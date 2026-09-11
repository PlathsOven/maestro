import { screen } from 'electron';
import { getWindow } from '../bus';
import { Settings } from '../db';

/**
 * Whole-app zoom. Chromium's page zoom already scales every pixel the renderer
 * draws — chrome, Monaco, xterm — so the feature is one setZoomLevel plus the
 * three things page zoom can't reach: the native window controls (painted over
 * the page, not in it), the window's minimum size, and the preview
 * WebContentsView (a sibling of the page, positioned in DIP — see `toDip`).
 *
 * Zoom is a window property, so it stays in main: menu → here → persisted. The
 * ladder is Chromium's own (factor = 1.2^level); half a level is a ~10% step,
 * and the limits below span 58%–207%.
 */

export const ZOOM_STEP = 0.5;
const MIN_LEVEL = -3;
const MAX_LEVEL = 4;

/** Height of the native minimize·maximize·close overlay Windows/Linux paint over
 *  the renderer's title bar at 100% (macOS insets traffic lights instead). */
export const TITLE_BAR_HEIGHT = 40;

/** The smallest window the three-pane layout is designed for, in CSS px. */
export const MIN_LAYOUT_SIZE = { width: 1080, height: 680 };

/** Zoom to `level` (0 = 100%), clamped, and remember it for next launch. */
export function setZoom(level: number): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  const next = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Number.isFinite(level) ? level : 0));
  win.webContents.setZoomLevel(next);
  Settings.setRaw('zoomLevel', String(next));
  const factor = win.webContents.getZoomFactor();

  // A CSS px now costs `factor` real pixels, so the layout's minimum costs that
  // much more window — grow the floor with it, and the window itself if it's
  // under that floor, rather than let zoom squeeze the panes past the size
  // they're designed for. Never past the display, though: on a small screen the
  // floor stops at the work area and the user gets the squeeze they asked for.
  const workArea = screen.getDisplayMatching(win.getBounds()).workAreaSize;
  const minWidth = Math.min(Math.round(MIN_LAYOUT_SIZE.width * factor), workArea.width);
  const minHeight = Math.min(Math.round(MIN_LAYOUT_SIZE.height * factor), workArea.height);
  win.setMinimumSize(minWidth, minHeight);
  const [width, height] = win.getSize();
  if (!win.isMaximized() && !win.isFullScreen() && (width < minWidth || height < minHeight)) {
    win.setSize(Math.max(width, minWidth), Math.max(height, minHeight));
  }

  // Keep the window controls on the title bar the page just redrew at 40 × factor.
  if (process.platform !== 'darwin') {
    win.setTitleBarOverlay({ height: Math.round(TITLE_BAR_HEIGHT * factor) });
  }
}

export function nudgeZoom(delta: number): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) setZoom(win.webContents.getZoomLevel() + delta);
}

/** Re-apply the saved zoom after a load — any navigation (⌘R included) drops it. */
export function restoreZoom(): void {
  setZoom(parseFloat(Settings.raw('zoomLevel') ?? '') || 0);
}

/** CSS px measured in the renderer → device-independent px, the unit every
 *  main-process geometry API speaks. The two only diverge once the app is
 *  zoomed, which is exactly when a bounds sync would otherwise drift. */
export function toDip(cssPx: number): number {
  const win = getWindow();
  return cssPx * (win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1);
}
