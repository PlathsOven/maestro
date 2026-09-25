import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Book, Search } from 'lucide-react';
import { GitHubMark } from '../../shared/ui/brandIcons';
import { tryInvoke } from '../lib/api';
import { useApp } from '../store/app';
import { FolderField, finishProjectAdd, Modal, Spinner, useProjectParentDir } from './common';
import type { RecentRepo } from '../../shared/types';

/** Anything that should be cloned verbatim rather than treated as a search. */
const isUrl = (q: string) => /^(https?:\/\/|git@|ssh:\/\/)/i.test(q) || q.endsWith('.git');
/** `owner/repo` shorthand — cloneable directly even if no result matches. */
const isSlug = (q: string) => /^[\w.-]+\/[\w.-]+$/.test(q);

/** Conductor-style "Clone GitHub repo": URL or name search, your repos, location, ⌘↵. */
export default function CloneRepoModal() {
  const setModal = useApp((s) => s.setModal);
  const toast = useApp((s) => s.toast);
  const ghAuth = useApp((s) => s.ghAuth);
  const [url, setUrl] = useState('');
  const [repos, setRepos] = useState<RecentRepo[] | null>(null);
  const [location, setLocation] = useProjectParentDir('cloneParentDir');
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState<RecentRepo[] | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const query = url.trim();
  const searching = !!query && !isUrl(query);

  // Recent repos come from the signed-in gh account. Re-fetch when auth flips so
  // signing in from the empty state fills the list without reopening the modal.
  useEffect(() => {
    setRepos(null);
    void tryInvoke('github:repoList').then((r) => setRepos(r.data ?? []));
  }, [ghAuth.authenticated]);

  // Search GitHub by name (debounced) so repos outside the list are reachable
  // without a URL. A sequence guard drops responses for superseded queries.
  const searchSeq = useRef(0);
  useEffect(() => {
    const seq = ++searchSeq.current;
    setRemote(null);
    if (!searching || query.length < 2) return;
    const t = setTimeout(() => {
      void tryInvoke('github:repoSearch', { query }).then((r) => {
        if (seq === searchSeq.current) setRemote(r.data ?? []);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [query, searching]);

  const mine = useMemo(() => {
    if (!repos || !searching) return repos ?? [];
    const q = query.toLowerCase();
    return repos.filter((r) => r.nameWithOwner.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  }, [repos, query, searching]);
  const others = useMemo(() => {
    const have = new Set(mine.map((r) => r.nameWithOwner.toLowerCase()));
    return (remote ?? []).filter((r) => !have.has(r.nameWithOwner.toLowerCase()));
  }, [mine, remote]);
  // Keyboard selection only applies while searching; a URL clones as typed.
  const results = searching ? [...mine, ...others] : [];
  const picked = results[Math.min(active, results.length - 1)];

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Enter/⌘↵: a URL clones as typed; a search clones the highlighted result,
  // falling back to `owner/repo` shorthand when nothing matched.
  const submit = () => {
    if (!query) return;
    if (!searching) return void clone(query);
    if (picked) return void clone(`https://github.com/${picked.nameWithOwner}`);
    if (isSlug(query)) void clone(`https://github.com/${query}`);
  };
  const canSubmit = !!query && (!searching || !!picked || isSlug(query));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp' && results.length) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    }
  };

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
      onCmdEnter={submit}
      footer={
        <button
          className="btn btn-accent h-9 gap-2 pl-4 pr-3 text-[13px]"
          disabled={!canSubmit || busy}
          onClick={submit}
        >
          {busy ? <Spinner className="!text-on-ink" /> : 'Clone repo'}
          <span className="rounded-md bg-on-ink/15 px-1.5 py-px text-2xs font-medium text-on-ink/80">⌘↵</span>
        </button>
      }
    >
      <div className="mt-5 space-y-5">
        <div>
          <label className="label !text-fg">Repository URL or name</label>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              autoFocus
              className={clsx('input h-9 pl-8 text-xs', !searching && query && 'font-mono')}
              placeholder="Search repos by name, or paste a URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
        </div>

        {!isUrl(query) && (
          <div>
            <div className="label !text-fg">{searching ? 'Results' : 'Your repos'}</div>
            <div ref={listRef} className="max-h-60 overflow-y-auto rounded-card border border-border/70 bg-raised p-1">
              {repos === null && (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted">
                  <Spinner /> Loading your repos…
                </div>
              )}
              {!searching &&
                repos?.length === 0 &&
                (ghAuth.authenticated ? (
                  <div className="px-3 py-3 text-xs text-faint">
                    No repositories found. Paste a URL above to clone any repo.
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3 px-3 py-3">
                    <span className="text-xs text-muted">Sign in with GitHub to see and clone your repos.</span>
                    <button className="btn shrink-0" onClick={() => void useApp.getState().startGithubSignIn()}>
                      <GitHubMark size={13} />
                      Sign in with GitHub
                    </button>
                  </div>
                ))}
              {repos !== null &&
                mine.map((r, i) => (
                  <RepoRow
                    key={r.nameWithOwner}
                    repo={r}
                    active={searching && i === active}
                    busy={busy}
                    onPick={clone}
                  />
                ))}
              {searching && repos !== null && mine.length === 0 && remote !== null && others.length === 0 && (
                <div className="px-3 py-3 text-xs text-faint">
                  No repos match “{query}”.
                  {isSlug(query) && ' Press Enter to clone it anyway.'}
                </div>
              )}
              {searching && query.length >= 2 && (
                <>
                  <div className="px-2.5 pb-1 pt-2.5 text-2xs font-medium uppercase tracking-wide text-faint">
                    On GitHub
                  </div>
                  {remote === null ? (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
                      <Spinner /> Searching GitHub…
                    </div>
                  ) : others.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-faint">No other matches.</div>
                  ) : (
                    others.map((r, i) => (
                      <RepoRow
                        key={r.nameWithOwner}
                        repo={r}
                        active={mine.length + i === active}
                        busy={busy}
                        onPick={clone}
                      />
                    ))
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <FolderField label="Location" value={location} onChange={setLocation} onBrowse={() => void browse()} />
      </div>
    </Modal>
  );
}

function RepoRow({
  repo,
  active,
  busy,
  onPick,
}: {
  repo: RecentRepo;
  active: boolean;
  busy: boolean;
  onPick: (url: string) => void;
}) {
  return (
    <button
      data-active={active}
      className={clsx(
        'flex w-full items-center gap-3 rounded-ctl px-2.5 py-2 text-left hover:bg-accent-soft',
        active && 'bg-accent-soft',
        busy && 'pointer-events-none opacity-60',
      )}
      onClick={() => onPick(`https://github.com/${repo.nameWithOwner}`)}
    >
      <RepoAvatar nameWithOwner={repo.nameWithOwner} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{repo.nameWithOwner}</span>
        {repo.description && <span className="block truncate text-2xs text-muted">{repo.description}</span>}
      </span>
    </button>
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
        className="h-7 w-7 shrink-0 rounded-lg"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft">
      <Book size={14} className="text-muted" />
    </span>
  );
}
