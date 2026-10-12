import os from 'os';
import crypto from 'crypto';
import { safeStorage } from 'electron';
import { broadcast, setBroadcastHook } from '../bus';
import { Comments, Hosts, Messages, Projects, Queued, Scheduled, Settings, Todos, Workspaces, now } from '../db';
import { hostById, hostForWorkspace, isCloudWorkspace } from '../hosts';
import { getSubUsage, isAgentRunning, setLiveTurnHook, type LiveTurnPublish } from './harness';
import { activeLogin } from './harness/logins';
import { githubOwner } from './capabilities';
import { cachedPrStatus } from './github';
import { readAttachment } from './files';
import { relayMode, startBridge, stopBridge, type RelayMode } from './bridge';
import { listRunScripts, runScriptStates } from './runscripts';
import { firstCommandLine } from '../../shared/rundoc';
import { snapshotBlocks, type BlockStream } from '../../shared/harness';
import type { ScriptState } from '../../shared/types';
import { ensureSync, teardownSync, installSyncCron, removeSyncCron, syncStatus } from './cloudsync';
import { ensureDrainShim } from './cloud';
import { HARNESS_DISPLAY, pickSyncedSettings } from '../../shared/types';
import { isColorTheme, isThemeMode } from '../../shared/themes';
import type { AccountStatus, AgentBlock, AgentEvent, ChatMessage, GlobalSettings, HarnessId, Project, PrStatus, SubUsage, Workspace } from '../../shared/types';

/**
 * Maestro Web account service (spec mobile-web-app §6.9). The desktop's side of
 * the relay: a device link (mirroring the GitHub device flow, `ghauth.ts`),
 * publishing conversation metadata + history backfill, pulling web-originated
 * sends + read state, and linking saved SSH hosts as relay "boxes" (which uploads
 * + launches `maestro-sync`). Outbound HTTPS only; the per-device bearer token is
 * encrypted with Electron safeStorage and never written to plain settings JSON.
 */

const DEFAULT_RELAY = '';

// ---------- config + secret storage ----------

function relayUrl(): string {
  return (Settings.global().account?.relayUrl || process.env.MAESTRO_RELAY_URL || DEFAULT_RELAY).replace(/\/$/, '');
}

function encryptSecret(s: string): string {
  try {
    if (safeStorage?.isEncryptionAvailable?.()) return 'enc:' + safeStorage.encryptString(s).toString('base64');
  } catch {}
  // Test / unsupported platform: base64 is not encryption, but keeps the value
  // out of plain settings JSON and readable only from the settings DB.
  return 'plain:' + Buffer.from(s, 'utf8').toString('base64');
}
function decryptSecret(v: string | null): string | null {
  if (!v) return null;
  if (v.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    } catch {
      return null;
    }
  }
  if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString('utf8');
  return null;
}

// The device token is read by every publish guard — `isLinked()` alone is called
// once per broadcast — and each read used to run a full `safeStorage` decrypt
// (an OS keychain round-trip). Memoize by ciphertext so the decrypt happens once
// per token and `isLinked()` costs two cached reads (perf-cpu-ram §4.4).
let tokenMemo: { cipher: string | null; plain: string | null } = { cipher: null, plain: null };
export function deviceToken(): string | null {
  const cipher = Settings.raw('account.token');
  if (cipher !== tokenMemo.cipher) tokenMemo = { cipher, plain: decryptSecret(cipher) };
  return tokenMemo.plain;
}
function setDeviceToken(token: string | null) {
  if (token) Settings.setRaw('account.token', encryptSecret(token));
  else Settings.setRaw('account.token', '');
}
function boxToken(hostId: string): string | null {
  return decryptSecret(Settings.raw(`account.box.${hostId}`));
}
function setBoxToken(hostId: string, token: string | null) {
  Settings.setRaw(`account.box.${hostId}`, token ? encryptSecret(token) : '');
}

export function isLinked(): boolean {
  return !!deviceToken() && !!Settings.global().account?.linked;
}

// ---------- relay fetch + circuit breaker ----------

/**
 * Relay circuit breaker (web-relay-egress-quota §B2).
 *
 * When the relay's database went down, this desktop retry-stormed it: ~60
 * conversation PUTs and 35 device polls in a 35-second window, every one of them
 * a 500. That is both useless and expensive (each failed request still costs the
 * relay a connection and a query attempt). So: any 5xx or network error opens a
 * breaker; while it's open, every publish path returns without making a request
 * — crucially WITHOUT advancing its fingerprint, so nothing is silently skipped
 * once the relay is back. The device long-poll is the prober: the first 2xx
 * closes the breaker.
 */
const BREAKER_MIN_MS = 30_000;
const BREAKER_MAX_MS = 5 * 60_000;
let breakerUntil = 0;
let breakerDelay = BREAKER_MIN_MS;
let breakerReason: string | null = null;

/** True while the relay is considered down — publish paths must not call it. */
function relayPaused(): boolean {
  return Date.now() < breakerUntil;
}

/**
 * True while publishing should wait: the relay is down, or nothing is watching
 * this account (the bridge's `idle` mode — no web client connected). Every
 * mirror write is a Neon wake-up, and a desktop busy with agents kept the
 * database awake all day for a phone in a drawer. So while nobody watches, the
 * publish paths return without a request — and without advancing their
 * fingerprints, so nothing is lost: the moment a viewer connects the bridge runs
 * `publishAll`, and one fingerprint-gated pass sends exactly what changed.
 */
function publishHeld(): boolean {
  return relayPaused() || relayMode() === 'idle';
}

/** ms until the breaker clears (0 when closed). The bridge sleeps on this. */
export function relayRetryIn(): number {
  return Math.max(0, breakerUntil - Date.now());
}

export function relayStatus(): { ok: boolean; reason: string | null; retryIn: number; mode: RelayMode } {
  return { ok: !relayPaused(), reason: relayPaused() ? breakerReason : null, retryIn: relayRetryIn(), mode: relayMode() };
}

/** Test/recovery hook: close the breaker immediately. */
export function resetRelayBreaker(): void {
  const wasOpen = relayPaused();
  breakerUntil = 0;
  breakerDelay = BREAKER_MIN_MS;
  breakerReason = null;
  if (wasOpen) broadcast('account:relay-status', relayStatus());
}

/** Ask the relay how it is — /api/health answers even with no database, and
 *  deliberately does NOT go through relayFetch (its 200 would close the breaker
 *  we're trying to describe). */
async function relayHealth(): Promise<{ ok?: boolean; db?: string; bus?: string; message?: string } | null> {
  try {
    const res = await fetch(`${relayUrl()}/api/health`, { signal: AbortSignal.timeout(5000) });
    return (await res.json()) as { ok?: boolean; db?: string; bus?: string; message?: string };
  } catch {
    return null;
  }
}

async function relayHealthReason(): Promise<string | null> {
  const j = await relayHealth();
  if (!j || j.ok) return null;
  return j.message ?? (j.db ? `database ${j.db}` : null);
}

/** One probe at boot: a relay running without its event bus still works, but its
 *  live features are per-instance and best-effort, so say so rather than letting
 *  it look like flakiness (web-relay-event-bus §2.3). */
async function reportRelayBus(): Promise<void> {
  const bus = (await relayHealth())?.bus;
  if (bus && bus !== 'redis') broadcast('account:relay-status', { ...relayStatus(), bus });
}

function openBreaker(why: string): void {
  // Already open: don't compound. A single failed round can involve several
  // in-flight requests (schedulePublish fires the workspace row, todos, comments
  // and each conversation together), and doubling per response would jump
  // straight to the 5-minute ceiling on the first outage instead of per retry.
  if (relayPaused()) return;
  breakerUntil = Date.now() + breakerDelay;
  breakerDelay = Math.min(breakerDelay * 2, BREAKER_MAX_MS);
  breakerReason = why;
  broadcast('account:relay-status', relayStatus());
  // Refine the reason from /api/health, best-effort, once per opening.
  void relayHealthReason().then((r) => {
    if (!r || !relayPaused()) return;
    breakerReason = r;
    broadcast('account:relay-status', relayStatus());
  });
}

function closeBreaker(): void {
  if (breakerUntil === 0 && breakerDelay === BREAKER_MIN_MS) return;
  const wasOpen = relayPaused();
  breakerUntil = 0;
  breakerDelay = BREAKER_MIN_MS;
  breakerReason = null;
  if (wasOpen) broadcast('account:relay-status', relayStatus());
}

