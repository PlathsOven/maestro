import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowRight, ArrowUp, Asterisk, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, Loader2, Mic, NotebookPen, Pencil, Plus, Search, Sparkles, Square, Terminal as TerminalIcon, Waypoints, X } from 'lucide-react';
import { invoke, on, tryInvoke } from '../lib/api';
import { EMPTY_ARR, useApp } from '../store/app';
import { probeDictationSupport, useDictation } from '../lib/dictation';
import { AttachmentChip } from './ChatPanel';
import { EffortBars, EffortOptions, PickerOption, Spinner, readFilesAsBase64, useDismissFromParent, useFileDrop } from './common';
import { formatElapsed, RunTimer } from './RunTimer';
import { ContextRing } from '../../shared/ui/composer/ContextRing';
import RolesMenu from './RolesMenu';
import { contextWindowForModel, effortLevelsFor, useHarnessModels } from '../lib/harnessModels';
import {
  HARNESS_DISPLAY,
  HARNESS_PLAN_MODE,
  resolveDefaultEffort,
  resolveDefaultModel,
  resolveEffortLevel,
  type BackgroundTask,
  type ContextUsage,
  type HarnessId,
  type HarnessInfo,
  type RemoteHarnessStatus,
  type HarnessLogins,
  type HarnessLoginView,
  type ScheduledMessage,
  type SkillEntry,
  type SubUsage,
  type Workspace,
} from '../../shared/types';
import { limitResetTarget } from '../../shared/limits';
import { matchesShortcut } from '../../shared/shortcuts';
import { useShortcuts } from '../lib/shortcuts';

