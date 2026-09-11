import { broadcast } from '../bus';
import { run } from '../exec';
import { ghAuth } from './github';
import { ensureGh, resolveGh } from './ghbin';
import type { GhAuth } from '../../shared/types';

// In-app GitHub sign-in via the OAuth device flow — the same grant `gh auth
// login` uses. We never store the token ourselves: it's handed straight to
// `gh auth login --with-token` (which keeps it in the macOS keyring), and
// git's credential helper for github.com is pointed at gh so `git push`
// authenticates with the same identity.

// GitHub CLI's public OAuth client id (device flow enabled; no secret involved).
const CLIENT_ID = '178c6fc778ccc68e1d6a';
const SCOPES = 'repo read:org gist workflow';

interface DeviceSession {
  deviceCode: string;
  interval: number;
  expiresAt: number;
  timer?: NodeJS.Timeout;
  cancelled: boolean;
}

let session: DeviceSession | null = null;

async function ghPost(url: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'maestro',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
  return res.json();
}

export async function startDeviceSignIn(): Promise<{
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}> {
  cancelDeviceSignIn();
  await ensureGh(); // downloads the CLI first if this machine has none
  const j = await ghPost('https://github.com/login/device/code', {
    client_id: CLIENT_ID,
    scope: SCOPES,
  });
  if (!j.device_code || !j.user_code) {
    throw new Error(j.error_description || 'Could not start GitHub sign-in');
  }
  session = {
    deviceCode: j.device_code,
    interval: j.interval ?? 5,
    expiresAt: Date.now() + (j.expires_in ?? 900) * 1000,
    cancelled: false,
  };
  schedulePoll();
  return {
    userCode: j.user_code,
    verificationUri: j.verification_uri ?? 'https://github.com/login/device',
    interval: session.interval,
    expiresIn: j.expires_in ?? 900,
  };
}

function schedulePoll() {
  if (!session || session.cancelled) return;
  session.timer = setTimeout(() => void poll(), session.interval * 1000);
}

async function poll() {
  const s = session;
  if (!s || s.cancelled) return;
  if (Date.now() > s.expiresAt) {
    session = null;
    broadcast('gh:auth', { phase: 'error', message: 'The sign-in code expired. Start again.' });
    return;
  }
  let j: any;
  try {
    j = await ghPost('https://github.com/login/oauth/access_token', {
      client_id: CLIENT_ID,
      device_code: s.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
  } catch {
    if (!s.cancelled) schedulePoll(); // transient network error — keep waiting
    return;
  }
  if (s.cancelled) return;
  if (j.access_token) {
    session = null;
    try {
      await completeSignInWithToken(j.access_token);
    } catch (e: any) {
      broadcast('gh:auth', { phase: 'error', message: String(e?.message ?? e) });
    }
    return;
  }
  if (j.error === 'authorization_pending') {
    schedulePoll();
    return;
  }
  if (j.error === 'slow_down') {
    s.interval += 5;
    schedulePoll();
    return;
  }
  session = null;
  broadcast('gh:auth', {
    phase: 'error',
    message:
      j.error === 'access_denied'
        ? 'Sign-in was cancelled on GitHub.'
        : j.error_description || j.error || 'GitHub sign-in failed',
  });
}

export function cancelDeviceSignIn() {
  if (session) {
    session.cancelled = true;
    if (session.timer) clearTimeout(session.timer);
    session = null;
  }
}

/** Store the token in gh (keyring) and point git's credential helper at gh. */
export async function completeSignInWithToken(token: string): Promise<GhAuth> {
  const bin = await ensureGh();
  const login = await run(bin, ['auth', 'login', '--hostname', 'github.com', '--with-token'], {
    input: token,
    timeout: 30_000,
  });
  if (!login.ok) {
    throw new Error(login.stderr.trim() || login.stdout.trim() || 'gh rejected the token');
  }
  await run(bin, ['config', 'set', '-h', 'github.com', 'git_protocol', 'https']);
  await configureGitCredentialHelper(bin);
  const auth = await ghAuth(true);
  broadcast('gh:auth', { phase: 'success', auth });
  return auth;
}

/**
 * Mirror `gh auth setup-git`, but with an absolute path when we're using a
 * downloaded gh, so pushes work from Maestro and from the user's own shells.
 * Scoped to github.com — the user's default credential helper is untouched.
 */
async function configureGitCredentialHelper(bin: string) {
  const helper = bin === 'gh' ? '!gh auth git-credential' : `!"${bin}" auth git-credential`;
  for (const host of ['github.com', 'gist.github.com']) {
    const key = `credential.https://${host}.helper`;
    await run('git', ['config', '--global', '--unset-all', key]); // exit 5 when unset — fine
    await run('git', ['config', '--global', '--add', key, '']); // clears inherited helpers
    await run('git', ['config', '--global', '--add', key, helper]);
  }
}

export async function signOutGitHub(): Promise<GhAuth> {
  cancelDeviceSignIn();
  const bin = (await resolveGh()) ?? 'gh';
  await run(bin, ['auth', 'logout', '--hostname', 'github.com'], { timeout: 20_000 });
  for (const host of ['github.com', 'gist.github.com']) {
    await run('git', ['config', '--global', '--unset-all', `credential.https://${host}.helper`]);
  }
  return ghAuth(true);
}
