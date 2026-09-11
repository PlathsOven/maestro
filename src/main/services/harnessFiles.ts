import fs from 'fs';
import path from 'path';
import { Workspaces } from '../db';

// Shared filesystem helpers for the two features that read the harnesses' on-disk
// transcript trees read-only: the Conductor importer (conductorImport.ts) and the
// harness chat sync engine (harnessSync/*). Extracted here so both use the exact
// same path munging, canonicalization, title rules, and Codex rollout walk
// (docs/specs/harness-chat-sync.md §6.10). Behavior is unchanged from the copies
// that used to live in conductorImport.ts.

/** Claude Code stores a worktree's transcripts under a munged copy of its cwd:
 *  every non `[A-Za-z0-9-]` char becomes '-' (verified against a real install).
 *  Lossy — never un-munge; read `cwd` from a transcript's first content line. */
export function mungePath(p: string): string {
  return p.replace(/[^A-Za-z0-9-]/g, '-');
}

/** Canonicalize a path for cross-source comparison. `git worktree list` emits
 *  symlink-resolved paths (e.g. /var → /private/var on macOS), so a DB-stored
 *  path and our candidates must resolve symlinks too, or a live worktree looks
 *  unregistered and gets dropped. Falls back to a plain resolve for paths that
 *  don't exist. */
export function normPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    const r = path.resolve(p);
    return r.length > 1 && r.endsWith(path.sep) ? r.slice(0, -1) : r;
  }
}

/** Apply the chat-title rules to a raw prompt: reject the injected preambles
 *  (Conductor/Maestro system instructions, resume caveats), collapse whitespace,
 *  cap at 60 chars. Returns null for a preamble/empty line so the caller can try
 *  the next prompt. */
export function promptTitle(text: string): string | null {
  const t = text.trim();
  if (!t || /^<(system_instruction|maestro|system-reminder)/i.test(t) || /^Caveat:/i.test(t)) return null;
  return t.replace(/\s+/g, ' ').slice(0, 60);
}

/** First real user prompt from a Claude transcript file, for a title. Bounded
 *  read; skips the injected preambles and tool-result turns so the title is the
 *  user's actual first ask. */
export function firstPromptTitleFromFile(file: string): string | null {
  let raw: string;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    raw = buf.slice(0, n).toString('utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // a truncated final line (buffer cut) — ignore
    }
    if (j?.type !== 'user') continue;
    const c = j.message?.content;
    const text =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c
              .filter((b: any) => b?.type === 'text')
              .map((b: any) => b.text)
              .join(' ')
          : '';
    const title = promptTitle(text);
    if (title) return title;
  }
  return null;
}

/** Codex names its rollouts `rollout-<ts>-<sessionId>.jsonl`, bucketed by date.
 *  Bounded walk of a sessions root for a file ending in the session id; returns
 *  its absolute path or null. */
export function findCodexRollout(sessionsRoot: string, sessionId: string): string | null {
  const suffix = `-${sessionId}.jsonl`;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 4) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
      } else if (e.name.startsWith('rollout-') && e.name.endsWith(suffix)) {
        return full;
      }
    }
    return null;
  };
  return walk(sessionsRoot, 0);
}

/** Highest agentId already used in a workspace (chats or sessions), so imported
 *  chats never collide with existing ones (idempotent re-import). */
export function maxAgentId(workspaceId: string): number {
  const ids = [
    ...Object.keys(Workspaces.getChats(workspaceId)),
    ...Object.keys(Workspaces.getSessions(workspaceId)),
  ].map(Number);
  return Math.max(0, ...ids.filter((n) => Number.isFinite(n)));
}
