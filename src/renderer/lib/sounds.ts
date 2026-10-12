// Completion sounds — short, soft sounds played when an agent finishes a chat.
//
// Every sound is synthesized on the fly with the Web Audio API rather than
// shipped as an audio file: it keeps the bundle tiny, works fully offline, and
// carries no licensing/attribution baggage.
//
// The aim is "real object, close mic": each sound is modelled on how the
// physical thing actually vibrates rather than on raw oscillators —
//   - struck objects (bells, bars, bowls, glass) use modal synthesis: a set of
//     sine partials at the object's (often inharmonic) mode ratios, each with
//     its own decay so the high modes die first, and near-degenerate modes
//     split into slowly beating pairs (the "shimmer" of a bowl or chime);
//   - plucked strings use Karplus–Strong, rendered sample-by-sample;
//   - every strike starts with a short filtered-noise contact (felt, wood,
//     fingertip) — most of what makes a sound read as real is in that attack;
//   - everything plays into a small generated room (convolution reverb) and a
//     gentle master chain that rounds off digital fizz.

type Ctx = BaseAudioContext;

/** Where a sound's voices go: a dry bus plus a send into the shared room. */
interface Stage {
  ctx: Ctx;
  dry: AudioNode;
  wet: AudioNode;
}

interface CompletionSoundDef {
  /** persisted id (GlobalSettings.completionSound) */
  id: string;
  label: string;
  /** dropdown <optgroup> bucket */
  group: string;
  /** seconds until the sound has fully rung out (before the room tail) */
  tail: number;
  /** output trim so every sound lands at a similar perceived loudness
   *  (measured offline; clicky, high sounds read louder per dB) */
  level: number;
  /** schedule the sound on `s`, starting at `t0` seconds */
  render: (s: Stage, t0: number) => void;
}

/** Fixed group order for the settings dropdown. */
export const SOUND_GROUP_ORDER = ['Bells', 'Mallets', 'Strings & keys', 'Nature'] as const;

// ---------- small helpers ----------

/** Random value in [lo, hi). */
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

/** A little human variation (± `amt` as a fraction) — no two strikes are identical. */
const vary = (v: number, amt = 0.06): number => v * (1 + rand(-amt, amt));

/** Per-context caches (noise source, room impulse response). */
const noiseCache = new WeakMap<Ctx, AudioBuffer>();
const roomCache = new WeakMap<Ctx, AudioBuffer>();

function noiseBuffer(ctx: Ctx): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

/**
 * A small, warm room: stereo decorrelated noise with an exponential decay,
 * lowpassed progressively harder as it decays (real rooms lose their highs
 * first), after a short pre-delay and a few early reflections.
 */
function roomImpulse(ctx: Ctx): AudioBuffer {
  let buf = roomCache.get(ctx);
  if (buf) return buf;
  const sr = ctx.sampleRate;
  const seconds = 2.4;
  const t60 = 1.7;
  const preDelay = 0.014;
  buf = ctx.createBuffer(2, Math.floor(sr * seconds), sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr - preDelay;
      if (t < 0) continue;
      const decay = Math.exp((-6.9 * t) / t60);
      const fadeIn = Math.min(1, t / 0.006);
      const a = 0.08 + 0.8 * Math.pow(1 - t / seconds, 2); // one-pole coefficient: bright → dark
      lp += a * (Math.random() * 2 - 1 - lp);
      d[i] = lp * decay * fadeIn;
    }
    // Sparse early reflections, different per ear.
    for (let k = 0; k < 6; k++) {
      const i = Math.floor(sr * (preDelay + rand(0.004, 0.045)));
      d[i] += rand(-0.6, 0.6) * (1 - k / 8);
    }
  }
  roomCache.set(ctx, buf);
  return buf;
}

/** A voice bus: panned, feeding the dry mix plus `send` of it into the room. */
function bus(s: Stage, pan = 0, send = 0.3): AudioNode {
  const p = s.ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(s.dry);
  const g = s.ctx.createGain();
  g.gain.value = send;
  p.connect(g);
  g.connect(s.wet);
  return p;
}

/** Linear attack to `peak`, then a natural exponential decay reaching −60 dB
 *  after `decay` seconds. */
