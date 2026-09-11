'use client';
import React, { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { DiffFile, DiffLine } from '../types';
import { highlightLine, langForPath, fmtStat } from './format';

/**
 * Diff renderer (web-desktop-parity spec §10.4), shared so the web's Diff view
 * matches the desktop's DiffViewer: a collapsible file list, per-file cards with
 * the `.diff-*` table + hljs highlighting, and a large-diff guard.
 */

const STATUS_GLYPH: Record<string, { ch: string; cls: string }> = {
  added: { ch: 'A', cls: 'text-ok' },
  deleted: { ch: 'D', cls: 'text-err' },
  renamed: { ch: 'R', cls: 'text-st-running' },
  modified: { ch: 'M', cls: 'text-warn' },
  binary: { ch: 'B', cls: 'text-muted' },
  untracked: { ch: 'U', cls: 'text-ok' },
};

function StatBadge({ add, del }: { add: number; del: number }) {
  if (!add && !del) return null;
  return (
    <span className="shrink-0 font-mono text-2xs">
      {add > 0 && <span className="text-ok">+{fmtStat(add)}</span>}
      {add > 0 && del > 0 && ' '}
      {del > 0 && <span className="text-err">−{fmtStat(del)}</span>}
    </span>
  );
}

const LARGE = 1500;

/** Pair a hunk's lines into side-by-side (old, new) rows: context aligns on both
 *  sides; a run of deletions pairs with the following run of additions. */
function pairLines(lines: DiffLine[]): { left: DiffLine | null; right: DiffLine | null }[] {
  const out: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === 'context') {
      out.push({ left: l, right: l });
      i++;
    } else {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
      if (n === 0) i++; // safety
    }
  }
  return out;
}

