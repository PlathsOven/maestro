import type { IpcEventMap, IpcInvokeMap } from '../../shared/types';

declare global {
  interface Window {
    maestro: {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>;
      on: (channel: string, callback: (data: unknown) => void) => () => void;
    };
  }
}

export function invoke<K extends keyof IpcInvokeMap>(
  channel: K,
  ...args: IpcInvokeMap[K][0] extends void ? [] : [IpcInvokeMap[K][0]]
): Promise<IpcInvokeMap[K][1]> {
  return window.maestro.invoke(channel, args[0]) as Promise<IpcInvokeMap[K][1]>;
}

export function on<K extends keyof IpcEventMap>(
  channel: K,
  callback: (data: IpcEventMap[K]) => void
): () => void {
  return window.maestro.on(channel, callback as (data: unknown) => void);
}

/** invoke() that surfaces errors as toast-friendly strings instead of throwing. */
export async function tryInvoke<K extends keyof IpcInvokeMap>(
  channel: K,
  ...args: IpcInvokeMap[K][0] extends void ? [] : [IpcInvokeMap[K][0]]
): Promise<{ data?: IpcInvokeMap[K][1]; error?: string }> {
  try {
    const data = await (window.maestro.invoke(channel, args[0]) as Promise<IpcInvokeMap[K][1]>);
    return { data };
  } catch (e: any) {
    const msg = String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return { error: msg };
  }
}
