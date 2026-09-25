import { broadcast } from '../bus';
import { Projects, Workspaces } from '../db';
import { hostForProject, hostForWorkspace } from '../hosts';
import { backgroundFactor } from './activity';
import * as git from './git';
import * as gh from './github';
import { generateText } from './llm';
import type { ExecHost } from '../hosts/types';
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

  // The draft only needs the commits, not the push — run the two side by side.
  // ws.branch lets pushCurrent recover a detached HEAD (an agent that ran
  // `git checkout <sha>`) instead of failing at the last step of one-click PR.
  const [push, { title, body }] = await Promise.all([
    git.pushCurrent(ws.worktreePath, host, ws.branch),
    draftPr(ws, project.baseBranch, host),
  ]);
  if (!push.ok) return { ok: false, error: friendlyPushError(push.error ?? '') };
  const note = push.reattached
    ? `This workspace had a detached HEAD; its commits are now on "${push.reattached}".`
    : undefined;

  const base = project.baseBranch.replace(/^origin\//, '');
  const res = await gh.prCreate(ws.worktreePath, { title, body, base, draft }, host);
  if (!res.ok) return res;

  // Only number/url/state are used here, and a brand-new PR's mergeability is
  // always still computing — don't make the Create-PR spinner wait it out.
  // Push the status too, so the header flips to the open PR with no refetch.
  const pr = await gh.prStatus(ws.worktreePath, true, host, false);
  if (pr) {
    ws.prNumber = pr.number;
    ws.prUrl = pr.url;
    ws.prState = pr.state;
    if (ws.status === 'idle') ws.status = 'reviewing';
    Workspaces.update(ws);
    broadcast('ws:updated', ws);
    broadcast('pr:status', { workspaceId, pr });
  }
  return { ok: true, url: res.url ?? pr?.url, note };
}

/** Agent-drafted PR title/body from the branch's commits and (inlined) diff,
 *  with a deterministic fallback. */
async function draftPr(ws: Workspace, baseRef: string, host: ExecHost): Promise<{ title: string; body: string }> {
  const [log, diff] = await Promise.all([
    git.shortLog(ws.worktreePath, baseRef, host),
    git.diffForPrompt(ws.worktreePath, baseRef, host),
  ]);
  let title = '';
  let body = '';
  const drafted = await generateText({
    cwd: ws.worktreePath,
    prompt:
      `Draft a pull request title and description for the current branch. ` +
      `Everything you need is below — do not run any tools.\n\n` +
      `Commits on this branch:\n${log}\n\n` +
      `Changes (git diff vs ${baseRef}):\n${diff}\n\n` +
      `Reply in EXACTLY this format (no markdown fences):\nTITLE: <one line, max 70 chars>\n\n<PR body in markdown: summary bullets, then a short test plan>`,
    tier: 'status',
    timeoutMs: 90_000,
    host,
    harness: host.id !== 'local' ? (ws.harness === 'codex' ? 'codex' : ws.harness === 'grok' ? 'grok' : 'claude-code') : undefined,
    // The user is watching a spinner — don't queue behind background digests.
    urgent: true,
  });
  const m = drafted.text?.match(/TITLE:\s*(.+)\n+([\s\S]*)/);
  if (m) {
    title = m[1].trim();
    body = m[2].trim();
  }
  if (!title) {
    title = log.split('\n')[0]?.replace(/^\w+\s/, '') || ws.branch;
    body = `## Changes\n\n${log
      .split('\n')
      .map((l) => `- ${l.replace(/^\w+\s/, '')}`)
      .join('\n')}`;
  }
  body += `\n\n---\n_Opened with Maestro from workspace \`${ws.name}\`._`;
  return { title, body };
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
  // `prStatus` returns null both when gh confirms there's no PR (it caches a
  // null) and when gh simply couldn't answer with nothing cached to fall back
  // on (offline / rate-limited). Only the former should clear a workspace's PR
  // — otherwise a transient blip makes a real PR flicker away on the desktop
  // and on Maestro Web. A transient failure with nothing cached: leave as-is.
  if (!pr && gh.cachedPrStatus(ws.worktreePath) !== null) return pr;
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
const POLL_FAST_MS = 12_000; // while a PR is mid-flight (checks running / mergeability computing)
const polling = new Set<string>();

/** Open-PR workspaces the poll should look at (skips folders / non-git). */
function pollableWorkspaces(): { ws: Workspace; project: Project }[] {
  const out: { ws: Workspace; project: Project }[] = [];
  for (const ws of Workspaces.list()) {
    if (ws.archived || ws.prNumber == null || ws.prState !== 'OPEN') continue;
    const project = Projects.get(ws.projectId);
    if (!project || project.kind === 'folder' || project.baseBranch == null) continue;
    out.push({ ws, project });
  }
  return out;
}

/**
 * A PR is "mid-flight" when checks are still running, GitHub is still computing
 * mergeability, or we have no full status cached yet — exactly the moments the
 * user is watching for it to settle. Poll those faster so the header action and
 * Maestro Web catch up in ~seconds, then relax back to the slow cadence once
 * everything is settled (keeping steady-state gh traffic low).
 */
function anyPrInFlight(rows: { ws: Workspace }[]): boolean {
  return rows.some(({ ws }) => {
    const pr = gh.cachedPrStatus(ws.worktreePath);
    if (!pr) return true; // no baseline yet — poll soon to establish one
    if (pr.mergeable !== 'MERGEABLE' && pr.mergeable !== 'CONFLICTING') return true;
    return pr.checks.some((c) => c.state === 'pending');
  });
}

export function startPrPolling() {
  // A self-scheduling loop (not a fixed setInterval) so the delay can adapt to
  // whether anything is mid-flight and whether the window is focused
  // (`backgroundFactor`, shared with the other pollers — perf-cpu-ram §4.6).
  const loop = () => {
    const rows = pollableWorkspaces();
    for (const { ws, project } of rows) {
      if (polling.has(ws.id)) continue;
      polling.add(ws.id);
      void pollOne(ws, project)
        .catch(() => {})
        .finally(() => polling.delete(ws.id));
    }
    const base = anyPrInFlight(rows) ? POLL_FAST_MS : POLL_MS;
    setTimeout(loop, base * backgroundFactor());
  };
  // First tick soon (not a full slow interval) so a freshly-launched desktop
  // seeds PR status to the header and Maestro Web quickly, then self-paces.
  setTimeout(loop, POLL_FAST_MS);
}

async function pollOne(ws: Workspace, project: Project) {
  const probe = await gh.prProbe(ws.worktreePath, hostForProject(project));
  if (!probe.ok) return; // gh couldn't answer — no news, never a state change
  // Identity drifts against the DB; mergeable/checks/review drift against the
  // last fully fetched status (what the UI and the relay last saw). Only
  // definite mergeable answers count — UNKNOWN means GitHub is still computing,
  // and acting on it would thrash.
  const definite = (m: string | null | undefined) => (m === 'MERGEABLE' || m === 'CONFLICTING' ? m : null);
  const mergeable = definite(probe.pr?.mergeable);
  const cached = gh.cachedPrStatus(ws.worktreePath);
  const seen = definite(cached?.mergeable);
  const drift =
    cached == null || // no baseline yet — establish one (also seeds Maestro Web)
    probe.pr == null ||
    probe.pr.number !== ws.prNumber ||
    probe.pr.state !== ws.prState ||
    (mergeable != null && seen != null && mergeable !== seen) ||
    gh.prSignals(probe.pr) !== gh.prSignals(cached);
  if (drift) await refreshPr(ws.id, true);
}
