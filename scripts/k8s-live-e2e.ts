/**
 * Kubernetes workspaces against a REAL cluster (docs/specs/kubernetes-workspaces.md).
 * The sibling of k8s-e2e.ts: that one proves the logic with a fake kubectl, this
 * one proves the thing actually works — a pod is provisioned, sshd answers
 * through the tunnel, a worktree lands on the PVC, a journaled turn drains on
 * the node, the forward survives being killed, and the pod survives being
 * deleted. Opt-in (never in CI — it needs a cluster and several minutes):
 *
 *   MAESTRO_K8S_CONTEXT=kind-maestro \
 *   MAESTRO_K8S_IMAGE=maestro-workspace-node:dev \
 *   npm run e2e:k8s-live            # add --keep to leave the namespace up
 *
 * It creates its own namespace (default maestro-e2e) and deletes it at the end.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { resolveShellEnv } from '../src/main/env';
import { run } from '../src/main/exec';
import { Hosts, Messages, Settings, Workspaces, initDb } from '../src/main/db';
import { setWindow } from '../src/main/bus';
import { initRemoteHosts, remoteHostFor } from '../src/main/hosts/remote';
import { addK8sCluster, removeK8sCluster } from '../src/main/services/k8shost';
import { NODE_NAME, fingerprintFromPub } from '../src/main/services/kube';
import { addProject, createWorkspace } from '../src/main/services/workspaces';
import { setWorkspaceCloud } from '../src/main/services/cloudmove';
import { sendChat } from '../src/main/services/chat';
import { stopAllFollowers } from '../src/main/services/cloud';
import type { ExecHost } from '../src/main/hosts/types';

const CONTEXT = process.env.MAESTRO_K8S_CONTEXT || '';
const IMAGE = process.env.MAESTRO_K8S_IMAGE || '';
const NS = process.env.MAESTRO_K8S_NAMESPACE || 'maestro-e2e';
const KEEP = process.argv.includes('--keep');
const ROOT = path.join(os.tmpdir(), `maestro-k8s-live-${process.pid}`);
const REPO = path.join(ROOT, 'repo');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await sleep(1000);
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}
/** kubectl straight at the cluster — the out-of-band check on what the app did. */
async function kc(args: string[], timeout = 60_000) {
  return run('kubectl', ['--context', CONTEXT, '-n', NS, ...args], { timeout });
}

/** A fake `claude` in ~/.maestro/bin on the NODE. SshHost prepends that dir to
 *  the agent PATH, so the drain loop runs this instead of the baked-in CLI —
 *  the turn is real (detached, journaled, drained on the pod), the model isn't. */
const FAKE_CLAUDE = `#!/bin/sh
case "$1" in --version) echo "claude-fake 1.0.0"; exit 0;; esac
cat >/dev/null 2>&1
printf '{"type":"system","subtype":"init","session_id":"S1"}\\n'
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from $(hostname)"}]}}\\n'
printf '{"type":"result","subtype":"success","session_id":"S1","is_error":false,"total_cost_usd":0.01,"duration_ms":10,"result":"hello from $(hostname)"}\\n'
`;

function agentText(workspaceId: string): string[] {
  return Messages.list(workspaceId)
    .filter((m) => m.role === 'agent')
    .map((m) => {
      try {
        return (JSON.parse(m.content) as any[]).map((b) => (b.type === 'text' ? b.text : '')).join('');
      } catch {
        return '';
      }
    });
}

