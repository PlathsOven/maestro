'use client';
import React, { forwardRef, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { computeGlassMaps, imageDataUrl, supportsRefraction } from './liquidGlassMaps';
import { subscribeTheme } from '../themes';

/**
 * Stained glass: the canonical skin for everything that carries a status colour —
 * status dots, and the status-coloured action buttons (Create PR, Merge, Archive,
 * Resolve conflicts, the sidebar merge/archive tiles).
 *
 * The backdrop is refracted through a thick bead of glass (the LiquidGlass maps)
 * and then seen *through* the status colour — its luminance is mapped onto the
 * hue — so whatever sits behind reads as if through coloured glass, with a
 * specular glint on the rim. Live/busy surfaces emit a ripple: a ring of the
 * same stained glass that expands and bends what it passes over. Buttons also
 * ripple once on press.
 *
 * Chromium (Electron, desktop Chrome) gets the real refraction; elsewhere (and
 * with reduced transparency) it falls back to a flat fill with a lit rim.
 * Filters are shared by size/colour/theme, so a sidebar full of dots costs a
 * handful of filters, not one each.
 */

export type GlassTone =
  | 'running'
  | 'unread'
  | 'waiting'
  | 'merged'
  | 'idle'
  | 'review'
  | 'ok'
  | 'warn'
  | 'err'
  | 'ink';

const TONE_VAR: Record<GlassTone, string> = {
  running: '--st-running',
  unread: '--st-unread',
  waiting: '--st-attention',
  merged: '--st-merged',
  idle: '--st-idle',
  review: '--st-review',
  ok: '--ok',
  warn: '--warn',
  err: '--err',
  ink: '--ink',
};

type Recipe = {
  /** Bezel as a fraction of the corner radius: tiny glass needs most of it curved. */
  bezel: number;
  /** Optical thickness per 26px of the shorter side. */
  thickness: number;
  ior: number;
  blur: number;
  specOpacity: number;
  specSaturation: number;
};
const BODY: Recipe = { bezel: 0.9, thickness: 60, ior: 1.5, blur: 0.25, specOpacity: 0.9, specSaturation: 10 };
const RING: Recipe = { bezel: 1, thickness: 160, ior: 1.7, blur: 0.3, specOpacity: 1, specSaturation: 14 };

// ---------------------------------------------------------------- theme epoch

const themeKey = () =>
  `${document.documentElement.classList.contains('dark') ? 'dark' : 'light'}|${document.documentElement.dataset.theme ?? ''}`;
/** Re-render on light/dark or colour-theme flips: the stain colour is baked
 *  into the filter, so it has to be re-read from the tokens. */
function useThemeKey(): string {
  return useSyncExternalStore(subscribeTheme, themeKey, () => 'light|');
}

function toneRgb(tone: GlassTone): [number, number, number] | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(TONE_VAR[tone]).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw)?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(raw);
  return rgb ? ([+rgb[1] / 255, +rgb[2] / 255, +rgb[3] / 255] as [number, number, number]) : null;
}

// ---------------------------------------------------------------- filter registry

let defs: SVGDefsElement | null = null;
const made = new Set<string>();

function defsHost(): SVGDefsElement {
  if (defs?.isConnected) return defs;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.style.pointerEvents = 'none';
  defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  svg.appendChild(defs);
  document.body.appendChild(svg);
  made.clear();
  return defs;
}

/** Alpha mask of the ripple band: a rounded-rect stroke hugging the edge. */
function ringMask(w: number, h: number, r: number, band: number, dpr: number): string {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.scale(dpr, dpr);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = band;
  ctx.beginPath();
  const inset = band / 2;
  ctx.roundRect(inset, inset, w - band, h - band, Math.max(0, Math.min(r, h / 2, w / 2) - inset));
  ctx.stroke();
  return c.toDataURL('image/png');
}

