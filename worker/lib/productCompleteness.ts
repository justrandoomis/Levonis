/**
 * PRODUCT COMPLETENESS — the server's verdict on every ordinary product against
 * the ONE central list of required fields (owner brief 2026-10-10: «اخفاء كل
 * المنتجات التي تنقصها التكاليف والحقول الناقصه مع اعلام احمر للحقل الناقص»).
 *
 * THE LIST (packages/contracts/src/productCompleteness.ts, version
 * `COMPLETENESS_LIST_VERSION`), each code with the rule that satisfies it:
 *
 *   NAME_AR         the Arabic name is not blank
 *   PRICE           an engine-priced product, or a manual price above zero
 *   COST ★          EVERY sellable model reaches a cost: the legacy dinar cost
 *                   (product, model, order-type cell or route — `legacyCostOf`)
 *                   above zero, or the USD pricing inputs resolve a supplier
 *                   cost for it (`resolveSkuInputs`, the engine's own resolver,
 *                   per model or for every one of its SKUs)
 *   ENGINE_INPUTS ★ (engine products only) every model resolves a minimum
 *                   profit (`resolveRuleAt`), and the engine's last repricing
 *                   was not blocked for a missing INPUT
 *   IMAGE           at least one displayable picture
 *   CATEGORY        a main section that exists
 *   PACKAGE_WEIGHT  the packaged weight above zero on the product, or on every
 *                   model
 *   PACKAGE_BOX     the box's three sides above zero on the product, or on
 *                   every model
 *
 * ★ private: the verified owner alone reads which; every other admin reads one
 * OWNER_DATA item; a customer reads nothing (the product is simply not there
 * while held). The stored row carries CODES and option ids only — never a
 * value — and `facts_key`, a digest of what the verdict read.
 *
 * NEVER FROM THE ENVIRONMENT. A missing exchange rate, a paused engine, a
 * resolver mismatch or a stale rate never makes a product incomplete: the
 * engine's own `complete` flag mixes those in, so it is not used here. Only the
 * product's own data decides.
 *
 * WHEN. After each catalogue write (worker/lib/completenessHooks.ts), by the
 * quarter-hour sweep within what the tick leaves (`sweepCompleteness`), and by
 * the owner's recount. A failure never fails the write that triggered it: the
 * sweep catches it up.
 *
 * Composition rows (bundles, mystery) are never evaluated: they are priced and
 * shown from their members, and a held member already makes them unavailable.
 */
import {
  COMPLETENESS_ENTRIES,
  COMPLETENESS_LIST_VERSION,
  OWNER_DATA_CODE,
  isCompletenessCode,
  type CompletenessCode,
  type CompletenessItem,
} from '@levonis/contracts/productCompleteness';
import { resolveSkuInputs } from '@levonis/pricing/costToPrice';
import { resolveRuleAt, type PricingRuleRow } from '@levonis/pricing/ruleResolution';
import type { OptionV2 } from './pricing';
import type { ProductDoc } from './productModel';
import type { ProductRelationsView } from './productOverlay';
import { loadProducts } from './pricingEngine/load';
import { chainOf, chainOfUnit, loadProductsPricing, type StoredInputRow } from './pricingEngine/store';
import { legacyCostOf, modelsOf, sellableSkus } from './pricingEngine/legacy';
import { sha256Hex } from './crypto';
import { completenessInstalled } from './listing';

export { COMPLETENESS_LIST_VERSION };

/** The owner's switch, as stored in admin_settings (worker/lib/settings.ts normalises it). */
export const HIDE_SETTING_KEY = 'catalogHideIncomplete';

/** At most this many products per recompute call (one relational load, one upsert batch). */
export const COMPLETENESS_CHUNK = 25;

/**
 * Statements one recompute of `n` (≤ COMPLETENESS_CHUNK) products spends: the
 * facts and the rules signature (2), the relational load (the row and its nine
 * relation reads, 10), the pricing batch (4), the switch (1), one upsert each.
 */
export const recomputeCost = (n: number): number => (n > 0 ? 2 + 10 + 4 + 1 + n : 0);