export async function relayFetch(path: string, init: RequestInit & { auth?: string } = {}): Promise<Response> {
  const { auth, ...rest } = init;
  const headers = new Headers(rest.headers);
  const token = auth ?? deviceToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (rest.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let res: Response;
  try {
    res = await fetch(`${relayUrl()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    // Network error / timeout — the relay is unreachable.
    openBreaker(e instanceof Error ? e.message : 'relay unreachable');
    throw e;
  }
  // Our device token was rejected — it was revoked/deleted on the relay (the user
  // hit "Reset Maestro Web" from the web, or revoked this desktop). Flip to
  // signed-out so the desktop stops silently failing every publish and the UI
  // shows "link again", instead of forever claiming it's linked. Only when WE used
  // the device token (not an explicit box/other token) and one was actually sent.
  if (res.status === 401 && auth === undefined && token) handleDeviceRevoked();
  if (res.status >= 500) openBreaker(`relay returned ${res.status}`);
  else if (res.ok) closeBreaker();
  return res;
}

// ---------- device link (mirrors ghauth.ts UX) ----------

interface LinkSession {
  pollToken: string;
  timer?: NodeJS.Timeout;
  cancelled: boolean;
  expiresAt: number;
}
let link: LinkSession | null = null;

export async function startLink(deviceName?: string): Promise<{ code: string; expiresInSec: number; url: string }> {
  cancelLink();
  const name = deviceName || os.hostname();
  const res = await relayFetch('/api/link/start', {
    method: 'POST',
    body: JSON.stringify({ name, platform: process.platform }),
  });
  if (!res.ok) throw new Error(`relay returned ${res.status}`);
  const j = (await res.json()) as { code: string; pollToken: string; expiresInSec: number };
  const account = Settings.global().account ?? { relayUrl: relayUrl(), deviceName: name, linked: false };
  Settings.setGlobal({ account: { ...account, relayUrl: relayUrl(), deviceName: name } });
  link = { pollToken: j.pollToken, cancelled: false, expiresAt: Date.now() + j.expiresInSec * 1000 };
  schedulePoll();
  return { code: j.code, expiresInSec: j.expiresInSec, url: `${relayUrl()}/link` };
}

function schedulePoll() {
  if (!link || link.cancelled) return;
  link.timer = setTimeout(() => void pollLink(), 3000);
}

async function pollLink() {
  const s = link;
  if (!s || s.cancelled) return;
  if (Date.now() > s.expiresAt) {
    link = null;
    broadcast('account:auth', { phase: 'error', message: 'The link code expired. Start again.' });
    return;
  }
  let j: any;
  try {
    const res = await relayFetch('/api/link/poll', { method: 'POST', body: JSON.stringify({ pollToken: s.pollToken }) });
    j = await res.json();
  } catch {
    if (!s.cancelled) schedulePoll();
    return;
  }
  if (s.cancelled) return;
  if (j.status === 'approved' && j.apiToken) {
    link = null;
    setDeviceToken(j.apiToken);
    const account = Settings.global().account ?? { relayUrl: relayUrl(), deviceName: os.hostname(), linked: false };
    Settings.setGlobal({ account: { ...account, linked: true, user: j.user ?? undefined } });
    broadcast('account:auth', { phase: 'success', status: await accountStatus() });
    // A fresh link can point at a different account, or one reset from the web, so
    // the fingerprints from the prior link no longer describe this relay — drop
    // them before the initial publish (see clearPublishFingerprints).
    clearPublishFingerprints();
    // A new link may well be a new (or recovered) relay — don't let a breaker
    // opened against the old one swallow the initial publish.
    resetRelayBreaker();
    // Start syncing exactly as boot does. The bridge's first answer publishes
    // everything we already have — at once when the web is open, as linking
    // usually is; otherwise the moment a viewer connects.
    void startAccountSync().catch(() => {});
    // Box-link saved SSH hosts by default so their cloud chats work from the web.
    void autoLinkBoxes().catch(() => {});
    return;
  }
  if (j.status === 'expired') {
    link = null;
    broadcast('account:auth', { phase: 'error', message: 'The link code expired. Start again.' });
    return;
  }
  schedulePoll(); // pending
}

export function cancelLink() {
  if (link) {
    link.cancelled = true;
    if (link.timer) clearTimeout(link.timer);
    link = null;
  }
}

/** Drop this device's web link locally: clear the token, `linked`, and `user`.
 *  Shared by an explicit sign-out and the relay-revoked path. Never touches local
 *  workspaces, sessions, harness keys, or any other desktop state — only the web
 *  link. The publish loop and bridge both gate on `isLinked()`, so they quiesce on
 *  their next tick once this flips. */
function clearLocalLink(): void {
  setDeviceToken(null);
  const account = Settings.global().account;
  if (account) Settings.setGlobal({ account: { ...account, linked: false, user: undefined } });
}

/** The relay rejected our device token (revoked or account-reset from the web).
 *  Flip to signed-out locally and tell the renderer. Idempotent — a no-op once the
 *  token is already gone, so the burst of in-flight 401s during a reset collapses
 *  to a single sign-out. */
function handleDeviceRevoked(): void {
  if (!deviceToken()) return;
  clearLocalLink();
  broadcast('account:auth', { phase: 'signedout', reason: 'revoked' });
}

export async function signOut(): Promise<void> {
  cancelLink();
  // Revoke this device on the relay first (while we still hold its token) so the
  // web — whose visibility is gated on a live device — empties immediately.
  // Best-effort: if we're offline, the local sign-out still proceeds.
  await relayFetch('/api/device/self', { method: 'DELETE' }).catch(() => {});
  clearLocalLink();
  broadcast('account:auth', { phase: 'signedout' });
}

/** Unlink ANOTHER linked desktop by its relay device id (Settings → Account).
 *  Revokes that device's token on the relay so it drops to signed-out on its next
 *  poll and the web stops showing it. This desktop's own link is untouched — to
 *  unlink THIS desktop, sign out (which revokes self). The relay scopes the revoke
 *  to our account, so we can only ever revoke our own devices. */
export async function unlinkDevice(deviceId: string): Promise<{ ok: boolean; error?: string }> {
  if (!isLinked()) return { ok: false, error: 'Sign in to Maestro Web first.' };
  try {
    const res = await relayFetch(`/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    if (!res.ok) return { ok: false, error: `relay returned ${res.status}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ---------- publish metadata + backfill ----------

const convId = (ws: Workspace, agentId: number) => `${ws.id}:${agentId}`;

/** A workspace's session ids (session 1 always, plus any extra chats). */
function chatIds(workspaceId: string): number[] {
  const ids = new Set<number>([1]);
  for (const k of Object.keys(Workspaces.getChats(workspaceId))) ids.add(Number(k));
  return [...ids];
}

/** Whether a project syncs to Maestro Web. Every project syncs by default; the
 *  user can deselect any, which lands its id in `account.projectOptOut`. Every
 *  publish path funnels through here (via `wsSynced`/`wsIdSynced`), so a
 *  deselected project's workspaces are never pushed to the relay. */
export function projectSynced(projectId: string): boolean {
  return !(Settings.global().account?.projectOptOut ?? []).includes(projectId);
}
const wsSynced = (ws: Workspace): boolean => projectSynced(ws.projectId);
/** Sync guard for the workspaceId-only publishers. A missing workspace passes
 *  (each caller's own logic handles absence) — only a deselected project blocks. */
const wsIdSynced = (workspaceId: string): boolean => {
  const ws = Workspaces.get(workspaceId);
  return !ws || wsSynced(ws);
};
/** The same guard for the publishers that write INTO a workspace row (todos, diff
 *  comments, run scripts, read state): an archived workspace has been deleted from
 *  the relay (web-neon-usage-diet §3.5), so a PUT would resurrect it as an orphan. */
const wsIdPublishable = (workspaceId: string): boolean => {
  const ws = Workspaces.get(workspaceId);
  return !ws || (wsSynced(ws) && !ws.archived);
};

/** Every non-deleted workspace + its sessions to mirror (all workspaces now —
 *  local included). §9.5.1. Workspaces whose project the user deselected from
 *  sync are excluded, and so are ARCHIVED ones: the web mirrors what you are
 *  working on, not your history (web-neon-usage-diet §3.5). Archived rows are
 *  removed from the relay by `publishWorkspace`, which `publishAll` still calls
 *  for them. */
function publishedChats(): { ws: Workspace; agentId: number }[] {
  const out: { ws: Workspace; agentId: number }[] = [];
  for (const ws of Workspaces.list()) {
    if (!wsSynced(ws) || ws.archived) continue;
    for (const id of chatIds(ws.id)) out.push({ ws, agentId: id });
  }
  return out;
}

/** The PR-status detail the shared workflow panels key off (§10.1/§10.3): the
 *  mergeable state that decides Merge vs Resolve-conflicts, the check rollup, and
 *  the review decision. Derived from the desktop's cached `gh pr view` so the web
 *  tracks exactly what the desktop UI shows; no cached PR → all null (same as a
 *  workspace with no PR). `mergeable` maps GitHub's verbatim strings to the web's
 *  enum — UNKNOWN stays 'unknown' (reads as mergeable, the attempt is the
 *  backstop), only CONFLICTING flips the button to Resolve conflicts. */
interface PrPublishDetail {
  prTitle: string | null;
  prDraft: boolean | null;
  prChecks: 'pass' | 'fail' | 'pending' | null;
  prMergeable: 'clean' | 'conflict' | 'unknown' | null;
  prReview: string | null;
  prChecksList: { name: string; state: string; url: string | null }[] | null;
}

/** Pure PrStatus → published detail (exported for account-e2e; no gh/IO). */
export function mapPrDetail(pr: PrStatus | null | undefined): PrPublishDetail {
  if (!pr) return { prTitle: null, prDraft: null, prChecks: null, prMergeable: null, prReview: null, prChecksList: null };
  const checks = pr.checks;
  return {
    prTitle: pr.title ?? null,
    prDraft: pr.isDraft,
    // Match the desktop's ChecksPanel: a red check fails the rollup, else any
    // still-running check is pending, else green. No checks configured → null,
    // which the web reads as green (like the desktop).
    prChecks:
      checks.length === 0
        ? null
        : checks.some((c) => c.state === 'fail')
          ? 'fail'
          : checks.some((c) => c.state === 'pending')
            ? 'pending'
            : 'pass',
    prMergeable: pr.mergeable === 'CONFLICTING' ? 'conflict' : pr.mergeable === 'MERGEABLE' ? 'clean' : 'unknown',
    prReview: pr.reviewDecision ?? null,
    prChecksList: checks.map((c) => ({ name: c.name, state: c.state, url: c.link })),
  };
}

function wsFingerprint(ws: Workspace, proj: Project | null, repoOwner: string | null, pr: PrPublishDetail): string {
  return [
    ws.title, ws.subtitle, ws.name, ws.status, ws.archived, ws.branch, ws.hostId,
    ws.prNumber, ws.prState, ws.prUrl, ws.setupError, ws.port, proj?.name, proj?.baseBranch,
    repoOwner,
    // PR detail moves independently of number/state (mergeable flips to conflict
    // when the base advances, checks go green): fold it in so those changes
    // aren't deduped away and the web's Merge/Resolve-conflicts button updates.
    pr.prMergeable, pr.prChecks, pr.prReview, pr.prDraft, pr.prTitle, JSON.stringify(pr.prChecksList),
  ].join('|');
}

/** `account.wsfp.<id>` value meaning "deleted from the relay because archived"
 *  (web-neon-usage-diet §3.5). Never equal to a real fingerprint, so un-archiving
 *  republishes through the normal gate; cleared with the rest on link. */
const WS_GONE = 'gone';

/** Publish one workspace row (web-desktop-parity §9.2/§9.5). Fingerprint-gated.
 *  An archived workspace is UNpublished instead (web-neon-usage-diet §3.5). */
export async function publishWorkspace(ws: Workspace): Promise<void> {
  if (!isLinked() || !wsSynced(ws) || publishHeld()) return;
  // Archived workspaces are not mirrored at all: 106 of this fleet's 137 rows were
  // archived, and each one still cost a row, a transcript and a re-publish for a
  // History view a phone barely visits. So archiving DELETES the row (the relay
  // cascades to its conversations/turns/diffs/attachments) and un-archiving
  // republishes it in full — clearing the fingerprints is what forces the whole
  // backfill back up through the normal path (§3.5).
  if (ws.archived) {
    // Already unpublished by an earlier pass — this runs for every archived
    // workspace on every publishAll, so it has to be a settings read, not a DELETE.
    if (Settings.raw(`account.wsfp.${ws.id}`) === WS_GONE) return;
    // Otherwise DELETE whether or not we remember publishing it: the fingerprints
    // are cleared on every link, and a relink is exactly when the relay may still
    // hold archived rows from the previous link. "Already gone" is a 200.
    const res = await relayFetch(`/api/workspaces/${encodeURIComponent(ws.id)}`, { method: 'DELETE' });
    if (!res.ok) return;
    clearWorkspaceFingerprints(ws);
    Settings.setRaw(`account.wsfp.${ws.id}`, WS_GONE);
    return;
  }
  const proj = Projects.get(ws.projectId);
  // GitHub owner for the web sidebar's repo avatar (desktop parity); cached per
  // repoPath, and in the fingerprint so it backfills for already-synced rows.
  const repoOwner = proj ? await githubOwner(proj.repoPath) : null;
  const prDetail = mapPrDetail(cachedPrStatus(ws.worktreePath));
  const fp = wsFingerprint(ws, proj, repoOwner, prDetail);
  if (Settings.raw(`account.wsfp.${ws.id}`) === fp) return;
  const account = Settings.global().account;
  const boxId = ws.hostId ? account?.boxes?.[ws.hostId]?.boxId : null;
  const host = ws.hostId ? Hosts.get(ws.hostId) : null;
  const body = {
    projectId: ws.projectId,
    projectName: proj?.name ?? null,
    projectKind: proj?.kind ?? null,
    repoOwner,
    name: ws.name,
    title: ws.title,
    subtitle: ws.subtitle,
    branch: ws.branch,
    baseBranch: proj?.baseBranch ?? null,
    wsKind: ws.wsKind,
    hostLabel: host?.label ?? null,
    isCloud: isCloudWorkspace(ws),
    boxId: boxId ?? null,
    harness: ws.harness,
    status: ws.status,
    setupError: ws.setupError ?? null,
    archived: !!ws.archived,
    port: ws.port,
    prNumber: ws.prNumber,
    prUrl: ws.prUrl,
    prState: ws.prState,
    ...prDetail,
    lastUserMessageAt: ws.lastUserMessageAt,
  };
  const res = await relayFetch(`/api/workspaces/${encodeURIComponent(ws.id)}`, { method: 'PUT', body: JSON.stringify(body) });
  if (res.ok) Settings.setRaw(`account.wsfp.${ws.id}`, fp);
}

/** Fingerprint of everything the *history* backfill depends on. `stats` comes
 *  from one indexed aggregate (perf-cpu-ram §4.2) — it used to be
 *  `Messages.list(ws.id).filter(…).length`, i.e. the whole workspace transcript
 *  materialized just to read a count, several times a second during a turn. */
function metaFingerprint(ws: Workspace, agentId: number, stats: MessageStats): string {
  const chat = Workspaces.getChats(ws.id)[String(agentId)] ?? {};
  return [
    ws.title, chat.title, ws.archived, ws.status, ws.hostId, stats.count, stats.maxTs, chat.lastAgentAt,
    chat.model, chat.effort, chat.planMode, chat.contextTokens, chat.attention, chat.closed,
    chat.titleCustom, chat.lastReadAt, isAgentRunning(ws.id, agentId),
    Scheduled.forWorkspace(ws.id).filter((s) => s.agentId === agentId).map((s) => `${s.id}:${s.deliverAt}:${s.text.length}`).join(','),
    // Queue state — so enqueue / edit / remove / drain re-publish (and reconcile) the web queue (§7.4).
    Queued.forChat(ws.id, agentId).map((q) => `${q.id}:${q.seq}:${q.text.length}`).join(','),
  ].join('|');
}

// Worktree images an agent embedded (`![](.context/x.png)`) can't load from the
// web's origin, so on publish we upload each once and rewrite the markdown ref to
// the relay URL (web-desktop-parity §6.4).
const IMG_REF_RE = /!\[[^\]]*\]\(([^)\s]+)/g;

/**
 * The upload cache: `account.img.<sha256 of the data URL>` → relay URL
 * (web-neon-usage-diet §3.6). It used to be an in-memory map keyed by
 * (workspace, ref), which was wrong twice over: it died with the process, so
 * every desktop restart followed by a resync re-uploaded every embedded
 * screenshot as a new base64 row that nothing ever deletes (the bulk of the
 * relay's 589 MB), and an overwritten `.context/preview/shot-1.png` kept serving
 * the first upload's bytes forever. Keying by CONTENT fixes both: same bytes →
 * same key → one row, new bytes → new key. The relay dedupes by the same hash,
 * so the worst a stale-free cache costs is one redundant POST.
 */
function imageCacheKey(dataUrl: string): string {
  return `account.img.${crypto.createHash('sha256').update(dataUrl).digest('hex')}`;
}

/** Upload one embedded image (or answer from the content cache) and return its
 *  relay URL. `workspaceId` attributes the row so it dies with the workspace;
 *  `deduped` says the relay already held these bytes — either way the URL it
 *  returns is the one to cache. */
async function uploadImage(dataUrl: string, workspaceId: string): Promise<string | null> {
  const key = imageCacheKey(dataUrl);
  const cached = Settings.raw(key);
  if (cached) return cached;
  try {
    const res = await relayFetch('/api/attachments', { method: 'POST', body: JSON.stringify({ dataUrl, workspaceId }) });
    if (!res.ok) return null;
    const j = (await res.json()) as { url?: string; deduped?: boolean };
    const url = j.url ? `${relayUrl()}${j.url}` : null;
    if (url) Settings.setRaw(key, url);
    return url;
  } catch {
    return null;
  }
}

/** Download an attachment the web user uploaded (a photo they attached to a
 *  message), by its relay id, over the device token. The desktop writes the bytes
 *  into the worktree before running the turn (web-desktop-parity §6.4). */
export async function downloadAttachment(id: string): Promise<{ dataBase64: string; mime: string } | null> {
  try {
    const res = await relayFetch(`/api/attachments/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const mime = res.headers.get('content-type') ?? 'application/octet-stream';
    const buf = Buffer.from(await res.arrayBuffer());
    return { dataBase64: buf.toString('base64'), mime };
  } catch {
    return null;
  }
}

async function rewriteImagesInText(ws: Workspace, text: string): Promise<string> {
  const refs = new Set<string>();
  for (const m of text.matchAll(IMG_REF_RE)) {
    const p = m[1];
    if (!/^(?:https?|data|blob):/i.test(p)) refs.add(p);
  }
  if (refs.size === 0) return text;
  const host = hostForWorkspace(ws);
  let out = text;
  for (const ref of refs) {
    // Read first, then let the content hash decide whether this is an upload
    // (§3.6) — the read is what tells a re-rendered screenshot from the one we
    // already sent, and it is exactly what the upload would have cost anyway.
    const att = await readAttachment(ws.worktreePath, ref, host).catch(() => null);
    if (att?.kind !== 'image' || !att.dataUrl) continue;
    const url = await uploadImage(att.dataUrl, ws.id);
    if (url) out = out.split(`](${ref})`).join(`](${url})`).split(`](${ref} `).join(`](${url} `);
  }
  return out;
}

async function rewriteBlocksImages(ws: Workspace, blocks: AgentBlock[]): Promise<AgentBlock[]> {
  const out: AgentBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text') out.push({ type: 'text', text: await rewriteImagesInText(ws, b.text) });
    else out.push(b);
  }
  return out;
}

/** Local turns + user messages for a chat, in the relay's backfill shape. `msgs`
 *  is the slice to send — the whole conversation, or just the tail an
 *  incremental backfill covers (see `backfillSlice`). */
async function backfillPayload(ws: Workspace, agentId: number, msgs: ChatMessage[]) {
  const turns: any[] = [];
  const userMessages: any[] = [];
  // The persisted send queue is the authoritative "queued" set (web-desktop-parity
  // §7.4): publish those rows as queued user messages, and skip any Messages
  // placeholder that shares an id (a web send inserts one before the queue row
  // lands) so the web shows one entry, keyed by the queued row's id.
  const queuedRows = Queued.forChat(ws.id, agentId);
  const queuedIds = new Set(queuedRows.map((q) => q.id));
  // Pair each user message with the agent turn it triggered (§12.5): walk in
  // order, remember the last user message, and stamp its turnId when the next
  // agent turn appears — so the web never hides a prompt for lack of a turnId.
  let pendingUserIdx = -1;
  for (const m of msgs) {
    if (m.role === 'agent') {
      let parsed: AgentBlock[] = [];
      try {
        parsed = JSON.parse(m.content);
      } catch {}
      const blocks = await rewriteBlocksImages(ws, Array.isArray(parsed) ? parsed : []);
      turns.push({
        id: m.id,
        status: m.meta?.error ? 'error' : 'done',
        blocks,
        meta: { costUsd: m.meta?.costUsd, durationMs: m.meta?.durationMs, error: m.meta?.error, needsAttention: !!m.meta?.error, origin: m.meta?.origin, subagents: m.meta?.subagents },
        startedAt: m.ts,
        endedAt: m.ts,
      });
      if (pendingUserIdx >= 0) {
        userMessages[pendingUserIdx].turnId = m.id;
        pendingUserIdx = -1;
      }
    } else if (m.role === 'user') {
      // Skip the placeholder for a still-queued message; the queued row below is
      // authoritative and carries the same id.
      if (queuedIds.has(m.id)) continue;
      userMessages.push({ id: m.id, text: m.content, origin: m.meta?.origin ?? 'desktop', turnId: undefined, queued: !!m.meta?.queued, createdAt: m.ts });
      pendingUserIdx = userMessages.length - 1;
    }
  }
  // Waiting messages (both desktop- and web-queued), FIFO. Keyed by the queued row
  // id so the web's edit / remove / send-now jobs resolve to the right row.
  for (const q of queuedRows) {
    userMessages.push({ id: q.id, text: q.text, origin: q.origin ?? 'desktop', turnId: q.turnId, queued: true, createdAt: q.createdAt });
  }
  return { turns, userMessages };
}

/** Short, stable digest of a publish body — the value stored in the fingerprint
 *  keys (the bodies themselves are ~1 KB each and there are hundreds). */
function digest(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

type MessageStats = ReturnType<typeof Messages.stats>;

/**
 * Incremental backfill (perf-cpu-ram §4.2). `msgs.length` was part of the meta
 * fingerprint, so every new message re-POSTed the WHOLE conversation to
 * `/backfill` — whose relay handler insert-ignores turns, discarding >99 % of the
 * bytes. O(n²) over a conversation's life.
 *
 * `account.bfmark.<convId>` remembers `{ts, count}` as of the last backfill the
 * relay acked. When the current `{count}` is exactly that plus what arrived after
 * `ts`, nothing was deleted or back-dated and the tail alone is a faithful
 * update; anything else (a deleted message, an import with old timestamps, a
 * cleared mark) falls back to the full conversation. Either way the relay's
 * semantics are unchanged — a full resend is always correct, so the mark is a
 * pure optimization that self-heals.
 */
interface BackfillMark {
  ts: number;
  count: number;
}
function backfillMark(id: string): BackfillMark | null {
  const raw = Settings.raw(`account.bfmark.${id}`);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as BackfillMark;
    return typeof m?.ts === 'number' && typeof m?.count === 'number' ? m : null;
  } catch {
    return null;
  }
}

/** The messages one backfill must carry: the whole history, or just the tail. */
function backfillSlice(ws: Workspace, agentId: number, stats: MessageStats): ChatMessage[] {
  const mark = backfillMark(convId(ws, agentId));
  if (!mark) return Messages.listForAgent(ws.id, agentId);
  const fresh = Messages.listForAgent(ws.id, agentId, { sinceTs: mark.ts + 1 });
  if (stats.count !== mark.count + fresh.length) return Messages.listForAgent(ws.id, agentId);
  // `backfillPayload` stamps a user message with the id of the turn that answered
  // it by walking the slice in order, so a window opening on an agent turn would
  // orphan the prompt before it (§12.5) — the everyday case, since a prompt
  // publishes when it is sent and its turn only lands a publish later. Re-send
  // that one row (the relay upserts user messages, so it costs one small
  // duplicate). Only when the prompt is genuinely unanswered: an agent message
  // just before the window means the walk had already consumed it.
  const prev = fresh[0]?.role === 'agent' ? Messages.lastExchangeBefore(ws.id, agentId, fresh[0].ts) : null;
  return prev?.role === 'user' ? [prev, ...fresh] : fresh;
}

export async function publishConversation(ws: Workspace, agentId: number): Promise<void> {
  // An archived workspace has been deleted from the relay (§3.5) — publishing its
  // conversations would only re-create rows with no workspace to hang off.
  if (!isLinked() || !wsSynced(ws) || ws.archived || publishHeld()) return;
  const id = convId(ws, agentId);
  const chat = Workspaces.getChats(ws.id)[String(agentId)] ?? {};
  const proj = Projects.get(ws.projectId);
  const account = Settings.global().account;
  const boxId = ws.hostId ? account?.boxes?.[ws.hostId]?.boxId : undefined;
  // One indexed aggregate feeds both `hasRun` and the history fingerprint below;
  // neither path reads a message row any more (perf-cpu-ram §4.2).
  const stats = Messages.stats(ws.id, agentId);
  const body = {
    workspaceId: ws.id,
    agentId,
    boxId: boxId ?? null,
    // Only the first chat stands in for the workspace. A later untitled chat
    // borrowing the workspace's title — which is the first chat's — showed on the
    // web as a copy of it; untitled, the web names it "New chat" like the desktop.
    title: chat.title || (agentId === 1 ? ws.title || ws.name : null),
    // No workspace-wide `state`/`subtitle`: they ride the workspace row, which is
    // what the web reads. Carried here too, every status flip changed ALL of a
    // workspace's chat bodies at once — 30 PUTs per turn start/end in a busy one.
    projectName: proj?.name ?? null,
    harness: ws.harness,
    hasRun: stats.agentCount > 0,
    archived: !!ws.archived,
    // MUST be stable for an unchanged conversation: this body is fingerprinted
    // below, and `now()` here made every single call look like a change — which
    // is exactly how a 400ms-coalesced `schedulePublish` turned into ~2 PUTs a
    // second per workspace during any turn (web-relay-egress-quota §B1).
    lastActivityAt: chat.lastAgentAt ?? ws.lastUserMessageAt ?? ws.createdAt ?? null,
    // Desktop-parity session fields (§9.2).
    model: chat.model ?? null,
    effort: chat.effort ?? null,
    planMode: !!chat.planMode,
    contextTokens: chat.contextTokens ?? null,
    // No `usage` here any more: subscription percentages moved to the per-user
    // settings row (web-neon-usage-diet §3.2). An unrounded `pct` float drifting
    // by a fraction of a percent re-PUT all ~293 conversations every five minutes
    // while Claude was used anywhere — the whole point of fingerprinting the body
    // is that an unchanged conversation is silent.
    // Local turns run here, so the desktop owns `running`. Cloud turns run on the
    // box — leave `running` to the relay ingest (§12.4); omitting the key means
    // putConversation won't overwrite it.
    running: isCloudWorkspace(ws) ? undefined : isAgentRunning(ws.id, agentId),
    attention: !!chat.attention,
    lastAgentAt: chat.lastAgentAt ?? null,
    closed: !!chat.closed,
    titleCustom: !!chat.titleCustom,
    scheduled: Scheduled.forWorkspace(ws.id)
      .filter((s) => s.agentId === agentId)
      .map((s) => ({ id: s.id, text: s.text, deliverAt: s.deliverAt })),
  };
  // Gate the metadata PUT on the body itself (§B1). Separate key from the
  // backfill gate below (`account.fp.*`), which fingerprints the *history*, not
  // the metadata — the two move independently. Cleared wherever that one is.
  const bodyJson = JSON.stringify(body);
  const cfp = digest(bodyJson);
  if (Settings.raw(`account.cfp.${id}`) !== cfp) {
    const res = await relayFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PUT', body: bodyJson });
    // Never advance a fingerprint on a failed request — the relay doesn't have
    // this body, so the next publish has to try again.
    if (!res.ok) return;
    Settings.setRaw(`account.cfp.${id}`, cfp);
  }
  // Backfill history (idempotent by id) whenever the fingerprint changed.
  const fp = metaFingerprint(ws, agentId, stats);
  if (Settings.raw(`account.fp.${id}`) !== fp) {
    const payload = await backfillPayload(ws, agentId, backfillSlice(ws, agentId, stats));
    let sent = true;
    if (payload.turns.length || payload.userMessages.length) {
      const res = await relayFetch(`/api/conversations/${encodeURIComponent(id)}/backfill`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }).catch(() => null);
      sent = !!res?.ok;
    }
    // Only a backfill the relay actually took may advance the mark. Left where it
    // was, the next slice simply starts from there again and re-covers whatever
    // this one failed to deliver.
    if (sent) Settings.setRaw(`account.bfmark.${id}`, JSON.stringify({ ts: stats.maxTs, count: stats.count }));
    Settings.setRaw(`account.fp.${id}`, fp);
  }
  // A chat read while nobody was watching was held; it goes up with the catch-up.
  await pushReadState(ws.id, agentId);
}

function runScriptPhase(st: ScriptState | undefined): 'idle' | 'running' | 'ok' | 'exit' | 'stopped' {
  if (!st) return 'idle';
  if (st.running) return 'running';
  if (st.exitCode == null) return 'idle';
  if (st.exitCode === 0) return 'ok';
  if (st.exitCode === 143 || st.exitCode === 130) return 'stopped';
  return 'exit';
}

/** Publish a workspace's run scripts + their live state to the relay Run tab
 *  (web-desktop-parity §10.5). Patched via the /git endpoint (present-field), and
 *  fingerprint-gated like the other /git blobs (web-neon-usage-diet §3.8): a
 *  `runscript:` broadcast fires per output chunk, and every one of them re-sent
 *  the same unchanged list. */
export async function publishRunScripts(workspaceId: string): Promise<void> {
  await publishGitBlob(workspaceId, 'account.rsfp.', () => {
    const states = runScriptStates(workspaceId);
    return {
      runScripts: listRunScripts(workspaceId).map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        command: firstCommandLine(s.doc),
        state: runScriptPhase(states[s.id]),
        exitCode: states[s.id]?.exitCode ?? undefined,
      })),
    };
  }).catch(() => {
    /* run scripts unavailable — leave the relay value as-is */
  });
}

