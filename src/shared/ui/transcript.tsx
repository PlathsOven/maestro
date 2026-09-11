'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, Bot, Check, ChevronDown, ChevronRight, Copy, KeyRound, Pencil, User, Waypoints } from 'lucide-react';
import type { AgentBlock, ChatMessage } from '../types';
import { formatDuration, timeAgo } from './format';
import { BlockList, AttachmentChip, answerStart } from './blocks';
import { Markdown } from './Markdown';
import { Spinner } from './primitives';
import { useUiHost } from './host';

/**
 * The chat transcript views, moved to the shared UI package (web-desktop-parity
 * spec §2.5, §6.3) so the renderer and Maestro Web render each turn identically.
 * Store/IPC dependencies are lifted to props (onResend / onReport / subagentSlot)
 * and the host context (copyText); the renderer wraps these with thin store-bound
 * adapters, the web wires them to relay jobs.
 */

/** Elapsed milliseconds as a compact "8m, 4.4s" / "4.4s" / "1h, 8m" string. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h, ${m}m`;
  if (m > 0) return `${m}m, ${s.toFixed(1)}s`;
  return `${s.toFixed(1)}s`;
}

/**
 * A bare live elapsed-time label — no spinner, ticking ~10×/s so the tenths
 * update smoothly. Pairs with a separate loading animation to show how long the
 * current work has been running.
 */
