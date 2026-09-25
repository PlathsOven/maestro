import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, X } from 'lucide-react';
import { on, tryInvoke } from '../lib/api';
import type { AppUpdate } from '../../shared/types';

/**
 * Conductor-style "restart to update" popup: a small, closeable card pinned to
 * the bottom-right that appears once a new version has finished downloading in
 * the background. Sits just above the transient <Toasts/> stack.
 *
 * The same slot doubles as a post-update confirmation: when the app relaunches
 * after a successful "Restart to update", it shows a one-time "Updated" card so
 * the user knows the update actually applied. The two states never coexist — a
 * just-relaunched app has nothing staged yet.
 */
export default function UpdateToast() {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stallTimer = useRef<number | undefined>(undefined);

  const [installed, setInstalled] = useState<AppUpdate | null>(null);
  const [installedDismissed, setInstalledDismissed] = useState(false);

  useEffect(() => {
    // Catch an update that landed before this mounted (checks start at launch)…
    void tryInvoke('update:pending').then(({ data }) => data && setUpdate(data));
    // …and confirm one applied by the restart that produced this very launch.
    void tryInvoke('update:installed').then(({ data }) => data && setInstalled(data));
    // …and any that arrive while the app is open.
    const offAvailable = on('update:available', (u) => {
      setUpdate(u);
      setDismissed(false);
      setInstalling(false);
      setError(null);
    });
    const offInstalled = on('update:installed', (u) => {
      setInstalled(u);
      setInstalledDismissed(false);
    });
    // A staged install can fail at the native-updater layer; recover the button.
    const offError = on('update:error', ({ message }) => {
      window.clearTimeout(stallTimer.current);
      setInstalling(false);
      setError(message || 'Update failed to install.');
    });
    return () => {
      offAvailable();
      offInstalled();
      offError();
      window.clearTimeout(stallTimer.current);
    };
  }, []);

  // The confirmation is informational — fade it out on its own after a bit, but
  // keep it dismissible in case the user wants it gone sooner.
  useEffect(() => {
    if (!installed || installedDismissed) return;
    const t = window.setTimeout(() => setInstalledDismissed(true), 8000);
    return () => window.clearTimeout(t);
  }, [installed, installedDismissed]);

  async function install() {
    setError(null);
    setInstalling(true);
    const { error: invokeError } = await tryInvoke('update:install');
    if (invokeError) {
      setInstalling(false);
      setError(invokeError);
      return;
    }
    // A successful install quits and relaunches the app within a second or two.
    // If we're still alive after a grace period the native updater failed
    // silently (e.g. Gatekeeper translocation) — stop pretending to restart.
    stallTimer.current = window.setTimeout(() => {
      setInstalling(false);
      setError((e) => e ?? 'Couldn’t restart automatically — quit and reopen Maestro to finish updating.');
    }, 12_000);
  }

  // The post-update confirmation takes priority over the ready prompt; the two
  // never both apply on the same launch.
  if (installed && !installedDismissed) {
    return (
      <div data-motion="toast" className="fixed bottom-4 right-4 z-[101] w-80">
        <div className="glass !rounded-[18px] py-3 pl-3.5 pr-2.5">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-fg">Updated · v{installed.version}</div>
              <p className="mt-0.5 text-2xs text-muted">Maestro is now up to date.</p>
            </div>
            <button
              className="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-faint hover:bg-accent-soft hover:text-fg"
              onClick={() => setInstalledDismissed(true)}
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!update || dismissed) return null;
  return (
    <div data-motion="toast" className="fixed bottom-4 right-4 z-[101] w-80">
      <div className="glass !rounded-[18px] p-3.5 pr-2.5">
        <div className="flex items-start gap-2.5">
          <ArrowUpCircle size={15} className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-fg">Update ready · v{update.version}</div>
            {update.notes && (
              <p className="mt-0.5 line-clamp-2 text-2xs text-muted">{update.notes}</p>
            )}
          </div>
          <button
            className="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-faint hover:bg-accent-soft hover:text-fg"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss update"
          >
            <X size={12} />
          </button>
        </div>
        <button
          className="btn btn-accent mt-3 h-8 w-[calc(100%-0.25rem)] text-xs"
          onClick={install}
          disabled={installing}
        >
          {installing ? 'Restarting…' : 'Restart to update'}
        </button>
        {error && <p className="mt-2 pr-1 text-2xs text-err">{error}</p>}
      </div>
    </div>
  );
}
