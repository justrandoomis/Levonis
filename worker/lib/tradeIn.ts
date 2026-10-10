/**
 * «استبدال الجهاز» — TRADE A DEVICE BOUGHT FROM LEVONIS AGAINST A NEW ONE.
 *
 * The owner (2026-09-26), in full in migrations/0143_trade_in.sql. The short
 * of it: only devices bought HERE, picked from the customer's own delivered
 * orders; the system fills in what it knows, the customer describes the
 * condition and photographs it, a live estimate is shown as an estimate, and
 * an admin inspects the machine and fixes the value — or proposes another one
 * the customer accepts or declines — before the customer pays the difference
 * on the new device.
 *
 * THIS FILE IS THE AUTHORITY. The valuation itself is the pure engine in
 * packages/pricing/src/tradeIn.ts, which the wizard and the admin calculator
 * also run for their previews; everything that needs the database or decides
 * something lives here:
 *
 *   ELIGIBILITY   a delivered, platform (not community-store) order of THIS
 *                 customer, a line whose product is a printer (FDM / Resin),
 *                 a laser, an AMS or a device accessory, not inside a bundle,
 *                 with no return case on it and no part already claimed. The
 *                 order is read by `user_id = ?` — another customer's line is
 *                 "not found", never "forbidden" (IDOR: nothing tells a prober
 *                 the id exists).
 *
 *   THE BASE      «يتم الاعتماد على سعر الجهاز الذي اشتراه» — what the
 *                 customer actually paid for ONE unit of the line: the stored
 *                 unit price, less the extended-warranty fee folded into it
 *                 (the cover that is left is valued by its own factor, not
 *                 twice), less the line's own membership and coupon discounts
 *                 per unit. Never a catalogue price.
 *
 *   THE AMS SPLIT «اذا كان … الـ AMS الذي أتى مع جهاز الكومبو … نتعامل مع سعر
 *                 ams فقط». A Combo is an OPTION of the printer ('a1-combo'
 *                 next to 'a1'). The AMS share is the gap between the Combo
 *                 option and its plain sibling in the same option group, as a
 *                 fraction of the Combo's price — read from the catalogue's
 *                 CURRENT option prices, because the order froze only the
 *                 price of what was bought — and applied to what the customer
 *                 PAID. So a customer who paid 1,100,000 for a Combo listed at
 *                 1,150,000 over a 850,000 plain model has an AMS worth
 *                 1,100,000 × 300/1,150 = 286,956 of it. When the sibling is
 *                 gone (renamed, merged, deleted) the owner's reference value
 *                 in the AMS rule set is used instead (capped at half the paid
 *                 price), and when that is not set either, «AMS فقط» is not
 *                 offered and a whole Combo is valued as one machine — said on
 *                 the screen, never guessed.
 *
 *   THE TARGET    the new device's DIRECT-SALE price for this customer, after
 *                 commission (`resolveUnitPrice` with fulfilment
 *                 'direct_sale', the same resolver the product page and the
 *                 cart use), re-resolved at every step that fixes money. A
 *                 client never sends a price.
 *
 *   THE CREDIT    when the value is fixed, a personal single-use coupon worth
 *                 min(value, target price), bound to this customer, the new
 *                 product and model, direct sale only (`coupons.trade_in_id`).
 *                 The ordinary checkout redeems it; the coupon trigger (0049 /
 *                 0077) makes it count once, inside the order's own batch; the
 *                 checkout's trade-in guard (`tradeInCouponCap`) refuses it on
 *                 any cart that does not hold the target line and caps it at
 *                 that line. If the order it paid for is cancelled, the next
 *                 «إتمام الدفع» mints a fresh coupon — the credit is never lost
 *                 and never doubled.
 *
 *   CONCURRENCY   every state change is ONE batch: the conditional UPDATE on
 *                 the expected status, a fence statement that re-reads this
 *                 batch's random token (and writes NULL into a NOT NULL column
 *                 when it is not there, aborting everything), then the
 *                 dependent writes — events, claims, the coupon, the in-app
 *                 notification. Two admins, or an admin and a Telegram press,
 *                 cannot both win.
 */
import { listing } from './listing';
import type { Env } from './types';
import { safeParse } from './types';
import { newId, randomToken } from './crypto';
import { notifyStatement } from './notifications';
import { notifyCustomer, notificationLang, reachFor, NOTIFY_LANG_SELECT, type NotifyLangRow } from './customerNotify';
import type { EmailLang } from './emailTemplates';
import { enqueue } from './outbox';
import { answerCallbackQuery, editMessageText, sendMessageToChat } from './telegram';
import { announceToAdmins } from './adminTopicRouting';
import { sanitizeUserText } from './walletNotify';
import { auditStatements } from './audit';
import { catalogIndexFor, productTypeOf, type CatalogIndex } from './catalogPresentation';
import { parseProductRow } from './productModel';
import { resolveUnitPrice } from './pricing';
import { applyRelations, capacityFrom, loadRelationsView, snapshotFrom } from './productOverlay';
import { isPrinterProduct, printerProductIds } from './printerIdentity';
import { parseOpsPolicy } from './deviceOps';
import { addMonths } from './membershipOps';
import { effectiveBaseMonths } from './warrantyPlans';
import { serialAssignmentsInstalled } from './serialPolicy';
import { MAX_REPLACEMENT_HOPS, liveUnitOfSlot } from './deviceCustody';
import { benefitFallbackFor, pricingCtxForUser, quoteOptionValueIds, saleAvailability } from '../routes/products';
import {
  DEFAULT_RULE_SETS,
  FACTOR_IDS,
  REQUIRED_PHOTOS,
  STATUS_LABELS,
  TRADE_IN_FAMILIES,
  blankInputs,
  canTransition,
  daysBetween,
  isTerminal,
  missingPhotoAngles,
  rolesForScope,
  tradeInSettlement,
  validateInputs,
  validateRuleSet,
  valuateComponent,
  warrantyMonthsLeft,
  wholeMonthsBetween,
  type ComponentInputs,
  type ComponentRole,
  type ComponentValuation,
  type FactorRule,
  type TradeInFamily,
  type TradeInRuleSet,
  type TradeInScope,
  type TradeInSettlement,
  type TradeInStatus,
} from '@levonis/pricing/tradeIn';

// ================================================================= errors

export type TradeInCode =
  | 'TRADE_IN_NOT_DELIVERED'
  | 'TRADE_IN_NOT_ELIGIBLE'
  | 'TRADE_IN_ALREADY_CLAIMED'
  | 'TRADE_IN_RETURN_OPEN'
  | 'TRADE_IN_BELOW_MINIMUM'
  | 'TRADE_IN_GIFT'
  | 'TRADE_IN_SCOPE_UNAVAILABLE'
  | 'TRADE_IN_DRAFT_LIMIT'
  | 'TRADE_IN_NOT_EDITABLE'
  | 'TRADE_IN_INPUTS_INVALID'
  | 'TRADE_IN_PHOTOS_MISSING'
  | 'TRADE_IN_PHOTO_LIMIT'
  | 'TRADE_IN_PHOTO_ANGLE'
  | 'TRADE_IN_TARGET_REQUIRED'
  | 'TRADE_IN_TARGET_UNAVAILABLE'
  | 'TRADE_IN_BAD_STATE'
  | 'TRADE_IN_OFFER_STALE'
  | 'TRADE_IN_ORDER_ACTIVE'
  | 'TRADE_IN_NO_ORDER'
  | 'TRADE_IN_INVALID_VALUE'
  | 'TRADE_IN_RULES_INVALID'
  | 'TRADE_IN_COUPON_MISMATCH'
  | 'TRADE_IN_LINKED_ELSEWHERE'
  | 'TRADE_IN_STALE';

export class TradeInError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code: TradeInCode | 'NOT_FOUND',
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'TradeInError';
  }
}

const MESSAGES: Record<TradeInCode, string> = {
  TRADE_IN_NOT_DELIVERED: 'Only a delivered order can be traded in.',
  TRADE_IN_NOT_ELIGIBLE: 'This item cannot be traded in.',
  TRADE_IN_ALREADY_CLAIMED: 'This device is already part of a trade-in.',
  TRADE_IN_RETURN_OPEN: 'This item has a return case, so it cannot be traded in.',
  TRADE_IN_BELOW_MINIMUM: 'This item is below the minimum value for a trade-in.',
  TRADE_IN_GIFT: 'This device came as a gift. Trade-in is for devices bought from LEVONIS.',
  TRADE_IN_SCOPE_UNAVAILABLE: 'That part of this device cannot be traded on its own.',
  TRADE_IN_DRAFT_LIMIT: 'You have too many unfinished trade-in requests. Finish or cancel one first.',
  TRADE_IN_NOT_EDITABLE: 'This request was already sent and can no longer be edited.',
  TRADE_IN_INPUTS_INVALID: 'Some answers about the device are missing or invalid.',
  TRADE_IN_PHOTOS_MISSING: 'Some required photos are missing.',
  TRADE_IN_PHOTO_LIMIT: 'You reached the photo limit for this angle or request.',
  TRADE_IN_PHOTO_ANGLE: 'That photo angle does not apply to this device.',
  TRADE_IN_TARGET_REQUIRED: 'Choose the new device first.',
  TRADE_IN_TARGET_UNAVAILABLE: 'The new device you chose is not available for direct sale right now.',
  TRADE_IN_BAD_STATE: 'This request is not in a state that allows this action.',
  TRADE_IN_OFFER_STALE: 'The value changed since this screen was opened. Refresh and decide again.',
  TRADE_IN_ORDER_ACTIVE: 'An order already used this trade-in credit. Cancel that order first.',
  TRADE_IN_NO_ORDER: 'The customer has not placed the order for the new device yet.',
  TRADE_IN_INVALID_VALUE: 'The value must be a whole number of dinars.',
  TRADE_IN_RULES_INVALID: 'Some rule values are invalid.',
  TRADE_IN_COUPON_MISMATCH: 'This trade-in credit applies only to its own new device, bought directly, by its owner.',
  TRADE_IN_STALE: 'The request changed while you were working on it. Refresh and try again.',
  TRADE_IN_LINKED_ELSEWHERE: 'This device is linked to another account. It must be released from that account before it can be traded in.',
};

const STATUS_OF: Partial<Record<TradeInCode, 400 | 409>> = {
  TRADE_IN_INPUTS_INVALID: 400,
  TRADE_IN_PHOTO_ANGLE: 400,
  TRADE_IN_INVALID_VALUE: 400,
  TRADE_IN_RULES_INVALID: 400,
  TRADE_IN_TARGET_REQUIRED: 400,
  TRADE_IN_COUPON_MISMATCH: 400,
};

export const refuse = (code: TradeInCode, details?: Record<string, unknown>) =>
  new TradeInError(STATUS_OF[code] ?? 409, code, MESSAGES[code], details);
export const notFoundTI = (what = 'Trade-in request not found') => new TradeInError(404, 'NOT_FOUND', what);

// ================================================================= rules

export type StoredRuleSet = TradeInRuleSet & { id: string; note: string; created_at: string; created_by: string | null };
export type RuleBook = Record<TradeInFamily, StoredRuleSet>;

interface RuleSetRow {
  id: string;
  family: TradeInFamily;
  version: number;
  floor_bp: number;
  cap_bp: number;
  rounding_iqd: number;
  min_base_iqd: number;
  ams_reference_iqd: number;
  is_default: number;
  note: string;
  created_by: string | null;
  created_at: string;
}

function assemble(row: RuleSetRow, rules: Array<{ factor: string; enabled: number; weight_bp: number; config_json: string }>): StoredRuleSet {
  const factors = rules.map((r) => ({
    factor: r.factor,
    enabled: r.enabled === 1,
    weight_bp: r.weight_bp,
    config: safeParse<Record<string, unknown>>(r.config_json, {}),
  }));
  const checked = validateRuleSet({ ...row, factors }, row.family);
  const base = {
    id: row.id,
    note: row.note,
    created_at: row.created_at,
    created_by: row.created_by,
    version: row.version,
    is_default: row.is_default === 1,
  };
  if (checked.ok) return { ...checked.value, ...base };
  // A stored version that no longer validates is a bug somewhere upstream —
  // price with the shipped defaults rather than with half a rule set, and say
  // so loudly.
  console.error(JSON.stringify({ event: 'trade_in_rules_invalid', rule_set: row.id, errors: checked.errors.slice(0, 10) }));
  return { ...DEFAULT_RULE_SETS[row.family], ...base, is_default: true };
}

