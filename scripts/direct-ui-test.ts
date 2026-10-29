/**
 * Renderer entry points vs direct workspaces: the store actions behind every PR /
 * branch button, the command palette and the create-pr shortcut refuse a direct
 * workspace before any IPC or "Committing…" progress toast, while worktree and
 * legacy in-place rows behave as before; the reuse / classification helpers and
 * the direct diff-scope switch. Runs the real store headless against a stubbed
 * IPC bridge.
 *
 *   npm run test:direct-ui
 */
import type { Project, Workspace } from '../src/shared/types';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
}

// ---- just enough browser for the store to load ----
const stub: any = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const mem = new Map<string, string>();
const calls: { channel: string; payload: any }[] = [];
const replies: Record<string, (p: any) => unknown> = {
  'github:prCreate': () => ({ ok: true, url: 'https://example.invalid/pr/1' }),
  'github:prMerge': () => ({ ok: true }),
  'workspace:continueBranch': () => ({ ok: true }),
  'workspace:conflictPreflight': () => ({ baseRef: 'origin/main', dirty: false, behind: 0, unpushed: 0, conflictFiles: [] }),
  'git:diff': (p) => ({ base: 'HEAD', scope: p.scope ?? 'uncommitted', files: [] }),
};
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
  document: stub,
  window: Object.assign(globalThis, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    maestro: {
      invoke: async (channel: string, payload: unknown) => {
        calls.push({ channel, payload });
        return replies[channel]?.(payload) ?? null;
      },
      on: () => () => {},
    },
  }),
});

const REPO = '/tmp/example/edge-monitor';
const project: Project = { id: 'p1', name: 'edge-monitor', repoPath: REPO, kind: 'git', hostId: null, cloudHostId: null, baseBranch: 'origin/main', createdAt: 1 };
const base: Omit<Workspace, 'id' | 'name' | 'wsKind' | 'worktreePath' | 'branch'> = {
  projectId: 'p1', hostId: null, title: null, subtitle: null, harness: 'shell', status: 'idle', port: 4100,
  archived: false, createdAt: 10, lastUserMessageAt: null, prNumber: 7, prUrl: null, prState: 'OPEN', setupError: null,
};
const direct: Workspace = { ...base, id: 'd1', name: 'zurich-v1', wsKind: 'in-place', worktreePath: REPO, branch: 'feature/x', directRepo: 'abc123' };
const directArchived: Workspace = { ...direct, id: 'd0', name: 'old', archived: true, createdAt: 5 };
const legacyRoot: Workspace = { ...base, id: 'l1', name: 'imported', wsKind: 'in-place', worktreePath: REPO, branch: 'feature/x', directRepo: null, createdAt: 1 };
const worktree: Workspace = { ...base, id: 'w1', name: 'leiden-v1', wsKind: 'worktree', worktreePath: '/tmp/example/wt/leiden-v1', branch: 'me/leiden-v1' };

async function main() {
  const { useApp } = await import('../src/renderer/store/app');
  const { isDirectIn, liveDirectWorkspace } = await import('../src/renderer/store/helpers');
  const toasts: { kind: string; msg: string }[] = [];
  useApp.setState({
    projects: [project],
    workspaces: [direct, directArchived, legacyRoot, worktree],
    toast: ((kind: string, msg: string) => void toasts.push({ kind, msg })) as any,
  });
  const reset = () => {
    calls.length = 0;
    toasts.length = 0;
  };
  const prChannels = ['github:prCreate', 'github:prMerge', 'workspace:continueBranch', 'workspace:conflictPreflight', 'chat:send'];
  const s = () => useApp.getState();

  // classification + reuse helpers (what the palette and the New-workspace modal use)
  check('isDirectIn: marked direct row', isDirectIn(s(), 'd1'));
  check('isDirectIn: legacy in-place row at the repo root is not direct', !isDirectIn(s(), 'l1'));
  check('isDirectIn: worktree row is not direct', !isDirectIn(s(), 'w1'));
  check('isDirectIn: unknown id', !isDirectIn(s(), 'nope') && !isDirectIn(s(), null));
  check('liveDirectWorkspace: the live direct row (archived/legacy skipped)', liveDirectWorkspace(s(), 'p1')?.id === 'd1');

  // every PR/branch store action — palette, shortcut, sidebar and panel buttons all land here
  const actions: [string, (id: string) => Promise<void>][] = [
    ['createPr', (id) => s().createPr(id)],
    ['squashMergePr', (id) => s().squashMergePr(id, 7)],
    ['startConflictResolution', (id) => s().startConflictResolution(id)],
    ['continueWorkspace', (id) => s().continueWorkspace(id)],
  ];
  for (const [name, run] of actions) {
    reset();
    await run('d1');
    check(`${name}: direct → no PR/branch IPC`, !calls.some((c) => prChannels.includes(c.channel)), calls);
    check(`${name}: direct → one explanatory info toast`, toasts.length === 1 && toasts[0].kind === 'info' && /directly in your project directory/.test(toasts[0].msg), toasts);
    check(`${name}: direct → no progress/success toast`, !toasts.some((t) => /Committing|created|Merged|success/i.test(t.msg) || t.kind === 'success'), toasts);
  }

  // the same actions still run for a worktree and a legacy in-place row
  reset();
  await s().createPr('w1');
  check('createPr: worktree → github:prCreate invoked', calls.some((c) => c.channel === 'github:prCreate'));
  check('createPr: worktree → progress toast as before', toasts.some((t) => /Committing changes/.test(t.msg)));
  reset();
  await s().createPr('l1');
  check('createPr: legacy in-place row keeps its old behavior', calls.some((c) => c.channel === 'github:prCreate'));
  reset();
  await s().continueWorkspace('w1');
  check('continueWorkspace: worktree → workspace:continueBranch invoked', calls.some((c) => c.channel === 'workspace:continueBranch'));
  reset();
  await s().squashMergePr('w1', 7);
  check('squashMergePr: worktree → github:prMerge invoked', calls.some((c) => c.channel === 'github:prMerge'));

  // diff scope (direct): the switch refetches with the scope; worktrees send none
  reset();
  s().setDiffScope('d1', 'staged');
  await new Promise((r) => setTimeout(r, 20));
  const diffCall = calls.find((c) => c.channel === 'git:diff');
  check('setDiffScope → git:diff carries the scope', diffCall?.payload?.scope === 'staged', calls);
  check('setDiffScope → diff stored for that scope', s().diffs['d1']?.scope === 'staged');
  reset();
  await s().refreshDiff('w1');
  check('worktree refreshDiff sends no scope (unchanged request)', calls.find((c) => c.channel === 'git:diff')?.payload?.scope === undefined);
}

main()
  .catch((e) => {
    failures++;
    console.error('FAIL (threw)', e);
  })
  .finally(() => {
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exit(failures ? 1 : 0);
  });
