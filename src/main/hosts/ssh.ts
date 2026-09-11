import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { Duplex } from 'stream';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import SSHConfig from 'ssh-config';
import { broadcast } from '../bus';
import { Hosts } from '../db';
import { stripNestedAgentVars } from '../env';
import { dropRemoteBridge } from './bridge';
import type {
  ExecHost,
  ExecOpts,
  ExecResult,
  HostChild,
  HostFs,
  HostPty,
  HostPtyOpts,
  SpawnOpts,
} from './types';
import type { FsEntry, HostState, SshConfigHost, SshHostConfig } from '../../shared/types';

/** POSIX single-quote a shell argument. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** POSIX snippet appending nvm-managed node bins to PATH. nvm initializes only
 *  in interactive bash/zsh (its nvm.sh is not POSIX and Ubuntu's .bashrc
 *  early-returns for non-interactive shells), so login-`sh` probes and spawns
 *  would miss CLIs installed via `npm i -g` on nvm boxes — glob the version
 *  dirs directly instead of sourcing it. */
export const NVM_PATH_SNIPPET =
  'for __nd in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin; do [ -d "$__nd" ] && PATH="$__nd:$PATH"; done';

/** Expand a leading ~ (and ~/) to the user's home. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Case-insensitive directive lookup on a computed ssh-config block — the
 *  parser preserves the user's casing (`hostname` and `HostName` both occur). */
function cfgGet(computed: any, name: string): any {
  if (!computed) return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(computed)) if (k.toLowerCase() === want) return computed[k];
  return undefined;
}

/** Look up a host in ~/.ssh/config: real hostname, user, port, IdentityFiles,
 *  and proxy directives. Lets an alias like `Host myserver` (or an EC2 entry)
 *  "just work" the way the terminal `ssh` command does. Best-effort — a
 *  missing/invalid config is fine. */
function sshConfigFor(alias: string): {
  hostname?: string;
  user?: string;
  port?: number;
  identityFiles: string[];
  proxyCommand?: string;
  proxyJump?: string;
} {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    const computed = SSHConfig.parse(text).compute(alias) as any;
    const idf = cfgGet(computed, 'IdentityFile');
    const port = cfgGet(computed, 'Port');
    return {
      hostname: cfgGet(computed, 'HostName'),
      user: cfgGet(computed, 'User'),
      port: port ? Number(port) : undefined,
      identityFiles: (Array.isArray(idf) ? idf : idf ? [idf] : []).map(expandHome),
      proxyCommand: cfgGet(computed, 'ProxyCommand'),
      proxyJump: cfgGet(computed, 'ProxyJump'),
    };
  } catch {
    return { identityFiles: [] };
  }
}

/** Enumerate the real hosts in ~/.ssh/config (skipping wildcard/pattern blocks)
 *  so we can offer them as one-click connect targets — the file VS Code
 *  Remote-SSH, Cursor, etc. all read/write. Best-effort. */
