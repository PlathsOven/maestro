import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import DOMPurify from 'dompurify';
import { ArrowDown, ArrowUp, Eraser, Pencil, Play, Plus, RotateCcw, Square, Trash2, Zap } from 'lucide-react';
import { invoke, on, tryInvoke } from '../lib/api';
import { highlightLine, renderMarkdown, stripAnsi } from '../lib/format';
import { monaco, ensureEditorTheme } from '../lib/monaco';
import { getBuffer } from '../lib/editorBuffers';
import { cellText, newCell, notebookLanguage, setCellText, type NotebookCell, type NotebookOutput } from '../lib/nbformat';
import { Spinner } from './common';
import type { KernelStatus } from '../../shared/types';

/**
 * Cell-based `.ipynb` editor (spec §8) with in-app kernel execution. Renders
 * markdown/outputs, edits cells through one live Monaco at a time, and mutates
 * the notebook doc *in place* — the doc lives in the shared buffer cache, so ⌘S /
 * conflict / reload reuse the text machinery (EditorSurface owns those; we flag
 * dirty via `onChange`). Cells run against a per-notebook Jupyter kernel (main
 * process); outputs stream back over `jupyter:cell` and append to the doc.
 */
export default function NotebookEditor({
  wsId,
  path,
  theme,
  onChange,
}: {
  wsId: string;
  path: string;
  theme: 'dark' | 'light';
  onChange: () => void;
}) {
  const buf = getBuffer(wsId, path);
  const [, forceRender] = useState(0);
  const bump = () => forceRender((n) => n + 1);
  const [editing, setEditing] = useState<number | null>(null);
  const [kernel, setKernel] = useState<KernelStatus>('none');
  const [caps, setCaps] = useState<{ available: boolean; version?: string; reason?: string } | null>(null);
  const [running, setRunning] = useState<Set<string>>(() => new Set());

  // Route kernel outputs back to cells by a stable per-cell id kept *outside* the
  // doc (no gratuitous `id` writes). WeakMap survives cell moves; the forward map
  // is the O(1) lookup for incoming events.
  const cellIds = useRef(new WeakMap<NotebookCell, string>()).current;
  const idCells = useRef(new Map<string, NotebookCell>()).current;
  const seq = useRef(0);
  const execIdFor = (cell: NotebookCell): string => {
    let id = cellIds.get(cell);
    if (!id) {
      id = 'c' + ++seq.current;
      cellIds.set(cell, id);
    }
    idCells.set(id, cell);
    return id;
  };

  // Discover kernel availability + current status once per notebook mount.
  useEffect(() => {
    let alive = true;
    void tryInvoke('jupyter:capabilities', { workspaceId: wsId }).then((r) => {
      if (alive && r.data) setCaps(r.data);
    });
    void tryInvoke('jupyter:kernelStatus', { workspaceId: wsId, path }).then((r) => {
      if (alive && r.data) setKernel(r.data.status);
    });
    return () => {
      alive = false;
    };
  }, [wsId, path]);

  // Live kernel + cell-output stream for this notebook.
  useEffect(() => {
    const offState = on('jupyter:state', (e) => {
      if (e.workspaceId !== wsId || e.path !== path) return;
      setKernel(e.status);
      if (e.status === 'dead' || e.status === 'restarting') setRunning(new Set());
    });
    const offCell = on('jupyter:cell', (e) => {
      if (e.workspaceId !== wsId || e.path !== path) return;
      const cell = idCells.get(e.cellId);
      if (!cell) return;
      if (e.kind === 'output' && e.output) {
        if (!Array.isArray(cell.outputs)) cell.outputs = [];
        appendOutput(cell.outputs, e.output as NotebookOutput);
      } else if (e.kind === 'clear') {
        cell.outputs = [];
      } else if (e.kind === 'input') {
        cell.execution_count = e.executionCount ?? cell.execution_count ?? null;
      } else if (e.kind === 'reply') {
        cell.execution_count = e.executionCount ?? cell.execution_count ?? null;
        setRunning((s) => {
          const n = new Set(s);
          n.delete(e.cellId);
          return n;
        });
        onChange(); // finished run → ensure outputs are persistable even if saved mid-run
      }
      bump();
    });
    return () => {
      offState();
      offCell();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, path]);

  if (!buf || buf.kind !== 'notebook') {
    return <div className="flex h-full items-center justify-center text-sm text-faint">Loading notebook…</div>;
  }
  const doc = buf.doc;
  const lang = notebookLanguage(doc);
  const kernelAvailable = caps?.available !== false; // optimistic until discovery resolves
  const busy = kernel === 'busy' || kernel === 'starting' || kernel === 'restarting' || running.size > 0;

  // Any structural / text mutation: flag dirty and re-render from the mutated doc.
  const touch = () => {
    onChange();
    bump();
  };

  const commitCell = (index: number, text: string) => {
    const cell = doc.cells[index];
    if (!cell) return;
    if (cellText(cell) === text) return; // no-op keystroke (e.g. focus without edit)
    setCellText(cell, text);
    onChange(); // dirty, but no re-render — the live editor holds the truth
  };

  const addCell = (at: number, type: 'code' | 'markdown') => {
    doc.cells.splice(at, 0, newCell(type));
    setEditing(at);
    touch();
  };
  const deleteCell = (index: number) => {
    doc.cells.splice(index, 1);
    setEditing((e) => (e === index ? null : e != null && e > index ? e - 1 : e));
    touch();
  };
  const moveCell = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= doc.cells.length) return;
    const [c] = doc.cells.splice(index, 1);
    doc.cells.splice(j, 0, c);
    setEditing(null);
    touch();
  };
  const cycleType = (index: number) => {
    const cell = doc.cells[index];
    const order: NotebookCell['cell_type'][] = ['code', 'markdown', 'raw'];
    const next = order[(order.indexOf(cell.cell_type) + 1) % order.length];
    cell.cell_type = next;
    if (next === 'code') {
      if (!Array.isArray(cell.outputs)) cell.outputs = [];
      if (cell.execution_count === undefined) cell.execution_count = null;
    } else {
      delete cell.outputs;
      delete cell.execution_count;
    }
    setEditing(null);
    touch();
  };
  const clearOutputs = (index: number) => {
    const cell = doc.cells[index];
    cell.outputs = [];
    cell.execution_count = null;
    touch();
  };

  // ---- execution ----

  const executeCode = (index: number) => {
    const cell = doc.cells[index];
    if (!cell || cell.cell_type !== 'code' || !kernelAvailable) return;
    const id = execIdFor(cell);
    cell.outputs = [];
    cell.execution_count = null;
    setRunning((s) => new Set(s).add(id));
    onChange(); // running clears/changes outputs → dirty
    bump();
    void tryInvoke('jupyter:execute', { workspaceId: wsId, path, cellId: id, code: cellText(cell) }).then(
      ({ data, error }) => {
        if (error || (data && !data.ok)) {
          cell.outputs = [
            { output_type: 'error', ename: 'Kernel error', evalue: error ?? data?.error ?? 'Could not run cell', traceback: [] },
          ];
          setRunning((s) => {
            const n = new Set(s);
            n.delete(id);
            return n;
          });
          bump();
        }
      }
    );
  };

  // Run + advance, per Jupyter: ⌘↵ stays, ⇧↵ moves to next (new cell at the end),
  // ⌥↵ inserts a new cell below. Commit happens in CellEditor before this fires.
  const runCell = (index: number, mode: 'stay' | 'below' | 'insert') => {
    const cell = doc.cells[index];
    if (!cell) return;
    if (cell.cell_type === 'code') executeCode(index);
    if (mode === 'stay') {
      setEditing((e) => (e === index ? null : e));
      return;
    }
    if (mode === 'insert') {
      addCell(index + 1, cell.cell_type === 'markdown' ? 'markdown' : 'code');
      return;
    }
    if (index >= doc.cells.length - 1) addCell(index + 1, 'code');
    else setEditing(index + 1);
  };

  const runAll = () => {
    for (let i = 0; i < doc.cells.length; i++) {
      if (doc.cells[i].cell_type === 'code') executeCode(i);
    }
  };
  const interrupt = () => void invoke('jupyter:interrupt', { workspaceId: wsId, path });
  const restart = () => {
    setRunning(new Set());
    void invoke('jupyter:restart', { workspaceId: wsId, path });
  };

  return (
    <div className="min-h-full pb-16">
      <KernelToolbar
        status={kernel}
        caps={caps}
        busy={busy}
        onRunAll={runAll}
        onInterrupt={interrupt}
        onRestart={restart}
      />
      <div className="mx-auto max-w-4xl px-4 py-4">
        <AddDivider onAdd={(t) => addCell(0, t)} />
        {doc.cells.map((cell, i) => {
          const eid = cellIds.get(cell);
          return (
            <div key={i}>
              <CellRow
                cell={cell}
                index={i}
                total={doc.cells.length}
                lang={lang}
                theme={theme}
                editing={editing === i}
                running={!!eid && running.has(eid)}
                canRun={kernelAvailable}
                onEdit={() => setEditing(i)}
                onDone={() => setEditing((e) => (e === i ? null : e))}
                onCommit={(text) => commitCell(i, text)}
                onRun={(mode) => runCell(i, mode)}
                onDelete={() => deleteCell(i)}
                onMove={(d) => moveCell(i, d)}
                onCycleType={() => cycleType(i)}
                onClearOutputs={() => clearOutputs(i)}
              />
              <AddDivider onAdd={(t) => addCell(i + 1, t)} />
            </div>
          );
        })}
        {doc.cells.length === 0 && (
          <div className="py-8 text-center text-sm text-faint">Empty notebook — add a cell above.</div>
        )}
      </div>
    </div>
  );
}

