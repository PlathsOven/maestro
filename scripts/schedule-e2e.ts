/**
 * Scheduled-messages end-to-end: persistence, the timer, boot catch-up,
 * ordering, and the mutators. Runs the real `services/schedule` against a real
 * SQLite file with a stub delivery hook, so everything except `sendChat` itself
 * is the shipping code path.
 *
 * Runs under ELECTRON_RUN_AS_NODE so better-sqlite3 (built for Electron) loads,
 * without opening a window.
 *
 *   npx esbuild scripts/schedule-e2e.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:better-sqlite3 --outfile=dist/schedule-e2e.cjs
 *   ELECTRON_RUN_AS_NODE=1 npx electron dist/schedule-e2e.cjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Scheduled, initDb, now, uid } from '../src/main/db';
import {
  cancelScheduled,
  editScheduled,
  dropScheduledForAgent,
  initScheduler,
  scheduleMessage,
  sendScheduledNow,
  setScheduledDeliveryHook,
} from '../src/main/services/schedule';

/** What the 'chat:schedule:list' IPC returns. */
const listScheduled = (workspaceId: string) => Scheduled.forWorkspace(workspaceId);
import type { ScheduledMessage, SubUsageWindow } from '../src/shared/types';
import { limitResetTarget, nextMinuteAfter } from '../src/shared/limits';

const WS = 'ws-test';
const dbDir = path.join(os.tmpdir(), `maestro-schedule-e2e-${process.pid}`);
const dbPath = path.join(dbDir, 'maestro.db');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stand-in for chat.ts's real hook: record what was handed over, and let a test
// force a failure to prove a failed send still doesn't leave a re-deliverable row.
const delivered: ScheduledMessage[] = [];
let failDelivery = false;
setScheduledDeliveryHook(async (m) => {
  delivered.push(m);
  return failDelivery ? { ok: false, error: 'simulated failure' } : { ok: true };
});

function reset() {
  delivered.length = 0;
  failDelivery = false;
  for (const m of listScheduled(WS)) Scheduled.remove(m.id);
}

