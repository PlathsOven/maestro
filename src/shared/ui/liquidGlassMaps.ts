/**
 * Liquid-glass refraction maps.
 *
 * Ported from mkj0kjay/vue-web-liquid-glass (MIT): src/lib/displacementMap.ts,
 * specular.ts and surfaceEquations.ts. A rounded rectangle of "glass" bends the
 * light behind it at its bezel (Snell's law over a convex squircle profile);
 * the maps drive an SVG feDisplacementMap used as a backdrop-filter. Consumed by
 * LiquidGlass.tsx, shared by the desktop renderer and Maestro Web.
 */

/** Height of the glass surface across the bezel, 0 (edge) to 1 (flat top). */
const CONVEX_SQUIRCLE = (x: number) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4);

/** Sideways travel of a vertical ray at each point across the bezel. */
function bezelDisplacement(
  glassThickness: number,
  bezelWidth: number,
  refractiveIndex: number,
  samples = 128
): number[] {
  const eta = 1 / refractiveIndex;
  return Array.from({ length: samples }, (_, i) => {
    const x = i / samples;
    const y = CONVEX_SQUIRCLE(x);
    const dx = x < 1 ? 0.0001 : -0.0001;
    const derivative = (CONVEX_SQUIRCLE(x + dx) - y) / dx;
    const magnitude = Math.sqrt(derivative * derivative + 1);
    const nx = -derivative / magnitude;
    const ny = -1 / magnitude;
    const k = 1 - eta * eta * (1 - ny * ny);
    if (k < 0) return 0; // total internal reflection
    const kSqrt = Math.sqrt(k);
    const rx = -(eta * ny + kSqrt) * nx;
    const ry = eta - (eta * ny + kSqrt) * ny;
    return rx * ((y * bezelWidth + glassThickness) / ry);
  });
}

type Corner = { x: number; y: number };

/** Offset from the nearest corner centre (0,0 when on a straight edge). */
function cornerOffset(x1: number, y1: number, w: number, h: number, r: number): Corner {
  const x = x1 < r ? x1 - r : x1 >= w - r ? x1 - (w - r) : 0;
  const y = y1 < r ? y1 - r : y1 >= h - r ? y1 - (h - r) : 0;
  return { x, y };
}

export type GlassMaps = {
  displacement: ImageData;
  specular: ImageData;
  /** feDisplacementMap scale that turns the map back into pixels. */
  scale: number;
};

export function computeGlassMaps(opts: {
  width: number;
  height: number;
  radius: number;
  bezelWidth: number;
  glassThickness: number;
  refractiveIndex: number;
  scaleRatio: number;
  dpr: number;
  specularAngle?: number;
}): GlassMaps {
  const { dpr } = opts;
  const w = Math.max(1, Math.floor(opts.width * dpr));
  const h = Math.max(1, Math.floor(opts.height * dpr));
  const r = Math.min(opts.radius * dpr, w / 2, h / 2);
  const bezel = Math.min(opts.bezelWidth * dpr, r || opts.bezelWidth * dpr);
  const profile = bezelDisplacement(opts.glassThickness, opts.bezelWidth, opts.refractiveIndex);
  const maxDisp = Math.max(...profile.map(Math.abs)) || 1;

  const displacement = new ImageData(w, h);
  new Uint32Array(displacement.data.buffer).fill(0xff008080); // neutral: no shift
  const specular = new ImageData(w, h);
  const angle = opts.specularAngle ?? Math.PI / 3;
  const sv = [Math.cos(angle), Math.sin(angle)] as const;

  const d = displacement.data;
  const s = specular.data;
  const rSq = r * r;
  const rPlusSq = (r + 1) ** 2;

  for (let y1 = 0; y1 < h; y1++) {
    // Rows away from the top/bottom bezels only touch the left/right edges.
    const rowNearEdge = y1 < bezel || y1 >= h - bezel || y1 < r || y1 >= h - r;
    for (let x1 = 0; x1 < w; x1++) {
      if (!rowNearEdge && x1 >= bezel && x1 < w - bezel) {
        // Jump to the right bezel. Bezels can be fractional (a 4.5px bezel,
        // or any bezel at 1.5× DPR); x1 must stay an integer or every write
        // on the right edge lands mid-pixel, corrupting the map there (a
        // black strip down the right side of small rounded-rect glass).
        x1 = Math.ceil(w - bezel) - 1;
        continue;
      }
      const { x, y } = cornerOffset(x1, y1, w, h, r);
      let dist: number; // distance inward from the edge
      let nx: number;
      let ny: number;
      let alpha = 1;
      if (x !== 0 && y !== 0) {
        const dc2 = x * x + y * y;
        if (dc2 > rPlusSq) continue;
        const dc = Math.sqrt(dc2);
        dist = r - dc;
        nx = x / dc;
        ny = y / dc;
        if (dc2 > rSq) alpha = 1 - (dc - r); // anti-alias the outer pixel
      } else if (x !== 0) {
        dist = x < 0 ? x1 : w - 1 - x1;
        nx = x < 0 ? -1 : 1;
        ny = 0;
      } else if (y !== 0) {
        dist = y < 0 ? y1 : h - 1 - y1;
        nx = 0;
        ny = y < 0 ? -1 : 1;
      } else {
        dist = Math.min(x1, y1, w - 1 - x1, h - 1 - y1);
        if (dist === x1) [nx, ny] = [-1, 0];
        else if (dist === w - 1 - x1) [nx, ny] = [1, 0];
        else if (dist === y1) [nx, ny] = [0, -1];
        else [nx, ny] = [0, 1];
      }
      if (dist > bezel || dist < -1) continue;
      const idx = (y1 * w + x1) * 4;

      const i = Math.min(profile.length - 1, Math.max(0, ((Math.max(0, dist) / bezel) * profile.length) | 0));
      const disp = (profile[i] ?? 0) / maxDisp;
      d[idx] = 128 - nx * disp * 127 * alpha;
      d[idx + 1] = 128 - ny * disp * 127 * alpha;
      d[idx + 2] = 0;
      d[idx + 3] = 255;

      // Specular rim: brightest where the edge faces the light, only on the outer pixel or two.
      const rim = Math.max(0, 1 - Math.max(0, dist) / (1.5 * dpr));
      if (rim > 0) {
        const facing = Math.abs(nx * sv[0] - ny * sv[1]);
        const c = 255 * facing * Math.sqrt(1 - (1 - rim) ** 2);
        s[idx] = s[idx + 1] = s[idx + 2] = c;
        s[idx + 3] = c * facing * alpha;
      }
    }
  }
  return { displacement, specular, scale: maxDisp * opts.scaleRatio };
}

export function imageDataUrl(image: ImageData): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** SVG filters in backdrop-filter only work in Chromium today (Electron
 *  included); Safari/iOS and Firefox fall back to the frosted blur. Reduced
 *  transparency also opts out. */
export function supportsRefraction(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  if (window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches) return false;
  return (
    ['Chrome/', 'Chromium/', 'Edg/'].some((s) => ua.includes(s)) &&
    !ua.includes('Firefox/') &&
    // iOS Chrome is WebKit underneath and says CriOS, not Chrome/.
    !/iPhone|iPad|iPod/.test(ua)
  );
}
