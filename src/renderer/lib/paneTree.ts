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
export const hasLeaf = (node: PaneNode | undefined, id: number): boolean => paneIds(node).includes(id);
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
export function removeLeaf(node: PaneNode, id: number): PaneNode | null {
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
export function insertBeside(node: PaneNode, targetId: number, newId: number, side: DropSide): PaneNode {
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
export function appendColumn(node: PaneNode, newId: number): PaneNode {
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
export function withFocusedLeaf(layout: PaneNode | undefined, prevFocused: number, agentId: number): PaneNode {
  const cur = layout ?? leaf(prevFocused);
  if (hasLeaf(cur, agentId)) return cur;
  const swapped = replaceLeaf(cur, prevFocused, agentId);
  return hasLeaf(swapped, agentId) ? swapped : leaf(agentId);
}
