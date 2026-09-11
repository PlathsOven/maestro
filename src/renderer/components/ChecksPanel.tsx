import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  CircleDashed,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  MinusCircle,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
  XCircle,
} from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { EMPTY_ARR, useApp } from '../store/app';
import { mergeabilityUnknown, mergeFailureMessage, noConflictsGate } from '../lib/resolveConflicts';
import { Spinner } from './common';
import type { MergeGates, PrCheck, PrStatus, Workspace } from '../../shared/types';

export default function ChecksPanel({ workspace, active }: { workspace: Workspace; active: boolean }) {
  const gitStatus = useApp((s) => s.gitStatus[workspace.id]);
  const pr = useApp((s) => s.prStatus[workspace.id]);
  const creatingPr = useApp((s) => s.creatingPr[workspace.id] ?? false);
  const comments = useApp((s) => s.comments[workspace.id]) ?? EMPTY_ARR;
  const todos = useApp((s) => s.todos[workspace.id]) ?? EMPTY_ARR;
  const wsVersion = useApp((s) => s.wsVersion[workspace.id] ?? 0);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [method, setMethod] = useState<'squash' | 'merge' | 'rebase'>('squash');
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const refresh = async (force = false) => {
    setLoading(true);
    await Promise.all([
      useApp.getState().refreshGit(workspace.id),
      useApp.getState().refreshPr(workspace.id, force),
      useApp.getState().refreshComments(workspace.id),
      useApp.getState().refreshTodos(workspace.id),
    ]);
    setLoading(false);
  };

  useEffect(() => {
    if (!active) return;
    void refresh();
    pollRef.current = setInterval(() => void refresh(true), 30_000);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspace.id]);

  useEffect(() => {
    if (active) void useApp.getState().refreshGit(workspace.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsVersion]);

  const unresolved = comments.filter((c) => !c.resolved);
  const pendingTodos = todos.filter((t) => !t.done);
  const checksGreen =
    !!pr && pr.checks.length > 0
      ? pr.checks.every((c) => c.state === 'pass' || c.state === 'skipped' || c.state === 'neutral')
      : !!pr; // no checks configured counts as green
  const gates: MergeGates = {
    approved: !!pr && (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === null),
    checksGreen,
    commentsResolved: unresolved.length === 0,
    todosDone: pendingTodos.length === 0,
    noConflicts: noConflictsGate(pr?.mergeable),
  };
  const checkingConflicts = mergeabilityUnknown(pr?.mergeable);
  const allGreen = pr?.state === 'OPEN' && Object.values(gates).every(Boolean);

  const merge = async () => {
    if (!pr) return;
    setMerging(true);
    const res = await tryInvoke('github:prMerge', { workspaceId: workspace.id, method });
    setMerging(false);
    if (res.error || !res.data?.ok) {
      useApp.getState().toast('error', mergeFailureMessage(res.error ?? res.data?.error, pr.baseRefName));
      // A refusal is usually news to our cached mergeability — re-ask, so the
      // panel flips to the conflict banner instead of still offering Merge.
      void refresh(true);
      return;
    }
    useApp.getState().toast('success', `PR #${pr.number} merged`);
    await refresh(true);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Checks</h2>
          <button className="btn btn-ghost h-6 px-1.5" onClick={() => void refresh(true)}>
            {loading ? <Spinner /> : <RefreshCw size={12} className="text-muted" />}
          </button>
        </div>

        {/* git status */}
        <section className="card p-3.5">
          <div className="mb-2 text-xs font-semibold text-muted">Git</div>
          {gitStatus ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
              <Row label="Branch" value={<code className="font-mono">{gitStatus.branch}</code>} />
              <Row
                label="vs base"
                value={
                  <span>
                    <span className={gitStatus.ahead ? 'text-ok' : ''}>{gitStatus.ahead} ahead</span>
                    {' · '}
                    <span className={gitStatus.behind ? 'text-warn' : ''}>{gitStatus.behind} behind</span>
                  </span>
                }
              />
              <Row label="Staged" value={String(gitStatus.staged)} />
              <Row label="Unstaged" value={String(gitStatus.unstaged)} />
              <Row label="Untracked" value={String(gitStatus.untracked)} />
              <Row
                label="Working tree"
                value={
                  gitStatus.dirty ? <span className="text-warn">dirty ({gitStatus.changedFiles} files)</span> : <span className="text-ok">clean</span>
                }
              />
            </div>
          ) : (
            <Spinner />
          )}
        </section>

        {/* PR */}
        <section className="card p-3.5">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted">
            <GitPullRequest size={13} /> Pull request
          </div>
          {pr === undefined && <Spinner />}
          {pr === null && (
            <div className="flex items-center justify-between text-xs text-muted">
              <span>No pull request for this branch yet.</span>
              <button
                className="btn btn-accent h-6 gap-1.5 text-2xs"
                disabled={creatingPr}
                onClick={() => void useApp.getState().createPr(workspace.id)}
              >
                {creatingPr && <Spinner className="!text-white" />}
                {creatingPr ? 'Creating…' : 'Create PR'}
              </button>
            </div>
          )}
          {pr && (
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <span
                  className={clsx(
                    'mt-px rounded-full px-2 py-px text-2xs font-semibold',
                    pr.state === 'OPEN' && 'bg-ok/15 text-ok',
                    pr.state === 'MERGED' && 'bg-st-merged-soft text-st-merged',
                    pr.state === 'CLOSED' && 'bg-err/15 text-err'
                  )}
                >
                  {pr.isDraft ? 'DRAFT' : pr.state}
                </span>
                <div className="min-w-0 flex-1">
                  <a href={pr.url} target="_blank" rel="noreferrer" className="text-[13px] font-medium hover:text-accent">
                    #{pr.number} {pr.title} <ExternalLink size={11} className="inline text-faint" />
                  </a>
                  <div className="text-2xs text-faint">
                    {pr.headRefName} → {pr.baseRefName} · <span className="text-ok">+{pr.additions}</span>{' '}
                    <span className="text-err">−{pr.deletions}</span>
                    {pr.reviewDecision && <> · review: {pr.reviewDecision.toLowerCase().replace(/_/g, ' ')}</>}
                  </div>
                </div>
              </div>

              {/* CI checks */}
              <div>
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-faint">CI checks</div>
                {pr.checks.length === 0 && <div className="text-xs text-faint">No checks reported.</div>}
                <div className="space-y-0.5">
                  {pr.checks.map((c, i) => (
                    <CheckRow key={i} check={c} />
                  ))}
                </div>
              </div>

              {/* deployments */}
              {pr.deployments.length > 0 && (
                <div>
                  <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-faint">Deployments</div>
                  {pr.deployments.map((d, i) => (
                    <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
                      <Rocket size={12} className={d.state === 'success' ? 'text-ok' : 'text-muted'} />
                      <span>{d.environment}</span>
                      <span className={clsx('text-2xs', d.state === 'success' ? 'text-ok' : 'text-muted')}>{d.state}</span>
                      {d.url && (
                        <a className="text-2xs text-accent" href={d.url} target="_blank" rel="noreferrer">
                          open <ArrowUpRight size={10} className="inline" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* PR comments */}
              {pr.comments.length > 0 && (
                <div>
                  <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-faint">PR comments</div>
                  <div className="space-y-1.5">
                    {pr.comments.slice(-5).map((c, i) => (
                      <div key={i} className="rounded-ctl border bg-bg px-2.5 py-1.5 text-xs">
                        <div className="mb-0.5 flex items-center gap-1 text-2xs text-faint">
                          <MessageSquare size={10} /> @{c.author}
                        </div>
                        <div className="line-clamp-3 whitespace-pre-wrap">{c.body}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* todos */}
        <TodoSection workspace={workspace} />

        {/* merge gate */}
        {pr && pr.state === 'OPEN' && (
          <section className="card p-3.5">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted">
              <GitMerge size={13} /> Merge
            </div>
            {pr.mergeable === 'CONFLICTING' && <ConflictBanner workspace={workspace} pr={pr} />}
            <div className="mb-3 space-y-1">
              <Gate ok={gates.approved} label={pr.reviewDecision === null ? 'No review required' : 'PR approved'} />
              <Gate ok={gates.checksGreen} label="Checks green" />
              <Gate ok={gates.commentsResolved} label={`Diff comments resolved (${unresolved.length} open)`} />
              <Gate ok={gates.todosDone} label={`Todos complete (${pendingTodos.length} open)`} />
              <Gate
                ok={gates.noConflicts}
                pending={checkingConflicts}
                label={checkingConflicts ? 'Checking for merge conflicts…' : 'No merge conflicts'}
              />
            </div>
            <div className="flex items-center gap-2">
              <select className="input h-7 w-32 py-0 text-xs" value={method} onChange={(e) => setMethod(e.target.value as never)}>
                <option value="squash">Squash</option>
                <option value="merge">Merge</option>
                <option value="rebase">Rebase</option>
              </select>
              <button className="btn btn-accent h-7" disabled={!allGreen || merging} onClick={() => void merge()}>
                {merging ? <Spinner className="!text-white" /> : <GitMerge size={13} />}
                Merge PR
              </button>
              {!allGreen && (
                <button
                  className="btn h-7 text-2xs text-muted"
                  disabled={merging}
                  title="Merge even though gates are not all green"
                  onClick={() =>
                    useApp.getState().setModal({
                      kind: 'confirm',
                      title: 'Merge with open gates?',
                      body: 'Some merge gates are not green (approval, checks, comments, or todos). Merge anyway?',
                      confirmLabel: 'Merge anyway',
                      danger: true,
                      onConfirm: () => void merge(),
                    })
                  }
                >
                  Merge anyway…
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function CheckRow({ check }: { check: PrCheck }) {
  const icon =
    check.state === 'pass' ? (
      <CheckCircle2 size={13} className="text-ok" />
    ) : check.state === 'fail' ? (
      <XCircle size={13} className="text-err" />
    ) : check.state === 'pending' ? (
      <CircleDashed size={13} className="spin text-warn" />
    ) : (
      <MinusCircle size={13} className="text-faint" />
    );
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      {icon}
      <span className="min-w-0 flex-1 truncate">{check.name}</span>
      {check.description && <span className="truncate text-2xs text-faint">{check.description}</span>}
      {check.link && (
        <a className="shrink-0 text-2xs text-accent" href={check.link} target="_blank" rel="noreferrer">
          details
        </a>
      )}
    </div>
  );
}

/**
 * Warn banner shown above the merge gate when GitHub reports conflicts — the
 * Checks-tab entry point for Resolve-conflicts mode (spec §4.1). Same dispatch as
 * the right-panel strip; the shell fallback keeps today's GitHub link. Uses the
 * color-mix warn wash (opacity-modifier tints on the hex `--warn` var don't
 * render — see the .pr-tone-conflict recipe in styles.css).
 */
function ConflictBanner({ workspace, pr }: { workspace: Workspace; pr: PrStatus }) {
  const resolving = useApp((s) => !!s.resolvingPr[workspace.id]);
  const base = pr.baseRefName || 'the base branch';
  const btnCls = 'btn h-6 shrink-0 gap-1.5 px-2 text-2xs border-warn/50 text-warn hover:bg-warn/10';
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-ctl border px-3 py-2 text-xs text-warn"
      style={{
        background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
        borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)',
      }}
    >
      <AlertTriangle size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        This PR has merge conflicts with <code className="font-mono">{base}</code> and can't be merged.
      </span>
      {workspace.harness === 'shell' ? (
        <a className={btnCls} href={pr.url} target="_blank" rel="noreferrer">
          <GitMerge size={11} /> Resolve conflicts
        </a>
      ) : (
        <button
          className={btnCls}
          disabled={resolving}
          onClick={() => void useApp.getState().startConflictResolution(workspace.id)}
        >
          {resolving ? <Spinner /> : <GitMerge size={11} />}
          {resolving ? 'Resolving…' : 'Resolve conflicts'}
        </button>
      )}
    </div>
  );
}

/** `pending` is the third state: not a failed gate, just no answer yet. */
function Gate({ ok, label, pending }: { ok: boolean; label: string; pending?: boolean }) {
  const icon = pending ? (
    <CircleDashed size={13} className="spin text-warn" />
  ) : ok ? (
    <CheckCircle2 size={13} className="text-ok" />
  ) : (
    <Circle size={13} className="text-faint" />
  );
  return (
    <div className="flex items-center gap-2 text-xs">
      {icon}
      <span className={ok && !pending ? '' : 'text-muted'}>{label}</span>
    </div>
  );
}

export function TodoSection({ workspace, compact }: { workspace: Workspace; compact?: boolean }) {
  const todos = useApp((s) => s.todos[workspace.id]) ?? EMPTY_ARR;
  const [text, setText] = useState('');

  const add = async () => {
    if (!text.trim()) return;
    await tryInvoke('todo:add', { workspaceId: workspace.id, text: text.trim() });
    setText('');
    void useApp.getState().refreshTodos(workspace.id);
  };

  return (
    <section className={compact ? '' : 'card p-3.5'}>
      <div className="mb-2 text-xs font-semibold text-muted">
        Todos{' '}
        <span className="font-normal text-faint">
          ({todos.filter((t) => t.done).length}/{todos.length})
        </span>
      </div>
      <div className="space-y-1">
        {todos.map((t) => (
          <div key={t.id} className="group flex items-center gap-2 text-xs">
            <button
              onClick={async () => {
                await tryInvoke('todo:toggle', { todoId: t.id, done: !t.done });
                void useApp.getState().refreshTodos(workspace.id);
              }}
            >
              {t.done ? <CheckCircle2 size={13} className="text-ok" /> : <Circle size={13} className="text-faint hover:text-muted" />}
            </button>
            <span className={clsx('min-w-0 flex-1', t.done && 'text-faint line-through')}>{t.text}</span>
            <button
              className="hidden text-faint hover:text-err group-hover:block"
              onClick={async () => {
                await tryInvoke('todo:delete', { todoId: t.id });
                void useApp.getState().refreshTodos(workspace.id);
              }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          className="input h-6 flex-1 text-xs"
          placeholder="Add a todo before merge…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button className="btn h-6 px-1.5" onClick={() => void add()} disabled={!text.trim()}>
          <Plus size={12} />
        </button>
      </div>
    </section>
  );
}
