import fs from 'fs';
import path from 'path';
import { localHost } from '../hosts/local';
import type { ExecHost } from '../hosts/types';
import type { AttachmentPreview, FileReadResult, FsEntry } from '../../shared/types';

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};

const MAX_IMAGE = 25 * 1024 * 1024; // inline as a data: URL up to here
const MAX_TEXT = 2 * 1024 * 1024; // chat-attachment preview text up to here
const MAX_EDIT_TEXT = 5 * 1024 * 1024; // editable buffer text up to here (fs:read)
// Notebooks aren't loaded into one Monaco buffer — they're parsed as JSON and
// rendered cell-by-cell, and their size is dominated by output data (base64
// plots, HTML tables), not editable text. So they get a much higher cap than
// plain text; only pathologically huge ones fall back to the system app.
const MAX_NOTEBOOK = 25 * 1024 * 1024;

/**
 * Read a worktree-relative attachment for in-app preview, on the project's host.
 * Images come back as a `data:` URL; text as UTF-8; anything else (binary, too
 * big, missing, or outside the worktree) as `kind: 'binary'` so the renderer
 * falls back to opening it in the OS default app.
 *
 * Images also carry a `version` (mtime + size); pass it back as `ifVersion` and
 * an unchanged image answers `{ unchanged: true }` after just the stat, so the
 * renderer can cheaply re-check a cached image an agent may have overwritten.
 */
export async function readAttachment(
  worktreePath: string,
  relPath: string,
  host: ExecHost = localHost,
  ifVersion?: string
): Promise<AttachmentPreview> {
  const abs = safeResolve(worktreePath, relPath, host);
  const name = host.path.basename(relPath);
  if (!abs) return { kind: 'binary', name, error: 'Path is outside the workspace' };
  let stat: { size: number; mtimeMs: number; dir: boolean };
  try {
    stat = await host.fs.stat(abs);
  } catch {
    return { kind: 'binary', name, error: 'File not found' };
  }
  if (stat.dir) return { kind: 'binary', name, error: 'Not a file' };

  const ext = host.path.extname(abs).slice(1).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime) {
    if (stat.size > MAX_IMAGE) return { kind: 'binary', name, error: 'Image too large to preview' };
    const version = `${stat.mtimeMs}:${stat.size}`;
    if (ifVersion === version) return { kind: 'image', name, version, unchanged: true };
    try {
      const b64 = (await host.fs.read(abs)).toString('base64');
      return { kind: 'image', dataUrl: `data:${mime};base64,${b64}`, name, version };
    } catch {
      return { kind: 'binary', name, error: 'Could not read image' };
    }
  }

  if (stat.size > MAX_TEXT) return { kind: 'binary', name };
  let buf: Buffer;
  try {
    buf = await host.fs.read(abs);
  } catch {
    return { kind: 'binary', name, error: 'Could not read file' };
  }
  // A NUL byte in the first 8KB is a reliable "this is binary" signal.
  if (buf.subarray(0, 8192).includes(0)) return { kind: 'binary', name };
  return { kind: 'text', text: buf.toString('utf8'), name };
}

/**
 * Resolve `relPath` (relative to the worktree root) to an absolute path,
 * confined to the worktree. Returns null on any escape attempt (`..`, an
 * absolute path, …) so callers can't read or open files outside the workspace.
 * Uses the host's path math (POSIX for remote) so the confinement check is
 * correct for the target OS, not the laptop's.
 */
export function safeResolve(worktreePath: string, relPath: string, host: ExecHost = localHost): string | null {
  const p = host.path;
  const root = p.resolve(worktreePath);
  const abs = p.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + p.sep)) return null;
  return abs;
}

/**
 * Second line of defense past `safeResolve` for the editor's read/write paths: a
 * symlink *inside* the worktree can still point outside it. Realpath the nearest
 * existing path at or above `probe` and confirm it stays within the (realpath'd)
 * worktree root — so a link escaping the tree is refused even though its textual
 * path looks contained.
 */
function containedReal(worktreePath: string, probe: string): boolean {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(worktreePath));
  } catch {
    return false;
  }
  let cur = probe;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return real === root || real.startsWith(root + path.sep);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return false; // walked past the filesystem root
      cur = up;
    }
  }
}

