import fs from 'fs';
import path from 'path';
import { broadcast } from '../bus';
import { userShell } from '../env';
import { Projects, RunScripts, Settings, Workspaces, mustWorkspace, now, uid } from '../db';
import { hostForWorkspace } from '../hosts';
import type { ExecHost } from '../hosts/types';
import { extractJson, generateText } from './llm';
import { isPtyAlive, killPty, spawnPty } from './pty';
import { watchPort, unwatchPort } from './portwatch';
import { scriptEnv } from './scripts';
import { readRepoSettings } from './settingsToml';
import { extractRunCommands } from '../../shared/rundoc';
import type { RunScript, ScriptState, Workspace } from '../../shared/types';

// Run scripts live on the workspace (= branch) and are managed from the Run
// tab — not repo settings. Each script is an instructional markdown doc whose
// shell code blocks execute in order inside the worktree (with its
// WORKSPACE_PORT). AI detection reads the branch's own worktree with the
// third-strongest model tier (same as status digests): branches that change
// the toolchain get matching scripts, and the commands need to be right.

function mustScript(id: string): RunScript {
  const s = RunScripts.get(id);
  if (!s) throw new Error('Run script not found');
  return s;
}

function broadcastScripts(workspaceId: string) {
  broadcast('runscript:changed', { workspaceId, scripts: RunScripts.forWorkspace(workspaceId) });
}

/**
 * Scripts for a workspace. First call migrates a legacy `.maestro/settings.toml`
 * run command into a card (once per workspace — deleting it later doesn't
 * resurrect it).
 */
export function listRunScripts(workspaceId: string): RunScript[] {
  const ws = mustWorkspace(workspaceId);
  const rows = RunScripts.forWorkspace(workspaceId);
  if (rows.length > 0 || Settings.raw(`rsSeeded:${workspaceId}`)) return rows;
  Settings.setRaw(`rsSeeded:${workspaceId}`, '1');
  const project = Projects.get(ws.projectId);
  const legacy = project ? readRepoSettings(project.repoPath).runScript.trim() : '';
  if (!legacy) return rows;
  const seed: RunScript = {
    id: uid(),
    workspaceId,
    name: 'Dev server',
    kind: 'run',
    doc: `Imported from repo settings (.maestro/settings.toml).\n\n\`\`\`sh\n${legacy}\n\`\`\`\n`,
    source: 'user',
    createdAt: now(),
    updatedAt: now(),
  };
  RunScripts.insert(seed);
  return [seed];
}

export function addRunScript(opts: {
  workspaceId: string;
  name: string;
  kind: 'run' | 'test';
  doc: string;
  source?: 'ai' | 'user';
}): RunScript {
  const s: RunScript = {
    id: uid(),
    workspaceId: opts.workspaceId,
    name: opts.name.trim() || 'Untitled script',
    kind: opts.kind,
    doc: opts.doc,
    source: opts.source ?? 'user',
    createdAt: now(),
    updatedAt: now(),
  };
  RunScripts.insert(s);
  broadcastScripts(s.workspaceId);
  return s;
}

export function updateRunScript(scriptId: string, patch: Partial<Pick<RunScript, 'name' | 'kind' | 'doc'>>): RunScript {
  const s = mustScript(scriptId);
  if (patch.name !== undefined) s.name = patch.name.trim() || s.name;
  if (patch.kind !== undefined) s.kind = patch.kind;
  if (patch.doc !== undefined) s.doc = patch.doc;
  s.updatedAt = now();
  RunScripts.update(s);
  broadcastScripts(s.workspaceId);
  return s;
}

export function deleteRunScript(scriptId: string) {
  const s = RunScripts.get(scriptId);
  if (!s) return;
  RunScripts.remove(scriptId);
  broadcastScripts(s.workspaceId);
}

// ---------- AI auto-populate ----------

const generating = new Set<string>();

function readHead(file: string, maxLen: number): string {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, maxLen);
  } catch {
    return '';
  }
}

/** Cheap repo facts the model needs to name the right commands — read from the
 *  branch's worktree so branch-local toolchain changes are visible. Includes a
 *  local-environment inventory (.venv, node_modules) because commands run in a
 *  fresh shell: a console script that only exists inside an unactivated venv
 *  is a `command not found` waiting to happen. */
