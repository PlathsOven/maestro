import fs from 'fs';
import path from 'path';
import TOML from '@iarna/toml';
import type { RepoSettings } from '../../shared/types';

// Repo-shareable settings, checked in at .maestro/settings.toml:
//
//   [scripts]
//   setup = "npm install"
//   run = "npm run dev"
//
//   [project]
//   instructions = """Durable guidance for agents working in this repo."""

function settingsPath(repoPath: string): string {
  return path.join(repoPath, '.maestro', 'settings.toml');
}

export function readRepoSettings(repoPath: string): RepoSettings {
  const empty: RepoSettings = { setupScript: '', runScript: '', instructions: '' };
  try {
    const file = settingsPath(repoPath);
    if (!fs.existsSync(file)) return empty;
    const parsed = TOML.parse(fs.readFileSync(file, 'utf8')) as any;
    return {
      setupScript: parsed?.scripts?.setup ?? '',
      runScript: parsed?.scripts?.run ?? '',
      instructions: parsed?.project?.instructions ?? '',
    };
  } catch {
    return empty;
  }
}

export function writeRepoSettings(repoPath: string, settings: RepoSettings) {
  const file = settingsPath(repoPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc: any = {};
  if (settings.setupScript || settings.runScript) {
    doc.scripts = {};
    if (settings.setupScript) doc.scripts.setup = settings.setupScript;
    if (settings.runScript) doc.scripts.run = settings.runScript;
  }
  if (settings.instructions) {
    doc.project = { instructions: settings.instructions };
  }
  fs.writeFileSync(file, TOML.stringify(doc));
}
