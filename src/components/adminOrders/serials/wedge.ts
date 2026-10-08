/**
 * KEYBOARD-WEDGE SCANNERS (brief §4) — USB, Bluetooth and keyboard-style
 * readers are keyboards: they type the code very fast and press Enter (or
 * Tab). Pure helpers, no DOM, unit-tested in tests/serialPrepUi.test.ts.
 *
 * TWO THINGS A PLAIN `<input>` GETS WRONG.
 *  1. Who typed it. A read that arrives as a burst is a scanner (`source:
 *     'scanner'` on the audit row); slow keys are a person (`'manual'`).
 *  2. Which characters. A wedge sends KEY CODES and the operating system turns
 *     them into characters through the ACTIVE LAYOUT — on an Arabic or Sorani
 *     keyboard `D` arrives as «ي» and the server rightly refuses the value
 *     (critique-2 M12, the layout most staff machines here use). So a burst is
 *     rebuilt from `KeyboardEvent.code`, the PHYSICAL key, which no layout
 *     changes. A person typing slowly keeps exactly what they typed.
 */

export interface KeyStroke {
  /** `KeyboardEvent.code` — the physical key (`KeyD`, `Digit3`, `Minus`). */
  code: string;
  /** `KeyboardEvent.key` — the character the layout produced. */
  key: string;
  shift: boolean;
  /** `performance.now()` or the event's timeStamp, in ms. */
  t: number;
}

/** A burst is at least this many characters… */
export const BURST_MIN_CHARS = 6;
/** …whose typical gap is under this many ms (people type at 100 ms and more). */
export const BURST_MAX_MEDIAN_GAP_MS = 35;

/** The median gap between consecutive keystrokes, or Infinity for fewer than two. */
export function medianGap(times: readonly number[]): number {
  if (times.length < 2) return Infinity;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(Math.max(0, times[i] - times[i - 1]));
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/** True when the keystrokes came as a scanner burst (6+ characters, median gap < 35 ms). */
export function isScannerBurst(times: readonly number[]): boolean {
  return times.length >= BURST_MIN_CHARS && medianGap(times) < BURST_MAX_MEDIAN_GAP_MS;
}

const SHIFTED: Record<string, string> = {
  Semicolon: ':',
  Slash: '?',
  Digit3: '#',
};
const PLAIN: Record<string, string> = {
  Minus: '-',
  Slash: '/',
  Period: '.',
  Space: ' ',
  Semicolon: ';',
  NumpadSubtract: '-',
  NumpadDivide: '/',
  NumpadDecimal: '.',
};

/**
 * The ASCII character a physical key stands for on a US layout — the layout a
 * barcode reader is programmed for — or null for a key that is not part of a
 * serial (Shift itself, arrows, F-keys).
 */
export function charFromCode(code: string, shift = false): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return shift && SHIFTED[code] ? SHIFTED[code] : code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (shift && SHIFTED[code]) return SHIFTED[code];
  return PLAIN[code] ?? null;
}

/** The value a burst MEANT, rebuilt from the physical keys. */
export function textFromStrokes(strokes: readonly KeyStroke[]): string {
  let out = '';
  for (const s of strokes) {
    const c = charFromCode(s.code, s.shift);
    if (c !== null) out += c;
  }
  return out;
}

/** Keys that end a read: Enter always; Tab only inside a burst (some readers send Tab). */
export function isTerminator(key: string, inBurst: boolean): boolean {
  return key === 'Enter' || key === 'NumpadEnter' || (inBurst && key === 'Tab');
}

/** Keys that mean a PERSON is editing — the strokes no longer describe the value. */
const EDITING = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * Follows one input's keystrokes from empty to submit. `push` every keydown
 * that produced a character (or edited), `finish` with the input's value on
 * Enter: it answers what to send and who sent it.
 */
export class WedgeTracker {
  private strokes: KeyStroke[] = [];
  private edited = false;

  push(e: { code: string; key: string; shiftKey: boolean; timeStamp: number }): void {
    if (EDITING.has(e.key)) {
      this.edited = true;
      return;
    }
    // Only keys that type something: a single character, from a known key.
    if (e.key.length !== 1 && e.key !== 'Unidentified') return;
    this.strokes.push({ code: e.code, key: e.key, shift: e.shiftKey, t: e.timeStamp });
  }

  /** Is the current run a burst so far? (Tab is a terminator only inside one.) */
  get inBurst(): boolean {
    return !this.edited && isScannerBurst(this.strokes.map((s) => s.t));
  }

  /** What to send for `value`, and who sent it. Resets the tracker. */
  finish(value: string): { text: string; source: 'scanner' | 'manual' } {
    const strokes = this.strokes;
    const burst = !this.edited && isScannerBurst(strokes.map((s) => s.t));
    this.reset();
    const typed = value.trim();
    if (!burst) return { text: typed, source: 'manual' };
    const physical = textFromStrokes(strokes).trim();
    // The layout changed the characters (or swallowed some): trust the keys.
    // Otherwise keep the value exactly as typed — it is the same text.
    // eslint-disable-next-line no-control-regex
    const nonAscii = /[^\x00-\x7F]/.test(typed);
    const text = physical && (nonAscii || physical.length > typed.length) ? physical : typed || physical;
    return { text, source: 'scanner' };
  }

  reset(): void {
    this.strokes = [];
    this.edited = false;
  }
}
