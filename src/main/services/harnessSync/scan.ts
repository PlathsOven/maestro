import fs from 'fs';
import path from 'path';
import { run } from '../../exec';
import { Projects, Workspaces } from '../../db';
import { claudeDir } from '../harness/claude';
import { codexDir } from '../harness/codex';
import { normPath, promptTitle } from '../harnessFiles';
import type {
  HarnessSyncApp,
  HarnessSyncGroup,
  HarnessSyncScan,
  HarnessSyncSessionPreview,
} from '../../../shared/types';

// Read-only enumeration + placement for harness chat sync
// (docs/specs/harness-chat-sync.md §5). Nothing here writes to ~/.claude or
// ~/.codex — only readdir / stat / open(O_RDONLY). Every failure is swallowed and
// downgraded to "skip this file"; the feature never throws past its boot step.

const HEAD_BYTES = 64 * 1024;
const SMALL_FILE = 2 * 1024 * 1024; // scan the whole file for prompts only when small

export type SessionOrigin = 'interactive' | 'maestro' | 'sdk' | 'subagent' | 'unknown';

export interface HarnessSession {
  app: HarnessSyncApp;
  sessionId: string;
  file: string; // absolute transcript path
  cwd: string; // as recorded, then normPath()'d
  startedAt: number; // first content line ts
  modifiedAt: number; // file mtime
  bytes: number;
  prompts: number; // typed prompts seen (0 ⇒ skipped)
  firstPrompt: string; // title source, ≤ 200 chars, preamble-stripped
  origin: SessionOrigin;
  gitBranch?: string;
  model?: string;
}

export type Placement = HarnessSyncGroup['placement'] | { kind: 'missing'; root: string };

// ---------- head reads ----------

function readHead(file: string, bytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function tsOf(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function completeLines(chunk: string): any[] {
  const out: any[] = [];
  const parts = chunk.split('\n');
  // The final element may be a partial line (buffer cut) — drop it.
  parts.pop();
  for (const line of parts) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // truncated / non-JSON — ignore
    }
  }
  return out;
}

// ---------- Claude ----------

function claudeOrigin(first: any): SessionOrigin {
  if (first?.isSidechain === true) return 'subagent';
  const e = typeof first?.entrypoint === 'string' ? first.entrypoint : '';
  if (e === 'sdk-cli') return 'maestro';
  if (e.startsWith('sdk-')) return 'sdk';
  if (e === 'cli') return 'interactive';
  return 'unknown';
}

/** Head-read one Claude transcript. `sessionId` is the filename stem (the resume
 *  key); cwd/origin/timestamp come from the first content line. */
function readClaudeSession(file: string, sessionId: string, stat: fs.Stats): HarnessSession | null {
  const head = readHead(file, HEAD_BYTES);
  if (head === null) return null;
  const lines = completeLines(head);
  const first = lines.find((j) => j?.type === 'user' || j?.type === 'assistant');
  if (!first) return null;
  const cwd = typeof first.cwd === 'string' && first.cwd ? first.cwd : '';
  let prompts = 0;
  let firstPrompt = '';
  let model: string | undefined;
  for (const j of lines) {
    if (j?.type === 'assistant' && !model && typeof j.message?.model === 'string') model = j.message.model;
    if (j?.type === 'user' && !j.toolUseResult && j.promptSource === 'typed') {
      prompts++;
      if (!firstPrompt) {
        const c = j.message?.content;
        const text =
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ')
              : '';
        firstPrompt = (promptTitle(text) ? text.trim().replace(/\s+/g, ' ') : '').slice(0, 200);
      }
    }
  }
  // Head had no typed prompt: scan the whole (small) file before giving up, else
  // assume it has prompts and let ingest decide (§5.1).
  if (prompts === 0) {
    if (stat.size < SMALL_FILE) {
      const full = readHead(file, stat.size);
      if (full) {
        for (const j of completeLines(full + '\n')) {
          if (j?.type === 'user' && !j.toolUseResult && j.promptSource === 'typed') {
            prompts++;
            if (!firstPrompt) {
              const c = j.message?.content;
              const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ') : '';
              firstPrompt = (promptTitle(text) ? text.trim().replace(/\s+/g, ' ') : '').slice(0, 200);
            }
          }
        }
      }
    } else {
      prompts = 1; // large file, unknown — treat as importable, ingest is authoritative
    }
  }
  return {
    app: 'claude-code',
    sessionId,
    file,
    cwd: cwd ? normPath(cwd) : '',
    startedAt: tsOf(first.timestamp),
    modifiedAt: stat.mtimeMs,
    bytes: stat.size,
    prompts,
    firstPrompt,
    origin: claudeOrigin(first),
    gitBranch: typeof first.gitBranch === 'string' ? first.gitBranch : undefined,
    model,
  };
}

