/**
 * Maestro Cloud free-beta e2e — the continuation protocol over REAL SSH to the
 * live Railway box (docs/specs/maestro-cloud-free-beta.md). Proves the managed
 * host is byte-for-byte a normal SSH host: a cloud turn is uploaded, the drain
 * loop runs it detached on the box, and the app tails the journal over the wire
 * and finalizes — including session recovery across a queued second turn.
 *
 * Auth barrier: a real Claude login needs a human, so we shadow `claude` with a
 * fake that speaks stream-json (installed in ~/.maestro/bin, which turn.sh puts
 * first on PATH — the readiness probe still sees the real baked CLI + an API key).
 *
 * Config comes from env (the signup response): MC_HOST MC_PORT MC_USER MC_KEY
 * MC_HOSTKEY MC_PORTBASE.
 *
 *   node dist/maestro-cloud-e2e.cjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { resolveShellEnv } from '../src/main/env';
import { initDb, Hosts, Messages, Projects, Settings, Workspaces, now, uid } from '../src/main/db';
import { setWindow } from '../src/main/bus';
import { initSshHosts } from '../src/main/hosts/ssh';
import { hostById } from '../src/main/hosts';
import { addProject } from '../src/main/services/workspaces';
import { sendChat } from '../src/main/services/chat';
import { stopAllFollowers } from '../src/main/services/cloud';
import type { Workspace } from '../src/shared/types';

const ROOT = path.join(os.tmpdir(), `mc-real-e2e-${process.pid}`);
const REPO = path.join(ROOT, 'repo');
const { MC_HOST, MC_PORT, MC_USER, MC_KEY, MC_HOSTKEY, MC_PORTBASE } = process.env;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
async function waitFor(pred: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

const FAKE_CLAUDE = `#!/bin/sh
case "$1" in --version) echo "claude-fake 1.0.0"; exit 0;; esac
cat >/dev/null 2>&1
resume=""; prev=""
for a in "$@"; do [ "$prev" = "--resume" ] && resume="$a"; prev="$a"; done
if [ -n "$resume" ]; then sid="$resume"; note="resumed=$resume"; else sid="MCFRESH"; note="fresh"; fi
printf '{"type":"system","subtype":"init","session_id":"%s"}\\n' "$sid"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"reply %s"}]}}\\n' "$note"
printf '{"type":"result","subtype":"success","session_id":"%s","is_error":false,"total_cost_usd":0.01,"duration_ms":10,"result":"reply %s"}\\n' "$sid" "$note"
`;

function agentText(wsId: string): string[] {
  return Messages.list(wsId)
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
  if (!MC_HOST || !MC_USER || !MC_KEY) {
    console.error('missing MC_HOST/MC_USER/MC_KEY env (from signup)');
    process.exit(2);
  }
  process.env.MAESTRO_HOME = path.join(ROOT, 'local');
  resolveShellEnv();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  execSync('git init -b main && git add -A && git commit -q --allow-empty -m init', { cwd: REPO });

  initDb(path.join(ROOT, 'db.sqlite'));
  initSshHosts();
  setWindow({ isDestroyed: () => false, isFocused: () => true, webContents: { send: () => {} } } as any);
  Settings.setGlobal({ harnessApiKeys: { 'claude-code': 'test-key' }, notifications: false });

  // Save the managed host exactly as the signup client would.
  const hostId = 'mcbox';
  Hosts.upsert({
    id: hostId,
    label: 'Maestro Cloud',
    host: MC_HOST,
    port: Number(MC_PORT || 22),
    user: MC_USER,
    auth: 'key',
    keyPath: MC_KEY,
    hostKeyFingerprint: MC_HOSTKEY,
    managed: true,
    portBase: Number(MC_PORTBASE || 4100),
  });
  const host = hostById(hostId);
  await host.connect?.();
  check('SSH connect to the managed box', (await host.exec('whoami', [])).stdout.trim() === MC_USER);

  // Prepare the box: a worktree dir + the fake claude shadowing the baked one.
  const home = (await host.exec('sh', ['-lc', 'printf %s "$HOME"'])).stdout.trim();
  const boxWt = `${home}/mc-e2e-wt`;
  await host.fs.mkdirp(boxWt);
  await host.exec('git', ['init', '-b', 'main', boxWt]);
  const binDir = `${home}/.maestro/bin`;
  await host.fs.mkdirp(binDir);
  await host.fs.write(`${binDir}/claude`, FAKE_CLAUDE);
  await host.fs.chmod(`${binDir}/claude`, 0o755);

  const project = await addProject({ mode: 'local', path: REPO });
  const ws: Workspace = {
    id: uid(),
    projectId: project.id,
    name: 'mc-e2e',
    hostId,
    branch: 'main',
    wsKind: 'worktree',
    title: 'mc',
    subtitle: null,
    worktreePath: boxWt,
    harness: 'claude-code',
    status: 'idle',
    port: Number(MC_PORTBASE || 4100),
    archived: false,
    createdAt: now(),
    lastUserMessageAt: null,
    prNumber: null,
    prUrl: null,
    prState: null,
    setupError: null,
  };
  Workspaces.insert(ws);
  Workspaces.patchChat(ws.id, 1, { titleCustom: true, title: 'mc' });

  // Two cloud turns over real SSH: detached drain + journal tail + finalize,
  // with the second resuming the first's session id from the journal.
  const r1 = await sendChat({ workspaceId: ws.id, agentId: 1, text: 'first', attachments: [] });
  check('first cloud send accepted', r1.ok, r1.error ?? '');
  const r2 = await sendChat({ workspaceId: ws.id, agentId: 1, text: 'second', attachments: [] });
  check('second cloud send accepted (queued on the box)', r2.ok, r2.error ?? '');

  const got = await waitFor(() => agentText(ws.id).length >= 2, 90_000, 'two agent replies over SSH');
  const replies = agentText(ws.id);
  check('two turns finalized from the journal over real SSH', got, `got ${JSON.stringify(replies)}`);
  check('turn 1 ran fresh', replies[0]?.includes('fresh') === true, replies[0]);
  check('turn 2 recovered turn 1 session id over SSH', replies[1]?.includes('resumed=MCFRESH') === true, replies[1]);

  // Diagnostics on failure: dump the box's turn.sh + journal.
  if (failures) {
    const chatDir = `${home}/maestro/cloud/${ws.id}/1`;
    const j = await host.exec('sh', ['-lc', `cat "${chatDir}/journal.jsonl" 2>/dev/null`]).catch(() => null);
    const t = await host.exec('sh', ['-lc', `cat "${chatDir}/turn.sh" 2>/dev/null`]).catch(() => null);
    console.log('\n--- turn.sh ---\n' + (t?.stdout ?? '(none)'));
    console.log('\n--- journal.jsonl ---\n' + (j?.stdout ?? '(none)'));
  }

  // Clean up the box (leave the account for the operator to DELETE via the API).
  stopAllFollowers();
  await host.exec('sh', ['-lc', `rm -rf "${home}/maestro/cloud" "${boxWt}" "${binDir}/claude"`]).catch(() => {});
  host.dispose?.();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL MAESTRO CLOUD E2E CHECKS PASSED');
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('MC_E2E_FAIL', e);
  process.exit(1);
});
