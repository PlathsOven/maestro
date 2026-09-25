'use client';
import { useState } from 'react';
import clsx from 'clsx';
import { ArrowUp, Laptop, Pencil, Server, X } from 'lucide-react';
import { CountBadge } from '../primitives';
import { useUiHost } from '../host';

/**
 * The queued-messages card above the composer (web-desktop-parity spec §7.4).
 * Prop-driven so the desktop and web share it. Inline edit: Enter saves, Esc
 * cancels; on touch a Save/Cancel pair appears.
 */
export interface QueuedItem {
  id: string;
  text: string;
  pending?: 'desktop' | 'box';
}

export function QueuedCard({
  items,
  onEdit,
  onRemove,
  onSendNow,
}: {
  items: QueuedItem[];
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  /** "Send now" / steer — interrupt the running turn to run this message next.
   *  Omit (or leave undefined) to hide the action (e.g. when nothing is running). */
  onSendNow?: (id: string) => void;
}) {
  const { isTouch } = useUiHost();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (items.length === 0) return null;
  const iconBtn = 'shrink-0 rounded-full p-1 text-faint transition-colors hover:bg-accent-soft hover:text-fg';
  return (
    <div data-motion="collapse" className="mb-2 rounded-card border bg-raised/80 p-1 shadow-[var(--shadow)] backdrop-blur-xl">
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted">
        Queued <CountBadge count={items.length} />
      </div>
      {items.map((m) => (
        <div
          key={m.id}
          data-motion="row"
          className={clsx(
            'group flex items-start gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
            editing !== m.id && 'hover:bg-accent-soft'
          )}
        >
          {editing === m.id ? (
            <>
              <textarea
                className="input flex-1 text-xs"
                rows={2}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (!isTouch && e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onEdit(m.id, draft);
                    setEditing(null);
                  } else if (e.key === 'Escape') setEditing(null);
                }}
              />
              <button className="btn btn-ghost h-7 px-3 text-2xs" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="btn btn-accent h-7 px-3 text-2xs"
                onClick={() => {
                  onEdit(m.id, draft);
                  setEditing(null);
                }}
              >
                Save
              </button>
            </>
          ) : (
            <>
              <span className="line-clamp-2 min-w-0 flex-1 py-0.5 text-fg/90">{m.text}</span>
              {m.pending ? (
                <span
                  className="flex shrink-0 items-center gap-1 py-0.5 text-2xs text-warn"
                  title={
                    m.pending === 'box'
                      ? "This server is offline — the message runs when it's back."
                      : "Your desktop is offline — the message runs when it reconnects."
                  }
                >
                  {m.pending === 'box' ? <Server size={11} /> : <Laptop size={11} />}
                  {m.pending === 'box' ? 'Server offline' : 'Desktop offline'}
                </span>
              ) : (
                <>
                  {onSendNow && (
                    <button
                      className={iconBtn}
                      title="Send now — interrupt the current turn to run this message next"
                      onClick={() => onSendNow(m.id)}
                    >
                      <ArrowUp size={12} />
                    </button>
                  )}
                  <button
                    className={iconBtn}
                    title="Edit"
                    onClick={() => {
                      setDraft(m.text);
                      setEditing(m.id);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                </>
              )}
              <button
                className="shrink-0 rounded-full p-1 text-faint transition-colors hover:bg-accent-soft hover:text-err"
                title="Remove"
                onClick={() => onRemove(m.id)}
              >
                <X size={12} />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
