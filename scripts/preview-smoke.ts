/**
 * Preview surface end-to-end smoke (§15). Runs as a REAL Electron main process
 * (needs a BrowserWindow to host a WebContentsView), seeds a workspace whose port
 * serves a tiny page (a button that console.errors on click), then exercises the
 * PreviewService + the maestro-preview CLI against the live roleserver:
 *
 *   npm run build:main && npx electron dist/preview-smoke.cjs
 */
import { app, BrowserWindow } from 'electron';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const pExecFile = promisify(execFile);
import { resolveShellEnv, maestroHome } from '../src/main/env';
import { setWindow } from '../src/main/bus';
import { initDb, Workspaces } from '../src/main/db';
import { addProject, createWorkspace } from '../src/main/services/workspaces';
import { startRoleServer, installBridgeClis, roleServerInfo } from '../src/main/services/roleserver';
import {
  capturePreview,
  destroyAllPreviews,
  getConsole,
  openPreview,
  previewElements,
  runPreviewCommand,
  setPreviewVisible,
} from '../src/main/services/preview';
import { PREVIEW_ENV } from '../src/shared/types';

const ROOT = '/tmp/maestro-preview-smoke';
const REPO = path.join(ROOT, 'repo');
const sh = (cmd: string, cwd: string) => execFileSync('sh', ['-lc', cmd], { cwd, stdio: 'pipe' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const PAGE = `<!doctype html><html><head><title>Preview Smoke</title></head>
<body style="margin:0;font:16px system-ui;background:#eef">
<h1 id="title">Preview Smoke Page</h1>
<button class="submit" data-testid="go" id="go" style="padding:20px 32px">Save changes</button>
<script>
  console.log('page ready');
  document.getElementById('go').addEventListener('click', () => console.error('BOOM: button clicked'));
</script></body></html>`;

async function main() {
  resolveShellEnv();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  process.env.MAESTRO_HOME = path.join(ROOT, 'home');

  sh('git init -b main', REPO);
  sh('git config user.email t@t.local && git config user.name T', REPO);
  fs.writeFileSync(path.join(REPO, 'README.md'), '# smoke\n');
  sh('git add -A && git commit -m init', REPO);

  initDb(path.join(ROOT, 'maestro.db'));
  startRoleServer();
  installBridgeClis();

  const project = await addProject({ mode: 'local', path: REPO });
  const ws = await createWorkspace({ projectId: project.id, harness: 'claude-code' });
  const port = ws.port;

  // A tiny dev server on the workspace's port.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  check('test server listening', true, `:${port}`);

  // A window is required to host a WebContentsView.
  const win = new BrowserWindow({ width: 1280, height: 800, show: false });
  setWindow(win);
  await new Promise<void>((r) => (win.webContents.isLoading() ? win.webContents.once('did-stop-loading', () => r()) : r()));

  // ---- open + navigate ----
  const opened = await openPreview(ws.id, `http://localhost:${port}/`);
  check('preview:open returns url', opened.url === `http://localhost:${port}/`, opened.url);
  setPreviewVisible(ws.id, true);
  await sleep(1800); // load + CDP console flush

  // ---- capture ----
  const shot = await capturePreview(ws.id, false);
  check('capture is a PNG', shot.dataUrl.startsWith('data:image/png;base64,') && shot.dataUrl.length > 3000, `${shot.width}x${shot.height} len=${shot.dataUrl.length}`);
  check('capture has size', shot.width > 0 && shot.height > 0 && shot.dpr >= 1);

  // ---- layout index → selector round-trips uniquely ----
  const els = await previewElements(ws.id);
  const btn = els.find((e) => e.tag === 'button' || /Save changes/.test(e.text));
  check('elements found the button', !!btn, btn ? `${btn.selector} "${btn.text}"` : `${els.length} els`);

  // ---- console capture (log emitted on load) ----
  const beforeClick = getConsole(ws.id, 'all');
  check('console captured page load', beforeClick.some((e) => /page ready/.test(e.text)), `${beforeClick.length} entries`);

  // ---- click via the command runner → error is captured ----
  const clickRes = await runPreviewCommand(ws.id, 1, btn ? ['click', btn.selector] : ['click', '#go']);
  check('click command ok', clickRes.ok, clickRes.text.split('\n')[0]);
  await sleep(400);
  const errs = getConsole(ws.id, 'error');
  check('console captured click error', errs.some((e) => /BOOM/.test(e.text)), `${errs.length} error(s)`);

  // ---- selector uniqueness (in-page querySelectorAll === 1) ----
  if (btn) {
    const uniq = await runPreviewCommand(ws.id, 1, ['eval', `document.querySelectorAll(${JSON.stringify(btn.selector)}).length`]);
    check('synthesized selector is unique', uniq.ok && uniq.text.trim() === '1', `${btn.selector} → ${uniq.text.trim()}`);
  }

  // ---- the real CLI shim → live roleserver → screenshot file on disk ----
  // installBridgeClis() copies preview-cli.cjs from next to the running bundle,
  // which here is dist/ (not dist/main/); write the shim explicitly against the
  // built CLI so we exercise the actual CLI → /preview → runPreviewCommand path.
  const info = roleServerInfo();
  const toolsBin = path.join(maestroHome(), 'tools', 'bin');
  fs.mkdirSync(toolsBin, { recursive: true });
  const shim = path.join(toolsBin, 'maestro-preview');
  const cliCjs = path.join(process.cwd(), 'dist', 'main', 'preview-cli.cjs');
  fs.writeFileSync(shim, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cliCjs}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  const env = {
    ...process.env,
    [PREVIEW_ENV.url]: info?.url ?? '',
    [PREVIEW_ENV.token]: info?.token ?? '',
    [PREVIEW_ENV.workspaceId]: ws.id,
    [PREVIEW_ENV.agentId]: '1',
  };
  // MUST be async — execFileSync would block the main event loop the roleserver
  // runs on, deadlocking the CLI's own HTTP call back into this process.
  const { stdout: statusOut } = await pExecFile(shim, ['status'], { env });
  check('CLI status prints URL', statusOut.includes(`localhost:${port}`), statusOut.split('\n')[0]);
  const { stdout: shotOut } = await pExecFile(shim, ['screenshot'], { env });
  const m = shotOut.match(/Saved: (\S+)/);
  const shotRel = m?.[1];
  const shotAbs = shotRel ? path.join(ws.worktreePath, shotRel) : '';
  check('CLI screenshot wrote a file', !!shotAbs && fs.existsSync(shotAbs), shotRel ?? shotOut.slice(0, 60));
  const { stdout: consoleOut } = await pExecFile(shim, ['console', '--level', 'error'], { env });
  check('CLI console shows the error', /BOOM/.test(consoleOut), consoleOut.split('\n')[0]);

  destroyAllPreviews();
  server.close();
  win.destroy();
  console.log(failures === 0 ? 'PREVIEW_SMOKE_PASS' : `PREVIEW_SMOKE_FAILURES=${failures}`);
  app.exit(failures === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('PREVIEW_SMOKE_CRASH', e);
    app.exit(1);
  })
);
