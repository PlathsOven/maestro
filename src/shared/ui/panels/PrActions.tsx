'use client';
import clsx from 'clsx';
import { Archive, ExternalLink, FastForward, GitMerge } from 'lucide-react';
import { fmtStat } from '../format';
import type { PanelWorkspace } from './types';

/**
 * The PR strip (web-desktop-parity spec §10.1) — the shared header of the Panel
 * sheet. States + copy match the desktop's RightPanel.PrActions. The web wires
 * each callback to a relay job; `busy` runs from tap until job-done.
 */

function DiffStatBadge({ add, del }: { add: number; del: number }) {
  if (!add && !del) return <span className="text-2xs text-faint">no changes</span>;
  return (
    <span className="font-mono text-2xs">
      {add > 0 && <span className="text-ok">+{fmtStat(add)}</span>}
      {add > 0 && del > 0 && ' '}
      {del > 0 && <span className="text-err">−{fmtStat(del)}</span>}
    </span>
  );
}

const PR_STATE_LABEL: Record<string, { text: string; cls: string }> = {
  MERGED: { text: 'Merged', cls: 'text-st-merged' },
  CLOSED: { text: 'Closed', cls: 'text-err' },
};

export function PrBadge({ ws }: { ws: PanelWorkspace }) {
  const state = ws.prState ?? '';
  const label =
    PR_STATE_LABEL[state]?.text ??
    (ws.prDraft ? 'Draft' : ws.prMergeable === 'conflict' ? 'Conflicts' : ws.prChecks === 'pending' ? 'Checking…' : 'Open');
  const cls =
    PR_STATE_LABEL[state]?.cls ??
    (ws.prDraft ? 'text-muted' : ws.prMergeable === 'conflict' ? 'text-warn' : 'text-ok');
  return (
    <span className="inline-flex items-center gap-1 rounded-ctl border bg-surface px-2 py-1 text-xs">
      {ws.prNumber != null && <span className="font-mono">#{ws.prNumber}</span>}
      {ws.prUrl && (
        <a href={ws.prUrl} target="_blank" rel="noreferrer" className="text-faint hover:text-fg" onClick={(e) => e.stopPropagation()}>
          <ExternalLink size={11} />
        </a>
      )}
      <span className={cls}>{label}</span>
    </span>
  );
}

function toneClass(ws: PanelWorkspace): string {
  if (ws.prState === 'MERGED') return 'pr-tone-merged';
  if (ws.prState === 'CLOSED') return 'pr-tone-closed';
  if (ws.prMergeable === 'conflict') return 'pr-tone-conflict';
  if (ws.prState === 'OPEN' && ws.prChecks !== 'fail') return 'pr-tone-ready';
  return '';
}

export function PrActions({
  ws,
  busy,
  onCreatePr,
  onMerge,
  onResolveConflicts,
  onContinue,
  onArchive,
  onOpenPr,
}: {
  ws: PanelWorkspace;
  busy?: boolean;
  onCreatePr: () => void;
  onMerge: () => void;
  onResolveConflicts: () => void;
  onContinue: () => void;
  onArchive: () => void;
  onOpenPr: () => void;
}) {
  const noChanges = ws.diffAdd + ws.diffDel === 0;
  const state = ws.prState;
  return (
    <div className={clsx('flex items-center gap-2 border-b px-3 py-2', toneClass(ws))}>
      {state == null && (
        <>
          <button className="btn btn-ghost h-7 w-7 !px-0" title="Archive workspace" onClick={onArchive}>
            <Archive size={13} />
          </button>
          <DiffStatBadge add={ws.diffAdd} del={ws.diffDel} />
          <span className="flex-1" />
          <button
            className="btn btn-accent"
            disabled={busy || noChanges}
            title={noChanges ? 'No changes yet — nothing to open a pull request for' : 'Commit all changes & create pull request (⌘⇧P)'}
            onClick={onCreatePr}
          >
            {busy ? 'Creating…' : 'Create PR'}
          </button>
        </>
      )}
      {state === 'OPEN' && (
        <>
          <PrBadge ws={ws} />
          <span className="flex-1" />
          {ws.prMergeable === 'conflict' ? (
            <button className="btn" style={{ color: 'var(--warn)' }} disabled={busy} onClick={onResolveConflicts}>
              Resolve conflicts
            </button>
          ) : (
            <button className="btn btn-ok" disabled={busy} title="Squash & merge this PR" onClick={onMerge}>
              <GitMerge size={12} /> {busy ? 'Merging…' : 'Merge'}
            </button>
          )}
        </>
      )}
      {state === 'MERGED' && (
        <>
          <PrBadge ws={ws} />
          <span className="flex-1" />
          <button className="btn" disabled={busy} onClick={onContinue}>
            <FastForward size={12} /> Continue
          </button>
          <button className="btn btn-merged" disabled={busy} onClick={onArchive}>
            <Archive size={12} /> Archive
          </button>
        </>
      )}
      {state === 'CLOSED' && (
        <>
          <PrBadge ws={ws} />
          <span className="flex-1" />
          <button className="btn btn-accent" disabled={busy} onClick={onArchive}>
            Archive
          </button>
        </>
      )}
      {ws.prUrl && state === 'OPEN' && (
        <button className="btn btn-ghost h-7 w-7 !px-0" title="Open pull request ↗" onClick={onOpenPr}>
          <ExternalLink size={12} />
        </button>
      )}
    </div>
  );
}
