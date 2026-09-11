import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowUpRight, MapPin, PenLine, Send, Square, Trash2, X } from 'lucide-react';
import { useApp, type AnnotateState } from '../store/app';
import { annotationBody, boxFromPoints, hitTest, markPoint, type Pt } from '../lib/annotate';
import type { AnnotationItem } from '../../shared/types';

type Tool = AnnotationItem['kind'];

/**
 * Annotation mode (§9): the live view is frozen (a screenshot swap, done in the
 * store) and the user draws box/arrow/pin/pen marks on this ordinary-DOM overlay —
 * no z-order fight, because the frame can't repaint under the pen. Each mark is
 * hit-tested against the captured layout index and carries its matched selector;
 * "Send" composites everything into one PNG and stages it in the composer.
 */
export default function AnnotateOverlay() {
  const a = useApp((s) => s.annotate);
  if (!a) return null;
  return <Overlay a={a} />;
}

function Overlay({ a }: { a: AnnotateState }) {
  const [tool, setTool] = useState<Tool>('box');
  const [draft, setDraft] = useState<AnnotationItem | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const accent = useAccent();
  const items = a.items;
  const setItems = (next: AnnotationItem[]) => useApp.getState().setAnnotateItems(next);

  // Escape cancels; ⌘↵ sends.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        useApp.getState().cancelAnnotate();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Redraw committed marks + the in-progress draft onto the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(a.cssW * dpr);
    canvas.height = Math.round(a.cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, a.cssW, a.cssH);
    drawMarks(ctx, draft ? [...items, draft] : items, accent);
  }, [items, draft, a.cssW, a.cssH, accent]);

  const ptFromEvent = (e: React.PointerEvent): Pt => {
    const r = layerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const commit = (mark: AnnotationItem) => {
    const el = hitTest(mark, a.elements);
    const withMatch: AnnotationItem = el ? { ...mark, selector: el.selector, matchText: el.text || undefined } : mark;
    setItems([...items, withMatch]);
    setNoteFor(withMatch.id);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = ptFromEvent(e);
    const id = 'm' + ++idRef.current;
    if (tool === 'pin') {
      commit({ id, kind: 'pin', points: [p] });
      return;
    }
    setDraft({ id, kind: tool, points: tool === 'pen' ? [p] : [p, p] });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draft) return;
    const p = ptFromEvent(e);
    setDraft((d) =>
      !d ? d : d.kind === 'pen' ? { ...d, points: [...d.points, p] } : { ...d, points: [d.points[0], p] }
    );
  };

  const onPointerUp = () => {
    if (!draft) return;
    const d = draft;
    setDraft(null);
    // Discard trivial drags (a click that didn't move) except pins.
    if (d.kind === 'box' || d.kind === 'arrow') {
      const b = boxFromPoints(d.points[0], d.points[1]);
      if (b.width < 5 && b.height < 5) return;
    }
    if (d.kind === 'pen' && d.points.length < 2) return;
    commit(d);
  };

  const updateItem = (id: string, patch: Partial<AnnotationItem>) =>
    setItems(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  const removeItem = (id: string) => {
    setItems(items.filter((it) => it.id !== id));
    if (noteFor === id) setNoteFor(null);
  };

  const send = async () => {
    if (!items.length) return;
    const base64 = await composite(a, accent);
    const body = annotationBody(items, a.url, a.cssW, a.cssH);
    await useApp.getState().sendAnnotations(a.wsId, a.agentId, base64, body, items.length);
  };

  const TOOLS: { id: Tool; icon: React.ReactNode; label: string }[] = [
    { id: 'box', icon: <Square size={13} />, label: 'Box' },
    { id: 'arrow', icon: <ArrowUpRight size={13} />, label: 'Arrow' },
    { id: 'pin', icon: <MapPin size={13} />, label: 'Pin' },
    { id: 'pen', icon: <PenLine size={13} />, label: 'Pen' },
  ];

  return (
    <div className="absolute inset-0 z-30 overflow-auto bg-bg">
      <div className="relative mx-auto" style={{ width: a.cssW, height: a.cssH }}>
        <img src={a.shot.dataUrl} width={a.cssW} height={a.cssH} className="block select-none" draggable={false} alt="" />
        <canvas ref={canvasRef} style={{ width: a.cssW, height: a.cssH }} className="pointer-events-none absolute inset-0" />
        <div
          ref={layerRef}
          className={clsx('absolute inset-0', tool === 'pin' ? 'cursor-pointer' : 'cursor-crosshair')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        {/* numbered badges + note popovers */}
        {items.map((it, i) => {
          const anchor = markPoint(it) ?? { x: 0, y: 0 };
          return (
            <div key={it.id} className="absolute" style={{ left: anchor.x, top: anchor.y }}>
              <button
                className="absolute flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-accent px-1 text-2xs font-bold text-white shadow"
                title="Edit note"
                onClick={() => setNoteFor((n) => (n === it.id ? null : it.id))}
              >
                {i + 1}
              </button>
              {noteFor === it.id && (
                <NotePopover
                  item={it}
                  onNote={(note) => updateItem(it.id, { note })}
                  onClearMatch={() => updateItem(it.id, { selector: null, matchText: undefined })}
                  onDelete={() => removeItem(it.id)}
                  onClose={() => setNoteFor(null)}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* floating tool + action bar */}
      <div className="glass fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 p-1">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={clsx(
              'flex items-center gap-1 rounded-ctl px-2 py-1 text-xs font-medium transition-colors',
              tool === t.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
            )}
            title={t.label}
            onClick={() => setTool(t.id)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
        <div className="mx-1 h-5 w-px bg-border" />
        <span className="px-1 text-2xs text-faint">{items.length} mark{items.length === 1 ? '' : 's'}</span>
        <button className="btn btn-ghost h-7 px-2 text-xs" onClick={() => useApp.getState().cancelAnnotate()}>
          Cancel
        </button>
        <button className="btn btn-accent h-7 gap-1.5 px-2.5 text-xs disabled:opacity-40" disabled={!items.length} onClick={() => void send()}>
          <Send size={12} /> Send to agent
        </button>
      </div>
    </div>
  );
}

function NotePopover({
  item,
  onNote,
  onClearMatch,
  onDelete,
  onClose,
}: {
  item: AnnotationItem;
  onNote: (note: string) => void;
  onClearMatch: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="glass absolute left-3 top-3 z-50 w-64 p-2.5" onPointerDown={(e) => e.stopPropagation()}>
      {item.selector ? (
        <button
          className="mb-2 flex max-w-full items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-2xs text-accent"
          title={`Matched ${item.selector} — click to clear a wrong match`}
          onClick={onClearMatch}
        >
          <span className="truncate font-mono">{item.matchText ? `"${item.matchText}"` : item.selector}</span>
          <X size={10} className="shrink-0" />
        </button>
      ) : (
        <div className="mb-2 text-2xs text-faint">No element matched — coordinates travel in the prompt.</div>
      )}
      <textarea
        ref={ref}
        className="input min-h-[52px] w-full resize-none text-xs"
        placeholder="Note (optional) — e.g. make this green"
        defaultValue={item.note ?? ''}
        onChange={(e) => onNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="mt-1.5 flex items-center justify-between">
        <button className="flex items-center gap-1 text-2xs text-faint hover:text-err" onClick={onDelete}>
          <Trash2 size={11} /> Delete
        </button>
        <button className="btn btn-ghost h-5 px-1.5 text-2xs" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

function useAccent(): string {
  const [c, setC] = useState('#d2691e');
  useEffect(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (v) setC(v);
  }, []);
  return c;
}

// ---------- drawing (shared by the on-screen canvas and the export composite) ----------

function drawMarks(ctx: CanvasRenderingContext2D, items: AnnotationItem[], accent: string, badges = true) {
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  items.forEach((it, i) => {
    ctx.strokeStyle = accent;
    if (it.kind === 'box' && it.points.length >= 2) {
      const b = boxFromPoints(it.points[0], it.points[1]);
      ctx.strokeRect(b.x, b.y, b.width, b.height);
    } else if (it.kind === 'arrow' && it.points.length >= 2) {
      drawArrow(ctx, it.points[0], it.points[1]);
    } else if (it.kind === 'pin') {
      drawPin(ctx, it.points[0], accent);
    } else if (it.kind === 'pen' && it.points.length) {
      ctx.beginPath();
      ctx.moveTo(it.points[0].x, it.points[0].y);
      for (const p of it.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    if (badges) {
      const anchor = markPoint(it) ?? { x: 0, y: 0 };
      drawBadge(ctx, anchor, i + 1, accent);
    }
  });
}

function drawArrow(ctx: CanvasRenderingContext2D, p0: Pt, p1: Pt) {
  const head = 9;
  const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p1.x - head * Math.cos(ang - Math.PI / 6), p1.y - head * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(p1.x - head * Math.cos(ang + Math.PI / 6), p1.y - head * Math.sin(ang + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawPin(ctx: CanvasRenderingContext2D, p: Pt, accent: string) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}

function drawBadge(ctx: CanvasRenderingContext2D, p: Pt, n: number, accent: string) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), p.x, p.y + 0.5);
}

/** Composite the frozen screenshot + all marks into a PNG at `dpr`, returning the
 *  base64 body (§9.3). */
async function composite(a: AnnotateState, accent: string): Promise<string> {
  const dpr = a.shot.dpr || 1;
  const W = Math.round(a.cssW * dpr);
  const H = Math.round(a.cssH * dpr);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = await loadImage(a.shot.dataUrl);
  ctx.drawImage(img, 0, 0, W, H);
  ctx.scale(dpr, dpr); // marks are in CSS px
  drawMarks(ctx, a.items, accent);
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
