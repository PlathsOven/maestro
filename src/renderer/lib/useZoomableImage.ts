import { useCallback, useEffect, useRef, useState } from 'react';

export const IMG_ZOOM_MIN = 0.05;
export const IMG_ZOOM_MAX = 32;
export const IMG_ZOOM_STEP = 1.25; // per button click; the wheel uses a gentler ratio
export const clampImgZoom = (z: number) => Math.min(IMG_ZOOM_MAX, Math.max(IMG_ZOOM_MIN, z));

/**
 * The zoom/fit mechanics shared by the Editor's image tab and the chat lightbox:
 * fit-to-window vs an absolute pixel scale, re-measured against a scroll
 * container as it resizes, plus wheel-zoom and the natural-size read. Snaps back
 * to fit whenever `resetKey` (the image's identity) changes. `wheelModifier`
 * gates wheel zoom behind ⌘/Ctrl so a bare wheel pans the overflow instead — the
 * Editor wants that; the lightbox zooms on a bare wheel.
 *
 * Spread `imgStyle` onto the `<img>` and give it `ref={captureImg}` +
 * `onLoad={onImgLoad}`; the scroll container gets `ref={scrollRef}`.
 */
export function useZoomableImage(
  resetKey: unknown,
  { padding, wheelModifier = false }: { padding: number; wheelModifier?: boolean }
) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // Zoom is `null` for fit-to-window, or an absolute scale of natural px (1 = 100%).
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scale = zoom ?? fitScale;
  const isFit = zoom === null;

  // A fresh image resets to fit; drop stale dims so we don't size against them.
  useEffect(() => {
    setZoom(null);
    setDims(null);
  }, [resetKey]);

  // Fit = the largest scale (never upscaling) that keeps the image inside the
  // container, tracked as it resizes. Mirrors CSS object-contain, but as a number.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !dims) return;
    const measure = () => {
      const availW = el.clientWidth - padding;
      const availH = el.clientHeight - padding;
      if (availW > 0 && availH > 0) setFitScale(Math.min(1, availW / dims.w, availH / dims.h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dims, padding]);

  // Wheel to zoom (native listener so we can preventDefault the page/back-swipe).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (wheelModifier && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom((z) => clampImgZoom((z ?? fitScale) * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fitScale, wheelModifier]);

  // A cached image can finish loading before React attaches onLoad, so also read
  // natural size from the node the moment it's already complete.
  const captureImg = useCallback((el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth) setDims({ w: el.naturalWidth, h: el.naturalHeight });
  }, []);
  const onImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) =>
      setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }),
    []
  );

  const zoomBy = useCallback((factor: number) => setZoom((z) => clampImgZoom((z ?? fitScale) * factor)), [fitScale]);
  /** Fit-to-window ⇆ actual size (100%). */
  const toggleFit = useCallback(() => setZoom((z) => (z === null ? 1 : null)), []);

  // Explicit width/height from the scale so fit and zoom share one path — a CSS
  // max-height can't fit against a growable flex child; object-contain until measured.
  const imgStyle = dims ? { width: dims.w * scale, height: dims.h * scale, maxWidth: 'none' as const } : undefined;

  return { scrollRef, dims, scale, isFit, fitScale, setZoom, zoomBy, toggleFit, captureImg, onImgLoad, imgStyle };
}
