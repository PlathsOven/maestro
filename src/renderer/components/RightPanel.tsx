import React, { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Activity,
  Archive,
  Braces,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FastForward,
  File,
  FileCode,
  FilePlus,
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
import { timeAgo, fmtStat } from '../lib/format';
import { mergeabilityUnknown, mergeFailureMessage } from '../lib/resolveConflicts';
import { DEFAULT_TERM_IDS, EMPTY_ARR, useApp, useCaps, useShowPr, LAYOUT_LIMITS, DEFAULT_LAYOUT } from '../store/app';
import { TodoSection } from './TodoSection';
import { CountBadge, Resizer, Segmented, Spinner } from './common';
import { VSCodeMark } from '../../shared/ui/brandIcons';
import { StainedDot, StainedGlass } from '../../shared/ui/StainedGlass';
import { GLASS_CONTROL, LiquidGlass } from '../../shared/ui/LiquidGlass';
import RunPanel from './RunPanel';
import SkillsPanel from './SkillsPanel';
import StatusPanel from './StatusPanel';
import ChangedFileTree from './ChangedFileTree';
import PtyView from './TerminalPanel';
import type { ContextFile, FsEntry, PrStatus, Workspace } from '../../shared/types';

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
  // The header (PR strip + tabs) floats over the tab content; the scroller is
  // padded by its live height so nothing starts hidden beneath it.
  const [headRef, headH] = useMeasured((el) => el.offsetHeight, 88);
  // Chromium mis-composites glass inside a scroll container (a bright box the
  // size of the scroller), so the tab row only scrolls when it overflows.
  const [tabsRef, tabsOverflow] = useMeasured((el) => el.scrollWidth > el.clientWidth + 1, false);

  useEffect(() => {
    // No diff source (plain remote folder) — skip the probes entirely.
    // No debounce here: main already throttles file-change bursts, and the
    // store coalesces overlapping probes per workspace.
    if (!showDiff) return;
    void useApp.getState().refreshGit(workspace.id);
    // keep the top-strip diff stat (and the Create PR enabled state) in sync
    useApp.getState().refreshDiffStat(workspace.id);
    if ((useApp.getState().rightTab[workspace.id] ?? 'status') === 'changes') {
      void useApp.getState().refreshDiff(workspace.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsVersion, workspace.id, rightTab, showDiff]);

  useEffect(() => {
    // PR status only makes sense with a github origin + authenticated gh.
    if (showPr) void useApp.getState().refreshPr(workspace.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, showPr]);

  if (collapsed) return <CollapsedRightPanel workspace={workspace} />;

  return (
    // `width` is the preferred width; `shrink`+`min-w-0` let the panel give it up
    // when the window is too narrow for sidebar + chat + panel, so its right edge
    // (PR actions) stays on-screen instead of spilling past the window.
    <aside data-morph="right-panel" className="relative flex min-w-0 shrink flex-col border-l" style={{ width: rightW }}>
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
      {/* Floating glass header over the tab content: the PR lifecycle action
          (Create PR → Merge → Continue/Archive) in the title-bar row, washed with
          the PR state color once a PR exists, then the tabs. */}
      <div ref={headRef} className="scroll-edge-top absolute inset-x-0 top-0 z-20">
        <div className="drag-region flex h-11 shrink-0 items-center justify-end gap-2 overflow-hidden px-2.5">
          {/* .wco-safe keeps these clear of the Windows window-control overlay,
              which is painted over this exact corner of the window. The PR-state
              wash is a soft capsule around the actions, not a full-width band. */}
          <LiquidGlass
            radius={999}
            {...GLASS_CONTROL}
            tint="clear"
            className={clsx(
              'lg-float no-drag wco-safe flex min-w-0 items-center gap-1.5 p-[3px] transition-colors',
              headerPrTone(pr) && ['pl-1.5', headerPrTone(pr)]
            )}
          >
            {/* PR lifecycle needs a github origin + gh auth; below that it's just
                Archive (the folder/remoteless projects that lost dead PR chrome). */}
            {showPr ? <PrActions workspace={workspace} /> : <ArchiveAction workspace={workspace} />}
          </LiquidGlass>
        </div>

        {/* tabs: Status | Files | [Changes] | Skills */}
        <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2.5">
          <button
            className="shrink-0 rounded-full p-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg"
            title="Collapse panel"
            onClick={() => void useApp.getState().saveSettings({ rightPanelCollapsed: true })}
          >
            <PanelRightClose size={15} />
          </button>
          {/* The tabs scroll horizontally when the panel is narrow so the collapse
              toggle is never pushed off the panel's edge. */}
          <div
            ref={tabsRef}
            className={clsx(
              'no-scrollbar -my-2 flex min-w-0 flex-1 items-center px-1 py-2',
              tabsOverflow ? 'overflow-x-auto' : 'overflow-visible'
            )}
          >
            <Segmented
              value={rightTab}
              onChange={(id) => useApp.getState().setRightTab(workspace.id, id)}
              options={(
                [
                  { id: 'status', label: 'Status', badge: 0, show: true },
                  { id: 'files', label: 'Files', badge: 0, show: true },
                  { id: 'changes', label: 'Changes', badge: gitStatus?.changedFiles || 0, show: showDiff },
                  { id: 'skills', label: 'Skills', badge: 0, show: true },
                ] as const
              )
                .filter((t) => t.show)
                .map((t) => ({
                  value: t.id,
                  label: (
                    <>
                      {t.label}
                      {t.badge > 0 && <CountBadge count={t.badge} />}
                    </>
                  ),
                }))}
            />
          </div>
        </div>
      </div>

      <div key={rightTab} data-motion="swap" className="min-h-0 flex-1 overflow-y-auto" style={{ paddingTop: headH }}>
        {/* Guard each tab's content on its capability so a stale rightTab (e.g.
            'changes' left over from a git project) falls back to Status. */}
        {rightTab === 'files' ? (
          <FilesTab workspace={workspace} />
        ) : rightTab === 'changes' && showDiff ? (
          <ChangesTab workspace={workspace} />
        ) : rightTab === 'skills' ? (
          <SkillsPanel workspace={workspace} />
        ) : (
          <StatusPanel workspace={workspace} />
        )}
      </div>

      <Dock workspace={workspace} />
    </aside>
  );
}

/** Thin icon-only rail shown when the right panel is collapsed — mirrors the
 *  collapsed sidebar. An expand toggle up top and quick tab shortcuts (each
 *  expands the panel to that tab). */
function CollapsedRightPanel({ workspace }: { workspace: Workspace }) {
  const rightTab = useApp((s) => s.rightTab[workspace.id] ?? 'status');
  const changed = useApp((s) => s.gitStatus[workspace.id]?.changedFiles ?? 0);
  const caps = useCaps(workspace.projectId);
  const showPr = useShowPr(workspace.projectId);

  const expand = (tab?: 'status' | 'files' | 'changes' | 'skills') => {
    if (tab) useApp.getState().setRightTab(workspace.id, tab);
    void useApp.getState().saveSettings({ rightPanelCollapsed: false });
  };

  const tabs = (
    [
      { id: 'status', label: 'Status', Icon: Activity, show: true },
      { id: 'files', label: 'Files', Icon: Folder, show: true },
      { id: 'changes', label: 'Changes', Icon: GitCompare, show: caps.git || caps.checkpoints },
      { id: 'skills', label: 'Skills', Icon: Sparkles, show: true },
    ] as const
  ).filter((t) => t.show);

  return (
    // w-12 must stay in sync with COLLAPSED_RIGHT_RAIL (store/app.ts).
    <aside data-morph="right-panel" className="relative flex w-12 shrink-0 flex-col items-center border-l">
      <div className="drag-region h-11 w-full shrink-0" />
      {/* primary PR action, shrunk to an icon button that mirrors the expanded
          panel's top-right Create PR / Merge control (hidden without PR caps). */}
      {showPr && <CollapsedPrButton workspace={workspace} />}
      <button
        className="no-drag mb-1.5 mt-1 grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg"
        title="Expand panel"
        onClick={() => expand()}
      >
        <PanelRightOpen size={16} />
      </button>
      <div className="mb-1.5 w-5 border-t" />
      <div className="flex flex-col items-center gap-1">
        {tabs.map((t) => {
          const Icon = t.Icon;
          return (
            <button
              key={t.id}
              className={clsx(
                'no-drag relative grid h-8 w-8 place-items-center rounded-full transition-colors',
                rightTab === t.id ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-accent-soft hover:text-fg'
              )}
              title={t.label}
              onClick={() => expand(t.id)}
            >
              <Icon size={15} />
              {t.id === 'changes' && changed > 0 && (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />
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
    <button className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg" title={title} onClick={onClick}>
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
        <StainedGlass
          as="button"
          tone="ink"
          ripple={creatingPr}
          className="btn h-7 shrink-0 gap-1.5 px-3 text-xs"
          title={hasChanges ? 'Commit all changes & create pull request (⌘⇧P)' : 'No changes yet — nothing to open a pull request for'}
          disabled={creatingPr || !hasChanges}
          onClick={() => void useApp.getState().createPr(workspace.id)}
        >
          {creatingPr ? <Spinner className="!text-on-ink" /> : <GitPullRequest size={12} />}
          {creatingPr ? 'Creating…' : 'Create PR'}
        </StainedGlass>
      </>
    );
  }

  if (pr.state === 'MERGED') {
    return (
      <>
        <PrBadge pr={pr} />
        <ContinueButton workspace={workspace} />
        <StainedGlass
          as="button"
          tone="merged"
          className="btn h-7 shrink-0 gap-1.5 px-3 text-xs"
          title="Archive this workspace"
          onClick={() => void useApp.getState().archiveWorkspace(workspace.id)}
        >
          <Archive size={12} />
          Archive
        </StainedGlass>
      </>
    );
  }

  if (pr.state === 'CLOSED') {
    return (
      <>
        <PrBadge pr={pr} />
        <StainedGlass
          as="button"
          tone="ink"
          className="btn h-7 shrink-0 gap-1.5 px-3 text-xs"
          title="Archive this workspace"
          onClick={() => void useApp.getState().archiveWorkspace(workspace.id)}
        >
          <Archive size={12} />
          Archive
        </StainedGlass>
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
  const cls = 'btn h-7 shrink-0 gap-1.5 px-3 text-xs';

  if (workspace.harness === 'shell') {
    return (
      <StainedGlass
        as="a"
        tone="warn"
        className={cls}
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title="This PR has merge conflicts — open it on GitHub to resolve"
      >
        <GitMerge size={12} />
        Resolve conflicts
      </StainedGlass>
    );
  }

  return (
    <StainedGlass
      as="button"
      tone="warn"
      ripple={resolving}
      className={cls}
      disabled={resolving}
      title={
        resolving
          ? 'The agent is resolving the conflicts…'
          : `Merge conflicts with ${base} — send the agent to resolve them`
      }
      onClick={() => void useApp.getState().startConflictResolution(workspace.id)}
    >
      {resolving ? <Spinner className="!text-white" /> : <GitMerge size={12} />}
      {resolving ? 'Resolving…' : 'Resolve conflicts'}
    </StainedGlass>
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
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-raised/80 px-2.5 text-xs shadow-[0_0_0_1px_var(--border)] transition-colors hover:bg-raised"
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
    <StainedGlass
      as="button"
      tone="ok"
      ripple={merging}
      className="btn h-7 shrink-0 gap-1.5 px-3 text-xs"
      disabled={merging}
      title="Squash & merge this PR"
      onClick={() => void merge()}
    >
      {merging ? <Spinner className="!text-white" /> : <GitMerge size={12} />}
      Merge
    </StainedGlass>
  );
}

function ContinueButton({ workspace }: { workspace: Workspace }) {
  const [continuing, setContinuing] = useState(false);
  return (
    <button
      className="btn h-7 shrink-0 gap-1.5 px-3 text-xs"
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
          'no-drag relative grid h-8 w-8 place-items-center rounded-full transition-colors',
          disabled ? 'text-faint' : 'text-muted hover:bg-accent-soft hover:text-fg'
        )}
        title={hasChanges ? 'Create pull request (⌘⇧P)' : 'No changes yet — nothing to open a pull request for'}
        disabled={disabled}
        onClick={() => void useApp.getState().createPr(workspace.id)}
      >
        {creatingPr ? <Spinner /> : <GitPullRequest size={15} />}
        {hasChanges && !creatingPr && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />
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
      className={clsx('no-drag grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-accent-soft', tone)}
      title={`PR #${pr.number} · ${pr.state.toLowerCase()} — expand for actions`}
      onClick={() => void useApp.getState().saveSettings({ rightPanelCollapsed: false })}
    >
      {pr.state === 'MERGED' ? <GitMerge size={15} /> : <GitPullRequest size={15} />}
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
    <div className="space-y-3 px-3 pb-4 pt-3.5">
      {/* summary line — folder projects diff against their last shadow checkpoint */}
      <div className="flex items-center justify-between px-1.5 text-xs text-muted">
        <span>
          vs <span className="font-mono">{project?.baseBranch ?? diff?.base ?? 'last checkpoint'}</span>
        </span>
        {project?.kind === 'folder' ? (
          <button
            className="btn h-6 gap-1 px-2.5 text-2xs"
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
          className="flex items-center gap-2 rounded-ctl bg-accent-soft px-3 py-2 text-xs text-muted transition-colors hover:text-fg"
          href={pr.url}
          target="_blank"
          rel="noreferrer"
        >
          <GitPullRequest size={12} className={pr.state === 'OPEN' ? 'text-ok' : 'text-muted'} />
          <span className="truncate">
            #{pr.number} {pr.title}
          </span>
          <span className="ml-auto shrink-0 rounded-full bg-raised px-1.5 text-2xs font-medium">{pr.state}</span>
        </a>
      )}

      {/* changed files */}
      <div className="-mx-1 space-y-px">
        {files.length === 0 && <div className="px-3 py-6 text-center text-xs text-faint">No changes yet.</div>}
        <ChangedFileTree
          files={files.slice(0, 100)}
          onSelect={() => useApp.getState().setTab(workspace.id, 'diff')}
          trailing={(f) => (
            <span className="shrink-0 font-mono text-2xs">
              <span className="text-ok">+{f.additions}</span> <span className="text-err">−{f.deletions}</span>
            </span>
          )}
        />
      </div>

      {unresolved.length > 0 && (
        <div className="card p-1.5">
          <div className="flex items-center justify-between px-2 pb-1 pt-1">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <MessageSquare size={11} className="text-faint" /> Comments ({unresolved.length})
            </span>
            <button className="btn h-6 px-2.5 text-2xs" onClick={() => useApp.getState().sendCommentsToAgent(workspace.id)}>
              Send to agent
            </button>
          </div>
          {unresolved.slice(0, 6).map((c) => (
            <div key={c.id} className="rounded-ctl px-2 py-1.5 text-xs">
              <div className="truncate font-mono text-2xs text-faint">
                {c.file}:{c.line}
              </div>
              <div className="truncate text-muted">{c.body}</div>
            </div>
          ))}
        </div>
      )}

      <div className="px-1.5">
        <TodoSection workspace={workspace} compact />
      </div>

      {contextFiles.length > 0 && (
        <div className="card p-1.5">
          <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted">
            .context (agent handoffs)
          </div>
          {contextFiles.slice(0, 5).map((f) => (
            <div key={f.path} className="flex items-center gap-2 rounded-ctl px-2 py-1.5 text-xs text-muted">
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
  // "+" → inline path input; the value is the initial text (a folder prefix
  // when started from a folder's right-click menu), null when closed.
  const [creating, setCreating] = useState<string | null>(null);
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

  // Create the file (or folder, for a trailing '/'), reveal it in the tree, and
  // open a new file in the editor. Returns an error message to keep the input open.
  const create = async (raw: string): Promise<string | null> => {
    const dir = raw.trim().endsWith('/');
    const rel = raw.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (!rel) return 'Enter a file name';
    const r = await tryInvoke('fs:create', { workspaceId: workspace.id, path: rel, dir });
    if (r.error) return r.error;
    setCreating(null);
    const parts = rel.split('/');
    const ancestors = parts.slice(0, dir ? parts.length : -1).map((_, i) => parts.slice(0, i + 1).join('/'));
    setExpanded((s) => new Set([...s, ...ancestors]));
    await Promise.all(['', ...ancestors].map((d) => load(d, true)));
    if (!dir) useApp.getState().openFile(workspace.id, rel);
    return null;
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
    <div className="space-y-px px-2 py-2">
      {/* New file needs the local editor + filesystem, so remote workspaces skip it. */}
      {!isRemote && (
        <div className="flex items-center justify-between pb-1 pl-2.5 pr-1">
          <span className="text-2xs text-faint">Working tree</span>
          <button
            className="rounded-full p-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg"
            title="New file (end with / for a folder)"
            onClick={() => setCreating((c) => (c === null ? '' : c))}
          >
            <Plus size={14} />
          </button>
        </div>
      )}
      {creating !== null && (
        <NewEntryInput key={creating} initial={creating} onSubmit={create} onCancel={() => setCreating(null)} />
      )}
      {!rootLoaded && <div className="px-2.5 py-3 text-xs text-faint">Loading…</div>}
      {rootLoaded && rows.length === 0 && <div className="px-2.5 py-3 text-xs text-faint">Empty working tree.</div>}
      {rows}
      {ctx && (
        <FileTreeContextMenu
          x={ctx.x}
          y={ctx.y}
          entry={ctx.entry}
          workspaceId={workspace.id}
          path={ctx.path}
          onClose={() => setCtx(null)}
          onNewFile={(dir) => setCreating(dir ? `${dir}/` : '')}
        />
      )}
    </div>
  );
}

/** Inline path input for the Files tab's "+" (Enter creates, Esc cancels). */
function NewEntryInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (path: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const err = await onSubmit(value);
    setBusy(false);
    setError(err);
  };
  return (
    <div className="px-1 pb-1.5">
      <input
        autoFocus
        className="input h-7 w-full font-mono text-2xs"
        placeholder="path/to/new-file.ts"
        value={value}
        spellCheck={false}
        disabled={busy}
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          else if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => {
          if (!value.trim() && !busy) onCancel();
        }}
      />
      <div className={clsx('px-1 pt-1 text-2xs', error ? 'text-err' : 'text-faint')}>
        {error ?? 'Enter to create · end with / for a folder · Esc to cancel'}
      </div>
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
      data-motion="row"
      className="flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-[13px] transition-colors hover:bg-accent-soft"
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
  onNewFile,
}: {
  x: number;
  y: number;
  entry: FsEntry;
  workspaceId: string;
  path: string;
  onClose: () => void;
  onNewFile: (dir: string) => void;
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
      data-motion="pop"
      className="glass w-56 origin-top-left overflow-hidden py-1"
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
        <VSCodeMark size={15} className="text-muted" /> Open in IDE
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
      <MenuItem
        onClick={() => {
          onClose();
          onNewFile(entry.dir ? path : path.slice(0, Math.max(0, path.lastIndexOf('/'))));
        }}
      >
        <FilePlus size={15} className="text-muted" /> New file here…
      </MenuItem>
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
      <div className="flex items-center gap-1 px-2 py-1.5">
        <LiquidGlass
          radius={999}
          {...GLASS_CONTROL}
          tint="clear"
          className="lg-float flex min-w-0 items-center gap-0.5 p-[3px]"
          style={{ background: 'var(--accent-soft)' }}
        >
          {tabs.map((t) => {
            const activeTab = open && tab === t.id;
            return (
              <div
                key={t.id}
                data-motion="tab"
                className={clsx(
                  'group flex h-7 shrink-0 items-center rounded-full text-xs font-medium transition-colors',
                  activeTab ? 'tab-lit text-fg' : 'text-muted hover:bg-accent-soft hover:text-fg'
                )}
              >
                <button
                  className={clsx('flex h-full min-w-0 max-w-[140px] items-center gap-1.5 pl-3', t.closable ? 'pr-1' : 'pr-3')}
                  title={t.label}
                  onClick={() => useApp.getState().setDock(workspace.id, !(open && tab === t.id), t.id)}
                >
                  <span className="truncate">{t.label}</span>
                  {t.running && <StainedDot tone="running" size={6} ripple />}
                </button>
                {t.closable && (
                  <button
                    className="mr-1 grid h-5 w-5 place-items-center rounded-full text-faint opacity-0 transition-opacity hover:bg-accent-soft hover:text-err group-hover:opacity-100"
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
        </LiquidGlass>
        <button
          className="grid h-7 w-7 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg"
          title="New terminal"
          onClick={() => useApp.getState().addDockTerminal(workspace.id)}
        >
          <Plus size={12} />
        </button>
        <div className="flex-1" />
        {scriptKind && open && (
          <button
            className={clsx('btn h-7 w-7 !px-0 text-2xs', scriptRunning ? 'btn-ghost text-err' : 'btn-accent')}
            title={scriptRunning ? `Stop ${scriptKind} script` : `Run ${scriptKind} script (WORKSPACE_PORT ${workspace.port})`}
            onClick={() => {
              if (scriptRunning) void invoke('script:stop', { workspaceId: workspace.id, kind: scriptKind });
              else
                void invoke('script:run', { workspaceId: workspace.id, kind: scriptKind }).then((r) => {
                  if (!r.ok) useApp.getState().toast('error', r.error ?? 'Failed');
                });
            }}
          >
            {scriptRunning ? <Square size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
          </button>
        )}
        <button
          className="grid h-7 w-7 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg"
          title={open ? 'Collapse' : 'Expand'}
          onClick={() => useApp.getState().setDock(workspace.id, !open)}
        >
          <ChevronDown size={13} className={clsx('transition-transform', !open && 'rotate-180')} />
        </button>
      </div>

      {open && (
        <div data-motion="collapse" className="relative" style={{ background: 'var(--term-bg)', height: dockH }}>
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
                  focusKey={`${workspace.id}:${id}`}
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
      focusKey={`${workspace.id}:rs:${scriptId}`}
      active={active}
      emptyHint={`"${name}" hasn't run in this workspace yet — press ▶ on its card in the Run tab. Commands run right here, then the terminal is yours.`}
    />
  );
}

/** Callback ref + a value read from the element, re-read whenever it or its
 *  content resizes (for chrome that floats over a scroller, and for overflow). */
function useMeasured<T>(read: (el: HTMLElement) => T, initial: T): [(el: HTMLElement | null) => void, T] {
  const [value, setValue] = useState(initial);
  const ro = useRef<ResizeObserver | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    const measure = () => setValue(readRef.current(el));
    measure();
    ro.current = new ResizeObserver(measure);
    ro.current.observe(el);
    if (el.firstElementChild) ro.current.observe(el.firstElementChild);
  }, []);
  return [ref, value];
}
