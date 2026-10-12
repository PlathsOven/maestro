import { parseKimiLine } from '../../../shared/harness/parse';
import { detectVersion, promptWithSystem, type BuildOpts, type HarnessAdapter } from './adapter';

// Kimi Code platform API ids (platform.kimi.ai) for Maestro's model ids, used in
// API-key mode. Signed in, the same models are the `kimi-code/<id>` aliases the
// CLI provisions at /login.
const API_MODEL: Record<string, string> = {
  k3: 'kimi-k3',
  'kimi-for-coding': 'kimi-k2.7-code',
  'kimi-for-coding-highspeed': 'kimi-k2.7-code-highspeed',
};

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
    // Print mode never asks for approval — it runs under the `auto` permission
    // policy — and kimi rejects -p combined with --yolo/--auto/--plan.
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    // A saved key arrives as KIMI_MODEL_API_KEY; the CLI only uses it when
    // KIMI_MODEL_NAME names the model too, and that model becomes the default —
    // so no -m (a login alias wouldn't exist in that config).
    let env: Record<string, string> | undefined;
    if (opts.apiKeyMode) env = { KIMI_MODEL_NAME: API_MODEL[opts.model ?? ''] ?? opts.model ?? API_MODEL['kimi-for-coding'] };
    else if (opts.model) args.push('-m', opts.model.includes('/') ? opts.model : `kimi-code/${opts.model}`);
    if (opts.sessionId) args.push('--session', opts.sessionId);
    return { cmd: 'kimi', args, stdin: null, env };
  },

  // Pure NDJSON → events; shared verbatim with the relay ingest (§6.4, G7).
  parseLine: parseKimiLine,
};