// ---------------- kernel toolbar ----------------

const STATUS_META: Record<KernelStatus, { label: string; dot: string }> = {
  none: { label: 'No kernel', dot: 'bg-faint' },
  starting: { label: 'Starting…', dot: 'bg-warn' },
  idle: { label: 'Ready', dot: 'bg-ok' },
  busy: { label: 'Running', dot: 'bg-warn' },
  restarting: { label: 'Restarting…', dot: 'bg-warn' },
  dead: { label: 'Kernel died', dot: 'bg-err' },
};

function KernelToolbar({
  status,
  caps,
  busy,
  onRunAll,
  onInterrupt,
  onRestart,
}: {
  status: KernelStatus;
  caps: { available: boolean; version?: string; reason?: string } | null;
  busy: boolean;
  onRunAll: () => void;
  onInterrupt: () => void;
  onRestart: () => void;
}) {
  const unavailable = caps?.available === false;
  const meta = STATUS_META[status];
  return (
    <div className="sticky top-0 z-20 flex items-center gap-2 border-b bg-bg/90 px-4 py-1.5 backdrop-blur">
      {unavailable ? (
        <span className="flex items-center gap-1.5 text-2xs text-muted" title={caps?.reason}>
          <Zap size={12} className="text-faint" />
          Notebook execution needs Python + <span className="font-mono">jupyter_client</span> +{' '}
          <span className="font-mono">ipykernel</span>
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-2xs text-muted">
          {status === 'busy' || status === 'starting' || status === 'restarting' ? (
            <Spinner className="!h-3 !w-3" />
          ) : (
            <span className={clsx('h-2 w-2 rounded-full', meta.dot)} />
          )}
          <span className="font-medium text-fg">{caps?.version ? `Python ${caps.version}` : 'Python'}</span>
          <span className="text-faint">·</span>
          {meta.label}
        </span>
      )}
      <div className="flex-1" />
      <button
        className="flex items-center gap-1 rounded-ctl px-1.5 py-0.5 text-2xs font-medium text-muted transition-colors hover:bg-accent-soft hover:text-fg disabled:opacity-40"
        title="Run every cell, top to bottom"
        disabled={unavailable}
        onClick={onRunAll}
      >
        <Play size={11} />
        Run all
      </button>
      <button
        className="flex items-center gap-1 rounded-ctl px-1.5 py-0.5 text-2xs font-medium text-muted transition-colors hover:bg-accent-soft hover:text-fg disabled:opacity-40"
        title="Interrupt the kernel (stop the running cell)"
        disabled={!busy}
        onClick={onInterrupt}
      >
        <Square size={10} fill="currentColor" />
        Interrupt
      </button>
      <button
        className="flex items-center gap-1 rounded-ctl px-1.5 py-0.5 text-2xs font-medium text-muted transition-colors hover:bg-accent-soft hover:text-fg disabled:opacity-40"
        title="Restart the kernel (clears all variables)"
        disabled={unavailable}
        onClick={onRestart}
      >
        <RotateCcw size={11} />
        Restart
      </button>
    </div>
  );
}

