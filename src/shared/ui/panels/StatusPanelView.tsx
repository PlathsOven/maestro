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
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
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
        <button className="btn btn-ghost h-6 gap-1 px-1.5 text-2xs" disabled={busy} onClick={onRegenerate}>
          <Sparkles size={12} /> Regenerate status
        </button>
      </div>

      {!d ? (
        <div className="px-1 py-4 text-xs text-muted">{busy ? 'Summarizing with AI…' : 'Nothing here yet'}</div>
      ) : (
        <>
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
          {d.nextUp && d.nextUp.length > 0 && (
            <section>
              <div className="label">Next up</div>
              <div className="space-y-1">
                {d.nextUp.map((n, i) => (
                  <button
                    key={i}
                    className="tap block w-full rounded-ctl border px-2.5 py-1.5 text-left text-body hover:border-accent/50"
                    title="Put this in the composer"
                    onClick={() => onPutInComposer(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </section>
          )}
          <div className="flex items-center gap-1 text-2xs text-faint">
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
