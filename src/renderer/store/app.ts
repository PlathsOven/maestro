import { create } from 'zustand';
import { invoke, on, tryInvoke } from '../lib/api';
import { playCompletionSound } from '../lib/sounds';
import { evictWorkspaceBuffers } from '../lib/editorEvictor';
import { composeResolvePrompt } from '../lib/resolveConflicts';
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
import { DEFAULT_COMPLETION_SOUND, statusKey } from '../../shared/types';
import { provisionalTitle } from '../../shared/chatTitle';
import { isUnread } from '../lib/status';

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
  | { kind: 'new-workspace'; from?: 'branch' | 'pr' | 'issue' | 'linear' }
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
export type LightboxImage = { path: string; alt?: string };
/**
 * The chat image lightbox (spotlight): a full-screen zoomable viewer opened by
 * clicking an inline transcript image, holding the pane's ordered images so the
 * arrows can step between them. Kept separate from `modal` so it overlays any
 * open modal (e.g. a sub-agent trace) instead of replacing it.
 */
type Lightbox = { workspaceId: string; images: LightboxImage[]; index: number } | null;

const turnKey = (wsId: string, agentId: number) => `${wsId}:${agentId}`;

/** Stable empty references — selectors must never fabricate fresh arrays. */
export const EMPTY_ARR: never[] = [];

/** Capability fallbacks used before main's `projectCaps` arrives (kept as stable
 *  refs so caps selectors don't churn). Every git/GitHub surface derives from a
 *  project's caps; a folder project reaches none of them. */
const NO_CAPS: ProjectCaps = { git: false, worktrees: false, githubRemote: false, checkpoints: false };
const GIT_FALLBACK: ProjectCaps = { git: true, worktrees: true, githubRemote: false, checkpoints: false };

/** Resolve a project's capability rung from store state. Falls back to a
 *  kind-derived guess (git chrome shows, PR waits for the probe) so the UI is
 *  right on the first paint after a project is added, before caps load. */
export function capsOf(
  s: { projectCaps: Record<string, ProjectCaps>; projects: Project[] },
  projectId: string | null | undefined
): ProjectCaps {
  if (!projectId) return NO_CAPS;
  const stored = s.projectCaps[projectId];
  if (stored) return stored;
  return s.projects.find((p) => p.id === projectId)?.kind === 'git' ? GIT_FALLBACK : NO_CAPS;
}
/** Default terminal set for a workspace (one terminal). Stable ref for selectors. */
export const DEFAULT_TERM_IDS: number[] = [1];
/** Default chat set for a workspace (one chat). Stable ref for selectors. */
export const DEFAULT_CHAT_IDS: number[] = [1];
/** Max chats tiled in the split (center) view before panes get unusably small.
 *  Beyond this, "split" replaces the focused pane instead of adding one. */
const MAX_PANES = 4;

/**
 * The center chat area is a mosaic of panes laid out as a tree. A `leaf` shows
 * one chat session; a `split` arranges its children left→right (`row`) or
 * top→bottom (`col`), so chats can be tiled on *both* axes (not just a single
 * row of columns). Sizes are intentionally not stored — every pane in a split
 * shares its axis evenly, re-equalizing whenever the split's child count
 * changes (live drag sizing is local to the renderer). The tree is renderer-only
 * state: it's reset to a single leaf on load, never persisted.
 */
export type PaneNode =
  | { t: 'leaf'; id: number }
  | { t: 'split'; dir: 'row' | 'col'; children: PaneNode[] };

/** Which edge of a target pane a dragged session is dropped against. */
export type DropSide = 'left' | 'right' | 'top' | 'bottom';

export const leaf = (id: number): PaneNode => ({ t: 'leaf', id });
const sideAxis = (side: DropSide): 'row' | 'col' => (side === 'left' || side === 'right' ? 'row' : 'col');
const sideFirst = (side: DropSide): boolean => side === 'left' || side === 'top';

/** Every leaf session id, in visual order (left→right, top→bottom). */
export function paneIds(node: PaneNode | undefined): number[] {
  if (!node) return [];
  if (node.t === 'leaf') return [node.id];
  return node.children.flatMap(paneIds);
}
export const paneCount = (node: PaneNode | undefined): number => paneIds(node).length;
const hasLeaf = (node: PaneNode | undefined, id: number): boolean => paneIds(node).includes(id);
/** The top-left-most session — the one that owns workspace-level chrome. */
export const firstLeaf = (node: PaneNode): number => paneIds(node)[0];

