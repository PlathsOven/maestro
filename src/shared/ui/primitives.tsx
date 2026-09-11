'use client';
import React, { useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Book, Check, Circle, Loader2, Star } from 'lucide-react';
import type { EffortLevel, WorkspaceStatus } from '../types';
import { INDICATOR_LABEL, INDICATOR_ORDER, type IndicatorStatus, type StatusCounts } from './status';

/**
 * Presentational primitives shared by the Electron renderer and Maestro Web
 * (web-desktop-parity spec §2.5). Everything here is prop-driven — no store, no
 * IPC, no host APIs — so both apps render pixel-for-pixel the same chrome.
 */

export function StatusDot({ status, pulse = true }: { status: WorkspaceStatus; pulse?: boolean }) {
  return (
    <span
      className={clsx('dot', `dot-${status}`, pulse && (status === 'running' || status === 'setting-up') && 'pulse')}
      title={status}
    />
  );
}

const INDICATOR_BG: Record<IndicatorStatus, string> = {
  running: 'bg-st-running',
  unread: 'bg-st-unread',
  waiting: 'bg-st-attention',
  merged: 'bg-st-merged',
};

/**
 * One status dot of the unified indicator system (blue running / green unread /
 * yellow waiting / purple merged) — a flat dot, no outline, styled like a
 * status-ping display: running dots emit an expanding ping halo. When it
 * represents several sessions or branches (`count` > 1), the count is shown
 * inside the dot.
 */
export function StatusCircle({
  status,
  count = 1,
  size = 13,
}: {
  status: IndicatorStatus;
  count?: number;
  size?: number;
}) {
  return (
    <span
      title={count > 1 ? `${INDICATOR_LABEL[status]} × ${count}` : INDICATOR_LABEL[status]}
      className="relative flex shrink-0"
      style={{ width: size, height: size }}
    >
      {status === 'running' && (
        <span className={clsx('status-ping absolute inset-0 rounded-full', INDICATOR_BG[status])} />
      )}
      <span
        className={clsx(
          'relative flex h-full w-full items-center justify-center rounded-full font-semibold leading-none text-white',
          INDICATOR_BG[status]
        )}
        style={{ fontSize: Math.max(7, Math.round(size * 0.62)) }}
      >
        {count > 1 ? (count > 9 ? '9+' : count) : ''}
      </span>
    </span>
  );
}

/**
 * The row of status dots beside a project / branch / session item: one dot per
 * state present (fixed order), separated by a hairline gap, each carrying its
 * count. Renders nothing when everything is idle — idle has no indication.
 */
export function StatusStack({
  counts,
  size = 13,
  vertical = false,
  className,
}: {
  counts: StatusCounts;
  size?: number;
  /** Stack downward instead of rightward (collapsed-rail project badges). */
  vertical?: boolean;
  className?: string;
}) {
  const present = INDICATOR_ORDER.filter((k) => counts[k] > 0);
  if (present.length === 0) return null;
  return (
    <span className={clsx('flex shrink-0 items-center gap-[3px]', vertical && 'flex-col', className)}>
      {present.map((k) => (
        <StatusCircle key={k} status={k} count={counts[k]} size={size} />
      ))}
    </span>
  );
}

/** A session's single status circle; idle renders a hollow neutral dot so
 *  list rows keep their alignment (used in hover cards and the session rail). */
export function SessionStatusDot({ status, size = 9 }: { status: IndicatorStatus | null; size?: number }) {
  if (!status) {
    return (
      <span
        title="Idle"
        className="shrink-0 rounded-full border-[1.5px] border-faint"
        style={{ width: size, height: size }}
      />
    );
  }
  return <StatusCircle status={status} size={size} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 size={14} className={clsx('spin text-muted', className)} />;
}

