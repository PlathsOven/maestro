/**
 * `maestro-role <role>` — the tiny CLI the orchestrator shells out to in order
 * to delegate to a specialist sub-agent. It reads the task from stdin (or the
 * remaining args), POSTs it to Maestro's loopback role server, and prints the
 * specialist's final answer to stdout. Runs as plain Node (the shim re-execs the
 * app with ELECTRON_RUN_AS_NODE=1), so it depends on Node builtins only.
 */
import { ROLE_ENV } from '../shared/types';
import { makeFail, postJson, readStdin } from './cli-shared';

const fail = makeFail('maestro-role');

async function main(): Promise<void> {
  const role = process.argv[2];
  const argPrompt = process.argv.slice(3).join(' ').trim();
  const url = process.env[ROLE_ENV.url];
  const token = process.env[ROLE_ENV.token];
  const workspaceId = process.env[ROLE_ENV.workspaceId];
  const parentAgent = process.env[ROLE_ENV.parentAgent];

  if (!role) return fail('usage: maestro-role <role>   (task on stdin)');
  if (!url || !token || !workspaceId) {
    return fail('this command only works inside a Maestro orchestrator session with specialists enabled.');
  }

  const prompt = (argPrompt || (await readStdin())).trim();
  if (!prompt) fail('no task provided — pipe it on stdin or pass it as an argument.');

  const body = JSON.stringify({ role, workspaceId, parentAgent, prompt });
  postJson(url, token, '/run', body, fail, (statusCode, out) => {
    let j: any;
    try {
      j = JSON.parse(out);
    } catch {
      return fail(`unexpected response from Maestro: ${out.slice(0, 200)}`);
    }
    if (statusCode !== 200 || !j.ok) return fail(j?.error || `delegation failed (HTTP ${statusCode})`);
    process.stdout.write((j.text ?? '') + '\n');
    process.exit(0);
  });
}

void main();