/** The rule set in force for every family: the highest version of each. */
export async function loadRuleBook(db: D1Database): Promise<RuleBook> {
  const { results } = await db
    .prepare(
      `SELECT rs.* FROM trade_in_rule_sets rs
        WHERE rs.version = (SELECT MAX(v.version) FROM trade_in_rule_sets v WHERE v.family = rs.family)`
    )
    .all<RuleSetRow>();
  const sets = results ?? [];
  const ids = sets.map((s) => s.id);
  const { results: rules } = await db
    .prepare('SELECT rule_set_id, factor, enabled, weight_bp, config_json FROM trade_in_rules WHERE rule_set_id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(ids))
    .all<{ rule_set_id: string; factor: string; enabled: number; weight_bp: number; config_json: string }>();
  const book = {} as RuleBook;
  for (const f of TRADE_IN_FAMILIES) {
    const row = sets.find((s) => s.family === f);
    book[f] = row
      ? assemble(row, (rules ?? []).filter((r) => r.rule_set_id === row.id))
      : { ...DEFAULT_RULE_SETS[f], id: `tirs_${f}_v1`, note: '', created_at: '', created_by: null };
  }
  return book;
}

export async function ruleSetHistory(db: D1Database, family: TradeInFamily) {
  const { results } = await db
    .prepare(
      `SELECT rs.id, rs.version, rs.is_default, rs.note, rs.created_at, u.name AS created_by_name
         FROM trade_in_rule_sets rs LEFT JOIN users u ON u.id = rs.created_by
        WHERE rs.family = ? ORDER BY rs.version DESC LIMIT 30`
    )
    .bind(family)
    .all<Record<string, unknown>>();
  return results ?? [];
}

/**
 * A NEW VERSION, never an edit. `UNIQUE (family, version)` is the fence: two
 * admins saving at once both compute N+1, and the second insert fails whole —
 * its factor rows with it, because they are in the same batch.
 */
export async function saveRuleSet(env: Env, family: TradeInFamily, raw: unknown, adminId: string, note: string): Promise<StoredRuleSet> {
  const checked = validateRuleSet(raw, family);
  if (!checked.ok) throw refuse('TRADE_IN_RULES_INVALID', { errors: checked.errors });
  const db = env.DB;
  const cur = await db.prepare('SELECT MAX(version) AS v FROM trade_in_rule_sets WHERE family = ?').bind(family).first<{ v: number | null }>();
  const version = (cur?.v ?? 0) + 1;
  const id = `tirs_${family}_v${version}`;
  const now = new Date().toISOString();
  const r = checked.value;
  const audit = await auditStatements(db, adminId, 'trade_in.rules.save', id, { family, version, note });
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO trade_in_rule_sets (id, family, version, floor_bp, cap_bp, rounding_iqd, min_base_iqd, ams_reference_iqd, is_default, note, created_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11)`
        )
        .bind(id, family, version, r.floor_bp, r.cap_bp, r.rounding_iqd, r.min_base_iqd, r.ams_reference_iqd, note, adminId, now),
      ...r.factors.map((f) =>
        db
          .prepare('INSERT INTO trade_in_rules (rule_set_id, factor, enabled, weight_bp, config_json) VALUES (?1, ?2, ?3, ?4, ?5)')
          .bind(id, f.factor, f.enabled ? 1 : 0, f.weight_bp, JSON.stringify(f.config))
      ),
      ...audit.statements,
    ]);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e instanceof Error ? e.message : String(e))) throw refuse('TRADE_IN_STALE');
    throw e;
  }
  return (await loadRuleBook(db))[family];
}

// ================================================================= classification

const COMBO_RE = /combo|كومبو/i;
const AMS_RE = /\bAMS\b/i;

/**
 * WHICH FAMILY A PRODUCT BELONGS TO — from the catalogue's own product type
 * (templateFamilies.ts, the compare page's rule), never from what a customer
 * says. Printers split into FDM and Resin by their section; a device part
 * named AMS is an AMS; any other device part is an accessory. Filament, resin
 * bottles and every other consumable resolve to null: not tradeable.
 */
export function familyOfProduct(
  row: { template_family?: unknown; category_id?: unknown; sub_category_id?: unknown; name?: unknown; name_ar?: unknown },
  idx: CatalogIndex
): TradeInFamily | null {
  const type = productTypeOf(row, idx);
  if (!type) return null;
  const leaf = String(row.sub_category_id || row.category_id || '');
  const slugs = leaf ? idx.branch(leaf).map((n) => n.slug) : [];
  const names = `${String(row.name ?? '')} ${String(row.name_ar ?? '')}`;
  if (type === 'laser') return 'laser';
  if (type === 'printer') return slugs.some((s) => /resin/i.test(s)) ? 'resin' : 'fdm';
  if (type === 'parts') return AMS_RE.test(names) ? 'ams' : 'accessory';
  return null;
}

interface OptionValueRow {
  id: string;
  product_id: string;
  group_id: string;
  name_en: string;
  name_ar: string;
  variant_key: string | null;
  regular_price_iqd: number | null;
  regular_adjust_iqd: number | null;
  active: number;
  merged_into: string | null;
}

const isComboValue = (v: OptionValueRow) => COMBO_RE.test(String(v.variant_key ?? '')) || COMBO_RE.test(v.name_en) || COMBO_RE.test(v.name_ar ?? '');
const valuePrice = (v: OptionValueRow, productPrice: number) =>
  v.regular_price_iqd !== null && v.regular_price_iqd !== undefined ? v.regular_price_iqd : productPrice + (Number(v.regular_adjust_iqd) || 0);

export interface AmsSplit {
  method: 'option_gap' | 'reference' | 'none';
  /** The AMS share of the Combo in basis points (option_gap only). */
  share_bp: number | null;
  ams_base_iqd: number;
}

/**
 * THE COMBO'S AMS SHARE — see the file header. Pure: every input is passed.
 */
export function amsSplit(input: {
  paidIqd: number;
  combo: OptionValueRow | null;
  siblings: OptionValueRow[];
  productPriceIqd: number;
  referenceIqd: number;
}): AmsSplit {
  const paid = Math.max(0, input.paidIqd);
  const c = input.combo;
  if (c) {
    const key = String(c.variant_key ?? '').replace(/[-_ ]?combo$/i, '');
    const plain = input.siblings.filter((v) => v.id !== c.id && v.group_id === c.group_id && !v.merged_into && !isComboValue(v));
    const byKey = key ? plain.find((v) => String(v.variant_key ?? '') === key) : undefined;
    const byName = plain.find((v) => v.name_en.trim().toLowerCase() === c.name_en.replace(COMBO_RE, '').trim().toLowerCase());
    const base = byKey ?? byName ?? (plain.length === 1 ? plain[0] : undefined);
    if (base) {
      const comboPrice = valuePrice(c, input.productPriceIqd);
      const basePrice = valuePrice(base, input.productPriceIqd);
      if (comboPrice > basePrice && basePrice > 0) {
        const share = Math.floor(((comboPrice - basePrice) * 10_000) / comboPrice);
        return { method: 'option_gap', share_bp: share, ams_base_iqd: Math.floor((paid * share) / 10_000) };
      }
    }
  }
  if (input.referenceIqd > 0) {
    return { method: 'reference', share_bp: null, ams_base_iqd: Math.min(input.referenceIqd, Math.floor(paid / 2)) };
  }
  return { method: 'none', share_bp: null, ams_base_iqd: 0 };
}

// ================================================================= eligibility

export interface ScopeOption {
  scope: TradeInScope;
  available: boolean;
  reason: TradeInCode | null;
  /** The base of each component this scope would assess. */
  components: Array<{ role: ComponentRole; family: TradeInFamily; base_iqd: number }>;
}

export interface EligibleUnit {
  key: string;
  order_item_id: string;
  unit_index: number;
  unit_id: string | null;
  order_id: string;
  product_id: string;
  product_slug: string;
  name: string;
  variant: string;
  image: string;
  family: TradeInFamily;
  is_combo: boolean;
  ams_split: AmsSplit;
  paid_iqd: number;
  ordered_at: string;
  delivered_at: string | null;
  warranty_end_at: string | null;
  usage_days: number;
  usage_months: number;
  warranty_remaining_months: number;
  scopes: ScopeOption[];
  available: boolean;
  reason: TradeInCode | null;
  /** The customer's own open request on this unit, if one exists. */
  open_request_id: string | null;
}

interface LineRow {
  item_id: string;
  order_id: string;
  product_id: string;
  name_snapshot: string;
  image_snapshot: string;
  option_snapshot: string;
  option_id: string | null;
  option_value_ids: string | null;
  qty: number;
  unit_price_iqd: number;
  warranty_snapshot: string | null;
  membership_discount_iqd: number | null;
  coupon_discount_iqd: number | null;
  /** Set when the line is a gift ordered at 0 IQD (0175). */
  gift_entitlement_id: string | null;
  status: string;
  ordered_at: string;
  order_delivered_at: string | null;
  slug: string | null;
  name: string | null;
  name_ar: string | null;
  template_family: string | null;
  category_id: string | null;
  sub_category_id: string | null;
  ops_policy: string | null;
  price_iqd: number | null;
}

const LINE_SQL = `SELECT oi.id AS item_id, oi.order_id, oi.product_id, oi.name_snapshot, oi.image_snapshot, oi.option_snapshot,
         oi.option_id, oi.option_value_ids, oi.qty, oi.unit_price_iqd, oi.warranty_snapshot,
         oi.membership_discount_iqd, oi.coupon_discount_iqd, oi.gift_entitlement_id,
         o.status, o.created_at AS ordered_at, o.delivered_at AS order_delivered_at,
         p.slug, p.name, p.name_ar, p.template_family, p.category_id, p.sub_category_id, p.ops_policy, p.price_iqd
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
   WHERE o.user_id = ?1
     AND COALESCE(o.seller_type, 'levonis') <> 'merchant'
     AND oi.product_id IS NOT NULL
     AND oi.bundle_parent_item_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM order_items k WHERE k.bundle_parent_item_id = oi.id)`;

/** Paid for ONE unit, per the header's definition. */
export function paidPerUnit(line: Pick<LineRow, 'unit_price_iqd' | 'qty' | 'warranty_snapshot' | 'membership_discount_iqd' | 'coupon_discount_iqd'>): number {
  const qty = Math.max(1, Number(line.qty) || 1);
  const unit = Math.max(0, Number(line.unit_price_iqd) || 0);
  const w = safeParse<{ fee_iqd?: unknown } | null>(line.warranty_snapshot, null);
  const fee = typeof w?.fee_iqd === 'number' && Number.isFinite(w.fee_iqd) ? Math.max(0, Math.min(Math.trunc(w.fee_iqd), unit)) : 0;
  const discounts = Math.max(0, (Number(line.membership_discount_iqd) || 0) + (Number(line.coupon_discount_iqd) || 0));
  return Math.max(0, unit - fee - Math.floor(discounts / qty));
}

/** Units per line shown for trade-in: a line of 30 printers is a reseller, not this screen. */
const MAX_UNITS_PER_LINE = 10;

async function buildEligibility(env: Env, userId: string, lines: LineRow[], nowIso: string): Promise<EligibleUnit[]> {
  if (lines.length === 0) return [];
  const db = env.DB;
  const idx = await catalogIndexFor(db);
  const itemIds = JSON.stringify(lines.map((l) => l.item_id));
  const productIds = JSON.stringify([...new Set(lines.map((l) => l.product_id))]);
  const [units, receipts, claims, returns, values, rules, links] = await Promise.all([
    db
      .prepare(
        `SELECT id, order_item_id, unit_index, delivered_at, warranty_end_at, warranty_base_months, replaced_by_unit_id
           FROM order_item_units WHERE order_item_id IN (SELECT value FROM json_each(?1))`
      )
      .bind(itemIds)
      .all<{ id: string; order_item_id: string; unit_index: number; delivered_at: string | null; warranty_end_at: string | null; replaced_by_unit_id: string | null }>(),
    db
      .prepare(
        `SELECT order_item_id, unit_id, warranty_end_at FROM warranty_receipts
          WHERE order_item_id IN (SELECT value FROM json_each(?1)) AND status = 'active'`
      )
      .bind(itemIds)
      .all<{ order_item_id: string; unit_id: string | null; warranty_end_at: string | null }>(),
    db
      .prepare(
        `SELECT c.order_item_id, c.unit_index, c.part, c.request_id, r.user_id, r.status
           FROM trade_in_claims c JOIN trade_in_requests r ON r.id = c.request_id
          WHERE c.order_item_id IN (SELECT value FROM json_each(?1))`
      )
      .bind(itemIds)
      .all<{ order_item_id: string; unit_index: number; part: ComponentRole; request_id: string; user_id: string; status: TradeInStatus }>(),
    db
      .prepare(
        `SELECT DISTINCT order_item_id FROM return_cases
          WHERE order_item_id IN (SELECT value FROM json_each(?1)) AND state <> 'rejected'`
      )
      .bind(itemIds)
      .all<{ order_item_id: string }>(),
    db
      .prepare(
        `SELECT id, product_id, group_id, name_en, name_ar, variant_key, regular_price_iqd, regular_adjust_iqd, active, merged_into
           FROM product_option_values WHERE product_id IN (SELECT value FROM json_each(?1))`
      )
      .bind(productIds)
      .all<OptionValueRow>(),
    loadRuleBook(db),
    // Who holds each device now: its live account link (owner decision 3 —
    // a trade-in takes the device from whoever holds it, so another
    // account's link must be released first).
    db
      .prepare(
        `SELECT r.unit_id, r.user_id FROM device_registrations r JOIN order_item_units u ON u.id = r.unit_id
          WHERE u.order_item_id IN (SELECT value FROM json_each(?1)) AND r.revoked_at IS NULL`
      )
      .bind(itemIds)
      .all<{ unit_id: string; user_id: string }>(),
  ]);
  const holderOf = new Map((links.results ?? []).map((l) => [l.unit_id, l.user_id]));
  const unitById = new Map((units.results ?? []).map((u) => [u.id, u]));
  /** The slot's LIVE unit: its own, or the end of its warranty-replacement chain (deviceCustody `liveUnitOfSlot`). */
  const liveOf = <U extends { replaced_by_unit_id: string | null }>(u: U | null): U | null => {
    let cur = u;
    for (let hop = 0; cur && cur.replaced_by_unit_id && hop < MAX_REPLACEMENT_HOPS; hop++) {
      const next = unitById.get(cur.replaced_by_unit_id) as U | undefined;
      if (!next) break;
      cur = next;
    }
    return cur;
  };
  // S14: a printer with no configured base still carries the 12-month default
  // (the same answer delivery wrote on its unit).
  const printers = await printerProductIds(db, lines.map((l) => l.product_id));
  const returnSet = new Set((returns.results ?? []).map((r) => r.order_item_id));
  const valuesByProduct = new Map<string, OptionValueRow[]>();
  for (const v of values.results ?? []) {
    const list = valuesByProduct.get(v.product_id) ?? [];
    list.push(v);
    valuesByProduct.set(v.product_id, list);
  }

  const out: EligibleUnit[] = [];
  for (const line of lines) {
    const family = familyOfProduct(line, idx);
    if (!family) continue; // not a device: never listed
    const productValues = valuesByProduct.get(line.product_id) ?? [];
    const selected = new Set<string>([
      ...safeParse<unknown[]>(line.option_value_ids, []).filter((x): x is string => typeof x === 'string'),
      ...(line.option_id ? [line.option_id] : []),
    ]);
    const comboValue = productValues.find((v) => selected.has(v.id) && isComboValue(v)) ?? null;
    const isCombo = (family === 'fdm' || family === 'resin') && (comboValue !== null || COMBO_RE.test(`${line.option_snapshot} ${line.name_snapshot}`));
    const paid = paidPerUnit(line);
    const split = isCombo
      ? amsSplit({
          paidIqd: paid,
          combo: comboValue,
          siblings: productValues,
          productPriceIqd: Number(line.price_iqd) || 0,
          referenceIqd: rules.ams.ams_reference_iqd,
        })
      : { method: 'none' as const, share_bp: null, ams_base_iqd: 0 };
    const opsMonths = effectiveBaseMonths(parseOpsPolicy(line.ops_policy).base_months, printers.has(line.product_id));
    const qty = Math.min(Math.max(1, Number(line.qty) || 1), MAX_UNITS_PER_LINE);
    for (let unitIndex = 1; unitIndex <= qty; unitIndex++) {
      const unit = (units.results ?? []).find((u) => u.order_item_id === line.item_id && u.unit_index === unitIndex) ?? null;
      const receipt =
        (receipts.results ?? []).find((r) => r.order_item_id === line.item_id && unit && r.unit_id === unit.id) ??
        (qty === 1 ? (receipts.results ?? []).find((r) => r.order_item_id === line.item_id) : undefined);
      const deliveredAt = unit?.delivered_at || line.order_delivered_at || null;
      // S14 (owner decision 3): the DEVICE record owns the warranty — the
      // unit's end first (a resold device carries its original end there),
      // then the receipt's paper, then the configured base from delivery.
      const warrantyEnd =
        unit?.warranty_end_at ||
        receipt?.warranty_end_at ||
        (deliveredAt && opsMonths ? addMonths(deliveredAt, opsMonths) : null);
      // The device in the customer's hands: a warranty replacement of this
      // slot's unit when there was one. Linked to ANOTHER account (the buyer
      // passed it on), it is not this customer's to trade in until that link
      // is released — the completion would otherwise take it from them.
      const live = liveOf(unit);
      const holder = live ? holderOf.get(live.id) ?? null : null;
      const linkedElsewhere = !!holder && holder !== userId;
      const unitClaims = (claims.results ?? []).filter((c) => c.order_item_id === line.item_id && c.unit_index === unitIndex);
      const claimedParts = new Set(unitClaims.map((c) => c.part));
      const ownOpen = unitClaims.find((c) => c.user_id === userId && !isTerminal(c.status) && c.status !== 'completed');
      const deviceBase = isCombo ? paid - split.ams_base_iqd : paid;
      const scopeList: TradeInScope[] = isCombo ? ['whole', 'printer_only', 'ams_only'] : ['whole'];
      const scopes: ScopeOption[] = scopeList.map((scope) => {
        const roles = rolesForScope(scope, isCombo);
        // An unknown AMS split: the whole Combo is one machine at its full
        // price, and neither half can be traded alone.
        const unknownSplit = isCombo && split.method === 'none';
        const components = roles.map((role) => ({
          role,
          family: role === 'ams' ? ('ams' as const) : family,
          base_iqd: unknownSplit ? (role === 'device' ? paid : 0) : role === 'ams' ? split.ams_base_iqd : deviceBase,
        }));
        let reason: TradeInCode | null = null;
        // A GIFT WAS NOT BOUGHT. «only devices bought HERE» and «the price he
        // paid» (the header): a device that came as a gift (0175) was paid
        // nothing, so it is listed with the reason rather than valued at 0 or
        // turned away as «below the minimum».
        if (line.gift_entitlement_id) reason = 'TRADE_IN_GIFT';
        else if (line.status !== 'delivered') reason = 'TRADE_IN_NOT_DELIVERED';
        else if (returnSet.has(line.item_id)) reason = 'TRADE_IN_RETURN_OPEN';
        else if (unknownSplit && scope !== 'whole') reason = 'TRADE_IN_SCOPE_UNAVAILABLE';
        else if (roles.some((r) => claimedParts.has(r))) reason = 'TRADE_IN_ALREADY_CLAIMED';
        // The AMS alone leaves the printer (and its link) where it is.
        else if (linkedElsewhere && scope !== 'ams_only') reason = 'TRADE_IN_LINKED_ELSEWHERE';
        else if (components.reduce((s, c) => s + c.base_iqd, 0) < rules[components[0].family].min_base_iqd) reason = 'TRADE_IN_BELOW_MINIMUM';
        return { scope, available: reason === null, reason, components };
      });
      const firstOpen = scopes.find((s) => s.available);
      out.push({
        key: `${line.item_id}:${unitIndex}`,
        order_item_id: line.item_id,
        unit_index: unitIndex,
        unit_id: unit?.id ?? null,
        order_id: line.order_id,
        product_id: line.product_id,
        product_slug: line.slug ?? '',
        name: line.name_snapshot,
        variant: line.option_snapshot ?? '',
        image: line.image_snapshot ?? '',
        family,
        is_combo: isCombo,
        ams_split: split,
        paid_iqd: paid,
        ordered_at: line.ordered_at,
        delivered_at: deliveredAt,
        warranty_end_at: warrantyEnd,
        usage_days: daysBetween(deliveredAt, nowIso),
        usage_months: wholeMonthsBetween(deliveredAt, nowIso),
        warranty_remaining_months: warrantyMonthsLeft(warrantyEnd, nowIso),
        scopes,
        available: !!firstOpen,
        reason: firstOpen ? null : scopes[0].reason,
        open_request_id: ownOpen?.request_id ?? null,
      });
    }
  }
  return out;
}

/** «طلباتك السابقة» — every device line of this customer's delivered orders, eligible or with the reason it is not. */
export async function listEligible(env: Env, userId: string, nowIso = new Date().toISOString()): Promise<EligibleUnit[]> {
  const { results } = await env.DB.prepare(`${LINE_SQL} AND o.status = 'delivered' ORDER BY COALESCE(o.delivered_at, o.created_at) DESC LIMIT 200`)
    .bind(userId)
    .all<LineRow>();
  return buildEligibility(env, userId, results ?? [], nowIso);
}

/**
 * ONE UNIT, FOR THE DOOR THAT OPENS A REQUEST. The ownership rule is the
 * query: `o.user_id = ?1`. A line of another customer's order returns no row,
 * which is a 404 — the same answer as an id that does not exist.
 */
export async function resolveUnit(env: Env, userId: string, orderItemId: string, unitIndex: number, nowIso = new Date().toISOString()): Promise<EligibleUnit> {
  const line = await env.DB.prepare(`${LINE_SQL} AND oi.id = ?2`).bind(userId, orderItemId).first<LineRow>();
  if (!line) throw notFoundTI('Order item not found');
  if (line.status !== 'delivered') throw refuse('TRADE_IN_NOT_DELIVERED');
  const units = await buildEligibility(env, userId, [line], nowIso);
  if (units.length === 0) throw refuse('TRADE_IN_NOT_ELIGIBLE');
  const unit = units.find((u) => u.unit_index === unitIndex);
  if (!unit) throw notFoundTI('Order item not found');
  return unit;
}

// ================================================================= requests

export interface RequestRow {
  id: string;
  user_id: string;
  status: TradeInStatus;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  unit_id: string | null;
  source_product_id: string | null;
  family: TradeInFamily;
  scope: TradeInScope;
  is_combo: number;
  source_snapshot_json: string;
  target_product_id: string | null;
  target_option_value_ids: string;
  target_color_id: string | null;
  target_snapshot_json: string;
  target_price_iqd: number | null;
  estimated_iqd: number | null;
  estimate_json: string;
  rule_versions_json: string;
  admin_value_iqd: number | null;
  admin_reason: string;
  offer_no: number;
  final_value_iqd: number | null;
  credit_iqd: number | null;
  difference_iqd: number | null;
  coupon_id: string | null;
  customer_note: string;
  cancel_reason: string;
  cancelled_by: string | null;
  decided_via: string;
  tg_chat_id: number | null;
  tg_message_id: number | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  inspected_at: string | null;
  valued_at: string | null;
  decided_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface ComponentRow {
  id: string;
  request_id: string;
  role: ComponentRole;
  family: TradeInFamily;
  label_ar: string;
  label_en: string;
  base_iqd: number;
  inputs_json: string;
  estimate_json: string;
  value_iqd: number | null;
  sort: number;
}

export interface PhotoRow {
  id: string;
  request_id: string;
  component_role: ComponentRole;
  angle: string;
  file_key: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  created_at: string;
}

export async function loadRequest(db: D1Database, id: string): Promise<RequestRow | null> {
  return (await db.prepare('SELECT * FROM trade_in_requests WHERE id = ?').bind(id).first<RequestRow>()) ?? null;
}

/** The customer's own request, or 404 — never 403 (IDOR). */
export async function ownRequest(db: D1Database, userId: string, id: string): Promise<RequestRow> {
  const r = await db.prepare('SELECT * FROM trade_in_requests WHERE id = ? AND user_id = ?').bind(id, userId).first<RequestRow>();
  if (!r) throw notFoundTI();
  return r;
}

export async function loadComponents(db: D1Database, requestId: string): Promise<ComponentRow[]> {
  const { results } = await db.prepare('SELECT * FROM trade_in_components WHERE request_id = ? ORDER BY sort').bind(requestId).all<ComponentRow>();
  return results ?? [];
}

export async function loadPhotos(db: D1Database, requestId: string): Promise<PhotoRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM trade_in_photos WHERE request_id = ? ORDER BY component_role, angle, created_at')
    .bind(requestId)
    .all<PhotoRow>();
  return results ?? [];
}

async function loadEvents(db: D1Database, requestId: string) {
  const { results } = await db
    .prepare('SELECT id, actor_role, action, from_status, to_status, detail_json, created_at FROM trade_in_events WHERE request_id = ? ORDER BY created_at, rowid LIMIT 100')
    .bind(requestId)
    .all<{ id: string; actor_role: string; action: string; from_status: string | null; to_status: string | null; detail_json: string; created_at: string }>();
  return (results ?? []).map((e) => ({ ...e, detail: safeParse<Record<string, unknown>>(e.detail_json, {}), detail_json: undefined }));
}

function eventStatement(
  db: D1Database,
  requestId: string,
  actor: { id: string | null; role: 'customer' | 'admin' | 'system' },
  action: string,
  from: TradeInStatus | null,
  to: TradeInStatus | null,
  detail: Record<string, unknown>,
  at: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO trade_in_events (id, request_id, actor_id, actor_role, action, from_status, to_status, detail_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(newId('tie'), requestId, actor.id, actor.role, action, from, to, JSON.stringify(detail), at);
}

/**
 * THE FENCE. Written after the conditional UPDATE in the same batch: if that
 * UPDATE did not land (the status had moved, another press won) the token is
 * not there, `status` becomes NULL, the NOT NULL constraint aborts the batch,
 * and nothing after it happens. The 0140 pattern, one table over.
 */
function fence(db: D1Database, id: string, token: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE trade_in_requests SET status = CASE WHEN decision_token = ?2 THEN status ELSE NULL END WHERE id = ?1`)
    .bind(id, token);
}

