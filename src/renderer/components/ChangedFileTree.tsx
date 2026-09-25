import React, { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ChevronRight, Folder } from 'lucide-react';
import { buildChangeTree, type ChangeTreeNode } from '../lib/changeTree';
import type { DiffFile } from '../../shared/types';

/**
 * Changed files as a collapsible folder tree (compact folder chains, folders
 * first), shared by the right panel's Changes tab and the Diff surface's file
 * list. Folders start expanded; `trailing` renders per-file meta on the right
 * (line stats, comment counts).
 */
export default function ChangedFileTree({
  files,
  selected,
  onSelect,
  trailing,
}: {
  files: DiffFile[];
  selected?: string | null;
  onSelect: (f: DiffFile) => void;
  trailing?: (f: DiffFile) => React.ReactNode;
}) {
  const tree = useMemo(() => buildChangeTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (path: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const rows: React.ReactNode[] = [];
  const walk = (nodes: ChangeTreeNode[], depth: number) => {
    for (const n of nodes) {
      const pad = { paddingLeft: depth * 12 + 8 };
      if (n.kind === 'dir') {
        const open = !collapsed.has(n.path);
        rows.push(
          <button
            key={`d:${n.path}`}
            data-motion="row"
            className="flex w-full items-center gap-1.5 rounded-ctl py-1 pr-2.5 text-left text-muted transition-colors hover:bg-accent-soft hover:text-fg"
            style={pad}
            title={n.path}
            onClick={() => toggle(n.path)}
          >
            <ChevronRight size={12} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
            <Folder size={12} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate font-mono text-2xs">{n.name}</span>
          </button>
        );
        if (open) walk(n.children, depth + 1);
      } else {
        rows.push(
          <button
            key={`f:${n.path}`}
            data-motion="row"
            className={clsx(
              'flex w-full items-center gap-1.5 rounded-ctl py-1 pr-2.5 text-left transition-colors',
              selected === n.path ? 'bg-accent-soft text-fg' : 'hover:bg-accent-soft'
            )}
            style={pad}
            title={n.path}
            onClick={() => onSelect(n.file)}
          >
            <StatusGlyph status={n.file.status} />
            <span className="min-w-0 flex-1 truncate font-mono text-2xs">{n.name}</span>
            {trailing?.(n.file)}
          </button>
        );
      }
    }
  };
  walk(tree, 0);
  return <>{rows}</>;
}

const STATUS: Record<DiffFile['status'], [string, string]> = {
  modified: ['M', 'text-warn'],
  added: ['A', 'text-ok'],
  untracked: ['U', 'text-ok'],
  deleted: ['D', 'text-err'],
  renamed: ['R', 'text-st-running'],
  binary: ['B', 'text-muted'],
};

export function StatusGlyph({ status }: { status: DiffFile['status'] }) {
  const [ch, cls] = STATUS[status];
  return <span className={clsx('w-3 shrink-0 text-center font-mono text-2xs font-medium', cls)}>{ch}</span>;
}
