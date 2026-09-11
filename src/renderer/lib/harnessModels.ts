import { useSyncExternalStore } from 'react';
import { HARNESS_MODELS, type HarnessId, type ModelOption } from '../../shared/types';
import { invoke, on } from './api';

// The pure model helpers moved to the shared UI package (web-desktop-parity spec
// §7.3) so the shared composer chips can resolve effort ladders / context windows
// without IPC. Re-exported here so existing renderer imports keep working.
export { effortLevelsFor, contextWindowForModel, type EffectiveModels } from '../../shared/ui/models';
import type { EffectiveModels } from '../../shared/ui/models';

// Codex's model list is discovered at runtime (the main process reads Codex's own
// catalog); every other harness is static. We fetch the effective map once, cache
// it here, and re-render any mounted picker when it arrives. Until then — and if the
// fetch ever fails — pickers fall back to the static HARNESS_MODELS lists.
let override: EffectiveModels | null = null;
let requested = false;
let subscribed = false;
const listeners = new Set<() => void>();

function apply(map: EffectiveModels | null): void {
  if (map && typeof map === 'object') {
    override = map;
    for (const notify of listeners) notify();
  }
}

function request(): void {
  // A live Codex catalog refresh (§6) can land after the initial fetch — while a
  // picker is open — so keep listening for the pushed map, not just the one reply.
  if (!subscribed) {
    subscribed = true;
    on('harness:models:updated', (map) => apply(map));
  }
  if (requested) return;
  requested = true;
  void invoke('harness:models')
    .then((map) => apply(map))
    .catch(() => {
      // Leave `override` null so pickers keep the static fallback.
    });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  request();
  return () => {
    listeners.delete(onChange);
  };
}

// `override` is null until the fetch resolves, then a single fixed object — so
// this is a stable snapshot and useSyncExternalStore re-renders exactly once.
function snapshot(): EffectiveModels | null {
  return override;
}

/** The effective per-harness model map for pickers: the live map once the main
 *  process reports it (Codex resolved from its catalog), else the static built-in
 *  lists. Re-renders the caller when the live map first arrives. */
export function useHarnessModels(): EffectiveModels {
  return useSyncExternalStore(subscribe, snapshot, snapshot) ?? HARNESS_MODELS;
}

// Re-export the model option type for callers that imported it from here.
export type { HarnessId, ModelOption };
