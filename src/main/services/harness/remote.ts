import type { HarnessId, RemoteHarnessStatus, RemoteInstallResult } from '../../../shared/types';
import type { ExecHost } from '../../hosts/types';
import { NVM_PATH_SNIPPET } from '../../hosts/ssh';
import { Settings } from '../../db';

export type { RemoteHarnessStatus };

/**
 * Remote harness detection (spec §6.6). When a project lives on an SSH host, the
 * agent CLI runs *there* — so what matters is whether e.g. `claude` is installed
 * and authenticated on the server, not on this laptop. These probes power the
 * composer's install hint and the "can't run here" feedback, so a missing remote
 * harness fails loudly instead of the agent silently never replying.
 */

/** The binary each harness invokes (matches each adapter's `cmd`). */
const HARNESS_BIN: Record<HarnessId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  opencode: 'opencode',
  'kimi-code': 'kimi',
  grok: 'grok',
  shell: 'sh',
};

/** Best-effort install command shown when a harness CLI is missing on a host.
 *  These must be self-contained on an empty box (curl/tar only — no language
 *  runtime): codex fetches the official static binary release instead of
 *  `npm i -g`, which dead-ends on servers without node. The release tarball
 *  holds a single `codex-<target>`-named binary (verified at rust-v0.147.0);
 *  musl builds run on any Linux. The first word is what the installer
 *  pre-flights (installRemoteHarness), so keep the fetch tool up front. */
const HARNESS_INSTALL: Record<HarnessId, string> = {
  'claude-code': 'curl -fsSL https://claude.ai/install.sh | bash',
  codex:
    `curl -fsSL -o "$HOME/.codex-cli.tgz" "https://github.com/openai/codex/releases/latest/download/codex-$(uname -m | sed 's/^arm64$/aarch64/;s/^amd64$/x86_64/')-$(uname -s | grep -qi darwin && echo apple-darwin || echo unknown-linux-musl).tar.gz" && ` +
    `rm -rf "$HOME/.codex-cli.d" && mkdir -p "$HOME/.codex-cli.d" "$HOME/.local/bin" && tar -xzf "$HOME/.codex-cli.tgz" -C "$HOME/.codex-cli.d" && ` +
    `mv -f "$HOME/.codex-cli.d/"* "$HOME/.local/bin/codex" && chmod +x "$HOME/.local/bin/codex" && rm -rf "$HOME/.codex-cli.tgz" "$HOME/.codex-cli.d"`,
  // -fsSL (not -fsS): the installer 3xx-redirects, so without -L curl fetches an
  // empty body and the pipe to bash is a silent no-op. Matches auth.ts.
  cursor: 'curl -fsSL https://cursor.com/install | bash',
  opencode: 'curl -fsSL https://opencode.ai/install | bash',
  // The package is @moonshot-ai/kimi-code providing the `kimi` bin — matches
  // auth.ts and the KIMI_CODE_HOME auth check below (the old @moonshotai/kimi-cli
  // name installed a different, wrong CLI).
  'kimi-code': 'npm install -g @moonshot-ai/kimi-code',
  grok: 'curl -fsSL https://x.ai/cli/install.sh | bash', // SSH ⇒ POSIX installer
  shell: '',
};

/**
 * Login command run in the remote terminal. Crucially these use HEADLESS /
 * device-code flows where the CLI supports one: a normal browser-OAuth login
 * redirects to `localhost` on the *server*, which the user's laptop browser
 * can't reach. `codex login --device-auth` prints a code to paste instead;
 * Claude Code / OpenCode already use a paste-a-code / API-key flow that works
 * over SSH. (If a CLI only has a localhost-redirect flow, the terminal at least
 * surfaces the URL so the user can decide.)
 */
export const HARNESS_LOGIN: Record<HarnessId, string> = {
  'claude-code': 'claude login',
  codex: 'codex login --device-auth',
  cursor: 'cursor-agent login',
  opencode: 'opencode auth login',
  'kimi-code': 'kimi login',
  grok: 'grok', // shown as a hint only; real remote path is the API key (spec §4)
  shell: '',
};

/**
 * POSIX-sh test that exits 0 when the harness is SIGNED IN on the host — mirrors
 * the local cred-file / API-key detection in `auth.ts` (SPECS[*].detect), run
 * over the wire. Kept lenient (presence of a token/key, not validity) but never
 * false-positive on a signed-out box: an empty `{}` cred file has no `"` and no
 * token string, so it fails. The probe shell is a login shell (`sh -lc`), so API
 * keys exported from the user's profile are visible here.
 */
