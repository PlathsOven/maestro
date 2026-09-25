/**
 * Memory guard policy unit test (docs/specs/memory-guard.md). Pure functions, no
 * electron/db — run under plain node via `npm run test:memguard`.
 *
 * The main fixture is the incident the guard exists for, as measured on the
 * machine: a 64 GB Windows box, commit limit 71.7 GB, a `python -m pytest` the
 * agent's sub-agent started holding 53.9 GB, and Maestro's renderer at 196 MB
 * minutes from dying of someone else's allocation.
 */
import {
  descendants,
  describeProc,
  formatGb,
  parseMeminfo,
  parsePs,
  parseWindowsProbe,
  pickVictim,
  pressure,
  type MemState,
  type ProcInfo,
} from '../src/main/services/memguard/policy';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const GB = 1024 ** 3;
const proc = (pid: number, ppid: number, memGb: number, cmd: string, started = pid): ProcInfo => ({
  pid,
  ppid,
  mem: memGb * GB,
  name: cmd.split(' ')[0],
  cmd,
  started,
});

// ---------- the incident ----------
const incident: ProcInfo[] = [
  proc(2252, 900, 0.17, 'Maestro.exe', 100),
  proc(3948, 2252, 0.19, 'Maestro.exe --type=renderer', 101),
  proc(7772, 2252, 0.49, 'claude.exe -p --output-format stream-json', 200),
  proc(9100, 7772, 0.01, 'bash.exe -c python -m pytest live/test_cap_arm.py -q', 300),
  proc(23104, 9100, 53.9, 'python -m pytest live/test_cap_arm.py -q', 301),
  proc(23784, 2252, 0.47, 'claude.exe -p --output-format stream-json', 250),
  proc(5712, 4, 0.43, 'MsMpEng.exe', 5),
];
const atTheBrink: MemState = { limit: 71.7 * GB, free: 5.2 * GB, totalPhys: 63.9 * GB };

ok('incident: 7 % headroom is critical', pressure(atTheBrink) === 'critical');
ok('20 % headroom is watch', pressure({ ...atTheBrink, free: 14 * GB }) === 'watch');
ok('85 % headroom is ok', pressure({ ...atTheBrink, free: 61 * GB }) === 'ok');
ok('a failed probe (limit 0) never reads as an emergency', pressure({ limit: 0, free: 0, totalPhys: 0 }) === 'ok');

const v = pickVictim(incident, [7772, 23784], atTheBrink);
ok('incident: the runaway pytest is the victim', v?.proc.pid === 23104, String(v?.proc.pid));
ok('incident: attributed to the turn that started it', v?.root === 7772, String(v?.root));
ok(
  'incident: the turn CLI, its sibling turn and Maestro itself are not candidates',
  pickVictim(incident.filter((p) => p.pid !== 23104), [7772, 23784], atTheBrink) === null
);

// ---------- only ours ----------
const foreign = [...incident.filter((p) => p.pid !== 23104), proc(4000, 12032, 53.9, 'python train.py', 50)];
ok('a runaway the agent did not start is never killed', pickVictim(foreign, [7772, 23784], atTheBrink) === null);
ok('no tracked turns → no victim', pickVictim(incident, [], atTheBrink) === null);

// ---------- big enough to matter ----------
const small = incident.map((p) => (p.pid === 23104 ? { ...p, mem: 9 * GB } : p));
ok('a 9 GB child on a 64 GB machine is below the 25 % floor', pickVictim(small, [7772], atTheBrink) === null);
const laptop: MemState = { limit: 10 * GB, free: 0.5 * GB, totalPhys: 8 * GB };
ok(
  'an 8 GB machine: 25 % would be 2 GB, the floor holds at 2 GB',
  pickVictim([proc(1, 0, 0.1, 'claude'), proc(2, 1, 1.9, 'node build.js')], [1], laptop) === null &&
    pickVictim([proc(1, 0, 0.1, 'claude'), proc(2, 1, 2.4, 'node build.js')], [1], laptop)?.proc.pid === 2
);
ok(
  'the turn CLI itself can be the victim (a leaking CLI)',
  pickVictim([proc(1, 0, 40, 'claude.exe -p')], [1], atTheBrink)?.proc.pid === 1
);
ok(
  'the largest qualifying descendant wins',
  pickVictim([proc(1, 0, 0.1, 'claude'), proc(2, 1, 20, 'a'), proc(3, 1, 30, 'b')], [1], atTheBrink)?.proc.pid === 3
);

