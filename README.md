# Maestro

A cross-platform (macOS · Windows · Linux) desktop app that runs multiple CLI coding agents (Claude Code, Codex, Cursor, OpenCode, Kimi Code, Grok Build) **in parallel**, each in an **isolated git-worktree-backed workspace** with its own branch, terminal, chat, and diff. A functional clone of [Conductor](https://conductor.build).

![stack](https://img.shields.io/badge/Electron-React%2019-blue) ![stack](https://img.shields.io/badge/git%20worktrees-node--pty-green) ![platforms](https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-lightgrey)

## What it does

- **Projects** wrap a git repository (open local folder, clone from GitHub via `gh`, or "Quick start" a fresh repo), or a **plain folder** worked in directly (a single in-place workspace, no branches — shadow-git checkpoints still power a diff-since view). Projects can also live on a **remote machine over SSH** (see below).
- **Workspaces** are isolated copies of the repo created with `git worktree add -b <branch> <base>` after a `git fetch`, so every agent starts from the latest remote state. One branch per worktree, enforced by git — conflicts offer a `-2` suffixed branch.
- **Agents** run per-workspace through a pluggable harness layer. Claude Code is fully wired (`claude -p --output-format stream-json`, session resume, token-by-token streaming, tool-call chips, cost/duration). Codex, Cursor, OpenCode, Kimi Code, and Grok Build have adapters; a Shell fallback works with no agent CLI at all. Model and reasoning-effort are pickable per chat. Auth is passed through to whatever login each CLI already has — Maestro never stores model API keys.
- **Multiple agents can share one workspace** (e.g. one implements while another reviews) — pick "Agent 2 / New agent" in the composer, or hit **Review** to spawn a reviewer.
- **Roles / specialist sub-agents**: an orchestrator turn can delegate scoped tasks to sub-agents (via the bundled `maestro-role` helper), whose runs and cost fold back into the parent turn.
- **Terminal** tab is a real login shell (node-pty + xterm) cwd'd to the worktree, with copy/paste (Ctrl/⌘+C/V) and a right-click menu.
- **Editor** tab (`⌘⇧E`): a Monaco-backed file editor for quick in-app edits (`⌘S` to save), including Jupyter notebooks.
- **Preview** tab (`⌘⇧B`): an embedded browser pointed at the workspace's dev server that both you and the agent can drive — the agent navigates, screenshots, reads the console, and clicks/types via the `maestro-preview` helper, and you can annotate the page and send it back.
- **Scripts**: a repo-level *setup script* runs on workspace creation (restore `.env`, deps, DBs — worktrees only carry git-tracked files) and a *run script* launches the app with a unique `WORKSPACE_PORT` per workspace so parallel dev servers don't collide. *Spotlight run* is the fallback that runs from the main repo checkout when a worktree can't run cleanly.
- **Diff viewer** (`⌘⇧D`) diffs the worktree against the merge-base with the base branch (including untracked files), with a file tree, unified/split toggle, syntax highlighting, and **inline comment threads** that persist, resolve, and can be sent to the agent as a composer attachment.
- **Checks** tab (`⌘⇧K`): git ahead/behind + staged/unstaged/untracked, PR state with CI checks via `gh pr checks` data, PR comments, deployments, and a todo list. **Merge is gated** on approval + green checks + resolved comments + completed todos (with an explicit override).
- **PR flow** (`⌘⇧P`): pushes the branch, lets Claude draft the title/body from the actual diff, `gh pr create`, polls checks, `gh pr merge`, then prompts to archive.
- **Archive / History**: archived workspaces keep their worktree and chat; restore brings everything back. Hard delete runs `git worktree remove`.
- **`.context/`** in every worktree (git-ignored via `.git/info/exclude`) for notes, attachments, and agent-to-agent handoffs — pasted images/large text and dropped files are saved there and referenced in prompts.
- **`maestro-ask`**: an agent can pause and ask you a structured multiple-choice question, answered inline in the chat.
- **Command palette** (`⌘K`), workspace switching (`⌘1..9`), live status dots (idle / running / needs-attention / reviewing), needs-attention banner, desktop notifications when an agent finishes in the background, and light / dark / **system** themes. Shortcuts use ⌘ on macOS and Ctrl on Windows/Linux.
- **Dictation** (macOS only): an on-device speech-to-text button in the composer, backed by a bundled Swift helper (SFSpeechRecognizer). Hidden on other platforms.
- **Auto-update**: packaged builds check for and download new releases in the background (electron-updater), with a progress toast.
- **Conductor import**: migrate existing [Conductor](https://conductor.build) workspaces into Maestro.
- **In-app "Sign in with GitHub"** (sidebar badge, onboarding banner, or Settings → Integrations): an OAuth device flow — enter a one-time code on github.com/login/device and Maestro finishes the rest. The token is handed to `gh auth login --with-token` (stored in gh's keyring, never by Maestro) and git's credential helper for github.com is pointed at gh, so `git push` and the whole PR pipeline work with one click. If the GitHub CLI isn't installed at all, Maestro downloads the official build to `~/maestro/tools/gh-cli` and uses that everywhere (it's also added to agent/script PATH).
- **Remote SSH hosts**: open a folder on a remote machine (hosts are auto-detected from `~/.ssh/config` or added by hand) and every exec, spawn, pty, and filesystem operation for its workspaces runs on that server. Auth is SSH agent or an explicit key (passphrase prompted, never stored); host keys are TOFU-pinned on first connect, and `ProxyCommand`/`ProxyJump` are honored.

## Repo settings — `.maestro/settings.toml`

Checked into the repo so the whole team shares them (Settings → Repository):

```toml
[scripts]
setup = "npm install && cp ~/secrets/.env .env"
run = "npm run dev -- --port $WORKSPACE_PORT"

[project]
instructions = """
Durable guidance included in every agent session for this repo.
"""
```

Env injected into scripts, terminals and agents: `WORKSPACE_PORT`, `MAESTRO_WORKSPACE_NAME`, `MAESTRO_ROOT_PATH`, `MAESTRO_BRANCH`.

## Development

```bash
npm install            # also rebuilds better-sqlite3 + node-pty for Electron
npm run build          # renderer (vite) + main (esbuild) + native dictation helper (macOS)
npm start              # launch the app
npm run dev            # vite dev server + electron with HMR
npm run dist           # unpacked app via electron-builder
npm run dist:dmg       # macOS: .dmg
npm run dist:win       # Windows: NSIS .exe installer (build on Windows)
npm run dist:linux     # Linux: AppImage
```

Requirements: macOS, Windows 10/11, or Linux, and `git`. GitHub features need the GitHub CLI — either preinstalled or auto-downloaded by the in-app "Sign in with GitHub" flow. Each agent harness needs its own CLI installed (`claude`, `codex`, `cursor-agent`, `opencode`, `kimi`, or `grok`); the Shell fallback needs none.

> **Building for Windows:** native modules (`better-sqlite3`, `node-pty`) can't be cross-compiled from macOS, so the Windows installer must be built on Windows. The `build-desktop` GitHub Actions workflow (`.github/workflows/build-desktop.yml`) does this on a `windows-latest` runner — trigger it from the Actions tab or by pushing a `v*` tag, then download the installer from the run's artifacts.

### Tests

Service-level end-to-end suite (real repos, worktrees, ptys, and optionally a live Claude call):

```bash
npx esbuild scripts/e2e.ts --bundle --platform=node --format=cjs \
  --external:electron --external:better-sqlite3 --external:node-pty --outfile=dist/e2e.cjs
ELECTRON_RUN_AS_NODE=1 npx electron dist/e2e.cjs [--with-claude]
```

Process-launching invariants (`scripts/launch-probe.ts`, same build/run pattern): builds a fake npm-installed CLI in a
temp dir — both `cmd-shim` shapes plus an unreadable batch file — and checks that argv survives byte-for-byte through
`exec`, `spawnStream`, and a pty, that an `undefined` env value unsets a var, and that killing a child reaps its tree.
Worth running on Windows after touching `src/main/launch.ts` or a host. `scripts/llm-probe.ts` makes one real (cheap)
`generateText` call — the Status-tab digest path — against whichever agent CLI is installed.

Live GitHub verification (`scripts/gh-e2e.ts`, same build/run pattern): starts a real device-flow session, exercises the
post-approval path with the machine's existing gh token, then runs the whole PR pipeline against a throwaway private
repo — create → clone → workspace → commit → push → PR → status → squash-merge — and cleans up.

Headless UI smoke (launches the real app, captures a screenshot):

```bash
npm run build && npx electron . --smoke --screenshot=/tmp/maestro.png [--smoke-actions=tab-diff]
```

## Architecture

```
┌────────────────────────── Renderer (React 19 + Zustand) ─────────────────────────┐
│ Sidebar · Chat/Composer · Terminal (xterm) · DiffViewer · Editor · Preview · Checks │
└──────────────▲────────────────────────────────────────────────────────────────────┘
               │ typed IPC (contextBridge → invoke/on, src/shared/types.ts)
┌──────────────┴─────────────────── Main (Node) ───────────────────────────────┐
│ git service (worktrees/diff/status)   pty service (node-pty pool + buffers)  │
│ harness adapters (claude/codex/…)     github service (gh CLI)                │
│ host layer (local · ssh2)             script runner (WORKSPACE_PORT)         │
│ roles / preview / stt servers         better-sqlite3 (projects/ws/chats/…)   │
│ fs watchers (dirty state, .context)   .maestro/settings.toml                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Every exec/spawn/pty/fs primitive goes through a **host** — `LocalHost` (this machine) or an `SshHost` for remote projects — so the same services work locally or over SSH.
- Workspaces live in `~/maestro/workspaces/<project>/<name>`; cloned repos in `~/maestro/repos`.
- The DB is at `<userData>/maestro.db` — i.e. `~/Library/Application Support/Maestro/` (macOS), `%APPDATA%\Maestro\` (Windows), `~/.config/Maestro/` (Linux). Set `MAESTRO_DB_PATH` to override (used by tests).
- Agent turns are persisted as structured blocks (text / thinking / tool + result), so history renders identically after restore.

## Notes & limitations

- Isolation is development-grade, not a security boundary — agents run with your local permissions (or, for remote projects, the SSH user's).
- Claude Code is the most exercised harness. Codex, Cursor, OpenCode, Kimi Code, and Grok Build adapters are wired but lightly exercised; the Shell fallback guarantees a working loop without any agent CLI.
- Dictation is macOS-only (on-device Swift helper); the mic button is hidden elsewhere.
- Linear integration needs a personal API token (Settings → Integrations) and fetches issue title/description into the first prompt.
- **Anonymous analytics**: packaged builds send anonymous usage events (a random per-install id — no account, prompts, repo names, or other PII) to PostHog to gauge how many people run Maestro. It is off in dev/unpackaged runs and off unless a real PostHog key is configured (`MAESTRO_POSTHOG_KEY` at build time); forks that set no key emit nothing.

## License

Copyright (C) 2026 Maestro contributors.

Licensed under the Business Source License 1.1 (BSL) — see [`LICENSE`](LICENSE).
You may read, run, self-host, modify, and redistribute Maestro; you may not offer
it to third parties on a hosted or embedded basis that competes with Maestro's
products or services. Four years after a given version is released, that version
converts to the Apache License 2.0.
