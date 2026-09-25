import fs from 'fs';
import os from 'os';
import path from 'path';
import { run } from '../exec';

/**
 * Lossless "free the disk" for an archived worktree (docs/specs/archive-disk-reclaim.md).
 *
 * Offload snapshots everything a worktree holds that git can't rebuild from the
 * branch — uncommitted edits, deletions, untracked files, the staged state —
 * into a commit pinned at a private ref, moves the gitignored files worth keeping
 * (.env, .context/, local data…) aside, and removes the worktree. Only
 * regenerable output (node_modules, .next, build dirs, caches) is dropped.
 * Rehydrate reverses it at the same path.
 *
 * Every step records its phase in the manifest first, so a crash anywhere leaves
 * a state rehydrate knows how to finish. DB-free: callers own the workspace row.
 */

export interface OffloadTarget {
  repoPath: string;
  wtPath: string;
  /** Per-workspace archive dir: manifest.json + files/ (kept ignored entries). */
  dir: string;
  /** Private ref pinning the snapshot commit, e.g. refs/maestro/archive/<wsId>. */
  ref: string;
}

/** snapshot/moving ⇒ the worktree is still on disk; removing/freed ⇒ it's (being) gone. */
type Phase = 'snapshot' | 'moving' | 'removing' | 'freed';

interface Manifest {
  v: 1;
  phase: Phase;
  /** HEAD at archive time (parent 1 of the snapshot) and its branch ('' = detached). */
  head: string;
  branch: string;
  /** Commit whose tree is the full working tree; parent 2's tree is the index. */
  snapshot: string;
  /** Worktree-relative entries moved to <dir>/files. */
  kept: string[];
  at: number;
}

/** Ignored output that a fresh install/build regenerates — the only things offload drops. */
const REGENERABLE = new Set([
  'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.vite', '.cache',
  'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', 'coverage', '.gradle', 'DerivedData', 'Pods', '.expo', '.angular', '.dart_tool',
]);

// Internal bookkeeping commits: never signed, never attributed to the user.
const IDENT = ['-c', 'user.name=Maestro', '-c', 'user.email=maestro@localhost', '-c', 'commit.gpgsign=false'];

async function git(cwd: string, args: string[], env?: Record<string, string>) {
  return run('git', [...IDENT, ...args], { cwd, timeout: 300_000, env });
}

async function gitOut(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await git(cwd, args, env);
  if (!r.ok) throw new Error(r.stderr.trim() || `git ${args.join(' ')} failed`);
  return r.stdout.trim();
}

const manifestPath = (dir: string) => path.join(dir, 'manifest.json');

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

function writeManifest(dir: string, m: Manifest) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${manifestPath(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, manifestPath(dir)); // atomic: a crash never leaves half a manifest
}

/** True when an offload record exists (the worktree may or may not still be on disk). */
function hasOffload(t: OffloadTarget): boolean {
  return readManifest(t.dir) !== null;
}

/** The worktree is gone (or going) from disk — what `Workspace.filesFreed` mirrors. */
export function isOffloaded(t: OffloadTarget): boolean {
  const phase = readManifest(t.dir)?.phase;
  return phase === 'removing' || phase === 'freed';
}

/** lstat that treats every failure (ENOENT, ENOTDIR…) as "nothing there". */
function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Rename, falling back to copy+delete across volumes. */
function move(src: string, dst: string) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/** A git repo somewhere under `dir` (bounded walk) — git can't snapshot its contents. */
function containsRepo(dir: string, depth = 4): boolean {
  if (fs.existsSync(path.join(dir, '.git'))) return true;
  if (depth === 0) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isDirectory() && !REGENERABLE.has(e.name) && containsRepo(path.join(dir, e.name), depth - 1));
}

const lines = (s: string) => s.split('\n').map((l) => l.replace(/\/$/, '')).filter(Boolean);

/** Why this worktree can't be offloaded safely right now, or null when it can. */
async function blocker(wt: string): Promise<string | null> {
  if (fs.existsSync(path.join(wt, '.gitmodules'))) return 'has submodules';
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
  const paths = lines(await gitOut(wt, ['rev-parse', ...markers.flatMap((m) => ['--git-path', m])]));
  if (paths.some((p) => fs.existsSync(path.resolve(wt, p)))) return 'an operation is in progress';
  if (!(await git(wt, ['rev-parse', '--verify', '-q', 'HEAD'])).ok) return 'no commits yet';
  return null;
}

