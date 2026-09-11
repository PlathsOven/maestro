import fs from 'fs';
import path from 'path';
import { broadcast } from '../bus';
import { maestroHome } from '../env';
import { Hosts, Projects, Scheduled, Settings, Workspaces, uid } from '../db';
import { localHost } from '../hosts/local';
import { hostById, hostForWorkspace } from '../hosts';
import type { ExecHost } from '../hosts/types';
import { slugify } from '../names';
import * as git from './git';
import { readRepoSettings } from './settingsToml';
import { runSetupAndWait } from './scripts';
import { stopWorkspaceAgents } from './harness';
import { killWorkspacePtys } from './pty';
import { unwatchWorkspace, watchWorkspace } from './watcher';
import { clearCloudJobs, startFollower, stopCloudTurn, stopFollower } from './cloud';
import { publishConversation } from './account';
import type { Project, Workspace } from '../../shared/types';

/**
 * Moving a conversation on/off the cloud (spec §6.6). A cloud conversation of a
 * local git project is a *remote worktree*: its branch and uncommitted work are
 * carried over the already-authenticated SSH transport via git bundles — no new
 * credential surface. Sessions are host-bound, so they're cleared on the move
 * (the next message seeds a fresh session, at the token cost the UI warned about).
 */

// POSIX single-quote.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const CHECKPOINT = (wsId: string) => `refs/maestro/checkpoint/${wsId}`;

/** The box's $HOME (cheap, uncached — moves are rare). */
async function homeOf(host: ExecHost): Promise<string> {
  const r = await host.exec('sh', ['-lc', 'printf %s "$HOME"']);
  return r.stdout.trim() || '.';
}

function mirrorPath(home: string, host: ExecHost, projectId: string): string {
  return host.path.join(home, 'maestro', 'mirrors', `${projectId}.git`);
}

function remoteWorktreePath(home: string, host: ExecHost, project: Project, ws: Workspace): string {
  return host.path.join(home, 'maestro', 'workspaces', slugify(project.name), ws.name);
}

/** Snapshot tracked dirty state as a stash-format commit and pin it to a ref, so
 *  it travels in the bundle. Returns the ref (or null when the tree is clean). */
async function checkpointDirty(host: ExecHost, wtPath: string, wsId: string): Promise<string | null> {
  const created = await host.exec('git', ['stash', 'create', 'maestro: cloud move'], { cwd: wtPath });
  const sha = created.stdout.trim();
  if (!created.ok || !sha) return null; // clean tree
  const ref = CHECKPOINT(wsId);
  await host.exec('git', ['update-ref', ref, sha], { cwd: wtPath });
  return ref;
}

/** Refs currently in a bare mirror, as SHAs (empty when it doesn't exist yet). */
async function mirrorShas(host: ExecHost, mirror: string): Promise<string[]> {
  const r = await host.exec('git', ['ls-remote', mirror]);
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.split('\t')[0]?.trim())
    .filter((s): s is string => !!s && /^[0-9a-f]{7,40}$/.test(s));
}

/**
 * Bundle `refs` from `srcWt` into a temp file on `srcHost`, download it, and push
 * it into `dstRepo` on `dstHost`, fetching each ref. `basisShas` are commits the
 * destination already has (so the bundle is incremental); unknown ones are
 * dropped. Returns false when there was nothing new to send.
 */
async function bundleTransfer(opts: {
  srcHost: ExecHost;
  srcWt: string;
  dstHost: ExecHost;
  dstRepo: string;
  refs: string[]; // e.g. ['refs/heads/foo', 'refs/maestro/checkpoint/x']
  basisShas: string[];
}): Promise<boolean> {
  const { srcHost, srcWt, dstHost, dstRepo, refs, basisShas } = opts;
  // Keep only basis commits the source actually has, so `--not` never errors.
  const known: string[] = [];
  for (const sha of basisShas) {
    if ((await srcHost.exec('git', ['cat-file', '-e', sha], { cwd: srcWt })).ok) known.push(sha);
  }
  // A worktree's `.git` is a file, not a dir — write the temp bundle in the repo
  // root (removed right after) so `git bundle create` has somewhere to put it.
  const srcBundle = srcHost.path.join(srcWt, `.maestro-${uid().slice(0, 8)}.bundle`);
  const revArgs = [...refs, ...known.flatMap((s) => ['--not', s])];
  const made = await srcHost.exec('git', ['bundle', 'create', srcBundle, ...revArgs], { cwd: srcWt, timeout: 300_000 });
  if (!made.ok) {
    // "Refusing to create empty bundle" ⇒ the destination is already up to date.
    if (/empty bundle/i.test(made.stderr)) return false;
    throw new Error(made.stderr.trim() || 'git bundle create failed');
  }
  // Move the bytes across the SSH transport (sftp), src → laptop → dst.
  const bytes = await srcHost.fs.read(srcBundle);
  await srcHost.fs.rm(srcBundle).catch(() => {});
  const dstBundle = dstHost.path.join(dstRepo, `maestro-${uid().slice(0, 8)}.bundle`);
  await dstHost.fs.write(dstBundle, bytes);
  try {
    // Fetch each ref independently and tolerate a missing one: `git bundle` omits
    // a ref that has no new commits vs the basis (e.g. the branch is unchanged and
    // only the working tree was dirty), and an atomic multi-ref fetch would then
    // fail wholesale — but the destination already has that ref.
    let any = false;
    for (const r of refs) {
      const f = await dstHost.exec('git', ['fetch', dstBundle, `+${r}:${r}`], { cwd: dstRepo, timeout: 300_000 });
      if (f.ok) any = true;
    }
    if (!any) throw new Error('git fetch <bundle> updated no refs');
  } finally {
    await dstHost.fs.rm(dstBundle).catch(() => {});
  }
  return true;
}