const isAbort = (e: unknown) => /NOT NULL|constraint|UNIQUE/i.test(e instanceof Error ? e.message : String(e));

/** Unfinished drafts one customer may hold at once. */
export const MAX_OPEN_DRAFTS = 5;

export async function createDraft(
  env: Env,
  userId: string,
  input: { orderItemId: string; unitIndex: number; scope: TradeInScope }
): Promise<RequestRow> {
  const db = env.DB;
  const nowIso = new Date().toISOString();
  const unit = await resolveUnit(env, userId, input.orderItemId, input.unitIndex, nowIso);
  const scope = unit.scopes.find((s) => s.scope === input.scope);
  if (!scope) throw refuse('TRADE_IN_SCOPE_UNAVAILABLE');
  if (!scope.available) {
    if (scope.reason === 'TRADE_IN_ALREADY_CLAIMED' && unit.open_request_id) {
      throw refuse('TRADE_IN_ALREADY_CLAIMED', { request_id: unit.open_request_id });
    }
    throw refuse(scope.reason ?? 'TRADE_IN_NOT_ELIGIBLE');
  }
  const drafts = await db
    .prepare("SELECT COUNT(*) AS n FROM trade_in_requests WHERE user_id = ? AND status = 'draft'")
    .bind(userId)
    .first<{ n: number }>();
  if ((drafts?.n ?? 0) >= MAX_OPEN_DRAFTS) throw refuse('TRADE_IN_DRAFT_LIMIT');

  const id = newId('tin');
  const snapshot = {
    name: unit.name,
    variant: unit.variant,
    image: unit.image,
    product_slug: unit.product_slug,
    order_id: unit.order_id,
    ordered_at: unit.ordered_at,
    delivered_at: unit.delivered_at,
    warranty_end_at: unit.warranty_end_at,
    paid_iqd: unit.paid_iqd,
    ams_split: unit.ams_split,
  };
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO trade_in_requests (id, user_id, status, order_id, order_item_id, unit_index, unit_id, source_product_id,
            family, scope, is_combo, source_snapshot_json, created_at, updated_at)
         VALUES (?1, ?2, 'draft', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`
      )
      .bind(
        id, userId, unit.order_id, unit.order_item_id, unit.unit_index, unit.unit_id, unit.product_id,
        unit.family, input.scope, unit.is_combo ? 1 : 0, JSON.stringify(snapshot), nowIso
      ),
  ];
  scope.components.forEach((c, i) => {
    const label =
      c.role === 'ams'
        ? { ar: `وحدة AMS المرفقة مع ${unit.name}`, en: `AMS included with ${unit.name}` }
        : { ar: unit.name, en: unit.name };
    stmts.push(
      db
        .prepare(
          `INSERT INTO trade_in_components (id, request_id, role, family, label_ar, label_en, base_iqd, inputs_json, sort)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        )
        .bind(newId('tic'), id, c.role, c.family, label.ar, label.en, c.base_iqd, JSON.stringify(blankInputs(c.family)), i),
      // THE CLAIM. The primary key (item, unit, part) is the whole of «لا يمكن
      // استبدال الجهاز مرتين»: a second request for the same part fails here,
      // inside this batch, whatever the eligibility read above saw.
      db
        .prepare('INSERT INTO trade_in_claims (order_item_id, unit_index, part, request_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(unit.order_item_id, unit.unit_index, c.role, id, nowIso)
    );
  });
  stmts.push(eventStatement(db, id, { id: userId, role: 'customer' }, 'create', null, 'draft', { scope: input.scope }, nowIso));
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isAbort(e)) throw refuse('TRADE_IN_ALREADY_CLAIMED');
    throw e;
  }
  return (await loadRequest(db, id))!;
}

