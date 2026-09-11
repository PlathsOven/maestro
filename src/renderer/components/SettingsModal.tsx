import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { RefreshCw, Volume2 } from 'lucide-react';
import { on, tryInvoke } from '../lib/api';
import { useApp, useActiveProject, useCaps } from '../store/app';
import { DoctorRowLine, Kbd, Modal, Spinner } from './common';
import { SHORTCUTS, acceleratorFromEvent, formatShortcut, type ShortcutId } from '../../shared/shortcuts';
import { useShortcuts } from '../lib/shortcuts';
import { COMPLETION_SOUNDS, SOUND_GROUP_ORDER, playCompletionSound } from '../lib/sounds';
import { hostAddress, hostLabel } from '../lib/hosts';
import HarnessesTab from './HarnessesSettings';
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

export default function SettingsModal() {
  const modal = useApp((s) => s.modal);
  const setModal = useApp((s) => s.setModal);
  const [tab, setTab] = useState<Tab>(modal?.kind === 'settings' ? (modal.tab ?? 'general') : 'general');

  return (
    <Modal title="Settings" onClose={() => setModal(null)} width={tab === 'harnesses' ? 780 : 620}>
      <div className="mb-4 flex gap-1 border-b pb-2">
        {(
          [
            ['general', 'General'],
            ['harnesses', 'Harnesses'],
            ['shortcuts', 'Shortcuts'],
            ['cloud', 'Cloud'],
            ['account', 'Account'],
            ['repository', 'Repository'],
            ['integrations', 'Integrations'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className={clsx(
              'rounded-ctl px-2.5 py-1 text-xs font-medium',
              tab === id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
            )}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'general' && <GeneralTab />}
      {tab === 'harnesses' && <HarnessesTab />}
      {tab === 'shortcuts' && <ShortcutsTab />}
      {tab === 'cloud' && <CloudTab />}
      {tab === 'account' && <AccountTab />}
      {tab === 'repository' && <RepositoryTab />}
      {tab === 'integrations' && <IntegrationsTab />}
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

const SHORTCUT_GROUPS = ['File', 'View', 'Workspace', 'Composer', 'Preview', 'Editor'] as const;

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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-2xs text-muted">Click a shortcut to change it. Esc cancels, ⌫ unbinds.</p>
        <button
          className="btn btn-ghost text-2xs"
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
          <div key={group}>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-faint">{group}</div>
            <div className="space-y-0.5">
              {rows.map((s) => {
                const cur = resolved[s.id];
                const isRec = recording === s.id;
                return (
                  <div key={s.id} className="flex items-center gap-2 py-0.5 text-xs">
                    <span className="flex-1 text-fg">{s.label}</span>
                    {isRec && warning && <span className="text-2xs text-err">{warning}</span>}
                    <button
                      className={clsx('min-w-[80px] text-right', isRec && 'text-accent')}
                      onClick={() => {
                        setWarning(null);
                        setRecording(s.id);
                      }}
                    >
                      {isRec ? <Kbd>Press keys…</Kbd> : cur ? <Kbd>{formatShortcut(cur, platform)}</Kbd> : <span className="text-2xs text-faint">unbound</span>}
                    </button>
                    <button
                      className="btn btn-ghost text-2xs text-muted"
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
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GeneralTab() {
  const settings = useApp((s) => s.settings);
  const harnesses = useApp((s) => s.harnesses);
  const save = (patch: Partial<GlobalSettings>) => void useApp.getState().saveSettings(patch);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Theme</label>
          <select className="input" value={settings.theme} onChange={(e) => save({ theme: e.target.value as never })}>
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
        <div>
          <label className="label">Default agent</label>
          <select
            className="input"
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
        </div>
        <div>
          <label className="label">Agent permissions</label>
          <select
            className="input"
            value={settings.permissionMode}
            onChange={(e) => save({ permissionMode: e.target.value as never })}
          >
            <option value="bypassPermissions">Full access — no prompts (recommended)</option>
            <option value="acceptEdits">Accept edits only (commands may fail)</option>
            <option value="plan">Plan mode</option>
            <option value="default">CLI default (blocks on prompts)</option>
          </select>
          <p className="mt-1 text-2xs text-faint">
            Workspaces are isolated worktrees, so agents run with full access and never ask for approval — like
            Conductor. Runs are non-interactive: anything stricter makes blocked commands fail.
          </p>
        </div>
        <div>
          <label className="label">Open in IDE command</label>
          <input
            className="input font-mono text-xs"
            placeholder="code | cursor | subl…"
            defaultValue={settings.ideCommand}
            onBlur={(e) => save({ ideCommand: e.target.value.trim() || 'code' })}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={settings.notifications}
          onChange={(e) => save({ notifications: e.target.checked })}
        />
        Notify when an agent finishes while Maestro is in the background
      </label>
      <div>
        <label className="label">Completion sound</label>
        <div className="flex items-center gap-2">
          <select
            className="input flex-1"
            value={settings.completionSound}
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
            className="btn shrink-0"
            disabled={settings.completionSound === 'none'}
            onClick={() => playCompletionSound(settings.completionSound)}
            title="Play the selected sound"
          >
            <Volume2 size={13} /> Test
          </button>
        </div>
        <p className="mt-1 text-2xs text-faint">
          Plays when an agent finishes working in a chat — synthesized from Maestro’s orchestra, so it works offline.
        </p>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={settings.refinePrompt}
          onChange={(e) => save({ refinePrompt: e.target.checked })}
        />
        Refine my prompts before sending — clearer &amp; more token-efficient, keeps every detail (uses your harness’s fastest model)
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={settings.autoStatus}
          onChange={(e) => save({ autoStatus: e.target.checked })}
        />
        Auto-generate the Status tab's AI digest — otherwise it only refreshes when you click Refresh
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={settings.autoDetectRunScripts}
          onChange={(e) => save({ autoDetectRunScripts: e.target.checked })}
        />
        Auto-detect run &amp; test scripts with AI when a workspace's Run tab first opens
      </label>
      <div className="rounded-card border bg-surface px-3 py-2.5 text-2xs text-muted">
        Agent CLIs use whatever login they already have (API key or subscription). Maestro never stores or manages
        model API keys.
      </div>
      <div>
        <div className="label">Detected agents</div>
        <div className="space-y-1">
          {harnesses.map((h) => (
            <div key={h.id} className="flex items-center justify-between text-xs">
              <span>{h.displayName}</span>
              <span className={h.installed ? 'font-mono text-2xs text-ok' : 'text-2xs text-faint'}>
                {h.installed ? (h.version ?? 'installed') : 'not installed'}
              </span>
            </div>
          ))}
        </div>
      </div>
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
    <div className="rounded-card border bg-surface px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-fg">Software update</div>
          <div className="mt-0.5 text-2xs text-faint">
            {version ? `Maestro v${version}` : 'Maestro'} · updates download and install automatically
          </div>
        </div>
        <button className="btn shrink-0" onClick={check} disabled={checking}>
          {checking ? <Spinner /> : <RefreshCw size={13} />}
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {progress ? (
        <div className="mt-2.5">
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
        status && <p className={clsx('mt-2 text-2xs', status.tone)}>{status.text}</p>
      )}
    </div>
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
    <div>
      <label className="label">New conversations run</label>
      <select className="input w-72" value={project.cloudHostId ?? ''} onChange={(e) => void save(e.target.value || null)}>
        <option value="">
          {appDefault ? `Follow the app default (${appDefaultLabel ?? 'cloud'})` : 'Locally — git worktrees'}
        </option>
        {hosts.map((h) => (
          <option key={h.id} value={h.id}>
            On {hostLabel(h)}
          </option>
        ))}
      </select>
      <p className="mt-1 text-2xs text-faint">
        Applies to conversations you create from now on, and every one is still overridable in the new-conversation
        picker. Existing conversations stay where they are.
      </p>
    </div>
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
    <div className="space-y-4">
      <div className="text-2xs text-muted">
        Stored in <code className="font-mono">.maestro/settings.toml</code> inside{' '}
        <code className="font-mono">{project.name}</code> — commit it to share with your team.
      </div>
      {/* Setup script restores ignored files a fresh worktree lacks — meaningless
          for an in-place folder (it already has them), so hidden for folder projects. */}
      {caps.git && (
        <div>
          <label className="label">Setup script — runs once per new workspace</label>
          <textarea
            className="input h-16 font-mono text-xs"
            placeholder={'npm install\ncp ~/secrets/.env .env'}
            value={repo.setupScript}
            onChange={(e) => setRepo({ ...repo, setupScript: e.target.value })}
          />
          <p className="mt-1 text-2xs text-faint">
            Worktrees only carry git-tracked files — restore .env, deps and local DBs here.
          </p>
        </div>
      )}
      <div className="rounded-ctl border border-dashed px-3 py-2 text-2xs text-faint">
        Run &amp; test scripts moved to the <span className="font-medium text-muted">Run</span> tab in the workspace
        dock — they're auto-detected with AI and editable there, no repo settings needed.
      </div>
      <div>
        <label className="label">Instructions — durable guidance for every agent</label>
        <textarea
          className="input h-24 text-xs"
          placeholder="Conventions, test commands, gotchas…"
          value={repo.instructions}
          onChange={(e) => setRepo({ ...repo, instructions: e.target.value })}
        />
      </div>
      {caps.git && (
        <div>
          <label className="label">Base branch</label>
          <input className="input w-56 font-mono text-xs" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
        </div>
      )}
      {caps.worktrees && !project.hostId && <ProjectRunsOn project={project} />}
      <div className="flex justify-end">
        <button className="btn btn-accent" onClick={() => void saveAll()} disabled={saving}>
          {saving ? <Spinner className="!text-white" /> : 'Save'}
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
    <div className="card !shadow-none p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-semibold">
          Maestro Cloud
          <span className="rounded bg-accent-soft px-1 py-0.5 text-[9px] font-medium text-accent">FREE BETA</span>
        </span>
        <span className={clsx('flex items-center gap-1 text-2xs', chip.cls)}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" /> {chip.text}
        </span>
      </div>
      <p className="text-2xs text-faint">
        A free always-on server with zero setup — shared, and slow when busy. Each user signs into their own harness
        account; usage is yours. Move any conversation to your own server anytime.
      </p>
      {managed ? (
        <div className="mt-2 flex items-center justify-between">
          <span className="text-2xs text-ok">Joined as {managed.user}</span>
          <button className="btn h-6 text-2xs text-muted" disabled={busy} onClick={() => void leave()}>
            {busy ? <Spinner /> : 'Leave Maestro Cloud'}
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <input
            className="input h-7 flex-1 text-xs"
            placeholder="invite code (if you have one)"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
          <button className="btn btn-accent h-7 shrink-0 text-2xs" disabled={busy || status === null} onClick={() => void join()}>
            {busy ? <Spinner /> : 'Use Maestro Cloud'}
          </button>
        </div>
      )}
    </div>
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
    <div className="card !shadow-none p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold">Kubernetes clusters</span>
        {!adding && (
          <button className="btn h-6 shrink-0 text-2xs" onClick={() => void openAdd()}>
            Add Kubernetes cluster…
          </button>
        )}
      </div>
      <p className="text-2xs text-faint">{K8S_BLURB}</p>

      {clusters.map((h) => {
        const st = hostStates[h.id];
        return (
          <div key={h.id} className="mt-2 rounded-ctl border p-2">
            <div className="flex items-center gap-2">
              <span
                className={clsx(
                  'h-2 w-2 shrink-0 rounded-full',
                  st === 'connected' ? 'bg-ok' : st === 'error' || st === 'disconnected' ? 'bg-err' : st ? 'bg-warn' : 'bg-muted'
                )}
              />
              <span className="min-w-0 flex-1 truncate text-xs">
                {h.label}
                <span className="ml-1.5 rounded bg-accent-soft px-1 py-0.5 text-[9px] font-medium text-accent">k8s</span>
                <span className="ml-1.5 font-mono text-2xs text-faint">
                  {h.k8s?.context}/{h.k8s?.namespace}
                </span>
              </span>
              <button className="btn h-6 shrink-0 text-2xs" disabled={checking === h.id} onClick={() => void check(h.id)}>
                {checking === h.id ? <Spinner /> : 'Check'}
              </button>
              <button className="btn h-6 shrink-0 text-2xs text-muted" onClick={() => void detach(h.id, h.label)}>
                Detach
              </button>
            </div>
            {rows[h.id] && (
              <div className="mt-2 overflow-hidden rounded-ctl border">
                {rows[h.id].map((r) => (
                  <DoctorRowLine key={r.label} row={r} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {adding && (
        <div className="mt-2 space-y-2 rounded-ctl border p-2">
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
              <div className="grid grid-cols-2 gap-2">
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
          <div className="flex justify-end gap-2">
            <button className="btn h-7 text-2xs text-muted" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn btn-accent h-7 text-2xs" disabled={busy || !context} onClick={() => void add()}>
              {busy ? <Spinner /> : 'Add cluster'}
            </button>
          </div>
          <p className="text-2xs text-faint">
            The node is one pod: parallel agents share its CPU and memory, like any box.
          </p>
        </div>
      )}
    </div>
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
    <div className="space-y-4">
      <MaestroCloudCard />
      <KubernetesCard />
      <div className="card !shadow-none p-3">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-xs font-semibold">Run new conversations in the cloud</span>
            <span className="text-2xs text-faint">New workspaces default to Cloud on your server; you can flip each one.</span>
          </span>
          <input type="checkbox" checked={cloud.defaultOn} onChange={(e) => save({ defaultOn: e.target.checked })} />
        </label>
      </div>

      <div className="card !shadow-none p-3">
        <div className="mb-1 text-xs font-semibold">Server</div>
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
          <button className="btn h-7 shrink-0 text-2xs" onClick={() => setModal({ kind: 'remote-folder' })}>
            Add / connect…
          </button>
        </div>
        <p className="mt-1 text-2xs text-faint">
          A cloud conversation runs on this always-on box (the same connect + harness-install flow as an SSH project).
          Close the app: the turn finishes, queued messages drain, dev servers keep serving — you catch up on return.
        </p>
      </div>

      <div className="card !shadow-none p-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold">Move all conversations to your server</span>
          <button
            className="btn btn-accent h-6 shrink-0 text-2xs"
            disabled={moving || !eligible.length || !cloud.hostId}
            onClick={() => void moveAll()}
          >
            {moving ? <Spinner /> : `Move ${eligible.length}`}
          </button>
        </div>
        <p className="text-2xs text-faint">{MOVE_COST}</p>
      </div>
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
  const [code, setCode] = useState<{ code: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => void tryInvoke('account:status').then((r) => r.data && setStatus(r.data));
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
    if (r.data) setCode({ code: r.data.code, url: r.data.url });
    else toast('error', r.error || 'Could not start linking.');
  };
  const signOut = async () => {
    await tryInvoke('account:signOut');
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

  if (!status) return <div className="p-4"><Spinner /></div>;

  return (
    <div className="space-y-4">
      <div className="card !shadow-none p-3">
        <div className="mb-1 text-xs font-semibold">Maestro Web</div>
        {!status.linked && !code && (
          <>
            <p className="text-2xs text-faint">
              See your fleet from your phone: sign in at{' '}
              <code className="font-mono">{status.relayUrl.replace(/^https?:\/\//, '')}</code>, then link this desktop.
              Your SSH keys and GitHub token never leave this machine.
            </p>
            <button className="btn btn-accent mt-2 h-7 text-2xs" disabled={busy === 'link'} onClick={() => void startLink()}>
              {busy === 'link' ? <Spinner /> : 'Link Maestro Web'}
            </button>
          </>
        )}
        {code && (
          <div className="text-2xs">
            <p className="text-faint">
              Open <code className="font-mono">{code.url.replace(/^https?:\/\//, '')}</code> on any device (signed in with
              GitHub) and enter this code:
            </p>
            <div className="my-2 select-all font-mono text-2xl tracking-[0.3em]">{code.code}</div>
            <p className="text-faint">Waiting for approval…</p>
          </div>
        )}
        {status.linked && !code && (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs">
                Linked as <span className="font-semibold">@{status.user?.login ?? '—'}</span> · {status.deviceName}
              </span>
              <div className="flex shrink-0 gap-1.5">
                <button className="btn h-6 text-2xs" disabled={busy === 'link'} onClick={() => void startLink()}>
                  {busy === 'link' ? <Spinner /> : 'Link another device'}
                </button>
                <button className="btn h-6 text-2xs" onClick={() => void signOut()}>
                  Sign out
                </button>
              </div>
            </div>
            <p className="mt-1.5 text-2xs text-faint">
              Phones and browsers just sign in with GitHub — you only need a code to link another computer.
            </p>
            <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
              <span className="min-w-0 text-2xs text-faint">
                Missing workspaces on the web? Push every workspace and its history up again.
              </span>
              <button className="btn h-6 shrink-0 text-2xs" disabled={busy === 'resync'} onClick={() => void resync()}>
                {busy === 'resync' ? <Spinner /> : 'Re-sync all'}
              </button>
            </div>
          </>
        )}
      </div>

      {(code || status.linked) && projects.length > 0 && (
        <div className="card !shadow-none p-3">
          <div className="mb-1 text-xs font-semibold">Projects to sync</div>
          <p className="mb-2 text-2xs text-faint">
            Choose which projects reach Maestro Web. Every project syncs by default — deselect any you'd rather keep off
            the cloud.{status.linked ? ' Deselecting one removes its conversations and diffs from the web.' : ''}
          </p>
          {projects.map((p) => {
            const synced = !status.projectOptOut.includes(p.id);
            return (
              <label key={p.id} className="flex items-center justify-between gap-3 border-t py-2 first:border-t-0">
                <span className="min-w-0">
                  <span className="block truncate text-xs">{p.name}</span>
                  <span className="block truncate text-2xs text-faint">{p.repoPath}</span>
                </span>
                {busy === `proj:${p.id}` ? (
                  <Spinner />
                ) : (
                  <input type="checkbox" checked={synced} onChange={(e) => void toggleProject(p.id, e.target.checked)} />
                )}
              </label>
            );
          })}
        </div>
      )}

      {status.linked && (
        <div className="card !shadow-none p-3">
          <div className="mb-1 text-xs font-semibold">Keep servers running when this desktop is closed</div>
          <p className="mb-2 text-2xs text-faint">
            Your conversations already reach your phone whenever this desktop is linked — this is separate. Turn it on
            for a server and its cloud tasks keep running (and stay send/stoppable from your phone) even with the
            desktop closed; turn one off to require this desktop to be open. On by default for every server. Uploads a
            small POSIX shell loop (maestro-sync) over the SSH connection you already trust — outbound HTTPS only.
          </p>
          {hosts.length === 0 && <p className="text-2xs text-faint">No saved servers yet.</p>}
          {hosts.map((h) => {
            const box = status.boxes[h.id];
            return (
              <label key={h.id} className="flex items-center justify-between gap-3 border-t py-2 first:border-t-0">
                <span className="min-w-0">
                  <span className="block truncate text-xs">{hostLabel(h)}</span>
                  {box && (
                    <span className="text-2xs text-faint">
                      {box.state === 'running' ? 'sync running' : box.state === 'installed' ? 'installed, not running' : box.state}
                      {box.cron ? ' · survives reboot' : ''}
                    </span>
                  )}
                </span>
                {busy === h.id ? (
                  <Spinner />
                ) : (
                  <input type="checkbox" checked={!!box} onChange={(e) => void toggleBox(h.id, e.target.checked, h.label)} />
                )}
              </label>
            );
          })}
        </div>
      )}

      <p className="text-2xs text-faint">
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
    <div className="space-y-4">
      <div className="card !shadow-none p-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold">GitHub CLI</span>
          <button
            className="btn h-6 text-2xs"
            onClick={async () => {
              setChecking(true);
              const r = await tryInvoke('github:auth');
              if (r.data) useApp.setState({ ghAuth: r.data });
              setChecking(false);
            }}
          >
            {checking ? <Spinner /> : 'Re-check'}
          </button>
        </div>
        {gh.authenticated ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-ok">Signed in as @{gh.user}</span>
            <button
              className="btn h-6 text-2xs text-muted"
              onClick={() => void useApp.getState().signOutGithub()}
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-warn">
              {gh.installed ? 'Not connected.' : 'GitHub CLI missing — sign-in installs it automatically.'}
            </span>
            <button
              className="btn btn-accent h-6 shrink-0 text-2xs"
              onClick={() => void useApp.getState().startGithubSignIn()}
            >
              Sign in with GitHub
            </button>
          </div>
        )}
        <p className="mt-1 text-2xs text-faint">
          One sign-in covers the GitHub CLI (PRs, checks, cloning) and git pushes — the token lives in gh's keyring,
          never in Maestro.
        </p>
      </div>

      <div className="card !shadow-none p-3">
        <div className="mb-1 text-xs font-semibold">Linear</div>
        <input
          className="input font-mono text-xs"
          type="password"
          placeholder="lin_api_…  (personal API key)"
          defaultValue={settings.linearToken}
          onBlur={(e) => void useApp.getState().saveSettings({ linearToken: e.target.value.trim() })}
        />
        <p className="mt-1 text-2xs text-faint">
          Enables "New workspace → from Linear issue". The token is stored locally only.
        </p>
      </div>

      {(hsDetected || hsEnabled) && (
        <div className="card !shadow-none p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold">Sync chats from Claude Code & Codex</span>
            <label className="flex cursor-pointer items-center gap-2 text-2xs text-muted">
              <input type="checkbox" checked={hsEnabled} onChange={toggleHs} /> Enabled
            </label>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs text-faint">
              {hsStatus
                ? `${hsStatus.mirrored} chat${hsStatus.mirrored === 1 ? '' : 's'} mirrored` +
                  (hsStatus.lastScanAt ? ` · last synced ${timeAgoShort(hsStatus.lastScanAt)}` : '')
                : 'Not scanned yet.'}
            </span>
            <button className="btn h-6 shrink-0 text-2xs" onClick={() => setModal({ kind: 'harness-sync' })}>
              Scan now…
            </button>
          </div>
          <p className="mt-1 text-2xs text-faint">
            Read-only: Maestro tails your Claude Code &amp; Codex transcripts so chats you start in either tool appear
            here and stay in sync. Your files are never modified.
          </p>
        </div>
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
