import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { GLASS_FIELD, LiquidGlass } from '../../shared/ui/LiquidGlass';

/**
 * Find-in-chat (⌘F). Matches are painted with the CSS Custom Highlight API rather
 * than wrapped in <mark>s: the transcript is React-owned (and partly memoised
 * markdown HTML), so mutating it would fight reconciliation. Ranges are pure
 * overlays. A match must sit inside one text node, and hidden content (a folded
 * tool call) isn't searched — only what can be scrolled to.
 */

const MAX_MATCHES = 2000;
/** Space the bar covers at the top of the scrollport (offset + h-9 + air). */
const BAR_H = 56;

// Highlight names are document-global but each split pane searches on its own,
// so every pane registers its ranges here and paint() rebuilds both highlights.
const panes = new Map<string, { all: Range[]; current?: Range }>();

function paint() {
  const all = new Highlight();
  const current = new Highlight();
  current.priority = 1; // the active match paints over the rest
  for (const p of panes.values()) {
    p.all.forEach((r) => all.add(r));
    if (p.current) current.add(p.current);
  }
  CSS.highlights.set('chat-find', all);
  CSS.highlights.set('chat-find-current', current);
}

/** Every visible, case-insensitive occurrence of `query` under `root`, in
 *  document order, skipping `data-find-skip` subtrees. */
function collect(root: HTMLElement, query: string): Range[] {
  const out: Range[] = [];
  if (!query) return out;
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && out.length < MAX_MATCHES; n = walker.nextNode()) {
    const text = n.nodeValue ?? '';
    const p = n.parentElement;
    if (!p || !text.match(re) || p.closest('[data-find-skip]') || !p.checkVisibility()) continue;
    for (const m of text.matchAll(re)) {
      const r = document.createRange();
      r.setStart(n, m.index);
      r.setEnd(n, m.index + m[0].length);
      out.push(r);
    }
  }
  return out.slice(0, MAX_MATCHES);
}

/** Centre `range` in `scroller` unless it's already clear of the bar and the
 *  composer; first nudge a wide code block sideways if the match is off its edge. */
function reveal(range: Range, scroller: HTMLElement, bottomInset: number) {
  const wide = range.startContainer.parentElement?.closest('pre');
  if (wide && scroller.contains(wide)) {
    const r = range.getBoundingClientRect();
    const w = wide.getBoundingClientRect();
    if (r.left < w.left || r.right > w.right) wide.scrollLeft += r.left - w.left - w.width / 3;
  }
  const r = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const top = box.top + BAR_H;
  const bottom = box.bottom - bottomInset;
  if (r.top < top || r.bottom > bottom) scroller.scrollTop += r.top - (top + bottom) / 2;
}

export function ChatFindBar({
  paneKey,
  scrollRef,
  open,
  top,
  bottomInset,
  onClose,
}: {
  paneKey: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Bumped on every ⌘F; a non-empty `seed` (selected text) replaces the query. */
  open: { seed: string; n: number };
  top: number | string;
  bottomInset: number;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(open.seed);
  const [matches, setMatches] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  // Only an explicit step (typing, Enter, arrows) scrolls to the current match;
  // a background re-collect (a streaming turn) must not yank the view.
  const revealNext = useRef(true);

  useEffect(() => {
    if (open.seed) setQuery(open.seed);
    inputRef.current?.select();
  }, [open]);

  // Collect on a new query (starting from the first match in view, like a
  // browser), then re-collect — debounced, keeping position — as the transcript
  // changes under the open bar.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = collect(el, query);
    const viewTop = el.getBoundingClientRect().top + BAR_H;
    const first = next.findIndex((r) => r.getBoundingClientRect().bottom >= viewTop);
    revealNext.current = true;
    setMatches(next);
    setIndex(first < 0 ? Math.max(0, next.length - 1) : first);

    let t: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        const again = collect(el, query);
        setMatches(again);
        setIndex((i) => Math.min(i, Math.max(0, again.length - 1)));
      }, 150);
    });
    mo.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      clearTimeout(t);
      mo.disconnect();
    };
  }, [query, scrollRef]);

  useEffect(() => {
    const current = matches[index];
    panes.set(paneKey, { all: matches, current });
    paint();
    if (current && revealNext.current && scrollRef.current) reveal(current, scrollRef.current, bottomInset);
    revealNext.current = false;
    // bottomInset is read at step time only; a composer resize shouldn't re-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, index, paneKey, scrollRef]);

  useEffect(
    () => () => {
      panes.delete(paneKey);
      paint();
    },
    [paneKey]
  );

  const count = matches.length;
  const step = (dir: 1 | -1) => {
    if (!count) return;
    revealNext.current = true;
    setIndex((i) => (i + dir + count) % count);
  };

  const buttons = [
    { title: 'Previous match (⇧↵)', icon: ChevronUp, onClick: () => step(-1), disabled: !count },
    { title: 'Next match (↵)', icon: ChevronDown, onClick: () => step(1), disabled: !count },
    { title: 'Close (Esc)', icon: X, onClick: onClose, disabled: false },
  ];

  return (
    <LiquidGlass
      radius={999}
      {...GLASS_FIELD}
      tint="light"
      role="search"
      data-motion="pop"
      className="lg-float absolute right-5 z-20 flex h-9 items-center gap-0.5 pl-3 pr-1 text-xs"
      style={{ top }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'Enter' && e.target === inputRef.current) {
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        }
      }}
    >
      <Search size={13} className="shrink-0 text-faint" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find in chat"
        aria-label="Find in chat"
        spellCheck={false}
        className="w-44 min-w-0 bg-transparent px-1.5 text-fg outline-none placeholder:text-faint"
      />
      <span className="min-w-[4.5rem] text-right tabular-nums text-faint" aria-live="polite">
        {query && (count ? `${index + 1} of ${count}` : 'No results')}
      </span>
      {buttons.map(({ title, icon: Icon, onClick, disabled }) => (
        <button
          key={title}
          type="button"
          title={title}
          aria-label={title}
          disabled={disabled}
          onClick={onClick}
          className="grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-accent-soft hover:text-fg disabled:opacity-40"
        >
          <Icon size={14} />
        </button>
      ))}
    </LiquidGlass>
  );
}
