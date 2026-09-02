import React, { useRef } from 'react';
import { toAsciiDigitsClient } from './PhoneField';

/**
 * OtpBoxes — six linked one-digit boxes for the Telegram OTP step
 * (integrated mandate §2.4).
 *
 * - Paste of the whole code works from any box (including "123 456" and
 *   Arabic/Eastern-Arabic digits — normalized to ASCII).
 * - autocomplete="one-time-code" lets iOS/Safari offer the code; when the
 *   autofill drops all six digits into one input they are distributed.
 * - Backspace on an empty box moves back and clears the previous digit;
 *   Arrow keys navigate; boxes always render LTR (digit order).
 *
 * HONESTY: the component reports the typed string only. Six digits mean
 * "ready to submit" — NEVER "verified". Verification is exclusively the
 * server's verdict after the caller submits. Pair with FillButton: progress
 * = value.length / length, ready = value.length === length.
 */

/** Digits only, ASCII-normalized, cut to the code length. */
export function normalizeOtp(raw: string, length = 6): string {
  return toAsciiDigitsClient(String(raw ?? '')).replace(/\D/g, '').slice(0, length);
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
}: OtpBoxesProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const code = normalizeOtp(value, length);
  const errorId = `${idPrefix}-error`;

  const focusBox = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(i, length - 1))];
    if (el) {
      el.focus();
      el.select();
    }
  };

  const commit = (next: string) => {
    const clean = normalizeOtp(next, length);
    onChange(clean);
    // Focus follows the first empty box (or the last box when complete).
    focusBox(Math.min(clean.length, length - 1));
  };

  const handleChange = (i: number, raw: string) => {
    const incoming = normalizeOtp(raw, length);
    if (incoming.length > 1) {
      // Paste or one-time-code autofill landed in a single input: treat it
      // as the whole code (starting from the first box).
      commit(incoming);
      return;
    }
    if (incoming.length === 0) {
      // Deletion inside a box: drop this digit (and the tail stays honest —
      // readiness regresses instantly with the shorter code).
      commit(code.slice(0, i));
      return;
    }
    commit(code.slice(0, i) + incoming);
  };

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (code[i]) {
        commit(code.slice(0, i));
      } else if (i > 0) {
        commit(code.slice(0, i - 1));
      }
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
    const pasted = normalizeOtp(e.clipboardData.getData('text'), length);
    if (pasted) commit(pasted);
  };

  return (
    <div>
      {/* Digit ORDER is always LTR, also on the Arabic page. */}
      <div role="group" aria-label={label} dir="ltr" className="lv-otp">
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
            className={`lv-otp__box${code[i] ? ' is-filled' : ''}${error ? ' is-error' : ''}`}
          />
        ))}
      </div>
      {error && (
        <p id={errorId} className="lv-field__error" style={{ textAlign: 'center' }}>
          {error}
        </p>
      )}
    </div>
  );
}
