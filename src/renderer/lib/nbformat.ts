// Minimal nbformat 4.x model for the in-app notebook editor. The guiding rule
// (see spec §8.1): parse the JSON once, then *mutate that object in place* for
// every edit and serialize the whole thing back. Because we never rebuild the
// object, every field we don't model — notebook/cell metadata, cell ids,
// execution_count, attachments — survives a round-trip untouched.

export interface NotebookOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error' | string;
  [k: string]: unknown;
}

export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  /** nbformat stores source as a list of lines (each with its trailing \n) or,
   *  loosely, a single string. `cellText`/`setCellText` bridge the two. */
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: NotebookOutput[];
  execution_count?: number | null;
  id?: string;
  [k: string]: unknown;
}

export interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
  [k: string]: unknown;
}

/** Parse `.ipynb` text into the doc, or null if it isn't a valid notebook (the
 *  caller then falls back to raw-JSON Monaco with a notice bar). */
export function parseNotebook(text: string): Notebook | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const cells = (doc as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return null;
  for (const c of cells) {
    if (!c || typeof c !== 'object' || typeof (c as NotebookCell).cell_type !== 'string') return null;
  }
  return doc as Notebook;
}

/**
 * Serialize the doc back to `.ipynb` text. `indent: 1` is Jupyter's own
 * convention; the trailing newline matches what `nbformat.write` emits, keeping
 * an edited notebook's diff to the touched cell instead of also flipping the
 * final line. Only ever called after an edit — a clean buffer's save is a no-op,
 * so unedited notebooks are never rewritten.
 */
export function serializeNotebook(doc: Notebook): string {
  return JSON.stringify(doc, null, 1) + '\n';
}

/** Flatten a cell's source (line-array or string) to a plain string for editing
 *  / rendering. */
export function cellText(cell: NotebookCell): string {
  const src = cell.source;
  if (Array.isArray(src)) return src.join('');
  return typeof src === 'string' ? src : '';
}

/** Commit edited text back to a cell, normalized to nbformat's canonical
 *  array-of-lines-with-trailing-\n shape. */
export function setCellText(cell: NotebookCell, text: string): void {
  cell.source = toSourceLines(text);
}

function toSourceLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i < parts.length - 1) out.push(parts[i] + '\n');
    else if (parts[i] !== '') out.push(parts[i]); // drop the empty tail from a trailing \n
  }
  return out;
}

/** Fresh cell for the "+"/add-cell affordances: a random nbformat ≥4.5 id, and
 *  empty outputs / null execution_count for code cells. */
export function newCell(type: 'code' | 'markdown' | 'raw'): NotebookCell {
  const cell: NotebookCell = { cell_type: type, metadata: {}, source: [], id: randomCellId() };
  if (type === 'code') {
    cell.execution_count = null;
    cell.outputs = [];
  }
  return cell;
}

function randomCellId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

/** The notebook's programming language, for code-cell highlighting:
 *  language_info → kernelspec → default python (spec §8.1). */
export function notebookLanguage(doc: Notebook): string {
  const md = (doc.metadata ?? {}) as {
    language_info?: { name?: string };
    kernelspec?: { language?: string };
  };
  const name = md.language_info?.name || md.kernelspec?.language || 'python';
  return String(name).toLowerCase();
}
