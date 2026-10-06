/**
 * THE 6-DIGIT GIFT CODE (docs/REVIEWS_GIFTS.md §Codes). Owner: lane S2.
 *
 * - Drawn from a CSPRNG with rejection sampling (`generateAuthOtpCode`, the
 *   sign-in OTP generator): 000000–999999, unbiased.
 * - NEVER stored, logged, audited, notified or announced. Only its verifier is
 *   stored: PBKDF2-SHA256, 100k iterations, a random 16-byte salt per code
 *   (`hashPassword`, worker/lib/crypto.ts), over `gift-code:v1:<entitlement
 *   id>:<code>` so a verifier cannot be moved to another entitlement.
 *   WHY NOT AN HMAC: every Worker secret in Env is optional and several are
 *   absent on the live Worker; a keyed hash would make issuing depend on a
 *   secret the owner must first set (or reuse a credential for a foreign
 *   purpose). PBKDF2 needs none and makes an offline guess from a leaked row
 *   cost 10^6 × 100k hash iterations; online guessing is capped at 5 tries per
 *   code plus per-user and per-IP rate limits.
 * - Compared in constant time (`verifyPassword` → `timingSafeEqual`).
 * - The raw code appears in exactly one place: the JSON body of the issue /
 *   re-issue response, sent `Cache-Control: no-store`.
 */
import { generateAuthOtpCode } from '../authOtp';
import { hashPassword, verifyPassword } from '../crypto';
import { toAsciiDigits } from '../phone';

/** Tries a code may absorb before it is locked (the admin re-issues). */
export const GIFT_CODE_MAX_ATTEMPTS = 5;

export const GIFT_CODE_SHAPE = /^\d{6}$/;

/**
 * What a customer typed, as the six ASCII digits the verifier knows — or ''
 * when it cannot be a code. Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹)
 * digits become ASCII; spaces, dashes and bidi marks a phone keyboard or a
 * pasted message carries are dropped. Nothing else is guessed.
 */
export function normalizeGiftCodeInput(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 64) return '';
  const code = toAsciiDigits(raw).replace(/[\s\-‎‏؜]/g, '');
  return GIFT_CODE_SHAPE.test(code) ? code : '';
}

/** A fresh 6-digit code. */
export function generateGiftCode(): string {
  return generateAuthOtpCode();
}

const material = (entitlementId: string, code: string) => `gift-code:v1:${entitlementId}:${code}`;

/** The stored verifier (`pbkdf2$<iter>$<salt>$<hash>`) for this entitlement's code. */
export async function giftCodeVerifier(entitlementId: string, code: string): Promise<string> {
  if (!GIFT_CODE_SHAPE.test(code)) throw new Error('gift code must be six digits');
  return hashPassword(material(entitlementId, code));
}

/**
 * True only when `code` is six ASCII digits and matches the verifier of this
 * entitlement. Callers normalise Arabic-Indic digits BEFORE calling (the SPA
 * sends ASCII; the route may apply toAsciiDigits). Never throws.
 */
export async function verifyGiftCode(entitlementId: string, code: string, verifier: string | null): Promise<boolean> {
  if (!verifier || typeof code !== 'string' || !GIFT_CODE_SHAPE.test(code)) return false;
  try {
    return await verifyPassword(material(entitlementId, code), verifier);
  } catch {
    return false;
  }
}
