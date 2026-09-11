import type { AnnotationItem, ElementRef, Rect } from '../../shared/types';

/**
 * Pure geometry + prompt helpers for annotation mode (§9). Kept free of any DOM /
 * React so the ones scripts/e2e.ts covers (§15) can be unit-tested node-side:
 * hit-test math (hitTest / pointInSmallest / boxMaxOverlap), composite scaling
 * (scaledDims) at dpr 1 and 2, and the structured prompt body (annotationBody).
 * Coordinates are all in the screenshot's CSS-px space (the box the user marked up).
 */

export type Pt = { x: number; y: number };

function rectArea(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function containsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

function intersectionArea(a: Rect, b: Rect): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - x) * Math.max(0, bottom - y);
}

/** Two corner points → a normalized rect. */
export function boxFromPoints(p0: Pt, p1: Pt): Rect {
  return {
    x: Math.min(p0.x, p1.x),
    y: Math.min(p0.y, p1.y),
    width: Math.abs(p1.x - p0.x),
    height: Math.abs(p1.y - p0.y),
  };
}

/** Smallest-area element whose rect contains the point (§9.2). Ties keep the
 *  first — layout order, so a genuinely-smaller later element still wins. */
export function pointInSmallest(elements: ElementRef[], x: number, y: number): ElementRef | null {
  let best: ElementRef | null = null;
  for (const e of elements) {
    if (!containsPoint(e.rect, x, y)) continue;
    if (!best || rectArea(e.rect) < rectArea(best.rect)) best = e;
  }
  return best;
}

/**
 * The element whose rect best matches the drawn box (§9.2 "max-overlap for
 * boxes"), scored by intersection-over-union. IoU is the right metric for "which
 * element did this box circle": a box drawn around the Save button matches the
 * button (IoU ≈ 1), not the page-sized container it also sits inside (IoU ≈ 0) —
 * whereas raw intersection area would always favor the largest enclosing element.
 * Returns null when the box overlaps nothing.
 */
export function boxMaxOverlap(elements: ElementRef[], box: Rect): ElementRef | null {
  let best: ElementRef | null = null;
  let bestIoU = 0;
  for (const e of elements) {
    const inter = intersectionArea(e.rect, box);
    if (inter <= 0) continue;
    const union = rectArea(e.rect) + rectArea(box) - inter;
    const iou = union > 0 ? inter / union : 0;
    if (iou > bestIoU) {
      bestIoU = iou;
      best = e;
    }
  }
  return best;
}

/** The point a non-box mark is anchored to: the pin dot, or a stroke's head. */
export function markPoint(item: AnnotationItem): Pt | null {
  if (!item.points.length) return null;
  if (item.kind === 'pin') return item.points[0];
  return item.points[item.points.length - 1]; // arrow head / pen tail
}

/** Hit-test one mark against the layout index — box uses max-overlap, everything
 *  else uses point-in-smallest (§9.2). Returns the matched element or null. */
export function hitTest(item: AnnotationItem, elements: ElementRef[]): ElementRef | null {
  if (item.kind === 'box' && item.points.length >= 2) {
    return boxMaxOverlap(elements, boxFromPoints(item.points[0], item.points[1]));
  }
  const p = markPoint(item);
  return p ? pointInSmallest(elements, p.x, p.y) : null;
}

/** Physical composite dimensions for a CSS box at a given devicePixelRatio (§9.3
 *  "composite scales once by dpr"). */
export function scaledDims(cssW: number, cssH: number, dpr: number): { width: number; height: number } {
  return { width: Math.round(cssW * dpr), height: Math.round(cssH * dpr) };
}

/** The structured, selector-anchored body folded into the prompt by
 *  renderAttachments (§9.3). Excludes the header + screenshot path (those are
 *  added from `a.path` main-side) — just the page line and the numbered marks. */
export function annotationBody(items: AnnotationItem[], url: string, cssW: number, cssH: number): string {
  const verb: Record<AnnotationItem['kind'], string> = {
    box: 'box around',
    arrow: 'arrow →',
    pin: 'pin at',
    pen: 'mark on',
  };
  const lines = items.map((it, i) => {
    const n = i + 1;
    const note = it.note?.trim() ? ` — ${it.note.trim()}` : '';
    if (it.selector) {
      const label = it.matchText ? ` (${JSON.stringify(it.matchText)})` : '';
      return `${n}. ${verb[it.kind]} \`${it.selector}\`${label}${note}`;
    }
    const p = markPoint(it) ?? { x: 0, y: 0 };
    return `${n}. ${it.kind} at (${Math.round(p.x)}, ${Math.round(p.y)})${note}`;
  });
  return [
    `Page: ${url || '(unknown)'} · viewport ${Math.round(cssW)}×${Math.round(cssH)}`,
    '',
    ...lines,
  ].join('\n');
}
