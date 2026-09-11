/**
 * E2E for the SSH transport seam (ProxyCommand / ProxyJump) — hermetic: runs
 * the real SshHost + db code against a local ssh2 Server, no sshd or network
 * needed. Covers:
 *   1. pure helpers (expandProxyTokens, parseJumpHops)
 *   2. ProxyCommand: SSM-style `Host i-*` alias (no HostName, lowercase
 *      directives) through a spawned relay process — the exact shape that used
 *      to die with `getaddrinfo ENOTFOUND i-…`
 *   3. ProxyJump: hop client + direct-tcpip channel as the next socket, with
 *      destination AND per-hop TOFU pins (regression: dest pin must not wipe
 *      hop pins)
 *   4. failing ProxyCommand → error carries the proxy's stderr
 *
 *   npx esbuild scripts/ssh-proxy-e2e.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:better-sqlite3 --external:node-pty \
 *     --external:electron-updater --external:ssh2 --external:cpu-features \
 *     --outfile=dist/ssh-proxy-e2e.cjs
 *   node dist/ssh-proxy-e2e.cjs   # or ELECTRON_RUN_AS_NODE=1 npx electron …
 *                                 # if node_modules are electron-rebuilt
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { execSync } from 'child_process';
import { Server } from 'ssh2';
import { initDb, Hosts } from '../src/main/db';
import { sshHostFor, expandProxyTokens, parseJumpHops } from '../src/main/hosts/ssh';

const ROOT = '/tmp/maestro-ssh-proxy-e2e';
const HOME = path.join(ROOT, 'home');
const KEY = path.join(HOME, '.ssh', 'id_ed25519');
const HOSTKEY = path.join(ROOT, 'hostkey');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function startServer(): Promise<{ port: number; close: () => void }> {
  const srv = new Server({ hostKeys: [fs.readFileSync(HOSTKEY)] }, (conn) => {
    conn.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') return ctx.accept();
      ctx.reject(['publickey']);
    });
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        accept().on('exec', (acceptExec: any, _rej: any, info: any) => {
          const stream = acceptExec();
          stream.write(`RAN:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
      // direct-tcpip: what a jump host does for the next hop.
      conn.on('tcpip', (accept: any, _rej: any, info: any) => {
        const ch = accept();
        const s = net.connect(info.destPort, '127.0.0.1');
        s.on('connect', () => {
          ch.pipe(s);
          s.pipe(ch);
        });
        s.on('error', () => ch.end());
        ch.on('error', () => s.end());
      });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port;
      resolve({ port, close: () => srv.close() });
    });
  });
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.ssh'), { recursive: true, mode: 0o700 });
  execSync(`ssh-keygen -t ed25519 -N '' -q -f ${KEY}`);
  execSync(`ssh-keygen -t ed25519 -N '' -q -f ${HOSTKEY}`);
  // Fake `aws ssm start-session`: stdio is a tunnel to the "instance".
  fs.writeFileSync(
    path.join(ROOT, 'relay.js'),
    `const net = require('net');
const [host, port] = process.argv.slice(2);
process.stderr.write('RELAY target=' + host + '\\n');
const s = net.connect(Number(port), '127.0.0.1');
process.stdin.pipe(s);
s.pipe(process.stdout);
s.on('error', (e) => { console.error('relay error:', e.message); process.exit(1); });
s.on('close', () => process.exit(0));
`
  );
  // A proxy that dies the way a missing SSM plugin does.
  fs.writeFileSync(
    path.join(ROOT, 'fail.js'),
    `console.error('SessionManagerPlugin is not found. Please refer to SessionManager Documentation.');
process.exit(255);
`
  );

  process.env.HOME = HOME; // sshConfigFor/candidateKeyPaths read ~/.ssh at call time
  delete process.env.SSH_AUTH_SOCK; // hermetic: no real agent

  // --- 1. pure helpers ---
  const exp = expandProxyTokens('run --to %h:%p as %r orig %n pct %%', {
    alias: 'i-0abc',
    host: 'i-0abc',
    port: 2222,
    user: 'ec2-user',
  });
  check('expandProxyTokens', exp === 'run --to i-0abc:2222 as ec2-user orig i-0abc pct %', exp);

  const hops = parseJumpHops('bastion, admin@jump2:2222, [::1]:2200');
  check(
    'parseJumpHops',
    hops.length === 3 &&
      hops[0].host === 'bastion' &&
      hops[0].user === undefined &&
      hops[1].user === 'admin' &&
      hops[1].host === 'jump2' &&
      hops[1].port === 2222 &&
      hops[2].host === '::1' &&
      hops[2].port === 2200,
    JSON.stringify(hops)
  );

  const { port, close } = await startServer();
  fs.writeFileSync(
    path.join(HOME, '.ssh', 'config'),
    [
      // SSM-style: instance-id alias, no HostName, proxied stdio — lowercase
      // directives on purpose (casing must not matter).
      `Host i-*`,
      `  user test`,
      `  proxycommand node ${ROOT}/relay.js %h %p`,
      ``,
      `Host target-via-jump`,
      `  HostName 127.0.0.1`,
      `  ProxyJump jumper`,
      ``,
      `Host jumper`,
      `  HostName 127.0.0.1`,
      `  Port ${port}`,
      `  User test`,
      `  IdentityFile ${KEY}`,
      ``,
      `Host badproxy`,
      `  User test`,
      `  ProxyCommand node ${ROOT}/fail.js`,
    ].join('\n')
  );

  initDb(path.join(ROOT, 'test.db'));
  Hosts.upsert({ id: 'h1', label: 'ssm', host: 'i-0deadbeef', port, user: '', auth: 'key', keyPath: KEY });
  Hosts.upsert({ id: 'h2', label: 'jump', host: 'target-via-jump', port, user: 'test', auth: 'key', keyPath: KEY });
  Hosts.upsert({ id: 'h3', label: 'bad', host: 'badproxy', port: 22, user: 'test', auth: 'key', keyPath: KEY });

  // --- 2. ProxyCommand (fake SSM) ---
  const h1 = sshHostFor('h1')!;
  const r1 = await h1.exec('echo', ['hi']);
  check('ProxyCommand exec ok', r1.ok && r1.stdout.startsWith('RAN:'), JSON.stringify(r1));
  check('ProxyCommand TOFU pinned', !!Hosts.get('h1')?.hostKeyFingerprint);

  // --- 3. ProxyJump ---
  const h2 = sshHostFor('h2')!;
  const r2 = await h2.exec('uname', ['-s']);
  const row2 = Hosts.get('h2');
  check('ProxyJump exec ok', r2.ok && r2.stdout.startsWith('RAN:'), JSON.stringify(r2));
  check('ProxyJump dest TOFU pinned', !!row2?.hostKeyFingerprint);
  check(
    'ProxyJump hop TOFU pinned (not wiped by dest pin)',
    !!row2?.jumpFingerprints?.[`127.0.0.1:${port}`],
    JSON.stringify(row2?.jumpFingerprints)
  );

  // --- 4. failing proxy → actionable error ---
  const h3 = sshHostFor('h3')!;
  const r3 = await h3.exec('true', []);
  check(
    'failing ProxyCommand surfaces stderr',
    !r3.ok && /ProxyCommand/.test(r3.stderr) && /SessionManagerPlugin/.test(r3.stderr),
    JSON.stringify(r3.stderr)
  );

  h1.dispose();
  h2.dispose();
  h3.dispose();
  close();
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error('HARNESS CRASH', e);
  process.exit(1);
});
