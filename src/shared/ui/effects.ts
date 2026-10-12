'use client';
import { useSyncExternalStore } from 'react';
import type { EffectsMode, GpuHint } from '../types';

/**
 * Visual-effects level, shared by the desktop renderer and Maestro Web.
 *
 * The liquid-glass look is GPU work: backdrop blurs re-sample whatever sits
 * behind a surface every frame something under or inside it changes, and the
 * refracting glass adds an SVG displacement-map filter chain on top. A modern
 * GPU shrugs that off; an older integrated one (common on Windows laptops) or a
 * software-composited window stutters on every scroll and streamed token while
 * CPU and RAM look idle, because the bottleneck is the compositor.
 *
 * `reduced` rides on `<html data-fx="reduced">`: theme.css swaps every blur for
 * an opaque fill, and <LiquidGlass>/<StainedGlass> stop building their SVG
 * filters, and <Spinner> spins as one composited icon instead of repainting a
 * lighting filter every frame. Layout and palette stay the same.
 */

export type { EffectsMode, GpuHint };
export type EffectsLevel = 'full' | 'reduced';

export function isEffectsMode(v: unknown): v is EffectsMode {
  return v === 'auto' || v === 'full' || v === 'reduced';
}

/** Why `auto` picks reduced on this machine, or null when it keeps full effects. */
export function lowEndReason(gpu?: GpuHint | null): string | null {
  if (typeof navigator === 'undefined') return null;
  if (gpu && !gpu.hardware) return 'graphics acceleration is off';
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches) {
    return 'your system asks for reduced transparency';
  }
  const cores = navigator.hardwareConcurrency || 0;
  // Chromium buckets this to a power of two and caps it at 8 (GB).
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
  if (cores > 0 && cores <= 4) return `${cores}-thread CPU`;
  if (memory > 0 && memory <= 4) return 'under 8 GB of memory';
  // Windows composites backdrop blurs noticeably slower than macOS, and older
  // Intel integrated GPUs are where the glass visibly drags.
  const windows = /Windows/.test(navigator.userAgent);
  if (windows && gpu?.intelOnly && cores > 0 && cores <= 8) return 'integrated graphics';
  return null;
}

export function resolveEffects(mode: EffectsMode, gpu?: GpuHint | null): EffectsLevel {
  if (mode !== 'auto') return mode;
  return lowEndReason(gpu) ? 'reduced' : 'full';
}

// ---------------------------------------------------------------- store

const listeners = new Set<() => void>();

const read = (): EffectsLevel =>
  typeof document !== 'undefined' && document.documentElement.dataset.fx === 'reduced' ? 'reduced' : 'full';

/** Stamp the level on <html> and tell the glass components. */
export function applyEffects(level: EffectsLevel): void {
  if (typeof document === 'undefined') return;
  if (read() === level) return;
  if (level === 'reduced') document.documentElement.dataset.fx = 'reduced';
  else delete document.documentElement.dataset.fx;
  listeners.forEach((l) => l());
}

export function subscribeEffects(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** True while full effects are on. False on the server, so a hydrating page
 *  starts without filters and adds them after mount. */
export function useFullEffects(): boolean {
  return useSyncExternalStore(
    subscribeEffects,
    () => read() === 'full',
    () => false
  );
}