function scanClaude(): HarnessSession[] {
  const root = path.join(claudeDir(), 'projects');
  const out: HarnessSession[] = [];
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const dir = path.join(root, pd.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      // Only *.jsonl files directly inside the project dir (a `<sessionId>/` subdir
      // holds tool-results/subagents — ignore it).
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, f.name);
      const sessionId = f.name.replace(/\.jsonl$/, '');
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const cached = fromCache('claude-code', file, stat);
      if (cached) {
        out.push(cached);
        continue;
      }
      const s = readClaudeSession(file, sessionId, stat);
      if (s) {
        putCache(file, stat, s);
        out.push(s);
      }
    }
  }
  return out;
}

// ---------- Codex ----------

function codexOrigin(meta: any): SessionOrigin {
  if (meta?.parent_thread_id) return 'subagent';
  const source = meta?.source;
  if (source && typeof source === 'object') return 'subagent'; // {subagent:{…}}
  const originator = typeof meta?.originator === 'string' ? meta.originator : '';
  if (source === 'exec') return 'maestro';
  if (originator.startsWith('codex_sdk_')) return 'sdk';
  if (source === 'cli') return 'interactive';
  return 'unknown';
}

function readCodexSession(file: string, stat: fs.Stats): HarnessSession | null {
  const head = readHead(file, HEAD_BYTES);
  if (head === null) return null;
  const lines = completeLines(head);
  const metaLine = lines.find((j) => (j?.payload?.type ?? j?.type) === 'session_meta' || j?.payload?.session_id || j?.payload?.id);
  const meta = metaLine?.payload ?? metaLine;
  if (!meta) return null;
  const sessionId =
    (typeof meta.session_id === 'string' && meta.session_id) ||
    (typeof meta.id === 'string' && meta.id) ||
    file.replace(/.*-([0-9a-fA-F-]{36})\.jsonl$/, '$1');
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
  let prompts = 0;
  let firstPrompt = '';
  let model: string | undefined;
  for (const j of lines) {
    const p = j?.payload ?? {};
    if (p.type === 'turn_context' && !model && typeof p.model === 'string') model = p.model;
    if (p.type === 'user_message') {
      prompts++;
      if (!firstPrompt && typeof p.message === 'string') firstPrompt = p.message.trim().replace(/\s+/g, ' ').slice(0, 200);
    }
  }
  if (prompts === 0 && stat.size >= SMALL_FILE) prompts = 1;
  return {
    app: 'codex',
    sessionId,
    file,
    cwd: cwd ? normPath(cwd) : '',
    startedAt: tsOf(metaLine?.timestamp ?? meta.timestamp),
    modifiedAt: stat.mtimeMs,
    bytes: stat.size,
    prompts,
    firstPrompt,
    origin: codexOrigin(meta),
    gitBranch: typeof meta.git?.branch === 'string' ? meta.git.branch : undefined,
    model,
  };
}

function scanCodex(): HarnessSession[] {
  const root = path.join(codexDir(), 'sessions');
  const out: HarnessSession[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        const cached = fromCache('codex', full, stat);
        if (cached) {
          out.push(cached);
          continue;
        }
        const s = readCodexSession(full, stat);
        if (s) {
          putCache(full, stat, s);
          out.push(s);
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

// ---------- cache (size, mtime) → session ----------

const cache = new Map<string, { size: number; mtime: number; session: HarnessSession }>();

function fromCache(app: HarnessSyncApp, file: string, stat: fs.Stats): HarnessSession | null {
  const hit = cache.get(file);
  if (hit && hit.session.app === app && hit.size === stat.size && hit.mtime === stat.mtimeMs) return hit.session;
  return null;
}
function putCache(file: string, stat: fs.Stats, session: HarnessSession) {
  cache.set(file, { size: stat.size, mtime: stat.mtimeMs, session });
}

// ---------- enumeration ----------

/** Every session on disk (both harnesses), newest-first. Caller filters by
 *  origin/prompts. */
export function scanHarnessSessions(): HarnessSession[] {
  const all = [...scanClaude(), ...scanCodex()];
  all.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return all;
}

/** A session is eligible to import / auto-create when the user typed it (or its
 *  origin is uncatalogued) and it has at least one human prompt. */
export function isImportable(s: HarnessSession): boolean {
  return (s.origin === 'interactive' || s.origin === 'unknown') && s.prompts >= 1;
}

/** Head-read a single transcript file by app + path (the watcher's live path). */
export function headReadFile(app: HarnessSyncApp, file: string): HarnessSession | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = fromCache(app, file, stat);
  if (cached) return cached;
  const s = app === 'codex' ? readCodexSession(file, stat) : readClaudeSession(file, file.replace(/\.jsonl$/, '').split(path.sep).pop()!, stat);
  if (s) putCache(file, stat, s);
  return s;
}

// ---------- placement ----------

function findProjectByRoot(repoRoot: string): { id: string; kind: 'git' | 'folder' } | null {
  for (const p of Projects.list()) {
    if (p.hostId) continue; // local only
    if (normPath(p.repoPath) === repoRoot) return { id: p.id, kind: p.kind };
  }
  return null;
}

// Placement runs 3 git subprocesses per distinct cwd; many sessions share one
// repo, so memoize briefly (§9 large histories). Cleared after an import mutates
// the project/workspace set.
const placeCache = new Map<string, { at: number; result: Placement }>();
export function clearPlaceCache(): void {
  placeCache.clear();
}

/** Map a session's cwd to a Maestro placement (§5.4). Async: consults git. */
export async function placeCwd(cwd: string): Promise<Placement> {
  const hit = placeCache.get(cwd);
  if (hit && Date.now() - hit.at < 10_000) return hit.result;
  const result = await placeCwdUncached(cwd);
  placeCache.set(cwd, { at: Date.now(), result });
  return result;
}

async function placeCwdUncached(cwd: string): Promise<Placement> {
  if (!cwd || !fs.existsSync(cwd)) return { kind: 'missing', root: cwd };
  const direct = Workspaces.byAnyWorktreePath(cwd);
  if (direct) return { kind: 'workspace', workspaceId: direct.id, name: direct.name };

  const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 10_000 });
  if (!top.ok) return { kind: 'new-folder', root: normPath(cwd) };
  const root = normPath(top.stdout.trim());

  const rootWs = Workspaces.byAnyWorktreePath(root);
  if (rootWs) return { kind: 'workspace', workspaceId: rootWs.id, name: rootWs.name };

  const branchOut = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeout: 10_000 });
  const branch = branchOut.ok ? branchOut.stdout.trim() : '';

  const common = await run('git', ['rev-parse', '--git-common-dir'], { cwd: root, timeout: 10_000 });
  let repoRoot = root;
  if (common.ok) {
    let c = common.stdout.trim();
    if (!path.isAbsolute(c)) c = path.resolve(root, c);
    repoRoot = normPath(path.dirname(c));
  }
  const proj = findProjectByRoot(repoRoot);
  if (proj && proj.kind === 'git') return { kind: 'adopt', projectId: proj.id, path: root, branch };
  return { kind: 'new-project', root, branch };
}

