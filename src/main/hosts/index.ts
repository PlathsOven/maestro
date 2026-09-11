import { Projects } from '../db';
import { localHost } from './local';
import type { ExecHost } from './types';
import type { Project, Workspace } from '../../shared/types';

export { localHost } from './local';

/**
 * Resolve which host a project's processes and files live on. hostId null = this
 * machine (LocalHost); otherwise the SshHost for that host row, created lazily
 * and cached. The SSH layer injects the factory (setSshHostFactory) so this
 * module has no static dependency on ssh2.
 */

const cache = new Map<string, ExecHost>(); // hostId -> connected SshHost
let sshFactory: ((hostId: string) => ExecHost | null) | null = null;

/** Called by the ssh layer at startup to supply the SshHost constructor. */
export function setSshHostFactory(fn: (hostId: string) => ExecHost | null): void {
  sshFactory = fn;
}

/** Forget a cached host so the next resolution rebuilds it from its (edited,
 *  re-pinned, or removed) row. Called by the host layer's drop path — without it
 *  a disposed host stays reachable through this cache. */
export function dropHostCache(hostId: string): void {
  cache.delete(hostId);
}

export function hostById(hostId: string | null | undefined): ExecHost {
  if (!hostId) return localHost;
  const existing = cache.get(hostId);
  if (existing) return existing;
  const created = sshFactory?.(hostId) ?? null;
  if (created) {
    cache.set(hostId, created);
    return created;
  }
  // No factory / unknown host: fall back to local so callers never crash. Remote
  // features simply stay unavailable until the ssh layer is wired.
  return localHost;
}

export function hostForProject(project: Project): ExecHost {
  return hostById(project.hostId);
}

/**
 * Which host a *workspace's* processes and files live on. A per-conversation
 * cloud override (`ws.hostId`, spec §6.1) wins over the project's host — that
 * one resolution is what makes the entire existing remote machinery (agent
 * spawn, git, scripts, ptys, status, watcher, PR) apply to a cloud workspace of
 * a local project. Unset ⇒ inherit the project's host (today's behavior).
 */
export function hostForWorkspace(ws: Workspace): ExecHost {
  if (ws.hostId) return hostById(ws.hostId);
  const project = Projects.get(ws.projectId);
  return project ? hostForProject(project) : localHost;
}

/** True when this workspace runs in the cloud — either an SSH project or a
 *  per-conversation cloud override on a local project. */
export function isCloudWorkspace(ws: Workspace): boolean {
  return hostForWorkspace(ws).id !== 'local';
}

/** Dispose every cached SSH host (app quit). */
export function disposeAllHosts(): void {
  for (const [, h] of cache) h.dispose?.();
  cache.clear();
}
