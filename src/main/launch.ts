import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * What to actually launch on Windows.
 *
 * The agent CLIs are not executables there. `claude`, `codex`, `cursor-agent`
 * … install as npm shims — a `claude.cmd` batch file beside a POSIX `claude`
 * script — and CreateProcess only ever appends `.exe` to a bare name, so
 * `spawn('claude')` dies with "spawn claude ENOENT".
 *
 * The usual patch for that, `shell: process.platform === 'win32'`, trades one
 * bug for two worse ones. Node builds the command line by joining argv with
 * spaces and no escaping, so a multi-word `--append-system-prompt` (or a
 * prompt containing `&`, `"`, or a newline) is shattered or handed to cmd.exe
 * to execute; and the pid we get back is cmd.exe's, so killing a turn leaves
 * the real CLI running.
 *
 * So resolve rather than shell out: find the file on PATH×PATHEXT and, when
 * it's an npm shim, read what the shim itself launches — a native binary, or
 * an interpreter plus a script — and launch that directly. argv then reaches
 * the CLI exactly as written and the pid is the CLI's own. Every function here
 * is a no-op off Windows, where the OS does all of this for us.
 */
export interface Launch {
  /** the file to spawn: an absolute executable, or `cmd` itself when unresolved */
  file: string;
  args: string[];
  /**
   * Last resort: a `.cmd`/`.ps1` on PATH whose target we couldn't read, which
   * only a shell can start. Carries the old caveats — argv is joined
   * unescaped, and the pid is the shell's — so it stays a narrow fallback.
   */
  shell: boolean;
}

/** `.com`/`.exe` are the only files CreateProcess can start on its own. */
const DIRECT_RE = /\.(?:com|exe)$/i;

const isWindows = process.platform === 'win32';

/** Windows env vars are case-insensitive, but a plain object copy of
 *  `process.env` keeps the OS's casing (`Path`), so look keys up loosely. */
function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The file a bare command name resolves to, searching PATH × PATHEXT the way
 * cmd.exe does. Null when it isn't found, or when `cmd` already carries a path
 * or an extension (the launcher can take those as-is).
 */
export function resolveCommandPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isWindows) return null;
  if (cmd.includes('/') || cmd.includes('\\') || path.extname(cmd)) return isFile(cmd) ? cmd : null;
  const exts = (envVar(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (envVar(env, 'PATH') || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, cmd + ext);
      if (isFile(cand)) return cand;
    }
  }
  return null;
}

/** Resolve `cmd args` to something a process launcher can start directly. */
export function resolveLaunch(
  cmd: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env
): Launch {
  if (!isWindows) return { file: cmd, args, shell: false };
  const resolved = resolveCommandPath(cmd, env);
  // Unresolved: let the launcher search PATH itself and report ENOENT as before.
  if (!resolved) return { file: cmd, args, shell: false };
  if (DIRECT_RE.test(resolved)) return { file: resolved, args, shell: false };
  return unwrapShim(resolved, args, env) ?? { file: cmd, args, shell: true };
}

/**
 * Read an npm-generated `.cmd` shim to find what it runs. `cmd-shim` writes
 * exactly two shapes, both ending in a single `%*` forwarding line:
 *
 *   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
 *   … & "%_prog%"  "%dp0%\node_modules\vite\bin\vite.js" %*
 *
 * Anything else (a hand-written batch file, another package manager's format)
 * returns null and falls back to a shell.
 */
function unwrapShim(shim: string, args: string[], env: NodeJS.ProcessEnv): Launch | null {
  let body: string;
  try {
    const st = fs.statSync(shim);
    // Shims are a few hundred bytes; anything larger is a real batch program.
    if (!st.isFile() || st.size > 16_384) return null;
    body = fs.readFileSync(shim, 'latin1');
  } catch {
    return null;
  }
  const dir = path.dirname(shim);
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const last = lines.filter(Boolean).pop() ?? '';

  // A native binary — spawn it in the shim's place.
  const direct = /^"%dp0%\\(.+?)"\s+%\*$/i.exec(last)?.[1];
  if (direct) {
    const target = path.join(dir, direct);
    return DIRECT_RE.test(target) && isFile(target) ? { file: target, args, shell: false } : null;
  }

  // An interpreted script — spawn the interpreter with the script as argv[1].
  const script = /"%_prog%"\s+"%dp0%\\(.+?)"\s+%\*$/i.exec(last)?.[1];
  if (!script) return null;
  const target = path.join(dir, script);
  if (!isFile(target)) return null;
  const interpreter = shimInterpreter(body, dir, env);
  return interpreter ? { file: interpreter, args: [target, ...args], shell: false } : null;
}

/** The shim's `_prog`: a runtime installed beside it (`%dp0%\node.exe`) when
 *  there is one, else a bare name to find on PATH. */
function shimInterpreter(body: string, dir: string, env: NodeJS.ProcessEnv): string | null {
  const local = /SET "_prog=%dp0%\\(.+?)"/i.exec(body)?.[1];
  if (local) {
    const p = path.join(dir, local);
    if (isFile(p)) return DIRECT_RE.test(p) ? p : null;
  }
  const global = /SET "_prog=([^"%\\/]+)"/i.exec(body)?.[1];
  if (!global) return null;
  const resolved = resolveCommandPath(global, env);
  return resolved && DIRECT_RE.test(resolved) ? resolved : null;
}

/**
 * Kill a child *and its descendants*. Agent CLIs spawn helpers of their own
 * (and an unwrappable shim still runs under cmd.exe), so killing just the
 * direct child can leave a turn running after Stop. Windows has no signals —
 * `child.kill('SIGTERM')` is already an immediate TerminateProcess — so the
 * only thing taskkill changes there is that the whole tree goes with it.
 */
export function killTree(child: { pid?: number; kill: (signal?: any) => boolean }, signal?: string): void {
  if (isWindows && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {}
      });
      return;
    } catch {
      // fall through to the plain kill below
    }
  }
  try {
    child.kill(signal as NodeJS.Signals);
  } catch {}
}
