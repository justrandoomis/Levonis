/**
 * READING THE BENEFIT RULES, AND TURNING THEM INTO MONEY.
 *
 * `packages/pricing/src/membershipBenefits.ts` holds the arithmetic and knows
 * nothing about a database. This is the half that talks to D1: it loads the
 * rules, picks the one that applies, hands the per-unit part to the price
 * resolver and the order-level parts to the shipping quote and the COD tax
 * step, and writes the version an order is snapshotted against.
 *
 * THE SERVER DECIDES EVERYTHING. A tier arrives from `getTierStatus`, never
 * from a request body; a category comes from the product row, never from the
 * cart payload; a discount is computed here, never accepted. The only thing a
 * browser can do is ask.
 */

import type { Env } from './types';
import { safeParse } from './types';
import {
  NO_SHIPPING_BENEFIT,
  NO_TAX_BENEFIT,
  isUnitExpressible,
  lineBenefit,
  selectRule,
  shippingAfterBenefit,
  shippingBenefit,
  taxBenefit,
  type BenefitRule,
  type BenefitTarget,
  type BenefitType,
  type DeliveryMethodId,
  type LineBenefit,
  type ShippingBenefit,
  type TaxBenefit,
} from '@levonis/pricing/membershipBenefits';
import type { MemberFallback, Tier } from '@levonis/pricing/pricing';
import { hasEntitlement, type MembershipEntitlement, type TierStatus } from './entitlements';
import { auditStatements } from './audit';

const RULE_COLUMNS =
  'id, tier, benefit_type, scope, category_id, sub_category_id, product_id, discount_mode, percent, ' +
  'fixed_iqd, max_discount_iqd, cap_scope, max_quantity, min_subtotal_iqd, free_shipping_threshold_iqd, ' +
  'shipping_methods, max_shipping_subsidy_iqd, cod_tax_exempt, enabled, priority, valid_from, valid_until, label, notes';

interface RuleRow {
  id: string;
  tier: string;
  benefit_type: string;
  scope: string;
  category_id: string | null;
  sub_category_id: string | null;
  product_id: string | null;
  discount_mode: string | null;
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: string | null;
  max_quantity: number | null;
  min_subtotal_iqd: number | null;
  free_shipping_threshold_iqd: number | null;
  shipping_methods: string | null;
  max_shipping_subsidy_iqd: number | null;
  cod_tax_exempt: number | null;
  enabled: number;
  priority: number;
  valid_from: string | null;
  valid_until: string | null;
  label: string | null;
  notes: string | null;
}

const isTier = (v: string): v is Exclude<Tier, 'free'> => v === 'plus' || v === 'prime' || v === 'pro';
const isType = (v: string): v is BenefitType =>
  v === 'product_discount' || v === 'free_shipping' || v === 'cod_tax_exemption';

/** A stored row as the pure resolver wants it. Anything malformed is dropped
 *  rather than coerced: a rule nobody can read is a rule nobody should apply. */
export function ruleFromRow(row: RuleRow): BenefitRule | null {
  if (!isTier(row.tier) || !isType(row.benefit_type)) return null;
  const scope = row.scope;
  if (scope !== 'global' && scope !== 'category' && scope !== 'sub_category' && scope !== 'product') return null;
  const methods = row.shipping_methods === null ? null : safeParse<unknown>(row.shipping_methods, []);
  const methodList = Array.isArray(methods)
    ? (methods.filter((m): m is DeliveryMethodId => m === 'standard' || m === 'personal'))
    : null;
  return {
    id: row.id,
    tier: row.tier,
    benefit_type: row.benefit_type,
    scope,
    category_id: row.category_id,
    sub_category_id: row.sub_category_id,
    product_id: row.product_id,
    discount_mode: row.discount_mode === 'percent' || row.discount_mode === 'fixed' ? row.discount_mode : null,
    percent: row.percent,
    fixed_iqd: row.fixed_iqd,
    max_discount_iqd: row.max_discount_iqd,
    cap_scope: row.cap_scope === 'per_unit' || row.cap_scope === 'per_order' ? row.cap_scope : null,
    max_quantity: row.max_quantity,
    min_subtotal_iqd: row.min_subtotal_iqd,
    free_shipping_threshold_iqd: row.free_shipping_threshold_iqd,
    shipping_methods: row.shipping_methods === null ? null : methodList,
    max_shipping_subsidy_iqd: row.max_shipping_subsidy_iqd,
    cod_tax_exempt: row.cod_tax_exempt === null ? null : row.cod_tax_exempt === 1,
    enabled: row.enabled === 1,
    priority: row.priority,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    label: row.label,
  };
}

