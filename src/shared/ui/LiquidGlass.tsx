'use client';
import React, { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { computeGlassMaps, imageDataUrl, supportsRefraction } from './liquidGlassMaps';

type Maps = { displacement: string; specular: string; scale: number };

/** Floating chrome controls (toolbar button groups, tab tracks, capsules): the
 *  reference nav-bar track recipe scaled to toolbar size. Thick, low-index
 *  glass, barely frosted, with a bright saturated rim. */
export const GLASS_CONTROL = {
  bezel: 12,
  thickness: 130,
  refractiveIndex: 1.32,
  strength: 0.4,
  blur: 1.5,
  specularOpacity: 0.8,
  specularSaturation: 12,
} as const;

/** Text fields that float over content (the composer): the reference search
 *  bar recipe, a little more frosted so the typed text stays crisp. */
export const GLASS_FIELD = {
  bezel: 16,
  thickness: 90,
  refractiveIndex: 1.4,
  strength: 0.45,
  blur: 2.5,
  specularOpacity: 0.5,
  specularSaturation: 8,
} as const;

// Maps depend only on size and shape, so identical surfaces share one render.
const cache = new Map<string, Maps>();

export type LiquidGlassProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> & {
  children?: React.ReactNode;
  /** Corner radius in px. Use a large number (999) for pills. */
  radius: number;
  /** How far in from the edge the glass curves, in px. */
  bezel?: number;
  /** Optical thickness: higher bends the edges more. */
  thickness?: number;
  refractiveIndex?: number;
  /** 0–1: how much of the computed bend to apply. */
  strength?: number;
  /** Frosting behind the glass, in px. */
  blur?: number;
  /** Colour boost for what's seen through the body of the glass. */
  saturation?: number;
  specularOpacity?: number;
  /** Colour boost for the backdrop seen through the rim only: this is the
   *  vivid glint along the edge that makes the surface read as liquid. */
  specularSaturation?: number;
  /** Surface tint drawn over the refracted backdrop: `clear` for small chrome
   *  (tab tracks), `light` for floating controls, `strong`/`panel` for surfaces
   *  that carry body text (menus, modals). */
  tint?: 'clear' | 'light' | 'strong' | 'panel';
};

/**
 * Apple-style liquid glass (port of the technique in mkj0kjay/vue-web-liquid-glass,
 * MIT): the backdrop is refracted at the rim through an SVG displacement map and
 * frosted, with a specular highlight on the edge. Chromium (Electron, desktop
 * Chrome) gets the real refraction; everything else falls back to the frosted
 * blur in theme.css (`.lg-backdrop`), so the surface always reads as glass.
 *
 * Purely a skin: it sets `isolation`, a border radius and — unless the caller
 * positions it with `absolute`/`fixed`/`sticky` in className — `relative`.
 * Sizing, padding and positioning otherwise stay with the caller.
 */
export const LiquidGlass = forwardRef<HTMLDivElement, LiquidGlassProps>(function LiquidGlass(
  {
    children,
    className,
    style,
    radius,
    bezel = 16,
    thickness = 90,
    refractiveIndex = 1.45,
    strength = 0.55,
    blur = 1,
    saturation = 1.1,
    specularOpacity = 0.45,
    specularSaturation = 6,
    tint = 'light',
    ...rest
  },
  forwarded
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const filterId = `lg-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [maps, setMaps] = useState<Maps | null>(null);
  const [refract, setRefract] = useState(false);

  useEffect(() => setRefract(supportsRefraction()), []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !refract) return;
    const measure = () => {
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [refract]);

  useEffect(() => {
    if (!refract || !size || size.w < 4 || size.h < 4) return;
    // Big surfaces render at 1x so resizing stays smooth.
    const dpr = size.w * size.h > 250_000 ? 1 : Math.min(2, window.devicePixelRatio || 1);
    const key = [size.w, size.h, radius, bezel, thickness, refractiveIndex, strength, dpr].join(':');
    const hit = cache.get(key);
    if (hit) {
      setMaps(hit);
      return;
    }
    const t = setTimeout(() => {
      const m = computeGlassMaps({
        width: size.w,
        height: size.h,
        radius,
        bezelWidth: bezel,
        glassThickness: thickness,
        refractiveIndex,
        scaleRatio: strength,
        dpr,
      });
      const next = { displacement: imageDataUrl(m.displacement), specular: imageDataUrl(m.specular), scale: m.scale };
      if (cache.size > 64) cache.clear();
      cache.set(key, next);
      setMaps(next);
    }, 30);
    return () => clearTimeout(t);
  }, [refract, size, radius, bezel, thickness, refractiveIndex, strength]);

  const live = refract && maps && size;
  // Tailwind emits `.relative` after `.absolute`/`.fixed`, so adding it
  // unconditionally would silently un-position a caller's popover.
  const positioned = /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(className ?? '');
  const setRef = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (typeof forwarded === 'function') forwarded(el);
    else if (forwarded) forwarded.current = el;
  };
  return (
    <div
      ref={setRef}
      className={clsx('lg isolate', !positioned && 'relative', `lg-${tint}`, live && 'lg-live', className)}
      style={{ borderRadius: radius, ...style }}
      {...rest}
    >
      {live && (
        <svg aria-hidden width="0" height="0" className="absolute" colorInterpolationFilters="sRGB">
          <defs>
            <filter id={filterId} x="0" y="0" width={size.w} height={size.h} filterUnits="userSpaceOnUse">
              <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="blurred" />
              <feImage
                href={maps.displacement}
                x="0"
                y="0"
                width={size.w}
                height={size.h}
                preserveAspectRatio="none"
                result="map"
              />
              <feDisplacementMap
                in="blurred"
                in2="map"
                scale={maps.scale}
                xChannelSelector="R"
                yChannelSelector="G"
                result="bent"
              />
              <feColorMatrix in="bent" type="saturate" values={String(saturation)} result="body" />
              {/* The reference pipeline: the backdrop is saturated hard but only
                  shown through the specular rim (composite `in`), then the white
                  highlight is laid over it, so the edge glints in the colours of
                  whatever is behind it while the body stays true. */}
              <feColorMatrix in="bent" type="saturate" values={String(specularSaturation)} result="vivid" />
              <feImage
                href={maps.specular}
                x="0"
                y="0"
                width={size.w}
                height={size.h}
                preserveAspectRatio="none"
                result="rim"
              />
              <feComposite in="vivid" in2="rim" operator="in" result="rimColour" />
              <feBlend in="rimColour" in2="body" mode="normal" result="glinted" />
              <feComponentTransfer in="rim" result="rimFaded">
                <feFuncA type="linear" slope={specularOpacity} />
              </feComponentTransfer>
              <feBlend in="rimFaded" in2="glinted" mode="normal" />
            </filter>
          </defs>
        </svg>
      )}
      <div
        aria-hidden
        className="lg-backdrop pointer-events-none absolute inset-0 -z-10"
        style={{
          borderRadius: radius,
          backdropFilter: live ? `url(#${filterId})` : undefined,
          WebkitBackdropFilter: live ? `url(#${filterId})` : undefined,
        }}
      />
      {children}
    </div>
  );
});
