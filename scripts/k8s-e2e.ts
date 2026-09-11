/**
 * Kubernetes-workspaces verification (spec docs/specs/kubernetes-workspaces.md).
 * No cluster required: a fake `kubectl` on PATH records every invocation and
 * answers the handful of calls provisioning makes, and the port-forward it
 * spawns is a real TCP listener — so the tunnel is exercised end to end (the
 * inner SshHost really dials the forwarded port) without an sshd.
 *
 * Asserts:
 *   - host rows carry kind/k8s config through SQLite, and old rows stay 'ssh'
 *   - the kind-aware factory hands out a K8sHost for a cluster row, an SshHost
 *     otherwise, cached per row id (so the bridge/host caches key identically)
 *   - manifests are one idempotent apply: namespace + secret + PVC + statefulset,
 *     with the client key base64'd (never interpolated) into authorized_keys
 *   - the node's host key is read over the kubectl channel and pinned BEFORE the
 *     first SSH byte, in the same fingerprint format SshHost compares against
 *   - connect() opens `kubectl port-forward` and the inner host dials THAT port
 *   - a dropped forward is restarted by the supervisor (backoff), so a paused
 *     stream is the worst case
 *   - every ExecHost method delegates to the inner host (nothing forks on kind)
 *   - preflight/doctor rows name the exact failing thing (no kubectl, no RBAC)
 *   - the backend-selection chain: picker → project → settings → local
 *   - detaching a cluster refuses while conversations live on it, and forgets
 *     every saved pointer at the row it removes
 *
 *   npm run e2e:k8s
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import jsYaml from 'js-yaml';
import { resolveShellEnv } from '../src/main/env';
import { Hosts, Projects, Settings, Workspaces, initDb, now, uid } from '../src/main/db';
import { setWindow } from '../src/main/bus';
import { hostById } from '../src/main/hosts';
import { K8sHost, dropK8sHost, k8sHostFor } from '../src/main/hosts/k8s';
import { initRemoteHosts, remoteHostFor } from '../src/main/hosts/remote';
import { SshHost } from '../src/main/hosts/ssh';
import { forgetHostReferences, removeK8sCluster } from '../src/main/services/k8shost';
import { hostDoctor } from '../src/main/services/hostdoctor';
import {
  DEFAULT_IMAGE,
  HOST_KEY_PUB,
  NODE_NAME,
  PVC_NAME,
  SECRET_MOUNT,
  SECRET_NAME,
  fingerprintFromPub,
  k8sPreflight,
  manifests,
  provisionNode,
} from '../src/main/services/kube';
import { effectiveCloudHostId, type Project, type SshHostConfig, type Workspace } from '../src/shared/types';

const ROOT = path.join(os.tmpdir(), `maestro-k8s-e2e-${process.pid}`);
const FAKE_BIN = path.join(ROOT, 'bin');
const STATE = path.join(ROOT, 'state'); // what the fake kubectl records
const CALLS = path.join(STATE, 'calls.log');
const APPLIED = path.join(STATE, 'applied.yaml');
const FORWARDS = path.join(STATE, 'forwards.log');
const CONNECTS = path.join(STATE, 'connects.log');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(100);
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

/**
 * The fake cluster. `kubectl` is a node script so port-forward can hold a real
 * socket open; every call is appended to calls.log, and MAESTRO_FAKE_KUBECTL
 * ('ok' | 'missing' | 'norbac') picks the scenario.
 */
