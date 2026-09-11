import { broadcast } from '../bus';
import { uid } from '../db';
import { ASK_MAX_OPTIONS, type AgentBlock, type AskAnswer, type AskQuestion, type AskResult } from '../../shared/types';

/**
 * Registry of in-flight "ask the user" prompts — the user-facing sibling of the
 * role delegation bridge. An agent shells out to the `maestro-ask` CLI, which
 * POSTs to the loopback /ask route (roleserver); that route calls createAsk()
 * and awaits the returned promise. We broadcast the question so the renderer
 * shows a picker, then resolve when the user answers (ipc `ask:answer` →
 * submitAskAnswer) or the run dies (socket close / stop → cancelAsk). The
 * agent's turn stays blocked on the CLI the whole time, exactly like a
 * Conductor-style AskUserQuestion tool call.
 */
interface Pending {
  workspaceId: string;
  agentId: number;
  questions: AskQuestion[];
  resolve: (r: AskResult) => void;
}

const pending = new Map<string, Pending>();

/** Injected by the harness runner: fold a resolved ask (question + answer) back
 *  into the running turn's block stream so it persists in the trace. Set via a
 *  hook to keep this module free of an import cycle with harness/index. */
let recordHook: ((workspaceId: string, agentId: number, block: AgentBlock) => void) | null = null;
export function setAskRecordHook(fn: (workspaceId: string, agentId: number, block: AgentBlock) => void): void {
  recordHook = fn;
}

/** Coerce arbitrary CLI JSON into a safe question list; null if unusable. */
function normalizeQuestions(raw: unknown): AskQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AskQuestion[] = [];
  for (const q of raw) {
    const question = typeof (q as { question?: unknown })?.question === 'string' ? (q as { question: string }).question.trim() : '';
    if (!question) continue;
    const optsRaw = Array.isArray((q as { options?: unknown })?.options) ? (q as { options: unknown[] }).options : [];
    const options = optsRaw
      .map((o) => (typeof o === 'string' ? o.trim() : String(o ?? '')))
      .filter((o) => o.length > 0)
      .slice(0, ASK_MAX_OPTIONS);
    out.push({ question, options, multiSelect: !!(q as { multiSelect?: unknown })?.multiSelect });
  }
  return out.length ? out : null;
}

/** Register a question, tell the renderer, and return its id + a promise that
 *  resolves with the user's answer. The caller (roleserver /ask) awaits it. */
export function createAsk(req: {
  workspaceId: string;
  agentId: number;
  questions: unknown;
}): { askId: string; result: Promise<AskResult> } {
  const questions = normalizeQuestions(req.questions);
  if (!questions) {
    return { askId: '', result: Promise.resolve({ ok: false, error: 'no valid questions provided' }) };
  }
  const askId = uid();
  const result = new Promise<AskResult>((resolve) => {
    pending.set(askId, { workspaceId: req.workspaceId, agentId: req.agentId, questions, resolve });
    broadcast('ask:question', { workspaceId: req.workspaceId, agentId: req.agentId, askId, questions });
  });
  return { askId, result };
}

/** Resolve one pending ask and tell the renderer to clear its picker. No-op if
 *  it was already resolved (answered, then the socket closed on reply, etc.). */
function resolveAsk(askId: string, result: AskResult): void {
  const p = pending.get(askId);
  if (!p) return;
  pending.delete(askId);
  broadcast('ask:resolved', { workspaceId: p.workspaceId, agentId: p.agentId, askId });
  // Fold the resolved Q&A into the turn so it survives the picker being cleared.
  // A cancelled/dismissed prompt records the question with a null answer.
  recordHook?.(p.workspaceId, p.agentId, {
    type: 'ask',
    questions: p.questions,
    answers: result.ok ? result.answers ?? [] : null,
  });
  p.resolve(result);
}

/** The user answered (ipc `ask:answer`). */
export function submitAskAnswer(askId: string, answers: AskAnswer[], cancelled?: boolean): void {
  resolveAsk(askId, cancelled ? { ok: false, cancelled: true } : { ok: true, answers });
}

/** The run died or the socket dropped before an answer — unblock the CLI. */
export function cancelAsk(askId: string): void {
  resolveAsk(askId, { ok: false, cancelled: true });
}

/** Cancel every pending ask for a (workspace, agent) — used when its turn is
 *  stopped so a killed agent never leaves the picker stuck on screen. */
export function cancelAsksFor(workspaceId: string, agentId: number): void {
  for (const [id, p] of pending) {
    if (p.workspaceId === workspaceId && p.agentId === agentId) cancelAsk(id);
  }
}