function envelope(ctx: Ctx, out: AudioNode, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = 0; // not the default 1 — else a sample can leak through at `t`
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setTargetAtTime(0, t + attack, decay / 6.9);
  g.connect(out);
  return g;
}

/** One decaying sine partial. */
function partial(ctx: Ctx, out: AudioNode, freq: number, t: number, peak: number, decay: number, attack = 0.0015): void {
  if (freq >= ctx.sampleRate * 0.45 || peak <= 0) return;
  const o = ctx.createOscillator();
  o.frequency.value = freq;
  o.connect(envelope(ctx, out, t, peak, attack, decay));
  o.start(t);
  o.stop(t + attack + decay * 1.1);
}

/** A mode: [frequency ratio, relative amplitude, decay seconds, beat Hz?]. A
 *  beat splits the mode into two sines `beat` Hz apart — the slow pulsing of a
 *  real bell whose symmetry is ever so slightly off. */
type Mode = readonly [ratio: number, amp: number, decay: number, beat?: number];

/** Modal synthesis: sum the object's modes at `freq`. */
function strike(s: Stage, out: AudioNode, freq: number, t: number, gain: number, modes: readonly Mode[], attack = 0.0015): void {
  for (const [ratio, amp, decay, beat] of modes) {
    const f = freq * ratio;
    if (beat) {
      partial(s.ctx, out, f - beat / 2, t, gain * amp * 0.55, decay, attack);
      partial(s.ctx, out, f + beat / 2, t, gain * amp * 0.45, decay * 0.92, attack);
    } else {
      partial(s.ctx, out, f, t, gain * amp, decay, attack);
    }
  }
}

interface ContactOpts {
  /** filter type/centre shaping the noise: felt is low, glass/metal is high */
  type: BiquadFilterType;
  freq: number;
  q?: number;
  dur: number;
  gain: number;
  attack?: number;
}

/** The contact transient of a strike or pluck: a few ms of filtered noise. */
function contact(s: Stage, out: AudioNode, t: number, o: ContactOpts): void {
  const src = s.ctx.createBufferSource();
  src.buffer = noiseBuffer(s.ctx);
  const f = s.ctx.createBiquadFilter();
  f.type = o.type;
  f.frequency.value = o.freq;
  f.Q.value = o.q ?? 0.7;
  src.connect(f);
  f.connect(envelope(s.ctx, out, t, o.gain, o.attack ?? 0.0006, o.dur));
  const offset = rand(0, 1.5);
  src.start(t, offset);
  src.stop(t + o.dur * 1.2 + 0.01);
}

interface PluckOpts {
  /** seconds to −60 dB */
  decay: number;
  /** 0 = bright/twangy … 1 = dark/soft */
  softness: number;
  /** where along the string it's plucked (0–0.5); shapes the tone */
  pickPos?: number;
}

/**
 * A plucked string by Karplus–Strong, rendered into a buffer: a burst of
 * filtered noise circulating in a delay line one period long, with a gentle
 * lowpass in the loop so highs fade faster than the fundamental — exactly how a
 * real string loses energy.
 */
function pluckBuffer(ctx: Ctx, freq: number, o: PluckOpts): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * (o.decay + 0.05));
  const buf = ctx.createBuffer(1, len, sr);
  const y = buf.getChannelData(0);
  // Loop delay (fractional, via linear interpolation); the 2-tap loop filter
  // adds half a sample, so subtract it to stay in tune.
  const period = sr / freq - 0.5;
  const loss = Math.pow(0.001, 1 / (freq * o.decay));
  const damp = 0.5 * o.softness; // weight of the older tap in the loop filter
  // Excitation: one period of lowpassed noise, comb-filtered by pick position.
  const n = Math.max(2, Math.round(period));
  const exc = new Float32Array(n);
  let lp = 0;
  const excA = 0.9 - 0.75 * o.softness;
  for (let i = 0; i < n; i++) {
    lp += excA * (Math.random() * 2 - 1 - lp);
    exc[i] = lp;
  }
  const pick = Math.floor(n * (o.pickPos ?? 0.18));
  let mean = 0;
  for (let i = 0; i < n; i++) mean += exc[i] - (i >= pick ? exc[i - pick] : 0);
  mean /= n;
  const read = (idx: number): number => {
    if (idx < 0) return 0;
    const i0 = Math.floor(idx);
    const fr = idx - i0;
    return y[i0] * (1 - fr) + (y[i0 + 1] ?? 0) * fr;
  };
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const a = read(i - period);
    const b = read(i - period - 1);
    let v = loss * ((1 - damp) * a + damp * b);
    if (i < n) v += exc[i] - (i >= pick ? exc[i - pick] : 0) - mean;
    y[i] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  if (peak > 0) for (let i = 0; i < len; i++) y[i] /= peak;
  return buf;
}

