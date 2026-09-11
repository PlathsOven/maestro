import { parseNoop } from '../../../shared/harness/parse';
import { detectVersion, promptWithSystem, type BuildOpts, type HarnessAdapter } from './adapter';

// OpenCode CLI: plain-text `opencode run`; continuity via --continue (last
// session in the working directory).
export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  jsonOutput: false,
  implicitSession: '__continue__',

  detect: () => detectVersion('opencode', 'OpenCode', 'opencode'),

  build(opts: BuildOpts) {
    const args = ['run'];
    // OpenCode's plan mode is its built-in `plan` agent: edit/write tools are
    // denied, so it proposes changes without applying them.
    if (opts.permissionMode === 'plan') args.push('--agent', 'plan');
    if (opts.sessionId) args.push('--continue');
    args.push(promptWithSystem(opts));
    return { cmd: 'opencode', args, stdin: null };
  },

  parseLine: parseNoop,

  // Unattended cloud drain: `--continue` resumes the last session in the cwd, so
  // no id is needed — echo a non-empty marker once any turn has completed, which
  // flips turn.sh onto its `--continue` branch for every turn after the first.
  unattendedDrain: {
    sessionRecipe: `grep -q '"maestro":"turn-end"' "$MAESTRO_JOURNAL" 2>/dev/null && echo continue || true`,
  },
};
