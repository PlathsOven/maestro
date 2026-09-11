import fs from 'fs';
import path from 'path';
import { broadcast, getWindow } from '../../bus';
import { Messages, Projects, Settings, Workspaces, now, uid } from '../../db';
import { addProject, createWorkspace } from '../workspaces';
import { addRunFinishedListener } from '../harness';
import { claudeDir } from '../harness/claude';
import { codexDir } from '../harness/codex';
import { HARNESS_MODELS, type HarnessSyncApp, type HarnessSyncImportResult, type HarnessSyncScan, type HarnessSyncStatus, type Workspace } from '../../../shared/types';
import { codexModels } from '../harness/codex-models';
import { findCodexRollout, maxAgentId, mungePath, normPath } from '../harnessFiles';
import type { ChatMeta } from '../../../shared/types';
import {
  buildScan,
  clearPlaceCache,
  headReadFile,
  isImportable,
  placeCwd,
  scanHarnessSessions,
  sessionTitle,
  type HarnessSession,
  type Placement,
} from './scan';
import { ingest, resetLiveState } from './ingest';
import { claudeLiveElsewhere } from './live';

// The background sync engine (docs/specs/harness-chat-sync.md §6.4/§6.7). Watches
// both harness transcript trees, tails the chats Maestro knows, and — when the
// user has opted in — turns new interactive sessions in known repos into chats.
// Everything here is best-effort: a watcher error falls back to the poll, and
// nothing may throw past the boot step().

// ---------- linked / watched maps ----------

interface Watched {
  workspaceId: string;
  agentId: number;
  app: HarnessSyncApp;
}

/** sessionId → the Maestro chat that owns it. */
let watched = new Map<string, Watched>();

function rebuildWatched(): void {
  const next = new Map<string, Watched>();
  for (const ws of Workspaces.list()) {
    if (ws.archived) continue;
    if (ws.harness !== 'claude-code' && ws.harness !== 'codex') continue;
    const sessions = Workspaces.getSessions(ws.id);
    const chats = Workspaces.getChats(ws.id);
    for (const [agentIdStr, sessionId] of Object.entries(sessions)) {
      const app = (chats[agentIdStr]?.mirror?.app ?? (ws.harness as HarnessSyncApp)) as HarnessSyncApp;
      next.set(sessionId, { workspaceId: ws.id, agentId: Number(agentIdStr), app });
    }
  }
  watched = next;
}

/** The set of session ids already tied to a Maestro chat (dedup, §5.3). */
function linkedIds(): Set<string> {
  const out = new Set<string>();
  for (const ws of Workspaces.list()) {
    for (const sessionId of Object.values(Workspaces.getSessions(ws.id))) out.add(sessionId);
  }
  return out;
}

// ---------- candidates (sessions in repos Maestro doesn't know) ----------

const candidates = new Map<string, { root: string; app: HarnessSyncApp; ids: Set<string> }>();
let lastScanAt: number | null = null;
// Sessions seen with no prompts yet — retried when they grow.
const emptySeen = new Map<string, number>();

function isEnabled(): boolean {
  return Settings.global().harnessSync?.enabled ?? false;
}

// ---------- status ----------

export function harnessSyncStatus(): HarnessSyncStatus {
  return {
    enabled: isEnabled(),
    lastScanAt,
    mirrored: watched.size,
    candidates: [...candidates.values()].map((c) => ({ root: c.root, app: c.app, count: c.ids.size })),
  };
}

function broadcastStatus(): void {
  broadcast('harnessSync:status', harnessSyncStatus());
}

// ---------- detect (cached 60 s) ----------

let detectCache: { at: number; value: boolean } | null = null;

export function detectHarnessSync(): boolean {
  if (detectCache && Date.now() - detectCache.at < 60_000) return detectCache.value;
  let value = false;
  try {
    value = scanHarnessSessions().some(isImportable);
  } catch {
    value = false;
  }
  detectCache = { at: Date.now(), value };
  return value;
}

// ---------- scan (grouped, for the panel) ----------

export async function scanHarnessSync(): Promise<HarnessSyncScan> {
  const { scan } = await buildScan(linkedIds());
  lastScanAt = Date.now();
  refreshCandidatesFromScan(scan);
  broadcastStatus();
  return scan;
}

function refreshCandidatesFromScan(scan: HarnessSyncScan): void {
  candidates.clear();
  for (const g of scan.groups) {
    if (g.placement.kind !== 'new-project' && g.placement.kind !== 'new-folder') continue;
    const root = g.placement.kind === 'new-project' ? g.placement.root : g.placement.root;
    if ((Settings.global().harnessSync?.dismissedRoots ?? []).includes(normPath(root))) continue;
    const app = g.sessions[0]?.app ?? 'claude-code';
    candidates.set(root, { root, app, ids: new Set(g.sessions.map((s) => s.sessionId)) });
  }
}

