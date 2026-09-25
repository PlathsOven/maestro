import clsx from 'clsx';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useApp } from '../store/app';

export default function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const reportError = useApp((s) => s.reportError);
  const openFeedback = useApp((s) => s.openFeedback);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-96 flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          data-motion="toast"
          className={clsx(
            'glass pointer-events-auto flex max-w-full items-start gap-2.5 !rounded-[18px] py-2.5 pl-3.5 pr-2.5 text-xs leading-relaxed'
          )}
        >
          {t.kind === 'error' ? (
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-err" />
          ) : t.kind === 'success' ? (
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" />
          ) : (
            <Info size={14} className="mt-0.5 shrink-0 text-muted" />
          )}
          <div className="min-w-0 flex-1 break-words">{t.text}</div>
          {/* One click, nothing to fill in — the "minimal button" (§10). A second,
              muted link opens the feedback box for users who want to say more. */}
          {t.kind === 'error' && (
            <>
              <button
                className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-2xs font-medium text-fg disabled:opacity-60"
                disabled={t.report === 'sending' || t.report === 'sent'}
                title="Send this error to the developer"
                onClick={() => void reportError({ message: t.text, source: 'toast', at: Date.now() }, t.id)}
              >
                {t.report === 'sending' ? 'Sending…' : t.report === 'sent' ? 'Sent ✓' : t.report === 'failed' ? 'Retry' : 'Report'}
              </button>
              <button
                className="shrink-0 py-0.5 text-2xs text-muted hover:text-fg"
                title="Add details before sending"
                onClick={() => openFeedback({ message: t.text, source: 'toast', at: Date.now() })}
              >
                Add details
              </button>
            </>
          )}
          <button
            className="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-faint hover:bg-accent-soft hover:text-fg"
            onClick={() => dismiss(t.id)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
