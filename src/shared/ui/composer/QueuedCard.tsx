'use client';
import { useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowUp, ImagePlus, Laptop, Loader2, Pencil, Server, X } from 'lucide-react';
import { CountBadge } from '../primitives';
import { useUiHost } from '../host';

/**
 * The queued-messages card above the composer (web-desktop-parity §7.4).
 * Prop-driven so the desktop and web share it. Inline edit: Enter saves, Esc
 * cancels; on touch a Save/Cancel pair appears. A message's photos show as
 * thumbnails; when `onUploadPhoto` is set and the item is `photosEditable`, the
 * editor can remove them or add more.
 */
export interface QueuedPhoto {
  id: string;
  name: string;
  /** Anything an <img> can load — a relay URL or a local data URL. */
  src: string;
}

export interface QueuedItem {
  id: string;
  text: string;
  pending?: 'desktop' | 'box';
  photos?: QueuedPhoto[];
  /** The host can rewrite this item's photos (e.g. the web owns its refs). */
  photosEditable?: boolean;
}

export function QueuedCard({
  items,
  onEdit,
  onRemove,
  onSendNow,
  onUploadPhoto,
}: {
  items: QueuedItem[];
  /** `photos` is set only when the edit changed them; undefined keeps them. */
  onEdit: (id: string, text: string, photos?: QueuedPhoto[]) => void;
  onRemove: (id: string) => void;
  /** "Send now" / steer — interrupt the running turn to run this message next.
   *  Omit (or leave undefined) to hide the action (e.g. when nothing is running). */
  onSendNow?: (id: string) => void;
  /** Upload one picked image for the message being edited. */
  onUploadPhoto?: (file: File) => Promise<QueuedPhoto>;
}) {
  const { isTouch, toast } = useUiHost();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // null = photos untouched by this edit (so a text-only edit doesn't resend them).
  const [draftPhotos, setDraftPhotos] = useState<QueuedPhoto[] | null>(null);
  const [uploading, setUploading] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  if (items.length === 0) return null;
  const iconBtn = 'shrink-0 rounded-full p-1 text-faint transition-colors hover:bg-accent-soft hover:text-fg';

  const startEdit = (m: QueuedItem) => {
    setDraft(m.text);
    setDraftPhotos(null);
    setEditing(m.id);
  };

  const save = (m: QueuedItem) => {
    if (uploading > 0) return;
    setEditing(null);
    // Nothing left to send → revert (the × removes a message outright).
    if ((draft.trim() || (draftPhotos ?? m.photos ?? []).length) && (draft !== m.text || draftPhotos))
      onEdit(m.id, draft, draftPhotos ?? undefined);
  };

  const addPhotos = async (m: QueuedItem, files: File[]) => {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      setUploading((n) => n + 1);
      try {
        const p = await onUploadPhoto!(file);
        setDraftPhotos((cur) => [...(cur ?? m.photos ?? []), p]);
      } catch (e) {
        toast({ kind: 'error', text: e instanceof Error ? e.message : 'Upload failed' });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  return (
    <div data-motion="collapse" className="mb-2 rounded-card border bg-raised/80 p-1 shadow-[var(--shadow)] backdrop-blur-xl">
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted">
        Queued <CountBadge count={items.length} />
      </div>
      {items.map((m) => {
        const canPhotos = !!(m.photosEditable && onUploadPhoto);
        const photos = (editing === m.id && draftPhotos) || m.photos || [];
        return (
          <div
            key={m.id}
            data-motion="row"
            className={clsx(
              'group rounded-lg px-2.5 py-1.5 text-xs transition-colors',
              editing !== m.id && 'hover:bg-accent-soft'
            )}
          >
            {editing === m.id ? (
              <>
                <div className="flex items-start gap-1">
                  <textarea
                    className="input flex-1 text-xs"
                    rows={2}
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onPaste={(e) => {
                      const files = Array.from(e.clipboardData.files);
                      if (canPhotos && files.length) {
                        e.preventDefault();
                        void addPhotos(m, files);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (!isTouch && e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        save(m);
                      } else if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                  {canPhotos && (
                    <>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          const files = Array.from(e.target.files ?? []);
                          e.target.value = '';
                          void addPhotos(m, files);
                        }}
                      />
                      <button className="btn btn-ghost h-7 w-7 !px-0 text-muted" title="Add photos" onClick={() => fileRef.current?.click()}>
                        <ImagePlus size={14} />
                      </button>
                    </>
                  )}
                  <button className="btn btn-ghost h-7 px-3 text-2xs" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  <button className="btn btn-accent h-7 px-3 text-2xs" disabled={uploading > 0} onClick={() => save(m)}>
                    Save
                  </button>
                </div>
                {(photos.length > 0 || uploading > 0) && (
                  <PhotoThumbs
                    photos={photos}
                    uploading={uploading}
                    onRemove={canPhotos ? (id) => setDraftPhotos(photos.filter((p) => p.id !== id)) : undefined}
                  />
                )}
              </>
            ) : (
              <>
                <div className="flex items-start gap-1">
                  <span className={clsx('line-clamp-2 min-w-0 flex-1 py-0.5', m.text ? 'text-fg/90' : 'text-faint')}>
                    {m.text || 'Photo'}
                  </span>
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
                      <button className={iconBtn} title="Edit" onClick={() => startEdit(m)}>
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
                </div>
                {photos.length > 0 && <PhotoThumbs photos={photos} />}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A queued message's photos as small thumbnails; `onRemove` adds an ×. */
function PhotoThumbs({
  photos,
  uploading = 0,
  onRemove,
}: {
  photos: QueuedPhoto[];
  uploading?: number;
  onRemove?: (id: string) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {photos.map((p) => (
        <div key={p.id} className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.src} alt={p.name} title={p.name} className="h-10 w-10 rounded-md border object-cover" />
          {onRemove && (
            <button
              type="button"
              className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-ink text-on-ink shadow-sm"
              title="Remove photo"
              onClick={() => onRemove(p.id)}
            >
              <X size={9} />
            </button>
          )}
        </div>
      ))}
      {uploading > 0 && (
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-accent-soft text-faint">
          <Loader2 size={14} className="animate-spin" />
        </div>
      )}
    </div>
  );
}
