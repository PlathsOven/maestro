import {
  CONTEXT_WINDOW,
  CONTEXT_WINDOWS,
  HARNESS_DISPLAY,
  HARNESS_MODELS,
  HARNESS_PLAN_MODE,
  effortLevelsForModel,
  resolveDefaultModel,
  type EffortLevel,
  type HarnessId,
  type ModelOption,
} from '../types';

/**
 * Model / effort / harness data for the shared composer chips (web-desktop-parity
 * spec §7.3). The static tables (HARNESS_MODELS, per-model effort ladders, harness
 * labels, plan-mode map) live in src/shared/types.ts; this module re-exports them
 * and the pure helpers so the composer under src/shared/ui/composer imports one
 * seam and never touches IPC. The desktop passes the live model map (Codex's
 * catalog, resolved over IPC); the web passes the static HARNESS_MODELS.
 */
export {
  CONTEXT_WINDOW,
  CONTEXT_WINDOWS,
  HARNESS_DISPLAY,
  HARNESS_MODELS,
  HARNESS_PLAN_MODE,
  effortLevelsForModel,
  resolveDefaultModel,
};
export type { EffortLevel, HarnessId, ModelOption };

/** The effective per-harness model map for pickers — either the live map the
 *  desktop resolves at runtime, or the static HARNESS_MODELS on the web. */
export type EffectiveModels = Record<HarnessId, ModelOption[]>;

/** The reasoning-effort ladder to show for a (harness, model), resolved against the
 *  effective model map so Codex's per-model levels (from its catalog) come through.
 *  An empty result means the effort control should be hidden. */
export function effortLevelsFor(harness: HarnessId, model: string, models: EffectiveModels): EffortLevel[] {
  const opt = (models[harness] ?? []).find((m) => m.id === model);
  return effortLevelsForModel(harness, model, opt);
}

/** Context window for a model, preferring the window carried by a runtime-discovered
 *  model (Codex) and falling back to the static CONTEXT_WINDOWS map / default. */
export function contextWindowForModel(model: string | undefined, models: EffectiveModels): number {
  if (model) {
    for (const list of Object.values(models)) {
      const found = list.find((m) => m.id === model);
      if (found?.contextWindow) return found.contextWindow;
    }
    if (CONTEXT_WINDOWS[model]) return CONTEXT_WINDOWS[model];
  }
  return CONTEXT_WINDOW;
}

/** Display label for a harness id (e.g. "Claude Code"). */
export function harnessLabel(harness: HarnessId): string {
  return HARNESS_DISPLAY[harness] ?? harness;
}
