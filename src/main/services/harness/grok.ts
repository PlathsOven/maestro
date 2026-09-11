import { randomUUID } from 'crypto';
import { grokClampEffort, parseGrokLine } from '../../../shared/harness/parse';
import { detectVersion, promptWithSystem, type BuildOpts, type HarnessAdapter } from './adapter';

/**
 * xAI Grok Build CLI (`grok`) in headless print mode
 * (`grok -p <prompt> --output-format streaming-json`). One process per user turn.
 *
 * Grok's `-s <id>` *creates or resumes* a named session, so Maestro mints the id
 * client-side (build() → AdapterCommand.sessionHint) instead of scraping it from
 * output — sidestepping the biggest unknown (whether streaming-json announces a
 * session id). See docs/specs/grok-build-harness.md §3.1.
 *
 * The streaming-json schema is NOT publicly documented (spec §8). parseLine()
 * assumes the `type`-tagged NDJSON shape the sibling CLIs use (codex/cursor/claude)
 * and stays lightly defensive — JSON.parse in try/catch, args-as-JSON-string
 * tolerance, a couple of field fallbacks — but does not try to guess several
 * schemas at once. Unrecognized lines return [] (the runner synthesizes `done` on
 * close). Pin the real field names from a capture (fixtures under
 * scripts/fixtures/grok) before merge.
 */

export const grokAdapter: HarnessAdapter = {
  id: 'grok',
  displayName: 'Grok Build',
  jsonOutput: true,

  detect: () => detectVersion('grok', 'Grok Build', 'grok'),

  build(opts: BuildOpts) {
    const prompt = promptWithSystem(opts);
    // `-s <id>` creates-or-resumes; mint one client-side when the chat has none.
    const sessionId = opts.sessionId ?? randomUUID();
    // --always-approve: stdin is closed for headless runs, so any approval prompt
    // would hang the turn (precedent: cursor's hardcoded --force). --no-auto-update:
    // no background update check polluting the NDJSON stream.
    const args = ['-p', prompt, '--output-format', 'streaming-json', '--always-approve', '--no-auto-update', '-s', sessionId];
    if (opts.model) args.push('-m', opts.model);
    // Reasoning effort (§5.4). The headless flag is [verify] — `grok-4.6` supports
    // low…xhigh at the API and the TUI has `/effort`, but no flag is documented;
    // `--effort <level>` is the most likely form. Non-reasoning grok-build-0.1 gets
    // no effort chip (effortLevelsForModel), so no flag.
    if (opts.effort && !/grok-build/i.test(opts.model ?? '')) args.push('--effort', grokClampEffort(opts.effort));
    return { cmd: 'grok', args, stdin: null, sessionHint: sessionId };
  },

  // Pure NDJSON → events; shared verbatim with the relay ingest (§6.4, G7).
  parseLine: parseGrokLine,
  // no implicitSession — sessions are client-minted via sessionHint (spec §3.1)
  // no fetchUsage — no known SuperGrok usage endpoint (spec §7)
};
