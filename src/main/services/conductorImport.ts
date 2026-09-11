import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run } from '../exec';
import { Messages, Projects, Settings, Workspaces, now, uid } from '../db';
import { addProject, createWorkspace } from './workspaces';
import { isGitRepo } from './git';
import {
  findCodexRollout,
  firstPromptTitleFromFile,
  maxAgentId,
  mungePath,
  normPath,
} from './harnessFiles';
import { codexModels } from './harness/codex-models';
import { HARNESS_MODELS } from '../../shared/types';
import type {
  ConductorImportResult,
  ConductorScan,
  ConductorSelection,
  HarnessId,
} from '../../shared/types';

// Read-only importer for a Conductor install (spec docs/specs/conductor-import.md).
// It NEVER writes conductor.db, ~/conductor, or any worktree it didn't create
// (G3). The DB is another app's private, unversioned schema, so every read is
// defensive: any failure downgrades the whole scan to a filesystem+git walk (G4).

// ---------- on-disk layout ----------

// All Conductor artifacts are anchored on the user's home. MAESTRO_CONDUCTOR_HOME
// overrides that anchor — for a Conductor installed under a non-standard home,
// and (its main use) for the scanner fixture tests the spec calls for (§9).
function conductorHome(): string {
  return process.env.MAESTRO_CONDUCTOR_HOME || os.homedir();
}

function conductorDbPath(): string {
  // macOS-only app; on other platforms this simply won't exist → detected:false.
  return path.join(conductorHome(), 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');
}
function conductorWorkspacesRoot(): string {
  return path.join(conductorHome(), 'conductor', 'workspaces');
}
function claudeProjectsRoot(): string {
  return path.join(conductorHome(), '.claude', 'projects');
}
function codexSessionsRoot(): string {
  return path.join(conductorHome(), '.codex', 'sessions');
}

/** Conductor's map claude→Maestro's claude-code, codex→codex. Unknown types
 *  (future agents) return null and are skipped. */
function mapAgentType(t: string | null | undefined): HarnessId | null {
  if (t === 'claude') return 'claude-code';
  if (t === 'codex') return 'codex';
  return null;
}

/** ISO-8601 datetime string (Conductor's created_at/updated_at) → epoch ms. */
function parseTs(s: unknown): number {
  if (typeof s !== 'string') return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// ---------- detection ----------

/** Cheap presence check: Conductor is "present" if its DB file exists. The app
 *  bundle and ~/conductor are corroborating signals surfaced in copy only. */
export function conductorDetected(): boolean {
  try {
    return fs.existsSync(conductorDbPath());
  } catch {
    return false;
  }
}

// ---------- git worktree authority ----------

/** `git worktree list --porcelain` at a repo root → { normalized path → short
 *  branch }. This is the authority for liveness (a dir must be registered) and
 *  for branch names (the DB column lags — Conductor renames branches, §2). */
async function worktreeBranchMap(repoRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const r = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, timeout: 15_000 });
  if (!r.ok) return map;
  let curPath: string | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      curPath = normPath(line.slice('worktree '.length).trim());
      map.set(curPath, ''); // default: detached until a branch line arrives
    } else if (line.startsWith('branch ') && curPath) {
      map.set(curPath, line.slice('branch '.length).trim().replace(/^refs\/heads\//, ''));
    } else if (line.trim() === '') {
      curPath = null;
    }
  }
  return map;
}

// ---------- transcript verification ----------

/** Does the resumable transcript for this session actually exist on disk? A DB
 *  row without its transcript can't be resumed (verified: some don't). */
function claudeTranscriptExists(worktreePath: string, sessionId: string): boolean {
  try {
    return fs.existsSync(path.join(claudeProjectsRoot(), mungePath(worktreePath), `${sessionId}.jsonl`));
  } catch {
    return false;
  }
}

/** Codex names its rollouts `rollout-<ts>-<sessionId>.jsonl`, bucketed by date.
 *  Bounded walk of ~/.codex/sessions for a file ending in the session id. */
