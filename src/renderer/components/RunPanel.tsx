import { useEffect } from 'react';
import clsx from 'clsx';
import { FlaskConical, Pencil, Play, Plus, Sparkles, Square } from 'lucide-react';
import { blankRunDoc, firstCommandLine } from '../../shared/rundoc';
import type { RunScript, Workspace } from '../../shared/types';
import { tryInvoke } from '../lib/api';
import { useApp } from '../store/app';
import { Spinner } from './common';
import { RunTimer } from './RunTimer';

/**
 * The Run tab (right-panel dock): this branch's run/test script cards, one
 * button each to run in the workspace's worktree. Scripts are configured
 * right here (click a card to edit it in the main section) — no repo settings
 * needed. First open auto-detects scripts from the branch's own worktree
 * (Settings → General → "Auto-detect run scripts" toggles this off).
 * ▶ opens the script's own dock terminal tab (a full terminal, exactly like the
 * Terminal tabs): the commands execute first, then the session drops into the
 * user's shell so they can interact with it.
 */
export default function RunPanel({ workspace }: { workspace: Workspace }) {
  const wsId = workspace.id;
  const scope = workspace.wsKind === 'in-place' ? 'folder' : 'branch';
  const scripts = useApp((s) => s.runScripts[wsId]);
  const generating = useApp((s) => s.rsGenerating[wsId] ?? false);
  const genError = useApp((s) => s.rsGenError[wsId]);

  useEffect(() => {
    if (!scripts) void useApp.getState().loadRunScripts(wsId);
  }, [wsId, scripts]);

  // Auto-populate once per workspace: when the tab first opens with no
  // scripts, detect run/test commands with AI. The marker survives restarts
  // so deleting the cards later doesn't resurrect them. Wait out worktree
  // provisioning — detecting against a half-created directory finds nothing
  // (the Run tab is the dock default, so this mounts right at creation).
  useEffect(() => {
    if (workspace.status === 'setting-up') return;
    if (!scripts || scripts.length > 0 || generating) return;
    if (!useApp.getState().settings.autoDetectRunScripts) return;
    const marker = `maestro:rsAuto:${wsId}`;
    if (localStorage.getItem(marker)) return;
    localStorage.setItem(marker, '1');
    void useApp.getState().generateRunScripts(wsId);
  }, [scripts, generating, wsId, workspace.status]);

  const addManual = async () => {
    const { data, error } = await tryInvoke('runscript:add', {
      workspaceId: wsId,
      name: 'New script',
      kind: 'run',
      doc: blankRunDoc(),
    });
    if (error || !data) {
      useApp.getState().toast('error', error ?? 'Could not create script');
      return;
    }
    useApp.getState().setEditingScript(wsId, data.id);
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex shrink-0 items-center gap-1 px-3 pb-1 pt-2">
        <span className="text-2xs font-semibold uppercase tracking-wide text-faint">Run scripts</span>
        {generating && <Spinner className="!h-3 !w-3" />}
        <div className="flex-1" />
        <button
          className="rounded-ctl p-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg disabled:opacity-40"
          title={`Detect run & test scripts for this ${scope} with AI (refreshes AI-created cards)`}
          disabled={generating}
          onClick={() => void useApp.getState().generateRunScripts(wsId)}
        >
          <Sparkles size={13} />
        </button>
        <button
          className="rounded-ctl p-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg"
          title="New script"
          onClick={() => void addManual()}
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-2">
        {!scripts && <div className="px-1 py-2 text-xs text-faint">Loading…</div>}
        {scripts?.length === 0 && generating && (
          <div className="flex items-center gap-2 rounded-card border border-dashed px-3 py-3 text-xs text-muted">
            <Spinner /> Detecting run & test scripts for this {scope}…
          </div>
        )}
        {scripts?.length === 0 && !generating && (
          <div className="rounded-card border border-dashed px-3 py-3 text-center">
            <div className="text-xs text-muted">
              {genError ?? 'Run tests or a development server to try changes in this workspace.'}
            </div>
            <div className="mt-2 flex items-center justify-center gap-2">
              <button className="btn h-6 gap-1.5 text-2xs" disabled={generating} onClick={() => void useApp.getState().generateRunScripts(wsId)}>
                <Sparkles size={11} /> Detect with AI
              </button>
              <button className="btn h-6 gap-1.5 text-2xs" onClick={() => void addManual()}>
                <Plus size={11} /> Add run script
              </button>
            </div>
          </div>
        )}
        {scripts?.map((s) => (
          <ScriptCard key={s.id} workspace={workspace} script={s} />
        ))}
        {scripts && scripts.length > 0 && genError && (
          <div className="truncate px-1 text-2xs text-err" title={genError}>
            {genError}
          </div>
        )}
      </div>
    </div>
  );
}

