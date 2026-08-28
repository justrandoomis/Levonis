/**
 * Deterministic phone normalization for account linking (final-phase §2).
 * Primary market: Iraq. Comparison always uses full E.164 — never loose
 * suffix matching.
 *
 * Accepted Iraqi forms (mobile): 07XXXXXXXXX (11 digits), 7XXXXXXXXX,
 * +9647XXXXXXXXX, 009647XXXXXXXXX, 9647XXXXXXXXX → +9647XXXXXXXXX.
 * Other countries: a leading + and 8–15 digits pass through as E.164
 * (Telegram contacts arrive without '+' — a bare 10–15 digit number that
 * doesn't match Iraqi forms is treated as already-international).
 */

export function normalizePhone(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;

  const digitsOnly = s.startsWith('+') ? s.slice(1) : s;
  if (!/^\d{7,15}$/.test(digitsOnly)) return null;

  // Iraqi mobile forms → +964 7XX XXX XXXX (E.164: +964 + 10 digits).
  if (/^07\d{9}$/.test(digitsOnly) && !s.startsWith('+')) return `+964${digitsOnly.slice(1)}`;
  if (/^7\d{9}$/.test(digitsOnly) && !s.startsWith('+')) return `+964${digitsOnly}`;
  if (/^9647\d{9}$/.test(digitsOnly)) return `+${digitsOnly}`;
  if (s.startsWith('+964')) {
    return /^9647\d{9}$/.test(digitsOnly) ? `+${digitsOnly}` : null; // Iraqi mobiles only
  }

  // International passthrough.
  if (s.startsWith('+')) return `+${digitsOnly}`;
  // Telegram contact.phone_number commonly omits '+' — treat as international.
  if (digitsOnly.length >= 10) return `+${digitsOnly}`;
  return null;
}

export function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return na !== null && nb !== null && na === nb;
}

/** Masked display: +9647******123 */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return '***';
  return `${e164.slice(0, 5)}${'*'.repeat(Math.max(0, e164.length - 8))}${e164.slice(-3)}`;
}
