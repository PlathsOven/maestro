import fs from 'fs';
import os from 'os';
import path from 'path';
import { broadcast } from '../bus';
import { maestroHome } from '../env';
import { Hosts, Messages, Projects, Settings, Workspaces, now, uid } from '../db';
import { generateWorkspaceName, slugify } from '../names';
import * as git from './git';
import * as gh from './github';
import { hostById, hostForProject, hostForWorkspace, isCloudWorkspace } from '../hosts';
import { catchUpWorkspace } from './cloud';
import { readRepoSettings } from './settingsToml';
import { runSetupAndWait } from './scripts';
import { stopWorkspaceAgents, runningAgents } from './harness';
import { killWorkspacePtys } from './pty';
import { destroyPreview } from './preview';
import { unwatchPort } from './portwatch';
import { watchWorkspace, unwatchWorkspace } from './watcher';
import { ensureShadow, removeShadow } from './shadow';
import type { Attachment, CreateWorkspaceOpts, HarnessId, Project, ProjectKind, Workspace } from '../../shared/types';
import { provisionalTitle } from '../../shared/chatTitle';

function projectSlug(p: Project): string {
  return slugify(p.name);
}

function workspacesRoot(p: Project): string {
  return path.join(maestroHome(), 'workspaces', projectSlug(p));
}

async function branchOwner(): Promise<string> {
  const auth = await gh.ghAuth();
  if (auth.user) return auth.user;
  return os.userInfo().username || 'maestro';
}

// ---------- projects ----------

export function defaultParentDir(): string {
  return path.join(maestroHome(), 'repos');
}

export async function addProject(opts: {
  mode: 'local' | 'github' | 'quickstart' | 'folder';
  path?: string;
  url?: string;
  name?: string;
  parentDir?: string;
  template?: 'empty' | 'next' | 'vite';
  github?: boolean;
  initGit?: boolean;
  hostId?: string;
  /** Harness for the auto-created first workspace (folder/quickstart/remote).
   *  Defaults to the global default — set by harness chat sync so a folder project
   *  born from a Codex session gets a Codex workspace (harness-chat-sync §6.7). */
  harness?: HarnessId;
}): Promise<Project> {
  let repoPath: string;
  let name: string;
  let firstWorkspace = false;
  let kind: ProjectKind = 'git';
  const hostId: string | null = opts.hostId ?? null;
  // Inspection runs on the target host (remote folders are detected over SSH).
  const host = hostById(hostId);

  if (opts.mode === 'local') {
    if (!opts.path) throw new Error('No folder selected');
    if (!(await git.isGitRepo(opts.path))) {
      throw new Error(`${opts.path} is not a git repository`);
    }
    repoPath = await git.repoRoot(opts.path);
    name = path.basename(repoPath);
  } else if (opts.mode === 'folder') {
    // "Open project" / "Open remote folder" landed on a non-git path. `initGit` =
    // the "Initialize git here" upsell (commit the folder's current contents,
    // then treat as a normal git project). Otherwise it's a folder project: work
    // in the directory directly, no worktrees/branches/PRs.
    if (!opts.path) throw new Error('No folder selected');
    if (opts.initGit && !(await git.isGitRepo(opts.path, host))) {
      await git.initFolderRepo(opts.path, host);
    }
    if (await git.isGitRepo(opts.path, host)) {
      // A repo exists (initGit ran, or one appeared since inspectPath — TOCTOU).
      repoPath = await git.repoRoot(opts.path, host);
      name = host.path.basename(repoPath);
      kind = 'git';
    } else {
      repoPath = hostId ? opts.path : path.resolve(opts.path);
      name = host.path.basename(repoPath);
      kind = 'folder';
      firstWorkspace = true; // the single in-place workspace = the folder itself
    }
  } else if (opts.mode === 'github') {
    if (!opts.url) throw new Error('No repository URL provided');
    let url = opts.url.trim();
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
    const repoName = url
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean)
      .pop()!;
    const parent = opts.parentDir?.trim() || defaultParentDir();
    repoPath = path.join(parent, repoName);
    if (fs.existsSync(repoPath)) {
      if (!(await git.isGitRepo(repoPath))) throw new Error(`${repoPath} exists and is not a git repo`);
    } else {
      await gh.ghClone(url, repoPath);
    }
    name = repoName;
  } else {
    // Quick start: local folder + template + private GitHub repo + first workspace.
    name = opts.name?.trim() || 'my-awesome-project';
    const slug = slugify(name);
    const parent = opts.parentDir?.trim() || defaultParentDir();
    repoPath = path.join(parent, slug);
    if (fs.existsSync(repoPath)) {
      throw new Error(`${repoPath} already exists`);
    }
    const { writeTemplate } = await import('./templates');
    fs.mkdirSync(repoPath, { recursive: true });
    writeTemplate(repoPath, opts.template ?? 'empty', slug);
    await git.initQuickstartRepo(repoPath, name);

    if (opts.github !== false) {
      const auth = await gh.ghAuth();
      if (auth.authenticated) {
        // Non-fatal: the project still works locally if repo creation fails.
        await gh.repoCreateFromLocal(slug, repoPath);
      }
    }
    name = slug;
    firstWorkspace = true;
  }

  // Remote projects are always in-place with a single auto-created workspace
  // (folder or git) — mirror folder projects so the user lands directly in a chat.
  if (hostId) firstWorkspace = true;

  const existing = Projects.byPath(repoPath, hostId);
  if (existing) return existing;

  // Folder projects have no base branch; git projects detect theirs (on the host).
  const baseBranch = kind === 'git' ? await git.detectBaseBranch(repoPath, host) : null;
  // cloudHostId starts null: a brand-new project has no default yet, so its
  // auto-created first workspace stays local (kubernetes-workspaces.md §3.5).
  const project: Project = { id: uid(), name, repoPath, kind, hostId, cloudHostId: null, baseBranch, createdAt: now() };
  Projects.insert(project);

  if (firstWorkspace) {
    const harness = opts.harness ?? Settings.global().defaultHarness;
    await createWorkspace({ projectId: project.id, harness });
  }
  return project;
}

