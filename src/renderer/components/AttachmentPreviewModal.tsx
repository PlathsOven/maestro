import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { invoke, tryInvoke } from '../lib/api';
import { Modal, Spinner } from './common';
import { AttachmentChip as SharedAttachmentChip } from '../../shared/ui/blocks';
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
          <button className="btn h-8 gap-1.5 px-3.5" onClick={openExternal}>
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
          <img src={preview.dataUrl} alt={attachment.label} className="max-h-[64vh] max-w-full rounded-card shadow-sm" />
        </div>
      ) : preview?.kind === 'text' ? (
        <pre className="max-h-[64vh] overflow-auto whitespace-pre-wrap break-words rounded-card bg-surface px-4 py-3.5 font-mono text-xs leading-relaxed text-fg">
          {preview.text}
        </pre>
      ) : (
        <div className="py-8 text-center text-xs text-muted">{preview?.error ?? 'Nothing to preview'}</div>
      )}
    </Modal>
  );
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

