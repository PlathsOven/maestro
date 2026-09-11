import os from 'os';
import { safeStorage } from 'electron';
import { broadcast, setBroadcastHook } from '../bus';
import { Comments, Hosts, Messages, Projects, Scheduled, Settings, Todos, Workspaces, now, uid } from '../db';
import { hostById, hostForWorkspace, isCloudWorkspace } from '../hosts';
import { isAgentRunning, setLiveTurnHook, type LiveTurnPublish } from './harness';
import { githubOwner } from './capabilities';
import { readAttachment } from './files';
import { startBridge, stopBridge } from './bridge';
import { listRunScripts, runScriptStates } from './runscripts';
import { firstCommandLine } from '../../shared/rundoc';
import type { ScriptState } from '../../shared/types';
import { ensureSync, teardownSync, installSyncCron, removeSyncCron, syncStatus, syncCrontabLines } from './cloudsync';
import { ensureDrainShim } from './cloud';
import type { AccountStatus, AgentBlock, ChatMessage, GlobalSettings, Project, Workspace } from '../../shared/types';

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

export function relayUrl(): string {
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

function deviceToken(): string | null {
  return decryptSecret(Settings.raw('account.token'));
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

// ---------- relay fetch ----------

export async function relayFetch(path: string, init: RequestInit & { auth?: string } = {}): Promise<Response> {
  const { auth, ...rest } = init;
  const headers = new Headers(rest.headers);
  const token = auth ?? deviceToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (rest.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(`${relayUrl()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(30_000) });
  // Our device token was rejected — it was revoked/deleted on the relay (the user
  // hit "Reset Maestro Web" from the web, or revoked this desktop). Flip to
  // signed-out so the desktop stops silently failing every publish and the UI
  // shows "link again", instead of forever claiming it's linked. Only when WE used
  // the device token (not an explicit box/other token) and one was actually sent.
  if (res.status === 401 && auth === undefined && token) handleDeviceRevoked();
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
    // Publish everything we already have so the phone shows history immediately.
    void publishAll().catch(() => {});
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
function projectSynced(projectId: string): boolean {
  return !(Settings.global().account?.projectOptOut ?? []).includes(projectId);
}
const wsSynced = (ws: Workspace): boolean => projectSynced(ws.projectId);
/** Sync guard for the workspaceId-only publishers. A missing workspace passes
 *  (each caller's own logic handles absence) — only a deselected project blocks. */
const wsIdSynced = (workspaceId: string): boolean => {
  const ws = Workspaces.get(workspaceId);
  return !ws || wsSynced(ws);
};

/** Every non-deleted workspace + its sessions to mirror (all workspaces now —
 *  local included; archived included, since History needs them). §9.5.1.
 *  Workspaces whose project the user deselected from sync are excluded. */
function publishedChats(): { ws: Workspace; agentId: number }[] {
  const out: { ws: Workspace; agentId: number }[] = [];
  for (const ws of Workspaces.list()) {
    if (!wsSynced(ws)) continue;
    for (const id of chatIds(ws.id)) out.push({ ws, agentId: id });
  }
  return out;
}

function wsFingerprint(ws: Workspace, proj: Project | null, repoOwner: string | null): string {
  return [
    ws.title, ws.subtitle, ws.name, ws.status, ws.archived, ws.branch, ws.hostId,
    ws.prNumber, ws.prState, ws.prUrl, ws.setupError, ws.port, proj?.name, proj?.baseBranch,
    repoOwner,
  ].join('|');
}

/** Publish one workspace row (web-desktop-parity §9.2/§9.5). Fingerprint-gated. */
export async function publishWorkspace(ws: Workspace): Promise<void> {
  if (!isLinked() || !wsSynced(ws)) return;
  const proj = Projects.get(ws.projectId);
  // GitHub owner for the web sidebar's repo avatar (desktop parity); cached per
  // repoPath, and in the fingerprint so it backfills for already-synced rows.
  const repoOwner = proj ? await githubOwner(proj.repoPath) : null;
  const fp = wsFingerprint(ws, proj, repoOwner);
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
    lastUserMessageAt: ws.lastUserMessageAt,
  };
  const res = await relayFetch(`/api/workspaces/${encodeURIComponent(ws.id)}`, { method: 'PUT', body: JSON.stringify(body) });
  if (res.ok) Settings.setRaw(`account.wsfp.${ws.id}`, fp);
}

function metaFingerprint(ws: Workspace, agentId: number): string {
  const chat = Workspaces.getChats(ws.id)[String(agentId)] ?? {};
  const msgs = Messages.list(ws.id).filter((m) => m.agentId === agentId);
  return [
    ws.title, chat.title, ws.archived, ws.status, ws.hostId, msgs.length, chat.lastAgentAt,
    chat.model, chat.effort, chat.planMode, chat.contextTokens, chat.attention, chat.closed,
    chat.titleCustom, chat.lastReadAt, isAgentRunning(ws.id, agentId),
    Scheduled.forWorkspace(ws.id).filter((s) => s.agentId === agentId).map((s) => `${s.id}:${s.deliverAt}:${s.text.length}`).join(','),
  ].join('|');
}

// Worktree images an agent embedded (`![](.context/x.png)`) can't load from the
// web's origin, so on publish we upload each once and rewrite the markdown ref to
// the relay URL (web-desktop-parity §6.4). Cached per (workspace, ref).
const imageUrlCache = new Map<string, string>();
const IMG_REF_RE = /!\[[^\]]*\]\(([^)\s]+)/g;

async function uploadImage(dataUrl: string): Promise<string | null> {
  try {
    const res = await relayFetch('/api/attachments', { method: 'POST', body: JSON.stringify({ dataUrl }) });
    if (!res.ok) return null;
    const j = (await res.json()) as { url?: string };
    return j.url ? `${relayUrl()}${j.url}` : null;
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
    const key = `${ws.id}:${ref}`;
    let url = imageUrlCache.get(key);
    if (!url) {
      const att = await readAttachment(ws.worktreePath, ref, host).catch(() => null);
      if (att?.kind === 'image' && att.dataUrl) {
        const u = await uploadImage(att.dataUrl);
        if (u) {
          url = u;
          imageUrlCache.set(key, u);
        }
      }
    }
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

/** Local turns + user messages for a chat, in the relay's backfill shape. */
async function backfillPayload(ws: Workspace, agentId: number) {
  const msgs = Messages.list(ws.id).filter((m) => m.agentId === agentId);
  const turns: any[] = [];
  const userMessages: any[] = [];
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
      userMessages.push({ id: m.id, text: m.content, origin: m.meta?.origin ?? 'desktop', turnId: undefined, queued: !!m.meta?.queued, createdAt: m.ts });
      pendingUserIdx = userMessages.length - 1;
    }
  }
  return { turns, userMessages };
}

export async function publishConversation(ws: Workspace, agentId: number): Promise<void> {
  if (!isLinked() || !wsSynced(ws)) return;
  const id = convId(ws, agentId);
  const chat = Workspaces.getChats(ws.id)[String(agentId)] ?? {};
  const proj = Projects.get(ws.projectId);
  const account = Settings.global().account;
  const boxId = ws.hostId ? account?.boxes?.[ws.hostId]?.boxId : undefined;
  const msgs = Messages.list(ws.id).filter((m) => m.agentId === agentId);
  const hasRun = msgs.some((m) => m.role === 'agent');
  const body = {
    workspaceId: ws.id,
    agentId,
    boxId: boxId ?? null,
    title: chat.title || ws.title || ws.name,
    subtitle: ws.subtitle ?? null,
    projectName: proj?.name ?? null,
    harness: ws.harness,
    state: ws.status,
    hasRun,
    archived: !!ws.archived,
    lastActivityAt: chat.lastAgentAt ?? now(),
    // Desktop-parity session fields (§9.2).
    model: chat.model ?? null,
    effort: chat.effort ?? null,
    planMode: !!chat.planMode,
    contextTokens: chat.contextTokens ?? null,
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
  const res = await relayFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
  if (!res.ok) return;
  // Backfill history (idempotent by id) whenever the fingerprint changed.
  const fp = metaFingerprint(ws, agentId);
  if (Settings.raw(`account.fp.${id}`) !== fp) {
    const payload = await backfillPayload(ws, agentId);
    if (payload.turns.length || payload.userMessages.length) {
      await relayFetch(`/api/conversations/${encodeURIComponent(id)}/backfill`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }).catch(() => {});
    }
    Settings.setRaw(`account.fp.${id}`, fp);
  }
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
 *  (web-desktop-parity §10.5). Patched via the /git endpoint (present-field). */
export async function publishRunScripts(workspaceId: string): Promise<void> {
  if (!isLinked() || !wsIdSynced(workspaceId)) return;
  try {
    const scripts = listRunScripts(workspaceId);
    const states = runScriptStates(workspaceId);
    const runScripts = scripts.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      command: firstCommandLine(s.doc),
      state: runScriptPhase(states[s.id]),
      exitCode: states[s.id]?.exitCode ?? undefined,
    }));
    await relayFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/git`, {
      method: 'PUT',
      body: JSON.stringify({ runScripts }),
    }).catch(() => {});
  } catch {
    /* run scripts unavailable — leave the relay value as-is */
  }
}

/** Stream a LOCAL turn to the relay so the web shows it live (§6.3). Cloud turns
 *  stream via the box journal, so those are skipped. Image refs in the finished
 *  blocks are rewritten to relay URLs (§6.4). */
export async function publishLiveTurn(workspaceId: string, agentId: number, turn: LiveTurnPublish): Promise<void> {
  if (!isLinked()) return;
  const ws = Workspaces.get(workspaceId);
  if (!ws || isCloudWorkspace(ws) || !wsSynced(ws)) return;
  const blocks =
    turn.status === 'running' ? turn.blocks : await rewriteBlocksImages(ws, (turn.blocks as AgentBlock[]) ?? []);
  await relayFetch(`/api/conversations/${encodeURIComponent(`${workspaceId}:${agentId}`)}/turn`, {
    method: 'PUT',
    body: JSON.stringify({ ...turn, blocks }),
  }).catch(() => {});
}

/** Publish a workspace's todos to the relay Checks tab (§10.3). */
export async function publishTodos(workspaceId: string): Promise<void> {
  if (!isLinked() || !wsIdSynced(workspaceId)) return;
  const todos = Todos.list(workspaceId).map((t) => ({ id: t.id, text: t.text, done: t.done }));
  await relayFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/git`, { method: 'PUT', body: JSON.stringify({ todos }) }).catch(() => {});
}

/** Publish a workspace's diff comments to the relay Diff view (§10.4). */
export async function publishComments(workspaceId: string): Promise<void> {
  if (!isLinked() || !wsIdSynced(workspaceId)) return;
  const comments = Comments.list(workspaceId).map((c) => ({
    id: c.id,
    file: c.file,
    line: c.line,
    side: c.side,
    body: c.body,
    resolved: c.resolved,
  }));
  await relayFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/git`, { method: 'PUT', body: JSON.stringify({ comments }) }).catch(() => {});
}

/** Drop the publish fingerprints so the next publishAll() is a full push, not a
 *  fingerprint-gated diff. Both gates assume the relay still holds what we last
 *  sent — true within one link, void across a re-link or relay reset:
 *    - `account.wsfp.*` gates the workspace-row PUT (publishWorkspace); stale, the
 *      sidebar shows only the workspace whose state is still churning.
 *    - `account.fp.*` gates the history backfill (publishConversation); stale, the
 *      rows come back but with empty transcripts.  */
function clearPublishFingerprints(): void {
  Settings.clearPrefix('account.wsfp.');
  Settings.clearPrefix('account.fp.');
}

/** Publish every workspace + conversation whose fingerprint changed (periodic +
 *  on link). Workspaces first (rows the Sidebar needs), then their sessions. */
export async function publishAll(): Promise<void> {
  if (!isLinked()) return;
  const seenWs = new Set<string>();
  const chats = publishedChats();
  for (const { ws } of chats) {
    if (seenWs.has(ws.id)) continue;
    seenWs.add(ws.id);
    await publishWorkspace(ws).catch(() => {});
  }
  for (const { ws, agentId } of chats) await publishConversation(ws, agentId).catch(() => {});
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
  if (!isLinked() || !wsIdSynced(workspaceId)) return;
  // Coalesce to the FIRST trigger + 400ms (don't reset on each), so a streaming
  // turn's burst of broadcasts still publishes promptly instead of starving.
  if (publishTimers.has(workspaceId)) return;
  publishTimers.set(
    workspaceId,
    setTimeout(() => {
      publishTimers.delete(workspaceId);
      const ws = Workspaces.get(workspaceId);
      if (!ws) return;
      void publishWorkspace(ws).catch(() => {});
      void publishTodos(ws.id).catch(() => {});
      void publishComments(ws.id).catch(() => {});
      for (const id of chatIds(ws.id)) void publishConversation(ws, id).catch(() => {});
    }, 400)
  );
}

// ---------- project sync selection ----------

/** Drop the publish fingerprints for every workspace of a project so the next
 *  publish re-sends each row + its backfill from scratch — the fingerprint gate
 *  in publishWorkspace/publishConversation otherwise skips unchanged rows. */
function clearProjectFingerprints(projectId: string): void {
  for (const ws of Workspaces.forProject(projectId)) {
    Settings.setRaw(`account.wsfp.${ws.id}`, '');
    for (const id of chatIds(ws.id)) Settings.setRaw(`account.fp.${ws.id}:${id}`, '');
  }
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
  if ((chat.lastReadAt ?? 0) < lastReadAt) Workspaces.patchChat(wsId, agentId, { lastReadAt });
}

/** Apply web-originated deltas (message-queued for web sends, read-state). Shared
 *  by the boot pull and the device bridge's long-poll (§12.3). */
export function applyEvents(events: any[]): void {
  for (const e of events ?? []) {
    if (e.kind === 'message-queued' && e.payload?.origin === 'web') {
      applyWebUserMessage(e.conversationId, e.payload.messageId, e.payload.text ?? '', e.payload.turnId);
    } else if (e.kind === 'read-state' && typeof e.payload?.lastReadAt === 'number') {
      applyReadState(e.conversationId, e.payload.lastReadAt);
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

/** Push local read state for a chat to the relay (LWW). Called from markChatRead. */
export async function pushReadState(workspaceId: string, agentId: number, lastReadAt: number): Promise<void> {
  if (!isLinked() || !wsIdSynced(workspaceId)) return;
  await relayFetch('/api/read-state', {
    method: 'PUT',
    body: JSON.stringify({ conversationId: `${workspaceId}:${agentId}`, lastReadAt }),
  }).catch(() => {});
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
  setBoxToken(hostId, null);
  if (account) {
    const boxes = { ...(account.boxes ?? {}) };
    delete boxes[hostId];
    // Remember the manual opt-out so autoLinkBoxes won't re-link it next boot.
    const boxOptOut = [...new Set([...(account.boxOptOut ?? []), hostId])];
    Settings.setGlobal({ account: { ...account, boxes, boxOptOut } });
  }
  return { ok: true };
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
    for (const h of Hosts.list()) {
      if (h.kind === 'k8s' || optOut.has(h.id)) continue;
      if (boxLinkedForHost(h.id)) {
        // Already linked: re-assert the drain worker on the box so one linked
        // before this shipped (sync installed, worker never uploaded) self-heals
        // on the next boot instead of silently swallowing web sends forever.
        const token = boxToken(h.id);
        if (token) await ensureDrainShim(hostById(h.id)).catch(() => {});
        continue;
      }
      await linkBox(h.id, h.label, /* cron */ true).catch(() => {});
    }
  });
  return linkPass;
}

// ---------- status + boot ----------

export async function accountStatus(): Promise<AccountStatus> {
  const account = Settings.global().account;
  const boxes: AccountStatus['boxes'] = {};
  for (const [hostId, link] of Object.entries(account?.boxes ?? {})) {
    let state: AccountStatus['boxes'][string]['state'] = 'unknown';
    try {
      state = await syncStatus(hostById(hostId));
    } catch {}
    boxes[hostId] = { boxId: link.boxId, state, cron: link.cron };
  }
  return {
    linked: isLinked(),
    relayUrl: relayUrl(),
    deviceName: account?.deviceName || os.hostname(),
    user: account?.user,
    boxes,
    projectOptOut: account?.projectOptOut ?? [],
  };
}

export function cronPreview(): { lines: string[] } {
  return { lines: syncCrontabLines() };
}

let publishTimer: NodeJS.Timeout | null = null;

/** Boot: pull web-originated deltas ONCE before catch-up (so replayed turns read
 *  correctly, §6.6), publish everything, then hand the steady state to the device
 *  bridge's long-poll (§9.3) with a 5-min fingerprint-gated publish safety net.
 *  Returns after the first pull so `index.ts` can order it before `catchUpAll`. */
export async function startAccountSync(): Promise<void> {
  if (!isLinked()) return;
  await pullSync().catch(() => {});
  void publishAll().catch(() => {});
  // Reconcile box links each boot: pick up hosts added while unlinked or whose
  // earlier auto-link failed (a no-op for already-linked and opted-out hosts).
  void autoLinkBoxes().catch(() => {});
  startBridge();
  // Re-publish a workspace whenever a chat/workspace broadcast touches it — the
  // one place that covers every §9.5.3 trigger (turn start/end, meta, CRUD, …).
  setBroadcastHook((channel, payload) => {
    const wsId = (payload as { workspaceId?: unknown })?.workspaceId;
    if (typeof wsId !== 'string') return;
    if (channel.startsWith('chat:') || channel.startsWith('workspace:')) schedulePublish(wsId);
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
  stopBridge();
  cancelLink();
}