function ScriptCard({ workspace, script }: { workspace: Workspace; script: RunScript }) {
  const state = useApp((s) => s.runScriptStates[`${workspace.id}:${script.id}`]);
  const running = state?.running ?? false;
  // Whether this card's terminal is the dock tab currently on screen.
  const active = useApp(
    (s) => (s.dockOpen[workspace.id] ?? true) && s.dockTab[workspace.id] === `rs:${script.id}`
  );
  const preview = firstCommandLine(script.doc);
  const Icon = script.kind === 'test' ? FlaskConical : Play;

  return (
    <div
      className={clsx(
        'group flex cursor-pointer items-center gap-2.5 rounded-card border px-3 py-2 transition-colors',
        active ? 'border-accent bg-accent-soft' : 'bg-surface hover:border-accent/50'
      )}
      title="Show this script's terminal"
      onClick={() => useApp.getState().openRunTab(workspace.id, script.id)}
    >
      <Icon size={14} className={clsx('shrink-0', script.kind === 'test' ? 'text-st-review' : 'text-accent')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{script.name}</span>
          <span className="shrink-0 rounded-full border px-1.5 text-2xs text-faint">{script.kind}</span>
          {script.source === 'ai' && (
            <Sparkles size={10} className="shrink-0 text-faint" aria-label="AI-detected" />
          )}
        </div>
        <div className="truncate font-mono text-2xs text-muted">{preview || 'no commands yet — edit to add'}</div>
      </div>
      <ExitBadge workspaceId={workspace.id} scriptId={script.id} />
      <button
        className="shrink-0 rounded p-1 text-faint opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
        title="Edit — see exactly what runs and why, and change it"
        onClick={(e) => {
          e.stopPropagation();
          useApp.getState().setEditingScript(workspace.id, script.id);
        }}
      >
        <Pencil size={12} />
      </button>
      <button
        className={clsx('btn h-6 w-6 shrink-0 !px-0', running ? 'text-err' : 'btn-accent')}
        title={running ? 'Stop (closes the terminal session)' : `Run in a terminal here (WORKSPACE_PORT=${workspace.port})`}
        disabled={!running && !preview}
        onClick={(e) => {
          e.stopPropagation();
          if (running) useApp.getState().stopRunScript(workspace.id, script.id);
          else void useApp.getState().execRunScript(workspace.id, script.id);
        }}
      >
        {running ? <Square size={10} fill="currentColor" /> : <Play size={11} />}
      </button>
    </div>
  );
}

function ExitBadge({ workspaceId, scriptId }: { workspaceId: string; scriptId: string }) {
  const state = useApp((s) => s.runScriptStates[`${workspaceId}:${scriptId}`]);
  if (!state) return null;
  if (state.running) return <RunTimer startedAt={state.startedAt} />;
  if (state.exitCode === null) return null;
  if (state.exitCode === 0) return <span className="dot dot-idle shrink-0 !bg-ok" title="last run: ok" />;
  return (
    <span className="shrink-0 rounded-full bg-err/15 px-1.5 text-2xs text-err" title="last run failed">
      {state.exitCode === -1 ? 'stopped' : `exit ${state.exitCode}`}
    </span>
  );
}
