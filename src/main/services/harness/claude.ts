import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run } from '../../exec';
import { modelSupportsEffort, type HarnessAuthFault, type SubUsage, type SubUsageWindow } from '../../../shared/types';
import { parseClaudeLine } from '../../../shared/harness/parse';
import { detectVersion, type BuildOpts, type HarnessAdapter } from './adapter';

/** Claude Code's own config dir (`CLAUDE_CONFIG_DIR` when the user moved it).
 *  `MAESTRO_CLAUDE_HOME` is a dev/test override (mirrors `MAESTRO_CONDUCTOR_HOME`)
 *  so the harness-sync fixtures can point at a scratch tree (spec §8). */
export function claudeDir(): string {
  return (
    process.env.MAESTRO_CLAUDE_HOME?.trim() ||
    process.env.CLAUDE_CONFIG_DIR?.trim() ||
    path.join(os.homedir(), '.claude')
  );
}

/**
 * The macOS-Keychain service name Claude Code stores its credentials under. With
 * no isolation dir it's the plain `Claude Code-credentials` the CLI's default
 * store uses; a per-login dir appends `-<first 8 hex of sha256(dir NFC)>` — the
 * exact scheme `CLAUDE_SECURESTORAGE_CONFIG_DIR` triggers in the CLI (fact 2).
 * Pure; unit-tested.
 */
export function secureStorageService(dir?: string): string {
  return (
    'Claude Code-credentials' +
    (dir ? '-' + createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8) : '')
  );
}

/**
 * Claude Code's OAuth credentials, as the CLI stores them: a JSON blob in
 * ~/.claude/.credentials.json, or (recent macOS installs) the login Keychain.
 * `dir` scopes it to one login's isolated store (fact 1/2); undefined reads the
 * CLI's default store. Read-only — we never refresh the token ourselves: refresh
 * tokens rotate, so refreshing here would revoke the CLI's copy and sign the
 * user out. The CLI refreshes on every run, so a stale token just means "no ring
 * until next turn".
 */
export async function readOAuthCreds(
  dir?: string
): Promise<{ accessToken: string; expiresAt?: number; subscriptionType?: string } | null> {
  const parse = (raw: string) => {
    try {
      const o = JSON.parse(raw)?.claudeAiOauth;
      return o?.accessToken
        ? { accessToken: o.accessToken as string, expiresAt: o.expiresAt as number, subscriptionType: o.subscriptionType as string }
        : null;
    } catch {
      return null;
    }
  };
  try {
    const file = await fs.promises.readFile(path.join(dir ?? claudeDir(), '.credentials.json'), 'utf8');
    const creds = parse(file);
    if (creds) return creds;
  } catch {}
  if (process.platform === 'darwin') {
    const r = await run('security', ['find-generic-password', '-s', secureStorageService(dir), '-w'], { timeout: 5_000 });
    if (r.ok) return parse(r.stdout.trim());
  }
  return null;
}

/**
 * Who a login is, from its own token: the account email (via the OAuth profile
 * endpoint) and the plan (from the token blob, as the ring already reads it).
 * `loginDir` scopes it to one login's store (undefined = default). This is the
 * per-token identity source — `~/.claude.json`'s shared `oauthAccount` reflects
 * only whichever login ran last, so it can't tell logins apart (fact 3). 10s
 * timeout, null on any failure.
 */
export async function fetchClaudeProfile(loginDir?: string): Promise<{ email?: string; plan?: string } | null> {
  const creds = await readOAuthCreds(loginDir);
  if (!creds) return null;
  if (creds.expiresAt && creds.expiresAt < Date.now()) return null;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return { email: typeof j?.account?.email === 'string' ? j.account.email : undefined, plan: creds.subscriptionType };
  } catch {
    return null;
  }
}

