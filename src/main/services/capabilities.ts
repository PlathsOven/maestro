import { hostForProject } from '../hosts';
import { localHost } from '../hosts/local';
import { ghAuthedOn } from './github';
import type { ExecHost } from '../hosts/types';
import type { Project, ProjectCaps } from '../../shared/types';

// The capability ladder, derived (never stored): a project sits on
//   folder → git → git+github
// and every git/GitHub surface in the renderer gates on the rung it actually
// reached. Tier is recomputed on demand (a folder can gain `.git`, a repo can
// gain an origin, `gh` auth can appear or vanish) — see spec §5.

const ownerCache = new Map<string, string | null>(); // key `${host.id}:${repoPath}`

/** GitHub owner of a repo's origin (run on the project's host) — powers the repo
 *  avatar in the sidebar and the `githubRemote` capability. Cached per
 *  host+repoPath; null when there's no origin or the origin isn't github.com. */
export async function githubOwner(repoPath: string, host: ExecHost = localHost): Promise<string | null> {
  const key = `${host.id}:${repoPath}`;
  if (ownerCache.has(key)) return ownerCache.get(key)!;
  const r = await host.exec('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, timeout: 8_000 });
  const m = r.ok ? r.stdout.match(/github\.com[:/]([^/]+)\//) : null;
  const owner = m ? m[1] : null;
  ownerCache.set(key, owner);
  return owner;
}

/**
 * Derive a project's capability rung.
 *
 * v1: git-ness follows the project kind — git projects are worktree-based
 * (tier B+), folder projects are in-place (tier A). `worktrees` is additionally
 * false for remote projects (they're always in-place in v1 — spec §6.6).
 * `githubRemote` is derived at runtime on the project's host: for local projects
 * it just requires a github origin (the renderer adds the local gh-auth check);
 * for remote projects it additionally requires gh authenticated ON the host
 * (`gh auth login` there), since the renderer can't probe per-host auth.
 */
export async function computeCaps(project: Project): Promise<ProjectCaps> {
  const git = project.kind === 'git';
  const remote = !!project.hostId;
  const worktrees = git && !remote; // remote projects are in-place in v1
  const host = hostForProject(project);
  const originIsGithub = git && (await githubOwner(project.repoPath, host)) !== null;
  const githubRemote = originIsGithub && (remote ? await ghAuthedOn(host) : true);
  // Shadow-git checkpoints back the Diff/undo story for local folder projects.
  const checkpoints = project.kind === 'folder' && !remote;
  return { git, worktrees, githubRemote, checkpoints };
}
