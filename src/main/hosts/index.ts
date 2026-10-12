import { Projects } from '../db';
import { localHost } from './local';
import pathMod from 'path';
import type { ExecHost, ExecResult, HostChild, HostPty } from './types';
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
  // No such host row (removed, or the ssh layer isn't wired yet). Never fall
  // back to this machine: the paths are the remote's, so git/fs/scripts would
  // run against whatever happens to live at them locally. Every operation
  // fails with an explanation instead. Not cached, so a re-added row resolves.
  return unavailableHost(hostId);
}

const warnedMissing = new Set<string>();

/** A host whose row is gone: every exec/spawn/pty/fs call fails with `why`. */
function unavailableHost(hostId: string): ExecHost {
  const why = `This workspace's remote host (${hostId}) is no longer set up in Maestro. Add the host again, or move the workspace to another host.`;
  if (!warnedMissing.has(hostId)) {
    warnedMissing.add(hostId);
    console.warn(`[hosts] unknown host ${hostId}; operations on it will fail`);
  }
  const failed: ExecResult = { ok: false, stdout: '', stderr: why, exitCode: 1 };
  const reject = async (): Promise<never> => {
    throw new Error(why);
  };
  const child = (): HostChild => {
    const onErr: ((c: string) => void)[] = [];
    const onClose: ((code: number | null) => void)[] = [];
    // Report after the caller has attached its listeners.
    setTimeout(() => {
      onErr.forEach((cb) => cb(why));
      onClose.forEach((cb) => cb(1));
    }, 0);
    return {
      onStdoutLine() {},
      onStdout() {},
      onStderr: (cb) => void onErr.push(cb),
      onClose: (cb) => void onClose.push(cb),
      onError() {},
      writeStdin() {},
      endStdin() {},
      kill() {},
    };
  };
  const pty = (): HostPty => {
    const onData: ((c: string) => void)[] = [];
    const onExit: ((code: number) => void)[] = [];
    setTimeout(() => {
      onData.forEach((cb) => cb(`\r\n[maestro] ${why}\r\n`));
      onExit.forEach((cb) => cb(1));
    }, 0);
    return { onData: (cb) => void onData.push(cb), onExit: (cb) => void onExit.push(cb), write() {}, resize() {}, kill() {} };
  };
  return {
    id: hostId,
    platform: 'linux',
    exec: async () => failed,
    spawnStream: child,
    pty,
    fs: { read: reject, write: reject, mkdirp: reject, exists: async () => false, stat: reject, readdir: reject, rm: reject, chmod: reject },
    watch: () => () => {},
    path: pathMod.posix,
  };
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