function pluck(s: Stage, out: AudioNode, freq: number, t: number, gain: number, o: PluckOpts): void {
  const src = s.ctx.createBufferSource();
  src.buffer = pluckBuffer(s.ctx, freq, o);
  const g = s.ctx.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.0015); // fingertip, not a hard edge
  src.connect(g);
  g.connect(out);
  src.start(t);
}

// ---------- instrument models ----------

/** Tuned chime bar (free–free bar mode ratios). */
const CHIME_MODES: readonly Mode[] = [
  [1, 1, 2.1, 0.55],
  [2.756, 0.2, 0.7],
  [5.404, 0.06, 0.24],
  [8.933, 0.02, 0.09],
];

/** Kalimba / music-box tine (clamped–free bar). */
const TINE_MODES: readonly Mode[] = [
  [1, 1, 1.3],
  [6.267, 0.1, 0.16],
  [17.55, 0.018, 0.05],
];

/** Marimba bar, undercut to ~1 : 4 : 10. */
const MARIMBA_MODES: readonly Mode[] = [
  [1, 1, 0.85],
  [3.93, 0.2, 0.2],
  [9.24, 0.045, 0.06],
];

/** Felt-hammer piano note: harmonic partials with slight string inharmonicity,
 *  two detuned unison strings per partial, highs rolled off by the felt and
 *  decaying faster. */
function feltPiano(s: Stage, out: AudioNode, f: number, t: number, gain: number): void {
  const B = 0.00035;
  const baseDecay = 2.6 * Math.pow(440 / f, 0.35);
  for (let n = 1; n <= 10; n++) {
    const fn = n * f * Math.sqrt(1 + B * n * n);
    const amp = Math.pow(n, -1.3) * Math.exp((-(n - 1) * f) / 1800);
    const decay = baseDecay / (1 + 0.45 * (n - 1));
    strike(s, out, fn, t, gain * amp, [[1, 1, decay, fn * 0.0011]], 0.003);
  }
  contact(s, out, t, { type: 'lowpass', freq: 320, dur: 0.06, gain: gain * 0.35, attack: 0.002 });
  contact(s, out, t, { type: 'bandpass', freq: 1400, q: 1, dur: 0.012, gain: gain * 0.05 });
}

// ---------- the library ----------