export async function removeProject(projectId: string, deleteWorkspaces: boolean) {
  const workspaces = Workspaces.forProject(projectId);
  const project = Projects.get(projectId);
  for (const ws of workspaces) {
    stopWorkspaceAgents(ws.id);
    killWorkspacePtys(ws.id);
    unwatchWorkspace(ws.id);
    destroyPreview(ws.id);
    // Never touch an in-place folder on disk (G4) — drop bookkeeping only.
    if (deleteWorkspaces && project && ws.wsKind !== 'in-place') {
      await git.worktreeRemove(project.repoPath, ws.worktreePath);
    }
    removeShadow(ws); // the shadow git-dir lives under ~/maestro, not the folder
    Workspaces.remove(ws.id);
    broadcast('ws:removed', { workspaceId: ws.id });
  }
  Projects.remove(projectId);
}

// ---------- workspaces ----------

export async function createWorkspace(opts: CreateWorkspaceOpts): Promise<Workspace> {
  const project = Projects.get(opts.projectId);
  if (!project) throw new Error('Project not found');

  // Conductor import adopts an existing directory as an in-place workspace on a
  // *local git* project (§6.3): open it as-is on its own branch, no worktree add
  // / fetch / setup. Ignored on folder & remote projects (already in-place).
  const adopt = opts.adopt && project.kind === 'git' && !project.hostId ? opts.adopt : undefined;

  // Folder projects — and all remote projects in v1 — have exactly one in-place
  // workspace (the folder/repo itself). It's auto-created when the project is
  // added; extra workspaces are refused (there's no worktree model to isolate
  // them). "New chat" (multi-agent per workspace) is the analogue of a new
  // workspace. A remote git repo (tier B) keeps its real current branch.
  const inPlace = !!adopt || project.kind === 'folder' || !!project.hostId;
  if (inPlace) {
    // A git project mixes adopted in-place and normal worktree workspaces freely
    // (each adopted dir is its own worktree with a real branch); only the single-
    // in-place folder/remote projects refuse a second workspace.
    if (!adopt && Workspaces.forProject(project.id).length > 0) {
      throw new Error('This project has a single in-place workspace — start a new chat instead.');
    }
    // Adopted branch is git-derived by the scanner (authoritative). A folder git
    // project reads the checked-out branch; a plain folder has none.
    const inPlaceBranch = adopt
      ? adopt.branch
      : project.kind === 'git'
        ? await git.currentBranch(project.repoPath, hostForProject(project)).catch(() => '')
        : '';
    const ws = newWorkspaceRow(project, opts, {
      name: opts.name?.trim()
        ? slugify(opts.name)
        : adopt
          ? slugify(path.basename(adopt.path))
          : slugify(project.name) || 'workspace',
      branch: inPlaceBranch === 'HEAD' ? '' : inPlaceBranch,
      wsKind: 'in-place',
      worktreePath: adopt ? adopt.path : project.repoPath,
    });
    return insertAndProvision(project, ws, opts);
  }

  const siblings = Workspaces.forProject(project.id).map((w) => w.name);
  const name = opts.name?.trim() ? slugify(opts.name) : generateWorkspaceName(siblings);
  if (siblings.includes(name)) throw new Error(`Workspace "${name}" already exists`);

  const owner = await branchOwner();
  const worktreePath = path.join(workspacesRoot(project), name);
  if (fs.existsSync(worktreePath)) throw new Error(`Directory already exists: ${worktreePath}`);

  const ws = newWorkspaceRow(project, opts, {
    name,
    branch: `${owner}/${name}`,
    wsKind: 'worktree',
    worktreePath,
  });
  return insertAndProvision(project, ws, opts);
}