/** Swap the leaf showing `oldId` to show `newId`, keeping the tree shape. No-op
 *  if `newId` is already somewhere in the tree (the caller just focuses it). */
function replaceLeaf(node: PaneNode, oldId: number, newId: number): PaneNode {
  if (node.t === 'leaf') return node.id === oldId ? leaf(newId) : node;
  return { ...node, children: node.children.map((c) => replaceLeaf(c, oldId, newId)) };
}

/** Remove leaf `id`, collapsing any split left with a single child. Returns null
 *  when the whole layout is emptied. */
function removeLeaf(node: PaneNode, id: number): PaneNode | null {
  if (node.t === 'leaf') return node.id === id ? null : node;
  const kept = node.children.map((c) => removeLeaf(c, id)).filter((c): c is PaneNode => c !== null);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return { ...node, children: kept };
}

/**
 * Insert `newId` as a new pane next to the leaf `targetId`, on the given side.
 * Splits the target leaf into a two-child row/col; but when the target's parent
 * already runs along that same axis, the new pane is spliced in beside it at
 * that level instead — so repeated same-direction drops tile evenly rather than
 * nesting ever deeper.
 */
function insertBeside(node: PaneNode, targetId: number, newId: number, side: DropSide): PaneNode {
  const dir = sideAxis(side);
  const first = sideFirst(side);
  if (node.t === 'leaf') {
    if (node.id !== targetId) return node;
    const pair = first ? [leaf(newId), node] : [node, leaf(newId)];
    return { t: 'split', dir, children: pair };
  }
  if (node.dir === dir) {
    const idx = node.children.findIndex((c) => c.t === 'leaf' && c.id === targetId);
    if (idx >= 0) {
      const at = first ? idx : idx + 1;
      const children = [...node.children];
      children.splice(at, 0, leaf(newId));
      return { ...node, children };
    }
  }
  return { ...node, children: node.children.map((c) => insertBeside(c, targetId, newId, side)) };
}

/** Add `newId` as a new right-most top-level column — the rail "split" button's
 *  "join the layout, evenly sharing the horizontal space" behavior. */
function appendColumn(node: PaneNode, newId: number): PaneNode {
  if (node.t === 'split' && node.dir === 'row') {
    return { ...node, children: [...node.children, leaf(newId)] };
  }
  return { t: 'split', dir: 'row', children: [node, leaf(newId)] };
}

/**
 * Selecting/opening a chat shows it in the focused pane (swaps the sole leaf in
 * single-pane mode; swaps only the focused pane in split mode). Already-visible
 * sessions leave the layout untouched — the caller just focuses them. Falls back
 * to a fresh single leaf if the focused pane can't be located (defensive).
 */
function withFocusedLeaf(layout: PaneNode | undefined, prevFocused: number, agentId: number): PaneNode {
  const cur = layout ?? leaf(prevFocused);
  if (hasLeaf(cur, agentId)) return cur;
  const swapped = replaceLeaf(cur, prevFocused, agentId);
  return hasLeaf(swapped, agentId) ? swapped : leaf(agentId);
}

/** Resizable panel sizes (px). Live-updated while dragging a divider, then
 *  persisted to localStorage so the layout survives restarts. */
interface LayoutSizes {
  sidebar: number; // left projects sidebar width
  sessions: number; // chat session rail width
  right: number; // right (files/changes/checks) panel width
  dock: number; // bottom terminal dock height
}
export const DEFAULT_LAYOUT: LayoutSizes = { sidebar: 264, sessions: 208, right: 380, dock: 300 };
/** Width of the collapsed right panel's icon rail — must track the `w-12` on
 *  CollapsedRightPanel's <aside>. Layout math outside that component (the
 *  window-control-overlay inset in WorkspaceView) needs it as a number. */
