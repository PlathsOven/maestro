// The "Open in" editor list: the editors main detected on this machine, default
// (the `ideCommand` setting) first. Fetched once per window — installs are rare.
import { useEffect, useState } from 'react';
import type { EditorInfo } from '../../shared/types';
import { tryInvoke } from './api';
import { useApp } from '../store/app';

let detected: Promise<EditorInfo[]> | null = null;

export function useEditors(): { editors: EditorInfo[]; current: EditorInfo } {
  const [list, setList] = useState<EditorInfo[]>([]);
  const ide = useApp((s) => s.settings.ideCommand.trim() || 'code');
  useEffect(() => {
    detected ??= tryInvoke('ide:list').then((r) => r.data ?? []);
    let alive = true;
    void detected.then((l) => alive && setList(l));
    return () => {
      alive = false;
    };
  }, []);
  // A custom command (not a detected editor) still gets a row of its own.
  const current = list.find((e) => e.id === ide) ?? { id: ide, label: list.length ? ide : 'IDE' };
  return { editors: [current, ...list.filter((e) => e.id !== current.id)], current };
}