function repoFacts(root: string): string {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const markers = [
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
    'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'requirements.txt',
    'uv.lock', 'poetry.lock', 'Pipfile', 'Gemfile', 'justfile',
    'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
  ].filter(has);
  const pkg = readHead(path.join(root, 'package.json'), 4000);
  const pyproject = readHead(path.join(root, 'pyproject.toml'), 3000);
  const readme = readHead(path.join(root, 'README.md'), 1500);
  const makefile = readHead(path.join(root, 'Makefile'), 900);
  const legacy = readRepoSettings(root);

  // Local env inventory: what would actually resolve after activation.
  const envLines: string[] = [];
  for (const venv of ['.venv', 'venv']) {
    try {
      const bins = fs.readdirSync(path.join(root, venv, 'bin')).filter((b) => !b.startsWith('.'));
      envLines.push(`${venv}/bin exists with ${bins.length} entries: ${bins.slice(0, 40).join(', ')}`);
    } catch {
      /* no venv here */
    }
  }
  if (envLines.length === 0 && (has('pyproject.toml') || has('requirements.txt'))) {
    envLines.push('No .venv/ or venv/ directory in this worktree yet (Python env may need creating/syncing).');
  }
  if (has('package.json')) {
    envLines.push(fs.existsSync(path.join(root, 'node_modules')) ? 'node_modules/ exists.' : 'node_modules/ is MISSING in this worktree.');
  }

  return [
    `Files present: ${markers.join(', ') || '(none of the common markers)'}`,
    envLines.length ? `Local environment:\n${envLines.join('\n')}` : '',
    pkg ? `package.json:\n${pkg}` : '',
    pyproject ? `pyproject.toml (head):\n${pyproject}` : '',
    makefile ? `Makefile (head):\n${makefile}` : '',
    readme ? `README.md (head):\n${readme}` : '',
    legacy.setupScript ? `Configured setup script: ${legacy.setupScript}` : '',
    legacy.runScript ? `Previously configured run command: ${legacy.runScript}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function generatePrompt(ws: Workspace, userScripts: RunScript[]): string {
  return (
    `You configure one-click run scripts for a repo inside Maestro (an app running coding agents in git worktrees). ` +
    `From the repo facts below (read from the worktree of branch "${ws.branch}"), produce the commands a developer uses to ` +
    `(a) run the app / dev server and (b) run the test suite. You are in the worktree at ${ws.worktreePath} — ` +
    `use your read-only tools to verify anything ambiguous (entry points in pyproject.toml/package.json, config files, ` +
    `what actually exists in .venv/bin or node_modules/.bin) before answering.\n\n` +
    `<repo>\n${repoFacts(ws.worktreePath)}\n</repo>\n\n` +
    (userScripts.length
      ? `User-authored scripts already exist (do NOT produce these kinds): ${userScripts.map((s) => `"${s.name}" (${s.kind})`).join(', ')}\n\n`
      : '') +
    `Reply with STRICT JSON only:\n` +
    `{"scripts": [{"name": "...", "kind": "run" | "test", "doc": "..."}]}\n\n` +
    `Rules for each entry:\n` +
    `- At most one "run" and one "test" script. Omit "test" if the repo has no test setup. If nothing can be determined, return {"scripts": []}.\n` +
    `- "name": 1-3 plain words (e.g. "Dev server", "Tests").\n` +
    `- "doc" is instructional markdown: one short sentence of context, then for EACH command a one-line explanation of why it's needed followed by a \`\`\`sh fenced block containing exactly that command. Every \`\`\`sh block is executed in the workspace terminal, top to bottom — include only commands that should run, nothing hypothetical.\n` +
    `- CRITICAL: each script runs in a FRESH non-interactive shell at the worktree root — no activated venv, no aliases, nothing on PATH beyond system + login shell. Bare project entry points (console scripts, local bins) will fail with "command not found". Make every command self-sufficient:\n` +
    `  · Prefer manager runners that create/sync the local env AND put it on PATH: \`uv run <cmd>\` (uv.lock), \`poetry run <cmd>\` (poetry.lock), \`pnpm exec\`/\`npx\` for JS bins.\n` +
    `  · Otherwise activate explicitly first (own block, e.g. \`source .venv/bin/activate\`) — and if the env may be missing or stale in a fresh worktree, add the one env-sync step that fixes it (e.g. \`uv sync\`, \`npm ci\`) with its why.\n` +
    `- Beyond env activation/sync, no boilerplate installs or builds the command doesn't need.\n` +
    `- Use the repo's real package manager (infer from the lockfile). Don't invent commands that aren't in the repo facts.\n` +
    `- The environment variable WORKSPACE_PORT holds a per-workspace free port. If the dev server accepts a port, pass it (e.g. PORT=$WORKSPACE_PORT or --port $WORKSPACE_PORT) so parallel workspaces don't collide.`
  );
}