export const COLLAPSED_RIGHT_RAIL = 48;
export const LAYOUT_LIMITS: Record<keyof LayoutSizes, { min: number; max: number }> = {
  sidebar: { min: 200, max: 460 },
  sessions: { min: 150, max: 380 },
  right: { min: 280, max: 680 },
  dock: { min: 120, max: 720 },
};
const clampLayoutValue = (n: number, { min, max }: { min: number; max: number }) => Math.min(max, Math.max(min, n));
const clampLayout = (l: LayoutSizes): LayoutSizes => ({
  sidebar: clampLayoutValue(l.sidebar, LAYOUT_LIMITS.sidebar),
  sessions: clampLayoutValue(l.sessions, LAYOUT_LIMITS.sessions),
  right: clampLayoutValue(l.right, LAYOUT_LIMITS.right),
  dock: clampLayoutValue(l.dock, LAYOUT_LIMITS.dock),
});
function loadLayout(): LayoutSizes {
  try {
    const raw = localStorage.getItem('layout');
    if (raw) return clampLayout({ ...DEFAULT_LAYOUT, ...JSON.parse(raw) });
  } catch {
    /* ignore malformed persisted layout */
  }
  return { ...DEFAULT_LAYOUT };
}

// Persisted session-rail order (per workspace → agent ids), so a drag-reorder
// survives restarts. It's a UI preference like `layout`, hence localStorage
// rather than the agent DB. Only the *relative* order is used on load: ids no
// longer open are ignored and newly-seen ids append, so it can never resurrect
// a closed session or drop a live one (see applyChatOrder / loadWorkspaceData).
const CHAT_ORDER_KEY = 'chatOrder';
function loadChatOrders(): Record<string, number[]> {
  try {
    const raw = localStorage.getItem(CHAT_ORDER_KEY);
    if (raw) return JSON.parse(raw) as Record<string, number[]>;
  } catch {
    /* ignore malformed persisted order */
  }
  return {};
}
function saveChatOrder(wsId: string, ids: number[]) {
  try {
    const map = loadChatOrders();
    map[wsId] = ids;
    localStorage.setItem(CHAT_ORDER_KEY, JSON.stringify(map));
  } catch {
    /* storage full / unavailable — order just won't persist */
  }
}
/** Reorder `ids` to match a saved order: known ids first (in saved order), any
 *  unknown ids after (keeping their incoming numeric order). Stable + total, so
 *  the result is always a permutation of `ids`. */
function applyChatOrder(ids: number[], saved: number[] | undefined): number[] {
  if (!saved || saved.length === 0) return ids;
  const rank = new Map(saved.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || a - b);
}

const diffStatTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface AppState {
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
  chatsMeta: Record<string, Record<string, ChatMeta>>;
  queued: Record<string, { id: string; text: string }[]>; // key `${wsId}:${agentId}`
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
  rightTab: Record<string, 'files' | 'changes' | 'checks' | 'status' | 'skills'>;
  layout: LayoutSizes; // resizable panel sizes (px)
  dockOpen: Record<string, boolean>;
  dockTab: Record<string, string>; // 'setup' | 'run' | 'rs:<scriptId>' | 'term:N'
  dockTermIds: Record<string, number[]>; // open terminal numbers, e.g. [1, 3]
  dockRunIds: Record<string, string[]>; // run-script ids open as their own dock terminal tabs
  statusScope: Record<string, 'session' | 'workspace' | 'project'>; // Status tab scope per workspace
  focusComposerNonce: number;
  /** Bumped by ⌘W in Editor mode; the visible EditorSurface watches it and runs
   *  its dirty-guarded close of the active tab. Mirrors focusComposerNonce. */
  closeActiveFileNonce: number;
  settings: GlobalSettings;
  /** The theme actually applied to the DOM: 'system' resolved against the OS
   *  color scheme. Consumers that need concrete dark/light (Monaco, etc.) read
   *  this rather than settings.theme. */
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
  /** bumped on every ws:updated — components use it to refetch git state */
  wsVersion: Record<string, number>;

  messages: Record<string, ChatMessage[] | undefined>;
  liveTurns: Record<string, LiveTurn | undefined>;
  /** In-flight "the agent is asking you a question" prompts, keyed by
   *  `${wsId}:${agentId}` — rendered as a picker inline in that agent's turn. */
  pendingAsks: Record<string, AskQuestionPayload | undefined>;
  /** Specialist sub-agent runs keyed by parent turn id (= parent message id).
   *  Populated live via subagent:updated and lazily via loadSubagents. */
  subagentRuns: Record<string, SubagentRun[] | undefined>;
  runningAgents: Record<string, number[]>;
  diffs: Record<string, WorkspaceDiff | undefined>;
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
  toast: (kind: Toast['kind'], text: string) => void;
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

  selectProject: (id: string) => void;
  selectWorkspace: (id: string | null) => void;
  /** Open the full-panel Workspaces browser. */
  openWorkspacesView: () => void;
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
  editQueued: (wsId: string, agentId: number, itemId: string, text: string) => void;
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
  setRightTab: (wsId: string, tab: 'files' | 'changes' | 'checks' | 'status' | 'skills') => void;
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

  loadWorkspaceData: (wsId: string) => Promise<void>;
  refreshGit: (wsId: string) => Promise<void>;
  refreshDiff: (wsId: string) => Promise<void>;
  refreshPr: (wsId: string, force?: boolean) => Promise<void>;
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
  applyTheme: (theme: 'dark' | 'light' | 'system') => void;

  archiveWorkspace: (wsId: string) => Promise<void>;
  restoreWorkspace: (wsId: string) => Promise<void>;
  deleteWorkspace: (wsId: string) => Promise<void>;
  createPr: (wsId: string) => Promise<void>;
  continueWorkspace: (wsId: string) => Promise<void>;
}

