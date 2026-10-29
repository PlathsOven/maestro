import { isDirectWorkspace, type ChatMeta, type Project, type ProjectCaps, type Workspace } from '../../shared/types';

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

/** Whether `wsId` is a direct workspace (the user's own checkout) — the gate every
 *  renderer entry point to the automatic branch/PR lifecycle checks, so a hidden
 *  button, the command palette and a shortcut all refuse alike, before any
 *  progress toast. Main enforces the same rule. */
export function isDirectIn(s: { workspaces: Workspace[]; projects: Project[] }, wsId: string | null | undefined): boolean {
  const ws = wsId ? s.workspaces.find((w) => w.id === wsId) : undefined;
  return !!ws && isDirectWorkspace(ws, s.projects.find((p) => p.id === ws.projectId));
}

/** The direct workspace a "New workspace → Existing working directory" request
 *  for this project reuses, if one is live (main reuses the same one). */
export function liveDirectWorkspace(
  s: { workspaces: Workspace[]; projects: Project[] },
  projectId: string
): Workspace | undefined {
  return s.workspaces
    .filter((w) => w.projectId === projectId && !w.archived && isDirectIn(s, w.id))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}
