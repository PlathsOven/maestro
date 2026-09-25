/**
 * Agent-to-agent messaging verification (docs/specs/agent-messaging.md). Drives
 * the REAL `maestro-message` CLI bundle over the REAL loopback server into
 * `sendChat`, against a temp DB and a fake `claude` on PATH. The fake records its
 * argv and env, so no model is called. It asserts:
 *
 *   1. `list` shows every messageable chat, marks the caller, and skips shell workspaces
 *   2. `send` to an idle chat starts a turn there, and the turn's system prompt
 *      and env carry the messaging preamble and handshake
 *   3. the delivered row is `origin: 'agent'`, message first and a sender/reply footer
 *      last (so a first message titles the chat by its content)
 *   4. a self-send, an unknown address, and an empty message are refused
 *   5. the loop guard refuses the 11th consecutive agent message, and a user
 *      message resets it
 *   6. regression guard: a burst queued behind a busy turn is capped at the door
 *      (queued messages count), and the queue then drains completely — no drained
 *      message is refused, and a user message queued behind the burst still runs
 *   7. a relay placeholder (queued web row) doesn't reset the guard
 *   8. a bare address is chat 1: with chat 1's tab closed it is refused, never
 *      delivered to chat 2; `#2` still reaches chat 2
 *   9. a project name with spaces works as an address even unquoted (split args)
 *  10. sendChat's check-then-start window: two sends in the same tick to an idle
 *      chat (any callers — agent, user, queue drain) → one runs, one queues
 *  11. a workspace whose tabs are all closed is not a target
 *  12. the loop guard on the sending side (a ping-pong fills the sender's chat too)
 *  13. a reply from chat #2: the footer names `ws#2`, and running that exact
 *      command lands back in chat 2
 *  14. an agent message doesn't mark the target chat read
 *  15. the remote curl shim (run by a real sh / dash against the real route):
 *      plain-text output, exit 0 on success and 1 on refusal, UTF-8 addresses,
 *      exact spacing in an address, and a failing exit when its env is missing
 *  16. a blank first tab: chat 1 is a target even when only chat 2 has meta
 *  17. the 32 KB limit counts the footer
 *  18. title footer-stripping is linear (a pasted 1 MB of whitespace must not
 *      freeze the app) and strips footers whose project name has quotes/brackets
 *  19. a long multi-byte message arrives intact (the loopback body spans chunks)
 *
 *   npm run e2e:messaging    (builds dist/main first: the CLI bundle is the unit under test)
 */
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { resolveShellEnv } from '../src/main/env';
import { initDb, Messages, Queued, Workspaces, uid } from '../src/main/db';
import { setWindow } from '../src/main/bus';
import { addProject, createWorkspace } from '../src/main/services/workspaces';
import { isAgentRunning, runningAgents } from '../src/main/services/harness';
import { agentLoopError, sendChat } from '../src/main/services/chat';
import { roleServerInfo, startRoleServer } from '../src/main/services/roleserver';
import { MESSAGE_ENV, messagingPreamble, type HarnessId, type Workspace } from '../src/shared/types';
import { REMOTE_MESSAGE } from '../src/main/hosts/bridge';
import { agentMessageFooter, provisionalTitle } from '../src/shared/chatTitle';

const ROOT = '/tmp/maestro-messaging-e2e';
const CLI = path.join(process.cwd(), 'dist', 'main', 'message-cli.cjs');
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

