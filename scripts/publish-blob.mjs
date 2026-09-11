// Publish release artifacts to Vercel Blob using ONLY BLOB_READ_WRITE_TOKEN.
//
// The Vercel CLI (v56+) requires an interactive account login for `blob put`
// even when a store read-write token is supplied, which CI doesn't have. The
// @vercel/blob SDK talks straight to the Blob API with just the token, so it
// works in a headless runner. Usage: node scripts/publish-blob.mjs <files...>
//
// Retention: each release publishes ~540MB of installers under version-stamped
// names (Maestro-<ver>-*) across mac/win/linux, and nothing overwrites the
// previous version's files, so the store grows ~540MB per release. The Vercel
// Blob Hobby tier caps at 1GB, so even two versions overflow it — then every
// publish fails with "Storage quota exceeded". To keep the store bounded we prune
// old versions' installers BEFORE uploading (pruning after would hit the same
// quota wall the upload does), always retaining the version being published plus
// BLOB_KEEP_RELEASES-1 previous ones (CI pins BLOB_KEEP_RELEASES=1 for the cap).
import { put, list, del } from '@vercel/blob';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error('::error::BLOB_READ_WRITE_TOKEN is not set — cannot publish the update feed.');
  process.exit(1);
}

const CONTENT_TYPE = {
  '.yml': 'text/yaml',
  '.json': 'application/json', // changelog.json — read by the landing page
  '.exe': 'application/x-msdownload',
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
  '.AppImage': 'application/octet-stream', // ELF binary — octet-stream forces a clean download
  '.blockmap': 'application/octet-stream',
};

const files = process.argv.slice(2).filter(Boolean);
if (files.length === 0) {
  console.error('::error::No files passed to publish.');
  process.exit(1);
}

// How many recent versions' installers to keep (current release + previous ones).
// CI pins this to 1 because three platforms' installers (~540MB/release) mean two
// versions overflow the 1GB Hobby cap. electron-updater deltas against the
// client's own local copy, so keeping only the newest artifact on the server is
// enough for auto-update; raise this (env var) once off the Hobby plan to retain
// previous versions for direct download / rollback.
const KEEP = Math.max(1, parseInt(process.env.BLOB_KEEP_RELEASES ?? '2', 10));

// Version stamp inside an installer name, e.g. Maestro-0.1.7-arm64.dmg -> 0.1.7.
// The version may be followed by "-" (…-arm64.dmg, …-x64-setup.exe) or "." (a
// bare …-<ver>.AppImage with no arch), so accept either — otherwise an unmatched
// installer is treated as unversioned, never pruned, and eventually blows the
// quota. Non-versioned blobs (latest.yml, latest-mac.yml, latest-linux.yml)
// never match and are kept.
const VER_RE = /-(\d+\.\d+\.\d+)[-.]/;
const versionOf = (name) => name.match(VER_RE)?.[1] ?? null;
const cmpVerDesc = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
};

// Versions being published in THIS run — always retained regardless of KEEP.
const publishing = new Set(files.map((f) => versionOf(basename(f))).filter(Boolean));

