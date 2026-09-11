/**
 * Incremental accumulator that turns a harness adapter's normalized event stream
 * into the `AgentBlock[]` a turn persists — plus the turn's session/context/done
 * bookkeeping and the finalized meta. Pure (no node builtins, no main-process
 * imports): the desktop runner (`harness/index`, `services/roles`) and the relay
 * ingest (`web/lib/ingest`) build blocks and meta identically (G7).
 *
 * Two entry points over one representation:
 *   - `BlockStream` + `applyBlockEvent` — the incremental, block-only API the
 *     desktop already used (session/context/done handled by the caller).
 *   - `TurnState` + `accumulate` + `finalizeMeta` — a superset that also captures
 *     session/context/done, is JSON-serializable, and is **resumable**: the relay
 *     persists it between HTTP requests and resumes mid-turn (spec §6.4). A
 *     golden-fixture parity test (`scripts/parity-e2e.ts`) keeps the two provably
 *     identical.
 */
import type { AgentBlock, AgentEvent, ContextUsage } from '../types';

export interface BlockStream {
  finalBlocks: AgentBlock[];
  deltaBlocks: AgentBlock[];
  accumType: 'text' | 'thinking' | null;
  accumText: string;
}

export function newBlockStream(): BlockStream {
  return { finalBlocks: [], deltaBlocks: [], accumType: null, accumText: '' };
}

/** Commit the in-progress text/thinking run into a block. */
function flushBlockStream(s: BlockStream): void {
  if (s.accumType && s.accumText) s.deltaBlocks.push({ type: s.accumType, text: s.accumText } as AgentBlock);
  s.accumType = null;
  s.accumText = '';
}

/**
 * Apply one content-bearing event. Returns true when the visible blocks changed
 * (so a live renderer can re-broadcast); text deltas also return true.
 */
export function applyBlockEvent(s: BlockStream, ev: AgentEvent): boolean {
  switch (ev.kind) {
    case 'seg-start':
      flushBlockStream(s);
      s.accumType = ev.segType;
      return false;
    case 'seg-delta':
      if (!s.accumType) s.accumType = 'text';
      s.accumText += ev.text;
      return true;
    case 'tool-start':
      flushBlockStream(s);
      s.deltaBlocks.push({ type: 'tool', id: ev.toolId, name: ev.name, input: ev.input });
      return true;
    case 'message-final':
      // Authoritative message content supersedes streamed deltas.
      s.finalBlocks.push(...ev.blocks);
      s.deltaBlocks = [];
      s.accumType = null;
      s.accumText = '';
      return true;
    case 'tool-result': {
      const all = [...s.finalBlocks, ...s.deltaBlocks];
      for (let i = all.length - 1; i >= 0; i--) {
        const b = all[i];
        if (b.type === 'tool' && b.id === ev.toolId) {
          b.result = { ok: ev.ok, summary: ev.summary };
          break;
        }
      }
      return true;
    }
    default:
      return false;
  }
}

/** Non-destructive view of the blocks so far (incl. the pending run). */
export function snapshotBlocks(s: BlockStream): AgentBlock[] {
  const blocks = [...s.finalBlocks, ...s.deltaBlocks];
  if (s.accumType && s.accumText) blocks.push({ type: s.accumType, text: s.accumText } as AgentBlock);
  return blocks;
}

/** Flush and fold every delta into finalBlocks; returns the final list. */
export function finalizeBlocks(s: BlockStream): AgentBlock[] {
  flushBlockStream(s);
  s.finalBlocks.push(...s.deltaBlocks);
  s.deltaBlocks = [];
  return s.finalBlocks;
}

// ---------- resumable turn state (relay ingest) ----------

/** The `done` event's fields captured verbatim as the turn ends. */
export interface DoneInfo {
  ok: boolean;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  needsAttention?: boolean;
}

/**
 * A whole turn's parse state — the block accumulator plus the session id, the
 * latest per-call context, and the terminal done event. JSON round-trips
 * losslessly (only plain data), which is what lets the relay persist it in
 * `journal_cursors.parse_state` and resume across chunks.
 */
export interface TurnState extends BlockStream {
  sessionId?: string;
  contextTokens?: number;
  usage?: ContextUsage;
  done?: DoneInfo;
}

export function newTurnState(): TurnState {
  return { ...newBlockStream() };
}

/**
 * Fold a batch of events into the turn state. Block events build blocks (via the
 * exact same `applyBlockEvent` the desktop uses); session/context/done are
 * captured into their fields; `task` is bookkeeping and ignored (it belongs to
 * the chat ledger, not the turn — see harness/index). Returns the same object.
 */
export function accumulate(s: TurnState, events: AgentEvent[]): TurnState {
  for (const ev of events) {
    switch (ev.kind) {
      case 'session':
        s.sessionId = ev.sessionId;
        break;
      case 'context':
        s.contextTokens = ev.contextTokens;
        s.usage = ev.usage;
        break;
      case 'done':
        s.done = {
          ok: ev.ok,
          error: ev.error,
          costUsd: ev.costUsd,
          durationMs: ev.durationMs,
          needsAttention: ev.needsAttention,
        };
        // A done event may also carry usage (grok reports context at turn end).
        if (ev.contextTokens != null) {
          s.contextTokens = ev.contextTokens;
          s.usage = ev.usage;
        }
        break;
      case 'task':
      case 'status':
      case 'limit':
        break;
      default:
        applyBlockEvent(s, ev);
    }
  }
  return s;
}

/** Finalized turn meta as stored on `turns` (relay). Mirrors the desktop
 *  `finalize()` rules: status from the done event + the journal's exit code,
 *  attention when the turn ended badly or flagged it, cost/duration passed
 *  through. `exit` is the `turn-end` frame's exit code (non-zero ⇒ the box saw
 *  the CLI die even if no done event was parsed — interrupted turn). */
export interface TurnMeta {
  status: 'done' | 'error' | 'aborted';
  error?: string;
  needsAttention: boolean;
  costUsd?: number;
  durationMs?: number;
}

export function finalizeMeta(s: TurnState, exit: number): TurnMeta {
  const done = s.done;
  // An interrupted turn (exit ≠ 0, no parsed done) is an error, not a clean end.
  const ok = done ? done.ok && exit === 0 : exit === 0;
  const error = done?.error ?? (exit !== 0 ? `exit code ${exit}` : undefined);
  const status: TurnMeta['status'] = ok ? 'done' : 'error';
  return {
    status,
    error,
    needsAttention: !ok || !!done?.needsAttention,
    costUsd: done?.costUsd,
    durationMs: done?.durationMs,
  };
}

/** First meaningful line of the turn's final text, markdown-stripped — the
 *  sidebar/notification subtitle. Shared so desktop and relay summarize alike. */
export function summarizeBlocks(blocks: AgentBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'text' && b.text.trim()) {
      const line = b.text
        .split('\n')
        .map((l) => l.replace(/^[#>*\-\s`]+/, '').replace(/[*`_]/g, '').trim())
        .find((l) => l.length > 0);
      if (line) return line.slice(0, 100);
    }
  }
  return null;
}
