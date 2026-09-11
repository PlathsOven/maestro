// Pure helpers for the Resolve-conflicts PR mode
// (docs/specs/resolve-conflicts-pr-mode.md). Kept free of store/React imports so
// the prompt and gate logic can be unit-tested directly (scripts/e2e.ts §10).

/**
 * The `noConflicts` merge gate: everything except a definite CONFLICTING reads
 * green, so a still-computing GitHub (UNKNOWN / null) never blocks the row — the
 * merge attempt itself is the backstop, as it is today.
 */
export function noConflictsGate(mergeable: string | null | undefined): boolean {
  return mergeable !== 'CONFLICTING';
}

/**
 * GitHub hasn't answered yet. It computes `mergeable` lazily and the main
 * process only waits a few seconds for it (`github.ts settleMergeable`), so the
 * merge surfaces need "don't know" to be distinct from "clean" — reading UNKNOWN
 * as clean is what let a conflicted PR advertise itself as ready to merge.
 */
export function mergeabilityUnknown(mergeable: string | null | undefined): boolean {
  return mergeable !== 'MERGEABLE' && mergeable !== 'CONFLICTING';
}

/**
 * What to show when `gh pr merge` refuses. gh answers a conflicted PR with a
 * paragraph of remediation shell commands ("…the merge commit cannot be cleanly
 * created. … Run the following to resolve the merge conflicts locally: gh pr
 * checkout 13 && …") — noise in a toast, and advice Maestro can act on itself
 * once the forced re-check flips the UI to Resolve-conflicts. Every other
 * refusal passes through exactly as gh wrote it.
 */
export function mergeFailureMessage(error: string | null | undefined, base: string): string {
  const raw = (error ?? '').trim();
  if (/merge commit cannot be cleanly created/i.test(raw))
    return `This PR has merge conflicts with ${base || 'the base branch'} — resolve them, then merge.`;
  return raw || 'Merge failed';
}

interface ResolvePromptInput {
  number: number;
  title: string;
  /** Plain base branch name, e.g. "main" (from pr.baseRefName). */
  base: string;
  /** Merge target the agent runs, e.g. "origin/main" (from the preflight). */
  baseRef: string;
  /** Would-conflict files from the preflight, or null when git couldn't answer. */
  conflictFiles: string[] | null;
}

/**
 * Compose the conflict-resolution prompt sent to the workspace's agent, per
 * docs/specs/resolve-conflicts-pr-mode.md §5. Fenced values are interpolated and
 * the conflicted-file listing is omitted entirely when the preflight came back
 * empty-handed (null → old git). The abort clause is the G3 safety valve: give up
 * loudly rather than merge over genuinely incompatible decisions.
 */
export function composeResolvePrompt(input: ResolvePromptInput): string {
  const { number, title, base, baseRef, conflictFiles } = input;
  const hasFiles = !!conflictFiles && conflictFiles.length > 0;
  const step3 = hasFiles
    ? `3. Resolve every conflict. Files expected to conflict:\n` +
      conflictFiles!.map((f) => `   - ${f}`).join('\n') +
      `\n   For each one, read both sides and work out what each branch was trying\n` +
      `   to do. Keep the intent of both: this branch's changes AND what landed on\n` +
      `   \`${base}\` (refactors, renames, fixes). Never blindly take one side of a\n` +
      `   conflict marker.`
    : `3. Resolve every conflict. For each one, read both sides and work out what\n` +
      `   each branch was trying to do. Keep the intent of both: this branch's\n` +
      `   changes AND what landed on \`${base}\` (refactors, renames, fixes). Never\n` +
      `   blindly take one side of a conflict marker.`;

  return (
    `Pull request #${number} ("${title}") for this branch has merge conflicts with\n` +
    `\`${base}\` and GitHub can't merge it.\n\n` +
    `Resolve the conflicts by merging the base branch into this branch. Do not\n` +
    `rebase and do not force-push.\n\n` +
    `1. If there is uncommitted work in the worktree, commit it first.\n` +
    `2. Run \`git fetch origin\`, then \`git merge ${baseRef}\`.\n` +
    `${step3}\n` +
    `4. Make sure the project still builds and its tests pass — run whatever\n` +
    `   checks this repo has.\n` +
    `5. Commit the merge and push with \`git push\`.\n\n` +
    `If a conflict reflects genuinely incompatible decisions you cannot safely\n` +
    `reconcile, stop: run \`git merge --abort\` and reply explaining exactly which\n` +
    `files and lines need a human decision.\n\n` +
    `When you're done, reply with a short summary of each conflict and how you\n` +
    `resolved it.`
  );
}
