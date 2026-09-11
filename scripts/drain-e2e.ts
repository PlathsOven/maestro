/**
 * maestro-drain verification (september-batch §4.8). Runs the REAL drain script
 * (getDrainScript() from services/cloud) under a real `sh` in a temp chat dir
 * with a fake turn.sh — no SSH, no Electron — and asserts the box-side scheduling
 * behaviour that §4 adds to the drain:
 *
 *   1. a future scheduled job → the drain naps, then promotes + runs it, then exits
 *   2. USR1 cuts a nap short so a freshly-queued job runs at once (not 60s later);
 *      TERM while napping exits cleanly with no spurious turn-end frame
 *   3. a stale lock (dead run.pid) is taken over
 *   4. zero-padded promotion numbering has no octal trap (0009 → 0010, not error)
 *
 *   npm run e2e:drain
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { getDrainScript } from '../src/main/services/cloud';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-drain-e2e-'));
const SCRIPT = path.join(ROOT, 'maestro-drain');
fs.writeFileSync(SCRIPT, getDrainScript());
fs.chmodSync(SCRIPT, 0o755);

// A fake turn.sh: consume the job on stdin, emit one result line (goes to the
// journal between the drain's turn-start/turn-end frames).
const FAKE_TURN = `cat >/dev/null\necho '{"type":"result","result":"ok"}'\n`;

let chatSeq = 0;
function newChat(): string {
  const dir = path.join(ROOT, `chat-${chatSeq++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'turn.sh'), FAKE_TURN);
  return dir;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const pad10 = (n: number) => String(n).padStart(10, '0');
const j = (dir: string) => path.join(dir, 'journal.jsonl');
const readJournal = (dir: string) => (fs.existsSync(j(dir)) ? fs.readFileSync(j(dir), 'utf8') : '');
const spawnDrain = (dir: string): ChildProcess => spawn('sh', [SCRIPT, dir], { stdio: 'ignore' });

async function waitFor(cond: () => boolean, timeoutMs: number, step = 100): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}
const exists = (p: string) => fs.existsSync(p);
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

async function main() {
  // ---- 1. a future scheduled job naps, then promotes + runs, then exits ----
  {
    const dir = newChat();
    fs.mkdirSync(path.join(dir, 'scheduled'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scheduled', `${pad10(nowSec() + 2)}-t1.job`), 'hello');
    const child = spawnDrain(dir);
    await sleep(600);
    check('1: drain alive while napping', alive(child) && exists(path.join(dir, '.lock')));
    check('1: journal still empty during the nap', !readJournal(dir).includes('turn-start'));
    // Wait for the turn to *finish* (turn-end), not just start: turn-start lands
    // first, so snapshotting on its arrival raced ahead of turn-end on slower hosts.
    const ended = await waitFor(() => readJournal(dir).includes('"maestro":"turn-end","turnId":"t1"'), 6000);
    const jr = readJournal(dir);
    check('1: turn-start framed for t1', jr.includes('"maestro":"turn-start","turnId":"t1"'));
    check('1: turn-end framed for t1', ended && jr.includes('"maestro":"turn-end","turnId":"t1"'));
    check('1: scheduled job was consumed', !exists(path.join(dir, 'scheduled', `${pad10(nowSec() + 2)}-t1.job`)));
    const gone = await waitFor(() => !alive(child), 4000);
    check('1: drain exits when nothing is left', gone);
    check('1: .lock removed on exit', !exists(path.join(dir, '.lock')));
    if (alive(child)) child.kill('SIGKILL');
  }

  // ---- 2. USR1 cuts a nap short; TERM while napping exits with no turn-end ----
  {
    const dir = newChat();
    fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scheduled'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue', '0001-a.job'), 'a');
    fs.writeFileSync(path.join(dir, 'scheduled', `${pad10(nowSec() + 30)}-b.job`), 'b'); // far future
    const child = spawnDrain(dir);
    const aRan = await waitFor(() => readJournal(dir).includes('"turnId":"a"'), 4000);
    check('2: queued job a runs immediately', aRan);
    // The drain should now be napping on b. Queue a new job and nudge with USR1.
    await waitFor(() => !exists(path.join(dir, 'queue', '0001-a.job')), 2000);
    fs.writeFileSync(path.join(dir, 'queue', '0002-c.job'), 'c');
    const pid = Number(fs.readFileSync(path.join(dir, 'run.pid'), 'utf8').trim());
    check('2: run.pid points at the live drain', pid === child.pid, `${pid} vs ${child.pid}`);
    const t0 = Date.now();
    process.kill(pid, 'SIGUSR1');
    const cRan = await waitFor(() => readJournal(dir).includes('"turnId":"c"'), 3000);
    check('2: USR1 wakes the nap so c runs at once (not after 30s)', cRan && Date.now() - t0 < 3000);
    check('2: drain still alive (b still pending)', alive(child));
    process.kill(pid, 'SIGTERM');
    const gone = await waitFor(() => !alive(child), 3000);
    check('2: TERM exits the napping drain', gone);
    // b never ran, so there must be no turn-end frame for a nap (only a and c).
    check('2: no spurious turn-end for the nap', !readJournal(dir).includes('"turnId":"b"'));
    check('2: .lock and run.pid gone after TERM', !exists(path.join(dir, '.lock')) && !exists(path.join(dir, 'run.pid')));
    if (alive(child)) child.kill('SIGKILL');
  }

  // ---- 3. a stale lock (dead run.pid) is taken over ----
  {
    const dir = newChat();
    fs.mkdirSync(path.join(dir, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.pid'), '999999\n'); // a pid that isn't alive
    fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue', '0001-s.job'), 's');
    const child = spawnDrain(dir);
    const ran = await waitFor(() => readJournal(dir).includes('"turnId":"s"'), 4000);
    check('3: stale lock is taken over and the queue runs', ran);
    await waitFor(() => !alive(child), 3000);
    if (alive(child)) child.kill('SIGKILL');
  }

  // ---- 4. zero-padded promotion numbering (no octal trap): 0009 → 0010 ----
  {
    const dir = newChat();
    fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scheduled'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue', '0009-x.job'), 'x');
    fs.writeFileSync(path.join(dir, 'scheduled', `${pad10(0)}-z.job`), 'z'); // due (0 <= now)
    const child = spawnDrain(dir);
    const bothRan = await waitFor(
      () => readJournal(dir).includes('"turnId":"x"') && readJournal(dir).includes('"turnId":"z"'),
      5000
    );
    const jr = readJournal(dir);
    check('4: both x and z ran (z promoted despite leading zeros)', bothRan);
    // x is the lower seq, so it must be framed before z — proves 0009 < 0010 order.
    check('4: x ran before z (promoted as 0010, not an octal error)', jr.indexOf('"turnId":"x"') < jr.indexOf('"turnId":"z"'));
    await waitFor(() => !alive(child), 3000);
    if (alive(child)) child.kill('SIGKILL');
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(failures === 0 ? '\nDRAIN_E2E_OK' : `\nDRAIN_E2E_FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
