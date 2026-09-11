'use client';
import type { ContextUsage } from '../../types';

/**
 * The 17px context-occupancy donut with a hover breakdown, shared by the desktop
 * composer and Maestro Web (web-desktop-parity spec §2.5, §7.1). Moved verbatim
 * from the renderer's Composer.
 */
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const fmtWindow = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}k`);

export function ContextRing({ tokens, usage, window }: { tokens: number; usage?: ContextUsage; window: number }) {
  const pct = Math.min(0.97, tokens / window);
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <span className="group relative flex h-7 w-6 items-center justify-center">
      <svg width="17" height="17" viewBox="0 0 18 18" className="-rotate-90">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border)" strokeWidth="2.4" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke={pct > 0.8 ? 'var(--warn)' : 'var(--muted)'}
          strokeWidth="2.4"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          strokeLinecap="round"
        />
      </svg>
      {/* hover details card */}
      <span className="glass pointer-events-none absolute bottom-full right-0 z-40 mb-2 hidden w-60 p-3 text-left group-hover:block">
        {tokens > 0 ? (
          <>
            <span className="flex items-baseline justify-between text-xs">
              <span className="font-semibold">Context used</span>
              <span className="text-muted">
                {fmtK(tokens)} / {fmtWindow(window)} · {Math.round(pct * 100)}%
              </span>
            </span>
            <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-border">
              <span
                className="block h-full rounded-full"
                style={{ width: `${pct * 100}%`, background: pct > 0.8 ? 'var(--warn)' : 'var(--accent)' }}
              />
            </span>
            {usage && (
              <span className="mt-2 block space-y-0.5">
                {(
                  [
                    ['Fresh input', usage.input],
                    ['Cache read', usage.cacheRead],
                    ['Cache write', usage.cacheCreation],
                    ['Output (latest call)', usage.output],
                  ] as const
                ).map(([label, n]) => (
                  <span key={label} className="flex justify-between text-2xs text-muted">
                    <span>{label}</span>
                    <span className="font-mono">{fmtK(n)}</span>
                  </span>
                ))}
              </span>
            )}
            <span className="mt-1.5 block text-2xs text-faint">
              Measured at the agent’s latest API call — ticks live while it works.
            </span>
          </>
        ) : (
          <span className="text-xs text-muted">Context usage — updates after the first turn of this chat.</span>
        )}
      </span>
    </span>
  );
}