async function main() {
  if (!CONTEXT) throw new Error('Set MAESTRO_K8S_CONTEXT to a kubeconfig context');
  process.env.MAESTRO_HOME = path.join(ROOT, 'maestro-home');
  resolveShellEnv();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  initDb(path.join(ROOT, 'db.sqlite'));
  setWindow({ isDestroyed: () => false, isFocused: () => true, webContents: { send: () => {} } } as any);
  Settings.setGlobal({ harnessApiKeys: { 'claude-code': 'test-key' }, notifications: false });
  initRemoteHosts();

  console.log(`\n--- cluster: ${CONTEXT} · namespace: ${NS} · image: ${IMAGE || '(default)'} ---\n`);

  // ---------- 1. add the cluster ----------
  const added = await addK8sCluster({ context: CONTEXT, namespace: NS, image: IMAGE || undefined, label: 'e2e cluster' });
  check('cluster added', added.ok && !!added.hostId, added.error ?? '');
  const hostId = added.hostId!;
  const keyPath = Hosts.get(hostId)!.keyPath!;
  check('a client key was generated for it', fs.existsSync(keyPath) && fs.existsSync(`${keyPath}.pub`), keyPath);

  // ---------- 2. connect = provision + tunnel + ssh ----------
  const host = remoteHostFor(hostId)! as ExecHost & { connect(): Promise<void>; dispose(): void };
  const t0 = Date.now();
  await host.connect();
  console.log(`(provision + connect took ${Math.round((Date.now() - t0) / 1000)}s)`);

  for (const [what, args] of [
    ['namespace', ['get', 'namespace', NS, '-o', 'name']],
    ['secret', ['get', 'secret', 'maestro-client-key', '-o', 'name']],
    ['pvc', ['get', 'pvc', 'maestro-home', '-o', 'name']],
    ['statefulset', ['get', `statefulset/${NODE_NAME}`, '-o', 'name']],
  ] as const) {
    const r = what === 'namespace' ? await run('kubectl', ['--context', CONTEXT, ...args]) : await kc([...args]);
    check(`the ${what} exists on the cluster`, r.ok, r.stdout.trim() || r.stderr.trim());
  }
  const pvcPhase = (await kc(['get', 'pvc', 'maestro-home', '-o', 'jsonpath={.status.phase}'])).stdout.trim();
  check('the PVC is Bound', pvcPhase === 'Bound', pvcPhase);
  const ready = (await kc(['get', `statefulset/${NODE_NAME}`, '-o', 'jsonpath={.status.readyReplicas}'])).stdout.trim();
  check('the node is ready (1 replica)', ready === '1', ready);
  const svc = await kc(['get', 'svc', '-o', 'name']);
  check('nothing is exposed (no Service/Ingress)', !svc.stdout.trim(), svc.stdout.trim());

  // The pin must equal what the pod actually holds — checked out-of-band.
  const podPub = await kc(['exec', `statefulset/${NODE_NAME}`, '--', 'cat', '/home/maestro/.maestro-node/hostkeys/ssh_host_ed25519_key.pub']);
  const podFp = fingerprintFromPub(podPub.stdout);
  check('the pinned host key is the pod’s own', Hosts.get(hostId)?.hostKeyFingerprint === podFp, `${Hosts.get(hostId)?.hostKeyFingerprint} vs ${podFp}`);

  // ---------- 3. it is an ordinary POSIX box over the tunnel ----------
  const whoami = await host.exec('whoami', []);
  check('ssh through the tunnel works, as user maestro', whoami.ok && whoami.stdout.trim() === 'maestro', whoami.stdout.trim() || whoami.stderr.trim());
  const home = await host.exec('sh', ['-lc', 'printf %s "$HOME"']);
  check('home is the PVC mount', home.stdout.trim() === '/home/maestro', home.stdout.trim());
  for (const tool of ['git', 'tmux', 'curl', 'tar', 'node', 'claude']) {
    const r = await host.exec('sh', ['-lc', `command -v ${tool}`]);
    check(`${tool} is pre-baked on the node`, r.ok && !!r.stdout.trim(), r.stdout.trim());
  }
  const probe = path.posix.join('/home/maestro', '.probe');
  await host.fs.write(probe, 'hello sftp');
  check('sftp write/read round-trips', (await host.fs.read(probe)).toString() === 'hello sftp');
  await host.fs.rm(probe);
  check('sftp rm works', !(await host.fs.exists(probe)));

  // ---------- 4. a workspace IS a worktree on the node ----------
  execSync('git init -b main -q && git config user.email t@t && git config user.name t', { cwd: REPO });
  fs.writeFileSync(path.join(REPO, 'hello.txt'), 'committed content\n');
  execSync('git add -A && git commit -q -m init', { cwd: REPO });
  const project = await addProject({ mode: 'local', path: REPO });
  const ws = await createWorkspace({ projectId: project.id, harness: 'claude-code' });
  await waitFor(() => Workspaces.get(ws.id)?.status !== 'setting-up', 60_000, 'local provision');
  Workspaces.patchChat(ws.id, 1, { titleCustom: true, title: 'live' });
  // Tracked edits travel (git stash create); a brand-new untracked file does not.
  fs.appendFileSync(path.join(Workspaces.get(ws.id)!.worktreePath, 'hello.txt'), 'uncommitted edit\n');
  fs.writeFileSync(path.join(Workspaces.get(ws.id)!.worktreePath, 'untracked.txt'), 'untracked\n');

  const moved = await setWorkspaceCloud(ws.id, hostId);
  check('conversation moved onto the cluster node', moved.ok, moved.error ?? '');
  const onNode = Workspaces.get(ws.id)!;
  check('its worktree path is on the node', onNode.worktreePath.startsWith('/home/maestro/maestro/workspaces'), onNode.worktreePath);
  const catCommitted = await kc(['exec', `statefulset/${NODE_NAME}`, '--', 'cat', `${onNode.worktreePath}/hello.txt`]);
  check('committed content arrived via git bundle', catCommitted.stdout.includes('committed content'), catCommitted.stderr.trim());
  const catDirty = await kc(['exec', `statefulset/${NODE_NAME}`, '--', 'cat', `${onNode.worktreePath}/hello.txt`]);
  check('uncommitted edits to tracked files travelled', catDirty.stdout.includes('uncommitted edit'), catDirty.stderr.trim());
  const catUntracked = await kc(['exec', `statefulset/${NODE_NAME}`, '--', 'ls', `${onNode.worktreePath}/untracked.txt`]);
  check('untracked files do NOT travel (git stash create, cloudmove.ts) — same as any cloud box', !catUntracked.ok, catUntracked.stdout.trim());
  const mirror = await kc(['exec', `statefulset/${NODE_NAME}`, '--', 'ls', `/home/maestro/maestro/mirrors/${project.id}.git`]);
  check('the bare mirror lives on the PVC', mirror.ok, mirror.stderr.trim());
  const noCreds = await host.exec('sh', ['-lc', 'ls -a /home/maestro | grep -c "\\.git-credentials\\|\\.netrc" || true']);
  check('no repo credentials were copied to the cluster', noCreds.stdout.trim() === '0', noCreds.stdout.trim());

  // ---------- 5. forwards both ways ----------
  const server = http.createServer((_q, s) => s.end('laptop-says-hi'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const localPort = (server.address() as any).port;
  const { remotePort } = await (host as any).forwardLoopback(localPort);
  const fromNode = await host.exec('sh', ['-lc', `curl -s http://127.0.0.1:${remotePort}`]);
  check('reverse forward: the node reaches the laptop (ask/role bridge)', fromNode.stdout.includes('laptop-says-hi'), fromNode.stdout || fromNode.stderr);
  server.close();

  await host.exec('sh', ['-lc', 'nohup node -e "require(\'http\').createServer((q,s)=>s.end(\'node-says-hi\')).listen(4399)" >/dev/null 2>&1 & sleep 1']);
  const { localPort: mapped } = await (host as any).forwardOut(4399);
  const fromLaptop = await new Promise<string>((resolve) => {
    http.get(`http://127.0.0.1:${mapped}`, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve(b));
    }).on('error', (e) => resolve(`ERR ${e.message}`));
  });
  check('forward-out: a dev server on the node opens locally', fromLaptop.includes('node-says-hi'), fromLaptop);

  // ---------- 6. a real detached, journaled turn ON the cluster ----------
  const binDir = '/home/maestro/.maestro/bin';
  await host.fs.mkdirp(binDir);
  await host.fs.write(path.posix.join(binDir, 'claude'), FAKE_CLAUDE);
  await host.fs.chmod(path.posix.join(binDir, 'claude'), 0o755);
  await sendChat({ workspaceId: ws.id, agentId: 1, text: 'say hi', attachments: [] });
  const got = await waitFor(() => agentText(ws.id).some((t) => t.includes('hello from')), 120_000, 'the turn to drain on the node');
  check('a journaled turn ran on the pod and came back', got, agentText(ws.id).join(' | ').slice(0, 120));
  const journal = await kc(['exec', `statefulset/${NODE_NAME}`, '--', 'sh', '-c', `ls /home/maestro/maestro/cloud/${ws.id}/1/`]);
  check('the journal lives on the PVC', /journal|queue/.test(journal.stdout), journal.stdout.trim() || journal.stderr.trim());

  // ---------- 7. the tunnel is supervised ----------
  try {
    execSync(`pkill -f "port-forward statefulset/${NODE_NAME}"`);
  } catch {
    // already gone
  }
  const back = await waitFor(async () => (await host.exec('true', [])).ok, 90_000, 'the tunnel to come back');
  check('a killed port-forward is restarted and ssh resumes', back);

  // ---------- 8. a pod reschedule keeps everything ----------
  const fpBefore = Hosts.get(hostId)?.hostKeyFingerprint;
  await kc(['delete', 'pod', `${NODE_NAME}-0`, '--wait=false']);
  await sleep(5000);
  const rolled = await kc(['rollout', 'status', `statefulset/${NODE_NAME}`, '--timeout=180s'], 200_000);
  check('the pod came back', rolled.ok, rolled.stderr.trim());
  const alive = await waitFor(async () => (await host.exec('true', [])).ok, 120_000, 'ssh after reschedule');
  check('the app reconnects after a reschedule', alive);
  check('the host key survived (no re-pin, no warning)', Hosts.get(hostId)?.hostKeyFingerprint === fpBefore, `${fpBefore} → ${Hosts.get(hostId)?.hostKeyFingerprint}`);
  const survived = await host.exec('cat', [`${onNode.worktreePath}/hello.txt`]);
  check('the worktree survived on the PVC', survived.stdout.includes('uncommitted edit'), survived.stdout.trim() || survived.stderr.trim());

  // ---------- 9. bring it home ----------
  const homeAgain = await setWorkspaceCloud(ws.id, null);
  check('bring local succeeded', homeAgain.ok, homeAgain.error ?? '');
  const local = Workspaces.get(ws.id)!;
  check('the workspace is local again', local.hostId === null && fs.existsSync(path.join(local.worktreePath, 'hello.txt')), local.worktreePath);
  check('uncommitted edits came back too', fs.readFileSync(path.join(local.worktreePath, 'hello.txt'), 'utf8').includes('uncommitted edit'));

  // ---------- 10. detach ----------
  stopAllFollowers();
  host.dispose();
  if (!KEEP) {
    const removed = await removeK8sCluster(hostId, true);
    check('cluster detached + namespace deleted', removed.ok, removed.error ?? '');
    check('the host row is gone', Hosts.get(hostId) === null);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL LIVE K8S E2E CHECKS PASSED');
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('K8S_LIVE_E2E_FAIL', e);
  process.exit(1);
});
