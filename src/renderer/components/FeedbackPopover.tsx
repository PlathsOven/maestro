import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { useApp } from '../store/app';
import { useDismiss } from './common';

/**
 * The feedback box (§10): a small glass card anchored above the Settings gear.
 * Sends a `feedback` PostHog event with the typed text (and, when opened from an
 * error, that error's message) — the only content ever transmitted. Diagnostics
 * are the same non-identifying fields app_opened sends.
 */
export default function FeedbackPopover() {
  const panel = useApp((s) => s.feedbackPanel);
  const close = useApp((s) => s.closeFeedback);
  const [text, setText] = useState('');
  const [error, setError] = useState<typeof panel.error>(panel.error);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, close, ref);

  const canSend = (!!text.trim() || !!error) && !sending;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setFailure(null);
    const { data } = await tryInvoke('feedback:send', { text, includeDiagnostics, error });
    setSending(false);
    if (data?.ok) {
      setDone(true);
      setTimeout(close, 1200);
    } else {
      setFailure(data?.error ?? 'Couldn’t send feedback');
    }
  };

  return (
    <div ref={ref} className="glass absolute bottom-full left-2 z-50 mb-2 w-72 rounded-card p-3 text-xs shadow-lg">
      {done ? (
        <div className="py-6 text-center text-muted">Thanks — sent.</div>
      ) : (
        <>
          <textarea
            autoFocus
            rows={4}
            className="w-full resize-none rounded border bg-bg px-2 py-1.5 text-xs outline-none focus:border-accent/60"
            placeholder="What's broken, or what would make Maestro better?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
            }}
          />
          {error && (
            <div className="mt-1.5 flex items-center gap-1.5 rounded bg-raised px-2 py-1 text-2xs text-muted">
              <span className="min-w-0 flex-1 truncate">Attached: {error.message}</span>
              <button className="shrink-0 hover:text-fg" title="Don't include this error" onClick={() => setError(undefined)}>
                <X size={12} />
              </button>
            </div>
          )}
          <label className="mt-2 flex items-center gap-1.5 text-2xs text-muted">
            <input type="checkbox" checked={includeDiagnostics} onChange={(e) => setIncludeDiagnostics(e.target.checked)} />
            Include app version & OS
          </label>
          {failure && <div className="mt-1.5 text-2xs text-err">{failure}</div>}
          <div className="mt-2 flex justify-end gap-1.5">
            <button className="btn btn-ghost text-2xs" onClick={close}>
              Cancel
            </button>
            <button className="btn btn-accent text-2xs" disabled={!canSend} onClick={() => void send()}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
