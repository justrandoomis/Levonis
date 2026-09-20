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
  NO_LINE_BENEFIT,
  NO_SHIPPING_BENEFIT,
  NO_TAX_BENEFIT,
  isUnitExpressible,
  lineBenefit,
  SCOPE_RANK,
  selectRule,
  shippingAfterBenefit,
  shippingBenefit,
  taxBenefit,
  withinWindow,
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
import { newId } from './crypto';

/* ------------------------------ when the feature was never installed ------ */

/**
 * IS THIS FAILURE "THE TABLE IS NOT THERE", AND NOTHING ELSE?
 *
 * THE DEFECT THIS EXISTS FOR. Code always reaches a deployment a moment
 * before its migration does. `GET /api/cart` is the only customer screen that
 * PRICES A MEMBERSHIP, so it is the only one that reads
 * `membership_benefit_rules` (0074) — and on a database where 0074 has not
 * been applied, `activeBenefitRules` threw `no such table` before a single
 * cart row had been read. The orders, points and farm screens never touch
 * that table, so the worker looked alive while the cart answered 500 and the
 * customer got «خطأ في الخادم / حدث خطأ من جهتنا» with a retry button that
 * could never succeed. `worker/routes/admin.ts` hit the same wall on
 * 2026-08-30 with `chats.order_id` and answered it the same way.
 *
 * WHY THIS IS AN HONEST DEGRADE AND NOT A SWALLOWED ERROR — the whole
 * argument, because getting it wrong means selling at the wrong price:
 *
 *   A TABLE THAT DOES NOT EXIST HOLDS NO ROWS. Every reader guarded by this
 *   helper already has a defined, correct answer for "no rows": no benefit
 *   rule means the regular price, no offer window means the regular price, no
 *   mystery pool means no product is a pool member. Returning that answer is
 *   not an approximation of the truth, it IS the truth — there is no discount
 *   being withheld and no price being guessed, because there is no
 *   configuration to read.
 *
 * WHAT IT MUST NEVER ABSORB. A lock, a busy database, an I/O error or a
 * malformed page are all failures to READ rows that may well exist. Treating
 * those as "no rows" would price a PRO member at the regular price while
 * their discount sat unread in the table — a silent wrong price, which is
 * worse than an error page. So only `no such table` / `no such column`
 * returns true here; every other error is rethrown by the callers below and
 * still reaches the customer as a 500.
 *
 * REQUIRED SCHEMA IS NOT GUARDED AT ALL. `catalogs` (0002) scopes a rule to a
 * section: if it is unreadable, rules that DO exist would quietly stop
 * matching and the member would be undercharged or overcharged. It is left to
 * throw, deliberately. The line is: a missing OPTIONAL feature table degrades,
 * a missing REQUIRED table fails loudly.
 */
export function isSchemaMissing(e: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = e;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const message =
      cursor instanceof Error ? cursor.message : typeof cursor === 'string' ? cursor : '';
    // D1 wraps SQLite's own wording: `D1_ERROR: no such table: x: SQLITE_ERROR`.
    //
    // SQLite USES TWO DIFFERENT SENTENCES FOR A MISSING COLUMN, and only one
    // of them says "no such column". A SELECT naming an absent column gives
    // `no such column: ci.fulfillment_type`; an INSERT naming one gives
    // `table points_accruals has no column named base_points`. Matching only
    // the first left every write path unrecognised — so the checkout answered
    // a missing migration with "please try again" instead of SERVICE_SETUP,
    // which is the one place the distinction mattered most.
    if (/no such (?:table|column)\b/i.test(message)) return true;
    if (/has no column named\b/i.test(message)) return true;
    cursor = cursor instanceof Error ? (cursor as { cause?: unknown }).cause : null;
  }
  return false;
}

