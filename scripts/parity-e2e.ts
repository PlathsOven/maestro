/**
 * Parity guard for the one-parse-implementation invariant (mobile-web-app spec
 * §10, G7). Golden NDJSON fixtures per harness are run through TWO code paths
 * that must agree byte-for-byte:
 *
 *   A) the desktop pipeline — parse each line, apply block events incrementally
 *      (`applyBlockEvent`), capture session/context/done exactly as
 *      `harness/index` does, finalize.
 *   B) the relay pipeline — `accumulate(state, events)` with the JSON-serializable
 *      `TurnState` round-tripped through JSON.stringify/parse **after every single
 *      event**, exactly as the relay does when it persists parse state between
 *      HTTP chunks and resumes mid-turn (§6.4).
 *
 * If the extraction refactor ever drifts, or `TurnState` stops surviving a JSON
 * round-trip, this fails in CI. Bundled with esbuild and run under plain node:
 *
 *   npx esbuild scripts/parity-e2e.ts --bundle --platform=node --format=cjs \
 *     --outfile=dist/parity-e2e.cjs && node dist/parity-e2e.cjs
 *
 * The fixtures live in scripts/fixtures/parity/<harness>.jsonl — extend them
 * from real CLI captures as harnesses evolve.
 */
import fs from 'fs';
import path from 'path';
import {
  PARSERS,
  newBlockStream,
  applyBlockEvent,
  finalizeBlocks,
  newTurnState,
  accumulate,
  finalizeMeta,
  type TurnState,
} from '../src/shared/harness';
import type { AgentBlock, AgentEvent, ContextUsage, HarnessId } from '../src/shared/types';

// Resolved from the repo root (the bundle runs from dist/, so __dirname is wrong).
const FIX = path.join(process.cwd(), 'scripts', 'fixtures', 'parity');

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

interface Outcome {
  blocks: AgentBlock[];
  sessionId?: string;
  contextTokens?: number;
  usage?: ContextUsage;
  meta: ReturnType<typeof finalizeMeta>;
}

/** Path A: the desktop's incremental pipeline (harness/index applyEvent + finalize). */
function desktopPath(harness: HarnessId, lines: string[], exit: number): Outcome {
  const parse = PARSERS[harness];
  const s = newBlockStream();
  let sessionId: string | undefined;
  let contextTokens: number | undefined;
  let usage: ContextUsage | undefined;
  let done: Extract<AgentEvent, { kind: 'done' }> | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    for (const ev of parse(line)) {
      if (ev.kind === 'session') sessionId = ev.sessionId;
      else if (ev.kind === 'context') {
        contextTokens = ev.contextTokens;
        usage = ev.usage;
      } else if (ev.kind === 'done') {
        done = ev;
        if (ev.contextTokens != null) {
          contextTokens = ev.contextTokens;
          usage = ev.usage;
        }
      } else if (ev.kind !== 'task' && ev.kind !== 'status') {
        applyBlockEvent(s, ev);
      }
    }
  }
  const blocks = finalizeBlocks(s);
  const stateForMeta: TurnState = {
    ...newBlockStream(),
    done: done && {
      ok: done.ok,
      error: done.error,
      costUsd: done.costUsd,
      durationMs: done.durationMs,
      needsAttention: done.needsAttention,
    },
  };
  return { blocks, sessionId, contextTokens, usage, meta: finalizeMeta(stateForMeta, exit) };
}

/** Path B: the relay's resumable pipeline — JSON round-trip after every event. */
function relayPath(harness: HarnessId, lines: string[], exit: number): Outcome {
  const parse = PARSERS[harness];
  let state = newTurnState();
  for (const line of lines) {
    if (!line.trim()) continue;
    for (const ev of parse(line)) {
      accumulate(state, [ev]);
      // Persist + resume between every event, exactly like the stateless relay.
      state = JSON.parse(JSON.stringify(state)) as TurnState;
    }
  }
  const blocks = finalizeBlocks(state);
  return {
    blocks,
    sessionId: state.sessionId,
    contextTokens: state.contextTokens,
    usage: state.usage,
    meta: finalizeMeta(state, exit),
  };
}

function main() {
  const harnesses = fs
    .readdirSync(FIX)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, '') as HarnessId);

  check('fixtures present', harnesses.length >= 4, harnesses.join(', '));

  for (const harness of harnesses) {
    const lines = fs.readFileSync(path.join(FIX, `${harness}.jsonl`), 'utf8').split('\n');
    const exit = 0;
    const a = desktopPath(harness, lines, exit);
    const b = relayPath(harness, lines, exit);

    const blocksMatch = JSON.stringify(a.blocks) === JSON.stringify(b.blocks);
    check(
      `${harness}: AgentBlock[] byte-identical (desktop vs relay)`,
      blocksMatch,
      blocksMatch ? `${a.blocks.length} blocks` : `\n  A=${JSON.stringify(a.blocks)}\n  B=${JSON.stringify(b.blocks)}`
    );
    check(`${harness}: session id agrees`, a.sessionId === b.sessionId, `${a.sessionId} vs ${b.sessionId}`);
    check(
      `${harness}: context tokens agree`,
      a.contextTokens === b.contextTokens,
      `${a.contextTokens} vs ${b.contextTokens}`
    );
    check(
      `${harness}: finalized meta byte-identical`,
      JSON.stringify(a.meta) === JSON.stringify(b.meta),
      `${JSON.stringify(a.meta)} vs ${JSON.stringify(b.meta)}`
    );
    // Every turn must produce at least one block (the fixtures all have output).
    check(`${harness}: produced blocks`, a.blocks.length > 0, `${a.blocks.length}`);
  }

  // Interrupted-turn meta: a non-zero exit with no parsed done → error + attention.
  const interrupted = finalizeMeta(newTurnState(), 137);
  check(
    'interrupted turn (exit≠0, no done) → error/attention',
    interrupted.status === 'error' && interrupted.needsAttention === true,
    JSON.stringify(interrupted)
  );

  console.log(failures ? `\n${failures} PARITY FAILURE(S)` : '\nALL PARITY CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main();