// ================================================================= target

export interface TargetSelection {
  product_id: string;
  option_value_ids: string[];
  color_id: string | null;
}

export interface PricedTarget {
  price_iqd: number;
  selection: TargetSelection;
  snapshot: {
    product_id: string;
    slug: string;
    name: string;
    name_ar: string;
    image: string;
    family: TradeInFamily;
    options: Array<{ id: string; label_ar: string; label_en: string }>;
    color: { id: string; label_ar: string; label_en: string; hex: string } | null;
  };
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function parseTargetSelection(raw: unknown): TargetSelection | null {
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!o || typeof o.product_id !== 'string' || !ID_RE.test(o.product_id)) return null;
  const ids = Array.isArray(o.option_value_ids) ? o.option_value_ids : [];
  if (ids.length > 12 || !ids.every((x) => typeof x === 'string' && ID_RE.test(x))) return null;
  const color = o.color_id === null || o.color_id === undefined || o.color_id === '' ? null : o.color_id;
  if (color !== null && (typeof color !== 'string' || !ID_RE.test(color))) return null;
  return { product_id: o.product_id, option_value_ids: [...new Set(ids as string[])], color_id: color as string | null };
}

const coverOf = (doc: ReturnType<typeof parseProductRow>): string => {
  const media = [...(doc.media ?? [])].sort((a, b) => Number(b.primary) - Number(a.primary) || a.order - b.order);
  return media[0]?.url ?? '';
};

/**
 * THE NEW DEVICE'S PRICE, AS THIS CUSTOMER WOULD PAY IT, BOUGHT DIRECTLY.
 *
 * «والذي يريده يكون على سعر البيع المباشر الذي يكون بعد العمولة». The same
 * resolver the product page's quote and the cart run, with the customer's own
 * pricing context (their membership, their PRO context), `fulfillmentType:
 * 'direct_sale'` and no transport — so the figure includes the direct-sale
 * surcharge/commission and never a pre-order journey. A selection that cannot
 * be bought directly right now (out of stock, pre-order only, incomplete) is
 * refused: a trade-in against a device the shop cannot hand over is a promise
 * with nothing behind it.
 */
export async function priceTarget(env: Env, userId: string, sel: TargetSelection): Promise<PricedTarget> {
  const db = env.DB;
  const row = await db.prepare(`SELECT * FROM products WHERE id = ? AND ${(await listing(db)).listed('products')}`).bind(sel.product_id).first<Record<string, unknown>>();
  if (!row) throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: 'not_found' });
  const parsed = parseProductRow(row);
  if (parsed.composition !== '') throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: 'composition' });
  const idx = await catalogIndexFor(db);
  const family = familyOfProduct(row, idx);
  if (!family || family === 'accessory') throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: 'not_a_device' });
  const [relations, ctx, isPrinter] = await Promise.all([
    loadRelationsView(db, sel.product_id, row.inventory_mode),
    pricingCtxForUser(db, userId),
    isPrinterProduct(db, sel.product_id),
  ]);
  const doc = applyRelations(parsed, relations);
  const known = new Set(doc.options.filter((o) => o.active !== false && !o.merged_into).map((o) => o.id));
  if (!sel.option_value_ids.every((id) => known.has(id))) throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: 'option' });
  const optionValueIds = quoteOptionValueIds(sel.option_value_ids, null, relations);
  const color = sel.color_id ? doc.colors.find((c) => c.id === sel.color_id && c.active !== false) ?? null : null;
  if (sel.color_id && !color) throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: 'color' });
  const resolved = resolveUnitPrice({
    product: doc,
    optionId: optionValueIds[0] ?? null,
    // The whole selection names the exact SKU whose stored engine price (0183, FX-7) applies.
    optionValueIds,
    colorId: color?.id ?? null,
    transportMethod: null,
    fulfillmentType: 'direct_sale',
    warrantyPlanId: null,
    tier: ctx.tier,
    tierActive: ctx.tierActive,
    proPolicy: ctx.proPolicy,
    transportDefaults: ctx.transportDefaults,
    memberFallback: benefitFallbackFor(ctx, doc),
    isPrinter,
  });
  if (resolved.errors.length > 0) throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: 'price', errors: resolved.errors });
  const availability = saleAvailability(doc, {
    optionValueIds,
    colorId: color?.id ?? null,
    qty: 1,
    transportDefaults: ctx.transportDefaults,
    inventory: snapshotFrom(relations, {
      stock: doc.stock,
      reserved: Number(row.stock_reserved ?? 0),
      low_stock_threshold: (row.low_stock_threshold as number | null) ?? null,
    }),
    links: relations.links,
    preferredType: 'direct_sale',
    capacity: capacityFrom(relations, optionValueIds),
    transportMethod: null,
  });
  const direct = availability.modes.find((m) => m.type === 'direct_sale');
  if (!availability.selection.complete) throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: 'selection', errors: availability.selection.errors });
  if (!direct || !direct.usable) throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: direct?.reason ?? 'no_direct_sale' });
  const price = Math.trunc(resolved.unit_subtotal_iqd);
  if (!(price > 0)) throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: 'price' });
  return {
    price_iqd: price,
    selection: { product_id: sel.product_id, option_value_ids: optionValueIds, color_id: color?.id ?? null },
    snapshot: {
      product_id: sel.product_id,
      slug: doc.slug,
      name: doc.name_en || doc.name_ar,
      name_ar: doc.name_ar || doc.name_en,
      image: coverOf(doc),
      family,
      options: optionValueIds.map((id) => {
        const o = doc.options.find((x) => x.id === id);
        return { id, label_ar: o?.name_ar || o?.name_en || id, label_en: o?.name_en || o?.name_ar || id };
      }),
      color: color ? { id: color.id, label_ar: color.name_ar || color.name_en, label_en: color.name_en || color.name_ar, hex: color.hex } : null,
    },
  };
}

/**
 * THE NEW DEVICES A CUSTOMER MAY CHOOSE — printers, lasers and AMS units that
 * are live in the catalogue, with their models and colours. The price is NOT
 * here: it depends on the model and the customer, and `priceTarget` answers
 * it for the exact selection.
 */
export async function listTargets(env: Env) {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT * FROM products WHERE ${(await listing(db)).listed('products')} AND COALESCE(composition, '') = ''
        ORDER BY is_featured DESC, display_order, created_at DESC LIMIT 400`
    )
    .all<Record<string, unknown>>();
  const idx = await catalogIndexFor(db);
  const picked = (results ?? [])
    .map((row) => ({ row, family: familyOfProduct(row, idx) }))
    .filter((x): x is { row: Record<string, unknown>; family: TradeInFamily } => !!x.family && x.family !== 'accessory')
    .slice(0, 120);
  const ids = JSON.stringify(picked.map((p) => String(p.row.id)));
  const [groups, values, colors] = await Promise.all([
    db
      .prepare('SELECT id, product_id, name_en, sort FROM product_option_groups WHERE product_id IN (SELECT value FROM json_each(?1)) AND active = 1 ORDER BY sort')
      .bind(ids)
      .all<{ id: string; product_id: string; name_en: string; sort: number }>(),
    db
      .prepare(
        `SELECT id, product_id, group_id, name_en, name_ar, sort FROM product_option_values
          WHERE product_id IN (SELECT value FROM json_each(?1)) AND active = 1 AND merged_into IS NULL ORDER BY sort`
      )
      .bind(ids)
      .all<{ id: string; product_id: string; group_id: string; name_en: string; name_ar: string | null; sort: number }>(),
    db
      .prepare('SELECT id, product_id, name_en, name_ar, hex, sort FROM product_colors WHERE product_id IN (SELECT value FROM json_each(?1)) AND active = 1 ORDER BY sort')
      .bind(ids)
      .all<{ id: string; product_id: string; name_en: string; name_ar: string | null; hex: string; sort: number }>(),
  ]);
  return picked.map(({ row, family }) => {
    const doc = parseProductRow(row);
    const pid = String(row.id);
    const g = (groups.results ?? []).filter((x) => x.product_id === pid);
    return {
      product_id: pid,
      slug: doc.slug,
      name: doc.name_en || doc.name_ar,
      name_ar: doc.name_ar || doc.name_en,
      image: coverOf(doc),
      family,
      from_price_iqd: doc.price_iqd,
      groups: g.map((grp) => ({
        id: grp.id,
        name: grp.name_en,
        values: (values.results ?? [])
          .filter((v) => v.group_id === grp.id)
          .map((v) => ({ id: v.id, label_ar: v.name_ar || v.name_en, label_en: v.name_en })),
      })),
      colors: (colors.results ?? [])
        .filter((c) => c.product_id === pid)
        .map((c) => ({ id: c.id, label_ar: c.name_ar || c.name_en, label_en: c.name_en, hex: c.hex })),
    };
  });
}

// ================================================================= estimate

export interface Estimate {
  components: Array<{ role: ComponentRole; family: TradeInFamily; label_ar: string; label_en: string; valuation: ComponentValuation }>;
  total_iqd: number;
  settlement: TradeInSettlement | null;
  rule_versions: Partial<Record<TradeInFamily, number>>;
  usage_months: number;
  warranty_remaining_months: number;
  computed_at: string;
}

/** Everything the engine needs, from the stored request — pure given its inputs. */
export function estimateFor(
  req: Pick<RequestRow, 'source_snapshot_json' | 'source_product_id' | 'target_price_iqd'>,
  components: ComponentRow[],
  book: RuleBook,
  nowIso: string
): { estimate: Estimate; invalid: Array<{ role: ComponentRole; errors: string[] }> } {
  const snap = safeParse<{ delivered_at?: string | null; warranty_end_at?: string | null }>(req.source_snapshot_json, {});
  const usage = wholeMonthsBetween(snap.delivered_at ?? null, nowIso);
  const left = warrantyMonthsLeft(snap.warranty_end_at ?? null, nowIso);
  const invalid: Array<{ role: ComponentRole; errors: string[] }> = [];
  const versions: Partial<Record<TradeInFamily, number>> = {};
  const out: Estimate['components'] = [];
  for (const c of components) {
    const rules = book[c.family];
    versions[c.family] = rules.version;
    const checked = validateInputs(safeParse(c.inputs_json, {}), rules);
    const inputs: ComponentInputs = checked.ok ? checked.value : blankInputs(c.family);
    if (!checked.ok) invalid.push({ role: c.role, errors: checked.errors });
    out.push({
      role: c.role,
      family: c.family,
      label_ar: c.label_ar,
      label_en: c.label_en,
      valuation: valuateComponent(
        rules,
        { base_iqd: c.base_iqd, usage_months: usage, warranty_remaining_months: left, product_id: req.source_product_id ?? '' },
        inputs
      ),
    });
  }
  const total = out.reduce((s, c) => s + c.valuation.value_iqd, 0);
  return {
    estimate: {
      components: out,
      total_iqd: total,
      settlement: req.target_price_iqd ? tradeInSettlement(req.target_price_iqd, total) : null,
      rule_versions: versions,
      usage_months: usage,
      warranty_remaining_months: left,
      computed_at: nowIso,
    },
    invalid,
  };
}

// ================================================================= customer edits

/**
 * SAVE WHAT THE WIZARD HAS SO FAR — answers per component, the target, a note.
 * Draft only. Every answer is rebuilt by `validateInputs` against the rule set
 * in force; the target is re-priced here, by the server, for this customer.
 */
export async function saveDraft(
  env: Env,
  userId: string,
  id: string,
  body: { components?: unknown; target?: unknown; customer_note?: unknown }
): Promise<RequestRow> {
  const db = env.DB;
  const req = await ownRequest(db, userId, id);
  if (req.status !== 'draft') throw refuse('TRADE_IN_NOT_EDITABLE');
  const comps = await loadComponents(db, id);
  const book = await loadRuleBook(db);
  const now = new Date().toISOString();
  const token = randomToken(12);
  const stmts: D1PreparedStatement[] = [];

  let set = 'updated_at = ?2, decision_token = ?3';
  const args: unknown[] = [id, now, token];
  if (body.customer_note !== undefined) {
    args.push(sanitizeUserText(typeof body.customer_note === 'string' ? body.customer_note : '', { max: 1000, singleLine: false }));
    set += `, customer_note = ?${args.length}`;
  }
  if (body.target !== undefined) {
    const sel = parseTargetSelection(body.target);
    if (!sel) throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: 'selection' });
    const priced = await priceTarget(env, userId, sel);
    args.push(priced.selection.product_id, JSON.stringify(priced.selection.option_value_ids), priced.selection.color_id, JSON.stringify(priced.snapshot), priced.price_iqd);
    const n = args.length;
    set += `, target_product_id = ?${n - 4}, target_option_value_ids = ?${n - 3}, target_color_id = ?${n - 2}, target_snapshot_json = ?${n - 1}, target_price_iqd = ?${n}`;
  }
  stmts.push(db.prepare(`UPDATE trade_in_requests SET ${set} WHERE id = ?1 AND status = 'draft'`).bind(...args));
  stmts.push(fence(db, id, token));

  if (body.components !== undefined) {
    const raw = (body.components && typeof body.components === 'object' ? body.components : {}) as Record<string, unknown>;
    const errors: Record<string, string[]> = {};
    for (const c of comps) {
      if (raw[c.role] === undefined) continue;
      const checked = validateInputs(raw[c.role], book[c.family]);
      if (!checked.ok) {
        errors[c.role] = checked.errors;
        continue;
      }
      stmts.push(db.prepare('UPDATE trade_in_components SET inputs_json = ?1 WHERE id = ?2').bind(JSON.stringify(checked.value), c.id));
    }
    const unknownRoles = Object.keys(raw).filter((k) => !comps.some((c) => c.role === k));
    if (unknownRoles.length) errors._ = unknownRoles.map((r) => `role:${r.slice(0, 20)}`);
    if (Object.keys(errors).length) throw refuse('TRADE_IN_INPUTS_INVALID', { errors });
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isAbort(e)) throw refuse('TRADE_IN_NOT_EDITABLE');
    throw e;
  }
  return (await loadRequest(db, id))!;
}

/** What still stops a draft from being sent, per component — the wizard's checklist and the door's refusal. */
export function submitBlockers(
  req: RequestRow,
  comps: ComponentRow[],
  photos: PhotoRow[],
  book: RuleBook
): { inputs: Record<string, string[]>; photos: Record<string, string[]>; target: boolean } {
  const inputs: Record<string, string[]> = {};
  const missing: Record<string, string[]> = {};
  for (const c of comps) {
    const checked = validateInputs(safeParse(c.inputs_json, {}), book[c.family]);
    if (!checked.ok) inputs[c.role] = checked.errors;
    const angles = photos.filter((p) => p.component_role === c.role).map((p) => p.angle);
    const m = missingPhotoAngles(c.family, angles);
    if (m.length) missing[c.role] = m;
  }
  return { inputs, photos: missing, target: !req.target_product_id };
}

export async function submitRequest(env: Env, userId: string, id: string): Promise<RequestRow> {
  const db = env.DB;
  const req = await ownRequest(db, userId, id);
  if (req.status !== 'draft') throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  const [comps, photos, book] = await Promise.all([loadComponents(db, id), loadPhotos(db, id), loadRuleBook(db)]);
  const blockers = submitBlockers(req, comps, photos, book);
  if (Object.keys(blockers.inputs).length) throw refuse('TRADE_IN_INPUTS_INVALID', { errors: blockers.inputs });
  if (Object.keys(blockers.photos).length) throw refuse('TRADE_IN_PHOTOS_MISSING', { missing: blockers.photos });
  if (blockers.target) throw refuse('TRADE_IN_TARGET_REQUIRED');
  // The target's price NOW, not when it was picked — the estimate the admin
  // reviews must be against today's figure.
  const priced = await priceTarget(env, userId, {
    product_id: req.target_product_id!,
    option_value_ids: safeParse<string[]>(req.target_option_value_ids, []),
    color_id: req.target_color_id,
  });
  const now = new Date().toISOString();
  const { estimate } = estimateFor({ ...req, target_price_iqd: priced.price_iqd }, comps, book, now);
  const token = randomToken(12);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE trade_in_requests
            SET status = 'submitted', submitted_at = ?2, updated_at = ?2, decision_token = ?3,
                target_price_iqd = ?4, target_snapshot_json = ?5, estimated_iqd = ?6, estimate_json = ?7, rule_versions_json = ?8
          WHERE id = ?1 AND status = 'draft'`
      )
      .bind(id, now, token, priced.price_iqd, JSON.stringify(priced.snapshot), estimate.total_iqd, JSON.stringify(estimate), JSON.stringify(estimate.rule_versions)),
    fence(db, id, token),
    ...estimate.components.map((c) =>
      db
        .prepare('UPDATE trade_in_components SET estimate_json = ?1, value_iqd = ?2 WHERE request_id = ?3 AND role = ?4')
        .bind(JSON.stringify(c.valuation), c.valuation.value_iqd, id, c.role)
    ),
    eventStatement(db, id, { id: userId, role: 'customer' }, 'submit', 'draft', 'submitted', { estimated_iqd: estimate.total_iqd, target_price_iqd: priced.price_iqd }, now),
    notifyStatement(db, {
      userId,
      kind: 'trade_in',
      title_ar: 'استلمنا طلب الاستبدال',
      title_en: 'We received your trade-in request',
      body_ar: `التقدير الأولي ${iqdText(estimate.total_iqd, 'ar')} — القيمة النهائية بعد الفحص.`,
      body_en: `Preliminary estimate ${iqdText(estimate.total_iqd, 'en')} — the final value follows the inspection.`,
      meta: {
        title_ckb: 'داواکاریی گۆڕینەوەکەت وەرگیرا',
        body_ckb: `خەمڵاندنی سەرەتایی ${iqdText(estimate.total_iqd, 'ckb')} — بەهای کۆتایی دوای پشکنین دیاری دەکرێت.`,
      },
      link: requestPath(id),
      entity_type: 'trade_in',
      entity_id: id,
      eventKey: `trade_in:${id}:submitted`,
    }).stmt,
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isAbort(e)) throw refuse('TRADE_IN_STALE');
    throw e;
  }
  return (await loadRequest(db, id))!;
}