export const COMPLETION_SOUNDS: CompletionSoundDef[] = [
  // --- Bells ---
  {
    id: 'chime',
    label: 'Chime',
    group: 'Bells',
    tail: 2.4,
    level: 0.84,
    render: (s, t0) => {
      // Two tuned chime bars, a rising fifth (A5 → E6), tapped with a soft mallet.
      const notes: [number, number, number, number][] = [
        [880, 0, 0.36, -0.18],
        [1318.51, 0.14, 0.3, 0.18],
      ];
      for (const [f, dt, g, pan] of notes) {
        const b = bus(s, pan, 0.32);
        const t = t0 + dt;
        strike(s, b, f, t, vary(g), CHIME_MODES);
        contact(s, b, t, { type: 'bandpass', freq: 3200, q: 0.8, dur: 0.01, gain: g * 0.12 });
      }
    },
  },
  {
    id: 'glass',
    label: 'Glass clink',
    group: 'Bells',
    tail: 1.6,
    level: 1.16,
    render: (s, t0) => {
      // Two crystal glasses touched together — one contact, both ring.
      const modes: Mode[] = [
        [1, 1, 1.4, 0.9],
        [2.32, 0.32, 0.55],
        [4.25, 0.12, 0.22],
        [6.63, 0.05, 0.1],
      ];
      strike(s, bus(s, -0.22, 0.38), 1244.5, t0, vary(0.3), modes, 0.001);
      strike(s, bus(s, 0.22, 0.38), 1661.2, t0 + 0.004, vary(0.2), modes, 0.001);
      contact(s, bus(s, 0, 0.3), t0, { type: 'highpass', freq: 5500, dur: 0.005, gain: 0.07 });
    },
  },
  {
    id: 'triangle',
    label: 'Triangle',
    group: 'Bells',
    tail: 2.8,
    level: 2.2,
    render: (s, t0) => {
      // A small orchestral triangle, lightly tapped: a dense cluster of
      // inharmonic modes that shimmer against each other as they fade.
      const b = bus(s, 0.1, 0.3);
      const modes: Mode[] = [
        [1, 0.3, 2.6],
        [2.02, 0.45, 2.3, 1.7],
        [2.99, 0.36, 1.9],
        [3.98, 0.28, 1.6, 2.3],
        [5.03, 0.2, 1.2],
        [6.11, 0.13, 0.9, 3.1],
        [7.25, 0.08, 0.7],
      ];
      strike(s, b, 1046.5, t0, vary(0.16), modes, 0.001);
      contact(s, b, t0, { type: 'highpass', freq: 6500, dur: 0.004, gain: 0.05 });
    },
  },
  {
    id: 'singing-bowl',
    label: 'Singing bowl',
    group: 'Bells',
    tail: 4,
    level: 1.2,
    render: (s, t0) => {
      // A bronze singing bowl struck on the rim with a felt mallet. Each mode
      // is a beating doublet — the slow "wah-wah" pulse is the bowl's character.
      const b = bus(s, 0, 0.42);
      const modes: Mode[] = [
        [1, 1, 4, 0.8],
        [2.71, 0.62, 3, 1.5],
        [5.13, 0.26, 1.7, 2.1],
        [8.28, 0.09, 0.8],
        [12.1, 0.03, 0.35],
      ];
      strike(s, b, 311.13, t0, vary(0.26), modes, 0.004);
      contact(s, b, t0, { type: 'lowpass', freq: 900, dur: 0.035, gain: 0.08, attack: 0.002 });
    },
  },

  // --- Mallets ---
  {
    id: 'kalimba',
    label: 'Kalimba',
    group: 'Mallets',
    tail: 1.6,
    level: 0.88,
    render: (s, t0) => {
      // Thumb-plucked tines, a rising D-major arpeggio.
      const notes: [number, number, number][] = [
        [587.33, 0, -0.25],
        [739.99, 0.1, 0],
        [880, 0.2, 0.25],
      ];
      notes.forEach(([f, dt, pan], i) => {
        const b = bus(s, pan, 0.28);
        const t = t0 + dt + rand(-0.006, 0.006);
        strike(s, b, f, t, vary(i === 2 ? 0.34 : 0.28), TINE_MODES, 0.002);
        contact(s, b, t, { type: 'lowpass', freq: 1400, dur: 0.018, gain: 0.07 });
      });
    },
  },
  {
    id: 'marimba',
    label: 'Marimba',
    group: 'Mallets',
    tail: 1.2,
    level: 0.95,
    render: (s, t0) => {
      // Rosewood bars with soft yarn mallets: G4 → D5.
      const notes: [number, number, number, number][] = [
        [392, 0, 0.42, -0.2],
        [587.33, 0.12, 0.36, 0.2],
      ];
      for (const [f, dt, g, pan] of notes) {
        const b = bus(s, pan, 0.25);
        const t = t0 + dt;
        strike(s, b, f, t, vary(g), MARIMBA_MODES, 0.004);
        contact(s, b, t, { type: 'lowpass', freq: 700, dur: 0.025, gain: g * 0.25, attack: 0.002 });
      }
    },
  },
  {
    id: 'tongue-drum',
    label: 'Tongue drum',
    group: 'Mallets',
    tail: 2.4,
    level: 0.72,
    render: (s, t0) => {
      // A steel tongue drum: round, warm fundamentals with an octave overtone.
      const modes: Mode[] = [
        [1, 1, 2.3],
        [2.0, 0.22, 1.1, 0.7],
        [3.01, 0.07, 0.45],
        [4.53, 0.025, 0.2],
      ];
      const notes: [number, number, number, number][] = [
        [293.66, 0, 0.46, -0.15],
        [440, 0.16, 0.36, 0.15],
      ];
      for (const [f, dt, g, pan] of notes) {
        const b = bus(s, pan, 0.33);
        const t = t0 + dt;
        strike(s, b, f, t, vary(g), modes, 0.006);
        contact(s, b, t, { type: 'lowpass', freq: 500, dur: 0.035, gain: g * 0.22, attack: 0.002 });
      }
    },
  },
  {
    id: 'music-box',
    label: 'Music box',
    group: 'Mallets',
    tail: 1.8,
    level: 1,
    render: (s, t0) => {
      // Steel comb teeth plucked by the cylinder's pins: G5 · C6 · E6.
      const notes: [number, number][] = [
        [783.99, 0],
        [1046.5, 0.17],
        [1318.51, 0.35],
      ];
      notes.forEach(([f, dt], i) => {
        const b = bus(s, -0.2 + i * 0.2, 0.36);
        const t = t0 + dt + rand(-0.008, 0.008);
        strike(s, b, f, t, vary(0.22), TINE_MODES, 0.001);
        contact(s, b, t, { type: 'highpass', freq: 3500, dur: 0.004, gain: 0.03 });
      });
    },
  },

  // --- Strings & keys ---
  {
    id: 'piano',
    label: 'Felt piano',
    group: 'Strings & keys',
    tail: 2.8,
    level: 1.08,
    render: (s, t0) => {
      // A felted upright, played softly: a low G under a rolled G4 · D5.
      feltPiano(s, bus(s, -0.2, 0.3), 196, t0, vary(0.13));
      feltPiano(s, bus(s, -0.05, 0.3), 392, t0 + 0.012, vary(0.2));
      feltPiano(s, bus(s, 0.15, 0.3), 587.33, t0 + 0.11, vary(0.17));
    },
  },
  {
    id: 'harp',
    label: 'Harp',
    group: 'Strings & keys',
    tail: 2,
    level: 1.8,
    render: (s, t0) => {
      // A short fingered run up a pentatonic scale, sweeping left to right.
      const run = [587.33, 659.25, 783.99, 880, 1174.66];
      run.forEach((f, i) => {
        const t = t0 + i * 0.058 + rand(-0.005, 0.005);
        pluck(s, bus(s, -0.45 + i * 0.22, 0.38), f, t, vary(i === run.length - 1 ? 0.3 : 0.24), {
          decay: 1.8,
          softness: 0.55,
          pickPos: 0.3,
        });
      });
    },
  },
  {
    id: 'pizzicato',
    label: 'Pizzicato',
    group: 'Strings & keys',
    tail: 0.8,
    level: 1.9,
    render: (s, t0) => {
      // Plucked cello strings (D3 · A3) through a warm wooden body resonance.
      const body = s.ctx.createBiquadFilter();
      body.type = 'peaking';
      body.frequency.value = 240;
      body.Q.value = 1.2;
      body.gain.value = 5;
      body.connect(bus(s, 0, 0.3));
      pluck(s, body, 146.83, t0, vary(0.4), { decay: 0.6, softness: 0.85, pickPos: 0.12 });
      pluck(s, body, 220, t0 + 0.13, vary(0.34), { decay: 0.55, softness: 0.85, pickPos: 0.12 });
    },
  },

  // --- Nature ---
  {
    id: 'droplet',
    label: 'Water drops',
    group: 'Nature',
    tail: 0.6,
    level: 1.6,
    render: (s, t0) => {
      // Two drops falling into still water. The "plip" is the bubble the drop
      // traps under the surface, whose pitch rises as it's pushed up and out.
      const drops: [number, number, number, number][] = [
        [880, 0, 0.5, -0.2],
        [1320, 0.19, 0.34, 0.25],
      ];
      for (const [f, dt, g, pan] of drops) {
        const b = bus(s, pan, 0.38);
        const t = t0 + dt;
        const o = s.ctx.createOscillator();
        o.frequency.setValueAtTime(f, t);
        o.frequency.exponentialRampToValueAtTime(f * 2.3, t + 0.06);
        o.connect(envelope(s.ctx, b, t, vary(g), 0.002, 0.13));
        o.start(t);
        o.stop(t + 0.2);
        contact(s, b, t, { type: 'highpass', freq: 4500, dur: 0.008, gain: g * 0.08 });
      }
    },
  },
  {
    id: 'stones',
    label: 'River stones',
    group: 'Nature',
    tail: 0.4,
    level: 1.9,
    render: (s, t0) => {
      // Two smooth stones knocked together, twice — a soft "tok · tok".
      const modes: Mode[] = [
        [1, 1, 0.045],
        [1.61, 0.5, 0.03],
        [2.47, 0.28, 0.02],
      ];
      const knocks: [number, number, number, number][] = [
        [2350, 0, 0.36, -0.1],
        [2200, 0.13, 0.26, 0.1],
      ];
      for (const [f, dt, g, pan] of knocks) {
        const b = bus(s, pan, 0.35);
        const t = t0 + dt;
        strike(s, b, vary(f, 0.02), t, vary(g), modes, 0.0005);
        contact(s, b, t, { type: 'bandpass', freq: 3200, q: 1.4, dur: 0.012, gain: g * 0.6 });
      }
    },
  },
  {
    id: 'rainstick',
    label: 'Rainstick',
    group: 'Nature',
    tail: 1.3,
    level: 3.9,
    render: (s, t0) => {
      // Seeds tumbling past pins inside a cactus tube: a swell of tiny clicks,
      // some of which ring briefly, thinning out as the last seeds settle.
      const dur = 1.1;
      const grains = 110;
      const buses = [-0.5, -0.15, 0.15, 0.5].map((p) => bus(s, p, 0.4));
      for (let i = 0; i < grains; i++) {
        const x = Math.pow(Math.random(), 1.5); // denser early on
        const t = t0 + 0.02 + x * dur;
        const level = Math.sin(Math.min(1, x * 6) * (Math.PI / 2)) * Math.pow(1 - x, 1.3); // quick swell, long fade
        const out = buses[Math.floor(Math.random() * buses.length)];
        contact(s, out, t, { type: 'bandpass', freq: rand(2500, 7500), q: rand(3, 9), dur: rand(0.004, 0.012), gain: 0.5 * level });
        if (Math.random() < 0.3) partial(s.ctx, out, rand(3000, 6000), t, 0.03 * level, rand(0.02, 0.05), 0.0005);
      }
    },
  },
];

