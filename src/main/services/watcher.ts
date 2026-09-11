import fs from 'fs';
import path from 'path';
import { broadcast } from '../bus';
import { Workspaces } from '../db';
import { hostForWorkspace } from '../hosts';
import type { ExecHost } from '../hosts/types';
import type { ContextFile, Workspace } from '../../shared/types';

// Watch worktrees so the UI can refresh dirty state / diffs as agents edit
// files. Local projects use recursive fs.watch (debounced, filename-filtered);
// remote projects use the host's trigger-based watcher (a slow poll — §6.8),
// on top of the turn-boundary ws:updated broadcasts the harness already emits.

const unwatchers = new Map<string, () => void>();
const timers = new Map<string, NodeJS.Timeout>();

const NOISY = /(^|\/)(\.git|node_modules|\.context|dist|build|\.next|target|__pycache__|\.venv)(\/|$)/;

function nudge(wsId: string) {
  const prev = timers.get(wsId);
  if (prev) clearTimeout(prev);
  timers.set(
    wsId,
    setTimeout(() => {
      timers.delete(wsId);
      const fresh = Workspaces.get(wsId);
      if (fresh && !fresh.archived) broadcast('ws:updated', fresh);
    }, 800)
  );
}

export function watchWorkspace(ws: Workspace) {
  if (unwatchers.has(ws.id)) return;
  const host: ExecHost = hostForWorkspace(ws);

  if (host.id === 'local') {
    // Local: recursive fs.watch, filtering the noisy churn dirs (unchanged).
    if (!fs.existsSync(ws.worktreePath)) return;
    try {
      const watcher = fs.watch(ws.worktreePath, { recursive: true }, (_ev, filename) => {
        if (filename && NOISY.test(filename.toString())) return;
        nudge(ws.id);
      });
      watcher.on('error', () => unwatchWorkspace(ws.id));
      unwatchers.set(ws.id, () => {
        try {
          watcher.close();
        } catch {}
      });
    } catch {
      // recursive fs.watch unsupported → skip silently
    }
    return;
  }

  // Remote: the host's trigger-based watcher (poller). onChange is already
  // coalesced by nudge()'s debounce.
  const off = host.watch(ws.worktreePath, () => nudge(ws.id));
  unwatchers.set(ws.id, off);
}

export function unwatchWorkspace(workspaceId: string) {
  const off = unwatchers.get(workspaceId);
  if (off) {
    off();
    unwatchers.delete(workspaceId);
  }
  const t = timers.get(workspaceId);
  if (t) clearTimeout(t);
  timers.delete(workspaceId);
}

export function watchAllActive() {
  for (const ws of Workspaces.list()) {
    if (!ws.archived) watchWorkspace(ws);
  }
}

export async function listContextFiles(ws: Workspace): Promise<ContextFile[]> {
  const host = hostForWorkspace(ws);
  const p = host.path;
  const root = p.join(ws.worktreePath, '.context');
  const out: ContextFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: { name: string; dir: boolean }[];
    try {
      entries = await host.fs.readdir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = p.join(dir, e.name);
      if (e.dir) await walk(full);
      else {
        try {
          const st = await host.fs.stat(full);
          out.push({ path: p.relative(ws.worktreePath, full), size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 100);
}
