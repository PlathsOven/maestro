import { create } from 'zustand';
import { invoke, tryInvoke } from '../lib/api';
import { evictWorkspaceBuffers } from '../lib/editorEvictor';
import { evictIdleWorkspaces } from '../lib/transcriptEvictor';
import { composeResolvePrompt, mergeFailureMessage } from '../lib/resolveConflicts';
import { appendColumn, firstLeaf, hasLeaf, insertBeside, leaf, paneCount, removeLeaf, withFocusedLeaf, type DropSide, type PaneNode } from '../lib/paneTree';
import {
  applyChatOrder,
  applyWorkspaceOrder,
  clampLayout,
  loadChatOrders,
  loadLayout,
  saveChatOrder,
  saveWorkspaceOrder,
  type LayoutSizes,
} from '../lib/layoutPrefs';
import { DEFAULT_COLOR_THEME, applyThemeToElement, isThemeMode, normalizeColorTheme, type ThemeMode } from '../../shared/themes';
import { applyEffects, isEffectsMode, resolveEffects } from '../../shared/ui/effects';
import type {
  AgentBlock,
  AskAnswer,
  AskQuestionPayload,
  Attachment,
  BackgroundTask,
  ChatMessage,
  ChatMeta,
  ConductorScan,
  ConductorSelection,
  DiffComment,
  ErrorRef,
  GhAuth,
  GpuHint,
  GitStatusSummary,
  GlobalSettings,
  HarnessId,
  HarnessSyncScan,
  HarnessSyncStatus,
  HarnessInfo,
  HostState,
  AnnotationItem,
  ElementRef,
  PreviewShot,
  PreviewState,
  PrStatus,
  Project,
  ProjectCaps,
  RemoteSetupState,
  RunScript,
  ScheduledMessage,
  SshHostConfig,
  ScriptState,
  SkillEntry,
  StatusReport,
  StatusRequest,
  SubagentRun,
  Todo,
  Workspace,
  WorkspaceDiff,
  WorkspaceScripts,
  WorkspaceTab,
} from '../../shared/types';
import { DEFAULT_COMPLETION_SOUND, DIRECT_REFUSAL, isDirectWorkspace, statusKey, type DiffScope } from '../../shared/types';
import { provisionalTitle } from '../../shared/chatTitle';
import { isUnread, workspaceStatusCounts } from '../../shared/ui/status';
import { askingAgents, turnKey } from '../lib/liveTurn';
import { EMPTY_ARR, capsOf, isDirectIn, patchChatMeta, type ChatsMeta } from './helpers';
import { flushChatEvents, subscribeToMain } from './events';
import { loadDrafts, persistDrafts } from '../lib/composerDrafts';
import { STASH_MAX, loadStash, saveStash, type StashedPrompt } from '../lib/promptStash';
import { rememberPreviewUrl } from '../lib/previewRecent';

export { EMPTY_ARR, capsOf };

export interface LiveTurn {
  agentId: number;
  finalBlocks: AgentBlock[];
  deltaBlocks: AgentBlock[];
  accumType: 'text' | 'thinking' | null;
  accumText: string;
  running: boolean;
  /** Wall-clock ms when this turn began — anchors the live elapsed timer. */
  startedAt: number;
}

interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  /** One-click error-report state on an error toast (§10). */
  report?: 'idle' | 'sending' | 'sent' | 'failed';
  /** A single follow-up button (e.g. "Open" on an agent-finished toast). */
  action?: { label: string; run: () => void };
}

interface GhSignInState {
  userCode: string;
  verificationUri: string;
  status: 'starting' | 'waiting' | 'error';
  message?: string;
}

/** Live annotation session (§9): the frozen screenshot + layout index the user
 *  marks up, plus the marks so far. `null` when not annotating. */
export interface AnnotateState {
  wsId: string;
  agentId: number;
  shot: PreviewShot;
  /** placeholder CSS dims captured at freeze time — the box the marks live in. */
  cssW: number;
  cssH: number;
  url: string;
  elements: ElementRef[];
  items: AnnotationItem[];
}

/** Renderer-side view of one status digest slot (keyed by statusKey). */
interface StatusSlot {
  report: StatusReport | null;
  stale: boolean;
  generating: boolean;
  error?: string;
}

type Modal =
  | { kind: 'new-workspace'; from?: 'branch' | 'pr' | 'issue' | 'linear' | 'direct' }
  | { kind: 'clone-repo' }
  | { kind: 'create-project' }
  /** Picked a non-git folder in "Open project" — choose work-in-folder vs init-git. */
  | { kind: 'folder-choice'; path: string; hostId?: string }
  /** Pick/create an SSH host and browse to a remote folder to open. */
  | { kind: 'remote-folder' }
  /** Continue from Conductor: prepopulate projects/workspaces/chats (post-onboarding). */
  | { kind: 'conductor-import' }
  /** Sync chats from Claude Code & Codex (harness-chat-sync §4.1). */
  | { kind: 'harness-sync' }
  | { kind: 'github-signin' }
  | { kind: 'settings'; tab?: 'general' | 'harnesses' | 'repository' | 'integrations' | 'cloud' | 'account' }
  | { kind: 'branch-conflict'; workspaceId: string; branch: string; message: string }
  | {
      kind: 'confirm';
      title: string;
      body: string;
      confirmLabel: string;
      danger?: boolean;
      onConfirm: () => void;
    }
  | { kind: 'subagent-preview'; run: SubagentRun }
  | null;

/** One image in the chat lightbox — a worktree-relative path plus its alt text. */
type LightboxImage = { path: string; alt?: string };
/**
 * The chat image lightbox (spotlight): a full-screen zoomable viewer opened by
 * clicking an inline transcript image, holding the pane's ordered images so the
 * arrows can step between them. Kept separate from `modal` so it overlays any
 * open modal (e.g. a sub-agent trace) instead of replacing it.
 */
type Lightbox = { workspaceId: string; images: LightboxImage[]; index: number } | null;

