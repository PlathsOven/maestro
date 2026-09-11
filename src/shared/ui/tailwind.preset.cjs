/**
 * Shared Tailwind preset — colors, fonts, radii and the base fontSize ladder,
 * used by BOTH the Electron renderer (root tailwind.config.js) and Maestro Web
 * (web/tailwind.config.cjs). Moved out of the root config so the two apps share
 * one design system (web-desktop-parity spec §3.2, G2). The web extends the
 * fontSize ladder up one step for arm's-length density (see web config).
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        raised: 'var(--raised)',
        canvas: 'var(--canvas)',
        'user-msg': 'var(--user-msg)',
        border: 'var(--border)',
        fg: 'var(--text)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        'st-idle': 'var(--st-idle)',
        'st-running': 'var(--st-running)',
        'st-attention': 'var(--st-attention)',
        'st-review': 'var(--st-review)',
        'st-unread': 'var(--st-unread)',
        'st-merged': 'var(--st-merged)',
        'st-merged-soft': 'var(--st-merged-soft)',
        ok: 'var(--ok)',
        err: 'var(--err)',
        warn: 'var(--warn)',
        'diff-add': 'var(--diff-add)',
        'diff-del': 'var(--diff-del)',
        'diff-add-strong': 'var(--diff-add-strong)',
        'diff-del-strong': 'var(--diff-del-strong)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        card: '8px',
        ctl: '6px',
      },
      // Make Tailwind Preflight's universal border reset use the theme token
      // instead of its gray-200 default, so `border` utilities never fall back to
      // a pale outline in dark mode regardless of CSS import order.
      borderColor: {
        DEFAULT: 'var(--border)',
      },
      fontSize: {
        '2xs': ['11px', '15px'],
        // Named body token so `.md`/`.input`/`body` can shift up one step on the
        // phone via the web config override while staying 13px on the desktop.
        body: ['13px', '1.5'],
      },
    },
  },
  plugins: [],
};
