/**
 * THE BUNDLES PANEL — the admin API of docs/BUNDLES_MYSTERY.md §10 and §11.
 *
 * A bundle is a REAL `products` row carrying `composition = 'bundle'`. That is
 * the whole design: it inherits the ar/en/ckb title, the slug, the cover, the
 * gallery, the status, the display order, the price ladder, price history,
 * price protection and every existing storefront surface, and it never grows a
 * second commerce system. What it never has is stock of its own — availability
 * is COMPUTED from its members' real inventory at every read.
 *
 * Four rules decide the shape of everything below.
 *
 * 1. ONE PLAN, ONE BATCH (§11.2). The product row and the composition are
 *    written by `planProductSave` + `planBundleComposition` and executed by
 *    `saveProductAtomic`'s single `db.batch`. `ProductSavePlan.statements` is a
 *    plain array, so appending to it before the batch keeps the single-writer
 *    contract of docs/TXT_IMPORT_PARITY.md §5.1 exactly: there is no second
 *    writer of the product tables, and a composition can never half-commit
 *    beside its product.
 *
 * 2. NOTHING IS COMPUTED IN THE PANEL. The component value, the saving,
 *    `max_bundles`, the blocking component and every warning come from
 *    `worker/lib/bundleComposition.ts` — the same functions the storefront, the
 *    cart and the door use — so the admin preview and the shop can never
 *    disagree.
 *
 * 3. NOTHING IS SILENTLY REPAIRED (§11.3). An invalid configuration is
 *    REFUSED, with the reason named, in three languages, in the one shape both
 *    existing decoders understand. A mixed-shipping bundle is not split; a
 *    discount larger than the parts is not clamped to free; an unpriced bundle
 *    is not published with a zero.
 *
 * 4. THE GUARD IS THIS ROUTER'S OWN. `requireMainHost` in worker/index.ts is a
 *    HOST check and never a role check, so `requireAdmin` is attached here —
 *    a mount without it would be an open admin API guarded only by hostname.
 *
 * The legacy `bundles` / `bundle_items` tables are read-only history from
 * `migrations/0059_bundles_migrate_legacy.sql` onward; nothing here writes them.
 */

import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, int, str, oneOf, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit, auditStatements } from '../lib/audit';
import { canViewFinancials, projectForAdmin } from '../lib/adminScope';
import {
  parseProductRow,
  primaryMedia,
  projectAdmin,
  validateProductDoc,
  type ProductDoc,
} from '../lib/productModel';
import {
  localizeRespectingAuthored,
  planProductSave,
  reloadForVerification,
  saveProductAtomic,
  verifyApplied,
  type ProductSavePlan,
} from '../lib/productPersistence';
import {
  compositionPriceWarnings,
  loadBundleComponents,
  loadCompositionMembers,
  planBundleComposition,
  resolveComposition,
  type BundleComponentInput,
  type BundleConfigInput,
  type BundleIssue,
  type BundleOfferInput,
  type CompositionPreview,
  type CompositionPricingCtx,
} from '../lib/bundleComposition';
import { loadOffers, offerWindowStatements, normalizeUtc, subjectOf, type OfferView } from '../lib/offers';
import { pricingCtx } from './products';
import { slugToken, uniqueSlugIn } from './adminProducts';

export const adminBundlesRoutes = new Hono<AppContext>();
adminBundlesRoutes.use('*', requireAdmin);

// --------------------------------------------------------------- reading

interface ConfigRow {
  product_id: string;
  price_mode: string;
  discount_percent: number | null;
  discount_iqd: number | null;
  min_price_iqd: number;
  plus_price_iqd: number | null;
  max_qty_per_order: number;
  duplicate_policy: string;
  reveal_stage: string;
  show_odds: number;
}

const DEFAULT_CONFIG: BundleConfigInput = {
  price_mode: 'fixed',
  discount_percent: null,
  discount_iqd: null,
  min_price_iqd: 1,
  plus_price_iqd: null,
  max_qty_per_order: 5,
};

const configFromRow = (r: ConfigRow | undefined): BundleConfigInput =>
  r
    ? {
        price_mode:
          r.price_mode === 'discount_percent' || r.price_mode === 'discount_iqd' ? r.price_mode : 'fixed',
        discount_percent: r.discount_percent ?? null,
        discount_iqd: r.discount_iqd ?? null,
        min_price_iqd: r.min_price_iqd ?? 1,
        plus_price_iqd: r.plus_price_iqd ?? null,
        max_qty_per_order: r.max_qty_per_order ?? 5,
      }
    : { ...DEFAULT_CONFIG };

