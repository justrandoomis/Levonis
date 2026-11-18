/**
 * SMART TRADE-IN VALUE — the database side (owner, 2026-11-18; DECISIONS row 353; migration 0238).
 *
 * What the pure formula (packages/pricing/src/tradeInOffer.ts) needs beyond the 0192 offer:
 *
 *   the family's knobs     `trade_in_smart_params` (NULL / no row / no table = the code default)
 *   the model's profile    `trade_in_model_profiles`: the owner's resale share, the newer generation
 *   the model's resales    what traded-in units of the model really sold for, read from the stock
 *                          lot each one became (`trade_in_stock` → its allocations → the order line)
 *                          against the intake valuation's own figures (today's price × condition)
 *
 * and the owner's VALUE TABLE: every printer model, today's price, the resale share in force and
 * where it came from, and the offer at 3 / 6 / 12 / 24 months in good condition.
 *
 * PRIVATE, ALL OF IT: resale shares, samples and the table are the owner's (rows 220, 238). The
 * customer reads only the one offer. A database without 0238 prices as before (defaults, no model
 * profile) — every read here treats «no such table» as empty.
 */
import type { Env } from './types';
import { safeParse } from './types';
import { auditStatements } from './audit';
import { badRequest, notFound } from './http';
import { catalogIndexFor } from './catalogPresentation';
import { TodayReader } from './tradeInToday';
import { familyOfProduct, loadRuleBook, type RuleBook } from './tradeIn';
import { offerParamsOf } from './tradeInOffer';
import { blankInputs, TRADE_IN_FAMILIES, type TradeInFamily } from '@levonis/pricing/tradeIn';
import {
  componentOffer,
  modelResaleBp,
  requestOffer,
  resaleSampleBp,
  smartParamsOf,
  teachingSamples,
  validateSmartParams,
  MODEL_RESALE_RANGE,
  SMART_PARAM_COLUMNS,
  type ResaleSource,
  type SmartParamColumn,
  type SmartParams,
} from '@levonis/pricing/tradeInOffer';

const missingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));
async function orEmpty<T>(f: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (missingTable(e)) return empty;
    throw e;
  }
}

// ============================================================ the family's knobs

export type SmartBook = Record<TradeInFamily, SmartParams>;
type SmartRow = { family: TradeInFamily } & Partial<Record<SmartParamColumn, number | null>>;

export async function storedSmartParams(db: D1Database): Promise<Partial<Record<TradeInFamily, Partial<Record<SmartParamColumn, number | null>>>>> {
  const rows = await orEmpty(
    async () =>
      (await db.prepare(`SELECT family, ${SMART_PARAM_COLUMNS.join(', ')} FROM trade_in_smart_params`).all<SmartRow>()).results ?? [],
    [] as SmartRow[]
  );
  return Object.fromEntries(rows.map((r) => [r.family, r]));
}

export async function loadSmartBook(db: D1Database): Promise<SmartBook> {
  const stored = await storedSmartParams(db);
  return Object.fromEntries(TRADE_IN_FAMILIES.map((f) => [f, smartParamsOf(f, stored[f])])) as SmartBook;
}