// ================================================================= transitions

async function releaseStatements(db: D1Database, req: RequestRow): Promise<D1PreparedStatement[]> {
  const out = [db.prepare('DELETE FROM trade_in_claims WHERE request_id = ?').bind(req.id)];
  // The credit coupon, if one was minted, dies with the request.
  out.push(db.prepare('UPDATE coupons SET active = 0 WHERE trade_in_id = ? AND active = 1').bind(req.id));
  return out;
}

/** The order that redeemed this request's credit, newest first — cancelled ones included. */
export async function creditOrders(db: D1Database, requestId: string) {
  const { results } = await db
    .prepare(
      `SELECT r.order_id, r.coupon_id, r.amount_iqd, o.status, o.created_at
         FROM coupons c
         JOIN coupon_redemptions r ON r.coupon_id = c.id
         JOIN orders o ON o.id = r.order_id
        WHERE c.trade_in_id = ?1
        ORDER BY r.created_at DESC`
    )
    .bind(requestId)
    .all<{ order_id: string; coupon_id: string; amount_iqd: number; status: string; created_at: string }>();
  return results ?? [];
}

export async function cancelRequest(
  env: Env,
  req: RequestRow,
  actor: { id: string; role: 'customer' | 'admin' },
  reason: string
): Promise<RequestRow> {
  const db = env.DB;
  if (isTerminal(req.status) || !canTransition(req.status, 'cancelled')) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  const live = (await creditOrders(db, req.id)).find((o) => o.status !== 'cancelled');
  if (live) throw refuse('TRADE_IN_ORDER_ACTIVE', { order_id: live.order_id });
  const now = new Date().toISOString();
  const token = randomToken(12);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE trade_in_requests
            SET status = 'cancelled', cancelled_at = ?2, updated_at = ?2, cancel_reason = ?3, cancelled_by = ?4, decision_token = ?5
          WHERE id = ?1 AND status = ?6`
      )
      .bind(req.id, now, reason, actor.id, token, req.status),
    fence(db, req.id, token),
    ...(await releaseStatements(db, req)),
    eventStatement(db, req.id, actor, 'cancel', req.status, 'cancelled', { reason }, now),
  ];
  if (actor.role === 'admin') {
    stmts.push(
      notifyStatement(db, {
        userId: req.user_id,
        kind: 'trade_in',
        title_ar: 'أُلغي طلب الاستبدال',
        title_en: 'Your trade-in request was cancelled',
        body_ar: reason,
        body_en: reason,
        meta: { title_ckb: 'داواکاریی گۆڕینەوەکەت هەڵوەشێندرایەوە', body_ckb: reason },
        link: requestPath(req.id),
        entity_type: 'trade_in',
        entity_id: req.id,
        eventKey: `trade_in:${req.id}:cancelled`,
      }).stmt,
      ...(await auditStatements(db, actor.id, 'trade_in.cancel', req.id, { reason })).statements
    );
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isAbort(e)) throw refuse('TRADE_IN_STALE');
    throw e;
  }
  return (await loadRequest(db, req.id))!;
}

export async function markInspected(env: Env, req: RequestRow, adminId: string): Promise<RequestRow> {
  const db = env.DB;
  if (req.status === 'under_review') return req;
  if (!canTransition(req.status, 'under_review')) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  const now = new Date().toISOString();
  const token = randomToken(12);
  try {
    await db.batch([
      db
        .prepare(`UPDATE trade_in_requests SET status = 'under_review', inspected_at = ?2, updated_at = ?2, decision_token = ?3 WHERE id = ?1 AND status = 'submitted'`)
        .bind(req.id, now, token),
      fence(db, req.id, token),
      eventStatement(db, req.id, { id: adminId, role: 'admin' }, 'inspect', 'submitted', 'under_review', {}, now),
      notifyStatement(db, {
        userId: req.user_id,
        kind: 'trade_in',
        title_ar: 'بدأ فحص جهازك',
        title_en: 'We are inspecting your device',
        meta: { title_ckb: 'پشکنینی ئامێرەکەت دەستی پێکرد' },
        link: requestPath(req.id),
        entity_type: 'trade_in',
        entity_id: req.id,
        eventKey: `trade_in:${req.id}:inspect`,
      }).stmt,
    ]);
  } catch (e) {
    if (isAbort(e)) throw refuse('TRADE_IN_STALE');
    throw e;
  }
  return (await loadRequest(db, req.id))!;
}

/** A trade-in coupon code: `TI` + ten characters nobody reads aloud wrongly. */
function couponCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `TI${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}

/**
 * THE CREDIT, MINTED. Personal (`assigned_user_id`, enforced by
 * `validateCoupon`), single use (`max_global = max_per_user = 1`, enforced by
 * the redemption trigger), targeted at the new product and model, direct sale
 * only, not stackable. Its value is the credit — min(value, target price) —
 * so even a coupon that escaped the checkout's trade-in guard could not take
 * more than the device is worth.
 */
function couponStatement(db: D1Database, req: RequestRow, credit: number, couponId: string, code: string, now: string): D1PreparedStatement {
  const optionIds = safeParse<string[]>(req.target_option_value_ids, []);
  return db
    .prepare(
      `INSERT INTO coupons (id, code, tier_required, kind, value, min_total_iqd, max_global, max_per_user, active, created_at,
          assigned_user_id, scope, product_id, option_value_id, color_id, fulfillment_types, applies_to, cap_scope, max_quantity, stacks, trade_in_id)
       VALUES (?1, ?2, NULL, 'fixed_iqd', ?3, 0, 1, 1, 1, ?4, ?5, 'product', ?6, ?7, ?8, '["direct_sale"]', 'merchandise', 'per_order', 1, 0, ?9)`
    )
    .bind(couponId, code, credit, now, req.user_id, req.target_product_id, optionIds[0] ?? null, req.target_color_id, req.id);
}

/**
 * FIX THE VALUE AND OPEN THE PAYMENT STAGE — the shared tail of «اعتماد
 * التقدير» (admin) and «أوافق» (customer). The target is re-priced for the
 * customer right now; the credit, the difference and the coupon are written
 * in the same batch as the status, behind the fence.
 */
async function fixValue(
  env: Env,
  req: RequestRow,
  value: number,
  step: { via: 'admin' | 'web' | 'telegram'; actor: { id: string; role: 'customer' | 'admin' }; passThrough: 'approved_as_estimated' | 'customer_accepted' }
): Promise<RequestRow> {
  const db = env.DB;
  const priced = await priceTarget(env, req.user_id, {
    product_id: req.target_product_id ?? '',
    option_value_ids: safeParse<string[]>(req.target_option_value_ids, []),
    color_id: req.target_color_id,
  });
  const s = tradeInSettlement(priced.price_iqd, value);
  const now = new Date().toISOString();
  const token = randomToken(12);
  const couponId = s.credit_iqd > 0 ? newId('cpn') : null;
  const code = couponId ? couponCode() : null;
  const from = req.status;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE trade_in_requests
            SET status = 'awaiting_payment', final_value_iqd = ?2, credit_iqd = ?3, difference_iqd = ?4,
                target_price_iqd = ?5, target_snapshot_json = ?6, coupon_id = ?7, decided_at = ?8, updated_at = ?8,
                decided_via = ?9, decision_token = ?10
          WHERE id = ?1 AND status = ?11 AND offer_no = ?12`
      )
      .bind(req.id, s.trade_in_value_iqd, s.credit_iqd, s.difference_iqd, s.target_price_iqd, JSON.stringify(priced.snapshot), couponId, now, step.via, token, from, req.offer_no),
    fence(db, req.id, token),
    eventStatement(db, req.id, step.actor, step.passThrough === 'approved_as_estimated' ? 'approve' : 'accept', from, step.passThrough, { value_iqd: value, via: step.via }, now),
    eventStatement(db, req.id, { id: null, role: 'system' }, 'awaiting_payment', step.passThrough, 'awaiting_payment', { ...s }, now),
    ...(couponId && code ? [couponStatement(db, req, s.credit_iqd, couponId, code, now)] : []),
    notifyStatement(db, {
      userId: req.user_id,
      kind: 'trade_in',
      title_ar: 'ثُبّتت قيمة الاستبدال — أكمل الدفع',
      title_en: 'Your trade-in value is fixed — complete the payment',
      body_ar: `قيمة جهازك ${iqdText(s.trade_in_value_iqd, 'ar')}. المطلوب للجهاز الجديد ${iqdText(s.difference_iqd, 'ar')} + التوصيل.`,
      body_en: `Your device is worth ${iqdText(s.trade_in_value_iqd, 'en')}. You pay ${iqdText(s.difference_iqd, 'en')} for the new device, plus delivery.`,
      meta: {
        title_ckb: 'بەهای گۆڕینەوە جێگیر کرا — پارەدان تەواو بکە',
        body_ckb: `بەهای ئامێرەکەت ${iqdText(s.trade_in_value_iqd, 'ckb')}. بۆ ئامێرە نوێیەکە ${iqdText(s.difference_iqd, 'ckb')} دەدەیت، لەگەڵ کرێی گەیاندن.`,
      },
      link: requestPath(req.id),
      entity_type: 'trade_in',
      entity_id: req.id,
      eventKey: `trade_in:${req.id}:fixed`,
    }).stmt,
  ];
  if (step.actor.role === 'admin') {
    stmts.push(...(await auditStatements(db, step.actor.id, 'trade_in.approve', req.id, { value_iqd: value, ...s })).statements);
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isAbort(e)) {
      const now2 = await loadRequest(db, req.id);
      if (now2 && now2.offer_no !== req.offer_no) throw refuse('TRADE_IN_OFFER_STALE');
      throw refuse('TRADE_IN_STALE');
    }
    throw e;
  }
  return (await loadRequest(db, req.id))!;
}

export async function approveEstimate(env: Env, req: RequestRow, adminId: string): Promise<RequestRow> {
  if (!canTransition(req.status, 'approved_as_estimated')) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  if (req.estimated_iqd === null) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  return fixValue(env, req, req.estimated_iqd, { via: 'admin', actor: { id: adminId, role: 'admin' }, passThrough: 'approved_as_estimated' });
}

export const TRADE_IN_VALUE_MAX_IQD = 1_000_000_000;

/**
 * «تغييره يدوياً مع سبب اختياري» — a new value the customer must accept or
 * decline. `offer_no` moves with it, so a decision always names the value it
 * answers. The in-app row rides in the batch; email, WhatsApp and the
 * Telegram buttons follow (`notifyCustomerOfValue`).
 */
export async function changeValue(env: Env, req: RequestRow, adminId: string, value: number, reason: string): Promise<RequestRow> {
  const db = env.DB;
  if (!Number.isSafeInteger(value) || value < 0 || value > TRADE_IN_VALUE_MAX_IQD) throw refuse('TRADE_IN_INVALID_VALUE');
  if (!canTransition(req.status, 'value_changed')) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  const now = new Date().toISOString();
  const token = randomToken(12);
  const offer = req.offer_no + 1;
  const est = req.estimated_iqd ?? 0;
  const target = req.target_price_iqd ?? 0;
  const s = tradeInSettlement(target, value);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE trade_in_requests
              SET status = 'value_changed', admin_value_iqd = ?2, admin_reason = ?3, offer_no = ?4, valued_at = ?5, updated_at = ?5,
                  decision_token = ?6, tg_chat_id = NULL, tg_message_id = NULL
            WHERE id = ?1 AND status = ?7 AND offer_no = ?8`
        )
        .bind(req.id, value, reason, offer, now, token, req.status, req.offer_no),
      fence(db, req.id, token),
      eventStatement(db, req.id, { id: adminId, role: 'admin' }, 'change_value', req.status, 'value_changed', { value_iqd: value, estimated_iqd: est, reason, offer_no: offer }, now),
      notifyStatement(db, {
        userId: req.user_id,
        kind: 'trade_in',
        title_ar: 'قيمة جديدة لجهازك — مطلوب موافقتك',
        title_en: 'A new value for your device — your decision is needed',
        body_ar: `${iqdText(est, 'ar')} ← ${iqdText(value, 'ar')}${reason ? ` — ${reason}` : ''}. الفرق للجهاز الجديد ${iqdText(s.difference_iqd, 'ar')}.`,
        body_en: `${iqdText(est, 'en')} → ${iqdText(value, 'en')}${reason ? ` — ${reason}` : ''}. You would pay ${iqdText(s.difference_iqd, 'en')} for the new device.`,
        link: requestPath(req.id),
        entity_type: 'trade_in',
        entity_id: req.id,
        meta: {
          offer_no: offer,
          title_ckb: 'بەهایەکی نوێ بۆ ئامێرەکەت — پێویستە بڕیار بدەیت',
          body_ckb: `${iqdText(est, 'ckb')} ← ${iqdText(value, 'ckb')}${reason ? ` — ${reason}` : ''}. جیاوازی بۆ ئامێرە نوێیەکە ${iqdText(s.difference_iqd, 'ckb')}.`,
        },
        eventKey: `trade_in:${req.id}:offer:${offer}`,
      }).stmt,
      ...(await auditStatements(db, adminId, 'trade_in.change_value', req.id, { value_iqd: value, estimated_iqd: est, reason, offer_no: offer })).statements,
    ]);
  } catch (e) {
    if (isAbort(e)) throw refuse('TRADE_IN_STALE');
    throw e;
  }
  return (await loadRequest(db, req.id))!;
}

