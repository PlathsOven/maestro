import type { ChatMessage, SubagentRun, WorkspaceDiff } from '../../shared/types';
import type { LiveTurn } from '../store/app';

/**
 * Drops the per-workspace chat state of workspaces the user left long ago (perf
 * spec §4.9.5). The renderer accumulates a transcript (and a full diff) for every
 * workspace it has ever opened — on a fleet-sized install that is tens of MB of
 * strings the user can't see. Everything dropped here reloads lazily the moment
 * the workspace is selected again: `messages` via loadWorkspaceData's `chat:list`,
 * `diffs` via DiffViewer's refresh-on-activate, `subagentRuns` via AgentMessage's
 * lazy `loadSubagents`; a finished `liveTurn` is already carried by its persisted
 * message.
 *
 * Pure and store-free, like lib/editorEvictor: the store owns the 60 s timer and
 * hands the state in, so the whole policy reads in one place.
 */

/** A workspace must have been off screen this long before it can be dropped. */
const IDLE_MS = 10 * 60_000;
/** The N most recently seen workspaces are never dropped, however idle — moving
 *  between a handful of workspaces must never pay for a refetch. */
const KEEP_RECENT = 8;

/** The slices eviction reads and writes — a structural subset of the store. */
export interface EvictableState {
  activeWorkspaceId: string | null;
  lastSeenAt: Record<string, number>;
  runningAgents: Record<string, number[]>;
  messages: Record<string, ChatMessage[] | undefined>;
  diffs: Record<string, WorkspaceDiff | undefined>;
  subagentRuns: Record<string, SubagentRun[] | undefined>;
  liveTurns: Record<string, LiveTurn | undefined>;
}

/** The store patch for one eviction sweep; `{}` when there is nothing to drop. */
export function evictIdleWorkspaces(s: EvictableState): Partial<EvictableState> {
  const loaded = new Set<string>();
  for (const [id, list] of Object.entries(s.messages)) if (list) loaded.add(id);
  for (const [id, diff] of Object.entries(s.diffs)) if (diff) loaded.add(id);
  if (loaded.size <= KEEP_RECENT) return {};

  const now = Date.now();
  // Most recently seen first, so the protected head is the working set.
  const byRecency = [...loaded].sort((a, b) => (s.lastSeenAt[b] ?? 0) - (s.lastSeenAt[a] ?? 0));
  const victims = byRecency.slice(KEEP_RECENT).filter(
    (id) =>
      id !== s.activeWorkspaceId &&
      (s.runningAgents[id]?.length ?? 0) === 0 &&
      now - (s.lastSeenAt[id] ?? 0) > IDLE_MS
  );
  if (victims.length === 0) return {};

  const messages = { ...s.messages };
  const diffs = { ...s.diffs };
  const subagentRuns = { ...s.subagentRuns };
  const liveTurns = { ...s.liveTurns };
  for (const id of victims) {
    // Specialist runs are keyed by parent *message* id, so the transcript we're
    // about to drop is the only way to find them.
    for (const m of s.messages[id] ?? []) delete subagentRuns[m.id];
    delete messages[id];
    delete diffs[id];
    // Only settled turns: a running one belongs to a workspace we never evict,
    // but a turn left behind by a crashed run would otherwise pin blocks forever.
    for (const key of Object.keys(liveTurns)) {
      if (key.startsWith(`${id}:`) && !liveTurns[key]?.running) delete liveTurns[key];
    }
  }
  return { messages, diffs, subagentRuns, liveTurns };
}
