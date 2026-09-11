import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, Circle } from 'lucide-react';
import type { DoctorRow } from '../../shared/types';
import { tryInvoke } from '../lib/api';
import { useApp } from '../store/app';

// Presentational primitives moved to the shared UI package (web-desktop-parity
// spec §2.5) so the renderer and Maestro Web draw identical chrome. Re-exported
// here so existing renderer imports (`./common`) keep working unchanged.
export {
  StatusDot,
  StatusCircle,
  StatusStack,
  SessionStatusDot,
  Spinner,
  ScrollingTitle,
  Segmented,
  EffortBars,
  PickerOption,
  EffortOptions,
  EmptyHint,
  Kbd,
  Toggle,
  MenuItem,
  MenuDivider,
  CountBadge,
} from '../../shared/ui/primitives';
export { Modal, Sheet, ActionSheet } from '../../shared/ui/Modal';

/** Pointer-drag scaffolding: set the body cursor + suppress selection, stream
 *  pointermove to `onMove`, then on pointerup restore, detach, and run `onEnd`.
 *  The size math lives at each call site (px clamp vs flex redistribution). */
export function beginPointerDrag(cursor: string, onMove: (ev: PointerEvent) => void, onEnd?: () => void): void {
  const prevCursor = document.body.style.cursor;
  const prevSelect = document.body.style.userSelect;
  document.body.style.cursor = cursor;
  document.body.style.userSelect = 'none';
  const end = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', end);
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = prevSelect;
    onEnd?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', end);
}

/**
 * A thin drag handle for resizing a panel. Absolutely positioned on a panel
 * edge (the parent must be `relative`; pick the edge with `className`, e.g.
 * `-right-1` / `-left-1` / `-top-1`). Dragging updates the size live via
 * `onResize`, releasing calls `onCommit` (persist), and double-click resets to
 * `resetTo`. The new size is derived from the pointer's displacement since drag
 * start, so it never drifts even as the panel re-renders mid-drag.
 *
 * `invert` flips drag direction — use it when the handle is on the side that
 * grows *away* from the drag (a right panel's left edge, a bottom dock's top
 * edge), so dragging outward enlarges the panel.
 */
export function Resizer({
  axis,
  size,
  min,
  max,
  invert,
  resetTo,
  onResize,
  onCommit,
  className,
}: {
  axis: 'x' | 'y';
  size: number;
  min: number;
  max: number;
  invert?: boolean;
  resetTo: number;
  onResize: (next: number) => void;
  onCommit: () => void;
  className?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startSize = size;
    const dir = invert ? -1 : 1;
    beginPointerDrag(
      axis === 'x' ? 'col-resize' : 'row-resize',
      (ev) => {
        const pos = axis === 'x' ? ev.clientX : ev.clientY;
        onResize(clamp(startSize + (pos - startPos) * dir));
      },
      onCommit
    );
  };
  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        onResize(clamp(resetTo));
        onCommit();
      }}
      className={clsx(
        'group absolute z-20 flex touch-none items-center justify-center',
        axis === 'x' ? 'inset-y-0 w-2 cursor-col-resize' : 'inset-x-0 h-2 cursor-row-resize',
        className
      )}
    >
      <span
        className={clsx(
          'bg-accent opacity-0 transition-opacity group-hover:opacity-100',
          axis === 'x' ? 'h-full w-0.5' : 'h-0.5 w-full'
        )}
      />
    </div>
  );
}

/** Close a popover on outside-click / Escape. Ref goes on the wrapper that holds
 *  both the trigger and the popover, so clicking the trigger doesn't double-toggle. */
export function useDismiss(open: boolean, onClose: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, ref]);
}

/** useDismiss variant that treats the ref's *parent* as "inside", so a toggle
 *  sharing the wrapper doesn't self-dismiss. Active while mounted. */
export function useDismissFromParent(onClose: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, ref]);
}

/** Read up to 10 files (each ≤ 25 MB) as base64 → `onFile(name, b64, kind)`;
 *  `onOversize(name)` fires for files over the cap. */
export function readFilesAsBase64(
  list: File[],
  onFile: (name: string, dataBase64: string, kind: 'image' | 'file') => void,
  onOversize: (name: string) => void
): void {
  for (const file of list.slice(0, 10)) {
    if (file.size > 25 * 1024 * 1024) {
      onOversize(file.name);
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result).split(',')[1] ?? '';
      onFile(file.name, b64, file.type.startsWith('image/') ? 'image' : 'file');
    };
    reader.readAsDataURL(file);
  }
}

/** Drag-and-drop-to-attach wiring: `dropProps` to spread on the zone + a
 *  `dragDepth` (0 = idle) for the overlay. `onFiles` gets the dropped files. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragDepth, setDragDepth] = useState(0);
  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('Files')) setDragDepth((d) => d + 1);
    },
    onDragLeave: () => setDragDepth((d) => Math.max(0, d - 1)),
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragDepth(0);
      onFiles(Array.from(e.dataTransfer.files));
    },
  };
  return { dragDepth, dropProps };
}

/**
 * A right-click context menu anchored at viewport coordinates. Renders a fixed
 * glass panel that dismisses on outside-click / Escape (via `useDismiss`) and is
 * clamped to stay on screen. Fill it with `ContextMenuItem` rows.
 */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const width = 200;
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - 120));
  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left, top, zIndex: 60, width }}
      className="glass overflow-hidden py-1"
      // Keep clicks inside the menu from bubbling to the row underneath (whose
      // onClick would re-select the chat and undo a "Mark as unread").
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

