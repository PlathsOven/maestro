import { Notification } from 'electron';
import { broadcast, getWindow } from './bus';
import { Settings } from './db';
import { appIconPath } from './icon';

/** Shown notifications, held so GC can't collect one — and silently drop its
 *  click handler — while it still sits in Notification Center. */
const live = new Set<Notification>();
const LIVE_CAP = 20;

/**
 * Raise an OS notification while Maestro is in the background (notifications
 * on, window not focused). Clicking it brings Maestro forward — on the chat it
 * names, when it names one. Returns whether it was shown.
 */
export function notify(opts: { title: string; body: string; workspaceId?: string; agentId?: number }): boolean {
  const win = getWindow();
  if (!Settings.global().notifications || !win || win.isFocused() || !Notification.isSupported()) return false;
  const n = new Notification({ title: opts.title, body: opts.body, icon: appIconPath() });
  const forget = () => live.delete(n);
  n.on('close', forget);
  n.on('click', () => {
    forget();
    const w = getWindow();
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    if (opts.workspaceId) broadcast('app:openChat', { workspaceId: opts.workspaceId, agentId: opts.agentId ?? null });
  });
  live.add(n);
  if (live.size > LIVE_CAP) live.delete(live.values().next().value!);
  n.show();
  return true;
}
