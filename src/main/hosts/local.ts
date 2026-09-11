import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import * as nodePty from 'node-pty';
import { run } from '../exec';
import { childEnv, stripNestedAgentVars, userShell } from '../env';
import { killTree, resolveCommandPath, resolveLaunch } from '../launch';
import type { ExecHost, ExecOpts, ExecResult, HostChild, HostFs, HostPty, HostPtyOpts, SpawnOpts } from './types';
import type { FsEntry } from '../../shared/types';

/**
 * LocalHost IS the extracted current code — exec via execa (services/exec),
 * agent spawns via child_process, terminals/scripts via node-pty, files via fs,
 * watching via recursive fs.watch. It must stay byte-identical in behavior to
 * what shipped before the seam (the e2e suite runs against it unchanged).
 */
class LocalHost implements ExecHost {
  readonly id = 'local';
  readonly platform = process.platform;
  readonly path = path;

  exec(cmd: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    return run(cmd, args, opts);
  }

  spawnStream(cmd: string, args: string[], opts: SpawnOpts = {}): HostChild {
    let child: ChildProcessWithoutNullStreams;
    const errorCbs: ((err: Error) => void)[] = [];
    // spawnStream is the agent-turn path — strip nested-session vars off the
    // final env (mirrors startAgent's old inline deletions).
    const env = stripNestedAgentVars(childEnv(opts.env ?? {}));
    // On Windows the agent CLIs are `.cmd` shims rather than executables;
    // resolveLaunch turns them back into the binary they wrap, so argv reaches
    // the CLI unescaped and `kill` reaches the CLI's own pid (see launch.ts).
    const launch = resolveLaunch(cmd, args, env);
    try {
      child = spawn(launch.file, launch.args, {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: launch.shell,
      });
    } catch (e: any) {
      // Defer the error to the next tick so the caller can attach onError first.
      const err = e instanceof Error ? e : new Error(String(e));
      queueMicrotask(() => errorCbs.forEach((cb) => cb(err)));
      return new DeadChild(errorCbs);
    }
    return new LocalChild(child, errorCbs);
  }

  pty(opts: HostPtyOpts): HostPty {
    return new LocalPty(opts);
  }

  fs: HostFs = {
    read: (p) => fs.promises.readFile(p),
    write: (p, data) => fs.promises.writeFile(p, data),
    mkdirp: async (p) => {
      await fs.promises.mkdir(p, { recursive: true });
    },
    exists: async (p) => {
      try {
        await fs.promises.access(p);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (p) => {
      const st = await fs.promises.stat(p);
      return { size: st.size, mtimeMs: st.mtimeMs, dir: st.isDirectory() };
    },
    readdir: async (p) => {
      const ents = await fs.promises.readdir(p, { withFileTypes: true });
      return ents.map((e): FsEntry => {
        let dir = e.isDirectory();
        if (!dir && e.isSymbolicLink()) {
          try {
            dir = fs.statSync(path.join(p, e.name)).isDirectory();
          } catch {
            dir = false; // broken symlink → treat as a file
          }
        }
        return { name: e.name, dir };
      });
    },
    rm: async (p) => {
      await fs.promises.rm(p, { recursive: true, force: true });
    },
    chmod: (p, mode) => fs.promises.chmod(p, mode),
  };

  watch(root: string, onChange: () => void): () => void {
    let watcher: fs.FSWatcher | null = null;
    try {
      watcher = fs.watch(root, { recursive: true }, () => onChange());
      watcher.on('error', () => {
        try {
          watcher?.close();
        } catch {}
      });
    } catch {
      // recursive fs.watch unsupported → no-op unwatch
    }
    return () => {
      try {
        watcher?.close();
      } catch {}
    };
  }

}

/** Wraps a live local child process in the HostChild contract. */
class LocalChild implements HostChild {
  constructor(
    private child: ChildProcessWithoutNullStreams,
    private errorCbs: ((err: Error) => void)[]
  ) {
    for (const cb of errorCbs) child.on('error', cb);
  }
  onStdoutLine(cb: (line: string) => void): void {
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', cb);
  }
  onStdout(cb: (chunk: string) => void): void {
    this.child.stdout.on('data', (d: Buffer) => cb(d.toString()));
  }
  onStderr(cb: (chunk: string) => void): void {
    this.child.stderr.on('data', (d: Buffer) => cb(d.toString()));
  }
  onClose(cb: (code: number | null) => void): void {
    this.child.on('close', (code) => cb(code));
  }
  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
    this.child.on('error', cb);
  }
  writeStdin(data: string): void {
    try {
      this.child.stdin.write(data);
    } catch {}
  }
  endStdin(): void {
    try {
      this.child.stdin.end();
    } catch {}
  }
  kill(signal?: string): void {
    killTree(this.child, signal ?? 'SIGTERM');
  }
}

/** A child that failed to spawn — only ever fires onError/onClose. */
class DeadChild implements HostChild {
  constructor(private errorCbs: ((err: Error) => void)[]) {}
  onStdoutLine(): void {}
  onStdout(): void {}
  onStderr(): void {}
  onClose(cb: (code: number | null) => void): void {
    queueMicrotask(() => cb(-1));
  }
  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }
  writeStdin(): void {}
  endStdin(): void {}
  kill(): void {}
}

/** Wraps a node-pty in the HostPty contract. */
class LocalPty implements HostPty {
  private pty: nodePty.IPty;
  constructor(opts: HostPtyOpts) {
    let file = opts.command?.file ?? userShell();
    let args = opts.command?.args ?? (process.platform === 'win32' ? [] : ['-l']);
    const env = childEnv({ TERM: 'xterm-256color', ...(opts.env ?? {}) });
    if (opts.command) {
      // ConPTY resolves bare names by appending `.exe` only, and node-pty has no
      // `shell` option — so hand it the resolved target. A shim we can't unwrap
      // still starts from its full path, which is what CreateProcess needs.
      const launch = resolveLaunch(file, args, env);
      if (launch.shell) file = resolveCommandPath(file, env) ?? file;
      else ({ file, args } = launch);
    }
    this.pty = nodePty.spawn(file, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env,
      // ConPTY's console-list agent calls AttachConsole, which fails when the
      // app runs with no console attached at all — as it does under `--smoke`
      // for the recorded demo, taking every terminal and run script down with
      // it. Opt-in escape hatch to the older winpty backend for those runs;
      // normal launches keep ConPTY.
      ...(process.platform === 'win32' && process.env.MAESTRO_NO_CONPTY ? { useConpty: false } : {}),
    });
  }
  onData(cb: (chunk: string) => void): void {
    this.pty.onData(cb);
  }
  onExit(cb: (code: number) => void): void {
    this.pty.onExit(({ exitCode }) => cb(exitCode));
  }
  write(data: string): void {
    this.pty.write(data);
  }
  resize(cols: number, rows: number): void {
    try {
      this.pty.resize(Math.max(2, cols), Math.max(2, rows));
    } catch {}
  }
  kill(): void {
    try {
      this.pty.kill();
    } catch {}
  }
}

export const localHost: ExecHost = new LocalHost();
