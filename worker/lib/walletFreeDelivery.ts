/**
 * «توصيل عادي مجاني — للدفع الكامل من محفظة Levo» (owner brief 2026-10-06 §2,
 * docs/GIFTS_QUICK_BUY.md §2, D7–D8).
 *
 * WHAT IT IS. A delivery waiver, not a discount: the standard fee is still
 * quoted, recorded as `shipping_before_benefit_iqd`, and the order is charged
 * 0 for it with `waiver_source='wallet'`. Finance posts delivery revenue from
 * the charged `shipping_iqd`, so nothing has to be computed and reversed.
 *
 * WHO GETS IT. The admin-configured rules below, evaluated on the server only:
 *   • the setting is enabled and the checkout method is one it covers
 *     (default: standard delivery — never personal, pickup or an add-on);
 *   • with `require_full_wallet` (default) the order is paid entirely from the
 *     Levo wallet: payment method `wallet` and no points (points are a second
 *     instrument, so the payment would be mixed);
 *   • some enabled rule is met: the order holds a PAID line from the rule's
 *     catalog section (or below it) and the order's paid products subtotal —
 *     after product and membership discounts, before coupon and delivery — is
 *     at least the rule's minimum. A gift-only order pays nothing and never
 *     qualifies.
 */
export interface WalletFreeDeliveryRule {
  catalog_id: string;
  min_products_iqd: number;
  enabled: boolean;
}
export interface WalletFreeDeliveryConfig {
  enabled: boolean;
  require_full_wallet: boolean;
  methods: string[];
  rules: WalletFreeDeliveryRule[];
}

/** The owner's defaults: printers from 500,000 IQD, FDM filament from 0. */
export const WALLET_FREE_DELIVERY_DEFAULT: WalletFreeDeliveryConfig = {
  enabled: true,
  require_full_wallet: true,
  methods: ['standard'],
  rules: [
    { catalog_id: 'cat_printers', min_products_iqd: 500_000, enabled: true },
    { catalog_id: 'cat_materials_fdm', min_products_iqd: 0, enabled: true },
  ],
};

/** Methods the waiver may cover. Pickup has no last mile and is never one. */
export const WALLET_FREE_DELIVERY_METHODS = ['standard', 'personal'] as const;
const MAX_RULES = 20;
const MAX_IQD = 1_000_000_000_000;

export const WALLET_FREE_DELIVERY_LABEL = {
  ar: 'توصيل عادي مجاني — للدفع الكامل من محفظة Levo',
  en: 'Free standard delivery — paid in full from Levo Wallet',
  ckb: 'گەیاندنی ئاسایی بەخۆڕایی — بۆ پارەدانی تەواو لە جزدانی Levo',
} as const;

const isCatalogId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const isIqd = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_IQD;

/** Tolerant read of the stored setting: anything malformed falls back to the
 *  default for that field, so a damaged row can never charge a wrong fee — it
 *  can only behave like the documented default. */
export function normalizeWalletFreeDelivery(raw: unknown): WalletFreeDeliveryConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = WALLET_FREE_DELIVERY_DEFAULT;
  const methods = Array.isArray(r.methods)
    ? [...new Set(r.methods.filter((m): m is string => (WALLET_FREE_DELIVERY_METHODS as readonly string[]).includes(m as string)))]
    : d.methods;
  const rules = Array.isArray(r.rules)
    ? r.rules.slice(0, MAX_RULES).flatMap((v) => {
        const x = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
        return isCatalogId(x.catalog_id) && isIqd(x.min_products_iqd)
          ? [{ catalog_id: x.catalog_id, min_products_iqd: x.min_products_iqd, enabled: x.enabled !== false }]
          : [];
      })
    : d.rules;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    require_full_wallet: typeof r.require_full_wallet === 'boolean' ? r.require_full_wallet : d.require_full_wallet,
    methods,
    rules,
  };
}

