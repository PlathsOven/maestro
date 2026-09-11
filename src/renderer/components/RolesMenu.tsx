import React, { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Asterisk, ChevronDown, ChevronRight, Pencil, Plus, RotateCcw, Trash2, Waypoints } from 'lucide-react';
import { useApp } from '../store/app';
import { EffortBars, PickerOption, RenameInput, useDismissFromParent } from './common';
import { effortLevelsFor, useHarnessModels, type EffectiveModels } from '../lib/harnessModels';
import {
  BUILTIN_SPECIALIST_ROLES,
  HARNESS_DISPLAY,
  ORCHESTRATOR,
  blankRoleDef,
  resolveDefaultEffort,
  resolveDefaultModel,
  resolveEffortLevel,
  resolveRoles,
  specialistRoleIds,
  type HarnessId,
  type RoleDef,
  type Workspace,
} from '../../shared/types';

/** Every selectable specialist model across harnesses (shell excluded), flattened
 *  to {harness, model, label}. Picking one sets a role's harness + model together,
 *  so the specialist model picker is one flat list — unlike the orchestrator,
 *  whose harness is fixed to the chat's. Built from the live model map so
 *  runtime-discovered Codex models appear here too. */
function buildAgentModels(models: EffectiveModels): { harness: HarnessId; model: string; label: string }[] {
  return (Object.keys(models) as HarnessId[])
    .filter((h) => h !== 'shell')
    .flatMap((h) =>
      models[h].map((m) => ({ harness: h, model: m.id, label: `${HARNESS_DISPLAY[h]}${m.id ? ' · ' + m.label : ''}` }))
    );
}


/** The enable/disable toggle for a specialist. */
function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={clsx('relative h-4 w-7 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-border')}
    >
      <span
        className={clsx('absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all', on ? 'left-[14px]' : 'left-0.5')}
      />
    </button>
  );
}

/** A compact model/effort chip that toggles its inline picker. */
function Chip({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex h-6 shrink-0 items-center gap-1 rounded-ctl border px-1.5 text-2xs transition-colors hover:border-accent/50',
        active ? 'border-accent/60 text-fg' : 'bg-raised text-muted'
      )}
    >
      {icon}
      <span className="max-w-[8.5rem] truncate">{label}</span>
    </button>
  );
}

/** Per-role instruction editor (the role's system prompt); saves on blur. */
function InstrArea({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      className="mt-1 ml-8 w-[calc(100%-2rem)] resize-y rounded-ctl border bg-raised px-2 py-1.5 text-2xs leading-relaxed outline-none focus:border-accent/60"
      rows={4}
      value={draft}
      spellCheck={false}
      placeholder="System prompt for this role…"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
    />
  );
}

/**
 * The lightweight roles dropdown — the composer "Roles" chip opens it, in the
 * same up-popover style as the model/effort menus. One row per agent: the
 * orchestrator (its model/effort mirror the chat's own composer chips) plus each
 * specialist, with an enable toggle, an inline-renamable label, model + effort
 * mini-pickers (the same Asterisk / EffortBars icons as the composer), a
 * collapsible instruction editor, and add/delete for a modular, user-editable
 * stack. Replaces the old full-screen roles modal.
 */
