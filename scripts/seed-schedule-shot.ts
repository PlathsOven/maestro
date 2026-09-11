/**
 * Seed a DB with a worked chat plus two pending scheduled messages, so a normal
 * `--smoke --screenshot` run of the real app captures the Scheduled card and
 * the composer's send-later control.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron dist/seed-schedule-shot.cjs
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { resolveShellEnv } from '../src/main/env';
import { Messages, Scheduled, Settings, Workspaces, initDb, now, uid } from '../src/main/db';
import { addProject, createWorkspace } from '../src/main/services/workspaces';

const ROOT = process.env.SCHED_SHOT_ROOT || path.join(process.env.TEMP || '/tmp', 'maestro-sched-shot');
const REPO = path.join(ROOT, 'demo-repo');

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe' });

async function waitIdle(id: string, ms = 90_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const w = Workspaces.get(id);
    if (w && w.status !== 'setting-up') return w;
    await new Promise((r) => setTimeout(r, 400));
  }
  return Workspaces.get(id);
}

async function main() {
  resolveShellEnv();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  process.env.MAESTRO_HOME = path.join(ROOT, 'home');

  sh('git init -b main', REPO);
  sh('git config user.email demo@maestro.app', REPO);
  sh('git config user.name Maestro', REPO);
  fs.writeFileSync(path.join(REPO, 'README.md'), '# demo\n\nA repo for the scheduled-messages screenshot.\n');
  fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'src/index.ts'), `export const hello = () => 'hi';\n`);
  sh('git add -A', REPO);
  sh('git commit -m "Initial commit"', REPO);

  initDb(path.join(ROOT, 'maestro.db'));
  Settings.setGlobal({ theme: 'light', onboarded: true, autoStatus: false } as any);
  const project = await addProject({ mode: 'local', path: REPO } as any);
  const ws = await createWorkspace({ projectId: project.id, harness: 'claude-code' as any } as any);
  await waitIdle(ws.id);

  const fresh = Workspaces.get(ws.id)!;
  fresh.title = 'Add rate-limit backoff';
  fresh.status = 'idle';
  fresh.lastUserMessageAt = now() - 600_000;
  Workspaces.update(fresh);
  Workspaces.patchChat(ws.id, 1, { title: 'Rate-limit backoff' });

  Messages.insert({
    id: uid(), workspaceId: ws.id, agentId: 1, role: 'user',
    content: 'Add exponential backoff to the fetch retry path.', attachments: [], ts: now() - 600_000,
  });
  Messages.insert({
    id: uid(), workspaceId: ws.id, agentId: 1, role: 'agent',
    content: JSON.stringify([{ kind: 'text', text: 'Done — retries now back off 1s → 2s → 4s with jitter, capped at 30s.' }]),
    attachments: [], ts: now() - 570_000,
  });

  // Two pending sends: one aimed at a usage-window reset, one at a wall clock.
  const evening = new Date();
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() <= now()) evening.setDate(evening.getDate() + 1);
  Scheduled.insert({
    id: uid(), workspaceId: ws.id, agentId: 1,
    text: 'Now port the same backoff to the websocket reconnect path and add tests.',
    attachments: [], kind: 'limit-reset', deliverAt: now() + 3 * 3_600_000 + 12 * 60_000, createdAt: now(),
  });
  Scheduled.insert({
    id: uid(), workspaceId: ws.id, agentId: 1,
    text: 'Write up the retry semantics in docs/retries.md.',
    attachments: [], kind: 'at', deliverAt: evening.getTime(), createdAt: now(),
  });

  console.log(`SEED_OK db=${path.join(ROOT, 'maestro.db')} ws=${ws.id}`);
  process.exit(0);
}

void main().catch((e) => {
  console.error('SEED_FAIL', e);
  process.exit(1);
});
