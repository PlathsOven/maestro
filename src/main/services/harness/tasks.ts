import { broadcast } from '../../bus';
import { now } from '../../db';
import type { BackgroundTask, BackgroundTaskEvent } from '../../../shared/types';

/**
 * Per-chat ledger of harness background tasks (Claude Code's `run_in_background`
 * Bash), and the note that hands their real fate to the next turn.
 *
 * Why a ledger at all: a background task is the one thing an agent starts
 * expecting to outlive the moment — "kick this off, come back to it later". But
 * Maestro runs each turn as its own CLI process, and the CLI kills its background
 * tasks when that process exits. The tool result already told the agent "you will
 * be notified when it completes", so without this the agent waits on a
 * notification that can never arrive, then reasons from a task id that no longer
 * exists. The ledger is keyed by chat (not by run) so it survives the turn that
 * created it, records that the task was reaped, and feeds that fact — plus the
 * partial output file, which does survive — into the next prompt.
 *
 * In-memory by design: a task can't outlive the app that spawned it, so a restart
 * legitimately starts from an empty ledger.
 */

const tasks = new Map<string, BackgroundTask[]>(); // key `${wsId}:${agentId}`
const key = (wsId: string, agentId: number) => `${wsId}:${agentId}`;

const isLive = (t: BackgroundTask) => t.status === 'running';

function publish(wsId: string, agentId: number) {
  broadcast('chat:tasks', { workspaceId: wsId, agentId, tasks: backgroundTasks(wsId, agentId) });
}

function backgroundTasks(wsId: string, agentId: number): BackgroundTask[] {
  return tasks.get(key(wsId, agentId)) ?? [];
}

/** Every chat's tasks in one workspace, keyed by agentId (renderer hydration). */
export function workspaceBackgroundTasks(wsId: string): Record<string, BackgroundTask[]> {
  const out: Record<string, BackgroundTask[]> = {};
  for (const [k, list] of tasks) {
    if (!list.length) continue;
    const [id, agentId] = [k.slice(0, k.lastIndexOf(':')), k.slice(k.lastIndexOf(':') + 1)];
    if (id === wsId) out[agentId] = list;
  }
  return out;
}

/**
 * Merge one adapter patch into the ledger; broadcasts when anything changed.
 * `afterTurnEnd` marks patches that arrive once the turn's result is in — the CLI
 * reaps its background tasks during shutdown, so a kill landing then means the
 * task was still running when the turn ended (orphaned), as opposed to one the
 * agent deliberately killed mid-turn.
 */
export function applyTaskEvent(wsId: string, agentId: number, ev: BackgroundTaskEvent, afterTurnEnd = false) {
  const k = key(wsId, agentId);
  const list = tasks.get(k) ?? [];
  const existing = list.find((t) => t.id === ev.taskId);
  if (!existing) {
    // Only a task we watched start belongs to this chat's ledger. One that shows
    // up already dead is the CLI replaying a notification for a task from an
    // earlier process — which we've already reaped and reported.
    if (ev.status && ev.status !== 'running') return;
    tasks.set(k, [
      ...list,
      {
        id: ev.taskId,
        description: ev.description || 'Background task',
        taskType: ev.taskType,
        status: 'running',
        startedAt: now(),
        outputFile: ev.outputFile,
      },
    ]);
    publish(wsId, agentId);
    return;
  }
  // A terminal status is final: a late "changed" patch can't revive the task.
  const status = ev.status && (isLive(existing) || ev.status !== 'running') ? ev.status : existing.status;
  const next: BackgroundTask = {
    ...existing,
    // The description a task starts with is the useful one — a terminal
    // notification's summary can be a paragraph of explanation.
    description: existing.description === 'Background task' ? ev.description || existing.description : existing.description,
    taskType: ev.taskType ?? existing.taskType,
    outputFile: ev.outputFile ?? existing.outputFile,
    status,
    endedAt: status === 'running' ? undefined : (existing.endedAt ?? now()),
    orphaned: existing.orphaned || (afterTurnEnd && isLive(existing) && status === 'killed') || undefined,
  };
  if (JSON.stringify(next) === JSON.stringify(existing)) return;
  tasks.set(
    k,
    list.map((t) => (t.id === ev.taskId ? next : t))
  );
  publish(wsId, agentId);
}