const HARNESS_AUTH_CHECK: Record<HarnessId, string> = {
  'claude-code': '[ -n "$ANTHROPIC_API_KEY" ] || grep -q accessToken "$HOME/.claude/.credentials.json" 2>/dev/null',
  codex:
    '[ -n "$OPENAI_API_KEY" ] || grep -q "access_token\\|id_token\\|OPENAI_API_KEY" "$HOME/.codex/auth.json" 2>/dev/null',
  cursor: '[ -n "$CURSOR_API_KEY" ]',
  opencode: 'grep -q \'"\' "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json" 2>/dev/null',
  'kimi-code':
    '[ -n "$MOONSHOT_API_KEY" ] || grep -q \'"\' "${KIMI_CODE_HOME:-$HOME/.kimi-code}/auth.json" 2>/dev/null || grep -q \'"\' "${KIMI_CODE_HOME:-$HOME/.kimi-code}/credentials.json" 2>/dev/null',
  grok: '[ -n "$XAI_API_KEY" ] || [ -s "$HOME/.grok/credentials.json" ] || [ -s "$HOME/.grok/auth.json" ]',
  shell: 'true',
};

/** Pull the usual install destinations into THIS shell — the installer only
 *  edits the login profile, which an already-open session hasn't re-sourced.
 *  Includes nvm's node bins: nvm never shows up in a POSIX login shell at all. */
const PATH_REFRESH =
  `export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$HOME/.npm-global/bin:$PATH"; ${NVM_PATH_SNIPPET}; hash -r 2>/dev/null`;

/** Install + PATH refresh + login — one command; the terminal fallback when the
 *  managed install (installRemoteHarness) isn't wanted or failed. */
function setupCommand(install: string, login: string): string {
  if (!install) return login;
  if (!login) return install;
  return `${install} && { ${PATH_REFRESH}; ${login}; }`;
}

/** The login step alone, PATH-refreshed so it works right after an install. */
function loginCommand(harness: HarnessId): string {
  const login = HARNESS_LOGIN[harness];
  return login ? `{ ${PATH_REFRESH}; ${login}; }` : '';
}

const cache = new Map<string, { at: number; value: RemoteHarnessStatus }>();
const cacheKey = (hostId: string, h: HarnessId) => `${hostId}:${h}`;

/** Probe whether a harness CLI is installed on a host (cached ~2 min). */
export async function probeRemoteHarness(
  host: ExecHost,
  harness: HarnessId,
  force = false
): Promise<RemoteHarnessStatus> {
  const bin = HARNESS_BIN[harness];
  const installHint = HARNESS_INSTALL[harness];
  const loginHint = HARNESS_LOGIN[harness];
  const base = {
    harness,
    bin,
    installHint,
    loginHint,
    loginCommand: loginCommand(harness),
    setupHint: setupCommand(installHint, loginHint),
  };
  if (harness === 'shell') return { ...base, installed: true, authed: true, version: null };

  const key = cacheKey(host.id, harness);
  const hit = cache.get(key);
  // Trust a ready (authed) result for a while, but re-check a not-installed /
  // signed-out one soon — the user is likely mid-fix in the terminal, and a stale
  // negative would keep blocking a harness they just signed into.
  const ttl = hit?.value.authed ? 120_000 : 8_000;
  if (!force && hit && Date.now() - hit.at < ttl) return hit.value;
  // A forced probe follows install/sign-in flows — the profile may have just
  // gained the CLI's PATH entry, so drop the host's cached login PATH with it.
  if (force) host.refreshEnv?.();

  // One round-trip: is the CLI on PATH (+ version), and is it signed in? The two
  // markers are parsed below; a signed-out-but-installed harness is `installed`
  // yet not `authed`, so its models stay disabled instead of 401ing on send.
  // The nvm prelude keeps the probe consistent with what spawns will see:
  // resolveLoginPath appends the same dirs, so "installed" here ⇔ runnable there.
  const script =
    `${NVM_PATH_SNIPPET}; ` +
    `if command -v ${bin} >/dev/null 2>&1; then ` +
    `echo "__V__:$(${bin} --version 2>/dev/null | head -1)"; ` +
    `if ${HARNESS_AUTH_CHECK[harness]}; then echo __AUTH_OK__; fi; ` +
    `else echo __MISSING__; fi`;
  const r = await host.exec('sh', ['-lc', script], { timeout: 15_000 });
  const out = r.stdout.trim();
  const installed = r.ok && out.includes('__V__:') && !out.includes('__MISSING__');
  const version = installed ? out.split('\n').find((l) => l.startsWith('__V__:'))?.slice('__V__:'.length).trim() || null : null;
  // Signed in on the host, OR Maestro holds an API key it injects into the remote
  // spawn env (harnessKeyEnv) — either way the CLI will authenticate on send.
  const savedKey = !!Settings.global().harnessApiKeys?.[harness]?.trim();
  const authed = installed && (out.includes('__AUTH_OK__') || savedKey);
  const value: RemoteHarnessStatus = { ...base, installed, authed, version };
  cache.set(key, { at: Date.now(), value });
  return value;
}

