import { run } from '../../exec';
import type { HostChild } from '../../hosts/types';
import type { AgentEvent, GlobalSettings, HarnessId, HarnessInfo, SubUsage } from '../../../shared/types';

export interface BuildOpts {
  prompt: string;
  sessionId: string | null;
  permissionMode: GlobalSettings['permissionMode'];
  systemPrompt: string | null;
  /** model id ('' = harness CLI default) */
  model?: string;
  /** '' | 'low' | 'medium' | 'high' | 'max' */
  effort?: string;
}

export interface AdapterCommand {
  cmd: string;
  args: string[];
  /** when set, written to stdin and closed */
  stdin: string | null;
  env?: Record<string, string>;
  /** Session id the adapter minted client-side (e.g. grok `-s <id>` creates-or-
   *  resumes). The runner stores it exactly as if the CLI had emitted a
   *  {kind:'session'} event. */
  sessionHint?: string;
}

export interface HarnessAdapter {
  id: HarnessId;
  displayName: string;
  /** true: stdout is NDJSON parsed via parseLine; false: raw text streamed as deltas */
  jsonOutput: boolean;
  detect(): Promise<HarnessInfo>;
  build(opts: BuildOpts): AdapterCommand;
  parseLine(line: string): AgentEvent[];
  /** value stored as the "session" after a run, when the CLI has no explicit id */
  implicitSession?: string;
  /**
   * Cloud unattended-drain recipe (spec §6.4). Present ⇒ the box can chain queued
   * turns while the app is closed, because turn N+1 can recover turn N's session
   * id from the journal itself. `sessionRecipe` is a POSIX-sh command that reads
   * `$MAESTRO_JOURNAL` and echoes the resume id (empty on the first turn); it is
   * baked into the per-chat `turn.sh`. Absent ⇒ the drain loop still runs the one
   * turn the app started (turns survive for every harness), but the queue waits
   * for the app to reattach and drain it (which it does through the same files).
   */
  unattendedDrain?: { sessionRecipe: string };
  /** subscription rate-limit usage for one login's credentials (`loginDir`
   *  undefined = the CLI's default store). null when not signed in with a
   *  subscription or the harness has no such notion. */
  fetchUsage?(loginDir?: string): Promise<SubUsage | null>;
  /** Per-login credential isolation. `env(dir)` makes the CLI read/write its
   *  credentials under `dir` instead of its default store, leaving sessions and
   *  settings shared. Absent = the harness supports exactly one login. */
  loginIsolation?: { env(dir: string): Record<string, string> };
  /** Who this login is, from its token (`loginDir` as in fetchUsage). null on
   *  any failure. */
  fetchProfile?(loginDir?: string): Promise<{ email?: string; plan?: string } | null>;
}

// The pure parse helpers moved to src/shared/harness/parse.ts (shared with the
// relay ingest, G7); re-exported so existing adapter call sites are untouched.
export { extractResultText, truncate, parseJsonLine, parseArgs, firstStr, firstNum } from '../../../shared/harness/parse';

/** Standard `<bin> --version` install probe shared by the version-flag adapters. */
export async function detectVersion(id: HarnessId, displayName: string, bin: string): Promise<HarnessInfo> {
  const r = await run(bin, ['--version'], { timeout: 15_000 });
  return {
    id,
    displayName,
    installed: r.ok,
    version: r.ok ? r.stdout.trim().split('\n')[0] : null,
  };
}

/** Prepend an optional system prompt to the user prompt, for CLIs without a
 *  dedicated system-prompt flag. */
export function promptWithSystem(opts: BuildOpts): string {
  return opts.systemPrompt ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}` : opts.prompt;
}

/** Send the prompt on stdin, then pipe the child's stdout/stderr into the
 *  adapter: NDJSON adapters parse each line to events for `emit`, raw adapters
 *  stream text deltas; stderr is fed to `appendStderr` so the caller can keep a
 *  tail for crash diagnostics. onError/onClose stay with the caller (they differ
 *  between the chat turn and specialist runs). */
export function wireAdapterStream(
  child: HostChild,
  adapter: HarnessAdapter,
  stdin: string | null,
  emit: (event: AgentEvent) => void,
  appendStderr: (chunk: string) => void
): void {
  if (stdin !== null) child.writeStdin(stdin);
  child.endStdin();

  if (adapter.jsonOutput) {
    child.onStdoutLine((line) => {
      if (!line.trim()) return;
      for (const ev of adapter.parseLine(line)) emit(ev);
    });
    child.onStderr(appendStderr);
  } else {
    emit({ kind: 'seg-start', segType: 'text' });
    child.onStdout((chunk) => emit({ kind: 'seg-delta', text: chunk }));
    child.onStderr((chunk) => emit({ kind: 'seg-delta', text: chunk }));
  }
}