/**
 * Live-turn streaming (web-relay-event-bus §3.1). A running turn used to be
 * re-PUT whole every 400ms: the desktop re-sent it, the relay re-wrote its jsonb
 * row, and the phone re-read it — every tick quadratic in the turn so far. Now
 * the turn is OPENED with a PUT (which is what creates the relay row and
 * announces it) and everything after that goes up as the block events
 * themselves.
 *
 * The desktop is the single writer for a turn and sends strictly sequentially,
 * so the protocol is just a seq: the relay takes entry N+1 after N, and answers
 * 409 otherwise. The recovery from ANY uncertainty — a 409, a failed request, a
 * phone that starts watching mid-turn — is a `base`, a copy of the stream so
 * far, which is a correct next entry whatever the relay holds. The stream
 * always already contains what's queued, so re-basing means the queue can
 * simply be dropped: nothing is ever sent twice, nothing is ever lost.
 */
interface LiveTurnState {
  /** The opening PUT landed: the relay has the row and an empty base (seq 1). */
  opened: boolean;
  seq: number;
  needBase: boolean;
  queue: AgentEvent[];
  inflight: boolean;
}
const liveTurns = new Map<string, LiveTurnState>();
const newLiveTurn = (): LiveTurnState => ({ opened: false, seq: 1, needBase: false, queue: [], inflight: false });

