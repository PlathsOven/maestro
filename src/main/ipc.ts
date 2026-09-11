import fs from 'fs';
import nodePath from 'path';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { run } from './exec';
import { rebuildMenu } from './bus';
import { Comments, Hosts, Messages, Projects, Scheduled, Settings, Subagents, Todos, Workspaces, mustWorkspace, mustProject, now, uid } from './db';
import * as git from './services/git';
import * as files from './services/files';
import * as jupyter from './services/jupyter';
import * as gh from './services/github';
import { cancelDeviceSignIn, signOutGitHub, startDeviceSignIn } from './services/ghauth';
import * as wsvc from './services/workspaces';
import { clearQueue, deleteChat, editQueued, editScheduledChat, removeQueued, scheduleChat, sendChat, sendQueuedNow } from './services/chat';
import { cancelScheduled, dropDueRemoteForAgent, sendScheduledNow } from './services/schedule';
import { submitAskAnswer } from './services/ask';
import { detectHarnesses, getSubUsage, runningAgents, stopAgent } from './services/harness';
import {
  detectHarnessAuth,
  repairHarnessAuth,
  startHarnessInstall,
  startHarnessLogin,
  stopHarnessInstall,
  stopHarnessLogin,
} from './services/harness/auth';
import {
  activeLogin,
  addLogin,
  harnessSupportsMultiLogin,
  labelFor,
  limitedUntil,
  loginDir,
  loginsFor,
  refreshProfiles,
  removeLogin,
  setActiveLogin,
} from './services/harness/logins';
import { readOAuthCreds } from './services/harness/claude';
import { effectiveHarnessModels, refreshCodexCatalog } from './services/harness/codex-models';
import { clearFinishedTasks, workspaceBackgroundTasks } from './services/harness/tasks';
import { installRemoteHarness, probeRemoteHarness } from './services/harness/remote';
import { createPr, mergePr, refreshPr } from './services/pr';
import { runScript, scriptEnv, scriptStatus, stopScript } from './services/scripts';
import {
  addRunScript,
  deleteRunScript,
  execRunScript,
  generateRunScripts,
  listRunScripts,
  runScriptStates,
  stopRunScript,
  updateRunScript,
} from './services/runscripts';
import { generateStatus, getStatus } from './services/status';
import {
  capturePreview,
  closePreview,
  defaultPreviewUrl,
  getConsole,
  navigatePreview,
  openPreview,
  openPreviewDevtools,
  previewElements,
  setPreviewBounds,
  setPreviewVisible,
  writeConsoleLog,
} from './services/preview';
import { watchPort, unwatchPort } from './services/portwatch';
import { computeCaps, githubOwner } from './services/capabilities';
import { hostDoctor } from './services/hostdoctor';
import * as shadow from './services/shadow';
import { hostById, hostForProject, hostForWorkspace, isCloudWorkspace } from './hosts';
import { stopCloudTurn } from './services/cloud';
import { setWorkspaceCloud } from './services/cloudmove';
import { cloudStatus, joinMaestroCloud, leaveMaestroCloud } from './services/cloudaccount';
import { listSshConfigHosts } from './hosts/ssh';
import { dropRemoteHost, remoteHostFor } from './hosts/remote';
import { addK8sCluster, forgetHostReferences, removeK8sCluster } from './services/k8shost';
import { listContexts } from './services/kube';
import { checkForUpdatesNow, installUpdate, installedUpdate, pendingUpdate } from './services/updater';
import { refinePrompt } from './services/refine';
import { sendFeedback } from './services/feedback';
import { dictationSupported, startDictation, stopDictation } from './services/stt';
import { ensurePty, getPtyBuffer, killPty, resizePty, writePty } from './services/pty';
import { readRepoSettings, writeRepoSettings } from './services/settingsToml';
import { deleteSkill, listSkills, readSkill, saveSkill } from './services/skills';
import { fetchLinearIssue } from './services/linear';
import { scanConductor, importConductor, conductorDetected } from './services/conductorImport';
import {
  detectHarnessSync,
  harnessSyncStatus,
  importHarnessSync,
  scanHarnessSync,
} from './services/harnessSync';
import { capture } from './services/analytics';
import { listContextFiles } from './services/watcher';
import * as account from './services/account';
import type { ChatMeta, HarnessId, HarnessLoginView, IpcInvokeMap, ProjectCaps } from '../shared/types';

function handle<K extends keyof IpcInvokeMap>(
  channel: K,
  fn: (payload: IpcInvokeMap[K][0]) => Promise<IpcInvokeMap[K][1]> | IpcInvokeMap[K][1]
) {
  ipcMain.handle(channel, async (_event, payload) => fn(payload));
}

/** Type + run a command in the workspace's main terminal (terminal 1 = the bare
 *  `term:<wsId>` pty; a login shell on the remote for SSH projects). Idempotent
 *  ensure so it works whether or not the terminal is already open on screen. */
function typeIntoTerminal(ws: ReturnType<typeof mustWorkspace>, text: string): void {
  const id = `term:${ws.id}`;
  ensurePty(id, { cwd: ws.worktreePath, cols: 100, rows: 30, env: scriptEnv(ws), host: hostForWorkspace(ws) });
  writePty(id, text.endsWith('\n') ? text : text + '\n');
}

/** Resolve a worktree-relative path to a local absolute path for the Files
 *  tree's "open on this device" actions. Returns null when the workspace is
 *  remote (its files can't reach the local shell) or the path escapes the tree. */
