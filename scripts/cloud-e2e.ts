/**
 * Cloud-continuation protocol verification (spec docs/specs/cloud-continuation.md).
 * Runs under ELECTRON_RUN_AS_NODE so better-sqlite3 loads. It exercises the FULL
 * cloud path — writeTurnJob → maestro-drain (detached) → journal → follower →
 * finalize → persisted message — without a real SSH server, by registering a
 * fake ExecHost that runs everything locally under a temp $HOME with a fake
 * `claude` on PATH. Asserts:
 *   - a detached, journalled turn completes and its structured output is persisted
 *   - a second message queued behind it drains IN ORDER on the box
 *   - the second turn resumes the first's session id, recovered from the journal
 *   - boot/reconnect catch-up replays a completed journal turn idempotently
 *
 *   npx esbuild scripts/cloud-e2e.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:better-sqlite3 --external:node-pty \
 *     --external:electron-updater --external:ssh2 --external:cpu-features \
 *     --outfile=dist/cloud-e2e.cjs && ELECTRON_RUN_AS_NODE=1 npx electron dist/cloud-e2e.cjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { resolveShellEnv } from '../src/main/env';
import { initDb, Messages, Scheduled, Settings, Workspaces, now, uid } from '../src/main/db';
import { setWindow } from '../src/main/bus';
import { setSshHostFactory, localHost } from '../src/main/hosts';
import { addProject, createWorkspace } from '../src/main/services/workspaces';
import { sendChat, scheduleChat } from '../src/main/services/chat';
import { catchUpAll, stopAllFollowers } from '../src/main/services/cloud';
import { cancelScheduled, fireRemoteScheduled } from '../src/main/services/schedule';
import { setWorkspaceCloud } from '../src/main/services/cloudmove';
import type { ExecHost } from '../src/main/hosts/types';

const ROOT = path.join(os.tmpdir(), `maestro-cloud-e2e-${process.pid}`);
const BOX_HOME = path.join(ROOT, 'box-home'); // the fake "box" $HOME
const FAKE_BIN = path.join(ROOT, 'bin');
const REPO = path.join(ROOT, 'repo');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

// A fake `claude` that speaks the stream-json protocol: echoes a resumed session
// id (recovered from --resume) so continuity is observable, and reads the prompt
// off stdin like the real CLI.
const FAKE_CLAUDE = `#!/bin/sh
case "$1" in --version) echo "claude-fake 1.0.0"; exit 0;; esac
cat >/dev/null 2>&1   # consume the prompt on stdin
resume=""; prev=""
for a in "$@"; do [ "$prev" = "--resume" ] && resume="$a"; prev="$a"; done
if [ -n "$resume" ]; then sid="$resume"; note="resumed=$resume"; else sid="S1FRESH"; note="fresh"; fi
printf '{"type":"system","subtype":"init","session_id":"%s"}\\n' "$sid"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"reply %s"}]}}\\n' "$note"
printf '{"type":"result","subtype":"success","session_id":"%s","is_error":false,"total_cost_usd":0.01,"duration_ms":10,"result":"reply %s"}\\n' "$sid" "$note"
`;

/** A host that IS localHost but reports a non-'local' id (so it counts as cloud)
 *  and forces $HOME + PATH to the test sandbox. */
