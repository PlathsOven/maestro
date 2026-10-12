import { hostForWorkspace } from '../hosts';
import * as git from './git';
import * as shadow from './shadow';
import type { GitStatusSummary, Project, Workspace, WorkspaceDiff } from '../../shared/types';

/**
 * A workspace's changes, as the Changes/Diff views show them. Local folder
 * projects diff against their shadow-git checkpoint (§7 Phase 5); everything
 * else diffs against the project's base branch, or reports nothing without one.
 */

function usesShadow(project: Project): boolean {
  return project.kind === 'folder' && !project.hostId;
}

export function workspaceStatus(ws: Workspace, project: Project): Promise<GitStatusSummary> {
  if (usesShadow(project)) return shadow.shadowStatus(ws);
  if (project.baseBranch == null) {
    return Promise.resolve({ branch: '', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, changedFiles: 0, dirty: false });
  }
  return git.statusSummary(ws.worktreePath, project.baseBranch, hostForWorkspace(ws));
}

export function workspaceDiffStat(ws: Workspace, project: Project): Promise<{ additions: number; deletions: number }> {
  if (usesShadow(project)) return shadow.shadowDiffStat(ws);
  if (project.baseBranch == null) return Promise.resolve({ additions: 0, deletions: 0 });
  return git.diffStat(ws.worktreePath, project.baseBranch, hostForWorkspace(ws));
}

export function workspaceDiff(ws: Workspace, project: Project): Promise<WorkspaceDiff> {
  if (usesShadow(project)) return shadow.shadowDiff(ws);
  if (project.baseBranch == null) return Promise.resolve({ base: '', files: [] });
  return git.workspaceDiff(ws.worktreePath, project.baseBranch, hostForWorkspace(ws));
}
