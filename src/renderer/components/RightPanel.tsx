import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Activity,
  Archive,
  Braces,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
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
  FolderPlus,
  GitBranch,
  GitCompare,
  GitMerge,
  GitPullRequest,
  History,
  Link2,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Play,
  Plus,
  Scissors,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { invoke, tryInvoke } from '../lib/api';
import { useEditors } from '../lib/editors';
import { timeAgo, fmtStat } from '../../shared/ui/format';
import { mergeabilityUnknown } from '../lib/resolveConflicts';
import { DEFAULT_TERM_IDS, EMPTY_ARR, useApp, useCaps, useShowPr } from '../store/app';
import { DEFAULT_LAYOUT, LAYOUT_LIMITS } from '../lib/layoutPrefs';
import { TodoSection } from './TodoSection';
import { ContextMenu, CountBadge, MenuDivider, MenuItem, Resizer, Segmented, Spinner } from './common';
import { VSCodeMark } from '../../shared/ui/brandIcons';
import { StainedDot, StainedGlass, type GlassTone } from '../../shared/ui/StainedGlass';
import { GLASS_CONTROL, LiquidGlass } from '../../shared/ui/LiquidGlass';
import RunPanel from './RunPanel';
import SkillsPanel from './SkillsPanel';
import StatusPanel from './StatusPanel';
import ChangedFileTree from './ChangedFileTree';
import PtyView from './TerminalPanel';
import type { ContextFile, FsEntry, PrStatus, Workspace } from '../../shared/types';
import { copyText } from '../lib/clipboard';

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
      <div ref={headRef} className="panel-head scroll-edge-top absolute inset-x-0 top-0 z-20">
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

/** A PR's state as a label + colour: text class for the pill, glass tone for the rail dot. */
function prState(pr: PrStatus): { label: string; cls: string; tone: GlassTone } {
  return pr.state === 'MERGED'
    ? { label: 'Merged', cls: 'text-st-merged', tone: 'merged' }
    : pr.state === 'CLOSED'
      ? { label: 'Closed', cls: 'text-err', tone: 'err' }
      : pr.isDraft
        ? { label: 'Draft', cls: 'text-muted', tone: 'idle' }
        : pr.mergeable === 'CONFLICTING'
          ? { label: 'Conflicts', cls: 'text-warn', tone: 'warn' }
          : // GitHub hasn't finished computing mergeability — say so rather than
            // claim the clean-and-open green it hasn't earned yet.
            mergeabilityUnknown(pr.mergeable)
            ? { label: 'Checking…', cls: 'text-muted', tone: 'idle' }
            : { label: 'Open', cls: 'text-ok', tone: 'ok' };
}

/** Clickable PR pill: number + external link + colored state label. */
function PrBadge({ pr }: { pr: PrStatus }) {
  const { label, cls } = prState(pr);
  return (
    <a
      className="flex h-7 min-w-0 items-center gap-1.5 rounded-full bg-raised/80 px-2.5 text-xs shadow-[0_0_0_1px_var(--border)] transition-colors hover:bg-raised"
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={`#${pr.number} ${pr.title}`}
    >
      <span className="font-mono text-muted">#{pr.number}</span>
      <ExternalLink size={11} className="text-faint" />
      <span className={clsx('truncate font-medium', cls)}>{label}</span>
    </a>
  );
}