function fakeBoxHost(): ExecHost {
  return {
    id: 'testbox',
    platform: 'linux',
    path: path.posix,
    exec: (cmd, args, opts = {}) =>
      localHost.exec(cmd, args, {
        ...opts,
        env: { ...opts.env, HOME: BOX_HOME, PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}` },
      }),
    spawnStream: (cmd, args, opts) => localHost.spawnStream(cmd, args, opts),
    pty: (o) => localHost.pty(o),
    fs: localHost.fs,
    watch: (r, cb) => localHost.watch(r, cb),
    refreshEnv: () => {},
    connect: async () => {},
    dispose: () => {},
    forwardLoopback: undefined,
  };
}

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
  // Keep local worktrees + mirrors inside the sandbox (createWorkspace uses maestroHome()).
  process.env.MAESTRO_HOME = path.join(ROOT, 'local');
  resolveShellEnv();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.mkdirSync(BOX_HOME, { recursive: true });
  fs.writeFileSync(path.join(FAKE_BIN, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  // The "box" needs a git identity for checkpoint commits (HOME is BOX_HOME there).
  fs.writeFileSync(path.join(BOX_HOME, '.gitconfig'), '[user]\n  name = Maestro Test\n  email = test@maestro.local\n');

  initDb(path.join(ROOT, 'db.sqlite'));
  const events: { channel: string; payload: any }[] = [];
  setWindow({
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: { send: (channel: string, payload: any) => events.push({ channel, payload }) },
  } as any);
  // A saved API key makes the remote harness probe report "authed" without a
  // real credentials file, and disables notifications during the run.
  Settings.setGlobal({ harnessApiKeys: { 'claude-code': 'test-key' }, notifications: false });

  // A local git repo + project + one worktree workspace, then flipped to cloud
  // (we test the continuation core, not the git-bundle move — that just sets
  // ws.hostId, which is the one resolution that makes the box path light up).
  fs.mkdirSync(REPO, { recursive: true });
  execSync('git init -b main && git config user.email e2e@maestro.local && git config user.name "Maestro E2E" && git add -A && git commit -q --allow-empty -m init', { cwd: REPO });
  setSshHostFactory((hostId) => (hostId === 'testbox' ? fakeBoxHost() : null));

  const project = await addProject({ mode: 'local', path: REPO });
  const ws = await createWorkspace({ projectId: project.id, harness: 'claude-code' });
  await waitFor(() => Workspaces.get(ws.id)?.status !== 'setting-up', 30_000, 'provision');
  // Skip AI titling and flip to cloud.
  Workspaces.patchChat(ws.id, 1, { titleCustom: true, title: 'test' });
  const w = Workspaces.get(ws.id)!;
  w.title = 'test';
  Workspaces.update(w);
  Workspaces.setCloudHost(ws.id, 'testbox');

  // ---- Test 1: two detached, journalled turns; queue order; session recovery ----
  const r1 = await sendChat({ workspaceId: ws.id, agentId: 1, text: 'first message', attachments: [] });
  check('first cloud send accepted', r1.ok, r1.error ?? '');
  const r2 = await sendChat({ workspaceId: ws.id, agentId: 1, text: 'second message', attachments: [] });
  check('second cloud send accepted (queued on the box)', r2.ok, r2.error ?? '');

  const got2 = await waitFor(() => agentText(ws.id).length >= 2, 30_000, 'two agent replies');
  const replies = agentText(ws.id);
  check('two turns finalized from the journal', got2, `got ${replies.length}: ${JSON.stringify(replies)}`);
  check('turn 1 ran fresh', replies[0]?.includes('fresh') === true, replies[0]);
  check(
    'turn 2 resumed turn 1 session id (recovered from the journal)',
    replies[1]?.includes('resumed=S1FRESH') === true,
    replies[1]
  );

  // ---- Test 2: boot/reconnect catch-up replays a completed journal, idempotently ----
  const ws2 = await createWorkspace({ projectId: project.id, harness: 'claude-code', name: 'catchup' });
  await waitFor(() => Workspaces.get(ws2.id)?.status !== 'setting-up', 30_000, 'provision ws2');
  Workspaces.setCloudHost(ws2.id, 'testbox');
  const chatDir = path.posix.join(BOX_HOME, 'maestro', 'cloud', ws2.id, '1');
  fs.mkdirSync(path.join(chatDir, 'queue'), { recursive: true });
  const turnId = uid();
  const journal =
    [
      `{"maestro":"turn-start","turnId":"${turnId}","at":1}`,
      `{"type":"system","subtype":"init","session_id":"SX"}`,
      `{"type":"assistant","message":{"content":[{"type":"text","text":"caught up"}]}}`,
      `{"type":"result","subtype":"success","session_id":"SX","is_error":false,"total_cost_usd":0,"duration_ms":1,"result":"caught up"}`,
      `{"maestro":"turn-end","turnId":"${turnId}","exit":0,"at":2}`,
    ].join('\n') + '\n';
  fs.writeFileSync(path.join(chatDir, 'journal.jsonl'), journal);
  Workspaces.patchChat(ws2.id, 1, { journalOffset: 0 });

  stopAllFollowers();
  await catchUpAll();
  const replayed = await waitFor(() => Messages.exists(turnId), 15_000, 'catch-up replay');
  check('catch-up materialized the completed away-turn', replayed);
  check('replayed turn text is correct', Messages.get(turnId)?.content.includes('caught up') === true);

  const countAfter = Messages.list(ws2.id).length;
  stopAllFollowers();
  await catchUpAll();
  await new Promise((r) => setTimeout(r, 2500));
  check(
    'catch-up is idempotent (no duplicate on re-run)',
    Messages.list(ws2.id).length === countAfter,
    `before ${countAfter}, after ${Messages.list(ws2.id).length}`
  );

  // ---- Test 3: move a conversation to the cloud and back (git-bundle sync, §6.6) ----
  const ws3 = await createWorkspace({ projectId: project.id, harness: 'claude-code', name: 'movetest' });
  await waitFor(() => Workspaces.get(ws3.id)?.status !== 'setting-up', 30_000, 'provision ws3');
  const wt3 = Workspaces.get(ws3.id)!.worktreePath;
  fs.writeFileSync(path.join(wt3, 'file.txt'), 'committed\n');
  execSync('git add -A && git commit -q -m add', { cwd: wt3 });
  fs.writeFileSync(path.join(wt3, 'file.txt'), 'dirty edit\n'); // uncommitted → must travel
  Workspaces.setSession(ws3.id, 1, 'stale-session'); // host-bound; must be cleared on the move

  const mv = await setWorkspaceCloud(ws3.id, 'testbox');
  check('move to cloud succeeded', mv.ok, mv.error ?? '');
  const moved = Workspaces.get(ws3.id)!;
  check('workspace flipped onto the box', moved.hostId === 'testbox', `hostId=${moved.hostId}`);
  check('worktree now lives on the box', moved.worktreePath.includes('box-home/maestro/workspaces'), moved.worktreePath);
  const remoteFile = path.join(moved.worktreePath, 'file.txt');
  check('committed content synced via bundle', fs.existsSync(remoteFile) && fs.readFileSync(remoteFile, 'utf8').length > 0);
  check(
    'uncommitted (dirty) state travelled',
    fs.existsSync(remoteFile) && fs.readFileSync(remoteFile, 'utf8').includes('dirty edit')
  );
  check('host-bound session cleared on move', Object.keys(Workspaces.getSessions(ws3.id)).length === 0);
  check('local worktree removed', !fs.existsSync(wt3));

  const bk = await setWorkspaceCloud(ws3.id, null);
  check('bring local succeeded', bk.ok, bk.error ?? '');
  const back = Workspaces.get(ws3.id)!;
  check('workspace flipped back home', back.hostId === null);
  check(
    'branch content restored locally',
    fs.existsSync(path.join(back.worktreePath, 'file.txt')) &&
      fs.readFileSync(path.join(back.worktreePath, 'file.txt'), 'utf8').length > 0,
    back.worktreePath
  );

  // ---- Test 4: box-side scheduling (§4) — job file, row, cancel, fire ----
  const ws4 = await createWorkspace({ projectId: project.id, harness: 'claude-code', name: 'sched' });
  await waitFor(() => Workspaces.get(ws4.id)?.status !== 'setting-up', 30_000, 'provision ws4');
  Workspaces.patchChat(ws4.id, 1, { titleCustom: true, title: 'sched' });
  Workspaces.setCloudHost(ws4.id, 'testbox');
  const schedDir = path.posix.join(BOX_HOME, 'maestro', 'cloud', ws4.id, '1');

  const deliverAt = now() + 3_600_000; // 1h out
  const sr = await scheduleChat({ workspaceId: ws4.id, agentId: 1, text: 'scheduled hi', attachments: [], deliverAt, kind: 'at' });
  check('scheduleChat on a cloud workspace accepted', sr.ok, sr.error ?? '');
  const rows = Scheduled.forWorkspace(ws4.id);
  check('a scheduled row was inserted with remoteTurnId', rows.length === 1 && !!rows[0]?.remoteTurnId, JSON.stringify(rows[0]?.remoteTurnId));
  const rTurnId = rows[0]!.remoteTurnId!;
  const schedFiles = fs.existsSync(path.join(schedDir, 'scheduled')) ? fs.readdirSync(path.join(schedDir, 'scheduled')) : [];
  check(
    'a scheduled job file was written (10-digit epoch + turnId)',
    schedFiles.length === 1 && /^\d{10}-.+\.job$/.test(schedFiles[0]) && schedFiles[0].includes(rTurnId),
    JSON.stringify(schedFiles)
  );
  check('turn.sh was written for the scheduled-first chat', fs.existsSync(path.join(schedDir, 'turn.sh')));

  // nextAt skips an overdue REMOTE row (the box delivers those; re-arming at 0 would spin).
  check('nextAt counts the future remote row', Scheduled.nextAt(now()) === deliverAt, String(Scheduled.nextAt(now())));
  Scheduled.insert({ id: uid(), workspaceId: ws4.id, agentId: 1, text: 'overdue', attachments: [], kind: 'at', deliverAt: now() - 1000, createdAt: now(), remoteTurnId: 'overdue-turn' });
  check('nextAt skips the overdue remote row', Scheduled.nextAt(now()) === deliverAt, String(Scheduled.nextAt(now())));
  Scheduled.remove(Scheduled.byRemoteTurnId('overdue-turn')!.id);

  // cancel removes the box job file AND the row.
  const cancelRes = await cancelScheduled(ws4.id, 1, rows[0]!.id);
  check('cancelScheduled ok for a reachable box', cancelRes.ok, cancelRes.error ?? '');
  check('cancel removed the job file', (fs.existsSync(path.join(schedDir, 'scheduled')) ? fs.readdirSync(path.join(schedDir, 'scheduled')) : []).length === 0);
  check('cancel removed the row', Scheduled.forWorkspace(ws4.id).length === 0);

  // fireRemoteScheduled records the user message at the box time and drops the row.
  const deliverAt2 = now() + 7_200_000;
  await scheduleChat({ workspaceId: ws4.id, agentId: 1, text: 'scheduled hi 2', attachments: [], deliverAt: deliverAt2, kind: 'at' });
  const row2 = Scheduled.forWorkspace(ws4.id)[0]!;
  const fireAt = now() - 5000; // pretend the box started the turn 5s ago
  events.length = 0;
  fireRemoteScheduled(row2.remoteTurnId!, fireAt);
  const userMsg = Messages.list(ws4.id).find((m) => m.role === 'user' && m.content === 'scheduled hi 2');
  check('fireRemoteScheduled recorded the user message', !!userMsg);
  check('user message carries the box time as ts', userMsg?.ts === fireAt, `${userMsg?.ts} vs ${fireAt}`);
  check('fireRemoteScheduled dropped the row', Scheduled.forWorkspace(ws4.id).length === 0);
  check('fireRemoteScheduled broadcast chat:scheduled', events.some((e) => e.channel === 'chat:scheduled'));
  check('fireRemoteScheduled broadcast chat:message', events.some((e) => e.channel === 'chat:message'));

  stopAllFollowers();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CLOUD E2E CHECKS PASSED');
  // Best-effort cleanup of any box drain still holding the temp dir.
  try {
    execSync(`pkill -f maestro-drain 2>/dev/null; true`);
  } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('CLOUD_E2E_FAIL', e);
  process.exit(1);
});
