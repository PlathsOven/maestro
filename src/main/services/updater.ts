import { app, dialog, powerMonitor } from 'electron';
import { autoUpdater } from 'electron-updater';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { broadcast } from '../bus';
import type { AppUpdate, UpdateCheckOutcome } from '../../shared/types';

// electron-updater reads its feed URL from the `app-update.yml` that
// electron-builder bakes into the packaged app from `build.publish`, so there's
// nothing to configure at runtime — we only wire the lifecycle:
//   check → background download → 'update-downloaded' → popup → quitAndInstall().

let pending: AppUpdate | null = null;
// The version currently downloading, captured from 'update-available' so the
// 'download-progress' events (which don't carry the version) can label it.
let downloadingVersion: string | null = null;
// Set on a post-update launch to the version we relaunched into, so the renderer
// can confirm the update actually applied (see detectInstalled).
let installed: AppUpdate | null = null;
// Set when the user clicks "Restart to update", so a native-updater error that
// arrives asynchronously (bad signature, staging failure) can be routed back to
// the toast instead of vanishing.
let installRequested = false;

// electron-updater runs silently by default, so a failed install leaves no
// trace — the button just appears to do nothing. Mirror the whole lifecycle to
// ~/Library/Logs/<App>/updater.log (and stdout for terminal-launched runs) so
// native failures (signature mismatch, Gatekeeper translocation, feed errors)
// are diagnosable.
function updaterLog(level: 'info' | 'warn' | 'error', msg: unknown) {
  const text = msg instanceof Error ? (msg.stack ?? msg.message) : String(msg);
  const line = `${new Date().toISOString()} [${level}] ${text}\n`;
  try {
    appendFileSync(join(app.getPath('logs'), 'updater.log'), line);
  } catch {}
  (level === 'error' ? console.error : console.log)('[updater]', text);
}
// electron-updater's Logger interface (info/warn/error; debug omitted on purpose
// to keep the log readable — the info level already covers the install steps).
const logger = {
  info: (m?: unknown) => updaterLog('info', m),
  warn: (m?: unknown) => updaterLog('warn', m),
  error: (m?: unknown) => updaterLog('error', m),
};

function toNotes(info: { releaseNotes?: unknown; releaseName?: unknown }): string {
  if (typeof info.releaseNotes === 'string') return info.releaseNotes;
  if (typeof info.releaseName === 'string') return info.releaseName;
  return '';
}

// quitAndInstall() relaunches a brand-new process, so the only way the updated
// app can tell it was just updated is a breadcrumb the outgoing process leaves
// in userData. installUpdate() writes the target version here right before it
// hands off to the native updater; detectInstalled() reads it back on the next
// launch and consumes it, so the confirmation shows exactly once.
const markerPath = () => join(app.getPath('userData'), 'update-marker.json');

/** If this launch is the relaunch after a successful "Restart to update",
 *  remember it so the renderer can confirm the update landed. Always consumes
 *  the breadcrumb; a version mismatch (e.g. a read-only DMG swallowed the swap)
 *  stays silent rather than claiming a success that didn't happen. */
function detectInstalled() {
  let target: string | undefined;
  try {
    target = JSON.parse(readFileSync(markerPath(), 'utf8'))?.installingVersion;
  } catch {
    return; // no breadcrumb — an ordinary launch
  }
  try {
    rmSync(markerPath(), { force: true });
  } catch {}
  if (target === app.getVersion()) {
    installed = { version: app.getVersion(), notes: '' };
    updaterLog('info', `Update applied — now running ${app.getVersion()}`);
    broadcast('update:installed', installed);
  } else {
    updaterLog('warn', `Update marker ${target} != running ${app.getVersion()}; no confirmation`);
  }
}

