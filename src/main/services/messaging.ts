/**
 * Agent-to-agent messaging (docs/specs/agent-messaging.md) — the service behind
 * the `maestro-message` CLI. A message is an ordinary user message sent into the
 * target chat. This machine's chats go through `sendChat`, which starts a turn,
 * queues behind the running one, or writes a box job. Chats on the user's other
 * linked machines go through the relay, and their desktop picks the message up
 * as a normal `message` job.
 */
import { Projects, Workspaces } from '../db';
import { isAgentRunning } from './harness';
import { agentLoopError, sendChat } from './chat';
import { deviceToken, isLinked, projectSynced, relayFetch } from './account';
import { agentMessageFooter } from '../../shared/chatTitle';
import type { Workspace } from '../../shared/types';

/** One workspace an agent can message, with its chats. */
interface Peer {
  workspaceId: string;
  name: string;
  project: string;
  title: string | null;
  /** 'this machine', a linked desktop's name, or 'cloud'. */
  machine: string;
  remote: boolean;
  /** Whether the machine that runs it is reachable right now. */
  online: boolean;
  /** Every chat the workspace has, closed ones included. */
  chats: { agentId: number; title: string | null; running: boolean; closed: boolean }[];
}

/** The chats a message can go to: the open ones. Locally chat 1 is open unless
 *  its meta says closed — the app shows it even before it has any meta (a blank
 *  first tab). A remote chat must exist on the relay, or a send would 404. */
function openChats(p: Peer): Peer['chats'] {
  const open = p.chats.filter((c) => !c.closed);
  if (!p.remote && !p.chats.some((c) => c.agentId === 1)) {
    open.push({ agentId: 1, title: null, running: isAgentRunning(p.workspaceId, 1), closed: false });
  }
  return open.sort((x, y) => x.agentId - y.agentId);
}

type Result = { ok: boolean; text: string };

const USAGE = [
  'usage:',
  '  maestro-message list                 list every chat you can message',
  "  maestro-message send <address> <<'MSG'",
  '  …message…',
  '  MSG',
  '',
  'An address is `workspace`, `project/workspace`, or either with `#<chat>`.',
].join('\n');

/** A chat's address: its workspace address, plus `#<chat>` for chats past the first. */
function messageAddress(base: string, agentId: number): string {
  return agentId === 1 ? base : `${base}#${agentId}`;
}

/** This machine's messageable workspaces. A shell-harness chat runs its prompt
 *  as a command, so it is never a target. */
function localPeers(): Peer[] {
  return Workspaces.list()
    .filter((ws) => !ws.archived && ws.harness !== 'shell')
    .map((ws) => ({
      workspaceId: ws.id,
      name: ws.name,
      project: Projects.get(ws.projectId)?.name ?? '',
      title: ws.title,
      machine: 'this machine',
      remote: false,
      online: true,
      chats: Object.entries(Workspaces.getChats(ws.id)).map(([id, c]) => ({
        agentId: Number(id),
        title: c.title ?? null,
        running: isAgentRunning(ws.id, Number(id)),
        closed: !!c.closed,
      })),
    }));
}

/** The user's other machines' workspaces, from the relay (when linked). `warning`
 *  says why they're missing. */
