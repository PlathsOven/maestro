/**
 * Pure folds that turn a Claude Code / Codex transcript (the JSONL the CLIs keep
 * on disk) into Maestro turns — the heart of harness chat sync
 * (docs/specs/harness-chat-sync.md §6.2). No node imports, so this runs under the
 * parity/fold fixture tests and can serve the web relay later. It reuses the same
 * `parseClaudeLine` + `applyBlockEvent` pipeline the live harness runner uses, so
 * a mirrored turn renders byte-identically to a Maestro-born one (G7).
 *
 * Both folds are line-oriented and idempotent: given the full set of lines from a
 * cursor, they group them into turns. The ingest layer advances a byte cursor by
 * the `consumed` count so settled turns are never re-read.
 */
import type { AgentBlock } from '../types';
import { parseClaudeLine, parseJsonLine, truncate } from './parse';
import { applyBlockEvent, finalizeBlocks, newBlockStream, snapshotBlocks, type BlockStream } from './blocks';

export interface ExternalTurn {
  /** promptUuid (Claude) | turn_id (Codex) — deterministic message-id seed. */
  id: string;
  prompt: { text: string; ts: number };
  /** model output so far (may be empty for a Ctrl-C'd prompt). */
  blocks: AgentBlock[];
  /** the harness marked the turn ended (Claude `end_turn` / Codex `task_complete`). */
  closed: boolean;
  /** last content line ts. */
  ts: number;
  model?: string;
  durationMs?: number;
  /** 'maestro' when the prompt line was written by Maestro's own CLI run (Claude:
   *  entrypoint 'sdk-cli'); such turns are never persisted by sync (§6.5). */
  by: 'external' | 'maestro';
}

export interface FoldResult {
  /** turns the harness has finished (a later prompt followed them, or they carry
   *  the end-of-turn marker). Persisted by ingest. */
  closed: ExternalTurn[];
  /** the still-in-progress final turn, if any. Streamed live / persisted at rest. */
  open?: ExternalTurn;
  /** number of leading input lines that belong entirely to closed turns — the
   *  count ingest advances its byte cursor past. `lines.length` when nothing is
   *  still open. */
  consumed: number;
}

/** A turn under construction: the public shape plus the block accumulator and the
 *  index of its first line in the current fold call (for `consumed`). */
interface WorkTurn extends ExternalTurn {
  stream: BlockStream;
  startIndex: number;
}