/** Detect run/test scripts for this branch (third-strongest model tier);
 *  inserts at most 2 cards. Progress + result also broadcast via
 *  'runscript:generating'/'runscript:changed'. */
export async function generateRunScripts(workspaceId: string): Promise<{ ok: boolean; error?: string; created: number }> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return { ok: false, error: 'Workspace not found', created: 0 };
  if (generating.has(workspaceId)) return { ok: true, created: 0 };
  generating.add(workspaceId);
  broadcast('runscript:generating', { workspaceId, generating: true });
  try {
    const existing = RunScripts.forWorkspace(workspaceId);
    const userScripts = existing.filter((s) => s.source === 'user');
    // Remote workspaces run detection on the host (its CLI + the remote cwd).
    const project = Projects.get(ws.projectId);
    const host = project?.hostId ? hostForWorkspace(ws) : undefined;
    const res = await generateText({
      cwd: ws.worktreePath,
      prompt: generatePrompt(ws, userScripts),
      tier: 'status',
      timeoutMs: 120_000,
      host,
      harness: host ? (ws.harness === 'codex' ? 'codex' : ws.harness === 'grok' ? 'grok' : 'claude-code') : undefined,
    });
    if (!res.text) {
      broadcast('runscript:generating', { workspaceId, generating: false, error: res.error ?? 'Generation failed' });
      return { ok: false, error: res.error ?? 'Generation failed', created: 0 };
    }
    const parsed = extractJson<{ scripts?: { name?: string; kind?: string; doc?: string }[] }>(res.text);
    const list = Array.isArray(parsed?.scripts) ? parsed.scripts : Array.isArray(parsed) ? (parsed as any) : [];
    let created = 0;
    // Re-detection refreshes previous AI results in place (same card id, so
    // open editors and terminal output stay attached); user-authored scripts
    // are never touched and their kind stays theirs.
    const seenKinds = new Set(userScripts.map((s) => s.kind));
    for (const raw of list.slice(0, 4)) {
      const kind = raw?.kind === 'test' ? 'test' : 'run';
      const doc = String(raw?.doc ?? '');
      if (!doc.trim() || !extractRunCommands(doc) || seenKinds.has(kind)) continue;
      seenKinds.add(kind);
      const name = String(raw?.name ?? '').trim() || (kind === 'test' ? 'Tests' : 'Run');
      const prior = existing.find((s) => s.source === 'ai' && s.kind === kind);
      if (prior) updateRunScript(prior.id, { name, doc });
      else addRunScript({ workspaceId, name, kind, doc, source: 'ai' });
      created++;
    }
    broadcast('runscript:generating', {
      workspaceId,
      generating: false,
      error: created === 0 ? 'Could not detect any run or test commands for this branch.' : undefined,
    });
    return created > 0
      ? { ok: true, created }
      : { ok: false, error: 'Could not detect any run or test commands for this branch.', created: 0 };
  } catch (e: any) {
    const error = String(e?.message ?? e);
    broadcast('runscript:generating', { workspaceId, generating: false, error });
    return { ok: false, error, created: 0 };
  } finally {
    generating.delete(workspaceId);
  }
}

// ---------- execution ----------

const states = new Map<string, ScriptState>(); // key `${wsId}:${scriptId}`
// Monotonic run token per key: a re-run replaces the pty, and the OLD pty's
// late onExit/onData must not clobber the NEW run's state.
const runSeq = new Map<string, number>();

const runScriptPtyId = (workspaceId: string, scriptId: string) => `rs:${workspaceId}:${scriptId}`;

