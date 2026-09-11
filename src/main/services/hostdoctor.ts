import type { DoctorRow, HarnessId, SshHostConfig } from '../../shared/types';
import type { ExecHost } from '../hosts/types';
import { NVM_PATH_SNIPPET } from '../hosts/ssh';
import { probeRemoteHarness } from './harness/remote';
import { syncStatus } from './cloudsync';
import { k8sPreflight } from './kube';

/**
 * One-click remote diagnostics (spec: host-doctor). Read-only: every recent SSH
 * support case was invisible state on the box — what PATH spawns get, whether
 * node/npm exist outside interactive bash, whether a harness is installed and
 * signed in. This assembles the existing probes into rows the user reads off a
 * panel and pastes into a bug report. It fixes nothing, caches nothing, schedules
 * nothing.
 */

/** Tools whose presence + version we report, in display order. `tmux` is a soft
 *  dependency for cloud continuation — it keeps run-script/dev-server sessions
 *  alive when the app closes (§6.8); the readiness panel offers a one-click install. */
const TOOLS = ['node', 'npm', 'git', 'gh', 'curl', 'tar', 'tmux'];
/** Harnesses probed for install/sign-in state, in display order. */
const HARNESSES: HarnessId[] = ['claude-code', 'codex', 'cursor', 'opencode', 'kimi-code', 'grok'];

/** One exec round trip for the env rows. Runs NVM_PATH_SNIPPET first so `$PATH`
 *  matches what agent spawns actually see, then emits one sentinel-prefixed
 *  `__D__<label>__:<value>` line per item — the sentinel survives chatty login
 *  profiles the way resolveLoginPath's does. */
const ENV_SCRIPT =
  `${NVM_PATH_SNIPPET}; ` +
  `printf '__D__os__:%s\\n' "$(uname -sm)"; ` +
  `printf '__D__path__:%s\\n' "$PATH"; ` +
  `for x in ${TOOLS.join(' ')}; do ` +
  `if command -v "$x" >/dev/null 2>&1; then printf '__D__%s__:%s\\n' "$x" "$("$x" --version 2>/dev/null | head -1)"; ` +
  `else printf '__D__%s__:missing\\n' "$x"; fi; done; ` +
  `printf '__D__disk__:%s\\n' "$(df -h "$HOME" | tail -1 | awk '{print $4 " free"}')"`;

/**
 * `cfg` is the host's saved row, when there is one. For a Kubernetes cluster the
 * panel leads with cluster preflight (kubernetes-workspaces.md §4) — kubectl,
 * reachability, RBAC, a default StorageClass — because when those fail there is
 * no box yet to ask anything else about.
 */
export async function hostDoctor(host: ExecHost, cfg?: SshHostConfig | null): Promise<{ rows: DoctorRow[] }> {
  const rows: DoctorRow[] = [];

  if (cfg?.kind === 'k8s') {
    const pre = await k8sPreflight(cfg);
    rows.push(...pre);
    // No node yet (or no way to reach it) ⇒ the in-box probes below would just
    // hang on a connect that can't succeed. Stop with the actionable rows.
    if (pre.some((row) => !row.ok && row.label !== 'storage' && row.label !== 'node')) return { rows };
  }

  const r = await host.exec('sh', ['-lc', ENV_SCRIPT], { timeout: 15_000 });
  const found = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/__D__(.*?)__:(.*)$/); // sentinel anywhere; unknown lines ignored
    if (m) found.set(m[1], m[2].trim());
  }
  for (const label of ['os', 'path', ...TOOLS, 'disk']) {
    const value = found.get(label) ?? 'missing';
    rows.push({ label, value, ok: value !== 'missing' }); // os/path/disk are always present
  }

  // Harness rows — the existing cached probe, no force.
  const probes = await Promise.all(HARNESSES.map((id) => probeRemoteHarness(host, id)));
  HARNESSES.forEach((id, i) => {
    const s = probes[i];
    const value = !s.installed
      ? 'not installed'
      : `installed${s.version ? ` ${s.version}` : ''}, ${s.authed ? 'signed in' : 'signed out'}`;
    rows.push({ label: id, value, ok: s.installed && s.authed });
  });

  // maestro-sync row (mobile-web §6.5): running / installed-not-running / not installed.
  try {
    const sync = await syncStatus(host);
    rows.push({
      label: 'maestro-sync',
      value: sync === 'running' ? 'running' : sync === 'installed' ? 'installed, not running' : 'not installed',
      ok: sync === 'running',
    });
  } catch {
    rows.push({ label: 'maestro-sync', value: 'unknown', ok: false });
  }

  return { rows };
}