/** Strict validation for the admin write: a typo is refused, never stored. */
export function validateWalletFreeDelivery(raw: unknown): { ok: true; value: WalletFreeDeliveryConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'walletFreeDelivery must be an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  if (typeof r.require_full_wallet !== 'boolean') return { ok: false, error: 'require_full_wallet must be true or false' };
  if (!Array.isArray(r.methods) || !r.methods.length || r.methods.some((m) => !(WALLET_FREE_DELIVERY_METHODS as readonly string[]).includes(m as string)))
    return { ok: false, error: 'methods must list standard and/or personal' };
  if (!Array.isArray(r.rules) || r.rules.length > MAX_RULES) return { ok: false, error: `rules must be a list of at most ${MAX_RULES}` };
  const seen = new Set<string>();
  for (const v of r.rules) {
    const x = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    if (!isCatalogId(x.catalog_id)) return { ok: false, error: 'every rule needs a catalog section id' };
    if (seen.has(x.catalog_id)) return { ok: false, error: `section ${x.catalog_id} is listed twice` };
    seen.add(x.catalog_id);
    if (!isIqd(x.min_products_iqd)) return { ok: false, error: 'min_products_iqd must be a whole number of dinars ≥ 0' };
    if (x.enabled !== undefined && typeof x.enabled !== 'boolean') return { ok: false, error: 'rule enabled must be true or false' };
  }
  return { ok: true, value: normalizeWalletFreeDelivery(r) };
}

export interface WalletFreeDeliveryLine {
  /** Every catalog id the line's product sits in, ancestors included. */
  ancestry: readonly string[];
  /** What the customer pays for the line (0 for a gift line). */
  paid_iqd: number;
}
export type WalletFreeDeliveryReason =
  | 'eligible'
  | 'disabled'
  | 'method_not_covered'
  | 'not_full_wallet'
  | 'points_used'
  | 'no_paid_products'
  | 'no_rule_met';
export interface WalletFreeDeliveryVerdict {
  eligible: boolean;
  reason: WalletFreeDeliveryReason;
  rule: WalletFreeDeliveryRule | null;
  products_subtotal_iqd: number;
}

export function walletFreeDeliveryVerdict(input: {
  config: WalletFreeDeliveryConfig;
  deliveryMethodId: string;
  paymentMethodId: string;
  pointsUsedIqd: number;
  lines: readonly WalletFreeDeliveryLine[];
  productsSubtotalIqd: number;
}): WalletFreeDeliveryVerdict {
  const subtotal = Math.max(0, Math.trunc(input.productsSubtotalIqd) || 0);
  const out = (reason: WalletFreeDeliveryReason, rule: WalletFreeDeliveryRule | null = null): WalletFreeDeliveryVerdict => ({
    eligible: reason === 'eligible',
    reason,
    rule,
    products_subtotal_iqd: subtotal,
  });
  const { config } = input;
  if (!config.enabled) return out('disabled');
  if (!config.methods.includes(input.deliveryMethodId)) return out('method_not_covered');
  if (config.require_full_wallet) {
    if (input.paymentMethodId !== 'wallet' && input.paymentMethodId !== 'full_advance') return out('not_full_wallet');
    if (input.pointsUsedIqd > 0) return out('points_used');
  }
  const paid = input.lines.filter((l) => l.paid_iqd > 0);
  if (!paid.length || subtotal <= 0) return out('no_paid_products');
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (subtotal < rule.min_products_iqd) continue;
    if (paid.some((l) => l.ancestry.includes(rule.catalog_id))) return out('eligible', rule);
  }
  return out('no_rule_met');
}

/** What the checkout settled about the rule for one quote or order. */
export interface WalletFreeDeliveryOutcome {
  verdict: WalletFreeDeliveryVerdict;
  /** The shipping engine actually took a fee off for this rule. */
  applied: boolean;
  waived_iqd: number;
  /** Paying the whole order from the wallet, without points, would earn it. */
  available_with_wallet: boolean;
}

/** The customer-facing view on a quote: no internal reason beyond the rule's
 *  own published terms (section and minimum). */
export function walletFreeDeliveryPublic(o: WalletFreeDeliveryOutcome) {
  return {
    applied: o.applied,
    waived_iqd: o.applied ? o.waived_iqd : 0,
    rule: o.applied && o.verdict.rule ? { catalog_id: o.verdict.rule.catalog_id, min_products_iqd: o.verdict.rule.min_products_iqd } : null,
    available_with_wallet: !o.applied && o.available_with_wallet,
  };
}
