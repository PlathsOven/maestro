import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  FileText,
  Globe,
  GripVertical,
  History,
  Image as ImageIcon,
  KeyRound,
  ListChecks,
  Maximize,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Terminal as TerminalIcon,
  User,
  Waypoints,
  Wrench,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { formatDuration, timeAgo } from '../lib/format';
import {
  DEFAULT_CHAT_IDS,
  useApp,
  LAYOUT_LIMITS,
  DEFAULT_LAYOUT,
  leaf,
  paneIds,
  paneCount,
  firstLeaf,
  type LiveTurn,
  type PaneNode,
  type DropSide,
} from '../store/app';
import Composer from './Composer';
import AskCard from './AskCard';
import AuthFix from './AuthFix';
import AttachmentPreviewModal from './AttachmentPreviewModal';
// Transcript rendering now lives in the shared UI package (web-desktop-parity §6);
// the desktop wraps it with store-bound adapters below.
import SharedMarkdown from '../../shared/ui/Markdown';
import { BlockList, AttachmentChip as SharedAttachmentChip } from '../../shared/ui/blocks';
import { AgentMessageView, UserMessageView, SystemMessageView, LiveTurnView as SharedLiveTurnView } from '../../shared/ui/transcript';
import { beginPointerDrag, DetailCard, DetailRow, EmptyHint, ReadUnreadMenu, RenameInput, Resizer, ScrollingTitle, Spinner, StatusCircle, useDismiss, useHoverDetail } from './common';
import { INDICATOR_LABEL, isUnread, sessionIndicator, type IndicatorStatus } from '../lib/status';
import { roleLabel, roleModelLabel } from '../../shared/types';
import type { AgentBlock, Attachment, ChatMessage, SubagentRun, Workspace } from '../../shared/types';
import { chatDisplayTitle } from '../../shared/chatTitle';

export { BlockList };

/**
 * The center chat area: the session rail on the left, then the split view — one
 * or more chat panes shown side by side. A single pane is the classic
 * one-chat layout; extra panes are popped out from the rail (or dragged in) so
 * several chats on the same branch are visible at once.
 */
export default function ChatPanel({ workspace }: { workspace: Workspace }) {
  return (
    <div className="flex h-full min-w-0">
      <SessionRail workspace={workspace} />
      <SplitView workspace={workspace} />
    </div>
  );
}

// --- split-pane drag & drop -------------------------------------------------
// A session dragged from the rail, or a pane dragged by its header, carries this
// payload. We keep a module-level copy because dataTransfer.getData() is
// unreadable during `dragover` (only the type list is), yet we need to know it's
// our own drag to draw the live drop preview.
const DRAG_MIME = 'application/x-maestro-session';
type PaneDrag = { agentId: number; from: 'pane' | 'rail' };
let paneDrag: PaneDrag | null = null;

function beginPaneDrag(e: React.DragEvent, payload: PaneDrag) {
  paneDrag = payload;
  try {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
  } catch {
    /* some environments reject custom MIME types — the module copy still works */
  }
  e.dataTransfer.effectAllowed = 'move';
}
function readPaneDrag(e: React.DragEvent): PaneDrag | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (raw) return JSON.parse(raw) as PaneDrag;
  } catch {
    /* fall through to the module copy */
  }
  return paneDrag;
}

/** Which edge of a pane the cursor is nearest — the classic four-quadrant split
 *  by the pane's diagonals, so the drop direction reads naturally. */
function dropSide(e: React.DragEvent, el: HTMLElement | null): DropSide {
  if (!el) return 'right';
  const r = el.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  const dist: Record<DropSide, number> = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return (Object.keys(dist) as DropSide[]).reduce((a, b) => (dist[b] < dist[a] ? b : a), 'left');
}

type PaneTreeProps = {
  node: PaneNode;
  workspace: Workspace;
  focused: number;
  /** the top-left-most session — the only pane that shows the "setting up" banner. */
  firstId: number;
  /** true when ≥2 panes are visible — every pane then gets a draggable header. */
  chrome: boolean;
};

/**
 * The center chat area: renders the workspace's pane-layout tree. A single leaf
 * is the classic one-chat view; splits tile chats along a row or column, nested
 * arbitrarily, so sessions can share the space both horizontally and vertically.
 * Dragging a session (from the rail or another pane) previews and drops against
 * whichever edge of a pane the cursor is nearest.
 */
function SplitView({ workspace }: { workspace: Workspace }) {
  const focused = useApp((s) => s.composerAgent[workspace.id] ?? 1);
  const layout = useApp((s) => s.paneLayout[workspace.id]) ?? leaf(focused);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-canvas">
      <PaneTree
        node={layout}
        workspace={workspace}
        focused={focused}
        firstId={firstLeaf(layout)}
        chrome={paneCount(layout) > 1}
      />
    </div>
  );
}

/** Dispatch one tree node to its renderer. */
function PaneTree({ node, ...rest }: PaneTreeProps) {
  if (node.t === 'leaf') return <PaneLeaf node={node} {...rest} />;
  return <PaneSplit node={node} {...rest} />;
}

/** Stable-ish React key so panes keep their identity (and scroll/composer state)
 *  across resizes; structural changes may still remount, which is harmless. */
const nodeKey = (n: PaneNode): string => (n.t === 'leaf' ? `l${n.id}` : `s${paneIds(n).join('.')}`);

