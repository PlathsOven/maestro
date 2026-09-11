/**
 * Desktop account-service verification (mobile-web-app spec §10 "Desktop e2e").
 * Exercises `src/main/services/account.ts` against a MOCK relay (plain
 * `node:http`) under a temp DB — no Electron window, no real relay. Runs under
 * plain node (native modules built for node), like cloud-e2e. Asserts:
 *   - device link flow (start → poll → token stored → linked)
 *   - conversation publish: metadata PUT + backfill payload shape (turns[]/userMessages[])
 *   - pullSync applies a web-originated user message keyed by messageId, idempotently
 *   - pullSync applies web read-state (LWW)
 *   - box link mints a token, writes sync.url/sync.token, records the box
 *
 *   npx esbuild scripts/account-e2e.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:better-sqlite3 --external:node-pty \
 *     --external:electron-updater --external:ssh2 --external:cpu-features \
 *     --outfile=dist/account-e2e.cjs && node dist/account-e2e.cjs
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.join(os.tmpdir(), `maestro-account-e2e-${process.pid}`);
const BOX_HOME = path.join(ROOT, 'box-home');
const REPO = path.join(ROOT, 'repo');

let PORT = 0;
process.env.MAESTRO_HOME = path.join(ROOT, 'local');

// Mock relay must be reachable before account.ts resolves relayUrl(); set later too.
import { resolveShellEnv } from '../src/main/env';
import { initDb, Hosts, Messages, Settings, Workspaces, now, uid } from '../src/main/db';
import { setWindow } from '../src/main/bus';
import { setSshHostFactory, localHost } from '../src/main/hosts';
import { addProject, createWorkspace } from '../src/main/services/workspaces';
import * as account from '../src/main/services/account';
import type { ExecHost } from '../src/main/hosts/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

// ---- mock relay ----
const captured = { put: [] as any[], backfill: [] as any[], readState: [] as any[], boxes: [] as any[], workspaces: [] as any[], deleted: [] as string[] };
let approveNow = false;
let syncEvents: any[] = [];

function fakeBoxHost(id = 'testbox'): ExecHost {
  return {
    id,
    platform: 'linux',
    path: path.posix,
    exec: (cmd, args, opts = {}) => {
      // The reboot-cron install shells out to the real `crontab` (which ignores
      // HOME and is keyed by the OS user), so intercept it — a test must never
      // touch the developer's actual crontab. Everything else runs for real.
      if (args?.some((a) => typeof a === 'string' && a.includes('crontab'))) {
        return Promise.resolve({ ok: true, stdout: '', stderr: '', exitCode: 0 });
      }
      return localHost.exec(cmd, args, { ...opts, env: { ...opts.env, HOME: BOX_HOME } });
    },
    spawnStream: (cmd, args, opts) => localHost.spawnStream(cmd, args, opts),
    pty: (o) => localHost.pty(o),
    fs: localHost.fs,
    watch: (r, cb) => localHost.watch(r, cb),
    refreshEnv: () => {},
    connect: async () => {},
    dispose: () => {},
    forwardLoopback: undefined,
  };
}

function startMock(): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
    const url = (req.url ?? '').split('?')[0];
    const send = (obj: any, code = 200) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    if (url === '/api/link/start') return send({ code: 'ABCD2345', pollToken: 'ptoken-1', expiresInSec: 900 });
    if (url === '/api/link/poll') return send(approveNow ? { status: 'approved', apiToken: 'dev-token-xyz', user: { login: 'tester' } } : { status: 'pending' });
    if (req.method === 'PUT' && url.startsWith('/api/conversations/')) {
      captured.put.push({ id: decodeURIComponent(url.split('/')[3]), body });
      return send({ ok: true });
    }
    if (req.method === 'PUT' && url.startsWith('/api/workspaces/')) {
      captured.workspaces.push({ id: decodeURIComponent(url.split('/')[3]), body });
      return send({ ok: true });
    }
    if (req.method === 'DELETE' && url.startsWith('/api/workspaces/')) {
      captured.deleted.push(decodeURIComponent(url.split('/')[3]));
      return send({ ok: true });
    }
    if (req.method === 'POST' && url.endsWith('/backfill')) {
      captured.backfill.push({ id: decodeURIComponent(url.split('/')[3]), body });
      return send({ ok: true });
    }
    if (url === '/api/sync') {
      const cursor = Number(new URL(req.url!, 'http://x').searchParams.get('cursor') || '0');
      const evs = syncEvents.filter((e) => e.seq > cursor);
      return send({ events: evs, next: evs.length ? evs[evs.length - 1].seq : cursor });
    }
    if (url === '/api/read-state') {
      captured.readState.push(body);
      return send({ ok: true });
    }
    if (req.method === 'POST' && url === '/api/boxes') {
      captured.boxes.push(body);
      return send({ boxId: 'box-X', boxToken: 'box-token-123' });
    }
    if (req.method === 'DELETE' && url.startsWith('/api/boxes/')) return send({ ok: true });
    send({ error: 'not found' }, 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(BOX_HOME, { recursive: true });
  fs.mkdirSync(REPO, { recursive: true });
  resolveShellEnv();

  const server = await startMock();
  PORT = (server.address() as any).port;
  process.env.MAESTRO_RELAY_URL = `http://127.0.0.1:${PORT}`;

  initDb(path.join(ROOT, 'db.sqlite'));
  setWindow({ isDestroyed: () => false, isFocused: () => true, webContents: { send: () => {} } } as any);
  Settings.setGlobal({ notifications: false });
  setSshHostFactory((hostId) => (hostId === 'testbox' || hostId === 'testbox2' ? fakeBoxHost(hostId) : null));

  execSync('git init -b main && git config user.email e2e@maestro.local && git config user.name "Maestro E2E" && git remote add origin https://github.com/maestro-e2e/repo.git && git add -A && git commit -q --allow-empty -m init', { cwd: REPO });
  const project = await addProject({ mode: 'local', path: REPO });
  const ws = await createWorkspace({ projectId: project.id, harness: 'claude-code' });
  await waitFor(() => Workspaces.get(ws.id)?.status !== 'setting-up', 30_000, 'provision');
  Workspaces.patchChat(ws.id, 1, { titleCustom: true, title: 'account test' });
  Workspaces.setCloudHost(ws.id, 'testbox');
  const convId = `${ws.id}:1`;

  // ---- Test 1: device link flow ----
  check('not linked initially', account.isLinked() === false);
  approveNow = true; // mock approves on the first poll
  const link = await account.startLink('Test Desktop');
  check('link start returns code + url', link.code === 'ABCD2345' && link.url.includes('/link'), JSON.stringify(link));
  const linked = await waitFor(() => account.isLinked(), 10_000, 'device link approval');
  check('device linked after approval (token stored)', linked);
  const status = await account.accountStatus();
  check('status reflects linked user', status.linked && status.user?.login === 'tester', JSON.stringify(status.user));

  // ---- Test 2: publish metadata + backfill payload shape ----
  // Link approval fired an unawaited publishAll() whose PUT — computed before the
  // turn below exists — carries hasRun:false. Let that initial publish land, then
  // clear captures so the assertions below see only the post-seed publish;
  // otherwise the stale PUT can race past the explicit publishConversation and
  // fail the .pop()-based check.
  await waitFor(() => captured.put.some((p) => p.id === convId), 10_000, 'initial publish after link');
  captured.put.length = 0;
  captured.backfill.length = 0;
  // Seed one user message + one agent turn locally.
  const turnId = uid();
  Messages.insert({ id: uid(), workspaceId: ws.id, agentId: 1, role: 'user', content: 'do the thing', attachments: [], ts: now() });
  Messages.insert({
    id: turnId,
    workspaceId: ws.id,
    agentId: 1,
    role: 'agent',
    content: JSON.stringify([{ type: 'text', text: 'done the thing' }]),
    attachments: [],
    ts: now(),
    meta: { costUsd: 0.03, durationMs: 42 },
  });
  await account.publishConversation(Workspaces.get(ws.id)!, 1);
  check('metadata PUT sent', captured.put.some((p) => p.id === convId), JSON.stringify(captured.put.map((p) => p.id)));
  // The latest PUT (after seeding the turn) — an earlier one fired on link before
  // any turn existed, so hasRun was legitimately false then.
  const meta = captured.put.filter((p) => p.id === convId).pop()?.body;
  check('metadata carries harness + hasRun', meta?.harness === 'claude-code' && meta?.hasRun === true, JSON.stringify(meta));
  const bf = captured.backfill.find((b) => b.id === convId)?.body;
  check('backfill has the agent turn (blocks)', !!bf && bf.turns.length === 1 && bf.turns[0].id === turnId, JSON.stringify(bf?.turns));
  check('backfill turn carries blocks', !!bf && bf.turns[0].blocks?.[0]?.text === 'done the thing');
  check('backfill has the user message', !!bf && bf.userMessages.length === 1 && bf.userMessages[0].origin === 'desktop');

  // ---- Test 2b: workspace publish carries the resolved GitHub owner ----
  // The web sidebar renders the repo avatar from repoOwner (parity with the
  // desktop's projectOwners cache); it must be the origin's owner, not null.
  Settings.setRaw(`account.wsfp.${ws.id}`, 'stale'); // force past the fingerprint gate
  await account.publishWorkspace(Workspaces.get(ws.id)!);
  const wsPut = captured.workspaces.filter((w) => w.id === ws.id).pop()?.body;
  check('workspace publish carries repoOwner from git origin', wsPut?.repoOwner === 'maestro-e2e', JSON.stringify({ repoOwner: wsPut?.repoOwner }));

  // ---- Test 2c: project sync selection (deselect purges, re-select republishes) ----
  // Deselecting a project stops publishing its workspaces AND deletes any already-
  // synced rows from the relay, so it disappears from the web (default: all sync).
  captured.deleted.length = 0;
  await account.setProjectSync(project.id, false);
  check('deselect purges the project workspace from the relay', captured.deleted.includes(ws.id), JSON.stringify(captured.deleted));
  check('deselected project recorded as opted out', (await account.accountStatus()).projectOptOut.includes(project.id));
  // A publish attempt for a deselected workspace is a no-op — nothing reaches the relay.
  captured.workspaces.length = 0;
  captured.put.length = 0;
  Settings.setRaw(`account.wsfp.${ws.id}`, 'stale'); // even past the fingerprint gate
  await account.publishWorkspace(Workspaces.get(ws.id)!);
  await account.publishConversation(Workspaces.get(ws.id)!, 1);
  check('deselected workspace is not published', captured.workspaces.length === 0 && captured.put.length === 0, `ws=${captured.workspaces.length} conv=${captured.put.length}`);
  // Re-selecting republishes the workspace + its conversation.
  captured.workspaces.length = 0;
  captured.put.length = 0;
  await account.setProjectSync(project.id, true);
  check('re-select republishes the workspace', captured.workspaces.some((w) => w.id === ws.id), JSON.stringify(captured.workspaces.map((w) => w.id)));
  check('re-select republishes the conversation', captured.put.some((p) => p.id === convId), JSON.stringify(captured.put.map((p) => p.id)));
  check('re-selected project no longer opted out', !(await account.accountStatus()).projectOptOut.includes(project.id));

  // ---- Test 2d: a fresh link re-publishes EVERY workspace + its history, not
  // just the churning one. The publish fingerprints (account.wsfp.* / account.fp.*)
  // describe what the *previous* relay already had; a re-link to a different
  // account — or to one reset from the web — must forget them. Otherwise
  // publishWorkspace() skips every workspace whose state hasn't changed (the
  // sidebar shows only the inflight one) and the backfill never re-fires (rows
  // come back with empty transcripts). (Test 2c left the project opted back in.)
  const ws2 = await createWorkspace({ projectId: project.id, harness: 'claude-code' });
  await waitFor(() => Workspaces.get(ws2.id)?.status !== 'setting-up', 30_000, 'provision ws2');
  // Prime both fingerprints (ws was primed in Test 2b; ws2 is new).
  await account.publishWorkspace(Workspaces.get(ws.id)!);
  await account.publishWorkspace(Workspaces.get(ws2.id)!);
  captured.workspaces.length = 0;
  // With both fingerprints current, a plain re-publish is gated out entirely.
  await account.publishWorkspace(Workspaces.get(ws.id)!);
  await account.publishWorkspace(Workspaces.get(ws2.id)!);
  check('publish fingerprint gate skips unchanged workspaces', captured.workspaces.length === 0, `saw ${captured.workspaces.length}`);
  // A fresh link must forget those fingerprints and re-push every workspace + the
  // conversation history (ws carries the turn seeded in Test 2).
  captured.workspaces.length = 0;
  captured.backfill.length = 0;
  await account.signOut();
  approveNow = true;
  await account.startLink('Relinked Desktop');
  await waitFor(() => account.isLinked(), 10_000, 're-link approval');
  const republished = await waitFor(() => {
    const ids = new Set(captured.workspaces.map((w) => w.id));
    return ids.has(ws.id) && ids.has(ws2.id);
  }, 10_000, 're-link full republish');
  check('re-link re-publishes every workspace (not just the inflight one)', republished, JSON.stringify(captured.workspaces.map((w) => w.id)));
  const backfilled = await waitFor(() => captured.backfill.some((b) => b.id === convId), 10_000, 're-link history backfill');
  check('re-link re-backfills conversation history (not just empty rows)', backfilled, JSON.stringify(captured.backfill.map((b) => b.id)));

  // ---- Test 2e: resyncAll() (the "Re-sync all" button) forgets the fingerprints
  // and re-pushes the whole fleet even though they're all current after 2d's
  // relink — a plain publishAll would be a gated no-op — and reports the count.
  captured.workspaces.length = 0;
  const rs = await account.resyncAll();
  // resyncAll reports the fleet size synchronously but re-pushes in the background
  // (so the relay's resync job acks at once instead of after a minutes-long push),
  // so wait for the workspace rows to stream up rather than reading them inline.
  const rsPushed = await waitFor(() => {
    const ids = new Set(captured.workspaces.map((w) => w.id));
    return ids.has(ws.id) && ids.has(ws2.id);
  }, 10_000, 'resyncAll background republish');
  check('resyncAll re-pushes every workspace', rsPushed, JSON.stringify(captured.workspaces.map((w) => w.id)));
  check('resyncAll reports the workspace count', rs.workspaces === 2, JSON.stringify(rs));

  // ---- Test 3: pullSync applies a web-originated user message (idempotent) ----
  const webMsgId = uid();
  const webTurnId = uid();
  syncEvents = [
    { seq: 1, kind: 'message-queued', conversationId: convId, payload: { messageId: webMsgId, turnId: webTurnId, text: 'sent from my phone', origin: 'web' } },
  ];
  await account.pullSync();
  check('web user message inserted locally by id', Messages.exists(webMsgId));
  const before = Messages.list(ws.id).length;
  // Re-serve the same event from cursor 0 by resetting cursor; must not duplicate.
  Settings.setRaw('account.syncCursor', '0');
  await account.pullSync();
  check('pullSync idempotent (no duplicate web message)', Messages.list(ws.id).length === before, `${before} vs ${Messages.list(ws.id).length}`);

  // ---- Test 4: pullSync applies web read-state (LWW) ----
  const readTs = now() + 5000;
  syncEvents = [{ seq: 2, kind: 'read-state', conversationId: convId, payload: { lastReadAt: readTs } }];
  Settings.setRaw('account.syncCursor', '1');
  await account.pullSync();
  check('web read-state advanced local lastReadAt', (Workspaces.getChats(ws.id)['1']?.lastReadAt ?? 0) === readTs);

  // ---- Test 5: box link writes sync files + records the box ----
  const bl = await account.linkBox('testbox', 'my mini-pc');
  check('box link succeeded', bl.ok, bl.error ?? '');
  check('relay minted a box token (POST /api/boxes)', captured.boxes.length === 1);
  const syncUrl = path.join(BOX_HOME, '.maestro', 'sync.url');
  const syncTok = path.join(BOX_HOME, '.maestro', 'sync.token');
  check('sync.url written to the box', fs.existsSync(syncUrl) && fs.readFileSync(syncUrl, 'utf8').includes(String(PORT)));
  check('sync.token written to the box', fs.existsSync(syncTok) && fs.readFileSync(syncTok, 'utf8') === 'box-token-123');
  // Linking installs the drain worker too, not just the sync listener — so the
  // box can run the web jobs sync stages (no "accepts work it can't run" hole).
  const drainShim = path.join(BOX_HOME, '.maestro', 'bin', 'maestro-drain');
  check('box link installs the maestro-drain worker', fs.existsSync(drainShim));
  check('box recorded in settings + linked-for-host', account.boxLinkedForHost('testbox'), 'boxLinkedForHost');
  const st2 = await account.accountStatus();
  check('status lists the linked box', !!st2.boxes['testbox']?.boxId, JSON.stringify(st2.boxes));

  // ---- Test 5b: autoLinkBoxes links saved SSH hosts by default ----
  // A saved host that was never linked should get box-linked automatically.
  Hosts.upsert({ id: 'testbox2', label: 'auto host', host: '10.0.0.9', port: 22, user: 'me', auth: 'agent' } as any);
  const boxesBefore = captured.boxes.length;
  await account.autoLinkBoxes();
  check('autoLinkBoxes linked the saved host by default', account.boxLinkedForHost('testbox2'));
  check('autoLinkBoxes minted a token for it (POST /api/boxes)', captured.boxes.length === boxesBefore + 1, `${boxesBefore} -> ${captured.boxes.length}`);

  // ---- Test 5c: a manual unlink is remembered; autoLinkBoxes respects it ----
  await account.unlinkBox('testbox2');
  check('unlink cleared the box link', account.boxLinkedForHost('testbox2') === false);
  const boxesAfterUnlink = captured.boxes.length;
  await account.autoLinkBoxes();
  check('autoLinkBoxes does NOT re-link an opted-out host', account.boxLinkedForHost('testbox2') === false);
  check('no new box minted for the opted-out host', captured.boxes.length === boxesAfterUnlink, `${boxesAfterUnlink} -> ${captured.boxes.length}`);

  // ---- Test 5d: re-linking clears the opt-out ----
  const rl = await account.linkBox('testbox2', 'auto host');
  check('manual re-link succeeds and clears the opt-out', rl.ok && account.boxLinkedForHost('testbox2'), rl.error ?? '');

  // ---- Test 6: sign out clears the token ----
  await account.signOut();
  check('sign out unlinks the device', account.isLinked() === false);

  account.stopAccountSync();
  server.close();
  try {
    execSync('pkill -f maestro-sync 2>/dev/null; true');
  } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(failures ? `\n${failures} ACCOUNT E2E FAILURE(S)` : '\nALL ACCOUNT E2E CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('ACCOUNT_E2E_FAIL', e);
  process.exit(1);
});
