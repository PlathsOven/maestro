/**
 * The memory guard's decisions, as pure functions (docs/specs/memory-guard.md).
 * No node builtins and no process spawning — `./probe` does the
 * probing and the killing, `./index` runs the loop, this decides *whether* and *whom*. Unit-tested by
 * `scripts/memguard-test.ts`.
 *
 * The thing being guarded against is a machine running out of memory because of
 * a process an agent started — a test with an unbounded allocation is the
 * canonical case. On Windows that is not a slow-down but a cliff: once the
 * system commit limit is reached, the next allocation fails in *every* process,
 * and Chromium (Maestro's window) and the agent CLI both treat a failed
 * allocation as fatal. The guard's job is to take out the one runaway process
 * before the OS takes out everything else.
 */

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Bytes the process answers for: private commit on Windows, RSS elsewhere. */
  mem: number;
  name: string;
  /** Command line, possibly truncated; '' when the OS wouldn't say. */
  cmd: string;
  /** Creation time in any monotone unit (0 = unknown). Only compared, never
   *  shown: it exists to reject a recycled parent pid (see `descendants`). */
  started: number;
}

/** How much memory the machine has left to give, in bytes. `limit`/`free` are
 *  the quantity whose exhaustion is fatal on this OS: the commit charge on
 *  Windows, RAM + swap on Linux. */
export interface MemState {
  limit: number;
  free: number;
  totalPhys: number;
}

export type Pressure = 'ok' | 'watch' | 'critical';

/** Below this share of headroom the guard probes quickly instead of lazily. */
export const WATCH_FREE = 0.25;
/** Below this share of headroom it acts. Measured: the machine in the spec was
 *  still standing at 7 % and gone minutes later, and a runaway at ~20 GB/min
 *  crosses the last 8 % of a 72 GB limit in about 17 s — several fast probes. */
export const CRITICAL_FREE = 0.08;
/** A victim must hold at least this share of physical RAM … */
export const VICTIM_SHARE = 0.25;
/** … and never less than this, so a small machine's ordinary processes are
 *  never candidates. */
export const VICTIM_MIN_BYTES = 2 * 1024 ** 3;

export function pressure(s: MemState): Pressure {
  if (!(s.limit > 0)) return 'ok'; // a failed probe must never read as an emergency
  const share = s.free / s.limit;
  return share < CRITICAL_FREE ? 'critical' : share < WATCH_FREE ? 'watch' : 'ok';
}

/**
 * Every process descended from `root`, root included. A parent pid is only a
 * number, and the OS recycles numbers: a child whose recorded parent died can
 * appear to hang off an unrelated process that later got the same pid. A real
 * child can't be older than its parent, so an edge that says otherwise is
 * dropped (when both creation times are known).
 */
export function descendants(procs: ProcInfo[], root: number): ProcInfo[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    const parent = byPid.get(p.ppid);
    if (!parent || p.pid === p.ppid) continue;
    if (parent.started && p.started && p.started < parent.started) continue;
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const out: ProcInfo[] = [];
  const seen = new Set<number>();
  const stack = byPid.has(root) ? [byPid.get(root)!] : [];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    for (const c of children.get(p.pid) ?? []) stack.push(c);
  }
  return out;
}

export interface Victim {
  proc: ProcInfo;
  /** The tracked turn process it descends from (may be the victim itself). */
  root: number;
}

/**
 * The process to stop, or null when none of ours is to blame. Only a process
 * Maestro's own agent turns started is ever a candidate — whatever else is
 * eating the machine is not Maestro's to kill — and only one big enough that
 * removing it is what resolves the emergency.
 */
export function pickVictim(procs: ProcInfo[], roots: number[], s: MemState): Victim | null {
  const floor = Math.max(VICTIM_MIN_BYTES, s.totalPhys * VICTIM_SHARE);
  let best: Victim | null = null;
  for (const root of roots) {
    for (const proc of descendants(procs, root)) {
      if (proc.mem >= floor && (!best || proc.mem > best.proc.mem)) best = { proc, root };
    }
  }
  return best;
}

// ---------- probe output parsing ----------

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Parse `WINDOWS_PROBE`'s JSON: the OS block (KB) and, in a full probe, the
 *  process list. Returns null on anything unparseable. */
export function parseWindowsProbe(stdout: string): { state: MemState; procs: ProcInfo[] } | null {
  let j: any;
  try {
    j = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!j?.os) return null;
  const state: MemState = {
    limit: num(j.os.limitKb) * 1024,
    free: num(j.os.freeKb) * 1024,
    totalPhys: num(j.os.physKb) * 1024,
  };
  // ConvertTo-Json unwraps a one-element array into a bare object.
  const raw: any[] = Array.isArray(j.procs) ? j.procs : j.procs ? [j.procs] : [];
  const procs = raw
    .map((p) => ({
      pid: num(p.p),
      ppid: num(p.pp),
      mem: num(p.m),
      name: String(p.n ?? ''),
      cmd: String(p.c ?? ''),
      started: num(p.t),
    }))
    .filter((p) => p.pid > 0);
  return state.limit > 0 ? { state, procs } : null;
}

/** Parse /proc/meminfo: fatal exhaustion on Linux is RAM + swap running out. */
export function parseMeminfo(text: string): MemState | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : 0;
  };
  const total = kb('MemTotal');
  if (!total) return null;
  return { limit: total + kb('SwapTotal'), free: kb('MemAvailable') + kb('SwapFree'), totalPhys: total };
}

/** Parse `ps -axo pid=,ppid=,rss=,etimes=,args=` (rss in KB). `etimes` is
 *  seconds since start, so an older process has the larger value — negate it to
 *  keep `started` monotone the way `descendants` expects. */
export function parsePs(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[5].trim();
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      mem: Number(m[3]) * 1024,
      name: cmd.split(/\s+/)[0]?.split('/').pop() ?? '',
      cmd: cmd.slice(0, 300),
      started: -Number(m[4]),
    });
  }
  return out;
}

export function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

/** What the process was, for a human: its command line, trimmed to a line. */
export function describeProc(p: ProcInfo): string {
  const cmd = (p.cmd || p.name || `pid ${p.pid}`).replace(/\s+/g, ' ').trim();
  return cmd.length > 140 ? `${cmd.slice(0, 137)}…` : cmd;
}
