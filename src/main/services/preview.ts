import { WebContentsView, session as electronSessions } from 'electron';
import type { Session } from 'electron';
import { broadcast, getWindow } from '../bus';
import { Projects, Workspaces } from '../db';
import { hostForWorkspace } from '../hosts';
import { capture } from './analytics';
import { toDip } from './zoom';
import type {
  ConsoleEntry,
  ConsoleLevel,
  ElementRef,
  PreviewShot,
  PreviewState,
  Rect,
  Workspace,
} from '../../shared/types';

/**
 * The Preview surface's main-process owner (spec §7): one embedded
 * `WebContentsView` per workspace, positioned by a bounds-sync from the renderer
 * placeholder and driven by *both* the user (toolbar/IPC) and the agent
 * (`maestro-preview` → roleserver `/preview`). The view floats above the DOM, so
 * the renderer hides it whenever an overlay owns the screen.
 *
 * Guest pages are untrusted (an agent-authored app is arbitrary JS): each project
 * gets an isolated `persist:preview:<projectId>` partition with deny-by-default
 * permissions, no preload/IPC bridge, http(s)-only navigation, popups denied, and
 * cert-bypass scoped to localhost. Maestro reaches *in* via CDP / executeJavaScript,
 * never the reverse. The main window's own deny-all-web-content policy is untouched.
 */

interface PreviewSession {
  workspaceId: string;
  projectId: string;
  view: WebContentsView;
  console: ConsoleEntry[];
  errors: number;
  warns: number;
  url: string;
  title: string;
  loading: boolean;
  error: PreviewState['error'];
  agentActive: boolean;
  agentTimer: ReturnType<typeof setTimeout> | null;
  openedByAgent: boolean;
  visible: boolean;
  bounds: Rect | null;
  /** serializes agent commands per workspace (§7 queue) */
  queue: Promise<unknown>;
  lastUsed: number;
  shotN: number;
  consoleN: number;
  cdpAttached: boolean;
  stateTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, PreviewSession>();
/** Partitions whose session handlers are already installed (idempotent guard). */
const configuredPartitions = new Set<string>();
const RING = 500;
const MAX_ENTRY = 2048; // 2 KB serialized per console entry (§11)
const MAX_VIEWS = 4; // LRU cap on live Chromium renderers (§7, §13)
const FULL_HEIGHT_CAP = 8000; // --full capture height cap (§12)
const AGENT_ACTIVE_MS = 2000; // "Agent is testing" chip lingers this long after a command

// ---------- default URL (shared with workspace:openPreview) ----------

/**
 * The workspace's dev-server URL — `http://localhost:<port>` locally, or an SSH
 * `-L` forward to that port on the server for remote workspaces. Identical to what
 * `workspace:openPreview` opened in Safari today (`ipc.ts`), extracted for reuse.
 */
export async function defaultPreviewUrl(ws: Workspace): Promise<string> {
  const host = hostForWorkspace(ws);
  if (host.id !== 'local' && host.forwardOut) {
    const { localPort } = await host.forwardOut(ws.port);
    return `http://127.0.0.1:${localPort}`;
  }
  return `http://localhost:${ws.port}`;
}

// ---------- state broadcasts ----------

function snapshot(s: PreviewSession): PreviewState {
  return {
    workspaceId: s.workspaceId,
    url: s.url,
    title: s.title,
    loading: s.loading,
    canGoBack: !s.view.webContents.isDestroyed() && s.view.webContents.navigationHistory.canGoBack(),
    canGoForward: !s.view.webContents.isDestroyed() && s.view.webContents.navigationHistory.canGoForward(),
    errors: s.errors,
    warns: s.warns,
    agentActive: s.agentActive,
    openedByAgent: s.openedByAgent,
    error: s.error,
  };
}

/** Coalesced state push — nav events fire in bursts and a chatty page can spam
 *  the console, so we debounce to one broadcast per ~80ms. */
function markState(s: PreviewSession) {
  if (s.stateTimer) return;
  s.stateTimer = setTimeout(() => {
    s.stateTimer = null;
    if (!sessions.has(s.workspaceId)) return;
    broadcast('preview:state', snapshot(s));
  }, 80);
}

function pushStateNow(s: PreviewSession) {
  if (s.stateTimer) {
    clearTimeout(s.stateTimer);
    s.stateTimer = null;
  }
  broadcast('preview:state', snapshot(s));
}

// ---------- console capture (CDP) ----------

function remoteObjToStr(o: any): string {
  if (o == null) return '';
  if (o.type === 'string') return String(o.value ?? '');
  if (o.value !== undefined) return typeof o.value === 'object' ? safeJson(o.value) : String(o.value);
  if (o.unserializableValue != null) return String(o.unserializableValue);
  if (o.description != null) return String(o.description);
  if (o.preview?.description) return String(o.preview.description);
  return o.className || o.subtype || o.type || '';
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function levelFromConsoleType(t: string): ConsoleLevel {
  if (t === 'error' || t === 'assert') return 'error';
  if (t === 'warning') return 'warn';
  if (t === 'debug' || t === 'trace') return 'debug';
  if (t === 'info') return 'info';
  return 'log';
}

function levelFromLogLevel(l: string): ConsoleLevel {
  if (l === 'error') return 'error';
  if (l === 'warning') return 'warn';
  if (l === 'verbose') return 'debug';
  return 'info';
}

function pushConsole(s: PreviewSession, entry: ConsoleEntry) {
  entry.text = entry.text.slice(0, MAX_ENTRY);
  s.console.push(entry);
  if (s.console.length > RING) s.console.splice(0, s.console.length - RING);
  if (entry.level === 'error') s.errors++;
  else if (entry.level === 'warn') s.warns++;
  markState(s);
}

function onCdpMessage(s: PreviewSession, method: string, params: any) {
  try {
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args ?? []).map(remoteObjToStr).join(' ');
      const frame = params.stackTrace?.callFrames?.[0];
      pushConsole(s, {
        level: levelFromConsoleType(params.type),
        text,
        ts: Date.now(),
        url: frame?.url || undefined,
        line: frame ? frame.lineNumber + 1 : undefined,
      });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails ?? {};
      const text =
        d.exception?.description || d.text || d.exception?.value || 'Uncaught exception';
      pushConsole(s, {
        level: 'error',
        text: String(text),
        ts: Date.now(),
        url: d.url || d.stackTrace?.callFrames?.[0]?.url || undefined,
        line: d.lineNumber != null ? d.lineNumber + 1 : undefined,
      });
    } else if (method === 'Log.entryAdded') {
      const e = params.entry ?? {};
      pushConsole(s, {
        level: levelFromLogLevel(e.level),
        text: String(e.text ?? ''),
        ts: Date.now(),
        url: e.url || undefined,
        line: e.lineNumber != null ? e.lineNumber + 1 : undefined,
      });
    }
  } catch {
    /* never let a malformed CDP payload throw into the debugger emitter */
  }
}