/** The engine's blocked-repricing codes that name a missing INPUT (never the environment's). */
const INPUT_BLOCK_CODES: ReadonlySet<string> = new Set([
  'SUPPLIER_COST_MISSING',
  'SUPPLIER_CURRENCY_MISSING',
  'SHIPPING_PROFILE_MISSING',
  'WEIGHT_MISSING',
  'CBM_MISSING',
  'TARGET_PROFIT_MISSING',
  'TARGET_PROFIT_BLOCKED',
  'DIRECT_SALE_EXTRA_MISSING',
  'DIRECT_SALE_EXTRA_BLOCKED',
]);

// ------------------------------------------------------------------ facts

/**
 * What a verdict is computed from, per product, in ONE statement: the row's
 * clock, its section, picture count, pricing state and input/rule
 * signatures, and the relation rows' presence counts (no value: counts of
 * rows that carry a cost or a measure, never the amounts). `facts_key` hashes
 * these with the global rules' signature and the list version.
 */
const FACTS_SQL = `SELECT p.id AS id, p.slug AS slug, p.status AS status, p.updated_at AS updated_at,
  COALESCE(p.composition, '') AS composition,
  (CASE WHEN COALESCE(p.category_id, '') <> '' AND EXISTS (SELECT 1 FROM catalogs c WHERE c.id = p.category_id) THEN 1 ELSE 0 END) AS cat_ok,
  (SELECT COUNT(*) FROM product_images i WHERE i.product_id = p.id AND COALESCE(i.quarantined, 0) = 0) AS images,
  COALESCE(s.mode, 'manual') AS mode, COALESCE(s.inputs_seq, 0) AS inputs_seq, COALESCE(s.reprice_blocked_code, '') AS blocked,
  (SELECT COUNT(*) || ':' || COALESCE(MAX(pi.updated_at), '') || ':' || TOTAL(pi.version) FROM pricing_inputs pi WHERE pi.product_id = p.id) AS inputs_sig,
  (SELECT COUNT(*) || ':' || COALESCE(MAX(r.updated_at), '') || ':' || TOTAL(r.version) FROM pricing_rules r WHERE r.product_id = p.id) AS rules_sig,
  (SELECT COUNT(*) || ':' || TOTAL(v.active) || ':' || TOTAL(v.merged_into IS NOT NULL) || ':' || TOTAL(v.cost_iqd IS NOT NULL) || ':' || TOTAL(v.cost_adjust_iqd IS NOT NULL)
          || ':' || TOTAL(COALESCE(v.package_weight_g, 0) > 0) || ':' || TOTAL(COALESCE(v.package_width_mm, 0) > 0 AND COALESCE(v.package_depth_mm, 0) > 0 AND COALESCE(v.package_height_mm, 0) > 0)
     FROM product_option_values v WHERE v.product_id = p.id) AS values_sig,
  (SELECT COUNT(*) || ':' || TOTAL(g.active) FROM product_option_groups g WHERE g.product_id = p.id) AS groups_sig,
  (SELECT COUNT(*) || ':' || TOTAL(f.enabled) || ':' || TOTAL(f.cost_iqd IS NOT NULL) || ':' || TOTAL(f.cost_adjust_iqd IS NOT NULL) FROM product_option_fulfillment f WHERE f.product_id = p.id) AS cells_sig,
  (SELECT COUNT(*) || ':' || TOTAL(t.enabled) || ':' || TOTAL(t.cost_iqd IS NOT NULL) || ':' || TOTAL(t.cost_adjust_iqd IS NOT NULL) FROM product_option_transports t WHERE t.product_id = p.id) AS routes_sig,
  (SELECT COUNT(*) || ':' || TOTAL(k.active) FROM product_colors k WHERE k.product_id = p.id) AS colors_sig,
  pc.facts_key AS stored_key, pc.list_version AS stored_version, pc.complete AS stored_complete, pc.held AS stored_held
FROM products p
LEFT JOIN product_pricing_state s ON s.product_id = p.id
LEFT JOIN product_completeness pc ON pc.product_id = p.id`;

/** The minimum-profit and Direct Sale Extra rules every product inherits (global and category scope). */
const GLOBAL_RULES_SQL = `SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') || ':' || TOTAL(version) AS sig FROM pricing_rules WHERE product_id IS NULL`;

