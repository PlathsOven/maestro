import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Book } from 'lucide-react';
import { tryInvoke } from '../lib/api';
import { useApp } from '../store/app';
import { FolderField, finishProjectAdd, Kbd, Modal, Spinner, useProjectParentDir } from './common';
import type { RecentRepo } from '../../shared/types';

/** Conductor-style "Clone GitHub repo": URL, recent repos, location, ⌘↵. */
export default function CloneRepoModal() {
  const setModal = useApp((s) => s.setModal);
  const toast = useApp((s) => s.toast);
  const ghAuth = useApp((s) => s.ghAuth);
  const [url, setUrl] = useState('');
  const [repos, setRepos] = useState<RecentRepo[] | null>(null);
  const [location, setLocation] = useProjectParentDir('cloneParentDir');
  const [busy, setBusy] = useState(false);

  // Recent repos come from the signed-in gh account. Re-fetch when auth flips so
  // signing in from the empty state fills the list without reopening the modal.
  useEffect(() => {
    setRepos(null);
    void tryInvoke('github:repoList').then((r) => setRepos(r.data ?? []));
  }, [ghAuth.authenticated]);

  const close = () => setModal(null);

  const clone = async (target?: string) => {
    const repoUrl = (target ?? url).trim();
    if (!repoUrl || busy) return;
    setBusy(true);
    localStorage.setItem('cloneParentDir', location.trim());
    const res = await tryInvoke('project:add', {
      mode: 'github',
      url: repoUrl,
      parentDir: location.trim() || undefined,
    });
    setBusy(false);
    if (res.error) {
      toast('error', res.error);
      return;
    }
    await finishProjectAdd(res, 'Cloned');
  };

  const browse = async () => {
    const { data } = await tryInvoke('dialog:pickFolder');
    if (data) setLocation(data);
  };

  return (
    <Modal
      plain
      title="Clone GitHub repo"
      onClose={close}
      width={540}
      onCmdEnter={() => void clone()}
      footer={
        <button className="btn btn-accent h-8 gap-2 px-3" disabled={!url.trim() || busy} onClick={() => void clone()}>
          {busy ? <Spinner className="!text-white" /> : 'Clone repo'}
          <Kbd>⌘↵</Kbd>
        </button>
      }
    >
      <div className="mt-3 space-y-4">
        <div>
          <label className="label !normal-case !text-xs !font-medium !text-fg">Repository URL</label>
          <input
            autoFocus
            className="input font-mono text-xs"
            placeholder="https://github.com/user/repo.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void clone()}
          />
        </div>

        <div>
          <div className="label !normal-case !text-xs !font-medium !text-fg">Recent repos</div>
          <div className="max-h-56 overflow-y-auto rounded-card border">
            {repos === null && (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted">
                <Spinner /> Loading your repos…
              </div>
            )}
            {repos?.length === 0 &&
              (ghAuth.authenticated ? (
                <div className="px-3 py-3 text-xs text-faint">
                  No repositories found. Paste a URL above to clone any repo.
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3 px-3 py-3">
                  <span className="text-xs text-muted">Sign in with GitHub to see and clone your repos.</span>
                  <button
                    className="btn btn-accent shrink-0 text-xs"
                    onClick={() => void useApp.getState().startGithubSignIn()}
                  >
                    Sign in with GitHub
                  </button>
                </div>
              ))}
            {repos?.map((r) => (
              <button
                key={r.nameWithOwner}
                className={clsx(
                  'flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent-soft',
                  busy && 'pointer-events-none opacity-60'
                )}
                onClick={() => {
                  setUrl(`https://github.com/${r.nameWithOwner}`);
                  void clone(`https://github.com/${r.nameWithOwner}`);
                }}
              >
                <RepoAvatar nameWithOwner={r.nameWithOwner} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{r.nameWithOwner}</span>
                  {r.description && <span className="block truncate text-2xs text-muted">{r.description}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>

        <FolderField label="Location" value={location} onChange={setLocation} onBrowse={() => void browse()} />
      </div>
    </Modal>
  );
}

/**
 * Repo icon for a recent repo — the owner's GitHub avatar (matching the sidebar's
 * RepoIcon), falling back to a book glyph if there's no owner or the avatar 404s.
 */
function RepoAvatar({ nameWithOwner }: { nameWithOwner: string }) {
  const owner = nameWithOwner.split('/')[0];
  const [broken, setBroken] = useState(false);
  if (owner && !broken) {
    return (
      <img
        src={`https://avatars.githubusercontent.com/${owner}?s=48`}
        alt=""
        className="h-7 w-7 shrink-0 rounded-md"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ok/15">
      <Book size={14} className="text-ok" />
    </span>
  );
}
