'use client';
import { useState } from 'react';
import clsx from 'clsx';
import { Check, Loader2, Minus, X } from 'lucide-react';
import { Segmented } from '../primitives';
import type { PanelWorkspace } from './types';

/** Checks tab (web-desktop-parity spec §10.3): Git grid, Pull request, CI checks,
 *  and the Merge section with its 5 gates. */

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-ctl border bg-surface px-2 py-1.5">
      <div className="text-2xs uppercase tracking-wide text-faint">{label}</div>
      <div className="truncate text-xs">{value}</div>
    </div>
  );
}

function CheckIcon({ state }: { state: string }) {
  if (state === 'pass') return <Check size={12} className="shrink-0 text-ok" />;
  if (state === 'fail') return <X size={12} className="shrink-0 text-err" />;
  if (state === 'pending') return <Loader2 size={12} className="spin shrink-0 text-muted" />;
  return <Minus size={12} className="shrink-0 text-muted" />;
}

const GATE_OK = (ok: boolean) => (ok ? 'text-ok' : 'text-muted');

export function ChecksView({
  ws,
  method,
  onMethod,
  onCreatePr,
  onMerge,
  onMergeAnyway,
  onTodoAdd,
  onTodoToggle,
}: {
  ws: PanelWorkspace;
  method: 'squash' | 'merge' | 'rebase';
  onMethod: (m: 'squash' | 'merge' | 'rebase') => void;
  onCreatePr: () => void;
  onMerge: () => void;
  onMergeAnyway: () => void;
  onTodoAdd?: (text: string) => void;
  onTodoToggle?: (id: string, done: boolean) => void;
}) {
  const git = ws.git;
  const todos = ws.todos ?? [];
  const [todoText, setTodoText] = useState('');
  const doneCount = todos.filter((t) => t.done).length;
  const approved = ws.prReview === 'APPROVED' || ws.prReview === null;
  const checksGreen = ws.prChecks === 'pass' || ws.prChecks == null;
  const noConflict = ws.prMergeable !== 'conflict';
  const gatesOpen = !(approved && checksGreen && noConflict);

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      <section>
        <div className="label">Git</div>
        <div className="grid grid-cols-2 gap-1.5">
          <Cell label="Branch" value={ws.branch ?? '—'} />
          <Cell label="vs base" value={git ? `${git.ahead} ahead · ${git.behind} behind` : '—'} />
          <Cell label="Staged" value={String(git?.staged ?? 0)} />
          <Cell label="Unstaged" value={String(git?.unstaged ?? 0)} />
          <Cell label="Untracked" value={String(git?.untracked ?? 0)} />
          <Cell label="Working tree" value={git?.dirty ? `dirty (${git.staged + git.unstaged + git.untracked} files)` : 'clean'} />
        </div>
      </section>

      <section>
        <div className="label">Pull request</div>
        {ws.prState == null ? (
          <div className="space-y-2">
            <div className="text-xs text-muted">No pull request for this branch yet.</div>
            <button className="btn btn-accent" onClick={onCreatePr}>
              Create PR
            </button>
          </div>
        ) : (
          <div className="space-y-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent">{ws.prState}</span>
              <span className="min-w-0 truncate font-medium">
                #{ws.prNumber} {ws.prTitle}
              </span>
            </div>
            <div className="text-2xs text-faint">
              {ws.branch} → {ws.baseBranch} · +{ws.diffAdd} −{ws.diffDel}
              {ws.prReview ? ` · review: ${ws.prReview}` : ''}
            </div>
          </div>
        )}
      </section>

      {ws.prChecksList && ws.prChecksList.length > 0 && (
        <section>
          <div className="label">CI checks</div>
          <div className="space-y-1">
            {ws.prChecksList.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <CheckIcon state={c.state} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.url && (
                  <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 text-2xs text-accent hover:underline">
                    details
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="label">
          Todos ({doneCount}/{todos.length})
        </div>
        <div className="space-y-1">
          {todos.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-xs">
              <input type="checkbox" className="accent-accent" checked={t.done} onChange={() => onTodoToggle?.(t.id, !t.done)} />
              <span className={clsx('min-w-0 flex-1', t.done && 'text-faint line-through')}>{t.text}</span>
            </label>
          ))}
          {onTodoAdd && (
            <input
              className="input mt-1 text-xs"
              placeholder="Add a todo before merge…"
              value={todoText}
              onChange={(e) => setTodoText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && todoText.trim()) {
                  onTodoAdd(todoText.trim());
                  setTodoText('');
                }
              }}
            />
          )}
        </div>
      </section>

      {ws.prState === 'OPEN' && (
        <section>
          <div className="label">Merge</div>
          <div className="space-y-1 text-xs">
            <div className={GATE_OK(approved)}>• {approved ? (ws.prReview === 'APPROVED' ? 'PR approved' : 'No review required') : 'Review required'}</div>
            <div className={GATE_OK(checksGreen)}>• {checksGreen ? 'Checks green' : 'Checks failing'}</div>
            <div className={GATE_OK(noConflict)}>• {noConflict ? 'No merge conflicts' : 'Merge conflicts'}</div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Segmented
              value={method}
              onChange={onMethod}
              options={[
                { value: 'squash', label: 'Squash' },
                { value: 'merge', label: 'Merge' },
                { value: 'rebase', label: 'Rebase' },
              ]}
            />
            <span className="flex-1" />
            {gatesOpen ? (
              <button className="btn" onClick={onMergeAnyway}>
                Merge anyway…
              </button>
            ) : (
              <button className="btn btn-ok" onClick={onMerge}>
                Merge PR
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
