import { modelForTier, type HarnessId, type ModelTier } from '../../shared/types';
import { localHost } from '../hosts/local';
import type { ExecHost } from '../hosts/types';
import { detectHarnesses } from './harness';
import { harnessLoginEnv } from './harness/logins';

// One-shot LLM generation for Maestro's own features (status digests, run
// script detection). Rides the CLI harnesses the user already has installed —
// Claude Code when available, Codex next, Grok Build last — so there are no API
// keys to configure. Each path feeds the prompt (stdin for claude/codex, argv
// for grok) and reads a single response.

interface LlmResult {
  text: string | null;
  model: string;
  error?: string;
}

/** The harnesses that can serve Maestro's own one-shot LLM calls (a single JSON
 *  response from `-p`/`exec`). The interactive-only harnesses (cursor/opencode/
 *  kimi/shell) don't expose a clean one-shot mode, so they're excluded. */
export type LlmHarness = Extract<HarnessId, 'claude-code' | 'codex' | 'grok'>;

/** The harness Maestro's own LLM calls ride on, strongest one-shot support first:
 *  Claude Code, else Codex, else Grok Build. Null when none is installed. */
export async function pickLlmHarness(): Promise<LlmHarness | null> {
  const infos = await detectHarnesses();
  if (infos.find((h) => h.id === 'claude-code')?.installed) return 'claude-code';
  if (infos.find((h) => h.id === 'codex')?.installed) return 'codex';
  if (infos.find((h) => h.id === 'grok')?.installed) return 'grok';
  return null;
}

const NO_LLM_ERROR =
  'No LLM CLI found — install Claude Code (claude), Codex (codex), or Grok Build (grok) to enable AI features.';

const ONE_SHOT_ENV = {
  // Avoid nested-session detection when Maestro itself runs under a CLI agent.
  CLAUDECODE: undefined,
  CLAUDE_CODE_ENTRYPOINT: undefined,
  CLAUDE_CODE_SSE_PORT: undefined,
  // Digest/extraction work needs speed, not deep deliberation.
  MAX_THINKING_TOKENS: '1024',
};

// Concurrent CLI instances contend (config locking, auth refresh), so
// Maestro's own one-shots run one at a time. Callers still overlap via the
// queue; each just waits its turn.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/**
 * Run a one-shot CLI and collect its output. Local and remote are the same
 * call: the host owns process launching (spec §6.2), which on Windows is what
 * turns a `claude.cmd` shim back into something spawnable (launch.ts).
 * Remote workspaces run the utility LLM on the host where the harness is
 * installed — the remote cwd doesn't even exist on this machine.
 */
async function collect(
  cmd: string,
  args: string[],
  opts: { cwd: string; stdin: string; timeoutMs: number; host?: ExecHost; harness: LlmHarness }
): Promise<{ out: string; error?: string }> {
  const host = opts.host ?? localHost;
  // Local one-shots run under the harness's active login, so a utility call
  // (title, digest) doesn't keep hammering a login rotation just moved off. A
  // remote host has its own credential store — the Mac-local dir is meaningless
  // there, so only the base one-shot env crosses the wire.
  const env = host.id === 'local' ? { ...ONE_SHOT_ENV, ...harnessLoginEnv(opts.harness) } : ONE_SHOT_ENV;
  const r = await host.exec(cmd, args, {
    cwd: opts.cwd,
    input: opts.stdin,
    timeout: opts.timeoutMs,
    env,
  });
  return {
    out: r.stdout,
    error: r.ok ? undefined : r.stderr.trim().slice(-800) || `exit code ${r.exitCode}`,
  };
}

/**
 * One-shot text generation at a model tier ('status' = third-strongest,
 * 'light' = weakest). Runs in `cwd` so read-only tools can inspect the repo
 * if the model chooses to.
 */
export function generateText(opts: {
  cwd: string;
  prompt: string;
  tier: ModelTier;
  /** Prefer this harness (the user's chosen one) when it's installed and can do
   *  one-shot text gen; otherwise fall back to the best available LLM CLI. */
  harness?: LlmHarness;
  /** Run on this host (remote workspaces). Omit/local = this Mac. */
  host?: ExecHost;
  timeoutMs?: number;
}): Promise<LlmResult> {
  return enqueue(() => generateTextNow(opts));
}

/**
 * One-shot generation for Maestro's own copy (PR descriptions, workspace
 * titles): the text, or null when no LLM CLI is installed or the run failed.
 */
export async function generateOneShot(
  cwd: string,
  prompt: string,
  timeoutMs = 90_000,
  tier: ModelTier = 'status'
): Promise<string | null> {
  return (await generateText({ cwd, prompt, tier, timeoutMs })).text;
}

