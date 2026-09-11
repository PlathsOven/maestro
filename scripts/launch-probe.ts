import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { resolveCommandPath, resolveLaunch } from '../src/main/launch';
import { localHost } from '../src/main/hosts/local';

/**
 * Proves the one invariant behind launch.ts: argv reaches a CLI byte-for-byte,
 * whatever the OS makes us go through to start it. Builds a fake npm-installed
 * CLI in a temp dir (both cmd-shim shapes, plus an unrecognizable batch file),
 * puts it on PATH, and launches it through every seam the app uses — exec,
 * spawnStream, pty — with arguments full of the characters cmd.exe would
 * otherwise eat. Also checks that killing a turn takes its children with it.
 *
 *   npx esbuild scripts/launch-probe.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:better-sqlite3 --external:node-pty --outfile=dist/launch-probe.cjs
 *   ELECTRON_RUN_AS_NODE=1 npx electron dist/launch-probe.cjs
 */

const isWin = process.platform === 'win32';
let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail && !ok ? `\n        ${detail}` : ''}`);
  if (!ok) failures++;
}

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}\n        actual   ${a}`);
}

// Every character class cmd.exe treats specially, plus a trailing backslash and
// a newline — the ones `shell: true` mangles or executes.
const NASTY = [
  'hello world',
  'a"b',
  'x&y',
  '%PATH%',
  'C:\\dir with space\\',
  '100%',
  '^caret',
  '(paren)',
  'a;b',
  'pipe|dollar$',
  'line1\nline2',
];

const PROBE_JS = `
const args = process.argv.slice(2);
if (args[0] === '--env') {
  process.stdout.write('ENV:' + JSON.stringify(process.env[args[1]] ?? null) + '\\n');
} else if (args[0] === '--spawn-child') {
  const kid = require('child_process').spawn(process.argv[0], ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  process.stdout.write('CHILD:' + kid.pid + '\\n');
  setTimeout(() => {}, 120000);
} else {
  process.stdout.write('ARGV:' + JSON.stringify(args) + '\\n');
}
`;

/** npm's cmd-shim output for a package whose bin is a native binary. */
const EXE_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
"%dp0%\\node_modules\\probe-pkg\\bin\\probe.exe"   %*\r
`;

/** npm's cmd-shim output for a package whose bin is a `#!/usr/bin/env node` script. */
const NODE_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\probe-pkg\\bin\\probe.js" %*\r
`;

/** A batch file we can't read a target out of — the shell fallback. */
const OPAQUE_SHIM = `@ECHO off\r
node "%~dp0node_modules\\probe-pkg\\bin\\probe.js" %*\r
`;

interface Fixture {
  bin: string;
  probeJs: string;
  /** command name whose shim runs an interpreted script */
  scriptCmd: string;
  /** command name whose shim runs a native binary (needs the script as argv[0]) */
  exeCmd: string | null;
  /** command name we deliberately can't unwrap */
  opaqueCmd: string | null;
  nodeExe: string | null;
}

function build(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-launch-'));
  const bin = path.join(root, 'bin');
  const pkg = path.join(bin, 'node_modules', 'probe-pkg', 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  const probeJs = path.join(pkg, 'probe.js');
  fs.writeFileSync(probeJs, PROBE_JS);

  if (!isWin) {
    // POSIX: a plain executable script, which the OS resolves and argv-escapes itself.
    const sh = path.join(bin, 'probe-script');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${probeJs}" "$@"\n`);
    fs.chmodSync(sh, 0o755);
    return { bin, probeJs, scriptCmd: 'probe-script', exeCmd: null, opaqueCmd: null, nodeExe: null };
  }

  // A real node.exe — under ELECTRON_RUN_AS_NODE `process.execPath` is
  // electron.exe, which children (whose env drops that var) would launch as a GUI.
  const nodeExe = resolveCommandPath('node', process.env);
  fs.writeFileSync(path.join(bin, 'probe-script.cmd'), NODE_SHIM);
  fs.writeFileSync(path.join(bin, 'probe-opaque.cmd'), OPAQUE_SHIM);
  let exeCmd: string | null = null;
  if (nodeExe) {
    for (const [src, dest] of [
      [nodeExe, path.join(bin, 'node.exe')],
      [nodeExe, path.join(pkg, 'probe.exe')],
    ]) {
      try {
        fs.linkSync(src, dest);
      } catch {
        fs.copyFileSync(src, dest); // different volume
      }
    }
    fs.writeFileSync(path.join(bin, 'probe-exe.cmd'), EXE_SHIM);
    exeCmd = 'probe-exe';
  }
  return { bin, probeJs, scriptCmd: 'probe-script', exeCmd, opaqueCmd: 'probe-opaque', nodeExe };
}

function parseArgv(out: string): unknown {
  const line = out.split(/\r?\n/).find((l) => l.startsWith('ARGV:'));
  return line ? JSON.parse(line.slice('ARGV:'.length)) : { missing: out.slice(0, 200) };
}

