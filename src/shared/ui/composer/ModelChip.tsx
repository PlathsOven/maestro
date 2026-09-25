'use client';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { HarnessLogo } from '../brandIcons';
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
  defaults,
  onSetDefault,
}: {
  harness: HarnessId;
  value: string;
  models?: EffectiveModels;
  onChange: (modelId: string) => void;
  disabledReason?: string;
  /** Per-harness default model ids. With `onSetDefault`, each row gets the
   *  desktop's star to pin it as the default for new chats. */
  defaults?: Partial<Record<HarnessId, string>>;
  onSetDefault?: (harness: HarnessId, modelId: string) => void;
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
            <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-xs font-medium text-faint">
              <HarnessLogo harness={h} size={12} />
              {HARNESS_DISPLAY[h]}
            </div>
            {opts.map((m) => (
              <PickerOption
                key={m.id}
                label={m.label}
                selected={h === harness && m.id === value}
                isDefault={!!onSetDefault && defaults?.[h] === m.id}
                showStar={!!onSetDefault}
                disabled={!!disabledReason}
                onSelect={() => {
                  setOpen(false);
                  onChange(m.id);
                }}
                onSetDefault={() => {
                  // "Set as default and select", like the desktop picker.
                  onSetDefault?.(h, m.id);
                  setOpen(false);
                  onChange(m.id);
                }}
              />
            ))}
          </div>
        );
      })}
    </>
  );

  return (
    <div ref={ref} className="relative">
      <button className={clsx('btn btn-ghost h-7 gap-1.5 px-2.5 text-xs text-muted hover:text-fg', open && 'bg-accent-soft text-fg')} onClick={() => setOpen(true)}>
        <HarnessLogo harness={harness} size={13} /> {label || 'Default'}
      </button>
      {isTouch ? (
        <Sheet title="Model" open={open} onClose={() => setOpen(false)}>
          {body}
        </Sheet>
      ) : (
        open && <div data-motion="pop-up" className="glass absolute bottom-full left-0 z-40 mb-2 max-h-80 w-64 overflow-y-auto py-1">{body}</div>
      )}
    </div>
  );
}