// A fake Claude Code: dump argv + the MAESTRO_MESSAGE_* env, then emit one
// stream-json turn so the harness finalizes normally.
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = auth ]; then echo '{"loggedIn":true}'; exit 0; fi
if [ "$1" = --version ]; then echo '9.9.9 (Claude Code)'; exit 0; fi
cat >/dev/null
if [ -f "${ROOT}/slow" ]; then sleep 8; fi
printf '%s\\n' "$@" > "${ROOT}/claude-argv-$MAESTRO_MESSAGE_WORKSPACE"
env | grep '^MAESTRO_MESSAGE_' > "${ROOT}/claude-env-$MAESTRO_MESSAGE_WORKSPACE"
echo '{"type":"system","subtype":"init","session_id":"fake-session"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]},"session_id":"fake-session"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"fake-session"}'
`;

/** Spawn `bin args…` with `input` on stdin; stdout+stderr collected. Async: the
 *  loopback server lives in this process, so a sync spawn would deadlock. */
function run(
  bin: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out: out.trim() }));
    child.stdin.end(input);
  });
}

/** Run the CLI as agent `from` would: the bundle under plain node with the
 *  handshake env chat.ts injects. */
function cli(from: Workspace, args: string[], stdin = '', agentId = 1) {
  const info = roleServerInfo()!;
  return run(process.execPath, [CLI, ...args], stdin, {
    ...process.env,
    [MESSAGE_ENV.url]: info.url,
    [MESSAGE_ENV.token]: info.token,
    [MESSAGE_ENV.workspaceId]: from.id,
    [MESSAGE_ENV.agentId]: String(agentId),
  });
}

async function workspace(projectId: string, harness: HarnessId): Promise<Workspace> {
  const ws = await createWorkspace({ projectId, harness });
  await waitFor(() => Workspaces.get(ws.id)?.status !== 'setting-up', 60_000);
  return Workspaces.get(ws.id)!;
}

/** Insert a user message directly (no turn) — `agent` marks it agent-sent. */
function userRow(wsId: string, content = 'x', agent = false): void {
  Messages.insert({
    id: uid(),
    workspaceId: wsId,
    agentId: 1,
    role: 'user',
    content,
    attachments: [],
    ts: Date.now(),
    ...(agent ? { meta: { origin: 'agent' } } : {}),
  });
}
const agentRow = (wsId: string) => userRow(wsId, 'x', true);

/** A fresh git repo at `dir`, added as a project. */
async function gitProject(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -q -b main && git commit -q --allow-empty -m init', { cwd: dir });
  return addProject({ mode: 'local', path: dir });
}

async function main() {
  if (!fs.existsSync(CLI)) throw new Error(`${CLI} missing — run \`npm run build:main\` first`);
  resolveShellEnv();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'bin', 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  process.env.PATH = `${path.join(ROOT, 'bin')}${path.delimiter}${process.env.PATH}`;
  process.env.MAESTRO_HOME = path.join(ROOT, 'home');
  initDb(path.join(ROOT, 'maestro.db'));
  setWindow({ isDestroyed: () => false, isFocused: () => true, webContents: { send: () => {} } } as any);
  startRoleServer();
  await waitFor(() => !!roleServerInfo(), 5000);

  const project = await gitProject(path.join(ROOT, 'repo'));
  const a = await workspace(project.id, 'claude-code');
  const b = await workspace(project.id, 'claude-code');
  const sh = await workspace(project.id, 'shell');

  // ---- 1. list ----
  const list = await cli(a, ['list']);
  check('1: list exits 0', list.code === 0, list.out);
  check('1: list marks the caller', list.out.includes(`${a.name} (you)`), list.out);
  check('1: list includes the peer', new RegExp(`^${b.name} — .*this machine · idle$`, 'm').test(list.out), list.out);
  check('1: list skips shell workspaces', !list.out.includes(sh.name), list.out);

  // ---- 2 + 3. send to an idle chat starts a turn there ----
  const sent = await cli(a, ['send', b.name], 'Please run the tests and tell me if anything fails.');
  check('2: send exits 0', sent.code === 0, sent.out);
  check('2: send reports a started turn', sent.out === `Delivered to ${b.name}.`, sent.out);
  const row = Messages.listForAgent(b.id, 1).find((m) => m.role === 'user');
  check('3: delivered row is origin agent', row?.meta?.origin === 'agent', JSON.stringify(row?.meta));
  check(
    '3: the message comes first, the sender + reply command last (first messages become titles)',
    !!row?.content.startsWith('Please run the tests') &&
      row.content.endsWith(
        `[Sent by the agent in "${a.name}" (${project.name}). Reply with: maestro-message send ${a.name}]`
      ),
    row?.content
  );
  const ran = await waitFor(
    () => fs.existsSync(path.join(ROOT, `claude-argv-${b.id}`)) && runningAgents(b.id).length === 0,
    30_000
  );
  check('2: target turn ran', ran);
  const argv = ran ? fs.readFileSync(path.join(ROOT, `claude-argv-${b.id}`), 'utf8') : '';
  check('2: the system prompt carries the messaging preamble verbatim', argv.includes(messagingPreamble()));
  const env = ran ? fs.readFileSync(path.join(ROOT, `claude-env-${b.id}`), 'utf8') : '';
  check(
    '2: target env carries the handshake',
    env.includes(`${MESSAGE_ENV.workspaceId}=${b.id}`) && env.includes(MESSAGE_ENV.token)
  );

  // ---- 4. refusals ----
  const self = await cli(a, ['send', a.name], 'hi');
  check('4: self-send refused', self.code === 1 && self.out.includes('your own chat'), self.out);
  const unknown = await cli(a, ['send', 'nowhere-v9'], 'hi');
  check('4: unknown address refused', unknown.code === 1 && unknown.out.includes('no chat found'), unknown.out);
  const empty = await cli(a, ['send', b.name], '   ');
  check('4: empty message refused', empty.code === 1 && empty.out.includes('no message'), empty.out);
  const shell = await cli(a, ['send', sh.name], 'rm -rf /');
  check('4: shell workspace is not a target', shell.code === 1 && shell.out.includes('no chat found'), shell.out);

  // ---- 5. loop guard ----
  for (let i = 0; i < 9; i++) agentRow(b.id); // 1 real + 9 = 10 in a row
  const capped = await cli(a, ['send', b.name], 'one more');
  check(
    '5: 11th agent message refused',
    capped.code === 1 && capped.out.includes('10 agent messages in a row'),
    capped.out
  );
  userRow(b.id, 'carry on');
  await waitFor(() => runningAgents(b.id).length === 0, 30_000);
  const reset = await cli(a, ['send', b.name], 'after the user spoke');
  check('5: a user message resets the guard', reset.code === 0, reset.out);
  await waitFor(() => runningAgents(b.id).length === 0, 30_000);

  // ---- 6. a queue drain is never refused mid-queue ----
  fs.writeFileSync(path.join(ROOT, 'slow'), '');
  await sendChat({ workspaceId: b.id, agentId: 1, text: 'long task', attachments: [] });
  await waitFor(() => isAgentRunning(b.id, 1), 5000);
  const burst: { code: number | null; out: string }[] = [];
  for (let i = 0; i < 11; i++) burst.push(await cli(a, ['send', b.name], `burst ${i}`));
  const queuedOk = burst.slice(0, 10).every((r) => r.code === 0 && r.out.includes('queued behind'));
  check('6: 10 agent messages queue behind a busy turn', queuedOk, burst.map((r) => r.out).join(' | '));
  check(
    '6: the 11th is refused at the door',
    burst[10].code === 1 && burst[10].out.includes('in a row'),
    burst[10].out
  );
  const human = await sendChat({
    workspaceId: b.id,
    agentId: 1,
    text: 'user message after the burst',
    attachments: [],
  });
  check('6: a user message queues behind the burst', human.ok && human.queued === true);
  fs.rmSync(path.join(ROOT, 'slow'));
  const drained = await waitFor(() => Queued.forChat(b.id, 1).length === 0 && runningAgents(b.id).length === 0, 90_000);
  const rows = Messages.listForAgent(b.id, 1);
  const delivered = rows.filter((m) => m.role === 'user' && /^burst \d+\n/.test(m.content)).length;
  const users = rows.filter((m) => m.role === 'user');
  check('6: the whole queue drains', drained, `${Queued.forChat(b.id, 1).length} left`);
  check('6: every accepted agent message was delivered', delivered === 10, `${delivered}`);
  check(
    '6: the user message behind them ran last',
    users[users.length - 1]?.content === 'user message after the burst'
  );
  check(
    '6: no drained message failed',
    !rows.some((m) => m.role === 'system' && m.content.includes('failed to start'))
  );

  // ---- 7. relay placeholders don't reset the guard ----
  for (let i = 0; i < 10; i++) agentRow(b.id);
  Messages.insert({
    id: uid(),
    workspaceId: b.id,
    agentId: 1,
    role: 'user',
    content: 'placeholder',
    attachments: [],
    ts: Date.now(),
    meta: { queued: true, origin: 'web' },
  });
  check('7: a relay placeholder does not reset the guard', agentLoopError(b.id, 1) !== null);

  // ---- 8. a bare address never falls through to another chat ----
  Workspaces.patchChat(b.id, 2, { title: 'second chat' });
  Workspaces.patchChat(b.id, 1, { closed: true });
  const toClosed = await cli(a, ['send', b.name], 'for chat one');
  check(
    '8: a closed chat 1 is refused, not rerouted',
    toClosed.code === 1 && toClosed.out.includes('not an open chat'),
    toClosed.out
  );
  check(
    '8: …and chat 2 received nothing',
    !Messages.listForAgent(b.id, 2).some((m) => m.content.startsWith('for chat one'))
  );
  const toTwo = await cli(a, ['send', `${b.name}#2`], 'for chat two');
  check(
    '8: #2 reaches chat 2',
    toTwo.code === 0 && Messages.listForAgent(b.id, 2).some((m) => m.content.startsWith('for chat two')),
    toTwo.out
  );
  await waitFor(() => runningAgents(b.id).length === 0, 30_000);
  Workspaces.patchChat(b.id, 1, { closed: false });

  // ---- 9. a project name with spaces ----
  const spacedProject = await gitProject(path.join(ROOT, 'My App'));
  const c = await workspace(spacedProject.id, 'claude-code');
  const unquoted = await cli(a, ['send', ...`${spacedProject.name}/${c.name}`.split(' ')], 'hello spaced');
  check(
    '9: an unquoted "project with spaces/workspace" address is delivered',
    unquoted.code === 0 && Messages.listForAgent(c.id, 1).some((m) => m.content.startsWith('hello spaced')),
    `${spacedProject.name} → ${unquoted.out}`
  );
  await waitFor(() => runningAgents(c.id).length === 0, 30_000);

  // ---- 10. two sendChats in the same tick ----
  // The second call runs while the first is suspended in turn prep — the window a
  // slow remote-host probe widens. It must queue, not lose to "already running".
  userRow(c.id, 'reset');
  const repliesBefore = Messages.listForAgent(c.id, 1).filter((m) => m.role === 'agent').length;
  fs.writeFileSync(path.join(ROOT, 'slow'), '');
  const [s1, s2] = await Promise.all([
    sendChat({ workspaceId: c.id, agentId: 1, text: 'same tick one', attachments: [] }),
    sendChat({ workspaceId: c.id, agentId: 1, text: 'same tick two', attachments: [] }),
  ]);
  fs.rmSync(path.join(ROOT, 'slow'));
  check('10: both same-tick sends succeed', s1.ok && s2.ok, JSON.stringify([s1, s2]));
  check('10: exactly one of them queued', [s1, s2].filter((r) => r.queued).length === 1, JSON.stringify([s1, s2]));
  await waitFor(() => Queued.forChat(c.id, 1).length === 0 && runningAgents(c.id).length === 0, 60_000);
  const cRows = Messages.listForAgent(c.id, 1);
  const replies = cRows.filter((m) => m.role === 'agent').length - repliesBefore;
  check('10: both ran (two agent turns, not one)', replies === 2, `${replies} turn(s)`);
  check(
    '10: nothing hit "already running"',
    !cRows.some((m) => m.role === 'system' && m.content.includes('already running'))
  );

  // ---- 11. all tabs closed ----
  Workspaces.patchChat(c.id, 1, { closed: true });
  const closedList = await cli(a, ['list']);
  check(
    '11: a workspace with every tab closed is not listed',
    !closedList.out.includes(` · ${spacedProject.name} · `),
    closedList.out
  );
  const toAllClosed = await cli(a, ['send', `${spacedProject.name}/${c.name}`], 'anyone?');
  check(
    '11: …and a send to it is refused',
    toAllClosed.code === 1 && toAllClosed.out.includes('not an open chat'),
    toAllClosed.out
  );
  Workspaces.patchChat(c.id, 1, { closed: false });

  // ---- 12. sender-side loop guard ----
  for (let i = 0; i < 10; i++) agentRow(a.id);
  const fromLooping = await cli(a, ['send', b.id], 'ping');
  check(
    '12: a chat that has only heard from agents lately cannot send',
    fromLooping.code === 1 && fromLooping.out.includes('not sending — your chat has had 10'),
    fromLooping.out
  );
  userRow(a.id, 'user again');

  // ---- 13. reply round-trip from chat #2 ----
  Workspaces.patchChat(a.id, 2, { title: 'a second chat' });
  userRow(b.id, 'reset');
  await waitFor(() => runningAgents(b.id).length === 0, 30_000);
  const fromTwo = await cli(a, ['send', b.id], 'question from chat two', 2);
  const got =
    Messages.listForAgent(b.id, 1)
      .filter((m) => m.role === 'user')
      .pop()?.content ?? '';
  const replyCmd = /Reply with: (maestro-message send \S+)\]$/.exec(got)?.[1] ?? '';
  // `a` may be project-qualified if its random name clashes with another project's.
  check('13: the footer names chat 2', fromTwo.code === 0 && replyCmd.endsWith(`${a.name}#2`), got);
  await waitFor(() => runningAgents(b.id).length === 0 && runningAgents(a.id).length === 0, 30_000);
  const replied = await cli(b, replyCmd.split(' ').slice(1), 'the answer');
  check(
    '13: running that exact command lands in chat 2',
    replied.code === 0 && Messages.listForAgent(a.id, 2).some((m) => m.content.startsWith('the answer')),
    replied.out
  );
  await waitFor(() => runningAgents(a.id).length === 0, 30_000);

  // ---- 14. an agent message doesn't mark the chat read ----
  Workspaces.patchChat(b.id, 1, { lastReadAt: 1, lastAgentAt: 2 });
  await cli(a, ['send', b.id], 'do not mark me read');
  check('14: lastReadAt untouched by an agent message', Workspaces.getChats(b.id)['1']?.lastReadAt === 1);
  await waitFor(() => runningAgents(b.id).length === 0, 30_000);

  // ---- 15. the remote curl shim against the real route ----
  const shimPath = path.join(ROOT, 'bin', 'maestro-message-remote');
  fs.writeFileSync(shimPath, REMOTE_MESSAGE, { mode: 0o755 });
  const info = roleServerInfo()!;
  const shimEnv = {
    ...process.env,
    MAESTRO_MESSAGE_URL: info.url,
    MAESTRO_MESSAGE_TOKEN: info.token,
    MAESTRO_MESSAGE_WORKSPACE: a.id,
    MAESTRO_MESSAGE_AGENT: '1',
  };
  const shells = ['sh', ...(fs.existsSync('/bin/dash') || fs.existsSync('/usr/bin/dash') ? ['dash'] : [])];
  const shim = (sh: string, args: string[], input = '', env = shimEnv) => run(sh, [shimPath, ...args], input, env);
  // A UTF-8 project name, only reachable project-qualified.
  const cafeProject = await gitProject(path.join(ROOT, 'Café App'));
  const d = await workspace(cafeProject.id, 'claude-code');
  for (const sh of shells) {
    const sl = await shim(sh, ['list']);
    check(
      `15 (${sh}): list prints plain text and exits 0`,
      sl.code === 0 && sl.out.includes(b.name) && !sl.out.trim().startsWith('{'),
      sl.out
    );
    const ok = await shim(sh, ['send', b.id], `via the ${sh} shim`);
    check(`15 (${sh}): a delivered send exits 0`, ok.code === 0 && ok.out.startsWith('Delivered to'), ok.out);
    const bad = await shim(sh, ['send', 'nowhere-v9'], 'x');
    check(
      `15 (${sh}): a refused send exits non-zero with the reason`,
      bad.code === 1 && bad.out.includes('no chat found'),
      `${bad.code} ${bad.out}`
    );
    const utf = await shim(sh, ['send', ...`${cafeProject.name}/${d.name}`.split(' ')], `utf8 via ${sh}`);
    check(
      `15 (${sh}): a UTF-8 project address survives the header`,
      utf.code === 0 && Messages.listForAgent(d.id, 1).some((m) => m.content.startsWith(`utf8 via ${sh}`)),
      `${cafeProject.name}: ${utf.out}`
    );
    await waitFor(() => runningAgents(b.id).length === 0 && runningAgents(d.id).length === 0, 30_000);
  }
  const bodyArrived = Messages.listForAgent(b.id, 1).some((m) => m.content.startsWith('via the sh shim'));
  check('15: the shim delivers the stdin body intact', bodyArrived);
  const noEnv = await shim('sh', ['send', b.id], 'x', { ...shimEnv, MAESTRO_MESSAGE_WORKSPACE: '' });
  check(
    '15: with its env missing the shim fails instead of "succeeding"',
    noEnv.code === 1 && noEnv.out.includes('only works inside'),
    `${noEnv.code} ${noEnv.out}`
  );
  const doubleProject = await gitProject(path.join(ROOT, 'Two  Spaces'));
  const e = await workspace(doubleProject.id, 'claude-code');
  const spacedSend = await shim('sh', ['send', `${doubleProject.name}/${e.name}`], 'double spaced');
  check(
    '15: an address with repeated spaces survives the shim',
    spacedSend.code === 0 && Messages.listForAgent(e.id, 1).some((m) => m.content.startsWith('double spaced')),
    `${doubleProject.name}: ${spacedSend.out}`
  );
  await waitFor(() => runningAgents(e.id).length === 0, 30_000);

  // ---- 16. a blank first tab ----
  const fresh = await workspace(project.id, 'claude-code');
  Workspaces.patchChat(fresh.id, 2, { title: 'only chat two has meta' });
  const freshList = await cli(a, ['list']);
  // Names are unique per project only, so `list` may qualify it — use what it prints.
  const freshAddr = new RegExp(`^((?:\\S+/)?${fresh.name}) — `, 'm').exec(freshList.out)?.[1] ?? '';
  check(
    '16: chat 1 is listed even with meta only for chat 2',
    !!freshAddr && freshList.out.includes(`${freshAddr}#2 — `),
    freshList.out
  );
  const toBlank = await cli(a, ['send', freshAddr], 'Short ask');
  check(
    '16: …and its address reaches it',
    toBlank.code === 0 && Messages.listForAgent(fresh.id, 1).some((m) => m.content.startsWith('Short ask')),
    toBlank.out
  );
  await waitFor(() => runningAgents(fresh.id).length === 0, 30_000);
  const shortTitle = Workspaces.getChats(fresh.id)['1']?.title ?? '';
  const taskTitle = Workspaces.get(fresh.id)?.title ?? '';
  check('16: a short agent message titles the chat without the footer', shortTitle === 'Short ask', shortTitle);
  check('16: …and the workspace task title too', !taskTitle.includes('Sent by'), taskTitle);

  // ---- 17. the size limit includes the footer ----
  const big = await cli(a, ['send', b.id], 'x'.repeat(32 * 1024 - 20));
  check(
    '17: a message that only exceeds 32 KB with its footer is refused up front',
    big.code === 1 && big.out.includes('too large'),
    big.out.slice(0, 120)
  );

  // ---- 18. titles: linear, and robust to odd project names ----
  const t0 = Date.now();
  provisionalTitle(' '.repeat(1_000_000) + 'x' + ' \n'.repeat(200_000));
  const titleMs = Date.now() - t0;
  check('18: a 1 MB whitespace-heavy first message titles in linear time', titleMs < 200, `${titleMs}ms`);
  const odd = 'Weird "quoted] name';
  check(
    '18: a footer with quotes/brackets in the project is stripped',
    provisionalTitle(`Hi\n\n${agentMessageFooter(`${odd}/geneva-v1`, odd)}`) === 'Hi'
  );
  check(
    '18: ordinary text is never stripped',
    provisionalTitle('Fix [Sent by the agent in "x"] please') === 'Fix [Sent by the agent in "x"] please'
  );

  // ---- 19. multi-byte text across body chunks ----
  const cjk = '漢'.repeat(30_000); // ~90 KB of UTF-8: more than one loopback chunk
  userRow(b.id, 'reset');
  const long = await cli(a, ['send', b.id], cjk);
  const arrived =
    Messages.listForAgent(b.id, 1)
      .filter((m) => m.role === 'user')
      .pop()?.content ?? '';
  check(
    '19: a 30K-character CJK message is delivered intact',
    long.code === 0 && arrived.startsWith(cjk + '\n') && !arrived.includes('\uFFFD'),
    long.out
  );
  await waitFor(() => runningAgents(b.id).length === 0, 30_000);

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
