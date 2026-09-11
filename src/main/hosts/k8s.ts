import net from 'net';
import path from 'path';
import { broadcast } from '../bus';
import { Hosts } from '../db';
import { localHost } from './local';
import { makeTunnelSshHost, type SshHost } from './ssh';
import { NODE_NAME, NODE_USER, k8sConfigOf, kubectlArgs, provisionNode } from '../services/kube';
import type { ExecHost, ExecOpts, ExecResult, HostChild, HostFs, HostPty, HostPtyOpts, SpawnOpts } from './types';
import type { SshHostConfig } from '../../shared/types';

/**
 * K8sHost — provision, tunnel, delegate (docs/specs/kubernetes-workspaces.md §3.2).
 *
 * The only Kubernetes-aware ExecHost, and it implements almost nothing: connect()
 * makes sure the workspace node exists, opens a supervised `kubectl port-forward`
 * to its sshd, and points an inner SshHost at 127.0.0.1:<forwarded>. Every other
 * method forwards to that inner host, so continuation, git-bundle sync, the
 * ask/role/preview bridge, readiness, doctor and the web relay all work here
 * without knowing Kubernetes exists.
 *
 * The inner host carries the SAME id as the row, so the host cache, the bridge
 * cache and `host:state` key identically to any SSH box.
 */

const FORWARD_READY_MS = 30_000;
/** How long a successful `kubectl apply` + rollout wait stays trusted. */
const PROVISION_TTL_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

