/**
 * The scanner's sound and buzz — tiny and EAGER on purpose.
 *
 * iOS Safari lets a page make sound only from an AudioContext that was
 * created or resumed inside a user gesture. The scanner itself is a lazy
 * chunk that mounts after the tap that opened it, outside that gesture, so
 * the button that opens it calls `primeScannerAudio()` in its own click
 * handler. Without the priming the scanner still works — it just flashes
 * and (on Android) vibrates instead of beeping.
 *
 * TWO VOICES, NOT FOUR BEEPS (the owner: «صوت نجاح عند تسجيل الطابعة بنجاح،
 * وإذا … طابعة مسجلة مسبقًا يظهر صوت خطأ واهتزاز»). Success is a short rising
 * two-note chime — bright, soft-edged, over in a quarter of a second, the
 * character of a payment going through. A refusal is a low falling pair with
 * a firmer buzz under it, unmistakable with the phone in a pocket and the eyes
 * on the next box. Causality: each sounds on the frame the answer lands, and
 * the frame flashes the same colour at the same moment.
 */
let ctx: AudioContext | null = null;

type AudioCtor = typeof AudioContext;

export function primeScannerAudio(): void {
  try {
    if (typeof window === 'undefined') return;
    const Ctor: AudioCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

/**
 * - `added` / `captured`: a new serial was stored / a single read was taken.
 * - `exists`: the serial is ALREADY registered (in the inventory, or earlier
 *   in this session) — the owner's «مسجلة مسبقًا», an error.
 * - `duplicate`: the same label read twice inside one batch.
 * - `invalid`: not a serial at all.
 */
export type ScanFeedback = 'added' | 'duplicate' | 'exists' | 'invalid' | 'captured';

interface Note {
  freq: number;
  /** Seconds after the first note. */
  at: number;
  dur: number;
  type: OscillatorType;
  gain: number;
}

const SUCCESS: Note[] = [
  { freq: 1046.5, at: 0, dur: 0.12, type: 'sine', gain: 0.16 }, // C6
  { freq: 1568, at: 0.09, dur: 0.18, type: 'sine', gain: 0.14 }, // G6
];
const ERROR: Note[] = [
  { freq: 392, at: 0, dur: 0.14, type: 'triangle', gain: 0.22 }, // G4
  { freq: 262, at: 0.16, dur: 0.22, type: 'triangle', gain: 0.24 }, // C4
];
const INVALID: Note[] = [{ freq: 262, at: 0, dur: 0.2, type: 'triangle', gain: 0.2 }];

const VIBRATION: Record<ScanFeedback, number | number[]> = {
  added: 35,
  captured: 35,
  // A refusal is felt: three firm pulses the thumb cannot mistake for the tick.
  exists: [90, 60, 90, 60, 90],
  duplicate: [90, 60, 90, 60, 90],
  invalid: [40, 60, 40],
};

function play(notes: Note[]): void {
  if (!ctx || ctx.state !== 'running') return;
  const start = ctx.currentTime + 0.01;
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const at = start + n.at;
    osc.type = n.type;
    osc.frequency.setValueAtTime(n.freq, at);
    // Soft attack, exponential tail: a chime, never a click.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(n.gain, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + n.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + n.dur + 0.02);
  }
}

/** One sound (and a buzz where the phone can) per scan outcome. */
export function scanFeedback(kind: ScanFeedback): void {
  try {
    navigator.vibrate?.(VIBRATION[kind]);
  } catch {
    /* not every browser vibrates */
  }
  try {
    play(kind === 'added' || kind === 'captured' ? SUCCESS : kind === 'invalid' ? INVALID : ERROR);
  } catch {
    /* sound is a courtesy */
  }
}
