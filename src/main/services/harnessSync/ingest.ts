import fs from 'fs';
import path from 'path';
import { broadcast } from '../../bus';
import { Messages, Workspaces, now } from '../../db';
import { isAgentRunning } from '../harness';
import { claudeDir } from '../harness/claude';
import { codexDir } from '../harness/codex';
import { findCodexRollout } from '../harnessFiles';
import { summarizeBlocks } from '../../../shared/harness/blocks';
import { foldClaudeLines, foldCodexLines, type ExternalTurn, type FoldCarry } from '../../../shared/harness/transcripts';
import { liveElsewhere } from './live';
import type { ChatMessage, HarnessSyncApp, Workspace } from '../../../shared/types';

// Cursor read → fold → persist / stream, for one mirrored chat
// (docs/specs/harness-chat-sync.md §6.3). Read-only toward the transcript; the
// deterministic message ids make every re-ingest idempotent, so a crash between
// "insert" and "advance cursor" is harmless.

const OPEN_TURN_TIMEOUT_MS = 60_000;

/** Per-chat streaming state for the in-progress (open) turn: how much of it has
 *  already been pushed to the renderer, so each ingest emits only the delta. */
interface LiveState {
  openId: string | null;
  userEmitted: boolean;
  emitted: number; // blocks already sent via message-final
  resolved: Set<string>; // tool ids whose result has been surfaced
}
const liveStates = new Map<string, LiveState>();
const chatKey = (wsId: string, agentId: number) => `${wsId}:${agentId}`;

/** Per-chat fold carry for the open turn (perf-cpu-ram §4.5.1): the fold state as
 *  of byte `foldedTo`, so a live re-ingest reads and parses only what the harness
 *  appended since instead of re-folding the turn from the cursor every ~400 ms.
 *  Valid only for the `(file, cursor)` it was built from and while the file only
 *  grows; the persisted cursor is untouched by it, so a restart still replays the
 *  open turn from its first line (harness-chat-sync §6.3). */
interface LiveFold {
  file: string;
  cursor: number;
  foldedTo: number;
  carry: FoldCarry;
}
const liveFolds = new Map<string, LiveFold>();

/** Drop the in-memory streaming state for a chat (turn boundary / cursor
 *  fast-forward). */
export function resetLiveState(wsId: string, agentId: number): void {
  const key = chatKey(wsId, agentId);
  liveStates.delete(key);
  liveFolds.delete(key);
}

function idFor(app: HarnessSyncApp, turnId: string, side: 'u' | 'a'): string {
  return `sync:${app === 'codex' ? 'cx' : 'cc'}:${turnId}:${side}`;
}