/** The owner's edit of one family's knobs: each key sent is checked; a key not sent keeps its value. */
export async function saveSmartParams(env: Env, family: TradeInFamily, raw: unknown, adminId: string): Promise<SmartBook> {
  const checked = validateSmartParams(raw);
  if (!checked.ok) throw badRequest('Invalid smart-value parameters', 'TRADE_IN_RULES_INVALID', { errors: checked.errors });
  const before = (await storedSmartParams(env.DB))[family] ?? {};
  const merged = Object.fromEntries(SMART_PARAM_COLUMNS.map((k) => [k, k in checked.value ? (checked.value[k] ?? null) : (before[k] ?? null)]));
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO trade_in_smart_params (family, ${SMART_PARAM_COLUMNS.join(', ')}, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (family) DO UPDATE SET ${SMART_PARAM_COLUMNS.map((k, i) => `${k} = ?${i + 2}`).join(', ')}, updated_by = ?7, updated_at = ?8`
    ).bind(family, ...SMART_PARAM_COLUMNS.map((k) => merged[k] ?? null), adminId, now),
    ...(await auditStatements(env.DB, adminId, 'trade_in.smart_params.save', family, { family, ...merged })).statements,
  ]);
  return loadSmartBook(env.DB);
}

// ============================================================ the model's profile

export interface ModelProfile {
  product_id: string;
  resale_bp: number | null;
  successor_product_id: string | null;
  superseded_bp: number | null;
  /** 1 = valued from what was paid while the model has no price on sale (the owner's switch). */
  value_off_sale: number;
  note: string;
  updated_at: string;
}
const PROFILE_COLUMNS = 'product_id, resale_bp, successor_product_id, superseded_bp, value_off_sale, note, updated_at';

export async function modelProfiles(db: D1Database, productIds?: readonly string[]): Promise<Map<string, ModelProfile>> {
  const rows = await orEmpty(
    async () =>
      (
        await (productIds
          ? db
              .prepare(
                `SELECT ${PROFILE_COLUMNS} FROM trade_in_model_profiles WHERE product_id IN (SELECT value FROM json_each(?1))`
              )
              .bind(JSON.stringify(productIds))
          : db.prepare(`SELECT ${PROFILE_COLUMNS} FROM trade_in_model_profiles`)
        ).all<ModelProfile>()
      ).results ?? [],
    [] as ModelProfile[]
  );
  return new Map(rows.map((r) => [r.product_id, r]));
}

const intOrNull = (v: unknown, lo: number, hi: number, field: string, errors: string[]): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < lo || v > hi) {
    errors.push(field);
    return null;
  }
  return v;
};

/** The owner's edit of one model's profile; every field null = the row is removed (the model follows its family). */
export async function saveModelProfile(env: Env, productId: string, raw: unknown, adminId: string): Promise<ModelProfile | null> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const resale = intOrNull(o.resale_bp, MODEL_RESALE_RANGE[0], MODEL_RESALE_RANGE[1], 'resale_bp', errors);
  const superseded = intOrNull(o.superseded_bp, 0, 5_000, 'superseded_bp', errors);
  const successor = typeof o.successor_product_id === 'string' && o.successor_product_id.trim() !== '' ? o.successor_product_id.trim().slice(0, 80) : null;
  const before = (await modelProfiles(env.DB, [productId])).get(productId) ?? null;
  // A field not sent keeps its value (the note; the off-sale switch).
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 500) : (before?.note ?? '');
  if (o.value_off_sale !== undefined && typeof o.value_off_sale !== 'boolean') errors.push('value_off_sale');
  const offSale = o.value_off_sale === undefined ? (before?.value_off_sale ?? 0) : o.value_off_sale ? 1 : 0;
  if (successor === productId) errors.push('successor_product_id');
  if (errors.length) throw badRequest('Invalid model profile', 'TRADE_IN_RULES_INVALID', { errors });
  const exists = await env.DB.prepare('SELECT (SELECT 1 FROM products WHERE id = ?1) AS model, (SELECT 1 FROM products WHERE id = ?2) AS successor')
    .bind(productId, successor ?? '')
    .first<{ model: number | null; successor: number | null }>();
  if (!exists?.model) throw notFound('Product not found');
  if (successor && !exists.successor) throw notFound('Successor product not found');
  const now = new Date().toISOString();
  const empty = resale === null && successor === null && superseded === null && note === '' && offSale === 0;
  await env.DB.batch([
    empty
      ? env.DB.prepare('DELETE FROM trade_in_model_profiles WHERE product_id = ?1').bind(productId)
      : env.DB.prepare(
          `INSERT INTO trade_in_model_profiles (product_id, resale_bp, successor_product_id, superseded_bp, value_off_sale, note, updated_by, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT (product_id) DO UPDATE SET resale_bp = ?2, successor_product_id = ?3, superseded_bp = ?4, value_off_sale = ?5, note = ?6, updated_by = ?7, updated_at = ?8`
        ).bind(productId, resale, successor, superseded, offSale, note, adminId, now),
    ...(await auditStatements(env.DB, adminId, 'trade_in.model_profile.save', productId, {
      resale_bp: resale,
      successor_product_id: successor,
      superseded_bp: superseded,
      value_off_sale: offSale,
      note,
    })).statements,
  ]);
  return (await modelProfiles(env.DB, [productId])).get(productId) ?? null;
}

// ============================================================ what the model really resold for

interface SoldRow {
  source_product_id: string | null;
  request_id: string;
  revenue_iqd: number;
  sold_at: string | null;
  components_json: string | null;
}

/**
 * Each traded-in unit of these models that was resold, against the intake valuation (today's price ×
 * condition of every part). One sample per resold unit; a sale with no readable valuation teaches nothing.
 *
 * Each model's NEWEST 20 resales teach; from 5 on, its highest and lowest are dropped (teachingSamples).
 *
 * ONLY A FINISHED SALE TEACHES (a sample moves every customer's offer for the model): the order is
 * DELIVERED, the line has no open, refunded or replaced return, and its figure is the line's unit
 * price — the listed price the owner set, before any coupon or points a buyer could stack to drag a
 * model's share down. A cancelled, undelivered or returned sale teaches nothing.
 */
export async function resaleSamples(db: D1Database, productIds: readonly string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (productIds.length === 0) return out;
  const rows = await orEmpty(
    async () =>
      (
        await db
          .prepare(
            `SELECT s.source_product_id, s.request_id,
                    MIN(oi.unit_price_iqd) AS revenue_iqd,
                    MAX(COALESCE(o.delivered_at, o.updated_at)) AS sold_at,
                    (SELECT v.components_json FROM trade_in_valuations v
                      WHERE v.request_id = s.request_id AND v.phase IN ('intake','override','submit')
                      ORDER BY CASE v.phase WHEN 'override' THEN 0 WHEN 'intake' THEN 1 ELSE 2 END, v.created_at DESC LIMIT 1) AS components_json
               FROM trade_in_stock s
               JOIN order_item_inventory_allocations a ON a.lot_id = s.lot_id AND a.released_at IS NULL
               JOIN order_items oi ON oi.id = a.order_item_id
               JOIN orders o ON o.id = a.order_id AND o.status = 'delivered'
              WHERE s.source_product_id IN (SELECT value FROM json_each(?1))
                AND oi.unit_price_iqd > 0
                AND NOT EXISTS (SELECT 1 FROM return_cases rc
                                 WHERE rc.order_item_id = oi.id AND rc.state <> 'rejected' AND (rc.resolution IS NULL OR rc.resolution IN ('refund','replacement')))
              GROUP BY s.request_id
              ORDER BY sold_at DESC, s.request_id
              LIMIT 2000`
          )
          .bind(JSON.stringify(productIds))
          .all<SoldRow>()
      ).results ?? [],
    [] as SoldRow[]
  );
  for (const r of rows) {
    if (!r.source_product_id) continue;
    const parts = safeParse<unknown>(r.components_json ?? '[]', []);
    const list = Array.isArray(parts) ? (parts as Array<{ now_iqd?: unknown; q_bp?: unknown }>) : [];
    // Σ now_c × q_c / 10^4 — today's price at the condition, every part the unit carried.
    const atCondition = list.reduce((n, c) => {
      const now = Number(c.now_iqd);
      const q = Number(c.q_bp);
      return Number.isFinite(now) && Number.isFinite(q) && now > 0 && q > 0 ? n + Math.floor((now * q) / 10_000) : n;
    }, 0);
    const sample = resaleSampleBp(Math.round(Number(r.revenue_iqd) || 0), atCondition, 10_000);
    if (sample === null) continue;
    const arr = out.get(r.source_product_id) ?? [];
    arr.push(sample);
    out.set(r.source_product_id, arr);
  }
  // Newest first already: each model keeps its newest LEARN_MAX_SAMPLES, the extremes trimmed.
  for (const [k, v] of out) out.set(k, teachingSamples(v));
  return out;
}

// ============================================================ the model's resale share

export interface ModelResale {
  resale_bp: number;
  source: ResaleSource;
  learned_bp: number;
  samples: number;
  superseded: boolean;
}

/** The resale share in force for a model of `family` (its owner figure, else learned, less a newer generation on sale). */
export async function modelResaleFor(
  db: D1Database,
  reader: TodayReader,
  productId: string,
  familyResaleBp: number,
  smart: SmartParams,
  pre?: { profile?: ModelProfile | null; samples?: number[] }
): Promise<ModelResale> {
  const profile = pre && 'profile' in pre ? (pre.profile ?? null) : ((await modelProfiles(db, [productId])).get(productId) ?? null);
  const samples = pre?.samples ?? (await resaleSamples(db, [productId])).get(productId) ?? [];
  const successorOnSale = profile?.successor_product_id ? (await reader.lowest(profile.successor_product_id)) !== null : false;
  const r = modelResaleBp(familyResaleBp, {
    ownerBp: profile?.resale_bp ?? null,
    samples,
    weight: smart.learn_weight,
    superseded: successorOnSale,
    supersededBp: profile?.superseded_bp ?? smart.superseded_bp,
  });
  return { ...r, superseded: successorOnSale };
}

// ============================================================ the owner's value table

export const TABLE_MONTHS = [3, 6, 12, 24] as const;
/** The value table assumes a year's warranty from delivery — the store's own printer warranty. */
const TABLE_WARRANTY_MONTHS = 12;

export interface ValueTableRow {
  product_id: string;
  name: string;
  name_ar: string;
  family: TradeInFamily;
  status: string;
  /** Today's lowest public new price; null = not on sale (an offer then starts from what was paid). */
  now_iqd: number | null;
  resale: ModelResale;
  profile: ModelProfile | null;
  /** The offer in good condition (scores 4, every accessory, normal hours), bought at today's price. */
  offers: Array<{ months: number; offer_iqd: number | null }>;
}

/** Every printer model (a product of a printer catalog, FDM / resin / laser), with its value at 3–24 months. */
export async function valueTable(env: Env): Promise<{ rows: ValueTableRow[]; smart: SmartBook; months: readonly number[] }> {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.name_ar, p.status, p.template_family, p.category_id, p.sub_category_id
         FROM products p
        WHERE p.id IN (SELECT pc.product_id FROM product_catalogs pc JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1)
          AND p.id NOT LIKE 'prd_ti_%' AND COALESCE(p.condition_doc, '{}') = '{}'
        ORDER BY p.name
        LIMIT 120`
    )
    .all<Record<string, unknown>>();
  const idx = await catalogIndexFor(db);
  const models = (results ?? [])
    .map((row) => ({ row, family: familyOfProduct(row, idx) }))
    .filter((x): x is { row: Record<string, unknown>; family: TradeInFamily } => x.family === 'fdm' || x.family === 'resin' || x.family === 'laser');
  const ids = models.map((m) => String(m.row.id));
  const [book, smart, profiles, samples] = await Promise.all([loadRuleBook(db), loadSmartBook(db), modelProfiles(db, ids), resaleSamples(db, ids)]);
  const reader = new TodayReader(env);
  const rowOf = async ({ row, family }: { row: Record<string, unknown>; family: TradeInFamily }): Promise<ValueTableRow> => {
    const id = String(row.id);
    const rules = book[family];
    const p = offerParamsOf(rules);
    const s = smart[family];
    const [today, resale] = await Promise.all([
      reader.lowest(id),
      modelResaleFor(db, reader, id, p.resale_bp, s, { profile: profiles.get(id) ?? null, samples: samples.get(id) ?? [] }),
    ]);
    const now = today?.iqd ?? null;
    const offers = TABLE_MONTHS.map((months) => {
      if (now === null) return { months, offer_iqd: null };
      const inputs = { ...blankInputs(family), hours: blankInputs(family).hours === null ? null : months * s.hours_allowance_per_month };
      const c = componentOffer(rules, p, {
        role: 'device',
        family,
        now_iqd: now,
        paid_iqd: now,
        usage_months: months,
        warranty_left_months: Math.max(0, TABLE_WARRANTY_MONTHS - months),
        product_id: id,
        inputs,
        resale_bp: resale.resale_bp,
        smart: s,
      });
      return { months, offer_iqd: requestOffer([c], { wholeComboNowIqd: null, fdmParams: p, rounding: p.offer_rounding_iqd, minOffer: p.min_offer_iqd }).offer_iqd };
    });
    return {
      product_id: id,
      name: String(row.name ?? ''),
      name_ar: String(row.name_ar ?? ''),
      family,
      status: String(row.status ?? ''),
      now_iqd: now,
      resale,
      profile: profiles.get(id) ?? null,
      offers,
    };
  };
  // A few models at a time (each reads its product, relations and successor): bounded, not one long chain.
  const rows: ValueTableRow[] = [];
  for (let i = 0; i < models.length; i += 8) rows.push(...(await Promise.all(models.slice(i, i + 8).map(rowOf))));
  return { rows, smart, months: TABLE_MONTHS };
}

export type { RuleBook };
