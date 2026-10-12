import type { DiffFile, DiffHunk, GitStatusSummary } from './types';

/**
 * Pure git output parsers, shared by the desktop's git service and the relay
 * (web-desktop-parity spec §9.6: the relay parses the raw `git diff` patch +
 * `git status --porcelain=v2 --branch` the box shim posts), so both sides turn
 * the same patch into the same DiffFile[]. No node imports.
 */

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

/** Parse a unified `git diff` patch into structured DiffFile[]. Handles quoted
 *  (non-ASCII) paths, renames, binary files and "\\ No newline" meta rows. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split('\n');
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLn = 0;
  let newLn = 0;
  let renameFrom: string | null = null;

  const flushFile = () => {
    if (cur) files.push(cur);
    cur = null;
    hunk = null;
    renameFrom = null;
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
      c.status = 'added';
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
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

/** A short status letter (A/M/D/R/U) for the Changes list, from a DiffFile. */
export function statusLetter(status: DiffFile['status']): string {
  return status === 'added' ? 'A' : status === 'deleted' ? 'D' : status === 'renamed' ? 'R' : status === 'binary' ? 'B' : 'M';
}

/**
 * Parse `git status --porcelain=v2 --branch` into a GitStatusSummary. `changed
 * Files`/dirty reflect the working tree; ahead/behind come from the branch header.
 */
export function parsePorcelainV2(text: string): GitStatusSummary {
  let branch = '';
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // "1 XY ..." / "2 XY ..." — XY is the staged/unstaged status pair.
      const xy = line.split(' ')[1] ?? '..';
      if (xy[0] && xy[0] !== '.') staged++;
      if (xy[1] && xy[1] !== '.') unstaged++;
    } else if (line.startsWith('u ')) {
      unstaged++;
    } else if (line.startsWith('? ')) {
      untracked++;
    }
  }
  const changedFiles = staged + unstaged + untracked;
  return { branch, ahead, behind, staged, unstaged, untracked, changedFiles, dirty: changedFiles > 0 };
}
