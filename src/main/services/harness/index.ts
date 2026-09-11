import { Notification } from 'electron';
import { broadcast, getWindow } from '../../bus';
import { hostForWorkspace, isCloudWorkspace } from '../../hosts';
import type { HostChild } from '../../hosts/types';
import { checkpoint } from '../shadow';
import { appIconPath } from '../../icon';
import { Messages, Projects, Settings, Subagents, Workspaces, now, uid } from '../../db';
import { currentBranch } from '../git';
import { scriptEnv } from '../scripts';
import { HARNESS_PLAN_MODE, resolveDefaultEffort, resolveDefaultModel } from '../../../shared/types';
import type { AgentBlock, AgentEvent, HarnessId, HarnessInfo, SubUsage, Workspace } from '../../../shared/types';
import { wireAdapterStream, type BuildOpts, type HarnessAdapter } from './adapter';
import { applyBlockEvent, finalizeBlocks, newBlockStream, snapshotBlocks, type BlockStream } from './stream';
import { applyTaskEvent, reapBackgroundTasks } from './tasks';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { effectiveHarnessModels } from './codex-models';
import { cursorAdapter } from './cursor';
import { opencodeAdapter } from './opencode';
import { kimiAdapter } from './kimi';
import { grokAdapter } from './grok';
import { shellAdapter } from './shell';
import { HARNESS_LOGIN } from './remote';
import { detectHarnessAuth, harnessAuthFault, harnessHasLogin, harnessKeyEnv } from './auth';
import { activeLogin, DEFAULT_LOGIN_ID, harnessLoginEnv, labelFor, loginDir, loginsFor, rotate, type HarnessLogin } from './logins';
import { looksLikeAuthError, looksLikeLimitError } from '../../../shared/harness/limits';
import { cancelAsksFor, setAskRecordHook } from '../ask';

export const adapters: Record<HarnessId, HarnessAdapter> = {
  'claude-code': claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  opencode: opencodeAdapter,
  'kimi-code': kimiAdapter,
  grok: grokAdapter,
  shell: shellAdapter,
};

let detectCache: { at: number; value: HarnessInfo[] } | null = null;

export async function detectHarnesses(force = false): Promise<HarnessInfo[]> {
  if (!force && detectCache && Date.now() - detectCache.at < 5 * 60_000) return detectCache.value;
  const infos = await Promise.all(Object.values(adapters).map((a) => a.detect()));
  // Pair each install probe with its (reliable, file-based) auth check so the UI
  // can tell "logged in" from "CLI present" — and keep a harness usable when the
  // user has authenticated it even if the `--version` probe came back empty.
  const value = await Promise.all(
    infos.map(async (info) => {
      const auth = await detectHarnessAuth(info.id, info).catch(() => null);
      return { ...info, connected: auth?.connected ?? false };
    })
  );
  detectCache = { at: Date.now(), value };
  return value;
}

// Subscription usage, cached briefly: renderers poll it freely (mount, turn
// end, interval) and a fetch hits the network + possibly the macOS Keychain.
// Keyed per login so each row in the usage popover caches independently.
const usageCache = new Map<string, { at: number; value: SubUsage | null }>();

export async function getSubUsage(harness: HarnessId, loginId: string = DEFAULT_LOGIN_ID): Promise<SubUsage | null> {
  const key = `${harness}:${loginId}`;
  const cached = usageCache.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  let value: SubUsage | null = null;
  try {
    value = (await adapters[harness]?.fetchUsage?.(loginDir(harness, loginId))) ?? null;
  } catch {
    value = null;
  }
  usageCache.set(key, { at: Date.now(), value });
  return value;
}

