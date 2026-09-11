/**
 * End-to-end test for the Conductor importer against a self-contained fixture:
 * a real git repo + worktree, a conductor.db shaped like the real one, and Claude
 * transcripts on disk. Exercises scan (db + fs fallback), adopt-in-place import,
 * session→chat mapping, husk-dropping, harness/transcript skips, and idempotency.
 *
 *   npx esbuild scripts/conductor-import-test.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:better-sqlite3 --outfile=dist/conductor-import-test.cjs
 *   ELECTRON_RUN_AS_NODE=1 npx electron dist/conductor-import-test.cjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { initDb, Projects, Workspaces, Messages } from '../src/main/db';
import { scanConductor, importConductor } from '../src/main/services/conductorImport';
import { recreateAdoptedFromBranch } from '../src/main/services/workspaces';

// Anchor on the realpath'd tmpdir so paths match git's symlink-resolved output
// (macOS /var → /private/var), the same normalization the scanner does.
const ROOT = path.join(fs.realpathSync.native(os.tmpdir()), 'conductor-import-test');
const HOME = path.join(ROOT, 'home'); // MAESTRO_CONDUCTOR_HOME
const REPO = path.join(HOME, 'conductor', 'repos', 'demo');
const WT = path.join(HOME, 'conductor', 'workspaces', 'demo', 'warsaw'); // live worktree
const HUSK = path.join(HOME, 'conductor', 'workspaces', 'demo', 'husk'); // unregistered dir
const DB_PATH = path.join(HOME, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');

const munge = (p: string) => p.replace(/[^A-Za-z0-9-]/g, '-');
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe' });

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  }
}

function writeTranscript(worktreePath: string, sessionId: string, firstUser: string) {
  const dir = path.join(HOME, '.claude', 'projects', munge(worktreePath));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    // The injected Conductor preamble comes first in real transcripts — the title
    // deriver must skip it and land on the real prompt below.
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<system_instruction>You are working inside Conductor…</system_instruction>' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: firstUser } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function buildConductorDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  // A trimmed copy of the real schema (only the columns the scanner reads/filters).
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, remote_url TEXT,
      default_branch TEXT, display_order INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT,
      workspace_path TEXT, branch TEXT, state TEXT DEFAULT 'ready', updated_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, claude_session_id TEXT,
      agent_type TEXT, title TEXT, model TEXT, is_hidden INTEGER DEFAULT 0, updated_at TEXT);
  `);
  db.prepare('INSERT INTO repos VALUES (?,?,?,?,?,?,?)').run('repo-demo', 'demo', REPO, null, 'main', 0, 0);
  db.prepare('INSERT INTO repos VALUES (?,?,?,?,?,?,?)').run('repo-hidden', 'secret', REPO + '-x', null, 'main', 1, 1); // hidden → excluded
  const ws = db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?,?,?)');
  ws.run('ws-warsaw', 'repo-demo', 'warsaw', WT, 'stale-db-branch', 'ready', '2026-07-20T10:00:00.000Z');
  ws.run('ws-archived', 'repo-demo', 'oslo', path.join(HOME, 'conductor/workspaces/demo/oslo'), 'feat/old', 'archived', '2026-07-01T10:00:00.000Z'); // archived → dropped
  ws.run('ws-husk', 'repo-demo', 'husk', HUSK, 'feat/husk', 'ready', '2026-07-19T10:00:00.000Z'); // dir exists but unregistered → dropped
  const ses = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)');
  // Newest → oldest; the newest claude session sets the workspace harness.
  ses.run('s-a', 'ws-warsaw', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'claude', 'Add split view', 'sonnet', 0, '2026-07-20T12:00:00.000Z');
  ses.run('s-b', 'ws-warsaw', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'claude', 'Untitled', null, 0, '2026-07-20T11:00:00.000Z');
  ses.run('s-c', 'ws-warsaw', 'cccccccc-3333-4333-8333-cccccccccccc', 'claude', 'No transcript', null, 0, '2026-07-20T10:30:00.000Z');
  ses.run('s-d', 'ws-warsaw', 'dddddddd-4444-4444-8444-dddddddddddd', 'codex', 'A codex chat', null, 0, '2026-07-20T09:00:00.000Z');
  ses.run('s-hidden', 'ws-warsaw', 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee', 'claude', 'hidden', null, 1, '2026-07-20T08:00:00.000Z'); // is_hidden → excluded
  db.close();
}

async function waitIdle(id: string, ms = 20_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const w = Workspaces.get(id);
    if (w && w.status !== 'setting-up') return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  process.env.MAESTRO_CONDUCTOR_HOME = HOME;
  process.env.MAESTRO_HOME = path.join(ROOT, 'maestro-home');

  // 1. Real repo + a linked worktree on a real branch (git is the branch authority).
  sh('git init -b main', REPO);
  sh('git config user.email t@t.dev && git config user.name Test', REPO);
  fs.writeFileSync(path.join(REPO, 'README.md'), '# demo\n');
  sh('git add -A && git commit -m init', REPO);
  fs.mkdirSync(path.dirname(WT), { recursive: true });
  sh(`git worktree add -b feat/split "${WT}"`, REPO); // real branch differs from the DB column
  fs.mkdirSync(HUSK, { recursive: true }); // a husk dir NOT registered as a worktree

  // 2. Transcripts for A and B (C intentionally missing on disk).
  writeTranscript(WT, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'Build the split view toggle please');
  writeTranscript(WT, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'Refactor the pane layout tree');

  // 3. conductor.db + Maestro's own DB.
  buildConductorDb();
  initDb(path.join(ROOT, 'maestro.db'));

  // ---- SCAN (db) ----
  console.log('\nSCAN (db mode):');
  const scan = await scanConductor();
  check('detected', scan.detected === true);
  check('source = db', scan.source === 'db', scan.source);
  check('one project (hidden repo excluded)', scan.projects.length === 1, scan.projects.length);
  const p = scan.projects[0];
  check('project name = demo', p?.name === 'demo', p?.name);
  check('repoPath = repo root', p?.repoPath === REPO, p?.repoPath);
  check('not missing', p?.missing === false);
  check('not alreadyImported', p?.alreadyImported === false);
  check('one live workspace (archived + husk dropped)', p?.workspaces.length === 1, p?.workspaces.map((w) => w.name));
  const w = p?.workspaces[0];
  check('workspace name = warsaw', w?.name === 'warsaw', w?.name);
  check('branch is git-derived (feat/split, not the stale DB column)', w?.branch === 'feat/split', w?.branch);
  check('worktree path', w?.path === WT, w?.path);
  check('sessionCount = 4 (hidden excluded; C/D still counted pre-verify)', w?.sessionCount === 4, w?.sessionCount);

  // ---- IMPORT ----
  console.log('\nIMPORT:');
  const res = await importConductor([{ key: 'repo-demo' }]);
  check('projects imported = 1', res.projects === 1, res.projects);
  check('workspaces imported = 1', res.workspaces === 1, res.workspaces);
  check('chats imported = 2 (A + B)', res.chats === 2, res.chats);
  check('skipped C (no transcript) + D (harness mismatch)', res.skipped.length === 2, res.skipped);
  check('focusWorkspaceId set', !!res.focusWorkspaceId);

  const proj = Projects.byPath(REPO, null);
  check('project persisted as git', proj?.kind === 'git', proj?.kind);
  const ws = proj ? Workspaces.forProject(proj.id) : [];
  check('one workspace row', ws.length === 1, ws.length);
  const imported = ws[0];
  check('adopted in-place', imported?.wsKind === 'in-place', imported?.wsKind);
  check('worktreePath = the Conductor dir (adopted, not a copy)', imported?.worktreePath === WT, imported?.worktreePath);
  check('branch = feat/split', imported?.branch === 'feat/split', imported?.branch);
  check('harness = claude-code (newest session)', imported?.harness === 'claude-code', imported?.harness);
  if (imported) await waitIdle(imported.id);

  const sessions = imported ? Workspaces.getSessions(imported.id) : {};
  const chats = imported ? Workspaces.getChats(imported.id) : {};
  check('two resume sessions seated', Object.keys(sessions).length === 2, sessions);
  const resumeIds = Object.values(sessions);
  check('resume id A present', resumeIds.includes('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'));
  check('resume id B present', resumeIds.includes('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'));
  check('C not seated (transcript missing)', !resumeIds.includes('cccccccc-3333-4333-8333-cccccccccccc'));
  const titles = Object.values(chats).map((c: any) => c.title);
  check('DB title used (Add split view)', titles.includes('Add split view'), titles);
  check('Untitled → JSONL first prompt (skips preamble)', titles.includes('Refactor the pane layout tree'), titles);
  // Newest session gets the highest agentId (focused on open).
  const newestAgentId = Math.max(...Object.keys(sessions).map(Number));
  check('newest session (A) has the highest agentId', sessions[String(newestAgentId)] === 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', sessions);
  const msgs = imported ? Messages.list(imported.id) : [];
  const markers = msgs.filter((m) => m.role === 'system' && m.content.includes('Imported from Conductor'));
  check('one import marker per chat', markers.length === 2, markers.length);

  // ---- IDEMPOTENCY (re-import) ----
  console.log('\nRE-IMPORT (idempotent):');
  const res2 = await importConductor([{ key: 'repo-demo' }]);
  check('no new project', res2.projects === 0, res2.projects);
  check('no new workspace', res2.workspaces === 0, res2.workspaces);
  check('no new chats', res2.chats === 0, res2.chats);
  const ws2 = proj ? Workspaces.forProject(proj.id) : [];
  check('still one workspace', ws2.length === 1, ws2.length);
  check('still two chats', imported ? Object.keys(Workspaces.getChats(imported.id)).length === 2 : false);

  // ---- alreadyImported reflected on re-scan ----
  console.log('\nRE-SCAN (after import):');
  const scan2 = await scanConductor();
  check('project now alreadyImported', scan2.projects[0]?.alreadyImported === true);
  check('workspace now alreadyImported', scan2.projects[0]?.workspaces[0]?.alreadyImported === true);

  // ---- FS FALLBACK (corrupt the DB → schema-drift path) ----
  console.log('\nSCAN (fs fallback):');
  const cdb = new Database(DB_PATH);
  cdb.exec('DROP TABLE sessions'); // a missing table forces the fs walk (G4)
  cdb.close();
  const scanFs = await scanConductor();
  check('source = fs', scanFs.source === 'fs', scanFs.source);
  const pf = scanFs.projects.find((x) => x.repoPath === REPO);
  check('fs found the repo', !!pf, scanFs.projects.map((x) => x.repoPath));
  check('fs found the live worktree (husk dropped)', pf?.workspaces.some((x) => x.path === WT) === true, pf?.workspaces.map((x) => x.name));
  check('fs did NOT include the husk', pf?.workspaces.some((x) => x.path === HUSK) === false);
  const wf = pf?.workspaces.find((x) => x.path === WT);
  check('fs branch = feat/split', wf?.branch === 'feat/split', wf?.branch);
  check('fs session count = 2 (transcripts on disk)', wf?.sessionCount === 2, wf?.sessionCount);

  // ---- RECREATE FROM BRANCH (adopted dir archived in Conductor, §4/G6) ----
  console.log('\nRECREATE FROM BRANCH:');
  // Simulate Conductor archiving the workspace: remove its worktree, freeing the
  // branch (which survives) — exactly the state the recreate action recovers from.
  sh(`git worktree remove --force "${WT}"`, REPO);
  check('adopted dir gone (archived in Conductor)', !fs.existsSync(WT));
  const rec = imported ? await recreateAdoptedFromBranch(imported.id) : { ok: false };
  check('recreate ok', rec.ok === true, rec);
  const recWs = imported ? Workspaces.get(imported.id) : null;
  check('now a normal worktree', recWs?.wsKind === 'worktree', recWs?.wsKind);
  check('worktree moved under ~/maestro', recWs?.worktreePath.startsWith(process.env.MAESTRO_HOME!) === true, recWs?.worktreePath);
  check('fresh worktree exists on disk', !!recWs && fs.existsSync(recWs.worktreePath));
  check('still on feat/split', recWs?.branch === 'feat/split', recWs?.branch);
  check('imported chats preserved', recWs ? Object.keys(Workspaces.getChats(recWs.id)).length === 2 : false);

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST_CRASH', e);
  process.exit(1);
});
