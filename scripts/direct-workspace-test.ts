/**
 * Direct workspaces ("Create from → Existing working directory (no worktree)")
 * against throwaway repos and an isolated Maestro home/DB: no worktree / branch is
 * ever created, the checkout's branch and staged / unstaged / untracked files
 * survive every lifecycle op, agents and terminals run in the repo itself, one
 * workspace is reused per repo (its chats are the parallel sessions), the
 * explicit marker survives restarts while legacy rows keep their classification,
 * the HEAD-relative diff splits staged / unstaged / untracked / branch commits,
 * reads never take the index lock, `.git/info/exclude` is only appended to when
 * needed, restore refuses a replaced repo, branch/PR mutations are refused
 * (desktop and Maestro Web executors) — and worktree workspaces behave as before.
 *
 *   npm run test:direct   (runs under ELECTRON_RUN_AS_NODE, like scripts/e2e.ts, so
 *                          native modules built by `npm run rebuild` load)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { resolveShellEnv } from '../src/main/env';
import { initDb, Messages, Projects, Workspaces } from '../src/main/db';
import * as git from '../src/main/services/git';
import * as changes from '../src/main/services/changes';
import {
  addProject,
  archiveWorkspace,
  continueOnNewBranch,
  createWorkspace,
  deleteWorkspace,
  recreateAdoptedFromBranch,
  removeProject,
  renameWorkspaceBranch,
  restoreWorkspace,
  sweepArchivedWorkspaces,
  switchBranch,
} from '../src/main/services/workspaces';
import { createPr, mergePr } from '../src/main/services/pr';
import { execContinueBranch, execPrCreate, execPrMerge, execResolveConflicts } from '../src/main/services/webexec';
import { sendChat } from '../src/main/services/chat';
import { ensurePty, getPtyBuffer, killAllPtys, writePty } from '../src/main/services/pty';
import { stopAllAgents } from '../src/main/services/harness';
import { unwatchWorkspace } from '../src/main/services/watcher';
import { isDirectWorkspace, type Project, type Workspace } from '../src/shared/types';

// Realpath'd so paths match git's symlink-resolved output (macOS /var → /private/var).
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'maestro-direct-'));
const REPO = path.join(ROOT, 'edge-monitor');
const DB = path.join(ROOT, 'maestro.db');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
}
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (pred()) return true;
  return pred();
}
async function rejects(fn: () => Promise<unknown>, match?: RegExp): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return !match || match.test(String((e as Error)?.message ?? e));
  }
}
const provisioned = (id: string) => waitFor(() => Workspaces.get(id)?.status !== 'setting-up', 60_000);
const direct = (projectId: string, extra: Partial<Parameters<typeof createWorkspace>[0]> = {}) =>
  createWorkspace({ projectId, harness: 'shell', from: { type: 'direct' }, ...extra });
const unwatchAll = () => Workspaces.list().forEach((w) => unwatchWorkspace(w.id));

/** Everything a direct workspace must leave alone. */
function snapshot(repo: string) {
  return {
    head: sh('git rev-parse HEAD', repo).trim(),
    branch: sh('git branch --show-current', repo).trim(),
    branches: sh('git for-each-ref --format="%(refname)" refs/heads', repo).trim(),
    worktrees: sh('git worktree list --porcelain', repo).trim(),
    status: sh('git status --porcelain=v1 -uall', repo).trim(),
    staged: sh('git diff --cached', repo),
    unstaged: sh('git diff', repo),
    stash: sh('git stash list', repo).trim(),
    untracked: fs.readFileSync(path.join(repo, 'notes/untracked.txt'), 'utf8'),
  };
}
function sameAs(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>, label: string) {
  const diffs = (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k]);
  check(`${label}: user's checkout untouched`, diffs.length === 0, diffs.map((k) => ({ [k]: { before: a[k], after: b[k] } })));
}

function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  sh('git init -q -b main', dir);
  sh('git config user.email test@maestro.local && git config user.name Maestro-Test', dir);
}
function commitFile(dir: string, file: string, text: string, msg: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  sh(`git add ${JSON.stringify(file)} && git commit -qm ${JSON.stringify(msg)}`, dir);
}

/** The main fixture: origin + a pushed feature branch one commit ahead of its
 *  upstream, with staged, unstaged, partly-staged and untracked work. */
