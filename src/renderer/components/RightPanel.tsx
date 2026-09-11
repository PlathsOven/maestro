import React, { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Activity,
  Archive,
  Braces,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FastForward,
  File,
  FileCode,
  FileImage,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompare,
  GitMerge,
  GitPullRequest,
  History,
  ListChecks,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Sparkles,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { MenuDivider, MenuItem } from './Sidebar';
import { useDismiss } from './common';
import { invoke, tryInvoke } from '../lib/api';
import { timeAgo, basename, fmtStat } from '../lib/format';
import { mergeabilityUnknown, mergeFailureMessage } from '../lib/resolveConflicts';
import { DEFAULT_TERM_IDS, EMPTY_ARR, useApp, useCaps, useShowPr, LAYOUT_LIMITS, DEFAULT_LAYOUT } from '../store/app';
import { TodoSection } from './ChecksPanel';
import ChecksPanel from './ChecksPanel';
import { Resizer, Spinner } from './common';
import RunPanel from './RunPanel';
import SkillsPanel from './SkillsPanel';
import StatusPanel from './StatusPanel';
import PtyView from './TerminalPanel';
import type { ContextFile, DiffFile, FsEntry, PrStatus, Workspace } from '../../shared/types';

export default function RightPanel({ workspace }: { workspace: Workspace }) {
  const rightTab = useApp((s) => s.rightTab[workspace.id] ?? 'status');
  const gitStatus = useApp((s) => s.gitStatus[workspace.id]);
  const pr = useApp((s) => s.prStatus[workspace.id]);
  const wsVersion = useApp((s) => s.wsVersion[workspace.id] ?? 0);
  const rightW = useApp((s) => s.layout.right);
  const collapsed = useApp((s) => s.settings.rightPanelCollapsed);
  const caps = useCaps(workspace.projectId);
  const showPr = useShowPr(workspace.projectId);
  // Diff/Changes surfaces: real git, or a folder project's shadow checkpoints.
  const showDiff = caps.git || caps.checkpoints;
  const debRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    // No diff source (plain remote folder) — skip the probes entirely.
    if (!showDiff) return;
    clearTimeout(debRef.current);
    debRef.current = setTimeout(() => {
      void useApp.getState().refreshGit(workspace.id);
      // keep the top-strip diff stat (and the Create PR enabled state) in sync
      useApp.getState().refreshDiffStat(workspace.id);
      if ((useApp.getState().rightTab[workspace.id] ?? 'status') === 'changes') {
        void useApp.getState().refreshDiff(workspace.id);
      }
    }, 500);
    return () => clearTimeout(debRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsVersion, workspace.id, rightTab, showDiff]);

  useEffect(() => {
    // PR status only makes sense with a github origin + authenticated gh.
    if (showPr) void useApp.getState().refreshPr(workspace.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, showPr]);

  if (collapsed) return <CollapsedRightPanel workspace={workspace} />;

  return (
    <aside className="relative flex shrink-0 flex-col border-l bg-canvas" style={{ width: rightW }}>
      <Resizer
        axis="x"
        invert
        size={rightW}
        min={LAYOUT_LIMITS.right.min}
        max={LAYOUT_LIMITS.right.max}
        resetTo={DEFAULT_LAYOUT.right}
        onResize={(w) => useApp.getState().setLayout({ right: w })}
        onCommit={() => useApp.getState().commitLayout()}
        className="-left-1"
      />
      {/* top strip: the PR lifecycle action (Create PR → Merge → Continue/Archive),
          right-aligned in the otherwise-empty title-bar row and washed with the PR
          state color so it's unmissable once a PR exists. */}
      <div
        className={clsx(
          'drag-region flex h-11 shrink-0 items-center justify-end gap-2 overflow-hidden px-3',
          headerPrTone(pr)
        )}
      >
        {/* .wco-safe keeps these clear of the Windows window-control overlay,
            which is painted over this exact corner of the window. */}
        <div className="no-drag wco-safe flex min-w-0 items-center gap-2">
          {/* PR lifecycle needs a github origin + gh auth; below that it's just
              Archive (the folder/remoteless projects that lost dead PR chrome). */}
          {showPr ? <PrActions workspace={workspace} /> : <ArchiveAction workspace={workspace} />}
        </div>
      </div>

      {/* tabs: Status | Files | [Changes] | [Checks] | Skills · [Review] */}
      <div className="flex shrink-0 items-center gap-1 border-b px-3 pb-2">
        <button
          className="shrink-0 rounded-ctl p-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg"
          title="Collapse panel"
          onClick={() => void useApp.getState().saveSettings({ rightPanelCollapsed: true })}
        >
          <PanelRightClose size={15} />
        </button>
        {(
          [
            { id: 'status', label: 'Status', badge: 0, show: true },
            { id: 'files', label: 'Files', badge: 0, show: true },
            { id: 'changes', label: 'Changes', badge: gitStatus?.changedFiles || 0, show: showDiff },
            { id: 'checks', label: 'Checks', badge: 0, show: showPr },
            { id: 'skills', label: 'Skills', badge: 0, show: true },
          ] as const
        )
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              className={clsx(
                'flex items-center gap-1.5 whitespace-nowrap rounded-ctl px-2 py-1 text-xs font-medium transition-colors',
                rightTab === t.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
              )}
              onClick={() => useApp.getState().setRightTab(workspace.id, t.id)}
            >
              {t.label}
              {t.badge > 0 && <span className="rounded-full bg-border px-1.5 text-2xs text-muted">{t.badge}</span>}
            </button>
          ))}
        <div className="flex-1" />
        {showDiff && (
          <button
            className="btn h-6 gap-1.5 text-2xs"
            title="Review the diff (⌘⇧D)"
            onClick={() => useApp.getState().setTab(workspace.id, 'diff')}
          >
            <Eye size={12} />
            Review
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Guard each tab's content on its capability so a stale rightTab (e.g.
            'checks' left over from a git project) falls back to Status. */}
        {rightTab === 'files' ? (
          <FilesTab workspace={workspace} />
        ) : rightTab === 'changes' && showDiff ? (
          <ChangesTab workspace={workspace} />
        ) : rightTab === 'skills' ? (
          <SkillsPanel workspace={workspace} />
        ) : rightTab === 'checks' && showPr ? (
          <ChecksPanel workspace={workspace} active />
        ) : (
          <StatusPanel workspace={workspace} />
        )}
      </div>

      <Dock workspace={workspace} />
    </aside>
  );
}