/** Get (building once) the shared filter for this surface; returns its id. */
function stainedFilter(
  kind: 'body' | 'ring',
  w: number,
  h: number,
  radius: number,
  rgb: [number, number, number],
  dark: boolean
): string {
  const lift = dark ? 0.78 : 0.42;
  const r = Math.min(radius, w / 2, h / 2);
  const id = `sg-${kind}-${w}x${h}-${Math.round(r * 10)}-${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}-${dark ? 'd' : 'l'}`;
  const host = defsHost();
  if (made.has(id)) return id;
  made.add(id);

  const recipe = kind === 'body' ? BODY : RING;
  const short = Math.min(w, h);
  const band = kind === 'ring' ? Math.max(1.5, Math.min(r * 0.5, 4)) : 0;
  const dpr = w * h < 2500 ? 3 : Math.min(2, window.devicePixelRatio || 1);
  const maps = computeGlassMaps({
    width: w,
    height: h,
    radius: r,
    bezelWidth: kind === 'ring' ? band : r * recipe.bezel,
    glassThickness: (recipe.thickness * short) / 26,
    refractiveIndex: recipe.ior,
    scaleRatio: 1,
    dpr,
  });
  // Luminance of the refracted backdrop, re-coloured with the tone: the stain.
  const row = (c: number) => `${0.3 * c * 0.75} ${0.59 * c * 0.75} ${0.11 * c * 0.75} 0 ${c * lift}`;
  const clip =
    kind === 'ring'
      ? `<feImage href="${ringMask(w, h, r, band, dpr)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="band"/>
         <feComposite in="lit" in2="band" operator="in"/>`
      : '';
  host.insertAdjacentHTML(
    'beforeend',
    `<filter id="${id}" x="0" y="0" width="${w}" height="${h}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="${recipe.blur}" result="blurred"/>
      <feImage href="${imageDataUrl(maps.displacement)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>
      <feDisplacementMap in="blurred" in2="map" scale="${maps.scale}" xChannelSelector="R" yChannelSelector="G" result="bent"/>
      <feColorMatrix in="bent" type="saturate" values="1.4" result="body0"/>
      <feColorMatrix in="body0" type="matrix" values="${row(rgb[0])} ${row(rgb[1])} ${row(rgb[2])} 0 0 0 1 0" result="body"/>
      <feColorMatrix in="bent" type="saturate" values="${recipe.specSaturation}" result="vivid"/>
      <feImage href="${imageDataUrl(maps.specular)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="rim"/>
      <feComposite in="vivid" in2="rim" operator="in" result="rimColour"/>
      <feBlend in="rimColour" in2="body" mode="normal" result="glinted"/>
      <feComponentTransfer in="rim" result="rimFaded"><feFuncA type="linear" slope="${recipe.specOpacity}"/></feComponentTransfer>
      <feBlend in="rimFaded" in2="glinted" mode="normal" result="lit"/>
      ${clip}
    </filter>`
  );
  return id;
}

// ---------------------------------------------------------------- component

type Size = { w: number; h: number };

export type StainedGlassProps = Omit<React.HTMLAttributes<HTMLElement>, 'children'> & {
  tone: GlassTone;
  /** Corner radius in px; defaults to a pill. */
  radius?: number;
  /** Fixed size (dots). Omit to measure the element (buttons). */
  size?: number;
  /** Emit a continuous ripple: something is live or in flight. */
  ripple?: boolean;
  /** Ripple once on press (on by default for buttons and links). */
  pressRipple?: boolean;
  as?: 'span' | 'button' | 'a';
  children?: React.ReactNode;
  // button / anchor passthroughs
  disabled?: boolean;
  type?: 'button' | 'submit';
  href?: string;
  target?: string;
  rel?: string;
};

/** How far a ripple travels past the edge, in px (circles scale further). */
const rippleGrow = (s: Size, circle: boolean) => (circle ? Math.min(s.w, s.h) * 0.75 : 8);

