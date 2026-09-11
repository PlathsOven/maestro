# Open-source mirror

Maestro is developed in a **private** repo (`PlathsOven/visual-conductor`, full
history, all release/deploy secrets) and published as a **public**, BSL-1.1-licensed
mirror (`PlathsOven/maestro`). The mirror is a sanitized, **history-free**
snapshot: none of the private repo's commit messages or past file versions ever
appear publicly — the mirror keeps its own clean, forward-only "Sync vX.Y.Z"
history.

Nothing about the private repo changes: releases, the desktop auto-update feed
(Vercel Blob), the Vercel web/landing deploys, and the Railway server all keep
working exactly as before. The mirror is downstream of all of it.

## How it works

`scripts/sync-public.mjs` copies the private working tree into a checkout of the
mirror, then:

- **excludes** everything in [`.publicignore`](../.publicignore) (build output,
  internal specs, and — by default — the hosted-service surfaces `web/`,
  `landing/`, `server/maestro-cloud/`);
- **sanitizes** so forks never phone home to us: the PostHog project key is
  swapped for an inert `…REPLACE…` placeholder (every embed gates on that), and
  the desktop `DEFAULT_RELAY` is blanked;
- **commits** one fresh `Sync vX.Y.Z (sha)` commit and pushes.

The sync runs on the **public** repo (free unlimited Actions minutes) via
[`.github/workflows/sync-public.yml`](../.github/workflows/sync-public.yml). It
triggers automatically after each release (the private `release.yml` sends a
`repository_dispatch`) and from the mirror's **Run workflow** button.

### What is published, by default

Published: the desktop app (`src/`, `scripts/`, `build/`, top-level configs,
`docs/` minus `docs/specs/`), the CI workflows, and this file.

Withheld: `web/`, `landing/`, `server/maestro-cloud/`, `docs/specs/`, and build
output. **Publishing is one-way** — you can widen scope on the next sync but you
can never un-publish. To publish one of those surfaces, delete its line in
`.publicignore`. Re-run the secret scan first (below).

## One-time setup

1. **Create the empty public repo** `PlathsOven/maestro` on GitHub — no README,
   no license, no `.gitignore` (the first sync populates everything, including the
BSL `LICENSE`).

2. **Create two fine-grained PATs** (least privilege — each only touches what it
   must) and add each as an **Actions secret**:

   | Secret name | Lives on repo | Scope | Permission | Used for |
   |---|---|---|---|---|
   | `PRIVATE_SRC_TOKEN` | **public** `maestro` | `visual-conductor` | Contents: **Read-only** | clone private source in CI |
   | `PUBLIC_SYNC_TOKEN` | **private** `visual-conductor` | `maestro` | Contents: **Read & write** | dispatch the sync after release |

   (`PUBLIC_SYNC_TOKEN` needs write because the repository-dispatch REST endpoint
   requires it. The push back into the mirror uses the built-in `GITHUB_TOKEN`,
   so no push token is needed.)

3. **Bootstrap the first push** from a local clone (the mirror can't run its own
   workflow until that workflow exists in it). From the private checkout:

   ```bash
   git clone https://github.com/PlathsOven/maestro.git /tmp/maestro-mirror
   SYNC_SRC=. SYNC_DEST=/tmp/maestro-mirror SYNC_PUSH=1 npm run sync:public
   ```

   That publishes the sanitized snapshot (including the workflow) to the mirror's
   `main`. After this, every release auto-syncs, and the **Run workflow** button
   works on demand.

## Before publishing (or widening scope): scan for secrets

The sanitizer only blanks the analytics key + relay. Before the first push, and
any time you un-exclude a surface, scan the tree that's about to go public:

```bash
git ls-files | grep -iE '\.(pem|p12|pfx|keystore|jks)$|(^|/)\.env($|\.)' | grep -v '\.env\.example'
git grep -nIE -e 'BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY' -e 'ghp_[A-Za-z0-9]{20,}' \
  -e 'github_pat_[A-Za-z0-9_]{20,}' -e 'vercel_blob_rw_[A-Za-z0-9_]+' -e 'AKIA[0-9A-Z]{16}'
```

Consider a dedicated scanner (`gitleaks detect --no-git`, `trufflehog filesystem .`).

## Local dry run

To preview exactly what would be published without pushing:

```bash
git clone https://github.com/PlathsOven/maestro.git /tmp/maestro-mirror   # or: git init /tmp/maestro-mirror
SYNC_SRC=. SYNC_DEST=/tmp/maestro-mirror npm run sync:public   # no SYNC_PUSH -> commits locally only
git -C /tmp/maestro-mirror show --stat
```
