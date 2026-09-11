import { Hosts } from '../db';
import { dropHostCache, setSshHostFactory } from './index';
import { dropK8sHost, k8sHostFor } from './k8s';
import { dropSshHost, sshHostFor } from './ssh';
import type { ExecHost } from './types';

/**
 * The one place host *kind* is dispatched (docs/specs/kubernetes-workspaces.md
 * §3.2). A row is either an SSH box the user already has or a Kubernetes cluster
 * that manufactures one; past this function nothing forks on kind, because a
 * K8sHost is an SshHost with a tunnel in front of it.
 */

/** A host row's live host: SshHost or K8sHost, both keyed by the row id. */
export interface RemoteHost extends ExecHost {
  connect(): Promise<void>;
  dispose(): void;
  /** Unlock an encrypted key for this app session (SSH rows only; k8s keys are
   *  app-generated and unencrypted). */
  setPassphrase(p: string | undefined): void;
}

export function remoteHostFor(hostId: string): RemoteHost | null {
  const cfg = Hosts.get(hostId);
  if (!cfg) return null;
  return cfg.kind === 'k8s' ? k8sHostFor(hostId) : sshHostFor(hostId);
}

/** Drop a host's live connection (host:remove / config change / re-pin), cache
 *  included — a disposed host must not survive in the resolver. */
export function dropRemoteHost(hostId: string): void {
  dropSshHost(hostId);
  dropK8sHost(hostId);
  dropHostCache(hostId);
}

/** Wire host creation into the resolver (called once at startup). */
export function initRemoteHosts(): void {
  setSshHostFactory((hostId) => remoteHostFor(hostId));
}
