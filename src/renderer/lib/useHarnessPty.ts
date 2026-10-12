import { useCallback, useEffect, useState, type DependencyList } from 'react';
import { invoke, on, tryInvoke } from './api';
import type { HarnessId, IpcInvokeMap } from '../../shared/types';

const CHANNELS = {
  login: { start: 'harness:loginStart', stop: 'harness:loginStop' },
  install: { start: 'harness:installStart', stop: 'harness:installStop' },
} as const;

type Kind = keyof typeof CHANNELS;
type Start<K extends Kind> = IpcInvokeMap[(typeof CHANNELS)[K]['start']];

/**
 * The embedded terminal behind a harness sign-in or install — the CLI's own
 * interactive flow, run in a pty that main owns and this component shows.
 *
 * - `start(extra)` runs `harness:<kind>Start` with `{ harness, ...extra }` and,
 *   on success, holds the returned pty id. The result comes back so the caller
 *   surfaces the error its own way (and reads the installer's `cmd`).
 * - `stop()` ends the pty and forgets its id; `clear()` only forgets it (for a
 *   pty that already exited).
 * - The pty is stopped on unmount or when `harness` changes — leaving the view
 *   must never orphan a login or installer.
 * - `onExit` fires when that pty exits (browser flow returned, the user quit,
 *   the installer finished). It's bound like a hand-written effect: re-bound
 *   only when the pty id or `exitDeps` change, so the handler that fires is the
 *   one from that render.
 */
export function useHarnessPty<K extends Kind>(
  kind: K,
  harness: HarnessId,
  onExit: () => void,
  exitDeps: DependencyList
) {
  const [ptyId, setPtyId] = useState<string | null>(null);
  const { start: startChannel, stop: stopChannel } = CHANNELS[kind];

  useEffect(() => () => void invoke(stopChannel, { harness }), [harness]);

  useEffect(() => {
    if (!ptyId) return;
    return on('pty:exit', ({ id }) => {
      if (id === ptyId) onExit();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId, ...exitDeps]);

  const start = useCallback(
    async (extra?: Omit<Start<K>[0], 'harness'>) => {
      const res = (await tryInvoke(startChannel, { harness, ...extra })) as { data?: Start<K>[1]; error?: string };
      if (!res.error && res.data) setPtyId(res.data.ptyId);
      return res;
    },
    [startChannel, harness]
  );

  const stop = useCallback(async () => {
    await invoke(stopChannel, { harness });
    setPtyId(null);
  }, [stopChannel, harness]);

  const clear = useCallback(() => setPtyId(null), []);

  return { ptyId, start, stop, clear };
}
