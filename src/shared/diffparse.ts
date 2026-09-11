import type { DiffFile, DiffHunk, DiffLine, GitStatusSummary } from './types';

/**
 * Pure parsers for the box-side git report (web-desktop-parity spec §9.6): the
 * relay can't use the main-process git module, so it parses the raw `git diff`
 * patch + `git status --porcelain=v2 --branch` the box shim posts. Shared so a
 * test (and any other consumer) uses one implementation. No node imports.
 */

function stripPrefix(p: string): string {
  if (p === '/dev/null') return p;
  return p.replace(/^[ab]\//, '');
}

const STATUS_FROM_LETTER: Record<string, DiffFile['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'modified',
  U: 'modified',
  T: 'modified',
};

/** Parse a unified `git diff base...HEAD` patch into structured DiffFile[]. */
export function parseUnifiedDiff(patch: string, base = ''): { base: string; files: DiffFile[] } {
  const files: DiffFile[] = [];
  const lines = patch.split('\n');
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const pushHunk = () => {
    if (cur && hunk) cur.hunks.push(hunk);
    hunk = null;
  };
  const pushFile = () => {
    pushHunk();
    if (cur) files.push(cur);
    cur = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      pushFile();
      const m = /^diff --git (.+) (.+)$/.exec(line);
      const newPath = m ? stripPrefix(m[2]) : '';
      cur = { path: newPath, oldPath: null, status: 'modified', additions: 0, deletions: 0, hunks: [] };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) {
      cur.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length).trim();
      cur.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.path = line.slice('rename to '.length).trim();
      continue;
    }
    if (line.startsWith('Binary files')) {
      cur.status = cur.status === 'added' ? 'added' : cur.status === 'deleted' ? 'deleted' : 'binary';
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4).trim());
      if (p !== '/dev/null' && cur.oldPath == null && cur.status !== 'renamed') cur.oldPath = p === cur.path ? null : p;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4).trim());
      if (p !== '/dev/null') cur.path = p;
      continue;
    }
    if (line.startsWith('@@')) {
      pushHunk();
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      oldLine = m ? Number(m[1]) : 0;
      newLine = m ? Number(m[2]) : 0;
      hunk = { header: line, lines: [] };
      continue;
    }
    if (!hunk) continue;
    const kind = line[0];
    const text = line.slice(1);
    if (kind === '+') {
      hunk.lines.push({ kind: 'add', oldLine: null, newLine, text });
      newLine++;
      cur.additions++;
    } else if (kind === '-') {
      hunk.lines.push({ kind: 'del', oldLine, newLine: null, text });
      oldLine++;
      cur.deletions++;
    } else if (kind === ' ') {
      hunk.lines.push({ kind: 'context', oldLine, newLine, text });
      oldLine++;
      newLine++;
    } else if (kind === '\\') {
      // "\ No newline at end of file" — ignore.
    }
  }
  pushFile();
  return { base, files };
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

/** Type re-exports for consumers that only import from here. */
export type { DiffFile, DiffLine, DiffHunk, GitStatusSummary };