function setStatus(wsId: string, patch: Partial<Workspace>) {
  const fresh = Workspaces.get(wsId);
  if (!fresh) return;
  Object.assign(fresh, patch);
  Workspaces.update(fresh);
  broadcast('ws:updated', fresh);
}

/**
 * Move a conversation to the cloud (hostId set) or bring it local (hostId null).
 * Async; the workspace row goes through the normal setting-up → idle lifecycle,
 * broadcast as it progresses.
 */
export async function setWorkspaceCloud(
  workspaceId: string,
  hostId: string | null
): Promise<{ ok: boolean; error?: string }> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const project = Projects.get(ws.projectId);
  if (!project) return { ok: false, error: 'Project not found' };

  // Only worktree workspaces of a LOCAL git project can move (§6.6). Folder
  // projects have nothing to sync; SSH projects already run on the box.
  if (project.hostId) return { ok: false, error: 'This project already runs on a server.' };
  if (project.kind !== 'git' || ws.wsKind !== 'worktree') {
    return { ok: false, error: 'Only branch workspaces of a git project can run in the cloud.' };
  }
  const target = (ws.hostId ?? null) ? ws.hostId! : null;
  if ((hostId ?? null) === target) return { ok: true }; // already there

  // Bringing local: box-owned scheduled rows have their job files on the server,
  // so refuse rather than orphan them on a host we're disconnecting from (§4.6).
  if (!hostId && Scheduled.forWorkspace(ws.id).some((m) => m.remoteTurnId)) {
    return { ok: false, error: 'Cancel or send the scheduled messages first' };
  }

  setStatus(ws.id, { status: 'setting-up', setupError: null });
  try {
    if (hostId) await moveToCloud(project, ws, hostId);
    else await bringLocal(project, ws);
    // Publish the moved conversation to Maestro Web so it appears (or disappears
    // as local-only) on the phone promptly (mobile-web §6.9 publish hook).
    const fresh = Workspaces.get(ws.id);
    if (fresh) void publishConversation(fresh, 1).catch(() => {});
    return { ok: true };
  } catch (e: any) {
    setStatus(ws.id, { status: 'needs-attention', setupError: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function moveToCloud(project: Project, ws: Workspace, hostId: string): Promise<void> {
  const host = hostById(hostId);
  await host.connect?.();
  const home = await homeOf(host);
  const mirror = mirrorPath(home, host, project.id);
  const remoteWt = remoteWorktreePath(home, host, project, ws);
  const branchRef = `refs/heads/${ws.branch}`;

  // The local turn (if any) and its watchers stop; the conversation is leaving.
  stopWorkspaceAgents(ws.id);
  killWorkspacePtys(ws.id);
  unwatchWorkspace(ws.id);

  // 1. Checkpoint dirty state so uncommitted work travels.
  const chkRef = await checkpointDirty(localHost, ws.worktreePath, ws.id);

  // 2. Ensure the bare mirror, then push the branch (+ checkpoint) incrementally.
  await host.fs.mkdirp(host.path.dirname(mirror));
  await host.exec('git', ['init', '--bare', mirror]);
  const refs = [branchRef, ...(chkRef ? [chkRef] : [])];
  await bundleTransfer({
    srcHost: localHost,
    srcWt: ws.worktreePath,
    dstHost: host,
    dstRepo: mirror,
    refs,
    basisShas: await mirrorShas(host, mirror),
  });

  // 3. Cut the remote worktree from the mirror, then restore the checkpoint.
  await host.fs.rm(remoteWt).catch(() => {});
  await host.exec('git', ['worktree', 'prune'], { cwd: mirror });
  await git.worktreeAddExistingBranch(mirror, remoteWt, ws.branch, host);
  await git.ensureContextDir(remoteWt, host);
  if (chkRef) {
    await host.exec('git', ['stash', 'apply', CHECKPOINT(ws.id)], { cwd: remoteWt }).catch(() => {});
  }

  // 4. Flip the workspace onto the host and clear the (host-bound) sessions.
  Workspaces.setCloudHost(ws.id, hostId);
  Workspaces.clearSessions(ws.id);
  // On a shared managed box, re-home the port into this user's assigned block so
  // WORKSPACE_PORT can't collide with a neighbor's (§3).
  const portBase = Hosts.get(hostId)?.portBase;
  const port = portBase != null ? Settings.nextPort(portBase) : ws.port;
  setStatus(ws.id, { hostId, worktreePath: remoteWt, port });

  // 5. Restore ignored files on the box (deps/.env) via the repo setup script.
  const setup = readRepoSettings(project.repoPath).setupScript;
  const fresh = Workspaces.get(ws.id)!;
  if (setup.trim()) {
    const code = await runSetupAndWait(fresh, setup, 15 * 60_000, host).catch(() => 1);
    if (code !== 0) setStatus(ws.id, { setupError: `Setup script exited with code ${code}` });
  }

  // 6. Remove the local worktree — bookkeeping + chat history stay put.
  await git.worktreeRemove(project.repoPath, ws.worktreePath).catch(() => {});

  const done = Workspaces.get(ws.id)!;
  setStatus(ws.id, { status: done.setupError ? 'needs-attention' : 'idle' });
  startFollower(done, 1);
}

async function bringLocal(project: Project, ws: Workspace): Promise<void> {
  const host = hostForWorkspace(ws);
  const home = await homeOf(host);
  const mirror = mirrorPath(home, host, project.id);
  const branchRef = `refs/heads/${ws.branch}`;
  const localWt = path.join(maestroWorkspacesRoot(project), ws.name);

  // Settle the box: stop tailing, stop the current turn, clear pending jobs.
  stopFollower(ws.id, 1);
  await stopCloudTurn(ws, 1).catch(() => {});
  await clearCloudJobs(ws, 1).catch(() => {});

  // 1. Checkpoint dirty state on the box, then pull the branch (+ checkpoint) back.
  const chkRef = await checkpointDirty(host, ws.worktreePath, ws.id);
  const refs = [branchRef, ...(chkRef ? [chkRef] : [])];
  // The mirror is the canonical place to bundle from — fetch the box worktree's
  // tip into it first so the branch ref is current there.
  await host.exec('git', ['fetch', ws.worktreePath, `+${branchRef}:${branchRef}`, ...(chkRef ? [`+${chkRef}:${chkRef}`] : [])], { cwd: mirror }).catch(() => {});
  const localShas = (await localHost.exec('git', ['rev-parse', ws.branch], { cwd: project.repoPath })).stdout.trim();
  await bundleTransfer({
    srcHost: host,
    srcWt: mirror,
    dstHost: localHost,
    dstRepo: project.repoPath,
    refs,
    basisShas: localShas ? [localShas] : [],
  });

  // 2. Cut a fresh local worktree from the branch, restore the checkpoint.
  fs.mkdirSync(path.dirname(localWt), { recursive: true });
  await git.worktreeRemove(project.repoPath, localWt).catch(() => {});
  await git.worktreeAddExistingBranch(project.repoPath, localWt, ws.branch);
  await git.ensureContextDir(localWt);
  if (chkRef) await localHost.exec('git', ['stash', 'apply', CHECKPOINT(ws.id)], { cwd: localWt }).catch(() => {});

  // 3. Flip the workspace back home and clear the (box-bound) sessions.
  Workspaces.setCloudHost(ws.id, null);
  Workspaces.clearSessions(ws.id);
  setStatus(ws.id, { hostId: null, worktreePath: localWt, status: 'idle', setupError: null });

  // 4. Remove the box worktree + journal dir (the mirror stays for cheap re-upload).
  await host.exec('git', ['worktree', 'remove', '--force', ws.worktreePath], { cwd: mirror }).catch(() => {});
  await host.fs.rm(host.path.join(home, 'maestro', 'cloud', ws.id)).catch(() => {});
  const fresh = Workspaces.get(ws.id)!;
  watchWorkspace(fresh);
}

/** Local worktrees root for a project (mirrors services/workspaces). */
function maestroWorkspacesRoot(project: Project): string {
  return path.join(maestroHome(), 'workspaces', slugify(project.name));
}
