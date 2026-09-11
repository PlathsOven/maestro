/**
 * The heavier Maestro Web job executors (web-desktop-parity spec §9.4, Phase 2) —
 * PR lifecycle, workspace lifecycle, git refresh + diff snapshot, and status
 * regeneration. Split out of bridge.ts so the thin dispatcher stays a switch and
 * the executor can import the git / PR / status / workspace services (and
 * publish the results back to the relay). Each returns the relay `done` body.
 */
import { Projects, Workspaces } from '../db';
import { hostForWorkspace } from '../hosts';
import * as git from './git';
import * as shadow from './shadow';
import { createPr, mergePr, refreshPr } from './pr';
import { generateStatus, getStatus } from './status';
import { archiveWorkspace, restoreWorkspace, deleteWorkspace, continueOnNewBranch } from './workspaces';
import { sendChat } from './chat';
import { relayFetch, publishWorkspace } from './account';

type StatusScope = 'session' | 'workspace' | 'project';
type Done = { ok: boolean; result?: unknown; error?: string };

const republish = (wsId: string) => {
  const ws = Workspaces.get(wsId);
  if (ws) void publishWorkspace(ws).catch(() => {});
};

export async function execPrCreate(wsId: string): Promise<Done> {
  const r = await createPr(wsId, false);
  if (r.ok) {
    await refreshPr(wsId, true).catch(() => {});
    republish(wsId);
  }
  return { ok: r.ok, result: r.ok ? { url: r.url } : undefined, error: r.error };
}

export async function execPrMerge(wsId: string, method: 'merge' | 'squash' | 'rebase' = 'squash'): Promise<Done> {
  const r = await mergePr(wsId, method);
  if (r.ok) republish(wsId);
  return { ok: r.ok, result: r.ok ? { merged: true } : undefined, error: r.error };
}

export async function execContinueBranch(wsId: string): Promise<Done> {
  try {
    await continueOnNewBranch(wsId);
    republish(wsId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function execResolveConflicts(wsId: string): Promise<Done> {
  const ws = Workspaces.get(wsId);
  const project = ws ? Projects.get(ws.projectId) : null;
  const base = project?.baseBranch ?? 'the base branch';
  // Send the agent a concrete instruction to merge the base and resolve conflicts.
  const r = await sendChat({
    workspaceId: wsId,
    agentId: 1,
    text: `Merge ${base} into this branch and resolve any merge conflicts, then run the build/tests to confirm the result compiles.`,
    attachments: [],
    origin: 'web',
  });
  return { ok: r.ok, error: r.error };
}

export function execArchive(wsId: string): Done {
  archiveWorkspace(wsId);
  republish(wsId);
  return { ok: true };
}

export async function execRestore(wsId: string): Promise<Done> {
  try {
    await restoreWorkspace(wsId);
    republish(wsId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function execDelete(wsId: string): Promise<Done> {
  await deleteWorkspace(wsId);
  // Remove the relay rows (device-authed DELETE branch).
  await relayFetch(`/api/workspaces/${encodeURIComponent(wsId)}`, { method: 'DELETE' }).catch(() => {});
  return { ok: true };
}

/** git status + diffstat (+ full diff when withPatch), published to the relay so
 *  the web's Changes/Diff views render (§10.2/§10.4). */
export async function execGitRefresh(wsId: string, withPatch: boolean): Promise<Done> {
  const ws = Workspaces.get(wsId);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const project = Projects.get(ws.projectId);
  if (!project) return { ok: false, error: 'Project not found' };
  const folder = project.kind === 'folder' && !project.hostId;
  const host = hostForWorkspace(ws);
  try {
    const status = folder
      ? await shadow.shadowStatus(ws)
      : project.baseBranch == null
        ? { branch: '', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, changedFiles: 0, dirty: false }
        : await git.statusSummary(ws.worktreePath, project.baseBranch, host);
    const stat = folder
      ? await shadow.shadowDiffStat(ws)
      : project.baseBranch == null
        ? { additions: 0, deletions: 0 }
        : await git.diffStat(ws.worktreePath, project.baseBranch, host);
    await relayFetch(`/api/workspaces/${encodeURIComponent(wsId)}/git`, {
      method: 'PUT',
      body: JSON.stringify({
        git: status,
        diffAdd: stat.additions,
        diffDel: stat.deletions,
        changedFiles: status.changedFiles,
      }),
    });
    if (withPatch) {
      const diff = folder
        ? await shadow.shadowDiff(ws)
        : project.baseBranch == null
          ? { base: '', files: [] }
          : await git.workspaceDiff(ws.worktreePath, project.baseBranch, host);
      await relayFetch(`/api/workspaces/${encodeURIComponent(wsId)}/diff`, {
        method: 'PUT',
        body: JSON.stringify({ base: diff.base, files: diff.files, producedBy: 'desktop' }),
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function execStatusRegenerate(wsId: string, agentId: number, scope: StatusScope): Promise<Done> {
  const ws = Workspaces.get(wsId);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const req = { scope, workspaceId: wsId, agentId, projectId: ws.projectId };
  const r = await generateStatus(req);
  if (!r.ok) return { ok: false, error: r.error };
  const { report, stale } = getStatus(req);
  const digest = report
    ? {
        scope: report.scope,
        workingOn: report.working,
        lastActivity: report.lastActivity,
        goal: report.goal,
        nextUp: report.next,
        generatedAt: report.generatedAt,
        model: report.model,
        stale,
      }
    : null;
  await relayFetch(`/api/workspaces/${encodeURIComponent(wsId)}/git`, {
    method: 'PUT',
    body: JSON.stringify({ statusDigest: digest }),
  }).catch(() => {});
  return { ok: true };
}
