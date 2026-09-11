/**
 * Demo seeder for the landing-page screenshot. Builds a real git repo + a
 * populated SQLite DB so a normal `--smoke --screenshot` run of the real app
 * captures a rich, on-brand window — a small fleet of parallel workspaces
 * with mixed statuses and a worked chat on the open one.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron dist/seed-shot.cjs
 *
 * SHOT_THEME=dark seeds the dark theme (the landing page ships a light and a
 * dark capture, swapped via prefers-color-scheme); default is light.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { resolveShellEnv } from '../src/main/env';
import { initDb, Messages, Comments, StatusReports, Todos, Workspaces, Settings, uid, now } from '../src/main/db';
import { addProject, createWorkspace, renameWorkspaceBranch } from '../src/main/services/workspaces';
import { writeRepoSettings } from '../src/main/services/settingsToml';

const ROOT = '/tmp/maestro-shot';
const REPO = path.join(ROOT, 'maestro');

function sh(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

async function waitIdle(id: string, ms = 60_000) {
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

  // 1. a real repo with a little structure so diffs read naturally
  sh('git init -b main', REPO);
  sh('git config user.email demo@maestro.app && git config user.name Maestro', REPO);
  fs.writeFileSync(path.join(REPO, 'README.md'), '# maestro\n\nRun coding agents in parallel.\n');
  fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(REPO, 'src/workspace.ts'),
    `import { Session } from './session';\n\nexport interface Workspace {\n  id: string;\n  branch: string;\n  sessions: Session[];\n}\n\nexport function activeSession(ws: Workspace): Session | undefined {\n  return ws.sessions[0];\n}\n`
  );
  fs.writeFileSync(
    path.join(REPO, 'src/session.ts'),
    `export interface Session {\n  id: number;\n  title: string;\n}\n`
  );
  fs.writeFileSync(
    path.join(REPO, 'src/server.ts'),
    `import http from 'http';\n\nconst port = Number(process.env.WORKSPACE_PORT ?? 3000);\n\nhttp\n  .createServer((_req, res) => res.end('ok'))\n  .listen(port, () => console.log('listening on ' + port));\n`
  );
  sh('git add -A && git commit -m "Initial commit"', REPO);

  // 2. DB + theme + project. autoStatus off so the canned Status digest below
  // renders as-is instead of kicking off a live LLM summarization mid-shot.
  const theme = process.env.SHOT_THEME === 'dark' ? 'dark' : 'light';
  initDb(path.join(ROOT, 'maestro.db'));
  Settings.setGlobal({ theme, onboarded: true, autoStatus: false } as any);
  const project = await addProject({ mode: 'local', path: REPO });
  writeRepoSettings(REPO, { setupScript: '', runScript: 'npm run dev', instructions: '' });

  async function mk(branch: string, title: string, harness = 'claude-code') {
    const ws = await createWorkspace({ projectId: project.id, harness: harness as any });
    await waitIdle(ws.id);
    try {
      await renameWorkspaceBranch(ws.id, branch);
    } catch {
      /* keep the auto branch if rename races */
    }
    const w = Workspaces.get(ws.id)!;
    w.title = title;
    Workspaces.update(w);
    return Workspaces.get(ws.id)!;
  }

  // 3. ws1 — the open workspace (a finished, reviewable turn)
  const w1 = await mk('feat/split-view', 'Add a split-view toggle');
  fs.writeFileSync(
    path.join(w1.worktreePath, 'src/split.ts'),
    `import { Session } from './session';\n\nexport type Dir = 'row' | 'col';\n\nexport interface Pane {\n  session: Session;\n  size: number;\n}\n\n/** A split node: two or more panes tiled along one axis. */\nexport interface Split {\n  dir: Dir;\n  panes: Pane[];\n}\n\nexport function splitBeside(split: Split, session: Session): Split {\n  const size = 1 / (split.panes.length + 1);\n  return {\n    dir: split.dir,\n    panes: [...split.panes.map((p) => ({ ...p, size })), { session, size }],\n  };\n}\n\nexport function focusedPane(split: Split): Pane {\n  return split.panes[0];\n}\n`
  );
  fs.writeFileSync(
    path.join(w1.worktreePath, 'src/workspace.ts'),
    `import { Session } from './session';\nimport { Split, splitBeside } from './split';\n\nexport interface Workspace {\n  id: string;\n  branch: string;\n  sessions: Session[];\n  split?: Split;\n}\n\nexport function activeSession(ws: Workspace): Session | undefined {\n  return ws.sessions[0];\n}\n\nexport function toggleSplitView(ws: Workspace, session: Session): Workspace {\n  const base: Split = ws.split ?? { dir: 'row', panes: [{ session: ws.sessions[0], size: 1 }] };\n  return { ...ws, split: splitBeside(base, session) };\n}\n`
  );

  const user = (text: string, ts: number) =>
    Messages.insert({ id: uid(), workspaceId: w1.id, agentId: 1, role: 'user', content: text, attachments: [], ts });
  const agent = (blocks: unknown[], ts: number, durationMs: number) =>
    Messages.insert({
      id: uid(), workspaceId: w1.id, agentId: 1, role: 'agent',
      content: JSON.stringify(blocks), attachments: [], ts, meta: { durationMs },
    } as any);

  // A worked, multi-turn conversation. Every turn's final answer stays visible;
  // each turn's activity folds to a chip above its answer — exactly how the app
  // reads a thread back.
  user(
    'Add a split-view toggle to the workspace header so two chats can sit side by side on the same branch — dragging a session from the rail should dock it beside the current one.',
    now() - 22 * 60_000
  );
  agent(
    [
      { type: 'text', text: "I'll add a pane-layout tree and wire drag-and-drop from the session rail." },
      { type: 'tool', id: 'r1', name: 'Read', input: { file_path: 'src/workspace.ts' }, result: { ok: true, summary: 'read 12 lines' } },
      { type: 'tool', id: 'w1', name: 'Write', input: { file_path: 'src/split.ts' }, result: { ok: true, summary: 'created SplitView' } },
      { type: 'tool', id: 'e1', name: 'Edit', input: { file_path: 'src/workspace.ts' }, result: { ok: true, summary: 'added toggleSplitView' } },
      { type: 'tool', id: 'b1', name: 'Bash', input: { command: 'npm run typecheck' }, result: { ok: true, summary: '0 errors' } },
      { type: 'text', text: 'Added a split-view toggle to the header. Sessions dragged from the rail now dock beside the current chat, and each pane keeps its own composer and scroll position. `npm run typecheck` passes.' },
    ],
    now() - 19 * 60_000,
    142_000
  );
  user('Nice. Make the divider draggable so panes can be resized, and persist the ratio per workspace.', now() - 12 * 60_000);
  agent(
    [
      { type: 'text', text: 'Making the divider draggable and persisting the split ratio.' },
      { type: 'tool', id: 'e2', name: 'Edit', input: { file_path: 'src/split.ts' }, result: { ok: true, summary: 'resizable divider' } },
      { type: 'tool', id: 'e3', name: 'Edit', input: { file_path: 'src/store.ts' }, result: { ok: true, summary: 'persist ratio' } },
      { type: 'tool', id: 'b2', name: 'Bash', input: { command: 'npm test -- split' }, result: { ok: true, summary: '6 passed' } },
      { type: 'text', text: 'The divider is draggable now — drag it to reallocate space between panes, and the ratio is saved per workspace so it survives reloads. Added six tests; all green.' },
    ],
    now() - 11 * 60_000,
    96_000
  );
  user('One more: dropping a session on the left / right / top / bottom edge of a pane should split in that direction.', now() - 4 * 60_000);
  agent(
    [
      { type: 'text', text: 'Adding four-way edge drops with a live preview overlay.' },
      { type: 'tool', id: 'r2', name: 'Read', input: { file_path: 'src/split.ts' }, result: { ok: true, summary: 'read 41 lines' } },
      { type: 'tool', id: 'e4', name: 'Edit', input: { file_path: 'src/ChatPanel.tsx' }, result: { ok: true, summary: 'drop zones + overlay' } },
      { type: 'tool', id: 'e5', name: 'Edit', input: { file_path: 'src/split.ts' }, result: { ok: true, summary: 'splitAtEdge()' } },
      { type: 'tool', id: 'b3', name: 'Bash', input: { command: 'npm run typecheck' }, result: { ok: true, summary: '0 errors' } },
      { type: 'text', text: 'Dragging a session now previews the target half of whichever pane you hover, and releasing splits along that edge — left/right tile in a row, top/bottom in a column, nested arbitrarily. Everything typechecks and the split-view smoke test passes.' },
    ],
    now() - 3 * 60_000,
    121_000
  );
  Workspaces.patchChat(w1.id, 1, { title: 'Add a split-view toggle', lastAgentAt: now() - 3 * 60_000, lastReadAt: now() } as any);

  Comments.insert({
    id: uid(), workspaceId: w1.id, file: 'src/split.ts', line: 18, side: 'new',
    body: 'Persist the split ratio per workspace?', resolved: false, createdAt: now(),
  } as any);
  Todos.insert({ id: uid(), workspaceId: w1.id, text: 'Add pane-layout tree', done: true, createdAt: now() } as any);
  Todos.insert({ id: uid(), workspaceId: w1.id, text: 'Drag & drop from the session rail', done: true, createdAt: now() } as any);
  Todos.insert({ id: uid(), workspaceId: w1.id, text: 'Persist split per workspace', done: false, createdAt: now() } as any);

  // 4. ws2 — complete · unread (green)
  const w2 = await mk('feat/api-pagination', 'Add API pagination');
  fs.appendFileSync(path.join(w2.worktreePath, 'src/server.ts'), `\nexport const PAGE_SIZE = 25;\n`);
  Messages.insert({
    id: uid(), workspaceId: w2.id, agentId: 1, role: 'agent',
    content: JSON.stringify([{ type: 'text', text: 'Added cursor-based pagination to the list endpoint.' }]),
    attachments: [], ts: now() - 9_000,
  });
  Workspaces.patchChat(w2.id, 1, { title: 'Add API pagination', lastAgentAt: now() - 9_000, lastReadAt: now() - 900_000 } as any);

  // 5. ws3 — waiting on you (amber)
  const w3 = await mk('fix/dictation-refine', 'Refine prompt on send');
  fs.appendFileSync(path.join(w3.worktreePath, 'src/server.ts'), `\n// refine the prompt before sending\n`);
  Workspaces.patchChat(w3.id, 1, { title: 'Refine prompt on send', attention: true, lastAgentAt: now() - 6_000, lastReadAt: now() - 6_000 } as any);

  // 6. ws4 — merged (purple)
  const w4 = await mk('chore/bump-electron', 'Bump Electron to 43', 'shell');
  const w4f = Workspaces.get(w4.id)!;
  w4f.prNumber = 128;
  w4f.prState = 'MERGED';
  w4f.prUrl = 'https://github.com/maestro/maestro/pull/128';
  Workspaces.update(w4f);
  Workspaces.patchChat(w4.id, 1, { title: 'Bump Electron to 43' } as any);

  // 7. Canned Status digest for the open workspace, so the right panel reads
  // as a worked branch brief instead of an empty "Summarizing with AI…" card.
  // The fingerprint must match what services/status.ts computes from this DB
  // state (PROMPT_VERSION:msgCount:lastTs:branch:subtitle:prNumber) or the
  // panel renders an "out of date" warn chip; recompute from final state here.
  const w1f = Workspaces.get(w1.id)!;
  const w1msgs = Messages.list(w1.id);
  const fp = `v2:${w1msgs.length}:${w1msgs[w1msgs.length - 1]?.ts ?? 0}:${w1f.branch ?? ''}:${w1f.subtitle ?? ''}:${w1f.prNumber ?? ''}`;
  StatusReports.set(
    `workspace:${w1.id}`,
    {
      scope: 'workspace',
      headline: 'Split-view: 4-way edge-drop splitting',
      working:
        '- Edge-drop splits (left/right/top/bottom) with live preview overlay\n- Nested row/column tiling via drag-drop',
      lastActivity:
        '- Implemented preview overlay + edge-split logic, smoke test passes\n- Files dirty, uncommitted: workspace.ts, split.ts',
      goal: 'Ship four-way edge-drop pane splitting',
      next: ['Commit changes', 'Open PR', 'Manual QA nested splits', 'More edge cases?'],
      generatedAt: now() - 2 * 60_000,
      model: 'claude-sonnet-5',
    },
    fp
  );

  console.log('SEED_OK db=' + path.join(ROOT, 'maestro.db'));
  process.exit(0);
}

main().catch((e) => {
  console.error('SEED_CRASH', e);
  process.exit(1);
});