/**
 * A MISSING TABLE, AND NOT A MISSING COLUMN. The narrower question, and the
 * only one that may be answered by degrading.
 *
 * The two are not the same fact and the difference decides a price:
 *
 *   `no such table`   — the feature is not installed. It HOLDS NO ROWS, so
 *                       "no benefit rule", "no offer", "no pool" is the
 *                       literal truth and answering it withholds nothing.
 *
 *   `no such column`  — THE TABLE IS THERE AND MAY BE FULL. Only the
 *                       projection is out of date, which is exactly what a
 *                       deploy that lands before its migration produces (0076
 *                       alone does ADD COLUMN thirteen times). Every row in it
 *                       is unread, not absent. Degrading here tells a PRO
 *                       member with three live discount rules that they have
 *                       none, and charges them the regular price at HTTP 200
 *                       with no error anywhere — the silent wrong price this
 *                       whole module exists to prevent, arriving through the
 *                       door built to prevent it.
 *
 * So a missing column is NOT degradable. It fails loudly and reaches the
 * customer as SERVICE_SETUP — «جزء من المتجر قيد التجهيز» — which is both
 * true and actionable, and gets the migration run instead of quietly
 * overcharging members until someone notices.
 *
 * `isSchemaMissing` keeps its wider meaning for the two callers that need it:
 * `safeErrorCode`, where both shapes genuinely mean "deployment ahead of its
 * database", and `cartLineRows`, which does not degrade at all — it reads
 * PRAGMA table_info and substitutes each absent column's own
 * migration-declared DEFAULT, which is the value the row would have carried.
 */
export function isMissingTable(e: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = e;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const message =
      cursor instanceof Error ? cursor.message : typeof cursor === 'string' ? cursor : '';
    if (/no such table\b/i.test(message)) return true;
    // Both of SQLite's ways of saying "that column is not here" (see
    // `isSchemaMissing`) mean the TABLE exists — so its rows are unread, not
    // absent, and nothing may be degraded away.
    if (/no such column\b/i.test(message)) return false;
    if (/has no column named\b/i.test(message)) return false;
    cursor = cursor instanceof Error ? (cursor as { cause?: unknown }).cause : null;
  }
  return false;
}

/**
 * Run an OPTIONAL feature's read; answer `fallback` when — and only when —
 * the feature's schema is not installed. `label` names the feature in the
 * server log so an owner can see which migration is missing; nothing about it
 * reaches the customer.
 */
