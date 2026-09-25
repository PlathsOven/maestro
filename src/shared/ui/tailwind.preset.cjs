/**
 * Shared Tailwind preset — colors, fonts, radii and the base fontSize ladder,
 * used by BOTH the Electron renderer (root tailwind.config.js) and Maestro Web
 * (web/tailwind.config.cjs). Moved out of the root config so the two apps share
 * one design system (web-desktop-parity spec §3.2, G2). The web extends the
 * fontSize ladder up one step for arm's-length density (see web config).
 *
 * @type {import('tailwindcss').Config}
 */
// Colours are CSS variables (theme.css) so light/dark swap at runtime. Wrapping
// each in color-mix with Tailwind's <alpha-value> placeholder makes opacity
// modifiers work on them (`bg-warn/10`, `border-accent/40`) — a bare
// `var(--x)` silently drops the modifier and emits no rule at all.
const c = (v) => `color-mix(in srgb, var(${v}) calc(<alpha-value> * 100%), transparent)`;

module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: c('--bg'),
        surface: c('--surface'),
        raised: c('--raised'),
        canvas: c('--canvas'),
        'user-msg': c('--user-msg'),
        border: c('--border'),
        fg: c('--text'),
        muted: c('--muted'),
        faint: c('--faint'),
        accent: c('--accent'),
        'accent-soft': c('--accent-soft'),
        'accent-tint': c('--accent-tint'),
        ink: c('--ink'),
        'on-ink': c('--on-ink'),
        'st-idle': c('--st-idle'),
        'st-running': c('--st-running'),
        'st-attention': c('--st-attention'),
        'st-review': c('--st-review'),
        'st-unread': c('--st-unread'),
        'st-merged': c('--st-merged'),
        'st-merged-soft': c('--st-merged-soft'),
        ok: c('--ok'),
        err: c('--err'),
        warn: c('--warn'),
        'diff-add': c('--diff-add'),
        'diff-del': c('--diff-del'),
        'diff-add-strong': c('--diff-add-strong'),
        'diff-del-strong': c('--diff-del-strong'),
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        // Softer, Lovable-style geometry: cards/panels 14px, controls 10px;
        // buttons are full pills (`.btn`).
        card: '14px',
        ctl: '10px',
      },
      // Make Tailwind Preflight's universal border reset use the theme token
      // instead of its gray-200 default, so `border` utilities never fall back to
      // a pale outline in dark mode regardless of CSS import order.
      borderColor: {
        DEFAULT: 'var(--border)',
      },
      // Tailwind's `transition*` utilities glide on the same curve as the rest of
      // the motion system (theme.css "Motion", after the reference glass UI).
      transitionTimingFunction: {
        DEFAULT: 'var(--ease-glass)',
      },
      transitionDuration: {
        DEFAULT: '180ms',
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