function attachCdp(s: PreviewSession) {
  const wc = s.view.webContents;
  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch {
    return; // DevTools may hold the target; console capture is best-effort
  }
  s.cdpAttached = true;
  dbg.removeAllListeners('message');
  dbg.on('message', (_e, method, params) => onCdpMessage(s, method, params));
  void dbg.sendCommand('Runtime.enable').catch(() => {});
  void dbg.sendCommand('Log.enable').catch(() => {});
  void dbg.sendCommand('Page.enable').catch(() => {});
}

// ---------- view creation + security ----------

function configureSession(partition: string): Session {
  const sess = electronSessions.fromPartition(partition);
  if (configuredPartitions.has(partition)) return sess;
  configuredPartitions.add(partition);
  // Deny every permission except sanitized clipboard writes (§4). The main
  // window's grant-all handler lives on the DEFAULT session and is untouched —
  // and now never sees third-party content.
  sess.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  sess.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  // Cert errors: auto-bypass for localhost/127.0.0.1 only; everything else uses
  // Chromium's own verdict (→ the error card).
  sess.setCertificateVerifyProc((req, cb) => {
    const local = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(req.hostname);
    cb(local ? 0 : -3);
  });
  // Downloads are cancelled in v1 (§4).
  sess.on('will-download', (e) => e.preventDefault());
  return sess;
}