/** "2 projects, 1 workspace, 5 chats" for an import toast; '' when nothing landed. */
function importSummary(n: { projects: number; workspaces: number; chats: number }): string {
  const parts: string[] = [];
  if (n.projects) parts.push(`${n.projects} project${n.projects === 1 ? '' : 's'}`);
  if (n.workspaces) parts.push(`${n.workspaces} workspace${n.workspaces === 1 ? '' : 's'}`);
  if (n.chats) parts.push(`${n.chats} chat${n.chats === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** How often the store sweeps for evictable workspace state (§4.9.5). The sweep
 *  itself is a few map lookups; idleness is measured in minutes, not ticks. */
const EVICT_SWEEP_MS = 60_000;

/** Default terminal set for a workspace (one terminal). Stable ref for selectors. */
export const DEFAULT_TERM_IDS: number[] = [1];
/** Default chat set for a workspace (one chat). Stable ref for selectors. */
export const DEFAULT_CHAT_IDS: number[] = [1];
/** Max chats tiled in the split (center) view before panes get unusably small.
 *  Beyond this, "split" replaces the focused pane instead of adding one. */
const MAX_PANES = 4;

/**
 * Single-flight per key: run `fn` now unless a run is already in flight, in
 * which case run it once more when that finishes. Bursts of refresh requests
 * collapse to at most one trailing probe — no fixed delay on the first one, and
 * no debounce that starves while changes keep arriving.
 */
const inflight = new Map<string, { run: Promise<void>; again: boolean }>();
function coalesce(key: string, fn: () => Promise<void>): Promise<void> {
  const cur = inflight.get(key);
  if (cur) {
    cur.again = true;
    return cur.run;
  }
  const entry = {
    again: false,
    run: fn().finally(() => {
      inflight.delete(key);
      if (entry.again) void coalesce(key, fn);
    }),
  };
  inflight.set(key, entry);
  return entry.run;
}

export interface AppState {
  loaded: boolean;
  projects: Project[];
  workspaces: Workspace[];
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  tabByWs: Record<string, WorkspaceTab>; // center mode: 'chat' | 'diff' | 'editor'
  // In-app editor tabs (per workspace). Monaco models / notebook docs live in a
  // module-level cache (lib/editorBuffers) — the store holds only what the tab
  // strip renders: the open paths, which is active, and which are dirty.
  openFiles: Record<string, string[]>; // wsId → ordered worktree-relative paths
  activeFile: Record<string, string | null>; // wsId → active tab path
  dirtyFiles: Record<string, Record<string, boolean>>; // wsId → path → dirty
  chatsMeta: ChatsMeta;
  queued: Record<string, { id: string; text: string; attachments: Attachment[] }[]>; // key `${wsId}:${agentId}`
  /** Messages waiting for a wall-clock time (key `${wsId}:${agentId}`). Unlike
   *  `queued`, main persists these — they survive restarts, so this map is
   *  hydrated on workspace load rather than starting empty. */
  scheduled: Record<string, ScheduledMessage[]>;
  /** Harness background tasks per chat (key `${wsId}:${agentId}`) — the strip
   *  above the composer. Main owns them; they're in-memory there, so an empty
   *  map after a restart is correct. */
  bgTasks: Record<string, BackgroundTask[]>;
  projectOwners: Record<string, string | null>;
  /** Derived capability rung per project — gates git/GitHub surfaces. Seeded by
   *  app:init, refreshed on project focus + after gh:auth via refreshCaps. */
  projectCaps: Record<string, ProjectCaps>;
  /** Saved SSH hosts and their live connection state (drives chips + banner). */
  hosts: SshHostConfig[];
  hostStates: Record<string, HostState>;
  diffStats: Record<string, { additions: number; deletions: number } | undefined>;
  rightTab: Record<string, 'files' | 'changes' | 'status' | 'skills'>;
  layout: LayoutSizes; // resizable panel sizes (px)
  dockOpen: Record<string, boolean>;
  dockTab: Record<string, string>; // 'setup' | 'run' | 'rs:<scriptId>' | 'term:N'
  dockTermIds: Record<string, number[]>; // open terminal numbers, e.g. [1, 3]
  dockRunIds: Record<string, string[]>; // run-script ids open as their own dock terminal tabs
  /** `${wsId}:${tabId}` of the dock tab the user just asked to see (tab click,
   *  expand, new/open terminal). Its terminal takes keyboard focus once and
   *  clears this; a terminal revealed any other way — say, by selecting a
   *  workspace whose dock was left on it — leaves focus in the composer. */
  dockFocusRequest: string | null;
  statusScope: Record<string, 'session' | 'workspace' | 'project'>; // Status tab scope per workspace
  focusComposerNonce: number;
  /** Bumped by ⌘F / the palette's "Find in Chat"; the focused chat pane opens
   *  (or refocuses) its find bar. */
  chatFindNonce: number;
  /** Changed file the Diff surface should scroll to — set by a Changes-tab click,
   *  cleared by the DiffViewer once it has scrolled there. */
  diffFocus: { wsId: string; path: string } | null;
  /** Bumped by ⌘W in Editor mode; the visible EditorSurface watches it and runs
   *  its dirty-guarded close of the active tab. Mirrors focusComposerNonce. */
  closeActiveFileNonce: number;
  settings: GlobalSettings;
  /** The theme variant actually applied to the DOM: 'system' resolved against
   *  the OS color scheme. Consumers that need concrete dark/light (Monaco, etc.)
   *  read this rather than settings.theme; the family is settings.colorTheme. */
  resolvedTheme: 'dark' | 'light';
  ghAuth: GhAuth;
  harnesses: HarnessInfo[];
  /** Managed remote-harness setup progress, keyed `${wsId}:${harness}` — lives
   *  here (not in the composer) so an in-flight install keeps its spinner
   *  across workspace switches and composer unmounts. */
  remoteSetup: Record<string, RemoteSetupState>;
  /** Running app version (from app.getVersion()); shown in Settings → General. */
  appVersion: string;
  /** process.platform (from app:init) — drives shortcut formatting/matching (§9). */
  platform: string;
  /** GPU facts from app:init, for the `auto` visual-effects level. */
  gpu: GpuHint | null;
  /** bumped on every ws:updated — components use it to refetch git state */
  wsVersion: Record<string, number>;

  messages: Record<string, ChatMessage[] | undefined>;
  /** When each workspace was last on screen (opened, or left for another one) —
   *  the only input to transcript eviction (§4.9.5) besides "is it running". */
  lastSeenAt: Record<string, number>;
  liveTurns: Record<string, LiveTurn | undefined>;
  /** In-flight "the agent is asking you a question" prompts, keyed by
   *  `${wsId}:${agentId}` — rendered as a picker inline in that agent's turn. */
  pendingAsks: Record<string, AskQuestionPayload | undefined>;
  /** Specialist sub-agent runs keyed by parent turn id (= parent message id).
   *  Populated live via subagent:updated and lazily via loadSubagents. */
  subagentRuns: Record<string, SubagentRun[] | undefined>;
  runningAgents: Record<string, number[]>;
  diffs: Record<string, WorkspaceDiff | undefined>;
  /** Direct workspaces: which comparison the Diff/Changes views show (default uncommitted). */
  diffScope: Record<string, DiffScope | undefined>;
  gitStatus: Record<string, GitStatusSummary | undefined>;
  prStatus: Record<string, PrStatus | null | undefined>;
  creatingPr: Record<string, boolean>; // PR creation in flight (commit+push+open)
  // Resolve-conflicts mode: the agent dispatched to merge+resolve, tracked so the
  // button reads "Resolving…" until a forced PR refresh flips mergeable back.
  // Transient (renderer-only), like prStatus. undefined = not resolving.
  resolvingPr: Record<string, { agentId: number } | undefined>;
  comments: Record<string, DiffComment[] | undefined>;
  todos: Record<string, Todo[] | undefined>;
  scripts: Record<string, WorkspaceScripts | undefined>;
  statusByKey: Record<string, StatusSlot | undefined>; // AI digests, keyed by statusKey()
  runScripts: Record<string, RunScript[] | undefined>; // per workspace (branch)
  skills: Record<string, SkillEntry[] | undefined>; // per workspace (harness + worktree)
  runScriptStates: Record<string, ScriptState | undefined>; // key `${wsId}:${scriptId}`
  rsGenerating: Record<string, boolean>; // AI detection in flight, per workspace
  rsGenError: Record<string, string | undefined>; // last AI detection error, per workspace
  editingScript: Record<string, string | null>; // run-script editor open in the center, per workspace

  // Integrated browser (§6). Renderer-only, deliberately not persisted — the
  // computed default URL is right on restart. `undefined` = no live view.
  previewByWs: Record<string, PreviewState | undefined>;
  // Whether each workspace's dev-server port is listening (§5) — drives the
  // Preview tab pulse independent of whether a preview view exists.
  portUpByWs: Record<string, boolean>;
  annotate: AnnotateState | null;

  composerAttachments: Record<string, Attachment[]>; // key `${wsId}:${agentId}` (per-session)
  composerAgent: Record<string, number>;
  composerDrafts: Record<string, string>; // unsent chatbox text per `${wsId}:${agentId}`
  /** Parked prompts (⌘S), newest first — see lib/promptStash. */
  promptStash: StashedPrompt[];
  agentCount: Record<string, number>; // monotonic high-water mark for allocating new chat ids
  chatIds: Record<string, number[]>; // open chat-tab ids per workspace (source of truth for tabs)
  // Mosaic layout of the center chat area: a tree of leaves (each an agentId,
  // a subset of chatIds) split row/col. The focused leaf is always composerAgent.
  // A single leaf = the classic one-chat view. Seeded lazily in loadWorkspaceData.
  paneLayout: Record<string, PaneNode>;
  closedTabs: Record<string, { agentId: number; index: number }[]>; // ⇧⌘T reopen stack (per workspace, LIFO)
  closedFiles: Record<string, { path: string; index: number }[]>; // ⇧⌘T editor-tab reopen stack (per workspace, LIFO)

  modal: Modal;
  /** Chat image lightbox (spotlight); null when closed. */
  lightbox: Lightbox;
  paletteOpen: boolean;
  /** Count of open floating popovers (hover cards, rail flyouts) — the preview's
   *  native view hides while > 0, since it paints above all DOM. */
  popovers: number;
  toasts: Toast[];
  /** The feedback popover (§10): open state + an optional attached error. */
  feedbackPanel: { open: boolean; error?: ErrorRef };
  ghSignIn: GhSignInState | null;
  /** Modal to reopen once GitHub sign-in resolves, so a sign-in launched from
   *  e.g. the clone-repo modal returns there instead of an empty screen. */
  ghSignInReturn: Modal;
  projectsMenuOpen: boolean;
  /** The full-panel Workspaces browser (all branches, incl. archived) is open,
   *  taking over the center in place of the active workspace. */
  showWorkspaces: boolean;
  /** Result of the last Conductor scan (null = not scanned yet). */
  conductorScan: ConductorScan | null;
  /** Instant presence check (from a stat of conductor.db) — gates every Conductor
   *  entry point and drives the "loading" affordance before the scan resolves. */
  conductorDetected: boolean;
  /** True while the (slower) full scan is in flight — drives the loading state. */
  conductorScanning: boolean;
  /** The scan failed (surfaced with a Retry instead of silent nothing). */
  conductorScanError: string | null;
  /** True while a Conductor import is running (disables the panel's button). */
  conductorImporting: boolean;

  // ---- Harness chat sync (docs/specs/harness-chat-sync.md) ----
  /** Either ~/.claude or ~/.codex has ≥1 importable session — gates the entry points. */
  harnessSyncDetected: boolean;
  /** Result of the last harness-sync scan (null = not scanned yet). */
  harnessSyncScan: HarnessSyncScan | null;
  /** True while the scan is in flight. */
  harnessSyncScanning: boolean;
  /** The scan failed. */
  harnessSyncScanError: string | null;
  /** True while an import is running (disables the panel's button). */
  harnessSyncImporting: boolean;
  /** Live engine status (toggle state, mirrored count, candidates). */
  harnessSyncStatus: HarnessSyncStatus | null;

  // actions
  init: () => Promise<void>;
  toast: (kind: Toast['kind'], text: string, action?: Toast['action']) => void;
  dismissToast: (id: number) => void;
  reportError: (ref: ErrorRef, toastId?: number) => Promise<boolean>;
  openFeedback: (error?: ErrorRef) => void;
  closeFeedback: () => void;
  setModal: (m: Modal) => void;
  /** Open the chat image lightbox at `entry.index` within `entry.images`. */
  openLightbox: (entry: NonNullable<Lightbox>) => void;
  closeLightbox: () => void;
  /** Move the lightbox by `delta` images, clamped to the ends (no-op past them). */
  stepLightbox: (delta: number) => void;
  setPalette: (open: boolean) => void;
  trackPopover: (delta: 1 | -1) => void;

  selectProject: (id: string) => void;
  selectWorkspace: (id: string | null) => void;
  /** Open the full-panel Workspaces browser. */
  openWorkspacesView: () => void;
  /** Bring one chat on screen from anywhere — switches project and workspace,
   *  reopens the tab if it was closed (a notification's "Open"). */
  openChat: (wsId: string, agentId: number | null) => void;
  setTab: (wsId: string, tab: WorkspaceTab) => void;

  // ---- integrated browser (Preview surface, §6/§9) ----
  /** Open (or focus) the Preview surface for a workspace, creating the live view
   *  and navigating it (defaults to the workspace URL). */
  openPreview: (wsId: string, url?: string) => void;
  /** Start this workspace's dev server, then open the Preview surface. Launches the
   *  workspace's run-kind Run card (the canonical run script — the Run dock uses the
   *  same path, and legacy `.maestro/settings.toml` run commands are migrated into a
   *  card); falls back to the legacy repo-settings run script only if no card exists. */
  startDevServer: (wsId: string) => Promise<void>;
  /** Mirror an authoritative `preview:state` push into the store. */
  setPreviewState: (p: PreviewState) => void;
  /** Free the live view (toolbar "Close preview") and drop back to chat. */
  closePreview: (wsId: string) => void;
  /** Freeze the frame: capture + layout index, then enter annotation mode. */
  startAnnotate: (wsId: string, agentId: number, cssW: number, cssH: number) => Promise<void>;
  /** Discard marks and resume the live view. */
  cancelAnnotate: () => void;
  /** Update the marks for the live annotation session. */
  setAnnotateItems: (items: AnnotationItem[]) => void;
  /** Composite → save PNG → stage the `annotations` attachment in the composer. */
  sendAnnotations: (wsId: string, agentId: number, pngBase64: string, text: string, count: number) => Promise<void>;
  /** Open (or focus) a worktree file in the center Editor surface, switching the
   *  center mode to 'editor'. Called by a Files-tab click instead of `fs:open`. */
  openFile: (wsId: string, path: string) => void;
  /** Close an editor tab (dirty guard is enforced at the call site). Falls back
   *  to a neighbouring tab, and leaves Editor mode when the last tab closes. */
  closeFile: (wsId: string, path: string) => void;
  /** Switch the center to the Diff surface, scrolled to `path`'s card. */
  revealDiffFile: (wsId: string, path: string) => void;
  /** A Files-tab rename/move: repoint every open editor tab at or under `from`
   *  to its new location (same slot, active + reopen stack follow). The buffer is
   *  reloaded from the new path, so callers refuse this for dirty tabs. */
  renameOpenFiles: (wsId: string, from: string, to: string) => void;
  /** ⌘W while the Editor surface is active: close the active editor tab. Bumps
   *  `closeActiveFileNonce` so the mounted EditorSurface runs its own
   *  dirty-guarded close (the confirm modal lives in the component). */
  requestCloseActiveFile: () => void;
  /** ⇧⌘T while the Editor surface is active: reopen the most recently closed
   *  editor tab (LIFO), re-inserting it at its old slot. */
  reopenClosedFile: (wsId: string) => void;
  setActiveFile: (wsId: string, path: string) => void;
  setFileDirty: (wsId: string, path: string, dirty: boolean) => void;
  setChatMeta: (wsId: string, agentId: number, patch: Partial<ChatMeta>) => void;
  /** Pick a model for a chat, switching the workspace's harness first when the
   *  model belongs to a different one. */
  setChatModel: (wsId: string, agentId: number, harness: HarnessId, modelId: string) => void;
  /** The user is viewing this chat — clear its unread indicator (no-op if already read). */
  markChatRead: (wsId: string, agentId: number) => void;
  /** Manually flag this chat as unread (right-click → "Mark as unread"). */
  markChatUnread: (wsId: string, agentId: number) => void;
  /** Mark every open session in a workspace read / unread at once (right-click a branch). */
  markWorkspaceRead: (wsId: string) => void;
  markWorkspaceUnread: (wsId: string) => void;
  /** Answer (or dismiss) an agent's structured question, unblocking its turn. */
  answerAsk: (wsId: string, agentId: number, askId: string, answers: AskAnswer[], cancelled?: boolean) => void;
  /** Fetch the specialist sub-agent runs a finished orchestrator turn spawned. */
  loadSubagents: (wsId: string, parentMessageId: string) => Promise<void>;
  removeQueued: (wsId: string, agentId: number, itemId: string) => void;
  /** `attachments` replaces the item's attachments; omit to keep them. */
  editQueued: (wsId: string, agentId: number, itemId: string, text: string, attachments?: Attachment[]) => void;
  /** Dismiss a chat's finished background tasks (running ones stay listed). */
  clearBackgroundTasks: (wsId: string, agentId: number) => void;
  refreshDiffStat: (wsId: string) => void;
  newChat: (wsId: string) => void;
  closeChat: (wsId: string, agentId: number) => void;
  closeActiveChat: (wsId: string) => void;
  /** Drag-reorder the session rail: move `agentId` to `toIndex` (an insertion
   *  index into the current `chatIds`). Rail order only — pane layout and focus
   *  are untouched. The new order is persisted per workspace (localStorage). */
  reorderChat: (wsId: string, agentId: number, toIndex: number) => void;
  /** Drag-reorder the sidebar: move `wsId` into `targetId`'s slot within their
   *  project (also reorders ⌘1–9). Persisted in localStorage. */
  reorderWorkspace: (wsId: string, targetId: string) => void;
  reopenClosedTab: (wsId: string) => void;
  /** Reopen a specific closed chat by id (the history menu). Re-inserts it at its
   *  old slot when known (else appends), clears the persisted `closed` flag, and
   *  focuses it — same restore as ⇧⌘T but targeted rather than LIFO. */
  reopenChat: (wsId: string, agentId: number) => void;
  /** Add a chat as a new right-most column in the split, sharing the row evenly.
   *  The rail "split" button — toggles: if the chat is already tiled alongside
   *  another pane, removes it instead; if it's the sole visible pane, just
   *  focuses it. */
  splitChat: (wsId: string, agentId: number) => void;
  /** Drop a chat (from the rail, or an existing pane being re-docked) against a
   *  side of the `targetId` pane — splitting it left/right (row) or top/bottom
   *  (col). Lifts the pane out of its old spot first when re-docking. */
  dropPaneBeside: (wsId: string, agentId: number, targetId: number, side: DropSide) => void;
  /** Remove a chat from the split (keeps it open in the session rail). No-op on
   *  the last remaining pane. */
  closePane: (wsId: string, agentId: number) => void;
  /** Collapse the split to just this chat (maximize a pane). */
  soloPane: (wsId: string, agentId: number) => void;
  setRightTab: (wsId: string, tab: 'files' | 'changes' | 'status' | 'skills') => void;
  setLayout: (patch: Partial<LayoutSizes>) => void; // live update during a drag
  commitLayout: () => void; // persist current sizes to localStorage on drag release
  setStatusScope: (wsId: string, scope: 'session' | 'workspace' | 'project') => void;
  /** Load the cached digest for a request; auto-generates when missing/stale. */
  loadStatus: (req: StatusRequest) => Promise<void>;
  generateStatus: (req: StatusRequest) => Promise<void>;
  loadRunScripts: (wsId: string) => Promise<void>;
  /** Refresh the workspace's skill list (slash menu + Skills tab share it). */
  loadSkills: (wsId: string) => Promise<void>;
  generateRunScripts: (wsId: string) => Promise<void>;
  execRunScript: (wsId: string, scriptId: string) => Promise<void>;
  stopRunScript: (wsId: string, scriptId: string) => void;
  setEditingScript: (wsId: string, scriptId: string | null) => void;
  /** Reveal a run script's terminal as its own dock tab (opening/focusing it,
   *  or collapsing the dock when it's already the shown tab). */
  openRunTab: (wsId: string, scriptId: string) => void;
  /** Close a run script's dock terminal tab — stops the session (like closing a
   *  terminal tab) and drops it from the tab bar. */
  closeRunTab: (wsId: string, scriptId: string) => void;
  setDock: (wsId: string, open: boolean, tab?: string) => void;
  /** A dock terminal acted on `dockFocusRequest` — clear it if it's still `key`. */
  consumeDockFocus: (key: string) => void;
  addDockTerminal: (wsId: string) => void;
  closeDockTerminal: (wsId: string, n: number) => void;
  openDockTerminal: (wsId: string) => void;
  /** Reveal the workspace terminal and run a command in it (e.g. install the
   *  remote harness). */
  runInTerminal: (wsId: string, text: string) => void;
  /** Managed one-click install of a harness on the workspace's remote host:
   *  main runs the installer over exec (progress in `remoteSetup`) and starts
   *  the CLI's sign-in in the terminal when needed — we just reveal it. */
  remoteSetupInstall: (wsId: string, harness: HarnessId) => Promise<void>;
  /** Start (or restart) just the sign-in step in the workspace terminal. */
  remoteSetupLogin: (wsId: string, harness: HarnessId, command: string) => void;
  /** Drop a setup entry — called by the composer's poll once the harness turns
   *  ready (or to dismiss an error). */
  remoteSetupClear: (wsId: string, harness: HarnessId) => void;
  focusComposer: () => void;
  openChatFind: () => void;

  loadWorkspaceData: (wsId: string) => Promise<void>;
  refreshGit: (wsId: string) => Promise<void>;
  refreshDiff: (wsId: string) => Promise<void>;
  /** Switch a direct workspace's diff comparison, then refetch. */
  setDiffScope: (wsId: string, scope: DiffScope) => void;
  refreshPr: (wsId: string, force?: boolean) => Promise<void>;
  /** Squash-merge the workspace's PR, toasting the outcome. */
  squashMergePr: (wsId: string, prNumber: number | null) => Promise<void>;
  refreshComments: (wsId: string) => Promise<void>;
  refreshTodos: (wsId: string) => Promise<void>;

  sendMessage: (wsId: string, text: string, agentId?: number) => Promise<void>;
  resendMessage: (wsId: string, agentId: number, text: string) => Promise<void>;
  /** Hold this message until `deliverAt` (epoch ms) instead of sending it now. */
  scheduleMessage: (
    wsId: string,
    agentId: number,
    text: string,
    deliverAt: number,
    kind: 'at' | 'limit-reset'
  ) => Promise<boolean>;
  editScheduled: (wsId: string, agentId: number, itemId: string, text: string) => void;
  cancelScheduled: (wsId: string, agentId: number, itemId: string) => void;
  sendScheduledNow: (wsId: string, agentId: number, itemId: string) => void;
  sendQueuedNow: (wsId: string, agentId: number, itemId: string) => void;
  stopAgent: (wsId: string, agentId: number) => void;
  setComposerAgent: (wsId: string, agentId: number) => void;
  setComposerDraft: (wsId: string, agentId: number, text: string) => void;
  /** Move this chat's draft (text + attachments) into the stash and clear the box. */
  stashDraft: (wsId: string, agentId: number) => void;
  /** Merge a stashed prompt back into this chat's draft and drop it from the stash. */
  restoreStash: (id: number, wsId: string, agentId: number) => void;
  dropStash: (id: number) => void;
  addAttachment: (wsId: string, agentId: number, a: Attachment) => void;
  removeAttachment: (wsId: string, agentId: number, index: number) => void;
  sendCommentsToAgent: (wsId: string) => void;
  startReviewAgent: (wsId: string) => Promise<void>;
  startConflictResolution: (wsId: string) => Promise<void>;

  startGithubSignIn: () => Promise<void>;
  cancelGithubSignIn: () => void;
  signOutGithub: () => Promise<void>;

  setProjectsMenu: (open: boolean) => void;
  openLocalProject: () => Promise<void>;
  /** Add a plain folder as a project — folder project, or "initialize git here". */
  addFolderProject: (folder: string, initGit: boolean) => Promise<void>;
  /** Open a folder on an SSH host as a remote project (git detected remotely). */
  openRemoteFolder: (hostId: string, folder: string) => Promise<void>;
  /** Reload the saved SSH hosts (after a Maestro Cloud join/leave, host edit, …). */
  refreshHosts: () => Promise<void>;
  refreshProjects: (selectProjectId?: string) => Promise<void>;
  /** Re-derive a project's capability rung (after gh sign-in, git init, …). */
  refreshCaps: (projectId: string) => Promise<void>;
  /** Scan the Conductor install (idempotent; caches into `conductorScan`).
   *  `force` re-runs even when a scan is cached (the panel's "Re-scan"). */
  scanConductor: (force?: boolean) => Promise<void>;
  /** Adopt the selected Conductor repos/workspaces/chats, then focus the most
   *  recently active imported workspace. */
  importFromConductor: (selections: ConductorSelection[]) => Promise<void>;
  /** Scan Claude Code & Codex transcripts for importable chats (harness-chat-sync). */
  scanHarnessSync: (force?: boolean) => Promise<void>;
  /** Import the selected harness sessions as mirrored chats; `enableSync` turns on
   *  ongoing sync. Focuses the most recently active imported workspace. */
  importHarnessSync: (sessionIds: string[], enableSync: boolean) => Promise<void>;
  /** Recreate an adopted workspace whose Conductor directory vanished, from its
   *  surviving branch (§4). */
  recreateAdoptedWorkspace: (wsId: string) => Promise<void>;

  saveSettings: (patch: Partial<GlobalSettings>) => Promise<void>;
  refreshHarnesses: (force?: boolean) => Promise<void>;
  setDefaultModel: (harness: HarnessId, modelId: string) => void;
  setDefaultEffort: (effort: string) => void;
  /** Stamp settings.theme (variant) + settings.colorTheme (family) onto the DOM,
   *  and the visual-effects level (settings.visualEffects, resolved for `auto`). */
  applyTheme: () => void;

  archiveWorkspace: (wsId: string) => Promise<void>;
  restoreWorkspace: (wsId: string) => Promise<void>;
  deleteWorkspace: (wsId: string) => Promise<void>;
  createPr: (wsId: string) => Promise<void>;
  continueWorkspace: (wsId: string) => Promise<void>;
}

/** Media query tracking the OS color scheme, used to resolve the 'system' theme. */
const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const resolveTheme = (theme: ThemeMode): 'dark' | 'light' =>
  theme === 'system' ? (systemDarkQuery.matches ? 'dark' : 'light') : theme;

/** The last applied theme, cached so the first frame wears it instead of flashing
 *  Classic until `app:init` answers with the real settings. */
const THEME_CACHE_KEY = 'maestro.themeCache';
const cachedTheme = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? '{}');
    return { theme: isThemeMode(v?.theme) ? v.theme : 'system', colorTheme: normalizeColorTheme(v?.colorTheme) } as const;
  } catch {
    return { theme: 'system', colorTheme: DEFAULT_COLOR_THEME } as const;
  }
})();
applyThemeToElement(document.documentElement, cachedTheme.colorTheme, resolveTheme(cachedTheme.theme) === 'dark');

/** The last resolved visual-effects level, so a machine that needs reduced
 *  effects never pays for the glass while `app:init` is in flight. */
const EFFECTS_CACHE_KEY = 'maestro.effectsCache';
try {
  if (localStorage.getItem(EFFECTS_CACHE_KEY) === 'reduced') applyEffects('reduced');
} catch {
  /* storage unavailable — full until app:init answers */
}

/** Unsent drafts from the last run, restored into the first frame. */
const savedDrafts = loadDrafts();

export const useApp = create<AppState>((set, get) => {
  let toastId = 0;

  // After an import: reload projects+workspaces (the onboarding gate closes as
  // projects.length flips > 0), then focus the most recently active imported
  // workspace.
  const focusImported = async (focusWorkspaceId: string | null) => {
    await get().refreshProjects();
    const s = get();
    const focusWs = focusWorkspaceId ? s.workspaces.find((w) => w.id === focusWorkspaceId) : null;
    const projectId = focusWs?.projectId ?? s.activeProjectId ?? s.projects[0]?.id ?? null;
    if (projectId) {
      localStorage.setItem('activeProjectId', projectId);
      set({ activeProjectId: projectId, showWorkspaces: false });
      void get().refreshCaps(projectId);
    }
    if (focusWs) get().selectWorkspace(focusWs.id);
  };

  // Re-apply when the OS flips its color scheme, but only while following it.
  systemDarkQuery.addEventListener('change', () => {
    if (get().settings.theme === 'system') get().applyTheme();
  });

  const patchWorkspace = (ws: Workspace) => {
    set((s) => {
      const idx = s.workspaces.findIndex((w) => w.id === ws.id);
      const workspaces = idx >= 0 ? s.workspaces.map((w) => (w.id === ws.id ? ws : w)) : [...s.workspaces, ws];
      return {
        workspaces,
        wsVersion: { ...s.wsVersion, [ws.id]: (s.wsVersion[ws.id] ?? 0) + 1 },
      };
    });
  };

  /** Stamp "this workspace was on screen just now" for transcript eviction
   *  (§4.9.5). Called both for the workspace being opened and for the one being
   *  left, so `lastSeenAt` means what it says. */
  const touchSeen = (...wsIds: (string | null | undefined)[]) => {
    const at = Date.now();
    set((s) => {
      const lastSeenAt = { ...s.lastSeenAt };
      for (const id of wsIds) if (id) lastSeenAt[id] = at;
      return { lastSeenAt };
    });
  };

  /** Free a workspace's editor buffers (models/docs) and drop its tab state —
   *  called on archive / delete / removal (spec §6, §9). */
  const evictEditor = (wsId: string) => {
    evictWorkspaceBuffers(wsId);
    set((s) => {
      if (!(wsId in s.openFiles) && !(wsId in s.activeFile) && !(wsId in s.dirtyFiles)) return {};
      const openFiles = { ...s.openFiles };
      const activeFile = { ...s.activeFile };
      const dirtyFiles = { ...s.dirtyFiles };
      delete openFiles[wsId];
      delete activeFile[wsId];
      delete dirtyFiles[wsId];
      return { openFiles, activeFile, dirtyFiles };
    });
  };

  return {
    loaded: false,
    projects: [],
    workspaces: [],
    activeProjectId: null,
    activeWorkspaceId: null,
    tabByWs: {},
    openFiles: {},
    activeFile: {},
    dirtyFiles: {},
    chatsMeta: {},
    queued: {},
    scheduled: {},
    bgTasks: {},
    projectOwners: {},
    projectCaps: {},
    hosts: [],
    hostStates: {},
    diffStats: {},
    rightTab: {},
    layout: loadLayout(),
    dockOpen: {},
    dockTab: {},
    dockFocusRequest: null,
    dockTermIds: {},
    dockRunIds: {},
    focusComposerNonce: 0,
    chatFindNonce: 0,
    diffFocus: null,
    closeActiveFileNonce: 0,
    resolvedTheme: resolveTheme(cachedTheme.theme),
    settings: {
      theme: cachedTheme.theme,
      colorTheme: cachedTheme.colorTheme,
      defaultHarness: 'claude-code',
      ideCommand: 'code',
      permissionMode: 'acceptEdits',
      linearToken: '',
      notifications: true,
      completionSound: DEFAULT_COMPLETION_SOUND,
      questionSound: true,
      defaultModels: {},
      defaultEffort: 'high',
      sidebarCollapsed: false,
      rightPanelCollapsed: false,
      refinePrompt: false,
      // Assume onboarded until the real settings arrive with app:init — the
      // loading splash covers that window, so the wizard never flashes.
      onboarded: true,
      autoStatus: true,
      autoDetectRunScripts: true,
    },
    ghAuth: { installed: false, authenticated: false, user: null },
    harnesses: [],
    remoteSetup: {},
    appVersion: '',
    platform: 'darwin',
    gpu: null,
    wsVersion: {},
    messages: {},
    lastSeenAt: {},
    liveTurns: {},
    pendingAsks: {},
    subagentRuns: {},
    runningAgents: {},
    diffs: {},
    diffScope: {},
    gitStatus: {},
    prStatus: {},
    creatingPr: {},
    resolvingPr: {},
    comments: {},
    todos: {},
    scripts: {},
    statusByKey: {},
    runScripts: {},
    skills: {},
    runScriptStates: {},
    rsGenerating: {},
    rsGenError: {},
    editingScript: {},
    statusScope: {},
    previewByWs: {},
    portUpByWs: {},
    annotate: null,
    composerAttachments: savedDrafts.attachments,
    composerAgent: {},
    composerDrafts: savedDrafts.text,
    promptStash: loadStash(),
    agentCount: {},
    chatIds: {},
    paneLayout: {},
    closedTabs: {},
    closedFiles: {},
    modal: null,
    lightbox: null,
    feedbackPanel: { open: false },
    paletteOpen: false,
    popovers: 0,
    toasts: [],
    ghSignIn: null,
    ghSignInReturn: null,
    projectsMenuOpen: false,
    showWorkspaces: false,
    conductorScan: null,
    conductorDetected: false,
    conductorScanning: false,
    conductorScanError: null,
    conductorImporting: false,
    harnessSyncDetected: false,
    harnessSyncScan: null,
    harnessSyncScanning: false,
    harnessSyncScanError: null,
    harnessSyncImporting: false,
    harnessSyncStatus: null,

    init: async () => {
      const data = await invoke('app:init');
      const lastProject = localStorage.getItem('activeProjectId');
      const lastWs = localStorage.getItem('activeWorkspaceId');
      const activeProjectId =
        (lastProject && data.projects.find((p) => p.id === lastProject)?.id) ||
        data.projects[0]?.id ||
        null;
      const wsForProject = data.workspaces.filter((w) => w.projectId === activeProjectId && !w.archived);
      const activeWorkspaceId =
        (lastWs && wsForProject.find((w) => w.id === lastWs)?.id) || wsForProject[0]?.id || null;

      set({
        loaded: true,
        projects: data.projects,
        workspaces: applyWorkspaceOrder(data.workspaces),
        settings: data.settings,
        ghAuth: data.ghAuth,
        harnesses: data.harnesses,
        appVersion: data.version,
        platform: data.platform,
        gpu: data.gpu ?? null,
        activeProjectId,
        activeWorkspaceId,
        projectOwners: data.projectOwners ?? {},
        projectCaps: data.projectCaps ?? {},
        hosts: data.hosts ?? [],
        // Session status (running/unread/waiting) for every workspace, so the
        // sidebar stacks are complete before any workspace is opened.
        chatsMeta: data.chatsMeta ?? {},
        runningAgents: data.runningAgents ?? {},
      });
      get().applyTheme();
      if (activeWorkspaceId) void get().loadWorkspaceData(activeWorkspaceId);
      for (const w of data.workspaces) {
        // Stat the diff for git worktrees and for folder projects that have
        // shadow-git checkpoints; plain (remote) folders have no diff to stat.
        const c = data.projectCaps?.[w.projectId];
        const hasDiff = c ? c.git || c.checkpoints : w.wsKind !== 'in-place';
        if (!w.archived && hasDiff) get().refreshDiffStat(w.id);
      }

      // Boot-time origin probes can time out; re-probe the misses once things settle.
      setTimeout(() => {
        const { projects, projectOwners } = get();
        for (const p of projects) if (p.kind === 'git' && !projectOwners[p.id]) void get().refreshCaps(p.id);
      }, 15_000);

      // gh auth + harness detection are slow probes — fill them in after first paint.
      void tryInvoke('github:auth').then((r) => r.data && set({ ghAuth: r.data }));
      void get().refreshHarnesses();
      // Detect a Conductor install so the "Continue from Conductor" onboarding
      // panel + entry points can surface (read-only; no-op when absent, §5).
      void get().scanConductor();
      // Detect importable Claude Code / Codex chats + fetch live sync status
      // (harness-chat-sync); read-only, no-op when neither CLI has transcripts.
      void tryInvoke('harnessSync:detect').then((r) => set({ harnessSyncDetected: !!r.data }));
      void tryInvoke('harnessSync:status').then((r) => r.data && set({ harnessSyncStatus: r.data }));

      // ---- push event wiring (once) ----
      subscribeToMain(set, get, { patchWorkspace, evictEditor });

      // Shed the transcripts / diffs of workspaces the user left long ago
      // (§4.9.5). One timer for the whole store; the policy lives in the evictor.
      setInterval(() => set(evictIdleWorkspaces), EVICT_SWEEP_MS);
    },

    toast: (kind, text, action) => {
      const id = ++toastId;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text, action }] }));
      setTimeout(() => get().dismissToast(id), kind === 'error' || action ? 8000 : 4000);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    // One-click error report (§10): send the error to the developer. When a
    // toastId is given, reflect progress on that toast and keep it around ~4s
    // after the result so "Sent ✓" is actually seen.
    reportError: async (ref, toastId) => {
      const setReport = (report: Toast['report']) =>
        set((s) => ({ toasts: s.toasts.map((t) => (t.id === toastId ? { ...t, report } : t)) }));
      if (toastId !== undefined) setReport('sending');
      const { data } = await tryInvoke('feedback:send', { text: '', includeDiagnostics: true, error: ref });
      const okSent = !!data?.ok;
      // With a toastId we reflect progress on the toast and keep it ~4s so
      // "Sent ✓" is seen; otherwise the caller (the chat Report link) shows its
      // own inline state, so we stay silent.
      if (toastId !== undefined) {
        setReport(okSent ? 'sent' : 'failed');
        setTimeout(() => get().dismissToast(toastId), 4000);
      }
      return okSent;
    },
    openFeedback: (error) => set({ feedbackPanel: { open: true, error } }),
    closeFeedback: () => set({ feedbackPanel: { open: false } }),

    setModal: (m) => set({ modal: m }),
    openLightbox: (entry) =>
      set({ lightbox: { ...entry, index: Math.max(0, Math.min(entry.index, entry.images.length - 1)) } }),
    closeLightbox: () => set({ lightbox: null }),
    stepLightbox: (delta) =>
      set((s) => {
        if (!s.lightbox) return {};
        const next = s.lightbox.index + delta;
        if (next < 0 || next >= s.lightbox.images.length) return {};
        return { lightbox: { ...s.lightbox, index: next } };
      }),
    setPalette: (open) => set({ paletteOpen: open }),
    trackPopover: (delta) => set((s) => ({ popovers: Math.max(0, s.popovers + delta) })),

    selectProject: (id) => {
      const s = get();
      if (s.activeProjectId === id) {
        // Same project — still leave the Workspaces browser if it's open.
        if (s.showWorkspaces) set({ showWorkspaces: false });
        return;
      }
      localStorage.setItem('activeProjectId', id);
      const first = s.workspaces.find((w) => w.projectId === id && !w.archived)?.id ?? null;
      set({ activeProjectId: id, activeWorkspaceId: first, showWorkspaces: false });
      touchSeen(s.activeWorkspaceId, first);
      void get().refreshCaps(id); // re-derive the rung on focus (git init / gh changes)
      if (first) void get().loadWorkspaceData(first);
    },

    selectWorkspace: (id) => {
      const prev = get().activeWorkspaceId;
      // Selecting a workspace always leaves the Workspaces browser.
      set({ activeWorkspaceId: id, showWorkspaces: false });
      touchSeen(prev, id); // the one we leave was on screen until now (§4.9.5)
      // Watch only the selected workspace's port (§5) so the Preview tab pulses
      // when its dev server is up; stop watching the one we left.
      if (prev && prev !== id) void invoke('port:unwatch', { workspaceId: prev });
      if (id) {
        localStorage.setItem('activeWorkspaceId', id);
        void get().loadWorkspaceData(id);
        void invoke('port:watch', { workspaceId: id });
      }
    },

    openWorkspacesView: () => set({ showWorkspaces: true }),

    openChat: (wsId, agentId) => {
      const ws = get().workspaces.find((w) => w.id === wsId);
      if (!ws) return;
      if (ws.projectId !== get().activeProjectId) get().selectProject(ws.projectId);
      get().selectWorkspace(wsId);
      if (agentId != null) get().reopenChat(wsId, agentId);
      get().setTab(wsId, 'chat');
    },

    setTab: (wsId, tab) => set((s) => ({ tabByWs: { ...s.tabByWs, [wsId]: tab } })),

    // ---- integrated browser ----
    openPreview: (wsId, url) => {
      get().setTab(wsId, 'preview');
      // Optimistic loading state so the surface renders immediately; the main
      // process broadcasts the authoritative preview:state right after.
      set((s) =>
        s.previewByWs[wsId]
          ? {}
          : {
              previewByWs: {
                ...s.previewByWs,
                [wsId]: {
                  workspaceId: wsId,
                  url: url ?? '',
                  title: '',
                  loading: true,
                  canGoBack: false,
                  canGoForward: false,
                  errors: 0,
                  warns: 0,
                  agentActive: false,
                  openedByAgent: false,
                  error: null,
                },
              },
            }
      );
      void tryInvoke('preview:open', { workspaceId: wsId, url }).then(({ error }) => {
        if (error) get().toast('error', `Preview: ${error}`);
      });
    },

    startDevServer: async (wsId) => {
      // Launch the server first, then arm the Preview (its refused-state auto-retry
      // flips the card live the moment the port comes up).
      let scripts = get().runScripts[wsId];
      if (scripts === undefined) {
        await get().loadRunScripts(wsId);
        scripts = get().runScripts[wsId];
      }
      const runCard = scripts?.find((r) => r.kind === 'run');
      if (runCard) {
        void get().execRunScript(wsId, runCard.id);
      } else {
        // No Run card — fall back to the legacy repo-settings run script; if that's
        // empty too, its error toast tells the user to add one.
        const { data } = await tryInvoke('script:run', { workspaceId: wsId, kind: 'run' });
        if (data && !data.ok && data.error) get().toast('info', data.error);
      }
      get().openPreview(wsId);
    },

    setPreviewState: (p) => {
      // A page that actually loaded joins the project's recent-URL list.
      const projectId = get().workspaces.find((w) => w.id === p.workspaceId)?.projectId;
      if (projectId && p.url && !p.loading && !p.error) rememberPreviewUrl(projectId, p.url);
      set((s) => ({ previewByWs: { ...s.previewByWs, [p.workspaceId]: p } }));
    },

    closePreview: (wsId) => {
      void invoke('preview:close', { workspaceId: wsId });
      set((s) => {
        const previewByWs = { ...s.previewByWs };
        delete previewByWs[wsId];
        return { previewByWs, annotate: s.annotate?.wsId === wsId ? null : s.annotate };
      });
      get().setTab(wsId, 'chat');
    },

    startAnnotate: async (wsId, agentId, cssW, cssH) => {
      // Capture WHILE the live view is still visible, so the frozen frame matches
      // exactly what the user sees; then enter annotate mode (which hides it).
      const shotRes = await tryInvoke('preview:capture', { workspaceId: wsId });
      if (!shotRes.data) {
        get().toast('error', shotRes.error ?? 'Could not capture the preview');
        return;
      }
      const elsRes = await tryInvoke('preview:elements', { workspaceId: wsId });
      const url = get().previewByWs[wsId]?.url ?? '';
      set({ annotate: { wsId, agentId, shot: shotRes.data, cssW, cssH, url, elements: elsRes.data?.items ?? [], items: [] } });
    },

    cancelAnnotate: () => set({ annotate: null }),

    setAnnotateItems: (items) => set((s) => (s.annotate ? { annotate: { ...s.annotate, items } } : {})),

    sendAnnotations: async (wsId, agentId, pngBase64, text, count) => {
      const name = `annotate-${Date.now()}.png`;
      const { data, error } = await tryInvoke('attachment:save', { workspaceId: wsId, name, dataBase64: pngBase64 });
      if (error || !data) {
        get().toast('error', error ?? 'Could not save annotation');
        return;
      }
      get().addAttachment(wsId, agentId, {
        kind: 'annotations',
        path: data.path,
        label: `Preview feedback (${count})`,
        text,
      });
      set({ annotate: null });
      get().setTab(wsId, 'chat');
      get().focusComposer();
    },

    openFile: (wsId, path) => {
      set((s) => {
        const list = s.openFiles[wsId] ?? EMPTY_ARR;
        const openFiles = list.includes(path) ? s.openFiles : { ...s.openFiles, [wsId]: [...list, path] };
        return { openFiles, activeFile: { ...s.activeFile, [wsId]: path } };
      });
      get().setTab(wsId, 'editor');
    },

    revealDiffFile: (wsId, path) => {
      set({ diffFocus: { wsId, path } });
      get().setTab(wsId, 'diff');
    },

    closeFile: (wsId, path) => {
      set((s) => {
        const list = s.openFiles[wsId] ?? EMPTY_ARR;
        if (!list.includes(path)) return {};
        const idx = list.indexOf(path);
        const remaining = list.filter((p) => p !== path);
        const dirty = { ...(s.dirtyFiles[wsId] ?? {}) };
        delete dirty[path];
        // Keep the active tab valid: if we closed the active file, fall to its
        // left neighbour (then right), else keep whatever was active.
        let active = s.activeFile[wsId] ?? null;
        if (active === path) active = remaining[Math.max(0, idx - 1)] ?? remaining[0] ?? null;
        // Push onto the ⇧⌘T reopen stack (LIFO), remembering its slot so a reopen
        // lands where it was. The buffer is disposed on close, so a reopen reloads
        // from disk — fine, since a dirty tab was saved/discarded via the guard.
        const stack = (s.closedFiles[wsId] ?? []).filter((e) => e.path !== path);
        const patch: Partial<AppState> = {
          openFiles: { ...s.openFiles, [wsId]: remaining },
          activeFile: { ...s.activeFile, [wsId]: active },
          dirtyFiles: { ...s.dirtyFiles, [wsId]: dirty },
          closedFiles: { ...s.closedFiles, [wsId]: [...stack, { path, index: idx }] },
        };
        // Closing the last file leaves nothing to show — drop back to chat.
        if (remaining.length === 0 && (s.tabByWs[wsId] ?? 'chat') === 'editor') {
          patch.tabByWs = { ...s.tabByWs, [wsId]: 'chat' };
        }
        return patch;
      });
    },

    renameOpenFiles: (wsId, from, to) =>
      set((s) => {
        const map = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
        const list = s.openFiles[wsId] ?? EMPTY_ARR;
        const active = s.activeFile[wsId] ?? null;
        const stack = s.closedFiles[wsId] ?? [];
        return {
          openFiles: { ...s.openFiles, [wsId]: list.map(map) },
          activeFile: { ...s.activeFile, [wsId]: active && map(active) },
          closedFiles: { ...s.closedFiles, [wsId]: stack.map((e) => ({ ...e, path: map(e.path) })) },
        };
      }),

    // ⌘W while Editor is the active surface. The dirty-guard confirm modal lives
    // in EditorSurface, so we just poke it via a nonce (only the visible editor,
    // which is `active`, reacts) rather than closing from here.
    requestCloseActiveFile: () => set((s) => ({ closeActiveFileNonce: s.closeActiveFileNonce + 1 })),

    // ⇧⌘T while Editor is the active surface: reopen the most recently closed
    // editor tab (LIFO). Skips any that are somehow open again, re-inserts at the
    // remembered slot, focuses it, and keeps the surface on Editor. The reconcile
    // effect in EditorSurface reloads the file once it reappears in openFiles.
    reopenClosedFile: (wsId) => {
      const stack = get().closedFiles[wsId] ?? [];
      const open = get().openFiles[wsId] ?? EMPTY_ARR;
      let i = stack.length - 1;
      while (i >= 0 && open.includes(stack[i].path)) i--;
      if (i < 0) {
        get().toast('info', 'No recently closed file to reopen');
        return;
      }
      const rec = stack[i];
      set((s) => {
        const list = s.openFiles[wsId] ?? EMPTY_ARR;
        const at = Math.min(Math.max(0, rec.index), list.length);
        const next = [...list.slice(0, at), rec.path, ...list.slice(at)];
        return {
          openFiles: { ...s.openFiles, [wsId]: next },
          activeFile: { ...s.activeFile, [wsId]: rec.path },
          closedFiles: { ...s.closedFiles, [wsId]: stack.filter((_, j) => j !== i) },
          tabByWs: { ...s.tabByWs, [wsId]: 'editor' },
        };
      });
    },

    setActiveFile: (wsId, path) =>
      set((s) => ({ activeFile: { ...s.activeFile, [wsId]: path } })),

    setFileDirty: (wsId, path, dirty) =>
      set((s) => {
        const cur = s.dirtyFiles[wsId] ?? {};
        if (!!cur[path] === dirty) return {}; // no-op — avoid a needless re-render
        const next = { ...cur };
        if (dirty) next[path] = true;
        else delete next[path];
        return { dirtyFiles: { ...s.dirtyFiles, [wsId]: next } };
      }),

    setChatMeta: (wsId, agentId, patch) => {
      set((s) => ({
        chatsMeta: patchChatMeta(s.chatsMeta, wsId, agentId, patch),
      }));
      void invoke('chat:meta:set', { workspaceId: wsId, agentId, patch });
    },

    setChatModel: (wsId, agentId, harness, modelId) => {
      const ws = get().workspaces.find((w) => w.id === wsId);
      // A model from another harness means switching the workspace's harness. Flip it
      // optimistically so the composer updates instantly; the main process clears the
      // now-unusable CLI sessions and broadcasts the authoritative row back.
      if (ws && ws.harness !== harness) {
        set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === wsId ? { ...w, harness } : w)) }));
        void invoke('workspace:setHarness', { workspaceId: wsId, harness });
      }
      get().setChatMeta(wsId, agentId, { model: modelId });
    },

    markChatRead: (wsId, agentId) => {
      const meta = get().chatsMeta[wsId]?.[String(agentId)];
      if (!isUnread(meta)) return; // nothing unread
      // Optimistic: the dot disappears now; main re-broadcasts the same state.
      set((s) => ({
        chatsMeta: patchChatMeta(s.chatsMeta, wsId, agentId, { lastReadAt: Date.now() }),
      }));
      void tryInvoke('chat:markRead', { workspaceId: wsId, agentId });
    },

    markChatUnread: (wsId, agentId) => {
      const meta = get().chatsMeta[wsId]?.[String(agentId)];
      if (isUnread(meta)) return; // already unread
      // Unread is derived as lastAgentAt > lastReadAt. Rewind the read marker just
      // behind the last agent activity so the green dot reappears; if the chat never
      // produced any output (never ran), synthesize activity "now" so a dot can show.
      const lastAgentAt = meta?.lastAgentAt ?? 0;
      if (lastAgentAt > 0) get().setChatMeta(wsId, agentId, { lastReadAt: lastAgentAt - 1 });
      else {
        const t = Date.now();
        get().setChatMeta(wsId, agentId, { lastAgentAt: t, lastReadAt: t - 1 });
      }
    },

    markWorkspaceRead: (wsId) => {
      const chats = get().chatsMeta[wsId] ?? {};
      for (const k of Object.keys(chats)) if (!chats[k]?.closed) get().markChatRead(wsId, Number(k));
    },

    markWorkspaceUnread: (wsId) => {
      const chats = get().chatsMeta[wsId] ?? {};
      const ids = Object.keys(chats).filter((k) => !chats[k]?.closed);
      // No sessions on record yet — flag the default one so the branch still lights up.
      if (ids.length === 0) get().markChatUnread(wsId, 1);
      else for (const k of ids) get().markChatUnread(wsId, Number(k));
    },

    answerAsk: (wsId, agentId, askId, answers, cancelled) => {
      // Optimistic: drop the picker now; main also broadcasts `ask:resolved`.
      set((s) => {
        const pendingAsks = { ...s.pendingAsks };
        delete pendingAsks[turnKey(wsId, agentId)];
        return { pendingAsks };
      });
      void tryInvoke('ask:answer', { askId, answers, cancelled });
    },

    loadSubagents: async (wsId, parentMessageId) => {
      const { data } = await tryInvoke('subagent:list', { workspaceId: wsId, parentMessageId });
      if (!data) return;
      set((s) => ({ subagentRuns: { ...s.subagentRuns, [parentMessageId]: data } }));
    },

    newChat: (wsId) => {
      const s = get();
      const msgs = s.messages[wsId] ?? [];
      const metaIds = Object.keys(s.chatsMeta[wsId] ?? {}).map(Number);
      const ids = s.chatIds[wsId] ?? DEFAULT_CHAT_IDS;
      // New id never reuses a closed one: take the high-water mark across every
      // source (open tabs, allocator, persisted messages/meta, running agents).
      const next =
        Math.max(1, s.agentCount[wsId] ?? 1, ...ids, ...msgs.map((m) => m.agentId), ...metaIds, ...(s.runningAgents[wsId] ?? [])) +
        1;
      set((st) => ({
        composerAgent: { ...st.composerAgent, [wsId]: next },
        agentCount: { ...st.agentCount, [wsId]: next },
        chatIds: { ...st.chatIds, [wsId]: [...(st.chatIds[wsId] ?? DEFAULT_CHAT_IDS), next] },
        // Opens in the focused pane (swaps the sole pane in single view; swaps the
        // focused pane in split view) — the other panes stay put.
        paneLayout: { ...st.paneLayout, [wsId]: withFocusedLeaf(st.paneLayout[wsId], st.composerAgent[wsId] ?? 1, next) },
      }));
      get().focusComposer();
    },

    // Non-destructive close (browser tab semantics): halt the run + queue, hide
    // the tab, and push it onto the reopen stack for ⇧⌘T. Messages, metadata,
    // and the harness session all stay in the DB; the chat is just flagged
    // `closed` (persisted) so it stays hidden across restarts until reopened.
    // Nothing is deleted, so no confirmation is needed. Closing the only tab is
    // allowed — a fresh blank chat replaces it (the closed one is still reopenable).
    closeChat: (wsId, agentId) => {
      const list = get().chatIds[wsId] ?? DEFAULT_CHAT_IDS;
      if (!list.includes(agentId)) return;
      const wasLast = list.length <= 1;
      void invoke('chat:stop', { workspaceId: wsId, agentId }); // halt run + clear queue
      flushChatEvents();
      set((s) => {
        const cur = s.chatIds[wsId] ?? DEFAULT_CHAT_IDS;
        const closedIdx = cur.indexOf(agentId);
        const remaining = cur.filter((id) => id !== agentId);

        // The agent is stopped and hidden — clear its transient run state, but
        // keep messages/drafts so a reopen restores the chat exactly as it was.
        const runningAgents = {
          ...s.runningAgents,
          [wsId]: (s.runningAgents[wsId] ?? []).filter((a) => a !== agentId),
        };
        const liveTurns = { ...s.liveTurns };
        delete liveTurns[turnKey(wsId, agentId)];

        // Drop the closed chat from the split too, then keep the focus invariant
        // (composerAgent is always a visible pane).
        const prevFocused = s.composerAgent[wsId] ?? 1;
        const paneCur = s.paneLayout[wsId] ?? leaf(prevFocused);
        let paneNext = removeLeaf(paneCur, agentId);
        let focused = prevFocused;
        if (!paneNext) {
          // No panes left visible — fall back to the closed tab's left neighbour
          // (matches classic single-view behavior). Null only when the last tab
          // is closing, in which case newChat() refills right after.
          const target = remaining[Math.max(0, closedIdx - 1)] ?? remaining[0];
          paneNext = leaf(target ?? prevFocused);
          focused = target ?? prevFocused;
        } else if (!hasLeaf(paneNext, focused)) {
          focused = firstLeaf(paneNext);
        }

        const stack = s.closedTabs[wsId] ?? [];
        return {
          chatIds: { ...s.chatIds, [wsId]: remaining },
          paneLayout: { ...s.paneLayout, [wsId]: paneNext },
          runningAgents,
          liveTurns,
          composerAgent: { ...s.composerAgent, [wsId]: focused },
          closedTabs: { ...s.closedTabs, [wsId]: [...stack, { agentId, index: closedIdx }] },
        };
      });
      // Persist the closed flag (also updates renderer meta so seeding/tabs agree).
      get().setChatMeta(wsId, agentId, { closed: true });
      // Never leave the workspace with zero sessions — replace the last one with
      // a fresh blank chat. Batched with the close above, so there's no empty flash.
      if (wasLast) get().newChat(wsId);
    },

    // ⌘W target: close the active chat tab. No confirm — closes are reversible
    // with ⇧⌘T; closing the only tab opens a fresh one in its place.
    closeActiveChat: (wsId) => {
      const s = get();
      get().closeChat(wsId, s.composerAgent[wsId] ?? 1);
    },

    // Drag-reorder the rail: lift `agentId` out and re-insert it at `toIndex` (an
    // insertion index into the *current* chatIds). Only rail order changes —
    // composerAgent/paneLayout key off agent ids, not positions, so focus and the
    // split layout are untouched. Persists the new order (survives restarts).
    reorderChat: (wsId, agentId, toIndex) => {
      set((s) => {
        const cur = s.chatIds[wsId] ?? DEFAULT_CHAT_IDS;
        const from = cur.indexOf(agentId);
        if (from === -1) return {};
        const without = cur.filter((id) => id !== agentId);
        // toIndex counts the dragged tab's old slot; drop it when inserting after.
        const insertAt = Math.min(Math.max(0, toIndex > from ? toIndex - 1 : toIndex), without.length);
        const next = [...without.slice(0, insertAt), agentId, ...without.slice(insertAt)];
        if (next.length === cur.length && next.every((id, i) => id === cur[i])) return {}; // no move
        return { chatIds: { ...s.chatIds, [wsId]: next } };
      });
      saveChatOrder(wsId, get().chatIds[wsId] ?? []);
    },

    reorderWorkspace: (wsId, targetId) => {
      set((s) => {
        const ws = s.workspaces.find((w) => w.id === wsId);
        if (!ws || wsId === targetId) return {};
        const inGroup = (w: Workspace) => w.projectId === ws.projectId && !w.archived;
        const group = s.workspaces.filter(inGroup);
        const to = group.findIndex((w) => w.id === targetId);
        if (to === -1) return {};
        const next = group.filter((w) => w !== ws);
        next.splice(to, 0, ws);
        // Refill the group's slots in the global list; other projects stay put.
        let k = 0;
        return { workspaces: s.workspaces.map((w) => (inGroup(w) ? next[k++] : w)) };
      });
      saveWorkspaceOrder(get().workspaces.map((w) => w.id));
    },

    // ⇧⌘T: reopen the most recently closed tab in this workspace (LIFO, like a
    // browser). Delegates to reopenChat, which restores the chat whole.
    reopenClosedTab: (wsId) => {
      const stack = get().closedTabs[wsId] ?? [];
      const last = stack[stack.length - 1];
      if (!last) {
        get().toast('info', 'No recently closed chat to reopen');
        return;
      }
      get().reopenChat(wsId, last.agentId);
    },

    // Targeted reopen (the Sessions history menu). Re-inserts the chat at its old
    // slot when we still remember it (the in-memory closedTabs stack), else
    // appends; clears the persisted `closed` flag so it survives restarts, drops
    // it from the reopen stack, and focuses it. Messages/meta were never deleted,
    // so the chat comes back exactly as it was.
    reopenChat: (wsId, agentId) => {
      const s = get();
      const ids = s.chatIds[wsId] ?? DEFAULT_CHAT_IDS;
      // Already open (e.g. reopened elsewhere) — just focus it.
      if (ids.includes(agentId)) {
        get().setComposerAgent(wsId, agentId);
        return;
      }
      const stack = s.closedTabs[wsId] ?? [];
      const rec = [...stack].reverse().find((e) => e.agentId === agentId);
      const at = rec ? rec.index : ids.length;
      const next = [...ids];
      next.splice(Math.min(Math.max(0, at), next.length), 0, agentId);
      set({
        chatIds: { ...s.chatIds, [wsId]: next },
        closedTabs: { ...s.closedTabs, [wsId]: stack.filter((e) => e.agentId !== agentId) },
        composerAgent: { ...s.composerAgent, [wsId]: agentId },
        paneLayout: { ...s.paneLayout, [wsId]: withFocusedLeaf(s.paneLayout[wsId], s.composerAgent[wsId] ?? 1, agentId) },
      });
      get().setChatMeta(wsId, agentId, { closed: false });
      get().setTab(wsId, 'chat');
      get().focusComposer();
    },

    setRightTab: (wsId, tab) => set((s) => ({ rightTab: { ...s.rightTab, [wsId]: tab } })),

    setLayout: (patch) => set((s) => ({ layout: clampLayout({ ...s.layout, ...patch }) })),
    commitLayout: () => {
      try {
        localStorage.setItem('layout', JSON.stringify(get().layout));
      } catch {
        /* ignore quota/serialization failures — sizes stay in memory */
      }
    },

    setStatusScope: (wsId, scope) => set((s) => ({ statusScope: { ...s.statusScope, [wsId]: scope } })),

    // Pull the cached digest; when it's missing or stale (and not already in
    // flight), kick off a regeneration — the result streams in via status:state.
    loadStatus: async (req) => {
      const key = statusKey(req);
      const { data } = await tryInvoke('status:get', req);
      if (!data) return;
      const willAutoGenerate = (data.stale || !data.report) && !data.generating && get().settings.autoStatus;
      set((s) => ({
        statusByKey: {
          ...s.statusByKey,
          [key]: {
            report: data.report,
            stale: data.stale,
            generating: data.generating || willAutoGenerate,
            error: s.statusByKey[key]?.error,
          },
        },
      }));
      if (willAutoGenerate) void get().generateStatus(req);
    },

    generateStatus: async (req) => {
      const key = statusKey(req);
      set((s) => ({
        statusByKey: {
          ...s.statusByKey,
          [key]: { report: s.statusByKey[key]?.report ?? null, stale: s.statusByKey[key]?.stale ?? true, generating: true },
        },
      }));
      const { data, error } = await tryInvoke('status:generate', req);
      if (error || (data && !data.ok)) {
        set((s) => ({
          statusByKey: {
            ...s.statusByKey,
            [key]: {
              report: s.statusByKey[key]?.report ?? null,
              stale: s.statusByKey[key]?.stale ?? true,
              generating: false,
              error: error ?? data?.error,
            },
          },
        }));
      }
    },

    loadRunScripts: async (wsId) => {
      const { data } = await tryInvoke('runscript:list', { workspaceId: wsId });
      if (data) set((s) => ({ runScripts: { ...s.runScripts, [wsId]: data } }));
    },

    loadSkills: async (wsId) => {
      const { data } = await tryInvoke('skill:list', { workspaceId: wsId });
      if (data) set((s) => ({ skills: { ...s.skills, [wsId]: data } }));
    },

    generateRunScripts: async (wsId) => {
      set((s) => ({
        rsGenerating: { ...s.rsGenerating, [wsId]: true },
        rsGenError: { ...s.rsGenError, [wsId]: undefined },
      }));
      const { data, error } = await tryInvoke('runscript:generate', { workspaceId: wsId });
      // State/result also arrive via runscript:generating / runscript:changed;
      // this handles IPC-level failure only.
      if (error) {
        set((s) => ({
          rsGenerating: { ...s.rsGenerating, [wsId]: false },
          rsGenError: { ...s.rsGenError, [wsId]: error },
        }));
      } else if (data && !data.ok && data.error) {
        set((s) => ({ rsGenError: { ...s.rsGenError, [wsId]: data.error } }));
      }
    },

    execRunScript: async (wsId, scriptId) => {
      // Reveal the output immediately — feedback beats waiting for the spawn. The
      // script gets its own dock terminal tab (a full terminal, like Terminal).
      get().openRunTab(wsId, scriptId);
      const { data, error } = await tryInvoke('runscript:exec', { workspaceId: wsId, scriptId });
      if (error || (data && !data.ok)) get().toast('error', error ?? data?.error ?? 'Failed to run script');
    },

    stopRunScript: (wsId, scriptId) => {
      void invoke('runscript:stop', { workspaceId: wsId, scriptId });
    },

    setEditingScript: (wsId, scriptId) =>
      set((s) => ({ editingScript: { ...s.editingScript, [wsId]: scriptId } })),

    openRunTab: (wsId, scriptId) => {
      set((s) => {
        const tabId = `rs:${scriptId}`;
        const ids = s.dockRunIds[wsId] ?? EMPTY_ARR;
        // Clicking the already-shown tab collapses the dock (matches the tab bar).
        const showing = (s.dockOpen[wsId] ?? true) && s.dockTab[wsId] === tabId;
        return {
          dockRunIds: { ...s.dockRunIds, [wsId]: ids.includes(scriptId) ? ids : [...ids, scriptId] },
          dockOpen: { ...s.dockOpen, [wsId]: !showing },
          dockTab: { ...s.dockTab, [wsId]: tabId },
          dockFocusRequest: showing ? s.dockFocusRequest : `${wsId}:${tabId}`,
        };
      });
    },

    closeRunTab: (wsId, scriptId) => {
      // Closing a run-script terminal stops its session, just like closing a
      // Terminal tab kills that shell (the card's ■ does the same).
      void invoke('runscript:stop', { workspaceId: wsId, scriptId });
      set((s) => {
        const ids = (s.dockRunIds[wsId] ?? EMPTY_ARR).filter((x) => x !== scriptId);
        let dockTab = s.dockTab;
        if (s.dockTab[wsId] === `rs:${scriptId}`) {
          const next = ids.length ? `rs:${ids[ids.length - 1]}` : 'run';
          dockTab = { ...s.dockTab, [wsId]: next };
        }
        return { dockRunIds: { ...s.dockRunIds, [wsId]: ids }, dockTab };
      });
    },

    setDock: (wsId, open, tab) =>
      set((s) => ({
        dockOpen: { ...s.dockOpen, [wsId]: open },
        dockTab: tab ? { ...s.dockTab, [wsId]: tab } : s.dockTab,
        dockFocusRequest: open ? `${wsId}:${tab ?? s.dockTab[wsId] ?? 'run'}` : s.dockFocusRequest,
      })),

    consumeDockFocus: (key) => set((s) => (s.dockFocusRequest === key ? { dockFocusRequest: null } : {})),

    addDockTerminal: (wsId) => {
      set((s) => {
        const list = s.dockTermIds[wsId] ?? DEFAULT_TERM_IDS;
        const n = (list.length ? Math.max(...list) : 0) + 1;
        return {
          dockTermIds: { ...s.dockTermIds, [wsId]: [...list, n] },
          dockOpen: { ...s.dockOpen, [wsId]: true },
          dockTab: { ...s.dockTab, [wsId]: `term:${n}` },
          dockFocusRequest: `${wsId}:term:${n}`,
        };
      });
    },

    closeDockTerminal: (wsId, n) => {
      // Terminal 1 uses the bare pty id; extras are suffixed (see ptyIdFor).
      void invoke('pty:kill', { id: n === 1 ? `term:${wsId}` : `term:${wsId}:${n}` });
      set((s) => {
        const list = (s.dockTermIds[wsId] ?? DEFAULT_TERM_IDS).filter((x) => x !== n);
        let dockTab = s.dockTab;
        // If the closed terminal was showing, fall back to another terminal
        // (or the Run script tab, which always exists).
        if ((s.dockTab[wsId] ?? 'term:1') === `term:${n}`) {
          const next = list.length ? `term:${list[list.length - 1]}` : 'run';
          dockTab = { ...s.dockTab, [wsId]: next };
        }
        return { dockTermIds: { ...s.dockTermIds, [wsId]: list }, dockTab };
      });
    },

    openDockTerminal: (wsId) => {
      set((s) => {
        // Ensure at least one terminal exists, then reveal it. Reuse the current
        // terminal tab when it's still open; otherwise show the first one.
        const list = (s.dockTermIds[wsId] ?? DEFAULT_TERM_IDS).length
          ? s.dockTermIds[wsId] ?? DEFAULT_TERM_IDS
          : [1];
        const cur = s.dockTab[wsId];
        const target =
          cur?.startsWith('term:') && list.includes(Number(cur.split(':')[1])) ? cur : `term:${list[0]}`;
        return {
          dockTermIds: { ...s.dockTermIds, [wsId]: list },
          dockOpen: { ...s.dockOpen, [wsId]: true },
          dockTab: { ...s.dockTab, [wsId]: target },
          dockFocusRequest: `${wsId}:${target}`,
        };
      });
    },

    runInTerminal: (wsId, text) => {
      get().openDockTerminal(wsId); // reveal terminal 1 so the user sees it run
      void tryInvoke('workspace:sendToTerminal', { workspaceId: wsId, text });
    },

    remoteSetupInstall: async (wsId, harness) => {
      const key = `${wsId}:${harness}`;
      if (get().remoteSetup[key]?.phase === 'installing') return; // one at a time
      set((s) => ({ remoteSetup: { ...s.remoteSetup, [key]: { phase: 'installing' } } }));
      const { data, error } = await tryInvoke('harness:remoteInstall', { workspaceId: wsId, harness });
      set((s) => {
        const remoteSetup = { ...s.remoteSetup };
        if (data?.needsLogin) remoteSetup[key] = { phase: 'login' };
        else if (data && !data.ok) remoteSetup[key] = { phase: 'error', error: data.error ?? 'Install failed.' };
        else if (!data && error) remoteSetup[key] = { phase: 'error', error };
        else delete remoteSetup[key]; // installed && already authed (or local project)
        return { remoteSetup };
      });
      // Main already typed the CLI's sign-in into terminal 1 — reveal it so the
      // user lands on the prompts.
      if (data?.needsLogin) get().openDockTerminal(wsId);
    },

    remoteSetupLogin: (wsId, harness, command) => {
      get().runInTerminal(wsId, command);
      set((s) => ({ remoteSetup: { ...s.remoteSetup, [`${wsId}:${harness}`]: { phase: 'login' } } }));
    },

    remoteSetupClear: (wsId, harness) =>
      set((s) => {
        const key = `${wsId}:${harness}`;
        if (!s.remoteSetup[key]) return s;
        const remoteSetup = { ...s.remoteSetup };
        delete remoteSetup[key];
        return { remoteSetup };
      }),

    focusComposer: () => set((s) => ({ focusComposerNonce: s.focusComposerNonce + 1 })),
    openChatFind: () => set((s) => ({ chatFindNonce: s.chatFindNonce + 1 })),

    loadWorkspaceData: async (wsId) => {
      const s = get();
      // Every "the user is looking at this workspace" path lands here (select,
      // project switch, startup), so it is also where idleness starts counting.
      touchSeen(wsId);
      if (!s.messages[wsId]) {
        const msgs = await invoke('chat:list', { workspaceId: wsId }).catch(() => []);
        set((st) => ({ messages: { ...st.messages, [wsId]: msgs } }));
        const maxAgent = Math.max(1, ...msgs.map((m) => m.agentId));
        set((st) => ({ agentCount: { ...st.agentCount, [wsId]: Math.max(st.agentCount[wsId] ?? 1, maxAgent) } }));
      }
      const running = await invoke('chat:running', { workspaceId: wsId }).catch(() => [] as number[]);
      set((st) => ({ runningAgents: { ...st.runningAgents, [wsId]: running } }));
      // A renderer that came up mid-turn — a reload, or the window recovering from
      // a crash — has seen none of the turn's events, and would show a running
      // chat with nothing in it until the next one. Main holds every running
      // turn's blocks; take them. Only ever fills a gap: a live turn this renderer
      // already has at least as much of is left alone (the normal case, where the
      // events got here first).
      if (running.length) {
        const live = await invoke('chat:live', { workspaceId: wsId }).catch(() => ({}));
        flushChatEvents(); // compare against every event that got here first
        set((st) => {
          const liveTurns = { ...st.liveTurns };
          let changed = false;
          for (const [agentId, snap] of Object.entries(live)) {
            const key = turnKey(wsId, Number(agentId));
            const have = liveTurns[key];
            const haveBlocks = have ? have.finalBlocks.length + have.deltaBlocks.length : -1;
            if (haveBlocks >= snap.finalBlocks.length + snap.deltaBlocks.length) continue;
            liveTurns[key] = { agentId: Number(agentId), running: true, ...snap };
            changed = true;
          }
          return changed ? { liveTurns } : {};
        });
      }
      // Background tasks live in main's memory, so re-read them on (re)load — a
      // renderer reload must not lose the "this task was terminated" record.
      const bg = await invoke('chat:tasks', { workspaceId: wsId }).catch(() => ({}));
      set((st) => {
        const bgTasks = { ...st.bgTasks };
        for (const [agentId, list] of Object.entries(bg)) bgTasks[`${wsId}:${agentId}`] = list;
        return { bgTasks };
      });
      // Scheduled sends are persisted in main, so (re)load restores them — a
      // message set for 6 PM must still be visible after an app restart.
      const sched = await invoke('chat:schedule:list', { workspaceId: wsId }).catch(() => [] as ScheduledMessage[]);
      set((st) => {
        const scheduled = { ...st.scheduled };
        for (const key of Object.keys(scheduled)) {
          if (key.startsWith(`${wsId}:`)) delete scheduled[key]; // drop stale keys for this ws
        }
        for (const m of sched) (scheduled[`${wsId}:${m.agentId}`] ??= []).push(m);
        return { scheduled };
      });
      const meta = await invoke('chat:meta', { workspaceId: wsId }).catch(() => ({}));
      set((st) => ({ chatsMeta: { ...st.chatsMeta, [wsId]: meta } }));
      // Seed the open chat-tab list once per session from what's persisted:
      // chat 1 plus every agent that has messages, metadata, or a running turn.
      set((st) => {
        if (st.chatIds[wsId]) return {};
        const ids = new Set<number>([1]);
        for (const m of st.messages[wsId] ?? []) ids.add(m.agentId);
        for (const k of Object.keys(meta)) ids.add(Number(k));
        for (const r of st.runningAgents[wsId] ?? []) ids.add(r);
        // Keep the allocator above every id ever used — including closed tabs —
        // so a new chat never collides with one that's still reopenable.
        const maxId = Math.max(1, ...ids);
        // Closed tabs stay hidden until reopened (⇧⌘T); drop them from the open set.
        for (const k of Object.keys(meta)) {
          if ((meta as Record<string, ChatMeta>)[k]?.closed) ids.delete(Number(k));
        }
        if (ids.size === 0) ids.add(1);
        // Numeric order is the base; a saved drag-order (if any) re-sorts it,
        // ignoring ids that are no longer open and appending any new ones.
        const list = applyChatOrder([...ids].sort((a, b) => a - b), loadChatOrders()[wsId]);
        // Land on a session that's actually open. composerAgent isn't persisted,
        // so on startup it's unset and would default to chat 1 — which may have
        // been closed. Keep the current pick only if it's still open; otherwise
        // fall back to the last open session instead of a closed/removed one.
        const current = st.composerAgent[wsId];
        const active = current != null && list.includes(current) ? current : list[list.length - 1];
        return {
          chatIds: { ...st.chatIds, [wsId]: list },
          agentCount: { ...st.agentCount, [wsId]: Math.max(st.agentCount[wsId] ?? 1, maxId) },
          composerAgent: { ...st.composerAgent, [wsId]: active },
          // Start unsplit — one pane showing the active chat. Split view is opt-in.
          paneLayout: { ...st.paneLayout, [wsId]: leaf(active) },
        };
      });
      const scripts = await invoke('script:status', { workspaceId: wsId }).catch(() => undefined);
      if (scripts) set((st) => ({ scripts: { ...st.scripts, [wsId]: scripts } }));
      void tryInvoke('runscript:states', { workspaceId: wsId }).then(({ data }) => {
        if (!data) return;
        set((st) => {
          const merged = { ...st.runScriptStates };
          for (const [scriptId, state] of Object.entries(data)) merged[`${wsId}:${scriptId}`] = state;
          return { runScriptStates: merged };
        });
      });
      // Only fire git/PR probes the project's rung actually supports — folder
      // projects skip them entirely (the calls, not just the rendering).
      const ws = get().workspaces.find((w) => w.id === wsId);
      const caps = capsOf(get(), ws?.projectId);
      if (caps.git || caps.checkpoints) {
        void get().refreshGit(wsId);
        get().refreshDiffStat(wsId);
      }
      void get().refreshComments(wsId);
      void get().refreshTodos(wsId);
      if (caps.githubRemote && get().ghAuth.authenticated) void get().refreshPr(wsId);
    },

    refreshGit: (wsId) =>
      coalesce(`git:${wsId}`, async () => {
        const { data } = await tryInvoke('git:status', { workspaceId: wsId });
        if (data) set((s) => ({ gitStatus: { ...s.gitStatus, [wsId]: data } }));
      }),

    refreshDiff: (wsId) =>
      coalesce(`diff:${wsId}`, async () => {
        const scope = get().diffScope[wsId];
        const { data, error } = await tryInvoke('git:diff', scope ? { workspaceId: wsId, scope } : { workspaceId: wsId });
        // Scope switched mid-flight: drop this answer; coalesce reruns with the new one.
        if (data?.scope && data.scope !== (get().diffScope[wsId] ?? 'uncommitted')) return;
        if (data) set((s) => ({ diffs: { ...s.diffs, [wsId]: data } }));
        else if (error) get().toast('error', `Diff failed: ${error}`);
      }),

    setDiffScope: (wsId, scope) => {
      if ((get().diffScope[wsId] ?? 'uncommitted') === scope) return;
      set((s) => ({ diffScope: { ...s.diffScope, [wsId]: scope }, diffs: { ...s.diffs, [wsId]: undefined } }));
      void get().refreshDiff(wsId);
    },

    refreshPr: async (wsId, force) => {
      const { data } = await tryInvoke('github:prStatus', { workspaceId: wsId, force });
      set((s) => ({ prStatus: { ...s.prStatus, [wsId]: data ?? null } }));
    },
    squashMergePr: async (wsId, prNumber) => {
      if (isDirectIn(get(), wsId)) return get().toast('info', DIRECT_REFUSAL('merge pull requests'));
      const res = await tryInvoke('github:prMerge', { workspaceId: wsId, method: 'squash' });
      if (res.error || !res.data?.ok) {
        const base = get().prStatus[wsId]?.baseRefName ?? '';
        get().toast('error', mergeFailureMessage(res.error ?? res.data?.error, base));
        // Re-ask GitHub: a refusal means our cached mergeability was optimistic,
        // and the merge buttons should stop offering a merge it can't do.
        void get().refreshPr(wsId, true);
        return;
      }
      get().toast('success', prNumber != null ? `PR #${prNumber} merged` : 'PR merged');
      void get().refreshPr(wsId, true);
    },

    refreshComments: async (wsId) => {
      const { data } = await tryInvoke('comment:list', { workspaceId: wsId });
      if (data) set((s) => ({ comments: { ...s.comments, [wsId]: data } }));
    },

    refreshTodos: async (wsId) => {
      const { data } = await tryInvoke('todo:list', { workspaceId: wsId });
      if (data) set((s) => ({ todos: { ...s.todos, [wsId]: data } }));
    },

    sendMessage: async (wsId, text, agentIdArg) => {
      flushChatEvents(); // a queued `done` decides whether this send starts a turn
      const s = get();
      const agentId = agentIdArg ?? s.composerAgent[wsId] ?? 1;
      const attKey = `${wsId}:${agentId}`;
      const attachments = s.composerAttachments[attKey] ?? [];
      if (!text.trim() && attachments.length === 0) return;
      set((st) => ({ composerAttachments: { ...st.composerAttachments, [attKey]: [] } }));
      // Optimistic "Thinking…": mark the agent running + seed an empty live turn
      // so feedback is instant on send — the real first stream event can lag a
      // couple seconds behind (esp. over SSH: bridge setup + remote CLI startup).
      // Skipped when the agent is already running (this send will queue).
      const alreadyRunning = (s.runningAgents[wsId] ?? []).includes(agentId);
      if (!alreadyRunning) {
        set((st) => ({
          runningAgents: {
            ...st.runningAgents,
            [wsId]: [...(st.runningAgents[wsId] ?? []).filter((a) => a !== agentId), agentId],
          },
          liveTurns: {
            ...st.liveTurns,
            [turnKey(wsId, agentId)]: { agentId, finalBlocks: [], deltaBlocks: [], accumType: null, accumText: '', running: true, startedAt: Date.now() },
          },
        }));
      }
      if (!s.chatsMeta[wsId]?.[String(agentId)]?.title && text.trim()) {
        // Mirror the main-process behavior (§7: first *text* message names the
        // tab; attachment-only sends leave it "New chat") so the tab names itself
        // instantly.
        set((st) => ({
          chatsMeta: patchChatMeta(st.chatsMeta, wsId, agentId, { title: provisionalTitle(text) }),
        }));
      }
      const { data, error } = await tryInvoke('chat:send', {
        workspaceId: wsId,
        agentId,
        text: text.trim(),
        attachments,
      });
      // Roll back the optimistic running/live-turn if the send failed or was
      // actually queued behind a running turn (no new turn started for us).
      if (!alreadyRunning && (error || !data?.ok || data?.queued)) {
        flushChatEvents();
        set((st) => {
          const liveTurns = { ...st.liveTurns };
          delete liveTurns[turnKey(wsId, agentId)];
          return {
            liveTurns,
            runningAgents: { ...st.runningAgents, [wsId]: (st.runningAgents[wsId] ?? []).filter((a) => a !== agentId) },
          };
        });
      }
      if (error || (data && !data.ok)) {
        get().toast('error', error ?? data?.error ?? 'Failed to send');
      }
      // data.queued → shown in the Queued list above the composer; no toast needed.
    },

    // Edit-and-resend: fires the revised text as a fresh turn on the same chat
    // (or queues it if that agent is mid-run). The original message stays put —
    // the agent already received it, so history isn't rewritten. Text only;
    // the source message's attachments aren't re-sent.
    resendMessage: async (wsId, agentId, text) => {
      if (!text.trim()) return;
      // Land the user on the chat the edit belongs to, so the new turn is visible.
      if ((get().composerAgent[wsId] ?? 1) !== agentId) get().setComposerAgent(wsId, agentId);
      const { data, error } = await tryInvoke('chat:send', {
        workspaceId: wsId,
        agentId,
        text: text.trim(),
        attachments: [],
      });
      if (error || (data && !data.ok)) {
        get().toast('error', error ?? data?.error ?? 'Failed to send');
      }
    },

    // Same payload a send would take — it just waits for a clock instead of a
    // free agent. Attachments are consumed exactly as sendMessage consumes
    // them, so the composer empties either way.
    scheduleMessage: async (wsId, agentId, text, deliverAt, kind) => {
      const attKey = `${wsId}:${agentId}`;
      const attachments = get().composerAttachments[attKey] ?? [];
      if (!text.trim() && attachments.length === 0) return false;
      const { data, error } = await tryInvoke('chat:schedule:add', {
        workspaceId: wsId,
        agentId,
        text: text.trim(),
        attachments,
        deliverAt,
        kind,
      });
      if (error || !data?.ok) {
        get().toast('error', error ?? data?.error ?? 'Couldn’t schedule message');
        return false;
      }
      set((st) => ({ composerAttachments: { ...st.composerAttachments, [attKey]: [] } }));
      return true;
    },

    // Main broadcasts the updated list back on 'chat:scheduled' for all three.
    editScheduled: (wsId, agentId, itemId, text) => {
      void invoke('chat:schedule:edit', { workspaceId: wsId, agentId, itemId, text });
    },

    cancelScheduled: async (wsId, agentId, itemId) => {
      // A remote row's box job can't always be removed (host unreachable); main
      // then keeps the row and returns the error, which we surface (§4.7).
      const { data, error } = await tryInvoke('chat:schedule:remove', { workspaceId: wsId, agentId, itemId });
      if (error || (data && !data.ok)) get().toast('error', error ?? data?.error ?? 'Couldn’t cancel scheduled message');
    },

    sendScheduledNow: (wsId, agentId, itemId) => {
      void invoke('chat:schedule:sendNow', { workspaceId: wsId, agentId, itemId });
    },

    removeQueued: (wsId, agentId, itemId) => {
      void invoke('chat:queue:remove', { workspaceId: wsId, agentId, itemId });
    },

    editQueued: (wsId, agentId, itemId, text, attachments) => {
      void invoke('chat:queue:edit', { workspaceId: wsId, agentId, itemId, text, attachments });
    },

    // Steer: interrupt the running turn so this queued message runs next. Main
    // promotes it, stops the turn (keeping the queue), and its run-finished hook
    // fires it; the resulting turn events re-sync runningAgents on their own.
    sendQueuedNow: (wsId, agentId, itemId) => {
      void invoke('chat:queue:sendNow', { workspaceId: wsId, agentId, itemId });
    },

    clearBackgroundTasks: (wsId, agentId) => {
      // Main broadcasts the trimmed ledger back on 'chat:tasks'.
      void invoke('chat:tasks:clear', { workspaceId: wsId, agentId });
    },

    refreshDiffStat: (wsId) => {
      void coalesce(`stat:${wsId}`, async () => {
        const r = await tryInvoke('git:diffstat', { workspaceId: wsId });
        if (r.data) set((s) => ({ diffStats: { ...s.diffStats, [wsId]: r.data } }));
      });
    },

    stopAgent: (wsId, agentId) => {
      void invoke('chat:stop', { workspaceId: wsId, agentId }).then(() =>
        // Re-sync from main: if the run already ended (or never existed), this
        // clears any zombie running state immediately.
        invoke('chat:running', { workspaceId: wsId }).then((running) =>
          set((s) => ({ runningAgents: { ...s.runningAgents, [wsId]: running } }))
        )
      );
    },

    setComposerAgent: (wsId, agentId) => {
      set((s) => {
        const ids = s.chatIds[wsId] ?? DEFAULT_CHAT_IDS;
        // Selecting an agent (e.g. the review agent) also opens its tab if new.
        const chatIds = ids.includes(agentId)
          ? s.chatIds
          : { ...s.chatIds, [wsId]: [...ids, agentId].sort((a, b) => a - b) };
        return {
          composerAgent: { ...s.composerAgent, [wsId]: agentId },
          agentCount: { ...s.agentCount, [wsId]: Math.max(s.agentCount[wsId] ?? 1, agentId) },
          chatIds,
          // Focusing a chat shows it in the focused pane (swaps the sole/focused
          // leaf). If it's already a visible pane, the layout is left as-is.
          paneLayout: { ...s.paneLayout, [wsId]: withFocusedLeaf(s.paneLayout[wsId], s.composerAgent[wsId] ?? 1, agentId) },
        };
      });
    },

    splitChat: (wsId, agentId) => {
      const s = get();
      const focused = s.composerAgent[wsId] ?? 1;
      const cur = s.paneLayout[wsId] ?? leaf(focused);
      if (hasLeaf(cur, agentId)) {
        // Already tiled alongside another pane — click again to remove it.
        if (paneCount(cur) > 1) {
          get().closePane(wsId, agentId);
          return;
        }
        // Sole visible pane — nothing to toggle off, just focus it.
        get().setComposerAgent(wsId, agentId);
        get().focusComposer();
        return;
      }
      // At the cap, an explicit split can't add a pane — swap the focused pane
      // instead so the click still lands the user on that chat.
      if (paneCount(cur) >= MAX_PANES) {
        get().toast('info', `Up to ${MAX_PANES} chats at once — close one to open another`);
        get().setComposerAgent(wsId, agentId);
        return;
      }
      set((st) => {
        const ids = st.chatIds[wsId] ?? DEFAULT_CHAT_IDS;
        const chatIds = ids.includes(agentId)
          ? st.chatIds
          : { ...st.chatIds, [wsId]: [...ids, agentId].sort((a, b) => a - b) };
        const layout = st.paneLayout[wsId] ?? leaf(st.composerAgent[wsId] ?? 1);
        return {
          composerAgent: { ...st.composerAgent, [wsId]: agentId },
          agentCount: { ...st.agentCount, [wsId]: Math.max(st.agentCount[wsId] ?? 1, agentId) },
          chatIds,
          paneLayout: { ...st.paneLayout, [wsId]: appendColumn(layout, agentId) },
        };
      });
      get().focusComposer();
    },

    dropPaneBeside: (wsId, agentId, targetId, side) => {
      const s = get();
      if (agentId === targetId) return; // dropped onto itself
      const focused = s.composerAgent[wsId] ?? 1;
      const cur = s.paneLayout[wsId] ?? leaf(focused);
      const alreadyOpen = hasLeaf(cur, agentId);
      // Adding a brand-new pane is capped; re-docking one already on screen isn't.
      if (!alreadyOpen && paneCount(cur) >= MAX_PANES) {
        get().toast('info', `Up to ${MAX_PANES} chats at once — close one to open another`);
        get().setComposerAgent(wsId, agentId);
        return;
      }
      set((st) => {
        const ids = st.chatIds[wsId] ?? DEFAULT_CHAT_IDS;
        const chatIds = ids.includes(agentId)
          ? st.chatIds
          : { ...st.chatIds, [wsId]: [...ids, agentId].sort((a, b) => a - b) };
        // Lift the dragged pane out of its old spot first (re-dock), then splice
        // it in beside the target. If lifting removed the target's last sibling,
        // fall back so the target survives.
        let layout = st.paneLayout[wsId] ?? leaf(st.composerAgent[wsId] ?? 1);
        if (alreadyOpen) layout = removeLeaf(layout, agentId) ?? leaf(targetId);
        if (!hasLeaf(layout, targetId)) layout = leaf(targetId);
        return {
          composerAgent: { ...st.composerAgent, [wsId]: agentId },
          agentCount: { ...st.agentCount, [wsId]: Math.max(st.agentCount[wsId] ?? 1, agentId) },
          chatIds,
          paneLayout: { ...st.paneLayout, [wsId]: insertBeside(layout, targetId, agentId, side) },
        };
      });
      get().focusComposer();
    },

    closePane: (wsId, agentId) => {
      set((s) => {
        const focused = s.composerAgent[wsId] ?? 1;
        const cur = s.paneLayout[wsId] ?? leaf(focused);
        if (paneCount(cur) <= 1 || !hasLeaf(cur, agentId)) return {};
        const next = removeLeaf(cur, agentId);
        if (!next) return {};
        // Closing the focused pane moves focus to the first surviving pane.
        const composerAgent =
          focused === agentId ? { ...s.composerAgent, [wsId]: firstLeaf(next) } : s.composerAgent;
        return { paneLayout: { ...s.paneLayout, [wsId]: next }, composerAgent };
      });
    },

    soloPane: (wsId, agentId) => {
      set((s) => ({
        paneLayout: { ...s.paneLayout, [wsId]: leaf(agentId) },
        composerAgent: { ...s.composerAgent, [wsId]: agentId },
      }));
    },

    setComposerDraft: (wsId, agentId, text) => {
      set((s) => ({ composerDrafts: { ...s.composerDrafts, [`${wsId}:${agentId}`]: text } }));
    },

    stashDraft: (wsId, agentId) => {
      const key = `${wsId}:${agentId}`;
      const s = get();
      const text = s.composerDrafts[key] ?? '';
      const attachments = s.composerAttachments[key] ?? [];
      if (!text.trim() && !attachments.length) return;
      const promptStash = [{ id: Date.now(), text, attachments, workspaceId: wsId, at: Date.now() }, ...s.promptStash].slice(0, STASH_MAX);
      saveStash(promptStash);
      set({
        promptStash,
        composerDrafts: { ...s.composerDrafts, [key]: '' },
        composerAttachments: { ...s.composerAttachments, [key]: [] },
      });
    },

    restoreStash: (id, wsId, agentId) => {
      const key = `${wsId}:${agentId}`;
      const s = get();
      const entry = s.promptStash.find((e) => e.id === id);
      if (!entry) return;
      const cur = s.composerDrafts[key] ?? '';
      // Attachments live in their workspace's worktree — they can't follow the text elsewhere.
      const here = entry.workspaceId === wsId;
      if (!here && entry.attachments.length) get().toast('info', 'Restored the text — its attachments stay with their workspace');
      const promptStash = s.promptStash.filter((e) => e.id !== id);
      saveStash(promptStash);
      set({
        promptStash,
        composerDrafts: { ...s.composerDrafts, [key]: cur.trim() ? `${cur}\n\n${entry.text}` : entry.text },
        composerAttachments: here
          ? { ...s.composerAttachments, [key]: [...(s.composerAttachments[key] ?? []), ...entry.attachments] }
          : s.composerAttachments,
      });
    },

    dropStash: (id) => {
      const promptStash = get().promptStash.filter((e) => e.id !== id);
      saveStash(promptStash);
      set({ promptStash });
    },

    addAttachment: (wsId, agentId, a) => {
      const key = `${wsId}:${agentId}`;
      set((s) => ({
        composerAttachments: {
          ...s.composerAttachments,
          [key]: [...(s.composerAttachments[key] ?? []), a],
        },
      }));
    },

    removeAttachment: (wsId, agentId, index) => {
      const key = `${wsId}:${agentId}`;
      set((s) => ({
        composerAttachments: {
          ...s.composerAttachments,
          [key]: (s.composerAttachments[key] ?? []).filter((_, i) => i !== index),
        },
      }));
    },

    sendCommentsToAgent: (wsId) => {
      const s = get();
      const unresolved = (s.comments[wsId] ?? []).filter((c) => !c.resolved);
      if (unresolved.length === 0) {
        get().toast('info', 'No unresolved comments');
        return;
      }
      const text = unresolved
        .map((c) => `- \`${c.file}:${c.line}\` (${c.side} side): ${c.body}`)
        .join('\n');
      get().addAttachment(wsId, s.composerAgent[wsId] ?? 1, {
        kind: 'comments',
        label: `${unresolved.length} review comment${unresolved.length > 1 ? 's' : ''}`,
        text,
      });
      get().setTab(wsId, 'chat');
    },

    startReviewAgent: async (wsId) => {
      const s = get();
      const nextAgent = (s.agentCount[wsId] ?? 1) + 1;
      get().setComposerAgent(wsId, nextAgent);
      const { data, error } = await tryInvoke('chat:send', {
        workspaceId: wsId,
        agentId: nextAgent,
        text:
          'You are acting as a code reviewer for this workspace. Review the full diff of this branch against its base (`git diff` against the merge base, plus untracked files). Look for bugs, missing edge cases, and failing tests. Run the test suite if one exists. Fix what you find, commit the fixes, and summarize your review.',
        attachments: [],
      });
      if (error || (data && !data.ok)) get().toast('error', error ?? data?.error ?? 'Failed to start review');
      else get().toast('info', `Review agent ${nextAgent} started`);
    },

    // Resolve-conflicts mode (docs/specs/resolve-conflicts-pr-mode.md). Preflight →
    // compose prompt → dispatch to the ACTIVE chat (the one that authored the
    // branch holds the intent a merge needs) → mark resolving → watch for the turn
    // to end and re-check mergeability. Unlike startReviewAgent, no fresh tab.
    startConflictResolution: async (wsId) => {
      if (isDirectIn(get(), wsId)) return get().toast('info', DIRECT_REFUSAL('merge the base branch'));
      const s = get();
      // Re-entry guard — same shape as creatingPr (§8 double-click).
      if (s.resolvingPr[wsId]) {
        get().toast('info', 'Already resolving conflicts for this PR');
        return;
      }
      const pr = s.prStatus[wsId];
      if (!pr || pr.state !== 'OPEN') return;

      // Read-only preflight: which files would collide, plus the base ref. Never
      // mutates the worktree; the agent does the actual merge in its terminal.
      const { data: pre, error: preErr } = await tryInvoke('workspace:conflictPreflight', { workspaceId: wsId });
      if (preErr || !pre || pre.error) {
        // A real failure (non-git / exception). Old git returns conflictFiles:null
        // with no error — that still dispatches below, prompt minus the file list.
        get().toast('error', preErr ?? pre?.error ?? 'Could not check for conflicts');
        return;
      }
      const base = pr.baseRefName || pre.baseRef.replace(/^origin\//, '') || 'the base branch';
      const baseRef = pre.baseRef || `origin/${base}`;

      // Preflight says clean but GitHub said CONFLICTING (§8). Two very different
      // reasons, and answering both with "no conflicts found" left the button
      // stuck on Resolve with nothing the user could do about it.
      if (pre.conflictFiles !== null && pre.conflictFiles.length === 0) {
        if (pre.unpushed > 0) {
          // Not stale at all: GitHub is judging the pushed head, and the merge we
          // just tested clean only exists locally. Pushing is the whole fix.
          const n = pre.unpushed === 1 ? '1 commit' : `${pre.unpushed} commits`;
          get().toast('info', `${n} not pushed — GitHub is still judging the pushed head. Push, then re-check.`);
          return;
        }
        get().toast('info', `No conflicts found against \`${base}\` — re-checking PR status`);
        void recheckMergeable(wsId);
        return;
      }

      const agentId = s.composerAgent[wsId] ?? 1;
      const text = composeResolvePrompt({
        number: pr.number,
        title: pr.title,
        base,
        baseRef,
        conflictFiles: pre.conflictFiles,
      });
      const { data, error } = await tryInvoke('chat:send', { workspaceId: wsId, agentId, text, attachments: [] });
      if (error || (data && !data.ok)) {
        get().toast('error', error ?? data?.error ?? 'Could not start conflict resolution');
        return;
      }

      // Enter the mode: the tab switches to chat so the turn is visible.
      set((st) => ({ resolvingPr: { ...st.resolvingPr, [wsId]: { agentId } } }));
      get().setComposerAgent(wsId, agentId);
      get().setTab(wsId, 'chat');
      void tryInvoke('workspace:conflictResolveEvent', { phase: 'started' });
      if (data?.queued) get().toast('info', 'Queued — starts when the current turn ends');
      else get().toast('info', `Resolving conflicts in chat ${agentId}…`);

      watchResolveTurn(wsId, agentId);
    },

    setProjectsMenu: (open) => set({ projectsMenuOpen: open }),

    refreshProjects: async (selectProjectId) => {
      const { data } = await tryInvoke('app:init');
      if (!data) return;
      set((s) => ({
        projects: data.projects,
        workspaces: applyWorkspaceOrder(data.workspaces),
        projectOwners: data.projectOwners ?? {},
        projectCaps: { ...s.projectCaps, ...(data.projectCaps ?? {}) },
        hosts: data.hosts ?? s.hosts,
        chatsMeta: { ...s.chatsMeta, ...(data.chatsMeta ?? {}) },
        runningAgents: { ...s.runningAgents, ...(data.runningAgents ?? {}) },
      }));
      if (selectProjectId) {
        const s = get();
        localStorage.setItem('activeProjectId', selectProjectId);
        const ws = data.workspaces.find((w) => w.projectId === selectProjectId && !w.archived);
        set({ activeProjectId: selectProjectId, activeWorkspaceId: ws?.id ?? null });
        if (ws) void s.loadWorkspaceData(ws.id);
      }
    },

    refreshCaps: async (projectId) => {
      const { data } = await tryInvoke('project:capabilities', { projectId });
      if (data)
        set((s) => ({
          projectCaps: { ...s.projectCaps, [projectId]: data },
          projectOwners: { ...s.projectOwners, [projectId]: data.githubOwner },
        }));
    },

    scanConductor: async (force) => {
      const st = get();
      // Cached, or already running — don't stack scans (the panel offers Re-scan).
      if (!force && (st.conductorScan || st.conductorScanning)) return;
      set({ conductorScanning: true, conductorScanError: null });
      // Instant presence check first, so the gate shows a loading affordance even
      // while the full scan (git-worktree walks) is still resolving on a big install.
      const det = await tryInvoke('conductor:detect');
      set({ conductorDetected: !!det.data });
      if (det.data === false) {
        set({ conductorScan: { detected: false, source: 'db', projects: [] }, conductorScanning: false });
        return;
      }
      const { data, error } = await tryInvoke('conductor:scan');
      set((s) => ({
        conductorScan: data ?? s.conductorScan,
        conductorDetected: data ? data.detected : s.conductorDetected,
        conductorScanError: data ? null : error ?? 'Scan failed',
        conductorScanning: false,
      }));
    },

    importFromConductor: async (selections) => {
      if (get().conductorImporting) return;
      set({ conductorImporting: true });
      const { data, error } = await tryInvoke('conductor:import', { selections });
      set({ conductorImporting: false });
      if (error || !data) {
        get().toast('error', error ?? 'Import failed');
        return;
      }
      get().setModal(null);
      const summary = importSummary(data);
      get().toast('success', summary ? `Imported ${summary} from Conductor` : 'Nothing new to import');
      await focusImported(data.focusWorkspaceId);
      // Refresh the scan so re-opening the panel shows the new "Imported ✓" states.
      void get().scanConductor(true);
    },

    scanHarnessSync: async (force?: boolean) => {
      const st = get();
      if (!force && (st.harnessSyncScan || st.harnessSyncScanning)) return;
      set({ harnessSyncScanning: true, harnessSyncScanError: null });
      const det = await tryInvoke('harnessSync:detect');
      set({ harnessSyncDetected: !!det.data });
      const { data, error } = await tryInvoke('harnessSync:scan');
      set((s) => ({
        harnessSyncScan: data ?? s.harnessSyncScan,
        harnessSyncScanError: data ? null : error ?? 'Scan failed',
        harnessSyncScanning: false,
      }));
    },

    importHarnessSync: async (sessionIds, enableSync) => {
      if (get().harnessSyncImporting) return;
      set({ harnessSyncImporting: true });
      const { data, error } = await tryInvoke('harnessSync:import', { sessionIds, enableSync });
      set({ harnessSyncImporting: false });
      if (error || !data) {
        get().toast('error', error ?? 'Import failed');
        return;
      }
      get().setModal(null);
      const summary = importSummary(data);
      get().toast('success', summary ? `Imported ${summary}` : 'Nothing new to import');
      if (data.errors.length) get().toast('error', data.errors[0]);
      await focusImported(data.focusWorkspaceId);
      void get().scanHarnessSync(true);
      void tryInvoke('harnessSync:status').then((r) => r.data && set({ harnessSyncStatus: r.data }));
    },

    recreateAdoptedWorkspace: async (wsId) => {
      const { data, error } = await tryInvoke('workspace:recreateFromBranch', { workspaceId: wsId });
      if (error || !data?.ok) {
        get().toast('error', error ?? data?.error ?? 'Could not recreate the workspace');
        return;
      }
      get().toast('success', 'Recreated the workspace from its branch');
    },

    refreshHosts: async () => {
      const { data } = await tryInvoke('host:list');
      if (data) set({ hosts: data });
    },

    openRemoteFolder: async (hostId, folder) => {
      // Detect git on the host first: a repo appears as a remote git project,
      // a plain folder as a remote folder project (both in-place in v1).
      const res = await tryInvoke('project:add', { mode: 'folder', path: folder, hostId });
      if (res.error) {
        get().toast('error', res.error);
        return;
      }
      get().setModal(null);
      get().toast('success', `Opened ${res.data!.name} on the remote host`);
      await get().refreshProjects(res.data!.id);
      const first = get().workspaces.find((w) => w.projectId === res.data!.id && !w.archived);
      if (first) get().selectWorkspace(first.id);
    },

    openLocalProject: async () => {
      const { data: folder } = await tryInvoke('dialog:pickFolder');
      if (!folder) return;
      // Inspect first: a git repo takes today's flow; a plain folder opens the
      // "work in this folder / initialize git here" sheet (§4).
      const { data: info } = await tryInvoke('project:inspectPath', { path: folder });
      if (info && !info.isGit) {
        get().setModal({ kind: 'folder-choice', path: folder });
        return;
      }
      const res = await tryInvoke('project:add', { mode: 'local', path: folder });
      if (res.error) {
        get().toast('error', res.error);
        return;
      }
      get().toast('success', `Added ${res.data!.name}`);
      await get().refreshProjects(res.data!.id);
      // Land in branch initialisation so the first workspace starts right away.
      get().setModal({ kind: 'new-workspace' });
    },

    /** Add a plain folder as a project. `initGit` = the "Initialize git here"
     *  upsell (commit the folder, add it as a git project); otherwise a folder
     *  project (single in-place workspace). */
    addFolderProject: async (folder: string, initGit: boolean) => {
      const res = await tryInvoke('project:add', { mode: 'folder', path: folder, initGit });
      if (res.error) {
        get().toast('error', res.error);
        return;
      }
      get().toast('success', `Added ${res.data!.name}`);
      await get().refreshProjects(res.data!.id);
      // Folder projects auto-create their single in-place workspace; git projects
      // land in branch init so the first workspace starts right away.
      if (!initGit) {
        const first = get().workspaces.find((w) => w.projectId === res.data!.id && !w.archived);
        if (first) get().selectWorkspace(first.id);
      } else {
        get().setModal({ kind: 'new-workspace' });
      }
    },

    startGithubSignIn: async () => {
      set((s) => ({
        // Remember the modal that launched sign-in (e.g. clone-repo) so success
        // or cancel returns the user there. On a retry the device modal is
        // already up, so keep the target captured on the first attempt.
        ghSignInReturn: s.modal?.kind === 'github-signin' ? s.ghSignInReturn : s.modal,
        modal: { kind: 'github-signin' },
        ghSignIn: { userCode: '', verificationUri: '', status: 'starting' },
      }));
      const { data, error } = await tryInvoke('github:signInStart');
      // The modal may have been dismissed while we were contacting GitHub.
      if (get().modal?.kind !== 'github-signin') {
        void invoke('github:signInCancel');
        return;
      }
      if (error || !data) {
        set({
          ghSignIn: {
            userCode: '',
            verificationUri: '',
            status: 'error',
            message: error ?? 'Could not reach GitHub',
          },
        });
        return;
      }
      set({
        ghSignIn: {
          userCode: data.userCode,
          verificationUri: data.verificationUri,
          status: 'waiting',
        },
      });
    },

    cancelGithubSignIn: () => {
      void invoke('github:signInCancel');
      set((s) => ({
        ghSignIn: null,
        // Back out to the modal that launched sign-in (e.g. clone-repo), if any.
        modal: s.modal?.kind === 'github-signin' ? s.ghSignInReturn : s.modal,
        ghSignInReturn: null,
      }));
    },

    signOutGithub: async () => {
      const { data, error } = await tryInvoke('github:signOut');
      if (data) {
        set({ ghAuth: data });
        get().toast('info', 'Signed out of GitHub');
      } else if (error) {
        get().toast('error', error);
      }
    },

    saveSettings: async (patch) => {
      const next = await invoke('settings:set', patch);
      set({ settings: next });
      if (patch.theme || patch.colorTheme || patch.visualEffects) get().applyTheme();
    },

    refreshHarnesses: async (force = false) => {
      const { data } = await tryInvoke('harness:list', { force });
      if (data) set({ harnesses: data });
    },

    // Pin the default model for a harness / the default effort. These seed the
    // model & effort of every new chat and are persisted globally.
    setDefaultModel: (harness, modelId) => {
      const cur = get().settings.defaultModels ?? {};
      void get().saveSettings({ defaultModels: { ...cur, [harness]: modelId } });
    },
    setDefaultEffort: (effort) => {
      void get().saveSettings({ defaultEffort: effort });
    },

    applyTheme: () => {
      const { theme, colorTheme } = get().settings;
      const mode = isThemeMode(theme) ? theme : 'system';
      const family = normalizeColorTheme(colorTheme);
      const resolved = resolveTheme(mode);
      applyThemeToElement(document.documentElement, family, resolved === 'dark');
      const fxMode = get().settings.visualEffects;
      const fx = resolveEffects(isEffectsMode(fxMode) ? fxMode : 'auto', get().gpu);
      applyEffects(fx);
      try {
        localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ theme: mode, colorTheme: family }));
        localStorage.setItem(EFFECTS_CACHE_KEY, fx);
      } catch {
        /* storage unavailable — the next boot just starts from Classic */
      }
      set({ resolvedTheme: resolved });
    },

    archiveWorkspace: async (wsId) => {
      evictEditor(wsId); // buffers/models are evicted with the workspace (spec §9)
      // Main destroys the embedded view on archive; drop its renderer mirror too.
      set((s) => {
        if (!(wsId in s.previewByWs) && s.annotate?.wsId !== wsId) return {};
        const previewByWs = { ...s.previewByWs };
        delete previewByWs[wsId];
        return { previewByWs, annotate: s.annotate?.wsId === wsId ? null : s.annotate };
      });
      await tryInvoke('workspace:archive', { workspaceId: wsId });
      const s = get();
      if (s.activeWorkspaceId === wsId) {
        const next = s.workspaces.find((w) => w.projectId === s.activeProjectId && !w.archived && w.id !== wsId);
        set({ activeWorkspaceId: next?.id ?? null });
      }
    },

    restoreWorkspace: async (wsId) => {
      // Bringing back an offloaded worktree takes a few seconds (checkout, deps,
      // setup) — open it right away; it shows as setting up meanwhile.
      get().selectWorkspace(wsId);
      const { data, error } = await tryInvoke('workspace:restore', { workspaceId: wsId });
      if (error) get().toast('error', error);
      else {
        // A remote folder that's gone (or an unreachable host) is advisory, not a
        // failure — the restore still happened (§8).
        if (data?.warning) get().toast('info', data.warning);
        else get().toast('success', 'Workspace restored');
      }
    },

    deleteWorkspace: async (wsId) => {
      const { error } = await tryInvoke('workspace:delete', { workspaceId: wsId });
      if (error) get().toast('error', error);
    },

    createPr: async (wsId) => {
      // Before the "Committing changes…" toast: one-click PR is off in direct workspaces.
      if (isDirectIn(get(), wsId)) return get().toast('info', DIRECT_REFUSAL('open pull requests'));
      // Commit + push + draft + open can take 30s+; ignore re-clicks while in flight.
      if (get().creatingPr[wsId]) return;
      set((s) => ({ creatingPr: { ...s.creatingPr, [wsId]: true } }));
      get().toast('info', 'Committing changes and creating pull request…');
      try {
        const { data, error } = await tryInvoke('github:prCreate', { workspaceId: wsId, draft: false });
        if (error || !data?.ok) {
          get().toast('error', error ?? data?.error ?? 'PR creation failed');
          return;
        }
        if (data.note) get().toast('info', data.note);
        // Main already pushed the new PR's status (pr:status) before replying,
        // so the header is on the open PR — no refetch needed here.
        get().toast('success', `PR created: ${data.url ?? ''}`);
        get().setTab(wsId, 'checks');
      } finally {
        set((s) => ({ creatingPr: { ...s.creatingPr, [wsId]: false } }));
      }
    },

    continueWorkspace: async (wsId) => {
      if (isDirectIn(get(), wsId)) return get().toast('info', DIRECT_REFUSAL('start a new branch'));
      const { data, error } = await tryInvoke('workspace:continueBranch', { workspaceId: wsId });
      if (error || !data?.ok) {
        get().toast('error', error ?? data?.error ?? 'Could not start a new branch');
        return;
      }
      // Clear the merged-PR view immediately; the branch is now fresh off base.
      set((s) => ({ prStatus: { ...s.prStatus, [wsId]: null } }));
      void get().refreshPr(wsId, true);
      void get().refreshGit(wsId);
      void get().refreshDiff(wsId);
      get().refreshDiffStat(wsId);
      get().setTab(wsId, 'chat');
      get().focusComposer();
      get().toast('success', `New branch: ${data.workspace?.branch ?? ''}`);
      if (data.note) get().toast(data.noteKind ?? 'info', data.note);
    },
  };
});

