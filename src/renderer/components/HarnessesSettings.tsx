import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { KeyRound, Play, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import { invoke, on, tryInvoke } from '../lib/api';
import { useApp } from '../store/app';
import { ApiKeyField, Spinner } from './common';
import AuthFix from './AuthFix';
import PtyView from './TerminalPanel';
import type { HarnessAuth, HarnessId, HarnessLoginView, HarnessLogins, SubUsage } from '../../shared/types';

/** Settings → Harnesses: per-harness connection status, an in-app interactive
 *  login terminal, and API-key entry — mirrors Conductor's Harnesses page. */
export default function HarnessesTab() {
  const harnesses = useApp((s) => s.harnesses);
  const defaultHarness = useApp((s) => s.settings.defaultHarness);
  // Real agents only — the "shell" fallback has no login.
  const list = harnesses.filter((h) => h.id !== 'shell');
  const [sel, setSel] = useState<HarnessId>(() => {
    if (defaultHarness !== 'shell' && list.some((h) => h.id === defaultHarness)) return defaultHarness;
    return (list.find((h) => h.installed)?.id ?? list[0]?.id ?? 'claude-code') as HarnessId;
  });

  return (
    <div className="space-y-4">
      <div className="-mt-1 flex flex-wrap gap-1 border-b pb-2">
        {list.map((h) => (
          <button
            key={h.id}
            className={clsx(
              'rounded-ctl px-2.5 py-1 text-xs font-medium',
              sel === h.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'
            )}
            onClick={() => setSel(h.id)}
          >
            {h.displayName}
          </button>
        ))}
      </div>
      {/* keyed so switching harnesses remounts with clean state + stops any login pty */}
      <HarnessAuthPanel key={sel} harness={sel} />
    </div>
  );
}

function HarnessAuthPanel({ harness }: { harness: HarnessId }) {
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const refreshHarnesses = useApp((s) => s.refreshHarnesses);
  const toast = useApp((s) => s.toast);
  const [auth, setAuth] = useState<HarnessAuth | null>(null);
  const [logins, setLogins] = useState<HarnessLogins | null>(null);
  const [loading, setLoading] = useState(true);
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [installPty, setInstallPty] = useState<string | null>(null);
  const [installCmd, setInstallCmd] = useState<string | null>(null);
  const [installFailed, setInstallFailed] = useState(false);
  const [keyDraft, setKeyDraft] = useState(settings.harnessApiKeys?.[harness] ?? '');

  const loadLogins = useCallback(
    async (force?: boolean) => {
      const { data } = await tryInvoke('harness:logins', { harness, force });
      if (data) setLogins(data);
    },
    [harness]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    const [{ data }] = await Promise.all([tryInvoke('harness:auth', { harness }), loadLogins(true)]);
    if (data) setAuth(data);
    setLoading(false);
  }, [harness, loadLogins]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Main pushes when the registry or active pointer changes (add/remove/switch/
  // rotate, or a profile filled in) — re-read the rows.
  useEffect(() => on('harness:logins', ({ harness: h }) => h === harness && void loadLogins()), [harness, loadLogins]);

  // A finished login terminal (browser flow returned / user quit) → re-probe.
  useEffect(() => {
    if (!ptyId) return;
    return on('pty:exit', ({ id }) => {
      if (id === ptyId) void refresh();
    });
  }, [ptyId, refresh]);

  // Installer exited → re-probe. A now-detected CLI is success (the panel flips
  // to its login/API-key state); otherwise the terminal shows what failed —
  // leave it up and offer a retry.
  useEffect(() => {
    if (!installPty) return;
    return on('pty:exit', ({ id }) => {
      if (id !== installPty) return;
      void (async () => {
        const { data } = await tryInvoke('harness:auth', { harness });
        if (data) setAuth(data);
        if (data?.installed) {
          toast('success', `${data.displayName} installed`);
          setInstallPty(null);
          setInstallCmd(null);
          void refreshHarnesses(true); // model pickers/composer see it too
        } else {
          setInstallFailed(true);
        }
      })();
    });
  }, [installPty, harness, toast, refreshHarnesses]);

  // Never leave a login or install pty running when the panel unmounts or the
  // harness switches.
  useEffect(
    () => () => {
      void invoke('harness:loginStop', { harness });
      void invoke('harness:installStop', { harness });
    },
    [harness]
  );

  const startInstall = async () => {
    setInstallFailed(false);
    const { data, error } = await tryInvoke('harness:installStart', { harness });
    if (error) return toast('error', error);
    if (data) {
      setInstallCmd(data.cmd);
      setInstallPty(data.ptyId);
    }
  };

  const cancelInstall = async () => {
    await invoke('harness:installStop', { harness });
    setInstallPty(null);
    setInstallCmd(null);
    setInstallFailed(false);
    void refresh();
  };

  const startLogin = async (loginId?: string) => {
    const { data, error } = await tryInvoke('harness:loginStart', { harness, loginId });
    if (error) return toast('error', error);
    if (data) setPtyId(data.ptyId);
  };

  const closeLogin = async () => {
    await invoke('harness:loginStop', { harness });
    setPtyId(null);
    void refresh();
  };

  // Add an empty login store, then immediately open its sign-in terminal so the
  // second account is one click away (no separate "sign in" step).
  const addLogin = async () => {
    const { data, error } = await tryInvoke('harness:loginAdd', { harness });
    if (error) return toast('error', error);
    await loadLogins();
    if (data) await startLogin(data.id);
  };

  const useLogin = async (loginId: string) => {
    await invoke('harness:setActiveLogin', { harness, loginId });
    void refresh(); // the status badge describes the active login
  };

  const removeLogin = async (loginId: string) => {
    const { error } = await tryInvoke('harness:loginRemove', { harness, loginId });
    if (error) return toast('error', error);
    void refresh();
  };

  const saveKey = async () => {
    const key = keyDraft.trim();
    const next = { ...(settings.harnessApiKeys ?? {}) };
    if (key) next[harness] = key;
    else delete next[harness];
    await saveSettings({ harnessApiKeys: next });
    toast('success', key ? 'API key saved' : 'API key cleared');
    void refresh();
  };

  if (loading && !auth) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  if (!auth) return <div className="text-xs text-muted">Couldn’t read harness status.</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {auth.connected ? (
            <span className="rounded-ctl bg-ok/10 px-1.5 py-0.5 text-2xs font-medium text-ok">Connected</span>
          ) : (
            <span className="rounded-ctl border px-1.5 py-0.5 text-2xs text-faint">
              {auth.fault ? 'Sign-in expired' : auth.installed ? 'Not connected' : 'Not installed'}
            </span>
          )}
          {auth.method && <span className="text-2xs text-muted">{auth.method}</span>}
        </div>
        <button className="btn btn-ghost gap-1 text-xs" onClick={() => void refresh()}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {!auth.installed &&
        (!installPty ? (
          <div className="flex items-center justify-between gap-3 rounded-card border bg-surface px-3 py-2.5">
            <span className="text-2xs text-muted">
              {auth.displayName} isn’t installed on this machine — Maestro can install it for you.
            </span>
            <button className="btn btn-accent h-6 shrink-0 gap-1 text-2xs" onClick={() => void startInstall()}>
              <Sparkles size={12} /> Install {auth.displayName}
            </button>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-2xs text-muted">
                {installFailed ? (
                  'Install didn’t finish — check the output below, then retry.'
                ) : (
                  <>
                    Running <code className="font-mono text-fg">{installCmd}</code>
                  </>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                {installFailed && (
                  <button className="btn btn-accent h-6 text-xs" onClick={() => void startInstall()}>
                    Retry
                  </button>
                )}
                <button className="btn btn-ghost h-6 text-xs" onClick={() => void cancelInstall()}>
                  {installFailed ? 'Close' : 'Cancel'}
                </button>
              </div>
            </div>
            <div className="h-64 overflow-hidden rounded-card border">
              <PtyView workspaceId="" ptyId={installPty} ensure={false} interactive active />
            </div>
          </div>
        ))}

      {auth.fault && (
        <div className="space-y-2 rounded-card border bg-surface px-3 py-2.5">
          <div className="flex gap-2 text-xs">
            <KeyRound size={13} className="mt-0.5 shrink-0 text-warn" />
            <span className="min-w-0 flex-1">{auth.fault.summary}</span>
          </div>
          <AuthFix harness={auth.fault.harness} onFixed={() => void refresh()} />
        </div>
      )}

      {(auth.version || auth.details.length > 0) && (
        <div className="divide-y overflow-hidden rounded-card border">
          {auth.version && <Row label="Version" value={auth.version} />}
          {auth.details.map((d) => (
            <Row key={d.label} label={d.label} value={d.value} />
          ))}
        </div>
      )}

      {auth.loginLabel && (
        <div className="space-y-2">
          {ptyId ? (
            // Shared sign-in terminal — one at a time, whether it's the single
            // login or a specific row's (multi-login). `claude auth login` exits
            // on its own; other CLIs' REPL logins stay open until Done.
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-2xs text-muted">Finish signing in below — a browser window may open.</span>
                <button className="btn btn-ghost text-xs" onClick={() => void closeLogin()}>
                  Done
                </button>
              </div>
              <div className="h-72 overflow-hidden rounded-card border">
                <PtyView workspaceId="" ptyId={ptyId} ensure={false} interactive active />
              </div>
            </div>
          ) : auth.multiLogin ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="label mb-0">Logins</label>
                <button
                  className="btn btn-ghost h-6 gap-1 text-2xs"
                  disabled={!auth.installed}
                  onClick={() => void addLogin()}
                >
                  <Plus size={12} /> Add login
                </button>
              </div>
              <div className="divide-y overflow-hidden rounded-card border">
                {(logins?.logins ?? []).map((l) => (
                  <LoginRow
                    key={l.id}
                    row={l}
                    active={l.id === logins?.activeId}
                    installed={auth.installed}
                    onUse={() => void useLogin(l.id)}
                    onSignIn={() => void startLogin(l.id)}
                    onRemove={() => void removeLogin(l.id)}
                  />
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={settings.loginRotation !== false}
                  onChange={(e) => void saveSettings({ loginRotation: e.target.checked })}
                />
                Rotate logins automatically when one hits a usage limit
              </label>
            </div>
          ) : (
            <button
              className="btn btn-accent gap-1.5 text-xs"
              disabled={!auth.installed}
              onClick={() => void startLogin()}
            >
              <Play size={12} /> Run {auth.loginLabel}
            </button>
          )}
          {!auth.installed && (
            <p className="text-2xs text-faint">Install {auth.displayName} above to log in from here.</p>
          )}
        </div>
      )}

      {auth.apiKey && (
        <ApiKeyField
          label={<label className="label mb-0">API key{auth.loginLabel ? ' (alternative)' : ''}</label>}
          url={auth.apiKey.url}
          envVar={auth.apiKey.envVar}
          value={keyDraft}
          onChange={setKeyDraft}
          onSave={() => void saveKey()}
          footer={
            <p className="text-2xs text-faint">
              Stored locally and injected as <span className="font-mono">{auth.apiKey.envVar}</span> for {auth.displayName}{' '}
              runs. Leave blank to use the CLI login{auth.loginLabel ? ' above' : ''}.
            </p>
          }
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between bg-surface px-3 py-1.5 text-xs">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-2xs">{value}</span>
    </div>
  );
}

/** The tightest usage window whose id starts with any of `prefixes`. */
function pickWindow(usage: SubUsage | null, prefixes: string[]) {
  return usage?.windows.find((w) => prefixes.some((p) => w.id.startsWith(p)));
}

/** A login row's one-line status: sign-in state, then plan + the session/weekly
 *  headroom, or a limited-until reset. */
function loginStatus(row: HarnessLoginView): string {
  if (!row.signedIn) return 'Not signed in';
  if (row.limitedUntil && row.limitedUntil > Date.now()) {
    return `Limited · resets ${new Date(row.limitedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  const parts: string[] = [];
  if (row.plan) parts.push(row.plan.toUpperCase());
  const session = pickWindow(row.usage, ['session', 'five_hour']);
  const weekly = pickWindow(row.usage, ['weekly_all', 'seven_day']);
  if (session) parts.push(`Session ${Math.round(session.pct)}%`);
  if (weekly) parts.push(`Weekly ${Math.round(weekly.pct)}%`);
  return parts.join(' · ');
}

/** One login in the Settings logins list: a radio dot, the label (+ email), a
 *  status cell, and per-row actions (Use / Sign in / remove). */
function LoginRow({
  row,
  active,
  installed,
  onUse,
  onSignIn,
  onRemove,
}: {
  row: HarnessLoginView;
  active: boolean;
  installed: boolean;
  onUse: () => void;
  onSignIn: () => void;
  onRemove: () => void;
}) {
  const isDefault = row.id === 'default';
  const emailUnder = row.email && row.label !== row.email ? row.email : null;
  return (
    <div className="flex items-center gap-2 bg-surface px-3 py-2">
      <span className={clsx('shrink-0 text-xs leading-none', active ? 'text-accent' : 'text-faint')}>
        {active ? '●' : '○'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs">{row.label}</div>
        {emailUnder && <div className="truncate font-mono text-2xs text-faint">{emailUnder}</div>}
      </div>
      <span className="shrink-0 text-2xs text-muted">{loginStatus(row)}</span>
      <div className="flex shrink-0 items-center gap-1">
        {!active && (
          <button className="btn btn-ghost h-6 text-2xs" disabled={!row.signedIn} onClick={onUse}>
            Use
          </button>
        )}
        <button className="btn btn-ghost h-6 text-2xs" disabled={!installed} onClick={onSignIn}>
          {row.signedIn ? 'Sign in again' : 'Sign in'}
        </button>
        {!isDefault && (
          <button
            className="btn btn-ghost h-6 !px-1 text-2xs text-muted hover:text-err"
            title="Remove login"
            onClick={onRemove}
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