function wireNavEvents(s: PreviewSession) {
  const wc = s.view.webContents;
  const syncNav = () => {
    if (wc.isDestroyed()) return;
    s.url = wc.getURL();
    s.title = wc.getTitle();
    markState(s);
  };
  wc.on('did-start-loading', () => {
    s.loading = true;
    markState(s);
  });
  wc.on('did-stop-loading', () => {
    s.loading = false;
    syncNav();
  });
  wc.on('did-navigate', (_e, url) => {
    s.error = null;
    s.url = url;
    // A real navigation resets the console badge (matches the drawer's reset, §5.4).
    s.errors = 0;
    s.warns = 0;
    markState(s);
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) {
      s.url = url;
      markState(s);
    }
  });
  wc.on('page-title-updated', (_e, title) => {
    s.title = title;
    markState(s);
  });
  wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
    // -3 (ERR_ABORTED) is a benign duplicate/redirect abort, not a failure.
    if (!isMainFrame || code === -3) return;
    s.loading = false;
    s.error = { code, description: desc, url: validatedURL };
    pushStateNow(s);
  });
  // Popups navigate the same view instead of opening a window (§4).
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!/^https?:/i.test(url)) e.preventDefault();
  });
  // Leaving a page with a beforeunload handler is auto-allowed (§12).
  wc.on('will-prevent-unload', (e) => e.preventDefault());
  // If DevTools detaches our CDP client, re-attach console capture on close.
  wc.on('devtools-closed', () => attachCdp(s));
}

function createSession(ws: Workspace, byAgent: boolean): PreviewSession {
  const partition = `persist:preview:${ws.projectId}`;
  const sess = configureSession(partition);
  const view = new WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      // No preload — the guest page gets no bridge at all (§4).
    },
  });
  view.setBackgroundColor('#ffffff');
  // A default size so an agent can `screenshot` before the user ever opens the
  // surface (capturePage needs a non-zero canvas). Real bounds sync in on open.
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  view.setVisible(false);
  const win = getWindow();
  win?.contentView.addChildView(view);

  const s: PreviewSession = {
    workspaceId: ws.id,
    projectId: ws.projectId,
    view,
    console: [],
    errors: 0,
    warns: 0,
    url: '',
    title: '',
    loading: false,
    error: null,
    agentActive: false,
    agentTimer: null,
    openedByAgent: byAgent,
    visible: false,
    bounds: null,
    queue: Promise.resolve(),
    lastUsed: Date.now(),
    shotN: 0,
    consoleN: 0,
    cdpAttached: false,
    stateTimer: null,
  };
  sessions.set(ws.id, s);
  attachCdp(s);
  wireNavEvents(s);
  capture('preview_opened');
  evictLru(ws.id);
  return s;
}

/** LRU cap: destroy the least-recently-used *other* view once we exceed MAX_VIEWS. */
function evictLru(keepId: string) {
  while (sessions.size > MAX_VIEWS) {
    let victim: PreviewSession | null = null;
    for (const s of sessions.values()) {
      if (s.workspaceId === keepId) continue;
      if (!victim || s.lastUsed < victim.lastUsed) victim = s;
    }
    if (!victim) break;
    destroyPreview(victim.workspaceId);
  }
}

function ensureSession(ws: Workspace, byAgent: boolean): PreviewSession {
  const existing = sessions.get(ws.id);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  return createSession(ws, byAgent);
}

// ---------- navigation ----------

/** Load a URL and resolve when it settles (load, fail, or 15 s). */
function waitForSettle(s: PreviewSession, timeoutMs: number): Promise<void> {
  const wc = s.view.webContents;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wc.off('did-stop-loading', finish);
      wc.off('did-fail-load', onFail);
      resolve();
    };
    const onFail = (_e: unknown, _c: number, _d: string, _u: string, isMain: boolean) => {
      if (isMain) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    wc.once('did-stop-loading', finish);
    wc.once('did-fail-load', onFail as never);
  });
}

async function navigate(
  s: PreviewSession,
  action: 'goto' | 'back' | 'forward' | 'reload' | 'stop',
  url?: string
): Promise<void> {
  const wc = s.view.webContents;
  const nav = wc.navigationHistory;
  if (action === 'goto' && url) {
    s.error = null;
    await wc.loadURL(url).catch(() => {}); // failures surface via did-fail-load
  } else if (action === 'back' && nav.canGoBack()) nav.goBack();
  else if (action === 'forward' && nav.canGoForward()) nav.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'stop') wc.stop();
}

