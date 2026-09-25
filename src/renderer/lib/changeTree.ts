import type { DiffFile } from '../../shared/types';

export type ChangeTreeNode =
  | { kind: 'dir'; name: string; path: string; children: ChangeTreeNode[] }
  | { kind: 'file'; name: string; path: string; file: DiffFile };

type Dir = Extract<ChangeTreeNode, { kind: 'dir' }>;

/**
 * Fold a flat list of changed files into a folder tree. Single-child folder
 * chains are compacted into one row (`src/renderer/components`), like VS Code's
 * compact folders, so deep paths don't waste indentation. Folders sort before
 * files, each case-insensitively by name.
 */
export function buildChangeTree(files: DiffFile[]): ChangeTreeNode[] {
  const root: Dir = { kind: 'dir', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let cur = root;
    const name = parts.pop() ?? file.path;
    for (const part of parts) {
      let next = cur.children.find((c): c is Dir => c.kind === 'dir' && c.name === part);
      if (!next) {
        next = { kind: 'dir', name: part, path: cur.path ? `${cur.path}/${part}` : part, children: [] };
        cur.children.push(next);
      }
      cur = next;
    }
    cur.children.push({ kind: 'file', name, path: file.path, file });
  }
  return finish(root.children);
}

function finish(nodes: ChangeTreeNode[]): ChangeTreeNode[] {
  const out = nodes.map((n) => {
    if (n.kind !== 'dir') return n;
    let d = n;
    // Merge a folder whose only child is another folder into one row.
    while (d.children.length === 1 && d.children[0].kind === 'dir') {
      const only: Dir = d.children[0];
      d = { kind: 'dir', name: `${d.name}/${only.name}`, path: only.path, children: only.children };
    }
    return { ...d, children: finish(d.children) };
  });
  return out.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}
