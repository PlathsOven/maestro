import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { resolveLaunch } from '../launch';
import { run } from '../exec';
import { childEnv } from '../env';
import { broadcast } from '../bus';
import { safeResolve } from './files';
import type { KernelStatus } from '../../shared/types';

// In-app Jupyter kernel execution. We don't reimplement the ZMQ messaging
// protocol in Node — instead a tiny Python bridge (below) runs under the
// discovered interpreter, uses `jupyter_client` to drive an in-process ipykernel,
// and speaks newline-delimited JSON over stdio. The kernel *is* the discovered
// interpreter (sys.executable), so a project venv's packages are available
// without registering a kernelspec.

// ---------------- the Python bridge ----------------

// Kept in sync with scripts we validate standalone. Newlines inside Python
// string literals are written `\\n` so they survive this JS template literal.
const BRIDGE_SOURCE = String.raw`
import sys, json, threading, queue
from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpec

out_lock = threading.Lock()
def emit(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()

def main():
    km = KernelManager()
    # Force the kernel to be *this* interpreter's ipykernel, so a project venv's
    # packages are available regardless of which kernelspecs are registered.
    km._kernel_spec = KernelSpec(
        argv=[sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name="maestro", language="python")
    try:
        km.start_kernel()
    except Exception as e:
        emit({"type": "fatal", "message": "start: %s" % e}); return
    kc = km.client(); kc.start_channels()
    try:
        kc.wait_for_ready(timeout=60)
    except Exception as e:
        emit({"type": "fatal", "message": "ready: %s" % e}); km.shutdown_kernel(now=True); return
    parents = {}; plock = threading.Lock()
    emit({"type": "ready"}); emit({"type": "status", "state": "idle"})
    def cell_for(msg):
        with plock: return parents.get(msg.get("parent_header", {}).get("msg_id"))
    def iopub():
        while True:
            try: msg = kc.get_iopub_msg(timeout=1)
            except queue.Empty: continue
            except Exception: break
            mt = msg["header"]["msg_type"]; c = msg["content"]; cid = cell_for(msg)
            if mt == "status": emit({"type":"status","state":c.get("execution_state","idle")})
            elif cid is None: continue
            elif mt == "execute_input": emit({"type":"input","id":cid,"execution_count":c.get("execution_count")})
            elif mt == "stream": emit({"type":"output","id":cid,"output":{"output_type":"stream","name":c.get("name","stdout"),"text":c.get("text","")}})
            elif mt in ("execute_result","display_data"):
                o = {"output_type":mt,"data":c.get("data",{}),"metadata":c.get("metadata",{})}
                if mt=="execute_result": o["execution_count"]=c.get("execution_count")
                emit({"type":"output","id":cid,"output":o})
            elif mt == "error": emit({"type":"output","id":cid,"output":{"output_type":"error","ename":c.get("ename",""),"evalue":c.get("evalue",""),"traceback":c.get("traceback",[])}})
            elif mt == "clear_output": emit({"type":"clear","id":cid})
    def shell():
        while True:
            try: msg = kc.get_shell_msg(timeout=1)
            except queue.Empty: continue
            except Exception: break
            if msg["header"]["msg_type"] == "execute_reply":
                pid = msg.get("parent_header",{}).get("msg_id")
                with plock: cid = parents.pop(pid, None)
                c = msg["content"]
                if cid is not None: emit({"type":"reply","id":cid,"status":c.get("status","ok"),"execution_count":c.get("execution_count")})
    threading.Thread(target=iopub, daemon=True).start()
    threading.Thread(target=shell, daemon=True).start()
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: cmd = json.loads(line)
        except Exception: continue
        t = cmd.get("type")
        if t == "execute":
            mid = kc.execute(cmd.get("code",""), allow_stdin=False)
            with plock: parents[mid] = cmd.get("id")
        elif t == "interrupt": km.interrupt_kernel()
        elif t == "shutdown": break
        # (restart is a Node-side re-spawn — jupyter_client's in-process restart raced.)
    try: kc.stop_channels(); km.shutdown_kernel(now=True)
    except Exception: pass

main()
`;

let bridgePath: string | null = null;
function ensureBridgeFile(): string {
  if (bridgePath && fs.existsSync(bridgePath)) return bridgePath;
  const p = path.join(os.tmpdir(), 'maestro-jupyter-bridge.py');
  fs.writeFileSync(p, BRIDGE_SOURCE, 'utf8');
  bridgePath = p;
  return p;
}

// ---------------- Python discovery (per worktree, cached) ----------------

const PROBE = 'import jupyter_client, ipykernel, sys; print(sys.version.split()[0])';