// ---------- creating chats ----------

function knownModel(app: HarnessSyncApp, model: string | undefined): string | undefined {
  if (!model) return undefined;
  const list = app === 'codex' ? codexModels() : HARNESS_MODELS[app] ?? [];
  return list.some((m) => m.id === model) ? model : undefined;
}

/** Resolve a placement to a concrete workspace, creating the project and/or
 *  adopting the root exactly as the Conductor importer does. Returns null (never
 *  throws) so one bad root can't abort the whole import. */
async function resolveTarget(
  placement: Placement,
  app: HarnessSyncApp,
  result: HarnessSyncImportResult
): Promise<Workspace | null> {
  try {
    if (placement.kind === 'workspace') {
      return Workspaces.get(placement.workspaceId);
    }
    if (placement.kind === 'adopt') {
      const existing = Workspaces.byWorktreePath(placement.projectId, placement.path);
      if (existing) return existing;
      const ws = await createWorkspace({
        projectId: placement.projectId,
        harness: app,
        adopt: { path: placement.path, branch: placement.branch },
      });
      result.workspaces++;
      return ws;
    }
    if (placement.kind === 'new-project') {
      const existed = !!Projects.byPath(placement.root, null);
      const project = await addProject({ mode: 'local', path: placement.root });
      if (!existed) result.projects++;
      const existing = Workspaces.byWorktreePath(project.id, placement.root);
      if (existing) return existing;
      const ws = await createWorkspace({
        projectId: project.id,
        harness: app,
        adopt: { path: placement.root, branch: placement.branch },
      });
      result.workspaces++;
      return ws;
    }
    if (placement.kind === 'new-folder') {
      const existed = !!Projects.byPath(placement.root, null);
      // addProject('folder') auto-creates the single in-place workspace on `app`.
      const project = await addProject({ mode: 'folder', path: placement.root, harness: app });
      if (!existed) result.projects++;
      return Workspaces.forProject(project.id).find((w) => !w.archived) ?? null;
    }
  } catch (e) {
    result.errors.push(`${(placement as any).root ?? (placement as any).path ?? 'target'}: ${String((e as Error)?.message ?? e)}`);
    return null;
  }
  return null;
}

const IMPORT_MARKER = (app: HarnessSyncApp, turns: number) =>
  `Imported from ${app === 'codex' ? 'Codex' : 'Claude Code'} — ${turns} turn${turns === 1 ? '' : 's'}. ` +
  `Continue here; new turns typed in ${app === 'codex' ? 'Codex' : 'Claude Code'} keep appearing.`;

/** Turn one session into a mirrored chat on `ws` and fold its whole history in. */
async function createChatForSession(ws: Workspace, s: HarnessSession): Promise<number> {
  const agentId = maxAgentId(ws.id) + 1;
  const title = sessionTitle(s, agentId);
  Workspaces.patchChat(ws.id, agentId, {
    title,
    titleCustom: true,
    ...(knownModel(s.app, s.model) ? { model: knownModel(s.app, s.model) } : {}),
    mirror: { app: s.app, file: s.file, cursor: 0, imported: true },
    lastReadAt: s.modifiedAt,
  });
  Workspaces.setSession(ws.id, agentId, s.sessionId);
  Messages.insert({
    id: uid(),
    workspaceId: ws.id,
    agentId,
    role: 'system',
    content: IMPORT_MARKER(s.app, s.prompts),
    attachments: [],
    ts: Math.max(1, s.startedAt - 1),
  });
  await ingest(ws, agentId); // import: cursor 0, no live — every turn is closed
  return agentId;
}

// ---------- import (panel action) ----------

