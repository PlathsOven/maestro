// Derives the unified status indicators (the stacked colored circles) shown
// beside projects, branches, and sessions. One color per state:
//   asking (pink "?" bead — blocked on a maestro-ask Q&A) · running
//   (blue) · complete+unread (green) · waiting on workflow (yellow) ·
//   merged (purple). Idle contributes nothing.
import type { ChatMeta, Workspace } from '../types';

export type IndicatorStatus = 'asking' | 'running' | 'unread' | 'waiting' | 'merged';

/** Fixed display order of the stack. */
export const INDICATOR_ORDER: IndicatorStatus[] = ['asking', 'running', 'unread', 'waiting', 'merged'];

export const INDICATOR_LABEL: Record<IndicatorStatus, string> = {
  asking: 'Asking you a question',
  running: 'Running',
  unread: 'Complete · unread',
  waiting: 'Waiting on you',
  merged: 'Merged',
};

export type StatusCounts = Record<IndicatorStatus, number>;

export const zeroCounts = (): StatusCounts => ({ asking: 0, running: 0, unread: 0, waiting: 0, merged: 0 });

/** A chat is "unread" when the agent has produced output past the read marker. */
export function isUnread(meta: ChatMeta | undefined): boolean {
  return (meta?.lastAgentAt ?? 0) > (meta?.lastReadAt ?? 0);
}

/** A single chat session's indicator; null = idle (no indication). A session
 *  blocked on a question is technically still running, but that's the one state
 *  the user must act on — it outranks everything. */
export function sessionIndicator(
  meta: ChatMeta | undefined,
  isRunning: boolean,
  isAsking = false
): IndicatorStatus | null {
  if (isAsking) return 'asking';
  if (isRunning) return 'running';
  if (meta?.attention) return 'waiting';
  if (isUnread(meta)) return 'unread';
  return null;
}

/**
 * A branch's (workspace's) stack: how many of its sessions are in each state,
 * plus a merged circle when its PR has been merged. Closed (hidden) tabs are
 * the user's choice to dismiss — they don't count.
 */
export function workspaceStatusCounts(
  ws: Workspace,
  chats: Record<string, ChatMeta> | undefined,
  running: readonly number[],
  asking: readonly number[] = []
): StatusCounts {
  const c = zeroCounts();
  const ids = new Set<number>([...running, ...asking]);
  for (const k of Object.keys(chats ?? {})) ids.add(Number(k));
  for (const id of ids) {
    const meta = chats?.[String(id)];
    if (meta?.closed) continue;
    const st = sessionIndicator(meta, running.includes(id), asking.includes(id));
    if (st) c[st]++;
  }
  // Workspace-level states that have no per-session source of truth.
  if (ws.status === 'setting-up' && c.running === 0) c.running = 1;
  if (ws.status === 'needs-attention' && c.waiting === 0 && c.running === 0) c.waiting = 1; // e.g. setup failed
  if (ws.prState === 'MERGED') c.merged = 1;
  return c;
}

/**
 * A project's stack: for each state, the number of *branches* currently in it
 * (a branch is "in" a state when any of its sessions is).
 */
export function projectStatusCounts(
  workspaces: Workspace[],
  projectId: string,
  chatsMeta: Record<string, Record<string, ChatMeta>>,
  runningAgents: Record<string, number[]>,
  askingAgents: Record<string, number[]> = {}
): StatusCounts {
  const c = zeroCounts();
  for (const ws of workspaces) {
    if (ws.projectId !== projectId || ws.archived) continue;
    const wc = workspaceStatusCounts(ws, chatsMeta[ws.id], runningAgents[ws.id] ?? [], askingAgents[ws.id] ?? []);
    for (const k of INDICATOR_ORDER) if (wc[k] > 0) c[k]++;
  }
  return c;
}

export function hasAnyStatus(c: StatusCounts): boolean {
  return INDICATOR_ORDER.some((k) => c[k] > 0);
}
