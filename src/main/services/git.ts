import fs from 'fs';
import path from 'path';
import { run, runOrThrow } from '../exec';
import { localHost } from '../hosts/local';
import type { ExecHost, ExecOpts } from '../hosts/types';
import type {
  BranchInfo,
  DiffFile,
  DiffHunk,
  DiffLine,
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
  const branch = await currentBranch(wtPath, host);
  let ahead = 0;
  let behind = 0;
  for (const ref of [baseRef, baseRef.replace(/^origin\//, '')]) {
    const r = await host.exec('git', ['rev-list', '--left-right', '--count', `${ref}...HEAD`], { cwd: wtPath });
    if (r.ok) {
      const [b, a] = r.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
      behind = b || 0;
      ahead = a || 0;
      break;
    }
  }
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const st = await host.exec('git', ['status', '--porcelain', '-uall'], { cwd: wtPath });
  for (const line of st.stdout.split('\n')) {
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
    const r = await host.exec('git', ['diff', '--name-only', mb, '--', '.', ':!.context'], { cwd: wtPath, timeout: 30_000 });
    for (const f of r.stdout.split('\n')) if (f.trim()) out.add(f.trim());
  }
  const st = await host.exec('git', ['status', '--porcelain', '-uall'], { cwd: wtPath });
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

export async function shortLog(wtPath: string, baseRef: string, host: ExecHost = localHost): Promise<string> {
  const mb = await resolveMergeBase(wtPath, baseRef, host);
  if (!mb) return '';
  const r = await host.exec('git', ['log', '--oneline', '--no-decorate', `${mb}..HEAD`], { cwd: wtPath });
  return r.stdout.trim();
}

/** Untracked (git status ??) paths in the worktree, minus .context/ and ignored
 *  top-level dirs. Callers cap the list themselves. */
async function untrackedPaths(wtPath: string, host: ExecHost): Promise<string[]> {
  const st = await host.exec('git', ['status', '--porcelain', '-uall', '-z'], { cwd: wtPath });
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
  const untracked = await untrackedPaths(wtPath, host);
  for (const f of untracked.slice(0, 50)) {
    try {
      const full = host.path.join(wtPath, f);
      const fst = await host.fs.stat(full);
      if (fst.size > 1_000_000) continue;
      const content = (await host.fs.read(full)).toString('utf8');
      if (content.includes('\0')) continue; // binary
      additions += content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    } catch {}
  }
  return { additions, deletions };
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
  // Untracked files don't appear in `git diff`; synthesize entries.
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
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { base: baseRef, files };
}

function unquoteGitPath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p);
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

function stripPrefix(p: string): string {
  const un = unquoteGitPath(p);
  if (un === '/dev/null') return un;
  return un.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split('\n');
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLn = 0;
  let newLn = 0;
  let renameFrom: string | null = null;
  let isNew = false;
  let isDeleted = false;

  const flushFile = () => {
    if (cur) files.push(cur);
    cur = null;
    hunk = null;
    renameFrom = null;
    isNew = false;
    isDeleted = false;
  };

  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      flushFile();
      // "diff --git a/path b/path" (possibly quoted)
      const m = raw.match(/^diff --git (.+) (.+)$/);
      const bPath = m ? stripPrefix(m[2]) : 'unknown';
      cur = { path: bPath, oldPath: null, status: 'modified', additions: 0, deletions: 0, hunks: [] };
      continue;
    }
    if (!cur) continue;
    const c: DiffFile = cur;
    if (raw.startsWith('new file mode')) {
      isNew = true;
      c.status = 'added';
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
      isDeleted = true;
      c.status = 'deleted';
      continue;
    }
    if (raw.startsWith('rename from ')) {
      renameFrom = raw.slice('rename from '.length);
      continue;
    }
    if (raw.startsWith('rename to ')) {
      c.status = 'renamed';
      c.oldPath = renameFrom ? unquoteGitPath(renameFrom) : null;
      c.path = unquoteGitPath(raw.slice('rename to '.length));
      continue;
    }
    if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) {
      c.status = c.status === 'added' ? 'added' : c.status === 'deleted' ? 'deleted' : 'binary';
      if (c.hunks.length === 0) c.hunks = [];
      continue;
    }
    if (raw.startsWith('--- ')) {
      const p = stripPrefix(raw.slice(4).trim());
      if (p !== '/dev/null' && !c.oldPath && c.status === 'renamed') c.oldPath = p;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = stripPrefix(raw.slice(4).trim());
      if (p !== '/dev/null') c.path = p;
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) continue;
      oldLn = parseInt(m[1], 10);
      newLn = parseInt(m[2], 10);
      hunk = { header: raw, lines: [] };
      c.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'add', oldLine: null, newLine: newLn++, text: raw.slice(1) });
      c.additions++;
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'del', oldLine: oldLn++, newLine: null, text: raw.slice(1) });
      c.deletions++;
    } else if (raw.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', oldLine: oldLn++, newLine: newLn++, text: raw.slice(1) });
    } else if (raw.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', oldLine: null, newLine: null, text: raw });
    }
  }
  flushFile();
  // status refinement for /dev/null cases
  for (const f of files) {
    if (isNewFile(f) && f.status === 'modified') f.status = 'added';
  }
  return files;
}

function isNewFile(f: DiffFile): boolean {
  return f.hunks.length > 0 && f.hunks.every((h) => h.lines.every((l) => l.kind !== 'del' && l.kind !== 'context'));
}

// ---------- misc workspace helpers ----------

/** Create .context/ and make git ignore it for every worktree of the repo. */
export async function ensureContextDir(wtPath: string, host: ExecHost = localHost) {
  const p = host.path;
  const dir = p.join(wtPath, '.context');
  await host.fs.mkdirp(p.join(dir, 'attachments'));
  const common = await host.exec('git', ['rev-parse', '--git-common-dir'], { cwd: wtPath });
  if (common.ok) {
    let commonDir = common.stdout.trim();
    if (!p.isAbsolute(commonDir)) commonDir = p.join(wtPath, commonDir);
    const excludePath = p.join(commonDir, 'info', 'exclude');
    try {
      await host.fs.mkdirp(p.dirname(excludePath));
      const cur = (await host.fs.exists(excludePath)) ? (await host.fs.read(excludePath)).toString('utf8') : '';
      if (!cur.split('\n').includes('.context/')) {
        await host.fs.write(excludePath, cur + (cur.endsWith('\n') || cur === '' ? '' : '\n') + '.context/\n');
      }
    } catch {
      // non-fatal
    }
  }
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