const FAKE_KUBECTL = `#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const argv = process.argv.slice(2);
const mode = process.env.MAESTRO_FAKE_KUBECTL || 'ok';
fs.appendFileSync(${JSON.stringify(CALLS)}, argv.join(' ') + '\\n');
const has = (s) => argv.includes(s);

if (has('version')) {
  console.log(JSON.stringify({ clientVersion: { gitVersion: 'v1.30.0' }, serverVersion: { gitVersion: 'v1.30.2' } }));
  process.exit(0);
}
if (has('config')) {
  if (has('get-contexts')) { console.log('kind-maestro\\nprod-cluster'); process.exit(0); }
  if (has('current-context')) { console.log('kind-maestro'); process.exit(0); }
  if (has('view')) {
    console.log(JSON.stringify({ contexts: [
      { name: 'kind-maestro', context: { cluster: 'kind', namespace: 'default' } },
      { name: 'prod-cluster', context: { cluster: 'prod', namespace: 'apps' } },
    ] }));
    process.exit(0);
  }
}
if (has('auth') && has('can-i')) {
  // 'norbac' denies exactly one verb, so the row must name it.
  if (mode === 'norbac' && argv.includes('statefulsets.apps')) { console.log('no'); process.exit(1); }
  console.log('yes'); process.exit(0);
}
if (has('apply')) {
  let body = '';
  try { body = fs.readFileSync(0, 'utf8'); } catch {}
  fs.writeFileSync(${JSON.stringify(APPLIED)}, body);
  console.log('applied'); process.exit(0);
}
if (has('rollout')) { console.log('statefulset rolling update complete'); process.exit(0); }
if (has('wait')) { console.log('pod/maestro-node-0 condition met'); process.exit(0); }
if (has('exec')) {
  // 'racy' reproduces the real cluster: the first exec lands before the
  // container is attachable, exactly as kubectl reports it.
  if (mode === 'racy') {
    const marker = ${JSON.stringify(STATE)} + '/exec-raced';
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, '1');
      console.error('error: unable to upgrade connection: container not found ("node")');
      process.exit(1);
    }
  }
  console.log(fs.readFileSync(process.env.MAESTRO_FAKE_HOSTKEY_PUB, 'utf8').trim());
  process.exit(0);
}
if (has('get')) {
  if (argv.includes('storageclass')) {
    console.log(JSON.stringify({ items: [ { metadata: { name: 'standard', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } } } ] }));
    process.exit(0);
  }
  if (argv.some((a) => a.startsWith('statefulset'))) { console.log('1/1'); process.exit(0); }
  console.log(''); process.exit(0);
}
if (has('delete')) { console.log('namespace deleted'); process.exit(0); }
if (has('port-forward')) {
  const spec = argv[argv.length - 1];              // "<local>:22"
  const port = Number(spec.split(':')[0]);
  fs.appendFileSync(${JSON.stringify(FORWARDS)}, argv.join(' ') + '\\n');
  const srv = net.createServer((sock) => {
    fs.appendFileSync(${JSON.stringify(CONNECTS)}, port + '\\n');
    sock.on('error', () => {});
    sock.end();                                     // not an sshd: the dial is the proof
  });
  srv.listen(port, '127.0.0.1', () => console.log('Forwarding from 127.0.0.1:' + port + ' -> 22'));
  process.on('SIGTERM', () => process.exit(0));
  return;
}
console.error('fake kubectl: unhandled ' + argv.join(' '));
process.exit(1);
`;

function lines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function k8sRow(overrides: Partial<SshHostConfig> = {}): SshHostConfig {
  return {
    id: 'cluster1',
    label: 'kind-maestro',
    host: 'kind-maestro/maestro',
    port: 22,
    user: 'maestro',
    auth: 'key',
    keyPath: path.join(ROOT, 'client-key'),
    kind: 'k8s',
    k8s: { context: 'kind-maestro', namespace: 'maestro' },
    ...overrides,
  };
}

function makeProject(over: Partial<Project> = {}): Project {
  const p: Project = {
    id: uid(),
    name: 'proj',
    repoPath: path.join(ROOT, 'repo'),
    kind: 'git',
    hostId: null,
    cloudHostId: null,
    baseBranch: 'main',
    createdAt: now(),
    ...over,
  };
  Projects.insert(p);
  return p;
}

