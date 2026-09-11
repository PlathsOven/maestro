// The one module that imports monaco-editor directly. Everything else in the
// editor surface goes through here, so Monaco stays in a single lazily-loaded
// chunk (see vite.config.ts `manualChunks`) and its parse cost is paid on first
// file open, not at app startup.
import * as monaco from 'monaco-editor';
// Bare specifiers (no `esm/vs/` prefix): monaco's exports map resolves
// `monaco-editor/<x>` → `esm/vs/<x>.js`, so prefixing would double-nest the path.
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';

// Explicit worker wiring — no bundler plugin. TS/JS/JSON/CSS/HTML get their real
// language services (single-file diagnostics, completion); everything else uses
// the base editor worker with monarch tokenization only.
self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === 'typescript' || label === 'javascript'
      ? new TsWorker()
      : label === 'json'
        ? new JsonWorker()
        : label === 'css' || label === 'scss' || label === 'less'
          ? new CssWorker()
          : label === 'html' || label === 'handlebars' || label === 'razor'
            ? new HtmlWorker()
            : new EditorWorker(),
};

export { monaco };

// Single-file editing has no project graph, so semantic checks (unresolved
// imports, missing types) would be all false positives — suppress them but keep
// real syntax errors. Matches "built-in single-file smarts only" (spec §3).
// (monaco 0.56 moved these defaults to the top-level `typescript` namespace.)
try {
  const opts = { noSemanticValidation: true, noSyntaxValidation: false };
  monaco.typescript?.typescriptDefaults.setDiagnosticsOptions(opts);
  monaco.typescript?.javascriptDefaults.setDiagnosticsOptions(opts);
} catch {
  /* language contribution not present — ignore */
}

// ---------------- language routing ----------------

// Extension → Monaco language id. Monaco ships ~80 monarch grammars; ids differ
// from file extensions (e.g. bash/sh/zsh → 'shell', .m → 'objective-c'). Unknown
// extensions fall back to 'plaintext'.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json', map: 'json', ipynb: 'json',
  css: 'css', scss: 'scss', less: 'less', sass: 'scss', pcss: 'css',
  html: 'html', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html',
  xml: 'xml', svg: 'xml', xsl: 'xml', plist: 'xml',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby', gemfile: 'ruby', rake: 'ruby',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  scala: 'scala', clj: 'clojure', cljs: 'clojure', dart: 'dart', lua: 'lua',
  c: 'c', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  m: 'objective-c', mm: 'objective-c', cs: 'csharp', fs: 'fsharp', fsx: 'fsharp',
  php: 'php', pl: 'perl', pm: 'perl', r: 'r', jl: 'julia', ex: 'elixir', exs: 'elixir',
  erl: 'plaintext', hrl: 'plaintext', hs: 'plaintext', elm: 'plaintext',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell',
  ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  dockerfile: 'dockerfile', tf: 'hcl', hcl: 'hcl', sol: 'solidity', wgsl: 'wgsl',
  vb: 'vb', tex: 'plaintext', rst: 'restructuredtext', diff: 'plaintext', patch: 'plaintext',
};

/** Monaco language id for a worktree-relative path (matches on the base name so
 *  extensionless files like `Dockerfile`/`Makefile` still route). */
export function monacoLanguage(pathRel: string): string {
  const base = (pathRel.split('/').pop() ?? '').toLowerCase();
  if (/^dockerfile/.test(base)) return 'dockerfile';
  if (/^makefile/.test(base)) return 'plaintext';
  if (base === '.gitignore' || base === '.dockerignore' || base === '.npmignore') return 'plaintext';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return EXT_LANG[ext] ?? 'plaintext';
}

// ---------------- theme ----------------

let themeReady = false;

function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Append an 8-bit alpha to a `#rrggbb` token (Monaco theme colors take hex, not
 *  `rgba()`), so we can derive translucent selection/line-highlight fills from a
 *  solid brand token. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex || '#00000000';
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${m[1]}${a}`;
}

/**
 * (Re)define and apply the Maestro editor theme from the live Tailwind tokens.
 * Monaco needs concrete colors, not `var()`, and `getComputedStyle` only sees
 * the *current* theme — so this reads fresh values and redefines the matching
 * theme on every call (mount + theme change).
 */
export function applyEditorTheme(theme: 'dark' | 'light'): void {
  const bg = readVar('--bg') || (theme === 'dark' ? '#1a1918' : '#fafaf9');
  const surface = readVar('--surface') || bg;
  const raised = readVar('--raised') || surface;
  const text = readVar('--text') || (theme === 'dark' ? '#eae8e6' : '#1a1918');
  const muted = readVar('--muted') || '#6b6864';
  const faint = readVar('--faint') || '#a8a49e';
  const accent = readVar('--accent') || '#5344b0';
  const border = readVar('--border') || '#34322f';
  const name = theme === 'dark' ? 'maestro-dark' : 'maestro-light';

  monaco.editor.defineTheme(name, {
    base: theme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: faint.replace('#', '') },
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': text,
      'editorCursor.foreground': accent,
      'editor.selectionBackground': withAlpha(accent, 0.24),
      'editor.inactiveSelectionBackground': withAlpha(accent, 0.14),
      'editor.lineHighlightBackground': withAlpha(accent, 0.06),
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': muted,
      'editorGutter.background': bg,
      'editorIndentGuide.background1': withAlpha(border, 0.7),
      'editorIndentGuide.activeBackground1': border,
      'editorWhitespace.foreground': withAlpha(faint, 0.4),
      'editor.findMatchBackground': withAlpha(accent, 0.4),
      'editor.findMatchHighlightBackground': withAlpha(accent, 0.2),
      'editorBracketMatch.background': withAlpha(accent, 0.18),
      'editorBracketMatch.border': '#00000000',
      'editorWidget.background': surface,
      'editorWidget.border': border,
      'editorSuggestWidget.background': raised,
      'editorSuggestWidget.border': border,
      'editorSuggestWidget.selectedBackground': withAlpha(accent, 0.16),
      'editorHoverWidget.background': raised,
      'editorHoverWidget.border': border,
      'input.background': surface,
      'input.border': border,
      'focusBorder': withAlpha(accent, 0.5),
      'scrollbarSlider.background': withAlpha(muted, 0.2),
      'scrollbarSlider.hoverBackground': withAlpha(muted, 0.32),
      'scrollbarSlider.activeBackground': withAlpha(muted, 0.44),
    },
  });
  monaco.editor.setTheme(name);
  themeReady = true;
}

/** Ensure a theme exists before the first editor is created (avoids a flash of
 *  the stock vs-dark palette). */
export function ensureEditorTheme(theme: 'dark' | 'light'): string {
  if (!themeReady) applyEditorTheme(theme);
  return theme === 'dark' ? 'maestro-dark' : 'maestro-light';
}