// ---------------- one cell ----------------

function CellRow({
  cell,
  index,
  total,
  lang,
  theme,
  editing,
  running,
  canRun,
  onEdit,
  onDone,
  onCommit,
  onRun,
  onDelete,
  onMove,
  onCycleType,
  onClearOutputs,
}: {
  cell: NotebookCell;
  index: number;
  total: number;
  lang: string;
  theme: 'dark' | 'light';
  editing: boolean;
  running: boolean;
  canRun: boolean;
  onEdit: () => void;
  onDone: () => void;
  onCommit: (text: string) => void;
  onRun: (mode: 'stay' | 'below' | 'insert') => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onCycleType: () => void;
  onClearOutputs: () => void;
}) {
  const isCode = cell.cell_type === 'code';
  const isMarkdown = cell.cell_type === 'markdown';
  const text = cellText(cell);

  return (
    <div className="group relative flex gap-2 rounded-card py-1">
      {/* gutter: run button (hover) / execution count / running spinner */}
      <div className="flex w-10 shrink-0 flex-col items-end pt-1.5">
        {isCode &&
          (running ? (
            <Spinner className="!h-3.5 !w-3.5" />
          ) : (
            <>
              <button
                className="hidden h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:bg-accent-soft hover:text-accent group-hover:flex disabled:opacity-40"
                title={canRun ? 'Run cell  (⌘↵ · ⇧↵ next · ⌥↵ insert)' : 'No kernel available'}
                disabled={!canRun}
                onClick={() => onRun('stay')}
              >
                <Play size={13} />
              </button>
              <span className="font-mono text-2xs text-faint group-hover:hidden">[{cell.execution_count ?? ' '}]</span>
            </>
          ))}
      </div>

      <div className="min-w-0 flex-1">
        {/* hover toolbar */}
        <div className="pointer-events-none absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded-ctl border bg-raised p-0.5 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <CellBtn title={`Type: ${cell.cell_type} — click to change`} onClick={onCycleType}>
            <span className="px-0.5 text-2xs font-medium uppercase">{cell.cell_type.slice(0, 2)}</span>
          </CellBtn>
          {isCode && (cell.outputs?.length ?? 0) > 0 && (
            <CellBtn title="Clear outputs" onClick={onClearOutputs}>
              <Eraser size={12} />
            </CellBtn>
          )}
          {isMarkdown && !editing && (
            <CellBtn title="Edit" onClick={onEdit}>
              <Pencil size={12} />
            </CellBtn>
          )}
          <CellBtn title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp size={12} />
          </CellBtn>
          <CellBtn title="Move down" disabled={index === total - 1} onClick={() => onMove(1)}>
            <ArrowDown size={12} />
          </CellBtn>
          <CellBtn title="Delete cell" onClick={onDelete}>
            <Trash2 size={12} />
          </CellBtn>
        </div>

        {/* body: live editor when focused, else the rendered/static view */}
        {editing ? (
          <CellEditor
            initial={text}
            language={isMarkdown ? 'markdown' : isCode ? lang : 'plaintext'}
            theme={theme}
            onCommit={onCommit}
            onRun={onRun}
            onDone={onDone}
          />
        ) : isMarkdown ? (
          <div
            className="md min-h-[1.5rem] cursor-text rounded px-1 py-0.5 hover:bg-accent-soft/30"
            onDoubleClick={onEdit}
            // Rendered via the same marked+DOMPurify path (+ `.md` styling) as chat markdown.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text || '*empty markdown cell*') }}
          />
        ) : (
          <pre
            className="cursor-text overflow-x-auto rounded border bg-surface px-2.5 py-1.5 font-mono text-xs leading-relaxed"
            onClick={onEdit}
            dangerouslySetInnerHTML={{ __html: highlightLine(text, isCode ? lang : null) || '<span class="text-faint">empty cell</span>' }}
          />
        )}

        {/* outputs (read-only) */}
        {isCode && cell.outputs && cell.outputs.length > 0 && (
          <div className="mt-1 space-y-1">
            {cell.outputs.map((o, k) => (
              <Output key={k} output={o} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CellBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className="flex h-5 items-center justify-center rounded px-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg disabled:opacity-30"
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The "+" divider between cells (and at the ends). */
function AddDivider({ onAdd }: { onAdd: (type: 'code' | 'markdown') => void }) {
  return (
    <div className="group/divider relative flex h-3 items-center justify-center">
      <div className="absolute inset-x-10 top-1/2 h-px -translate-y-1/2 bg-transparent group-hover/divider:bg-border" />
      <div className="z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover/divider:opacity-100">
        <button
          className="flex items-center gap-1 rounded-ctl border bg-raised px-1.5 py-0.5 text-2xs text-muted shadow-sm hover:text-fg"
          onClick={() => onAdd('code')}
        >
          <Plus size={10} /> Code
        </button>
        <button
          className="flex items-center gap-1 rounded-ctl border bg-raised px-1.5 py-0.5 text-2xs text-muted shadow-sm hover:text-fg"
          onClick={() => onAdd('markdown')}
        >
          <Plus size={10} /> Markdown
        </button>
      </div>
    </div>
  );
}

// ---------------- per-cell Monaco (one live instance at a time) ----------------

function CellEditor({
  initial,
  language,
  theme,
  onCommit,
  onRun,
  onDone,
}: {
  initial: string;
  language: string;
  theme: 'dark' | 'light';
  onCommit: (text: string) => void;
  onRun: (mode: 'stay' | 'below' | 'insert') => void;
  onDone: () => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  // Keep the latest onRun without re-creating the editor (commands capture it).
  const runRef = useRef(onRun);
  runRef.current = onRun;

  useEffect(() => {
    if (!elRef.current) return;
    const ed = monaco.editor.create(elRef.current, {
      value: initial,
      language,
      theme: ensureEditorTheme(theme),
      automaticLayout: true,
      minimap: { enabled: false },
      lineNumbers: 'off',
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 0,
      lineNumbersMinChars: 0,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      renderLineHighlight: 'none',
      scrollbar: { vertical: 'hidden', alwaysConsumeMouseWheel: false },
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      fontLigatures: true,
      fontSize: 12.5,
      padding: { top: 6, bottom: 6 },
    });
    // Auto-height so the whole cell is visible without an inner scrollbar.
    const fit = () => {
      const h = Math.min(Math.max(ed.getContentHeight(), 30), 640);
      if (elRef.current) elRef.current.style.height = `${h}px`;
      ed.layout();
    };
    fit();
    const dSize = ed.onDidContentSizeChange(fit);
    const dChange = ed.onDidChangeModelContent(() => onCommit(ed.getValue()));
    const dBlur = ed.onDidBlurEditorWidget(() => onDone()); // unfocused cell → static (spec §8.2)
    // Jupyter run shortcuts (commit first so the doc has the latest text).
    const run = (mode: 'stay' | 'below' | 'insert') => {
      onCommit(ed.getValue());
      runRef.current(mode);
    };
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run('stay'));
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => run('below'));
    ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => run('insert'));
    ed.focus();
    return () => {
      onCommit(ed.getValue()); // never lose the last edit
      dSize.dispose();
      dChange.dispose();
      dBlur.dispose();
      ed.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={elRef} className="overflow-hidden rounded border" />;
}

// ---------------- outputs (read-only, spec §8.3) ----------------

function joinText(v: unknown): string {
  if (Array.isArray(v)) return v.join('');
  return typeof v === 'string' ? v : '';
}

/** Append a streamed output to a cell, merging consecutive same-stream chunks
 *  (stdout/stderr) into one growing block — nbformat's own convention, and it
 *  keeps a chatty loop from producing hundreds of <pre>s. */
function appendOutput(outputs: NotebookOutput[], output: NotebookOutput): void {
  if (output.output_type === 'stream') {
    const last = outputs[outputs.length - 1];
    if (last && last.output_type === 'stream' && (last as { name?: string }).name === (output as { name?: string }).name) {
      (last as { text?: unknown }).text = joinText((last as { text?: unknown }).text) + joinText((output as { text?: unknown }).text);
      return;
    }
  }
  outputs.push(output);
}

function Output({ output }: { output: NotebookOutput }) {
  const type = output.output_type;

  if (type === 'stream') {
    const isErr = (output as { name?: string }).name === 'stderr';
    return (
      <pre className={clsx('overflow-x-auto whitespace-pre-wrap rounded bg-surface px-2.5 py-1.5 font-mono text-2xs', isErr ? 'text-err' : 'text-muted')}>
        {stripAnsi(joinText((output as { text?: unknown }).text))}
      </pre>
    );
  }

  if (type === 'error') {
    const err = output as { ename?: string; evalue?: string; traceback?: unknown };
    const tb = Array.isArray(err.traceback) ? err.traceback.join('\n') : joinText(err.traceback);
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-err/30 bg-err/5 px-2.5 py-1.5 font-mono text-2xs text-err">
        <span className="font-semibold">
          {err.ename}: {err.evalue}
        </span>
        {tb ? '\n' + stripAnsi(tb) : ''}
      </pre>
    );
  }

  if (type === 'execute_result' || type === 'display_data') {
    const data = ((output as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return <MimeBundle data={data} />;
  }

  return null;
}

/** Render a mime bundle in priority order — richest renderable representation
 *  wins, with text/plain as the universal fallback. */
function MimeBundle({ data }: { data: Record<string, unknown> }) {
  const png = data['image/png'];
  const jpeg = data['image/jpeg'];
  if (png || jpeg) {
    const mime = png ? 'image/png' : 'image/jpeg';
    const b64 = joinText(png ?? jpeg).replace(/\s/g, '');
    return <img src={`data:${mime};base64,${b64}`} alt="output" className="max-w-full rounded border bg-white" />;
  }
  if (data['image/svg+xml']) {
    const svg = DOMPurify.sanitize(joinText(data['image/svg+xml']));
    return <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  if (data['text/html']) {
    // Untrusted (agent/repo authored) — sanitized like chat markdown, never raw.
    const html = DOMPurify.sanitize(joinText(data['text/html'])).trim();
    if (html) {
      return <div className="notebook-html overflow-x-auto text-xs" dangerouslySetInnerHTML={{ __html: html }} />;
    }
    // Sanitized away (e.g. a script-only plotly bundle) → fall through to text.
  }
  if (data['application/json']) {
    let pretty: string;
    try {
      pretty = JSON.stringify(data['application/json'], null, 2);
    } catch {
      pretty = joinText(data['application/json']);
    }
    return <pre className="overflow-x-auto rounded bg-surface px-2.5 py-1.5 font-mono text-2xs text-muted">{pretty}</pre>;
  }
  if (data['text/plain']) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-surface px-2.5 py-1.5 font-mono text-2xs text-muted">
        {joinText(data['text/plain'])}
      </pre>
    );
  }
  return null;
}