// ---------- recycled parent pids ----------
// pid 500 died and its number went to a long-running process that predates the
// "child" — the edge is a coincidence, not ancestry.
const recycled = [proc(1, 0, 0.1, 'claude', 1000), proc(500, 1, 0.1, 'bash', 1001), proc(600, 500, 40, 'python', 10)];
ok('a "child" older than its parent is not a descendant', !descendants(recycled, 1).some((p) => p.pid === 600));
ok('unknown creation times keep the edge', descendants([proc(1, 0, 1, 'a', 0), proc(2, 1, 1, 'b', 0)], 1).length === 2);
ok('a self-parented pid does not loop', descendants([proc(0, 0, 1, 'idle')], 0).length === 1);
ok('a missing root yields nothing', descendants(incident, 424242).length === 0);

// ---------- probe parsing ----------
const win = parseWindowsProbe(
  JSON.stringify({
    os: { limitKb: 75182080, freeKb: 5452595, physKb: 67004416 },
    procs: [{ p: 23104, pp: 9100, m: 57875104563, n: 'python.exe', c: 'python -m pytest live/test_cap_arm.py -q', t: 1.3e17 }],
  })
);
ok('windows probe: state in bytes', win?.state.limit === 75182080 * 1024 && win?.state.free === 5452595 * 1024);
ok('windows probe: process row', win?.procs[0].pid === 23104 && win?.procs[0].ppid === 9100 && win.procs[0].mem > 53 * GB);
ok(
  'windows probe: a single process arrives unwrapped (ConvertTo-Json)',
  parseWindowsProbe(JSON.stringify({ os: { limitKb: 1, freeKb: 1, physKb: 1 }, procs: { p: 7, pp: 1, m: 5, n: 'x', c: null, t: 0 } }))
    ?.procs.length === 1
);
ok('windows probe: light form (no procs)', parseWindowsProbe('{"os":{"limitKb":10,"freeKb":5,"physKb":8}}')?.procs.length === 0);
ok('windows probe: garbage → null', parseWindowsProbe('Get-CimInstance : Access denied') === null);

const mi = parseMeminfo('MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:     400000 kB\nSwapTotal:       2000000 kB\nSwapFree:         100000 kB\n');
ok('meminfo: limit = RAM + swap, free = available + swap free', mi?.limit === 18000000 * 1024 && mi?.free === 500000 * 1024);
ok('meminfo: that state is critical', !!mi && pressure(mi) === 'critical');
ok('meminfo: garbage → null', parseMeminfo('') === null);

const ps = parsePs('    1     0   1200  90000 /sbin/init\n 4242  4100 9437184     12 python -m pytest tests/ -q\n');
ok('ps: rows parsed', ps.length === 2 && ps[1].pid === 4242 && ps[1].mem === 9437184 * 1024 && ps[1].name === 'python');
ok('ps: older process has the smaller `started`', ps[0].started < ps[1].started);

// ---------- wording ----------
ok('formatGb', formatGb(53.9 * GB) === '54 GB' && formatGb(5.2 * GB) === '5.2 GB', `${formatGb(53.9 * GB)} / ${formatGb(5.2 * GB)}`);
ok('describeProc trims a long command line', describeProc(proc(1, 0, 1, 'x'.repeat(400))).length === 138);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL MEMGUARD CHECKS PASSED');
process.exit(failures ? 1 : 0);
