import React, { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Archive,
  Clock,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Server,
  CircleDot,
  MessageSquare,
  MoreHorizontal,
  ChevronsLeft,
  ChevronsRight,
  Plus,
  RotateCcw,
  Settings,
  Smartphone,
  Trash2,
  Zap,
  AlertTriangle,
  DownloadCloud,
  Cloud,
  Check,
  Circle,
  Laptop,
} from 'lucide-react';
import { GitHubMark } from '../../shared/ui/brandIcons';
import { EMPTY_ARR, useApp, useActiveProject, useCaps, useIsDirect, useShowPr, type LiveTurn } from '../store/app';
import { askingAgents, turnKey } from '../lib/liveTurn';
import { DEFAULT_LAYOUT, LAYOUT_LIMITS } from '../lib/layoutPrefs';
import {
  ContextMenu,
  ContextMenuItem,
  DetailCard,
  DetailRow,
  MenuDivider,
  MenuItem,
  RenameInput,
  Resizer,
  ScrollingTitle,
  SessionStatusDot,
  Spinner,
  StatusStack,
  useCoversPreview,
  useDismiss,
  useHoverDetail,
} from './common';
import { Chevron, RepoIcon as SharedRepoIcon } from '../../shared/ui/primitives';
import { GLASS_CONTROL, LiquidGlass } from '../../shared/ui/LiquidGlass';
import { tryInvoke } from '../lib/api';
import { fmtStat } from '../../shared/ui/format';
import FeedbackPopover from './FeedbackPopover';
import { RailDropLine, setRowDragImage } from './ChatPanel';
import { mergeabilityUnknown } from '../lib/resolveConflicts';
import { StainedGlass } from '../../shared/ui/StainedGlass';
import {
  INDICATOR_LABEL,
  hasAnyStatus,
  projectStatusCounts,
  sessionIndicator,
  workspaceStatusCounts,
} from '../../shared/ui/status';
import type { ChatMeta, PrStatus, Project, Workspace } from '../../shared/types';
import { chatDisplayTitle } from '../../shared/chatTitle';
import { unwrapShellCommand } from '../../shared/harness/parse';

export default function Sidebar() {
  const collapsed = useApp((s) => s.settings.sidebarCollapsed);
  return collapsed ? <CollapsedSidebar /> : <ExpandedSidebar />;
}