export interface FactsRow {
  id: string;
  slug: string;
  status: string;
  updated_at: string;
  composition: string;
  cat_ok: number;
  images: number;
  mode: string;
  inputs_seq: number;
  blocked: string;
  inputs_sig: string;
  rules_sig: string;
  values_sig: string;
  groups_sig: string;
  cells_sig: string;
  routes_sig: string;
  colors_sig: string;
  stored_key: string | null;
  stored_version: number | null;
  stored_complete: number | null;
  stored_held: number | null;
}

/** The digest of one product's facts (64 hex, the column's bound). */
export async function factsKeyOf(f: FactsRow, globalSig: string): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      COMPLETENESS_LIST_VERSION,
      f.updated_at ?? '',
      Number(f.cat_ok) || 0,
      Number(f.images) || 0,
      f.mode,
      Number(f.inputs_seq) || 0,
      f.blocked ?? '',
      f.inputs_sig ?? '',
      f.rules_sig ?? '',
      f.values_sig ?? '',
      f.groups_sig ?? '',
      f.cells_sig ?? '',
      f.routes_sig ?? '',
      f.colors_sig ?? '',
      globalSig,
    ])
  );
}

/** The global rules' signature (one statement), as `factsKeyOf` reads it. */
export async function globalRulesSig(db: D1Database): Promise<string> {
  const row = await db.prepare(GLOBAL_RULES_SQL).first<{ sig: string }>();
  return String(row?.sig ?? '');
}