async function remotePeers(): Promise<{ peers: Peer[]; warning?: string }> {
  const token = isLinked() ? deviceToken() : null;
  if (!token) return { peers: [] };
  try {
    // Explicit `auth`: a relay that predates device-authed reads answers 401,
    // which must not trip relayFetch's "device revoked" auto-unlink.
    const res = await relayFetch('/api/workspaces', { auth: token });
    if (!res.ok) return { peers: [], warning: `other machines unavailable (relay returned ${res.status})` };
    const fleet: any = await res.json();
    // Every workspace this desktop has or had is ours, whatever the relay still
    // lists (an unpublish that hasn't got through: archived, deleted): skip our
    // own ids and anything under our own device.
    const seen = new Set(Workspaces.list().map((w) => w.id));
    // The relay keeps a revoked machine's workspace rows but lists only live
    // devices and boxes; a workspace whose runner isn't among them can never
    // pick a message up, so it isn't a target.
    const devices = new Map<string, any>((fleet.devices ?? []).map((d: any) => [d.id, d]));
    const boxes = new Map<string, any>((fleet.boxes ?? []).map((b: any) => [b.id, b]));
    const peers: Peer[] = (fleet.workspaces ?? []).flatMap((w: any) => {
      const runner = w.isCloud ? boxes.get(w.boxId) : devices.get(w.deviceId);
      if (!runner || w.archived || w.harness === 'shell' || seen.has(w.id) || w.deviceId === fleet.selfDeviceId)
        return [];
      return [
        {
          workspaceId: w.id,
          name: w.name,
          project: w.projectName ?? '',
          title: w.title ?? null,
          machine: w.isCloud ? `cloud (${runner.label ?? 'box'})` : (runner.name ?? 'another machine'),
          remote: true,
          online: !!runner.online,
          chats: (fleet.sessions ?? [])
            .filter((c: any) => c.workspaceId === w.id)
            .map((c: any) => ({
              agentId: Number(c.agentId),
              title: c.title ?? null,
              running: !!c.running,
              closed: !!c.closed,
            })),
        },
      ];
    });
    return { peers };
  } catch (e: any) {
    return { peers: [], warning: `other machines unavailable (${e?.message ?? e})` };
  }
}

/** The shortest address that's unambiguous among `peers`: `name`, else
 *  `project/name`, else the workspace id (the same project on two machines can
 *  easily have the same workspace name). */
function baseAddress(p: Peer, peers: Peer[]): string {
  const clash = (key: (q: Peer) => string) =>
    peers.some((o) => o !== p && key(o).toLowerCase() === key(p).toLowerCase());
  if (!clash((q) => q.name)) return p.name;
  return clash((q) => `${q.project}/${q.name}`) ? p.workspaceId : `${p.project}/${p.name}`;
}

function formatList(peers: Peer[], self: { workspaceId: string; agentId: number }, warning?: string): string {
  const rows: string[] = [];
  for (const p of peers) {
    const base = baseAddress(p, peers);
    for (const c of openChats(p)) {
      const addr = messageAddress(base, c.agentId);
      const you = p.workspaceId === self.workspaceId && c.agentId === self.agentId ? ' (you)' : '';
      const title = c.title || p.title || 'untitled';
      const state = !p.online ? 'offline' : c.running ? 'busy' : 'idle';
      rows.push(`${addr}${you} — ${title} · ${p.project} · ${p.machine} · ${state}`);
    }
  }
  if (!rows.length) rows.push('(no other chats)');
  if (warning) rows.push('', `note: ${warning}`);
  return rows.join('\n');
}

/** Resolve an address to one peer + chat: null when nothing matches, an error
 *  for an ambiguous name (listing the qualified candidates) or a closed chat. */
function resolve(address: string, peers: Peer[]): { peer: Peer; agentId: number } | { error: string } | null {
  // `#<n>` is a chat suffix only when numeric — a project name may contain '#'.
  const suffix = /^(.*)#(\d+)$/.exec(address);
  const base = suffix ? suffix[1] : address;
  const chatStr = suffix?.[2];
  const slash = base.lastIndexOf('/');
  const project = slash >= 0 ? base.slice(0, slash).toLowerCase() : null;
  const name = base.slice(slash + 1).toLowerCase();
  const matches = peers.filter(
    (p) =>
      (p.name.toLowerCase() === name || p.workspaceId === name) &&
      (project === null || p.project.toLowerCase() === project)
  );
  if (!matches.length) return null;
  if (matches.length > 1) {
    const options = matches.map((p) => `${baseAddress(p, matches)} (${p.machine})`).join(', ');
    return { error: `"${address}" is ambiguous — use one of: ${options}` };
  }
  // A bare address is chat 1 — never "whichever chat is open": a reply to an
  // agent whose tab was closed must not land in some other conversation.
  const peer = matches[0];
  const agentId = chatStr === undefined ? 1 : Number(chatStr);
  if (!openChats(peer).some((c) => c.agentId === agentId)) {
    return { error: `${address} is not an open chat — run \`maestro-message list\`.` };
  }
  return { peer, agentId };
}

