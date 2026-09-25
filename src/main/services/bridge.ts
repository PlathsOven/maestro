/**
 * The desktop bridge (web-desktop-parity spec §9.3, §9.4) — the desktop's side of
 * the device channel. A long-poll loop against `/api/device/poll` (which doubles
 * as the presence heartbeat) that applies web-originated deltas and executes the
 * jobs the web enqueues by calling the same service functions the IPC handlers
 * call. Every job is acked with its result via `/api/device/jobs/:id/done`, which
 * the web reacts to (job-done). At-least-once delivery: a small handled-id set
 * makes duplicate deliveries a no-op.
 *
 * The box still runs message/stop/queue_* for cloud workspaces; the device runs
 * those for local workspaces and every other kind (git/PR/workspace lifecycle).
 */
import { broadcast } from '../bus';
import { Comments, Messages, Settings, Todos, Workspaces, now, uid } from '../db';
import { isLinked, relayFetch, relayRetryIn, relayStatus, applyEvents, schedulePublish, publishRunScripts, publishTodos, publishComments, resyncAll, downloadAttachment } from './account';
import { agentLoopError, recordUserMessage, sendChat, clearQueue, removeQueued, editQueued, sendQueuedNow, scheduleChat, editScheduledChat } from './chat';
import { cancelScheduled } from './schedule';
import { createWorkspace, writeWorkspaceAttachment } from './workspaces';
import { execRunScript, stopRunScript } from './runscripts';
import { setWorkspaceCloud } from './cloudmove';
import { postSystem, stopAgent } from './harness';
import { submitAskAnswer } from './ask';
import type { Attachment, HarnessId } from '../../shared/types';
import {
  execPrCreate,
  execPrMerge,
  execContinueBranch,
  execResolveConflicts,
  execArchive,
  execRestore,
  execDelete,
  execGitRefresh,
  execStatusRegenerate,
} from './webexec';

interface Job {
  id: string;
  kind: string;
  conversationId: string;
  workspaceId?: string;
  payload: any;
}

let running = false;
let backoff = 2000;

/**
 * Cadence (web-relay-event-bus §4.4). The relay tells us on every poll whether
 * anything is watching this account; while something is we long-poll and stream
 * live turns, and when nothing is we drop to a heartbeat and Neon gets to sleep.
 * The grace window means a phone that reloads or flips apps doesn't cost the
 * user a wake-up. 'legacy' is a relay that predates the flag — it gets exactly
 * the old behaviour.
 */
export type RelayMode = 'live' | 'idle' | 'legacy';
const LIVE_GRACE_MS = 60_000;
/** Seconds between idle heartbeats; the relay sets it (`idleWait`). */
let idleWait = 30;
let sawWatch = false;
let watchingAt = 0;
let lastMode: RelayMode | null = null;

export function relayMode(): RelayMode {
  if (!sawWatch) return 'legacy';
  return Date.now() - watchingAt < LIVE_GRACE_MS ? 'live' : 'idle';
}

/** Tell the renderer when the cadence changes, so Settings → Account can say
 *  whether a phone is connected. */
function noteMode(): void {
  const mode = relayMode();
  if (mode === lastMode) return;
  lastMode = mode;
  broadcast('account:relay-status', relayStatus());
}

/** Sleep in ≤5s slices so a stop / sign-out still takes effect promptly. */
async function nap(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (running && isLinked() && Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(5000, until - Date.now())));
  }
}

function cursor(): number {
  return Number(Settings.raw('account.deviceCursor') || '0');
}
function setCursor(n: number) {
  Settings.setRaw('account.deviceCursor', String(n));
}

/** Last-N handled job ids (at-least-once dedup). */
function handled(): Set<string> {
  try {
    return new Set(JSON.parse(Settings.raw('bridge.handled') || '[]'));
  } catch {
    return new Set();
  }
}
function markHandled(id: string) {
  const set = handled();
  set.add(id);
  const arr = [...set].slice(-500);
  Settings.setRaw('bridge.handled', JSON.stringify(arr));
}

