import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { run } from '../exec';
import { Hosts, Settings, Workspaces, uid } from '../db';
import { dropRemoteHost } from '../hosts/remote';
import type { CloudStatus, SshHostConfig } from '../../shared/types';

/**
 * Maestro Cloud free beta (docs/specs/maestro-cloud-free-beta.md §3). A thin
 * layer over BYOS: generate an ed25519 keypair, `POST /signup` to the shared
 * Railway box, and save a normal (but `managed`) SshHostConfig. Everything after
 * that — readiness, sign-in, journals, drain, bundle sync — is the existing SSH
 * machinery, unchanged.
 */

/** The signup service's HTTPS origin (the Railway HTTP domain). Overridable so
 *  the same build can point at a staging box or a local test server. */
const CLOUD_URL = (process.env.MAESTRO_CLOUD_URL || 'https://maestro-cloud-production-3998.up.railway.app').replace(/\/$/, '');

async function api(method: string, endpoint: string, body?: unknown, timeoutMs = 15_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CLOUD_URL}${endpoint}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

/** Live capacity for the picker chip; null when the box is unreachable. */
export async function cloudStatus(): Promise<CloudStatus | null> {
  try {
    const { status, json } = await api('GET', '/status', undefined, 6_000);
    return status === 200 ? (json as CloudStatus) : null;
  } catch {
    return null;
  }
}

/** The app-managed keypair for Maestro Cloud (one per install), created lazily. */
async function ensureKeypair(): Promise<{ keyPath: string; pubkey: string }> {
  const dir = path.join(app.getPath('userData'), 'maestro-cloud');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, 'id_ed25519');
  if (!fs.existsSync(keyPath)) {
    const r = await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'maestro-cloud', '-f', keyPath], {
      timeout: 20_000,
    });
    if (!r.ok || !fs.existsSync(keyPath)) {
      throw new Error(`Couldn't generate an SSH key (ssh-keygen): ${r.stderr.trim() || 'unavailable'}`);
    }
  }
  const pubkey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
  return { keyPath, pubkey };
}

/** The saved managed-host row, if the user has joined. */
export function managedHost(): SshHostConfig | null {
  return Hosts.list().find((h) => h.managed) ?? null;
}

export interface JoinResult {
  ok: boolean;
  hostId?: string;
  waitlisted?: boolean;
  full?: boolean;
  error?: string;
}

/** Join (or re-attach to) Maestro Cloud: signup, pin the host key, save the row,
 *  and make it the default cloud server. Idempotent — re-joining reuses the
 *  account tied to this install's key. */
export async function joinMaestroCloud(inviteCode?: string): Promise<JoinResult> {
  let pubkey: string, keyPath: string;
  try {
    ({ keyPath, pubkey } = await ensureKeypair());
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  let res: { status: number; json: any };
  try {
    res = await api('POST', '/signup', { pubkey, inviteCode: inviteCode?.trim() || undefined });
  } catch {
    return { ok: false, error: 'Maestro Cloud is unreachable right now.' };
  }
  const { status, json } = res;
  if (status !== 200) return { ok: false, error: json?.error || `Signup failed (${status}).` };
  if (json?.waitlisted) return { ok: false, waitlisted: true };
  if (json?.full) return { ok: false, full: true };
  if (!json?.host || !json?.user) return { ok: false, error: 'Signup returned an incomplete account.' };

  // Reuse the existing managed row if there is one, so re-joining doesn't dup.
  const existing = managedHost();
  const host: SshHostConfig = {
    id: existing?.id ?? uid(),
    label: 'Maestro Cloud',
    host: json.host,
    port: json.port || 22,
    user: json.user,
    auth: 'key',
    keyPath,
    hostKeyFingerprint: json.hostKey || undefined, // TOFU pin without a prompt
    managed: true,
    portBase: typeof json.portBase === 'number' ? json.portBase : undefined,
  };
  Hosts.upsert(host);
  dropRemoteHost(host.id); // pick up the pinned key / new address on next use
  const cloud = Settings.global().cloud ?? { defaultOn: false, hostId: null };
  Settings.setGlobal({ cloud: { ...cloud, hostId: host.id } });
  return { ok: true, hostId: host.id };
}

/** Leave Maestro Cloud: delete the account (best-effort) and the host row.
 *  Refuses while conversations still run on it — bring them local first (§1). */
export async function leaveMaestroCloud(): Promise<{ ok: boolean; error?: string }> {
  const host = managedHost();
  if (!host) return { ok: true };
  const onIt = Workspaces.list().filter((w) => w.hostId === host.id && !w.archived);
  if (onIt.length) {
    return {
      ok: false,
      error: `Bring ${onIt.length} conversation(s) back local before leaving (Sidebar → right-click → Bring local).`,
    };
  }
  try {
    const pub = host.keyPath && fs.existsSync(`${host.keyPath}.pub`) ? fs.readFileSync(`${host.keyPath}.pub`, 'utf8').trim() : '';
    await api('DELETE', '/account', { user: host.user, pubkey: pub }, 10_000).catch(() => {});
  } catch {}
  dropRemoteHost(host.id);
  Hosts.remove(host.id);
  const cloud = Settings.global().cloud;
  if (cloud?.hostId === host.id) Settings.setGlobal({ cloud: { defaultOn: false, hostId: null } });
  return { ok: true };
}