/** Thin icon-only rail shown when the right panel is collapsed — mirrors the
 *  collapsed sidebar. An expand toggle up top, quick tab shortcuts (each expands
 *  the panel to that tab), and a Review button at the bottom. */
function CollapsedRightPanel({ workspace }: { workspace: Workspace }) {
  const rightTab = useApp((s) => s.rightTab[workspace.id] ?? 'status');
  const changed = useApp((s) => s.gitStatus[workspace.id]?.changedFiles ?? 0);
  const caps = useCaps(workspace.projectId);
  const showPr = useShowPr(workspace.projectId);

  const expand = (tab?: 'status' | 'files' | 'changes' | 'checks' | 'skills') => {
    if (tab) useApp.getState().setRightTab(workspace.id, tab);
    void useApp.getState().saveSettings({ rightPanelCollapsed: false });
  };

  const tabs = (
    [
      { id: 'status', label: 'Status', Icon: Activity, show: true },
      { id: 'files', label: 'Files', Icon: Folder, show: true },
      { id: 'changes', label: 'Changes', Icon: GitCompare, show: caps.git || caps.checkpoints },
      { id: 'checks', label: 'Checks', Icon: ListChecks, show: showPr },
      { id: 'skills', label: 'Skills', Icon: Sparkles, show: true },
    ] as const
  ).filter((t) => t.show);

  return (
    // w-12 must stay in sync with COLLAPSED_RIGHT_RAIL (store/app.ts).
    <aside className="relative flex w-12 shrink-0 flex-col items-center border-l bg-canvas">
      <div className="drag-region h-11 w-full shrink-0" />
      {/* primary PR action, shrunk to an icon button that mirrors the expanded
          panel's top-right Create PR / Merge control (hidden without PR caps). */}
      {showPr && <CollapsedPrButton workspace={workspace} />}
      <button
        className="no-drag mb-1 mt-0.5 rounded-ctl p-1.5 text-muted transition-colors hover:bg-accent-soft hover:text-fg"
        title="Expand panel"
        onClick={() => expand()}
      >
        <PanelRightOpen size={16} />
      </button>
      <div className="mb-1 w-6 border-t" />
      <div className="flex flex-col items-center gap-0.5">
        {tabs.map((t) => {
          const Icon = t.Icon;
          return (
            <button
              key={t.id}
              className={clsx(
                'no-drag relative rounded-ctl p-1.5 transition-colors',
                rightTab === t.id ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-accent-soft hover:text-fg'
              )}
              title={t.label}
              onClick={() => expand(t.id)}
            >
              <Icon size={16} />
              {t.id === 'changes' && changed > 0 && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

// ---------------- PR lifecycle actions (top strip + collapsed rail) ----------------

/**
 * Background wash for the right panel's top strip, keyed off the PR lifecycle so
 * its state (and the matching action button) reads at a glance. No tint before a
 * PR exists — the plain "Create PR" state stays neutral so the color only ever
 * signals something actionable.
 */
function headerPrTone(pr: PrStatus | null | undefined): string {
  if (!pr) return '';
  if (pr.state === 'MERGED') return 'pr-tone-merged';
  if (pr.state === 'CLOSED') return 'pr-tone-closed';
  if (pr.mergeable === 'CONFLICTING') return 'pr-tone-conflict';
  if (pr.isDraft) return '';
  return 'pr-tone-ready';
}

/**
 * Is there anything worth opening a PR for? Any line diff, any working-tree
 * change, or any commit already ahead of the base branch. Drives whether the
 * Create PR action is enabled — when there's nothing to ship it's dimmed.
 */
function useHasChanges(workspaceId: string): boolean {
  const stat = useApp((s) => s.diffStats[workspaceId]);
  const git = useApp((s) => s.gitStatus[workspaceId]);
  const lines = (stat?.additions ?? 0) + (stat?.deletions ?? 0);
  return lines > 0 || (!!git && (git.changedFiles > 0 || git.ahead > 0));
}

/** `+adds −dels` vs the base branch, shown beside the Create PR button. */
function DiffStatBadge({ workspace }: { workspace: Workspace }) {
  const stat = useApp((s) => s.diffStats[workspace.id]);
  if (!stat || (stat.additions === 0 && stat.deletions === 0)) return null;
  return (
    <span
      className="shrink-0 font-mono text-2xs"
      title={`+${stat.additions} −${stat.deletions} lines vs base branch`}
    >
      <span className="text-ok">+{fmtStat(stat.additions)}</span>{' '}
      <span className="text-err">−{fmtStat(stat.deletions)}</span>
    </span>
  );
}

function PanelIconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="shrink-0 rounded-ctl p-1.5 text-muted transition-colors hover:bg-accent-soft hover:text-fg" title={title} onClick={onClick}>
      {children}
    </button>
  );
}

/** Top-strip action for projects without PR affordances (folder / remoteless /
 *  gh-unauthenticated): just Archive — the workspace-level action that always
 *  applies. */
function ArchiveAction({ workspace }: { workspace: Workspace }) {
  return (
    <PanelIconBtn title="Archive workspace" onClick={() => void useApp.getState().archiveWorkspace(workspace.id)}>
      <Archive size={13} />
    </PanelIconBtn>
  );
}

/**
 * PR-state-aware action group living in the right panel's top strip. Before a PR
 * exists it's the one-click "Create PR" (with the line diff beside it, dimmed when
 * there's nothing to ship); once one is open it becomes Merge (or Resolve
 * conflicts); after it merges/closes it becomes Continue + Archive.
 */
function PrActions({ workspace }: { workspace: Workspace }) {
  const pr = useApp((s) => s.prStatus[workspace.id]);
  const creatingPr = useApp((s) => s.creatingPr[workspace.id] ?? false);
  const hasChanges = useHasChanges(workspace.id);

  const archiveIcon = (
    <PanelIconBtn title="Archive workspace" onClick={() => void useApp.getState().archiveWorkspace(workspace.id)}>
      <Archive size={13} />
    </PanelIconBtn>
  );

  // undefined = PR status still loading, null = no PR — both keep Create PR.
  if (!pr) {
    return (
      <>
        {archiveIcon}
        <DiffStatBadge workspace={workspace} />
        <button
          className="btn h-7 shrink-0 gap-1.5 px-2.5 text-xs"
          title={hasChanges ? 'Commit all changes & create pull request (⌘⇧P)' : 'No changes yet — nothing to open a pull request for'}
          disabled={creatingPr || !hasChanges}
          onClick={() => void useApp.getState().createPr(workspace.id)}
        >
          {creatingPr ? <Spinner /> : <GitPullRequest size={12} />}
          {creatingPr ? 'Creating…' : 'Create PR'}
        </button>
      </>
    );
  }

  if (pr.state === 'MERGED') {
    return (
      <>
        <PrBadge pr={pr} />
        <ContinueButton workspace={workspace} />
        <button
          className="btn btn-merged h-7 shrink-0 gap-1.5 px-2.5 text-xs"
          title="Archive this workspace"
          onClick={() => void useApp.getState().archiveWorkspace(workspace.id)}
        >
          <Archive size={12} />
          Archive
        </button>
      </>
    );
  }

  if (pr.state === 'CLOSED') {
    return (
      <>
        <PrBadge pr={pr} />
        <button
          className="btn btn-accent h-7 shrink-0 gap-1.5 px-2.5 text-xs"
          title="Archive this workspace"
          onClick={() => void useApp.getState().archiveWorkspace(workspace.id)}
        >
          <Archive size={12} />
          Archive
        </button>
      </>
    );
  }

  // OPEN — merge when clean, otherwise hand the conflicts to the agent.
  return (
    <>
      {archiveIcon}
      <PrBadge pr={pr} />
      {pr.mergeable === 'CONFLICTING' ? (
        <ResolveConflictsButton workspace={workspace} pr={pr} />
      ) : (
        <MergeButton workspace={workspace} pr={pr} />
      )}
    </>
  );
}

/**
 * The conflicted-PR action: instead of punting to GitHub's web editor, dispatch
 * the workspace's agent to merge the base and resolve the markers (spec §4.1).
 * Reads "Resolving…" while the agent works. The shell fallback has no agent to
 * dispatch to (the prompt would run as shell syntax), so it keeps today's link.
 */
function ResolveConflictsButton({ workspace, pr }: { workspace: Workspace; pr: PrStatus }) {
  const resolving = useApp((s) => !!s.resolvingPr[workspace.id]);
  const base = pr.baseRefName || 'the base branch';
  const cls = 'btn h-7 shrink-0 gap-1.5 px-2.5 text-xs border-warn/50 text-warn hover:bg-warn/10';

  if (workspace.harness === 'shell') {
    return (
      <a
        className={cls}
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title="This PR has merge conflicts — open it on GitHub to resolve"
      >
        <GitMerge size={12} />
        Resolve conflicts
      </a>
    );
  }

  return (
    <button
      className={cls}
      disabled={resolving}
      title={
        resolving
          ? 'The agent is resolving the conflicts…'
          : `Merge conflicts with ${base} — send the agent to resolve them`
      }
      onClick={() => void useApp.getState().startConflictResolution(workspace.id)}
    >
      {resolving ? <Spinner /> : <GitMerge size={12} />}
      {resolving ? 'Resolving…' : 'Resolve conflicts'}
    </button>
  );
}

/** Clickable PR pill: number + external link + colored state label. */
function PrBadge({ pr }: { pr: PrStatus }) {
  const { label, cls } =
    pr.state === 'MERGED'
      ? { label: 'Merged', cls: 'text-st-merged' }
      : pr.state === 'CLOSED'
        ? { label: 'Closed', cls: 'text-err' }
        : pr.isDraft
          ? { label: 'Draft', cls: 'text-muted' }
          : pr.mergeable === 'CONFLICTING'
            ? { label: 'Conflicts', cls: 'text-warn' }
            : // GitHub hasn't finished computing mergeability — say so rather than
              // claim the clean-and-open green it hasn't earned yet.
              mergeabilityUnknown(pr.mergeable)
              ? { label: 'Checking…', cls: 'text-muted' }
              : { label: 'Open', cls: 'text-ok' };
  return (
    <a
      className="flex shrink-0 items-center gap-1.5 rounded-ctl border bg-surface px-2 py-1 text-xs transition-colors hover:border-accent/50"
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={`#${pr.number} ${pr.title}`}
    >
      <span className="font-mono text-muted">#{pr.number}</span>
      <ExternalLink size={11} className="text-faint" />
      <span className={clsx('font-medium', cls)}>{label}</span>
    </a>
  );
}

function MergeButton({ workspace, pr }: { workspace: Workspace; pr: PrStatus }) {
  const [merging, setMerging] = useState(false);
  const merge = async () => {
    setMerging(true);
    const res = await tryInvoke('github:prMerge', { workspaceId: workspace.id, method: 'squash' });
    setMerging(false);
    if (res.error || !res.data?.ok) {
      useApp.getState().toast('error', mergeFailureMessage(res.error ?? res.data?.error, pr.baseRefName));
      // GitHub just told us more than our cached mergeability knew — re-ask, so
      // this button becomes Resolve conflicts instead of inviting a second try.
      void useApp.getState().refreshPr(workspace.id, true);
      return;
    }
    useApp.getState().toast('success', `PR #${pr.number} merged`);
    void useApp.getState().refreshPr(workspace.id, true);
  };
  return (
    <button
      className="btn btn-ok h-7 shrink-0 gap-1.5 px-2.5 text-xs"
      disabled={merging}
      title="Squash & merge this PR"
      onClick={() => void merge()}
    >
      {merging ? <Spinner className="!text-white" /> : <GitMerge size={12} />}
      Merge
    </button>
  );
}

function ContinueButton({ workspace }: { workspace: Workspace }) {
  const [continuing, setContinuing] = useState(false);
  return (
    <button
      className="btn h-7 shrink-0 gap-1.5 px-2.5 text-xs"
      title="Keep this workspace and start a fresh branch off the updated base"
      disabled={continuing}
      onClick={async () => {
        setContinuing(true);
        try {
          await useApp.getState().continueWorkspace(workspace.id);
        } finally {
          setContinuing(false);
        }
      }}
    >
      {continuing ? <Spinner /> : <FastForward size={12} />}
      {continuing ? 'Starting…' : 'Continue'}
    </button>
  );
}

/**
 * Collapsed-rail version of the PR action: a single icon button. With no PR it's
 * Create PR — dimmed with no dot when there's nothing to ship, an accent dot when
 * there is. Once a PR exists it becomes a state-colored icon that expands the
 * panel to reveal the full Merge / Continue / Archive actions.
 */
function CollapsedPrButton({ workspace }: { workspace: Workspace }) {
  const pr = useApp((s) => s.prStatus[workspace.id]);
  const creatingPr = useApp((s) => s.creatingPr[workspace.id] ?? false);
  const hasChanges = useHasChanges(workspace.id);

  if (!pr) {
    const disabled = creatingPr || !hasChanges;
    return (
      <button
        className={clsx(
          'no-drag relative rounded-ctl p-1.5 transition-colors',
          disabled ? 'text-faint' : 'text-muted hover:bg-accent-soft hover:text-fg'
        )}
        title={hasChanges ? 'Create pull request (⌘⇧P)' : 'No changes yet — nothing to open a pull request for'}
        disabled={disabled}
        onClick={() => void useApp.getState().createPr(workspace.id)}
      >
        {creatingPr ? <Spinner /> : <GitPullRequest size={16} />}
        {hasChanges && !creatingPr && (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
        )}
      </button>
    );
  }

  const tone =
    pr.state === 'MERGED'
      ? 'text-st-merged'
      : pr.state === 'CLOSED'
        ? 'text-err'
        : pr.mergeable === 'CONFLICTING'
          ? 'text-warn'
          : 'text-ok';
  return (
    <button
      className={clsx('no-drag rounded-ctl p-1.5 transition-colors hover:bg-accent-soft', tone)}
      title={`PR #${pr.number} · ${pr.state.toLowerCase()} — expand for actions`}
      onClick={() => void useApp.getState().saveSettings({ rightPanelCollapsed: false })}
    >
      {pr.state === 'MERGED' ? <GitMerge size={16} /> : <GitPullRequest size={16} />}
    </button>
  );
}

// ---------------- Changes tab ----------------

function ChangesTab({ workspace }: { workspace: Workspace }) {
  const gitStatus = useApp((s) => s.gitStatus[workspace.id]);
  const diff = useApp((s) => s.diffs[workspace.id]);
  const comments = useApp((s) => s.comments[workspace.id]) ?? EMPTY_ARR;
  const pr = useApp((s) => s.prStatus[workspace.id]);
  const project = useApp((s) => s.projects.find((p) => p.id === workspace.projectId));
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const wsVersion = useApp((s) => s.wsVersion[workspace.id] ?? 0);

  useEffect(() => {
    void useApp.getState().refreshDiff(workspace.id);
    void tryInvoke('workspace:contextFiles', { workspaceId: workspace.id }).then((r) => setContextFiles(r.data ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, wsVersion]);

  const unresolved = comments.filter((c) => !c.resolved);
  const files = diff?.files ?? [];

  return (
    <div className="space-y-3 px-3 py-3">
      {/* summary line — folder projects diff against their last shadow checkpoint */}
      <div className="flex items-center justify-between px-1 text-xs text-muted">
        <span>
          vs <span className="font-mono">{project?.baseBranch ?? diff?.base ?? 'last checkpoint'}</span>
        </span>
        {project?.kind === 'folder' ? (
          <button
            className="btn h-5 gap-1 px-1.5 text-2xs"
            title="Restore tracked files to the last checkpoint (new files are kept)"
            onClick={() =>
              useApp.getState().setModal({
                kind: 'confirm',
                title: 'Revert to last checkpoint',
                body: 'Restore files in this folder to the last checkpoint? Files created since are left in place. This changes your folder on disk.',
                confirmLabel: 'Revert',
                danger: true,
                onConfirm: async () => {
                  const r = await tryInvoke('workspace:revertCheckpoint', { workspaceId: workspace.id });
                  if (r.error || !r.data?.ok) useApp.getState().toast('error', r.error ?? r.data?.error ?? 'Revert failed');
                  else {
                    useApp.getState().toast('success', 'Reverted to last checkpoint');
                    void useApp.getState().refreshDiff(workspace.id);
                  }
                },
              })
            }
          >
            <History size={11} /> Revert
          </button>
        ) : (
          gitStatus && (
            <span>
              <span className={gitStatus.ahead ? 'text-ok' : 'text-faint'}>↑{gitStatus.ahead}</span>{' '}
              <span className={gitStatus.behind ? 'text-warn' : 'text-faint'}>↓{gitStatus.behind}</span>
              <span className="ml-2 text-faint">
                {gitStatus.staged}s · {gitStatus.unstaged}u · {gitStatus.untracked}?
              </span>
            </span>
          )
        )}
      </div>

      {pr && (
        <a
          className="flex items-center gap-2 rounded-ctl border bg-surface px-2.5 py-1.5 text-xs text-muted hover:border-accent/50"
          href={pr.url}
          target="_blank"
          rel="noreferrer"
        >
          <GitPullRequest size={12} className={pr.state === 'OPEN' ? 'text-ok' : 'text-muted'} />
          <span className="truncate">
            #{pr.number} {pr.title}
          </span>
          <span className="ml-auto shrink-0 text-2xs">{pr.state}</span>
        </a>
      )}

      {/* changed files */}
      <div className="overflow-hidden rounded-card border bg-surface">
        {files.length === 0 && <div className="px-3 py-3 text-xs text-faint">No changes yet.</div>}
        {files.slice(0, 100).map((f) => (
          <FileRow key={f.path} f={f} onClick={() => useApp.getState().setTab(workspace.id, 'diff')} />
        ))}
      </div>

      {unresolved.length > 0 && (
        <div className="overflow-hidden rounded-card border bg-surface">
          <div className="flex items-center justify-between border-b px-2.5 py-1.5">
            <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
              <MessageSquare size={11} /> Comments ({unresolved.length})
            </span>
            <button className="btn h-5 text-2xs" onClick={() => useApp.getState().sendCommentsToAgent(workspace.id)}>
              Send to agent
            </button>
          </div>
          {unresolved.slice(0, 6).map((c) => (
            <div key={c.id} className="border-b px-2.5 py-1.5 text-xs last:border-b-0">
              <div className="truncate font-mono text-2xs text-faint">
                {c.file}:{c.line}
              </div>
              <div className="truncate text-muted">{c.body}</div>
            </div>
          ))}
        </div>
      )}

      <TodoSection workspace={workspace} compact />

      {contextFiles.length > 0 && (
        <div className="overflow-hidden rounded-card border bg-surface">
          <div className="border-b px-2.5 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
            .context (agent handoffs)
          </div>
          {contextFiles.slice(0, 5).map((f) => (
            <div key={f.path} className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted">
              <FileText size={11} className="shrink-0" />
              <span className="truncate font-mono text-2xs">{f.path.replace(/^\.context\//, '')}</span>
              <span className="ml-auto shrink-0 text-2xs text-faint">{timeAgo(f.mtime)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FileRow({ f, onClick }: { f: DiffFile; onClick: () => void }) {
  const letter =
    f.status === 'added' || f.status === 'untracked' ? 'A' : f.status === 'deleted' ? 'D' : f.status === 'renamed' ? 'R' : 'M';
  const color =
    letter === 'A' ? 'text-ok' : letter === 'D' ? 'text-err' : letter === 'R' ? 'text-st-running' : 'text-warn';
  return (
    <button
      className="flex w-full items-center gap-2 border-b px-2.5 py-1.5 text-left last:border-b-0 hover:bg-accent-soft/50"
      title={f.path}
      onClick={onClick}
    >
      <span className={clsx('w-3 shrink-0 text-center font-mono text-2xs font-semibold', color)}>{letter}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-2xs">{basename(f.path)}</span>
      <span className="shrink-0 font-mono text-2xs">
        <span className="text-ok">+{f.additions}</span> <span className="text-err">−{f.deletions}</span>
      </span>
    </button>
  );
}

// ---------------- All files tab: lazy working-tree browser ----------------

/**
 * The real on-disk working tree (including ignored/untracked files), browsed
 * one directory at a time. Directories load their children on first expand;
 * everything already loaded is quietly re-fetched as the agent edits files, so
 * the tree stays in sync without a manual refresh. Clicking a file opens it in
 * the in-app editor (center Editor surface).
 */
function FilesTab({ workspace }: { workspace: Workspace }) {
  const wsVersion = useApp((s) => s.wsVersion[workspace.id] ?? 0);
  // The "open on this device" actions are local-only; remote workspaces get the
  // plain tree with no right-click menu (their files can't reach the local shell).
  const isRemote = useApp((s) => !!s.projects.find((p) => p.id === workspace.projectId)?.hostId);
  const [tree, setTree] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: FsEntry; path: string } | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;

  const load = useCallback(
    async (dir: string, silent = false) => {
      if (!silent) setLoading((s) => new Set(s).add(dir));
      const { data } = await tryInvoke('fs:list', { workspaceId: workspace.id, path: dir });
      setTree((t) => ({ ...t, [dir]: data ?? [] }));
      if (!silent)
        setLoading((s) => {
          const n = new Set(s);
          n.delete(dir);
          return n;
        });
    },
    [workspace.id]
  );

  // Load the root fresh whenever the workspace changes.
  useEffect(() => {
    setTree({});
    setExpanded(new Set());
    void load('', false);
  }, [workspace.id, load]);

  // Keep already-loaded directories in sync as the working tree changes.
  useEffect(() => {
    const t = setTimeout(() => {
      for (const dir of Object.keys(treeRef.current)) void load(dir, true);
    }, 500);
    return () => clearTimeout(t);
  }, [wsVersion, load]);

  const toggle = (full: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(full)) n.delete(full);
      else {
        n.add(full);
        if (!treeRef.current[full]) void load(full, false);
      }
      return n;
    });
  };

  const rows: React.ReactNode[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of tree[dir] ?? []) {
      const full = dir ? `${dir}/${e.name}` : e.name;
      const open = expanded.has(full);
      rows.push(
        <FileTreeRow
          key={full}
          entry={e}
          depth={depth}
          open={open}
          busy={loading.has(full)}
          onClick={() => (e.dir ? toggle(full) : useApp.getState().openFile(workspace.id, full))}
          onContext={
            isRemote ? undefined : (x, y) => setCtx({ x, y, entry: e, path: full })
          }
        />
      );
      if (e.dir && open) walk(full, depth + 1);
    }
  };
  walk('', 0);

  const rootLoaded = tree[''] !== undefined;
  return (
    <div className="py-1">
      {!rootLoaded && <div className="px-3 py-3 text-xs text-faint">Loading…</div>}
      {rootLoaded && rows.length === 0 && <div className="px-3 py-3 text-xs text-faint">Empty working tree.</div>}
      {rows}
      {ctx && (
        <FileTreeContextMenu
          x={ctx.x}
          y={ctx.y}
          entry={ctx.entry}
          workspaceId={workspace.id}
          path={ctx.path}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}

function FileTreeRow({
  entry,
  depth,
  open,
  busy,
  onClick,
  onContext,
}: {
  entry: FsEntry;
  depth: number;
  open: boolean;
  busy: boolean;
  onClick: () => void;
  onContext?: (x: number, y: number) => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[13px] hover:bg-accent-soft/50"
      style={{ paddingLeft: depth * 14 + 8 }}
      title={entry.name}
      onClick={onClick}
      onContextMenu={
        onContext
          ? (e) => {
              e.preventDefault();
              onContext(e.clientX, e.clientY);
            }
          : undefined
      }
    >
      {entry.dir ? (
        busy ? (
          <Spinner className="!h-3.5 !w-3.5 shrink-0" />
        ) : (
          <ChevronRight size={13} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        )
      ) : (
        <span className="w-[13px] shrink-0" />
      )}
      {entry.dir ? <Folder size={14} className="shrink-0 text-muted" /> : fileGlyph(entry.name)}
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
    </button>
  );
}

const IS_MAC = navigator.userAgent.includes('Macintosh');
const REVEAL_LABEL = IS_MAC ? 'Reveal in Finder' : navigator.userAgent.includes('Windows') ? 'Reveal in Explorer' : 'Reveal in file manager';

/** Right-click menu for a Files-tree entry: open/reveal it on the local device. */
function FileTreeContextMenu({
  x,
  y,
  entry,
  workspaceId,
  path,
  onClose,
}: {
  x: number;
  y: number;
  entry: FsEntry;
  workspaceId: string;
  path: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  const copyPath = async () => {
    const { data } = await tryInvoke('fs:absPath', { workspaceId, path });
    if (!data?.path) return;
    try {
      await navigator.clipboard.writeText(data.path);
      useApp.getState().toast('success', 'Path copied');
    } catch {
      useApp.getState().toast('error', 'Could not copy path');
    }
  };
  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: Math.min(x, window.innerWidth - 224), top: Math.min(y, window.innerHeight - 180), zIndex: 60 }}
      className="glass w-56 overflow-hidden py-1"
    >
      <MenuItem
        onClick={() => {
          onClose();
          void tryInvoke('fs:reveal', { workspaceId, path });
        }}
      >
        <FolderOpen size={15} className="text-muted" /> {REVEAL_LABEL}
      </MenuItem>
      <MenuItem
        onClick={async () => {
          onClose();
          const r = await tryInvoke('fs:openInIDE', { workspaceId, path });
          if (r.error) useApp.getState().toast('error', r.error);
        }}
      >
        <Code2 size={15} className="text-muted" /> Open in IDE
      </MenuItem>
      <MenuItem
        onClick={() => {
          onClose();
          void tryInvoke('fs:openTerminal', { workspaceId, path, dir: entry.dir });
        }}
      >
        <Terminal size={15} className="text-muted" /> Open in terminal
      </MenuItem>
      {!entry.dir && (
        <MenuItem
          onClick={() => {
            onClose();
            void tryInvoke('fs:open', { workspaceId, path });
          }}
        >
          <ExternalLink size={15} className="text-muted" /> Open with default app
        </MenuItem>
      )}
      <MenuDivider />
      <MenuItem
        onClick={() => {
          onClose();
          void copyPath();
        }}
      >
        <Copy size={15} className="text-muted" /> Copy path
      </MenuItem>
    </div>
  );
}

/** VS-Code-style colored glyph for a file, keyed off its extension. */
export function fileGlyph(name: string): React.ReactNode {
  const lower = name.toLowerCase();
  const cls = 'shrink-0';
  if (lower === '.git' || lower.startsWith('.git')) return <GitBranch size={14} className={clsx(cls, 'text-orange-400')} />;
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return <FileCode size={14} className={clsx(cls, 'text-blue-400')} />;
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return <FileCode size={14} className={clsx(cls, 'text-yellow-400')} />;
    case 'json':
      return <Braces size={14} className={clsx(cls, 'text-amber-400')} />;
    case 'md':
    case 'mdx':
    case 'markdown':
      return <FileText size={14} className={clsx(cls, 'text-sky-400')} />;
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
    case 'pcss':
      return <FileCode size={14} className={clsx(cls, 'text-sky-400')} />;
    case 'html':
    case 'htm':
      return <FileCode size={14} className={clsx(cls, 'text-orange-400')} />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
    case 'avif':
      return <FileImage size={14} className={clsx(cls, 'text-purple-400')} />;
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
      return <FileTerminal size={14} className={clsx(cls, 'text-emerald-400')} />;
    default:
      return <File size={14} className={clsx(cls, 'text-faint')} />;
  }
}

// ---------------- bottom dock: Setup | Run | Terminal(s) ----------------

function Dock({ workspace }: { workspace: Workspace }) {
  const open = useApp((s) => s.dockOpen[workspace.id] ?? true);
  const tab = useApp((s) => s.dockTab[workspace.id] ?? 'run');
  const termIds = useApp((s) => s.dockTermIds[workspace.id]) ?? DEFAULT_TERM_IDS;
  const runTabIds = useApp((s) => s.dockRunIds[workspace.id]) ?? EMPTY_ARR;
  const runScripts = useApp((s) => s.runScripts[workspace.id]);
  const scripts = useApp((s) => s.scripts[workspace.id]);
  const runScriptStates = useApp((s) => s.runScriptStates);
  const runScriptRunning = (scriptId: string) => !!runScriptStates[`${workspace.id}:${scriptId}`]?.running;
  const anyRunScriptRunning = Object.keys(runScriptStates).some(
    (k) => k.startsWith(`${workspace.id}:`) && !!runScriptStates[k]?.running
  );
  const dockH = useApp((s) => s.layout.dock);
  const [visited, setVisited] = useState<Set<string>>(() => new Set(open ? [tab] : []));

  useEffect(() => {
    if (open) setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab, open]);

  // Each run script that's been opened gets its own terminal tab, sitting between
  // Run (the cards) and the ad-hoc Terminal tabs. A tab whose script was deleted
  // is dropped (once the script list has loaded).
  const runTabs = runTabIds
    .map((scriptId) => {
      const sc = runScripts?.find((x) => x.id === scriptId);
      if (runScripts && !sc) return null;
      return { id: `rs:${scriptId}`, label: sc?.name ?? 'Script', running: runScriptRunning(scriptId), closable: true };
    })
    .filter(Boolean) as { id: string; label: string; running?: boolean; closable?: boolean }[];

  const tabs: { id: string; label: string; running?: boolean; closable?: boolean }[] = [
    { id: 'setup', label: 'Setup', running: scripts?.setup.running },
    { id: 'run', label: 'Run', running: anyRunScriptRunning },
    ...runTabs,
    ...termIds.map((n) => ({ id: `term:${n}`, label: n === 1 ? 'Terminal' : `Terminal ${n}`, closable: true })),
  ];

  // Only Setup keeps the header ▶ (it's a single repo-settings script); each
  // run-script card carries its own run button.
  const scriptKind = tab === 'setup' ? ('setup' as const) : null;
  const scriptRunning = scriptKind ? !!scripts?.[scriptKind]?.running : false;

  const ptyIdFor = (id: string) => {
    if (id === 'setup') return `script:setup:${workspace.id}`;
    if (id.startsWith('rs:')) return `rs:${workspace.id}:${id.slice(3)}`;
    const n = Number(id.split(':')[1] ?? 1);
    return n === 1 ? `term:${workspace.id}` : `term:${workspace.id}:${n}`;
  };

  return (
    <div className="relative shrink-0 border-t">
      {/* Splitter between the panel's top content and this bottom dock — drag to
          reallocate space between them (only meaningful while the dock is open). */}
      {open && (
        <Resizer
          axis="y"
          invert
          size={dockH}
          min={LAYOUT_LIMITS.dock.min}
          max={LAYOUT_LIMITS.dock.max}
          resetTo={DEFAULT_LAYOUT.dock}
          onResize={(h) => useApp.getState().setLayout({ dock: h })}
          onCommit={() => useApp.getState().commitLayout()}
          className="-top-1"
        />
      )}
      <div className="flex items-center gap-0.5 px-2 py-1">
        {tabs.map((t) => {
          const activeTab = open && tab === t.id;
          return (
            <div
              key={t.id}
              className={clsx(
                'group flex items-center rounded-ctl text-xs transition-colors',
                activeTab ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:text-fg'
              )}
            >
              <button
                className={clsx('flex min-w-0 max-w-[140px] items-center gap-1.5 py-1 pl-2', t.closable ? 'pr-1' : 'pr-2')}
                title={t.label}
                onClick={() => useApp.getState().setDock(workspace.id, !(open && tab === t.id), t.id)}
              >
                <span className="truncate">{t.label}</span>
                {t.running && <span className="dot dot-running pulse !h-1.5 !w-1.5 shrink-0" />}
              </button>
              {t.closable && (
                <button
                  className="mr-1 rounded p-0.5 text-faint opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
                  title="Close terminal"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (t.id.startsWith('rs:')) useApp.getState().closeRunTab(workspace.id, t.id.slice(3));
                    else useApp.getState().closeDockTerminal(workspace.id, Number(t.id.split(':')[1]));
                  }}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          );
        })}
        <button
          className="rounded-ctl p-1 text-muted hover:bg-accent-soft hover:text-fg"
          title="New terminal"
          onClick={() => useApp.getState().addDockTerminal(workspace.id)}
        >
          <Plus size={12} />
        </button>
        <div className="flex-1" />
        {scriptKind && open && (
          <button
            className={clsx('btn btn-ghost h-6 px-1.5 text-2xs', scriptRunning ? 'text-err' : 'text-muted')}
            title={scriptRunning ? `Stop ${scriptKind} script` : `Run ${scriptKind} script (WORKSPACE_PORT ${workspace.port})`}
            onClick={() => {
              if (scriptRunning) void invoke('script:stop', { workspaceId: workspace.id, kind: scriptKind });
              else
                void invoke('script:run', { workspaceId: workspace.id, kind: scriptKind }).then((r) => {
                  if (!r.ok) useApp.getState().toast('error', r.error ?? 'Failed');
                });
            }}
          >
            {scriptRunning ? <Square size={11} fill="currentColor" /> : <Play size={11} />}
          </button>
        )}
        <button
          className="rounded-ctl p-1 text-muted hover:bg-accent-soft hover:text-fg"
          title={open ? 'Collapse' : 'Expand'}
          onClick={() => useApp.getState().setDock(workspace.id, !open)}
        >
          <ChevronDown size={13} className={clsx('transition-transform', !open && 'rotate-180')} />
        </button>
      </div>

      {open && (
        <div className="relative border-t" style={{ background: 'var(--term-bg)', height: dockH }}>
          {[...visited].filter((id) => tabs.some((t) => t.id === id)).map((id) => (
            <div key={id} className={clsx('absolute inset-0', id !== tab && 'hidden')}>
              {id === 'run' ? (
                <RunPanel workspace={workspace} />
              ) : id.startsWith('rs:') ? (
                <RunScriptTerminal workspace={workspace} scriptId={id.slice(3)} active={open && id === tab} />
              ) : (
                <PtyView
                  workspaceId={workspace.id}
                  ptyId={ptyIdFor(id)}
                  ensure={id.startsWith('term:')}
                  active={open && id === tab}
                  emptyHint={
                    id === 'setup' ? 'Setup script output appears here — press ▶ to run it.' : undefined
                  }
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A run script's output as a first-class dock terminal — the same PtyView the
 * Terminal tabs use, so it's a full interactive terminal (the commands run, then
 * it drops into the user's shell). The pty is spawned by the main process when ▶
 * is pressed (execRunScript), so this attaches rather than spawning
 * (ensure=false). Keyed per run: each ▶ replaces the pty, so a fresh xterm
 * remounts and replays just the new session.
 */
function RunScriptTerminal({
  workspace,
  scriptId,
  active,
}: {
  workspace: Workspace;
  scriptId: string;
  active: boolean;
}) {
  const name = useApp((s) => s.runScripts[workspace.id]?.find((x) => x.id === scriptId)?.name) ?? 'This script';
  const startedAt = useApp((s) => s.runScriptStates[`${workspace.id}:${scriptId}`]?.startedAt ?? null);
  return (
    <PtyView
      key={`${scriptId}:${startedAt ?? 'idle'}`}
      workspaceId={workspace.id}
      ptyId={`rs:${workspace.id}:${scriptId}`}
      ensure={false}
      interactive
      active={active}
      emptyHint={`"${name}" hasn't run in this workspace yet — press ▶ on its card in the Run tab. Commands run right here, then the terminal is yours.`}
    />
  );
}
