import fs from 'fs';
import path from 'path';
import { run, runOrThrow } from '../exec';
import { localHost } from '../hosts/local';
import type { ExecHost, ExecOpts } from '../hosts/types';
import { parseUnifiedDiff } from '../../shared/diffparse';
import type {
  BranchInfo,
  DiffFile,
  DiffScope,
  GitStatusSummary,
  WorkspaceDiff,
} from '../../shared/types';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.context', 'dist', 'build', '.next', 'target', '.venv', 'venv']);

// Git read/inspect/commit operations flow through an ExecHost so they run on the
// project's host (this machine or a remote server over SSH). Worktree creation
// stays local in v1 — remote projects are in-place (spec §6.6). Callers that
// omit the host get LocalHost, so existing local behavior is unchanged.
async function gexecThrow(host: ExecHost, cmd: string, args: string[], opts?: ExecOpts): Promise<string> {
  const r = await host.exec(cmd, args, opts);
  if (!r.ok) throw new Error(r.stderr.trim() || r.stdout.trim() || `${cmd} ${args.join(' ')} failed`);
  return r.stdout;
}

export async function isGitRepo(dir: string, host: ExecHost = localHost): Promise<boolean> {
  const r = await host.exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  return r.ok && r.stdout.trim() === 'true';
}

export async function repoRoot(dir: string, host: ExecHost = localHost): Promise<string> {
  return (await gexecThrow(host, 'git', ['rev-parse', '--show-toplevel'], { cwd: dir })).trim();
}

async function hasRemote(repoPath: string, host: ExecHost = localHost): Promise<boolean> {
  return (await host.exec('git', ['remote', 'get-url', 'origin'], { cwd: repoPath })).ok;
}

/** origin's fetch URL, or null when there's no origin. */
export async function originUrl(repoPath: string, host: ExecHost = localHost): Promise<string | null> {
  const r = await host.exec('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, timeout: 8_000 });
  return r.ok ? r.stdout.trim() || null : null;
}

/** Best-guess base branch, prefixed with origin/ when a remote exists. */
export async function detectBaseBranch(repoPath: string, host: ExecHost = localHost): Promise<string> {
  const head = await host.exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath });
  if (head.ok) return head.stdout.trim(); // "origin/main"
  for (const cand of ['origin/main', 'origin/master']) {
    if ((await host.exec('git', ['show-ref', '--verify', `refs/remotes/${cand}`], { cwd: repoPath })).ok) return cand;
  }
  const cur = await host.exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath });
  if (cur.ok && cur.stdout.trim()) return cur.stdout.trim();
  for (const cand of ['main', 'master']) {
    if ((await host.exec('git', ['show-ref', '--verify', `refs/heads/${cand}`], { cwd: repoPath })).ok) return cand;
  }
  return 'main';
}

export async function fetchOrigin(repoPath: string, host: ExecHost = localHost): Promise<void> {
  if (await hasRemote(repoPath, host)) {
    await host.exec('git', ['fetch', 'origin', '--prune'], { cwd: repoPath, timeout: 45_000 });
  }
}

export async function worktreeAddNewBranch(repoPath: string, wtPath: string, branch: string, baseRef: string, host: ExecHost = localHost) {
  await host.fs.mkdirp(host.path.dirname(wtPath));
  await gexecThrow(host, 'git', ['worktree', 'add', wtPath, '-b', branch, baseRef], { cwd: repoPath, timeout: 120_000 });
}

/** Check out an existing branch into a new worktree. Throws BranchInUseError on conflict. */
export async function worktreeAddExistingBranch(repoPath: string, wtPath: string, branch: string, host: ExecHost = localHost) {
  await host.fs.mkdirp(host.path.dirname(wtPath));
  const r = await host.exec('git', ['worktree', 'add', wtPath, branch], { cwd: repoPath, timeout: 120_000 });
  if (!r.ok) {
    if (/already (checked out|used by worktree)/i.test(r.stderr)) {
      const err = new Error(r.stderr.trim());
      (err as any).branchInUse = true;
      throw err;
    }
    throw new Error(r.stderr.trim() || 'git worktree add failed');
  }
}

