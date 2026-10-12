/**
 * Prints the smoke-mode --demo-script for the theme tour recording
 * (docs/images/themes.gif): every colour family in turn, crossfaded with a
 * view transition, with a small label pill naming each one. See
 * landing/README.md, "Regenerating the app screenshots".
 *
 *   node scripts/theme-tour.mjs [holdMs]   # END=<ms> on stderr = smoke delay
 */
const seq = [
  ['classic', 'light', 'Classic'], ['classic', 'dark', 'Classic'], ['catppuccin', 'dark', 'Catppuccin'],
  ['nord', 'light', 'Nord'], ['solarized', 'dark', 'Solarized'], ['gruvbox', 'light', 'Gruvbox'],
  ['rose-pine', 'dark', 'Rosé Pine'], ['tokyo-night', 'dark', 'Tokyo Night'], ['everforest', 'light', 'Everforest'],
  ['synthwave', 'dark', 'Synthwave'], ['phosphor', 'dark', 'Phosphor'], ['brutalist', 'light', 'Brutalist'],
  ['blueprint', 'dark', 'Blueprint'], ['bubblegum', 'light', 'Bubblegum'], ['classic', 'light', 'Classic'],
];
const HOLD = Number(process.argv[2] || 1500);
const START = 2500;

// The pill sits in the empty lower half of the right panel (CSS px of the
// 1500×940 smoke window). The first step also hides the demo cursor, which
// this recording has no use for.
const js = (id, mode, label) => `(() => {
  let p = document.getElementById('__tourPill');
  if (!p) {
    p = document.createElement('div');
    p.id = '__tourPill';
    p.style.cssText = 'position:fixed;left:1242px;bottom:90px;transform:translateX(-50%);z-index:2147483600;padding:7px 16px;border-radius:999px;font:500 13px/1.2 var(--font-sans,system-ui);background:var(--raised);color:var(--text);box-shadow:0 0 0 1px var(--border),0 8px 24px rgba(0,0,0,.18);pointer-events:none;letter-spacing:.01em;view-transition-name:tourpill';
    document.body.appendChild(p);
    document.querySelectorAll('body > div').forEach((d) => { if (d.style.zIndex === '2147483647') d.remove(); });
  }
  const go = () => {
    const h = document.documentElement;
    h.dataset.theme = '${id}';
    h.classList.toggle('dark', ${mode === 'dark'});
    p.textContent = '${label} · ${mode === 'dark' ? 'Dark' : 'Light'}';
  };
  document.startViewTransition ? document.startViewTransition(go) : go();
})()`;

const steps = seq.map(([id, mode, label], i) => `${START + i * HOLD}:js:${Buffer.from(js(id, mode, label)).toString('base64')}`);
console.log(steps.join(','));
console.error(`END=${START + seq.length * HOLD}`);
