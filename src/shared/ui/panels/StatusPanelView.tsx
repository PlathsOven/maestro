'use client';
import { Sparkles } from 'lucide-react';
import { Segmented } from '../primitives';
import { timeAgo } from '../format';
import type { PanelWorkspace } from './types';

/** Status tab (web-desktop-parity spec §10.5). `scope` uses the desktop's values
 *  ('workspace' is labelled "Branch"). */
export function StatusPanelView({
  ws,
  scope,
  onScope,
  onRegenerate,
  onPutInComposer,
  busy,
}: {
  ws: PanelWorkspace;
  scope: 'session' | 'workspace' | 'project';
  onScope: (s: 'session' | 'workspace' | 'project') => void;
  onRegenerate: () => void;
  onPutInComposer: (text: string) => void;
  busy?: boolean;
}) {
  const d = ws.statusDigest ?? null;
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <Segmented
          value={scope}
          onChange={onScope}
          options={[
            { value: 'session', label: 'Session' },
            { value: 'workspace', label: 'Branch' },
            { value: 'project', label: 'Project' },
          ]}
        />
        <span className="flex-1" />
        <button className="btn btn-ghost h-7 gap-1 px-2.5 text-2xs text-muted" disabled={busy} onClick={onRegenerate}>
          <Sparkles size={12} /> Regenerate status
        </button>
      </div>

      {!d ? (
        <div className="px-1 py-6 text-center text-xs text-muted">{busy ? 'Summarizing with AI…' : 'Nothing here yet'}</div>
      ) : (
        <>
          {(d.workingOn || d.lastActivity || d.goal) && (
            <div className="card space-y-4 p-4">
              {d.workingOn && (
                <section>
                  <div className="label">Working on</div>
                  <div className="text-body">{d.workingOn}</div>
                </section>
              )}
              {d.lastActivity && (
                <section>
                  <div className="label">Last activity</div>
                  <div className="text-body text-muted">{d.lastActivity}</div>
                </section>
              )}
              {d.goal && (
                <section>
                  <div className="label">Goal</div>
                  <div className="text-body text-muted">{d.goal}</div>
                </section>
              )}
            </div>
          )}
          {d.nextUp && d.nextUp.length > 0 && (
            <section className="card p-1.5">
              <div className="label px-2.5 pb-0 pt-1.5">Next up</div>
              <div className="space-y-0.5">
                {d.nextUp.map((n, i) => (
                  <button
                    key={i}
                    className="tap block w-full rounded-ctl px-2.5 py-2 text-left text-body transition-colors hover:bg-accent-soft"
                    title="Put this in the composer"
                    onClick={() => onPutInComposer(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </section>
          )}
          <div className="flex items-center gap-1 px-2 text-2xs text-faint">
            <Sparkles size={10} />
            {d.generatedAt ? timeAgo(d.generatedAt) : ''}
            {d.model ? ` · ${d.model}` : ''}
            {d.stale ? ' · out of date' : ''}
          </div>
        </>
      )}
    </div>
  );
}