// ---------- the credential file, and how it takes runs down ----------
//
// Claude Code >=2.1 keeps a per-config credential under its config dir:
// credentials/<active_config>.json, selected when configs/<name>.json declares
// a `user_oauth` / `oidc_federation` profile. `claude setup-token` writes one —
// a long-lived access token with NO refresh token. Once it expires, a run that
// reads it dies before reaching the model:
//
//   API Error: Access token at <path> has expired and no refresh is available
//   (client_id set, refresh_token empty)
//
// Nothing about that is fixable from inside a turn, and it takes every
// workspace down together, so Maestro repairs it in one click: move the dead
// file aside (never delete) so the login behind it is reachable again — see
// `repairHarnessAuth` in ./auth. Whether the CLI dies on it or ignores it
// varies by version and by what else it can reach, which is why the detection
// below only ever *offers* a repair.

function anthropicConfigDir(): string {
  const explicit = process.env.ANTHROPIC_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(xdg, 'anthropic');
  // [verify] Windows: the CLI's resolver reaches for %USERPROFILE%\AppData\
  // Roaming\Anthropic there rather than the POSIX layout. Guessing wrong is
  // inert — the file simply isn't found and no fault is reported.
  const profile = process.env.USERPROFILE?.trim();
  if (process.platform === 'win32' && profile) return path.join(profile, 'AppData', 'Roaming', 'Anthropic');
  return path.join(os.homedir(), '.config', 'anthropic');
}

function readJsonSync(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The config the CLI is pointed at — `active_config`, or "default". */
function activeConfigName(): string {
  try {
    const name = fs.readFileSync(path.join(anthropicConfigDir(), 'active_config'), 'utf8').trim();
    // The name is a file stem; refuse anything that could escape the directory.
    if (name && !/[\\/]/.test(name) && name !== '..') return name;
  } catch {}
  return 'default';
}

export interface ConfigCredential {
  file: string;
  /** ms epoch (the file stores seconds); null when the credential can't expire */
  expiresAt: number | null;
  /** the CLI can renew it unattended — true for a login, false for setup-token */
  refreshable: boolean;
  accountEmail?: string;
}

/** The per-config credential file, when the CLI has one. */
export function readConfigCredential(): ConfigCredential | null {
  const file = path.join(anthropicConfigDir(), 'credentials', `${activeConfigName()}.json`);
  const j = readJsonSync(file);
  if (!j || typeof j !== 'object') return null;
  const raw = typeof j.expires_at === 'number' ? j.expires_at : null;
  return {
    file,
    // Seconds in every file we've seen; tolerate ms so a format change can't
    // turn a live credential into a "expired in 1970" false alarm.
    expiresAt: raw === null ? null : raw > 1e12 ? raw : raw * 1000,
    refreshable: typeof j.refresh_token === 'string' && j.refresh_token.trim().length > 0,
    accountEmail: typeof j.account_email === 'string' ? j.account_email : undefined,
  };
}

/** Auth that runs ahead of (or instead of) the credential file, which then can't
 *  be what breaks a run. Maestro-saved API keys are checked by the caller — they
 *  only exist as env at spawn time. */
function credentialFileBypassed(): boolean {
  if (process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim()) return true;
  // Bedrock/Vertex/Foundry authenticate with the cloud provider's own credentials.
  const on = (v?: string) => !!v && v !== '0' && v.toLowerCase() !== 'false';
  if (on(process.env.CLAUDE_CODE_USE_BEDROCK) || on(process.env.CLAUDE_CODE_USE_VERTEX)) return true;
  // An apiKeyHelper mints a key per request, so the file is never consulted.
  const helper = readJsonSync(path.join(claudeDir(), 'settings.json'))?.apiKeyHelper;
  return typeof helper === 'string' && helper.trim().length > 0;
}

const tildify = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

/**
 * The credential fault that can fail every `claude` run on this machine, or null
 * when there isn't one. Deliberately narrow — an expired, non-refreshable
 * credential file and nothing else — so that a false positive is impossible to
 * mistake for a diagnosis of an unrelated failure. Sync and cheap (two small
 * reads), so a failing turn can ask on the spot.
 */
export function claudeAuthFault(): HarnessAuthFault | null {
  if (credentialFileBypassed()) return null;
  const cred = readConfigCredential();
  if (!cred || cred.refreshable || cred.expiresAt === null || cred.expiresAt > Date.now()) return null;
  const when = new Date(cred.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return {
    kind: 'expired-credential',
    harness: 'claude-code',
    path: cred.file,
    displayPath: tildify(cred.file),
    account: cred.accountEmail ?? null,
    summary:
      `The Claude Code token in ${tildify(cred.file)} expired on ${when} and carries no refresh token — ` +
      `a run that reads it fails with this error instead of using your Claude login.`,
  };
}

/** Move the dead credential aside (never delete — it is the user's, and the
 *  backup is how they undo this) so the CLI reaches the login behind it. */
export async function quarantineConfigCredential(file: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d+Z$/, 'Z');
  const dest = `${file}.expired-${stamp}.bak`;
  await fs.promises.rename(file, dest);
  return dest;
}

/** The CLI's own verdict on whether it can authenticate (`claude auth status`,
 *  Claude Code >=2.1). Null when the command is missing or unparseable — an
 *  older CLI, which the caller falls back from rather than guessing. */
export async function claudeAuthStatus(
  env?: Record<string, string>
): Promise<{ loggedIn: boolean; method?: string; email?: string } | null> {
  const r = await run('claude', ['auth', 'status', '--json'], { timeout: 20_000, env });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.stdout.trim());
    if (typeof j?.loggedIn !== 'boolean') return null;
    return {
      loggedIn: j.loggedIn,
      method: typeof j.authMethod === 'string' ? j.authMethod : undefined,
      email: typeof j.email === 'string' ? j.email : undefined,
    };
  } catch {
    return null;
  }
}

