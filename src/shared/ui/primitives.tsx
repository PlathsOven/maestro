'use client';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { GLASS_CONTROL, LiquidGlass } from './LiquidGlass';
import { StainedDot, type GlassTone } from './StainedGlass';
import { Book, Check, ChevronRight, Circle, Star } from 'lucide-react';
import type { EffortLevel, WorkspaceStatus } from '../types';
import { INDICATOR_LABEL, INDICATOR_ORDER, type IndicatorStatus, type StatusCounts } from './status';

/**
 * Presentational primitives shared by the Electron renderer and Maestro Web
 * (web-desktop-parity spec §2.5). Everything here is prop-driven — no store, no
 * IPC, no host APIs — so both apps render pixel-for-pixel the same chrome.
 */

const WORKSPACE_TONE: Partial<Record<WorkspaceStatus, GlassTone>> = {
  running: 'running',
  'setting-up': 'running',
  idle: 'idle',
  'needs-attention': 'waiting',
  reviewing: 'review',
};

/** A workspace's 8px status dot, in stained glass; archived is a hollow ring. */
export function StatusDot({ status, pulse = true }: { status: WorkspaceStatus; pulse?: boolean }) {
  const tone = WORKSPACE_TONE[status];
  if (!tone) return <span className={clsx('dot', `dot-${status}`)} title={status} />;
  return <StainedDot tone={tone} size={8} ripple={pulse && tone === 'running'} title={status} />;
}

/**
 * One status dot of the unified indicator system (blue running / green unread /
 * yellow waiting / purple merged) in stained glass: the backdrop seen through
 * the status colour. Running dots emit a stained-glass ripple. When it
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
      className="flex shrink-0"
      style={{ fontSize: Math.max(7, Math.round(size * 0.62)) }}
    >
      <StainedDot tone={status} size={size} ripple={status === 'running'}>
        {count > 1 ? (count > 9 ? '9+' : count) : ''}
      </StainedDot>
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

/**
 * The loading indicator: liquid droplets chasing round a glass track. Three
 * drops share one orbit on different easing curves, so they stretch apart and
 * merge back (a gooey metaball threshold) twice a turn, while the whole chase
 * slowly drifts; a specular pass lights them like beads of glass. Plain SVG —
 * no backdrop filter — so it renders everywhere, and it takes `currentColor`
 * like the icon it replaced (size it with `size` or h-/w- classes).
 */
