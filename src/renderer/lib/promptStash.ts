// The prompt stash: park a half-written prompt (⌘S), bring it back later —
// across chats, workspaces, and restarts. Newest first, capped.
import type { Attachment } from '../../shared/types';

export interface StashedPrompt {
  id: number;
  text: string;
  /** Worktree-relative, so they only come back in the workspace they came from. */
  attachments: Attachment[];
  workspaceId: string;
  at: number;
}

const KEY = 'maestro.promptStash';
export const STASH_MAX = 20;

export function loadStash(): StashedPrompt[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveStash(list: StashedPrompt[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* quota / unavailable — the stash lives for this session only */
  }
}
