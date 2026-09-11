import { userShell } from '../../env';
import type { HarnessInfo } from '../../../shared/types';
import { parseNoop } from '../../../shared/harness/parse';
import { type BuildOpts, type HarnessAdapter } from './adapter';

// Generic fallback: run the message as a shell command and stream its output.
// Keeps the whole chat UI usable before any agent CLI is wired up.
export const shellAdapter: HarnessAdapter = {
  id: 'shell',
  displayName: 'Shell (fallback)',
  jsonOutput: false,

  async detect(): Promise<HarnessInfo> {
    return { id: 'shell', displayName: 'Shell (fallback)', installed: true, version: userShell() };
  },

  build(opts: BuildOpts) {
    return { cmd: userShell(), args: ['-lc', opts.prompt], stdin: null };
  },

  parseLine: parseNoop,
};
