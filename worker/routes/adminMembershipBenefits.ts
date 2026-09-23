import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, notFound, int, str, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { getSettings } from '../lib/settings';
import { shippingConfigFrom } from './orders';
import { quoteShipping } from '../lib/shipping';
import { codDeliveryTaxIqd } from '../lib/codTax';
import { resolveUnitPrice, proPolicyFrom } from '../lib/pricing';
import { parseProductRow } from '../lib/productModel';
import type { DeliveryMethod } from '../lib/settings';
import {
  allBenefitRules,
  ancestryFor,
  catalogAncestry,
  currentBenefitVersionId,
  deleteBenefitRule,
  fallbackFor,
  resolveMembershipBenefits,
  saveBenefitRule,
  type RuleWrite,
} from '../lib/membershipBenefits';
import type { TierStatus } from '../lib/entitlements';
import { auditStatements } from '../lib/audit';
import { selectRule, type BenefitRule, type DeliveryMethodId } from '@levonis/pricing/membershipBenefits';

/**
 * THE OWNER'S CONTROL PANEL FOR WHAT A MEMBERSHIP IS WORTH.
 *
 * Every commercial value PRO and PREMIUM shopping benefits are made of lives
 * in `membership_benefit_rules` and is edited here — a percentage, a fixed
 * amount, a ceiling, a quantity, the sections it covers, the delivery methods
 * free shipping applies to, whether cash-on-delivery tax is waived, the dates
 * it runs between, and the order two rules at the same level are read in.
 * Nothing on this path is a constant in a React file or a branch on a tier
 * name, which is the whole point: the owner changes a number and the next
 * order follows, with no deploy.
 *
 * WHAT THIS ROUTER DOES NOT DO: recalculate anything already sold. Every write
 * appends a VERSION, and every order records the version it was priced under
 * together with the money it produced (`orders.benefit_snapshot`). Yesterday's
 * totals are read from the order, never re-derived from today's rules.
 */
export const adminMembershipBenefitRoutes = new Hono<AppContext>();
adminMembershipBenefitRoutes.use('*', requireAdmin);

const TIERS = ['plus', 'prime', 'pro'] as const;
const TYPES = ['product_discount', 'free_shipping', 'cod_tax_exemption'] as const;
const SCOPES = ['global', 'category', 'sub_category', 'product'] as const;
const MODES = ['percent', 'fixed'] as const;
const CAP_SCOPES = ['per_unit', 'per_order'] as const;
const METHODS: DeliveryMethodId[] = ['standard', 'personal'];

/** An optional integer field: absent/null stays null, anything else must be a
 *  whole number of dinars at or above zero. A silent coercion here is a price
 *  nobody typed. */
function optInt(value: unknown, field: string, max = 1_000_000_000): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw badRequest(`${field} must be a whole number of dinars between 0 and ${max.toLocaleString()}`, 'VALIDATION');
  }
  return n;
}

function optIso(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value);
  if (!Number.isFinite(Date.parse(s))) throw badRequest(`${field} must be an ISO timestamp`, 'VALIDATION');
  return new Date(s).toISOString();
}

/**
 * THE DOOR THE ADMIN SCREEN WRITES THROUGH — and every refusal here is a
 * sentence, because a rule that saves but can never apply is worse than one
 * that refuses to save.
 */
