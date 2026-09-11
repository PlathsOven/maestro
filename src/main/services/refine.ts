import type { Workspace } from '../../shared/types';
import { Projects } from '../db';
import { hostForWorkspace } from '../hosts';
import { generateText } from './llm';

// Rewrite a user's prompt to be clearer and more token-efficient before it's
// sent to the agent, using the weakest model of their chosen harness (Haiku for
// Claude, etc.). Preserves every detail — this is not summarization.
//
// Unlike every other one-shot consumer (status/runscripts/pr), the refined text
// becomes the user's *message*, so the model's words are never trusted blindly:
// the prompt demands a machine-checkable output shape (§3.2) and
// validateRefinement rejects refusals, meta-commentary, bloat, collapse, and any
// rewrite that dropped an @mention / `code` / URL. On any rejection the caller
// falls back to sending the user's own text as written.

export interface RefineResult {
  /** The prompt to send, or null → send the user's text as written. */
  text: string | null;
  model: string;
  /** Why `text` is null. Only `error` is worth a toast; the others are silent. */
  reason?: 'trivial' | 'unchanged' | 'rejected';
  error?: string;
}

const TRIVIAL_WORDS = 3; // "yes", "try again", "continue" — nothing to refine, only risk

function buildPrompt(raw: string): string {
  return (
    'You are a prompt editor for a coding agent. Rewrite the user prompt below to be clearer and more ' +
    'token-efficient, while preserving EVERY detail: every requirement, constraint, instruction, question, and ' +
    'every file path, identifier, code snippet, number, and proper noun exactly as written. Do NOT answer, ' +
    'perform, summarize, generalize, reorder priorities, or add or drop anything — only tighten wording, fix ' +
    'grammar/transcription errors, and remove filler and redundancy. Preserve any @file mentions verbatim.\n\n' +
    'Output format — exactly one of:\n' +
    '<refined>the rewritten prompt</refined>\n' +
    'UNCHANGED\n' +
    'Never output anything else: no preamble, no questions, no explanation, and never an ' +
    'answer to the prompt. If the prompt is too short, too vague to rewrite faithfully, ' +
    `or already clear, output UNCHANGED.\n\nPrompt:\n"""\n${raw}\n"""`
  );
}

export async function refinePrompt(ws: Workspace, text: string): Promise<RefineResult> {
  const raw = text.trim();
  if (!raw) return { text: null, model: '' };
  if (raw.split(/\s+/).length < TRIVIAL_WORDS) return { text: null, model: '', reason: 'trivial' };
  const harness =
    ws.harness === 'claude-code' || ws.harness === 'codex' || ws.harness === 'grok' ? ws.harness : undefined;
  const remoteHost = Projects.get(ws.projectId)?.hostId ? hostForWorkspace(ws) : undefined; // as today (ipc.ts:640)
  const r = await generateText({
    cwd: ws.worktreePath,
    prompt: buildPrompt(raw),
    tier: 'light',
    harness: remoteHost ? harness ?? 'claude-code' : harness,
    host: remoteHost,
    timeoutMs: 30_000,
  });
  if (!r.text) return { text: null, model: r.model, error: r.error };
  const v = validateRefinement(raw, r.text);
  return v.ok ? { text: v.text, model: r.model } : { text: null, model: r.model, reason: v.reason };
}

/**
 * Validate a refinement against the raw prompt. Pure and exported so it's
 * unit-tested under node. Extracts the <refined>…</refined> payload and rejects
 * anything that smells like the model answered, summarized, or refused.
 */
export function validateRefinement(
  raw: string,
  out: string
): { ok: true; text: string } | { ok: false; reason: 'unchanged' | 'rejected' } {
  const m = /<refined>([\s\S]*?)<\/refined>/.exec(out);
  if (!m) return { ok: false, reason: /^\s*UNCHANGED\s*$/.test(out) ? 'unchanged' : 'rejected' };
  const text = m[1].trim().replace(/^"""\s*|\s*"""$/g, '');
  if (!text) return { ok: false, reason: 'unchanged' };
  // Bloat or collapse is the signature of "answered it" / "summarized it".
  if (text.length > Math.max(raw.length * 3, raw.length + 300)) return { ok: false, reason: 'rejected' };
  if (text.length < raw.length * 0.2) return { ok: false, reason: 'rejected' };
  // Anchors the rewrite must carry verbatim: @mentions, `code`, URLs.
  for (const tok of raw.match(/@[\w./-]+|`[^`\n]+`|https?:\/\/\S+/g) ?? []) {
    if (!text.includes(tok)) return { ok: false, reason: 'rejected' };
  }
  // Meta-commentary that slipped inside the tags.
  const META =
    /\b(I (cannot|can't|am unable|need more)|could you (please )?(clarify|provide)|not enough (context|information|detail)|no prompt (was )?provided|as an AI)\b/i;
  if (META.test(text) && !META.test(raw)) return { ok: false, reason: 'rejected' };
  return { ok: true, text };
}
