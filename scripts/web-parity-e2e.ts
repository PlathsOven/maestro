/**
 * Desktop-parity data-plane verification (web-desktop-parity spec §9.7). Boots
 * the relay handlers against an in-process PGlite DB (no Postgres, no next start
 * — the house pattern) and drives the workspaces endpoint, the device channel,
 * job routing (device vs box), asks, and read-state LWW by calling the handlers
 * directly with crafted Requests (web session via a test header, desktop/box via
 * bearer tokens).
 *
 * Build + run (from repo root, so drizzle + pglite resolve from web/node_modules):
 *   npx esbuild scripts/web-parity-e2e.ts --bundle --platform=node --format=cjs \
 *     --packages=external --outfile=web/dist-e2e/web-parity-e2e.cjs
 *   node web/dist-e2e/web-parity-e2e.cjs
 */
process.env.MAESTRO_WEB_E2E = '1';
process.env.MAESTRO_WEB_PGLITE = '1';
process.env.NODE_ENV = 'test';

import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../web/lib/db';
import { boxes, conversations, devices, events, jobs, readState, users } from '../web/lib/db/schema';
import { hashToken } from '../web/lib/tokens';
import {
  webWorkspaces,
  webWorkspace,
  webWorkspaceDiff,
  putWorkspace,
  putWorkspaceGit,
  putWorkspaceDiff,
  wsDeleteRoute,
  wsPrCreate,
  wsRefresh,
  wsTodoAdd,
  wsCommentAdd,
  convMeta,
  convAskAnswer,
  putAsk,
  deleteAsk,
} from '../web/lib/handlers/workspaces';
import { devicePoll, deviceJobDone } from '../web/lib/handlers/device';
import { resyncDevices, resyncStatus } from '../web/lib/handlers/account';
import { boxWorkspaceGit } from '../web/lib/handlers/box';
import { postAttachment, getAttachment } from '../web/lib/handlers/attachments';
import { webSend, webReadState, webTurns } from '../web/lib/handlers/web';
import { putConversation, deviceReadState, putConvTurn } from '../web/lib/handlers/desktop';
import { boxPoll } from '../web/lib/handlers/box';
import { toTranscript } from '../web/lib/transcript';

const USER = 'user-1';
const DEVICE = 'device-1';
const DEVICE_TOKEN = 'device-token-secret';
const BOX = 'box-1';
const BOX_TOKEN = 'box-token-secret';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const webH = { 'content-type': 'application/json', 'x-maestro-test-user': USER };
const devH = { 'content-type': 'application/json', authorization: `Bearer ${DEVICE_TOKEN}` };
const boxH = { authorization: `Bearer ${BOX_TOKEN}` };