/**
 * The question alert — played when an agent blocks on a maestro-ask question.
 * Deliberately NOT one of the completion sounds (and not user-pickable from that
 * list): "your agent is waiting on you" must never be mistaken for "done". It's
 * a bright glass-chime figure that rises like a spoken question — a quick
 * upward fourth, answered by a higher one — played twice so it cuts through
 * whatever the user is doing without being harsh.
 */
const QUESTION_SOUND: CompletionSoundDef = {
  id: 'question',
  label: 'Question',
  group: 'Alerts',
  tail: 1.9,
  level: 1.2, // a notch over the completion sounds — its job is to interrupt
  render: (s, t0) => {
    const GLASS: readonly Mode[] = [
      [1, 1, 0.9, 0.7],
      [2.756, 0.22, 0.35],
      [5.404, 0.07, 0.12],
    ];
    const tap = (f: number, t: number, g: number, pan: number) => {
      const out = bus(s, pan, 0.28);
      contact(s, out, t, { type: 'highpass', freq: 3200, dur: 0.006, gain: g * 0.18 });
      strike(s, out, vary(f, 0.003), t, g, GLASS);
    };
    // E5 → A5, then B5 → E6: the second pair lifts the phrase into a question.
    for (const [dt, f, g, pan] of [
      [0, 659.3, 0.24, -0.18],
      [0.12, 880, 0.3, 0.12],
      [0.46, 987.8, 0.22, -0.1],
      [0.58, 1318.5, 0.3, 0.18],
    ] as const) {
      tap(f, t0 + dt, g, pan);
    }
  },
};