export default function RolesMenu({
  workspace,
  agentId,
  onClose,
}: {
  workspace: Workspace;
  agentId: number;
  onClose: () => void;
}) {
  const settings = useApp((s) => s.settings);
  const chatMeta = useApp((s) => s.chatsMeta[workspace.id]?.[String(agentId)]);
  const installed = useApp((s) => s.harnesses);
  const ref = useRef<HTMLDivElement>(null);
  const HM = useHarnessModels();
  const AGENT_MODELS = useMemo(() => buildAgentModels(HM), [HM]);

  // Only one inline picker / rename / instruction editor open at a time.
  const [picker, setPicker] = useState<{ role: string; kind: 'model' | 'effort' } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [instr, setInstr] = useState<string | null>(null);

  // Close on outside click / Escape. `parentElement` is the composer's relative
  // wrapper holding both the chip and this menu, so clicking the chip (which
  // toggles) doesn't count as "outside".
  useDismissFromParent(onClose, ref);

  const roles = resolveRoles(settings);
  const specialists = specialistRoleIds(settings);
  const enabled = chatMeta?.enabledRoles ?? [];
  const noneOn = enabled.length === 0;

  // ---- persistence ----
  // Specialist defs (harness/model/effort/md/label) are global; orchestrator
  // model/effort are the chat's own (ChatMeta) so they stay linked to the
  // composer chips. Enable toggles are per-chat.
  const patchRole = (id: string, patch: Partial<RoleDef>) =>
    void useApp.getState().saveSettings({
      roles: { ...(settings.roles ?? {}), [id]: { ...(settings.roles?.[id] ?? {}), ...patch } },
    });

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...new Set([...enabled, id])] : enabled.filter((r) => r !== id);
    // Keep stack order so the generated preamble reads in the user's order.
    useApp.getState().setChatMeta(workspace.id, agentId, { enabledRoles: specialists.filter((r) => next.includes(r)) });
  };

  const orchModel = chatMeta?.model || resolveDefaultModel(workspace.harness, settings.defaultModels);
  const orchEffort = chatMeta?.effort || resolveDefaultEffort(settings.defaultEffort);

  const addRole = () => {
    let n = specialists.length + 1;
    while (specialists.includes(`role-${n}`) || `role-${n}` === ORCHESTRATOR) n++;
    const id = `role-${n}`;
    void useApp.getState().saveSettings({
      specialists: [...specialists, id],
      roles: { ...(settings.roles ?? {}), [id]: blankRoleDef(`New role ${n}`) },
    });
    setRenaming(id);
    setInstr(id);
  };

  const deleteRole = (id: string) => {
    const nextRoles = { ...(settings.roles ?? {}) };
    delete nextRoles[id];
    void useApp.getState().saveSettings({ specialists: specialists.filter((r) => r !== id), roles: nextRoles });
    if (enabled.includes(id)) toggle(id, false);
    if (renaming === id) setRenaming(null);
    if (instr === id) setInstr(null);
  };

  const reset = () =>
    void useApp.getState().saveSettings({ roles: {}, specialists: BUILTIN_SPECIALIST_ROLES.slice() });

  // ---- per-row model/effort (orchestrator is chat-scoped; others global) ----
  const modelOptions = (id: string) =>
    id === ORCHESTRATOR
      ? (HM[workspace.harness] ?? []).map((m) => ({
          harness: workspace.harness,
          model: m.id,
          label: m.label || 'Default',
        }))
      : AGENT_MODELS;

  const curModel = (id: string) =>
    id === ORCHESTRATOR ? { harness: workspace.harness, model: orchModel } : { harness: roles[id].harness, model: roles[id].model };

  const applyModel = (id: string, harness: HarnessId, model: string) => {
    // Effort ladders differ per model/harness, so a stored id can become invalid
    // when the model changes — clamp it to the new model's ladder in the same save.
    const levels = effortLevelsFor(harness, model, HM);
    const opt = (HM[harness] ?? []).find((x) => x.id === model);
    const eff =
      levels.length && !levels.some((l) => l.id === curEffort(id))
        ? resolveEffortLevel(curEffort(id), levels, opt?.defaultEffort)?.id
        : undefined;
    if (id === ORCHESTRATOR) useApp.getState().setChatMeta(workspace.id, agentId, { model, ...(eff ? { effort: eff } : {}) });
    else patchRole(id, { harness, model, ...(eff ? { effort: eff } : {}) });
    setPicker(null);
  };

  const curEffort = (id: string) => (id === ORCHESTRATOR ? orchEffort : roles[id].effort);
  const applyEffort = (id: string, e: string) => {
    if (id === ORCHESTRATOR) useApp.getState().setChatMeta(workspace.id, agentId, { effort: e });
    else patchRole(id, { effort: e });
    setPicker(null);
  };

  // The effort ladder for a role's current model, and the resolved current level
  // within it — Codex's ladder is per-model, Haiku (and non-effort harnesses)
  // have none, so a null level means: show no effort chip for this row.
  const roleEffortLevels = (id: string) => {
    const { harness, model } = curModel(id);
    return effortLevelsFor(harness, model, HM);
  };
  const roleEffortLevel = (id: string) => {
    const { harness, model } = curModel(id);
    const opt = (HM[harness] ?? []).find((x) => x.id === model);
    return resolveEffortLevel(curEffort(id), roleEffortLevels(id), opt?.defaultEffort);
  };

  // Compact: model label only (the harness is shown in the picker and in the
  // delegation preamble), so a long "Claude Code · Opus 4.8" doesn't crowd out
  // the role name on the row.
  const modelChipLabel = (id: string) => {
    const { harness, model } = curModel(id);
    const m = (HM[harness] ?? []).find((x) => x.id === model);
    return m?.label || model || HARNESS_DISPLAY[harness] || 'Default';
  };

  /** The model + effort chips shown on a role's row. */
  const chips = (id: string) => {
    const eff = roleEffortLevel(id);
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Chip
          icon={<Asterisk size={11} className="text-accent" />}
          label={modelChipLabel(id)}
          active={picker?.role === id && picker.kind === 'model'}
          onClick={() => setPicker((p) => (p?.role === id && p.kind === 'model' ? null : { role: id, kind: 'model' }))}
        />
        {eff && (
          <Chip
            icon={<EffortBars level={eff.bars} />}
            label={eff.label}
            active={picker?.role === id && picker.kind === 'effort'}
            onClick={() => setPicker((p) => (p?.role === id && p.kind === 'effort' ? null : { role: id, kind: 'effort' }))}
          />
        )}
      </div>
    );
  };

  /** The inline model/effort picker list under a role's row (when open). */
  const pickers = (id: string) => (
    <>
      {picker?.role === id && picker.kind === 'model' && (
        <div className="mt-1 ml-8 max-h-52 overflow-y-auto rounded-ctl border bg-raised py-1">
          {modelOptions(id).map((m) => {
            const gone = installed.find((i) => i.id === m.harness)?.installed === false;
            return (
              <PickerOption
                key={m.harness + ':' + m.model}
                label={m.label + (gone ? ' (not installed)' : '')}
                icon={<Asterisk size={12} className="text-accent" />}
                selected={curModel(id).harness === m.harness && curModel(id).model === m.model}
                isDefault={false}
                showStar={false}
                disabled={gone}
                onSelect={() => applyModel(id, m.harness, m.model)}
                onSetDefault={() => {}}
              />
            );
          })}
        </div>
      )}
      {picker?.role === id && picker.kind === 'effort' && (
        <div className="mt-1 ml-8 rounded-ctl border bg-raised py-1">
          {roleEffortLevels(id).map((e) => (
            <PickerOption
              key={e.id}
              label={e.label}
              icon={<EffortBars level={e.bars} />}
              selected={roleEffortLevel(id)?.id === e.id}
              isDefault={false}
              showStar={false}
              onSelect={() => applyEffort(id, e.id)}
              onSetDefault={() => {}}
            />
          ))}
        </div>
      )}
    </>
  );

  /** The collapsible instruction editor for one role. */
  const instructions = (id: string) => (
    <>
      <button
        className="mt-1 ml-8 flex items-center gap-1 text-2xs text-faint transition-colors hover:text-muted"
        onClick={() => setInstr((v) => (v === id ? null : id))}
      >
        {instr === id ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Instructions
      </button>
      {instr === id && <InstrArea value={roles[id].md} onSave={(md) => patchRole(id, { md })} />}
    </>
  );

  /** A renamable role label (click or pencil to edit). */
  const nameCell = (id: string) =>
    renaming === id ? (
      <RenameInput
        initial={roles[id].label}
        onCommit={(v) => {
          if (v) patchRole(id, { label: v });
          setRenaming(null);
        }}
        onCancel={() => setRenaming(null)}
      />
    ) : (
      <button
        className="group/label flex min-w-0 items-center gap-1 text-left"
        title="Rename role"
        onClick={() => setRenaming(id)}
      >
        <span className="truncate text-[13px] font-medium">{roles[id].label}</span>
        <Pencil size={10} className="shrink-0 text-faint opacity-0 transition-opacity group-hover/label:opacity-100" />
      </button>
    );

  return (
    <div
      ref={ref}
      className="glass absolute bottom-full left-0 z-40 mb-1.5 max-h-[72vh] w-[360px] overflow-y-auto p-1.5"
    >
      <div className="px-1.5 pb-1 pt-0.5 text-2xs text-faint">
        Toggle a specialist on to orchestrate this chat — the orchestrator delegates to it. Models &amp; names are saved
        globally; toggles are per-chat.
      </div>

      {/* Orchestrator — the chat itself; model/effort are the composer's own. */}
      <div className="rounded-ctl px-1.5 py-1.5">
        <div className="flex items-center gap-2">
          <Waypoints size={15} className="shrink-0 text-accent" />
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {nameCell(ORCHESTRATOR)}
            {noneOn && (
              <span
                className="shrink-0 rounded-full border border-warn px-1 text-[9px] leading-4 text-warn"
                title="Enable a specialist to activate the orchestrator"
              >
                Inactive
              </span>
            )}
          </div>
          {chips(ORCHESTRATOR)}
        </div>
        {pickers(ORCHESTRATOR)}
        {instructions(ORCHESTRATOR)}
      </div>

      <div className="my-1 border-t" />

      {/* Specialists — built-ins and user-added are identical: all renamable,
          editable, and deletable ("Reset to defaults" restores the built-ins). */}
      {specialists.map((id) => {
        const on = enabled.includes(id);
        return (
          <div key={id} className={clsx('rounded-ctl px-1.5 py-1.5 transition-colors', on && 'bg-accent-soft/25')}>
            <div className="flex items-center gap-2">
              <Switch on={on} onChange={(v) => toggle(id, v)} />
              <div className="min-w-0 flex-1">{nameCell(id)}</div>
              {chips(id)}
              <button
                className="shrink-0 rounded p-1 text-faint transition-colors hover:text-err"
                title="Delete role"
                onClick={() => deleteRole(id)}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {pickers(id)}
            {instructions(id)}
          </div>
        );
      })}

      <button
        onClick={addRole}
        className="mt-0.5 flex w-full items-center gap-1.5 rounded-ctl px-2 py-1.5 text-xs text-muted transition-colors hover:bg-accent-soft hover:text-fg"
      >
        <Plus size={13} /> Add role
      </button>

      <div className="mt-1 flex items-center border-t px-1.5 pt-1.5">
        <button className="flex items-center gap-1 text-2xs text-faint transition-colors hover:text-muted" onClick={reset}>
          <RotateCcw size={11} /> Reset to defaults
        </button>
      </div>
    </div>
  );
}