persistDrafts(useApp);

// Dock badge: how many workspaces are waiting on the user — a question, an
// unread finish, or needs-attention (the sidebar's status stack, summed up).
// Off with notifications; recomputed only when an input to it changes.
let dockBadge = -1;
useApp.subscribe((s, prev) => {
  if (
    s.chatsMeta === prev.chatsMeta &&
    s.pendingAsks === prev.pendingAsks &&
    s.runningAgents === prev.runningAgents &&
    s.workspaces === prev.workspaces &&
    s.settings.notifications === prev.settings.notifications
  )
    return;
  const asking = askingAgents(s.pendingAsks);
  const count = s.settings.notifications
    ? s.workspaces.filter((w) => {
        if (w.archived) return false;
        const c = workspaceStatusCounts(w, s.chatsMeta[w.id], s.runningAgents[w.id] ?? EMPTY_ARR, asking[w.id] ?? EMPTY_ARR);
        return c.asking + c.unread + c.waiting > 0;
      }).length
    : 0;
  if (count === dockBadge) return;
  dockBadge = count;
  void tryInvoke('app:setBadge', { count });
});

// ---------------- Resolve-conflicts mode: turn-end watch + re-check backoff ----

/** Drop the resolving flag for a workspace (mode over, whatever the outcome). */
function clearResolving(wsId: string) {
  useApp.setState((s) => {
    if (!s.resolvingPr[wsId]) return s;
    const resolvingPr = { ...s.resolvingPr };
    delete resolvingPr[wsId];
    return { resolvingPr };
  });
}