function getState(workspaceId: string, scriptId: string): ScriptState {
  return states.get(`${workspaceId}:${scriptId}`) ?? { running: false, exitCode: null, startedAt: null };
}

function setState(workspaceId: string, scriptId: string, state: ScriptState) {
  states.set(`${workspaceId}:${scriptId}`, state);
  broadcast('runscript:state', { workspaceId, scriptId, state });
  // While a run script runs, watch the port so the Preview tab pulses the moment
  // the server binds (not when the script starts) (§5).
  if (state.running) watchPort(workspaceId, 'script');
  else unwatchPort(workspaceId, 'script');
}

// The script phase ends with an invisible OSC escape carrying its exit code
// (xterm swallows unknown OSCs, so the user never sees it). This is how we
// know "done + exit code" even though the terminal itself stays alive.
const EXIT_SENTINEL = /\x1b\]7777;(\d+)\x07/;

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// tmux session name for a cloud run script (§6.8) — bounded, id-safe.
function tmuxSession(workspaceId: string, scriptId: string): string {
  return `mst-${workspaceId.slice(0, 8)}-${scriptId.slice(0, 8)}`;
}

const tmuxAvail = new Map<string, Promise<boolean>>();
/** Does the host have tmux (probed once per host)? Cloud dev servers run inside
 *  it so they outlive the app (§6.8); without it, run scripts stay ephemeral. */
function hostHasTmux(host: ExecHost): Promise<boolean> {
  let p = tmuxAvail.get(host.id);
  if (!p) {
    p = host
      .exec('sh', ['-lc', 'command -v tmux >/dev/null 2>&1 && echo 1 || echo 0'])
      .then((r) => r.ok && r.stdout.trim() === '1')
      .catch(() => false);
    tmuxAvail.set(host.id, p);
  }
  return p;
}

/**
 * Run a script's shell blocks in a real terminal session: the commands execute
 * first (traced, stop on first failure), then the same window execs into the
 * user's interactive login shell at the worktree — so the user can inspect,
 * Ctrl+C a dev server, re-run things, or keep typing. Re-running replaces the
 * terminal with a fresh session.
 */
