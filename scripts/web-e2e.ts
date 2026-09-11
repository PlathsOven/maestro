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
import { getDb } from '../web/lib/db';
import { boxes, conversations, turns, userMessages, users } from '../web/lib/db/schema';
import { hashToken } from '../web/lib/tokens';
import { boxPoll, boxJournal, boxQueue, boxRotated, boxAck } from '../web/lib/handlers/box';
import { webSend, webStop, webTurns, webFleet, webStream, webReadState } from '../web/lib/handlers/web';
import { SYNC_SH, SYNC_HASH } from '../src/main/services/cloudsync';

const ROOT = path.join(os.tmpdir(), `maestro-web-e2e-${process.pid}`);
const BOX_HOME = path.join(ROOT, 'box-home');
const BIN = path.join(BOX_HOME, '.maestro', 'bin');
const CLOUD = path.join(BOX_HOME, 'maestro', 'cloud');
const USER_ID = 'user-1';
const BOX_ID = 'box-1';
const BOX_TOKEN = 'box-token-secret-abc';
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
  { method: 'GET', re: /^\/api\/fleet/, handler: (r) => webFleet(r) },
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

  // ---- Test 6: fleet endpoint ----
  const fleet = await (await fetch(`${BASE}/api/fleet`, { headers: { 'x-maestro-test-user': USER_ID } })).json();
  check('fleet lists the conversations', Array.isArray(fleet.conversations) && fleet.conversations.length >= 4, `${fleet.conversations?.length} convs`);

  // ---- cleanup ----
  try {
    process.kill(-sync.pid!, 'SIGTERM');
  } catch {}
  try {
    execSync('pkill -f maestro-sync 2>/dev/null; pkill -f maestro-drain 2>/dev/null; true');
  } catch {}
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
