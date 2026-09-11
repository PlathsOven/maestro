import { broadcast, getWindow } from '../bus';
import { Projects, Workspaces } from '../db';
import { hostForProject, hostForWorkspace } from '../hosts';
import * as git from './git';
import * as gh from './github';
import { generateOneShot } from './llm';
import type { Project, Workspace } from '../../shared/types';

function friendlyPushError(raw: string): string {
  if (/could not read Username|Authentication failed|HTTP 403|Invalid username or (password|token)/i.test(raw)) {
    return 'git push was rejected: GitHub authentication is missing. Click "Sign in with GitHub" (sidebar badge or Settings → Integrations), then try again.';
  }
  if (/Permission denied \(publickey\)|Could not resolve hostname.*ssh/i.test(raw)) {
    return 'git push failed: origin uses SSH but no SSH key is set up. Switch origin to HTTPS (git remote set-url origin https://github.com/…) so the in-app GitHub sign-in can authenticate pushes.';
  }
  return `git push failed: ${raw}`;
}

/**
 * Create a PR for a workspace in one click: commit any uncommitted work first
 * (so the user never has to commit separately), push the branch, let Claude
 * draft the title/body from the branch's changes, then `gh pr create`.
 */
export async function createPr(
  workspaceId: string,
  draft: boolean
): Promise<{ ok: boolean; url?: string; error?: string; note?: string }> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const project = Projects.get(ws.projectId);
  if (!project) return { ok: false, error: 'Project not found' };
  if (project.baseBranch == null) return { ok: false, error: 'Not a git repository' };
  const host = hostForProject(project);

  // gh auth is per-host: local uses the app's gh login; remote uses `gh` on the
  // server (the user runs `gh auth login` there).
  if (!(await gh.ghAuthedOn(host))) {
    return {
      ok: false,
      error: host.id === 'local'
        ? 'GitHub isn’t connected. Click "Sign in with GitHub" (sidebar badge or Settings → Integrations) — no terminal needed.'
        : 'GitHub isn’t connected on the remote host. Run `gh auth login` there once, then try again.',
    };
  }

  let status = await git.statusSummary(ws.worktreePath, project.baseBranch, host);

  // One-click PR: stage and commit everything that's uncommitted so opening a PR
  // never requires a separate commit step. The commit subject reuses the
  // (agent-drafted) task title; the PR body is drafted from the diff below.
  if (status.dirty) {
    const message = (ws.title?.trim() || ws.name || ws.branch || 'Update').slice(0, 72);
    const committed = await git.commitAll(ws.worktreePath, message, host);
    // "nothing to commit" is fine when commits already exist (e.g. only the
    // git-ignored .context/ changed, which commitAll deliberately excludes).
    if (!committed.ok && !/nothing to commit/i.test(committed.error ?? '')) {
      return { ok: false, error: `Could not commit changes: ${committed.error ?? 'git commit failed'}` };
    }
    status = await git.statusSummary(ws.worktreePath, project.baseBranch, host);
  }

  if (status.ahead === 0) {
    return { ok: false, error: 'No changes to open a PR for.' };
  }

  // ws.branch lets pushCurrent recover a detached HEAD (an agent that ran
  // `git checkout <sha>`) instead of failing at the last step of one-click PR.
  const push = await git.pushCurrent(ws.worktreePath, host, ws.branch);
  if (!push.ok) return { ok: false, error: friendlyPushError(push.error ?? '') };
  const note = push.reattached
    ? `This workspace had a detached HEAD; its commits are now on "${push.reattached}".`
    : undefined;

  // Agent-drafted PR description, with a deterministic fallback.
  const log = await git.shortLog(ws.worktreePath, project.baseBranch, host);
  let title = '';
  let body = '';
  const drafted = await generateOneShot(
    ws.worktreePath,
    `Draft a pull request title and description for the current branch.\n` +
      `Commits on this branch:\n${log}\n\n` +
      `Look at the actual changes with: git diff ${project.baseBranch}...HEAD\n\n` +
      `Reply in EXACTLY this format (no markdown fences):\nTITLE: <one line, max 70 chars>\n\n<PR body in markdown: summary bullets, then a short test plan>`
  );
  if (drafted) {
    const m = drafted.match(/TITLE:\s*(.+)\n+([\s\S]*)/);
    if (m) {
      title = m[1].trim();
      body = m[2].trim();
    }
  }
  if (!title) {
    title = log.split('\n')[0]?.replace(/^\w+\s/, '') || ws.branch;
    body = `## Changes\n\n${log
      .split('\n')
      .map((l) => `- ${l.replace(/^\w+\s/, '')}`)
      .join('\n')}`;
  }
  body += `\n\n---\n_Opened with Maestro from workspace \`${ws.name}\`._`;

  const base = project.baseBranch.replace(/^origin\//, '');
  const res = await gh.prCreate(ws.worktreePath, { title, body, base, draft }, host);
  if (!res.ok) return res;

  // Only number/url/state are used here, and a brand-new PR's mergeability is
  // always still computing — don't make the Create-PR spinner wait it out.
  const pr = await gh.prStatus(ws.worktreePath, true, host, false);
  if (pr) {
    ws.prNumber = pr.number;
    ws.prUrl = pr.url;
    ws.prState = pr.state;
    if (ws.status === 'idle') ws.status = 'reviewing';
    Workspaces.update(ws);
    broadcast('ws:updated', ws);
  }
  return { ok: true, url: res.url ?? pr?.url, note };
}