/**
 * The turn's process is gone, so anything still marked running died with it.
 * Called when the child closes and again before the next run starts (a child that
 * never closes cleanly would otherwise leave a task "running" forever).
 */
export function reapBackgroundTasks(wsId: string, agentId: number) {
  const k = key(wsId, agentId);
  const list = tasks.get(k);
  if (!list?.some(isLive)) return;
  tasks.set(
    k,
    list.map((t) => (isLive(t) ? { ...t, status: 'killed' as const, endedAt: now(), orphaned: true } : t))
  );
  publish(wsId, agentId);
}

/** Dismiss finished tasks (the user's ✕, or a turn that consumed the note). */
export function clearFinishedTasks(wsId: string, agentId: number) {
  const k = key(wsId, agentId);
  const list = tasks.get(k);
  if (!list?.some((t) => !isLive(t))) return;
  const live = list.filter(isLive);
  if (live.length) tasks.set(k, live);
  else tasks.delete(k);
  publish(wsId, agentId);
}

export function dropBackgroundTasks(wsId: string, agentId: number) {
  if (!tasks.delete(key(wsId, agentId))) return;
  publish(wsId, agentId);
}

/**
 * Prompt block telling the agent what really happened to the background tasks it
 * left behind, then clears them (they're reported once). Returns '' when there's
 * nothing to report. Without this the agent either blocks waiting for a
 * notification the dead process will never send, or calls BashOutput on an id the
 * fresh process has never heard of.
 */
export function consumeBackgroundTaskNote(wsId: string, agentId: number): string {
  const finished = backgroundTasks(wsId, agentId).filter((t) => !isLive(t));
  if (!finished.length) return '';
  clearFinishedTasks(wsId, agentId);
  const lines = finished.map((t) => {
    const secs = t.endedAt ? Math.max(1, Math.round((t.endedAt - t.startedAt) / 1000)) : null;
    const fate =
      t.status === 'completed'
        ? 'finished'
        : t.status === 'failed'
          ? 'failed'
          : t.orphaned || t.status === 'killed'
            ? 'was terminated before it finished'
            : t.status;
    return (
      `- \`${t.id}\` — ${t.description}: ${fate}${secs ? ` after ${secs}s` : ''}.` +
      (t.outputFile ? ` Output so far: ${t.outputFile}` : '')
    );
  });
  const orphaned = finished.some((t) => t.orphaned);
  return [
    '<maestro-background-tasks>',
    'Background tasks from an earlier turn of this chat:',
    ...lines,
    '',
    orphaned
      ? 'Maestro runs every turn as a separate CLI process, and the CLI terminates its ' +
        'background tasks when the turn ends — so the completion notification you were told ' +
        'to expect never arrives, and BashOutput can no longer reach those task ids. Read the ' +
        'output file if the partial output helps; otherwise re-run the work in the foreground ' +
        '(with a bounded timeout) within a single turn.'
      : 'Those task ids belong to a CLI process that has exited, so BashOutput can no longer ' +
        'reach them — read the output file instead.',
    '</maestro-background-tasks>',
  ].join('\n');
}

/**
 * First-turn guidance, so the agent doesn't design around a notification that
 * can't be delivered. Claude Code only — other harnesses don't expose the
 * background-task tools this describes.
 */
export function backgroundTaskPreamble(): string {
  return (
    '<maestro-background-tasks>' +
    'Each turn here runs as its own `claude -p` process, and background tasks ' +
    '(`run_in_background`) are terminated when the turn ends — a task cannot be handed to a ' +
    'later turn, and no completion notification survives the turn. Use one only for work you ' +
    'will poll with BashOutput and finish inside this same turn; for anything longer, run it in ' +
    'the foreground with a bounded timeout, or have it write to a file you can read next turn.' +
    '</maestro-background-tasks>'
  );
}