function makeMainRepo() {
  const origin = path.join(ROOT, 'origin.git');
  sh(`git init -q --bare -b main ${JSON.stringify(origin)}`, ROOT);
  initRepo(REPO);
  commitFile(REPO, 'README.md', '# edge-monitor\n', 'init');
  fs.writeFileSync(path.join(REPO, 'src-app.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(REPO, 'src-lib.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(REPO, 'both.ts'), 'export const d = 4;\n');
  fs.writeFileSync(path.join(REPO, 'committed.ts'), 'export const e = 5;\n');
  sh('git add -A && git commit -qm files', REPO);
  sh(`git remote add origin ${JSON.stringify(origin)} && git push -q -u origin main && git remote set-head origin main`, REPO);
  sh('git checkout -qb feature/local-work && git push -q -u origin feature/local-work', REPO);
  // committed on the branch, not yet pushed → "branch" scope, ahead 1
  fs.appendFileSync(path.join(REPO, 'committed.ts'), 'export const f = 6; // branch commit\n');
  sh('git commit -qam "branch commit"', REPO);
  // staged only / unstaged only / both / staged new file / untracked
  fs.writeFileSync(path.join(REPO, 'src-app.ts'), 'export const a = 42; // staged\n');
  sh('git add src-app.ts', REPO);
  fs.appendFileSync(path.join(REPO, 'src-lib.ts'), 'export const c = 3; // unstaged\n');
  fs.appendFileSync(path.join(REPO, 'both.ts'), 'export const g = 7; // staged part\n');
  sh('git add both.ts', REPO);
  fs.appendFileSync(path.join(REPO, 'both.ts'), 'export const h = 8; // unstaged part\n');
  fs.writeFileSync(path.join(REPO, 'added.ts'), 'export const i = 9; // staged new file\n');
  sh('git add added.ts', REPO);
  fs.mkdirSync(path.join(REPO, 'notes'));
  fs.writeFileSync(path.join(REPO, 'notes/untracked.txt'), 'scratch\n');
}

/** Make the index stat-stale so any command that may refresh it would rewrite it. */
function staleIndex(repo: string, files: string[]) {
  const later = new Date(Date.now() + 5_000);
  for (const f of files) fs.utimesSync(path.join(repo, f), later, later);
}
const indexStamp = (repo: string) => {
  const st = fs.statSync(path.join(repo, '.git', 'index'));
  return `${st.ino}:${st.mtimeMs}`;
};

async function main() {
  resolveShellEnv();
  process.env.MAESTRO_HOME = path.join(ROOT, 'home');
  makeMainRepo();
  initDb(DB);

  const project = await addProject({ mode: 'local', path: REPO });
  check('git project added (worktree model is still the default)', project.kind === 'git' && project.repoPath === REPO);
  const before = snapshot(REPO);
  const rootCommit = sh('git rev-list --max-parents=0 HEAD', REPO).trim();

  // ---------- create ----------
  const a0 = await direct(project.id);
  await provisioned(a0.id);
  const a = Workspaces.get(a0.id)!;
  check('direct ws is idle', a.status === 'idle', { status: a.status, err: a.setupError });
  check('direct ws is in-place at the repo itself', a.wsKind === 'in-place' && a.worktreePath === REPO, a);
  check('direct ws carries the explicit marker (= root commit)', a.directRepo === rootCommit, a.directRepo);
  check('direct ws is identified as direct', isDirectWorkspace(a, project));
  check('direct ws records the current branch', a.branch === 'feature/local-work', a.branch);
  check('no worktree under MAESTRO_HOME/workspaces', !fs.existsSync(path.join(process.env.MAESTRO_HOME!, 'workspaces')));
  sameAs(before, snapshot(REPO), 'after create');

  // ---------- M1: classification of other in-place rows ----------
  // Harness chat sync imports a CLI session run in the main checkout exactly like this.
  const imported0 = await createWorkspace({ projectId: project.id, harness: 'shell', adopt: { path: REPO, branch: 'feature/local-work' } });
  await provisioned(imported0.id);
  const imported = Workspaces.get(imported0.id)!;
  check('imported in-place row at the repo root is NOT direct', imported.wsKind === 'in-place' && imported.worktreePath === REPO && !isDirectWorkspace(imported, project) && imported.directRepo == null);
  const folderDir = path.join(ROOT, 'plain-folder');
  fs.mkdirSync(folderDir);
  const folderProject = await addProject({ mode: 'folder', path: folderDir, harness: 'shell' });
  const folderWs = Workspaces.forProject(folderProject.id)[0];
  await provisioned(folderWs.id);
  check('plain-folder in-place row is NOT direct', folderWs.wsKind === 'in-place' && !isDirectWorkspace(Workspaces.get(folderWs.id)!, folderProject));
  check('direct from a folder project is refused', await rejects(() => direct(folderProject.id), /only available for local git/));
  unwatchWorkspace(imported.id);
  Workspaces.remove(imported.id); // bookkeeping only; keeps the rest of the run about the direct row

  // ---------- L5: one live direct workspace per repo; chats are the sessions ----------
  const again = await direct(project.id);
  check('a second direct create reuses the live workspace', again.id === a.id);
  check('…and makes no new row', Workspaces.forProject(project.id).filter((w) => isDirectWorkspace(w, project)).length === 1);
  const withTask = await direct(project.id, { initialPrompt: 'pwd -P > .context/cwd-reuse.txt' });
  const reuseFile = path.join(REPO, '.context', 'cwd-reuse.txt');
  check('reuse with a task → same workspace', withTask.id === a.id);
  check('…task ran in the repo, in a new chat', await waitFor(() => fs.existsSync(reuseFile), 30_000));
  const reuseMsg = Messages.list(a.id).find((m) => m.role === 'user' && m.content.includes('cwd-reuse'));
  check('…on a fresh agent id (chat 1 untouched)', !!reuseMsg && reuseMsg.agentId > 1, reuseMsg?.agentId);
  const [c1, c2] = await Promise.all([direct(project.id), direct(project.id)]);
  check('concurrent creates converge on one workspace', c1.id === a.id && c2.id === a.id);

  // ---------- agents + terminal in the repo; several chats share it ----------
  for (const agentId of [1, 2, 3]) {
    const r = await sendChat({ workspaceId: a.id, agentId, text: `pwd -P > .context/cwd-${agentId}.txt`, attachments: [] });
    check(`chat ${agentId} accepted`, r.ok, r.error);
  }
  for (const agentId of [1, 2, 3]) {
    const f = path.join(REPO, '.context', `cwd-${agentId}.txt`);
    const ok = await waitFor(() => fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim().length > 0, 30_000);
    check(`chat ${agentId} ran in the repo directory`, ok && fs.readFileSync(f, 'utf8').trim() === REPO);
  }
  await waitFor(() => Workspaces.get(a.id)?.status !== 'running', 30_000);
  const ptyId = `term:${a.id}:1`;
  ensurePty(ptyId, { cwd: Workspaces.get(a.id)!.worktreePath, cols: 120, rows: 30 });
  writePty(ptyId, `printf 'PWD=%s\\n' "$(pwd -P)"\n`);
  check('terminal opens in the repo directory', await waitFor(() => getPtyBuffer(ptyId).buffer.includes(`PWD=${REPO}`), 15_000));
  killAllPtys();
  sameAs(before, snapshot(REPO), 'after agents + terminal');

  // ---------- M2: status + diff in the user's checkout ----------
  const ws = Workspaces.get(a.id)!;
  const st = await changes.workspaceStatus(ws, project);
  check('status: upstream is the branch\'s own', st.upstream === 'origin/feature/local-work', st);
  check('status: ahead 1 / behind 0 vs upstream', st.ahead === 1 && st.behind === 0, st);
  check('status: staged/unstaged/untracked counts', st.staged === 3 && st.unstaged === 2 && st.untracked === 1, st);
  const byPath = (d: { files: { path: string }[] }) => Object.fromEntries(d.files.map((f) => [f.path, f])) as Record<string, any>;
  const unc = byPath(await changes.workspaceDiff(ws, project));
  check('uncommitted: staged-only file tagged staged', unc['src-app.ts']?.stage === 'staged', unc['src-app.ts']);
  check('uncommitted: unstaged-only file tagged unstaged', unc['src-lib.ts']?.stage === 'unstaged');
  check('uncommitted: partly staged file tagged both', unc['both.ts']?.stage === 'both' && unc['both.ts'].additions === 2);
  check('uncommitted: staged new file', unc['added.ts']?.stage === 'staged' && unc['added.ts'].status === 'added');
  check('uncommitted: untracked listed as untracked', unc['notes/untracked.txt']?.status === 'untracked');
  check('uncommitted: branch commit NOT included', !unc['committed.ts']);
  check('uncommitted: .context/ never shown', !Object.keys(unc).some((p) => p.startsWith('.context')));
  const stg = byPath(await changes.workspaceDiff(ws, project, 'staged'));
  check('staged scope: exactly the staged files', Object.keys(stg).sort().join() === 'added.ts,both.ts,src-app.ts', Object.keys(stg));
  check('staged scope: partly staged file shows only its staged line', stg['both.ts']?.additions === 1);
  const uns = byPath(await changes.workspaceDiff(ws, project, 'unstaged'));
  check('unstaged scope: unstaged files + untracked', Object.keys(uns).sort().join() === 'both.ts,notes/untracked.txt,src-lib.ts', Object.keys(uns));
  const br = await changes.workspaceDiff(ws, project, 'branch');
  check('branch scope: only the unpushed commit, vs upstream', br.base === 'origin/feature/local-work' && br.files.map((f) => f.path).join() === 'committed.ts', br);
  const stat = await changes.workspaceDiffStat(ws, project);
  check('diffstat: uncommitted (+5 tracked +1 untracked) vs HEAD', stat.additions === 6, stat);
  sameAs(before, snapshot(REPO), 'after status/diff reads');

  // ---------- L2: reads never take the index lock ----------
  staleIndex(REPO, ['src-lib.ts', 'README.md']);
  const stamp = indexStamp(REPO);
  await changes.workspaceStatus(ws, project);
  for (const scope of ['uncommitted', 'staged', 'unstaged', 'branch'] as const) await changes.workspaceDiff(ws, project, scope);
  await changes.workspaceDiffStat(ws, project);
  await git.changedFilePaths(REPO, project.baseBranch!);
  await git.statusSummary(REPO, project.baseBranch!);
  check('status/diff/diffstat/changedFilePaths leave .git/index alone', indexStamp(REPO) === stamp);
  sh('git status --porcelain', REPO); // control: plain status refreshes the stale index
  check('control: plain `git status` does rewrite the stale index (probe is sensitive)', indexStamp(REPO) !== stamp);
  const paths = await git.changedFilePaths(REPO, project.baseBranch!);
  check('changedFilePaths still correct with --no-optional-locks', ['src-app.ts', 'notes/untracked.txt', 'committed.ts'].every((p) => paths.includes(p)), paths);

  // ---------- branch / PR lifecycle refused: desktop services ----------
  check('switchBranch refused', await rejects(() => switchBranch(a.id, 'main', false)));
  check('new-branch-from-here refused', await rejects(() => switchBranch(a.id, 'scratch', true)));
  check('renameBranch refused', await rejects(() => renameWorkspaceBranch(a.id, 'renamed')));
  check('continueOnNewBranch refused', (await continueOnNewBranch(a.id)).ok === false);
  check('createPr refused', (await createPr(a.id, false)).ok === false);
  check('mergePr refused', (await mergePr(a.id, 'squash')).ok === false);
  check('recreateFromBranch refused', (await recreateAdoptedFromBranch(a.id)).ok === false);
  // ---------- L4: Maestro Web executors report the refusal ----------
  const webContinue = await execContinueBranch(a.id);
  check('web continue_branch → ok:false with the reason', webContinue.ok === false && /directly in your project directory/.test(webContinue.error ?? ''), webContinue);
  const webPr = await execPrCreate(a.id);
  check('web pr_create → ok:false', webPr.ok === false && !!webPr.error, webPr);
  const webMerge = await execPrMerge(a.id);
  check('web pr_merge → ok:false', webMerge.ok === false && !!webMerge.error, webMerge);
  const webResolve = await execResolveConflicts(a.id);
  check('web resolve_conflicts → ok:false, no chat sent', webResolve.ok === false && !Messages.list(a.id).some((m) => /Merge .* into this branch/.test(m.content)), webResolve);
  sameAs(before, snapshot(REPO), 'after refused branch/PR ops');

  // ---------- restart: marker persists; legacy rows stay unmarked ----------
  unwatchAll();
  initDb(DB);
  const reread = Workspaces.get(a.id)!;
  check('restart: marker persists', isDirectWorkspace(reread, Projects.get(project.id)) && reread.directRepo === rootCommit, reread);

  const legacyDb = path.join(ROOT, 'legacy.db');
  initDb(legacyDb);
  const lp: Project = { ...project, id: 'legacy-p' };
  Projects.insert(lp);
  const legacyRows: Workspace[] = [
    { ...reread, id: 'legacy-root', projectId: lp.id, directRepo: undefined }, // in-place at the root, pre-marker
    { ...reread, id: 'legacy-wt', projectId: lp.id, wsKind: 'worktree', worktreePath: path.join(ROOT, 'wt'), directRepo: undefined },
  ];
  legacyRows.forEach((w) => Workspaces.insert(w));
  const raw = new Database(legacyDb);
  raw.exec('ALTER TABLE workspaces DROP COLUMN directRepo'); // the schema before this change
  raw.close();
  initDb(legacyDb); // boot migration re-adds the column
  const cols = (() => {
    const d = new Database(legacyDb, { readonly: true });
    const c = d.prepare('PRAGMA table_info(workspaces)').all().map((r: any) => r.name);
    d.close();
    return c;
  })();
  check('legacy DB: migration adds directRepo', cols.includes('directRepo'));
  const lr = Workspaces.get('legacy-root');
  const lw = Workspaces.get('legacy-wt');
  check('legacy DB: rows readable', !!lr && !!lw && lr.worktreePath === REPO);
  check('legacy DB: pre-existing in-place root row is NOT direct', !!lr && !isDirectWorkspace(lr, lp) && lr.directRepo == null);
  check('legacy DB: worktree row unchanged', !!lw && lw.wsKind === 'worktree' && lw.directRepo == null);
  initDb(DB);

  // ---------- archive safety: the background reclaim never touches a direct ws ----------
  archiveWorkspace(a.id);
  await sweepArchivedWorkspaces();
  const archived = Workspaces.get(a.id)!;
  check('archived; sweep/offload skipped it', archived.archived && !archived.filesFreed);
  check('no offload/archive snapshot written', !fs.existsSync(path.join(process.env.MAESTRO_HOME!, 'archive', a.id)));
  check('no archive ref in the user\'s repo', !sh('git for-each-ref refs/maestro', REPO).trim());
  sameAs(before, snapshot(REPO), 'after archive + sweep');
  const restored = await restoreWorkspace(a.id);
  check('restore reopens in place', restored.workspace.worktreePath === REPO && !restored.workspace.archived);

  // ---------- L5: names; archived direct rows aren't reused ----------
  archiveWorkspace(a.id);
  const fresh0 = await direct(project.id);
  check('only an archived direct ws → a new one is made', fresh0.id !== a.id);
  await provisioned(fresh0.id);
  archiveWorkspace(fresh0.id);
  check('explicit duplicate name refused', await rejects(() => direct(project.id, { name: fresh0.name }), /already exists/));
  await restoreWorkspace(a.id);

  // ---------- delete: bookkeeping only ----------
  await deleteWorkspace(fresh0.id);
  await deleteWorkspace(a.id);
  check('rows removed', !Workspaces.get(a.id) && !Workspaces.get(fresh0.id));
  check('repo directory still exists', fs.existsSync(path.join(REPO, '.git')) && fs.existsSync(path.join(REPO, 'src-app.ts')));
  sameAs(before, snapshot(REPO), 'after delete');

  // ---------- L6: restore validates the repository ----------
  const NEST = path.join(ROOT, 'outer');
  initRepo(NEST);
  commitFile(NEST, 'outer.txt', 'outer\n', 'outer');
  const CHILD = path.join(NEST, 'child');
  initRepo(CHILD);
  commitFile(CHILD, 'c.txt', 'child\n', 'child root');
  const cp = await addProject({ mode: 'local', path: CHILD });
  const cw0 = await direct(cp.id);
  await provisioned(cw0.id);
  const restoreIt = async () => {
    archiveWorkspace(cw0.id);
    unwatchWorkspace(cw0.id);
    return restoreWorkspace(cw0.id);
  };
  // legitimate maintenance: orphan branch with a new root, then gc
  sh('git checkout -q --orphan pages && git rm -rqf . && git commit -q --allow-empty -m "orphan root"', CHILD);
  sh('git gc -q --prune=now', CHILD);
  check('orphan branch + gc: restore still accepted', !(await rejects(restoreIt)));
  sh('git checkout -q main', CHILD);
  // .git gone → the folder now sits inside the outer repo
  fs.renameSync(path.join(CHILD, '.git'), path.join(ROOT, 'child-git-away'));
  check('.git removed (inside another repo) → refused', await rejects(restoreIt, /no longer the root/));
  fs.renameSync(path.join(ROOT, 'child-git-away'), path.join(CHILD, '.git'));
  // unrelated repo at the same path
  fs.renameSync(CHILD, path.join(ROOT, 'child-orig'));
  initRepo(CHILD);
  commitFile(CHILD, 'other.txt', 'unrelated\n', 'unrelated root');
  check('replaced by an unrelated repo → refused', await rejects(restoreIt, /different git repository/));
  check('…and nothing about the replacement changed', sh('git log --oneline', CHILD).trim().split('\n').length === 1);
  fs.rmSync(CHILD, { recursive: true, force: true }); // our own throwaway replacement
  fs.renameSync(path.join(ROOT, 'child-orig'), CHILD);
  // not a repo at all (no parent repo either)
  const LONE = path.join(ROOT, 'lone');
  initRepo(LONE);
  commitFile(LONE, 'l.txt', 'l\n', 'l');
  const lpj = await addProject({ mode: 'local', path: LONE });
  const lw0 = await direct(lpj.id);
  await provisioned(lw0.id);
  archiveWorkspace(lw0.id);
  unwatchWorkspace(lw0.id);
  fs.renameSync(path.join(LONE, '.git'), path.join(ROOT, 'lone-git-away'));
  check('.git removed (no repo) → refused', await rejects(() => restoreWorkspace(lw0.id), /no longer a git repository/));
  check('…and no repo was initialized', !fs.existsSync(path.join(LONE, '.git')));
  fs.renameSync(path.join(ROOT, 'lone-git-away'), path.join(LONE, '.git'));
  fs.renameSync(LONE, `${LONE}-moved`);
  check('moved away → refused as missing', await rejects(() => restoreWorkspace(lw0.id), /missing/));
  check('create direct with missing dir is refused', await rejects(() => direct(lpj.id)));
  check('nothing recreated at the old path', !fs.existsSync(LONE));
  fs.renameSync(`${LONE}-moved`, LONE);
  check('put back → restore accepted', !(await rejects(() => restoreWorkspace(lw0.id))));
  check('restored original: same repo, untouched', sh('git log --oneline', CHILD).includes('child root'));

  // ---------- detached HEAD / no upstream / no commits ----------
  const DET = path.join(ROOT, 'detached');
  initRepo(DET);
  commitFile(DET, 'x.txt', 'x\n', 'one');
  commitFile(DET, 'x.txt', 'x\ny\n', 'two');
  sh('git checkout -q --detach HEAD~1', DET);
  fs.appendFileSync(path.join(DET, 'x.txt'), 'dirty\n');
  const dp = await addProject({ mode: 'local', path: DET });
  const dw0 = await direct(dp.id);
  await provisioned(dw0.id);
  const dw = Workspaces.get(dw0.id)!;
  check('detached: created with empty branch', dw.branch === '' && isDirectWorkspace(dw, dp), dw.branch);
  check('detached: HEAD not moved', sh('git rev-parse --abbrev-ref HEAD', DET).trim() === 'HEAD');
  const dst = await changes.workspaceStatus(dw, dp);
  check('detached: status has no upstream, 0/0', dst.upstream === null && dst.ahead === 0 && dst.behind === 0 && dst.branch === 'HEAD', dst);
  const ddiff = await changes.workspaceDiff(dw, dp);
  check('detached: uncommitted diff vs HEAD', ddiff.files.length === 1 && ddiff.files[0].stage === 'unstaged', ddiff.files);
  check('detached: branch scope degrades gracefully', !(await rejects(() => changes.workspaceDiff(dw, dp, 'branch'))));

  const NOUP = path.join(ROOT, 'no-upstream');
  initRepo(NOUP);
  commitFile(NOUP, 'n.txt', 'n\n', 'n');
  sh('git checkout -qb topic', NOUP);
  commitFile(NOUP, 'n.txt', 'n\nmore\n', 'topic work');
  const np = await addProject({ mode: 'local', path: NOUP });
  const nw0 = await direct(np.id);
  await provisioned(nw0.id);
  const nst = await changes.workspaceStatus(Workspaces.get(nw0.id)!, np);
  check('no upstream: upstream null, 0/0', nst.upstream === null && nst.ahead === 0 && nst.behind === 0, nst);
  const nbr = await changes.workspaceDiff(Workspaces.get(nw0.id)!, np, 'branch');
  check('no upstream: branch scope falls back to the project base', /no upstream/.test(nbr.base), nbr.base);

  const EMPTY = path.join(ROOT, 'unborn');
  initRepo(EMPTY);
  fs.writeFileSync(path.join(EMPTY, 'first.txt'), 'first\n');
  sh('git add first.txt', EMPTY);
  fs.writeFileSync(path.join(EMPTY, 'loose.txt'), 'loose\n');
  const ep = await addProject({ mode: 'local', path: EMPTY });
  const ew0 = await direct(ep.id);
  await provisioned(ew0.id);
  const ew = Workspaces.get(ew0.id)!;
  check('no commits: direct ws created, identity empty', ew.status === 'idle' && ew.directRepo === '', ew);
  const ediff = byPath(await changes.workspaceDiff(ew, ep));
  check('no commits: staged new file + untracked shown', ediff['first.txt']?.stage === 'staged' && ediff['loose.txt']?.status === 'untracked', ediff);
  check('no commits: staged scope works', (await changes.workspaceDiff(ew, ep, 'staged')).files.length === 1);
  check('no commits: branch scope empty, no throw', (await changes.workspaceDiff(ew, ep, 'branch')).files.length === 0);
  const est = await changes.workspaceStatus(ew, ep);
  check('no commits: status counts', est.staged === 1 && est.untracked === 1 && est.upstream === null, est);
  archiveWorkspace(ew.id);
  unwatchWorkspace(ew.id);
  check('no commits: restore accepted (no identity to check)', !(await rejects(() => restoreWorkspace(ew.id))));

  // ---------- L1: .git/info/exclude ----------
  const excl = (repo: string) => fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  const CUST = path.join(ROOT, 'custom-exclude');
  initRepo(CUST);
  commitFile(CUST, 'k.txt', 'k\n', 'k');
  fs.writeFileSync(path.join(CUST, '.git', 'info', 'exclude'), '# mine\nsecret.txt'); // no trailing newline
  const xp = await addProject({ mode: 'local', path: CUST });
  const xw = await direct(xp.id);
  await provisioned(xw.id);
  check('exclude: existing content kept, .context/ appended on its own line', excl(CUST) === '# mine\nsecret.txt\n.context/\n', excl(CUST));
  check('exclude: .context/ now ignored', sh('git check-ignore --no-index .context/x || true', CUST).trim() === '.context/x');
  const wt0 = await createWorkspace({ projectId: xp.id, harness: 'shell' }); // a worktree on the same repo
  await provisioned(wt0.id);
  check('exclude: a later worktree on the same repo adds no duplicate', excl(CUST) === '# mine\nsecret.txt\n.context/\n', excl(CUST));

  const GI = path.join(ROOT, 'gitignored');
  initRepo(GI);
  commitFile(GI, '.gitignore', 'node_modules/\n.context/\n', 'ignore');
  const giBefore = excl(GI);
  const gp = await addProject({ mode: 'local', path: GI });
  const gw = await direct(gp.id);
  await provisioned(gw.id);
  check('exclude: already ignored via .gitignore → file not touched', excl(GI) === giBefore);

  const LINK = path.join(ROOT, 'linked-main');
  initRepo(LINK);
  commitFile(LINK, 'm.txt', 'm\n', 'm');
  sh(`git worktree add -q ${JSON.stringify(path.join(ROOT, 'linked-wt'))} -b side`, LINK);
  check('exclude: linked worktree (gitdir: file) → true', await git.ensureContextDir(path.join(ROOT, 'linked-wt')));
  check('exclude: …written to the common dir\'s info/exclude once', excl(LINK).split('\n').filter((l) => l === '.context/').length === 1, excl(LINK));
  check('exclude: …and ignored from the linked worktree', sh('git check-ignore --no-index .context/x || true', path.join(ROOT, 'linked-wt')).trim() === '.context/x');

  const RO = path.join(ROOT, 'readonly-exclude');
  initRepo(RO);
  commitFile(RO, 'r.txt', 'r\n', 'r');
  const roInfo = path.join(RO, '.git', 'info');
  fs.chmodSync(path.join(roInfo, 'exclude'), 0o444);
  fs.chmodSync(roInfo, 0o555);
  const rp = await addProject({ mode: 'local', path: RO });
  const rw0 = await direct(rp.id);
  await provisioned(rw0.id);
  const rw = Workspaces.get(rw0.id)!;
  if (process.getuid?.() === 0) console.log('SKIP unwritable-exclude check (running as root)');
  else check('exclude unwritable → surfaced as needs-attention, not silent', rw.status === 'needs-attention' && /\.context/.test(rw.setupError ?? ''), rw);
  fs.chmodSync(roInfo, 0o755);
  fs.chmodSync(path.join(roInfo, 'exclude'), 0o644);

  // ---------- regression: worktree workspaces, same repo ----------
  const w0 = await createWorkspace({ projectId: project.id, harness: 'shell' });
  await provisioned(w0.id);
  const w = Workspaces.get(w0.id)!;
  check('worktree ws provisioned', w.status === 'idle' && w.wsKind === 'worktree', { status: w.status, err: w.setupError });
  check('worktree ws is not direct, no marker', !isDirectWorkspace(w, project) && w.directRepo == null);
  check('worktree ws lives under MAESTRO_HOME', w.worktreePath.startsWith(process.env.MAESTRO_HOME!) && fs.existsSync(path.join(w.worktreePath, 'README.md')));
  check('worktree ws got its own new branch', w.branch !== 'feature/local-work' && (await git.currentBranch(w.worktreePath)) === w.branch, w.branch);
  check('worktree registered with git', sh('git worktree list --porcelain', REPO).includes(w.worktreePath));
  fs.appendFileSync(path.join(w.worktreePath, 'README.md'), 'wt edit\n');
  sh('git commit -qam "wt commit"', w.worktreePath);
  fs.writeFileSync(path.join(w.worktreePath, 'wt-new.txt'), 'n\n');
  const wd = await changes.workspaceDiff(w, project, 'staged'); // a scope is ignored for worktrees
  check('worktree diff unchanged: vs base merge-base, commits included, no scope/stage', wd.base === project.baseBranch && !wd.scope && wd.files.some((f) => f.path === 'README.md') && wd.files.every((f) => !f.stage), wd);
  const wst = await changes.workspaceStatus(w, project);
  check('worktree status unchanged: ahead vs base, no upstream field', wst.ahead >= 1 && wst.upstream === undefined, wst);
  const ren = await renameWorkspaceBranch(w.id, `${w.branch}-renamed`).then(() => true, () => false);
  check('worktree ws can still rename its branch', ren && (await git.currentBranch(w.worktreePath)) === `${w.branch}-renamed`);
  check('user checkout still on its branch', snapshot(REPO).branch === 'feature/local-work' && snapshot(REPO).status === before.status);
  const wPath = Workspaces.get(w.id)!.worktreePath;
  const wBranch = Workspaces.get(w.id)!.branch;
  await deleteWorkspace(w.id);
  check('worktree delete removes the worktree dir', !fs.existsSync(wPath));
  check('worktree delete unregisters it', !sh('git worktree list --porcelain', REPO).includes(wPath));
  check('worktree delete keeps the branch', sh('git for-each-ref --format="%(refname:short)" refs/heads', REPO).split('\n').includes(wBranch));

  // removing the whole project (with "delete workspaces") never touches the checkout
  const beforeRemoval = snapshot(REPO); // now includes the worktree's kept branch
  const pd = await direct(project.id);
  await provisioned(pd.id);
  await removeProject(project.id, true);
  check('project removed', !Projects.get(project.id));
  check('repo survives project removal', fs.existsSync(path.join(REPO, '.git')));
  sameAs(beforeRemoval, snapshot(REPO), 'after project removal');
}

main()
  .catch((e) => {
    failures++;
    console.error('FAIL (threw)', e);
  })
  .finally(() => {
    try {
      stopAllAgents();
      killAllPtys();
    } catch {}
    try {
      fs.chmodSync(path.join(ROOT, 'readonly-exclude', '.git', 'info'), 0o755);
    } catch {}
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exit(failures ? 1 : 0);
  });
