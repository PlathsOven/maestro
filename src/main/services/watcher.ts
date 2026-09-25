import fs from 'fs';
import path from 'path';
import { broadcast } from '../bus';
import { Projects, Workspaces } from '../db';
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

// A throttle, not a debounce: the first change opens a short window and
// everything inside it coalesces. A debounce kept resetting while an agent
// edited continuously, freezing the UI's git state for the whole turn.
function nudge(wsId: string) {
  if (timers.has(wsId)) return;
  timers.set(
    wsId,
    setTimeout(() => {
      timers.delete(wsId);
      const fresh = Workspaces.get(wsId);
      if (fresh && !fresh.archived) broadcast('ws:updated', fresh);
    }, 400)
  );
}

/**
 * Commits, pushes, checkouts and `git add` only touch git's own files — for a
 * linked worktree those live outside it (its `.git` is a `gitdir:` pointer
 * file), so the tree watcher never sees them. Adds watchers on the
 * worktree's HEAD/index and on the shared refs for its branch and the base
 * (ahead/behind), filtered so other workspaces' commits don't nudge this one.
 */
function watchGitDirs(ws: Workspace, into: fs.FSWatcher[]) {
  const dotGit = path.join(ws.worktreePath, '.git');
  let gitDir = dotGit;
  let commonDir = dotGit;
  if (!fs.statSync(dotGit).isDirectory()) {
    gitDir = path.resolve(ws.worktreePath, fs.readFileSync(dotGit, 'utf8').replace(/^gitdir:/, '').trim());
    commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
  }
  // git writes `<name>.lock` and renames it into place.
  const name = (f: string | Buffer | null) => f?.toString().split(path.sep).join('/').replace(/\.lock$/, '');
  into.push(
    fs.watch(gitDir, (_ev, f) => {
      const n = name(f);
      if (n === 'HEAD' || n === 'index') nudge(ws.id);
    })
  );
  into.push(
    fs.watch(path.join(commonDir, 'refs'), { recursive: true }, (_ev, f) => {
      const n = name(f);
      const branch = Workspaces.get(ws.id)?.branch;
      const base = (Projects.get(ws.projectId)?.baseBranch ?? '').replace(/^origin\//, '');
      if (n === `heads/${branch}` || n === `remotes/origin/${branch}` || n === `remotes/origin/${base}`) nudge(ws.id);
    })
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
      const watchers = [watcher];
      try {
        watchGitDirs(ws, watchers);
      } catch {
        // unexpected git layout — the tree watcher + turn-end refreshes still apply
      }
      for (const w of watchers) w.on('error', () => unwatchWorkspace(ws.id));
      unwatchers.set(ws.id, () => {
        for (const w of watchers) {
          try {
            w.close();
          } catch {}
        }
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
