import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { run } from '../../exec';
import { broadcast } from '../../bus';
import { Settings, uid } from '../../db';
import { nextLogin } from '../../../shared/harness/limits';
import type { HarnessId } from '../../../shared/types';
import { secureStorageService } from './claude';

/**
 * The multiple-logins-per-harness registry (spec multi-login-rotation.md). Owns
 * the persisted list, the active pointer, the in-memory "limited until" marks,
 * and each login's isolated credential directory.
 *
 * Persistence is one JSON blob in the settings KV under `harnessLogins`, NOT in
 * `GlobalSettings`: the renderer mirrors `GlobalSettings` and would go stale
 * every time main rotates. The renderer re-reads through `harness:logins`,
 * prompted by the `harness:logins` push event this module broadcasts.
 *
 * The default login (index 0, id `'default'`) is the CLI's own unscoped store —
 * what every user has today; its dir is undefined and its env is `{}`. Extra
 * logins live under `<userData>/logins/<harness>/<id>/`.
 */

export const DEFAULT_LOGIN_ID = 'default';

export interface HarnessLogin {
  id: string;
  addedAt: number;
  email?: string;
}

type Store = Partial<Record<HarnessId, { logins: HarnessLogin[]; activeId: string }>>;

const STORE_KEY = 'harnessLogins';

