import { app } from 'electron';
import type { GpuHint } from '../../shared/types';

/**
 * What Chromium reports about the GPU, for the renderer's `auto` visual-effects
 * level (src/shared/ui/effects.ts). Asked on `app:init`, once the renderer is up:
 * before the GPU process starts (e.g. at `app.whenReady`) Chromium reports every
 * feature as `disabled_software`, even on a healthy GPU.
 */
export async function gpuHint(): Promise<GpuHint> {
  // 'enabled', 'enabled_on', … vs 'disabled_software', 'unavailable_software', …
  const hardware = String(app.getGPUFeatureStatus().gpu_compositing).startsWith('enabled');
  // Software compositing settles it — and getGPUInfo may never resolve then.
  if (!hardware) return { hardware, intelOnly: false };
  const info = (await Promise.race([
    app.getGPUInfo('basic').catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
  ])) as { gpuDevice?: { vendorId?: number }[] } | null;
  const vendors = (info?.gpuDevice ?? []).map((d) => d.vendorId);
  return { hardware, intelOnly: vendors.length > 0 && vendors.every((v) => v === 0x8086) };
}