async function send(from: Workspace, fromAgent: number, address: string, body: string): Promise<Result> {
  const text = body.trim();
  if (!text) return { ok: false, text: 'no message — pass it on stdin.' };
  // This machine first; only a miss costs a relay round-trip (and a Neon read).
  const local = localPeers();
  let r = resolve(address, local);
  let warning: string | undefined;
  if (!r) {
    const remote = await remotePeers();
    r = resolve(address, remote.peers);
    warning = remote.warning;
  }
  if (!r) {
    const note = warning ? ` (${warning})` : '';
    return { ok: false, text: `no chat found for "${address}" — run \`maestro-message list\`.${note}` };
  }
  if ('error' in r) return { ok: false, text: r.error };
  const { peer, agentId } = r;
  if (peer.workspaceId === from.id && agentId === fromAgent) return { ok: false, text: "that's your own chat." };
  // The loop guard, on the sending side too: a ping-pong fills BOTH chats with
  // agent messages, and this side is the only one that can check when the target
  // is a cloud chat on another machine (its relay job goes to a box, not a desktop).
  const looping = agentLoopError(from.id, fromAgent);
  if (looping) return { ok: false, text: `not sending — ${looping.replace(/^this chat/, 'your chat')}` };

  // How the target should address us back. Another machine resolves names
  // against its own workspaces first, where ours may be shadowed — so it gets our
  // id; here, the shortest address that's unambiguous on this machine.
  const self = local.find((p) => p.workspaceId === from.id);
  const reply = messageAddress(peer.remote || !self ? from.id : baseAddress(self, local), fromAgent);
  const fromProject = Projects.get(from.projectId)?.name ?? '';
  // A footer, not a header: a chat's first message becomes its title.
  const envelope = `${text}\n\n${agentMessageFooter(reply, fromProject)}`;
  // The relay's limit, applied to what's actually sent (footer included).
  if (envelope.length > 32 * 1024) return { ok: false, text: 'message too large (max 32 KB).' };
  // Another machine can only address us through the relay, which never sees a
  // project the user keeps off Maestro Web — the reply command would dead-end.
  if (peer.remote && !projectSynced(from.projectId)) {
    return {
      ok: false,
      text: `not sending — ${fromProject || 'this project'} isn't synced to Maestro Web, so an agent on another machine couldn't reply. The user can turn it on in Settings → Account → Projects to sync.`,
    };
  }

  if (!peer.remote) {
    const blocked = agentLoopError(peer.workspaceId, agentId);
    if (blocked) return { ok: false, text: `could not deliver to ${address}: ${blocked}` };
    const res = await sendChat({
      workspaceId: peer.workspaceId,
      agentId,
      text: envelope,
      attachments: [],
      origin: 'agent',
    });
    if (!res.ok) return { ok: false, text: `could not deliver to ${address}: ${res.error}` };
    return { ok: true, text: `Delivered to ${address}${res.queued ? ' — queued behind its current turn' : ''}.` };
  }
  const res = await relayFetch(`/api/conversations/${encodeURIComponent(`${peer.workspaceId}:${agentId}`)}/send`, {
    method: 'POST',
    auth: deviceToken() ?? '',
    body: JSON.stringify({ text: envelope, origin: 'agent' }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok)
    return { ok: false, text: `could not deliver to ${address}: ${j?.error ?? `relay returned ${res.status}`}` };
  return {
    ok: true,
    text: peer.online
      ? `Delivered to ${address} on ${peer.machine}.`
      : `Queued for ${address} — ${peer.machine} is offline; it runs when that machine reconnects.`,
  };
}

/** The /message loopback route: `list`, or `send <address>` with the message on
 *  stdin. Always `{ ok, text }` — the CLI prints `text`. */
export async function runMessageCommand(
  workspaceId: string,
  agentId: number,
  argv: string[],
  stdin: string
): Promise<Result> {
  const from = Workspaces.get(workspaceId);
  if (!from) return { ok: false, text: 'workspace not found.' };
  // `send` takes exactly one address, so everything after it is the address: a
  // project name may contain spaces, and the remote shim joins args with spaces.
  const [cmd, ...rest] = argv;
  const address = rest.join(' ');
  if (cmd === 'list') {
    const local = localPeers();
    const remote = await remotePeers();
    return { ok: true, text: formatList([...local, ...remote.peers], { workspaceId, agentId }, remote.warning) };
  }
  if (cmd === 'send' && address) return send(from, agentId, address, stdin);
  return { ok: cmd === 'help', text: USAGE };
}
