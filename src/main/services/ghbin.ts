import fs from 'fs';
import os from 'os';
import path from 'path';
import { run } from '../exec';
import { maestroHome } from '../env';

// Resolves the GitHub CLI binary. Prefers a system `gh` on PATH; falls back to
// a copy Maestro downloaded itself, so in-app sign-in works even on machines
// that never installed gh.

const isWindows = process.platform === 'win32';
const GH_EXE = isWindows ? 'gh.exe' : 'gh';

let cached: string | null = null;

export function ghPath(): string {
  return cached ?? 'gh';
}

function downloadedGhPath(): string {
  return path.join(maestroHome(), 'tools', 'gh-cli', 'bin', GH_EXE);
}

export async function resolveGh(): Promise<string | null> {
  if (cached) return cached;
  if ((await run('gh', ['--version'], { timeout: 10_000 })).ok) {
    cached = 'gh';
    return cached;
  }
  const dl = downloadedGhPath();
  if (fs.existsSync(dl) && (await run(dl, ['--version'], { timeout: 10_000 })).ok) {
    cached = dl;
    return cached;
  }
  return null;
}

/** Resolve gh, downloading the official build for this OS if it's missing entirely. */
export async function ensureGh(): Promise<string> {
  const existing = await resolveGh();
  if (existing) return existing;

  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const osName = isWindows ? 'windows' : 'macOS';
  const assetSuffix = `_${osName}_${arch}.zip`;
  const rel = await fetch('https://api.github.com/repos/cli/cli/releases/latest', {
    headers: { 'User-Agent': 'maestro', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!rel.ok) throw new Error(`Could not query GitHub CLI releases (HTTP ${rel.status})`);
  const json: any = await rel.json();
  const asset = (json.assets ?? []).find((a: any) => a.name?.endsWith(assetSuffix));
  if (!asset) throw new Error(`No ${osName} GitHub CLI build found in the latest release`);

  const zipRes = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'maestro' },
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  });
  if (!zipRes.ok) throw new Error(`GitHub CLI download failed (HTTP ${zipRes.status})`);
  const buf = Buffer.from(await zipRes.arrayBuffer());

  const tmpZip = path.join(os.tmpdir(), `maestro-gh-${Date.now()}.zip`);
  const extractDir = path.join(os.tmpdir(), `maestro-gh-extract-${Date.now()}`);
  fs.writeFileSync(tmpZip, buf);
  try {
    // ditto is macOS-only; PowerShell's Expand-Archive ships with every
    // supported Windows and handles .zip natively.
    const unzip = isWindows
      ? await run(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath '${tmpZip.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
          ],
          { timeout: 60_000 }
        )
      : await run('ditto', ['-xk', tmpZip, extractDir], { timeout: 60_000 });
    if (!unzip.ok) throw new Error(`Could not extract GitHub CLI: ${unzip.stderr.trim()}`);
    // Layouts differ by OS: the macOS archive wraps everything in a single
    // `gh_<version>_<os>_<arch>/` directory, while the Windows zip unpacks
    // `bin/`, `LICENSE`, etc. straight into the destination. Copy from whichever
    // directory actually holds `bin/<gh>` — the extract root or its one child.
    const hasBin = (dir: string) => fs.existsSync(path.join(dir, 'bin', GH_EXE));
    const sourceRoot = hasBin(extractDir)
      ? extractDir
      : fs
          .readdirSync(extractDir)
          .map((d) => path.join(extractDir, d))
          .find(hasBin);
    if (!sourceRoot) throw new Error('Unexpected GitHub CLI archive layout');
    const destRoot = path.join(maestroHome(), 'tools', 'gh-cli');
    fs.rmSync(destRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destRoot), { recursive: true });
    fs.cpSync(sourceRoot, destRoot, { recursive: true });
    // Executable bit matters on Unix; on Windows the .exe is already runnable.
    if (!isWindows) fs.chmodSync(path.join(destRoot, 'bin', GH_EXE), 0o755);
  } finally {
    fs.rmSync(tmpZip, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  const bin = downloadedGhPath();
  if (!(await run(bin, ['--version'], { timeout: 10_000 })).ok) {
    throw new Error('Downloaded GitHub CLI does not run');
  }
  cached = bin;
  return bin;
}