const refreshing = new Set<string>();
/** How long a known-good (authed) probe is served stale before a background
 *  re-check — long, because an installed+signed-in CLI essentially never regresses
 *  mid-session. */
const AUTHED_STALE_MS = 10 * 60_000;

/**
 * Send-path probe: NEVER blocks once a harness is known-good. A login-shell probe
 * (`sh -lc` sources the box's whole profile — nvm/conda/etc.) costs 1–4s, and
 * awaiting it before every spawn was adding that to each spaced-out message. So:
 *   • authed in cache        → return it instantly; refresh in the background if old
 *   • signed-out/missing     → re-check (blocking) so a just-fixed harness unblocks
 *   • never probed           → one blocking probe
 * The strict `probeRemoteHarness` still backs the picker/list where accuracy matters.
 */
export async function probeRemoteHarnessFast(host: ExecHost, harness: HarnessId): Promise<RemoteHarnessStatus> {
  if (harness === 'shell') return probeRemoteHarness(host, harness); // no round-trip
  const key = cacheKey(host.id, harness);
  const hit = cache.get(key);
  if (!hit) return probeRemoteHarness(host, harness);
  if (hit.value.authed) {
    // Serve stale, revalidate in the background (deduped) — the hot path stays free.
    if (Date.now() - hit.at >= AUTHED_STALE_MS && !refreshing.has(key)) {
      refreshing.add(key);
      void probeRemoteHarness(host, harness, true).finally(() => refreshing.delete(key));
    }
    return hit.value;
  }
  // A cached negative is only trusted briefly (the user may be mid-fix); past that,
  // re-check so signing in actually unblocks the next send.
  if (Date.now() - hit.at < 8_000) return hit.value;
  return probeRemoteHarness(host, harness, true);
}

/** Forget cached probes for a host (e.g. after a reconnect or config change). */
function invalidateRemoteHarness(hostId: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`${hostId}:`)) cache.delete(k);
}

/** Installers download a CLI (sometimes a runtime too) — allow a slow box. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Last lines of installer output, so a failure message is legible not a dump. */
function outputTail(stdout: string, stderr: string): string {
  const text = stderr.trim() || stdout.trim();
  return text.split('\n').slice(-6).join('\n').slice(-600).trim();
}

/**
 * Managed one-click install (spec §6.6): run the harness's installer over a
 * plain exec channel — not the terminal — so Maestro sees the exit code and can
 * report success/failure itself instead of asking the user to babysit shell
 * output. Ends with a forced re-probe so the UI flips on its own. Only the
 * interactive login stays in the terminal (device-code flows need the user);
 * the caller starts it when the fresh probe still says signed-out.
 */
export async function installRemoteHarness(host: ExecHost, harness: HarnessId): Promise<RemoteInstallResult> {
  const install = HARNESS_INSTALL[harness];
  const finish = async (error: string | null): Promise<RemoteInstallResult> => {
    invalidateRemoteHarness(host.id);
    const status = await probeRemoteHarness(host, harness, true);
    // The probe outranks the installer's exit code in both directions: a "failed"
    // run that still produced a working CLI is fine, a "clean" one that didn't isn't.
    if (status.installed) return { ok: true, status, needsLogin: !status.authed, error: null };
    return { ok: false, status, needsLogin: false, error };
  };
  if (!install) return finish(null);
  // Pre-flight the tool the installer itself is built on (curl / npm), so a bare
  // box gets an actionable message instead of a shell error buried in output.
  // PATH_REFRESH first: on nvm boxes `npm` only exists in nvm's version dirs
  // (invisible to a bare POSIX login shell), and routing the install through
  // nvm's npm also lands it in a user-writable prefix instead of EACCESing on
  // a system-wide one.
  const tool = install.split(' ')[0];
  const script = `${PATH_REFRESH}; command -v ${tool} >/dev/null 2>&1 || { echo __NO_TOOL__ >&2; exit 127; }; ${install}`;
  const r = await host.exec('sh', ['-lc', script], { timeout: INSTALL_TIMEOUT_MS });
  return finish(
    r.stderr.includes('__NO_TOOL__')
      ? `\`${tool}\` isn't available on this server — install it first (e.g. apt-get install ${tool}), then retry.`
      : r.ok
        ? `The installer finished, but \`${HARNESS_BIN[harness]}\` still isn't on the login-shell PATH.`
        : outputTail(r.stdout, r.stderr) || `Installer exited with code ${r.exitCode}.`
  );
}
