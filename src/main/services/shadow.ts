import fs from 'fs';
import path from 'path';
import { run } from '../exec';
import { maestroHome } from '../env';
import { parseNumstat, parseUnifiedDiff } from './git';
import type { DiffFile, GitStatusSummary, Workspace, WorkspaceDiff } from '../../shared/types';

/**
 * Folder checkpoints via a *shadow* git repo (spec §7 Phase 5). A folder project
 * has no `.git`, so we keep a separate git dir under ~/maestro/shadow/<wsId>
 * whose work-tree IS the user's folder — the folder is never touched (no `.git`
 * appears in it). A checkpoint is committed at every turn boundary, which powers
 * a "changes since the last checkpoint" diff and a conservative rollback, giving
 * tier-A folders their Diff tab and an undo story without a real repo.
 *
 * v1: local folder projects only (a remote shadow git-dir is a future increment).
 * Aggressive excludes keep the shadow small; there's no size cap yet, so a folder
 * with huge binaries will make checkpoints heavy — acceptable for v1.
 */

const SHADOW_EXCLUDES = [
  '.git/',
  '.context/',
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  'target/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.log',
];

function shadowGitDir(ws: Workspace): string {
  return path.join(maestroHome(), 'shadow', ws.id);
}

/** Run git against the shadow git-dir with the folder as the work-tree. */
function sgit(ws: Workspace, args: string[], timeout = 30_000) {
  const gd = shadowGitDir(ws);
  return run('git', ['--git-dir', gd, '--work-tree', ws.worktreePath, ...args], { cwd: ws.worktreePath, timeout });
}

/** Initialize the shadow repo (idempotent). */
export async function ensureShadow(ws: Workspace): Promise<void> {
  const gd = shadowGitDir(ws);
  if (fs.existsSync(path.join(gd, 'HEAD'))) return;
  fs.mkdirSync(gd, { recursive: true });
  await run('git', ['--git-dir', gd, 'init'], { cwd: ws.worktreePath });
  await run('git', ['--git-dir', gd, 'config', 'user.email', 'shadow@maestro.app'], {});
  await run('git', ['--git-dir', gd, 'config', 'user.name', 'Maestro'], {});
  fs.mkdirSync(path.join(gd, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'info', 'exclude'), SHADOW_EXCLUDES.join('\n') + '\n');
  await checkpoint(ws, 'baseline');
}

/** Commit a checkpoint of the folder's current state to the shadow repo. */
export async function checkpoint(ws: Workspace, label: string): Promise<void> {
  const gd = shadowGitDir(ws);
  if (!fs.existsSync(path.join(gd, 'HEAD'))) {
    // First call is the init path; ensureShadow makes the baseline itself.
    if (label !== 'baseline') return ensureShadow(ws);
  }
  await sgit(ws, ['add', '-A'], 60_000);
  await sgit(ws, ['commit', '--allow-empty', '-m', label], 30_000);
}

/** Full diff of the folder vs the last checkpoint (HEAD), incl. new files. */
export async function shadowDiff(ws: Workspace): Promise<WorkspaceDiff> {
  await ensureShadow(ws);
  // Stage everything into the shadow index, then diff the index vs HEAD so new
  // files show up too. (Staging is harmless — the next checkpoint re-adds.)
  await sgit(ws, ['add', '-A'], 60_000);
  const d = await sgit(ws, ['diff', '--cached', '--no-color', '--find-renames', 'HEAD'], 60_000);
  const files: DiffFile[] = parseUnifiedDiff(d.stdout);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { base: 'last checkpoint', files };
}

/** +adds/−dels vs the last checkpoint, for the sidebar row. */
export async function shadowDiffStat(ws: Workspace): Promise<{ additions: number; deletions: number }> {
  await ensureShadow(ws);
  await sgit(ws, ['add', '-A'], 60_000);
  const r = await sgit(ws, ['diff', '--cached', '--numstat', 'HEAD'], 30_000);
  return parseNumstat(r.stdout);
}

/** A GitStatusSummary-shaped view for the Changes/Status cards (no ahead/behind). */
export async function shadowStatus(ws: Workspace): Promise<GitStatusSummary> {
  await ensureShadow(ws);
  const st = await sgit(ws, ['status', '--porcelain', '-uall'], 30_000);
  let changed = 0;
  for (const line of st.stdout.split('\n')) if (line.trim()) changed++;
  return {
    branch: '',
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: changed,
    untracked: 0,
    changedFiles: changed,
    dirty: changed > 0,
  };
}

/**
 * Conservative rollback: restore tracked files to the last checkpoint. New files
 * created since the checkpoint are left in place (we never `git clean` a user's
 * folder). Returns whether anything was restored.
 */
export async function rollbackToCheckpoint(ws: Workspace): Promise<{ ok: boolean; error?: string }> {
  const gd = shadowGitDir(ws);
  if (!fs.existsSync(path.join(gd, 'HEAD'))) return { ok: false, error: 'No checkpoints yet.' };
  const r = await sgit(ws, ['checkout', 'HEAD', '--', '.'], 60_000);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || 'Rollback failed' };
}

/** Drop the shadow repo (workspace delete). */
export function removeShadow(ws: Workspace): void {
  try {
    fs.rmSync(shadowGitDir(ws), { recursive: true, force: true });
  } catch {}
}
