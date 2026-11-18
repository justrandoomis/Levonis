/**
 * «حد الفلامنت الشهري» — HOW MANY PIECES OF ONE FILAMENT KIND AN ACCOUNT MAY
 * BUY IN A ROLLING WINDOW (owner, 2026-11-19; migration 0245).
 *
 * A KIND is one product: «PLA Matte» with all its colours is one kind, «PLA
 * Basic» is another with its own limit. Per rolling `window_days` (30):
 *
 *   no membership 50 · PLUS 100 · PREMIUM (`prime`) 250 · PRO unlimited
 *
 * THE LIMIT FOLLOWS THE PERSON, NOT ONLY THE ACCOUNT. «Used» is every unit of
 * that product in a non-cancelled order of the window that was placed by this
 * account OR delivered to the same phone — the order's delivery phone, and the
 * account's verified phone (`users.phone_e164`). A second account with the same
 * delivery phone pools with the first.
 *
 * WHAT COUNTS. A line of a filament product (the FDM materials section
 * `cat_materials_fdm` and everything under it, by `category_id`,
 * `sub_category_id` or `product_catalogs` — the rewards programme's rule) and a
 * bundle component of one. NOT a printer's filament kit or add-on line (sold as
 * part of a printer, priced by the printer's offer), not a gift line, not a
 * mystery spool (whose order row names no product).
 *
 * WHO IS NOT LIMITED: PRO (null = unlimited), an admin account, and anything
 * that does not pass through the customer's checkout (the POS, the owner's
 * stock operations).
 *
 * THE PHONE KEY. `orders.delivery_phone_key` is the last ten digits of the
 * delivery phone — the Iraqi national number without its 0 / +964 prefix — so
 * `+964 770 123 4567`, `07701234567`, `7701234567` and `009647701234567` are
 * one key. `phoneKey` below is the rule; `PHONE_DIGITS_SQL` / `PHONE_KEY_SQL`
 * are the same rule in SQL (the 0245 backfill), proven equal by
 * tests/filamentLimits.test.ts.
 */
import { HttpError } from './http';
import { toAsciiDigits } from './phone';
import { FILAMENT_SECTION_ID } from './rewards/config';
import { tableColumns } from './schemaColumns';

// ------------------------------------------------------------------ config

export type FilamentTierKey = 'none' | 'plus' | 'prime' | 'pro';
export const FILAMENT_TIER_ORDER: readonly FilamentTierKey[] = ['none', 'plus', 'prime', 'pro'];

export interface FilamentLimitsConfig {
  enabled: boolean;
  window_days: number;
  /** Pieces per product per window; null = unlimited. */
  per_tier: Record<FilamentTierKey, number | null>;
}

export const FILAMENT_LIMITS_DEFAULT: FilamentLimitsConfig = {
  enabled: true,
  window_days: 30,
  per_tier: { none: 50, plus: 100, prime: 250, pro: null },
};

export const FILAMENT_LIMIT_MAX = 100_000;
export const FILAMENT_WINDOW_MAX_DAYS = 365;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;

/** Any stored shape → a whole config: each field in range, else its default. */
export function normalizeFilamentLimits(value: unknown): FilamentLimitsConfig {
  const o = isObject(value) ? value : {};
  const tiers = isObject(o.per_tier) ? o.per_tier : {};
  const per_tier = { ...FILAMENT_LIMITS_DEFAULT.per_tier };
  for (const t of FILAMENT_TIER_ORDER) {
    const v = tiers[t];
    if (v === null) per_tier[t] = null;
    else if (isCount(v, 0, FILAMENT_LIMIT_MAX)) per_tier[t] = v;
  }
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : FILAMENT_LIMITS_DEFAULT.enabled,
    window_days: isCount(o.window_days, 1, FILAMENT_WINDOW_MAX_DAYS) ? o.window_days : FILAMENT_LIMITS_DEFAULT.window_days,
    per_tier,
  };
}

export type Trilingual = { ar: string; en: string; ckb: string };