/** Ids retired in the sound refresh, mapped to their closest successor so a
 *  saved pick keeps playing something in the same spirit. */
const LEGACY_IDS: Record<string, string> = {
  cymbal: 'rainstick',
  timpani: 'tongue-drum',
  celesta: 'music-box',
  'orchestra-hit': 'piano',
  fanfare: 'harp',
};

const SOUND_BY_ID: Record<string, CompletionSoundDef> = Object.fromEntries(COMPLETION_SOUNDS.map((s) => [s.id, s]));

/** The live id for a (possibly retired) persisted id. */
export function resolveSoundId(id: string): string {
  return LEGACY_IDS[id] ?? id;
}

// ---------- playback ----------

/**
 * Build the master chain on `ctx` into `dest` and schedule sound `id` at `t0`.
 * Chain: dry + room → gentle high-shelf cut (takes the digital edge off) → soft
 * compressor (keeps dense voicings from clipping) → output. Returns the seconds
 * until everything has rung out and a teardown for the per-play nodes. Also
 * used to render sounds offline (OfflineAudioContext) for level checks.
 */
export function scheduleCompletionSound(ctx: Ctx, dest: AudioNode, id: string, t0: number): { length: number; dispose: () => void } | null {
  const def = SOUND_BY_ID[resolveSoundId(id)];
  return def ? scheduleSound(ctx, dest, def, t0) : null;
}