/** Forget what's queued and start the next entry from a base. */
function rebase(st: LiveTurnState): void {
  st.queue = [];
  st.needBase = true;
}

async function flushLiveTurn(path: string, turnId: string, st: LiveTurnState, stream: BlockStream, startedAt: number): Promise<void> {
  st.inflight = true;
  try {
    // The opening PUT creates the relay row and announces the turn. Until it
    // lands nothing else can, so a failure here is retried by the next tick —
    // and so is a turn that started while nobody was watching: it is opened by
    // the first tick after a viewer connects, and its base carries everything
    // so far (the held ticks re-based it).
    if (!st.opened) {
      if (publishHeld()) return;
      const res = await relayFetch(path, {
        method: 'PUT',
        body: JSON.stringify({ turnId, status: 'running', blocks: [], startedAt }),
      }).catch(() => null);
      if (!res?.ok) return rebase(st);
      st.opened = true;
    }
    while ((st.needBase || st.queue.length) && !publishHeld()) {
      const sending = st.queue;
      st.queue = [];
      // Serialize NOW: `stream` keeps mutating as the turn runs, so a base is
      // only a valid replacement for `sending` at the moment it was taken.
      const entry = st.needBase ? { seq: 1, base: stream } : { seq: st.seq + 1, events: sending };
      const body = JSON.stringify(entry);
      const res = await relayFetch(`${path}/${encodeURIComponent(turnId)}/deltas`, { method: 'POST', body }).catch(() => null);
      if (res?.ok) {
        const { next } = (await res.json().catch(() => ({ next: entry.seq + 1 }))) as { next: number };
        st.seq = next - 1;
        st.needBase = false;
        continue;
      }
      // A 409 means the log isn't where we thought (expired, reset by a late
      // opening PUT, a 200 we never saw): send the base now. Anything else is the
      // relay being unwell — the breaker owns the backoff; re-base when it closes.
      rebase(st);
      if (res?.status !== 409) return;
    }
  } finally {
    st.inflight = false;
  }
}

