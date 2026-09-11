/**
 * Live GitHub sign-in + PR pipeline verification.
 * Runs under ELECTRON_RUN_AS_NODE against the real GitHub API.
 *
 * - Starts a real device-flow session (asserts a user code is issued), then cancels it.
 * - Exercises the post-approval path with this machine's existing gh token
 *   (completeSignInWithToken → gh auth login --with-token + git credential helper).
 * - Runs the full PR pipeline end-to-end on a throwaway PRIVATE repo:
 *   create → clone via app services → workspace → commit → push → PR (agent-drafted
 *   body) → status → squash-merge → cleanup (delete; falls back to archive).
 */
import fs from 'fs';
import path from 'path';
import { resolveShellEnv } from '../src/main/env';
import { initDb, Workspaces } from '../src/main/db';
import * as git from '../src/main/services/git';
import { addProject, createWorkspace } from '../src/main/services/workspaces';
import { createPr, mergePr, refreshPr } from '../src/main/services/pr';
import { ghAuth } from '../src/main/services/github';
import {
  cancelDeviceSignIn,
  completeSignInWithToken,
  startDeviceSignIn,
} from '../src/main/services/ghauth';
import { run } from '../src/main/exec';

const ROOT = '/tmp/maestro-gh-e2e';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
}

async function main() {
  resolveShellEnv();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.MAESTRO_HOME = path.join(ROOT, 'home');
  initDb(path.join(ROOT, 'maestro.db'));

  // 1. Device flow start against the real endpoint (no approval — just the code).
  const dev = await startDeviceSignIn();
  check(
    'device flow issues a user code',
    /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(dev.userCode) && dev.verificationUri.includes('github.com'),
    `${dev.userCode} @ ${dev.verificationUri} (expires ${dev.expiresIn}s)`
  );
  cancelDeviceSignIn();

  // 2. Post-approval path with the machine's existing token — identical to what
  //    the poller does after the user authorizes in the browser.
  const tokRes = await run('gh', ['auth', 'token'], { timeout: 15_000 });
  const token = tokRes.stdout.trim();
  check('existing gh token available for harness test', tokRes.ok && token.length > 20, `len=${token.length}`);
  const auth = await completeSignInWithToken(token);
  check('completeSignIn → gh authenticated', auth.authenticated && !!auth.user, `user=@${auth.user}`);
  const helper = await run('git', ['config', '--global', '--get-all', 'credential.https://github.com.helper']);
  check(
    'git credential helper → gh (push auth)',
    helper.ok && helper.stdout.includes('auth git-credential'),
    JSON.stringify(helper.stdout.trim().split('\n'))
  );

  // 3. Full PR pipeline, live.
  const repoName = `maestro-pr-e2e-${Date.now().toString(36)}`;
  const slug = `${auth.user}/${repoName}`;
  const created = await run('gh', ['repo', 'create', repoName, '--private', '--add-readme'], { timeout: 60_000 });
  check('created private test repo', created.ok, created.ok ? slug : created.stderr.trim());
  if (!created.ok) {
    console.log(`E2E_FAILURES=${++failures}`);
    process.exit(1);
  }

  try {
    const project = await addProject({ mode: 'github', url: `https://github.com/${slug}` });
    check('cloned via gh into project', fs.existsSync(path.join(project.repoPath, 'README.md')), project.repoPath);
    check('base branch detected', /main|master/.test(project.baseBranch), project.baseBranch);

    const ws = await createWorkspace({ projectId: project.id, harness: 'claude-code' });
    await waitFor(() => Workspaces.get(ws.id)?.status === 'idle', 90_000, 'workspace provisioning');
    const w = Workspaces.get(ws.id)!;
    check('workspace provisioned', w.status === 'idle', `${w.branch} err=${w.setupError}`);

    fs.writeFileSync(
      path.join(w.worktreePath, 'maestro-test.md'),
      '# Maestro PR pipeline test\n\nOpened, checked and merged entirely by Maestro using the in-app GitHub identity.\n'
    );
    const commit = await git.commitAll(w.worktreePath, 'Add Maestro pipeline test file');
    check('committed in worktree', commit.ok, commit.error);

    const pr = await createPr(w.id, false);
    check('PR created on GitHub', pr.ok && /\/pull\/\d+$/.test(pr.url ?? ''), pr.url ?? pr.error);

    const st = await refreshPr(w.id, true);
    check('PR status OPEN via gh', st?.state === 'OPEN', `#${st?.number} ${st?.state} +${st?.additions}`);
    check('PR has agent/fallback body metadata', (st?.title ?? '').length > 4, st?.title);

    const merged = await mergePr(w.id, 'squash');
    check('PR merged (squash)', merged.ok, merged.error);

    const st2 = await refreshPr(w.id, true);
    check('PR state MERGED', st2?.state === 'MERGED', st2?.state ?? 'null');

    const after = await ghAuth(true);
    check('auth intact after pipeline', after.authenticated && after.user === auth.user);
  } finally {
    const del = await run('gh', ['repo', 'delete', slug, '--yes'], { timeout: 30_000 });
    if (del.ok) {
      console.log(`CLEANUP: test repo ${slug} deleted`);
    } else {
      const arch = await run('gh', ['repo', 'archive', slug, '--yes'], { timeout: 30_000 });
      console.log(
        arch.ok
          ? `CLEANUP: could not delete ${slug} (token lacks delete_repo scope) — archived instead: https://github.com/${slug}`
          : `CLEANUP: could not delete or archive ${slug}: ${del.stderr.trim()}`
      );
    }
  }

  console.log(failures === 0 ? 'GH_E2E_ALL_PASS' : `E2E_FAILURES=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('GH_E2E_CRASH', e);
  process.exit(1);
});