function readStore(): Store {
  try {
    const raw = Settings.raw(STORE_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && typeof s === 'object' ? (s as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  Settings.setRaw(STORE_KEY, JSON.stringify(store));
}

/** The default entry is always present, always index 0, and never removed. */
function seed(): { logins: HarnessLogin[]; activeId: string } {
  return { logins: [{ id: DEFAULT_LOGIN_ID, addedAt: 0 }], activeId: DEFAULT_LOGIN_ID };
}

/** This harness's entry, guaranteeing the default is index 0. */
function entryFor(store: Store, harness: HarnessId): { logins: HarnessLogin[]; activeId: string } {
  const e = store[harness];
  if (!e || !Array.isArray(e.logins) || !e.logins.length) return seed();
  // Belt-and-braces: the default must exist and lead the list.
  if (e.logins[0]?.id !== DEFAULT_LOGIN_ID) {
    const rest = e.logins.filter((l) => l.id !== DEFAULT_LOGIN_ID);
    return { logins: [{ id: DEFAULT_LOGIN_ID, addedAt: 0 }, ...rest], activeId: e.activeId || DEFAULT_LOGIN_ID };
  }
  return { logins: e.logins, activeId: e.activeId || DEFAULT_LOGIN_ID };
}

/** The stored list for a harness, seeded with the default entry on first read. */
export function loginsFor(harness: HarnessId): HarnessLogin[] {
  return entryFor(readStore(), harness).logins;
}

/** The active login (falling back to the default when the stored id is gone). */
export function activeLogin(harness: HarnessId): HarnessLogin {
  const e = entryFor(readStore(), harness);
  return e.logins.find((l) => l.id === e.activeId) ?? e.logins[0];
}

/** A login's isolated credential dir — undefined for the default (CLI's own). */
export function loginDir(harness: HarnessId, id: string): string | undefined {
  if (id === DEFAULT_LOGIN_ID) return undefined;
  return path.join(app.getPath('userData'), 'logins', harness, id);
}

/** Whether this harness supports more than one login. Lazily reaches into the
 *  adapter registry (avoids the `index → logins → index` load-time cycle, the
 *  same way roles.ts does). */
export function harnessSupportsMultiLogin(harness: HarnessId): boolean {
  const { adapters } = require('./index') as typeof import('./index');
  return !!adapters[harness]?.loginIsolation;
}

/** The credential-isolation env for a login — `{}` for the default (and for any
 *  harness without `loginIsolation`). Defaults to the active login. */
export function harnessLoginEnv(harness: HarnessId, id: string = activeLogin(harness).id): Record<string, string> {
  const dir = loginDir(harness, id);
  if (!dir) return {};
  const { adapters } = require('./index') as typeof import('./index');
  return adapters[harness]?.loginIsolation?.env(dir) ?? {};
}

/** Make `id` the login new turns run under. Global per harness. */
export function setActiveLogin(harness: HarnessId, id: string): void {
  const store = readStore();
  const e = entryFor(store, harness);
  if (!e.logins.some((l) => l.id === id)) throw new Error(`Unknown login ${id} for ${harness}`);
  store[harness] = { logins: e.logins, activeId: id };
  writeStore(store);
  broadcast('harness:logins', { harness });
}

/** Add an empty login store and return its entry. Does NOT activate and does
 *  NOT sign in — the Settings row starts the login terminal next. */
export function addLogin(harness: HarnessId): HarnessLogin {
  if (!harnessSupportsMultiLogin(harness)) throw new Error(`${harness} supports only one login`);
  const store = readStore();
  const e = entryFor(store, harness);
  const login: HarnessLogin = { id: uid(), addedAt: Date.now() };
  const dir = loginDir(harness, login.id);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  store[harness] = { logins: [...e.logins, login], activeId: e.activeId };
  writeStore(store);
  broadcast('harness:logins', { harness });
  return login;
}

/** Remove a login: wipe its Keychain item (macOS, best-effort) + its dir, then
 *  drop the entry. Refuses the default. If it was active, active → default.
 *  (Not `claude auth logout`: that also clears the shared `oauthAccount`,
 *  fact 3.) */
export async function removeLogin(harness: HarnessId, id: string): Promise<void> {
  if (id === DEFAULT_LOGIN_ID) throw new Error('The default login cannot be removed');
  const store = readStore();
  const e = entryFor(store, harness);
  const dir = loginDir(harness, id);
  if (dir) {
    if (process.platform === 'darwin') {
      await run('security', ['delete-generic-password', '-s', secureStorageService(dir)], { timeout: 5_000 }).catch(
        () => {}
      );
    }
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  markUnlimited(harness, id);
  const logins = e.logins.filter((l) => l.id !== id);
  const activeId = e.activeId === id ? DEFAULT_LOGIN_ID : e.activeId;
  store[harness] = { logins, activeId };
  writeStore(store);
  broadcast('harness:logins', { harness });
}

// ---------- limited-until marks (in-memory; usage bars are the truth after a
// restart, so one wasted retry re-marks a still-limited login) ----------

const limitedMarks = new Map<string, number>();
const markKey = (harness: HarnessId, id: string) => `${harness}:${id}`;

export function markLimited(harness: HarnessId, id: string, until: number): void {
  limitedMarks.set(markKey(harness, id), until);
}

function markUnlimited(harness: HarnessId, id: string): void {
  limitedMarks.delete(markKey(harness, id));
}

/** The ms epoch until which `id` is limited, or undefined when it isn't (or the
 *  mark has already expired). */
export function limitedUntil(harness: HarnessId, id: string): number | undefined {
  const until = limitedMarks.get(markKey(harness, id));
  if (until === undefined) return undefined;
  if (until <= Date.now()) {
    limitedMarks.delete(markKey(harness, id));
    return undefined;
  }
  return until;
}

/**
 * On a turn that died on a usage limit: mark the failed login, then switch to a
 * login with headroom. Returns the {from,to} pair on success (active already
 * moved), or null when rotation is off or no candidate is available.
 */
export function rotate(
  harness: HarnessId,
  failedId: string,
  until: number
): { from: HarnessLogin; to: HarnessLogin } | null {
  markLimited(harness, failedId, until);
  if (Settings.global().loginRotation === false) return null;
  const e = entryFor(readStore(), harness);
  const from = e.logins.find((l) => l.id === failedId) ?? e.logins[0];
  const to = nextLogin(e.logins, failedId, e.activeId, (id) => limitedUntil(harness, id) !== undefined);
  if (!to) return null;
  setActiveLogin(harness, to.id);
  return { from, to };
}

/** Display label for a login row: its email, else "Default login" / "Login N". */
export function labelFor(login: HarnessLogin, index: number): string {
  return login.email ?? (index === 0 ? 'Default login' : `Login ${index + 1}`);
}

/** Fetch each login's profile and persist its email when it changed. Called by
 *  the `harness:logins` IPC with `force`, and after a login pty exits. */
export async function refreshProfiles(harness: HarnessId): Promise<void> {
  const { adapters } = require('./index') as typeof import('./index');
  const fetchProfile = adapters[harness]?.fetchProfile;
  if (!fetchProfile) return;
  const e = entryFor(readStore(), harness);
  const results = await Promise.all(
    e.logins.map(async (l) => ({ id: l.id, profile: await fetchProfile(loginDir(harness, l.id)).catch(() => null) }))
  );
  const store = readStore();
  const cur = entryFor(store, harness);
  let changed = false;
  const logins = cur.logins.map((l) => {
    const r = results.find((x) => x.id === l.id);
    const email = r?.profile?.email;
    if (email && email !== l.email) {
      changed = true;
      return { ...l, email };
    }
    return l;
  });
  if (changed) {
    store[harness] = { logins, activeId: cur.activeId };
    writeStore(store);
    broadcast('harness:logins', { harness });
  }
}