const parseConv = (conversationId: string): [string, number] => {
  const [wsId, agentStr] = conversationId.split(':');
  return [wsId, Number(agentStr || '1')];
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/** Turn the relay attachment refs a web send carried into local worktree
 *  attachments: download each photo over the device token and write it under
 *  .context/attachments/, so the harness reads it off disk like a desktop attach
 *  (web-desktop-parity §6.4). Failures are skipped — the text still sends. */
async function downloadWebAttachments(wsId: string, refs: unknown): Promise<Attachment[]> {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  const ws = Workspaces.get(wsId);
  if (!ws) return [];
  const out: Attachment[] = [];
  for (const ref of refs.slice(0, 10)) {
    const id = String((ref as any)?.id ?? '');
    if (!id) continue;
    const dl = await downloadAttachment(id);
    if (!dl) continue;
    const ext = EXT_BY_MIME[dl.mime.toLowerCase()] ?? 'png';
    const name = String((ref as any)?.name ?? '').trim() || `photo.${ext}`;
    const path = await writeWorkspaceAttachment(ws, { name, dataBase64: dl.dataBase64 });
    out.push({ kind: dl.mime.startsWith('image/') ? 'image' : 'file', path, label: name });
  }
  return out;
}

/** Execute one job by calling the same service function the IPC handler calls
 *  (§9.4). Returns the relay's `done` body. Unknown kinds stay compatible. */
async function runJob(job: Job): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const [wsId, agentId] = parseConv(job.conversationId);
  switch (job.kind) {
    case 'message': {
      // A `maestro-message` from an agent on another machine: apply the loop
      // guard here (the sender can't see this chat's history). A refused message
      // is still recorded — un-queued, under the relay's id — because
      // republishing that id is the only thing that clears the relay's queued row.
      const target = job.payload?.origin === 'agent' ? Workspaces.get(wsId) : null;
      const blocked = target && agentLoopError(wsId, agentId);
      if (target && blocked) {
        recordUserMessage(target, agentId, String(job.payload?.text ?? ''), [], now(), { id: job.payload?.messageId, origin: 'agent' });
        postSystem(wsId, agentId, `Didn't run the message above: ${blocked}.`);
        schedulePublish(wsId);
        return { ok: false, error: blocked };
      }
      // The relay's message-queued event may have inserted a queued placeholder
      // row keyed by messageId; sendChat replaces it (id + origin) and starts the
      // turn with the desktop's normal system-prompt preamble (§12.6).
      const attachments = await downloadWebAttachments(wsId, job.payload?.attachments);
      const r = await sendChat({
        workspaceId: wsId,
        agentId,
        text: String(job.payload?.text ?? ''),
        attachments,
        id: job.payload?.messageId,
        turnId: job.payload?.turnId,
        origin: job.payload?.origin === 'agent' ? 'agent' : 'web',
      });
      schedulePublish(wsId);
      return { ok: r.ok, error: r.error };
    }
    case 'stop': {
      clearQueue(wsId, agentId);
      stopAgent(wsId, agentId);
      schedulePublish(wsId);
      return { ok: true };
    }
    case 'ask_answer': {
      submitAskAnswer(job.payload?.askId, job.payload?.answers ?? [], !!job.payload?.cancelled);
      return { ok: true };
    }
    case 'chat_set': {
      const patch: Record<string, unknown> = {};
      if ('model' in (job.payload ?? {})) patch.model = job.payload.model;
      if ('effort' in (job.payload ?? {})) patch.effort = job.payload.effort;
      if ('planMode' in (job.payload ?? {})) patch.planMode = job.payload.planMode;
      Workspaces.patchChat(wsId, agentId, patch);
      schedulePublish(wsId);
      return { ok: true };
    }
    case 'chat_rename': {
      Workspaces.patchChat(wsId, agentId, { title: String(job.payload?.title ?? ''), titleCustom: true });
      schedulePublish(wsId);
      return { ok: true };
    }
    case 'chat_close': {
      Workspaces.patchChat(wsId, agentId, { closed: true });
      schedulePublish(wsId);
      return { ok: true };
    }
    case 'chat_restore': {
      Workspaces.patchChat(wsId, agentId, { closed: false });
      schedulePublish(wsId);
      return { ok: true };
    }
    case 'chat_new': {
      const chats = Workspaces.getChats(wsId);
      const next = Math.max(1, ...Object.keys(chats).map(Number)) + 1;
      Workspaces.patchChat(wsId, next, job.payload?.title ? { title: String(job.payload.title), titleCustom: true } : {});
      schedulePublish(wsId);
      return { ok: true, result: { agentId: next } };
    }
    case 'queue_remove': {
      // The queued row now carries the web's messageId (enqueueLocal preserves it),
      // so remove the real row by that id — the local and relay queues stay in sync.
      const id = String(job.payload?.messageId ?? '');
      if (id) {
        removeQueued(wsId, agentId, id);
        if (Messages.exists(id)) Messages.remove(id);
      }
      schedulePublish(wsId);
      return { ok: true };
    }
    case 'queue_edit': {
      // Rewrite the real queued row by the web's messageId (empty text drops it).
      const id = String(job.payload?.messageId ?? '');
      if (id) editQueued(wsId, agentId, id, String(job.payload?.text ?? ''));
      schedulePublish(wsId);
      return { ok: true };
    }
    case 'queue_send_now': {
      // Steer: interrupt the running turn so this queued message runs next. No-op
      // if the turn already ended or the row is gone (a stale click racing a drain).
      const id = String(job.payload?.messageId ?? '');
      if (id) sendQueuedNow(wsId, agentId, id);
      schedulePublish(wsId);
      return { ok: true };
    }
    case 'pr_create':
      return execPrCreate(wsId);
    case 'pr_merge':
      return execPrMerge(wsId, job.payload?.method ?? 'squash');
    case 'continue_branch':
      return execContinueBranch(wsId);
    case 'resolve_conflicts':
      return execResolveConflicts(wsId);
    case 'workspace_archive':
      return execArchive(wsId);
    case 'workspace_restore':
      return execRestore(wsId);
    case 'workspace_delete':
      return execDelete(wsId);
    case 'git_refresh':
      return execGitRefresh(wsId, !!job.payload?.withPatch);
    case 'status_regenerate':
      return execStatusRegenerate(wsId, agentId, job.payload?.scope ?? 'session');
    case 'runscript_exec': {
      const r = await execRunScript(wsId, String(job.payload?.scriptId ?? ''));
      void publishRunScripts(wsId);
      return { ok: r.ok, error: r.error };
    }
    case 'runscript_stop': {
      stopRunScript(wsId, String(job.payload?.scriptId ?? ''));
      void publishRunScripts(wsId);
      return { ok: true };
    }
    case 'run_in_cloud': {
      const hostId = Settings.global().cloud?.hostId ?? null;
      if (!hostId) return { ok: false, error: 'No cloud host configured' };
      const r = await setWorkspaceCloud(wsId, hostId);
      schedulePublish(wsId);
      return { ok: r.ok, error: r.error };
    }
    case 'bring_local': {
      const r = await setWorkspaceCloud(wsId, null);
      schedulePublish(wsId);
      return { ok: r.ok, error: r.error };
    }
    case 'todo_add': {
      Todos.insert({ id: uid(), workspaceId: wsId, text: String(job.payload?.text ?? ''), done: false, createdAt: now() });
      await publishTodos(wsId);
      return { ok: true };
    }
    case 'todo_toggle': {
      Todos.setDone(String(job.payload?.todoId ?? ''), !!job.payload?.done);
      await publishTodos(wsId);
      return { ok: true };
    }
    case 'todo_delete': {
      Todos.remove(String(job.payload?.todoId ?? ''));
      await publishTodos(wsId);
      return { ok: true };
    }
    case 'comment_add': {
      Comments.insert({
        id: uid(),
        workspaceId: wsId,
        file: String(job.payload?.file ?? ''),
        line: Number(job.payload?.line ?? 0),
        side: job.payload?.side === 'old' ? 'old' : 'new',
        body: String(job.payload?.text ?? job.payload?.body ?? ''),
        resolved: false,
        createdAt: now(),
      });
      await publishComments(wsId);
      return { ok: true };
    }
    case 'comment_resolve': {
      Comments.setResolved(String(job.payload?.commentId ?? ''), !!job.payload?.resolved);
      await publishComments(wsId);
      return { ok: true };
    }
    case 'comment_delete': {
      Comments.remove(String(job.payload?.commentId ?? ''));
      await publishComments(wsId);
      return { ok: true };
    }
    case 'comments_send': {
      const open = Comments.list(wsId).filter((c) => !c.resolved);
      if (open.length === 0) return { ok: false, error: 'No open comments' };
      const text =
        'Please address these code review comments:\n\n' +
        open.map((c) => `- ${c.file}:${c.line} — ${c.body}`).join('\n');
      const r = await sendChat({ workspaceId: wsId, agentId, text, attachments: [], origin: 'web' });
      for (const c of open) Comments.setResolved(c.id, true);
      await publishComments(wsId);
      return { ok: r.ok, error: r.error };
    }
    case 'schedule_add': {
      const r = await scheduleChat({
        workspaceId: wsId,
        agentId,
        text: String(job.payload?.text ?? ''),
        attachments: [],
        deliverAt: Number(job.payload?.deliverAt ?? 0),
        kind: 'at',
      });
      schedulePublish(wsId);
      return { ok: r.ok, error: r.error };
    }
    case 'schedule_edit': {
      await editScheduledChat(wsId, agentId, String(job.payload?.itemId ?? ''), String(job.payload?.text ?? ''));
      schedulePublish(wsId);
      return { ok: true };
    }
    case 'schedule_remove': {
      await cancelScheduled(wsId, agentId, String(job.payload?.itemId ?? ''));
      schedulePublish(wsId);
      return { ok: true };
    }
    case 'resync': {
      // Account-global (no workspace): forget the publish fingerprints and re-push
      // every workspace. The web "Re-sync" button enqueues this when the relay is
      // missing workspaces this desktop has. Triggered per-device, so conversationId
      // is a sentinel and wsId/agentId above are ignored.
      return { ok: true, result: await resyncAll() };
    }
    case 'workspace_create': {
      const p = job.payload ?? {};
      const ws = await createWorkspace({
        id: p.id ?? job.workspaceId,
        projectId: p.projectId,
        harness: (p.harness ?? 'claude-code') as HarnessId,
        initialPrompt: p.task,
        hostId: p.host && p.host !== 'local' ? p.host : null,
        // From branch / PR / issue / linear (§10.6). Absent ⇒ base branch.
        from: p.from && p.from.type ? p.from : undefined,
      });
      if (p.model || p.effort || p.planMode)
        Workspaces.patchChat(ws.id, 1, { model: p.model, effort: p.effort, planMode: p.planMode });
      schedulePublish(ws.id);
      return { ok: true, result: { workspaceId: ws.id } };
    }
    default:
      // Older desktops (and Phase 3 kinds: runscript_*, comment_*, workspace_create)
      // stay compatible.
      return { ok: false, error: 'unsupported job kind' };
  }
}

