import { broadcast } from '../bus';
import { localHost } from '../hosts/local';
import type { ExecHost, HostPty } from '../hosts/types';

const MAX_BUFFER = 400_000;

interface PtyRecord {
  pty: HostPty;
  /** Scrollback for a late attach / replay, kept as the chunks it arrived in plus
   *  their total length. Re-slicing one big string per chunk copied up to 800 KB
   *  for every write of a chatty process (perf-cpu-ram §4.7); appending is free
   *  and the join only happens when someone actually reads. */
  chunks: string[];
  total: number;
  alive: boolean;
}

const ptys = new Map<string, PtyRecord>();

/** What a reader sees: the last MAX_BUFFER characters, exactly as the old
 *  `(buffer + data).slice(-MAX_BUFFER)` produced. */
function replay(rec: PtyRecord | undefined): string {
  if (!rec) return '';
  const all = rec.chunks.length === 1 ? rec.chunks[0] : rec.chunks.join('');
  return all.length > MAX_BUFFER ? all.slice(-MAX_BUFFER) : all;
}

interface SpawnPtyOpts {
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** run this command instead of an interactive shell */
  command?: { file: string; args: string[] };
  /** which host the terminal/script lives on (defaults to this machine) */
  host?: ExecHost;
  /** tap on raw output (in addition to the renderer broadcast) */
  onData?: (chunk: string) => void;
  onExit?: (exitCode: number) => void;
}

/** Idempotent: returns the existing pty's buffer, or spawns a new one. */
export function ensurePty(id: string, opts: SpawnPtyOpts): { buffer: string } {
  const existing = ptys.get(id);
  if (existing && existing.alive) {
    if (opts.cols && opts.rows) {
      try {
        existing.pty.resize(opts.cols, opts.rows);
      } catch {}
    }
    return { buffer: replay(existing) };
  }
  return spawnPty(id, opts);
}

export function spawnPty(id: string, opts: SpawnPtyOpts): { buffer: string } {
  killPty(id);
  const host = opts.host ?? localHost;
  const pty = host.pty({
    cwd: opts.cwd,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    env: { TERM: 'xterm-256color', ...(opts.env ?? {}) },
    command: opts.command,
  });
  const rec: PtyRecord = { pty, chunks: [], total: 0, alive: true };
  ptys.set(id, rec);
  pty.onData((data) => {
    rec.chunks.push(data);
    rec.total += data.length;
    // Trim only at twice the cap (amortising the shift), and never below it, so
    // `replay()` always has the full tail to slice.
    if (rec.total > 2 * MAX_BUFFER) {
      while (rec.chunks.length > 1 && rec.total - rec.chunks[0].length >= MAX_BUFFER) {
        rec.total -= rec.chunks.shift()!.length;
      }
    }
    broadcast('pty:data', { id, data });
    opts.onData?.(data);
  });
  pty.onExit((exitCode) => {
    rec.alive = false;
    broadcast('pty:exit', { id, exitCode });
    opts.onExit?.(exitCode);
  });
  return { buffer: '' };
}

export function writePty(id: string, data: string) {
  const rec = ptys.get(id);
  if (rec?.alive) rec.pty.write(data);
}

export function resizePty(id: string, cols: number, rows: number) {
  const rec = ptys.get(id);
  if (rec?.alive) {
    try {
      rec.pty.resize(Math.max(2, cols), Math.max(2, rows));
    } catch {}
  }
}

export function killPty(id: string) {
  const rec = ptys.get(id);
  if (rec) {
    if (rec.alive) {
      try {
        rec.pty.kill();
      } catch {}
    }
    ptys.delete(id);
  }
}

export function isPtyAlive(id: string): boolean {
  return !!ptys.get(id)?.alive;
}

export function getPtyBuffer(id: string): { buffer: string; alive: boolean } {
  const rec = ptys.get(id);
  return { buffer: replay(rec), alive: !!rec?.alive };
}

export function killWorkspacePtys(workspaceId: string) {
  for (const id of [...ptys.keys()]) {
    if (id.includes(workspaceId)) killPty(id);
  }
}

export function killAllPtys() {
  for (const id of [...ptys.keys()]) killPty(id);
}
