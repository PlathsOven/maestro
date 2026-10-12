import type { ExecHost } from './types';

/** POSIX single-quote a shell argument, for commands run on ssh/cloud boxes. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const homeCache = new Map<string, Promise<string>>();

/** The box's $HOME, cached per host. '.' if it can't be read — and then not
 *  cached, so a box that was briefly unreachable is asked again next time
 *  instead of having every shim path pinned relative forever. */
export function homeFor(host: ExecHost): Promise<string> {
  let p = homeCache.get(host.id);
  if (!p) {
    const probe: Promise<string> = host
      .exec('sh', ['-lc', 'printf %s "$HOME"'])
      .then((r) => r.stdout.trim())
      .catch(() => '')
      .then((home) => {
        if (home) return home;
        if (homeCache.get(host.id) === probe) homeCache.delete(host.id);
        return '.';
      });
    p = probe;
    homeCache.set(host.id, p);
  }
  return p;
}

const shimsUploaded = new Map<string, Set<string>>(); // shim name → `${hostId}:${hash}`

/** Upload `body` as the box's `~/.maestro/bin/<name>` (0755), once per host and
 *  content hash; returns the shim's path. */
export async function ensureShim(host: ExecHost, name: string, body: string, hash: string): Promise<string> {
  const bin = host.path.join(await homeFor(host), '.maestro', 'bin');
  const shim = host.path.join(bin, name);
  const uploaded = shimsUploaded.get(name) ?? new Set<string>();
  shimsUploaded.set(name, uploaded);
  const key = `${host.id}:${hash}`;
  if (!uploaded.has(key)) {
    await host.fs.mkdirp(bin);
    await host.fs.write(shim, body);
    await host.fs.chmod(shim, 0o755);
    uploaded.add(key);
  }
  return shim;
}

/** Forget every upload of shim `name`, so the next ensureShim re-sends it. */
export function forgetShim(name: string): void {
  shimsUploaded.delete(name);
}
