/**
 * The motion engine shared by the desktop renderer and Maestro Web. It pairs with
 * the `[data-motion]` rules in theme.css:
 *
 *  - Enter animations for overlays (pop, modal, sheet, toast, fade, swap) are plain
 *    CSS keyframes that run when the element mounts.
 *  - Everything React can't animate on its own is handled here, by one
 *    MutationObserver on <body>:
 *      • exits: when React removes an element marked `data-motion`, it's put
 *        back where it was, marked `data-exiting` + inert, played out, and then
 *        removed. React is done with a deleted node, so borrowing it back is safe.
 *      • in-flow enter: a `collapse` / `row` / `tab` added to a parent that was
 *        already on screen grows from zero height (width for `tab`), so its
 *        siblings slide instead of jumping.
 *      • morphs: when an element marked `data-morph="key"` is swapped for another
 *        with the same key (e.g. the expanded sidebar for its collapsed rail),
 *        the newcomer tweens from the old one's width.
 *
 * Components opt in with an attribute only; nothing needs to know about
 * unmount timing. Replacements (a whole list re-rendered because the workspace
 * changed) are left instant, as is everything under prefers-reduced-motion.
 */

type Kind = 'pop' | 'pop-up' | 'modal' | 'sheet' | 'fade' | 'swap' | 'toast' | 'collapse' | 'row' | 'tab';

const EASE_GLASS = 'cubic-bezier(0.25, 0.8, 0.25, 1)';
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EXIT_MS = 150;
const SIZE_MS = 240;
/** More in-flow changes than this under one parent in one commit is a re-render, not an edit. */
const MAX_BATCH = 60;
const STAGGER_MS = 14;

const IN_FLOW = new Set<Kind>(['collapse', 'row', 'tab']);

let installed = false;

export function installMotion(): void {
  if (installed || typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;
  installed = true;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const morphWidths = new Map<string, number>();
  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver((entries) => {
          for (const e of entries) {
            const el = e.target as HTMLElement;
            const key = el.dataset.morph;
            if (key && el.isConnected && !el.hasAttribute('data-exiting')) morphWidths.set(key, el.getBoundingClientRect().width);
          }
        })
      : null;
  // Morph elements are few; rather than scanning every added subtree (the
  // transcript streams constantly), rescan the document shortly after any
  // structural change. A morph is always user-triggered, well after that.
  let scan = 0;
  const trackMorphs = () => {
    if (!ro || scan) return;
    scan = window.setTimeout(() => {
      scan = 0;
      document.querySelectorAll('[data-morph]').forEach((el) => ro.observe(el));
    }, 250);
  };
  trackMorphs();

  const mo = new MutationObserver((records) => {
    if (reduce?.matches || document.hidden) {
      trackMorphs();
      return;
    }
    const enters = new Map<Node, HTMLElement[]>();
    const exits = new Map<Node, { el: HTMLElement; prev: Node | null; next: Node | null }[]>();
    const morphIn: HTMLElement[] = [];
    // React moves a keyed node (a reorder) by re-inserting it: that's a removal
    // plus an addition of the same, still-connected node — neither an exit nor an enter.
    const moved = new Set<Node>();
    for (const r of records) r.removedNodes.forEach((n) => n.isConnected && moved.add(n));
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement) || n.hasAttribute('data-exiting') || moved.has(n)) return;
        if (n.firstElementChild) trackMorphs();
        if (n.dataset.morph) {
          morphIn.push(n);
          ro?.observe(n);
        }
        const kind = n.dataset.motion as Kind | undefined;
        if (kind && IN_FLOW.has(kind)) push(enters, r.target, n);
      });
      r.removedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement) || n.isConnected || n.hasAttribute('data-exiting')) return;
        // `swap` is enter-only: its replacement is already in the same slot.
        if (n.dataset.motion && n.dataset.motion !== 'swap') push(exits, r.target, { el: n, prev: r.previousSibling, next: r.nextSibling });
      });
    }
    // A parent that gained AND lost in-flow items in one commit had its list
    // replaced (another workspace, a new filter) — show that instantly. Pure
    // growth (a folder opened) or shrinkage (one closed) animates, staggered.
    const replaced = (parent: Node) => {
      const a = enters.get(parent)?.length ?? 0;
      const x = exits.get(parent)?.filter((i) => IN_FLOW.has(i.el.dataset.motion as Kind)).length ?? 0;
      return (a > 0 && x > 0) || a > MAX_BATCH || x > MAX_BATCH;
    };
    for (const [parent, els] of enters) {
      if (replaced(parent)) continue;
      els.forEach((el, i) => el.isConnected && enterInFlow(el, el.dataset.motion as Kind, Math.min(i, 12) * STAGGER_MS));
    }
    for (const [parent, items] of exits) {
      if (!parent.isConnected || !(parent instanceof Element)) continue;
      if (replaced(parent)) continue;
      for (const { el, prev, next } of items) {
        // Put it back where it was: before its old next sibling, else after its
        // old previous one (either may have been removed in the same commit).
        const at = next?.parentNode === parent ? next : prev?.parentNode === parent ? prev.nextSibling : null;
        exit(el, parent, at);
      }
    }
    for (const el of morphIn) {
      const from = morphWidths.get(el.dataset.morph!);
      if (from && el.isConnected) morph(el, from);
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/** The gap a flex/grid parent puts between children along `axis`, so a shrinking
 *  child can give that up too instead of leaving it to snap closed at the end. */
function gapOf(parent: Element, axis: 'x' | 'y'): number {
  const cs = getComputedStyle(parent);
  if (!/flex|grid/.test(cs.display)) return 0;
  const g = parseFloat(axis === 'y' ? cs.rowGap : cs.columnGap);
  return Number.isFinite(g) ? g : 0;
}

function enterInFlow(el: HTMLElement, kind: Kind, delay = 0) {
  const axis = kind === 'tab' ? 'x' : 'y';
  const r = el.getBoundingClientRect();
  const size = axis === 'y' ? r.height : r.width;
  if (!size) return;
  // Tweening the height of something huge (an expanded 3,000-line diff) means a
  // full layout per frame; just fade those in.
  if (size > tooBig(axis)) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SIZE_MS, easing: EASE_GLASS, delay, fill: 'backwards' });
    return;
  }
  const dim = axis === 'y' ? 'height' : 'width';
  const pad = axis === 'y' ? ['paddingTop', 'paddingBottom'] : ['paddingLeft', 'paddingRight'];
  const cs = getComputedStyle(el);
  const from: Keyframe = { [dim]: '0px', opacity: 0, [pad[0]]: '0px', [pad[1]]: '0px', overflow: 'hidden' };
  const to: Keyframe = { [dim]: `${size}px`, opacity: 1, [pad[0]]: cs[pad[0] as 'paddingTop'], [pad[1]]: cs[pad[1] as 'paddingBottom'], overflow: 'hidden' };
  if (kind === 'row') {
    from.translate = '0 -4px';
    to.translate = '0 0';
  }
  el.animate([from, to], { duration: SIZE_MS, easing: EASE_OUT, delay, fill: 'backwards' });
}

