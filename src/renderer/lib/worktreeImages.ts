import { tryInvoke } from './api';
import { resolveFileHref } from './format';
import { useApp } from '../store/app';

/**
 * The desktop's imperative hydrator for a rendered-markdown subtree, passed to
 * the shared Markdown via `UiHost.hydrateMarkdown` (web-desktop-parity §2.4). It
 * does three things the renderer origin can't do declaratively:
 *
 *  1. Fills the inert `<img data-ws-src>` elements `renderMarkdown` emits, so an
 *     agent can answer with a picture (`![login](.context/preview/shot-1.png)`)
 *     rather than a path the user has to open. Each path is resolved like a
 *     markdown *link* (`resolveFileHref`) and read through `attachment:read`,
 *     which returns a `data:` URL; anything unreadable becomes a "missing" chip.
 *  2. Opens a click on such an image in the zoomable lightbox (spotlight),
 *     seeded with every image in the same transcript so its arrows can step
 *     between them — rather than routing the click into the Editor surface.
 *  3. Routes a click on a worktree file *link* to the in-app editor rather than
 *     letting the anchor navigate the renderer to a `file://` page (blank app).
 *
 * Returns a cleanup that detaches the click listener. Runs after every render
 * (the shared Markdown calls it with no dep array), so streaming turns re-fill.
 */
export function hydrateChatMarkdown(root: HTMLElement): () => void {
  hydrateImages(root);

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // A worktree file *link* → open in the in-app editor.
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (anchor) {
      const st = useApp.getState();
      const wsId = st.activeWorkspaceId;
      const ws = st.workspaces.find((w) => w.id === wsId);
      if (wsId && ws) {
        const rel = resolveFileHref(anchor.getAttribute('href') ?? '', ws.worktreePath);
        if (rel) {
          e.preventDefault();
          st.openFile(wsId, rel);
        }
      }
      return;
    }
    // A worktree *image* → open the zoomable lightbox (unless it's inside a
    // link). Seed it with every resolved image in the same transcript so the
    // arrows can page through them; the clicked one becomes the initial index.
    const img = target.closest<HTMLImageElement>('img[data-ws-path]');
    if (img && !img.closest('a')) {
      const wsId = useApp.getState().activeWorkspaceId;
      if (!wsId) return;
      const scope = img.closest<HTMLElement>('[data-img-gallery]') ?? root;
      const els = Array.from(scope.querySelectorAll<HTMLImageElement>('img[data-ws-path]'));
      const images = els.map((el) => ({ path: el.dataset.wsPath!, alt: el.alt || undefined }));
      useApp.getState().openLightbox({ workspaceId: wsId, images, index: Math.max(0, els.indexOf(img)) });
    }
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}

function hydrateImages(root: HTMLElement) {
  const imgs = root.querySelectorAll<HTMLImageElement>('img[data-ws-src]');
  if (!imgs.length) return;

  const st = useApp.getState();
  const wsId = st.activeWorkspaceId;
  const worktree = st.workspaces.find((w) => w.id === wsId)?.worktreePath;

  for (const img of imgs) {
    const raw = img.dataset.wsSrc ?? '';
    const rel = wsId && worktree ? resolveFileHref(raw, worktree) : null;
    if (!wsId || !rel) {
      markMissing(img, raw);
      continue;
    }
    img.dataset.wsPath = rel; // what a click opens
    const key = `${wsId}\n${rel}`;
    if (cache.has(key)) {
      apply(img, raw, cache.get(key)!);
      continue;
    }
    img.dataset.wsState = 'loading'; // no alt-text flash while the file loads
    void read(wsId, rel, key).then(() => apply(img, raw, cache.get(key) ?? null));
  }
}

/**
 * Resolved `data:` URLs, keyed workspace + path (`null` = nothing to show).
 * Markdown is re-parsed on every render, so without this a streaming turn would
 * re-read its screenshots on every delta. Capped because these are base64 image
 * payloads: a long session of screenshots shouldn't pin them all in memory.
 */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<unknown>>();
const CACHE_MAX = 24;

/**
 * Resolve a worktree image to its `data:` URL, sharing the inline-image cache
 * and its one-read-per-path dedup. Used by the lightbox so paging to an image
 * already shown inline is instant, and never re-reads a file twice.
 */
export async function readWorktreeImage(workspaceId: string, path: string): Promise<string | null> {
  const key = `${workspaceId}\n${path}`;
  if (cache.has(key)) return cache.get(key)!;
  await read(workspaceId, path, key);
  return cache.get(key) ?? null;
}

/** One read per path, however many elements (or renders) are waiting on it. */
function read(workspaceId: string, path: string, key: string): Promise<unknown> {
  let pending = inflight.get(key);
  if (!pending) {
    pending = tryInvoke('attachment:read', { workspaceId, path }).then(({ data }) => {
      cache.set(key, data?.kind === 'image' ? data.dataUrl ?? null : null);
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      inflight.delete(key);
    });
    inflight.set(key, pending);
  }
  return pending;
}

function apply(img: HTMLImageElement, raw: string, dataUrl: string | null) {
  if (!dataUrl) return markMissing(img, raw);
  img.dataset.wsState = 'ready';
  img.src = dataUrl;
}

/**
 * Nothing readable at that path — a hallucinated filename, or one outside the
 * worktree. Swap the element for a chip naming what was asked for.
 */
function markMissing(img: HTMLImageElement, raw: string) {
  const chip = document.createElement('span');
  chip.className = 'md-img-missing';
  chip.textContent = img.alt || raw;
  chip.title = `No readable image at ${raw}`;
  img.replaceWith(chip);
}
