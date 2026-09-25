'use client';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, ImagePlus, Square } from 'lucide-react';
import clsx from 'clsx';
import { useUiHost } from '../host';
import { GLASS_FIELD, LiquidGlass } from '../LiquidGlass';

/**
 * The composer frame (web-desktop-parity spec §7.1): box + auto-growing textarea
 * + chip row + send/stop pill, with the queued card above. Prop-driven — the
 * desktop passes model/effort/roles/plan chips + attach/mic/refine as slots, the
 * web passes its subset. Keyboard rule (G4): on a hardware keyboard Enter sends
 * and ⇧Enter newlines; on a soft keyboard Enter newlines and the pill sends.
 *
 * Photos (§6.4): when `onAttach`/`onFiles` are set the composer shows a paperclip
 * that opens a file picker, and accepts pasted / drag-dropped images. Pending
 * attachments render in `attachmentsBar`; `canSendEmpty` lets a photo-only message
 * (no text) send.
 */
export function ComposerFrame({
  value,
  onChange,
  onSend,
  onStop,
  running,
  disabled,
  placeholder,
  leftChips,
  rightChips,
  queuedCard,
  onSchedule,
  onAttach,
  onFiles,
  attachmentsBar,
  canSendEmpty,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  running?: boolean;
  disabled?: boolean;
  placeholder?: string;
  leftChips?: React.ReactNode;
  rightChips?: React.ReactNode;
  queuedCard?: React.ReactNode;
  /** When set, the send pill gets a "Schedule for later" split button. */
  onSchedule?: () => void;
  /** When set, shows a paperclip that opens the file picker (photo attach). */
  onAttach?: () => void;
  /** When set, pasted / dropped image files are handed here. */
  onFiles?: (files: File[]) => void;
  /** Pending-attachment chips/thumbnails, shown under the textarea. */
  attachmentsBar?: React.ReactNode;
  /** Allow sending with empty text (there are pending attachments). */
  canSendEmpty?: boolean;
}) {
  const { isTouch } = useUiHost();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
    // Only scroll once capped: a fractional line-height rounds scrollHeight down a
    // pixel, which would otherwise flash a scrollbar on every wrapped line.
    ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
  }, [value]);

  const ready = value.trim().length > 0 || !!canSendEmpty;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (ready) onSend();
    } else if (e.key === 'Enter' && !e.shiftKey && !isTouch) {
      e.preventDefault();
      if (ready) onSend();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (!onFiles) return;
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      onFiles(files);
    }
  };

  const dropProps = onFiles
    ? {
        onDragEnter: (e: React.DragEvent) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        },
        onDragOver: (e: React.DragEvent) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) onFiles(files);
        },
      }
    : {};

  return (
    // Positioning-agnostic: the host floats this over its transcript (the web's
    // WorkspaceScreen docks it absolutely and pads the scroller by its measured
    // height). The gutters pass taps through to the transcript underneath.
    <div className="pointer-events-none px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
      <div className="pointer-events-auto mx-auto max-w-3xl">
        {queuedCard}
        <LiquidGlass
          radius={22}
          {...GLASS_FIELD}
          tint="light"
          className="lg-field"
          {...dropProps}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[22px] border-2 border-dashed border-accent/70 bg-accent-tint text-xs font-medium text-accent">
              Drop images to attach
            </div>
          )}
          <textarea
            ref={taRef}
            className="relative w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-body outline-none placeholder:text-faint"
            rows={2}
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {attachmentsBar}
          <div className="relative flex items-center gap-1 px-2.5 pb-2.5">
            {leftChips}
            <span className="flex-1" />
            {rightChips}
            {onAttach && (
              <button
                className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-accent-soft hover:text-fg disabled:opacity-45"
                title="Attach photos"
                onClick={onAttach}
                disabled={disabled}
              >
                <ImagePlus size={15} />
              </button>
            )}
            {/* While a turn runs, Stop and the Send pill sit side by side (desktop
                parity): Stop halts the turn, the pill queues the typed message to
                run when it finishes. The pill is always present so there's always a
                visible send affordance — only its title changes. */}
            {running && (
              <button
                className="flex h-8 w-8 items-center justify-center rounded-full border border-err/40 text-err transition-colors hover:bg-err/10 disabled:opacity-45"
                title="Stop agent (also clears the queue)"
                onClick={onStop}
                disabled={!onStop}
              >
                <Square size={11} fill="currentColor" />
              </button>
            )}
            <div className="flex h-8 items-stretch overflow-hidden rounded-full bg-ink text-on-ink shadow-sm">
              <button
                className={clsx(
                  'flex w-8 items-center justify-center transition-colors hover:bg-on-ink/10 disabled:opacity-40 disabled:hover:bg-transparent',
                  onSchedule && 'pl-0.5'
                )}
                title={running ? 'Queue message (runs when the agent finishes)' : 'Send (↵)'}
                onClick={onSend}
                disabled={disabled || !ready}
              >
                <ArrowUp size={15} strokeWidth={2.4} />
              </button>
              {onSchedule && (
                <>
                  <span aria-hidden className="my-2 w-px bg-on-ink/25" />
                  <button
                    className="flex w-6 items-center justify-center pr-0.5 transition-colors hover:bg-on-ink/10 disabled:opacity-40 disabled:hover:bg-transparent"
                    title="Schedule for later"
                    onClick={onSchedule}
                    disabled={disabled || !value.trim()}
                  >
                    <ChevronDown size={13} />
                  </button>
                </>
              )}
            </div>
          </div>
        </LiquidGlass>
      </div>
    </div>
  );
}
