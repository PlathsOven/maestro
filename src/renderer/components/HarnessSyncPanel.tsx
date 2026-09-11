import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, MessageSquare, RefreshCw } from 'lucide-react';
import { useApp } from '../store/app';
import { Spinner } from './common';
import type { HarnessSyncGroup } from '../../shared/types';

// The "Sync chats from Claude Code & Codex" panel (docs/specs/harness-chat-sync.md
// §4.1). Layout mirrors ConductorImportPanel: read-only scan, preview grouped by
// placement, per-session selection, one-click import + a "keep syncing" toggle.

function appLabel(app: 'claude-code' | 'codex'): string {
  return app === 'codex' ? 'Codex' : 'Claude Code';
}

/** Shorten a home-anchored path for display (~/… form). */
function prettyPath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+/)?.[0];
  return home ? '~' + p.slice(home.length) : p;
}

function timeAgo(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function groupTitle(g: HarnessSyncGroup): { name: string; sub: string; tag: string } {
  const p = g.placement;
  switch (p.kind) {
    case 'workspace':
      return { name: p.name, sub: '', tag: 'existing workspace' };
    case 'adopt':
      return { name: p.path.split('/').pop() || p.path, sub: prettyPath(p.path), tag: 'known project' };
    case 'new-project':
      return { name: p.root.split('/').pop() || p.root, sub: prettyPath(p.root), tag: 'new project — will be added' };
    case 'new-folder':
      return { name: p.root.split('/').pop() || '~', sub: prettyPath(p.root), tag: 'new folder project' };
    case 'missing':
      return { name: p.root, sub: '', tag: 'folder missing' };
  }
}

/** Groups checked by default: existing workspace / known project / new git repo.
 *  Non-git folders start unchecked (§4.1). */
function defaultOn(g: HarnessSyncGroup): boolean {
  return g.placement.kind === 'workspace' || g.placement.kind === 'adopt' || g.placement.kind === 'new-project';
}

function CheckBox({ checked, disabled, small }: { checked: boolean; disabled?: boolean; small?: boolean }) {
  const size = small ? 15 : 17;
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded border transition-colors ${
        checked ? 'border-accent bg-accent text-white' : 'border-line bg-raised'
      } ${disabled ? 'opacity-50' : ''}`}
      style={{ width: size, height: size }}
    >
      {checked && <Check size={small ? 10 : 12} strokeWidth={3} />}
    </span>
  );
}

export default function HarnessSyncPanel({ hideTitle }: { hideTitle?: boolean }) {
  const scan = useApp((s) => s.harnessSyncScan);
  const scanning = useApp((s) => s.harnessSyncScanning);
  const scanError = useApp((s) => s.harnessSyncScanError);
  const importing = useApp((s) => s.harnessSyncImporting);
  const doScan = useApp((s) => s.scanHarnessSync);
  const doImport = useApp((s) => s.importHarnessSync);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [keepSyncing, setKeepSyncing] = useState(true);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    void doScan();
  }, [doScan]);

  const groups = scan?.groups ?? [];

  // Seed the default selection once the first scan lands.
  useEffect(() => {
    if (seeded || !scan) return;
    const sel = new Set<string>();
    const exp = new Set<string>();
    for (const g of groups) {
      exp.add(g.key);
      if (!defaultOn(g)) continue;
      for (const s of g.sessions) if (!s.alreadyImported) sel.add(s.sessionId);
    }
    setSelected(sel);
    setExpanded(exp);
    setSeeded(true);
  }, [scan, seeded, groups]);

  const selectableCount = useMemo(
    () => groups.reduce((n, g) => n + g.sessions.filter((s) => !s.alreadyImported).length, 0),
    [groups]
  );

  if (!scan || groups.length === 0) {
    if (scanError && !scanning)
      return (
        <div className="card flex flex-col items-center gap-3 p-6 text-center text-sm text-muted">
          <div>Couldn’t scan Claude Code / Codex chats.</div>
          <button className="btn" onClick={() => void doScan(true)}>
            Retry
          </button>
        </div>
      );
    if (scanning || !scan)
      return (
        <div className="card flex items-center justify-center gap-2 p-6 text-sm text-muted">
          <Spinner /> Scanning Claude Code & Codex chats…
        </div>
      );
    return (
      <div className="card p-6 text-center text-sm text-muted">No importable Claude Code or Codex chats found.</div>
    );
  }

  const toggleSession = (sessionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };
  const toggleGroup = (g: HarnessSyncGroup) => {
    const ids = g.sessions.filter((s) => !s.alreadyImported).map((s) => s.sessionId);
    const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) (allOn ? next.delete(id) : next.add(id));
      return next;
    });
  };
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const count = selected.size;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line bg-raised/40 px-4 py-3">
        <div>
          {!hideTitle && <div className="text-[13px] font-semibold">Sync chats from Claude Code & Codex</div>}
          <div className="text-xs text-muted">
            {selectableCount > 0
              ? `Found ${selectableCount} chat${selectableCount === 1 ? '' : 's'} in ${groups.length} repo${groups.length === 1 ? '' : 's'}.`
              : 'All found chats are already in Maestro.'}
          </div>
        </div>
        <button
          className="btn h-7 px-2 text-2xs"
          title="Re-scan"
          onClick={() => {
            setSeeded(false);
            void doScan(true);
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="max-h-[46vh] overflow-y-auto">
        {groups.map((g, i) => {
          const t = groupTitle(g);
          const ids = g.sessions.filter((s) => !s.alreadyImported).map((s) => s.sessionId);
          const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
          const isOpen = expanded.has(g.key);
          return (
            <div key={g.key} className={i > 0 ? 'border-t border-line' : ''}>
              <div
                className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-raised/40"
                onClick={() => ids.length && toggleGroup(g)}
              >
                <CheckBox checked={allOn} disabled={ids.length === 0} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.name}</div>
                  <div className="truncate text-2xs text-faint">
                    {t.sub && <span>{t.sub} · </span>}
                    {t.tag} · {g.sessions.length} chat{g.sessions.length === 1 ? '' : 's'}
                  </div>
                </div>
                <button
                  className="rounded p-1 text-muted hover:bg-raised"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpanded(g.key);
                  }}
                >
                  {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
              </div>
              {isOpen && (
                <div className="border-t border-line bg-raised/30 pb-1">
                  {g.sessions.map((s) => (
                    <div
                      key={s.sessionId}
                      className={`flex items-center gap-3 px-4 py-1.5 pl-9 ${
                        s.alreadyImported ? 'opacity-60' : 'cursor-pointer hover:bg-raised/40'
                      }`}
                      onClick={() => !s.alreadyImported && toggleSession(s.sessionId)}
                    >
                      <CheckBox checked={s.alreadyImported ? true : selected.has(s.sessionId)} disabled={s.alreadyImported} small />
                      <div className="min-w-0 flex-1 truncate text-xs">{s.title}</div>
                      <div className="flex shrink-0 items-center gap-2 text-2xs text-faint">
                        <span>{appLabel(s.app)}</span>
                        <span className="flex items-center gap-1">
                          <MessageSquare size={11} /> {s.turns}
                        </span>
                        <span>{timeAgo(s.modifiedAt)}</span>
                        {s.alreadyImported && <span className="italic">already in Maestro</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-line bg-raised/40 px-4 py-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-2xs text-muted">
          <input type="checkbox" checked={keepSyncing} onChange={(e) => setKeepSyncing(e.target.checked)} />
          Keep syncing: new chats and turns from Claude Code & Codex appear here automatically
        </label>
      </div>

      <div className="flex items-center justify-between border-t border-line bg-raised/40 px-4 py-3">
        <span className="text-2xs text-faint">Read-only: your Claude Code &amp; Codex files are not modified.</span>
        <button
          className="btn btn-accent flex items-center gap-2"
          disabled={count === 0 || importing}
          onClick={() => void doImport([...selected], keepSyncing)}
        >
          {importing ? (
            <>
              <Spinner /> Importing…
            </>
          ) : (
            `Import ${count} chat${count === 1 ? '' : 's'}`
          )}
        </button>
      </div>
    </div>
  );
}
