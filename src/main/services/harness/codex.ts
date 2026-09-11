import os from 'os';
import path from 'path';
import { parseCodexLine } from '../../../shared/harness/parse';
import { detectVersion, promptWithSystem, type BuildOpts, type HarnessAdapter } from './adapter';
import { codexReasoningEffort } from './codex-models';

/** Codex's home dir (`CODEX_HOME` when the user moved it). `MAESTRO_CODEX_HOME`
 *  is a dev/test override (mirrors `claudeDir()`) so the harness-sync fixtures can
 *  point at a scratch tree (spec §8). */
export function codexDir(): string {
  return (
    process.env.MAESTRO_CODEX_HOME?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    path.join(os.homedir(), '.codex')
  );
}

// OpenAI Codex CLI: `codex exec --json` emits JSONL thread/turn/item events.
export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  displayName: 'Codex',
  jsonOutput: true,

  detect: () => detectVersion('codex', 'Codex', 'codex'),

  build(opts: BuildOpts) {
    // Codex has no named plan mode; its read-only sandbox is the same idea — the
    // model can explore but not write. The sandbox alone doesn't tell the model
    // WHY writes fail, so pair it with an explicit planning instruction.
    const plan = opts.permissionMode === 'plan';
    const sandbox = plan
      ? ['--sandbox', 'read-only']
      : [opts.permissionMode === 'bypassPermissions' ? '--dangerously-bypass-approvals-and-sandbox' : '--full-auto'];
    const common = ['--json', ...sandbox, '--skip-git-repo-check'];
    if (opts.model) common.push('-m', opts.model);
    if (opts.effort) {
      // Codex's reasoning ladder is per-model (low…xhigh, plus max/ultra on newer
      // models); translate/clamp our stored id to one this model advertises.
      common.push('-c', `model_reasoning_effort=${codexReasoningEffort(opts.model ?? '', opts.effort)}`);
    }
    const args = opts.sessionId
      ? ['exec', 'resume', opts.sessionId, ...common, '-']
      : ['exec', ...common, '-'];
    const stdinOpts = plan
      ? {
          ...opts,
          systemPrompt:
            (opts.systemPrompt ? `${opts.systemPrompt}\n\n` : '') +
            'Plan mode: you are in a read-only sandbox. Investigate the codebase and reply with a concrete ' +
            'implementation plan; do not attempt to modify files or run state-changing commands.',
        }
      : opts;
    return { cmd: 'codex', args, stdin: promptWithSystem(stdinOpts) };
  },

  // Unattended cloud drain: `thread.started` carries the thread id to resume.
  unattendedDrain: {
    sessionRecipe:
      `grep -o '"thread_id":"[^"]*"' "$MAESTRO_JOURNAL" 2>/dev/null | tail -n 1 | sed 's/.*"thread_id":"//; s/".*//'`,
  },

  // Pure NDJSON → events; shared verbatim with the relay ingest (§6.4, G7).
  parseLine: parseCodexLine,
};
