import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { broadcast } from '../bus';
import { Settings } from '../db';
import { run } from '../exec';
import type { EditorInfo } from '../../shared/types';

/** Editors "Open in" knows how to find. The id doubles as the CLI name, so the
 *  `ideCommand` setting ("code" by default) stays valid as an editor id. */
const EDITORS: { id: string; label: string; apps: string[] }[] = [
  { id: 'cursor', label: 'Cursor', apps: ['Cursor'] },
  { id: 'code', label: 'VS Code', apps: ['Visual Studio Code'] },
  { id: 'windsurf', label: 'Windsurf', apps: ['Windsurf'] },
  { id: 'zed', label: 'Zed', apps: ['Zed'] },
  { id: 'codium', label: 'VSCodium', apps: ['VSCodium'] },
  { id: 'subl', label: 'Sublime Text', apps: ['Sublime Text'] },
  { id: 'idea', label: 'IntelliJ IDEA', apps: ['IntelliJ IDEA', 'IntelliJ IDEA CE'] },
  { id: 'webstorm', label: 'WebStorm', apps: ['WebStorm'] },
  { id: 'pycharm', label: 'PyCharm', apps: ['PyCharm', 'PyCharm CE'] },
  { id: 'xed', label: 'Xcode', apps: ['Xcode'] },
];

let cache: { at: number; list: (EditorInfo & { appPath: string | null })[] } | null = null;

/** Installed editors: a macOS .app bundle, else the CLI on PATH. Cached for a
 *  minute — cheap enough to re-probe, rare enough to change. */
async function detect() {
  if (cache && Date.now() - cache.at < 60_000) return cache.list;
  const which = process.platform === 'win32' ? 'where' : 'which';
  const found = await Promise.all(
    EDITORS.map(async (e) => {
      if (process.platform === 'darwin') {
        for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')])
          for (const app of e.apps) {
            const p = path.join(dir, `${app}.app`);
            if (fs.existsSync(p)) return { id: e.id, label: e.label, appPath: p };
          }
        return null;
      }
      return (await run(which, [e.id], { timeout: 5_000 })).ok ? { id: e.id, label: e.label, appPath: null } : null;
    })
  );
  cache = { at: Date.now(), list: found.filter((e) => e !== null) };
  return cache.list;
}

export async function listEditors(): Promise<EditorInfo[]> {
  return (await detect()).map(({ id, label }) => ({ id, label }));
}

/**
 * Open a path (worktree or file) in an editor: the one picked (remembered as the
 * new default), else the `ideCommand` setting — a known editor id or any custom
 * command. macOS opens the .app directly, so no shell CLI install is needed.
 */
export async function openInEditor(target: string, pick?: string): Promise<void> {
  if (pick && pick !== Settings.global().ideCommand) broadcast('settings:updated', Settings.setGlobal({ ideCommand: pick }));
  const cmd = pick ?? (Settings.global().ideCommand.trim() || 'code');
  const app = (await detect()).find((e) => e.id === cmd)?.appPath;
  const r = app ? await run('open', ['-a', app, target], { timeout: 15_000 }) : await run(cmd, [target], { timeout: 15_000 });
  if (!r.ok) throw new Error(`Could not open in "${cmd}": ${r.stderr.trim() || 'command failed'}`);
}
