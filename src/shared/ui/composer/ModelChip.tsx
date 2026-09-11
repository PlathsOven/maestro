'use client';
import { useEffect, useRef, useState } from 'react';
import { Asterisk } from 'lucide-react';
import { PickerOption } from '../primitives';
import { Sheet } from '../Modal';
import { useUiHost } from '../host';
import { HARNESS_MODELS, HARNESS_DISPLAY, type EffectiveModels, type HarnessId } from '../models';

/**
 * Model chip + grouped picker (web-desktop-parity spec §7.3). Desktop-style glass
 * dropdown on a fine pointer, bottom Sheet on touch. `models` is the effective
 * per-harness map (desktop passes Codex's live catalog; the web the static list).
 */
export function ModelChip({
  harness,
  value,
  models,
  onChange,
  disabledReason,
}: {
  harness: HarnessId;
  value: string;
  models?: EffectiveModels;
  onChange: (modelId: string) => void;
  disabledReason?: string;
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

  const map = models ?? HARNESS_MODELS;
  const label = map[harness]?.find((m) => m.id === value)?.label ?? 'Default';

  const body = (
    <>
      {disabledReason && <div className="px-3 pb-1 pt-2 text-2xs text-faint">{disabledReason}</div>}
      {(Object.keys(map) as HarnessId[]).map((h) => {
        const opts = (map[h] ?? []).filter((m) => m.id);
        if (opts.length === 0) return null;
        return (
          <div key={h}>
            <div className="px-3 pt-2 text-2xs font-semibold uppercase tracking-wide text-muted">{HARNESS_DISPLAY[h]}</div>
            {opts.map((m) => (
              <PickerOption
                key={m.id}
                label={m.label}
                selected={h === harness && m.id === value}
                isDefault={false}
                showStar={false}
                disabled={!!disabledReason}
                onSelect={() => {
                  setOpen(false);
                  onChange(m.id);
                }}
                onSetDefault={() => {}}
              />
            ))}
          </div>
        );
      })}
    </>
  );

  return (
    <div ref={ref} className="relative">
      <button className="btn btn-ghost h-6 gap-1 px-1.5 text-xs" onClick={() => setOpen(true)}>
        <Asterisk size={13} className="text-accent" /> {label || 'Default'}
      </button>
      {isTouch ? (
        <Sheet title="Model" open={open} onClose={() => setOpen(false)}>
          {body}
        </Sheet>
      ) : (
        open && <div className="glass absolute bottom-full left-0 z-40 mb-1 max-h-80 w-64 overflow-y-auto py-1">{body}</div>
      )}
    </div>
  );
}
