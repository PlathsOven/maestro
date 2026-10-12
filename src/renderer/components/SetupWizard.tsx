import React, { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Bot, Boxes, Check, ChevronLeft, Download, Folder, GitPullRequest, Play, RefreshCw } from 'lucide-react';
import { HarnessLogo } from '../../shared/ui/brandIcons';
import { on, tryInvoke } from '../lib/api';
import { useHarnessPty } from '../lib/useHarnessPty';
import { useApp } from '../store/app';
import { ApiKeyField, Kbd, Spinner } from './common';
import PtyView from './TerminalPanel';
import { LiquidGlass } from '../../shared/ui/LiquidGlass';
import maestroLogo from '../assets/maestro-logo.png';
import type { GlobalSettings, HarnessAuth, HarnessId, HarnessInfo } from '../../shared/types';

type Step = 0 | 1 | 2;

/** First-run setup: welcome → connect the agent CLIs Maestro auto-detected →
 *  a 30-second tour. Shown once per install (settings.onboarded gates it);
 *  skipping counts as done — it must never nag on the next launch. */
export default function SetupWizard() {
  const [step, setStep] = useState<Step>(0);
  // Live auth results from this session's connect panels — fresher than the
  // store list, whose `connected` flags come from main's 5-min detect cache.
  const [authed, setAuthed] = useState<Partial<Record<HarnessId, boolean>>>({});
  const [heardFrom, setHeardFrom] = useState<string | null>(null);

  // Smoke-test hook: `--smoke-actions=wizard-next,…` pages through the wizard
  // so a screenshot run can capture each pane. No menu item emits this action.
  useEffect(
    () =>
      on('menu:action', ({ action }) => {
        if (action === 'wizard-next') setStep((s) => (s < 2 ? ((s + 1) as Step) : s));
      }),
    []
  );

  const finish = (skipped: boolean) => {
    const s = useApp.getState();
    const patch: Partial<GlobalSettings> = { onboarded: true };
    if (!skipped) {
      // Default new workspaces to an agent that actually works on this machine.
      const connected = s.harnesses.filter((h) => h.id !== 'shell' && (authed[h.id] ?? h.connected));
      if (connected.length > 0 && !connected.some((h) => h.id === s.settings.defaultHarness)) {
        patch.defaultHarness = connected[0].id;
      }
      if (heardFrom) patch.heardFrom = heardFrom;
    }
    void s.saveSettings(patch);
    // Logins done here outlive the wizard — refresh the cached detect sweep so
    // pickers and Settings agree with what just got connected.
    void s.refreshHarnesses(true);
  };

  const cta = step === 0 ? 'Get started' : step === 1 ? 'Continue' : 'Start using Maestro';

  return (
    <div className="wash-hero flex h-full flex-col">
      <div className="drag-region flex h-11 shrink-0 items-center justify-end px-3">
        {step < 2 && (
          <button className="btn btn-ghost no-drag wco-safe text-muted hover:text-fg" onClick={() => finish(true)}>
            Skip setup
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 overflow-y-auto px-8 pb-12 pt-4">
        <div key={step} data-motion="swap" className="m-auto w-[580px] max-w-full">
          {step === 0 && <WelcomeStep />}
          {step === 1 && (
            <AgentsStep authed={authed} setAuthed={(id, v) => setAuthed((m) => ({ ...m, [id]: v }))} />
          )}
          {step === 2 && <TourStep heardFrom={heardFrom} setHeardFrom={setHeardFrom} />}

          <div className="mt-9 flex items-center">
            <div className="flex-1">
              {step > 0 && (
                <button className="btn btn-ghost h-9 gap-1 px-3.5 text-[13px] text-muted hover:text-fg" onClick={() => setStep((step - 1) as Step)}>
                  <ChevronLeft size={13} /> Back
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {([0, 1, 2] as const).map((i) => (
                <span
                  key={i}
                  className={clsx(
                    'h-1.5 rounded-full transition-all duration-200',
                    i === step ? 'w-5 bg-ink' : 'w-1.5 bg-faint/50'
                  )}
                />
              ))}
            </div>
            <div className="flex flex-1 justify-end">
              <button
                className="btn btn-accent h-9 px-5 text-[13px]"
                onClick={() => (step < 2 ? setStep((step + 1) as Step) : finish(false))}
              >
                {cta}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  return (
    <div className="text-center">
      <LiquidGlass
        radius={22}
        bezel={14}
        thickness={50}
        tint="strong"
        className="mx-auto mb-7 flex h-[72px] w-[72px] items-center justify-center"
      >
        <img src={maestroLogo} alt="" className="h-12 w-12" />
      </LiquidGlass>
      <h1 className="text-3xl font-semibold tracking-tight">Welcome to Maestro</h1>
      <p className="mx-auto mt-3 max-w-[420px] text-[14px] leading-relaxed text-muted">
        Run a fleet of coding agents in parallel — each in an isolated git worktree with its own branch, terminal, and
        diff.
      </p>
    </div>
  );
}

// ---------- step 2: connect agents ----------

function AgentsStep({
  authed,
  setAuthed,
}: {
  authed: Partial<Record<HarnessId, boolean>>;
  setAuthed: (id: HarnessId, connected: boolean) => void;
}) {
  const harnesses = useApp((s) => s.harnesses);
  const refreshHarnesses = useApp((s) => s.refreshHarnesses);
  const [open, setOpen] = useState<HarnessId | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The "shell" fallback needs no login; an empty list means the parallel
  // version probes from app boot haven't resolved yet.
  const list = harnesses.filter((h) => h.id !== 'shell');
  const probing = harnesses.length === 0;
  const isConnected = (h: HarnessInfo) => authed[h.id] ?? h.connected ?? false;
  const connectedCount = list.filter(isConnected).length;
  const noneInstalled = !probing && !list.some((h) => h.installed);

  const refresh = async () => {
    setRefreshing(true);
    await refreshHarnesses(true);
    setRefreshing(false);
  };

  return (
    <div>
      <h1 className="text-center text-2xl font-semibold tracking-tight">Connect your coding agents</h1>
      <p className="mx-auto mt-2.5 max-w-[440px] text-center text-[13px] leading-relaxed text-muted">
        Maestro found these CLIs on your Mac automatically. Agents you're already signed in to just work — connect the
        rest here, or later in Settings.
      </p>

      <div className="mb-2 mt-8 flex items-center justify-between px-1">
        <span className="text-xs text-muted">
          {probing ? 'Looking for installed agents…' : `${connectedCount} of ${list.length} connected`}
        </span>
        <button className="btn btn-ghost gap-1 text-muted hover:text-fg" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw size={11} className={refreshing ? 'spin' : undefined} /> Refresh
        </button>
      </div>

      <LiquidGlass radius={24} bezel={22} thickness={70} tint="strong" className="p-2">
        {probing ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted">
            <Spinner /> Detecting installed agents…
          </div>
        ) : (
          list.map((h, i) => (
            <AgentRow
              key={h.id}
              info={h}
              first={i === 0}
              connected={isConnected(h)}
              open={open === h.id}
              onToggle={() => setOpen(open === h.id ? null : h.id)}
              onStatus={(v) => setAuthed(h.id, v)}
              onConnected={() => setOpen(null)}
            />
          ))
        )}
      </LiquidGlass>

      {noneInstalled && (
        <div className="mt-3 rounded-card bg-warn/10 px-4 py-3 text-xs leading-relaxed text-muted">
          No agent CLIs found on this computer. Install one — e.g.{' '}
          <code className="font-mono text-2xs">npm install -g @anthropic-ai/claude-code</code> — then hit Refresh.
        </div>
      )}
    </div>
  );
}

function AgentRow({
  info,
  first,
  connected,
  open,
  onToggle,
  onStatus,
  onConnected,
}: {
  info: HarnessInfo;
  first: boolean;
  connected: boolean;
  open: boolean;
  onToggle: () => void;
  onStatus: (connected: boolean) => void;
  onConnected: () => void;
}) {
  return (
    <div className={clsx('rounded-[16px] transition-colors', !first && 'mt-0.5', open && 'bg-accent-soft')}>
      <div className="flex items-center gap-3.5 px-3 py-3">
        <span
          className={clsx(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
            connected ? 'bg-ok/10 text-ok' : info.installed ? 'bg-accent-soft text-fg' : 'bg-accent-soft text-faint'
          )}
        >
          {connected ? <Check size={17} /> : <HarnessLogo harness={info.id} size={19} />}
        </span>
        <span className={clsx('min-w-0 flex-1', !info.installed && 'opacity-60')}>
          <span className="block text-[14px] font-medium tracking-tight">{info.displayName}</span>
          <span className="block truncate font-mono text-2xs text-muted">
            {info.installed ? (info.version ?? 'Installed') : 'Not installed'}
          </span>
        </span>
        {connected ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-ok/10 px-2.5 py-1 text-2xs font-medium text-ok">
            <Check size={11} /> Connected
          </span>
        ) : info.installed ? (
          <button className={clsx('btn h-8 shrink-0 px-3.5', open && 'btn-ghost text-muted')} onClick={onToggle}>
            {open ? 'Close' : 'Connect'}
          </button>
        ) : (
          <button className={clsx('btn h-8 shrink-0 gap-1 px-3.5', open && 'btn-ghost text-muted')} onClick={onToggle}>
            {open ? (
              'Close'
            ) : (
              <>
                <Download size={12} /> Install
              </>
            )}
          </button>
        )}
      </div>
      {open &&
        (info.installed ? (
          <ConnectPanel harness={info.id} onStatus={onStatus} onConnected={onConnected} />
        ) : (
          <InstallPanel harness={info.id} displayName={info.displayName} onClose={onToggle} />
        ))}
    </div>
  );
}

/** Inline connect flow for one harness — a condensed HarnessesSettings panel:
 *  run the CLI's interactive login in an embedded terminal, or save an API key. */
function ConnectPanel({
  harness,
  onStatus,
  onConnected,
}: {
  harness: HarnessId;
  onStatus: (connected: boolean) => void;
  onConnected: () => void;
}) {
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const toast = useApp((s) => s.toast);
  const [auth, setAuth] = useState<HarnessAuth | null>(null);
  const [keyDraft, setKeyDraft] = useState(settings.harnessApiKeys?.[harness] ?? '');

  const refresh = useCallback(
    async (notify = false) => {
      const { data } = await tryInvoke('harness:auth', { harness });
      if (!data) return;
      setAuth(data);
      onStatus(data.connected);
      if (notify && data.connected) {
        toast('success', `${data.displayName} connected`);
        onConnected();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [harness]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A finished login terminal (browser flow returned / user quit) → re-probe.
  // Never leave a login pty running when the row collapses or the step changes.
  const login = useHarnessPty('login', harness, () => void refresh(true), [refresh]);
  const ptyId = login.ptyId;

  const startLogin = async () => {
    const { error } = await login.start();
    if (error) return toast('error', error);
  };

  const closeLogin = async () => {
    await login.stop();
    void refresh(true);
  };

  const saveKey = async () => {
    const key = keyDraft.trim();
    const next = { ...(settings.harnessApiKeys ?? {}) };
    if (key) next[harness] = key;
    else delete next[harness];
    await saveSettings({ harnessApiKeys: next });
    void refresh(true);
  };

  if (!auth) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-3 px-3 pb-3 pt-2">
      {auth.loginLabel && (
        <div className="space-y-2">
          {!ptyId ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted">Sign in with your existing account or subscription.</span>
              <button className="btn btn-accent h-8 shrink-0 gap-1.5 px-3.5" onClick={() => void startLogin()}>
                <Play size={12} /> Run {auth.loginLabel}
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-2xs text-muted">Finish signing in below — a browser window may open.</span>
                <button className="btn" onClick={() => void closeLogin()}>
                  Done
                </button>
              </div>
              <div className="h-64 overflow-hidden rounded-card border border-border/70">
                <PtyView workspaceId="" ptyId={ptyId} ensure={false} interactive active />
              </div>
            </div>
          )}
        </div>
      )}

      {auth.apiKey && (
        <ApiKeyField
          label={<span className="text-2xs font-medium text-muted">API key{auth.loginLabel ? ' (alternative)' : ''}</span>}
          url={auth.apiKey.url}
          envVar={auth.apiKey.envVar}
          value={keyDraft}
          onChange={setKeyDraft}
          onSave={() => void saveKey()}
        />
      )}
    </div>
  );
}

/** One-click installer for a not-yet-installed harness: runs the CLI's install
 *  command in an embedded terminal that drops down under the row. On exit we
 *  re-probe — a now-installed harness re-renders the row into its Connect state
 *  (AgentRow picks the panel by install status), so the flow reads install → connect. */
function InstallPanel({
  harness,
  displayName,
  onClose,
}: {
  harness: HarnessId;
  displayName: string;
  onClose: () => void;
}) {
  const refreshHarnesses = useApp((s) => s.refreshHarnesses);
  const toast = useApp((s) => s.toast);
  const [cmd, setCmd] = useState<string | null>(null);
  const [phase, setPhase] = useState<'running' | 'failed'>('running');

  // Never leave an install pty running when the row collapses or the step changes.
  // Installer exited → re-probe. A now-detected CLI is success (the row flips to
  // its Connect state); otherwise the terminal shows what failed — offer a retry.
  const install = useHarnessPty(
    'install',
    harness,
    () =>
      void (async () => {
        await refreshHarnesses(true);
        const installed = useApp.getState().harnesses.find((h) => h.id === harness)?.installed;
        if (installed) toast('success', `${displayName} installed`);
        else setPhase('failed');
      })(),
    [harness, displayName, refreshHarnesses, toast]
  );
  const { ptyId, start: startInstall } = install;

  const start = useCallback(async () => {
    setPhase('running');
    const { data, error } = await startInstall();
    if (error) {
      setPhase('failed');
      return toast('error', error);
    }
    if (data) setCmd(data.cmd);
  }, [startInstall, toast]);

  // Clicking "Install" is the one click — kick off the installer as we open.
  useEffect(() => {
    void start();
  }, [start]);

  return (
    <div className="space-y-2 px-3 pb-3 pt-2">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-2xs text-muted">
          {phase === 'failed' ? (
            "Install didn't finish — check the output below, then retry."
          ) : cmd ? (
            <>
              Running <code className="font-mono text-fg">{cmd}</code>
            </>
          ) : (
            'Starting install…'
          )}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {phase === 'failed' && (
            <button className="btn btn-accent" onClick={() => void start()}>
              Retry
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            {phase === 'failed' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
      {ptyId && (
        <div className="h-64 overflow-hidden rounded-card border border-border/70">
          <PtyView workspaceId="" ptyId={ptyId} ensure={false} interactive active />
        </div>
      )}
    </div>
  );
}

// ---------- step 3: tour ----------

const HEARD_FROM = ['Google', 'AI assistant', 'Reddit', 'GitHub', 'Hacker News', 'X / Twitter', 'Friend or colleague', 'Other'];

function TourStep({ heardFrom, setHeardFrom }: { heardFrom: string | null; setHeardFrom: (v: string | null) => void }) {
  const items: { icon: React.ReactNode; title: string; blurb: React.ReactNode }[] = [
    {
      icon: <Folder size={17} />,
      title: 'Open a project',
      blurb: 'Point Maestro at a git repo, clone one from GitHub, or just open any folder to work in it directly.',
    },
    {
      icon: <Boxes size={17} />,
      title: 'Spin up workspaces',
      blurb: (
        <>
          Each git workspace is an isolated worktree with its own branch, so agents never step on each other.{' '}
          <Kbd>⌘N</Kbd>
        </>
      ),
    },
    {
      icon: <Bot size={17} />,
      title: 'Run agents in parallel',
      blurb: 'Give every workspace a task — watch live status, answer questions, queue follow-ups.',
    },
    {
      icon: <GitPullRequest size={17} />,
      title: 'Review and ship',
      blurb: (
        <>
          Follow the live diff <Kbd>⌘⇧D</Kbd>, run checks, then merge or open a PR without leaving the app.
        </>
      ),
    },
  ];

  return (
    <div>
      <h1 className="text-center text-2xl font-semibold tracking-tight">How Maestro works</h1>
      <p className="mt-2.5 text-center text-[13px] text-muted">Four ideas and you know the whole app.</p>

      <LiquidGlass radius={24} bezel={22} thickness={70} tint="strong" className="mt-8 grid grid-cols-2 gap-1 p-2">
        {items.map((it) => (
          <div key={it.title} className="flex flex-col gap-3 rounded-[16px] px-4 py-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-fg">
              {it.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-medium tracking-tight">{it.title}</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted">{it.blurb}</span>
            </span>
          </div>
        ))}
      </LiquidGlass>

      <p className="mt-5 text-center text-xs text-muted">
        <Kbd>⌘K</Kbd> opens the command palette — every action is in there.
      </p>

      {/* Optional, one tap — referrers can't see AI chats or word of mouth. */}
      <div className="mt-7 text-center">
        <p className="text-xs text-muted">How did you hear about Maestro? (optional)</p>
        <div className="mt-2.5 flex flex-wrap justify-center gap-1.5">
          {HEARD_FROM.map((o) => (
            <button
              key={o}
              aria-pressed={heardFrom === o}
              onClick={() => setHeardFrom(heardFrom === o ? null : o)}
              className={clsx(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                heardFrom === o ? 'border-ink bg-ink text-on-ink' : 'bg-raised text-muted hover:text-fg'
              )}
            >
              {o}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
