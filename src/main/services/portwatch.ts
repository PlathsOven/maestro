import net from 'node:net';
import { broadcast } from '../bus';
import { Workspaces } from '../db';
import { hostForWorkspace } from '../hosts';
import type { ExecHost } from '../hosts/types';

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
  current.timer = setTimeout(() => void tick(workspaceId), host.id === 'local' ? LOCAL_MS : REMOTE_MS);
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
