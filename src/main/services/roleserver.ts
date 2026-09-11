import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { maestroHome } from '../env';
import { runRole } from './roles';
import { cancelAsk, createAsk } from './ask';
import { runPreviewCommand } from './preview';

/**
 * Loopback HTTP bridge the agent's CLIs call back into. Two routes, both gated
 * on a per-launch bearer token and bound to 127.0.0.1 so nothing else on the box
 * can drive them:
 *   POST /run — `maestro-role` delegates a task to a specialist sub-agent.
 *   POST /ask — `maestro-ask` asks the user a structured question and blocks on
 *               the answer (rendered as a picker in the agent's live turn).
 * The agent is spawned by us with the matching MAESTRO_ROLE_ / MAESTRO_ASK_ env
 * vars, shells out to the CLI, and blocks on stdout until we reply.
 */
let server: http.Server | null = null;
let info: { url: string; token: string } | null = null;

export function roleServerInfo(): { url: string; token: string } | null {
  return info;
}

export function startRoleServer(): void {
  if (server) return;
  const token = randomBytes(24).toString('hex');
  server = http.createServer((req, res) => void handleRequest(req, res, token));
  server.on('error', () => {
    info = null;
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server?.address();
    if (addr && typeof addr === 'object') info = { url: `http://127.0.0.1:${addr.port}`, token };
  });
}

export function stopRoleServer(): void {
  try {
    server?.close();
  } catch {}
  server = null;
  info = null;
}

/** Parse a JSON request body, returning undefined (never throwing) on malformed
 *  input so each route can answer with its own 400 shape. */
