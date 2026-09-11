import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useApp } from '../store/app';
import { readWorktreeImage } from '../lib/worktreeImages';
import { useZoomableImage, IMG_ZOOM_MIN, IMG_ZOOM_MAX, IMG_ZOOM_STEP } from '../lib/useZoomableImage';
import { Spinner } from './common';

/**
 * Full-screen, zoomable spotlight for the chat's inline images. Opened from the
 * transcript instead of routing a click into the Editor (see worktreeImages.ts):
 * clicking an image seeds the lightbox with every image in that transcript so the
 * ◀/▶ arrows — and ←/→ keys — page between them. Zoom with the wheel, the ±
 * buttons, or a double-click (fit ↔ 100%); drag to pan once zoomed in. Dismisses
 * on the backdrop, the ✕, or Escape.
 *
 * Kept out of the `modal` slot (its own `lightbox` store state) so it overlays
 * whatever is open — including a sub-agent trace whose image was clicked.
 */
export default function ImageLightbox() {
  const lightbox = useApp((s) => s.lightbox);
  const close = useApp((s) => s.closeLightbox);
  const step = useApp((s) => s.stepLightbox);

  const { workspaceId, images, index } = lightbox ?? { workspaceId: '', images: [], index: 0 };
  const current = lightbox ? images[index] : undefined;

  const [load, setLoad] = useState<{ src: string | null; failed: boolean }>({ src: null, failed: false });
  const { scrollRef, dims, scale, isFit, setZoom, zoomBy, toggleFit, fitScale, captureImg, onImgLoad, imgStyle } =
    useZoomableImage(current?.path, { padding: 32 });
  const canPan = !!dims && scale > fitScale + 1e-3;

  // Resolve the current image (shared cache → instant for anything already inline).
  useEffect(() => {
    if (!current) return;
    let alive = true;
    setLoad({ src: null, failed: false });
    void readWorktreeImage(workspaceId, current.path).then((url) => {
      if (alive) setLoad({ src: url, failed: url == null });
    });
    return () => {
      alive = false;
    };
  }, [workspaceId, current]);

  // Prefetch the neighbours so paging is instant (both no-op if already cached).
  useEffect(() => {
    if (!lightbox) return;
    for (const n of [index - 1, index + 1]) {
      if (n >= 0 && n < images.length) void readWorktreeImage(workspaceId, images[n].path);
    }
  }, [lightbox, workspaceId, images, index]);

  // Keyboard: capture-phase + stopImmediatePropagation so Escape/arrows drive the
  // lightbox without also reaching a Modal listening on window beneath it.
  useEffect(() => {
    if (!lightbox) return;
    const actions: Record<string, () => void> = {
      Escape: close,
      ArrowLeft: () => step(-1),
      ArrowRight: () => step(1),
      '0': () => setZoom(null),
      '-': () => zoomBy(1 / IMG_ZOOM_STEP),
      '+': () => zoomBy(IMG_ZOOM_STEP),
      '=': () => zoomBy(IMG_ZOOM_STEP),
    };
    const onKey = (e: KeyboardEvent) => {
      const act = actions[e.key];
      if (!act) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      act();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [lightbox, close, step, setZoom, zoomBy]);

  // Drag-to-pan once zoomed past fit — moves the scroll offset under the pointer.
  const onImgPointerDown = (e: React.PointerEvent) => {
    if (!canPan || e.button !== 0) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = el.scrollLeft;
    const startTop = el.scrollTop;
    const move = (ev: PointerEvent) => {
      el.scrollLeft = startLeft - (ev.clientX - startX);
      el.scrollTop = startTop - (ev.clientY - startY);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!lightbox || !current) return null;

  return (
    <div className="fade-in fixed inset-0 z-[100] flex flex-col bg-black/85 backdrop-blur-sm">
      {/* Top bar: counter · caption · zoom controls · close. */}
      <div className="flex shrink-0 items-center gap-3 px-3 py-2 text-2xs text-white/70">
        {images.length > 1 && (
          <span className="tabular-nums">
            {index + 1} / {images.length}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-center" title={current.alt || current.path}>
          {current.alt || current.path.split('/').pop()}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <LightboxButton title="Zoom out" onClick={() => zoomBy(1 / IMG_ZOOM_STEP)} disabled={scale <= IMG_ZOOM_MIN}>
            <ZoomOut size={15} />
          </LightboxButton>
          <button
            className="h-7 min-w-[3rem] rounded px-2 text-2xs tabular-nums text-white/80 hover:bg-white/10"
            title={isFit ? 'Actual size (100%)' : 'Fit to window'}
            onClick={toggleFit}
          >
            {Math.round(scale * 100)}%
          </button>
          <LightboxButton title="Zoom in" onClick={() => zoomBy(IMG_ZOOM_STEP)} disabled={scale >= IMG_ZOOM_MAX}>
            <ZoomIn size={15} />
          </LightboxButton>
          <LightboxButton title="Close (Esc)" onClick={close}>
            <X size={16} />
          </LightboxButton>
        </div>
      </div>

      {/* Image stage: clicking the empty space closes; the image itself pans/zooms. */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        onDoubleClick={toggleFit}
      >
        <div
          className="flex min-h-full min-w-full items-center justify-center p-4"
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          {load.src ? (
            <img
              ref={captureImg}
              src={load.src}
              alt={current.alt || current.path}
              draggable={false}
              onPointerDown={onImgPointerDown}
              style={imgStyle}
              className={clsx(
                'select-none rounded shadow-2xl',
                !dims && 'max-h-full max-w-full object-contain',
                canPan ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
              )}
              onLoad={onImgLoad}
            />
          ) : load.failed ? (
            <div className="text-sm text-white/60">Couldn’t load {current.path}</div>
          ) : (
            <Spinner />
          )}
        </div>
      </div>

      {/* Prev / next — only when there's more than one image in this transcript. */}
      {index > 0 && (
        <LightboxArrow side="left" title="Previous (←)" onClick={() => step(-1)}>
          <ChevronLeft size={26} />
        </LightboxArrow>
      )}
      {index < images.length - 1 && (
        <LightboxArrow side="right" title="Next (→)" onClick={() => step(1)}>
          <ChevronRight size={26} />
        </LightboxArrow>
      )}
    </div>
  );
}

function LightboxButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className="flex h-7 w-7 items-center justify-center rounded text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function LightboxArrow({
  side,
  title,
  onClick,
  children,
}: {
  side: 'left' | 'right';
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={clsx(
        'absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/80 backdrop-blur transition-colors hover:bg-white/20 hover:text-white',
        side === 'left' ? 'left-4' : 'right-4'
      )}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
