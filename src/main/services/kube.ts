import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { maestroHome } from '../env';
import { run } from '../exec';
import type { DoctorRow, K8sConfig, K8sContext, SshHostConfig } from '../../shared/types';

/**
 * Manufacturing the workspace node (docs/specs/kubernetes-workspaces.md §3.3).
 * A Kubernetes cluster is not a new kind of host — it's a factory that makes the
 * kind of host we already have: a small always-on box running sshd, reached
 * through a tunnel and handed to SshHost unchanged.
 *
 * Everything here shells out to `kubectl`, the same way the app shells out to
 * `git` and `gh`. That is deliberate: every auth mode a cluster can have (EKS/GKE
 * exec plugins, OIDC refresh, client certs) stays kubectl's problem, and Maestro
 * never reads or stores kubeconfig credentials.
 */

export const NODE_NAME = 'maestro-node';
export const SECRET_NAME = 'maestro-client-key';
export const PVC_NAME = 'maestro-home';
/** The single unprivileged account on the node; its home is the PVC. */
export const NODE_USER = 'maestro';
export const DEFAULT_NAMESPACE = 'maestro';
export const DEFAULT_PVC_SIZE = '20Gi';
/** The Railway box image, published for clusters (§3.3 — one Dockerfile, two
 *  consumers). Overridable per host row for teams who bake their own toolchain. */
export const DEFAULT_IMAGE = process.env.MAESTRO_NODE_IMAGE || 'ghcr.io/plathsoven/maestro-workspace-node:latest';
/** Where the node persists its sshd host key — on the PVC (so the pin survives a
 *  reschedule) and root-only (so the node's own user can't read it). Must match
 *  the image's entrypoint (server/maestro-cloud/entrypoint.sh, k8s branch). */
export const HOST_KEY_PUB = `/home/${NODE_USER}/.maestro-node/hostkeys/ssh_host_ed25519_key.pub`;
/** Where the client-key Secret is mounted; the entrypoint copies it into
 *  ~/.ssh/authorized_keys on every start (the kubelet refreshes the file). */
export const SECRET_MOUNT = '/etc/maestro/keys';

export function k8sConfigOf(cfg: SshHostConfig): K8sConfig {
  return {
    context: cfg.k8s?.context ?? '',
    namespace: cfg.k8s?.namespace || DEFAULT_NAMESPACE,
    image: cfg.k8s?.image || DEFAULT_IMAGE,
    pvcSize: cfg.k8s?.pvcSize || DEFAULT_PVC_SIZE,
  };
}

/** kubectl argv prefix for a cluster: context always explicit, namespace only
 *  where it applies (cluster-scoped verbs pass `all = false`). */
export function kubectlArgs(k: K8sConfig, namespaced = true): string[] {
  return [...(k.context ? ['--context', k.context] : []), ...(namespaced ? ['-n', k.namespace] : [])];
}

/** Run kubectl for a cluster; never throws (the caller reports stderr verbatim). */
export function kubectl(k: K8sConfig, args: string[], opts: { input?: string; timeout?: number; namespaced?: boolean } = {}) {
  return run('kubectl', [...kubectlArgs(k, opts.namespaced ?? true), ...args], {
    timeout: opts.timeout ?? 60_000,
    input: opts.input,
  });
}

/** Is kubectl on PATH, and which version? We never install it (§5). */
export async function kubectlProbe(): Promise<{ ok: boolean; version: string | null; error?: string }> {
  const r = await run('kubectl', ['version', '--client=true', '-o', 'json'], { timeout: 10_000 });
  if (!r.ok) return { ok: false, version: null, error: r.stderr.trim() || 'kubectl not found on PATH' };
  try {
    const v = JSON.parse(r.stdout)?.clientVersion?.gitVersion;
    return { ok: true, version: typeof v === 'string' ? v : 'unknown' };
  } catch {
    return { ok: true, version: r.stdout.trim().split('\n')[0] || 'unknown' };
  }
}