/** The facts of the named products (any status; compositions included so the caller can skip them). */
export async function loadFacts(db: D1Database, ids: readonly string[]): Promise<FactsRow[]> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  if (!unique.length) return [];
  const { results } = await db
    .prepare(`${FACTS_SQL} WHERE p.id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(unique))
    .all<FactsRow>();
  return (results ?? []) as FactsRow[];
}

/** Every ordinary product's facts (the sweep, the owner's summary). */
async function loadAllFacts(db: D1Database): Promise<FactsRow[]> {
  const { results } = await db.prepare(`${FACTS_SQL} WHERE COALESCE(p.composition, '') = '' ORDER BY p.id`).all<FactsRow>();
  return (results ?? []) as FactsRow[];
}

// ------------------------------------------------------------------ the rules (pure)

export interface EvaluationInput {
  id: string;
  doc: ProductDoc;
  view: ProductRelationsView | undefined;
  mode: 'manual' | 'engine';
  inputs: readonly Partial<StoredInputRow>[];
  rules: readonly PricingRuleRow[];
  /** The main section is set and exists. */
  category_ok: boolean;
  /** The engine's last blocked-repricing code ('' = none). */
  blocked: string;
}

const positive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;

const hasBox = (d: { package_width_mm?: number | null; package_depth_mm?: number | null; package_height_mm?: number | null } | null | undefined): boolean =>
  !!d && positive(d.package_width_mm) && positive(d.package_depth_mm) && positive(d.package_height_mm);

const supplierResolves = (chain: Parameters<typeof resolveSkuInputs>[0]): boolean => {
  const r = resolveSkuInputs(chain);
  return r.problems.supplier.length === 0 && !!r.inputs.supplier;
};

const targetActive = (rules: readonly PricingRuleRow[], productId: string, optionValueIds: readonly string[], colorId: string | null): boolean =>
  resolveRuleAt(rules, 'target_profit', { product_id: productId, option_value_ids: optionValueIds, color_id: colorId, ancestry: [] }).status === 'active';

/**
 * The missing items of one product, in list order (product-level items first,
 * then per model). Pure over what was loaded.
 */
export function evaluateCompleteness(e: EvaluationInput): CompletenessItem[] {
  const out: CompletenessItem[] = [];
  const add = (code: CompletenessCode, option_id = '') => out.push({ code, option_id });
  const { doc } = e;
  const { models } = modelsOf(doc, e.view);
  const realModels = models.filter((m): m is OptionV2 => !!m);
  // The SKUs a customer can buy, by model (FX-7: a supplier cost may sit on a colour or SKU level).
  const sku = sellableSkus(doc, e.view);
  const unitsOf = (modelId: string) => (sku.overflow ? [] : sku.skus.filter((s) => (s.model?.id ?? '') === modelId));

  if (!String(doc.name_ar ?? '').trim()) add('NAME_AR');
  if (e.mode !== 'engine' && !positive(doc.price_iqd)) add('PRICE');

  // COST ★: every model reaches one.
  for (const m of models) {
    const modelId = m?.id ?? '';
    const legacy = legacyCostOf(doc, m);
    if (legacy !== null && legacy > 0) continue;
    if (supplierResolves(chainOf(e.inputs, modelId))) continue;
    const units = unitsOf(modelId);
    if (units.length && units.every((u) => supplierResolves(chainOfUnit(e.inputs, { option_value_ids: u.option_value_ids, color_id: u.color?.id ?? null, combo_key: u.combo_key })))) continue;
    add('COST', modelId);
  }

  // ENGINE_INPUTS ★: an engine product's own pricing data (never the rates).
  if (e.mode === 'engine') {
    if (e.blocked && INPUT_BLOCK_CODES.has(e.blocked)) add('ENGINE_INPUTS');
    for (const m of models) {
      const modelId = m?.id ?? '';
      if (targetActive(e.rules, e.id, modelId ? [modelId] : [], null)) continue;
      const units = unitsOf(modelId);
      if (units.length && units.every((u) => targetActive(e.rules, e.id, u.option_value_ids, u.color?.id ?? null))) continue;
      if (!out.some((i) => i.code === 'ENGINE_INPUTS' && i.option_id === modelId)) add('ENGINE_INPUTS', modelId);
    }
  }

  if (!(doc.media ?? []).length) add('IMAGE');
  if (!e.category_ok) add('CATEGORY');

  const dims = doc.dimensions;
  if (!positive(dims?.package_weight_g) && !(realModels.length > 0 && realModels.every((m) => positive(m.package_weight_g)))) add('PACKAGE_WEIGHT');
  if (!hasBox(dims) && !(realModels.length > 0 && realModels.every((m) => hasBox(m)))) add('PACKAGE_BOX');

  return out;
}

export const privateCount = (items: readonly CompletenessItem[]): number =>
  items.filter((i) => isCompletenessCode(i.code) && COMPLETENESS_ENTRIES[i.code].private).length;

/**
 * What one viewer may read of a verdict: the verified owner (and a cost grantee)
 * every item; any other admin the public items plus ONE OWNER_DATA item when a
 * private one is missing — never which.
 */
export function projectItems(items: readonly CompletenessItem[], canSeePrivate: boolean): CompletenessItem[] {
  if (canSeePrivate) return items.map((i) => ({ ...i }));
  const pub = items.filter((i) => !(isCompletenessCode(i.code) && COMPLETENESS_ENTRIES[i.code].private)).map((i) => ({ ...i }));
  if (pub.length < items.length) pub.push({ code: OWNER_DATA_CODE, option_id: '' });
  return pub;
}

/** A stored `missing_json`, read defensively (codes only; anything else is dropped). */
export function parseMissing(raw: unknown): CompletenessItem[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: CompletenessItem[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const c = (x as { c?: unknown }).c;
    const o = (x as { o?: unknown }).o;
    if (isCompletenessCode(c)) out.push({ code: c, option_id: typeof o === 'string' ? o : '' });
  }
  return out;
}

const serializeMissing = (items: readonly CompletenessItem[]): string => JSON.stringify(items.map((i) => ({ c: i.code, o: i.option_id })));

// ------------------------------------------------------------------ the writer

/**
 * One product's verdict, upserted. `held` is decided INSIDE the statement from
 * the owner's switch as stored at that instant, so a concurrent toggle can
 * never leave it stale; the row is written only while the product's clock is
 * still the one the verdict read (a newer save recomputes on its own).
 */
const UPSERT_SQL = `INSERT INTO product_completeness (product_id, complete, held, missing_json, missing_count, private_missing, list_version, facts_key, computed_at)
SELECT ?, ?, (CASE WHEN ? = 0 AND EXISTS (SELECT 1 FROM admin_settings s WHERE s.key = '${HIDE_SETTING_KEY}' AND json_valid(s.value) AND json_extract(s.value, '$.enabled') = 1) THEN 1 ELSE 0 END), ?, ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND updated_at IS ? AND COALESCE(composition, '') = '')
ON CONFLICT(product_id) DO UPDATE SET complete = excluded.complete, held = excluded.held, missing_json = excluded.missing_json,
  missing_count = excluded.missing_count, private_missing = excluded.private_missing, list_version = excluded.list_version,
  facts_key = excluded.facts_key, computed_at = excluded.computed_at`;

export interface Verdict {
  id: string;
  slug: string;
  status: string;
  items: CompletenessItem[];
  complete: boolean;
  facts_key: string;
  /** `held` as stored before this recompute (null: no row yet). */
  held_before: boolean | null;
}

export interface RecomputeResult {
  verdicts: Verdict[];
  /** Slugs whose customer visibility flipped with this recompute (purge their pages). */
  flipped: string[];
  /** Statements spent. */
  statements: number;
}

/** Is the owner's switch on, as stored? (Unknown or broken reads as OFF.) */
export async function hideSwitchOn(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(HIDE_SETTING_KEY).first<{ value: string }>();
    if (!row) return false;
    const v = JSON.parse(String(row.value)) as { enabled?: unknown };
    return v?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Evaluate the named products (≤ COMPLETENESS_CHUNK per call; more are cut)
 * and store each verdict. Compositions and unknown ids are skipped. Without
 * migration 0184 nothing is read or written.
 */
export async function recomputeCompleteness(
  db: D1Database,
  ids: readonly string[],
  opts: { facts?: readonly FactsRow[]; globalSig?: string; now?: string; write?: boolean } = {}
): Promise<RecomputeResult> {
  const none: RecomputeResult = { verdicts: [], flipped: [], statements: 0 };
  if (!(await completenessInstalled(db))) return none;
  const wanted = [...new Set(ids)].slice(0, COMPLETENESS_CHUNK);
  if (!wanted.length) return none;
  let statements = 0;
  let facts: readonly FactsRow[];
  if (opts.facts) facts = opts.facts.filter((f) => wanted.includes(f.id));
  else {
    facts = await loadFacts(db, wanted);
    statements += 1;
  }
  const ordinary = facts.filter((f) => !f.composition);
  if (!ordinary.length) return { ...none, statements };
  let globalSig = opts.globalSig;
  if (globalSig === undefined) {
    globalSig = await globalRulesSig(db);
    statements += 1;
  }
  const idsToLoad = ordinary.map((f) => f.id);
  const [loaded, pricing] = await Promise.all([loadProducts(db, idsToLoad), loadProductsPricing(db, idsToLoad)]);
  statements += 10 + 4;
  const switchOn = await hideSwitchOn(db);
  statements += 1;
  const now = opts.now ?? new Date().toISOString();
  const verdicts: Verdict[] = [];
  const writes: D1PreparedStatement[] = [];
  for (const f of ordinary) {
    const l = loaded.get(f.id);
    if (!l) continue;
    const p = pricing.get(f.id);
    const items = evaluateCompleteness({
      id: f.id,
      doc: l.doc,
      view: l.view,
      mode: f.mode === 'engine' ? 'engine' : 'manual',
      inputs: p?.inputs ?? [],
      rules: p?.rules ?? [],
      category_ok: Number(f.cat_ok) === 1,
      blocked: String(f.blocked ?? ''),
    });
    const key = await factsKeyOf(f, globalSig);
    const complete = items.length === 0;
    verdicts.push({
      id: f.id,
      slug: String(f.slug ?? ''),
      status: String(f.status ?? ''),
      items,
      complete,
      facts_key: key,
      held_before: f.stored_held === null || f.stored_held === undefined ? null : Number(f.stored_held) === 1,
    });
    writes.push(
      db
        .prepare(UPSERT_SQL)
        .bind(f.id, complete ? 1 : 0, complete ? 1 : 0, serializeMissing(items), items.length, privateCount(items), COMPLETENESS_LIST_VERSION, key, now, f.id, f.updated_at ?? null)
    );
  }
  if (opts.write !== false && writes.length) {
    await db.batch(writes);
    statements += writes.length;
  }
  const flipped = verdicts
    .filter((v) => v.status === 'active' && (v.held_before ?? false) !== (switchOn && !v.complete))
    .map((v) => v.slug)
    .filter(Boolean);
  return { verdicts, flipped, statements };
}

/** Recompute in chunks (the owner's recount, a bulk write). Best effort per chunk. */
export async function recomputeMany(db: D1Database, ids: readonly string[]): Promise<RecomputeResult> {
  const out: RecomputeResult = { verdicts: [], flipped: [], statements: 0 };
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += COMPLETENESS_CHUNK) {
    const r = await recomputeCompleteness(db, unique.slice(i, i + COMPLETENESS_CHUNK));
    out.verdicts.push(...r.verdicts);
    out.flipped.push(...r.flipped);
    out.statements += r.statements;
  }
  return out;
}

// ------------------------------------------------------------------ staleness, the sweep, the summary

export interface StaleScan {
  facts: FactsRow[];
  globalSig: string;
  /** Ordinary products with no verdict, or one computed from other facts or another list version. */
  stale: FactsRow[];
}

export async function scanStale(db: D1Database): Promise<StaleScan> {
  const [facts, globalSig] = await Promise.all([loadAllFacts(db), globalRulesSig(db)]);
  const stale: FactsRow[] = [];
  for (const f of facts) {
    if (f.composition) continue;
    if (!f.stored_key || Number(f.stored_version) !== COMPLETENESS_LIST_VERSION) {
      stale.push(f);
      continue;
    }
    if ((await factsKeyOf(f, globalSig)) !== f.stored_key) stale.push(f);
  }
  return { facts, globalSig, stale };
}

export interface SweepReport {
  scanned: number;
  stale: number;
  recomputed: number;
  flipped: string[];
  statements: number;
}

/**
 * THE QUARTER-HOUR CATCH-UP: products whose verdict is missing or stale are
 * re-evaluated, oldest id first, within `budget` (every statement charged
 * before it is sent). Runs after the engine sweep with what is left
 * (worker/index.ts). Never throws.
 */
/** The quarter-hour's statement budget as the sweep spends it (worker/lib/fx/budget.ts `statementBudget` fits). */
export interface SweepBudget {
  canSpend(n: number): boolean;
  spend(n: number): boolean;
  remaining(): number;
}

export async function sweepCompleteness(db: D1Database, budget: SweepBudget): Promise<SweepReport> {
  const report: SweepReport = { scanned: 0, stale: 0, recomputed: 0, flipped: [], statements: 0 };
  try {
    if (!budget.canSpend(1)) return report;
    budget.spend(1);
    report.statements += 1;
    if (!(await completenessInstalled(db))) return report;
    if (!budget.canSpend(2)) return report;
    budget.spend(2);
    report.statements += 2;
    const scan = await scanStale(db);
    report.scanned = scan.facts.length;
    report.stale = scan.stale.length;
    const room = budget.remaining();
    let n = Math.min(COMPLETENESS_CHUNK, scan.stale.length);
    while (n > 0 && recomputeCost(n) - 2 > room) n--;
    if (n <= 0) return report;
    const batch = scan.stale.slice(0, n);
    const cost = recomputeCost(n) - 2; // the facts and the rules signature were read by the scan
    if (!budget.spend(cost)) return report;
    const r = await recomputeCompleteness(db, batch.map((f) => f.id), { facts: batch, globalSig: scan.globalSig });
    report.recomputed = r.verdicts.length;
    report.flipped = r.flipped;
    report.statements += cost;
  } catch (error) {
    console.error('completeness sweep failed:', error instanceof Error ? error.name : 'unknown');
  }
  return report;
}

export interface HideSummary {
  enabled: boolean;
  since: string | null;
  total_ordinary: number;
  evaluated: number;
  stale: number;
  /** Active ordinary products the switch hides (incomplete). */
  would_hide: number;
  /** Held right now. */
  held: number;
  /** Active bundles with an active member that would be hidden. */
  bundles_affected: number;
  /** Up to ten names of products it hides. */
  sample: Array<{ id: string; name_ar: string; name_en: string; missing_count: number }>;
}

/** The owner's card: what the switch does (or does) right now. */
export async function hideSummary(db: D1Database, setting: { enabled: boolean; since: string | null }): Promise<HideSummary> {
  const scan = await scanStale(db);
  const ordinary = scan.facts.filter((f) => !f.composition);
  const [counts, bundles, sample] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS evaluated,
              TOTAL(pc.complete = 0 AND p.status = 'active') AS would_hide,
              TOTAL(pc.held = 1) AS held
         FROM product_completeness pc JOIN products p ON p.id = pc.product_id
        WHERE COALESCE(p.composition, '') = ''`
    ),
    db.prepare(
      `SELECT COUNT(DISTINCT bc.bundle_product_id) AS n
         FROM bundle_components bc
         JOIN products b ON b.id = bc.bundle_product_id AND b.status = 'active'
         JOIN products m ON m.id = bc.member_product_id AND m.status = 'active'
         JOIN product_completeness pc ON pc.product_id = m.id AND pc.complete = 0`
    ),
    db.prepare(
      `SELECT p.id AS id, COALESCE(p.name_ar, '') AS name_ar, COALESCE(p.name, '') AS name_en, pc.missing_count AS missing_count
         FROM product_completeness pc JOIN products p ON p.id = pc.product_id
        WHERE pc.complete = 0 AND p.status = 'active' AND COALESCE(p.composition, '') = ''
        ORDER BY pc.missing_count DESC, p.id LIMIT 10`
    ),
  ]);
  const c = ((counts as D1Result<{ evaluated: number; would_hide: number; held: number }>).results ?? [])[0];
  const b = ((bundles as D1Result<{ n: number }>).results ?? [])[0];
  return {
    enabled: setting.enabled,
    since: setting.since,
    total_ordinary: ordinary.length,
    evaluated: Number(c?.evaluated ?? 0),
    stale: scan.stale.length,
    would_hide: Number(c?.would_hide ?? 0),
    held: Number(c?.held ?? 0),
    bundles_affected: Number(b?.n ?? 0),
    sample: ((sample as D1Result<{ id: string; name_ar: string; name_en: string; missing_count: number }>).results ?? []).map((r) => ({
      id: String(r.id),
      name_ar: String(r.name_ar ?? ''),
      name_en: String(r.name_en ?? ''),
      missing_count: Number(r.missing_count ?? 0),
    })),
  };
}

