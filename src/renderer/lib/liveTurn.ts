import type { AgentBlock, AgentEvent } from '../../shared/types';
import type { AppState, LiveTurn } from '../store/app';

/**
 * The live-turn reducer: folds one streamed `chat:event` into the store's
 * per-turn state (liveTurns / runningAgents / pendingAsks).
 *
 * Pure and store-free, like lib/transcriptEvictor: the store's `chat:event`
 * subscription (store/events.ts) hands the state in and keeps the side effects
 * — the completion chime, the per-call context ring and the `done` context merge.
 */

export const turnKey = (wsId: string, agentId: number) => `${wsId}:${agentId}`;

/** The slices a streamed event reads and writes — a structural subset of the store. */
export type LiveTurnSlices = Pick<AppState, 'liveTurns' | 'runningAgents' | 'pendingAsks'>;

/** The live-turn slices after `event`; `now` stamps a turn this event starts.
 *  Bookkeeping-only kinds (session/status/task/limit/context) are filtered out
 *  by the caller before this runs. */
export function reduceLiveTurnEvent(
  s: LiveTurnSlices,
  workspaceId: string,
  agentId: number,
  event: AgentEvent,
  now: number
): LiveTurnSlices {
  const key = turnKey(workspaceId, agentId);
  const cur: LiveTurn = s.liveTurns[key] ?? {
    agentId,
    finalBlocks: [],
    deltaBlocks: [],
    accumType: null,
    accumText: '',
    running: true,
    startedAt: now,
  };
  // Structural sharing (§4.9.4): a streaming turn re-enters this handler
  // once per token, so copying both block arrays every time is O(turn)
  // per token. Each case below copies only the array it actually changes
  // — `seg-delta`, the per-token event, copies neither — which also keeps
  // the finished blocks' identities stable for the memoised views.
  const t: LiveTurn = { ...cur };
  const flush = () => {
    if (t.accumType && t.accumText) {
      t.deltaBlocks = [...t.deltaBlocks, { type: t.accumType, text: t.accumText } as AgentBlock];
    }
    t.accumType = null;
    t.accumText = '';
  };
  let running = s.runningAgents[workspaceId] ?? [];
  switch (event.kind) {
    case 'seg-start':
      flush();
      t.accumType = event.segType;
      break;
    case 'seg-delta':
      if (!t.accumType) t.accumType = 'text';
      t.accumText = t.accumText + event.text;
      break;
    case 'tool-start':
      flush();
      t.deltaBlocks = [...t.deltaBlocks, { type: 'tool', id: event.toolId, name: event.name, input: event.input }];
      break;
    case 'message-final':
      t.finalBlocks = [...t.finalBlocks, ...event.blocks];
      t.deltaBlocks = [];
      t.accumType = null;
      t.accumText = '';
      break;
    case 'tool-result': {
      // Copy-on-write: only the array that actually holds the newest
      // block with this tool id is replaced. A result usually lands in a
      // block the previous `message-final` already moved to finalBlocks.
      const patched = (arr: AgentBlock[]): AgentBlock[] | null => {
        for (let i = arr.length - 1; i >= 0; i--) {
          const b = arr[i];
          if (b.type === 'tool' && b.id === event.toolId) {
            const next = [...arr];
            next[i] = { ...b, result: { ok: event.ok, summary: event.summary } };
            return next;
          }
        }
        return null;
      };
      const finals = patched(t.finalBlocks);
      if (finals) t.finalBlocks = finals;
      else {
        const deltas = patched(t.deltaBlocks);
        if (deltas) t.deltaBlocks = deltas;
      }
      break;
    }
    case 'done': {
      t.running = false;
      running = running.filter((a) => a !== agentId);
      // (The store merges `event.contextTokens` into chatsMeta, on a timer.)
      break;
    }
    default:
      break;
  }
  if (event.kind !== 'done' && !running.includes(agentId)) {
    running = [...running, agentId];
  }
  const liveTurns = { ...s.liveTurns, [key]: t };
  if (
    event.kind === 'done' &&
    t.finalBlocks.length === 0 &&
    t.deltaBlocks.length === 0 &&
    !t.accumText
  ) {
    // Nothing was produced (e.g. stopped immediately) — drop the stub;
    // otherwise the persisted chat:message replaces it.
    delete liveTurns[key];
  }
  // Turn ended — no question can still be waiting on it (main also cancels
  // + broadcasts ask:resolved; this just guarantees an instant clear).
  let pendingAsks = s.pendingAsks;
  if (event.kind === 'done' && pendingAsks[key]) {
    pendingAsks = { ...pendingAsks };
    delete pendingAsks[key];
  }
  return {
    liveTurns,
    pendingAsks,
    // Same structural sharing as the blocks above: mid-turn the running
    // list never changes, and a fresh map identity here would re-render
    // every sidebar status stack on every token.
    runningAgents:
      running === s.runningAgents[workspaceId] ? s.runningAgents : { ...s.runningAgents, [workspaceId]: running },
  };
}

const askingCache = new WeakMap<LiveTurnSlices['pendingAsks'], Record<string, number[]>>();

/** `pendingAsks` regrouped as workspaceId → agent ids blocked on a question —
 *  the shape the shared status derivations take. Memoised on the (immutable)
 *  pendingAsks object so selectors and memo deps see a stable reference. */
export function askingAgents(pendingAsks: LiveTurnSlices['pendingAsks']): Record<string, number[]> {
  let out = askingCache.get(pendingAsks);
  if (!out) {
    out = {};
    for (const ask of Object.values(pendingAsks)) if (ask) (out[ask.workspaceId] ??= []).push(ask.agentId);
    askingCache.set(pendingAsks, out);
  }
  return out;
}