/** Every rule, including disabled ones — the admin's view. */
export async function allBenefitRules(db: D1Database): Promise<BenefitRule[]> {
  const { results } = await db
    .prepare(`SELECT ${RULE_COLUMNS} FROM membership_benefit_rules ORDER BY tier, benefit_type, scope, priority DESC, id`)
    .all<RuleRow>();
  return (results ?? []).map(ruleFromRow).filter((r): r is BenefitRule => r !== null);
}

/** The rules a checkout may apply: switched on. The date window and the scope
 *  are decided per line by the pure selector, which needs the clock anyway. */
export async function activeBenefitRules(db: D1Database): Promise<BenefitRule[]> {
  const { results } = await db
    .prepare(`SELECT ${RULE_COLUMNS} FROM membership_benefit_rules WHERE enabled = 1`)
    .all<RuleRow>();
  return (results ?? []).map(ruleFromRow).filter((r): r is BenefitRule => r !== null);
}

/**
 * WHICH ENTITLEMENT GATES WHICH BENEFIT.
 *
 * A rule is configuration; an entitlement is permission. An admin who has
 * restricted `freeDelivery` on one account for an open abuse case must not see
 * that account get free delivery because a rule says the tier does — so the
 * rule is consulted only after the entitlement agrees.
 */
const GATE: Record<BenefitType, { pro: MembershipEntitlement; prime: MembershipEntitlement }> = {
  product_discount: { pro: 'proPricing', prime: 'premiumPricing' },
  free_shipping: { pro: 'freeDelivery', prime: 'premiumDelivery' },
  cod_tax_exemption: { pro: 'codTaxExemption', prime: 'codTaxExemption' },
};

function entitled(status: TierStatus, type: BenefitType): boolean {
  if (!status.active) return false;
  if (status.tier === 'pro') return hasEntitlement(status, GATE[type].pro);
  if (status.tier === 'prime') return hasEntitlement(status, GATE[type].prime);
  return false;
}

/** The rule that applies to one product for this member, or null. */
export function ruleFor(
  rules: readonly BenefitRule[],
  status: TierStatus,
  type: BenefitType,
  target: BenefitTarget,
  nowIso: string,
  subtotalIqd?: number
): BenefitRule | null {
  if (!entitled(status, type)) return null;
  return selectRule(rules, {
    tier: status.tier,
    tierActive: status.active,
    benefitType: type,
    target,
    nowIso,
    subtotalIqd,
  });
}

/**
 * The per-unit fallback `resolveUnitPrice` consults where a line carries no
 * explicit member price. Only the member's OWN tier is filled: a PRO member
 * has no use for the PREMIUM rule, and filling both would let
 * `clampMemberLadder` hand a PRO member a PREMIUM discount that is larger than
 * their own — a real inversion the ladder is there to prevent.
 */
export function fallbackFor(
  rules: readonly BenefitRule[],
  status: TierStatus,
  target: BenefitTarget,
  nowIso: string
): MemberFallback {
  const rule = ruleFor(rules, status, 'product_discount', target, nowIso);
  // A rule whose effect depends on the ORDER (a quantity limit, a per-order
  // ceiling, a minimum subtotal) cannot be a unit price and is applied once at
  // the line instead — `isUnitExpressible` is the single place that decides,
  // so the unit price and the line correction can never both take it.
  if (!rule || !isUnitExpressible(rule)) return { pro: null, prime: null };
  return status.tier === 'pro' ? { pro: rule, prime: null } : { pro: null, prime: rule };
}

/* ------------------------------------------------------------ the order */

export interface BenefitLineInput {
  product_id: string;
  category_id: string | null;
  sub_category_id: string | null;
  /** The REGULAR unit price this line resolved to, before any membership. */
  regular_unit_iqd: number;
  /** What the buyer is actually charged per unit, after the ladder. */
  applied_unit_iqd: number;
  qty: number;
}

export interface ResolvedBenefits {
  tier: Tier;
  tier_active: boolean;
  version_id: number | null;
  lines: Array<LineBenefit & { product_id: string }>;
  /** The membership's total saving on merchandise, however it was applied. */
  discount_total_iqd: number;
  /**
   * The part of `discount_total_iqd` that is NOT yet in the unit prices and
   * the caller must subtract from the line totals exactly once
   * (`isUnitExpressible` in `@levonis/pricing/membershipBenefits`).
   */
  line_discount_iqd: number;
  shipping: ShippingBenefit;
  tax: TaxBenefit;
}

export interface ProductBenefits {
  lines: Array<LineBenefit & { product_id: string }>;
  discount_total_iqd: number;
  line_discount_iqd: number;
}