function makeWorkspace(projectId: string, hostId: string | null): Workspace {
  const w: Workspace = {
    id: uid(),
    projectId,
    name: 'ws',
    hostId,
    branch: 'feature',
    wsKind: 'worktree',
    title: null,
    subtitle: null,
    worktreePath: path.join(ROOT, 'wt'),
    harness: 'claude-code',
    status: 'idle',
    port: 4100,
    archived: false,
    createdAt: now(),
    lastUserMessageAt: null,
    prNumber: null,
    prUrl: null,
    prState: null,
    setupError: null,
  };
  Workspaces.insert(w);
  return w;
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.mkdirSync(STATE, { recursive: true });
  process.env.MAESTRO_HOME = path.join(ROOT, 'maestro-home');
  resolveShellEnv();
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.MAESTRO_FAKE_KUBECTL = 'ok';
  fs.writeFileSync(path.join(FAKE_BIN, 'kubectl'), FAKE_KUBECTL, { mode: 0o755 });

  // A real ed25519 key stands in for the node's sshd host key, so the pinned
  // fingerprint can be cross-checked against ssh-keygen's own output.
  const hostKey = path.join(STATE, 'ssh_host_ed25519_key');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'node', '-f', hostKey], { stdio: 'ignore' });
  // A real client key too: with no usable key ANYWHERE (a CI runner has no
  // ~/.ssh and no agent), SshHost fails before it dials, and the tunnel checks
  // below would be testing nothing.
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'client', '-f', path.join(ROOT, 'client-key')], { stdio: 'ignore' });
  process.env.MAESTRO_FAKE_HOSTKEY_PUB = `${hostKey}.pub`;
  const sshKeygenFp =
    execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${hostKey}.pub`], { encoding: 'utf8' })
      .split(/\s+/)
      .find((t) => t.startsWith('SHA256:')) ?? '';

  initDb(path.join(ROOT, 'db.sqlite'));
  setWindow({ isDestroyed: () => false, isFocused: () => true, webContents: { send: () => {} } } as any);
  initRemoteHosts();

  // ---------- 1. the host row ----------
  Hosts.upsert(k8sRow());
  Hosts.upsert({ id: 'box1', label: 'box', host: 'example.com', port: 22, user: 'ubuntu', auth: 'key' });
  const saved = Hosts.get('cluster1')!;
  check('k8s row round-trips its kind', saved.kind === 'k8s', String(saved.kind));
  check(
    'k8s row round-trips its cluster config',
    saved.k8s?.context === 'kind-maestro' && saved.k8s?.namespace === 'maestro',
    JSON.stringify(saved.k8s)
  );
  check('a plain ssh row is still kind ssh', Hosts.get('box1')?.kind === 'ssh');

  // ---------- 2. the kind-aware factory ----------
  const cluster = remoteHostFor('cluster1');
  check('cluster rows build a K8sHost', cluster instanceof K8sHost);
  check('ssh rows still build an SshHost', remoteHostFor('box1') instanceof SshHost);
  check('the K8sHost keeps the row id (bridge/host caches key alike)', cluster?.id === 'cluster1');
  check('hosts are cached per row id', remoteHostFor('cluster1') === cluster);
  check('hostById resolves through the same factory', hostById('cluster1') === cluster);
  check('posix path math (the node is Linux)', cluster?.path.sep === '/' && cluster?.platform === 'linux');

  // ---------- 3. manifests ----------
  const yaml = manifests({ context: 'c', namespace: 'ns-x', image: 'img:1', pvcSize: '5Gi' }, 'ssh-ed25519 AAAAKEY user@host');
  for (const [what, needle] of [
    ['namespace', 'kind: Namespace'],
    ['secret', `name: ${SECRET_NAME}`],
    ['pvc', `name: ${PVC_NAME}`],
    ['statefulset', `name: ${NODE_NAME}`],
  ] as const) {
    check(`manifests include the ${what}`, yaml.includes(needle));
  }
  check('namespace/image/size are substituted', yaml.includes('ns-x') && yaml.includes('img:1') && yaml.includes('5Gi'));
  check('no Service/Ingress/NodePort is created', !/kind: (Service|Ingress)/.test(yaml));
  check('the node runs in k8s mode', yaml.includes('MAESTRO_NODE_MODE') && yaml.includes('"k8s"'));
  // Parse it for real. Hand-written YAML fails on indentation, and a fake kubectl
  // that only records stdin will happily "apply" a document no cluster accepts —
  // which is exactly how the pod template's labels shipped mis-indented once.
  const docs = jsYaml.loadAll(yaml) as any[];
  check('every document is valid YAML', docs.length === 4, `${docs.length} docs`);
  const byKind = new Map(docs.map((d) => [d?.kind, d]));
  check('the documents are the four objects', [...byKind.keys()].join(',') === 'Namespace,Secret,PersistentVolumeClaim,StatefulSet', [...byKind.keys()].join(','));
  const sts = byKind.get('StatefulSet');
  const selector = sts?.spec?.selector?.matchLabels ?? {};
  const podLabels = sts?.spec?.template?.metadata?.labels ?? {};
  check(
    'the pod template carries the selector labels (nested at the right depth)',
    Object.entries(selector).every(([k2, v]) => podLabels[k2] === v) && Object.keys(podLabels).length >= 1,
    `selector=${JSON.stringify(selector)} pod=${JSON.stringify(podLabels)}`
  );
  check('the container mounts the PVC at the node user’s home', sts?.spec?.template?.spec?.containers?.[0]?.volumeMounts?.some((m: any) => m.mountPath === '/home/maestro'));
  check('one replica, no Service object', sts?.spec?.replicas === 1);
  const b64 = yaml.match(/authorized_keys: (\S+)/)?.[1] ?? '';
  check(
    'the client key travels base64 (never interpolated)',
    Buffer.from(b64, 'base64').toString('utf8').trim() === 'ssh-ed25519 AAAAKEY user@host',
    b64
  );

  // ---------- 4. fingerprint format ----------
  const pub = fs.readFileSync(`${hostKey}.pub`, 'utf8');
  check('fingerprintFromPub matches ssh-keygen', fingerprintFromPub(pub) === sshKeygenFp, `${fingerprintFromPub(pub)} vs ${sshKeygenFp}`);

  // ---------- 5. provisioning ----------
  const prov = await provisionNode(Hosts.get('cluster1')!);
  check('provisioning returns the node host key', prov.hostKeyFingerprint === sshKeygenFp, prov.hostKeyFingerprint);
  const applied = fs.readFileSync(APPLIED, 'utf8');
  check('apply received the manifests on stdin', applied.includes(`name: ${NODE_NAME}`) && applied.includes('kind: Namespace'));
  check('the default image is used when none is set', applied.includes(DEFAULT_IMAGE));
  const clientPub = fs.readFileSync(path.join(process.env.MAESTRO_HOME!, 'keys', 'k8s-cluster1.pub'), 'utf8').trim();
  check(
    'the generated client key is the one mounted as authorized_keys',
    Buffer.from(applied.match(/authorized_keys: (\S+)/)?.[1] ?? '', 'base64').toString('utf8').trim() === clientPub
  );
  const applyCalls = lines(CALLS).filter((l) => l.includes('apply'));
  check('apply is namespace-free (documents carry their own)', !applyCalls[0].includes('-n maestro'), applyCalls[0]);
  check('the context is always explicit', applyCalls[0].includes('--context kind-maestro'));
  check('provisioning waits for the node', lines(CALLS).some((l) => l.startsWith('--context') && l.includes('rollout status')));
  check(
    'the host key is read over the kubectl channel, not over SSH',
    lines(CALLS).some((l) => l.includes('exec') && l.includes('ssh_host_ed25519_key.pub'))
  );

  check(
    'provisioning waits on the pod itself, not just the rollout',
    lines(CALLS).some((l) => l.includes('wait --for=condition=Ready pod')),
    ''
  );

  // A cluster answers `exec` a beat after `rollout status` says ready; losing
  // that race must not fail provisioning (found by the live-cluster run).
  process.env.MAESTRO_FAKE_KUBECTL = 'racy';
  const racy = await provisionNode(Hosts.get('cluster1')!);
  check('a lost exec race is retried, not surfaced as a failure', racy.hostKeyFingerprint === sshKeygenFp, racy.hostKeyFingerprint);
  process.env.MAESTRO_FAKE_KUBECTL = 'ok';

  // re-applying is a no-op by construction (idempotent, safe on every connect)
  const before = lines(CALLS).length;
  await provisionNode(Hosts.get('cluster1')!);
  check('provisioning is idempotent (re-apply, no error)', lines(CALLS).length > before);

  // ---------- 6. connect: tunnel + pin ----------
  const host = k8sHostFor('cluster1')!;
  let connectErr = '';
  await host.connect().catch((e) => {
    connectErr = String(e?.message ?? e);
  });
  check('the node host key is pinned on the row', Hosts.get('cluster1')?.hostKeyFingerprint === sshKeygenFp);
  check('the row is normalized to key auth as user maestro', Hosts.get('cluster1')?.user === 'maestro' && Hosts.get('cluster1')?.auth === 'key');
  const fwd = lines(FORWARDS);
  check('connect opened a port-forward to the node', fwd.length === 1, fwd.join(' | '));
  check(
    'port-forward targets the statefulset over the saved context/namespace',
    fwd[0]?.includes(`statefulset/${NODE_NAME}`) && fwd[0]?.includes('--context kind-maestro') && fwd[0]?.includes('-n maestro'),
    fwd[0]
  );
  const fwdPort = Number(fwd[0]?.trim().split(/\s+/).pop()?.split(':')[0]);
  await waitFor(() => lines(CONNECTS).length > 0, 15_000, 'the inner host to dial the tunnel');
  check('the inner SSH host dialed the forwarded port', lines(CONNECTS)[0] === String(fwdPort), `${lines(CONNECTS)[0]} vs ${fwdPort}`);
  // Our fake speaks no SSH, so the handshake must fail — that failure IS the
  // evidence the inner host got a real socket on the tunnel.
  check('connect surfaces the SSH-side failure (fake node speaks no ssh)', !!connectErr, connectErr);

  // ---------- 7. supervision: a dropped forward comes back ----------
  execFileSync('pkill', ['-f', `port-forward statefulset/${NODE_NAME} ${fwdPort}:22`], { stdio: 'ignore' });
  const restarted = await waitFor(() => lines(FORWARDS).length >= 2, 15_000, 'the forward supervisor to restart');
  check('a dropped port-forward is restarted with backoff', restarted, `starts=${lines(FORWARDS).length}`);
  check(
    'the restart keeps the same local port (blind reconnects find it again)',
    lines(FORWARDS)[1] === lines(FORWARDS)[0],
    lines(FORWARDS).slice(0, 2).join(' | ')
  );
  host.dispose();

  // ---------- 8. delegation: nothing downstream forks on kind ----------
  const calls: string[] = [];
  const fake: any = {
    connect: () => (calls.push('connect'), Promise.resolve()),
    exec: (...a: any[]) => (calls.push(`exec:${a[0]}`), Promise.resolve({ ok: true, stdout: '', stderr: '', exitCode: 0 })),
    spawnStream: (cmd: string) => (calls.push(`spawnStream:${cmd}`), {}) as any,
    pty: () => (calls.push('pty'), {}) as any,
    fs: { read: () => (calls.push('fs.read'), Promise.resolve(Buffer.from(''))) },
    watch: () => (calls.push('watch'), () => {}),
    refreshEnv: () => calls.push('refreshEnv'),
    forwardLoopback: (p: number) => (calls.push(`forwardLoopback:${p}`), Promise.resolve({ remotePort: 1 })),
    forwardOut: (p: number) => (calls.push(`forwardOut:${p}`), Promise.resolve({ localPort: 2 })),
    dispose: () => calls.push('dispose'),
  };
  // Provisioned and tunnelled already — this section is about what happens after.
  const delegating = new K8sHost(k8sRow({ id: 'cluster-delegate' })) as any;
  delegating.inner = fake;
  delegating.forward = { child: { kill: () => calls.push('kill-forward') }, port: 1 };
  delegating.provisionedAt = Date.now();
  await delegating.exec('git', ['status']);
  delegating.spawnStream('claude', []);
  delegating.pty({ cwd: '/home/maestro' });
  await delegating.fs.read('/home/maestro/x');
  delegating.watch('/home/maestro', () => {});
  delegating.refreshEnv();
  await delegating.forwardLoopback(41000);
  await delegating.forwardOut(3000);
  check('async entry points ensure the tunnel before delegating', calls.includes('connect'), calls.join(','));
  check(
    'every ExecHost method delegates to the inner host',
    ['exec:git', 'spawnStream:claude', 'pty', 'fs.read', 'watch', 'refreshEnv', 'forwardLoopback:41000', 'forwardOut:3000'].every((c) =>
      calls.includes(c)
    ),
    calls.join(',')
  );
  delegating.dispose();
  check('dispose tears the inner host and the tunnel down', calls.includes('dispose') && calls.includes('kill-forward'));

  // ---------- 9. preflight + doctor ----------
  const rows = await k8sPreflight(Hosts.get('cluster1')!);
  const row = (l: string) => rows.find((r) => r.label === l);
  check('preflight reports kubectl', row('kubectl')?.ok === true, row('kubectl')?.value);
  check('preflight reports the cluster reachable', row('cluster')?.ok === true, row('cluster')?.value);
  check('preflight reports RBAC ok', row('rbac')?.ok === true, row('rbac')?.value);
  check('preflight finds the default StorageClass', row('storage')?.ok === true, row('storage')?.value);
  check('preflight reports the node ready', row('node')?.ok === true, row('node')?.value);

  process.env.MAESTRO_FAKE_KUBECTL = 'norbac';
  const denied = (await k8sPreflight(Hosts.get('cluster1')!)).find((r) => r.label === 'rbac');
  check('a denied verb is named exactly', denied?.ok === false && denied.value.includes('create statefulsets'), denied?.value);

  // "kubectl missing" means NOT ON PATH — hiding the fake isn't enough, because
  // the developer's (or the CI runner's) real kubectl would answer instead and
  // quietly talk to a live cluster. Point PATH at an empty dir for these two.
  process.env.MAESTRO_FAKE_KUBECTL = 'ok';
  const EMPTY_BIN = path.join(ROOT, 'empty-bin');
  fs.mkdirSync(EMPTY_BIN, { recursive: true });
  const realPath = process.env.PATH;
  process.env.PATH = EMPTY_BIN;
  const noKubectl = await k8sPreflight(Hosts.get('cluster1')!);
  check('no kubectl ⇒ one actionable row, no cluster calls', noKubectl.length === 1 && !noKubectl[0].ok, JSON.stringify(noKubectl));
  const doctored = await hostDoctor(
    { id: 'cluster1', exec: () => Promise.reject(new Error('should not be reached')) } as any,
    Hosts.get('cluster1')!
  );
  check('the doctor stops at preflight instead of probing an unreachable box', doctored.rows.length === 1);
  process.env.PATH = realPath;

  // ---------- 10. the backend-selection chain ----------
  const proj = makeProject();
  check('a fresh project defaults to local worktrees', effectiveCloudHostId(proj, { cloud: undefined }) === null);
  check(
    'settings default applies when the project has none',
    effectiveCloudHostId(proj, { cloud: { defaultOn: true, hostId: 'box1' } }) === 'box1'
  );
  check(
    'settings default OFF means local, even with a saved host',
    effectiveCloudHostId(proj, { cloud: { defaultOn: false, hostId: 'box1' } }) === null
  );
  Projects.update({ ...proj, cloudHostId: 'cluster1' });
  const withDefault = Projects.get(proj.id)!;
  check('the project default persists', withDefault.cloudHostId === 'cluster1');
  check(
    'the project default beats the app-wide one',
    effectiveCloudHostId(withDefault, { cloud: { defaultOn: true, hostId: 'box1' } }) === 'cluster1'
  );
  check(
    'an SSH project ignores the chain (its work already runs on its box)',
    effectiveCloudHostId({ hostId: 'box1', cloudHostId: 'cluster1' }, { cloud: { defaultOn: true, hostId: 'box1' } }) === null
  );

  // ---------- 11. detaching a cluster ----------
  const live = makeWorkspace(proj.id, 'cluster1');
  const refused = await removeK8sCluster('cluster1', false);
  check('detach refuses while conversations live on the node', !refused.ok && /back local/i.test(refused.error ?? ''), refused.error);
  Workspaces.update({ ...live, archived: true });
  Settings.setGlobal({ cloud: { defaultOn: true, hostId: 'cluster1' } });
  const gone = await removeK8sCluster('cluster1', true);
  check('detach succeeds once nothing runs there', gone.ok, gone.error ?? '');
  check('the namespace teardown ran', lines(CALLS).some((l) => l.includes('delete namespace maestro')));
  check('the host row is gone', Hosts.get('cluster1') === null);
  check('the project default forgets the detached host', Projects.get(proj.id)?.cloudHostId === null);
  check('the app-wide default forgets it too', Settings.global().cloud?.hostId === null);

  const p2 = makeProject({ cloudHostId: 'box1' });
  forgetHostReferences('box1');
  check('removing an ordinary ssh host clears its pointers as well', Projects.get(p2.id)?.cloudHostId === null);

  // ---------- 12. the image contract (drift between app and node is invisible
  //                until a real cluster, so pin it here) ----------
  const repo = process.cwd();
  const entrypoint = fs.readFileSync(path.join(repo, 'server/maestro-cloud/entrypoint.sh'), 'utf8');
  const signup = fs.readFileSync(path.join(repo, 'server/maestro-cloud/signup.mjs'), 'utf8');
  execFileSync('sh', ['-n', path.join(repo, 'server/maestro-cloud/entrypoint.sh')]); // throws on a syntax error
  check('the entrypoint has a k8s node mode', entrypoint.includes('MAESTRO_NODE_MODE') && entrypoint.includes('"k8s"'));
  check('the manifest asks for exactly that mode', yaml.includes('name: MAESTRO_NODE_MODE') && yaml.includes('value: "k8s"'));
  check(
    'the host key the app reads is the one the node writes',
    entrypoint.includes('$HOME_DIR/.maestro-node/hostkeys') && HOST_KEY_PUB === '/home/maestro/.maestro-node/hostkeys/ssh_host_ed25519_key.pub',
    HOST_KEY_PUB
  );
  check('the node installs the key from the mounted Secret', entrypoint.includes(`${SECRET_MOUNT}/authorized_keys`));
  check('the manifest mounts the Secret there', yaml.includes(`mountPath: ${SECRET_MOUNT}`));
  check('the node listens on the port the tunnel forwards to', yaml.includes('containerPort: 22') && yaml.includes('value: "22"'));
  check(
    'a reschedule re-arms unattended drains',
    entrypoint.includes('--resume-drains') && signup.includes("--resume-drains") && signup.includes('resumeDrains(user)')
  );
  check('sshd runs in the foreground (the pod IS sshd)', /exec \/usr\/sbin\/sshd -D/.test(entrypoint));

  dropK8sHost('cluster-delegate');
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL K8S E2E CHECKS PASSED');
  try {
    execFileSync('pkill', ['-f', 'port-forward statefulset/maestro-node'], { stdio: 'ignore' });
  } catch {
    // nothing left running
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('K8S_E2E_FAIL', e);
  process.exit(1);
});
