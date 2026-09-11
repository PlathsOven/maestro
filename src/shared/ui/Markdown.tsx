'use client';
import React, { forwardRef, useLayoutEffect, useRef } from 'react';
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

  // Desktop: hand the rendered subtree to the host's imperative hydrator (worktree
  // images + in-app file links). No dep array — the markdown HTML is rebuilt on
  // every render (each streaming delta included), so re-run each pass, mirroring
  // the desktop's useWorktreeImages.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !host.hydrateMarkdown) return;
    return host.hydrateMarkdown(root);
  });

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
  });

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

  return (
    <div
      ref={assign}
      className={clsx('md', className)}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
});

export default Markdown;