// ---------- capture ----------

async function dpr(s: PreviewSession): Promise<number> {
  try {
    const v = await s.view.webContents.executeJavaScript('window.devicePixelRatio', true);
    return Number(v) || 1;
  } catch {
    return 1;
  }
}

async function captureShot(s: PreviewSession, fullPage: boolean): Promise<PreviewShot> {
  const wc = s.view.webContents;
  const ratio = await dpr(s);
  if (fullPage && s.cdpAttached) {
    const metrics = await wc.debugger.sendCommand('Page.getLayoutMetrics');
    const content = metrics.cssContentSize ?? metrics.contentSize ?? { width: 1280, height: 800 };
    const width = Math.max(1, Math.ceil(content.width));
    const height = Math.min(FULL_HEIGHT_CAP, Math.max(1, Math.ceil(content.height)));
    const res = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return { dataUrl: `data:image/png;base64,${res.data}`, width, height, dpr: ratio };
  }
  // Viewport capture works even while the surface is hidden or another mode is
  // active (`stayHidden`), so an agent can screenshot without the user watching.
  const img = await wc.capturePage(undefined, { stayHidden: true });
  const size = img.getSize();
  return { dataUrl: img.toDataURL(), width: size.width, height: size.height, dpr: ratio };
}

// ---------- layout index (§9.1) ----------

// In-page pass: visible elements → { selector, tag, text, rect }, each selector
// verified unique via querySelectorAll(...).length === 1. Runs in the guest page.
const LAYOUT_INDEX_JS = `(() => {
  const MAX = 1500;
  const out = [];
  const seen = new Set();
  const esc = (s) => { try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); } catch (e) { return String(s); } };
  const ident = (s) => /^[A-Za-z_][\\w-]*$/.test(s);
  function step(node) {
    let sel = node.tagName.toLowerCase();
    const cls = (node.getAttribute('class') || '').trim().split(/\\s+/).filter((c) => c && ident(c)).slice(0, 2);
    for (const c of cls) sel += '.' + esc(c);
    const parent = node.parentElement;
    if (parent) {
      const same = Array.prototype.filter.call(parent.children, (ch) => ch.tagName === node.tagName);
      if (same.length > 1) sel += ':nth-of-type(' + (Array.prototype.indexOf.call(parent.children, node) + 1) + ')';
    }
    return sel;
  }
  function uniqueSel(el) {
    if (el.id && ident(el.id)) { const s = '#' + esc(el.id); if (document.querySelectorAll(s).length === 1) return s; }
    const tid = el.getAttribute && el.getAttribute('data-testid');
    if (tid) { const s = '[data-testid="' + tid.replace(/["\\\\]/g, '\\\\$&') + '"]'; if (document.querySelectorAll(s).length === 1) return s; }
    let parts = [step(el)];
    let node = el;
    for (let i = 0; i < 4; i++) {
      const full = parts.join(' > ');
      if (document.querySelectorAll(full).length === 1) return full;
      node = node.parentElement;
      if (!node || node === document.documentElement) break;
      parts.unshift(step(node));
    }
    const full = parts.join(' > ');
    return document.querySelectorAll(full).length === 1 ? full : null;
  }
  const nodes = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of nodes) {
    if (out.length >= MAX) break;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    const sel = uniqueSel(el);
    if (!sel || seen.has(sel)) continue;
    seen.add(sel);
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    out.push({ selector: sel, tag: el.tagName.toLowerCase(), text, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  }
  return out;
})()`;