function ruleFromBody(body: Record<string, unknown>, id: string): RuleWrite {
  const tier = oneOf(body.tier, 'tier', TIERS);
  const benefitType = oneOf(body.benefit_type, 'benefit_type', TYPES);
  const scope = oneOf(body.scope ?? 'global', 'scope', SCOPES);

  /**
   * PLUS HAS NO PRICING OR DELIVERY ENTITLEMENT (worker/lib/entitlements.ts
   * `ENTITLEMENT_MINIMUM_TIER`: proPricing needs PRO, premiumPricing and
   * premiumDelivery need PREMIUM). A PLUS rule would therefore save cleanly
   * and then do nothing at every checkout, forever, with no error anywhere —
   * so it is refused at the door with the reason.
   */
  if (tier === 'plus') {
    throw badRequest(
      'PLUS has no shopping-benefit entitlement, so a PLUS rule would never apply. Use PREMIUM or PRO.',
      'BENEFIT_TIER_NOT_ENTITLED'
    );
  }

  const categoryId = str(body.category_id, 'category_id', { max: 60, required: false }) || null;
  const subCategoryId = str(body.sub_category_id, 'sub_category_id', { max: 60, required: false }) || null;
  const productId = str(body.product_id, 'product_id', { max: 60, required: false }) || null;
  if (scope === 'category' && !categoryId) throw badRequest('Choose a section for a section rule', 'VALIDATION');
  if (scope === 'sub_category' && !subCategoryId) throw badRequest('Choose a sub-section for a sub-section rule', 'VALIDATION');
  if (scope === 'product' && !productId) throw badRequest('Choose a product for a product rule', 'VALIDATION');

  const discountMode = body.discount_mode === undefined || body.discount_mode === null || body.discount_mode === ''
    ? null
    : oneOf(body.discount_mode, 'discount_mode', MODES);
  const percent = body.percent === undefined || body.percent === null || body.percent === ''
    ? null
    : int(body.percent, 'percent', { min: 1, max: 100 });
  const fixedIqd = optInt(body.fixed_iqd, 'fixed_iqd');
  const capScope = body.cap_scope === undefined || body.cap_scope === null || body.cap_scope === ''
    ? null
    : oneOf(body.cap_scope, 'cap_scope', CAP_SCOPES);
  const maxDiscount = optInt(body.max_discount_iqd, 'max_discount_iqd');
  const maxQuantity = body.max_quantity === undefined || body.max_quantity === null || body.max_quantity === ''
    ? null
    : int(body.max_quantity, 'max_quantity', { min: 1, max: 9999 });

  const methodsRaw = body.shipping_methods;
  let shippingMethods: DeliveryMethodId[] | null = null;
  if (Array.isArray(methodsRaw)) {
    shippingMethods = [...new Set(methodsRaw.map((m) => String(m)))].filter((m): m is DeliveryMethodId =>
      METHODS.includes(m as DeliveryMethodId)
    );
  }

  const validFrom = optIso(body.valid_from, 'valid_from');
  const validUntil = optIso(body.valid_until, 'valid_until');
  if (validFrom && validUntil && validUntil <= validFrom) {
    throw badRequest('The end of the window must be after its start', 'VALIDATION');
  }

  if (benefitType === 'product_discount') {
    if (discountMode === null) throw badRequest('A discount rule needs a percentage or a fixed amount', 'VALIDATION');
    if (discountMode === 'percent' && percent === null) throw badRequest('Enter the percentage', 'VALIDATION');
    if (discountMode === 'fixed' && (fixedIqd === null || fixedIqd <= 0)) {
      throw badRequest('Enter the amount in dinars', 'VALIDATION');
    }
    // A ceiling with no scope, or a scope with no ceiling, is half a sentence:
    // "up to 100,000" means nothing until it says per what.
    if (maxDiscount !== null && capScope === null) {
      throw badRequest('Say whether the ceiling is per unit or per order', 'VALIDATION');
    }
    if (capScope !== null && maxDiscount === null) {
      throw badRequest('Enter the ceiling, or clear the per-unit/per-order choice', 'VALIDATION');
    }
  }
  if (benefitType === 'free_shipping' && shippingMethods !== null && shippingMethods.length === 0) {
    throw badRequest('Choose at least one delivery method, or leave the list empty to cover all of them', 'VALIDATION');
  }

  return {
    id,
    tier,
    benefit_type: benefitType,
    scope,
    category_id: scope === 'category' ? categoryId : scope === 'sub_category' ? categoryId : null,
    sub_category_id: scope === 'sub_category' ? subCategoryId : null,
    product_id: scope === 'product' ? productId : null,
    discount_mode: benefitType === 'product_discount' ? discountMode : null,
    percent: benefitType === 'product_discount' && discountMode === 'percent' ? percent : null,
    fixed_iqd: benefitType === 'product_discount' && discountMode === 'fixed' ? fixedIqd : null,
    max_discount_iqd: benefitType === 'product_discount' ? maxDiscount : null,
    cap_scope: benefitType === 'product_discount' ? capScope : null,
    max_quantity: benefitType === 'product_discount' ? maxQuantity : null,
    min_subtotal_iqd: optInt(body.min_subtotal_iqd, 'min_subtotal_iqd'),
    free_shipping_threshold_iqd: benefitType === 'free_shipping' ? optInt(body.free_shipping_threshold_iqd, 'free_shipping_threshold_iqd') : null,
    shipping_methods: benefitType === 'free_shipping' ? shippingMethods : null,
    max_shipping_subsidy_iqd: benefitType === 'free_shipping' ? optInt(body.max_shipping_subsidy_iqd, 'max_shipping_subsidy_iqd') : null,
    cod_tax_exempt: benefitType === 'cod_tax_exemption' ? body.cod_tax_exempt === true : null,
    enabled: body.enabled !== false,
    priority: body.priority === undefined || body.priority === null || body.priority === ''
      ? 0
      : int(body.priority, 'priority', { min: -999, max: 999 }),
    valid_from: validFrom,
    valid_until: validUntil,
    label: str(body.label, 'label', { max: 120, required: false }) || null,
    notes: str(body.notes, 'notes', { max: 2000, required: false }) || null,
  };
}

/** The whole configuration, with the units each number is in so the screen
 *  never has to guess whether a field is a percentage or dinars (§6). */
adminMembershipBenefitRoutes.get('/', async (c) => {
  const [rules, versionId, settings] = await Promise.all([
    allBenefitRules(c.env.DB),
    currentBenefitVersionId(c.env.DB),
    getSettings(c.env.DB, ['checkoutDeliveryMethods']),
  ]);
  const methods = (settings.checkoutDeliveryMethods as DeliveryMethod[] | undefined) ?? [];
  return c.json({
    success: true,
    rules,
    version_id: versionId,
    /** The fields, their units and their ranges — one place, so the admin
     *  screen renders "%" and "د.ع" from the server's word and not its own. */
    schema: {
      tiers: ['prime', 'pro'],
      benefit_types: TYPES,
      scopes: SCOPES,
      discount_modes: MODES,
      cap_scopes: CAP_SCOPES,
      delivery_methods: methods
        .filter((m) => METHODS.includes(m.id as DeliveryMethodId))
        .map((m) => ({ id: m.id, title_ar: m.titleAr, title_en: m.titleEn, price_iqd: m.price_iqd })),
      units: {
        percent: 'percent',
        fixed_iqd: 'iqd',
        max_discount_iqd: 'iqd',
        max_quantity: 'quantity',
        min_subtotal_iqd: 'iqd',
        free_shipping_threshold_iqd: 'iqd',
        max_shipping_subsidy_iqd: 'iqd',
      },
    },
  });
});

