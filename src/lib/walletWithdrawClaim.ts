/**
 * THE WITHDRAWAL FORM'S BALANCE QUESTION, IN THE UNIT THE CUSTOMER READS.
 *
 * The wallet shows ONE balance: the server's dinars (`balances.iqd_available`,
 * migration 0108), printed as-is in IQD and floored to the cent in USD. Two
 * typed deposits of 25,000 are 3,570 cents on the ledger but read IQD 50,000,
 * or $35.71 — one cent MORE than the ledger holds. The form used to compare a
 * typed dinar figure with the dinars (fine) but a typed dollar figure with the
 * raw cents, so a customer in USD mode who typed the $35.71 the header and the
 * form both showed was told «المبلغ يتجاوز رصيدك المتاح», and the server — which
 * caps at the cents on hand only beside a typed dinar claim
 * (`withdrawalReserveCents`, worker/lib/walletOps.ts) — refused it as well.
 *
 * So both currencies ask against the balance that was DISPLAYED, and a dollar
 * figure that lies between the ledger cents and the displayed dollars carries
 * the dinars it stands for as `declared_amount_iqd` — the whole dinar balance
 * when it is the whole displayed balance. The server corroborates that claim
 * against the cents sent (floor(declared × 100 / rate) must equal them) and
 * against the dinar balance, then reserves the cents on hand, exactly as it
 * does for a typed 50,000. A dollar amount inside the ledger cents sends no
 * dinars, as before: there the cents ARE the customer's number.
 */
import { iqdToUsdCents } from './api';

export interface WithdrawalClaimInput {
  currency: 'IQD' | 'USD';
  /** What was typed, parsed (dinars in IQD, dollars in USD). */
  rawAmount: number;
  /** The cents the form sends — `iqdToUsdCents(rawAmount)` in IQD, round(rawAmount × 100) in USD. */
  amountCents: number;
  /** The ledger's spendable cents (`balances.usd_cents_available`). */
  availableCents: number;
  /** The server's dinar balance (`balances.iqd_available`); 0 from an older server. */
  availableIqd: number;
  exchangeRate: number;
}

export interface WithdrawalClaim {
  /** `declared_amount_iqd` to send; 0 means none. */
  declaredIqd: number;
  /** True when the request is over the balance the customer was SHOWN. */
  overBalance: boolean;
  /** What is left after this request, in the unit it is printed in. */
  remaining: { iqd: number } | { cents: number };
}

export function withdrawalClaim(p: WithdrawalClaimInput): WithdrawalClaim {
  const availableCents = Number.isFinite(p.availableCents) ? Math.max(Math.trunc(p.availableCents), 0) : 0;
  const availableIqd = Number.isFinite(p.availableIqd) && p.availableIqd > 0 ? Math.trunc(p.availableIqd) : 0;
  const rate = Number.isFinite(p.exchangeRate) && p.exchangeRate > 0 ? p.exchangeRate : 0;

  if (p.currency === 'IQD') {
    const typed = Number.isInteger(p.rawAmount) && p.rawAmount > 0 ? p.rawAmount : 0;
    if (typed && availableIqd > 0) {
      return { declaredIqd: typed, overBalance: typed > availableIqd, remaining: { iqd: Math.max(availableIqd - typed, 0) } };
    }
    return {
      declaredIqd: typed,
      overBalance: p.amountCents > availableCents,
      remaining: { cents: Math.max(availableCents - p.amountCents, 0) },
    };
  }

  // USD: the dollars the header printed — the dinars floored to the cent —
  // never less than the ledger cents themselves.
  const shownCents = availableIqd > 0 && rate > 0 ? Math.max(iqdToUsdCents(availableIqd, rate), availableCents) : availableCents;
  let declaredIqd = 0;
  if (p.amountCents > availableCents && p.amountCents <= shownCents && rate > 0) {
    // The whole displayed balance is the whole dinar balance; anything short
    // of it is the fewest dinars that floor onto the same cents.
    const candidate = p.amountCents === shownCents ? availableIqd : Math.ceil((p.amountCents * rate) / 100);
    if (iqdToUsdCents(candidate, rate) === p.amountCents && candidate <= availableIqd) declaredIqd = candidate;
  }
  return {
    declaredIqd,
    overBalance: p.amountCents > shownCents,
    remaining: { cents: Math.max(shownCents - p.amountCents, 0) },
  };
}