export async function degradeIfSchemaMissing<T>(
  label: string,
  run: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    console.error(`optional feature not installed (${label}): ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

/**
 * THE CUSTOMER-SAFE NAME FOR A DATABASE FAILURE THAT ESCAPED — the other half
 * of the same question, so `no such table` is decided in ONE place.
 *
 * Not everything can degrade. A missing REQUIRED table, a missing column on
 * the cart's own SELECT, a lock: those still reach `app.onError` in
 * worker/index.ts as a 500, and until now the customer read «حدث خطأ من
 * جهتنا» — a sentence equally true of a five-second lock, a missing migration
 * and an outright bug, which are three situations with three different right
 * answers for the person reading it.
 *
 * Two of them are recognisable here and safe to name at that altitude:
 *
 *   SERVICE_SETUP  the deployment is ahead of its database. Retrying now fails
 *                  identically; only the owner running the migration fixes it.
 *   SERVICE_BUSY   the database was locked or busy. Retrying in a moment works.
 *
 * The code is ALL that crosses: no stack, no table name, no column name, no
 * SQL, no driver text. The storefront turns the code into a sentence in the
 * customer's own language (`src/components/ui/AsyncStates.tsx`), because an
 * English string chosen by the worker is the wrong sentence on an Arabic-first
 * shop. Anything unrecognised returns null and keeps the generic message.
 */
export function safeErrorCode(err: unknown): 'SERVICE_SETUP' | 'SERVICE_BUSY' | null {
  if (isSchemaMissing(err)) return 'SERVICE_SETUP';
  const seen = new Set<unknown>();
  let cursor: unknown = err;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const message = cursor instanceof Error ? cursor.message : typeof cursor === 'string' ? cursor : '';
    if (/\b(?:SQLITE_BUSY|SQLITE_LOCKED)\b|database (?:is|table is) locked/i.test(message)) return 'SERVICE_BUSY';
    cursor = cursor instanceof Error ? (cursor as { cause?: unknown }).cause : null;
  }
  return null;
}

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

/**
 * THE SECTION TREE AS AN ANCESTOR INDEX: catalog id -> itself and every
 * section above it.
 *
 * `catalogs` is a handful of rows and every cart request already reads more
 * than this, so the walk is done here rather than in SQL. It is cycle-safe by
 * construction (a visited set), because `adminTaxonomy` refuses a cycle at
 * write time but a legacy row is not worth trusting with an infinite loop.
 */
export async function catalogAncestry(db: D1Database): Promise<Map<string, string[]>> {
  const { results } = await db.prepare('SELECT id, parent_id FROM catalogs').all<{ id: string; parent_id: string | null }>();
  const parent = new Map<string, string | null>();
  for (const row of results ?? []) parent.set(String(row.id), row.parent_id ? String(row.parent_id) : null);
  const index = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      cursor = parent.get(cursor) ?? null;
    }
    index.set(id, chain);
  }
  return index;
}

/** The sections a product belongs to, nearest first, with every ancestor. */
export function ancestryFor(
  index: Map<string, string[]> | null,
  categoryId: string | null,
  subCategoryId: string | null
): string[] | null {
  if (!index) return null;
  const out = new Set<string>();
  for (const id of [subCategoryId, categoryId]) {
    if (!id) continue;
    for (const step of index.get(id) ?? [id]) out.add(step);
  }
  return out.size ? [...out] : null;
}

/** Every rule, including disabled ones — the admin's view. */
export async function allBenefitRules(db: D1Database): Promise<BenefitRule[]> {
  const { results } = await db
    .prepare(`SELECT ${RULE_COLUMNS} FROM membership_benefit_rules ORDER BY tier, benefit_type, scope, priority DESC, id`)
    .all<RuleRow>();
  return (results ?? []).map(ruleFromRow).filter((r): r is BenefitRule => r !== null);
}

/** The rules a checkout may apply: switched on. The date window and the scope
 *  are decided per line by the pure selector, which needs the clock anyway.
 *
 *  THE ONE PLACE 0074's ABSENCE IS ANSWERED. Every customer-facing reader of
 *  the rules comes through here — the cart quote, the product page's
 *  membership teaser, the subscription page's benefit list and the checkout's
 *  own settlement — so a store whose 0074 has not been applied loses the
 *  BENEFITS on all four and keeps the four SCREENS, instead of losing the
 *  screens. There are no rules to apply, so every price it produces is the
 *  regular price, which is the correct price; see `degradeIfSchemaMissing`. */
export async function activeBenefitRules(db: D1Database): Promise<BenefitRule[]> {
  return degradeIfSchemaMissing(
    'membership_benefit_rules (migration 0074)',
    async () => {
      const { results } = await db
        .prepare(`SELECT ${RULE_COLUMNS} FROM membership_benefit_rules WHERE enabled = 1`)
        .all<RuleRow>();
      return (results ?? []).map(ruleFromRow).filter((r): r is BenefitRule => r !== null);
    },
    [] as BenefitRule[]
  );
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
  /** Every section above the two above — see `ancestryFor`. */
  ancestry?: readonly string[] | null;
  /** The REGULAR unit price this line resolved to, before any membership. */
  regular_unit_iqd: number;
  /** What the buyer is actually charged per unit, after the ladder. */
  applied_unit_iqd: number;
  qty: number;
  /**
   * THE RULE `resolveUnitPrice` ACTUALLY CREDITED for this line's member
   * price — `ResolvedPrice.member_rule` for the buyer's own tier — or null
   * when the price came from a typed number, from an offer, or from nothing.
   *
   * Without this the resolver reports a saving the customer never received.
   * A product can carry BOTH a typed `pro_price_iqd` and a matching rule, and
   * the typed price wins outright (`memberPrice` in packages/pricing): the
   * rule is never applied. Recomputing the rule's arithmetic here anyway
   * credited it with the whole discount while the unit price had moved by
   * whatever the owner typed — on a 1,000,000 product with a typed PRO price
   * of 950,000 and a store-wide 10% rule, the cart said the membership saved
   * 100,000 beside a gap of 50,000, and the order snapshot froze the wrong
   * number onto the row.
   *
   * Optional so a caller that genuinely has no resolver output (the pure
   * tests) can omit it; when it is omitted the actual movement is used
   * instead, which is the same answer wherever there is one to check.
   */
  applied_rule_id?: string | null;
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
      {
        product_id: line.product_id,
        category_id: line.category_id,
        sub_category_id: line.sub_category_id,
        ancestry: line.ancestry ?? null,
      },
      nowIso,
      merchandise
    );
    const computed = lineBenefit({ regularUnitIqd: line.regular_unit_iqd, qty: line.qty, rule });

    /**
     * A LINE IS ONLY CREDITED WITH WHAT ITS PRICE ACTUALLY MOVED.
     *
     * For a rule that lives in the unit price, `resolveUnitPrice` has already
     * decided the answer, and it may not be this rule's answer: a typed member
     * price on any rung beats it outright, an offer window can replace the
     * regular price under it, and `clampMemberLadder` can lower it further
     * still. So the arithmetic below is a CHECK, not the source — the figure
     * reported is the gap between what this line costs and what it would have
     * cost, which is the only number that can be true by construction.
     *
     * A rule applied at the LINE is untouched: its whole point is that it is
     * NOT in the unit price, so there is no movement to measure and the
     * caller's subtraction is the thing being described.
     */
    if (computed.applied_at === 'line') return { product_id: line.product_id, ...computed };

    const moved = Math.max(0, Math.trunc(line.regular_unit_iqd) - Math.trunc(line.applied_unit_iqd));
    if (moved <= 0) return { product_id: line.product_id, ...NO_LINE_BENEFIT, applied_at: computed.applied_at };

    // The SAVING is the movement — whatever produced it. The customer saved
    // what they saved, and a figure that disagreed with the two prices beside
    // it on the screen would be wrong however it was arrived at.
    //
    // The RULE ID is a separate question, and it is the one the old code got
    // wrong: a rule is named only when the resolver says that rule is why this
    // price is what it is. A typed member price, an offer window, or a clamp
    // to the other tier's number all produce a real saving that this rule did
    // not cause, and crediting it would put the wrong id on the order row and
    // the wrong explanation on the receipt.
    const credited = line.applied_rule_id === undefined
      ? computed.rule_id
      : line.applied_rule_id !== null && line.applied_rule_id === computed.rule_id
        ? computed.rule_id
        : null;
    const qty = Math.max(0, Math.trunc(line.qty));
    return {
      product_id: line.product_id,
      ...computed,
      rule_id: credited,
      scope: credited ? computed.scope : null,
      discount_mode: credited ? computed.discount_mode : null,
      capped_by: credited ? computed.capped_by : 'none',
      per_unit_iqd: moved,
      eligible_qty: qty,
      total_iqd: moved * qty,
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

/**
 * The version an order placed right now is priced under.
 *
 * `null` already means "no rule set has ever been written", which is exactly
 * what an uninstalled 0074 is, and `orders.benefit_version_id` is nullable for
 * that case. The WRITE side is untouched: `saveBenefitRule` and `appendVersion`
 * still throw on a missing table, because failing to RECORD a rule change
 * silently is a different and much worse thing than failing to read one.
 */
export async function currentBenefitVersionId(db: D1Database): Promise<number | null> {
  return degradeIfSchemaMissing(
    'membership_benefit_versions (migration 0074)',
    async () => {
      const row = await db
        .prepare('SELECT id FROM membership_benefit_versions ORDER BY id DESC LIMIT 1')
        .first<{ id: number }>();
      return row ? Number(row.id) : null;
    },
    null as number | null
  );
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

/** The product-scoped subset accepted by the CSV/TXT import formats. */
export interface ProductMembershipMutation {
  tier: 'pro' | 'prime';
  remove: boolean;
  discount_mode: 'percent' | 'fixed' | null;
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: 'per_unit' | 'per_order' | null;
  max_quantity: number | null;
}

export interface ProductMembershipWritePlan {
  statements: D1PreparedStatement[];
  changedRuleIds: string[];
}

const membershipRuleOrder = (a: BenefitRule, b: BenefitRule): number =>
  a.tier.localeCompare(b.tier) ||
  a.benefit_type.localeCompare(b.benefit_type) ||
  a.scope.localeCompare(b.scope) ||
  b.priority - a.priority ||
  a.id.localeCompare(b.id);

const plannedBenefitRule = (write: RuleWrite): BenefitRule => ({
  id: write.id,
  tier: write.tier,
  benefit_type: write.benefit_type,
  scope: write.scope,
  category_id: write.category_id,
  sub_category_id: write.sub_category_id,
  product_id: write.product_id,
  discount_mode: write.discount_mode,
  percent: write.percent,
  fixed_iqd: write.fixed_iqd,
  max_discount_iqd: write.max_discount_iqd,
  cap_scope: write.cap_scope,
  max_quantity: write.max_quantity,
  min_subtotal_iqd: write.min_subtotal_iqd,
  free_shipping_threshold_iqd: write.free_shipping_threshold_iqd,
  shipping_methods: write.shipping_methods,
  max_shipping_subsidy_iqd: write.max_shipping_subsidy_iqd,
  cod_tax_exempt: write.cod_tax_exempt,
  enabled: write.enabled,
  priority: write.priority,
  valid_from: write.valid_from,
  valid_until: write.valid_until,
  label: write.label,
});

/**
 * Plan product membership rules without committing them.
 *
 * The ordinary membership admin owns a complete atomic batch of rule +
 * version + audit. An import has a larger transaction boundary: the rule must
 * commit with the product row and relations too. Returning statements rather
 * than invoking `saveBenefitRule` lets that caller append the exact same three
 * records to its ProductSavePlan batch.
 */
export async function planProductMembershipRules(
  db: D1Database,
  actorId: string,
  productId: string,
  requested: readonly ProductMembershipMutation[]
): Promise<ProductMembershipWritePlan> {
  if (requested.length === 0) return { statements: [], changedRuleIds: [] };

  const [allBefore, productResult] = await Promise.all([
    allBenefitRules(db),
    db
      .prepare(
        `SELECT ${RULE_COLUMNS}
           FROM membership_benefit_rules
          WHERE benefit_type = 'product_discount' AND scope = 'product' AND product_id = ?
          ORDER BY tier, priority DESC, id`
      )
      .bind(productId)
      .all<RuleRow>(),
  ]);
  let allRules = [...allBefore].sort(membershipRuleOrder);
  let productRows = [...(productResult.results ?? [])];
  const statements: D1PreparedStatement[] = [];
  const changedRuleIds: string[] = [];

  const appendVersionAndAudit = async (
    action: 'create' | 'update' | 'delete',
    ruleId: string,
    before: RuleRow | null,
    after: RuleWrite | null
  ): Promise<void> => {
    statements.push(
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
          JSON.stringify([...allRules].sort(membershipRuleOrder))
        )
    );
    const audited = await auditStatements(db, actorId, `membership_benefit.${action}`, ruleId, {
      before: before ? { ...before } : null,
      after: after ? { ...after } : null,
    });
    statements.push(...audited.statements);
  };

  for (const item of requested) {
    const matching = productRows
      .filter((rule) => rule.tier === item.tier)
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

    if (item.remove) {
      for (const before of matching) {
        statements.push(db.prepare('DELETE FROM membership_benefit_rules WHERE id = ?').bind(before.id));
        productRows = productRows.filter((row) => row.id !== before.id);
        allRules = allRules.filter((row) => row.id !== before.id);
        changedRuleIds.push(before.id);
        await appendVersionAndAudit('delete', before.id, before, null);
      }
      continue;
    }

    const existing = matching[0] ?? null;
    const kept = <T>(column: keyof RuleRow): T | null =>
      existing ? ((existing[column] as T | null) ?? null) : null;
    const write: RuleWrite = {
      id: existing?.id ?? newId('mbr'),
      tier: item.tier,
      benefit_type: 'product_discount',
      scope: 'product',
      category_id: null,
      sub_category_id: null,
      product_id: productId,
      discount_mode: item.discount_mode,
      percent: item.percent,
      fixed_iqd: item.fixed_iqd,
      max_discount_iqd: item.max_discount_iqd,
      cap_scope: item.cap_scope,
      max_quantity: item.max_quantity,
      min_subtotal_iqd: kept<number>('min_subtotal_iqd'),
      free_shipping_threshold_iqd: null,
      shipping_methods: null,
      max_shipping_subsidy_iqd: null,
      cod_tax_exempt: null,
      enabled: existing ? existing.enabled === 1 : true,
      priority: existing?.priority ?? 0,
      valid_from: kept<string>('valid_from'),
      valid_until: kept<string>('valid_until'),
      label: kept<string>('label'),
      notes: kept<string>('notes'),
    };
    statements.push(
      db
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
          write.id,
          write.tier,
          write.benefit_type,
          write.scope,
          write.category_id,
          write.sub_category_id,
          write.product_id,
          write.discount_mode,
          write.percent,
          write.fixed_iqd,
          write.max_discount_iqd,
          write.cap_scope,
          write.max_quantity,
          write.min_subtotal_iqd,
          write.free_shipping_threshold_iqd,
          null,
          write.max_shipping_subsidy_iqd,
          null,
          write.enabled ? 1 : 0,
          write.priority,
          write.valid_from,
          write.valid_until,
          write.label,
          write.notes,
          actorId
        )
    );
    const next = plannedBenefitRule(write);
    allRules = allRules.some((rule) => rule.id === write.id)
      ? allRules.map((rule) => (rule.id === write.id ? next : rule))
      : [...allRules, next];
    productRows = existing
      ? productRows.map((rule) => (rule.id === existing.id ? {
          ...rule,
          tier: write.tier,
          discount_mode: write.discount_mode,
          percent: write.percent,
          fixed_iqd: write.fixed_iqd,
          max_discount_iqd: write.max_discount_iqd,
          cap_scope: write.cap_scope,
          max_quantity: write.max_quantity,
          min_subtotal_iqd: write.min_subtotal_iqd,
          enabled: write.enabled ? 1 : 0,
          priority: write.priority,
          valid_from: write.valid_from,
          valid_until: write.valid_until,
          label: write.label,
          notes: write.notes,
        } : rule))
      : [...productRows, {
          id: write.id,
          tier: write.tier,
          benefit_type: 'product_discount',
          scope: 'product',
          category_id: null,
          sub_category_id: null,
          product_id: productId,
          discount_mode: write.discount_mode,
          percent: write.percent,
          fixed_iqd: write.fixed_iqd,
          max_discount_iqd: write.max_discount_iqd,
          cap_scope: write.cap_scope,
          max_quantity: write.max_quantity,
          min_subtotal_iqd: write.min_subtotal_iqd,
          free_shipping_threshold_iqd: null,
          shipping_methods: null,
          max_shipping_subsidy_iqd: null,
          cod_tax_exempt: null,
          enabled: write.enabled ? 1 : 0,
          priority: write.priority,
          valid_from: write.valid_from,
          valid_until: write.valid_until,
          label: write.label,
          notes: write.notes,
        }];
    changedRuleIds.push(write.id);
    await appendVersionAndAudit(existing ? 'update' : 'create', write.id, existing, write);
  }

  return { statements, changedRuleIds };
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

/* ------------------------------------------------------- the public view */

export interface PublicDiscountRule {
  rule_id: string;
  scope: BenefitRule['scope'];
  /** The section, sub-section or product the rule covers, named. */
  target_id: string | null;
  target_name_ar: string;
  target_name_en: string;
  discount_mode: BenefitRule['discount_mode'];
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: BenefitRule['cap_scope'];
  max_quantity: number | null;
  min_subtotal_iqd: number | null;
  label: string | null;
}

export interface PublicTierBenefits {
  discounts: PublicDiscountRule[];
  free_shipping: {
    rule_id: string;
    threshold_iqd: number | null;
    methods: DeliveryMethodId[] | null;
    max_subsidy_iqd: number | null;
  } | null;
  cod_tax_exempt: boolean;
}

/**
 * WHAT THE STORE CURRENTLY PROMISES EACH TIER — the same rows the checkout
 * reads, named and stripped of anything internal.
 *
 * This exists so the subscription page can STATE the benefits instead of
 * carrying its own copy of them (§22). A percentage that lives in a React
 * string is a promise nobody can keep: the owner lowers it in the admin, the
 * page keeps advertising the old one, and the customer finds out at checkout.
 *
 * `notes` never leaves the server — it is the owner's note to themselves.
 * Rules that are switched off or outside their window are omitted, because
 * this is a list of what a member gets TODAY.
 */
export async function publicBenefitSummary(
  db: D1Database,
  nowIso: string
): Promise<Record<'prime' | 'pro', PublicTierBenefits>> {
  const [rules, { results: catalogRows }] = await Promise.all([
    activeBenefitRules(db),
    db.prepare('SELECT id, name_ar, name_en FROM catalogs').all<{ id: string; name_ar: string; name_en: string }>(),
  ]);
  const names = new Map((catalogRows ?? []).map((r) => [String(r.id), r]));

  const productIds = [...new Set(rules.filter((r) => r.scope === 'product' && r.product_id).map((r) => r.product_id!))];
  const products = new Map<string, { name_ar: string; name: string }>();
  if (productIds.length) {
    const { results } = await db
      .prepare(`SELECT id, name_ar, name FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`)
      .bind(...productIds)
      .all<{ id: string; name_ar: string; name: string }>();
    for (const row of results ?? []) products.set(String(row.id), { name_ar: row.name_ar, name: row.name });
  }

  const empty = (): PublicTierBenefits => ({ discounts: [], free_shipping: null, cod_tax_exempt: false });
  const out: Record<'prime' | 'pro', PublicTierBenefits> = { prime: empty(), pro: empty() };

  for (const rule of rules) {
    if (rule.tier !== 'prime' && rule.tier !== 'pro') continue;
    if (!withinWindow(rule, nowIso)) continue;
    const bucket = out[rule.tier];
    if (rule.benefit_type === 'product_discount') {
      const targetId = rule.scope === 'product' ? rule.product_id : rule.scope === 'sub_category' ? rule.sub_category_id : rule.category_id;
      const catalog = targetId ? names.get(targetId) : undefined;
      const product = targetId ? products.get(targetId) : undefined;
      bucket.discounts.push({
        rule_id: rule.id,
        scope: rule.scope,
        target_id: targetId ?? null,
        target_name_ar: product?.name_ar ?? catalog?.name_ar ?? '',
        target_name_en: product?.name ?? catalog?.name_en ?? '',
        discount_mode: rule.discount_mode,
        percent: rule.percent,
        fixed_iqd: rule.fixed_iqd,
        max_discount_iqd: rule.max_discount_iqd,
        cap_scope: rule.cap_scope,
        max_quantity: rule.max_quantity,
        min_subtotal_iqd: rule.min_subtotal_iqd,
        label: rule.label,
      });
    } else if (rule.benefit_type === 'free_shipping') {
      // The most specific live rule wins here for the same reason it does at
      // the checkout — `selectRule`'s specificity order, of which free
      // shipping only ever uses priority.
      if (!bucket.free_shipping || rule.priority > 0) {
        bucket.free_shipping = {
          rule_id: rule.id,
          threshold_iqd: rule.free_shipping_threshold_iqd,
          methods: rule.shipping_methods,
          max_subsidy_iqd: rule.max_shipping_subsidy_iqd,
        };
      }
    } else if (rule.benefit_type === 'cod_tax_exemption') {
      bucket.cod_tax_exempt = rule.cod_tax_exempt === true;
    }
  }
  // Most specific first, so a page listing them reads "printers, filament,
  // then everything else" rather than in insertion order.
  for (const tier of ['prime', 'pro'] as const) {
    out[tier].discounts.sort((a, b) => SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope]);
  }
  return out;
}
