import fs from 'fs';
import path from 'path';
import { claudeDir } from '../harness/claude';
import type { HarnessSyncApp } from '../../../shared/types';

// The "don't be a second writer" guard (docs/specs/harness-chat-sync.md §6.6).
// Never resume a session another process has open: Claude publishes a live
// registry under ~/.claude/sessions/<pid>.json; Codex has none, so liveness is
// structural (an open turn on a recently-touched rollout).

export interface LiveElsewhere {
  app: HarnessSyncApp;
  pid?: number;
}

// The registry listing is re-read at most once a second — a send / watcher tick
// can ask freely.
let regCache: { at: number; entries: any[] } | null = null;

function readRegistry(): any[] {
  if (regCache && Date.now() - regCache.at < 1000) return regCache.entries;
  const dir = path.join(claudeDir(), 'sessions');
  const entries: any[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        entries.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch {}
    }
  } catch {}
  regCache = { at: Date.now(), entries };
  return entries;
}

/** A live interactive `claude` process holding this session, or null. A Maestro
 *  `-p` child (`entrypoint:'sdk-cli'`) is not "elsewhere"; a stale registry file
 *  whose pid is dead is ignored. */
export function claudeLiveElsewhere(sessionId: string): LiveElsewhere | null {
  for (const e of readRegistry()) {
    if (e?.sessionId !== sessionId) continue;
    if (e.entrypoint === 'sdk-cli') continue; // Maestro's own child
    const pid = typeof e.pid === 'number' ? e.pid : null;
    if (pid !== null) {
      try {
        process.kill(pid, 0);
        return { app: 'claude-code', pid };
      } catch {
        continue; // process gone — stale file
      }
    }
    return { app: 'claude-code' };
  }
  return null;
}

/**
 * Whether `sessionId`'s transcript is open in another process. Claude is
 * definitive (registry); Codex is structural — the caller passes whether the
 * tail has an unclosed turn, and a rollout touched in the last 5 minutes with an
 * open turn is treated as live.
 */
export function liveElsewhere(
  app: HarnessSyncApp,
  sessionId: string,
  file: string,
  opts?: { openTurn?: boolean }
): LiveElsewhere | null {
  if (app === 'claude-code') return claudeLiveElsewhere(sessionId);
  if (opts?.openTurn) {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < 5 * 60_000) return { app: 'codex' };
    } catch {}
  }
  return null;
}
