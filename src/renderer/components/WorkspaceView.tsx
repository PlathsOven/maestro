import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  DownloadCloud,
  FileCode,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  Globe,
  MessageSquare,
  FileDiff,
  Pencil,
  Repeat,
  Server,
  AlertTriangle,
} from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { hostAddress } from '../lib/hosts';
import { EMPTY_ARR, useApp, useCaps } from '../store/app';
import { COLLAPSED_RIGHT_RAIL } from '../lib/layoutPrefs';
import { ContextMenu, ContextMenuItem, MenuDivider, MenuItem, Segmented, Spinner, StatusDot } from './common';
import { useEditors } from '../lib/editors';
import { VSCodeMark } from '../../shared/ui/brandIcons';
import { GLASS_CONTROL, LiquidGlass } from '../../shared/ui/LiquidGlass';
import { StainedDot } from '../../shared/ui/StainedGlass';
import { Menu } from './Sidebar';
import type { BranchInfo, Workspace } from '../../shared/types';
import { formatShortcut, type ShortcutId } from '../../shared/shortcuts';
import { useShortcuts } from '../lib/shortcuts';
import ChatPanel from './ChatPanel';
import DiffViewer from './DiffViewer';
import RunScriptEditor from './RunScriptEditor';

// The whole editor surface (Monaco + notebook renderer) is a lazy chunk — its
// parse cost is paid on first file open, never at app startup.
const EditorSurface = React.lazy(() => import('./EditorSurface'));
// The Preview surface (embedded browser toolbar + annotate canvas) is likewise a
// lazy chunk — zero cost until the surface is first opened (§5.1, §13).
const PreviewSurface = React.lazy(() => import('./PreviewSurface'));

