import { powerMonitor } from 'electron';
import { broadcast } from '../bus';
import { Scheduled, now, uid } from '../db';
import type { Attachment, ScheduledMessage } from '../../shared/types';

/**
 * Scheduled messages — "send this at 6 PM" / "send this when my usage window
 * resets".
 *
 * The whole feature is one persisted table plus the timer below. A scheduled
 * message is just a *deferred send*: when its instant arrives the row is
 * deleted and the payload is handed to the delivery hook, which routes it
 * through the ordinary `sendChat`. Auto-titling, preambles, attachments, and
 * the queue-behind-a-running-turn branch therefore all come for free, and
 * nothing here knows what a chat is.
 *
 * The hook (rather than importing `chat.ts` directly) keeps the import graph
 * acyclic and mirrors `setRunFinishedHook` in `harness/index.ts`.
 *
 * Remote (box-owned) rows (§4): a row with `remoteTurnId` is delivered by the
 * drain ON THE BOX, not by the timer. Its job file already sits in `scheduled/`
 * on the server. For such a row the timer only *wakes the follower* at deliverAt
 * (the box may need Maestro up to tail the journal), and the row is deleted when
 * the follower sees the turn start (`fireRemoteScheduled`) — never by the timer.
 */

type DeliveryHook = (m: ScheduledMessage) => Promise<{ ok: boolean; error?: string }>;

let deliveryHook: DeliveryHook | null = null;

/** Registered by `chat.ts` at module load, before `initScheduler()` runs. */
export function setScheduledDeliveryHook(fn: DeliveryHook) {
  deliveryHook = fn;
}

interface RemoteHooks {
  /** deliverAt reached for a box-owned row: make sure the drain + follower are up. */
  wake(m: ScheduledMessage): Promise<void>;
  /** Remove the job file on the box. `ok:false` = unreachable; the row must stay. */
  cancel(m: ScheduledMessage): Promise<{ ok: boolean; error?: string }>;
  /** The box started this row's turn at `atMs`: record the user message. */
  fired(m: ScheduledMessage, atMs: number): void;
}

let remoteHooks: RemoteHooks | null = null;

/** Registered by `chat.ts` at module load, alongside the delivery hook. */
export function setRemoteScheduleHooks(h: RemoteHooks) {
  remoteHooks = h;
}

// A single armed timer, always aimed at the earliest pending deliverAt. Every
// mutation re-aims it, so there is no polling loop and no per-item timer to
// leak.
let timer: NodeJS.Timeout | null = null;

// setTimeout drifts badly across sleep and overflows past ~24.8 days, so cap
// each hop. A long wait becomes a chain of short ones and the final hop — the
// only one whose precision matters — is always well under the cap.
const MAX_HOP_MS = 15 * 60_000;

function arm() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const next = Scheduled.nextAt(now());
  if (next === null) return;
  timer = setTimeout(() => void deliverDue(), Math.max(0, Math.min(next - now(), MAX_HOP_MS)));
}

function broadcastFor(workspaceId: string, agentId: number) {
  const items = Scheduled.forWorkspace(workspaceId).filter((m) => m.agentId === agentId);
  broadcast('chat:scheduled', { workspaceId, agentId, items });
}

/**
 * Fire everything that's due, oldest first, then re-arm.
 *
 * Each row is deleted *before* its send is attempted: a crash mid-delivery can
 * then at worst drop one message, never deliver it twice — the safe direction
 * for something the user will re-read as chat history.
 *
 * Several items due at once (three messages aimed at the same limit reset)
 * need no special handling: the first starts a turn, the rest hit `sendChat`'s
 * agent-is-busy branch and land in the existing follow-up queue, which drains
 * one per turn.
 */
async function deliverDue() {
  // Without a delivery hook we'd delete rows and drop the messages on the
  // floor. Leave them pending and try again on the next tick instead.
  if (!deliveryHook) return arm();
  const due = Scheduled.due(now());
  const touched = new Map<string, { workspaceId: string; agentId: number }>();
  for (const item of due) {
    if (item.remoteTurnId) {
      // Box-owned: the drain on the server delivers it. We only make sure the
      // drain + follower are up; the row is removed when the follower sees the
      // turn start (fireRemoteScheduled), never here. arm() excludes overdue
      // remote rows, so this doesn't spin.
      if (remoteHooks) await remoteHooks.wake(item);
      continue;
    }
    Scheduled.remove(item.id);
    touched.set(`${item.workspaceId}:${item.agentId}`, { workspaceId: item.workspaceId, agentId: item.agentId });
    await deliveryHook(item);
  }
  for (const { workspaceId, agentId } of touched.values()) broadcastFor(workspaceId, agentId);
  arm();
}

/** Re-run the due sweep now (reconnect catch-up, §4.3) — overdue remote rows get
 *  their drains/followers re-woken. */
export function pokeScheduler() {
  void deliverDue();
}

/** The box started a scheduled row's turn: record its user message and drop the
 *  row. No-op unless a row carries this remoteTurnId, so journal replays after
 *  rotation are idempotent (§4.5). Called by the follower on every turn-start. */
export function fireRemoteScheduled(turnId: string, atMs: number) {
  const item = Scheduled.byRemoteTurnId(turnId);
  if (!item) return;
  Scheduled.remove(item.id);
  if (remoteHooks) remoteHooks.fired(item, atMs);
  broadcastFor(item.workspaceId, item.agentId);
  arm();
}

