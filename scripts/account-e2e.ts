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
 *   - incremental backfill: only the new turn goes up, with a full resend whenever
 *     the mark can't be trusted (perf-cpu-ram §6.2)
 *   - todos/comments/run-scripts are fingerprint-gated; `chat:event` is not a
 *     publish trigger
 *   - the Neon diet (web-neon-usage-diet): usage rides the settings row and not
 *     every conversation, archiving deletes the workspace from the relay (and
 *     un-archiving republishes it), embedded images upload once per content hash
 *   - the live-turn delta protocol: negotiation, base regression, 409 resync,
 *     ordering, terminal snapshot, and the old-relay fallback
 *   - agent messaging over the relay: remote list/send with the device token,
 *     unambiguous reply addresses, a 401 that doesn't unlink, and the relay
 *     `message` job's loop guard (docs/specs/agent-messaging.md)
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
import { initDb, Hosts, Messages, Queued, Settings, Todos, Workspaces, now, uid } from '../src/main/db';
import { broadcast, setWindow } from '../src/main/bus';
import { setSshHostFactory, localHost } from '../src/main/hosts';
import { addProject, createWorkspace } from '../src/main/services/workspaces';
import * as account from '../src/main/services/account';
import { adapters, runningAgents } from '../src/main/services/harness';
import { SYNC_HASH } from '../src/main/services/cloudsync';
import { relayMode, startBridge, stopBridge } from '../src/main/services/bridge';
import { applyBlockEvent, newBlockStream, snapshotBlocks } from '../src/shared/harness';
import type { ExecHost } from '../src/main/hosts/types';
import type { AgentEvent, PrCheck, PrStatus } from '../src/shared/types';

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
const captured = { put: [] as any[], backfill: [] as any[], readState: [] as any[], boxes: [] as any[], workspaces: [] as any[], git: [] as any[], turns: [] as any[], deltas: [] as any[], deleted: [] as string[], settings: [] as any[], devicesDeleted: [] as string[], attachments: [] as any[] };
let approveNow = false;
/** Flip on to make the whole mock relay answer 5xx (the "database suspended"
 *  shape) — drives the circuit-breaker assertions (§B2). */
let relayFail = false;
/** Device-poll protocol v2 (web-relay-event-bus §4.3): `null` answers like a
 *  relay that predates it, so the desktop falls back to the old streaming. */
let pollWatch: boolean | null = false;
let pollIdleWait = 1;
const polls: string[] = [];
/** Set to make the next delta POST answer 409 with this expected seq. */
let delta409: number | null = null;
let syncEvents: any[] = [];
// The relay's device fleet the desktop's accountStatus() lists (source of truth).
let relayDevices: any[] = [];
/** The live box ids GET /api/devices reports; null plays a relay that predates the field. */
let relayBoxes: string[] | null = null;
/** Agent messaging: jobs the next device poll hands out, their done reports,
 *  the fleet GET /api/workspaces serves (and its status), and captured sends. */
