// Completion sounds — short chimes played when an agent finishes a chat.
//
// Every sound is synthesized on the fly with the Web Audio API rather than
// shipped as an audio file: it keeps the bundle tiny, works fully offline, and
// carries no licensing/attribution baggage. The palette is themed around
// Maestro's orchestra motif — triangle, cymbals, timpani, pizzicato strings,
// harp, piano, celesta, brass — so the app that conducts your agents sounds
// the part.

interface CompletionSoundDef {
  /** persisted id (GlobalSettings.completionSound) */
  id: string;
  label: string;
  /** dropdown <optgroup> bucket */
  group: string;
  /** schedule the sound on `ctx`, routed to `out`, starting at `t0` seconds */
  render: (ctx: AudioContext, out: AudioNode, t0: number) => void;
}

/** Fixed group order for the settings dropdown. */
export const SOUND_GROUP_ORDER = ['Classic', 'Percussion', 'Strings', 'Keys', 'Brass'] as const;

// ---------- synthesis primitives ----------

/** An exponential attack→decay envelope gain node (exp ramps can't hit 0, so a
 *  tiny floor stands in for silence). */
function envGain(ctx: AudioContext, out: AudioNode, t0: number, peak: number, dur: number, attack = 0.005): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  g.connect(out);
  return g;
}

interface ToneOpts {
  type: OscillatorType;
  freq: number;
  t0: number;
  dur: number;
  gain: number;
  attack?: number;
  detune?: number;
}

/** One enveloped oscillator voice. */
function tone(ctx: AudioContext, out: AudioNode, o: ToneOpts): void {
  const osc = ctx.createOscillator();
  osc.type = o.type;
  osc.frequency.value = o.freq;
  if (o.detune) osc.detune.value = o.detune;
  osc.connect(envGain(ctx, out, o.t0, o.gain, o.dur, o.attack ?? 0.005));
  osc.start(o.t0);
  osc.stop(o.t0 + o.dur + 0.05);
}

interface NoiseOpts {
  t0: number;
  dur: number;
  gain: number;
  filter?: BiquadFilterType;
  freq?: number;
  q?: number;
}

/** A burst of (optionally filtered) white noise — the basis for cymbals and hit
 *  transients. */
function noiseHit(ctx: AudioContext, out: AudioNode, o: NoiseOpts): void {
  const len = Math.ceil(ctx.sampleRate * (o.dur + 0.05));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  let node: AudioNode = src;
  if (o.filter) {
    const f = ctx.createBiquadFilter();
    f.type = o.filter;
    f.frequency.value = o.freq ?? 6000;
    if (o.q != null) f.Q.value = o.q;
    src.connect(f);
    node = f;
  }
  node.connect(envGain(ctx, out, o.t0, o.gain, o.dur, 0.001));
  src.start(o.t0);
  src.stop(o.t0 + o.dur + 0.05);
}

/** A mallet/keyboard note: fundamental plus a couple of quieter harmonics. */
function malletNote(ctx: AudioContext, out: AudioNode, freq: number, t0: number, dur: number, gain: number, type: OscillatorType = 'triangle'): void {
  const harmonics: [number, number][] = [
    [1, 1],
    [2, 0.35],
    [3, 0.16],
  ];
  for (const [mult, amp] of harmonics) tone(ctx, out, { type, freq: freq * mult, t0, dur, gain: gain * amp, attack: 0.003 });
}

// ---------- the library ----------