/** Stream a LOCAL turn to the relay so the web shows it live (§6.3). Cloud turns
 *  stream via the box journal, so those are skipped. Image refs in the finished
 *  blocks are rewritten to relay URLs (§6.4). */
export async function publishLiveTurn(workspaceId: string, agentId: number, turn: LiveTurnPublish): Promise<void> {
  if (!isLinked()) return;
  const ws = Workspaces.get(workspaceId);
  if (!ws || isCloudWorkspace(ws) || !wsSynced(ws)) return;
  const id = `${workspaceId}:${agentId}`;
  const path = `/api/conversations/${encodeURIComponent(id)}/turn`;

  if (turn.status !== 'running') {
    const opened = liveTurns.get(turn.turnId)?.opened ?? false;
    liveTurns.delete(turn.turnId);
    // A turn the relay opened must be closed here even if the viewer has since
    // left: the history backfill never overwrites a turn row, so skipping this
    // would strand it on "running". One it never saw arrives whole with the
    // next catch-up's backfill instead.
    if (relayPaused() || (!opened && publishHeld())) return;
    const blocks = await rewriteBlocksImages(ws, (turn.blocks as AgentBlock[]) ?? []);
    await relayFetch(path, { method: 'PUT', body: JSON.stringify({ ...turn, blocks }) }).catch(() => {});
    return;
  }

  // A relay that predates the delta protocol (no `watch` in its poll response)
  // still wants the whole snapshot every tick.
  if (relayMode() === 'legacy') {
    if (relayPaused()) return;
    await relayFetch(path, {
      method: 'PUT',
      body: JSON.stringify({ turnId: turn.turnId, status: 'running', blocks: snapshotBlocks(turn.stream), startedAt: turn.startedAt }),
    }).catch(() => {});
    return;
  }

  const st = liveTurns.get(turn.turnId) ?? newLiveTurn();
  liveTurns.set(turn.turnId, st);
  // Nobody is watching (or the relay is down): drop the tick and re-base when we
  // resume — sending the next events on top would be a silent gap.
  if (publishHeld()) rebase(st);
  else st.queue.push(...turn.events);
  if (!st.inflight) await flushLiveTurn(path, turn.turnId, st, turn.stream, turn.startedAt);
}

/** PUT a `/git` panel blob, gated on its own fingerprint so an unchanged list
 *  costs a settings read and a sha1 instead of an HTTPS round-trip. Every
 *  schedulePublish batch fires todos AND comments for the workspace, so before
 *  this a streaming turn pushed two ungated PUTs per tick, forever (§4.1). */