/** Media query tracking the OS color scheme, used to resolve the 'system' theme. */
const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const resolveTheme = (theme: 'dark' | 'light' | 'system'): 'dark' | 'light' =>
  theme === 'system' ? (systemDarkQuery.matches ? 'dark' : 'light') : theme;

export const useApp = create<AppState>((set, get) => {
  let toastId = 0;

  // Re-apply when the OS flips its color scheme, but only while following it.
  systemDarkQuery.addEventListener('change', () => {
    if (get().settings.theme === 'system') get().applyTheme('system');
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
    dockTermIds: {},
    dockRunIds: {},
    focusComposerNonce: 0,
    closeActiveFileNonce: 0,
    resolvedTheme: resolveTheme('system'),
    settings: {
      theme: 'system',
      defaultHarness: 'claude-code',
      ideCommand: 'code',
      permissionMode: 'acceptEdits',
      linearToken: '',
      notifications: true,
      completionSound: DEFAULT_COMPLETION_SOUND,
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
    wsVersion: {},
    messages: {},
    liveTurns: {},
    pendingAsks: {},
    subagentRuns: {},
    runningAgents: {},
    diffs: {},
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
    composerAttachments: {},
    composerAgent: {},
    composerDrafts: {},
    agentCount: {},
    chatIds: {},
    paneLayout: {},
    closedTabs: {},
    closedFiles: {},
    modal: null,
    lightbox: null,
    feedbackPanel: { open: false },
    paletteOpen: false,
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
        workspaces: data.workspaces,
        settings: data.settings,
        ghAuth: data.ghAuth,
        harnesses: data.harnesses,
        appVersion: data.version,
        platform: data.platform,
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
      get().applyTheme(data.settings.theme);
      if (activeWorkspaceId) void get().loadWorkspaceData(activeWorkspaceId);
      for (const w of data.workspaces) {
        // Stat the diff for git worktrees and for folder projects that have
        // shadow-git checkpoints; plain (remote) folders have no diff to stat.
        const c = data.projectCaps?.[w.projectId];
        const hasDiff = c ? c.git || c.checkpoints : w.wsKind !== 'in-place';
        if (!w.archived && hasDiff) get().refreshDiffStat(w.id);
      }

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
          // Mirrored (harness-sync) rows use deterministic ids and can re-arrive on
          // a re-ingest; replace an existing id in place instead of appending a dup.
          const existingIdx = list ? list.findIndex((m) => m.id === msg.id) : -1;
          const messages = {
            ...s.messages,
            [msg.workspaceId]: !list
              ? [msg]
              : existingIdx >= 0
                ? list.map((m) => (m.id === msg.id ? msg : m))
                : [...list, msg],
          };
          const liveTurns = { ...s.liveTurns };
          const pendingAsks = s.pendingAsks;
          let asks = pendingAsks;
          let runningAgents = s.runningAgents;
          if (msg.role === 'agent' || msg.role === 'system') {
            // A persisted agent/system message means that agent's run is over.
            const key = turnKey(msg.workspaceId, msg.agentId);
            delete liveTurns[key];
            const running = (s.runningAgents[msg.workspaceId] ?? []).filter((a) => a !== msg.agentId);
            runningAgents = { ...s.runningAgents, [msg.workspaceId]: running };
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
      });
      on('ask:resolved', ({ workspaceId, agentId }) => {
        set((s) => {
          const pendingAsks = { ...s.pendingAsks };
          delete pendingAsks[turnKey(workspaceId, agentId)];
          return { pendingAsks };
        });
      });
      on('chat:event', ({ workspaceId, agentId, event }) => {
        // Bookkeeping-only events must not create turns or mark agents running —
        // a trailing one after `done` would leave a zombie "Thinking…" state.
        // (Main routes background tasks to 'chat:tasks' instead; guarded here too
        // because those legitimately arrive after the turn's `done`.)
        if (event.kind === 'session' || event.kind === 'status' || event.kind === 'task' || event.kind === 'limit')
          return;
        if (event.kind === 'context') {
          // Per-API-call measurement — the ring ticks live during long turns.
          set((st) => ({
            chatsMeta: {
              ...st.chatsMeta,
              [workspaceId]: {
                ...st.chatsMeta[workspaceId],
                [String(agentId)]: {
                  ...st.chatsMeta[workspaceId]?.[String(agentId)],
                  contextTokens: event.contextTokens,
                  usage: event.usage,
                },
              },
            },
          }));
          return;
        }
        if (event.kind === 'done') {
          // Completion chime — plays ONCE when an agent finishes a turn, in any
          // workspace. Guarded on the turn still being marked running so a harness
          // that emits several `done` events (e.g. codex retrying a failed
          // connection) doesn't replay it 5×. Independent of the OS notification
          // (which only fires when Maestro is backgrounded); disabled by "No sound".
          if (get().liveTurns[turnKey(workspaceId, agentId)]?.running) {
            playCompletionSound(get().settings.completionSound);
          }
        }
        set((s) => {
          const key = turnKey(workspaceId, agentId);
          const cur: LiveTurn = s.liveTurns[key] ?? {
            agentId,
            finalBlocks: [],
            deltaBlocks: [],
            accumType: null,
            accumText: '',
            running: true,
            startedAt: Date.now(),
          };
          const t: LiveTurn = {
            ...cur,
            finalBlocks: [...cur.finalBlocks],
            deltaBlocks: [...cur.deltaBlocks],
          };
          const flush = () => {
            if (t.accumType && t.accumText) {
              t.deltaBlocks.push({ type: t.accumType, text: t.accumText } as AgentBlock);
            }
            t.accumType = null;
            t.accumText = '';
          };
          let running = s.runningAgents[workspaceId] ?? [];
          switch (event.kind) {
            case 'seg-start':
              flush();
              t.accumType = event.segType;
              break;
            case 'seg-delta':
              if (!t.accumType) t.accumType = 'text';
              t.accumText = t.accumText + event.text;
              break;
            case 'tool-start':
              flush();
              t.deltaBlocks.push({ type: 'tool', id: event.toolId, name: event.name, input: event.input });
              break;
            case 'message-final':
              t.finalBlocks = [...t.finalBlocks, ...event.blocks];
              t.deltaBlocks = [];
              t.accumType = null;
              t.accumText = '';
              break;
            case 'tool-result': {
              const patch = (arr: AgentBlock[]) => {
                for (let i = arr.length - 1; i >= 0; i--) {
                  const b = arr[i];
                  if (b.type === 'tool' && b.id === event.toolId) {
                    arr[i] = { ...b, result: { ok: event.ok, summary: event.summary } };
                    return true;
                  }
                }
                return false;
              };
              if (!patch(t.finalBlocks)) patch(t.deltaBlocks);
              break;
            }
            case 'done': {
              t.running = false;
              running = running.filter((a) => a !== agentId);
              if (event.contextTokens) {
                // context ring data — merged here so it survives without a refetch
                setTimeout(() =>
                  set((st) => ({
                    chatsMeta: {
                      ...st.chatsMeta,
                      [workspaceId]: {
                        ...st.chatsMeta[workspaceId],
                        [String(agentId)]: {
                          ...st.chatsMeta[workspaceId]?.[String(agentId)],
                          contextTokens: event.contextTokens,
                        },
                      },
                    },
                  }))
                );
              }
              break;
            }
            default:
              break;
          }
          if (event.kind !== 'done' && !running.includes(agentId)) {
            running = [...running, agentId];
          }
          const liveTurns = { ...s.liveTurns, [key]: t };
          if (
            event.kind === 'done' &&
            t.finalBlocks.length === 0 &&
            t.deltaBlocks.length === 0 &&
            !t.accumText
          ) {
            // Nothing was produced (e.g. stopped immediately) — drop the stub;
            // otherwise the persisted chat:message replaces it.
            delete liveTurns[key];
          }
          // Turn ended — no question can still be waiting on it (main also cancels
          // + broadcasts ask:resolved; this just guarantees an instant clear).
          let pendingAsks = s.pendingAsks;
          if (event.kind === 'done' && pendingAsks[key]) {
            pendingAsks = { ...pendingAsks };
            delete pendingAsks[key];
          }
          return {
            liveTurns,
            pendingAsks,
            runningAgents: { ...s.runningAgents, [workspaceId]: running },
          };
        });
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
        // Authoritative merged meta from main (titles, attention, read marks…).
        set((s) => ({
          chatsMeta: {
            ...s.chatsMeta,
            [workspaceId]: { ...s.chatsMeta[workspaceId], [String(agentId)]: meta },
          },
        }));
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
    },

    toast: (kind, text) => {
      const id = ++toastId;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000);
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
      void get().refreshCaps(id); // re-derive the rung on focus (git init / gh changes)
      if (first) void get().loadWorkspaceData(first);
    },

    selectWorkspace: (id) => {
      const prev = get().activeWorkspaceId;
      // Selecting a workspace always leaves the Workspaces browser.
      set({ activeWorkspaceId: id, showWorkspaces: false });
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

    setPreviewState: (p) => set((s) => ({ previewByWs: { ...s.previewByWs, [p.workspaceId]: p } })),

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
        chatsMeta: {
          ...s.chatsMeta,
          [wsId]: {
            ...s.chatsMeta[wsId],
            [String(agentId)]: { ...s.chatsMeta[wsId]?.[String(agentId)], ...patch },
          },
        },
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
        chatsMeta: {
          ...s.chatsMeta,
          [wsId]: {
            ...s.chatsMeta[wsId],
            [String(agentId)]: { ...s.chatsMeta[wsId]?.[String(agentId)], lastReadAt: Date.now() },
          },
        },
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
      })),

    addDockTerminal: (wsId) => {
      set((s) => {
        const list = s.dockTermIds[wsId] ?? DEFAULT_TERM_IDS;
        const n = (list.length ? Math.max(...list) : 0) + 1;
        return {
          dockTermIds: { ...s.dockTermIds, [wsId]: [...list, n] },
          dockOpen: { ...s.dockOpen, [wsId]: true },
          dockTab: { ...s.dockTab, [wsId]: `term:${n}` },
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

    loadWorkspaceData: async (wsId) => {
      const s = get();
      if (!s.messages[wsId]) {
        const msgs = await invoke('chat:list', { workspaceId: wsId }).catch(() => []);
        set((st) => ({ messages: { ...st.messages, [wsId]: msgs } }));
        const maxAgent = Math.max(1, ...msgs.map((m) => m.agentId));
        set((st) => ({ agentCount: { ...st.agentCount, [wsId]: Math.max(st.agentCount[wsId] ?? 1, maxAgent) } }));
      }
      const running = await invoke('chat:running', { workspaceId: wsId }).catch(() => [] as number[]);
      set((st) => ({ runningAgents: { ...st.runningAgents, [wsId]: running } }));
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

    refreshGit: async (wsId) => {
      const { data } = await tryInvoke('git:status', { workspaceId: wsId });
      if (data) set((s) => ({ gitStatus: { ...s.gitStatus, [wsId]: data } }));
    },

    refreshDiff: async (wsId) => {
      const { data, error } = await tryInvoke('git:diff', { workspaceId: wsId });
      if (data) set((s) => ({ diffs: { ...s.diffs, [wsId]: data } }));
      else if (error) get().toast('error', `Diff failed: ${error}`);
    },

    refreshPr: async (wsId, force) => {
      const { data } = await tryInvoke('github:prStatus', { workspaceId: wsId, force });
      set((s) => ({ prStatus: { ...s.prStatus, [wsId]: data ?? null } }));
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
          chatsMeta: {
            ...st.chatsMeta,
            [wsId]: {
              ...st.chatsMeta[wsId],
              [String(agentId)]: {
                ...st.chatsMeta[wsId]?.[String(agentId)],
                title: provisionalTitle(text),
              },
            },
          },
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

    editQueued: (wsId, agentId, itemId, text) => {
      void invoke('chat:queue:edit', { workspaceId: wsId, agentId, itemId, text });
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
      const prev = diffStatTimers.get(wsId);
      if (prev) clearTimeout(prev);
      diffStatTimers.set(
        wsId,
        setTimeout(() => {
          diffStatTimers.delete(wsId);
          void tryInvoke('git:diffstat', { workspaceId: wsId }).then((r) => {
            if (r.data) set((s) => ({ diffStats: { ...s.diffStats, [wsId]: r.data } }));
          });
        }, 600)
      );
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
        workspaces: data.workspaces,
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
      if (data) set((s) => ({ projectCaps: { ...s.projectCaps, [projectId]: data } }));
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
      const parts: string[] = [];
      if (data.projects) parts.push(`${data.projects} project${data.projects === 1 ? '' : 's'}`);
      if (data.workspaces) parts.push(`${data.workspaces} workspace${data.workspaces === 1 ? '' : 's'}`);
      if (data.chats) parts.push(`${data.chats} chat${data.chats === 1 ? '' : 's'}`);
      get().toast('success', parts.length ? `Imported ${parts.join(', ')} from Conductor` : 'Nothing new to import');

      // Reload projects+workspaces (the gate closes as projects.length flips > 0),
      // then focus the most recently active imported workspace.
      await get().refreshProjects();
      const s = get();
      const focusWs = data.focusWorkspaceId ? s.workspaces.find((w) => w.id === data.focusWorkspaceId) : null;
      const projectId = focusWs?.projectId ?? s.activeProjectId ?? s.projects[0]?.id ?? null;
      if (projectId) {
        localStorage.setItem('activeProjectId', projectId);
        set({ activeProjectId: projectId, showWorkspaces: false });
        void get().refreshCaps(projectId);
      }
      if (focusWs) get().selectWorkspace(focusWs.id);
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
      const parts: string[] = [];
      if (data.projects) parts.push(`${data.projects} project${data.projects === 1 ? '' : 's'}`);
      if (data.workspaces) parts.push(`${data.workspaces} workspace${data.workspaces === 1 ? '' : 's'}`);
      if (data.chats) parts.push(`${data.chats} chat${data.chats === 1 ? '' : 's'}`);
      get().toast('success', parts.length ? `Imported ${parts.join(', ')}` : 'Nothing new to import');
      if (data.errors.length) get().toast('error', data.errors[0]);

      await get().refreshProjects();
      const s = get();
      const focusWs = data.focusWorkspaceId ? s.workspaces.find((w) => w.id === data.focusWorkspaceId) : null;
      const projectId = focusWs?.projectId ?? s.activeProjectId ?? s.projects[0]?.id ?? null;
      if (projectId) {
        localStorage.setItem('activeProjectId', projectId);
        set({ activeProjectId: projectId, showWorkspaces: false });
        void get().refreshCaps(projectId);
      }
      if (focusWs) get().selectWorkspace(focusWs.id);
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
      if (patch.theme) get().applyTheme(patch.theme);
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

    applyTheme: (theme) => {
      const resolved = resolveTheme(theme);
      document.documentElement.classList.toggle('dark', resolved === 'dark');
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
      const { data, error } = await tryInvoke('workspace:restore', { workspaceId: wsId });
      if (error) get().toast('error', error);
      else {
        get().selectWorkspace(wsId);
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
        get().toast('success', `PR created: ${data.url ?? ''}`);
        void get().refreshPr(wsId, true);
        get().setTab(wsId, 'checks');
      } finally {
        set((s) => ({ creatingPr: { ...s.creatingPr, [wsId]: false } }));
      }
    },

    continueWorkspace: async (wsId) => {
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
