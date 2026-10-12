import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Clipboard, Copy } from 'lucide-react';
import { invoke, on } from '../lib/api';
import { useApp } from '../store/app';
import { subscribeTheme } from '../../shared/themes';
import { ContextMenu, MenuItem } from './common';
import { copyText } from '../lib/clipboard';

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The selection fill: Classic keeps its tuned violet; other theme families
 *  tint it with their own accent (a 6-digit hex token + alpha byte). */
function selectionFill(dark: boolean): string {
  const accent = cssVar('--accent');
  if (document.documentElement.dataset.theme === 'classic' || !/^#[0-9a-f]{6}$/i.test(accent))
    return dark ? 'rgba(130,113,232,0.30)' : 'rgba(83,68,176,0.25)';
  return accent + (dark ? '4d' : '40');
}

/** Lighten (amt > 0) or darken a 6-digit hex toward white / black. */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt));
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(ch);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function terminalTheme() {
  const dark = document.documentElement.classList.contains('dark');
  const classic = document.documentElement.dataset.theme === 'classic';
  // Classic keeps its tuned ANSI set; every other family draws the terminal
  // from its own palette (status colours double as the ANSI hues, and
  // `--ansi-cyan` is the one hue a family names just for this), so a Nord or
  // Phosphor terminal doesn't break the spell with Classic's colours.
  const tok = (name: string, fallback: string) => {
    const v = classic ? '' : cssVar(name);
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  };
  const bright = (hex: string) => shade(hex, dark ? 0.22 : -0.14);
  const red = tok('--err', '#e06a5e');
  const green = tok('--ok', '#5fb885');
  const yellow = tok('--warn', '#e0a33a');
  const blue = tok('--st-running', '#6ba1e0');
  const magenta = tok('--st-merged', '#b088d6');
  const cyan = tok('--ansi-cyan', '#5eb8b0');
  const white = tok('--text', dark ? '#eae8e6' : '#1a1918');
  return {
    background: cssVar('--term-bg') || (dark ? '#201f1e' : '#ffffff'),
    foreground: cssVar('--text'),
    cursor: cssVar('--accent'),
    cursorAccent: cssVar('--term-bg'),
    selectionBackground: selectionFill(dark),
    black: tok('--st-idle', dark ? '#3a3835' : '#5a5753'),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack: tok('--faint', '#8a867f'),
    brightRed: classic ? '#e88a80' : bright(red),
    brightGreen: classic ? '#7fcca0' : bright(green),
    brightYellow: classic ? '#eab866' : bright(yellow),
    brightBlue: classic ? '#8fb8ea' : bright(blue),
    brightMagenta: classic ? '#c4a4e0' : bright(magenta),
    brightCyan: classic ? '#83ccc5' : bright(cyan),
    brightWhite: classic ? (dark ? '#ffffff' : '#000000') : bright(white),
  };
}

interface PtyViewProps {
  workspaceId: string;
  ptyId: string;
  /** true: spawn/attach an interactive shell; false: attach-only (script output) */
  ensure: boolean;
  active: boolean;
  /** treat an attach-only pty as a live terminal (blinking cursor, focus on
   *  reveal) — used by run scripts, whose pty main spawns but the user drives */
  interactive?: boolean;
  /** dock terminals: take focus only when the store's `dockFocusRequest` names
   *  this key (the user asked to see it), not on every reveal — the dock mounts
   *  its terminal whenever a workspace is selected, and mustn't pull focus out
   *  of the composer when it does. Unset: focus on every reveal. */
  focusKey?: string;
  emptyHint?: string;
}