function localAbs(workspaceId: string, relPath: string): string | null {
  const ws = mustWorkspace(workspaceId);
  if (mustProject(ws.projectId).hostId) return null;
  return files.safeResolve(ws.worktreePath, relPath, hostForWorkspace(ws));
}

/** Open a path (worktree or file) in the user's IDE (defaults to `code`). */
async function openInIde(target: string): Promise<void> {
  const cmd = Settings.global().ideCommand.trim() || 'code';
  const r = await run(cmd, [target], { timeout: 15_000 });
  if (!r.ok) throw new Error(`Could not run "${cmd}": ${r.stderr.trim() || 'command failed'}`);
}

/** Open the OS terminal app rooted at `dir` (best-effort per platform). */
async function openTerminalAt(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    // Prefer Windows Terminal; fall back to a PowerShell window via cmd's start.
    const wt = await run('wt', ['-d', dir], { timeout: 10_000 });
    if (!wt.ok) {
      await run(
        'cmd',
        ['/c', 'start', 'PowerShell', 'powershell', '-NoExit', '-Command', `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`],
        { timeout: 10_000 }
      );
    }
  } else if (process.platform === 'darwin') {
    await run('open', ['-a', 'Terminal', dir], { timeout: 10_000 });
  } else {
    // Linux best-effort: whatever the desktop registered as the default terminal.
    await run('x-terminal-emulator', [], { cwd: dir, timeout: 10_000 });
  }
}

