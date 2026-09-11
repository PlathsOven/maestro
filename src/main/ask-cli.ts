/**
 * `maestro-ask` — the tiny CLI an agent shells out to in order to ask the user a
 * structured multiple-choice question. It reads a JSON request from stdin (or
 * the args), POSTs it to Maestro's loopback /ask route, blocks while the user
 * answers in the picker, and prints the resulting AskResult JSON to stdout. Runs
 * as plain Node (the shim re-execs the app with ELECTRON_RUN_AS_NODE=1), so it
 * depends on Node builtins only.
 */
import { ASK_ENV } from '../shared/types';
import { makeFail, postJson, readStdin } from './cli-shared';

const fail = makeFail('maestro-ask');

async function main(): Promise<void> {
  const url = process.env[ASK_ENV.url];
  const token = process.env[ASK_ENV.token];
  const workspaceId = process.env[ASK_ENV.workspaceId];
  const agentId = process.env[ASK_ENV.agentId];

  if (!url || !token || !workspaceId) {
    return fail('this command only works inside a Maestro agent session.');
  }

  const argJson = process.argv.slice(2).join(' ').trim();
  const raw = (argJson || (await readStdin())).trim();
  if (!raw) {
    fail('no question provided — pipe a JSON request on stdin, e.g. {"questions":[{"question":"…","options":["A","B"]}]}');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('input is not valid JSON — expected {"questions":[{"question":"…","options":["A","B"]}]}');
  }
  // Accept either {questions:[…]} or a bare array of questions.
  const questions = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    fail('no questions found — expected {"questions":[{"question":"…","options":["A","B"]}]}');
  }

  const body = JSON.stringify({ workspaceId, agentId, questions });
  postJson(url, token, '/ask', body, fail, (statusCode, out) => {
    if (statusCode !== 200) {
      let msg = `ask failed (HTTP ${statusCode})`;
      try {
        const j = JSON.parse(out);
        if (j?.error) msg = j.error;
      } catch {}
      return fail(msg);
    }
    // Pass the AskResult straight through. A dismissed prompt (ok:false /
    // cancelled) is still a valid outcome — exit 0 and let the agent read the
    // fields; only transport/HTTP errors are treated as failures.
    process.stdout.write(out.trim() + '\n');
    process.exit(0);
  });
}

void main();
