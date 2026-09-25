'use client';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
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
  defaultValue,
  onSetDefault,
}: {
  harness: HarnessId;
  model: string;
  value: string;
  models?: EffectiveModels;
  onChange: (effortId: string) => void;
  /** The default effort for new chats; with `onSetDefault`, the star pins it. */
  defaultValue?: string;
  onSetDefault?: (effortId: string) => void;
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
      defaultId={onSetDefault ? defaultValue ?? '' : ''}
      onPick={(id, makeDefault) => {
        setOpen(false);
        if (makeDefault) onSetDefault?.(id);
        onChange(id);
      }}
    />
  );

  return (
    <div ref={ref} className="relative">
      <button className={clsx('btn btn-ghost h-7 gap-1.5 px-2.5 text-xs text-muted hover:text-fg', open && 'bg-accent-soft text-fg')} onClick={() => setOpen(true)}>
        <EffortBars level={(current?.bars ?? 3) as 1 | 2 | 3 | 4 | 5} />
        {current?.label}
      </button>
      {isTouch ? (
        <Sheet title="Reasoning effort" open={open} onClose={() => setOpen(false)}>
          {body}
        </Sheet>
      ) : (
        open && <div data-motion="pop-up" className="glass absolute bottom-full left-0 z-40 mb-2 w-56 overflow-y-auto py-1">{body}</div>
      )}
    </div>
  );
}
