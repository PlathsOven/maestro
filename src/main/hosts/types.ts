import type * as pathMod from 'path';
import type { FsEntry } from '../../shared/types';

/**
 * The ExecHost seam (spec §6.2). One interface, two implementations
 * (LocalHost, SshHost), resolved once per project. It answers *where processes
 * and files live* — every exec / streaming agent spawn / pty / fs primitive that
 * used to call execa / node-pty / fs directly now goes through a host, so the
 * same orchestration runs against this machine or a remote server unchanged.
 */

export interface ExecOpts {
  cwd?: string;
  timeout?: number;
  input?: string;
  /** extra vars for the child; an `undefined` value unsets an inherited one */
  env?: Record<string, string | undefined>;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * A streaming child process for an agent turn — piped stdio, line-based stdout,
 * a stderr tail, kill(), and a close event. Mirrors today's child usage in
 * harness/index.ts so the NDJSON stream-json protocol parses identically off a
 * local pipe or an SSH channel.
 */
export interface HostChild {
  /** readline over stdout — the JSON-adapter path */
  onStdoutLine(cb: (line: string) => void): void;
  /** raw stdout chunks — the non-JSON adapter path */
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  onClose(cb: (code: number | null) => void): void;
  onError(cb: (err: Error) => void): void;
  writeStdin(data: string): void;
  endStdin(): void;
  kill(signal?: string): void;
}

export interface HostPtyOpts {
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** run this command instead of an interactive login shell */
  command?: { file: string; args: string[] };
}

export interface HostPty {
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** Filesystem primitives against the host. Paths are host-native (POSIX on
 *  remote); callers do path math with `host.path`. */
export interface HostFs {
  read(p: string): Promise<Buffer>;
  write(p: string, data: Buffer | string): Promise<void>;
  mkdirp(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  stat(p: string): Promise<{ size: number; mtimeMs: number; dir: boolean }>;
  readdir(p: string): Promise<FsEntry[]>;
  rm(p: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
}

export interface ExecHost {
  /** 'local' or the hosts-row id. */
  readonly id: string;
  /** The REMOTE OS for ssh hosts (drives scriptShell / path selection), not the laptop's. */
  readonly platform: NodeJS.Platform;
  exec(cmd: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;
  spawnStream(cmd: string, args: string[], opts?: SpawnOpts): HostChild;
  pty(opts: HostPtyOpts): HostPty;
  fs: HostFs;
  /** Watch a tree for changes; returns an unsubscribe. Local = fs.watch; ssh =
   *  trigger-based poller (§6.8). */
  watch(root: string, onChange: () => void): () => void;
  /** Drop the cached login-shell PATH so the next command re-resolves it. SSH
   *  only — local resolves once at app startup (env.ts). */
  refreshEnv?(): void;
  /** Path math for this host (posix for remote). */
  path: typeof pathMod.posix | typeof pathMod.win32;
  /** Reverse-forward a local port so remote children can reach a loopback server
   *  (the ask/role bridge). Returns the remote port. SSH only. (§6.7) */
  forwardLoopback?(localPort: number): Promise<{ remotePort: number }>;
  /** `-L`-style forward: expose a remote loopback port on a local port, so the
   *  user can open a dev server running on the server (§6.8). SSH only. */
  forwardOut?(remotePort: number): Promise<{ localPort: number }>;
  /** Establish/verify the connection. Local is a no-op. */
  connect?(): Promise<void>;
  /** Tear down (channels, client). Local is a no-op. */
  dispose?(): void;
}
