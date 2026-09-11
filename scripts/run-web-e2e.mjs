/**
 * Build + run the relay e2e (spec §10). Bundles `scripts/web-e2e.ts` with all
 * node_modules kept external so drizzle + pglite resolve from `web/node_modules`
 * at runtime, then runs it under plain node. Invoked by `npm --prefix web run e2e`
 * and directly in CI.
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'web', 'dist-e2e', 'web-e2e.cjs');

execSync(
  `npx esbuild scripts/web-e2e.ts --bundle --platform=node --format=cjs --packages=external --outfile=${JSON.stringify(out)}`,
  { cwd: repo, stdio: 'inherit' }
);
execSync(`node ${JSON.stringify(out)}`, { cwd: repo, stdio: 'inherit' });
