// Open buffers live *outside* React, in a module-level cache keyed `wsId:path`.
// Monaco models own the buffer text + undo stack (the source of truth); the
// zustand store only mirrors what other components render (tabs, dirty dots).
// This module is imported only from the lazily-loaded editor chunk, so pulling
// in monaco here doesn't cost app startup.
import { monaco } from './monaco';
import type { Notebook } from './nbformat';

export interface TextBuffer {
  kind: 'text';
  model: monaco.editor.ITextModel;
  /** Restored when this tab is re-activated, so scroll + cursor survive. */
  viewState: monaco.editor.ICodeEditorViewState | null;
  /** `model.getAlternativeVersionId()` at the last load/save — dirty is any
   *  divergence from this (returns to clean if you undo back). */
  savedVersionId: number;
  /** mtime the buffer last synced with disk, sent as `expectedMtimeMs` on save. */
  baseMtime: number;
}

interface NotebookBuffer {
  kind: 'notebook';
  doc: Notebook;
  dirty: boolean;
  baseMtime: number;
}

type EditorBuffer = TextBuffer | NotebookBuffer;

const cache = new Map<string, EditorBuffer>();

const bufKey = (wsId: string, path: string) => `${wsId}:${path}`;

export function getBuffer(wsId: string, path: string): EditorBuffer | undefined {
  return cache.get(bufKey(wsId, path));
}

export function setBuffer(wsId: string, path: string, buf: EditorBuffer): void {
  cache.set(bufKey(wsId, path), buf);
}

export function disposeBuffer(wsId: string, path: string): void {
  const key = bufKey(wsId, path);
  const buf = cache.get(key);
  if (buf?.kind === 'text') buf.model.dispose();
  cache.delete(key);
}

/** Evict every buffer for a workspace — on archive/delete (spec §6). */
export function disposeWorkspaceBuffers(wsId: string): void {
  const prefix = `${wsId}:`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) {
      const buf = cache.get(key);
      if (buf?.kind === 'text') buf.model.dispose();
      cache.delete(key);
    }
  }
}
