'use client';
import clsx from 'clsx';
import { FlaskConical, Play, Square } from 'lucide-react';
import type { PanelWorkspace, PanelRunScript } from './types';

/** Run tab (web-desktop-parity spec §10.5). The terminal output is Desktop only;
 *  the phone shows the state badge and a run/stop control per script. */
function ExitBadge({ s }: { s: PanelRunScript }) {
  if (s.state === 'ok') return <span className="text-2xs text-ok">last run: ok</span>;
  if (s.state === 'exit') return <span className="text-2xs text-err">exit {s.exitCode ?? '?'}</span>;
  if (s.state === 'stopped') return <span className="text-2xs text-muted">stopped</span>;
  return null;
}

export function RunView({
  ws,
  onRun,
  onStop,
  port,
}: {
  ws: PanelWorkspace;
  onRun: (scriptId: string) => void;
  onStop: (scriptId: string) => void;
  port?: number | null;
}) {
  const scripts = ws.runScripts ?? [];
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
      <div className="label px-1">Run scripts</div>
      {scripts.length === 0 ? (
        <div className="space-y-2">
          <div className="text-xs text-muted">Run tests or a development server to try changes in this workspace.</div>
          <div className="flex gap-2">
            <span className="btn opacity-45">Detect with AI <span className="ml-1 text-2xs text-faint">Desktop only</span></span>
            <span className="btn opacity-45">Add run script <span className="ml-1 text-2xs text-faint">Desktop only</span></span>
          </div>
        </div>
      ) : (
        scripts.map((s) => {
          const running = s.state === 'running';
          return (
            <div key={s.id} className="rounded-card border bg-raised px-3 py-2.5">
              <div className="flex items-center gap-2">
                {s.kind === 'test' ? <FlaskConical size={12} className="text-faint" /> : <Play size={12} className="text-faint" />}
                <span className="text-xs font-medium">{s.name}</span>
                <span className={clsx('rounded-full bg-accent-soft px-1.5 py-px text-[10px]', s.kind === 'test' ? 'text-fg' : 'text-muted')}>
                  {s.kind}
                </span>
                <span className="flex-1" />
                <ExitBadge s={s} />
                <button
                  className={clsx('btn h-7 w-7 !px-0', running ? 'btn-ghost' : 'btn-accent')}
                  title={running ? 'Stop' : `Run in a terminal here (WORKSPACE_PORT=${port ?? '—'})`}
                  onClick={() => (running ? onStop(s.id) : onRun(s.id))}
                >
                  {running ? <Square size={11} className="text-err" /> : <Play size={11} className="fill-current" />}
                </button>
              </div>
              <div className="mt-1.5 truncate font-mono text-2xs text-faint">{s.command}</div>
            </div>
          );
        })
      )}
    </div>
  );
}