export const COMPLETION_SOUNDS: CompletionSoundDef[] = [
  {
    id: 'triangle',
    label: 'Triangle',
    group: 'Classic',
    render: (ctx, out, t0) => {
      // A struck triangle: bright, slightly inharmonic partials, long ring.
      const partials: [number, number][] = [
        [2637, 0.5],
        [3520, 0.22],
        [5274, 0.1],
        [1760, 0.16],
      ];
      for (const [f, g] of partials) tone(ctx, out, { type: 'sine', freq: f, t0, dur: 1.25, gain: g, attack: 0.002 });
    },
  },
  {
    id: 'chime',
    label: 'Chime',
    group: 'Classic',
    render: (ctx, out, t0) => {
      // Three descending bell tones (G6 · E6 · C6).
      [1568, 1319, 1047].forEach((f, i) => {
        const s = t0 + i * 0.13;
        tone(ctx, out, { type: 'sine', freq: f, t0: s, dur: 0.9, gain: 0.5, attack: 0.003 });
        tone(ctx, out, { type: 'sine', freq: f * 2.01, t0: s, dur: 0.45, gain: 0.13, attack: 0.003 });
      });
    },
  },
  {
    id: 'cymbal',
    label: 'Cymbal',
    group: 'Percussion',
    render: (ctx, out, t0) => {
      noiseHit(ctx, out, { t0, dur: 0.95, gain: 0.32, filter: 'highpass', freq: 5200 });
      noiseHit(ctx, out, { t0, dur: 0.28, gain: 0.2, filter: 'bandpass', freq: 9000, q: 0.5 });
    },
  },
  {
    id: 'timpani',
    label: 'Timpani',
    group: 'Percussion',
    render: (ctx, out, t0) => {
      // A tuned drum: a sine that drops in pitch, with a short noise thump.
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t0);
      o.frequency.exponentialRampToValueAtTime(73, t0 + 0.22);
      o.connect(envGain(ctx, out, t0, 0.7, 0.7, 0.004));
      o.start(t0);
      o.stop(t0 + 0.75);
      noiseHit(ctx, out, { t0, dur: 0.06, gain: 0.18, filter: 'lowpass', freq: 400 });
    },
  },
  {
    id: 'pizzicato',
    label: 'Pizzicato',
    group: 'Strings',
    render: (ctx, out, t0) => {
      // A plucked string: bandpassed saw with a fast decay, plus a fingernail tick.
      // Bandpass sits nearer the fundamental (was 620/Q2, which starved it) so the
      // pluck actually speaks.
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 440;
      bp.Q.value = 1.2;
      bp.connect(out);
      tone(ctx, bp, { type: 'sawtooth', freq: 293.66, t0, dur: 0.28, gain: 1.0, attack: 0.002 }); // D4
      tone(ctx, out, { type: 'triangle', freq: 587.33, t0, dur: 0.16, gain: 0.22, attack: 0.001 });
      noiseHit(ctx, out, { t0, dur: 0.02, gain: 0.2, filter: 'bandpass', freq: 2500 });
    },
  },
  {
    id: 'harp',
    label: 'Harp glissando',
    group: 'Strings',
    render: (ctx, out, t0) => {
      // A quick rising sweep across a pentatonic run.
      [392, 523, 587, 659, 784, 880, 1047, 1319].forEach((f, i) =>
        tone(ctx, out, { type: 'triangle', freq: f, t0: t0 + i * 0.05, dur: 0.6, gain: 0.24, attack: 0.002 })
      );
    },
  },
  {
    id: 'piano',
    label: 'Piano riff',
    group: 'Keys',
    render: (ctx, out, t0) => {
      // A four-note ascending arpeggio (C5 · E5 · G5 · C6).
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => malletNote(ctx, out, f, t0 + i * 0.085, 0.6, 0.4));
    },
  },
  {
    id: 'celesta',
    label: 'Celesta',
    group: 'Keys',
    render: (ctx, out, t0) => {
      // Two shimmering bell-keys (C6 · G6).
      [1046.5, 1567.98].forEach((f, i) => {
        const s = t0 + i * 0.12;
        tone(ctx, out, { type: 'sine', freq: f, t0: s, dur: 0.7, gain: 0.42, attack: 0.002 });
        tone(ctx, out, { type: 'sine', freq: f * 3, t0: s, dur: 0.3, gain: 0.06, attack: 0.002 });
      });
    },
  },
  {
    id: 'orchestra-hit',
    label: 'Orchestra hit',
    group: 'Brass',
    render: (ctx, out, t0) => {
      // The classic sampled stab: a detuned minor chord under a lowpass, a sub
      // thump, and a noise transient on the attack.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3200;
      lp.connect(out);
      for (const f of [130.81, 261.63, 311.13, 392.0]) {
        // C3 · C4 · Eb4 · G4
        tone(ctx, lp, { type: 'sawtooth', freq: f, t0, dur: 0.5, gain: 0.16, attack: 0.004 });
        tone(ctx, lp, { type: 'sawtooth', freq: f, t0, dur: 0.5, gain: 0.12, attack: 0.004, detune: 9 });
      }
      tone(ctx, out, { type: 'sine', freq: 65.41, t0, dur: 0.32, gain: 0.5, attack: 0.004 });
      noiseHit(ctx, out, { t0, dur: 0.06, gain: 0.25, filter: 'bandpass', freq: 1600, q: 0.5 });
    },
  },
  {
    id: 'fanfare',
    label: 'Fanfare',
    group: 'Brass',
    render: (ctx, out, t0) => {
      // A short brass call: G4 → C5 → held E5, each doubled and detuned for body.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3000;
      lp.connect(out);
      const seq: [number, number, number][] = [
        [392, 0, 0.16],
        [523.25, 0.15, 0.16],
        [659.25, 0.3, 0.42],
      ];
      for (const [f, dt, dur] of seq) {
        tone(ctx, lp, { type: 'sawtooth', freq: f, t0: t0 + dt, dur, gain: 0.2, attack: 0.02 });
        tone(ctx, lp, { type: 'sawtooth', freq: f, t0: t0 + dt, dur, gain: 0.14, attack: 0.02, detune: -8 });
      }
    },
  },
];

const SOUND_BY_ID: Record<string, CompletionSoundDef> = Object.fromEntries(COMPLETION_SOUNDS.map((s) => [s.id, s]));

// ---------- playback ----------

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

/** Build the per-play graph and schedule the sound. Reads currentTime only when
 *  the context is actually running — scheduling near t=0 on a just-resumed
 *  context silently drops the sound. */
function emit(ctx: AudioContext, def: CompletionSoundDef): void {
  const master = ctx.createGain();
  master.gain.value = 0.6;
  // A soft limiter keeps dense voicings (harp, orchestra hit) from clipping.
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp);
  comp.connect(ctx.destination);

  const t0 = ctx.currentTime + 0.03;
  try {
    def.render(ctx, master, t0);
  } catch {
    /* ignore synthesis failures — a missed chime is harmless */
  }
  // Tear down the graph well after the longest sound has rung out.
  window.setTimeout(() => {
    try {
      comp.disconnect();
      master.disconnect();
    } catch {
      /* already gone */
    }
  }, 2800);
}

/**
 * Play a completion sound by id. No-ops for 'none'/unknown ids or when audio is
 * unavailable — it never throws, so callers can fire it blindly from an event
 * handler. If the context is still suspended, it resumes first and plays once
 * that resolves (rather than scheduling into a stopped clock and losing the sound).
 */
export function playCompletionSound(id: string | undefined): void {
  if (!id || id === 'none') return;
  const def = SOUND_BY_ID[id];
  if (!def) return;
  const ctx = getCtx();
  if (!ctx) return;

  if (ctx.state === 'running') emit(ctx, def);
  else void ctx.resume().then(() => emit(ctx, def)).catch(() => {});
}