/**
 * Watch the dispatched resolve turn and, when it ends, kick off the re-check
 * backoff (spec §4.3). "Turn end" is read off the existing chat run-state the
 * store already tracks: we arm once the agent is actually running our message
 * (running AND its queue drained — so a queued dispatch waits past the current
 * turn), then fire on the falling edge. A long safety timeout keeps the button
 * from sticking on "Resolving…" if the turn never starts (e.g. the agent failed
 * to launch, or a queued predecessor hangs).
 */
function watchResolveTurn(wsId: string, agentId: number) {
  let armed = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    unsub();
    clearTimeout(safety);
  };
  const evaluate = () => {
    const st = useApp.getState();
    // Someone else ended the mode (PR merged/closed, or a new resolve replaced us).
    if (st.resolvingPr[wsId]?.agentId !== agentId) {
      finish();
      return;
    }
    const running = (st.runningAgents[wsId] ?? []).includes(agentId);
    const queued = (st.queued[`${wsId}:${agentId}`] ?? []).length > 0;
    if (!armed && running && !queued) armed = true;
    if (armed && !running) {
      finish();
      void resolveRecheckBackoff(wsId, agentId);
    }
  };
  const unsub = useApp.subscribe(evaluate);
  const safety = setTimeout(
    () => {
      if (armed || finished) return; // the falling-edge path owns it once armed
      finish();
      clearResolving(wsId);
      void useApp.getState().refreshPr(wsId, true);
    },
    15 * 60_000
  );
  evaluate(); // in case the state already qualifies
}

