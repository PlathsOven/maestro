import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  CircleUser,
  Cloud,
  Cpu,
  FolderGit2,
  Keyboard,
  Plug,
  RefreshCw,
  SlidersHorizontal,
  Volume2,
  X,
} from 'lucide-react';
import maestroLogo from '../assets/maestro-logo.png';
import { GitHubMark, HarnessLogo } from '../../shared/ui/brandIcons';
import { on, tryInvoke } from '../lib/api';
import { useApp, useActiveProject, useCaps } from '../store/app';
import { DoctorRowLine, Kbd, Modal, Spinner, Toggle } from './common';
import { SHORTCUTS, acceleratorFromEvent, formatShortcut, type ShortcutId } from '../../shared/shortcuts';
import { useShortcuts } from '../lib/shortcuts';
import { COMPLETION_SOUNDS, SOUND_GROUP_ORDER, playCompletionSound, playQuestionSound, resolveSoundId } from '../lib/sounds';
import { hostLabel } from '../lib/hosts';
import { timeAgo } from '../../shared/ui/format';
import HarnessesTab, { SettingsRow, SettingsSection } from './HarnessesSettings';
import { ThemePicker } from '../../shared/ui/ThemePicker';
import { normalizeColorTheme } from '../../shared/themes';
import { isEffectsMode, lowEndReason } from '../../shared/ui/effects';
import type {
  AccountStatus,
  CloudStatus,
  DoctorRow,
  GlobalSettings,
  HarnessId,
  K8sContext,
  Project,
  RepoSettings,
  UpdateCheckOutcome,
} from '../../shared/types';

type Tab = 'general' | 'harnesses' | 'shortcuts' | 'repository' | 'integrations' | 'cloud' | 'account';

// Left-nav groups (sentence case).
const NAV: { group: string; items: [Tab, string, typeof Cpu][] }[] = [
  {
    group: 'Preferences',
    items: [
      ['general', 'General', SlidersHorizontal],
      ['harnesses', 'Harnesses', Cpu],
      ['shortcuts', 'Shortcuts', Keyboard],
    ],
  },
  {
    group: 'Connections',
    items: [
      ['integrations', 'Integrations', Plug],
      ['cloud', 'Cloud', Cloud],
      ['account', 'Account', CircleUser],
    ],
  },
  {
    group: 'This project',
    items: [['repository', 'Repository', FolderGit2]],
  },
];

