import { parseKimiLine } from '../../../shared/harness/parse';
import { detectVersion, promptWithSystem, type BuildOpts, type HarnessAdapter } from './adapter';

// Kimi Code CLI (`kimi`) in print mode with streaming JSON output. One process
// per user turn; the CLI mints a session id (announced via a role:"meta" record)
// and conversation continuity is via `--session <id>` on the next turn.
export const kimiAdapter: HarnessAdapter = {
  id: 'kimi-code',
  displayName: 'Kimi Code',
  jsonOutput: true,

  detect: () => detectVersion('kimi-code', 'Kimi Code', 'kimi'),

  build(opts: BuildOpts) {
    const prompt = promptWithSystem(opts);
    // Non-interactive: stdin is closed, so an approval prompt would hang the run.
    // Always auto-approve; bypassPermissions gets the fully-autonomous mode.
    const approval = opts.permissionMode === 'bypassPermissions' ? '--auto' : '--yolo';
    const args = ['-p', prompt, '--output-format', 'stream-json', approval];
    if (opts.model) args.push('-m', opts.model);
    if (opts.sessionId) args.push('--session', opts.sessionId);
    return { cmd: 'kimi', args, stdin: null };
  },

  // Pure NDJSON → events; shared verbatim with the relay ingest (§6.4, G7).
  parseLine: parseKimiLine,
};