/**
 * The local preflight has disproved GitHub's CONFLICTING. GitHub recomputes
 * mergeability lazily, so the first read usually repeats the old verdict — re-ask
 * on a short backoff rather than leaving the user on a Resolve-conflicts button
 * we've just told them is wrong. If it never agrees, name the disagreement and
 * point at the way out (the Checks tab merges past a stale gate).
 */
async function recheckMergeable(wsId: string) {
  for (const delay of [0, 5_000, 15_000]) {
    if (delay) await new Promise((done) => setTimeout(done, delay));
    await useApp.getState().refreshPr(wsId, true);
    if (useApp.getState().prStatus[wsId]?.mergeable !== 'CONFLICTING') return;
  }
  useApp
    .getState()
    .toast('info', "GitHub still reports a conflict Maestro can't reproduce locally — try Merge in the Checks tab");
}

/**
 * After the resolve turn ends, force-refresh PR status on a bounded backoff until
 * GitHub reports MERGEABLE (resolved) or CONFLICTING (failed). UNKNOWN keeps the
 * loop alive; exhausting the budget resolves as a shrug (spec §4.3 / §8).
 */
async function resolveRecheckBackoff(wsId: string, agentId: number) {
  const stillOurs = () => useApp.getState().resolvingPr[wsId]?.agentId === agentId;
  for (const delay of [5_000, 15_000, 30_000, 60_000]) {
    await new Promise((r) => setTimeout(r, delay));
    if (!stillOurs()) return; // mode ended out from under us
    await useApp.getState().refreshPr(wsId, true);
    const pr = useApp.getState().prStatus[wsId];
    if (!pr) continue;
    if (pr.state !== 'OPEN') {
      // Merged/closed mid-flow — clear silently; PrActions re-renders itself (§8).
      clearResolving(wsId);
      return;
    }
    if (pr.mergeable === 'MERGEABLE') {
      clearResolving(wsId);
      void tryInvoke('workspace:conflictResolveEvent', { phase: 'succeeded' });
      useApp.getState().toast('success', `Conflicts resolved — PR #${pr.number} is mergeable`);
      return;
    }
    if (pr.mergeable === 'CONFLICTING') {
      clearResolving(wsId);
      void tryInvoke('workspace:conflictResolveEvent', { phase: 'failed' });
      useApp.getState().toast('error', `PR #${pr.number} still has conflicts — see the chat`);
      return;
    }
    // UNKNOWN / null → GitHub is still computing; keep looping.
  }
  if (!stillOurs()) return;
  clearResolving(wsId);
  void tryInvoke('workspace:conflictResolveEvent', { phase: 'failed' });
  useApp.getState().toast('info', 'GitHub is still computing mergeability — check back shortly');
}

