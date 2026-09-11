import fs from 'fs';
import path from 'path';

/**
 * Guards the process-launching seam. Everything the app starts goes through a
 * host (src/main/hosts) so the Windows shim resolution in src/main/launch.ts
 * applies once instead of being remembered at each call site — that's how
 * `spawn claude ENOENT` reached the Status tab while every other path worked.
 * Reaching for `child_process` outside the seam is how the next one gets in.
 */
const ALLOWED = new Set([
  'src/main/launch.ts', // the resolver itself
  'src/main/hosts/local.ts', // the local seam
  'src/main/hosts/ssh.ts', // ProxyCommand: a shell command by contract
  'src/main/env.ts', // login-shell probe, before any host exists
  'src/main/services/jupyter.ts', // kernel bridge, via resolveLaunch
  'src/main/services/stt.ts', // bundled dictation helper, absolute path
]);

const offenders = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(entry.name)) {
      const rel = p.split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/from ['"]child_process['"]|require\(['"]child_process['"]\)/.test(src)) offenders.push(rel);
    }
  }
}

walk('src');

if (offenders.length) {
  console.error(
    `${offenders.length} file(s) import child_process outside the host seam:\n` +
      offenders.map((o) => `  ${o}`).join('\n') +
      `\n\nLaunch processes through a host (hosts/types.ts: exec / spawnStream / pty), or\n` +
      `resolve the command with src/main/launch.ts and add the file to ALLOWED in\n` +
      `scripts/check-seams.mjs with a reason.`
  );
  process.exit(1);
}

/**
 * Purity guard for the shared harness pipeline (mobile-web-app spec §5, G7).
 * `src/shared/harness/` is imported by BOTH the Electron main process and the
 * relay ingest (`web/`), so it must stay pure: no node builtins, no
 * main-process modules. If it drifts, the "one parse implementation" guarantee
 * (and the relay build) breaks. Only `../types` and sibling `./` files allowed.
 */
const NODE_BUILTINS =
  /from ['"](?:node:)?(?:fs|os|path|crypto|child_process|net|http|https|stream|util|events|electron)['"]|require\(['"]/;
const sharedOffenders = [];
function walkShared(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkShared(p);
    else if (/\.tsx?$/.test(entry.name)) {
      const rel = p.split(path.sep).join('/');
      const src = fs.readFileSync(p, 'utf8');
      if (NODE_BUILTINS.test(src)) sharedOffenders.push(`${rel} (node builtin / electron)`);
      // Must not reach back into the main process (only shared/types + siblings).
      for (const m of src.matchAll(/from ['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (spec.startsWith('.') && !/^\.\.\/types$|^\.\/[\w-]+$|^\.\.\/harness/.test(spec)) {
          sharedOffenders.push(`${rel} → ${spec} (only ../types and siblings allowed)`);
        }
      }
    }
  }
}
if (fs.existsSync('src/shared/harness')) walkShared('src/shared/harness');
if (sharedOffenders.length) {
  console.error(
    `${sharedOffenders.length} impurity in src/shared/harness (must be node-free, main-process-free):\n` +
      sharedOffenders.map((o) => `  ${o}`).join('\n') +
      `\n\nThe shared harness pipeline runs on the desktop AND in the relay ingest —\n` +
      `keep it pure (only ../types + sibling modules). Move node/main-process code out.`
  );
  process.exit(1);
}

/**
 * Purity guard for the shared UI package (web-desktop-parity spec §2.3, G1).
 * `src/shared/ui/` is imported by BOTH the Electron renderer and Maestro Web, so
 * it must stay presentational: React + a short allow-list of render deps + the
 * shared types/harness + siblings. No store (zustand), no renderer/main modules,
 * no electron / next / node builtins, no `window.maestro`. Host-specific
 * behaviour is injected through the UiHost context (host.tsx).
 */
const UI_BARE_ALLOWED = new Set([
  'react',
  'react/jsx-runtime',
  'clsx',
  'lucide-react',
  'marked',
  'marked-katex-extension',
  'dompurify',
  'katex',
]);
const UI_NODE_BUILTINS =
  /from ['"](?:node:)?(?:fs|os|path|crypto|child_process|net|http|https|stream|util|events|electron)['"]|require\(['"]/;
const uiOffenders = [];
function walkUi(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkUi(p);
    else if (/\.tsx?$/.test(entry.name)) {
      const rel = p.split(path.sep).join('/');
      const src = fs.readFileSync(p, 'utf8');
      if (UI_NODE_BUILTINS.test(src)) uiOffenders.push(`${rel} (node builtin / electron)`);
      if (/window\s*\.\s*maestro/.test(src)) uiOffenders.push(`${rel} (window.maestro — inject via UiHost instead)`);
      for (const m of src.matchAll(/from ['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (spec.startsWith('.')) {
          // Relative import: must not reach into the renderer or main process, or
          // escape the shared tree. (../types and ../harness/* stay inside shared.)
          if (/(^|\/)(renderer|main)(\/|$)/.test(spec)) {
            uiOffenders.push(`${rel} → ${spec} (must not import renderer/main)`);
          }
        } else if (/^highlight\.js(\/.*)?$/.test(spec)) {
          // allowed: highlight.js and highlight.js/lib/*
        } else if (!UI_BARE_ALLOWED.has(spec)) {
          uiOffenders.push(`${rel} → ${spec} (not in the shared-UI allow-list)`);
        }
      }
    }
  }
}
if (fs.existsSync('src/shared/ui')) walkUi('src/shared/ui');
if (uiOffenders.length) {
  console.error(
    `${uiOffenders.length} impurity in src/shared/ui (must be presentational, host-agnostic):\n` +
      uiOffenders.map((o) => `  ${o}`).join('\n') +
      `\n\nsrc/shared/ui renders on the desktop AND on the web — keep it pure: React +\n` +
      `the render-dep allow-list + ../types + ../harness/* + siblings. Move store/IPC/\n` +
      `node/renderer code out, and inject host behaviour through UiHost (host.tsx).`
  );
  process.exit(1);
}
console.log('seams ok');
