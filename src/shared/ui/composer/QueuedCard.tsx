'use client';
import { useState } from 'react';
import { Laptop, Pencil, Server, X } from 'lucide-react';
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
}: {
  items: QueuedItem[];
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const { isTouch } = useUiHost();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (items.length === 0) return null;
  return (
    <div className="mb-2 rounded-card border bg-surface">
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
        Queued <CountBadge count={items.length} />
      </div>
      {items.map((m) => (
        <div key={m.id} className="flex items-start gap-2 px-3 py-1.5 text-xs">
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
              <button className="btn h-6 px-2 text-2xs" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="btn btn-accent h-6 px-2 text-2xs"
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
              <span className="line-clamp-2 min-w-0 flex-1">{m.text}</span>
              {m.pending ? (
                <span
                  className="flex shrink-0 items-center gap-1 text-2xs text-warn"
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
                <button
                  className="shrink-0 text-faint hover:text-fg"
                  onClick={() => {
                    setDraft(m.text);
                    setEditing(m.id);
                  }}
                >
                  <Pencil size={12} />
                </button>
              )}
              <button className="shrink-0 text-faint hover:text-err" onClick={() => onRemove(m.id)}>
                <X size={12} />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
