import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { HARNESS_MODELS, type ModelOption } from '../../../shared/types';

// Grok Build reads ~/.grok/config.toml (Windows %USERPROFILE%\.grok\config.toml).
// Unlike Codex, Grok ships no backend-synced model catalog, but its config supports
// custom `[model.<id>]` sections (a user pointing at a self-hosted or preview
// model). We surface those alongside the built-in list so the picker shows them
// without anyone hand-editing HARNESS_MODELS. The exact section shape is [verify]
// (spec §7): we probe `[model.*]` and `[models.*]` and read a label / context
// window when present, else fall back to the section id.
const CONFIG_PATH = join(homedir(), '.grok', 'config.toml');

let memo: ModelOption[] | null = null;

/** The Grok models to offer: the built-in list plus any custom models declared in
 *  ~/.grok/config.toml. Memoised for the app session; falls back to the built-in
 *  HARNESS_MODELS.grok list when the config is missing, unreadable, or declares no
 *  custom models, so the picker is never empty. */
export function grokModels(): ModelOption[] {
  if (!memo) memo = readConfig() ?? (HARNESS_MODELS.grok as ModelOption[]);
  return memo;
}

function readConfig(): ModelOption[] | null {
  const builtins = HARNESS_MODELS.grok as ModelOption[];
  let parsed: any;
  try {
    parsed = TOML.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null; // no config / unreadable / not TOML → built-ins only
  }
  const custom: ModelOption[] = [];
  const seen = new Set(builtins.map((m) => m.id));
  // `[model.foo]` parses to { model: { foo: {...} } }; some configs may use the
  // plural `[models.foo]`. A scalar `model = "grok-4.6"` (a default-model setting)
  // is not a table, so the typeof guard skips it.
  for (const section of [parsed?.model, parsed?.models]) {
    if (!section || typeof section !== 'object') continue;
    for (const [id, cfg] of Object.entries(section as Record<string, any>)) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label =
        (typeof cfg?.display_name === 'string' && cfg.display_name) ||
        (typeof cfg?.name === 'string' && cfg.name) ||
        id;
      const contextWindow = typeof cfg?.context_window === 'number' ? cfg.context_window : undefined;
      custom.push({ id, label, ...(contextWindow ? { contextWindow } : {}) });
    }
  }
  // Built-ins first (canonical strongest→weakest order the modelForTier contract
  // relies on), custom models appended after.
  return custom.length ? [...builtins, ...custom] : null;
}
