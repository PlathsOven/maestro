import React, { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Archive,
  DownloadCloud,
  FileDiff,
  FolderGit2,
  GitPullRequest,
  ListChecks,
  MessageSquare,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { useApp, capsOf } from '../store/app';
import { StatusDot } from './common';
import { formatShortcut, type ShortcutId } from '../../shared/shortcuts';
import { useShortcuts } from '../lib/shortcuts';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  action: () => void;
}

export default function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const workspaces = useApp((s) => s.workspaces);
  const projects = useApp((s) => s.projects);
  const activeWsId = useApp((s) => s.activeWorkspaceId);
  const projectCaps = useApp((s) => s.projectCaps);
  const ghAuthed = useApp((s) => s.ghAuth.authenticated);
  const conductorDetected = useApp((s) => s.conductorDetected);
  const harnessSyncDetected = useApp((s) => s.harnessSyncDetected);
  const theme = useApp((s) => s.resolvedTheme);
  // Hints resolve from the registry (§9), so a rebound key updates here and the
  // stale hand-typed combos (⌘⇧T for Terminal → really ⌘J) can't drift.
  const keys = useShortcuts();
  const platform = useApp((s) => s.platform);
  const hk = (id: ShortcutId) => formatShortcut(keys[id], platform) || undefined;

  useEffect(() => {
    if (open) {
      setQuery('');
      setIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const close = () => useApp.getState().setPalette(false);

  const items = useMemo<Item[]>(() => {
    const s = useApp.getState();
    const list: Item[] = [];
    for (const ws of workspaces.filter((w) => !w.archived)) {
      const project = projects.find((p) => p.id === ws.projectId);
      list.push({
        id: `ws-${ws.id}`,
        label: ws.branch || ws.name,
        hint: `${project?.name ?? ''} · ${ws.name}`,
        icon: <StatusDot status={ws.status} pulse={false} />,
        action: () => {
          if (ws.projectId !== s.activeProjectId) s.selectProject(ws.projectId);
          s.selectWorkspace(ws.id);
        },
      });
    }
    // Gate git/PR commands on the active workspace's project rung.
    const activeWs = workspaces.find((w) => w.id === activeWsId);
    const caps = capsOf({ projectCaps, projects }, activeWs?.projectId);
    const showPr = caps.githubRemote && ghAuthed;
    const wsActions: Item[] = activeWsId
      ? ([
          { id: 'a-chat', label: 'Go to Chat', hint: hk('focus-composer'), icon: <MessageSquare size={13} />, action: () => { s.setTab(activeWsId, 'chat'); s.focusComposer(); }, show: true },
          { id: 'a-new-chat', label: 'New Chat', hint: hk('new-chat'), icon: <MessageSquare size={13} />, action: () => { s.setTab(activeWsId, 'chat'); s.newChat(activeWsId); }, show: true },
          { id: 'a-term', label: 'Open Terminal', hint: hk('tab-terminal'), icon: <TerminalIcon size={13} />, action: () => s.openDockTerminal(activeWsId), show: true },
          { id: 'a-diff', label: 'Open Diff Viewer', hint: hk('tab-diff'), icon: <FileDiff size={13} />, action: () => s.setTab(activeWsId, 'diff'), show: caps.git },
          { id: 'a-checks', label: 'Open Checks', hint: hk('tab-checks'), icon: <ListChecks size={13} />, action: () => s.setRightTab(activeWsId, 'checks'), show: showPr },
          { id: 'a-review-agent', label: 'Start Review Agent (new chat)', icon: <ListChecks size={13} />, action: () => void s.startReviewAgent(activeWsId), show: caps.git },
          { id: 'a-pr', label: 'Create Pull Request', hint: hk('create-pr'), icon: <GitPullRequest size={13} />, action: () => void s.createPr(activeWsId), show: showPr },
          { id: 'a-archive', label: 'Archive Workspace', icon: <Archive size={13} />, action: () => void s.archiveWorkspace(activeWsId), show: true },
        ] as (Item & { show: boolean })[]).filter((a) => a.show)
      : [];
    return [
      ...list,
      { id: 'a-new-ws', label: 'New Workspace', hint: hk('new-workspace'), icon: <Plus size={13} />, action: () => s.setModal({ kind: 'new-workspace' }) },
      ...wsActions,
      { id: 'a-open-project', label: 'Open Project…', icon: <FolderGit2 size={13} />, action: () => void s.openLocalProject() },
      { id: 'a-clone-repo', label: 'Open GitHub Project…', icon: <FolderGit2 size={13} />, action: () => s.setModal({ kind: 'clone-repo' }) },
      { id: 'a-remote-folder', label: 'Open Remote Folder…', icon: <FolderGit2 size={13} />, action: () => s.setModal({ kind: 'remote-folder' }) },
      { id: 'a-create-project', label: 'Quick Start Project…', icon: <FolderGit2 size={13} />, action: () => s.setModal({ kind: 'create-project' }) },
      ...(conductorDetected
        ? [{ id: 'a-conductor-import', label: 'Import from Conductor…', icon: <DownloadCloud size={13} />, action: () => s.setModal({ kind: 'conductor-import' }) }]
        : []),
      ...(harnessSyncDetected
        ? [{ id: 'a-harness-sync', label: 'Sync chats from Claude Code & Codex…', icon: <DownloadCloud size={13} />, action: () => s.setModal({ kind: 'harness-sync' }) }]
        : []),
      {
        id: 'a-theme',
        label: theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme',
        icon: theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />,
        action: () => void s.saveSettings({ theme: theme === 'dark' ? 'light' : 'dark' }),
      },
      { id: 'a-settings', label: 'Settings', hint: hk('settings'), icon: <Settings size={13} />, action: () => s.setModal({ kind: 'settings' }) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, projects, activeWsId, projectCaps, ghAuthed, conductorDetected, harnessSyncDetected, theme, keys, platform]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return items;
    return items.filter((i) => (i.label + ' ' + (i.hint ?? '')).toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => setIdx(0), [filtered.length]);

  if (!open) return null;

  return (
    <div
      className="glass-scrim fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[16vh]"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="glass glass-panel fade-in w-[560px] overflow-hidden">
        <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
          <Search size={14} className="text-muted" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
            placeholder="Jump to workspace or run a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && filtered[idx]) {
                close();
                filtered[idx].action();
              }
            }}
          />
        </div>
        <div className="max-h-[380px] overflow-y-auto py-1.5">
          {filtered.length === 0 && <div className="px-4 py-3 text-xs text-faint">No matches</div>}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              className={clsx(
                'flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left text-[13px]',
                i === idx ? 'bg-accent-soft' : ''
              )}
              onMouseEnter={() => setIdx(i)}
              onClick={() => {
                close();
                item.action();
              }}
            >
              <span className="flex w-4 shrink-0 items-center justify-center text-muted">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-2xs text-faint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