interface JupyterCaps {
  available: boolean;
  python?: string;
  version?: string;
  reason?: string;
}

const capsCache = new Map<string, JupyterCaps>();

function pythonCandidates(worktreePath: string): string[] {
  const venvs = process.platform === 'win32'
    ? ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe', '.venv/Scripts/python']
    : ['.venv/bin/python', 'venv/bin/python', '.venv/bin/python3', 'venv/bin/python3'];
  return [...venvs.map((v) => path.join(worktreePath, v)), 'python3', 'python'];
}

export async function jupyterCapabilities(worktreePath: string): Promise<JupyterCaps> {
  const cached = capsCache.get(worktreePath);
  if (cached) return cached;
  let sawPython = false;
  for (const cand of pythonCandidates(worktreePath)) {
    // Skip venv paths that don't exist to avoid a spawn error per candidate.
    if (path.isAbsolute(cand) && !fs.existsSync(cand)) continue;
    const r = await run(cand, ['-c', PROBE], { cwd: worktreePath, timeout: 20_000 });
    if (r.ok) {
      const caps: JupyterCaps = { available: true, python: cand, version: r.stdout.trim() };
      capsCache.set(worktreePath, caps);
      return caps;
    }
    // A python that runs but lacks the modules → record so the message is precise.
    if (r.exitCode === 1 || /ModuleNotFoundError|No module named/i.test(r.stderr)) sawPython = true;
  }
  const caps: JupyterCaps = {
    available: false,
    reason: sawPython
      ? 'Python is installed but jupyter_client / ipykernel are missing. Install them in your project env: pip install jupyter_client ipykernel'
      : 'No Python found. Install Python 3 plus jupyter_client and ipykernel to run notebook cells.',
  };
  capsCache.set(worktreePath, caps);
  return caps;
}

// ---------------- kernel sessions (one per open notebook) ----------------

interface BridgeMsg {
  type: 'ready' | 'status' | 'output' | 'clear' | 'input' | 'reply' | 'fatal';
  state?: string;
  id?: string;
  output?: Record<string, unknown>;
  execution_count?: number | null;
  status?: string;
  message?: string;
}

class KernelSession {
  proc: ChildProcessWithoutNullStreams | null = null;
  status: KernelStatus = 'none';
  ready = false;
  private buf = '';
  private pending: { cellId: string; code: string }[] = [];

  constructor(
    readonly wsId: string,
    readonly relPath: string,
    readonly cwd: string,
    readonly python: string
  ) {}

  private emitState(status: KernelStatus, error?: string) {
    this.status = status;
    broadcast('jupyter:state', { workspaceId: this.wsId, path: this.relPath, status, kernelName: 'python3', error });
  }

  start(): void {
    if (this.proc) return;
    this.ready = false;
    this.emitState('starting');
    const env = childEnv({ PYTHONUNBUFFERED: '1' });
    // `this.python` may be a bare `python`/`python3`, which on Windows can be a
    // launcher script rather than an executable — resolve it like any other CLI.
    const launch = resolveLaunch(this.python, ['-u', ensureBridgeFile()], env);
    const proc = spawn(launch.file, launch.args, { cwd: this.cwd, env, shell: launch.shell });
    this.proc = proc;
    proc.stdout.on('data', (d: Buffer) => {
      if (this.proc === proc) this.onData(d.toString());
    });
    proc.stderr.on('data', () => {
      /* kernel/bridge stderr is noisy (deprecations); surfaced only via fatal */
    });
    // Guard on identity: an old process exiting during a restart (we've already
    // spawned its replacement) must NOT flip the session to 'dead'.
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = false;
      this.emitState('dead');
    });
    proc.on('error', (e) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = false;
      this.emitState('dead', e.message);
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onMsg(line);
    }
  }

  private onMsg(line: string) {
    let msg: BridgeMsg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        for (const p of this.pending.splice(0)) this.send({ type: 'execute', id: p.cellId, code: p.code });
        break;
      case 'status':
        // Kernel busy/idle → session status (keep 'starting' until first ready).
        if (msg.state === 'busy') this.emitState('busy');
        else if (msg.state === 'idle' && this.ready) this.emitState('idle');
        break;
      case 'fatal':
        this.emitState('dead', msg.message);
        this.shutdown();
        break;
      case 'output':
        broadcast('jupyter:cell', { workspaceId: this.wsId, path: this.relPath, cellId: msg.id!, kind: 'output', output: msg.output });
        break;
      case 'clear':
        broadcast('jupyter:cell', { workspaceId: this.wsId, path: this.relPath, cellId: msg.id!, kind: 'clear' });
        break;
      case 'input':
        broadcast('jupyter:cell', {
          workspaceId: this.wsId, path: this.relPath, cellId: msg.id!, kind: 'input', executionCount: msg.execution_count,
        });
        break;
      case 'reply':
        broadcast('jupyter:cell', {
          workspaceId: this.wsId, path: this.relPath, cellId: msg.id!, kind: 'reply',
          executionCount: msg.execution_count, status: msg.status as 'ok' | 'error' | 'aborted',
        });
        break;
    }
  }

  private send(obj: Record<string, unknown>) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  execute(cellId: string, code: string) {
    if (!this.proc) this.start();
    if (this.ready) this.send({ type: 'execute', id: cellId, code });
    else this.pending.push({ cellId, code }); // flushed on 'ready'
  }

  interrupt() {
    this.send({ type: 'interrupt' });
  }

  /** Fresh kernel = fresh namespace. Re-spawning the bridge is simpler and more
   *  reliable than jupyter_client's in-process `restart_kernel` (which raced and
   *  could take the bridge down with it); the old process's guarded exit handler
   *  no longer fires 'dead' since `this.proc` already points at the new one. */
  restart() {
    this.emitState('restarting');
    this.pending = [];
    const old = this.proc;
    this.proc = null;
    this.ready = false;
    if (old) {
      try {
        if (old.stdin.writable) old.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          if (!old.killed) old.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 1500);
    }
    this.start();
  }

  shutdown() {
    this.pending = [];
    const proc = this.proc;
    if (!proc) return;
    this.send({ type: 'shutdown' });
    // Hard-kill if it doesn't exit promptly.
    setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
  }
}

