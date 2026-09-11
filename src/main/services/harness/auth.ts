import fs from 'fs';
import os from 'os';
import path from 'path';
import { killPty, spawnPty, writePty } from '../pty';
import { scriptShell } from '../../env';
import { Settings } from '../../db';
import {
  claudeAuthFault,
  claudeAuthStatus,
  quarantineConfigCredential,
  readConfigCredential,
  readOAuthCreds,
} from './claude';
import { activeLogin, harnessLoginEnv, harnessSupportsMultiLogin, loginDir, DEFAULT_LOGIN_ID } from './logins';
import type {
  GlobalSettings,
  HarnessAuth,
  HarnessAuthDetail,
  HarnessAuthFault,
  HarnessAuthRepair,
  HarnessId,
  HarnessInfo,
} from '../../../shared/types';

/**
 * Harness connection ("login") management for Settings → Harnesses.
 *
 * Maestro doesn't own any credentials — each agent CLI logs in through its own
 * OAuth/device flow and stores its own token. We just (a) surface that CLI's
 * connection state read-only, (b) launch its interactive login command in a pty
 * so the user can authenticate without leaving the app, and (c) optionally hold
 * an API key and inject it as the CLI's key env var at spawn time.
 */

interface AuthDetectResult {
  connected: boolean;
  method: string | null;
  details: HarnessAuthDetail[];
}

interface AuthSpec {
  /** interactive login run in a terminal; `send` is typed into the pty after it
   *  boots (for CLIs whose login is a REPL slash-command like `/login`). */
  login: { file: string; args: string[]; send?: string; label: string } | null;
  /** shell command that installs this CLI, run in a login-shell pty so the user's
   *  PATH (nvm/homebrew) resolves; null when there's no one-line installer. */
  install: string | null;
  /** env var this CLI reads an API key from — also how a saved key is injected. */
  apiKeyEnv: string | null;
  /** where the user obtains an API key. */
  apiKeyUrl: string | null;
  detect: (settings: GlobalSettings) => Promise<AuthDetectResult>;
}

const NONE: AuthDetectResult = { connected: false, method: null, details: [] };