function codexTranscriptExists(sessionId: string): boolean {
  return !!findCodexRollout(codexSessionsRoot(), sessionId);
}

function transcriptExists(harness: HarnessId, worktreePath: string, sessionId: string): boolean {
  return harness === 'codex' ? codexTranscriptExists(sessionId) : claudeTranscriptExists(worktreePath, sessionId);
}

/** First real user prompt from a Claude transcript, for a title when Conductor
 *  has none. Skips the injected Conductor/Maestro preambles and tool-result
 *  turns so the title is the user's actual first ask. */
function firstPromptTitle(worktreePath: string, sessionId: string): string | null {
  return firstPromptTitleFromFile(path.join(claudeProjectsRoot(), mungePath(worktreePath), `${sessionId}.jsonl`));
}

// ---------- internal scan model ----------
// Richer than the public ConductorScan: carries the session rows the importer
// needs. scan() builds it; the IPC layer projects it to counts (toPublicScan).

interface ScannedSession {
  sessionId: string;
  harness: HarnessId;
  title: string | null;
  model: string | null;
  updatedAt: number;
}
interface ScannedWorkspace {
  name: string;
  branch: string;
  path: string;
  sessions: ScannedSession[]; // newest-first, capped
  lastActivityAt: number;
}
interface ScannedProject {
  key: string;
  name: string;
  repoPath: string;
  remoteUrl: string | null;
  missing: boolean;
  lastActivityAt: number | null;
  workspaces: ScannedWorkspace[];
}
interface ScanModel {
  detected: boolean;
  source: 'db' | 'fs';
  projects: ScannedProject[];
}

const SESSIONS_PER_WORKSPACE = 5;

// ---------- primary source: conductor.db (read-only) ----------

interface RepoRow {
  id: string;
  name: string | null;
  root_path: string | null;
  remote_url: string | null;
}
interface WsRow {
  id: string;
  directory_name: string | null;
  workspace_path: string | null;
  branch: string | null;
  updated_at: string | null;
}
interface SessionRow {
  claude_session_id: string | null;
  agent_type: string | null;
  title: string | null;
  model: string | null;
  updated_at: string | null;
}