export function ElapsedTime({ startedAt, className }: { startedAt: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  return (
    <span className={clsx('shrink-0 font-mono text-2xs tabular-nums text-faint', className)}>
      {formatElapsed(now - startedAt)}
    </span>
  );
}

/**
 * Hover action on a finished turn: copy the agent's answer as markdown — the same
 * blocks foldBlocks leaves on screen (see answerStart), so what lands on the
 * clipboard is what you were reading, without the folded tool calls and narration.
 */
export function CopyResponse({ blocks }: { blocks: AgentBlock[] }) {
  const host = useUiHost();
  const [copied, setCopied] = useState(false);
  const text = useMemo(
    () =>
      blocks
        .slice(answerStart(blocks))
        .map((b) => (b as Extract<AgentBlock, { type: 'text' }>).text.trim())
        .filter(Boolean)
        .join('\n\n'),
    [blocks]
  );
  if (!text) return null;
  return (
    <button
      className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
      title="Copy response"
      onClick={() => {
        void host.copyText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
    </button>
  );
}

function originVia(origin: string | undefined) {
  if (origin === 'claude-code') return <span className="text-accent">· via Claude Code</span>;
  if (origin === 'codex') return <span className="text-accent">· via Codex</span>;
  return null;
}

/**
 * A finished agent turn. The final answer always renders; intermediate narration
 * and tool calls fold into a single activity chip. The header chevron collapses
 * the whole turn to a one-line preview on demand. `subagentSlot` is where the
 * desktop mounts its store-driven SubagentBar; the web passes nothing.
 */
export function AgentMessageView({ message, subagentSlot }: { message: ChatMessage; subagentSlot?: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  const blocks = useMemo<AgentBlock[]>(() => {
    try {
      return JSON.parse(message.content);
    } catch {
      return [{ type: 'text', text: message.content }];
    }
  }, [message.content]);

  const failed = !!message.meta?.error;
  const preview = useMemo(() => {
    if (failed) return message.meta!.error!;
    const last = blocks
      .filter((b): b is Extract<AgentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text.trim())
      .filter(Boolean)
      .pop();
    if (last) return last.replace(/\s+/g, ' ');
    const tools = blocks.filter((b) => b.type === 'tool').length;
    return tools ? `${tools} tool call${tools === 1 ? '' : 's'}` : 'Agent response';
  }, [blocks, failed, message.meta]);

  if (collapsed) {
    return (
      <button
        className="fade-in group flex w-full items-center gap-1.5 rounded-ctl px-1 py-1 text-left transition-colors hover:bg-accent-soft/40"
        onClick={() => setCollapsed(false)}
        title="Expand agent message"
      >
        <ChevronRight size={12} className="shrink-0 text-faint" />
        <Bot size={11} className="shrink-0 text-faint" />
        <span className={clsx('min-w-0 flex-1 truncate text-xs', failed ? 'text-err' : 'text-muted')}>{preview}</span>
        <span className="shrink-0 text-2xs text-faint">{timeAgo(message.ts)}</span>
      </button>
    );
  }

  return (
    <div className="fade-in group">
      <div className="mb-1 flex select-none items-center gap-1.5 text-2xs text-faint">
        <button
          className="flex items-center gap-1.5 transition-colors hover:text-muted"
          onClick={() => setCollapsed(true)}
          title="Collapse agent message"
        >
          <ChevronDown size={11} className="text-faint" />
          <Bot size={11} />
          Agent
        </button>
        <span>· {timeAgo(message.ts)}</span>
        {message.meta?.durationMs != null && <span>· {formatDuration(message.meta.durationMs)}</span>}
        {originVia(message.meta?.origin)}
        <CopyResponse blocks={blocks} />
      </div>
      {subagentSlot ??
        ((message.meta?.subagents ?? 0) > 0 ? (
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs text-faint">
            <Waypoints size={11} className="shrink-0" />
            {message.meta!.subagents} subagent{message.meta!.subagents === 1 ? '' : 's'}
          </div>
        ) : null)}
      <BlockList blocks={blocks} folded />
      {message.meta?.error && <div className="mt-1 px-1 text-xs text-err">{message.meta.error}</div>}
    </div>
  );
}

/**
 * A user turn: rendered markdown with hover actions to copy the raw text or
 * edit-and-resend it. "Edit" opens an inline editor and, on send, calls
 * `onResend(text)` — a normal new turn on this chat; the original stays.
 */
export function UserMessageView({ message, onResend }: { message: ChatMessage; onResend?: (text: string) => void }) {
  const host = useUiHost();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !editing) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
  }, [draft, editing]);

  const copy = () => {
    void host.copyText(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const submit = () => {
    const text = draft.trim();
    setEditing(false);
    if (!text || text === message.content) return;
    onResend?.(text);
  };

  return (
    // data-user-msg: anchor for the desktop floating-prompt overlay.
    <div className="fade-in group" data-user-msg={message.id}>
      <div className="mb-1 flex select-none items-center gap-1.5 text-2xs text-faint">
        <User size={11} />
        You
        <span>· {timeAgo(message.ts)}</span>
        {message.meta?.origin === 'web' && <span className="text-accent">· from Maestro Web</span>}
        {originVia(message.meta?.origin)}
        {!editing && (
          <span className="ml-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button className="rounded p-0.5 hover:text-fg" title="Copy message" onClick={copy}>
              {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
            </button>
            {onResend && (
              <button
                className="rounded p-0.5 hover:text-fg"
                title="Edit & resend"
                onClick={() => {
                  setDraft(message.content);
                  setEditing(true);
                }}
              >
                <Pencil size={12} />
              </button>
            )}
          </span>
        )}
      </div>
      {editing ? (
        <div className="rounded-card border border-accent/50 bg-user-msg px-3 py-2.5">
          <textarea
            ref={taRef}
            className="w-full resize-none bg-transparent text-body leading-relaxed outline-none"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="mt-2 flex items-center gap-1.5">
            <span className="mr-auto text-2xs text-faint">Sends a revised message · ↵ send · esc cancel</span>
            <button className="btn h-6 px-2 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn btn-accent h-6 px-2 text-xs" disabled={!draft.trim()} onClick={submit}>
              Send
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-card border bg-user-msg px-3.5 py-2.5">
          <Markdown text={message.content} />
          {message.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {message.attachments.map((a, i) => (
                <AttachmentChip key={i} a={a} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Pfix = { kind: 'harness-auth'; harness: string; loginId?: string } | undefined;

/**
 * A system note. Most are dead ends the user must act on elsewhere; one carrying
 * a `fix` becomes a repair card — the desktop passes its AuthFix as `fixSlot`,
 * the web passes an advisory line. `onReport` sends the error to the developer.
 */
export function SystemMessageView({
  message,
  onReport,
  fixSlot,
}: {
  message: ChatMessage;
  onReport?: () => Promise<boolean>;
  fixSlot?: React.ReactNode;
}) {
  const fix = message.meta?.fix as Pfix;
  const [report, setReport] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  if (!fix)
    return (
      <div className="fade-in flex items-start gap-2 px-1 text-xs text-err">
        <span className="min-w-0 flex-1 break-words">{message.content}</span>
        {onReport && (
          <button
            className="shrink-0 text-2xs text-muted hover:text-fg disabled:opacity-60"
            disabled={report === 'sending' || report === 'sent'}
            title="Send this error to the developer"
            onClick={async () => {
              setReport('sending');
              const ok = await onReport();
              setReport(ok ? 'sent' : 'failed');
            }}
          >
            {report === 'sending' ? 'Sending…' : report === 'sent' ? 'Sent ✓' : report === 'failed' ? 'Retry' : 'Report'}
          </button>
        )}
      </div>
    );
  return (
    <div className="fade-in space-y-2 rounded-card border bg-surface px-3 py-2.5">
      <div className="flex gap-2">
        <KeyRound size={13} className="mt-0.5 shrink-0 text-warn" />
        <Markdown text={message.content} className="min-w-0 flex-1 text-xs" />
      </div>
      {fixSlot}
    </div>
  );
}

/** A live, streaming turn: the blocks so far + a trailing spinner and elapsed
 *  timer, or "Thinking…" before the first block. */
export function LiveTurnView({ blocks, running, startedAt }: { blocks: AgentBlock[]; running: boolean; startedAt: number }) {
  return (
    <div className="fade-in">
      <div className="mb-1 flex select-none items-center gap-1.5 text-2xs text-faint">
        <Bot size={11} />
        Agent
      </div>
      {blocks.length === 0 && running ? (
        <div className="flex items-center gap-2 px-1 text-xs text-muted">
          <Spinner className="!h-3 !w-3" /> Thinking…
          <ElapsedTime startedAt={startedAt} />
        </div>
      ) : (
        <>
          <BlockList blocks={blocks} streaming={running} folded={!running} />
          {running && (
            <div className="mt-1.5 flex items-center gap-2 px-1">
              <Spinner className="!h-3.5 !w-3.5" />
              <ElapsedTime startedAt={startedAt} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Dispatch one message to its view by role. */
export function MessageView({
  message,
  onResend,
  onReport,
  agentSubagentSlot,
}: {
  message: ChatMessage;
  onResend?: (text: string) => void;
  onReport?: () => Promise<boolean>;
  agentSubagentSlot?: React.ReactNode;
}) {
  if (message.role === 'user') return <UserMessageView message={message} onResend={onResend} />;
  if (message.role === 'system') return <SystemMessageView message={message} onReport={onReport} />;
  return <AgentMessageView message={message} subagentSlot={agentSubagentSlot} />;
}

/**
 * The web transcript column (web-desktop-parity §6.2): the desktop column markup
 * (max-w-3xl, space-y-4), auto-scroll-to-bottom when the user is already at the
 * bottom, and a floating "Jump to latest" pill otherwise. The desktop uses its
 * own richer ChatPane instead; this is the web's scroller.
 */
export function TranscriptColumn({
  messages,
  live,
  pendingAskSlot,
  onResend,
  onReport,
  onNearTop,
  className,
}: {
  messages: ChatMessage[];
  live?: { blocks: AgentBlock[]; startedAt: number } | null;
  pendingAskSlot?: React.ReactNode;
  onResend?: (message: ChatMessage, text: string) => void;
  onReport?: (message: ChatMessage) => Promise<boolean>;
  /** Fired when the user scrolls within 200px of the top (load older history). */
  onNearTop?: () => void;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow the tail while pinned; re-runs every render (a streaming turn re-renders
  // often), matching the desktop's tail-follow.
  useEffect(() => {
    const el = scrollRef.current;
    if (pinned && el) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setPinned(atBottom);
    if (el.scrollTop < 200) onNearTop?.();
  };

  const jump = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className={clsx('min-h-0 flex-1 overflow-y-auto px-3 py-4', className)}>
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((m) => (
            <MessageView
              key={m.id}
              message={m}
              onResend={onResend ? (text) => onResend(m, text) : undefined}
              onReport={onReport ? () => onReport(m) : undefined}
            />
          ))}
          {live && <LiveTurnView blocks={live.blocks} running startedAt={live.startedAt} />}
          {pendingAskSlot}
        </div>
      </div>
      {!pinned && (
        <button
          className="btn glass absolute bottom-3 right-3 z-10 gap-1"
          title="Jump to latest"
          onClick={jump}
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}
    </div>
  );
}
