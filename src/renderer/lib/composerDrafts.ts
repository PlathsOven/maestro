// Unsent composer drafts (text + attachments, per `${wsId}:${agentId}`) persisted
// to localStorage, so a reload, an update restart, or a crash never eats a
// half-written prompt. Attachments are just references to files already saved
// under the worktree, so they're cheap to keep alongside the text.
import type { StoreApi } from 'zustand';
import type { Attachment } from '../../shared/types';
import type { AppState } from '../store/app';

const KEY = 'maestro.composerDrafts';
/** Typing only schedules a write; serialization runs at most this often. */
const WRITE_MS = 400;

interface Drafts {
  text: Record<string, string>;
  attachments: Record<string, Attachment[]>;
}

export function loadDrafts(): Drafts {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object') return { text: v.text ?? {}, attachments: v.attachments ?? {} };
  } catch {
    /* malformed or unavailable storage — start empty */
  }
  return { text: {}, attachments: {} };
}

/** Mirror the store's drafts into localStorage for the life of the window.
 *  Empty drafts and those of deleted workspaces are dropped on each write. */
export function persistDrafts(store: StoreApi<AppState>): void {
  let timer = 0;
  const write = () => {
    clearTimeout(timer);
    timer = 0;
    const s = store.getState();
    const ids = new Set(s.workspaces.map((w) => w.id));
    // Before app:init lands the workspace list is empty — keep everything then.
    const keep = (key: string) => !s.loaded || ids.has(key.slice(0, key.lastIndexOf(':')));
    const drafts: Drafts = {
      text: Object.fromEntries(Object.entries(s.composerDrafts).filter(([k, v]) => v && keep(k))),
      attachments: Object.fromEntries(Object.entries(s.composerAttachments).filter(([k, v]) => v?.length && keep(k))),
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(drafts));
    } catch {
      /* quota / unavailable — drafts stay in memory */
    }
  };
  store.subscribe((s, prev) => {
    if (s.composerDrafts !== prev.composerDrafts || s.composerAttachments !== prev.composerAttachments) {
      timer ||= window.setTimeout(write, WRITE_MS);
    }
  });
  // Quitting inside the debounce window must not lose the last keystrokes.
  window.addEventListener('beforeunload', () => timer && write());
}