function SplitTable({ file, lang }: { file: DiffFile; lang: string | null }) {
  return (
    <table className="diff-table">
      <tbody>
        {file.hunks.map((h, hi) => (
          <React.Fragment key={hi}>
            {h.header && (
              <tr>
                <td className="diff-gutter" />
                <td className="diff-hunk-header px-2" colSpan={3}>
                  {h.header}
                </td>
              </tr>
            )}
            {pairLines(h.lines).map((p, i) => (
              <tr key={i}>
                <td className={clsx('diff-gutter', p.left?.kind === 'del' && 'diff-del-row')}>{p.left?.oldLine ?? ''}</td>
                <td className={clsx('diff-code', p.left?.kind === 'del' && 'diff-del-row')}>
                  {p.left && <span dangerouslySetInnerHTML={{ __html: highlightLine(p.left.text, lang) }} />}
                </td>
                <td className={clsx('diff-gutter', p.right?.kind === 'add' && 'diff-add-row')}>{p.right?.newLine ?? ''}</td>
                <td className={clsx('diff-code', p.right?.kind === 'add' && 'diff-add-row')}>
                  {p.right && <span dangerouslySetInnerHTML={{ __html: highlightLine(p.right.text, lang) }} />}
                </td>
              </tr>
            ))}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}

function FileDiffCard({
  file,
  defaultOpen,
  onAddComment,
  split,
}: {
  file: DiffFile;
  defaultOpen?: boolean;
  onAddComment?: (file: string, line: number, side: 'old' | 'new', text: string) => void;
  split?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  const [expandLarge, setExpandLarge] = useState(false);
  const [commenting, setCommenting] = useState<{ line: number; side: 'old' | 'new' } | null>(null);
  const [commentText, setCommentText] = useState('');
  const lang = langForPath(file.path);
  const glyph = STATUS_GLYPH[file.status] ?? STATUS_GLYPH.modified;
  const rows: DiffLine[] = file.hunks.flatMap((h) => h.lines);
  const large = rows.length >= LARGE;
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
  const base = file.path.slice(file.path.lastIndexOf('/') + 1);
  return (
    <div className="rounded-card border" data-diff-file={file.path}>
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} className="shrink-0 text-faint" /> : <ChevronRight size={12} className="shrink-0 text-faint" />}
        <span className={clsx('shrink-0 font-mono text-2xs font-semibold', glyph.cls)}>{glyph.ch}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs">
          {dir && <span className="text-faint">{dir}</span>}
          <span>{base}</span>
        </span>
        <StatBadge add={file.additions} del={file.deletions} />
      </button>
      {open && (
        <div className="overflow-x-auto border-t">
          {file.status === 'binary' ? (
            <div className="px-3 py-2 text-2xs text-muted">Binary file</div>
          ) : large && !expandLarge ? (
            <button className="w-full px-3 py-2 text-left text-2xs text-muted hover:text-fg" onClick={() => setExpandLarge(true)}>
              Large diff collapsed ({rows.length} lines) — tap to expand
            </button>
          ) : split ? (
            <SplitTable file={file} lang={lang} />
          ) : (
            <table className="diff-table">
              <tbody>
                {file.hunks.map((h, hi) => (
                  <HunkRows
                    key={hi}
                    lines={h.lines}
                    header={h.header}
                    lang={lang}
                    onGutter={onAddComment ? (line, side) => { setCommenting({ line, side }); setCommentText(''); } : undefined}
                  />
                ))}
              </tbody>
            </table>
          )}
          {commenting && onAddComment && (
            <div className="border-t p-2">
              <div className="mb-1 text-2xs text-faint">Comment on line {commenting.line}</div>
              <textarea
                className="input text-xs"
                rows={2}
                autoFocus
                placeholder="Leave a comment for the agent…"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
              />
              <div className="mt-1 flex justify-end gap-2">
                <button className="btn h-6 px-2 text-2xs" onClick={() => setCommenting(null)}>
                  Cancel
                </button>
                <button
                  className="btn btn-accent h-6 px-2 text-2xs"
                  disabled={!commentText.trim()}
                  onClick={() => {
                    onAddComment(file.path, commenting.line, commenting.side, commentText.trim());
                    setCommenting(null);
                  }}
                >
                  Comment
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HunkRows({
  lines,
  header,
  lang,
  onGutter,
}: {
  lines: DiffLine[];
  header: string;
  lang: string | null;
  onGutter?: (line: number, side: 'old' | 'new') => void;
}) {
  return (
    <>
      {header && (
        <tr>
          <td className="diff-gutter" />
          <td className="diff-gutter" />
          <td className="diff-hunk-header px-2">{header}</td>
        </tr>
      )}
      {lines.map((l, i) => (
        <tr key={i} className={clsx(l.kind === 'add' && 'diff-add-row', l.kind === 'del' && 'diff-del-row')}>
          <td className="diff-gutter" onClick={() => l.oldLine != null && onGutter?.(l.oldLine, 'old')}>
            {l.oldLine ?? ''}
          </td>
          <td className="diff-gutter" onClick={() => (l.newLine ?? l.oldLine) != null && onGutter?.((l.newLine ?? l.oldLine)!, 'new')}>
            {l.newLine ?? ''}
          </td>
          <td className="diff-code">
            <span className="select-none pr-1 text-faint">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <span dangerouslySetInnerHTML={{ __html: highlightLine(l.text, lang) }} />
          </td>
        </tr>
      ))}
    </>
  );
}

/** The whole diff: a header line + one FileDiffCard per file. */
export function DiffView({
  base,
  files,
  emptyBase,
  onAddComment,
  split,
}: {
  base: string;
  files: DiffFile[];
  emptyBase?: string;
  onAddComment?: (file: string, line: number, side: 'old' | 'new', text: string) => void;
  split?: boolean;
}) {
  if (files.length === 0) {
    return (
      <div className="p-6 text-center">
        <div className="text-sm font-medium">Working tree matches the base branch</div>
        <div className="mt-1 text-xs text-muted">No differences between this workspace and {emptyBase || base || 'base'}.</div>
      </div>
    );
  }
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2 px-1 font-mono text-2xs text-muted">
        <span>
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        <StatBadge add={add} del={del} />
        {base && <span className="text-faint">vs {base}</span>}
      </div>
      {files.map((f, i) => (
        <FileDiffCard key={f.path + i} file={f} defaultOpen={files.length <= 5} onAddComment={onAddComment} split={split} />
      ))}
    </div>
  );
}