function ExpandedSidebar() {
  const projects = useApp((s) => s.projects);
  const activeProject = useActiveProject();
  const workspaces = useApp((s) => s.workspaces);
  const plusOpen = useApp((s) => s.projectsMenuOpen);
  const setPlus = useApp((s) => s.setProjectsMenu);
  const setModal = useApp((s) => s.setModal);
  const feedbackOpen = useApp((s) => s.feedbackPanel.open);
  const conductorDetected = useApp((s) => s.conductorDetected);
  const harnessSyncDetected = useApp((s) => s.harnessSyncDetected);
  const showWorkspaces = useApp((s) => s.showWorkspaces);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const sidebarW = useApp((s) => s.layout.sidebar);

  useEffect(() => {
    if (activeProject) setExpanded((e) => (e[activeProject.id] ? e : { ...e, [activeProject.id]: true }));
  }, [activeProject?.id]);

  const archived = useMemo(
    () =>
      workspaces
        .filter((w) => w.projectId === activeProject?.id && w.archived)
        // most recent first
        .sort((a, b) => (b.lastUserMessageAt ?? b.createdAt) - (a.lastUserMessageAt ?? a.createdAt)),
    [workspaces, activeProject?.id]
  );
  const attention = workspaces.filter((w) => !w.archived && w.status === 'needs-attention');

  return (
    <aside
      data-morph="sidebar"
      className="relative flex shrink-0 flex-col"
      style={{ width: sidebarW }}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <Resizer
        axis="x"
        size={sidebarW}
        min={LAYOUT_LIMITS.sidebar.min}
        max={LAYOUT_LIMITS.sidebar.max}
        resetTo={DEFAULT_LAYOUT.sidebar}
        onResize={(w) => useApp.getState().setLayout({ sidebar: w })}
        onCommit={() => useApp.getState().commitLayout()}
        className="-right-1"
      />
      {/* traffic-light drag strip */}
      <div className="drag-region h-11 shrink-0" />

      {/* top nav: the global Workspaces browser (all branches, incl. archived) */}
      <div className="px-3">
        <button
          className={clsx(
            'no-drag flex w-full items-center gap-2 rounded-ctl px-2 py-1.5 text-[13px] transition-colors',
            showWorkspaces ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:bg-accent-soft hover:text-fg'
          )}
          onClick={() => useApp.getState().openWorkspacesView()}
        >
          <Clock size={15} className="shrink-0" />
          Workspaces
        </button>
      </div>
      <div className="h-3" />

      {/* Projects header + [+] menu (Conductor flow: Open / GitHub / Quick start) */}
      <div className="relative px-3">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs font-medium text-faint">Projects</span>
          <div className="flex items-center gap-0.5">
            <button
              className="no-drag rounded-ctl p-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg"
              title="Collapse sidebar"
              onClick={() => void useApp.getState().saveSettings({ sidebarCollapsed: true })}
            >
              <ChevronsLeft size={15} strokeWidth={1.5} />
            </button>
            <button
              className="no-drag rounded-ctl p-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg"
              title="Add project"
              onClick={() => setPlus(!plusOpen)}
            >
              <FolderPlus size={15} />
            </button>
          </div>
        </div>
        {plusOpen && (
          <Menu onClose={() => setPlus(false)}>
            <MenuItem
              big
              onClick={() => {
                setPlus(false);
                void useApp.getState().openLocalProject();
              }}
            >
              <Folder size={15} className="text-muted" /> Open project
            </MenuItem>
            <MenuItem
              big
              onClick={() => {
                setPlus(false);
                setModal({ kind: 'clone-repo' });
              }}
            >
              <GitHubMark size={15} className="text-muted" /> Open GitHub project
            </MenuItem>
            <MenuItem
              big
              onClick={() => {
                setPlus(false);
                setModal({ kind: 'remote-folder' });
              }}
            >
              <Server size={15} className="text-muted" /> Open remote folder…
            </MenuItem>
            <MenuItem
              big
              onClick={() => {
                setPlus(false);
                setModal({ kind: 'create-project' });
              }}
            >
              <FolderPlus size={15} className="text-muted" /> Quick start
            </MenuItem>
            {conductorDetected && (
              <MenuItem
                big
                onClick={() => {
                  setPlus(false);
                  setModal({ kind: 'conductor-import' });
                }}
              >
                <DownloadCloud size={15} className="text-muted" /> Import from Conductor…
              </MenuItem>
            )}
            {harnessSyncDetected && (
              <MenuItem
                big
                onClick={() => {
                  setPlus(false);
                  setModal({ kind: 'harness-sync' });
                }}
              >
                <DownloadCloud size={15} className="text-muted" /> Sync chats from Claude Code & Codex…
              </MenuItem>
            )}
          </Menu>
        )}
      </div>
      <HarnessSyncHint />

      {/* needs-attention glance */}
      {attention.length > 0 && (
        <button
          className="mx-3 mt-1 flex items-center gap-2 rounded-ctl border bg-raised px-2.5 py-1.5 text-left text-xs shadow-sm"
          onClick={() => {
            const ws = attention[0];
            useApp.getState().selectProject(ws.projectId);
            useApp.getState().selectWorkspace(ws.id);
          }}
        >
          <AlertTriangle size={13} className="shrink-0 text-warn" />
          <span className="truncate">
            {attention.length === 1 ? `${attention[0].name} needs attention` : `${attention.length} workspaces need attention`}
          </span>
        </button>
      )}

      {/* project groups */}
      <div className="mt-1 flex-1 overflow-y-auto px-3 pb-2">
        {projects.map((p) => (
          <ProjectGroup
            key={p.id}
            project={p}
            expanded={!!expanded[p.id]}
            onToggle={() => setExpanded((e) => ({ ...e, [p.id]: !e[p.id] }))}
          />
        ))}

        {/* history (active project) */}
        {archived.length > 0 && (
          <div className="mt-4">
            <button
              className="flex w-full items-center gap-1.5 px-2 py-1 text-xs font-medium text-faint hover:text-muted"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <Clock size={11} />
              History
              <span className="ml-auto">{archived.length}</span>
              <Chevron open={historyOpen} size={11} />
            </button>
            {historyOpen && (
              <div data-motion="collapse">
              {archived.map((ws) => (
                <div key={ws.id} data-motion="row" className="group flex items-center gap-2 rounded-ctl px-2 py-1.5 hover:bg-accent-soft">
                  <GitBranch size={13} aria-label="archived" className="shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-muted">{ws.title ?? (ws.wsKind === 'in-place' ? ws.name : ws.branch)}</div>
                    <div className="truncate font-mono text-2xs text-faint">
                      {ws.wsKind === 'in-place' ? 'in-place folder' : ws.branch}
                    </div>
                  </div>
                  <button
                    className="hidden rounded p-1 text-muted hover:text-fg group-hover:block"
                    title="Restore workspace (with chat history)"
                    onClick={() => void useApp.getState().restoreWorkspace(ws.id)}
                  >
                    <RotateCcw size={12} />
                  </button>
                  <button
                    className="hidden rounded p-1 text-muted hover:text-err group-hover:block"
                    title={ws.wsKind === 'in-place' ? 'Remove from Maestro (your folder is not touched)' : 'Delete permanently (removes worktree)'}
                    onClick={() =>
                      useApp.getState().setModal({
                        kind: 'confirm',
                        title: ws.wsKind === 'in-place' ? 'Remove workspace' : 'Delete workspace',
                        body:
                          ws.wsKind === 'in-place'
                            ? `Remove "${ws.name}" from Maestro? Your folder on disk is not touched — only the workspace bookkeeping and its chat history are removed.`
                            : `Permanently delete "${ws.name}"? This removes the worktree from disk (git worktree remove) and its chat history. The branch itself is kept in the repo.`,
                        confirmLabel: ws.wsKind === 'in-place' ? 'Remove' : 'Delete',
                        danger: true,
                        onConfirm: () => void useApp.getState().deleteWorkspace(ws.id),
                      })
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* footer — z-20 because LiquidGlass isolates, which would otherwise trap the
          feedback popover's z-50 beneath the (later-painted) stage. */}
      <LiquidGlass
        radius={16}
        {...GLASS_CONTROL}
        tint="light"
        className="sidebar-foot z-20 mx-2.5 mb-2.5 flex items-center gap-0.5 p-1"
      >
        <button className="btn btn-ghost flex-1 justify-start text-muted" onClick={() => setModal({ kind: 'settings' })}>
          <Settings size={13} /> Settings
        </button>
        <button
          className="btn btn-ghost text-muted"
          title="Set up Maestro Web on your phone"
          onClick={() => setModal({ kind: 'settings', tab: 'account' })}
        >
          <Smartphone size={13} />
        </button>
        <button
          className="btn btn-ghost text-muted"
          title="Send feedback"
          onClick={() => useApp.getState().openFeedback()}
        >
          <MessageSquare size={13} />
        </button>
        <GhBadge />
        {feedbackOpen && <FeedbackPopover />}
      </LiquidGlass>

      {ctxMenu && <SidebarContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)} />}
    </aside>
  );
}

/** Card popover that opens to the right of a thin-rail trigger. */
function FlyoutPanel({ children, className }: { children: React.ReactNode; className?: string }) {
  useCoversPreview(true);
  return (
    <div data-motion="pop" className={clsx('glass absolute left-full top-0 z-50 ml-2 origin-top-left overflow-hidden', className)}>
      {children}
    </div>
  );
}

/** Right-click dropdown for the sidebar (works collapsed or expanded). */
function SidebarContextMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const collapsed = useApp((s) => s.settings.sidebarCollapsed);
  const setModal = useApp((s) => s.setModal);
  const conductorDetected = useApp((s) => s.conductorDetected);
  const harnessSyncDetected = useApp((s) => s.harnessSyncDetected);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: x, top: Math.min(y, window.innerHeight - 300), zIndex: 60 }}
      data-motion="pop"
      className="glass w-56 origin-top-left overflow-hidden py-1.5"
    >
      <MenuItem
        onClick={() => {
          onClose();
          void useApp.getState().saveSettings({ sidebarCollapsed: !collapsed });
        }}
      >
        {collapsed ? <ChevronsRight size={15} strokeWidth={1.5} className="text-muted" /> : <ChevronsLeft size={15} strokeWidth={1.5} className="text-muted" />}
        {collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      </MenuItem>
      <MenuDivider />
      <MenuItem
        onClick={() => {
          onClose();
          void useApp.getState().openLocalProject();
        }}
      >
        <Folder size={15} className="text-muted" /> Open project…
      </MenuItem>
      <MenuItem
        onClick={() => {
          onClose();
          setModal({ kind: 'clone-repo' });
        }}
      >
        <GitHubMark size={15} className="text-muted" /> Open GitHub project…
      </MenuItem>
      <MenuItem
        onClick={() => {
          onClose();
          setModal({ kind: 'create-project' });
        }}
      >
        <FolderPlus size={15} className="text-muted" /> Quick start…
      </MenuItem>
      {conductorDetected && (
        <MenuItem
          onClick={() => {
            onClose();
            setModal({ kind: 'conductor-import' });
          }}
        >
          <DownloadCloud size={15} className="text-muted" /> Import from Conductor…
        </MenuItem>
      )}
      {harnessSyncDetected && (
        <MenuItem
          onClick={() => {
            onClose();
            setModal({ kind: 'harness-sync' });
          }}
        >
          <DownloadCloud size={15} className="text-muted" /> Sync chats from Claude Code & Codex…
        </MenuItem>
      )}
      <MenuDivider />
      <MenuItem
        onClick={() => {
          onClose();
          setModal({ kind: 'settings' });
        }}
      >
        <Settings size={15} className="text-muted" /> Settings…
      </MenuItem>
    </div>
  );
}

/** Thin icon-only rail: expand toggle, add-project, project avatars (with a
 *  workspace flyout on click), and settings. Right-click opens the full menu. */
function CollapsedSidebar() {
  const projects = useApp((s) => s.projects);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const setModal = useApp((s) => s.setModal);
  const feedbackOpen = useApp((s) => s.feedbackPanel.open);
  const conductorDetected = useApp((s) => s.conductorDetected);
  const harnessSyncDetected = useApp((s) => s.harnessSyncDetected);
  const showWorkspaces = useApp((s) => s.showWorkspaces);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  useDismiss(addOpen, () => setAddOpen(false), addRef);

  return (
    <aside
      data-morph="sidebar"
      className="relative flex w-14 shrink-0 flex-col items-center"
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="drag-region h-11 w-full shrink-0" />
      <button
        className="no-drag mb-1 grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg"
        title="Expand sidebar"
        onClick={() => void useApp.getState().saveSettings({ sidebarCollapsed: false })}
      >
        <ChevronsRight size={16} strokeWidth={1.5} />
      </button>

      <div ref={addRef} className="relative">
        <button
          className={clsx(
            'grid h-9 w-9 place-items-center rounded-full transition-colors',
            addOpen ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-accent-soft hover:text-fg'
          )}
          title="Add project"
          onClick={() => setAddOpen(!addOpen)}
        >
          <FolderPlus size={16} />
        </button>
        {addOpen && (
          <FlyoutPanel className="w-52 py-1.5">
            <MenuItem
              big
              onClick={() => {
                setAddOpen(false);
                void useApp.getState().openLocalProject();
              }}
            >
              <Folder size={15} className="text-muted" /> Open project
            </MenuItem>
            <MenuItem
              big
              onClick={() => {
                setAddOpen(false);
                setModal({ kind: 'clone-repo' });
              }}
            >
              <GitHubMark size={15} className="text-muted" /> Open GitHub project
            </MenuItem>
            <MenuItem
              big
              onClick={() => {
                setAddOpen(false);
                setModal({ kind: 'create-project' });
              }}
            >
              <FolderPlus size={15} className="text-muted" /> Quick start
            </MenuItem>
            {conductorDetected && (
              <MenuItem
                big
                onClick={() => {
                  setAddOpen(false);
                  setModal({ kind: 'conductor-import' });
                }}
              >
                <DownloadCloud size={15} className="text-muted" /> Import from Conductor…
              </MenuItem>
            )}
            {harnessSyncDetected && (
              <MenuItem
                big
                onClick={() => {
                  setAddOpen(false);
                  setModal({ kind: 'harness-sync' });
                }}
              >
                <DownloadCloud size={15} className="text-muted" /> Sync chats from Claude Code & Codex…
              </MenuItem>
            )}
          </FlyoutPanel>
        )}
      </div>

      <button
        className={clsx(
          'no-drag mt-1 grid h-9 w-9 place-items-center rounded-full transition-colors',
          showWorkspaces ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-accent-soft hover:text-fg'
        )}
        title="Workspaces"
        onClick={() => useApp.getState().openWorkspacesView()}
      >
        <Clock size={16} />
      </button>

      <div className="mx-auto my-2 w-5 border-t" />
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto py-1">
        {projects.map((p) => (
          <CollapsedProjectIcon key={p.id} project={p} active={p.id === activeProjectId} />
        ))}
      </div>

      <div className="relative flex w-full flex-col items-center gap-1 pb-3 pt-2">
        <button
          className="grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg"
          title="Set up Maestro Web on your phone"
          onClick={() => setModal({ kind: 'settings', tab: 'account' })}
        >
          <Smartphone size={16} />
        </button>
        <button
          className="grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg"
          title="Send feedback"
          onClick={() => useApp.getState().openFeedback()}
        >
          <MessageSquare size={16} />
        </button>
        <button
          className="grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg"
          title="Settings"
          onClick={() => setModal({ kind: 'settings' })}
        >
          <Settings size={16} />
        </button>
        {feedbackOpen && <FeedbackPopover />}
      </div>

      {ctxMenu && <SidebarContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)} />}
    </aside>
  );
}

/**
 * One project avatar in the collapsed rail. Hovering reveals a workspace flyout
 * (like a browser side-tab preview) — no click needed; clicking the icon just
 * jumps to the project. The flyout is `position: fixed` (anchored to the button's
 * rect) so it escapes the rail's vertical-scroll container instead of being clipped.
 * An open delay avoids flicker when the pointer passes over icons; a close delay
 * lets the pointer cross the gap into the flyout without it snapping shut.
 */
function CollapsedProjectIcon({ project, active }: { project: Project; active: boolean }) {
  const workspaces = useApp((s) => s.workspaces);
  const activeWsId = useApp((s) => s.activeWorkspaceId);
  const chatsMeta = useApp((s) => s.chatsMeta);
  const runningAgents = useApp((s) => s.runningAgents);
  const asking = askingAgents(useApp((s) => s.pendingAsks));
  const counts = projectStatusCounts(workspaces, project.id, chatsMeta, runningAgents, asking);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const list = workspaces.filter((w) => w.projectId === project.id && !w.archived);
  useCoversPreview(!!rect);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const openSoon = () => {
    clearTimer();
    if (rect) return; // already open — just cancel any pending close
    timer.current = setTimeout(() => setRect(btnRef.current?.getBoundingClientRect() ?? null), 120);
  };
  const closeSoon = () => {
    clearTimer();
    timer.current = setTimeout(() => setRect(null), 160);
  };
  useEffect(() => clearTimer, []);

  return (
    <div className="relative" onMouseEnter={openSoon} onMouseLeave={closeSoon}>
      {active && (
        <span className="pointer-events-none absolute -left-2 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-fg/70" />
      )}
      <button
        ref={btnRef}
        className={clsx(
          'flex h-10 w-10 items-center justify-center rounded-full transition-colors',
          active ? 'bg-accent-soft' : 'hover:bg-accent-soft'
        )}
        title={project.name}
        onClick={() => useApp.getState().selectProject(project.id)}
      >
        <RepoIcon project={project} active={active} />
      </button>
      {/* Inside the button bounds — the rail's scroll container clips overhang. */}
      <StatusStack counts={counts} size={11} vertical className="pointer-events-none absolute right-0 top-0 z-10" />
      {rect && (
        <div
          style={{ position: 'fixed', left: rect.right + 8, top: Math.min(rect.top, window.innerHeight - 340), zIndex: 50 }}
          data-motion="pop"
          className="glass w-64 origin-left overflow-hidden p-1.5"
        >
          <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
            <RepoIcon project={project} active />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">{project.name}</span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {list.length === 0 && <div className="px-2 py-2 text-2xs text-faint">No workspaces yet</div>}
            {list.map((ws, i) => (
              <WorkspaceRow key={ws.id} ws={ws} index={i} active={ws.id === activeWsId} onNavigate={() => setRect(null)} />
            ))}
            <NewWorkspaceButton project={project} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Quiet hint when harness sync is on and has found chats in a repo Maestro doesn't
 *  know (harness-chat-sync §4.2). Click opens the panel; dismiss remembers the root. */
function HarnessSyncHint() {
  const status = useApp((s) => s.harnessSyncStatus);
  const settings = useApp((s) => s.settings);
  const setModal = useApp((s) => s.setModal);
  const cand = status?.enabled ? status.candidates[0] : null;
  if (!cand) return null;
  const label = cand.root.replace(/^\/Users\/[^/]+/, '~');
  const app = cand.app === 'codex' ? 'Codex' : 'Claude Code';
  return (
    <div className="mx-3 mt-1 flex items-center gap-2 rounded-ctl border bg-raised px-2.5 py-1.5 text-2xs text-muted shadow-sm">
      <DownloadCloud size={13} className="shrink-0 text-faint" />
      <button
        className="min-w-0 flex-1 truncate text-left hover:text-fg"
        onClick={() => setModal({ kind: 'harness-sync' })}
        title={cand.root}
      >
        {cand.count} {app} chat{cand.count === 1 ? '' : 's'} in {label} — Add project
      </button>
      <button
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-accent-soft hover:text-fg"
        title="Dismiss"
        onClick={() =>
          void useApp.getState().saveSettings({
            harnessSync: {
              enabled: status!.enabled,
              dismissedRoots: [...(settings.harnessSync?.dismissedRoots ?? []), cand.root],
            },
          })
        }
      >
        ×
      </button>
    </div>
  );
}

/** GitHub repo avatar (owner identicon) when the origin is on GitHub; book icon
 *  otherwise. Thin wrapper over the shared RepoIcon that feeds it the owner from
 *  the store's projectOwners cache (web-desktop-parity spec §2.5). */
export function RepoIcon({ project, active }: { project: Project; active: boolean }) {
  const owner = useApp((s) => s.projectOwners[project.id]);
  return <SharedRepoIcon owner={owner ?? null} active={active} />;
}

function ProjectGroup({ project, expanded, onToggle }: { project: Project; expanded: boolean; onToggle: () => void }) {
  const activeProjectId = useApp((s) => s.activeProjectId);
  const workspaces = useApp((s) => s.workspaces);
  const activeWsId = useApp((s) => s.activeWorkspaceId);
  const chatsMeta = useApp((s) => s.chatsMeta);
  const runningAgents = useApp((s) => s.runningAgents);
  const asking = askingAgents(useApp((s) => s.pendingAsks));
  const [menuOpen, setMenuOpen] = useState(false);
  const active = project.id === activeProjectId;
  const list = workspaces.filter((w) => w.projectId === project.id && !w.archived);
  const counts = projectStatusCounts(workspaces, project.id, chatsMeta, runningAgents, asking);
  const { rect, hoverProps, hideHover } = useHoverDetail();
  // Drag-to-reorder: the dragged workspace and the row it would take the slot of.
  // Local state, so a drag only ever reorders within its own project.
  const [drag, setDrag] = useState<{ from: string; over: string } | null>(null);

  return (
    <div data-motion="row" className="relative mb-0.5">
      <div
        className={clsx(
          'group flex cursor-pointer items-center gap-1.5 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-accent-soft',
          active ? 'text-fg' : 'text-fg/85'
        )}
        onClick={() => {
          hideHover();
          if (!active) useApp.getState().selectProject(project.id);
          if (!expanded || active) onToggle();
        }}
        {...hoverProps}
      >
        <Chevron open={expanded} className="text-faint" />
        <RepoIcon project={project} active={active} />
        <ScrollingTitle text={project.name} className={clsx('min-w-0 flex-1 text-[13px]', active && 'font-medium')} />
        <StatusStack counts={counts} size={12} />
        <button
          className="hidden h-5 w-5 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg group-hover:grid"
          title="Project options"
          onClick={(e) => {
            e.stopPropagation();
            hideHover();
            setMenuOpen(true);
          }}
        >
          <MoreHorizontal size={13} />
        </button>
        <button
          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg"
          title={`New workspace in ${project.name}`}
          onClick={(e) => {
            e.stopPropagation();
            hideHover();
            useApp.getState().selectProject(project.id);
            useApp.getState().setModal({ kind: 'new-workspace' });
          }}
        >
          <Plus size={13} />
        </button>
      </div>

      {!menuOpen && (
        <DetailCard rect={rect}>
          <div className="text-[13px] font-semibold leading-snug break-words">{project.name}</div>
          <div className="mt-2 border-t pt-2">
            <div className="mb-1 text-xs font-medium text-faint">Branches</div>
            {list.length === 0 ? (
              <div className="text-2xs text-faint">No workspaces yet</div>
            ) : (
              <div className="space-y-1">
                {list.map((w) => {
                  const wc = workspaceStatusCounts(w, chatsMeta[w.id], runningAgents[w.id] ?? EMPTY_ARR, asking[w.id] ?? EMPTY_ARR);
                  return (
                    <div key={w.id} className="flex items-center gap-2 text-2xs">
                      <span className="min-w-0 flex-1 truncate text-muted">{w.title ?? w.branch}</span>
                      {hasAnyStatus(wc) ? (
                        <StatusStack counts={wc} size={11} />
                      ) : (
                        <span className="shrink-0 text-faint">Idle</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DetailCard>
      )}

      {menuOpen && (
        <Menu onClose={() => setMenuOpen(false)}>
          <MenuItem
            onClick={() => {
              setMenuOpen(false);
              useApp.getState().selectProject(project.id);
              useApp.getState().setModal({ kind: 'settings', tab: 'repository' });
            }}
          >
            <Settings size={13} className="text-muted" /> Repository settings…
          </MenuItem>
          <MenuDivider />
          <MenuItem
            danger
            onClick={() => {
              setMenuOpen(false);
              useApp.getState().setModal({
                kind: 'confirm',
                title: 'Remove project',
                body: `Remove "${project.name}" from Maestro? Worktrees and the repository stay on disk.`,
                confirmLabel: 'Remove',
                danger: true,
                onConfirm: () => {
                  void tryInvoke('project:remove', { projectId: project.id, deleteWorkspaces: false }).then(() =>
                    useApp.getState().refreshProjects()
                  );
                },
              });
            }}
          >
            <Trash2 size={13} /> Remove project…
          </MenuItem>
        </Menu>
      )}

      {expanded && (
        <div
          data-motion="collapse"
          className="ml-3 space-y-px pb-1 pl-1"
          onDragStart={(e) => {
            const row = e.target as HTMLElement;
            if (!row.dataset.wsId) return;
            setDrag({ from: row.dataset.wsId, over: row.dataset.wsId });
            e.dataTransfer.effectAllowed = 'move';
            setRowDragImage(e, row);
          }}
          onDragOver={(e) => {
            const over = (e.target as HTMLElement).closest<HTMLElement>('[data-ws-id]')?.dataset.wsId;
            if (!drag || !over) return;
            e.preventDefault();
            if (over !== drag.over) setDrag({ ...drag, over });
          }}
          onDrop={() => drag && useApp.getState().reorderWorkspace(drag.from, drag.over)}
          onDragEnd={() => setDrag(null)}
        >
          {list.map((ws, i) => (
            <WorkspaceRow
              key={ws.id}
              ws={ws}
              index={active ? i : -1}
              active={ws.id === activeWsId}
              dropLine={drag?.over !== ws.id || drag.from === ws.id ? null : list.findIndex((w) => w.id === drag.from) < i ? 'after' : 'before'}
            />
          ))}
          <NewWorkspaceButton project={project} />
        </div>
      )}
    </div>
  );
}

function NewWorkspaceButton({ project }: { project: Project }) {
  const [menu, setMenu] = useState(false);
  const caps = useCaps(project.id);
  const showPr = useShowPr(project.id);
  // A folder project's single in-place workspace, if this is one.
  const folderWs = useApp((s) =>
    caps.worktrees ? undefined : s.workspaces.find((w) => w.projectId === project.id && !w.archived)
  );
  const open = (from?: 'branch' | 'pr' | 'issue' | 'linear' | 'direct') => {
    useApp.getState().selectProject(project.id);
    useApp.getState().setModal({ kind: 'new-workspace', from });
  };

  // Folder projects have no worktrees — "New workspace" becomes "New chat" (a new
  // agent in the single in-place workspace, the existing multi-chat flow).
  if (!caps.worktrees) {
    return (
      <button
        className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] text-faint transition-colors hover:bg-accent-soft hover:text-fg"
        onClick={() => {
          if (!folderWs) return;
          useApp.getState().selectProject(project.id);
          useApp.getState().selectWorkspace(folderWs.id);
          useApp.getState().newChat(folderWs.id);
        }}
      >
        <Plus size={13} /> New chat
      </button>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center">
        <button
          className="flex flex-1 items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] text-faint transition-colors hover:bg-accent-soft hover:text-fg"
          onClick={() => open()}
        >
          <Plus size={13} /> New workspace
        </button>
        <button
          className="grid h-7 w-7 place-items-center rounded-full text-faint transition-colors hover:bg-accent-soft hover:text-fg"
          title="New workspace from branch / PR / issue"
          onClick={() => setMenu((v) => !v)}
        >
          <MoreHorizontal size={13} />
        </button>
      </div>
      {menu && (
        <Menu onClose={() => setMenu(false)}>
          {(
            [
              { icon: <GitBranch size={13} />, label: 'From branch…', from: 'branch', show: caps.git },
              { icon: <GitPullRequest size={13} />, label: 'From pull request…', from: 'pr', show: showPr },
              { icon: <CircleDot size={13} />, label: 'From GitHub issue…', from: 'issue', show: showPr },
              { icon: <Zap size={13} />, label: 'From Linear issue…', from: 'linear', show: true },
              {
                icon: <FolderOpen size={13} />,
                label: 'Existing working directory (no worktree)…',
                from: 'direct',
                show: caps.git && !project.hostId,
              },
            ] as const
          )
            .filter((item) => item.show)
            .map((item) => (
              <MenuItem
                key={item.label}
                onClick={() => {
                  setMenu(false);
                  open(item.from);
                }}
              >
                <span className="text-muted">{item.icon}</span> {item.label}
              </MenuItem>
            ))}
        </Menu>
      )}
    </div>
  );
}

/** Open (non-closed) sessions of a workspace, each with its display status. */
function listSessions(chats: Record<string, ChatMeta> | undefined, running: number[], asking: number[]) {
  const ids = new Set<number>([...running, ...asking]);
  for (const k of Object.keys(chats ?? {})) ids.add(Number(k));
  return [...ids]
    .filter((id) => !chats?.[String(id)]?.closed)
    .sort((a, b) => a - b)
    .map((id) => ({
      id,
      // No messages in scope here; a title-less chat reads "New chat" until the
      // boot backfill fills it (§7). Never a synthetic "Chat N".
      title: chatDisplayTitle(chats?.[String(id)]),
      status: sessionIndicator(chats?.[String(id)], running.includes(id), asking.includes(id)),
    }));
}

/**
 * A tab's PR at a glance. The live `prStatus` (loaded only for the workspace
 * that's been opened) enriches the persisted `ws.prState/prNumber/prUrl` that
 * every workspace carries — so a tab reads its PR state even before it's opened,
 * and gains draft/conflict detail once its full status is fetched.
 */
interface PrView {
  hasPr: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED' | null;
  number: number | null;
  url: string | null;
  conflicting: boolean;
  /** Live status in hand, but GitHub hasn't said yet whether it merges cleanly. */
  checking: boolean;
  draft: boolean;
}

function prView(ws: Workspace, pr: PrStatus | null | undefined): PrView {
  const number = pr?.number ?? ws.prNumber;
  return {
    hasPr: number != null,
    state: pr?.state ?? ws.prState,
    number,
    url: pr?.url ?? ws.prUrl,
    conflicting: pr?.mergeable === 'CONFLICTING',
    // Only when the full status was actually fetched: a tab that has never been
    // opened has no `pr` at all, and that's "unloaded", not "unknown".
    checking: !!pr && pr.state === 'OPEN' && mergeabilityUnknown(pr.mergeable),
    draft: pr?.isDraft ?? false,
  };
}

/** At-a-glance PR status glyph, colored like the right panel's PR badge. */
function SidebarPrIcon({ view }: { view: PrView }) {
  if (!view.hasPr) return null;
  if (view.state === 'MERGED') return <GitMerge size={12} className="shrink-0 text-st-merged" aria-label="PR merged" />;
  if (view.state === 'CLOSED') return <GitPullRequest size={12} className="shrink-0 text-err" aria-label="PR closed" />;
  const cls = view.conflicting ? 'text-warn' : view.draft ? 'text-muted' : 'text-ok';
  return <GitPullRequest size={12} className={clsx('shrink-0', cls)} aria-label="PR open" />;
}

function prTitleText(view: PrView): string {
  const n = view.number != null ? `#${view.number}` : 'PR';
  if (view.state === 'MERGED') return `${n} · merged`;
  if (view.state === 'CLOSED') return `${n} · closed`;
  if (view.conflicting) return `${n} · conflicts`;
  if (view.draft) return `${n} · draft`;
  return `${n} · open`;
}

/**
 * The tab's one-click PR action, mirroring the right panel's primary button in
 * whatever mode the PR is in: Create PR when there's none, Merge (squash) when
 * one is open and clean, or Resolve-conflicts (open on GitHub) when it isn't.
 * Merged/closed PRs have no forward action here — the archive button covers it.
 */
function WorkspacePrAction({ ws, view, hasChanges }: { ws: Workspace; view: PrView; hasChanges: boolean }) {
  const creatingPr = useApp((s) => s.creatingPr[ws.id] ?? false);
  const [merging, setMerging] = useState(false);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (!view.hasPr) {
    const disabled = creatingPr || !hasChanges;
    return (
      <button
        className="grid h-6 w-6 place-items-center rounded-full bg-raised text-muted shadow-sm hover:text-fg disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted"
        title={hasChanges ? 'Commit changes & create pull request' : 'No changes yet — nothing to open a PR for'}
        disabled={disabled}
        onClick={(e) => {
          stop(e);
          void useApp.getState().createPr(ws.id);
        }}
      >
        {creatingPr ? <Spinner /> : <GitPullRequest size={12} />}
      </button>
    );
  }

  if (view.state === 'OPEN' && view.conflicting && view.url) {
    return (
      <a
        className="grid h-6 w-6 place-items-center rounded-full bg-raised text-warn shadow-sm hover:text-warn"
        href={view.url}
        target="_blank"
        rel="noreferrer"
        title={`${view.number != null ? `#${view.number} ` : ''}has merge conflicts — resolve on GitHub`}
        onClick={stop}
      >
        <GitMerge size={12} />
      </a>
    );
  }

  if (view.state === 'OPEN') {
    const merge = async () => {
      setMerging(true);
      await useApp.getState().squashMergePr(ws.id, view.number);
      setMerging(false);
    };
    return (
      <button
        className="grid h-6 w-6 place-items-center rounded-full bg-raised text-ok shadow-sm hover:text-ok disabled:opacity-40"
        title={`Squash & merge PR${view.number != null ? ` #${view.number}` : ''}`}
        disabled={merging}
        onClick={(e) => {
          stop(e);
          void merge();
        }}
      >
        {merging ? <Spinner /> : <GitMerge size={12} />}
      </button>
    );
  }

  return null; // MERGED / CLOSED — archive handles cleanup
}

/** Move a conversation on/off the cloud (§6.6). null = bring local. The move is
 *  async; the row updates itself via ws:updated. */
async function moveWorkspaceCloud(workspaceId: string, hostId: string | null): Promise<void> {
  const app = useApp.getState();
  const cost =
    hostId === null
      ? 'Bring this conversation back to your machine?\n\nThe agent starts a fresh session locally, seeded with this conversation’s history — the next message will take longer while it re-reads context. Branch and uncommitted changes come back.'
      : 'Run this conversation in the cloud?\n\nThe agent starts a fresh session on the server, seeded with this conversation’s history — the next message will take longer and use more tokens while it re-reads context. Branch and uncommitted changes move; chat history stays local.';
  if (!confirm(cost)) return;
  const r = await tryInvoke('workspace:setCloud', { workspaceId, hostId });
  if (r.error || r.data?.ok === false) app.toast('error', r.error || r.data?.error || 'Move failed');
}

function WorkspaceRow({
  ws,
  index,
  active,
  onNavigate,
  dropLine,
}: {
  ws: Workspace;
  index: number;
  active: boolean;
  onNavigate?: () => void;
  /** Where the drag-to-reorder marker sits; undefined where rows aren't draggable (rail flyout). */
  dropLine?: 'before' | 'after' | null;
}) {
  const runningList = useApp((s) => s.runningAgents[ws.id]) ?? EMPTY_ARR;
  const askingList = useApp((s) => askingAgents(s.pendingAsks)[ws.id]) ?? EMPTY_ARR;
  const question = useApp((s) =>
    askingList.length ? s.pendingAsks[turnKey(ws.id, askingList[0])]?.questions[0]?.question : undefined
  );
  const chats = useApp((s) => s.chatsMeta[ws.id]);
  const project = useApp((s) => s.projects.find((p) => p.id === ws.projectId));
  const defaultCloudHost = useApp((s) => s.settings.cloud?.hostId ?? null);
  const cloudHost = useApp((s) => (ws.hostId ? s.hosts.find((h) => h.id === ws.hostId) : undefined));
  // Cloud toggle eligibility: a branch workspace of a local git project (§6.6).
  const cloudConversation = !!ws.hostId && !project?.hostId;
  const cloudEligible = !project?.hostId && project?.kind === 'git' && ws.wsKind === 'worktree' && !ws.archived;
  const liveTurn = useApp((s) =>
    runningList.length ? s.liveTurns[`${ws.id}:${runningList[runningList.length - 1]}`] : undefined
  );
  const stat = useApp((s) => s.diffStats[ws.id]);
  const pr = useApp((s) => s.prStatus[ws.id]);
  const direct = useIsDirect(ws);
  // No merge/resolve shortcuts on a direct workspace (the user's own checkout).
  const showPr = useShowPr(ws.projectId) && !direct;
  const view = prView(ws, pr);
  const inPlace = ws.wsKind === 'in-place';
  const status = ws.status === 'idle' && runningList.length > 0 ? 'running' : ws.status;
  const counts = workspaceStatusCounts(ws, chats, runningList, askingList);
  const merged = counts.merged > 0;
  // A clean open PR is one click from done — surface that as a green merge
  // button in the icon slot, same pattern as the merged→archive prompt.
  // "Clean" has to mean GitHub said so: while it's still computing mergeability
  // this button was the loudest place a conflicted PR read as ready to merge.
  const readyToMerge = showPr && !merged && view.state === 'OPEN' && !view.conflicting && !view.draft && !view.checking;
  // Its conflicted counterpart. Shell workspaces have no agent to dispatch, so
  // they keep the hover link to GitHub instead.
  const needsResolve = showPr && !merged && view.state === 'OPEN' && view.conflicting && ws.harness !== 'shell';
  const sessions = listSessions(chats, runningList, askingList);

  // Title from the first prompt; subtitle = live activity or last thing done.
  // In-place (folder) workspaces have no branch — fall back to the folder name.
  const title = ws.title ?? (inPlace ? ws.name : ws.branch);
  const subtitle =
    ws.status === 'setting-up'
      ? inPlace
        ? 'Preparing workspace…'
        : 'Setting up worktree…'
      : question
        ? `Asks: ${question}`
        : runningList.length > 0
          ? liveActivity(liveTurn)
        : (ws.subtitle ?? (ws.title ? (inPlace ? ws.name : ws.branch) : ws.name));

  const hasStat = !!stat && (stat.additions > 0 || stat.deletions > 0);
  const [editing, setEditing] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const unread = counts.unread > 0;
  const { rect, hoverProps, hideHover } = useHoverDetail();

  return (
    <div
      data-motion="row"
      className={clsx(
        'group relative flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 transition-colors',
        active ? 'tab-lit' : 'hover:bg-accent-soft/60'
      )}
      onClick={
        editing
          ? undefined
          : () => {
              useApp.getState().selectProject(ws.projectId);
              useApp.getState().selectWorkspace(ws.id);
              onNavigate?.();
            }
      }
      onDoubleClick={
        inPlace
          ? undefined // no branch to rename on an in-place folder workspace
          : (e) => {
              e.preventDefault();
              hideHover();
              setEditing(true);
            }
      }
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation(); // don't fall through to the sidebar-level context menu
        hideHover();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
      data-ws-id={ws.id}
      draggable={dropLine !== undefined && !editing}
      onDragStart={hideHover}
      {...hoverProps}
    >
      {dropLine && <RailDropLine edge={dropLine} />}
      <StatusStack counts={merged ? { ...counts, merged: 0 } : counts} />
      {merged && <ArchiveMergedButton ws={ws} />}
      {readyToMerge && <MergePrButton ws={ws} view={view} />}
      {needsResolve && <ResolveConflictsButton ws={ws} />}
      {editing ? (
        <RenameInput
          initial={ws.branch}
          mono
          onCommit={(name) => {
            setEditing(false);
            if (name && name !== ws.branch) {
              void tryInvoke('workspace:renameBranch', { workspaceId: ws.id, branch: name }).then((r) => {
                if (r.error) useApp.getState().toast('error', r.error);
              });
            }
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ScrollingTitle text={title} className={clsx('min-w-0 flex-1 text-[13px]', active && 'font-medium')} />
            {cloudConversation && (
              <span
                className="flex shrink-0 items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-medium text-muted group-hover:hidden"
                title={`Runs in the cloud${cloudHost ? ` on ${cloudHost.label}` : ''} — keeps going when Maestro is closed`}
              >
                <Cloud size={9} /> Cloud
              </span>
            )}
            {direct && (
              <span
                className="flex shrink-0 items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-medium text-muted group-hover:hidden"
                title={`Works directly in ${ws.worktreePath} — no worktree or branch. Sessions here share the same files, so simultaneous edits can conflict.`}
              >
                <FolderOpen size={9} /> Direct
              </span>
            )}
            {view.hasPr && (
              <span className="shrink-0 group-hover:hidden" title={prTitleText(view)}>
                <SidebarPrIcon view={view} />
              </span>
            )}
            {hasStat && (
              <span className="shrink-0 font-mono text-2xs group-hover:hidden">
                <span className="text-ok">+{fmtStat(stat!.additions)}</span>{' '}
                <span className="text-err">-{fmtStat(stat!.deletions)}</span>
              </span>
            )}
          </div>
          <div
            className={clsx(
              'truncate text-2xs text-faint',
              question ? 'text-st-asking' : runningList.length > 0 && 'text-st-running'
            )}
          >
            {subtitle}
          </div>
        </div>
      )}
      {!editing && (
        <div className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 items-center gap-1 group-hover:flex">
          {/* ready-to-merge and conflicted rows already carry their PR action in the icon slot */}
          {showPr && !readyToMerge && !needsResolve && <WorkspacePrAction ws={ws} view={view} hasChanges={hasStat} />}
          {/* merged rows already carry a purple archive button in the icon slot */}
          {!merged && (
            <button
              className="grid h-6 w-6 place-items-center rounded-full bg-raised text-muted shadow-sm hover:text-fg"
              title="Archive workspace"
              onClick={(e) => {
                e.stopPropagation();
                void useApp.getState().archiveWorkspace(ws.id);
              }}
            >
              <Archive size={12} />
            </button>
          )}
        </div>
      )}
      {!editing && (
        <DetailCard rect={rect}>
          <div className="text-[13px] font-semibold leading-snug break-words">{title}</div>
          <div className="mt-1 flex items-center gap-1.5 break-all font-mono text-2xs text-muted">
            <GitBranch size={11} className="shrink-0 text-faint" />
            {ws.branch}
          </div>
          <div className="mt-2 space-y-1 border-t pt-2 text-2xs">
            <DetailRow label="Workspace" value={ws.name} />
            <DetailRow label="Status" value={status} />
            {hasStat && (
              <DetailRow
                label="Changes"
                value={
                  <>
                    <span className="text-ok">+{stat!.additions}</span> <span className="text-err">-{stat!.deletions}</span>
                  </>
                }
              />
            )}
            {ws.prNumber != null && (
              <DetailRow
                label="Pull request"
                value={ws.prState === 'MERGED' ? `#${ws.prNumber} · merged` : `#${ws.prNumber}`}
              />
            )}
            {index >= 0 && index < 9 && <DetailRow label="Shortcut" value={`⌘${index + 1}`} />}
          </div>
          <div className="mt-2 border-t pt-2">
            <div className="mb-1 text-xs font-medium text-faint">Sessions</div>
            {sessions.length === 0 ? (
              <div className="text-2xs text-faint">No sessions yet</div>
            ) : (
              <div className="space-y-1">
                {sessions.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 text-2xs">
                    <SessionStatusDot status={s.status} />
                    <span className="min-w-0 flex-1 truncate text-muted">{s.title}</span>
                    <span className="shrink-0 text-faint">{s.status ? INDICATOR_LABEL[s.status] : 'Idle'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {subtitle && <div className="mt-2 border-t pt-2 text-2xs text-muted line-clamp-3">{subtitle}</div>}
        </DetailCard>
      )}
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          {unread ? (
            <ContextMenuItem onClick={() => { setCtxMenu(null); useApp.getState().markWorkspaceRead(ws.id); }}>
              <Check size={14} className="text-muted" /> Mark as read
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onClick={() => { setCtxMenu(null); useApp.getState().markWorkspaceUnread(ws.id); }}>
              <Circle size={14} className="fill-st-unread text-st-unread" /> Mark as unread
            </ContextMenuItem>
          )}
          {cloudEligible && (cloudConversation ? (
            <ContextMenuItem onClick={() => { setCtxMenu(null); void moveWorkspaceCloud(ws.id, null); }}>
              <Laptop size={14} className="text-muted" /> Bring local
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              onClick={() => {
                setCtxMenu(null);
                if (!defaultCloudHost) {
                  useApp.getState().toast('error', 'Pick a cloud server in Settings → Cloud first.');
                  useApp.getState().setModal({ kind: 'settings', tab: 'cloud' });
                  return;
                }
                void moveWorkspaceCloud(ws.id, defaultCloudHost);
              }}
            >
              <Cloud size={14} className="text-muted" /> Run in cloud
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </div>
  );
}

/**
 * A ready-to-merge branch's icon slot: a green squash-merge button, the
 * counterpart of the merged→archive prompt. Without it an idle branch with a
 * clean open PR looked identical to one with nothing going on, even though
 * it's one click from done.
 */
function MergePrButton({ ws, view }: { ws: Workspace; view: PrView }) {
  const [merging, setMerging] = useState(false);
  const label = `Ready to merge — squash & merge PR${view.number != null ? ` #${view.number}` : ''}`;
  return (
    <StainedGlass
      as="button"
      tone="ok"
      radius={5}
      ripple={merging}
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center transition active:scale-95"
      title={label}
      aria-label={label}
      disabled={merging}
      onClick={(e) => {
        e.stopPropagation();
        setMerging(true);
        void useApp.getState().squashMergePr(ws.id, view.number).finally(() => setMerging(false));
      }}
    >
      {merging ? <Spinner size={11} className="!text-current" /> : <GitMerge size={11} />}
    </StainedGlass>
  );
}

/**
 * A conflicted PR's icon slot: an amber button that sends the agent to resolve
 * the conflicts (the right panel's Resolve conflicts). The click bubbles to the
 * row on purpose, opening the workspace so the resolving turn is visible.
 */
function ResolveConflictsButton({ ws }: { ws: Workspace }) {
  const resolving = useApp((s) => !!s.resolvingPr[ws.id]);
  const label = resolving ? 'The agent is resolving the conflicts…' : 'Merge conflicts — send the agent to resolve them';
  return (
    <StainedGlass
      as="button"
      tone="warn"
      radius={5}
      ripple={resolving}
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center transition active:scale-95"
      title={label}
      aria-label={label}
      disabled={resolving}
      onClick={() => void useApp.getState().startConflictResolution(ws.id)}
    >
      {resolving ? <Spinner size={11} className="!text-current" /> : <GitMerge size={11} />}
    </StainedGlass>
  );
}

/**
 * A merged branch's icon slot: the purple status dot becomes a purple archive
 * button. Merged is a terminal state, so the indication doubles as the one
 * action left — clearing the branch out of the sidebar. Rounded-rectangular on
 * purpose: circles are status, rounded rects are buttons — it should read as
 * clickable at a glance.
 */
function ArchiveMergedButton({ ws }: { ws: Workspace }) {
  return (
    <StainedGlass
      as="button"
      tone="merged"
      radius={5}
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center transition active:scale-95"
      title="Merged — archive this workspace"
      aria-label="Merged — archive this workspace"
      onClick={(e) => {
        e.stopPropagation();
        void useApp.getState().archiveWorkspace(ws.id);
      }}
    >
      <Archive size={11} />
    </StainedGlass>
  );
}

/** What the agent is doing right now, from the live stream. */
function liveActivity(t: LiveTurn | undefined): string {
  if (!t) return 'Working…';
  const blocks = [...t.finalBlocks, ...t.deltaBlocks];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'tool') {
      const input = (b.input ?? {}) as Record<string, unknown>;
      if ((b.name === 'Bash' || b.name === 'shell') && input.command)
        return `$ ${unwrapShellCommand(String(input.command)).slice(0, 48)}`;
      const p = input.file_path ?? input.path ?? input.pattern ?? input.query;
      return p ? `${b.name} · ${String(p).split('/').pop()}` : b.name;
    }
  }
  if (t.accumType === 'thinking') return 'Thinking…';
  if (t.accumText || blocks.some((b) => b.type === 'text')) return 'Writing…';
  return 'Thinking…';
}

function GhBadge() {
  const gh = useApp((s) => s.ghAuth);
  const [broken, setBroken] = useState(false);
  if (gh.authenticated) {
    // The signed-in GitHub account as an avatar, like an account chip — the
    // handle lives in the tooltip so the footer never overflows.
    return (
      <span
        className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-ink text-2xs font-semibold text-on-ink"
        title={`GitHub: @${gh.user}`}
      >
        {gh.user && !broken ? (
          <img
            src={`https://avatars.githubusercontent.com/${gh.user}?s=56`}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          (gh.user ?? '?').charAt(0).toUpperCase()
        )}
      </span>
    );
  }
  return (
    <button
      className="gh-signin flex items-center gap-1 rounded-ctl px-2 py-1 text-2xs text-warn hover:bg-accent-soft"
      title="Sign in with GitHub — enables cloning, PRs, checks and pushes"
      onClick={() => void useApp.getState().startGithubSignIn()}
    >
      <GitHubMark size={12} />
      Sign in to GitHub
    </button>
  );
}

export function Menu({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  return (
    <div ref={ref} data-motion="pop" className="glass absolute left-2 right-2 z-40 mt-1 overflow-hidden py-1.5">
      {children}
    </div>
  );
}
