'use client';
import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { MenuDivider, MenuItem } from './primitives';

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
      className="glass-scrim fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="glass glass-panel fade-in flex max-h-[78vh] flex-col overflow-hidden" style={{ width }}>
        {!plain && (
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="text-body font-semibold">{title}</div>
            <button className="btn btn-ghost h-6 w-6 !px-0" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        )}
        <div className={plain ? 'overflow-y-auto p-5' : 'overflow-y-auto px-4 py-4'}>
          {plain && title && <div className="mb-1 text-lg font-semibold tracking-tight">{title}</div>}
          {children}
        </div>
        {footer && (
          <div className={plain ? 'flex items-center justify-end gap-2 px-5 pb-5' : 'flex items-center justify-end gap-2 border-t px-4 py-3'}>
            {footer}
          </div>
        )}
      </div>
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
    <div className="fixed inset-0 z-[90] glass-scrim bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="glass glass-panel fade-in safe-b fixed inset-x-0 bottom-0 z-[91] flex max-h-[85dvh] flex-col rounded-t-[12px]"
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