function scheduleSound(ctx: Ctx, dest: AudioNode, def: CompletionSoundDef, t0: number): { length: number; dispose: () => void } {
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const room = ctx.createConvolver();
  room.buffer = roomImpulse(ctx);
  wet.connect(room);
  const shelf = ctx.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 7000;
  shelf.gain.value = -4;
  dry.connect(shelf);
  room.connect(shelf);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 12;
  comp.ratio.value = 3;
  comp.attack.value = 0.002;
  comp.release.value = 0.2;
  const master = ctx.createGain();
  master.gain.value = 0.85 * def.level;
  shelf.connect(comp);
  comp.connect(master);
  master.connect(dest);

  try {
    def.render({ ctx, dry, wet }, t0);
  } catch {
    /* ignore synthesis failures — a missed chime is harmless */
  }
  return {
    length: def.tail + 2.4,
    dispose: () => {
      for (const n of [dry, wet, room, shelf, comp, master]) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
    },
  };
}

let audioCtx: AudioContext | null = null;

/** The one shared AudioContext, created lazily. Returns null when Web Audio is
 *  unavailable. Creation is cheap; unlocking (resume) is the gesture-gated part. */
function getCtx(): AudioContext | null {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/**
 * Browsers start an AudioContext "suspended" until a user gesture. A completion
 * chime fires from a background event (an agent finished) — never a gesture — so
 * the context must already be unlocked by then, or it plays nothing. Resume it on
 * the first pointer/key/touch interaction anywhere in the app; after that it stays
 * running and later chimes are instant.
 */
if (typeof window !== 'undefined') {
  const unlock = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  }
}

/** Schedule the sound on the live context. Reads currentTime only when the
 *  context is actually running — scheduling near t=0 on a just-resumed context
 *  silently drops the sound. */
function emit(ctx: AudioContext, def: CompletionSoundDef): void {
  const played = scheduleSound(ctx, ctx.destination, def, ctx.currentTime + 0.03);
  window.setTimeout(played.dispose, played.length * 1000 + 200);
}

/** Play `def` now, resuming a suspended context first (never throws). */
function play(def: CompletionSoundDef): void {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === 'running') emit(ctx, def);
  else void ctx.resume().then(() => emit(ctx, def)).catch(() => {});
}

/**
 * Play a completion sound by id. No-ops for 'none'/unknown ids or when audio is
 * unavailable — it never throws, so callers can fire it blindly from an event
 * handler. If the context is still suspended, it resumes first and plays once
 * that resolves (rather than scheduling into a stopped clock and losing the sound).
 */
export function playCompletionSound(id: string | undefined): void {
  const def = id && id !== 'none' ? SOUND_BY_ID[resolveSoundId(id)] : undefined;
  if (def) play(def);
}

let lastQuestionAt = 0;

/** Play the question alert (an agent is blocked asking the user something).
 *  Several asks landing together — parallel agents, or a multi-question burst —
 *  ring once rather than stacking into a clatter. */
export function playQuestionSound(): void {
  const now = Date.now();
  if (now - lastQuestionAt < 1500) return;
  lastQuestionAt = now;
  play(QUESTION_SOUND);
}
