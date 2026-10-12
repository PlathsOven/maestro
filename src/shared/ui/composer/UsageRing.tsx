'use client';
import type { SubUsage } from '../../types';
import { Donut } from './ContextRing';

/**
 * The subscription-limit usage vocabulary (Claude session/weekly windows, etc.),
 * shared by the desktop composer and Maestro Web (web-desktop-parity §7.1). One
 * home for the color thresholds and the per-window bars, so the two surfaces can't
 * drift — the desktop's interactive ring/popover import `usageColor` + `UsageBars`
 * from here, and the web renders the read-only `UsageRing` below.
 */

/** Provider severity → color; falls back to percent thresholds. The provider
 *  knows things thresholds don't (e.g. a window flagged critical before 95%). */
export function usageColor(w: { pct: number; severity?: string }, normal: string): string {
  if (w.severity === 'critical') return 'var(--err)';
  if (w.severity && /warn|elevat|high/i.test(w.severity)) return 'var(--warn)';
  return w.pct > 95 ? 'var(--err)' : w.pct > 80 ? 'var(--warn)' : normal;
}

/** How far off `ts` is, coarsely: "45m", "1h", "3h 12m", "2d 4h". '' once past.
 *  Rounds to whole minutes FIRST, so an instant an eyelash under the hour reads
 *  "1h" rather than "60m". */
export const fmtDelta = (ts: number): string => {
  const ms = ts - Date.now();
  if (!isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return '<1m'; // about to fire — "0m" reads like it's stuck
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

const fmtReset = (iso?: string): string => {
  if (!iso) return '';
  const d = fmtDelta(new Date(iso).getTime());
  return d ? `resets in ${d}` : 'resets soon';
};

/** The per-window bars for one login's usage — a labelled bar per rate-limit
 *  window with its percent and reset/note subtext. */
export function UsageBars({ usage }: { usage: SubUsage | null }) {
  if (!usage || usage.windows.length === 0)
    return <span className="block text-2xs text-faint">No usage data</span>;
  return (
    <span className="block space-y-2">
      {usage.windows.map((w) => {
        const sub = [w.resetsAt ? fmtReset(w.resetsAt) : '', w.note ?? ''].filter(Boolean).join(' · ');
        return (
          <span key={w.id} className="block">
            <span className="flex justify-between text-2xs text-muted">
              <span>{w.label}</span>
              <span className="font-mono">{Math.round(w.pct)}%</span>
            </span>
            <span className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-border">
              <span
                className="block h-full rounded-full"
                style={{ width: `${Math.min(100, w.pct)}%`, background: usageColor(w, 'var(--accent)') }}
              />
            </span>
            {sub && <span className="mt-0.5 block text-2xs text-faint">{sub}</span>}
          </span>
        );
      })}
      {usage.asOf && <span className="block text-2xs text-faint">Updated {fmtAgo(usage.asOf)}</span>}
    </span>
  );
}

/** Age of a re-served reading: "3m ago", "2h ago". */
const fmtAgo = (ts: number): string => {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  return mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
};

/**
 * The subscription-limit donut for Maestro Web: the 17px ring tracks the tightest
 * (max-pct) window; hovering shows the per-window breakdown. Renders nothing when
 * there is no usage data (API-key logins, non-subscription harnesses), so most
 * users never see it. Read-only + pure-CSS hover, like ContextRing — the desktop
 * keeps its own richer ring with a login-switching popover (which needs IPC).
 */
export function UsageRing({ usage }: { usage: SubUsage | null }) {
  if (!usage || usage.windows.length === 0) return null;
  const top = usage.windows.reduce((a, b) => (b.pct > a.pct ? b : a));
  const pct = Math.min(1, top.pct / 100);
  const color = usageColor(top, 'var(--muted)');
  return (
    <span className="group relative flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-accent-soft" aria-label="Plan usage">
      <Donut pct={pct} color={color} />
      {/* hover breakdown card */}
      <span className="glass pointer-events-none absolute bottom-full right-0 z-40 mb-2 hidden w-60 p-3 text-left group-hover:block">
        <span className="mb-2 flex items-baseline justify-between text-xs">
          <span className="font-medium">Plan usage</span>
          {usage.plan && <span className="text-muted">{usage.plan.toUpperCase()}</span>}
        </span>
        <UsageBars usage={usage} />
      </span>
    </span>
  );
}
