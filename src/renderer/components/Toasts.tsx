import clsx from 'clsx';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useApp } from '../store/app';

export default function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const reportError = useApp((s) => s.reportError);
  const openFeedback = useApp((s) => s.openFeedback);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'glass pointer-events-auto fade-in flex items-start gap-2 px-3 py-2.5 text-xs',
            t.kind === 'error' && 'border-err/40'
          )}
        >
          {t.kind === 'error' ? (
            <AlertCircle size={14} className="mt-px shrink-0 text-err" />
          ) : t.kind === 'success' ? (
            <CheckCircle2 size={14} className="mt-px shrink-0 text-ok" />
          ) : (
            <Info size={14} className="mt-px shrink-0 text-muted" />
          )}
          <div className="min-w-0 flex-1 break-words">{t.text}</div>
          {/* One click, nothing to fill in — the "minimal button" (§10). A second,
              muted link opens the feedback box for users who want to say more. */}
          {t.kind === 'error' && (
            <>
              <button
                className="shrink-0 text-2xs text-muted hover:text-fg disabled:opacity-60"
                disabled={t.report === 'sending' || t.report === 'sent'}
                title="Send this error to the developer"
                onClick={() => void reportError({ message: t.text, source: 'toast', at: Date.now() }, t.id)}
              >
                {t.report === 'sending' ? 'Sending…' : t.report === 'sent' ? 'Sent ✓' : t.report === 'failed' ? 'Retry' : 'Report'}
              </button>
              <button
                className="shrink-0 text-2xs text-faint hover:text-fg"
                title="Add details before sending"
                onClick={() => openFeedback({ message: t.text, source: 'toast', at: Date.now() })}
              >
                Add details
              </button>
            </>
          )}
          <button className="shrink-0 text-faint hover:text-fg" onClick={() => dismiss(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
