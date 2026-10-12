/**
 * Relay protocol verification (spec docs/specs/mobile-web-app.md §10). Boots the
 * relay handlers over a plain `node:http` server against an in-process PGlite DB
 * (no Postgres service, no `next start` — the house pattern: esbuild bundle,
 * plain node), then drives the FULL box path with the *real* `maestro-sync`
 * shim under `sh` and the *real* `maestro-drain` against a fake `claude` CLI.
 *
 * Asserts (§10):
 *   - journal chunks ingest across a split JSON line
 *   - 409 resync on offset mismatch
 *   - web send → job → queue file → drain → journal → turns row → SSE event
 *   - stop job kills the pgid and the aborted frame lands (turn → error)
 *   - rotation guard (cursor reset) + idempotent re-ingest
 *   - queue report carries a desktop-written job's preview
 *
 * Build + run (from web/ so drizzle + pglite resolve from web/node_modules):
 *   npx esbuild scripts/web-e2e.ts --bundle --platform=node --format=cjs \
 *     --packages=external --outfile=web/dist-e2e/web-e2e.cjs
 *   node web/dist-e2e/web-e2e.cjs
 */
process.env.MAESTRO_WEB_E2E = '1';
process.env.MAESTRO_WEB_PGLITE = '1';
process.env.NODE_ENV = 'test';

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { eq } from 'drizzle-orm';
import { getDb, __dbStatements, __forceDbError, __resetDb } from '../web/lib/db';
import { DDL_VERSION } from '../web/lib/db/ddl';
import {
  attachments,
  boxes,
  conversations,
  devices,
  jobs,
  journalCursors,
  pushSubscriptions,
  readState,
  turns,
  userMessages,
  users,
  workspaces,
  workspaceDiffs,
} from '../web/lib/db/schema';
import { hashToken } from '../web/lib/tokens';
import { boxPoll, boxJournal, boxQueue, boxRotated, boxAck, boxWorkspaceGit } from '../web/lib/handlers/box';
import { webSend, webStop, webTurn, webTurns, webStream, webReadState } from '../web/lib/handlers/web';
import { deviceList, devicePoll, deviceJobDone, listUserDevices } from '../web/lib/handlers/device';
import { webWorkspaces, webWorkspace, presenceSnapshot, putWorkspace, wsDelete, wsDeleteRoute } from '../web/lib/handlers/workspaces';
import { postAttachment } from '../web/lib/handlers/attachments';
import { deleteAccount, revokeBox } from '../web/lib/handlers/account';
import { enqueueJob, pruneFinishedJobs } from '../web/lib/jobs';
import { backfill, putConvTurn, postConvTurnDeltas, putConversation, putDeviceSettings, putWebSettings } from '../web/lib/handlers/desktop';
import { forgetLinkSummary, hasLiveLink, resolveDevice } from '../web/lib/authtokens';
import { appendEvent, latestSeq, eventsSince } from '../web/lib/events';
import { MemoryBus, MemoryRedis, RedisBus, getBus, liveKey, pruneKey, seenKey, wakeKey, watchKey, __setBus, type Bus } from '../web/lib/bus';
import { applyDelta } from '../web/lib/turn-deltas';
import { applyBlockEvent, newBlockStream, snapshotBlocks } from '../src/shared/harness';
import type { AgentEvent } from '../src/shared/types';
import { webHealth, signInDbGate, classifyDbError } from '../web/lib/health';
import { errorCopy } from '../web/app/auth/error/copy';
import { SYNC_SH, SYNC_HASH } from '../src/main/services/cloudsync';

const ROOT = path.join(os.tmpdir(), `maestro-web-e2e-${process.pid}`);
const BOX_HOME = path.join(ROOT, 'box-home');
const BIN = path.join(BOX_HOME, '.maestro', 'bin');
const CLOUD = path.join(BOX_HOME, 'maestro', 'cloud');
const USER_ID = 'user-1';
const BOX_ID = 'box-1';
const BOX_TOKEN = 'box-token-secret-abc';
const DEVICE_ID = 'dev-1';
const DEVICE_TOKEN = 'device-token-secret-xyz';
let PORT = 0;
let BASE = '';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

// A fake `claude` that speaks the stream-json protocol (mirrors cloud-e2e).
const FAKE_CLAUDE = `#!/bin/sh
case "$1" in --version) echo "claude-fake 1.0.0"; exit 0;; esac
cat >/dev/null 2>&1
resume=""; prev=""
for a in "$@"; do [ "$prev" = "--resume" ] && resume="$a"; prev="$a"; done
if [ -n "$resume" ]; then sid="$resume"; note="resumed=$resume"; else sid="S1FRESH"; note="fresh"; fi
printf '{"type":"system","subtype":"init","session_id":"%s"}\\n' "$sid"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"reply %s"}]}}\\n' "$note"
printf '{"type":"result","subtype":"success","session_id":"%s","is_error":false,"total_cost_usd":0.01,"duration_ms":10,"result":"reply %s"}\\n' "$sid" "$note"
`;

// A slow fake claude for the stop test — sleeps so a stop can interrupt it.
const SLOW_CLAUDE = `#!/bin/sh
case "$1" in --version) echo "claude-fake 1.0.0"; exit 0;; esac
cat >/dev/null 2>&1
printf '{"type":"system","subtype":"init","session_id":"SLOW"}\\n'
sleep 30
`;

// maestro-drain, copied verbatim from src/main/services/cloud.ts DRAIN_SH (kept
// in sync by hand — the parity of DRAIN itself is out of scope for web-e2e).
const DRAIN_SH = `#!/bin/sh
dir="$1"
[ -n "$dir" ] || exit 2
cd "$dir" 2>/dev/null || exit 2
mkdir .lock 2>/dev/null || exit 0
child=""
turnid=""
cleanup() { rm -rf .lock; rm -f run.pid; }
onterm() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null
    ts=$(date +%s 2>/dev/null || echo 0)
    [ -n "$turnid" ] && printf '{"maestro":"turn-end","turnId":"%s","exit":143,"at":%s}\\n' "$turnid" "$ts" >> "$JOURNAL"
  fi
  cleanup; exit 143
}
trap onterm TERM INT
trap cleanup EXIT
echo $$ > run.pid
JOURNAL="$dir/journal.jsonl"
: >> "$JOURNAL"
while :; do
  next=$(ls queue 2>/dev/null | sort | head -n 1)
  [ -n "$next" ] || break
  job="queue/$next"
  turnid=$(printf '%s' "$next" | sed 's/^[0-9]*-//; s/\\.job$//')
  ts=$(date +%s 2>/dev/null || echo 0)
  printf '{"maestro":"turn-start","turnId":"%s","at":%s}\\n' "$turnid" "$ts" >> "$JOURNAL"
  MAESTRO_JOURNAL="$JOURNAL" sh turn.sh < "$job" >> "$JOURNAL" 2>> stderr.log &
  child=$!
  wait "$child"
  code=$?
  child=""
  wait 2>/dev/null
  ts=$(date +%s 2>/dev/null || echo 0)
  printf '{"maestro":"turn-end","turnId":"%s","exit":%d,"at":%s}\\n' "$turnid" "$code" "$ts" >> "$JOURNAL"
  rm -f "$job"
done
`;

const TURN_SH = `#!/bin/sh
export PATH="$HOME/.maestro/bin:$PATH"
SESSION=$(grep -o '"session_id":"[^"]*"' "$MAESTRO_JOURNAL" 2>/dev/null | tail -n 1 | sed 's/.*"session_id":"//; s/".*//')
if [ -n "$SESSION" ]; then exec claude -p --resume "$SESSION"; else exec claude -p; fi
`;

// ---------- node http ↔ web Fetch adapter ----------

async function toRequest(req: http.IncomingMessage, body: Buffer): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(','));
  }
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
  return new Request(`${BASE}${req.url}`, init);
}

async function sendResponse(res: http.ServerResponse, r: Response) {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  if (r.body) {
    const reader = (r.body as any).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } else {
    res.end(await r.text());
  }
}

type Handler = (req: Request, params: any) => Promise<Response>;
const ROUTES: { method: string; re: RegExp; handler: Handler }[] = [
  { method: 'GET', re: /^\/api\/box\/poll/, handler: (r) => boxPoll(r) },
  { method: 'POST', re: /^\/api\/box\/journal/, handler: (r) => boxJournal(r) },
  { method: 'POST', re: /^\/api\/box\/queue/, handler: (r) => boxQueue(r) },
  { method: 'POST', re: /^\/api\/box\/rotated/, handler: (r) => boxRotated(r) },
  { method: 'POST', re: /^\/api\/box\/jobs\/([^/]+)\/ack/, handler: (r, p) => boxAck(r, { id: p[1] }) },
  { method: 'POST', re: /^\/api\/conversations\/([^/]+)\/send/, handler: (r, p) => webSend(r, { id: decodeURIComponent(p[1]) }) },
  { method: 'POST', re: /^\/api\/conversations\/([^/]+)\/stop/, handler: (r, p) => webStop(r, { id: decodeURIComponent(p[1]) }) },
  { method: 'GET', re: /^\/api\/conversations\/([^/]+)\/turns/, handler: (r, p) => webTurns(r, { id: decodeURIComponent(p[1]) }) },
  // No /api/fleet and no /api/presence: both are deleted (web-neon-usage-diet
  // §3.3/§3.8) — presence rides the SSE stream, the fleet read is /api/workspaces.
  { method: 'GET', re: /^\/api\/stream/, handler: (r) => webStream(r) },
  { method: 'PUT', re: /^\/api\/read-state/, handler: (r) => webReadState(r) },
];

function startServer(): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = (req.url ?? '').split('?')[0];
    const route = ROUTES.find((rt) => rt.method === req.method && rt.re.test(url));
    if (!route) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    try {
      const params = route.re.exec(url)!;
      const request = await toRequest(req, body);
      const response = await route.handler(request, params);
      await sendResponse(res, response);
    } catch (e: any) {
      res.statusCode = 500;
      res.end(String(e?.stack ?? e));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Convenience callers (test user header injects the session).
const webHeaders = { 'content-type': 'application/json', 'x-maestro-test-user': USER_ID };
const boxHeaders = { authorization: `Bearer ${BOX_TOKEN}` };

async function seedConversation(id: string, harness = 'claude-code') {
  const db = await getDb();
  const [workspaceId, agentId] = id.split(':');
  await db
    .insert(conversations)
    .values({
      id,
      userId: USER_ID,
      boxId: BOX_ID,
      workspaceId,
      agentId: Number(agentId),
      title: `conv ${id}`,
      harness,
      hasRun: true,
      state: 'idle',
    })
    .onConflictDoNothing();
}

function makeChatDir(id: string, claudeBin = 'claude'): string {
  const [ws, agent] = id.split(':');
  const dir = path.join(CLOUD, ws, agent);
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'turn.sh'), TURN_SH);
  return dir;
}

async function turnRow(turnId: string) {
  const db = await getDb();
  const [t] = await db.select().from(turns).where(eq(turns.id, turnId));
  return t;
}
function blockText(blocks: any): string {
  try {
    return (blocks as any[]).map((b) => (b.type === 'text' ? b.text : '')).join('');
  } catch {
    return '';
  }
}

// ---------- egress-quota tests (docs/specs/web-relay-egress-quota.md §E) ----------

const webReq = (path: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-maestro-test-user': USER_ID, ...((init.headers as any) ?? {}) },
  });
/** The same as `webReq`, for a user other than the fixture one (the purge and
 *  link-summary tests need an account they can destroy). */
const userReq = (userId: string, path: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-maestro-test-user': userId, ...((init.headers as any) ?? {}) },
  });
