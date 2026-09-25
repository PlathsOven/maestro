/**
 * Archive disk reclaim e2e (docs/specs/archive-disk-reclaim.md) — real git repos
 * in a temp dir, no Electron/DB. `npm run e2e:offload`.
 *
 * Offload → rehydrate must be lossless for everything but regenerable output:
 * tracked edits, deletions, untracked files, the staged state, kept ignored files
 * (.env, .context/, data), nested repos, unpushed commits — across a moved
 * branch, a conflicting branch, a deleted branch, a detached HEAD, and crashes.
 */
import assert from 'assert';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { offloadWorktree, rehydrateWorktree, isOffloaded, type OffloadTarget } from '../src/main/services/offload';
import { reuseDependencies } from '../src/main/services/depreuse';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-e2e-'));
const repo = path.join(root, 'repo');
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
const exists = (p: string) => fs.existsSync(p);

let n = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(
    () => console.log(`  ✓ ${name}`),
    (e) => {
      console.error(`  ✗ ${name}\n${e?.stack ?? e}`);
      process.exitCode = 1;
    }
  );
}

/** Every file under wt except .git and regenerable dirs → sha of its bytes. */
function fileMap(wt: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(wt, abs);
      if (e.name === '.git' && dir === wt) continue;
      if (['node_modules', '.next'].includes(e.name)) continue;
      if (e.isDirectory()) walk(abs);
      else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  walk(wt);
  return out;
}

/** The complete observable state rehydrate must reproduce. */
function state(wt: string) {
  return {
    status: git(wt, 'status', '--porcelain=v1', '--untracked-files=all'),
    staged: git(wt, 'diff', '--cached'),
    head: git(wt, 'rev-parse', 'HEAD'),
    branch: git(wt, 'branch', '--show-current'),
    files: fileMap(wt),
  };
}

let wsSeq = 0;
/** A fresh worktree on its own branch with a rich, messy state. */
function messyWorktree(): OffloadTarget {
  const id = `ws${++wsSeq}`;
  const wt = path.join(root, 'workspaces', id);
  git(repo, 'worktree', 'add', '-q', '-b', `feat-${id}`, wt, 'main');
  write(path.join(wt, 'unpushed.txt'), 'committed but never pushed\n');
  git(wt, 'add', 'unpushed.txt');
  git(wt, 'commit', '-qm', 'local commit');
  write(path.join(wt, 'a.txt'), 'a modified\n'); // tracked edit
  fs.rmSync(path.join(wt, 'b.txt')); // tracked deletion
  write(path.join(wt, 'new/deep/c.txt'), 'untracked\n'); // untracked
  write(path.join(wt, 'staged.txt'), 'staged new\n');
  git(wt, 'add', 'staged.txt'); // staged add
  write(path.join(wt, 'shared.txt'), 'shared staged\n');
  git(wt, 'add', 'shared.txt');
  write(path.join(wt, 'shared.txt'), 'shared staged then edited\n'); // staged + unstaged on one file
  write(path.join(wt, '.env'), 'SECRET=1\n'); // kept ignored
  write(path.join(wt, '.context/notes.md'), '# notes\n'); // kept ignored (info/exclude)
  write(path.join(wt, 'data/big.csv'), 'x,y\n1,2\n'); // kept ignored
  write(path.join(wt, 'node_modules/pkg/index.js'), 'module.exports=1\n'); // regenerable
  write(path.join(wt, 'web/.next/cache/x'), 'cache\n'); // regenerable (nested)
  const nested = path.join(wt, 'vendor/sub');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q');
  write(path.join(nested, 'lib.txt'), 'nested repo file\n');
  git(nested, 'add', '.');
  git(nested, 'commit', '-qm', 'nested');
  return { repoPath: repo, wtPath: wt, dir: path.join(root, 'archive', id), ref: `refs/maestro/archive/${id}` };
}

