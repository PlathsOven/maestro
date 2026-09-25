// Source of landing/assets/glass.js (maestro-build.com). Rebuild after editing:
//   npm run build:landing-glass
import { computeGlassMaps, imageDataUrl, supportsRefraction } from '../src/shared/ui/liquidGlassMaps';

// Refract the backdrop of every [data-glass] element: an SVG displacement map
// (Snell's law over a squircle bezel) plus a specular rim, applied as a
// backdrop-filter. Chromium only; elsewhere the CSS frosted fallback stays.
// data-glass="radius bezel thickness strength blur" (px except strength 0..1).
const NS = 'http://www.w3.org/2000/svg';

function enhance(el: HTMLElement, host: SVGSVGElement, n: number) {
  const [radius = 24, bezel = 16, thickness = 60, strength = 0.55, blur = 3] = (el.dataset.glass || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  const back = document.createElement('span');
  back.className = 'glass-backdrop';
  back.setAttribute('aria-hidden', 'true');
  el.prepend(back);
  const id = `glass-${n}`;
  let last = '';
  const render = () => {
    const w = Math.round(el.offsetWidth);
    const h = Math.round(el.offsetHeight);
    if (w < 4 || h < 4) return;
    const dpr = w * h > 250_000 ? 1 : Math.min(2, window.devicePixelRatio || 1);
    const key = `${w}:${h}:${dpr}`;
    if (key === last) return;
    last = key;
    const m = computeGlassMaps({
      width: w,
      height: h,
      radius: Math.min(radius, h / 2, w / 2),
      bezelWidth: bezel,
      glassThickness: thickness,
      refractiveIndex: 1.45,
      scaleRatio: strength,
      dpr,
    });
    const old = host.querySelector(`#${id}`);
    if (old) old.remove();
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', id);
    for (const [k, v] of Object.entries({ x: '0', y: '0', width: String(w), height: String(h), filterUnits: 'userSpaceOnUse' }))
      f.setAttribute(k, v);
    f.innerHTML = `
      <feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="blurred"/>
      <feImage href="${imageDataUrl(m.displacement)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>
      <feDisplacementMap in="blurred" in2="map" scale="${m.scale}" xChannelSelector="R" yChannelSelector="G" result="bent"/>
      <feColorMatrix in="bent" type="saturate" values="1.6" result="vivid"/>
      <feImage href="${imageDataUrl(m.specular)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="rim"/>
      <feComponentTransfer in="rim" result="rimFaded"><feFuncA type="linear" slope="0.5"/></feComponentTransfer>
      <feBlend in="rimFaded" in2="vivid" mode="screen"/>`;
    host.querySelector('defs')!.appendChild(f);
    back.style.backdropFilter = back.style.webkitBackdropFilter = `url(#${id})`;
    el.classList.add('glass-live');
  };
  let t = 0;
  new ResizeObserver(() => {
    clearTimeout(t);
    t = window.setTimeout(render, 40);
  }).observe(el);
}

function init() {
  if (!supportsRefraction()) return;
  const els = document.querySelectorAll<HTMLElement>('[data-glass]');
  if (!els.length) return;
  const host = document.createElementNS(NS, 'svg');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('width', '0');
  host.setAttribute('height', '0');
  host.setAttribute('color-interpolation-filters', 'sRGB');
  host.style.position = 'absolute';
  host.appendChild(document.createElementNS(NS, 'defs'));
  document.body.appendChild(host);
  els.forEach((el, i) => enhance(el, host, i));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
