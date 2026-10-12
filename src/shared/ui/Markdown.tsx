'use client';
import React, { forwardRef, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { renderMarkdown } from './format';
import { useUiHost } from './host';

/**
 * Rendered markdown with one-click copy buttons on fenced code blocks. Moved to
 * the shared UI package (web-desktop-parity spec §2.5) so the renderer and
 * Maestro Web render prose identically. The copy buttons live inside the
 * sanitized HTML (added by renderMarkdown), so copying is handled here by
 * delegation via the host's clipboard.
 *
 * Host seams (§2.4):
 *  - `copyText` — used by the fenced-code copy buttons.
 *  - `imageSrc` — when set (web), fills the inert `<img data-ws-src>` elements
 *    renderMarkdown emits; when unset (desktop) the renderer layers its own
 *    async worktree-image loader on the forwarded ref (useWorktreeImages).
 *  - `openImage` — when set (web), tapping a loaded image spotlights it.
 *  - `openFile` — when unset (web), relative file links are neutralised so a tap
 *    never navigates the page away; when set (desktop) the renderer's own
 *    capture-phase listener resolves the href and opens the in-app editor.
 */
export const Markdown = forwardRef<HTMLDivElement, { text: string; className?: string }>(function Markdown(
  { text, className },
  forwardedRef
) {
  const host = useUiHost();
  const ref = useRef<HTMLDivElement | null>(null);
  const assign = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (typeof forwardedRef === 'function') forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  // The HTML is patched in place, not re-set: a streaming message re-renders on
  // every token, and replacing the whole subtree each time destroyed any text
  // selection in it — the user couldn't copy a finished paragraph while the next
  // one was still arriving. Only top-level nodes from the first changed one on
  // are swapped; everything before it (usually all but the last paragraph)
  // keeps its DOM. React renders the initial HTML once (SSR-safe) and never
  // touches the subtree again — which needs the SAME `{ __html }` object every
  // render: React 19 diffs that prop by identity, so a fresh object literal
  // re-set innerHTML on every render (even with unchanged text), wiping
  // selections in finished messages whenever anything above them re-rendered.
  const html = useMemo(() => renderMarkdown(text), [text]);
  const [initial] = useState(() => ({ __html: html }));
  const initialHtml = initial.__html;
  const sources = useRef<string[] | null>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    sources.current ??= topLevelSources(parseHtml(initialHtml));
    const next = parseHtml(html);
    const nextSources = topLevelSources(next);
    const prev = sources.current;
    let same = 0;
    while (same < prev.length && same < nextSources.length && prev[same] === nextSources[same]) same++;
    if (same === prev.length && same === nextSources.length) return;
    while (root.childNodes.length > same) root.lastChild!.remove();
    root.append(...Array.from(next.childNodes).slice(same));
    sources.current = nextSources;
  }, [html, initialHtml]);

  // Desktop: hand the rendered subtree to the host's imperative hydrator (worktree
  // images + in-app file links).
  //
  // Both hydration passes depend on `[text, host]` (perf spec §4.9.3): the HTML
  // is a pure function of `text`, so the patch above only touches this subtree
  // when `text` changes — every other render leaves the hydrated DOM as it was. The
  // effects used to run dep-free, re-walking the whole transcript's markup on
  // every re-render of any message. `text` isn't read inside the effect; it is
  // the dependency *of the DOM* the effect touches.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !host.hydrateMarkdown) return;
    return host.hydrateMarkdown(root);
  }, [text, host]);

  // Web image hydration: fill `<img data-ws-src>` from the host resolver when no
  // imperative hydrator is provided.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || host.hydrateMarkdown || !host.imageSrc) return;
    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-ws-src]')) {
      const raw = img.dataset.wsSrc ?? '';
      const url = host.imageSrc(raw);
      if (url) {
        img.dataset.wsState = 'ready';
        img.src = url;
      }
    }
  }, [text, host]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (anchor) {
      const href = (anchor.getAttribute('href') ?? '').trim();
      const external = /^(?:https?|mailto|tel|data|blob):/i.test(href);
      // Web (no openFile / no hydrator): a relative worktree path would otherwise
      // navigate the whole app away — neutralise it. The desktop handles file
      // links inside its hydrateMarkdown pass.
      if (!external && !host.openFile && !host.hydrateMarkdown) e.preventDefault();
      return;
    }
    const btn = target.closest<HTMLElement>('.code-copy');
    if (!btn) return;
    const code = btn.parentElement?.querySelector('pre')?.textContent ?? '';
    if (!code) return;
    void host.copyText(code);
    btn.classList.add('copied');
    window.setTimeout(() => btn.classList.remove('copied'), 1400);
  };

  // On pointerup, not click: iOS spends a tap's click on revealing the message's
  // group-hover actions, so a click-driven spotlight needed a second tap.
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target;
    // Only an image with real pixels — not an inert worktree ref or a broken URL.
    if (host.openImage && e.button === 0 && t instanceof HTMLImageElement && t.naturalWidth > 0 && !t.closest('a[href]'))
      host.openImage(t.currentSrc, t.alt);
  };

  return (
    <div
      ref={assign}
      className={clsx('md', className)}
      data-spotlight={host.openImage ? '' : undefined}
      onClick={onClick}
      onPointerUp={onPointerUp}
      dangerouslySetInnerHTML={initial}
    />
  );
});

/** Parse sanitized markdown HTML into a detached fragment. */
function parseHtml(html: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

/** Each top-level node's source markup — captured before hydration mutates the
 *  live nodes, so it's what a later render is compared against. */
function topLevelSources(frag: DocumentFragment): string[] {
  return Array.from(frag.childNodes, (n) => (n instanceof Element ? n.outerHTML : `#${n.nodeType}:${n.textContent}`));
}