export function useActiveWorkspace(): Workspace | null {
  return useApp((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null);
}

export function useActiveProject(): Project | null {
  return useApp((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
}

/** The capability rung for a project — the source of every git/GitHub gate.
 *  `caps.git` → branch/diff/changes/review; `caps.worktrees` → new worktree
 *  workspaces; `caps.githubRemote && ghAuth.authenticated` (see useShowPr) → PRs. */
export function useCaps(projectId: string | null | undefined): ProjectCaps {
  return useApp((s) => capsOf(s, projectId));
}

/** PR/Checks/merge affordances: a github origin AND authenticated gh. For remote
 *  projects the gh-auth check is baked into caps.githubRemote (per-host, probed
 *  in main), so the local gh login is irrelevant there. */
export function useShowPr(projectId: string | null | undefined): boolean {
  const githubRemote = useApp((s) => capsOf(s, projectId).githubRemote);
  const localAuthed = useApp((s) => s.ghAuth.authenticated);
  const isRemote = useApp((s) => !!(projectId && s.projects.find((p) => p.id === projectId)?.hostId));
  return githubRemote && (isRemote || localAuthed);
}

/** Whether a workspace works directly in its project's own checkout (Create from
 *  → Existing working directory) — its branch/PR lifecycle is hidden. */
export function useIsDirect(ws: Pick<Workspace, 'projectId' | 'wsKind' | 'worktreePath' | 'hostId' | 'directRepo'>): boolean {
  return useApp((s) => isDirectWorkspace(ws, s.projects.find((p) => p.id === ws.projectId)));
}
