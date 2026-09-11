import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { broadcast } from './bus';
import type {
  Attachment,
  ChatMessage,
  ChatMeta,
  DiffComment,
  GlobalSettings,
  HarnessId,
  K8sConfig,
  Project,
  QueuedMessage,
  RunScript,
  ScheduledMessage,
  StatusReport,
  SubagentRun,
  Todo,
  SshHostConfig,
  Workspace,
  WorkspaceStatus,
} from '../shared/types';
import { DEFAULT_EFFORT, DEFAULT_COMPLETION_SOUND } from '../shared/types';

let db: Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repoPath TEXT NOT NULL,
  baseBranch TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'git',
  hostId TEXT,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  wsKind TEXT NOT NULL DEFAULT 'worktree',
  worktreePath TEXT NOT NULL,
  harness TEXT NOT NULL,
  status TEXT NOT NULL,
  port INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  lastUserMessageAt INTEGER,
  prNumber INTEGER,
  prUrl TEXT,
  setupError TEXT,
  sessionsJson TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  agentId INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  attachmentsJson TEXT NOT NULL DEFAULT '[]',
  metaJson TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_ws ON messages(workspaceId, ts);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  side TEXT NOT NULL,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_scripts (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  doc TEXT NOT NULL,
  source TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_scripts_ws ON run_scripts(workspaceId, createdAt);
CREATE TABLE IF NOT EXISTS status_reports (
  key TEXT PRIMARY KEY,
  dataJson TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  generatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subagent_runs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  parentAgentId INTEGER NOT NULL,
  parentMessageId TEXT NOT NULL,
  role TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  prompt TEXT NOT NULL,
  blocksJson TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  error TEXT,
  costUsd REAL,
  durationMs INTEGER,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subagents_parent ON subagent_runs(workspaceId, parentMessageId, ts);
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  agentId INTEGER NOT NULL,
  text TEXT NOT NULL,
  attachmentsJson TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'at',
  deliverAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(deliverAt);
CREATE TABLE IF NOT EXISTS queued_messages (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  agentId INTEGER NOT NULL,
  turnId TEXT NOT NULL,
  text TEXT NOT NULL,
  attachmentsJson TEXT NOT NULL DEFAULT '[]',
  seq INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queued_chat ON queued_messages(workspaceId, agentId, seq);
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  user TEXT NOT NULL,
  auth TEXT NOT NULL DEFAULT 'agent',
  keyPath TEXT,
  hostKeyFingerprint TEXT,
  jumpFingerprints TEXT
);
`;

export function initDb(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Run scripts went project-scoped → workspace-scoped before ever shipping;
  // rebuild any old-shape table (SCHEMA below recreates it empty).
  try {
    db.prepare('SELECT workspaceId FROM run_scripts LIMIT 1').get();
  } catch {
    db.exec('DROP TABLE IF EXISTS run_scripts');
  }
  db.exec(SCHEMA);
  // Lightweight migrations for columns added after first release.
  for (const stmt of [
    "ALTER TABLE workspaces ADD COLUMN chatsJson TEXT NOT NULL DEFAULT '{}'",
    'ALTER TABLE workspaces ADD COLUMN title TEXT',
    'ALTER TABLE workspaces ADD COLUMN subtitle TEXT',
    'ALTER TABLE workspaces ADD COLUMN prState TEXT',
    // Folder & remote projects: project kind + host, in-place vs worktree.
    "ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'git'",
    'ALTER TABLE projects ADD COLUMN hostId TEXT',
    "ALTER TABLE workspaces ADD COLUMN wsKind TEXT NOT NULL DEFAULT 'worktree'",
    // ProxyJump support: per-hop TOFU pins on the destination host's row.
    'ALTER TABLE hosts ADD COLUMN jumpFingerprints TEXT',
    // Cloud continuation: per-conversation cloud override (spec §6.1). Null =
    // inherit the project's host (today's behavior).
    'ALTER TABLE workspaces ADD COLUMN hostId TEXT',
    // Maestro Cloud free beta: managed host + its assigned port block.
    'ALTER TABLE hosts ADD COLUMN managed INTEGER',
    'ALTER TABLE hosts ADD COLUMN portBase INTEGER',
    // Kubernetes workspaces (§3.1): a host row's kind + its cluster config, and
    // the per-project default host for new conversations (null = local worktrees,
    // which is what every existing project gets).
    "ALTER TABLE hosts ADD COLUMN kind TEXT NOT NULL DEFAULT 'ssh'",
    'ALTER TABLE hosts ADD COLUMN k8sJson TEXT',
    'ALTER TABLE projects ADD COLUMN cloudHostId TEXT',
    // Remote (box-side) scheduling (§4): null ⇒ the local timer delivers (today's
    // behaviour); non-null ⇒ the box owns delivery, and the value is the turnId
    // baked into the scheduled job file, which is how the follower recognises the
    // fired turn.
    'ALTER TABLE scheduled_messages ADD COLUMN remoteTurnId TEXT',
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // column already exists
    }
  }
  // One-time: earlier builds defaulted to acceptEdits, which made agents hit
  // unanswerable permission prompts in non-interactive runs.
  if (!Settings.raw('permsV2')) {
    if (Settings.global().permissionMode === 'acceptEdits') {
      Settings.setGlobal({ permissionMode: 'bypassPermissions' });
    }
    Settings.setRaw('permsV2', '1');
  }
  // A DB with projects but no recorded onboarding decision belongs to an
  // install that pre-dates the setup wizard (or a seeded demo DB) — that user
  // is already set up, so never greet them with first-run setup.
  const storedGlobal = safeJson<Partial<GlobalSettings>>(Settings.raw('global') ?? '', {});
  if (storedGlobal.onboarded === undefined) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
    if (n > 0) Settings.setGlobal({ onboarded: true });
  }
}

export const uid = () => randomUUID();
export const now = () => Date.now();

// ---------- row mappers ----------

function rowToProject(r: any): Project {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repoPath,
    // '' is the folder-project sentinel (the column is NOT NULL); map it to null
    // so `baseBranch == null ⇔ folder project` holds across the app.
    baseBranch: r.baseBranch || null,
    kind: r.kind === 'folder' ? 'folder' : 'git',
    hostId: r.hostId ?? null,
    cloudHostId: r.cloudHostId ?? null,
    createdAt: r.createdAt,
  };
}

function rowToWorkspace(r: any): Workspace {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    hostId: r.hostId ?? null,
    branch: r.branch,
    wsKind: r.wsKind === 'in-place' ? 'in-place' : 'worktree',
    title: r.title ?? null,
    subtitle: r.subtitle ?? null,
    worktreePath: r.worktreePath,
    harness: r.harness as HarnessId,
    status: r.status as WorkspaceStatus,
    port: r.port,
    archived: !!r.archived,
    createdAt: r.createdAt,
    lastUserMessageAt: r.lastUserMessageAt ?? null,
    prNumber: r.prNumber ?? null,
    prUrl: r.prUrl ?? null,
    prState: r.prState ?? null,
    setupError: r.setupError ?? null,
  };
}

function rowToMessage(r: any): ChatMessage {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    agentId: r.agentId,
    role: r.role,
    content: r.content,
    attachments: safeJson(r.attachmentsJson, [] as Attachment[]),
    ts: r.ts,
    meta: r.metaJson ? safeJson(r.metaJson, undefined) : undefined,
  };
}

function rowToComment(r: any): DiffComment {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    file: r.file,
    line: r.line,
    side: r.side,
    body: r.body,
    resolved: !!r.resolved,
    createdAt: r.createdAt,
  };
}

function rowToTodo(r: any): Todo {
  return { id: r.id, workspaceId: r.workspaceId, text: r.text, done: !!r.done, createdAt: r.createdAt };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// ---------- projects ----------

export const Projects = {
  list(): Project[] {
    return db.prepare('SELECT * FROM projects ORDER BY createdAt ASC').all().map(rowToProject);
  },
  get(id: string): Project | null {
    const r = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    return r ? rowToProject(r) : null;
  },
  byPath(repoPath: string, hostId: string | null = null): Project | null {
    const r = hostId
      ? db.prepare('SELECT * FROM projects WHERE repoPath=? AND hostId=?').get(repoPath, hostId)
      : db.prepare('SELECT * FROM projects WHERE repoPath=? AND hostId IS NULL').get(repoPath);
    return r ? rowToProject(r) : null;
  },
  insert(p: Project) {
    db.prepare(
      'INSERT INTO projects (id,name,repoPath,baseBranch,kind,hostId,cloudHostId,createdAt) VALUES (@id,@name,@repoPath,@baseBranch,@kind,@hostId,@cloudHostId,@createdAt)'
    ).run({ ...p, baseBranch: p.baseBranch ?? '', hostId: p.hostId ?? null, cloudHostId: p.cloudHostId ?? null });
  },
  update(p: Project) {
    db.prepare(
      'UPDATE projects SET name=@name, repoPath=@repoPath, baseBranch=@baseBranch, kind=@kind, hostId=@hostId, cloudHostId=@cloudHostId WHERE id=@id'
    ).run({ ...p, baseBranch: p.baseBranch ?? '', hostId: p.hostId ?? null, cloudHostId: p.cloudHostId ?? null });
  },
  remove(id: string) {
    db.prepare('DELETE FROM projects WHERE id=?').run(id);
    db.prepare('DELETE FROM status_reports WHERE key=?').run(`project:${id}`);
  },
};

// ---------- workspaces ----------

export const Workspaces = {
  list(): Workspace[] {
    return db.prepare('SELECT * FROM workspaces ORDER BY createdAt ASC').all().map(rowToWorkspace);
  },
  forProject(projectId: string): Workspace[] {
    return db
      .prepare('SELECT * FROM workspaces WHERE projectId=? ORDER BY createdAt ASC')
      .all(projectId)
      .map(rowToWorkspace);
  },
  get(id: string): Workspace | null {
    const r = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
    return r ? rowToWorkspace(r) : null;
  },
  /** Dedup lookup for adopt-in-place import (§6.2): a directory is imported at
   *  most once as a workspace. Scoped to a project so unrelated repos that ever
   *  shared a path can't collide. */
  byWorktreePath(projectId: string, worktreePath: string): Workspace | null {
    const r = db
      .prepare('SELECT * FROM workspaces WHERE projectId=? AND worktreePath=?')
      .get(projectId, worktreePath);
    return r ? rowToWorkspace(r) : null;
  },
  /** Non-archived workspace whose worktree resolves to `worktreePath` (symlinks
   *  resolved), across every project — the placement lookup for harness chat sync
   *  (docs/specs/harness-chat-sync.md §5.4), where a scanned `cwd` isn't scoped to
   *  a project yet. */
  byAnyWorktreePath(worktreePath: string): Workspace | null {
    const norm = (p: string) => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return path.resolve(p);
      }
    };
    const target = norm(worktreePath);
    for (const w of Workspaces.list()) {
      if (w.archived) continue;
      if (norm(w.worktreePath) === target) return w;
    }
    return null;
  },
  insert(w: Workspace) {
    db.prepare(
      `INSERT INTO workspaces (id,projectId,name,hostId,branch,wsKind,title,subtitle,worktreePath,harness,status,port,archived,createdAt,lastUserMessageAt,prNumber,prUrl,prState,setupError)
       VALUES (@id,@projectId,@name,@hostId,@branch,@wsKind,@title,@subtitle,@worktreePath,@harness,@status,@port,@archived,@createdAt,@lastUserMessageAt,@prNumber,@prUrl,@prState,@setupError)`
    ).run({ ...w, hostId: w.hostId ?? null, archived: w.archived ? 1 : 0 });
  },
  update(w: Workspace) {
    db.prepare(
      `UPDATE workspaces SET name=@name, hostId=@hostId, branch=@branch, wsKind=@wsKind, title=@title, subtitle=@subtitle, worktreePath=@worktreePath, harness=@harness, status=@status,
       port=@port, archived=@archived, lastUserMessageAt=@lastUserMessageAt, prNumber=@prNumber, prUrl=@prUrl, prState=@prState, setupError=@setupError
       WHERE id=@id`
    ).run({ ...w, hostId: w.hostId ?? null, archived: w.archived ? 1 : 0 });
  },
  remove(id: string) {
    db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
    db.prepare('DELETE FROM messages WHERE workspaceId=?').run(id);
    db.prepare('DELETE FROM comments WHERE workspaceId=?').run(id);
    db.prepare('DELETE FROM todos WHERE workspaceId=?').run(id);
    db.prepare('DELETE FROM run_scripts WHERE workspaceId=?').run(id);
    db.prepare('DELETE FROM subagent_runs WHERE workspaceId=?').run(id);
    // Pending scheduled sends die with their workspace. The scheduler needs no
    // notification: a timer aimed at a now-deleted row fires, finds nothing
    // due, and re-arms to the true next item.
    db.prepare('DELETE FROM scheduled_messages WHERE workspaceId=?').run(id);
    db.prepare('DELETE FROM queued_messages WHERE workspaceId=?').run(id);
    // session:<wsId>:<agentId> and workspace:<wsId> digests
    db.prepare('DELETE FROM status_reports WHERE key LIKE ? OR key=?').run(`session:${id}:%`, `workspace:${id}`);
  },
  /** Set (or clear) a workspace's per-conversation cloud host (spec §6.6). */
  setCloudHost(id: string, hostId: string | null) {
    db.prepare('UPDATE workspaces SET hostId=? WHERE id=?').run(hostId, id);
  },
  getSessions(id: string): Record<string, string> {
    const r = db.prepare('SELECT sessionsJson FROM workspaces WHERE id=?').get(id) as any;
    return r ? safeJson(r.sessionsJson, {}) : {};
  },
  getChats(id: string): Record<string, ChatMeta> {
    const r = db.prepare('SELECT chatsJson FROM workspaces WHERE id=?').get(id) as any;
    return r ? safeJson(r.chatsJson, {}) : {};
  },
  patchChat(id: string, agentId: number, patch: Partial<ChatMeta>) {
    const chats = Workspaces.getChats(id);
    const meta = { ...chats[String(agentId)], ...patch };
    chats[String(agentId)] = meta;
    db.prepare('UPDATE workspaces SET chatsJson=? WHERE id=?').run(JSON.stringify(chats), id);
    // Keep every window's session-status indicators live without refetching.
    broadcast('chat:meta:updated', { workspaceId: id, agentId, meta });
  },
  removeChat(id: string, agentId: number) {
    const chats = Workspaces.getChats(id);
    delete chats[String(agentId)];
    db.prepare('UPDATE workspaces SET chatsJson=? WHERE id=?').run(JSON.stringify(chats), id);
  },
  setSession(id: string, agentId: number, sessionId: string) {
    const sessions = Workspaces.getSessions(id);
    sessions[String(agentId)] = sessionId;
    db.prepare('UPDATE workspaces SET sessionsJson=? WHERE id=?').run(JSON.stringify(sessions), id);
  },
  removeSession(id: string, agentId: number) {
    const sessions = Workspaces.getSessions(id);
    delete sessions[String(agentId)];
    db.prepare('UPDATE workspaces SET sessionsJson=? WHERE id=?').run(JSON.stringify(sessions), id);
  },
  clearSessions(id: string) {
    db.prepare('UPDATE workspaces SET sessionsJson=? WHERE id=?').run('{}', id);
  },
  usedPorts(): number[] {
    return (db.prepare('SELECT port FROM workspaces').all() as any[]).map((r) => r.port);
  },
};

/** Fetch a workspace by id or throw — the shared guard for IPC/service entry
 *  points that must have one. Accepts `undefined` so callers can pass an
 *  optional id straight through. */
export function mustWorkspace(id: string | undefined): Workspace {
  const ws = id ? Workspaces.get(id) : null;
  if (!ws) throw new Error('Workspace not found');
  return ws;
}

/** Fetch a project by id or throw. Accepts `undefined` (see mustWorkspace). */
export function mustProject(id: string | undefined): Project {
  const p = id ? Projects.get(id) : null;
  if (!p) throw new Error('Project not found');
  return p;
}

// ---------- messages ----------

export const Messages = {
  list(workspaceId: string): ChatMessage[] {
    return db
      .prepare('SELECT * FROM messages WHERE workspaceId=? ORDER BY ts ASC')
      .all(workspaceId)
      .map(rowToMessage);
  },
  insert(m: ChatMessage) {
    db.prepare(
      `INSERT INTO messages (id,workspaceId,agentId,role,content,attachmentsJson,metaJson,ts)
       VALUES (@id,@workspaceId,@agentId,@role,@content,@attachmentsJson,@metaJson,@ts)`
    ).run({
      id: m.id,
      workspaceId: m.workspaceId,
      agentId: m.agentId,
      role: m.role,
      content: m.content,
      attachmentsJson: JSON.stringify(m.attachments ?? []),
      metaJson: m.meta ? JSON.stringify(m.meta) : null,
      ts: m.ts,
    });
  },
  removeForAgent(workspaceId: string, agentId: number) {
    db.prepare('DELETE FROM messages WHERE workspaceId=? AND agentId=?').run(workspaceId, agentId);
  },
  get(id: string): ChatMessage | null {
    const r = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    return r ? rowToMessage(r) : null;
  },
  exists(id: string): boolean {
    return !!db.prepare('SELECT 1 FROM messages WHERE id=?').get(id);
  },
  remove(id: string) {
    db.prepare('DELETE FROM messages WHERE id=?').run(id);
  },
  /** Replace a message's meta blob (e.g. clear the cloud `queued` flag once its
   *  turn starts on the box). */
  setMeta(id: string, meta: ChatMessage['meta']) {
    db.prepare('UPDATE messages SET metaJson=? WHERE id=?').run(meta ? JSON.stringify(meta) : null, id);
  },
  /** The earliest user message's text for a chat, or null — the source the title
   *  backfill and every display fallback derive a provisional title from (§7). */
  firstUserText(workspaceId: string, agentId: number): string | null {
    const r = db
      .prepare("SELECT content FROM messages WHERE workspaceId=? AND agentId=? AND role='user' ORDER BY ts ASC LIMIT 1")
      .get(workspaceId, agentId) as { content: string } | undefined;
    return r?.content ?? null;
  },
  countForAgent(workspaceId: string, agentId: number): number {
    const r = db
      .prepare('SELECT COUNT(*) c FROM messages WHERE workspaceId=? AND agentId=? AND role=?')
      .get(workspaceId, agentId, 'user') as any;
    return r.c;
  },
};

// ---------- scheduled messages (send later) ----------

function rowToScheduled(r: any): ScheduledMessage {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    agentId: r.agentId,
    text: r.text,
    attachments: safeJson(r.attachmentsJson, []),
    kind: r.kind === 'limit-reset' ? 'limit-reset' : 'at',
    deliverAt: r.deliverAt,
    createdAt: r.createdAt,
    remoteTurnId: r.remoteTurnId ?? null,
  };
}

/**
 * Pending sends only: a row exists if and only if it is still waiting. Delivery
 * and cancellation both just delete, so there's nothing to garbage-collect and
 * no status field that could drift out of sync with reality.
 */
export const Scheduled = {
  insert(m: ScheduledMessage) {
    db.prepare(
      `INSERT INTO scheduled_messages (id,workspaceId,agentId,text,attachmentsJson,kind,deliverAt,createdAt,remoteTurnId)
       VALUES (@id,@workspaceId,@agentId,@text,@attachmentsJson,@kind,@deliverAt,@createdAt,@remoteTurnId)`
    ).run({ ...m, attachmentsJson: JSON.stringify(m.attachments ?? []), remoteTurnId: m.remoteTurnId ?? null });
  },
  get(id: string): ScheduledMessage | null {
    const r = db.prepare('SELECT * FROM scheduled_messages WHERE id=?').get(id);
    return r ? rowToScheduled(r) : null;
  },
  /** The row whose box job carries this turnId — how the follower matches a
   *  fired remote turn back to its scheduled row (§4). */
  byRemoteTurnId(turnId: string): ScheduledMessage | null {
    const r = db.prepare('SELECT * FROM scheduled_messages WHERE remoteTurnId=?').get(turnId);
    return r ? rowToScheduled(r) : null;
  },
  setText(id: string, text: string) {
    db.prepare('UPDATE scheduled_messages SET text=? WHERE id=?').run(text, id);
  },
  remove(id: string) {
    db.prepare('DELETE FROM scheduled_messages WHERE id=?').run(id);
  },
  forWorkspace(workspaceId: string): ScheduledMessage[] {
    return db
      .prepare('SELECT * FROM scheduled_messages WHERE workspaceId=? ORDER BY deliverAt ASC, createdAt ASC')
      .all(workspaceId)
      .map(rowToScheduled);
  },
  removeForAgent(workspaceId: string, agentId: number) {
    db.prepare('DELETE FROM scheduled_messages WHERE workspaceId=? AND agentId=?').run(workspaceId, agentId);
  },
  /** Everything at or past its time, oldest first — the delivery order. */
  due(nowMs: number): ScheduledMessage[] {
    return db
      .prepare('SELECT * FROM scheduled_messages WHERE deliverAt<=? ORDER BY deliverAt ASC, createdAt ASC')
      .all(nowMs)
      .map(rowToScheduled);
  },
  /** The earliest instant the local timer must fire at, or null. Overdue remote
   *  rows are excluded — the box delivers those, and re-arming at 0 would spin
   *  (§4.4). A future remote row still counts: the timer wakes its follower then. */
  nextAt(nowMs: number): number | null {
    const r = db
      .prepare('SELECT MIN(deliverAt) m FROM scheduled_messages WHERE remoteTurnId IS NULL OR deliverAt > ?')
      .get(nowMs) as any;
    return r?.m ?? null;
  },
  /** Earliest remote deliverAt for a chat strictly after `afterMs`, or null —
   *  lets the follower decide whether to keep polling a napping drain (§4.3). */
  nextRemoteAt(workspaceId: string, agentId: number, afterMs: number): number | null {
    const r = db
      .prepare(
        'SELECT MIN(deliverAt) m FROM scheduled_messages WHERE workspaceId=? AND agentId=? AND remoteTurnId IS NOT NULL AND deliverAt>?'
      )
      .get(workspaceId, agentId, afterMs) as any;
    return r?.m ?? null;
  },
};

// ---------- queued messages (send-while-busy → runs next) ----------

function rowToQueued(r: any): QueuedMessage {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    agentId: r.agentId,
    turnId: r.turnId,
    text: r.text,
    attachments: safeJson(r.attachmentsJson, []),
    seq: r.seq,
    createdAt: r.createdAt,
  };
}

/**
 * The pending send queue, persisted (spec §6.4): a row exists iff a message is
 * still waiting behind a running turn. Replaces the old in-memory map so a quit
 * no longer silently drops queued work; for cloud chats each row is mirrored by
 * a job file the box drains in `seq` order.
 */
export const Queued = {
  insert(m: QueuedMessage) {
    db.prepare(
      `INSERT INTO queued_messages (id,workspaceId,agentId,turnId,text,attachmentsJson,seq,createdAt)
       VALUES (@id,@workspaceId,@agentId,@turnId,@text,@attachmentsJson,@seq,@createdAt)`
    ).run({ ...m, attachmentsJson: JSON.stringify(m.attachments ?? []) });
  },
  get(id: string): QueuedMessage | null {
    const r = db.prepare('SELECT * FROM queued_messages WHERE id=?').get(id);
    return r ? rowToQueued(r) : null;
  },
  forChat(workspaceId: string, agentId: number): QueuedMessage[] {
    return db
      .prepare('SELECT * FROM queued_messages WHERE workspaceId=? AND agentId=? ORDER BY seq ASC')
      .all(workspaceId, agentId)
      .map(rowToQueued);
  },
  /** The oldest waiting message for a chat (FIFO drain), or null. */
  oldest(workspaceId: string, agentId: number): QueuedMessage | null {
    const r = db
      .prepare('SELECT * FROM queued_messages WHERE workspaceId=? AND agentId=? ORDER BY seq ASC LIMIT 1')
      .get(workspaceId, agentId);
    return r ? rowToQueued(r) : null;
  },
  /** Next monotonic seq for a chat — the job-file ordinal on the box. */
  nextSeq(workspaceId: string, agentId: number): number {
    const r = db
      .prepare('SELECT COALESCE(MAX(seq),0) m FROM queued_messages WHERE workspaceId=? AND agentId=?')
      .get(workspaceId, agentId) as any;
    return (r?.m ?? 0) + 1;
  },
  /** Dual of nextSeq: bump a message to the *front* of its chat's queue so it
   *  drains next (steer) — a seq below the current minimum. Local-only; cloud
   *  never enqueues here, so its box-side `seq` ordinals are untouched. */
  promote(workspaceId: string, agentId: number, id: string) {
    const r = db
      .prepare('SELECT COALESCE(MIN(seq),0) m FROM queued_messages WHERE workspaceId=? AND agentId=?')
      .get(workspaceId, agentId) as any;
    db.prepare('UPDATE queued_messages SET seq=? WHERE id=?').run((r?.m ?? 0) - 1, id);
  },
  setText(id: string, text: string) {
    db.prepare('UPDATE queued_messages SET text=? WHERE id=?').run(text, id);
  },
  remove(id: string) {
    db.prepare('DELETE FROM queued_messages WHERE id=?').run(id);
  },
  removeForChat(workspaceId: string, agentId: number) {
    db.prepare('DELETE FROM queued_messages WHERE workspaceId=? AND agentId=?').run(workspaceId, agentId);
  },
  /** Chats (across all workspaces) that have at least one waiting message — the
   *  boot drain checks these. */
  pendingChats(): { workspaceId: string; agentId: number }[] {
    return db
      .prepare('SELECT DISTINCT workspaceId, agentId FROM queued_messages')
      .all()
      .map((r: any) => ({ workspaceId: r.workspaceId, agentId: r.agentId }));
  },
};

// ---------- subagent runs (specialist delegations) ----------

function rowToSubagentRun(r: any): SubagentRun {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    parentAgentId: r.parentAgentId,
    parentMessageId: r.parentMessageId,
    role: r.role,
    harness: r.harness as HarnessId,
    model: r.model,
    effort: r.effort,
    prompt: r.prompt,
    blocks: safeJson(r.blocksJson, []),
    status: r.status,
    error: r.error ?? undefined,
    costUsd: r.costUsd ?? undefined,
    durationMs: r.durationMs ?? undefined,
    ts: r.ts,
  };
}

export const Subagents = {
  insert(s: SubagentRun) {
    db.prepare(
      `INSERT INTO subagent_runs (id,workspaceId,parentAgentId,parentMessageId,role,harness,model,effort,prompt,blocksJson,status,error,costUsd,durationMs,ts)
       VALUES (@id,@workspaceId,@parentAgentId,@parentMessageId,@role,@harness,@model,@effort,@prompt,@blocksJson,@status,@error,@costUsd,@durationMs,@ts)`
    ).run({
      ...s,
      blocksJson: JSON.stringify(s.blocks ?? []),
      error: s.error ?? null,
      costUsd: s.costUsd ?? null,
      durationMs: s.durationMs ?? null,
    });
  },
  update(s: SubagentRun) {
    db.prepare(
      `UPDATE subagent_runs SET blocksJson=@blocksJson, status=@status, error=@error, costUsd=@costUsd, durationMs=@durationMs WHERE id=@id`
    ).run({
      id: s.id,
      blocksJson: JSON.stringify(s.blocks ?? []),
      status: s.status,
      error: s.error ?? null,
      costUsd: s.costUsd ?? null,
      durationMs: s.durationMs ?? null,
    });
  },
  listForParent(workspaceId: string, parentMessageId: string): SubagentRun[] {
    return db
      .prepare('SELECT * FROM subagent_runs WHERE workspaceId=? AND parentMessageId=? ORDER BY ts ASC')
      .all(workspaceId, parentMessageId)
      .map(rowToSubagentRun);
  },
  countForParent(workspaceId: string, parentMessageId: string): number {
    const r = db
      .prepare('SELECT COUNT(*) c FROM subagent_runs WHERE workspaceId=? AND parentMessageId=?')
      .get(workspaceId, parentMessageId) as any;
    return r.c;
  },
  costForParent(workspaceId: string, parentMessageId: string): number {
    const r = db
      .prepare('SELECT COALESCE(SUM(costUsd),0) s FROM subagent_runs WHERE workspaceId=? AND parentMessageId=?')
      .get(workspaceId, parentMessageId) as any;
    return r.s ?? 0;
  },
  removeForAgent(workspaceId: string, agentId: number) {
    db.prepare('DELETE FROM subagent_runs WHERE workspaceId=? AND parentAgentId=?').run(workspaceId, agentId);
  },
};

// ---------- comments ----------

export const Comments = {
  list(workspaceId: string): DiffComment[] {
    return db
      .prepare('SELECT * FROM comments WHERE workspaceId=? ORDER BY createdAt ASC')
      .all(workspaceId)
      .map(rowToComment);
  },
  insert(c: DiffComment) {
    db.prepare(
      'INSERT INTO comments (id,workspaceId,file,line,side,body,resolved,createdAt) VALUES (@id,@workspaceId,@file,@line,@side,@body,@resolved,@createdAt)'
    ).run({ ...c, resolved: c.resolved ? 1 : 0 });
  },
  setResolved(id: string, resolved: boolean) {
    db.prepare('UPDATE comments SET resolved=? WHERE id=?').run(resolved ? 1 : 0, id);
  },
  remove(id: string) {
    db.prepare('DELETE FROM comments WHERE id=?').run(id);
  },
};

// ---------- todos ----------

export const Todos = {
  list(workspaceId: string): Todo[] {
    return db
      .prepare('SELECT * FROM todos WHERE workspaceId=? ORDER BY createdAt ASC')
      .all(workspaceId)
      .map(rowToTodo);
  },
  insert(t: Todo) {
    db.prepare('INSERT INTO todos (id,workspaceId,text,done,createdAt) VALUES (@id,@workspaceId,@text,@done,@createdAt)').run(
      { ...t, done: t.done ? 1 : 0 }
    );
  },
  setDone(id: string, done: boolean) {
    db.prepare('UPDATE todos SET done=? WHERE id=?').run(done ? 1 : 0, id);
  },
  remove(id: string) {
    db.prepare('DELETE FROM todos WHERE id=?').run(id);
  },
};

// ---------- run scripts ----------

function rowToRunScript(r: any): RunScript {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    kind: r.kind === 'test' ? 'test' : 'run',
    doc: r.doc,
    source: r.source === 'ai' ? 'ai' : 'user',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const RunScripts = {
  forWorkspace(workspaceId: string): RunScript[] {
    return db
      .prepare('SELECT * FROM run_scripts WHERE workspaceId=? ORDER BY createdAt ASC')
      .all(workspaceId)
      .map(rowToRunScript);
  },
  get(id: string): RunScript | null {
    const r = db.prepare('SELECT * FROM run_scripts WHERE id=?').get(id);
    return r ? rowToRunScript(r) : null;
  },
  insert(s: RunScript) {
    db.prepare(
      `INSERT INTO run_scripts (id,workspaceId,name,kind,doc,source,createdAt,updatedAt)
       VALUES (@id,@workspaceId,@name,@kind,@doc,@source,@createdAt,@updatedAt)`
    ).run(s);
  },
  update(s: RunScript) {
    db.prepare('UPDATE run_scripts SET name=@name, kind=@kind, doc=@doc, updatedAt=@updatedAt WHERE id=@id').run(s);
  },
  remove(id: string) {
    db.prepare('DELETE FROM run_scripts WHERE id=?').run(id);
  },
};

// ---------- status digests ----------

export const StatusReports = {
  get(key: string): { report: StatusReport; fingerprint: string } | null {
    const r = db.prepare('SELECT dataJson, fingerprint FROM status_reports WHERE key=?').get(key) as any;
    if (!r) return null;
    const report = safeJson<StatusReport | null>(r.dataJson, null);
    return report ? { report, fingerprint: r.fingerprint } : null;
  },
  set(key: string, report: StatusReport, fingerprint: string) {
    db.prepare(
      `INSERT INTO status_reports (key,dataJson,fingerprint,generatedAt) VALUES (?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET dataJson=excluded.dataJson, fingerprint=excluded.fingerprint, generatedAt=excluded.generatedAt`
    ).run(key, JSON.stringify(report), fingerprint, report.generatedAt);
  },
};

// ---------- ssh hosts ----------

function rowToHost(r: any): SshHostConfig {
  return {
    id: r.id,
    label: r.label,
    host: r.host,
    port: r.port,
    user: r.user,
    auth: r.auth === 'key' ? 'key' : 'agent',
    keyPath: r.keyPath ?? undefined,
    hostKeyFingerprint: r.hostKeyFingerprint ?? undefined,
    jumpFingerprints: r.jumpFingerprints ? safeJson<Record<string, string>>(r.jumpFingerprints, {}) : undefined,
    managed: r.managed ? true : undefined,
    portBase: r.portBase ?? undefined,
    kind: r.kind === 'k8s' ? 'k8s' : 'ssh',
    k8s: r.k8sJson ? safeJson<K8sConfig | undefined>(r.k8sJson, undefined) : undefined,
  };
}

export const Hosts = {
  list(): SshHostConfig[] {
    return db.prepare('SELECT * FROM hosts ORDER BY label ASC').all().map(rowToHost);
  },
  get(id: string): SshHostConfig | null {
    const r = db.prepare('SELECT * FROM hosts WHERE id=?').get(id);
    return r ? rowToHost(r) : null;
  },
  upsert(h: SshHostConfig) {
    db.prepare(
      `INSERT INTO hosts (id,label,host,port,user,auth,keyPath,hostKeyFingerprint,jumpFingerprints,managed,portBase,kind,k8sJson)
       VALUES (@id,@label,@host,@port,@user,@auth,@keyPath,@hostKeyFingerprint,@jumpFingerprints,@managed,@portBase,@kind,@k8sJson)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, host=excluded.host, port=excluded.port,
         user=excluded.user, auth=excluded.auth, keyPath=excluded.keyPath, hostKeyFingerprint=excluded.hostKeyFingerprint,
         jumpFingerprints=excluded.jumpFingerprints, managed=excluded.managed, portBase=excluded.portBase,
         kind=excluded.kind, k8sJson=excluded.k8sJson`
    ).run({
      id: h.id,
      label: h.label,
      host: h.host,
      port: h.port,
      user: h.user,
      auth: h.auth,
      keyPath: h.keyPath ?? null,
      hostKeyFingerprint: h.hostKeyFingerprint ?? null,
      jumpFingerprints: h.jumpFingerprints ? JSON.stringify(h.jumpFingerprints) : null,
      managed: h.managed ? 1 : null,
      portBase: h.portBase ?? null,
      kind: h.kind ?? 'ssh',
      k8sJson: h.k8s ? JSON.stringify(h.k8s) : null,
    });
  },
  remove(id: string) {
    db.prepare('DELETE FROM hosts WHERE id=?').run(id);
  },
};

// ---------- settings ----------

// Workspaces are isolated worktrees — agents get full access inside them with
// no permission prompts, matching Conductor. (Non-interactive runs can't answer
// prompts anyway; anything short of bypass just makes commands fail.)
const DEFAULT_SETTINGS: GlobalSettings = {
  theme: 'system',
  defaultHarness: 'claude-code',
  ideCommand: 'code',
  permissionMode: 'bypassPermissions',
  linearToken: '',
  notifications: true,
  completionSound: DEFAULT_COMPLETION_SOUND,
  defaultModels: {},
  defaultEffort: DEFAULT_EFFORT,
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  refinePrompt: false,
  onboarded: false,
  harnessApiKeys: {},
  autoStatus: true,
  autoDetectRunScripts: true,
};

export const Settings = {
  raw(key: string): string | null {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;
    return r ? r.value : null;
  },
  setRaw(key: string, value: string) {
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
      key,
      value
    );
  },
  /** Delete every raw setting whose key starts with `prefix` (LIKE wildcards in the
   *  prefix are escaped, so `_`/`%` match literally). Used to drop whole families
   *  of per-id keys, e.g. the relay publish fingerprints on a fresh web link. */
  clearPrefix(prefix: string) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    db.prepare("DELETE FROM settings WHERE key LIKE ? ESCAPE '\\'").run(`${escaped}%`);
  },
  global(): GlobalSettings {
    const raw = Settings.raw('global');
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...safeJson(raw, {}) };
  },
  setGlobal(patch: Partial<GlobalSettings>): GlobalSettings {
    const next = { ...Settings.global(), ...patch };
    Settings.setRaw('global', JSON.stringify(next));
    return next;
  },
  nextPort(portBase?: number | null): number {
    const used = new Set(Workspaces.usedPorts());
    // On a shared managed box each user gets a 100-port block (§3); allocating
    // WORKSPACE_PORT inside it keeps different users from colliding even though
    // their apps don't know about each other.
    if (portBase != null) {
      for (let p = portBase; p < portBase + 100; p++) if (!used.has(p)) return p;
      return portBase; // block exhausted — reuse the base (best-effort)
    }
    let port = parseInt(Settings.raw('nextPort') || '4100', 10);
    while (used.has(port)) port++;
    Settings.setRaw('nextPort', String(port + 1));
    return port;
  },
};