async function scanViaDb(): Promise<ScanModel | null> {
  let db: Database.Database;
  try {
    db = new Database(conductorDbPath(), { readonly: true, fileMustExist: true, timeout: 250 });
  } catch {
    return null; // open error / SQLITE_BUSY past the timeout / WAL corner → fs fallback
  }
  try {
    // Explicit column lists (never *) so a dropped/renamed column throws here and
    // downgrades to fs, rather than yielding a half-broken scan.
    const repos = db
      .prepare(
        `SELECT id, name, root_path, remote_url FROM repos
         WHERE COALESCE(hidden, 0) = 0
         ORDER BY COALESCE(display_order, 0) ASC, name ASC`
      )
      .all() as RepoRow[];
    const wsStmt = db.prepare(
      `SELECT id, directory_name, workspace_path, branch, updated_at FROM workspaces
       WHERE repository_id = ? AND COALESCE(state, '') != 'archived'`
    );
    const sesStmt = db.prepare(
      `SELECT claude_session_id, agent_type, title, model, updated_at FROM sessions
       WHERE workspace_id = ? AND COALESCE(is_hidden, 0) = 0 AND claude_session_id IS NOT NULL
       ORDER BY updated_at DESC LIMIT ?`
    );

    const projects = await Promise.all(
      repos.map(async (repo): Promise<ScannedProject> => {
        const repoPath = repo.root_path ? normPath(repo.root_path) : '';
        const name = repo.name?.trim() || (repoPath ? path.basename(repoPath) : 'repo');
        const base: ScannedProject = {
          key: repo.id,
          name,
          repoPath,
          remoteUrl: repo.remote_url?.trim() || null,
          missing: true,
          lastActivityAt: null,
          workspaces: [],
        };
        if (!repoPath || !fs.existsSync(repoPath) || !(await isGitRepo(repoPath))) return base;
        base.missing = false;

        const wtMap = await worktreeBranchMap(repoPath); // one invocation per repo, reused below
        const wsRows = wsStmt.all(repo.id) as WsRow[];
        for (const w of wsRows) {
          // The workspace dir is the first of the absolute path column / the
          // conventional ~/conductor/workspaces/<repo>/<dir> that exists.
          const candidates = [
            w.workspace_path,
            w.directory_name ? path.join(conductorWorkspacesRoot(), name, w.directory_name) : null,
          ].filter((c): c is string => !!c);
          const dir = candidates.map(normPath).find((c) => fs.existsSync(c));
          if (!dir || !wtMap.has(dir)) continue; // archive husk / unregistered dir — drop it

          const sessions: ScannedSession[] = [];
          for (const s of sesStmt.all(w.id, SESSIONS_PER_WORKSPACE) as SessionRow[]) {
            const harness = mapAgentType(s.agent_type);
            if (!harness || !s.claude_session_id) continue;
            sessions.push({
              sessionId: s.claude_session_id,
              harness,
              title: s.title?.trim() && s.title.trim() !== 'Untitled' ? s.title.trim() : null,
              model: s.model?.trim() || null,
              updatedAt: parseTs(s.updated_at),
            });
          }
          const lastActivityAt = Math.max(
            parseTs(w.updated_at),
            ...sessions.map((s) => s.updatedAt),
            0
          );
          base.workspaces.push({
            name: w.directory_name || path.basename(dir),
            branch: wtMap.get(dir) || w.branch?.trim() || '',
            path: dir,
            sessions,
            lastActivityAt,
          });
        }
        base.workspaces.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        base.lastActivityAt = base.workspaces.reduce<number | null>(
          (max, w) => (max == null ? w.lastActivityAt : Math.max(max, w.lastActivityAt)) || null,
          null
        );
        return base;
      })
    );
    return { detected: true, source: 'db', projects };
  } catch (e) {
    // Missing table/column (schema drift) or any query failure → fs fallback (G4).
    console.warn('[conductorImport] DB scan failed, falling back to filesystem:', (e as Error)?.message);
    return null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

// ---------- fallback source: filesystem + git ----------

/** Newest Claude transcripts under a worktree's munged dir → ScannedSessions.
 *  Titles come from the transcript itself (no DB); model unknown. */
function fsSessionsForWorkspace(worktreePath: string): ScannedSession[] {
  const dir = path.join(claudeProjectsRoot(), mungePath(worktreePath));
  let files: { id: string; mtime: number }[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(dir, f)).mtimeMs;
        } catch {}
        return { id: f.replace(/\.jsonl$/, ''), mtime };
      });
  } catch {
    return [];
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, SESSIONS_PER_WORKSPACE).map((f) => ({
    sessionId: f.id,
    harness: 'claude-code' as HarnessId,
    title: firstPromptTitle(worktreePath, f.id),
    model: null,
    updatedAt: f.mtime,
  }));
}

