/**
 * Scheduled-messages UI check: drives the real app over CDP, asserting the
 * send-later flow end to end and capturing cropped 2x shots of each step
 * (the same images the spec links).
 *
 *   ELECTRON_RUN_AS_NODE=1 electron dist/seed-schedule-shot.cjs   # fixture DB
 *   node scripts/schedule-ui.mjs <dbPath> <outDir>
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const [dbPath, outDir] = process.argv.slice(2);
const PORT = 9223;
fs.mkdirSync(outDir, { recursive: true });

const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    MAESTRO_DB_PATH: dbPath,
    MAESTRO_USER_DATA: path.join(outDir, 'userdata'),
  },
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('no CDP page target appeared');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    };
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

const COMPOSER = `[document.querySelector('textarea').closest('.rounded-card')]`;
const CARD = `[[...document.querySelectorAll('div')].find(d => d.textContent.trim() === 'Scheduled' && d.children.length <= 1)?.parentElement]`;
const MENU = `[document.querySelector('input[type="datetime-local"]')?.closest('.glass')]`;

async function main() {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await sleep(6500); // workspace load + chat/schedule hydration

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  /** Screenshot cropped to the union of the given elements' rects, at 2x. */
  const shot = async (name, els, pad = 14) => {
    const clip = await evaluate(`(() => {
      const rs = (${els}).filter(Boolean).map(e => e.getBoundingClientRect());
      if (!rs.length) return null;
      const x = Math.max(0, Math.min(...rs.map(r => r.left)) - ${pad});
      const y = Math.max(0, Math.min(...rs.map(r => r.top)) - ${pad});
      return { x, y, width: Math.max(...rs.map(r => r.right)) + ${pad} - x,
               height: Math.max(...rs.map(r => r.bottom)) + ${pad} - y, scale: 2 };
    })()`);
    const { data } = await cdp.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(data, 'base64'));
  };
  const rows = () => evaluate(`document.querySelectorAll('button[title="Cancel scheduled message"]').length`);

  // ---- resting state: the card hydrated from the persisted table ----
  const cardCount = await evaluate(
    `[...document.querySelectorAll('div')].filter(d => d.textContent.trim() === 'Scheduled' && d.children.length <= 1).length`
  );
  check('Scheduled card is rendered', cardCount === 1, `matches=${cardCount}`);
  check(
    'send-later is disabled with an empty composer',
    (await evaluate(`document.querySelector('button[title="Send later…"]')?.disabled`)) === true
  );
  await shot('A-card-and-composer.png', `[...${CARD}, ...${COMPOSER}]`);

  // ---- hovering a row reveals send-now / cancel ----
  const pt = await evaluate(`(() => {
    const r = document.querySelector('button[title="Edit message"]').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
  await sleep(700);
  await shot('B-row-hover-actions.png', CARD);

  // ---- type like a user (React needs the native setter + a bubbling event) ----
  await evaluate(`(() => {
    const ta = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      .call(ta, 'Port the same backoff to the websocket reconnect path, then add tests.');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(400);
  check(
    'send-later enables once there is text',
    (await evaluate(`document.querySelector('button[title="Send later…"]').disabled`)) === false
  );

  // ---- the send-later menu ----
  await evaluate(`document.querySelector('button[title="Send later…"]').click()`);
  await sleep(700);
  const menu = await evaluate(`(() => {
    const el = (${MENU})[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.innerText, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
             vw: innerWidth, vh: innerHeight, input: el.querySelector('input').value };
  })()`);
  check('the menu opened', !!menu);
  console.log('   menu:', JSON.stringify(menu?.text));
  check(
    'menu is fully on-screen',
    menu && menu.left >= 0 && menu.right <= menu.vw && menu.top >= 0 && menu.bottom <= menu.vh
  );
  check('exact-time input defaults to a round hour', /T\d\d:00$/.test(menu?.input ?? ''), menu?.input);
  check('quick options are offered', /In 1 hour/.test(menu?.text ?? ''));
  check('the running-required note is shown', /Sends only while Maestro is running/.test(menu?.text ?? ''));
  await shot('C-send-later-menu.png', `[...${MENU}, ...${COMPOSER}]`);

  // ---- pick a time → it lands in the card ----
  const before = await rows();
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.trim().startsWith('This evening')).click()`);
  await sleep(1600);
  check('picking a time adds a scheduled item', (await rows()) === before + 1, `${before} → ${await rows()}`);
  check('composer is emptied after scheduling', (await evaluate(`document.querySelector('textarea').value`)) === '');
  // Match on text unique to what we just typed — the fixture also mentions
  // "websocket reconnect", so a looser match would assert on the wrong row.
  const added = await evaluate(
    `[...document.querySelectorAll('button[title="Edit message"]')].map(b => b.innerText).find(t => t.includes('then add tests')) ?? null`
  );
  check('the new item shows its text and time', /\bin \d+[hm]/.test(added ?? ''), JSON.stringify(added));
  await shot('D-after-scheduling.png', `[...${CARD}, ...${COMPOSER}]`);

  // ---- cancel removes it again ----
  const n = await rows();
  await evaluate(`document.querySelectorAll('button[title="Cancel scheduled message"]')[0].click()`);
  await sleep(1000);
  check('cancelling removes a scheduled item', (await rows()) === n - 1, `${n} → ${await rows()}`);

  cdp.close();
  console.log(failures === 0 ? '\nUI_OK' : `\nUI_FAILED (${failures})`);
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('UI_ERROR', e);
  child.kill();
  process.exit(1);
});