/** The offer block as the panel edits it — the window and its limits. */
function offerFromView(view: OfferView | undefined): BundleOfferInput | null {
  if (!view || !view.window) return null;
  const w = view.window;
  return {
    starts_at: w.starts_at,
    ends_at: w.ends_at,
    required_tiers: w.required_tiers,
    offer_price_mode: w.offer_price_mode as BundleOfferInput['offer_price_mode'],
    offer_price_iqd: w.offer_price_iqd,
    discount_percent: w.discount_percent,
    discount_iqd: w.discount_iqd,
    plus_price_iqd: w.plus_price_iqd,
    locked_preview: w.locked_preview,
    active: w.active,
    max_per_user: view.limits?.max_per_user ?? null,
    max_global: view.limits?.max_global ?? null,
  };
}

/**
 * The admin's own verdict on the offer. An administrator previewing a bundle
 * is not the gated customer, so eligibility is not re-decided here — but the
 * REQUIRED TIERS are carried through so the preview can badge a
 * members-exclusive offer exactly as the card will.
 */
const adminOfferCheck = (offer: BundleOfferInput | null) => ({
  ok: true,
  reason: null,
  required_tiers: (offer?.required_tiers ?? []) as never[],
  locked_preview: offer?.locked_preview ?? true,
});

const ctxFor = async (c: Context<AppContext>): Promise<CompositionPricingCtx> => {
  const ctx = await pricingCtx(c);
  // The preview is the REGULAR price a bundle sells at, never the admin's own
  // membership: an owner who happens to be PRO must not be shown a PRO figure
  // as "the bundle price".
  return { tier: 'free', tierActive: false, proPolicy: ctx.proPolicy, transportDefaults: ctx.transportDefaults };
};

/** Stored components, in the shape the planner and the resolver both take. */
function storedComponents(
  rows: Awaited<ReturnType<typeof loadBundleComponents>>,
  productId: string
): BundleComponentInput[] {
  return (rows.byBundle.get(productId) ?? []).map((r) => {
    const choices = rows.choicesByComponent.get(r.id) ?? [];
    return {
      id: r.id,
      member_product_id: r.member_product_id,
      qty: r.qty,
      optional: r.optional,
      option_value_ids: r.option_value_ids,
      color_id: r.color_id,
      customer_picks_option: r.customer_picks_option,
      customer_picks_color: r.customer_picks_color,
      sort: r.sort,
      choice_option_value_ids: choices.filter((x) => x.dim === 'option_value').map((x) => x.ref_id),
      choice_color_ids: choices.filter((x) => x.dim === 'color').map((x) => x.ref_id),
    };
  });
}

/**
 * WARNINGS TRAVEL TWICE, ON PURPOSE.
 *
 * `warnings` is a list of STRINGS because that is what the existing decoders
 * survive: `strList` (applyResult.ts:49) filters a list down to
 * `typeof x === 'string'`, so an object-shaped success-path `warnings` becomes
 * an empty list, and `ProductForm` joins them with ' · ', printing
 * "[object Object]". `warning_details` carries the full §11.3 record —
 * `{ code, message, key?, line?, ar, en, ckb, component_id? }` — for the panel's
 * trilingual `Banner`. Refusals stay objects: `refusalIssues` renders
 * `${line}${key}${message}` and therefore needs the record, not the sentence.
 */
const warningBody = (warnings: BundleIssue[]) => ({
  warnings: warnings.map((w) => w.message),
  warning_details: warnings,
});

/**
 * «اجعله الان عام» — AND THE HALF OF IT THAT IS STILL NOT.
 *
 * The owner's instruction named both the bundles and the random filament. The
 * filament was never gated: worker/routes/mystery.ts defaults `required_tiers`
 * to [] and worker/routes/bundles.ts computes `entitled` but never filters on
 * it, so an ungated bundle is public to a guest as well.
 *
 * But migration 0063 INSERTED `["plus","prime","pro"]` onto every MIGRATED
 * bundle — every `prd_bnd_*` subject — and those rows are still in the
 * database. `offerEligible` (worker/lib/offers.ts) still turns a non-empty set
 * into MEMBERSHIP_REQUIRED, and the card, the cart and the checkout door each
 * re-ask it independently. So today the honest answer to "can a non-member buy
 * it?" is: for the random filament yes, for a migrated bundle NO.
 *
 * CLEARING THOSE ROWS IS A DATA UPDATE and is the owner's call to make, not a
 * migration this change may write on its own: it would silently overwrite
 * whatever an admin deliberately configured, and the ability to run a
 * members-only promotion is the only thing `required_tiers` can express. What
 * this does instead is make the surviving gate ANNOUNCE ITSELF on the listing
 * — where the owner can clear the tiers per bundle from the screen the
 * instruction was given about. It is a warning and never a refusal: a refusal
 * would destroy the ability it is protecting.
 *
 * Deliberately NOT imported from worker/routes/mystery.ts. One route importing
 * another's private notice is how a sentence written about a filament ends up
 * printed over a bundle; the shape is shared (BundleIssue), the wording is not.
 */
