/**
 * Memory guard end-to-end (docs/specs/memory-guard.md §6): the real probe, a
 * real process tree and a real kill — everything except the emergency itself,
 * which is synthesised (the test must not actually exhaust the machine).
 *
 *   fake turn (node, idle)  ──spawns──▶  runaway (node, holds ~2.5 GB, touched)
 *   bystander turn (node, idle)
 *
 * Asserts: the probe sees the tree with true parentage and the runaway's memory;
 * under a critical reading the runaway — and only the runaway — is chosen, and
 * attributed to the turn that started it; a turn that didn't start it yields no
 * victim; the kill takes the runaway and leaves the turn process alive.
 *
 * `npm run e2e:memguard`. Windows and Linux; skips elsewhere or when the machine
 * is too short of memory to lend 2.5 GB.
 */
import { spawn, type ChildProcess } from 'child_process';
import os from 'os';
import { formatGb, pickVictim, pressure, type MemState } from '../src/main/services/memguard/policy';
import { killProcessTree, probe } from '../src/main/services/memguard/probe';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GB = 1024 ** 3;

const RUNAWAY = `const held=[];for(let i=0;i<5;i++)held.push(Buffer.alloc(512*1024*1024,1));console.log('held');setInterval(()=>{},1000)`;
// The fake turn prints the runaway's pid, then reports when it dies — and stays up.
const TURN = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(RUNAWAY)}],{stdio:['ignore','pipe','inherit']});console.log('runaway '+c.pid);c.on('exit',()=>console.log('runaway-exit'));setInterval(()=>{},1000)`;
const IDLE = `setInterval(()=>{},1000)`;

async function main() {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    console.log('SKIP: the memory guard covers Windows and Linux only');
    return;
  }
  if (os.freemem() < 12 * GB) {
    console.log(`SKIP: only ${formatGb(os.freemem())} available — not borrowing 2.5 GB from this machine`);
    return;
  }

  let t0 = Date.now();
  const light = await probe(false);
  check('light probe parses', !!light && light.state.limit > 0 && light.state.totalPhys > 0, `${Date.now() - t0} ms`);
  if (!light) return;
  console.log(`     machine: ${formatGb(light.state.free)} of ${formatGb(light.state.limit)} left, ${formatGb(light.state.totalPhys)} RAM`);
  check('a healthy machine reads ok', pressure(light.state) === 'ok', pressure(light.state));

  const children: ChildProcess[] = [];
  const turn = spawn(process.execPath, ['-e', TURN], { stdio: ['ignore', 'pipe', 'inherit'] });
  const bystander = spawn(process.execPath, ['-e', IDLE], { stdio: 'ignore' });
  children.push(turn, bystander);
  let out = '';
  turn.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  let turnExited = false;
  turn.on('exit', () => (turnExited = true));

  try {
    for (let i = 0; i < 100 && !/runaway (\d+)/.test(out); i++) await sleep(100);
    const runawayPid = Number(/runaway (\d+)/.exec(out)?.[1]);
    check('fake turn started its runaway', runawayPid > 0, String(runawayPid));

    // Wait for the runaway to actually hold its memory, as the probe sees it.
    let full = await probe(true);
    for (let i = 0; i < 40; i++) {
      const mem = full?.procs.find((p) => p.pid === runawayPid)?.mem ?? 0;
      if (mem > 2.2 * GB) break;
      await sleep(500);
      t0 = Date.now();
      full = await probe(true);
    }
    const seen = full?.procs.find((p) => p.pid === runawayPid);
    check('full probe sees the runaway', !!seen, `${full?.procs.length ?? 0} processes in ${Date.now() - t0} ms`);
    check('…with its memory', (seen?.mem ?? 0) > 2.2 * GB, seen ? formatGb(seen.mem) : '');
    check('…its parent', seen?.ppid === turn.pid, `${seen?.ppid} vs ${turn.pid}`);
    check('…and a command line to show the user', /Buffer\.alloc|node/i.test(seen?.cmd ?? ''), (seen?.cmd ?? '').slice(0, 60));
    if (!full || !seen) return;

    // The emergency, synthesised: 5 % headroom on a machine small enough that a
    // 2.5 GB process is over the victim floor.
    const brink: MemState = { limit: full.state.limit, free: full.state.limit * 0.05, totalPhys: 8 * GB };
    check('the synthetic reading is critical', pressure(brink) === 'critical');

    const victim = pickVictim(full.procs, [turn.pid!, bystander.pid!], brink);
    check('the runaway is chosen', victim?.proc.pid === runawayPid, String(victim?.proc.pid));
    check('attributed to the turn that started it', victim?.root === turn.pid, String(victim?.root));
    check('a turn that did not start it yields no victim', pickVictim(full.procs, [bystander.pid!], brink) === null);
    check(
      'on the real machine (64 GB floor = 25 %) a 2.5 GB process is never a victim',
      pickVictim(full.procs, [turn.pid!], { ...brink, totalPhys: full.state.totalPhys }) === null ||
        full.state.totalPhys < 10 * GB
    );
    if (!victim) return;

    t0 = Date.now();
    await killProcessTree(victim.proc, full.procs);
    for (let i = 0; i < 50 && !/runaway-exit/.test(out); i++) await sleep(100);
    check('the kill took the runaway', /runaway-exit/.test(out), `${Date.now() - t0} ms`);
    const after = await probe(true);
    check('the runaway is gone from the process table', !after?.procs.some((p) => p.pid === runawayPid));
    check('the turn process survived', !turnExited && !!after?.procs.some((p) => p.pid === turn.pid));
    check('the bystander survived', !!after?.procs.some((p) => p.pid === bystander.pid));
  } finally {
    for (const c of children) {
      try {
        c.kill();
      } catch {}
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nMEMGUARD E2E PASSED');
    process.exit(failures ? 1 : 0);
  });
