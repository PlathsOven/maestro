import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { highlightLine, langForPath } from '../lib/format';
import { EMPTY_ARR, useApp } from '../store/app';
import { EmptyHint, Segmented, Spinner } from './common';
import type { DiffComment, DiffFile, DiffLine, Workspace } from '../../shared/types';

type ViewMode = 'unified' | 'split';

export default function DiffViewer({ workspace, active }: { workspace: Workspace; active: boolean }) {
  const diff = useApp((s) => s.diffs[workspace.id]);
  const comments = useApp((s) => s.comments[workspace.id]) ?? EMPTY_ARR;
  const wsVersion = useApp((s) => s.wsVersion[workspace.id] ?? 0);
  const [mode, setMode] = useState<ViewMode>('unified');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = async () => {
    setLoading(true);
    await useApp.getState().refreshDiff(workspace.id);
    setLoading(false);
  };

  useEffect(() => {
    if (!active) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void refresh(), diff ? 700 : 0);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, wsVersion, workspace.id]);

  const unresolved = comments.filter((c) => !c.resolved);
  const files = diff?.files ?? [];
  const totalAdd = files.reduce((n, f) => n + f.additions, 0);
  const totalDel = files.reduce((n, f) => n + f.deletions, 0);

  const scrollToFile = (path: string) => {
    setSelected(path);
    fileRefs.current[path]?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="flex h-full">
      {/* file tree */}
      <div className="flex w-60 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-medium">
            {files.length} file{files.length === 1 ? '' : 's'}
          </span>
          <span className="font-mono text-2xs">
            <span className="text-ok">+{totalAdd}</span> <span className="text-err">−{totalDel}</span>
          </span>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {files.map((f) => (
            <button
              key={f.path}
              className={clsx(
                'flex w-full items-center gap-1.5 px-3 py-1 text-left',
                selected === f.path ? 'bg-accent-soft' : 'hover:bg-accent-soft/50'
              )}
              onClick={() => scrollToFile(f.path)}
              title={f.path}
            >
              <StatusGlyph status={f.status} />
              <span className="min-w-0 flex-1 truncate font-mono text-2xs">{f.path}</span>
              {commentsFor(comments, f).length > 0 && (
                <span className="shrink-0 rounded-full bg-accent-soft px-1 text-2xs text-accent">
                  {commentsFor(comments, f).length}
                </span>
              )}
            </button>
          ))}
          {files.length === 0 && !loading && <div className="px-3 py-2 text-xs text-faint">No changes vs {diff?.base}</div>}
        </div>
      </div>

      {/* diff content */}
      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <Segmented<ViewMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'unified', label: 'Unified' },
              { value: 'split', label: 'Split' },
            ]}
          />
          <div className="flex-1" />
          {unresolved.length > 0 && (
            <button
              className="btn h-6 text-2xs"
              title="Attach unresolved comments to the composer"
              onClick={() => useApp.getState().sendCommentsToAgent(workspace.id)}
            >
              <Send size={11} />
              Send {unresolved.length} comment{unresolved.length > 1 ? 's' : ''} to agent
            </button>
          )}
          <button className="btn btn-ghost h-6 px-1.5" title="Refresh diff" onClick={() => void refresh()}>
            {loading ? <Spinner /> : <RefreshCw size={12} className="text-muted" />}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {!diff && (
            <div className="flex h-40 items-center justify-center">
              <Spinner />
            </div>
          )}
          {diff && files.length === 0 && (
            <EmptyHint
              icon={<FileDiff size={30} strokeWidth={1.5} />}
              title="Working tree matches the base branch"
              body={`No differences between this workspace and ${diff.base}.`}
            />
          )}
          <div className="space-y-4 p-4">
            {files.map((f) => (
              <FileDiffCard
                key={f.path + f.status}
                file={f}
                mode={mode}
                workspace={workspace}
                comments={commentsFor(comments, f)}
                refCb={(el) => (fileRefs.current[f.path] = el)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function commentsFor(comments: DiffComment[], f: DiffFile): DiffComment[] {
  return comments.filter((c) => c.file === f.path);
}

function StatusGlyph({ status }: { status: DiffFile['status'] }) {
  const map: Record<DiffFile['status'], [string, string]> = {
    modified: ['M', 'text-warn'],
    added: ['A', 'text-ok'],
    untracked: ['U', 'text-ok'],
    deleted: ['D', 'text-err'],
    renamed: ['R', 'text-st-running'],
    binary: ['B', 'text-muted'],
  };
  const [ch, cls] = map[status];
  return <span className={clsx('w-3 shrink-0 text-center font-mono text-2xs font-bold', cls)}>{ch}</span>;
}

const COLLAPSE_THRESHOLD = 1500;

function FileDiffCard({
  file,
  mode,
  workspace,
  comments,
  refCb,
}: {
  file: DiffFile;
  mode: ViewMode;
  workspace: Workspace;
  comments: DiffComment[];
  refCb: (el: HTMLDivElement | null) => void;
}) {
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lineCount < COLLAPSE_THRESHOLD);
  const [draft, setDraft] = useState<{ line: number; side: 'old' | 'new' } | null>(null);
  const lang = langForPath(file.path);

  return (
    <div ref={refCb} className="card overflow-hidden" style={{ scrollMarginTop: 8 }}>
      <button
        className="flex w-full items-center gap-2 border-b bg-surface px-3 py-2 text-left"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={13} className="text-muted" /> : <ChevronRight size={13} className="text-muted" />}
        <StatusGlyph status={file.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="shrink-0 font-mono text-2xs">
          <span className="text-ok">+{file.additions}</span> <span className="text-err">−{file.deletions}</span>
        </span>
      </button>
      {open &&
        (file.status === 'binary' || file.hunks.length === 0 ? (
          <div className="px-4 py-3 text-xs text-faint">
            {file.status === 'binary' ? 'Binary file' : 'No text diff available'}
          </div>
        ) : mode === 'unified' ? (
          <UnifiedDiff file={file} lang={lang} workspace={workspace} comments={comments} draft={draft} setDraft={setDraft} />
        ) : (
          <SplitDiff file={file} lang={lang} workspace={workspace} comments={comments} draft={draft} setDraft={setDraft} />
        ))}
      {!open && lineCount >= COLLAPSE_THRESHOLD && (
        <div className="px-4 py-2 text-2xs text-faint">Large diff collapsed ({lineCount} lines) — click to expand</div>
      )}
    </div>
  );
}

interface CommentCtx {
  workspace: Workspace;
  file: DiffFile;
  comments: DiffComment[];
  draft: { line: number; side: 'old' | 'new' } | null;
  setDraft: (d: { line: number; side: 'old' | 'new' } | null) => void;
}

function lineComments(ctx: CommentCtx, line: DiffLine): DiffComment[] {
  return ctx.comments.filter((c) =>
    c.side === 'new' ? line.newLine !== null && c.line === line.newLine : line.oldLine !== null && c.line === line.oldLine
  );
}

function UnifiedDiff({
  file,
  lang,
  workspace,
  comments,
  draft,
  setDraft,
}: { file: DiffFile; lang: string | null } & Omit<CommentCtx, 'file'>) {
  const ctx: CommentCtx = { workspace, file, comments, draft, setDraft };
  return (
    <table className="diff-table">
      <tbody>
        {file.hunks.map((h, hi) => (
          <React.Fragment key={hi}>
            <tr className="diff-hunk-header">
              <td className="diff-gutter !cursor-default" colSpan={2} />
              <td className="diff-code py-0.5">{h.header}</td>
            </tr>
            {h.lines.map((l, li) => {
              const cs = lineComments(ctx, l);
              const isDraft =
                draft &&
                ((draft.side === 'new' && l.newLine === draft.line) || (draft.side === 'old' && l.oldLine === draft.line && l.kind === 'del'));
              return (
                <React.Fragment key={li}>
                  <tr className={clsx(l.kind === 'add' && 'diff-add-row', l.kind === 'del' && 'diff-del-row', 'group')}>
                    <td
                      className="diff-gutter"
                      onClick={() => l.oldLine !== null && l.kind === 'del' && setDraft({ line: l.oldLine, side: 'old' })}
                    >
                      {l.oldLine ?? ''}
                    </td>
                    <td
                      className="diff-gutter"
                      title="Comment on this line"
                      onClick={() => {
                        if (l.newLine !== null) setDraft({ line: l.newLine, side: 'new' });
                        else if (l.oldLine !== null) setDraft({ line: l.oldLine, side: 'old' });
                      }}
                    >
                      {l.newLine ?? ''}
                    </td>
                    <td className="diff-code">
                      <span className="select-none pr-1 text-faint">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                      <span dangerouslySetInnerHTML={{ __html: highlightLine(l.text, lang) }} />
                    </td>
                  </tr>
                  {(cs.length > 0 || isDraft) && (
                    <tr>
                      <td colSpan={3} className="!p-0">
                        <CommentThread ctx={ctx} line={l} showDraft={!!isDraft} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === 'context' || l.kind === 'meta') {
      rows.push({ left: l, right: l });
      i++;
    } else if (l.kind === 'del') {
      const dels: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    } else {
      rows.push({ left: null, right: l });
      i++;
    }
  }
  return rows;
}

function SplitDiff({
  file,
  lang,
  workspace,
  comments,
  draft,
  setDraft,
}: { file: DiffFile; lang: string | null } & Omit<CommentCtx, 'file'>) {
  const ctx: CommentCtx = { workspace, file, comments, draft, setDraft };
  return (
    <table className="diff-table">
      <tbody>
        {file.hunks.map((h, hi) => {
          const rows = buildSplitRows(h.lines);
          return (
            <React.Fragment key={hi}>
              <tr className="diff-hunk-header">
                <td className="diff-gutter !cursor-default" />
                <td className="diff-code py-0.5" colSpan={3}>
                  {h.header}
                </td>
              </tr>
              {rows.map((r, ri) => {
                const anchor = r.right ?? r.left;
                const cs = anchor ? lineComments(ctx, anchor) : [];
                const isDraft =
                  draft &&
                  ((r.right && draft.side === 'new' && r.right.newLine === draft.line) ||
                    (r.left && draft.side === 'old' && r.left.oldLine === draft.line && r.left.kind === 'del'));
                return (
                  <React.Fragment key={ri}>
                    <tr>
                      <td
                        className={clsx('diff-gutter', r.left?.kind === 'del' && 'diff-del-row')}
                        onClick={() => r.left?.oldLine != null && setDraft({ line: r.left.oldLine, side: r.left.kind === 'del' ? 'old' : 'new' })}
                      >
                        {r.left?.oldLine ?? ''}
                      </td>
                      <td className={clsx('diff-code w-[calc(50%-42px)] border-r', r.left?.kind === 'del' && 'diff-del-row')}>
                        {r.left && <span dangerouslySetInnerHTML={{ __html: highlightLine(r.left.text, lang) }} />}
                      </td>
                      <td
                        className={clsx('diff-gutter', r.right?.kind === 'add' && 'diff-add-row')}
                        onClick={() => r.right?.newLine != null && setDraft({ line: r.right.newLine, side: 'new' })}
                      >
                        {r.right?.newLine ?? ''}
                      </td>
                      <td className={clsx('diff-code w-[calc(50%-42px)]', r.right?.kind === 'add' && 'diff-add-row')}>
                        {r.right && <span dangerouslySetInnerHTML={{ __html: highlightLine(r.right.text, lang) }} />}
                      </td>
                    </tr>
                    {(cs.length > 0 || isDraft) && anchor && (
                      <tr>
                        <td colSpan={4} className="!p-0">
                          <CommentThread ctx={ctx} line={anchor} showDraft={!!isDraft} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function CommentThread({ ctx, line, showDraft }: { ctx: CommentCtx; line: DiffLine; showDraft: boolean }) {
  const cs = lineComments(ctx, line);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (showDraft) inputRef.current?.focus();
  }, [showDraft]);

  const submit = async () => {
    if (!text.trim() || !ctx.draft) return;
    const res = await tryInvoke('comment:add', {
      workspaceId: ctx.workspace.id,
      file: ctx.file.path,
      line: ctx.draft.line,
      side: ctx.draft.side,
      body: text.trim(),
    });
    if (res.error) useApp.getState().toast('error', res.error);
    setText('');
    ctx.setDraft(null);
    void useApp.getState().refreshComments(ctx.workspace.id);
  };

  return (
    <div className="border-y bg-bg px-4 py-2 font-sans">
      {cs.map((c) => (
        <div key={c.id} className={clsx('mb-1.5 flex items-start gap-2 text-xs', c.resolved && 'opacity-50')}>
          <MessageSquarePlus size={12} className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <span className={clsx(c.resolved && 'line-through')}>{c.body}</span>
          </div>
          <button
            className="shrink-0 text-faint hover:text-ok"
            title={c.resolved ? 'Unresolve' : 'Resolve'}
            onClick={async () => {
              await tryInvoke('comment:resolve', { commentId: c.id, resolved: !c.resolved });
              void useApp.getState().refreshComments(ctx.workspace.id);
            }}
          >
            <Check size={12} className={c.resolved ? 'text-ok' : ''} />
          </button>
          <button
            className="shrink-0 text-faint hover:text-err"
            title="Delete comment"
            onClick={async () => {
              await tryInvoke('comment:delete', { commentId: c.id });
              void useApp.getState().refreshComments(ctx.workspace.id);
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {showDraft && (
        <div className="flex items-start gap-2">
          <textarea
            ref={inputRef}
            className="input min-h-[52px] flex-1 text-xs"
            placeholder="Leave a comment for the agent…  (⌘↵ to save)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
              if (e.key === 'Escape') ctx.setDraft(null);
            }}
          />
          <div className="flex flex-col gap-1">
            <button className="btn btn-accent h-6 text-2xs" onClick={() => void submit()} disabled={!text.trim()}>
              Comment
            </button>
            <button className="btn h-6 text-2xs" onClick={() => ctx.setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