async function layoutIndex(s: PreviewSession): Promise<ElementRef[]> {
  try {
    const items = await s.view.webContents.executeJavaScript(LAYOUT_INDEX_JS, true);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

// ---------- visibility + bounds ----------

export function setPreviewBounds(workspaceId: string, bounds: Rect): void {
  const s = sessions.get(workspaceId);
  if (!s || s.view.webContents.isDestroyed()) return;
  s.bounds = bounds;
  // The renderer measures in CSS px; a WebContentsView is a sibling of the page,
  // not part of it, so it is placed in DIP — the two agree only at 100% zoom.
  // The preview's own content stays unzoomed on purpose: it's the user's site as
  // a browser would render it, not app chrome.
  s.view.setBounds({
    x: Math.round(toDip(bounds.x)),
    y: Math.round(toDip(bounds.y)),
    width: Math.max(0, Math.round(toDip(bounds.width))),
    height: Math.max(0, Math.round(toDip(bounds.height))),
  });
}

export function setPreviewVisible(workspaceId: string, visible: boolean): void {
  const s = sessions.get(workspaceId);
  if (!s || s.view.webContents.isDestroyed()) return;
  s.visible = visible;
  s.view.setVisible(visible);
  s.view.webContents.setBackgroundThrottling(!visible);
  if (visible) {
    if (s.bounds) setPreviewBounds(workspaceId, s.bounds);
    // The user is now looking — clear the "opened by agent" nudge.
    if (s.openedByAgent) {
      s.openedByAgent = false;
      markState(s);
    }
    s.lastUsed = Date.now();
  }
}

// ---------- lifecycle ----------

/** Open (creating if needed) a workspace's preview and navigate it. User-initiated
 *  (`preview:open`), so it clears the agent-nudge. */
export async function openPreview(workspaceId: string, url?: string): Promise<{ url: string; error?: string }> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return { url: '', error: 'Workspace not found' };
  const existed = sessions.has(workspaceId);
  const s = ensureSession(ws, false);
  s.openedByAgent = false;
  let target = url;
  if (!target) {
    // Reuse the last URL if the view already had one; else compute the default.
    target = s.url || (await defaultPreviewUrl(ws).catch(() => `http://localhost:${ws.port}`));
  }
  if (!existed || url || !s.url) {
    await navigate(s, 'goto', target);
  }
  markState(s);
  return { url: target };
}

export function closePreview(workspaceId: string): void {
  destroyPreview(workspaceId);
}

/** Tear a view down: detach CDP, remove from the window, destroy the webContents,
 *  drop the ring buffer. Reopening recreates it at its last URL (held in the store). */
export function destroyPreview(workspaceId: string): void {
  const s = sessions.get(workspaceId);
  if (!s) return;
  sessions.delete(workspaceId);
  if (s.agentTimer) clearTimeout(s.agentTimer);
  if (s.stateTimer) clearTimeout(s.stateTimer);
  const wc = s.view.webContents;
  try {
    if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
  } catch {}
  try {
    getWindow()?.contentView.removeChildView(s.view);
  } catch {}
  try {
    if (!wc.isDestroyed()) wc.close();
  } catch {}
}

export function destroyAllPreviews(): void {
  for (const id of [...sessions.keys()]) destroyPreview(id);
}

export function openPreviewDevtools(workspaceId: string): void {
  const s = sessions.get(workspaceId);
  if (!s || s.view.webContents.isDestroyed()) return;
  const wc = s.view.webContents;
  // v1 opens DevTools detached — an explicit escape hatch (§3 non-goals). DevTools
  // and our CDP client can't both own the target, so release it while open.
  try {
    if (wc.debugger.isAttached()) {
      s.cdpAttached = false;
      wc.debugger.detach();
    }
  } catch {}
  wc.openDevTools({ mode: 'detach' });
}

// ---------- console read ----------

export function getConsole(
  workspaceId: string,
  level?: ConsoleLevel | 'all',
  clear?: boolean
): ConsoleEntry[] {
  const s = sessions.get(workspaceId);
  if (!s) return [];
  const filtered = !level || level === 'all' ? s.console : s.console.filter((e) => e.level === level);
  const out = filtered.slice();
  if (clear) {
    s.console = [];
    s.errors = 0;
    s.warns = 0;
    markState(s);
  }
  return out;
}

/** Write the current (filtered) console buffer to `.context/preview/console-<n>.log`
 *  (host-aware) so the drawer's "send to agent" can stage it as a `log` attachment
 *  — reusing the existing prompt plumbing (§5.4). */
export async function writeConsoleLog(
  workspaceId: string,
  level?: ConsoleLevel | 'all'
): Promise<{ path: string; count: number }> {
  const ws = Workspaces.get(workspaceId);
  const s = sessions.get(workspaceId);
  if (!ws || !s) return { path: '', count: 0 };
  const entries = getConsole(workspaceId, level, false);
  const host = hostForWorkspace(ws);
  const rel = `.context/preview/console-${++s.consoleN}.log`;
  const abs = host.path.join(ws.worktreePath, ...rel.split('/'));
  await host.fs.mkdirp(host.path.dirname(abs));
  const body = (entries.length ? entries.map(fmtConsole).join('\n') : 'No console entries.') + '\n';
  await host.fs.write(abs, body);
  return { path: rel, count: entries.length };
}

// ---------- IPC-facing capture / elements ----------

export async function capturePreview(workspaceId: string, fullPage?: boolean): Promise<PreviewShot> {
  const s = sessions.get(workspaceId);
  if (!s || s.view.webContents.isDestroyed()) throw new Error('No live preview to capture');
  s.lastUsed = Date.now();
  return captureShot(s, !!fullPage);
}

export async function previewElements(workspaceId: string): Promise<ElementRef[]> {
  const s = sessions.get(workspaceId);
  if (!s || s.view.webContents.isDestroyed()) return [];
  return layoutIndex(s);
}

export async function navigatePreview(
  workspaceId: string,
  action: 'goto' | 'back' | 'forward' | 'reload' | 'stop',
  url?: string
): Promise<void> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return;
  const s = ensureSession(ws, false);
  await navigate(s, action, url);
  markState(s);
}

