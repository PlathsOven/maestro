import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { formatElapsed } from '../../shared/ui/transcript';

// Classic 10-frame braille spinner — cycles ~10×/s alongside the timer tick.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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
