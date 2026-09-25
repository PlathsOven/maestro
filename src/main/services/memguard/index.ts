import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { Settings } from '../../db';
import { describeProc, formatGb, pickVictim, pressure, type MemState, type ProcInfo } from './policy';
import { killProcessTree, probe } from './probe';

/**
 * Memory guard (docs/specs/memory-guard.md): while a local agent turn runs,
 * watch how much memory the machine has left, and when it is about to run out
 * *because of a process that turn started*, stop that one process and say so.
 *
 * Why Maestro: an agent runs commands nobody is watching — a test with an
 * unbounded allocation grows until the OS gives out. On Windows that is a cliff,
 * not a slope: at the commit limit the next allocation fails in every process,
 * so Maestro's window dies (`render-process-gone: oom`, at 196 MB), the agent
 * CLI dies (`0xC0000409`), and the user sees "Maestro crashed" with nothing to
 * connect it to a pytest run in another worktree. Maestro is the one party that
 * knows which process tree belongs to the agent, so it is the one that can take
 * out the runaway instead of letting the OS take out everything else.
 *
 * Scope is deliberately narrow: only descendants of a turn Maestro spawned on
 * this machine are ever candidates, only when the machine is at the brink, and
 * only a process big enough that stopping it is what ends the emergency. The
 * policy is pure (./policy) and the OS work is in ./probe; this file runs the
 * loop and reports.
 *
 * macOS is not covered: it compresses and grows swap dynamically instead of
 * enforcing a commit limit, `os.freemem()` there is not "available", and the
 * failure this guards against does not take that shape.
 */

export interface GuardedTurn {
  workspaceId: string;
  agentId: number;
}

export interface GuardKill {
  turn: GuardedTurn;
  victim: ProcInfo;
  /** the victim was the turn's own CLI process — the turn ends with it */
  wasRoot: boolean;
  state: MemState;
}

const SUPPORTED = process.platform === 'win32' || process.platform === 'linux';

/** Probe cadence. A Windows probe is a PowerShell spawn (~0.3 CPU-s), so the
 *  lazy rate is what runs for the hours nothing is wrong; `os.freemem()` is
 *  checked every tick for free and pulls a probe forward when RAM is tight. */
const TICK_MS = 3_000;
const LAZY_PROBE_MS = 30_000;
/** Tight RAM alone (normal on a 16 GB laptop) only shortens the lazy interval. */
const TIGHT_RAM_PROBE_MS = 10_000;
/** After a kill, give the OS a moment to reclaim before judging again. */
const COOLDOWN_MS = 15_000;
/** One log line per emergency Maestro didn't cause, not one per tick. */
const FOREIGN_LOG_MS = 5 * 60_000;

const tracked = new Map<number, GuardedTurn>();
const killedRoots = new Map<number, GuardKill>();
const notes = new Map<string, string[]>(); // `${wsId}:${agentId}` → agent-facing notes
let reporter: ((kill: GuardKill) => void) | null = null;
let timer: NodeJS.Timeout | null = null;
let busy = false;
let lastProbeAt = 0;
let lastPressure: 'ok' | 'watch' | 'critical' = 'ok';
let quietUntil = 0;
let lastForeignLogAt = 0;

/** Injected by harness/index (which owns chat messages) — avoids a cycle. */
export function setMemGuardReporter(fn: (kill: GuardKill) => void): void {
  reporter = fn;
}

