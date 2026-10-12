/**
 * Build + run a relay e2e under plain node: `web-e2e` (spec §10, the default)
 * or `web-parity-e2e` (web-desktop-parity §9.7), named by the first argument.
 * Bundles `scripts/<name>.ts` with all node_modules kept external so drizzle +
 * pglite resolve from `web/node_modules` at runtime. Invoked by
 * `npm --prefix web run e2e`, `npm run e2e:web` / `e2e:parity-web`, and CI.
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const name = process.argv[2] ?? 'web-e2e';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'web', 'dist-e2e', `${name}.cjs`);

execSync(
  `npx esbuild scripts/${name}.ts --bundle --platform=node --format=cjs --packages=external --outfile=${JSON.stringify(out)}`,
  { cwd: repo, stdio: 'inherit' }
);
execSync(`node ${JSON.stringify(out)}`, { cwd: repo, stdio: 'inherit' });