export const StainedGlass = forwardRef<HTMLElement, StainedGlassProps>(function StainedGlass(
  { tone, radius = 999, size, ripple = false, pressRipple, as = 'span', className, style, children, onPointerDown, ...rest },
  forwarded
) {
  const ref = useRef<HTMLElement | null>(null);
  const theme = useThemeKey();
  const dark = theme.startsWith('dark');
  const [refract, setRefract] = useState(false);
  const [measured, setMeasured] = useState<Size | null>(null);
  const [filters, setFilters] = useState<{ body: string; ring: string } | null>(null);
  const [presses, setPresses] = useState<number[]>([]);
  const sz: Size | null = size ? { w: size, h: size } : measured;

  useEffect(() => setRefract(supportsRefraction()), []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (size || !el) return;
    const measure = () => {
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      setMeasured((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);

  const w = sz?.w ?? 0;
  const h = sz?.h ?? 0;
  const pressable = pressRipple ?? (as === 'button' || as === 'a');
  // The ring filter is only built for surfaces that can ripple.
  const rings = ripple || pressable;
  useEffect(() => {
    if (!refract || w < 4 || h < 4) return setFilters(null);
    const rgb = toneRgb(tone);
    if (!rgb) return setFilters(null);
    setFilters({
      body: stainedFilter('body', w, h, radius, rgb, dark),
      ring: rings ? stainedFilter('ring', w, h, radius, rgb, dark) : '',
    });
  }, [refract, w, h, radius, tone, theme, rings]);

  const Tag = as as 'span';
  const circle = !!sz && radius >= Math.min(sz.w, sz.h) / 2 && Math.abs(sz.w - sz.h) < 1;
  const grow = sz ? rippleGrow(sz, circle) : 8;
  const ringStyle = filters?.ring ? { backdropFilter: `url(#${filters.ring})`, WebkitBackdropFilter: `url(#${filters.ring})` } : undefined;

  return (
    <Tag
      ref={(el: HTMLElement | null) => {
        ref.current = el;
        if (typeof forwarded === 'function') forwarded(el);
        else if (forwarded) forwarded.current = el;
      }}
      className={clsx('sg', tone === 'ink' && 'sg-ink', filters && 'sg-live', ripple && 'sg-busy', className)}
      style={
        {
          borderRadius: radius,
          '--sg-c': `var(${TONE_VAR[tone]})`,
          '--sg-sx': sz ? 1 + (2 * grow) / sz.w : 1.4,
          '--sg-sy': sz ? 1 + (2 * grow) / sz.h : 1.4,
          ...style,
        } as React.CSSProperties
      }
      onPointerDown={(e: React.PointerEvent<HTMLElement>) => {
        if (pressable && !rest.disabled) setPresses((p) => [...p.slice(-2), e.timeStamp]);
        onPointerDown?.(e);
      }}
      {...rest}
    >
      {ripple && <span aria-hidden className="sg-ring sg-ring-loop" style={ringStyle} />}
      {presses.map((k) => (
        <span
          key={k}
          aria-hidden
          className="sg-ring sg-ring-once"
          style={ringStyle}
          onAnimationEnd={() => setPresses((p) => p.filter((x) => x !== k))}
        />
      ))}
      <span
        aria-hidden
        className="sg-glass"
        style={filters ? { backdropFilter: `url(#${filters.body})`, WebkitBackdropFilter: `url(#${filters.body})` } : undefined}
      />
      {children}
    </Tag>
  );
});

/** A round stained-glass status dot; `ripple` while it's live. */
export function StainedDot({
  tone,
  size = 8,
  ripple = false,
  title,
  className,
  children,
}: {
  tone: GlassTone;
  size?: number;
  ripple?: boolean;
  title?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <StainedGlass
      tone={tone}
      radius={size / 2}
      size={size}
      ripple={ripple}
      title={title}
      className={clsx('sg-dot inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      {children}
    </StainedGlass>
  );
}
