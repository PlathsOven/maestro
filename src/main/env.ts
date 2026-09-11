import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';

// Apps launched from Finder/Dock get a minimal PATH that misses homebrew,
// nvm, ~/.local/bin, etc. Resolve the user's login-shell environment once at
// startup so `git`, `gh`, `claude`, ... resolve the same way they do in a
// terminal.
const isWindows = process.platform === 'win32';
let resolved = false;

function prependGhToPath(extras: string[]) {
  const parts = (process.env.PATH || '').split(path.delimiter);
  for (const e of extras) if (e && !parts.includes(e)) parts.push(e);
  process.env.PATH = parts.join(path.delimiter);
}

export function resolveShellEnv() {
  if (resolved) return;
  resolved = true;
  const ghBin = path.join(maestroHome(), 'tools', 'gh-cli', 'bin');
  // Where installRoleCli drops the `maestro-role` launcher agents delegate to.
  const rolesBin = path.join(maestroHome(), 'tools', 'bin');
  // Windows GUI apps inherit the full user PATH (unlike macOS Finder/Dock, which
  // hand launched apps a minimal PATH), so there's no login-shell env to probe —
  // just make sure Maestro's own downloaded gh is reachable.
  if (isWindows) {
    prependGhToPath([ghBin, rolesBin]);
    return;
  }
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = spawnSync(shell, ['-lc', 'env'], {
      encoding: 'utf8',
      timeout: 8000,
    });
    if (out.status === 0 && out.stdout) {
      for (const line of out.stdout.split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        // SSH_AUTH_SOCK: GUI apps launched from Finder don't inherit the login
        // shell's ssh-agent socket, so SSH-agent auth (§6.6) would fail without
        // pulling it in here.
        if (key === 'PATH' || key === 'HOME' || key === 'NVM_DIR' || key === 'GOPATH' || key === 'SSH_AUTH_SOCK') {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // keep whatever PATH we have
  }
  // Belt and braces: common tool locations, plus Maestro's own downloaded
  // GitHub CLI so agents and scripts can call `gh` even without a system copy.
  prependGhToPath([
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), 'bin'),
    ghBin,
    rolesBin,
  ]);
}

/** Environment passed to child processes (git, gh, harness CLIs, ptys). An
 *  `undefined` value in `extra` unsets an inherited var rather than adding one. */
export function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('npm_')) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * Strip vars that make a harness CLI think it's nested inside another agent
 * session (Maestro itself may have been launched from a CLI agent). Applied to
 * the *final* agent-spawn env by every ExecHost — on the remote env for SSH
 * hosts, not the laptop's (spec §6.2 contract b).
 */
export function stripNestedAgentVars<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  delete out.CLAUDECODE;
  delete out.CLAUDE_CODE_ENTRYPOINT;
  delete out.CLAUDE_CODE_SSE_PORT;
  // [verify] Grok's own subprocess markers (spec §5.2/§8.8) — confirm the real
  // names by running `env | grep -i grok` from inside a Grok shell tool call.
  // Deleting absent keys is a harmless no-op; clearing them lets a Grok turn shell
  // out to other agent CLIs without them thinking they're nested in a Grok session.
  delete out.GROK_CLI;
  delete out.GROK_SESSION_ID;
  return out;
}

export function userShell(): string {
  if (isWindows) {
    // PowerShell 5 (`powershell.exe`) ships with every supported Windows; prefer
    // it over cmd for the interactive terminal. COMSPEC is the last resort.
    return process.env.MAESTRO_SHELL || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

/**
 * How to run a setup/run script body through the user's shell as `{file, args}`
 * for a pty. POSIX shells take `-lc <body>`; PowerShell takes `-Command <body>`.
 * (Script bodies are inherently shell-specific — a bash script won't run under
 * PowerShell — but this at least invokes the right interpreter per OS.)
 */
export function scriptShell(body: string): { file: string; args: string[] } {
  if (isWindows) {
    return { file: userShell(), args: ['-NoProfile', '-Command', body] };
  }
  return { file: userShell(), args: ['-lc', body] };
}

export function maestroHome(): string {
  return process.env.MAESTRO_HOME || path.join(os.homedir(), 'maestro');
}
