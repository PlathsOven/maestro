import { tryInvoke } from './api';
import { resolveFileHref } from '../../shared/ui/format';
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
 *     Cached images are re-checked against the file on every display, so an
 *     image the agent overwrote in place shows its new bytes, not the old ones.
 *  2. Opens a click on such an image in the zoomable lightbox (spotlight),
 *     seeded with every image in the same transcript so its arrows can step
 *     between them — rather than routing the click into the Editor surface.
 *  3. Routes a click on a worktree file *link* to the in-app editor rather than
 *     letting the anchor navigate the renderer to a `file://` page (blank app).
 *  4. Wraps inline-code file mentions (`src/app.ts`, `README.md:12`) that name
 *     a real worktree file in such a link, since agents cite files that way far
 *     more often than as markdown links.
 *
 * Returns a cleanup that detaches the click listener. Re-runs whenever the
 * markdown text changes (the shared Markdown keys its hydration on it), which is
 * exactly when React rewrites the subtree — so streaming turns re-fill.
 */
export function hydrateChatMarkdown(root: HTMLElement): () => void {
  hydrateImages(root);
  linkFileMentions(root);

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

/**
 * Wrap each inline-code span that reads like a path (no whitespace; a `/` or a
 * file extension; optional `:line[:col]`) in a file link — only once `fs:stat`
 * confirms it's a file in the worktree, so identifiers like `window.maestro`
 * never become dead links. The click handler above opens it like any file link.
 */
function linkFileMentions(root: HTMLElement) {
  const st = useApp.getState();
  const wsId = st.activeWorkspaceId;
  const worktree = st.workspaces.find((w) => w.id === wsId)?.worktreePath;
  if (!wsId || !worktree) return;
  for (const code of root.querySelectorAll<HTMLElement>('code')) {
    if (code.closest('pre, a')) continue; // fenced blocks, already-linked text
    const text = code.textContent?.trim() ?? '';
    if (!PATH_LIKE.test(text) || !/\/|\.\w{1,10}(?::\d+){0,2}$/.test(text)) continue;
    const rel = resolveFileHref(text, worktree);
    if (!rel) continue;
    void statFile(wsId, rel).then((isFile) => {
      if (!isFile || !code.isConnected || code.closest('a')) return;
      const a = document.createElement('a');
      a.setAttribute('href', text);
      a.title = `Open ${rel} in the editor`;
      code.replaceWith(a);
      a.append(code);
    });
  }
}

// No whitespace, quotes, globs or URL schemes (`file://` aside — resolveFileHref
// drops the others). Brackets/parens stay allowed for `app/[id]/page.tsx`.
const PATH_LIKE = /^[^\s`'"<>|*?{},;]{3,260}$/;

/**
 * `fs:stat` results per workspace + path, so the re-hydration a streaming turn
 * runs on every delta is a map lookup rather than an IPC round-trip. Misses
 * expire, so a file the agent creates after mentioning it still links later.
 */
const statCache = new Map<string, Promise<boolean>>();
function statFile(workspaceId: string, path: string): Promise<boolean> {
  const key = `${workspaceId}\n${path}`;
  let hit = statCache.get(key);
  if (!hit) {
    hit = tryInvoke('fs:stat', { workspaceId, path }).then(({ data }) => {
      if (!data) setTimeout(() => statCache.delete(key), 15_000);
      return !!data;
    });
    statCache.set(key, hit);
    if (statCache.size > 2000) statCache.delete(statCache.keys().next().value!);
  }
  return hit;
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
    if (img.dataset.wsState) continue; // filled by an earlier pass
    // Show the cached copy at once (the streaming tail re-creates its elements
    // every delta; a round trip each time would blink them), then swap in the
    // file's current bytes if an agent overwrote it since.
    const shown = cache.get(`${wsId}\n${rel}`)?.url;
    if (shown) apply(img, raw, shown);
    else img.dataset.wsState = 'loading'; // no alt-text flash while the file loads
    void readWorktreeImage(wsId, rel).then((url) => {
      if (url !== shown && img.isConnected) apply(img, raw, url);
    });
  }
}

/**
 * Resolved images, keyed workspace + path, with the file version (mtime + size)
 * each was read at (`url: null` = nothing to show). Capped, least-recently-used
 * out, because these are base64 image payloads: a long session of screenshots
 * shouldn't pin them all in memory.
 */
const cache = new Map<string, { url: string | null; version?: string }>();
const CACHE_MAX = 24;

/**
 * Resolve a worktree image to its current `data:` URL. A cache hit is never
 * trusted blindly — agents overwrite paths like `.context/preview/shot-1.png` in
 * place — so each call hands main the cached version, which answers `unchanged`
 * after one stat (no read) or with the new bytes. Also used by the lightbox and
 * the composer's thumbnails.
 */
export async function readWorktreeImage(workspaceId: string, path: string): Promise<string | null> {
  const key = `${workspaceId}\n${path}`;
  const prev = cache.get(key);
  const { data } = await tryInvoke('attachment:read', { workspaceId, path, ifVersion: prev?.version });
  const read = data?.kind === 'image' && data.dataUrl ? { url: data.dataUrl, version: data.version } : null;
  // Unchanged, or a failed check (host dropped, file deleted): keep what we have
  // rather than downgrade a shown image to a "missing" chip.
  const next = read ?? prev ?? { url: null };
  cache.delete(key); // re-insert → most recently used
  cache.set(key, next);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return next.url;
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
