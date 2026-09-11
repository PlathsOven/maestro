import { broadcast } from '../bus';
import { scriptShell } from '../env';
import { Projects, Workspaces } from '../db';
import { hostForWorkspace } from '../hosts';
import type { ExecHost } from '../hosts/types';
import { readRepoSettings } from './settingsToml';
import { ensurePty, isPtyAlive, killPty, spawnPty } from './pty';
import type { ScriptState, Workspace, WorkspaceScripts } from '../../shared/types';

/**
 * How to invoke a script body on a host. Local keeps today's exact behavior
 * (the user's login shell via scriptShell); remote POSIX hosts use `sh -lc`
 * (v1 remote targets are POSIX only), keyed off host.platform not the laptop's.
 */
function scriptCommandFor(body: string, host: ExecHost): { file: string; args: string[] } {
  if (host.id === 'local') return scriptShell(body);
  if (host.platform === 'win32') return { file: 'powershell.exe', args: ['-NoProfile', '-Command', body] };
  return { file: 'sh', args: ['-lc', body] };
}

export type ScriptKind = 'setup' | 'run' | 'spotlight';

const scriptPtyId = (workspaceId: string, kind: ScriptKind) => `script:${kind}:${workspaceId}`;

const states = new Map<string, ScriptState>(); // key `${wsId}:${kind}`

function getState(workspaceId: string, kind: ScriptKind): ScriptState {
  return states.get(`${workspaceId}:${kind}`) ?? { running: false, exitCode: null, startedAt: null };
}

function setState(workspaceId: string, kind: ScriptKind, state: ScriptState) {
  states.set(`${workspaceId}:${kind}`, state);
  broadcast('script:state', { workspaceId, kind, state });
}

export function scriptEnv(ws: Workspace): Record<string, string> {
  return {
    WORKSPACE_PORT: String(ws.port),
    MAESTRO_WORKSPACE_NAME: ws.name,
    MAESTRO_ROOT_PATH: ws.worktreePath,
    MAESTRO_BRANCH: ws.branch,
  };
}

/**
 * Runs the configured setup/run script in a pty; output is viewable in the UI.
 * 'spotlight' is the fallback mode: it runs the run script from the project's
 * main repo checkout instead of the worktree, for repos whose workspace dirs
 * can't run cleanly (missing local state, absolute paths, etc).
 */
export function runScript(workspaceId: string, kind: ScriptKind): { ok: boolean; error?: string } {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return { ok: false, error: 'workspace not found' };
  const project = Projects.get(ws.projectId);
  if (!project) return { ok: false, error: 'project not found' };
  const settings = readRepoSettings(project.repoPath);
  const script = kind === 'setup' ? settings.setupScript : settings.runScript;
  if (!script.trim()) {
    return { ok: false, error: `No ${kind === 'setup' ? 'setup' : 'run'} script configured. Add one in Settings → Repository.` };
  }
  const id = scriptPtyId(workspaceId, kind);
  if (getState(workspaceId, kind).running) {
    return { ok: false, error: `${kind} script already running` };
  }
  setState(workspaceId, kind, { running: true, exitCode: null, startedAt: Date.now() });
  const host = hostForWorkspace(ws);
  spawnPty(id, {
    cwd: kind === 'spotlight' ? project.repoPath : ws.worktreePath,
    cols: 100,
    rows: 30,
    env: scriptEnv(ws),
    command: scriptCommandFor(script, host),
    host,
    onExit: (exitCode) => {
      setState(workspaceId, kind, { running: false, exitCode, startedAt: null });
    },
  });
  return { ok: true };
}

/** Await-able setup used during workspace creation. Runs on the workspace's host
 *  when one is passed (cloud provisioning runs the setup script on the box). */
export function runSetupAndWait(ws: Workspace, script: string, timeoutMs = 15 * 60_000, host?: ExecHost): Promise<number> {
  return new Promise((resolve) => {
    const id = scriptPtyId(ws.id, 'setup');
    setState(ws.id, 'setup', { running: true, exitCode: null, startedAt: Date.now() });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        killPty(id);
        setState(ws.id, 'setup', { running: false, exitCode: 124, startedAt: null });
        resolve(124);
      }
    }, timeoutMs);
    spawnPty(id, {
      cwd: ws.worktreePath,
      cols: 100,
      rows: 30,
      env: scriptEnv(ws),
      command: host ? scriptCommandFor(script, host) : scriptShell(script),
      host,
      onExit: (exitCode) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        setState(ws.id, 'setup', { running: false, exitCode, startedAt: null });
        resolve(exitCode);
      },
    });
  });
}

export function stopScript(workspaceId: string, kind: ScriptKind) {
  const id = scriptPtyId(workspaceId, kind);
  killPty(id);
  if (getState(workspaceId, kind).running) {
    setState(workspaceId, kind, { running: false, exitCode: -1, startedAt: null });
  }
}

export function scriptStatus(workspaceId: string): WorkspaceScripts {
  // Reconcile with pty liveness in case of missed exits.
  for (const kind of ['setup', 'run', 'spotlight'] as const) {
    const st = getState(workspaceId, kind);
    if (st.running && !isPtyAlive(scriptPtyId(workspaceId, kind))) {
      setState(workspaceId, kind, { running: false, exitCode: st.exitCode ?? -1, startedAt: null });
    }
  }
  return {
    setup: getState(workspaceId, 'setup'),
    run: getState(workspaceId, 'run'),
    spotlight: getState(workspaceId, 'spotlight'),
  };
}
