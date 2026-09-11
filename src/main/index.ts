import { BrowserWindow, Menu, app, dialog, shell } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveShellEnv } from './env';
import { Settings, Workspaces, initDb } from './db';
import { broadcast, setMenuRebuildHook, setWindow } from './bus';
import { resolveShortcuts } from '../shared/shortcuts';
import { appIconPath } from './icon';
import { registerIpc } from './ipc';
import { detectHarnesses, stopAllAgents } from './services/harness';
import { refreshCodexCatalog } from './services/harness/codex-models';
import { catchUpAll, reconnectCatchUp, stopAllFollowers } from './services/cloud';
import { bootDrainLocalQueues } from './services/chat';
import * as account from './services/account';
import { isCloudWorkspace } from './hosts';
import { setHostConnectedHook } from './hosts/ssh';
import { installBridgeClis, startRoleServer, stopRoleServer } from './services/roleserver';
import { destroyAllPreviews } from './services/preview';
import { killAllPtys } from './services/pty';
import { shutdownAllKernels } from './services/jupyter';
import { stopAllDictation } from './services/stt';
import { watchAllActive } from './services/watcher';
import { backfillChatTitles } from './services/workspaces';
import { startPrPolling } from './services/pr';
import { startHarnessSync } from './services/harnessSync';
import { initRemoteHosts } from './hosts/remote';
import { disposeAllHosts } from './hosts';
import { checkForUpdatesFromMenu, initUpdater } from './services/updater';
import { initScheduler } from './services/schedule';
import { initAnalytics, shutdownAnalytics } from './services/analytics';
import { MIN_LAYOUT_SIZE, TITLE_BAR_HEIGHT, ZOOM_STEP, nudgeZoom, restoreZoom, setZoom } from './services/zoom';

const isSmoke = process.argv.includes('--smoke');
const screenshotArg = process.argv.find((a) => a.startsWith('--screenshot='));
// --smoke-delay=<ms>: how long after load to screenshot (default 3500/5500) —
// raise it when the state under test needs async work (git, LLM calls) to land.
const smokeDelayMs = parseInt(process.argv.find((a) => a.startsWith('--smoke-delay='))?.split('=')[1] ?? '', 10) || null;
const smokeActions = (process.argv.find((a) => a.startsWith('--smoke-actions='))?.split('=')[1] ?? '')
  .split(',')
  .filter(Boolean);
// --record=<dir>: smoke-mode video capture — JPEG frames from did-finish-load
// until --smoke-delay, for ffmpeg to stitch (`RECORD_OK` prints the effective
// fps to encode at, since capturePage can't always hold the nominal rate).
const recordDir = process.argv.find((a) => a.startsWith('--record='))?.split('=')[1] ?? null;
const recordFps = parseInt(process.argv.find((a) => a.startsWith('--record-fps='))?.split('=')[1] ?? '', 10) || 10;
// --demo-script=<ms>:<verb>[:<payload>],… — timed drive for recorded demos:
//   menu:<action>     broadcast a menu:action (same names the app menu sends)
//   cursor:<x>.<y>    glide the injected fake cursor to CSS-px coords
//   click:<x>.<y>     glide there, pulse, then deliver a real mouse click
//   type:<base64>     type UTF-8 text into the focused element, char by char
//   key:<Enter|…>     press one key (keyDown/keyUp, so React handlers fire)
// slice, don't split('=') — base64 `type:` payloads can end in '=' padding
const demoScript = (process.argv.find((a) => a.startsWith('--demo-script='))?.slice('--demo-script='.length) ?? '')
  .split(',')
  .filter(Boolean)
  .map((item) => {
    const [at, verb, ...rest] = item.split(':');
    return { at: parseInt(at, 10) || 0, verb, payload: rest.join(':') };
  });

// Smoke/test runs must not share the Chromium profile with a real session —
// the userData lock would hang the second instance before it opens a window.
const userDataOverride =
  process.env.MAESTRO_USER_DATA || (isSmoke ? path.join(os.tmpdir(), `maestro-smoke-${process.pid}`) : null);
if (userDataOverride) app.setPath('userData', userDataOverride);

let mainWindow: BrowserWindow | null = null;

// ---------- startup diagnostics ----------