/**
 * Read a worktree file for the in-app editor. Like `readAttachment` but with the
 * mtime attached (for conflict detection), a 5 MB text cap, and `.ipynb` always
 * returned as text (the renderer parses it into a notebook). Images come back as
 * a `data:` URL; binary / oversized / unreadable files fall back to the "open in
 * system app" card.
 */
export function readFile(worktreePath: string, relPath: string): FileReadResult {
  const abs = safeResolve(worktreePath, relPath);
  const name = path.basename(relPath);
  if (!abs || !containedReal(worktreePath, abs)) {
    return { kind: 'binary', name, error: 'Path is outside the workspace' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { kind: 'binary', name, error: 'File not found' };
  }
  if (!stat.isFile()) return { kind: 'binary', name, error: 'Not a file' };

  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime) {
    if (stat.size > MAX_IMAGE) return { kind: 'binary', name, size: stat.size, error: 'Image too large to preview' };
    try {
      const b64 = fs.readFileSync(abs).toString('base64');
      return { kind: 'image', dataUrl: `data:${mime};base64,${b64}`, name };
    } catch {
      return { kind: 'binary', name, size: stat.size, error: 'Could not read image' };
    }
  }

  const isNotebook = ext === 'ipynb';
  if (stat.size > (isNotebook ? MAX_NOTEBOOK : MAX_EDIT_TEXT)) {
    return {
      kind: 'binary',
      name,
      size: stat.size,
      error: isNotebook ? 'Notebook is too large to open (over 25 MB)' : 'File is too large to edit (over 5 MB)',
    };
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return { kind: 'binary', name, size: stat.size, error: 'Could not read file' };
  }
  // A NUL byte in the first 8KB is a reliable "this is binary" signal — but a
  // notebook is always returned as text so the renderer can parse it.
  if (ext !== 'ipynb' && buf.subarray(0, 8192).includes(0)) return { kind: 'binary', name, size: stat.size };
  return { kind: 'text', text: buf.toString('utf8'), mtimeMs: stat.mtimeMs, size: stat.size };
}

/** Cheap mtime/size probe — gates the editor's watcher-driven live reload so an
 *  unchanged open file costs one `stat`, not a full re-read. */
export function statFile(worktreePath: string, relPath: string): { mtimeMs: number; size: number } | null {
  const abs = safeResolve(worktreePath, relPath);
  if (!abs || !containedReal(worktreePath, abs)) return null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * Write a worktree file from the editor. Confined to the worktree (safeResolve +
 * realpath), atomic (temp file in the same dir → rename over, preserving the
 * original mode), and guarded by mtime: if the file changed on disk since the
 * buffer last synced (`expectedMtimeMs`), or a file appeared where we expected to
 * create one, the write is refused as a conflict unless `force`. The buffer text
 * is written verbatim — no EOL normalization, no trailing-newline insertion.
 */
export function writeFile(
  worktreePath: string,
  relPath: string,
  text: string,
  expectedMtimeMs: number | null,
  force?: boolean
): { ok: true; mtimeMs: number } | { ok: false; conflict: true; mtimeMs: number } {
  const abs = safeResolve(worktreePath, relPath);
  if (!abs) throw new Error('Path is outside the workspace');
  // The containing directory must resolve inside the worktree, and we never
  // write *through* a symlink (rename-over would clobber a link target).
  if (!containedReal(worktreePath, path.dirname(abs))) throw new Error('Path is outside the workspace');

  let cur: fs.Stats | null = null;
  try {
    const lst = fs.lstatSync(abs);
    if (lst.isSymbolicLink()) throw new Error('Refusing to write through a symlink');
    cur = lst;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // missing file → we'll create it
  }

  if (cur && !force && (expectedMtimeMs === null || cur.mtimeMs !== expectedMtimeMs)) {
    // Disk moved out from under the buffer (agent wrote it, or it appeared where
    // we expected to create). Surfaced as the "changed on disk" banner.
    return { ok: false, conflict: true, mtimeMs: cur.mtimeMs };
  }

  const tmp = abs + '.maestro-tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.chmodSync(tmp, (cur?.mode ?? 0o644) & 0o777);
    fs.renameSync(tmp, abs);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw e;
  }
  return { ok: true, mtimeMs: fs.statSync(abs).mtimeMs };
}

