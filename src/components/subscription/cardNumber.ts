/**
 * The cosmetic Levo ID number printed on the membership card.
 *
 * DISPLAY ONLY. It is derived deterministically from the account id so the
 * same person always sees the same number, it is never stored, never sent,
 * and nothing on the server knows it. It used to carry a bank-card-like fixed
 * four-digit prefix, making sixteen digits in four groups; the owner asked
 * for twelve, so it is now the twelve hashed digits in three groups of four —
 * which also lets it fit inside the card on a 360px phone.
 */
export const CARD_GROUPS = 3;
export const CARD_PLACEHOLDER = '---- ---- ----';

export function cardNumberFor(seed: string): string {
  if (!seed) return CARD_PLACEHOLDER;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  // |hash| is a 32-bit magnitude (at most ten digits); padding gives exactly twelve.
  const digits = Math.abs(hash).toString().padStart(12, '0').slice(-12);
  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)}`;
}

/** "**** **** 1234" — the last group stays readable. */
export function maskCardNumber(full: string): string {
  if (full === CARD_PLACEHOLDER) return full;
  return `**** **** ${full.slice(-4)}`;
}
