'use client';
import { useEffect } from 'react';
import clsx from 'clsx';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useUiHost } from './host';

/**
 * Toast stack, moved to the shared UI package (web-desktop-parity spec §13.3).
 * Glass cards, bottom-right on the desktop and bottom-inset on the phone (chosen
 * by the host's coarse-pointer flag). Errors linger 8s and carry their actions
 * (e.g. Report); other kinds auto-dismiss after 4s.
 */
export interface ToastData {
  id: string;
  kind: 'error' | 'info' | 'success';
  text: string;
  actions?: { label: string; onClick: () => void }[];
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastData[]; onDismiss: (id: string) => void }) {
  const { isTouch } = useUiHost();
  return (
    <div
      className={clsx(
        'pointer-events-none fixed z-[100] flex flex-col gap-2',
        isTouch
          ? 'inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+12px)]'
          : 'bottom-4 right-4 w-96'
      )}
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  useEffect(() => {
    const ms = toast.kind === 'error' ? 8000 : 4000;
    const id = window.setTimeout(onDismiss, ms);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);
  return (
    <div
      className={clsx(
        'glass pointer-events-auto fade-in flex items-start gap-2 px-3 py-2.5 text-xs',
        toast.kind === 'error' && 'border-err/40'
      )}
    >
      {toast.kind === 'error' ? (
        <AlertCircle size={14} className="mt-px shrink-0 text-err" />
      ) : toast.kind === 'success' ? (
        <CheckCircle2 size={14} className="mt-px shrink-0 text-ok" />
      ) : (
        <Info size={14} className="mt-px shrink-0 text-muted" />
      )}
      <div className="min-w-0 flex-1 break-words">{toast.text}</div>
      {toast.actions?.map((a, i) => (
        <button key={i} className="shrink-0 text-2xs text-muted hover:text-fg" onClick={a.onClick}>
          {a.label}
        </button>
      ))}
      <button className="shrink-0 text-faint hover:text-fg" onClick={onDismiss}>
        <X size={13} />
      </button>
    </div>
  );
}