interface RunHandle {
  child: HostChild;
  adapter: HarnessAdapter;
  workspaceId: string;
  agentId: number;
  // Stable id for this turn, assigned at start and reused as the finalized
  // agent message's id — so specialist sub-agents spawned mid-turn can link to
  // the message before it exists (see services/roles + currentTurnId).
  turnId: string;
  stream: BlockStream;
  doneHandled: boolean;
  stopped: boolean;
  stderrTail: string;
  startedAt: number;
  // Latest per-call context occupancy — persisted once at finalize.
  context: Extract<AgentEvent, { kind: 'context' }> | null;
  // A usage-limit rejection seen mid-stream — why the turn failed (login
  // rotation reads it in finalize). Never broadcast, never a block.
  limit: Extract<AgentEvent, { kind: 'limit' }> | null;
  // The login this turn ran under (local turns); rotation marks it on a limit.
  loginId: string;
  // The original send, so a rotated retry can re-run the same turn under a new
  // login. Undefined for journal/cloud turns (they don't rotate).
  send?: SendOpts;
  // A cloud turn replayed from the journal during catch-up: skip the live
  // Notification (a single away-digest is posted instead — §6.5) and run the
  // follower's per-turn callback so it can advance the journal offset.
  quiet?: boolean;
  onFinalized?: () => void;
  // Pending throttled publish of the in-progress turn to Maestro Web (§6.3).
  liveTimer?: ReturnType<typeof setTimeout>;
}

const runs = new Map<string, RunHandle>();
const runKey = (wsId: string, agentId: number) => `${wsId}:${agentId}`;

// Injected by the chat service (which owns the message queue) — avoids a
// circular import between chat and harness.
let runFinishedHook: ((workspaceId: string, agentId: number) => void) | null = null;
export function setRunFinishedHook(fn: (workspaceId: string, agentId: number) => void) {
  runFinishedHook = fn;
}

// Additional turn-end observers (harness chat sync fast-forwards its cursor past
// Maestro's own turn here, §6.5). A Set — never replaces the single-slot
// runFinishedHook (chat.ts owns that); it runs alongside it.
const runFinishedListeners = new Set<(workspaceId: string, agentId: number) => void>();
export function addRunFinishedListener(fn: (workspaceId: string, agentId: number) => void): () => void {
  runFinishedListeners.add(fn);
  return () => runFinishedListeners.delete(fn);
}

// Injected by the roles service so stopping an orchestrator turn also kills the
// specialist sub-agents it spawned. workspaceId null = every workspace (quit).
let subagentStopHook: ((workspaceId: string | null, agentId: number | null) => void) | null = null;
export function setSubagentStopHook(fn: (workspaceId: string | null, agentId: number | null) => void) {
  subagentStopHook = fn;
}

// Injected by the cloud service: a quiet (catch-up) turn's finalize reports here
// instead of posting its own Notification, so one away-digest covers them all.
let awayDigestHook: ((o: { attention: boolean }) => void) | null = null;
export function setAwayDigestHook(fn: ((o: { attention: boolean }) => void) | null) {
  awayDigestHook = fn;
}

/** The in-flight turn id for a running (workspace, agent), or null when idle.
 *  Specialists link to it as their parentMessageId. */
export function currentTurnId(workspaceId: string, agentId: number): string | null {
  return runs.get(runKey(workspaceId, agentId))?.turnId ?? null;
}

export function runningAgents(workspaceId: string): number[] {
  const out: number[] = [];
  for (const h of runs.values()) {
    if (h.workspaceId === workspaceId) out.push(h.agentId);
  }
  return out.sort((a, b) => a - b);
}

export function isAgentRunning(workspaceId: string, agentId: number): boolean {
  return runs.has(runKey(workspaceId, agentId));
}

function setWorkspaceStatus(ws: Workspace, status: Workspace['status']) {
  const fresh = Workspaces.get(ws.id);
  if (!fresh) return;
  fresh.status = status;
  Workspaces.update(fresh);
  broadcast('ws:updated', fresh);
}

