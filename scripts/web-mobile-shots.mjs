/**
 * Capture real Maestro Web screens at a phone viewport, light + dark, over CDP.
 * Dev-only tooling for the landing page / README mobile demos.
 *
 *   # 1. seed + boot next dev on :4300 first (see landing/README.md)
 *   # 2. node scripts/web-mobile-shots.mjs <baseUrl> <outDir>
 *
 * SHOT_THEMES=nord:light,synthwave:dark,… also captures the chat screen in those
 * colour families (as chat-<family>-<mode>.png) for the themes showcase.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const BASE = process.argv[2] || 'http://127.0.0.1:4300';
const OUT = process.argv[3] || '/tmp/maestro-web-shot/out';
const PORT = 9200 + (Date.now() % 300); // fresh port each run — avoid a stale lock
const PROFILE = `/tmp/maestro-web-shot/chrome-${Date.now()}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(OUT, { recursive: true });

// Logical phone viewport (iPhone-ish) at 2x for crisp retina captures.
const VW = 390;
const VH = 844;
const DPR = 2;

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Keep the fleet's projects expanded (skip the collapse-once-on-link behavior)
  // and leave theme on `system` so setEmulatedMedia drives light/dark.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      "try{localStorage.setItem('maestro.collapsed','[]');localStorage.setItem('maestro.collapsedLink','9999999999999');localStorage.setItem('maestro.theme','system');}catch(e){}",
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VW,
    height: VH,
    deviceScaleFactor: DPR,
    mobile: true,
    screenWidth: VW,
    screenHeight: VH,
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };

  const waitFor = async (jsBool, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await evaluate(`Boolean(${jsBool})`)) return true;
      } catch {
        /* page mid-navigation */
      }
      await sleep(300);
    }
    return false;
  };

  const setTheme = (theme) =>
    cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: theme },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });

  const capture = async (name, url, readyExpr, settle = 900) => {
    await cdp.send('Page.navigate', { url: BASE + url });
    await cdp.send('Page.loadEventFired').catch(() => {});
    const ok = await waitFor(readyExpr);
    await sleep(settle);
    // Hide the Next.js dev-mode overlay (bottom-left logo/build watcher) so it
    // never bleeds into a marketing capture.
    await evaluate(`(() => {
      const s = document.getElementById('__shot_hide') || document.createElement('style');
      s.id = '__shot_hide';
      s.textContent = 'nextjs-portal,#__next-build-watcher,[data-nextjs-toast],[data-next-badge-root]{display:none!important}';
      document.head.appendChild(s);
    })()`).catch(() => {});
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: VW, height: VH, scale: DPR },
    });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    console.log(`${ok ? 'OK ' : 'HMM'} ${name}  (${url})`);
  };

  const shots = [
    ['fleet', '/workspaces', `document.body.innerText.includes('dark mode toggle')`],
    ['chat', '/w/wsA?s=1', `document.body.innerText.includes('persists to')`],
    ['diff', '/w/wsA?view=diff', `document.body.innerText.includes('theme.ts')`],
  ];

  // Warm every route once (dev-mode first-hit compile is slow) before capturing.
  for (const [, url, ready] of shots) {
    await cdp.send('Page.navigate', { url: BASE + url });
    await waitFor(ready, 30000);
  }

  for (const theme of ['light', 'dark']) {
    await setTheme(theme);
    for (const [key, url, ready] of shots) {
      await capture(`${key}-${theme}.png`, url, ready);
    }
  }

  // Colour families: the web boot script reads the family from localStorage, so
  // set it on the current (same-origin) page and let the next navigation apply it.
  const families = (process.env.SHOT_THEMES ?? '').split(',').filter(Boolean);
  for (const item of families) {
    const [family, mode = 'light'] = item.split(':');
    await setTheme(mode);
    await evaluate(`localStorage.setItem('maestro.colorTheme', ${JSON.stringify(family)})`);
    const [, url, ready] = shots[1];
    await capture(`chat-${family}-${mode}.png`, url, ready);
  }
  if (families.length) await evaluate(`localStorage.removeItem('maestro.colorTheme')`);

  cdp.close();
  chrome.kill();
  console.log('DONE');
  process.exit(0);
}

main().catch((e) => {
  console.error('SHOT_ERROR', e);
  chrome.kill();
  process.exit(1);
});