/** Build a fresh workspace row from the fields that differ between in-place and
 *  worktree creation; everything else is a constant setup default. Calls
 *  Settings.nextPort() exactly once per creation. */
function newWorkspaceRow(
  project: Project,
  opts: CreateWorkspaceOpts,
  fields: { name: string; branch: string; wsKind: Workspace['wsKind']; worktreePath: string }
): Workspace {
  // On a managed cloud box, allocate the port inside the box's assigned block.
  const hostId = opts.hostId ?? project.hostId;
  const portBase = hostId ? Hosts.get(hostId)?.portBase : undefined;
  return {
    id: opts.id ?? uid(),
    projectId: project.id,
    name: fields.name,
    branch: fields.branch,
    wsKind: fields.wsKind,
    title: null,
    subtitle: null,
    worktreePath: fields.worktreePath,
    harness: opts.harness,
    status: 'setting-up',
    port: Settings.nextPort(portBase),
    archived: false,
    createdAt: now(),
    lastUserMessageAt: null,
    prNumber: null,
    prUrl: null,
    prState: null,
    setupError: null,
  };
}

/** Insert a freshly-built workspace, announce it, and start provisioning. */
function insertAndProvision(project: Project, ws: Workspace, opts: CreateWorkspaceOpts): Workspace {
  Workspaces.insert(ws);
  broadcast('ws:updated', ws);
  provisionAsync(project, ws, opts);
  return ws;
}

/** Kick off provisioning in the background; the row is already visible as
 *  "setting-up". On failure it flips to needs-attention with the error. */
function provisionAsync(project: Project, ws: Workspace, opts: CreateWorkspaceOpts) {
  void provisionWorkspace(project, ws, opts).catch((e) => {
    const fresh = Workspaces.get(ws.id);
    if (fresh) {
      fresh.status = 'needs-attention';
      fresh.setupError = String(e?.message ?? e);
      Workspaces.update(fresh);
      broadcast('ws:updated', fresh);
    }
  });
}

/**
 * Switch an existing workspace to a different agent harness. A chat's CLI session
 * is a resume handle only the harness that created it understands, so all sessions
 * are cleared — the next message starts fresh under the new CLI. (Per-chat model
 * ids belonging to the old harness are ignored at run time, so they need no
 * reconciliation here.)
 */
export function setWorkspaceHarness(workspaceId: string, harness: HarnessId): Workspace {
  const ws = Workspaces.get(workspaceId);
  if (!ws) throw new Error('Workspace not found');
  if (ws.harness !== harness) {
    ws.harness = harness;
    Workspaces.update(ws);
    Workspaces.clearSessions(workspaceId);
    broadcast('ws:updated', ws);
  }
  return ws;
}

/** Add `local` as this workspace's worktree branch; on the one-branch-per-worktree
 *  conflict, fall back to a fresh `<local>-2` branched off it. */