async function scanViaFs(): Promise<ScanModel> {
  const root = conductorWorkspacesRoot();
  let groups: string[];
  try {
    groups = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { detected: conductorDetected(), source: 'fs', projects: [] };
  }

  // Collect every candidate workspace dir, resolve each to its repo root, and
  // keep only dirs registered in that repo's worktree list (drops husks).
  const wtMapCache = new Map<string, Map<string, string>>();
  const byRepo = new Map<string, ScannedProject>();

  for (const group of groups) {
    const groupDir = path.join(root, group);
    let subdirs: string[];
    try {
      subdirs = fs.readdirSync(groupDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const sub of subdirs) {
      const wsDir = normPath(path.join(groupDir, sub));
      // Resolve the shared git dir → repo root (dirname of the common .git).
      const common = await run('git', ['rev-parse', '--git-common-dir'], { cwd: wsDir });
      if (!common.ok) continue;
      let commonDir = common.stdout.trim();
      if (!path.isAbsolute(commonDir)) commonDir = path.resolve(wsDir, commonDir);
      const repoRoot = normPath(path.dirname(commonDir));

      let wtMap = wtMapCache.get(repoRoot);
      if (!wtMap) {
        wtMap = await worktreeBranchMap(repoRoot);
        wtMapCache.set(repoRoot, wtMap);
      }
      if (!wtMap.has(wsDir)) continue; // not a registered worktree — husk

      let proj = byRepo.get(repoRoot);
      if (!proj) {
        const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
        proj = {
          key: repoRoot,
          name: path.basename(repoRoot),
          repoPath: repoRoot,
          remoteUrl: remote.ok ? remote.stdout.trim() || null : null,
          missing: false,
          lastActivityAt: null,
          workspaces: [],
        };
        byRepo.set(repoRoot, proj);
      }
      const sessions = fsSessionsForWorkspace(wsDir);
      let mtime = 0;
      try {
        mtime = fs.statSync(wsDir).mtimeMs;
      } catch {}
      const lastActivityAt = Math.max(mtime, ...sessions.map((s) => s.updatedAt), 0);
      proj.workspaces.push({ name: sub, branch: wtMap.get(wsDir) || '', path: wsDir, sessions, lastActivityAt });
    }
  }

  const projects = [...byRepo.values()];
  for (const p of projects) {
    p.workspaces.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    p.lastActivityAt = p.workspaces.reduce<number | null>(
      (max, w) => (max == null ? w.lastActivityAt : Math.max(max, w.lastActivityAt)) || null,
      null
    );
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return { detected: conductorDetected(), source: 'fs', projects };
}

// ---------- public scan ----------

async function scan(): Promise<ScanModel> {
  if (!conductorDetected()) return { detected: false, source: 'db', projects: [] };
  return (await scanViaDb()) ?? (await scanViaFs());
}

/** Project the internal model to the renderer contract (counts only). Marks
 *  rows/workspaces already present in Maestro so the panel can disable them. */
function toPublicScan(model: ScanModel): ConductorScan {
  const maestroPaths = new Set(Workspaces.list().map((w) => normPath(w.worktreePath)));
  return {
    detected: model.detected,
    source: model.source,
    projects: model.projects.map((p) => ({
      key: p.key,
      name: p.name,
      repoPath: p.repoPath,
      remoteUrl: p.remoteUrl,
      missing: p.missing,
      alreadyImported: !!Projects.byPath(p.repoPath, null),
      lastActivityAt: p.lastActivityAt,
      workspaces: p.workspaces.map((w) => ({
        name: w.name,
        branch: w.branch,
        path: w.path,
        sessionCount: w.sessions.length,
        alreadyImported: maestroPaths.has(normPath(w.path)),
      })),
    })),
  };
}

export async function scanConductor(): Promise<ConductorScan> {
  return toPublicScan(await scan());
}

// ---------- import ----------

/** The workspace's single harness is set by its newest session's agent type;
 *  sessions of the other harness are skipped (workspaces are single-harness). */
function chooseHarness(ws: ScannedWorkspace): HarnessId | null {
  return ws.sessions[0]?.harness ?? null;
}

/** Valid model ids for a harness, so a Conductor model id is only carried over
 *  when it exactly matches one Maestro offers (else the CLI default is used). */
function isKnownModel(harness: HarnessId, model: string): boolean {
  const list = harness === 'codex' ? codexModels() : HARNESS_MODELS[harness] ?? [];
  return list.some((m) => m.id === model);
}

const IMPORT_MARKER = 'Imported from Conductor · the agent remembers this conversation. Send a message to continue.';

/** Adopt a workspace's verified sessions as resumable chats (§6.4). Oldest→newest
 *  so the newest lands on the highest agentId (the one focused on open). */
function importSessions(
  workspaceId: string,
  worktreePath: string,
  wsHarness: HarnessId,
  ws: ScannedWorkspace,
  skipped: ConductorImportResult['skipped']
): number {
  const existingSessionIds = new Set(Object.values(Workspaces.getSessions(workspaceId)));
  let nextAgent = maxAgentId(workspaceId);
  let created = 0;
  // Newest-first was capped by the scanner; assign ids oldest→newest.
  for (const s of [...ws.sessions].reverse()) {
    const label = s.title || s.sessionId.slice(0, 8);
    if (s.harness !== wsHarness) {
      skipped.push({ what: 'session', name: label, reason: `${s.harness} session in a ${wsHarness} workspace` });
      continue;
    }
    if (existingSessionIds.has(s.sessionId)) continue; // already imported
    if (!transcriptExists(wsHarness, worktreePath, s.sessionId)) {
      skipped.push({ what: 'session', name: label, reason: 'transcript not found on disk' });
      continue;
    }
    const agentId = ++nextAgent;
    const title = s.title || firstPromptTitle(worktreePath, s.sessionId) || 'Imported chat';
    const model = s.model && isKnownModel(wsHarness, s.model) ? s.model : undefined;
    // Pin the title (titleCustom) so the session-status headline doesn't overwrite
    // Conductor's, and seat the resume id so the next turn issues --resume <id>.
    Workspaces.patchChat(workspaceId, agentId, { title, titleCustom: true, ...(model ? { model } : {}) });
    Workspaces.setSession(workspaceId, agentId, s.sessionId);
    Messages.insert({
      id: uid(),
      workspaceId,
      agentId,
      role: 'system',
      content: IMPORT_MARKER,
      attachments: [],
      ts: now(),
    });
    existingSessionIds.add(s.sessionId);
    created++;
  }
  return created;
}

export async function importConductor(selections: ConductorSelection[]): Promise<ConductorImportResult> {
  // Re-scan from fresh truth rather than trusting renderer-passed previews — the
  // scan is cheap and this keeps import correct and idempotent (G5).
  const model = await scan();
  const result: ConductorImportResult = {
    projects: 0,
    workspaces: 0,
    chats: 0,
    source: model.source,
    focusWorkspaceId: null,
    skipped: [],
  };
  const byKey = new Map(model.projects.map((p) => [p.key, p]));
  const defaultHarness = Settings.global().defaultHarness;
  let focusActivity = -1;

  for (const sel of selections) {
    const preview = byKey.get(sel.key);
    if (!preview) {
      result.skipped.push({ what: 'repo', name: sel.key, reason: 'no longer found in Conductor' });
      continue;
    }
    if (preview.missing) {
      result.skipped.push({ what: 'repo', name: preview.name, reason: 'folder missing' });
      continue;
    }

    // Repo → git project (dedupes by repoPath inside addProject).
    const existed = !!Projects.byPath(preview.repoPath, null);
    let project;
    try {
      project = await addProject({ mode: 'local', path: preview.repoPath });
    } catch (e) {
      result.skipped.push({ what: 'repo', name: preview.name, reason: String((e as Error)?.message ?? e) });
      continue;
    }
    if (!existed) result.projects++;

    // Which of the repo's live workspaces to adopt (omitted selection = all).
    const wanted = sel.workspaceNames
      ? preview.workspaces.filter((w) => sel.workspaceNames!.includes(w.name))
      : preview.workspaces;

    for (const wp of wanted) {
      let ws = Workspaces.byWorktreePath(project.id, wp.path);
      if (!ws) {
        if (!fs.existsSync(wp.path)) {
          result.skipped.push({ what: 'workspace', name: wp.name, reason: 'folder missing' });
          continue;
        }
        const harness = chooseHarness(wp) ?? defaultHarness;
        try {
          ws = await createWorkspace({
            projectId: project.id,
            harness,
            name: wp.name,
            adopt: { path: wp.path, branch: wp.branch },
          });
        } catch (e) {
          result.skipped.push({ what: 'workspace', name: wp.name, reason: String((e as Error)?.message ?? e) });
          continue;
        }
        result.workspaces++;
      }
      result.chats += importSessions(ws.id, ws.worktreePath, ws.harness, wp, result.skipped);

      if (wp.lastActivityAt > focusActivity) {
        focusActivity = wp.lastActivityAt;
        result.focusWorkspaceId = ws.id;
      }
    }
  }
  return result;
}