/**
 * A single line of text that horizontally scrolls while you hover its row, when
 * it's too long to fit — the classic "marquee": hold at the start for a beat,
 * glide to the end at a constant speed, hold at the end, then loop. Leaving the
 * row rewinds it to the start.
 *
 * Only titles that actually overflow animate; anything that fits is left static
 * (and truncated with an ellipsis as a fallback when it can't fit and motion is
 * reduced). The scroll distance is measured live, so it re-syncs when the text
 * or the container width changes. Honors `prefers-reduced-motion`.
 *
 * The hover target is the nearest ancestor Tailwind `group` (the row), falling
 * back to the title's own box, so hovering anywhere on the row starts the scroll.
 *
 * Drop-in replacement for a `truncate` span: pass the container/text classes
 * (font, colour, `flex-1`, `min-w-0`, …) via `className`; they cascade to the
 * text through inheritance.
 */
/** Seconds the text holds still at each end before scrolling / looping. */
const SCROLL_PAUSE = 1.5;
/** Scroll speed in pixels per second — keeps long titles from racing by. */
const SCROLL_SPEED = 40;

export function ScrollingTitle({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  // Static per render; drives the fallback layout without touching measurement.
  const [reduce] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useLayoutEffect(() => {
    const container = box.current;
    const el = inner.current;
    if (!container || !el || reduce) return;

    const row = container.closest<HTMLElement>('.group') ?? container;
    let anim: Animation | undefined;
    const play = () => anim?.play();
    const rewind = () => {
      if (anim) {
        anim.pause();
        anim.currentTime = 0;
      }
    };

    const sync = () => {
      anim?.cancel();
      const overflow = el.scrollWidth - container.clientWidth;
      if (overflow < 1) return;
      const p = SCROLL_PAUSE * 1000;
      const scroll = (overflow / SCROLL_SPEED) * 1000;
      const total = p * 2 + scroll;
      anim = el.animate(
        [
          { transform: 'none', offset: 0 },
          { transform: 'none', offset: p / total },
          { transform: `translateX(-${overflow}px)`, offset: (p + scroll) / total },
          { transform: `translateX(-${overflow}px)`, offset: 1 },
        ],
        { duration: total, iterations: Infinity }
      );
      // Start paused; only run while the row is hovered (resume if already is).
      if (row.matches(':hover')) anim.play();
      else anim.pause();
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(container);
    row.addEventListener('pointerenter', play);
    row.addEventListener('pointerleave', rewind);
    return () => {
      ro.disconnect();
      row.removeEventListener('pointerenter', play);
      row.removeEventListener('pointerleave', rewind);
      anim?.cancel();
    };
  }, [text, reduce]);

  return (
    <div ref={box} className={clsx('overflow-hidden', className)}>
      <span ref={inner} className={reduce ? 'block truncate' : 'inline-block whitespace-nowrap'}>
        {text}
      </span>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-ctl border bg-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-[4px] px-2 py-0.5 text-xs font-medium transition-colors',
            o.value === value ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The 5-segment glyph that visualizes a reasoning-effort level. */
export function EffortBars({ level }: { level: 1 | 2 | 3 | 4 | 5 }) {
  return (
    <span className="flex items-end gap-px" aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={clsx('w-[3px] rounded-sm', i <= level ? 'bg-current' : 'bg-current opacity-25')}
          style={{ height: 2 + i * 2 }}
        />
      ))}
    </span>
  );
}

/**
 * A row in a model/effort picker: a check for the current selection, an optional
 * leading glyph, the label, and a trailing star to pin it as the default.
 * Clicking the row selects; clicking the star sets-as-default *and* selects.
 * The star is always shown for the current default (filled) and on hover
 * otherwise; pass `showStar={false}` where pinning a default is meaningless
 * (e.g. a harness with a single model).
 */
export function PickerOption({
  label,
  icon,
  selected,
  isDefault,
  showStar = true,
  disabled,
  onSelect,
  onSetDefault,
}: {
  label: React.ReactNode;
  icon?: React.ReactNode;
  selected: boolean;
  isDefault: boolean;
  showStar?: boolean;
  /** shown but not selectable (e.g. a harness whose CLI isn't installed). */
  disabled?: boolean;
  onSelect: () => void;
  onSetDefault: () => void;
}) {
  return (
    <div className={clsx('group flex items-center', disabled ? 'opacity-45' : 'hover:bg-accent-soft')}>
      <button
        className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-3 pr-1 text-left text-body disabled:cursor-default"
        disabled={disabled}
        onClick={onSelect}
      >
        <span className="w-3.5 shrink-0">{selected && <Check size={12} className="text-accent" />}</span>
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {showStar && !disabled && (
        <button
          className={clsx(
            'mr-1.5 shrink-0 rounded p-1 transition-opacity',
            isDefault
              ? 'text-accent opacity-100'
              : 'text-faint opacity-0 hover:text-fg group-hover:opacity-100'
          )}
          title={isDefault ? 'Default — used for new chats' : 'Set as default and select'}
          onClick={(e) => {
            e.stopPropagation();
            onSetDefault();
          }}
        >
          <Star size={12} fill={isDefault ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  );
}

/** Shared reasoning-effort picker body: one pinnable PickerOption per level.
 *  `onPick(id, makeDefault)` applies the choice and the caller closes the menu. */
export function EffortOptions({
  levels,
  currentId,
  defaultId,
  onPick,
}: {
  levels: EffortLevel[];
  currentId: string;
  defaultId: string;
  onPick: (id: string, makeDefault: boolean) => void;
}) {
  return (
    <>
      {levels.map((e) => (
        <PickerOption
          key={e.id}
          label={e.label}
          icon={<EffortBars level={e.bars} />}
          selected={currentId === e.id}
          isDefault={defaultId === e.id}
          onSelect={() => onPick(e.id, false)}
          onSetDefault={() => onPick(e.id, true)}
        />
      ))}
    </>
  );
}

export function EmptyHint({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {body && <div className="max-w-sm text-xs text-muted">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded border bg-raised px-1 text-2xs font-medium text-muted">
      {children}
    </kbd>
  );
}

/** iOS-style toggle switch (18×32), used in settings rows and the New workspace
 *  sheet. */
export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-[18px] w-8 shrink-0 rounded-full transition-colors',
        checked ? 'bg-accent' : 'bg-border'
      )}
    >
      <span
        className={clsx(
          'absolute left-0 top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-[15px]' : 'translate-x-[3px]'
        )}
      />
    </button>
  );
}

/** A menu/action-sheet row. `big` is the touch-sized variant. */
export function MenuItem({
  children,
  onClick,
  danger,
  big,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  big?: boolean;
}) {
  return (
    <button
      className={clsx(
        'flex w-full items-center gap-2.5 text-left hover:bg-accent-soft',
        big ? 'px-3.5 py-2.5 text-sm' : 'px-3 py-1.5 text-body',
        danger ? 'text-err' : ''
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 border-t" />;
}

/** The little count pill used on Sidebar/RightPanel tabs and section headers. */
export function CountBadge({ count, className }: { count: number; className?: string }) {
  return <span className={clsx('rounded-full bg-border px-1.5 text-2xs text-muted', className)}>{count}</span>;
}

/** GitHub repo avatar (owner identicon) when the origin is on GitHub; book icon
 *  otherwise. `owner` is the resolved GitHub login (or null) — the desktop reads
 *  it from the projectOwners cache, the web from the relay's repoOwner. */
export function RepoIcon({ owner, active }: { owner: string | null; active: boolean }) {
  const [broken, setBroken] = useState(false);
  if (owner && !broken) {
    return (
      <img
        src={`https://avatars.githubusercontent.com/${owner}?s=32`}
        alt=""
        className="h-[15px] w-[15px] shrink-0 rounded-[3px]"
        onError={() => setBroken(true)}
      />
    );
  }
  return <Book size={13} className={clsx('shrink-0', active ? 'text-accent' : 'text-muted')} />;
}
