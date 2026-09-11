'use client';
import { useEffect, useRef, useState } from 'react';
import { EffortBars, EffortOptions } from '../primitives';
import { Sheet } from '../Modal';
import { useUiHost } from '../host';
import { HARNESS_MODELS, effortLevelsFor, type EffectiveModels, type HarnessId } from '../models';

/**
 * Effort chip + ladder picker (web-desktop-parity spec §7.3). Hidden by the
 * caller when the (harness, model) exposes no effort ladder.
 */
export function EffortChip({
  harness,
  model,
  value,
  models,
  onChange,
}: {
  harness: HarnessId;
  model: string;
  value: string;
  models?: EffectiveModels;
  onChange: (effortId: string) => void;
}) {
  const { isTouch } = useUiHost();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || isTouch) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open, isTouch]);

  const levels = effortLevelsFor(harness, model, models ?? HARNESS_MODELS);
  if (levels.length === 0) return null;
  const current = levels.find((l) => l.id === value) ?? levels[0];

  const body = (
    <EffortOptions
      levels={levels}
      currentId={value}
      defaultId=""
      onPick={(id) => {
        setOpen(false);
        onChange(id);
      }}
    />
  );

  return (
    <div ref={ref} className="relative">
      <button className="btn btn-ghost h-6 gap-1 px-1.5 text-xs" onClick={() => setOpen(true)}>
        <EffortBars level={(current?.bars ?? 3) as 1 | 2 | 3 | 4 | 5} />
        {current?.label}
      </button>
      {isTouch ? (
        <Sheet title="Reasoning effort" open={open} onClose={() => setOpen(false)}>
          {body}
        </Sheet>
      ) : (
        open && <div className="glass absolute bottom-full left-0 z-40 mb-1 w-56 overflow-y-auto py-1">{body}</div>
      )}
    </div>
  );
}