export async function worktreeRemove(repoPath: string, wtPath: string, host: ExecHost = localHost) {
  await host.exec('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoPath, timeout: 60_000 });
  await host.exec('git', ['worktree', 'prune'], { cwd: repoPath });
}

export async function currentBranch(wtPath: string, host: ExecHost = localHost): Promise<string> {
  const r = await host.exec('git', ['branch', '--show-current'], { cwd: wtPath });
  return r.stdout.trim() || 'HEAD';
}

/** A repo's identity for direct workspaces: the root commit of HEAD's history
 *  (stable across branch switches, pulls and gc), or '' with no commits yet. */
export async function repoIdentity(repoPath: string, host: ExecHost = localHost): Promise<string> {
  const r = await host.exec('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repoPath });
  return r.ok ? (r.stdout.trim().split('\n')[0] ?? '') : '';
}

/**
 * Why `dir` is no longer the repo a direct workspace was created on, or null when
 * it still is: the directory must exist, be the toplevel of a git repo (not a
 * folder inside some other repo after its .git went away), and — when an identity
 * was captured — still contain that root commit. Object presence, not "HEAD's
 * root", so switching to an orphan branch or rewriting recent history is fine. A
 * shallow clone may lack the commit legitimately, so it isn't held against one.
 * Never initializes or repairs anything.
 */
export async function directRepoProblem(dir: string, identity: string, host: ExecHost = localHost): Promise<string | null> {
  if (!(await host.fs.exists(dir).catch(() => false))) {
    return `${dir} is missing — it may have been moved or deleted.`;
  }
  const top = await host.exec('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (!top.ok) return `${dir} is no longer a git repository.`;
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  if (real(top.stdout.trim()) !== real(dir)) {
    return `${dir} is no longer the root of its own git repository (it now sits inside ${top.stdout.trim()}).`;
  }
  if (identity) {
    const has = await host.exec('git', ['cat-file', '-e', `${identity}^{commit}`], { cwd: dir });
    if (!has.ok) {
      const shallow = await host.exec('git', ['rev-parse', '--is-shallow-repository'], { cwd: dir });
      if (shallow.stdout.trim() !== 'true') {
        return `${dir} now holds a different git repository than the one this workspace was created from.`;
      }
    }
  }
  return null;
}

export async function renameBranch(wtPath: string, newName: string, host: ExecHost = localHost) {
  await gexecThrow(host, 'git', ['branch', '-m', newName], { cwd: wtPath });
}

export interface CheckoutResult {
  ok: boolean;
  conflict?: string;
}

export async function checkout(wtPath: string, branch: string, create: boolean, host: ExecHost = localHost): Promise<CheckoutResult> {
  const args = create ? ['checkout', '-b', branch] : ['checkout', branch];
  const r = await host.exec('git', args, { cwd: wtPath });
  if (r.ok) return { ok: true };
  if (/already (checked out|used by worktree)/i.test(r.stderr)) {
    return { ok: false, conflict: r.stderr.trim() };
  }
  throw new Error(r.stderr.trim() || 'git checkout failed');
}

/**
 * Create and switch to a new branch from an explicit start point (e.g.
 * origin/main), tolerating the origin/ prefix on remoteless repos.
 */
export async function checkoutNewBranch(
  wtPath: string,
  branch: string,
  startPoint: string,
  host: ExecHost = localHost
): Promise<CheckoutResult> {
  let lastErr = '';
  for (const sp of [startPoint, startPoint.replace(/^origin\//, '')]) {
    const r = await host.exec('git', ['checkout', '-b', branch, sp], { cwd: wtPath });
    if (r.ok) return { ok: true };
    if (/already (checked out|used by worktree)/i.test(r.stderr)) {
      return { ok: false, conflict: r.stderr.trim() };
    }
    lastErr = r.stderr.trim();
    // Only fall through to the next start-point variant when this one didn't resolve.
    if (!/(unknown revision|not a valid|ambiguous argument|did not match|invalid reference)/i.test(lastErr)) {
      break;
    }
  }
  throw new Error(lastErr || 'git checkout -b failed');
}

/** The commit a ref points at, or null when it doesn't resolve. */
export async function revParse(wtPath: string, ref: string, host: ExecHost = localHost): Promise<string | null> {
  const r = await host.exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: wtPath });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Resolve a base branch that may or may not carry the origin/ prefix (remoteless repos). */
export async function resolveBaseRef(wtPath: string, baseRef: string, host: ExecHost = localHost): Promise<string | null> {
  for (const ref of [baseRef, baseRef.replace(/^origin\//, '')]) {
    const sha = await revParse(wtPath, ref, host);
    if (sha) return sha;
  }
  return null;
}

export async function isAncestor(wtPath: string, ancestor: string, descendant: string, host: ExecHost = localHost): Promise<boolean> {
  return (await host.exec('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: wtPath })).ok;
}

/** Commits reachable from `tip` but from none of `excludes`, oldest first.
 *  Merges are left out: a linear replay wants the commits, not the joins. */
export async function commitsNotIn(
  wtPath: string,
  tip: string,
  excludes: string[],
  host: ExecHost = localHost
): Promise<string[]> {
  const r = await host.exec('git', ['rev-list', '--reverse', '--no-merges', tip, '--not', ...excludes], { cwd: wtPath });
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Replay `commits` (oldest first) onto HEAD. Any failure rolls the whole range
 * back with `cherry-pick --abort`, so the caller is left on a clean branch
 * rather than mid-conflict — the commits are still on the branch they came from,
 * which is the caller's fallback story.
 */
export async function cherryPick(
  wtPath: string,
  commits: string[],
  host: ExecHost = localHost
): Promise<{ ok: boolean; error?: string }> {
  if (!commits.length) return { ok: true };
  // --keep-redundant-commits: a commit whose changes the base already has turns
  // empty, which would otherwise stop the replay dead.
  const r = await host.exec('git', ['cherry-pick', '--keep-redundant-commits', ...commits], {
    cwd: wtPath,
    timeout: 120_000,
  });
  if (r.ok) return { ok: true };
  await host.exec('git', ['cherry-pick', '--abort'], { cwd: wtPath });
  return { ok: false, error: (r.stderr + r.stdout).trim() };
}

/**
 * The head commit of a PR as GitHub still serves it. `pull/<n>/head` outlives
 * the branch itself, which GitHub deletes on merge (and our pruning fetch then
 * drops locally), so it's the one durable record of what got merged. null when
 * it can't be fetched — offline, no remote, PR gone.
 */
export async function prHeadSha(repoPath: string, prNumber: number, host: ExecHost = localHost): Promise<string | null> {
  const r = await host.exec('git', ['fetch', 'origin', `pull/${prNumber}/head`], { cwd: repoPath, timeout: 60_000 });
  if (!r.ok) return null;
  const sha = await host.exec('git', ['rev-parse', 'FETCH_HEAD'], { cwd: repoPath });
  return sha.ok ? sha.stdout.trim() || null : null;
}

/**
 * What became of the work parked by `withStash`:
 * - `none`      — the tree was clean, nothing was stashed.
 * - `restored`  — the work is back in the worktree.
 * - `conflicted`— the work is back with conflict markers; the entry is kept too.
 * - `stranded`  — the pop refused outright, so the work is ONLY in the stash.
 *   The worktree looks clean, which reads as "my changes vanished" — callers must
 *   say where the work went.
 */
export type StashRestore = 'none' | 'restored' | 'conflicted' | 'stranded';

/**
 * Run `fn` with the worktree's uncommitted work parked in a stash, then put it
 * back. Checkout refuses to clobber local edits, so a branch switch under a
 * dirty tree only lands if the work steps aside first — and the work belongs on
 * whichever branch we end up on, whether `fn` resolved or threw.
 *
 * refs/stash is shared by all of a repo's worktrees, so restore the entry we
 * pushed rather than stash@{0}, which a sibling worktree may have taken since.
 */
export async function withStash<T>(
  wtPath: string,
  fn: () => Promise<T>,
  host: ExecHost = localHost
): Promise<{ value: T; restore: StashRestore; stashRef?: string }> {
  const stashTop = async () =>
    (await host.exec('git', ['rev-parse', '-q', '--verify', 'refs/stash'], { cwd: wtPath })).stdout.trim();

  const before = await stashTop();
  // .context is Maestro's own scratch dir — leave the agent's notes alone (cf. commitAll).
  await host.exec('git', ['stash', 'push', '-u', '-m', 'maestro: branch switch', '--', '.', ':!.context'], {
    cwd: wtPath,
  });
  const mine = await stashTop();
  if (!mine || mine === before) return { value: await fn(), restore: 'none' }; // tree was clean

  const restore = async (): Promise<{ restore: StashRestore; stashRef?: string }> => {
    const entry = (await host.exec('git', ['stash', 'list', '--format=%H %gd'], { cwd: wtPath })).stdout
      .split('\n')
      .find((l) => l.startsWith(mine))
      ?.split(' ')[1];
    if (!entry) return { restore: 'stranded' };
    const pop = await host.exec('git', ['stash', 'pop', entry], { cwd: wtPath });
    if (pop.ok) return { restore: 'restored' };
    // A failed pop means one of two very different things. Either git merged the
    // work in and left conflict markers (unmerged index entries — the work is in
    // the tree), or it refused to start at all: an agent that kept writing while
    // the tree was parked re-creates the very files the pop wants to lay down
    // ("would be overwritten by merge" / "already exists, no checkout"), and then
    // nothing is applied and the work stays in the stash.
    const st = await host.exec('git', ['status', '--porcelain'], { cwd: wtPath });
    const unmerged = st.stdout.split('\n').some((l) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(l));
    return { restore: unmerged ? 'conflicted' : 'stranded', stashRef: entry };
  };

  let value: T;
  try {
    value = await fn();
  } catch (e) {
    await restore();
    throw e;
  }
  return { value, ...(await restore()) };
}

export async function fetchPrHead(repoPath: string, prNumber: number, localBranch: string, host: ExecHost = localHost) {
  await gexecThrow(host, 'git', ['fetch', 'origin', `pull/${prNumber}/head:${localBranch}`], {
    cwd: repoPath,
    timeout: 120_000,
  });
}

export async function listBranches(repoPath: string, host: ExecHost = localHost): Promise<BranchInfo[]> {
  const r = await host.exec('git', ['branch', '-a', '--format=%(refname:short)%09%(HEAD)'], { cwd: repoPath });
  const out: BranchInfo[] = [];
  const seen = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const [name, head] = line.split('\t');
    if (!name || name.endsWith('/HEAD')) continue;
    const isRemote = name.startsWith('origin/');
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, isRemote, current: head === '*' });
  }
  return out;
}

export async function lsFiles(wtPath: string, host: ExecHost = localHost): Promise<string[]> {
  const r = await host.exec('git', ['ls-files'], { cwd: wtPath, timeout: 20_000 });
  return r.stdout.split('\n').filter(Boolean).slice(0, 8000);
}

/**
 * Bounded on-disk file list for a non-git folder — the @-mention source when
 * `git ls-files` isn't available (folder projects). Mirrors lsFiles' 8000 cap
 * and skips the same noisy dirs (node_modules, .git, .context, dist, …).
 * Returns POSIX-relative paths.
 */
export async function walkFiles(root: string, host: ExecHost = localHost, limit = 8000): Promise<string[]> {
  const out: string[] = [];
  const p = host.path;
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (out.length >= limit) return;
    let entries: { name: string; dir: boolean }[];
    try {
      entries = await host.fs.readdir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (IGNORED_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.dir) await walk(p.join(dir, e.name), childRel);
      else out.push(childRel);
    }
  };
  await walk(root, '');
  return out.slice(0, limit);
}

/** Resolve the merge base between HEAD and the project base branch. */
async function resolveMergeBase(wtPath: string, baseRef: string, host: ExecHost = localHost): Promise<string | null> {
  for (const ref of [baseRef, baseRef.replace(/^origin\//, '')]) {
    const mb = await host.exec('git', ['merge-base', 'HEAD', ref], { cwd: wtPath });
    if (mb.ok && mb.stdout.trim()) return mb.stdout.trim();
  }
  return null;
}

/**
 * Parse the conflicted-file section of `git merge-tree --write-tree --name-only`
 * output. The first line is the written-tree OID; the conflicted paths follow,
 * one per line, until a blank line (informational messages come after that).
 * Deduped, since a path can appear more than once. Exported for unit tests.
 */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const lines = stdout.split('\n');
  const files: string[] = [];
  // Skip line 0 (the tree OID); collect paths until the blank separator.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim() === '') break;
    files.push(line);
  }
  return [...new Set(files)];
}

/**
 * Files that would conflict if baseRef were merged into HEAD right now.
 * Read-only (`git merge-tree --write-tree`, git ≥ 2.38); fetches origin
 * first so the answer matches what GitHub sees. Returns null when this
 * host's git can't answer (old git, weird repo) — callers treat that as
 * "unknown", not "no conflicts".
 */
export async function conflictPreflight(
  wtPath: string,
  baseRef: string,
  host: ExecHost = localHost
): Promise<string[] | null> {
  await fetchOrigin(wtPath, host);
  // Tolerate the origin/ prefix on remoteless repos, mirroring resolveMergeBase.
  for (const ref of [baseRef, baseRef.replace(/^origin\//, '')]) {
    const r = await host.exec('git', ['merge-tree', '--write-tree', '--name-only', ref, 'HEAD'], {
      cwd: wtPath,
      timeout: 30_000,
    });
    if (r.exitCode === 0) return []; // clean merge — GitHub's CONFLICTING view was stale
    if (r.exitCode === 1) return parseMergeTreeConflicts(r.stdout).slice(0, 100); // conflicts
    // exit ≥2: a bad ref → try the origin-stripped variant; anything else
    // (old git without --write-tree, a broken repo) → unknown.
    const badRef = /(unknown revision|not a valid|ambiguous argument|did not match|invalid reference)/i.test(
      r.stderr + r.stdout
    );
    if (!badRef) return null;
  }
  return null;
}

/**
 * Commits on HEAD that origin doesn't have yet. GitHub judges mergeability
 * against the *pushed* head, so while these exist a locally clean merge proves
 * nothing about the PR — it really is conflicted until they're pushed. Returns 0
 * when there's nothing to compare against (branch never pushed, no remote).
 */
export async function unpushedCount(wtPath: string, branch: string, host: ExecHost = localHost): Promise<number> {
  if (!branch) return 0;
  const r = await host.exec('git', ['rev-list', '--count', `origin/${branch}..HEAD`], { cwd: wtPath });
  return r.ok ? parseInt(r.stdout.trim(), 10) || 0 : 0;
}

export async function statusSummary(wtPath: string, baseRef: string, host: ExecHost = localHost): Promise<GitStatusSummary> {
  // Independent reads — run them together. --no-optional-locks keeps `status`
  // from rewriting the index, which the watcher observes (it'd re-trigger us).
  const aheadBehind = async () => {
    for (const ref of [baseRef, baseRef.replace(/^origin\//, '')]) {
      const r = await host.exec('git', ['rev-list', '--left-right', '--count', `${ref}...HEAD`], { cwd: wtPath });
      if (r.ok) {
        const [b, a] = r.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
        return { behind: b || 0, ahead: a || 0 };
      }
    }
    return { behind: 0, ahead: 0 };
  };
  const [branch, { ahead, behind }, st] = await Promise.all([
    currentBranch(wtPath, host),
    aheadBehind(),
    host.exec('git', ['--no-optional-locks', 'status', '--porcelain', '-uall'], { cwd: wtPath }),
  ]);
  return parsePorcelainCounts(st.stdout, branch, ahead, behind);
}

/** Staged/unstaged/untracked counts from `git status --porcelain` (v1). */
function parsePorcelainCounts(porcelain: string, branch: string, ahead: number, behind: number): GitStatusSummary {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of porcelain.split('\n')) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') {
      if (!line.slice(3).startsWith('.context/')) untracked++;
      continue;
    }
    if (x !== ' ' && x !== '?') staged++;
    if (y !== ' ' && y !== '?') unstaged++;
  }
  const changed = staged + unstaged + untracked;
  return {
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    changedFiles: changed,
    dirty: changed > 0,
  };
}

/** Changed file paths vs merge-base (tracked) plus untracked — a light list
 *  for LLM context, no hunks. */
export async function changedFilePaths(wtPath: string, baseRef: string, limit = 60, host: ExecHost = localHost): Promise<string[]> {
  const out = new Set<string>();
  const mb = await resolveMergeBase(wtPath, baseRef, host);
  if (mb) {
    // Plumbing + numstat: names of files whose content differs, without the index
    // refresh porcelain `git diff` does against the working tree (lock-free; this
    // runs in the background, and in a direct workspace it's the user's index).
    const r = await host.exec('git', ['--no-optional-locks', 'diff-index', '--numstat', mb, '--', '.', ':!.context'], { cwd: wtPath, timeout: 30_000 });
    for (const line of r.stdout.split('\n')) {
      const f = line.split('\t')[2]?.trim();
      if (f) out.add(f);
    }
  }
  const st = await host.exec('git', ['--no-optional-locks', 'status', '--porcelain', '-uall'], { cwd: wtPath });
  for (const line of st.stdout.split('\n')) {
    const f = line.slice(3).trim();
    if (line.startsWith('??') && f && !f.startsWith('.context/')) out.add(f);
  }
  return [...out].slice(0, limit);
}

export async function commitAll(wtPath: string, message: string, host: ExecHost = localHost): Promise<{ ok: boolean; error?: string }> {
  await host.exec('git', ['add', '-A', '--', '.', ':!.context'], { cwd: wtPath });
  const r = await host.exec('git', ['commit', '-m', message], { cwd: wtPath });
  if (!r.ok) return { ok: false, error: (r.stdout + r.stderr).trim() };
  return { ok: true };
}

/**
 * Push HEAD to origin. An agent that ran `git checkout <sha>` (or origin/main)
 * leaves HEAD detached, and git then can't derive a destination branch from
 * `HEAD` — it fails with an unreadable "not a full refname" wall. Reattach to
 * the workspace's own branch first, but only when that provably orphans no
 * commits; otherwise say so rather than moving the branch out from under them.
 */
export async function pushCurrent(
  wtPath: string,
  host: ExecHost = localHost,
  branch?: string
): Promise<{ ok: boolean; error?: string; reattached?: string }> {
  let reattached: string | undefined;
  if (!(await host.exec('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: wtPath })).ok) {
    if (!branch) {
      return { ok: false, error: 'this workspace is not on a branch (detached HEAD), so there is no branch name to push to.' };
    }
    // Safe to (re)point the branch at HEAD when it doesn't exist yet, or when
    // its tip is already an ancestor of HEAD. Anything else would drop commits.
    const exists = await host.exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: wtPath });
    if (exists.ok && !(await host.exec('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd: wtPath })).ok) {
      return {
        ok: false,
        error:
          `this workspace is not on a branch (detached HEAD), and branch "${branch}" has commits that HEAD doesn't — ` +
          `reattaching would lose them. In the terminal, keep this work with \`git switch -c <new-branch>\`, ` +
          `or discard it with \`git switch ${branch}\`.`,
      };
    }
    const co = await host.exec('git', ['checkout', '-B', branch], { cwd: wtPath });
    if (!co.ok) {
      return { ok: false, error: `this workspace is not on a branch (detached HEAD) and reattaching to "${branch}" failed: ${co.stderr.trim()}` };
    }
    reattached = branch;
  }
  const r = await host.exec('git', ['push', '-u', 'origin', 'HEAD'], { cwd: wtPath, timeout: 120_000 });
  return r.ok ? { ok: true, reattached } : { ok: false, error: r.stderr.trim() };
}

/** `--stat` plus the patch vs the merge-base, capped, for inlining into an LLM
 *  prompt (so the model needn't run git itself — one inference, no tool round). */
export async function diffForPrompt(wtPath: string, baseRef: string, host: ExecHost = localHost): Promise<string> {
  const maxChars = 40_000;
  const mb = await resolveMergeBase(wtPath, baseRef, host);
  if (!mb) return '';
  const r = await host.exec('git', ['diff', '--stat', '-p', mb, 'HEAD', '--', '.', ':!.context'], { cwd: wtPath, timeout: 30_000 });
  const out = r.stdout.trim();
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n… (diff truncated)` : out;
}

export async function shortLog(wtPath: string, baseRef: string, host: ExecHost = localHost): Promise<string> {
  const mb = await resolveMergeBase(wtPath, baseRef, host);
  if (!mb) return '';
  const r = await host.exec('git', ['log', '--oneline', '--no-decorate', `${mb}..HEAD`], { cwd: wtPath });
  return r.stdout.trim();
}

/** Untracked (git status ??) paths in the worktree, minus .context/ and ignored
 *  top-level dirs. Callers cap the list themselves. */
async function untrackedPaths(wtPath: string, host: ExecHost): Promise<string[]> {
  const st = await host.exec('git', ['--no-optional-locks', 'status', '--porcelain', '-uall', '-z'], { cwd: wtPath });
  return st.stdout
    .split('\0')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3))
    .filter((p) => !p.startsWith('.context/') && !IGNORED_DIRS.has(p.split('/')[0]));
}

/** Sum +adds/−dels from `git diff --numstat` output (binary rows count 0). */
export function parseNumstat(stdout: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    if (m[1] !== '-') additions += parseInt(m[1], 10);
    if (m[2] !== '-') deletions += parseInt(m[2], 10);
  }
  return { additions, deletions };
}

/** Cheap +adds/−dels vs merge-base for sidebar rows (tracked via numstat, untracked via line counts). */
export async function diffStat(
  wtPath: string,
  baseRef: string,
  host: ExecHost = localHost
): Promise<{ additions: number; deletions: number }> {
  let additions = 0;
  let deletions = 0;
  const mb = await resolveMergeBase(wtPath, baseRef, host);
  if (mb) {
    const r = await host.exec('git', ['diff', '--numstat', mb, '--', '.', ':!.context'], {
      cwd: wtPath,
      timeout: 30_000,
    });
    ({ additions, deletions } = parseNumstat(r.stdout));
  }
  additions += await untrackedLineCount(wtPath, host);
  return { additions, deletions };
}

/** Lines in (up to 50) untracked text files — what `git diff` can't count. */
async function untrackedLineCount(wtPath: string, host: ExecHost): Promise<number> {
  let lines = 0;
  const untracked = await untrackedPaths(wtPath, host);
  for (const f of untracked.slice(0, 50)) {
    try {
      const full = host.path.join(wtPath, f);
      const fst = await host.fs.stat(full);
      if (fst.size > 1_000_000) continue;
      const content = (await host.fs.read(full)).toString('utf8');
      if (content.includes('\0')) continue; // binary
      lines += content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    } catch {}
  }
  return lines;
}

// ---------- diff ----------

export async function workspaceDiff(wtPath: string, baseRef: string, host: ExecHost = localHost): Promise<WorkspaceDiff> {
  const mb = await resolveMergeBase(wtPath, baseRef, host);
  const files: DiffFile[] = [];
  if (mb) {
    const d = await host.exec('git', ['diff', '--no-color', '--find-renames', mb, '--', '.', ':!.context'], {
      cwd: wtPath,
      timeout: 60_000,
    });
    files.push(...parseUnifiedDiff(d.stdout));
  }
  files.push(...(await untrackedDiffFiles(wtPath, host)));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { base: baseRef, files };
}

/** Untracked files don't appear in `git diff`; synthesize entries (up to 200). */
async function untrackedDiffFiles(wtPath: string, host: ExecHost): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  const untracked = await untrackedPaths(wtPath, host);
  for (const file of untracked.slice(0, 200)) {
    const nd = await host.exec('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', file], {
      cwd: wtPath,
      timeout: 20_000,
    });
    const parsed = parseUnifiedDiff(nd.stdout);
    for (const f of parsed) {
      f.status = 'untracked';
      files.push(f);
    }
    if (parsed.length === 0) {
      files.push({ path: file, oldPath: null, status: 'untracked', additions: 0, deletions: 0, hunks: [] });
    }
  }
  return files;
}

// ---------- direct workspaces (the user's own checkout) ----------
//
// A direct workspace has no branch of its own to compare against a base: what
// matters is what's uncommitted, split by where it sits in git, plus what the
// current branch has that its upstream doesn't. All reads here leave the index
// alone, so they never contend with the user's own git commands for its lock:
// --no-optional-locks covers status, but porcelain `git diff` refreshes the index
// whenever the working tree is one side (vs the index or vs a commit), flag or
// not — those comparisons use the `diff-files` / `diff-index` plumbing instead.

/** git's empty tree — the "before" of an unborn branch (no commits yet). */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const gitRead = (args: string[]) => ['--no-optional-locks', ...args];

/** HEAD's commit, or the empty tree on an unborn branch. */
async function headOrEmpty(wtPath: string, host: ExecHost): Promise<string> {
  return (await revParse(wtPath, 'HEAD', host)) ?? EMPTY_TREE;
}

/** The current branch's upstream ("origin/feature"), or null (none / detached). */
export async function upstreamOf(wtPath: string, host: ExecHost = localHost): Promise<string | null> {
  const r = await host.exec('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: wtPath });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/** statusSummary for a direct workspace: same counts, but ahead/behind against the
 *  branch's own upstream (0/0 when it has none). */
export async function directStatusSummary(wtPath: string, host: ExecHost = localHost): Promise<GitStatusSummary> {
  const [branch, upstream, st] = await Promise.all([
    currentBranch(wtPath, host),
    upstreamOf(wtPath, host),
    host.exec('git', gitRead(['status', '--porcelain', '-uall']), { cwd: wtPath }),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const r = await host.exec('git', ['rev-list', '--left-right', '--count', `${upstream}...HEAD`], { cwd: wtPath });
    if (r.ok) [behind, ahead] = r.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
  }
  return { ...parsePorcelainCounts(st.stdout, branch, ahead, behind), upstream };
}

/** Name → DiffFile from a `git diff` over the given args (cwd = wtPath). */
async function diffFiles(wtPath: string, args: string[], host: ExecHost): Promise<DiffFile[]> {
  const d = await host.exec('git', gitRead(['diff', '--no-color', '--find-renames', ...args, '--', '.', ':!.context']), {
    cwd: wtPath,
    timeout: 60_000,
  });
  return parseUnifiedDiff(d.stdout);
}

/** Working tree vs `against` (the index, or a commit), without refreshing the
 *  index. Unrefreshed stat info can make a touched-but-identical file show up as
 *  a bare header; drop those. */
async function worktreeFiles(wtPath: string, against: 'index' | string, host: ExecHost): Promise<DiffFile[]> {
  const cmd = against === 'index' ? ['diff-files', '-p'] : ['diff-index', '-p', '-M', against];
  const d = await host.exec('git', gitRead([...cmd, '--no-color', '--', '.', ':!.context']), { cwd: wtPath, timeout: 60_000 });
  return parseUnifiedDiff(d.stdout).filter((f) => f.hunks.length > 0 || f.status === 'binary' || f.status === 'deleted');
}
const unstagedFiles = (wtPath: string, host: ExecHost) => worktreeFiles(wtPath, 'index', host);

/**
 * A direct workspace's diff in one of four scopes (see DiffScope). One entry per
 * path in every scope; in `uncommitted`, each tracked file says whether its
 * change is staged, unstaged, or both. Unborn HEAD diffs against the empty tree;
 * `branch` falls back from the upstream to the project's base, then to nothing.
 */
export async function directDiff(
  wtPath: string,
  scope: DiffScope,
  baseRef: string | null,
  host: ExecHost = localHost
): Promise<WorkspaceDiff> {
  const head = await headOrEmpty(wtPath, host);
  const sorted = (base: string, files: DiffFile[]): WorkspaceDiff => ({
    base,
    scope,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  });
  if (scope === 'staged') return sorted('HEAD (staged changes)', await diffFiles(wtPath, ['--cached', head], host));
  if (scope === 'unstaged') {
    return sorted('the index (unstaged changes)', [...(await unstagedFiles(wtPath, host)), ...(await untrackedDiffFiles(wtPath, host))]);
  }
  if (scope === 'branch') {
    const upstream = await upstreamOf(wtPath, host);
    const from = upstream ?? (baseRef ? await resolveMergeBase(wtPath, baseRef, host) : null);
    if (!from || head === EMPTY_TREE) return sorted(upstream ?? baseRef ?? 'no upstream', []);
    // three-dot: what HEAD added since it forked from `from`, committed only.
    const files = await diffFiles(wtPath, [upstream ? `${upstream}...HEAD` : `${from}..HEAD`], host);
    return sorted(upstream ?? `${baseRef} (no upstream)`, files);
  }
  // uncommitted: working tree vs HEAD, each file tagged by where its change sits.
  const [all, staged, unstaged, untracked] = await Promise.all([
    worktreeFiles(wtPath, head, host),
    host.exec('git', gitRead(['diff', '--name-only', '--cached', head, '--', '.', ':!.context']), { cwd: wtPath }),
    unstagedFiles(wtPath, host),
    untrackedDiffFiles(wtPath, host),
  ]);
  const inIndex = new Set(staged.stdout.split('\n').filter(Boolean));
  const inTree = new Set(unstaged.map((f) => f.path));
  for (const f of all) {
    const s = inIndex.has(f.path) || (!!f.oldPath && inIndex.has(f.oldPath));
    const u = inTree.has(f.path);
    f.stage = s && u ? 'both' : s ? 'staged' : 'unstaged';
  }
  return sorted('HEAD', [...all, ...untracked]);
}

/** Sidebar +/− for a direct workspace: uncommitted changes vs HEAD plus untracked. */
export async function directDiffStat(wtPath: string, host: ExecHost = localHost): Promise<{ additions: number; deletions: number }> {
  const head = await headOrEmpty(wtPath, host);
  const r = await host.exec('git', gitRead(['diff-index', '--numstat', head, '--', '.', ':!.context']), { cwd: wtPath, timeout: 30_000 });
  const { additions, deletions } = parseNumstat(r.stdout);
  return { additions: additions + (await untrackedLineCount(wtPath, host)), deletions };
}

// ---------- misc workspace helpers ----------

/** Create .context/ and make git ignore it for every worktree of the repo.
 *  Resolves true once git ignores .context/ (or this isn't a git repo, where
 *  there's nothing to commit it into); false when that couldn't be arranged —
 *  callers working in a user's own checkout surface it rather than risk the
 *  folder being swept into a commit. */
export async function ensureContextDir(wtPath: string, host: ExecHost = localHost): Promise<boolean> {
  const p = host.path;
  await host.fs.mkdirp(p.join(wtPath, '.context', 'attachments'));
  // A path under .context/: a directory pattern matches what's inside it. Pattern
  // check only (--no-index), so it holds even if someone committed .context/.
  const ignored = async () => {
    const r = await host.exec('git', ['check-ignore', '-q', '--no-index', '.context/.maestro'], { cwd: wtPath });
    return r.exitCode === 0;
  };
  const inRepo = await host.exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: wtPath });
  if (!inRepo.ok) return true;
  // Already ignored (repo .gitignore, global excludes, or an earlier run): touch nothing.
  if (await ignored()) return true;
  // info/exclude lives in the common git dir, shared by every linked worktree;
  // --git-path knows where that is for any layout (gitdir: files, GIT_COMMON_DIR).
  const where = await host.exec('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: wtPath });
  if (!where.ok || !where.stdout.trim()) return false;
  let excludePath = where.stdout.trim();
  if (!p.isAbsolute(excludePath)) excludePath = p.join(wtPath, excludePath);
  try {
    await host.fs.mkdirp(p.dirname(excludePath));
    const cur = (await host.fs.exists(excludePath)) ? (await host.fs.read(excludePath)).toString('utf8') : '';
    const line = (cur === '' || cur.endsWith('\n') ? '' : '\n') + '.context/\n';
    // Append rather than rewrite, so a concurrent edit to the file isn't lost.
    if (host.id === 'local') await fs.promises.appendFile(excludePath, line);
    else await host.fs.write(excludePath, cur + line);
  } catch {
    // fall through to the re-check
  }
  return ignored();
}

/**
 * Turn an existing folder into a git repo with a first commit capturing its
 * current contents — the "Initialize git here" upsell (spec §6.3). Unlike
 * initQuickstartRepo it writes no README; the folder already has files.
 */
export async function initFolderRepo(dir: string, host: ExecHost = localHost) {
  await gexecThrow(host, 'git', ['init', '-b', 'main'], { cwd: dir });
  await host.exec('git', ['add', '-A'], { cwd: dir });
  await host.exec('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
}

export async function initQuickstartRepo(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  await runOrThrow('git', ['init', '-b', 'main'], { cwd: dir });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, `# ${name}\n\nCreated with Maestro quick start.\n`);
  }
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
}