export default function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const tab = useApp((s) => s.tabByWs[workspace.id] ?? 'chat');
  const running = useApp((s) => (s.runningAgents[workspace.id] ?? []).length > 0);
  const project = useApp((s) => s.projects.find((p) => p.id === workspace.projectId));
  const caps = useCaps(workspace.projectId);
  // Effective host: a per-conversation cloud override (workspace.hostId) wins over
  // the project's host, so a cloud workspace of a local project shows the badge too.
  const effHostId = workspace.hostId ?? project?.hostId ?? null;
  const cloudConversation = !!workspace.hostId && !project?.hostId;
  const host = useApp((s) => (effHostId ? s.hosts.find((h) => h.id === effHostId) : undefined));
  const hostState = useApp((s) => (effHostId ? s.hostStates[effHostId] : undefined));
  const editingScriptId = useApp((s) => s.editingScript[workspace.id] ?? null);
  const hasOpenFiles = useApp((s) => (s.openFiles[workspace.id] ?? EMPTY_ARR).length > 0);
  const preview = useApp((s) => s.previewByWs[workspace.id]);
  const portUp = useApp((s) => !!s.portUpByWs[workspace.id]);
  const keys = useShortcuts();
  const platform = useApp((s) => s.platform);
  // Tab tooltips read their combo from the registry (§9), so a rebind updates them.
  const tabTip = (label: string, id: ShortcutId) => {
    const f = formatShortcut(keys[id], platform);
    return f ? `${label} (${f})` : label;
  };
  // Something to look at: the port answers, Chromium has a page, or an agent is
  // driving the pane right now (screenshots, clicks) — §5.
  const previewLive =
    portUp || (!!preview && !preview.error && !!preview.url) || !!preview?.agentActive || !!preview?.openedByAgent;
  // Width of the right panel sitting between this header and the window edge —
  // the collapsed 48px rail is narrower than the Windows window-control overlay,
  // so the leftover spills onto the header's buttons (see .wco-safe).
  const rightRail = useApp((s) => (s.settings.rightPanelCollapsed ? COLLAPSED_RIGHT_RAIL : s.layout.right));
  const [diffVisited, setDiffVisited] = useState(tab === 'diff');
  const [editorVisited, setEditorVisited] = useState(tab === 'editor');
  const [previewVisited, setPreviewVisited] = useState(tab === 'preview');

  // An adopted (Conductor) workspace is an in-place workspace on a git project —
  // the only way to get one. Its directory is Conductor's, so Maestro never
  // removes it; but Conductor can archive it out from under us (§4/§6.3).
  const isAdopted = project?.kind === 'git' && workspace.wsKind === 'in-place';
  const [dirMissing, setDirMissing] = useState(false);
  useEffect(() => {
    if (!isAdopted) {
      setDirMissing(false);
      return;
    }
    let alive = true;
    void tryInvoke('workspace:dirExists', { workspaceId: workspace.id }).then((r) => {
      if (alive) setDirMissing(r.data === false);
    });
    return () => {
      alive = false;
    };
  }, [isAdopted, workspace.id, workspace.worktreePath]);

  // An archived workspace whose worktree was offloaded to save disk has nothing
  // on disk until restored — only its chat is viewable (archive-disk-reclaim.md).
  const freed = !!workspace.filesFreed;
  // A diff is available for git projects and for folder projects with shadow-git
  // checkpoints (§7 Phase 5); a stale 'diff' tab on a plain folder falls back.
  const showDiff = (caps.git || caps.checkpoints) && !freed;
  const mode: 'chat' | 'diff' | 'editor' | 'preview' =
    freed ? 'chat' : tab === 'diff' && showDiff ? 'diff' : tab === 'editor' ? 'editor' : tab === 'preview' ? 'preview' : 'chat';
  useEffect(() => {
    if (mode === 'diff') setDiffVisited(true);
    if (mode === 'editor') setEditorVisited(true);
    if (mode === 'preview') setPreviewVisited(true);
  }, [mode]);

  const status = workspace.status === 'idle' && running ? 'running' : workspace.status;
  const hostDown = !!(host && hostState && hostState !== 'connected');
  // Chat scrolls under the header, which floats as glass (scroll-edge fade, no
  // border). Diff/editor/preview keep it in flow: the preview is a native view
  // that can't sit under HTML, and the others pin their own toolbars.
  // A banner under the header (host down, archived) needs it in flow too.
  const floatHeader = mode === 'chat' && !hostDown && !workspace.archived;

  return (
    <div data-motion="swap" className="relative flex h-full min-w-0 flex-col">
      {/* breadcrumb header: status · project · branch, with the view toggles and
          window actions on the right. The PR lifecycle action (Create PR → Merge →
          Continue/Archive) now lives at the top of the right panel. */}
      <header
        className={clsx(
          'ws-head drag-region flex h-11 shrink-0 items-center gap-2 px-4',
          floatHeader ? 'scroll-edge-top absolute inset-x-0 top-0 z-20' : 'border-b'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot status={status} />
          {host && (
            <span
              className={clsx(
                'flex min-w-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-2xs font-medium',
                hostState === 'connected' || hostState === undefined ? 'text-muted' : hostState === 'error' || hostState === 'disconnected' ? 'text-err' : 'text-warn'
              )}
              title={`${cloudConversation ? 'Cloud · ' : ''}${hostAddress(host)} — ${hostState ?? 'connecting'}`}
            >
              <Server size={11} className="shrink-0" />
              <span className="truncate">{cloudConversation ? `Cloud · ${host.label}` : hostAddress(host)}</span>
            </span>
          )}
          <span className="shrink-[0.2] truncate text-[13px] text-muted">{project?.name}</span>
          <ChevronRight size={12} className="shrink-0 text-faint" />
          {caps.git ? (
            <>
              <BranchMenu workspace={workspace} />
              {isAdopted && (
                <span
                  className="flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-2xs font-medium text-muted"
                  title="Adopted from Conductor — Maestro opened this existing worktree in place. Deleting the workspace here never removes the directory."
                >
                  <DownloadCloud size={10} /> adopted
                </span>
              )}
            </>
          ) : (
            <span
              className="flex min-w-0 items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-2xs font-medium text-muted"
              title="Agents work directly in this folder — no branches or diffs. They have direct access under the current permission mode."
            >
              <FolderOpen size={11} className="shrink-0" />
              <span className="truncate">in-place · direct access</span>
            </span>
          )}
          {workspace.setupError && (
            <span className="truncate text-2xs text-err" title={workspace.setupError}>
              setup failed
            </span>
          )}
        </div>
        <div className="flex-1" />
        <div className="no-drag wco-safe flex items-center gap-1" style={{ '--wco-rail': `${rightRail}px` } as React.CSSProperties}>
          {/* center mode toggle: Chat · Diff (git/checkpoints) · Editor (once a
              file is open) · Preview (always). The Globe button is retired — the
              embedded preview lives right here (§5.1). */}
          {!freed && (
            <>
              <Segmented<'chat' | 'diff' | 'editor' | 'preview'>
                size="md"
                className="mr-1"
                value={mode}
                onChange={(id) =>
                  id === 'preview' ? useApp.getState().openPreview(workspace.id) : useApp.getState().setTab(workspace.id, id)
                }
                options={(
                  [
                    { id: 'chat', icon: <MessageSquare size={12} />, label: 'Chat', title: tabTip('Chat', 'tab-chat') },
                    ...(showDiff
                      ? [{ id: 'diff' as const, icon: <FileDiff size={12} />, label: 'Diff', title: tabTip('Diff viewer', 'tab-diff') }]
                      : []),
                    ...(hasOpenFiles || mode === 'editor'
                      ? [{ id: 'editor' as const, icon: <FileCode size={12} />, label: 'Editor', title: tabTip('Editor', 'tab-editor') }]
                      : []),
                    { id: 'preview' as const, icon: <Globe size={12} />, label: 'Preview', title: tabTip('Preview', 'tab-preview') },
                  ] as { id: 'chat' | 'diff' | 'editor' | 'preview'; icon: React.ReactNode; label: string; title: string }[]
                ).map((m) => ({
                  value: m.id,
                  title: m.title,
                  label: (
                    <>
                      {m.icon}
                      {m.label}
                      {/* There's something to show and the user isn't looking (§5): the
                          dev server is up, Chromium has a page, or an agent is driving
                          the pane. Same expanding halo as the running-status dots. */}
                      {m.id === 'preview' && mode !== 'preview' && previewLive && (
                        <StainedDot tone="running" size={6} ripple className="!absolute right-0.5 top-0.5" />
                      )}
                    </>
                  ),
                }))}
              />
              <LiquidGlass radius={999} {...GLASS_CONTROL} tint="clear" className="lg-float flex items-center p-[3px]">
                <OpenInButton workspaceId={workspace.id} />
                <HeaderBtn title="Reveal in Finder" onClick={() => void tryInvoke('workspace:reveal', { workspaceId: workspace.id })}>
                  <FolderOpen size={13} />
                </HeaderBtn>
              </LiquidGlass>
            </>
          )}
        </div>
      </header>

      {/* SSH connection banner — shown while a remote host is down/reconnecting. */}
      {hostDown && host && (
        <div
          data-motion="collapse"
          className={clsx(
            'flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-2xs',
            hostState === 'connecting' ? 'text-warn' : 'text-err'
          )}
        >
          <Server size={12} />
          {hostState === 'connecting'
            ? `Connecting to ${hostAddress(host)}…`
            : `Disconnected from ${hostAddress(host)} — reconnecting…`}
        </div>
      )}

      {workspace.archived && <ArchivedBanner workspace={workspace} />}

      {/* center: chat (with chat tabs) or diff review */}
      <div
        className="relative min-h-0 flex-1"
        style={floatHeader ? ({ '--chrome-top': '44px' } as React.CSSProperties) : undefined}
      >
        <div data-motion="swap" className={clsx('absolute inset-0', mode !== 'chat' && 'hidden')}>
          <ChatPanel workspace={workspace} />
        </div>
        {diffVisited && (
          <div data-motion="swap" className={clsx('absolute inset-0', mode !== 'diff' && 'hidden')}>
            <DiffViewer workspace={workspace} active={mode === 'diff'} />
          </div>
        )}
        {editorVisited && (
          <div data-motion="swap" className={clsx('absolute inset-0', mode !== 'editor' && 'hidden')}>
            <React.Suspense
              fallback={
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
                  <Spinner /> Loading editor…
                </div>
              }
            >
              <EditorSurface workspace={workspace} active={mode === 'editor'} />
            </React.Suspense>
          </div>
        )}
        {previewVisited && (
          <div className={clsx('absolute inset-0', mode !== 'preview' && 'hidden')}>
            <React.Suspense
              fallback={
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
                  <Spinner /> Loading preview…
                </div>
              }
            >
              <PreviewSurface workspace={workspace} active={mode === 'preview'} />
            </React.Suspense>
          </div>
        )}
        {/* run-script editor: opened by clicking a card in the Run tab */}
        {editingScriptId && (
          <div data-motion="fade" className="absolute inset-0 z-10 bg-bg">
            <RunScriptEditor workspace={workspace} scriptId={editingScriptId} />
          </div>
        )}
        {/* Adopted workspace whose Conductor directory vanished (archived there).
            The branch survives, so offer to recreate it as a Maestro worktree. */}
        {dirMissing && <AdoptedMissing workspace={workspace} onGone={() => setDirMissing(false)} />}
      </div>
    </div>
  );
}

/** Archived workspaces stay browsable; this says so and offers the way back. */
function ArchivedBanner({ workspace }: { workspace: Workspace }) {
  const restoring = workspace.status === 'setting-up';
  return (
    <div data-motion="collapse" className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-2xs text-muted">
      <Archive size={12} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {workspace.filesFreed
          ? 'Archived — files cleared to save disk space. Restoring brings back the branch, uncommitted changes and local files.'
          : 'Archived.'}{' '}
        Sending a message restores it too.
      </span>
      <button
        className="btn h-6 shrink-0 px-2.5 text-2xs"
        disabled={restoring}
        onClick={() => void useApp.getState().restoreWorkspace(workspace.id)}
      >
        {restoring ? 'Restoring…' : 'Restore'}
      </button>
    </div>
  );
}

function AdoptedMissing({ workspace, onGone }: { workspace: Workspace; onGone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg p-8">
      <div className="w-[440px] rounded-card border bg-raised/40 p-6 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-warn/15 text-warn">
          <AlertTriangle size={20} />
        </div>
        <div className="text-[15px] font-semibold">This workspace was archived in Conductor</div>
        <div className="mx-auto mt-1.5 max-w-[360px] text-[13px] text-muted">
          Its directory is gone, but branch <span className="font-mono text-xs text-fg">{workspace.branch}</span> still
          exists. Recreate it as a fresh Maestro worktree to keep going, or remove the workspace from Maestro.
        </div>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            className="btn h-8 text-xs"
            disabled={busy}
            onClick={() => {
              useApp.getState().setModal({
                kind: 'confirm',
                title: 'Remove from Maestro',
                body: `Remove "${workspace.name}"? Its chats and bookkeeping are deleted. Nothing on disk is touched.`,
                confirmLabel: 'Remove',
                danger: true,
                onConfirm: () => void useApp.getState().deleteWorkspace(workspace.id),
              });
            }}
          >
            Remove from Maestro
          </button>
          <button
            className="btn btn-accent h-8 text-xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await useApp.getState().recreateAdoptedWorkspace(workspace.id);
              setBusy(false);
              onGone(); // the row is now a normal worktree; drop the takeover
            }}
          >
            {busy ? 'Recreating…' : 'Recreate from branch'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Open in <editor>": a click opens the worktree in the default editor; the
 *  chevron lists every detected editor, and picking one makes it the default. */
function OpenInButton({ workspaceId }: { workspaceId: string }) {
  const { editors, current } = useEditors();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const open = async (editor?: string) => {
    const r = await tryInvoke('workspace:openInIDE', { workspaceId, editor });
    if (r.error) useApp.getState().toast('error', r.error);
  };
  return (
    <>
      <HeaderBtn title={`Open in ${current.label}`} onClick={() => void open()}>
        <VSCodeMark size={13} />
      </HeaderBtn>
      {editors.length > 1 && (
        <button
          className="-ml-1.5 grid h-7 w-4 shrink-0 place-items-center rounded-full text-faint transition-colors hover:text-fg"
          title="Open in…"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 200, y: r.bottom + 6 });
          }}
        >
          <ChevronDown size={11} />
        </button>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {editors.map((ed) => (
            <ContextMenuItem
              key={ed.id}
              onClick={() => {
                setMenu(null);
                void open(ed.id);
              }}
            >
              Open in {ed.label}
              {ed.id === current.id && <Check size={13} className="ml-auto text-muted" />}
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  );
}

function HeaderBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg" title={title} onClick={onClick}>
      {children}
    </button>
  );
}

type BranchMode = 'closed' | 'menu' | 'rename' | 'create' | 'switch';

/** Branch operations from within the workspace: rename, new branch, switch. */
function BranchMenu({ workspace }: { workspace: Workspace }) {
  const [mode, setMode] = useState<BranchMode>('closed');
  const [draft, setDraft] = useState(workspace.branch);
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const toast = useApp((s) => s.toast);

  useEffect(() => setDraft(workspace.branch), [workspace.branch]);

  useEffect(() => {
    if (mode === 'switch' && branches === null) {
      void tryInvoke('project:branches', { projectId: workspace.projectId }).then((r) => setBranches(r.data ?? []));
    }
  }, [mode, branches, workspace.projectId]);

  const rename = async () => {
    setMode('closed');
    const name = draft.trim();
    if (!name || name === workspace.branch) return;
    const res = await tryInvoke('workspace:renameBranch', { workspaceId: workspace.id, branch: name });
    if (res.error) toast('error', res.error);
  };

  const createBranch = async () => {
    setMode('closed');
    const name = draft.trim();
    if (!name || name === workspace.branch) return;
    const res = await tryInvoke('workspace:switchBranch', { workspaceId: workspace.id, branch: name, create: true });
    if (res.error) toast('error', res.error);
    else if (!res.data?.ok) toast('error', res.data?.conflict ?? 'Could not create branch');
    else toast('success', `Created and switched to ${name}`);
  };

  const switchTo = async (name: string) => {
    setMode('closed');
    const local = name.replace(/^origin\//, '');
    const res = await tryInvoke('workspace:switchBranch', { workspaceId: workspace.id, branch: local, create: false });
    if (res.error) toast('error', res.error);
    else if (!res.data?.ok) {
      useApp.getState().setModal({
        kind: 'branch-conflict',
        workspaceId: workspace.id,
        branch: local,
        message: res.data?.conflict ?? '',
      });
    } else toast('success', `Switched to ${local}`);
  };

  if (mode === 'rename' || mode === 'create') {
    return (
      <input
        autoFocus
        className="input no-drag h-7 w-72 !rounded-full px-3 py-0 font-mono text-xs"
        placeholder={mode === 'create' ? 'new branch name (git checkout -b)' : 'branch name (git branch -m)'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setMode('closed')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void (mode === 'rename' ? rename() : createBranch());
          if (e.key === 'Escape') {
            setDraft(workspace.branch);
            setMode('closed');
          }
        }}
      />
    );
  }

  return (
    <div className="no-drag relative min-w-0">
      <button
        className={clsx(
          'group flex h-7 min-w-0 items-center gap-1.5 rounded-full px-1.5 transition-colors hover:bg-accent-soft',
          mode !== 'closed' && 'bg-accent-soft'
        )}
        title={`${workspace.branch} · workspace ${workspace.name} — branch actions`}
        onClick={() => setMode(mode === 'closed' ? 'menu' : 'closed')}
      >
        <GitBranch size={13} className="shrink-0 text-faint" />
        <span className="truncate text-[13px] font-semibold tracking-tight">{workspace.branch}</span>
        <ChevronDown size={11} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
      {mode === 'menu' && (
        <div className="absolute left-0 top-full z-40 w-72">
          <Menu onClose={() => setMode('closed')}>
            <MenuItem onClick={() => { setDraft(workspace.branch); setMode('rename'); }}>
              <Pencil size={12} className="text-muted" /> Rename branch…
            </MenuItem>
            <MenuItem onClick={() => { setDraft(''); setMode('create'); }}>
              <GitBranchPlus size={12} className="text-muted" /> New branch from here…
            </MenuItem>
            <MenuItem onClick={() => setMode('switch')}>
              <Repeat size={12} className="text-muted" /> Switch branch…
            </MenuItem>
          </Menu>
        </div>
      )}
      {mode === 'switch' && (
        <div className="absolute left-0 top-full z-40 w-72">
          <Menu onClose={() => setMode('closed')}>
            <div className="max-h-64 overflow-y-auto">
              {branches === null && <div className="px-3.5 py-2 text-xs text-faint">Loading branches…</div>}
              {branches?.filter((b) => b.name !== workspace.branch).map((b) => (
                <MenuItem key={b.name} onClick={() => void switchTo(b.name)}>
                  <GitBranch size={12} className="text-muted" />
                  <span className="truncate font-mono text-xs">{b.name}</span>
                </MenuItem>
              ))}
            </div>
            <MenuDivider />
            <div className="px-3.5 py-1.5 text-2xs text-faint">One branch per worktree — conflicts offer a “-2” copy.</div>
          </Menu>
        </div>
      )}
    </div>
  );
}