export function Spinner({ className, size = 14 }: { className?: string; size?: number }) {
  const id = `lq-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="status"
      aria-label="Loading"
      className={clsx('shrink-0 text-muted', className)}
    >
      <defs>
        <filter id={id} x="-25%" y="-25%" width="150%" height="150%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.1" result="soft" />
          <feColorMatrix in="soft" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" result="goo" />
          <feGaussianBlur in="goo" stdDeviation="0.8" result="height" />
          <feSpecularLighting in="height" surfaceScale="2.2" specularConstant="1.2" specularExponent="24" lightingColor="#fff" result="spec">
            <fePointLight x="5" y="-3" z="16" />
          </feSpecularLighting>
          <feComposite in="spec" in2="goo" operator="in" result="glint" />
          <feComposite in="glint" in2="goo" operator="arithmetic" k2="0.8" k3="1" />
        </filter>
      </defs>
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.6" />
      <g filter={`url(#${id})`} fill="currentColor">
        <g className="lq-drift">
          <circle className="lq-drop lq-drop-1" cx="12" cy="4" r="3.2" />
          <circle className="lq-drop lq-drop-2" cx="12" cy="4" r="2.4" />
          <circle className="lq-drop lq-drop-3" cx="12" cy="4" r="1.7" />
        </g>
      </g>
    </svg>
  );
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

/**
 * Segmented control, after the reference liquid-glass nav bar
 * (mkj0kjay/vue-web-liquid-glass): a glass track with a bright glass thumb.
 * When the selection moves, the thumb turns into a clear lens that swells, rides
 * over the labels (they refract through it) and squashes/stretches with its
 * speed on a spring, then settles back to a solid pill. The thumb can also be
 * dragged, with elastic edges, onto another option. Reduced motion just snaps.
 * `size="md"` is the roomier variant for primary view switches.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'sm',
  className,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const thumbEl = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const target = useRef<{ x: number; w: number } | null>(null);
  // Physics state, stepped per frame outside React.
  const sim = useRef({ x: 0, w: 0, sx: 1, sy: 1, lens: 0, raf: 0, placed: false });
  const drag = useRef<{ id: number; x0: number; thumb0: number; moved: boolean } | null>(null);
  const hideLens = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [lens, setLens] = useState(false);
  const lensRef = useRef(false);
  const keys = options.map((o) => o.value).join('|');
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const paint = () => {
    const el = thumbEl.current;
    if (!el) return;
    const s = sim.current;
    el.style.visibility = target.current ? '' : 'hidden';
    el.style.width = `${s.w}px`;
    // The lens is wider than it is tall, as in the reference (1.3 x 1.1).
    el.style.transform = `translateX(${s.x}px) scale(${s.sx * (1 + 0.22 * s.lens)}, ${s.sy * (1 + 0.12 * s.lens)})`;
  };
  // Squash & stretch toward a speed-driven target, preserving area.
  const wobble = (speed: number, gain: number) => {
    const s = sim.current;
    const stretch = 1 + Math.min(speed * gain, 0.35);
    s.sx += (stretch - s.sx) * 0.25;
    s.sy += (1 / stretch - s.sy) * 0.25;
  };

  const step = () => {
    const s = sim.current;
    const t = target.current;
    s.raf = 0;
    if (!t) return;
    const dragging = !!drag.current?.moved;
    const v = dragging ? 0 : (t.x - s.x) * 0.3;
    s.x += v;
    if (!dragging) s.w += (t.w - s.w) * 0.3;
    wobble(Math.abs(v), 0.025);
    const lensTo = lensRef.current ? 1 : 0;
    s.lens += (lensTo - s.lens) * 0.28;
    const settled =
      !dragging &&
      Math.abs(t.x - s.x) < 0.1 &&
      Math.abs(t.w - s.w) < 0.1 &&
      Math.abs(s.sx - 1) < 0.005 &&
      Math.abs(s.lens - lensTo) < 0.01;
    if (settled) Object.assign(s, { x: t.x, w: t.w, sx: 1, sy: 1, lens: lensTo });
    paint();
    if (!settled) s.raf = requestAnimationFrame(step);
  };
  const kick = () => {
    if (!sim.current.raf) sim.current.raf = requestAnimationFrame(step);
  };
  const setLensOn = (on: boolean) => {
    lensRef.current = on;
    setLens(on);
    kick();
  };
  // Glass while the thumb travels, back to a solid pill 280ms after the last
  // input (the reference's hold).
  const pulseLens = () => {
    if (reduced()) return;
    clearTimeout(hideLens.current);
    setLensOn(true);
    hideLens.current = setTimeout(() => !drag.current?.moved && setLensOn(false), 280);
  };

  useLayoutEffect(() => {
    const measure = () => {
      const b = buttons.current.get(value);
      target.current = b ? { x: b.offsetLeft, w: b.offsetWidth } : null;
      const s = sim.current;
      if (b && (!s.placed || reduced())) {
        // First paint (or reduced motion): place without travelling.
        Object.assign(s, { x: b.offsetLeft, w: b.offsetWidth, placed: true });
      }
      paint();
      kick();
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (track.current) ro.observe(track.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, keys]);

  useEffect(
    () => () => {
      cancelAnimationFrame(sim.current.raf);
      clearTimeout(hideLens.current);
    },
    []
  );

  // Drag: press on the selected option and move.
  const onPointerDown = (e: React.PointerEvent) => {
    const hit = (e.target as HTMLElement).closest('button');
    if (e.button !== 0 || reduced() || !hit || hit !== buttons.current.get(value)) return;
    drag.current = { id: e.pointerId, x0: e.clientX, thumb0: sim.current.x, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !track.current) return;
    const dx = e.clientX - d.x0;
    if (!d.moved) {
      if (Math.abs(dx) < 4) return;
      d.moved = true;
      track.current.setPointerCapture(e.pointerId);
      clearTimeout(hideLens.current);
      setLensOn(true);
    }
    const s = sim.current;
    const max = track.current.offsetWidth - s.w;
    let x = d.thumb0 + dx;
    // Elastic edges: a third of the overshoot (the reference's damping).
    if (x < 0) x /= 3;
    if (x > max) x = max + (x - max) / 3;
    wobble(Math.abs(x - s.x), 0.05);
    s.x = x;
    paint();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    // Drop on the option nearest the thumb's centre.
    const centre = sim.current.x + sim.current.w / 2;
    const dist = (o: T) => {
      const b = buttons.current.get(o);
      return b ? Math.abs(b.offsetLeft + b.offsetWidth / 2 - centre) : Infinity;
    };
    const best = options.reduce((a, o) => (dist(o.value) < dist(a) ? o.value : a), value);
    if (best !== value) onChange(best);
    pulseLens();
  };

  return (
    <LiquidGlass
      radius={999}
      {...GLASS_CONTROL}
      tint="clear"
      className={clsx('seg lg-float inline-flex shrink-0 p-[3px]', lens && 'seg-lens', className)}
      style={{ background: 'var(--accent-soft)' }}
    >
      <div
        ref={track}
        className="relative inline-flex touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <LiquidGlass
          ref={thumbEl}
          radius={999}
          bezel={10}
          thickness={110}
          refractiveIndex={1.5}
          strength={0.45}
          blur={0}
          specularOpacity={0.6}
          specularSaturation={10}
          // A solid bright pill at rest; a clear, click-through lens above the
          // labels while it moves.
          tint={lens ? 'clear' : 'strong'}
          className={clsx('seg-thumb absolute inset-y-0 left-0', lens ? 'pointer-events-none z-20' : 'z-0')}
          style={{ visibility: 'hidden' }}
        />
        {options.map((o) => (
          <button
            key={o.value}
            ref={(el) => {
              if (el) buttons.current.set(o.value, el);
              else buttons.current.delete(o.value);
            }}
            title={o.title}
            aria-pressed={o.value === value}
            onClick={() => {
              if (o.value === value) return;
              pulseLens();
              onChange(o.value);
            }}
            className={clsx(
              'relative z-10 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors duration-200',
              size === 'md' ? 'h-7 px-3 text-[12.5px]' : 'h-6 px-2.5 text-xs',
              o.value === value ? 'text-fg' : 'text-muted hover:text-fg'
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </LiquidGlass>
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
    <div className={clsx('group mx-1 flex items-center rounded-lg', disabled ? 'opacity-45' : 'hover:bg-accent-soft')}>
      <button
        className="tap flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-3 pr-1 text-left text-body disabled:cursor-default"
        disabled={disabled}
        onClick={onSelect}
      >
        <span className="w-3.5 shrink-0">{selected && <Check size={12} className="text-fg" />}</span>
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {showStar && !disabled && (
        <button
          className={clsx(
            'mr-1.5 shrink-0 rounded p-1 transition-opacity',
            isDefault
              ? 'text-fg opacity-100'
              : // No hover on touch: keep the star faintly visible so it's tappable.
                'text-faint opacity-0 hover:text-fg group-hover:opacity-100 [@media(hover:none)]:opacity-60'
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
      {icon && <div className="mb-1 text-faint">{icon}</div>}
      <div className="text-[15px] font-semibold tracking-tight">{title}</div>
      {body && <div className="max-w-sm text-xs leading-relaxed text-muted">{body}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded-md border bg-raised px-1 text-2xs font-medium text-muted">
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
        checked ? 'bg-accent' : 'bg-fg/15'
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
        'mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-lg text-left hover:bg-accent-soft',
        big ? 'px-3 py-2.5 text-sm' : 'px-2.5 py-1.5 text-body',
        danger ? 'text-err' : ''
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function MenuDivider() {
  return <div className="mx-2.5 my-1 border-t" />;
}

/** The little count pill used on Sidebar/RightPanel tabs and section headers. */
export function CountBadge({ count, className }: { count: number; className?: string }) {
  return <span className={clsx('rounded-full bg-accent-soft px-1.5 text-2xs font-medium text-muted', className)}>{count}</span>;
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

/** Disclosure chevron: points right when closed and rotates down when open
 *  (theme.css `.chev`), instead of swapping between two icons. */
export function Chevron({ open, size = 12, className }: { open: boolean; size?: number; className?: string }) {
  return <ChevronRight size={size} data-open={open} className={clsx('chev shrink-0', className)} />;
}
