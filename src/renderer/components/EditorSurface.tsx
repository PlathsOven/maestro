import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileWarning,
  Pencil,
  Save,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { basename, renderMarkdown } from '../lib/format';
import { useZoomableImage, IMG_ZOOM_MIN, IMG_ZOOM_MAX, IMG_ZOOM_STEP } from '../lib/useZoomableImage';
import { EMPTY_ARR, useApp } from '../store/app';
import { Modal, Spinner, useDismiss } from './common';
import { MenuItem } from './Sidebar';
import { fileGlyph } from './RightPanel';
import { monaco, monacoLanguage, applyEditorTheme, ensureEditorTheme } from '../lib/monaco';
import {
  disposeBuffer,
  disposeWorkspaceBuffers,
  getBuffer,
  setBuffer,
  type TextBuffer,
} from '../lib/editorBuffers';
import { registerBufferEvictor } from '../lib/editorEvictor';
import { parseNotebook, serializeNotebook } from '../lib/nbformat';
import NotebookEditor from './NotebookEditor';
import { matchesShortcut } from '../../shared/shortcuts';
import { useShortcuts } from '../lib/shortcuts';
import type { Workspace } from '../../shared/types';

// Free a workspace's buffers when it's archived/removed (spec §6). Registered at
// chunk-load, so it's a no-op until the editor has actually been opened.
registerBufferEvictor(disposeWorkspaceBuffers);

/** What the center pane shows for one open file. The heavy data (Monaco model /
 *  notebook doc) lives in the module-level buffer cache; this only records the
 *  routing decision + any inline notice. */
type FileView =
  | { kind: 'loading' }
  | { kind: 'text'; language: string; notice?: string }
  | { kind: 'notebook' }
  | { kind: 'image'; dataUrl: string; name: string }
  | { kind: 'binary'; name: string; size?: number; error?: string };

type Banner = 'conflict' | 'deleted';

const EMPTY_OBJ: Record<string, boolean> = {};