const deviceReq = (path: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DEVICE_TOKEN}`, ...((init.headers as any) ?? {}) },
  });
const jbody = async (r: Response) => (await r.json()) as any;

/** Drain the SSE stream from `cursor` until `until` matches (or the stream ends),
 *  returning every frame seen. */
async function sseFrames(cursor: number, until: (f: any) => boolean): Promise<any[]> {
  const sse = await webStream(webReq(`/api/stream?cursor=${cursor}&maxMs=500`));
  const frames: any[] = [];
  const reader = (sse.body as any).getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? ''; // keep the trailing partial line
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        frames.push(JSON.parse(line.slice(6)));
      } catch {}
    }
    if (frames.some(until)) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return frames;
}

/**
 * The read plane must be proportional to what changed, not to how much history
 * exists — the "id-only event → refetch the whole slice" design is what burned
 * 5 GB of Postgres egress a month. These assert the pieces the web client now
 * relies on: turnId on the wire, a single-turn read, a `?since=` delta, the
 * probe-driven long-poll, and the health/error surfaces that stop a database
 * outage from masquerading as a broken OAuth config.
 */
async function egressTests() {
  const db = await getDb();
  const convE = 'wsE:1';
  await db
    .insert(conversations)
    .values({ id: convE, userId: USER_ID, workspaceId: 'wsE', agentId: 1, title: 'local conv', harness: 'claude-code', state: 'idle' })
    .onConflictDoNothing();
  // A published workspace row, with the panel blobs the fleet must NOT re-send.
  await db
    .insert(workspaces)
    .values({
      id: 'wsE',
      userId: USER_ID,
      deviceId: DEVICE_ID,
      projectId: 'projE',
      projectName: 'proj E',
      title: 'local workspace',
      harness: 'claude-code',
      git: { ahead: 0, behind: 0, staged: 1, unstaged: 0, untracked: 0, dirty: true, files: [{ path: 'a.ts', status: 'M', add: 3, del: 1 }] } as any,
      todos: [{ id: 't1', text: 'do it', done: false }] as any,
      comments: [] as any,
      statusDigest: { scope: 'session', workingOn: 'stuff' } as any,
      runScripts: [] as any,
    })
    .onConflictDoNothing();

  // ---- Test 7: SSE forwards turnId for turn-* (§A1) ----
  const cursorBefore = await latestSeq(USER_ID);
  const turnE = 'turnE-1';
  const putResp = await putConvTurn(deviceReq(`/api/conversations/${encodeURIComponent(convE)}/turn`, {
    method: 'PUT',
    body: JSON.stringify({ turnId: turnE, status: 'running', blocks: [{ type: 'text', text: 'streaming…' }] }),
  }), { id: convE });
  check('device PUT of a live turn accepted', putResp.status === 200, `${putResp.status}`);

  const frames = await sseFrames(cursorBefore, (f) => f.kind === 'turn-delta');
  const started = frames.find((f) => f.kind === 'turn-started');
  check('SSE turn-started carries turnId', started?.turnId === turnE, JSON.stringify(started ?? frames));

  // ---- Test 8: GET /api/conversations/:id/turns/:turnId (§A2) ----
  const oneTurn = await jbody(await webTurn(webReq(`/api/conversations/${encodeURIComponent(convE)}/turns/${turnE}`), { id: convE, turnId: turnE }));
  check(
    'single-turn read returns that turn in the transcript shape',
    oneTurn.turn?.id === turnE && oneTurn.turn?.status === 'running' && blockText(oneTurn.turn?.blocks).includes('streaming…'),
    JSON.stringify(oneTurn).slice(0, 200)
  );
  const wrongConv = await webTurn(webReq(`/api/conversations/${encodeURIComponent(convE)}/turns/nope`), { id: convE, turnId: 'nope' });
  check('single-turn read 404s an unknown turn', wrongConv.status === 404, `${wrongConv.status}`);

  // ---- Test 9: GET …/turns?since=<seq> returns only newer turns (§A3) ----
  const full = await jbody(await webTurns(webReq(`/api/conversations/${encodeURIComponent(convE)}/turns`), { id: convE }));
  check('full transcript read still returns the turn', full.turns.length === 1 && full.turns[0].id === turnE, `${full.turns.length} turns`);
  check('full transcript read is not marked partial', !full.partial);
  const headSeq = full.turns[full.turns.length - 1].seq;
  const emptyDelta = await jbody(await webTurns(webReq(`/api/conversations/${encodeURIComponent(convE)}/turns?since=${headSeq}`), { id: convE }));
  check('?since=<head> returns no turns', emptyDelta.turns.length === 0 && emptyDelta.partial === true, JSON.stringify(emptyDelta.turns));
  // A second turn lands; the delta carries exactly that one.
  await putConvTurn(deviceReq(`/api/conversations/${encodeURIComponent(convE)}/turn`, {
    method: 'PUT',
    body: JSON.stringify({ turnId: 'turnE-2', status: 'done', blocks: [{ type: 'text', text: 'second' }] }),
  }), { id: convE });
  const delta = await jbody(await webTurns(webReq(`/api/conversations/${encodeURIComponent(convE)}/turns?since=${headSeq}`), { id: convE }));
  check('?since=<head> returns only the new turn', delta.turns.length === 1 && delta.turns[0].id === 'turnE-2', JSON.stringify(delta.turns.map((t: any) => t.id)));
  check('delta still carries the conversation head', delta.conversation?.id === convE, JSON.stringify(delta.conversation));
  // userMessages stay a FULL snapshot in a delta: queued rows mutate and vanish
  // in place, so a seq-keyed delta would ghost them on the phone.
  const msgsFull = full.userMessages.length;
  check('delta carries the full userMessages snapshot', delta.userMessages.length === msgsFull, `${delta.userMessages.length} vs ${msgsFull}`);

  // ---- Test 10: the device long-poll still returns promptly, via the wake flag ----
  // (A first poll flips the device online, which publishes device-presence and
  // would end the long-polls below on its own — get that out of the way first.)
  await devicePoll(deviceReq('/api/device/poll?wait=0&cursor=0'));
  const pollCursor = await latestSeq(USER_ID);
  {
    const started = Date.now();
    const pending = devicePoll(deviceReq(`/api/device/poll?wait=20&cursor=${pollCursor}`));
    await new Promise((r) => setTimeout(r, 300));
    await db.insert(jobs).values({
      id: 'job-probe-1',
      deviceId: DEVICE_ID,
      conversationId: convE,
      workspaceId: 'wsE',
      kind: 'message',
      payload: { text: 'hi' } as any,
      status: 'pending',
    });
    // enqueueJob does this for real callers; this test inserts the row directly.
    await getBus().set(wakeKey('d', DEVICE_ID), '1', 600);
    const body = await jbody(await pending);
    const elapsed = Date.now() - started;
    check('device poll returns the job promptly (probe path)', body.jobs?.some((j: any) => j.id === 'job-probe-1') && elapsed < 6000, `${elapsed}ms ${JSON.stringify(body.jobs?.map((j: any) => j.id))}`);
    check('device poll still reports a next cursor', typeof body.next === 'number', JSON.stringify(body.next));
    // Ack it — delivery alone leaves it pending (at-least-once), which would
    // make every later poll return instantly with the same job.
    await db.update(jobs).set({ ackedAt: new Date(), doneAt: new Date(), status: 'done' }).where(eq(jobs.id, 'job-probe-1'));
  }
  {
    const cursor = await latestSeq(USER_ID);
    const started = Date.now();
    const pending = devicePoll(deviceReq(`/api/device/poll?wait=20&cursor=${cursor}`));
    await new Promise((r) => setTimeout(r, 300));
    await appendEvent(USER_ID, 'workspace-updated', 'wsE:1');
    const body = await jbody(await pending);
    const elapsed = Date.now() - started;
    check(
      'device poll returns a new event promptly (probe path)',
      body.events?.some((e: any) => e.kind === 'workspace-updated') && elapsed < 6000,
      `${elapsed}ms ${JSON.stringify(body.events?.map((e: any) => e.kind))}`
    );
    check('device poll advances `next` past the delivered event', body.next > cursor, `${body.next} vs ${cursor}`);
  }
  {
    // Heartbeat / idle: an empty poll still returns at its deadline.
    const cursor = await latestSeq(USER_ID);
    const started = Date.now();
    const body = await jbody(await devicePoll(deviceReq(`/api/device/poll?wait=2&cursor=${cursor}`)));
    const elapsed = Date.now() - started;
    check('idle device poll returns at the deadline with an empty payload', body.jobs?.length === 0 && body.events?.length === 0 && elapsed >= 1500 && elapsed < 8000, `${elapsed}ms`);
  }

  // ---- Test 10b: the fleet diet + the presence endpoint that replaces the
  //      30s full refetch (§A6/§A7) ----
  const fleetRows = await jbody(await webWorkspaces(webReq('/api/workspaces')));
  const listRow = fleetRows.workspaces.find((w: any) => w.id === 'wsE');
  check('fleet lists the workspace', !!listRow, JSON.stringify(fleetRows.workspaces?.map((w: any) => w.id)));
  check(
    'fleet row omits the panel-only blobs (git/todos/comments/statusDigest/runScripts)',
    listRow && !('git' in listRow) && !('todos' in listRow) && !('comments' in listRow) && !('statusDigest' in listRow) && !('runScripts' in listRow),
    JSON.stringify(Object.keys(listRow ?? {}))
  );
  check('fleet row keeps what the list renders', listRow?.diffAdd === 0 && listRow?.changedFiles === 0 && 'liveActivity' in listRow, JSON.stringify(listRow));
  const oneWs = await jbody(await webWorkspace(webReq('/api/workspaces/wsE'), { id: 'wsE' }));
  check(
    'single-workspace read still carries the panel blobs',
    'git' in oneWs.workspace && 'todos' in oneWs.workspace && 'comments' in oneWs.workspace && 'statusDigest' in oneWs.workspace && 'runScripts' in oneWs.workspace,
    JSON.stringify(Object.keys(oneWs.workspace))
  );
  const presence = await presenceSnapshot(USER_ID);
  check(
    'presence reports lastSeenAt for the linked desktop',
    presence.devices?.some((d: any) => d.id === DEVICE_ID && typeof d.lastSeenAt === 'number'),
    JSON.stringify(presence)
  );
  check('presence payload is tiny (no workspace rows)', JSON.stringify(presence).length < 500, `${JSON.stringify(presence).length} bytes`);

  // ---- Test 11: /api/health (§D1) ----
  const healthOk = await jbody(await webHealth(webReq('/api/health')));
  check('/api/health reports ok with a live database', healthOk.ok === true && healthOk.db === 'ok', JSON.stringify(healthOk));

  // ---- Test 12: DB-down surfaces (§D1/§D2/§D3) ----
  // Categories are derived from the driver text, and the sanitized message must
  // never echo it (a Postgres error can carry the connection string).
  check(
    'quota errors classify as quota',
    classifyDbError(new Error('PostgresError: Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.')) === 'quota'
  );
  check('connection errors classify as unreachable', classifyDbError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) === 'unreachable');
  check('anything else classifies as error', classifyDbError(new Error('relation "turns" does not exist')) === 'error');

  const quotaErr = new Error('Your project has exceeded the data transfer quota. postgres://u:p@ep-x.neon.tech/db');
  __forceDbError(quotaErr);
  const healthDown = await jbody(await webHealth(webReq('/api/health')));
  check('/api/health answers with no database at all', healthDown.ok === false && healthDown.db === 'quota', JSON.stringify(healthDown));
  check('/api/health never echoes the raw driver error', !JSON.stringify(healthDown).includes('neon.tech'), JSON.stringify(healthDown));
  const gate = await signInDbGate();
  check(
    'signIn gate redirects to the custom error page when the DB is down',
    typeof gate === 'string' && gate.startsWith('/auth/error?error=RelayUnavailable'),
    String(gate)
  );
  __forceDbError(null);
  const healthBack = await jbody(await webHealth(webReq('/api/health')));
  check('/api/health recovers once the database is back', healthBack.ok === true, JSON.stringify(healthBack));
  check('signIn gate lets sign-in through when the DB is healthy', (await signInDbGate()) === true);

  // The error page's copy is a pure function, so it renders with no DB — which
  // is the whole point (Auth.js's built-in page 500s on `Configuration`).
  const unknownYet = errorCopy('Configuration', null);
  check('error page shows a checking state before /api/health answers', /Checking/i.test(unknownYet.body), unknownYet.body);
  const quotaCopy = errorCopy('Configuration', 'quota');
  check(
    'error page names the database quota, not "server configuration"',
    /data-transfer quota/i.test(quotaCopy.body) && !/server configuration/i.test(quotaCopy.body),
    quotaCopy.body
  );
  check('error page reassures the user their GitHub account is fine', /GitHub account is fine/i.test(quotaCopy.note ?? ''), quotaCopy.note ?? '');
  check('error page offers a retry', quotaCopy.retry === true);
  const healthyCopy = errorCopy('Configuration', 'ok');
  check('a healthy DB points at the sign-in itself, not an outage', /database is healthy/i.test(healthyCopy.body), healthyCopy.body);
  check('non-DB codes keep their own copy', /Access denied/i.test(errorCopy('AccessDenied', null).title));
}

// ---------- event bus (docs/specs/web-relay-event-bus.md §8) ----------

/**
 * The same contract against both backends — the in-process bus the relay falls
 * back to, and the real key layout driven through a command shim. Everything
 * downstream (the feed, live turns, presence) assumes exactly these semantics,
 * and the memory bus is what every other test here runs on.
 */
async function busContract(label: string, bus: Bus) {
  const u = `bus-${label}`;
  const first = await bus.publish(u, 'turn-started', 'c:1', { turnId: 't1' });
  const second = await bus.publish(u, 'turn-delta', 'c:1', { turnId: 't1', seq: 2 });
  check(`[${label}] publish returns a monotonic seq`, first === 1 && second === 2, `${first},${second}`);
  const head = await bus.head(u);
  check(`[${label}] cseq stays behind a turn-delta`, head.seq === 2 && head.cseq === 1, JSON.stringify(head));

  const all = await bus.read(u, 0);
  check(
    `[${label}] read returns the feed with its payloads`,
    all.events.length === 2 && all.events[0].kind === 'turn-started' && (all.events[1].payload as any)?.turnId === 't1',
    JSON.stringify(all.events)
  );
  check(`[${label}] read after a cursor returns only newer events`, (await bus.read(u, 1)).events.length === 1);
  check(`[${label}] read honours the limit`, (await bus.read(u, 0, 1)).events.length === 1);
  check(`[${label}] a caught-up reader sees no gap`, all.gap === false);

  // Past the window the feed is trimmed, and a client that was behind is told to
  // resync rather than handed a hole.
  for (let i = 0; i < 1100; i++) await bus.publish(u, 'read-state', 'c:1');
  const trimmed = await bus.read(u, 0);
  check(`[${label}] a reader behind the window sees a gap`, trimmed.gap === true);
  check(`[${label}] a reader inside the window does not`, (await bus.read(u, 1100)).gap === false);

  const t = `turn-${label}`;
  const base = newBlockStream();
  check(`[${label}] a base opens the log`, (await bus.turnAppend(t, { seq: 1, base })).ok);
  const second2 = await bus.turnAppend(t, { seq: 2, events: [{ kind: 'seg-delta', text: 'hi' }] });
  check(`[${label}] the next entry appends`, second2.ok === true && second2.len === 2, JSON.stringify(second2));
  const gapped = await bus.turnAppend(t, { seq: 9, events: [] });
  check(`[${label}] an out-of-order entry is refused with the expected seq`, gapped.ok === false && gapped.expected === 3, JSON.stringify(gapped));
  const entries = await bus.turnRead(t);
  check(`[${label}] the log reads back in order`, entries.length === 2 && !!entries[0].base && entries[1].seq === 2, JSON.stringify(entries));
  check(`[${label}] a base always wins`, (await bus.turnAppend(t, { seq: 1, base })).ok && (await bus.turnRead(t)).length === 1);
  await bus.turnClear(t);
  check(`[${label}] clearing drops the log`, (await bus.turnRead(t)).length === 0);
  check(`[${label}] an entry into a cleared log is refused from 1`, ((await bus.turnAppend(t, { seq: 1, events: [] })) as any).expected === 1);

  await bus.set(`sig:${label}`, 'yes', 1);
  check(`[${label}] a signal reads back`, (await bus.get([`sig:${label}`]))[0] === 'yes');
  await bus.del(`sig:${label}`);
  check(`[${label}] a deleted signal is gone`, (await bus.get([`sig:${label}`]))[0] === null);
  await bus.set(`ttl:${label}`, 'yes', 1);
  await new Promise((r) => setTimeout(r, 1100));
  check(`[${label}] a signal expires`, (await bus.get([`ttl:${label}`]))[0] === null);
}

async function busTests() {
  await busContract('memory', new MemoryBus());
  await busContract('redis', new RedisBus(new MemoryRedis()));

  // The INCR→XADD race: another publish for the same user landed a higher id
  // first, so ours is refused by the stream. It must take a fresh seq, not fail
  // the request (and trip the desktop's breaker).
  const redis = new MemoryRedis();
  const raced = new RedisBus(redis);
  await raced.publish('race', 'read-state', null);
  await redis.pipeline().xadd('ev:race', '3-0', { k: 'read-state', c: '', p: 'null', t: 0 }).exec();
  check('a publish that loses the id race takes the next free seq', (await raced.publish('race', 'read-state', null)) === 4);
  check('…and the feed still reads back in order', (await raced.read('race', 0)).events.map((e) => e.seq).join(',') === '1,3,4');

  const health = await jbody(await webHealth(webReq('/api/health')));
  check('/api/health reports which bus the relay got', health.bus === 'memory', JSON.stringify(health));
  const real = getBus();
  __setBus(new RedisBus(new MemoryRedis()));
  check('/api/health reports redis when one is wired in', (await jbody(await webHealth(webReq('/api/health')))).bus === 'redis');
  __setBus(real);

  // The client-side reducer: anything it can't apply in order must fall back to
  // a refetch, which is what keeps a lost delta from corrupting the transcript.
  const held = { stream: newBlockStream(), deltaSeq: 1 };
  check('applyDelta applies the next entry', applyDelta(held, { deltaSeq: 2, events: [{ kind: 'seg-delta', text: 'hi' }] }) === 'applied');
  check('applyDelta folded the events in', snapshotBlocks(held.stream).length === 1 && (snapshotBlocks(held.stream)[0] as any).text === 'hi');
  check('applyDelta refetches on a gap', applyDelta(held, { deltaSeq: 9, events: [] }) === 'refetch');
  check('applyDelta refetches on a base', applyDelta(held, { deltaSeq: 3, base: true }) === 'refetch');
  check('applyDelta refetches with nothing held', applyDelta(undefined, { deltaSeq: 1, events: [] }) === 'refetch');
  check('a refused delta left the stream alone', held.deltaSeq === 2 && snapshotBlocks(held.stream).length === 1);
}

/**
 * Live turns as deltas (§3). The desktop opens the turn with a PUT and streams
 * the block events; the relay keeps them on the bus and reduces them on read, so
 * a streaming turn costs two Neon writes instead of two a second — and the phone
 * reads exactly the blocks the desktop holds.
 */
async function deltaTests() {
  const db = await getDb();
  const conv = 'wsG:1';
  await db
    .insert(conversations)
    .values({ id: conv, userId: USER_ID, workspaceId: 'wsG', agentId: 1, title: 'delta conv', harness: 'claude-code', state: 'idle' })
    .onConflictDoNothing();
  const turnId = 'turnG-1';
  const turnPath = `/api/conversations/${encodeURIComponent(conv)}/turn`;
  const deltaPath = `${turnPath}/${turnId}/deltas`;
  const putTurn = (body: unknown) => putConvTurn(deviceReq(turnPath, { method: 'PUT', body: JSON.stringify(body) }), { id: conv });
  const postDelta = (body: unknown) =>
    postConvTurnDeltas(deviceReq(deltaPath, { method: 'POST', body: JSON.stringify(body) }), { id: conv, turnId });
  const readTurn = async () => (await jbody(await webTurn(webReq(`${turnPath}s/${turnId}`), { id: conv, turnId }))).turn;

  const cursor0 = await latestSeq(USER_ID);
  check('turn start accepted', (await putTurn({ turnId, status: 'running', blocks: [], startedAt: Date.now() })).status === 200);
  const startEvents = (await eventsSince(USER_ID, cursor0)).map((e) => e.kind);
  check('turn start announces turn-started', startEvents.includes('turn-started'), JSON.stringify(startEvents));
  check('turn start opens an empty log', (await getBus().turnRead(turnId)).length === 1);
  const opened = await readTurn();
  check('a just-opened turn reads back empty', opened.status === 'running' && opened.blocks.length === 0 && opened.deltaSeq === 1, JSON.stringify(opened));

  // The desktop's own accumulator, fed the same events — the relay must agree
  // block for block, because both run `applyBlockEvent`.
  const evs: AgentEvent[] = [
    { kind: 'seg-start', segType: 'text' },
    { kind: 'seg-delta', text: 'Hello ' },
    { kind: 'seg-delta', text: 'world' },
    { kind: 'tool-start', toolId: 'T1', name: 'bash', input: { cmd: 'ls' } },
    { kind: 'tool-result', toolId: 'T1', ok: true, summary: 'ok' },
  ];
  const desktop = newBlockStream();
  for (const e of evs) applyBlockEvent(desktop, e);

  const cursor1 = await latestSeq(USER_ID);
  const first = await jbody(await postDelta({ seq: 2, events: evs.slice(0, 3) }));
  check('a delta entry is accepted and names the next seq', first.next === 3, JSON.stringify(first));
  check('a second entry follows it', (await jbody(await postDelta({ seq: 3, events: evs.slice(3) }))).next === 4);
  const outOfOrder = await postDelta({ seq: 9, events: [] });
  check(
    'an out-of-order entry is refused with the expected seq',
    outOfOrder.status === 409 && (await jbody(outOfOrder)).expected === 4,
    `${outOfOrder.status}`
  );

  const streaming = await readTurn();
  check(
    'a running turn reduces to exactly the desktop blocks',
    JSON.stringify(streaming.blocks) === JSON.stringify(snapshotBlocks(desktop)),
    JSON.stringify(streaming.blocks)
  );
  check('a running turn carries the stream + deltaSeq to resume from', streaming.deltaSeq === 3 && !!streaming.stream, JSON.stringify(streaming.deltaSeq));
  const slice = await jbody(await webTurns(webReq(`${turnPath}s`), { id: conv }));
  check(
    'the transcript read reduces the running turn the same way',
    JSON.stringify(slice.turns.find((t: any) => t.id === turnId)?.blocks) === JSON.stringify(snapshotBlocks(desktop))
  );
  const [rawRow] = await db.select().from(turns).where(eq(turns.id, turnId));
  check('a streaming turn never writes blocks to the database', JSON.stringify(rawRow.blocks) === '[]', JSON.stringify(rawRow.blocks));

  const deltaFrames = await sseFrames(cursor1, (f) => f.deltaSeq === 3);
  const sent = deltaFrames.find((f) => f.kind === 'turn-delta' && f.deltaSeq === 2);
  check('SSE forwards the block events', sent?.turnId === turnId && sent?.events?.length === 3 && sent?.base === false, JSON.stringify(sent));

  // Finalize: the full blocks land in the store and the live log is done with.
  check(
    'terminal PUT accepted',
    (await putTurn({ turnId, status: 'done', blocks: [{ type: 'text', text: 'Hello world' }], meta: { costUsd: 1 }, endedAt: Date.now() })).status === 200
  );
  check('finalize clears the live log', (await getBus().turnRead(turnId)).length === 0);
  const ended = await readTurn();
  check('a finalized turn reads its stored blocks', ended.status === 'done' && !ended.stream && blockText(ended.blocks) === 'Hello world', JSON.stringify(ended));
  // The phone may keep a finalized turn forever; a running one never.
  const cached = await webTurn(webReq(`${turnPath}s/${turnId}`), { id: conv, turnId });
  check('a finalized turn is immutably cacheable', cached.headers.get('cache-control') === 'private, max-age=31536000, immutable', String(cached.headers.get('cache-control')));

  // An old desktop still PUTs whole snapshots: they become a base, so it stays
  // linear on the store too (its bandwidth is its own problem).
  const oldTurn = 'turnG-2';
  await putConvTurn(deviceReq(turnPath, { method: 'PUT', body: JSON.stringify({ turnId: oldTurn, status: 'running', blocks: [] }) }), { id: conv });
  const cursor2 = await latestSeq(USER_ID);
  await putConvTurn(
    deviceReq(turnPath, { method: 'PUT', body: JSON.stringify({ turnId: oldTurn, status: 'running', blocks: [{ type: 'text', text: 'snapshot' }] }) }),
    { id: conv }
  );
  const [oldRow] = await db.select().from(turns).where(eq(turns.id, oldTurn));
  check('an old-desktop snapshot writes no blocks to the database', JSON.stringify(oldRow.blocks) === '[]', JSON.stringify(oldRow.blocks));
  const oldResp = await webTurn(webReq(`${turnPath}s/${oldTurn}`), { id: conv, turnId: oldTurn });
  const oldRead = await jbody(oldResp);
  check('an old-desktop snapshot still reaches the phone', blockText(oldRead.turn.blocks) === 'snapshot', JSON.stringify(oldRead.turn.blocks));
  check('a running turn is never cached', oldResp.headers.get('cache-control') === 'no-store', String(oldResp.headers.get('cache-control')));
  const baseFrame = (await sseFrames(cursor2, (f) => f.kind === 'turn-delta')).find((f) => f.kind === 'turn-delta');
  check('the base itself never rides the feed', baseFrame?.base === true && !JSON.stringify(baseFrame).includes('snapshot'), JSON.stringify(baseFrame));

  // Box turns take the same path: the journal chunk publishes a delta instead of
  // rewriting the row, which is also what finally makes them stream to the phone.
  const convBox = 'wsH:1';
  await seedConversation(convBox);
  const boxTurn = 'turnH-1';
  const chunk =
    [`{"maestro":"turn-start","turnId":"${boxTurn}","at":1}`, `{"type":"assistant","message":{"content":[{"type":"text","text":"from the box"}]}}`].join('\n') +
    '\n';
  const cursor3 = await latestSeq(USER_ID);
  const r = await fetch(`${BASE}/api/box/journal`, {
    method: 'POST',
    headers: { ...boxHeaders, 'maestro-conversation': convBox, 'maestro-from-offset': '0' },
    body: chunk,
  });
  check('journal chunk accepted', r.status === 200);
  const boxKinds = (await eventsSince(USER_ID, cursor3)).map((e) => e.kind);
  check('a box journal chunk publishes a turn-delta', boxKinds.includes('turn-delta'), JSON.stringify(boxKinds));
  const [boxRow] = await db.select().from(turns).where(eq(turns.id, boxTurn));
  check('a streaming box turn writes no blocks to the database', JSON.stringify(boxRow.blocks) === '[]', JSON.stringify(boxRow.blocks));
  const boxRead = await jbody(
    await webTurn(webReq(`/api/conversations/${encodeURIComponent(convBox)}/turns/${boxTurn}`), { id: convBox, turnId: boxTurn })
  );
  check('a streaming box turn reaches the phone', blockText(boxRead.turn.blocks) === 'from the box', JSON.stringify(boxRead.turn.blocks));
}

/**
 * Idle = zero (§4). The relay is time-billed, so the thing to prove is not that
 * a poll is small but that an idle one is *absent* from the database entirely —
 * and that nothing is lost by it: a job still arrives within a heartbeat, and a
 * desktop that was away still finds its work.
 */
async function pollTests() {
  const db = await getDb();
  const bus = getBus();
  const conv = 'wsE:1';
  const poll = (q: string) => devicePoll(deviceReq(`/api/device/poll?${q}`));
  const ws = { id: 'wsE', deviceId: DEVICE_ID, isCloud: false, boxId: null };
  const enqueue = (kind: string) =>
    enqueueJob({ userId: USER_ID, conversationId: conv, workspaceId: 'wsE', ws, kind, payload: {}, emit: false });

  await bus.del(watchKey(USER_ID));
  await poll('wait=0&cursor=0'); // settle presence, so the next beat has nothing to do
  const cursor = await latestSeq(USER_ID);
  const before = __dbStatements();
  const beat = await jbody(await poll(`wait=0&cursor=${cursor}`));
  check('an idle heartbeat runs ZERO database statements', __dbStatements() === before, `${__dbStatements() - before} statements`);
  check('an idle heartbeat reports no watcher and the idle cadence', beat.watch === false && beat.idleWait === 30, JSON.stringify(beat));

  await sseFrames(cursor, () => false); // one SSE connect marks the account watched
  check('a connected SSE client flips watch on', (await jbody(await poll(`wait=0&cursor=${cursor}`))).watch === true);

  const job = await enqueue('git_refresh');
  check('enqueueJob sets the wake flag', job.ok && !!(await bus.get([wakeKey('d', DEVICE_ID)]))[0], JSON.stringify(job));
  const woke = await jbody(await poll(`wait=0&cursor=${cursor}`));
  check('the next heartbeat delivers the job', woke.jobs.some((j: any) => j.id === job.jobId), JSON.stringify(woke.jobs));
  check('delivering it clears the wake flag', !(await bus.get([wakeKey('d', DEVICE_ID)]))[0]);
  await db.update(jobs).set({ ackedAt: new Date(), status: 'done' }).where(eq(jobs.id, job.jobId!));

  // A wake flag can be lost (TTL, a bus restart); coming back online must not be.
  await db.insert(jobs).values({ id: 'job-stale-1', deviceId: DEVICE_ID, conversationId: conv, workspaceId: 'wsE', kind: 'git_refresh', payload: {} as any, status: 'pending' });
  await bus.del(seenKey('d', DEVICE_ID));
  await bus.del(wakeKey('d', DEVICE_ID));
  const back = await jbody(await poll(`wait=0&cursor=${cursor}`));
  check('a desktop that just came back reads its jobs with no flag at all', back.jobs.some((j: any) => j.id === 'job-stale-1'), JSON.stringify(back.jobs));
  await db.update(jobs).set({ ackedAt: new Date(), status: 'done' }).where(eq(jobs.id, 'job-stale-1'));

  const evCursor = await latestSeq(USER_ID);
  await appendEvent(USER_ID, 'turn-delta', conv, { turnId: 'nope', seq: 2, events: [] });
  await appendEvent(USER_ID, 'read-state', conv, { lastReadAt: 1 });
  const evs = await jbody(await poll(`wait=0&cursor=${evCursor}`));
  check(
    'executors never receive turn-delta',
    evs.events.every((e: any) => e.kind !== 'turn-delta') && evs.events.some((e: any) => e.kind === 'read-state'),
    JSON.stringify(evs.events.map((e: any) => e.kind))
  );
  check('the cursor still advances past the deltas it skipped', evs.next > evCursor, `${evs.next} vs ${evCursor}`);
}

/** Presence, off the bus (§4.2) — the column is now written once per wake-up, so
 *  everything that renders a dot has to read the bus or it would decay a healthy
 *  desktop to "offline" after a minute. */
async function presenceTests() {
  const db = await getDb();
  const bus = getBus();
  const deviceOf = (p: any) => p.devices.find((d: any) => d.id === DEVICE_ID);

  await devicePoll(deviceReq(`/api/device/poll?wait=1&cursor=${await latestSeq(USER_ID)}`));
  await db.update(devices).set({ lastSeenAt: new Date(0) }).where(eq(devices.id, DEVICE_ID));
  const held = await presenceSnapshot(USER_ID);
  check('presence reads the bus, not the (now write-once) column', Date.now() - deviceOf(held).lastSeenAt < 60_000, JSON.stringify(deviceOf(held)));
  check('a long-polling desktop reports live', deviceOf(held).live === true, JSON.stringify(deviceOf(held)));
  await bus.del(liveKey(DEVICE_ID));
  const standby = await presenceSnapshot(USER_ID);
  check('a standby desktop is online but not live', deviceOf(standby).live === false && Date.now() - deviceOf(standby).lastSeenAt < 60_000, JSON.stringify(deviceOf(standby)));
  const fleet = await jbody(await webWorkspaces(webReq('/api/workspaces')));
  check('the fleet reads the same presence', fleet.devices.find((d: any) => d.id === DEVICE_ID)?.online === true, JSON.stringify(fleet.devices));

  // The enqueue gate reads it too — otherwise every action would 409 a minute
  // after the desktop's last wake-up.
  const ws = { id: 'wsE', deviceId: DEVICE_ID, isCloud: false, boxId: null };
  const enqueue = () => enqueueJob({ userId: USER_ID, conversationId: 'wsE:1', workspaceId: 'wsE', ws, kind: 'git_refresh', payload: {}, emit: false });
  await bus.del(seenKey('d', DEVICE_ID));
  const offline = await enqueue();
  check('the enqueue gate 409s a desktop the bus has not seen', !offline.ok && offline.status === 409, JSON.stringify(offline));
  await devicePoll(deviceReq('/api/device/poll?wait=0&cursor=0'));
  const backOnline = await enqueue();
  check('and lets it through once it heartbeats', backOnline.ok, JSON.stringify(backOnline));
  await db.delete(jobs).where(eq(jobs.id, backOnline.jobId!));

  // Box metadata repeats on every poll; it must only reach the store on change.
  const boxPollReq = (shim: string) =>
    boxPoll(new Request(`${BASE}/api/box/poll?wait=0&shim=${shim}&uname=Linux&qd=0`, { headers: boxHeaders }));
  await boxPollReq('shim-aaa');
  const [first] = await db.select().from(boxes).where(eq(boxes.id, BOX_ID));
  check('a box poll writes its metadata once', first.shimHash === 'shim-aaa', String(first.shimHash));
  const stmts = __dbStatements();
  await boxPollReq('shim-aaa');
  check('an unchanged box poll writes nothing at all', __dbStatements() === stmts, `${__dbStatements() - stmts} statements`);
  await boxPollReq('shim-bbb');
  const [changed] = await db.select().from(boxes).where(eq(boxes.id, BOX_ID));
  check('a changed shim hash is written through', changed.shimHash === 'shim-bbb', String(changed.shimHash));
}

/** Events carry the row they changed (§6): one SSE frame instead of a fetch per
 *  open tab, with the fetch path still there for anything too big to inline. */
async function rowEventTests() {
  const cursor = await latestSeq(USER_ID);
  await putWorkspace(
    deviceReq('/api/workspaces/wsE', { method: 'PUT', body: JSON.stringify({ projectId: 'projE', title: 'renamed' }) }),
    { id: 'wsE' }
  );
  const ev = (await sseFrames(cursor, (f) => f.kind === 'workspace-updated')).find((f) => f.kind === 'workspace-updated');
  check('workspace-updated carries the row it changed', ev?.workspace?.id === 'wsE' && ev.workspace.title === 'renamed', JSON.stringify(ev)?.slice(0, 200));
  check('…and that workspace’s sessions', ev?.sessions?.some((s: any) => s.conversationId === 'wsE:1'), JSON.stringify(ev?.sessions));
  check('…in the lean fleet shape, not the panel one', ev && !('git' in ev.workspace), JSON.stringify(Object.keys(ev?.workspace ?? {})));

  const convCursor = await latestSeq(USER_ID);
  await putConversation(
    deviceReq('/api/conversations/wsE:1', { method: 'PUT', body: JSON.stringify({ workspaceId: 'wsE', agentId: 1, title: 'renamed chat', harness: 'claude-code' }) }),
    { id: 'wsE:1' }
  );
  const cev = (await sseFrames(convCursor, (f) => f.kind === 'conversation-updated')).find((f) => f.kind === 'conversation-updated');
  check('conversation-updated carries its session row', cev?.session?.conversationId === 'wsE:1' && cev.session.title === 'renamed chat', JSON.stringify(cev)?.slice(0, 200));

  const bigCursor = await latestSeq(USER_ID);
  await appendEvent(USER_ID, 'workspace-updated', 'wsE:1', { workspace: { id: 'wsE', title: 'x'.repeat(9000) } });
  const big = (await sseFrames(bigCursor, (f) => f.kind === 'workspace-updated')).find((f) => f.kind === 'workspace-updated');
  check('an oversized payload falls back to id-only', !!big && !big.workspace, JSON.stringify(big)?.slice(0, 120));
}

// ---------- Neon usage diet (docs/specs/web-neon-usage-diet.md §4) ----------

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const STATUS_V2 = '# branch.head main\n# branch.ab +1 -0\n1 .M N... 100644 100644 100644 aaa bbb a.ts\n';
const patchFor = (line: string) =>
  ['diff --git a/a.ts b/a.ts', 'index 111..222 100644', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1,2 @@', ' old', `+${line}`].join('\n') + '\n';

/**
 * §3.1 — the box reports git every 30s per cloud workspace, forever. Before this
 * the report was unconditional: a select, an update, a diff upsert and a fleet
 * event, 2,880 times a day per workspace, usually for a byte-identical diff. The
 * claim being tested is narrow and exact: an unchanged `hash` costs ONE statement
 * (the ownership select) and emits nothing.
 */
async function boxGitTests() {
  const db = await getDb();
  await db
    .insert(workspaces)
    .values({ id: 'wsBox', userId: USER_ID, deviceId: DEVICE_ID, projectId: 'projBox', isCloud: true, boxId: BOX_ID, title: 'cloud ws' })
    .onConflictDoNothing();
  const report = (hash: string, line: string) =>
    boxWorkspaceGit(
      new Request(`${BASE}/api/box/workspaces/wsBox/git`, {
        method: 'POST',
        headers: boxHeaders,
        body: JSON.stringify({ base: 'main', statusB64: b64(STATUS_V2), patchB64: b64(patchFor(line)), hash }),
      }),
      { id: 'wsBox' }
    );

  const firstCursor = await latestSeq(USER_ID);
  const first = await jbody(await report('hash-1', 'one'));
  check('a first box git report is written through', first.ok === true && !first.unchanged, JSON.stringify(first));
  const kinds1 = (await eventsSince(USER_ID, firstCursor)).map((e) => e.kind);
  check('…and announces diff-updated', kinds1.includes('diff-updated'), JSON.stringify(kinds1));
  const [afterFirst] = await db.select().from(workspaces).where(eq(workspaces.id, 'wsBox'));
  check('…storing the hash it was given', afterFirst.gitHash === 'hash-1', String(afterFirst.gitHash));
  check('…and the parsed diff', afterFirst.diffAdd === 1 && afterFirst.changedFiles >= 0, `add ${afterFirst.diffAdd}`);

  const sameCursor = await latestSeq(USER_ID);
  const before = __dbStatements();
  const same = await jbody(await report('hash-1', 'one'));
  const cost = __dbStatements() - before;
  check('an unchanged box git report answers {unchanged:true}', same.ok === true && same.unchanged === true, JSON.stringify(same));
  check('…costing exactly the ownership select', cost === 1, `${cost} statements`);
  check('…and emitting nothing at all', (await eventsSince(USER_ID, sameCursor)).length === 0, JSON.stringify((await eventsSince(USER_ID, sameCursor)).map((e) => e.kind)));

  const changedCursor = await latestSeq(USER_ID);
  const changed = await jbody(await report('hash-2', 'two lines now\n+three'));
  check('a changed hash is written through', changed.ok === true && !changed.unchanged, JSON.stringify(changed));
  const [afterSecond] = await db.select().from(workspaces).where(eq(workspaces.id, 'wsBox'));
  check('…and the stored hash moves with it', afterSecond.gitHash === 'hash-2', String(afterSecond.gitHash));
  check('…re-announcing diff-updated', (await eventsSince(USER_ID, changedCursor)).some((e) => e.kind === 'diff-updated'));
  const [diffRow] = await db.select().from(workspaceDiffs).where(eq(workspaceDiffs.workspaceId, 'wsBox'));
  check('…and upserting the diff snapshot', !!diffRow && diffRow.producedBy === 'box', JSON.stringify(diffRow?.producedBy));

  // An archived workspace's row is deleted (§3.5), so its report 404s — which is
  // what tells the shim to drop its marker and stop reporting.
  const gone = await report('hash-3', 'orphan');
  await db.delete(workspaces).where(eq(workspaces.id, 'wsBox'));
  check('a live workspace still accepts reports', gone.status === 200, `${gone.status}`);
  const orphan = await report('hash-4', 'orphan');
  check('a deleted workspace 404s the report', orphan.status === 404, `${orphan.status}`);
}

/** §3.3 — presence rides the SSE stream: the first frame, before any event. */
async function presenceFrameTests() {
  const sse = await webStream(webReq(`/api/stream?cursor=${await latestSeq(USER_ID)}&maxMs=300`));
  const reader = (sse.body as any).getReader();
  const dec = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    if (text.includes('event: presence')) break;
  }
  await reader.cancel().catch(() => {});
  const names = text.split('\n').filter((l) => l.startsWith('event: ')).map((l) => l.slice(7).trim());
  check('the stream opens with a presence frame', names[0] === 'presence', JSON.stringify(names));
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const frame = line ? JSON.parse(line.slice(6)) : null;
  check(
    'the presence frame carries the linked desktop, bus-only',
    frame?.kind === 'presence' && frame.devices?.some((d: any) => d.id === DEVICE_ID && typeof d.live === 'boolean'),
    JSON.stringify(frame)
  );
  check('…and the linked box', frame?.boxes?.some((b: any) => b.id === BOX_ID), JSON.stringify(frame?.boxes));
}

/** §3.4 — the link summary is bus-cached, and every revoke path drops it. Stale
 *  in one direction only: a revoke must be visible on the very next read. */
async function linkSummaryTests() {
  const db = await getDb();
  const LINK_USER = 'user-link';
  await db.insert(users).values({ id: LINK_USER, githubId: 'gh-link', login: 'linker' }).onConflictDoNothing();
  await db
    .insert(boxes)
    .values({ id: 'box-link', userId: LINK_USER, label: 'link box', tokenHash: hashToken('link-box-token') })
    .onConflictDoNothing();
  await forgetLinkSummary(LINK_USER);

  check('a user with a live box has a link', (await hasLiveLink(LINK_USER)) === true);
  // Revoke behind the cache's back: the answer must NOT change, or the gate is
  // still querying Postgres on every web read (which is the thing being fixed).
  await db.update(boxes).set({ revokedAt: new Date() }).where(eq(boxes.id, 'box-link'));
  check('hasLiveLink is answered from the bus, not the database', (await hasLiveLink(LINK_USER)) === true);
  await forgetLinkSummary(LINK_USER);
  check('…and invalidating the summary reveals the revoke', (await hasLiveLink(LINK_USER)) === false);

  // The real path: the revoke HANDLER invalidates, so the next read is honest
  // with no help from the test.
  await db
    .insert(boxes)
    .values({ id: 'box-link-2', userId: LINK_USER, label: 'link box 2', tokenHash: hashToken('link-box-token-2') })
    .onConflictDoNothing();
  await forgetLinkSummary(LINK_USER);
  check('a newly registered box relinks the account', (await hasLiveLink(LINK_USER)) === true);
  await revokeBox(userReq(LINK_USER, '/api/boxes/box-link-2', { method: 'DELETE' }), { id: 'box-link-2' });
  check('revoking it through the handler unlinks on the NEXT read', (await hasLiveLink(LINK_USER)) === false);

  // A revoked box's shim retried about once a minute, and every 401 was a Postgres
  // read — alone enough to keep Neon awake around the clock (neon-idle-compute).
  // Run it on the Upstash-shaped bus: Upstash parses stored values, and the old
  // cached `"null"` came back as a miss there while MemoryBus kept it (round 4).
  const linkBus = getBus();
  __setBus(new RedisBus(new MemoryRedis()));
  const deadPoll = () =>
    boxPoll(new Request(`${BASE}/api/box/poll?wait=0`, { headers: { authorization: 'Bearer link-box-token-2' } }));
  check('a revoked box token is rejected', (await deadPoll()).status === 401);
  const beforeRetry = __dbStatements();
  const retry = await deadPoll();
  check(
    '…and its retries are rejected from the bus, not the database',
    retry.status === 401 && __dbStatements() === beforeRetry,
    `${__dbStatements() - beforeRetry} statements`
  );
  const deadDevice = () => resolveDevice(new Request(`${BASE}/api/device/poll`, { headers: { authorization: 'Bearer no-such-desktop' } }));
  await deadDevice();
  const beforeDevice = __dbStatements();
  check('an unknown desktop token is rejected from the bus on retry', (await deadDevice()) === null && __dbStatements() === beforeDevice);
  __setBus(linkBus);

  // The desktop heals a box link the relay revoked by comparing against this list.
  const listed = await jbody(await deviceList(deviceReq('/api/devices')));
  check('/api/devices lists the live box ids', Array.isArray(listed.boxes) && listed.boxes.includes(BOX_ID), JSON.stringify(listed.boxes));
}

/** §3.6 — attachments dedupe by content hash: a relink re-uploads every embedded
 *  screenshot, and each one used to be a new multi-megabyte row. */
async function attachmentTests() {
  const db = await getDb();
  const dataUrl = `data:image/png;base64,${Buffer.from('the same pixels').toString('base64')}`;
  const post = (body: unknown) => postAttachment(deviceReq('/api/attachments', { method: 'POST', body: JSON.stringify(body) }));
  const countMine = async () =>
    (await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.userId, USER_ID))).length;

  const before = await countMine();
  const firstUp = await jbody(await post({ dataUrl }));
  check('a fresh upload returns an id + url', !!firstUp.id && firstUp.url === `/api/attachments/${firstUp.id}` && !firstUp.deduped, JSON.stringify(firstUp));
  const afterFirst = await countMine();
  const second = await jbody(await post({ dataUrl, workspaceId: 'wsE' }));
  check('re-uploading the same bytes returns the same row', second.id === firstUp.id && second.deduped === true, JSON.stringify(second));
  check('…and inserts nothing', (await countMine()) === afterFirst && afterFirst === before + 1, `${await countMine()} rows`);
  const [row] = await db.select().from(attachments).where(eq(attachments.id, firstUp.id));
  check('…but stamps the workspace it now belongs to', row.workspaceId === 'wsE', String(row.workspaceId));
  check('…and stores the content hash', typeof row.sha256 === 'string' && row.sha256!.length === 64, String(row.sha256));
  const other = await jbody(await post({ dataUrl: `data:image/png;base64,${Buffer.from('different pixels').toString('base64')}` }));
  check('different bytes are a different row', other.id !== firstUp.id && !other.deduped, JSON.stringify(other));
  await db.delete(attachments).where(eq(attachments.id, other.id));
}

/** Agent messaging (docs/specs/agent-messaging.md): a desktop reads the user's
 *  fleet and sends into another machine's chat with its DEVICE token, and an
 *  agent-sent message reaches the owning desktop's job with `origin: 'agent'`. */
async function agentMessagingTests() {
  const db = await getDb();
  const WS = 'wsPeer';
  const CONV = `${WS}:1`;
  await db.insert(workspaces).values({ id: WS, userId: USER_ID, deviceId: DEVICE_ID, projectId: 'projP', title: 'peer', name: 'lisbon-v4' });
  await db.insert(conversations).values({ id: CONV, userId: USER_ID, workspaceId: WS, agentId: 1, title: 'peer chat' });

  const fleet = await webWorkspaces(deviceReq('/api/workspaces'));
  const fleetBody = await jbody(fleet);
  check('a device token can read the fleet', fleet.status === 200 && fleetBody.workspaces.some((w: any) => w.id === WS), `${fleet.status}`);
  check('…which tells the desktop its own device id', fleetBody.selfDeviceId === DEVICE_ID, String(fleetBody.selfDeviceId));
  const sessionFleet = await jbody(await webWorkspaces(webReq('/api/workspaces')));
  check('…and a web session gets no selfDeviceId', !('selfDeviceId' in sessionFleet));
  const anon = await webWorkspaces(new Request(`${BASE}/api/workspaces`));
  check('…and an unauthenticated read is still refused', anon.status === 401, `${anon.status}`);

  const send = (body: unknown) =>
    webSend(deviceReq(`/api/conversations/${CONV}/send`, { method: 'POST', body: JSON.stringify(body) }), { id: CONV });
  const sent = await send({ text: 'hi\n\n[Sent by the agent in "geneva-v3" (p). Reply with: maestro-message send geneva-v3]', origin: 'agent' });
  const sentBody = await jbody(sent);
  check('a device token can send into another chat', sent.status === 200 && !!sentBody.messageId, JSON.stringify(sentBody));
  const [job] = await db.select().from(jobs).where(eq(jobs.workspaceId, WS));
  check('…routed to the owning desktop', job?.deviceId === DEVICE_ID && job?.kind === 'message', JSON.stringify(job));
  check("…with origin 'agent' in the job payload", (job?.payload as any)?.origin === 'agent', JSON.stringify(job?.payload));
  await db.delete(jobs).where(eq(jobs.workspaceId, WS));
  await send({ text: 'plain', origin: 'something-else' });
  const [plain] = await db.select().from(jobs).where(eq(jobs.workspaceId, WS));
  check('any other origin is dropped (defaults to web)', !!plain && (plain.payload as any)?.origin === undefined, JSON.stringify(plain?.payload));

  // The relay row a cross-machine send creates is origin 'web' (the desktop needs
  // that to apply it); the desktop's republish promotes it to 'agent', and a
  // republish with any other origin leaves the column alone.
  const origin = async (id: string) => (await db.select({ o: userMessages.origin }).from(userMessages).where(eq(userMessages.id, id)))[0]?.o;
  const republish = (m: any) =>
    backfill(deviceReq(`/api/conversations/${CONV}/backfill`, { method: 'POST', body: JSON.stringify({ userMessages: [m] }) }), { id: CONV });
  check("the cross-machine row starts as origin 'web'", (await origin(sentBody.messageId)) === 'web');
  await republish({ id: sentBody.messageId, text: 'hi', origin: 'agent', queued: false });
  check("…and the desktop's republish marks it 'agent'", (await origin(sentBody.messageId)) === 'agent');
  const webSent = await jbody(await webSend(webReq(`/api/conversations/${CONV}/send`, { method: 'POST', body: JSON.stringify({ text: 'from the phone' }) }), { id: CONV }));
  await republish({ id: webSent.messageId, text: 'from the phone', origin: 'desktop', queued: false });
  check("a web message's origin is untouched by a republish", (await origin(webSent.messageId)) === 'web');

  await wsDeleteRoute(deviceReq(`/api/workspaces/${WS}`, { method: 'DELETE' }), { id: WS });
}

/** §3.5 — DELETE /api/workspaces/:id takes everything with it. There are no
 *  foreign keys, so "cascade" is this function and nothing else. */
async function cascadeTests() {
  const db = await getDb();
  const WS = 'wsCascade';
  const CONV = `${WS}:1`;
  await db.insert(workspaces).values({ id: WS, userId: USER_ID, deviceId: DEVICE_ID, projectId: 'projX', title: 'doomed' });
  await db.insert(conversations).values({ id: CONV, userId: USER_ID, workspaceId: WS, agentId: 1, title: 'doomed chat' });
  await db.insert(turns).values({ id: 'turn-cascade', conversationId: CONV, status: 'done', blocks: [] as any });
  await db.insert(userMessages).values({ id: 'msg-cascade', conversationId: CONV, text: 'bye', origin: 'web' });
  await db.insert(journalCursors).values({ conversationId: CONV });
  await db.insert(readState).values({ userId: USER_ID, conversationId: CONV });
  await db.insert(jobs).values({ id: 'job-cascade', deviceId: DEVICE_ID, conversationId: CONV, workspaceId: WS, kind: 'message', payload: {} as any });
  await db.insert(attachments).values({ id: 'att-cascade', userId: USER_ID, dataUrl: 'data:image/png;base64,QQ==', sha256: 'cascade-sha', workspaceId: WS });
  await db.insert(workspaceDiffs).values({ workspaceId: WS, base: 'main', files: [] as any });

  const resp = await wsDeleteRoute(deviceReq(`/api/workspaces/${WS}`, { method: 'DELETE' }), { id: WS });
  check('the device delete answers 200', resp.status === 200, `${resp.status}`);
  const counts: Record<string, number> = {
    workspaces: (await db.select().from(workspaces).where(eq(workspaces.id, WS))).length,
    workspace_diffs: (await db.select().from(workspaceDiffs).where(eq(workspaceDiffs.workspaceId, WS))).length,
    conversations: (await db.select().from(conversations).where(eq(conversations.workspaceId, WS))).length,
    turns: (await db.select().from(turns).where(eq(turns.conversationId, CONV))).length,
    user_messages: (await db.select().from(userMessages).where(eq(userMessages.conversationId, CONV))).length,
    journal_cursors: (await db.select().from(journalCursors).where(eq(journalCursors.conversationId, CONV))).length,
    read_state: (await db.select().from(readState).where(eq(readState.conversationId, CONV))).length,
    jobs: (await db.select().from(jobs).where(eq(jobs.workspaceId, WS))).length,
    attachments: (await db.select().from(attachments).where(eq(attachments.workspaceId, WS))).length,
  };
  check('deleting a workspace leaves NO row behind in any table', Object.values(counts).every((n) => n === 0), JSON.stringify(counts));
  // The desktop retries a non-2xx every 5 minutes, forever — "already gone" is
  // the success case, not a 404.
  const again = await wsDeleteRoute(deviceReq(`/api/workspaces/${WS}`, { method: 'DELETE' }), { id: WS });
  check('deleting an already-deleted workspace is still 200', again.status === 200, `${again.status}`);

  // A delete from the web is a job for the desktop, and the cascade must NOT run
  // until the desktop calls back — `jobs` is keyed by workspace_id, so cascading
  // here would eat the very workspace_delete job just enqueued.
  await db.insert(workspaces).values({ id: WS, userId: USER_ID, deviceId: DEVICE_ID, projectId: 'projX', title: 'doomed later' });
  await devicePoll(deviceReq('/api/device/poll?wait=0&cursor=0'));
  const fromWeb = await jbody(await wsDelete(webReq(`/api/workspaces/${WS}`, { method: 'DELETE', body: '{}' }), { id: WS }));
  check('a web delete enqueues a workspace_delete job', fromWeb.ok === true && !!fromWeb.jobId, JSON.stringify(fromWeb));
  const [pendingDelete] = await db.select({ kind: jobs.kind, status: jobs.status }).from(jobs).where(eq(jobs.id, fromWeb.jobId));
  check('…that is still waiting for the desktop', pendingDelete?.kind === 'workspace_delete' && pendingDelete.status === 'pending', JSON.stringify(pendingDelete));
  const [stillThere] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, WS));
  check('…and the relay row stays until the desktop calls back', !!stillThere);
  await wsDeleteRoute(deviceReq(`/api/workspaces/${WS}`, { method: 'DELETE' }), { id: WS });
  check('the desktop callback then takes the job with the rest', (await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, fromWeb.jobId))).length === 0);
}

/** §3.7 — "unlink = purge" has to mean it: the purge used to leave `workspaces`,
 *  `workspace_diffs` and every attachment behind. */
async function purgeTests() {
  const db = await getDb();
  const U = 'user-purge';
  const WS = 'wsPurge';
  const CONV = `${WS}:1`;
  await db.insert(users).values({ id: U, githubId: 'gh-purge', login: 'purger' }).onConflictDoNothing();
  await db.insert(devices).values({ id: 'dev-purge', userId: U, kind: 'desktop', name: 'purge desktop', tokenHash: hashToken('purge-device-token') });
  await db.insert(boxes).values({ id: 'box-purge', userId: U, label: 'purge box', tokenHash: hashToken('purge-box-token') });
  await db.insert(workspaces).values({ id: WS, userId: U, deviceId: 'dev-purge', projectId: 'projP', title: 'purge me' });
  await db.insert(workspaceDiffs).values({ workspaceId: WS, base: 'main', files: [] as any });
  await db.insert(conversations).values({ id: CONV, userId: U, workspaceId: WS, agentId: 1, title: 'purge chat' });
  await db.insert(turns).values({ id: 'turn-purge', conversationId: CONV, status: 'done', blocks: [] as any });
  await db.insert(userMessages).values({ id: 'msg-purge', conversationId: CONV, text: 'hi', origin: 'web' });
  await db.insert(journalCursors).values({ conversationId: CONV });
  await db.insert(readState).values({ userId: U, conversationId: CONV });
  await db.insert(jobs).values({ id: 'job-purge', deviceId: 'dev-purge', conversationId: CONV, workspaceId: WS, kind: 'message', payload: {} as any });
  await db.insert(attachments).values({ id: 'att-purge', userId: U, dataUrl: 'data:image/png;base64,QQ==', sha256: 'purge-sha', workspaceId: WS });
  await db.insert(pushSubscriptions).values({ id: 'push-purge', userId: U, endpoint: 'https://example.invalid/purge', p256dh: 'p', auth: 'a' });
  check('the purge fixture counts as linked', (await hasLiveLink(U)) === true);

  const resp = await deleteAccount(userReq(U, '/api/account', { method: 'DELETE' }));
  check('account purge answers 200', resp.status === 200, `${resp.status}`);
  const left: Record<string, number> = {
    users: (await db.select().from(users).where(eq(users.id, U))).length,
    devices: (await db.select().from(devices).where(eq(devices.userId, U))).length,
    boxes: (await db.select().from(boxes).where(eq(boxes.userId, U))).length,
    workspaces: (await db.select().from(workspaces).where(eq(workspaces.userId, U))).length,
    workspace_diffs: (await db.select().from(workspaceDiffs).where(eq(workspaceDiffs.workspaceId, WS))).length,
    conversations: (await db.select().from(conversations).where(eq(conversations.userId, U))).length,
    turns: (await db.select().from(turns).where(eq(turns.conversationId, CONV))).length,
    user_messages: (await db.select().from(userMessages).where(eq(userMessages.conversationId, CONV))).length,
    journal_cursors: (await db.select().from(journalCursors).where(eq(journalCursors.conversationId, CONV))).length,
    read_state: (await db.select().from(readState).where(eq(readState.userId, U))).length,
    jobs: (await db.select().from(jobs).where(eq(jobs.deviceId, 'dev-purge'))).length,
    attachments: (await db.select().from(attachments).where(eq(attachments.userId, U))).length,
    push_subscriptions: (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, U))).length,
  };
  check('the purge leaves zero rows for the user in every table', Object.values(left).every((n) => n === 0), JSON.stringify(left));
  check('…and the purged account is no longer linked', (await hasLiveLink(U)) === false);
}

/** §3.2 — subscription usage is a per-user settings field, mirrored to the fleet
 *  payload and pushed down the stream instead of riding ~293 conversation rows. */
async function settingsUsageTests() {
  const put = (body: unknown) => putDeviceSettings(deviceReq('/api/settings', { method: 'PUT', body: JSON.stringify(body) }));
  const cursor = await latestSeq(USER_ID);
  const resp = await put({
    defaultHarness: 'codex',
    defaultModels: { codex: 'gpt-5' },
    defaultEffort: 'medium',
    usage: {
      'claude-code': {
        plan: 'max',
        windows: [
          { id: 'week', label: 'Weekly', pct: 42, resetsAt: '2026-01-01T00:00:00Z', severity: 'warn', note: 'n', bogus: 'dropped' },
          { id: 'broken' }, // no label/pct — not a window
        ],
      },
      codex: null,
    },
  });
  check('PUT /api/settings accepted', resp.status === 200, `${resp.status}`);

  const fleet = await jbody(await webWorkspaces(webReq('/api/workspaces')));
  const usage = fleet.settings?.usage ?? {};
  check('usage round-trips through the fleet payload', usage['claude-code']?.windows?.[0]?.pct === 42, JSON.stringify(usage));
  check('…keeping the optional fields it documents', usage['claude-code']?.plan === 'max' && usage['claude-code']?.windows?.[0]?.resetsAt === '2026-01-01T00:00:00Z', JSON.stringify(usage['claude-code']));
  check('…dropping unknown keys and malformed windows', usage['claude-code']?.windows?.length === 1 && !('bogus' in usage['claude-code'].windows[0]), JSON.stringify(usage['claude-code']?.windows));
  check('…and keeping an explicit null for a harness with no subscription', usage.codex === null, JSON.stringify(usage));
  check('the rest of the settings still mirror', fleet.settings?.defaultHarness === 'codex' && fleet.settings?.defaultEffort === 'medium', JSON.stringify(fleet.settings));

  const kinds = (await eventsSince(USER_ID, cursor)).map((e) => e.kind);
  check('a settings PUT announces settings-updated', kinds.includes('settings-updated'), JSON.stringify(kinds));
  const frame = (await sseFrames(cursor, (f) => f.kind === 'settings-updated')).find((f) => f.kind === 'settings-updated');
  check('…and the SSE inlines the settings (8 KB rule)', frame?.usage?.['claude-code']?.windows?.[0]?.pct === 42, JSON.stringify(frame)?.slice(0, 200));

  // An empty map is a real answer ("no harness reports usage"), not "absent".
  await put({ defaultHarness: 'claude-code', defaultModels: {}, defaultEffort: 'high', usage: {} });
  const emptied = await jbody(await webWorkspaces(webReq('/api/workspaces')));
  check('an empty usage map is stored as {}', JSON.stringify(emptied.settings?.usage) === '{}', JSON.stringify(emptied.settings));

  // The conversation PUT no longer accepts it (the column is gone).
  const convResp = await putConversation(
    deviceReq('/api/conversations/wsE:1', {
      method: 'PUT',
      body: JSON.stringify({ workspaceId: 'wsE', agentId: 1, title: 'renamed chat', harness: 'claude-code', usage: { windows: [] } }),
    }),
    { id: 'wsE:1' }
  );
  check('a conversation PUT carrying legacy `usage` is still accepted', convResp.status === 200, `${convResp.status}`);
}

/** settings-sync, two-way: the web pins a default; the relay merges it (keeping
 *  the desktop-owned usage) and emits a web-origin event the desktop applies. */
async function webSettingsTests() {
  await putDeviceSettings(
    deviceReq('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ defaultHarness: 'claude-code', defaultModels: { codex: 'gpt-5' }, defaultEffort: 'high', usage: { codex: null } }),
    })
  );
  const cursor = await latestSeq(USER_ID);
  const unauth = await putWebSettings(new Request(`${BASE}/api/settings`, { method: 'PUT', body: '{}' }));
  check('web settings PUT needs a session', unauth.status === 401, `${unauth.status}`);
  const resp = await putWebSettings(
    webReq('/api/settings', { method: 'PUT', body: JSON.stringify({ defaultModels: { 'claude-code': 'opus' }, defaultEffort: 'low' }) })
  );
  check('web settings PUT accepted', resp.status === 200, `${resp.status}`);
  const fleet = await jbody(await webWorkspaces(webReq('/api/workspaces')));
  const st = fleet.settings ?? {};
  check(
    'web defaults merge onto the stored settings',
    st.defaultModels?.['claude-code'] === 'opus' && st.defaultModels?.codex === 'gpt-5' && st.defaultEffort === 'low' && st.defaultHarness === 'claude-code',
    JSON.stringify(st)
  );
  check('…keeping the desktop-owned usage', st.usage && 'codex' in st.usage, JSON.stringify(st.usage));
  const ev = (await eventsSince(USER_ID, cursor)).find((e) => e.kind === 'settings-updated');
  check('…and emit a web-origin settings-updated', (ev?.payload as any)?.origin === 'web' && (ev?.payload as any)?.defaultEffort === 'low', JSON.stringify(ev));
}

/** Desktops list in link order (oldest first), never by presence. */
async function deviceOrderTests() {
  const db = await getDb();
  const U = 'user-order';
  await db.insert(users).values({ id: U, githubId: 'gh-order', login: 'order' } as any).onConflictDoNothing();
  await db.insert(devices).values([
    { id: 'dev-order-b', userId: U, kind: 'desktop', name: 'second', tokenHash: hashToken('order-b'), createdAt: new Date(2_000_000_000_000) },
    { id: 'dev-order-a', userId: U, kind: 'desktop', name: 'first', tokenHash: hashToken('order-a'), createdAt: new Date(1_000_000_000_000), lastSeenAt: new Date(0) },
  ] as any);
  const listed = (await listUserDevices(U)).map((d: any) => d.id);
  check('linked desktops list in link order', JSON.stringify(listed) === JSON.stringify(['dev-order-a', 'dev-order-b']), JSON.stringify(listed));
  const fleet = await jbody(await webWorkspaces(userReq(U, '/api/workspaces')));
  const ids = (fleet.devices ?? []).map((d: any) => d.id);
  check('the fleet lists desktops in link order', JSON.stringify(ids) === JSON.stringify(['dev-order-a', 'dev-order-b']), JSON.stringify(ids));
  check('…carrying linkedAt', fleet.devices?.[0]?.linkedAt === 1_000_000_000_000, JSON.stringify(fleet.devices?.[0]));
}

/** §3.7 — finished jobs are pruned, at most once every 6 hours; pending work is
 *  never touched. */
async function pruneTests() {
  const db = await getDb();
  const bus = getBus();
  const conv = 'wsE:1';
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  const base = { conversationId: conv, workspaceId: 'wsE', deviceId: DEVICE_ID, kind: 'git_refresh', payload: {} as any };

  // The wiring: finishing a job is what schedules the sweep.
  await bus.del(pruneKey('jobs'));
  await db.insert(jobs).values({ id: 'job-finish', ...base, status: 'delivered' });
  await deviceJobDone(deviceReq('/api/device/jobs/job-finish/done', { method: 'POST', body: JSON.stringify({ ok: true }) }), { id: 'job-finish' });
  check('finishing a job schedules the 6-hourly sweep', !!(await bus.get([pruneKey('jobs')]))[0]);
  check('a second finish inside the window does not re-run it', (await pruneFinishedJobs()) === false);

  // A box never reports a result, so its ack is the terminal status — otherwise
  // box-routed jobs would be immortal and sit in pendingJobs for five minutes.
  await db.insert(jobs).values({ id: 'job-box-ack', conversationId: 'wsBox:1', workspaceId: 'wsBox', boxId: BOX_ID, kind: 'message', payload: {} as any, status: 'pending' });
  await boxAck(new Request(`${BASE}/api/box/jobs/job-box-ack/ack`, { method: 'POST', headers: boxHeaders }), { id: 'job-box-ack' });
  const [acked] = await db.select({ status: jobs.status, doneAt: jobs.doneAt }).from(jobs).where(eq(jobs.id, 'job-box-ack'));
  check('a box ack marks the job done', acked?.status === 'done' && !!acked?.doneAt, JSON.stringify(acked));
  await db.delete(jobs).where(eq(jobs.id, 'job-box-ack'));

  await bus.del(pruneKey('jobs'));
  await db.insert(jobs).values({ id: 'job-stale-done', ...base, status: 'done', doneAt: old });
  await db.insert(jobs).values({ id: 'job-stale-failed', ...base, status: 'failed', doneAt: old });
  await db.insert(jobs).values({ id: 'job-fresh-done', ...base, status: 'done', doneAt: new Date() });
  await db.insert(jobs).values({ id: 'job-still-pending', ...base, status: 'pending' });
  check('the sweep runs when the window is clear', (await pruneFinishedJobs()) === true);
  const alive = async (id: string) => (await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id))).length === 1;
  check('a week-old finished job is pruned', !(await alive('job-stale-done')) && !(await alive('job-stale-failed')));
  check('a fresh finished job is kept', await alive('job-fresh-done'));
  check('a pending job is never pruned', await alive('job-still-pending'));
  check('…and the sweep is rate-limited to once per window', (await pruneFinishedJobs()) === false);

  // The injected cutoff (e2e only) proves the predicate, not just the window.
  await bus.del(pruneKey('jobs'));
  check('an injected cutoff prunes everything finished before it', (await pruneFinishedJobs(Date.now())) === true);
  check('…taking the fresh finished job with it', !(await alive('job-fresh-done')));
  check('…and still leaving the pending one', await alive('job-still-pending'));
  await db.delete(jobs).where(eq(jobs.id, 'job-still-pending'));
  await bus.del(pruneKey('jobs'));
}

/**
 * §3.7 — DDL once per schema version. ~50 statements on every lambda cold start
 * was by itself enough to keep Neon's compute from ever idling, and after the
 * first boot every one of them was a no-op.
 *
 * Runs LAST and against a temp on-disk PGlite: it swaps the process-wide DB out
 * (an in-memory one has no stored version, which is exactly why it always runs
 * the list), so nothing after it may touch the fixtures.
 */
async function ddlVersionTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-web-ddl-'));
  process.env.MAESTRO_WEB_PGLITE_DIR = dir;
  try {
    __resetDb();
    const beforeFirst = __dbStatements();
    await getDb();
    const firstBoot = __dbStatements() - beforeFirst;
    check('a fresh database runs the whole DDL list', firstBoot > 10, `${firstBoot} statements`);
    __resetDb();
    const beforeSecond = __dbStatements();
    await getDb();
    const secondBoot = __dbStatements() - beforeSecond;
    check(`a cold start at DDL_VERSION ${DDL_VERSION} runs ≤ 3 statements`, secondBoot <= 3, `${secondBoot} statements`);
  } catch (e: any) {
    check('the DDL version gate runs against an on-disk PGlite', false, String(e?.message ?? e));
  } finally {
    delete process.env.MAESTRO_WEB_PGLITE_DIR;
    __resetDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(BIN, { recursive: true });
  fs.mkdirSync(CLOUD, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(BIN, 'maestro-drain'), DRAIN_SH, { mode: 0o755 });
  fs.writeFileSync(path.join(BIN, 'maestro-sync'), SYNC_SH, { mode: 0o755 });
  fs.mkdirSync(path.join(BOX_HOME, '.maestro'), { recursive: true });

  const server = await startServer();
  PORT = (server.address() as any).port;
  BASE = `http://127.0.0.1:${PORT}`;

  // sync.url / sync.token on the box.
  fs.writeFileSync(path.join(BOX_HOME, '.maestro', 'sync.url'), BASE);
  fs.writeFileSync(path.join(BOX_HOME, '.maestro', 'sync.token'), BOX_TOKEN);

  // Seed user + box (token hashed at rest).
  const db = await getDb();
  await db.insert(users).values({ id: USER_ID, githubId: 'gh-1', login: 'tester' }).onConflictDoNothing();
  await db.insert(boxes).values({ id: BOX_ID, userId: USER_ID, label: 'testbox', tokenHash: hashToken(BOX_TOKEN) }).onConflictDoNothing();
  // A linked desktop, for the device long-poll + live-turn PUT assertions below.
  await db
    .insert(devices)
    .values({ id: DEVICE_ID, userId: USER_ID, kind: 'desktop', name: 'Test Desktop', tokenHash: hashToken(DEVICE_TOKEN) })
    .onConflictDoNothing();

  // ---- Test 1: direct ingest across a SPLIT JSON line + 409 + idempotent re-ingest ----
  const convA = 'wsA:1';
  await seedConversation(convA);
  const turnIdA = 'turnA-1';
  const journalA =
    [
      `{"maestro":"turn-start","turnId":"${turnIdA}","at":1}`,
      `{"type":"system","subtype":"init","session_id":"SA"}`,
      `{"type":"assistant","message":{"content":[{"type":"text","text":"hello from A"}]}}`,
      `{"type":"result","subtype":"success","session_id":"SA","is_error":false,"total_cost_usd":0.02,"duration_ms":5,"result":"hello from A"}`,
      `{"maestro":"turn-end","turnId":"${turnIdA}","exit":0,"at":2}`,
    ].join('\n') + '\n';
  // Split mid-way through the assistant JSON line.
  const splitAt = journalA.indexOf('hello from A') + 4; // inside the JSON string
  const chunk1 = journalA.slice(0, splitAt);
  const chunk2 = journalA.slice(splitAt);

  const r1 = await fetch(`${BASE}/api/box/journal`, {
    method: 'POST',
    headers: { ...boxHeaders, 'maestro-conversation': convA, 'maestro-from-offset': '0' },
    body: chunk1,
  });
  const j1 = await r1.json();
  check('journal chunk 1 accepted', r1.status === 200, `status ${r1.status}`);
  check('nextOffset advances by chunk 1 bytes', j1.nextOffset === Buffer.byteLength(chunk1), `${j1.nextOffset} vs ${Buffer.byteLength(chunk1)}`);

  // 409: wrong offset.
  const rBad = await fetch(`${BASE}/api/box/journal`, {
    method: 'POST',
    headers: { ...boxHeaders, 'maestro-conversation': convA, 'maestro-from-offset': '999' },
    body: 'garbage',
  });
  const jBad = await rBad.json();
  check('409 on offset mismatch', rBad.status === 409 && jBad.expectedOffset === j1.nextOffset, `status ${rBad.status} expected ${jBad.expectedOffset}`);

  const r2 = await fetch(`${BASE}/api/box/journal`, {
    method: 'POST',
    headers: { ...boxHeaders, 'maestro-conversation': convA, 'maestro-from-offset': String(j1.nextOffset) },
    body: chunk2,
  });
  check('journal chunk 2 accepted', r2.status === 200, `status ${r2.status}`);

  const tA = await turnRow(turnIdA);
  check('split JSON line reassembled → turn finalized', !!tA && tA.status === 'done', tA ? tA.status : 'missing');
  check('reassembled turn text correct', blockText(tA?.blocks).includes('hello from A'), blockText(tA?.blocks));

  // Idempotent re-ingest after rotation reset.
  await fetch(`${BASE}/api/box/rotated`, { method: 'POST', headers: { ...boxHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: convA }) });
  const before = (await (await getDb()).select().from(turns).where(eq(turns.conversationId, convA))).length;
  await fetch(`${BASE}/api/box/journal`, { method: 'POST', headers: { ...boxHeaders, 'maestro-conversation': convA, 'maestro-from-offset': '0' }, body: journalA });
  const after = (await (await getDb()).select().from(turns).where(eq(turns.conversationId, convA))).length;
  check('idempotent re-ingest (no duplicate turn)', before === after && after === 1, `before ${before}, after ${after}`);

  // ---- Test 2: full loop — web send → shim → drain → journal → ingest → turn ----
  const convB = 'wsB:1';
  await seedConversation(convB);
  makeChatDir(convB);

  const sync = spawn('sh', [path.join(BIN, 'maestro-sync')], {
    env: {
      ...process.env,
      HOME: BOX_HOME,
      PATH: `${BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
      MAESTRO_SYNC_WAIT: '1',
      MAESTRO_SYNC_HASH: SYNC_HASH,
    },
    stdio: 'ignore',
    detached: true,
  });

  const sendResp = await fetch(`${BASE}/api/conversations/${encodeURIComponent(convB)}/send`, {
    method: 'POST',
    headers: webHeaders,
    body: JSON.stringify({ text: 'run something' }),
  });
  const sent = await sendResp.json();
  check('web send accepted + job created', sendResp.status === 200 && !!sent.turnId && sent.delivered, JSON.stringify(sent));

  const gotB = await waitFor(async () => {
    const t = await turnRow(sent.turnId);
    return !!t && t.status === 'done';
  }, 30_000, 'web-send turn finalized via shim+drain');
  const tB = await turnRow(sent.turnId);
  check('web send → job → queue → drain → journal → turn (full loop)', gotB, tB ? tB.status : 'missing');
  check('full-loop turn text correct', blockText(tB?.blocks).includes('reply fresh'), blockText(tB?.blocks));

  // The queued user_message flips to not-queued once its turn-start is ingested.
  const [umB] = await (await getDb()).select().from(userMessages).where(eq(userMessages.turnId, sent.turnId));
  check('web user_message un-queued after turn started', !!umB && umB.queued === false, umB ? String(umB.queued) : 'missing');

  // ---- Test 3: SSE carries the events for this user ----
  const sseCtrl = new AbortController();
  const seen: string[] = [];
  const ssePromise = (async () => {
    const resp = await fetch(`${BASE}/api/stream?cursor=0&maxMs=4000`, { headers: { 'x-maestro-test-user': USER_ID }, signal: sseCtrl.signal });
    const reader = (resp.body as any).getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = dec.decode(value);
      for (const line of text.split('\n')) if (line.startsWith('event: ')) seen.push(line.slice(7).trim());
    }
  })();
  await ssePromise.catch(() => {});
  check('SSE replays the turn lifecycle events', seen.includes('turn-started') && seen.includes('turn-ended'), seen.join(','));

  // ---- Test 4: queue report carries a desktop-written job's preview ----
  const convC = 'wsC:1';
  await seedConversation(convC);
  const dirC = makeChatDir(convC);
  const deskTurn = 'desk-turn-1';
  // Hold the chat's drain lock first. `report_queues` only POSTs when the queue
  // dir's listing CHANGED, so without this the test is a coin flip: if the job
  // file lands while the shim is past report_queues in its cycle, the sweep at
  // the end of that cycle starts a drain, the (instant) fake claude eats the job,
  // and the next report_queues sees an unchanged (empty) listing — the queue
  // report never fires. Taking `.lock` makes maestro-drain exit immediately, which
  // is also the real-world shape of this feature: the desktop writes a job over
  // SFTP while a worker already owns the chat, and the phone must still show it.
  fs.mkdirSync(path.join(dirC, '.lock'), { recursive: true });
  fs.writeFileSync(path.join(dirC, 'queue', `0005-${deskTurn}.job`), 'queued from the desktop over SFTP');
  const gotPreview = await waitFor(async () => {
    const [m] = await (await getDb()).select().from(userMessages).where(eq(userMessages.turnId, deskTurn));
    return !!m;
  }, 20_000, 'queue report surfaces desktop job');
  const [umC] = await (await getDb()).select().from(userMessages).where(eq(userMessages.turnId, deskTurn));
  check('queue report carries desktop job preview', gotPreview && umC?.origin === 'desktop' && umC?.text.includes('queued from the desktop'), umC ? umC.text : 'missing');

  // ---- Test 5: stop kills the pgid and the aborted frame lands ----
  const convD = 'wsD:1';
  await seedConversation(convD);
  const dirD = makeChatDir(convD);
  fs.writeFileSync(path.join(BIN, 'claude'), FAKE_CLAUDE, { mode: 0o755 }); // default fast
  // Use a slow turn.sh for D so the turn is interruptible.
  fs.writeFileSync(path.join(dirD, 'turn.sh'), `#!/bin/sh\nsleep 30\n`);
  const stopSend = await fetch(`${BASE}/api/conversations/${encodeURIComponent(convD)}/send`, {
    method: 'POST',
    headers: webHeaders,
    body: JSON.stringify({ text: 'long task' }),
  });
  const stopSent = await stopSend.json();
  const drainUp = await waitFor(() => fs.existsSync(path.join(dirD, 'run.pid')) && fs.readFileSync(path.join(dirD, 'run.pid'), 'utf8').trim().length > 0, 20_000, 'drain running for convD');
  check('slow turn started on the box', drainUp);
  await new Promise((r) => setTimeout(r, 1500));
  await fetch(`${BASE}/api/conversations/${encodeURIComponent(convD)}/stop`, { method: 'POST', headers: webHeaders, body: '{}' });
  const aborted = await waitFor(async () => {
    const t = await turnRow(stopSent.turnId);
    return !!t && (t.status === 'error' || t.status === 'aborted');
  }, 25_000, 'stopped turn finalized as aborted/error');
  const tD = await turnRow(stopSent.turnId);
  check('stop → pgid killed → aborted frame ingested', aborted, tD ? `${tD.status} ${JSON.stringify(tD.meta)}` : 'missing');

  // ---- Test 6: the fleet read (GET /api/fleet is deleted — §3.8) ----
  const fleet = await jbody(await webWorkspaces(webReq('/api/workspaces')));
  check('the fleet read lists the sessions', Array.isArray(fleet.sessions) && fleet.sessions.length >= 4, `${fleet.sessions?.length} sessions`);
  check('a session row no longer carries `usage`', !fleet.sessions.some((s: any) => 'usage' in s), JSON.stringify(Object.keys(fleet.sessions[0] ?? {})));

  // The box loops are done with; stop them so they can't append events under the
  // delta / long-poll assertions below.
  try {
    process.kill(-sync.pid!, 'SIGTERM');
  } catch {}
  try {
    execSync('pkill -f maestro-sync 2>/dev/null; pkill -f maestro-drain 2>/dev/null; true');
  } catch {}
  await new Promise((r) => setTimeout(r, 800));

  await egressTests();
  await busTests();
  await deltaTests();
  await pollTests();
  await presenceTests();
  await rowEventTests();

  // ---- the Neon usage diet (docs/specs/web-neon-usage-diet.md) ----
  await boxGitTests();
  await presenceFrameTests();
  await linkSummaryTests();
  await attachmentTests();
  await agentMessagingTests();
  await settingsUsageTests();
  await webSettingsTests();
  await deviceOrderTests();
  await pruneTests();
  await cascadeTests();
  await purgeTests();
  // Last: it swaps the process-wide database for a temp on-disk one.
  await ddlVersionTests();

  // ---- cleanup ----
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });

  console.log(failures ? `\n${failures} WEB E2E FAILURE(S)` : '\nALL WEB E2E CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('WEB_E2E_FAIL', e);
  try {
    execSync('pkill -f maestro-sync 2>/dev/null; pkill -f maestro-drain 2>/dev/null; true');
  } catch {}
  process.exit(1);
});
