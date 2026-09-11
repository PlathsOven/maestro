import type { SubUsage, SubUsageWindow } from './types';

// "After limits reset" scheduling (§1). Pure and type-only-imports, so it is
// unit-tested under plain node (scripts/schedule-e2e.ts) and reused by the
// remote-schedule path (§4).

export interface LimitResetTarget {
  /** Epoch ms: the first whole minute after the last tied window resets. */
  at: number;
  /** The window(s) being waited on — one, or several tied at the top. */
  windows: SubUsageWindow[];
}

/** The first whole minute strictly after `ms`. */
export function nextMinuteAfter(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000 + 60_000;
}

/**
 * "After limits reset": the window(s) at the highest usage, and the minute
 * after the *last* of them resets. Ties are deliberate — waiting for only the
 * first of two exhausted windows would fire straight into the other one.
 * Null when no window has a future reset (API-key logins, non-sub harnesses).
 */
export function limitResetTarget(usage: SubUsage | null, now = Date.now()): LimitResetTarget | null {
  const live = (usage?.windows ?? []).filter((w) => {
    const t = w.resetsAt ? new Date(w.resetsAt).getTime() : NaN;
    return Number.isFinite(t) && t > now;
  });
  if (!live.length) return null;
  const top = Math.max(...live.map((w) => Math.round(w.pct)));
  const windows = live.filter((w) => Math.round(w.pct) === top);
  const at = nextMinuteAfter(Math.max(...windows.map((w) => new Date(w.resetsAt!).getTime())));
  return { at, windows };
}