/**
 * WHAT THE MEMBERSHIP IS WORTH ON THE MERCHANDISE — the first half.
 *
 * Split out from the shipping/tax half because the checkout needs the answers
 * in that order: the product discount changes the merchandise total, the
 * merchandise total changes the coupon and the points, and only then is the
 * figure a free-delivery threshold should be tested against known. One
 * function computing all three would have to be told a shipping basis it is
 * itself about to invalidate.
 */
export function resolveProductBenefits(input: {
  rules: readonly BenefitRule[];
  status: TierStatus;
  lines: BenefitLineInput[];
  nowIso: string;
}): ProductBenefits {
  const { rules, status, nowIso } = input;
  const merchandise = input.lines.reduce((n, l) => n + Math.max(0, l.applied_unit_iqd) * Math.max(0, l.qty), 0);
  const lines = input.lines.map((line) => {
    const rule = ruleFor(
      rules,
      status,
      'product_discount',
      { product_id: line.product_id, category_id: line.category_id, sub_category_id: line.sub_category_id },
      nowIso,
      merchandise
    );
    return {
      product_id: line.product_id,
      ...lineBenefit({ regularUnitIqd: line.regular_unit_iqd, qty: line.qty, rule }),
    };
  });
  return {
    lines,
    discount_total_iqd: lines.reduce((n, l) => n + l.total_iqd, 0),
    line_discount_iqd: lines.reduce((n, l) => n + (l.applied_at === 'line' ? l.total_iqd : 0), 0),
  };
}

/** The order-level half: is delivery free on this method, and is the
 *  cash-on-delivery tax waived. */
export function resolveOrderBenefits(input: {
  rules: readonly BenefitRule[];
  status: TierStatus;
  /** The figure a free-shipping threshold is tested against. */
  shippingBasisIqd: number;
  deliveryMethod: DeliveryMethodId | null;
  nowIso: string;
}): { shipping: ShippingBenefit; tax: TaxBenefit } {
  const { rules, status, nowIso } = input;
  const shippingRule = ruleFor(rules, status, 'free_shipping', {}, nowIso, input.shippingBasisIqd);
  const shipping = shippingRule
    ? shippingBenefit({ rule: shippingRule, basisIqd: input.shippingBasisIqd, method: input.deliveryMethod })
    : { ...NO_SHIPPING_BENEFIT, basis_iqd: input.shippingBasisIqd };
  const codRule = ruleFor(rules, status, 'cod_tax_exemption', {}, nowIso);
  const tax = codRule ? taxBenefit(codRule) : NO_TAX_BENEFIT;
  return { shipping, tax };
}

/**
 * THE ONE RESOLVER the brief asks for: everything a membership is worth on
 * this cart, in one structured answer — `{ discount, shipping, tax }`.
 *
 * It reports; it does not charge. A line discount marked `applied_at: 'unit'`
 * is ALREADY in the unit price `resolveUnitPrice` produced and is repeated
 * here only so the cart can name it and the order can snapshot it; one marked
 * `'line'` is the caller's to subtract, exactly once. The shipping and tax
 * parts are decisions their own engines act on.
 *
 * The checkout uses the two halves separately (see `resolveProductBenefits`);
 * this entry point is for every surface that knows the whole cart up front —
 * the cart quote, the public preview and the admin simulator.
 */
export function resolveMembershipBenefits(input: {
  rules: readonly BenefitRule[];
  status: TierStatus;
  lines: BenefitLineInput[];
  /** The figure a free-shipping threshold is tested against. */
  shippingBasisIqd: number;
  deliveryMethod: DeliveryMethodId | null;
  nowIso: string;
  versionId?: number | null;
}): ResolvedBenefits {
  const product = resolveProductBenefits(input);
  const order = resolveOrderBenefits(input);
  return {
    tier: input.status.tier,
    tier_active: input.status.active,
    version_id: input.versionId ?? null,
    ...product,
    ...order,
  };
}

export { shippingAfterBenefit };

/* -------------------------------------------------------- the versioning */

/** The version an order placed right now is priced under. */
export async function currentBenefitVersionId(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare('SELECT id FROM membership_benefit_versions ORDER BY id DESC LIMIT 1')
    .first<{ id: number }>();
  return row ? Number(row.id) : null;
}

export interface RuleWrite {
  id: string;
  tier: Exclude<Tier, 'free'>;
  benefit_type: BenefitType;
  scope: BenefitRule['scope'];
  category_id: string | null;
  sub_category_id: string | null;
  product_id: string | null;
  discount_mode: BenefitRule['discount_mode'];
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: BenefitRule['cap_scope'];
  max_quantity: number | null;
  min_subtotal_iqd: number | null;
  free_shipping_threshold_iqd: number | null;
  shipping_methods: DeliveryMethodId[] | null;
  max_shipping_subsidy_iqd: number | null;
  cod_tax_exempt: boolean | null;
  enabled: boolean;
  priority: number;
  valid_from: string | null;
  valid_until: string | null;
  label: string | null;
  notes: string | null;
}