/** A loopback port that is free right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not reserve a local port'))));
    });
  });
}

export class K8sHost implements ExecHost {
  readonly id: string;
  readonly platform: NodeJS.Platform = 'linux';
  readonly path = path.posix;

  private inner: SshHost | null = null;
  private forward: { child: HostChild; port: number } | null = null;
  private connecting: Promise<void> | null = null;
  private forwarding: Promise<void> | null = null;
  private disposed = false;
  private backoff = 1000;
  private restartTimer: NodeJS.Timeout | null = null;
  /** The loopback port this cluster's tunnel owns. Kept stable across restarts
   *  so the inner host's blind reconnects find the forward again (it re-picks
   *  only if the port turns out to be taken). */
  private port = 0;
  private provisionedAt = 0;

  constructor(private cfg: SshHostConfig) {
    this.id = cfg.id;
  }

  /** The inner host, created on first use so delegation never sees a null. Its
   *  cfg is re-read from the row (pins, key path) on every connect. */
  private innerHost(): SshHost {
    if (!this.inner) {
      this.inner = makeTunnelSshHost(Hosts.get(this.id) ?? this.cfg, () => ({
        host: '127.0.0.1',
        port: this.forward?.port ?? this.port,
      }));
    }
    return this.inner;
  }

  setPassphrase(_p: string | undefined) {
    // The client key is app-generated and never passphrase-protected (§3.1).
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('This cluster has been detached.'));
    if (this.forward && this.inner) return this.inner.connect();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const cfg = Hosts.get(this.id) ?? this.cfg;
      this.cfg = cfg;
      // Re-applying on every connect is safe but chatty; a reconnect seconds
      // after a dropped tunnel doesn't need another apply + rollout wait.
      if (Date.now() - this.provisionedAt > PROVISION_TTL_MS) {
        this.state('connecting', 'Provisioning the workspace node…');
        const { hostKeyFingerprint } = await provisionNode(cfg, (line) => this.state('connecting', line));
        this.provisionedAt = Date.now();
        // Pin the node's key from the authenticated kubectl channel — stronger
        // than TOFU: SshHost's verifier now has something to compare against
        // before the first SSH byte. A CHANGED key means the node was recreated,
        // not an attack, so we re-pin rather than hard-fail the way an edited
        // ssh row would.
        if (cfg.hostKeyFingerprint !== hostKeyFingerprint) {
          const next: SshHostConfig = { ...cfg, hostKeyFingerprint, user: NODE_USER, auth: 'key' };
          Hosts.upsert(next);
          this.cfg = next;
          this.inner = null; // rebuild with the fresh pin
        }
      }
      await this.ensureForward();
      await this.innerHost().connect();
    })()
      .catch((e: any) => {
        this.state('error', String(e?.message ?? e));
        throw e;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  /** Single-flight: a connect() and a supervised restart can't race into two
   *  `kubectl port-forward` children fighting over the same node. */
  private ensureForward(): Promise<void> {
    if (this.forward) return Promise.resolve();
    if (this.forwarding) return this.forwarding;
    this.forwarding = this.startForward().finally(() => {
      this.forwarding = null;
    });
    return this.forwarding;
  }

  /** Spawn `kubectl port-forward` and resolve once it reports a listener. Runs
   *  through the local host seam, so stdio error listeners are attached for us
   *  (an unhandled EPIPE on a child's stdio takes the whole main process down). */
  private startForward(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      void (async () => {
        const k = k8sConfigOf(this.cfg);
        let port: number;
        try {
          port = this.port || (await freePort());
          this.port = port;
        } catch (e: any) {
          return reject(e instanceof Error ? e : new Error(String(e)));
        }
        const args = [...kubectlArgs(k), 'port-forward', `statefulset/${NODE_NAME}`, `${port}:22`];
        const child = localHost.spawnStream('kubectl', args);
        this.forward = { child, port };
        let settled = false;
        let stderr = '';
        const timer = setTimeout(
          () => done(new Error(`kubectl port-forward didn't start: ${stderr.trim() || 'timed out'}`)),
          FORWARD_READY_MS
        );
        function done(err?: Error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        }
        // `Forwarding from 127.0.0.1:<port> -> 22` is the readiness signal.
        child.onStdoutLine((line) => {
          if (/Forwarding from/i.test(line)) {
            this.backoff = 1000;
            done();
          }
        });
        child.onStderr((chunk) => {
          stderr = (stderr + chunk).slice(-2000);
        });
        child.onError((err) => done(new Error(`kubectl port-forward failed: ${err.message}`)));
        child.onClose(() => {
          if (this.forward?.child === child) this.forward = null;
          // Someone else grabbed the port while we were down — take a new one.
          if (/address already in use|unable to listen|bind/i.test(stderr)) this.port = 0;
          done(new Error(`kubectl port-forward exited: ${stderr.trim() || 'no output'}`));
          this.scheduleForwardRestart();
        });
      })();
    });
  }

  /**
   * A dropped forward is benign by construction: cloud turns are detached and
   * journaled, so the worst case is a paused stream. Restart with backoff on the
   * same local port and let the inner SshHost's own keepalive/reconnect ride
   * through — its next attempt finds the tunnel exactly where it left it.
   */
  private scheduleForwardRestart() {
    if (this.disposed || this.restartTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed) return;
      void this.ensureForward().catch(() => {
        // startForward's own close handler schedules the next attempt
      });
    }, delay);
  }

  private state(state: 'connecting' | 'error', message?: string) {
    broadcast('host:state', { hostId: this.id, state, message });
  }

  private killForward() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const f = this.forward;
    this.forward = null;
    try {
      f?.child.kill();
    } catch {
      // already gone
    }
  }

  dispose(): void {
    this.disposed = true;
    // Left in place, disposed: connect() refuses from here on, so a late
    // delegated call fails on a dead host instead of resurrecting a live one.
    this.inner?.dispose();
    this.killForward();
  }

  // ---------- delegation (everything past connect() is an ordinary SSH host) ----------

  // Callers reach a host through hostForWorkspace() and use it directly, so the
  // tunnel has to come up on demand — otherwise the first command after an app
  // restart would dial a port nothing is listening on. Async entry points await
  // it (and report a provisioning failure as the failure); the synchronous ones
  // kick it off and let the inner host's own reconnect ride the gap.

  async exec(cmd: string, args: string[], opts?: ExecOpts): Promise<ExecResult> {
    try {
      await this.connect();
    } catch (e: any) {
      return { ok: false, stdout: '', stderr: String(e?.message ?? e), exitCode: -1 };
    }
    return this.innerHost().exec(cmd, args, opts);
  }
  spawnStream(cmd: string, args: string[], opts?: SpawnOpts): HostChild {
    void this.connect().catch(() => {});
    return this.innerHost().spawnStream(cmd, args, opts);
  }
  pty(opts: HostPtyOpts): HostPty {
    void this.connect().catch(() => {});
    return this.innerHost().pty(opts);
  }
  /** Every fs primitive behind the same ensure-connected gate. */
  readonly fs: HostFs = {
    read: async (p) => (await this.ready()).fs.read(p),
    write: async (p, data) => (await this.ready()).fs.write(p, data),
    mkdirp: async (p) => (await this.ready()).fs.mkdirp(p),
    exists: async (p) => (await this.ready()).fs.exists(p),
    stat: async (p) => (await this.ready()).fs.stat(p),
    readdir: async (p) => (await this.ready()).fs.readdir(p),
    rm: async (p) => (await this.ready()).fs.rm(p),
    chmod: async (p, mode) => (await this.ready()).fs.chmod(p, mode),
  };
  watch(root: string, onChange: () => void): () => void {
    void this.connect().catch(() => {});
    return this.innerHost().watch(root, onChange);
  }
  refreshEnv(): void {
    this.innerHost().refreshEnv();
  }
  async forwardLoopback(localPort: number) {
    return (await this.ready()).forwardLoopback(localPort);
  }
  async forwardOut(remotePort: number) {
    return (await this.ready()).forwardOut(remotePort);
  }

  /** The inner host, with the node provisioned and the tunnel up. */
  private async ready(): Promise<SshHost> {
    await this.connect();
    return this.innerHost();
  }
}

// ---------- registry ----------

const hosts = new Map<string, K8sHost>();

/** Get (or lazily create) the K8sHost for a saved `kind: 'k8s'` row. */
export function k8sHostFor(hostId: string): K8sHost | null {
  const existing = hosts.get(hostId);
  if (existing) return existing;
  const cfg = Hosts.get(hostId);
  if (!cfg) return null;
  const h = new K8sHost(cfg);
  hosts.set(hostId, h);
  return h;
}

/** Drop a cluster host (host:remove / config change). */
export function dropK8sHost(hostId: string): void {
  const h = hosts.get(hostId);
  if (h) {
    h.dispose();
    hosts.delete(hostId);
  }
}