export async function importHarnessSync(sessionIds: string[], enableSync: boolean): Promise<HarnessSyncImportResult> {
  const result: HarnessSyncImportResult = { projects: 0, workspaces: 0, chats: 0, focusWorkspaceId: null, errors: [] };
  // Re-scan from fresh truth (cheap) rather than trusting renderer previews.
  const linked = linkedIds();
  const all = scanHarnessSessions();
  const wanted = new Set(sessionIds);
  const selected = all.filter((s) => wanted.has(s.sessionId) && !linked.has(s.sessionId) && isImportable(s));

  // Group by placement so a project/workspace is created once; within a group,
  // oldest-first so agent ids follow chronology (§6.7).
  const byKey = new Map<string, { placement: Placement; app: HarnessSyncApp; sessions: HarnessSession[] }>();
  for (const s of selected) {
    const placement = await placeCwd(s.cwd);
    if (placement.kind === 'missing') continue;
    const key = placementDedupKey(placement);
    let g = byKey.get(key);
    if (!g) {
      g = { placement, app: s.app, sessions: [] };
      byKey.set(key, g);
    }
    g.sessions.push(s);
  }

  let focusActivity = -1;
  for (const g of byKey.values()) {
    const ws = await resolveTarget(g.placement, g.app, result);
    if (!ws) continue;
    for (const s of [...g.sessions].sort((a, b) => a.startedAt - b.startedAt)) {
      try {
        await createChatForSession(ws, s);
        result.chats++;
        if (s.modifiedAt > focusActivity) {
          focusActivity = s.modifiedAt;
          result.focusWorkspaceId = ws.id;
        }
      } catch (e) {
        result.errors.push(`${s.sessionId}: ${String((e as Error)?.message ?? e)}`);
      }
    }
  }

  if (enableSync) {
    Settings.setGlobal({
      harnessSync: {
        enabled: true,
        dismissedRoots: Settings.global().harnessSync?.dismissedRoots ?? [],
      },
    });
  }
  clearPlaceCache(); // the project/workspace set just changed
  rebuildWatched();
  lastScanAt = Date.now();
  broadcastStatus();
  return result;
}

