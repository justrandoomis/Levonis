/**
 * WHEN AN ABANDONED CHECKOUT LETS GO OF ITS STOCK — owner decision 5.
 *
 * A pending order holds its components reserved until someone confirms or
 * cancels it, and nothing has ever swept those reservations. On single
 * products that is merely untidy; on a bundle it is worse, because one
 * abandoned order holds several products at once and the whole bundle reads
 * "sold out" to every other customer while nobody has paid.
 *
 * The owner asked for a CONFIGURABLE expiry rather than a hardcoded 24 hours,
 * and for one guarantee above all others: *"the customer must never lose a
 * legitimately confirmed order because a cleanup job ran."* Everything below
 * is built around that sentence.
 *
 * THE CONFIG. `orderExpiryConfig` in `admin_settings`, shaped like
 * `orderStageDurations` (the other "how long does an order wait" setting the
 * same cron reads) rather than like the printer farm's versioned document:
 * three numbers do not need an expected-version protocol. It is validated by
 * THIS function on the way in through the admin settings route and on the way
 * out in the sweep, so a value that survives is exactly the value the clock
 * uses.
 *
 * IT SHIPS OFF. `enabled: false` and `ttl_minutes: 0`, the house default for
 * a policy nobody has chosen yet (printerGiftConfig, preorderGiftConfig and
 * minMarginPercent all ship the same way). Until an owner turns it on the
 * deployed behaviour is byte-identical to today's.
 *
 * This is a LEAF module — it imports nothing from the worker — because
 * `settings.ts` is imported by half the codebase and an import cycle through
 * it leaves a `const` uninitialised at runtime. Same reason `farm/config.ts`
 * and `warrantyConfig.ts` are leaves.
 */

export interface OrderExpiryConfig {
  /** Off until an owner turns it on. */
  enabled: boolean;
  /** How long an untouched, unpaid checkout may hold its stock. 0 = never. */
  ttl_minutes: number;
  /** How many orders one cron run may expire — the cost bound, not a policy. */
  batch_limit: number;
}

export const DEFAULT_ORDER_EXPIRY: OrderExpiryConfig = {
  enabled: false,
  ttl_minutes: 0,
  batch_limit: 100,
};

/** The shortest TTL that is not an accident. */
export const MIN_TTL_MINUTES = 15;
/** A year: past this the setting is junk rather than a policy. */
export const MAX_TTL_MINUTES = 365 * 24 * 60;

/**
 * Merges a stored value over the defaults, clamping every field and ignoring
 * junk — the same contract `resolveDurations` has, and for the same reason:
 * the admin route calls this on the way IN, so what is stored is what runs.
 *
 * `ttl_minutes` is clamped UP to 15 when it is positive but smaller, because
 * the cron runs every 15 minutes: a 5-minute TTL cannot mean what it says, and
 * silently behaving like 15 while displaying 5 is the kind of lie this
 * codebase does not tell. Zero stays zero and means "never expire", which is
 * how the feature stays off.
 */
export function resolveOrderExpiry(stored: unknown): OrderExpiryConfig {
  const out: OrderExpiryConfig = { ...DEFAULT_ORDER_EXPIRY };
  if (!stored || typeof stored !== 'object') return out;
  const raw = stored as Record<string, unknown>;

  out.enabled = raw.enabled === true || raw.enabled === 1 || raw.enabled === '1';

  const ttl = num(raw.ttl_minutes);
  if (ttl !== null && ttl > 0) out.ttl_minutes = Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.round(ttl)));

  const limit = num(raw.batch_limit);
  if (limit !== null && limit > 0) out.batch_limit = Math.min(500, Math.max(1, Math.round(limit)));

  return out;
}

/** Is this configuration actually going to expire anything? */
export function orderExpiryActive(cfg: OrderExpiryConfig): boolean {
  return cfg.enabled && cfg.ttl_minutes > 0;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