/** Start background update checks. No-op in dev (there is no app-update.yml). */
export function initUpdater() {
  if (!app.isPackaged) return;

  // Surface a one-time confirmation if we just relaunched into a new version.
  // Runs before the checks are wired so the result is ready by the time the
  // renderer pulls update:installed on mount.
  detectInstalled();

  autoUpdater.logger = logger;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Remember which version is being pulled so progress events can be labelled,
  // and surface an initial 0% so the renderer can show "downloading" state
  // before the first chunk lands.
  autoUpdater.on('update-available', (info) => {
    if (pending) return; // already downloaded and staged — a re-check, not a new download
    downloadingVersion = info.version;
    broadcast('update:progress', { version: info.version, percent: 0 });
  });
  // Stream download progress so the renderer can render a live progress bar
  // instead of a static "downloading now" line.
  autoUpdater.on('download-progress', (p) => {
    const version = downloadingVersion ?? app.getVersion();
    const percent = Math.max(0, Math.min(100, Math.round(p.percent)));
    broadcast('update:progress', { version, percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloadingVersion = null;
    pending = { version: info.version, notes: toNotes(info) };
    broadcast('update:progress', { version: info.version, percent: 100 });
    broadcast('update:available', pending);
  });
  // A failed check (offline, feed unreachable) must never crash or nag the user,
  // but an error that follows a "Restart to update" click is a failed install —
  // route it back to the toast so the button doesn't hang on "Restarting…".
  // A user-initiated check reports its own failure via checkForUpdatesNow()'s
  // return value, so nothing else needs handling here.
  autoUpdater.on('error', (err) => {
    updaterLog('error', err);
    if (installRequested) {
      installRequested = false;
      broadcast('update:error', { message: err?.message || String(err) });
    }
  });

  // Throttle automatic checks so the 2-min timer plus the focus/resume triggers
  // below can't hit the feed more than once a minute.
  let lastAutoCheck = 0;
  const check = () => {
    const now = Date.now();
    if (now - lastAutoCheck < 60_000) return;
    lastAutoCheck = now;
    autoUpdater.checkForUpdates().catch(() => {});
  };

  check();
  // Poll every 2 min, and also whenever the user returns to the app or the
  // machine wakes from sleep, so a fresh release is picked up within minutes.
  setInterval(check, 2 * 60 * 1000);
  app.on('browser-window-focus', () => check());
  powerMonitor.on('resume', () => check());
}

/** The staged update, if one downloaded before a renderer mounted. */
export function pendingUpdate(): AppUpdate | null {
  return pending;
}

/** The update applied on the last restart, if this is a post-update launch —
 *  drives the "Updated" confirmation toast. Null on an ordinary launch. */
export function installedUpdate(): AppUpdate | null {
  return installed;
}

/** Quit, install the staged update, and relaunch. */
export function installUpdate() {
  updaterLog('info', 'User requested install (Restart to update)');
  if (!pending) {
    // The toast only shows when an update is staged, so this is an anomaly —
    // tell the renderer instead of silently no-op'ing the button.
    updaterLog('warn', 'Install requested but no update is staged');
    broadcast('update:error', { message: 'No update is staged — please check for updates again.' });
    return;
  }
  installRequested = true;
  // Leave a breadcrumb the relaunched process reads back to confirm the update
  // landed. Best-effort: losing it only costs the confirmation, not the update.
  try {
    writeFileSync(markerPath(), JSON.stringify({ installingVersion: pending.version }));
  } catch (err) {
    updaterLog('warn', err);
  }
  try {
    // On success this quits the app and hands off to the native updater, so
    // control never returns here. A synchronous throw means the install never
    // started; surface it so the toast recovers.
    autoUpdater.quitAndInstall();
  } catch (err) {
    installRequested = false;
    updaterLog('error', err);
    broadcast('update:error', { message: (err as Error)?.message || String(err) });
  }
}

/**
 * Force an immediate check and report the outcome to the caller — powers the
 * in-Settings "Check for updates" button, which renders the result inline. Shows
 * no dialogs of its own (autoDownload still pulls any update in the background,
 * and 'update-downloaded' surfaces the restart toast when it lands).
 */
export async function checkForUpdatesNow(): Promise<UpdateCheckOutcome> {
  if (!app.isPackaged) return { status: 'disabled' };
  if (pending) {
    // Already downloaded and waiting — re-surface the restart toast, and tell
    // the caller so it can point the user at it.
    broadcast('update:available', pending);
    return { status: 'downloaded', version: pending.version };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    // autoDownload=true, so an available update is already downloading; the
    // 'update-downloaded' handler will broadcast update:available for the toast.
    const available = result?.isUpdateAvailable ?? Boolean(result?.downloadPromise);
    return available && result
      ? { status: 'available', version: result.updateInfo.version }
      : { status: 'current', version: app.getVersion() };
  } catch (err) {
    updaterLog('error', err);
    return { status: 'error', message: (err as Error)?.message || String(err) };
  }
}

/**
 * The native "Check for Updates…" menu item: runs the same check but reports the
 * result as a native dialog (there's no renderer surface for a menu action).
 */
export async function checkForUpdatesFromMenu(): Promise<void> {
  const outcome = await checkForUpdatesNow();
  const info = (message: string, detail?: string) =>
    void dialog.showMessageBox({ type: 'info', message, detail, buttons: ['OK'] });
  switch (outcome.status) {
    case 'disabled':
      return info('Updates are disabled in development builds.');
    case 'current':
      return info("You're on the latest version.", `Maestro ${outcome.version} is up to date.`);
    case 'available':
      return info(
        'Update available',
        `Maestro ${outcome.version} is downloading in the background. You'll be prompted to restart when it's ready.`
      );
    case 'downloaded':
      return info('Update ready', `Maestro ${outcome.version} is ready — restart to finish updating.`);
    case 'error':
      return void dialog.showMessageBox({
        type: 'error',
        message: "Couldn't check for updates.",
        detail: outcome.message,
        buttons: ['OK'],
      });
  }
}