const tooBig = (axis: 'x' | 'y') => (axis === 'y' ? window.innerHeight : window.innerWidth) * 1.5;

function exit(el: HTMLElement, parent: Element, before: Node | null) {
  const kind = el.dataset.motion as Kind;
  el.setAttribute('data-exiting', '');
  el.setAttribute('aria-hidden', 'true');
  el.inert = true;
  el.style.pointerEvents = 'none';
  parent.insertBefore(el, before);
  const done = () => el.remove();
  let anim: Animation;
  const opts = (ms: number, easing = EASE_GLASS): KeyframeAnimationOptions => ({ duration: ms, easing, fill: 'forwards' });
  switch (kind) {
    case 'pop':
    case 'pop-up':
      anim = el.animate(
        [{ opacity: 1 }, { opacity: 0, scale: '0.97', translate: kind === 'pop' ? '0 -3px' : '0 3px' }],
        opts(EXIT_MS)
      );
      break;
    case 'modal':
    case 'sheet': {
      const panel = el.firstElementChild as HTMLElement | null;
      panel?.animate(
        kind === 'modal'
          ? [{ opacity: 1 }, { opacity: 0, scale: '0.96', translate: '0 6px' }]
          : [{ translate: '0 0' }, { translate: '0 100%' }],
        opts(kind === 'modal' ? EXIT_MS : SIZE_MS)
      );
      anim = el.animate([{ opacity: 1 }, { opacity: 0 }], opts(kind === 'modal' ? EXIT_MS + 30 : SIZE_MS));
      break;
    }
    case 'fade':
      anim = el.animate([{ opacity: 1 }, { opacity: 0 }], opts(EXIT_MS));
      break;
    default: {
      // In-flow: fold the element away so its neighbours slide into the space.
      const axis = kind === 'tab' ? 'x' : 'y';
      const r = el.getBoundingClientRect();
      const size = axis === 'y' ? r.height : r.width;
      if (!size || size > tooBig(axis)) return done();
      const gap = gapOf(parent, axis);
      const dim = axis === 'y' ? 'height' : 'width';
      const [padA, padB] = axis === 'y' ? ['paddingTop', 'paddingBottom'] : ['paddingLeft', 'paddingRight'];
      const [marA, marB] = axis === 'y' ? ['marginTop', 'marginBottom'] : ['marginLeft', 'marginRight'];
      const cs = getComputedStyle(el);
      el.style.overflow = 'hidden';
      const last: Keyframe = { [dim]: '0px', opacity: 0, [padA]: '0px', [padB]: '0px', [marA]: '0px', [marB]: gap ? `${-gap}px` : '0px' };
      if (kind === 'toast') last.translate = '24px 0';
      if (kind === 'row') last.translate = '-6px 0';
      anim = el.animate(
        [{ [dim]: `${size}px`, opacity: 1, [padA]: cs[padA as 'paddingTop'], [padB]: cs[padB as 'paddingTop'], [marA]: cs[marA as 'marginTop'], [marB]: cs[marB as 'marginTop'] }, last],
        opts(SIZE_MS, EASE_OUT)
      );
    }
  }
  anim.onfinish = done;
  anim.oncancel = done;
  // Belt and braces: never leave a ghost behind if the animation is starved.
  setTimeout(done, 1000);
}

/** Tween a morph newcomer's width from its predecessor's (the only axis the
 *  sidebar/panel morphs change). */
function morph(el: HTMLElement, fromWidth: number) {
  const width = el.getBoundingClientRect().width;
  if (Math.abs(width - fromWidth) <= 1) return;
  // Hold the element's own floor/ceiling out of the way while it tweens.
  const hold = { minWidth: '0px', maxWidth: 'none', overflow: 'hidden' };
  el.animate([{ ...hold, width: `${fromWidth}px` }, { ...hold, width: `${width}px` }], { duration: SIZE_MS + 40, easing: EASE_OUT });
  // Let the content settle in rather than reflow visibly at the start.
  for (const child of Array.from(el.children) as HTMLElement[]) {
    child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SIZE_MS, easing: EASE_GLASS, delay: 60, fill: 'backwards' });
  }
}