/**
 * Boot catch-up + wake-up handling.
 *
 * Maestro's main process doesn't outlive its window (`window-all-closed →
 * app.quit()`), so a message scheduled for 6 PM cannot fire if the app was
 * closed at 6 PM. "Send at 6 PM" means "send as soon as possible once it's
 * 6 PM" — especially for the limit-reset case, where the whole point is to use
 * a window the user already paid for — so overdue items fire at next launch.
 * The composer states this plainly rather than implying background delivery.
 */
export function initScheduler() {
  void deliverDue();
  // Sleeping through the target time is the common desktop case: the timer
  // doesn't advance, so re-check on wake. (Same trigger the updater uses.)
  // Optional-chained because this module is also loaded by the headless
  // test/seed scripts, which run under ELECTRON_RUN_AS_NODE — no Electron
  // runtime, so no powerMonitor.
  powerMonitor?.on('resume', () => void deliverDue());
}

export function scheduleMessage(opts: {
  workspaceId: string;
  agentId: number;
  text: string;
  attachments: Attachment[];
  deliverAt: number;
  kind: 'at' | 'limit-reset';
  /** Set for a box-owned row: the turnId baked into the job file already written
   *  to the server's scheduled/ dir (§4.6). */
  remoteTurnId?: string;
}): { ok: boolean; error?: string } {
  const text = opts.text.trim();
  if (!text && opts.attachments.length === 0) return { ok: false, error: 'Nothing to schedule' };
  // A time in the past is what Send is for; accepting it silently would make
  // the item vanish into an instant delivery the user didn't ask for.
  if (!Number.isFinite(opts.deliverAt) || opts.deliverAt <= now()) {
    return { ok: false, error: 'Pick a time in the future' };
  }
  Scheduled.insert({
    id: uid(),
    workspaceId: opts.workspaceId,
    agentId: opts.agentId,
    text,
    attachments: opts.attachments,
    kind: opts.kind,
    deliverAt: opts.deliverAt,
    createdAt: now(),
    remoteTurnId: opts.remoteTurnId ?? null,
  });
  broadcastFor(opts.workspaceId, opts.agentId);
  arm();
  return { ok: true };
}

/** Reword a LOCAL pending item in place. Empty text drops it, matching the
 *  queued-message affordance (`editQueued` in chat.ts). Remote rows are re-rendered
 *  by chat.ts's `editScheduledChat` (cancel + reschedule with a new turnId), so
 *  this only handles local rows. Rescheduling isn't offered: the time never
 *  moves, so the armed timer stays valid and nothing re-arms here. */
export function editScheduled(workspaceId: string, agentId: number, itemId: string, text: string) {
  const cur = Scheduled.get(itemId);
  if (!cur) return;
  if (!text.trim() && cur.attachments.length === 0) return void cancelScheduled(workspaceId, agentId, itemId);
  Scheduled.setText(itemId, text.trim());
  broadcastFor(workspaceId, agentId);
}

/** Cancel a pending item. For a remote row the box job is removed first; if the
 *  host is unreachable the row stays and the error is returned (the caller
 *  toasts, §4.5). */
export async function cancelScheduled(
  workspaceId: string,
  agentId: number,
  itemId: string
): Promise<{ ok: boolean; error?: string }> {
  const item = Scheduled.get(itemId);
  if (!item) return { ok: true }; // already gone
  if (item.remoteTurnId && remoteHooks) {
    const r = await remoteHooks.cancel(item);
    if (!r.ok) return r; // unreachable — keep the row so the user can retry
  }
  Scheduled.remove(itemId);
  broadcastFor(workspaceId, agentId);
  arm();
  return { ok: true };
}

/** "Don't wait" — deliver now and drop the schedule. For a remote row the box
 *  job is removed first (must succeed, else we'd double-deliver), then the
 *  ordinary delivery path runs — which for a cloud workspace becomes a normal
 *  queue job. Exactly one way a scheduled message reaches the agent. */
export async function sendScheduledNow(workspaceId: string, agentId: number, itemId: string) {
  const item = Scheduled.get(itemId);
  if (!item || !deliveryHook) return;
  if (item.remoteTurnId && remoteHooks) {
    const r = await remoteHooks.cancel(item);
    if (!r.ok) return; // couldn't remove the box job — don't risk delivering twice
  }
  Scheduled.remove(itemId);
  broadcastFor(workspaceId, agentId);
  arm();
  await deliveryHook(item);
}

/** Called when a chat is deleted — its pending sends go with it. Remote rows'
 *  box job files are removed best-effort (the chat is going away regardless). */
export function dropScheduledForAgent(workspaceId: string, agentId: number) {
  if (remoteHooks) {
    for (const m of Scheduled.forWorkspace(workspaceId)) {
      if (m.agentId === agentId && m.remoteTurnId) void remoteHooks.cancel(m).catch(() => {});
    }
  }
  Scheduled.removeForAgent(workspaceId, agentId);
  broadcastFor(workspaceId, agentId);
  arm();
}

/** Stop semantics (§4.5): after chat:stop clears a cloud chat's queue (which
 *  includes any *due* remote row's promoted job), drop the now-orphaned remote
 *  rows whose time has already passed — they no longer exist on the box. */
export function dropDueRemoteForAgent(workspaceId: string, agentId: number) {
  let removed = false;
  for (const m of Scheduled.forWorkspace(workspaceId)) {
    if (m.agentId === agentId && m.remoteTurnId && m.deliverAt <= now()) {
      Scheduled.remove(m.id);
      removed = true;
    }
  }
  if (removed) {
    broadcastFor(workspaceId, agentId);
    arm();
  }
}
