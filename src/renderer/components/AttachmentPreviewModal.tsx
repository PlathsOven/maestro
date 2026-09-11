import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { invoke, tryInvoke } from '../lib/api';
import { Modal, Spinner } from './common';
import type { Attachment, AttachmentPreview } from '../../shared/types';

/**
 * Preview a chat attachment in-app: images as a lightbox, text/logs/notes in a
 * scrollable viewer. Anything we can't render inline (binary, too large) is
 * handed off to the OS default app via `fs:open` and the modal closes itself.
 */
export default function AttachmentPreviewModal({
  workspaceId,
  attachment,
  onClose,
}: {
  workspaceId: string;
  attachment: Attachment;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // Comments/notes carry their text on the message — no file to read.
    if (attachment.text != null && !attachment.path) {
      setPreview({ kind: 'text', text: attachment.text, name: attachment.label });
      setLoading(false);
      return;
    }
    if (!attachment.path) {
      setPreview({ kind: 'binary', name: attachment.label, error: 'Nothing to preview' });
      setLoading(false);
      return;
    }
    void tryInvoke('attachment:read', { workspaceId, path: attachment.path }).then(({ data, error }) => {
      if (!alive) return;
      const result: AttachmentPreview = data ?? { kind: 'binary', error: error ?? 'Could not read attachment' };
      // Not renderable inline → open it in the OS default app and dismiss.
      if (result.kind === 'binary' && attachment.path) {
        void invoke('fs:open', { workspaceId, path: attachment.path });
        onClose();
        return;
      }
      setPreview(result);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [workspaceId, attachment, onClose]);

  const openExternal = attachment.path
    ? () => void invoke('fs:open', { workspaceId, path: attachment.path! })
    : undefined;

  return (
    <Modal
      title={attachment.label}
      onClose={onClose}
      width={preview?.kind === 'image' ? 900 : 720}
      footer={
        openExternal && (
          <button className="btn gap-1.5 text-xs" onClick={openExternal}>
            <ExternalLink size={12} /> Open in default app
          </button>
        )
      }
    >
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : preview?.kind === 'image' ? (
        <div className="flex justify-center">
          <img src={preview.dataUrl} alt={attachment.label} className="max-h-[64vh] max-w-full rounded-card" />
        </div>
      ) : preview?.kind === 'text' ? (
        <pre className="max-h-[64vh] overflow-auto whitespace-pre-wrap break-words rounded-card border bg-surface p-3 font-mono text-xs leading-relaxed text-fg">
          {preview.text}
        </pre>
      ) : (
        <div className="py-8 text-center text-xs text-muted">{preview?.error ?? 'Nothing to preview'}</div>
      )}
    </Modal>
  );
}
