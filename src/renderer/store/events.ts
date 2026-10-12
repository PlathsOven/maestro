import type { StoreApi } from 'zustand';
import type { AgentEvent, Workspace } from '../../shared/types';
import { on as onMain } from '../lib/api';
import { playCompletionSound, playQuestionSound } from '../lib/sounds';
import { reduceLiveTurnEvent, turnKey, type LiveTurnSlices } from '../lib/liveTurn';
import { EMPTY_ARR, capsOf, patchChatMeta } from './helpers';
import type { AppState } from './app';

/** A queued stream event; `at` is its arrival, which stamps a turn it starts. */
type StreamedEvent = { workspaceId: string; agentId: number; event: AgentEvent; at: number };

/**
 * Streamed `chat:event`s are applied in batches, at most one store update per
 * STREAM_FLUSH_MS, not one per event. Each update re-renders the live turn and
 * re-parses its whole (growing) markdown, so per-token updates made a long
 * answer cost O(n²) and kept an older CPU ~80% busy for the whole stream;
 * batched, it's under half that. Any other push from main, and the store
 * actions that edit live turns, flush the queue first (`flushChatEvents`), so
 * ordering against everything else is as if each event had applied on arrival.
 */
const STREAM_FLUSH_MS = 50;
let pendingChat: StreamedEvent[] = [];
let flushChat: () => void = () => {};

/** Apply any queued streamed events now. */
export function flushChatEvents(): void {
  flushChat();
}

/** Store-internal helpers (closures over `set`) the subscriptions share with
 *  the store's actions. */
export interface EventHelpers {
  patchWorkspace: (ws: Workspace) => void;
  evictEditor: (wsId: string) => void;
}

/**
 * Push event wiring: mirrors main's broadcasts into the store. Called once,
 * from `init`, after the first `app:init` snapshot has been applied.
 */