/** Decode a JWT's payload claims (unverified — display only). */
function jwtClaims(idToken?: string): any {
  if (!idToken) return null;
  try {
    const seg = idToken.split('.')[1] ?? '';
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const SPECS: Record<HarnessId, AuthSpec> = {
  'claude-code': {
    // Non-REPL login (fact 5): `claude auth login` opens the browser, waits for
    // the pasted code, prints "Login successful." and exits 0 — so the process
    // exiting IS the "done" signal, no `send` needed. It honours
    // CLAUDE_SECURESTORAGE_CONFIG_DIR, which is how a per-login store is written.
    login: { file: 'claude', args: ['auth', 'login'], label: 'claude auth login' },
    install: 'npm install -g @anthropic-ai/claude-code',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    async detect() {
      if (process.env.ANTHROPIC_API_KEY) {
        return { connected: true, method: 'API key', details: [{ label: 'Provider', value: 'Anthropic API' }] };
      }
      // The per-config credential file (what `claude setup-token` writes) is a
      // sign-in in its own right, so a live one counts even with no Keychain
      // login behind it. A DEAD one is reported as a fault instead of a
      // disconnect (see harnessAuthFault): whether the CLI dies on it or falls
      // through to the login behind it depends on the version and on what else
      // it can reach, and calling a working machine "not connected" would
      // disable its model picker.
      const cred = readConfigCredential();
      const credLive = !!cred && (cred.expiresAt === null || cred.expiresAt > Date.now());
      // The status badge describes the ACTIVE login, so read its store — and take
      // its email from the registry (the shared `oauthAccount` reflects only the
      // last login to run, so it can't identify a login — fact 3).
      const active = activeLogin('claude-code');
      const creds = await readOAuthCreds(loginDir('claude-code', active.id));
      if (creds && !(creds.expiresAt && creds.expiresAt < Date.now())) {
        const details: HarnessAuthDetail[] = [{ label: 'Provider', value: 'Anthropic API' }];
        if (creds.subscriptionType) details.push({ label: 'Plan', value: creds.subscriptionType });
        if (active.email) details.push({ label: 'Email', value: active.email });
        return { connected: true, method: 'Claude subscription', details };
      }
      if (credLive) {
        const details: HarnessAuthDetail[] = [{ label: 'Provider', value: 'Anthropic API' }];
        if (cred!.accountEmail) details.push({ label: 'Email', value: cred!.accountEmail });
        return { connected: true, method: 'Claude subscription', details };
      }
      return NONE;
    },
  },
  codex: {
    login: { file: 'codex', args: ['login'], label: 'codex login' },
    install: 'npm install -g @openai/codex',
    apiKeyEnv: 'OPENAI_API_KEY',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    async detect() {
      const j = readJson(path.join(os.homedir(), '.codex', 'auth.json'));
      const details: HarnessAuthDetail[] = [{ label: 'Provider', value: 'openai' }];
      if (j?.tokens?.access_token || j?.tokens?.id_token) {
        const claims = jwtClaims(j.tokens.id_token);
        const plan = claims?.['https://api.openai.com/auth']?.chatgpt_plan_type;
        if (plan) details.push({ label: 'Plan', value: String(plan) });
        if (claims?.email) details.push({ label: 'Account', value: String(claims.email) });
        return { connected: true, method: 'ChatGPT login', details };
      }
      if ((typeof j?.OPENAI_API_KEY === 'string' && j.OPENAI_API_KEY) || process.env.OPENAI_API_KEY) {
        return { connected: true, method: 'API key', details };
      }
      return NONE;
    },
  },
  cursor: {
    login: null, // Cursor connects via API key (matches Conductor)
    install: 'curl https://cursor.com/install -fsSL | bash',
    apiKeyEnv: 'CURSOR_API_KEY',
    apiKeyUrl: 'https://cursor.com/settings',
    async detect(settings) {
      const key = settings.harnessApiKeys?.cursor?.trim() || process.env.CURSOR_API_KEY;
      return key
        ? { connected: true, method: 'API key', details: [{ label: 'Provider', value: 'Cursor' }] }
        : NONE;
    },
  },
  opencode: {
    login: { file: 'opencode', args: ['auth', 'login'], label: 'opencode auth login' },
    install: 'npm install -g opencode-ai',
    apiKeyEnv: null, // opencode stores per-provider credentials itself
    apiKeyUrl: null,
    async detect() {
      const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
      const j = readJson(path.join(base, 'opencode', 'auth.json'));
      const providers = j && typeof j === 'object' ? Object.keys(j) : [];
      return providers.length
        ? { connected: true, method: 'Provider login', details: [{ label: 'Providers', value: providers.join(', ') }] }
        : NONE;
    },
  },
  'kimi-code': {
    login: { file: 'kimi', args: [], send: '/login\r', label: 'kimi /login' },
    install: 'npm install -g @moonshot-ai/kimi-code',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
    async detect() {
      const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
      for (const f of ['auth.json', 'credentials.json']) {
        const j = readJson(path.join(home, f));
        if (j && (j.access_token || j.accessToken || j.token || j.api_key || Object.keys(j).length > 0)) {
          return { connected: true, method: 'Kimi Code login', details: [{ label: 'Provider', value: 'Moonshot AI' }] };
        }
      }
      return process.env.MOONSHOT_API_KEY
        ? { connected: true, method: 'API key', details: [{ label: 'Provider', value: 'Moonshot AI' }] }
        : NONE;
    },
  },
  grok: {
    // First launch of the TUI triggers browser OAuth in browser-capable envs —
    // same pty-driven style as claude/kimi, but no slash command needed.
    login: { file: 'grok', args: [], label: 'grok (browser sign-in)' },
    install:
      process.platform === 'win32'
        ? 'powershell -NoProfile -Command "irm https://x.ai/cli/install.ps1 | iex"'
        : 'curl -fsSL https://x.ai/cli/install.sh | bash',
    apiKeyEnv: 'XAI_API_KEY',
    apiKeyUrl: 'https://console.x.ai',
    async detect(settings) {
      // Maestro never stores Grok creds — it reads whatever the CLI wrote under
      // ~/.grok/. The exact filename is [verify] (config is ~/.grok/config.toml;
      // OAuth tokens land adjacent), so probe the plausible names.
      const home = path.join(os.homedir(), '.grok');
      for (const f of ['credentials.json', 'auth.json']) {
        const j = readJson(path.join(home, f));
        if (j && Object.keys(j).length > 0) {
          return { connected: true, method: 'Grok sign-in', details: [{ label: 'Provider', value: 'xAI' }] };
        }
      }
      return settings.harnessApiKeys?.grok?.trim() || process.env.XAI_API_KEY
        ? { connected: true, method: 'API key', details: [{ label: 'Provider', value: 'xAI API' }] }
        : NONE;
    },
  },
  shell: { login: null, install: null, apiKeyEnv: null, apiKeyUrl: null, async detect() {
    return NONE;
  } },
};

/** Env to inject for a harness run when the user has saved an API key for it. */
export function harnessKeyEnv(harness: HarnessId, settings: GlobalSettings): Record<string, string> {
  const spec = SPECS[harness];
  const key = settings.harnessApiKeys?.[harness]?.trim();
  return spec?.apiKeyEnv && key ? { [spec.apiKeyEnv]: key } : {};
}

/** Best-effort connection status for one harness. `info` (install + version)
 *  comes from the caller's `detectHarnesses()` result — avoids importing the
 *  adapter registry here (keeps this module free of an index.ts import cycle). */
export async function detectHarnessAuth(harness: HarnessId, info?: HarnessInfo): Promise<HarnessAuth> {
  const spec = SPECS[harness];
  const settings = Settings.global();
  let result = NONE;
  try {
    result = await spec.detect(settings);
  } catch {
    result = NONE;
  }
  const savedKey = settings.harnessApiKeys?.[harness]?.trim();
  // A key saved in Settings is injected as the harness's env var at spawn, so
  // it makes the harness just as usable as a CLI login — report it as such
  // (per-spec detects only look at env vars and the CLI's own cred files).
  if (!result.connected && spec.apiKeyEnv && savedKey) {
    result = { connected: true, method: 'API key', details: [] };
  }
  const apiKey = spec.apiKeyEnv
    ? { envVar: spec.apiKeyEnv, url: spec.apiKeyUrl, set: !!savedKey || !!process.env[spec.apiKeyEnv] }
    : null;
  return {
    harness,
    displayName: info?.displayName ?? harness,
    installed: info?.installed ?? false,
    version: info?.version ?? null,
    connected: result.connected,
    method: result.method,
    details: result.details,
    loginLabel: spec.login?.label ?? null,
    apiKey,
    // Reported even when connected: a dead credential can sit behind a working
    // login and take runs down without changing how "signed in" looks.
    fault: harnessAuthFault(harness),
    // Drives the Settings logins list + rotation toggle (today only Claude Code).
    multiLogin: harnessSupportsMultiLogin(harness),
  };
}

/** Whether this harness has an interactive sign-in Maestro can run for the user. */
export function harnessHasLogin(harness: HarnessId): boolean {
  return !!SPECS[harness]?.login;
}

/**
 * The specific, repairable reason this harness's CLI can fail every run right
 * now — null when there isn't one. Advisory, not a verdict: the credential it
 * reports is fatal on some CLI builds and quietly ignored on others, so callers
 * offer the repair without gating anything on it. Cheap and synchronous (two
 * small file reads), so a failing turn can ask on the spot.
 */
export function harnessAuthFault(harness: HarnessId): HarnessAuthFault | null {
  if (harness !== 'claude-code') return null;
  // A key saved in Settings is injected as ANTHROPIC_API_KEY at spawn, so the
  // CLI never consults its credential file on a run.
  if (Settings.global().harnessApiKeys?.['claude-code']?.trim()) return null;
  try {
    return claudeAuthFault();
  } catch {
    return null;
  }
}

/** Does the CLI consider itself authenticated? Its own `auth status` is the
 *  authority; the credential files are the fallback for CLIs too old to have it.
 *  Scoped to a specific login (defaults to the active one). */
async function claudeSignedIn(loginId: string = activeLogin('claude-code').id): Promise<boolean> {
  const status = await claudeAuthStatus(harnessLoginEnv('claude-code', loginId));
  if (status) return status.loggedIn;
  const cred = readConfigCredential();
  if (cred && (cred.expiresAt === null || cred.expiresAt > Date.now())) return true;
  const creds = await readOAuthCreds(loginDir('claude-code', loginId));
  return !!creds && !(creds.expiresAt && creds.expiresAt < Date.now());
}

/**
 * The one-click repair behind a fault card: move the dead credential aside so
 * the CLI reaches the login behind it, then ask the CLI whether that worked.
 * Nothing is deleted — the quarantined file keeps its contents under a `.bak`
 * name — and when no login was behind it the caller finishes in the login
 * terminal, which is the same two-step a user would do by hand.
 */
export async function repairHarnessAuth(
  harness: HarnessId,
  loginId: string = activeLogin(harness).id
): Promise<HarnessAuthRepair> {
  if (harness !== 'claude-code') {
    return {
      ok: false,
      movedTo: null,
      needsLogin: !!SPECS[harness]?.login,
      message: `Maestro can't repair ${harness} sign-in automatically — sign in below.`,
    };
  }
  const fault = harnessAuthFault(harness);
  let movedTo: string | null = null;
  if (fault) {
    try {
      movedTo = await quarantineConfigCredential(fault.path);
    } catch (e: any) {
      return {
        ok: false,
        movedTo: null,
        needsLogin: false,
        message: `Couldn't move ${fault.displayPath} aside: ${String(e?.message ?? e)}`,
      };
    }
  }
  const backup = movedTo ? path.basename(movedTo) : null;
  if (await claudeSignedIn(loginId)) {
    return {
      ok: true,
      movedTo,
      needsLogin: false,
      message: backup
        ? `Moved the expired token to ${backup}. Claude Code is signed in again — send your message.`
        : 'Claude Code is signed in — nothing needed repairing.',
    };
  }
  return {
    ok: false,
    movedTo,
    needsLogin: true,
    message: backup
      ? `Moved the expired token to ${backup}. No other login was behind it, so finish signing in below.`
      : 'Claude Code isn’t signed in on this machine — finish signing in below.',
  };
}

const loginPtyId = (harness: HarnessId) => `login:${harness}`;

/** Spawn the harness's interactive login in a pty; the renderer attaches a
 *  terminal to `ptyId` to drive the OAuth/device flow. `loginId` scopes the
 *  login to that credential store (the default when omitted), so signing a
 *  second account in doesn't overwrite the first. */
export function startHarnessLogin(harness: HarnessId, loginId: string = DEFAULT_LOGIN_ID): { ptyId: string } {
  const spec = SPECS[harness];
  if (!spec.login) throw new Error(`${harness} has no interactive login — connect it with an API key instead.`);
  const ptyId = loginPtyId(harness);
  try {
    spawnPty(ptyId, {
      cwd: os.homedir(),
      cols: 90,
      rows: 26,
      command: { file: spec.login.file, args: spec.login.args },
      env: harnessLoginEnv(harness, loginId),
    });
  } catch (e: any) {
    throw new Error(`Couldn't launch ${spec.login.file}: ${String(e?.message ?? e)}`);
  }
  // REPL logins (`claude`, `kimi`) need the TUI to boot before we type `/login`.
  const send = spec.login.send;
  if (send) setTimeout(() => void writePty(ptyId, send), 1200);
  return { ptyId };
}

export function stopHarnessLogin(harness: HarnessId): void {
  killPty(loginPtyId(harness));
}

const installPtyId = (harness: HarnessId) => `install:${harness}`;

/** Run the harness's CLI installer in a login-shell pty; the renderer attaches a
 *  terminal to `ptyId` to watch the output and drive any prompts. Returns the
 *  exact command so the UI can show what's being run. */
export function startHarnessInstall(harness: HarnessId): { ptyId: string; cmd: string } {
  const spec = SPECS[harness];
  if (!spec.install) throw new Error(`No one-click installer for ${harness} — install its CLI manually.`);
  const ptyId = installPtyId(harness);
  const { file, args } = scriptShell(spec.install);
  try {
    spawnPty(ptyId, {
      cwd: os.homedir(),
      cols: 90,
      rows: 26,
      command: { file, args },
    });
  } catch (e: any) {
    throw new Error(`Couldn't start the installer: ${String(e?.message ?? e)}`);
  }
  return { ptyId, cmd: spec.install };
}

export function stopHarnessInstall(harness: HarnessId): void {
  killPty(installPtyId(harness));
}