/** The admin door's strict reading: junk is refused in three languages, never stored. */
export function validateFilamentLimits(value: unknown): { ok: true; value: FilamentLimitsConfig } | { ok: false; error: Trilingual } {
  if (!isObject(value) || typeof value.enabled !== 'boolean' || !isObject(value.per_tier)) {
    return { ok: false, error: { ar: 'إعداد حد الفلامنت غير صالح.', en: 'The filament limit setting is not valid.', ckb: 'ڕێکخستنی سنووری فیلامێنت دروست نییە.' } };
  }
  if (!isCount(value.window_days, 1, FILAMENT_WINDOW_MAX_DAYS)) {
    return {
      ok: false,
      error: {
        ar: `مدة الحد بين 1 و${FILAMENT_WINDOW_MAX_DAYS} يومًا.`,
        en: `The window is 1 to ${FILAMENT_WINDOW_MAX_DAYS} days.`,
        ckb: `ماوەی سنوورەکە لە 1 بۆ ${FILAMENT_WINDOW_MAX_DAYS} ڕۆژە.`,
      },
    };
  }
  const tiers = value.per_tier;
  for (const t of FILAMENT_TIER_ORDER) {
    const v = tiers[t];
    if (v !== null && !isCount(v, 0, FILAMENT_LIMIT_MAX)) {
      return {
        ok: false,
        error: {
          ar: `حد كل باقة رقم صحيح من 0 إلى ${FILAMENT_LIMIT_MAX}، أو بلا حد.`,
          en: `Each plan's limit is a whole number from 0 to ${FILAMENT_LIMIT_MAX}, or unlimited.`,
          ckb: `سنووری هەر پلانێک ژمارەیەکی تەواوە لە 0 بۆ ${FILAMENT_LIMIT_MAX}، یان بێسنوور.`,
        },
      };
    }
  }
  return { ok: true, value: normalizeFilamentLimits(value) };
}

/** The membership as this rule reads it: an inactive or free membership is «none»; paused PRO already reads `prime`. */
export function filamentTierKey(status: { tier: string; active: boolean } | null | undefined): FilamentTierKey {
  if (!status || !status.active) return 'none';
  return status.tier === 'plus' || status.tier === 'prime' || status.tier === 'pro' ? status.tier : 'none';
}

/** The next plan up that raises this limit (null limit = unlimited), for the upsell; null when none does. */
export function nextFilamentTier(config: FilamentLimitsConfig, tier: FilamentTierKey): { tier: FilamentTierKey; limit: number | null } | null {
  const mine = config.per_tier[tier];
  if (mine === null) return null;
  for (const t of FILAMENT_TIER_ORDER.slice(FILAMENT_TIER_ORDER.indexOf(tier) + 1)) {
    const l = config.per_tier[t];
    if (l === null || l > mine) return { tier: t, limit: l };
  }
  return null;
}

// --------------------------------------------------------------- phone key

/** The characters a typed phone carries besides its digits. Anything else makes it no key at all. */
const PHONE_STRIP = [' ', '-', '+', '(', ')', '.', '\t', '‎', '‏'] as const;

/** A delivery phone → its pooling key (the last ten digits), or null when it is not a phone. */
export function phoneKey(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = toAsciiDigits(String(raw));
  for (const ch of PHONE_STRIP) s = s.split(ch).join('');
  if (s.length < 7 || !/^[0-9]+$/.test(s)) return null;
  return s.slice(-10);
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';
const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Step 1 of the SQL rule: the phone with its separators removed and its digits made ASCII. */
export function PHONE_DIGITS_SQL(expr: string): string {
  let out = `CAST(${expr} AS TEXT)`;
  for (let d = 0; d < 10; d++) {
    out = `replace(${out}, ${sqlText(ARABIC_INDIC[d])}, '${d}')`;
    out = `replace(${out}, ${sqlText(EASTERN_ARABIC_INDIC[d])}, '${d}')`;
  }
  for (const ch of PHONE_STRIP) {
    const lit = ch === '\t' ? 'char(9)' : ch === '‎' ? 'char(8206)' : ch === '‏' ? 'char(8207)' : sqlText(ch);
    out = `replace(${out}, ${lit}, '')`;
  }
  return out;
}

/** Step 2: those digits → the key (null unless at least seven digits and nothing else). */
export function PHONE_KEY_SQL(digits: string): string {
  return `CASE WHEN length(${digits}) >= 7 AND ${digits} NOT GLOB '*[^0-9]*' THEN substr(${digits}, -10) ELSE NULL END`;
}

/** The delivery phone inside an order's `address_snapshot`, as SQL (malformed JSON reads as no phone). */
export const SNAPSHOT_PHONE_SQL = `CASE WHEN json_valid(address_snapshot) THEN json_extract(address_snapshot, '$.phone') END`;

// ------------------------------------------------------------- the verdict

export interface FilamentRequestLine {
  product_id: string;
  qty: number;
}

export interface FilamentProductUsage {
  product_id: string;
  name: Trilingual;
  /** null = unlimited (this product is never over). */
  limit: number | null;
  used: number;
  requested: number;
  /** What may still be bought in this window, before this request; null = unlimited. */
  remaining: number | null;
  over: boolean;
}

export interface FilamentLimitVerdict {
  tier: FilamentTierKey;
  window_days: number;
  limit: number | null;
  next_tier: { tier: FilamentTierKey; limit: number | null } | null;
  products: FilamentProductUsage[];
  over: FilamentProductUsage[];
}

/** Sum the requested lines per product (two colours of one kind are one kind). */
export function requestedByProduct(lines: readonly FilamentRequestLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    const q = Math.max(0, Math.trunc(Number(l.qty) || 0));
    if (!l.product_id || q === 0) continue;
    out.set(l.product_id, (out.get(l.product_id) ?? 0) + q);
  }
  return out;
}

