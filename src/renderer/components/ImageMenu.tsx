import { useEffect, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { useApp } from '../store/app';
import { ContextMenu, ContextMenuItem } from './common';

/**
 * Copy an image to the clipboard. Chromium's async clipboard only takes PNG, so
 * anything else (a JPEG screenshot, a WebP, an SVG) is re-encoded through a
 * canvas first.
 */
async function copyImage(src: string) {
  try {
    let blob = await (await fetch(src)).blob();
    if (blob.type !== 'image/png') blob = await toPng(src);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    useApp.getState().toast('success', 'Image copied to clipboard');
  } catch (err) {
    useApp.getState().toast('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Download an image (Electron shows its Save dialog for the anchor's download). */
function saveImage(src: string, name: string) {
  const a = document.createElement('a');
  a.href = src;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function toPng(src: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode PNG'))), 'image/png');
    };
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = src;
  });
}

/** Right-click menu for an image: Copy image · Save image…. Sits above the
 *  lightbox (z-100), which is where most of these open. */
export function ImageContextMenu({
  x,
  y,
  src,
  name,
  onClose,
}: {
  x: number;
  y: number;
  src: string;
  name: string;
  onClose: () => void;
}) {
  return (
    <ContextMenu x={x} y={y} onClose={onClose} zIndex={110}>
      <ContextMenuItem
        onClick={() => {
          onClose();
          void copyImage(src);
        }}
      >
        <Copy size={14} className="text-muted" /> Copy image
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          onClose();
          saveImage(src, name);
        }}
      >
        <Download size={14} className="text-muted" /> Save image…
      </ContextMenuItem>
    </ContextMenu>
  );
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };

/** A download name for an in-memory image: its worktree path's basename, else
 *  its alt text, else "image" — with an extension taken from a data: URL's mime. */
function imageName(img: HTMLImageElement): string {
  const base = img.dataset.wsPath?.split('/').pop() || img.alt.trim() || 'image';
  if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
  const mime = /^data:([^;,]+)/.exec(img.currentSrc)?.[1] ?? 'image/png';
  return `${base}.${EXT[mime] ?? mime.split('/')[1] ?? 'png'}`;
}

/**
 * App-wide "Copy image / Save image…" on right-click for any loaded in-memory
 * image (`data:`/`blob:` src) — the chat's inline screenshots, attachment
 * thumbnails, the lightbox, notebook outputs. Surfaces with their own menu
 * (the editor's image preview) claim the event with preventDefault first.
 */
export function GlobalImageMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; src: string; name: string } | null>(null);
  const lightbox = useApp((s) => s.lightbox);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const img = e.target instanceof HTMLImageElement ? e.target : null;
      if (!img || !img.complete || !img.naturalWidth || !/^(data|blob):/.test(img.currentSrc)) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, src: img.currentSrc, name: imageName(img) });
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);

  // The lightbox swallows Escape (capture phase) to close itself; drop the menu
  // with it rather than leaving it floating over the chat.
  useEffect(() => setMenu(null), [lightbox]);

  if (!menu) return null;
  return <ImageContextMenu {...menu} onClose={() => setMenu(null)} />;
}
