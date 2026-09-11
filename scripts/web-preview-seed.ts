/**
 * Seed a persisted PGlite DB with realistic data for a local web preview
 * (dev-only; not shipped). Run under plain node against MAESTRO_WEB_PGLITE_DIR,
 * then boot `next dev` pointing at the same dir with MAESTRO_WEB_DEV_USER=dev.
 */
process.env.MAESTRO_WEB_PGLITE = '1';
process.env.NODE_ENV = 'development';

import { getDb } from '../web/lib/db';
import {
  users,
  devices,
  boxes,
  workspaces,
  workspaceDiffs,
  conversations,
  turns,
  userMessages,
  readState,
} from '../web/lib/db/schema';

const U = 'dev';
const ago = (m: number) => new Date(Date.now() - m * 60_000);

async function main() {
  const db = await getDb();
  await db.insert(users).values({ id: U, githubId: 'dev', login: 'octocat', name: 'Octo Cat', avatarUrl: 'https://avatars.githubusercontent.com/octocat?s=64' }).onConflictDoNothing();
  await db.insert(devices).values({ id: 'd1', userId: U, kind: 'desktop', name: 'MacBook Pro', platform: 'darwin', tokenHash: 'seed-d1', lastSeenAt: new Date() }).onConflictDoNothing();
  await db.insert(boxes).values({ id: 'box1', userId: U, label: 'hayabusa', tokenHash: 'seed-box1', lastSeenAt: new Date() }).onConflictDoNothing();

  await db.insert(workspaces).values([
    {
      id: 'wsA', userId: U, deviceId: 'd1', projectId: 'p1', projectName: 'visual-conductor', projectKind: 'git', repoOwner: 'octocat',
      name: 'warsaw-v1', title: 'Add dark mode toggle', subtitle: 'Waiting on you', branch: 'feat/dark-mode', baseBranch: 'main', wsKind: 'worktree',
      isCloud: false, harness: 'claude-code', status: 'needs-attention', archived: false, port: 4173,
      prNumber: 128, prUrl: 'https://github.com/octocat/visual-conductor/pull/128', prState: 'OPEN', prTitle: 'Add dark mode toggle', prDraft: false,
      prChecks: 'pass', prMergeable: 'clean', prReview: 'APPROVED',
      prChecksList: [{ name: 'build', state: 'pass', url: null }, { name: 'test', state: 'pass', url: null }, { name: 'lint', state: 'pending', url: null }],
      diffAdd: 42, diffDel: 8, changedFiles: 3,
      git: { ahead: 2, behind: 0, staged: 1, unstaged: 2, untracked: 0, dirty: true, files: [{ path: 'src/Settings.tsx', status: 'M', add: 30, del: 6 }, { path: 'src/theme.ts', status: 'A', add: 12, del: 0 }, { path: 'src/old.css', status: 'D', add: 0, del: 2 }] },
      statusDigest: { scope: 'session', workingOn: 'Wiring the theme toggle into the settings panel', lastActivity: 'Edited Settings.tsx and added theme.ts', goal: 'Ship a persistent light/dark toggle', nextUp: ['Add a system-preference option', 'Write a test for persistence'], generatedAt: Date.now() - 300_000, model: 'claude-sonnet-5', stale: false },
      runScripts: [{ id: 'r1', name: 'Dev server', kind: 'run', command: 'npm run dev', state: 'ok' }, { id: 'r2', name: 'Unit tests', kind: 'test', command: 'npm test', state: 'exit', exitCode: 1 }],
      todos: [{ id: 't1', text: 'Persist theme to localStorage', done: true }, { id: 't2', text: 'Add system-preference option', done: false }],
      comments: [],
      updatedAt: ago(3), lastUserMessageAt: ago(6),
    },
    {
      id: 'wsB', userId: U, deviceId: 'd1', projectId: 'p1', projectName: 'visual-conductor', projectKind: 'git', repoOwner: 'octocat',
      name: 'auth', title: 'Refactor auth service', subtitle: 'Working…', branch: 'feat/auth', baseBranch: 'main', wsKind: 'worktree',
      isCloud: true, boxId: 'box1', hostLabel: 'hayabusa', harness: 'codex', status: 'running', archived: false, port: 4174,
      prNumber: null, prUrl: null, prState: null, prChecks: null, prMergeable: null, prReview: null, prChecksList: null,
      diffAdd: 15, diffDel: 30, changedFiles: 2, git: { ahead: 1, behind: 0, staged: 0, unstaged: 2, untracked: 0, dirty: true, files: [] },
      liveActivity: 'Tool · auth.ts', todos: [], comments: [], updatedAt: ago(1), lastUserMessageAt: ago(2),
    },
    {
      id: 'wsC', userId: U, deviceId: 'd1', projectId: 'p1', projectName: 'visual-conductor', projectKind: 'git', repoOwner: 'octocat',
      name: 'old-thing', title: 'Bump dependencies', branch: 'chore/deps', baseBranch: 'main', wsKind: 'worktree',
      isCloud: false, harness: 'claude-code', status: 'archived', archived: true, diffAdd: 0, diffDel: 0, changedFiles: 0, git: null, updatedAt: ago(4000),
    },
  ]).onConflictDoNothing();

  await db.insert(conversations).values([
    { id: 'wsA:1', userId: U, workspaceId: 'wsA', agentId: 1, title: 'Add dark mode toggle', harness: 'claude-code', state: 'needs-attention', hasRun: true, model: 'claude-sonnet-5', effort: 'high', planMode: false, running: false, attention: true, lastAgentAt: ago(3), closed: false, titleCustom: false },
    { id: 'wsA:2', userId: U, workspaceId: 'wsA', agentId: 2, title: 'Fix flaky test', harness: 'claude-code', hasRun: true, model: 'claude-opus-5', effort: 'medium', running: false, attention: false, lastAgentAt: ago(60), closed: false },
    { id: 'wsB:1', userId: U, workspaceId: 'wsB', agentId: 1, title: 'Refactor auth service', harness: 'codex', boxId: 'box1', hasRun: true, model: 'gpt-5.6-sol', effort: 'high', running: true, attention: false, lastAgentAt: ago(1), closed: false },
  ]).onConflictDoNothing();

  const blocksDone = [
    { type: 'text', text: "I'll add a dark mode toggle to the settings panel and persist the choice." },
    { type: 'tool', id: 'x1', name: 'Read', input: { file_path: 'src/Settings.tsx' }, result: { ok: true, summary: 'read 120 lines' } },
    { type: 'tool', id: 'x2', name: 'Edit', input: { file_path: 'src/theme.ts', old_string: "export const theme = 'light';", new_string: "export type Theme = 'light' | 'dark';\nexport const theme: Theme = 'light';" }, result: { ok: true, summary: 'updated' } },
    { type: 'text', text: 'Done — the toggle switches themes and persists to `localStorage`.\n\n```ts\nlocalStorage.setItem("theme", next);\n```\n\n- Added `theme.ts`\n- Wired the toggle in **Settings**' },
  ];
  await db.insert(turns).values([
    { id: 'wsA1-turn1', conversationId: 'wsA:1', status: 'done', blocks: blocksDone as any, meta: { costUsd: 0.04, durationMs: 42000 }, startedAt: ago(6), endedAt: ago(5) },
  ]).onConflictDoNothing();
  await db.insert(userMessages).values([
    { id: 'wsA1-m1', conversationId: 'wsA:1', text: 'Add a dark mode toggle to settings and persist it.', origin: 'desktop', turnId: 'wsA1-turn1', queued: false, createdAt: ago(6) },
    { id: 'wsA1-m2', conversationId: 'wsA:1', text: 'Also add a "system" option that follows the OS.', origin: 'web', turnId: null, queued: false, createdAt: ago(3) },
  ]).onConflictDoNothing();

  await db.insert(workspaceDiffs).values({
    workspaceId: 'wsA', base: 'main', producedBy: 'desktop', producedAt: new Date(),
    files: [
      { path: 'src/theme.ts', oldPath: null, status: 'added', additions: 12, deletions: 0, hunks: [{ header: '@@ -0,0 +1,3 @@', lines: [{ kind: 'add', oldLine: null, newLine: 1, text: "export type Theme = 'light' | 'dark';" }, { kind: 'add', oldLine: null, newLine: 2, text: "export const theme: Theme = 'light';" }, { kind: 'add', oldLine: null, newLine: 3, text: 'export const toggle = (t: Theme): Theme => (t === "light" ? "dark" : "light");' }] }] },
      { path: 'src/Settings.tsx', oldPath: null, status: 'modified', additions: 3, deletions: 1, hunks: [{ header: '@@ -10,4 +10,6 @@', lines: [{ kind: 'context', oldLine: 10, newLine: 10, text: 'function Settings() {' }, { kind: 'del', oldLine: 11, newLine: null, text: '  const theme = "light";' }, { kind: 'add', oldLine: null, newLine: 11, text: '  const [theme, setTheme] = useState<Theme>(load());' }, { kind: 'add', oldLine: null, newLine: 12, text: '  const flip = () => setTheme(toggle(theme));' }, { kind: 'context', oldLine: 12, newLine: 13, text: '  return <Panel>' }] }] },
    ] as any,
  }).onConflictDoNothing();

  // wsA:2 unread (green), wsA:1 read up to its turn but attention drives waiting.
  await db.insert(readState).values([
    { userId: U, conversationId: 'wsA:1', lastReadAt: ago(2), updatedAt: ago(2) },
    { userId: U, conversationId: 'wsA:2', lastReadAt: ago(120), updatedAt: ago(120) },
  ]).onConflictDoNothing();

  console.log('seeded preview DB');
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