// ---------- title ----------

/** Chat title for a session (§5.5): first prompt through the title rules, else a
 *  fallback. Always used with titleCustom:true so sendChat won't overwrite it. */
export function sessionTitle(s: HarnessSession, ordinal: number): string {
  return promptTitle(s.firstPrompt) || (s.firstPrompt ? s.firstPrompt.slice(0, 60) : '') || `Chat ${ordinal}`;
}

// ---------- public scan (grouped) ----------

function placementKey(p: Placement): string {
  switch (p.kind) {
    case 'workspace':
      return `ws:${p.workspaceId}`;
    case 'adopt':
      return `adopt:${p.path}`;
    case 'new-project':
      return `new:${p.root}`;
    case 'new-folder':
      return `folder:${p.root}`;
    case 'missing':
      return `missing:${p.root}`;
  }
}

/** Build the renderer's grouped scan. `linked` maps a session id already tied to a
 *  Maestro chat → true (so it's listed greyed and unselectable). */
export async function buildScan(linked: Set<string>): Promise<{ scan: HarnessSyncScan; sessions: Map<string, HarnessSession> }> {
  const sessions = scanHarnessSessions();
  const byId = new Map<string, HarnessSession>();
  const skipped: HarnessSyncScan['skipped'] = { maestro: 0, sdk: 0, subagent: 0, 'no-prompts': 0, missing: 0 };
  const groups = new Map<string, HarnessSyncGroup>();

  for (const s of sessions) {
    if (!linked.has(s.sessionId)) byId.set(s.sessionId, s); // for import lookup

    if (s.origin === 'maestro' || s.origin === 'sdk' || s.origin === 'subagent') {
      if (!linked.has(s.sessionId)) skipped[s.origin]++;
      continue;
    }
    if (s.prompts < 1) {
      if (!linked.has(s.sessionId)) skipped['no-prompts']++;
      continue;
    }
    const placement = await placeCwd(s.cwd);
    if (placement.kind === 'missing') {
      if (!linked.has(s.sessionId)) skipped.missing++;
      continue;
    }
    const key = placementKey(placement);
    let group = groups.get(key);
    if (!group) {
      group = { key: groupKey(placement), placement: placement as HarnessSyncGroup['placement'], sessions: [] };
      groups.set(key, group);
    }
    const preview: HarnessSyncSessionPreview = {
      app: s.app,
      sessionId: s.sessionId,
      title: sessionTitle(s, group.sessions.length + 1),
      turns: s.prompts,
      startedAt: s.startedAt,
      modifiedAt: s.modifiedAt,
      cwd: s.cwd,
      alreadyImported: linked.has(s.sessionId),
    };
    group.sessions.push(preview);
  }

  // Newest group first; sessions newest-first within a group.
  const list = [...groups.values()];
  for (const g of list) g.sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
  list.sort((a, b) => (b.sessions[0]?.modifiedAt ?? 0) - (a.sessions[0]?.modifiedAt ?? 0));
  return { scan: { groups: list, skipped }, sessions: byId };
}

/** The group's public selection key: workspaceId for an existing workspace, else
 *  the root path (§6.9). */
function groupKey(p: Placement): string {
  switch (p.kind) {
    case 'workspace':
      return p.workspaceId;
    case 'adopt':
      return p.path;
    case 'new-project':
      return p.root;
    case 'new-folder':
      return p.root;
    case 'missing':
      return p.root;
  }
}