/** Contexts from the user's kubeconfig, for the add-cluster picker (§4). */
export async function listContexts(): Promise<{ kubectl: string | null; contexts: K8sContext[]; error?: string }> {
  const probe = await kubectlProbe();
  if (!probe.ok) return { kubectl: null, contexts: [], error: probe.error };
  const r = await run('kubectl', ['config', 'get-contexts', '-o', 'name'], { timeout: 10_000 });
  if (!r.ok) return { kubectl: probe.version, contexts: [], error: r.stderr.trim() || 'Could not read kubeconfig' };
  const current = (await run('kubectl', ['config', 'current-context'], { timeout: 10_000 })).stdout.trim();
  const names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  // One view call for cluster/namespace detail; a failure just leaves them blank.
  const view = await run('kubectl', ['config', 'view', '-o', 'json'], { timeout: 10_000 });
  const byName = new Map<string, { cluster?: string; namespace?: string }>();
  try {
    for (const c of JSON.parse(view.stdout)?.contexts ?? []) byName.set(c.name, c.context ?? {});
  } catch {
    // best-effort detail
  }
  return {
    kubectl: probe.version,
    contexts: names.map((name) => ({
      name,
      cluster: byName.get(name)?.cluster ?? '',
      namespace: byName.get(name)?.namespace ?? '',
      current: name === current,
    })),
  };
}

// ---------- the client key (one per cluster) ----------

/** The app-generated ed25519 key this cluster's node trusts. Same shape as the
 *  managed-box keypair: generated locally, only the public half ever leaves. */
export async function ensureClientKey(hostId: string): Promise<{ keyPath: string; pubkey: string }> {
  const dir = path.join(maestroHome(), 'keys');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, `k8s-${hostId}`);
  if (!fs.existsSync(keyPath)) {
    const r = await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `maestro-k8s-${hostId}`, '-f', keyPath], {
      timeout: 20_000,
    });
    if (!r.ok || !fs.existsSync(keyPath)) {
      throw new Error(`Couldn't generate an SSH key (ssh-keygen): ${r.stderr.trim() || 'unavailable'}`);
    }
  }
  return { keyPath, pubkey: fs.readFileSync(`${keyPath}.pub`, 'utf8').trim() };
}

// ---------- manifests ----------

/**
 * Everything Maestro creates, in one applyable document. Declarative and
 * idempotent by construction: re-applying on every connect is a no-op once the
 * objects match, and a partly-created namespace is repaired rather than blocked.
 */
export function manifests(k: K8sConfig, pubkey: string): string {
  const ns = k.namespace;
  // Indent is a parameter, not a constant: the same two labels sit under
  // `metadata.labels` (4) and under `spec.template.metadata.labels` (8).
  const labels = (indent: string) =>
    `${indent}app.kubernetes.io/name: ${NODE_NAME}\n${indent}app.kubernetes.io/managed-by: maestro`;
  // The key travels base64'd in `data` (never `stringData`), so no user-supplied
  // bytes are ever interpolated into YAML.
  const authorizedKeys = Buffer.from(`${pubkey.trim()}\n`, 'utf8').toString('base64');
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}
  labels:
${labels('    ')}
---
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_NAME}
  namespace: ${ns}
  labels:
${labels('    ')}
type: Opaque
data:
  authorized_keys: ${authorizedKeys}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${PVC_NAME}
  namespace: ${ns}
  labels:
${labels('    ')}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: ${k.pvcSize || DEFAULT_PVC_SIZE}
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${NODE_NAME}
  namespace: ${ns}
  labels:
${labels('    ')}
spec:
  serviceName: ${NODE_NAME}
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${NODE_NAME}
  template:
    metadata:
      labels:
${labels('        ')}
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: node
          image: ${k.image || DEFAULT_IMAGE}
          imagePullPolicy: IfNotPresent
          env:
            - name: MAESTRO_NODE_MODE
              value: "k8s"
            - name: MAESTRO_NODE_USER
              value: "${NODE_USER}"
            - name: SSH_PORT
              value: "22"
          ports:
            - name: ssh
              containerPort: 22
          volumeMounts:
            - name: home
              mountPath: /home/${NODE_USER}
            - name: client-key
              mountPath: ${SECRET_MOUNT}
              readOnly: true
          readinessProbe:
            tcpSocket:
              port: 22
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
      volumes:
        - name: home
          persistentVolumeClaim:
            claimName: ${PVC_NAME}
        - name: client-key
          secret:
            secretName: ${SECRET_NAME}
            defaultMode: 0400
