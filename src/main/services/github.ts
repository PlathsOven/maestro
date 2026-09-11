import { run, type ExecResult } from '../exec';
import { localHost } from '../hosts/local';
import type { ExecHost } from '../hosts/types';
import { ghPath, resolveGh } from './ghbin';
import type {
  GhAuth,
  IssueListItem,
  PrCheck,
  PrComment,
  PrDeployment,
  PrListItem,
  PrStatus,
  RecentRepo,
} from '../../shared/types';

/**
 * Run gh on the given host. Local uses the resolved binary (system PATH or the
 * Maestro-downloaded copy); a remote host runs `gh` off the server's PATH (the
 * user authenticates it there — `gh auth login` once). Callers that omit the
 * host get local, so existing behavior is unchanged.
 */
async function gh(args: string[], opts: { cwd?: string; timeout?: number; host?: ExecHost } = {}): Promise<ExecResult> {
  const host = opts.host ?? localHost;
  if (host.id === 'local') {
    await resolveGh();
    return run(ghPath(), args, { cwd: opts.cwd, timeout: opts.timeout });
  }
  return host.exec('gh', args, { cwd: opts.cwd, timeout: opts.timeout });
}

/** Run a gh --json command and parse its stdout; null on non-zero exit or
 *  malformed JSON. Callers shape the parsed value themselves. */
