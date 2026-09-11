import fs from 'fs';
import os from 'os';
import path from 'path';
import type { HarnessId, SkillEntry, SkillLocation, Workspace } from '../../shared/types';

/**
 * Skills: reusable instruction files the harness CLI discovers on disk and the
 * user invokes as /name. Maestro never interprets a skill itself — it only
 * finds, shows, and writes the files; the CLI picks them up on its next run
 * (every turn spawns a fresh process, so a just-saved skill works immediately).
 *
 * Layouts differ per harness:
 *  - 'dir'  → <root>/<name>/SKILL.md   (Claude Code skills)
 *  - 'file' → <root>/<name>.md         (Codex prompts, opencode/cursor commands)
 */
interface SkillDirs {
  user: string | null;
  project: string | null;
  layout: 'dir' | 'file';
  /** claude-code only: also surface installed plugins' skills (read-only) */
  plugins: boolean;
}

function skillDirs(harness: HarnessId, worktreePath: string): SkillDirs | null {
  const home = os.homedir();
  switch (harness) {
    case 'claude-code':
      return {
        user: path.join(home, '.claude', 'skills'),
        project: path.join(worktreePath, '.claude', 'skills'),
        layout: 'dir',
        plugins: true,
      };
    case 'codex':
      // Codex custom prompts are global-only ($CODEX_HOME/prompts).
      return { user: path.join(home, '.codex', 'prompts'), project: null, layout: 'file', plugins: false };
    case 'opencode':
      return {
        user: path.join(home, '.config', 'opencode', 'command'),
        project: path.join(worktreePath, '.opencode', 'command'),
        layout: 'file',
        plugins: false,
      };
    case 'cursor':
      return {
        user: path.join(home, '.cursor', 'commands'),
        project: path.join(worktreePath, '.cursor', 'commands'),
        layout: 'file',
        plugins: false,
      };
    case 'kimi-code':
      // Kimi Code Agent Skills mirror Claude's layout: <root>/<name>/SKILL.md.
      return {
        user: path.join(home, '.kimi-code', 'skills'),
        project: path.join(worktreePath, '.kimi-code', 'skills'),
        layout: 'dir',
        plugins: false,
      };
    case 'grok':
      // Grok Build has a skills/plugins system; the on-disk layout is [verify]
      // (spec §7). Best-guess it mirrors Claude/Kimi: <root>/<name>/SKILL.md under
      // ~/.grok/skills (user) and <worktree>/.grok/skills (project).
      return {
        user: path.join(home, '.grok', 'skills'),
        project: path.join(worktreePath, '.grok', 'skills'),
        layout: 'dir',
        plugins: false,
      };
    default:
      return null; // shell: no skills notion
  }
}

/** `p` is `root` itself or inside it (after resolving; no symlink chasing). */
function within(root: string, p: string): boolean {
  const r = path.resolve(root);
  const abs = path.resolve(p);
  return abs === r || abs.startsWith(r + path.sep);
}

// ---------- markdown parsing ----------

/**
 * Minimal frontmatter reader: top-level `key: value` lines between leading
 * `---` fences, including block scalars (`description: >` / `|`) whose
 * indented lines are joined — enough for the name/description skills use.
 */
function parseFrontmatter(md: string): { fields: Record<string, string>; body: string } {
  const m = md.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!m) return { fields: {}, body: md };
  const fields: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/); // anchored: nested keys don't match
    if (!kv) continue;
    let val = kv[2].trim();
    if (/^[>|][+-]?$/.test(val)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^[ \t]/.test(lines[i + 1]))) {
        block.push(lines[++i].trim());
      }
      val = block.filter(Boolean).join(' ');
    }
    fields[kv[1].toLowerCase()] = val.replace(/^["']|["']$/g, '');
  }
  return { fields, body: md.slice(m[0].length) };
}

/** First prose line of the body — description fallback for bare files. */
function firstBodyLine(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !/^#{1,6}\s/.test(line) && line !== '---') return line.slice(0, 200);
  }
  return '';
}

function skillMeta(markdown: string): { name?: string; description: string } {
  const { fields, body } = parseFrontmatter(markdown);
  return { name: fields.name, description: (fields.description || firstBodyLine(body)).slice(0, 500) };
}