function placementDedupKey(p: Placement): string {
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

// ---------- live-elsewhere maintenance ----------

/** Claude liveness is definitive via its live registry and independent of the
 *  transcript, so the watcher recomputes it directly. (Codex has no registry — its
 *  externalLive is maintained by the ingest fold, which knows the open turn.) */
function recomputeExternalLive(w: Watched): void {
  if (w.app !== 'claude-code') return;
  const ws = Workspaces.get(w.workspaceId);
  if (!ws) return;
  const meta = Workspaces.getChats(ws.id)[String(w.agentId)];
  const sessionId = Workspaces.getSessions(ws.id)[String(w.agentId)];
  if (!sessionId) return;
  const el = claudeLiveElsewhere(sessionId);
  const cur = meta?.externalLive ?? null;
  const changed = (el?.pid ?? null) !== (cur?.pid ?? null) || !!el !== !!cur;
  if (changed) Workspaces.patchChat(ws.id, w.agentId, { externalLive: el });
}

// ---------- watching ----------

const debounce = new Map<string, NodeJS.Timeout>();

function scheduleIngest(sessionId: string, root: string, filename: string): void {
  const prev = debounce.get(sessionId);
  if (prev) clearTimeout(prev);
  debounce.set(
    sessionId,
    setTimeout(() => {
      debounce.delete(sessionId);
      void handleChange(sessionId, root, filename).catch(() => {});
    }, 400)
  );
}

async function handleChange(sessionId: string, root: string, filename: string): Promise<void> {
  const w = watched.get(sessionId);
  if (w) {
    const ws = Workspaces.get(w.workspaceId);
    if (!ws) return;
    recomputeExternalLive(w);
    await ingest(ws, w.agentId, { live: true }).catch(() => {});
    // Re-check shortly after so the banner clears when the external process exits.
    setTimeout(() => recomputeExternalLive(w), 2000);
    return;
  }
  if (!isEnabled()) return;

  // An unknown session in a known repo can become a chat automatically.
  const app: HarnessSyncApp = root === path.join(codexDir(), 'sessions') ? 'codex' : 'claude-code';
  const file = path.join(root, filename);
  const s = headReadFile(app, file);
  if (!s) return;
  if (!isImportable(s)) {
    if (s.prompts < 1) emptySeen.set(sessionId, s.bytes);
    return;
  }
  const placement = await placeCwd(s.cwd);
  if (placement.kind === 'workspace' || placement.kind === 'adopt') {
    const result: HarnessSyncImportResult = { projects: 0, workspaces: 0, chats: 0, focusWorkspaceId: null, errors: [] };
    const ws = await resolveTarget(placement, app, result);
    if (ws) {
      await createChatForSession(ws, s).catch(() => {});
      clearPlaceCache();
      rebuildWatched();
    }
  } else if (placement.kind === 'new-project' || placement.kind === 'new-folder') {
    const dismissed = Settings.global().harnessSync?.dismissedRoots ?? [];
    if (!dismissed.includes(normPath(placement.root))) {
      const entry = candidates.get(placement.root) ?? { root: placement.root, app, ids: new Set<string>() };
      entry.ids.add(sessionId);
      candidates.set(placement.root, entry);
      broadcastStatus();
    }
  }
}

function sessionIdFromClaude(filename: string): string | null {
  const parts = filename.split(path.sep);
  if (parts.length !== 2 || !parts[1].endsWith('.jsonl')) return null;
  return parts[1].replace(/\.jsonl$/, '');
}

function sessionIdFromCodex(filename: string): string | null {
  const base = filename.split(path.sep).pop() ?? '';
  const m = base.match(/^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/);
  return m ? m[1] : null;
}

function watchTree(root: string, kind: HarnessSyncApp): fs.FSWatcher | null {
  if (!fs.existsSync(root)) return null;
  try {
    const watcher = fs.watch(root, { recursive: true }, (_ev, filename) => {
      if (!filename) return;
      const name = filename.toString();
      const id = kind === 'codex' ? sessionIdFromCodex(name) : sessionIdFromClaude(name);
      if (id) scheduleIngest(id, root, name);
    });
    watcher.on('error', () => {
      try {
        watcher.close();
      } catch {}
    });
    return watcher;
  } catch {
    return null; // recursive fs.watch unsupported → the poll covers it
  }
}

// ---------- fallback poll ----------

const POLL_MS = 30_000;
const UNFOCUSED_EVERY = 10; // ≈5 min while backgrounded
const sizes = new Map<string, number>();

function pollTick(): void {
  rebuildWatched();
  for (const [sessionId, w] of watched) {
    const ws = Workspaces.get(w.workspaceId);
    if (!ws) continue;
    const meta = Workspaces.getChats(ws.id)[String(w.agentId)];
    const file = meta?.mirror?.file;
    if (!file) continue;
    let size = -1;
    try {
      size = fs.statSync(file).size;
    } catch {}
    if (size < 0) continue;
    if (sizes.get(sessionId) !== size) {
      sizes.set(sessionId, size);
      void ingest(ws, w.agentId, { live: true }).catch(() => {});
    }
  }
}

// ---------- boot ----------

/** On boot, attach a mirror to every linked chat that lacks one (Maestro-born
 *  chats resumed in a terminal, §6.4) so future external turns are tailed, and
 *  clear any stale externalLive. */
function primeMirrors(): void {
  for (const ws of Workspaces.list()) {
    if (ws.archived) continue;
    if (ws.harness !== 'claude-code' && ws.harness !== 'codex') continue;
    const app = ws.harness as HarnessSyncApp;
    const sessions = Workspaces.getSessions(ws.id);
    const chats = Workspaces.getChats(ws.id);
    for (const [agentIdStr, sessionId] of Object.entries(sessions)) {
      const agentId = Number(agentIdStr);
      const meta = chats[agentIdStr];
      const patch: Partial<ChatMeta> = {};
      if (!meta?.mirror) {
        const file = app === 'codex' ? findCodexFile(sessionId) : claudeFile(ws.worktreePath, sessionId);
        if (file) {
          let size = 0;
          try {
            size = fs.statSync(file).size;
          } catch {}
          patch.mirror = { app, file, cursor: size };
        }
      }
      if (meta?.externalLive) patch.externalLive = null;
      if (Object.keys(patch).length) Workspaces.patchChat(ws.id, agentId, patch);
      resetLiveState(ws.id, agentId);
    }
  }
}

function claudeFile(worktreePath: string, sessionId: string): string | null {
  const file = path.join(claudeDir(), 'projects', mungePath(worktreePath), `${sessionId}.jsonl`);
  return fs.existsSync(file) ? file : null;
}
function findCodexFile(sessionId: string): string | null {
  return findCodexRollout(path.join(codexDir(), 'sessions'), sessionId);
}

let started = false;

export function startHarnessSync(): void {
  if (started) return;
  started = true;

  primeMirrors();
  rebuildWatched();

  // Fence 2 (§6.5): after Maestro's own turn on a mirrored session finishes, its
  // output is already in the transcript — fast-forward the cursor past it and drop
  // the streaming carry so ingest never re-persists it.
  addRunFinishedListener((workspaceId, agentId) => {
    const meta = Workspaces.getChats(workspaceId)[String(agentId)];
    const m = meta?.mirror;
    if (!m) return;
    setTimeout(() => {
      try {
        const size = fs.statSync(m.file).size;
        const cur = Workspaces.getChats(workspaceId)[String(agentId)]?.mirror;
        if (cur) Workspaces.patchChat(workspaceId, agentId, { mirror: { ...cur, cursor: size } });
        resetLiveState(workspaceId, agentId);
      } catch {}
    }, 1500);
  });

  watchTree(path.join(claudeDir(), 'projects'), 'claude-code');
  watchTree(path.join(codexDir(), 'sessions'), 'codex');

  let tick = 0;
  setInterval(() => {
    tick++;
    if (!(getWindow()?.isFocused() ?? false) && tick % UNFOCUSED_EVERY !== 0) return;
    try {
      pollTick();
    } catch {}
  }, POLL_MS);
}
