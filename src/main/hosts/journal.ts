import type { ExecHost, HostChild } from './types';

/**
 * The journal is the wire protocol (spec §6.3). A per-chat `journal.jsonl` holds
 * the harness's own NDJSON verbatim, bracketed by one framing line before and
 * after each turn:
 *
 *   {"maestro":"turn-start","turnId":"…","at":…}
 *   …the CLI's NDJSON (or raw text) for this turn…
 *   {"maestro":"turn-end","turnId":"…","exit":0,"at":…}
 *
 * The single-writer drain loop writes framing only while no CLI is running, so
 * frames never interleave with CLI output. The app tails the file from a stored
 * byte offset and replays it through the exact same adapter pipeline it uses for
 * a live child — a `JournalChild` presents one turn's bytes as a `HostChild`.
 *
 * `parseFrame` + the frame types now live in `src/shared/harness/frames.ts` so
 * the relay ingest parses the same wire protocol with the same code (mobile-web
 * spec §6.4, G7); re-exported here so existing call sites are untouched.
 */

export { parseFrame } from '../../shared/harness/frames';
export type { JournalFrame, TurnStartFrame, TurnEndFrame } from '../../shared/harness/frames';

/** Read `journal.jsonl` from `offset` to EOF in one bounded pass — no persistent
 *  channel (used for catch-up and for the polling follower). Returns the new
 *  bytes and the file's current size, or size 0 when the file doesn't exist. */
export async function readJournalFrom(
  host: ExecHost,
  journalPath: string,
  offset: number
): Promise<{ data: string; size: number }> {
  let size = 0;
  try {
    size = (await host.fs.stat(journalPath)).size;
  } catch {
    return { data: '', size: 0 };
  }
  if (size <= offset) return { data: '', size };
  // `tail -c +N` is 1-indexed and streams from byte N — uniform on local + POSIX
  // remote, and avoids re-reading the whole (possibly large) file over sftp.
  const r = await host.exec('sh', ['-lc', `tail -c +${offset + 1} ${shq(journalPath)}`], { timeout: 20_000 });
  return { data: r.ok ? r.stdout : '', size };
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * One turn presented as a `HostChild`, fed manually by the follower. Its stdout
 * lines are the CLI's own journal lines (frames stripped); `close(exit)` fires
 * when the turn's `turn-end` frame is observed; `kill()` delegates to the
 * follower's process-group kill. This is the seam §6.3 describes: it slots into
 * `wireAdapterStream` unchanged, so parse/accumulate/finalize stay untouched.
 */
export class JournalChild implements HostChild {
  private stdoutCbs: ((c: string) => void)[] = [];
  private stderrCbs: ((c: string) => void)[] = [];
  private lineCbs: ((l: string) => void)[] = [];
  private closeCbs: ((c: number | null) => void)[] = [];
  private errorCbs: ((e: Error) => void)[] = [];
  private closed = false;

  constructor(private onKill: () => void) {}

  /** Feed one line of the CLI's own output for this turn. */
  pushLine(line: string): void {
    for (const cb of this.lineCbs) cb(line);
    // Raw (non-JSON) adapters read chunks, not lines — re-add the newline the
    // journal split on so text streams back intact.
    if (this.stdoutCbs.length) for (const cb of this.stdoutCbs) cb(line + '\n');
  }
  pushStderr(chunk: string): void {
    for (const cb of this.stderrCbs) cb(chunk);
  }
  close(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb(code);
  }

  onStdoutLine(cb: (line: string) => void): void {
    this.lineCbs.push(cb);
  }
  onStdout(cb: (chunk: string) => void): void {
    this.stdoutCbs.push(cb);
  }
  onStderr(cb: (chunk: string) => void): void {
    this.stderrCbs.push(cb);
  }
  onClose(cb: (code: number | null) => void): void {
    this.closeCbs.push(cb);
  }
  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }
  writeStdin(): void {
    // The box already fed the prompt from the job file — nothing to write here.
  }
  endStdin(): void {}
  kill(): void {
    this.onKill();
  }
}