/**
 * Snapshot, set aside kept files, and remove the worktree. Returns why it was
 * skipped instead of throwing for the expected "can't do this one" cases.
 */
export async function offloadWorktree(t: OffloadTarget): Promise<{ freed: boolean; reason?: string }> {
  if (!fs.existsSync(t.wtPath)) return { freed: false, reason: 'worktree missing' };
  if (hasOffload(t)) return { freed: false, reason: 'already offloaded' };
  const blocked = await blocker(t.wtPath);
  if (blocked) return { freed: false, reason: blocked };
  try {
    return await offloadSteps(t);
  } catch (e) {
    // Failed while the worktree was still whole: put back what was moved and drop
    // the record, so it's exactly as before and a later attempt can retry.
    const phase = readManifest(t.dir)?.phase;
    if (phase === 'snapshot' || phase === 'moving') await rehydrateWorktree(t).catch(() => {});
    throw e;
  }
}

async function offloadSteps(t: OffloadTarget): Promise<{ freed: boolean; reason?: string }> {
  const wt = t.wtPath;

  const head = await gitOut(wt, ['rev-parse', 'HEAD']);
  const branch = (await git(wt, ['branch', '--show-current'])).stdout.trim();

  // Untracked dirs holding their own repo can't live in the snapshot — keep them whole.
  const untracked = lines(await gitOut(wt, ['ls-files', '--others', '--exclude-standard', '--directory']));
  const nested = untracked.filter((e) => fs.statSync(path.join(wt, e), { throwIfNoEntry: false })?.isDirectory() && containsRepo(path.join(wt, e)));

  // 1. Snapshot. Index state first (fails on unmerged entries — refuse then), then
  //    the whole working tree through a throwaway index so the real one is untouched.
  const indexTree = (await git(wt, ['write-tree'])).stdout.trim();
  if (!indexTree) return { freed: false, reason: 'unmerged index' };
  const tmpIndex = path.join(os.tmpdir(), `maestro-offload-${process.pid}-${Date.now()}.index`);
  let workTree: string;
  try {
    const env = { GIT_INDEX_FILE: tmpIndex };
    await gitOut(wt, ['read-tree', 'HEAD'], env);
    await gitOut(wt, ['add', '-A', '--', '.', ...nested.map((n) => `:(exclude,literal)${n}`)], env);
    workTree = await gitOut(wt, ['write-tree'], env);
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
  const m: Manifest = { v: 1, phase: 'snapshot', head, branch, snapshot: '', kept: [], at: Date.now() };
  writeManifest(t.dir, m); // before the ref, so a crash never orphans one
  const indexCommit = await gitOut(wt, ['commit-tree', indexTree, '-p', head, '-m', 'maestro: archived index']);
  m.snapshot = await gitOut(wt, ['commit-tree', workTree, '-p', head, '-p', indexCommit, '-m', 'maestro: archived worktree']);
  await gitOut(wt, ['update-ref', t.ref, m.snapshot]);
  writeManifest(t.dir, m);

  // 2. Keep every ignored entry that isn't regenerable output, plus nested repos.
  //    git also lists an untracked dir holding only ignored files (`web/` beside
  //    `web/.next/`) — the finer entries describe it, so only leaves count.
  const ignored = lines(await gitOut(wt, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']));
  const leaves = ignored.filter((e) => !ignored.some((o) => o.startsWith(`${e}/`)));
  m.kept = [...leaves.filter((e) => !e.split('/').some((seg) => REGENERABLE.has(seg))), ...nested];
  m.phase = 'moving';
  writeManifest(t.dir, m);
  const files = path.join(t.dir, 'files');
  for (const rel of m.kept) {
    const src = path.join(wt, rel);
    if (lstat(src)) move(src, path.join(files, rel));
  }

  // 3. Remove. Double force also clears a lock on the worktree.
  m.phase = 'removing';
  writeManifest(t.dir, m);
  await git(t.repoPath, ['worktree', 'remove', '--force', '--force', wt]);
  if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  await git(t.repoPath, ['worktree', 'prune']);
  m.phase = 'freed';
  writeManifest(t.dir, m);
  return { freed: true };
}

/**
 * Bring an offloaded worktree back at its original path, exactly as it was
 * (modulo regenerable output). Returns null when there's no offload record.
 * `recreated` says the worktree was rebuilt (so deps/setup need to run again).
 * Anything that couldn't be put back cleanly is parked under its own name and
 * reported in `warning`; the record itself is always closed.
 */
export async function rehydrateWorktree(t: OffloadTarget): Promise<{ recreated: boolean; warning?: string } | null> {
  const m = readManifest(t.dir);
  if (!m) return null;
  const wt = t.wtPath;
  const warnings: string[] = [];
  const recreated = m.phase === 'removing' || m.phase === 'freed';

  if (recreated) {
    // A crash mid-removal leaves a partial tree — the snapshot is the truth.
    if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
    await git(t.repoPath, ['worktree', 'prune']);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    const branchExists = !!m.branch && (await git(t.repoPath, ['show-ref', '--verify', '-q', `refs/heads/${m.branch}`])).ok;
    const add = !m.branch
      ? ['worktree', 'add', '--detach', wt, m.head]
      : branchExists
        ? ['worktree', 'add', wt, m.branch]
        : ['worktree', 'add', '-b', m.branch, wt, m.head]; // branch deleted meanwhile: rebuild it
    const r = await git(t.repoPath, add);
    if (!r.ok) {
      if (/already (checked out|used by worktree)/i.test(r.stderr)) {
        throw new Error(`Branch ${m.branch} is checked out in another workspace`);
      }
      throw new Error(r.stderr.trim() || 'git worktree add failed');
    }

    const tip = await gitOut(wt, ['rev-parse', 'HEAD']);
    if (tip === m.head) {
      // Exact: working tree from the snapshot, index from its second parent.
      await gitOut(wt, ['restore', `--source=${m.snapshot}`, '--worktree', '--', '.']);
      await gitOut(wt, ['read-tree', `${m.snapshot}^2^{tree}`]);
      await git(wt, ['update-index', '-q', '--refresh']);
    } else if ((await gitOut(wt, ['rev-parse', `${m.snapshot}^{tree}`])) !== (await gitOut(wt, ['rev-parse', `${m.head}^{tree}`]))) {
      // The branch moved on while archived: replay the uncommitted work 3-way.
      const pick = await git(wt, ['cherry-pick', '--no-commit', '-m', '1', m.snapshot]);
      await git(wt, ['cherry-pick', '--quit']);
      await git(wt, ['reset', '-q']);
      if (!pick.ok) {
        const backup = `${t.ref}-conflict`;
        await git(t.repoPath, ['update-ref', backup, m.snapshot]);
        warnings.push(
          `Your uncommitted changes conflicted with new commits on ${m.branch || 'the branch'} — resolve the conflict markers. ` +
            `The original snapshot is kept at ${backup}.`
        );
      }
    }
  }

  // Kept files go back where they were — never over something already there.
  const files = path.join(t.dir, 'files');
  const stranded: string[] = [];
  for (const rel of m.kept) {
    const src = path.join(files, rel);
    if (!lstat(src)) continue;
    const dst = path.join(wt, rel);
    const there = lstat(dst);
    if (there?.isDirectory() && fs.readdirSync(dst).length === 0) fs.rmdirSync(dst);
    else if (there) {
      stranded.push(rel);
      continue;
    }
    move(src, dst);
  }
  if (stranded.length) {
    // Park them outside the record so discarding it (below) can't lose them.
    const leftover = `${t.dir}-leftover-${Date.now()}`;
    move(files, leftover);
    warnings.push(`Some local files couldn't be put back (already present): ${stranded.join(', ')} — they're in ${leftover}.`);
  }

  // Always close the record once the worktree is back: a lingering 'freed'
  // manifest would make the next rehydrate rebuild (and wipe) a live worktree.
  await discardOffload(t);
  return { recreated, warning: warnings.join(' ') || undefined };
}

/** Forget an offload: drop the ref and the archive dir (workspace deleted, or restored cleanly). */
export async function discardOffload(t: OffloadTarget): Promise<void> {
  if (fs.existsSync(t.repoPath)) await git(t.repoPath, ['update-ref', '-d', t.ref]);
  fs.rmSync(t.dir, { recursive: true, force: true });
}
