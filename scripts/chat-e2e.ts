/**
 * Chat/harness lifecycle verification (run under ELECTRON_RUN_AS_NODE).
 * Captures main→renderer broadcasts through a fake window and asserts:
 *  - a real Claude turn emits no chat:event after `done` (the stuck-"Thinking…" bug)
 *  - the persisted agent message arrives and the run fully clears
 *  - Stop kills a running agent and leaves clean state
 *  - cloning/creating from an empty base branch posts the explanatory system message
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { resolveShellEnv } from '../src/main/env';
import { initDb, Messages, Workspaces, now, uid } from '../src/main/db';
import { setWindow } from '../src/main/bus';
import { addProject, createWorkspace } from '../src/main/services/workspaces';
import { sendChat } from '../src/main/services/chat';
import { runningAgents, startAgent, stopAgent } from '../src/main/services/harness';
import type { ChatEventPayload, ChatMessage, Workspace } from '../src/shared/types';

const ROOT = '/tmp/maestro-chat-e2e';
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const events: { channel: string; payload: any }[] = [];
function captureWindow() {
  setWindow({
    on: () => {},
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: { send: (channel: string, payload: unknown) => events.push({ channel, payload }) },
  } as any);
}

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

function makeRepo(dir: string, opts: { empty: boolean }) {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -b main', { cwd: dir });
  if (opts.empty) {
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  } else {
    fs.writeFileSync(path.join(dir, 'README.md'), '# chat-e2e\n');
  }
  execSync('git add -A && git commit -q -m "Initial commit"', { cwd: dir });
}

async function provisionedWorkspace(projectId: string, harness: 'claude-code' | 'shell'): Promise<Workspace> {
  const ws = await createWorkspace({ projectId, harness });
  await waitFor(() => Workspaces.get(ws.id)?.status !== 'setting-up', 60_000, 'provision');
  return Workspaces.get(ws.id)!;
}

async function main() {
  resolveShellEnv();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.MAESTRO_HOME = path.join(ROOT, 'home');
  initDb(path.join(ROOT, 'maestro.db'));
  captureWindow();

  // --- setup: normal repo + workspace ---
  makeRepo(path.join(ROOT, 'repo'), { empty: false });
  const project = await addProject({ mode: 'local', path: path.join(ROOT, 'repo') });
  const ws = await provisionedWorkspace(project.id, 'claude-code');
  check('workspace ready', ws.status === 'idle', ws.status);

  // --- 1. real Claude turn: event order + cleanup + per-chat model/effort +
  //        no-permission-prompts (a Bash command must just run) ---
  events.length = 0;
  Workspaces.patchChat(ws.id, 1, { model: 'claude-haiku-4-5', effort: 'low' });
  const send = await sendChat({
    workspaceId: ws.id,
    agentId: 1,
    text: 'Use the Bash tool to run exactly `git log --oneline -1`, then reply with the word OK. Do not rename the branch.',
    attachments: [],
  });
  check('chat:send accepted', send.ok, send.error);
  const finished = await waitFor(
    () =>
      runningAgents(ws.id).length === 0 &&
      events.some((e) => e.channel === 'chat:message' && (e.payload as ChatMessage).role === 'agent'),
    180_000,
    'claude turn'
  );
  check('claude turn completed', finished);

  const chatEvents = events
    .map((e, i) => ({ ...e, i }))
    .filter((e) => e.channel === 'chat:event' && (e.payload as ChatEventPayload).agentId === 1);
  const doneIdx = chatEvents.findIndex((e) => (e.payload as ChatEventPayload).event.kind === 'done');
  check('done event emitted', doneIdx >= 0);
  const afterDone = chatEvents.slice(doneIdx + 1);
  check(
    'no chat:event after done (stuck-Thinking bug)',
    afterDone.length === 0,
    afterDone.map((e) => (e.payload as ChatEventPayload).event.kind).join(',') || 'clean'
  );
  const agentMsg = events.find((e) => e.channel === 'chat:message' && (e.payload as ChatMessage).role === 'agent');
  const blocks = agentMsg ? JSON.parse((agentMsg.payload as ChatMessage).content) : [];
  check('agent reply persisted', blocks.some((b: any) => b.type === 'text' && /OK/.test(b.text)));
  const toolBlock = blocks.find((b: any) => b.type === 'tool');
  check(
    'Bash ran without permission prompts',
    !!toolBlock && toolBlock.result?.ok === true && /Initial commit|chat-e2e/.test(toolBlock.result?.summary ?? ''),
    toolBlock ? `${toolBlock.name}: ${String(toolBlock.result?.summary ?? '').slice(0, 40)}` : 'no tool block'
  );
  check('no lingering run (zombie Stop)', runningAgents(ws.id).length === 0);
  const wsAfter = Workspaces.get(ws.id)!;
  check('status back to idle', wsAfter.status === 'idle', wsAfter.status);
  const sessionAfterDone = afterDone.some((e) => (e.payload as ChatEventPayload).event.kind === 'session');
  check('no trailing session event', !sessionAfterDone);

  // per-chat meta: model/effort accepted by the CLI, title + context tokens recorded
  const meta = Workspaces.getChats(ws.id)['1'] ?? {};
  check('chat title set from first message', (meta.title ?? '').startsWith('Use the Bash tool'), meta.title);
  const wsAfterTurn = Workspaces.get(ws.id)!;
  check('workspace title set from first prompt', !!wsAfterTurn.title, wsAfterTurn.title ?? 'null');
  check('workspace subtitle = last thing done', !!wsAfterTurn.subtitle, wsAfterTurn.subtitle ?? 'null');
  const doneEvent = chatEvents[doneIdx].payload as ChatEventPayload;
  check(
    'no permission denials (needsAttention unset)',
    doneEvent.event.kind === 'done' && !doneEvent.event.needsAttention
  );
  check(
    'context tokens recorded for usage ring',
    (meta.contextTokens ?? 0) > 1000,
    `${meta.contextTokens ?? 0} tokens`
  );
  const doneEvPayload = chatEvents[doneIdx].payload as ChatEventPayload;
  check(
    'done event carries contextTokens',
    doneEvPayload.event.kind === 'done' && (doneEvPayload.event.contextTokens ?? 0) > 0
  );

  // --- 2. Stop kills a running agent ---
  events.length = 0;
  const ws2 = await provisionedWorkspace(project.id, 'shell');
  const started = startAgent({ workspace: ws2, agentId: 1, prompt: 'echo started; sleep 60', systemPrompt: null });
  check('long-running agent started', started.ok, started.error);
  await waitFor(() => runningAgents(ws2.id).length === 1, 10_000, 'agent running');
  stopAgent(ws2.id, 1);
  const stopped = await waitFor(() => runningAgents(ws2.id).length === 0, 15_000, 'stop');
  check('stop kills the run', stopped);
  const doneEv = events.find(
    (e) =>
      e.channel === 'chat:event' &&
      (e.payload as ChatEventPayload).workspaceId === ws2.id &&
      (e.payload as ChatEventPayload).event.kind === 'done'
  );
  check('stop produces done event', !!doneEv);
  await waitFor(() => Workspaces.get(ws2.id)?.status === 'idle', 10_000, 'idle after stop');
  check('status idle after stop (not needs-attention)', Workspaces.get(ws2.id)!.status === 'idle');

  // --- 2b. queueing: a send during a run is queued and fires automatically after ---
  events.length = 0;
  const ws2b = await provisionedWorkspace(project.id, 'shell');
  const s1 = await sendChat({ workspaceId: ws2b.id, agentId: 1, text: 'echo FIRST && sleep 2', attachments: [] });
  check('first send starts immediately', s1.ok && !s1.queued);
  const s2 = await sendChat({ workspaceId: ws2b.id, agentId: 1, text: 'echo SECOND', attachments: [] });
  check('second send is queued (no error)', s2.ok === true && s2.queued === true, JSON.stringify(s2));
  const qEv = events.some((e) => e.channel === 'chat:queue' && (e.payload as any).items.length === 1);
  check('queue broadcast with pending item', qEv);
  await waitFor(
    () => runningAgents(ws2b.id).length === 0 && Messages.list(ws2b.id).filter((m) => m.role === 'agent').length >= 2,
    30_000,
    'queued turn to run'
  );
  const agentMsgs = Messages.list(ws2b.id).filter((m) => m.role === 'agent');
  check(
    'queued message ran after the first finished',
    agentMsgs.length === 2 && /FIRST/.test(agentMsgs[0].content) && /SECOND/.test(agentMsgs[1].content),
    `${agentMsgs.length} agent turns`
  );
  check(
    'queue drained broadcast',
    events.some((e) => e.channel === 'chat:queue' && (e.payload as any).items.length === 0)
  );

  // --- 2c. a web-queued message keeps its id when it drains (no ghost/dup) ---
  // Mirrors the web path: applyWebUserMessage inserts a queued placeholder keyed by
  // the relay's messageId, then the bridge calls sendChat with that same id. While a
  // turn runs the send is queued (preserving the id); when it drains the final user
  // row reuses the id — replacing the placeholder instead of duplicating it (§7.4).
  events.length = 0;
  const ws2c = await provisionedWorkspace(project.id, 'shell');
  const webId = uid();
  const webTurn = uid();
  await sendChat({ workspaceId: ws2c.id, agentId: 1, text: 'echo LEAD && sleep 2', attachments: [] });
  // The placeholder the relay's message-queued event would have inserted.
  Messages.insert({ id: webId, workspaceId: ws2c.id, agentId: 1, role: 'user', content: 'echo WEBQ', attachments: [], ts: now(), meta: { queued: true, origin: 'web' } });
  const sWeb = await sendChat({ workspaceId: ws2c.id, agentId: 1, text: 'echo WEBQ', id: webId, turnId: webTurn, origin: 'web' });
  check('web-origin send queued behind the running turn', sWeb.ok === true && sWeb.queued === true, JSON.stringify(sWeb));
  await waitFor(
    () => runningAgents(ws2c.id).length === 0 && Messages.list(ws2c.id).filter((m) => m.role === 'agent').length >= 2,
    30_000,
    'web-queued turn to run'
  );
  const webUserRows = Messages.list(ws2c.id).filter((m) => m.role === 'user' && m.id === webId);
  check('web-queued user row keeps its id (no duplicate)', webUserRows.length === 1, `${webUserRows.length} rows with id`);
  check('drained web-queued row is no longer marked queued', webUserRows[0] && !webUserRows[0].meta?.queued, JSON.stringify(webUserRows[0]?.meta));
  check('web-queued row keeps origin web', webUserRows[0]?.meta?.origin === 'web', JSON.stringify(webUserRows[0]?.meta));

  // --- 3. empty base branch → explanatory system message ---
  makeRepo(path.join(ROOT, 'empty-repo'), { empty: true });
  const emptyProject = await addProject({ mode: 'local', path: path.join(ROOT, 'empty-repo') });
  events.length = 0;
  const ws3 = await provisionedWorkspace(emptyProject.id, 'shell');
  const sysMsg = events.find(
    (e) =>
      e.channel === 'chat:message' &&
      (e.payload as ChatMessage).workspaceId === ws3.id &&
      (e.payload as ChatMessage).role === 'system'
  );
  check(
    'empty-base workspace posts guidance',
    !!sysMsg && /has no files/.test((sysMsg!.payload as ChatMessage).content),
    sysMsg ? (sysMsg.payload as ChatMessage).content.slice(0, 60) + '…' : 'missing'
  );

  console.log(failures === 0 ? 'CHAT_E2E_ALL_PASS' : `E2E_FAILURES=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('CHAT_E2E_CRASH', e);
  process.exit(1);
});
