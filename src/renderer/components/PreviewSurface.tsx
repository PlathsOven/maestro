import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe,
  Lock,
  MoreVertical,
  PenLine,
  Play,
  RotateCw,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { invoke, tryInvoke } from '../lib/api';
import { useApp } from '../store/app';
import { Menu, MenuItem, MenuDivider } from './Sidebar';
import AnnotateOverlay from './AnnotateOverlay';
import { matchesShortcut } from '../../shared/shortcuts';
import { useShortcuts } from '../lib/shortcuts';
import type { ConsoleEntry, ConsoleLevel, Workspace } from '../../shared/types';

type Rect = { x: number; y: number; width: number; height: number };
const rectOf = (r: DOMRect): Rect => ({ x: r.left, y: r.top, width: r.width, height: r.height });
const isRefused = (e?: { code: number; description: string } | null) =>
  !!e && (e.code === -102 || /CONNECTION_REFUSED/i.test(e.description));

/**
 * The Preview center surface (§5): a toolbar + an OS-composited `WebContentsView`
 * that floats above this placeholder. Because the view sits above the DOM, we
 * hide it (setVisible) whenever an overlay owns the screen — a modal, the command
 * palette, annotate mode, an error card, the toolbar's overflow menu, or another
 * center mode.
 */
export default function PreviewSurface({ workspace, active }: { workspace: Workspace; active: boolean }) {
  const wsId = workspace.id;
  const preview = useApp((s) => s.previewByWs[wsId]);
  const annotating = useApp((s) => s.annotate?.wsId === wsId);
  const overlayOwnsScreen = useApp((s) => s.modal !== null || s.paletteOpen);
  const layout = useApp((s) => s.layout);
  const agentId = useApp((s) => s.composerAgent[wsId] ?? 1);
  const runScripts = useApp((s) => s.runScripts[wsId]);
  const portUp = useApp((s) => !!s.portUpByWs[wsId]);
  const keys = useShortcuts();
  const platform = useApp((s) => s.platform);

  const holderRef = useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [addr, setAddr] = useState('');

  const live = !!preview;
  const err = preview?.error ?? null;
  const refused = isRefused(err);
  // The view floats above the DOM, so it must be hidden for any DOM overlay
  // (empty/error card, annotate frame, the toolbar's overflow menu) or app
  // overlay to be visible.
  const shouldShow = active && live && !overlayOwnsScreen && !annotating && !err && !overflow;

  useEffect(() => setAddr(preview?.url ?? ''), [preview?.url]);

  // Make sure the Run cards are loaded so the empty-state hint is accurate and
  // "Start dev server" can find the run script even if the Run dock was never opened.
  useEffect(() => {
    if (useApp.getState().runScripts[wsId] === undefined) void useApp.getState().loadRunScripts(wsId);
  }, [wsId]);

  const navigate = (action: 'goto' | 'back' | 'forward' | 'reload' | 'stop', url?: string) =>
    void invoke('preview:navigate', { workspaceId: wsId, action, url });

  const measure = (): Rect | null => {
    const el = holderRef.current;
    return el ? rectOf(el.getBoundingClientRect()) : null;
  };

  // Continuous bounds sync while a view exists — the placeholder resizes with any
  // Resizer drag (sidebar/right/dock) or window resize (§4 bounds sync).
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    let raf = 0;
    const push = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const b = measure();
        if (b) void invoke('preview:setBounds', { workspaceId: wsId, bounds: b });
      });
    };
    const ro = new ResizeObserver(push);
    ro.observe(el);
    window.addEventListener('resize', push);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', push);
      cancelAnimationFrame(raf);
    };
  }, [wsId]);

  // Show/hide the view (and re-anchor its bounds on show). Runs on every input to
  // `shouldShow` — mode flip, overlay open/close, annotate, error, layout drag.
  useEffect(() => {
    if (!live) return;
    if (shouldShow) {
      const b = measure();
      if (b) void invoke('preview:setBounds', { workspaceId: wsId, bounds: b });
    }
    void invoke('preview:setVisible', { workspaceId: wsId, visible: shouldShow });
  }, [shouldShow, live, wsId, layout]);

  // Hide on unmount (workspace switch) so a background view never floats over the
  // next workspace.
  useEffect(() => () => void invoke('preview:setVisible', { workspaceId: wsId, visible: false }), [wsId]);

  // Auto-retry while the dev server is down: re-navigate the workspace URL every
  // few seconds so the card flips live the moment the server comes up (§5.3).
  useEffect(() => {
    if (!active || !refused) return;
    const url = preview?.url || `http://localhost:${workspace.port}`;
    const t = setInterval(() => navigate('goto', url), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, refused, wsId]);

  // The port just came up (§5.4): heal the "Nothing is listening" card at once
  // rather than waiting for the next 2.5s retry tick.
  useEffect(() => {
    if (!active || !refused || !portUp) return;
    navigate('goto', preview?.url || `http://localhost:${workspace.port}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portUp, active, refused, wsId]);

  const go = () => {
    let u = addr.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    navigate('goto', u);
  };

  const startDevServer = () => void useApp.getState().startDevServer(wsId);

  const toggleAnnotate = () => {
    const st = useApp.getState();
    if (st.annotate?.wsId === wsId) return st.cancelAnnotate();
    const b = measure();
    if (!b || !live || err) return;
    void st.startAnnotate(wsId, agentId, b.width, b.height);
  };

  // Annotate-preview shortcut (⌘⇧A by default) while the surface is active (§9).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, keys['preview.annotate'], platform)) {
        e.preventDefault();
        toggleAnnotate();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, live, err, wsId, agentId, keys, platform]);

  const secure = /^https:/i.test(preview?.url ?? '');

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-surface px-2">
        <ToolbarBtn title="Back" disabled={!preview?.canGoBack} onClick={() => navigate('back')}>
          <ChevronLeft size={15} />
        </ToolbarBtn>
        <ToolbarBtn title="Forward" disabled={!preview?.canGoForward} onClick={() => navigate('forward')}>
          <ChevronRight size={15} />
        </ToolbarBtn>
        <ToolbarBtn title="Reload" disabled={!live} onClick={() => navigate('reload')}>
          <RotateCw size={13} className={preview?.loading ? 'spin' : ''} />
        </ToolbarBtn>

        <div className="mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-ctl border bg-bg px-2 py-1">
          {secure ? <Lock size={11} className="shrink-0 text-ok" /> : <Globe size={11} className="shrink-0 text-faint" />}
          <input
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
            placeholder={`localhost:${workspace.port}`}
            value={addr}
            spellCheck={false}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go();
              if (e.key === 'Escape') setAddr(preview?.url ?? '');
            }}
          />
          {preview?.agentActive && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent"
              title="An agent is driving the preview"
            >
              <span className="dot dot-running pulse" /> Agent is testing
            </span>
          )}
        </div>

        {live && (
          <button
            className={clsx(
              'flex shrink-0 items-center gap-1 rounded-ctl px-2 py-1 text-2xs font-medium transition-colors',
              drawerOpen ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-accent-soft hover:text-fg'
            )}
            title="Console"
            onClick={() => setDrawerOpen((v) => !v)}
          >
            <Terminal size={12} />
            {preview!.errors > 0 && <span className="text-err">{preview!.errors}</span>}
            {preview!.warns > 0 && <span className="text-warn">{preview!.warns}</span>}
            {preview!.errors === 0 && preview!.warns === 0 && 'Console'}
          </button>
        )}

        <button
          className={clsx(
            'flex shrink-0 items-center gap-1 rounded-ctl px-2 py-1 text-2xs font-medium transition-colors',
            annotating ? 'btn-accent' : 'text-muted hover:bg-accent-soft hover:text-fg'
          )}
          title="Annotate — draw on the page and send it to the agent (⌘⇧A)"
          disabled={!live || !!err}
          onClick={toggleAnnotate}
        >
          <PenLine size={12} /> Annotate
        </button>

        <div className="relative shrink-0">
          <ToolbarBtn title="More" onClick={() => setOverflow((v) => !v)}>
            <MoreVertical size={15} />
          </ToolbarBtn>
          {overflow && (
            <div className="absolute right-0 top-full z-40 mt-1 w-56">
              <Menu onClose={() => setOverflow(false)}>
                <MenuItem
                  onClick={() => {
                    void tryInvoke('workspace:openPreview', { workspaceId: wsId });
                    setOverflow(false);
                  }}
                >
                  <ExternalLink size={12} className="text-muted" /> Open in external browser
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    void invoke('preview:devtools', { workspaceId: wsId });
                    setOverflow(false);
                  }}
                >
                  <Terminal size={12} className="text-muted" /> Open DevTools
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    void navigator.clipboard?.writeText(preview?.url ?? '');
                    setOverflow(false);
                  }}
                >
                  <Copy size={12} className="text-muted" /> Copy URL
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  onClick={() => {
                    useApp.getState().closePreview(wsId);
                    setOverflow(false);
                  }}
                >
                  <X size={12} className="text-muted" /> Close preview
                </MenuItem>
              </Menu>
            </div>
          )}
        </div>
      </div>

      {/* stage — the WebContentsView floats over `holderRef`; DOM overlays show
          only while it's hidden (empty/error/annotate). */}
      <div className="relative min-h-0 flex-1">
        <div ref={holderRef} className="absolute inset-0" />

        {!live && <EmptyCard workspace={workspace} hasRunScript={(runScripts?.length ?? 0) > 0} onStart={startDevServer} onOpen={() => useApp.getState().openPreview(wsId)} />}

        {live && err && (
          refused ? (
            <ErrorCard
              title={`Nothing is listening on :${workspace.port}`}
              body="Start the workspace's dev server — this card flips to the app the moment the port is up."
              onStart={startDevServer}
              onRetry={() => navigate('goto', preview?.url || `http://localhost:${workspace.port}`)}
            />
          ) : (
            <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b bg-warn/10 px-4 py-2 text-2xs text-warn">
              <AlertTriangle size={13} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {err.description} ({err.code}) — {err.url}
              </span>
              <button className="btn btn-ghost h-5 px-1.5 text-2xs" onClick={() => navigate('goto', err.url)}>
                Retry
              </button>
            </div>
          )
        )}

        {annotating && <AnnotateOverlay />}
      </div>

      {/* console drawer */}
      {drawerOpen && live && <ConsoleDrawer wsId={wsId} agentId={agentId} onClose={() => setDrawerOpen(false)} />}
    </div>
  );
}

function ToolbarBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl text-muted transition-colors hover:bg-accent-soft hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function EmptyCard({
  workspace,
  hasRunScript,
  onStart,
  onOpen,
}: {
  workspace: Workspace;
  hasRunScript: boolean;
  onStart: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-card border bg-surface px-6 py-8 text-center">
        <Globe size={26} className="text-faint" strokeWidth={1.5} />
        <div>
          <div className="text-sm font-medium text-fg">Preview this workspace's app</div>
          <div className="mt-1 font-mono text-2xs text-muted">http://localhost:{workspace.port}</div>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <button className="btn btn-accent h-7 gap-1.5 text-xs" onClick={onStart}>
            <Play size={12} /> Start dev server &amp; preview
          </button>
          <button className="btn h-7 text-xs" onClick={onOpen}>
            Preview anyway
          </button>
        </div>
        {!hasRunScript && (
          <div className="mt-1 text-2xs text-faint">
            No run script yet — add one from the Run dock so “Start” knows how to launch your server.
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorCard({
  title,
  body,
  onStart,
  onRetry,
}: {
  title: string;
  body: string;
  onStart: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-card border bg-surface px-6 py-8 text-center">
        <AlertTriangle size={26} className="text-warn" strokeWidth={1.5} />
        <div>
          <div className="text-sm font-medium text-fg">{title}</div>
          <div className="mt-1 text-2xs text-muted">{body}</div>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <button className="btn btn-accent h-7 gap-1.5 text-xs" onClick={onStart}>
            <Play size={12} /> Start dev server
          </button>
          <button className="btn h-7 gap-1.5 text-xs" onClick={onRetry}>
            <RotateCw size={12} /> Retry
          </button>
        </div>
      </div>
    </div>
  );
}

const LEVEL_TINT: Record<ConsoleEntry['level'], string> = {
  error: 'text-err',
  warn: 'text-warn',
  info: 'text-muted',
  log: 'text-muted',
  debug: 'text-faint',
};

function ConsoleDrawer({ wsId, agentId, onClose }: { wsId: string; agentId: number; onClose: () => void }) {
  const preview = useApp((s) => s.previewByWs[wsId]);
  const [level, setLevel] = useState<ConsoleLevel | 'all'>('all');
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const errors = preview?.errors ?? 0;
  const warns = preview?.warns ?? 0;

  useEffect(() => {
    let alive = true;
    void tryInvoke('preview:console', { workspaceId: wsId, level }).then(({ data }) => {
      if (alive && data) setEntries(data.entries);
    });
    return () => {
      alive = false;
    };
  }, [wsId, level, errors, warns]);

  const clear = () =>
    void tryInvoke('preview:console', { workspaceId: wsId, clear: true }).then(({ data }) => setEntries(data?.entries ?? []));

  const sendToAgent = async () => {
    const { data } = await tryInvoke('preview:sendConsole', { workspaceId: wsId, level });
    if (data?.path) {
      useApp.getState().addAttachment(wsId, agentId, { kind: 'log', path: data.path, label: `Console log (${data.count})` });
      useApp.getState().setTab(wsId, 'chat');
      useApp.getState().toast('info', 'Console log staged in the composer');
    }
  };

  const LEVELS: (ConsoleLevel | 'all')[] = ['all', 'error', 'warn'];

  return (
    <div className="flex h-56 shrink-0 flex-col border-t bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-2xs">
        <div className="flex items-center rounded-ctl border bg-bg p-0.5">
          {LEVELS.map((l) => (
            <button
              key={l}
              className={clsx('rounded px-1.5 py-0.5 font-medium capitalize', level === l ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg')}
              onClick={() => setLevel(l)}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button className="btn btn-ghost h-5 gap-1 px-1.5 text-2xs" title="Stage the console in the composer" onClick={() => void sendToAgent()}>
          <Terminal size={11} /> Send to agent
        </button>
        <button className="btn btn-ghost h-5 gap-1 px-1.5 text-2xs" onClick={clear}>
          <Trash2 size={11} /> Clear
        </button>
        <button className="btn btn-ghost h-5 w-5 !px-0" onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1 font-mono text-2xs leading-relaxed">
        {entries.length === 0 ? (
          <div className="p-3 text-center text-faint">No console output.</div>
        ) : (
          entries.map((e, i) => (
            <div key={i} className={clsx('flex gap-2 border-b border-border/40 px-2 py-1 last:border-b-0', LEVEL_TINT[e.level])}>
              <span className="shrink-0 uppercase opacity-70">{e.level}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{e.text}</span>
              {e.url && <span className="shrink-0 text-faint">{shortLoc(e.url, e.line)}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function shortLoc(url: string, line?: number): string {
  let base = url;
  try {
    base = new URL(url).pathname.split('/').pop() || url;
  } catch {
    /* keep raw */
  }
  return line ? `${base}:${line}` : base;
}
