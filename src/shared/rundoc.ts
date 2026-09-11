// A run-script "doc" is instructional markdown: prose explains why, and every
// fenced shell code block is a command that actually executes in the workspace
// terminal, top to bottom. This parser is shared by the main process (which
// joins the blocks into the script that runs) and the renderer (which renders
// prose and command blocks distinctly in the editor).

export type RunDocSegment =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; code: string; lang: string };

const FENCE_RE = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm;

/** Split a doc into alternating prose and fenced-code segments (in order). */
export function parseRunDoc(doc: string): RunDocSegment[] {
  const segments: RunDocSegment[] = [];
  let last = 0;
  FENCE_RE.lastIndex = 0;
  for (let m = FENCE_RE.exec(doc); m; m = FENCE_RE.exec(doc)) {
    const prose = doc.slice(last, m.index).trim();
    if (prose) segments.push({ kind: 'prose', text: prose });
    segments.push({ kind: 'code', code: m[2].replace(/\s+$/, ''), lang: m[1].trim().toLowerCase() });
    last = m.index + m[0].length;
  }
  const tail = doc.slice(last).trim();
  if (tail) segments.push({ kind: 'prose', text: tail });
  return segments;
}

/** Code-block languages treated as executable shell. Unlabeled blocks count too
 *  — in a run doc, a bare fence is a command by convention. */
const SHELL_LANGS = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'terminal']);

export function isShellSegment(seg: RunDocSegment): seg is Extract<RunDocSegment, { kind: 'code' }> {
  return seg.kind === 'code' && SHELL_LANGS.has(seg.lang);
}

/**
 * The commands a doc executes: all shell blocks joined in order. Returns ''
 * when the doc has no executable blocks (the UI disables Run in that case).
 */
export function extractRunCommands(doc: string): string {
  return parseRunDoc(doc)
    .filter(isShellSegment)
    .map((s) => s.code)
    .join('\n')
    .trim();
}

/** The doc's headline command for card previews — the last non-comment line,
 *  which is usually the payoff (`npm run dev`), not the preamble (`npm install`). */
export function firstCommandLine(doc: string): string {
  const lines = extractRunCommands(doc)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines[lines.length - 1] ?? '';
}

/** Starter template for a hand-made script. */
export function blankRunDoc(): string {
  return (
    'Explain what this script does and why here — prose is documentation.\n\n' +
    'Each shell code block below actually runs in the workspace terminal, in order:\n\n' +
    '```sh\necho "hello from this workspace"\n```\n'
  );
}