export function ContextMenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className={clsx(
        'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-accent-soft',
        danger ? 'text-err' : ''
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * The right-click "Mark as read / unread" toggle shared by session rows and
 * branch rows — shows the inverse of the current state.
 */
export function ReadUnreadMenu({
  x,
  y,
  unread,
  onRead,
  onUnread,
  onClose,
}: {
  x: number;
  y: number;
  unread: boolean;
  onRead: () => void;
  onUnread: () => void;
  onClose: () => void;
}) {
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      {unread ? (
        <ContextMenuItem onClick={() => { onClose(); onRead(); }}>
          <Check size={14} className="text-muted" /> Mark as read
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onClick={() => { onClose(); onUnread(); }}>
          <Circle size={14} className="fill-st-unread text-st-unread" /> Mark as unread
        </ContextMenuItem>
      )}
    </ContextMenu>
  );
}

/**
 * Delayed hover trigger for a floating detail card. Spread `hoverProps` onto a
 * row and render `<DetailCard rect={rect}>` — the card only appears after
 * `delay`, so a quick pass of the cursor doesn't flash it. `hideHover` cancels
 * it immediately (e.g. when the row enters rename mode).
 */
export function useHoverDetail() {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  useEffect(() => clear, []);
  const hoverProps = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget;
      clear();
      timer.current = setTimeout(() => setRect(el.getBoundingClientRect()), 450);
    },
    onMouseLeave: () => {
      clear();
      setRect(null);
    },
  };
  return {
    rect,
    hoverProps,
    hideHover: () => {
      clear();
      setRect(null);
    },
  };
}

/**
 * A floating, non-interactive info card anchored beside the hovered row's
 * `rect`. Placed to the row's right, flipping to the left and clamping
 * vertically to stay on-screen. Renders nothing until `rect` is set.
 */
export function DetailCard({
  rect,
  children,
}: {
  rect: DOMRect | null;
  children: React.ReactNode;
}) {
  if (!rect) return null;
  const width = 268;
  const m = 8;
  let left = rect.right + m;
  if (left + width > window.innerWidth - m) left = Math.max(m, rect.left - width - m);
  const top = Math.max(m, Math.min(rect.top, window.innerHeight - 220));
  return (
    <div className="glass fade-in pointer-events-none fixed z-50 p-3" style={{ left, top, width }}>
      {children}
    </div>
  );
}

/** Label/value line inside a DetailCard. */
export function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-faint">{label}</span>
      <span className="min-w-0 truncate text-right text-muted">{value}</span>
    </div>
  );
}

/**
 * Inline single-line rename field: autofocuses and selects its text, commits on
 * Enter or blur, cancels on Escape, and swallows pointer events so the row
 * underneath doesn't navigate. commit/cancel fire exactly once.
 */
export function RenameInput({
  initial,
  onCommit,
  onCancel,
  mono,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  mono?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value.trim());
    else onCancel();
  };
  return (
    <input
      ref={ref}
      value={value}
      spellCheck={false}
      className={clsx('input h-6 w-full min-w-0 flex-1 px-1.5 py-0 text-[13px]', mono && 'font-mono')}
      onChange={(e) => setValue(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** Shared API-key row: caller-supplied `label`, optional "Get key ↗" link, a
 *  password input + Save, and an optional `footer` in the same spacing group. */
export function ApiKeyField({
  label,
  url,
  envVar,
  value,
  onChange,
  onSave,
  footer,
}: {
  label: React.ReactNode;
  url?: string | null;
  envVar: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  footer?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        {label}
        {url && (
          <a className="text-2xs text-accent hover:underline" href={url} target="_blank" rel="noreferrer">
            Get key ↗
          </a>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          className="input flex-1 font-mono text-xs"
          placeholder={envVar}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSave()}
        />
        <button className="btn text-xs" onClick={onSave}>
          Save
        </button>
      </div>
      {footer}
    </div>
  );
}

/** Parent-dir state for the project modals: seeded from localStorage, then
 *  backfilled once with the OS default while still empty. */
export function useProjectParentDir(storageKey: string): [string, React.Dispatch<React.SetStateAction<string>>] {
  const [dir, setDir] = useState(localStorage.getItem(storageKey) || '');
  useEffect(() => {
    if (dir) return;
    void tryInvoke('project:defaultParentDir').then((r) => {
      if (r.data) setDir((cur) => cur || r.data!);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [dir, setDir];
}

/** Labelled folder path input with a Browse button, shared by the project modals. */
export function FolderField({
  label,
  value,
  onChange,
  onBrowse,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div>
      <label className="label !normal-case !text-xs !font-medium !text-fg">{label}</label>
      <div className="flex gap-2">
        <input className="input flex-1 font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} />
        <button className="btn h-[30px]" onClick={onBrowse}>
          Browse
        </button>
      </div>
    </div>
  );
}

/** create/clone success tail: toast, close, refresh, then land in new-workspace. */
export async function finishProjectAdd(res: { data?: { id: string; name: string } | null }, verb: string): Promise<void> {
  const app = useApp.getState();
  app.toast('success', `${verb} ${res.data!.name}`);
  app.setModal(null);
  await app.refreshProjects(res.data!.id);
  app.setModal({ kind: 'new-workspace' });
}

/** One diagnostics row (label · value), mirroring HarnessesSettings' `Row`; a
 *  not-ok value (missing tool / not-ready harness / denied RBAC) is tinted warn. */
export function DoctorRowLine({ row }: { row: DoctorRow }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-surface px-3 py-1.5 text-xs">
      <span className="shrink-0 text-muted">{row.label}</span>
      <span className={'break-all text-right font-mono text-2xs ' + (row.ok ? '' : 'text-warn')}>{row.value}</span>
    </div>
  );
}