// Prune older versions' installers up front so the new files fit under the quota.
// Best-effort: listing/deleting failures are warnings, not errors — if space
// genuinely couldn't be freed the upload below surfaces the real quota error.
// Safe to run concurrently from the parallel win/mac matrix jobs: both derive the
// same keep set (neither deletes the version being published) and del() is a
// no-op on already-removed blobs.
async function pruneOldReleases() {
  let blobs;
  try {
    blobs = [];
    let cursor;
    for (;;) {
      const page = await list({ token, cursor, limit: 1000 });
      blobs.push(...page.blobs);
      if (!page.hasMore) break;
      cursor = page.cursor;
    }
  } catch (err) {
    console.warn(`::warning::could not list blobs to prune old releases: ${err?.message ?? err}`);
    return;
  }

  const byVersion = new Map();
  for (const b of blobs) {
    const v = versionOf(b.pathname);
    if (!v) continue; // manifests and anything unversioned — never pruned
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(b);
  }

  const keep = new Set(publishing);
  for (const v of [...byVersion.keys()].sort(cmpVerDesc)) {
    if (keep.size >= KEEP) break;
    keep.add(v);
  }

  const toDelete = [];
  for (const [v, arr] of byVersion) {
    if (!keep.has(v)) for (const b of arr) toDelete.push(b.url);
  }

  const kept = [...keep].sort(cmpVerDesc).join(', ') || '(none)';
  if (toDelete.length === 0) {
    console.log(`prune: keeping ${kept}; nothing older to remove`);
    return;
  }
  console.log(`prune: keeping ${kept}; removing ${toDelete.length} file(s) from older releases`);
  try {
    await del(toDelete, { token }); // accepts a URL array; missing URLs are no-ops
    console.log(`prune: removed ${toDelete.length} old file(s)`);
  } catch (err) {
    console.warn(`::warning::failed to delete some old blobs: ${err?.message ?? err}`);
  }
}

await pruneOldReleases();

// Vercel Blob frees space asynchronously after del(), and the win/mac matrix
// jobs upload concurrently — so a put() right after pruning can be transiently
// rejected as over-quota even though space was (or is about to be) freed once the
// deletes settle. Retry those transient errors with a delay; fail fast on genuine
// ones (bad auth, malformed request) so real problems still surface immediately.
const RETRY_ATTEMPTS = Math.max(1, parseInt(process.env.BLOB_PUT_ATTEMPTS ?? '6', 10));
const RETRY_DELAY_MS = Math.max(0, parseInt(process.env.BLOB_PUT_RETRY_MS ?? '20000', 10));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isTransient = (err) => {
  const m = String(err?.message ?? err).toLowerCase();
  return (
    err?.status === 429 ||
    m.includes('quota') ||
    m.includes('exceeded') ||
    m.includes('rate limit') ||
    m.includes('too many requests')
  );
};
async function putWithRetry(name, body, opts) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await put(name, body, opts);
    } catch (err) {
      if (attempt >= RETRY_ATTEMPTS || !isTransient(err)) throw err;
      console.log(
        `retry ${attempt}/${RETRY_ATTEMPTS - 1} for ${name}: ${err?.message ?? err} — waiting ${RETRY_DELAY_MS}ms for freed space to settle`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// Upload the version-stamped installers first and the latest*.yml manifest LAST,
// so a partial failure never leaves a published manifest pointing at installers
// that haven't finished uploading (which would break clients polling the feed).
const uploadOrder = [...files].sort(
  (a, b) => (extname(a) === '.yml' ? 1 : 0) - (extname(b) === '.yml' ? 1 : 0),
);

let failed = false;
for (const file of uploadOrder) {
  const name = basename(file);
  try {
    const size = statSync(file).size;
    const res = await putWithRetry(name, readFileSync(file), {
      access: 'public',
      token,
      addRandomSuffix: false, // keep clean, predictable pathnames the landing page/feed reference
      allowOverwrite: true, // latest*.yml + versioned installers are overwritten each release
      contentType: CONTENT_TYPE[extname(file)] ?? 'application/octet-stream',
      // The latest*.yml manifests (and changelog.json) are overwritten every
      // release and polled by clients/the landing page, so keep them near-fresh
      // (60s) — otherwise a stale cached manifest delays update detection
      // regardless of how often the app checks. Versioned installers are
      // immutable, so they keep Vercel Blob's long default.
      cacheControlMaxAge: ['.yml', '.json'].includes(extname(file)) ? 60 : undefined,
      multipart: size > 20 * 1024 * 1024, // resilient chunked upload for the large installers
    });
    console.log(`published ${name} (${size} bytes) -> ${res.url}`);
  } catch (err) {
    console.error(`::error::failed to publish ${name}: ${err?.message ?? err}`);
    failed = true;
    // Stop before the manifest (uploaded last) so a failed installer never gets
    // a published latest*.yml advertising it. Re-running the job republishes.
    break;
  }
}
process.exit(failed ? 1 : 0);
