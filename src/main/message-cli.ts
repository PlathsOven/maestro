/**
 * `maestro-message list | send <address>` — the CLI an agent shells out to in
 * order to message an agent in another Maestro chat (docs/specs/agent-messaging.md).
 * It forwards its argv (plus the message text from stdin) to Maestro's loopback
 * /message route and prints the plain-text result. Runs as plain Node (the shim
 * re-execs the app with ELECTRON_RUN_AS_NODE=1), so it depends on Node builtins
 * only. Mirrors maestro-preview.
 */
import { MESSAGE_ENV } from '../shared/types';
import { makeFail, postJson, readStdin } from './cli-shared';

const fail = makeFail('maestro-message');

async function main(): Promise<void> {
  const url = process.env[MESSAGE_ENV.url];
  const token = process.env[MESSAGE_ENV.token];
  const workspaceId = process.env[MESSAGE_ENV.workspaceId];
  const agentId = process.env[MESSAGE_ENV.agentId];

  if (!url || !token || !workspaceId) {
    return fail('this command only works inside a Maestro agent session.');
  }

  const argv = process.argv.slice(2);
  // Only `send` reads stdin, so `list` never blocks on it.
  const text = argv[0] === 'send' ? await readStdin() : '';
  const body = JSON.stringify({ workspaceId, agentId, argv, text });
  postJson(url, token, '/message', body, fail, (statusCode, out) => {
    let j: any;
    try {
      j = JSON.parse(out);
    } catch {
      return fail(`unexpected response from Maestro (HTTP ${statusCode}): ${out.slice(0, 200)}`);
    }
    if (statusCode !== 200) return fail(j?.text || j?.error || `message failed (HTTP ${statusCode})`);
    process.stdout.write((j.text ?? '') + '\n');
    process.exit(j.ok ? 0 : 1);
  });
}

void main();
