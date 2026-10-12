/**
 * Colour themes, shared by the desktop renderer and Maestro Web.
 *
 * A theme is a palette family with a light and a dark variant. The family rides
 * on `<html data-theme="…">`, the variant on the existing `.dark` class, so the
 * two choices are independent: `theme` (System / Light / Dark) picks the
 * variant, `colorTheme` picks the family. The palettes themselves are CSS
 * (src/shared/ui/themes.css); this is just the catalog the pickers list and the
 * validators the settings paths run untrusted values through.
 *
 * Classic is the original Maestro look and stays the default.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

export const COLOR_THEMES = [
  { id: 'classic', label: 'Classic', blurb: 'Warm neutrals with a violet accent' },
  { id: 'catppuccin', label: 'Catppuccin', blurb: 'Cosy pastels, soft and round — Latte and Mocha' },
  { id: 'nord', label: 'Nord', blurb: 'Arctic calm: frosted glass under an aurora' },
  { id: 'solarized', label: 'Solarized', blurb: 'Flat and exact — no glass, just measured contrast' },
  { id: 'gruvbox', label: 'Gruvbox', blurb: 'A retro workshop: warm lamplight and paper grain' },
  { id: 'rose-pine', label: 'Rosé Pine', blurb: 'Twilight rose and iris, with serif headings' },
  { id: 'tokyo-night', label: 'Tokyo Night', blurb: 'A neon city after rain — Day and Night' },
  { id: 'everforest', label: 'Everforest', blurb: 'Soft, round and dappled with forest light' },
  // Experimental: these go past a palette swap (type, shape, texture, glow), so
  // the picker lists them apart. Each still has a light and a dark variant.
  { id: 'synthwave', label: 'Synthwave', blurb: 'A striped sun over a neon grid — or vaporwave pastels', experimental: true },
  { id: 'phosphor', label: 'Phosphor', blurb: 'A green CRT with scanlines — or greenbar printer paper', experimental: true },
  { id: 'brutalist', label: 'Brutalist', blurb: 'Hard edges, hard shadows, no glass', experimental: true },
  { id: 'blueprint', label: 'Blueprint', blurb: 'A cyanotype drafting sheet — or pencil on graph paper', experimental: true },
  { id: 'bubblegum', label: 'Bubblegum', blurb: 'Candy-coloured, bouncy and sprinkled', experimental: true },
] as const satisfies readonly { id: string; label: string; blurb: string; experimental?: true }[];

export type ColorThemeId = (typeof COLOR_THEMES)[number]['id'];

export const DEFAULT_COLOR_THEME: ColorThemeId = 'classic';

export function isColorTheme(v: unknown): v is ColorThemeId {
  return typeof v === 'string' && COLOR_THEMES.some((t) => t.id === v);
}

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'system' || v === 'light' || v === 'dark';
}

/** An unknown / missing family (an older build, a hand-edited value) falls back
 *  to Classic rather than to no palette at all. */
export function normalizeColorTheme(v: unknown): ColorThemeId {
  return isColorTheme(v) ? v : DEFAULT_COLOR_THEME;
}

/** Stamp a theme onto a root element: the family attribute + the dark class. */
export function applyThemeToElement(el: HTMLElement, colorTheme: ColorThemeId, dark: boolean): void {
  el.dataset.theme = colorTheme;
  el.classList.toggle('dark', dark);
}

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

/** Call `cb` whenever <html> flips light/dark or colour family. One shared
 *  observer fans out to every subscriber. */
export function subscribeTheme(cb: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => {};
  themeListeners.add(cb);
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => themeListeners.forEach((l) => l()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  }
  return () => void themeListeners.delete(cb);
}
