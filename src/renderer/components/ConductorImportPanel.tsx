import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, GitBranch, RefreshCw, Check, AlertTriangle, MessageSquare } from 'lucide-react';
import { useApp } from '../store/app';
import { Spinner } from './common';
import type { ConductorProjectPreview, ConductorSelection } from '../../shared/types';

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

interface Selection {
  projects: Set<string>;
  workspaces: Record<string, Set<string>>; // projectKey → chosen workspace names
}

const importableWorkspaces = (p: ConductorProjectPreview) => p.workspaces.filter((w) => !w.alreadyImported);
const isRowDisabled = (p: ConductorProjectPreview) => p.missing || p.alreadyImported;

/** Default-check heuristic (§4): projects with ≥1 live workspace or activity in
 *  the last 30 days; skips missing / already-imported rows. */
function defaultSelection(projects: ConductorProjectPreview[]): Selection {
  const sel: Selection = { projects: new Set(), workspaces: {} };
  for (const p of projects) {
    if (isRowDisabled(p)) continue;
    const ws = importableWorkspaces(p);
    const recent = p.lastActivityAt != null && Date.now() - p.lastActivityAt < THIRTY_DAYS;
    if (ws.length > 0 || recent) {
      sel.projects.add(p.key);
      sel.workspaces[p.key] = new Set(ws.map((w) => w.name));
    }
  }
  return sel;
}

/**
 * The "Continue from Conductor" panel: lists scanned repos → live workspaces →
 * session counts, lets the user pick, and adopts them (read-only toward
 * Conductor). Rendered inline in the onboarding gate and inside the post-
 * onboarding modal — same component, so the two stay in lockstep (spec §4/§6.5).
 */
