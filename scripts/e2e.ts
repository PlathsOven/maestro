/**
 * Service-level end-to-end test + demo seeder.
 * Runs under ELECTRON_RUN_AS_NODE so native modules (better-sqlite3, node-pty)
 * built for Electron load correctly, without opening a window.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron dist/e2e.cjs [--with-claude]
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { resolveShellEnv } from '../src/main/env';
import { initDb, Messages, Comments, Todos, Workspaces, Projects, uid, now } from '../src/main/db';
import * as git from '../src/main/services/git';
import {
  addProject,
  archiveWorkspace,
  createWorkspace,
  deleteWorkspace,
  restoreWorkspace,
  switchBranch,
} from '../src/main/services/workspaces';
import { sendChat } from '../src/main/services/chat';
import { readRepoSettings, writeRepoSettings } from '../src/main/services/settingsToml';
import { prStatus } from '../src/main/services/github';
import { readFile, statFile, writeFile } from '../src/main/services/files';
import { cellText, newCell, parseNotebook, serializeNotebook, setCellText } from '../src/renderer/lib/nbformat';
import { annotationBody, boxMaxOverlap, hitTest, pointInSmallest, scaledDims } from '../src/renderer/lib/annotate';
import {
  composeResolvePrompt,
  mergeabilityUnknown,
  mergeFailureMessage,
  noConflictsGate,
} from '../src/renderer/lib/resolveConflicts';
import type { AnnotationItem, ElementRef } from '../src/shared/types';

const ROOT = '/tmp/maestro-test';
const REPO = path.join(ROOT, 'demo-repo');
const withClaude = process.argv.includes('--with-claude');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function sh(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

async function main() {
  resolveShellEnv();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  process.env.MAESTRO_HOME = path.join(ROOT, 'home');

  // 1. demo repo
  sh('git init -b main', REPO);
  sh('git config user.email maestro@test.local && git config user.name Maestro', REPO);
  fs.writeFileSync(path.join(REPO, 'README.md'), '# Demo\n\nA demo repository for Maestro.\n');
  fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(REPO, 'src/server.ts'),
    `import http from 'http';\n\nconst port = Number(process.env.WORKSPACE_PORT ?? 3000);\n\nexport function greet(name: string) {\n  return 'Hello ' + name;\n}\n\nhttp.createServer((_req, res) => res.end(greet('world'))).listen(port);\nconsole.log('listening on ' + port);\n`
  );
  fs.writeFileSync(path.join(REPO, 'src/util.ts'), `export const add = (a: number, b: number) => a + b;\n`);
  sh('git add -A && git commit -m "Initial commit"', REPO);

  initDb(path.join(ROOT, 'maestro.db'));

  // 2. project add (local path)
  const project = await addProject({ mode: 'local', path: REPO });
  check('project:add local', project.name === 'demo-repo' && !!project.baseBranch, `base=${project.baseBranch}`);

  // repo settings toml round-trip
  writeRepoSettings(REPO, {
    setupScript: 'mkdir -p .context && echo setup-done > .context/setup-marker',
    runScript: 'echo "run on port $WORKSPACE_PORT"',
    instructions: 'Keep functions small. This is a demo repo.',
  });
  const rs = readRepoSettings(REPO);
  check('settings.toml round-trip', rs.setupScript.includes('setup-marker') && rs.instructions.includes('demo'));

  // 3. workspace 1 — fresh branch from base
  const ws1 = await createWorkspace({ projectId: project.id, harness: 'claude-code' });
  check('workspace:create returns setting-up', ws1.status === 'setting-up');
  await waitFor(() => Workspaces.get(ws1.id)?.status !== 'setting-up', 60_000, 'ws1 provisioning');
  const w1 = Workspaces.get(ws1.id)!;
  check('ws1 provisioned idle', w1.status === 'idle', `status=${w1.status} err=${w1.setupError}`);
  check('ws1 worktree exists', fs.existsSync(path.join(w1.worktreePath, 'README.md')), w1.worktreePath);
  check('ws1 setup script ran', fs.existsSync(path.join(w1.worktreePath, '.context/setup-marker')));
  check('ws1 .context created', fs.existsSync(path.join(w1.worktreePath, '.context')));
  const br1 = await git.currentBranch(w1.worktreePath);
  check('ws1 on its own branch', br1 === w1.branch && br1 !== 'main', br1);

  // 4. workspace 2 — parallel, unique port
  const ws2 = await createWorkspace({ projectId: project.id, harness: 'claude-code' });
  await waitFor(() => Workspaces.get(ws2.id)?.status !== 'setting-up', 60_000, 'ws2 provisioning');
  const w2 = Workspaces.get(ws2.id)!;
  check('ws2 provisioned idle', w2.status === 'idle', `err=${w2.setupError}`);
  check('distinct ports', w1.port !== w2.port, `${w1.port} vs ${w2.port}`);
  check('distinct branches/trees', w1.branch !== w2.branch && w1.worktreePath !== w2.worktreePath);

  // 5. edit in ws1 → diff vs base
  fs.appendFileSync(path.join(w1.worktreePath, 'src/util.ts'), `export const sub = (a: number, b: number) => a - b;\n`);
  fs.writeFileSync(path.join(w1.worktreePath, 'src/new-file.ts'), `export const created = true;\n`);
  const diff = await git.workspaceDiff(w1.worktreePath, project.baseBranch);
  const utilFile = diff.files.find((f) => f.path === 'src/util.ts');
  const newFile = diff.files.find((f) => f.path === 'src/new-file.ts');
  check('diff picks up modification', !!utilFile && utilFile.additions === 1, JSON.stringify(utilFile?.additions));
  check('diff picks up untracked file', !!newFile && newFile.status === 'untracked');
  const ds = await git.diffStat(w1.worktreePath, project.baseBranch);
  check('diffstat counts additions (tracked + untracked)', ds.additions >= 2 && ds.deletions === 0, JSON.stringify(ds));
  const st = await git.statusSummary(w1.worktreePath, project.baseBranch);
  check('status summary dirty', st.dirty && st.untracked >= 1 && st.branch === w1.branch, JSON.stringify(st));

  // isolation: ws2 clean
  const st2 = await git.statusSummary(w2.worktreePath, project.baseBranch);
  check('ws2 unaffected (isolation)', !st2.dirty);

  // 6. from-branch conflict handling (one branch per worktree)
  const ws3 = await createWorkspace({
    projectId: project.id,
    harness: 'shell',
    from: { type: 'branch', ref: w1.branch },
  });
  await waitFor(() => Workspaces.get(ws3.id)?.status !== 'setting-up', 60_000, 'ws3 provisioning');
  const w3 = Workspaces.get(ws3.id)!;
  check('from-busy-branch falls back to suffix', w3.branch === `${w1.branch}-2`, w3.branch);

  // 7. comments + todos + seeded chat for screenshots
  Comments.insert({
    id: uid(), workspaceId: w1.id, file: 'src/util.ts', line: 2, side: 'new',
    body: 'Handle negative numbers explicitly here?', resolved: false, createdAt: now(),
  });
  Todos.insert({ id: uid(), workspaceId: w1.id, text: 'Add unit tests for util.ts', done: false, createdAt: now() });
  Todos.insert({ id: uid(), workspaceId: w1.id, text: 'Rename branch to match task', done: true, createdAt: now() });

  // 7.5 in-app editor: fs:read / fs:stat / fs:write service + nbformat round-trip
  {
    const root = w1.worktreePath;

    const rd = readFile(root, 'src/util.ts');
    check(
      'fs:read text w/ mtime',
      rd.kind === 'text' && typeof rd.mtimeMs === 'number' && rd.text.includes('add'),
      rd.kind
    );

    // 1×1 PNG → image data URL
    const pngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    fs.writeFileSync(path.join(root, 'pixel.png'), Buffer.from(pngB64, 'base64'));
    const rimg = readFile(root, 'pixel.png');
    check('fs:read image → dataUrl', rimg.kind === 'image' && rimg.dataUrl.startsWith('data:image/png;base64,'));

    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4]));
    check('fs:read NUL → binary fallback', readFile(root, 'blob.bin').kind === 'binary');

    fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(6 * 1024 * 1024, 0x61));
    const rbig = readFile(root, 'big.txt');
    check('fs:read >5MB → binary', rbig.kind === 'binary' && /too large/i.test(rbig.error ?? ''));
    fs.rmSync(path.join(root, 'big.txt'));

    const resc = readFile(root, '../../../etc/hosts');
    check('fs:read ../ escape rejected', resc.kind === 'binary' && /outside/i.test(resc.error ?? ''));

    // atomic write + mode preservation + mtime bump
    const target = path.join(root, 'src/util.ts');
    fs.chmodSync(target, 0o640);
    const before = readFile(root, 'src/util.ts');
    const baseMtime = before.kind === 'text' ? before.mtimeMs : 0;
    const baseText = before.kind === 'text' ? before.text : '';
    const w = writeFile(root, 'src/util.ts', baseText + 'export const mul = (a: number, b: number) => a * b;\n', baseMtime);
    check('fs:write ok', w.ok === true);
    check('fs:write preserves mode', (fs.statSync(target).mode & 0o777) === 0o640, (fs.statSync(target).mode & 0o777).toString(8));
    check('fs:write persisted + no tmp', fs.readFileSync(target, 'utf8').includes('mul') && !fs.existsSync(target + '.maestro-tmp'));

    const stale = writeFile(root, 'src/util.ts', 'clobber', 123);
    check('fs:write stale mtime → conflict', stale.ok === false && stale.conflict === true);
    const forced = writeFile(root, 'src/util.ts', 'export const forced = 1;\n', 123, true);
    check('fs:write force overrides', forced.ok === true && fs.readFileSync(target, 'utf8').includes('forced'));

    const created = writeFile(root, 'src/created.txt', 'hi\n', null);
    check('fs:write create (null mtime)', created.ok === true && fs.readFileSync(path.join(root, 'src/created.txt'), 'utf8') === 'hi\n');

    // symlink escaping the worktree is refused for read AND write
    const outside = path.join(ROOT, 'outside-secret.txt');
    fs.writeFileSync(outside, 'secret');
    try {
      fs.symlinkSync(outside, path.join(root, 'link.txt'));
    } catch {}
    check('fs:read via escaping symlink refused', readFile(root, 'link.txt').kind === 'binary');
    let symlinkRefused = false;
    try {
      writeFile(root, 'link.txt', 'pwned', null, true);
    } catch {
      symlinkRefused = true;
    }
    check('fs:write through symlink refused', symlinkRefused && fs.readFileSync(outside, 'utf8') === 'secret');

    check('fs:stat mtime', (statFile(root, 'src/util.ts')?.mtimeMs ?? 0) > 0);
    check('fs:stat null for missing', statFile(root, 'nope/missing.ts') === null);

    // nbformat: unedited round-trip is semantically identical; unknown metadata
    // + cell ids survive; edited source normalizes to nbformat line-array form.
    const nbText = JSON.stringify(
      {
        cells: [
          { cell_type: 'markdown', id: 'md1', source: ['# Title\n', 'body'], metadata: { custom: 42 } },
          { cell_type: 'code', id: 'code1', execution_count: 3, source: 'print("hi")', outputs: [], metadata: {} },
        ],
        metadata: { kernelspec: { language: 'python' }, custom_top: { a: 1 } },
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1
    );
    const doc = parseNotebook(nbText)!;
    check('nbformat parse', !!doc && doc.cells.length === 2);
    const roundTrip = JSON.parse(serializeNotebook(doc));
    check('nbformat round-trip semantic', JSON.stringify(roundTrip) === JSON.stringify(JSON.parse(nbText)));
    check(
      'nbformat unknown metadata + ids survive',
      roundTrip.metadata.custom_top.a === 1 && roundTrip.cells[0].metadata.custom === 42 && roundTrip.cells[0].id === 'md1'
    );
    setCellText(doc.cells[1], 'x = 1\ny = 2\n');
    check(
      'nbformat edited source → line array',
      Array.isArray(doc.cells[1].source) &&
        cellText(doc.cells[1]) === 'x = 1\ny = 2\n' &&
        (doc.cells[1].source as string[])[0] === 'x = 1\n'
    );
    check('nbformat invalid → null', parseNotebook('{not json') === null);
    const nc = newCell('code');
    check('nbformat newCell has id + null exec', !!nc.id && nc.execution_count === null && Array.isArray(nc.outputs));

    // restore util.ts (keep §5's `sub` edit) for the later commit/push sections
    writeFile(root, 'src/util.ts', baseText, null, true);
    fs.chmodSync(target, 0o644);
    for (const f of ['pixel.png', 'blob.bin', 'src/created.txt', 'link.txt']) {
      try {
        fs.rmSync(path.join(root, f));
      } catch {}
    }
  }

  if (withClaude) {
    // 8. real Claude Code harness run (uses the CLI's existing login)
    const res = await sendChat({
      workspaceId: w1.id,
      agentId: 1,
      text: 'Reply with exactly: OK — do not run any tools, do not modify files.',
      attachments: [],
    });
    check('chat:send accepted', res.ok, res.error);
    const gotReply = await waitFor(
      () => Messages.list(w1.id).some((m) => m.role === 'agent'),
      120_000,
      'claude agent reply'
    );
    const agentMsg = Messages.list(w1.id).find((m) => m.role === 'agent');
    let blocksOk = false;
    try {
      const blocks = JSON.parse(agentMsg?.content ?? '[]');
      blocksOk = Array.isArray(blocks) && blocks.some((b: any) => b.type === 'text' && /OK/i.test(b.text));
    } catch {}
    check('claude harness round-trip', gotReply && blocksOk, (agentMsg?.content ?? '').slice(0, 120));
    const after = Workspaces.get(w1.id)!;
    check('ws1 back to idle after run', after.status === 'idle', after.status);
    const sessions = Workspaces.getSessions(w1.id);
    check('claude session captured', !!sessions['1'], sessions['1']);
  } else {
    // seed fake chat so screenshots have content
    Messages.insert({
      id: uid(), workspaceId: w1.id, agentId: 1, role: 'user',
      content: 'Add a subtraction helper to src/util.ts and create a new module for constants.',
      attachments: [], ts: now() - 60_000,
    });
    Messages.insert({
      id: uid(), workspaceId: w1.id, agentId: 1, role: 'agent',
      content: JSON.stringify([
        { type: 'text', text: "I'll add the helper and the new module." },
        { type: 'tool', id: 't1', name: 'Edit', input: { file_path: 'src/util.ts' }, result: { ok: true, summary: 'Added sub()' } },
        { type: 'tool', id: 't2', name: 'Write', input: { file_path: 'src/new-file.ts' }, result: { ok: true, summary: 'Created file' } },
        { type: 'text', text: 'Done — `sub()` added to **src/util.ts** and `src/new-file.ts` created. Both are visible in the diff.' },
      ]),
      attachments: [], ts: now() - 30_000, meta: { costUsd: 0.042, durationMs: 21_000 },
    });
  }

  // 9. push to a local bare "origin" — exercises the pre-PR mechanics without GitHub
  const bare = path.join(ROOT, 'origin.git');
  sh(`git init --bare ${bare}`, ROOT);
  sh(`git remote add origin ${bare}`, REPO);
  sh('git push -u origin main', REPO);
  sh('git add -A && git commit -m "ws1 work"', w1.worktreePath);
  const push = await git.pushCurrent(w1.worktreePath);
  check('push branch to origin', push.ok, push.error);
  const st3 = await git.statusSummary(w1.worktreePath, project.baseBranch);
  check('ahead of base after commit', st3.ahead === 1, String(st3.ahead));
  const pr = await prStatus(w1.worktreePath, true);
  check('prStatus null for non-GitHub remote (graceful)', pr === null);

  // 9b. detached HEAD (agent ran `git checkout <sha>`) — push reattaches when
  // that loses nothing, and refuses when the branch has commits HEAD lacks.
  sh('git checkout --detach', w1.worktreePath);
  fs.writeFileSync(path.join(w1.worktreePath, 'detached.txt'), 'work done off-branch\n');
  sh('git add -A && git commit -m "detached work"', w1.worktreePath);
  const dpush = await git.pushCurrent(w1.worktreePath, undefined, w1.branch);
  check('detached HEAD reattaches and pushes', dpush.ok && dpush.reattached === w1.branch, dpush.error);
  check('back on the workspace branch', (await git.currentBranch(w1.worktreePath)) === w1.branch);
  sh('git checkout --detach HEAD~1', w1.worktreePath);
  const dpush2 = await git.pushCurrent(w1.worktreePath, undefined, w1.branch);
  check('detached behind branch refuses to reattach', !dpush2.ok && /detached HEAD/.test(dpush2.error ?? ''), dpush2.error);
  sh(`git checkout ${w1.branch}`, w1.worktreePath);

  // 10. switch-branch conflict → main is checked out in the primary repo clone
  const sw = await switchBranch(w2.id, 'main', false);
  check('switchBranch conflict detected', !sw.ok && !!sw.conflict, sw.conflict?.slice(0, 60));

  // 11. archive → restore keeps chat; hard delete removes worktree
  archiveWorkspace(w1.id);
  const archived = Workspaces.get(w1.id)!;
  check('archive hides + keeps disk', archived.archived && fs.existsSync(w1.worktreePath));
  const msgCountBefore = Messages.list(w1.id).length;
  await restoreWorkspace(w1.id);
  const restored = Workspaces.get(w1.id)!;
  check(
    'restore brings back with chat history',
    !restored.archived && Messages.list(w1.id).length === msgCountBefore && msgCountBefore > 0
  );
  await deleteWorkspace(ws3.id);
  check('hard delete removes worktree', !fs.existsSync(w3.worktreePath) && Workspaces.get(ws3.id) === null);

  const projCount = Projects.list().length;
  check('db persisted', projCount === 1 && Workspaces.list().length === 2);

  // 12. annotation math (pure fns in lib/annotate — §9 hit-test + composite)
  {
    const els: ElementRef[] = [
      { selector: '#big', tag: 'div', text: 'big', rect: { x: 0, y: 0, width: 100, height: 100 } },
      { selector: '#small', tag: 'button', text: 'Save changes', rect: { x: 10, y: 10, width: 20, height: 20 } },
      { selector: '#far', tag: 'a', text: 'Billing', rect: { x: 200, y: 200, width: 40, height: 40 } },
    ];
    // point-in-smallest picks the smaller containing element, not the enclosing one.
    check('annotate: point-in-smallest', pointInSmallest(els, 15, 15)?.selector === '#small');
    check('annotate: point in enclosing only', pointInSmallest(els, 5, 5)?.selector === '#big');
    check('annotate: point outside all', pointInSmallest(els, 500, 500) === null);
    // box max-overlap picks the element the box covers most.
    check('annotate: box max-overlap near', boxMaxOverlap(els, { x: 205, y: 205, width: 20, height: 20 })?.selector === '#far');
    check('annotate: box max-overlap none', boxMaxOverlap(els, { x: 400, y: 400, width: 5, height: 5 }) === null);
    // hitTest dispatches box→overlap, pin→point.
    const boxMark: AnnotationItem = { id: 'a', kind: 'box', points: [{ x: 8, y: 8 }, { x: 34, y: 34 }] };
    const pinMark: AnnotationItem = { id: 'b', kind: 'pin', points: [{ x: 15, y: 15 }], note: 'make this green' };
    check('annotate: hitTest box', hitTest(boxMark, els)?.selector === '#small');
    check('annotate: hitTest pin', hitTest(pinMark, els)?.selector === '#small');
    // composite scaling at dpr 1 and 2.
    const d1 = scaledDims(1280, 800, 1);
    const d2 = scaledDims(1280, 800, 2);
    check('annotate: composite dpr1', d1.width === 1280 && d1.height === 800);
    check('annotate: composite dpr2', d2.width === 2560 && d2.height === 1600);
    // prompt body carries numbered marks + matched selector + note.
    const withMatch: AnnotationItem = { ...pinMark, selector: '#small', matchText: 'Save changes' };
    const body = annotationBody([withMatch], 'http://localhost:4102/', 1280, 800);
    check(
      'annotate: prompt body',
      body.includes('viewport 1280×800') && body.includes('`#small`') && body.includes('make this green')
    );
  }

  // 8. Resolve-conflicts PR mode (docs/specs/resolve-conflicts-pr-mode.md §10)
  {
    // merge-tree output parsing: OID line skipped, files until the blank
    // separator, deduped.
    check('mergeTree parse: only OID → no files', git.parseMergeTreeConflicts('deadbeeftreeoid\n').length === 0);
    const parsed = git.parseMergeTreeConflicts(
      'treeoid123\nsrc/a.ts\nsrc/b.ts\nsrc/a.ts\n\nCONFLICT (content): Merge conflict in src/a.ts\n'
    );
    check(
      'mergeTree parse: files until blank, deduped',
      parsed.length === 2 && parsed[0] === 'src/a.ts' && parsed[1] === 'src/b.ts',
      JSON.stringify(parsed)
    );

    // prompt composition — with and without a file list.
    const withFiles = composeResolvePrompt({
      number: 42,
      title: 'Add widget',
      base: 'main',
      baseRef: 'origin/main',
      conflictFiles: ['src/a.ts', 'src/b.ts'],
    });
    check(
      'resolve prompt (with files)',
      withFiles.includes('#42 ("Add widget")') &&
        withFiles.includes('git merge origin/main') &&
        withFiles.includes('Files expected to conflict:') &&
        withFiles.includes('   - src/a.ts') &&
        withFiles.includes('git merge --abort') &&
        withFiles.includes('do not force-push'),
      'missing expected prompt fragments'
    );
    const noFiles = composeResolvePrompt({
      number: 7,
      title: 'Fix bug',
      base: 'develop',
      baseRef: 'origin/develop',
      conflictFiles: null,
    });
    check(
      'resolve prompt (no files) omits the file listing',
      !noFiles.includes('Files expected to conflict:') &&
        noFiles.includes('Resolve every conflict.') &&
        noFiles.includes('git merge origin/develop'),
      'unexpected prompt shape'
    );

    // gate math for noConflicts across the three mergeable values (UNKNOWN/null green).
    check(
      'noConflicts gate math',
      noConflictsGate('MERGEABLE') === true &&
        noConflictsGate('UNKNOWN') === true &&
        noConflictsGate(null) === true &&
        noConflictsGate('CONFLICTING') === false
    );

    // "GitHub hasn't answered" has to be distinct from "clean" — reading UNKNOWN
    // as clean is what made a conflicted PR advertise itself as ready to merge.
    check(
      'mergeabilityUnknown',
      mergeabilityUnknown('UNKNOWN') &&
        mergeabilityUnknown(null) &&
        mergeabilityUnknown(undefined) &&
        !mergeabilityUnknown('MERGEABLE') &&
        !mergeabilityUnknown('CONFLICTING')
    );

    // gh's conflict refusal → one actionable sentence; anything else passes through.
    const ghRefusal =
      'X Pull request #13 is not mergeable: the merge commit cannot be cleanly created. To have the pull request merged after all the requirements have been met, add the `--auto` flag.\nRun the following to resolve the merge conflicts locally: gh pr checkout 13 && git fetch origin main && git merge origin/main';
    check(
      'merge failure message',
      mergeFailureMessage(ghRefusal, 'main') === 'This PR has merge conflicts with main — resolve them, then merge.' &&
        mergeFailureMessage('GraphQL: Resource not accessible', 'main') === 'GraphQL: Resource not accessible',
      mergeFailureMessage(ghRefusal, 'main')
    );

    // preflight smoke: base and branch edit the same line → the file conflicts.
    const cdir = path.join(ROOT, 'conflict-repo');
    fs.mkdirSync(cdir, { recursive: true });
    sh('git init -b main', cdir);
    sh('git config user.email maestro@test.local && git config user.name Maestro', cdir);
    fs.writeFileSync(path.join(cdir, 'file.txt'), 'line one\nline two\nline three\n');
    sh('git add -A && git commit -m init', cdir);
    sh('git checkout -b feature', cdir);
    fs.writeFileSync(path.join(cdir, 'file.txt'), 'branch one\nline two\nline three\n');
    sh('git add -A && git commit -m branch-edit', cdir);
    sh('git checkout main', cdir);
    fs.writeFileSync(path.join(cdir, 'file.txt'), 'main one\nline two\nline three\n');
    sh('git add -A && git commit -m main-edit', cdir);
    sh('git checkout feature', cdir);
    const conflicts = await git.conflictPreflight(cdir, 'main');
    if (conflicts === null) {
      // Old git without `merge-tree --write-tree` — degrade to "unknown" (§8).
      check('preflight null on old git (skipped assert)', true, 'merge-tree unavailable');
    } else {
      check('preflight lists the conflicted file', conflicts.includes('file.txt'), JSON.stringify(conflicts));
      // a base that's an ancestor of HEAD → clean ([]).
      sh('git checkout -b feature2 main', cdir);
      fs.writeFileSync(path.join(cdir, 'other.txt'), 'unrelated\n');
      sh('git add -A && git commit -m other', cdir);
      const clean = await git.conflictPreflight(cdir, 'main');
      check('preflight clean when base is an ancestor', clean !== null && clean.length === 0, JSON.stringify(clean));
    }

    // unpushed: the reason a clean preflight can disagree with GitHub, which
    // judges the pushed head. No remote counterpart → 0, not a false accusation.
    sh('git checkout feature', cdir); // the clean-preflight case above left us on feature2
    check('unpushed 0 without a remote', (await git.unpushedCount(cdir, 'feature')) === 0);
    const bare = path.join(ROOT, 'conflict-origin.git');
    sh(`git init --bare "${bare}"`, ROOT);
    sh(`git remote add origin "${bare}" && git push -q origin feature`, cdir);
    check('unpushed 0 when in sync', (await git.unpushedCount(cdir, 'feature')) === 0);
    fs.appendFileSync(path.join(cdir, 'file.txt'), 'local only\n');
    sh('git add -A && git commit -m local-only', cdir);
    check('unpushed counts commits origin lacks', (await git.unpushedCount(cdir, 'feature')) === 1);
  }

  // ---- Continue after a merged PR: work made since the merge has to survive ----
  {
    // A squash-merged PR, the shape GitHub's "Squash & merge" leaves behind: the
    // branch's commits are NOT ancestors of main, so cutting a fresh branch from
    // main drops everything the agent did afterwards unless we replay it.
    const root = path.join(ROOT, 'continue');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const origin = path.join(root, 'origin.git');
    const wt = path.join(root, 'work');
    sh(`git init -q --bare "${origin}"`, root);
    sh(`git clone -q "${origin}" work`, root);
    sh('git config user.email maestro@test.local && git config user.name Maestro', wt);
    fs.writeFileSync(path.join(wt, 'README.md'), 'base\n');
    sh('git add -A && git commit -q -m init && git branch -M main && git push -q -u origin main', wt);
    sh('git checkout -q -b feature', wt);
    fs.writeFileSync(path.join(wt, 'f1.txt'), 'shipped\n');
    sh('git add -A && git commit -q -m shipped && git push -q -u origin feature', wt);
    const mergedHead = (await git.revParse(wt, 'refs/remotes/origin/feature'))!;
    sh('git checkout -q main && git merge -q --squash feature && git commit -q -m "squash merge (#1)"', wt);
    sh('git push -q origin main', wt);
    // Somebody else lands on main too — the replay must not revert their work.
    fs.writeFileSync(path.join(wt, 'other.txt'), 'someone else\n');
    sh('git add -A && git commit -q -m other && git push -q origin main', wt);
    sh('git checkout -q feature', wt);

    // The agent keeps working on the merged branch: one commit, plus dirty files.
    fs.appendFileSync(path.join(wt, 'f1.txt'), 'after the merge\n');
    fs.writeFileSync(path.join(wt, 'f2.txt'), 'new file\n');
    sh('git add -A && git commit -q -m "agent: post-merge work"', wt);
    fs.appendFileSync(path.join(wt, 'f1.txt'), 'uncommitted\n');
    fs.writeFileSync(path.join(wt, 'f3.txt'), 'untracked\n');
    sh('git fetch -q origin --prune', wt);

    const tip = (await git.revParse(wt, 'HEAD'))!;
    const baseSha = (await git.resolveBaseRef(wt, 'origin/main'))!;
    const unmerged = await git.commitsNotIn(wt, tip, [baseSha]);
    check('squash merge leaves the whole branch looking unmerged', unmerged.length === 2, `${unmerged.length}`);
    const carry = await git.commitsNotIn(wt, tip, [baseSha, mergedHead]);
    check('only post-merge commits are carried', carry.length === 1, `${carry.length}`);

    const res = await git.withStash(wt, async () => {
      const co = await git.checkoutNewBranch(wt, 'maestro/next', 'origin/main');
      return co.ok ? await git.cherryPick(wt, carry) : { ok: false, error: co.conflict };
    });
    check('replay onto the fresh branch succeeded', res.value.ok, res.value.error ?? '');
    check('uncommitted work came back', res.restore === 'restored', res.restore);
    const f1 = fs.readFileSync(path.join(wt, 'f1.txt'), 'utf8');
    check('committed post-merge work carried over', f1.includes('after the merge') && fs.existsSync(path.join(wt, 'f2.txt')), f1);
    check('uncommitted post-merge work carried over', f1.includes('uncommitted') && fs.existsSync(path.join(wt, 'f3.txt')));
    check("another dev's commit on the base survived", fs.existsSync(path.join(wt, 'other.txt')));
    const st = await git.statusSummary(wt, 'origin/main');
    check(
      'the new branch has something to open a PR for',
      st.branch === 'maestro/next' && (st.ahead > 0 || st.changedFiles > 0),
      JSON.stringify(st)
    );
    const stat = await git.diffStat(wt, 'origin/main');
    check('diff stat vs base is non-empty', stat.additions > 0, JSON.stringify(stat));

    // A branch with nothing past the merge carries nothing — the plain case.
    sh('git checkout -q feature && git reset -q --hard ' + mergedHead, wt);
    check('nothing to carry on a cleanly merged branch', (await git.commitsNotIn(wt, mergedHead, [baseSha, mergedHead])).length === 0);

    // An agent that keeps writing while the tree is parked makes the pop refuse
    // outright — the work is then only in the stash, and saying "restored" (or
    // "conflicted") would send the user looking for changes that aren't there.
    fs.appendFileSync(path.join(wt, 'f1.txt'), 'mid-flight edit\n');
    const raced = await git.withStash(wt, async () => {
      const co = await git.checkoutNewBranch(wt, 'maestro/raced', 'origin/main');
      fs.appendFileSync(path.join(wt, 'f1.txt'), 'written while parked\n'); // the agent, still going
      return co;
    });
    check(
      'a refused pop reports stranded (with the entry to recover), not restored',
      raced.restore === 'stranded' && !!raced.stashRef,
      `${raced.restore} ${raced.stashRef ?? 'no ref'}`
    );
  }

  console.log(failures === 0 ? 'E2E_ALL_PASS' : `E2E_FAILURES=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E_CRASH', e);
  process.exit(1);
});