export default function SettingsModal() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  const [tab, setTab] = useState<Tab>(modal?.kind === 'settings' ? (modal.tab ?? 'general') : 'general');
  const current = NAV.flatMap((g) => g.items).find(([id]) => id === tab);

  return (
    <Modal plain onClose={() => setModal(null)} width={880}>
      {/* The plain shell pads its body; the two-pane layout runs edge to edge. */}
      <div className="-m-6 flex h-[min(640px,72vh)]">
        <nav className="flex w-[196px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-border/60 px-3 py-5">
          <div className="px-2.5 text-[15px] font-semibold tracking-tight">Settings</div>
          {NAV.map((g) => (
            <div key={g.group} className="space-y-0.5">
              <div className="px-2.5 pb-1 text-2xs font-medium text-faint">{g.group}</div>
              {g.items.map(([id, label, Icon]) => (
                <button
                  key={id}
                  className={clsx(
                    'flex h-8 w-full items-center gap-2.5 rounded-ctl px-2.5 text-left text-[13px] transition-colors',
                    tab === id ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:bg-accent-soft/60 hover:text-fg'
                  )}
                  onClick={() => setTab(id)}
                >
                  <Icon size={14} className="shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="relative min-w-0 flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 flex h-0 justify-end">
            <button
              className="btn btn-ghost mr-3 mt-3 h-8 w-8 shrink-0 !px-0 text-muted hover:text-fg"
              title="Close"
              aria-label="Close settings"
              onClick={() => setModal(null)}
            >
              <X size={15} />
            </button>
          </div>
          <div key={tab} data-motion="swap" className="px-8 pb-8 pt-6">
            <h2 className="mb-6 text-lg font-semibold tracking-tight">{current?.[1] ?? 'Settings'}</h2>
            {tab === 'general' && <GeneralTab />}
            {tab === 'harnesses' && <HarnessesTab />}
            {tab === 'shortcuts' && <ShortcutsTab />}
            {tab === 'cloud' && <CloudTab />}
            {tab === 'account' && <AccountTab />}
            {tab === 'repository' && <RepositoryTab />}
            {tab === 'integrations' && <IntegrationsTab />}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Is this accelerator safe to bind? Must carry a primary modifier (⌘/Ctrl/Alt),
 *  unless it's an F-key or a Shift+<named key> chord (like Shift+Tab) — a bare
 *  letter/digit would swallow ordinary typing (§9). */
function validAccelerator(acc: string): boolean {
  const parts = acc.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.some((m) => m === 'CmdOrCtrl' || m === 'Cmd' || m === 'Ctrl' || m === 'Alt')) return true;
  if (/^F\d{1,2}$/.test(key)) return true;
  if (mods.includes('Shift') && key.length > 1) return true; // Shift+Tab-style
  return false;
}

const SHORTCUT_GROUPS = ['File', 'View', 'Workspace', 'Chat', 'Composer', 'Preview', 'Editor'] as const;

function ShortcutsTab() {
  const overrides = useApp((s) => s.settings.shortcuts);
  const platform = useApp((s) => s.platform);
  const resolved = useShortcuts();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const save = (patch: Partial<GlobalSettings>) => void useApp.getState().saveSettings(patch);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setRecording(null);
      if (e.key === 'Backspace' || e.key === 'Delete') {
        save({ shortcuts: { ...overrides, [recording]: null } }); // unbind
        setRecording(null);
        return;
      }
      const acc = acceleratorFromEvent(e, platform);
      if (!acc) return; // modifier-only so far — keep waiting for the real key
      if (!validAccelerator(acc)) {
        setWarning('Use ⌘/Ctrl or Alt (or an F-key / Shift+Tab-style chord).');
        return;
      }
      const clash = SHORTCUTS.find((s) => s.id !== recording && resolved[s.id] === acc);
      if (clash) {
        setWarning(`Already used by ${clash.label}`);
        return;
      }
      save({ shortcuts: { ...overrides, [recording]: acc } });
      setRecording(null);
      setWarning(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, overrides, platform, resolved]);

  return (
    <div className="space-y-8">
      <div className="-mt-3 flex items-center justify-between gap-4 px-1">
        <p className="text-xs text-muted">Click a shortcut to change it. Esc cancels, ⌫ unbinds.</p>
        <button
          className="btn"
          onClick={() => {
            save({ shortcuts: {} });
            setRecording(null);
            setWarning(null);
          }}
        >
          Reset all
        </button>
      </div>
      {SHORTCUT_GROUPS.map((group) => {
        const rows = SHORTCUTS.filter((s) => s.group === group);
        if (!rows.length) return null;
        return (
          <SettingsSection key={group} title={group}>
            {rows.map((s) => {
              const cur = resolved[s.id];
              const isRec = recording === s.id;
              return (
                <div key={s.id} className="group flex items-center gap-3 px-4 py-2 text-[13px]">
                  <span className="flex-1 text-fg">{s.label}</span>
                  {isRec && warning && <span className="text-2xs text-err">{warning}</span>}
                  <button
                    className={clsx(
                      'flex min-w-[88px] justify-end rounded-ctl px-1.5 py-1 hover:bg-accent-soft',
                      isRec && 'bg-accent-tint text-accent'
                    )}
                    onClick={() => {
                      setWarning(null);
                      setRecording(s.id);
                    }}
                  >
                    {isRec ? <Kbd>Press keys…</Kbd> : cur ? <Kbd>{formatShortcut(cur, platform)}</Kbd> : <span className="text-2xs text-faint">unbound</span>}
                  </button>
                  <button
                    className="btn btn-ghost text-muted opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    title="Reset to default"
                    onClick={() => {
                      const { [s.id]: _drop, ...rest } = overrides ?? {};
                      save({ shortcuts: rest });
                      if (recording === s.id) setRecording(null);
                    }}
                  >
                    Reset
                  </button>
                </div>
              );
            })}
          </SettingsSection>
        );
      })}
    </div>
  );
}

function GeneralTab() {
  const settings = useApp((s) => s.settings);
  const harnesses = useApp((s) => s.harnesses);
  const gpu = useApp((s) => s.gpu);
  const effects = isEffectsMode(settings.visualEffects) ? settings.visualEffects : 'auto';
  const lowEnd = lowEndReason(gpu);
  const save = (patch: Partial<GlobalSettings>) => void useApp.getState().saveSettings(patch);

  return (
    <div className="space-y-8">
      <SettingsSection title="Appearance & defaults">
        <SettingsRow
          stack
          label="Theme"
          description="Every theme has a light and a dark version. Maestro Web follows the theme you pick here."
        >
          <ThemePicker value={normalizeColorTheme(settings.colorTheme)} onChange={(colorTheme) => save({ colorTheme })} />
        </SettingsRow>
        <SettingsRow label="Mode" description="Light or dark, or follow your system.">
          <select className="input w-48" value={settings.theme} onChange={(e) => save({ theme: e.target.value as never })}>
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </SettingsRow>
        <SettingsRow
          label="Visual effects"
          description={
            'Glass and blur are drawn by your graphics card. Reduced swaps them for solid surfaces, which keeps Maestro smooth on older or integrated graphics.' +
            (effects === 'auto' ? (lowEnd ? ` Auto is using Reduced on this device (${lowEnd}).` : ' Auto is using Full on this device.') : '')
          }
        >
          <select className="input w-48" value={effects} onChange={(e) => save({ visualEffects: e.target.value as never })}>
            <option value="auto">Auto</option>
            <option value="full">Full</option>
            <option value="reduced">Reduced</option>
          </select>
        </SettingsRow>
        <SettingsRow label="Default agent" description="Used for new conversations.">
          <select
            className="input w-48"
            value={settings.defaultHarness}
            onChange={(e) => save({ defaultHarness: e.target.value as HarnessId })}
          >
            {harnesses.map((h) => (
              <option key={h.id} value={h.id}>
                {h.displayName}
                {h.installed ? '' : ' (not installed)'}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow
          label="Agent permissions"
          description="Workspaces are isolated worktrees, so agents run with full access and never ask for approval — like Conductor. Runs are non-interactive: anything stricter makes blocked commands fail."
        >
          <select
            className="input w-56"
            value={settings.permissionMode}
            onChange={(e) => save({ permissionMode: e.target.value as never })}
          >
            <option value="bypassPermissions">Full access — no prompts (recommended)</option>
            <option value="acceptEdits">Accept edits only (commands may fail)</option>
            <option value="plan">Plan mode</option>
            <option value="default">CLI default (blocks on prompts)</option>
          </select>
        </SettingsRow>
        <SettingsRow label="Open in IDE command">
          <input
            className="input w-48 font-mono text-xs"
            placeholder="code | cursor | subl…"
            key={settings.ideCommand} // an "Open in" pick changes it from outside
            defaultValue={settings.ideCommand}
            onBlur={(e) => save({ ideCommand: e.target.value.trim() || 'code' })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Notifications">
        <SettingsRow
          label="Notify when an agent finishes or asks a question"
          description="A notification in the background, a toast when it’s another workspace, and a dock badge for workspaces waiting on you"
        >
          <Toggle checked={settings.notifications} onChange={(v) => save({ notifications: v })} />
        </SettingsRow>
        <SettingsRow
          label="Completion sound"
          description="Plays when an agent finishes working in a chat — modelled on real instruments and synthesized live, so it works offline."
        >
          <select
            className="input w-44"
            value={resolveSoundId(settings.completionSound)}
            onChange={(e) => {
              save({ completionSound: e.target.value });
              playCompletionSound(e.target.value); // preview the pick immediately
            }}
          >
            <option value="none">No sound</option>
            {SOUND_GROUP_ORDER.map((group) => (
              <optgroup key={group} label={group}>
                {COMPLETION_SOUNDS.filter((s) => s.group === group).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            className="btn btn-ghost h-8 w-8 shrink-0 !px-0"
            disabled={settings.completionSound === 'none'}
            onClick={() => playCompletionSound(settings.completionSound)}
            title="Play the selected sound"
            aria-label="Test sound"
          >
            <Volume2 size={14} />
          </button>
        </SettingsRow>
        <SettingsRow
          label="Question alert"
          description="A distinct rising chime when an agent stops to ask you something — it can't continue until you answer."
        >
          <Toggle
            checked={settings.questionSound}
            onChange={(v) => {
              save({ questionSound: v });
              if (v) playQuestionSound();
            }}
          />
          <button
            className="btn btn-ghost h-8 w-8 shrink-0 !px-0"
            disabled={!settings.questionSound}
            onClick={() => playQuestionSound()}
            title="Play the question alert"
            aria-label="Test question alert"
          >
            <Volume2 size={14} />
          </button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Automation">
        <SettingsRow
          label="Refine my prompts before sending"
          description="Clearer & more token-efficient, keeps every detail (uses your harness’s fastest model)."
        >
          <Toggle checked={settings.refinePrompt} onChange={(v) => save({ refinePrompt: v })} />
        </SettingsRow>
        <SettingsRow
          label="Auto-generate the Status tab's AI digest"
          description="Otherwise it only refreshes when you click Refresh."
        >
          <Toggle checked={settings.autoStatus} onChange={(v) => save({ autoStatus: v })} />
        </SettingsRow>
        <SettingsRow
          label="Auto-detect run & test scripts"
          description="Uses AI when a workspace's Run tab first opens."
        >
          <Toggle checked={settings.autoDetectRunScripts} onChange={(v) => save({ autoDetectRunScripts: v })} />
        </SettingsRow>
        <SettingsRow
          label="Memory guard"
          description="Stop a process an agent started when it is about to use up this machine's memory."
        >
          <Toggle checked={settings.memoryGuard !== false} onChange={(v) => save({ memoryGuard: v })} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Storage">
        <SettingsRow
          label="Free disk space for archived workspaces"
          description="Clears an archived workspace's files, keeping its branch, uncommitted changes and local files. Restoring brings everything back."
        >
          <Toggle checked={settings.freeArchivedFiles !== false} onChange={(v) => save({ freeArchivedFiles: v })} />
        </SettingsRow>
        <SettingsRow
          label="Reuse dependencies between workspaces"
          description="New workspaces start with node_modules cloned from a sibling with the same lockfile — near-instant, and no extra disk."
        >
          <Toggle checked={settings.reuseDependencies !== false} onChange={(v) => save({ reuseDependencies: v })} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Detected agents"
        description="Agent CLIs use whatever login they already have (API key or subscription). Maestro never stores or manages model API keys."
      >
        {harnesses.map((h) => (
          <div key={h.id} className="flex items-center justify-between gap-6 px-4 py-2.5 text-[13px]">
            <span className="flex items-center gap-2.5">
              <HarnessLogo harness={h.id} size={15} className={h.installed ? 'text-fg' : 'text-faint'} />
              {h.displayName}
            </span>
            <span className={h.installed ? 'font-mono text-2xs text-ok' : 'text-2xs text-faint'}>
              {h.installed ? (h.version ?? 'installed') : 'not installed'}
            </span>
          </div>
        ))}
      </SettingsSection>

      <SoftwareUpdate />
    </div>
  );
}

/** Turn a check outcome into an inline status line (text + tone class). */
function describeUpdateOutcome(o: UpdateCheckOutcome): { text: string; tone: string } {
  switch (o.status) {
    case 'current':
      return { text: `You’re on the latest version (v${o.version}).`, tone: 'text-ok' };
    case 'available':
      return {
        text: `Update v${o.version} found — downloading now. You’ll be prompted to restart when it’s ready.`,
        tone: 'text-accent',
      };
    case 'downloaded':
      return {
        text: `Update v${o.version} is ready — use the restart prompt at the bottom-right to finish.`,
        tone: 'text-accent',
      };
    case 'disabled':
      return { text: 'Updates are disabled in development builds.', tone: 'text-faint' };
    case 'error':
      return { text: o.message || 'Couldn’t check for updates.', tone: 'text-err' };
  }
}

/** Shows the running version and a manual "Check for updates" button. */
function SoftwareUpdate() {
  const version = useApp((s) => s.appVersion);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<UpdateCheckOutcome | null>(null);
  // Live background-download progress. Non-null only while a download is in
  // flight; supersedes the check-outcome line so the bar is what the user sees.
  const [progress, setProgress] = useState<{ version: string; percent: number } | null>(null);

  useEffect(() => {
    const offProgress = on('update:progress', (p) => {
      // 100% arrives together with update:available (the restart prompt) — drop
      // the bar then so we don't leave a stale full bar sitting in Settings.
      setProgress(p.percent >= 100 ? null : p);
      setOutcome(null);
    });
    const offAvailable = on('update:available', () => setProgress(null));
    return () => {
      offProgress();
      offAvailable();
    };
  }, []);

  async function check() {
    setChecking(true);
    setOutcome(null);
    const { data, error } = await tryInvoke('update:check');
    setOutcome(data ?? { status: 'error', message: error ?? 'Couldn’t check for updates.' });
    setChecking(false);
  }

  const status = outcome && describeUpdateOutcome(outcome);
  return (
    <SettingsSection title="Software update">
      <div className="px-4 py-3.5">
        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <img src={maestroLogo} alt="" className="h-5 w-5" />
              {version ? `Maestro v${version}` : 'Maestro'}
            </div>
            <div className="mt-0.5 text-2xs text-muted">Updates download and install automatically.</div>
          </div>
          <button className="btn h-8 shrink-0 px-3.5" onClick={check} disabled={checking}>
            {checking ? <Spinner /> : <RefreshCw size={13} />}
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
        {progress ? (
          <div className="mt-3">
            <div className="flex items-center justify-between text-2xs text-accent">
              <span>Downloading v{progress.version}…</span>
              <span className="font-mono tabular-nums">{progress.percent}%</span>
            </div>
            <div
              className="mt-1 h-1.5 overflow-hidden rounded-full bg-accent-soft"
              role="progressbar"
              aria-valuenow={progress.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Downloading update v${progress.version}`}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        ) : (
          status && <p className={clsx('mt-2.5 text-2xs', status.tone)}>{status.text}</p>
        )}
      </div>
    </SettingsSection>
  );
}

/**
 * Where this project's NEW conversations run (kubernetes-workspaces.md §3.5) —
 * the middle link between the per-conversation picker and the app-wide default.
 * Saved immediately (it's one click, and nothing else on this sheet depends on it).
 */
function ProjectRunsOn({ project }: { project: Project }) {
  const hosts = useApp((s) => s.hosts);
  const settings = useApp((s) => s.settings);
  const toast = useApp((s) => s.toast);
  const appDefault = settings.cloud?.defaultOn ? (settings.cloud.hostId ?? null) : null;
  const appDefaultLabel = hosts.find((h) => h.id === appDefault)?.label;

  const save = async (hostId: string | null) => {
    const r = await tryInvoke('project:setCloudHost', { projectId: project.id, hostId });
    if (r.error || !r.data) return toast('error', r.error ?? 'Could not save');
    useApp.setState((s) => ({ projects: s.projects.map((p) => (p.id === r.data!.id ? r.data! : p)) }));
  };

  return (
    <SettingsRow
      label="New conversations run"
      description="Applies to conversations you create from now on, and every one is still overridable in the new-conversation picker. Existing conversations stay where they are."
    >
      <select className="input w-60" value={project.cloudHostId ?? ''} onChange={(e) => void save(e.target.value || null)}>
        <option value="">
          {appDefault ? `Follow the app default (${appDefaultLabel ?? 'cloud'})` : 'Locally — git worktrees'}
        </option>
        {hosts.map((h) => (
          <option key={h.id} value={h.id}>
            On {hostLabel(h)}
          </option>
        ))}
      </select>
    </SettingsRow>
  );
}

function RepositoryTab() {
  const project = useActiveProject();
  const caps = useCaps(project?.id);
  const toast = useApp((s) => s.toast);
  const [repo, setRepo] = useState<RepoSettings | null>(null);
  const [baseBranch, setBaseBranch] = useState(project?.baseBranch ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!project) return;
    void tryInvoke('project:settings:get', { projectId: project.id }).then((r) => {
      setRepo(r.data ?? { setupScript: '', runScript: '', instructions: '' });
    });
    setBaseBranch(project.baseBranch ?? '');
  }, [project?.id]);

  if (!project) return <div className="text-xs text-muted">Add a project first.</div>;
  if (!repo) return <Spinner />;

  const saveAll = async () => {
    setSaving(true);
    const r1 = await tryInvoke('project:settings:set', { projectId: project.id, settings: repo });
    let err = r1.error;
    if (baseBranch.trim() && baseBranch !== project.baseBranch) {
      const r2 = await tryInvoke('project:setBaseBranch', { projectId: project.id, baseBranch: baseBranch.trim() });
      err = err ?? r2.error;
      if (r2.data) {
        useApp.setState((s) => ({ projects: s.projects.map((p) => (p.id === r2.data!.id ? r2.data! : p)) }));
      }
    }
    setSaving(false);
    if (err) toast('error', err);
    else toast('success', 'Saved to .maestro/settings.toml');
  };

  return (
    <div className="space-y-8">
      <p className="-mt-3 px-1 text-xs text-muted">
        Stored in <code className="font-mono">.maestro/settings.toml</code> inside{' '}
        <code className="font-mono">{project.name}</code> — commit it to share with your team.
      </p>
      <SettingsSection title="Agents">
        {/* Setup script restores ignored files a fresh worktree lacks — meaningless
            for an in-place folder (it already has them), so hidden for folder projects. */}
        {caps.git && (
          <SettingsRow
            stack
            label="Setup script"
            description="Runs once per new workspace. Worktrees only carry git-tracked files — restore .env, deps and local DBs here."
          >
            <textarea
              className="input h-20 font-mono text-xs"
              placeholder={'npm install\ncp ~/secrets/.env .env'}
              value={repo.setupScript}
              onChange={(e) => setRepo({ ...repo, setupScript: e.target.value })}
            />
          </SettingsRow>
        )}
        <SettingsRow stack label="Instructions" description="Durable guidance for every agent.">
          <textarea
            className="input h-24 text-xs"
            placeholder="Conventions, test commands, gotchas…"
            value={repo.instructions}
            onChange={(e) => setRepo({ ...repo, instructions: e.target.value })}
          />
        </SettingsRow>
        <div className="px-4 py-3 text-2xs text-muted">
          Run &amp; test scripts moved to the <span className="font-medium text-fg">Run</span> tab in the workspace
          dock — they're auto-detected with AI and editable there, no repo settings needed.
        </div>
      </SettingsSection>
      {(caps.git || (caps.worktrees && !project.hostId)) && (
        <SettingsSection title="Branches & hosting">
          {caps.git && (
            <SettingsRow label="Base branch">
              <input className="input w-48 font-mono text-xs" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
            </SettingsRow>
          )}
          {caps.worktrees && !project.hostId && <ProjectRunsOn project={project} />}
        </SettingsSection>
      )}
      <div className="flex justify-end">
        <button className="btn btn-accent h-8 px-4" onClick={() => void saveAll()} disabled={saving}>
          {saving ? <Spinner className="!text-on-ink" /> : 'Save'}
        </button>
      </div>
    </div>
  );
}

const MOVE_COST =
  'The agent starts a fresh session on the other machine, seeded with each conversation’s history — the next ' +
  'message will take longer and use more tokens while it re-reads context. Branches and uncommitted changes move; ' +
  'chat history stays local.';

const CLOUD_JOIN_SHEET =
  'This free beta runs on one shared server. It’s isolated by user accounts, not hard walls — don’t put code or ' +
  'credentials here that you couldn’t stand a determined neighbor seeing. When it’s busy, everyone’s agents slow ' +
  'down. You can move any conversation to your own server at any time.\n\nJoin Maestro Cloud?';

/** Maestro Cloud free-beta card: live capacity chip + join / leave (§1). */
function MaestroCloudCard() {
  const hosts = useApp((s) => s.hosts);
  const toast = useApp((s) => s.toast);
  const managed = hosts.find((h) => h.managed);
  const [status, setStatus] = useState<CloudStatus | null | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState('');

  useEffect(() => {
    let alive = true;
    void tryInvoke('cloud:status').then((r) => alive && setStatus((r.data as CloudStatus | null) ?? null));
    return () => {
      alive = false;
    };
  }, []);

  const chip =
    status === 'loading'
      ? { text: 'checking…', cls: 'text-faint' }
      : !status
        ? { text: 'offline', cls: 'text-err' }
        : status.full
          ? { text: 'full right now', cls: 'text-warn' }
          : status.load1 > status.capacity * 0.7
            ? { text: 'busy — may be slow', cls: 'text-warn' }
            : { text: 'quiet right now', cls: 'text-ok' };

  const join = async () => {
    if (!confirm(CLOUD_JOIN_SHEET)) return;
    setBusy(true);
    const r = await tryInvoke('cloud:join', { inviteCode: invite.trim() || undefined });
    setBusy(false);
    const d = r.data;
    if (r.error || (d && !d.ok && !d.waitlisted && !d.full)) return toast('error', r.error || d?.error || 'Join failed');
    if (d?.waitlisted) return toast('error', 'You’re on the waitlist — Maestro Cloud is at capacity.');
    if (d?.full) return toast('error', 'Maestro Cloud is full right now — try again later, or use your own server.');
    if (d?.ok) {
      useApp.getState().refreshHosts?.();
      toast('success', 'Joined Maestro Cloud — sign into your harness in the readiness panel.');
    }
  };
  const leave = async () => {
    if (!confirm('Leave Maestro Cloud? This deletes your account and its host row.')) return;
    setBusy(true);
    const r = await tryInvoke('cloud:leave');
    setBusy(false);
    if (r.error || r.data?.ok === false) return toast('error', r.error || r.data?.error || 'Leave failed');
    useApp.getState().refreshHosts?.();
    toast('success', 'Left Maestro Cloud.');
  };

  return (
    <SettingsSection
      title={
        <span className="flex items-center gap-2">
          Maestro Cloud
          <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[10px] font-medium text-accent">Free beta</span>
        </span>
      }
      action={
        <span className={clsx('flex items-center gap-1.5 text-2xs', chip.cls)}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" /> {chip.text}
        </span>
      }
    >
      <div className="space-y-3 px-4 py-3.5">
        <p className="text-2xs leading-relaxed text-muted">
          A free always-on server with zero setup — shared, and slow when busy. Each user signs into their own harness
          account; usage is yours. Move any conversation to your own server anytime.
        </p>
        {managed ? (
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs text-ok">Joined as {managed.user}</span>
            <button className="btn shrink-0 text-muted" disabled={busy} onClick={() => void leave()}>
              {busy ? <Spinner /> : 'Leave Maestro Cloud'}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              className="input h-8 flex-1 text-xs"
              placeholder="invite code (if you have one)"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
            <button className="btn btn-accent h-8 shrink-0 px-3.5" disabled={busy || status === null} onClick={() => void join()}>
              {busy ? <Spinner /> : 'Use Maestro Cloud'}
            </button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

const K8S_BLURB =
  'Maestro provisions one always-on workspace node (a 1-replica StatefulSet + PVC running sshd) in a namespace on ' +
  'your cluster and reaches it through kubectl port-forward. Conversations are git worktrees on that node — code ' +
  'travels as git bundles over the tunnel, so no repo credentials ever reach the cluster.';

/** Kubernetes clusters card (kubernetes-workspaces.md §4): pick a context, pick
 *  a namespace, done. Provisioning happens on first connect; the readiness panel
 *  and install/sign-in flows are the same as any SSH box. */
function KubernetesCard() {
  const hosts = useApp((s) => s.hosts);
  const hostStates = useApp((s) => s.hostStates);
  const toast = useApp((s) => s.toast);
  const clusters = hosts.filter((h) => h.kind === 'k8s');
  const [adding, setAdding] = useState(false);
  const [contexts, setContexts] = useState<K8sContext[] | null>(null);
  const [kubectlErr, setKubectlErr] = useState<string | null>(null);
  const [context, setContext] = useState('');
  const [namespace, setNamespace] = useState('maestro');
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, DoctorRow[]>>({});

  const openAdd = async () => {
    setAdding(true);
    setContexts(null);
    setKubectlErr(null);
    const { data } = await tryInvoke('k8s:contexts');
    setContexts(data?.contexts ?? []);
    if (!data?.kubectl) setKubectlErr(data?.error ?? 'kubectl isn’t on your PATH. Install it and reopen Maestro.');
    else if (data.error) setKubectlErr(data.error);
    const current = data?.contexts.find((c) => c.current) ?? data?.contexts[0];
    if (current) setContext(current.name);
  };

  const add = async () => {
    if (!context) return toast('error', 'Pick a context first.');
    setBusy(true);
    const r = await tryInvoke('k8s:addCluster', { context, namespace: namespace.trim() || 'maestro', image: image.trim() || undefined });
    setBusy(false);
    if (r.error || !r.data?.ok) return toast('error', r.error || r.data?.error || 'Could not add the cluster');
    await useApp.getState().refreshHosts?.();
    setAdding(false);
    setImage('');
    toast('success', 'Cluster added — the workspace node is created on first use.');
  };

  const check = async (hostId: string) => {
    setChecking(hostId);
    const r = await tryInvoke('host:doctor', { hostId });
    setChecking(null);
    setRows((prev) => ({ ...prev, [hostId]: r.data?.rows ?? [] }));
    if (r.error) toast('error', r.error);
  };

  const detach = async (hostId: string, label: string) => {
    if (!confirm(`Detach "${label}"?\n\nBring its conversations local first — they can’t be reached afterwards.`)) return;
    const deleteNamespace = confirm(
      'Also delete the Maestro namespace on the cluster?\n\nOK deletes the node, its PVC and all work on it. Cancel keeps them (you can re-add the cluster later).'
    );
    const r = await tryInvoke('host:remove', { hostId, deleteNamespace });
    if (r.error || r.data?.ok === false) return toast('error', r.error || r.data?.error || 'Could not detach the cluster');
    await useApp.getState().refreshHosts?.();
    toast('success', deleteNamespace ? 'Cluster detached and namespace deleted.' : 'Cluster detached.');
  };

  return (
    <SettingsSection
      title="Kubernetes clusters"
      action={
        !adding && (
          <button className="btn shrink-0" onClick={() => void openAdd()}>
            Add Kubernetes cluster…
          </button>
        )
      }
    >
      <p className="px-4 py-3.5 text-2xs leading-relaxed text-muted">{K8S_BLURB}</p>

      {clusters.map((h) => {
        const st = hostStates[h.id];
        return (
          <div key={h.id} className="px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span
                className={clsx(
                  'h-2 w-2 shrink-0 rounded-full',
                  st === 'connected' ? 'bg-ok' : st === 'error' || st === 'disconnected' ? 'bg-err' : st ? 'bg-warn' : 'bg-muted'
                )}
              />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {h.label}
                <span className="ml-1.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-muted">k8s</span>
                <span className="ml-1.5 font-mono text-2xs font-normal text-faint">
                  {h.k8s?.context}/{h.k8s?.namespace}
                </span>
              </span>
              <button className="btn shrink-0" disabled={checking === h.id} onClick={() => void check(h.id)}>
                {checking === h.id ? <Spinner /> : 'Check'}
              </button>
              <button className="btn btn-ghost shrink-0 text-muted" onClick={() => void detach(h.id, h.label)}>
                Detach
              </button>
            </div>
            {rows[h.id] && (
              <div className="mt-2.5 overflow-hidden rounded-ctl border border-border/70">
                {rows[h.id].map((r) => (
                  <DoctorRowLine key={r.label} row={r} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {adding && (
        <div className="space-y-3 px-4 py-3.5">
          {kubectlErr && <p className="text-2xs text-warn">{kubectlErr}</p>}
          {contexts === null ? (
            <Spinner />
          ) : (
            <>
              <div>
                <label className="label">Context</label>
                <select className="input" value={context} onChange={(e) => setContext(e.target.value)}>
                  <option value="">Pick a kubeconfig context…</option>
                  {contexts.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                      {c.current ? ' (current)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Namespace</label>
                  <input className="input font-mono text-xs" value={namespace} onChange={(e) => setNamespace(e.target.value)} />
                </div>
                <div>
                  <label className="label">Image (optional)</label>
                  <input
                    className="input font-mono text-xs"
                    placeholder="default workspace node"
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-2xs text-muted">The node is one pod: parallel agents share its CPU and memory, like any box.</p>
            <div className="flex shrink-0 gap-2">
              <button className="btn btn-ghost text-muted" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button className="btn btn-accent" disabled={busy || !context} onClick={() => void add()}>
                {busy ? <Spinner /> : 'Add cluster'}
              </button>
            </div>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

function CloudTab() {
  const settings = useApp((s) => s.settings);
  const hosts = useApp((s) => s.hosts);
  const hostStates = useApp((s) => s.hostStates);
  const workspaces = useApp((s) => s.workspaces);
  const projects = useApp((s) => s.projects);
  const setModal = useApp((s) => s.setModal);
  const toast = useApp((s) => s.toast);
  const [moving, setMoving] = useState(false);
  const cloud = settings.cloud ?? { defaultOn: false, hostId: null };
  const save = (patch: Partial<{ defaultOn: boolean; hostId: string | null }>) =>
    void useApp.getState().saveSettings({ cloud: { ...cloud, ...patch } });

  const eligible = workspaces.filter((w) => {
    const p = projects.find((pp) => pp.id === w.projectId);
    return !w.archived && w.wsKind === 'worktree' && !w.hostId && p?.kind === 'git' && !p.hostId;
  });
  const dot = (id: string | null) => {
    const st = id ? hostStates[id] : undefined;
    return st === 'connected' || st === undefined ? 'bg-muted' : st === 'error' || st === 'disconnected' ? 'bg-err' : 'bg-warn';
  };

  const moveAll = async () => {
    if (!cloud.hostId) return toast('error', 'Pick a server first.');
    if (!confirm(`Move ${eligible.length} conversation(s) to your server?\n\n${MOVE_COST}`)) return;
    setMoving(true);
    for (const w of eligible) await tryInvoke('workspace:setCloud', { workspaceId: w.id, hostId: cloud.hostId });
    setMoving(false);
    toast('success', `Moved ${eligible.length} conversation(s) to the cloud.`);
  };

  return (
    <div className="space-y-8">
      <MaestroCloudCard />
      <SettingsSection title="Your server">
        <SettingsRow
          label="Run new conversations in the cloud"
          description="New workspaces default to Cloud on your server; you can flip each one."
        >
          <Toggle checked={cloud.defaultOn} onChange={(v) => save({ defaultOn: v })} />
        </SettingsRow>
        <SettingsRow
          stack
          label="Server"
          description="A cloud conversation runs on this always-on box (the same connect + harness-install flow as an SSH project). Close the app: the turn finishes, queued messages drain, dev servers keep serving — you catch up on return."
        >
          <div className="flex items-center gap-2">
            <span className={clsx('h-2 w-2 shrink-0 rounded-full', dot(cloud.hostId))} />
            <select
              className="input flex-1"
              value={cloud.hostId ?? ''}
              onChange={(e) => save({ hostId: e.target.value || null })}
            >
              <option value="">No server selected</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {hostLabel(h)}
                </option>
              ))}
            </select>
            <button className="btn h-8 shrink-0" onClick={() => setModal({ kind: 'remote-folder' })}>
              Add / connect…
            </button>
          </div>
        </SettingsRow>
        <SettingsRow label="Move all conversations to your server" description={MOVE_COST}>
          <button
            className="btn btn-accent shrink-0"
            disabled={moving || !eligible.length || !cloud.hostId}
            onClick={() => void moveAll()}
          >
            {moving ? <Spinner /> : `Move ${eligible.length}`}
          </button>
        </SettingsRow>
      </SettingsSection>
      <KubernetesCard />
    </div>
  );
}

/** Settings → Account (spec mobile-web-app §6.9): link this desktop to Maestro
 *  Web (device-code flow), and per saved SSH host toggle "Sync with Maestro Web"
 *  (uploads + launches maestro-sync). Mirrors the GitHub device-flow UX users
 *  already know. */
function AccountTab() {
  const hosts = useApp((s) => s.hosts);
  const projects = useApp((s) => s.projects);
  const toast = useApp((s) => s.toast);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  // A rejected/failed account:status must not strand the tab on a forever spinner
  // (account-tab spinner hang): show a retry instead of silently dropping the error.
  const [loadError, setLoadError] = useState(false);
  const [code, setCode] = useState<{ code: string; url: string } | null>(null);
  // Approving a link publishes every selected project at once, so the first link
  // asks the user to confirm which projects sync before a code is minted.
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Relay outage banner: the desktop's circuit breaker tells us the relay is
  // down and (from /api/health) why, so this doesn't read as "sync silently
  // stopped working" (web-relay-egress-quota §B2/§D).
  const [relayDown, setRelayDown] = useState<string | null>(null);
  // Live while a phone is watching, standby otherwise (web-relay-event-bus §4.4).
  const [mode, setMode] = useState<AccountStatus['mode'] | null>(null);
  // The relay came up without its event bus: it works, but live features are
  // per-instance and best-effort until it's provisioned (web-relay-event-bus §2.3).
  const [busDegraded, setBusDegraded] = useState(false);

  const refresh = () =>
    void tryInvoke('account:status').then((r) => {
      if (r.data) {
        setStatus(r.data);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    });
  useEffect(() => {
    const offRelay = on('account:relay-status', (e) => {
      setRelayDown(e.ok ? null : e.reason || 'The relay is unavailable.');
      if (e.mode) setMode(e.mode);
      if (e.bus) setBusDegraded(e.bus !== 'redis');
    });
    return offRelay;
  }, []);
  useEffect(() => {
    refresh();
    const off = on('account:auth', (e) => {
      if (e.phase === 'success') {
        setCode(null);
        if (e.status) setStatus(e.status);
        else refresh();
        toast('success', 'Maestro Web linked.');
      } else if (e.phase === 'error') {
        setCode(null);
        toast('error', e.message || 'Linking failed.');
      } else if (e.phase === 'signedout') {
        setCode(null);
        refresh();
      }
    });
    return off;
  }, []);

  const startLink = async () => {
    setBusy('link');
    const r = await tryInvoke('account:linkStart', {});
    setBusy(null);
    setConfirming(false);
    if (r.data) setCode({ code: r.data.code, url: r.data.url });
    else toast('error', r.error || 'Could not start linking.');
  };
  const signOut = async () => {
    await tryInvoke('account:signOut');
    refresh();
  };
  const unlinkDevice = async (deviceId: string) => {
    setBusy(`dev:${deviceId}`);
    const r = await tryInvoke('account:deviceUnlink', { deviceId });
    setBusy(null);
    if (!r.data?.ok) toast('error', r.data?.error || r.error || 'Could not unlink that device.');
    else toast('success', 'Device unlinked.');
    refresh();
  };
  const resync = async () => {
    setBusy('resync');
    const r = await tryInvoke('account:resync');
    setBusy(null);
    if (r.error) toast('error', r.error || 'Could not re-sync.');
    else toast('success', `Re-syncing ${r.data?.workspaces ?? 0} workspace${r.data?.workspaces === 1 ? '' : 's'} — they'll appear on Maestro Web shortly.`);
    refresh();
  };
  const toggleBox = async (hostId: string, on: boolean, label?: string) => {
    setBusy(hostId);
    if (on) {
      const cron = confirm('Keep sync running after the box reboots?\n\nThis installs two visible crontab lines (a @reboot launch + a 10-minute watchdog).');
      const r = await tryInvoke('account:boxLink', { hostId, label, cron });
      if (!r.data?.ok) toast('error', r.data?.error || r.error || 'Could not link the box.');
    } else {
      await tryInvoke('account:boxUnlink', { hostId });
    }
    setBusy(null);
    refresh();
  };
  const toggleProject = async (projectId: string, synced: boolean) => {
    setBusy(`proj:${projectId}`);
    await tryInvoke('account:setProjectSync', { projectId, synced });
    setBusy(null);
    refresh();
  };

  if (!status)
    return (
      <div className="py-6">
        {loadError ? (
          <div className="space-y-3 text-xs text-muted">
            <div>Couldn't load your account details.</div>
            <button
              className="btn"
              onClick={() => {
                setLoadError(false);
                refresh();
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    );

  return (
    <div className="space-y-8">
      <SettingsSection title="Maestro Web">
        {(relayDown || busDegraded) && (
          <div className="space-y-1 bg-warn/10 px-4 py-2.5 text-2xs text-warn">
            {relayDown && (
              <div>Maestro Web relay unavailable — {relayDown} Publishing is paused and will resume automatically.</div>
            )}
            {busDegraded && <div>Relay running without its event bus — live features degraded.</div>}
          </div>
        )}
        {!status.linked && !code && !confirming && (
          <SettingsRow
            label="Link this desktop"
            description={
              <>
                See your fleet from your phone: sign in at{' '}
                <code className="font-mono">{status.relayUrl.replace(/^https?:\/\//, '')}</code>, then link this desktop.
                Your SSH keys and GitHub token never leave this machine.
              </>
            }
          >
            <button className="btn btn-accent h-8 px-3.5" onClick={() => setConfirming(true)}>
              Link Maestro Web
            </button>
          </SettingsRow>
        )}
        {!status.linked && !code && confirming && (
          <SettingsRow
            label="Confirm what syncs"
            description="Linking uploads the conversations, transcripts, and diffs of every project selected below to Maestro Web."
          >
            <button className="btn btn-ghost text-muted" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="btn btn-accent h-8 px-3.5" disabled={busy === 'link'} onClick={() => void startLink()}>
              {busy === 'link' ? <Spinner /> : 'Confirm & link'}
            </button>
          </SettingsRow>
        )}
        {code && (
          <div className="px-4 py-5 text-center text-2xs">
            <p className="text-muted">
              Open <code className="font-mono">{code.url.replace(/^https?:\/\//, '')}</code> on any device (signed in with
              GitHub) and enter this code:
            </p>
            <div className="my-3 select-all font-mono text-2xl font-medium tracking-[0.3em]">{code.code}</div>
            <p className="text-faint">Waiting for approval…</p>
          </div>
        )}
        {status.linked && !code && (
          <>
            <SettingsRow
              label={
                <>
                  Linked as @{status.user?.login ?? '—'}
                  {/* The device list below names every desktop; fall back to this one's
                      name only when the relay was unreachable (empty list). */}
                  {status.devices.length === 0 && <span className="font-normal text-muted"> · {status.deviceName}</span>}
                </>
              }
              description={
                <>
                  {(mode ?? status.mode) !== 'legacy' && (
                    <span className="block">
                      {(mode ?? status.mode) === 'live'
                        ? 'Live — a phone is connected.'
                        : 'Standby — wakes within 30s when you send from your phone.'}
                    </span>
                  )}
                  Phones and browsers just sign in with GitHub — you only need a code to link another computer.
                </>
              }
            >
              <button className="btn" disabled={busy === 'link'} onClick={() => void startLink()}>
                {busy === 'link' ? <Spinner /> : 'Link another device'}
              </button>
              <button className="btn btn-ghost text-muted" onClick={() => void signOut()}>
                Sign out
              </button>
            </SettingsRow>
            <SettingsRow
              label="Re-sync all"
              description="Missing workspaces on the web? Push every workspace and its history up again."
            >
              <button className="btn" disabled={busy === 'resync'} onClick={() => void resync()}>
                {busy === 'resync' ? <Spinner /> : 'Re-sync all'}
              </button>
            </SettingsRow>
          </>
        )}
      </SettingsSection>

      {status.linked && !code && status.devices.length > 0 && (
        <SettingsSection title="Linked desktops">
          {status.devices.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">
                  {d.name || 'Desktop'}
                  {d.current && <span className="font-normal text-muted"> · this device</span>}
                </span>
                <span className="block truncate text-2xs text-muted">
                  {[d.platform, d.lastSeenAt ? `last seen ${timeAgo(new Date(d.lastSeenAt).getTime())}` : null]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </span>
              </span>
              {d.current ? null : busy === `dev:${d.id}` ? (
                <Spinner />
              ) : (
                <button className="btn shrink-0" onClick={() => void unlinkDevice(d.id)}>
                  Unlink
                </button>
              )}
            </div>
          ))}
        </SettingsSection>
      )}

      {(confirming || code || status.linked) && projects.length > 0 && (
        <SettingsSection
          title="Projects to sync"
          description={
            <>
              Choose which projects reach Maestro Web. Every project syncs by default — deselect any you'd rather keep
              off the cloud.{status.linked ? ' Deselecting one removes its conversations and diffs from the web.' : ''}
            </>
          }
        >
          {projects.map((p) => {
            const synced = !status.projectOptOut.includes(p.id);
            return (
              <div key={p.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{p.name}</span>
                  <span className="block truncate text-2xs text-muted">{p.repoPath}</span>
                </span>
                {busy === `proj:${p.id}` ? (
                  <Spinner />
                ) : (
                  <Toggle checked={synced} onChange={(v) => void toggleProject(p.id, v)} />
                )}
              </div>
            );
          })}
        </SettingsSection>
      )}

      {status.linked && (
        <SettingsSection
          title="Keep servers running when this desktop is closed"
          description="Your conversations already reach your phone whenever this desktop is linked — this is separate. Turn it on for a server and its cloud tasks keep running (and stay send/stoppable from your phone) even with the desktop closed; turn one off to require this desktop to be open. On by default for every server. Uploads a small POSIX shell loop (maestro-sync) over the SSH connection you already trust — outbound HTTPS only."
        >
          {hosts.length === 0 && <p className="px-4 py-3 text-2xs text-muted">No saved servers yet.</p>}
          {hosts.map((h) => {
            const box = status.boxes[h.id];
            return (
              <div key={h.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{hostLabel(h)}</span>
                  {box && (
                    <span className="text-2xs text-muted">
                      {box.state === 'running' ? 'sync running' : box.state === 'installed' ? 'installed, not running' : box.state}
                      {box.cron ? ' · survives reboot' : ''}
                    </span>
                  )}
                </span>
                {busy === h.id ? (
                  <Spinner />
                ) : (
                  <Toggle checked={!!box} onChange={(v) => void toggleBox(h.id, v, h.label)} />
                )}
              </div>
            );
          })}
        </SettingsSection>
      )}

      <p className="px-1 text-2xs leading-relaxed text-faint">
        The relay stores conversation metadata, transcripts, and queued messages for synced conversations — visible to
        no other user, and hidden from the web the moment no device or server is linked. Sign out here and unlink your
        servers to clear it; delete your account from Maestro Web → Settings to erase the stored data for good.
      </p>
    </div>
  );
}

function IntegrationsTab() {
  const gh = useApp((s) => s.ghAuth);
  const settings = useApp((s) => s.settings);
  const hsStatus = useApp((s) => s.harnessSyncStatus);
  const hsDetected = useApp((s) => s.harnessSyncDetected);
  const setModal = useApp((s) => s.setModal);
  const [checking, setChecking] = useState(false);

  const hsEnabled = settings.harnessSync?.enabled ?? false;
  const toggleHs = () =>
    void useApp.getState().saveSettings({
      harnessSync: { enabled: !hsEnabled, dismissedRoots: settings.harnessSync?.dismissedRoots ?? [] },
    });

  return (
    <div className="space-y-8">
      <SettingsSection
        title="GitHub"
        description="One sign-in covers the GitHub CLI (PRs, checks, cloning) and git pushes — the token lives in gh's keyring, never in Maestro."
      >
        <SettingsRow
          label="GitHub CLI"
          description={
            gh.authenticated ? (
              <span className="text-ok">Signed in as @{gh.user}</span>
            ) : (
              <span className="text-warn">
                {gh.installed ? 'Not connected.' : 'GitHub CLI missing — sign-in installs it automatically.'}
              </span>
            )
          }
        >
          <button
            className="btn btn-ghost text-muted"
            onClick={async () => {
              setChecking(true);
              const r = await tryInvoke('github:auth');
              if (r.data) useApp.setState({ ghAuth: r.data });
              setChecking(false);
            }}
          >
            {checking ? <Spinner /> : 'Re-check'}
          </button>
          {gh.authenticated ? (
            <button className="btn" onClick={() => void useApp.getState().signOutGithub()}>
              Sign out
            </button>
          ) : (
            <button className="btn btn-accent" onClick={() => void useApp.getState().startGithubSignIn()}>
              <GitHubMark size={14} />
              Sign in with GitHub
            </button>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Linear">
        <SettingsRow
          label="Personal API key"
          description='Enables "New workspace → from Linear issue". The token is stored locally only.'
        >
          <input
            className="input w-56 font-mono text-xs"
            type="password"
            placeholder="lin_api_…  (personal API key)"
            defaultValue={settings.linearToken}
            onBlur={(e) => void useApp.getState().saveSettings({ linearToken: e.target.value.trim() })}
          />
        </SettingsRow>
      </SettingsSection>

      {(hsDetected || hsEnabled) && (
        <SettingsSection
          title="Sync chats from Claude Code & Codex"
          description="Read-only: Maestro tails your Claude Code & Codex transcripts so chats you start in either tool appear here and stay in sync. Your files are never modified."
        >
          <SettingsRow label="Enabled">
            <Toggle checked={hsEnabled} onChange={toggleHs} />
          </SettingsRow>
          <SettingsRow
            label="Status"
            description={
              hsStatus
                ? `${hsStatus.mirrored} chat${hsStatus.mirrored === 1 ? '' : 's'} mirrored` +
                  (hsStatus.lastScanAt ? ` · last synced ${timeAgoShort(hsStatus.lastScanAt)}` : '')
                : 'Not scanned yet.'
            }
          >
            <button className="btn" onClick={() => setModal({ kind: 'harness-sync' })}>
              Scan now…
            </button>
          </SettingsRow>
        </SettingsSection>
      )}
    </div>
  );
}

function timeAgoShort(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
