'use client';
import clsx from 'clsx';
import { RefreshCw } from 'lucide-react';
import { fmtStat, timeAgo } from '../format';
import type { PanelWorkspace } from './types';

/** Changes tab (web-desktop-parity spec §10.2). */
const FILE_STATUS: Record<string, string> = {
  A: 'text-ok',
  D: 'text-err',
  R: 'text-st-running',
  M: 'text-warn',
  U: 'text-ok',
};

export function ChangesView({
  ws,
  updatedAt,
  onRefresh,
  onOpenFile,
  onCommentsSend,
}: {
  ws: PanelWorkspace;
  updatedAt?: number | null;
  onRefresh: () => void;
  onOpenFile?: (path: string) => void;
  onCommentsSend?: () => void;
}) {
  const git = ws.git;
  const files = git?.files ?? [];
  const openComments = (ws.comments ?? []).filter((c) => !c.resolved);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 px-4 pb-1.5 pt-3 font-mono text-2xs text-faint">
        <span>vs {ws.baseBranch ?? 'base'}</span>
        {git && (
          <span>
            ↑{git.ahead} ↓{git.behind}
          </span>
        )}
        {git && (
          <span>
            {git.staged}s · {git.unstaged}u · {git.untracked}?
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 pb-2">
        {files.length === 0 ? (
          <div className="px-2.5 py-6 text-center text-xs text-muted">No changes yet.</div>
        ) : (
          files.map((f) => (
            <button
              key={f.path}
              className="tap flex w-full items-center gap-2.5 rounded-ctl px-2.5 py-1.5 text-left transition-colors hover:bg-accent-soft"
              onClick={() => onOpenFile?.(f.path)}
            >
              <span className={clsx('w-3 shrink-0 text-center font-mono text-2xs font-medium', FILE_STATUS[f.status] ?? 'text-muted')}>{f.status}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-2xs">
                {f.path.includes('/') && <span className="text-faint">{f.path.slice(0, f.path.lastIndexOf('/') + 1)}</span>}
                {f.path.slice(f.path.lastIndexOf('/') + 1)}
              </span>
              <span className="shrink-0 font-mono text-2xs">
                {f.add > 0 && <span className="text-ok">+{fmtStat(f.add)}</span>}
                {f.add > 0 && f.del > 0 && ' '}
                {f.del > 0 && <span className="text-err">−{fmtStat(f.del)}</span>}
              </span>
            </button>
          ))
        )}
      </div>
      {openComments.length > 0 && (
        <div className="mx-2 mb-2 rounded-card bg-accent-soft px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted">Comments ({openComments.length})</span>
            <span className="flex-1" />
            {onCommentsSend && (
              <button className="btn h-6 px-2.5 text-2xs" onClick={onCommentsSend}>
                Send to agent
              </button>
            )}
          </div>
          <div className="mt-1.5 space-y-1">
            {openComments.map((c) => (
              <div key={c.id} className="text-2xs">
                <span className="font-mono text-faint">
                  {c.file.split('/').pop()}:{c.line}
                </span>{' '}
                <span className="text-muted">{c.body}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 border-t px-4 py-2 text-2xs text-faint">
        {updatedAt ? <span>Updated {timeAgo(updatedAt)}</span> : <span>Not refreshed yet</span>}
        <span className="flex-1" />
        <button className="btn btn-ghost h-6 gap-1 px-2 text-2xs text-muted" onClick={onRefresh}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
    </div>
  );
}