/** First meaningful line of the turn's final text, markdown-stripped. */
function summarizeBlocks(blocks: AgentBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'text' && b.text.trim()) {
      const line = b.text
        .split('\n')
        .map((l) => l.replace(/^[#>*\-\s`]+/, '').replace(/[*`_]/g, '').trim())
        .find((l) => l.length > 0);
      if (line) return line.slice(0, 100);
    }
  }
  return null;
}

/** Fold a resolved `maestro-ask` prompt into its turn as a persisted `ask`
 *  block — same path a message-final event takes, so it lands in the stream and
 *  reaches the live renderer. No-op if the turn already finished (a stopped run
 *  cancels its ask after the turn is gone). */
function recordAskBlock(workspaceId: string, agentId: number, block: AgentBlock): void {
  const h = runs.get(runKey(workspaceId, agentId));
  if (!h || h.doneHandled) return;
  const event: AgentEvent = { kind: 'message-final', blocks: [block] };
  applyBlockEvent(h.stream, event);
  broadcast('chat:event', { workspaceId, agentId, event });
}
setAskRecordHook(recordAskBlock);

/** Publish a LOCAL turn's lifecycle to Maestro Web (web-desktop-parity §6.3). The
 *  account service registers this once linked; cloud turns stream via the box
 *  journal instead, so the hook (account.publishLiveTurn) skips them. */
export type LiveTurnPublish = { turnId: string; status: 'running' | 'done' | 'error'; blocks: unknown[]; meta?: unknown; startedAt: number; endedAt?: number };
let liveTurnHook: ((workspaceId: string, agentId: number, turn: LiveTurnPublish) => void) | null = null;
export function setLiveTurnHook(fn: ((workspaceId: string, agentId: number, turn: LiveTurnPublish) => void) | null): void {
  liveTurnHook = fn;
}

// While a local turn streams, mirror its blocks-so-far to Maestro Web so the web
// shows the same tool calls / reasoning / text the desktop does, instead of a
// bare "Thinking…" until the turn ends (§6.3). Throttled trailing edge: the first
// change since the last publish schedules one LIVE_STREAM_MS later and coalesces
// the burst. finalize clears the timer and sets doneHandled, so no trailing
// publish lands after the terminal one (the relay also refuses to revive a
// finalized turn — putConvTurn).
const LIVE_STREAM_MS = 400;
function scheduleLivePublish(h: RunHandle): void {
  if (!liveTurnHook || h.doneHandled || h.liveTimer) return;
  h.liveTimer = setTimeout(() => {
    h.liveTimer = undefined;
    if (h.doneHandled) return;
    liveTurnHook?.(h.workspaceId, h.agentId, {
      turnId: h.turnId,
      status: 'running',
      blocks: snapshotBlocks(h.stream),
      startedAt: h.startedAt,
    });
  }, LIVE_STREAM_MS);
}

/** Fold one event into the turn. Returns true when the visible blocks changed, so
 *  the caller can stream the update to Maestro Web. Session/context/limit/task
 *  carry no visible blocks. */
function applyEvent(h: RunHandle, ev: AgentEvent): boolean {
  // Session + context carry no visible blocks; everything else builds the turn.
  if (ev.kind === 'session') {
    Workspaces.setSession(h.workspaceId, h.agentId, ev.sessionId);
    return false;
  }
  if (ev.kind === 'context') {
    h.context = ev;
    return false;
  }
  if (ev.kind === 'limit') {
    // Bookkeeping only — finalize reads it to decide rotation. Never a block.
    h.limit = ev;
    return false;
  }
  if (ev.kind === 'task') {
    // Lives in the per-chat ledger, not in the turn: the task outlives the turn
    // that started it (in the agent's head, at least — see services/harness/tasks).
    // The CLI reaps its background tasks *after* emitting the turn's result, so
    // doneHandled distinguishes that from a kill the agent asked for mid-turn.
    applyTaskEvent(h.workspaceId, h.agentId, ev.task, h.doneHandled);
    return false;
  }
  return applyBlockEvent(h.stream, ev);
}

/** Drop a system line into a chat — how an automatic send (a queued message, a
 *  rotation retry) reports what it did, since there's no UI action to return to.
 *  Shared with services/chat (one definition). */
export function postSystem(workspaceId: string, agentId: number, content: string): void {
  const msg = {
    id: uid(),
    workspaceId,
    agentId,
    role: 'system' as const,
    content,
    attachments: [],
    ts: now(),
  };
  Messages.insert(msg);
  broadcast('chat:message', msg);
}

/** A usage window's human label for the rotation message. */
function windowLabel(window?: string): string {
  return window === 'five_hour' ? '5-hour' : window === 'seven_day' ? 'weekly' : 'usage';
}

async function finalize(h: RunHandle, done: Extract<AgentEvent, { kind: 'done' }>) {
  if (h.doneHandled) return;
  h.doneHandled = true;
  runs.delete(runKey(h.workspaceId, h.agentId));
  // The turn is over: resolve any question it was blocked on. Normally the agent
  // can't finish mid-ask, but a stopped turn can leave a `maestro-ask` child
  // orphaned on its socket — cancel so the CLI unblocks and the picker clears.
  cancelAsksFor(h.workspaceId, h.agentId);
  // Prefer the per-call measurement (claude adapter); done-event fields are a
  // fallback for adapters that only report usage once at turn end.
  const ctx = h.context ?? (done.contextTokens ? { contextTokens: done.contextTokens, usage: done.usage } : null);
  if (ctx) {
    Workspaces.patchChat(h.workspaceId, h.agentId, {
      contextTokens: ctx.contextTokens,
      usage: ctx.usage,
    });
  }

  const blocks = finalizeBlocks(h.stream);

  const ws = Workspaces.get(h.workspaceId);
  if (!ws) return;

  // Stop streaming: the terminal publish below is authoritative, and a trailing
  // "running" publish would otherwise re-strand the web on "Thinking…". (doneHandled
  // is already set above, so a fired-but-pending timer no-ops too.)
  clearTimeout(h.liveTimer);
  h.liveTimer = undefined;

  // Specialist sub-agents spawned during this turn linked to h.turnId; surface
  // their count (drives the response dropdown) and fold their cost into the turn.
  const subCount = Subagents.countForParent(h.workspaceId, h.turnId);
  const subCost = Subagents.costForParent(h.workspaceId, h.turnId);
  const costUsd = done.costUsd != null || subCost ? (done.costUsd ?? 0) + subCost : undefined;

  const meta = {
    costUsd,
    durationMs: done.durationMs ?? Date.now() - h.startedAt,
    error: done.error,
    ...(subCount ? { subagents: subCount } : {}),
  };

  if (blocks.length > 0) {
    const msg = {
      // id === turnId so specialists (linked by parentMessageId = turnId) attach
      // to this exact message.
      id: h.turnId,
      workspaceId: h.workspaceId,
      agentId: h.agentId,
      role: 'agent' as const,
      content: JSON.stringify(blocks),
      attachments: [],
      ts: now(),
      meta,
    };
    Messages.insert(msg);
    broadcast('chat:message', msg);
  }

  // Always tell Maestro Web the local turn ended — even with no blocks (a cancel
  // before any output, or an empty error) — so the web finalizes its live turn
  // instead of hanging on "Thinking…" forever (the relay keeps a turn "live"
  // purely while its status is 'running'). The hook no-ops for cloud/unlinked.
  liveTurnHook?.(h.workspaceId, h.agentId, {
    turnId: h.turnId,
    status: done.error ? 'error' : 'done',
    blocks,
    meta,
    startedAt: h.startedAt,
    endedAt: Date.now(),
  });

  // A local turn that died on a usage limit: mark that login, move to one with
  // headroom, and run the same turn again under it. The retried run owns the
  // rest of this turn's bookkeeping (attention, subtitle, notification, queue),
  // so on a successful re-spawn we return early. `limitNote` (set when there's
  // no candidate) is appended to the error system message below.
  let limitNote = '';
  const localTurn = !Projects.get(ws.projectId)?.hostId && !isCloudWorkspace(ws);
  if (done.error && !done.ok && !h.stopped && h.send && localTurn) {
    // The structured `limit` event when we saw one; else infer from the error
    // text (older CLI, or the event was dropped) — an empty window either way.
    const limit: { resetsAt?: number; window?: string } | null =
      h.limit ?? (looksLikeLimitError(done.error) ? {} : null);
    if (limit) {
      const until = limit.resetsAt ?? Date.now() + 60 * 60_000;
      const logins = loginsFor(ws.harness);
      const label = (l: HarnessLogin) => labelFor(l, logins.findIndex((x) => x.id === l.id));
      const resetText = limit.resetsAt
        ? ` (resets ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`
        : '';
      const win = windowLabel(limit.window);
      const r = rotate(ws.harness, h.loginId, until);
      if (r) {
        postSystem(
          h.workspaceId,
          h.agentId,
          `Switched to **${label(r.to)}** — **${label(r.from)}** hit its ${win} limit${resetText}. Re-sending your message.`
        );
        if (startAgent(h.send).ok) {
          h.onFinalized?.();
          return;
        }
      } else if (logins.length > 1) {
        const from = label(logins.find((l) => l.id === h.loginId) ?? logins[0]);
        limitNote =
          Settings.global().loginRotation === false
            ? `**${from}** hit its ${win} limit${resetText}. Automatic rotation is off — pick another login from the usage ring or turn rotation on in Settings → Harnesses.`
            : `**${from}** hit its ${win} limit${resetText} and every other login is limited too — pick one from the usage ring, or send later when limits reset.`;
      }
    }
  }

  if (done.error && blocks.length === 0) {
    let content = `Agent error: ${done.error}`;
    // A remote agent that fails auth (e.g. codex "unexpected status 401
    // Unauthorized") needs a sign-in on the SERVER, not this Mac — point straight
    // at the headless login instead of leaving a bare 401.
    const proj = Projects.get(ws.projectId);
    const login = HARNESS_LOGIN[ws.harness];
    const authish = looksLikeAuthError(`${done.error} ${h.stderrTail}`);
    if (proj?.hostId && login && authish) {
      content += `\n\nThis looks like a sign-in problem on ${proj.name}. Run \`${login}\` in the terminal (or click “sign in” in the model picker), then send again.`;
    }
    // A local run that died on the CLI's own credentials is a dead end inside the
    // chat — the user can't sign in from in there, and every other workspace is
    // about to fail the same way. Name what's wrong when we can see it, and mark
    // the message so it renders with the one-click repair.
    const local = !proj?.hostId && !isCloudWorkspace(ws) && authish;
    const fault = local ? harnessAuthFault(ws.harness) : null;
    if (fault) content += `\n\n${fault.summary}`;
    // A limit with no rotation candidate (all logins limited, or rotation off).
    if (limitNote) content += `\n\n${limitNote}`;
    const offerFix = local && harnessHasLogin(ws.harness);
    const msg = {
      id: uid(),
      workspaceId: h.workspaceId,
      agentId: h.agentId,
      role: 'system' as const,
      content,
      attachments: [],
      ts: now(),
      // Carry the login this turn actually ran under so the fix signs THAT one
      // back in — not whichever login later happens to be active.
      ...(offerFix ? { meta: { fix: { kind: 'harness-auth' as const, harness: ws.harness, loginId: h.loginId } } } : {}),
    };
    Messages.insert(msg);
    broadcast('chat:message', msg);
  }

  // Session status bookkeeping: a run that ended badly leaves the chat waiting
  // on the user ("attention", cleared by their next send); a clean finish marks
  // fresh unread output. Stopping a run is a user action — neither applies.
  Workspaces.patchChat(h.workspaceId, h.agentId, {
    attention: !h.stopped && (!done.ok || !!done.needsAttention),
    ...(blocks.length > 0 || done.error ? { lastAgentAt: now() } : {}),
  });

  // The agent may have renamed the branch (we ask it to on the first turn).
  try {
    const branch = await currentBranch(ws.worktreePath, hostForWorkspace(ws));
    if (branch && branch !== 'HEAD' && branch !== ws.branch) {
      ws.branch = branch;
      Workspaces.update(ws);
    }
  } catch {}

  // Sidebar subtitle: the last thing that happened in this workspace.
  const subtitle = h.stopped
    ? 'Stopped'
    : done.error
      ? `Error: ${done.error}`.slice(0, 100)
      : done.needsAttention
        ? 'Needs attention'
        : summarizeBlocks(blocks);
  if (subtitle) {
    const fresh = Workspaces.get(h.workspaceId);
    if (fresh) {
      fresh.subtitle = subtitle;
      Workspaces.update(fresh);
    }
  }

  // Snapshot a folder project's changes into its shadow repo at the turn boundary
  // (§7 Phase 5) so the Diff tab / undo reflect what this turn did. Local only.
  if (ws.wsKind === 'in-place') {
    const proj = Projects.get(ws.projectId);
    if (proj?.kind === 'folder' && !proj.hostId) void checkpoint(ws, subtitle || 'turn').catch(() => {});
  }

  if (runningAgents(h.workspaceId).length === 0) {
    const attention = !h.stopped && (!done.ok || done.needsAttention);
    setWorkspaceStatus(ws, attention ? 'needs-attention' : ws.prNumber ? 'reviewing' : 'idle');
  } else {
    broadcast('ws:updated', Workspaces.get(h.workspaceId)!);
  }

  const attentionEnd = !done.ok || !!done.needsAttention;
  if (h.quiet) {
    // A journal turn replayed during catch-up (§6.5): no per-turn notification —
    // the caller posts a single "while you were away" digest instead.
    if (!h.stopped) awayDigestHook?.({ attention: attentionEnd });
  } else {
    const win = getWindow();
    const settings = Settings.global();
    if (settings.notifications && win && !win.isFocused() && !h.stopped && Notification.isSupported()) {
      new Notification({
        // Name the task by its work summary (like every other surface), not the
        // placeholder directory name — so the user can tell which task finished.
        title: `${ws.title ?? ws.name} · ${adapters[ws.harness].displayName}`,
        body: attentionEnd ? 'Agent needs attention' : 'Agent finished',
        icon: appIconPath(),
      }).show();
    }
  }

  runFinishedHook?.(h.workspaceId, h.agentId);
  for (const fn of runFinishedListeners) {
    try {
      fn(h.workspaceId, h.agentId);
    } catch {}
  }
  h.onFinalized?.();
}

export interface SendOpts {
  workspace: Workspace;
  agentId: number;
  prompt: string;
  systemPrompt: string | null;
  /** Extra env for the child (e.g. the orchestrator's role-delegation handshake). */
  env?: Record<string, string>;
}

export interface ResolvedTurn {
  adapter: HarnessAdapter;
  /** per-chat build options minus the per-message prompt + session id */
  base: Omit<BuildOpts, 'prompt' | 'sessionId'>;
  /** the session id to resume for the *next* attended turn (null when fresh) */
  sessionId: string | null;
  /** the full spawn env (scriptEnv + API keys + harness effort env + extras) */
  spawnEnv: Record<string, string>;
  /** the login this turn ran under — the active login for a local turn, else the
   *  default (a remote/cloud host uses its own credential store). finalize marks
   *  it limited on a usage-limit failure. */
  loginId: string;
}

/**
 * Resolve the adapter, per-chat build options, and spawn env for a turn — the
 * shared prelude for a local spawn (`startAgent`) and a cloud `turn.sh`
 * (services/cloud). The env depends only on model/effort, so it's stable across
 * the messages of one chat.
 */
export function resolveTurn(
  ws: Workspace,
  agentId: number,
  systemPrompt: string | null,
  extraEnv?: Record<string, string>
): ResolvedTurn {
  const adapter = adapters[ws.harness] ?? shellAdapter;
  const settings = Settings.global();
  const sessionId = Workspaces.getSessions(ws.id)[String(agentId)] ?? null;
  const chatMeta = Workspaces.getChats(ws.id)[String(agentId)] ?? {};
  // A chat's stored model must be one of the workspace harness's *current* models.
  // Codex's list is resolved live from its own catalog, so validate against that —
  // otherwise a newly-shipped model the picker just offered would be rejected here
  // and silently downgraded to the default. If the harness was switched, an id left
  // over from the old one is likewise dropped so it isn't handed to the wrong CLI
  // (e.g. `claude --model gpt-5.6-terra`) — we fall back to the default then.
  const validModels = effectiveHarnessModels()[ws.harness] ?? [];
  const chatModel = validModels.some((m) => m.id === chatMeta.model) ? chatMeta.model : '';
  // The per-chat plan toggle overrides the global permission mode, gated on the
  // harness actually having a plan-style mode — so a stale flag left over from a
  // harness switch can't distort another CLI's approval flags.
  const planMode = !!chatMeta.planMode && ws.harness in HARNESS_PLAN_MODE;
  const base = {
    permissionMode: planMode ? ('plan' as const) : settings.permissionMode,
    systemPrompt,
    // Always resolve to an explicit model/effort so the UI and the CLI agree.
    model: chatModel || resolveDefaultModel(ws.harness, settings.defaultModels) || undefined,
    effort: chatMeta.effort || resolveDefaultEffort(settings.defaultEffort) || undefined,
  };
  // env depends only on model/effort — a probe build yields it prompt-independently.
  const probeEnv = adapter.build({ ...base, prompt: '', sessionId: null }).env ?? {};
  // The active login reaches a LOCAL child through its credential-isolation env.
  // A cloud box or SSH host has its own credential store, so a Mac-local dir path
  // means nothing there — skip it and record the run as the default login.
  const local = !isCloudWorkspace(ws) && !Projects.get(ws.projectId)?.hostId;
  const loginId = local ? activeLogin(ws.harness).id : DEFAULT_LOGIN_ID;
  const loginEnv = local ? harnessLoginEnv(ws.harness, loginId) : {};
  const spawnEnv = {
    ...scriptEnv(ws),
    ...harnessKeyEnv(ws.harness, settings),
    ...loginEnv,
    ...probeEnv,
    ...(extraEnv ?? {}),
  };
  return { adapter, base, sessionId, spawnEnv, loginId };
}

export function startAgent(opts: SendOpts): { ok: boolean; error?: string } {
  const { workspace: ws, agentId } = opts;
  const key = runKey(ws.id, agentId);
  if (runs.has(key)) return { ok: false, error: `Agent ${agentId} is already running in this workspace` };

  // Belt and braces for a child that never closed cleanly: whatever the previous
  // process left "running" is certainly dead by the time a new one starts.
  reapBackgroundTasks(ws.id, agentId);

  const { adapter, base, sessionId, spawnEnv, loginId } = resolveTurn(ws, agentId, opts.systemPrompt, opts.env);
  const cmd = adapter.build({ ...base, prompt: opts.prompt, sessionId });

  // Agents run ON the project's host — local child_process for local projects,
  // an SSH channel for remote ones. The host merges these extras with its own
  // login env and strips nested-session vars (§6.2). The prompt rides stdin, so
  // there's no injection surface in the fixed flag args.
  const host = hostForWorkspace(ws);
  const child = host.spawnStream(cmd.cmd, cmd.args, { cwd: ws.worktreePath, env: spawnEnv });

  const turnId = uid();
  beginTurn(ws, agentId, adapter, child, {
    turnId,
    stdin: cmd.stdin,
    cmdName: cmd.cmd,
    sessionHint: cmd.sessionHint,
    // Snapshot the original send + the login it ran under, so finalize can
    // rotate to another login and re-run this exact turn on a usage limit.
    send: opts,
    loginId,
  });
  liveTurnHook?.(ws.id, agentId, { turnId, status: 'running', blocks: [], startedAt: Date.now() });
  return { ok: true };
}

export interface BeginTurnOpts {
  turnId: string;
  /** written to the child's stdin (local spawn); null for a journal child (the
   *  box already fed the prompt from the job file). */
  stdin: string | null;
  /** name used in the "failed to start" message. */
  cmdName: string;
  /** client-minted session id to store up front (grok). */
  sessionHint?: string;
  /** catch-up replay: suppress the live notification (digest instead, §6.5). */
  quiet?: boolean;
  /** invoked once this turn has fully finalized — the follower advances its
   *  journal offset here. */
  onFinalized?: () => void;
  /** the original send, so a usage-limit rotation can re-run this exact turn
   *  under a different login. Undefined for journal/cloud turns (they don't
   *  rotate). */
  send?: SendOpts;
  /** the login this turn ran under (default when omitted). */
  loginId?: string;
}

/**
 * The per-turn pipeline, shared by a local spawn (`startAgent`) and a cloud
 * journal replay (services/cloud follower). Registers the run, wires the child
 * through the same `wireAdapterStream` → `emit` → `finalize` path, and marks the
 * workspace running. The only variation between the two callers is the
 * `HostChild` implementation (a real process vs a `JournalChild`).
 */
export function beginTurn(
  ws: Workspace,
  agentId: number,
  adapter: HarnessAdapter,
  child: HostChild,
  opts: BeginTurnOpts
): void {
  const handle: RunHandle = {
    child,
    adapter,
    workspaceId: ws.id,
    agentId,
    turnId: opts.turnId,
    stream: newBlockStream(),
    doneHandled: false,
    stopped: false,
    stderrTail: '',
    startedAt: Date.now(),
    context: null,
    limit: null,
    loginId: opts.loginId ?? DEFAULT_LOGIN_ID,
    send: opts.send,
    quiet: opts.quiet,
    onFinalized: opts.onFinalized,
  };
  runs.set(runKey(ws.id, agentId), handle);
  setWorkspaceStatus(ws, 'running');

  // Client-minted session id (grok `-s <id>` creates-or-resumes): store it exactly
  // as if the CLI had emitted a {kind:'session'} event, so the next turn resumes it.
  // Belt-and-braces: a later session event from the stream with the same id is a no-op.
  if (opts.sessionHint) applyEvent(handle, { kind: 'session', sessionId: opts.sessionHint });

  const emit = (event: AgentEvent) => {
    const blocksChanged = applyEvent(handle, event);
    // Task events reach the renderer on their own channel (they belong to the
    // chat, not the turn) — and the turn's stream must not carry them: a
    // `chat:event` arriving after `done` re-marks the agent as running, and the
    // CLI reports its end-of-turn task reaping *after* the result. `limit` is
    // pure bookkeeping (finalize reads it) — never broadcast, same as `task`.
    if (event.kind !== 'task' && event.kind !== 'limit')
      broadcast('chat:event', { workspaceId: ws.id, agentId, event });
    // Mirror the growing turn to Maestro Web as blocks arrive (§6.3). The hook
    // no-ops for cloud turns (they stream via the box journal) and when unlinked.
    if (blocksChanged) scheduleLivePublish(handle);
    if (event.kind === 'done') void finalize(handle, event);
  };

  child.onError((err) => {
    emit({ kind: 'done', ok: false, error: `Failed to start ${opts.cmdName}: ${err.message}` });
  });

  wireAdapterStream(child, adapter, opts.stdin, emit, (chunk) => {
    handle.stderrTail = (handle.stderrTail + chunk).slice(-2000);
  });

  child.onClose((code) => {
    // The process that owned this chat's background tasks is gone, so any task
    // still marked running died with it — record that before the turn wraps up.
    reapBackgroundTasks(ws.id, agentId);
    if (!handle.doneHandled) {
      // Adapter never emitted done (crash / raw adapters): synthesize it.
      if (adapter.implicitSession) {
        Workspaces.setSession(ws.id, agentId, adapter.implicitSession);
      }
      emit({
        kind: 'done',
        ok: handle.stopped || code === 0,
        error: handle.stopped ? undefined : code !== 0 ? handle.stderrTail.trim() || `exit code ${code}` : undefined,
      });
    }
  });
}

export function stopAgent(workspaceId: string, agentId: number) {
  // Kill any specialist sub-agents this turn spawned first (they'd otherwise
  // outlive the orchestrator that was waiting on them).
  subagentStopHook?.(workspaceId, agentId);
  const handle = runs.get(runKey(workspaceId, agentId));
  if (!handle) return;
  handle.stopped = true;
  try {
    handle.child.kill('SIGTERM');
  } catch {}
  setTimeout(() => {
    if (!handle.doneHandled) {
      try {
        handle.child.kill('SIGKILL');
      } catch {}
    }
  }, 3000);
}

export function stopWorkspaceAgents(workspaceId: string) {
  for (const agentId of runningAgents(workspaceId)) stopAgent(workspaceId, agentId);
}

/**
 * App quit. Local turns are killed (they can't survive the process). Cloud turns
 * are deliberately left running on the box — that survival is the whole feature
 * (§6.4) — so we drop their in-memory handle without touching the process group;
 * the app re-tails the journal and catches up on next launch.
 */
export function stopAllAgents() {
  subagentStopHook?.(null, null);
  for (const [key, h] of runs) {
    const ws = Workspaces.get(h.workspaceId);
    if (ws && isCloudWorkspace(ws)) continue;
    h.stopped = true;
    try {
      h.child.kill('SIGKILL');
    } catch {}
    runs.delete(key);
  }
}

// One-shot text generation (PR descriptions, workspace titles) lives in
// services/llm — this module runs agent *turns*.