// Startup runs before any renderer exists, so a failure here has nowhere to
// show itself — the symptom is a live process with no window (§ startupLog's
// callers). Mirror it to ~/AppData/Roaming/Maestro/logs/main.log alongside the
// updater's, so the next occurrence is diagnosable after the fact.
function startupLog(msg: unknown, err?: unknown) {
  const detail = err instanceof Error ? (err.stack ?? err.message) : err !== undefined ? String(err) : '';
  const line = `${new Date().toISOString()} [main] ${msg}${detail ? ` — ${detail}` : ''}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('logs'), 'main.log'), line);
  } catch {}
  (err === undefined ? console.log : console.error)(line.trimEnd());
}

/** A startup step whose failure must never cost the user their window. */
function step(name: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    startupLog(`${name} failed`, err);
  }
}

// ---------- demo recording (--record / --demo-script) ----------

/** Frame-capture loop. Returns a stopper that resolves once the last frame is on disk. */
function startRecording(win: BrowserWindow, dir: string, fps: number) {
  fs.mkdirSync(dir, { recursive: true });
  win.webContents.setBackgroundThrottling(false);
  let stopped = false;
  const t0 = Date.now();
  const loop = (async () => {
    let frames = 0;
    while (!stopped) {
      const wait = t0 + (frames * 1000) / fps - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (stopped) break;
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, `f${String(frames).padStart(5, '0')}.jpg`), img.toJPEG(90));
        frames++;
      } catch {
        // capturePage rejects until the window is actually on screen, which on
        // Windows lands well after did-finish-load. Only a destroyed window ends
        // the recording; anything else is transient, so keep trying.
        if (win.isDestroyed()) break;
        await new Promise((r) => setTimeout(r, 1000 / fps));
      }
    }
    return frames;
  })();
  return async () => {
    stopped = true;
    const frames = await loop;
    console.log(`RECORD_OK frames=${frames} fps=${(frames / ((Date.now() - t0) / 1000)).toFixed(3)} dir=${dir}`);
    return frames;
  };
}

/** A fake on-page cursor (capturePage never includes the OS cursor). */
function injectDemoCursor(win: BrowserWindow) {
  return win.webContents
    .executeJavaScript(
      `(() => {
        if (window.__demoCursor) return;
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;' +
          'transition:transform 520ms cubic-bezier(.3,.7,.3,1);transform:translate(745px,465px);will-change:transform;';
        el.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))">' +
          '<path d="M5.5 3.2v17.6c0 .45.54.67.85.35l4.3-4.3c.1-.1.22-.15.36-.15h6.1c.45 0 .67-.54.35-.85L6.35 2.85c-.31-.31-.85-.09-.85.35Z" fill="#1a1918" stroke="#fff" stroke-width="1.6"/></svg>';
        document.body.appendChild(el);
        window.__demoCursor = (x, y, click) => {
          el.style.transform = 'translate(' + (x - 5.5) + 'px,' + (y - 3.2) + 'px)';
          if (!click) return;
          const r = document.createElement('div');
          r.style.cssText = 'position:fixed;left:' + (x - 14) + 'px;top:' + (y - 14) + 'px;width:28px;height:28px;' +
            'border-radius:50%;border:2.5px solid var(--accent,#7c5cff);z-index:2147483646;pointer-events:none;';
          document.body.appendChild(r);
          r.animate([{ transform: 'scale(.35)', opacity: 0.9 }, { transform: 'scale(1.5)', opacity: 0 }],
            { duration: 480, easing: 'ease-out' }).onfinish = () => r.remove();
        };
      })()`
    )
    .catch(() => {});
}

async function runDemoStep(win: BrowserWindow, step: { verb: string; payload: string }) {
  const wc = win.webContents;
  const cursorTo = (x: number, y: number, click: boolean) =>
    wc.executeJavaScript(`window.__demoCursor && window.__demoCursor(${x},${y},${click})`).catch(() => {});
  if (step.verb === 'menu') {
    broadcast('menu:action', { action: step.payload });
  } else if (step.verb === 'cursor' || step.verb === 'click') {
    const [x, y] = step.payload.split('.').map(Number);
    await cursorTo(x, y, false);
    await new Promise((r) => setTimeout(r, 560)); // let the glide land first
    // Real mouseMove too, so hover state (flyouts, highlights) tracks the fake cursor.
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    if (step.verb === 'click') {
      await cursorTo(x, y, true);
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }
  } else if (step.verb === 'type') {
    wc.focus();
    const text = Buffer.from(step.payload, 'base64').toString('utf8');
    for (let i = 0; i < text.length; i++) {
      wc.sendInputEvent({ type: 'char', keyCode: text[i] });
      await new Promise((r) => setTimeout(r, 34 + ((i * 7919) % 52))); // human-ish cadence
    }
  } else if (step.verb === 'key') {
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: step.payload });
    wc.sendInputEvent({ type: 'keyUp', keyCode: step.payload });
  }
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: MIN_LAYOUT_SIZE.width,
    minHeight: MIN_LAYOUT_SIZE.height,
    show: false,
    backgroundColor: '#eae8e6',
    icon: appIconPath(),
    // Frameless with a custom title bar. macOS insets the traffic lights;
    // Windows/Linux get the native minimize/maximize/close buttons overlaid
    // (matched to the light chrome) so a hidden title bar still has controls.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 17 } }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#eae8e6', symbolColor: '#1a1918', height: TITLE_BAR_HEIGHT },
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setWindow(mainWindow);

  // Grant permission requests (notably 'media', for the microphone that voice
  // dictation uses). Without a handler some Electron builds deny these; the app
  // only ever requests mic + clipboard/notifications.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));

  // The window is created hidden and shown on 'ready-to-show', which waits for
  // the renderer's first frame — so a renderer that never comes up leaves the
  // app with no window at all, alive but invisible, recoverable only through
  // Task Manager. That is what the Windows installer's "Run Maestro" checkbox
  // hits: the app is launched the instant the installer finishes writing, and
  // races the AV scan of the just-replaced files. So treat 'ready-to-show' as
  // the preferred path, not the only one — the load finishing, failing, or
  // taking too long all get a window on screen as well. Failures show
  // immediately (nothing better is coming); a finished load still gives
  // 'ready-to-show' a moment to win, so the usual launch keeps its unflashed
  // first paint.
  let revealed = false;
  let revealTimer: NodeJS.Timeout;
  const reveal = (why: string) => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return;
    revealed = true;
    clearTimeout(revealTimer);
    if (why !== 'ready-to-show') startupLog(`window shown via ${why} — 'ready-to-show' never fired`);
    mainWindow.show();
    mainWindow.focus();
  };
  const revealIn = (ms: number, why: string) => {
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => reveal(why), ms);
  };
  revealIn(10_000, 'startup deadline');
  mainWindow.once('ready-to-show', () => reveal('ready-to-show'));
  mainWindow.webContents.once('did-finish-load', () => revealIn(1_500, 'did-finish-load'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    startupLog(`renderer failed to load (${code} ${desc}) ${url}`);
    reveal('did-fail-load'); // an error page beats an invisible process
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    startupLog(`renderer process gone: ${details.reason} (exit ${details.exitCode})`);
    reveal('render-process-gone');
  });

  // External links open in the default browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Never let a link replace the app shell. A reload targets the exact same URL
  // and is allowed; anything else is blocked (http(s) opens in the OS browser,
  // everything else — file:// paths, relative links from agent output — is
  // simply prevented so the renderer can't navigate to a blank page).
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url === mainWindow?.webContents.getURL()) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  // dom-ready lands before ready-to-show, so the window is never shown unzoomed.
  mainWindow.webContents.on('dom-ready', restoreZoom);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  if (isSmoke) {
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log(`[renderer:${level}]`, message);
    });
    mainWindow.webContents.once('did-finish-load', () => {
      if (smokeActions.length) {
        setTimeout(() => {
          for (const action of smokeActions) broadcast('menu:action', { action });
        }, 3000);
      }
      if (demoScript.length) {
        void injectDemoCursor(mainWindow!);
        for (const step of demoScript) setTimeout(() => void runDemoStep(mainWindow!, step), step.at);
      }
      const stopRecording = recordDir ? startRecording(mainWindow!, recordDir, recordFps) : null;
      setTimeout(async () => {
        try {
          if (stopRecording) await stopRecording();
          const img = await mainWindow!.webContents.capturePage();
          const out = screenshotArg ? screenshotArg.split('=')[1] : '/tmp/maestro-smoke.png';
          fs.writeFileSync(out, img.toPNG());
          console.log(`SMOKE_OK screenshot=${out}`);
        } catch (e) {
          console.error('SMOKE_FAIL', e);
          process.exitCode = 1;
        }
        app.quit();
      }, smokeDelayMs ?? (smokeActions.length ? 5500 : 3500));
    });
    setTimeout(() => {
      console.error('SMOKE_TIMEOUT');
      process.exitCode = 1;
      app.quit();
    }, Math.max(45_000, (smokeDelayMs ?? 0) + 20_000));
  }

  mainWindow.on('closed', () => {
    clearTimeout(revealTimer);
    setWindow(null);
    mainWindow = null;
  });
}

function menuAction(action: string) {
  return () => broadcast('menu:action', { action });
}

/**
 * Edit menu. On Windows/Linux the items are shown but their accelerators aren't
 * registered, so the page — not the menu — handles ⌃C/⌃V. That matters for the
 * terminal: xterm's selection lives on a canvas, so the Copy role's
 * webContents.copy() finds nothing to copy, and a registered accelerator would
 * swallow the keystroke before xterm's own handler (or its interrupt) sees it.
 * Chromium binds these keys natively in editable fields, so nothing else
 * changes. macOS keeps the roles — there Cmd+C/V only work *through* the menu,
 * and accelerators are always registered — so its terminal copies by
 * right-click (TerminalPanel).
 */
function editMenu(): Electron.MenuItemConstructorOptions {
  if (process.platform === 'darwin') return { role: 'editMenu' };
  const page = { registerAccelerator: false } as const;
  return {
    label: 'Edit',
    submenu: [
      { role: 'undo', ...page },
      { role: 'redo', ...page },
      { type: 'separator' },
      { role: 'cut', ...page },
      { role: 'copy', ...page },
      { role: 'paste', ...page },
      { type: 'separator' },
      { role: 'selectAll', ...page },
    ],
  };
}

/**
 * Window menu. macOS keeps the stock role, but on Windows/Linux that role ends
 * in a Close item Electron hands the default CmdOrCtrl+W — a duplicate of
 * File ▸ Close Tab below. An accelerator can only belong to one item, and the
 * Window menu is built last, so its Close won: Ctrl+W closed the sole window
 * and took the whole app with it instead of closing the tab. Close Window keeps
 * the Ctrl+Shift+W it already has in File, so nothing here claims Ctrl+W.
 * (Both platforms hide the menu bar, so these items exist for their keys.)
 */
function windowMenu(): Electron.MenuItemConstructorOptions {
  if (process.platform === 'darwin') return { role: 'windowMenu' };
  return {
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' }],
  };
}

function buildMenu() {
  // Every customisable accelerator resolves from the registry + the user's
  // overrides (§9), so the menu, the palette hints, and the Settings editor
  // never disagree. `?? undefined` leaves an unbound item with no accelerator.
  const keys = resolveShortcuts(Settings.global().shortcuts);
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Maestro',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => void checkForUpdatesFromMenu() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: keys.settings ?? undefined, click: menuAction('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Workspace (Branch)', accelerator: keys['new-workspace'] ?? undefined, click: menuAction('new-workspace') },
        { label: 'New Chat', accelerator: keys['new-chat'] ?? undefined, click: menuAction('new-chat') },
        { label: 'Reopen Closed Tab', accelerator: keys['reopen-tab'] ?? undefined, click: menuAction('reopen-tab') },
        { type: 'separator' },
        { label: 'Open Project…', click: menuAction('open-project') },
        { label: 'Open GitHub Project…', click: menuAction('clone-repo') },
        { label: 'Quick Start Project…', click: menuAction('create-project') },
        { type: 'separator' },
        // ⌘W / Ctrl+W closes the active chat tab, not the window (single-window
        // app — closing the window would quit). ⌘⇧W still closes the window; the
        // Window menu must not re-bind ⌘W over this one (see windowMenu()).
        { label: 'Close Tab', accelerator: keys['close-tab'] ?? undefined, click: menuAction('close-tab') },
        { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' },
      ],
    },
    editMenu(),
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette', accelerator: keys.palette ?? undefined, click: menuAction('palette') },
        { type: 'separator' },
        { label: 'Focus Composer', accelerator: keys['focus-composer'] ?? undefined, click: menuAction('focus-composer') },
        { label: 'Chat', accelerator: keys['tab-chat'] ?? undefined, click: menuAction('tab-chat') },
        // ⌘J (was ⇧⌘T, now reassigned to Reopen Closed Tab).
        { label: 'Terminal', accelerator: keys['tab-terminal'] ?? undefined, click: menuAction('tab-terminal') },
        { label: 'Diff Viewer', accelerator: keys['tab-diff'] ?? undefined, click: menuAction('tab-diff') },
        { label: 'Editor', accelerator: keys['tab-editor'] ?? undefined, click: menuAction('tab-editor') },
        // ⌘⇧P is taken by Create Pull Request, so Preview uses ⌘⇧B (spec §5.1).
        { label: 'Preview', accelerator: keys['tab-preview'] ?? undefined, click: menuAction('tab-preview') },
        { label: 'Checks', accelerator: keys['tab-checks'] ?? undefined, click: menuAction('tab-checks') },
        { type: 'separator' },
        { label: 'Toggle Theme', click: menuAction('toggle-theme') },
        { type: 'separator' },
        // Not the built-in zoom roles: those forget the level on quit and can't
        // keep the window controls, minimum size and preview view in step (see
        // services/zoom). "Plus" is literally ⇧= to Chromium, so bare ⌘/Ctrl+=
        // gets a hidden twin — a hidden item keeps its accelerator registered.
        { label: 'Zoom In', accelerator: keys['zoom-in'] ?? undefined, click: () => nudgeZoom(ZOOM_STEP) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => nudgeZoom(ZOOM_STEP), visible: false },
        { label: 'Zoom Out', accelerator: keys['zoom-out'] ?? undefined, click: () => nudgeZoom(-ZOOM_STEP) },
        { label: 'Actual Size', accelerator: keys['zoom-reset'] ?? undefined, click: () => setZoom(0) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Workspace',
      submenu: [
        { label: 'Create Pull Request', accelerator: keys['create-pr'] ?? undefined, click: menuAction('create-pr') },
        { label: 'Archive Workspace', click: menuAction('archive') },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Workspace ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: menuAction(`workspace-${i + 1}`),
        })),
      ],
    },
    windowMenu(),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !isSmoke) {
  // Handing off to the instance that owns the lock (see 'second-instance'), so
  // this launch showing no window of its own is correct — log it, because from
  // the outside it looks identical to a launch that silently died.
  startupLog('another instance holds the lock — handing off and exiting');
  app.quit();
} else {
  // Launching Maestro again is the user's instinctive fix when the window isn't
  // where they expect it, so this handler is the last line of defence: whatever
  // state the running instance is in — minimized, hidden, buried behind the
  // installer that just launched it, or with no window at all — a second launch
  // has to put a window in front of them rather than silently exit.
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      startupLog('second instance with no window in the first — recreating');
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.moveTop(); // Windows won't raise a background window on focus() alone
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Packaged builds get build/icon.icns baked into the .app bundle by
    // electron-builder, which macOS then uses for the dock and for the
    // notification badge (macOS notifications always mirror the dock icon —
    // there's no per-notification override like Windows/Linux have). Dev
    // runs have no such bundle, so without this they show Electron's
    // default icon everywhere, notifications included.
    if (!app.isPackaged && process.platform === 'darwin') {
      app.dock?.setIcon(appIconPath());
    }
    // Everything up to createWindow() is load-bearing, and a throw in any of it
    // used to reject this promise into the void: no window, no error, just a
    // process sitting in Task Manager. Fail loudly instead — the user gets a
    // message they can act on (and report) rather than a silent no-op.
    try {
      resolveShellEnv();
      const dbPath =
        process.env.MAESTRO_DB_PATH || path.join(app.getPath('userData'), 'maestro.db');
      initDb(dbPath);
      // Wire host creation into the resolver before any remote project can be
      // focused (so hostForProject can build/connect an SSH box — or a cluster's
      // workspace node — on demand).
      initRemoteHosts();
      // A reconnecting host should re-tail its cloud chats and catch up.
      setHostConnectedHook(reconnectCatchUp);
      // Agent/script processes died with the previous app instance; clear stale statuses.
      for (const ws of Workspaces.list()) {
        if (ws.status === 'running') {
          // A cloud turn keeps running on the box across an app restart, so its
          // 'running' status may still be true — leave it for catch-up to confirm
          // from the journal (§6.3). A local turn died with the app.
          if (!isCloudWorkspace(ws)) {
            ws.status = ws.prNumber ? 'reviewing' : 'idle';
            Workspaces.update(ws);
          }
        } else if (ws.status === 'setting-up') {
          // 'setting-up' is provisioning driven by the (now-restarted) app process,
          // never by the box, so it can't resume and is always stale here. A cloud
          // move only reaches it after the host is assigned — the remote worktree
          // already exists and no turn was queued (catch-up would find the chat
          // quiescent and never clear it), so drop it to idle rather than let the
          // "Setting up worktree…" banner stick forever. A local worktree may be
          // half-built, so flag it for attention instead.
          if (isCloudWorkspace(ws)) {
            ws.status = 'idle';
          } else {
            ws.status = 'needs-attention';
            ws.setupError = ws.setupError ?? 'Setup was interrupted by an app restart';
          }
          Workspaces.update(ws);
        }
      }
      registerIpc(() => mainWindow);
      setMenuRebuildHook(buildMenu); // §9: settings:set rebuilds the menu on a shortcut change
      buildMenu();
      createWindow();
    } catch (err) {
      startupLog('startup failed before the window opened', err);
      dialog.showErrorBox(
        'Maestro failed to start',
        `${err instanceof Error ? err.message : String(err)}\n\n` +
          `Details were written to ${path.join(app.getPath('logs'), 'main.log')}.`
      );
      app.quit();
      return;
    }
    // Past the window: the app is usable, so nothing below may take it down.
    // Loopback bridge + `maestro-role`/`maestro-ask` launchers: specialist
    // delegation and asking the user structured questions. Cheap and
    // best-effort; must be up before the first chat send.
    step('startRoleServer', startRoleServer);
    step('installBridgeClis', installBridgeClis);
    step('watchAllActive', watchAllActive);
    // Keeps prState honest while agents merge/close/resolve PRs out-of-band
    // (gh in a run or terminal, GitHub web) — the fs watcher can't see those.
    step('startPrPolling', startPrPolling);
    // Harness chat sync (docs/specs/harness-chat-sync.md): tail Claude Code / Codex
    // transcripts so external turns mirror into Maestro, and (once enabled) surface
    // new sessions in known repos as chats.
    step('startHarnessSync', startHarnessSync);
    // Runs after registerIpc() above, which pulls in chat.ts and so registers
    // the delivery hook the scheduler needs for its boot catch-up of overdue
    // messages. Delivering a scheduled message must never cost the user their
    // window, so it's a step() like every other post-window init.
    step('initScheduler', initScheduler);
    step('initUpdater', initUpdater);
    step('initAnalytics', initAnalytics);
    // Refresh the Codex model catalog from its backend at boot (§6) — but only if
    // codex is installed; don't spawn a binary that isn't there. Throttled + silent
    // inside, so this is fire-and-forget.
    step('refreshCodexCatalog', () =>
      void detectHarnesses().then((infos) => {
        if (infos.find((h) => h.id === 'codex')?.installed) void refreshCodexCatalog();
      })
    );
    // One-time: backfill provisional titles for chats that predate first-message
    // titling or carry a synthetic "Chat N" (§7). Lossless; the KV flag stops a
    // second boot from redoing it.
    step('backfillChatTitles', () => {
      if (Settings.raw('chatTitlesV1')) return;
      backfillChatTitles();
      Settings.setRaw('chatTitlesV1', '1');
    });
    // Cloud continuation catch-up: re-tail journals for turns that ran (or are
    // still running) on the box while the app was closed (§6.3), and resume any
    // locally-persisted queue that a prior quit interrupted. Maestro Web's
    // account sync pulls web-originated sends FIRST (mobile-web §6.6) so replayed
    // turn-start frames already have their user message, then catch-up runs.
    step('accountSync+catchUp', () =>
      void account
        .startAccountSync()
        .catch(() => {})
        .finally(() => void catchUpAll())
    );
    step('bootDrainLocalQueues', bootDrainLocalQueues);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    // Cloud turns keep running on the box — stop tailing, don't kill them. The
    // box's maestro-sync loop keeps mirroring to the relay while we're closed.
    account.stopAccountSync();
    stopAllFollowers();
    stopAllAgents();
    killAllPtys();
    destroyAllPreviews();
    stopRoleServer();
    stopAllDictation();
    disposeAllHosts();
    shutdownAllKernels();
    shutdownAnalytics();
  });
}