/**
 * ONE BATCH: the rule, the new version row, and the audit entry.
 *
 * They go together or not at all. A rule that changed without a version row
 * would leave the next order pointing at a set that no longer describes it,
 * and a rule that changed without an audit row is a price change nobody can
 * attribute — which is the thing an audit trail exists to make impossible.
 */
export async function saveBenefitRule(
  env: Env,
  actorId: string,
  rule: RuleWrite,
  action: 'create' | 'update'
): Promise<number> {
  const db = env.DB;
  const before = action === 'update'
    ? await db.prepare(`SELECT ${RULE_COLUMNS} FROM membership_benefit_rules WHERE id = ?`).bind(rule.id).first<RuleRow>()
    : null;

  const upsert = db
    .prepare(
      `INSERT INTO membership_benefit_rules
         (id, tier, benefit_type, scope, category_id, sub_category_id, product_id, discount_mode, percent,
          fixed_iqd, max_discount_iqd, cap_scope, max_quantity, min_subtotal_iqd, free_shipping_threshold_iqd,
          shipping_methods, max_shipping_subsidy_iqd, cod_tax_exempt, enabled, priority, valid_from, valid_until,
          label, notes, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)
       ON CONFLICT(id) DO UPDATE SET
         tier=excluded.tier, benefit_type=excluded.benefit_type, scope=excluded.scope,
         category_id=excluded.category_id, sub_category_id=excluded.sub_category_id, product_id=excluded.product_id,
         discount_mode=excluded.discount_mode, percent=excluded.percent, fixed_iqd=excluded.fixed_iqd,
         max_discount_iqd=excluded.max_discount_iqd, cap_scope=excluded.cap_scope, max_quantity=excluded.max_quantity,
         min_subtotal_iqd=excluded.min_subtotal_iqd,
         free_shipping_threshold_iqd=excluded.free_shipping_threshold_iqd,
         shipping_methods=excluded.shipping_methods, max_shipping_subsidy_iqd=excluded.max_shipping_subsidy_iqd,
         cod_tax_exempt=excluded.cod_tax_exempt, enabled=excluded.enabled, priority=excluded.priority,
         valid_from=excluded.valid_from, valid_until=excluded.valid_until, label=excluded.label, notes=excluded.notes,
         updated_at=datetime('now'), updated_by=excluded.updated_by`
    )
    .bind(
      rule.id, rule.tier, rule.benefit_type, rule.scope, rule.category_id, rule.sub_category_id, rule.product_id,
      rule.discount_mode, rule.percent, rule.fixed_iqd, rule.max_discount_iqd, rule.cap_scope, rule.max_quantity,
      rule.min_subtotal_iqd, rule.free_shipping_threshold_iqd,
      rule.shipping_methods === null ? null : JSON.stringify(rule.shipping_methods),
      rule.max_shipping_subsidy_iqd, rule.cod_tax_exempt === null ? null : rule.cod_tax_exempt ? 1 : 0,
      rule.enabled ? 1 : 0, rule.priority, rule.valid_from, rule.valid_until, rule.label, rule.notes, actorId
    );

  await upsert.run();
  return await appendVersion(env, actorId, action, rule.id, before, rule);
}

export async function deleteBenefitRule(env: Env, actorId: string, id: string): Promise<number> {
  const db = env.DB;
  const before = await db
    .prepare(`SELECT ${RULE_COLUMNS} FROM membership_benefit_rules WHERE id = ?`)
    .bind(id)
    .first<RuleRow>();
  await db.prepare('DELETE FROM membership_benefit_rules WHERE id = ?').bind(id).run();
  return await appendVersion(env, actorId, 'delete', id, before, null);
}

async function appendVersion(
  env: Env,
  actorId: string,
  action: string,
  ruleId: string,
  before: RuleRow | null,
  after: RuleWrite | null
): Promise<number> {
  const db = env.DB;
  const rules = await allBenefitRules(db);
  const { statements } = await auditStatements(db, actorId, `membership_benefit.${action}`, ruleId, {
    before: before ? { ...before } : null,
    after: after ? { ...after } : null,
  });
  await db.batch([
    db
      .prepare(
        'INSERT INTO membership_benefit_versions (actor_user_id, action, rule_id, before_json, after_json, rules_json) VALUES (?,?,?,?,?,?)'
      )
      .bind(
        actorId,
        action,
        ruleId,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        JSON.stringify(rules)
      ),
    ...statements,
  ]);
  return (await currentBenefitVersionId(db)) ?? 0;
}
