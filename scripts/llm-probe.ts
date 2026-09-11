import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveShellEnv } from '../src/main/env';
import { detectHarnesses } from '../src/main/services/harness';
import { generateOneShot, generateText, pickLlmHarness } from '../src/main/services/llm';

/**
 * The bug this branch exists for, end to end: the Status tab's digest is a
 * `generateText` call, which on Windows died with "spawn claude ENOENT".
 * Makes one real (cheap) call through the same path, plus the generateOneShot
 * path behind PR descriptions and workspace titles.
 *
 *   npx esbuild scripts/llm-probe.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:better-sqlite3 --external:node-pty --outfile=dist/llm-probe.cjs
 *   ELECTRON_RUN_AS_NODE=1 npx electron dist/llm-probe.cjs
 */
async function main() {
  resolveShellEnv();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-llm-'));

  const infos = await detectHarnesses();
  console.log('detected:', infos.filter((h) => h.installed).map((h) => `${h.id} ${h.version ?? ''}`.trim()));
  console.log('utility harness:', await pickLlmHarness());

  const t0 = Date.now();
  const res = await generateText({
    cwd,
    prompt: 'Reply with exactly one word: OK',
    tier: 'light',
    timeoutMs: 120_000,
  });
  console.log(`generateText (${Date.now() - t0}ms):`, JSON.stringify(res));

  const one = await generateOneShot(cwd, 'Reply with exactly one word: FINE', 120_000, 'light');
  console.log('generateOneShot:', JSON.stringify(one));

  const ok = !!res.text && !!one;
  console.log(ok ? '\nall passed' : '\nFAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