export default function ConductorImportPanel({ hideTitle }: { hideTitle?: boolean } = {}) {
  const scan = useApp((s) => s.conductorScan);
  const scanning = useApp((s) => s.conductorScanning);
  const scanError = useApp((s) => s.conductorScanError);
  const importing = useApp((s) => s.conductorImporting);
  const doScan = useApp((s) => s.scanConductor);
  const doImport = useApp((s) => s.importFromConductor);

  const [sel, setSel] = useState<Selection>({ projects: new Set(), workspaces: {} });
  const [seeded, setSeeded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    void doScan();
  }, [doScan]);

  // Seed the default selection once the first scan lands.
  useEffect(() => {
    if (!scan || seeded) return;
    setSel(defaultSelection(scan.projects));
    setSeeded(true);
  }, [scan, seeded]);

  const projects = scan?.projects ?? [];
  const count = sel.projects.size;

  const toggleProject = (p: ConductorProjectPreview) => {
    if (isRowDisabled(p)) return;
    setSel((s) => {
      const nextProjects = new Set(s.projects);
      const workspaces = { ...s.workspaces };
      if (nextProjects.has(p.key)) nextProjects.delete(p.key);
      else {
        nextProjects.add(p.key);
        workspaces[p.key] = new Set(importableWorkspaces(p).map((w) => w.name));
      }
      return { projects: nextProjects, workspaces };
    });
  };

  const toggleWorkspace = (p: ConductorProjectPreview, name: string) => {
    setSel((s) => {
      const chosen = new Set(s.workspaces[p.key] ?? []);
      if (chosen.has(name)) chosen.delete(name);
      else chosen.add(name);
      const projects = new Set(s.projects);
      if (chosen.size > 0) projects.add(p.key); // checking a workspace implies importing its project
      return { projects, workspaces: { ...s.workspaces, [p.key]: chosen } };
    });
  };

  const setAll = (on: boolean) =>
    setSel(on ? defaultSelectionAll(projects) : { projects: new Set(), workspaces: {} });

  const selections = useMemo<ConductorSelection[]>(() => {
    const out: ConductorSelection[] = [];
    for (const p of projects) {
      if (!sel.projects.has(p.key)) continue;
      const ws = importableWorkspaces(p);
      const chosen = ws.filter((w) => sel.workspaces[p.key]?.has(w.name));
      // Omit workspaceNames to mean "all" (also the project-only case: no live ws).
      if (chosen.length === ws.length) out.push({ key: p.key });
      else out.push({ key: p.key, workspaceNames: chosen.map((w) => w.name) });
    }
    return out;
  }, [projects, sel]);

  // ---- states before the list ----
  // No results yet: show a scan error (with retry) or a loading affordance, so a
  // slow/failed scan on a large install never reads as "nothing found" (§4).
  if (!scan || projects.length === 0) {
    if (scanError && !scanning) {
      return (
        <div className="card flex items-center justify-between gap-3 px-4 py-3.5 text-xs">
          <span className="flex items-center gap-2 text-muted">
            <AlertTriangle size={14} className="text-warn" /> Couldn’t read your Conductor projects.
          </span>
          <button className="btn h-7 shrink-0 text-2xs" onClick={() => void doScan(true)}>
            Retry
          </button>
        </div>
      );
    }
    if (scanning || !scan) {
      return (
        <div className="card flex items-center gap-2.5 px-4 py-4 text-xs text-muted">
          <Spinner /> Loading your Conductor projects…
        </div>
      );
    }
    return null; // scan done, nothing importable
  }
  if (!scan.detected) return null;

  const allImported = projects.every((p) => p.alreadyImported || p.missing);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-start justify-between gap-2 border-b bg-raised/40 px-4 py-3">
        <div className="min-w-0">
          {!hideTitle && <div className="text-[13px] font-semibold">Continue from Conductor</div>}
          <div className={`text-xs text-muted ${hideTitle ? '' : 'mt-0.5'}`}>
            {allImported
              ? 'All your Conductor projects are already in Maestro.'
              : `We found ${projects.length} project${projects.length === 1 ? '' : 's'} in your Conductor install.`}
            {scan.source === 'fs' && ' (found via filesystem scan)'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-2xs">
          <button className="text-accent hover:underline" onClick={() => setAll(true)} disabled={importing}>
            Select all
          </button>
          <span className="text-faint">·</span>
          <button className="text-muted hover:underline" onClick={() => setAll(false)} disabled={importing}>
            none
          </button>
          <button
            className="ml-1 rounded-ctl p-1 text-muted transition-colors hover:bg-accent-soft hover:text-fg"
            title="Re-scan Conductor"
            onClick={() => void doScan(true)}
            disabled={importing}
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      <div className="max-h-[46vh] overflow-y-auto">
        {projects.map((p, i) => {
          const disabled = isRowDisabled(p);
          const checked = sel.projects.has(p.key);
          const isOpen = expanded.has(p.key);
          const wsCount = p.workspaces.length;
          const sessionCount = p.workspaces.reduce((n, w) => n + w.sessionCount, 0);
          return (
            <div key={p.key} className={i > 0 ? 'border-t' : ''}>
              <div
                className={`flex items-center gap-3 px-4 py-2.5 ${
                  disabled ? 'opacity-55' : 'cursor-pointer hover:bg-accent-soft/50'
                }`}
                onClick={() => toggleProject(p)}
              >
                <CheckBox checked={disabled ? p.alreadyImported : checked} disabled={disabled} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{p.name}</span>
                    <span className="truncate font-mono text-2xs text-faint">{prettyPath(p.repoPath)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted">
                    {p.missing ? (
                      <span className="flex items-center gap-1 text-warn">
                        <AlertTriangle size={11} /> folder missing
                      </span>
                    ) : p.alreadyImported ? (
                      <span className="flex items-center gap-1 text-ok">
                        <Check size={11} /> Imported
                      </span>
                    ) : wsCount === 0 ? (
                      'no live workspaces'
                    ) : (
                      <>
                        <span>{wsCount} workspace{wsCount === 1 ? '' : 's'}</span>
                        {sessionCount > 0 && (
                          <>
                            <span className="text-faint">·</span>
                            <span>{sessionCount} recent session{sessionCount === 1 ? '' : 's'}</span>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {wsCount > 0 && (
                  <button
                    className="shrink-0 rounded-ctl p-0.5 text-faint hover:bg-accent-soft hover:text-fg"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded((s) => {
                        const next = new Set(s);
                        next.has(p.key) ? next.delete(p.key) : next.add(p.key);
                        return next;
                      });
                    }}
                    title={isOpen ? 'Hide workspaces' : 'Show workspaces'}
                  >
                    {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                )}
              </div>

              {isOpen && wsCount > 0 && (
                <div className="border-t bg-raised/30 pb-1">
                  {p.workspaces.map((w) => {
                    const wsDisabled = w.alreadyImported || p.missing || p.alreadyImported;
                    const wsChecked = w.alreadyImported ? true : !!sel.workspaces[p.key]?.has(w.name);
                    return (
                      <div
                        key={w.name}
                        className={`flex items-center gap-3 py-1.5 pl-11 pr-4 ${
                          wsDisabled ? 'opacity-55' : 'cursor-pointer hover:bg-accent-soft/40'
                        }`}
                        onClick={() => !wsDisabled && toggleWorkspace(p, w.name)}
                      >
                        <CheckBox checked={wsChecked} disabled={wsDisabled} small />
                        <span className="truncate text-xs">{w.name}</span>
                        <span className="flex min-w-0 items-center gap-1 font-mono text-2xs text-faint">
                          <GitBranch size={10} className="shrink-0" />
                          <span className="truncate">{w.branch || 'detached'}</span>
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-2 text-2xs text-muted">
                          {w.sessionCount > 0 && (
                            <span className="flex items-center gap-0.5">
                              <MessageSquare size={10} /> {w.sessionCount}
                            </span>
                          )}
                          {w.alreadyImported && <span className="flex items-center gap-0.5 text-ok"><Check size={10} /> Imported</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t bg-raised/40 px-4 py-3">
        <span className="text-2xs text-faint">Read-only: your Conductor setup is not modified.</span>
        <button
          className="btn btn-accent h-8 shrink-0 text-xs"
          disabled={count === 0 || importing}
          onClick={() => void doImport(selections)}
        >
          {importing ? (
            <>
              <Spinner /> Importing…
            </>
          ) : (
            `Import selected (${count})`
          )}
        </button>
      </div>
    </div>
  );
}

/** Select everything importable (projects + all their live workspaces). */
function defaultSelectionAll(projects: ConductorProjectPreview[]): Selection {
  const sel: Selection = { projects: new Set(), workspaces: {} };
  for (const p of projects) {
    if (isRowDisabled(p)) continue;
    sel.projects.add(p.key);
    sel.workspaces[p.key] = new Set(importableWorkspaces(p).map((w) => w.name));
  }
  return sel;
}

function CheckBox({ checked, disabled, small }: { checked: boolean; disabled?: boolean; small?: boolean }) {
  const size = small ? 15 : 17;
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded border transition-colors ${
        checked ? 'border-accent bg-accent text-white' : 'border-line bg-raised'
      } ${disabled ? '' : ''}`}
      style={{ width: size, height: size }}
    >
      {checked && <Check size={small ? 10 : 12} strokeWidth={3} />}
    </span>
  );
}

/** Shorten a home-anchored path for display (~/… form). */
function prettyPath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+/)?.[0];
  return home ? '~' + p.slice(home.length) : p;
}
