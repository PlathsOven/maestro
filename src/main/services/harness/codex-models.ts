import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_EFFORT_LEVELS,
  CONTEXT_WINDOW,
  HARNESS_MODELS,
  type EffortLevel,
  type HarnessId,
  type ModelOption,
} from '../../../shared/types';
import { grokModels } from './grok-models';
import { localHost } from '../../hosts/local';
import { broadcast } from '../../bus';

// The Codex CLI keeps a self-updating catalog of the models the signed-in account
// can use, fetched from its backend into ~/.codex/models_cache.json. We mirror the
// user-visible slice of that catalog so our picker tracks new Codex models (5.5,
// the 5.6 family, whatever ships next) without anyone hand-editing HARNESS_MODELS.
const CACHE_PATH = join(homedir(), '.codex', 'models_cache.json');

interface CatalogEntry {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
  context_window?: unknown;
  supported_reasoning_levels?: unknown;
  default_reasoning_level?: unknown;
}

let memo: { mtimeMs: number; models: ModelOption[] } | null = null;

/** The Codex models to offer, read live from Codex's own catalog. Memoised by the
 *  cache file's mtime, so an out-of-band refresh (the Codex CLI resyncing, or our
 *  own `codex debug models`, §6) is picked up on the next call without an app
 *  restart, while a re-read (parses ~280KB) is skipped when nothing changed. Falls
 *  back to the built-in HARNESS_MODELS.codex list when the cache is missing or
 *  unreadable — a fresh install with no Codex, a permissions error, a format
 *  change — so the picker never ends up empty. */
export function codexModels(): ModelOption[] {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(CACHE_PATH).mtimeMs;
  } catch {
    return HARNESS_MODELS.codex as ModelOption[];
  }
  if (!memo || memo.mtimeMs !== mtimeMs) memo = { mtimeMs, models: readCatalog() ?? (HARNESS_MODELS.codex as ModelOption[]) };
  return memo.models;
}

function readCatalog(): ModelOption[] | null {
  try {
    return parseCatalog(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** Parse a Codex catalog (from the cache file or `codex debug models` stdout —
 *  same schema) into our picker's model list, strongest→weakest. Null on bad
 *  JSON or an empty list. */
export function parseCatalog(json: string): ModelOption[] | null {
  try {
    const raw = JSON.parse(json) as { models?: CatalogEntry[] };
    const models = (raw.models ?? [])
      // `visibility: 'list'` are the models the CLI's own picker shows; 'hide'
      // marks internal ones (e.g. codex-auto-review) we must not offer.
      .filter((m): m is CatalogEntry & { slug: string } => m?.visibility === 'list' && typeof m.slug === 'string')
      // Codex orders its picker by ascending priority (lower = stronger/newer);
      // our lists are read strongest→weakest, so this matches modelForTier().
      .sort((a, b) => priority(a) - priority(b))
      .map((m) => ({
        id: m.slug,
        // Codex hyphenates the variant ("GPT-5.6-Sol"); our UI spaces it
        // ("GPT-5.6 Sol"). Only split hyphens before a word, not version dots.
        label: String(m.display_name ?? m.slug).replace(/-(?=[A-Za-z])/g, ' '),
        contextWindow: typeof m.context_window === 'number' ? m.context_window : CONTEXT_WINDOW,
        // Per-model effort ladder — Codex models genuinely differ (5.6 adds
        // max/ultra, 5.4 stops at xhigh), so the picker tracks each model's own.
        efforts: catalogEfforts(m),
        defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined,
      }));
    return models.length ? models : null;
  } catch {
    return null;
  }
}

let lastRefresh = 0;
const REFRESH_THROTTLE_MS = 60 * 60_000; // once per hour — the backend catalog changes rarely

/**
 * Ask the Codex CLI to re-sync its catalog from the backend (`codex debug models`,
 * which prints the catalog AND rewrites models_cache.json), then update the memo
 * and tell the renderer so an open picker re-renders. Throttled to once an hour.
 * Silent on failure (not installed, offline, signed out) — the file-based path
 * still serves the picker. Returns true when a fresh catalog was applied.
 */
export async function refreshCodexCatalog(): Promise<boolean> {
  const nowMs = Date.now();
  if (nowMs - lastRefresh < REFRESH_THROTTLE_MS) return false;
  lastRefresh = nowMs;
  try {
    const r = await localHost.exec('codex', ['debug', 'models'], { timeout: 15_000 });
    if (!r.ok) return false;
    const models = parseCatalog(r.stdout);
    if (!models) return false;
    // `codex debug models` rewrote the cache file, so key the memo to its new
    // mtime — a later codexModels() then agrees with what we just broadcast.
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(CACHE_PATH).mtimeMs;
    } catch {}
    memo = { mtimeMs, models };
    broadcast('harness:models:updated', effectiveHarnessModels());
    return true;
  } catch {
    return false;
  }
}

function priority(m: CatalogEntry): number {
  return typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER;
}

/** Map a catalog entry's `supported_reasoning_levels` to our EffortLevel[] (label +
 *  bars from CODEX_EFFORT_LEVELS), preserving catalog order and dropping any level
 *  we have no glyph for. Returns undefined when the catalog omits the field. */
function catalogEfforts(m: CatalogEntry): EffortLevel[] | undefined {
  if (!Array.isArray(m.supported_reasoning_levels)) return undefined;
  const out: EffortLevel[] = [];
  for (const lv of m.supported_reasoning_levels) {
    const id = (lv as { effort?: unknown })?.effort;
    const def = typeof id === 'string' ? CODEX_EFFORT_LEVELS.find((e) => e.id === id) : undefined;
    if (def) out.push(def);
  }
  return out.length ? out : undefined;
}

/** Translate a stored effort id into a Codex `model_reasoning_effort` value the
 *  given model actually supports. Native Codex ids pass through; Maestro/Claude
 *  ids ('max' on a model without it, 'ultracode') and anything unsupported clamp
 *  to the nearest supported level, so a stale cross-harness effort never breaks a
 *  run. Guaranteed to return a level the model advertises. */
export function codexReasoningEffort(model: string, effort: string): string {
  const supported = (codexModels().find((m) => m.id === model)?.efforts ?? CODEX_EFFORT_LEVELS.slice(0, 4)).map(
    (e) => e.id
  );
  if (supported.includes(effort)) return effort;
  const prefer =
    effort === 'ultracode' ? ['ultra', 'max', 'xhigh', 'high'] :
    effort === 'max' ? ['max', 'xhigh', 'high'] :
    ['high', 'medium', 'low'];
  return prefer.find((id) => supported.includes(id)) ?? supported[supported.length - 1] ?? 'high';
}

/** The effective per-harness model map: the static lists, with Codex resolved
 *  live. This is the source of truth for both the renderer picker (via IPC) and
 *  main-side model validation, so the two never disagree about which models exist. */
export function effectiveHarnessModels(): Record<HarnessId, ModelOption[]> {
  return { ...(HARNESS_MODELS as Record<HarnessId, ModelOption[]>), codex: codexModels(), grok: grokModels() };
}