/**
 * THE PURE RULE. `filament` names the requested products that are filament
 * (others are not limited at all); `used` is what the window already holds.
 */
export function evaluateFilamentLimits(input: {
  config: FilamentLimitsConfig;
  tier: FilamentTierKey;
  requested: ReadonlyMap<string, number>;
  filament: ReadonlyMap<string, Trilingual>;
  used: ReadonlyMap<string, number>;
}): FilamentLimitVerdict {
  const { config, tier } = input;
  const limit = config.enabled ? config.per_tier[tier] : null;
  const products: FilamentProductUsage[] = [];
  for (const [product_id, requested] of input.requested) {
    const name = input.filament.get(product_id);
    if (!name) continue;
    const used = Math.max(0, Math.trunc(input.used.get(product_id) ?? 0));
    const remaining = limit === null ? null : Math.max(0, limit - used);
    products.push({ product_id, name, limit, used, requested, remaining, over: remaining !== null && requested > remaining });
  }
  return {
    tier,
    window_days: config.window_days,
    limit,
    next_tier: config.enabled ? nextFilamentTier(config, tier) : null,
    products,
    over: products.filter((p) => p.over),
  };
}

// ---------------------------------------------------------------- D1 reader

export interface FilamentUsageRow {
  id: string;
  name: string | null;
  name_ar: string | null;
  name_ku: string | null;
  used: number | null;
}

/**
 * ONE QUERY for every requested product: which are filament (and their names),
 * and how many of each the window already holds — by this account, by the
 * account's verified phone, or delivered to one of `phoneKeys`. Products and
 * keys travel as JSON lists (`json_each`), so the bound parameters stay at
 * six whatever the cart holds (D1 allows 100).
 *
 * A database without 0245's `delivery_phone_key` pools by account only; one
 * without 0235 / 0242 / 0175 simply has no kit, add-on or gift lines to leave out.
 */
