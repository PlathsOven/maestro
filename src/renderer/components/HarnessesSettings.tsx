import { useCallback, useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { KeyRound, Play, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import { invoke, on, tryInvoke } from '../lib/api';
import { useHarnessPty } from '../lib/useHarnessPty';
import { useApp } from '../store/app';
import { ApiKeyField, Segmented, Spinner, Toggle } from './common';
import AuthFix from './AuthFix';
import PtyView from './TerminalPanel';
import type { HarnessAuth, HarnessId, HarnessLoginView, HarnessLogins, SubUsage } from '../../shared/types';

/** Settings layout (shared with SettingsModal, which imports this file): a
 *  titled group of aligned two-column rows on one quiet card — Lovable-style.
 *  Rows put the label + description on the left and the control on the right;
 *  `stack` puts a wide control (textarea, list, terminal) under the label. */
export function SettingsSection({
  title,
  description,
  action,
  children,
  bare,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  /** Children sit directly on the page instead of inside the card. */
  bare?: boolean;
}) {
  return (
    <section className="space-y-2.5">
      {(title || action) && (
        <div className="flex items-end justify-between gap-4 px-1">
          <div className="min-w-0">
            {title && <h3 className="text-[13px] font-medium text-fg">{title}</h3>}
            {description && <p className="mt-0.5 text-2xs leading-relaxed text-muted">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
        </div>
      )}
      {bare ? (
        children
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-card border border-border/70 bg-raised">
          {children}
        </div>
      )}
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  stack,
}: {
  label?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  stack?: boolean;
}) {
  const text = (label || description) && (
    <div className="min-w-0 flex-1">
      {label && <div className="text-[13px] font-medium text-fg">{label}</div>}
      {description && <div className="mt-0.5 text-2xs leading-relaxed text-muted">{description}</div>}
    </div>
  );
  if (stack) {
    return (
      <div className="space-y-2.5 px-4 py-3.5">
        {text}
        {children}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      {text}
      {children != null && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

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
    <div className="space-y-6">
      <div className="no-scrollbar -mx-1 max-w-full overflow-x-auto px-1 py-0.5">
        <Segmented
          size="md"
          value={sel}
          options={list.map((h) => ({ value: h.id, label: h.displayName }))}
          onChange={setSel}
        />
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

  // Never leave a login or install pty running when the panel unmounts or the
  // harness switches (login is declared first, so it's stopped first).
  // A finished login terminal (browser flow returned / user quit) → re-probe.
  const login = useHarnessPty('login', harness, () => void refresh(), [refresh]);
  const ptyId = login.ptyId;

  // Installer exited → re-probe. A now-detected CLI is success (the panel flips
  // to its login/API-key state); otherwise the terminal shows what failed —
  // leave it up and offer a retry.
  const install = useHarnessPty(
    'install',
    harness,
    () =>
      void (async () => {
        const { data } = await tryInvoke('harness:auth', { harness });
        if (data) setAuth(data);
        if (data?.installed) {
          toast('success', `${data.displayName} installed`);
          install.clear();
          setInstallCmd(null);
          void refreshHarnesses(true); // model pickers/composer see it too
        } else {
          setInstallFailed(true);
        }
      })(),
    [harness, toast, refreshHarnesses]
  );
  const installPty = install.ptyId;

  const startInstall = async () => {
    setInstallFailed(false);
    const { data, error } = await install.start();
    if (error) return toast('error', error);
    if (data) setInstallCmd(data.cmd);
  };

  const cancelInstall = async () => {
    await install.stop();
    setInstallCmd(null);
    setInstallFailed(false);
    void refresh();
  };

  const startLogin = async (loginId?: string) => {
    const { error } = await login.start({ loginId });
    if (error) return toast('error', error);
  };

  const closeLogin = async () => {
    await login.stop();
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
    <div className="space-y-6">
      <SettingsSection>
        <SettingsRow
          label={auth.displayName}
          description={auth.method ?? (auth.installed ? undefined : 'Not installed on this machine')}
        >
          {auth.connected ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ok/10 px-2.5 py-1 text-2xs font-medium text-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-current" /> Connected
            </span>
          ) : (
            <span
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium',
                auth.fault ? 'bg-warn/10 text-warn' : 'bg-accent-soft text-muted'
              )}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {auth.fault ? 'Sign-in expired' : auth.installed ? 'Not connected' : 'Not installed'}
            </span>
          )}
          <button
            className="btn btn-ghost h-7 w-7 !px-0 text-muted hover:text-fg"
            title="Refresh"
            aria-label="Refresh"
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} className={clsx(loading && 'animate-spin')} />
          </button>
        </SettingsRow>
        {auth.version && <Row label="Version" value={auth.version} />}
        {auth.details.map((d) => (
          <Row key={d.label} label={d.label} value={d.value} />
        ))}
        {!auth.installed &&
          (!installPty ? (
            <SettingsRow
              label={`Install ${auth.displayName}`}
              description={`${auth.displayName} isn’t installed on this machine — Maestro can install it for you.`}
            >
              <button className="btn btn-accent h-8 gap-1.5 px-3.5" onClick={() => void startInstall()}>
                <Sparkles size={12} /> Install {auth.displayName}
              </button>
            </SettingsRow>
          ) : (
            <div className="space-y-2.5 px-4 py-3.5">
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
                    <button className="btn btn-accent" onClick={() => void startInstall()}>
                      Retry
                    </button>
                  )}
                  <button className="btn btn-ghost" onClick={() => void cancelInstall()}>
                    {installFailed ? 'Close' : 'Cancel'}
                  </button>
                </div>
              </div>
              <div className="h-64 overflow-hidden rounded-ctl border border-border/70">
                <PtyView workspaceId="" ptyId={installPty} ensure={false} interactive active />
              </div>
            </div>
          ))}
      </SettingsSection>

      {auth.fault && (
        <div className="space-y-3 rounded-card bg-warn/10 px-4 py-3.5">
          <div className="flex gap-2.5 text-xs">
            <KeyRound size={14} className="mt-0.5 shrink-0 text-warn" />
            <span className="min-w-0 flex-1 leading-relaxed">{auth.fault.summary}</span>
          </div>
          <AuthFix harness={auth.fault.harness} onFixed={() => void refresh()} />
        </div>
      )}

      {auth.loginLabel && (
        <>
          {ptyId ? (
            // Shared sign-in terminal — one at a time, whether it's the single
            // login or a specific row's (multi-login). `claude auth login` exits
            // on its own; other CLIs' REPL logins stay open until Done.
            <SettingsSection
              title="Sign in"
              description="Finish signing in below — a browser window may open."
              action={
                <button className="btn" onClick={() => void closeLogin()}>
                  Done
                </button>
              }
              bare
            >
              <div className="h-72 overflow-hidden rounded-card border border-border/70">
                <PtyView workspaceId="" ptyId={ptyId} ensure={false} interactive active />
              </div>
            </SettingsSection>
          ) : auth.multiLogin ? (
            <SettingsSection
              title="Logins"
              action={
                <button className="btn btn-ghost gap-1" disabled={!auth.installed} onClick={() => void addLogin()}>
                  <Plus size={12} /> Add login
                </button>
              }
            >
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
              <SettingsRow
                label="Rotate logins automatically"
                description="Switch to the next login when one hits a usage limit."
              >
                <Toggle
                  checked={settings.loginRotation !== false}
                  onChange={(v) => void saveSettings({ loginRotation: v })}
                />
              </SettingsRow>
            </SettingsSection>
          ) : (
            <SettingsSection>
              <SettingsRow
                label="Sign in"
                description={
                  auth.installed
                    ? `Opens ${auth.loginLabel} in a terminal here.`
                    : `Install ${auth.displayName} above to log in from here.`
                }
              >
                <button className="btn btn-accent h-8 gap-1.5 px-3.5" disabled={!auth.installed} onClick={() => void startLogin()}>
                  <Play size={12} /> Run {auth.loginLabel}
                </button>
              </SettingsRow>
            </SettingsSection>
          )}
          {!auth.installed && (auth.multiLogin || ptyId) && (
            <p className="-mt-3 px-1 text-2xs text-faint">Install {auth.displayName} above to log in from here.</p>
          )}
        </>
      )}

      {auth.apiKey && (
        <SettingsSection>
          <div className="px-4 py-3.5">
            <ApiKeyField
              label={
                <span className="text-[13px] font-medium text-fg">API key{auth.loginLabel ? ' (alternative)' : ''}</span>
              }
              url={auth.apiKey.url}
              envVar={auth.apiKey.envVar}
              value={keyDraft}
              onChange={setKeyDraft}
              onSave={() => void saveKey()}
              footer={
                <p className="text-2xs leading-relaxed text-muted">
                  Stored locally and injected as <span className="font-mono">{auth.apiKey.envVar}</span> for{' '}
                  {auth.displayName} runs. Leave blank to use the CLI login{auth.loginLabel ? ' above' : ''}.
                </p>
              }
            />
          </div>
        </SettingsSection>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-2.5 text-xs">
      <span className="text-muted">{label}</span>
      <span className="truncate font-mono text-2xs text-fg">{value}</span>
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
    <div className="flex items-center gap-3 px-4 py-3">
      <span
        className={clsx(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
          active ? 'border-fg' : 'border-faint/70'
        )}
      >
        {active && <span className="h-1.5 w-1.5 rounded-full bg-fg" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{row.label}</div>
        {emailUnder && <div className="truncate font-mono text-2xs text-faint">{emailUnder}</div>}
      </div>
      <span className="shrink-0 text-2xs text-muted">{loginStatus(row)}</span>
      <div className="flex shrink-0 items-center gap-1">
        {!active && (
          <button className="btn" disabled={!row.signedIn} onClick={onUse}>
            Use
          </button>
        )}
        <button className="btn btn-ghost" disabled={!installed} onClick={onSignIn}>
          {row.signedIn ? 'Sign in again' : 'Sign in'}
        </button>
        {!isDefault && (
          <button
            className="btn btn-ghost h-7 w-7 !px-0 text-muted hover:text-err"
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
