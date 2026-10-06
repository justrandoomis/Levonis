import React, { useRef } from 'react';
import { toAsciiDigits } from '../../lib/localeNumber';

/**
 * OtpBoxes — six linked one-digit boxes for the Telegram OTP step
 * (integrated mandate §2.4), and for the 6-digit gift code on /gifts
 * (docs/REVIEWS_GIFTS.md §8 C3).
 *
 * - Paste of the whole code works from any box (including "123 456" and
 *   Arabic/Eastern-Arabic digits — normalized to ASCII).
 * - autocomplete="one-time-code" lets iOS/Safari offer the code; when the
 *   autofill drops all six digits into one input they are distributed.
 * - Backspace on an empty box moves back and clears the previous digit;
 *   Arrow keys navigate; boxes always render LTR (digit order).
 *
 * THE DIGITS COME FROM src/lib/localeNumber, NOT FROM ./PhoneField. PhoneField
 * carries the whole phone-number library, and importing one helper from it
 * pulled that library into every page that shows these boxes — /gifts too.
 * `toAsciiDigits` is the same normaliser (٠-٩ and ۰-۹ → 0-9), so
 * `normalizeOtp` answers exactly as it did.
 *
 * TWO APPEARANCES. `auth` (the default, unchanged) is styled by the sign-in
 * stylesheet, which only the auth screens load. `plain` is drawn with the
 * shared theme utilities only, so it renders correctly on any page.
 *
 * HONESTY: the component reports the typed string only. Six digits mean
 * "ready to submit" — NEVER "verified". Verification is exclusively the
 * server's verdict after the caller submits. Pair with FillButton: progress
 * = value.length / length, ready = value.length === length.
 */

/** Digits only, ASCII-normalized, cut to the code length. */
export function normalizeOtp(raw: string, length = 6): string {
  return toAsciiDigits(String(raw ?? '')).replace(/\D/g, '').slice(0, length);
}

/** The code after an edit, and the box the focus moves to (the first empty one, or the last). */
export interface OtpStep {
  value: string;
  focus: number;
}

function step(next: string, length: number): OtpStep {
  const value = normalizeOtp(next, length);
  return { value, focus: Math.min(value.length, length - 1) };
}

/**
 * What typing (or an autofill landing) in box `index` makes of the code.
 * Several digits at once are the whole code from the first box; nothing is a
 * deletion of this box and everything after it; one digit replaces this box
 * and drops the tail, so readiness regresses the moment a digit changes.
 */
export function otpAfterInput(code: string, index: number, raw: string, length = 6): OtpStep {
  const incoming = normalizeOtp(raw, length);
  if (incoming.length > 1) return step(incoming, length);
  if (incoming.length === 0) return step(code.slice(0, index), length);
  return step(code.slice(0, index) + incoming, length);
}

/** Backspace in box `index`: clear it, or — when it is already empty — the box before it. Null = nothing to clear. */
export function otpAfterBackspace(code: string, index: number, length = 6): OtpStep | null {
  if (code[index]) return step(code.slice(0, index), length);
  if (index > 0) return step(code.slice(0, index - 1), length);
  return null;
}

/** A paste anywhere is the whole code. Null when the clipboard holds no digit. */
export function otpAfterPaste(text: string, length = 6): OtpStep | null {
  const pasted = normalizeOtp(text, length);
  return pasted ? step(pasted, length) : null;
}

export interface OtpBoxesProps {
  value: string;
  onChange: (code: string) => void;
  length?: number;
  /** Accessible group label, e.g. "رمز التحقق (6 أرقام)". */
  label: string;
  disabled?: boolean;
  error?: string;
  idPrefix?: string;
  autoFocus?: boolean;
  /** `auth` (default): the sign-in stylesheet's boxes. `plain`: shared theme utilities, for any page. */
  appearance?: 'auth' | 'plain';
}

/** The plain box: 40px wide on a phone (six fit a 296px card body), 44px from `sm` up, 48px tall. */
function plainBoxClass(filled: boolean, invalid: boolean): string {
  const edge = invalid ? 'border-danger' : filled ? 'border-gold/60' : 'border-border-subtle';
  return `w-10 h-12 sm:w-11 rounded-xl border ${edge} bg-canvas text-center text-xl font-semibold font-mono tabular-nums text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50`;
}

export default function OtpBoxes({
  value,
  onChange,
  length = 6,
  label,
  disabled,
  error,
  idPrefix = 'otp',
  autoFocus,
  appearance = 'auth',
}: OtpBoxesProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const code = normalizeOtp(value, length);
  const errorId = `${idPrefix}-error`;
  const plain = appearance === 'plain';

  const focusBox = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(i, length - 1))];
    if (el) {
      el.focus();
      el.select();
    }
  };

  const commit = (next: OtpStep) => {
    onChange(next.value);
    // Focus follows the first empty box (or the last box when complete).
    focusBox(next.focus);
  };

  const handleChange = (i: number, raw: string) => {
    // Paste or one-time-code autofill landing in a single input is the whole
    // code; a deletion inside a box drops it and the tail stays honest.
    commit(otpAfterInput(code, i, raw, length));
  };

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = otpAfterBackspace(code, i, length);
      if (next) commit(next);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusBox(i - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusBox(i + 1);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const next = otpAfterPaste(e.clipboardData.getData('text'), length);
    if (next) commit(next);
  };

  return (
    <div>
      {/* Digit ORDER is always LTR, also on the Arabic page. */}
      <div role="group" aria-label={label} dir="ltr" className={plain ? 'flex justify-center gap-1.5' : 'lv-otp'}>
        {Array.from({ length }, (_, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${idPrefix}-${i}`}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={length}
            value={code[i] ?? ''}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={handlePaste}
            onFocus={(e) => e.target.select()}
            disabled={disabled}
            autoFocus={autoFocus && i === 0}
            aria-label={`${label} — ${i + 1}/${length}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={
              plain
                ? plainBoxClass(!!code[i], !!error)
                : `lv-otp__box${code[i] ? ' is-filled' : ''}${error ? ' is-error' : ''}`
            }
            style={plain ? { caretColor: 'var(--color-gold)' } : undefined}
          />
        ))}
      </div>
      {error &&
        (plain ? (
          <p id={errorId} role="alert" className="mt-2 text-center text-[13px] leading-relaxed text-danger">
            {error}
          </p>
        ) : (
          <p id={errorId} className="lv-field__error" style={{ textAlign: 'center' }}>
            {error}
          </p>
        ))}
    </div>
  );
}