async function poll(): Promise<void> {
  // Live: hold the connection open, as before. Idle: ask for an answer now and
  // sleep — the relay can answer a heartbeat without touching its database, and
  // a job still arrives within one `idleWait`.
  const wait = relayMode() === 'idle' ? 0 : 25;
  const res = await relayFetch(`/api/device/poll?wait=${wait}&cursor=${cursor()}`);
  if (!res.ok) throw new Error(`device poll ${res.status}`);
  const j = (await res.json()) as { jobs?: Job[]; events?: any[]; next?: number; watch?: boolean; idleWait?: number };
  if (typeof j.watch === 'boolean') {
    sawWatch = true;
    if (j.watch) watchingAt = Date.now();
    if (typeof j.idleWait === 'number' && j.idleWait > 0) idleWait = j.idleWait;
  }
  noteMode();
  applyEvents(j.events ?? []);
  if (typeof j.next === 'number') setCursor(j.next);
  const done = handled();
  for (const job of j.jobs ?? []) {
    if (done.has(job.id)) {
      // Duplicate delivery — ack without re-executing (at-least-once).
      await relayFetch(`/api/device/jobs/${encodeURIComponent(job.id)}/done`, { method: 'POST', body: JSON.stringify({ ok: true }) }).catch(() => {});
      continue;
    }
    let out: { ok: boolean; result?: unknown; error?: string };
    try {
      out = await runJob(job);
    } catch (e) {
      out = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    markHandled(job.id);
    await relayFetch(`/api/device/jobs/${encodeURIComponent(job.id)}/done`, {
      method: 'POST',
      body: JSON.stringify(out),
    }).catch(() => {});
  }
}

async function loop(): Promise<void> {
  while (running && isLinked()) {
    // Honour the shared relay breaker (web-relay-egress-quota §B2) so this loop
    // and the publish paths back off together instead of each hammering a dead
    // relay on its own schedule. This poll is also the PROBER that closes it:
    // relayFetch resets the breaker on the first 2xx. Sleep in ≤5s slices so a
    // stop / sign-out still takes effect promptly.
    const pause = relayRetryIn();
    if (pause > 0) {
      await nap(Math.min(pause, 5000));
      continue;
    }
    try {
      await poll();
      backoff = 2000; // healthy response → reset
      // Idle: the heartbeat answered at once, so we pace the next one ourselves.
      if (relayMode() === 'idle') await nap(idleWait * 1000);
    } catch {
      // Network error / relay down — back off 2s → 30s, then retry.
      await nap(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

/** Start the device long-poll loop (idempotent). */
export function startBridge(): void {
  if (running) return;
  running = true;
  backoff = 2000;
  // A fresh link may be a different (or older) relay: re-learn its protocol.
  sawWatch = false;
  watchingAt = 0;
  lastMode = null;
  void loop();
}

/** Stop the loop; the in-flight poll times out server-side and the device ages
 *  to offline after 60s. */
export function stopBridge(): void {
  running = false;
}
