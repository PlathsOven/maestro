/**
 * Harness chat sync verification (docs/specs/harness-chat-sync.md §8). Exercises
 * the pure folds (§6.2), the scan/placement/import (§5, §6.7), live-tail ingest +
 * idempotency + the Maestro-own-turn fence (§6.3/§6.5), and the live-elsewhere
 * guard (§6.6), against fixture ~/.claude and ~/.codex trees under a temp DB — no
 * Electron window. Runs under plain node (native modules built for node), like the
 * other *-e2e scripts.
 *
 *   npx esbuild scripts/harness-sync-e2e.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:better-sqlite3 --external:node-pty \
 *     --external:electron-updater --external:ssh2 --external:cpu-features \
 *     --outfile=dist/harness-sync-e2e.cjs && node dist/harness-sync-e2e.cjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.join(fs.realpathSync.native(os.tmpdir()), `maestro-harness-sync-e2e-${process.pid}`);
const CLAUDE_HOME = path.join(ROOT, 'claude'); // MAESTRO_CLAUDE_HOME (= a .claude dir)
const CODEX_HOME = path.join(ROOT, 'codex'); // MAESTRO_CODEX_HOME (= a .codex dir)
const REPO = path.join(ROOT, 'repo');

process.env.MAESTRO_CLAUDE_HOME = CLAUDE_HOME;
process.env.MAESTRO_CODEX_HOME = CODEX_HOME;
process.env.MAESTRO_HOME = path.join(ROOT, 'maestro');
process.env.MAESTRO_DB_PATH = path.join(ROOT, 'maestro.db');

import { initDb, Messages, Projects, Settings, Workspaces } from '../src/main/db';
import { setWindow } from '../src/main/bus';
import { foldClaudeLines, foldCodexLines } from '../src/shared/harness/transcripts';
import { scanHarnessSync, importHarnessSync, harnessSyncStatus } from '../src/main/services/harnessSync';
import { ingest } from '../src/main/services/harnessSync/ingest';
import { liveElsewhere } from '../src/main/services/harnessSync/live';

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : detail !== '' ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
}

const mungePath = (p: string) => p.replace(/[^A-Za-z0-9-]/g, '-');
const jl = (arr: any[]) => arr.map((o) => JSON.stringify(o)).join('\n') + '\n';

function claudeFile(cwd: string, sessionId: string): string {
  const dir = path.join(CLAUDE_HOME, 'projects', mungePath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}
function codexFile(sessionId: string): string {
  const dir = path.join(CODEX_HOME, 'sessions', '2026', '09', '07');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-2026-09-07T10-00-00-${sessionId}.jsonl`);
}

// ---- Claude line builders ----
const T0 = Date.parse('2026-09-07T10:00:00Z');
function cUser(uuid: string, text: string, cwd: string, entrypoint = 'cli', typed = true) {
  return {
    type: 'user',
    uuid,
    timestamp: new Date(T0).toISOString(),
    sessionId: 'S',
    cwd,
    gitBranch: 'main',
    entrypoint,
    isSidechain: false,
    ...(typed ? { promptSource: 'typed' } : {}),
    message: { role: 'user', content: text },
  };
}
function cAssistant(uuid: string, text: string, cwd: string, stop = 'end_turn', entrypoint = 'cli') {
  return {
    type: 'assistant',
    uuid,
    timestamp: new Date(T0 + 1000).toISOString(),
    cwd,
    entrypoint,
    message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: stop, content: [{ type: 'text', text }] },
  };
}
function cToolUse(uuid: string, toolId: string, name: string, input: any, cwd: string) {
  return {
    type: 'assistant',
    uuid,
    timestamp: new Date(T0 + 500).toISOString(),
    cwd,
    entrypoint: 'cli',
    message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolId, name, input }] },
  };
}
function cToolResult(uuid: string, toolId: string, out: string, cwd: string) {
  return {
    type: 'user',
    uuid,
    timestamp: new Date(T0 + 600).toISOString(),
    cwd,
    entrypoint: 'cli',
    toolUseResult: { stdout: out },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: out, is_error: false }] },
  };
}

// ---- Codex line builders ----
function cxMeta(sessionId: string, cwd: string, originator = 'codex_cli_rs', source: any = 'cli') {
  return { timestamp: new Date(T0).toISOString(), type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cwd, originator, source, git: { branch: 'main' } } };
}
function cxEvt(type: string, payload: any, dt = 0) {
  return { timestamp: new Date(T0 + dt).toISOString(), type: 'event_msg', payload: { type, ...payload } };
}
function cxItem(type: string, payload: any, dt = 0) {
  return { timestamp: new Date(T0 + dt).toISOString(), type: 'response_item', payload: { type, ...payload } };
}

async function main() {
  const sent: { channel: string; payload: any }[] = [];
  setWindow({ isDestroyed: () => false, webContents: { send: (c: string, p: any) => sent.push({ channel: c, payload: p }) } } as any);

  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(CLAUDE_HOME, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  initDb(process.env.MAESTRO_DB_PATH!);

  // A real git repo so placement/adopt/new-project work.
  fs.mkdirSync(REPO, { recursive: true });
  const sh = (cmd: string) => execSync(cmd, { cwd: REPO, stdio: 'pipe' });
  sh('git init -q');
  sh('git config user.email t@t.co');
  sh('git config user.name t');
  sh('git symbolic-ref HEAD refs/heads/main');
  fs.writeFileSync(path.join(REPO, 'README.md'), '# demo\n');
  sh('git add -A');
  sh('git -c commit.gpgsign=false commit -q -m init');

  // ---------- Phase 1: pure folds ----------
  {
    const lines = [cUser('u1', 'Fix the flaky watcher test', REPO), cAssistant('a1', 'Fixed it.', REPO)].map((o) => JSON.stringify(o));
    const r = foldClaudeLines(lines);
    check('claude fold: one closed turn', r.closed.length === 1 && !r.open, { closed: r.closed.length, open: !!r.open });
    check('claude fold: prompt + by external', r.closed[0]?.prompt.text === 'Fix the flaky watcher test' && r.closed[0]?.by === 'external', r.closed[0]);
    check('claude fold: text block + model', r.closed[0]?.blocks[0]?.type === 'text' && (r.closed[0]?.blocks[0] as any)?.text === 'Fixed it.' && r.closed[0]?.model === 'claude-opus-4-8', r.closed[0]?.blocks);
  }
  {
    // Maestro's own turn (entrypoint sdk-cli) folds to by:'maestro'.
    const lines = [cUser('u1', 'digest please', REPO, 'sdk-cli'), cAssistant('a1', 'ok', REPO)].map((o) => JSON.stringify(o));
    const r = foldClaudeLines(lines);
    check('claude fold: sdk-cli ⇒ by maestro', r.closed[0]?.by === 'maestro', r.closed[0]?.by);
  }
  {
    // Tool-heavy: tool block gets its result attached by id.
    const lines = [
      cUser('u1', 'run tests', REPO),
      cToolUse('a1', 'tool-1', 'Bash', { command: 'npm test' }, REPO),
      cToolResult('r1', 'tool-1', 'all passed', REPO),
      cAssistant('a2', 'Green.', REPO),
    ].map((o) => JSON.stringify(o));
    const r = foldClaudeLines(lines);
    const toolBlock = r.closed[0]?.blocks.find((b) => b.type === 'tool') as any;
    check('claude fold: tool + result attached', !!toolBlock?.result && toolBlock.result.ok === true, toolBlock);
  }
  {
    // Open turn (no end_turn) is returned as `open`.
    const lines = [cUser('u1', 'thinking…', REPO), cAssistant('a1', 'working', REPO, 'tool_use')].map((o) => JSON.stringify(o));
    const r = foldClaudeLines(lines);
    check('claude fold: open turn kept open', !!r.open && r.closed.length === 0, { open: !!r.open, closed: r.closed.length });
  }
  {
    const lines = [
      cxMeta('CX', REPO),
      cxEvt('task_started', { turn_id: 't1' }, 10),
      cxEvt('user_message', { message: 'add a plan toggle' }, 20),
      cxItem('turn_context', { turn_id: 't1', model: 'gpt-5.6-sol' }, 25),
      cxItem('message', { role: 'assistant', content: [{ type: 'output_text', text: 'Added.' }] }, 30),
      cxEvt('task_complete', { turn_id: 't1', duration_ms: 4200 }, 40),
    ].map((o) => JSON.stringify(o));
    const r = foldCodexLines(lines);
    check('codex fold: one closed turn', r.closed.length === 1 && !r.open, { closed: r.closed.length });
    check('codex fold: prompt + text + model + duration', r.closed[0]?.prompt.text === 'add a plan toggle' && (r.closed[0]?.blocks[0] as any)?.text === 'Added.' && r.closed[0]?.model === 'gpt-5.6-sol' && r.closed[0]?.durationMs === 4200, r.closed[0]);
  }

  // ---------- Phase 2: scan + placement + import ----------
  const claudeSession = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  fs.writeFileSync(claudeFile(REPO, claudeSession), jl([cUser('u1', 'Fix the flaky watcher test', REPO), cAssistant('a1', 'Fixed it.', REPO)]));
  // A Maestro-own (sdk-cli) transcript that must be skipped by the scan.
  const maestroSession = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  fs.writeFileSync(claudeFile(REPO, maestroSession), jl([cUser('u1', 'status digest', REPO, 'sdk-cli'), cAssistant('a1', 'ok', REPO)]));

  const scan = await scanHarnessSync();
  const group = scan.groups.find((g) => g.sessions.some((s) => s.sessionId === claudeSession));
  check('scan: session grouped', !!group, scan.groups.map((g) => g.placement.kind));
  check('scan: placement new-project (repo unknown)', group?.placement.kind === 'new-project', group?.placement);
  check('scan: maestro session skipped', scan.skipped.maestro >= 1 && !scan.groups.some((g) => g.sessions.some((s) => s.sessionId === maestroSession)), scan.skipped);

  const imp = await importHarnessSync([claudeSession], true);
  check('import: created project+workspace+chat', imp.projects === 1 && imp.workspaces === 1 && imp.chats === 1, imp);
  check('import: sync enabled', Settings.global().harnessSync?.enabled === true, Settings.global().harnessSync);

  const ws = Workspaces.list()[0];
  check('import: workspace adopted in place on main', !!ws && ws.wsKind === 'in-place' && ws.harness === 'claude-code', ws);
  const linkedAgent = Object.entries(Workspaces.getSessions(ws.id)).find(([, sid]) => sid === claudeSession);
  check('import: session linked to a chat (resumable)', !!linkedAgent, Workspaces.getSessions(ws.id));
  const agentId = Number(linkedAgent![0]);
  const msgs = Messages.list(ws.id).filter((m) => m.agentId === agentId);
  check('import: marker + user + agent rows', msgs.some((m) => m.role === 'system') && msgs.some((m) => m.id === `sync:cc:u1:u`) && msgs.some((m) => m.id === `sync:cc:u1:a`), msgs.map((m) => m.id));
  check('import: rows carry origin claude-code', msgs.find((m) => m.id === 'sync:cc:u1:u')?.meta?.origin === 'claude-code', msgs.find((m) => m.id === 'sync:cc:u1:u')?.meta);
  const marker = msgs.find((m) => m.role === 'system');
  check('import: original timestamp preserved', msgs.find((m) => m.id === 'sync:cc:u1:u')?.ts === T0, msgs.find((m) => m.id === 'sync:cc:u1:u')?.ts);

  // ---------- Phase 3: live tail + idempotency + maestro fence ----------
  const before = Messages.list(ws.id).length;
  await ingest(Workspaces.get(ws.id)!, agentId); // re-ingest whole file
  check('idempotent: re-ingest adds no rows', Messages.list(ws.id).length === before, { before, after: Messages.list(ws.id).length });

  // Append a real external turn, then a Maestro (sdk-cli) turn.
  fs.appendFileSync(claudeFile(REPO, claudeSession), jl([cUser('u2', 'and lint it', REPO), cAssistant('a2', 'Linted.', REPO)]));
  await ingest(Workspaces.get(ws.id)!, agentId, { live: true });
  check('live: appended external turn persisted', Messages.exists('sync:cc:u2:u') && Messages.exists('sync:cc:u2:a'), null);

  fs.appendFileSync(claudeFile(REPO, claudeSession), jl([cUser('u3', 'internal maestro run', REPO, 'sdk-cli'), cAssistant('a3', 'ok', REPO)]));
  await ingest(Workspaces.get(ws.id)!, agentId, { live: true });
  check('live: maestro (sdk-cli) turn NOT persisted', !Messages.exists('sync:cc:u3:u') && !Messages.exists('sync:cc:u3:a'), null);

  // ---------- Phase 4: live-elsewhere guard ----------
  // Write every registry file BEFORE the first read (the listing is cached 1s), so
  // all branches read one consistent snapshot.
  const sessDir = path.join(CLAUDE_HOME, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, `${process.pid}-A.json`), JSON.stringify({ pid: process.pid, sessionId: 'SESS-A', entrypoint: 'cli', kind: 'interactive' }));
  fs.writeFileSync(path.join(sessDir, `${process.pid}-B.json`), JSON.stringify({ pid: process.pid, sessionId: 'SESS-B', entrypoint: 'sdk-cli' }));
  fs.writeFileSync(path.join(sessDir, `dead-C.json`), JSON.stringify({ pid: 999999, sessionId: 'SESS-C', entrypoint: 'cli' }));
  check('guard: live interactive pid ⇒ elsewhere', !!liveElsewhere('claude-code', 'SESS-A', ''), null);
  check('guard: sdk-cli child not elsewhere', liveElsewhere('claude-code', 'SESS-B', '') === null, null);
  check('guard: dead pid ignored', liveElsewhere('claude-code', 'SESS-C', '') === null, null);

  const status = harnessSyncStatus();
  check('status: enabled + mirrored count', status.enabled === true && status.mirrored >= 1, status);

  console.log(sent.length ? `(captured ${sent.length} broadcasts)` : '(no broadcasts captured)');
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