async function main() {
  console.log(`offload e2e in ${root}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  write(path.join(repo, 'a.txt'), 'a\n');
  write(path.join(repo, 'b.txt'), 'b\n');
  write(path.join(repo, 'shared.txt'), 'shared\n');
  write(path.join(repo, '.gitignore'), 'node_modules/\n.next/\n.env\ndata/\n');
  write(path.join(repo, '.git/info/exclude'), '.context/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');

  await check('offload frees the worktree; rehydrate restores it exactly (minus regenerable output)', async () => {
    const t = messyWorktree();
    const before = state(t.wtPath);
    const r = await offloadWorktree(t);
    assert.deepStrictEqual(r, { freed: true });
    assert(!exists(t.wtPath), 'worktree dir removed');
    assert(isOffloaded(t), 'marked offloaded');
    assert(git(repo, 'rev-parse', '--verify', t.ref), 'snapshot ref pinned');
    assert(!git(repo, 'worktree', 'list').includes(t.wtPath), 'worktree unregistered');

    const back = await rehydrateWorktree(t);
    assert.deepStrictEqual(back, { recreated: true, warning: undefined });
    const after = state(t.wtPath);
    assert.deepStrictEqual(after, before);
    assert(!exists(path.join(t.wtPath, 'node_modules')), 'node_modules dropped');
    assert(!exists(path.join(t.wtPath, 'web/.next')), '.next dropped');
    assert(exists(path.join(t.wtPath, 'vendor/sub/.git')), 'nested repo kept with its .git');
    assert(!exists(t.dir), 'archive record gone');
    assert.throws(() => git(repo, 'rev-parse', '--verify', '-q', t.ref), 'ref dropped');
    assert(!isOffloaded(t));
  });

  await check('branch moved on while archived → uncommitted work replays on the new tip', async () => {
    const t = messyWorktree();
    const branch = git(t.wtPath, 'branch', '--show-current');
    const before = state(t.wtPath);
    await offloadWorktree(t);
    const other = path.join(root, 'other');
    git(repo, 'worktree', 'add', '-q', other, branch);
    write(path.join(other, 'upstream.txt'), 'pushed from elsewhere\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'moved on');
    const tip = git(other, 'rev-parse', 'HEAD');
    git(repo, 'worktree', 'remove', other);

    const back = await rehydrateWorktree(t);
    assert.strictEqual(back?.warning, undefined);
    assert.strictEqual(git(t.wtPath, 'rev-parse', 'HEAD'), tip);
    const files = fileMap(t.wtPath);
    for (const [f, sha] of Object.entries(before.files)) assert.strictEqual(files[f], sha, f);
    assert(files['upstream.txt'], 'new commit present');
    assert(!files['b.txt'], 'deletion replayed');
  });

  await check('conflicting branch → conflict warning, snapshot kept at a backup ref', async () => {
    const t = messyWorktree();
    const branch = git(t.wtPath, 'branch', '--show-current');
    await offloadWorktree(t);
    const other = path.join(root, 'other2');
    git(repo, 'worktree', 'add', '-q', other, branch);
    write(path.join(other, 'a.txt'), 'a changed upstream\n');
    git(other, 'commit', '-qam', 'conflict');
    git(repo, 'worktree', 'remove', other);

    const back = await rehydrateWorktree(t);
    assert.match(back?.warning ?? '', /conflict/);
    assert(git(repo, 'rev-parse', '--verify', `${t.ref}-conflict`), 'backup ref');
    assert.match(fs.readFileSync(path.join(t.wtPath, 'a.txt'), 'utf8'), /<<<<<<<|a modified/);
    assert(exists(path.join(t.wtPath, '.env')), 'kept files still restored');
    assert(!exists(t.dir), 'record closed so a second restore cannot wipe it');
  });

  await check('branch deleted while archived → recreated from the snapshot head (unpushed commit survives)', async () => {
    const t = messyWorktree();
    const branch = git(t.wtPath, 'branch', '--show-current');
    const before = state(t.wtPath);
    await offloadWorktree(t);
    git(repo, 'branch', '-D', branch);
    await rehydrateWorktree(t);
    assert.deepStrictEqual(state(t.wtPath), before);
  });

  await check('detached HEAD round-trips', async () => {
    const t = messyWorktree();
    git(t.wtPath, 'checkout', '-q', '--detach');
    const before = state(t.wtPath);
    await offloadWorktree(t);
    await rehydrateWorktree(t);
    assert.deepStrictEqual(state(t.wtPath), before);
  });

  await check('crash mid-removal → rehydrate discards the partial tree and restores', async () => {
    const t = messyWorktree();
    const before = state(t.wtPath);
    await offloadWorktree(t);
    write(path.join(t.wtPath, 'half-deleted-junk'), 'x'); // what a killed `worktree remove` leaves
    const m = JSON.parse(fs.readFileSync(path.join(t.dir, 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(t.dir, 'manifest.json'), JSON.stringify({ ...m, phase: 'removing' }));
    assert(isOffloaded(t));
    await rehydrateWorktree(t);
    assert.deepStrictEqual(state(t.wtPath), before);
  });

  await check('failure before removal rolls back: worktree untouched, record gone, retry works', async () => {
    const t = messyWorktree();
    const before = state(t.wtPath);
    fs.mkdirSync(t.dir, { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'files'), 'blocks the kept-files dir'); // makes the move throw
    await assert.rejects(offloadWorktree(t));
    assert.deepStrictEqual(state(t.wtPath), before);
    assert(!exists(t.dir), 'record rolled back');
    assert.deepStrictEqual(await offloadWorktree(t), { freed: true });
    await rehydrateWorktree(t);
    assert.deepStrictEqual(state(t.wtPath), before);
  });

  await check('never offloads mid-merge or with submodules', async () => {
    const t = messyWorktree();
    const mergeHead = git(t.wtPath, 'rev-parse', '--git-path', 'MERGE_HEAD');
    fs.writeFileSync(path.resolve(t.wtPath, mergeHead), git(repo, 'rev-parse', 'main'));
    assert.deepStrictEqual(await offloadWorktree(t), { freed: false, reason: 'an operation is in progress' });
    fs.rmSync(path.resolve(t.wtPath, mergeHead));
    write(path.join(t.wtPath, '.gitmodules'), '');
    assert.deepStrictEqual(await offloadWorktree(t), { freed: false, reason: 'has submodules' });
    assert(exists(path.join(t.wtPath, 'node_modules')), 'untouched');
  });

  await check('a live worktree with no record: rehydrate is a no-op', async () => {
    const t = messyWorktree();
    assert.strictEqual(await rehydrateWorktree(t), null);
  });

  await check('dependency reuse clones node_modules only from an identical lockfile', async () => {
    write(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    write(path.join(repo, 'web/package-lock.json'), '{"web":1}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'lockfiles');
    const mk = (name: string) => {
      const wt = path.join(root, 'dep', name);
      git(repo, 'worktree', 'add', '-q', '-b', `dep-${name}`, wt, 'main');
      return wt;
    };
    const donor = mk('donor');
    write(path.join(donor, 'node_modules/left-pad/index.js'), 'pad\n');
    write(path.join(donor, 'web/node_modules/react/index.js'), 'react\n');
    const stale = mk('stale');
    write(path.join(stale, 'package-lock.json'), '{"lockfileVersion":2}\n');
    write(path.join(stale, 'node_modules/old/index.js'), 'old\n');

    const fresh = mk('fresh');
    const cloned = await reuseDependencies(fresh, [stale, donor]);
    if (process.platform === 'darwin' || process.platform === 'linux') {
      // Linux CI without reflink support clones nothing — that's the safe outcome too.
      if (process.platform === 'darwin') assert.deepStrictEqual(cloned.sort(), ['node_modules', 'web/node_modules']);
      if (cloned.length) {
        assert.strictEqual(fs.readFileSync(path.join(fresh, 'node_modules/left-pad/index.js'), 'utf8'), 'pad\n');
        assert(!exists(path.join(fresh, 'node_modules/old')), 'stale lockfile donor skipped');
        assert.strictEqual(git(fresh, 'status', '--porcelain'), '', 'clone is ignored');
      }
    }
    assert.deepStrictEqual(await reuseDependencies(fresh, [donor]), [], 'existing node_modules left alone');
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(process.exitCode ? 'FAILED' : `offload e2e passed`);
}

void main();