export function registerIpc(getMainWindow: () => BrowserWindow | null) {
  handle('app:init', async () => {
    // Warm the slow probes without blocking first paint.
    void gh.ghAuth();
    void detectHarnesses();
    const projects = Projects.list();
    const projectOwners: Record<string, string | null> = {};
    const projectCaps: Record<string, ProjectCaps> = {};
    await Promise.all(
      projects.map(async (p) => {
        projectOwners[p.id] = await githubOwner(p.repoPath);
        projectCaps[p.id] = await computeCaps(p);
      })
    );
    const workspaces = Workspaces.list();
    // Per-session state for every live workspace, so the sidebar's status
    // stacks are right from the first paint (not just for visited workspaces).
    const chatsMeta: Record<string, Record<string, ChatMeta>> = {};
    const runningByWs: Record<string, number[]> = {};
    for (const w of workspaces) {
      // Archived workspaces included: their sessions render in the sidebar hover
      // card and the workspaces view, and need titles too (§7). runningAgents is
      // trivially empty for them.
      chatsMeta[w.id] = Workspaces.getChats(w.id);
      runningByWs[w.id] = runningAgents(w.id);
    }
    return {
      projects,
      workspaces,
      settings: Settings.global(),
      ghAuth: { installed: true, authenticated: true, user: null },
      harnesses: [],
      platform: process.platform,
      version: app.getVersion(),
      projectOwners,
      projectCaps,
      hosts: Hosts.list(),
      chatsMeta,
      runningAgents: runningByWs,
    };
  });

  handle('harness:list', (p) => detectHarnesses(p?.force));
  handle('harness:auth', async ({ harness }) => {
    const info = (await detectHarnesses()).find((h) => h.id === harness);
    return detectHarnessAuth(harness, info);
  });
  // Every login for a harness with its usage + sign-in state — replaces
  // harness:usage (the ring reads the active login's usage from the result).
  handle('harness:logins', async ({ harness, force }) => {
    if (force) await refreshProfiles(harness);
    const list = loginsFor(harness);
    // signedIn/plan come from the per-login credential store; only harnesses
    // with credential isolation (Claude) have one — others report the default.
    const multi = harnessSupportsMultiLogin(harness);
    const logins: HarnessLoginView[] = await Promise.all(
      list.map(async (l, i): Promise<HarnessLoginView> => {
        const creds = multi ? await readOAuthCreds(loginDir(harness, l.id)) : null;
        const signedIn = !!creds && !(creds.expiresAt && creds.expiresAt < Date.now());
        return {
          id: l.id,
          label: labelFor(l, i),
          email: l.email,
          plan: creds?.subscriptionType,
          signedIn,
          limitedUntil: limitedUntil(harness, l.id),
          usage: await getSubUsage(harness, l.id),
        };
      })
    );
    return { logins, activeId: activeLogin(harness).id, rotation: Settings.global().loginRotation !== false };
  });
  handle('harness:loginAdd', ({ harness }) => {
    const login = addLogin(harness);
    const i = loginsFor(harness).findIndex((l) => l.id === login.id);
    return { id: login.id, label: labelFor(login, i), email: login.email, signedIn: false, usage: null };
  });
  handle('harness:loginRemove', ({ harness, loginId }) => removeLogin(harness, loginId));
  handle('harness:setActiveLogin', ({ harness, loginId }) => setActiveLogin(harness, loginId));
  handle('harness:repairAuth', ({ harness, loginId }) => repairHarnessAuth(harness, loginId));
  handle('harness:loginStart', ({ harness, loginId }) => startHarnessLogin(harness, loginId));
  handle('harness:loginStop', ({ harness }) => stopHarnessLogin(harness));
  handle('harness:installStart', ({ harness }) => startHarnessInstall(harness));
  handle('harness:installStop', ({ harness }) => stopHarnessInstall(harness));
  handle('harness:models', () => {
    // Kick a live Codex catalog refresh (throttled, silent on failure) so a newly
    // entitled model shows up; never block the picker on it — return what we have
    // now, and 'harness:models:updated' re-renders it if the refresh lands (§6).
    void refreshCodexCatalog();
    return effectiveHarnessModels();
  });
  handle('harness:remoteProbe', ({ workspaceId, harness, force }) => {
    const ws = mustWorkspace(workspaceId);
    // Local workspaces use the normal (local) harness detection UI; cloud
    // workspaces (SSH project OR per-conversation override) probe the box.
    const host = hostForWorkspace(ws);
    if (host.id === 'local') return null;
    return probeRemoteHarness(host, harness ?? ws.harness, force);
  });
  handle('harness:remoteList', async ({ workspaceId, force }) => {
    const ws = mustWorkspace(workspaceId);
    const host = hostForWorkspace(ws);
    if (host.id === 'local') return null;
    // `shell` is always present on the host (it's the login shell); the rest are
    // probed. probeRemoteHarness('shell') short-circuits to installed:true.
    const ids: HarnessId[] = ['claude-code', 'codex', 'cursor', 'opencode', 'kimi-code', 'grok', 'shell'];
    return Promise.all(ids.map((h) => probeRemoteHarness(host, h, force)));
  });
  // Managed one-click install. When the install lands but the CLI is signed out,
  // its headless login is typed into terminal 1 here — the renderer just reveals
  // the terminal on `needsLogin` and lets its readiness poll clear the banner.
  handle('harness:remoteInstall', async ({ workspaceId, harness }) => {
    const ws = mustWorkspace(workspaceId);
    const host = hostForWorkspace(ws);
    if (host.id === 'local') return null;
    const res = await installRemoteHarness(host, harness ?? ws.harness);
    if (res.needsLogin && res.status.loginCommand) typeIntoTerminal(ws, res.status.loginCommand);
    return res;
  });
  // Host-keyed probe/install/readiness for the shared HostConnect flow (§6.7),
  // so the picker works before any project or workspace exists.
  handle('harness:hostProbe', ({ hostId, harness, force }) => probeRemoteHarness(hostById(hostId), harness, force));
  handle('harness:hostInstall', ({ hostId, harness }) => installRemoteHarness(hostById(hostId), harness));
  handle('host:readiness', ({ hostId }) => {
    const h = remoteHostFor(hostId);
    return h ? hostDoctor(h, Hosts.get(hostId)) : { rows: [] };
  });

  // ---------- Maestro Cloud free beta ----------
  handle('cloud:status', () => cloudStatus());
  handle('cloud:join', async ({ inviteCode }) => {
    const r = await joinMaestroCloud(inviteCode);
    // Box-link the new managed host by default so its cloud chats reach the web.
    if (r.ok) void account.autoLinkBoxes().catch(() => {});
    return r;
  });
  handle('cloud:leave', () => leaveMaestroCloud());

  // ---------- Kubernetes workspaces ----------
  handle('k8s:contexts', () => listContexts());
  handle('k8s:addCluster', (opts) => addK8sCluster(opts));

  handle('dialog:pickFolder', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      message: 'Choose a git repository',
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  // ---------- auto-update ----------

  handle('update:check', () => checkForUpdatesNow());
  handle('update:pending', () => pendingUpdate());
  handle('update:installed', () => installedUpdate());
  handle('update:install', () => installUpdate());

  // ---------- projects ----------

  // Inspect a path before adding it, so the renderer can pick the right flow:
  // git repo → today's add; plain folder → the "work in folder / init git" sheet.
  handle('project:inspectPath', async ({ path: p, hostId }) => {
    const host = hostById(hostId ?? null);
    const isGit = await git.isGitRepo(p, host);
    const root = isGit ? await git.repoRoot(p, host) : p;
    const originUrl = isGit ? await git.originUrl(root, host) : null;
    const owner = isGit ? await githubOwner(root, host) : null;
    return { isGit, root, originUrl, githubOwner: owner };
  });
  handle('project:add', (payload) => wsvc.addProject(payload));
  handle('project:defaultParentDir', () => wsvc.defaultParentDir());

  // ---------- SSH hosts ----------

  handle('host:list', () => Hosts.list());
  handle('host:sshConfigHosts', () => listSshConfigHosts());
  handle('host:save', (host) => {
    const fresh: typeof host = { ...host, id: host.id || uid(), port: host.port || 22 };
    Hosts.upsert(fresh);
    // Reset any live connection so the edited config takes effect on next use.
    dropRemoteHost(fresh.id);
    // Box-link a newly saved SSH host by default (autoLinkBoxes no-ops for k8s,
    // already-linked, opted-out hosts, or when the desktop isn't web-linked).
    void account.autoLinkBoxes().catch(() => {});
    return fresh;
  });
  handle('host:remove', async ({ hostId, deleteNamespace }) => {
    // A cluster row owns objects on someone's cluster — detaching goes through
    // the guarded path (conversations home first, optional namespace teardown).
    if (Hosts.get(hostId)?.kind === 'k8s') return removeK8sCluster(hostId, !!deleteNamespace);
    forgetHostReferences(hostId);
    dropRemoteHost(hostId);
    Hosts.remove(hostId);
    return { ok: true };
  });
  handle('host:test', async ({ hostId, passphrase, acceptNewHostKey }) => {
    const cfg = Hosts.get(hostId);
    if (!cfg) return { ok: false, error: 'Host not found' };
    // If a key hasn't been pinned yet and the caller hasn't confirmed, surface a
    // confirmation prompt after probing the key. (Our hostVerifier pins on first
    // connect; acceptNewHostKey just gates whether we proceed to connect here.)
    // A cluster node needs no such confirmation: its key is read over the
    // authenticated kubectl channel at provision time, never trusted on sight.
    if (cfg.kind !== 'k8s' && !cfg.hostKeyFingerprint && !acceptNewHostKey) {
      // Probe the host key non-interactively so the UI can show the fingerprint.
      // (ssh2 pins on connect; here we just tell the UI a first-connect confirm is due.)
      return { ok: false, needsHostKeyConfirm: true };
    }
    const host = remoteHostFor(hostId);
    if (!host) return { ok: false, error: 'Host not found' };
    if (passphrase) host.setPassphrase(passphrase);
    try {
      await host.connect();
      const os = await host.exec('uname', ['-s']);
      if (!os.ok) {
        return {
          ok: false,
          error:
            "This server doesn't look like a Linux/macOS host (`uname` failed) — Windows SSH servers aren't supported yet.",
        };
      }
      const gitv = await host.exec('git', ['--version']);
      const fresh = Hosts.get(hostId);
      return {
        ok: true,
        platform: os.ok ? os.stdout.trim() : undefined,
        gitVersion: gitv.ok ? gitv.stdout.trim().replace(/^git version /, '') : null,
        fingerprint: fresh?.hostKeyFingerprint,
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  handle('host:doctor', ({ hostId }) => {
    const h = remoteHostFor(hostId);
    return h ? hostDoctor(h, Hosts.get(hostId)) : { rows: [] };
  });
  handle('host:browse', async ({ hostId, path: p }) => {
    const host = remoteHostFor(hostId);
    if (!host) return { path: p, entries: [] };
    const dir = p && p.trim() ? p : (await host.exec('sh', ['-lc', 'echo $HOME'])).stdout.trim() || '/';
    const entries = await host.fs.readdir(dir).catch(() => []);
    return { path: dir, entries: entries.filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name)) };
  });
  handle('project:capabilities', ({ projectId }) => computeCaps(mustProject(projectId)));
  handle('project:remove', ({ projectId, deleteWorkspaces }) => wsvc.removeProject(projectId, deleteWorkspaces));
  // Git/GitHub project queries return empty (not errors) for folder projects, so
  // a stale renderer can't crash them (§5.2 defense in depth).
  handle('project:branches', ({ projectId }) => {
    const p = mustProject(projectId);
    return p.kind === 'folder' ? [] : git.listBranches(p.repoPath, hostForProject(p));
  });
  handle('project:prs', ({ projectId }) => {
    const p = mustProject(projectId);
    return p.kind === 'folder' ? [] : gh.prList(p.repoPath, hostForProject(p));
  });
  handle('project:issues', ({ projectId }) => {
    const p = mustProject(projectId);
    return p.kind === 'folder' ? [] : gh.issueList(p.repoPath, hostForProject(p));
  });
  handle('project:settings:get', ({ projectId }) => readRepoSettings(mustProject(projectId).repoPath));
  handle('project:settings:set', ({ projectId, settings }) => {
    writeRepoSettings(mustProject(projectId).repoPath, settings);
  });
  handle('project:setBaseBranch', ({ projectId, baseBranch }) => {
    const p = mustProject(projectId);
    p.baseBranch = baseBranch;
    Projects.update(p);
    return p;
  });
  // Where this project's NEW conversations run (§3.5). Only meaningful for local
  // git projects — an SSH project's work already lives on its own box.
  handle('project:setCloudHost', ({ projectId, hostId }) => {
    const p = mustProject(projectId);
    if (hostId && !Hosts.get(hostId)) throw new Error('That server is no longer saved.');
    p.cloudHostId = p.hostId ? null : hostId;
    Projects.update(p);
    return p;
  });

  // ---------- workspaces ----------

  handle('workspace:create', (payload) => wsvc.createWorkspace(payload));
  handle('workspace:archive', ({ workspaceId }) => wsvc.archiveWorkspace(workspaceId));
  handle('workspace:restore', ({ workspaceId }) => wsvc.restoreWorkspace(workspaceId));
  handle('workspace:delete', ({ workspaceId }) => wsvc.deleteWorkspace(workspaceId));
  handle('workspace:renameBranch', ({ workspaceId, branch }) => wsvc.renameWorkspaceBranch(workspaceId, branch));
  handle('workspace:switchBranch', ({ workspaceId, branch, create }) => wsvc.switchBranch(workspaceId, branch, create));
  handle('workspace:continueBranch', ({ workspaceId }) => wsvc.continueOnNewBranch(workspaceId));
  handle('workspace:setHarness', ({ workspaceId, harness }) => wsvc.setWorkspaceHarness(workspaceId, harness));
  handle('workspace:setCloud', ({ workspaceId, hostId }) => setWorkspaceCloud(workspaceId, hostId));
  handle('workspace:recreateFromBranch', ({ workspaceId }) => wsvc.recreateAdoptedFromBranch(workspaceId));
  handle('workspace:dirExists', ({ workspaceId }) => fs.existsSync(mustWorkspace(workspaceId).worktreePath));
  handle('workspace:refresh', async ({ workspaceId }) => {
    const ws = mustWorkspace(workspaceId);
    const branch = await git.currentBranch(ws.worktreePath, hostForWorkspace(ws));
    if (branch && branch !== 'HEAD') ws.branch = branch;
    Workspaces.update(ws);
    return ws;
  });
  handle('workspace:openInIDE', async ({ workspaceId }) => {
    await openInIde(mustWorkspace(workspaceId).worktreePath);
  });
  handle('workspace:reveal', ({ workspaceId }) => {
    shell.openPath(mustWorkspace(workspaceId).worktreePath);
  });
  handle('workspace:openTerminalApp', ({ workspaceId }) => openTerminalAt(mustWorkspace(workspaceId).worktreePath));
  handle('workspace:contextFiles', ({ workspaceId }) => listContextFiles(mustWorkspace(workspaceId)));
  handle('workspace:openPreview', async ({ workspaceId }) => {
    const ws = mustWorkspace(workspaceId);
    try {
      const url = await defaultPreviewUrl(ws);
      await shell.openExternal(url);
      return { url };
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  });

  // ---------- integrated browser (Preview surface) ----------
  // The WebContentsView is owned by main (services/preview.ts); these handlers
  // are the renderer's control surface. The agent drives the SAME views through
  // the roleserver /preview route, so both look at one live pane (§7, §8).
  handle('preview:open', ({ workspaceId, url }) => openPreview(mustWorkspace(workspaceId).id, url));
  handle('preview:navigate', ({ workspaceId, action, url }) =>
    navigatePreview(mustWorkspace(workspaceId).id, action, url)
  );
  handle('preview:setBounds', ({ workspaceId, bounds }) => setPreviewBounds(workspaceId, bounds));
  handle('preview:setVisible', ({ workspaceId, visible }) => setPreviewVisible(workspaceId, visible));
  handle('preview:close', ({ workspaceId }) => closePreview(workspaceId));
  handle('preview:capture', ({ workspaceId, fullPage }) => capturePreview(mustWorkspace(workspaceId).id, fullPage));
  handle('preview:elements', async ({ workspaceId }) => ({ items: await previewElements(mustWorkspace(workspaceId).id) }));
  handle('preview:console', ({ workspaceId, level, clear }) => ({
    entries: getConsole(mustWorkspace(workspaceId).id, level, clear),
  }));
  handle('preview:sendConsole', ({ workspaceId, level }) => writeConsoleLog(mustWorkspace(workspaceId).id, level));
  handle('preview:devtools', ({ workspaceId }) => openPreviewDevtools(mustWorkspace(workspaceId).id));

  // Port probing for the Preview tab pulse (§5): the renderer watches the selected
  // workspace; run scripts watch themselves in main (runscripts.ts).
  handle('port:watch', ({ workspaceId }) => watchPort(mustWorkspace(workspaceId).id, 'selected'));
  handle('port:unwatch', ({ workspaceId }) => unwatchPort(workspaceId, 'selected'));

  // ---------- chat ----------

  handle('chat:list', ({ workspaceId }) => Messages.list(workspaceId));
  handle('chat:send', (payload) => sendChat(payload));
  handle('chat:stop', ({ workspaceId, agentId }) => {
    // Stop is a full halt: also drop anything queued behind the run.
    clearQueue(workspaceId, agentId);
    stopAgent(workspaceId, agentId);
    // Cloud: also kill the drain group on the box and clear its job files
    // (the local stopAgent only detaches the tail). A *due* remote row's job was
    // promoted into the queue, so it's gone from the box now too — drop its row
    // (§4.5). Future scheduled rows are a standing intent and stay.
    const ws = Workspaces.get(workspaceId);
    if (ws && isCloudWorkspace(ws))
      void stopCloudTurn(ws, agentId)
        .catch(() => {})
        .finally(() => dropDueRemoteForAgent(workspaceId, agentId));
  });
  handle('chat:queue:remove', ({ workspaceId, agentId, itemId }) => removeQueued(workspaceId, agentId, itemId));
  handle('chat:queue:edit', ({ workspaceId, agentId, itemId, text }) => editQueued(workspaceId, agentId, itemId, text));
  // Steer: stop the current turn but keep the queue (promoting this item), so the
  // run-finished hook runs this message next instead of after the turn completes.
  handle('chat:queue:sendNow', ({ workspaceId, agentId, itemId }) => sendQueuedNow(workspaceId, agentId, itemId));
  // Scheduled sends. Unlike the queue, these are persisted and survive restarts,
  // so `chat:stop` leaves *future* rows alone: a queued item is a followup to the
  // turn being stopped, a scheduled one is a standing intent about a future time.
  // (Exception: a due remote row already promoted to the box queue is dropped on
  // stop — §4.5, handled in chat:stop above.)
  handle('chat:schedule:add', (payload) => scheduleChat(payload));
  handle('chat:schedule:list', ({ workspaceId }) => Scheduled.forWorkspace(workspaceId));
  handle('chat:schedule:edit', ({ workspaceId, agentId, itemId, text }) =>
    editScheduledChat(workspaceId, agentId, itemId, text)
  );
  handle('chat:schedule:remove', ({ workspaceId, agentId, itemId }) => cancelScheduled(workspaceId, agentId, itemId));
  handle('chat:schedule:sendNow', ({ workspaceId, agentId, itemId }) => sendScheduledNow(workspaceId, agentId, itemId));
  handle('chat:tasks', ({ workspaceId }) => workspaceBackgroundTasks(workspaceId));
  handle('chat:tasks:clear', ({ workspaceId, agentId }) => clearFinishedTasks(workspaceId, agentId));
  handle('chat:running', ({ workspaceId }) => runningAgents(workspaceId));
  handle('chat:meta', ({ workspaceId }) => Workspaces.getChats(workspaceId));
  handle('chat:meta:set', ({ workspaceId, agentId, patch }) => {
    Workspaces.patchChat(workspaceId, agentId, patch);
  });
  handle('chat:markRead', ({ workspaceId, agentId }) => {
    const ts = now();
    Workspaces.patchChat(workspaceId, agentId, { lastReadAt: ts });
    // Push read state to Maestro Web so unread dots agree across devices (§6.6).
    void account.pushReadState(workspaceId, agentId, ts).catch(() => {});
  });
  handle('chat:delete', ({ workspaceId, agentId }) => deleteChat(workspaceId, agentId));

  // ---- Maestro Web account (spec mobile-web-app §6.9) ----
  handle('account:status', () => account.accountStatus());
  handle('account:linkStart', ({ deviceName }) => account.startLink(deviceName));
  handle('account:linkCancel', () => account.cancelLink());
  handle('account:signOut', () => account.signOut());
  handle('account:boxLink', ({ hostId, label, cron }) => account.linkBox(hostId, label, cron));
  handle('account:boxUnlink', ({ hostId }) => account.unlinkBox(hostId));
  handle('account:cronPreview', () => account.cronPreview());
  handle('account:setProjectSync', ({ projectId, synced }) => account.setProjectSync(projectId, synced));
  handle('account:resync', () => account.resyncAll());

  // The user answered (or dismissed) an agent's structured question — unblocks
  // the `maestro-ask` call that's holding the agent's turn open.
  handle('ask:answer', ({ askId, answers, cancelled }) => submitAskAnswer(askId, answers, cancelled));

  handle('subagent:list', ({ workspaceId, parentMessageId }) => Subagents.listForParent(workspaceId, parentMessageId));

  // ---------- git ----------

  handle('git:diff', ({ workspaceId }) => {
    const ws = mustWorkspace(workspaceId);
    const project = mustProject(ws.projectId);
    // Local folder projects diff against their shadow-git checkpoint (§7 Phase 5).
    if (project.kind === 'folder' && !project.hostId) return shadow.shadowDiff(ws);
    if (project.baseBranch == null) return { base: '', files: [] };
    return git.workspaceDiff(ws.worktreePath, project.baseBranch, hostForWorkspace(ws));
  });
  handle('git:status', ({ workspaceId }) => {
    const ws = mustWorkspace(workspaceId);
    const project = mustProject(ws.projectId);
    if (project.kind === 'folder' && !project.hostId) return shadow.shadowStatus(ws);
    if (project.baseBranch == null) {
      return { branch: '', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, changedFiles: 0, dirty: false };
    }
    return git.statusSummary(ws.worktreePath, project.baseBranch, hostForWorkspace(ws));
  });
  // Folder projects have no git index — the composer's @-file mentions fall back
  // to a bounded on-disk walk (on the project's host).
  handle('git:files', ({ workspaceId }) => {
    const ws = mustWorkspace(workspaceId);
    const project = mustProject(ws.projectId);
    const host = hostForWorkspace(ws);
    return project.kind === 'folder' ? git.walkFiles(ws.worktreePath, host) : git.lsFiles(ws.worktreePath, host);
  });
  handle('git:diffstat', ({ workspaceId }) => {
    const ws = mustWorkspace(workspaceId);
    const project = mustProject(ws.projectId);
    if (project.kind === 'folder' && !project.hostId) return shadow.shadowDiffStat(ws);
    if (project.baseBranch == null) return { additions: 0, deletions: 0 };
    return git.diffStat(ws.worktreePath, project.baseBranch, hostForWorkspace(ws));
  });
  handle('git:commit', ({ workspaceId, message }) => {
    const ws = mustWorkspace(workspaceId);
    if (mustProject(ws.projectId).kind === 'folder') return { ok: false, error: 'Not a git repository' };
    return git.commitAll(ws.worktreePath, message, hostForWorkspace(ws));
  });
  handle('workspace:revertCheckpoint', ({ workspaceId }) => {
    const ws = mustWorkspace(workspaceId);
    if (mustProject(ws.projectId).kind !== 'folder') return { ok: false, error: 'Only folder projects use checkpoints' };
    return shadow.rollbackToCheckpoint(ws);
  });

  // ---------- working-tree file browser ("All files") ----------

  handle('fs:list', ({ workspaceId, path }) => {
    const ws = mustWorkspace(workspaceId);
    return files.listDir(ws.worktreePath, path, hostForWorkspace(ws));
  });
  // Per-entry "open on this device" affordances (the Files tree's right-click menu
  // and its double-click "open"). All are local-only — a remote path can't be
  // handed to the local shell — and confined to the worktree via `localAbs`.
  handle('fs:open', ({ workspaceId, path }) => {
    const abs = localAbs(workspaceId, path);
    if (abs) void shell.openPath(abs);
  });
  handle('fs:reveal', ({ workspaceId, path }) => {
    const abs = localAbs(workspaceId, path);
    if (abs) shell.showItemInFolder(abs); // open the enclosing folder and select the entry
  });
  handle('fs:openInIDE', async ({ workspaceId, path }) => {
    const abs = localAbs(workspaceId, path);
    if (!abs) return;
    await openInIde(abs);
  });
  handle('fs:openTerminal', ({ workspaceId, path, dir }) => {
    const abs = localAbs(workspaceId, path);
    // Root the terminal at the entry if it's a directory, else its parent folder.
    if (abs) return openTerminalAt(dir ? abs : nodePath.dirname(abs));
  });
  handle('fs:absPath', ({ workspaceId, path }) => ({ path: localAbs(workspaceId, path) }));

  // ---------- in-app editor (read/stat/write a worktree file) ----------

  handle('fs:read', ({ workspaceId, path }) => files.readFile(mustWorkspace(workspaceId).worktreePath, path));
  handle('fs:stat', ({ workspaceId, path }) => files.statFile(mustWorkspace(workspaceId).worktreePath, path));
  handle('fs:write', ({ workspaceId, path, text, expectedMtimeMs, force }) =>
    files.writeFile(mustWorkspace(workspaceId).worktreePath, path, text, expectedMtimeMs, force)
  );

  // ---------- notebook kernel execution ----------

  handle('jupyter:capabilities', ({ workspaceId }) => jupyter.jupyterCapabilities(mustWorkspace(workspaceId).worktreePath));
  handle('jupyter:start', ({ workspaceId, path }) =>
    jupyter.startKernel(workspaceId, mustWorkspace(workspaceId).worktreePath, path)
  );
  handle('jupyter:execute', ({ workspaceId, path, cellId, code }) =>
    jupyter.executeCell(workspaceId, mustWorkspace(workspaceId).worktreePath, path, cellId, code)
  );
  handle('jupyter:interrupt', ({ workspaceId, path }) => jupyter.interruptKernel(workspaceId, path));
  handle('jupyter:restart', ({ workspaceId, path }) =>
    jupyter.restartKernel(workspaceId, mustWorkspace(workspaceId).worktreePath, path)
  );
  handle('jupyter:shutdown', ({ workspaceId, path }) => jupyter.shutdownKernel(workspaceId, path));
  handle('jupyter:kernelStatus', ({ workspaceId, path }) => jupyter.kernelStatus(workspaceId, path));

  // ---------- comments ----------

  handle('comment:list', ({ workspaceId }) => Comments.list(workspaceId));
  handle('comment:add', ({ workspaceId, file, line, side, body }) => {
    const c = { id: uid(), workspaceId, file, line, side, body, resolved: false, createdAt: now() };
    Comments.insert(c);
    return c;
  });
  handle('comment:resolve', ({ commentId, resolved }) => Comments.setResolved(commentId, resolved));
  handle('comment:delete', ({ commentId }) => Comments.remove(commentId));

  // ---------- todos ----------

  handle('todo:list', ({ workspaceId }) => Todos.list(workspaceId));
  handle('todo:add', ({ workspaceId, text }) => {
    const t = { id: uid(), workspaceId, text, done: false, createdAt: now() };
    Todos.insert(t);
    return t;
  });
  handle('todo:toggle', ({ todoId, done }) => Todos.setDone(todoId, done));
  handle('todo:delete', ({ todoId }) => Todos.remove(todoId));

  // ---------- scripts ----------

  handle('script:run', ({ workspaceId, kind }) => runScript(workspaceId, kind));
  handle('script:stop', ({ workspaceId, kind }) => stopScript(workspaceId, kind));
  handle('script:status', ({ workspaceId }) => scriptStatus(workspaceId));

  // ---------- run scripts (Run tab) ----------

  handle('runscript:list', ({ workspaceId }) => listRunScripts(mustWorkspace(workspaceId).id));
  handle('runscript:add', ({ workspaceId, name, kind, doc, source }) =>
    addRunScript({ workspaceId: mustWorkspace(workspaceId).id, name, kind, doc, source })
  );
  handle('runscript:update', ({ scriptId, patch }) => updateRunScript(scriptId, patch));
  handle('runscript:delete', ({ scriptId }) => deleteRunScript(scriptId));
  handle('runscript:generate', ({ workspaceId }) => generateRunScripts(mustWorkspace(workspaceId).id));
  handle('runscript:exec', ({ workspaceId, scriptId }) => execRunScript(mustWorkspace(workspaceId).id, scriptId));
  handle('runscript:stop', ({ workspaceId, scriptId }) => stopRunScript(workspaceId, scriptId));
  handle('runscript:states', ({ workspaceId }) => runScriptStates(workspaceId));

  // ---------- status digests (Status tab) ----------

  handle('status:get', (req) => getStatus(req));
  handle('status:generate', (req) => generateStatus(req));

  // Rewrite a user's prompt to be clearer and more token-efficient before it's
  // sent to the agent (weakest model of their harness). The prompt + validation
  // now live in services/refine.ts, which rejects refusals/meta-commentary so a
  // model's words never become the user's message (§3).
  handle('prompt:refine', ({ workspaceId, text }) => refinePrompt(mustWorkspace(workspaceId), text));

  // ---------- voice dictation (on-device, macOS) ----------
  // Transcript streams back on the 'dictation:*' events, keyed by sessionId.
  handle('dictation:supported', () => dictationSupported());
  handle('dictation:start', (opts) => startDictation(opts));
  handle('dictation:stop', (opts) => stopDictation(opts));

  // ---------- pty ----------

  handle('pty:ensure', ({ id, workspaceId, cols, rows }) => {
    const ws = mustWorkspace(workspaceId);
    return ensurePty(id, { cwd: ws.worktreePath, cols, rows, env: scriptEnv(ws), host: hostForWorkspace(ws) });
  });
  handle('workspace:sendToTerminal', ({ workspaceId, text }) => typeIntoTerminal(mustWorkspace(workspaceId), text));
  handle('pty:buffer', ({ id }) => getPtyBuffer(id));
  handle('pty:write', ({ id, data }) => writePty(id, data));
  handle('pty:resize', ({ id, cols, rows }) => resizePty(id, cols, rows));
  handle('pty:kill', ({ id }) => killPty(id));

  // ---------- github ----------

  handle('github:auth', () => gh.ghAuth(true));
  handle('github:repoList', () => gh.repoList());
  handle('github:signInStart', () => startDeviceSignIn());
  handle('github:signInCancel', () => cancelDeviceSignIn());
  handle('github:signOut', () => signOutGitHub());
  // PR surfaces require a git project; folder projects short-circuit (§5.2).
  handle('github:prStatus', ({ workspaceId, force }) => {
    const ws = mustWorkspace(workspaceId);
    return mustProject(ws.projectId).kind === 'folder' ? null : refreshPr(workspaceId, force);
  });
  handle('github:prCreate', ({ workspaceId, draft }) => {
    const ws = mustWorkspace(workspaceId);
    if (mustProject(ws.projectId).kind === 'folder') return { ok: false, error: 'Not a git repository' };
    return createPr(workspaceId, draft);
  });
  handle('github:prMerge', ({ workspaceId, method }) => {
    const ws = mustWorkspace(workspaceId);
    if (mustProject(ws.projectId).kind === 'folder') return { ok: false, error: 'Not a git repository' };
    return mergePr(workspaceId, method);
  });
  // Resolve-conflicts mode (docs/specs/resolve-conflicts-pr-mode.md). Read-only:
  // enumerates the would-conflict files via `git merge-tree` without touching the
  // worktree, so the agent's prompt is concrete. Folder projects short-circuit.
  handle('workspace:conflictPreflight', async ({ workspaceId }) => {
    const ws = mustWorkspace(workspaceId);
    const project = mustProject(ws.projectId);
    if (project.kind === 'folder' || project.baseBranch == null) {
      return { baseRef: '', dirty: false, behind: 0, unpushed: 0, conflictFiles: null, error: 'Not a git repository' };
    }
    const host = hostForWorkspace(ws);
    const baseRef = project.baseBranch;
    try {
      // conflictPreflight fetches origin first; run the rest after so `behind`
      // and `unpushed` reflect the just-fetched refs.
      const conflictFiles = await git.conflictPreflight(ws.worktreePath, baseRef, host);
      const status = await git.statusSummary(ws.worktreePath, baseRef, host);
      const unpushed = await git.unpushedCount(ws.worktreePath, ws.branch, host);
      return { baseRef, dirty: status.dirty, behind: status.behind, unpushed, conflictFiles };
    } catch (e: any) {
      return { baseRef, dirty: false, behind: 0, unpushed: 0, conflictFiles: null, error: String(e?.message ?? e) };
    }
  });
  handle('workspace:conflictResolveEvent', ({ phase }) => {
    capture(`pr_resolve_conflicts_${phase}`);
  });

  // ---------- skills ----------

  handle('skill:list', ({ workspaceId }) => listSkills(mustWorkspace(workspaceId)));
  handle('skill:read', ({ workspaceId, path }) => readSkill(mustWorkspace(workspaceId), path));
  handle('skill:save', ({ workspaceId, location, markdown, prevPath }) =>
    saveSkill(mustWorkspace(workspaceId), location, markdown, prevPath)
  );
  handle('skill:delete', ({ workspaceId, path }) => deleteSkill(mustWorkspace(workspaceId), path));

  // ---------- settings ----------

  handle('feedback:send', (req) => sendFeedback(req));

  handle('settings:get', () => Settings.global());
  handle('settings:set', (patch) => {
    // Finishing first-run setup is the one settings write worth a usage signal
    // (pairs with app_opened to measure the install → set-up funnel).
    if (patch.onboarded && !Settings.global().onboarded) capture('setup_completed');
    const next = Settings.setGlobal(patch);
    // A shortcut change must re-render the menu accelerators (§9). Menu.setApplicationMenu is idempotent.
    if ('shortcuts' in patch) rebuildMenu();
    return next;
  });

  // ---------- attachments / linear ----------

  handle('attachment:save', async ({ workspaceId, name, text, dataBase64 }) => {
    const ws = mustWorkspace(workspaceId);
    return { path: await wsvc.writeWorkspaceAttachment(ws, { name, text, dataBase64 }) };
  });
  handle('attachment:read', ({ workspaceId, path }) => {
    const ws = mustWorkspace(workspaceId);
    return files.readAttachment(ws.worktreePath, path, hostForWorkspace(ws));
  });

  handle('linear:issue', ({ id }) => fetchLinearIssue(id));

  // ---------- Conductor import (spec docs/specs/conductor-import.md) ----------

  handle('conductor:detect', () => conductorDetected());
  handle('conductor:scan', () => scanConductor());
  handle('conductor:import', async ({ selections }) => {
    const result = await importConductor(selections);
    // Counts only, consistent with the app's anonymous-counts analytics posture.
    capture('conductor_import', {
      projects: result.projects,
      workspaces: result.workspaces,
      chats: result.chats,
      source: result.source,
    });
    return result;
  });

  // ---------- Harness chat sync (spec docs/specs/harness-chat-sync.md) ----------

  handle('harnessSync:detect', () => detectHarnessSync());
  handle('harnessSync:scan', () => scanHarnessSync());
  handle('harnessSync:status', () => harnessSyncStatus());
  handle('harnessSync:import', async ({ sessionIds, enableSync }) => {
    const result = await importHarnessSync(sessionIds, enableSync);
    // Counts only (anonymous-counts posture).
    capture('harness_sync_import', {
      projects: result.projects,
      workspaces: result.workspaces,
      chats: result.chats,
    });
    return result;
  });
}