/** One product's stored verdict, or null (no row yet / no 0184). */
export async function storedVerdict(
  db: D1Database,
  productId: string
): Promise<{ complete: boolean; held: boolean; items: CompletenessItem[]; computed_at: string; facts_key: string } | null> {
  if (!(await completenessInstalled(db))) return null;
  const row = await db
    .prepare('SELECT complete, held, missing_json, computed_at, facts_key FROM product_completeness WHERE product_id = ?')
    .bind(productId)
    .first<{ complete: number; held: number; missing_json: string; computed_at: string; facts_key: string }>();
  if (!row) return null;
  return {
    complete: Number(row.complete) === 1,
    held: Number(row.held) === 1,
    items: parseMissing(row.missing_json),
    computed_at: String(row.computed_at ?? ''),
    facts_key: String(row.facts_key ?? ''),
  };
}

/**
 * A PRODUCT AS IT WOULD BE — the data file's preview («ما الذي سيبقى ناقصاً
 * بعد التطبيق»): the verdict of the list on a document and pricing data that
 * are not saved yet. Reads only the section's existence and (when not given)
 * the stored pricing data; writes nothing.
 */
export async function evaluateDraft(
  db: D1Database,
  d: {
    id: string;
    doc: ProductDoc;
    view: ProductRelationsView | undefined;
    mode: 'manual' | 'engine';
    inputs?: readonly Partial<StoredInputRow>[];
    rules?: readonly PricingRuleRow[];
  }
): Promise<CompletenessItem[]> {
  const categoryId = String(d.doc.category_id ?? '');
  const [category, pricing] = await Promise.all([
    categoryId ? db.prepare('SELECT 1 AS x FROM catalogs WHERE id = ?').bind(categoryId).first<{ x: number }>() : Promise.resolve(null),
    d.inputs && d.rules ? Promise.resolve(null) : loadProductsPricing(db, [d.id]).then((m) => m.get(d.id) ?? null),
  ]);
  return evaluateCompleteness({
    id: d.id,
    doc: d.doc,
    view: d.view,
    mode: d.mode,
    inputs: d.inputs ?? pricing?.inputs ?? [],
    rules: d.rules ?? pricing?.rules ?? [],
    category_ok: !!category,
    blocked: '',
  });
}
