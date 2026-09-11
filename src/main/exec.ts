import { execa, type Options } from 'execa';
import { childEnv } from './env';
import { resolveLaunch } from './launch';
import type { ExecResult } from './hosts/types';

export type { ExecResult };

/** Run a command, never throw; normalize output. */
export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; input?: string; env?: Record<string, string | undefined> } = {}
): Promise<ExecResult> {
  try {
    const env = childEnv(opts.env ?? {});
    const timeout = opts.timeout ?? 60_000;
    // Launch the resolved target where we can (see launch.ts) so exec, agent
    // spawns and ptys all start the same file. When a shim resists unwrapping
    // we hand execa the bare name: it escapes cmd.exe properly, unlike `shell`.
    const launch = resolveLaunch(cmd, args, env);
    const [file, argv] = launch.shell ? [cmd, args] : [launch.file, launch.args];
    const res = await execa(file, argv, {
      cwd: opts.cwd,
      timeout,
      input: opts.input,
      env,
      extendEnv: false,
      reject: false,
      stripFinalNewline: false,
    } as Options);
    const stderr = typeof res.stderr === 'string' ? res.stderr : '';
    return {
      ok: res.exitCode === 0,
      stdout: typeof res.stdout === 'string' ? res.stdout : '',
      // A timeout kills the child before it can explain itself; say so rather
      // than reporting an empty failure.
      stderr: res.timedOut && !stderr.trim() ? `timed out after ${timeout}ms` : stderr,
      exitCode: res.exitCode ?? -1,
    };
  } catch (e: any) {
    return { ok: false, stdout: '', stderr: String(e?.shortMessage || e?.message || e), exitCode: -1 };
  }
}

export async function runOrThrow(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; input?: string; env?: Record<string, string | undefined> } = {}
): Promise<string> {
  const res = await run(cmd, args, opts);
  if (!res.ok) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `${cmd} ${args.join(' ')} failed`);
  }
  return res.stdout;
}
