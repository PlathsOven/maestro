/**
 * Prompt-refinement validation unit test (§3).
 *
 * `validateRefinement()` is the guardrail that stops a model's refusal or answer
 * from becoming the user's message. A false accept sends garbage to the agent;
 * a false reject silently falls back to the raw prompt (safe). The shapes are
 * pinned here — a clean rewrite, UNCHANGED, refusals in and out of the tags,
 * bloat/collapse, a dropped @mention, and the tricky case where the raw prompt
 * itself contains meta-language.
 *
 * Pure regex, no electron/db/llm at runtime (tree-shaken out). Run under plain
 * node via `npm run test:refine`.
 */
import { validateRefinement } from '../src/main/services/refine';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

// A clean tagged rewrite: ok, text extracted, surrounding """ stripped.
{
  const raw = 'please fix the login bug in the auth flow it keeps failing';
  const v = validateRefinement(raw, '<refined>"""\nFix the login bug in the auth flow that keeps failing.\n"""</refined>');
  ok('tagged rewrite → ok', v.ok === true);
  ok('tagged rewrite extracts text', v.ok && v.text === 'Fix the login bug in the auth flow that keeps failing.', v.ok ? v.text : '');
}

// UNCHANGED → not ok, reason 'unchanged' (user's words go out silently).
{
  const v = validateRefinement('some prompt here that is long enough', 'UNCHANGED');
  ok('UNCHANGED → unchanged', !v.ok && v.reason === 'unchanged');
}

// A bare refusal (no tags) → rejected.
{
  const v = validateRefinement('add a dark mode toggle to the settings page', "I can't refine this — it's a request rather than a prompt.");
  ok('bare refusal → rejected', !v.ok && v.reason === 'rejected');
}

// A refusal that slipped inside the tags → rejected via META.
{
  const raw = 'add a dark mode toggle to the settings page please';
  const v = validateRefinement(raw, '<refined>I cannot refine this without more context about your app.</refined>');
  ok('refusal inside tags → rejected (META)', !v.ok && v.reason === 'rejected');
}

// A short prompt blown up into a 400-char rewrite → rejected (bloat).
{
  const raw = 'fix the bug';
  const v = validateRefinement(raw, `<refined>${'x'.repeat(400)}</refined>`);
  ok('bloat → rejected', !v.ok && v.reason === 'rejected');
}

// Collapse (rewrite far shorter than the raw) → rejected.
{
  const raw = 'here is a very detailed and specific request with lots of important nuance and constraints to preserve';
  const v = validateRefinement(raw, '<refined>fix it</refined>');
  ok('collapse → rejected', !v.ok && v.reason === 'rejected');
}

// A dropped @mention anchor → rejected.
{
  const raw = 'update the parser in @src/foo.ts to handle empty input gracefully';
  const v = validateRefinement(raw, '<refined>Update the parser to handle empty input gracefully.</refined>');
  ok('dropped @mention → rejected', !v.ok && v.reason === 'rejected');
  const kept = validateRefinement(raw, '<refined>Update the parser in @src/foo.ts to handle empty input gracefully.</refined>');
  ok('kept @mention → ok', kept.ok === true);
}

// A dropped `code` / URL anchor → rejected.
{
  const raw = 'run `npm test` and open https://example.com/docs for reference';
  const v = validateRefinement(raw, '<refined>Run the tests and open the docs for reference.</refined>');
  ok('dropped code/URL → rejected', !v.ok && v.reason === 'rejected');
}

// The raw prompt itself contains meta-language ("I need more"): a faithful
// rewrite that echoes it must still be accepted (META only rejects when the
// commentary is new).
{
  const raw = 'tell the agent: I need more logging around the retry loop so I can debug it';
  const v = validateRefinement(raw, '<refined>Tell the agent I need more logging around the retry loop so I can debug it.</refined>');
  ok('meta in raw + faithful rewrite → ok', v.ok === true, v.ok ? '' : v.reason);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
