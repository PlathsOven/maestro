import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Narrow, typed-on-the-renderer-side bridge. Channels are validated by the
// main process handlers; we only expose invoke/on.
contextBridge.exposeInMainWorld('maestro', {
  invoke: (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload),
  on: (channel: string, callback: (data: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on(channel, listener as never);
    return () => ipcRenderer.removeListener(channel, listener as never);
  },
  // Absolute path of a File dropped in from the OS ('' when it has none).
  pathForFile: (file: File) => webUtils.getPathForFile(file),
});
