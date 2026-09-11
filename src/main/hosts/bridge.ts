import { roleServerInfo } from '../services/roleserver';
import type { ExecHost } from './types';

/**
 * The ask/role loopback bridge, remotely (spec §6.7). A remote agent can't reach
 * the local roleserver directly, so on first use we (a) open a reverse SSH
 * forward from the remote's 127.0.0.1 to the local roleserver, and (b) upload
 * ~15-line POSIX-sh + curl shims for `maestro-ask` / `maestro-role` to
 * ~/.maestro/bin on the remote (prepended to the agent's PATH by SshHost). If
 * forwarding is refused (AllowTcpForwarding no) the run proceeds without the
 * ask/role preambles — the composer explains why.
 */

// The shims pass workspace/agent/role/parent as x-maestro-* headers and the raw
// payload (questions JSON / prompt text) as the body — the server's header-mode.
const REMOTE_ASK =
  `#!/bin/sh\n` +
  `exec curl -s -X POST ` +
  `-H "Authorization: Bearer $MAESTRO_ASK_TOKEN" ` +
  `-H "X-Maestro-Workspace: $MAESTRO_ASK_WORKSPACE" ` +
  `-H "X-Maestro-Agent: $MAESTRO_ASK_AGENT" ` +
  `--data-binary @- "$MAESTRO_ASK_URL/ask"\n`;

const REMOTE_ROLE =
  `#!/bin/sh\n` +
  `role="$1"\n` +
  `exec curl -s -X POST ` +
  `-H "Authorization: Bearer $MAESTRO_ROLE_TOKEN" ` +
  `-H "X-Maestro-Role: $role" ` +
  `-H "X-Maestro-Workspace: $MAESTRO_WORKSPACE_ID" ` +
  `-H "X-Maestro-Parent: $MAESTRO_PARENT_AGENT" ` +
  `--data-binary @- "$MAESTRO_ROLE_URL/run"\n`;

// `maestro-preview` passes its argv newline-delimited as the body; the server's
// header-mode splits it back into argv and runs the command (§8, §10).
const REMOTE_PREVIEW =
  `#!/bin/sh\n` +
  `printf '%s\\n' "$@" | exec curl -s -X POST ` +
  `-H "Authorization: Bearer $MAESTRO_PREVIEW_TOKEN" ` +
  `-H "X-Maestro-Workspace: $MAESTRO_PREVIEW_WORKSPACE" ` +
  `-H "X-Maestro-Agent: $MAESTRO_PREVIEW_AGENT" ` +
  `--data-binary @- "$MAESTRO_PREVIEW_URL/preview"\n`;

const bridges = new Map<string, { url: string; token: string } | null>(); // null = tried & failed

/** Set up (once per host) the reverse tunnel + remote shims; returns the tunnel
 *  URL + bearer token agents should call, or null if unavailable (degrade). */
export async function ensureRemoteBridge(host: ExecHost): Promise<{ url: string; token: string } | null> {
  if (host.id === 'local' || !host.forwardLoopback) return null;
  if (bridges.has(host.id)) return bridges.get(host.id)!;
  const info = roleServerInfo();
  if (!info) return null;
  try {
    const home = (await host.exec('sh', ['-lc', 'printf %s "$HOME"'])).stdout.trim() || '.';
    const binDir = host.path.join(home, '.maestro', 'bin');
    await host.fs.mkdirp(binDir);
    for (const [name, body] of [['maestro-ask', REMOTE_ASK], ['maestro-role', REMOTE_ROLE], ['maestro-preview', REMOTE_PREVIEW]] as const) {
      const p = host.path.join(binDir, name);
      await host.fs.write(p, body);
      await host.fs.chmod(p, 0o755);
    }
    const localPort = Number(new URL(info.url).port);
    const { remotePort } = await host.forwardLoopback(localPort);
    const bridge = { url: `http://127.0.0.1:${remotePort}`, token: info.token };
    bridges.set(host.id, bridge);
    return bridge;
  } catch {
    bridges.set(host.id, null);
    return null;
  }
}

/** Forget a host's bridge (on disconnect / config change) so it's rebuilt. */
export function dropRemoteBridge(hostId: string): void {
  bridges.delete(hostId);
}
