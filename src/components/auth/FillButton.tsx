import React from 'react';

/**
 * FillButton — the "button that fills as requirements are completed"
 * (integrated mandate §2.2).
 *
 * The gold background layer scales smoothly with form-completion progress
 * (transform on an inner layer — no width animation, no layout thrash), and
 * a second, clipped label layer keeps text contrast intact on both the
 * filled (dark-on-gold) and unfilled (light-on-dark) regions.
 *
 * HONESTY CONTRACT:
 * - `ready` is the ONLY thing that enables the button. It must come from
 *   real validation in the caller — never from text length alone and never
 *   from the fill animation reaching the end. The animation is presentation.
 * - While not ready the visual fill is hard-capped below 100% so the bar can
 *   never *look* complete while validation still fails.
 * - This is a form-completion meter, not a network loading bar and not any
 *   claim that the account/code is correct. Real loading starts only after
 *   submit (`status="submitting"`).
 * - Deleting input regresses instantly: progress/ready are plain props
 *   recomputed by the caller on every change; nothing here latches.
 * - A ready button submits with Enter too (it is a real `type="submit"`
 *   button inside the form); a not-ready button shows WHY via `hint`.
 * - prefers-reduced-motion disables the fill transitions (auth.css).
 *
 * The pure helpers below (clamp01 … combineFillProgress) are exported for
 * unit tests (tests/fillButton.test.ts) and for the /auth page.
 */

// ---------------------------------------------------------------- helpers

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Pragmatic email shape check: local@domain.tld with a 2+ char TLD and no
 * spaces/extra @. Deliberately does NOT force `.com`/`.ru` or a fixed TLD
 * length (mandate §2.2): user@example.com, user@example.ru and
 * name+tag@sub.example.co.uk are all valid. Ownership is still only proven
 * by the server's verification email — this gates the button, nothing more.
 */
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmailAddress(raw: string): boolean {
  const s = raw.trim();
  return s.length >= 5 && s.length <= 320 && EMAIL_SHAPE_RE.test(s);
}

/**
 * Visual progress for an email field: grows as the local part, the "@",
 * the domain and the TLD are completed. Reaches 1 only for a valid shape.
 */
export function emailFieldProgress(raw: string): number {
  const s = raw.trim();
  if (!s) return 0;
  if (isValidEmailAddress(s)) return 1;
  const at = s.indexOf('@');
  let p = 0;
  if (at === -1) {
    // Only the local part so far.
    p = 0.3 * clamp01(s.length / 4);
  } else {
    const local = s.slice(0, at);
    const domain = s.slice(at + 1);
    p = 0.3 * clamp01(local.length / 3) + 0.15; // local + the @ itself
    const dot = domain.lastIndexOf('.');
    if (dot === -1) {
      p += 0.25 * clamp01(domain.length / 3);
    } else {
      const head = domain.slice(0, dot);
      const tld = domain.slice(dot + 1);
      p += 0.25 * clamp01(head.length / 3) + 0.3 * clamp01(tld.length / 2);
    }
  }
  // Invalid shapes never reach 100%.
  return Math.min(0.95, p);
}

/** Character-count progress toward a minimum (e.g. password min length). */
export function lengthProgress(value: string, min: number): number {
  if (min <= 0) return value.length > 0 ? 1 : 0;
  return clamp01(value.length / min);
}

export interface FillPart {
  /** Visual 0..1 progress of this field. */
  progress: number;
  /** REAL validation verdict for this field. */
  valid: boolean;
}

/**
 * The most an INCOMPLETE form may ever fill the button.
 *
 * This used to be 0.96 — and inside a 15px border radius the missing 4% is
 * a sliver the eye cannot find, so a form one rule short of valid rendered a
 * button that LOOKED finished while refusing the tap. That reads as a broken
 * animation, not as a meter. 85% leaves a gap no one can miss: the bar is
 * clearly "almost", and it snaps to 100% only at the moment every condition
 * is actually met.
 */
export const INCOMPLETE_FILL_CAP = 0.85;

/**
 * The sign-in password's meter part: fills character by character toward the
 * platform minimum and counts as met only at 8+.
 *
 * DEMANDING LENGTH 8 AT SIGN-IN LOCKS NOBODY OUT. Every path that has ever
 * STORED a password runs the same checkPassword(PASSWORD_MIN = 8) on the
 * worker — register, reset-password, change-password, and the optional
 * Telegram password (worker/routes/auth.ts) — so no existing account has a
 * shorter one, and a shorter attempt could only ever come back LOGIN_FAILED.
 * The meter saying "not yet" at 5 characters is therefore the truth, not a
 * new rule: it is why the fill can honestly track password length here, as
 * it always has for sign-up.
 */
