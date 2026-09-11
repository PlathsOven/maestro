/**
 * Pure NDJSON parsing for every harness (spec mobile-web-app §6.4). Each
 * adapter's `parseLine` — the code that turns one line of a CLI's stdout into
 * normalized `AgentEvent`s — lives here, free of node builtins and main-process
 * imports, so the desktop main process and the relay ingest run the *same code*
 * over the *same journal bytes* (G7). The main-process adapters
 * (`src/main/services/harness/*.ts`) import their `parseLine` from here and
 * re-export the shared helpers, so all existing call sites are untouched.
 */
import type { AgentBlock, AgentEvent, BackgroundTaskStatus, ContextUsage, HarnessId } from '../types';
import { GROK_EFFORT_LEVELS } from '../types';

// ---------- shared pure helpers (moved from harness/adapter.ts) ----------

export function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function truncate(s: string, n = 600): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n… (${s.length - n} more chars)`;
}

/** Parse one NDJSON line to an object, or null on parse failure / non-object. */
export function parseJsonLine(line: string): any {
  try {
    const j = JSON.parse(line);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** Best-effort JSON.parse for tool-call arguments that may arrive as a string. */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : { value: raw };
    } catch {
      return { value: raw };
    }
  }
  return {};
}

/** First non-empty string among candidate fields. */
export function firstStr(...c: unknown[]): string | null {
  for (const v of c) if (typeof v === 'string' && v) return v;
  return null;
}

/** First finite number among candidate fields. */
export function firstNum(...c: unknown[]): number | undefined {
  for (const v of c) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

// ---------- Claude Code ----------

/** CLI background-task states → the ledger's. Unknown/absent leaves it unchanged. */
function claudeTaskStatus(s: unknown): BackgroundTaskStatus | undefined {
  switch (s) {
    case 'running':
    case 'started':
      return 'running';
    case 'completed':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'killed':
    case 'stopped':
      return 'killed';
    default:
      return undefined;
  }
}

/**
 * Context occupancy from a single API call's usage. The prompt side
 * (input + cacheRead + cacheCreation) is exactly what sat in the window for
 * that call; adding output gives what the next call starts from.
 */
function claudeContextEvent(u: any): AgentEvent | null {
  if (!u) return null;
  const usage = {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
  const contextTokens = usage.input + usage.cacheRead + usage.cacheCreation + usage.output;
  return contextTokens > 0 ? { kind: 'context', contextTokens, usage } : null;
}

export function parseClaudeLine(line: string): AgentEvent[] {
  const j = parseJsonLine(line);
  if (!j) return [];
  const events: AgentEvent[] = [];
  switch (j.type) {
    case 'system': {
      if (j.subtype === 'init' && j.session_id) events.push({ kind: 'session', sessionId: j.session_id });
      else if (j.subtype === 'task_started' && j.task_id) {
        events.push({
          kind: 'task',
          task: {
            taskId: j.task_id,
            status: 'running',
            description: typeof j.description === 'string' ? j.description : undefined,
            taskType: typeof j.task_type === 'string' ? j.task_type : undefined,
          },
        });
      } else if (j.subtype === 'task_updated' && j.task_id) {
        events.push({ kind: 'task', task: { taskId: j.task_id, status: claudeTaskStatus(j.patch?.status) } });
      } else if (j.subtype === 'task_notification' && j.task_id) {
        events.push({
          kind: 'task',
          task: {
            taskId: j.task_id,
            status: claudeTaskStatus(j.status),
            description: typeof j.summary === 'string' ? j.summary : undefined,
            outputFile: typeof j.output_file === 'string' && j.output_file ? j.output_file : undefined,
          },
        });
      }
      break;
    }
    case 'stream_event': {
      const ev = j.event;
      if (!ev) break;
      if (ev.type === 'message_start') {
        if (!j.parent_tool_use_id) {
          const c = claudeContextEvent(ev.message?.usage);
          if (c) events.push(c);
        }
      } else if (ev.type === 'content_block_start') {
        const cb = ev.content_block;
        if (cb?.type === 'text') events.push({ kind: 'seg-start', segType: 'text' });
        else if (cb?.type === 'thinking') events.push({ kind: 'seg-start', segType: 'thinking' });
        else if (cb?.type === 'tool_use') {
          events.push({ kind: 'tool-start', toolId: cb.id ?? `tool-${ev.index}`, name: cb.name ?? 'tool', input: cb.input ?? {} });
        }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta;
        if (d?.type === 'text_delta' && d.text) events.push({ kind: 'seg-delta', text: d.text });
        else if (d?.type === 'thinking_delta' && d.thinking) events.push({ kind: 'seg-delta', text: d.thinking });
      }
      break;
    }
    case 'assistant': {
      const content = j.message?.content;
      if (Array.isArray(content)) {
        const blocks: AgentBlock[] = [];
        for (const c of content) {
          if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text });
          else if (c.type === 'thinking' && c.thinking) blocks.push({ type: 'thinking', text: c.thinking });
          else if (c.type === 'tool_use') blocks.push({ type: 'tool', id: c.id, name: c.name, input: c.input });
        }
        if (blocks.length) events.push({ kind: 'message-final', blocks });
      }
      if (!j.parent_tool_use_id) {
        const c = claudeContextEvent(j.message?.usage);
        if (c) events.push(c);
      }
      break;
    }
    case 'user': {
      const content = j.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'tool_result') {
            events.push({
              kind: 'tool-result',
              toolId: c.tool_use_id,
              ok: !c.is_error,
              summary: truncate(extractResultText(c.content)),
            });
          }
        }
      }
      break;
    }
    case 'rate_limit_event': {
      // Only a *rejection* means the turn was blocked on a limit; `allowed` /
      // `allowed_warning` are just headroom telemetry we don't act on.
      const r = j.rate_limit_info;
      if (r?.status === 'rejected') {
        const resetsAt =
          typeof r.resetsAt === 'number' ? (r.resetsAt > 1e12 ? r.resetsAt : r.resetsAt * 1000) : undefined;
        const window = typeof r.rateLimitType === 'string' ? r.rateLimitType : undefined;
        events.push({ kind: 'limit', resetsAt, window });
      }
      break;
    }
    case 'result': {
      if (j.origin?.kind) break;
      const denials = Array.isArray(j.permission_denials) ? j.permission_denials.length : 0;
      if (j.session_id) events.push({ kind: 'session', sessionId: j.session_id });
      events.push({
        kind: 'done',
        ok: !j.is_error,
        error: j.is_error ? extractResultText(j.result) || j.subtype : undefined,
        costUsd: j.total_cost_usd,
        durationMs: j.duration_ms,
        needsAttention: denials > 0,
      });
      break;
    }
  }
  return events;
}

// ---------- Codex ----------

export function parseCodexLine(line: string): AgentEvent[] {
  const j = parseJsonLine(line);
  if (!j) return [];
  const events: AgentEvent[] = [];
  const itemType = (item: any) => item?.item_type ?? item?.type ?? 'item';
  switch (j.type) {
    case 'thread.started': {
      if (j.thread_id) events.push({ kind: 'session', sessionId: j.thread_id });
      break;
    }
    case 'item.started': {
      const item = j.item;
      const t = itemType(item);
      if (t === 'command_execution') {
        events.push({ kind: 'tool-start', toolId: item.id ?? 'cmd', name: 'shell', input: { command: item.command } });
      } else if (t === 'file_change' || t === 'patch_apply') {
        events.push({ kind: 'tool-start', toolId: item.id ?? 'patch', name: 'edit', input: item.changes ?? {} });
      } else if (t === 'mcp_tool_call') {
        events.push({ kind: 'tool-start', toolId: item.id ?? 'mcp', name: item.tool ?? 'mcp', input: item.arguments ?? {} });
      } else if (t === 'web_search') {
        events.push({ kind: 'tool-start', toolId: item.id ?? 'search', name: 'web_search', input: { query: item.query } });
      }
      break;
    }
    case 'item.completed': {
      const item = j.item;
      const t = itemType(item);
      if (t === 'agent_message' || t === 'assistant_message') {
        if (item.text) events.push({ kind: 'message-final', blocks: [{ type: 'text', text: item.text }] });
      } else if (t === 'reasoning') {
        if (item.text) events.push({ kind: 'message-final', blocks: [{ type: 'thinking', text: item.text }] });
      } else if (t === 'command_execution') {
        events.push({
          kind: 'tool-result',
          toolId: item.id ?? 'cmd',
          ok: item.exit_code === 0 || item.status === 'completed',
          summary: truncate(item.aggregated_output ?? ''),
        });
      } else if (t === 'file_change' || t === 'patch_apply') {
        events.push({ kind: 'tool-result', toolId: item.id ?? 'patch', ok: item.status !== 'failed', summary: '' });
      } else if (t === 'mcp_tool_call') {
        events.push({ kind: 'tool-result', toolId: item.id ?? 'mcp', ok: item.status !== 'failed', summary: '' });
      }
      break;
    }
    case 'turn.completed': {
      events.push({ kind: 'done', ok: true });
      break;
    }
    case 'turn.failed': {
      events.push({ kind: 'done', ok: false, error: j.error?.message ?? 'turn failed' });
      break;
    }
    case 'error': {
      events.push({ kind: 'done', ok: false, error: j.message ?? 'codex error' });
      break;
    }
  }
  return events;
}

// ---------- Cursor ----------

export function parseCursorLine(line: string): AgentEvent[] {
  const j = parseJsonLine(line);
  if (!j) return [];
  const events: AgentEvent[] = [];
  switch (j.type) {
    case 'system': {
      if (j.subtype === 'init' && (j.session_id || j.sessionId)) {
        events.push({ kind: 'session', sessionId: j.session_id ?? j.sessionId });
      }
      break;
    }
    case 'assistant': {
      const content = j.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && c.text) events.push({ kind: 'seg-delta', text: c.text });
        }
      }
      break;
    }
    case 'tool_call': {
      const tc = j.tool_call ?? {};
      const name = Object.keys(tc)[0] ?? 'tool';
      if (j.subtype === 'started') {
        events.push({ kind: 'tool-start', toolId: j.call_id ?? name, name, input: tc[name]?.args ?? {} });
      } else if (j.subtype === 'completed') {
        events.push({ kind: 'tool-result', toolId: j.call_id ?? name, ok: true, summary: '' });
      }
      break;
    }
    case 'result': {
      events.push({
        kind: 'done',
        ok: j.subtype !== 'error' && !j.is_error,
        error: j.is_error ? String(j.result ?? 'error') : undefined,
        durationMs: j.duration_ms,
      });
      break;
    }
  }
  return events;
}

// ---------- Kimi Code ----------

function kimiSessionIdFrom(j: any): string | null {
  return firstStr(
    j.session?.resume_hint,
    j.resume_hint,
    j.session?.id,
    j.session?.session_id,
    j.session_id,
    j.sessionId,
    typeof j.session === 'string' ? j.session : undefined,
    j.id
  );
}

export function parseKimiLine(line: string): AgentEvent[] {
  const j = parseJsonLine(line);
  if (!j) return [];
  const events: AgentEvent[] = [];
  switch (j.role) {
    case 'meta': {
      const id = kimiSessionIdFrom(j);
      if (id) events.push({ kind: 'session', sessionId: id });
      break;
    }
    case 'assistant': {
      const reasoning = j.reasoning_content ?? j.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        events.push({ kind: 'seg-start', segType: 'thinking' }, { kind: 'seg-delta', text: reasoning });
      }
      if (typeof j.content === 'string' && j.content) {
        events.push({ kind: 'seg-start', segType: 'text' }, { kind: 'seg-delta', text: j.content });
      }
      if (Array.isArray(j.tool_calls)) {
        for (const tc of j.tool_calls) {
          const fn = tc?.function ?? {};
          events.push({
            kind: 'tool-start',
            toolId: tc?.id ?? fn.name ?? 'tool',
            name: fn.name ?? 'tool',
            input: parseArgs(fn.arguments),
          });
        }
      }
      break;
    }
    case 'tool': {
      events.push({
        kind: 'tool-result',
        toolId: j.tool_call_id ?? j.id ?? 'tool',
        ok: !j.is_error && !j.error,
        summary: truncate(typeof j.content === 'string' ? j.content : ''),
      });
      break;
    }
    case 'error': {
      events.push({ kind: 'done', ok: false, error: j.message ?? j.error ?? 'kimi error' });
      break;
    }
  }
  return events;
}

// ---------- Grok Build ----------

function grokNormalizeToolName(raw: unknown): string {
  const name = typeof raw === 'string' && raw ? raw : 'tool';
  const n = name.toLowerCase();
  if (/(^|[_-])(bash|shell|sh|exec|command|terminal|run)($|[_-])/.test(n)) return 'shell';
  if (/(^|[_-])(edit|multiedit|write|str.?replace|create.?file|apply.?patch|update.?file|patch)/.test(n)) return 'edit';
  return name;
}

function grokToolFailed(j: any): boolean {
  if (j.is_error || j.error) return true;
  const status = firstStr(j.status, j.result?.status);
  if (status && /^(error|fail|failed|denied|rejected)$/i.test(status)) return true;
  if (typeof j.exit_code === 'number') return j.exit_code !== 0;
  if (typeof j.ok === 'boolean') return !j.ok;
  return false;
}

function grokResultText(j: any): string {
  const v = j.output ?? j.result ?? j.content ?? j.stdout ?? '';
  if (typeof v === 'string') return v;
  try {
    return v && typeof v === 'object' ? JSON.stringify(v) : '';
  } catch {
    return '';
  }
}

function grokUsageFrom(u: any): { usage: ContextUsage; contextTokens: number } | null {
  if (!u || typeof u !== 'object') return null;
  const usage: ContextUsage = {
    input: firstNum(u.input_tokens, u.prompt_tokens) ?? 0,
    cacheRead: firstNum(u.cache_read_input_tokens, u.cached_tokens) ?? 0,
    cacheCreation: firstNum(u.cache_creation_input_tokens) ?? 0,
    output: firstNum(u.output_tokens, u.completion_tokens) ?? 0,
  };
  const contextTokens = usage.input + usage.cacheRead + usage.cacheCreation + usage.output;
  return contextTokens > 0 ? { usage, contextTokens } : null;
}

/** Clamp a stored effort id to one Grok's ladder advertises. Exported for the
 *  grok adapter's build(). */
export function grokClampEffort(effort: string): string {
  const ids = GROK_EFFORT_LEVELS.map((e) => e.id);
  if (ids.includes(effort)) return effort;
  const prefer = /ultra|max/i.test(effort) ? ['xhigh', 'high'] : ['high', 'medium', 'low'];
  return prefer.find((id) => ids.includes(id)) ?? ids[ids.length - 1];
}

export function parseGrokLine(line: string): AgentEvent[] {
  const j = parseJsonLine(line);
  if (!j) return [];
  const events: AgentEvent[] = [];

  switch (String(j.type ?? '').toLowerCase()) {
    case 'session':
    case 'system': {
      const id = firstStr(j.session_id, j.sessionId, j.session?.id);
      if (id) events.push({ kind: 'session', sessionId: id });
      break;
    }

    case 'reasoning': {
      const text = firstStr(j.delta, j.text, j.content);
      if (text) events.push({ kind: 'seg-start', segType: 'thinking' }, { kind: 'seg-delta', text });
      break;
    }

    case 'assistant': {
      const reasoning = firstStr(j.reasoning, j.reasoning_content);
      if (reasoning) events.push({ kind: 'seg-start', segType: 'thinking' }, { kind: 'seg-delta', text: reasoning });
      const content = j.delta ?? j.text ?? j.content;
      if (typeof content === 'string' && content) {
        events.push({ kind: 'seg-start', segType: 'text' }, { kind: 'seg-delta', text: content });
      } else if (Array.isArray(content)) {
        for (const c of content) {
          const text = typeof c?.text === 'string' ? c.text : '';
          if (text) {
            const segType = c?.type === 'thinking' ? 'thinking' : 'text';
            events.push({ kind: 'seg-start', segType }, { kind: 'seg-delta', text });
          }
        }
      }
      for (const tc of Array.isArray(j.tool_calls) ? j.tool_calls : []) {
        const fn = tc?.function ?? tc ?? {};
        events.push({
          kind: 'tool-start',
          toolId: firstStr(tc?.id, fn.name) ?? 'tool',
          name: grokNormalizeToolName(fn.name),
          input: parseArgs(fn.arguments ?? fn.input),
        });
      }
      break;
    }

    case 'tool_call': {
      events.push({
        kind: 'tool-start',
        toolId: firstStr(j.id, j.call_id, j.name) ?? 'tool',
        name: grokNormalizeToolName(j.name ?? j.tool),
        input: parseArgs(j.input ?? j.arguments ?? j.args),
      });
      break;
    }

    case 'tool_result': {
      events.push({
        kind: 'tool-result',
        toolId: firstStr(j.tool_call_id, j.id, j.call_id) ?? 'tool',
        ok: !grokToolFailed(j),
        summary: truncate(grokResultText(j)),
      });
      break;
    }

    case 'result': {
      const ok = !j.is_error && !j.error;
      const u = grokUsageFrom(j.usage);
      events.push({
        kind: 'done',
        ok,
        error: ok ? undefined : firstStr(j.error?.message, j.error, j.message) ?? 'grok error',
        costUsd: firstNum(j.cost_usd, j.total_cost_usd),
        durationMs: firstNum(j.duration_ms),
        contextTokens: u?.contextTokens,
        usage: u?.usage,
      });
      break;
    }

    case 'error': {
      events.push({ kind: 'done', ok: false, error: firstStr(j.error?.message, j.message, j.error) ?? 'grok error' });
      break;
    }
  }
  return events;
}

// ---------- raw-text adapters ----------

/** OpenCode + Shell stream raw text, not NDJSON — nothing to parse per line. */
export function parseNoop(): AgentEvent[] {
  return [];
}

// ---------- registry ----------

/** parseLine keyed by harness id — the relay ingest resolves a conversation's
 *  parser from its stored `harness`. `jsonOutput: false` harnesses (opencode,
 *  shell) stream raw text; their journal lines are surfaced as text deltas by
 *  the caller, not parsed here. */
export const PARSERS: Record<HarnessId, (line: string) => AgentEvent[]> = {
  'claude-code': parseClaudeLine,
  codex: parseCodexLine,
  cursor: parseCursorLine,
  opencode: parseNoop,
  'kimi-code': parseKimiLine,
  grok: parseGrokLine,
  shell: parseNoop,
};

/** Whether a harness emits NDJSON (parsed via PARSERS) or raw text (streamed as
 *  one text block). Mirrors each adapter's `jsonOutput`. */
export const JSON_OUTPUT: Record<HarnessId, boolean> = {
  'claude-code': true,
  codex: true,
  cursor: true,
  opencode: false,
  'kimi-code': true,
  grok: true,
  shell: false,
};