function log(msg: string): void {
  const line = `${new Date().toISOString()} [memguard] ${msg}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('logs'), 'main.log'), line);
  } catch {}
  console.warn(line.trimEnd());
}

/**
 * Watch a turn's process tree. `pid` is undefined for anything that isn't a
 * local OS process (SSH / k8s / journal children) — those run on someone else's
 * memory, so there is nothing here to guard. Returns the untrack function, which
 * reports whether the guard is what killed this process.
 */
export function trackTurnProcess(pid: number | undefined, turn: GuardedTurn): () => GuardKill | null {
  if (!SUPPORTED || !pid) return () => null;
  tracked.set(pid, turn);
  if (!timer) timer = setTimeout(tick, TICK_MS);
  return () => {
    tracked.delete(pid);
    const kill = killedRoots.get(pid) ?? null;
    killedRoots.delete(pid);
    if (tracked.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
    return kill;
  };
}

/** One-shot prompt block for the chat's next turn: the agent saw only a command
 *  that died, and left alone it re-runs it (it did, in the incident behind this). */
export function consumeMemoryGuardNote(workspaceId: string, agentId: number): string {
  const key = `${workspaceId}:${agentId}`;
  const list = notes.get(key);
  if (!list?.length) return '';
  notes.delete(key);
  return [
    '<maestro-memory-guard>',
    'During the previous turn Maestro killed a process this chat started, because the machine was about to run out of memory:',
    ...list.map((l) => `- ${l}`),
    'It will be killed again if it grows like that again, so do not simply re-run it: find the unbounded allocation or ' +
      'loop first (a smaller input, or a hard memory cap on the process, makes that safe to investigate).',
    '</maestro-memory-guard>',
  ].join('\n');
}

/** A one-line description of the machine's memory, for crash diagnostics. */
export function memorySummary(): string {
  return `${formatGb(os.freemem())} of ${formatGb(os.totalmem())} RAM available`;
}

// ---------- the loop ----------

function tick(): void {
  timer = null;
  void step().finally(() => {
    if (tracked.size > 0 && !timer) timer = setTimeout(tick, TICK_MS);
  });
}

async function step(): Promise<void> {
  if (busy || tracked.size === 0) return;
  if (Settings.global().memoryGuard === false) return;
  const now = Date.now();
  if (now < quietUntil) return;
  // Linux reads /proc for free, so it probes every tick. Windows probes lazily
  // unless the last reading was already worrying or physical RAM is tight — the
  // lazy probe still catches commit that was reserved but never touched, which
  // `os.freemem()` cannot see.
  const due =
    process.platform !== 'win32' ||
    lastPressure !== 'ok' ||
    now - lastProbeAt >= LAZY_PROBE_MS ||
    (os.freemem() / os.totalmem() < 0.15 && now - lastProbeAt >= TIGHT_RAM_PROBE_MS);
  if (!due) return;

  busy = true;
  try {
    lastProbeAt = now;
    let reading = await probe(lastPressure === 'critical');
    if (!reading) return;
    lastPressure = pressure(reading.state);
    if (lastPressure !== 'critical') return;
    if (!reading.procs.length) reading = await probe(true);
    if (!reading || pressure(reading.state) !== 'critical') return;

    const { state, procs } = reading;
    const found = pickVictim(procs, [...tracked.keys()], state);
    if (!found) {
      // Not ours to stop — but worth a line: this is the state in which the
      // window and the CLI die, and the log is where someone will look for why.
      if (now - lastForeignLogAt > FOREIGN_LOG_MS) {
        lastForeignLogAt = now;
        const top = [...procs].sort((a, b) => b.mem - a.mem)[0];
        log(
          `memory critical (${formatGb(state.free)} of ${formatGb(state.limit)} left), not caused by an agent turn` +
            (top ? ` — largest process: ${describeProc(top)} (${formatGb(top.mem)})` : '')
        );
      }
      return;
    }

    const turn = tracked.get(found.root);
    if (!turn) return;
    const event: GuardKill = { turn, victim: found.proc, wasRoot: found.proc.pid === found.root, state };
    log(
      `memory critical (${formatGb(state.free)} of ${formatGb(state.limit)} left) — killing pid ${found.proc.pid} ` +
        `(${formatGb(found.proc.mem)}): ${describeProc(found.proc)}`
    );
    if (event.wasRoot) killedRoots.set(found.root, event);
    await killProcessTree(found.proc, procs);
    quietUntil = Date.now() + COOLDOWN_MS;
    lastPressure = 'watch'; // re-probe promptly once the cooldown ends

    const key = `${turn.workspaceId}:${turn.agentId}`;
    notes.set(key, [
      ...(notes.get(key) ?? []),
      `\`${describeProc(found.proc)}\` (pid ${found.proc.pid}) had grown to ${formatGb(found.proc.mem)}.`,
    ]);
    try {
      reporter?.(event);
    } catch {}
  } finally {
    busy = false;
  }
}