async function generateTextNow(opts: {
  cwd: string;
  prompt: string;
  tier: ModelTier;
  harness?: LlmHarness;
  host?: ExecHost;
  timeoutMs?: number;
}): Promise<LlmResult> {
  const remote = !!opts.host && opts.host.id !== 'local';
  let harness: LlmHarness | null = opts.harness ?? null;
  if (remote) {
    // Remote: use the workspace's harness (must be a one-shot-capable one); it's
    // the CLI installed on the server. If missing, host.exec surfaces the error
    // and the feature degrades to its fallback.
    if (harness !== 'claude-code' && harness !== 'codex' && harness !== 'grok')
      return { text: null, model: '', error: NO_LLM_ERROR };
  } else {
    if (harness) {
      const infos = await detectHarnesses();
      if (!infos.find((h) => h.id === harness)?.installed) harness = null;
    }
    harness = harness ?? (await pickLlmHarness());
  }
  if (!harness) return { text: null, model: '', error: NO_LLM_ERROR };
  const model = modelForTier(harness, opts.tier);
  const timeoutMs = opts.timeoutMs ?? 90_000;

  if (harness === 'claude-code') {
    // --no-session-persistence: a one-shot digest/title/PR-draft must not leave a
    // junk transcript in the user's ~/.claude/projects that pollutes their
    // `claude --resume` picker and history (spec §6.8). Print-mode only.
    const r = await collect('claude', ['-p', '--no-session-persistence', '--output-format', 'json', '--model', model], {
      cwd: opts.cwd,
      stdin: opts.prompt,
      timeoutMs,
      host: opts.host,
      harness,
    });
    if (r.error && !r.out) return { text: null, model, error: r.error };
    // A remote `claude` (over SSH) may print a first-run notice / update banner
    // before the JSON, so slice the JSON object out rather than parsing the whole
    // stream. No JSON at all means the CLI failed (a login prompt, a crash banner)
    // even on exit 0, so it's an error — never the answer (spec §3.2a).
    const j = extractJson<{ is_error?: boolean; result?: unknown }>(r.out);
    if (!j) return { text: null, model, error: r.error ?? `no JSON from claude: ${r.out.trim().slice(-300) || 'empty output'}` };
    if (j.is_error) return { text: null, model, error: typeof j.result === 'string' ? j.result : 'model error' };
    return { text: typeof j.result === 'string' ? j.result : null, model };
  }

  if (harness === 'grok') {
    // Grok: a single JSON object from `--output-format json`. The prompt rides
    // argv (like the turn adapter); stdin stays empty. --always-approve and
    // --no-auto-update stop a read-only one-shot hanging on a prompt/update check.
    // The result field name is [verify] — probe the common conventions. A banner
    // may precede the JSON on a remote box, so slice it out; no JSON at all means
    // the CLI failed and is an error, never the answer (spec §3.2a).
    const args = ['-p', opts.prompt, '--output-format', 'json', '--always-approve', '--no-auto-update'];
    if (model) args.push('-m', model);
    const r = await collect('grok', args, { cwd: opts.cwd, stdin: '', timeoutMs, host: opts.host, harness });
    if (r.error && !r.out) return { text: null, model, error: r.error };
    const j = extractJson<any>(r.out);
    if (!j) return { text: null, model, error: r.error ?? `no JSON from grok: ${r.out.trim().slice(-300) || 'empty output'}` };
    if (j.is_error || (typeof j.error === 'string' && j.error))
      return { text: null, model, error: typeof j.error === 'string' ? j.error : 'model error' };
    const text = [j.result, j.text, j.response, j.output, j.message, j.content].find(
      (v) => typeof v === 'string' && v
    ) as string | undefined;
    return text ? { text, model } : { text: null, model, error: r.error ?? 'no response' };
  }

  // Codex: JSONL events; the answer is the last agent_message item. --ephemeral
  // runs without persisting a session file (spec §6.8), so a one-shot digest/title
  // doesn't litter ~/.codex/sessions.
  const r = await collect('codex', ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '-m', model, '-'], {
    cwd: opts.cwd,
    stdin: opts.prompt,
    timeoutMs,
    host: opts.host,
    harness,
  });
  if (r.error && !r.out) return { text: null, model, error: r.error };
  let text: string | null = null;
  let error: string | undefined;
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const t = j?.item?.item_type ?? j?.item?.type;
      if (j.type === 'item.completed' && (t === 'agent_message' || t === 'assistant_message') && j.item?.text) {
        text = j.item.text;
      } else if (j.type === 'turn.failed') error = j.error?.message ?? 'turn failed';
      else if (j.type === 'error') error = j.message ?? 'codex error';
    } catch {}
  }
  return text ? { text, model } : { text: null, model, error: error ?? r.error ?? 'no response' };
}

/**
 * Pull the first JSON value out of model output — tolerates code fences and
 * prose around it by slicing from the first opening brace/bracket to the last
 * closer. No fence stripping: the payload's own strings may legitimately
 * contain ``` fences (run-script docs do), and the outer fence sits outside
 * the braces anyway. Returns null when nothing parses.
 */
export function extractJson<T>(text: string): T | null {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const closer = text[start] === '{' ? '}' : ']';
  const end = text.lastIndexOf(closer);
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
