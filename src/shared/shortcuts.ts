// One registry for every customisable keyboard shortcut (§9). Before this, the
// same combos lived in the Electron menu accelerators, the App.tsx menu:action
// dispatcher, ~15 inline keydown handlers, and hand-typed command-palette /
// tooltip strings — which drifted (the palette claimed ⌘⇧T for Terminal while
// the menu bound ⌘J). Here the default lives once; the menu, the renderer
// handlers, the palette hints, and the Settings editor all read it.

export type ShortcutId =
  | 'settings'
  | 'new-workspace'
  | 'new-chat'
  | 'reopen-tab'
  | 'close-tab'
  | 'palette'
  | 'focus-composer'
  | 'tab-chat'
  | 'tab-terminal'
  | 'tab-diff'
  | 'tab-editor'
  | 'tab-preview'
  | 'tab-checks'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'create-pr'
  | 'composer.plan-mode'
  | 'preview.annotate'
  | 'editor.save';

export interface ShortcutDef {
  id: ShortcutId;
  label: string; // "Toggle Preview"
  group: 'File' | 'View' | 'Workspace' | 'Composer' | 'Preview' | 'Editor';
  /** Electron accelerator syntax: 'CmdOrCtrl+Shift+B', 'Shift+Tab'. */
  default: string;
  /** Who dispatches it: the application menu, or a renderer keydown handler. */
  where: 'menu' | 'renderer';
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'settings', label: 'Settings', group: 'File', default: 'CmdOrCtrl+,', where: 'menu' },
  { id: 'new-workspace', label: 'New Workspace (Branch)', group: 'File', default: 'CmdOrCtrl+N', where: 'menu' },
  { id: 'new-chat', label: 'New Chat', group: 'File', default: 'CmdOrCtrl+T', where: 'menu' },
  { id: 'reopen-tab', label: 'Reopen Closed Tab', group: 'File', default: 'CmdOrCtrl+Shift+T', where: 'menu' },
  { id: 'close-tab', label: 'Close Tab', group: 'File', default: 'CmdOrCtrl+W', where: 'menu' },
  { id: 'palette', label: 'Command Palette', group: 'View', default: 'CmdOrCtrl+K', where: 'menu' },
  { id: 'focus-composer', label: 'Focus Composer', group: 'View', default: 'CmdOrCtrl+L', where: 'menu' },
  { id: 'tab-chat', label: 'Chat', group: 'View', default: 'CmdOrCtrl+Shift+C', where: 'menu' },
  { id: 'tab-terminal', label: 'Terminal', group: 'View', default: 'CmdOrCtrl+J', where: 'menu' },
  { id: 'tab-diff', label: 'Diff Viewer', group: 'View', default: 'CmdOrCtrl+Shift+D', where: 'menu' },
  { id: 'tab-editor', label: 'Editor', group: 'View', default: 'CmdOrCtrl+Shift+E', where: 'menu' },
  { id: 'tab-preview', label: 'Preview', group: 'View', default: 'CmdOrCtrl+Shift+B', where: 'menu' },
  { id: 'tab-checks', label: 'Checks', group: 'View', default: 'CmdOrCtrl+Shift+K', where: 'menu' },
  { id: 'zoom-in', label: 'Zoom In', group: 'View', default: 'CmdOrCtrl+Plus', where: 'menu' },
  { id: 'zoom-out', label: 'Zoom Out', group: 'View', default: 'CmdOrCtrl+-', where: 'menu' },
  { id: 'zoom-reset', label: 'Actual Size', group: 'View', default: 'CmdOrCtrl+0', where: 'menu' },
  { id: 'create-pr', label: 'Create Pull Request', group: 'Workspace', default: 'CmdOrCtrl+Shift+P', where: 'menu' },
  { id: 'composer.plan-mode', label: 'Toggle Plan Mode', group: 'Composer', default: 'Shift+Tab', where: 'renderer' },
  { id: 'preview.annotate', label: 'Annotate Preview', group: 'Preview', default: 'CmdOrCtrl+Shift+A', where: 'renderer' },
  { id: 'editor.save', label: 'Save File', group: 'Editor', default: 'CmdOrCtrl+S', where: 'renderer' },
];

export type ShortcutOverrides = Partial<Record<ShortcutId, string | null>>; // null = unbound

/** The effective binding for every shortcut: its default, then the user's
 *  override (an explicit `null` unbinds it). */
export function resolveShortcuts(overrides?: ShortcutOverrides): Record<ShortcutId, string | null> {
  const out = {} as Record<ShortcutId, string | null>;
  for (const s of SHORTCUTS) {
    out[s.id] = overrides && Object.prototype.hasOwnProperty.call(overrides, s.id) ? overrides[s.id]! : s.default;
  }
  return out;
}

