import { parseCursorLine } from '../../../shared/harness/parse';
import { detectVersion, promptWithSystem, type BuildOpts, type HarnessAdapter } from './adapter';

// Cursor CLI (`cursor-agent`) with stream-json output. Assistant events carry
// incremental text chunks, so we surface them as deltas.
export const cursorAdapter: HarnessAdapter = {
  id: 'cursor',
  displayName: 'Cursor Agent',
  jsonOutput: true,

  detect: () => detectVersion('cursor', 'Cursor Agent', 'cursor-agent'),

  build(opts: BuildOpts) {
    const args = ['-p', '--output-format', 'stream-json', '--force'];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    args.push(promptWithSystem(opts));
    return { cmd: 'cursor-agent', args, stdin: null };
  },

  // Pure NDJSON → events; shared verbatim with the relay ingest (§6.4, G7).
  parseLine: parseCursorLine,
};
