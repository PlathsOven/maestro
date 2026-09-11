import clsx from 'clsx';
import { User, Waypoints } from 'lucide-react';
import { useApp } from '../store/app';
import { Modal } from './common';
import { BlockList, Markdown } from './ChatPanel';
import { formatDuration } from '../lib/format';
import { roleLabel, roleModelLabel } from '../../shared/types';

/**
 * Read-only preview of one specialist sub-agent run — the delegated task and the
 * specialist's full trace, rendered with the same blocks as a normal chat turn.
 * Prefers the live store copy so it fills in while the specialist works.
 */
export default function SubagentPreview() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  const settings = useApp((s) => s.settings);
  const live = useApp((s) =>
    modal?.kind === 'subagent-preview'
      ? s.subagentRuns[modal.run.parentMessageId]?.find((r) => r.id === modal.run.id)
      : undefined
  );
  if (modal?.kind !== 'subagent-preview') return null;
  const run = live ?? modal.run;

  return (
    <Modal
      width={760}
      onClose={() => setModal(null)}
      title={
        <span className="flex items-center gap-1.5">
          <Waypoints size={13} /> {roleLabel(run.role, settings)} · trace
        </span>
      }
    >
      <div data-img-gallery className="mx-auto max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-faint">
          <span>{roleModelLabel(run)}</span>
          {run.durationMs != null && <span>· {formatDuration(run.durationMs)}</span>}
          <span
            className={clsx(
              'capitalize',
              run.status === 'error' ? 'text-err' : run.status === 'running' ? 'text-accent' : 'text-ok'
            )}
          >
            · {run.status}
          </span>
        </div>

        <div>
          <div className="mb-1 flex items-center gap-1.5 text-2xs text-faint">
            <User size={11} /> Delegated task
          </div>
          <div className="rounded-card border bg-surface px-3.5 py-2.5">
            <Markdown text={run.prompt} />
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center gap-1.5 text-2xs text-faint">
            <Waypoints size={11} /> {roleLabel(run.role, settings)}
          </div>
          {run.blocks.length ? (
            <BlockList blocks={run.blocks} folded />
          ) : (
            <div className="px-1 text-xs text-muted">{run.status === 'running' ? 'Working…' : 'No output.'}</div>
          )}
          {run.error && <div className="mt-1 px-1 text-xs text-err">{run.error}</div>}
        </div>
      </div>
    </Modal>
  );
}