export default function EditorSurface({ workspace, active }: { workspace: Workspace; active: boolean }) {
  const wsId = workspace.id;
  const keys = useShortcuts();
  const platform = useApp((s) => s.platform);
  const openFiles = useApp((s) => s.openFiles[wsId] ?? EMPTY_ARR);
  const activeFile = useApp((s) => s.activeFile[wsId] ?? null);
  const dirtyMap = useApp((s) => s.dirtyFiles[wsId]) ?? EMPTY_OBJ;
  const wsVersion = useApp((s) => s.wsVersion[wsId] ?? 0);
  const theme = useApp((s) => s.resolvedTheme);
  const closeNonce = useApp((s) => s.closeActiveFileNonce); // ⌘W from the menu (see effect below)

  const [views, setViews] = useState<Record<string, FileView>>({});
  const [banners, setBanners] = useState<Record<string, Banner>>({});
  const [nbNonce, setNbNonce] = useState<Record<string, number>>({});
  const [mdMode, setMdMode] = useState<Record<string, 'preview' | 'edit'>>({}); // markdown: default preview
  const [closePrompt, setClosePrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Refs mirror the latest committed values so async callbacks (reads, saves,
  // watcher reloads) never fire on a stale closure.
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const bannersRef = useRef(banners);
  bannersRef.current = banners;
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const forceRef = useRef(new Set<string>()); // paths armed for a forced (Keep-mine) save
  const suppressRef = useRef(new Set<string>()); // paths under a programmatic (reload) edit
  const loadingRef = useRef(new Set<string>()); // reads in flight (de-dupe)

  const setView = useCallback((path: string, v: FileView) => setViews((p) => ({ ...p, [path]: v })), []);
  const removeView = useCallback(
    (path: string) =>
      setViews((p) => {
        if (!(path in p)) return p;
        const n = { ...p };
        delete n[path];
        return n;
      }),
    []
  );
  const setBanner = useCallback((path: string, b: Banner) => setBanners((p) => ({ ...p, [path]: b })), []);
  const clearBanner = useCallback(
    (path: string) =>
      setBanners((p) => {
        if (!(path in p)) return p;
        const n = { ...p };
        delete n[path];
        return n;
      }),
    []
  );
  const bumpNb = useCallback((path: string) => setNbNonce((p) => ({ ...p, [path]: (p[path] ?? 0) + 1 })), []);
  const markNotebookDirty = useCallback(
    (path: string) => {
      const buf = getBuffer(wsId, path);
      if (buf?.kind === 'notebook') {
        buf.dirty = true;
        useApp.getState().setFileDirty(wsId, path, true);
      }
    },
    [wsId]
  );

  // ---- theme: define + apply on mount and whenever the app theme flips ----
  useEffect(() => {
    applyEditorTheme(theme);
  }, [theme]);

  // ---- create / replace a text model in the buffer cache ----
  const installTextBuffer = useCallback(
    (path: string, text: string, mtimeMs: number) => {
      const existing = getBuffer(wsId, path);
      if (existing?.kind === 'text') {
        // Reload in place: full-range replace preserves cursor + undo history.
        const model = existing.model;
        suppressRef.current.add(path);
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
        suppressRef.current.delete(path);
        existing.savedVersionId = model.getAlternativeVersionId();
        existing.baseMtime = mtimeMs;
        useApp.getState().setFileDirty(wsId, path, false);
        return;
      }
      const uri = monaco.Uri.file(`/maestro/${wsId}/${path}`);
      monaco.editor.getModel(uri)?.dispose(); // defensive: reclaim a lingering URI
      const model = monaco.editor.createModel(text, monacoLanguage(path), uri);
      // Preserve the file's detected EOL — no normalization on save (spec §5.4).
      model.setEOL(text.includes('\r\n') ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      const buf: TextBuffer = {
        kind: 'text',
        model,
        viewState: null,
        savedVersionId: model.getAlternativeVersionId(),
        baseMtime: mtimeMs,
      };
      setBuffer(wsId, path, buf);
      model.onDidChangeContent(() => {
        if (suppressRef.current.has(path)) return;
        const b = getBuffer(wsId, path);
        if (b?.kind === 'text') {
          useApp.getState().setFileDirty(wsId, path, b.model.getAlternativeVersionId() !== b.savedVersionId);
        }
      });
      useApp.getState().setFileDirty(wsId, path, false);
    },
    [wsId]
  );

  // ---- read a file from disk and route it to the right surface ----
  const loadFile = useCallback(
    async (path: string, reload = false) => {
      if (!reload) {
        // A cached buffer (survived a mode/tab switch) needs no re-read.
        const cached = getBuffer(wsId, path);
        if (cached) {
          setView(path, cached.kind === 'notebook' ? { kind: 'notebook' } : { kind: 'text', language: monacoLanguage(path) });
          return;
        }
        if (loadingRef.current.has(path)) return;
      }
      loadingRef.current.add(path);
      const { data, error } = await tryInvoke('fs:read', { workspaceId: wsId, path });
      loadingRef.current.delete(path);
      if (error || !data) {
        if (error) setView(path, { kind: 'binary', name: basename(path), error });
        return;
      }
      if (data.kind === 'image') {
        setView(path, { kind: 'image', dataUrl: data.dataUrl, name: data.name });
        clearBanner(path);
        return;
      }
      if (data.kind === 'binary') {
        setView(path, { kind: 'binary', name: data.name, size: data.size, error: data.error });
        return;
      }
      // text
      if (path.toLowerCase().endsWith('.ipynb')) {
        const doc = parseNotebook(data.text);
        if (doc) {
          // If a prior (invalid-JSON) load left a text model here, reclaim it.
          const prev = getBuffer(wsId, path);
          if (prev?.kind === 'text') prev.model.dispose();
          setBuffer(wsId, path, { kind: 'notebook', doc, dirty: false, baseMtime: data.mtimeMs });
          setView(path, { kind: 'notebook' });
          useApp.getState().setFileDirty(wsId, path, false);
          clearBanner(path);
          if (reload) bumpNb(path);
          return;
        }
        // Not valid JSON → raw JSON Monaco + a notice bar.
        installTextBuffer(path, data.text, data.mtimeMs);
        setView(path, { kind: 'text', language: 'json', notice: "Couldn't parse this as a notebook — showing raw JSON." });
        clearBanner(path);
        return;
      }
      installTextBuffer(path, data.text, data.mtimeMs);
      setView(path, { kind: 'text', language: monacoLanguage(path) });
      clearBanner(path);
    },
    [wsId, setView, clearBanner, bumpNb, installTextBuffer]
  );

  // ---- save (⌘S / toolbar) ----
  const save = useCallback(
    async (path: string): Promise<'saved' | 'conflict' | 'noop' | 'error'> => {
      const buf = getBuffer(wsId, path);
      if (!buf) return 'noop';
      const force = forceRef.current.has(path);
      const banner = bannersRef.current[path];
      let text: string;
      let dirtyNow: boolean;
      if (buf.kind === 'text') {
        dirtyNow = buf.model.getAlternativeVersionId() !== buf.savedVersionId;
        text = buf.model.getValue();
      } else {
        dirtyNow = buf.dirty;
        text = serializeNotebook(buf.doc);
      }
      // Clean + not forced + not recreating a deleted file ⇒ nothing to write
      // (keeps unedited notebooks from being gratuitously rewritten).
      if (!dirtyNow && !force && banner !== 'deleted') return 'noop';
      const { data, error } = await tryInvoke('fs:write', {
        workspaceId: wsId,
        path,
        text,
        expectedMtimeMs: buf.baseMtime,
        force,
      });
      if (error) {
        useApp.getState().toast('error', `Save failed: ${error}`);
        return 'error';
      }
      if (data && !data.ok) {
        setBanner(path, 'conflict'); // caught server-side: agent wrote between sync and save
        return 'conflict';
      }
      buf.baseMtime = data!.mtimeMs;
      forceRef.current.delete(path);
      if (buf.kind === 'text') buf.savedVersionId = buf.model.getAlternativeVersionId();
      else buf.dirty = false;
      useApp.getState().setFileDirty(wsId, path, false);
      clearBanner(path);
      return 'saved';
    },
    [wsId, setBanner, clearBanner]
  );

  // ---- watcher-driven live reload (stat-gated) ----
  const reloadIfChanged = useCallback(
    async (path: string) => {
      const buf = getBuffer(wsId, path);
      if (!buf) return;
      const { data: st, error } = await tryInvoke('fs:stat', { workspaceId: wsId, path });
      if (error) return;
      if (!st) {
        setBanner(path, 'deleted'); // gone on disk — keep content, saving recreates
        return;
      }
      if (st.mtimeMs === buf.baseMtime) return; // unchanged
      const dirty = buf.kind === 'text' ? buf.model.getAlternativeVersionId() !== buf.savedVersionId : buf.dirty;
      if (dirty) {
        setBanner(path, 'conflict'); // never clobber the user's edits
        return;
      }
      await loadFile(path, true); // clean buffer follows the file
    },
    [wsId, setBanner, loadFile]
  );

  // Reconcile open files: load newly-opened ones, evict closed ones.
  useEffect(() => {
    for (const path of openFiles) {
      if (!viewsRef.current[path] && !loadingRef.current.has(path)) void loadFile(path);
    }
    for (const path of Object.keys(viewsRef.current)) {
      if (!openFiles.includes(path)) {
        disposeBuffer(wsId, path);
        removeView(path);
        clearBanner(path);
      }
    }
  }, [openFiles, wsId, loadFile, removeView, clearBanner]);

  // On every watcher tick (debounced 800ms in main), re-check each open buffer.
  useEffect(() => {
    for (const path of openFilesRef.current) void reloadIfChanged(path);
  }, [wsVersion, reloadIfChanged]);

  // Save shortcut (⌘S by default) for the active buffer (text or notebook).
  // Capture-phase so it beats Monaco and there's no OS "save" beep. §9.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, keys['editor.save'], platform)) {
        e.preventDefault();
        const p = useApp.getState().activeFile[wsId];
        if (p) void save(p);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, wsId, save, keys, platform]);

  // ---- close (with dirty guard) ----
  const requestClose = useCallback(
    (path: string) => {
      if (useApp.getState().dirtyFiles[wsId]?.[path]) setClosePrompt(path);
      else useApp.getState().closeFile(wsId, path);
    },
    [wsId]
  );

  // ⌘W arrives via the app menu (which swallows the keydown, so we can't listen
  // for the key here like ⌘S). App.tsx bumps closeActiveFileNonce when Editor is
  // the active surface; only the visible editor (active) reacts, closing its
  // active tab through the same dirty-guard the ✕ button uses. A ref skips the
  // initial mount value so nothing closes just because the surface rendered.
  const closeNonceRef = useRef(closeNonce);
  useEffect(() => {
    if (closeNonce === closeNonceRef.current) return;
    closeNonceRef.current = closeNonce;
    if (!active) return;
    const p = useApp.getState().activeFile[wsId];
    if (p) requestClose(p);
  }, [closeNonce, active, wsId, requestClose]);

  const dupBasenames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of openFiles) counts.set(basename(p), (counts.get(basename(p)) ?? 0) + 1);
    return counts;
  }, [openFiles]);

  const activeView = activeFile ? views[activeFile] : undefined;
  const isMarkdown = activeView?.kind === 'text' && activeView.language === 'markdown';
  const mdPreview = isMarkdown && activeFile ? (mdMode[activeFile] ?? 'preview') === 'preview' : false;
  // Monaco shows for any text file *except* a markdown tab in preview mode.
  const activeTextPath = activeView?.kind === 'text' && !mdPreview ? activeFile : null;
  const activeBuffer = activeFile ? getBuffer(wsId, activeFile) : undefined;
  const activeDirty = !!(activeFile && dirtyMap[activeFile]);
  const activeBanner = activeFile ? banners[activeFile] : undefined;

  const copyPath = () => {
    if (!activeFile) return;
    void navigator.clipboard?.writeText(activeFile);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {/* tab strip */}
      <div className="flex shrink-0 items-stretch overflow-x-auto border-b bg-surface">
        {openFiles.map((path) => {
          const dup = dupBasenames.get(basename(path))! > 1;
          const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/').pop() : null;
          return (
            <div
              key={path}
              className={clsx(
                'group flex min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 border-r px-2.5 py-1.5 text-xs',
                path === activeFile ? 'bg-bg text-fg' : 'text-muted hover:bg-bg/50 hover:text-fg'
              )}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5"
                title={path}
                onClick={() => useApp.getState().setActiveFile(wsId, path)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    requestClose(path);
                  }
                }}
              >
                {fileGlyph(basename(path))}
                <span className="truncate">{basename(path)}</span>
                {dup && parent && <span className="shrink-0 truncate text-faint">— {parent}</span>}
              </button>
              {/* dirty dot until hover, then the close ✕ (middle-click also closes) */}
              <button
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint hover:bg-accent-soft hover:text-fg"
                title="Close tab (middle-click)"
                onClick={() => requestClose(path)}
              >
                {dirtyMap[path] ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-current group-hover:hidden" />
                    <X size={12} className="hidden group-hover:block" />
                  </>
                ) : (
                  <X size={12} className="opacity-0 group-hover:opacity-100" />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* breadcrumb + actions for the active file */}
      {activeFile && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-2xs text-muted">
          <span className="min-w-0 truncate font-mono" title={activeFile}>
            {activeFile}
          </span>
          <button
            className="shrink-0 rounded p-0.5 text-faint transition-colors hover:bg-accent-soft hover:text-fg"
            title="Copy relative path"
            onClick={copyPath}
          >
            {copied ? <Check size={11} className="text-ok" /> : <Copy size={11} />}
          </button>
          <div className="flex-1" />
          {isMarkdown && activeFile && (
            <div className="flex shrink-0 items-center rounded-ctl border bg-surface p-0.5">
              {(
                [
                  { id: 'preview', icon: <Eye size={11} />, label: 'Preview' },
                  { id: 'edit', icon: <Pencil size={11} />, label: 'Edit' },
                ] as const
              ).map((m) => {
                const on = (mdMode[activeFile] ?? 'preview') === m.id;
                return (
                  <button
                    key={m.id}
                    className={clsx(
                      'flex items-center gap-1 rounded px-1.5 py-0.5 font-medium transition-colors',
                      on ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
                    )}
                    onClick={() => setMdMode((p) => ({ ...p, [activeFile]: m.id }))}
                  >
                    {m.icon}
                    {m.label}
                  </button>
                );
              })}
            </div>
          )}
          <button
            className={clsx(
              'flex shrink-0 items-center gap-1 rounded-ctl px-1.5 py-0.5 transition-colors',
              activeDirty ? 'text-accent hover:bg-accent-soft' : 'cursor-default text-faint'
            )}
            title="Save (⌘S)"
            disabled={!activeDirty}
            onClick={() => void save(activeFile)}
          >
            <Save size={11} />
            Save
          </button>
        </div>
      )}

      {/* conflict / deleted banner for the active file */}
      {activeFile && activeBanner && (
        <ChangeBanner
          kind={activeBanner}
          onReload={() => {
            forceRef.current.delete(activeFile);
            void loadFile(activeFile, true);
          }}
          onKeepMine={() => {
            forceRef.current.add(activeFile); // next save wins
            clearBanner(activeFile);
          }}
          onSaveAnyway={() => void save(activeFile)}
        />
      )}

      {/* the surface itself */}
      <div className="relative min-h-0 flex-1">
        {/* single persistent Monaco instance — hidden (not unmounted) when the
            active tab isn't text (or is markdown in preview), so its models /
            view-state survive tab and preview↔edit switches */}
        <div className={clsx('absolute inset-0', (activeView?.kind !== 'text' || mdPreview) && 'invisible')}>
          <MonacoHost
            wsId={wsId}
            path={activeTextPath}
            visible={active && activeView?.kind === 'text' && !mdPreview}
            theme={theme}
          />
        </div>

        {mdPreview && activeBuffer?.kind === 'text' && <MarkdownPreview buffer={activeBuffer} />}
        {activeView?.kind === 'image' && <ImagePreview view={activeView} />}
        {activeView?.kind === 'binary' && (
          <BinaryCard wsId={wsId} path={activeFile!} view={activeView} />
        )}
        {activeView?.kind === 'notebook' && activeFile && (
          <div className="absolute inset-0 overflow-y-auto">
            <NotebookEditor
              key={`${activeFile}:${nbNonce[activeFile] ?? 0}`}
              wsId={wsId}
              path={activeFile}
              theme={theme}
              onChange={() => markNotebookDirty(activeFile)}
            />
          </div>
        )}
        {(!activeFile || activeView?.kind === 'loading') && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-faint">
            {activeFile ? (
              <span className="flex items-center gap-2">
                <Spinner /> Opening {basename(activeFile)}…
              </span>
            ) : (
              'Select a file to edit.'
            )}
          </div>
        )}
      </div>

      {closePrompt && (
        <CloseDirtyModal
          name={basename(closePrompt)}
          onCancel={() => setClosePrompt(null)}
          onDiscard={() => {
            const p = closePrompt;
            setClosePrompt(null);
            useApp.getState().closeFile(wsId, p);
          }}
          onSave={async () => {
            const p = closePrompt;
            const res = await save(p);
            if (res === 'conflict') {
              setClosePrompt(null); // leave the tab open on the conflict banner
              return;
            }
            setClosePrompt(null);
            useApp.getState().closeFile(wsId, p);
          }}
        />
      )}
    </div>
  );
}