export async function execRunScript(workspaceId: string, scriptId: string): Promise<{ ok: boolean; error?: string }> {
  const ws = Workspaces.get(workspaceId);
  if (!ws) return { ok: false, error: 'Workspace not found' };
  const script = RunScripts.get(scriptId);
  if (!script) return { ok: false, error: 'Run script not found' };
  const commands = extractRunCommands(script.doc);
  if (!commands) return { ok: false, error: 'This script has no shell code blocks to run yet.' };
  if (getState(workspaceId, scriptId).running) return { ok: false, error: `"${script.name}" is already running` };

  const key = `${workspaceId}:${scriptId}`;
  const token = (runSeq.get(key) ?? 0) + 1;
  runSeq.set(key, token);
  const current = () => runSeq.get(key) === token;

  setState(workspaceId, scriptId, { running: true, exitCode: null, startedAt: now() });

  // Run scripts execute on the workspace's host. Remote targets are POSIX in v1,
  // so use `sh`; local keeps the user's own login shell.
  const host = hostForWorkspace(ws);
  const shell = host.id === 'local' ? userShell() : 'sh';
  // Both branches: run the doc's shell blocks, emit an OSC exit-code sentinel
  // (ESC ]7777;<rc> BEL, matched by EXIT_SENTINEL), then leave the same pty at
  // an interactive prompt so the user can inspect / Ctrl+C / keep typing.
  let command: { file: string; args: string[] };
  if (host.platform === 'win32') {
    // Best-effort PowerShell port. `-NoExit` keeps the session interactive after
    // the blocks run. Note: PowerShell doesn't trace/stop on native-command
    // failures the way bash `set -e` does, so Windows run scripts should guard
    // their own steps (e.g. `if ($LASTEXITCODE) { throw }`).
    const body =
      `${commands}\n` +
      `$__rc = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }\n` +
      `[Console]::Out.Write([char]27 + ']7777;' + $__rc + [char]7)\n`;
    command = { file: shell, args: ['-NoProfile', '-NoExit', '-Command', body] };
  } else {
    // Subshell so `set -e` ends the script phase without killing the wrapper;
    // -x with plain PS4 echoes each command like the doc's code blocks. Pagers
    // are disabled only inside the script phase — the interactive shell that
    // follows is the user's own.
    const body =
      `( export PS4='+ ' PAGER=cat GIT_PAGER=cat; set -ex\n${commands}\n)\n` +
      `__rc=$?\n` +
      `printf '\\033]7777;%d\\007' "$__rc"\n` +
      `exec '${shell}' -il`;
    command = { file: shell, args: ['-lc', body] };
    // Cloud workspaces wrap the session in tmux (§6.8) so a dev server keeps
    // serving when Maestro closes; the attached pty is `tmux attach`, which
    // reattaches to the live session (with scrollback) on re-open. `stop` kills
    // the session. Without tmux, today's ephemeral behavior.
    if (host.id !== 'local' && (await hostHasTmux(host))) {
      const session = tmuxSession(workspaceId, scriptId);
      const bodyFile = host.path.join(scriptEnv(ws).MAESTRO_ROOT_PATH, '.context', `run-${scriptId}.sh`);
      try {
        await host.fs.mkdirp(host.path.dirname(bodyFile));
        await host.fs.write(bodyFile, body + '\n');
        const wrapper =
          `if tmux has-session -t ${shq(session)} 2>/dev/null; then :; ` +
          `else tmux new-session -d -s ${shq(session)} sh ${shq(bodyFile)}; fi\n` +
          `exec tmux attach -t ${shq(session)}`;
        command = { file: 'sh', args: ['-lc', wrapper] };
      } catch {
        // sftp write failed — fall back to the ephemeral direct run above.
      }
    }
  }
  let tail = '';
  spawnPty(runScriptPtyId(workspaceId, scriptId), {
    cwd: ws.worktreePath,
    cols: 100,
    rows: 30,
    env: scriptEnv(ws),
    command,
    host,
    onData: (chunk) => {
      if (!current() || !getState(workspaceId, scriptId).running) return;
      tail = (tail + chunk).slice(-80); // sentinel may split across chunks
      const m = tail.match(EXIT_SENTINEL);
      if (m) {
        tail = '';
        setState(workspaceId, scriptId, { running: false, exitCode: Number(m[1]), startedAt: null });
      }
    },
    onExit: (exitCode) => {
      // Terminal died mid-script (crash / ■ / closed shell before sentinel).
      if (current() && getState(workspaceId, scriptId).running) {
        setState(workspaceId, scriptId, { running: false, exitCode, startedAt: null });
      }
    },
  });
  return { ok: true };
}

export function stopRunScript(workspaceId: string, scriptId: string) {
  const key = `${workspaceId}:${scriptId}`;
  runSeq.set(key, (runSeq.get(key) ?? 0) + 1); // invalidate in-flight handlers
  if (getState(workspaceId, scriptId).running) {
    setState(workspaceId, scriptId, { running: false, exitCode: -1, startedAt: null });
  }
  killPty(runScriptPtyId(workspaceId, scriptId));
  // Cloud: killing the attach pty leaves the tmux session (and dev server)
  // running — stop is an explicit halt, so tear the session down too.
  const ws = Workspaces.get(workspaceId);
  if (ws) {
    const host = hostForWorkspace(ws);
    if (host.id !== 'local') {
      void host.exec('sh', ['-lc', `tmux kill-session -t ${shq(tmuxSession(workspaceId, scriptId))} 2>/dev/null; true`]).catch(() => {});
    }
  }
}

/** Per-script states for one workspace (reconciled against pty liveness). */
export function runScriptStates(workspaceId: string): Record<string, ScriptState> {
  const out: Record<string, ScriptState> = {};
  for (const [key, st] of states) {
    if (!key.startsWith(`${workspaceId}:`)) continue;
    const scriptId = key.slice(workspaceId.length + 1);
    if (st.running && !isPtyAlive(runScriptPtyId(workspaceId, scriptId))) {
      setState(workspaceId, scriptId, { running: false, exitCode: st.exitCode ?? -1, startedAt: null });
    }
    out[scriptId] = getState(workspaceId, scriptId);
  }
  return out;
}
