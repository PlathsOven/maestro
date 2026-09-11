/**
 * Build + run the desktop-parity relay e2e (web-desktop-parity §9.7). Bundles
 * `scripts/web-parity-e2e.ts` with node_modules external so drizzle + pglite
 * resolve from `web/node_modules`, then runs it under plain node.
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'web', 'dist-e2e', 'web-parity-e2e.cjs');

execSync(
  `npx esbuild scripts/web-parity-e2e.ts --bundle --platform=node --format=cjs --packages=external --outfile=${JSON.stringify(out)}`,
  { cwd: repo, stdio: 'inherit' }
);
execSync(`node ${JSON.stringify(out)}`, { cwd: repo, stdio: 'inherit' });
