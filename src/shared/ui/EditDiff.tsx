'use client';
import clsx from 'clsx';
import { highlightLine, langForPath } from './format';

/**
 * Renders a file-editing tool call (Edit / MultiEdit / Write / NotebookEdit) as
 * a red/green diff instead of a raw JSON blob. Reuses the git-diff table styling
 * (`.diff-*` classes) and hljs syntax highlighting from the Review tab.
 */

export interface ParsedEdit {
  file: string;
  /** old→new replacements (Edit/MultiEdit). Empty when it's a whole-file write. */
  hunks: { old: string; new: string }[];
  /** full new contents for Write/NotebookEdit (rendered as all-added). */
  write?: string;
}

interface DiffRow {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  oldN: number | null;
  newN: number | null;
}

export interface BuiltDiff {
  sections: DiffRow[][];
  adds: number;
  dels: number;
  lang: string | null;
}

const EDIT_NAME = /(^|[_-])(edit|multiedit|write|notebook|str.?replace|create.?file|apply.?patch|update.?file)/i;

/** Normalize a tool call's opaque input into an edit shape, or null if it isn't
 *  a file-editing tool. Field-driven (works across harnesses), name-gated only
 *  for whole-file writes to avoid false positives. */
export function parseEditTool(name: string, input: unknown): ParsedEdit | null {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const file = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path) ?? str(i.filePath) ?? '';

  // MultiEdit — an array of {old_string, new_string}.
  if (Array.isArray(i.edits)) {
    const hunks = (i.edits as unknown[])
      .map((e) => (e ?? {}) as Record<string, unknown>)
      .filter((e) => typeof e.old_string === 'string' && typeof e.new_string === 'string')
      .map((e) => ({ old: e.old_string as string, new: e.new_string as string }));
    if (hunks.length) return { file, hunks };
  }

  // Single Edit / str_replace.
  const oldS = str(i.old_string) ?? str(i.old_str) ?? str(i.oldText);
  const newS = str(i.new_string) ?? str(i.new_str) ?? str(i.newText);
  if (oldS !== undefined && newS !== undefined) return { file, hunks: [{ old: oldS, new: newS }] };

  // Whole-file Write / NotebookEdit / create — only when the name looks like a writer.
  const content = str(i.content) ?? str(i.new_source) ?? str(i.file_text);
  if (content !== undefined && EDIT_NAME.test(name)) return { file, hunks: [], write: content };

  return null;
}

/** Split into lines, dropping a single trailing newline's phantom empty line. */
function toLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Line-level LCS diff of old vs new. Falls back to all-del/all-add for very
 *  large blocks so the O(m·n) table can't blow up. */
function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = toLines(oldText);
  const b = toLines(newText);
  const m = a.length;
  const n = b.length;
  const rows: DiffRow[] = [];
  let oldN = 1;
  let newN = 1;

  if (m > 600 || n > 600 || m * n > 200_000) {
    for (const t of a) rows.push({ kind: 'del', text: t, oldN: oldN++, newN: null });
    for (const t of b) rows.push({ kind: 'add', text: t, oldN: null, newN: newN++ });
    return rows;
  }

  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: a[i], oldN, newN });
      i++;
      j++;
      oldN++;
      newN++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: 'del', text: a[i], oldN, newN: null });
      i++;
      oldN++;
    } else {
      rows.push({ kind: 'add', text: b[j], oldN: null, newN });
      j++;
      newN++;
    }
  }
  while (i < m) {
    rows.push({ kind: 'del', text: a[i], oldN, newN: null });
    i++;
    oldN++;
  }
  while (j < n) {
    rows.push({ kind: 'add', text: b[j], oldN: null, newN });
    j++;
    newN++;
  }
  return rows;
}

export function buildEditDiff(edit: ParsedEdit): BuiltDiff {
  const lang = langForPath(edit.file);
  const sections: DiffRow[][] =
    edit.write != null
      ? [toLines(edit.write).map((t, idx) => ({ kind: 'add' as const, text: t, oldN: null, newN: idx + 1 }))]
      : edit.hunks.map((h) => lineDiff(h.old, h.new));
  let adds = 0;
  let dels = 0;
  for (const s of sections) for (const r of s) (r.kind === 'add' && adds++) || (r.kind === 'del' && dels++);
  return { sections, adds, dels, lang };
}

const MAX_ROWS = 400; // per hunk — keep a giant write from rendering thousands of <tr>

export function EditDiff({ diff }: { diff: BuiltDiff }) {
  return (
    <div className="max-h-80 overflow-auto rounded-ctl border bg-bg">
      {diff.sections.map((rows, si) => {
        const shown = rows.slice(0, MAX_ROWS);
        const hidden = rows.length - shown.length;
        return (
          <table key={si} className={clsx('diff-table', si > 0 && 'border-t')}>
            <tbody>
              {shown.map((r, ri) => (
                <tr key={ri} className={clsx(r.kind === 'add' && 'diff-add-row', r.kind === 'del' && 'diff-del-row')}>
                  <td className="diff-gutter">{r.oldN ?? ''}</td>
                  <td className="diff-gutter">{r.newN ?? ''}</td>
                  <td className="diff-code">
                    <span className="select-none pr-1 text-faint">
                      {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
                    </span>
                    <span dangerouslySetInnerHTML={{ __html: highlightLine(r.text, diff.lang) }} />
                  </td>
                </tr>
              ))}
              {hidden > 0 && (
                <tr>
                  <td className="diff-gutter" />
                  <td className="diff-gutter" />
                  <td className="diff-code text-faint">… {hidden} more lines</td>
                </tr>
              )}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}