// ---------- agent bridge command runner (§8) ----------

interface PreviewCliResult {
  ok: boolean;
  text: string;
}

/** Entry point the roleserver `/preview` route calls. Serializes per workspace so
 *  the agent's own commands never race each other, and animates the "Agent is
 *  testing" chip. `goto`/`status`/… auto-create the view (agent can test before
 *  the user ever opens the surface — the toggle gets the activity dot). */
export function runPreviewCommand(
  workspaceId: string,
  agentId: number,
  argv: string[]
): Promise<PreviewCliResult> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return Promise.resolve({ ok: false, text: 'preview: unknown workspace' });
  const s = ensureSession(ws, true);
  const run = s.queue.then(() => execCommand(s, ws, agentId, argv));
  // keep the chain alive even if one command throws
  s.queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function markAgentActive(s: PreviewSession) {
  s.agentActive = true;
  if (s.agentTimer) clearTimeout(s.agentTimer);
  pushStateNow(s);
  s.agentTimer = setTimeout(() => {
    s.agentTimer = null;
    s.agentActive = false;
    if (sessions.has(s.workspaceId)) pushStateNow(s);
  }, AGENT_ACTIVE_MS);
}

async function execCommand(
  s: PreviewSession,
  ws: Workspace,
  agentId: number,
  argv: string[]
): Promise<PreviewCliResult> {
  s.lastUsed = Date.now();
  const cmd = (argv[0] || 'status').toLowerCase();
  const rest = argv.slice(1);
  capture('preview_agent_command', { command: cmd });
  if (cmd !== 'help') markAgentActive(s);
  try {
    switch (cmd) {
      case 'help':
        return { ok: true, text: HELP_TEXT };
      case 'status':
        return { ok: true, text: statusText(s) };
      case 'goto': {
        const url = rest[0];
        if (!url) return { ok: false, text: 'usage: maestro-preview goto <url>' };
        if (!/^https?:\/\//i.test(url)) return { ok: false, text: 'goto: only http(s) URLs are allowed' };
        await navigate(s, 'goto', url);
        await waitForSettle(s, 15_000);
        markState(s);
        return { ok: !s.error, text: s.error ? `Navigation error: ${s.error.description} (${s.error.url})` : statusText(s) };
      }
      case 'back':
      case 'forward':
      case 'reload': {
        await navigate(s, cmd, undefined);
        await waitForSettle(s, 15_000);
        markState(s);
        return { ok: true, text: statusText(s) };
      }
      case 'screenshot': {
        const full = hasFlag(rest, '--full');
        const outFlag = flagValue(rest, '--out');
        const shot = await captureShot(s, full);
        const { relPath, abs, note } = await writeShot(ws, s, shot, outFlag);
        return {
          ok: true,
          text: `Saved: ${relPath} (${shot.width}×${shot.height}${note}). Read this file to view it.${
            abs && abs !== relPath ? `\nAbsolute: ${abs}` : ''
          }`,
        };
      }
      case 'console': {
        const lvl = (flagValue(rest, '--level') as ConsoleLevel | 'all' | undefined) ?? 'all';
        const limit = Number(flagValue(rest, '--limit')) || 100;
        const clear = hasFlag(rest, '--clear');
        const entries = getConsole(s.workspaceId, lvl, clear);
        const tail = entries.slice(-limit);
        if (!tail.length) return { ok: true, text: clear ? 'Console cleared.' : 'No console entries.' };
        return { ok: true, text: tail.map(fmtConsole).join('\n') };
      }
      case 'click': {
        const target = rest[0];
        if (!target) return { ok: false, text: 'usage: maestro-preview click <selector | x,y>' };
        const pt = await resolvePoint(s, target);
        if (!pt) return { ok: false, text: `click: no element matched ${target}` };
        await dispatchClick(s, pt.x, pt.y);
        await sleep(150);
        markState(s);
        return { ok: true, text: `Clicked (${Math.round(pt.x)}, ${Math.round(pt.y)}) — ${statusText(s)}` };
      }
      case 'type': {
        const sel = flagValue(rest, '--selector');
        const text = rest.filter((a) => a !== '--selector' && a !== sel).join(' ');
        if (!text) return { ok: false, text: 'usage: maestro-preview type <text> [--selector <s>]' };
        if (sel) {
          const focused = await focusSelector(s, sel);
          if (!focused) return { ok: false, text: `type: no element matched ${sel}` };
        }
        await s.view.webContents.debugger.sendCommand('Input.insertText', { text });
        return { ok: true, text: `Typed ${text.length} char${text.length === 1 ? '' : 's'}.` };
      }
      case 'press': {
        const key = rest[0];
        if (!key) return { ok: false, text: 'usage: maestro-preview press <key>' };
        const ok = await dispatchKey(s, key);
        if (!ok) return { ok: false, text: `press: unknown key "${key}"` };
        await sleep(80);
        return { ok: true, text: `Pressed ${key}.` };
      }
      case 'scroll': {
        const toSel = flagValue(rest, '--to');
        const y = flagValue(rest, '--y');
        if (toSel) {
          const ok = await s.view.webContents.executeJavaScript(
            `(() => { const el = document.querySelector(${JSON.stringify(toSel)}); if (!el) return false; el.scrollIntoView({behavior:'instant',block:'center'}); return true; })()`,
            true
          );
          return ok ? { ok: true, text: `Scrolled to ${toSel}.` } : { ok: false, text: `scroll: no element matched ${toSel}` };
        }
        if (y != null) {
          await s.view.webContents.executeJavaScript(`window.scrollTo(0, ${Number(y) || 0})`, true);
          return { ok: true, text: `Scrolled to y=${Number(y) || 0}.` };
        }
        return { ok: false, text: 'usage: maestro-preview scroll [--to <selector> | --y <px>]' };
      }
      case 'wait': {
        const sel = rest.find((a) => !a.startsWith('--'));
        if (!sel) return { ok: false, text: 'usage: maestro-preview wait <selector> [--timeout <ms>]' };
        const timeout = Number(flagValue(rest, '--timeout')) || 10_000;
        const ok = await waitForSelector(s, sel, timeout);
        return ok ? { ok: true, text: `Found ${sel}.` } : { ok: false, text: `wait: ${sel} not visible after ${timeout}ms` };
      }
      case 'eval': {
        const js = rest.join(' ');
        if (!js) return { ok: false, text: 'usage: maestro-preview eval <js>' };
        try {
          const result = await s.view.webContents.executeJavaScript(
            `(async () => { return (${js}); })()`,
            true
          );
          const text = typeof result === 'string' ? result : safeJson(result);
          return { ok: true, text: (text ?? 'undefined').slice(0, 16_384) };
        } catch (e: any) {
          return { ok: false, text: `eval error: ${String(e?.message ?? e)}` };
        }
      }
      default:
        return { ok: false, text: `Unknown command "${cmd}". Run \`maestro-preview help\`.` };
    }
  } catch (e: any) {
    return { ok: false, text: `preview ${cmd} failed: ${String(e?.message ?? e)}` };
  }
}

// ---------- command helpers ----------

function statusText(s: PreviewSession): string {
  const load = s.loading ? 'loading' : s.error ? `error: ${s.error.description}` : 'loaded';
  return `URL: ${s.url || '(none)'}\nTitle: ${s.title || '(none)'}\nState: ${load}\nConsole: ${s.errors} error(s), ${s.warns} warning(s)`;
}

function fmtConsole(e: ConsoleEntry): string {
  const t = new Date(e.ts).toTimeString().slice(0, 8);
  const loc = e.url ? ` ${shortUrl(e.url)}${e.line ? ':' + e.line : ''}` : '';
  return `[${e.level}] ${t}${loc} ${e.text}`.slice(0, MAX_ENTRY);
}

function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.pathname.split('/').pop() || url.pathname || u;
  } catch {
    return u;
  }
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve a click target — "x,y" or a selector (scrolled into view) → CSS-px point. */
async function resolvePoint(s: PreviewSession, target: string): Promise<{ x: number; y: number } | null> {
  const m = target.match(/^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) return { x: Number(m[1]), y: Number(m[2]) };
  return s.view.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) return null; el.scrollIntoView({behavior:'instant',block:'center',inline:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
    true
  );
}

