import React, { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  Archive,
  Boxes,
  GitBranch,
  GitMerge,
  GitPullRequest,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { useApp } from '../store/app';
import { EmptyHint, Toggle } from './common';
import { RepoIcon } from './Sidebar';
import type { Workspace } from '../../shared/types';

/**
 * Full-panel "Workspaces" browser — a global, searchable index of every branch
 * across all projects, including archived ones (Conductor's Workspaces view).
 * Rows are grouped into relative-time buckets (Today / Yesterday / N days ago)
 * by last activity, and clicking one opens that workspace. Archived branches
 * live here: toggle "Show archived" to reveal them, then restore or delete.
 */
export default function WorkspacesView() {
  const workspaces = useApp((s) => s.workspaces);
  const projects = useApp((s) => s.projects);
  const activeWorkspaceId = useApp((s) => s.activeWorkspaceId);

  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [showArchived, setShowArchived] = useState(() => {
    try {
      return localStorage.getItem('wsShowArchived') === '1';
    } catch {
      return false;
    }
  });
  // Persist the archived toggle so once revealed, archived branches stay revealed
  // across visits (they never silently disappear from the browser).
  useEffect(() => {
    try {
      localStorage.setItem('wsShowArchived', showArchived ? '1' : '0');
    } catch {
      /* ignore persistence failures */
    }
  }, [showArchived]);
  // Recompute relative times on a slow tick so "5m" doesn't go stale on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Esc returns to whatever was open before (or the empty state).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useApp.setState({ showWorkspaces: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { groups, archivedCount } = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Project + search predicate, independent of the archived toggle — so the
    // archived count reflects the same view the user is looking at.
    const matches = (w: Workspace) => {
      if (projectFilter && w.projectId !== projectFilter) return false;
      if (!q) return true;
      const proj = projects.find((p) => p.id === w.projectId)?.name ?? '';
      return (
        (w.title ?? '').toLowerCase().includes(q) ||
        w.branch.toLowerCase().includes(q) ||
        w.name.toLowerCase().includes(q) ||
        proj.toLowerCase().includes(q)
      );
    };
    const matched = workspaces.filter(matches);
    const rows: WsRow[] = matched
      .filter((w) => showArchived || !w.archived)
      .map((w) => ({ w, ts: w.lastUserMessageAt ?? w.createdAt }))
      .sort((a, b) => b.ts - a.ts);

    // Sorted newest-first, so same-bucket rows are contiguous — group by walking.
    const out: { label: string; items: WsRow[] }[] = [];
    for (const row of rows) {
      const label = bucketLabel(dayDiff(now, row.ts));
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(row);
      else out.push({ label, items: [row] });
    }
    return { groups: out, archivedCount: matched.filter((w) => w.archived).length };
  }, [workspaces, projects, projectFilter, showArchived, query, now]);

  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* search + filters (also the window drag strip) */}
      <header className="drag-region flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <div className="no-drag flex min-w-0 flex-1 items-center gap-2">
          <Search size={15} className="shrink-0 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            placeholder="Search workspaces…"
            className="w-full min-w-0 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
          />
        </div>
        <div className="no-drag wco-safe flex shrink-0 items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Project
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="input h-7 w-auto max-w-[160px] !py-0 text-xs"
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <span>Show archived</span>
            {archivedCount > 0 && (
              <span
                className="min-w-[16px] rounded-full bg-raised px-1 text-center text-2xs text-faint"
                title={`${archivedCount} archived workspace${archivedCount === 1 ? '' : 's'}`}
              >
                {archivedCount}
              </span>
            )}
            <Toggle checked={showArchived} onChange={setShowArchived} />
          </label>
        </div>
      </header>

      {/* grouped list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {total === 0 ? (
          <EmptyHint
            icon={<Boxes size={30} strokeWidth={1.5} />}
            title={query ? 'No matching workspaces' : showArchived ? 'No workspaces yet' : 'No active workspaces'}
            body={
              !showArchived && archivedCount > 0
                ? `${archivedCount} archived ${archivedCount === 1 ? 'workspace is' : 'workspaces are'} hidden.`
                : query
                  ? 'Try a different search, or clear the project filter.'
                  : showArchived
                    ? 'Create a workspace to spin up a branch with its own worktree, terminal, and agent.'
                    : 'Every branch you create shows up here. Toggle “Show archived” to see past ones.'
            }
            action={
              !showArchived && archivedCount > 0 ? (
                <button className="btn no-drag" onClick={() => setShowArchived(true)}>
                  Show {archivedCount} archived
                </button>
              ) : undefined
            }
          />
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-4">
              <div className="flex items-center gap-2 px-3 pb-1 pt-1">
                <span className="text-[13px] font-semibold text-muted">{g.label}</span>
                <span className="text-2xs text-faint">{g.items.length}</span>
              </div>
              {g.items.map((row) => (
                <WorkspaceRow key={row.w.id} row={row} now={now} active={row.w.id === activeWorkspaceId} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface WsRow {
  w: Workspace;
  ts: number;
}

function WorkspaceRow({ row, now, active }: { row: WsRow; now: number; active: boolean }) {
  const { w } = row;
  const project = useApp((s) => s.projects.find((p) => p.id === w.projectId));

  const open = () => {
    useApp.getState().selectProject(w.projectId);
    useApp.getState().selectWorkspace(w.id);
  };

  return (
    <div
      className={clsx(
        'group flex cursor-pointer items-center gap-2.5 rounded-ctl px-3 py-2',
        active ? 'bg-accent-soft' : 'hover:bg-accent-soft/50',
        w.archived && 'opacity-70'
      )}
      onClick={open}
      title={w.wsKind === 'in-place' ? 'in-place folder' : w.branch}
    >
      {project && <RepoIcon project={project} active={false} />}
      <StatusGlyph ws={w} />
      <span className="min-w-0 flex-1 truncate text-[13px]">{w.title ?? (w.wsKind === 'in-place' ? w.name : w.branch)}</span>
      {w.archived && (
        <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-2xs text-faint">Archived</span>
      )}
      <div className="flex shrink-0 items-center gap-1.5">
        <div className="hidden items-center gap-0.5 group-hover:flex">
          {w.archived ? (
            <>
              <RowAction
                icon={<RotateCcw size={13} />}
                title="Restore workspace (with chat history)"
                onClick={() => void useApp.getState().restoreWorkspace(w.id)}
              />
              <RowAction
                icon={<Trash2 size={13} />}
                title={w.wsKind === 'in-place' ? 'Remove from Maestro (your folder is not touched)' : 'Delete permanently (removes worktree)'}
                danger
                onClick={() =>
                  useApp.getState().setModal({
                    kind: 'confirm',
                    title: w.wsKind === 'in-place' ? 'Remove workspace' : 'Delete workspace',
                    body:
                      w.wsKind === 'in-place'
                        ? `Remove "${w.name}" from Maestro? Your folder on disk is not touched — only the workspace bookkeeping and its chat history are removed.`
                        : `Permanently delete "${w.name}"? This removes the worktree from disk (git worktree remove) and its chat history. The branch itself is kept in the repo.`,
                    confirmLabel: w.wsKind === 'in-place' ? 'Remove' : 'Delete',
                    danger: true,
                    onConfirm: () => void useApp.getState().deleteWorkspace(w.id),
                  })
                }
              />
            </>
          ) : (
            <RowAction
              icon={<Archive size={13} />}
              title="Archive workspace"
              onClick={() => void useApp.getState().archiveWorkspace(w.id)}
            />
          )}
        </div>
        <span className="w-9 text-right text-2xs tabular-nums text-faint">{shortAgo(now, row.ts)}</span>
      </div>
    </div>
  );
}

function RowAction({
  icon,
  title,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className={clsx('rounded p-1 text-muted', danger ? 'hover:text-err' : 'hover:text-fg')}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {icon}
    </button>
  );
}

/** Leading branch-state glyph, mirroring the sidebar's palette — merged PRs get a
 *  purple merge mark; open PRs a pull-request mark; live branches a tinted fork. */
function StatusGlyph({ ws }: { ws: Workspace }) {
  if (ws.prState === 'MERGED') return <GitMerge size={13} className="shrink-0 text-st-merged" />;
  if (ws.prNumber != null) return <GitPullRequest size={13} className="shrink-0 text-st-running" />;
  if (ws.status === 'needs-attention') return <GitBranch size={13} className="shrink-0 text-st-attention" />;
  if (ws.status === 'running' || ws.status === 'setting-up')
    return <GitBranch size={13} className="shrink-0 pulse-soft text-st-running" />;
  return null;
}

/** Small iOS-style on/off switch. */
// ---------- time helpers ----------

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar-day distance (0 = today, 1 = yesterday, …), so buckets respect
 *  local midnight boundaries rather than raw 24h windows. */
function dayDiff(now: number, ts: number): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
}

function bucketLabel(days: number): string {
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'Last week';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return 'Last month';
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  if (days < 730) return 'Last year';
  return `${Math.floor(days / 365)} years ago`;
}

/** Compact "time since" for the right rail: now / 5m / 3h / 2d / 3w / 5mo / 1y. */
function shortAgo(now: number, ts: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}