async function main() {
  fs.rmSync(dbDir, { recursive: true, force: true });
  initDb(dbPath);

  // ---- 0. "after limits reset" target (pure §1; no DB) ----
  const T = Date.now();
  const win = (id: string, pct: number, resetsAt: number): SubUsageWindow => ({ id, label: id, pct, resetsAt: new Date(resetsAt).toISOString() });
  {
    // Two windows tied at 100%, resetting T+1h and T+3d: wait for the later one,
    // the minute after it resets, and report both windows.
    const t3d = T + 3 * 24 * 3_600_000;
    const r = limitResetTarget({ windows: [win('5h', 100, T + 3_600_000), win('week', 100, t3d)] }, T);
    check('tie waits on both windows', r?.windows.length === 2, String(r?.windows.length));
    check('tie waits until the last reset', r?.at === nextMinuteAfter(t3d), String(r?.at));
  }
  {
    // 100% / 60%: wait only on the 100% window.
    const r = limitResetTarget({ windows: [win('5h', 100, T + 3_600_000), win('week', 60, T + 3 * 24 * 3_600_000)] }, T);
    check('untied waits on the top window only', r?.windows.length === 1 && r?.windows[0].id === '5h', JSON.stringify(r?.windows.map((w) => w.id)));
  }
  {
    // A 100% window whose reset is in the past is ignored (already reset).
    const r = limitResetTarget({ windows: [win('old', 100, T - 60_000), win('live', 50, T + 3_600_000)] }, T);
    check('past resets are ignored', r?.windows.length === 1 && r?.windows[0].id === 'live', JSON.stringify(r?.windows.map((w) => w.id)));
  }
  {
    // Minute rounding: strictly the next whole minute after the reset.
    const at1500 = new Date('2026-09-07T15:00:00.000Z').getTime();
    const at1512 = new Date('2026-09-07T15:12:34.000Z').getTime();
    check('nextMinuteAfter(15:00:00) → 15:01:00', nextMinuteAfter(at1500) === at1500 + 60_000);
    check('nextMinuteAfter(15:12:34) → 15:13:00', nextMinuteAfter(at1512) === new Date('2026-09-07T15:13:00.000Z').getTime());
  }
  check('null usage → no target', limitResetTarget(null) === null);
  check('no live windows → no target', limitResetTarget({ windows: [] }) === null);

  // ---- 1. schedule → persisted and pending ----
  reset();
  const r1 = scheduleMessage({
    workspaceId: WS,
    agentId: 1,
    text: '  run the tests  ',
    attachments: [],
    deliverAt: now() + 60_000,
    kind: 'at',
  });
  const pending = listScheduled(WS);
  check('schedule persists a pending row', r1.ok && pending.length === 1);
  check('text is trimmed', pending[0]?.text === 'run the tests', JSON.stringify(pending[0]?.text));
  check('nothing delivered early', delivered.length === 0);

  // ---- 2. survives a "restart" (fresh initDb over the same file) ----
  initDb(dbPath);
  check('pending row survives a restart', listScheduled(WS).length === 1);

  // ---- 3. rejections ----
  reset();
  const past = scheduleMessage({
    workspaceId: WS, agentId: 1, text: 'too late', attachments: [], deliverAt: now() - 1000, kind: 'at',
  });
  check('a past time is rejected', !past.ok && !!past.error, past.error);
  const empty = scheduleMessage({
    workspaceId: WS, agentId: 1, text: '   ', attachments: [], deliverAt: now() + 60_000, kind: 'at',
  });
  check('an empty message is rejected', !empty.ok);
  check('neither rejection wrote a row', listScheduled(WS).length === 0);

  // ---- 4. the timer actually fires ----
  reset();
  scheduleMessage({
    workspaceId: WS, agentId: 2, text: 'fires soon', attachments: [], deliverAt: now() + 1200, kind: 'limit-reset',
  });
  await sleep(2500);
  check('timer delivered the message', delivered.length === 1 && delivered[0]?.text === 'fires soon');
  check('kind survives the round trip', delivered[0]?.kind === 'limit-reset');
  check('agentId survives the round trip', delivered[0]?.agentId === 2);
  check('delivered row is gone', listScheduled(WS).length === 0);

  // ---- 5. several due at once fire oldest-first, exactly once each ----
  reset();
  const base = now() + 1000;
  for (const [i, label] of ['third', 'first', 'second'].entries()) {
    scheduleMessage({
      workspaceId: WS, agentId: 1, text: label, attachments: [],
      // 'first' is earliest, then 'second', then 'third'
      deliverAt: base + (label === 'first' ? 0 : label === 'second' ? 10 : 20) + i * 0,
      kind: 'at',
    });
  }
  await sleep(2500);
  check(
    'simultaneous items deliver in deliverAt order',
    delivered.map((d) => d.text).join(',') === 'first,second,third',
    delivered.map((d) => d.text).join(',')
  );
  check('no row left behind', listScheduled(WS).length === 0);

  // ---- 6. boot catch-up: an overdue row fires at launch ----
  reset();
  Scheduled.insert({
    id: uid(), workspaceId: WS, agentId: 1, text: 'missed while closed', attachments: [],
    kind: 'at', deliverAt: now() - 3 * 3_600_000, createdAt: now() - 4 * 3_600_000,
  });
  initScheduler(); // what src/main/index.ts calls at boot
  await sleep(500);
  check('overdue message fires at next launch', delivered.length === 1 && delivered[0]?.text === 'missed while closed');
  check('caught-up row is cleared', listScheduled(WS).length === 0);

  // ---- 7. a failed send still can't be delivered twice ----
  reset();
  failDelivery = true;
  scheduleMessage({
    workspaceId: WS, agentId: 1, text: 'will fail', attachments: [], deliverAt: now() + 1000, kind: 'at',
  });
  await sleep(2500);
  check('failed delivery was attempted', delivered.length === 1);
  check('failed delivery leaves no re-deliverable row', listScheduled(WS).length === 0);
  failDelivery = false;

  // ---- 8. edit: reword in place, and drop-on-empty ----
  reset();
  const at = now() + 3_600_000;
  scheduleMessage({ workspaceId: WS, agentId: 1, text: 'original', attachments: [], deliverAt: at, kind: 'at' });
  const id = listScheduled(WS)[0]!.id;
  editScheduled(WS, 1, id, '  reworded  ');
  check('edit rewords in place (trimmed)', listScheduled(WS)[0]?.text === 'reworded');
  check('edit leaves the time alone', listScheduled(WS)[0]?.deliverAt === at);
  editScheduled(WS, 1, id, '  ');
  check('emptying the text drops the item', listScheduled(WS).length === 0);
  check('editing never delivered anything', delivered.length === 0);

  // ---- 9. cancel ----
  reset();
  scheduleMessage({
    workspaceId: WS, agentId: 1, text: 'cancel me', attachments: [], deliverAt: now() + 1000, kind: 'at',
  });
  cancelScheduled(WS, 1, listScheduled(WS)[0]!.id);
  await sleep(2000);
  check('cancelled message never fires', delivered.length === 0 && listScheduled(WS).length === 0);

  // ---- 10. send now ----
  reset();
  scheduleMessage({
    workspaceId: WS, agentId: 1, text: 'send me now', attachments: [{ kind: 'file', path: '/tmp/x.txt' } as any],
    deliverAt: now() + 3_600_000, kind: 'at',
  });
  await sendScheduledNow(WS, 1, listScheduled(WS)[0]!.id);
  check('sendNow delivers immediately', delivered.length === 1 && delivered[0]?.text === 'send me now');
  check('attachments round-trip through SQLite', delivered[0]?.attachments?.[0]?.path === '/tmp/x.txt');
  check('sendNow clears the schedule', listScheduled(WS).length === 0);

  // ---- 11. deleting a chat drops only that chat's messages ----
  reset();
  for (const agentId of [1, 1, 2]) {
    scheduleMessage({
      workspaceId: WS, agentId, text: `a${agentId}`, attachments: [], deliverAt: now() + 3_600_000, kind: 'at',
    });
  }
  dropScheduledForAgent(WS, 1);
  const left = listScheduled(WS);
  check('deleting a chat drops its scheduled messages', left.length === 1 && left[0]?.agentId === 2);

  // ---- 12. deleting a workspace cascades (db.ts Workspaces.remove) ----
  reset();
  scheduleMessage({
    workspaceId: WS, agentId: 1, text: 'ws scoped', attachments: [], deliverAt: now() + 3_600_000, kind: 'at',
  });
  scheduleMessage({
    workspaceId: 'other-ws', agentId: 1, text: 'other', attachments: [], deliverAt: now() + 3_600_000, kind: 'at',
  });
  check('listScheduled is workspace-scoped', listScheduled(WS).length === 1 && listScheduled('other-ws').length === 1);

  console.log(failures === 0 ? '\nSCHEDULE_E2E_OK' : `\nSCHEDULE_E2E_FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
