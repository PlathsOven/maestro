import type { ChatMeta, Project, ProjectCaps } from '../../shared/types';

/**
 * Store-free helpers shared by the store (app.ts) and its push event wiring
 * (events.ts). They live here so events.ts never imports app.ts at runtime;
 * app.ts re-exports the public ones.
 */

export type ChatsMeta = Record<string, Record<string, ChatMeta>>;

/** `all` with one chat's meta shallow-merged with `patch`. */
export function patchChatMeta(all: ChatsMeta, wsId: string, agentId: number, patch: Partial<ChatMeta>): ChatsMeta {
  return { ...all, [wsId]: { ...all[wsId], [String(agentId)]: { ...all[wsId]?.[String(agentId)], ...patch } } };
}

/** Stable empty references — selectors must never fabricate fresh arrays. */
export const EMPTY_ARR: never[] = [];

/** Capability fallbacks used before main's `projectCaps` arrives (kept as stable
 *  refs so caps selectors don't churn). Every git/GitHub surface derives from a
 *  project's caps; a folder project reaches none of them. */
const NO_CAPS: ProjectCaps = { git: false, worktrees: false, githubRemote: false, githubOwner: null, checkpoints: false };
const GIT_FALLBACK: ProjectCaps = { git: true, worktrees: true, githubRemote: false, githubOwner: null, checkpoints: false };

/** Resolve a project's capability rung from store state. Falls back to a
 *  kind-derived guess (git chrome shows, PR waits for the probe) so the UI is
 *  right on the first paint after a project is added, before caps load. */
export function capsOf(
  s: { projectCaps: Record<string, ProjectCaps>; projects: Project[] },
  projectId: string | null | undefined
): ProjectCaps {
  if (!projectId) return NO_CAPS;
  const stored = s.projectCaps[projectId];
  if (stored) return stored;
  return s.projects.find((p) => p.id === projectId)?.kind === 'git' ? GIT_FALLBACK : NO_CAPS;
}
