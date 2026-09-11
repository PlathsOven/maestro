import React, { useEffect, useMemo } from 'react';
import { Activity, ArrowRight, Crosshair, History, RefreshCw, Sparkles } from 'lucide-react';
import { statusKey } from '../../shared/types';
import type { StatusRequest, Workspace } from '../../shared/types';
import { chatDisplayTitle } from '../../shared/chatTitle';
import { timeAgo } from '../lib/format';
import { useApp, useCaps } from '../store/app';
import { EmptyHint, Segmented, Spinner } from './common';

type Scope = 'session' | 'workspace' | 'project';

/** The empty-state glyph shared by the three digest scopes + the loading card. */
const SPARKLES_ICON = <Sparkles size={26} strokeWidth={1.5} />;

/**
 * AI status digest: what's being worked on, the last thing that happened, the
 * likely goal, and suggested next moves — at chat, branch, or project scope.
 * Cached per scope and regenerated automatically when the underlying state
 * (messages, branch, workspaces) has moved on — unless Settings → General →
 * "Auto-generate status" is off, in which case it only updates on request.
 */
export default function StatusPanel({ workspace }: { workspace: Workspace }) {
  const scope = useApp((s) => s.statusScope[workspace.id] ?? 'workspace');
  const autoStatus = useApp((s) => s.settings.autoStatus);
  const caps = useCaps(workspace.projectId);
  const agentId = useApp((s) => s.composerAgent[workspace.id] ?? 1);
  const messages = useApp((s) => s.messages[workspace.id]);
  const chatsMeta = useApp((s) => s.chatsMeta[workspace.id]);

  const req: StatusRequest = useMemo(
    () =>
      scope === 'session'
        ? { scope, workspaceId: workspace.id, agentId }
        : scope === 'workspace'
          ? { scope, workspaceId: workspace.id }
          : { scope, projectId: workspace.projectId },
    [scope, workspace.id, workspace.projectId, agentId]
  );
  const key = statusKey(req);
  const slot = useApp((s) => s.statusByKey[key]);

  // A session with no history has nothing to digest — skip the LLM entirely.
  // Same while the worktree is still provisioning (Status is the default tab,
  // so this mounts the moment a workspace is created).
  const settingUp = workspace.status === 'setting-up';
  const sessionEmpty = scope === 'session' && !(messages ?? []).some((m) => m.agentId === agentId);
  const skip = sessionEmpty || settingUp;

  useEffect(() => {
    if (!skip) void useApp.getState().loadStatus(req);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, skip]);

  const chatTitle = chatDisplayTitle(
    chatsMeta?.[String(agentId)],
    (messages ?? []).find((m) => m.agentId === agentId && m.role === 'user')?.content
  );

  const report = slot?.report ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3">
        <Segmented<Scope>
          value={scope}
          options={[
            { value: 'session', label: 'Session' },
            { value: 'workspace', label: caps.git ? 'Branch' : 'Workspace' },
            { value: 'project', label: 'Project' },
          ]}
          onChange={(v) => useApp.getState().setStatusScope(workspace.id, v)}
        />
        <button
          className="btn btn-ghost h-6 px-1.5"
          title="Regenerate status"
          disabled={slot?.generating || skip}
          onClick={() => void useApp.getState().generateStatus(req)}
        >
          {slot?.generating ? <Spinner /> : <RefreshCw size={12} className="text-muted" />}
        </button>
      </div>
      <div className="shrink-0 truncate px-4 pb-1 pt-1.5 text-2xs text-faint">
        {scope === 'session' && `Chat: ${chatTitle}`}
        {scope === 'workspace' && (caps.git ? `Branch: ${workspace.branch}` : `Folder: ${workspace.name}`)}
        {scope === 'project' && 'All active workspaces in this project'}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3 pt-1">
        {settingUp ? (
          <EmptyHint
            icon={SPARKLES_ICON}
            title="Setting up workspace"
            body="Status appears once the worktree is ready and there's activity to recap."
          />
        ) : sessionEmpty ? (
          <EmptyHint
            icon={SPARKLES_ICON}
            title="Nothing here yet"
            body="Once this chat has some history, Status will recap what's being worked on and what to do next."
          />
        ) : slot?.error && !report ? (
          <EmptyHint
            icon={SPARKLES_ICON}
            title="Couldn't generate status"
            body={slot.error}
            action={
              <button className="btn h-7 text-xs" onClick={() => void useApp.getState().generateStatus(req)}>
                Try again
              </button>
            }
          />
        ) : !report && !autoStatus && !slot?.generating ? (
          <EmptyHint
            icon={SPARKLES_ICON}
            title="Autodetect is off"
            body="Status only updates when you ask — generate it now, or turn autodetect back on in Settings → General."
            action={
              <button className="btn h-7 text-xs" onClick={() => void useApp.getState().generateStatus(req)}>
                Generate status
              </button>
            }
          />
        ) : !report ? (
          <StatusSkeleton />
        ) : (
          <>
            <div className="card space-y-3 p-3.5">
              <div className="text-[13px] font-semibold leading-snug">{report.headline}</div>
              <Section icon={<Activity size={11} />} label="Working on" text={report.working} />
              <Section icon={<History size={11} />} label="Last activity" text={report.lastActivity} />
              <Section icon={<Crosshair size={11} />} label="Goal" text={report.goal} />
            </div>

            {report.next.length > 0 && (
              <div className="card overflow-hidden">
                <div className="border-b px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
                  Next up
                </div>
                {report.next.map((n, i) => (
                  <button
                    key={i}
                    className="group flex w-full items-start gap-2 border-b px-3 py-2 text-left text-xs last:border-b-0 hover:bg-accent-soft/50"
                    title="Put this in the composer"
                    onClick={() => {
                      const s = useApp.getState();
                      s.setComposerDraft(workspace.id, s.composerAgent[workspace.id] ?? 1, n);
                      s.setTab(workspace.id, 'chat');
                      s.focusComposer();
                    }}
                  >
                    <ArrowRight size={12} className="mt-px shrink-0 text-faint transition-colors group-hover:text-accent" />
                    <span className="min-w-0 flex-1">{n}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-1.5 px-1 text-2xs text-faint">
              {slot?.generating ? (
                <>
                  <Spinner className="!h-3 !w-3" /> Updating…
                </>
              ) : (
                <>
                  <Sparkles size={10} />
                  {timeAgo(report.generatedAt)} · {report.model.replace(/^claude-/, '')}
                  {slot?.stale && <span className="text-warn"> · out of date</span>}
                </>
              )}
              {slot?.error && <span className="truncate text-err" title={slot.error}>· {slot.error}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ icon, label, text }: { icon: React.ReactNode; label: string; text: string }) {
  // The model emits multi-item fields as "- " lines — render those as a real
  // bullet list; a single item stays plain text.
  const items = text
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-0.5 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide text-faint">
        {icon} {label}
      </div>
      {items.length === 1 ? (
        <div className="text-xs leading-relaxed text-fg/90">{items[0]}</div>
      ) : (
        <ul className="space-y-0.5 text-xs leading-relaxed text-fg/90">
          {items.map((it, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="select-none text-faint">•</span>
              <span className="min-w-0 flex-1">{it}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusSkeleton() {
  return (
    <div className="card animate-pulse space-y-3 p-3.5">
      <div className="h-3.5 w-3/4 rounded bg-border/70" />
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-1.5">
          <div className="h-2 w-20 rounded bg-border/50" />
          <div className="h-2.5 w-full rounded bg-border/60" />
          <div className="h-2.5 w-5/6 rounded bg-border/60" />
        </div>
      ))}
      <div className="flex items-center gap-1.5 pt-1 text-2xs text-faint">
        <Spinner className="!h-3 !w-3" /> Summarizing with AI…
      </div>
    </div>
  );
}
