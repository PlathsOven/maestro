/**
 * `maestro-sync` hardening test (perf-cpu-ram §4.8, verification §6.5). Runs the
 * REAL shim (`SYNC_SH`, imported from the module that ships it) in a temp home
 * under plain node — no Electron, no box.
 *
 * The three failures it pins down are the ones that left 18 orphaned shims
 * burning 1–2 % CPU each for 19 hours on the author's laptop: a tight fork loop
 * when the relay is unreachable, a swallowed SIGTERM, and a shim outliving the
 * temp home it was installed into. The fourth case (a live relay) guards the
 * status-code handling those fixes introduced, so hardening can't cost us a job.
 *
 * It also covers the git-report change gate (web-neon-usage-diet §3.1): an
 * unchanged worktree must be reported exactly once, a 404 must stop the reports
 * altogether, and a restarted loop must re-report once.
 *
 *   npx esbuild scripts/shim-test.ts --bundle --platform=node --format=cjs \
 *     --outfile=dist/shim-test.cjs && node dist/shim-test.cjs
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execSync, spawn, type ChildProcess } from 'child_process';

import { SYNC_SH, SYNC_HASH } from '../src/main/services/cloudsync';
import { homeFor } from '../src/main/hosts/posix';

const ROOT = path.join(fs.realpathSync.native(os.tmpdir()), `maestro-shim-test-${process.pid}`);
const SHIM = path.join(ROOT, 'maestro-sync');

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : detail !== '' ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- shim lifecycle helpers ----

const running = new Set<ChildProcess>();

/** Launch the shim in its own temp home; returns the child and its trace file
 *  (one line per cycle — the shim only writes it when MAESTRO_SYNC_TRACE is set).
 *  `env` adds to the shim's environment — the git-report cases lower the 30s
 *  report throttle (MAESTRO_SYNC_GIT_EVERY) so a change gate can be observed in
 *  seconds instead of half a minute. */
function launch(home: string, url: string, env: Record<string, string> = {}): { child: ChildProcess; trace: string } {
  fs.mkdirSync(path.join(home, '.maestro'), { recursive: true });
  fs.mkdirSync(path.join(home, 'maestro', 'cloud'), { recursive: true });
  fs.writeFileSync(path.join(home, '.maestro', 'sync.url'), url);
  fs.writeFileSync(path.join(home, '.maestro', 'sync.token'), 'box-token-test');
  const trace = path.join(home, 'cycles');
  const child = spawn('sh', [SHIM], {
    env: { ...process.env, HOME: home, MAESTRO_SYNC_WAIT: '1', MAESTRO_SYNC_HASH: SYNC_HASH, MAESTRO_SYNC_TRACE: trace, ...env },
    stdio: 'ignore',
  });
  running.add(child);
  child.on('exit', () => running.delete(child));
  return { child, trace };
}

const cycles = (trace: string) => (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** Wait up to `ms` for the shim to exit; returns how long it took (or null). */
async function waitExit(child: ChildProcess, ms: number): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (!alive(child)) return Date.now() - started;
    await sleep(50);
  }
  return null;
}

function killAll(): void {
  for (const child of running) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

// ---- mock relay (the live-path case) ----

interface Mock {
  server: http.Server;
  url: string;
  /** jobs handed out, acks received, the queue depth the shim last reported, and
   *  every git report it sent (web-neon-usage-diet §3.1). */
  seen: { delivered: number; acked: string[]; qd: string[]; git: { ws: string; hash: string }[] };
  /** The status the git route answers with — flip to 404 to play "this workspace
   *  is gone or archived" and watch the shim drop its marker. `revoked` tokens get
   *  a 401 on poll, and `pollTokens` records the bearer each poll carried. */
  state: { gitCode: number; revoked: Set<string>; pollTokens: string[]; journalGone: Set<string>; journals: { conv: string; code: number }[] };
}

function startMock(job: { id: string; conv: string; turnId: string; text: string } | null): Promise<Mock> {
  const seen = { delivered: 0, acked: [] as string[], qd: [] as string[], git: [] as { ws: string; hash: string }[] };
  const state = {
    gitCode: 200,
    revoked: new Set<string>(),
    pollTokens: [] as string[],
    journalGone: new Set<string>(),
    journals: [] as { conv: string; code: number }[],
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/box/workspaces/') && url.pathname.endsWith('/git')) {
      let hash = '';
      try {
        hash = JSON.parse(Buffer.concat(chunks).toString() || '{}').hash ?? '';
      } catch {}
      seen.git.push({ ws: url.pathname.split('/')[4], hash });
      res.writeHead(state.gitCode, { 'content-type': 'application/json' });
      return res.end(state.gitCode === 404 ? '{"error":"unknown workspace for this box"}' : '{"ok":true}');
    }
    if (url.pathname === '/api/box/journal') {
      const conv = String(req.headers['maestro-conversation'] ?? '');
      const from = Number(req.headers['maestro-from-offset'] ?? 0);
      const code = state.journalGone.has(conv) ? 404 : 200;
      state.journals.push({ conv, code });
      res.writeHead(code, { 'content-type': 'application/json' });
      return res.end(code === 404 ? '{"error":"unknown conversation for this box"}' : JSON.stringify({ nextOffset: from + Buffer.concat(chunks).length }));
    }
    if (url.pathname === '/api/box/poll') {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      state.pollTokens.push(token);
      if (state.revoked.has(token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":"invalid box token"}');
      }
      seen.qd.push(url.searchParams.get('qd') ?? '');
      // One job on the first poll, then the ordinary empty "nothing to do" reply.
      const give = job && seen.delivered === 0;
      if (give) seen.delivered++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(
        give ? `${job!.id}\tmessage\t${job!.conv}\t${job!.turnId}\t${Buffer.from(job!.text).toString('base64')}\n` : ''
      );
    }
    if (url.pathname.startsWith('/api/box/jobs/')) {
      seen.acked.push(url.pathname.split('/')[4]);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, seen, state });
    });
  });
}

