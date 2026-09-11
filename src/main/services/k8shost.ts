import { Hosts, Projects, Settings, Workspaces, uid } from '../db';
import { dropRemoteHost } from '../hosts/remote';
import { DEFAULT_NAMESPACE, NODE_USER, deleteNamespace, ensureClientKey } from './kube';
import type { SshHostConfig } from '../../shared/types';

/**
 * Add / detach a Kubernetes cluster (docs/specs/kubernetes-workspaces.md §4).
 * The mirror image of cloudaccount.ts for the managed box: this only writes the
 * host row and its client key — the node itself is manufactured lazily on the
 * first connect, so adding a cluster is instant and works offline.
 */

export interface AddClusterOpts {
  context: string;
  namespace?: string;
  image?: string;
  pvcSize?: string;
  label?: string;
}

export async function addK8sCluster(opts: AddClusterOpts): Promise<{ ok: boolean; hostId?: string; error?: string }> {
  const context = opts.context.trim();
  if (!context) return { ok: false, error: 'Pick a kubeconfig context first.' };
  const namespace = (opts.namespace || DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;
  // Kubernetes names: lowercase alphanumerics and '-', starting/ending alphanumeric.
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace) || namespace.length > 63) {
    return { ok: false, error: `"${namespace}" isn't a valid namespace (lowercase letters, digits and dashes).` };
  }
  // One row per context+namespace — re-adding repairs the existing row instead of
  // manufacturing a second node on the same cluster.
  const existing = Hosts.list().find((h) => h.kind === 'k8s' && h.k8s?.context === context && h.k8s?.namespace === namespace);
  const id = existing?.id ?? uid();
  let keyPath: string;
  try {
    ({ keyPath } = await ensureClientKey(id));
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  const host: SshHostConfig = {
    ...existing,
    id,
    label: opts.label?.trim() || existing?.label || context,
    // Bookkeeping only — the live endpoint is the tunnel's loopback port (§3.1).
    host: `${context}/${namespace}`,
    port: 22,
    user: NODE_USER,
    auth: 'key',
    keyPath,
    kind: 'k8s',
    k8s: { context, namespace, image: opts.image?.trim() || undefined, pvcSize: opts.pvcSize?.trim() || undefined },
  };
  Hosts.upsert(host);
  dropRemoteHost(id); // re-provision/re-tunnel with the fresh config on next use
  return { ok: true, hostId: id };
}

/**
 * Detach a cluster. Conversations must come home first (the same guard as
 * leaving the managed box), then optionally `kubectl delete namespace` — one
 * object holds everything Maestro created.
 */
export async function removeK8sCluster(hostId: string, deleteNs: boolean): Promise<{ ok: boolean; error?: string }> {
  const host = Hosts.get(hostId);
  if (!host) return { ok: true };
  const onIt = Workspaces.list().filter((w) => w.hostId === hostId && !w.archived);
  if (onIt.length) {
    return {
      ok: false,
      error: `Bring ${onIt.length} conversation(s) back local before detaching (Sidebar → right-click → Bring local).`,
    };
  }
  let error: string | undefined;
  if (deleteNs && host.kind === 'k8s') {
    const r = await deleteNamespace(host);
    if (!r.ok) error = r.error;
  }
  forgetHostReferences(hostId);
  dropRemoteHost(hostId);
  Hosts.remove(hostId);
  return { ok: !error, error };
}

/** Drop every saved pointer at a host that no longer exists, so a new
 *  conversation can't be aimed at a dead row (it would silently fall back to
 *  this machine). Shared by host:remove and cluster detach. */
export function forgetHostReferences(hostId: string): void {
  for (const p of Projects.list()) {
    if (p.cloudHostId === hostId) Projects.update({ ...p, cloudHostId: null });
  }
  const cloud = Settings.global().cloud;
  if (cloud?.hostId === hostId) Settings.setGlobal({ cloud: { defaultOn: false, hostId: null } });
}
