import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, int, str, oneOf } from '../lib/http';
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
import type { BenefitRule, DeliveryMethodId } from '@levonis/pricing/membershipBenefits';

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
  fields: Partial<RuleWrite>;
}> = [
  {
    key: 'pro-printers',
    slugs: ['printers', '3d-printers'],
    tier: 'pro',
    label: 'PRO — طابعات',
    fields: { discount_mode: 'percent', percent: 10, max_discount_iqd: 100_000, cap_scope: 'per_unit' },
  },
  {
    key: 'pro-materials',
    slugs: ['materials', 'filament'],
    tier: 'pro',
    label: 'PRO — مواد',
    fields: { discount_mode: 'percent', percent: 15 },
  },
  {
    key: 'pro-accessories',
    slugs: ['accessories', 'printer-accessories'],
    tier: 'pro',
    label: 'PRO — إكسسوارات',
    fields: { discount_mode: 'percent', percent: 10 },
  },
  {
    key: 'premium-printers',
    slugs: ['printers', '3d-printers'],
    tier: 'prime',
    label: 'PREMIUM — طابعات',
    fields: { discount_mode: 'fixed', fixed_iqd: 15_000, cap_scope: null },
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

adminMembershipBenefitRoutes.post('/recommended', async (c) => {
  const user = c.get('user')!;
  const [existing, { results: catalogs }] = await Promise.all([
    allBenefitRules(c.env.DB),
    c.env.DB.prepare('SELECT id, slug FROM catalogs WHERE parent_id IS NULL').all<{ id: string; slug: string }>(),
  ]);
  const bySlug = new Map((catalogs ?? []).map((row) => [String(row.slug), String(row.id)]));

  const created: RuleWrite[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  let versionId = (await currentBenefitVersionId(c.env.DB)) ?? 0;

  for (const rec of RECOMMENDED) {
    const categoryId = rec.slugs.map((slug) => bySlug.get(slug)).find((id) => !!id) ?? null;
    if (!categoryId) {
      skipped.push({ key: rec.key, reason: 'NO_MATCHING_SECTION' });
      continue;
    }
    // An owner who already wrote a rule for this tier and section keeps it.
    // This action offers a starting point; it never overwrites a decision.
    const taken = existing.some(
      (r) => r.tier === rec.tier && r.benefit_type === 'product_discount' && r.scope === 'category' && r.category_id === categoryId
    );
    if (taken) {
      skipped.push({ key: rec.key, reason: 'ALREADY_CONFIGURED' });
      continue;
    }
    const rule: RuleWrite = {
      ...BLANK_RULE,
      ...rec.fields,
      id: newId('mbr'),
      tier: rec.tier,
      benefit_type: 'product_discount',
      scope: 'category',
      category_id: categoryId,
      label: rec.label,
    };
    versionId = await saveBenefitRule(c.env, user.id, rule, 'create');
    created.push(rule);
  }

  return c.json({ success: true, created, skipped, version_id: versionId });
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
    getSettings(c.env.DB, ['proPricingPolicy', 'shippingPolicy', 'checkoutDeliveryMethods']),
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
  const codTaxBefore = codDeliveryTaxIqd({
    paymentMethodId,
    deliveryMethodId,
    payableBeforeTaxIqd: payable,
  });
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