/**
 * A split node: a flex row/col of its children with a draggable divider between
 * each pair. Child sizes live in local state (equal by default, re-equalized
 * whenever the child count changes) so a resize never drifts or needs persisting.
 */
function PaneSplit({ node, ...rest }: PaneTreeProps & { node: Extract<PaneNode, { t: 'split' }> }) {
  const row = node.dir === 'row';
  const count = node.children.length;
  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>(() => node.children.map(() => 1));
  useEffect(() => setSizes(node.children.map(() => 1)), [count]);

  // Drag the divider between child i and i+1 to shift space between the two,
  // along whichever axis this split runs.
  const startResize = (i: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const extent = row ? r.width : r.height;
    const startPos = row ? e.clientX : e.clientY;
    const base = sizes;
    const total = base.reduce((a, b) => a + b, 0);
    const pair = (base[i] ?? 1) + (base[i + 1] ?? 1);
    const min = total * 0.12; // keep both neighbours usably large
    beginPointerDrag(row ? 'col-resize' : 'row-resize', (ev) => {
      const delta = (((row ? ev.clientX : ev.clientY) - startPos) / extent) * total;
      let a = (base[i] ?? 1) + delta;
      let b = (base[i + 1] ?? 1) - delta;
      if (a < min) { a = min; b = pair - min; }
      if (b < min) { b = min; a = pair - min; }
      setSizes((ws) => ws.map((w, idx) => (idx === i ? a : idx === i + 1 ? b : w)));
    });
  };

  return (
    <div ref={containerRef} className={clsx('flex min-h-0 min-w-0 flex-1', row ? 'flex-row' : 'flex-col')}>
      {node.children.map((child, i) => (
        <React.Fragment key={nodeKey(child)}>
          {i > 0 && <PaneDivider row={row} onPointerDown={startResize(i - 1)} />}
          <div className="relative flex min-h-0 min-w-0" style={{ flexGrow: sizes[i] ?? 1, flexBasis: 0 }}>
            <PaneTree {...rest} node={child} />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

/** The resizable divider between two split children — vertical bar for a row,
 *  horizontal for a column, with a hit area that overhangs both sides. */
function PaneDivider({ row, onPointerDown }: { row: boolean; onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div className={clsx('relative z-20 shrink-0 bg-border', row ? 'w-px' : 'h-px')}>
      <div
        role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        onPointerDown={onPointerDown}
        className={clsx(
          'group absolute flex items-center justify-center',
          row ? '-inset-x-1 inset-y-0 cursor-col-resize' : '-inset-y-1 inset-x-0 cursor-row-resize'
        )}
      >
        <span
          className={clsx(
            'bg-accent opacity-0 transition-opacity group-hover:opacity-100',
            row ? 'h-full w-0.5' : 'h-0.5 w-full'
          )}
        />
      </div>
    </div>
  );
}

/**
 * A leaf pane: one chat column, plus the drop machinery. While a session is
 * dragged over it, a translucent overlay previews which half the dropped chat
 * will take; releasing splits this pane along that edge.
 */
function PaneLeaf({ node, workspace, focused, firstId, chrome }: PaneTreeProps & { node: Extract<PaneNode, { t: 'leaf' }> }) {
  const id = node.id;
  const ref = useRef<HTMLDivElement>(null);
  const [zone, setZone] = useState<DropSide | null>(null);

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return; // ignore OS file drags etc.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setZone(dropSide(e, ref.current));
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.relatedTarget && ref.current?.contains(e.relatedTarget as Node)) return;
    setZone(null);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const p = readPaneDrag(e);
    const side = zone;
    setZone(null);
    paneDrag = null;
    if (!p || !side) return;
    useApp.getState().dropPaneBeside(workspace.id, p.agentId, id, side);
  };

  return (
    <div
      ref={ref}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ChatPane
        workspace={workspace}
        agentId={id}
        focused={id === focused}
        chrome={chrome}
        showSetup={id === firstId}
        onHeaderDragStart={(e) => beginPaneDrag(e, { agentId: id, from: 'pane' })}
      />
      {zone && <DropOverlay side={zone} />}
    </div>
  );
}

/** Ghost of where a dragged chat will land: the highlighted half of the pane. */
function DropOverlay({ side }: { side: DropSide }) {
  const half = {
    left: 'inset-y-0 left-0 w-1/2',
    right: 'inset-y-0 right-0 w-1/2',
    top: 'inset-x-0 top-0 h-1/2',
    bottom: 'inset-x-0 bottom-0 h-1/2',
  }[side];
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {/* var-colour opacity utilities (bg-accent/20) compile to nothing here, so
          tint the ghost with color-mix; the border stays a solid accent. */}
      <div
        className={clsx('absolute rounded-card border-2 border-accent', half)}
        style={{ background: 'color-mix(in srgb, var(--accent) 26%, transparent)' }}
      />
    </div>
  );
}

// Height (px) the floating bar occupies below the scrollport top, used as the
// cutoff for when a user message counts as scrolled out of sight. Mirrors
// FloatingPrompt's box: pt-2 (8) + button py-2 (16) + label line & mb-0.5 (17) +
// two clamped text-[13px]/snug lines (~36). Sized to the 2-line max so a message
// hidden behind the bar always switches the float; a rare 1-line prompt just
// switches a hair early. Keep in sync if FloatingPrompt's padding/type changes.
const FLOAT_BAR_H = 78;

/**
 * True when a live, non-empty text selection sits inside `el`. A collapsed caret
 * (a plain click) doesn't count, so clicking in the chat never stalls its
 * follow-the-tail scrolling — only an actual selection does. Scoped per pane, so
 * selecting in one split pane leaves the others following normally.
 */
function hasSelectionIn(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return el.contains(sel.getRangeAt(0).commonAncestorContainer);
}

/** One definition of "scrolled to the bottom", shared by the tail-follow pinning
 *  and the unread-clearing check so the two never disagree. */
function atBottomOf(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

/**
 * One chat column: an optional pane header (shown only in split view), the
 * scrolling message list for `agentId`, the floating-prompt overlay, and the
 * session's own composer. Extracted from the old ChatPanel so each pane owns its
 * scroll state and composer independently.
 */
function ChatPane({
  workspace,
  agentId,
  focused,
  chrome,
  showSetup,
  onHeaderDragStart,
}: {
  workspace: Workspace;
  agentId: number;
  focused: boolean;
  /** true when there are ≥2 panes — adds the draggable pane header. */
  chrome: boolean;
  /** only the first pane shows the workspace "setting up" banner. */
  showSetup: boolean;
  onHeaderDragStart: (e: React.DragEvent) => void;
}) {
  const messages = useApp((s) => s.messages[workspace.id]);
  const liveTurns = useApp((s) => s.liveTurns);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTopRef = useRef(0);
  const [pinned, setPinned] = useState(true);
  const [floatId, setFloatId] = useState<string | null>(null);

  const chatMessages = useMemo(
    () => (messages ?? []).filter((m) => m.agentId === agentId),
    [messages, agentId]
  );
  const liveTurn = liveTurns[`${workspace.id}:${agentId}`];
  const pendingAsk = useApp((s) => s.pendingAsks[`${workspace.id}:${agentId}`]);

  // The unread ("complete") dot clears when the user has actually seen the end of
  // the conversation: this scrollport is at its bottom, on screen, in a focused
  // window. Checked from every path that can bring the bottom into view — the
  // scroll handler, output settling below (the deps effect), the window regaining
  // focus, and this pane (re)appearing (the IntersectionObserver). Output landing
  // while you're away is never silently cleared: the focus check fails until you
  // return, and once you're back the new content is what's on screen. Everything
  // is read fresh (DOM + store) so the focus/observer listeners can't act on a
  // stale closure.
  const maybeMarkRead = () => {
    const el = scrollRef.current;
    // offsetParent goes null when a display:none ancestor hides the chat (the
    // Diff/Editor/Preview tab is on top) — being mounted isn't being seen; a
    // collapsed 0-height scrollport is "at the bottom" only vacuously.
    if (!el || el.clientHeight === 0 || !document.hasFocus() || el.offsetParent === null) return;
    // While a turn streams, the indicator shows "running" and each token re-flags
    // unread — clearing now would just churn IPC. The deps effect below re-checks
    // the moment the turn settles, which is when the dot would turn green.
    if (useApp.getState().liveTurns[`${workspace.id}:${agentId}`]) return;
    if (atBottomOf(el)) useApp.getState().markChatRead(workspace.id, agentId);
  };

  // The prompt that triggered the output currently on screen = the last user
  // message that has scrolled up behind the floating bar. The reminder exists to
  // stand in for a message you can no longer see, so a message counts as gone the
  // moment its bottom passes the bar's *bottom* edge — not the scrollport top.
  // Testing against the top alone (`top + 8`) left a dead zone one bar-height tall:
  // a message tucked behind the bar was still counted as on screen, so the float
  // kept showing the *previous* (older) prompt while covering the newer one.
  const recomputeFloat = () => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = el.getBoundingClientRect().top + FLOAT_BAR_H;
    let id: string | null = null;
    for (const node of el.querySelectorAll<HTMLElement>('[data-user-msg]')) {
      if (node.getBoundingClientRect().bottom <= threshold) id = node.dataset.userMsg ?? null;
      else break; // document order: once one is on/below screen, the rest are too
    }
    setFloatId(id);
  };

  // Follow the tail while pinned — but never while the user is selecting text in
  // this pane. Auto-follow re-runs on *every* render, and a streaming turn
  // re-renders on every token: yanking scrollTop out from under a drag moves the
  // text under the cursor, so the selection lands somewhere other than where it
  // was aimed and long selections are impossible to finish. Holding position for
  // the length of a selection costs nothing — clearing it resumes the follow.
  useEffect(() => {
    const el = scrollRef.current;
    if (pinned && el && !hasSelectionIn(el)) el.scrollTop = el.scrollHeight;
  });

  // Selecting another session swaps this pane's conversation without remounting
  // it (the leaf keeps its React identity), so the previous chat's scroll offset
  // — and its `pinned` flag — would carry over: leave one chat scrolled up to
  // re-read something and the next one opens parked at that offset, near the
  // top. Every switch starts at the newest message instead, like a fresh open.
  // Before paint, so the stale offset is never shown; `lastTopRef` moves with it
  // so the resulting scroll event isn't read as the user scrolling up.
  useLayoutEffect(() => {
    setPinned(true);
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  }, [workspace.id, agentId]);

  // No deps: message heights settle across renders (markdown, folds, streaming),
  // so re-measure each pass — mirrors the auto-scroll effect above.
  useEffect(() => {
    recomputeFloat();
    window.addEventListener('resize', recomputeFloat);
    return () => window.removeEventListener('resize', recomputeFloat);
  });

  // Sees-the-bottom checks for the paths that produce no scroll event. Content
  // settling covers a turn finishing (or a session switch swapping in a chat)
  // while the view sits at the bottom; it runs after the tail-follow effect above,
  // so a pinned view has already been scrolled down when it measures. Deliberately
  // NOT keyed on the unread flag itself: "Mark as unread" must stick until one of
  // these viewing moments actually recurs, not be un-done by the next render.
  useEffect(() => {
    maybeMarkRead();
  }, [chatMessages, liveTurn]);
  // Window focus (coming back to the app with the bottom already on screen) and
  // pane visibility (the chat tab surfacing back over Diff/Editor/Preview; the
  // observer also fires once on observe, covering mount and session switches).
  useEffect(() => {
    window.addEventListener('focus', maybeMarkRead);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) maybeMarkRead();
    });
    if (scrollRef.current) io.observe(scrollRef.current);
    return () => {
      window.removeEventListener('focus', maybeMarkRead);
      io.disconnect();
    };
  }, [workspace.id, agentId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Hiding the chat behind the Diff/Editor/Preview tab collapses the scroller,
    // which clamps scrollTop to 0 and fires a scroll event. That's not the user
    // scrolling up: acting on it would unpin the tail-follow (and rewind
    // lastTopRef), leaving the chat parked above its bottom when it re-surfaces.
    if (el.clientHeight === 0) return;
    const atBottom = atBottomOf(el);
    // No slack in the upward test: scroll events only fire when scrollTop
    // actually changed, and a slow trackpad scroll moves ≤1px per event. Any
    // tolerance leaves `pinned` true through a slow scroll-up, and the next
    // re-render (the float bar swapping at a prompt boundary) snaps the view
    // back to the bottom — the scroll appears to bounce off the real message.
    const wentUp = el.scrollTop < lastTopRef.current;
    lastTopRef.current = el.scrollTop;
    // Re-pin only when the user returns to the bottom; unpin the moment they
    // scroll up, so a slow upward scroll near the bottom isn't snapped back by
    // the auto-follow effect above.
    setPinned((p) => (wentUp ? false : atBottom ? true : p));
    recomputeFloat();
    maybeMarkRead();
  };

  const empty = chatMessages.length === 0 && !liveTurn && !pendingAsk;
  const floatMsg = floatId ? chatMessages.find((m) => m.id === floatId) : undefined;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {chrome && (
        <PaneHeader workspace={workspace} agentId={agentId} focused={focused} onDragStart={onHeaderDragStart} />
      )}
      <div ref={scrollRef} onScroll={onScroll} data-img-gallery className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {floatMsg && <FloatingPrompt msg={floatMsg} scrollRef={scrollRef} />}
        {showSetup && workspace.status === 'setting-up' && (
          <div className="mb-3 rounded-card border bg-surface px-3 py-2.5" role="status" aria-live="polite">
            <div className="text-xs text-muted">
              {workspace.wsKind === 'in-place'
                ? 'Preparing workspace…'
                : 'Setting up worktree — fetching origin, creating branch, running setup script…'}
            </div>
            <div
              className="progress-indeterminate mt-2 h-1 rounded-full"
              role="progressbar"
              aria-label="Setting up workspace"
            />
          </div>
        )}
        {empty ? (
          <EmptyHint
            icon={<MessageSquare size={30} strokeWidth={1.5} />}
            title="Describe the task"
            body={
              workspace.wsKind === 'in-place'
                ? `Your message starts ${harnessLabel(workspace)} working directly in this folder. Edits change your files in place — there's no branch or diff.`
                : `Your message starts ${harnessLabel(workspace)} inside this worktree on branch ${workspace.branch}. The agent will rename the branch to match the task.`
            }
          />
        ) : (
          <div className={clsx('mx-auto space-y-4', chrome ? 'max-w-2xl' : 'max-w-3xl')}>
            {chatMessages.map((m) => (
              <MessageView key={m.id} msg={m} />
            ))}
            {liveTurn && <LiveTurnView turn={liveTurn} />}
            {pendingAsk && <AskCard payload={pendingAsk} />}
          </div>
        )}
      </div>
      <Composer workspace={workspace} agentId={agentId} />
    </div>
  );
}

