import type { SshHostConfig } from '../../shared/types';

/**
 * How a saved host reads on screen. An SSH box is an address you could type into
 * a terminal; a Kubernetes cluster is a context/namespace — its `user@host` is
 * bookkeeping, not somewhere you can connect to (kubernetes-workspaces.md §3.1).
 */
export function hostAddress(h: SshHostConfig): string {
  return h.kind === 'k8s' ? `${h.k8s?.context}/${h.k8s?.namespace}` : `${h.user}@${h.host}`;
}

/** Label + address, for pickers that list every host in one line. */
export function hostLabel(h: SshHostConfig): string {
  return h.kind === 'k8s' ? `${h.label} — k8s · ${hostAddress(h)}` : `${h.label} — ${hostAddress(h)}`;
}