/**
 * Create a new, empty file (or a folder, when `dir`) in the worktree for the
 * Files tab's "+" button. Missing parent folders are created along the way.
 * Confined like `writeFile` (safeResolve + realpath of the nearest existing
 * ancestor), and never overwrites: an existing entry at `relPath` is an error.
 */
export function createEntry(worktreePath: string, relPath: string, dir: boolean): void {
  const abs = safeResolve(worktreePath, relPath);
  if (!abs) throw new Error('Path is outside the workspace');
  if (!containedReal(worktreePath, path.dirname(abs))) throw new Error('Path is outside the workspace');
  if (fs.existsSync(abs)) throw new Error(`${relPath} already exists`);
  fs.mkdirSync(dir ? abs : path.dirname(abs), { recursive: true });
  if (!dir) fs.writeFileSync(abs, '');
}

/**
 * Resolve a worktree-relative path for a mutating Files-tab action (rename,
 * move, copy, trash): confined like `createEntry`, and never the worktree root.
 * Only the *parent* is realpath-checked, so a symlink inside the tree is
 * moved/removed as a link rather than followed out of the workspace.
 */
export function entryPath(worktreePath: string, relPath: string): string {
  const abs = safeResolve(worktreePath, relPath);
  if (!abs || abs === path.resolve(worktreePath) || !containedReal(worktreePath, path.dirname(abs))) {
    throw new Error('Path is outside the workspace');
  }
  return abs;
}

/** lstat-based existence, so a dangling symlink still counts. */
function exists(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename or move an entry within the worktree. Missing destination parents are
 * created; never overwrites, except a case-only rename of the same entry (same
 * inode on a case-insensitive filesystem). A folder can't move into itself.
 */
export function renameEntry(worktreePath: string, from: string, to: string): void {
  const src = entryPath(worktreePath, from);
  const dest = entryPath(worktreePath, to);
  if (src === dest) return;
  if (!exists(src)) throw new Error(`${from} no longer exists`);
  if (dest.startsWith(src + path.sep)) throw new Error('Cannot move a folder into itself');
  if (exists(dest)) {
    const [a, b] = [fs.lstatSync(src), fs.lstatSync(dest)];
    if (a.ino !== b.ino || a.dev !== b.dev) throw new Error(`${path.basename(to)} already exists in that folder`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
}

/**
 * Copy entries (recursively; symlinks as links) into `toDir` ('' = root) for
 * Duplicate, Copy → Paste and drops from the OS file manager — `paths` are
 * worktree-relative, or absolute for those OS drops. A taken name gets a
 * Finder-style suffix (`a copy.ts`, `a copy 2.ts`). Returns the new paths.
 */
export function copyEntries(worktreePath: string, paths: string[], toDir: string): string[] {
  const root = path.resolve(worktreePath);
  const destDir = toDir ? entryPath(worktreePath, toDir) : root;
  return paths.map((p) => {
    const src = path.isAbsolute(p) ? path.resolve(p) : entryPath(worktreePath, p);
    if (!exists(src)) throw new Error(`${path.basename(p)} no longer exists`);
    if (destDir === src || destDir.startsWith(src + path.sep)) throw new Error('Cannot copy a folder into itself');
    const name = path.basename(src);
    const dot = fs.lstatSync(src).isDirectory() ? -1 : name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let dest = path.join(destDir, name);
    for (let i = 1; exists(dest); i++) dest = path.join(destDir, `${stem} copy${i > 1 ? ` ${i}` : ''}${ext}`);
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    return path.relative(root, dest).split(path.sep).join('/');
  });
}

/**
 * List one directory of a workspace's working tree for the "All files" browser,
 * on the project's host. Unlike `git ls-files`, this is the real on-disk tree —
 * ignored and untracked entries (node_modules, dist, .git, .context, …) are
 * included so it mirrors what's actually on disk. Loaded lazily one directory at
 * a time. Sorted folders-first, then case-insensitively by name.
 */
export async function listDir(worktreePath: string, relPath: string, host: ExecHost = localHost): Promise<FsEntry[]> {
  const abs = safeResolve(worktreePath, relPath, host);
  if (!abs) return [];
  let entries: FsEntry[];
  try {
    entries = await host.fs.readdir(abs);
  } catch {
    return []; // path is not a directory, or is unreadable
  }
  entries.sort((a, b) =>
    a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
  return entries.slice(0, 5000);
}