let pendingJobs: any[] = [];
const jobsDone: { id: string; body: any }[] = [];
let relayFleet: any = { devices: [], workspaces: [], sessions: [] };
let fleetStatus = 200;
let fleetReads = 0;
let sendStatus = 200;
const sends: { id: string; body: any; auth: string | undefined }[] = [];

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
      // Still record what was asked for — the breaker tests assert that a failing
      // publish was ATTEMPTED once and then that nothing else reaches the wire.
      res.statusCode = relayFail ? 500 : code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(relayFail ? { error: 'database unavailable' } : obj));
    };
    if (url === '/api/link/start') return send({ code: 'ABCD2345', pollToken: 'ptoken-1', expiresInSec: 900 });
    if (url === '/api/link/poll') return send(approveNow ? { status: 'approved', apiToken: 'dev-token-xyz', user: { login: 'tester' } } : { status: 'pending' });
    if (req.method === 'PUT' && url === '/api/settings') {
      captured.settings.push(body);
      return send({ ok: true });
    }
    if (url === '/api/device/poll') {
      polls.push(new URL(req.url!, 'http://x').searchParams.get('wait') ?? '');
      // Answer like a real long-poll would, so a live loop doesn't spin hot.
      await new Promise((r) => setTimeout(r, 150));
      return send({ jobs: pendingJobs.splice(0), events: [], next: 0, ...(pollWatch === null ? {} : { watch: pollWatch, idleWait: pollIdleWait }) });
    }
    if (req.method === 'POST' && url.startsWith('/api/device/jobs/') && url.endsWith('/done')) {
      jobsDone.push({ id: decodeURIComponent(url.split('/')[4]), body });
      return send({ ok: true });
    }
    if (req.method === 'GET' && url === '/api/workspaces') {
      fleetReads++;
      return fleetStatus === 200 ? send(relayFleet) : send({ error: 'sign in' }, fleetStatus);
    }
    if (req.method === 'POST' && url.startsWith('/api/conversations/') && url.endsWith('/send')) {
      if (sendStatus !== 200) return send({ error: 'gone' }, sendStatus);
      sends.push({ id: decodeURIComponent(url.split('/')[3]), body, auth: req.headers.authorization });
      return send({ messageId: 'm-sent', turnId: 't-sent', delivered: true, routedTo: 'device' });
    }
    if (req.method === 'POST' && url.endsWith('/deltas')) {
      if (delta409 != null) {
        const expected = delta409;
        delta409 = null;
        return send({ expected }, 409);
      }
      captured.deltas.push(body);
      return send({ next: (body.seq ?? 0) + 1 });
    }
    if (req.method === 'PUT' && url.endsWith('/turn')) {
      captured.turns.push({ id: decodeURIComponent(url.split('/')[3]), body });
      return send({ ok: true });
    }
    if (req.method === 'PUT' && url.startsWith('/api/conversations/')) {
      captured.put.push({ id: decodeURIComponent(url.split('/')[3]), body });
      return send({ ok: true });
    }
    if (req.method === 'PUT' && url.endsWith('/git') && url.startsWith('/api/workspaces/')) {
      captured.git.push({ id: decodeURIComponent(url.split('/')[3]), body });
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
    if (req.method === 'POST' && url === '/api/attachments') {
      // The real relay dedupes by sha256 of the data URL and answers with the
      // existing row (web-neon-usage-diet §3.6); the desktop's own content cache
      // means it should not get that far twice for the same bytes.
      captured.attachments.push(body);
      return send({ id: 'att-1', url: '/api/attachments/att-1' });
    }
    if (req.method === 'POST' && url === '/api/boxes') {
      captured.boxes.push(body);
      return send({ boxId: 'box-X', boxToken: 'box-token-123' });
    }
    if (req.method === 'DELETE' && url.startsWith('/api/boxes/')) return send({ ok: true });
    if (req.method === 'GET' && url === '/api/devices') return send({ devices: relayDevices, ...(relayBoxes ? { boxes: relayBoxes } : {}) });
    if (req.method === 'DELETE' && url.startsWith('/api/devices/')) {
      const id = decodeURIComponent(url.split('/')[3]);
      captured.devicesDeleted.push(id);
      relayDevices = relayDevices.filter((d) => d.id !== id);
      return send({ ok: true });
    }
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
  // Deterministic subscription usage — the real adapter reads the user's Claude
  // credentials. The percent is deliberately fractional: what the desktop
  // publishes must be a whole number (web-neon-usage-diet §3.2), since it is an
  // unrounded float that used to re-publish the whole fleet every five minutes.
  adapters['claude-code'].fetchUsage = async () => ({ plan: 'max', windows: [{ id: 'session', label: '5h limit', pct: 12.7 }] });
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

  // ---- Test 1b: accountStatus lists EVERY linked desktop from the relay ----
  // The desktop shows the whole fleet (relay is the source of truth), not just this
  // machine — and marks itself so the UI can label it and route its own removal to
  // sign-out rather than unlink.
  relayDevices = [
    { id: 'dev-self', name: 'Test Desktop', platform: 'darwin', lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString(), current: true },
    { id: 'dev-other', name: 'Studio', platform: 'linux', lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString(), current: false },
  ];
  const st1b = await account.accountStatus();
  check('status lists every linked desktop', st1b.devices.length === 2 && st1b.devices.some((d) => d.id === 'dev-other'), JSON.stringify(st1b.devices.map((d) => d.id)));
  check('status marks the current desktop', st1b.devices.find((d) => d.id === 'dev-self')?.current === true);

  // ---- Test 1c: unlinkDevice revokes a SIBLING on the relay (not self) ----
  const ul = await account.unlinkDevice('dev-other');
  check('unlinkDevice succeeds', ul.ok, ul.error ?? '');
  check('unlinkDevice DELETEs the right device', captured.devicesDeleted.includes('dev-other'), JSON.stringify(captured.devicesDeleted));
  check('unlinked sibling drops out of the fleet', (await account.accountStatus()).devices.every((d) => d.id !== 'dev-other'));
  check('unlinkDevice left this desktop linked', account.isLinked() === true);

  // ---- Test 1d: settings-sync — the initial publish mirrors the new-conversation
  // defaults, a later change re-pushes, and an unchanged blob is fingerprint-gated. ----
  const gotInitialSettings = await waitFor(() => captured.settings.length >= 1, 10_000, 'initial settings mirror after link');
  check('link mirrors new-conversation defaults to the relay', gotInitialSettings, JSON.stringify(captured.settings[0]));
  check(
    'mirrored settings carry harness + model map + effort',
    !!captured.settings[0]?.defaultHarness && !!captured.settings[0]?.defaultModels && typeof captured.settings[0]?.defaultEffort === 'string',
    JSON.stringify(captured.settings[0])
  );
  check(
    'mirrored settings carry the theme (Classic by default)',
    captured.settings[0]?.colorTheme === 'classic' && typeof captured.settings[0]?.theme === 'string',
    JSON.stringify(captured.settings[0])
  );
  captured.settings.length = 0;
  Settings.setGlobal({ colorTheme: 'nord' });
  await account.publishSettings();
  check('a theme change re-pushes the mirror', captured.settings.length === 1 && captured.settings[0]?.colorTheme === 'nord', JSON.stringify(captured.settings));
  captured.settings.length = 0;
  Settings.setGlobal({ defaultEffort: 'low' });
  await account.publishSettings();
  check('a changed default re-pushes the mirror', captured.settings.length === 1 && captured.settings[0]?.defaultEffort === 'low', JSON.stringify(captured.settings));
  await account.publishSettings();
  check('an unchanged mirror is fingerprint-gated (no re-push)', captured.settings.length === 1, `${captured.settings.length}`);

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

  // ---- Test 2a: the persisted queue is published to the web (§7.4) ----
  // A desktop-queued message (queued_messages only, no Messages row) must surface
  // on the web; a web-queued message has a Messages placeholder sharing its id, so
  // it must appear exactly once (the placeholder is deduped, the queue row wins).
  captured.backfill.length = 0;
  const deskQ = uid();
  const webQ = uid();
  Queued.insert({ id: deskQ, workspaceId: ws.id, agentId: 1, turnId: uid(), text: 'queued on desktop', attachments: [], seq: 1, createdAt: now() });
  Queued.insert({ id: webQ, workspaceId: ws.id, agentId: 1, turnId: uid(), text: 'queued from web', attachments: [], origin: 'web', seq: 2, createdAt: now() });
  // The web placeholder Messages row that applyWebUserMessage inserts, same id.
  Messages.insert({ id: webQ, workspaceId: ws.id, agentId: 1, role: 'user', content: 'queued from web', attachments: [], ts: now(), meta: { queued: true, origin: 'web' } });
  await account.publishConversation(Workspaces.get(ws.id)!, 1);
  const bfQ = captured.backfill.filter((b) => b.id === convId).pop()?.body;
  const deskItem = bfQ?.userMessages.find((m: any) => m.id === deskQ);
  const webItems = bfQ?.userMessages.filter((m: any) => m.id === webQ) ?? [];
  check('desktop-queued message published as queued', !!deskItem && deskItem.queued === true && deskItem.origin === 'desktop', JSON.stringify(deskItem));
  check('web-queued message published once (placeholder deduped)', webItems.length === 1 && webItems[0].queued === true && webItems[0].origin === 'web', JSON.stringify(webItems));
  // Drain them so later tests see a clean queue.
  Queued.remove(deskQ);
  Queued.remove(webQ);
  Messages.remove(webQ);

  // ---- Test 2b: workspace publish carries the resolved GitHub owner ----
  // The web sidebar renders the repo avatar from repoOwner (parity with the
  // desktop's projectOwners cache); it must be the origin's owner, not null.
  Settings.setRaw(`account.wsfp.${ws.id}`, 'stale'); // force past the fingerprint gate
  await account.publishWorkspace(Workspaces.get(ws.id)!);
  const wsPut = captured.workspaces.filter((w) => w.id === ws.id).pop()?.body;
  check('workspace publish carries repoOwner from git origin', wsPut?.repoOwner === 'maestro-e2e', JSON.stringify({ repoOwner: wsPut?.repoOwner }));

  // ---- Test 2b′: PR-status detail mapping (drives web's Merge vs Resolve-conflicts) ----
  // The web shows the "Resolve conflicts" button only when the published row says
  // prMergeable === 'conflict'. Before this, publishWorkspace never sent mergeable,
  // so the button never appeared and a conflicted PR advertised itself as mergeable.
  const prOf = (over: Partial<PrStatus>): PrStatus => ({
    number: 7, title: 'A PR', url: 'https://github.com/x/y/pull/7', state: 'OPEN',
    isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', baseRefName: 'main',
    headRefName: 'feat', additions: 1, deletions: 0, checks: [], comments: [], deployments: [],
    ...over,
  });
  const chk = (state: PrCheck['state']): PrCheck => ({ name: `c-${state}`, state, link: null, description: null });
  check('no PR → all detail null', account.mapPrDetail(null).prMergeable === null && account.mapPrDetail(undefined).prChecks === null);
  check("CONFLICTING → prMergeable 'conflict'", account.mapPrDetail(prOf({ mergeable: 'CONFLICTING' })).prMergeable === 'conflict');
  check("MERGEABLE → prMergeable 'clean'", account.mapPrDetail(prOf({ mergeable: 'MERGEABLE' })).prMergeable === 'clean');
  check("UNKNOWN/null → prMergeable 'unknown' (attempt is the backstop)", account.mapPrDetail(prOf({ mergeable: null })).prMergeable === 'unknown');
  check('no checks → prChecks null (reads green)', account.mapPrDetail(prOf({ checks: [] })).prChecks === null);
  check("a red check → prChecks 'fail' (fail beats pending)", account.mapPrDetail(prOf({ checks: [chk('pass'), chk('pending'), chk('fail')] })).prChecks === 'fail');
  check("a running check → prChecks 'pending'", account.mapPrDetail(prOf({ checks: [chk('pass'), chk('pending')] })).prChecks === 'pending');
  check("all green (incl skipped/neutral) → prChecks 'pass'", account.mapPrDetail(prOf({ checks: [chk('pass'), chk('skipped'), chk('neutral')] })).prChecks === 'pass');
  const mapped = account.mapPrDetail(prOf({ isDraft: true, reviewDecision: 'APPROVED', title: 'T', checks: [chk('pass')] }));
  check('detail carries draft/review/title + checksList', mapped.prDraft === true && mapped.prReview === 'APPROVED' && mapped.prTitle === 'T' && mapped.prChecksList?.length === 1 && mapped.prChecksList?.[0].state === 'pass', JSON.stringify(mapped));

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

  // ---- Test 2f: the conversation metadata PUT is fingerprint-gated (§B1) ----
  // Before this, publishConversation PUT unconditionally on every call, and its
  // body carried `lastActivityAt: now()` — so a 400ms-coalesced schedulePublish
  // (which every chat broadcast triggers) meant ~2 PUTs a second per workspace
  // during any turn, forever, for data that hadn't changed. That is the single
  // biggest write-side contributor to the relay's egress bill.
  const wsRow = () => Workspaces.get(ws.id)!;
  // Let 2e's background publishAll finish before counting requests.
  await new Promise((r) => setTimeout(r, 2000));
  account.resetRelayBreaker();
  Workspaces.patchChat(ws.id, 1, { title: 'gate check', titleCustom: true });
  captured.put.length = 0;
  await account.publishConversation(wsRow(), 1);
  await account.publishConversation(wsRow(), 1);
  const gatedPuts = captured.put.filter((p) => p.id === convId).length;
  check('publishConversation PUTs once across two identical calls', gatedPuts === 1, `${gatedPuts} PUTs`);
  // `lastActivityAt` must be stable, not now() — otherwise nothing is ever "unchanged".
  const gatedBody = captured.put.filter((p) => p.id === convId).pop()?.body;
  check('metadata body carries a stable lastActivityAt (never now())', typeof gatedBody?.lastActivityAt === 'number' && gatedBody.lastActivityAt < Date.now() - 1, JSON.stringify(gatedBody?.lastActivityAt));
  // A real change still goes up.
  Workspaces.patchChat(ws.id, 1, { title: 'gate check 2', titleCustom: true });
  captured.put.length = 0;
  await account.publishConversation(wsRow(), 1);
  const changedPuts = captured.put.filter((p) => p.id === convId);
  check('a changed conversation re-PUTs once', changedPuts.length === 1 && changedPuts[0].body.title === 'gate check 2', JSON.stringify(changedPuts.map((p) => p.body.title)));

  // ---- Test 2g: a 5xx opens the relay circuit breaker (§B2) ----
  // The outage log showed this desktop firing ~60 conversation PUTs and 35 device
  // polls into a dead relay in 35 seconds. The breaker stops that, and MUST NOT
  // advance any fingerprint while it's open — otherwise the change that failed
  // would be silently skipped forever once the relay came back.
  Workspaces.patchChat(ws.id, 1, { title: 'outage 1', titleCustom: true });
  relayFail = true;
  captured.put.length = 0;
  await account.publishConversation(wsRow(), 1);
  const attempted = captured.put.filter((p) => p.id === convId).length;
  check('a failing publish is attempted exactly once', attempted === 1, `${attempted}`);
  check('a 5xx opens the relay breaker', account.relayStatus().ok === false, JSON.stringify(account.relayStatus()));

  // While the breaker is open, nothing reaches the wire at all.
  Workspaces.patchChat(ws.id, 1, { title: 'outage 2', titleCustom: true });
  Settings.setRaw(`account.wsfp.${ws.id}`, 'stale'); // past the workspace fingerprint gate too
  captured.put.length = 0;
  captured.workspaces.length = 0;
  await account.publishConversation(wsRow(), 1);
  await account.publishWorkspace(wsRow());
  await account.publishAll();
  check(
    'breaker open → publish paths make no request',
    captured.put.length === 0 && captured.workspaces.length === 0,
    `conv=${captured.put.length} ws=${captured.workspaces.length}`
  );

  // Fingerprints were not advanced, so the skipped change publishes on recovery.
  relayFail = false;
  account.resetRelayBreaker();
  check('resetting the breaker clears the outage', account.relayStatus().ok === true);
  captured.put.length = 0;
  captured.workspaces.length = 0;
  await account.publishConversation(wsRow(), 1);
  await account.publishWorkspace(wsRow());
  const recovered = captured.put.filter((p) => p.id === convId).pop()?.body;
  check('the change skipped during the outage publishes on recovery', recovered?.title === 'outage 2', JSON.stringify(recovered?.title));
  check('the workspace row skipped during the outage publishes on recovery', captured.workspaces.some((w) => w.id === ws.id), JSON.stringify(captured.workspaces.map((w) => w.id)));

  // ---- Test 2h: incremental backfill (perf-cpu-ram §4.2) ----
  // `msgs.length` was in the history fingerprint, so EVERY new message re-POSTed
  // the whole conversation to /backfill — whose relay handler insert-ignores
  // turns, so >99 % of those bytes were discarded. O(n²) over a chat's life. The
  // `account.bfmark.<convId>` mark makes the steady state send only the tail,
  // with a full resend whenever the mark can't be trusted.
  const bfMark = () => Settings.raw(`account.bfmark.${convId}`);
  const forceBackfill = () => Settings.setRaw(`account.fp.${convId}`, ''); // past the history gate
  const lastBackfill = () => captured.backfill.filter((b) => b.id === convId).pop()?.body;
  const t0 = now();
  Settings.setRaw(`account.bfmark.${convId}`, '');
  forceBackfill();
  captured.backfill.length = 0;
  await account.publishConversation(wsRow(), 1);
  const bfFull = lastBackfill();
  check('no backfill mark → the full history goes up', bfFull?.turns.length === 1 && bfFull?.userMessages.length === 1, JSON.stringify(bfFull?.turns.map((t: any) => t.id)));
  check('a successful backfill records the mark', !!bfMark(), String(bfMark()));

  // A queued row alone: the payload carries the queue and NOT the history.
  const incQ = uid();
  Queued.insert({ id: incQ, workspaceId: ws.id, agentId: 1, turnId: uid(), text: 'waiting', attachments: [], seq: 9, createdAt: t0 });
  captured.backfill.length = 0;
  await account.publishConversation(wsRow(), 1);
  const bfQueueOnly = lastBackfill();
  check('an unchanged history backfills the queue only', bfQueueOnly?.turns.length === 0 && bfQueueOnly?.userMessages.length === 1 && bfQueueOnly?.userMessages[0].id === incQ, JSON.stringify(bfQueueOnly));

  // One new agent turn: exactly that turn (+ the still-queued rows), no history.
  const turn2 = uid();
  Messages.insert({ id: turn2, workspaceId: ws.id, agentId: 1, role: 'agent', content: JSON.stringify([{ type: 'text', text: 'second' }]), attachments: [], ts: t0 + 10 });
  captured.backfill.length = 0;
  await account.publishConversation(wsRow(), 1);
  const bfInc = lastBackfill();
  check('a new message backfills only the new turn', bfInc?.turns.length === 1 && bfInc?.turns[0].id === turn2, JSON.stringify(bfInc?.turns.map((t: any) => t.id)));
  check('the incremental backfill still carries the whole queue', bfInc?.userMessages.length === 1 && bfInc?.userMessages[0].id === incQ, JSON.stringify(bfInc?.userMessages));
  Queued.remove(incQ);

  // A prompt published in one slice and answered in the next still gets its
  // turnId: the slice re-sends the user row the turn it opens on answered (§12.5).
  const user2 = uid();
  Messages.insert({ id: user2, workspaceId: ws.id, agentId: 1, role: 'user', content: 'and again', attachments: [], ts: t0 + 20 });
  captured.backfill.length = 0;
  await account.publishConversation(wsRow(), 1);
  const turn3 = uid();
  Messages.insert({ id: turn3, workspaceId: ws.id, agentId: 1, role: 'agent', content: JSON.stringify([{ type: 'text', text: 'third' }]), attachments: [], ts: t0 + 30 });
  captured.backfill.length = 0;
  await account.publishConversation(wsRow(), 1);
  const bfPair = lastBackfill();
  check('an incremental slice still pairs the prompt with the turn it started', bfPair?.userMessages.find((m: any) => m.id === user2)?.turnId === turn3, JSON.stringify(bfPair?.userMessages));

  // Clearing the mark (link / re-sync / purge) forces the whole history again.
  Settings.setRaw(`account.bfmark.${convId}`, '');
  forceBackfill();
  captured.backfill.length = 0;
  await account.publishConversation(wsRow(), 1);
  const bfCleared = lastBackfill();
  check('clearing the backfill mark re-sends the whole history', bfCleared?.turns.length === 3 && bfCleared?.userMessages.length === 2, JSON.stringify({ turns: bfCleared?.turns.length, msgs: bfCleared?.userMessages.length }));

  // A deletion makes the count disagree with the mark — fall back to a full one.
  Messages.remove(turn3);
  forceBackfill();
  captured.backfill.length = 0;
  await account.publishConversation(wsRow(), 1);
  const bfDeleted = lastBackfill();
  check('a deleted message falls back to a full backfill', bfDeleted?.turns.length === 2 && bfDeleted?.userMessages.length === 2, JSON.stringify({ turns: bfDeleted?.turns.length, msgs: bfDeleted?.userMessages.length }));

  // ---- Test 2i: todos / diff comments are fingerprint-gated (§4.1) ----
  // Both fired an UNGATED PUT to /git on every schedulePublish batch, i.e. twice
  // per 400ms tick for the whole of every turn.
  Todos.insert({ id: uid(), workspaceId: ws.id, text: 'ship it', done: false, createdAt: now() });
  captured.git.length = 0;
  await account.publishTodos(ws.id);
  await account.publishTodos(ws.id);
  check('publishTodos PUTs once across two identical calls', captured.git.length === 1, `${captured.git.length} PUTs`);
  Todos.insert({ id: uid(), workspaceId: ws.id, text: 'and again', done: false, createdAt: now() });
  await account.publishTodos(ws.id);
  check('a changed todo list re-PUTs', captured.git.length === 2 && captured.git[1].body.todos.length === 2, JSON.stringify(captured.git.map((g) => g.body.todos?.length)));
  captured.git.length = 0;
  await account.publishComments(ws.id);
  await account.publishComments(ws.id);
  check('publishComments PUTs once across two identical calls', captured.git.length === 1, `${captured.git.length} PUTs`);

  // ---- Test 2j: subscription usage rides the settings row, not every conversation ----
  // (web-neon-usage-diet §3.2) `usage.windows[].pct` was an unrounded float on
  // EVERY conversation row, so a drift of hundredths of a percent re-PUT all ~293
  // of them every five minutes for as long as Claude was used anywhere. It is now
  // one per-user field, per harness, in whole percent.
  captured.put.length = 0;
  captured.settings.length = 0;
  Settings.setRaw(`account.cfp.${convId}`, ''); // past the metadata gate
  Settings.setRaw('account.settingsfp', ''); // past the settings gate
  await account.publishConversation(wsRow(), 1);
  await account.publishSettings();
  const usageConv = captured.put.filter((p) => p.id === convId).pop()?.body;
  check('the conversation PUT carries no usage key', !!usageConv && !('usage' in usageConv), JSON.stringify(Object.keys(usageConv ?? {})));
  const usageBody = captured.settings.pop()?.usage;
  const claudeUsage = usageBody?.['claude-code'];
  check('the settings PUT carries usage per harness', !!claudeUsage && claudeUsage.plan === 'max', JSON.stringify(usageBody));
  check(
    'published usage percentages are whole numbers',
    claudeUsage?.windows?.length === 1 && claudeUsage.windows[0].pct === 13,
    JSON.stringify(claudeUsage?.windows)
  );
  // ws is a cloud workspace (its harness runs on the box), ws2 is the local one
  // that put claude-code in the map — a harness with no live local work is absent.
  check('usage covers only harnesses with live local work', Object.keys(usageBody ?? {}).join(',') === 'claude-code', JSON.stringify(Object.keys(usageBody ?? {})));

  // ---- Test 2k: archiving removes the workspace from the relay (§3.5) ----
  // The web mirrors what you are working on: 106 of this fleet's 137 workspaces
  // were archived, and every one of them cost a row, a transcript and a re-publish
  // for a History view a phone barely visits. Archiving deletes; un-archiving
  // republishes in full.
  const ws2Conv = `${ws2.id}:1`;
  Messages.insert({ id: uid(), workspaceId: ws2.id, agentId: 1, role: 'user', content: 'archive me', attachments: [], ts: now() });
  await account.publishWorkspace(Workspaces.get(ws2.id)!);
  await account.publishConversation(Workspaces.get(ws2.id)!, 1);
  check('the workspace is on the relay before archiving', !!Settings.raw(`account.wsfp.${ws2.id}`) && !!Settings.raw(`account.fp.${ws2Conv}`));
  const setArchived = (id: string, archived: boolean) => {
    const w = Workspaces.get(id)!;
    Workspaces.update({ ...w, archived, status: archived ? 'archived' : 'idle' });
  };
  captured.deleted.length = 0;
  captured.workspaces.length = 0;
  captured.put.length = 0;
  setArchived(ws2.id, true);
  await account.publishAll();
  check('archiving DELETEs the workspace from the relay', captured.deleted.includes(ws2.id), JSON.stringify(captured.deleted));
  check(
    'archiving clears that workspace fingerprints and marks the row gone',
    Settings.raw(`account.wsfp.${ws2.id}`) === 'gone' && !Settings.raw(`account.fp.${ws2Conv}`) && !Settings.raw(`account.cfp.${ws2Conv}`) && !Settings.raw(`account.bfmark.${ws2Conv}`),
    JSON.stringify({ wsfp: Settings.raw(`account.wsfp.${ws2.id}`), fp: Settings.raw(`account.fp.${ws2Conv}`) })
  );
  check(
    'an archived workspace is not published',
    !captured.workspaces.some((w) => w.id === ws2.id) && !captured.put.some((p) => p.id === ws2Conv),
    JSON.stringify({ ws: captured.workspaces.map((w) => w.id), conv: captured.put.map((p) => p.id) })
  );
  // With the fingerprint gone the relay has nothing left to delete — a later pass
  // must not keep firing DELETEs at it forever.
  captured.deleted.length = 0;
  await account.publishAll();
  check('an already-removed archived workspace is not deleted again', !captured.deleted.includes(ws2.id), JSON.stringify(captured.deleted));
  // …but a relink clears every fingerprint, and the relay may still hold archived
  // rows from the previous link — so the pass after a link deletes once more.
  Settings.setRaw(`account.wsfp.${ws2.id}`, '');
  await account.publishAll();
  check('after a relink an archived workspace is deleted once more', captured.deleted.includes(ws2.id), JSON.stringify(captured.deleted));
  captured.deleted.length = 0;
  await account.publishAll();
  check('…and then stays quiet', !captured.deleted.includes(ws2.id), JSON.stringify(captured.deleted));
  // Un-archiving republishes the row AND the whole history (the cleared
  // fingerprints are what force the full backfill back up).
  captured.workspaces.length = 0;
  captured.backfill.length = 0;
  setArchived(ws2.id, false);
  await account.publishAll();
  check('un-archiving re-PUTs the workspace row', captured.workspaces.some((w) => w.id === ws2.id), JSON.stringify(captured.workspaces.map((w) => w.id)));
  const ws2Backfill = captured.backfill.filter((b) => b.id === ws2Conv).pop()?.body;
  check('un-archiving re-backfills the conversation history', ws2Backfill?.userMessages.length === 1, JSON.stringify(ws2Backfill));

  // ---- Test 2l: the run-scripts blob is fingerprint-gated (§3.8) ----
  // A `runscript:` broadcast fires per output chunk, and each one re-PUT the same
  // unchanged list — an ungated write per line of a dev server's log.
  const runScriptPuts = () => captured.git.filter((g) => g.body.runScripts).length;
  captured.git.length = 0;
  await account.publishRunScripts(ws.id);
  await account.publishRunScripts(ws.id);
  check('publishRunScripts PUTs once across two identical calls', runScriptPuts() === 1, `${runScriptPuts()} PUTs`);

  // ---- Test 2m: embedded images upload once, keyed by content (§3.6) ----
  // The URL cache was an in-memory map keyed by (workspace, ref), so every
  // restart + resync re-uploaded each embedded screenshot as a new base64 row
  // that nothing ever deletes — the bulk of the relay's 589 MB. It is now
  // `account.img.<sha256 of the data URL>` in settings.
  const shot = path.join(Workspaces.get(ws.id)!.worktreePath, '.context', 'shot.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  Messages.insert({
    id: uid(),
    workspaceId: ws.id,
    agentId: 1,
    role: 'agent',
    content: JSON.stringify([{ type: 'text', text: 'shipped it ![shot](.context/shot.png)' }]),
    attachments: [],
    ts: now(),
  });
  const fullBackfill = () => {
    Settings.setRaw(`account.bfmark.${convId}`, ''); // no tail — resend the whole history
    Settings.setRaw(`account.fp.${convId}`, ''); // past the history gate
  };
  captured.attachments.length = 0;
  captured.backfill.length = 0;
  fullBackfill();
  await account.publishConversation(wsRow(), 1);
  check('an embedded image is uploaded', captured.attachments.length === 1, `${captured.attachments.length} uploads`);
  check('the upload is attributed to its workspace', captured.attachments[0]?.workspaceId === ws.id, JSON.stringify(captured.attachments[0]?.workspaceId));
  check('the upload carries the image bytes as a data URL', String(captured.attachments[0]?.dataUrl ?? '').startsWith('data:image/png;base64,'));
  check(
    'the published markdown points at the relay copy',
    JSON.stringify(captured.backfill.filter((b) => b.id === convId).pop()?.body.turns ?? []).includes('/api/attachments/att-1'),
    'rewritten ref'
  );
  captured.attachments.length = 0;
  fullBackfill();
  await account.publishConversation(wsRow(), 1);
  check('the same bytes are never uploaded twice (persisted cache)', captured.attachments.length === 0, `${captured.attachments.length} uploads`);

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

  // ---- Test 4b: pullSync adopts defaults pinned on the web (settings-sync) ----
  Settings.setGlobal({ defaultHarness: 'claude-code', defaultModels: { codex: 'gpt-5' }, defaultEffort: 'high' });
  // A desktop's own mirror PUT (no origin) must not be adopted — two desktops would ping-pong.
  syncEvents = [{ seq: 3, kind: 'settings-updated', conversationId: null, payload: { defaultHarness: 'codex', defaultModels: {}, defaultEffort: 'low' } }];
  Settings.setRaw('account.syncCursor', '2');
  await account.pullSync();
  check('a desktop-origin settings-updated is ignored', Settings.global().defaultEffort === 'high' && Settings.global().defaultHarness === 'claude-code');
  syncEvents = [
    {
      seq: 4,
      kind: 'settings-updated',
      conversationId: null,
      payload: { origin: 'web', defaultHarness: 'codex', defaultModels: { 'claude-code': 'opus', bogus: 'x' }, defaultEffort: 'low' },
    },
  ];
  Settings.setRaw('account.syncCursor', '3');
  await account.pullSync();
  const g = Settings.global();
  check(
    'a web-origin settings-updated sets the local defaults',
    g.defaultHarness === 'codex' && g.defaultEffort === 'low' && g.defaultModels?.['claude-code'] === 'opus' && g.defaultModels?.codex === 'gpt-5',
    JSON.stringify({ h: g.defaultHarness, m: g.defaultModels, e: g.defaultEffort })
  );
  check('…ignoring unknown harness ids', !('bogus' in (g.defaultModels ?? {})), JSON.stringify(g.defaultModels));
  // The theme syncs the same way; an unknown family / mode is dropped.
  Settings.setGlobal({ theme: 'system', colorTheme: 'classic' });
  syncEvents = [
    { seq: 5, kind: 'settings-updated', conversationId: null, payload: { origin: 'web', theme: 'dark', colorTheme: 'gruvbox' } },
  ];
  Settings.setRaw('account.syncCursor', '4');
  await account.pullSync();
  check('a web-origin theme pick re-themes the desktop', Settings.global().theme === 'dark' && Settings.global().colorTheme === 'gruvbox', JSON.stringify(Settings.global()));
  syncEvents = [
    { seq: 6, kind: 'settings-updated', conversationId: null, payload: { origin: 'web', theme: 'sepia', colorTheme: 'bogus' } },
  ];
  Settings.setRaw('account.syncCursor', '5');
  await account.pullSync();
  check('…ignoring an unknown theme / mode', Settings.global().theme === 'dark' && Settings.global().colorTheme === 'gruvbox');

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

  // ---- Test 5f: boot re-asserts the sync loop (perf-cpu-ram §4.8 roll-out) ----
  // A linked box keeps running whatever shim it was launched with until it
  // reboots, so a shim fix has to reach it without a relink: the loop stamps its
  // hash into the lock, and autoLinkBoxes → ensureSync restarts it when that is
  // stale — and leaves a current one alone.
  const lock = path.join(BOX_HOME, 'maestro', 'cloud', '.sync.lock');
  const lockPid = () => {
    try {
      return fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
    } catch {
      return ''; // between the old loop's exit and the new one's start
    }
  };
  const alive = (pid: string) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  check('box link launched the sync loop', await waitFor(() => fs.existsSync(path.join(lock, 'hash')), 5_000, 'sync lock'));
  const pid0 = lockPid();
  check('the loop stamped its shim hash into the lock', fs.readFileSync(path.join(lock, 'hash'), 'utf8').trim() === SYNC_HASH);
  await account.autoLinkBoxes();
  check('a current loop is left alone at boot', lockPid() === pid0 && alive(pid0), `${pid0} -> ${lockPid()}`);
  fs.writeFileSync(path.join(lock, 'hash'), 'stale\n');
  await account.autoLinkBoxes();
  const restarted = await waitFor(() => lockPid() !== '' && lockPid() !== pid0, 5_000, 'restarted sync loop');
  const pid1 = lockPid();
  check('a loop running an older shim is restarted at boot', restarted && alive(pid1), `${pid0} -> ${pid1}`);
  check('the older loop is gone', await waitFor(() => !alive(pid0), 3_000, 'old sync loop exit'));
  check('the restarted loop carries the current hash', fs.readFileSync(path.join(lock, 'hash'), 'utf8').trim() === SYNC_HASH);

  // ---- Test 5g: a box link the relay revoked is re-minted (neon-idle-compute) ----
  // Reset Maestro Web revokes every box, but the desktop kept re-asserting the dead
  // tokens at boot — so the box 401'd forever: offline on the web, and each retry
  // a Postgres read that kept Neon awake. The relay's live box ids are the truth.
  relayBoxes = ['box-X'];
  const beforeLive = captured.boxes.length;
  await account.autoLinkBoxes();
  check('a box the relay still honours is left alone', captured.boxes.length === beforeLive, `${beforeLive} -> ${captured.boxes.length}`);
  relayBoxes = [];
  await account.autoLinkBoxes();
  // Only testbox2 is a saved host; autoLinkBoxes never walks the ad-hoc testbox.
  check('a box the relay revoked is re-linked with a fresh token', captured.boxes.length === beforeLive + 1, `${beforeLive} -> ${captured.boxes.length}`);
  check('…and the host is linked again', account.boxLinkedForHost('testbox2'));
  relayBoxes = null;

  // ---- Test 5e: what actually triggers a publish (perf-cpu-ram §4.1) ----
  // `chat:event` is one broadcast per streamed token (claude runs with
  // --include-partial-messages), so treating it as a publish trigger ran the whole
  // guard chain — safeStorage decrypt included — per token, and kept a 400ms
  // publish batch turning over for the length of every turn. The live turn has its
  // own hook; only row-level broadcasts schedule a publish.
  await account.startAccountSync();
  await new Promise((r) => setTimeout(r, 2000)); // let the boot publishAll drain
  // Probe on the todos PUT: only a schedulePublish batch emits one, so the boot
  // publishAll (which never touches /git) can't be mistaken for a trigger.
  Settings.setRaw(`account.tfp.${ws.id}`, 'stale'); // a publish WOULD reach the relay
  captured.git.length = 0;
  broadcast('chat:event', { workspaceId: ws.id, agentId: 1, event: { kind: 'seg-delta', text: 'token' } });
  await new Promise((r) => setTimeout(r, 900)); // longer than the 400ms publish batch
  check('a chat:event broadcast does not schedule a publish', captured.git.length === 0, `${captured.git.length} PUTs`);
  broadcast('chat:message', { workspaceId: ws.id, agentId: 1, id: uid(), role: 'user', content: 'hi', attachments: [], ts: now() });
  const triggered = await waitFor(() => captured.git.some((g) => g.id === ws.id), 5_000, 'chat:message publish');
  check('a chat:message broadcast does schedule a publish', triggered, JSON.stringify(captured.git.map((g) => g.id)));
  account.stopAccountSync();

  // ---- Test 7: live turns stream as deltas, and only while something watches ----
  // A running turn used to be re-PUT whole every 400ms, forever, whether or not
  // anyone was looking. Now the turn is opened with a PUT and streamed as the
  // block events themselves — and only while the relay says a client is watching
  // (web-relay-event-bus §3.1/§4.4). ws2 is local; ws lives on a box, whose turns
  // stream through the journal instead.
  account.resetRelayBreaker();
  const liveConv = `${ws2.id}:1`;
  const liveTurn = uid();
  const stream = newBlockStream();
  const tick = (events: AgentEvent[], turnId = liveTurn) => {
    for (const e of events) applyBlockEvent(stream, e);
    return account.publishLiveTurn(ws2.id, 1, { turnId, status: 'running', events, stream, startedAt: 1 });
  };

  pollWatch = false;
  startBridge();
  check('a relay with no watcher puts the desktop in standby', await waitFor(() => relayMode() === 'idle', 10_000, 'standby'), relayMode());
  const pollsBefore = polls.length;
  await new Promise((r) => setTimeout(r, 2500));
  const idlePolls = polls.slice(pollsBefore);
  check(
    'idle heartbeats ask for an answer now and pace themselves by idleWait',
    idlePolls.length >= 2 && idlePolls.length <= 4 && idlePolls.every((w) => w === '0'),
    JSON.stringify(idlePolls)
  );

  captured.turns.length = 0;
  captured.deltas.length = 0;
  await account.publishLiveTurn(ws2.id, 1, { turnId: liveTurn, status: 'running', events: [], stream: newBlockStream(), startedAt: 1 });
  check(
    'a turn is opened on the relay even in standby',
    captured.turns.some((t) => t.id === liveConv && t.body.status === 'running' && t.body.blocks.length === 0),
    JSON.stringify(captured.turns)
  );
  await tick([{ kind: 'seg-start', segType: 'text' }, { kind: 'seg-delta', text: 'a' }]);
  check('nothing streams while nothing is watching', captured.deltas.length === 0, JSON.stringify(captured.deltas));

  pollWatch = true;
  check('a watcher puts the desktop back in live mode', await waitFor(() => relayMode() === 'live', 10_000, 'live'), relayMode());
  await tick([{ kind: 'seg-delta', text: 'b' }]);
  const base = captured.deltas[0];
  check('the first entry after going live is a base', base?.seq === 1 && !!base?.base, JSON.stringify(base));
  check('the base carries the turn so far, not just the new events', snapshotBlocks(base.base)[0]?.text === 'ab', JSON.stringify(base?.base));
  await tick([{ kind: 'seg-delta', text: 'c' }]);
  check(
    'later entries carry only what changed',
    captured.deltas[1]?.seq === 2 && !captured.deltas[1]?.base && captured.deltas[1]?.events.length === 1,
    JSON.stringify(captured.deltas[1])
  );

  // The grace window: a phone that reloads (or a poll loop that stops) must not
  // cost the user a wake-up, so streaming continues for 60s.
  stopBridge();
  check('the live grace keeps the desktop streaming after the loop stops', relayMode() === 'live');

  captured.deltas.length = 0;
  delta409 = 1;
  await tick([{ kind: 'seg-delta', text: 'd' }]);
  check(
    'a 409 re-bases instead of leaving a hole',
    captured.deltas.length === 1 && captured.deltas[0]?.seq === 1 && snapshotBlocks(captured.deltas[0].base)[0]?.text === 'abcd',
    JSON.stringify(captured.deltas)
  );

  relayFail = true;
  await tick([{ kind: 'seg-delta', text: 'e' }]);
  relayFail = false;
  account.resetRelayBreaker();
  captured.deltas.length = 0;
  await tick([{ kind: 'seg-delta', text: 'f' }]);
  check(
    'a failed entry re-bases once the relay is back',
    captured.deltas[0]?.seq === 1 && snapshotBlocks(captured.deltas[0].base)[0]?.text === 'abcdef',
    JSON.stringify(captured.deltas[0])
  );

  // A 409 that says the relay is AHEAD of us (a 200 we never saw) is still a
  // re-base: replaying the entry at the seq it names could land it twice.
  captured.deltas.length = 0;
  delta409 = 3;
  await tick([{ kind: 'seg-delta', text: 'g' }]);
  check(
    'any 409 re-bases, never replays',
    captured.deltas.length === 1 && captured.deltas[0]?.seq === 1 && snapshotBlocks(captured.deltas[0].base)[0]?.text === 'abcdefg',
    JSON.stringify(captured.deltas)
  );

  // An opening PUT that fails (relay down at turn start) is retried by the next
  // tick, before anything streams — the phone can't watch a turn with no row.
  const lateTurn = uid();
  const late = newBlockStream();
  const lateTick = (events: AgentEvent[]) => {
    for (const e of events) applyBlockEvent(late, e);
    return account.publishLiveTurn(ws2.id, 1, { turnId: lateTurn, status: 'running', events, stream: late, startedAt: 1 });
  };
  relayFail = true;
  await lateTick([]);
  relayFail = false;
  account.resetRelayBreaker();
  captured.turns.length = 0;
  captured.deltas.length = 0;
  await lateTick([{ kind: 'seg-start', segType: 'text' }, { kind: 'seg-delta', text: 'late' }]);
  check(
    'an opening PUT that failed is retried before anything streams',
    captured.turns.some((t) => t.body.turnId === lateTurn && t.body.status === 'running' && t.body.blocks.length === 0) &&
      captured.deltas.length === 1 &&
      captured.deltas[0]?.seq === 1 &&
      snapshotBlocks(captured.deltas[0].base)[0]?.text === 'late',
    JSON.stringify({ turns: captured.turns.map((t) => t.body), deltas: captured.deltas })
  );

  captured.turns.length = 0;
  await account.publishLiveTurn(ws2.id, 1, {
    turnId: liveTurn,
    status: 'done',
    blocks: [{ type: 'text', text: 'abcdef' }],
    meta: { costUsd: 0.1 },
    startedAt: 1,
    endedAt: 2,
  });
  const terminal = captured.turns.pop();
  check(
    'the terminal PUT still carries the whole finished turn',
    terminal?.body.status === 'done' && terminal?.body.blocks?.[0]?.text === 'abcdef',
    JSON.stringify(terminal?.body)
  );

  // Against a relay that predates the protocol, a new desktop behaves exactly as
  // it did before: full snapshots on the turn PUT, no deltas.
  pollWatch = null;
  startBridge();
  const pollsSeen = polls.length;
  await waitFor(() => polls.length > pollsSeen, 10_000, 'legacy poll');
  check('a relay with no watch flag reads as legacy', relayMode() === 'legacy', relayMode());
  captured.turns.length = 0;
  captured.deltas.length = 0;
  await tick([{ kind: 'seg-delta', text: 'legacy' }], 'legacy-turn');
  check(
    'an old relay still gets the full-snapshot running PUT',
    captured.deltas.length === 0 && captured.turns.at(-1)?.body.status === 'running' && captured.turns.at(-1)?.body.blocks?.[0]?.text.endsWith('legacy'),
    JSON.stringify(captured.turns.at(-1)?.body)
  );
  stopBridge();

  // ---- Test 8: agent messaging over the relay (docs/specs/agent-messaging.md) ----
  // ws2 is local; the relay also lists another desktop's workspaces, one of which
  // shares ws2's project AND name — the collision a reply must survive.
  const { runMessageCommand } = await import('../src/main/services/messaging');
  const fleetWs = (id: string, name: string, harness = 'claude-code', deviceId = 'dev-other') => ({ id, name, projectName: project.name, deviceId, harness, archived: false });
  // A workspace this desktop has but doesn't offer locally (here a shell one;
  // likewise an archived one whose unpublish hasn't reached the relay).
  const hidden = await createWorkspace({ projectId: project.id, harness: 'shell' });
  // dev-gone is a revoked desktop: the relay keeps its workspace rows but leaves
  // it out of `devices`. dev-asleep is linked but offline.
  relayFleet = {
    selfDeviceId: 'dev-me',
    devices: [
      { id: 'dev-other', name: 'Other Mac', online: true },
      { id: 'dev-asleep', name: 'Laptop', online: false },
      { id: 'dev-me', name: 'This Mac', online: true },
    ],
    boxes: [],
    workspaces: [
      fleetWs('remote-ws', 'lisbon-v9'),
      fleetWs('twin-ws', ws2.name),
      fleetWs('shell-ws', 'oslo-v9', 'shell'),
      fleetWs('gone-ws', 'riga-v9', 'claude-code', 'dev-gone'),
      fleetWs('asleep-ws', 'porto-v9', 'claude-code', 'dev-asleep'),
      fleetWs('unpublished-ws', 'kyoto-v9'),
      fleetWs(hidden.id, 'hidden-v9', 'claude-code', 'dev-me'),
      // This desktop's own rows: ws2 (live) and one it deleted whose unpublish
      // never reached the relay.
      fleetWs(ws2.id, ws2.name, 'claude-code', 'dev-me'),
      fleetWs('deleted-ws', 'bergen-v9', 'claude-code', 'dev-me'),
      // A remote twin of ws2's name whose project the relay doesn't know (null).
      { ...fleetWs('noproj-ws', ws2.name), projectName: null },
    ],
    sessions: [
      { workspaceId: 'remote-ws', agentId: 1 },
      { workspaceId: 'twin-ws', agentId: 1 },
      { workspaceId: 'gone-ws', agentId: 1 },
      { workspaceId: 'asleep-ws', agentId: 1 },
      { workspaceId: hidden.id, agentId: 1 },
      { workspaceId: 'noproj-ws', agentId: 1 },
    ],
  };
  const listed = await runMessageCommand(ws2.id, 1, ['list'], '');
  check('list shows another machine\'s chats by device name', listed.ok && /^lisbon-v9 — .*Other Mac · idle$/m.test(listed.text), listed.text);
  check('list skips remote shell workspaces', !listed.text.includes('oslo-v9'), listed.text);
  check(
    'a name + project clash across machines lists both by id',
    listed.text.includes(`${ws2.id} (you)`) && /^twin-ws — /m.test(listed.text),
    listed.text
  );

  check('a revoked machine\'s workspaces are not listed', !listed.text.includes('riga-v9'), listed.text);
  check('an offline machine\'s chats are listed as offline', /^porto-v9 — .*Laptop · offline$/m.test(listed.text), listed.text);
  check('a remote workspace with no chat on the relay is not listed', !listed.text.includes('kyoto-v9'), listed.text);
  const toGone = await runMessageCommand(ws2.id, 1, ['send', 'riga-v9'], 'hello?');
  check('…and a send to a revoked machine is refused, not "delivered"', !toGone.ok && sends.length === 0, toGone.text);
  const toAsleep = await runMessageCommand(ws2.id, 1, ['send', 'porto-v9'], 'when you wake');
  check('a send to an offline machine says it is queued, not delivered', toAsleep.ok && toAsleep.text.startsWith('Queued for porto-v9') && sends.pop()?.id === 'asleep-ws:1', toAsleep.text);
  sendStatus = 404;
  const relayErr = await runMessageCommand(ws2.id, 1, ['send', 'lisbon-v9'], 'x');
  sendStatus = 200;
  check('a relay error on /send is reported, not swallowed', !relayErr.ok && relayErr.text.includes('could not deliver to lisbon-v9') && relayErr.text.includes('gone'), relayErr.text);
  sends.length = 0;

  check('a workspace this desktop has is never offered as a remote one', !listed.text.includes('hidden-v9'), listed.text);
  check('…nor one it deleted that the relay still lists under its device', !listed.text.includes('bergen-v9'), listed.text);
  const optOutBefore = Settings.global().account?.projectOptOut ?? [];
  Settings.setGlobal({ account: { ...Settings.global().account!, projectOptOut: [...optOutBefore, project.id] } });
  const optedOut = await runMessageCommand(ws2.id, 1, ['send', 'lisbon-v9'], 'can you hear me');
  Settings.setGlobal({ account: { ...Settings.global().account!, projectOptOut: optOutBefore } });
  check('an unsynced project cannot message another machine (no reply path)', !optedOut.ok && optedOut.text.includes("isn't synced") && sends.length === 0, optedOut.text);

  const readsBefore = fleetReads;
  const self = await runMessageCommand(ws2.id, 1, ['send', ws2.name], 'hi');
  check('a local name resolves locally first — no relay read', !self.ok && self.text.includes('your own chat') && fleetReads === readsBefore, self.text);

  const remote = await runMessageCommand(ws2.id, 1, ['send', 'lisbon-v9'], 'hello over there');
  const sent = sends.pop();
  check('a remote target is sent through the relay', remote.ok && sent?.id === 'remote-ws:1' && remote.text.includes('Other Mac'), remote.text);
  check('…with the device token and origin agent', sent?.auth === 'Bearer dev-token-xyz' && sent?.body.origin === 'agent', JSON.stringify(sent));
  check(
    '…and a reply address the other machine cannot mistake for its own workspace',
    !!sent?.body.text.startsWith('hello over there') && sent?.body.text.includes(`Reply with: maestro-message send ${ws2.id}]`),
    sent?.body.text
  );
  const noProj = await runMessageCommand(ws2.id, 1, ['send', `/${ws2.name}`], 'to the project-less twin');
  check('an empty-project address reaches that workspace, not a local namesake', noProj.ok && sends.pop()?.id === 'noproj-ws:1', noProj.text);
  const twin = await runMessageCommand(ws2.id, 1, ['send', 'twin-ws'], 'hi twin');
  check('a workspace id reaches the same-named remote twin', twin.ok && sends.pop()?.id === 'twin-ws:1', twin.text);

  fleetStatus = 401;
  const stale = await runMessageCommand(ws2.id, 1, ['send', 'lisbon-v9'], 'x');
  fleetStatus = 200;
  check('a 401 from an old relay explains itself', !stale.ok && stale.text.includes('relay returned 401'), stale.text);
  check('…and does not unlink the desktop', account.isLinked() === true);

  // The relay `message` job applies the loop guard on the receiving machine. The
  // refused message stays in history, un-queued, under the relay's id (that is
  // what clears the relay's queued row on the next publish) — and no turn runs.
  for (let i = 0; i < 10; i++) {
    Messages.insert({ id: uid(), workspaceId: ws2.id, agentId: 1, role: 'user', content: `agent ${i}`, attachments: [], ts: Date.now() + i, meta: { origin: 'agent' } });
  }
  await new Promise((r) => setTimeout(r, 20));
  account.applyWebUserMessage(`${ws2.id}:1`, 'm-agent', 'ping from afar');
  pendingJobs.push({ id: 'job-agent', kind: 'message', conversationId: `${ws2.id}:1`, workspaceId: ws2.id, payload: { text: 'ping from afar', messageId: 'm-agent', turnId: 't-agent', origin: 'agent' } });
  startBridge();
  const refused = await waitFor(() => jobsDone.some((j) => j.id === 'job-agent'), 15_000, 'agent job done');
  stopBridge();
  const doneBody = jobsDone.find((j) => j.id === 'job-agent')?.body;
  check('a looping relay message is refused', refused && doneBody?.ok === false && /in a row/.test(doneBody?.error ?? ''), JSON.stringify(doneBody));
  const kept = Messages.get('m-agent');
  check('…kept un-queued under the relay id (clears the web Queued card)', !!kept && !kept.meta?.queued && kept.meta?.origin === 'agent', JSON.stringify(kept?.meta));
  const last = Messages.listForAgent(ws2.id, 1).pop();
  check('…with a note saying it did not run', last?.role === 'system' && last.content.includes("Didn't run"), last?.content);
  check('…and no turn started', !runningAgents(ws2.id).length);
  const refusedRepublished = await waitFor(
    () => captured.backfill.some((b) => b.id === `${ws2.id}:1` && b.body.userMessages?.some((m: any) => m.id === 'm-agent' && m.queued === false)),
    15_000,
    'refused row republished'
  );
  check('…and republishes it un-queued, which clears the relay row', refusedRepublished);

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
