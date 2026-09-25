import { getWindow } from '../bus';

/**
 * One definition of "is the user looking at Maestro?" for every background poller
 * (perf-cpu-ram §4.6). A backgrounded app still has to notice PRs merging, dev
 * servers starting and boxes journalling — it just doesn't have to notice them
 * within a second — so pollers multiply their delay by `backgroundFactor()` and
 * the ones that can react instantly (the cloud follower's backoff) subscribe to
 * `onForeground` to snap back the moment the window comes forward.
 *
 * No window (an e2e script, a headless run) counts as background: nothing is
 * watching, so the slow cadence is the right one.
 */

/** How much slower background polls run. 4× is the cadence `pr.ts` proved out. */
const BACKGROUND_MULT = 4;

const foreground = new Set<() => void>();
let bound: unknown = null; // the window whose focus events we already listen to
let focused = false;

/** Fed by both the window's own events and every `backgroundFactor()` call, so a
 *  listener fires once per transition however the change is noticed. */
function setFocused(next: boolean): void {
  if (next === focused) return;
  focused = next;
  if (!next) return;
  for (const fn of foreground) {
    try {
      fn();
    } catch {
      /* a foreground listener must never break the poller that noticed */
    }
  }
}

/** 1 while the window is in front, 4 while it's behind another app, minimized or
 *  not created yet. */
export function backgroundFactor(): 1 | 4 {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    // Services register at import time, before index.ts creates the window; bind
    // to it the first time a poll sees one.
    if (win !== bound) {
      bound = win;
      win.on('focus', () => setFocused(true));
      win.on('blur', () => setFocused(false));
    }
    setFocused(win.isFocused());
  } else {
    setFocused(false);
  }
  return focused ? 1 : BACKGROUND_MULT;
}

/** Run `fn` whenever the window comes back to the front. Registration order and
 *  arrival time don't matter: listeners are permanent and idempotent to add. */
export function onForeground(fn: () => void): void {
  foreground.add(fn);
}