export async function readFilamentUsage(
  db: D1Database,
  input: { userId: string; productIds: readonly string[]; phoneKeys: readonly string[]; sinceIso: string }
): Promise<{ filament: Map<string, Trilingual>; used: Map<string, number> }> {
  const filament = new Map<string, Trilingual>();
  const used = new Map<string, number>();
  const ids = [...new Set(input.productIds.filter(Boolean))];
  if (ids.length === 0) return { filament, used };
  const [orderCols, itemCols] = await Promise.all([
    tableColumns(db, 'orders', ['delivery_phone_key']),
    tableColumns(db, 'order_items', ['kit_id', 'addon_id', 'gift_entitlement_id']),
  ]);
  const byPhone = orderCols?.has('delivery_phone_key') === true;
  const itemFilters = (['kit_id', 'addon_id', 'gift_entitlement_id'] as const)
    .filter((col) => itemCols?.has(col))
    .map((col) => ` AND oi.${col} IS NULL`)
    .join('');
  const keys = [...new Set(input.phoneKeys.filter((k) => typeof k === 'string' && k.length > 0))];
  // Another account's order joins this pool through a phone only once staff
  // have confirmed it (confirmed / processing / shipped / delivered). A merely
  // placed 'pending' order does not, so nobody can use up a stranger's limit by
  // placing unconfirmed orders to that stranger's number; the account's own
  // orders still count from the moment they are placed.
  const phoneClause = byPhone
    ? ` OR (o.status IN ('confirmed', 'processing', 'shipped', 'delivered') AND (
          o.delivery_phone_key IN (SELECT value FROM json_each(?4))
          OR o.delivery_phone_key = (SELECT substr(replace(u.phone_e164, '+', ''), -10) FROM users u WHERE u.id = ?3 AND u.phone_e164 IS NOT NULL)))`
    : '';
  const sql = `WITH RECURSIVE branch(id) AS (
       SELECT ?1 UNION SELECT c.id FROM catalogs c JOIN branch b ON c.parent_id = b.id
     ),
     fil AS (
       SELECT p.id, p.name, p.name_ar, p.name_ku FROM products p
        WHERE p.id IN (SELECT value FROM json_each(?2))
          AND (p.category_id IN (SELECT id FROM branch) OR p.sub_category_id IN (SELECT id FROM branch)
               OR EXISTS (SELECT 1 FROM product_catalogs pc WHERE pc.product_id = p.id AND pc.catalog_id IN (SELECT id FROM branch)))
     ),
     usage AS (
       SELECT oi.product_id, SUM(oi.qty) AS used
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id IN (SELECT id FROM fil)
          AND o.status <> 'cancelled'
          AND o.created_at >= ?5
          AND (o.user_id = ?3${phoneClause})${itemFilters}
        GROUP BY oi.product_id
     )
     SELECT fil.id, fil.name, fil.name_ar, fil.name_ku, COALESCE(usage.used, 0) AS used
       FROM fil LEFT JOIN usage ON usage.product_id = fil.id`;
  const { results } = await db
    .prepare(sql)
    .bind(FILAMENT_SECTION_ID, JSON.stringify(ids), input.userId, JSON.stringify(keys), input.sinceIso)
    .all<FilamentUsageRow>();
  for (const r of results ?? []) {
    const en = String(r.name ?? '');
    filament.set(String(r.id), { ar: String(r.name_ar || en), en, ckb: String(r.name_ku || en) });
    used.set(String(r.id), Number(r.used) || 0);
  }
  return { filament, used };
}

/**
 * Read and judge in one call. Returns null when nothing is limited here —
 * the rule is off, the plan is unlimited, or the account is an admin — so the
 * caller pays no query at all.
 */
export async function checkFilamentLimits(
  db: D1Database,
  input: {
    config: FilamentLimitsConfig;
    user: { id: string; role?: string };
    tierStatus: { tier: string; active: boolean };
    lines: readonly FilamentRequestLine[];
    phones?: readonly unknown[];
    now?: number;
  }
): Promise<FilamentLimitVerdict | null> {
  const { config } = input;
  if (!config.enabled || input.user.role === 'admin') return null;
  const tier = filamentTierKey(input.tierStatus);
  if (config.per_tier[tier] === null) return null;
  const requested = requestedByProduct(input.lines);
  if (requested.size === 0) return null;
  const sinceIso = new Date((input.now ?? Date.now()) - config.window_days * 86_400_000).toISOString();
  const phoneKeys = (input.phones ?? []).map(phoneKey).filter((k): k is string => k !== null);
  const { filament, used } = await readFilamentUsage(db, { userId: input.user.id, productIds: [...requested.keys()], phoneKeys, sinceIso });
  if (filament.size === 0) return null;
  return evaluateFilamentLimits({ config, tier, requested, filament, used });
}

const TIER_LABEL: Record<FilamentTierKey, string> = { none: 'FREE', plus: 'PLUS', prime: 'PREMIUM', pro: 'PRO' };

/** The refusal: 409 FILAMENT_LIMIT, with every offending product and the next plan's limit as data. */
export function filamentLimitError(verdict: FilamentLimitVerdict): HttpError {
  const first = verdict.over[0];
  const message = first
    ? `«${first.name.en}» is limited to ${first.limit} pieces every ${verdict.window_days} days — you have ${first.remaining} left.` +
      (verdict.next_tier ? ` ${TIER_LABEL[verdict.next_tier.tier]} raises it to ${verdict.next_tier.limit ?? 'unlimited'}.` : '')
    : 'Filament limit reached.';
  return new HttpError(409, message, 'FILAMENT_LIMIT', filamentLimitDetails(verdict));
}

/** The client's data for the sentence — also the quote's `filament_limit`. */
export function filamentLimitDetails(verdict: FilamentLimitVerdict) {
  return {
    tier: verdict.tier,
    window_days: verdict.window_days,
    limit: verdict.limit,
    next_tier: verdict.next_tier,
    products: verdict.over.map((p) => ({
      product_id: p.product_id,
      name: p.name,
      limit: p.limit,
      used: p.used,
      requested: p.requested,
      remaining: p.remaining,
    })),
  };
}