async function ghJson<T = any>(
  args: string[],
  opts: { cwd?: string; timeout?: number; host?: ExecHost } = {}
): Promise<T | null> {
  const r = await gh(args, opts);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

/** Is gh authenticated on this host? (Per-host for remote tier C.) */
export async function ghAuthedOn(host: ExecHost): Promise<boolean> {
  if (host.id === 'local') return (await ghAuth()).authenticated;
  const r = await host.exec('gh', ['auth', 'status'], { timeout: 15_000 });
  return r.ok;
}

let authCache: { at: number; value: GhAuth } | null = null;

export async function ghAuth(force = false): Promise<GhAuth> {
  if (!force && authCache && Date.now() - authCache.at < 60_000) return authCache.value;
  const bin = await resolveGh();
  if (!bin) {
    const value = { installed: false, authenticated: false, user: null };
    authCache = { at: Date.now(), value };
    return value;
  }
  const st = await run(bin, ['auth', 'status'], { timeout: 15_000 });
  let user: string | null = null;
  const m = (st.stdout + st.stderr).match(/account (\S+)/);
  if (m) user = m[1];
  const value = { installed: true, authenticated: st.ok, user };
  authCache = { at: Date.now(), value };
  return value;
}

export async function ghClone(url: string, dest: string): Promise<void> {
  const r = await gh(['repo', 'clone', url, dest], { timeout: 600_000 });
  if (!r.ok) {
    const g = await run('git', ['clone', url, dest], { timeout: 600_000 });
    if (!g.ok) throw new Error(g.stderr.trim() || r.stderr.trim() || 'clone failed');
  }
}

let repoListCache: { at: number; value: RecentRepo[] } | null = null;

/** The signed-in user's repos, most recently pushed first (for "Recent repos"). */
export async function repoList(): Promise<RecentRepo[]> {
  if (repoListCache && Date.now() - repoListCache.at < 60_000) return repoListCache.value;
  const rows = await ghJson<any[]>(['repo', 'list', '--limit', '30', '--json', 'nameWithOwner,description,url'], {
    timeout: 30_000,
  });
  if (!rows) return [];
  const value = rows.map((x) => ({
    nameWithOwner: x.nameWithOwner ?? '',
    description: x.description ?? '',
    url: x.url ?? `https://github.com/${x.nameWithOwner}`,
  }));
  repoListCache = { at: Date.now(), value };
  return value;
}

/** Create a private GitHub repo from an existing local folder and push it. */
export async function repoCreateFromLocal(
  name: string,
  dir: string
): Promise<{ ok: boolean; error?: string }> {
  const r = await gh(['repo', 'create', name, '--private', '--source', dir, '--remote', 'origin', '--push'], {
    timeout: 120_000,
  });
  if (!r.ok) return { ok: false, error: (r.stderr + r.stdout).trim() };
  return { ok: true };
}

export async function prList(repoPath: string, host: ExecHost = localHost): Promise<PrListItem[]> {
  const rows = await ghJson<any[]>(['pr', 'list', '--json', 'number,title,headRefName,author,isDraft,url', '--limit', '50'], {
    cwd: repoPath,
    timeout: 30_000,
    host,
  });
  if (!rows) return [];
  return rows.map((p) => ({
    number: p.number,
    title: p.title,
    headRefName: p.headRefName,
    author: p.author?.login ?? '',
    isDraft: !!p.isDraft,
    url: p.url,
  }));
}

export async function issueList(repoPath: string, host: ExecHost = localHost): Promise<IssueListItem[]> {
  const rows = await ghJson<any[]>(['issue', 'list', '--json', 'number,title,author,url', '--limit', '50'], {
    cwd: repoPath,
    timeout: 30_000,
    host,
  });
  if (!rows) return [];
  return rows.map((i) => ({
    number: i.number,
    title: i.title,
    author: i.author?.login ?? '',
    url: i.url,
  }));
}

export async function issueView(
  repoPath: string,
  num: number,
  host: ExecHost = localHost
): Promise<{ title: string; body: string } | null> {
  const j = await ghJson<any>(['issue', 'view', String(num), '--json', 'title,body'], {
    cwd: repoPath,
    timeout: 30_000,
    host,
  });
  if (!j) return null;
  return { title: j.title ?? '', body: j.body ?? '' };
}

function mapCheck(item: any): PrCheck {
  // statusCheckRollup mixes CheckRun and StatusContext shapes.
  if (item.__typename === 'CheckRun' || item.status !== undefined) {
    const concl = (item.conclusion || '').toUpperCase();
    let state: PrCheck['state'] = 'pending';
    if (item.status === 'COMPLETED') {
      if (concl === 'SUCCESS') state = 'pass';
      else if (concl === 'SKIPPED') state = 'skipped';
      else if (concl === 'NEUTRAL') state = 'neutral';
      else state = 'fail';
    }
    return {
      name: item.name || item.context || 'check',
      state,
      link: item.detailsUrl || null,
      description: item.title || null,
    };
  }
  const s = (item.state || '').toUpperCase();
  const state: PrCheck['state'] =
    s === 'SUCCESS' ? 'pass' : s === 'PENDING' || s === 'EXPECTED' ? 'pending' : s === 'NEUTRAL' ? 'neutral' : 'fail';
  return {
    name: item.context || 'status',
    state,
    link: item.targetUrl || null,
    description: item.description || null,
  };
}

const prCache = new Map<string, { at: number; value: PrStatus | null }>();

/**
 * GitHub computes `mergeable` lazily: reading a PR whose base has moved kicks
 * off a background job and answers UNKNOWN until it lands. Since UNKNOWN reads
 * as "no conflicts" downstream, taking that first answer at face value is what
 * made a conflicted PR look merge-ready. So: re-ask on a short backoff before
 * returning, and keep an unsettled answer on a short leash in the cache so the
 * next refresh asks again rather than serving it for the full window.
 */
const MERGEABILITY_POLLS_MS = [1_000, 2_500];
const CACHE_MS = 20_000;
const UNSETTLED_CACHE_MS = 5_000;

/** Is this an open PR GitHub hasn't committed to an answer on? */
function mergeabilityPending(value: PrStatus | null): value is PrStatus {
  return !!value && value.state === 'OPEN' && value.mergeable !== 'MERGEABLE' && value.mergeable !== 'CONFLICTING';
}

export function invalidatePrCache(wtPath: string) {
  prCache.delete(wtPath);
}

/** Last full status this process fetched, any age — what the UI last saw,
 *  which makes it the poller's drift baseline. */
export function cachedPrStatus(wtPath: string): PrStatus | null | undefined {
  return prCache.get(wtPath)?.value;
}

/** gh definitively answered "this branch has no PR" (vs a transient failure). */
function isNoPr(r: ExecResult): boolean {
  return /no pull requests? found|could not resolve to a pullrequest/i.test(r.stderr + r.stdout);
}

interface PrProbe {
  number: number;
  state: string;
  mergeable: string | null;
}

/**
 * One-call identity probe for the background poller: just number/state/
 * mergeable — no checks, comments, or deployments. `pr: null` means gh
 * answered "no PR for this branch"; `ok: false` means gh couldn't answer
 * (offline, auth expired) — callers treat that as no news, not a change.
 */
export async function prProbe(wtPath: string, host: ExecHost = localHost): Promise<{ ok: boolean; pr: PrProbe | null }> {
  const r = await gh(['pr', 'view', '--json', 'number,state,mergeable'], { cwd: wtPath, timeout: 20_000, host });
  if (!r.ok) return { ok: isNoPr(r), pr: null };
  try {
    const j = JSON.parse(r.stdout);
    return { ok: true, pr: { number: j.number, state: j.state, mergeable: j.mergeable || null } };
  } catch {
    return { ok: false, pr: null };
  }
}

/**
 * PR status for a worktree. `settleMergeability` re-asks GitHub for a still-
 * computing `mergeable` before returning (a few seconds, worst case) — callers
 * that only need identity/state can turn it off.
 */
export async function prStatus(
  wtPath: string,
  force = false,
  host: ExecHost = localHost,
  settleMergeability = true
): Promise<PrStatus | null> {
  const cached = prCache.get(wtPath);
  const ttl = cached && mergeabilityPending(cached.value) ? UNSETTLED_CACHE_MS : CACHE_MS;
  if (!force && cached && Date.now() - cached.at < ttl) return cached.value;
  const r = await gh(
    [
      'pr',
      'view',
      '--json',
      'number,title,url,state,isDraft,reviewDecision,mergeable,baseRefName,headRefName,additions,deletions,statusCheckRollup,comments',
    ],
    { cwd: wtPath, timeout: 30_000, host }
  );
  if (!r.ok) {
    // Only a definite "no PR for this branch" clears the status; a transient
    // failure (offline, auth expired, rate limit) serves the last known value
    // instead, so callers never mistake an outage for the PR disappearing.
    if (isNoPr(r)) {
      prCache.set(wtPath, { at: Date.now(), value: null });
      return null;
    }
    return cached?.value ?? null;
  }
  let value: PrStatus | null = null;
  try {
    const j = JSON.parse(r.stdout);
    const checks: PrCheck[] = Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup.map(mapCheck) : [];
    const comments: PrComment[] = Array.isArray(j.comments)
      ? j.comments.slice(-30).map((c: any) => ({
          author: c.author?.login ?? '',
          body: c.body ?? '',
          createdAt: c.createdAt ?? '',
          url: c.url ?? null,
        }))
      : [];
    value = {
      number: j.number,
      title: j.title,
      url: j.url,
      state: j.state,
      isDraft: !!j.isDraft,
      reviewDecision: j.reviewDecision || null,
      mergeable: j.mergeable || null,
      baseRefName: j.baseRefName,
      headRefName: j.headRefName,
      additions: j.additions ?? 0,
      deletions: j.deletions ?? 0,
      checks,
      comments,
      deployments: await deployments(wtPath, j.headRefName, host),
    };
  } catch {
    value = null;
  }
  if (settleMergeability && mergeabilityPending(value)) {
    value.mergeable = await settleMergeable(wtPath, value.mergeable, host);
  }
  prCache.set(wtPath, { at: Date.now(), value });
  return value;
}

/** Re-read `mergeable` until GitHub is definite; each read also nudges it to compute. */
async function settleMergeable(wtPath: string, current: string | null, host: ExecHost): Promise<string | null> {
  for (const wait of MERGEABILITY_POLLS_MS) {
    await new Promise((done) => setTimeout(done, wait));
    const r = await gh(['pr', 'view', '--json', 'mergeable'], { cwd: wtPath, timeout: 20_000, host });
    if (!r.ok) break;
    try {
      const m = JSON.parse(r.stdout).mergeable;
      if (m === 'MERGEABLE' || m === 'CONFLICTING') return m;
    } catch {
      break;
    }
  }
  return current;
}

async function deployments(wtPath: string, ref: string, host: ExecHost = localHost): Promise<PrDeployment[]> {
  const arr = await ghJson<any[]>(['api', `repos/{owner}/{repo}/deployments?ref=${encodeURIComponent(ref)}&per_page=3`], {
    cwd: wtPath,
    timeout: 20_000,
    host,
  });
  if (!Array.isArray(arr)) return [];
  const out: PrDeployment[] = [];
  for (const d of arr.slice(0, 3)) {
    let state = 'unknown';
    let url: string | null = null;
    const st = await gh(['api', `repos/{owner}/{repo}/deployments/${d.id}/statuses?per_page=1`], {
      cwd: wtPath,
      timeout: 15_000,
      host,
    });
    if (st.ok) {
      try {
        const sts = JSON.parse(st.stdout) as any[];
        if (sts[0]) {
          state = sts[0].state;
          url = sts[0].environment_url || sts[0].target_url || null;
        }
      } catch {}
    }
    out.push({ environment: d.environment ?? 'env', state, createdAt: d.created_at ?? '', url });
  }
  return out;
}

export async function prCreate(
  wtPath: string,
  opts: { title: string; body: string; base: string; draft: boolean },
  host: ExecHost = localHost
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const args = ['pr', 'create', '--title', opts.title, '--body', opts.body, '--base', opts.base];
  if (opts.draft) args.push('--draft');
  const r = await gh(args, { cwd: wtPath, timeout: 60_000, host });
  if (!r.ok) return { ok: false, error: (r.stderr + r.stdout).trim() };
  const m = (r.stdout + r.stderr).match(/https:\/\/\S+\/pull\/\d+/);
  invalidatePrCache(wtPath);
  return { ok: true, url: m ? m[0] : undefined };
}

export async function prMerge(
  wtPath: string,
  method: 'merge' | 'squash' | 'rebase',
  host: ExecHost = localHost
): Promise<{ ok: boolean; error?: string }> {
  const r = await gh(['pr', 'merge', `--${method}`], { cwd: wtPath, timeout: 60_000, host });
  invalidatePrCache(wtPath);
  if (!r.ok) return { ok: false, error: (r.stderr + r.stdout).trim() };
  return { ok: true };
}