async function attachBranch(project: Project, ws: Workspace, local: string): Promise<void> {
  try {
    await git.worktreeAddExistingBranch(project.repoPath, ws.worktreePath, local);
    ws.branch = local;
  } catch (e: any) {
    if (e?.branchInUse) {
      // One branch per worktree: offer the documented fallback automatically.
      const alt = `${local}-2`;
      await git.worktreeAddNewBranch(project.repoPath, ws.worktreePath, alt, local);
      ws.branch = alt;
    } else {
      throw e;
    }
  }
}

async function provisionWorkspace(project: Project, ws: Workspace, opts: CreateWorkspaceOpts) {
  // In-place (folder) workspace = the user's own folder. Never fetch, add a
  // worktree, warn about an empty base, or run the setup script (its job is
  // restoring ignored files a fresh worktree lacks — an in-place folder already
  // has them). Just ensure .context/ and honor the first prompt. (§6.3, G4)
  if (ws.wsKind === 'in-place') {
    await git.ensureContextDir(ws.worktreePath, hostForProject(project)); // .git/info/exclude step no-ops without git
    // Baseline shadow-git checkpoint for local folder projects (§7 Phase 5) so
    // the Diff tab shows changes since the folder was opened. Best-effort.
    if (project.kind === 'folder' && !project.hostId) await ensureShadow(ws).catch(() => {});
    ws.status = 'idle';
    Workspaces.update(ws);
    broadcast('ws:updated', ws);
    watchWorkspace(ws);

    const attachments: Attachment[] = [];
    for (const a of opts.initialAttachments ?? []) {
      attachments.push({ kind: a.kind, path: await writeWorkspaceAttachment(ws, a), label: a.name });
    }
    const initialPrompt = opts.initialPrompt ?? '';
    if (initialPrompt.trim() || attachments.length) {
      const { sendChat } = await import('./chat');
      await sendChat({ workspaceId: ws.id, agentId: 1, text: initialPrompt.trim(), attachments });
    }
    return;
  }

  // Start from the latest remote state even if the local base is behind.
  await git.fetchOrigin(project.repoPath);

  // Worktree projects always have a base branch (folder projects took the branch
  // above); fall back defensively so the type narrows.
  const baseBranch = project.baseBranch ?? 'main';
  let initialPrompt = opts.initialPrompt ?? '';

  if (!opts.from) {
    await git.worktreeAddNewBranch(project.repoPath, ws.worktreePath, ws.branch, baseBranch);
  } else if (opts.from.type === 'branch') {
    const source = opts.from.ref;
    const local = source.replace(/^origin\//, '');
    await attachBranch(project, ws, local);
  } else if (opts.from.type === 'pr') {
    const prNumber = opts.from.ref;
    const prs = await gh.prList(project.repoPath);
    const pr = prs.find((p) => p.number === prNumber);
    const local = pr?.headRefName || `pr-${prNumber}`;
    try {
      await git.fetchPrHead(project.repoPath, prNumber, local);
    } catch {
      // branch may already exist locally
    }
    await attachBranch(project, ws, local);
    ws.prNumber = prNumber;
    ws.prUrl = pr?.url ?? null;
  } else if (opts.from.type === 'issue') {
    await git.worktreeAddNewBranch(project.repoPath, ws.worktreePath, ws.branch, baseBranch);
    const issue = await gh.issueView(project.repoPath, opts.from.ref);
    if (issue) {
      initialPrompt =
        `Work on GitHub issue #${opts.from.ref}: ${issue.title}\n\n${issue.body}` +
        (initialPrompt ? `\n\nAdditional context: ${initialPrompt}` : '');
    }
  } else if (opts.from.type === 'linear') {
    await git.worktreeAddNewBranch(project.repoPath, ws.worktreePath, ws.branch, baseBranch);
    const { fetchLinearIssue } = await import('./linear');
    const issue = await fetchLinearIssue(opts.from.ref);
    if (issue) {
      initialPrompt =
        `Work on Linear issue ${opts.from.ref}: ${issue.title}\n\n${issue.description}` +
        (initialPrompt ? `\n\nAdditional context: ${initialPrompt}` : '');
    }
  }

  await git.ensureContextDir(ws.worktreePath);
  ws.branch = await git.currentBranch(ws.worktreePath);
  Workspaces.update(ws);
  broadcast('ws:updated', ws);

  // A base branch with no real files usually means the code was never pushed
  // (or lives on another branch) — say so instead of letting the user find an
  // inexplicably empty workspace.
  const tracked = (await git.lsFiles(ws.worktreePath)).filter(
    (f) => f !== '.gitkeep' && !f.startsWith('.maestro/')
  );
  if (tracked.length === 0) {
    const msg = {
      id: uid(),
      workspaceId: ws.id,
      agentId: 1,
      role: 'system' as const,
      content:
        `Heads up: this workspace started from ${baseBranch}, which has no files. ` +
        `If this repo's code lives on another branch, create a workspace from that branch ` +
        `(New workspace ⋯ → From branch). If the code only exists locally, push it to ${baseBranch} first.`,
      attachments: [],
      ts: now(),
    };
    Messages.insert(msg);
    broadcast('chat:message', msg);
  }

  // Ignored files (.env, deps, local DBs) don't travel with the worktree; the
  // setup script restores them. For a cloud workspace the move runs setup on the
  // box, so skip the redundant local run here.
  const repoSettings = readRepoSettings(project.repoPath);
  if (repoSettings.setupScript.trim() && !opts.hostId) {
    const code = await runSetupAndWait(ws, repoSettings.setupScript);
    if (code !== 0) {
      ws.setupError = `Setup script exited with code ${code}`;
    }
  }

  ws.status = ws.setupError ? 'needs-attention' : 'idle';
  Workspaces.update(ws);
  broadcast('ws:updated', ws);
  watchWorkspace(ws);

  // Cloud toggle at creation (§4/§6.6): the worktree exists locally now — move it
  // to the box (mirror + bundle + remote worktree) before the first message so
  // the initial turn runs (and survives) in the cloud.
  if (opts.hostId) {
    const { setWorkspaceCloud } = await import('./cloudmove');
    await setWorkspaceCloud(ws.id, opts.hostId).catch(() => {});
  }
  const target = Workspaces.get(ws.id)!;

  // Files dropped into the branch-init chatbox couldn't be saved before the
  // worktree existed — persist them now (on the workspace's host), then send them
  // with the first message.
  const attachments: Attachment[] = [];
  for (const a of opts.initialAttachments ?? []) {
    attachments.push({ kind: a.kind, path: await writeWorkspaceAttachment(target, a), label: a.name });
  }

  if (initialPrompt.trim() || attachments.length) {
    const { sendChat } = await import('./chat');
    await sendChat({ workspaceId: ws.id, agentId: 1, text: initialPrompt.trim(), attachments });
  }
}

/** Write a chat attachment into the workspace's .context dir; returns the
 *  worktree-relative path. Shared by the branch-init flow and attachment:save. */
export async function writeWorkspaceAttachment(
  ws: Workspace,
  a: { name: string; text?: string; dataBase64?: string }
): Promise<string> {
  const host = hostForWorkspace(ws);
  const p = host.path;
  const dir = p.join(ws.worktreePath, '.context', 'attachments', uid().slice(0, 6));
  await host.fs.mkdirp(dir);
  const safe = a.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'attachment';
  const full = p.join(dir, safe);
  if (a.dataBase64 !== undefined) await host.fs.write(full, Buffer.from(a.dataBase64, 'base64'));
  else await host.fs.write(full, a.text ?? '');
  return p.relative(ws.worktreePath, full);
}

/**
 * One-time (§7): give a provisional title to every chat that never got one, or
 * that carries a persisted synthetic "Chat N" from a pre-titling build. Lossless
 * — it only fills blanks with the first user message, exactly what the rail
 * already derives. Covers archived workspaces too. Guarded by the caller via the
 * `chatTitlesV1` KV flag, so a second boot never rewrites.
 */
export function backfillChatTitles(): void {
  for (const ws of Workspaces.list()) {
    const chats = Workspaces.getChats(ws.id);
    for (const [key, meta] of Object.entries(chats)) {
      if (meta?.title && !/^Chat \d+$/.test(meta.title)) continue; // a real title — leave it
      const agentId = Number(key);
      if (!Number.isFinite(agentId)) continue;
      const first = Messages.firstUserText(ws.id, agentId);
      if (!first) continue; // nothing to derive from — stays "New chat"
      Workspaces.patchChat(ws.id, agentId, { title: provisionalTitle(first) });
    }
  }
}

export function archiveWorkspace(workspaceId: string) {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return;
  stopWorkspaceAgents(ws.id);
  killWorkspacePtys(ws.id);
  unwatchWorkspace(ws.id);
  destroyPreview(ws.id);
  unwatchPort(ws.id, 'selected');
  unwatchPort(ws.id, 'script');
  ws.archived = true;
  ws.status = 'archived';
  Workspaces.update(ws);
  broadcast('ws:updated', ws);
}

export async function restoreWorkspace(workspaceId: string): Promise<{ workspace: Workspace; warning?: string }> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) throw new Error('Workspace not found');
  const project = Projects.get(ws.projectId);
  if (!project) throw new Error('Project not found');
  // ws.hostId wins over project.hostId (src/main/hosts/index.ts) — a cloud
  // workspace of a local project resolves to the box, not this Mac.
  const host = hostForWorkspace(ws);
  let warning: string | undefined;

  if (host.id === 'local') {
    if (!fs.existsSync(ws.worktreePath)) {
      // An in-place folder that's gone was moved or deleted by the user — never
      // recreate it (there's no branch to rebuild it from). Surface the gap.
      if (ws.wsKind === 'in-place') {
        throw new Error('This folder is missing — it may have been moved or deleted.');
      }
      // Worktree was cleaned from disk; recreate it from the branch.
      await git.worktreeRemove(project.repoPath, ws.worktreePath); // prune stale registration
      try {
        await git.worktreeAddExistingBranch(project.repoPath, ws.worktreePath, ws.branch);
      } catch (e: any) {
        if (e?.branchInUse) throw new Error(`Branch ${ws.branch} is checked out in another workspace`);
        throw e;
      }
      await git.ensureContextDir(ws.worktreePath);
    }
  } else {
    // Remote: nothing was removed on archive, so restore is bookkeeping. A missing
    // directory or an unreachable host is worth a warning, not a refusal — the
    // user can still open the workspace, reconnect, or move it.
    const exists = await host.fs.exists(ws.worktreePath).catch(() => null);
    if (exists === false) warning = 'The folder on the server is missing — it may have been moved or deleted.';
  }
  ws.archived = false;
  ws.status = 'idle';
  Workspaces.update(ws);
  broadcast('ws:updated', ws);
  watchWorkspace(ws);
  if (isCloudWorkspace(ws)) void catchUpWorkspace(ws); // followers skipped it while archived (cloud.ts)
  return { workspace: ws, warning };
}

