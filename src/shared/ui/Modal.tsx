'use client';
import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { MenuDivider, MenuItem } from './primitives';
import { LiquidGlass } from './LiquidGlass';

/**
 * Centered modal shell (desktop). Moved verbatim from the renderer's common.tsx
 * (web-desktop-parity spec §2.5). On the phone the same interactions render as a
 * bottom `Sheet` (below) — see §4.6.
 */
export function Modal({
  title,
  onClose,
  children,
  width,
  footer,
  plain = false,
  onCmdEnter,
}: {
  title?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  width: number;
  footer?: React.ReactNode;
  /** Conductor-style dialog: big title inside the body, no chrome bar */
  plain?: boolean;
  onCmdEnter?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onCmdEnter) {
        e.preventDefault();
        onCmdEnter();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onCmdEnter]);
  return (
    <div
      data-motion="modal"
      className="glass-scrim fixed inset-0 z-50 flex items-start justify-center bg-black/15 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <LiquidGlass
        ref={ref}
        radius={20}
        bezel={20}
        thickness={80}
        strength={0.5}
        blur={4}
        tint="panel"
        className="flex max-h-[78vh] flex-col overflow-hidden"
        style={{ width }}
      >
        {!plain && (
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <div className="text-[15px] font-semibold tracking-tight">{title}</div>
            <button className="btn btn-ghost h-7 w-7 !px-0 text-muted hover:text-fg" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        )}
        <div className={plain ? 'overflow-y-auto p-6' : 'overflow-y-auto px-5 py-4'}>
          {plain && title && <div className="mb-1 text-lg font-semibold tracking-tight">{title}</div>}
          {children}
        </div>
        {footer && (
          <div className={plain ? 'flex items-center justify-end gap-2 px-6 pb-6' : 'flex items-center justify-end gap-2 px-5 pb-5 pt-2'}>
            {footer}
          </div>
        )}
      </LiquidGlass>
    </div>
  );
}

/**
 * The mobile form of Modal / UpMenu / ContextMenu: a full-width bottom panel
 * (web-desktop-parity §4.6). Slides up, dismisses on scrim tap / swipe-down /
 * Escape. When a desktop interaction opens a Modal, the web opens a Sheet with
 * the same title and body; an UpMenu/ContextMenu becomes an ActionSheet.
 */
export function Sheet({
  title,
  open,
  onClose,
  children,
  footer,
}: {
  title?: React.ReactNode;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const [dragY, setDragY] = useState(0);
  // Match the visible (visual) viewport rect. iOS places a `position: fixed`
  // overlay against the *layout* viewport, so whenever the visual viewport is
  // inset from it — the soft keyboard eating the bottom, or the blank band at
  // the top before Safari's address bar settles — the overlay is painted and
  // hit-tested at different places and a tap lands on the wrong, higher-in-the-
  // list row. Sizing + translating the scrim to the visual viewport keeps paint
  // and hit-testing aligned in every state (a transform moves both together);
  // the panel then sits at the scrim's bottom via flex.
  const [vv, setVv] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    // The sheet has no text input, so drop the soft keyboard if one is up.
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    const view = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!view) return;
    const sync = () => setVv({ x: view.offsetLeft, y: view.offsetTop, w: view.width, h: view.height });
    sync();
    view.addEventListener('resize', sync);
    view.addEventListener('scroll', sync);
    return () => {
      view.removeEventListener('resize', sync);
      view.removeEventListener('scroll', sync);
      setVv(null);
    };
  }, [open]);
  if (!open) return null;

  // Swipe-down-to-dismiss on the grab handle / header.
  const onHandlePointerDown = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const move = (ev: PointerEvent) => setDragY(Math.max(0, ev.clientY - startY));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (ev.clientY - startY > 80) onClose();
      else setDragY(0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      data-motion="sheet"
      className="fixed z-[90] flex flex-col justify-end glass-scrim bg-black/25"
      style={vv ? { top: 0, left: 0, width: vv.w, height: vv.h, transform: `translate(${vv.x}px, ${vv.y}px)` } : { inset: 0 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="glass glass-panel safe-b z-[91] flex max-h-[85%] w-full flex-col rounded-t-[24px]"
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
      >
        <div className="flex shrink-0 cursor-grab touch-none justify-center pt-2 active:cursor-grabbing" onPointerDown={onHandlePointerDown}>
          <span className="h-1 w-9 rounded-full bg-border" />
        </div>
        {title != null && (
          <div className="flex items-center justify-between px-4 py-3 text-body font-semibold" onPointerDown={onHandlePointerDown}>
            <span className="min-w-0 truncate">{title}</span>
            <button className="btn btn-ghost h-6 w-6 !px-0" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export interface ActionSheetItem {
  label: string;
  icon?: React.ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  /** When set, the row is shown disabled with this reason (e.g. "Desktop only"). */
  disabled?: string;
  /** Draw a divider above this item (group separator). */
  divider?: boolean;
}

/** A `Sheet` whose body is a list of MenuItems — the mobile form of an
 *  UpMenu / ContextMenu, same items in the same order (§4.6). */
export function ActionSheet({
  title,
  open,
  onClose,
  items,
}: {
  title?: React.ReactNode;
  open: boolean;
  onClose: () => void;
  items: ActionSheetItem[];
}) {
  return (
    <Sheet title={title} open={open} onClose={onClose}>
      <div className="pb-1">
        {items.map((it, i) => (
          <React.Fragment key={i}>
            {it.divider && <MenuDivider />}
            {it.disabled ? (
              <div className="flex w-full items-center gap-2 px-3 py-2.5 text-body opacity-45">
                {it.icon}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                <span className="shrink-0 text-2xs text-faint">{it.disabled}</span>
              </div>
            ) : (
              <MenuItem
                big
                danger={it.danger}
                onClick={() => {
                  onClose();
                  it.onSelect?.();
                }}
              >
                <span className={clsx('flex w-full items-center gap-2', it.danger && 'text-err')}>
                  {it.icon}
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                </span>
              </MenuItem>
            )}
          </React.Fragment>
        ))}
      </div>
    </Sheet>
  );
}
