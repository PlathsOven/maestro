'use client';
import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface View {
  scale: number;
  x: number;
  y: number;
}
const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * Full-screen spotlight for an image tapped in Maestro Web's transcript (the
 * desktop has its own ImageLightbox). Pinch to zoom, drag to pan once zoomed,
 * double-tap to toggle zoom; the backdrop, ✕ or Escape close it.
 */
export function ImageSpotlight({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [view, setView] = useState<View>(FIT);
  const [gesturing, setGesturing] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // Gesture baseline, re-taken whenever a finger lands or lifts.
  const start = useRef({ view: FIT, cx: 0, cy: 0, dist: 1, moved: false });
  // Read at pointerdown: pointer capture retargets pointerup to the stage. Starts
  // true so the click trailing the opening tap (which lands here) doesn't close.
  const downOnImage = useRef(true);
  const lastTap = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Centroid and spread of the fingers currently down. */
  const touchState = () => {
    const pts = [...pointers.current.values()];
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 1;
    return { cx, cy, dist };
  };

  /** `from` rescaled so the screen point (cx, cy) stays put. */
  const zoomAt = (from: View, scale: number, cx: number, cy: number): View => {
    const r = stageRef.current!.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2);
    const py = cy - (r.top + r.height / 2);
    const k = scale / from.scale;
    return { scale, x: px - (px - from.x) * k, y: py - (py - from.y) * k };
  };

  /** Snap back to fit, or keep the zoomed image's edges from leaving the screen. */
  const bounded = (v: View): View => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage || v.scale <= 1) return FIT;
    const mx = Math.max(0, (img.offsetWidth * v.scale - stage.clientWidth) / 2);
    const my = Math.max(0, (img.offsetHeight * v.scale - stage.clientHeight) / 2);
    return { scale: v.scale, x: clamp(v.x, -mx, mx), y: clamp(v.y, -my, my) };
  };

  const rebase = (v: View, moved: boolean) => {
    start.current = { view: v, ...touchState(), moved };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    downOnImage.current = e.target === imgRef.current;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    rebase(view, pointers.current.size > 1);
    setGesturing(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = start.current;
    const t = touchState();
    if (Math.hypot(t.cx - s.cx, t.cy - s.cy) > TAP_SLOP) s.moved = true;
    // One finger on an unzoomed image does nothing; otherwise pinch and/or pan.
    if (pointers.current.size < 2 && s.view.scale <= 1) return;
    const scale = clamp((s.view.scale * t.dist) / s.dist, 0.8, MAX_SCALE);
    const z = zoomAt(s.view, scale, s.cx, s.cy);
    setView({ scale, x: z.x + t.cx - s.cx, y: z.y + t.cy - s.cy });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size > 0) return rebase(view, true);
    setGesturing(false);
    if (start.current.moved) return setView(bounded);
    if (!downOnImage.current) return;
    // A tap on the image: the second of two toggles zoom.
    if (e.timeStamp - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      setView(view.scale > 1 ? FIT : bounded(zoomAt(view, DOUBLE_TAP_SCALE, e.clientX, e.clientY)));
    } else {
      lastTap.current = e.timeStamp;
    }
  };

  // A tap off the image closes — on click, not pointerup, or the tap's own click
  // would land on (and reopen) the transcript image beneath.
  const onClick = () => {
    if (!start.current.moved && !downOnImage.current) onClose();
  };

  return (
    <div data-motion="fade" className="fixed inset-0 z-[100] bg-black/95" role="dialog" aria-modal="true" aria-label={alt || 'Image'}>
      <div
        ref={stageRef}
        className="absolute inset-0 flex items-center justify-center overflow-hidden"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: gesturing ? 'none' : 'transform 180ms ease-out',
          }}
        />
      </div>
      <button
        className="absolute right-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/80 ring-1 ring-inset ring-white/15 backdrop-blur-xl transition-colors hover:bg-white/20 hover:text-white"
        style={{ top: 'max(0.5rem, env(safe-area-inset-top))' }}
        aria-label="Close"
        onClick={onClose}
      >
        <X size={20} />
      </button>
    </div>
  );
}
