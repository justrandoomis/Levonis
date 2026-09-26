/**
 * The scanner's sound and buzz — tiny and EAGER on purpose.
 *
 * iOS Safari lets a page make sound only from an AudioContext that was
 * created or resumed inside a user gesture. The scanner itself is a lazy
 * chunk that mounts after the tap that opened it, outside that gesture, so
 * the button that opens it calls `primeScannerAudio()` in its own click
 * handler. Without the priming the scanner still works — it just flashes
 * and (on Android) vibrates instead of beeping.
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

export type ScanFeedback = 'added' | 'duplicate' | 'invalid' | 'captured';

/** One short tone (and a buzz where the phone can) per scan outcome. */
export function scanFeedback(kind: ScanFeedback): void {
  try {
    navigator.vibrate?.(kind === 'added' || kind === 'captured' ? 40 : [30, 60, 30]);
  } catch {
    /* not every browser vibrates */
  }
  if (!ctx || ctx.state !== 'running') return;
  try {
    const tones = kind === 'added' || kind === 'captured' ? [1175] : kind === 'duplicate' ? [660, 660] : [330];
    let at = ctx.currentTime;
    for (const freq of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.1);
      at += 0.13;
    }
  } catch {
    /* sound is a courtesy */
  }
}
