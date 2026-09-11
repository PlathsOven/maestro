import React, { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Bot, Boxes, Check, ChevronLeft, Download, Folder, GitPullRequest, Play, RefreshCw } from 'lucide-react';
import { invoke, on, tryInvoke } from '../lib/api';
import { useApp } from '../store/app';
import { ApiKeyField, Kbd, Spinner } from './common';
import PtyView from './TerminalPanel';
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
    }
    void s.saveSettings(patch);
    // Logins done here outlive the wizard — refresh the cached detect sweep so
    // pickers and Settings agree with what just got connected.
    void s.refreshHarnesses(true);
  };

  const cta = step === 0 ? 'Get started' : step === 1 ? 'Continue' : 'Start using Maestro';

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="drag-region flex h-11 shrink-0 items-center justify-end px-3">
        {step < 2 && (
          <button className="btn btn-ghost no-drag wco-safe h-6 text-2xs text-muted" onClick={() => finish(true)}>
            Skip setup
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div key={step} className="fade-in m-auto w-[560px] max-w-full">
          {step === 0 && <WelcomeStep />}
          {step === 1 && (
            <AgentsStep authed={authed} setAuthed={(id, v) => setAuthed((m) => ({ ...m, [id]: v }))} />
          )}
          {step === 2 && <TourStep />}

          <div className="mt-7 flex items-center">
            <div className="flex-1">
              {step > 0 && (
                <button className="btn btn-ghost gap-1 text-xs text-muted" onClick={() => setStep((step - 1) as Step)}>
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
                    i === step ? 'w-4 bg-accent' : 'w-1.5 bg-border'
                  )}
                />
              ))}
            </div>
            <div className="flex flex-1 justify-end">
              <button
                className="btn btn-accent h-8 px-4 text-[13px]"
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
      <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border bg-raised">
        <img src={maestroLogo} alt="" className="h-10 w-10" />
      </div>
      <h1 className="text-[26px] font-semibold tracking-tight">Welcome to Maestro</h1>
      <p className="mx-auto mt-2 max-w-[400px] text-[13px] text-muted">
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
      <h1 className="text-center text-xl font-semibold tracking-tight">Connect your coding agents</h1>
      <p className="mx-auto mt-1.5 max-w-[430px] text-center text-[13px] text-muted">
        Maestro found these CLIs on your Mac automatically. Agents you're already signed in to just work — connect the
        rest here, or later in Settings.
      </p>

      <div className="mb-1.5 mt-6 flex items-center justify-between">
        <span className="text-2xs text-muted">
          {probing ? 'Looking for installed agents…' : `${connectedCount} of ${list.length} connected`}
        </span>
        <button className="btn btn-ghost h-6 gap-1 text-2xs text-muted" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw size={11} className={refreshing ? 'spin' : undefined} /> Refresh
        </button>
      </div>

      <div className="card overflow-hidden">
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
      </div>

      {noneInstalled && (
        <div
          className="mt-3 rounded-card border px-3 py-2.5 text-xs text-muted"
          style={{
            background: 'color-mix(in srgb, var(--warn) 8%, transparent)',
            borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)',
          }}
        >
          No agent CLIs found on this Mac. Install one — e.g.{' '}
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
    <div className={first ? undefined : 'border-t'}>
      <div className="flex items-center gap-3.5 px-4 py-3">
        <span
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-raised',
            connected ? 'text-ok' : info.installed ? 'text-accent' : 'text-faint'
          )}
          style={connected ? { background: 'color-mix(in srgb, var(--ok) 10%, transparent)' } : undefined}
        >
          {connected ? <Check size={17} /> : <Bot size={17} />}
        </span>
        <span className={clsx('min-w-0 flex-1', !info.installed && 'opacity-60')}>
          <span className="block text-[14px] font-medium">{info.displayName}</span>
          <span className="block truncate font-mono text-2xs text-muted">
            {info.installed ? (info.version ?? 'Installed') : 'Not installed'}
          </span>
        </span>
        {connected ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium text-ok"
            style={{ background: 'color-mix(in srgb, var(--ok) 12%, transparent)' }}
          >
            <Check size={11} /> Connected
          </span>
        ) : info.installed ? (
          <button className={clsx('btn shrink-0 text-xs', !open && 'btn-accent')} onClick={onToggle}>
            {open ? 'Close' : 'Connect'}
          </button>
        ) : (
          <button className="btn shrink-0 gap-1 text-xs" onClick={onToggle}>
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
  const [ptyId, setPtyId] = useState<string | null>(null);
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
  useEffect(() => {
    if (!ptyId) return;
    return on('pty:exit', ({ id }) => {
      if (id === ptyId) void refresh(true);
    });
  }, [ptyId, refresh]);

  // Never leave a login pty running when the row collapses or the step changes.
  useEffect(() => () => void invoke('harness:loginStop', { harness }), [harness]);

  const startLogin = async () => {
    const { data, error } = await tryInvoke('harness:loginStart', { harness });
    if (error) return toast('error', error);
    if (data) setPtyId(data.ptyId);
  };

  const closeLogin = async () => {
    await invoke('harness:loginStop', { harness });
    setPtyId(null);
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
      <div className="flex justify-center border-t bg-bg py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t bg-bg px-4 py-3.5">
      {auth.loginLabel && (
        <div className="space-y-2">
          {!ptyId ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted">Sign in with your existing account or subscription.</span>
              <button className="btn btn-accent shrink-0 gap-1.5 text-xs" onClick={() => void startLogin()}>
                <Play size={12} /> Run {auth.loginLabel}
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-2xs text-muted">Finish signing in below — a browser window may open.</span>
                <button className="btn btn-ghost h-6 text-xs" onClick={() => void closeLogin()}>
                  Done
                </button>
              </div>
              <div className="h-64 overflow-hidden rounded-card border">
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
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [cmd, setCmd] = useState<string | null>(null);
  const [phase, setPhase] = useState<'running' | 'failed'>('running');

  const start = useCallback(async () => {
    setPhase('running');
    const { data, error } = await tryInvoke('harness:installStart', { harness });
    if (error) {
      setPhase('failed');
      return toast('error', error);
    }
    if (data) {
      setCmd(data.cmd);
      setPtyId(data.ptyId);
    }
  }, [harness, toast]);

  // Clicking "Install" is the one click — kick off the installer as we open.
  useEffect(() => {
    void start();
  }, [start]);

  // Never leave an install pty running when the row collapses or the step changes.
  useEffect(() => () => void invoke('harness:installStop', { harness }), [harness]);

  // Installer exited → re-probe. A now-detected CLI is success (the row flips to
  // its Connect state); otherwise the terminal shows what failed — offer a retry.
  useEffect(() => {
    if (!ptyId) return;
    return on('pty:exit', ({ id }) => {
      if (id !== ptyId) return;
      void (async () => {
        await refreshHarnesses(true);
        const installed = useApp.getState().harnesses.find((h) => h.id === harness)?.installed;
        if (installed) toast('success', `${displayName} installed`);
        else setPhase('failed');
      })();
    });
  }, [ptyId, harness, displayName, refreshHarnesses, toast]);

  return (
    <div className="space-y-2 border-t bg-bg px-4 py-3.5">
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
            <button className="btn btn-accent h-6 text-xs" onClick={() => void start()}>
              Retry
            </button>
          )}
          <button className="btn btn-ghost h-6 text-xs" onClick={onClose}>
            {phase === 'failed' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
      {ptyId && (
        <div className="h-64 overflow-hidden rounded-card border">
          <PtyView workspaceId="" ptyId={ptyId} ensure={false} interactive active />
        </div>
      )}
    </div>
  );
}

// ---------- step 3: tour ----------

function TourStep() {
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
      <h1 className="text-center text-xl font-semibold tracking-tight">How Maestro works</h1>
      <p className="mt-1.5 text-center text-[13px] text-muted">Four ideas and you know the whole app.</p>

      <div className="card mt-6 overflow-hidden">
        {items.map((it, i) => (
          <div key={it.title} className={clsx('flex items-start gap-3.5 px-4 py-3.5', i > 0 && 'border-t')}>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-raised text-accent">
              {it.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium">{it.title}</span>
              <span className="block text-xs leading-relaxed text-muted">{it.blurb}</span>
            </span>
          </div>
        ))}
      </div>

      <p className="mt-4 text-center text-2xs text-muted">
        <Kbd>⌘K</Kbd> opens the command palette — every action is in there.
      </p>
    </div>
  );
}
