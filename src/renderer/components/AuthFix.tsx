import { useState } from 'react';
import { CheckCircle2, KeyRound, RefreshCw, Wrench } from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { useHarnessPty } from '../lib/useHarnessPty';
import { useApp } from '../store/app';
import { Spinner } from './common';
import PtyView from './TerminalPanel';
import type { HarnessAuthRepair, HarnessId } from '../../shared/types';

/**
 * The one-click repair for a broken harness sign-in.
 *
 * An expired credential the CLI can't refresh isn't something the user can fix
 * from inside a chat — and it kills every workspace at once — so wherever we
 * detect it (the chat card, Settings → Harnesses) the fix is the same single
 * button: quarantine the dead credential, ask the CLI whether that restored the
 * login behind it, and only fall back to the interactive sign-in when it didn't.
 * On success the failed message can be resent without retyping it.
 */
export default function AuthFix({
  harness,
  loginId,
  retry,
  onFixed,
}: {
  harness: HarnessId;
  /** the login the failed turn ran under — signed back in, rather than whichever
   *  login is active now. Omitted in Settings (repairs the active login). */
  loginId?: string;
  /** resend the message the fault interrupted; omitted outside a chat */
  retry?: () => void;
  /** re-probe the surrounding view once the sign-in works again */
  onFixed?: () => void;
}) {
  const refreshHarnesses = useApp((s) => s.refreshHarnesses);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HarnessAuthRepair | null>(null);
  // Leaving the card (chat switch, settings close) must not orphan a login pty.
  // The login terminal exiting (browser flow returned, or the user quit it) is
  // the cue to re-ask the CLI whether it is signed in now.
  const login = useHarnessPty('login', harness, () => void finishLogin(), []);
  const ptyId = login.ptyId;

  const repair = async () => {
    setBusy(true);
    const { data, error } = await tryInvoke('harness:repairAuth', { harness, loginId });
    setBusy(false);
    if (error || !data) return toast('error', error ?? 'Repair failed');
    setResult(data);
    void refreshHarnesses(true); // model pickers see the new state
    if (data.ok) {
      toast('success', 'Sign-in restored');
      onFixed?.();
    } else if (data.needsLogin) void startLogin();
  };

  const startLogin = async () => {
    const { error } = await login.start({ loginId });
    if (error) return toast('error', error);
  };

  const finishLogin = async () => {
    await login.stop();
    const { data } = await tryInvoke('harness:auth', { harness });
    void refreshHarnesses(true);
    if (data?.connected) {
      setResult({ ok: true, movedTo: null, needsLogin: false, message: `${data.displayName} is signed in again.` });
      toast('success', 'Sign-in restored');
      onFixed?.();
    } else {
      setResult({
        ok: false,
        movedTo: null,
        needsLogin: true,
        message: 'Still signed out — run the sign-in again and complete it in the browser.',
      });
    }
  };

  if (result?.ok) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <CheckCircle2 size={13} className="shrink-0 text-ok" />
        <span className="min-w-0 flex-1 text-2xs text-muted">{result.message}</span>
        {retry && (
          <button className="btn btn-accent shrink-0 gap-1" onClick={retry}>
            <RefreshCw size={11} /> Send again
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-accent shrink-0 gap-1" disabled={busy} onClick={() => void repair()}>
          {busy ? <Spinner className="h-3 w-3" /> : <Wrench size={11} />} Fix sign-in
        </button>
        {result && !ptyId && (
          <button className="btn shrink-0 gap-1" onClick={() => void startLogin()}>
            <KeyRound size={11} /> Sign in
          </button>
        )}
        <span className="min-w-0 flex-1 text-2xs text-muted">
          {result?.message ?? 'Re-authenticates this login and restores the CLI’s sign-in so you can resend.'}
        </span>
      </div>
      {ptyId && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs text-muted">Finish signing in below — a browser window may open.</span>
            <button className="btn" onClick={() => void finishLogin()}>
              Done
            </button>
          </div>
          <div className="h-64 overflow-hidden rounded-card border border-border/70">
            <PtyView workspaceId="" ptyId={ptyId} ensure={false} interactive active />
          </div>
        </div>
      )}
    </div>
  );
}