function MergeButton({ workspace, pr }: { workspace: Workspace; pr: PrStatus }) {
  const [merging, setMerging] = useState(false);
  const merge = async () => {
    setMerging(true);
    await useApp.getState().squashMergePr(workspace.id, pr.number);
    setMerging(false);
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
 * Collapsed-rail version of the PR action: a stained-glass icon button in the
 * same tone as the expanded panel's action (ink Create PR, green Merge, amber
 * Resolve conflicts, violet merged), with a status dot top-right carrying the PR
 * state (the PrBadge colours). Hovering shows a glass card with the state and
 * the `+adds −dels` diff summary. With no PR a click creates one; once a PR
 * exists it expands the panel to reveal the full actions.
 */
function CollapsedPrButton({ workspace }: { workspace: Workspace }) {
  const pr = useApp((s) => s.prStatus[workspace.id]);
  const creatingPr = useApp((s) => s.creatingPr[workspace.id] ?? false);
  const resolving = useApp((s) => !!s.resolvingPr[workspace.id]);
  const stat = useApp((s) => s.diffStats[workspace.id]);
  const hasChanges = useHasChanges(workspace.id);

  const conflicting = pr?.state === 'OPEN' && pr.mergeable === 'CONFLICTING';
  // Body tone mirrors the expanded action button; the dot carries the status.
  const body: GlassTone = !pr || pr.state === 'CLOSED' ? 'ink' : pr.state === 'MERGED' ? 'merged' : conflicting ? 'warn' : 'ok';
  const status = pr
    ? { ...prState(pr), ...(resolving && { label: 'Resolving conflicts…' }) }
    : creatingPr
      ? { tone: 'running' as const, label: 'Creating PR…', cls: 'text-st-running' }
      : hasChanges
        ? { tone: 'running' as const, label: 'Ready to open a PR', cls: 'text-st-running' }
        : null;
  const busy = creatingPr || resolving;
  const heading = pr ? `PR #${pr.number}` : 'Create PR';

  return (
    <div className="group relative mb-1 mt-0.5">
      <StainedGlass
        as="button"
        tone={body}
        ripple={busy}
        className="no-drag grid h-8 w-8 place-items-center"
        aria-label={pr ? `${heading} · ${status?.label ?? ''} — expand for actions` : 'Create pull request (⌘⇧P)'}
        disabled={!pr && (creatingPr || !hasChanges)}
        onClick={() =>
          void (pr ? useApp.getState().saveSettings({ rightPanelCollapsed: false }) : useApp.getState().createPr(workspace.id))
        }
      >
        {creatingPr ? (
          <Spinner className="!text-on-ink" />
        ) : pr?.state === 'MERGED' || conflicting ? (
          <GitMerge size={14} />
        ) : (
          <GitPullRequest size={14} />
        )}
      </StainedGlass>
      {status && (
        <StainedDot
          tone={status.tone}
          size={9}
          ripple={busy}
          className="pointer-events-none absolute -right-0.5 -top-0.5 shadow-[0_0_0_1.5px_var(--bg)]"
        />
      )}
      {/* hover card: floats left of the rail, over the chat column */}
      <div
        role="tooltip"
        className="glass pointer-events-none absolute right-full top-1/2 z-50 mr-2.5 -translate-y-1/2 translate-x-1 whitespace-nowrap px-3 py-2 opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0 group-hover:opacity-100"
      >
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-medium text-fg">{heading}</span>
          {status && <span className={clsx('font-medium', status.cls)}>· {status.label}</span>}
        </div>
        <div className="mt-0.5 font-mono text-2xs">
          {stat && stat.additions + stat.deletions > 0 ? (
            <>
              <span className="text-ok">+{fmtStat(stat.additions)}</span>{' '}
              <span className="text-err">−{fmtStat(stat.deletions)}</span>
              <span className="font-sans text-faint"> vs base</span>
            </>
          ) : (
            <span className="font-sans text-faint">{hasChanges ? 'Uncommitted changes' : 'No changes yet'}</span>
          )}
        </div>
      </div>
    </div>
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
          onSelect={(f) => useApp.getState().revealDiffFile(workspace.id, f.path)}
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

const IS_MAC = navigator.userAgent.includes('Macintosh');
const IS_WIN = navigator.userAgent.includes('Windows');
const REVEAL_LABEL = IS_MAC ? 'Reveal in Finder' : IS_WIN ? 'Reveal in Explorer' : 'Reveal in file manager';
const TRASH_LABEL = IS_MAC ? 'Trash' : IS_WIN ? 'Recycle Bin' : 'trash';
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
/** Hovering a collapsed folder this long mid-drag springs it open. */
const SPRING_MS = 600;

type TreeRow = { full: string; entry: FsEntry; depth: number };
type ClipKind = 'copy' | 'cut' | 'paste';

const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const isUnder = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');
/** Drop paths covered by another path in the list — a folder carries its contents. */
const topLevel = (paths: string[]) => paths.filter((p) => !paths.some((q) => q !== p && isUnder(p, q)));

/**
 * The real on-disk working tree (including ignored/untracked files), browsed
 * one directory at a time. Directories load their children on first expand;
 * everything already loaded is quietly re-fetched as the agent edits files, so
 * the tree stays in sync without a manual refresh. Clicking a file opens it in
 * the in-app editor (center Editor surface).
 *
 * Local workspaces also get file management: ⌘/⇧-click multi-select and arrow
 * keys, inline rename (F2, or Enter on macOS), delete to the OS trash,
 * duplicate, cut/copy/paste, and drag-and-drop (⌥ copies; collapsed folders
 * spring open; files dropped from the OS are copied in). Open editor tabs
 * follow renames and moves.
 */
function FilesTab({ workspace }: { workspace: Workspace }) {
  const wsId = workspace.id;
  const wsVersion = useApp((s) => s.wsVersion[wsId] ?? 0);
  // The "open on this device" and file-management actions are local-only; remote
  // workspaces get the plain tree (their files can't reach the local shell/disk).
  const isRemote = useApp((s) => !!s.projects.find((p) => p.id === workspace.projectId)?.hostId);
  const [tree, setTree] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  // `path: null` = right-click on the empty area (acts on the root).
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string | null } | null>(null);
  // Inline "new file/folder" input: `initial` is its starting text (a folder
  // prefix when started from a folder), null when closed.
  const [creating, setCreating] = useState<{ initial: string; folder: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [lead, setLead] = useState<string | null>(null); // keyboard cursor
  const [anchor, setAnchor] = useState<string | null>(null); // ⇧-range origin
  const [renaming, setRenaming] = useState<string | null>(null);
  const [clip, setClip] = useState<{ cut: boolean; paths: string[] } | null>(null);
  // Folder under the pointer mid-drag ('' = root), highlighted as the drop target.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragRef = useRef<string[] | null>(null); // our own rows being dragged (null = OS files)
  const springRef = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const treeElRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const load = useCallback(
    async (dir: string, silent = false) => {
      if (!silent) setLoading((s) => new Set(s).add(dir));
      const { data } = await tryInvoke('fs:list', { workspaceId: wsId, path: dir });
      setTree((t) => ({ ...t, [dir]: data ?? [] }));
      if (!silent)
        setLoading((s) => {
          const n = new Set(s);
          n.delete(dir);
          return n;
        });
    },
    [wsId]
  );

  // Load the root fresh whenever the workspace changes.
  useEffect(() => {
    setTree({});
    setExpanded(new Set());
    setSelected(new Set());
    setRenaming(null);
    setClip(null);
    void load('', false);
  }, [wsId, load]);

  // Keep already-loaded directories in sync as the working tree changes.
  useEffect(() => {
    const t = setTimeout(() => {
      for (const dir of Object.keys(treeRef.current)) void load(dir, true);
    }, 500);
    return () => clearTimeout(t);
  }, [wsVersion, load]);

  const toggle = (full: string, open?: boolean) => {
    setExpanded((s) => {
      if (open !== undefined && s.has(full) === open) return s;
      const n = new Set(s);
      if (n.has(full)) n.delete(full);
      else {
        n.add(full);
        if (!treeRef.current[full]) void load(full, false);
      }
      return n;
    });
  };

  // Visible rows in display order — drives rendering, arrow keys and ⇧-ranges.
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of tree[dir] ?? []) {
      const full = joinPath(dir, e.name);
      rows.push({ full, entry: e, depth });
      if (e.dir && expanded.has(full)) walk(full, depth + 1);
    }
  };
  walk('', 0);
  const rowIndex = new Map(rows.map((r, i) => [r.full, i]));
  const selection = topLevel([...selected].sort((a, b) => (rowIndex.get(a) ?? 1e9) - (rowIndex.get(b) ?? 1e9)));

  const toast = (kind: 'error' | 'success', msg: string) => useApp.getState().toast(kind, msg);
  const focusTree = () => treeElRef.current?.focus({ preventScroll: true });
  const scrollTo = (full: string) =>
    treeElRef.current?.querySelector(`[data-path="${CSS.escape(full)}"]`)?.scrollIntoView({ block: 'nearest' });
  const select = (paths: string[], cursor = paths[paths.length - 1] ?? null) => {
    setSelected(new Set(paths));
    setLead(cursor);
    setAnchor(cursor);
  };
  /** ⇧-click / ⇧-arrow: select anchor…`full`, keeping the anchor. */
  const extendTo = (full: string) => {
    const [a, b] = [rowIndex.get(anchor ?? full) ?? 0, rowIndex.get(full)!].sort((x, y) => x - y);
    setSelected(new Set(rows.slice(a, b + 1).map((r) => r.full)));
    setLead(full);
  };
  /** Where Paste / New file land: the folder itself, a file's folder, or the root. */
  const dirOf = (p: string | null) => (p === null ? '' : tree[parentOf(p)]?.find((e) => e.name === baseOf(p))?.dir ? p : parentOf(p));

  /** An open editor tab with unsaved edits at or under any of `paths`. */
  const dirtyIn = (paths: string[]) => {
    const dirty = useApp.getState().dirtyFiles[wsId] ?? {};
    return Object.keys(dirty).find((f) => dirty[f] && paths.some((p) => isUnder(f, p)));
  };

  /**
   * After entries moved (`moves` = [from, to]) or appeared: carry expansion and
   * cached listings to the new paths, expand the ancestors of `reveal`, select
   * it, and re-list every loaded folder.
   */
  const afterChange = async (moves: [string, string][], reveal: string[]) => {
    const map = (p: string) => {
      for (const [f, t] of moves) if (isUnder(p, f)) return t + p.slice(f.length);
      return p;
    };
    const ancestors = reveal.flatMap((p) => {
      const out: string[] = [];
      for (let d = parentOf(p); d; d = parentOf(d)) out.push(d);
      return out;
    });
    setExpanded(new Set([...[...expandedRef.current].map(map), ...ancestors]));
    setTree((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [map(k), v])));
    select(reveal);
    const dirs = new Set(['', ...Object.keys(treeRef.current).map(map), ...ancestors]);
    await Promise.all([...dirs].map((d) => load(d, true)));
    if (reveal.length) requestAnimationFrame(() => scrollTo(reveal[reveal.length - 1]));
  };

  // Create the file (or folder, for a trailing '/'), reveal it in the tree, and
  // open a new file in the editor. Returns an error message to keep the input open.
  const create = async (raw: string): Promise<string | null> => {
    const dir = raw.trim().endsWith('/');
    const rel = raw.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (!rel) return 'Enter a file name';
    const r = await tryInvoke('fs:create', { workspaceId: wsId, path: rel, dir });
    if (r.error) return r.error;
    setCreating(null);
    await afterChange([], [rel]);
    if (dir) focusTree();
    else useApp.getState().openFile(wsId, rel);
    return null;
  };

  // Move entries by renaming each; editor tabs follow. Returns an error message.
  const move = async (pairs: [string, string][]): Promise<string | null> => {
    const dirty = dirtyIn(pairs.map(([from]) => from));
    if (dirty) return `Save ${baseOf(dirty)} before moving or renaming it`;
    const done: [string, string][] = [];
    let error: string | null = null;
    for (const [from, to] of pairs) {
      error = (await tryInvoke('fs:rename', { workspaceId: wsId, from, to })).error ?? null;
      if (error) break;
      useApp.getState().renameOpenFiles(wsId, from, to);
      done.push([from, to]);
    }
    if (done.length) await afterChange(done, done.map(([, to]) => to));
    return error;
  };

  // Inline rename. A name containing '/' moves the entry into (new) subfolders.
  const rename = async (from: string, raw: string): Promise<string | null> => {
    const name = raw.trim().replace(/^\/+|\/+$/g, '');
    if (name.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return 'Not a valid name';
    const err = name === baseOf(from) ? null : await move([[from, joinPath(parentOf(from), name)]]);
    if (err) return err;
    setRenaming(null);
    focusTree();
    return null;
  };

  const copy = async (paths: string[], toDir: string) => {
    const r = await tryInvoke('fs:copy', { workspaceId: wsId, paths, toDir });
    if (r.error) toast('error', r.error);
    else if (r.data) await afterChange([], r.data);
  };

  // Drag-and-drop and Cut/Copy → Paste into `dir`.
  const transfer = async (paths: string[], dir: string, asCopy: boolean) => {
    if (asCopy) return copy(paths, dir);
    const pairs = paths.filter((p) => parentOf(p) !== dir).map((p): [string, string] => [p, joinPath(dir, baseOf(p))]);
    const err = pairs.length ? await move(pairs) : null;
    if (err) toast('error', err);
  };

  const duplicate = async (paths: string[]) => {
    for (const p of paths) await copy([p], parentOf(p));
  };

  const remove = (paths: string[]) => {
    const one = paths.length === 1;
    const dirty = dirtyIn(paths);
    // Land the cursor on the first surviving row after (or else before) the deleted ones.
    const gone = (r: TreeRow) => paths.some((p) => isUnder(r.full, p));
    const idx = rowIndex.get(paths[0]) ?? 0;
    const next = rows.slice(idx).find((r) => !gone(r)) ?? rows.slice(0, idx).reverse().find((r) => !gone(r));
    useApp.getState().setModal({
      kind: 'confirm',
      title: one ? `Delete “${baseOf(paths[0])}”?` : `Delete ${paths.length} items?`,
      body:
        `${one ? 'It' : 'They'} will be moved to the ${TRASH_LABEL}, where you can restore ${one ? 'it' : 'them'}.` +
        (dirty ? ` Unsaved changes in ${baseOf(dirty)} will be lost.` : ''),
      confirmLabel: IS_MAC ? 'Move to Trash' : 'Delete',
      danger: true,
      onConfirm: async () => {
        const r = await tryInvoke('fs:trash', { workspaceId: wsId, paths });
        if (r.error) return toast('error', r.error);
        const st = useApp.getState();
        for (const f of st.openFiles[wsId] ?? EMPTY_ARR) if (paths.some((p) => isUnder(f, p))) st.closeFile(wsId, f);
        await afterChange([], next ? [next.full] : []);
        focusTree();
      },
    });
  };

  // Cut/Copy the selection, or Paste into the selected folder (or file's folder).
  const clipboard = (kind: ClipKind, paths = selection, dir = dirOf(lead !== null && selected.has(lead) ? lead : null)) => {
    if (kind !== 'paste') {
      if (paths.length) setClip({ cut: kind === 'cut', paths });
    } else if (clip) {
      void transfer(clip.paths, dir, !clip.cut);
      if (clip.cut) setClip(null);
    }
  };
  // macOS routes ⌘C/⌘X/⌘V through the Edit menu, so the keydown never reaches
  // us — but the menu role's copy/cut/paste DOM event does, while the tree has focus.
  const clipboardRef = useRef(clipboard);
  clipboardRef.current = clipboard;
  useEffect(() => {
    if (isRemote) return;
    const kinds: ClipKind[] = ['copy', 'cut', 'paste'];
    const handlers = kinds.map((kind) => (e: Event) => {
      if (document.activeElement !== treeElRef.current) return;
      e.preventDefault();
      clipboardRef.current(kind);
    });
    kinds.forEach((k, i) => document.addEventListener(k, handlers[i]));
    return () => kinds.forEach((k, i) => document.removeEventListener(k, handlers[i]));
  }, [isRemote]);

  const copyPaths = async (paths: string[]) => {
    const abs = await Promise.all(paths.map((p) => tryInvoke('fs:absPath', { workspaceId: wsId, path: p })));
    const text = abs.flatMap((r) => (r.data?.path ? [r.data.path] : [])).join('\n');
    if (!text) return;
    await copyText(text);
    toast('success', paths.length > 1 ? `${paths.length} paths copied` : 'Path copied');
  };

  const openRow = (row: TreeRow) => (row.entry.dir ? toggle(row.full) : useApp.getState().openFile(wsId, row.full));

  const onRowClick = (e: React.MouseEvent, row: TreeRow) => {
    focusTree();
    if (!isRemote && e.shiftKey) return extendTo(row.full);
    if (!isRemote && (IS_MAC ? e.metaKey : e.ctrlKey)) {
      const n = new Set(selected);
      if (!n.delete(row.full)) n.add(row.full);
      setSelected(n);
      setLead(row.full);
      setAnchor(row.full);
      return;
    }
    select([row.full]);
    openRow(row);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // inline inputs handle their own keys
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const idx = lead === null ? -1 : rowIndex.get(lead) ?? -1;
    const cur = rows[idx];
    const go = (i: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!row) return;
      if (e.shiftKey && !isRemote) extendTo(row.full);
      else select([row.full]);
      scrollTo(row.full);
    };
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'ArrowDown' && mod && IS_MAC) {
      if (cur) openRow(cur); // ⌘↓ opens, as in Finder
    } else if (key === 'ArrowDown') go(idx + 1);
    else if (key === 'ArrowUp') go(idx < 0 ? rows.length - 1 : idx - 1);
    else if (key === 'Home') go(0);
    else if (key === 'End') go(rows.length - 1);
    else if (key === 'ArrowRight' && cur?.entry.dir) {
      if (expanded.has(cur.full)) go(idx + 1);
      else toggle(cur.full, true);
    } else if (key === 'ArrowLeft' && cur) {
      if (cur.entry.dir && expanded.has(cur.full)) toggle(cur.full, false);
      else if (parentOf(cur.full)) go(rowIndex.get(parentOf(cur.full)) ?? idx);
    } else if (key === 'Escape') {
      if (clip?.cut) setClip(null);
      else select([]);
    } else if (key === 'Enter' && cur && IS_MAC && !isRemote) setRenaming(cur.full);
    else if ((key === 'Enter' || key === ' ') && cur) openRow(cur);
    else if (isRemote) return;
    else if (key === 'F2' && cur) setRenaming(cur.full);
    else if ((key === 'Delete' || (key === 'Backspace' && mod)) && selection.length) remove(selection);
    else if (mod && key === 'c') clipboard('copy');
    else if (mod && key === 'x') clipboard('cut');
    else if (mod && key === 'v') clipboard('paste');
    else if (mod && key === 'd' && selection.length) void duplicate(selection);
    else return;
    e.preventDefault();
  };

  // ---- drag and drop ----
  const clearSpring = () => {
    if (springRef.current) clearTimeout(springRef.current.timer);
    springRef.current = null;
  };
  const endDrag = () => {
    dragRef.current = null;
    setDropTarget(null);
    clearSpring();
  };

  const onDragStart = (e: React.DragEvent, row: TreeRow) => {
    const paths = selected.has(row.full) ? selection : [row.full];
    if (!selected.has(row.full)) select([row.full]);
    dragRef.current = paths;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', paths.join('\n')); // dropping on a text field inserts the paths
    if (paths.length > 1) {
      const ghost = Object.assign(document.createElement('div'), {
        textContent: `${paths.length} items`,
        className: 'glass fixed -left-full rounded-full px-3 py-1 text-xs',
      });
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, -8, -8);
      setTimeout(() => ghost.remove());
    }
  };

  // `row` null = the empty area (root).
  const onDragOver = (e: React.DragEvent, row: TreeRow | null) => {
    const paths = dragRef.current;
    if (!paths && !e.dataTransfer.types.includes('Files')) return;
    e.stopPropagation();
    const dest = row ? (row.entry.dir ? row.full : parentOf(row.full)) : '';
    const asCopy = !paths || e.altKey;
    // Never into itself; a move must actually move something.
    if (paths && (paths.some((p) => isUnder(dest, p)) || (!asCopy && paths.every((p) => parentOf(p) === dest)))) {
      setDropTarget(null);
      return clearSpring();
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = asCopy ? 'copy' : 'move';
    setDropTarget(dest);
    if (!row?.entry.dir || expandedRef.current.has(row.full)) clearSpring();
    else if (springRef.current?.path !== row.full) {
      clearSpring();
      springRef.current = { path: row.full, timer: setTimeout(() => toggle(row.full, true), SPRING_MS) };
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const [dest, paths] = [dropTarget, dragRef.current];
    endDrag();
    if (dest === null) return;
    if (paths) return void transfer(paths, dest, e.altKey);
    const sources = [...e.dataTransfer.files].map((f) => window.maestro.pathForFile?.(f) ?? '').filter(Boolean);
    if (sources.length) void copy(sources, dest);
  };

  const dnd = !isRemote && renaming === null;
  const rootLoaded = tree[''] !== undefined;
  const ctxPaths = ctx?.path == null ? [] : selected.has(ctx.path) ? selection : [ctx.path];
  const newEntry = (dir: string, folder: boolean) => setCreating({ initial: dir && `${dir}/`, folder });
  return (
    <div
      className={clsx(
        'flex min-h-full flex-col px-2 py-2',
        dropTarget === '' && 'rounded-xl bg-accent-tint outline outline-1 -outline-offset-2 outline-accent/40'
      )}
      onDragOver={dnd ? (e) => onDragOver(e, null) : undefined}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) endDrag();
      }}
      onDrop={dnd ? onDrop : undefined}
      onContextMenu={
        isRemote
          ? undefined
          : (e) => {
              e.preventDefault();
              select([]);
              setCtx({ x: e.clientX, y: e.clientY, path: null });
            }
      }
    >
      {/* New file needs the local editor + filesystem, so remote workspaces skip it. */}
      {!isRemote && (
        <div className="flex items-center justify-between pb-1 pl-2.5 pr-1">
          <span className="text-2xs text-faint">Working tree</span>
          <button
            className="rounded-full p-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg"
            title="New file (end with / for a folder)"
            onClick={() => setCreating((c) => c ?? { initial: '', folder: false })}
          >
            <Plus size={14} />
          </button>
        </div>
      )}
      {creating !== null && (
        <NewEntryInput
          key={`${creating.initial}:${creating.folder}`}
          {...creating}
          onSubmit={create}
          onCancel={() => setCreating(null)}
        />
      )}
      {!rootLoaded && <div className="px-2.5 py-3 text-xs text-faint">Loading…</div>}
      {rootLoaded && rows.length === 0 && <div className="px-2.5 py-3 text-xs text-faint">Empty working tree.</div>}
      <div
        ref={treeElRef}
        role="tree"
        aria-multiselectable={!isRemote}
        tabIndex={0}
        className="space-y-px outline-none"
        onKeyDown={onKeyDown}
      >
        {rows.map((row) =>
          renaming === row.full ? (
            <RenameRow
              key={row.full}
              row={row}
              onSubmit={(name) => rename(row.full, name)}
              onCancel={() => {
                setRenaming(null);
                focusTree();
              }}
            />
          ) : (
            <FileTreeRow
              key={row.full}
              row={row}
              open={expanded.has(row.full)}
              busy={loading.has(row.full)}
              selected={selected.has(row.full)}
              dropTarget={!!dropTarget && isUnder(row.full, dropTarget)}
              dimmed={!!clip?.cut && clip.paths.some((p) => isUnder(row.full, p))}
              onClick={(e) => onRowClick(e, row)}
              onContextMenu={
                isRemote
                  ? undefined
                  : (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // Right-clicking outside the selection retargets it, like Finder / VS Code.
                      if (!selected.has(row.full)) select([row.full]);
                      setCtx({ x: e.clientX, y: e.clientY, path: row.full });
                    }
              }
              {...(dnd && {
                draggable: true,
                onDragStart: (e: React.DragEvent) => onDragStart(e, row),
                onDragEnd: endDrag,
                onDragOver: (e: React.DragEvent) => onDragOver(e, row),
                onDrop,
              })}
            />
          )
        )}
      </div>
      {/* Empty space below the rows: root drop zone + root context menu. */}
      <div className="min-h-8 flex-1" onClick={() => select([])} />
      {ctx && (
        <FileTreeContextMenu
          x={ctx.x}
          y={ctx.y}
          workspaceId={wsId}
          entry={ctx.path === null ? null : { path: ctx.path, dir: dirOf(ctx.path) === ctx.path }}
          paths={ctxPaths}
          canPaste={!!clip}
          onClose={() => setCtx(null)}
          onNew={(folder) => newEntry(dirOf(ctx.path), folder)}
          onRename={() => ctx.path && setRenaming(ctx.path)}
          onDuplicate={() => void duplicate(ctxPaths)}
          onDelete={() => remove(ctxPaths)}
          onClipboard={(kind) => clipboard(kind, ctxPaths, dirOf(ctx.path))}
          onCopyPaths={() => void copyPaths(ctxPaths)}
        />
      )}
    </div>
  );
}