export function listSshConfigHosts(): SshConfigHost[] {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    const parsed = SSHConfig.parse(text);
    const out: SshConfigHost[] = [];
    const seen = new Set<string>();
    for (const node of parsed as any[]) {
      if (String(node?.param ?? '').toLowerCase() !== 'host') continue;
      // ssh-config gives a single pattern as a string, multiple as an array of
      // `{val}` objects.
      const raw = node.value;
      const patterns: string[] = Array.isArray(raw)
        ? raw.map((v: any) => (typeof v === 'string' ? v : v?.val)).filter(Boolean)
        : String(raw ?? '').split(/\s+/).filter(Boolean);
      for (const alias of patterns) {
        if (/[*?!]/.test(alias) || seen.has(alias)) continue; // skip wildcards/dupes
        seen.add(alias);
        const c = parsed.compute(alias) as any;
        const idf = cfgGet(c, 'IdentityFile');
        const idfPath = Array.isArray(idf) ? idf[0] : idf;
        const port = cfgGet(c, 'Port');
        out.push({
          alias,
          hostname: cfgGet(c, 'HostName') || alias,
          user: cfgGet(c, 'User'),
          port: port ? Number(port) : undefined,
          identityFile: idfPath ? expandHome(idfPath) : undefined,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Ordered, de-duped list of candidate private-key paths to try, mirroring how
 *  `ssh` picks an identity: the explicit key (if chosen), any ~/.ssh/config
 *  IdentityFile for the host, then the default keys. */
function candidateKeyPaths(alias: string, explicitKey?: string): string[] {
  const out: string[] = [];
  const add = (p?: string) => {
    if (!p) return;
    const abs = expandHome(p);
    if (!out.includes(abs)) out.push(abs);
  };
  add(explicitKey);
  for (const idf of sshConfigFor(alias).identityFiles) add(idf);
  for (const d of ['id_ed25519', 'id_ecdsa', 'id_rsa']) add(path.join(os.homedir(), '.ssh', d));
  return out;
}

/** The reachable SSH agent: $SSH_AUTH_SOCK, else the Windows OpenSSH agent's
 *  fixed named pipe (the service rarely exports SSH_AUTH_SOCK). */
function agentSock(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') {
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
    try {
      if (fs.existsSync(pipe)) return pipe;
    } catch {}
  }
  return undefined;
}

/** Build an ordered ssh2 auth-method list that mirrors the terminal `ssh`, for
 *  the destination host or a jump hop: the agent (if reachable) and each
 *  candidate key (the chosen key file, any ~/.ssh/config IdentityFile, then the
 *  default keys). Agent-first unless the user explicitly chose a key file. This
 *  is why "SSH agent" mode still works when the key is only a file, and why a
 *  `~/…` key path is honored. A key that needs a passphrase uses the one the
 *  user entered for this app session (never stored). */
function buildAuthMethods(opts: {
  alias: string;
  username?: string;
  mode?: 'agent' | 'key';
  keyPath?: string;
  passphrase?: string;
}): any[] {
  const { username } = opts;
  const methods: any[] = [];
  const sock = agentSock();
  const agentMethod = sock ? { type: 'agent', username, agent: sock } : null;
  if (opts.mode !== 'key' && agentMethod) methods.push(agentMethod);
  for (const kp of candidateKeyPaths(opts.alias, opts.mode === 'key' ? opts.keyPath : undefined)) {
    try {
      methods.push({ type: 'publickey', username, key: fs.readFileSync(kp), passphrase: opts.passphrase });
    } catch {
      // key file missing/unreadable — skip it
    }
  }
  if (opts.mode === 'key' && agentMethod) methods.push(agentMethod);
  return methods;
}

/** OpenSSH-style SHA256 fingerprint of a host key. */
function fingerprint(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

const KEEPALIVE_MS = 20_000;
const WATCH_POLL_MS = 15_000;

// Fired (main-side) when a host transitions to connected, so cloud continuation
// can re-tail its journals and catch up (§6.3). Separate from the renderer
// `host:state` broadcast.
let hostConnectedHook: ((hostId: string) => void) | null = null;
export function setHostConnectedHook(fn: (hostId: string) => void): void {
  hostConnectedHook = fn;
}
// Cap concurrent budgeted channels — exec + agent + pty — below OpenSSH's
// default MaxSessions (10): 10 minus 1 for the persistent sftp session, minus 1
// spare so killPgid/reconnect never starve. Long-lived agent/pty channels hold
// their slot until close; execs release on close. Overflow queues instead of
// failing with "Channel open failure: open failed". (§6.6)
const MAX_CHANNELS = 8;

/** A tiny FIFO semaphore: acquire() resolves when a slot is free; release()
 *  hands the slot to the next waiter (or returns it to the pool). */
class Semaphore {
  private count: number;
  private waiters: (() => void)[] = [];
  constructor(n: number) {
    this.count = n;
  }
  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    await new Promise<void>((res) => this.waiters.push(res));
  }
  release(): void {
    const w = this.waiters.shift();
    if (w) w(); // hand the slot straight to the next waiter (count unchanged)
    else this.count++;
  }
}

// ---------- proxy transports (ProxyCommand / ProxyJump) ----------

/** Collapse whitespace and keep the tail — proxy stderr shaped for a one-line error. */
function squashWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(-400);
}

/** OpenSSH TOKENS accepted in ProxyCommand: %h resolved hostname, %p port,
 *  %r remote user, %n the host name as given, %% a literal %. */
export function expandProxyTokens(
  template: string,
  t: { alias: string; host: string; port: number; user: string }
): string {
  return template.replace(/%[%hnpr]/g, (m) =>
    m === '%%' ? '%' : m === '%h' ? t.host : m === '%n' ? t.alias : m === '%p' ? String(t.port) : t.user
  );
}

type JumpHop = { user?: string; host: string; port?: number };

/** Parse a ProxyJump chain — comma-separated `[user@]host[:port]` hops, IPv6
 *  hosts in brackets (`user@[::1]:2222`). */
export function parseJumpHops(spec: string): JumpHop[] {
  const hops: JumpHop[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = part.lastIndexOf('@');
    const user = at > 0 ? part.slice(0, at) : undefined;
    const rest = at > 0 ? part.slice(at + 1) : part;
    let host = rest;
    let port: number | undefined;
    const v6 = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (v6) {
      host = v6[1];
      port = v6[2] ? Number(v6[2]) : undefined;
    } else {
      const colon = rest.indexOf(':');
      if (colon >= 0 && colon === rest.lastIndexOf(':')) {
        host = rest.slice(0, colon);
        port = Number(rest.slice(colon + 1)) || undefined;
      }
    }
    if (host) hops.push({ user, host, port });
  }
  return hops;
}

/** A direct-tcpip channel from `conn` to host:port. The channel is a Duplex, so
 *  it can serve as the next Client's `sock` — that IS the jump implementation. */
function forwardOutP(conn: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    conn.forwardOut('127.0.0.1', 0, host, port, (err, ch) =>
      err ? reject(new Error(`tunnel to ${host}:${port} failed: ${err.message}`)) : resolve(ch)
    );
  });
}

/** Per-connection-attempt context threaded through transport setup: teardown
 *  hooks (the transport lives exactly as long as the connection), the proxy's
 *  stderr tail for actionable errors, and the settle-once failure path. */
type ConnectAttempt = {
  cleanups: (() => void)[];
  diag: { proxy?: string };
  fail: (e: Error) => void;
};

/**
 * SshHost — the remote ExecHost. One authenticated ssh2 Client per host,
 * multiplexing exec channels (exec / spawnStream), pty channels (pty), the sftp
 * subsystem (fs), and a reverse forward (forwardLoopback). Keepalives on;
 * reconnect with backoff; host:state drives the renderer banner. Remote targets
 * are POSIX in v1, so path math is posix and script/login shells are POSIX.
 */
export class SshHost implements ExecHost {
  readonly id: string;
  readonly platform: NodeJS.Platform = 'linux'; // remote is POSIX in v1
  readonly path = path.posix;

  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private state: HostState = 'disconnected';
  private backoff = 1000;
  private disposed = false;
  private sftpSession: any = null;
  /** In-memory only — a key passphrase entered for this app session (never stored). */
  private passphrase: string | undefined;
  /** Login-shell PATH, resolved once per connection (single-flight). */
  private loginPath: Promise<string | null> | null = null;
  /** Whether `setsid` exists on the host (probed once, lazily). */
  private setsidAvail: boolean | null = null;
  /** Keeps concurrent exec/agent/pty channels below MaxSessions. */
  private execSem = new Semaphore(MAX_CHANNELS);
  /** Pending reverse forwards: remote bound port -> the local port it tunnels to. */
  private forwards = new Map<number, number>();
  /** `-L` forwards: remote port -> local port; the listening servers to close. */
  private outForwards = new Map<number, number>();
  private outServers: net.Server[] = [];

  /** When set, dial this instead of the row's host/port — the k8s tunnel's
   *  loopback endpoint, which changes every time port-forward restarts
   *  (kubernetes-workspaces.md §3.2). Re-read on every connect attempt, so a
   *  reconnect after a dropped forward finds the new port. */
  private endpoint: (() => { host: string; port: number }) | null = null;

  constructor(private cfg: SshHostConfig) {
    this.id = cfg.id;
  }

  setEndpoint(fn: (() => { host: string; port: number }) | null) {
    this.endpoint = fn;
  }

  setPassphrase(p: string | undefined) {
    if (p) this.passphrase = p;
  }

  private setState(state: HostState, message?: string) {
    if (this.state === state) return;
    this.state = state;
    broadcast('host:state', { hostId: this.id, state, message });
    if (state === 'connected') {
      try {
        hostConnectedHook?.(this.id);
      } catch {}
    }
  }

  /** Connect (or reuse). Rejects with an actionable error; sets host:state. */
  connect(): Promise<void> {
    if (this.client && this.state === 'connected') return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      this.setState('connecting');
      const conn = new Client();
      const cfg = Hosts.get(this.id) ?? this.cfg; // pick up edits/pinned fingerprint
      this.cfg = cfg;

      // Resolve ~/.ssh/config so an alias / config-only hostname/user/port works.
      // A tunnel endpoint (k8s) skips the file entirely: it's a loopback port we
      // opened ourselves, and a global `Host *` ProxyCommand must not hijack it.
      const ep = this.endpoint?.();
      const scfg = ep ? { identityFiles: [] as string[] } : sshConfigFor(cfg.host);
      const username = cfg.user || scfg.user;
      const target = ep ?? { host: scfg.hostname || cfg.host, port: cfg.port || scfg.port || 22 };

      // Per-attempt context: whatever the transport sets up (a ProxyCommand
      // process, jump-hop clients) lives exactly as long as this connection.
      let settled = false;
      const at: ConnectAttempt = {
        cleanups: [],
        diag: {},
        fail: (err) => {
          if (settled) return;
          settled = true;
          runCleanups();
          this.setState('error', err.message);
          this.connecting = null;
          if (this.client === conn) this.client = null;
          reject(err);
        },
      };
      const runCleanups = () => {
        for (const c of at.cleanups.splice(0)) {
          try {
            c();
          } catch {}
        }
      };

      const connectCfg: ConnectConfig = {
        host: target.host,
        port: target.port,
        username,
        keepaliveInterval: KEEPALIVE_MS,
        readyTimeout: 20_000,
        // TOFU: pin the fingerprint on first connect; hard-fail on change.
        // (Reads this.cfg live — hop verifiers may have pinned jump
        // fingerprints onto it between attempt start and this handshake.)
        hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
          const cur = this.cfg;
          const fp = fingerprint(key);
          const pinned = cur.hostKeyFingerprint;
          if (!pinned) {
            // First connect — pin it. (host:test surfaces a confirm; here we
            // accept and record so background reconnects don't stall.)
            const next = { ...cur, hostKeyFingerprint: fp };
            Hosts.upsert(next);
            this.cfg = next;
            return verify(true);
          }
          verify(fp === pinned);
        }) as any,
      };

      const methods = buildAuthMethods({
        alias: cfg.host,
        username,
        mode: cfg.auth,
        keyPath: cfg.keyPath,
        passphrase: this.passphrase,
      });
      if (methods.length === 0) {
        return at.fail(
          new Error(
            cfg.auth === 'key'
              ? `No usable key found. Set the key path to your private key (e.g. an EC2 .pem).`
              : `No SSH agent and no key found. Switch to "Key file" and point to your private key (e.g. your EC2 .pem), or run \`ssh-add <key>\` first.`
          )
        );
      }
      connectCfg.authHandler = methods as any;

      conn.on('ready', () => {
        settled = true;
        this.client = conn;
        this.backoff = 1000;
        this.setState('connected');
        this.connecting = null;
        resolve();
        void this.resolveLoginPath(); // warm it before the first exec/spawn waits on it
      });
      conn.on('error', (err) => {
        const raw = String(err?.message ?? err);
        // Translate the cryptic ssh2 auth failure into something actionable.
        let msg = /authentication methods failed|All configured/i.test(raw)
          ? `SSH authentication failed for ${username}@${target.host}. ` +
            (cfg.auth === 'agent'
              ? `Your SSH agent has no key this server accepts. For an EC2 instance, switch AUTH to "Key file" and set the key path to your .pem (e.g. ~/Downloads/your-key.pem), or run \`ssh-add <key>\` first.`
              : `Check the key path points to the right private key for this server (EC2 uses the .pem you downloaded), and that the user is correct (often \`ec2-user\`, \`ubuntu\`, or \`admin\`).`)
          : raw;
        // The proxy's stderr usually holds the real story ("SessionManagerPlugin
        // is not found", "aws: command not found", …).
        if (at.diag.proxy) msg += ` — ProxyCommand said: ${squashWs(at.diag.proxy)}`;
        if (!settled) at.fail(new Error(msg));
        else this.setState('error', msg); // post-ready error; 'close' owns recovery
      });
      conn.on('close', () => {
        runCleanups(); // the transport dies with the connection
        this.sftpSession = null;
        this.loginPath = null; // re-resolved on the next connection
        this.forwards.clear();
        dropRemoteBridge(this.id); // the reverse tunnel died with the connection
        if (this.client === conn) this.client = null;
        // Closed before the handshake finished (e.g. the proxy printed an error
        // and exited) — settle the attempt instead of hanging it.
        if (!settled) {
          const said = at.diag.proxy ? ` — ProxyCommand said: ${squashWs(at.diag.proxy)}` : '';
          at.fail(new Error(`Connection closed during SSH handshake${said}`));
        }
        if (!this.disposed) {
          this.setState('disconnected');
          this.scheduleReconnect();
        }
      });
      conn.on('tcp connection', (info, accept) => {
        const localPort = this.forwards.get(info.destPort);
        if (localPort == null) return; // not one of ours
        const channel = accept();
        const sock = net.connect(localPort, '127.0.0.1');
        channel.pipe(sock).pipe(channel);
        sock.on('error', () => channel.end());
        channel.on('error', () => sock.end());
      });

      // Resolve the transport (direct, ProxyCommand, or ProxyJump chain), then
      // run the SSH protocol over it — ssh2 dials TCP itself when sock is unset.
      void (async () => {
        const sock = await this.resolveTransport(cfg.host, scfg, target, username, new Set([cfg.host]), at);
        if (settled) return; // the attempt already failed while we were dialing
        if (sock) {
          connectCfg.sock = sock;
          connectCfg.readyTimeout = 60_000; // SSM sessions & hop chains start slower than a TCP dial
        }
        conn.connect(connectCfg);
      })().catch((e) => at.fail(e instanceof Error ? e : new Error(String(e))));
    });
    return this.connecting;
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    setTimeout(() => {
      if (this.disposed || this.state === 'connected') return;
      // Re-establish so exec/pty/sftp/forwards work after a drop; ignore errors
      // (the next command retries, and host:state already reflects the drop).
      void this.connect().catch(() => {});
    }, delay);
  }

  /**
   * The transport seam: how do we obtain the byte stream the SSH protocol runs
   * over? Mirrors OpenSSH's own model — a `ProxyJump` chain connects hop by hop
   * (each direct-tcpip channel is the next Client's socket), a `ProxyCommand`
   * spawns a process whose stdio *is* the connection, and a plain host returns
   * undefined so ssh2 dials TCP itself. Everything downstream (auth, TOFU,
   * channels, sftp, forwards) is transport-agnostic.
   */
  private async resolveTransport(
    alias: string,
    scfg: ReturnType<typeof sshConfigFor>,
    target: { host: string; port: number },
    username: string | undefined,
    seen: Set<string>,
    at: ConnectAttempt
  ): Promise<Duplex | undefined> {
    // OpenSSH treats these as mutually exclusive (first in config wins); the
    // computed block loses order, so prefer ProxyJump when both appear.
    const jump = scfg.proxyJump?.trim();
    if (jump && jump.toLowerCase() !== 'none') {
      let via: Client | null = null;
      for (const hop of parseJumpHops(jump)) via = await this.connectHop(hop, via, seen, at);
      return via ? await forwardOutP(via, target.host, target.port) : undefined;
    }
    const proxy = scfg.proxyCommand?.trim();
    if (proxy && proxy.toLowerCase() !== 'none') {
      const cmd = expandProxyTokens(proxy, {
        alias,
        host: target.host,
        port: target.port,
        user: username || os.userInfo().username,
      });
      return this.spawnProxy(cmd, at);
    }
    return undefined;
  }

  /** Spawn a ProxyCommand; its stdio is the SSH byte stream (OpenSSH's own
   *  contract for the directive). stderr is kept for actionable errors. */
  private spawnProxy(command: string, at: ConnectAttempt): Duplex {
    // OpenSSH runs ProxyCommand through a shell; `shell: true` matches (`sh -c`
    // on POSIX, `cmd /c` on Windows — where AWS's documented SSM config invokes
    // powershell.exe explicitly). PATH is the login-shell PATH (env.ts), so
    // `aws` resolves in GUI launches too.
    const proc = spawn(command, { shell: true, windowsHide: true, env: process.env });
    at.cleanups.push(() => {
      try {
        proc.kill();
      } catch {}
    });
    proc.stderr?.on('data', (d: Buffer) => {
      at.diag.proxy = ((at.diag.proxy ?? '') + d.toString()).slice(-2000);
    });
    // A dying proxy EPIPEs in-flight writes — that must surface as a failed
    // connection, not an uncaught stream error.
    proc.stdin?.on('error', () => {});
    proc.stdout?.on('error', () => {});
    proc.on('error', (e) => at.fail(new Error(`ProxyCommand could not start: ${e.message}`)));
    proc.on('exit', (code) => {
      // Fatal only before 'ready' (fail() settles once); after that the
      // connection's own close path owns recovery.
      const said = at.diag.proxy ? `: ${squashWs(at.diag.proxy)}` : '';
      at.fail(new Error(`ProxyCommand exited${code != null ? ` (${code})` : ''} during SSH handshake${said}`));
    });
    // Duplex.from accepts Node streams in the {readable, writable} pair at
    // runtime; @types/node only admits web streams there — hence the cast.
    return Duplex.from({ readable: proc.stdout!, writable: proc.stdin! } as any);
  }

  /** Connect to one ProxyJump hop. The first hop resolves its own transport
   *  from local config (it may itself sit behind a ProxyCommand); later hops
   *  are reached through the previous one. */
  private async connectHop(hop: JumpHop, via: Client | null, seen: Set<string>, at: ConnectAttempt): Promise<Client> {
    if (seen.has(hop.host)) throw new Error(`ProxyJump loop: ${hop.host} is already on the chain`);
    seen.add(hop.host);
    const scfg = sshConfigFor(hop.host);
    const username = hop.user || scfg.user || os.userInfo().username;
    const target = { host: scfg.hostname || hop.host, port: hop.port || scfg.port || 22 };
    const sock = via
      ? await forwardOutP(via, target.host, target.port)
      : await this.resolveTransport(hop.host, scfg, target, username, seen, at);
    const methods = buildAuthMethods({ alias: hop.host, username, passphrase: this.passphrase });
    if (methods.length === 0) throw new Error(`Jump host ${hop.host}: no SSH key or agent available`);
    const conn = new Client();
    at.cleanups.push(() => {
      try {
        conn.end();
      } catch {}
    });
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', () => resolve());
      conn.on('error', (e) => reject(new Error(`Jump host ${hop.host}: ${String(e?.message ?? e)}`)));
      conn.connect({
        host: target.host,
        port: target.port,
        username,
        sock,
        keepaliveInterval: KEEPALIVE_MS,
        readyTimeout: 30_000,
        hostVerifier: this.hopVerifier(`${target.host}:${target.port}`),
        authHandler: methods as any,
      });
    });
    return conn;
  }

  /** TOFU for jump hops, pinned per `host:port` on this host's row (a hop has
   *  no row of its own). Same trust model as the destination key. */
  private hopVerifier(hopKey: string) {
    return ((key: Buffer, verify: (ok: boolean) => void) => {
      const fp = fingerprint(key);
      const pins = this.cfg.jumpFingerprints ?? {};
      const pinned = pins[hopKey];
      if (!pinned) {
        const next = { ...this.cfg, jumpFingerprints: { ...pins, [hopKey]: fp } };
        Hosts.upsert(next);
        this.cfg = next;
        return verify(true);
      }
      verify(fp === pinned);
    }) as any;
  }

  private async conn(): Promise<Client> {
    await this.connect();
    if (!this.client) throw new Error(`Not connected to ${this.cfg.label || this.cfg.host}`);
    return this.client;
  }

  /** Build the shell command that runs `cmd args` in `cwd` with `env`. `exec`
   *  prefixes only the final command (so it replaces the shell, preserving the
   *  pgid) — NOT the leading `export`s, which must run as builtins first. */
  private buildCommand(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string | undefined>; strip?: boolean; exec?: boolean; loginPath?: string | null }
  ): string {
    const parts: string[] = [];
    // Login-shell PATH first, so `cmd` resolves the way it does in the user's
    // terminal; an explicit env.PATH below still overrides it.
    if (opts?.loginPath) parts.push(`export PATH=${shq(opts.loginPath)};`);
    if (opts?.cwd) parts.push(`cd ${shq(opts.cwd)} &&`);
    const env = opts?.strip ? stripNestedAgentVars(opts.env ?? {}) : opts?.env ?? {};
    for (const [k, v] of Object.entries(env)) {
      parts.push(v === undefined ? `unset ${k};` : `export ${k}=${shq(v)};`);
    }
    const command = [cmd, ...args].map(shq).join(' ');
    parts.push(opts?.exec ? `exec ${command}` : command);
    return parts.join(' ');
  }

  async exec(cmd: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    let conn: Client;
    try {
      conn = await this.conn();
    } catch (e: any) {
      return { ok: false, stdout: '', stderr: String(e?.message ?? e), exitCode: -1 };
    }
    // Resolved before taking a semaphore slot; single-flight and cached, so only
    // the first exec after connect actually waits on the login shell.
    const loginPath = await this.resolveLoginPath();
    // Queue below MaxSessions so a burst of git calls doesn't overflow into
    // "Channel open failure: open failed".
    await this.execSem.acquire();
    const command = this.buildCommand(cmd, args, { cwd: opts.cwd, env: opts.env, loginPath });
    return new Promise<ExecResult>((resolve) => {
      let done = false;
      const finish = (r: ExecResult) => {
        if (done) return;
        done = true;
        this.execSem.release();
        resolve(r);
      };
      conn.exec(command, (err, stream) => {
        if (err) return finish({ ok: false, stdout: '', stderr: String(err.message), exitCode: -1 });
        let stdout = '';
        let stderr = '';
        const timer =
          opts.timeout && opts.timeout > 0
            ? setTimeout(() => {
                try {
                  stream.signal('KILL');
                  stream.close();
                } catch {}
              }, opts.timeout)
            : null;
        stream.on('close', (code: number | null) => {
          if (timer) clearTimeout(timer);
          const exitCode = code ?? -1;
          finish({ ok: exitCode === 0, stdout, stderr, exitCode });
        });
        stream.on('data', (d: Buffer) => (stdout += d.toString()));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        if (opts.input != null) {
          stream.write(opts.input);
          stream.end();
        }
      });
    });
  }

  spawnStream(cmd: string, args: string[], opts: SpawnOpts = {}): HostChild {
    return new SshChild(this, cmd, args, opts);
  }

  /**
   * The user's login-shell PATH (nvm, ~/.local/bin, …), resolved once per
   * connection — so exec/agent channels find the same commands the interactive
   * terminal (`$SHELL -l`) and the harness probe (`sh -lc`) do; sshd gives raw
   * exec channels a minimal PATH that skips profile files entirely. The remote
   * mirror of env.ts's local login-env resolution. Runs on a raw channel, not
   * exec() (which awaits this); the sentinel line survives chatty profiles, and
   * a hung profile times out to null — commands then run with sshd's default
   * PATH, i.e. the pre-resolution behavior.
   */
  private resolveLoginPath(): Promise<string | null> {
    if (!this.loginPath) {
      this.loginPath = (async () => {
        try {
          const conn = await this.conn();
          // Deliberately unbudgeted: single-flight, runs at connect before the budget's own load exists.
          return await new Promise<string | null>((resolve) => {
            conn.exec(`sh -lc '${NVM_PATH_SNIPPET}; echo "__MAESTRO_PATH__:$PATH"'`, (err, stream) => {
              if (err) return resolve(null);
              let out = '';
              const timer = setTimeout(() => {
                try {
                  stream.close();
                } catch {}
                resolve(null);
              }, 10_000);
              stream.on('data', (d: Buffer) => (out += d.toString()));
              stream.stderr.on('data', () => {});
              stream.on('close', () => {
                clearTimeout(timer);
                const line = out.split('\n').find((l) => l.startsWith('__MAESTRO_PATH__:'));
                resolve(line ? line.slice('__MAESTRO_PATH__:'.length).trim() || null : null);
              });
            });
          });
        } catch {
          return null;
        }
      })();
    }
    return this.loginPath;
  }

  /** Forget the cached login PATH so the next command re-resolves it. Wired to
   *  forced harness probes: installing a CLI edits the profile, which the
   *  cached capture predates. */
  refreshEnv(): void {
    this.loginPath = null;
  }

  /** Whether `setsid` exists on the host (probed once). It lets us run the CLI as
   *  a session leader for clean process-group kills; where it's absent (e.g.
   *  macOS) we fall back to a plain shell and kill the pid. */
  private async hasSetsid(): Promise<boolean> {
    if (this.setsidAvail == null) {
      const r = await this.exec('sh', ['-lc', 'command -v setsid >/dev/null 2>&1 && echo 1 || echo 0']);
      this.setsidAvail = r.ok && r.stdout.trim() === '1';
    }
    return this.setsidAvail;
  }

  /**
   * Run an agent CLI wired to a fresh channel, echoing its pgid once on stderr as
   * `__MAESTRO_PGID__:<n>` (stripped by SshChild). With `setsid -w` the CLI runs
   * in a new session (whole-tree pgid kill) AND setsid waits, so the exit code +
   * stdio propagate; plain `setsid` (no -w) would fork and exit 0 immediately,
   * silently detaching the CLI. On hosts without setsid we run under a plain
   * `sh` (channel close still SIGHUPs the CLI; we also kill the pid on stop).
   */
  async openAgentChannel(
    cmd: string,
    args: string[],
    opts: SpawnOpts
  ): Promise<ClientChannel> {
    const conn = await this.conn();
    const setsid = await this.hasSetsid();
    const loginPath = await this.resolveLoginPath();
    // Budget this long-lived channel; hold the slot until it closes.
    await this.execSem.acquire();
    let released = false;
    const release = () => { if (!released) { released = true; this.execSem.release(); } };
    // `exec: true` puts `exec` before the CLI (not the env exports), so the CLI
    // replaces the inner sh and keeps its pgid. inner = `export K=v; …; exec claude …`.
    const inner = this.buildCommand(cmd, args, { env: opts.env, strip: true, exec: true });
    const cd = opts.cwd ? `cd ${shq(opts.cwd)}; ` : '';
    // Login-shell PATH first (where the CLI usually lives), then ~/.maestro/bin
    // on top so the uploaded maestro-ask/maestro-role shims win (§6.7). The
    // inner sh is the (session) leader, so its $$ is the pgid.
    const leader = setsid ? 'setsid -w ' : '';
    const pathExport = loginPath ? `export PATH=${shq(loginPath)}; ` : '';
    const wrapped =
      `${cd}${pathExport}export PATH="$HOME/.maestro/bin:$PATH"; ` +
      `exec ${leader}sh -c ${shq(`echo "__MAESTRO_PGID__:$$" 1>&2; ${inner}`)}`;
    return new Promise((resolve, reject) => {
      conn.exec(wrapped, { pty: false }, (err, stream) => {
        if (err) { release(); return reject(err); }
        stream.on('close', release);
        resolve(stream);
      });
    });
  }

  /** Kill a remote process (best effort): the whole group (`-pgid`, works under
   *  setsid) AND the pid itself (for the no-setsid fallback). */
  async killPgid(pgid: number, signal: 'TERM' | 'KILL') {
    try {
      const conn = await this.conn();
      // Deliberately unbudgeted: this frees slots (kills agents), so queueing it behind a full budget would deadlock.
      conn.exec(`kill -${signal} -${pgid} 2>/dev/null; kill -${signal} ${pgid} 2>/dev/null; true`, () => {});
    } catch {}
  }

  pty(opts: HostPtyOpts): HostPty {
    return new SshPty(this, opts);
  }

  /** Open a pty channel running `command` (or a login shell) in `cwd`. */
  async openPtyChannel(opts: HostPtyOpts): Promise<ClientChannel> {
    const conn = await this.conn();
    // Budget this long-lived channel; hold the slot until it closes.
    await this.execSem.acquire();
    let released = false;
    const release = () => { if (!released) { released = true; this.execSem.release(); } };
    return new Promise<ClientChannel>((resolve, reject) => {
      const window = { rows: opts.rows ?? 24, cols: opts.cols ?? 80, height: 480, width: 640, term: 'xterm-256color' };
      const cd = opts.cwd ? `cd ${shq(opts.cwd)}; ` : '';
      const envExports = Object.entries(opts.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}; `)
        .join('');
      const run = opts.command
        ? [opts.command.file, ...opts.command.args].map(shq).join(' ')
        : 'exec "$SHELL" -l';
      conn.exec(`${cd}${envExports}${run}`, { pty: window }, (err, stream) => {
        if (err) { release(); return reject(err); }
        stream.on('close', release);
        resolve(stream);
      });
    });
  }

  private async sftp(): Promise<any> {
    if (this.sftpSession) return this.sftpSession;
    const conn = await this.conn();
    this.sftpSession = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.on('close', () => {
          if (this.sftpSession === sftp) this.sftpSession = null;
        });
        resolve(sftp);
      });
    });
    return this.sftpSession;
  }

  fs: HostFs = {
    read: async (p) => {
      const sftp = await this.sftp();
      return new Promise<Buffer>((resolve, reject) => {
        sftp.readFile(p, (err: any, data: Buffer) => (err ? reject(err) : resolve(data)));
      });
    },
    write: async (p, data) => {
      const sftp = await this.sftp();
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      return new Promise<void>((resolve, reject) => {
        sftp.writeFile(p, buf, (err: any) => (err ? reject(err) : resolve()));
      });
    },
    mkdirp: async (p) => {
      // sftp.mkdir isn't recursive — walk the ancestors. Cheapest robust path is
      // a single remote `mkdir -p`.
      const r = await this.exec('mkdir', ['-p', p]);
      if (!r.ok) throw new Error(r.stderr.trim() || `mkdir -p ${p} failed`);
    },
    exists: async (p) => {
      const sftp = await this.sftp();
      return new Promise<boolean>((resolve) => {
        sftp.stat(p, (err: any) => resolve(!err));
      });
    },
    stat: async (p) => {
      const sftp = await this.sftp();
      return new Promise((resolve, reject) => {
        sftp.stat(p, (err: any, st: any) =>
          err ? reject(err) : resolve({ size: st.size, mtimeMs: (st.mtime ?? 0) * 1000, dir: st.isDirectory() })
        );
      });
    },
    readdir: async (p) => {
      const sftp = await this.sftp();
      return new Promise<FsEntry[]>((resolve, reject) => {
        sftp.readdir(p, (err: any, list: any[]) =>
          err
            ? reject(err)
            : resolve(
                list.map((e) => ({
                  name: e.filename,
                  // longname mode string starts with 'd' for directories
                  dir: e.attrs?.isDirectory?.() ?? /^d/.test(String(e.longname ?? '')),
                }))
              )
        );
      });
    },
    rm: async (p) => {
      const r = await this.exec('rm', ['-rf', p]);
      if (!r.ok) throw new Error(r.stderr.trim() || `rm -rf ${p} failed`);
    },
    chmod: async (p, mode) => {
      const sftp = await this.sftp();
      return new Promise<void>((resolve, reject) => {
        sftp.chmod(p, mode, (err: any) => (err ? reject(err) : resolve()));
      });
    },
  };

  watch(root: string, onChange: () => void): () => void {
    // Trigger-based poller (§6.8): every ~15s, ask whether any non-noisy file is
    // newer than a sentinel; if so, fire and re-stamp. This backstops the
    // turn-boundary ws:updated broadcasts the harness already emits.
    const sentinel = this.path.join(root, '.context', '.watch-sentinel');
    let stopped = false;
    void this.exec('sh', ['-lc', `mkdir -p ${shq(this.path.dirname(sentinel))}; : > ${shq(sentinel)}`]);
    const tick = async () => {
      if (stopped) return;
      const find =
        `find ${shq(root)} -type f -newer ${shq(sentinel)} ` +
        `-not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.context/*' 2>/dev/null | head -1`;
      const r = await this.exec('sh', ['-lc', find]);
      if (!stopped && r.ok && r.stdout.trim()) {
        await this.exec('sh', ['-lc', `: > ${shq(sentinel)}`]);
        onChange();
      }
    };
    const timer = setInterval(() => void tick(), WATCH_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async forwardLoopback(localPort: number): Promise<{ remotePort: number }> {
    const conn = await this.conn();
    return new Promise((resolve, reject) => {
      conn.forwardIn('127.0.0.1', 0, (err, port) => {
        if (err) return reject(err);
        this.forwards.set(port, localPort);
        resolve({ remotePort: port });
      });
    });
  }

  async forwardOut(remotePort: number): Promise<{ localPort: number }> {
    const existing = this.outForwards.get(remotePort);
    if (existing) return { localPort: existing };
    const conn = await this.conn();
    const server = net.createServer((sock) => {
      conn.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (err, channel) => {
        if (err) {
          sock.destroy();
          return;
        }
        sock.pipe(channel).pipe(sock);
        sock.on('error', () => channel.end());
        channel.on('error', () => sock.end());
      });
    });
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const localPort = addr && typeof addr === 'object' ? addr.port : 0;
        this.outForwards.set(remotePort, localPort);
        this.outServers.push(server);
        resolve({ localPort });
      });
    });
  }

  dispose() {
    this.disposed = true;
    for (const s of this.outServers) {
      try {
        s.close();
      } catch {}
    }
    this.outServers = [];
    this.outForwards.clear();
    try {
      this.client?.end();
    } catch {}
    this.client = null;
    this.sftpSession = null;
  }
}

/** HostChild over an SSH exec channel, with setsid/pgid-kill semantics. */
class SshChild implements HostChild {
  private channel: ClientChannel | null = null;
  private pgid: number | null = null;
  private pgidBuf = '';
  private pgidSeen = false;
  private killPending: 'TERM' | 'KILL' | null = null;
  private stdoutCbs: ((c: string) => void)[] = [];
  private stderrCbs: ((c: string) => void)[] = [];
  private lineCbs: ((l: string) => void)[] = [];
  private closeCbs: ((c: number | null) => void)[] = [];
  private errorCbs: ((e: Error) => void)[] = [];
  private lineBuf = '';
  private pendingStdin: string[] = [];
  private stdinEnded = false;

  constructor(private host: SshHost, cmd: string, args: string[], opts: SpawnOpts) {
    host
      .openAgentChannel(cmd, args, opts)
      .then((channel) => {
        this.channel = channel;
        // Flush any stdin queued before the channel opened.
        for (const d of this.pendingStdin) channel.write(d);
        this.pendingStdin = [];
        if (this.stdinEnded) channel.end();
        if (this.killPending) this.kill(this.killPending);

        channel.on('data', (d: Buffer) => this.emitStdout(d.toString()));
        channel.stderr.on('data', (d: Buffer) => this.emitStderr(d.toString()));
        channel.on('close', (code: number | null) => this.closeCbs.forEach((cb) => cb(code)));
      })
      .catch((e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        this.errorCbs.forEach((cb) => cb(err));
      });
  }

  private emitStdout(chunk: string) {
    for (const cb of this.stdoutCbs) cb(chunk);
    if (this.lineCbs.length) {
      this.lineBuf += chunk;
      let idx: number;
      while ((idx = this.lineBuf.indexOf('\n')) >= 0) {
        const line = this.lineBuf.slice(0, idx);
        this.lineBuf = this.lineBuf.slice(idx + 1);
        for (const cb of this.lineCbs) cb(line);
      }
    }
  }

  private emitStderr(chunk: string) {
    // Strip the leading __MAESTRO_PGID__:<n> marker line before passing stderr on.
    if (!this.pgidSeen) {
      this.pgidBuf += chunk;
      const nl = this.pgidBuf.indexOf('\n');
      if (nl < 0) return; // wait for the full marker line
      const first = this.pgidBuf.slice(0, nl);
      const rest = this.pgidBuf.slice(nl + 1);
      this.pgidSeen = true;
      const m = first.match(/__MAESTRO_PGID__:(\d+)/);
      if (m) {
        this.pgid = Number(m[1]);
        if (this.killPending) this.kill(this.killPending);
      } else {
        // No marker (unexpected) — treat the whole buffer as real stderr.
        for (const cb of this.stderrCbs) cb(first + '\n');
      }
      chunk = rest;
      if (!chunk) return;
    }
    for (const cb of this.stderrCbs) cb(chunk);
  }

  onStdout(cb: (c: string) => void) {
    this.stdoutCbs.push(cb);
  }
  onStderr(cb: (c: string) => void) {
    this.stderrCbs.push(cb);
  }
  onStdoutLine(cb: (l: string) => void) {
    this.lineCbs.push(cb);
  }
  onClose(cb: (c: number | null) => void) {
    this.closeCbs.push(cb);
  }
  onError(cb: (e: Error) => void) {
    this.errorCbs.push(cb);
  }
  writeStdin(data: string) {
    if (this.channel) this.channel.write(data);
    else this.pendingStdin.push(data);
  }
  endStdin() {
    if (this.channel) {
      try {
        this.channel.end();
      } catch {}
    } else this.stdinEnded = true;
  }
  kill(signal?: string) {
    const sig = signal === 'SIGKILL' ? 'KILL' : 'TERM';
    if (this.pgid != null) {
      void this.host.killPgid(this.pgid, sig);
    } else {
      // pgid not captured yet — remember and also close the channel.
      this.killPending = sig;
    }
    try {
      this.channel?.close();
    } catch {}
  }
}

/** HostPty over an SSH pty channel. */
class SshPty implements HostPty {
  private channel: ClientChannel | null = null;
  private dataCbs: ((c: string) => void)[] = [];
  private exitCbs: ((c: number) => void)[] = [];
  private pendingWrites: string[] = [];
  private lastCols: number;
  private lastRows: number;

  constructor(host: SshHost, opts: HostPtyOpts) {
    this.lastCols = opts.cols ?? 80;
    this.lastRows = opts.rows ?? 24;
    host
      .openPtyChannel(opts)
      .then((channel) => {
        this.channel = channel;
        for (const d of this.pendingWrites) channel.write(d);
        this.pendingWrites = [];
        channel.on('data', (d: Buffer) => this.dataCbs.forEach((cb) => cb(d.toString())));
        channel.stderr?.on('data', (d: Buffer) => this.dataCbs.forEach((cb) => cb(d.toString())));
        channel.on('close', (code: number | null) => this.exitCbs.forEach((cb) => cb(code ?? 0)));
      })
      .catch((e) => {
        this.dataCbs.forEach((cb) => cb(`\r\n[maestro] remote terminal error: ${String(e?.message ?? e)}\r\n`));
        this.exitCbs.forEach((cb) => cb(1));
      });
  }
  onData(cb: (c: string) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (c: number) => void) {
    this.exitCbs.push(cb);
  }
  write(data: string) {
    if (this.channel) this.channel.write(data);
    else this.pendingWrites.push(data);
  }
  resize(cols: number, rows: number) {
    this.lastCols = cols;
    this.lastRows = rows;
    try {
      this.channel?.setWindow(rows, cols, 480, 640);
    } catch {}
  }
  kill() {
    try {
      this.channel?.close();
    } catch {}
  }
}

// ---------- registry ----------

const hosts = new Map<string, SshHost>();

/** Get (or lazily create) the SshHost for a saved host id. */
export function sshHostFor(hostId: string): SshHost | null {
  const existing = hosts.get(hostId);
  if (existing) return existing;
  const cfg = Hosts.get(hostId);
  if (!cfg) return null;
  const h = new SshHost(cfg);
  hosts.set(hostId, h);
  return h;
}

/** Drop a host (host:remove / config change). */
export function dropSshHost(hostId: string) {
  const h = hosts.get(hostId);
  if (h) {
    h.dispose();
    hosts.delete(hostId);
  }
}

/**
 * An SshHost that dials a caller-owned endpoint instead of the row's address —
 * the inner host of a `K8sHost` (kubernetes-workspaces.md §3.2). It keeps the
 * row's id (so host:state, the bridge and the host cache key identically) and
 * its auth/pin, but is NOT in the registry above: the wrapper owns its lifetime.
 */
export function makeTunnelSshHost(cfg: SshHostConfig, endpoint: () => { host: string; port: number }): SshHost {
  const h = new SshHost(cfg);
  h.setEndpoint(endpoint);
  return h;
}
