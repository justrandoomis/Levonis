/**
 * Store creation, slug rules, and the platform commission.
 *
 * Two things here decide money and identity, so both are pure enough to test
 * directly (tests/merchantOps.test.ts) and neither takes a value from the
 * browser:
 *
 *   - a slug becomes a DNS label and a public URL, so it is validated by
 *     syntax, then against the code-level system list, then against the
 *     database's reserved and retired names — in that order, most-trusted
 *     source first (§4, §7);
 *
 *   - a commission is read from admin settings and SNAPSHOT onto the order
 *     (§30, §75). Changing the rate tomorrow must not rewrite what a merchant
 *     is owed for a sale that already happened, so no reader ever recomputes
 *     a fee from live settings for a historical row.
 */

import { isValidSlugSyntax, isSystemSlug, SLUG_MIN, SLUG_MAX } from './hosts';

export type SlugRejection =
  | 'too_short'
  | 'too_long'
  | 'invalid_characters'
  | 'reserved'
  | 'taken'
  | 'recently_released';

export interface SlugCheck {
  ok: boolean;
  reason: SlugRejection | null;
  /**
   * The slug as it would actually be stored. Hostnames are case-insensitive,
   * so "Ali3D" is not an error — but it is not what the merchant gets either,
   * and a store's name in the address bar is identity, not formatting. The
   * caller stores THIS value and shows it back, so the transformation is
   * visible rather than a surprise after the fact.
   */
  slug: string;
}

/**
 * Is this slug available for `forStoreId` (or for a brand-new store)?
 *
 * Order matters. Syntax first (cheapest, and rejects anything that could not
 * be a hostname at all), then the code-level system list (must hold even if
 * the database is mid-migration), then the database.
 */
export async function checkSlug(
  db: D1Database,
  raw: string,
  forStoreId: string | null = null
): Promise<SlugCheck> {
  const slug = (raw || '').trim().toLowerCase();
  const no = (reason: SlugRejection): SlugCheck => ({ ok: false, reason, slug });

  if (slug.length < SLUG_MIN) return no('too_short');
  if (slug.length > SLUG_MAX) return no('too_long');
  if (!isValidSlugSyntax(slug)) return no('invalid_characters');
  if (isSystemSlug(slug)) return no('reserved');

  const reserved = await db.prepare('SELECT slug FROM reserved_slugs WHERE slug = ?').bind(slug).first();
  if (reserved) return no('reserved');

  const live = await db
    .prepare('SELECT id FROM merchant_stores WHERE slug = ?')
    .bind(slug)
    .first<{ id: string }>();
  if (live && live.id !== forStoreId) return no('taken');

  // A slug this store used to hold is still theirs to take back. Anyone
  // else's retired slug stays parked until its reservation lapses, so a
  // competitor cannot watch for a rename and capture the traffic — and every
  // link and QR code already printed on a box keeps pointing somewhere sane
  // (§68).
  const retired = await db
    .prepare("SELECT store_id, reserved_until FROM merchant_store_slugs WHERE slug = ? AND active = 0")
    .bind(slug)
    .first<{ store_id: string; reserved_until: string | null }>();
  if (retired && retired.store_id !== forStoreId) {
    if (!retired.reserved_until || retired.reserved_until > new Date().toISOString()) {
      return no('recently_released');
    }
  }

  return { ok: true, reason: null, slug };
}

/** How long a released slug stays unclaimable by anyone else. */
export const SLUG_RESERVATION_DAYS = 180;

/**
 * Turns a store name into a slug suggestion. A suggestion only — it is
 * re-validated by `checkSlug` like anything a user typed, because a name in
 * Arabic or Kurdish can transliterate to nothing usable at all.
 */
export function suggestSlug(name: string): string {
  const base = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return base.slice(0, SLUG_MAX);
}

// ------------------------------------------------------------- commission

export interface FeeSettings {
  requestPercentX100: number;
  storePercentX100: number;
  minIqd: number;
}

export type FeeKind = 'store' | 'request';

/**
 * Reads the owner-configured commission. Never hardcoded at a call site.
 *
 * The seeded default is 5% on both kinds of sale. That is a STARTING VALUE
 * chosen to be conservative, not a business decision — the mandate requires
 * the rate to be configurable and gives 10% only as an arithmetic example.
 * The owner sets the real rate in community settings, and whatever it is at
 * the moment of sale is snapshot onto that order forever.
 */
export async function feeSettings(db: D1Database): Promise<FeeSettings> {
  const { results } = await db
    .prepare(
      `SELECT key, value FROM admin_settings
        WHERE key IN ('communityFeeRequestPercentX100','communityFeeStorePercentX100','communityFeeMinIqd')`
    )
    .all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const num = (k: string, d: number) => {
    const n = Number(map.get(k));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
  };
  return {
    requestPercentX100: num('communityFeeRequestPercentX100', 500),
    storePercentX100: num('communityFeeStorePercentX100', 500),
    minIqd: num('communityFeeMinIqd', 0),
  };
}

export interface FeeSplit {
  gross_iqd: number;
  commission_percent_x100: number;
  platform_fee_iqd: number;
  merchant_receivable_iqd: number;
}

/**
 * Splits a gross amount into the platform's fee and the merchant's receivable.
 *
 * INTEGER IQD THROUGHOUT (§31). The percentage is held in hundredths and the
 * fee is floored, so the two parts always sum back to the gross exactly — the
 * database CHECK on community_orders and community_escrows enforces that, and
 * a rounding scheme that could be off by one dinar would fail every insert.
 *
 * The minimum fee cannot exceed the gross: on a very small job the platform
 * takes everything rather than the merchant owing money, and `receivable`
 * never goes negative.
 */
export function splitFee(grossIqd: number, percentX100: number, minIqd = 0): FeeSplit {
  const gross = Math.max(0, Math.floor(grossIqd));
  const pct = Math.max(0, Math.floor(percentX100));
  let fee = Math.floor((gross * pct) / 10_000);
  if (minIqd > 0 && fee < minIqd) fee = Math.floor(minIqd);
  if (fee > gross) fee = gross;
  return {
    gross_iqd: gross,
    commission_percent_x100: pct,
    platform_fee_iqd: fee,
    merchant_receivable_iqd: gross - fee,
  };
}

/** The split for a given sale kind, using the current owner settings. */
export async function feeFor(db: D1Database, kind: FeeKind, grossIqd: number): Promise<FeeSplit> {
  const s = await feeSettings(db);
  const pct = kind === 'request' ? s.requestPercentX100 : s.storePercentX100;
  return splitFee(grossIqd, pct, s.minIqd);
}

// -------------------------------------------------------------- lifecycle

/** Days a customer has to confirm or dispute before auto-completion. 0 = off. */
export async function autoCompleteDays(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM admin_settings WHERE key = 'communityAutoCompleteDays'")
    .first<{ value: string }>();
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7;
}

/** Merchant badge from transparent, published criteria (§42). */
export function badgeFor(input: {
  completed_orders: number;
  rating_avg_x100: number;
  rating_count: number;
  verified: number;
}): string {
  const { completed_orders: done, rating_avg_x100: rating, rating_count: ratings, verified } = input;
  // Deliberately conservative: a merchant with a 5.0 from two customers is not
  // "Elite", they are new with a good start. Every tier needs volume AND a
  // rating that has been tested by enough people to mean something.
  if (verified && done >= 100 && ratings >= 40 && rating >= 470) return 'elite';
  if (done >= 40 && ratings >= 15 && rating >= 450) return 'professional';
  if (done >= 10 && ratings >= 5 && rating >= 400) return 'trusted';
  return 'new';
}