/** Inline path input for new files/folders (Enter creates, Esc cancels). */
function NewEntryInput({
  initial,
  folder,
  onSubmit,
  onCancel,
}: {
  initial: string;
  folder: boolean;
  onSubmit: (path: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(await onSubmit(folder ? `${value.trim().replace(/\/+$/, '')}/` : value));
    setBusy(false);
  };
  return (
    <div className="px-1 pb-1.5">
      <input
        autoFocus
        className="input h-7 w-full font-mono text-2xs"
        placeholder={folder ? 'path/to/new-folder' : 'path/to/new-file.ts'}
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
          if (value.trim() === initial.trim() && !busy) onCancel();
        }}
      />
      <div className={clsx('px-1 pt-1 text-2xs', error ? 'text-err' : 'text-faint')}>
        {error ?? `Enter to create${folder ? ' folder' : ' · end with / for a folder'} · Esc to cancel`}
      </div>
    </div>
  );
}

/**
 * A tree row swapped for an input during inline rename, with the stem (name
 * before the extension) pre-selected like Finder. Enter commits and shows any
 * error inline; clicking away commits too (an invalid name then just reverts);
 * Esc cancels.
 */
function RenameRow({
  row,
  onSubmit,
  onCancel,
}: {
  row: TreeRow;
  onSubmit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(row.entry.name);
  const [error, setError] = useState<string | null>(null);
  const settled = useRef(false); // busy or finished — ignore further commits
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const dot = row.entry.dir ? -1 : row.entry.name.lastIndexOf('.');
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(0, dot > 0 ? dot : row.entry.name.length);
  }, [row.entry]);
  const commit = async (fromBlur: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const err = await onSubmit(value);
    if (!err) return;
    if (fromBlur) {
      useApp.getState().toast('error', err);
      onCancel();
    } else {
      settled.current = false;
      setError(err);
    }
  };
  return (
    <div style={{ paddingLeft: row.depth * 14 + 8 }} className="py-0.5 pr-1">
      <div className="flex items-center gap-1.5">
        <span className="w-[13px] shrink-0" />
        {row.entry.dir ? <Folder size={14} className="shrink-0 text-muted" /> : fileGlyph(row.entry.name)}
        <input
          ref={inputRef}
          aria-label={`Rename ${row.entry.name}`}
          className={clsx('input h-6 min-w-0 flex-1 px-1.5 text-[13px]', error && '!border-err')}
          value={value}
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') void commit(false);
            else if (e.key === 'Escape') {
              settled.current = true;
              onCancel();
            }
          }}
          onBlur={() => void commit(true)}
        />
      </div>
      {error && <div className="pl-[34px] pt-0.5 text-2xs text-err">{error}</div>}
    </div>
  );
}

