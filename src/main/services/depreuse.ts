import fs from 'fs';
import path from 'path';
import { run } from '../exec';

/**
 * Dependency reuse (docs/specs/archive-disk-reclaim.md §2): give a fresh worktree
 * the node_modules of a sibling checkout whose lockfile is byte-identical, as a
 * copy-on-write clone — seconds instead of an install, and ~no extra disk.
 *
 * Identical lockfile only, so the result is what a clean install would produce;
 * anything else falls back to today's behaviour (setup script / the agent
 * installs). pnpm is left out: its .bin shims bake in absolute store paths.
 */

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']);

/** Clone a directory tree without duplicating its blocks, or report that we can't. */
async function cloneDir(src: string, dst: string): Promise<boolean> {
  const args =
    process.platform === 'darwin' ? ['-cR', src, dst] // APFS clonefile
    : process.platform === 'linux' ? ['-R', '--reflink=always', src, dst] // btrfs/xfs; fails elsewhere
    : null; // no reflink copy we trust — a full copy would defeat the point
  if (!args) return false;
  const r = await run('cp', args, { timeout: 300_000 });
  if (!r.ok) fs.rmSync(dst, { recursive: true, force: true });
  return r.ok;
}

function sameBytes(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function nonEmptyDir(p: string): boolean {
  try {
    return fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

/**
 * Fill each missing `node_modules` in `wtPath` (one per tracked lockfile) from the
 * first donor checkout with the identical lockfile. Donors are tried in order.
 * Returns the worktree-relative dirs that were cloned. Never throws.
 */
export async function reuseDependencies(wtPath: string, donors: string[]): Promise<string[]> {
  const ls = await run('git', ['ls-files', '-z'], { cwd: wtPath, timeout: 60_000 });
  if (!ls.ok) return [];
  const lockfiles = ls.stdout
    .split('\0')
    .filter((f) => LOCKFILES.has(path.posix.basename(f)) && !f.split('/').includes('node_modules'));
  const cloned: string[] = [];
  for (const lock of lockfiles) {
    const rel = path.join(path.dirname(lock), 'node_modules');
    const target = path.join(wtPath, rel);
    if (fs.existsSync(target)) continue;
    // Only where the repo ignores it — otherwise the clone would flood `git status`.
    // (Trailing slash: a `node_modules/` pattern only matches a path known to be a dir.)
    if (!(await run('git', ['check-ignore', '-q', `${rel}/`], { cwd: wtPath })).ok) continue;
    for (const donor of donors) {
      if (path.resolve(donor) === path.resolve(wtPath)) continue;
      const source = path.join(donor, rel);
      if (!nonEmptyDir(source) || !sameBytes(path.join(donor, lock), path.join(wtPath, lock))) continue;
      // Clones only exist within a volume; across one, cp would quietly do a full copy.
      if (fs.statSync(source).dev !== fs.statSync(path.dirname(target)).dev) continue;
      // Clone beside the target and rename in, so a half-finished clone never
      // looks like an installed node_modules.
      const tmp = `${target}.maestro-clone-${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!(await cloneDir(source, tmp))) continue; // donor vanished mid-clone (being offloaded), or no reflink
      fs.renameSync(tmp, target);
      cloned.push(rel);
      break;
    }
  }
  return cloned;
}