async function focusSelector(s: PreviewSession, selector: string): Promise<boolean> {
  return s.view.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if (el.select) try { el.select(); } catch(e){} return true; })()`,
    true
  );
}

async function waitForSelector(s: PreviewSession, selector: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const probe = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; })()`;
  for (;;) {
    const ok = await s.view.webContents.executeJavaScript(probe, true).catch(() => false);
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

async function dispatchClick(s: PreviewSession, x: number, y: number): Promise<void> {
  const dbg = s.view.webContents.debugger;
  const base = { x, y, button: 'left' as const };
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount: 1, buttons: 1 });
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount: 1, buttons: 0 });
}

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
};

async function dispatchKey(s: PreviewSession, keyName: string): Promise<boolean> {
  const k = KEYS[keyName.toLowerCase()];
  if (!k) return false;
  const dbg = s.view.webContents.debugger;
  await dbg.sendCommand('Input.dispatchKeyEvent', {
    type: k.text ? 'keyDown' : 'rawKeyDown',
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk,
    ...(k.text ? { text: k.text } : {}),
  });
  await dbg.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk,
  });
  return true;
}

/** Write a screenshot into the worktree's `.context/preview/` (host-aware, so it
 *  lands in remote worktrees too) and return its worktree-relative path. */
async function writeShot(
  ws: Workspace,
  s: PreviewSession,
  shot: PreviewShot,
  outFlag?: string
): Promise<{ relPath: string; abs: string; note: string }> {
  const host = hostForWorkspace(ws);
  const b64 = shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1);
  const buf = Buffer.from(b64, 'base64');
  const rel = outFlag ? sanitizeRel(outFlag) : `.context/preview/shot-${++s.shotN}.png`;
  const abs = host.path.join(ws.worktreePath, ...rel.split('/'));
  await host.fs.mkdirp(host.path.dirname(abs));
  await host.fs.write(abs, buf);
  const note = shot.height >= FULL_HEIGHT_CAP ? `, height-capped at ${FULL_HEIGHT_CAP}px` : '';
  return { relPath: rel, abs, note };
}

/** Confine a user-supplied `--out` to a relative path under the worktree. */
function sanitizeRel(p: string): string {
  const cleaned = p.replace(/^[/\\]+/, '').replace(/\.\.(?:[/\\]|$)/g, '');
  return cleaned || '.context/preview/shot.png';
}

const HELP_TEXT = [
  'maestro-preview — drive the embedded browser pane the user watches.',
  '',
  '  status                              URL, title, load state, console counts',
  '  goto <url>                          navigate (http/https), wait for load',
  '  back | forward | reload             history / reload',
  '  screenshot [--full] [--out <path>]  capture → .context/preview/shot-N.png (read the file)',
  '  console [--level error|warn|all] [--limit N] [--clear]',
  '  click <selector | x,y>              click an element (or coordinates)',
  '  type <text> [--selector <s>]        insert text (optionally focus a field first)',
  '  press <key>                         Enter, Tab, Escape, ArrowUp/Down/Left/Right, …',
  '  scroll [--to <selector> | --y <px>] scroll the page/element',
  '  wait <selector> [--timeout <ms>]    poll until present & visible',
  '  eval <js>                           run JS in the page, print the JSON result',
].join('\n');
