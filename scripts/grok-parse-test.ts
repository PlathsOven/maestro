/**
 * Grok Build adapter unit test (spec §8): drives grokAdapter.parseLine over the
 * captured NDJSON fixtures and asserts the normalized AgentEvent mapping + the
 * blocks the stream accumulator builds from them. No electron/db needed — run it
 * under the repo's TS runner (e.g. `npx tsx scripts/grok-parse-test.ts`).
 *
 * The fixtures under scripts/fixtures/grok are provisional (schema TBD); when a
 * real capture lands, update both them and grokAdapter.parseLine, and this test
 * keeps the mapping contract honest.
 */
import fs from 'fs';
import path from 'path';
import { grokAdapter } from '../src/main/services/harness/grok';
import { finalizeBlocks, newBlockStream, applyBlockEvent } from '../src/main/services/harness/stream';
import { effortLevelsForModel, type AgentBlock, type AgentEvent } from '../src/shared/types';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

function parseFixture(file: string): { events: AgentEvent[]; blocks: AgentBlock[] } {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'grok', file), 'utf8');
  const events: AgentEvent[] = [];
  const stream = newBlockStream();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    for (const ev of grokAdapter.parseLine(line)) {
      events.push(ev);
      // session/context/done carry no blocks (the runner handles them).
      if (ev.kind !== 'session' && ev.kind !== 'context' && ev.kind !== 'done' && ev.kind !== 'task') {
        applyBlockEvent(stream, ev);
      }
    }
  }
  return { events, blocks: finalizeBlocks(stream) };
}

const has = (evs: AgentEvent[], pred: (e: AgentEvent) => boolean) => evs.some(pred);
const toolStarts = (evs: AgentEvent[]) => evs.filter((e) => e.kind === 'tool-start') as Extract<AgentEvent, { kind: 'tool-start' }>[];

// ---- basic-turn: session, reasoning, shell tool, result, done ----
{
  const { events, blocks } = parseFixture('basic-turn.ndjson');
  ok('basic: session id captured', has(events, (e) => e.kind === 'session' && e.sessionId === 'test-4917'));
  ok('basic: thinking segment', blocks.some((b) => b.type === 'thinking' && /summary of package\.json/.test(b.text)));
  const ts = toolStarts(events);
  ok('basic: one tool-start', ts.length === 1);
  ok('basic: shell name normalized', ts[0]?.name === 'shell', ts[0]?.name);
  ok('basic: tool input carried', (ts[0]?.input as any)?.command === 'cat package.json');
  ok('basic: tool-result ok', has(events, (e) => e.kind === 'tool-result' && e.toolId === 'call_1' && e.ok));
  ok('basic: text block', blocks.some((b) => b.type === 'text' && /named \*\*demo\*\*/.test(b.text)));
  ok(
    'basic: done ok + cost + duration',
    has(events, (e) => e.kind === 'done' && e.ok && e.costUsd === 0.0031 && e.durationMs === 4200)
  );
  ok(
    'basic: done carries token usage',
    has(events, (e) => e.kind === 'done' && e.usage?.input === 1200 && e.usage?.output === 64 && e.contextTokens === 1264)
  );
  ok('basic: tool block linked to result', blocks.some((b) => b.type === 'tool' && b.result?.ok === true));
}

// ---- edit-turn: file-edit tools normalized to "edit" so EditDiff fires ----
{
  const { events, blocks } = parseFixture('edit-turn.ndjson');
  const ts = toolStarts(events);
  ok('edit: two tool-starts', ts.length === 2);
  ok('edit: names normalized to edit', ts.every((t) => t.name === 'edit'), ts.map((t) => t.name).join(','));
  ok('edit: edit input has file_path/old_string', (ts[0]?.input as any)?.file_path === 'src/index.ts' && (ts[0]?.input as any)?.old_string === 'const x = 1;');
  ok('edit: write input has content', (ts[1]?.input as any)?.content?.includes('# Notes'));
  ok('edit: both tool blocks resolved ok', blocks.filter((b) => b.type === 'tool' && b.result?.ok).length === 2);
  ok('edit: done ok', has(events, (e) => e.kind === 'done' && e.ok));
}

