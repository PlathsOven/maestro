import { useState } from 'react';
import { AlertCircle, Check, Copy, ExternalLink } from 'lucide-react';
import { useApp } from '../store/app';
import { Modal, Spinner } from './common';

/**
 * OAuth device-flow sign-in: show the one-time code, send the user to
 * github.com/login/device, and wait — the main process polls GitHub and
 * finishes by wiring both `gh` and git's credential helper.
 */
export default function GitHubSignInModal() {
  const st = useApp((s) => s.ghSignIn);
  const cancel = useApp((s) => s.cancelGithubSignIn);
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    if (!st?.userCode) return;
    void navigator.clipboard.writeText(st.userCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const openGithub = () => {
    copyCode();
    window.open(st?.verificationUri || 'https://github.com/login/device');
  };

  return (
    <Modal
      title="Sign in with GitHub"
      onClose={cancel}
      width={460}
      footer={
        <>
          <span className="mr-auto text-2xs text-faint">
            Prefer a terminal? <code className="font-mono">gh auth login</code> works too.
          </span>
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
        </>
      }
    >
      {!st || st.status === 'starting' ? (
        <div className="flex items-center gap-2.5 py-4 text-[13px] text-muted">
          <Spinner />
          Contacting GitHub… (this also installs the GitHub CLI if it's missing)
        </div>
      ) : st.status === 'error' ? (
        <div className="space-y-3 py-2">
          <div className="flex items-start gap-2 text-[13px] text-err">
            <AlertCircle size={15} className="mt-px shrink-0" />
            <span>{st.message}</span>
          </div>
          <button className="btn btn-accent" onClick={() => void useApp.getState().startGithubSignIn()}>
            Try again
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] text-muted">
            Enter this one-time code on GitHub to connect Maestro. This signs in the GitHub CLI{' '}
            <em>and</em> sets up git pushes — no terminal needed.
          </p>

          <button
            className="group flex w-full items-center justify-center gap-3 rounded-card border bg-raised py-3.5 font-mono text-xl font-semibold tracking-[0.3em] hover:border-accent/60"
            title="Copy code"
            onClick={copyCode}
          >
            {st.userCode}
            {copied ? (
              <Check size={15} className="text-ok" />
            ) : (
              <Copy size={15} className="text-faint group-hover:text-muted" />
            )}
          </button>

          <button className="btn btn-accent w-full justify-center gap-2 !h-8" onClick={openGithub}>
            <ExternalLink size={13} />
            Open github.com/login/device
          </button>
          <p className="-mt-2 text-center text-2xs text-faint">The code is copied automatically when you open GitHub.</p>

          <div className="flex items-center gap-2 rounded-ctl border bg-surface px-3 py-2 text-xs text-muted">
            <Spinner />
            Waiting for approval — this finishes automatically once you authorize on GitHub.
          </div>
        </div>
      )}
    </Modal>
  );
}
