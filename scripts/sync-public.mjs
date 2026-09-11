#!/usr/bin/env node
// Sync the app source to the PUBLIC open-source mirror (PlathsOven/maestro).
//
// Copies the *working tree* of the private repo (visual-conductor) into a
// checkout of the public mirror, applying:
//   • .publicignore   — paths withheld from the mirror (rsync --exclude-from)
//   • SANITIZE (below) — swaps our production analytics key / relay default for
//                        inert placeholders so forks never phone home to us
// then makes a single fresh "Sync vX.Y.Z" commit and (optionally) pushes.
//
// NONE of the private repo's git history is copied — the mirror keeps its own
// clean, forward-only history, so old commit messages never appear publicly.
//
// Runs in two places, both driven purely by env vars:
//   • CI (on the public repo): .github/workflows/sync-public.yml
//   • Bootstrap (local, first push): see docs/OPEN-SOURCE.md
//
// Env:
//   SYNC_SRC     path to the private checkout        (default ".")
//   SYNC_DEST    path to the public-mirror checkout  (required)
//   SYNC_BRANCH  branch to commit/push in the mirror (default "main")
//   SYNC_PUSH    "1" to `git push` after committing  (default: no push)
//   SYNC_MESSAGE override the commit message         (default "Sync vX (sha)")

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.env.SYNC_SRC || '.');
const DEST = process.env.SYNC_DEST ? path.resolve(process.env.SYNC_DEST) : null;
const BRANCH = process.env.SYNC_BRANCH || 'main';
const PUSH = process.env.SYNC_PUSH === '1';

// --- what to scrub from the mirror -------------------------------------------
// The PostHog *project* key is a publishable client key, but we still don't want
// forks reporting into OUR analytics project, so swap it for the repo's own
// "REPLACE" placeholder — every embed gates on `phc_` + !includes('REPLACE'),
// so this leaves analytics inert until a fork fills in its own key. The relay
// default is blanked so a fork's desktop build has no server to talk to until
// its user links one. The private repo is never modified — only the mirror.
const PLACEHOLDER_KEY = 'phc_REPLACE_WITH_YOUR_POSTHOG_PROJECT_KEY';
const SANITIZE = {
  // applied to every text file in the mirror (the key appears in 4 embeds)
  global: [
    { find: 'phc_REPLACE_WITH_YOUR_POSTHOG_PROJECT_KEY', replace: PLACEHOLDER_KEY },
  ],
  // applied to one specific file, exact substring
  files: [
    {
      file: 'src/main/services/account.ts',
      find: "const DEFAULT_RELAY = 'https://app.maestro-build.com';",
      replace: "const DEFAULT_RELAY = '';",
    },
  ],
};

function die(msg) { console.error(`sync-public: ${msg}`); process.exit(1); }
function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...opts });
}

if (!DEST) die('SYNC_DEST is required (path to the public-mirror checkout)');
if (!fs.existsSync(path.join(SRC, '.publicignore'))) die(`no .publicignore in ${SRC}`);
if (!fs.existsSync(path.join(DEST, '.git'))) {
  die(`${DEST} is not a git checkout — clone the empty public repo there first`);
}

// Version + source SHA, only for the commit message.
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
let sha = 'unknown';
try { sha = git(SRC, ['rev-parse', '--short', 'HEAD']).trim(); } catch { /* shallow/no HEAD */ }
const message = process.env.SYNC_MESSAGE || `Sync v${pkg.version} (${sha})`;

// 1) Mirror the tree (minus .publicignore paths + git metadata).
console.log(`sync-public: copying ${SRC} -> ${DEST}`);
execFileSync('rsync', [
  '-a', '--delete',
  `--exclude-from=${path.join(SRC, '.publicignore')}`,
  '--exclude=/.git',
  `${SRC}/`, `${DEST}/`,
], { stdio: 'inherit' });

// 2) Sanitize.
const looksBinary = (buf) => buf.includes(0);
function walk(dir, cb) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, cb);
    else if (ent.isFile()) cb(full);
  }
}
let scrubbed = 0;
walk(DEST, (file) => {
  const buf = fs.readFileSync(file);
  if (looksBinary(buf)) return;
  let text = buf.toString('utf8');
  let changed = false;
  for (const rule of SANITIZE.global) {
    if (text.includes(rule.find)) { text = text.split(rule.find).join(rule.replace); changed = true; }
  }
  if (changed) { fs.writeFileSync(file, text); scrubbed++; }
});
for (const rule of SANITIZE.files) {
  const file = path.join(DEST, rule.file);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(rule.find)) {
    fs.writeFileSync(file, text.split(rule.find).join(rule.replace));
    scrubbed++;
  }
}
console.log(`sync-public: sanitized ${scrubbed} file(s)`);

// Belt-and-braces: never let the real production key leave in the mirror.
let leaked = 0;
walk(DEST, (file) => {
  const buf = fs.readFileSync(file);
  if (looksBinary(buf)) return;
  if (buf.toString('utf8').includes('phc_REPLACE_WITH_YOUR_POSTHOG_PROJECT_KEY')) {
    console.error(`sync-public: LEAK — production key still present in ${path.relative(DEST, file)}`);
    leaked++;
  }
});
if (leaked) die('aborting: production key survived sanitization');

// 3) Commit on the mirror's own forward-only history.
git(DEST, ['config', 'user.name', 'maestro-oss-sync[bot]']);
git(DEST, ['config', 'user.email', 'maestro-oss-sync@users.noreply.github.com']);
git(DEST, ['checkout', '-B', BRANCH]);
git(DEST, ['add', '-A']);
const status = git(DEST, ['status', '--porcelain']).trim();
if (!status) { console.log('sync-public: no changes — nothing to commit'); process.exit(0); }
git(DEST, ['commit', '-m', message], { stdio: 'inherit' });
console.log(`sync-public: committed "${message}"`);

// 4) Optionally push.
if (PUSH) {
  git(DEST, ['push', '-u', 'origin', BRANCH], { stdio: 'inherit' });
  console.log('sync-public: pushed');
} else {
  console.log('sync-public: SYNC_PUSH not set — leaving the commit unpushed');
}