/**
 * Recreate an adopted (Conductor) in-place workspace whose directory vanished —
 * the user archived it in Conductor (`git worktree remove --force`), but the
 * branch survives and is no longer checked out anywhere. Cut a fresh Maestro
 * worktree from that branch, converting this to a normal worktree workspace so
 * its whole lifecycle (delete/restore) becomes Maestro-owned (§4/§6.3). The
 * imported chats stay, but resume context is best-effort (the transcript was
 * keyed to the old dir's path — a fresh session may result, which is fine).
 */
export async function recreateAdoptedFromBranch(
  workspaceId: string
): Promise<{ ok: boolean; error?: string; workspace?: Workspace }> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const project = Projects.get(ws.projectId);
  if (!project) return { ok: false, error: 'Project not found' };
  // Only adopted in-place workspaces on a local git project qualify (they alone
  // have a real branch to rebuild from).
  if (ws.wsKind !== 'in-place' || project.kind !== 'git' || project.hostId || !ws.branch) {
    return { ok: false, error: 'This workspace can’t be recreated from a branch.' };
  }
  if (fs.existsSync(ws.worktreePath)) {
    return { ok: false, error: 'The workspace directory still exists.' };
  }

  await git.fetchOrigin(project.repoPath); // freshen the branch before checking it out

  // A fresh Maestro-owned worktree path, unique among this project's.
  let worktreePath = path.join(workspacesRoot(project), ws.name);
  for (let i = 2; fs.existsSync(worktreePath); i++) worktreePath = path.join(workspacesRoot(project), `${ws.name}-${i}`);

  try {
    await git.worktreeAddExistingBranch(project.repoPath, worktreePath, ws.branch);
  } catch (e: any) {
    if (e?.branchInUse) return { ok: false, error: `Branch ${ws.branch} is checked out in another workspace` };
    return { ok: false, error: String(e?.message ?? e) };
  }
  await git.ensureContextDir(worktreePath);

  const fresh = Workspaces.get(workspaceId)!;
  fresh.worktreePath = worktreePath;
  fresh.wsKind = 'worktree'; // now a real Maestro worktree — full lifecycle applies
  fresh.status = 'idle';
  fresh.archived = false;
  fresh.setupError = null;
  Workspaces.update(fresh);
  broadcast('ws:updated', fresh);
  watchWorkspace(fresh);
  return { ok: true, workspace: fresh };
}

