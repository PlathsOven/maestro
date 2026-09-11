import fs from 'fs';
import path from 'path';
import { broadcast } from '../../bus';
import { Messages, Workspaces, now, uid } from '../../db';
import { isAgentRunning } from '../harness';
import { claudeDir } from '../harness/claude';
import { codexDir } from '../harness/codex';
import { findCodexRollout } from '../harnessFiles';
import { summarizeBlocks } from '../../../shared/harness/blocks';
import { foldClaudeLines, foldCodexLines, type ExternalTurn } from '../../../shared/harness/transcripts';
import { liveElsewhere } from './live';
import type { AgentBlock, ChatMessage, HarnessSyncApp, Workspace } from '../../../shared/types';

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

/** Drop the in-memory streaming state for a chat (turn boundary / cursor
 *  fast-forward). */
export function resetLiveState(wsId: string, agentId: number): void {
  liveStates.delete(chatKey(wsId, agentId));
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

function readWindow(file: string, from: number, to: number): string {
  const len = to - from;
  const buf = Buffer.alloc(len);
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const n = fs.readSync(fd, buf, 0, len, from);
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

function fold(app: HarnessSyncApp, lines: string[]) {
  return app === 'codex' ? foldCodexLines(lines) : foldClaudeLines(lines);
}

/** Insert (idempotently) the rows for a finished turn and update chat/workspace
 *  bookkeeping. Mirrored turns never set attention and are marked read. */
function persistTurn(ws: Workspace, agentId: number, app: HarnessSyncApp, turn: ExternalTurn): boolean {
  let inserted = false;
  const userId = idFor(app, turn.id, 'u');
  const promptTs = turn.prompt.ts || turn.ts || now();
  if (!Messages.exists(userId)) {
    const userMsg: ChatMessage = {
      id: userId,
      workspaceId: ws.id,
      agentId,
      role: 'user',
      content: turn.prompt.text,
      attachments: [],
      ts: promptTs,
      meta: { origin: app },
    };
    Messages.insert(userMsg);
    broadcast('chat:message', userMsg);
    inserted = true;
  }
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
      inserted = true;
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
  return inserted;
}

/** Stream the delta of an in-progress turn to the renderer as chat:events — it
 *  renders exactly like a live Maestro turn. */
function streamOpen(ws: Workspace, agentId: number, app: HarnessSyncApp, turn: ExternalTurn, st: LiveState): void {
  if (turn.by !== 'external') return;
  if (!st.userEmitted) {
    const userId = idFor(app, turn.id, 'u');
    if (!Messages.exists(userId)) {
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
  let cursor = m.cursor;
  if (size < cursor) cursor = 0; // truncated / rewritten — replay (idempotent ids)
  if (size <= cursor) return;

  const chunk = readWindow(file, cursor, size);
  const { lines, bytes } = splitLines(chunk);
  if (!lines.length) return;
  const result = fold(app, lines);

  const key = chatKey(ws.id, agentId);

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
  // restart replays it from its start.
  let advance = 0;
  for (let i = 0; i < result.consumed && i < bytes.length; i++) advance += bytes[i];
  const newCursor = cursor + advance;

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

  Workspaces.patchChat(ws.id, agentId, { mirror: { ...m, file, cursor: newCursor } });
}