function tryParse(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
  // Defensive: a blocked call (role delegation or ask) may outlive its client —
  // the agent can be killed mid-wait — so the socket may already be gone here.
  const send = (code: number, obj: unknown) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    } catch {}
  };
  const pathName = (req.url ?? '').split('?')[0];
  if (req.method !== 'POST' || (pathName !== '/run' && pathName !== '/ask' && pathName !== '/preview')) {
    return send(404, { ok: false, error: 'not found' });
  }
  if (req.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized' });

  // Remote agents call in through the curl shims, which can't easily build the
  // JSON envelope in POSIX sh — so they pass workspace/agent/role/parent as
  // `x-maestro-*` headers and the raw payload as the body (questions JSON for
  // /ask, the prompt text for /run). Local Node CLIs send everything in the body.
  const hWorkspace = header(req, 'x-maestro-workspace');
  const headerMode = !!hWorkspace;

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('error', () => send(400, { ok: false, error: 'request error' }));
  req.on('end', async () => {
    if (pathName === '/ask') {
      let questions: unknown;
      if (headerMode) {
        const parsed = tryParse(body);
        if (parsed === undefined) return send(400, { ok: false, error: 'bad json' });
        questions = Array.isArray(parsed) ? parsed : parsed?.questions;
        return handleAsk({ workspaceId: hWorkspace, agentId: header(req, 'x-maestro-agent'), questions }, res, send);
      }
      const j = tryParse(body);
      if (j === undefined) return send(400, { ok: false, error: 'bad json' });
      return handleAsk(j, res, send);
    }

    if (pathName === '/preview') {
      // `maestro-preview` drives the embedded browser pane (§8). Local Node CLIs
      // send `{ workspaceId, agentId, argv }`; remote curl shims send workspace/
      // agent as x-maestro-* headers and the argv as newline-delimited body.
      let workspaceId: string | undefined;
      let agentId: string | undefined;
      let argv: string[] = [];
      if (headerMode) {
        workspaceId = hWorkspace;
        agentId = header(req, 'x-maestro-agent');
        const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body;
        argv = trimmed.length ? trimmed.split('\n') : [];
      } else {
        const j = tryParse(body);
        if (j === undefined) return send(400, { ok: false, text: 'bad json' });
        workspaceId = j?.workspaceId != null ? String(j.workspaceId) : undefined;
        agentId = j?.agentId != null ? String(j.agentId) : undefined;
        argv = Array.isArray(j?.argv) ? j.argv.map(String) : [];
      }
      if (!workspaceId) return send(400, { ok: false, text: 'missing workspaceId' });
      try {
        const result = await runPreviewCommand(workspaceId, Number(agentId) || 1, argv);
        return send(200, result);
      } catch (e: any) {
        return send(200, { ok: false, text: String(e?.message ?? e) });
      }
    }

    // /run
    let role: string | undefined;
    let workspaceId: string | undefined;
    let parentAgent: string | undefined;
    let prompt: string | undefined;
    if (headerMode) {
      role = header(req, 'x-maestro-role');
      workspaceId = hWorkspace;
      parentAgent = header(req, 'x-maestro-parent');
      prompt = body; // raw prompt text
    } else {
      const j = tryParse(body);
      if (j === undefined) return send(400, { ok: false, error: 'bad json' });
      role = j?.role != null ? String(j.role) : undefined;
      workspaceId = j?.workspaceId != null ? String(j.workspaceId) : undefined;
      parentAgent = j?.parentAgent != null ? String(j.parentAgent) : undefined;
      prompt = j?.prompt != null ? String(j.prompt) : undefined;
    }
    if (!role || !workspaceId || !prompt) {
      return send(400, { ok: false, error: 'missing role, workspaceId, or prompt' });
    }
    try {
      const result = await runRole({ role, workspaceId, parentAgent, prompt });
      send(200, result);
    } catch (e: any) {
      send(500, { ok: false, error: String(e?.message ?? e) });
    }
  });
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * `/ask` — the `maestro-ask` CLI posts a structured question here and blocks on
 * the reply. We register it (createAsk broadcasts to the renderer's picker) and
 * answer once the user responds. If the agent dies first, the socket closes and
 * we cancel so nothing leaks. Always replies 200 with an AskResult; the agent
 * reads `ok`/`answers`/`cancelled` — a dismissed prompt is not a transport error.
 */
function handleAsk(j: any, res: http.ServerResponse, send: (code: number, obj: unknown) => void): void {
  if (!j?.workspaceId || !Array.isArray(j?.questions)) {
    return send(400, { ok: false, error: 'missing workspaceId or questions' });
  }
  const { askId, result } = createAsk({
    workspaceId: String(j.workspaceId),
    agentId: Number(j.agentId) || 1,
    questions: j.questions,
  });
  if (askId) res.on('close', () => cancelAsk(askId));
  void result.then((r) => send(200, r));
}

/**
 * Copy one bundled CLI out of the (possibly asar-packed) app to a real path and
 * drop a launcher shim for it onto the agent PATH. The shim re-execs this app as
 * plain Node (ELECTRON_RUN_AS_NODE=1) on the CLI, so no separate Node install is
 * required.
 */
function installCli(toolsDir: string, binDir: string, binName: string, cjsBase: string): void {
  const cliDst = path.join(toolsDir, cjsBase);
  fs.writeFileSync(cliDst, fs.readFileSync(path.join(__dirname, cjsBase)));
  const exe = process.execPath;
  if (process.platform === 'win32') {
    const shim = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${cliDst}" %*\r\n`;
    fs.writeFileSync(path.join(binDir, `${binName}.cmd`), shim);
  } else {
    const shimPath = path.join(binDir, binName);
    fs.writeFileSync(shimPath, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe}" "${cliDst}" "$@"\n`);
    fs.chmodSync(shimPath, 0o755);
  }
}

/**
 * Drop the loopback-bridge launchers onto the agent PATH (`~/maestro/tools/bin`,
 * already prepended in env.resolveShellEnv): `maestro-role` for specialist
 * delegation and `maestro-ask` for asking the user a structured question.
 * Best-effort: if a shim can't be written, that capability is simply unavailable.
 */
export function installBridgeClis(): void {
  try {
    const toolsDir = path.join(maestroHome(), 'tools');
    const binDir = path.join(toolsDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    installCli(toolsDir, binDir, 'maestro-role', 'role-cli.cjs');
    installCli(toolsDir, binDir, 'maestro-ask', 'ask-cli.cjs');
    installCli(toolsDir, binDir, 'maestro-preview', 'preview-cli.cjs');
  } catch {
    // best-effort — leave the bridge CLIs unavailable rather than crash startup
  }
}
