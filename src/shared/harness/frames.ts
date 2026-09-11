/**
 * Journal framing — the wire protocol between the box and every viewer
 * (spec mobile-web-app §6.4). A per-chat `journal.jsonl` holds the harness's own
 * NDJSON verbatim, bracketed by one framing line before and after each turn:
 *
 *   {"maestro":"turn-start","turnId":"…","at":…}
 *   …the CLI's NDJSON (or raw text) for this turn…
 *   {"maestro":"turn-end","turnId":"…","exit":0,"at":…}
 *
 * This module is PURE (no node builtins, no main-process imports): the desktop
 * follower (`src/main/hosts/journal.ts` re-exports it) and the relay ingest
 * (`web/lib/ingest.ts`) parse the same bytes with the same code — one wire
 * protocol, one parser (G7).
 */

export interface TurnStartFrame {
  kind: 'turn-start';
  turnId: string;
  /** unix seconds when the box began the turn (0 when the box has no clock). */
  at?: number;
}
export interface TurnEndFrame {
  kind: 'turn-end';
  turnId: string;
  exit: number;
  at?: number;
}
export type JournalFrame = TurnStartFrame | TurnEndFrame;

/** Parse a journal line as a maestro framing line, or null if it's ordinary CLI
 *  output. Framing lines are JSON objects with a `maestro` discriminator. */
export function parseFrame(line: string): JournalFrame | null {
  if (line.indexOf('"maestro"') < 0) return null; // cheap reject before JSON.parse
  try {
    const j = JSON.parse(line);
    if (!j || typeof j !== 'object') return null;
    const at = typeof j.at === 'number' ? j.at : undefined;
    if (j.maestro === 'turn-start' && typeof j.turnId === 'string') return { kind: 'turn-start', turnId: j.turnId, at };
    if (j.maestro === 'turn-end' && typeof j.turnId === 'string')
      return { kind: 'turn-end', turnId: j.turnId, exit: typeof j.exit === 'number' ? j.exit : 0, at };
  } catch {
    // A raw CLI line that merely contains the substring — not a frame.
  }
  return null;
}
