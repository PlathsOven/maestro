'use client';
import React, { useEffect, useRef } from 'react';
import { ArrowUp, ChevronDown, Square } from 'lucide-react';
import { useUiHost } from '../host';

/**
 * The composer frame (web-desktop-parity spec §7.1): box + auto-growing textarea
 * + chip row + send/stop pill, with the queued card above. Prop-driven — the
 * desktop passes model/effort/roles/plan chips + attach/mic/refine as slots, the
 * web passes its subset. Keyboard rule (G4): on a hardware keyboard Enter sends
 * and ⇧Enter newlines; on a soft keyboard Enter newlines and the pill sends.
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
}) {
  const { isTouch } = useUiHost();
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  }, [value]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    } else if (e.key === 'Enter' && !e.shiftKey && !isTouch) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="safe-b sticky bottom-0 z-10 bg-canvas px-3 pb-2 pt-1">
      <div className="mx-auto max-w-3xl">
        {queuedCard}
        <div className="rounded-card border bg-surface focus-within:border-accent/60">
          <textarea
            ref={taRef}
            className="w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-body outline-none"
            rows={2}
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            {leftChips}
            <span className="flex-1" />
            {rightChips}
            {running ? (
              <button
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-err/50 text-err"
                title="Stop agent (also clears the queue)"
                onClick={onStop}
                disabled={!onStop}
              >
                <Square size={11} />
              </button>
            ) : (
              <div className="flex h-7 items-center overflow-hidden rounded-lg bg-accent text-white">
                <button
                  className="flex h-full items-center px-2 disabled:opacity-45"
                  title="Send (↵)"
                  onClick={onSend}
                  disabled={disabled || !value.trim()}
                >
                  <ArrowUp size={14} strokeWidth={2.4} />
                </button>
                {onSchedule && (
                  <button
                    className="flex h-full items-center border-l border-white/25 px-1 disabled:opacity-45"
                    title="Schedule for later"
                    onClick={onSchedule}
                    disabled={disabled || !value.trim()}
                  >
                    <ChevronDown size={13} />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
