// ↑/↓ prompt recall in the composer — a shell-style walk back through the
// prompts sent in this chat. Nothing is stored: the history is read off the
// chat's own messages at keypress time.
import type { ChatMessage } from '../../shared/types';

/** This chat's sent prompts, newest first — text only, consecutive repeats
 *  collapsed. Messages from other agents (`maestro-message`) aren't the user's
 *  words and are skipped. */
export function promptHistory(messages: ChatMessage[] | undefined, agentId: number): string[] {
  const out: string[] = [];
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages![i];
    if (m.role !== 'user' || m.agentId !== agentId || m.meta?.origin === 'agent' || !m.content.trim()) continue;
    if (out[out.length - 1] !== m.content) out.push(m.content);
  }
  return out;
}

/**
 * Is the caret on the textarea's first (or last) *visual* line — counting soft
 * wraps, so ↑ inside a long wrapped prompt still moves the caret, and only ↑ on
 * the top line walks history. Measured with an offscreen mirror of the textarea.
 */
export function caretOnEdgeLine(ta: HTMLTextAreaElement, edge: 'first' | 'last'): boolean {
  if (ta.selectionStart !== ta.selectionEnd) return false;
  const text = ta.value;
  const caret = ta.selectionStart;
  if (caret === (edge === 'first' ? 0 : text.length)) return true;
  const cs = getComputedStyle(ta);
  const mirror = document.createElement('div');
  mirror.style.cssText =
    'position:absolute;visibility:hidden;left:-9999px;top:0;white-space:pre-wrap;overflow-wrap:break-word;';
  for (const p of ['boxSizing', 'width', 'font', 'letterSpacing', 'lineHeight', 'padding', 'border', 'tabSize'] as const) {
    mirror.style[p] = cs[p];
  }
  // Marker tops at the caret and at the edge; the same top ⇒ the same line.
  const top = (at: number) => {
    mirror.textContent = text.slice(0, at);
    const mark = mirror.appendChild(document.createElement('span'));
    mark.textContent = '​';
    return mark.offsetTop;
  };
  document.body.appendChild(mirror);
  try {
    return top(caret) === top(edge === 'first' ? 0 : text.length);
  } finally {
    mirror.remove();
  }
}
