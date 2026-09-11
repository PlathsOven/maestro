// Build release/changelog.json — every release (version, date, what shipped)
// — from git history. Feeds both the landing page's "Recent releases" widget
// and the full /changelog page from one source, so they can't drift. Runs in
// CI on the mac matrix job (the same one that publishes latest-mac.yml), where
// the checkout has full history + tags (fetch-depth: 0 in build-desktop.yml).
//
// Titles are the commit subjects between consecutive release tags — i.e. the
// squash-merged PR titles, which are human-written — so the section stays
// authentic with zero per-release editing. The bot's own "chore: release
// vX.Y.Z" bumps are filtered out.
//
// The changelog is a *product* log: it should list what changed in the app,
// not marketing/docs/landing housekeeping (e.g. "Remove pricing mentions from
// landing", "Update README", "Identify subreddits for promotion"). Because
// every auto-update — each CI release build — runs through this one script,
// the rule applies to all future releases with no ongoing effort. Three layers
// enforce it, most-durable first:
//   1. Path filter — a commit is kept only if it touched app source under
//      APP_PATHS (src/). Landing-only, README-only, and CI-script-only PRs
//      drop out automatically with no per-PR bookkeeping. Handles most noise.
//   2. Explicit opt-out — a maintainer marks a mixed PR with SKIP_MARKER
//      ("Changelog: skip" / "[skip changelog]") in the squash-commit body.
//      Intent-based, so it never drifts with wording; the preferred mechanism.
//   3. Title denylist — EXCLUDE_TITLE is the automatic fallback for mixed PRs
//      nobody marked. Keyword-based, so it can drift; extend it when a new
//      marketing/docs term leaks in, but prefer (2).
// Output shape (newest first):
//   [{ "version": "0.1.37", "date": "…", "title": "…", "items": ["…", "…"] }]
// `title` is the one-line summary the home page's widget renders; `items` is
// the full per-release bullet list the /changelog page renders.
//
// Best-effort by design: any git failure emits a warning and exits 0 so the
// feed publish never blocks on the changelog. The landing page hides the
// section when the file is missing or empty.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

// Emit every release by default so /changelog can render the full history; the
// home page's "Recent releases" widget slices to the latest few client-side.
// CHANGELOG_RELEASES caps the count when set (handy for quick local runs).
const CAP = parseInt(process.env.CHANGELOG_RELEASES ?? '', 10);
const COUNT = Number.isFinite(CAP) && CAP > 0 ? CAP : Infinity;

// Guard against the oldest tag (which has no predecessor) turning the entire
// pre-1.0 history into bullet points — cap each release's list and summarize
// the remainder in a final line.
const MAX_ITEMS = 12;

// A commit is a product change only if it touched source under one of these
// paths. Keep this to the shipped app; landing/, docs/, scripts/, and root
// config stay out so their PRs never reach the changelog.
const APP_PATHS = ['src'];

// Explicit, intent-based opt-out. A maintainer can keep any PR out of the
// changelog by putting one of these markers in the squash-commit body (the PR
// description, editable at merge time) — no code change, no keyword guessing.
// This is the durable exclusion signal; the keyword denylist below is only an
// automatic fallback for PRs nobody remembered to mark.
//   Changelog: skip        (a trailer line, git-trailer style)
//   [skip changelog]       (inline, anywhere in the title or body)
const SKIP_MARKER = /\[skip changelog\]|^\s*changelog:\s*(skip|none|no)\b/im;

// Automatic backstop for mixed PRs that bundled a stray src/ edit into
// non-product work (marketing, promotion, SEO, docs) and weren't marked with
// SKIP_MARKER. The path filter can't catch those, so drop them by title.
// Case-insensitive; extend as new leaks appear — but prefer SKIP_MARKER, which
// doesn't drift with wording.
const EXCLUDE_TITLE = /\b(subreddit|promotion|promote|marketing|seo|readme|changelog|landing page|pricing)\b/i;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let tags = [];
try {
  tags = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').filter(Boolean);
} catch (err) {
  console.warn(`::warning::changelog: could not list tags: ${err?.message ?? err}`);
}
if (tags.length === 0) {
  console.warn('::warning::changelog: no v* tags in this checkout (shallow clone?) — skipping');
  process.exit(0);
}

const entries = [];
for (let i = 0; i < Math.min(COUNT, tags.length); i++) {
  const tag = tags[i];
  const prev = tags[i + 1];
  let date = '';
  try {
    date = git('log', '-1', '--format=%cI', tag);
  } catch {
    /* leave empty — the page renders the row without a date */
  }
  const range = prev ? `${prev}..${tag}` : tag;
  let subjects = [];
  try {
    // Commits in this range that touched app source. A path-limited `git log`
    // omits commits that changed nothing under APP_PATHS, so this set is
    // exactly the product changes; we intersect it with the full commit list
    // below to drop landing/docs/CI-only PRs.
    const appHashes = new Set(
      git('log', '--no-merges', '--format=%H', range, '--', ...APP_PATHS)
        .split('\n')
        .filter(Boolean),
    );
    // -z NUL-delimits commits so a multi-line %b body can't be mistaken for a
    // new record; fields within a commit are 0x1f-separated.
    subjects = git('log', '-z', '--no-merges', '--format=%H%x1f%s%x1f%b', range)
      .split('\0')
      .map((rec) => {
        const [hash, subject = '', body = ''] = rec.split('\x1f');
        return { hash, subject: subject.trim(), body };
      })
      .filter(({ hash, subject, body }) => {
        if (!subject) return false;
        if (/^chore: release v/.test(subject) || /^Merge /.test(subject)) return false;
        if (!appHashes.has(hash)) return false; // non-product (landing/docs/CI) PR
        if (SKIP_MARKER.test(`${subject}\n${body}`)) return false; // explicit opt-out
        if (EXCLUDE_TITLE.test(subject)) return false; // mixed marketing/docs PR
        return true;
      })
      .map(({ subject }) => subject.replace(/\s*\(#\d+\)\s*$/, ''));
  } catch {
    /* fall through to the placeholder title */
  }
  // git log lists newest first, so subjects[0] is the most recent product
  // change in the range — the one that headlines the release. A release whose
  // only changes were non-product (landing/docs/marketing) filters down to an
  // empty list and renders as a plain "Maintenance release" with no bullets.
  const title =
    subjects.length === 0
      ? 'Maintenance release'
      : subjects.length === 1
        ? subjects[0]
        : `${subjects[0]} — and ${subjects.length - 1} more`;
  // Full detail for the /changelog page: every merged-PR title in the range,
  // bounded so the genesis release can't dump the whole pre-1.0 history.
  const items = subjects.slice(0, MAX_ITEMS);
  if (subjects.length > MAX_ITEMS) items.push(`…and ${subjects.length - MAX_ITEMS} more`);
  entries.push({ version: tag.replace(/^v/, ''), date, title, items });
}

mkdirSync('release', { recursive: true });
writeFileSync('release/changelog.json', JSON.stringify(entries, null, 2) + '\n');
console.log(`changelog: wrote release/changelog.json (${entries.length} release(s))`);