export async function deleteWorkspace(workspaceId: string) {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return;
  const project = Projects.get(ws.projectId);
  stopWorkspaceAgents(ws.id);
  killWorkspacePtys(ws.id);
  unwatchWorkspace(ws.id);
  destroyPreview(ws.id);
  unwatchPort(ws.id, 'selected');
  unwatchPort(ws.id, 'script');
  // In-place folders are the user's own directory — remove bookkeeping only (G4).
  if (project && ws.wsKind !== 'in-place') {
    await git.worktreeRemove(project.repoPath, ws.worktreePath);
  }
  removeShadow(ws); // shadow git-dir under ~/maestro (never in the user's folder)
  Workspaces.remove(ws.id);
  broadcast('ws:removed', { workspaceId: ws.id });
}

export async function switchBranch(
  workspaceId: string,
  branch: string,
  create: boolean
): Promise<{ ok: boolean; conflict?: string; workspace?: Workspace }> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) throw new Error('Workspace not found');
  const host = hostForProject(Projects.get(ws.projectId)!);
  const res = await git.checkout(ws.worktreePath, branch, create, host);
  if (!res.ok) return { ok: false, conflict: res.conflict };
  ws.branch = await git.currentBranch(ws.worktreePath, host);
  Workspaces.update(ws);
  broadcast('ws:updated', ws);
  return { ok: true, workspace: ws };
}

