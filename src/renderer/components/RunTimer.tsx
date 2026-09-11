import { useEffect, useState } from 'react';
import clsx from 'clsx';

// Classic 10-frame braille spinner — cycles ~10×/s alongside the timer tick.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Elapsed milliseconds as a compact "8m, 4.4s" / "4.4s" / "1h, 8m" string. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h, ${m}m`;
  if (m > 0) return `${m}m, ${s.toFixed(1)}s`;
  return `${s.toFixed(1)}s`;
}

/**
 * Live "running" indicator for a run script: an animated braille spinner plus
 * the elapsed time since `startedAt`, ticking ~10×/s so the tenths update
 * smoothly. Deriving the frame from the wall clock keeps every instance in
 * sync. Falls back to a bare spinner when the start time is unknown.
 */
export function RunTimer({ startedAt, className }: { startedAt: number | null; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  const frame = FRAMES[Math.floor(now / 100) % FRAMES.length];
  return (
    <span
      className={clsx('shrink-0 font-mono text-2xs tabular-nums text-muted', className)}
      title={startedAt != null ? 'Running' : undefined}
    >
      <span className="text-accent">{frame}</span>
      {startedAt != null && ` ${formatElapsed(now - startedAt)}`}
    </span>
  );
}

/**
 * A bare live elapsed-time label — no spinner, ticking ~10×/s so the tenths
 * update smoothly. Pairs with a separate loading animation (e.g. the chat
 * spinner) to show how long the current work has been running.
 */
export function ElapsedTime({ startedAt, className }: { startedAt: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  return (
    <span className={clsx('shrink-0 font-mono text-2xs tabular-nums text-faint', className)}>
      {formatElapsed(now - startedAt)}
    </span>
  );
}