/** Display labels for the top-level convenience keys of the usage endpoint —
 *  the legacy fallback when the richer `limits` array is absent. */
const USAGE_WINDOWS: Record<string, string> = {
  five_hour: 'Session (5h)',
  seven_day: 'Weekly — all models',
  seven_day_sonnet: 'Weekly — Sonnet',
  seven_day_opus: 'Weekly — Opus',
};

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/**
 * The `limits` array is the authoritative window list: model-scoped weeklies
 * (e.g. Fable on Max plans) appear ONLY here — the top-level per-model keys
 * stay null — and each entry carries the provider's own severity judgment.
 */
function windowsFromLimits(j: any): SubUsageWindow[] {
  if (!Array.isArray(j?.limits)) return [];
  const out: SubUsageWindow[] = [];
  for (const l of j.limits) {
    if (typeof l?.percent !== 'number') continue;
    const scopeName = l.scope?.model?.display_name || l.scope?.surface;
    const label =
      l.kind === 'session'
        ? 'Session (5h)'
        : l.kind === 'weekly_all'
          ? 'Weekly — all models'
          : scopeName
            ? `Weekly — ${scopeName}`
            : String(l.kind ?? 'limit').replace(/_/g, ' ');
    out.push({
      id: `${l.kind ?? 'limit'}:${scopeName ?? ''}`,
      label,
      pct: clampPct(l.percent),
      resetsAt: typeof l.resets_at === 'string' ? l.resets_at : undefined,
      severity: typeof l.severity === 'string' ? l.severity : undefined,
    });
  }
  return out;
}

/** Legacy shape: scan top-level keys carrying a numeric `utilization`. */
function windowsFromTopLevel(j: any): SubUsageWindow[] {
  const out: SubUsageWindow[] = [];
  for (const [key, v] of Object.entries(j ?? {})) {
    if (key === 'extra_usage') continue; // appended separately in both paths
    const pct = (v as any)?.utilization;
    if (typeof pct !== 'number') continue;
    out.push({
      id: key,
      label: USAGE_WINDOWS[key] ?? key.replace(/_/g, ' '),
      pct: clampPct(pct),
      resetsAt: typeof (v as any).resets_at === 'string' ? (v as any).resets_at : undefined,
    });
  }
  const order = Object.keys(USAGE_WINDOWS);
  out.sort((a, b) => ((order.indexOf(a.id) + 1 || 99) as number) - ((order.indexOf(b.id) + 1 || 99) as number));
  return out;
}

