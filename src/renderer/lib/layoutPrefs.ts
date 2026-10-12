// Renderer layout preferences persisted to localStorage: panel sizes and the
// per-workspace session-rail order.

/** Resizable panel sizes (px). Live-updated while dragging a divider, then
 *  persisted to localStorage so the layout survives restarts. */
export interface LayoutSizes {
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
export const clampLayout = (l: LayoutSizes): LayoutSizes => ({
  sidebar: clampLayoutValue(l.sidebar, LAYOUT_LIMITS.sidebar),
  sessions: clampLayoutValue(l.sessions, LAYOUT_LIMITS.sessions),
  right: clampLayoutValue(l.right, LAYOUT_LIMITS.right),
  dock: clampLayoutValue(l.dock, LAYOUT_LIMITS.dock),
});
export function loadLayout(): LayoutSizes {
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
export function loadChatOrders(): Record<string, number[]> {
  try {
    const raw = localStorage.getItem(CHAT_ORDER_KEY);
    if (raw) return JSON.parse(raw) as Record<string, number[]>;
  } catch {
    /* ignore malformed persisted order */
  }
  return {};
}
export function saveChatOrder(wsId: string, ids: number[]) {
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
export function applyChatOrder(ids: number[], saved: number[] | undefined): number[] {
  if (!saved || saved.length === 0) return ids;
  const rank = new Map(saved.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || a - b);
}

// Persisted sidebar workspace order (drag-reorder), a flat list of workspace ids
// across all projects. Like the rail order, only the relative order is used:
// unknown ids (new workspaces) keep their incoming createdAt order at the end.
const WORKSPACE_ORDER_KEY = 'workspaceOrder';
export function saveWorkspaceOrder(ids: string[]) {
  try {
    localStorage.setItem(WORKSPACE_ORDER_KEY, JSON.stringify(ids));
  } catch {
    /* storage full / unavailable — order just won't persist */
  }
}
export function applyWorkspaceOrder<T extends { id: string }>(list: T[]): T[] {
  let saved: string[] = [];
  try {
    saved = JSON.parse(localStorage.getItem(WORKSPACE_ORDER_KEY) ?? '[]') as string[];
  } catch {
    /* ignore malformed persisted order */
  }
  if (saved.length === 0) return list;
  const rank = new Map(saved.map((id, i) => [id, i]));
  return [...list].sort((a, b) => (rank.get(a.id) ?? saved.length) - (rank.get(b.id) ?? saved.length));
}