const bundleMembersOnlyNotice = (tiers: string[]): BundleIssue => {
  const list = tiers.map((t) => t.toUpperCase()).join(' / ');
  const en = `this bundle is restricted to members (${list}) — a guest cannot buy it; clear the tiers to open it to everyone`;
  return {
    code: 'BUNDLE_MEMBERS_ONLY_RESTRICTION',
    message: en,
    en,
    ar: `هذه الباقة مقيّدة بالأعضاء (${list}) — الزائر ما يكدر يشتريها؛ امسح الفئات لفتحها للجميع`,
    ckb: `ئەم پاکێجە تەنها بۆ ئەندامانە (${list}) — میوان ناتوانێت بیکڕێت؛ ئاستەکان بسڕەوە بۆ کردنەوەی بۆ هەمووان`,
  };
};

/** The tiers a bundle's offer window demands, or an empty list. */
const requiredTiersOf = (offer: BundleOfferInput | null): string[] =>
  (offer?.required_tiers ?? []).filter((t): t is string => typeof t === 'string' && t.trim() !== '');

// ------------------------------------------------------------------ listing

adminBundlesRoutes.get('/', async (c) => {
  const q = c.req.query();
  const search = String(q.search ?? '').trim().toLowerCase();
  const status = String(q.status ?? '').trim();
  const kind = q.kind === 'mystery' ? 'mystery' : q.kind === 'bundle' ? 'bundle' : '';

  const where: string[] = ["composition <> ''"];
  const args: unknown[] = [];
  if (kind) {
    where.push('composition = ?');
    args.push(kind);
  }
  if (status === 'draft' || status === 'active' || status === 'hidden') {
    where.push('status = ?');
    args.push(status);
  }
  if (search) {
    where.push(`(${sqlLikeClause(['lower(name)', 'lower(name_ar)', 'lower(slug)'])})`);
    const like = likePattern(search);
    args.push(like, like, like);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY display_order, created_at DESC LIMIT 200`
  )
    .bind(...args)
    .all<Record<string, unknown>>();

  const ids = results.map((r) => String(r.id));
  // FOUR reads for the whole page, whatever its length: the components, their
  // configs, their offers and every member product at once. Never one round
  // trip per card.
  const comps = await loadBundleComponents(c.env.DB, ids);
  const configs = ids.length
    ? (
        await c.env.DB.prepare(
          `SELECT * FROM bundle_config WHERE product_id IN (${ids.map(() => '?').join(', ')})`
        )
          .bind(...ids)
          .all<ConfigRow>()
      ).results
    : [];
  const configById = new Map(configs.map((r) => [r.product_id, r]));
  const offers = await loadOffers(c.env.DB, ids.map((id) => subjectOf(id)));
  const memberIds = [...comps.byBundle.values()].flat().map((r) => r.member_product_id);
  const members = await loadCompositionMembers(c.env.DB, memberIds);

  const ctx = await ctxFor(c);
  const nowMs = Date.now();
  const bundles = [];
  for (const row of results) {
    const id = String(row.id);
    const doc = parseProductRow(row);
    const components = storedComponents(comps, id);
    const offer = offerFromView(offers.get(`product:${id}`));
    const res = await resolveComposition(c.env.DB, {
      bundleProductId: id,
      doc,
      config: configFromRow(configById.get(id)),
      components,
      offer: offer ? { starts_at: offer.starts_at, ends_at: offer.ends_at, active: offer.active } : null,
      offerCheck: adminOfferCheck(offer),
      ctx,
      nowMs,
      members,
    });
    const gatedTiers = requiredTiersOf(offer);
    const warnings = [
      ...res.warnings,
      ...compositionPriceWarnings(doc, configFromRow(configById.get(id)), res.preview),
      ...(gatedTiers.length ? [bundleMembersOnlyNotice(gatedTiers)] : []),
    ];
    bundles.push({
      id,
      slug: doc.slug,
      status: doc.status,
      kind: doc.composition,
      name: doc.name_en,
      name_ar: doc.name_ar,
      name_ku: doc.name_ckb,
      image: primaryMedia(doc.media)?.url ?? '',
      display_order: doc.display_order,
      is_featured: doc.is_featured,
      price_iqd: doc.price_iqd,
      component_count: components.length,
      component_total_iqd: res.preview.component_total_iqd,
      bundle_price_iqd: res.preview.bundle_price_iqd,
      saving_percent: res.preview.saving_percent,
      max_bundles: res.preview.availability.max_bundles,
      availability_state: res.preview.availability.state,
      offer,
      // Published as its own key as well as as a warning, so the listing can
      // FILTER on it. Until now the only place a tier set appeared was inside
      // ONE offer's edit form, which is exactly how a members-only bundle
      // survives an instruction to make the feature general.
      members_only: gatedTiers.length > 0,
      required_tiers: gatedTiers,
      // A refusal-shaped issue is still a warning on a LISTING: the row exists
      // and the admin must be told why it cannot sell, not shown an error page.
      ...warningBody([...warnings, ...res.errors]),
    });
  }
  return c.json({ success: true, bundles: projectForAdmin(c.env, c.get('user'), bundles) });
});

// ------------------------------------------------------------- one bundle

async function loadOne(c: Context<AppContext>, id: string) {
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw notFound('bundle');
  const doc = parseProductRow(row);
  if (doc.composition === '') {
    // An ordinary product is edited in the product panel, and the bundles
    // panel says so rather than pretending to own it.
    throw new HttpError(400, 'this product is not a bundle', 'VALIDATION', { id });
  }
  const comps = await loadBundleComponents(c.env.DB, [id]);
  const cfg = await c.env.DB.prepare('SELECT * FROM bundle_config WHERE product_id = ?').bind(id).first<ConfigRow>();
  const offers = await loadOffers(c.env.DB, [subjectOf(id)]);
  return {
    row,
    doc,
    components: storedComponents(comps, id),
    config: configFromRow(cfg ?? undefined),
    offer: offerFromView(offers.get(`product:${id}`)),
    stored: cfg ?? null,
  };
}

async function previewOf(c: Context<AppContext>, id: string) {
  const loaded = await loadOne(c, id);
  const ctx = await ctxFor(c);
  const res = await resolveComposition(c.env.DB, {
    bundleProductId: id,
    doc: loaded.doc,
    config: loaded.config,
    components: loaded.components,
    offer: loaded.offer
      ? { starts_at: loaded.offer.starts_at, ends_at: loaded.offer.ends_at, active: loaded.offer.active }
      : null,
    offerCheck: adminOfferCheck(loaded.offer),
    ctx,
    nowMs: Date.now(),
  });
  // The gate rides on EVERY read, not only on the listing: an admin who opens
  // one bundle to ask why a guest cannot buy it is the reader this sentence
  // was written for, and a warning that appears on one screen and not the
  // other is a warning the next person will assume they imagined.
  const gatedTiers = requiredTiersOf(loaded.offer);
  return {
    loaded,
    preview: res.preview,
    issues: [
      ...res.warnings,
      ...compositionPriceWarnings(loaded.doc, loaded.config, res.preview),
      ...(gatedTiers.length ? [bundleMembersOnlyNotice(gatedTiers)] : []),
      ...res.errors,
    ],
  };
}

adminBundlesRoutes.get('/:productId', async (c) => {
  const id = c.req.param('productId');
  const { loaded, preview, issues } = await previewOf(c, id);
  const stored = await reloadForVerification(c.env.DB, id);
  return c.json({
    success: true,
    ...projectForAdmin(c.env, c.get('user'), {
      product: stored ? projectAdmin(stored.document) : projectAdmin(loaded.doc),
      config: loaded.config,
      components: loaded.components,
      offer: loaded.offer,
      preview,
      updated_at: String(loaded.row.updated_at ?? ''),
      ...warningBody(issues),
    }),
  });
});

adminBundlesRoutes.get('/:productId/preview', async (c) => {
  const id = c.req.param('productId');
  const { preview, issues } = await previewOf(c, id);
  return c.json({
    success: true,
    ...projectForAdmin(c.env, c.get('user'), { preview, ...warningBody(issues) }),
  });
});

// ----------------------------------------------------------------- writing

/** The components a save asks for, validated as SHAPES here and as a
 *  configuration by `planBundleComposition` against the real catalogue. */
function readComponents(body: Record<string, unknown>): BundleComponentInput[] {
  const raw = Array.isArray(body.components) ? body.components : [];
  if (raw.length > 50) throw badRequest('at most 50 components per bundle', 'VALIDATION');
  const ids = (v: unknown, name: string): string[] =>
    (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80)
      .slice(0, 200)
      .map((x) => str(x, name, { max: 80 }));
  return raw.map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    return {
      id: typeof o.id === 'string' && /^bc_/.test(o.id) ? o.id : undefined,
      member_product_id: str(o.member_product_id, `components[${i}].member_product_id`, { min: 1, max: 80 }),
      qty: int(o.qty, `components[${i}].qty`, { min: 1, max: 99, def: 1 }),
      optional: o.optional === true,
      option_value_ids: ids(o.option_value_ids, `components[${i}].option_value_ids`),
      color_id: str(o.color_id ?? '', `components[${i}].color_id`, { max: 80, required: false }),
      customer_picks_option: o.customer_picks_option === true,
      customer_picks_color: o.customer_picks_color === true,
      sort: int(o.sort, `components[${i}].sort`, { min: 0, max: 10_000, def: i }),
      choice_option_value_ids: ids(o.choice_option_value_ids, `components[${i}].choice_option_value_ids`),
      choice_color_ids: ids(o.choice_color_ids, `components[${i}].choice_color_ids`),
    };
  });
}

function readConfig(body: Record<string, unknown>): BundleConfigInput {
  const raw = (body.config ?? {}) as Record<string, unknown>;
  const nullableInt = (v: unknown, name: string, max: number): number | null =>
    v === null || v === undefined || v === '' ? null : int(v, name, { min: 0, max });
  return {
    price_mode: oneOf(raw.price_mode ?? 'fixed', 'config.price_mode', ['fixed', 'discount_percent', 'discount_iqd'] as const),
    // A wide shape bound on purpose: 1..90 is a DOMAIN rule, and it is
    // refused by `planBundleComposition` in three languages rather than by a
    // generic "must be between 0 and 100" that no admin can act on.
    discount_percent: nullableInt(raw.discount_percent, 'config.discount_percent', 100_000),
    discount_iqd: nullableInt(raw.discount_iqd, 'config.discount_iqd', 100_000_000),
    min_price_iqd: int(raw.min_price_iqd, 'config.min_price_iqd', { min: 1, max: 100_000_000, def: 1 }),
    plus_price_iqd: nullableInt(raw.plus_price_iqd, 'config.plus_price_iqd', 100_000_000),
    max_qty_per_order: int(raw.max_qty_per_order, 'config.max_qty_per_order', { min: 1, max: 99, def: 5 }),
  };
}

function readOffer(body: Record<string, unknown>): BundleOfferInput | null {
  if (!body.offer || typeof body.offer !== 'object' || Array.isArray(body.offer)) return null;
  const raw = body.offer as Record<string, unknown>;
  const nullableInt = (v: unknown, name: string, max: number): number | null =>
    v === null || v === undefined || v === '' ? null : int(v, name, { min: 0, max });
  return {
    starts_at: normalizeUtc(typeof raw.starts_at === 'string' ? raw.starts_at : null),
    ends_at: normalizeUtc(typeof raw.ends_at === 'string' ? raw.ends_at : null),
    required_tiers: (Array.isArray(raw.required_tiers) ? raw.required_tiers : []).filter(
      (x): x is string => typeof x === 'string'
    ),
    offer_price_mode: oneOf(raw.offer_price_mode ?? '', 'offer.offer_price_mode', [
      '',
      'fixed',
      'discount_percent',
      'discount_iqd',
    ] as const),
    offer_price_iqd: nullableInt(raw.offer_price_iqd, 'offer.offer_price_iqd', 100_000_000),
    discount_percent: nullableInt(raw.discount_percent, 'offer.discount_percent', 100_000),
    discount_iqd: nullableInt(raw.discount_iqd, 'offer.discount_iqd', 100_000_000),
    plus_price_iqd: nullableInt(raw.plus_price_iqd, 'offer.plus_price_iqd', 100_000_000),
    locked_preview: raw.locked_preview !== false,
    active: raw.active !== false,
    max_per_user: nullableInt(raw.max_per_user, 'offer.max_per_user', 100_000),
    max_global: nullableInt(raw.max_global, 'offer.max_global', 100_000_000),
  };
}

/** The bundle's own document, with §1.2's pins already stated. `planProductSave`
 *  enforces them again — a pin that lives in a caller is a pin the next caller
 *  forgets — but stating them here keeps the refusals honest about intent. */
function bundleDocFrom(body: Record<string, unknown>, kind: 'bundle' | 'mystery', id: string): ProductDoc {
  const doc = validateProductDoc({
    ...body,
    id,
    composition: kind,
    // A composition row has no variability of its own; it lives in the
    // components. Passing anything else through would be refused anyway.
    options: [],
    colors: [],
    stock: null,
    inventory_mode: 'BASE',
    selling_type: 'bundle',
    sale_types: Array.isArray(body.sale_types) && (body.sale_types as unknown[]).includes('pre_order')
      ? ['bundle', 'pre_order']
      : ['bundle'],
  });
  doc.id = id;
  return doc;
}

interface SaveOutcome {
  plan: ProductSavePlan;
  preview: CompositionPreview;
  warnings: BundleIssue[];
}

/**
 * ONE PLAN, ONE BATCH — §11.2, verbatim.
 *
 * `planProductSave` plans the product row (and applies §1.2's pins and the
 * `COMPOSITION_NOT_ALLOWED` door); `planBundleComposition` plans the
 * composition and the config; `offerWindowStatements` plans the window and its
 * limits. All three arrays go into `plan.statements`, and `saveProductAtomic`
 * runs exactly one `db.batch`. A test asserts no second batch touches a
 * product table.
 */
async function planSave(
  c: Context<AppContext>,
  opts: { doc: ProductDoc; prev: ProductDoc | null; body: Record<string, unknown>; kind: 'bundle' | 'mystery' }
): Promise<SaveOutcome> {
  const admin = c.get('user')!;
  const { doc, prev } = opts;
  const components = readComponents(opts.body);
  const config = readConfig(opts.body);
  const offer = readOffer(opts.body);
  const ctx = await ctxFor(c);

  const localized = localizeRespectingAuthored(doc, prev);
  const plan = await planProductSave(c.env.DB, {
    mode: prev ? 'update' : 'create',
    doc,
    prev,
    relations: null,
    catalogIds: Array.isArray(opts.body.catalog_ids)
      ? (opts.body.catalog_ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined,
    actor: { adminId: admin.id, money: canViewFinancials(c.env, admin) },
    translations: localized.fields,
    // The ONE writer allowed to create or edit a composition row. The product
    // form, the TXT template and the CSV importer inherit the refusal.
    allowComposition: true,
  });

  const comp = await planBundleComposition(c.env.DB, doc.id, { components, config }, {
    doc,
    offer,
    offerCheck: adminOfferCheck(offer),
    ctx,
    nowMs: Date.now(),
    publishing: doc.status === 'active',
  });
  // `statements` is the discriminant: a refusal carries none, and the errors
  // travel as OBJECTS because `refusalIssues` renders `${line}${key}${message}`.
  if (!comp.statements) {
    throw new HttpError(400, 'this bundle cannot be saved as configured', 'BUNDLE_VALIDATION', {
      errors: comp.errors as unknown as Record<string, unknown>[],
    });
  }

  plan.statements.push(...comp.statements, ...offerWindowStatements(c.env.DB, subjectOf(doc.id), offer));
  if (offer) {
    // AN ODDS- OR DISCLOSURE-CHANGING WRITE IS AUDITED INSIDE ITS OWN BATCH
    // (§10). A tier gate and an offer price decide who may buy and at what
    // price; auditing them after the batch means a crash between the two
    // leaves an unaudited change to exactly the row that decides access.
    //
    // AND IT CARRIES THE BEFORE VALUES. §10 asks for "before and after values
    // in the detail: … an offer price or tier gate". With the after values
    // alone, the one question an audit trail on a randomised money mechanism
    // exists to answer — "what was the tier gate / the reveal milestone / the
    // offer price before this admin changed it" — is unanswerable, because the
    // window row it would be compared against has already been overwritten.
    const beforeWindow = await c.env.DB
      .prepare(
        `SELECT w.starts_at, w.ends_at, w.required_tiers, w.offer_price_mode, w.offer_price_iqd,
                w.discount_percent, w.discount_iqd, w.plus_price_iqd, w.locked_preview, w.active,
                l.max_per_user, l.max_global
           FROM offer_windows w
           LEFT JOIN offer_limits l ON l.subject_type = w.subject_type AND l.subject_id = w.subject_id
          WHERE w.subject_type = 'product' AND w.subject_id = ?`
      )
      .bind(doc.id)
      .first<Record<string, unknown>>();
    const { statements } = await auditStatements(c.env.DB, admin.id, 'offer.update', doc.id, {
      before: beforeWindow ?? null,
      after: {
        required_tiers: offer.required_tiers,
        offer_price_mode: offer.offer_price_mode,
        offer_price_iqd: offer.offer_price_iqd,
        discount_percent: offer.discount_percent,
        discount_iqd: offer.discount_iqd,
        plus_price_iqd: offer.plus_price_iqd,
        starts_at: offer.starts_at,
        ends_at: offer.ends_at,
        active: offer.active,
        max_per_user: offer.max_per_user,
        max_global: offer.max_global,
      },
    });
    plan.statements.push(...statements);
  }
  return { plan, preview: comp.preview, warnings: comp.warnings };
}

async function writeBundle(c: Context<AppContext>, mode: 'create' | 'update', productId: string | null) {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw badRequest('JSON body required', 'VALIDATION');

  let prev: ProductDoc | null = null;
  let prevRow: Record<string, unknown> | null = null;
  if (mode === 'update') {
    prevRow =
      (await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(productId).first<Record<string, unknown>>()) ??
      null;
    if (!prevRow) throw notFound('bundle');
    prev = parseProductRow(prevRow);
    if (prev.composition === '') throw badRequest('this product is not a bundle', 'VALIDATION');
    // Stale-edit protection, the idiom the product editor already uses.
    if (typeof body.expected_updated_at === 'string' && body.expected_updated_at) {
      const current = String(prevRow.updated_at ?? '');
      if (body.expected_updated_at !== current) {
        return c.json(
          {
            success: false,
            code: 'STALE_EDIT',
            error: 'This bundle was modified by someone else since you opened it.',
            current,
          },
          409
        );
      }
    }
  }

  const kind: 'bundle' | 'mystery' = prev ? (prev.composition as 'bundle' | 'mystery') : 'bundle';
  const id = prev ? prev.id : newId('prd');
  const doc = bundleDocFrom(body, kind, id);
  // Links stay stable: an update keeps its stored slug unless the admin asks.
  if (prev) {
    if (body.allow_slug_change === true && typeof body.slug === 'string' && slugToken(body.slug)) {
      doc.slug = await uniqueSlugIn(c.env.DB, 'products', slugToken(body.slug), id);
    } else {
      doc.slug = prev.slug;
    }
  } else {
    const base = slugToken(doc.name_en) || slugToken(doc.name_ar) || `bundle-${id.slice(-8)}`;
    doc.slug = await uniqueSlugIn(c.env.DB, 'products', base, null);
  }

  const { plan, preview, warnings } = await planSave(c, { doc, prev, body, kind });
  await saveProductAtomic(c.env.DB, plan, [
    {
      action: prev ? 'bundle.update' : 'bundle.create',
      detail: { slug: doc.slug, status: doc.status, price_iqd: doc.price_iqd, components: preview.components.length },
    },
  ]);

  const stored = await reloadForVerification(c.env.DB, id);
  const mismatches = stored ? verifyApplied(plan, stored, { documentKeys: null }) : [];
  return c.json({
    success: true,
    created: !prev,
    product: projectForAdmin(c.env, admin, stored ? projectAdmin(stored.document) : projectAdmin(doc)),
    preview: projectForAdmin(c.env, admin, preview),
    ...warningBody(warnings),
    ...(mismatches.length ? { mismatches } : {}),
  });
}

adminBundlesRoutes.post('/', async (c) => writeBundle(c, 'create', null));

/**
 * The whole-set reorder. Registered BEFORE `/:productId` so Hono cannot read
 * "reorder" as a product id.
 */
adminBundlesRoutes.put('/reorder', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const order = Array.isArray(body?.order) ? (body!.order as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (order.length === 0) throw badRequest('order must be a non-empty array of bundle ids', 'VALIDATION');
  if (order.length > 200) throw badRequest('at most 200 bundles per reorder', 'VALIDATION');
  const now = new Date().toISOString();
  await c.env.DB.batch(
    order.map((id, i) =>
      c.env.DB
        .prepare("UPDATE products SET display_order = ?, updated_at = ? WHERE id = ? AND composition <> ''")
        .bind(i, now, id)
    )
  );
  await audit(c.env.DB, admin.id, 'bundle.update', 'reorder', { ids: order.length });
  return c.json({ success: true, reordered: order.length });
});

adminBundlesRoutes.put('/:productId', async (c) => writeBundle(c, 'update', c.req.param('productId')));

/**
 * DUPLICATE — doc + composition + config as a NEW DRAFT with a new slug.
 *
 * The offer window is copied so a members-only bundle does not silently become
 * public, but the LIMITS are not: `max_global = 100` copied onto a second
 * bundle would quietly double a cap the owner set once.
 */
adminBundlesRoutes.post('/:productId/duplicate', async (c) => {
  const admin = c.get('user')!;
  const source = await loadOne(c, c.req.param('productId'));
  const id = newId('prd');
  const doc: ProductDoc = {
    ...source.doc,
    id,
    status: 'draft',
    name_en: source.doc.name_en ? `${source.doc.name_en} (copy)` : '',
    name_ar: source.doc.name_ar ? `${source.doc.name_ar} (نسخة)` : '',
    sku: null,
  };
  doc.slug = await uniqueSlugIn(
    c.env.DB,
    'products',
    slugToken(doc.name_en) || slugToken(doc.name_ar) || `bundle-${id.slice(-8)}`,
    null
  );
  const ctx = await ctxFor(c);
  const offer = source.offer ? { ...source.offer, max_per_user: null, max_global: null } : null;
  const plan = await planProductSave(c.env.DB, {
    mode: 'create',
    doc,
    prev: null,
    relations: null,
    actor: { adminId: admin.id, money: canViewFinancials(c.env, admin) },
    allowComposition: true,
  });
  const comp = await planBundleComposition(
    c.env.DB,
    id,
    // The surrogate ids are dropped: a copy gets its own component rows, so a
    // cart line pointing at the original is never re-pointed at the copy.
    { components: source.components.map((x) => ({ ...x, id: undefined })), config: source.config },
    { doc, offer, offerCheck: adminOfferCheck(offer), ctx, nowMs: Date.now(), publishing: false }
  );
  if (!comp.statements) {
    throw new HttpError(400, 'this bundle cannot be duplicated as configured', 'BUNDLE_VALIDATION', {
      errors: comp.errors as unknown as Record<string, unknown>[],
    });
  }
  plan.statements.push(...comp.statements, ...offerWindowStatements(c.env.DB, subjectOf(id), offer));
  await saveProductAtomic(c.env.DB, plan, [
    { action: 'bundle.create', detail: { duplicated_from: source.doc.id, slug: doc.slug } },
  ]);
  const stored = await reloadForVerification(c.env.DB, id);
  return c.json({
    success: true,
    created: true,
    product: projectForAdmin(c.env, admin, stored ? projectAdmin(stored.document) : projectAdmin(doc)),
    preview: projectForAdmin(c.env, admin, comp.preview),
    ...warningBody(comp.warnings),
  });
});

/**
 * ENABLE / DISABLE / ARCHIVE.
 *
 * Publishing is a MONEY decision, so it re-runs the whole configuration check:
 * an unpriced fixed-price bundle, a discount at or above the component total
 * or a mixed-shipping composition is refused here exactly as it is at save.
 * Without that, "publish" would be the one door around every refusal.
 */
adminBundlesRoutes.patch('/:productId/status', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('productId');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === 'string' ? body.action : '';
  const status =
    action === 'enable'
      ? 'active'
      : action === 'disable'
        ? 'hidden'
        : action === 'archive'
          ? 'draft'
          : oneOf(body.status, 'status', ['draft', 'active', 'hidden'] as const);

  const loaded = await loadOne(c, id);
  if (status === 'active') {
    const ctx = await ctxFor(c);
    const comp = await planBundleComposition(
      c.env.DB,
      id,
      { components: loaded.components, config: loaded.config },
      {
        doc: { ...loaded.doc, status: 'active' },
        offer: loaded.offer,
        offerCheck: adminOfferCheck(loaded.offer),
        ctx,
        nowMs: Date.now(),
        publishing: true,
      }
    );
    if (!comp.statements) {
      throw new HttpError(400, 'this bundle cannot be published as configured', 'BUNDLE_VALIDATION', {
        errors: comp.errors as unknown as Record<string, unknown>[],
      });
    }
  }
  // Archiving a bundle that past orders name keeps the row: order history must
  // keep resolving. The count is in the response — the taxonomy panel's
  // deactivate-when-in-use idiom, not a delete.
  const refs = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?')
    .bind(id)
    .first<{ n: number }>();
  const res = await c.env.DB.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, new Date().toISOString(), id)
    .run();
  if (res.meta.changes === 0) throw notFound('bundle');
  await audit(c.env.DB, admin.id, status === 'draft' ? 'bundle.archive' : 'bundle.update', id, {
    status,
    order_item_refs: refs?.n ?? 0,
  });
  return c.json({ success: true, id, status, order_item_refs: refs?.n ?? 0 });
});

/**
 * DELETE is ARCHIVE once any order names the bundle — the same policy the
 * product panel applies, for the same reason: an order that cannot resolve its
 * product is an order nobody can answer a question about.
 */
adminBundlesRoutes.delete('/:productId', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('productId');
  const loaded = await loadOne(c, id);
  const refs = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?')
    .bind(id)
    .first<{ n: number }>();
  if ((refs?.n ?? 0) > 0) {
    await c.env.DB.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?')
      .bind('draft', new Date().toISOString(), id)
      .run();
    await audit(c.env.DB, admin.id, 'bundle.archive', id, { order_item_refs: refs!.n });
    return c.json({
      success: true,
      archived: true,
      deleted: false,
      order_item_refs: refs!.n,
      reason: 'Referenced by past orders — archived instead of deleted.',
    });
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM bundle_component_choices WHERE component_id IN (SELECT id FROM bundle_components WHERE bundle_product_id = ?)'
    ).bind(id),
    c.env.DB.prepare('DELETE FROM bundle_components WHERE bundle_product_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM bundle_config WHERE product_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM offer_windows WHERE subject_type = ? AND subject_id = ?').bind('product', id),
    c.env.DB.prepare('DELETE FROM offer_limits WHERE subject_type = ? AND subject_id = ?').bind('product', id),
    c.env.DB.prepare('DELETE FROM product_catalogs WHERE product_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id),
  ]);
  await audit(c.env.DB, admin.id, 'bundle.archive', id, { deleted: true, slug: loaded.doc.slug });
  return c.json({ success: true, archived: false, deleted: true });
});