function streamed(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const child = localHost.spawnStream(cmd, args, {});
    child.onStdout((c) => (out += c));
    child.onError((e) => resolve(`ERROR:${e.message}`));
    child.onClose(() => resolve(out));
  });
}

/** The old approach, for comparison only: bare name + `shell: true`. */
function viaShell(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: isWin });
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (e) => resolve(`ERROR:${e.message}`));
    child.on('close', () => resolve(out));
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const fx = build();
  process.env.PATH = `${fx.bin}${path.delimiter}${process.env.PATH ?? ''}`;
  console.log(`fixture: ${fx.bin}\n`);

  // 1. Resolution — what we hand the OS instead of a shim.
  if (isWin) {
    const script = resolveLaunch(fx.scriptCmd, ['a'], process.env);
    check('shim (script) unwraps to its interpreter', script.file === path.join(fx.bin, 'node.exe') && !script.shell, script.file);
    eq('shim (script) prepends its script to argv', script.args, [fx.probeJs, 'a']);

    if (fx.exeCmd) {
      const exe = resolveLaunch(fx.exeCmd, ['a'], process.env);
      const want = path.join(fx.bin, 'node_modules', 'probe-pkg', 'bin', 'probe.exe');
      check('shim (native) unwraps to its binary', exe.file === want && !exe.shell && exe.args.length === 1, exe.file);
    }
    if (fx.opaqueCmd) {
      const opaque = resolveLaunch(fx.opaqueCmd, ['a'], process.env);
      check('unreadable shim falls back to a shell', opaque.shell && opaque.file === fx.opaqueCmd, JSON.stringify(opaque));
    }
    const missing = resolveLaunch('maestro-no-such-cli', [], process.env);
    check('unknown command is left for the launcher to report', !missing.shell && missing.file === 'maestro-no-such-cli');
    const direct = resolveLaunch('node', ['-v'], process.env);
    check('a real executable resolves to its own path', /node\.exe$/i.test(direct.file) && !direct.shell, direct.file);
  } else {
    const l = resolveLaunch(fx.scriptCmd, ['a']);
    eq('off Windows resolveLaunch is identity', [l.file, l.args, l.shell], [fx.scriptCmd, ['a'], false]);
  }

  // 2. argv fidelity through every seam the app launches processes with.
  eq('spawnStream (agent turns) preserves argv', parseArgv(await streamed(fx.scriptCmd, NASTY)), NASTY);

  const exec = await localHost.exec(fx.scriptCmd, NASTY, {});
  eq('exec (detection, git, one-shot LLM) preserves argv', parseArgv(exec.stdout), NASTY);

  if (fx.exeCmd) {
    eq('spawnStream via a native-binary shim preserves argv', parseArgv(await streamed(fx.exeCmd, [fx.probeJs, ...NASTY])), NASTY);
  }

  // 3. The pty seam (terminals, run scripts) resolves the same shim.
  const ptyOut = await new Promise<string>((resolve) => {
    let out = '';
    const pty = localHost.pty({ cwd: fx.bin, cols: 400, rows: 24, command: { file: fx.scriptCmd, args: ['pty ok'] } });
    const timer = setTimeout(() => resolve(out), 15_000);
    pty.onData((c) => {
      out += c;
      if (out.includes('ARGV:')) {
        clearTimeout(timer);
        resolve(out);
      }
    });
    pty.onExit(() => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  check('pty launches the shim', ptyOut.includes('"pty ok"'), ptyOut.slice(0, 200));

  // 4. env unset reaches the child (how the one-shot LLM drops CLAUDECODE).
  process.env.MAESTRO_PROBE_VAR = 'inherited';
  const inherited = await localHost.exec(fx.scriptCmd, ['--env', 'MAESTRO_PROBE_VAR'], {});
  check('a plain env var is inherited', inherited.stdout.includes('ENV:"inherited"'), inherited.stdout.slice(0, 200));
  const unset = await localHost.exec(fx.scriptCmd, ['--env', 'MAESTRO_PROBE_VAR'], {
    env: { MAESTRO_PROBE_VAR: undefined },
  });
  check('an undefined env value unsets it', unset.stdout.includes('ENV:null'), unset.stdout.slice(0, 200));

  // 5. Stopping a turn takes the CLI's children with it.
  const grandchild = await new Promise<number>((resolve) => {
    const child = localHost.spawnStream(fx.scriptCmd, ['--spawn-child'], {});
    child.onStdout((c) => {
      const m = /CHILD:(\d+)/.exec(c);
      if (m) {
        child.kill();
        resolve(Number(m[1]));
      }
    });
    child.onError(() => resolve(-1));
  });
  if (grandchild > 0) {
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(100);
      gone = !alive(grandchild);
    }
    check('kill() reaps the whole process tree', gone, `pid ${grandchild} still alive`);
  } else {
    check('kill() reaps the whole process tree', false, 'never saw a grandchild pid');
  }

  // 6. For the record: what the old `shell: true` path did with the same argv.
  const before = parseArgv(await viaShell(fx.scriptCmd, NASTY));
  console.log(`\n  (old shell:true path returned: ${JSON.stringify(before).slice(0, 160)})`);

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
