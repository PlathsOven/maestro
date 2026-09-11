import { useMemo } from 'react';
import { useApp } from '../store/app';
import { resolveShortcuts, type ShortcutId } from '../../shared/shortcuts';

/** The effective keybindings map (defaults + the user's overrides), memoised.
 *  The single source every renderer keydown handler, palette hint, and tooltip
 *  reads (§9), so nothing drifts from the menu. */
export function useShortcuts(): Record<ShortcutId, string | null> {
  const overrides = useApp((s) => s.settings.shortcuts);
  return useMemo(() => resolveShortcuts(overrides), [overrides]);
}