/**
 * A pane's header (split view only): grip + the session's status and title +
 * maximize / close-pane actions. Dragging it reorders the columns; clicking it
 * focuses the pane. The close button removes the column but keeps the chat open
 * in the session rail.
 */
function PaneHeader({
  workspace,
  agentId,
  focused,
  onDragStart,
}: {
  workspace: Workspace;
  agentId: number;
  focused: boolean;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const messages = useApp((s) => s.messages[workspace.id]);
  const meta = useApp((s) => s.chatsMeta[workspace.id]?.[String(agentId)]);
  const running = useApp((s) => s.runningAgents[workspace.id])?.includes(agentId) ?? false;
  const firstUserMsg = (messages ?? []).find((m) => m.agentId === agentId && m.role === 'user');
  const title = chatDisplayTitle(meta, firstUserMsg?.content);
  const status = sessionIndicator(meta, running);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={() => useApp.getState().setComposerAgent(workspace.id, agentId)}
      title="Drag to rearrange · click to focus"
      className={clsx(
        'group flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b px-2 active:cursor-grabbing',
        focused ? 'bg-accent-soft/70' : 'bg-bg hover:bg-accent-soft/30'
      )}
    >
      <GripVertical size={13} className="shrink-0 text-faint" />
      {status ? (
        <StatusCircle status={status} size={11} />
      ) : (
        <MessageSquare size={11} className={clsx('shrink-0', focused ? 'text-accent' : 'text-faint')} />
      )}
      <span className={clsx('min-w-0 flex-1 truncate text-xs', focused ? 'font-medium text-fg' : 'text-muted')}>
        {title}
      </span>
      <button
        className="shrink-0 rounded p-0.5 text-faint opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
        title="Maximize — show only this chat"
        onClick={(e) => {
          e.stopPropagation();
          useApp.getState().soloPane(workspace.id, agentId);
        }}
      >
        <Maximize size={12} />
      </button>
      <button
        className="shrink-0 rounded p-0.5 text-faint opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
        title="Close pane — keeps the chat in the session list"
        onClick={(e) => {
          e.stopPropagation();
          useApp.getState().closePane(workspace.id, agentId);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * Compact copy of the prompt governing the output being read, overlaid at the
 * top of the chat while the original message is scrolled out of view. Click
 * jumps back to the original (which hides the float, since it becomes visible).
 */
function FloatingPrompt({ msg, scrollRef }: { msg: ChatMessage; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    // Rendered *inside* the scroll container as a zero-height sticky overlay, not
    // as a sibling. It must be a descendant of the scroller so a wheel/trackpad
    // gesture over it stays latched to that scroller: when the float lived
    // outside, scrolling up slowly stalled right where it meets the real message,
    // because the overlay unmounted under the cursor and severed the gesture each
    // time. `h-0` reserves no layout space (messages aren't pushed down); `sticky
    // top-0` pins it flush to the top of the scrollport as content scrolls behind.
    <div className="pointer-events-none sticky top-0 z-10 h-0">
      <div className="mx-auto max-w-3xl pt-2">
        <button
          className="glass fade-in pointer-events-auto w-full px-3.5 py-2 text-left transition-colors hover:border-accent/50"
          title="Jump to this message"
          onClick={() =>
            scrollRef.current
              ?.querySelector(`[data-user-msg="${msg.id}"]`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        >
          <span className="mb-0.5 flex items-center gap-1.5 text-2xs text-faint">
            <User size={11} />
            You · {timeAgo(msg.ts)}
          </span>
          <span className="line-clamp-2 text-[13px] leading-snug text-muted">
            {msg.content.replace(/\s+/g, ' ').trim()}
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * Vertical session rail: one row per agent session, styled like the workspace
 * list in the sidebar so many sessions are easy to scan and manage at once.
 * Rows are closable (non-destructive, reopen with ⇧⌘T); "+" starts a new chat.
 */
function SessionRail({ workspace }: { workspace: Workspace }) {
  const messages = useApp((s) => s.messages[workspace.id]);
  const chatsMeta = useApp((s) => s.chatsMeta[workspace.id]);
  const running = useApp((s) => s.runningAgents[workspace.id]) ?? [];
  const activeChat = useApp((s) => s.composerAgent[workspace.id] ?? 1);
  const chatIds = useApp((s) => s.chatIds[workspace.id]) ?? DEFAULT_CHAT_IDS;
  const paneLayout = useApp((s) => s.paneLayout[workspace.id]);
  const visiblePanes = paneIds(paneLayout);
  const splitActive = visiblePanes.length > 1;
  const sessionsW = useApp((s) => s.layout.sessions);

  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  // Drag-to-reorder the rail. Reuses the split-pane drag payload (beginPaneDrag,
  // from: 'rail'): dropping over another row reorders chatIds, while dropping over
  // the chat area still splits (that path is unchanged). `dropIdx` is the pending
  // insertion index into chatIds; we render a thin accent line there.
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  // getData() is unreadable during dragover, so read the module-level copy to tell
  // it's our own drag. Only rail-originated drags reorder (a pane header dragged
  // over the rail is a re-dock gesture, not a reorder); the id must still be open.
  const railDragId = () =>
    paneDrag && paneDrag.from === 'rail' && chatIds.includes(paneDrag.agentId) ? paneDrag.agentId : null;
  const onRowDragOver = (e: React.DragEvent, index: number) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME) || railDragId() == null) return;
    e.preventDefault();
    e.stopPropagation(); // beat the container handler so we keep the per-row index
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    setDropIdx(index + (e.clientY > r.top + r.height / 2 ? 1 : 0));
  };
  const onRailDragOver = (e: React.DragEvent) => {
    // Fires only for the empty space below the rows (rows stopPropagation) → end.
    if (!e.dataTransfer.types.includes(DRAG_MIME) || railDragId() == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIdx(chatIds.length);
  };
  const onRailDragLeave = (e: React.DragEvent) => {
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropIdx(null);
  };
  const onRailDrop = (e: React.DragEvent) => {
    const id = railDragId();
    const idx = dropIdx;
    setDropIdx(null);
    paneDrag = null;
    if (id == null || idx == null) return;
    e.preventDefault();
    useApp.getState().reorderChat(workspace.id, id, idx);
  };
  // Dismissal lives here (not in the menu) so the wrapper contains both the
  // toggle button and the menu — re-clicking the button toggles cleanly instead
  // of close-then-reopen.
  useDismiss(historyOpen, () => setHistoryOpen(false), historyRef);

  // Recently closed sessions for the history menu. Built from persisted ChatMeta
  // (the `closed` flag survives restarts; the ⇧⌘T stack doesn't), newest activity
  // first. Excludes anything currently open, so it never double-lists a session.
  const closedSessions = useMemo(() => {
    const meta = chatsMeta ?? {};
    return Object.entries(meta)
      .filter(([id, m]) => m?.closed && !chatIds.includes(Number(id)))
      .map(([id, m]) => {
        const agentId = Number(id);
        const firstUserMsg = (messages ?? []).find((msg) => msg.agentId === agentId && msg.role === 'user');
        const title = chatDisplayTitle(m, firstUserMsg?.content);
        return { id: agentId, title, lastAgentAt: m.lastAgentAt };
      })
      .sort((a, b) => (b.lastAgentAt ?? 0) - (a.lastAgentAt ?? 0));
  }, [chatsMeta, chatIds, messages]);

  return (
    <div className="relative flex shrink-0 flex-col border-r bg-bg" style={{ width: sessionsW }}>
      <Resizer
        axis="x"
        size={sessionsW}
        min={LAYOUT_LIMITS.sessions.min}
        max={LAYOUT_LIMITS.sessions.max}
        resetTo={DEFAULT_LAYOUT.sessions}
        onResize={(w) => useApp.getState().setLayout({ sessions: w })}
        onCommit={() => useApp.getState().commitLayout()}
        className="-right-1"
      />
      <div className="flex items-center justify-between px-3 pb-1.5 pt-3">
        <span className="text-2xs font-semibold uppercase tracking-wide text-faint">Sessions</span>
        <div className="flex items-center gap-0.5">
          <div ref={historyRef} className="relative">
            <button
              className={clsx(
                'flex items-center rounded-ctl p-1 transition-colors',
                historyOpen ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-accent-soft hover:text-fg'
              )}
              title="Recently closed sessions"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <History size={14} />
            </button>
            {historyOpen && (
              <ClosedSessionsMenu
                workspace={workspace}
                sessions={closedSessions}
                onReopen={() => setHistoryOpen(false)}
              />
            )}
          </div>
          <button
            className="rounded-ctl p-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg"
            title="New chat (⌘T)"
            onClick={() => useApp.getState().newChat(workspace.id)}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2"
        onDragOver={onRailDragOver}
        onDragLeave={onRailDragLeave}
        onDrop={onRailDrop}
      >
        {chatIds.map((id, i) => {
          const firstUserMsg = (messages ?? []).find((m) => m.agentId === id && m.role === 'user');
          const title = chatDisplayTitle(chatsMeta?.[String(id)], firstUserMsg?.content);
          const active = id === activeChat;
          const isRunning = running.includes(id);
          return (
            <React.Fragment key={id}>
              {dropIdx === i && <RailDropLine />}
              <SessionRow
                workspace={workspace}
                id={id}
                index={i}
                active={active}
                status={sessionIndicator(chatsMeta?.[String(id)], isRunning)}
                title={title}
                preview={firstUserMsg?.content}
                inSplit={splitActive && visiblePanes.includes(id)}
                onReorderDragOver={onRowDragOver}
                onReorderEnd={() => setDropIdx(null)}
              />
            </React.Fragment>
          );
        })}
        {dropIdx === chatIds.length && <RailDropLine />}
      </div>
    </div>
  );
}

/**
 * Dropdown of recently closed sessions, anchored under the rail's history button.
 * Lists every closed chat in the workspace (newest first) with its title and when
 * it last ran; a row restores that session via reopenChat. Outside-click / Escape
 * dismissal is owned by the SessionRail wrapper (see historyRef).
 */
function ClosedSessionsMenu({
  workspace,
  sessions,
  onReopen,
}: {
  workspace: Workspace;
  sessions: { id: number; title: string; lastAgentAt?: number }[];
  onReopen: () => void;
}) {
  return (
    <div className="glass absolute left-0 top-full z-50 mt-1 max-h-80 w-64 overflow-y-auto py-1">
      <div className="px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-faint">Recently closed</div>
      {sessions.length === 0 ? (
        <div className="px-3 py-2 text-2xs text-faint">No recently closed sessions</div>
      ) : (
        sessions.map((s) => (
          <button
            key={s.id}
            className="group flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent-soft"
            title="Reopen this session"
            onClick={() => {
              useApp.getState().reopenChat(workspace.id, s.id);
              onReopen();
            }}
          >
            <MessageSquare size={13} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted group-hover:text-fg">{s.title}</span>
            {s.lastAgentAt != null && <span className="shrink-0 text-2xs text-faint">{timeAgo(s.lastAgentAt)}</span>}
            <RotateCcw size={12} className="shrink-0 text-faint group-hover:text-accent" />
          </button>
        ))
      )}
    </div>
  );
}

/** Insertion marker shown between rows while dragging to reorder the rail. */
function RailDropLine() {
  return <div className="pointer-events-none mx-1 h-0.5 rounded-full bg-accent" />;
}

/**
 * One session row: click to focus it, double-click to rename (sets a custom
 * ChatMeta title, overriding the auto title), and hover for a detail card with
 * the full title and the first message.
 */
function SessionRow({
  workspace,
  id,
  index,
  active,
  status,
  title,
  preview,
  inSplit,
  onReorderDragOver,
  onReorderEnd,
}: {
  workspace: Workspace;
  id: number;
  /** position in the rail — the reorder drop target computes from it. */
  index: number;
  active: boolean;
  status: IndicatorStatus | null;
  title: string;
  preview?: string;
  /** currently shown as one of several split panes (but not the focused one). */
  inSplit: boolean;
  /** rail reorder: report the hovered insertion point / clear it on drag end. */
  onReorderDragOver: (e: React.DragEvent, index: number) => void;
  onReorderEnd: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const unread = useApp((s) => isUnread(s.chatsMeta[workspace.id]?.[String(id)]));
  const { rect, hoverProps, hideHover } = useHoverDetail();
  return (
    <div
      draggable={!editing}
      onDragStart={(e) => {
        hideHover();
        beginPaneDrag(e, { agentId: id, from: 'rail' });
      }}
      onDragOver={(e) => onReorderDragOver(e, index)}
      onDragEnd={onReorderEnd}
      className={clsx(
        'group relative flex cursor-pointer items-center gap-2 rounded-ctl px-2 py-1.5',
        active ? 'bg-accent-soft' : 'hover:bg-accent-soft/60'
      )}
      // Selecting the session opens its pane at the newest message; the pane
      // clears the unread dot itself once that bottom is actually on screen.
      onClick={editing ? undefined : () => useApp.getState().setComposerAgent(workspace.id, id)}
      onDoubleClick={(e) => {
        e.preventDefault();
        hideHover();
        setEditing(true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        hideHover();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
      {...hoverProps}
    >
      {status ? (
        <StatusCircle status={status} size={13} />
      ) : (
        <MessageSquare size={13} className={clsx('shrink-0', active ? 'text-accent' : 'text-faint')} />
      )}
      {editing ? (
        <RenameInput
          initial={title}
          onCommit={(name) => {
            setEditing(false);
            if (name && name !== title) useApp.getState().setChatMeta(workspace.id, id, { title: name, titleCustom: true });
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <ScrollingTitle
          text={title}
          className={clsx('min-w-0 flex-1 text-[13px]', active ? 'font-medium text-fg' : 'text-muted')}
        />
      )}
      {!editing && (
        <button
          className={clsx(
            'shrink-0 rounded p-0.5 hover:text-accent',
            inSplit ? 'text-accent' : 'hidden text-faint group-hover:block'
          )}
          title={inSplit ? 'Showing in split view — click to remove' : 'Open beside the current chat (split view)'}
          onClick={(e) => {
            e.stopPropagation();
            useApp.getState().splitChat(workspace.id, id);
          }}
        >
          <Columns2 size={12} />
        </button>
      )}
      {!editing && (
        <button
          className="hidden shrink-0 rounded p-0.5 text-faint hover:text-err group-hover:block"
          title="Close chat (⌘W · reopen with ⇧⌘T)"
          onClick={(e) => {
            e.stopPropagation();
            useApp.getState().closeChat(workspace.id, id);
          }}
        >
          <X size={12} />
        </button>
      )}
      {!editing && (
        <DetailCard rect={rect}>
          <div className="text-[13px] font-semibold leading-snug break-words">{title}</div>
          <div className="mt-2 space-y-1 border-t pt-2 text-2xs">
            <DetailRow label="Session" value={id === 1 ? 'Main' : `Agent ${id}`} />
            <DetailRow label="State" value={status ? INDICATOR_LABEL[status] : 'Idle'} />
          </div>
          {preview && (
            <div className="mt-2 border-t pt-2 text-2xs text-muted line-clamp-4 break-words">
              {preview.replace(/\s+/g, ' ').trim()}
            </div>
          )}
        </DetailCard>
      )}
      {ctxMenu && (
        <ReadUnreadMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          unread={unread}
          onRead={() => useApp.getState().markChatRead(workspace.id, id)}
          onUnread={() => useApp.getState().markChatUnread(workspace.id, id)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function harnessLabel(ws: Workspace): string {
  return (
    {
      'claude-code': 'Claude Code',
      codex: 'Codex',
      cursor: 'Cursor Agent',
      opencode: 'OpenCode',
      'kimi-code': 'Kimi Code',
      grok: 'Grok',
      shell: 'the shell',
    }[ws.harness] ?? ws.harness
  );
}

/**
 * Desktop Markdown = the shared renderer. Worktree-image loading and in-app
 * file-link opening are wired through the UiHost's `hydrateMarkdown` seam
 * (App.tsx → hydrateChatMarkdown), so this is just the shared component.
 * Re-exported for SubagentPreview.
 */
export const Markdown = SharedMarkdown;

/** Desktop user turn: the shared view + store-driven edit-&-resend. */
function UserMessage({ msg }: { msg: ChatMessage }) {
  return (
    <UserMessageView
      message={msg}
      onResend={(text) => void useApp.getState().resendMessage(msg.workspaceId, msg.agentId, text)}
    />
  );
}

function MessageView({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return <UserMessage msg={msg} />;
  }
  if (msg.role === 'system') {
    return <SystemMessage msg={msg} />;
  }
  return <AgentMessage msg={msg} />;
}

/**
 * Desktop system note: the shared view + store-driven error reporting. When the
 * note carries a `fix`, the desktop's AuthFix repair card is passed as the slot,
 * wired to resend the message the fault interrupted.
 */
function SystemMessage({ msg }: { msg: ChatMessage }) {
  const messages = useApp((s) => s.messages[msg.workspaceId]);
  const fix = msg.meta?.fix;
  // What the user sent right before the fault stopped the turn.
  const interrupted = fix
    ? (messages ?? []).filter((m) => m.agentId === msg.agentId && m.role === 'user' && m.ts <= msg.ts).pop()
    : undefined;
  return (
    <SystemMessageView
      message={msg}
      onReport={() => useApp.getState().reportError({ message: msg.content, source: 'chat', at: Date.now() })}
      fixSlot={
        fix ? (
          <AuthFix
            harness={fix.harness}
            loginId={fix.loginId}
            retry={
              interrupted
                ? () => void useApp.getState().resendMessage(msg.workspaceId, msg.agentId, interrupted.content)
                : undefined
            }
          />
        ) : undefined
      }
    />
  );
}

/**
 * Desktop agent turn: the shared view, with the store-driven SubagentBar mounted
 * as its slot. Loads the turn's specialist runs lazily on reload; kept live
 * during a session by subagent:updated.
 */
function AgentMessage({ msg }: { msg: ChatMessage }) {
  const subRuns = useApp((s) => s.subagentRuns[msg.id]);
  const subCount = subRuns?.length ?? msg.meta?.subagents ?? 0;
  const subsLoaded = subRuns !== undefined;
  useEffect(() => {
    if ((msg.meta?.subagents ?? 0) > 0 && !subsLoaded) void useApp.getState().loadSubagents(msg.workspaceId, msg.id);
  }, [msg.workspaceId, msg.id, msg.meta?.subagents, subsLoaded]);
  return <AgentMessageView message={msg} subagentSlot={<SubagentBar messageId={msg.id} count={subCount} />} />;
}

/** Color for a specialist run's status dot. */
function subStatusClass(status: SubagentRun['status']): string {
  return status === 'running' ? 'bg-accent' : status === 'error' ? 'bg-err' : 'bg-ok';
}

/**
 * Dropdown listing the specialist sub-agents a turn spawned — shown near the
 * response details, each row opening the specialist's full trace as a read-only
 * preview. Header shows immediately from the stamped count; rows fill in once
 * the runs load.
 */
function SubagentBar({ messageId, count }: { messageId: string; count: number }) {
  const runs = useApp((s) => s.subagentRuns[messageId]);
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  const list = runs ?? [];
  return (
    <div className="mb-1.5 px-1">
      <button
        className="group/subs flex items-center gap-1.5 py-0.5 text-xs text-faint transition-colors hover:text-muted"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
        <Waypoints size={11} className="shrink-0" />
        <span>
          {count} subagent{count === 1 ? '' : 's'}
        </span>
        {!open && list.length > 0 && (
          <span className="flex items-center gap-1">
            {list.map((r) => (
              <span key={r.id} className={clsx('h-1.5 w-1.5 rounded-full', subStatusClass(r.status))} />
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-1 border-l-2 pl-2">
          {list.length === 0 ? (
            <div className="flex items-center gap-1.5 px-1 py-0.5 text-2xs text-faint">
              <Spinner className="!h-3 !w-3" /> Loading…
            </div>
          ) : (
            list.map((r) => <SubagentRow key={r.id} run={r} />)
          )}
        </div>
      )}
    </div>
  );
}

function SubagentRow({ run }: { run: SubagentRun }) {
  const failed = run.status === 'error';
  const settings = useApp((s) => s.settings);
  return (
    <button
      className={clsx(
        'flex w-full items-center gap-2 rounded-ctl border bg-surface/60 px-2.5 py-1.5 text-left text-xs transition-colors hover:border-accent/40',
        failed && 'border-err/40'
      )}
      title="Open the specialist's full trace"
      onClick={() => useApp.getState().setModal({ kind: 'subagent-preview', run })}
    >
      <Waypoints size={12} className="shrink-0 text-muted" />
      <span className="shrink-0 font-medium">{roleLabel(run.role, settings)}</span>
      <span className="min-w-0 flex-1 truncate text-2xs text-muted">{roleModelLabel(run)}</span>
      {run.durationMs != null && <span className="shrink-0 text-2xs text-faint">{formatDuration(run.durationMs)}</span>}
      {run.status === 'running' ? (
        <Spinner className="!h-3 !w-3" />
      ) : failed ? (
        <XCircle size={12} className="shrink-0 text-err" />
      ) : (
        <CheckCircle2 size={12} className="shrink-0 text-ok" />
      )}
    </button>
  );
}

/** Desktop live turn: flatten the store's LiveTurn (final + delta + accumulating
 *  block) into the block list the shared view renders. */
function LiveTurnView({ turn }: { turn: LiveTurn }) {
  const blocks: AgentBlock[] = [...turn.finalBlocks, ...turn.deltaBlocks];
  if (turn.accumType && turn.accumText) {
    blocks.push({ type: turn.accumType, text: turn.accumText } as AgentBlock);
  }
  return <SharedLiveTurnView blocks={blocks} running={turn.running} startedAt={turn.startedAt} />;
}

/**
 * Desktop attachment chip: the shared chip wired to open an in-app preview modal
 * (previewable when the attachment has a path or inline text). The composer
 * imports this for its pending-attachment list (with onRemove).
 */
export function AttachmentChip({
  a,
  onRemove,
  workspaceId,
}: {
  a: Attachment;
  onRemove?: () => void;
  /** when set, the chip is clickable to preview the attachment */
  workspaceId?: string;
}) {
  const [preview, setPreview] = useState(false);
  const clickable = !!workspaceId && (!!a.path || a.text != null);
  return (
    <>
      <SharedAttachmentChip a={a} onRemove={onRemove} onOpen={clickable ? () => setPreview(true) : undefined} />
      {preview && workspaceId && (
        <AttachmentPreviewModal workspaceId={workspaceId} attachment={a} onClose={() => setPreview(false)} />
      )}
    </>
  );
}