/**
 * The sign-in identifier's meter part. One field, two rule tracks: with an
 * "@" it must become a valid email; without one, a username needs 3+
 * characters (the server is the authority on the credentials either way).
 *
 * THE TRACKS MEET, ON PURPOSE. The username ramp plateaus at exactly 0.45 —
 * the value the email track opens with once "@" is typed
 * (0.3·(local≥3) + 0.15 in emailFieldProgress). The old ramp reached 1.0 at
 * three characters, so typing "use" filled the part and the very next
 * keystroke of an email address ("user@…") dropped it to 0.45: an honest
 * rule change that LOOKS like the meter glitching backwards mid-word. Now
 * typing forward never moves the bar backwards, on either track, and a
 * complete valid username still reads full the moment everything else
 * passes (combineFillProgress returns 1 for an all-valid form).
 */
export function signinIdentifierPart(raw: string): FillPart {
  const s = raw.trim();
  if (s.includes('@')) {
    return { progress: emailFieldProgress(s), valid: isValidEmailAddress(s) };
  }
  return { progress: 0.45 * clamp01(s.length / 3), valid: s.length >= 3 };
}

export function loginPasswordPart(password: string): FillPart {
  return {
    progress: lengthProgress(password, 8),
    valid: password.length >= 8 && password.length <= 128,
  };
}

/**
 * Combine per-field parts into one button fill. `ready` is true only when
 * EVERY part passes its real validation; until then the combined progress
 * is capped at 0.96 so the bar cannot pretend to be complete.
 */
export function combineFillProgress(parts: FillPart[]): { progress: number; ready: boolean } {
  if (parts.length === 0) return { progress: 0, ready: false };
  const ready = parts.every((p) => p.valid);
  if (ready) return { progress: 1, ready: true };
  const sum = parts.reduce((acc, p) => acc + clamp01(p.progress), 0);
  return { progress: Math.min(INCOMPLETE_FILL_CAP, sum / parts.length), ready: false };
}

// -------------------------------------------------------------- component

export type FillButtonStatus = 'idle' | 'submitting' | 'success' | 'error';

export interface FillButtonProps {
  /** Resting label (also shown in the error state so retry is obvious). */
  label: string;
  /** Label while `status="submitting"` (real network work only). */
  workingLabel: string;
  /** Label for the brief success state; falls back to `label`. */
  successLabel?: string;
  /** Visual completion 0..1 — presentation only. */
  progress: number;
  /** Real-validation verdict; the ONLY source of clickability. */
  ready: boolean;
  status?: FillButtonStatus;
  /** The missing requirement, shown under the button while not ready. */
  hint?: string;
  id?: string;
}

export default function FillButton({
  label,
  workingLabel,
  successLabel,
  progress,
  ready,
  status = 'idle',
  hint,
  id,
}: FillButtonProps) {
  const submitting = status === 'submitting';
  const success = status === 'success';
  // Ready ⇒ full fill. Not ready ⇒ hard visual cap well below 100%, so an
  // almost-complete form can never wear a finished button (honesty).
  const shown = ready || submitting || success ? 1 : Math.min(clamp01(progress), INCOMPLETE_FILL_CAP);
  const pct = Math.round(shown * 100);
  const disabled = !ready || submitting || success;
  const hintId = id ? `${id}-hint` : undefined;
  const showHint = !!hint && !ready && !submitting;

  const content = submitting ? (
    <>
      <span aria-hidden className="lv-fillbtn__spinner" />
      <span>{workingLabel}</span>
    </>
  ) : success ? (
    <>
      <svg aria-hidden viewBox="0 0 24 24" className="lv-fillbtn__check" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      <span>{successLabel || label}</span>
    </>
  ) : (
    <>
      <span>{label}</span>
      {/* Forward arrow (auth.css mirrors it in RTL). Same box as the
          spinner, so submit never shifts the label. */}
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="lv-fillbtn__arrow"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4.5 12h15M13.5 6l6 6-6 6" />
      </svg>
    </>
  );

  return (
    <div>
      <button
        id={id}
        type="submit"
        disabled={disabled}
        aria-disabled={disabled || undefined}
        aria-busy={submitting || undefined}
        aria-describedby={showHint ? hintId : undefined}
        data-status={status}
        data-ready={ready ? 'true' : 'false'}
        className={`lv-fillbtn${ready || submitting || success ? ' is-ready' : ''}${status === 'error' ? ' is-error' : ''}`}
        style={{ '--lv-fill-scale': String(shown), '--lv-fill-pct': `${pct}%` } as React.CSSProperties}
      >
        {/* Gold fill layer — transform-only animation, origin at inline-start. */}
        <span aria-hidden className="lv-fillbtn__fill" />
        {/* Base label: light text for the unfilled region. */}
        <span className="lv-fillbtn__layer lv-fillbtn__layer--base">{content}</span>
        {/* Filled label: dark text, clipped to the filled region, so contrast
            never drops while the background fills (mandate §2.2). */}
        <span aria-hidden className="lv-fillbtn__layer lv-fillbtn__layer--fill">
          {content}
        </span>
      </button>
      {showHint && (
        <p id={hintId} className="lv-fillbtn__hint">
          {hint}
        </p>
      )}
    </div>
  );
}
