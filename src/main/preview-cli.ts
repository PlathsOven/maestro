/**
 * `maestro-preview <command> …` — the CLI an agent shells out to in order to
 * drive Maestro's embedded browser pane (navigate, screenshot, read the console,
 * click/type, …). It forwards its argv to Maestro's loopback /preview route and
 * prints the plain-text result to stdout (exit 0 on success, 1 on failure). Runs
 * as plain Node (the shim re-execs the app with ELECTRON_RUN_AS_NODE=1), so it
 * depends on Node builtins only. Mirrors maestro-ask / maestro-role.
 */
import { PREVIEW_ENV } from '../shared/types';
import { makeFail, postJson } from './cli-shared';

const fail = makeFail('maestro-preview');

async function main(): Promise<void> {
  const url = process.env[PREVIEW_ENV.url];
  const token = process.env[PREVIEW_ENV.token];
  const workspaceId = process.env[PREVIEW_ENV.workspaceId];
  const agentId = process.env[PREVIEW_ENV.agentId];

  if (!url || !token || !workspaceId) {
    return fail('this command only works inside a Maestro agent session.');
  }

  const argv = process.argv.slice(2);
  const body = JSON.stringify({ workspaceId, agentId, argv });
  postJson(url, token, '/preview', body, fail, (statusCode, out) => {
    if (statusCode !== 200) {
      let msg = `preview failed (HTTP ${statusCode})`;
      try {
        const j = JSON.parse(out);
        if (j?.text || j?.error) msg = j.text || j.error;
      } catch {}
      return fail(msg);
    }
    let j: any;
    try {
      j = JSON.parse(out);
    } catch {
      return fail(`unexpected response from Maestro: ${out.slice(0, 200)}`);
    }
    process.stdout.write((j.text ?? '') + '\n');
    process.exit(j.ok ? 0 : 1);
  });
}

void main();