const sessions = new Map<string, KernelSession>();
const starting = new Map<string, Promise<{ session?: KernelSession; error?: string }>>();
const keyOf = (wsId: string, relPath: string) => `${wsId}:${relPath}`;

async function ensureSession(
  wsId: string,
  worktreePath: string,
  relPath: string
): Promise<{ session?: KernelSession; error?: string }> {
  const key = keyOf(wsId, relPath);
  const existing = sessions.get(key);
  if (existing && existing.proc) return { session: existing };
  // Coalesce concurrent starts (e.g. "Run all" firing every cell at once) onto a
  // single kernel — without this, each racing call would spawn its own.
  const inflight = starting.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const caps = await jupyterCapabilities(worktreePath);
    if (!caps.available || !caps.python) return { error: caps.reason ?? 'No Jupyter kernel available' };
    const abs = safeResolve(worktreePath, relPath);
    const cwd = abs ? path.dirname(abs) : worktreePath;
    const session = new KernelSession(wsId, relPath, cwd, caps.python);
    sessions.set(key, session);
    session.start();
    return { session };
  })();
  starting.set(key, p);
  try {
    return await p;
  } finally {
    starting.delete(key);
  }
}

export async function startKernel(
  wsId: string,
  worktreePath: string,
  relPath: string
): Promise<{ ok: boolean; status: KernelStatus; error?: string }> {
  const { session, error } = await ensureSession(wsId, worktreePath, relPath);
  if (!session) return { ok: false, status: 'none', error };
  return { ok: true, status: session.status };
}

export async function executeCell(
  wsId: string,
  worktreePath: string,
  relPath: string,
  cellId: string,
  code: string
): Promise<{ ok: boolean; error?: string }> {
  const { session, error } = await ensureSession(wsId, worktreePath, relPath);
  if (!session) return { ok: false, error };
  session.execute(cellId, code);
  return { ok: true };
}

export function interruptKernel(wsId: string, relPath: string): void {
  sessions.get(keyOf(wsId, relPath))?.interrupt();
}

export async function restartKernel(
  wsId: string,
  worktreePath: string,
  relPath: string
): Promise<{ ok: boolean; error?: string }> {
  const existing = sessions.get(keyOf(wsId, relPath));
  if (existing && existing.proc) {
    existing.restart();
    return { ok: true };
  }
  const { session, error } = await ensureSession(wsId, worktreePath, relPath);
  return session ? { ok: true } : { ok: false, error };
}

export function shutdownKernel(wsId: string, relPath: string): void {
  const key = keyOf(wsId, relPath);
  const s = sessions.get(key);
  if (s) {
    s.shutdown();
    sessions.delete(key);
  }
}

export function kernelStatus(wsId: string, relPath: string): { status: KernelStatus; kernelName?: string } {
  const s = sessions.get(keyOf(wsId, relPath));
  return { status: s?.status ?? 'none', kernelName: 'python3' };
}

export function shutdownAllKernels(): void {
  for (const s of sessions.values()) s.shutdown();
  sessions.clear();
}