/**
 * "Continue" after a merged PR: keep the workspace/worktree (and its chat) but
 * move onto a brand-new branch cut from the freshly-fetched base. The merged
 * work is already in the base, so the new branch starts clean and a fresh PR can
 * be opened for the next unit of work.
 *
 * Work done *after* the merge is the whole point of continuing, so it rides
 * across: uncommitted edits are stashed over the switch, and commits the agent
 * made on the merged branch are replayed onto the new one (cutting from base
 * would otherwise leave them stranded on a branch nobody looks at, with the
 * header stuck on a disabled "Create PR" because the new branch has no diff).
 */
export async function continueOnNewBranch(
  workspaceId: string
): Promise<{
  ok: boolean;
  error?: string;
  note?: string;
  noteKind?: 'info' | 'error';
  workspace?: Workspace;
}> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const project = Projects.get(ws.projectId);
  if (!project) return { ok: false, error: 'Project not found' };
  const base = project.baseBranch;
  if (base == null) return { ok: false, error: 'Not a git repository' };
  const oldBranch = ws.branch;

  // Read the merged head *before* fetching: GitHub deletes the branch when the PR
  // merges and our fetch prunes, so origin/<branch> disappears at exactly the
  // moment we want it. It's the cheap, offline half of "what was already merged".
  let mergedHead =
    oldBranch && oldBranch !== 'HEAD'
      ? await git.revParse(ws.worktreePath, `refs/remotes/origin/${oldBranch}`)
      : null;

  // Pull the merge into the local base so the new branch (and its diff) is clean.
  await git.fetchOrigin(project.repoPath);

  // Pruned already (merged a while ago, or on GitHub rather than here)? The PR's
  // head ref is permanent, so ask origin for it.
  if (!mergedHead && ws.prNumber) mergedHead = await git.prHeadSha(project.repoPath, ws.prNumber);

  // A fresh branch name off the base, unique across the repo's branches.
  const owner = await branchOwner();
  const existing = new Set(
    (await git.listBranches(project.repoPath)).map((b) => b.name.replace(/^origin\//, ''))
  );
  const stem = `${owner}/${ws.name}`;
  let branch = stem;
  for (let i = 2; existing.has(branch); i++) branch = `${stem}-${i}`;

  // Commits the old branch has and the base doesn't. After a squash merge that's
  // *all* of them — the merged ones included, since squashing rewrites them — so
  // the merged head is what tells apart "already shipped" from "made since", and
  // only the slice past it is new work worth replaying onto the fresh branch.
  // `--is-ancestor` counts a commit as its own ancestor, so a branch with nothing
  // past the merge falls out of this as an empty carry — no special case needed.
  const tip = await git.revParse(ws.worktreePath, 'HEAD');
  const baseSha = await git.resolveBaseRef(ws.worktreePath, base);
  const known = !!tip && !!baseSha && !!mergedHead && (await git.isAncestor(ws.worktreePath, mergedHead, tip));
  const carry = known ? await git.commitsNotIn(ws.worktreePath, tip!, [baseSha!, mergedHead!]) : [];
  // Without a merged head to measure against (PR merged elsewhere and the ref long
  // since pruned, or history rewritten) every commit is ambiguous, and guessing
  // either drops work or replays what already shipped. Count what's at stake.
  const unaccounted = known || !tip || !baseSha ? [] : await git.commitsNotIn(ws.worktreePath, tip, [baseSha]);

  // Work done since the merge rides along: checkout aborts on any dirty file that
  // differs between the old branch and the base, and that work is still wanted.
  // The replay happens inside the stash window — cherry-pick needs a clean tree.
  let co: { value: git.CheckoutResult; restore: git.StashRestore; stashRef?: string };
  let replay: { ok: boolean; error?: string } = { ok: true };
  try {
    co = await git.withStash(ws.worktreePath, async () => {
      const r = await git.checkoutNewBranch(ws.worktreePath, branch, base);
      if (r.ok && carry.length) replay = await git.cherryPick(ws.worktreePath, carry);
      return r;
    });
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  if (!co.value.ok) return { ok: false, error: co.value.conflict ?? 'Could not create a new branch' };

  // Drop the merged PR association so the header returns to "Create PR" and the
  // cached (merged) PR status doesn't linger.
  gh.invalidatePrCache(ws.worktreePath);
  const fresh = Workspaces.get(workspaceId)!;
  fresh.branch = await git.currentBranch(ws.worktreePath);
  fresh.prNumber = null;
  fresh.prUrl = null;
  fresh.prState = null;
  fresh.subtitle = null;
  // Main owns the truth that "any agent running ⇒ status 'running'"; the renderer
  // drops a workspace's in-flight trace on any non-'running' ws:updated. Continuing
  // mid-run must not clobber that status, or the live agent's trace is wiped.
  fresh.status = runningAgents(workspaceId).length > 0 ? 'running' : 'idle';
  Workspaces.update(fresh);
  broadcast('ws:updated', fresh);

  // Anything the switch couldn't carry still exists — on the old branch, in the
  // stash — but the worktree looks empty, so say where it went, and say it loudly.
  const stayed = (!replay.ok && carry.length) || unaccounted.length;
  const commits = (c: number) => `${c} commit${c === 1 ? '' : 's'}`;
  const notes = [
    carry.length && replay.ok ? `Brought ${commits(carry.length)} made after the merge onto the new branch.` : '',
    !replay.ok && carry.length ? `${commits(carry.length)} made after the merge wouldn't replay cleanly — still on ${oldBranch}.` : '',
    unaccounted.length
      ? `${oldBranch} has ${commits(unaccounted.length)} the base doesn't, and which of them the merge already covered ` +
        `couldn't be determined — they stayed on ${oldBranch}.`
      : '',
    co.restore === 'conflicted' ? 'Your uncommitted changes came back with conflicts — resolve them before committing.' : '',
    co.restore === 'stranded'
      ? `Your uncommitted changes couldn't be restored (the worktree changed underneath — an agent still writing, most likely). ` +
        `They're safe in the stash: \`git stash pop ${co.stashRef ?? '<entry>'}\`.`
      : '',
  ].filter(Boolean);
  return {
    ok: true,
    workspace: fresh,
    note: notes.join(' ') || undefined,
    noteKind: stayed || co.restore === 'stranded' ? 'error' : 'info',
  };
}

export async function renameWorkspaceBranch(workspaceId: string, branch: string): Promise<Workspace> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) throw new Error('Workspace not found');
  await git.renameBranch(ws.worktreePath, branch, hostForProject(Projects.get(ws.projectId)!));
  ws.branch = branch;
  Workspaces.update(ws);
  broadcast('ws:updated', ws);
  return ws;
}
