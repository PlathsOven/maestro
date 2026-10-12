import net from 'node:net';
import { broadcast } from '../bus';
import { Workspaces } from '../db';
import { hostForWorkspace } from '../hosts';
import { backgroundFactor } from './activity';
import { run } from '../exec';
import type { ExecHost } from '../hosts/types';
import type { LocalServer } from '../../shared/types';

// Probe a workspace's dev-server port so the Preview tab can pulse whenever
// there's something to show — a dev server started from the terminal, a run
// script that just bound its port, or a remote server — independent of whether a
// preview view was ever opened (§5). One probe per interval per workspace, and
// only for workspaces someone is actually watching (the selected one, and any
// with a running script), so this stays cheap even over SSH.

const LOCAL_MS = 3_000;
const REMOTE_MS = 10_000; // one SSH exec per remote probe — go easy

type Reason = 'selected' | 'script';

interface Watcher {
  reasons: Set<Reason>;
  timer: NodeJS.Timeout | null;
  /** Last broadcast state; null until the first probe, so the first result is
   *  always sent even when it's "not listening". */
  listening: boolean | null;
}

const watchers = new Map<string, Watcher>();

/** Start (or add a reason to) watching a workspace's port. */
export function watchPort(workspaceId: string, reason: Reason): void {
  const existing = watchers.get(workspaceId);
  if (existing) {
    existing.reasons.add(reason);
    return;
  }
  watchers.set(workspaceId, { reasons: new Set([reason]), timer: null, listening: null });
  void tick(workspaceId); // probe now, then reschedule
}

/** Drop a reason; when none remain, stop probing and clear the pulse. */
export function unwatchPort(workspaceId: string, reason: Reason): void {
  const w = watchers.get(workspaceId);
  if (!w) return;
  w.reasons.delete(reason);
  if (w.reasons.size > 0) return;
  if (w.timer) clearTimeout(w.timer);
  watchers.delete(workspaceId);
  // Nobody's watching anymore: stop implying the server is up.
  if (w.listening) broadcast('port:state', { workspaceId, listening: false });
}

async function tick(workspaceId: string): Promise<void> {
  const w = watchers.get(workspaceId);
  if (!w) return;
  const ws = Workspaces.get(workspaceId);
  if (!ws) {
    if (w.timer) clearTimeout(w.timer);
    watchers.delete(workspaceId);
    return;
  }
  const host = hostForWorkspace(ws);
  let listening = false;
  try {
    listening = host.id === 'local' ? await probeLocal(ws.port) : await probeRemote(ws.port, host);
  } catch {
    listening = false;
  }
  const current = watchers.get(workspaceId);
  if (!current) return; // unwatched during the probe
  if (current.listening === null || current.listening !== listening) {
    current.listening = listening;
    broadcast('port:state', { workspaceId, listening });
  }
  // Nobody is watching a pulse they can't see: back off ×4 while the window is
  // in the background (perf-cpu-ram §4.6).
  const every = (host.id === 'local' ? LOCAL_MS : REMOTE_MS) * backgroundFactor();
  current.timer = setTimeout(() => void tick(workspaceId), every);
}

/** Listening ⇔ a TCP connect to 127.0.0.1:port succeeds within 1s. */
function probeLocal(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Listening ⇔ curl printed an exit code that isn't refused (7), timeout (28), or
 *  no-curl (127). Any HTTP status (even 404/500) counts — the server answered. */
async function probeRemote(port: number, host: ExecHost): Promise<boolean> {
  const r = await host.exec('sh', ['-c', `curl -s -o /dev/null -m 3 http://127.0.0.1:${port}/; echo $?`]);
  const code = r.stdout.trim().split(/\s+/).pop() ?? '';
  return /^\d+$/.test(code) && code !== '7' && code !== '28' && code !== '127';
}

// ---- other local servers (Preview's "Running on this machine") ----

let serversCache: { at: number; list: Promise<LocalServer[]> } | null = null;

/**
 * Web servers listening on loopback/any: `lsof` for the listeners, then an HTTP
 * probe keeps only ports that answer with HTML — databases, IPC and Maestro's
 * own sockets drop out. Cached for a few seconds (the Preview card polls it).
 * macOS/Linux; Windows (no lsof) reports none.
 */
export function listLocalServers(): Promise<LocalServer[]> {
  if (!serversCache || Date.now() - serversCache.at > 3_000) serversCache = { at: Date.now(), list: scanServers() };
  return serversCache.list;
}

async function scanServers(): Promise<LocalServer[]> {
  if (process.platform === 'win32') return [];
  const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeout: 5_000 });
  const found = new Map<number, string>();
  let pid = 0;
  let cmd = '';
  for (const line of r.stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'c') cmd = line.slice(1);
    else if (line[0] === 'n' && pid !== process.pid) {
      const m = /^(\*|127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1?\]):(\d+)$/.exec(line.slice(1));
      const port = m ? Number(m[2]) : 0;
      // Browsers' / Electron apps' DevTools endpoints serve HTML too — not an app.
      if (port >= 1024 && !found.has(port) && !/chrome|electron/i.test(cmd)) found.set(port, cmd);
    }
  }
  const probed = await Promise.all(
    [...found].slice(0, 40).map(async ([port, name]) => ((await servesHtml(port)) ? { port, process: name } : null))
  );
  return probed.filter((s) => s !== null).sort((a, b) => a.port - b.port);
}

async function servesHtml(port: number): Promise<boolean> {
  try {
    // localhost, not 127.0.0.1: dev servers often bind only ::1 (Vite on macOS).
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(800), redirect: 'manual' });
    void res.body?.cancel();
    return (res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}
