import { broadcast } from '../bus';
import { Settings, Subagents, Workspaces, now, uid } from '../db';
import { hostForWorkspace } from '../hosts';
import type { HostChild } from '../hosts/types';
import { scriptEnv } from './scripts';
import { adapters, currentTurnId, setSubagentStopHook } from './harness';
import { harnessKeyEnv } from './harness/auth';
import { harnessLoginEnv } from './harness/logins';
import { applyBlockEvent, finalizeBlocks, newBlockStream, snapshotBlocks } from './harness/stream';
import { wireAdapterStream } from './harness/adapter';
import {
  HARNESS_PLAN_MODE,
  ORCHESTRATOR,
  resolveRoles,
  specialistRoleIds,
  type AgentBlock,
  type AgentEvent,
  type SubagentRun,
} from '../../shared/types';

/** Live specialist runs, keyed by run id, so a stopped/quit orchestrator can
 *  kill the sub-agents it was waiting on. */
const subRuns = new Map<string, { workspaceId: string; parentAgentId: number; stop: () => void }>();

/** Kill matching specialist runs. workspaceId null = all (app quit); agentId
 *  null = every agent in the workspace. */
function stopSubagents(workspaceId: string | null, agentId: number | null) {
  for (const r of subRuns.values()) {
    if (workspaceId && r.workspaceId !== workspaceId) continue;
    if (agentId != null && r.parentAgentId !== agentId) continue;
    r.stop();
  }
}

// Registered at module load (roleserver imports this file at startup), so it's
// wired before any orchestrator turn can run.
setSubagentStopHook(stopSubagents);

/** Concatenated text of a specialist's turn — what the orchestrator reads back. */
function resultText(blocks: AgentBlock[]): string {
  return blocks
    .filter((b): b is Extract<AgentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Run one specialist delegation to completion. Spawns the role's harness with
 * its instructions as the system prompt, records the full trace as a
 * SubagentRun linked to the orchestrator's in-flight turn, streams it to the
 * renderer, and resolves with the final answer for the `maestro-role` CLI to
 * print back to the orchestrator. Independent of the top-level run machinery,
 * so it never touches workspace status or the main chat thread.
 */
export function runRole(req: {
  role: string;
  workspaceId: string;
  parentAgent?: string;
  prompt: string;
}): Promise<{ ok: boolean; text: string; error?: string }> {
  const role = req.role;
  const settings = Settings.global();
  // Any current specialist id is invocable (built-in or user-created); the
  // orchestrator is never a delegation target.
  if (role === ORCHESTRATOR || !specialistRoleIds(settings).includes(role)) {
    return Promise.resolve({ ok: false, text: '', error: `Unknown role "${req.role}"` });
  }
  const ws = Workspaces.get(req.workspaceId);
  if (!ws) return Promise.resolve({ ok: false, text: '', error: 'Workspace not found' });

  const def = resolveRoles(settings)[role];
  const adapter = adapters[def.harness];
  const parentAgentId = Number(req.parentAgent) || 1;
  // Link to the orchestrator's live turn; falls back to a standalone id if the
  // parent already finished (e.g. its Bash call timed out and it moved on).
  const parentMessageId = currentTurnId(req.workspaceId, parentAgentId) ?? uid();
  const runId = uid();
  const startedAt = Date.now();

  const record: SubagentRun = {
    id: runId,
    workspaceId: ws.id,
    parentAgentId,
    parentMessageId,
    role,
    harness: def.harness,
    model: def.model,
    effort: def.effort,
    prompt: req.prompt,
    blocks: [],
    status: 'running',
    ts: now(),
  };
  Subagents.insert(record);
  broadcast('subagent:updated', record);

  // A plan-mode chat must stay read-only end to end, so specialists inherit the
  // parent chat's toggle — gated on their own harness having a plan-style mode.
  const parentPlan =
    !!Workspaces.getChats(ws.id)[String(parentAgentId)]?.planMode && def.harness in HARNESS_PLAN_MODE;

  const cmd = adapter.build({
    prompt: req.prompt,
    sessionId: null,
    permissionMode: parentPlan ? 'plan' : settings.permissionMode,
    systemPrompt: def.md.trim() || null,
    model: def.model || undefined,
    effort: def.effort || undefined,
  });

  // Extras only — the host merges these with its own login env and strips the
  // nested-session vars (§6.2). Specialists don't sub-delegate, so the role
  // handshake env is simply never added here. They follow the harness's active
  // login (like the main turn) but never rotate.
  const spawnEnv = {
    ...scriptEnv(ws),
    ...harnessKeyEnv(def.harness, settings),
    ...harnessLoginEnv(def.harness),
    ...(cmd.env ?? {}),
  };

  return new Promise((resolve) => {
    const stream = newBlockStream();
    let done = false;
    let stopped = false;
    let stderrTail = '';
    let lastBroadcast = 0;

    const pushUpdate = (force: boolean) => {
      const t = Date.now();
      if (!force && t - lastBroadcast < 150) return;
      lastBroadcast = t;
      broadcast('subagent:updated', { ...record, status: 'running', blocks: snapshotBlocks(stream) });
    };

    const finish = (status: 'done' | 'error', d: { error?: string; costUsd?: number; durationMs?: number }) => {
      if (done) return;
      done = true;
      subRuns.delete(runId);
      const blocks = finalizeBlocks(stream);
      const final: SubagentRun = {
        ...record,
        blocks,
        status,
        error: d.error,
        costUsd: d.costUsd,
        durationMs: d.durationMs ?? Date.now() - startedAt,
      };
      Subagents.update(final);
      broadcast('subagent:updated', final);
      resolve(
        status === 'done'
          ? { ok: true, text: resultText(blocks) }
          : { ok: false, text: resultText(blocks), error: d.error || 'Specialist run failed' }
      );
    };

    const onEvent = (ev: AgentEvent) => {
      if (ev.kind === 'done') {
        finish(!stopped && ev.ok ? 'done' : 'error', {
          error: stopped ? 'Stopped' : ev.error,
          costUsd: ev.costUsd,
          durationMs: ev.durationMs,
        });
        return;
      }
      // Session/context carry no blocks. Nor do background tasks: a specialist's
      // die with its own process, and it has no later turn to report them to. A
      // `limit` is bookkeeping too — specialists don't rotate, so it's ignored.
      if (ev.kind === 'session' || ev.kind === 'context' || ev.kind === 'task' || ev.kind === 'limit') return;
      // Broadcast on block-completing events immediately; coalesce text deltas.
      if (applyBlockEvent(stream, ev)) pushUpdate(ev.kind !== 'seg-delta');
    };

    // Specialists run on the workspace's host — same machine as the orchestrator
    // that delegated to them, so cwd and code stay together (§6.7).
    const host = hostForWorkspace(ws);
    const child: HostChild = host.spawnStream(cmd.cmd, cmd.args, { cwd: ws.worktreePath, env: spawnEnv });

    subRuns.set(runId, {
      workspaceId: ws.id,
      parentAgentId,
      stop: () => {
        stopped = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!done) child.kill('SIGKILL');
        }, 3000);
      },
    });

    child.onError((err) => finish('error', { error: `Failed to start ${cmd.cmd}: ${err.message}` }));

    wireAdapterStream(child, adapter, cmd.stdin, onEvent, (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.onClose((code) => {
      // Raw adapters never emit 'done' — synthesize it from the exit code.
      if (done) return;
      onEvent({
        kind: 'done',
        ok: stopped || code === 0,
        error: stopped ? undefined : code !== 0 ? stderrTail.trim() || `exit code ${code}` : undefined,
      });
    });
  });
}