/** Skill names become directory/file names — keep them path-safe. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
function validName(name: string | undefined): name is string {
  return !!name && NAME_RE.test(name) && !name.includes('..');
}

// ---------- discovery ----------

function readSkillFile(file: string, name: string, source: SkillEntry['source'], plugin?: string): SkillEntry | null {
  let md: string;
  try {
    md = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const meta = skillMeta(md);
  return { name: plugin ? `${plugin}:${name}` : name, description: meta.description, source, path: file, plugin };
}

/** List one root's skills per the layout; missing/unreadable dirs are just empty. */
function scanRoot(root: string | null, layout: 'dir' | 'file', source: SkillEntry['source'], plugin?: string): SkillEntry[] {
  if (!root) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const e of entries.slice(0, 500)) {
    if (e.name.startsWith('.')) continue;
    if (layout === 'dir') {
      if (!e.isDirectory()) continue;
      const s = readSkillFile(path.join(root, e.name, 'SKILL.md'), e.name, source, plugin);
      if (s) out.push(s);
    } else {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const s = readSkillFile(path.join(root, e.name), e.name.replace(/\.md$/, ''), source, plugin);
      if (s) out.push(s);
    }
  }
  return out;
}

const claudePluginsRoot = () => path.join(os.homedir(), '.claude', 'plugins');

/**
 * Skills shipped by installed Claude Code plugins, shown as plugin:skill (the
 * CLI's invocation syntax). installed_plugins.json maps each plugin to its
 * current install path; anything unreadable is silently skipped.
 */
function scanClaudePluginSkills(): SkillEntry[] {
  let installed: any;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(claudePluginsRoot(), 'installed_plugins.json'), 'utf8'));
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const [key, installs] of Object.entries(installed?.plugins ?? {})) {
    const plugin = key.split('@')[0];
    const installPath = Array.isArray(installs) ? (installs[0] as any)?.installPath : undefined;
    if (!plugin || typeof installPath !== 'string') continue;
    out.push(...scanRoot(path.join(installPath, 'skills'), 'dir', 'plugin', plugin));
  }
  return out;
}

const SOURCE_ORDER: Record<SkillEntry['source'], number> = { project: 0, user: 1, plugin: 2 };

export function listSkills(ws: Workspace): SkillEntry[] {
  const dirs = skillDirs(ws.harness, ws.worktreePath);
  if (!dirs) return [];
  const all = [
    ...scanRoot(dirs.project, dirs.layout, 'project'),
    ...scanRoot(dirs.user, dirs.layout, 'user'),
    ...(dirs.plugins ? scanClaudePluginSkills() : []),
  ];
  // Same name in several places → the CLI resolution order wins (project > user).
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const s of all) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out.sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.name.localeCompare(b.name));
}

// ---------- read / write / delete ----------

/** Roots `p` may live in. Plugin paths are readable but never writable. */
function checkPath(ws: Workspace, p: string, opts: { write: boolean }): void {
  const dirs = skillDirs(ws.harness, ws.worktreePath);
  const roots = [dirs?.user, dirs?.project].filter((r): r is string => !!r);
  if (!opts.write && dirs?.plugins) roots.push(claudePluginsRoot());
  if (!roots.some((r) => within(r, p))) throw new Error('Path is outside the skill folders');
}

export function readSkill(ws: Workspace, p: string): { markdown: string } {
  checkPath(ws, p, { write: false });
  return { markdown: fs.readFileSync(p, 'utf8') };
}

export function deleteSkill(ws: Workspace, p: string): void {
  checkPath(ws, p, { write: true });
  const dirs = skillDirs(ws.harness, ws.worktreePath)!;
  // dir layout: the skill IS its folder (SKILL.md + any support files) — remove it whole.
  if (dirs.layout === 'dir' && path.basename(p) === 'SKILL.md') {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  } else {
    fs.rmSync(p, { force: true });
  }
}

/**
 * Create or update a skill from raw markdown. The name comes from the
 * `name:` frontmatter (it's what /-invocation uses, so it must be explicit and
 * path-safe). Renames drop the old file/folder after writing the new one.
 */
export function saveSkill(ws: Workspace, location: SkillLocation, markdown: string, prevPath?: string): SkillEntry {
  const dirs = skillDirs(ws.harness, ws.worktreePath);
  if (!dirs) throw new Error(`The ${ws.harness} harness has no skills folder`);
  const root = location === 'user' ? dirs.user : dirs.project;
  if (!root) throw new Error(`${ws.harness} only supports personal skills`);

  const meta = skillMeta(markdown);
  if (!validName(meta.name)) {
    throw new Error('Add a frontmatter `name:` (letters, digits, dashes) — it becomes the /command');
  }
  const target =
    dirs.layout === 'dir' ? path.join(root, meta.name, 'SKILL.md') : path.join(root, `${meta.name}.md`);
  checkPath(ws, target, { write: true });

  if (prevPath && path.resolve(prevPath) !== path.resolve(target)) {
    // moved (renamed or relocated) — validate before touching, then clean up old
    checkPath(ws, prevPath, { write: true });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, markdown, 'utf8');
  if (prevPath && path.resolve(prevPath) !== path.resolve(target)) deleteSkill(ws, prevPath);

  return {
    name: meta.name,
    description: meta.description,
    source: location,
    path: target,
  };
}