export type Decision = 'accept' | 'reject';

/**
 * THE CUSTOMER'S ANSWER to a changed value — the site's buttons and the
 * Telegram inline buttons both land here. The offer number is part of the
 * question: an answer to offer 1 after the admin sent offer 2 is refused
 * (TRADE_IN_OFFER_STALE), and a second press of the same answer is a replay.
 */
export async function decideValue(
  env: Env,
  req: RequestRow,
  offerNo: number,
  decision: Decision,
  via: 'web' | 'telegram'
): Promise<{ request: RequestRow; replayed: boolean }> {
  const db = env.DB;
  if (offerNo !== req.offer_no) throw refuse('TRADE_IN_OFFER_STALE', { offer_no: req.offer_no });
  if (req.status !== 'value_changed') {
    // The same answer, pressed again (a double tap, the site and Telegram).
    const same =
      (decision === 'accept' && (req.status === 'awaiting_payment' || req.status === 'completed') && req.decided_via !== 'admin') ||
      (decision === 'reject' && req.status === 'customer_rejected');
    if (same) return { request: req, replayed: true };
    throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  }
  const actor = { id: req.user_id, role: 'customer' as const };
  if (decision === 'accept') {
    const out = await fixValue(env, req, req.admin_value_iqd ?? 0, { via, actor, passThrough: 'customer_accepted' });
    return { request: out, replayed: false };
  }
  const now = new Date().toISOString();
  const token = randomToken(12);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE trade_in_requests SET status = 'customer_rejected', decided_at = ?2, updated_at = ?2, decided_via = ?3, decision_token = ?4
            WHERE id = ?1 AND status = 'value_changed' AND offer_no = ?5`
        )
        .bind(req.id, now, via, token, offerNo),
      fence(db, req.id, token),
      ...(await releaseStatements(db, req)),
      eventStatement(db, req.id, actor, 'reject', 'value_changed', 'customer_rejected', { value_iqd: req.admin_value_iqd, via }, now),
    ]);
  } catch (e) {
    if (isAbort(e)) {
      const again = await loadRequest(db, req.id);
      if (again?.status === 'customer_rejected') return { request: again, replayed: true };
      if (again && again.offer_no !== offerNo) throw refuse('TRADE_IN_OFFER_STALE');
      throw refuse('TRADE_IN_STALE');
    }
    throw e;
  }
  return { request: (await loadRequest(db, req.id))!, replayed: false };
}

/**
 * «إتمام الدفع» — the coupon the checkout will redeem. Mints a replacement when
 * the order that used the previous one was cancelled; refuses when a live
 * order already carries the credit (the customer is sent to that order).
 */
export async function checkoutCredit(env: Env, req: RequestRow): Promise<{ code: string | null; order_id: string | null }> {
  const db = env.DB;
  if (req.status !== 'awaiting_payment') throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  const orders = await creditOrders(db, req.id);
  const live = orders.find((o) => o.status !== 'cancelled');
  if (live) return { code: null, order_id: live.order_id };
  if (!req.credit_iqd || !req.coupon_id) return { code: null, order_id: null };
  const current = await db
    .prepare('SELECT id, code, active FROM coupons WHERE id = ? AND trade_in_id = ?')
    .bind(req.coupon_id, req.id)
    .first<{ id: string; code: string; active: number }>();
  const used = orders.some((o) => o.coupon_id === req.coupon_id);
  if (current && current.active === 1 && !used) return { code: current.code, order_id: null };
  if (!used) throw refuse('TRADE_IN_COUPON_MISMATCH');
  // The order that spent the credit was cancelled: a fresh coupon, the old one
  // retired, both behind the fence on `coupon_id` still naming the old one.
  const now = new Date().toISOString();
  const token = randomToken(12);
  const couponId = newId('cpn');
  const code = couponCode();
  try {
    await db.batch([
      db
        .prepare(`UPDATE trade_in_requests SET coupon_id = ?2, updated_at = ?3, decision_token = ?4 WHERE id = ?1 AND status = 'awaiting_payment' AND coupon_id = ?5`)
        .bind(req.id, couponId, now, token, req.coupon_id),
      fence(db, req.id, token),
      db.prepare('UPDATE coupons SET active = 0 WHERE id = ?').bind(req.coupon_id),
      couponStatement(db, req, req.credit_iqd, couponId, code, now),
      eventStatement(db, req.id, { id: null, role: 'system' }, 'credit_reissued', 'awaiting_payment', 'awaiting_payment', { previous_coupon: req.coupon_id }, now),
    ]);
  } catch (e) {
    if (isAbort(e)) throw refuse('TRADE_IN_STALE');
    throw e;
  }
  return { code, order_id: null };
}

interface CustodyPlan {
  unitId: string | null;
  statements: D1PreparedStatement[];
}

/** The live unit of the request's slot and who else holds it, or null for an AMS-only trade-in. */
async function custodyTarget(db: D1Database, req: RequestRow) {
  if (req.scope === 'ams_only') return null;
  const unit = await liveUnitOfSlot<{ id: string; replaced_by_unit_id: string | null; warranty_start_at: string | null; warranty_end_at: string | null }>(
    db,
    req.order_item_id,
    req.unit_index,
    'u.id, u.warranty_start_at, u.warranty_end_at'
  );
  if (!unit) return null;
  const [serial, other] = await Promise.all([
    db.prepare('SELECT serial_norm FROM device_serials WHERE unit_id = ?').bind(unit.id).first<{ serial_norm: string }>(),
    db
      .prepare('SELECT user_id FROM device_registrations WHERE unit_id = ? AND revoked_at IS NULL AND user_id <> ?')
      .bind(unit.id, req.user_id)
      .first<{ user_id: string }>(),
  ]);
  return { unit, serialNorm: serial?.serial_norm ?? null, linkedElsewhere: !!other };
}

/**
 * THE DEVICE LEAVES THE TRADER, ITS WARRANTY DOES NOT (owner decision 3,
 * 2026-10-09; DECISIONS row 193). For a `whole` or `printer_only` trade-in the
 * completion batch, behind the request's own fence, acts on the slot's LIVE
 * unit — its own, or the warranty replacement the customer actually holds
 * (`liveUnitOfSlot`):
 *   - refuses (a second fence) while that device is linked to an account
 *     other than the trader's — a buyer who passed the device on cannot take
 *     it from its holder (TRADE_IN_LINKED_ELSEWHERE);
 *   - revokes the unit's live account link (the trader no longer holds it);
 *   - releases its activated serial binding as `traded_in`
 *     (`trade_in:<request id>`), so the serial is the shop's to sell again;
 *   - records `serial.traded_in` with the unit's dates and its own serial.
 * It NEVER touches `warranty_closed_at`, the warranty dates or the receipt:
 * the warranty stays with the serial and runs from the original delivery.
 * The traded-in state itself is derived from this request's `completed`
 * status (worker/lib/deviceCustody.ts `tradedInSql`, which follows the same
 * replacement chain) — nothing else marks the unit.
 * An `ams_only` trade-in leaves the device with the customer: nothing moves.
 */
async function custodyStatements(env: Env, req: RequestRow, adminId: string, now: string): Promise<CustodyPlan> {
  const db = env.DB;
  const target = await custodyTarget(db, req);
  if (!target) return { unitId: null, statements: [] };
  if (target.linkedElsewhere) throw refuse('TRADE_IN_LINKED_ELSEWHERE');
  const { unit } = target;
  const stmts: D1PreparedStatement[] = [
    // The holder is still the trader (or nobody) INSIDE the write: a link
    // another account made since the read aborts the whole completion.
    db
      .prepare(
        `UPDATE trade_in_requests SET status = CASE WHEN NOT EXISTS (
            SELECT 1 FROM device_registrations WHERE unit_id = ?2 AND revoked_at IS NULL AND user_id <> ?3) THEN status ELSE NULL END
          WHERE id = ?1`
      )
      .bind(req.id, unit.id, req.user_id),
    db.prepare('UPDATE device_registrations SET revoked_at = ? WHERE unit_id = ? AND revoked_at IS NULL').bind(now, unit.id),
  ];
  if (await serialAssignmentsInstalled(db)) {
    stmts.push(
      db
        .prepare(
          `UPDATE serial_assignments SET released_at = ?1, released_by = ?2, release_reason = 'traded_in', release_note = ?3
            WHERE unit_id = ?4 AND released_at IS NULL AND activated_at IS NOT NULL`
        )
        .bind(now, adminId, `trade_in:${req.id}`, unit.id)
    );
  }
  stmts.push(
    ...(
      await auditStatements(db, adminId, 'serial.traded_in', target.serialNorm || unit.id, {
        request_id: req.id,
        unit_id: unit.id,
        scope: req.scope,
        start_at: unit.warranty_start_at,
        end_at: unit.warranty_end_at,
        traded_in_at: now,
      })
    ).statements
  );
  return { unitId: unit.id, statements: stmts };
}

export async function completeRequest(env: Env, req: RequestRow, adminId: string): Promise<RequestRow> {
  const db = env.DB;
  if (!canTransition(req.status, 'completed')) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  const live = (await creditOrders(db, req.id)).find((o) => o.status !== 'cancelled');
  // A credit of zero has nothing to redeem; anything else must have been
  // spent on a live order before the exchange can be called done.
  if ((req.credit_iqd ?? 0) > 0 && !live) throw refuse('TRADE_IN_NO_ORDER');
  const now = new Date().toISOString();
  const token = randomToken(12);
  const custody = await custodyStatements(env, req, adminId, now);
  try {
    await db.batch([
      db
        .prepare(`UPDATE trade_in_requests SET status = 'completed', completed_at = ?2, updated_at = ?2, decision_token = ?3 WHERE id = ?1 AND status = 'awaiting_payment'`)
        .bind(req.id, now, token),
      fence(db, req.id, token),
      eventStatement(db, req.id, { id: adminId, role: 'admin' }, 'complete', 'awaiting_payment', 'completed', { order_id: live?.order_id ?? null }, now),
      notifyStatement(db, {
        userId: req.user_id,
        kind: 'trade_in',
        title_ar: 'اكتمل الاستبدال',
        title_en: 'Your trade-in is complete',
        meta: { title_ckb: 'گۆڕینەوەکە تەواو بوو' },
        link: requestPath(req.id),
        entity_type: 'trade_in',
        entity_id: req.id,
        eventKey: `trade_in:${req.id}:completed`,
      }).stmt,
      ...(await auditStatements(db, adminId, 'trade_in.complete', req.id, { order_id: live?.order_id ?? null })).statements,
      // After the fence: a completion that lost its race moves no device.
      ...custody.statements,
    ]);
  } catch (e) {
    if (isAbort(e)) {
      // The honest reason: another account linked the device since the read.
      if (custody.unitId && (await custodyTarget(db, req))?.linkedElsewhere) throw refuse('TRADE_IN_LINKED_ELSEWHERE');
      throw refuse('TRADE_IN_STALE');
    }
    throw e;
  }
  return (await loadRequest(db, req.id))!;
}

// ================================================================= checkout guard

/**
 * THE CHECKOUT'S TRADE-IN RULE — called from computeCheckout's coupon block.
 *
 * null      the coupon is not a trade-in credit; nothing changes.
 * a number  the most this coupon may take off: ONE unit of the target line.
 * throws    the coupon IS a trade-in credit and this cart cannot use it —
 *           another customer, a request no longer awaiting payment, or no
 *           direct-sale line of the target product and model in the cart.
 */
export async function tradeInCouponCap(
  db: D1Database,
  userId: string,
  couponId: string,
  lines: ReadonlyArray<{ product_id: string; option_value_ids?: readonly string[]; color_id?: string | null; unit: number; pricing_basis?: string; gift?: unknown }>
): Promise<number | null> {
  const c = await db
    .prepare(
      `SELECT c.trade_in_id, c.assigned_user_id, c.product_id, c.option_value_id, c.color_id, r.status, r.user_id, r.coupon_id
         FROM coupons c LEFT JOIN trade_in_requests r ON r.id = c.trade_in_id
        WHERE c.id = ?`
    )
    .bind(couponId)
    .first<{
      trade_in_id: string | null;
      assigned_user_id: string | null;
      product_id: string | null;
      option_value_id: string | null;
      color_id: string | null;
      status: string | null;
      user_id: string | null;
      coupon_id: string | null;
    }>();
  if (!c || !c.trade_in_id) return null;
  if (c.user_id !== userId || c.assigned_user_id !== userId || c.status !== 'awaiting_payment' || c.coupon_id !== couponId) {
    throw refuse('TRADE_IN_COUPON_MISMATCH');
  }
  const line = lines.find(
    (l) =>
      // A gift line (0175, S8) is never the bought target: its 0 IQD would cap
      // the credit at nothing, and a product given free earns no trade-in.
      !l.gift &&
      l.product_id === c.product_id &&
      (!c.option_value_id || (l.option_value_ids ?? []).includes(c.option_value_id)) &&
      (!c.color_id || l.color_id === c.color_id) &&
      (l.pricing_basis === undefined || l.pricing_basis === 'direct')
  );
  if (!line) throw refuse('TRADE_IN_COUPON_MISMATCH');
  return Math.max(0, Math.trunc(line.unit));
}

// ================================================================= views

export const requestPath = (id: string) => `/trade-in?request=${encodeURIComponent(id)}`;

export function iqdText(n: number, lang: 'ar' | 'en' | EmailLang): string {
  const v = Math.trunc(n).toLocaleString('en-US');
  return lang === 'en' ? `${v} IQD` : `${v} د.ع`;
}

function photoView(p: PhotoRow) {
  return { id: p.id, component: p.component_role, angle: p.angle, url: `/files/${p.file_key}`, width: p.width, height: p.height, created_at: p.created_at };
}

/** The request as its owner sees it; the admin view adds the customer and the audit detail. */
export async function requestView(env: Env, req: RequestRow, audience: 'customer' | 'admin') {
  const db = env.DB;
  const [comps, photos, events, book, orders] = await Promise.all([
    loadComponents(db, req.id),
    loadPhotos(db, req.id),
    loadEvents(db, req.id),
    loadRuleBook(db),
    creditOrders(db, req.id),
  ]);
  const now = new Date().toISOString();
  const live = estimateFor(req, comps, book, now);
  const stored = safeParse<Estimate | null>(req.estimate_json, null);
  const blockers = req.status === 'draft' ? submitBlockers(req, comps, photos, book) : null;
  const creditOrder = orders.find((o) => o.status !== 'cancelled') ?? null;
  const offer =
    req.admin_value_iqd !== null
      ? {
          offer_no: req.offer_no,
          value_iqd: req.admin_value_iqd,
          reason: req.admin_reason,
          settlement: tradeInSettlement(req.target_price_iqd ?? 0, req.admin_value_iqd),
          valued_at: req.valued_at,
        }
      : null;
  const families = [...new Set(comps.map((c) => c.family))];
  return {
    id: req.id,
    status: req.status,
    status_label: STATUS_LABELS[req.status],
    scope: req.scope,
    family: req.family,
    is_combo: req.is_combo === 1,
    order_id: req.order_id,
    order_item_id: req.order_item_id,
    unit_index: req.unit_index,
    source_product_id: req.source_product_id,
    source: safeParse<Record<string, unknown>>(req.source_snapshot_json, {}),
    target:
      req.target_product_id
        ? {
            ...safeParse<Record<string, unknown>>(req.target_snapshot_json, {}),
            option_value_ids: safeParse<string[]>(req.target_option_value_ids, []),
            color_id: req.target_color_id,
            price_iqd: req.target_price_iqd,
          }
        : null,
    components: comps.map((c) => ({
      role: c.role,
      family: c.family,
      label_ar: c.label_ar,
      label_en: c.label_en,
      base_iqd: c.base_iqd,
      inputs: safeParse<Record<string, unknown>>(c.inputs_json, {}),
      value_iqd: c.value_iqd,
      estimate: safeParse<ComponentValuation | null>(c.estimate_json, null),
      required_angles: REQUIRED_PHOTOS[c.family].map((a) => a.id),
      photos: photos.filter((p) => p.component_role === c.role).map(photoView),
    })),
    // The figure fixed at submit — what the admin reviews. While a draft, the
    // live figure from the current answers (the same engine the page runs).
    estimate: req.status === 'draft' ? live.estimate : stored,
    estimated_iqd: req.status === 'draft' ? live.estimate.total_iqd : req.estimated_iqd,
    offer,
    final_value_iqd: req.final_value_iqd,
    credit_iqd: req.credit_iqd,
    difference_iqd: req.difference_iqd,
    excess_iqd: req.final_value_iqd !== null && req.credit_iqd !== null ? req.final_value_iqd - req.credit_iqd : null,
    credit_order: creditOrder ? { id: creditOrder.order_id, status: creditOrder.status, amount_iqd: creditOrder.amount_iqd } : null,
    customer_note: req.customer_note,
    cancel_reason: req.cancel_reason,
    blockers,
    events: events.map((e) => ({
      action: e.action,
      actor_role: e.actor_role,
      from_status: e.from_status,
      to_status: e.to_status,
      created_at: e.created_at,
      detail: audience === 'admin' ? e.detail : pickPublicDetail(e.detail),
    })),
    rules: Object.fromEntries(families.map((f) => [f, publicRules(book[f])])),
    can: {
      edit: req.status === 'draft',
      submit: req.status === 'draft' && !!blockers && !Object.keys(blockers.inputs).length && !Object.keys(blockers.photos).length && !blockers.target,
      cancel: !isTerminal(req.status) && !creditOrder,
      decide: req.status === 'value_changed',
      pay: req.status === 'awaiting_payment' && !creditOrder && (req.credit_iqd ?? 0) > 0,
    },
    created_at: req.created_at,
    submitted_at: req.submitted_at,
    decided_at: req.decided_at,
    completed_at: req.completed_at,
    cancelled_at: req.cancelled_at,
  };
}

function pickPublicDetail(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['value_iqd', 'estimated_iqd', 'reason', 'offer_no', 'via', 'difference_iqd', 'credit_iqd']) if (k in d) out[k] = d[k];
  return out;
}

/** The rule set as the wizard needs it for its live preview — every number is already public by design («شفاف»). */
export function publicRules(r: StoredRuleSet): TradeInRuleSet {
  return {
    family: r.family,
    version: r.version,
    floor_bp: r.floor_bp,
    cap_bp: r.cap_bp,
    rounding_iqd: r.rounding_iqd,
    min_base_iqd: r.min_base_iqd,
    ams_reference_iqd: r.ams_reference_iqd,
    is_default: r.is_default,
    factors: FACTOR_IDS.map((id) => r.factors.find((f) => f.factor === id)).filter((f): f is FactorRule => !!f),
  };
}

export async function listMine(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT id, status, scope, family, source_snapshot_json, target_snapshot_json, estimated_iqd, admin_value_iqd, final_value_iqd,
              difference_iqd, offer_no, created_at, updated_at
         FROM trade_in_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
    )
    .bind(userId)
    .all<Record<string, unknown>>();
  return (results ?? []).map((r) => {
    const src = safeParse<Record<string, unknown>>(r.source_snapshot_json, {});
    const tgt = safeParse<Record<string, unknown>>(r.target_snapshot_json, {});
    return {
      id: r.id,
      status: r.status,
      status_label: STATUS_LABELS[r.status as TradeInStatus],
      scope: r.scope,
      family: r.family,
      name: src.name ?? '',
      image: src.image ?? '',
      target_name: tgt.name ?? null,
      target_name_ar: tgt.name_ar ?? null,
      estimated_iqd: r.estimated_iqd,
      admin_value_iqd: r.admin_value_iqd,
      final_value_iqd: r.final_value_iqd,
      difference_iqd: r.difference_iqd,
      offer_no: r.offer_no,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });
}

// ================================================================= notifications

function appOrigin(env: Env): string | null {
  const origin = (env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  return origin.startsWith('https://') ? origin : null;
}

async function customerLang(env: Env, userId: string): Promise<EmailLang> {
  const row = await env.DB.prepare(`SELECT ${NOTIFY_LANG_SELECT} FROM users u WHERE u.id = ?`)
    .bind(userId)
    .first<NotifyLangRow>()
    .catch(() => null);
  return row ? notificationLang(row) : 'ar';
}

/** The customer's copy, in the three languages the customer may read. */
const COPY = {
  ar: {
    subject: 'قيمة جديدة لجهازك — مطلوب موافقتك',
    body: (name: string, from: string, to: string, reason: string, diff: string) =>
      `راجعنا جهازك (${name}) وحددنا قيمة الاستبدال ${to} بدل التقدير الأولي ${from}.${reason ? `\nالسبب: ${reason}` : ''}\nالمطلوب للجهاز الجديد بعد الاستبدال: ${diff} (التوصيل منفصل).\nوافق لنكمل، أو ارفض ونلغي الطلب.`,
    accept: '✅ أوافق على القيمة',
    reject: '✖️ أرفض',
    open: '🔗 فتح الطلب',
    cta: 'راجع القيمة وقرّر',
    accepted: (v: string) => `✅ وافقت — قيمة جهازك ${v}. أكمل الدفع من صفحة الطلب.`,
    rejected: '✖️ رفضت القيمة وأُغلق الطلب.',
    closed: 'هذا العرض لم يعد قائماً.',
  },
  en: {
    subject: 'A new value for your device — your decision is needed',
    body: (name: string, from: string, to: string, reason: string, diff: string) =>
      `We inspected your device (${name}) and set its trade-in value at ${to} instead of the preliminary ${from}.${reason ? `\nReason: ${reason}` : ''}\nYou would pay ${diff} for the new device (delivery separate).\nAccept to continue, or decline to close the request.`,
    accept: '✅ Accept the value',
    reject: '✖️ Decline',
    open: '🔗 Open the request',
    cta: 'Review and decide',
    accepted: (v: string) => `✅ Accepted — your device is worth ${v}. Complete the payment from the request page.`,
    rejected: '✖️ You declined; the request is closed.',
    closed: 'This offer is no longer open.',
  },
  ckb: {
    subject: 'بەهایەکی نوێ بۆ ئامێرەکەت — پێویستە بڕیار بدەیت',
    body: (name: string, from: string, to: string, reason: string, diff: string) =>
      `ئامێرەکەتمان (${name}) پشکنی و بەهای گۆڕینەوەکەیمان کرد بە ${to} لە جیاتی خەمڵاندنی سەرەتایی ${from}.${reason ? `\nهۆکار: ${reason}` : ''}\nبۆ ئامێرە نوێیەکە دوای گۆڕینەوە ${diff} دەدەیت (کرێی گەیاندن جیایە).\nڕازی بە بۆ ئەوەی بەردەوام بین، یان ڕەتی بکەرەوە و داواکارییەکە دادەخەین.`,
    accept: '✅ ڕازیم بە بەهاکە',
    reject: '✖️ ڕەتی دەکەمەوە',
    open: '🔗 کردنەوەی داواکارییەکە',
    cta: 'بەهاکە ببینە و بڕیار بدە',
    accepted: (v: string) => `✅ ڕازی بوویت — بەهای ئامێرەکەت ${v}. لە پەڕەی داواکارییەکەوە پارەدان تەواو بکە.`,
    rejected: '✖️ بەهاکەت ڕەت کردەوە و داواکارییەکە داخرا.',
    closed: 'ئەم ئۆفەرە چیتر کراوە نییە.',
  },
} as const;

const copyFor = (lang: EmailLang) => COPY[lang];

/** Telegram refuses callback_data over 64 bytes; ours is ~36. */
export const TRADE_IN_CALLBACK_PREFIX = 'ti:';
const REQ_ID_RE = /^tin_[0-9a-f]{20}$/;

export function tradeInCallbackData(decision: Decision, requestId: string, offerNo: number): string {
  return `${TRADE_IN_CALLBACK_PREFIX}${decision === 'accept' ? 'y' : 'n'}:${requestId}:${offerNo}`;
}
export function isTradeInCallbackData(data: unknown): data is string {
  return typeof data === 'string' && data.startsWith(TRADE_IN_CALLBACK_PREFIX);
}
export function parseTradeInCallbackData(data: unknown): { decision: Decision; requestId: string; offerNo: number } | null {
  if (!isTradeInCallbackData(data)) return null;
  const m = /^ti:([yn]):(tin_[0-9a-f]{20}):(\d{1,6})$/.exec(data);
  if (!m || !REQ_ID_RE.test(m[2])) return null;
  return { decision: m[1] === 'y' ? 'accept' : 'reject', requestId: m[2], offerNo: Number(m[3]) };
}

function promptText(req: RequestRow, lang: EmailLang): string {
  const t = copyFor(lang);
  const L = lang === 'en' ? 'en' : 'ar';
  const src = safeParse<{ name?: string }>(req.source_snapshot_json, {});
  const s = tradeInSettlement(req.target_price_iqd ?? 0, req.admin_value_iqd ?? 0);
  return `LEVONIS\n${t.body(
    sanitizeUserText(String(src.name ?? ''), { max: 120 }),
    iqdText(req.estimated_iqd ?? 0, L),
    iqdText(req.admin_value_iqd ?? 0, L),
    sanitizeUserText(req.admin_reason, { max: 500 }),
    iqdText(s.difference_iqd, L)
  )}`;
}

/**
 * «إذا غيّرت الإدارة السعر: إشعار للمستخدم … يطلب منه قبول أو رفض» — email
 * and WhatsApp through the ordinary fan-out (a link to the request), Telegram
 * as its own message with the two decision buttons. The in-app row was written
 * in the change batch. Never throws: the new value is already true.
 */
export async function notifyCustomerOfValue(env: Env, req: RequestRow): Promise<void> {
  try {
    const lang = await customerLang(env, req.user_id);
    const t = copyFor(lang);
    const L = lang === 'en' ? 'en' : 'ar';
    const origin = appOrigin(env);
    const src = safeParse<{ name?: string }>(req.source_snapshot_json, {});
    const s = tradeInSettlement(req.target_price_iqd ?? 0, req.admin_value_iqd ?? 0);
    await notifyCustomer(
      env,
      req.user_id,
      `trade_in:${req.id}:offer:${req.offer_no}`,
      {
        subject: t.subject,
        body: t.body(
          sanitizeUserText(String(src.name ?? ''), { max: 120 }),
          iqdText(req.estimated_iqd ?? 0, L),
          iqdText(req.admin_value_iqd ?? 0, L),
          sanitizeUserText(req.admin_reason, { max: 500 }),
          iqdText(s.difference_iqd, L)
        ),
        ...(origin ? { cta: { label: t.cta, url: `${origin}${requestPath(req.id)}` } } : {}),
      },
      { channels: ['email', 'whatsapp'] }
    );
    const reach = await reachFor(env, req.user_id);
    if (reach.telegram_chat_id === null) return;
    const text = promptText(req, lang);
    const markup = {
      inline_keyboard: [
        [{ text: t.accept, callback_data: tradeInCallbackData('accept', req.id, req.offer_no) }],
        [{ text: t.reject, callback_data: tradeInCallbackData('reject', req.id, req.offer_no) }],
        ...(origin ? [[{ text: t.open, url: `${origin}${requestPath(req.id)}` }]] : []),
      ],
    };
    const sent = await sendMessageToChat(env, reach.telegram_chat_id, text, { reply_markup: markup });
    if (sent.ok) {
      await env.DB.prepare('UPDATE trade_in_requests SET tg_chat_id = ?1, tg_message_id = ?2 WHERE id = ?3 AND offer_no = ?4')
        .bind(sent.chat_id, sent.message_id, req.id, req.offer_no)
        .run();
      return;
    }
    if (sent.retryable) {
      await enqueue(env, `trade_in:${req.id}:offer:${req.offer_no}:telegram`, {
        kind: 'telegram',
        chat_id: reach.telegram_chat_id,
        text,
        reply_markup: markup,
      });
    }
  } catch (e) {
    console.error('notifyCustomerOfValue failed for', req.id, e instanceof Error ? e.message : String(e));
  }
}

/** Rewrites the customer's Telegram prompt with the outcome and no buttons. Best effort. */
export async function stampCustomerPrompt(env: Env, req: RequestRow, original?: string): Promise<void> {
  try {
    if (!req.tg_chat_id || !req.tg_message_id) return;
    const lang = await customerLang(env, req.user_id);
    const t = copyFor(lang);
    const L = lang === 'en' ? 'en' : 'ar';
    const stamp =
      req.status === 'awaiting_payment' || req.status === 'completed'
        ? t.accepted(iqdText(req.final_value_iqd ?? 0, L))
        : req.status === 'customer_rejected'
          ? t.rejected
          : t.closed;
    const origin = appOrigin(env);
    const markup = origin ? { inline_keyboard: [[{ text: t.open, url: `${origin}${requestPath(req.id)}` }]] } : { inline_keyboard: [] };
    await editMessageText(env, req.tg_chat_id, req.tg_message_id, `${original ?? promptText(req, lang)}\n\n${stamp}`.slice(0, 4000), markup);
  } catch (e) {
    console.error('trade-in stampCustomerPrompt failed for', req.id, e instanceof Error ? e.message : String(e));
  }
}

function adminLink(env: Env, id: string): string | null {
  const origin = appOrigin(env);
  return origin ? `${origin}/admin?tab=trade_in&request=${encodeURIComponent(id)}` : null;
}

/**
 * The admin group hears about a trade-in in the DIRECT-orders topic: the
 * money it ends in is a direct sale of the new device, and that is the desk
 * that will hand it over. Never throws (`announceToAdmins`).
 */
export async function notifyAdmins(env: Env, req: RequestRow, event: 'submitted' | 'accepted' | 'rejected' | 'order_placed'): Promise<void> {
  const src = safeParse<{ name?: string; order_id?: string }>(req.source_snapshot_json, {});
  const tgt = safeParse<{ name?: string }>(req.target_snapshot_json, {});
  const name = sanitizeUserText(String(src.name ?? ''), { max: 120 });
  const head =
    event === 'submitted'
      ? '🔁 طلب استبدال جديد'
      : event === 'accepted'
        ? '✅ وافق الزبون على قيمة الاستبدال'
        : event === 'rejected'
          ? '❌ رفض الزبون قيمة الاستبدال'
          : '🧾 طلب شراء بقيمة الاستبدال';
  const lines = [
    `${head} — ${req.id}`,
    `الجهاز: ${name} (طلب ${src.order_id ?? req.order_id})`,
    `النطاق: ${req.scope === 'whole' ? 'الجهاز كاملاً' : req.scope === 'ams_only' ? 'AMS فقط' : 'الطابعة فقط'}`,
    `الجهاز الجديد: ${sanitizeUserText(String(tgt.name ?? ''), { max: 120 })} — ${iqdText(req.target_price_iqd ?? 0, 'ar')}`,
    event === 'submitted'
      ? `التقدير الأولي: ${iqdText(req.estimated_iqd ?? 0, 'ar')}`
      : `القيمة: ${iqdText(req.final_value_iqd ?? req.admin_value_iqd ?? 0, 'ar')} · الفرق: ${iqdText(req.difference_iqd ?? 0, 'ar')}`,
  ];
  const url = adminLink(env, req.id);
  await announceToAdmins(env, 'orders_direct', lines.join('\n'), url ? { reply_markup: { inline_keyboard: [[{ text: '🔗 فتح في لوحة الإدارة', url }]] } } : {});
}

// ================================================================= Telegram

export interface TradeInCallback {
  id: string;
  from?: { id?: number };
  data?: string;
  message?: { message_id?: number; chat?: { id?: number; type?: string }; text?: string };
}

export type TradeInCallbackOutcome = 'ignored' | 'not_owner' | 'not_found' | 'accepted' | 'rejected' | 'already' | 'stale';

/**
 * One press of «أوافق على القيمة» / «أرفض» in the customer's private chat.
 *
 * SECURITY: the presser must be the Telegram account LINKED to the request's
 * customer right now (a live `telegram_links` row) — a forwarded message
 * pressed by anyone else is refused and audited. The callback names the
 * REQUEST and the OFFER, so a stale message cannot accept a newer value.
 */
export async function handleTradeInCallback(env: Env, cb: TradeInCallback): Promise<TradeInCallbackOutcome> {
  const parsed = parseTradeInCallbackData(cb.data);
  const fromId = typeof cb.from?.id === 'number' && Number.isSafeInteger(cb.from.id) ? cb.from.id : null;
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!parsed || fromId === null || typeof chatId !== 'number' || typeof messageId !== 'number') {
    if (cb.id) await answerCallbackQuery(env, cb.id, 'زر غير صالح.', true);
    return 'ignored';
  }
  const req = await loadRequest(env.DB, parsed.requestId);
  const owner = req
    ? await env.DB.prepare('SELECT user_id FROM telegram_links WHERE user_id = ?1 AND telegram_user_id = ?2 AND revoked_at IS NULL')
        .bind(req.user_id, fromId)
        .first<{ user_id: string }>()
    : null;
  if (!req || !owner) {
    await answerCallbackQuery(env, cb.id, 'هذا الزر لصاحب الطلب فقط. / This button is for the request’s owner only.', true);
    await auditStatements(env.DB, null, 'trade_in.telegram_denied', parsed.requestId, { telegram_user_id: fromId, reason: req ? 'not_owner' : 'not_found' })
      .then((x) => env.DB.batch(x.statements))
      .catch(() => undefined);
    return req ? 'not_owner' : 'not_found';
  }
  const lang = await customerLang(env, req.user_id);
  const t = copyFor(lang);
  const original = typeof cb.message?.text === 'string' && cb.message.text ? cb.message.text : undefined;
  let res: { request: RequestRow; replayed: boolean };
  try {
    res = await decideValue(env, req, parsed.offerNo, parsed.decision, 'telegram');
  } catch (e) {
    if (e instanceof TradeInError) {
      await answerCallbackQuery(env, cb.id, t.closed, true);
      await stampCustomerPrompt(env, { ...req, tg_chat_id: chatId, tg_message_id: messageId, status: 'cancelled' }, original);
      return 'stale';
    }
    throw e;
  }
  const decided = { ...res.request, tg_chat_id: chatId, tg_message_id: messageId };
  const L = lang === 'en' ? 'en' : 'ar';
  await answerCallbackQuery(env, cb.id, parsed.decision === 'accept' ? t.accepted(iqdText(decided.final_value_iqd ?? 0, L)) : t.rejected, false);
  await stampCustomerPrompt(env, decided, original);
  if (res.replayed) return 'already';
  await notifyAdmins(env, res.request, parsed.decision === 'accept' ? 'accepted' : 'rejected');
  return parsed.decision === 'accept' ? 'accepted' : 'rejected';
}

// ================================================================= admin lists

export async function adminList(
  db: D1Database,
  q: { status: string | null; family: string | null; search: string | null; limit: number; offset: number }
) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.status) {
    args.push(q.status);
    where.push(`r.status = ?${args.length}`);
  }
  if (q.family) {
    args.push(q.family);
    where.push(`r.family = ?${args.length}`);
  }
  if (q.search) {
    // Exact ids only — a request id, an order id or a customer's phone. No
    // LIKE: the three things an admin pastes are identifiers.
    args.push(q.search);
    const n = args.length;
    where.push(`(r.id = ?${n} OR r.order_id = ?${n} OR u.phone_e164 = ?${n} OR u.email = ?${n})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(q.limit, q.offset);
  const { results } = await db
    .prepare(
      `SELECT r.id, r.status, r.family, r.scope, r.order_id, r.source_snapshot_json, r.target_snapshot_json, r.estimated_iqd,
              r.admin_value_iqd, r.final_value_iqd, r.difference_iqd, r.target_price_iqd, r.created_at, r.submitted_at, r.updated_at,
              u.name AS customer_name, u.phone_e164 AS customer_phone
         FROM trade_in_requests r LEFT JOIN users u ON u.id = r.user_id
         ${clause}
        ORDER BY COALESCE(r.submitted_at, r.created_at) DESC
        LIMIT ?${args.length - 1} OFFSET ?${args.length}`
    )
    .bind(...args)
    .all<Record<string, unknown>>();
  const counts = await db.prepare("SELECT status, COUNT(*) AS n FROM trade_in_requests WHERE status <> 'draft' GROUP BY status").all<{ status: string; n: number }>();
  return {
    requests: (results ?? []).map((r) => {
      const src = safeParse<Record<string, unknown>>(r.source_snapshot_json, {});
      const tgt = safeParse<Record<string, unknown>>(r.target_snapshot_json, {});
      return {
        id: r.id,
        status: r.status,
        family: r.family,
        scope: r.scope,
        order_id: r.order_id,
        name: src.name ?? '',
        image: src.image ?? '',
        target_name: tgt.name ?? '',
        estimated_iqd: r.estimated_iqd,
        admin_value_iqd: r.admin_value_iqd,
        final_value_iqd: r.final_value_iqd,
        difference_iqd: r.difference_iqd,
        target_price_iqd: r.target_price_iqd,
        customer_name: r.customer_name,
        customer_phone: r.customer_phone,
        created_at: r.created_at,
        submitted_at: r.submitted_at,
        updated_at: r.updated_at,
      };
    }),
    counts: Object.fromEntries((counts.results ?? []).map((c) => [c.status, c.n])),
  };
}