/** Who changed what, when, and what it was before (§21). */
adminMembershipBenefitRoutes.get('/versions', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 30 });
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.created_at, v.actor_user_id, v.action, v.rule_id, v.before_json, v.after_json,
            u.name AS actor_name, u.email AS actor_email
       FROM membership_benefit_versions v
       LEFT JOIN users u ON u.id = v.actor_user_id
      ORDER BY v.id DESC LIMIT ?`
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  return c.json({ success: true, versions: results ?? [] });
});

adminMembershipBenefitRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const rule = ruleFromBody(body, newId('mbr'));
  const versionId = await saveBenefitRule(c.env, user.id, rule, 'create');
  return c.json({ success: true, rule, version_id: versionId });
});

adminMembershipBenefitRoutes.put('/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM membership_benefit_rules WHERE id = ?').bind(id).first();
  if (!existing) throw notFound('That benefit rule no longer exists');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const rule = ruleFromBody(body, id);
  const versionId = await saveBenefitRule(c.env, user.id, rule, 'update');
  return c.json({ success: true, rule, version_id: versionId });
});

adminMembershipBenefitRoutes.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM membership_benefit_rules WHERE id = ?').bind(id).first();
  if (!existing) throw notFound('That benefit rule no longer exists');
  const versionId = await deleteBenefitRule(c.env, user.id, id);
  return c.json({ success: true, version_id: versionId });
});

/* ------------------------------------------------- recommended starting values */

/**
 * THE MANDATE'S INITIAL DEFAULTS, offered as a STARTING POINT.
 *
 * Migration 0074 deliberately seeds no product discount: a global "PRO 10%
 * off" would discount the entire catalogue on the first deploy, and a section
 * rule cannot be seeded because it must name sections whose ids a migration
 * cannot know. So the owner presses a button instead, against the sections
 * that actually exist in THEIR taxonomy, and then edits every number.
 *
 * Nothing here is permanent and nothing here is special: each rule it creates
 * is an ordinary row the owner can change or delete, and running it twice
 * creates nothing the second time.
 */
const RECOMMENDED: Array<{
  key: string;
  slugs: string[];
  tier: 'pro' | 'prime';
  label: string;
  /**
   * Only the owner's own two printer figures are created LIVE. Every other
   * suggestion is this file's guess, not the owner's decision, so it lands
   * switched off: it is on the screen to be read, and it discounts nothing
   * until the owner turns it on.
   */
  enabled: boolean;
  fields: Partial<RuleWrite>;
}> = [
  {
    key: 'pro-printers',
    slugs: ['printers', '3d-printers'],
    tier: 'pro',
    label: 'PRO — طابعات',
    enabled: true,
    fields: { discount_mode: 'percent', percent: 10, max_discount_iqd: 100_000, cap_scope: 'per_unit' },
  },
  {
    key: 'pro-materials',
    slugs: ['materials', 'filament'],
    tier: 'pro',
    label: 'PRO — مواد',
    enabled: false,
    fields: { discount_mode: 'percent', percent: 15 },
  },
  {
    key: 'pro-accessories',
    slugs: ['accessories', 'printer-accessories'],
    tier: 'pro',
    label: 'PRO — إكسسوارات',
    enabled: false,
    fields: { discount_mode: 'percent', percent: 10 },
  },
  /**
   * THE OWNER'S FIGURE: «البريميوم خصم حتى 25,000 لكل وحدة على الطابعات فقط».
   * A FIXED 25,000 per unit, not "100% capped at 25,000": `unitDiscountIqd`
   * already never takes more than the unit costs, so a fixed amount IS "up to
   * 25,000 per unit", while a 100% rule would read as a free printer to anyone
   * who opens it. The ceiling is written too (25,000, per unit) so the row
   * passes the same validation as one typed in the dialog, and the public
   * line prints it once (a ceiling equal to the amount is not repeated).
   */
  {
    key: 'premium-printers',
    slugs: ['printers', '3d-printers'],
    tier: 'prime',
    label: 'PREMIUM — طابعات',
    enabled: true,
    fields: { discount_mode: 'fixed', fixed_iqd: 25_000, max_discount_iqd: 25_000, cap_scope: 'per_unit' },
  },
];

const BLANK_RULE: Omit<RuleWrite, 'id' | 'tier' | 'benefit_type' | 'scope' | 'label'> = {
  category_id: null,
  sub_category_id: null,
  product_id: null,
  discount_mode: null,
  percent: null,
  fixed_iqd: null,
  max_discount_iqd: null,
  cap_scope: null,
  max_quantity: null,
  min_subtotal_iqd: null,
  free_shipping_threshold_iqd: null,
  shipping_methods: null,
  max_shipping_subsidy_iqd: null,
  cod_tax_exempt: null,
  enabled: true,
  priority: 0,
  valid_from: null,
  valid_until: null,
  notes: null,
};

/** One suggestion as the confirmation dialog lists it, and as POST writes it. */
export interface RecommendedPlanEntry {
  key: string;
  category_name_ar: string;
  category_name_en: string;
  rule: RuleWrite;
}

async function planRecommended(db: D1Database): Promise<{
  entries: RecommendedPlanEntry[];
  skipped: Array<{ key: string; reason: 'NO_MATCHING_SECTION' | 'ALREADY_CONFIGURED' }>;
}> {
  const [existing, { results: catalogs }] = await Promise.all([
    allBenefitRules(db),
    db
      .prepare('SELECT id, slug, name_ar, name_en FROM catalogs WHERE parent_id IS NULL')
      .all<{ id: string; slug: string; name_ar: string | null; name_en: string | null }>(),
  ]);
  const bySlug = new Map((catalogs ?? []).map((row) => [String(row.slug), row]));

  const entries: RecommendedPlanEntry[] = [];
  const skipped: Array<{ key: string; reason: 'NO_MATCHING_SECTION' | 'ALREADY_CONFIGURED' }> = [];
  for (const rec of RECOMMENDED) {
    const section = rec.slugs.map((slug) => bySlug.get(slug)).find((row) => !!row) ?? null;
    if (!section) {
      skipped.push({ key: rec.key, reason: 'NO_MATCHING_SECTION' });
      continue;
    }
    const categoryId = String(section.id);
    // An owner who already wrote a rule for this tier and section keeps it.
    // This action offers a starting point; it never overwrites a decision.
    const taken = existing.some(
      (r) => r.tier === rec.tier && r.benefit_type === 'product_discount' && r.scope === 'category' && r.category_id === categoryId
    );
    if (taken) {
      skipped.push({ key: rec.key, reason: 'ALREADY_CONFIGURED' });
      continue;
    }
    entries.push({
      key: rec.key,
      category_name_ar: section.name_ar ?? '',
      category_name_en: section.name_en ?? '',
      rule: {
        ...BLANK_RULE,
        ...rec.fields,
        id: newId('mbr'),
        tier: rec.tier,
        benefit_type: 'product_discount',
        scope: 'category',
        category_id: categoryId,
        label: rec.label,
        enabled: rec.enabled,
      },
    });
  }
  return { entries, skipped };
}

/**
 * WHAT THE BUTTON WOULD WRITE, BEFORE IT WRITES IT. The rules screen shows
 * this list — tier, section, figure, and whether each lands live or switched
 * off — in a confirmation dialog; nothing is created by opening it.
 */
adminMembershipBenefitRoutes.get('/recommended', async (c) => {
  const { entries, skipped } = await planRecommended(c.env.DB);
  return c.json({ success: true, entries, skipped });
});

/**
 * Creates the suggestions the admin CONFIRMED: the body names their keys, as
 * the dialog listed them. A key the plan no longer offers (a rule was added
 * for that section in the meantime) is skipped, never overwritten.
 */
adminMembershipBenefitRoutes.post('/recommended', async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw badRequest('Choose the recommended rules to add', 'RECOMMENDED_KEYS_REQUIRED');
  }
  const confirmed = new Set(body.keys.map((k) => String(k)));
  const { entries, skipped } = await planRecommended(c.env.DB);

  const created: RuleWrite[] = [];
  let versionId = (await currentBenefitVersionId(c.env.DB)) ?? 0;
  for (const entry of entries) {
    if (!confirmed.has(entry.key)) continue;
    versionId = await saveBenefitRule(c.env, user.id, entry.rule, 'create');
    created.push(entry.rule);
  }

  return c.json({ success: true, created, skipped, version_id: versionId });
});

/* -------------------------------------------- per-product rules -> one section rule */

/**
 * «تحويل إلى قاعدة قسم» — THE PER-PRODUCT LIST, FOLDED BACK INTO ONE SENTENCE.
 *
 * The owner states a discount on a section: «خصم 10% حتى 100,000 لكل وحدة»
 * on printers. The product editor and the import both write PRODUCT rules,
 * so a store priced that way ends up with one row per printer, all saying the
 * same thing. This groups the enabled per-product discount rules by tier, by
 * the section their product is filed under and by the exact terms they make
 * (mode, figure, ceiling and its scope, quantity, minimum order, window), and
 * offers each group as ONE section rule.
 *
 * A SECTION RULE REACHES MORE THAN THE PRODUCTS IT REPLACES — every product
 * filed under the section. So each group is priced before and after on every
 * active product in the section with the checkout's own `selectRule`, and the
 * screen is told how many other products the section rule would start (or
 * stop) discounting. A product whose price the conversion would CHANGE — a
 * sub-section rule would win once its product rule is gone, say — is left out
 * of the group and keeps its own rule.
 *
 * Refused, with the reason, where one section rule cannot say the same thing:
 *   SECTION_RULE_EXISTS — the section already has a rule for this tier with
 *     different terms; two section rules would compete on priority.
 *   ORDER_WIDE_LIMIT    — a per-order ceiling or a quantity limit is spent once
 *     per RULE per order (`orderLineBenefits`); folding N rules into one
 *     would turn N budgets into one.
 * When the section already has a rule with exactly these terms the product
 * rules are redundant, and the action only deletes them.
 */
interface ConsolidationTerms {
  discount_mode: BenefitRule['discount_mode'];
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: BenefitRule['cap_scope'];
  max_quantity: number | null;
  min_subtotal_iqd: number | null;
  valid_from: string | null;
  valid_until: string | null;
}

export interface ConsolidationGroup {
  key: string;
  tier: 'prime' | 'pro';
  category_id: string;
  category_name_ar: string;
  category_name_en: string;
  terms: ConsolidationTerms;
  /** The product rules the action deletes. */
  rule_ids: string[];
  /** Product rules in the group whose product would be priced differently
   *  without them; they are left alone. */
  kept_rule_ids: string[];
  /** Other active products in the section whose discount the section rule
   *  would change (almost always: products that had none and would get one). */
  other_products_affected: number;
  mode: 'create' | 'delete_only' | 'blocked';
  reason: 'SECTION_RULE_EXISTS' | 'ORDER_WIDE_LIMIT' | null;
  existing_rule_id: string | null;
}

const termsOf = (r: BenefitRule): ConsolidationTerms => ({
  discount_mode: r.discount_mode,
  percent: r.discount_mode === 'percent' ? r.percent : null,
  fixed_iqd: r.discount_mode === 'fixed' ? r.fixed_iqd : null,
  max_discount_iqd: r.max_discount_iqd,
  cap_scope: r.max_discount_iqd === null ? null : r.cap_scope,
  max_quantity: r.max_quantity,
  min_subtotal_iqd: r.min_subtotal_iqd,
  valid_from: r.valid_from,
  valid_until: r.valid_until,
});
const termsKey = (t: ConsolidationTerms): string => JSON.stringify(Object.values(t));
/** What a rule does to a price — `null` for no rule — so before and after compare. */
const effectOf = (r: BenefitRule | null): string => (r ? termsKey(termsOf(r)) : 'none');

async function planConsolidation(db: D1Database, nowIso: string): Promise<{ groups: ConsolidationGroup[]; product_rule_count: number; rules: BenefitRule[] }> {
  const [rules, tree, { results: productRows }, { results: catalogRows }] = await Promise.all([
    allBenefitRules(db),
    catalogAncestry(db),
    db
      .prepare("SELECT id, category_id, sub_category_id FROM products WHERE status = 'active'")
      .all<{ id: string; category_id: string | null; sub_category_id: string | null }>(),
    db.prepare('SELECT id, name_ar, name_en FROM catalogs').all<{ id: string; name_ar: string; name_en: string }>(),
  ]);
  const names = new Map((catalogRows ?? []).map((r) => [String(r.id), r]));
  const products = (productRows ?? []).map((p) => ({
    id: String(p.id),
    category_id: p.category_id ? String(p.category_id) : null,
    sub_category_id: p.sub_category_id ? String(p.sub_category_id) : null,
    ancestry: ancestryFor(tree, p.category_id ? String(p.category_id) : null, p.sub_category_id ? String(p.sub_category_id) : null),
  }));
  const productById = new Map(products.map((p) => [p.id, p]));

  const productRules = rules.filter((r) => r.benefit_type === 'product_discount' && r.scope === 'product' && r.product_id);
  const buckets = new Map<string, BenefitRule[]>();
  for (const rule of productRules) {
    if (!rule.enabled || (rule.tier !== 'pro' && rule.tier !== 'prime')) continue;
    const product = productById.get(rule.product_id!);
    if (!product?.category_id) continue;
    const key = `${rule.tier}|${product.category_id}|${termsKey(termsOf(rule))}`;
    buckets.set(key, [...(buckets.get(key) ?? []), rule]);
  }

  // Unknown order value: a minimum-order rule is compared as if reached, so
  // the before/after test sees every rule that can ever apply.
  const priceOf = (set: readonly BenefitRule[], tier: 'pro' | 'prime', p: (typeof products)[number]) =>
    selectRule(set, {
      tier,
      tierActive: true,
      benefitType: 'product_discount',
      target: { product_id: p.id, category_id: p.category_id, sub_category_id: p.sub_category_id, ancestry: p.ancestry },
      nowIso,
      subtotalIqd: Number.MAX_SAFE_INTEGER,
    });

  const groups: ConsolidationGroup[] = [];
  for (const [key, members] of buckets) {
    const first = members[0]!;
    const tier = first.tier as 'pro' | 'prime';
    const categoryId = productById.get(first.product_id!)!.category_id!;
    const terms = termsOf(first);
    // Only a LIVE section rule competes with the one this would write: a
    // switched-off rule prices nothing, so it neither blocks the conversion
    // nor makes the product rules redundant. An enabled rule with exactly
    // these terms makes them redundant wherever it sits in the list; only a
    // different enabled rule blocks.
    const sectionRules = rules.filter(
      (r) =>
        r.enabled &&
        r.tier === tier &&
        r.benefit_type === 'product_discount' &&
        r.scope === 'category' &&
        r.category_id === categoryId
    );
    const same = sectionRules.find((r) => termsKey(termsOf(r)) === termsKey(terms)) ?? null;
    const different = sectionRules.find((r) => termsKey(termsOf(r)) !== termsKey(terms)) ?? null;
    const existing = same ?? different;
    const orderWide = terms.max_quantity !== null || (terms.cap_scope === 'per_order' && terms.max_discount_iqd !== null);
    const mode: ConsolidationGroup['mode'] = orderWide ? 'blocked' : same ? 'delete_only' : different ? 'blocked' : 'create';

    const candidate: BenefitRule = {
      ...first,
      id: '__consolidated__',
      scope: 'category',
      category_id: categoryId,
      sub_category_id: null,
      product_id: null,
      priority: 0,
    };
    const memberIds = new Set(members.map((r) => r.id));
    // A blocked group is still priced as if converted, so the screen can list
    // it with the reason rather than drop it.
    const after = [...rules.filter((r) => !memberIds.has(r.id)), ...(mode === 'delete_only' ? [] : [candidate])];

    const ruleIds: string[] = [];
    const kept: string[] = [];
    let others = 0;
    const inSection = products.filter((p) => p.category_id === categoryId || (p.ancestry ?? []).includes(categoryId));
    const memberProducts = new Set(members.map((r) => r.product_id!));
    for (const rule of members) {
      const p = productById.get(rule.product_id!)!;
      const was = priceOf(rules, tier, p);
      // A product whose current price does not come from this rule, or whose
      // price would change without it, keeps it.
      if (was?.id !== rule.id || effectOf(priceOf(after, tier, p)) !== effectOf(was)) kept.push(rule.id);
      else ruleIds.push(rule.id);
    }
    for (const p of inSection) {
      if (memberProducts.has(p.id)) continue;
      if (effectOf(priceOf(rules, tier, p)) !== effectOf(priceOf(after, tier, p))) others += 1;
    }
    if (ruleIds.length === 0) continue;

    const name = names.get(categoryId);
    groups.push({
      key,
      tier,
      category_id: categoryId,
      category_name_ar: name?.name_ar ?? '',
      category_name_en: name?.name_en ?? '',
      terms,
      rule_ids: ruleIds.sort(),
      kept_rule_ids: kept.sort(),
      other_products_affected: mode === 'blocked' ? 0 : others,
      mode,
      reason: orderWide ? 'ORDER_WIDE_LIMIT' : mode === 'blocked' ? 'SECTION_RULE_EXISTS' : null,
      existing_rule_id: existing?.id ?? null,
    });
  }
  groups.sort((a, b) => b.rule_ids.length - a.rule_ids.length || a.key.localeCompare(b.key));
  return { groups, product_rule_count: productRules.length, rules };
}

adminMembershipBenefitRoutes.get('/consolidation', async (c) => {
  const { groups, product_rule_count } = await planConsolidation(c.env.DB, new Date().toISOString());
  return c.json({ success: true, product_rule_count, groups });
});

/**
 * ONE BATCH: the section rule, every deleted product rule, ONE version row
 * for the whole conversion and an audit row per rule, plus one audit row
 * naming the conversion. All of it lands or none of it does, so the store is
 * never left with the product rules gone and no section rule in their place.
 *
 * The request carries the group key AND the exact rule ids the admin was
 * shown; if the plan has moved since (a rule edited, a product re-filed), the
 * answer is 409 and nothing is written. The same holds when it moves DURING
 * the request — a second admin converting the same group, an edit landing
 * between the plan and the batch — because the batch itself is fenced.
 */
adminMembershipBenefitRoutes.post('/consolidation', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const key = str(body.key, 'key', { max: 2000 });
  const sent = Array.isArray(body.rule_ids) ? body.rule_ids.map((x) => String(x)).sort() : [];

  const { groups, rules } = await planConsolidation(db, new Date().toISOString());
  const group = groups.find((g) => g.key === key);
  if (!group || JSON.stringify(group.rule_ids) !== JSON.stringify(sent)) {
    throw conflict('These product rules have changed since the list was loaded. Reload and try again.', 'CONSOLIDATION_STALE');
  }
  if (group.mode === 'blocked') {
    throw conflict(
      group.reason === 'ORDER_WIDE_LIMIT'
        ? 'A per-order ceiling or a quantity limit cannot be folded into one section rule without changing what an order saves.'
        : 'This section already has a rule for this tier with different terms. Edit that rule instead.',
      group.reason ?? 'CONSOLIDATION_BLOCKED'
    );
  }

  const tierLabel = group.tier === 'pro' ? 'PRO' : 'PREMIUM';
  const created: RuleWrite | null =
    group.mode === 'create'
      ? {
          ...BLANK_RULE,
          ...group.terms,
          id: newId('mbr'),
          tier: group.tier,
          benefit_type: 'product_discount',
          scope: 'category',
          category_id: group.category_id,
          label: `${tierLabel} — ${group.category_name_ar || group.category_name_en || group.category_id}`,
          notes: `حُوّلت من ${group.rule_ids.length} قاعدة منتج / consolidated from ${group.rule_ids.length} product rules`,
        }
      : null;

  const { results: beforeRows } = await db
    .prepare("SELECT * FROM membership_benefit_rules WHERE scope = 'product' AND benefit_type = 'product_discount'")
    .all<Record<string, unknown>>();
  const beforeById = new Map((beforeRows ?? []).map((r) => [String(r.id), r]));
  const deleted = group.rule_ids.map((id) => beforeById.get(id));
  if (deleted.some((row) => !row)) {
    throw conflict('These product rules have changed since the list was loaded. Reload and try again.', 'CONSOLIDATION_STALE');
  }

  const statements: D1PreparedStatement[] = [];
  const sectionTaken = `EXISTS (SELECT 1 FROM membership_benefit_rules
                                 WHERE tier = ? AND benefit_type = 'product_discount' AND scope = 'category'
                                   AND category_id = ? AND enabled = 1 AND id <> ?)`;

  if (created) {
    // Conditional on the section still having no live rule for this tier: a
    // second admin (or a second tab) converting the same group at the same
    // moment inserts nothing here, and the fence below rolls its batch back.
    statements.push(
      db
        .prepare(
          `INSERT INTO membership_benefit_rules
             (id, tier, benefit_type, scope, category_id, sub_category_id, product_id, discount_mode, percent,
              fixed_iqd, max_discount_iqd, cap_scope, max_quantity, min_subtotal_iqd, free_shipping_threshold_iqd,
              shipping_methods, max_shipping_subsidy_iqd, cod_tax_exempt, enabled, priority, valid_from, valid_until,
              label, notes, updated_at, updated_by)
           SELECT ?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,1,0,?,?,?,?,datetime('now'),?
            WHERE NOT ${sectionTaken}`
        )
        .bind(
          created.id, created.tier, created.benefit_type, created.scope, created.category_id,
          created.discount_mode, created.percent, created.fixed_iqd, created.max_discount_iqd, created.cap_scope,
          created.max_quantity, created.min_subtotal_iqd, created.valid_from, created.valid_until,
          created.label, created.notes, user.id,
          created.tier, created.category_id, created.id
        )
    );
  }
  // Each product rule is deleted only if it is still the row that was planned
  // on: the same terms, the same last edit. One edited in the meantime is left
  // in place, and the fence below refuses the whole batch.
  for (const row of deleted as Array<Record<string, unknown>>) {
    statements.push(
      db
        .prepare(
          `DELETE FROM membership_benefit_rules
            WHERE id = ? AND scope = 'product' AND enabled = 1 AND tier IS ? AND product_id IS ?
              AND discount_mode IS ? AND percent IS ? AND fixed_iqd IS ? AND max_discount_iqd IS ? AND cap_scope IS ?
              AND max_quantity IS ? AND min_subtotal_iqd IS ? AND valid_from IS ? AND valid_until IS ?
              AND updated_at IS ?`
        )
        .bind(
          row.id, row.tier, row.product_id, row.discount_mode, row.percent, row.fixed_iqd, row.max_discount_iqd,
          row.cap_scope, row.max_quantity, row.min_subtotal_iqd, row.valid_from, row.valid_until, row.updated_at ?? null
        )
    );
  }

  /**
   * ONE VERSION ROW for the whole conversion, carrying the rule set as it
   * stands AFTER it — the only set any order can ever be priced under. It is
   * also THE FENCE: `rules_json` is NOT NULL, and it is written NULL (so the
   * whole batch rolls back) unless every planned product rule is gone and
   * the section holds exactly the live rule this conversion relies on.
   */
  const createdAsRule: BenefitRule | null = created
    ? (({ notes: _notes, ...rule }) => rule)({ ...created, enabled: true, priority: 0 })
    : null;
  const snapshot: BenefitRule[] = [
    ...rules.filter((r) => !group.rule_ids.includes(r.id)),
    ...(createdAsRule ? [createdAsRule] : []),
  ];
  const idMarks = group.rule_ids.map(() => '?').join(',');
  const sectionHolds = created
    ? `EXISTS (SELECT 1 FROM membership_benefit_rules WHERE id = ?) AND NOT ${sectionTaken}`
    : `EXISTS (SELECT 1 FROM membership_benefit_rules WHERE id = ? AND enabled = 1)`;
  const sectionBinds = created
    ? [created.id, created.tier, created.category_id, created.id]
    : [group.existing_rule_id];
  statements.push(
    db
      .prepare(
        `INSERT INTO membership_benefit_versions (actor_user_id, action, rule_id, before_json, after_json, rules_json)
         SELECT ?, 'consolidate', ?, ?, ?,
                CASE WHEN NOT EXISTS (SELECT 1 FROM membership_benefit_rules WHERE id IN (${idMarks}))
                       AND ${sectionHolds}
                     THEN ? ELSE NULL END`
      )
      .bind(
        user.id,
        created?.id ?? group.existing_rule_id,
        JSON.stringify(deleted),
        created ? JSON.stringify(created) : null,
        ...group.rule_ids,
        ...sectionBinds,
        JSON.stringify(snapshot)
      )
  );

  // The audit trail keeps one row per rule, as an ordinary edit would.
  if (created) {
    const audited = await auditStatements(db, user.id, 'membership_benefit.create', created.id, {
      before: null,
      after: created,
      via: 'consolidation',
    });
    statements.push(...audited.statements);
  }
  for (const row of deleted) {
    const audited = await auditStatements(db, user.id, 'membership_benefit.delete', String(row!.id), {
      before: row,
      after: null,
      via: 'consolidation',
    });
    statements.push(...audited.statements);
  }
  const summary = await auditStatements(db, user.id, 'membership_benefit.consolidate', created?.id ?? group.existing_rule_id ?? group.key, {
    tier: group.tier,
    category_id: group.category_id,
    created_rule_id: created?.id ?? null,
    existing_rule_id: group.existing_rule_id,
    deleted_rule_ids: group.rule_ids,
    terms: group.terms,
  });
  statements.push(...summary.statements);
  try {
    await db.batch(statements);
  } catch (e) {
    // The fence (or a concurrent write it guards against) rolled the batch
    // back: nothing was written.
    if (/NOT NULL constraint failed/i.test(e instanceof Error ? e.message : String(e))) {
      throw conflict('These product rules have changed since the list was loaded. Reload and try again.', 'CONSOLIDATION_STALE');
    }
    throw e;
  }

  return c.json({
    success: true,
    created_rule_id: created?.id ?? null,
    deleted_rule_ids: group.rule_ids,
    version_id: (await currentBenefitVersionId(db)) ?? 0,
  });
});

/* ------------------------------------------------------------ simulator */

/** A membership the simulator prices AS IF — never read from any account. */
function pretendStatus(tier: 'prime' | 'pro'): TierStatus {
  return { tier, active: true, expires_at: null, pending_launch: null, gated_benefits: [] };
}

/**
 * §7 — "WHAT WOULD THIS CART COST?", answered by the SAME functions the
 * checkout uses.
 *
 * The owner picks products, quantities, a tier, a delivery method and a
 * payment method, and gets the exact breakdown a customer would see: per line
 * the regular price, the member price and the saving; then the delivery fee
 * with its waiver, and the cash-on-delivery tax with its exemption. It reads
 * the rules AS THEY ARE SAVED — including disabled and future-dated ones,
 * which simply do not apply — and writes nothing at all.
 */
adminMembershipBenefitRoutes.post('/simulate', async (c: Context<AppContext>) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tier = oneOf(body.tier ?? 'pro', 'tier', ['prime', 'pro'] as const);
  const deliveryMethodId = str(body.delivery_method_id ?? 'standard', 'delivery_method_id', { max: 60 });
  const paymentMethodId = str(body.payment_method_id ?? 'cash', 'payment_method_id', { max: 60 });
  const nowIso = optIso(body.at, 'at') ?? new Date().toISOString();

  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 40).map((raw) => {
    const it = raw as Record<string, unknown>;
    return {
      product_id: str(it.product_id, 'items[].product_id', { min: 1, max: 60 }),
      qty: int(it.qty ?? 1, 'items[].qty', { min: 1, max: 99 }),
    };
  });
  if (items.length === 0) throw badRequest('Add at least one product to simulate', 'VALIDATION');

  const ids = [...new Set(items.map((i) => i.product_id))];
  const [{ results: rows }, rules, ancestry, settings] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM products WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<Record<string, unknown>>(),
    allBenefitRules(c.env.DB),
    catalogAncestry(c.env.DB),
    getSettings(c.env.DB, ['proPricingPolicy', 'shippingPolicy', 'checkoutDeliveryMethods', 'codTaxPerBlockIqd', 'codTaxBlockIqd']),
  ]);
  const byId = new Map((rows ?? []).map((r) => [String(r.id), r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw badRequest(`Unknown product: ${missing.join(', ')}`, 'VALIDATION');

  // Only the ENABLED rules can apply, exactly as at a real checkout; the
  // disabled ones are still listed above so the owner can see what is off.
  const live: BenefitRule[] = rules.filter((r) => r.enabled);
  const status = pretendStatus(tier);
  const proPolicy = proPolicyFrom(settings.proPricingPolicy);

  const lines = items.map((item) => {
    const row = byId.get(item.product_id)!;
    const doc = parseProductRow(row);
    const categoryId = (row.category_id as string | null) ?? null;
    const subCategoryId = (row.sub_category_id as string | null) ?? null;
    const target = {
      product_id: item.product_id,
      category_id: categoryId,
      sub_category_id: subCategoryId,
      ancestry: ancestryFor(ancestry, categoryId, subCategoryId),
    };
    const resolved = resolveUnitPrice({
      product: doc,
      tier,
      tierActive: true,
      proPolicy,
      memberFallback: fallbackFor(live, status, target, nowIso),
    });
    return {
      product_id: item.product_id,
      name: String(row.name_ar || row.name || item.product_id),
      qty: item.qty,
      regular_unit_iqd: resolved.regular_iqd,
      member_unit_iqd: resolved.applied_iqd,
      applied_tier: resolved.applied_tier,
      member_rule_id: tier === 'pro' ? resolved.member_rule.pro : resolved.member_rule.prime,
      benefit: {
        product_id: item.product_id,
        category_id: categoryId,
        sub_category_id: subCategoryId,
        ancestry: target.ancestry,
        regular_unit_iqd: resolved.regular_iqd,
        applied_unit_iqd: resolved.applied_iqd,
        applied_rule_id: tier === 'pro' ? resolved.member_rule.pro : resolved.member_rule.prime,
        qty: item.qty,
      },
    };
  });

  const merchandise = lines.reduce((n, l) => n + l.member_unit_iqd * l.qty, 0);
  const benefits = resolveMembershipBenefits({
    rules: live,
    status,
    lines: lines.map((l) => l.benefit),
    shippingBasisIqd: merchandise,
    deliveryMethod: METHODS.includes(deliveryMethodId as DeliveryMethodId) ? (deliveryMethodId as DeliveryMethodId) : null,
    nowIso,
    versionId: await currentBenefitVersionId(c.env.DB),
  });
  const merchandiseAfter = Math.max(0, merchandise - benefits.line_discount_iqd);

  const methods = (settings.checkoutDeliveryMethods as DeliveryMethod[] | undefined) ?? [];
  const method = methods.find((m) => m.id === deliveryMethodId);
  const shippingConfig = shippingConfigFrom(settings.shippingPolicy);
  const ordinary = method && Number.isInteger(method.price_iqd) && (method.price_iqd as number) >= 0
    ? (method.price_iqd as number)
    : shippingConfig.ordinary_iqd;
  const shipping = quoteShipping({
    items: lines.map((l) => ({ product_id: l.product_id, qty: l.qty, size_class: 'ordinary' as const })),
    deliveryMethod: deliveryMethodId === 'personal' ? 'personal' : 'standard',
    merchandiseIqd: merchandiseAfter,
    primeMerchandiseIqd: merchandiseAfter,
    tier,
    tierActive: true,
    proShippingEntitled: tier === 'pro',
    premiumShippingEntitled: tier === 'prime',
    // The simulator answers the owner's question — "what does this rule do" —
    // so the PRO approved-address condition is assumed met and said so in the
    // response rather than silently denying the benefit being tested.
    atApprovedDefaultAddress: true,
    membershipShipping: benefits.shipping,
    config: { ...shippingConfig, ordinary_iqd: ordinary },
  });

  const payable = Math.max(0, merchandiseAfter + shipping.total_iqd);
  // The SIMULATOR must quote the same rate the checkout charges, or an owner
  // tuning a benefit is reading a number no customer will ever see.
  const codTaxBefore = codDeliveryTaxIqd(
    {
      paymentMethodId,
      deliveryMethodId,
      payableBeforeTaxIqd: payable,
    },
    { blockIqd: Number(settings.codTaxBlockIqd), perBlockIqd: Number(settings.codTaxPerBlockIqd) }
  );
  const codTaxExemption = benefits.tax.cod_exempt ? codTaxBefore : 0;

  return c.json({
    success: true,
    assumptions: ['PRO benefits are simulated at the approved default address'],
    at: nowIso,
    tier,
    version_id: benefits.version_id,
    lines: lines.map((l, i) => {
      const b = benefits.lines[i];
      return {
        product_id: l.product_id,
        name: l.name,
        qty: l.qty,
        regular_unit_iqd: l.regular_unit_iqd,
        member_unit_iqd: l.member_unit_iqd,
        regular_line_iqd: l.regular_unit_iqd * l.qty,
        member_rule_id: b?.rule_id ?? l.member_rule_id,
        rule_scope: b?.scope ?? null,
        discount_iqd: b?.total_iqd ?? 0,
        per_unit_discount_iqd: b?.per_unit_iqd ?? 0,
        eligible_qty: b?.eligible_qty ?? 0,
        capped_by: b?.capped_by ?? 'none',
        applied_at: b?.applied_at ?? 'unit',
      };
    }),
    totals: {
      merchandise_regular_iqd: lines.reduce((n, l) => n + l.regular_unit_iqd * l.qty, 0),
      membership_discount_iqd: benefits.discount_total_iqd,
      merchandise_iqd: merchandiseAfter,
      shipping_before_benefit_iqd: shipping.total_before_waiver_iqd,
      shipping_iqd: shipping.total_iqd,
      shipping_benefit_iqd: shipping.membership_subsidy_iqd,
      cod_tax_before_exemption_iqd: codTaxBefore,
      cod_tax_exemption_iqd: codTaxExemption,
      cod_tax_iqd: Math.max(0, codTaxBefore - codTaxExemption),
      total_iqd: payable + Math.max(0, codTaxBefore - codTaxExemption),
    },
    shipping: {
      rule_id: benefits.shipping.rule_id,
      eligible: benefits.shipping.eligible,
      reason: benefits.shipping.reason,
      threshold_iqd: benefits.shipping.threshold_iqd,
      basis_iqd: benefits.shipping.basis_iqd,
      methods: benefits.shipping.methods,
      subsidy_capped: shipping.membership_subsidy_capped,
      reasons: shipping.reasons,
    },
    cod_tax: { rule_id: benefits.tax.rule_id, exempt: benefits.tax.cod_exempt },
  });
});