/** xterm view bound to a main-process pty — interactive terminal or script output. */
export default function PtyView({ workspaceId, ptyId, ensure, active, interactive = false, focusKey, emptyHint }: PtyViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: ensure || interactive,
      scrollback: 8000,
      theme: terminalTheme(),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Open links in the default browser. WebLinksAddon's default handler calls
    // window.open() with no URL, which our setWindowOpenHandler (main) denies
    // because it isn't http(s) — so links silently never open. Passing the URL
    // to window.open lets that handler route it to shell.openExternal.
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)));
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;

    // Clipboard keys, which only reach us because the Edit menu leaves those
    // accelerators unregistered (main/index).
    //   ⌃C: xterm draws its selection on a canvas, so the browser — and the
    //   menu's Copy role, which is just webContents.copy() — sees nothing to
    //   copy. Copy by hand, but only with a selection, so an empty terminal
    //   still sends its interrupt; clearing after means a second ⌃C interrupts.
    //   ⌃V: xterm would send ^V (readline's quoted-insert) as well as pasting.
    //   Bowing out early skips that without preventing the default, so the
    //   browser's own paste event still reaches xterm's handler — which honours
    //   bracketed-paste mode and needs no clipboard-read permission.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || e.altKey || !(e.ctrlKey || e.metaKey)) return true;
      const key = e.key.toLowerCase();
      if (key === 'v') return false;
      if (key !== 'c' || !term.hasSelection()) return true;
      e.preventDefault();
      void copyText(term.getSelection());
      term.clearSelection();
      return false;
    });

    // Electron ships no default context menu, so right-click gets ours.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, selection: term.getSelection() });
    };
    el.addEventListener('contextmenu', onContextMenu);

    let disposed = false;
    const boot = async () => {
      try {
        fit.fit();
      } catch {}
      if (ensure) {
        const { buffer } = await invoke('pty:ensure', {
          id: ptyId,
          workspaceId,
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) return;
        if (buffer) term.write(buffer);
      } else {
        const { buffer } = await invoke('pty:buffer', { id: ptyId });
        if (disposed) return;
        if (buffer) term.write(buffer);
        else if (emptyHint) term.write(`\x1b[2m${emptyHint}\x1b[0m\r\n`);
      }
    };
    void boot();

    const offData = on('pty:data', ({ id, data }) => {
      if (id === ptyId) term.write(data);
    });
    const offExit = on('pty:exit', ({ id, exitCode }) => {
      if (id !== ptyId) return;
      term.write(
        ensure
          ? '\r\n\x1b[2m[process exited — reopen to restart]\x1b[0m\r\n'
          : `\r\n\x1b[2m[exited with code ${exitCode}]\x1b[0m\r\n`
      );
    });
    const onInput = term.onData((data) => void invoke('pty:write', { id: ptyId, data }));

    const ro = new ResizeObserver(() => {
      if (!el.offsetParent) return; // hidden
      try {
        fit.fit();
        void invoke('pty:resize', { id: ptyId, cols: term.cols, rows: term.rows });
      } catch {}
    });
    ro.observe(el);

    const offTheme = subscribeTheme(() => term.options && (term.options.theme = terminalTheme()));

    return () => {
      disposed = true;
      offData();
      offExit();
      onInput.dispose();
      el.removeEventListener('contextmenu', onContextMenu);
      ro.disconnect();
      offTheme();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          const t = termRef.current;
          if (t) {
            void invoke('pty:resize', { id: ptyId, cols: t.cols, rows: t.rows });
          }
        } catch {}
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Live terminals take the keyboard when revealed — for a dock terminal, only
  // when the user asked for this one (its focus request, consumed here).
  const requested = useApp((s) => focusKey !== undefined && s.dockFocusRequest === focusKey);
  const wantsFocus = active && (focusKey === undefined || requested);
  useEffect(() => {
    if (!wantsFocus) return;
    if (focusKey !== undefined) useApp.getState().consumeDockFocus(focusKey);
    if (ensure || interactive) requestAnimationFrame(() => termRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsFocus]);

  return (
    <div className="h-full" style={{ background: 'var(--term-bg)' }}>
      <div ref={containerRef} className="h-full" />
      {menu && (
        <TerminalMenu
          x={menu.x}
          y={menu.y}
          selection={menu.selection}
          onPaste={(text) => termRef.current?.paste(text)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** Right-click menu for the terminal, since Electron has no default one. */
function TerminalMenu({
  x,
  y,
  selection,
  onPaste,
  onClose,
}: {
  x: number;
  y: number;
  selection: string;
  onPaste: (text: string) => void;
  onClose: () => void;
}) {
  return (
    <ContextMenu x={x} y={y} onClose={onClose} width={160}>
      {selection && (
        <MenuItem
          onClick={() => {
            onClose();
            void copyText(selection);
          }}
        >
          <Copy size={15} className="text-muted" /> Copy
        </MenuItem>
      )}
      <MenuItem
        onClick={() => {
          onClose();
          // The click is the user gesture the async clipboard API wants;
          // execCommand('paste') is blocked in Chromium. paste() routes through
          // term.onData, so bracketed-paste mode is honoured as with ⌃V.
          void navigator.clipboard
            ?.readText()
            .then((text) => text && onPaste(text))
            .catch(() => {});
        }}
      >
        <Clipboard size={15} className="text-muted" /> Paste
      </MenuItem>
    </ContextMenu>
  );
}
