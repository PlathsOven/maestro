import type { BrowserWindow } from 'electron';
import type { IpcEventMap } from '../shared/types';

let win: BrowserWindow | null = null;

export function setWindow(w: BrowserWindow | null) {
  win = w;
}

export function getWindow() {
  return win;
}

// A side-channel tap for main-process listeners (the Maestro Web bridge uses it
// to re-publish a workspace whenever something a Sidebar row / header shows
// changes — web-desktop-parity §9.5.3). Kept out of the import graph: account.ts
// registers the hook at link time, so bus.ts never imports it.
let broadcastHook: ((channel: string, payload: unknown) => void) | null = null;
export function setBroadcastHook(fn: ((channel: string, payload: unknown) => void) | null) {
  broadcastHook = fn;
}

export function broadcast<K extends keyof IpcEventMap>(channel: K, payload: IpcEventMap[K]) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
  try {
    broadcastHook?.(channel as string, payload);
  } catch {
    /* a publish hook must never break the renderer broadcast */
  }
}

// Rebuild the application menu (§9). index.ts owns buildMenu(); ipc.ts calls
// rebuildMenu() when the user changes shortcuts, without importing index.ts (the
// import graph stays acyclic — index → ipc, never the reverse).
let menuRebuild: (() => void) | null = null;
export function setMenuRebuildHook(fn: () => void) {
  menuRebuild = fn;
}
export function rebuildMenu() {
  menuRebuild?.();
}
