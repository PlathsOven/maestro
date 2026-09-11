import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import katex from 'katex';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

marked.setOptions({ gfm: true, breaks: true });
// LaTeX math via KaTeX. `$…$` / `$$…$$` use the extension's strict rule (the
// closing `$` must be followed by whitespace/punctuation) — `nonStandard: true`
// paired currency amounts, mangling "with $81 collateral … at $200" into math.
// `output: 'html'` skips MathML so the result is just spans/svg that survive
// DOMPurify; `throwOnError: false` shows bad LaTeX as source instead of blowing
// up the render.
const KATEX_OPTS = { throwOnError: false, output: 'html' as const };
marked.use(markedKatex(KATEX_OPTS));

// The extension only understands dollar delimiters, so `\(…\)` and `\[…\]` —
// the unambiguous forms LLMs favor — get their own tokenizers. Content allows
// any escape (`\\.`) so e.g. `\frac` doesn't end the match early; non-greedy
// stops at the first real closer.
function texDelimiter(name: string, open: string, close: string, displayMode: boolean) {
  const rule = new RegExp(`^\\\\\\${open}((?:\\\\.|[^\\\\])+?)\\\\\\${close}`);
  return {
    name,
    level: 'inline' as const,
    start: (src: string) => src.indexOf('\\' + open),
    tokenizer(src: string) {
      const match = rule.exec(src);
      if (match) return { type: name, raw: match[0], text: match[1].trim(), displayMode };
    },
    renderer: (token: { text: string; displayMode: boolean }) =>
      katex.renderToString(token.text, { ...KATEX_OPTS, displayMode: token.displayMode }),
  };
}
marked.use({
  extensions: [texDelimiter('texParen', '(', ')', false), texDelimiter('texBracket', '[', ']', true)],
});

// Agents answer with worktree paths — `![shot](.context/preview/shot-1.png)` —
// which can't load from the renderer's origin, so a `src` here would buy only a
// failed request and a broken-image flash. Emit the image inert instead, with
// the path stashed: `useWorktreeImages` (lib/worktreeImages.ts) reads the file
// over IPC and fills in a `data:` URL wherever the HTML is mounted. Where
// nothing hydrates it (the editor's own markdown preview) the element falls back
// to its alt text. Remote and inline sources load on their own, so they stay
// marked's business.
marked.use({
  renderer: {
    image({ href, text, title }) {
      if (/^(?:https?|data|blob):/i.test(href.trim())) return false;
      return (
        `<img data-ws-src="${escapeAttr(href)}" alt="${escapeAttr(text)}"` +
        (title ? ` title="${escapeAttr(title)}"` : '') +
        '>'
      );
    },
  },
});

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const COPY_BTN =
  '<button type="button" class="code-copy" data-copy aria-label="Copy code" title="Copy code">' +
  `<span class="ico-copy">${COPY_ICON}</span><span class="ico-check">${CHECK_ICON}</span></button>`;

/**
 * Wrap each fenced code block in a positioned container with a copy button.
 * Runs after sanitize (the button markup is ours, not user input), and only
 * targets block-level <pre> — inline `code` is left alone.
 */
function withCodeCopyButtons(html: string): string {
  return html
    .replace(/<pre(\b[^>]*)?>/g, (_m, attrs) => `<div class="code-block">${COPY_BTN}<pre${attrs ?? ''}>`)
    .replace(/<\/pre>/g, '</pre></div>');
}

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return withCodeCopyButtons(DOMPurify.sanitize(html));
}

/**
 * Resolve a markdown link's href to a worktree-relative path, or null when it
 * isn't a file inside the given worktree (external URL, anchor, or a path that
 * escapes the tree). Agents commonly link files as relative paths, absolute
 * paths, or `file://` URLs — a click on any of these would otherwise navigate
 * the whole renderer to a `file://` page and blank the app, so we route the
 * ones we can locate to the in-app editor instead. A trailing `:line[:col]`
 * (e.g. `src/foo.ts:42`) is stripped since the editor opens whole files.
 */
export function resolveFileHref(rawHref: string, worktreePath: string): string | null {
  let href = rawHref.trim();
  if (!href) return null;
  // External schemes and in-page anchors are not workspace files.
  if (/^(?:https?|mailto|tel|data|blob|javascript|vscode):/i.test(href)) return null;
  if (href.startsWith('#') || href.startsWith('?')) return null;

  if (href.startsWith('file://')) {
    href = href.slice('file://'.length);
    // file:///C:/… on Windows carries a leading slash before the drive letter.
    if (/^\/[a-zA-Z]:/.test(href)) href = href.slice(1);
  }
  try {
    href = decodeURI(href);
  } catch {
    /* keep the raw form if it isn't valid percent-encoding */
  }

  const norm = href.replace(/\\/g, '/');
  const root = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const isAbsolute = norm.startsWith('/') || /^[a-zA-Z]:\//.test(norm);

  let rel: string;
  if (isAbsolute) {
    // Match the worktree root case-insensitively (Windows paths, `C:` vs `c:`).
    const prefix = root + '/';
    if (norm.toLowerCase().startsWith(prefix.toLowerCase())) {
      rel = norm.slice(prefix.length);
    } else {
      return null; // absolute path outside this worktree
    }
  } else {
    rel = norm.replace(/^\.\//, '');
  }

  rel = rel.replace(/:\d+(?::\d+)?$/, ''); // drop trailing :line[:col]
  if (!rel || rel.startsWith('..')) return null;
  return rel;
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  cjs: 'javascript', json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'xml',
  xml: 'xml', svg: 'xml', md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', sql: 'sql', dockerfile: 'dockerfile', graphql: 'graphql',
};

export function langForPath(path: string): string | null {
  const base = path.split('/').pop() ?? '';
  if (/^dockerfile/i.test(base)) return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return EXT_LANG[ext] ?? null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightLine(text: string, lang: string | null): string {
  if (!lang || text.length > 1000) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Strip ANSI escape sequences (SGR colors, cursor moves) + carriage returns —
// Jupyter tracebacks and stream output arrive colorized; we render them plain.
// Assembled from char codes so this file carries no raw ESC/CSI control bytes,
// and it consumes the intro byte too (the old pattern left it as a stray glyph).
// Introducer is ESC+'[' (or the single CSI byte 0x9b); '[[]' is a char class
// matching a literal '[', which keeps this file free of backslash escapes.
const ANSI_RE = new RegExp(
  '(?:' + String.fromCharCode(0x1b) + '[[]|' + String.fromCharCode(0x9b) + ')[0-9;?]*[ -/]*[@-~]|' + String.fromCharCode(13),
  'g'
);
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

/** Compact line-diff count for tight rows: 1234 → "1.2k". */
export function fmtStat(n: number): string {
  if (n >= 1000) {
    const k = (n / 1000).toFixed(1).replace(/\.0$/, '');
    return `${k}k`;
  }
  return String(n);
}