function req(method: string, url: string, headers: Record<string, string>, body?: unknown): Request {
  return new Request(`http://x${url}`, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
}
const jbody = (r: Response) => r.json() as Promise<any>;

async function main() {
  const db = await getDb();
  await db.insert(users).values({ id: USER, githubId: 'gh-1', login: 'tester' }).onConflictDoNothing();
  await db
    .insert(devices)
    .values({ id: DEVICE, userId: USER, kind: 'desktop', name: 'MacBook', platform: 'darwin', tokenHash: hashToken(DEVICE_TOKEN), lastSeenAt: new Date() })
    .onConflictDoNothing();
  await db.insert(boxes).values({ id: BOX, userId: USER, label: 'testbox', tokenHash: hashToken(BOX_TOKEN), lastSeenAt: new Date() }).onConflictDoNothing();

  // ---- 1. desktop publishes a local + a cloud workspace + sessions ----
  await putWorkspace(req('PUT', '/api/workspaces/wsLocal', devH, { projectId: 'p1', projectName: 'Proj', projectKind: 'git', branch: 'feat-local', title: 'Local task', status: 'idle', isCloud: false }), { id: 'wsLocal' });
  await putWorkspace(req('PUT', '/api/workspaces/wsCloud', devH, { projectId: 'p1', projectName: 'Proj', projectKind: 'git', branch: 'feat-cloud', title: 'Cloud task', status: 'idle', isCloud: true, boxId: BOX, hostLabel: 'my-server' }), { id: 'wsCloud' });
  await putConversation(req('PUT', '/api/conversations/wsLocal:1', devH, { projectName: 'Proj', hasRun: true, running: false }), { id: 'wsLocal:1' });
  await putConversation(req('PUT', '/api/conversations/wsCloud:1', devH, { projectName: 'Proj', boxId: BOX, hasRun: true }), { id: 'wsCloud:1' });

  const wsResp = await jbody(await webWorkspaces(req('GET', '/api/workspaces', webH)));
  check('GET /api/workspaces returns both workspaces', wsResp.workspaces.length === 2, `${wsResp.workspaces.length}`);
  check('GET /api/workspaces returns both sessions', wsResp.sessions.length === 2, `${wsResp.sessions.length}`);
  check('project derived from workspaces', wsResp.projects.length === 1 && wsResp.projects[0].id === 'p1');
  check('device reported online', wsResp.devices.length === 1 && wsResp.devices[0].online === true);
  check('cloud workspace flagged isCloud', !!wsResp.workspaces.find((w: any) => w.id === 'wsCloud')?.isCloud);

  // ---- 2. send to the local workspace → job addressed to the device ----
  const sLocal = await jbody(await webSend(req('POST', '/api/conversations/wsLocal:1/send', webH, { text: 'hi local' }), { id: 'wsLocal:1' }));
  check('local send routed to device', sLocal.routedTo === 'device', sLocal.routedTo);
  const [localJob] = await db.select().from(jobs).where(and(eq(jobs.conversationId, 'wsLocal:1'), eq(jobs.kind, 'message')));
  check('local message job has deviceId, not boxId', localJob?.deviceId === DEVICE && !localJob?.boxId);

  // device poll returns it (wait=0 → immediate)
  const poll = await jbody(await devicePoll(req('GET', '/api/device/poll?wait=0&cursor=0', devH)));
  check('device poll returns the local job', poll.jobs.some((j: any) => j.id === localJob.id), `${poll.jobs.length} jobs`);
  await deviceJobDone(req('POST', `/api/device/jobs/${localJob.id}/done`, devH, { ok: true }), { id: localJob.id });
  const [doneJob] = await db.select().from(jobs).where(eq(jobs.id, localJob.id));
  check('device job marked done', doneJob?.status === 'done');
  const jobDoneEv = await db.select().from(events).where(and(eq(events.userId, USER), eq(events.kind, 'job-done')));
  check('job-done event emitted', jobDoneEv.length >= 1);

  // ---- 3. send to the cloud workspace → job addressed to the box ----
  const sCloud = await jbody(await webSend(req('POST', '/api/conversations/wsCloud:1/send', webH, { text: 'hi cloud' }), { id: 'wsCloud:1' }));
  check('cloud send routed to box', sCloud.routedTo === 'box', sCloud.routedTo);
  const [cloudJob] = await db.select().from(jobs).where(and(eq(jobs.conversationId, 'wsCloud:1'), eq(jobs.kind, 'message')));
  check('cloud message job has boxId, not deviceId', cloudJob?.boxId === BOX && !cloudJob?.deviceId);
  const boxPollResp = await jbody(await boxPoll(req('GET', '/api/box/poll?wait=0', boxH)));
  check('box poll returns the cloud job', boxPollResp.jobs.some((j: any) => j.id === cloudJob.id), `${boxPollResp.jobs.length} jobs`);

  // ---- 4. pr on a cloud workspace routes to the DEVICE (not the box) ----
  const prResp = await wsPrCreate(req('POST', '/api/workspaces/wsCloud/pr', webH, {}), { id: 'wsCloud' });
  check('pr_create accepted while desktop online', prResp.status === 200, `${prResp.status}`);
  const [prJob] = await db.select().from(jobs).where(and(eq(jobs.workspaceId, 'wsCloud'), eq(jobs.kind, 'pr_create')));
  check('pr_create job routed to device', prJob?.deviceId === DEVICE && !prJob?.boxId);

  // chat_set (meta) also routes to device
  const metaResp = await convMeta(req('POST', '/api/conversations/wsLocal:1/meta', webH, { model: 'claude-opus-5' }), { id: 'wsLocal:1' });
  check('chat_set accepted', metaResp.status === 200);

  // ---- 5. desktop offline → non-queueable jobs 409; message still queues ----
  await db.update(devices).set({ lastSeenAt: new Date(Date.now() - 120_000) }).where(eq(devices.id, DEVICE));
  const prOffline = await wsPrCreate(req('POST', '/api/workspaces/wsCloud/pr', webH, {}), { id: 'wsCloud' });
  check('pr_create 409 when desktop offline', prOffline.status === 409, `${prOffline.status}`);
  const sendOffline = await webSend(req('POST', '/api/conversations/wsLocal:1/send', webH, { text: 'queue me' }), { id: 'wsLocal:1' });
  check('message still accepted (queues) when desktop offline', sendOffline.status === 200, `${sendOffline.status}`);

  // ---- 6. asks: desktop announces, web answers, desktop resolves ----
  await putAsk(req('PUT', '/api/conversations/wsLocal:1/ask', devH, { askId: 'ask-1', questions: [{ question: 'Which?', options: ['a', 'b'] }] }), { id: 'wsLocal:1' });
  const [convAfterAsk] = await db.select().from(conversations).where(eq(conversations.id, 'wsLocal:1'));
  check('pendingAsk set on the conversation', !!(convAfterAsk?.pendingAsk as any)?.askId);
  const askQEv = await db.select().from(events).where(and(eq(events.userId, USER), eq(events.kind, 'ask-question')));
  check('ask-question event emitted', askQEv.length >= 1);
  // desktop must be back online for a non-queueable ask_answer job
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, DEVICE));
  const ans = await convAskAnswer(req('POST', '/api/conversations/wsLocal:1/ask/ask-1/answer', webH, { answers: [{ question: 'Which?', selected: ['a'] }] }), { id: 'wsLocal:1', askId: 'ask-1' });
  check('ask_answer accepted', ans.status === 200);
  const [answerJob] = await db.select().from(jobs).where(and(eq(jobs.conversationId, 'wsLocal:1'), eq(jobs.kind, 'ask_answer')));
  check('ask_answer job routed to device', answerJob?.deviceId === DEVICE);
  await deleteAsk(req('DELETE', '/api/conversations/wsLocal:1/ask/ask-1', devH), { id: 'wsLocal:1', askId: 'ask-1' });
  const [convAfterResolve] = await db.select().from(conversations).where(eq(conversations.id, 'wsLocal:1'));
  check('pendingAsk cleared', !convAfterResolve?.pendingAsk);
  const askREv = await db.select().from(events).where(and(eq(events.userId, USER), eq(events.kind, 'ask-resolved')));
  check('ask-resolved event emitted', askREv.length >= 1);

  // ---- Phase 2: workflow surfaces data plane ----
  // git_refresh routes to the device.
  const refreshResp = await wsRefresh(req('POST', '/api/workspaces/wsCloud/refresh', webH, { withPatch: true }), { id: 'wsCloud' });
  check('git_refresh accepted', refreshResp.status === 200, `${refreshResp.status}`);
  const [refreshJob] = await db.select().from(jobs).where(and(eq(jobs.workspaceId, 'wsCloud'), eq(jobs.kind, 'git_refresh')));
  check('git_refresh job routed to device', refreshJob?.deviceId === DEVICE);

  // desktop publishes git status + diff stats (putWorkspaceGit) → GET reflects it.
  await putWorkspaceGit(req('PUT', '/api/workspaces/wsCloud/git', devH, { git: { ahead: 1, behind: 0, staged: 2, unstaged: 1, untracked: 0, dirty: true }, diffAdd: 12, diffDel: 3, changedFiles: 3 }), { id: 'wsCloud' });
  const oneWs = await jbody(await webWorkspace(req('GET', '/api/workspaces/wsCloud', webH), { id: 'wsCloud' }));
  check('git patch reflected in GET /api/workspaces/:id', oneWs.workspace.diffAdd === 12 && oneWs.workspace.git?.staged === 2);

  // desktop publishes a diff snapshot → GET /api/workspaces/:id/diff returns it.
  await putWorkspaceDiff(req('PUT', '/api/workspaces/wsCloud/diff', devH, { base: 'main', files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, hunks: [] }], producedBy: 'desktop' }), { id: 'wsCloud' });
  const diffResp = await webWorkspaceDiff(req('GET', '/api/workspaces/wsCloud/diff', webH), { id: 'wsCloud' });
  const diffBody = await jbody(diffResp);
  check('diff snapshot returned', diffResp.status === 200 && Array.isArray(diffBody.files) && diffBody.files.length === 1);

  // §9.6 box-side git report: the box posts a raw patch + porcelain; the relay
  // parses them (shared diffparse) into git stats + structured diff files.
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const patch = ['diff --git a/x.ts b/x.ts', 'index 0..1 100644', '--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,3 @@', ' a', '-b', '+b2', '+c'].join('\n') + '\n';
  const porcelain = ['# branch.head feat-cloud', '# branch.ab +2 -0', '1 .M N... 100644 100644 100644 aaa bbb x.ts'].join('\n') + '\n';
  const bgit = await boxWorkspaceGit(
    req('POST', '/api/box/workspaces/wsCloud/git', { authorization: `Bearer ${BOX_TOKEN}` }, { base: 'main', statusB64: b64(porcelain), patchB64: b64(patch) }),
    { id: 'wsCloud' }
  );
  check('box git report accepted', bgit.status === 200, `${bgit.status}`);
  const bws = await jbody(await webWorkspace(req('GET', '/api/workspaces/wsCloud', webH), { id: 'wsCloud' }));
  check('box git report parsed diff stats', bws.workspace.diffAdd === 2 && bws.workspace.diffDel === 1);
  const bdiff = await jbody(await webWorkspaceDiff(req('GET', '/api/workspaces/wsCloud/diff', webH), { id: 'wsCloud' }));
  check('box git report produced structured diff', bdiff.files.length === 1 && bdiff.files[0].path === 'x.ts' && bdiff.producedBy === 'box');

  // device DELETE removes the relay rows; web DELETE enqueues a job.
  const webDel = await wsDeleteRoute(req('DELETE', '/api/workspaces/wsCloud', webH), { id: 'wsCloud' });
  check('web DELETE enqueues workspace_delete job', webDel.status === 200);
  const [delJob] = await db.select().from(jobs).where(and(eq(jobs.workspaceId, 'wsCloud'), eq(jobs.kind, 'workspace_delete')));
  check('workspace_delete job routed to device', delJob?.deviceId === DEVICE);
  await wsDeleteRoute(req('DELETE', '/api/workspaces/wsCloud', devH), { id: 'wsCloud' });
  const afterDel = await jbody(await webWorkspaces(req('GET', '/api/workspaces', webH)));
  check('device DELETE removed the workspace row', !afterDel.workspaces.find((w: any) => w.id === 'wsCloud'));

  // ---- Phase 3: todos + comments (published jsonb + jobs) ----
  await putWorkspaceGit(
    req('PUT', '/api/workspaces/wsLocal/git', devH, {
      todos: [{ id: 't1', text: 'ship it', done: false }],
      comments: [{ id: 'c1', file: 'a.ts', line: 2, side: 'new', body: 'nit', resolved: false }],
    }),
    { id: 'wsLocal' }
  );
  const locWs = await jbody(await webWorkspace(req('GET', '/api/workspaces/wsLocal', webH), { id: 'wsLocal' }));
  check('todos published to relay', Array.isArray(locWs.workspace.todos) && locWs.workspace.todos.length === 1);
  check('comments published to relay', Array.isArray(locWs.workspace.comments) && locWs.workspace.comments.length === 1);
  const todoResp = await wsTodoAdd(req('POST', '/api/workspaces/wsLocal/todos', webH, { text: 'another' }), { id: 'wsLocal' });
  check('todo_add accepted', todoResp.status === 200);
  const [todoJob] = await db.select().from(jobs).where(and(eq(jobs.workspaceId, 'wsLocal'), eq(jobs.kind, 'todo_add')));
  check('todo_add routed to device', todoJob?.deviceId === DEVICE);
  const cmtResp = await wsCommentAdd(req('POST', '/api/workspaces/wsLocal/comments', webH, { file: 'a.ts', line: 2, side: 'new', text: 'fix' }), { id: 'wsLocal' });
  check('comment_add accepted', cmtResp.status === 200);
  const [cmtJob] = await db.select().from(jobs).where(and(eq(jobs.workspaceId, 'wsLocal'), eq(jobs.kind, 'comment_add')));
  check('comment_add routed to device', cmtJob?.deviceId === DEVICE);

  // ---- local live-turn streaming (§6.3): desktop PUTs a running then done turn ----
  await putConvTurn(req('PUT', '/api/conversations/wsLocal:1/turn', devH, { turnId: 'lt1', status: 'running', blocks: [{ type: 'text', text: 'thinking' }], startedAt: Date.now() }), { id: 'wsLocal:1' });
  const t1 = await jbody(await webTurns(req('GET', '/api/conversations/wsLocal:1/turns', webH), { id: 'wsLocal:1' }));
  check('live turn published as running', t1.turns.some((t: any) => t.id === 'lt1' && t.status === 'running'));
  // A mid-stream tick refreshes the blocks while still running (Thinking… → tools).
  await putConvTurn(req('PUT', '/api/conversations/wsLocal:1/turn', devH, { turnId: 'lt1', status: 'running', blocks: [{ type: 'text', text: 'thinking' }, { type: 'tool', id: 'x', name: 'bash', input: {} }], startedAt: Date.now() }), { id: 'wsLocal:1' });
  const t1b = await jbody(await webTurns(req('GET', '/api/conversations/wsLocal:1/turns', webH), { id: 'wsLocal:1' }));
  check('running turn refreshes blocks mid-stream', (t1b.turns.find((t: any) => t.id === 'lt1')?.blocks ?? []).length === 2);
  await putConvTurn(req('PUT', '/api/conversations/wsLocal:1/turn', devH, { turnId: 'lt1', status: 'done', blocks: [{ type: 'text', text: 'done' }], endedAt: Date.now() }), { id: 'wsLocal:1' });
  const t2 = await jbody(await webTurns(req('GET', '/api/conversations/wsLocal:1/turns', webH), { id: 'wsLocal:1' }));
  check('live turn finalized as done', t2.turns.some((t: any) => t.id === 'lt1' && t.status === 'done'));
  // A late/out-of-order "running" tick must NOT revive a finalized turn (the fix
  // for web stranded on "Thinking…" after a turn ends — putConvTurn race guard).
  await putConvTurn(req('PUT', '/api/conversations/wsLocal:1/turn', devH, { turnId: 'lt1', status: 'running', blocks: [{ type: 'text', text: 'stale' }], startedAt: Date.now() }), { id: 'wsLocal:1' });
  const t3 = await jbody(await webTurns(req('GET', '/api/conversations/wsLocal:1/turns', webH), { id: 'wsLocal:1' }));
  check('stale running tick cannot revive a finalized turn', t3.turns.find((t: any) => t.id === 'lt1')?.status === 'done');

  // A cancel before any output: running (empty) then done (empty). The turn must
  // finalize (not hang on running), and toTranscript must not leave an empty
  // "Thinking…" bubble — desktop shows nothing for it either.
  await putConvTurn(req('PUT', '/api/conversations/wsLocal:1/turn', devH, { turnId: 'lt2', status: 'running', blocks: [], startedAt: Date.now() }), { id: 'wsLocal:1' });
  await putConvTurn(req('PUT', '/api/conversations/wsLocal:1/turn', devH, { turnId: 'lt2', status: 'done', blocks: [], endedAt: Date.now() }), { id: 'wsLocal:1' });
  const t4 = await jbody(await webTurns(req('GET', '/api/conversations/wsLocal:1/turns', webH), { id: 'wsLocal:1' }));
  check('cancelled empty turn finalized (not stuck running)', t4.turns.find((t: any) => t.id === 'lt2')?.status === 'done');
  const tr4 = toTranscript(t4);
  check('cancelled empty turn shows no live "Thinking…"', tr4.live === null);
  check('cancelled empty turn shows no empty bubble', !tr4.messages.some((m: any) => m.id === 'lt2'));

  // ---- attachments (§6.4): device uploads a data URL, web loads it as an image ----
  const att = await jbody(await postAttachment(req('POST', '/api/attachments', devH, { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })));
  check('attachment upload returns id + url', !!att.id && att.url === `/api/attachments/${att.id}`);
  const getRes = await getAttachment(req('GET', att.url, webH), { id: att.id });
  check('attachment served as image', getRes.status === 200 && (getRes.headers.get('content-type') || '').startsWith('image/'));

  // ---- 7. read-state: web marks read (now), desktop marks unread (0) ----
  await webReadState(req('PUT', '/api/read-state', webH, { conversationId: 'wsLocal:1', lastReadAt: Date.now() }));
  await deviceReadState(req('PUT', '/api/read-state', devH, { conversationId: 'wsLocal:1', lastReadAt: 0 }));
  const [rs] = await db.select().from(readState).where(and(eq(readState.userId, USER), eq(readState.conversationId, 'wsLocal:1')));
  const readMs = rs ? new Date(rs.lastReadAt as any).getTime() : -1;
  check('mark-unread (lastReadAt: 0) applied, not coerced to now', readMs === 0, `${readMs}`);

  // ---- 8. web "Re-sync" button enqueues a device-global resync for online desktops ----
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, DEVICE));
  const rs1 = await jbody(await resyncDevices(req('POST', '/api/account/resync', webH)));
  check('resync reports the online desktop', rs1.online === 1 && rs1.offline === 0, JSON.stringify(rs1));
  check('resync returns the enqueued job id to poll', Array.isArray(rs1.jobIds) && rs1.jobIds.length === 1, JSON.stringify(rs1.jobIds));
  const [resyncJob] = await db.select().from(jobs).where(and(eq(jobs.deviceId, DEVICE), eq(jobs.kind, 'resync')));
  check('resync job enqueued for the device with no workspace', !!resyncJob && !resyncJob.workspaceId, JSON.stringify(resyncJob && { id: resyncJob.id, ws: resyncJob.workspaceId }));
  check('returned job id matches the enqueued job', rs1.jobIds[0] === resyncJob.id, `${rs1.jobIds[0]} vs ${resyncJob.id}`);
  const rPoll = await jbody(await devicePoll(req('GET', '/api/device/poll?wait=0&cursor=0', devH)));
  check('device poll returns the resync job', rPoll.jobs.some((j: any) => j.id === resyncJob.id && j.kind === 'resync'), `${rPoll.jobs.length} jobs`);
  // Status endpoint reports in-flight before the desktop acks (delivered by the poll).
  const statPending = await jbody(await resyncStatus(req('GET', `/api/account/resync?ids=${resyncJob.id}`, webH)));
  check('resync status reports the job before it finishes', statPending.jobs.length === 1 && statPending.jobs[0].status !== 'done' && statPending.jobs[0].status !== 'failed', JSON.stringify(statPending.jobs));
  // Coalesce: tapping again while the first is un-acked must not pile up jobs.
  const rsAgain = await jbody(await resyncDevices(req('POST', '/api/account/resync', webH)));
  const unacked = await db.select().from(jobs).where(and(eq(jobs.deviceId, DEVICE), eq(jobs.kind, 'resync'), isNull(jobs.ackedAt)));
  check('resync coalesces to one un-acked job per device', unacked.length === 1, `${unacked.length}`);
  check('coalesced resync tracks the same live job', rsAgain.jobIds[0] === resyncJob.id, `${rsAgain.jobIds[0]}`);
  await deviceJobDone(req('POST', `/api/device/jobs/${resyncJob.id}/done`, devH, { ok: true, result: { workspaces: 2 } }), { id: resyncJob.id });
  // Status endpoint now reports the outcome (count re-synced) the UI shows.
  const statDone = await jbody(await resyncStatus(req('GET', `/api/account/resync?ids=${resyncJob.id}`, webH)));
  check('resync status reports done + the workspace count', statDone.jobs[0]?.status === 'done' && statDone.jobs[0]?.workspaces === 2, JSON.stringify(statDone.jobs));
  // Offline desktop: nothing to enqueue, reported as offline so the web can say so.
  await db.update(devices).set({ lastSeenAt: new Date(Date.now() - 120_000) }).where(eq(devices.id, DEVICE));
  const rs2 = await jbody(await resyncDevices(req('POST', '/api/account/resync', webH)));
  check('resync reports an offline desktop and enqueues nothing', rs2.online === 0 && rs2.offline === 1 && rs2.jobIds.length === 0, JSON.stringify(rs2));

  console.log('');
  if (failures) {
    console.log(`${failures} PARITY E2E FAILURE(S)`);
    process.exit(1);
  }
  console.log('ALL PARITY-WEB E2E CHECKS PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