function FileTreeRow({
  row,
  open,
  busy,
  selected,
  dropTarget,
  dimmed,
  ...rest
}: {
  row: TreeRow;
  open: boolean;
  busy: boolean;
  selected: boolean;
  dropTarget: boolean;
  dimmed: boolean;
} & React.HTMLAttributes<HTMLDivElement>) {
  const { entry } = row;
  return (
    <div
      {...rest}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={entry.dir ? open : undefined}
      data-path={row.full}
      data-motion="row"
      className={clsx(
        'flex w-full cursor-default select-none items-center gap-1.5 rounded-lg py-1 pr-2 text-[13px] transition-colors',
        dropTarget ? 'bg-accent-tint' : selected ? 'bg-accent-soft text-fg' : 'hover:bg-accent-soft',
        dimmed && 'opacity-50'
      )}
      style={{ paddingLeft: row.depth * 14 + 8 }}
      title={entry.name}
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
    </div>
  );
}

/**
 * Right-click menu for the Files tree. On one entry: open/reveal it on this
 * device, new file/folder, cut/copy/paste, duplicate, copy path, rename,
 * delete. With several selected it keeps only the actions that apply to all of
 * them; on the empty area (`entry` null) it offers root-level New / Paste.
 */
function FileTreeContextMenu({
  x,
  y,
  workspaceId,
  entry,
  paths,
  canPaste,
  onClose,
  onNew,
  onRename,
  onDuplicate,
  onDelete,
  onClipboard,
  onCopyPaths,
}: {
  x: number;
  y: number;
  workspaceId: string;
  entry: { path: string; dir: boolean } | null;
  paths: string[];
  canPaste: boolean;
  onClose: () => void;
  onNew: (folder: boolean) => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClipboard: (kind: ClipKind) => void;
  onCopyPaths: () => void;
}) {
  const item = (icon: React.ReactNode, label: React.ReactNode, run: () => void, opts: { kbd?: string; danger?: boolean } = {}) => (
    <MenuItem
      danger={opts.danger}
      onClick={() => {
        onClose();
        run();
      }}
    >
      {icon} {label}
      {opts.kbd && <span className="ml-auto pl-3 text-2xs text-faint">{opts.kbd}</span>}
    </MenuItem>
  );
  const icon = (I: typeof Copy) => <I size={15} className="text-muted" />;
  const multi = paths.length > 1;
  const { editors } = useEditors();
  const one = !multi && entry;
  const here = entry ? ' here' : '';
  return (
    <ContextMenu x={x} y={y} onClose={onClose} width={224}>
      {one && (
        <>
          {item(icon(FolderOpen), REVEAL_LABEL, () => void tryInvoke('fs:reveal', { workspaceId, path: one.path }))}
          {editors.map((ed, i) =>
            item(i === 0 ? <VSCodeMark size={15} className="text-muted" /> : <span className="w-[15px]" />, `Open in ${ed.label}`, async () => {
              const r = await tryInvoke('fs:openInIDE', { workspaceId, path: one.path, editor: ed.id });
              if (r.error) useApp.getState().toast('error', r.error);
            })
          )}
          {item(icon(Terminal), 'Open in terminal', () => void tryInvoke('fs:openTerminal', { workspaceId, path: one.path, dir: one.dir }))}
          {!one.dir && item(icon(ExternalLink), 'Open with default app', () => void tryInvoke('fs:open', { workspaceId, path: one.path }))}
          <MenuDivider />
        </>
      )}
      {!multi && (
        <>
          {item(icon(FilePlus), `New file${here}…`, () => onNew(false))}
          {item(icon(FolderPlus), `New folder${here}…`, () => onNew(true))}
          <MenuDivider />
        </>
      )}
      {paths.length > 0 && item(icon(Scissors), 'Cut', () => onClipboard('cut'), { kbd: `${MOD}X` })}
      {paths.length > 0 && item(icon(Copy), 'Copy', () => onClipboard('copy'), { kbd: `${MOD}C` })}
      {canPaste && item(icon(ClipboardPaste), 'Paste', () => onClipboard('paste'), { kbd: `${MOD}V` })}
      {paths.length > 0 && (
        <>
          {item(icon(CopyPlus), 'Duplicate', onDuplicate, { kbd: `${MOD}D` })}
          {item(icon(Link2), multi ? 'Copy paths' : 'Copy path', onCopyPaths)}
          <MenuDivider />
          {one && item(icon(Pencil), 'Rename…', onRename, { kbd: IS_MAC ? '↩' : 'F2' })}
          {item(<Trash2 size={15} />, multi ? `Delete ${paths.length} items` : 'Delete', onDelete, {
            kbd: IS_MAC ? '⌘⌫' : 'Del',
            danger: true,
          })}
        </>
      )}
    </ContextMenu>
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
                  'group flex h-7 min-w-0 items-center rounded-full text-xs font-medium transition-colors',
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