function tsOf(j: any): number {
  const t = typeof j?.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Reconstruct a work turn from a carry (a previous call's open turn), seeding the
 *  block accumulator with its blocks so later tool-results still attach by id. */
function revive(carry: ExternalTurn): WorkTurn {
  const stream = newBlockStream();
  stream.finalBlocks = carry.blocks.map((b) => ({ ...b }) as AgentBlock);
  return { ...carry, blocks: [...carry.blocks], stream, startIndex: -1 };
}

function toExternal(t: WorkTurn, final: boolean): ExternalTurn {
  const blocks = final ? finalizeBlocks(t.stream) : snapshotBlocks(t.stream);
  const { stream: _s, startIndex: _i, ...rest } = t;
  return { ...rest, blocks };
}

// ---------- Claude Code ----------

/** Text of a typed prompt line: the string content, or the joined `text` blocks.
 *  Returns null when the line carries no user text (tool result, image-only). */
function claudePromptText(j: any): string | null {
  const c = j.message?.content;
  if (typeof c === 'string') return c || null;
  if (Array.isArray(c)) {
    const text = c
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
    return text || null;
  }
  return null;
}

/** Injected user lines (system reminders, Maestro's own preamble) look like typed
 *  prompts but must not open a turn. */
function isInjectedPrompt(text: string): boolean {
  return /^<(maestro|system_instruction|system-reminder)/i.test(text.trim());
}

export function foldClaudeLines(lines: string[], carry?: ExternalTurn): FoldResult {
  const closed: ExternalTurn[] = [];
  let cur: WorkTurn | undefined = carry ? revive(carry) : undefined;
  const finishCur = () => {
    if (cur) closed.push(toExternal(cur, true));
    cur = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const j = parseJsonLine(lines[i]);
    if (!j || j.isSidechain) continue;
    const isToolResult = j.type === 'user' && !!j.toolUseResult;

    if (j.type === 'user' && !isToolResult) {
      const text = claudePromptText(j);
      if (text === null || isInjectedPrompt(text)) continue; // not a real turn boundary
      finishCur(); // a prompt implies the previous turn ended, even without end_turn
      cur = {
        id: typeof j.uuid === 'string' ? j.uuid : `cc-${i}`,
        prompt: { text, ts: tsOf(j) },
        blocks: [],
        closed: false,
        ts: tsOf(j),
        by: j.entrypoint === 'sdk-cli' ? 'maestro' : 'external',
        stream: newBlockStream(),
        startIndex: i,
      };
      continue;
    }

    if (j.type === 'assistant' || isToolResult) {
      if (!cur) continue; // output before any prompt — drop
      for (const ev of parseClaudeLine(lines[i])) {
        if (ev.kind === 'context' || ev.kind === 'session' || ev.kind === 'done' || ev.kind === 'task') continue;
        applyBlockEvent(cur.stream, ev);
      }
      if (j.type === 'assistant') {
        if (typeof j.message?.model === 'string') cur.model = j.message.model;
        if (j.message?.stop_reason === 'end_turn') cur.closed = true;
      }
      const t = tsOf(j);
      if (t) cur.ts = t;
    }
    // every other line type (system, cost-state, pr-link, …) is ignored
  }

  return finalizeFold(closed, cur, lines.length);
}

// ---------- Codex ----------

/** exit-code sniff for a shell function_call_output: Codex prints "exited with
 *  code N" in the aggregated output when a command failed. */
function codexOutputOk(output: unknown): boolean {
  const s = typeof output === 'string' ? output : '';
  return !/exited with code [1-9]/.test(s);
}

function codexJoinText(items: unknown): string {
  if (!Array.isArray(items)) return typeof items === 'string' ? items : '';
  return items
    .map((it: any) => (typeof it === 'string' ? it : typeof it?.text === 'string' ? it.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function foldCodexLines(lines: string[], carry?: ExternalTurn): FoldResult {
  const closed: ExternalTurn[] = [];
  let cur: WorkTurn | undefined = carry ? revive(carry) : undefined;
  let pendingPrompt: { text: string; ts: number } | null = null;
  const finishCur = () => {
    if (cur) closed.push(toExternal(cur, true));
    cur = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const j = parseJsonLine(lines[i]);
    if (!j) continue;
    const p = j.payload ?? {};
    const t = tsOf(j);

    switch (p.type) {
      case 'task_started': {
        finishCur();
        cur = {
          id: typeof p.turn_id === 'string' ? p.turn_id : `cx-${i}`,
          prompt: pendingPrompt ?? { text: '', ts: t },
          blocks: [],
          closed: false,
          ts: t,
          by: 'external',
          stream: newBlockStream(),
          startIndex: i,
        };
        pendingPrompt = null;
        break;
      }
      case 'user_message': {
        const text = typeof p.message === 'string' ? p.message : '';
        if (cur && !cur.prompt.text) cur.prompt = { text, ts: t };
        else if (!cur) pendingPrompt = { text, ts: t };
        break;
      }
      case 'turn_context': {
        if (cur && typeof p.model === 'string') cur.model = p.model;
        break;
      }
      case 'message': {
        // response_item assistant text. (role:'user' messages carry injected
        // context — AGENTS.md, recommended plugins — and are ignored.)
        if (cur && p.role === 'assistant') {
          const text = codexJoinText(p.content?.filter?.((c: any) => c?.type === 'output_text') ?? p.content);
          if (text) applyBlockEvent(cur.stream, { kind: 'message-final', blocks: [{ type: 'text', text }] });
        }
        break;
      }
      case 'reasoning': {
        if (cur) {
          const text = codexJoinText(p.summary);
          if (text) applyBlockEvent(cur.stream, { kind: 'message-final', blocks: [{ type: 'thinking', text }] });
        }
        break;
      }
      case 'function_call': {
        if (cur) {
          let input: unknown;
          try {
            input = JSON.parse(p.arguments);
          } catch {
            input = { raw: p.arguments };
          }
          applyBlockEvent(cur.stream, {
            kind: 'tool-start',
            toolId: p.call_id ?? p.id ?? 'call',
            name: typeof p.name === 'string' ? p.name : 'tool',
            input,
          });
        }
        break;
      }
      case 'function_call_output': {
        if (cur) {
          const out = typeof p.output === 'string' ? p.output : codexJoinText(p.output);
          applyBlockEvent(cur.stream, {
            kind: 'tool-result',
            toolId: p.call_id ?? p.id ?? 'call',
            ok: codexOutputOk(out),
            summary: truncate(out),
          });
        }
        break;
      }
      case 'custom_tool_call': {
        if (cur) {
          applyBlockEvent(cur.stream, {
            kind: 'tool-start',
            toolId: p.call_id ?? p.id ?? 'call',
            name: typeof p.name === 'string' ? p.name : 'tool',
            input: { input: p.input },
          });
        }
        break;
      }
      case 'custom_tool_call_output': {
        if (cur) {
          applyBlockEvent(cur.stream, {
            kind: 'tool-result',
            toolId: p.call_id ?? p.id ?? 'call',
            ok: true,
            summary: truncate(codexJoinText(p.output)),
          });
        }
        break;
      }
      case 'web_search_call': {
        if (cur) {
          const id = p.call_id ?? p.id ?? 'web_search';
          applyBlockEvent(cur.stream, {
            kind: 'tool-start',
            toolId: id,
            name: 'web_search',
            input: { query: p.action?.query },
          });
          applyBlockEvent(cur.stream, { kind: 'tool-result', toolId: id, ok: true, summary: '' });
        }
        break;
      }
      case 'task_complete': {
        if (cur) {
          cur.closed = true;
          if (typeof p.duration_ms === 'number') cur.durationMs = p.duration_ms;
        }
        break;
      }
      case 'turn_aborted': {
        if (cur) {
          cur.closed = true;
          applyBlockEvent(cur.stream, { kind: 'message-final', blocks: [{ type: 'text', text: '_(interrupted)_' }] });
        }
        break;
      }
      default:
        break; // token_count, patch_apply_end, world_state, … — ignored
    }
    if (cur && t) cur.ts = t;
  }

  return finalizeFold(closed, cur, lines.length);
}

// ---------- shared tail ----------

function finalizeFold(closed: ExternalTurn[], cur: WorkTurn | undefined, total: number): FoldResult {
  if (!cur) return { closed, consumed: total };
  if (cur.closed) {
    closed.push(toExternal(cur, true));
    return { closed, consumed: total };
  }
  const open = toExternal(cur, false);
  const consumed = cur.startIndex >= 0 ? cur.startIndex : 0;
  return { closed, open, consumed };
}