export default function Composer({
  workspace,
  agentId: agentIdProp,
}: {
  workspace: Workspace;
  /** which session this composer sends to. Defaults to the focused chat; passed
   *  explicitly by each split pane so every pane has its own composer. */
  agentId?: number;
}) {
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  // "/" at the start of the message opens the skills menu (narrows as you type).
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const [modelMenu, setModelMenu] = useState(false);
  const [effortMenu, setEffortMenu] = useState(false);
  const [rolesMenu, setRolesMenu] = useState(false);
  const [scheduleMenu, setScheduleMenu] = useState(false);
  const [focused, setFocused] = useState(false);
  // Install + sign-in state of EVERY harness on the remote host — the single
  // source of truth for the banner, the model picker, AND send-gating, so they
  // all resolve together (null = local project, or the probe is still in flight).
  const [remoteHarnesses, setRemoteHarnesses] = useState<RemoteHarnessStatus[] | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const focusedAgent = useApp((s) => s.composerAgent[workspace.id] ?? 1);
  const agentId = agentIdProp ?? focusedAgent;
  const isFocusedPane = agentId === focusedAgent;
  const attachments = useApp((s) => s.composerAttachments[`${workspace.id}:${agentId}`]) ?? EMPTY_ARR;
  // Draft text is scoped to the session (workspace + chat) so a new tab/session
  // starts with an empty box and each session keeps its own unsent text.
  const text = useApp((s) => s.composerDrafts[`${workspace.id}:${agentId}`]) ?? '';
  const setText = (v: string) => useApp.getState().setComposerDraft(workspace.id, agentId, v);
  const running = useApp((s) => s.runningAgents[workspace.id]) ?? EMPTY_ARR;
  const chatMeta = useApp((s) => s.chatsMeta[workspace.id]?.[String(agentId)]);
  const settings = useApp((s) => s.settings);
  const harnesses = useApp((s) => s.harnesses);
  const focusNonce = useApp((s) => s.focusComposerNonce);
  const keys = useShortcuts();
  const platform = useApp((s) => s.platform);
  const agentRunning = running.includes(agentId);
  // The workspace's effective host: a per-conversation cloud override
  // (workspace.hostId) wins over the project's host, so the readiness gating and
  // "Install & sign in" flow apply to a cloud workspace of a local project too.
  const projectHostId = useApp(
    (s) => workspace.hostId ?? s.projects.find((p) => p.id === workspace.projectId)?.hostId ?? null
  );
  // This chat runs on a remote host: the schedule popover then promises box-side
  // delivery, and scheduling routes through the box (§4).
  const remoteChat = !!projectHostId;
  // Managed install / sign-in progress (per workspace+harness) — kept in the
  // store so an in-flight install survives unmounts and workspace switches.
  const remoteSetup = useApp((s) => s.remoteSetup);

  // For remote projects, probe every harness on the host up front (cached in
  // main). ONE fetch drives the banner, the picker, and send-gating — so a
  // message can't be sent, and the chips don't re-enable, until the SAME check
  // the dropdown shows has actually finished. Local projects never enter here.
  useEffect(() => {
    if (!projectHostId) {
      setRemoteHarnesses(null);
      return;
    }
    let alive = true;
    setRemoteHarnesses(null); // loading
    void tryInvoke('harness:remoteList', { workspaceId: workspace.id }).then(({ data }) => {
      // `[]` (not null) on failure so the gate always resolves — a failed probe
      // falls back to set-up affordances / the send-time pre-check, never a hang.
      if (alive) setRemoteHarnesses(data ?? []);
    });
    return () => {
      alive = false;
    };
  }, [workspace.id, projectHostId]);

  // Self-clearing readiness: while the current harness isn't ready on the host —
  // or a managed install / terminal sign-in is underway — re-probe every few
  // seconds and fold the fresh status in. Completing `claude login` in the
  // terminal simply makes the banner and picker badges resolve themselves; there
  // is no manual "re-check" step. Cheap: main caches probes, so a not-ready
  // harness costs at most one shell round-trip per ~8s.
  useEffect(() => {
    if (!projectHostId || !remoteHarnesses) return;
    const targets = remoteHarnesses
      .filter((r) => {
        if (r.harness === 'shell') return false;
        const st = remoteSetup[`${workspace.id}:${r.harness}`];
        if (st) return st.phase !== 'error'; // installing / waiting on sign-in
        return r.harness === workspace.harness && (!r.installed || !r.authed); // banner is up
      })
      .map((r) => r.harness);
    if (targets.length === 0) return;
    let alive = true;
    const t = setInterval(() => {
      for (const h of targets)
        void tryInvoke('harness:remoteProbe', { workspaceId: workspace.id, harness: h }).then(({ data }) => {
          if (!alive || !data) return;
          setRemoteHarnesses((list) => {
            const prev = list?.find((r) => r.harness === data.harness);
            // Swap only on a real change, so this effect's deps stay stable.
            if (!prev || (prev.installed === data.installed && prev.authed === data.authed)) return list;
            return list!.map((r) => (r.harness === data.harness ? data : r));
          });
          if (data.installed && data.authed) useApp.getState().remoteSetupClear(workspace.id, data.harness);
        });
    }, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectHostId, workspace.id, workspace.harness, remoteHarnesses, remoteSetup]);

  const HM = useHarnessModels();
  const models = HM[workspace.harness] ?? [{ id: '', label: 'Default' }];
  // Both fall back to the user's pinned default (else the built-in one) and are
  // resolved to a concrete value shown explicitly in the UI.
  const defaultModel = resolveDefaultModel(workspace.harness, settings.defaultModels);
  const model = chatMeta?.model || defaultModel;
  const modelLabel = models.find((m) => m.id === model)?.label ?? (model || 'Default');
  // The model menu lists every harness's models (grouped), not just this workspace's
  // — picking one from another harness switches the workspace to it. Ready harnesses
  // (installed or logged-in) sort first; the rest stay visible but disabled, with a
  // link to set them up in Settings. Mirrors the new-workspace picker.
  //
  // Remote (SSH) workspaces gate on whether the harness is installed AND signed in
  // ON THE SERVER (the CLI runs there); a not-yet-loaded probe counts as NOT ready,
  // so models stay disabled behind a spinner until we're sure — never optimistically
  // selectable. Local projects (folders + git repos) are untouched: same local
  // detection as before, no probe, no loading gate.
  const remoteLoading = !!projectHostId && !remoteHarnesses;
  const harnessReady = (h: HarnessInfo) => {
    if (projectHostId) {
      if (!remoteHarnesses) return false; // still probing — disabled until known
      // A remote harness is only usable when it's installed AND signed in on the
      // host — an installed-but-signed-out CLI 401s on send, so gate on both.
      const r = remoteHarnesses.find((rh) => rh.harness === h.id);
      return !!r?.installed && !!r?.authed;
    }
    return h.installed || !!h.connected;
  };
  const harnessGroups = useMemo(() => {
    const sorted = [...harnesses].sort((a, b) => Number(harnessReady(b)) - Number(harnessReady(a)));
    if (sorted.length) return sorted;
    // Harness detection hasn't landed yet — still offer the current harness's models
    // so the picker is never empty (matches pre-grouping behavior).
    return [
      { id: workspace.harness, displayName: HARNESS_DISPLAY[workspace.harness] ?? workspace.harness, installed: true, version: null, connected: true },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnesses, workspace.harness, projectHostId, remoteHarnesses]);
  // The current workspace harness's status, pulled from the SAME list the picker
  // uses — so send-gating and the dropdown's "checking…" resolve in lockstep.
  const remoteCurrent = projectHostId
    ? remoteHarnesses?.find((r) => r.harness === workspace.harness) ?? null
    : null;
  // Managed-setup progress for the current harness — picks the banner's
  // installing / signing-in / error variant.
  const curSetup = projectHostId ? remoteSetup[`${workspace.id}:${workspace.harness}`] : undefined;
  // Send-gating on the current harness's host readiness (remote only). Because it
  // reads `remoteHarnesses` — the exact value that clears the dropdown spinner —
  // send can't re-enable while the picker still shows "checking…". Shell always
  // works; local projects are never gated. `remoteBlocked` covers a known
  // not-installed / signed-out harness (the banner explains the fix); a failed
  // probe (list = []) leaves `remoteCurrent` null → not blocked → the send-time
  // pre-check handles it, so a transient probe error never wedges the composer.
  const harnessGated = !!projectHostId && workspace.harness !== 'shell';
  const remoteChecking = harnessGated && !remoteHarnesses;
  const remoteBlocked = harnessGated && !!remoteCurrent && (!remoteCurrent.installed || !remoteCurrent.authed);
  const sendBlockReason = remoteChecking
    ? `Checking ${HARNESS_DISPLAY[workspace.harness] ?? workspace.harness} is set up on the server…`
    : remoteBlocked
      ? `${remoteCurrent!.bin} isn’t ready on the server yet — set it up above, then send`
      : null;
  // Queuing onto a running agent is always fine — its harness already works — so
  // the readiness gate only applies when we'd START a fresh turn.
  const blockSend = !agentRunning && !!sendBlockReason;
  const nothingToSend = !text.trim() && attachments.length === 0;

  const defaultEffort = resolveDefaultEffort(settings.defaultEffort);
  const effort = chatMeta?.effort || defaultEffort;
  // Effort levels are per-model (Codex's differ from Claude's; Haiku has none),
  // so the chip + menu follow the selected model and hide when it has no levels.
  const effortLevels = effortLevelsFor(workspace.harness, model, HM);
  const effortLevel = resolveEffortLevel(effort, effortLevels);
  const contextTokens = chatMeta?.contextTokens ?? 0;
  const rolesCount = chatMeta?.enabledRoles?.length ?? 0;
  // Plan-mode chip: only for harnesses with a plan-style mode (the tooltip text
  // doubles as the capability flag). "On" also reflects the global permission
  // mode being 'plan' (Settings), which already covers every chat.
  const planTip = HARNESS_PLAN_MODE[workspace.harness];
  const globalPlan = settings.permissionMode === 'plan';
  const planOn = !!chatMeta?.planMode || globalPlan;
  const queued = useApp((s) => s.queued[`${workspace.id}:${agentId}`]) ?? EMPTY_ARR;
  const scheduled = useApp((s) => s.scheduled[`${workspace.id}:${agentId}`]) ?? EMPTY_ARR;
  const bgTasks = useApp((s) => s.bgTasks[`${workspace.id}:${agentId}`]) ?? EMPTY_ARR;
  const skills = useApp((s) => s.skills[workspace.id]);

  // Drives the usage donut/popover and the send-later menu's "when limits
  // reset". Both read the ACTIVE login — the one the next message runs under.
  const { logins, reload: reloadLogins } = useHarnessLogins(workspace.harness, agentRunning);
  const usage = logins?.logins.find((l) => l.id === logins.activeId)?.usage ?? null;

  // ---- voice dictation + optional prompt refinement (on send) ----
  const [refining, setRefining] = useState(false);
  const baseTextRef = useRef(''); // text already in the box when dictation started
  // On-device dictation support is probed in the main process (macOS only), so
  // the mic button only appears where it can actually work.
  const [canDictate, setCanDictate] = useState(false);
  useEffect(() => {
    let alive = true;
    void probeDictationSupport().then((r) => {
      if (alive) setCanDictate(r.supported);
    });
    return () => {
      alive = false;
    };
  }, []);

  const joinText = (base: string, add: string) => {
    const b = base.replace(/\s+$/, '');
    if (!b) return add;
    if (!add) return base;
    return `${b} ${add}`;
  };

  // Dictation just fills the box; refinement (if enabled) happens on send, so a
  // typed prompt and a dictated one are treated identically.
  const dictation = useDictation({
    onText: (t) => setText(joinText(baseTextRef.current, t)),
    onDone: (finalText) => {
      if (finalText) setText(joinText(baseTextRef.current, finalText));
    },
    onError: (msg) => useApp.getState().toast('error', msg),
  });

  const onMicClick = () => {
    if (dictation.listening) {
      dictation.stop();
      return;
    }
    baseTextRef.current = text;
    taRef.current?.focus();
    dictation.start();
  };

  // auto-grow
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  }, [text]);

  // ⌘L focus (from menu/shortcut) + focus when switching chats. In split view
  // only the focused pane's composer reacts, so the panes don't fight for focus.
  useEffect(() => {
    if (focusNonce > 0 && isFocusedPane) taRef.current?.focus();
  }, [focusNonce, isFocusedPane]);
  useEffect(() => {
    setMention(null);
    setSlash(null);
    if (isFocusedPane) taRef.current?.focus();
  }, [agentId, workspace.id, isFocusedPane]);


  const loadFiles = useCallback(async () => {
    if (files) return files;
    const { data } = await tryInvoke('git:files', { workspaceId: workspace.id });
    const list = data ?? [];
    setFiles(list);
    return list;
  }, [files, workspace.id]);

  const mentionMatches = useMemo(() => {
    if (!mention || !files) return [];
    const q = mention.query.toLowerCase();
    const hit = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    return hit
      .sort((a, b) => a.length - b.length)
      .slice(0, 8)
      .map((f) => {
        const di = q ? f.toLowerCase().indexOf(q) : -1;
        return { f, hits: di >= 0 ? range(di, di + q.length) : NO_HITS };
      });
  }, [mention, files]);

  // Ranked in tiers so the strongest signal wins, with the matched characters
  // carried through (nameHits / descHits) for highlighting — so the user sees
  // *why* each result matched:
  //   0) name contains the query as a substring (earliest position first)
  //   1) name matches as a fuzzy subsequence (kept in list order)
  //   2) query is only in the description (substring)
  const slashMatches = useMemo(() => {
    if (!slash || !skills) return [];
    const q = slash.query.toLowerCase();
    if (!q) return skills.map((s) => ({ s, nameHits: NO_HITS, descHits: NO_HITS }));
    const out: { s: SkillEntry; tier: number; key: number; nameHits: number[]; descHits: number[] }[] = [];
    skills.forEach((s, idx) => {
      const sub = s.name.toLowerCase().indexOf(q);
      if (sub >= 0) {
        out.push({ s, tier: 0, key: sub, nameHits: range(sub, sub + q.length), descHits: NO_HITS });
        return;
      }
      const fuzzy = fuzzyMatch(q, s.name);
      if (fuzzy) {
        out.push({ s, tier: 1, key: idx, nameHits: fuzzy, descHits: NO_HITS });
        return;
      }
      const di = s.description.toLowerCase().indexOf(q);
      if (di >= 0) out.push({ s, tier: 2, key: idx, nameHits: NO_HITS, descHits: range(di, di + q.length) });
    });
    return out.sort((a, b) => a.tier - b.tier || a.key - b.key).slice(0, 50);
  }, [slash, skills]);

  // Keep the highlighted skill visible while arrowing through a long menu.
  const slashListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    slashListRef.current?.children[slashIdx]?.scrollIntoView({ block: 'nearest' });
  }, [slashIdx]);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setText(v);
    const caret = e.target.selectionStart;
    const before = v.slice(0, caret);
    // Slash command: the whole text before the caret is "/partial-name" —
    // skills are message-initial, like the harness CLIs treat them.
    const sm = before.match(/^\/([\w.:-]*)$/);
    if (sm) {
      setSlash({ query: sm[1] });
      setSlashIdx(0);
      if (!skills) void useApp.getState().loadSkills(workspace.id);
    } else {
      setSlash(null);
    }
    const m = before.match(/(?:^|[\s(])@([\w./-]*)$/);
    if (m) {
      setMention({ query: m[1], start: caret - m[1].length - 1 });
      setMentionIdx(0);
      void loadFiles();
    } else {
      setMention(null);
    }
  };

  const insertMention = (file: string) => {
    if (!mention) return;
    const ta = taRef.current!;
    const caret = ta.selectionStart;
    const next = text.slice(0, mention.start) + '@' + file + ' ' + text.slice(caret);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = mention.start + file.length + 2;
      ta.setSelectionRange(pos, pos);
    });
  };

  const insertSkill = (s: SkillEntry) => {
    const ta = taRef.current!;
    const next = '/' + s.name + ' ' + text.slice(ta.selectionStart);
    setText(next);
    setSlash(null);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = s.name.length + 2;
      ta.setSelectionRange(pos, pos);
    });
  };

  /**
   * Empty the box and resolve the text that should actually be dispatched —
   * shared by send and schedule so both get the same refinement pass and the
   * same "nothing to send" rule. Returns null when there's nothing to do.
   */
  const takeDraft = async (): Promise<string | null> => {
    const raw = text;
    if (!raw.trim() && attachments.length === 0) return null;
    setText(''); // clear optimistically; the box is free for the next prompt while we refine
    setMention(null);
    setSlash(null);
    // Refine the prompt (clearer + more token-efficient, every detail preserved)
    // with the harness's weakest model before it reaches the agent, when enabled.
    // For a scheduled message this runs now, not at delivery, so what's sitting
    // in the Scheduled card is exactly what will be sent. Main validates the
    // refinement (§3) and returns text:null for a trivial/unchanged/rejected
    // result — we silently fall back to the user's own words; only a real error
    // (LLM failure) is worth a toast.
    if (raw.trim() && useApp.getState().settings.refinePrompt) {
      setRefining(true);
      const { data } = await tryInvoke('prompt:refine', { workspaceId: workspace.id, text: raw });
      setRefining(false);
      if (data?.text) return data.text;
      if (data?.error) useApp.getState().toast('error', `Couldn’t refine prompt: ${data.error}`);
    }
    return raw;
  };

  const send = async () => {
    // While the agent runs, sends are queued (main process) and listed above.
    if (refining) return;
    // Don't fire at a harness we haven't confirmed works on the host — the button
    // is disabled, but Enter reaches here too, so guard + explain (toast) here.
    // (While an agent runs, this same button queues — which is always allowed.)
    if (blockSend) {
      useApp.getState().toast('info', sendBlockReason!);
      return;
    }
    const toSend = await takeDraft();
    if (toSend === null) return;
    void useApp.getState().sendMessage(workspace.id, toSend, agentId);
  };

  /**
   * Hold this message until `deliverAt` instead of sending it now.
   *
   * Deliberately NOT gated on `blockSend`: that check is about starting a turn
   * *right now* on a remote host whose harness isn't ready. Scheduling is a
   * statement about the future — the harness may well be set up by then — so
   * refusing here would be the wrong call.
   */
  const schedule = async (deliverAt: number, kind: 'at' | 'limit-reset') => {
    if (refining) return;
    setScheduleMenu(false);
    const toSend = await takeDraft();
    if (toSend === null) return;
    const ok = await useApp.getState().scheduleMessage(workspace.id, agentId, toSend, deliverAt, kind);
    if (!ok) setText(toSend); // rejected (e.g. a time in the past) — hand the text back
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Plan-mode toggle (⇧Tab by default) — the shortcut the harness CLIs
    // themselves use. Only intercepted where the harness supports it; elsewhere
    // the key behaves as before (incl. accepting a slash/mention pick below). §9.
    if (matchesShortcut(e, keys['composer.plan-mode'], platform) && planTip) {
      e.preventDefault();
      setMeta({ planMode: !chatMeta?.planMode });
      return;
    }
    if (slash && slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const pick = slashMatches[slashIdx] ?? slashMatches[0];
        if (pick) insertSkill(pick.s);
        return;
      }
      if (e.key === 'Escape') {
        setSlash(null);
        return;
      }
    }
    if (mention && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const pick = mentionMatches[mentionIdx] ?? mentionMatches[0];
        if (pick) insertMention(pick.f);
        return;
      }
      if (e.key === 'Escape') {
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const saveAttachment = async (
    name: string,
    opts: { text?: string; dataBase64?: string },
    kind: 'note' | 'image' | 'log' | 'file'
  ) => {
    const { data, error } = await tryInvoke('attachment:save', {
      workspaceId: workspace.id,
      name,
      ...opts,
    });
    if (error || !data) {
      useApp.getState().toast('error', error ?? 'Failed to save attachment');
      return;
    }
    useApp.getState().addAttachment(workspace.id, agentId, { kind, path: data.path, label: name });
  };

  const ingestFiles = (list: File[]) =>
    readFilesAsBase64(
      list,
      (name, b64, kind) => void saveAttachment(name, { dataBase64: b64 }, kind),
      (name) => useApp.getState().toast('error', `${name} is larger than 25MB`)
    );
  const { dragDepth, dropProps } = useFileDrop(ingestFiles);

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) ingestFiles([file]);
        return;
      }
    }
    const textData = e.clipboardData.getData('text/plain');
    if (textData && textData.length > 2000) {
      e.preventDefault();
      void saveAttachment(`pasted_text_${Date.now()}.txt`, { text: textData }, 'note');
    }
  };

  const pickFiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => ingestFiles(Array.from(input.files ?? []));
    input.click();
  };

  const setMeta = (patch: { model?: string; effort?: string; planMode?: boolean }) =>
    useApp.getState().setChatMeta(workspace.id, agentId, patch);

  // When the model changes, keep the stored effort valid for it — ladders differ
  // across models/harnesses, so a Claude 'ultracode' shouldn't linger on a Codex
  // model. No-op when the current effort already fits or the model has none.
  const clampEffortForModel = (h: HarnessId, mId: string) => {
    const levels = effortLevelsFor(h, mId, HM);
    if (!levels.length || levels.some((l) => l.id === effort)) return;
    const opt = (HM[h] ?? []).find((x) => x.id === mId);
    const next = resolveEffortLevel(effort, levels, opt?.defaultEffort);
    if (next) setMeta({ effort: next.id });
  };

  return (
    <div className="relative shrink-0 px-4 pb-4 pt-1" {...dropProps}>
      <div className="mx-auto max-w-3xl">
        {chatMeta?.externalLive && (
          <div className="mb-2 rounded-card border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs text-warn">
            This chat is open in {chatMeta.externalLive.app === 'codex' ? 'Codex' : 'Claude Code'}
            {chatMeta.externalLive.pid ? ` (pid ${chatMeta.externalLive.pid})` : ''}. Close it there or wait for it to
            finish to continue here.
          </div>
        )}
        {remoteCurrent && workspace.harness !== 'shell' && (!remoteCurrent.installed || !remoteCurrent.authed) && (
          <div className="mb-2 rounded-card border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs">
            {curSetup?.phase === 'installing' ? (
              <>
                <div className="mb-1 flex items-center gap-1.5 font-medium text-warn">
                  <Loader2 size={12} className="shrink-0 animate-spin" /> Installing {remoteCurrent.bin} on the server…
                </div>
                <div className="text-muted">
                  Maestro is running the installer over SSH — usually under a minute. This updates by itself.
                </div>
              </>
            ) : curSetup?.phase === 'login' ? (
              <>
                <div className="mb-1 flex items-center gap-1.5 font-medium text-warn">
                  <Loader2 size={12} className="shrink-0 animate-spin" /> One step left — sign in to {remoteCurrent.bin}
                </div>
                <div className="text-muted">
                  Its sign-in is running in the terminal below (a device-code flow — follow the prompts). This banner
                  clears itself the moment you’re signed in.{' '}
                  <button
                    className="text-accent hover:underline"
                    onClick={() =>
                      useApp.getState().remoteSetupLogin(workspace.id, workspace.harness, remoteCurrent.loginCommand)
                    }
                  >
                    Restart sign-in
                  </button>
                </div>
              </>
            ) : curSetup?.phase === 'error' ? (
              <>
                <div className="mb-1 font-medium text-warn">Couldn’t install {remoteCurrent.bin} on this server</div>
                <div className="whitespace-pre-wrap font-mono text-2xs text-muted">{curSetup.error}</div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    className="btn btn-accent h-6 text-2xs"
                    onClick={() => void useApp.getState().remoteSetupInstall(workspace.id, workspace.harness)}
                  >
                    Try again
                  </button>
                  <button
                    className="btn h-6 gap-1 text-2xs"
                    title={`Runs: ${remoteCurrent.setupHint}`}
                    onClick={() =>
                      useApp.getState().remoteSetupLogin(workspace.id, workspace.harness, remoteCurrent.setupHint)
                    }
                  >
                    <TerminalIcon size={12} /> Run in terminal instead
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-1 font-medium text-warn">
                  {!remoteCurrent.installed
                    ? `${remoteCurrent.bin} isn’t installed on this server`
                    : `You’re not signed in to ${remoteCurrent.bin} on this server`}
                </div>
                <div className="text-muted">
                  Agents run on the host where the code lives, so <code className="font-mono">{remoteCurrent.bin}</code>{' '}
                  must be installed and signed in there.{' '}
                  {!remoteCurrent.installed
                    ? 'One click: Maestro installs it on the server, then walks you through its sign-in.'
                    : 'One click starts its sign-in in the terminal (already on the server).'}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {!remoteCurrent.installed ? (
                    <button
                      className="btn btn-accent h-6 gap-1 text-2xs"
                      title={`Runs on the server: ${remoteCurrent.installHint}`}
                      onClick={() => void useApp.getState().remoteSetupInstall(workspace.id, workspace.harness)}
                    >
                      <Sparkles size={12} /> Install &amp; sign in
                    </button>
                  ) : (
                    <button
                      className="btn btn-accent h-6 gap-1 text-2xs"
                      title={`Runs: ${remoteCurrent.loginHint}`}
                      onClick={() =>
                        useApp.getState().remoteSetupLogin(workspace.id, workspace.harness, remoteCurrent.loginCommand)
                      }
                    >
                      <TerminalIcon size={12} /> Sign in
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {bgTasks.length > 0 && <BackgroundTaskStrip workspaceId={workspace.id} agentId={agentId} tasks={bgTasks} />}
        {scheduled.length > 0 && (
          <div className="mb-2 overflow-hidden rounded-card border bg-surface">
            <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs text-muted">
              <Clock size={12} />
              Scheduled
            </div>
            {scheduled.map((m) => (
              <ScheduledItem key={m.id} workspaceId={workspace.id} agentId={agentId} item={m} />
            ))}
          </div>
        )}
        {queued.length > 0 && (
          <div className="mb-2 overflow-hidden rounded-card border bg-surface">
            <div className="border-b px-3 py-1.5 text-xs text-muted">Queued</div>
            {queued.map((q) => (
              <QueuedItem key={q.id} workspaceId={workspace.id} agentId={agentId} item={q} />
            ))}
          </div>
        )}
        <div
          className={clsx(
            'relative rounded-card border bg-surface transition-colors focus-within:border-accent/60',
            dragDepth > 0 && 'border-accent border-dashed'
          )}
        >
          {dragDepth > 0 && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-card bg-accent-soft/70 text-[13px] font-medium text-accent">
              Drop images or files to attach
            </div>
          )}

          {slash && slashMatches.length > 0 && (
            <div ref={slashListRef} className="glass absolute bottom-full left-0 right-0 z-30 mb-1 max-h-72 overflow-y-auto py-1">
              {slashMatches.map((m, i) => (
                <button
                  key={m.s.path}
                  className={clsx(
                    'flex w-full items-baseline gap-2 px-3 py-1.5 text-left',
                    i === slashIdx ? 'bg-accent-soft' : ''
                  )}
                  onMouseEnter={() => setSlashIdx(i)}
                  onClick={() => insertSkill(m.s)}
                >
                  <span className="shrink-0 font-mono text-xs text-faint">/</span>
                  <span className="shrink-0 text-[13px] font-semibold">
                    <Marked text={m.s.name} hits={m.nameHits} dim="text-faint" />
                  </span>
                  <span className="min-w-0 truncate text-xs text-muted">
                    {m.s.plugin ? `(${m.s.plugin}) ` : m.s.source === 'project' ? '(project) ' : ''}
                    <Marked text={m.s.description} hits={m.descHits} />
                  </span>
                </button>
              ))}
            </div>
          )}

          {mention && mentionMatches.length > 0 && (
            <div className="glass absolute bottom-full left-2 z-30 mb-1 w-96 overflow-hidden py-1">
              {mentionMatches.map((m, i) => (
                <button
                  key={m.f}
                  className={clsx(
                    'flex w-full items-center gap-2 px-2.5 py-1 text-left font-mono text-xs',
                    i === mentionIdx ? 'bg-accent-soft text-fg' : 'text-muted'
                  )}
                  onMouseEnter={() => setMentionIdx(i)}
                  onClick={() => insertMention(m.f)}
                >
                  <Search size={11} className="shrink-0" />
                  <span className="truncate">
                    <Marked text={m.f} hits={m.hits} />
                  </span>
                </button>
              ))}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {attachments.map((a, i) => (
                <AttachmentChip
                  key={i}
                  a={a}
                  workspaceId={workspace.id}
                  onRemove={() => useApp.getState().removeAttachment(workspace.id, agentId, i)}
                />
              ))}
            </div>
          )}

          {!focused && !text && (
            <span className="pointer-events-none absolute right-3.5 top-3 text-xs text-faint">⌘L to focus</span>
          )}
          <textarea
            ref={taRef}
            className="w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13px] leading-relaxed outline-none placeholder:text-faint"
            rows={2}
            placeholder={
              workspace.status === 'setting-up'
                ? 'Workspace is setting up — you can queue a message'
                : 'Describe a task… (@ to mention files, / for skills, drag or paste to attach)'
            }
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => {
              setFocused(true);
              // Typing into a pane focuses it (drives ⌘L, new-chat placement, etc.).
              if (!isFocusedPane) useApp.getState().setComposerAgent(workspace.id, agentId);
            }}
            onBlur={() => setFocused(false)}
          />

          <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
            {/* model chip — popover opens upward, never clipped */}
            <div className="relative">
              <button
                className={clsx(
                  'btn btn-ghost h-6 gap-1 px-1.5 text-xs text-muted transition-opacity hover:text-fg',
                  blockSend && 'opacity-40'
                )}
                title={blockSend ? sendBlockReason! : 'Choose model'}
                onClick={() => setModelMenu((v) => !v)}
              >
                <Asterisk size={13} className="text-accent" />
                {modelLabel}
              </button>
              {modelMenu && (
                <UpMenu
                  wide
                  tall
                  onClose={() => setModelMenu(false)}
                  footer={
                    <button
                      className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-xs text-muted hover:bg-accent-soft hover:text-fg"
                      title="Set up or log into agent harnesses"
                      onClick={() => {
                        useApp.getState().setModal({ kind: 'settings', tab: 'harnesses' });
                        setModelMenu(false);
                      }}
                    >
                      Manage harnesses
                      <ArrowRight size={12} className="ml-auto shrink-0 text-faint" />
                    </button>
                  }
                >
                  {harnessGroups.map((h, gi) => {
                    const hModels = HM[h.id] ?? [];
                    const hDefault = resolveDefaultModel(h.id, settings.defaultModels);
                    const ready = harnessReady(h);
                    const remoteStatus = projectHostId ? remoteHarnesses?.find((r) => r.harness === h.id) : undefined;
                    const setupSt = projectHostId ? remoteSetup[`${workspace.id}:${h.id}`] : undefined;
                    return (
                      <div key={h.id}>
                        {gi > 0 && <div className="mx-2 my-1 border-t" />}
                        <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1 text-2xs font-semibold uppercase tracking-wide text-faint">
                          <Bot size={11} className="shrink-0" />
                          <span className="truncate">{h.displayName}</span>
                          {projectHostId ? (
                            // Remote (SSH): a ready harness needs NO badge — its
                            // models are simply selectable. Show an affordance only
                            // when it isn't usable yet: a spinner while the host
                            // probe is in flight, else a one-click set-up / sign-in.
                            remoteLoading ? (
                              <span className="ml-auto flex items-center gap-1 font-normal normal-case text-faint">
                                <Loader2 size={11} className="animate-spin" /> checking…
                              </span>
                            ) : setupSt?.phase === 'installing' ? (
                              <span className="ml-auto flex items-center gap-1 font-normal normal-case text-faint">
                                <Loader2 size={11} className="animate-spin" /> installing…
                              </span>
                            ) : setupSt?.phase === 'login' ? (
                              <span className="ml-auto flex items-center gap-1 font-normal normal-case text-faint">
                                <Loader2 size={11} className="animate-spin" /> finish sign-in in the terminal
                              </span>
                            ) : !remoteStatus?.installed ? (
                              // Managed one-click install; the badge flips to
                              // "installing…" in place, so the menu stays open.
                              <button
                                className="ml-auto flex items-center gap-1 font-normal normal-case text-accent hover:underline"
                                // On failure the tooltip carries the actual reason
                                // (e.g. "npm isn't available on this server") —
                                // the badge alone is a dead end.
                                title={
                                  setupSt?.phase === 'error'
                                    ? setupSt.error
                                    : `Runs on the server: ${remoteStatus?.installHint ?? ''}`
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void useApp.getState().remoteSetupInstall(workspace.id, h.id);
                                }}
                              >
                                <Sparkles size={10} /> {setupSt?.phase === 'error' ? 'install failed — retry' : 'install & sign in'}
                              </button>
                            ) : !remoteStatus.authed ? (
                              // Installed but signed out — its models are disabled
                              // below; one click starts the headless login.
                              <button
                                className="ml-auto flex items-center gap-1 font-normal normal-case text-accent hover:underline"
                                title={`Runs on the server: ${remoteStatus.loginHint}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  useApp.getState().remoteSetupLogin(workspace.id, h.id, remoteStatus.loginCommand);
                                  setModelMenu(false); // the sign-in prompts are in the terminal below
                                }}
                              >
                                <TerminalIcon size={10} /> sign in
                              </button>
                            ) : null // ready → no badge, availability is the feedback
                          ) : !ready ? (
                            <span className="ml-auto font-normal normal-case">not connected</span>
                          ) : (
                            !h.installed && (
                              <span className="ml-auto font-normal normal-case text-ok">logged in</span>
                            )
                          )}
                        </div>
                        {hModels.map((m) => (
                          <PickerOption
                            key={`${h.id}:${m.id}`}
                            label={m.label}
                            selected={workspace.harness === h.id && model === m.id}
                            isDefault={hDefault === m.id}
                            showStar={hModels.length > 1}
                            disabled={!ready}
                            onSelect={() => {
                              useApp.getState().setChatModel(workspace.id, agentId, h.id, m.id);
                              clampEffortForModel(h.id, m.id);
                              setModelMenu(false);
                            }}
                            onSetDefault={() => {
                              useApp.getState().setDefaultModel(h.id, m.id);
                              useApp.getState().setChatModel(workspace.id, agentId, h.id, m.id);
                              clampEffortForModel(h.id, m.id);
                              setModelMenu(false);
                            }}
                          />
                        ))}
                      </div>
                    );
                  })}
                </UpMenu>
              )}
            </div>

            {/* effort chip — popover opens upward. Star a level to make it the
                default for new chats. Levels follow the model; hidden when it has
                none (e.g. Haiku, which has no thinking budget). */}
            {effortLevel && (
              <div className="relative">
                <button
                  className={clsx(
                    'btn btn-ghost h-6 gap-1.5 px-1.5 text-xs text-muted transition-opacity hover:text-fg',
                    blockSend && 'opacity-40'
                  )}
                  title={blockSend ? sendBlockReason! : 'Choose reasoning effort'}
                  onClick={() => setEffortMenu((v) => !v)}
                >
                  <EffortBars level={effortLevel.bars} />
                  {effortLevel.label}
                </button>
                {effortMenu && (
                  <UpMenu onClose={() => setEffortMenu(false)}>
                    <EffortOptions
                      levels={effortLevels}
                      currentId={effortLevel.id}
                      defaultId={defaultEffort}
                      onPick={(id, makeDefault) => {
                        if (makeDefault) useApp.getState().setDefaultEffort(id);
                        setMeta({ effort: id });
                        setEffortMenu(false);
                      }}
                    />
                  </UpMenu>
                )}
              </div>
            )}

            {/* roles chip — orchestrator + specialist sub-agents. Enabling any
                turns this chat into an orchestrated run; with none on the
                orchestrator is inactive, so the chip is clearly dimmed (faint +
                lowered opacity, restored on hover). Opens the roles dropdown. */}
            {workspace.harness !== 'shell' && (
              <div className="relative">
                <button
                  className={clsx(
                    'btn btn-ghost h-6 hover:text-fg',
                    rolesCount ? 'gap-1 px-1.5 text-xs text-accent' : 'w-6 !px-0 text-faint opacity-60 hover:opacity-100'
                  )}
                  title="Orchestrator & specialist sub-agents — delegate planning, critique, building, and verification"
                  onClick={() => setRolesMenu((v) => !v)}
                >
                  {rolesCount > 0 && `${rolesCount}x`}
                  <Waypoints size={13} />
                </button>
                {rolesMenu && (
                  <RolesMenu workspace={workspace} agentId={agentId} onClose={() => setRolesMenu(false)} />
                )}
              </div>
            )}

            {/* plan-mode chip — per-chat toggle, only where the harness has a
                plan-style mode (see HARNESS_PLAN_MODE). Off = dimmed icon like
                the roles chip; on = accent + label. ⇧Tab toggles it too. */}
            {planTip && (
              <button
                className={clsx(
                  'btn btn-ghost h-6 hover:text-fg',
                  planOn ? 'gap-1 px-1.5 text-xs text-accent' : 'w-6 !px-0 text-faint opacity-60 hover:opacity-100'
                )}
                title={
                  globalPlan && !chatMeta?.planMode
                    ? 'Plan mode is on for every chat (Settings → Agent permissions)'
                    : `${planTip} (${planOn ? 'on' : 'off'} — ⇧Tab)`
                }
                onClick={() => setMeta({ planMode: !chatMeta?.planMode })}
              >
                <NotebookPen size={13} />
                {planOn && 'Plan'}
              </button>
            )}

            <div className="flex-1" />

            <UsageRing harness={workspace.harness} logins={logins} onReload={reloadLogins} />
            <ContextRing tokens={contextTokens} usage={chatMeta?.usage} window={contextWindowForModel(model, HM)} />

            {canDictate && (
              <button
                className={clsx(
                  'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
                  dictation.listening ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
                )}
                title={dictation.listening ? 'Stop dictation' : 'Dictate — speak your prompt'}
                onClick={onMicClick}
              >
                <Mic size={15} className={dictation.listening ? 'pulse-soft' : ''} />
              </button>
            )}
            <button
              className={clsx(
                'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
                settings.refinePrompt ? 'text-accent' : 'text-faint hover:text-fg'
              )}
              title={`Refine my prompt before sending — clearer, keeps every detail (${settings.refinePrompt ? 'on' : 'off'})`}
              onClick={() => void useApp.getState().saveSettings({ refinePrompt: !settings.refinePrompt })}
            >
              <Sparkles size={14} />
            </button>

            <button className="btn btn-ghost h-7 w-7 !px-0 text-muted hover:text-fg" title="Attach files" onClick={pickFiles}>
              <Plus size={15} />
            </button>

            {agentRunning && (
              <button
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-err/50 text-err transition-colors hover:bg-err/10"
                title="Stop agent (also clears the queue)"
                onClick={() => useApp.getState().stopAgent(workspace.id, agentId)}
              >
                <Square size={11} fill="currentColor" />
              </button>
            )}
            {/* Split send: the Slack shape. One accent pill — send on the left,
                "schedule for later" on the right — so scheduling is discoverable
                as part of sending rather than a separate muted control. Each half
                disables independently: the schedule half stays live while the
                agent runs and on remote hosts that aren't set up yet (scheduling
                is a statement about the future). */}
            <div className="relative">
              <div className="inline-flex h-7 items-stretch overflow-hidden rounded-lg bg-accent text-white transition-all">
                <button
                  className="flex w-7 items-center justify-center transition-colors hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
                  title={
                    blockSend
                      ? sendBlockReason!
                      : refining
                        ? 'Refining prompt…'
                        : agentRunning
                          ? 'Queue message (runs when the agent finishes)'
                          : 'Send (↵)'
                  }
                  disabled={refining || blockSend || nothingToSend}
                  onClick={() => void send()}
                >
                  {refining || (remoteChecking && !agentRunning) ? (
                    <Spinner className="!text-white" />
                  ) : (
                    <ArrowUp size={14} strokeWidth={2.4} />
                  )}
                </button>
                <span aria-hidden className="my-1.5 w-px bg-white/30" />
                <button
                  className="flex w-5 items-center justify-center transition-colors hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
                  title="Schedule for later"
                  aria-label="Schedule for later"
                  aria-haspopup="menu"
                  aria-expanded={scheduleMenu}
                  disabled={refining || nothingToSend}
                  onClick={() => setScheduleMenu((v) => !v)}
                >
                  <ChevronDown size={13} />
                </button>
              </div>
              {scheduleMenu && (
                <SchedulePopover
                  usage={usage}
                  remote={remoteChat}
                  onPick={(at, kind) => void schedule(at, kind)}
                  onClose={() => setScheduleMenu(false)}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const NO_HITS: number[] = [];
const range = (start: number, end: number): number[] => {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
};

/**
 * Greedy subsequence match: returns the indices in `target` that spell out the
 * lowercase `query` in order (taking the earliest of each character), or null
 * when `query` isn't a subsequence of `target`. Used to highlight *why* a fuzzy
 * hit matched — e.g. "spec" → st·ri·pe-dire·ctory.
 */
function fuzzyMatch(query: string, target: string): number[] | null {
  const t = target.toLowerCase();
  const positions: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < query.length; ti++) {
    if (t[ti] === query[qi]) {
      positions.push(ti);
      qi++;
    }
  }
  return qi === query.length ? positions : null;
}

/**
 * Renders `text` with the characters at `hits` brightened (and the rest dimmed
 * via `dim`, when given) — so a search result shows *why* it matched. Consecutive
 * hit/non-hit runs collapse into single spans to keep the DOM light.
 */
function Marked({ text, hits, dim }: { text: string; hits: number[]; dim?: string }) {
  if (hits.length === 0) return <>{text}</>;
  const set = new Set(hits);
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const on = set.has(i);
    let j = i;
    while (j < text.length && set.has(j) === on) j++;
    parts.push(
      <span key={i} className={on ? 'text-fg' : dim}>
        {text.slice(i, j)}
      </span>
    );
    i = j;
  }
  return <>{parts}</>;
}

/** Popover anchored above its trigger (composer sits at the window bottom). */
function UpMenu({
  children,
  footer,
  wide,
  tall,
  right,
  onClose,
}: {
  children: React.ReactNode;
  /** pinned below the scroll area, e.g. a "Manage harnesses" link */
  footer?: React.ReactNode;
  /** roomier width/height for the harness-grouped model list */
  wide?: boolean;
  tall?: boolean;
  /** anchor to the right edge — for triggers near the end of the toolbar, which
   *  would otherwise open off the side of the composer */
  right?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissFromParent(onClose, ref);
  return (
    <div
      ref={ref}
      className={clsx(
        'glass absolute bottom-full z-40 mb-1.5 overflow-hidden',
        right ? 'right-0' : 'left-0',
        wide ? 'w-64' : 'w-44'
      )}
    >
      <div className={clsx('overflow-y-auto py-1', tall ? 'max-h-80' : 'max-h-72')}>{children}</div>
      {footer}
    </div>
  );
}


/** How far off `ts` is, coarsely: "45m", "1h", "3h 12m", "2d 4h". '' once past.
 *  Rounds to whole minutes FIRST, so an instant an eyelash under the hour reads
 *  "1h" rather than "60m". */
const fmtDelta = (ts: number): string => {
  const ms = ts - Date.now();
  if (!isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return '<1m'; // about to fire — "0m" reads like it's stuck
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

const fmtReset = (iso?: string): string => {
  if (!iso) return '';
  const d = fmtDelta(new Date(iso).getTime());
  return d ? `resets in ${d}` : 'resets soon';
};

/** Wall-clock label for a scheduled instant: "6:00 PM", "Tomorrow 9:00 AM",
 *  or "Aug 15, 6:00 PM" once it's further out than that. */
const fmtClock = (ts: number): string => {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(new Date())) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
};

/** epoch ms → the local `YYYY-MM-DDTHH:mm` a datetime-local input expects. */
const toLocalInput = (ts: number): string => {
  const d = new Date(ts);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** The top of the next hour — a sane default for the exact-time input. */
const nextRoundHour = (): number => {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
};

/** Fixed offers, dropping any that have already passed today. */
function quickTimes(): { label: string; at: number }[] {
  const nowMs = Date.now();
  const todayAt = (dayOffset: number, hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };
  return [
    { label: 'In 1 hour', at: nowMs + 3_600_000 },
    { label: 'This evening', at: todayAt(0, 18) },
    { label: 'Tomorrow morning', at: todayAt(1, 9) },
  ].filter((c) => c.at > nowMs + 60_000);
}

/**
 * The send-later menu. Every option resolves to a plain epoch-ms instant at the
 * moment of choosing, so nothing downstream ever has to reason about "6 PM",
 * DST, or which timezone the user was in when they scheduled it.
 */
function SchedulePopover({
  usage,
  remote,
  onPick,
  onClose,
}: {
  usage: SubUsage | null;
  /** True when this chat runs on a remote host — changes the footer note (§4.7). */
  remote: boolean;
  onPick: (deliverAt: number, kind: 'at' | 'limit-reset') => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState(() => toLocalInput(nextRoundHour()));
  const chips = useMemo(() => quickTimes(), []);
  const limit = useMemo(() => limitResetTarget(usage), [usage]);

  const pickCustom = () => {
    const at = new Date(custom).getTime(); // datetime-local parses as local time
    if (isFinite(at)) onPick(at, 'at');
  };

  return (
    <UpMenu wide right onClose={onClose}>
      {/* The headline option: this is what the feature is for. Waits for the
          highest-usage window(s), the minute after the last of them resets, and
          names every window so a tie reads as "both", not as a mystery delay. */}
      {limit && (
        <button
          className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-accent-soft"
          onClick={() => onPick(limit.at, 'limit-reset')}
        >
          <span className="flex w-full items-center gap-1.5 text-[13px]">
            <Clock size={12} className="shrink-0 text-accent" />
            After limits reset
            <span className="ml-auto font-mono text-2xs" style={{ color: usageColor(limit.windows[0], 'var(--muted)') }}>
              {Math.round(limit.windows[0].pct)}%
            </span>
          </span>
          {/* Names every window being waited on, so a tie reads as "both". */}
          <span className="pl-[18px] text-2xs text-faint">
            {fmtClock(limit.at)} · {limit.windows.map((w) => w.label).join(' & ')}
          </span>
        </button>
      )}
      {/* Usage is known but nothing is counting down: keep the row visible but
          disabled, so its absence isn't mistaken for a bug. Hidden entirely when
          the harness reports no usage at all (usage === null). */}
      {usage && !limit && (
        <button
          disabled
          className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left opacity-50"
        >
          <span className="flex w-full items-center gap-1.5 text-[13px]">
            <Clock size={12} className="shrink-0 text-accent" />
            After limits reset
          </span>
          <span className="pl-[18px] text-2xs text-faint">No window is counting down</span>
        </button>
      )}
      {(limit || (usage && !limit)) && chips.length > 0 && <div className="mx-2 my-1 border-t" />}
      {chips.map((c) => (
        <button
          key={c.label}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent-soft"
          onClick={() => onPick(c.at, 'at')}
        >
          {c.label}
          <span className="ml-auto text-2xs text-faint">{fmtClock(c.at)}</span>
        </button>
      ))}
      <div className="mx-2 my-1 border-t" />
      <div className="px-3 py-2">
        <div className="mb-1 text-2xs uppercase tracking-wide text-faint">Pick a time</div>
        <div className="flex items-center gap-1.5">
          <input
            type="datetime-local"
            className="min-w-0 flex-1 rounded border bg-bg px-1.5 py-1 text-xs outline-none focus:border-accent/60"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                pickCustom();
              }
            }}
          />
          <button
            className="shrink-0 rounded bg-accent px-2 py-1 text-xs text-white transition-opacity hover:opacity-90"
            onClick={pickCustom}
          >
            Set
          </button>
        </div>
        {/* Local: main's process doesn't outlive the window, so be honest about
            it rather than implying background delivery. Remote: the box owns
            delivery and runs even with Maestro closed (§4). */}
        <div className="mt-1.5 text-2xs leading-snug text-faint">
          {remote
            ? 'Runs on the server at that time, even if Maestro is closed. Needs the server to stay up.'
            : 'Sends only while Maestro is running; a missed time sends at next launch.'}
        </div>
      </div>
    </UpMenu>
  );
}

/** Trailing action on a pending row — revealed on hover, like the queue's. */
const ROW_ACTION = 'shrink-0 rounded p-0.5 text-faint opacity-0 transition-opacity group-hover:opacity-100';

/**
 * One pending message above the composer — queued behind a running turn, or
 * scheduled for a wall-clock time. Both wait before they fire, so both let you
 * reword in place: click the text (or the pencil), Enter saves, Escape cancels.
 * The subtitle and trailing actions are all that differ between the two lists.
 */
function PendingRow({
  text,
  onCommit,
  subtitle,
  actions,
}: {
  text: string;
  onCommit: (next: string) => void;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const cancelledRef = useRef(false);

  const startEdit = () => {
    setDraft(text);
    cancelledRef.current = false;
    setEditing(true);
  };

  const cancel = () => {
    cancelledRef.current = true;
    setEditing(false);
  };

  const commit = () => {
    // Escape unmounts the textarea, which fires onBlur → commit; skip that save.
    if (cancelledRef.current) return;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== text) onCommit(next);
  };

  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing]);

  if (editing) {
    return (
      <div className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
        <textarea
          ref={taRef}
          className="min-w-0 flex-1 resize-none rounded border bg-bg px-2 py-1 text-[13px] leading-relaxed outline-none focus:border-accent/60"
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
        />
        <button
          className="shrink-0 rounded p-0.5 text-faint transition-colors hover:text-ok"
          title="Save (Enter)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
        >
          <Check size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
      <button className="min-w-0 flex-1 cursor-text text-left" title="Edit message" onClick={startEdit}>
        <span className="block truncate text-[13px]">{text}</span>
        {subtitle && <span className="mt-0.5 block truncate text-2xs text-faint">{subtitle}</span>}
      </button>
      <button className={clsx(ROW_ACTION, 'hover:text-fg')} title="Edit message" onClick={startEdit}>
        <Pencil size={13} />
      </button>
      {actions}
    </div>
  );
}

/** A scheduled message: its time, plus an escape hatch to send it now. */
function ScheduledItem({
  workspaceId,
  agentId,
  item,
}: {
  workspaceId: string;
  agentId: number;
  item: ScheduledMessage;
}) {
  // "in 3h 12m" would otherwise go stale on a card that sits for hours; a
  // minute is as fine-grained as the label gets.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const delta = fmtDelta(item.deliverAt);
  const remote = !!item.remoteTurnId;
  return (
    <PendingRow
      text={item.text}
      onCommit={(next) => useApp.getState().editScheduled(workspaceId, agentId, item.id, next)}
      subtitle={
        fmtClock(item.deliverAt) +
        // A remote row that's past due is waiting on the box's drain to run it,
        // not on us "sending" (§4.7).
        (delta ? ` · in ${delta}` : remote ? ' · waiting for the server' : ' · sending…') +
        (item.kind === 'limit-reset' ? ' · after limits reset' : '') +
        (remote ? ' · on the server' : '')
      }
      actions={
        <>
          <button
            className={clsx(ROW_ACTION, 'hover:text-fg')}
            title="Send now instead of waiting"
            onClick={() => useApp.getState().sendScheduledNow(workspaceId, agentId, item.id)}
          >
            <ArrowUp size={13} />
          </button>
          <button
            className={clsx(ROW_ACTION, 'hover:text-err')}
            title="Cancel scheduled message"
            onClick={() => useApp.getState().cancelScheduled(workspaceId, agentId, item.id)}
          >
            <X size={13} />
          </button>
        </>
      }
    />
  );
}

/** Provider severity → color; falls back to percent thresholds. The provider
 *  knows things thresholds don't (e.g. a window flagged critical before 95%). */
function usageColor(w: { pct: number; severity?: string }, normal: string): string {
  if (w.severity === 'critical') return 'var(--err)';
  if (w.severity && /warn|elevat|high/i.test(w.severity)) return 'var(--warn)';
  return w.pct > 95 ? 'var(--err)' : w.pct > 80 ? 'var(--warn)' : normal;
}

/**
 * Every login for this harness, each with its subscription usage + sign-in
 * state, plus the active id and the rotation flag. Refreshes on mount, at each
 * turn end (a turn is what moves the needle, and rotation may have switched the
 * active login), on a slow interval for long-idle windows, and whenever main
 * pushes `harness:logins` (an add/remove/activate/rotate). Main caches usage for
 * 30s, so extra calls are cheap.
 *
 * The donut/popover and the send-later menu both read the active login here —
 * one fetcher, several consumers.
 */
function useHarnessLogins(harness: Workspace['harness'], agentRunning: boolean) {
  const [logins, setLogins] = useState<HarnessLogins | null>(null);
  const aliveRef = useRef(true);
  const load = useCallback(
    (force?: boolean) => {
      void tryInvoke('harness:logins', { harness, force }).then(({ data }) => {
        if (aliveRef.current) setLogins(data ?? null);
      });
    },
    [harness]
  );
  useEffect(() => {
    aliveRef.current = true;
    if (!agentRunning) load();
    const t = window.setInterval(() => load(), 5 * 60_000);
    // Main broadcasts when the registry or active pointer changes (a manual
    // switch, an add/remove, or a rotation mid-turn) — re-read then too.
    const off = on('harness:logins', ({ harness: h }) => {
      if (h === harness) load();
    });
    return () => {
      aliveRef.current = false;
      window.clearInterval(t);
      off();
    };
  }, [agentRunning, harness, load]);
  return { logins, reload: load };
}

/** A limited-until ms epoch as a wall-clock reset time, e.g. "resets 3:00 PM".
 *  Matches the rotation system message; '' once it's in the past. */
function fmtLimitReset(ms?: number): string {
  if (!ms || ms <= Date.now()) return '';
  return `resets ${new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/** The per-window bars for one login's usage — the body shared by the popover
 *  (identical to the old hover card's rows). */
function UsageBars({ usage }: { usage: SubUsage | null }) {
  if (!usage || usage.windows.length === 0)
    return <span className="block text-2xs text-faint">No usage data</span>;
  return (
    <span className="block space-y-2">
      {usage.windows.map((w) => {
        const sub = [w.resetsAt ? fmtReset(w.resetsAt) : '', w.note ?? ''].filter(Boolean).join(' · ');
        return (
          <span key={w.id} className="block">
            <span className="flex justify-between text-2xs text-muted">
              <span>{w.label}</span>
              <span className="font-mono">{Math.round(w.pct)}%</span>
            </span>
            <span className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-border">
              <span
                className="block h-full rounded-full"
                style={{ width: `${Math.min(100, w.pct)}%`, background: usageColor(w, 'var(--accent)') }}
              />
            </span>
            {sub && <span className="mt-0.5 block text-2xs text-faint">{sub}</span>}
          </span>
        );
      })}
    </span>
  );
}

/**
 * Subscription-limit donut (e.g. Claude session/weekly windows). The 17px donut
 * always tracks the ACTIVE login's tightest window. Hovering it opens the
 * UsageMenu — every login, with ◀ ▶ to cycle and a "Use this login" switch.
 * Renders nothing when the active login has no usage AND there is only one login
 * (API-key logins, non-subscription harnesses), so most users never see it.
 *
 * Hover-only, like ContextRing: the card opens on enter and closes the instant
 * the pointer leaves — no click-to-pin (which felt stuck) and no close delay.
 * The card is interactive (cycle logins, switch active), so an invisible bridge
 * fills the 6px gap to it, keeping it reachable without a lingering timer.
 */
function UsageRing({
  harness,
  logins,
  onReload,
}: {
  harness: HarnessId;
  logins: HarnessLogins | null;
  onReload: (force?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  // Entering also refreshes (throttled by the main-process cache), so the card
  // shows near-live numbers exactly when the user goes looking for them.
  const enter = useCallback(() => {
    onReload();
    setOpen(true);
  }, [onReload]);
  const leave = useCallback(() => setOpen(false), []);

  const active = logins?.logins.find((l) => l.id === logins.activeId) ?? null;
  const usage = active?.usage ?? null;
  const many = (logins?.logins.length ?? 0) > 1;
  if (!logins || (!usage?.windows.length && !many)) return null;
  const top = usage?.windows.length ? usage.windows.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
  const pct = top ? Math.min(1, top.pct / 100) : 0;
  const color = top ? usageColor(top, 'var(--muted)') : 'var(--border)';
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="relative flex h-7 w-6 items-center justify-center"
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <span className="flex h-7 w-6 items-center justify-center text-muted" aria-label="Plan usage">
        <svg width="17" height="17" viewBox="0 0 18 18" className="-rotate-90">
          <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border)" strokeWidth="2.4" />
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="2.4"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct)}
            strokeLinecap="round"
          />
        </svg>
      </span>
      {open && (
        <>
          {/* Invisible hover bridge spanning the 6px gap under the card (same
              right-0 w-64 footprint): keeps the pointer inside the wrapper as it
              travels from donut to any part of the card, so the card stays
              reachable even though leaving closes instantly (no timer). */}
          <span aria-hidden className="absolute bottom-full right-0 h-1.5 w-64" />
          <UsageMenu harness={harness} logins={logins} onReload={onReload} onClose={leave} />
        </>
      )}
    </span>
  );
}

/**
 * The usage popover the ring hovers open: one login at a time, ◀ ▶ to cycle, a
 * "Current" pill on the active login, and a "Use this login" switch. The active
 * login is the one the next message runs under, so switching here re-points the
 * ring and every new turn.
 */
function UsageMenu({
  harness,
  logins,
  onReload,
  onClose,
}: {
  harness: HarnessId;
  logins: HarnessLogins;
  onReload: (force?: boolean) => void;
  onClose: () => void;
}) {
  const list = logins.logins;
  const many = list.length > 1;
  const activeIdx = Math.max(
    0,
    list.findIndex((l) => l.id === logins.activeId)
  );
  const [viewIdx, setViewIdx] = useState(activeIdx);
  const idx = ((viewIdx % list.length) + list.length) % list.length;
  const viewed = list[idx];
  const isActive = viewed.id === logins.activeId;
  const move = useCallback(
    (delta: number) => setViewIdx((i) => (((i + delta) % list.length) + list.length) % list.length),
    [list.length]
  );

  // ←/→ cycle the viewed login while the popover is open (Esc/outside-click are
  // handled by UpMenu's useDismissFromParent). Hover can open this while the
  // caret is still in the composer, so never steal arrows from a text field.
  useEffect(() => {
    if (!many) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        move(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [many, move]);

  const limited = fmtLimitReset(viewed.limitedUntil);
  const subHeader = !viewed.signedIn
    ? 'Not signed in'
    : limited
      ? `Limited · ${limited}`
      : [viewed.email, viewed.plan?.toUpperCase()].filter(Boolean).join(' · ');

  const arrow =
    'flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-accent-soft hover:text-fg';

  return (
    <UpMenu
      wide
      right
      onClose={onClose}
      footer={
        <div className="border-t">
          {!isActive && (
            <div className="px-3 pt-2">
              <button
                className="btn btn-accent h-7 w-full text-xs"
                disabled={!viewed.signedIn}
                onClick={() => {
                  // Keep the menu open so the "Current" pill visibly moves under
                  // the user's eyes; the push event reloads the rows.
                  void invoke('harness:setActiveLogin', { harness, loginId: viewed.id }).then(() => onReload());
                }}
              >
                Use this login
              </button>
            </div>
          )}
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-accent-soft hover:text-fg"
            title="Add, sign into, or remove logins"
            onClick={() => {
              useApp.getState().setModal({ kind: 'settings', tab: 'harnesses' });
              onClose();
            }}
          >
            Manage logins
            <ArrowRight size={12} className="ml-auto shrink-0 text-faint" />
          </button>
        </div>
      }
    >
      <div className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          {many && (
            <button className={arrow} title="Previous login (←)" onClick={() => move(-1)}>
              <ChevronLeft size={14} />
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{viewed.label}</span>
          {isActive && <span className="rounded-ctl bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent">Current</span>}
          {many && <span className="text-2xs text-faint">{idx + 1}/{list.length}</span>}
          {many && (
            <button className={arrow} title="Next login (→)" onClick={() => move(1)}>
              <ChevronRight size={14} />
            </button>
          )}
        </div>
        {subHeader && <div className="mt-0.5 text-2xs text-muted">{subHeader}</div>}
        <div className="mt-2">
          <UsageBars usage={viewed.usage} />
        </div>
      </div>
    </UpMenu>
  );
}

/** A queued message: runs as soon as the current turn ends. */
function QueuedItem({
  workspaceId,
  agentId,
  item,
}: {
  workspaceId: string;
  agentId: number;
  item: { id: string; text: string };
}) {
  return (
    <PendingRow
      text={item.text}
      onCommit={(next) => useApp.getState().editQueued(workspaceId, agentId, item.id, next)}
      actions={
        <>
          {/* Steer: interrupt the current turn so this message runs next. */}
          <button
            className={clsx(ROW_ACTION, 'hover:text-fg')}
            title="Send now — interrupt the current turn to run this message next"
            onClick={() => useApp.getState().sendQueuedNow(workspaceId, agentId, item.id)}
          >
            <ArrowUp size={13} />
          </button>
          <button
            className={clsx(ROW_ACTION, 'hover:text-err')}
            title="Remove from queue"
            onClick={() => useApp.getState().removeQueued(workspaceId, agentId, item.id)}
          >
            <X size={13} />
          </button>
        </>
      }
    />
  );
}

/**
 * Whether a background task is one the agent is (or was) *waiting on* — still
 * running now, or still running when its turn ended (so the CLI killed it and it
 * never got to report). Those are the ones worth surfacing: the agent's response
 * looks finished, but really it left this task hanging. Tasks that completed or
 * failed *within* the turn resolved on their own and don't get the strip.
 */
function isWaitingTask(t: BackgroundTask): boolean {
  return t.status === 'running' || t.orphaned === true;
}

/**
 * Background tasks the agent started with `run_in_background` and left hanging,
 * above the composer next to the queue. They're worth their own strip because
 * the agent kicks them off intending to come back later — and it can't: each
 * turn is its own CLI process, so the CLI kills them when the turn ends. The
 * response looks done while a task is still running, so we surface only those
 * "still waiting" tasks (see `isWaitingTask`) with a live elapsed timer, the way
 * an agent response is timed; the next message tells the agent the same thing.
 */
function BackgroundTaskStrip({
  workspaceId,
  agentId,
  tasks,
}: {
  workspaceId: string;
  agentId: number;
  tasks: BackgroundTask[];
}) {
  const waiting = tasks.filter(isWaitingTask);
  if (waiting.length === 0) return null;
  const anyFinished = waiting.some((t) => t.status !== 'running');
  return (
    <div className="mb-2 overflow-hidden rounded-card border bg-surface">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted">
        <span className="flex-1">Background tasks</span>
        {anyFinished && (
          <button
            className="shrink-0 rounded p-0.5 text-faint transition-colors hover:text-fg"
            title="Dismiss finished tasks"
            onClick={() => useApp.getState().clearBackgroundTasks(workspaceId, agentId)}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {waiting.map((t) => {
        const note =
          t.status === 'running'
            ? 'Running — the CLI ends it when this turn does'
            : 'Terminated when the turn ended — the agent is told on your next message';
        return (
          <div key={t.id} className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0">
            <span
              className={clsx(
                'mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full',
                t.status === 'running' ? 'bg-accent' : 'bg-warn'
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{t.description}</span>
              <span className={clsx('block text-2xs', t.orphaned ? 'text-warn' : 'text-faint')}>
                {note}
                {t.outputFile && (
                  <>
                    {' · '}
                    <span className="font-mono" title={t.outputFile}>
                      output kept
                    </span>
                  </>
                )}
              </span>
            </span>
            {t.status === 'running' ? (
              <RunTimer startedAt={t.startedAt} className="mt-1" />
            ) : (
              <span className="mt-1 shrink-0 font-mono text-2xs tabular-nums text-faint">
                {formatElapsed((t.endedAt ?? t.startedAt) - t.startedAt)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