/** Wait up to `ms` for `pred`, polling every 100ms. */
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (pred()) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(SHIM, SYNC_SH, { mode: 0o755 });

  // ---- Test 1: an unreachable relay must not spin (MIN_CYCLE + poll backoff) ----
  const dead = launch(path.join(ROOT, 'home-dead'), 'http://127.0.0.1:1');
  await sleep(5_000);
  const spun = cycles(dead.trace);
  check('dead relay: at most 3 cycles in 5s', spun >= 1 && spun <= 3, `${spun} cycles`);
  check('dead relay: still running (it retries, it does not give up)', alive(dead.child));

  // ---- Test 2: SIGTERM is honoured (teardownSync/unlinkBox kill by pid) ----
  dead.child.kill('SIGTERM');
  const termMs = await waitExit(dead.child, 1_000);
  check('SIGTERM exits within 1s', termMs !== null, `still alive after 1s`);
  check(
    'SIGTERM releases the single-instance lock',
    !fs.existsSync(path.join(ROOT, 'home-dead', 'maestro', 'cloud', '.sync.lock')),
    'lock dir survived'
  );

  // ---- Test 3: a deleted install (e2e temp home, unlink) stands itself down ----
  const gone = launch(path.join(ROOT, 'home-gone'), 'http://127.0.0.1:1');
  await sleep(1_200); // let it take the lock and enter the loop
  fs.rmSync(path.join(ROOT, 'home-gone'), { recursive: true, force: true });
  const goneMs = await waitExit(gone.child, 10_000);
  check('deleted home: exits on its own', goneMs !== null, 'still alive after 10s');

  // ---- Test 4: a live relay still gets its job through, at a bounded rate ----
  const mock = await startMock({ id: 'job-1', conv: 'wsX:1', turnId: 'turn-1', text: 'do the thing' });
  const home = path.join(ROOT, 'home-live');
  const queue = path.join(home, 'maestro', 'cloud', 'wsX', '1', 'queue');
  fs.mkdirSync(queue, { recursive: true });
  const live = launch(home, mock.url);
  const jobFile = path.join(queue, '0001-turn-1.job');
  for (let i = 0; i < 100 && !fs.existsSync(jobFile); i++) await sleep(100);
  check('live relay: job written into the queue dir', fs.existsSync(jobFile), fs.readdirSync(queue).join(','));
  check('live relay: job content decoded', fs.existsSync(jobFile) && fs.readFileSync(jobFile, 'utf8') === 'do the thing', 'content');
  for (let i = 0; i < 50 && !mock.seen.acked.length; i++) await sleep(100);
  check('live relay: job acked', mock.seen.acked[0] === 'job-1', JSON.stringify(mock.seen.acked));

  // An empty 200 (the normal "no jobs" long-poll reply) is a success, so cycles
  // keep flowing — but never faster than MIN_CYCLE=3s.
  const before = cycles(live.trace);
  await sleep(7_000);
  const ran = cycles(live.trace) - before;
  check('live relay: keeps polling on an empty reply', ran >= 1, `${ran} cycles in 7s`);
  check('live relay: at most 3 cycles in 7s (MIN_CYCLE floor)', ran <= 3, `${ran} cycles in 7s`);
  check('live relay: reports its queue depth (no tree-wide find)', mock.seen.qd.includes('1'), mock.seen.qd.join(','));

  live.child.kill('SIGTERM');
  const liveMs = await waitExit(live.child, 1_000);
  check('live relay: SIGTERM exits within 1s', liveMs !== null, 'still alive after 1s');

  // ---- Test 5: the git report goes up ONLY on change (web-neon-usage-diet §3.1) ----
  // This POST was unconditional behind a 30s throttle, so an idle cloud workspace
  // re-sent a byte-identical report (often a 0-byte diff) 2,880 times a day — each
  // one a select + update + diff upsert + fleet event, which alone kept the relay's
  // Postgres from ever scaling to zero. The throttle is dropped to 1s here so the
  // gate, not the clock, is what the cycles below measure.
  const repo = path.join(ROOT, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execSync('git init -q -b main && git config user.email shim@maestro.local && git config user.name "Maestro Shim" && git commit -q --allow-empty -m init', { cwd: repo });
  const gitHome = path.join(ROOT, 'home-git');
  const wsG = path.join(gitHome, 'maestro', 'cloud', 'wsG');
  fs.mkdirSync(wsG, { recursive: true });
  fs.writeFileSync(path.join(wsG, 'worktree'), repo);
  const gitRun = launch(gitHome, mock.url, { MAESTRO_SYNC_GIT_EVERY: '1' });
  const reported = await until(() => mock.seen.git.length > 0, 15_000);
  check('git report: an unchanged worktree is reported once', reported, JSON.stringify(mock.seen.git));
  check('git report: the body carries a cksum hash', /^[0-9]+$/.test(mock.seen.git[0]?.hash ?? ''), JSON.stringify(mock.seen.git[0]));
  const gitCyclesBefore = cycles(gitRun.trace);
  await sleep(7_000);
  check('git report: the loop kept cycling', cycles(gitRun.trace) - gitCyclesBefore >= 2, `${cycles(gitRun.trace) - gitCyclesBefore} cycles in 7s`);
  check('git report: an unchanged worktree is NOT re-sent', mock.seen.git.length === 1, `${mock.seen.git.length} reports`);
  // A real change still gets through — the gate must not be a mute button.
  fs.writeFileSync(path.join(repo, 'new.txt'), 'hello');
  check('git report: a changed worktree reports again', await until(() => mock.seen.git.length === 2, 15_000), `${mock.seen.git.length} reports`);
  check('git report: the second report carries a different hash', mock.seen.git[0]?.hash !== mock.seen.git[1]?.hash, JSON.stringify(mock.seen.git));

  // ---- Test 6: a 404 (workspace deleted or archived, §3.5) stops the reports ----
  mock.state.gitCode = 404;
  const wsN = path.join(gitHome, 'maestro', 'cloud', 'wsN');
  fs.mkdirSync(wsN, { recursive: true });
  const marker = path.join(wsN, 'worktree');
  fs.writeFileSync(marker, repo);
  check('git 404: the new workspace is reported', await until(() => mock.seen.git.some((g) => g.ws === 'wsN'), 15_000), JSON.stringify(mock.seen.git));
  check('git 404: the worktree marker is removed', await until(() => !fs.existsSync(marker), 5_000), 'marker survived');
  const n404 = mock.seen.git.filter((g) => g.ws === 'wsN').length;
  await sleep(7_000);
  check('git 404: nothing is reported for it again', mock.seen.git.filter((g) => g.ws === 'wsN').length === n404, `${n404} -> ${mock.seen.git.filter((g) => g.ws === 'wsN').length}`);

  // ---- Test 7: a restarted loop re-reports each workspace exactly once ----
  // The stamps say what the RELAY has, which a new link / new shim / rebooted box
  // can't know — so the loop drops them on start (§3.1) and says it once more.
  mock.state.gitCode = 200;
  gitRun.child.kill('SIGTERM');
  check('git restart: the loop exited', (await waitExit(gitRun.child, 2_000)) !== null, 'still alive');
  const beforeRestart = mock.seen.git.filter((g) => g.ws === 'wsG').length;
  const gitRun2 = launch(gitHome, mock.url, { MAESTRO_SYNC_GIT_EVERY: '1' });
  check(
    'git restart: an unchanged workspace is re-reported once',
    await until(() => mock.seen.git.filter((g) => g.ws === 'wsG').length === beforeRestart + 1, 15_000),
    `${beforeRestart} -> ${mock.seen.git.filter((g) => g.ws === 'wsG').length}`
  );
  await sleep(7_000);
  check(
    'git restart: and then goes quiet again',
    mock.seen.git.filter((g) => g.ws === 'wsG').length === beforeRestart + 1,
    `${mock.seen.git.filter((g) => g.ws === 'wsG').length} reports`
  );
  gitRun2.child.kill('SIGTERM');
  await waitExit(gitRun2.child, 2_000);

  // ---- Test 8: a revoked token stands the loop down (neon-idle-compute) ----
  // A 401 is permanent, yet the shim retried it once a minute forever — and each
  // retry cost the relay a Postgres read, which kept Neon awake around the clock.
  mock.state.revoked.add('box-token-test');
  const revokedHome = path.join(ROOT, 'home-revoked');
  const revoked = launch(revokedHome, mock.url);
  check('revoked token: the loop exits on its own', (await waitExit(revoked.child, 10_000)) !== null, 'still alive after 10s');
  check(
    'revoked token: the dead token is removed (the cron relaunch exits too)',
    !fs.existsSync(path.join(revokedHome, '.maestro', 'sync.token')),
    'token survived'
  );

  // …unless the desktop relinked while it ran: then it switches to the new token.
  mock.state.revoked.clear();
  const relinkHome = path.join(ROOT, 'home-relink');
  const relinked = launch(relinkHome, mock.url);
  check('relink: the loop is polling', await until(() => mock.state.pollTokens.includes('box-token-test'), 10_000));
  fs.writeFileSync(path.join(relinkHome, '.maestro', 'sync.token'), 'box-token-new');
  mock.state.revoked.add('box-token-test');
  check('relink: the loop picks up the fresh token', await until(() => mock.state.pollTokens.includes('box-token-new'), 20_000), mock.state.pollTokens.slice(-3).join(','));
  check('relink: and keeps running', alive(relinked.child));
  check('relink: with the fresh token still installed', fs.readFileSync(path.join(relinkHome, '.maestro', 'sync.token'), 'utf8') === 'box-token-new');
  relinked.child.kill('SIGTERM');
  await waitExit(relinked.child, 2_000);

  // ---- Test 9: a journal 404 parks that chat, not the loop (neon-idle-compute) ----
  // An archived chat's journal 404'd, which failed the whole cycle: every chat
  // after it stopped syncing, and the retry (once a minute, forever) was a
  // Postgres read each time — enough to keep Neon awake all night by itself.
  mock.state.revoked.clear();
  mock.state.journalGone.add('wsA:1');
  const jHome = path.join(ROOT, 'home-journal');
  const jDir = (c: string) => path.join(jHome, 'maestro', 'cloud', c, '1');
  for (const c of ['wsA', 'wsB']) {
    fs.mkdirSync(jDir(c), { recursive: true });
    fs.writeFileSync(path.join(jDir(c), 'journal.jsonl'), '{"type":"system"}\n');
  }
  const jRun = launch(jHome, mock.url);
  const jFor = (conv: string) => mock.state.journals.filter((j) => j.conv === conv);
  check('journal 404: the chat after it still syncs', await until(() => jFor('wsB:1').some((j) => j.code === 200), 15_000), JSON.stringify(mock.state.journals));
  const jCycles = cycles(jRun.trace);
  // MIN_CYCLE=3s allows 3+ cycles in 10s; the failure backoff (5s, then 10s, plus
  // jitter) allows at most 2.
  await sleep(10_000);
  check('journal 404: the loop does not back off', cycles(jRun.trace) - jCycles >= 3, `${cycles(jRun.trace) - jCycles} cycles in 10s`);
  check('journal 404: an unchanged journal is not retried', jFor('wsA:1').length === 1, `${jFor('wsA:1').length} attempts`);
  // Published after all: the next write retries it, from the offset it never left.
  mock.state.journalGone.clear();
  fs.appendFileSync(path.join(jDir('wsA'), 'journal.jsonl'), '{"type":"result"}\n');
  check('journal 404: a growing journal is retried', await until(() => jFor('wsA:1').some((j) => j.code === 200), 15_000), JSON.stringify(jFor('wsA:1')));
  check('journal 404: from the start, so nothing is lost', await until(() => fs.readFileSync(path.join(jDir('wsA'), 'sync.offset'), 'utf8').trim() === '36', 5_000));
  check('journal 404: the park marker is cleared', !fs.existsSync(path.join(jDir('wsA'), '.nf')));
  jRun.child.kill('SIGTERM');
  await waitExit(jRun.child, 2_000);

  mock.server.close();
  killAll();
  fs.rmSync(ROOT, { recursive: true, force: true });

  // ---- the shim's install dir: a failed $HOME probe must not stick ----
  let probes = 0;
  let down = true;
  const flaky = {
    id: 'flaky-box',
    exec: async () => {
      probes++;
      if (down) throw new Error('connection reset');
      return { ok: true, stdout: '/home/box', stderr: '', code: 0 };
    },
  } as unknown as Parameters<typeof homeFor>[0];
  check('home: an unreachable box reads as "."', (await homeFor(flaky)) === '.');
  down = false;
  check('home: the next call asks again and gets the real $HOME', (await homeFor(flaky)) === '/home/box');
  check('home: a good answer is cached', (await homeFor(flaky)) === '/home/box' && probes === 2, `probes=${probes}`);

  console.log(failures ? `\n${failures} SHIM TEST FAILURE(S)` : '\nALL SHIM CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('SHIM_TEST_FAIL', e);
  killAll();
  process.exit(1);
});