// ---------------- single Monaco editor host ----------------

function MonacoHost({
  wsId,
  path,
  visible,
  theme,
}: {
  wsId: string;
  path: string | null;
  visible: boolean;
  theme: 'dark' | 'light';
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const curPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!elRef.current) return;
    const ed = monaco.editor.create(elRef.current, {
      model: null,
      theme: ensureEditorTheme(theme),
      automaticLayout: true,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      fontLigatures: true,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: 'selection',
      tabSize: 2,
      padding: { top: 10, bottom: 10 },
    });
    edRef.current = ed;
    return () => {
      // Persist the last tab's scroll/cursor before tearing the editor down.
      const cur = curPathRef.current;
      if (cur) {
        const b = getBuffer(wsId, cur);
        if (b?.kind === 'text') b.viewState = ed.saveViewState();
      }
      ed.dispose();
      edRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the model when the active text tab changes, saving/restoring view state.
  useEffect(() => {
    const ed = edRef.current;
    if (!ed) return;
    const prev = curPathRef.current;
    if (prev && prev !== path) {
      const pb = getBuffer(wsId, prev);
      if (pb?.kind === 'text') pb.viewState = ed.saveViewState();
    }
    if (path) {
      const b = getBuffer(wsId, path);
      if (b?.kind === 'text' && ed.getModel() !== b.model) {
        ed.setModel(b.model);
        if (b.viewState) ed.restoreViewState(b.viewState);
      }
    }
    curPathRef.current = path;
    if (visible) {
      ed.layout();
      ed.focus();
    }
  }, [wsId, path, visible]);

  return <div ref={elRef} className="h-full w-full" />;
}

// ---------------- non-text surfaces ----------------

/** Rendered-markdown Preview mode. Reads the live model and re-renders on every
 *  content change, so switching from Edit — and external reloads — stay in sync.
 *  Same marked+DOMPurify path (`.md` styling) as chat markdown. */
function MarkdownPreview({ buffer }: { buffer: TextBuffer }) {
  const [html, setHtml] = useState(() => renderMarkdown(buffer.model.getValue()));
  useEffect(() => {
    const update = () => setHtml(renderMarkdown(buffer.model.getValue()));
    update();
    const d = buffer.model.onDidChangeContent(update);
    return () => d.dispose();
  }, [buffer]);
  return (
    <div className="absolute inset-0 overflow-y-auto bg-bg">
      <div className="md mx-auto max-w-3xl px-8 py-6" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function ImagePreview({ view }: { view: { dataUrl: string; name: string } }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Ctrl/Cmd + wheel zooms (a bare wheel pans the overflow); p-6 padding, both sides.
  const { scrollRef, dims, scale, isFit, zoomBy, toggleFit, captureImg, onImgLoad, imgStyle } = useZoomableImage(
    view.dataUrl,
    { padding: 48, wheelModifier: true }
  );

  const copyImage = async () => {
    try {
      const blob = await (await fetch(view.dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      useApp.getState().toast('success', 'Image copied to clipboard');
    } catch (err) {
      useApp.getState().toast('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const saveImage = () => {
    const a = document.createElement('a');
    a.href = view.dataUrl;
    a.download = view.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div
      className="absolute inset-0 flex flex-col"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onDoubleClick={toggleFit}>
        <div className="flex min-h-full min-w-full items-center justify-center p-6">
          <img
            ref={captureImg}
            src={view.dataUrl}
            alt={view.name}
            draggable={false}
            style={imgStyle}
            className={clsx(
              'rounded border bg-[repeating-conic-gradient(var(--surface)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] shadow',
              !dims && 'max-h-full max-w-full object-contain',
            )}
            onLoad={onImgLoad}
          />
        </div>
      </div>
      <div className="flex items-center gap-3 border-t bg-bg px-3 py-1.5 text-2xs">
        <div className="min-w-0 flex-1 truncate text-muted">
          {view.name}
          {dims && <span className="text-faint"> · {dims.w}×{dims.h}</span>}
          <span className="text-faint"> · {formatBytes(approxBytesFromDataUrl(view.dataUrl))}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            className="btn h-6 w-6 p-0"
            title="Zoom out"
            onClick={() => zoomBy(1 / IMG_ZOOM_STEP)}
            disabled={scale <= IMG_ZOOM_MIN}
          >
            <ZoomOut size={13} />
          </button>
          <button
            className="btn h-6 min-w-12 px-2 tabular-nums"
            title={isFit ? 'Actual size (100%)' : 'Fit to window'}
            onClick={toggleFit}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            className="btn h-6 w-6 p-0"
            title="Zoom in"
            onClick={() => zoomBy(IMG_ZOOM_STEP)}
            disabled={scale >= IMG_ZOOM_MAX}
          >
            <ZoomIn size={13} />
          </button>
        </div>
      </div>
      {menu && (
        <ImageContextMenu
          x={menu.x}
          y={menu.y}
          onCopy={() => void copyImage()}
          onSave={saveImage}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function ImageContextMenu({
  x,
  y,
  onCopy,
  onSave,
  onClose,
}: {
  x: number;
  y: number;
  onCopy: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: Math.min(x, window.innerWidth - 200),
        top: Math.min(y, window.innerHeight - 100),
        zIndex: 60,
      }}
      className="glass w-48 overflow-hidden py-1"
    >
      <MenuItem
        onClick={() => {
          onClose();
          onCopy();
        }}
      >
        <Copy size={15} className="text-muted" /> Copy image
      </MenuItem>
      <MenuItem
        onClick={() => {
          onClose();
          onSave();
        }}
      >
        <Download size={15} className="text-muted" /> Save image…
      </MenuItem>
    </div>
  );
}

function BinaryCard({
  wsId,
  path,
  view,
}: {
  wsId: string;
  path: string;
  view: { name: string; size?: number; error?: string };
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-card border bg-surface px-6 py-8 text-center">
        <FileWarning size={28} className="text-faint" strokeWidth={1.5} />
        <div className="min-w-0">
          <div className="truncate font-mono text-sm text-fg">{view.name}</div>
          <div className="mt-1 text-xs text-muted">
            {view.error ?? "This file can't be shown in the editor."}
            {view.size != null && <> · {formatBytes(view.size)}</>}
          </div>
        </div>
        <button
          className="btn h-7 gap-1.5 text-xs"
          onClick={() => void tryInvoke('fs:open', { workspaceId: wsId, path })}
        >
          <ExternalLink size={12} />
          Open in system app
        </button>
      </div>
    </div>
  );
}

function ChangeBanner({
  kind,
  onReload,
  onKeepMine,
  onSaveAnyway,
}: {
  kind: Banner;
  onReload: () => void;
  onKeepMine: () => void;
  onSaveAnyway: () => void;
}) {
  const deleted = kind === 'deleted';
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-warn/10 px-3 py-1.5 text-2xs text-warn">
      {deleted ? <Trash2 size={12} className="shrink-0" /> : <AlertTriangle size={12} className="shrink-0" />}
      <span className="min-w-0 flex-1">
        {deleted
          ? 'Deleted on disk — your buffer is kept; saving recreates the file.'
          : 'Changed on disk since you opened it.'}
      </span>
      {deleted ? (
        <button className="btn btn-ghost h-5 px-1.5 text-2xs" onClick={onSaveAnyway}>
          Save (recreate)
        </button>
      ) : (
        <>
          <button className="btn btn-ghost h-5 px-1.5 text-2xs" onClick={onReload} title="Discard my edits and load the disk version">
            Reload
          </button>
          <button className="btn btn-ghost h-5 px-1.5 text-2xs" onClick={onKeepMine} title="Keep my edits; my next save overwrites the disk version">
            Keep mine
          </button>
        </>
      )}
    </div>
  );
}

function CloseDirtyModal({
  name,
  onSave,
  onDiscard,
  onCancel,
}: {
  name: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title="Unsaved changes"
      width={440}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onDiscard}>
            Discard
          </button>
          <button className="btn btn-accent" onClick={onSave}>
            Save
          </button>
        </>
      }
    >
      <div className="text-[13px] text-muted">
        <span className="font-mono text-fg">{name}</span> has unsaved changes. Save them before closing?
      </div>
    </Modal>
  );
}

// ---------------- helpers ----------------

function approxBytesFromDataUrl(u: string): number {
  const i = u.indexOf(',');
  const b64 = i >= 0 ? u.slice(i + 1) : u;
  return Math.floor((b64.length * 3) / 4);
}

function formatBytes(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