const isMac = (platform: string) => platform === 'darwin';

interface Parsed {
  meta: boolean; // Cmd (on mac) — CmdOrCtrl resolves per platform
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  cmdOrCtrl: boolean; // the platform-agnostic primary modifier
  key: string; // the non-modifier token, e.g. 'B', 'Tab', '1', 'Plus'
}

function parse(acc: string, platform: string): Parsed | null {
  const p: Parsed = { meta: false, ctrl: false, shift: false, alt: false, cmdOrCtrl: false, key: '' };
  for (const raw of acc.split('+')) {
    const t = raw.trim();
    switch (t.toLowerCase()) {
      case 'cmdorctrl':
      case 'commandorcontrol':
        p.cmdOrCtrl = true;
        break;
      case 'cmd':
      case 'command':
      case 'super':
        p.meta = true;
        break;
      case 'ctrl':
      case 'control':
        p.ctrl = true;
        break;
      case 'shift':
        p.shift = true;
        break;
      case 'alt':
      case 'option':
        p.alt = true;
        break;
      default:
        p.key = t;
    }
  }
  if (!p.key) return null;
  // Fold CmdOrCtrl into the concrete modifier for this platform.
  if (p.cmdOrCtrl) {
    if (isMac(platform)) p.meta = true;
    else p.ctrl = true;
  }
  return p;
}

/** Human-facing key label for one accelerator key token. */
function keyLabel(key: string, mac: boolean): string {
  const map: Record<string, string> = {
    plus: '+',
    escape: mac ? '⎋' : 'Esc',
    esc: mac ? '⎋' : 'Esc',
    enter: mac ? '↵' : 'Enter',
    return: mac ? '↵' : 'Enter',
    tab: mac ? '⇥' : 'Tab',
    space: 'Space',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
  };
  const m = map[key.toLowerCase()];
  if (m) return m;
  return key.length === 1 ? key.toUpperCase() : key;
}

/** 'CmdOrCtrl+Shift+B' → '⌘⇧B' (darwin) / 'Ctrl+Shift+B'. Empty for null. */
export function formatShortcut(acc: string | null, platform: string): string {
  if (!acc) return '';
  const p = parse(acc, platform);
  if (!p) return '';
  const mac = isMac(platform);
  const key = keyLabel(p.key, mac);
  if (mac) {
    let out = '';
    if (p.meta) out += '⌘';
    if (p.ctrl) out += '⌃';
    if (p.alt) out += '⌥';
    if (p.shift) out += '⇧';
    return out + key;
  }
  const parts: string[] = [];
  if (p.ctrl) parts.push('Ctrl');
  if (p.alt) parts.push('Alt');
  if (p.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** Does a keyboard event's key token match this accelerator's key token? */
function keyMatches(token: string, eventKey: string): boolean {
  const t = token.toLowerCase();
  const k = eventKey.toLowerCase();
  if (t === 'plus') return eventKey === '+' || eventKey === '=';
  if (t === 'esc' || t === 'escape') return k === 'escape';
  if (t === 'return' || t === 'enter') return k === 'enter';
  return t === k;
}

/** Does this keydown match the accelerator? Exact modifier match — an extra
 *  modifier is NOT a match. */
export function matchesShortcut(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  acc: string | null,
  platform: string
): boolean {
  if (!acc) return false;
  const p = parse(acc, platform);
  if (!p) return false;
  return (
    e.metaKey === p.meta &&
    e.ctrlKey === p.ctrl &&
    e.shiftKey === p.shift &&
    e.altKey === p.alt &&
    keyMatches(p.key, e.key)
  );
}

/** Event key → accelerator key token (the inverse of keyMatches, for recording). */
function tokenFromKey(key: string): string | null {
  if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt') return null;
  if (key === '+' || key === '=') return 'Plus';
  if (key === ' ') return 'Space';
  if (key === 'Escape') return 'Escape';
  if (key === 'Enter') return 'Enter';
  if (key === 'Tab') return 'Tab';
  if (/^F\d{1,2}$/.test(key)) return key;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Keydown → accelerator string, for the recorder. Null when no non-modifier
 *  key was pressed. */
export function acceleratorFromEvent(e: KeyboardEvent, platform: string): string | null {
  const token = tokenFromKey(e.key);
  if (!token) return null;
  const parts: string[] = [];
  if (isMac(platform) ? e.metaKey : e.ctrlKey) parts.push('CmdOrCtrl');
  else if (e.metaKey) parts.push('Cmd');
  else if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(token);
  return parts.join('+');
}