export async function mergePr(
  workspaceId: string,
  method: 'merge' | 'squash' | 'rebase'
): Promise<{ ok: boolean; error?: string }> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const res = await gh.prMerge(ws.worktreePath, method, hostForWorkspace(ws));
  if (res.ok) {
    const fresh = Workspaces.get(workspaceId)!;
    fresh.status = 'idle';
    fresh.prState = 'MERGED';
    Workspaces.update(fresh);
    broadcast('ws:updated', fresh);
  }
  return res;
}

/** Sync cached PR info; also picks up PRs the agent opened itself via gh. */
export async function refreshPr(workspaceId: string, force = false) {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return null;
  const pr = await gh.prStatus(ws.worktreePath, force, hostForWorkspace(ws));
  const fresh = Workspaces.get(workspaceId);
  if (!fresh) return pr;
  const changed = pr
    ? fresh.prNumber !== pr.number || fresh.prUrl !== pr.url || fresh.prState !== pr.state
    : fresh.prNumber !== null || fresh.prState !== null;
  if (pr) {
    fresh.prNumber = pr.number;
    fresh.prUrl = pr.url;
    fresh.prState = pr.state;
    if (pr.state === 'OPEN' && fresh.status === 'idle') fresh.status = 'reviewing';
    if (pr.state !== 'OPEN' && fresh.status === 'reviewing') fresh.status = 'idle';
  } else {
    fresh.prNumber = null;
    fresh.prUrl = null;
    fresh.prState = null;
    if (fresh.status === 'reviewing') fresh.status = 'idle';
  }
  if (changed) {
    Workspaces.update(fresh);
    broadcast('ws:updated', fresh);
  }
  // Always push the full status: number/state can be unchanged while what the
  // buttons key off (mergeable, checks, review decision) moved.
  broadcast('pr:status', { workspaceId, pr });
  return pr;
}

// ---------- background PR poll ----------
//
// Agents merge, close, and resolve PRs from inside their runs (gh pr merge,
// git push) — none of which touches the files the worktree watcher sees, so
// the header action (Merge / Resolve conflicts) used to sit stale until the
// user happened to switch workspaces or open the Checks tab. Turn ends now
// refresh eagerly (chat.ts); this poll bounds the wait for mid-turn and
// out-of-band changes (terminal, GitHub web). One cheap probe per open-PR
// workspace per tick; the full refresh only runs on drift.

const POLL_MS = 45_000;
const UNFOCUSED_EVERY = 4; // ≈3 min while the window is in the background
const polling = new Set<string>();

export function startPrPolling() {
  let tick = 0;
  setInterval(() => {
    tick++;
    if (!(getWindow()?.isFocused() ?? false) && tick % UNFOCUSED_EVERY !== 0) return;
    for (const ws of Workspaces.list()) {
      if (ws.archived || ws.prNumber == null || ws.prState !== 'OPEN' || polling.has(ws.id)) continue;
      const project = Projects.get(ws.projectId);
      if (!project || project.kind === 'folder' || project.baseBranch == null) continue;
      polling.add(ws.id);
      void pollOne(ws, project)
        .catch(() => {})
        .finally(() => polling.delete(ws.id));
    }
  }, POLL_MS);
}

async function pollOne(ws: Workspace, project: Project) {
  const probe = await gh.prProbe(ws.worktreePath, hostForProject(project));
  if (!probe.ok) return; // gh couldn't answer — no news, never a state change
  // Identity drifts against the DB; mergeable drifts against the last fully
  // fetched status (what the UI saw). Only definite mergeable answers count —
  // UNKNOWN means GitHub is still computing, and acting on it would thrash.
  const definite = (m: string | null | undefined) => (m === 'MERGEABLE' || m === 'CONFLICTING' ? m : null);
  const mergeable = definite(probe.pr?.mergeable);
  const seen = definite(gh.cachedPrStatus(ws.worktreePath)?.mergeable);
  const drift =
    probe.pr == null ||
    probe.pr.number !== ws.prNumber ||
    probe.pr.state !== ws.prState ||
    (mergeable != null && seen != null && mergeable !== seen);
  if (drift) await refreshPr(ws.id, true);
}