// Claude Code CLI in non-interactive mode with streaming JSON output.
// One process per user turn; conversation continuity via --resume <session-id>.
export const claudeAdapter: HarnessAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  jsonOutput: true,

  detect: () => detectVersion('claude-code', 'Claude Code', 'claude'),

  // Per-login credential isolation: the CLI reads/writes its token under `dir`
  // instead of its default store, leaving sessions + settings shared (fact 1).
  loginIsolation: { env: (dir: string) => ({ CLAUDE_SECURESTORAGE_CONFIG_DIR: dir }) },

  // Who a login is, from its own token (fact 3). `loginDir` undefined = default.
  fetchProfile: (loginDir?: string) => fetchClaudeProfile(loginDir),

  // Subscription usage via the endpoint backing the CLI's /usage screen. It is
  // unofficial (no public equivalent exists), hence the defensive parsing and
  // the nulls instead of errors: no ring beats a broken composer. `loginDir`
  // scopes the credential read to one login (undefined = default).
  async fetchUsage(loginDir?: string): Promise<SubUsage | null> {
    const creds = await readOAuthCreds(loginDir);
    if (!creds) return null;
    if (creds.expiresAt && creds.expiresAt < Date.now()) return null;
    let j: any;
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      j = await res.json();
    } catch {
      return null;
    }
    let windows = windowsFromLimits(j);
    if (!windows.length) windows = windowsFromTopLevel(j);
    // The extra-usage (overflow credits) bucket lives only at the top level.
    const extra = j?.extra_usage;
    if (typeof extra?.utilization === 'number') {
      windows.push({
        id: 'extra_usage',
        label: 'Extra usage',
        pct: clampPct(extra.utilization),
        note:
          extra.is_enabled === false
            ? extra.disabled_reason === 'out_of_credits'
              ? 'out of credits'
              : 'disabled'
            : undefined,
      });
    }
    if (!windows.length) return null;
    return { plan: creds.subscriptionType, windows };
  },

  build(opts: BuildOpts) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.permissionMode && opts.permissionMode !== 'default') {
      args.push('--permission-mode', opts.permissionMode);
    }
    let systemPrompt = opts.systemPrompt ?? '';
    // Effort maps to the thinking-token budget; 'high' is the CLI default.
    // Ultracode additionally pushes the agent to decompose, verify, and self-review.
    // Haiku has no extended-thinking budget, so effort is ignored there.
    const env: Record<string, string> = {};
    const effort = modelSupportsEffort(opts.model ?? '') ? opts.effort : undefined;
    if (effort === 'low') env.MAX_THINKING_TOKENS = '1024';
    else if (effort === 'medium') env.MAX_THINKING_TOKENS = '8192';
    else if (effort === 'max') env.MAX_THINKING_TOKENS = '31999';
    else if (effort === 'ultracode') {
      env.MAX_THINKING_TOKENS = '31999';
      systemPrompt +=
        (systemPrompt ? '\n\n' : '') +
        'Ultracode mode: be maximally thorough. Decompose the task before acting, consider alternative approaches, ' +
        'verify every change by actually running the code or tests, and adversarially self-review the full diff ' +
        'for bugs and missed edge cases before finishing.';
    }
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (opts.model) args.push('--model', opts.model);
    return { cmd: 'claude', args, stdin: opts.prompt, env };
  },

  // Unattended cloud drain: the CLI stamps its session id into every NDJSON line
  // (`"session_id":"…"`); the last one is the resume handle for the next turn.
  unattendedDrain: {
    sessionRecipe:
      `grep -o '"session_id":"[^"]*"' "$MAESTRO_JOURNAL" 2>/dev/null | tail -n 1 | sed 's/.*"session_id":"//; s/".*//'`,
  },

  // Pure NDJSON → events; shared verbatim with the relay ingest (§6.4, G7).
  parseLine: parseClaudeLine,
};