/** Re-locate a transcript by session id when its recorded path is gone (§6.3). */
function resolveFile(app: HarnessSyncApp, sessionId: string): string | null {
  if (app === 'codex') return findCodexRollout(path.join(codexDir(), 'sessions'), sessionId);
  const root = path.join(claudeDir(), 'projects');
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(root, d.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

let bytesRead = 0;

/** Test hook (perf-cpu-ram §6.4): total bytes `readWindow` has pulled off disk,
 *  so the e2e can assert that re-ingesting a growing turn costs only its delta. */
export function ingestBytesRead(): number {
  return bytesRead;
}

function readWindow(file: string, from: number, to: number): string {
  const len = to - from;
  const buf = Buffer.alloc(len);
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const n = fs.readSync(fd, buf, 0, len, from);
    bytesRead += n;
    return buf.slice(0, n).toString('utf8');
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/** Split a read window into complete lines, dropping the trailing partial. Returns
 *  the lines and their byte lengths (incl. the newline) so the caller can advance
 *  a byte cursor by an exact line count. */
function splitLines(chunk: string): { lines: string[]; bytes: number[] } {
  const parts = chunk.split('\n');
  parts.pop(); // trailing '' (window ended on \n) or an incomplete last line
  return { lines: parts, bytes: parts.map((l) => Buffer.byteLength(l, 'utf8') + 1) };
}

function fold(app: HarnessSyncApp, lines: string[], carry?: FoldCarry) {
  return app === 'codex' ? foldCodexLines(lines, carry) : foldClaudeLines(lines, carry);
}

/** Insert (idempotently) the turn's prompt row. */
function insertPrompt(ws: Workspace, agentId: number, app: HarnessSyncApp, turn: ExternalTurn): void {
  const userId = idFor(app, turn.id, 'u');
  if (Messages.exists(userId)) return;
  const userMsg: ChatMessage = {
    id: userId,
    workspaceId: ws.id,
    agentId,
    role: 'user',
    content: turn.prompt.text,
    attachments: [],
    ts: turn.prompt.ts || turn.ts || now(),
    meta: { origin: app },
  };
  Messages.insert(userMsg);
  broadcast('chat:message', userMsg);
}

/** Insert (idempotently) the rows for a finished turn and update chat/workspace
 *  bookkeeping. Mirrored turns never set attention and are marked read. */
function persistTurn(ws: Workspace, agentId: number, app: HarnessSyncApp, turn: ExternalTurn): void {
  const promptTs = turn.prompt.ts || turn.ts || now();
  insertPrompt(ws, agentId, app, turn);
  if (turn.blocks.length) {
    const agentMsgId = idFor(app, turn.id, 'a');
    if (!Messages.exists(agentMsgId)) {
      const agentMsg: ChatMessage = {
        id: agentMsgId,
        workspaceId: ws.id,
        agentId,
        role: 'agent',
        content: JSON.stringify(turn.blocks),
        attachments: [],
        ts: turn.ts || promptTs,
        meta: { origin: app, ...(turn.durationMs ? { durationMs: turn.durationMs } : {}) },
      };
      Messages.insert(agentMsg);
      broadcast('chat:message', agentMsg);
    }
  }
  const ts = turn.ts || promptTs;
  Workspaces.patchChat(ws.id, agentId, { lastAgentAt: ts, lastReadAt: ts });
  const subtitle = summarizeBlocks(turn.blocks);
  const fresh = Workspaces.get(ws.id);
  if (fresh && subtitle) {
    fresh.subtitle = subtitle;
    Workspaces.update(fresh);
    broadcast('ws:updated', fresh);
  }
}

/** Stream the delta of an in-progress turn to the renderer as chat:events — it
 *  renders exactly like a live Maestro turn. */
function streamOpen(ws: Workspace, agentId: number, app: HarnessSyncApp, turn: ExternalTurn, st: LiveState): void {
  if (turn.by !== 'external') return;
  if (!st.userEmitted) {
    insertPrompt(ws, agentId, app, turn);
    st.userEmitted = true;
  }
  const fresh = turn.blocks.slice(st.emitted);
  if (fresh.length) {
    broadcast('chat:event', { workspaceId: ws.id, agentId, event: { kind: 'message-final', blocks: fresh } });
    for (const b of fresh) if (b.type === 'tool' && b.result) st.resolved.add(b.id);
    st.emitted = turn.blocks.length;
  }
  for (const b of turn.blocks) {
    if (b.type === 'tool' && b.result && !st.resolved.has(b.id)) {
      broadcast('chat:event', {
        workspaceId: ws.id,
        agentId,
        event: { kind: 'tool-result', toolId: b.id, ok: b.result.ok, summary: b.result.summary },
      });
      st.resolved.add(b.id);
    }
  }
}

export async function ingest(ws: Workspace, agentId: number, opts?: { live?: boolean }): Promise<void> {
  // Fence 1: never fold while Maestro is running its own turn on this session —
  // its output lands in the transcript too (§6.5).
  if (isAgentRunning(ws.id, agentId)) return;

  const meta = Workspaces.getChats(ws.id)[String(agentId)];
  const m = meta?.mirror;
  if (!m) return;
  const sessionId = Workspaces.getSessions(ws.id)[String(agentId)];
  const app = m.app;

  let file = m.file;
  if (!fs.existsSync(file)) {
    const relocated = sessionId ? resolveFile(app, sessionId) : null;
    if (!relocated) return;
    file = relocated;
    Workspaces.patchChat(ws.id, agentId, { mirror: { ...m, file } });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  const size = stat.size;
  const key = chatKey(ws.id, agentId);
  let cursor = m.cursor;
  if (size < cursor) cursor = 0; // truncated / rewritten — replay (idempotent ids)

  // Resume the open turn from the carry when it still describes this transcript
  // and cursor and the file only grew — then the window is just the new bytes.
  // Taken out of the map up front: it is re-armed below only after a clean fold,
  // so a throw mid-fold can never leave a half-applied accumulator behind.
  const prior = liveFolds.get(key);
  liveFolds.delete(key);
  const resume = opts?.live && prior && prior.file === file && prior.cursor === cursor && size >= prior.foldedTo ? prior : null;
  const from = resume ? resume.foldedTo : cursor;
  if (size <= from) return;

  const chunk = readWindow(file, from, size);
  const { lines, bytes } = splitLines(chunk);
  if (!lines.length) return;
  const result = fold(app, lines, resume?.carry);

  // Closed turns are settled: persist the external ones (Maestro's own are
  // by:'maestro' and skipped), and reset streaming state since a new turn began.
  for (const turn of result.closed) {
    if (turn.by === 'external') persistTurn(ws, agentId, app, turn);
    if (liveStates.get(key)?.openId === turn.id) resetLiveState(ws.id, agentId);
  }

  if (!opts?.live) {
    // Import / at-rest: the trailing open turn is treated as finished too.
    if (result.open && result.open.by === 'external') persistTurn(ws, agentId, app, result.open);
    Workspaces.patchChat(ws.id, agentId, { mirror: { ...m, file, cursor: size } });
    resetLiveState(ws.id, agentId);
    return;
  }

  // Advance the cursor past every settled (closed) line; the open turn stays so a
  // restart replays it from its start. A resumed fold whose carried turn is still
  // open settled nothing, so the cursor doesn't move at all (its window began
  // mid-turn, past the line the cursor points at).
  let advance = 0;
  for (let i = 0; i < result.consumed && i < bytes.length; i++) advance += bytes[i];
  const carried = !!resume && result.open?.id === resume.carry.turn.id;
  const newCursor = carried ? cursor : from + advance;
  // End of the last COMPLETE line read: where a resumed read starts next time (a
  // trailing partial line is deliberately re-read).
  const foldedTo = from + bytes.reduce((n, b) => n + b, 0);

  if (result.open) {
    // Open-turn timeout: a process killed mid-turn leaves an unclosed tail. If the
    // file is stale and nobody holds the session, fold it up as-is (§6.3 step 6).
    const stale = Date.now() - stat.mtimeMs > OPEN_TURN_TIMEOUT_MS;
    const held = liveElsewhere(app, sessionId ?? '', file, { openTurn: true });
    if (stale && !held) {
      if (result.open.by === 'external') persistTurn(ws, agentId, app, result.open);
      Workspaces.patchChat(ws.id, agentId, { mirror: { ...m, file, cursor: size }, externalLive: null });
      resetLiveState(ws.id, agentId);
      return;
    }
    let st = liveStates.get(key);
    if (!st || st.openId !== result.open.id) {
      st = { openId: result.open.id, userEmitted: false, emitted: 0, resolved: new Set() };
      liveStates.set(key, st);
    }
    streamOpen(ws, agentId, app, result.open, st);
    // Re-arm the carry so the next tick folds only what lands after this window.
    if (result.carry) liveFolds.set(key, { file, cursor: newCursor, foldedTo, carry: result.carry });
  }

  // Codex has no live registry: an open turn on a rollout touched in the last 5
  // minutes means it's being typed in the TUI right now (§6.6). (Claude liveness
  // is registry-driven and maintained by the watcher.)
  if (app === 'codex') {
    const nextEl =
      result.open && Date.now() - stat.mtimeMs < 5 * 60_000 ? ({ app: 'codex' } as const) : null;
    const curEl = Workspaces.getChats(ws.id)[String(agentId)]?.externalLive ?? null;
    if (!!nextEl !== !!curEl) Workspaces.patchChat(ws.id, agentId, { externalLive: nextEl });
  }

  // Only write when the mirror actually moved: an open turn parks the cursor for
  // its whole life, and patchChat is a DB write plus a broadcast every tick.
  if (newCursor !== m.cursor || file !== m.file) {
    Workspaces.patchChat(ws.id, agentId, { mirror: { ...m, file, cursor: newCursor } });
  }
}