`;
}

// ---------- provisioning ----------

/** OpenSSH-style SHA256 fingerprint of an `ssh-ed25519 AAAA… comment` line —
 *  the same format SshHost pins (hosts/ssh.ts). */
export function fingerprintFromPub(pub: string): string | null {
  const blob = pub.trim().split(/\s+/)[1];
  if (!blob) return null;
  try {
    const raw = Buffer.from(blob, 'base64');
    if (!raw.length) return null;
    return 'SHA256:' + crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
  } catch {
    return null;
  }
}

export interface ProvisionResult {
  /** The node's sshd host key, read over the authenticated kubectl channel —
   *  a pin without a first-connect leap of faith (§6). */
  hostKeyFingerprint: string;
}

/**
 * Ensure the namespace / Secret / PVC / StatefulSet exist and the node is ready,
 * then read its host key. Safe to call on every connect: `kubectl apply` is
 * idempotent, and a ready node makes the rollout wait return immediately.
 */
export async function provisionNode(
  cfg: SshHostConfig,
  log: (line: string) => void = () => {}
): Promise<ProvisionResult> {
  const k = k8sConfigOf(cfg);
  if (!k.context) throw new Error('This cluster has no kubeconfig context saved — re-add it from Settings → Cloud.');
  const probe = await kubectlProbe();
  if (!probe.ok) throw new Error(`kubectl isn't available: ${probe.error}. Install kubectl and reopen Maestro.`);

  const { pubkey } = await ensureClientKey(cfg.id);
  log(`Applying workspace node to ${k.context}/${k.namespace}…`);
  const applied = await kubectl(k, ['apply', '-f', '-'], {
    input: manifests(k, pubkey),
    timeout: 120_000,
    namespaced: false, // the documents carry their own namespace (incl. the Namespace itself)
  });
  if (!applied.ok) throw new Error(`kubectl apply failed: ${applied.stderr.trim() || applied.stdout.trim()}`);

  log('Waiting for the node to become ready…');
  const rollout = await kubectl(k, ['rollout', 'status', `statefulset/${NODE_NAME}`, '--timeout=300s'], {
    timeout: 320_000,
  });
  if (!rollout.ok) {
    const why = await describeUnready(k);
    throw new Error(`The workspace node didn't become ready: ${rollout.stderr.trim() || rollout.stdout.trim()}${why}`);
  }

  // `rollout status` can return while the pod is still being (re)placed, and the
  // entrypoint writes the host key a beat after the container starts — so an
  // immediate exec loses the race with "container not found" / "no such file".
  // Wait on the pod itself, then retry: this is the one call whose answer we
  // must have before any SSH byte.
  await kubectl(k, ['wait', '--for=condition=Ready', 'pod', '-l', `app.kubernetes.io/name=${NODE_NAME}`, '--timeout=180s'], {
    timeout: 200_000,
  });
  let keyOut = { ok: false, stdout: '', stderr: '', exitCode: -1 };
  for (let attempt = 0; attempt < 8; attempt++) {
    keyOut = await kubectl(k, ['exec', `statefulset/${NODE_NAME}`, '--', 'cat', HOST_KEY_PUB], { timeout: 30_000 });
    const fp = keyOut.ok ? fingerprintFromPub(keyOut.stdout) : null;
    if (fp) return { hostKeyFingerprint: fp };
    if (attempt === 0) log('Waiting for the node’s host key…');
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Couldn't read the node's host key: ${keyOut.stderr.trim() || 'no key at ' + HOST_KEY_PUB}`);
}

/** Why isn't the pod up? Pod events say "no default StorageClass" / "ImagePullBackOff"
 *  in plain words; appended to the rollout failure so the user gets the real cause. */
async function describeUnready(k: K8sConfig): Promise<string> {
  const r = await kubectl(k, ['get', 'pods', '-l', `app.kubernetes.io/name=${NODE_NAME}`, '-o', 'jsonpath={range .items[*]}{.status.phase}{" "}{range .status.containerStatuses[*]}{.state.waiting.reason}{" "}{.state.waiting.message}{end}{end}'], {
    timeout: 20_000,
  });
  const detail = r.stdout.trim();
  return detail ? ` — pod: ${detail}` : '';
}

/** Tear the node down: one namespace holds everything Maestro made (§6). */
export async function deleteNamespace(cfg: SshHostConfig): Promise<{ ok: boolean; error?: string }> {
  const k = k8sConfigOf(cfg);
  const r = await kubectl(k, ['delete', 'namespace', k.namespace, '--wait=false'], { timeout: 60_000, namespaced: false });
  if (r.ok || /not found/i.test(r.stderr)) return { ok: true };
  return { ok: false, error: r.stderr.trim() || 'kubectl delete namespace failed' };
}

// ---------- doctor preflight (§4) ----------

/** RBAC verbs the provisioning path actually uses; each row names the exact
 *  failing command so the user can hand it to whoever owns the cluster. */
const RBAC_CHECKS: [label: string, args: string[], namespaced: boolean][] = [
  ['create namespaces', ['create', 'namespaces'], false],
  ['create statefulsets', ['create', 'statefulsets.apps'], true],
  ['create persistentvolumeclaims', ['create', 'persistentvolumeclaims'], true],
  ['create secrets', ['create', 'secrets'], true],
  ['port-forward pods', ['create', 'pods/portforward'], true],
  ['exec into pods', ['create', 'pods/exec'], true],
];

/** k8s preflight rows, prepended to the host doctor for a cluster host. */
export async function k8sPreflight(cfg: SshHostConfig): Promise<DoctorRow[]> {
  const k = k8sConfigOf(cfg);
  const rows: DoctorRow[] = [];
  const probe = await kubectlProbe();
  rows.push({ label: 'kubectl', value: probe.ok ? (probe.version ?? 'present') : 'missing — install kubectl', ok: probe.ok });
  if (!probe.ok) return rows;

  rows.push({ label: 'context', value: `${k.context || '(current)'} · namespace ${k.namespace}`, ok: !!k.context });

  const ver = await kubectl(k, ['version', '-o', 'json'], { timeout: 20_000, namespaced: false });
  let serverVersion = '';
  try {
    serverVersion = JSON.parse(ver.stdout)?.serverVersion?.gitVersion ?? '';
  } catch {
    // fall through to the raw error below
  }
  rows.push({
    label: 'cluster',
    value: ver.ok ? `reachable${serverVersion ? ` · ${serverVersion}` : ''}` : squash(ver.stderr) || 'unreachable',
    ok: ver.ok,
  });
  if (!ver.ok) return rows;

  const denied: string[] = [];
  for (const [label, args, namespaced] of RBAC_CHECKS) {
    const r = await kubectl(k, ['auth', 'can-i', ...args], { timeout: 20_000, namespaced });
    if (!r.ok || !/^yes/i.test(r.stdout.trim())) denied.push(label);
  }
  rows.push({
    label: 'rbac',
    value: denied.length
      ? `denied: ${denied.join(', ')} (kubectl -n ${k.namespace} auth can-i …)`
      : 'can create everything the node needs',
    ok: denied.length === 0,
  });

  const sc = await kubectl(k, ['get', 'storageclass', '-o', 'json'], { timeout: 20_000, namespaced: false });
  let defaultSc = '';
  try {
    for (const item of JSON.parse(sc.stdout)?.items ?? []) {
      const ann = item?.metadata?.annotations ?? {};
      if (ann['storageclass.kubernetes.io/is-default-class'] === 'true' || ann['storageclass.beta.kubernetes.io/is-default-class'] === 'true') {
        defaultSc = item?.metadata?.name ?? '';
      }
    }
  } catch {
    // no permission to list storage classes is not fatal — the PVC may still bind
  }
  rows.push({
    label: 'storage',
    value: defaultSc ? `default StorageClass: ${defaultSc}` : 'no default StorageClass — the PVC may stay Pending',
    ok: !!defaultSc,
  });

  const sts = await kubectl(k, ['get', `statefulset/${NODE_NAME}`, '-o', 'jsonpath={.status.readyReplicas}/{.status.replicas}'], {
    timeout: 20_000,
  });
  rows.push({
    label: 'node',
    value: sts.ok ? `${NODE_NAME} ${sts.stdout.trim() || '0/0'} ready` : 'not provisioned yet (created on first connect)',
    ok: sts.ok && sts.stdout.trim().startsWith('1/'),
  });
  return rows;
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}
