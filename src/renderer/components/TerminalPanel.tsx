import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Clipboard, Copy } from 'lucide-react';
import { invoke, on } from '../lib/api';
import { useDismiss } from './common';
import { MenuItem } from './Sidebar';

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function terminalTheme() {
  const dark = document.documentElement.classList.contains('dark');
  return {
    background: cssVar('--term-bg') || (dark ? '#201f1e' : '#ffffff'),
    foreground: cssVar('--text'),
    cursor: cssVar('--accent'),
    cursorAccent: cssVar('--term-bg'),
    selectionBackground: dark ? 'rgba(130,113,232,0.30)' : 'rgba(83,68,176,0.25)',
    black: dark ? '#3a3835' : '#5a5753',
    red: '#e06a5e',
    green: '#5fb885',
    yellow: '#e0a33a',
    blue: '#6ba1e0',
    magenta: '#b088d6',
    cyan: '#5eb8b0',
    white: dark ? '#eae8e6' : '#1a1918',
    brightBlack: '#8a867f',
    brightRed: '#e88a80',
    brightGreen: '#7fcca0',
    brightYellow: '#eab866',
    brightBlue: '#8fb8ea',
    brightMagenta: '#c4a4e0',
    brightCyan: '#83ccc5',
    brightWhite: dark ? '#ffffff' : '#000000',
  };
}

function copyText(text: string) {
  if (text) void navigator.clipboard?.writeText(text).catch(() => {});
}

export interface PtyViewProps {
  workspaceId: string;
  ptyId: string;
  /** true: spawn/attach an interactive shell; false: attach-only (script output) */
  ensure: boolean;
  active: boolean;
  /** treat an attach-only pty as a live terminal (blinking cursor, focus on
   *  reveal) — used by run scripts, whose pty main spawns but the user drives */
  interactive?: boolean;
  emptyHint?: string;
}

/** xterm view bound to a main-process pty — interactive terminal or script output. */
export default function PtyView({ workspaceId, ptyId, ensure, active, interactive = false, emptyHint }: PtyViewProps) {
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
      copyText(term.getSelection());
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

    const observer = new MutationObserver(() => term.options && (term.options.theme = terminalTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      disposed = true;
      offData();
      offExit();
      onInput.dispose();
      el.removeEventListener('contextmenu', onContextMenu);
      ro.disconnect();
      observer.disconnect();
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
            if (ensure || interactive) t.focus();
          }
        } catch {}
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: Math.min(x, window.innerWidth - 168),
        top: Math.min(y, window.innerHeight - 88),
        zIndex: 60,
      }}
      className="glass w-40 overflow-hidden py-1"
    >
      {selection && (
        <MenuItem
          onClick={() => {
            onClose();
            copyText(selection);
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
    </div>
  );
}