export function subscribeToMain(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  { patchWorkspace, evictEditor }: EventHelpers
): void {
  /** The in-app half of notifications: Maestro is in front but the user is
   *  looking at another workspace, so an OS notification would never show —
   *  a toast names the workspace, with a one-click jump to the chat. (In the
   *  background, main's OS notification covers it.) */
  const toastOffscreen = (workspaceId: string, agentId: number, kind: 'success' | 'info', what: string) => {
    const s = get();
    if (!s.settings.notifications || !document.hasFocus()) return;
    if (s.activeWorkspaceId === workspaceId && !s.showWorkspaces) return;
    const ws = s.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    s.toast(kind, `${ws.title ?? ws.name} ${what}`, {
      label: 'Open',
      run: () => get().openChat(workspaceId, agentId),
    });
  };

  let timer = 0;
  const applyChatEvents = () => {
    clearTimeout(timer);
    timer = 0;
    if (!pendingChat.length) return;
    const batch = pendingChat;
    pendingChat = [];
    const s = get();
    let slices: LiveTurnSlices = { liveTurns: s.liveTurns, runningAgents: s.runningAgents, pendingAsks: s.pendingAsks };
    let chatsMeta = s.chatsMeta;
    const finished: { workspaceId: string; agentId: number; attention: boolean }[] = [];
    for (const { workspaceId, agentId, event, at } of batch) {
      if (event.kind === 'context') {
        // Per-API-call measurement — the ring ticks live during long turns.
        chatsMeta = patchChatMeta(chatsMeta, workspaceId, agentId, {
          contextTokens: event.contextTokens,
          usage: event.usage,
        });
        continue;
      }
      // Completion chime — plays ONCE when an agent finishes a turn, in any
      // workspace. Guarded on the turn still being marked running so a harness
      // that emits several `done` events (e.g. codex retrying a failed
      // connection) doesn't replay it 5×. Independent of the OS notification
      // (which only fires when Maestro is backgrounded); disabled by "No sound".
      if (event.kind === 'done' && slices.liveTurns[turnKey(workspaceId, agentId)]?.running)
        finished.push({ workspaceId, agentId, attention: !event.ok || !!event.needsAttention });
      slices = reduceLiveTurnEvent(slices, workspaceId, agentId, event, at);
      // context ring data — merged here so it survives without a refetch
      if (event.kind === 'done' && event.contextTokens)
        chatsMeta = patchChatMeta(chatsMeta, workspaceId, agentId, { contextTokens: event.contextTokens });
    }
    set(chatsMeta === s.chatsMeta ? slices : { ...slices, chatsMeta });
    if (finished.length) playCompletionSound(get().settings.completionSound);
    for (const f of finished) toastOffscreen(f.workspaceId, f.agentId, f.attention ? 'info' : 'success', f.attention ? 'needs attention' : 'finished');
  };
  flushChat = applyChatEvents;
  const scheduleChatEvents = () => {
    timer ||= window.setTimeout(applyChatEvents, STREAM_FLUSH_MS);
  };
  // Every other push flushes the queued stream first, preserving event order.
  const on: typeof onMain = (channel, callback) =>
    onMain(channel, (data) => {
      applyChatEvents();
      callback(data);
    });

  on('ws:updated', (ws) => {
    patchWorkspace(ws);
    // Persisted PR identity disagrees with the live status this renderer has
    // shown (agent opened a PR out-of-band) → re-fetch. Cheap: main's forced
    // refresh just filled the gh cache, so this is a cache hit.
    const cached = get().prStatus[ws.id];
    if (cached !== undefined && ((cached?.number ?? null) !== ws.prNumber || (cached?.state ?? null) !== ws.prState)) {
      void get().refreshPr(ws.id);
    }
    const c = capsOf(get(), ws.projectId);
    if (!ws.archived && (c.git || c.checkpoints)) get().refreshDiffStat(ws.id);
    // Main owns the truth about running agents: while any agent runs the
    // status is 'running'. Anything else ⇒ drop stale renderer run state.
    if (ws.status !== 'running' && ws.status !== 'setting-up') {
      set((s) => {
        const staleRunning = (s.runningAgents[ws.id] ?? []).length > 0;
        const staleTurnKeys = Object.entries(s.liveTurns)
          .filter(([k, t]) => k.startsWith(`${ws.id}:`) && t?.running)
          .map(([k]) => k);
        if (!staleRunning && staleTurnKeys.length === 0) return {};
        const liveTurns = { ...s.liveTurns };
        for (const k of staleTurnKeys) delete liveTurns[k];
        return { runningAgents: { ...s.runningAgents, [ws.id]: [] }, liveTurns };
      });
    }
  });
  // Main pushes authoritative PR status after any refresh it runs itself
  // (turn end, background poll, merge) — mirror it so the header action
  // (Create PR → Merge / Resolve → Merged) flips without a UI-side fetch.
  on('pr:status', ({ workspaceId, pr }) => {
    set((s) => ({ prStatus: { ...s.prStatus, [workspaceId]: pr } }));
  });
  on('app:openChat', ({ workspaceId, agentId }) => get().openChat(workspaceId, agentId));
  on('ws:removed', ({ workspaceId }) => {
    evictEditor(workspaceId);
    set((s) => {
      const previewByWs = { ...s.previewByWs };
      delete previewByWs[workspaceId];
      return {
        workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
        activeWorkspaceId: s.activeWorkspaceId === workspaceId ? null : s.activeWorkspaceId,
        previewByWs,
        annotate: s.annotate?.wsId === workspaceId ? null : s.annotate,
      };
    });
  });
  // Authoritative preview facts (URL, nav, console counts, agent activity).
  on('preview:state', (p) => get().setPreviewState(p));
  // Dev-server port liveness for the Preview tab pulse (§5).
  on('port:state', ({ workspaceId, listening }) =>
    set((s) => ({ portUpByWs: { ...s.portUpByWs, [workspaceId]: listening } }))
  );
  on('chat:message', (msg) => {
    set((s) => {
      const list = s.messages[msg.workspaceId];
      // A workspace whose transcript isn't loaded — never opened, or evicted
      // (§4.9.5) — has nothing to append to, and seeding it with this one
      // message would make the lazy loader (`!s.messages[wsId]`, see
      // loadWorkspaceData) skip `chat:list` and show a one-message chat.
      // Leave the slice absent: selecting the workspace loads the full
      // history including this row (main persists before it broadcasts, and
      // the reply to a `chat:list` sent earlier arrives before this push).
      // Mirrored (harness-sync) rows use deterministic ids and can re-arrive on
      // a re-ingest; replace an existing id in place instead of appending a dup.
      const existingIdx = list ? list.findIndex((m) => m.id === msg.id) : -1;
      const messages = !list
        ? s.messages
        : {
            ...s.messages,
            [msg.workspaceId]: existingIdx >= 0 ? list.map((m) => (m.id === msg.id ? msg : m)) : [...list, msg],
          };
      const liveTurns = { ...s.liveTurns };
      const pendingAsks = s.pendingAsks;
      let asks = pendingAsks;
      let runningAgents = s.runningAgents;
      if ((msg.role === 'agent' || msg.role === 'system') && !msg.meta?.midTurn) {
        // A persisted agent/system message means that agent's run is over —
        // except a note Maestro posts *during* the turn (`midTurn`).
        const key = turnKey(msg.workspaceId, msg.agentId);
        delete liveTurns[key];
        const wasRunning = s.runningAgents[msg.workspaceId] ?? EMPTY_ARR;
        const running = wasRunning.filter((a) => a !== msg.agentId);
        // Keep the old identity when this agent wasn't running anyway (a
        // mirrored row): every sidebar stack watches this map.
        runningAgents =
          running.length === wasRunning.length ? s.runningAgents : { ...s.runningAgents, [msg.workspaceId]: running };
        // The turn is over, so no question can still be waiting — drop any
        // stale picker (safety net if an `ask:resolved` was missed).
        if (pendingAsks[key]) {
          asks = { ...pendingAsks };
          delete asks[key];
        }
      }
      return { messages, liveTurns, runningAgents, pendingAsks: asks };
    });
  });

  // A specialist run was created or advanced — upsert it under its parent
  // turn so the response dropdown + preview reflect it live and after reload.
  on('subagent:updated', (run) => {
    set((s) => {
      const list = s.subagentRuns[run.parentMessageId] ?? [];
      const idx = list.findIndex((r) => r.id === run.id);
      const next = idx >= 0 ? list.map((r) => (r.id === run.id ? run : r)) : [...list, run];
      return { subagentRuns: { ...s.subagentRuns, [run.parentMessageId]: next } };
    });
  });
  // An agent is blocked asking the user something — surface the picker in its
  // live turn. `ask:resolved` (answer, dismiss, or a killed run) clears it.
  on('ask:question', (payload) => {
    set((s) => ({
      pendingAsks: { ...s.pendingAsks, [turnKey(payload.workspaceId, payload.agentId)]: payload },
    }));
    // The agent is blocked until the user answers — alert them by ear with the
    // dedicated question sound (never the completion chime: "needs you" must
    // not sound like "done").
    if (get().settings.questionSound) playQuestionSound();
    toastOffscreen(payload.workspaceId, payload.agentId, 'info', 'has a question');
  });
  on('ask:resolved', ({ workspaceId, agentId }) => {
    set((s) => {
      const pendingAsks = { ...s.pendingAsks };
      delete pendingAsks[turnKey(workspaceId, agentId)];
      return { pendingAsks };
    });
  });
  onMain('chat:event', ({ workspaceId, agentId, event }) => {
    // Bookkeeping-only events must not create turns or mark agents running —
    // a trailing one after `done` would leave a zombie "Thinking…" state.
    // (Main routes background tasks to 'chat:tasks' instead; guarded here too
    // because those legitimately arrive after the turn's `done`.)
    if (event.kind === 'session' || event.kind === 'status' || event.kind === 'task' || event.kind === 'limit')
      return;
    pendingChat.push({ workspaceId, agentId, event, at: Date.now() });
    scheduleChatEvents();
  });
  on('chat:queue', ({ workspaceId, agentId, items }) => {
    set((s) => ({ queued: { ...s.queued, [`${workspaceId}:${agentId}`]: items } }));
  });
  on('chat:scheduled', ({ workspaceId, agentId, items }) => {
    set((s) => ({ scheduled: { ...s.scheduled, [`${workspaceId}:${agentId}`]: items } }));
  });
  on('chat:tasks', ({ workspaceId, agentId, tasks }) => {
    set((s) => ({ bgTasks: { ...s.bgTasks, [`${workspaceId}:${agentId}`]: tasks } }));
  });
  on('chat:meta:updated', ({ workspaceId, agentId, meta }) => {
    const prev = get().chatsMeta[workspaceId]?.[String(agentId)];
    // Authoritative merged meta from main (titles, attention, read marks…).
    set((s) => ({
      chatsMeta: {
        ...s.chatsMeta,
        [workspaceId]: { ...s.chatsMeta[workspaceId], [String(agentId)]: meta },
      },
    }));
    // Tabs are seeded from meta once per session, so a chat created, restored or
    // closed elsewhere (Maestro Web's chat_new/chat_restore/chat_close jobs) only
    // reaches an already-loaded workspace here. Local tab actions update chatIds
    // before their meta write echoes back, so for them this is a no-op.
    const s = get();
    const ids = s.chatIds[workspaceId];
    if (!ids) return; // not seeded yet — seeding reads meta
    const open = ids.includes(agentId);
    if (meta.closed && open && !prev?.closed) s.closeChat(workspaceId, agentId);
    else if (!meta.closed && !open && (prev?.closed || agentId > (s.agentCount[workspaceId] ?? 1)))
      // Background tab: focus stays put. Drop any ⇧⌘T entry so it can't go stale.
      set({
        chatIds: { ...s.chatIds, [workspaceId]: [...ids, agentId] },
        agentCount: { ...s.agentCount, [workspaceId]: Math.max(s.agentCount[workspaceId] ?? 1, agentId) },
        closedTabs: { ...s.closedTabs, [workspaceId]: (s.closedTabs[workspaceId] ?? []).filter((e) => e.agentId !== agentId) },
      });
  });
  on('harnessSync:status', (status) => set({ harnessSyncStatus: status }));
  on('gh:auth', (p) => {
    if (p.phase === 'success' && p.auth) {
      set((s) => ({
        ghAuth: p.auth,
        ghSignIn: null,
        // Reopen the modal that launched sign-in (e.g. clone-repo), if any.
        modal: s.modal?.kind === 'github-signin' ? s.ghSignInReturn : s.modal,
        ghSignInReturn: null,
      }));
      get().toast(
        'success',
        p.auth.user ? `Signed in to GitHub as @${p.auth.user}` : 'Signed in to GitHub'
      );
      // gh auth is a per-host input to the githubRemote rung — re-derive caps
      // so PR chrome appears without a reload.
      for (const proj of get().projects) void get().refreshCaps(proj.id);
    } else if (p.phase === 'error') {
      set((s) => ({
        ghSignIn: {
          userCode: s.ghSignIn?.userCode ?? '',
          verificationUri: s.ghSignIn?.verificationUri ?? '',
          status: 'error',
          message: p.message ?? 'GitHub sign-in failed',
        },
      }));
    }
  });
  // A default model/effort/harness or a theme set on Maestro Web lands in
  // main (settings-sync); adopt it so the composer's chips and the theme
  // follow at once.
  on('settings:updated', (next) => {
    set({ settings: next });
    get().applyTheme();
  });
  on('account:auth', (p) => {
    // The relay dropped this desktop's link (web "Reset Maestro Web" or a
    // device revoke). SettingsModal refreshes its own status; surface a toast
    // too so the sign-out isn't silent. Only the revoked case — an explicit
    // sign-out and normal link success/error are handled elsewhere.
    if (p.phase === 'signedout' && p.reason === 'revoked')
      get().toast('info', 'Signed out of Maestro Web — its cloud data was reset. Link again to reconnect.');
  });
  on('script:state', ({ workspaceId, kind, state }) => {
    set((s) => {
      const idle = { running: false, exitCode: null, startedAt: null };
      const cur = s.scripts[workspaceId] ?? { setup: idle, run: idle, spotlight: idle };
      return { scripts: { ...s.scripts, [workspaceId]: { ...cur, [kind]: state } } };
    });
  });
  on('status:state', ({ key, generating, report, error }) => {
    set((s) => {
      const cur = s.statusByKey[key];
      return {
        statusByKey: {
          ...s.statusByKey,
          [key]: {
            report: report ?? cur?.report ?? null,
            stale: report ? false : cur?.stale ?? true,
            generating,
            error,
          },
        },
      };
    });
  });
  on('runscript:changed', ({ workspaceId, scripts }) => {
    set((s) => {
      // A deleted script takes its dock terminal tab with it; if that tab was
      // showing, fall back to the Run (cards) tab.
      const live = new Set(scripts.map((sc) => sc.id));
      const openIds = s.dockRunIds[workspaceId] ?? EMPTY_ARR;
      const keptIds = openIds.filter((id) => live.has(id));
      const patch: Partial<AppState> = { runScripts: { ...s.runScripts, [workspaceId]: scripts } };
      if (keptIds.length !== openIds.length) {
        patch.dockRunIds = { ...s.dockRunIds, [workspaceId]: keptIds };
        const cur = s.dockTab[workspaceId];
        if (cur?.startsWith('rs:') && !live.has(cur.slice(3))) {
          patch.dockTab = { ...s.dockTab, [workspaceId]: 'run' };
        }
      }
      return patch;
    });
  });
  on('runscript:state', ({ workspaceId, scriptId, state }) => {
    set((s) => ({ runScriptStates: { ...s.runScriptStates, [`${workspaceId}:${scriptId}`]: state } }));
  });
  on('runscript:generating', ({ workspaceId, generating, error }) => {
    set((s) => ({
      rsGenerating: { ...s.rsGenerating, [workspaceId]: generating },
      rsGenError: { ...s.rsGenError, [workspaceId]: error },
    }));
  });
  on('host:state', ({ hostId, state, message }) => {
    set((s) => ({ hostStates: { ...s.hostStates, [hostId]: state } }));
    if (state === 'error' && message) get().toast('error', `SSH: ${message}`);
  });
}