async function publishGitBlob(workspaceId: string, fpPrefix: string, build: () => Record<string, unknown>): Promise<void> {
  if (!isLinked() || !wsIdPublishable(workspaceId) || publishHeld()) return;
  const body = JSON.stringify(build());
  const fp = digest(body);
  if (Settings.raw(`${fpPrefix}${workspaceId}`) === fp) return;
  const res = await relayFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/git`, { method: 'PUT', body }).catch(() => null);
  if (res?.ok) Settings.setRaw(`${fpPrefix}${workspaceId}`, fp);
}

/** Publish a workspace's todos to the relay Checks tab (§10.3). */
export async function publishTodos(workspaceId: string): Promise<void> {
  await publishGitBlob(workspaceId, 'account.tfp.', () => ({
    todos: Todos.list(workspaceId).map((t) => ({ id: t.id, text: t.text, done: t.done })),
  }));
}

/** Publish a workspace's diff comments to the relay Diff view (§10.4). */
export async function publishComments(workspaceId: string): Promise<void> {
  await publishGitBlob(workspaceId, 'account.cmfp.', () => ({
    comments: Comments.list(workspaceId).map((c) => ({
      id: c.id,
      file: c.file,
      line: c.line,
      side: c.side,
      body: c.body,
      resolved: c.resolved,
    })),
  }));
}

/**
 * Subscription usage for the settings mirror (web-neon-usage-diet §3.2): one
 * entry per harness the user actually has live work in — synced, not archived,
 * not cloud (a cloud workspace's harness runs on the box, so this desktop's
 * windows don't describe it). `pct` is ROUNDED: it used to ride every
 * conversation row unrounded, so a float drifting by 0.03 % re-published the
 * whole fleet every five minutes and kept Neon awake around the clock.
 *
 * `getSubUsage` caches for 30 s, so calling this from the 400 ms publish flush
 * costs one workspace list + a JSON round-trip, not a network fetch.
 */
type PublishedUsage = Partial<Record<HarnessId, SubUsage | null>>;

/** An ISO timestamp rounded to the minute; anything unparseable passes through. */
function minuteIso(iso: string | undefined): string | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(Math.round(t / 60_000) * 60_000).toISOString() : iso;
}

async function publishedUsage(): Promise<PublishedUsage> {
  const harnesses = new Set<HarnessId>();
  for (const ws of Workspaces.list()) {
    if (!wsSynced(ws) || ws.archived || isCloudWorkspace(ws)) continue;
    harnesses.add(ws.harness);
  }
  const value: PublishedUsage = {};
  // Sorted so the body — which IS the fingerprint below — doesn't move just
  // because a workspace was created in a different order.
  for (const harness of [...harnesses].sort()) {
    const usage = await getSubUsage(harness, activeLogin(harness).id).catch(() => null);
    // asOf dropped: it flips with every rate-limited read and would re-PUT.
    // resetsAt to the minute: Claude stamps it with the READ's microseconds
    // ("…T03:30:00.921518+00:00"), so it too moved on every refresh and defeated
    // the fingerprint — a Postgres write per 30-s usage refresh (neon-idle-compute).
    value[harness] = usage
      ? {
          ...usage,
          asOf: undefined,
          windows: usage.windows.map((w) => ({ ...w, pct: Math.round(w.pct), resetsAt: minuteIso(w.resetsAt) })),
        }
      : null;
  }
  return value;
}

/** Mirror this desktop's new-conversation defaults (harness/model/effort), its
 *  theme (family + light/dark mode) and the per-harness subscription usage to the
 *  relay, so Maestro Web's composer + new-workspace chips default to what the user
 *  configured here, it wears the same theme, and its usage ring has something to
 *  read — including immediately on the initial link (publishAll
 *  fires it) and whenever they change a default in Settings (settings-sync).
 *  Two-way for the defaults: a pick on the web comes back as a web-origin
 *  `settings-updated` event (applyWebSettings). Fingerprint-gated on the whole
 *  body so an unchanged blob doesn't re-PUT. */
export async function publishSettings(): Promise<void> {
  if (!isLinked() || publishHeld()) return;
  const body = JSON.stringify({ ...pickSyncedSettings(Settings.global()), usage: await publishedUsage() });
  if (Settings.raw('account.settingsfp') === body) return;
  const res = await relayFetch('/api/settings', { method: 'PUT', body });
  if (res.ok) Settings.setRaw('account.settingsfp', body);
}

/** Drop the publish fingerprints so the next publishAll() is a full push, not a
 *  fingerprint-gated diff. Both gates assume the relay still holds what we last
 *  sent — true within one link, void across a re-link or relay reset:
 *    - `account.wsfp.*` gates the workspace-row PUT (publishWorkspace); stale, the
 *      sidebar shows only the workspace whose state is still churning.
 *    - `account.fp.*` gates the history backfill (publishConversation); stale, the
 *      rows come back but with empty transcripts.
 *    - `account.cfp.*` gates the conversation metadata PUT (publishConversation);
 *      stale, the conversation rows never reappear at all.
 *    - `account.settingsfp` gates the settings mirror (publishSettings); stale, a
 *      re-link to a different / reset account never re-pushes the defaults.  */
function clearPublishFingerprints(): void {
  Settings.clearPrefix('account.wsfp.');
  Settings.clearPrefix('account.fp.');
  // `account.cfp.*` gates the conversation METADATA PUT (publishConversation,
  // web-relay-egress-quota §B1); stale, the relay keeps whatever title/state it
  // had when the previous link ended.
  Settings.clearPrefix('account.cfp.');
  // `account.bfmark.*` records how far the relay's copy of each conversation
  // reaches (perf-cpu-ram §4.2); stale, the next backfill would send only the tail
  // to a relay that holds none of the history. Clearing it forces a full one.
  Settings.clearPrefix('account.bfmark.');
  // `account.tfp.*` / `account.cmfp.*` / `account.rsfp.*` gate the todos, diff-
  // comment and run-script blobs (§4.1, web-neon-usage-diet §3.8).
  Settings.clearPrefix('account.tfp.');
  Settings.clearPrefix('account.cmfp.');
  Settings.clearPrefix('account.rsfp.');
  // `account.read.*` is the read mark the relay last took (pushReadState).
  Settings.clearPrefix('account.read.');
  // `account.img.*` maps an image's content hash to the relay URL we uploaded it
  // to (§3.6); those URLs belong to the previous link's account. The relay dedupes
  // by the same hash, so re-uploading costs bandwidth once, never a second row.
  Settings.clearPrefix('account.img.');
  Settings.setRaw('account.settingsfp', '');
}

/** Publish every synced workspace + conversation whose fingerprint changed
 *  (periodic + on link). Workspaces first (rows the Sidebar needs), then their
 *  sessions. Archived workspaces go through `publishWorkspace` too — for them it
 *  is a DELETE (web-neon-usage-diet §3.5), which is how the already-published
 *  archived rows leave the relay on the first run after this ships — but they have
 *  no conversations to publish. */
export async function publishAll(): Promise<void> {
  if (!isLinked() || publishHeld()) return;
  // Mirror the user's default harness/model/effort + subscription usage first so
  // the web's chips and usage ring are right the moment its fleet loads after a
  // link (settings-sync, §3.2).
  void publishSettings().catch(() => {});
  for (const ws of Workspaces.list().filter(wsSynced)) await publishWorkspace(ws).catch(() => {});
  for (const { ws, agentId } of publishedChats()) await publishConversation(ws, agentId).catch(() => {});
}

/** Forget the publish fingerprints and push everything up again now — the manual
 *  recovery when the relay has drifted out of sync with this desktop (a web-side
 *  reset, or workspaces that never made it up because their fingerprint claimed
 *  they already had). Same effect as a fresh link's initial publish, but without
 *  re-linking. Returns the number of synced workspaces re-published so the UI can
 *  confirm the whole fleet went up, not just the one that was churning. */
export async function resyncAll(): Promise<{ workspaces: number }> {
  if (!isLinked()) return { workspaces: 0 };
  clearPublishFingerprints();
  // Count the fleet up front, then re-push in the BACKGROUND and return at once.
  // A full publishAll() — every workspace row, then every conversation's metadata
  // + history backfill, all sequential — routinely runs for minutes on a real
  // fleet, far longer than the web's ~30s resync poll window. Awaiting it here kept
  // the relay job unacked that whole time, so the web never saw it settle and
  // always fell back to "Re-sync is taking a while…" even when it was working.
  // Acking now lets the web confirm immediately; the workspaces stream back over
  // the normal publish path and appear live (SSE) as each one lands.
  const workspaces = new Set(publishedChats().map((c) => c.ws.id)).size;
  void publishAll().catch(() => {});
  return { workspaces };
}

/** Debounced publish of one workspace + its sessions — the trigger every mutation
 *  site calls (§9.5.3). Coalesces bursts so a streaming turn doesn't spam PUTs. */
const publishTimers = new Map<string, NodeJS.Timeout>();
export function schedulePublish(workspaceId: string): void {
  // Cheapest test FIRST (perf-cpu-ram §4.1). Coalesce to the FIRST trigger +
  // 400ms (don't reset on each), so a streaming turn's burst of broadcasts still
  // publishes promptly instead of starving — and so the guards below, which cost
  // settings reads and a workspace row, are skipped for every trigger but the one
  // that arms the timer.
  if (publishTimers.has(workspaceId)) return;
  if (publishHeld() || !isLinked() || !wsIdSynced(workspaceId)) return;
  publishTimers.set(
    workspaceId,
    setTimeout(() => {
      publishTimers.delete(workspaceId);
      const ws = Workspaces.get(workspaceId);
      if (!ws) return;
      // Archiving lands here as a `workspace:` broadcast: publishWorkspace deletes
      // the row, and nothing else may publish into it afterwards (§3.5).
      void publishWorkspace(ws).catch(() => {});
      if (!ws.archived) {
        void publishTodos(ws.id).catch(() => {});
        void publishComments(ws.id).catch(() => {});
        for (const id of chatIds(ws.id)) void publishConversation(ws, id).catch(() => {});
      }
      // Subscription usage rides the settings row now (§3.2), so this is where a
      // turn's usage change reaches the web. Fingerprint-gated on the whole body,
      // and the percentages are whole numbers, so the common "nothing moved" case
      // costs a settings read rather than a PUT per conversation.
      void publishSettings().catch(() => {});
    }, 400)
  );
}

// ---------- project sync selection ----------

/** Drop one workspace's publish fingerprints so the next publish re-sends its row,
 *  its /git blobs and every chat's backfill from scratch — the gates in
 *  publishWorkspace/publishConversation otherwise skip unchanged rows. Used
 *  wherever the relay no longer holds the workspace: a deselected project, and an
 *  archived workspace we just deleted (web-neon-usage-diet §3.5). */
function clearWorkspaceFingerprints(ws: Workspace): void {
  Settings.setRaw(`account.wsfp.${ws.id}`, '');
  Settings.setRaw(`account.tfp.${ws.id}`, '');
  Settings.setRaw(`account.cmfp.${ws.id}`, '');
  Settings.setRaw(`account.rsfp.${ws.id}`, '');
  for (const id of chatIds(ws.id)) {
    Settings.setRaw(`account.fp.${ws.id}:${id}`, '');
    Settings.setRaw(`account.cfp.${ws.id}:${id}`, '');
    // The relay no longer has this conversation, so the re-publish has to carry
    // the whole history, not a tail (§4.2).
    Settings.setRaw(`account.bfmark.${ws.id}:${id}`, '');
    Settings.setRaw(`account.read.${ws.id}:${id}`, '');
  }
}

/** Drop the publish fingerprints for every workspace of a project. */
function clearProjectFingerprints(projectId: string): void {
  for (const ws of Workspaces.forProject(projectId)) clearWorkspaceFingerprints(ws);
}

/** Delete a deselected project's already-published rows from the relay (workspace,
 *  diffs, conversations) so it disappears from the web, then clear its
 *  fingerprints so a later re-select republishes it. */
async function purgeProjectFromRelay(projectId: string): Promise<void> {
  for (const ws of Workspaces.forProject(projectId))
    await relayFetch(`/api/workspaces/${encodeURIComponent(ws.id)}`, { method: 'DELETE' }).catch(() => {});
  clearProjectFingerprints(projectId);
}

/** Publish every workspace + conversation of a re-selected project. Clearing the
 *  fingerprints first guarantees a full resend even when the rows were deselected
 *  while unlinked (so they were never purged and their fingerprints still match). */
async function republishProject(projectId: string): Promise<void> {
  clearProjectFingerprints(projectId);
  for (const ws of Workspaces.forProject(projectId)) {
    await publishWorkspace(ws).catch(() => {});
    for (const id of chatIds(ws.id)) await publishConversation(ws, id).catch(() => {});
  }
}

/** Toggle whether a project's workspaces sync to Maestro Web. Records the opt-out
 *  (default: every project syncs), then — when linked — reconciles the relay:
 *  deselect purges the project's rows, select republishes them. Unlinked, it only
 *  records the choice, which the next link's `publishAll` then honors. */
export async function setProjectSync(projectId: string, synced: boolean): Promise<void> {
  const account = Settings.global().account ?? { relayUrl: relayUrl(), deviceName: os.hostname(), linked: false };
  const optOut = new Set(account.projectOptOut ?? []);
  const wasSynced = !optOut.has(projectId);
  if (synced) optOut.delete(projectId);
  else optOut.add(projectId);
  Settings.setGlobal({ account: { ...account, projectOptOut: [...optOut] } });
  if (!isLinked() || synced === wasSynced) return;
  if (synced) await republishProject(projectId).catch(() => {});
  else await purgeProjectFromRelay(projectId).catch(() => {});
}

// ---------- pull web-originated deltas ----------

function syncCursor(): number {
  return Number(Settings.raw('account.syncCursor') || '0');
}
function setSyncCursor(n: number) {
  Settings.setRaw('account.syncCursor', String(n));
}

/** Insert a web-originated user message into local SQLite keyed by its minted id
 *  (idempotent). So when catch-up replays the turn-start frame, the thread reads
 *  correctly (§6.6). A later publish/pull with the same id is a no-op. */
export function applyWebUserMessage(convIdStr: string, messageId: string, text: string, _turnId?: string): void {
  const [wsId, agentStr] = convIdStr.split(':');
  const agentId = Number(agentStr || '1');
  const ws = Workspaces.get(wsId);
  if (!ws) return;
  if (Messages.exists(messageId)) return;
  const msg: ChatMessage = {
    id: messageId,
    workspaceId: wsId,
    agentId,
    role: 'user',
    content: text,
    attachments: [],
    ts: now(),
    meta: { queued: true, origin: 'web' },
  };
  Messages.insert(msg);
  broadcast('chat:message', msg);
}

/** Apply web read-state (LWW): advance the local lastReadAt if the relay's is newer. */
function applyReadState(convIdStr: string, lastReadAt: number): void {
  const [wsId, agentStr] = convIdStr.split(':');
  const agentId = Number(agentStr || '1');
  const chat = Workspaces.getChats(wsId)[String(agentId)];
  if (!chat) return;
  if ((chat.lastReadAt ?? 0) < lastReadAt) {
    Workspaces.patchChat(wsId, agentId, { lastReadAt });
    // The relay already holds this mark — don't echo it back (pushReadState).
    Settings.setRaw(`account.read.${wsId}:${agentId}`, String(lastReadAt));
  }
}

/** Adopt new-conversation defaults and the theme picked on Maestro Web
 *  (settings-sync). Only a web-originated `settings-updated` counts — the relay
 *  also emits one for every desktop's own mirror PUT, and following those would
 *  let two linked desktops ping-pong. Only the known fields, validated, so the relay can't write anything
 *  else into local settings. */
function applyWebSettings(p: any): void {
  const cur = Settings.global();
  const patch: Partial<GlobalSettings> = {};
  if (typeof p?.defaultHarness === 'string' && p.defaultHarness in HARNESS_DISPLAY)
    patch.defaultHarness = p.defaultHarness as HarnessId;
  if (p?.defaultModels && typeof p.defaultModels === 'object' && !Array.isArray(p.defaultModels)) {
    const models: Partial<Record<HarnessId, string>> = { ...(cur.defaultModels ?? {}) };
    for (const [h, m] of Object.entries(p.defaultModels as Record<string, unknown>)) {
      if (h in HARNESS_DISPLAY && typeof m === 'string') models[h as HarnessId] = m;
    }
    patch.defaultModels = models;
  }
  if (typeof p?.defaultEffort === 'string' && p.defaultEffort) patch.defaultEffort = p.defaultEffort;
  // The appearance syncs too (a theme picked on the web re-themes this desktop).
  // Only changed values, so the no-op check below still holds for an echo.
  if (isThemeMode(p?.theme) && p.theme !== cur.theme) patch.theme = p.theme;
  if (isColorTheme(p?.colorTheme) && p.colorTheme !== cur.colorTheme) patch.colorTheme = p.colorTheme;
  if (Object.keys(patch).length === 0) return;
  const next = Settings.setGlobal(patch);
  broadcast('settings:updated', next);
  // Re-mirror (fingerprint-gated): the relay already holds these values, but the
  // stored fingerprint still describes the pre-web body.
  void publishSettings().catch(() => {});
}

/** Apply web-originated deltas (message-queued for web sends, read-state). Shared
 *  by the boot pull and the device bridge's long-poll (§12.3). */
export function applyEvents(events: any[]): void {
  for (const e of events ?? []) {
    if (e.kind === 'message-queued' && e.payload?.origin === 'web') {
      applyWebUserMessage(e.conversationId, e.payload.messageId, e.payload.text ?? '', e.payload.turnId);
    } else if (e.kind === 'read-state' && typeof e.payload?.lastReadAt === 'number') {
      applyReadState(e.conversationId, e.payload.lastReadAt);
    } else if (e.kind === 'settings-updated' && e.payload?.origin === 'web') {
      applyWebSettings(e.payload);
    }
  }
}

/** One pull of web-originated deltas since the stored cursor (boot only; the
 *  bridge's long-poll takes over the steady state — §12.3). */
export async function pullSync(): Promise<void> {
  if (!isLinked()) return;
  let j: any;
  try {
    const res = await relayFetch(`/api/sync?cursor=${syncCursor()}`);
    if (!res.ok) return;
    j = await res.json();
  } catch {
    return;
  }
  applyEvents(j.events);
  if (typeof j.next === 'number') setSyncCursor(j.next);
}

/** Push a chat's local read mark to the relay (LWW), so unread dots agree across
 *  devices (§6.6). Called from markChatRead and from every publishConversation;
 *  gated on the mark the relay last took (`account.read.*`), so a mark held while
 *  nobody watched goes up with the catch-up and an unchanged one costs nothing. */
export async function pushReadState(workspaceId: string, agentId: number): Promise<void> {
  if (!isLinked() || !wsIdPublishable(workspaceId) || publishHeld()) return;
  const lastReadAt = Workspaces.getChats(workspaceId)[String(agentId)]?.lastReadAt ?? 0;
  const key = `account.read.${workspaceId}:${agentId}`;
  if (lastReadAt <= Number(Settings.raw(key) || '0')) return;
  const res = await relayFetch('/api/read-state', {
    method: 'PUT',
    body: JSON.stringify({ conversationId: `${workspaceId}:${agentId}`, lastReadAt }),
  }).catch(() => null);
  if (res?.ok) Settings.setRaw(key, String(lastReadAt));
}

// ---------- box link (per saved SSH host) ----------

export async function linkBox(hostId: string, label?: string, cron?: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!isLinked()) return { ok: false, error: 'Sign in to Maestro Web first.' };
  const cfg = Hosts.get(hostId);
  try {
    const res = await relayFetch('/api/boxes', {
      method: 'POST',
      body: JSON.stringify({ label: label ?? cfg?.label ?? hostId, hostKeyFingerprint: cfg?.hostKeyFingerprint }),
    });
    if (!res.ok) return { ok: false, error: `relay returned ${res.status}` };
    const { boxId, boxToken: token } = (await res.json()) as { boxId: string; boxToken: string };
    setBoxToken(hostId, token);
    const host = hostById(hostId);
    await ensureSync(host, relayUrl(), token);
    // Install the drain worker too: maestro-sync stages web jobs but only
    // maestro-drain runs them, and sync's ensure_drain silently no-ops when the
    // worker shim is absent. Installing both here means a synced box can never
    // accept work it can't run.
    await ensureDrainShim(host);
    if (cron) await installSyncCron(host);
    const account = Settings.global().account!;
    Settings.setGlobal({
      account: {
        ...account,
        boxes: { ...(account.boxes ?? {}), [hostId]: { boxId, cron: !!cron } },
        // Re-linking clears any earlier manual opt-out (see autoLinkBoxes).
        boxOptOut: (account.boxOptOut ?? []).filter((id) => id !== hostId),
      },
    });
    // Publish the conversations that live on this host so they appear on the phone.
    void publishAll().catch(() => {});
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function unlinkBox(hostId: string): Promise<{ ok: boolean; error?: string }> {
  const account = Settings.global().account;
  const boxId = account?.boxes?.[hostId]?.boxId;
  try {
    if (boxId) await relayFetch(`/api/boxes/${boxId}`, { method: 'DELETE' }).catch(() => {});
    const host = hostById(hostId);
    await removeSyncCron(host).catch(() => {});
    await teardownSync(host).catch(() => {});
  } catch {}
  dropBoxLink(hostId);
  // Remember the manual opt-out so autoLinkBoxes won't re-link it next boot.
  const after = Settings.global().account;
  if (after) Settings.setGlobal({ account: { ...after, boxOptOut: [...new Set([...(after.boxOptOut ?? []), hostId])] } });
  return { ok: true };
}

/** Forget a host's box link locally (token + boxId). Nothing on the box or relay. */
function dropBoxLink(hostId: string): void {
  setBoxToken(hostId, null);
  const account = Settings.global().account;
  if (!account?.boxes?.[hostId]) return;
  const boxes = { ...account.boxes };
  delete boxes[hostId];
  Settings.setGlobal({ account: { ...account, boxes } });
}

/** Box ids the relay still honours, or null when it can't say (offline, or a
 *  relay that predates the field) — callers then trust the local link. */
async function liveBoxIds(): Promise<Set<string> | null> {
  try {
    const res = await relayFetch('/api/devices');
    if (!res.ok) return null;
    const j = (await res.json()) as { boxes?: string[] };
    return Array.isArray(j.boxes) ? new Set(j.boxes) : null;
  } catch {
    return null;
  }
}

/** Whether a host has a linked box + its sync.offset (rotation guard, §6.5). The
 *  rotation guard in cloud.ts calls this to require sync.offset == size before
 *  truncating a linked box's journal (so the relay never loses a tail). */
export function boxLinkedForHost(hostId: string | null | undefined): boolean {
  if (!hostId) return false;
  return !!Settings.global().account?.boxes?.[hostId] && !!boxToken(hostId);
}

let linkPass: Promise<void> = Promise.resolve();

/** Box-link every saved SSH host by default, so cloud conversations are reachable
 *  from Maestro Web even with the desktop closed. Best-effort + idempotent:
 *  requires the desktop to be linked, skips k8s clusters (maestro-sync is an
 *  SSH/POSIX loop, not a cluster thing), skips hosts already linked or explicitly
 *  opted out (a manual unlink), and swallows per-host failures so one unreachable
 *  host never blocks the rest. Installs the reboot-survival cron so a linked box
 *  stays reachable across reboots. Fired on link, boot, and host add — the passes
 *  are serialized so overlapping triggers can't double-register one box (each pass
 *  re-reads the list and skips whatever the previous pass already linked). */
export function autoLinkBoxes(): Promise<void> {
  linkPass = linkPass.catch(() => {}).then(async () => {
    if (!isLinked()) return;
    const optOut = new Set(Settings.global().account?.boxOptOut ?? []);
    const live = await liveBoxIds();
    for (const h of Hosts.list()) {
      if (h.kind === 'k8s' || optOut.has(h.id)) continue;
      // A link the relay revoked (Reset Maestro Web, an unlink from the web) is
      // dead for good: re-asserting its token left the box answering 401 forever
      // — offline on the web, and every retry woke Neon (neon-idle-compute).
      // Drop it so the host is re-linked with a fresh token below.
      const boxId = Settings.global().account?.boxes?.[h.id]?.boxId;
      if (boxId && live && !live.has(boxId)) dropBoxLink(h.id);
      if (boxLinkedForHost(h.id)) {
        // Already linked: re-assert both shims on the box so one linked before a
        // fix shipped self-heals on the next boot — the drain worker (a box that
        // was linked with sync only would silently swallow web sends forever) and
        // the sync loop itself (ensureSync restarts one running an older shim;
        // the cron lines carry the shim hash, so they are refreshed with it).
        const token = boxToken(h.id);
        if (token) {
          const host = hostById(h.id);
          await ensureDrainShim(host).catch(() => {});
          await ensureSync(host, relayUrl(), token).catch(() => {});
          if (Settings.global().account?.boxes?.[h.id]?.cron) await installSyncCron(host).catch(() => {});
        }
        continue;
      }
      await linkBox(h.id, h.label, /* cron */ true).catch(() => {});
    }
  });
  return linkPass;
}

// ---------- status + boot ----------

/** Every linked desktop for this account, from the relay (its source of truth), so
 *  Settings → Account lists them all and can unlink any. Best-effort: unlinked or
 *  offline yields an empty list — `linked`/`deviceName` still describe this desktop,
 *  so the panel degrades to the pre-list single-device summary. */
async function fetchLinkedDevices(): Promise<AccountStatus['devices']> {
  if (!isLinked()) return [];
  try {
    const res = await relayFetch('/api/devices');
    if (!res.ok) return [];
    const j = (await res.json()) as { devices?: AccountStatus['devices'] };
    return Array.isArray(j.devices) ? j.devices : [];
  } catch {
    return [];
  }
}

/** Resolve `p`, or `fallback` if it hasn't settled within `ms`. Keeps a slow or
 *  unreachable box from wedging Settings → Account on a spinner: each `syncStatus`
 *  probe is a chain of SSH round-trips with no inner deadline, so one down box
 *  could otherwise block the whole panel until ssh.ts's connect timeouts elapse. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    void p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

export async function accountStatus(): Promise<AccountStatus> {
  const account = Settings.global().account;
  // Probe every linked box in parallel and time-bounded — an offline box reports
  // 'unknown' (a state the UI already renders) instead of hanging the response.
  const boxes: AccountStatus['boxes'] = Object.fromEntries(
    await Promise.all(
      Object.entries(account?.boxes ?? {}).map(async ([hostId, link]) => {
        const state = await withTimeout(syncStatus(hostById(hostId)), 6000, 'unknown' as const);
        return [hostId, { boxId: link.boxId, state, cron: link.cron }] as const;
      }),
    ),
  );
  return {
    linked: isLinked(),
    relayUrl: relayUrl(),
    deviceName: account?.deviceName || os.hostname(),
    user: account?.user,
    boxes,
    devices: await fetchLinkedDevices(),
    projectOptOut: account?.projectOptOut ?? [],
    mode: relayMode(),
  };
}

let publishTimer: NodeJS.Timeout | null = null;

/** Boot: pull web-originated deltas ONCE before catch-up (so replayed turns read
 *  correctly, §6.6), then hand the steady state to the device bridge's long-poll
 *  (§9.3) — which publishes whenever a viewer connects — with a 5-min
 *  fingerprint-gated publish safety net.
 *  Returns after the first pull so `index.ts` can order it before `catchUpAll`. */
export async function startAccountSync(): Promise<void> {
  if (!isLinked()) return;
  await pullSync().catch(() => {});
  void reportRelayBus().catch(() => {});
  // No publishAll here: the bridge runs it as soon as its first poll says a web
  // client is watching (or that the relay predates the flag). An unwatched boot
  // leaves the relay — and Neon — alone.
  // Reconcile box links each boot: pick up hosts added while unlinked or whose
  // earlier auto-link failed (a no-op for already-linked and opted-out hosts).
  void autoLinkBoxes().catch(() => {});
  startBridge();
  // Re-publish a workspace whenever a chat/workspace broadcast touches it — the
  // one place that covers every §9.5.3 trigger (turn start/end, meta, CRUD, …).
  setBroadcastHook((channel, payload) => {
    // `chat:event` is one broadcast per streamed token (claude runs with
    // --include-partial-messages), and none of them changes a conversation ROW:
    // the live turn mirrors through the live-turn hook below, and every row-level
    // change (session id, running flag, title, new message, queue, scheduled) has
    // its own broadcast. So it is not a publish trigger (perf-cpu-ram §4.1) — the
    // context/usage chips settle at the next one, i.e. turn end.
    if (channel === 'chat:event') return;
    const wsId = (payload as { workspaceId?: unknown })?.workspaceId;
    if (typeof wsId !== 'string') return;
    // `pr:status` fires on every refreshPr (turn end, background poll, merge
    // attempt) and carries the mergeable/checks the Merge vs Resolve-conflicts
    // button keys off — republish so the web tracks it live (§10.1).
    if (channel.startsWith('chat:') || channel.startsWith('workspace:') || channel === 'pr:status') schedulePublish(wsId);
    else if (channel.startsWith('runscript:')) void publishRunScripts(wsId).catch(() => {});
    else if (channel.startsWith('todo:')) void publishTodos(wsId).catch(() => {});
    else if (channel.startsWith('comment:')) void publishComments(wsId).catch(() => {});
  });
  // Stream local turns live (§6.3).
  setLiveTurnHook((wsId, agentId, turn) => void publishLiveTurn(wsId, agentId, turn).catch(() => {}));
  if (publishTimer) clearInterval(publishTimer);
  publishTimer = setInterval(() => void publishAll().catch(() => {}), 5 * 60_000);
}

export function stopAccountSync(): void {
  if (publishTimer) clearInterval(publishTimer);
  publishTimer = null;
  setBroadcastHook(null);
  setLiveTurnHook(null);
  // Nothing will publish a terminal tick for whatever was mid-turn, so retire the
  // live-turn protocol state here rather than leaving it to the hook (§4.3).
  liveTurns.clear();
  stopBridge();
  cancelLink();
}
