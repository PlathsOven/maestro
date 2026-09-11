import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Asterisk, Bot, Check, ChevronDown, Cloud, ImageIcon, Laptop, Paperclip, X } from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { useApp, useActiveProject, useCaps, useShowPr } from '../store/app';
import { EffortBars, EffortOptions, Kbd, Modal, PickerOption, Spinner, readFilesAsBase64, useFileDrop } from './common';
import { effortLevelsFor, useHarnessModels } from '../lib/harnessModels';
import {
  effectiveCloudHostId,
  resolveDefaultEffort,
  resolveDefaultModel,
  resolveEffortLevel,
  type BranchInfo,
  type CreateFrom,
  type HarnessId,
  type HarnessInfo,
  type IssueListItem,
  type PrListItem,
} from '../../shared/types';

type FromMode = 'base' | 'branch' | 'pr' | 'issue' | 'linear';

const FROM_LABELS: Record<FromMode, string> = {
  base: 'Create from…',
  branch: 'From branch',
  pr: 'From pull request',
  issue: 'From GitHub issue',
  linear: 'From Linear issue',
};

/** Conductor-style "new workspace" floating chatbox: describe the task, pick
 *  model/effort, Create ↵ — the workspace (branch + worktree) comes with it. */
export default function NewWorkspaceModal() {
  const setModal = useApp((s) => s.setModal);
  const modal = useApp((s) => s.modal);
  const project = useActiveProject();
  const projects = useApp((s) => s.projects);
  // From-PR/issue need a github origin + gh auth; from-branch needs git. (The
  // modal itself only opens for worktree projects, so `caps.git` holds here.)
  const caps = useCaps(project?.id);
  const showPr = useShowPr(project?.id);
  const harnesses = useApp((s) => s.harnesses);
  const settings = useApp((s) => s.settings);
  const toast = useApp((s) => s.toast);
  const HM = useHarnessModels();

  const [harness, setHarness] = useState<HarnessId>(settings.defaultHarness);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState(() => resolveDefaultEffort(settings.defaultEffort));
  const [fromMode, setFromMode] = useState<FromMode>(modal?.kind === 'new-workspace' ? (modal.from ?? 'base') : 'base');
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [prs, setPrs] = useState<PrListItem[] | null>(null);
  const [issues, setIssues] = useState<IssueListItem[] | null>(null);
  const [fromRef, setFromRef] = useState('');
  const [prompt, setPrompt] = useState('');
  const [createMore, setCreateMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projMenu, setProjMenu] = useState(false);
  const [fromMenu, setFromMenu] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [effortMenu, setEffortMenu] = useState(false);
  const [harnessMenu, setHarnessMenu] = useState(false);
  // Attachments are held in memory until the workspace exists (its worktree is
  // provisioned async) — they're persisted server-side during workspace:create.
  const [atts, setAtts] = useState<{ name: string; dataBase64: string; kind: 'image' | 'file' }[]>([]);

  // Where this conversation runs (§4, kubernetes-workspaces.md §3.5). Only branch
  // workspaces of a local git project can start off this machine. The chain —
  // project default → app-wide default → local — is pre-selected and always
  // overridable here; k8s clusters are ordinary entries in the same list.
  const hosts = useApp((s) => s.hosts);
  const cloudEligible = !!project && caps.worktrees && !project.hostId;
  const [hostId, setHostId] = useState<string | null>(() => effectiveCloudHostId(project, settings));
  const [hostMenu, setHostMenu] = useState(false);
  const runHost = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  // A saved default can vanish (host detached) or change with the project.
  useEffect(() => {
    setHostId(effectiveCloudHostId(project, settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.cloudHostId, settings.cloud?.defaultOn, settings.cloud?.hostId]);

  const installed = useMemo(() => harnesses.filter((h) => h.installed), [harnesses]);
  // Every harness is offered in the model picker (grouped) — even ones the user
  // hasn't installed/logged into yet — with the ready ones (installed OR logged
  // in) surfaced first. "Connected" counts as ready: a harness the user has
  // authenticated shouldn't disappear just because its CLI probe came back empty.
  const harnessReady = (h: HarnessInfo) => h.installed || !!h.connected;
  const harnessGroups = useMemo(
    () => [...harnesses].sort((a, b) => Number(harnessReady(b)) - Number(harnessReady(a))),
    [harnesses]
  );

  useEffect(() => {
    const def = installed.find((h) => h.id === settings.defaultHarness);
    setHarness(def?.id ?? installed[0]?.id ?? 'shell');
  }, [installed, settings.defaultHarness]);

  useEffect(() => {
    if (!project) return;
    setFromRef('');
    setBranches(null);
    setPrs(null);
    setIssues(null);
    if (fromMode === 'branch') {
      void tryInvoke('project:branches', { projectId: project.id }).then((r) => setBranches(r.data ?? []));
    } else if (fromMode === 'pr') {
      void tryInvoke('project:prs', { projectId: project.id }).then((r) => setPrs(r.data ?? []));
    } else if (fromMode === 'issue') {
      void tryInvoke('project:issues', { projectId: project.id }).then((r) => setIssues(r.data ?? []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromMode, project?.id]);

  if (!project) return null;

  const models = HM[harness] ?? [];
  const defaultModel = resolveDefaultModel(harness, settings.defaultModels);
  const effModel = model || defaultModel;
  const modelLabel = models.find((m) => m.id === effModel)?.label ?? (effModel || 'Default');
  const defaultEffort = resolveDefaultEffort(settings.defaultEffort);
  // Effort levels follow the chosen model (Codex's differ from Claude's; Haiku has
  // none), so the chip hides when the model exposes none.
  const effortLevels = effortLevelsFor(harness, effModel, HM);
  const effortLevel = resolveEffortLevel(effort, effortLevels);
  // On a model switch, keep the selected effort valid for the new model's ladder.
  const clampEffort = (h: HarnessId, mId: string) => {
    const levels = effortLevelsFor(h, mId, HM);
    if (!levels.length || levels.some((l) => l.id === effort)) return;
    const opt = (HM[h] ?? []).find((x) => x.id === mId);
    const next = resolveEffortLevel(effort, levels, opt?.defaultEffort);
    if (next) setEffort(next.id);
  };
  const harnessLabel = harnesses.find((h) => h.id === harness)?.displayName ?? harness;

  const ingestFiles = (list: File[]) =>
    readFilesAsBase64(
      list,
      (name, b64, kind) => setAtts((a) => [...a, { name, dataBase64: b64, kind }]),
      (name) => toast('error', `${name} is larger than 25MB`)
    );
  const { dragDepth, dropProps } = useFileDrop(ingestFiles);

  const create = async () => {
    if (busy) return;
    let from: CreateFrom | undefined;
    if (fromMode === 'branch') {
      if (!fromRef) return toast('error', 'Pick a branch');
      from = { type: 'branch', ref: fromRef };
    } else if (fromMode === 'pr') {
      if (!fromRef) return toast('error', 'Pick a pull request');
      from = { type: 'pr', ref: parseInt(fromRef, 10) };
    } else if (fromMode === 'issue') {
      if (!fromRef) return toast('error', 'Pick an issue');
      from = { type: 'issue', ref: parseInt(fromRef, 10) };
    } else if (fromMode === 'linear') {
      if (!fromRef.trim()) return toast('error', 'Enter a Linear issue ID (e.g. ENG-123)');
      if (!settings.linearToken.trim()) return toast('error', 'Add a Linear API token in Settings → Integrations first');
      from = { type: 'linear', ref: fromRef.trim() };
    }
    setBusy(true);
    const res = await tryInvoke('workspace:create', {
      projectId: project.id,
      harness,
      from,
      initialPrompt: prompt.trim() || undefined,
      initialAttachments: atts.length ? atts.map((a) => ({ name: a.name, kind: a.kind, dataBase64: a.dataBase64 })) : undefined,
      hostId: cloudEligible && hostId ? hostId : undefined,
    });
    setBusy(false);
    if (res.error) {
      toast('error', res.error);
      return;
    }
    // Provisioning takes a moment — the chat meta lands well before the first send.
    const ws = res.data!;
    if (effModel || effort !== defaultEffort) {
      useApp.getState().setChatMeta(ws.id, 1, { model: effModel, effort });
    }
    if (createMore) {
      setPrompt('');
      setAtts([]);
      toast('success', `Created ${ws.name}`);
    } else {
      setModal(null);
      useApp.getState().selectWorkspace(ws.id);
    }
  };

  const chip = 'btn btn-ghost h-6 gap-1 px-1.5 text-xs text-muted hover:text-fg';

  return (
    <Modal plain onClose={() => setModal(null)} width={680} onCmdEnter={() => void create()}>
      <div className="relative" {...dropProps}>
        {dragDepth > 0 && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-card border border-dashed border-accent bg-accent-soft/80 text-[13px] font-medium text-accent">
            Drop images or files to attach
          </div>
        )}
      {/* header: project switcher · create-from */}
      <div className="-mt-1 flex items-center gap-2">
        <div className="relative">
          <button className="flex items-center gap-2 rounded-ctl px-1.5 py-1 text-[15px] font-semibold hover:bg-accent-soft" onClick={() => setProjMenu((v) => !v)}>
            {project.name}
            <ChevronDown size={13} className="text-faint" />
          </button>
          {projMenu && (
            <DownMenu onClose={() => setProjMenu(false)}>
              {projects.map((p) => (
                <MenuRow
                  key={p.id}
                  checked={p.id === project.id}
                  onClick={() => {
                    useApp.getState().selectProject(p.id);
                    setProjMenu(false);
                  }}
                >
                  {p.name}
                </MenuRow>
              ))}
            </DownMenu>
          )}
        </div>
        <div className="flex-1" />
        <div className="relative">
          <button className="flex items-center gap-1.5 rounded-ctl px-2 py-1 text-[13px] text-muted hover:bg-accent-soft hover:text-fg" onClick={() => setFromMenu((v) => !v)}>
            {fromMode === 'base' ? 'Create from…' : FROM_LABELS[fromMode]}
            <ChevronDown size={12} className="text-faint" />
          </button>
          {fromMenu && (
            <DownMenu onClose={() => setFromMenu(false)} right>
              {(Object.keys(FROM_LABELS) as FromMode[])
                // From PR/issue require github+auth; from branch requires git.
                .filter((m) => (m === 'pr' || m === 'issue' ? showPr : m === 'branch' ? caps.git : true))
                .map((m) => (
                  <MenuRow
                    key={m}
                    checked={fromMode === m}
                    onClick={() => {
                      setFromMode(m);
                      setFromMenu(false);
                    }}
                  >
                    {m === 'base' ? `Base branch (${project.baseBranch ?? 'main'})` : FROM_LABELS[m]}
                  </MenuRow>
                ))}
            </DownMenu>
          )}
        </div>
      </div>

      {/* the task */}
      <textarea
        autoFocus
        className="mt-3 w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-faint"
        rows={5}
        placeholder="What do you want to work on? (drag or paste to attach images)"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onPaste={(e) => {
          for (const item of e.clipboardData.items) {
            if (item.type.startsWith('image/')) {
              e.preventDefault();
              const file = item.getAsFile();
              if (file) ingestFiles([file]);
              return;
            }
          }
        }}
      />

      {atts.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {atts.map((a, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-ctl border bg-raised px-2 py-1 text-xs text-muted">
              {a.kind === 'image' ? <ImageIcon size={12} className="text-accent" /> : <Paperclip size={12} />}
              <span className="max-w-[160px] truncate">{a.name}</span>
              <button
                className="rounded p-0.5 text-faint hover:text-err"
                title="Remove attachment"
                onClick={() => setAtts((cur) => cur.filter((_, j) => j !== i))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* from picker when needed */}
      {fromMode !== 'base' && (
        <div className="mb-1 mt-1">
          {fromMode === 'branch' &&
            (branches === null ? (
              <Spinner />
            ) : (
              <select className="input font-mono text-xs" value={fromRef} onChange={(e) => setFromRef(e.target.value)}>
                <option value="">choose branch…</option>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            ))}
          {fromMode === 'pr' &&
            (prs === null ? (
              <Spinner />
            ) : (
              <select className="input text-xs" value={fromRef} onChange={(e) => setFromRef(e.target.value)}>
                <option value="">choose PR…</option>
                {prs.map((p) => (
                  <option key={p.number} value={p.number}>
                    #{p.number} {p.title.slice(0, 60)}
                  </option>
                ))}
              </select>
            ))}
          {fromMode === 'issue' &&
            (issues === null ? (
              <Spinner />
            ) : (
              <select className="input text-xs" value={fromRef} onChange={(e) => setFromRef(e.target.value)}>
                <option value="">choose issue…</option>
                {issues.map((i) => (
                  <option key={i.number} value={i.number}>
                    #{i.number} {i.title.slice(0, 60)}
                  </option>
                ))}
              </select>
            ))}
          {fromMode === 'linear' && (
            <input className="input w-56 font-mono text-xs" placeholder="ENG-123" value={fromRef} onChange={(e) => setFromRef(e.target.value)} />
          )}
        </div>
      )}

      {/* bottom bar */}
      <div className="mt-2 flex items-center gap-1.5">
        <div className="relative">
          <button className={chip} title="Model" onClick={() => setModelMenu((v) => !v)}>
            <Asterisk size={13} className="text-accent" />
            {modelLabel}
          </button>
          {modelMenu && (
            <DownMenu up tall wide onClose={() => setModelMenu(false)}>
              {harnessGroups.map((h, gi) => {
                const hModels = HM[h.id] ?? [];
                const hDefault = resolveDefaultModel(h.id, settings.defaultModels);
                return (
                  <div key={h.id}>
                    {gi > 0 && <div className="mx-2 my-1 border-t" />}
                    <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1 text-2xs font-semibold uppercase tracking-wide text-faint">
                      <Bot size={11} className="shrink-0" />
                      <span className="truncate">{h.displayName}</span>
                      {!harnessReady(h) ? (
                        <span className="ml-auto font-normal normal-case">not installed</span>
                      ) : (
                        !h.installed && <span className="ml-auto font-normal normal-case text-ok">logged in</span>
                      )}
                    </div>
                    {hModels.map((m) => (
                      <PickerOption
                        key={`${h.id}:${m.id}`}
                        label={m.label}
                        selected={harness === h.id && effModel === m.id}
                        isDefault={hDefault === m.id}
                        showStar={hModels.length > 1}
                        disabled={!harnessReady(h)}
                        onSelect={() => {
                          setHarness(h.id);
                          setModel(m.id);
                          clampEffort(h.id, m.id);
                          setModelMenu(false);
                        }}
                        onSetDefault={() => {
                          useApp.getState().setDefaultModel(h.id, m.id);
                          setHarness(h.id);
                          setModel(m.id);
                          clampEffort(h.id, m.id);
                          setModelMenu(false);
                        }}
                      />
                    ))}
                  </div>
                );
              })}
            </DownMenu>
          )}
        </div>

        {effortLevel && (
          <div className="relative">
            <button className={chip} title="Reasoning effort" onClick={() => setEffortMenu((v) => !v)}>
              <EffortBars level={effortLevel.bars} />
              {effortLevel.label}
            </button>
            {effortMenu && (
              <DownMenu up onClose={() => setEffortMenu(false)}>
                <EffortOptions
                  levels={effortLevels}
                  currentId={effortLevel.id}
                  defaultId={defaultEffort}
                  onPick={(id, makeDefault) => {
                    if (makeDefault) useApp.getState().setDefaultEffort(id);
                    setEffort(id);
                    setEffortMenu(false);
                  }}
                />
              </DownMenu>
            )}
          </div>
        )}

        <div className="relative">
          <button className={chip} title="Agent harness" onClick={() => setHarnessMenu((v) => !v)}>
            <Bot size={13} />
            {harnessLabel}
          </button>
          {harnessMenu && (
            <DownMenu up onClose={() => setHarnessMenu(false)}>
              {harnesses.map((h) => (
                <MenuRow
                  key={h.id}
                  checked={h.id === harness}
                  disabled={!h.installed}
                  onClick={() => {
                    if (!h.installed) return;
                    setHarness(h.id);
                    setModel('');
                    setHarnessMenu(false);
                  }}
                >
                  {h.displayName}
                  {!h.installed && <span className="ml-auto text-2xs text-faint">not installed</span>}
                </MenuRow>
              ))}
            </DownMenu>
          )}
        </div>

        <div className="flex-1" />

        {cloudEligible && (
          <div className="relative">
            <button
              className={clsx(chip, runHost && 'text-accent')}
              title={
                runHost
                  ? `Runs on ${runHost.label} — keeps going when Maestro is closed`
                  : 'Runs on this machine, in a git worktree'
              }
              onClick={() => setHostMenu((v) => !v)}
            >
              {runHost ? <Cloud size={12} /> : <Laptop size={12} />}
              {runHost ? runHost.label : 'Local'}
              <ChevronDown size={11} className="text-faint" />
            </button>
            {hostMenu && (
              <DownMenu up right onClose={() => setHostMenu(false)}>
                <MenuRow
                  checked={!hostId}
                  onClick={() => {
                    setHostId(null);
                    setHostMenu(false);
                  }}
                >
                  This machine <span className="text-2xs text-faint">git worktree</span>
                </MenuRow>
                {hosts.map((h) => (
                  <MenuRow
                    key={h.id}
                    checked={h.id === hostId}
                    onClick={() => {
                      setHostId(h.id);
                      setHostMenu(false);
                    }}
                  >
                    <span className="truncate">{h.label}</span>
                    {h.kind === 'k8s' && <span className="ml-auto text-2xs text-faint">k8s</span>}
                  </MenuRow>
                ))}
                {hosts.length === 0 && (
                  <MenuRow
                    onClick={() => {
                      setHostMenu(false);
                      setModal({ kind: 'settings', tab: 'cloud' });
                    }}
                  >
                    Add a server or cluster…
                  </MenuRow>
                )}
              </DownMenu>
            )}
          </div>
        )}

        <button
          className="flex items-center gap-2 rounded-ctl px-2 py-1 text-xs text-muted hover:text-fg"
          title="Keep this dialog open to create several workspaces"
          onClick={() => setCreateMore((v) => !v)}
        >
          <span className={clsx('relative h-4 w-7 rounded-full transition-colors', createMore ? 'bg-accent' : 'bg-border')}>
            <span
              className={clsx(
                'absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white transition-transform',
                createMore ? 'translate-x-3.5' : 'translate-x-0.5'
              )}
            />
          </span>
          Create more
        </button>

        <button className="btn btn-accent h-8 gap-2 px-3" disabled={busy} onClick={() => void create()}>
          {busy ? <Spinner className="!text-white" /> : 'Create'}
          <Kbd>⌘↵</Kbd>
        </button>
      </div>

      <p className="mt-2 text-2xs text-faint">
        Creates an isolated worktree on a fresh branch from {fromMode === 'base' ? (project.baseBranch ?? 'main') : 'the selected source'} —
        the task is sent to {harnessLabel} once setup finishes.
      </p>
      </div>
    </Modal>
  );
}

/**
 * A dropdown anchored to its trigger, rendered through a portal to `document.body`.
 * The modal panel is a `.glass` surface (backdrop-filter) with `overflow-hidden`,
 * which both clips descendants AND acts as a containing block for `position: fixed`
 * — so a tall menu like the grouped model list gets cut off at the modal's top edge
 * instead of spilling over it. Portaling escapes both. Position is measured from the
 * trigger wrapper each open (and on scroll/resize): `up` menus grow upward from just
 * above the trigger, down menus downward, and both clamp their height to the viewport
 * so a long list scrolls inside rather than running off-screen.
 */
function DownMenu({
  children,
  onClose,
  right,
  up,
  tall,
  wide,
}: {
  children: React.ReactNode;
  onClose: () => void;
  right?: boolean;
  /** open upward — for chips on the bottom bar */
  up?: boolean;
  /** roomier — for the harness-grouped model list, which has many rows */
  tall?: boolean;
  wide?: boolean;
}) {
  // Zero-size probe left in the normal tree: its parent is the trigger wrapper we
  // measure and hit-test against (the menu itself lives in a body-level portal).
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties | null>(null);

  const width = wide ? 256 : 224; // w-64 / w-56
  const maxH = tall ? 384 : 224; // max-h-96 / max-h-56

  useLayoutEffect(() => {
    const trigger = anchorRef.current?.parentElement;
    if (!trigger) return;
    const m = 8; // stay clear of the viewport edges
    const gap = 4; // matches the old mt-1 / mb-1
    const place = () => {
      const r = trigger.getBoundingClientRect();
      const left = Math.max(m, Math.min(right ? r.right - width : r.left, window.innerWidth - width - m));
      setStyle(
        up
          ? { left, bottom: window.innerHeight - r.top + gap, width, maxHeight: Math.min(maxH, r.top - gap - m) }
          : { left, top: r.bottom + gap, width, maxHeight: Math.min(maxH, window.innerHeight - r.bottom - gap - m) }
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true); // capture: any ancestor scroller that moves the trigger
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [up, right, width, maxH]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.parentElement?.contains(t) || menuRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden />
      {style &&
        createPortal(
          <div ref={menuRef} className="glass fixed z-[60] overflow-y-auto py-1" style={style}>
            {children}
          </div>,
          document.body
        )}
    </>
  );
}

function MenuRow({
  children,
  checked,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  checked?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx(
        'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-accent-soft',
        disabled && 'opacity-45'
      )}
      onClick={onClick}
    >
      <span className="w-3.5 shrink-0">{checked && <Check size={12} className="text-accent" />}</span>
      {children}
    </button>
  );
}