// ---- assistant-combined: one assistant record w/ reasoning + array content + tool_calls ----
{
  const { events, blocks } = parseFixture('assistant-combined.ndjson');
  ok('combined: session id captured', has(events, (e) => e.kind === 'session' && e.sessionId === 'test-6633'));
  const ts = toolStarts(events);
  ok('combined: tool from tool_calls[].function', ts.length === 1 && ts[0].name === 'shell');
  ok('combined: JSON-string args parsed', (ts[0]?.input as any)?.command === 'ls -la');
  ok('combined: reasoning + text blocks', blocks.some((b) => b.type === 'thinking') && blocks.filter((b) => b.type === 'text').length >= 1);
  ok('combined: tool-result linked', has(events, (e) => e.kind === 'tool-result' && e.toolId === 'tc_1' && e.ok));
  ok('combined: done ok + usage', has(events, (e) => e.kind === 'done' && e.ok && e.contextTokens === 1440));
}

// ---- error: terminal error record maps to done{ok:false} ----
{
  const { events } = parseFixture('error.ndjson');
  ok('error: session first', has(events, (e) => e.kind === 'session'));
  ok(
    'error: done not-ok with message',
    has(events, (e) => e.kind === 'done' && !e.ok && /503 upstream/.test(e.error ?? ''))
  );
}

// ---- robustness: malformed / unknown lines never throw, yield nothing useful ----
{
  ok('robust: garbage → []', grokAdapter.parseLine('not json at all').length === 0);
  ok('robust: empty object → []', grokAdapter.parseLine('{}').length === 0);
  ok('robust: unknown type → []', grokAdapter.parseLine('{"type":"heartbeat"}').length === 0);
}

// ---- build(): flags + client-minted session hint ----
{
  const cmd = grokAdapter.build({ prompt: 'hi', sessionId: null, permissionMode: 'default', systemPrompt: null, model: 'grok-4.6' });
  ok('build: cmd is grok', cmd.cmd === 'grok');
  ok('build: streaming-json + always-approve + no-auto-update', ['--output-format', 'streaming-json', '--always-approve', '--no-auto-update'].every((f) => cmd.args.includes(f)));
  ok('build: prompt on argv after -p', cmd.args[cmd.args.indexOf('-p') + 1] === 'hi');
  ok('build: model passed', cmd.args[cmd.args.indexOf('-m') + 1] === 'grok-4.6');
  ok('build: sessionHint minted + matches -s', !!cmd.sessionHint && cmd.args[cmd.args.indexOf('-s') + 1] === cmd.sessionHint);
  ok('build: stdin closed', cmd.stdin === null);
  const resumed = grokAdapter.build({ prompt: 'again', sessionId: 'sess-42', permissionMode: 'default', systemPrompt: null });
  ok('build: resumes given session id', resumed.sessionHint === 'sess-42' && resumed.args.includes('sess-42'));
  const withSys = grokAdapter.build({ prompt: 'go', sessionId: null, permissionMode: 'default', systemPrompt: 'BE BRIEF' });
  ok('build: system prompt prepended', withSys.args[withSys.args.indexOf('-p') + 1].startsWith('BE BRIEF\n\n---\n\n'));
}

// ---- effort (§5.4): ladder exposure + build() flag + clamp ----
{
  const arg = (o: ReturnType<typeof grokAdapter.build>, f: string) => o.args[o.args.indexOf(f) + 1];
  const base = { sessionId: null, permissionMode: 'default' as const, systemPrompt: null };
  ok('effort: grok-4.6 exposes low…xhigh', effortLevelsForModel('grok', 'grok-4.6').map((e) => e.id).join(',') === 'low,medium,high,xhigh');
  ok('effort: grok-build-0.1 hides chip', effortLevelsForModel('grok', 'grok-build-0.1').length === 0);
  const hi = grokAdapter.build({ ...base, prompt: 'x', model: 'grok-4.6', effort: 'high' });
  ok('effort: passed as --effort', arg(hi, '--effort') === 'high');
  const clamp = grokAdapter.build({ ...base, prompt: 'x', model: 'grok-4.6', effort: 'ultracode' });
  ok('effort: ultracode clamps to xhigh', arg(clamp, '--effort') === 'xhigh');
  const nb = grokAdapter.build({ ...base, prompt: 'x', model: 'grok-build-0.1', effort: 'high' });
  ok('effort: no flag for non-reasoning grok-build-0.1', !nb.args.includes('--effort'));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
