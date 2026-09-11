/**
 * Keybindings registry unit test (§9). Pure functions, no electron/db — run under
 * plain node via `npm run test:shortcuts`.
 */
import {
  acceleratorFromEvent,
  formatShortcut,
  matchesShortcut,
  resolveShortcuts,
  SHORTCUTS,
} from '../src/shared/shortcuts';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

// ---------- formatShortcut ----------
ok('format ⌘⇧B on mac', formatShortcut('CmdOrCtrl+Shift+B', 'darwin') === '⌘⇧B', formatShortcut('CmdOrCtrl+Shift+B', 'darwin'));
ok('format Ctrl+Shift+B on win', formatShortcut('CmdOrCtrl+Shift+B', 'win32') === 'Ctrl+Shift+B', formatShortcut('CmdOrCtrl+Shift+B', 'win32'));
ok('format ⌘S on mac', formatShortcut('CmdOrCtrl+S', 'darwin') === '⌘S', formatShortcut('CmdOrCtrl+S', 'darwin'));
ok('format Shift+Tab on mac', formatShortcut('Shift+Tab', 'darwin') === '⇧⇥', formatShortcut('Shift+Tab', 'darwin'));
ok('format Shift+Tab on win', formatShortcut('Shift+Tab', 'win32') === 'Shift+Tab', formatShortcut('Shift+Tab', 'win32'));
ok('format Plus on win', formatShortcut('CmdOrCtrl+Plus', 'win32') === 'Ctrl++', formatShortcut('CmdOrCtrl+Plus', 'win32'));
ok('format null → empty', formatShortcut(null, 'darwin') === '');

// ---------- matchesShortcut ----------
const ev = (o: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({
  key: o.key ?? '',
  metaKey: !!o.metaKey,
  ctrlKey: !!o.ctrlKey,
  shiftKey: !!o.shiftKey,
  altKey: !!o.altKey,
});
ok('⌘⇧B matches on mac', matchesShortcut(ev({ key: 'b', metaKey: true, shiftKey: true }), 'CmdOrCtrl+Shift+B', 'darwin'));
ok('⌘⇧B rejects ctrl on mac', !matchesShortcut(ev({ key: 'b', ctrlKey: true, shiftKey: true }), 'CmdOrCtrl+Shift+B', 'darwin'));
ok('Ctrl+Shift+B matches on win', matchesShortcut(ev({ key: 'b', ctrlKey: true, shiftKey: true }), 'CmdOrCtrl+Shift+B', 'win32'));
ok('Shift+Tab matches', matchesShortcut(ev({ key: 'Tab', shiftKey: true }), 'Shift+Tab', 'darwin'));
ok('⌘S matches (no shift/alt)', matchesShortcut(ev({ key: 's', metaKey: true }), 'CmdOrCtrl+S', 'darwin'));
ok('extra modifier is NOT a match', !matchesShortcut(ev({ key: 's', metaKey: true, altKey: true }), 'CmdOrCtrl+S', 'darwin'));
ok('wrong key is NOT a match', !matchesShortcut(ev({ key: 'x', metaKey: true }), 'CmdOrCtrl+S', 'darwin'));
ok('null accelerator never matches', !matchesShortcut(ev({ key: 's', metaKey: true }), null, 'darwin'));

// ---------- acceleratorFromEvent (round-trip) ----------
const evt = (o: any): KeyboardEvent => o as KeyboardEvent;
ok(
  'record ⌘⇧B on mac → CmdOrCtrl+Shift+B',
  acceleratorFromEvent(evt({ key: 'b', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }), 'darwin') === 'CmdOrCtrl+Shift+B'
);
ok(
  'record Shift+Tab',
  acceleratorFromEvent(evt({ key: 'Tab', shiftKey: true, metaKey: false, ctrlKey: false, altKey: false }), 'darwin') === 'Shift+Tab'
);
ok(
  'record on a modifier-only press → null',
  acceleratorFromEvent(evt({ key: 'Shift', shiftKey: true, metaKey: false, ctrlKey: false, altKey: false }), 'darwin') === null
);
// A recorded accelerator matches the event that produced it (round-trip).
{
  const e = { key: 'k', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
  const acc = acceleratorFromEvent(evt(e), 'darwin');
  ok('round-trip: recorded acc matches its event', !!acc && matchesShortcut(e, acc, 'darwin'), acc ?? 'null');
}

// ---------- resolveShortcuts ----------
{
  const r = resolveShortcuts();
  ok('defaults resolve for every id', SHORTCUTS.every((s) => r[s.id] === s.default));
  const over = resolveShortcuts({ 'tab-preview': 'CmdOrCtrl+Shift+V', 'editor.save': null });
  ok('override applies', over['tab-preview'] === 'CmdOrCtrl+Shift+V');
  ok('null override unbinds', over['editor.save'] === null);
  ok('untouched ids keep defaults', over['tab-chat'] === 'CmdOrCtrl+Shift+C');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
