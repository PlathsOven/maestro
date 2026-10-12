/**
 * Publish-path micro-benchmark (docs/specs/perf-cpu-ram.md §6.6). Report only —
 * it asserts nothing, it just puts a number on §3.1: with Maestro Web linked, a
 * streaming turn ran `publishConversation` for every chat in the workspace every
 * 400 ms, and each call materialized the workspace's WHOLE transcript two or
 * three times over (`Messages.list(ws.id).filter(...)`) purely to read a count.
 *
 * Seeds a temp DB with the shape from the spec's baseline (a 3-chat workspace of
 * ~3 MB of agent content), links it to a mock relay, then times:
 *   - `before`: the pre-spec fingerprint pass, i.e. the two whole-workspace reads
 *     `publishConversation` used to do per call (reproduced here — the old code is
 *     gone, and this is the part that was O(transcript)).
 *   - `after`:  the real `publishConversation`, fingerprints already current, so
 *     it is exactly the fingerprint pass and makes no request.
 * and counts the `Messages.list` calls the publish path still makes (target: 0).
 *
 *   npm run bench:publish
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.join(os.tmpdir(), `maestro-perf-bench-${process.pid}`);
process.env.MAESTRO_HOME = path.join(ROOT, 'local');

import { initDb, Messages, Projects, Settings, Workspaces, now, uid } from '../src/main/db';
import { setWindow } from '../src/main/bus';
import * as account from '../src/main/services/account';
import type { ChatMessage, Project, Workspace } from '../src/shared/types';

const CHATS = 3;
const TURNS_PER_CHAT = 10;
const BLOCK_BYTES = 100_000; // ≈ the live install's average agent message (47.6 KB), doubled
const ITERATIONS = 100;

/** A mock relay that 200s everything — the bench must never depend on the network,
 *  and a steady-state pass is expected not to call it at all. */
function startMock(): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) void _;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function seed(): Workspace {
  const project: Project = {
    id: uid(),
    name: 'bench',
    repoPath: path.join(ROOT, 'repo'),
    baseBranch: 'main',
    kind: 'git',
    hostId: null,
    cloudHostId: null,
    createdAt: now(),
  };
  Projects.insert(project);
  const ws: Workspace = {
    id: uid(),
    projectId: project.id,
    name: 'bench-ws',
    hostId: null,
    branch: 'bench',
    wsKind: 'worktree',
    title: 'bench workspace',
    subtitle: null,
    worktreePath: path.join(ROOT, 'repo'),
    harness: 'claude-code',
    status: 'idle',
    port: 4100,
    archived: false,
    createdAt: now(),
    lastUserMessageAt: now(),
    prNumber: null,
    prUrl: null,
    prState: null,
    setupError: null,
  };
  Workspaces.insert(ws);
  const text = 'x'.repeat(BLOCK_BYTES);
  let ts = now() - CHATS * TURNS_PER_CHAT * 2000;
  for (let agentId = 1; agentId <= CHATS; agentId++) {
    Workspaces.patchChat(ws.id, agentId, { title: `bench chat ${agentId}`, titleCustom: true });
    for (let i = 0; i < TURNS_PER_CHAT; i++) {
      const user: ChatMessage = { id: uid(), workspaceId: ws.id, agentId, role: 'user', content: `prompt ${i}`, attachments: [], ts: ++ts };
      Messages.insert(user);
      const agent: ChatMessage = {
        id: uid(),
        workspaceId: ws.id,
        agentId,
        role: 'agent',
        content: JSON.stringify([{ type: 'text', text }]),
        attachments: [],
        ts: ++ts,
        meta: { costUsd: 0.01, durationMs: 100 },
      };
      Messages.insert(agent);
    }
  }
  return ws;
}

/** The whole-workspace reads `publishConversation` used to do on every call:
 *  once for `hasRun`, once for `metaFingerprint`'s `msgs.length`. */
function v1FingerprintPass(ws: Workspace, agentId: number): number {
  const forHasRun = Messages.list(ws.id).filter((m) => m.agentId === agentId);
  const hasRun = forHasRun.some((m) => m.role === 'agent');
  const forCount = Messages.list(ws.id).filter((m) => m.agentId === agentId);
  return (hasRun ? 1 : 0) + forCount.length;
}

const ms = (t: bigint) => Number(t) / 1e6;

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'repo'), { recursive: true });
  const server = await startMock();
  const port = (server.address() as any).port;
  process.env.MAESTRO_RELAY_URL = `http://127.0.0.1:${port}`;

  initDb(path.join(ROOT, 'db.sqlite'));
  setWindow({ on: () => {}, isDestroyed: () => false, isFocused: () => true, webContents: { send: () => {} } } as any);
  const ws = seed();
  const bytes = (Messages.list(ws.id) as ChatMessage[]).reduce((n, m) => n + m.content.length, 0);

  // Link without the device flow: `plain:` is what `encryptSecret` falls back to
  // when Electron's safeStorage is unavailable, which is the case under node.
  Settings.setRaw('account.token', `plain:${Buffer.from('bench-token', 'utf8').toString('base64')}`);
  Settings.setGlobal({ account: { relayUrl: process.env.MAESTRO_RELAY_URL!, deviceName: 'bench', linked: true } });

  // Prime: one real publish per chat so every fingerprint is current and the
  // timed passes below are pure fingerprint work, exactly like the steady state.
  for (let agentId = 1; agentId <= CHATS; agentId++) await account.publishConversation(ws, agentId);
  for (let agentId = 1; agentId <= CHATS; agentId++) await account.publishConversation(ws, agentId);

  let listCalls = 0;
  const realList = Messages.list;
  (Messages as any).list = (workspaceId: string) => {
    listCalls++;
    return realList(workspaceId);
  };

  const t1 = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) for (let agentId = 1; agentId <= CHATS; agentId++) v1FingerprintPass(ws, agentId);
  const beforeMs = ms(process.hrtime.bigint() - t1);
  const beforeListCalls = listCalls;

  listCalls = 0;
  const t2 = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) for (let agentId = 1; agentId <= CHATS; agentId++) await account.publishConversation(ws, agentId);
  const afterMs = ms(process.hrtime.bigint() - t2);
  const afterListCalls = listCalls;
  (Messages as any).list = realList;

  const passes = ITERATIONS * CHATS;
  console.log(`seed:   ${CHATS} chats · ${CHATS * TURNS_PER_CHAT * 2} messages · ${(bytes / 1e6).toFixed(2)} MB of content`);
  console.log(`before: ${beforeMs.toFixed(1)} ms for ${passes} fingerprint passes (${(beforeMs / passes).toFixed(3)} ms each, ${beforeListCalls} Messages.list calls)`);
  console.log(`after:  ${afterMs.toFixed(1)} ms for ${passes} publishConversation passes (${(afterMs / passes).toFixed(3)} ms each, ${afterListCalls} Messages.list calls)`);
  console.log(`speedup: ${(beforeMs / afterMs).toFixed(1)}×`);

  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => {
  console.error('PERF_BENCH_FAIL', e);
  process.exit(1);
});
