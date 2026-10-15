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
 *                 customer actually paid for ONE unit of the line, by the
 *                 one rule price protection reads too (Services V2 plan
 *                 §3.2, packages/pricing/src/paidNet.ts): the merchandise
 *                 without the extended-warranty fee (the cover that is left
 *                 is valued by its own factor, not twice) or the transport
 *                 fee, less the frozen membership, the line's own discount,
 *                 and its share of the order's coupon and points; plus an
 *                 accepted price adjustment; less every price-protection
 *                 credit already paid on the line. A trade-in credit that
 *                 bought the device counts as paid. Never a catalogue price.
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
import { needsPricingIds } from './needsPricing';
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
import { closedClaimSql, parseOpsPolicy } from './deviceOps';
import { loadOrdersPaidNet } from './paidNet';
import type { MoneyGrant } from './moneyAuthority';
import { addMonths } from './membershipOps';
import { membershipDiscountAtLine } from './orderMembership';
import { effectiveBaseMonths } from './warrantyPlans';
import { serialAssignmentsInstalled } from './serialPolicy';
import { MAX_REPLACEMENT_HOPS, liveUnitOfSlot } from './deviceCustody';
import { benefitFallbackFor, pricingCtxForUser, quoteOptionValueIds, saleAvailability } from '../routes/products';
import {
  FACTOR_IDS,
  REQUIRED_PHOTOS,
  STAGE_LABELS,
  STATUS_LABELS,
  anglesFor,
  stageOf,
  TRADE_IN_FAMILIES,
  blankInputs,
  canTransition,
  checklistLabelCkb,
  checklistOf,
  daysBetween,
  missingProofs,
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
  type FactorId,
  type FactorRule,
  type TradeInFamily,
  type TradeInRuleSet,
  type TradeInScope,
  type TradeInSettlement,
  type TradeInStatus,
  type TradeInStage,
} from '@levonis/pricing/tradeIn';
import { DEFAULT_RULE_SETS } from '@levonis/pricing/tradeInDefaults';
import { paidNetPerUnit } from '@levonis/pricing/paidNet';
import { OFFER_PARAM_COLUMNS, settlement as offerSettlement, validateOfferParams, type OfferParamColumn } from '@levonis/pricing/tradeInOffer';
import { tradeInV2Installed } from './tradeInSchema';
import { openProtectionSql, openReturnSql, openServiceSql } from './services/myDevices';
import { offerFor, storedInputs, valuationStatement, type ValuationDraft } from './tradeInOffer';
import { getSetting } from './settings';

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
  | 'TRADE_IN_STALE'
  | 'TRADE_IN_SERVICE_OPEN'
  | 'TRADE_IN_PROTECTION_OPEN'
  | 'TRADE_IN_CREDIT_EXPIRED'
  | 'TRADE_IN_PREVIEW_LIMIT'
  // ---- trade-in v2 (S-P2, DECISIONS row 238)
  | 'TRADE_IN_NO_OFFER'
  | 'TRADE_IN_TARGET_NOT_LISTED'
  | 'TRADE_IN_DEVICE_NOT_RECEIVED'
  | 'TRADE_IN_OFFER_EXPIRED'
  | 'TRADE_IN_SERIAL_MISMATCH'
  | 'TRADE_IN_ALREADY_RECEIVED'
  | 'TRADE_IN_INTAKE_REQUIRED'
  | 'TRADE_IN_OWN_REQUEST'
  | 'TRADE_IN_ORDER_NOT_DELIVERED'
  | 'TRADE_IN_ORDER_DELIVERED'
  | 'TRADE_IN_DEVICE_IN_SHOP'
  | 'TRADE_IN_MARGIN_ACK_REQUIRED'
  | 'TRADE_IN_HOURS_PHOTO'
  | 'TRADE_IN_DAMAGE_PHOTO';

export class TradeInError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 429,
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
  TRADE_IN_SERVICE_OPEN: 'This device has an open warranty or repair request. It can be traded in once that request is closed.',
  TRADE_IN_PROTECTION_OPEN: 'This item has a price-protection claim under review. It can be traded in once that claim is decided.',
  TRADE_IN_CREDIT_EXPIRED: 'The trade-in credit has expired.',
  TRADE_IN_PREVIEW_LIMIT: 'You have reached the number of estimates allowed. Send the request as it is, or try again tomorrow.',
  TRADE_IN_NO_OFFER: 'We can’t make an offer for this device right now.',
  TRADE_IN_TARGET_NOT_LISTED: 'This device is not on sale right now, so it can’t be chosen. Choose another one.',
  TRADE_IN_DEVICE_NOT_RECEIVED: 'The credit can be used once we receive your old device.',
  TRADE_IN_OFFER_EXPIRED: 'The offer expired. Open a new request for an offer at today’s prices.',
  TRADE_IN_SERIAL_MISMATCH: 'The serial number does not match the device sold.',
  TRADE_IN_ALREADY_RECEIVED: 'This device’s receipt was already recorded.',
  TRADE_IN_INTAKE_REQUIRED: 'Receive the device and record its serial and hours first.',
  TRADE_IN_OWN_REQUEST: 'Staff do not receive their own trade-in; a colleague handles it.',
  TRADE_IN_ORDER_NOT_DELIVERED: 'The trade-in completes when the new device is delivered.',
  TRADE_IN_ORDER_DELIVERED: 'A delivered order that completed a trade-in is not cancelled; open a return instead.',
  TRADE_IN_DEVICE_IN_SHOP: 'This device is with us for a trade-in, so no other request can be opened on it.',
  TRADE_IN_MARGIN_ACK_REQUIRED: 'Confirm you understand the margin shrinks and may be a loss.',
  TRADE_IN_HOURS_PHOTO: 'Photograph the hours screen.',
  TRADE_IN_DAMAGE_PHOTO: 'Add a photo for each damage you ticked.',
};

const STATUS_OF: Partial<Record<TradeInCode, 400 | 403 | 409 | 429>> = {
  TRADE_IN_INPUTS_INVALID: 400,
  TRADE_IN_PHOTO_ANGLE: 400,
  TRADE_IN_INVALID_VALUE: 400,
  TRADE_IN_RULES_INVALID: 400,
  TRADE_IN_TARGET_REQUIRED: 400,
  TRADE_IN_COUPON_MISMATCH: 400,
  TRADE_IN_PREVIEW_LIMIT: 429,
  TRADE_IN_MARGIN_ACK_REQUIRED: 400,
  TRADE_IN_OWN_REQUEST: 403,
  TRADE_IN_HOURS_PHOTO: 400,
  TRADE_IN_DAMAGE_PHOTO: 400,
};

export const refuse = (code: TradeInCode, details?: Record<string, unknown>) =>
  new TradeInError(STATUS_OF[code] ?? 409, code, MESSAGES[code], details);
export const notFoundTI = (what = 'Trade-in request not found') => new TradeInError(404, 'NOT_FOUND', what);

// ================================================================= rules

export type StoredRuleSet = TradeInRuleSet & {
  id: string;
  note: string;
  created_at: string;
  created_by: string | null;
  /** The owner's offer parameters stored on this version (0192; NULL = the code default). Owner-only. */
  offer_params?: Partial<Record<OfferParamColumn, number | null>>;
};
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
  /** 0192 — present (possibly NULL) on a migrated database, absent before it. */
  resale_bp?: number | null;
  handling_iqd?: number | null;
  warranty_reserve_bp?: number | null;
  margin_bp?: number | null;
  margin_min_iqd?: number | null;
  max_offer_bp?: number | null;
  offer_rounding_iqd?: number | null;
  min_offer_iqd?: number | null;
}

/** The 0192 columns a stored rule set row carries (absent → nothing; NULL → the default). */
function offerParamsOfRow(row: RuleSetRow): Partial<Record<OfferParamColumn, number | null>> {
  const out: Partial<Record<OfferParamColumn, number | null>> = {};
  for (const k of OFFER_PARAM_COLUMNS) if (k in row) out[k] = row[k] ?? null;
  return out;
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
    offer_params: offerParamsOfRow(row),
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
  // The owner's offer parameters (0192), on the same rule set: each key sent is validated against its CHECK
  // range; a key not sent keeps the version before it (an editor that predates them changes nothing).
  const params = validateOfferParams(raw);
  if (!params.ok) throw refuse('TRADE_IN_RULES_INVALID', { errors: params.errors });
  const db = env.DB;
  const cur = await db.prepare('SELECT MAX(version) AS v FROM trade_in_rule_sets WHERE family = ?').bind(family).first<{ v: number | null }>();
  const version = (cur?.v ?? 0) + 1;
  const id = `tirs_${family}_v${version}`;
  const now = new Date().toISOString();
  const r = checked.value;
  const audit = await auditStatements(db, adminId, 'trade_in.rules.save', id, { family, version, note });
  const v2 = await tradeInV2Installed(db);
  const before = v2 ? (await loadRuleBook(db))[family].offer_params ?? {} : {};
  const merged = Object.fromEntries(OFFER_PARAM_COLUMNS.map((k) => [k, k in params.value ? (params.value[k] ?? null) : (before[k] ?? null)]));
  try {
    await db.batch([
      v2
        ? db
            .prepare(
              `INSERT INTO trade_in_rule_sets (id, family, version, floor_bp, cap_bp, rounding_iqd, min_base_iqd, ams_reference_iqd, is_default, note, created_by, created_at,
                  resale_bp, handling_iqd, warranty_reserve_bp, margin_bp, margin_min_iqd, max_offer_bp, offer_rounding_iqd, min_offer_iqd)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`
            )
            .bind(
              id, family, version, r.floor_bp, r.cap_bp, r.rounding_iqd, r.min_base_iqd, r.ams_reference_iqd, note, adminId, now,
              ...OFFER_PARAM_COLUMNS.map((k) => merged[k] ?? null)
            )
        : db
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
/**
 * THE PLAIN SIBLING OF A COMBO OPTION: same group, its `variant_key` without
 * «-combo», else the same name without «Combo», else the only plain value.
 */
export function plainSiblingOf<V extends Pick<OptionValueRow, 'id' | 'group_id' | 'variant_key' | 'name_en' | 'name_ar' | 'merged_into'>>(
  c: V,
  siblings: readonly V[]
): V | undefined {
  const key = String(c.variant_key ?? '').replace(/[-_ ]?combo$/i, '');
  const plain = siblings.filter((v) => v.id !== c.id && v.group_id === c.group_id && !v.merged_into && !isComboValue(v as unknown as OptionValueRow));
  const byKey = key ? plain.find((v) => String(v.variant_key ?? '') === key) : undefined;
  const byName = plain.find((v) => v.name_en.trim().toLowerCase() === c.name_en.replace(COMBO_RE, '').trim().toLowerCase());
  return byKey ?? byName ?? (plain.length === 1 ? plain[0] : undefined);
}

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
    const base = plainSiblingOf(c, input.siblings);
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
  /** What this unit was bought as (model values, colour) and, on a Combo, its Combo value and plain sibling (S-P2 B.4). */
  selection: { option_value_ids: string[]; color_id: string | null; combo_value_id: string | null; plain_value_id: string | null };
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
  color_id: string | null;
  qty: number;
  unit_price_iqd: number;
  warranty_snapshot: string | null;
  membership_discount_iqd: number | null;
  membership_rule_id: string | null;
  benefit_snapshot: string | null;
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
         oi.option_id, oi.option_value_ids, oi.color_id, oi.qty, oi.unit_price_iqd, oi.warranty_snapshot,
         oi.membership_discount_iqd, oi.membership_rule_id, oi.coupon_discount_iqd, oi.gift_entitlement_id,
         o.benefit_snapshot, o.status, o.created_at AS ordered_at, o.delivered_at AS order_delivered_at,
         p.slug, p.name, p.name_ar, p.template_family, p.category_id, p.sub_category_id, p.ops_policy, p.price_iqd
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
   WHERE o.user_id = ?1
     AND COALESCE(o.seller_type, 'levonis') <> 'merchant'
     AND oi.product_id IS NOT NULL
     AND oi.bundle_parent_item_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM order_items k WHERE k.bundle_parent_item_id = oi.id)`;

/**
 * ONE unit of a line on its own — the shared paid-net rule with no
 * order-level coupon, points or adjustment (those need the whole order:
 * eligibility reads it through `loadOrdersPaidNet`). The line is floored once
 * over its quantity, the same rounding price protection applies.
 */
export function paidPerUnit(line: Pick<LineRow, 'unit_price_iqd' | 'qty' | 'warranty_snapshot' | 'membership_discount_iqd' | 'coupon_discount_iqd'>
  & Partial<Pick<LineRow, 'product_id' | 'membership_rule_id' | 'benefit_snapshot'>>): number {
  const qty = Math.max(1, Number(line.qty) || 1);
  const unit = Math.max(0, Number(line.unit_price_iqd) || 0);
  const w = safeParse<{ fee_iqd?: unknown } | null>(line.warranty_snapshot, null);
  const fee = typeof w?.fee_iqd === 'number' && Number.isFinite(w.fee_iqd) ? Math.max(0, Math.min(Math.trunc(w.fee_iqd), unit)) : 0;
  const membership = membershipDiscountAtLine({ benefit_snapshot: line.benefit_snapshot }, { ...line });
  const gross = unit * qty;
  return (
    paidNetPerUnit(
      { subtotal_iqd: gross, shipping_iqd: 0, total_iqd: gross, order_coupon_iqd: 0, points_iqd: 0 },
      [
        {
          id: 'line',
          qty,
          gross_iqd: gross,
          merchandise_iqd: (unit - fee) * qty,
          membership_iqd: Math.max(0, membership || 0),
          line_discount_iqd: Math.max(0, Number(line.coupon_discount_iqd) || 0),
          price_adjustment_iqd: 0,
        },
      ],
      'line'
    ) ?? 0
  );
}

/** Units per line shown for trade-in: a line of 30 printers is a reseller, not this screen. */
const MAX_UNITS_PER_LINE = 10;

async function buildEligibility(env: Env, userId: string, lines: LineRow[], nowIso: string): Promise<EligibleUnit[]> {
  if (lines.length === 0) return [];
  const db = env.DB;
  const idx = await catalogIndexFor(db);
  const itemIds = JSON.stringify(lines.map((l) => l.item_id));
  const productIds = JSON.stringify([...new Set(lines.map((l) => l.product_id))]);
  const orderIds = [...new Set(lines.map((l) => l.order_id))];
  const [units, receipts, claims, returns, values, rules, links, paidNet, protection, serviceClaims] = await Promise.all([
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
    // «ما دفعه فعلاً» — the whole order, by the shared rule (plan §3.2).
    loadOrdersPaidNet(db, orderIds),
    // Price protection on these lines, claim by claim: what each credited and
    // over which units (it comes off what those units were paid — no trade-in
    // on the original price after a credit), and whether a claim is still
    // being decided (no trade-in until it is).
    db
      .prepare(
        `SELECT order_item_id, state, credited_iqd, qty,
                CASE WHEN json_valid(policy_snapshot) THEN json_extract(policy_snapshot, '$.covered_qty') END AS covered_qty,
                CASE WHEN json_valid(policy_snapshot) THEN json_extract(policy_snapshot, '$.covered_unit_indexes') END AS covered_units
           FROM price_protection_claims WHERE order_item_id IN (SELECT value FROM json_each(?1))`
      )
      .bind(itemIds)
      .all<{ order_item_id: string; state: string; credited_iqd: number | null; qty: number | null; covered_qty: number | null; covered_units: string | null }>(),
    // Devices on the repair desk: an OPEN warranty claim on a unit of these
    // lines (or a legacy claim on the line itself). The trade-in waits for it.
    db
      .prepare(
        `SELECT wc.unit_id, wc.order_item_id FROM warranty_claims wc
          WHERE (wc.unit_id IN (SELECT id FROM order_item_units WHERE order_item_id IN (SELECT value FROM json_each(?1)))
                 OR (wc.unit_id IS NULL AND wc.order_item_id IN (SELECT value FROM json_each(?1))))
            AND NOT ${closedClaimSql('wc')}`
      )
      .bind(itemIds)
      .all<{ unit_id: string | null; order_item_id: string | null }>(),
  ]);
  const protectionOf = protectionByLine(protection.results ?? []);
  const claimedUnits = new Set((serviceClaims.results ?? []).map((r) => r.unit_id).filter((x): x is string => !!x));
  const claimedLines = new Set((serviceClaims.results ?? []).filter((r) => !r.unit_id && r.order_item_id).map((r) => String(r.order_item_id)));
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

  // The clean start (DECISIONS row 222; review 2026-10-14): a product still «يحتاج تسعيرًا» keeps its old dinar
  // model prices only as an archive — the Combo/AMS split never reads them; such a Combo is valued by the
  // reference method. A V2-published product's model cells are the V2 writer's and are read as before.
  const unpriced = await needsPricingIds(db, [...new Set(lines.map((l) => l.product_id))]);
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
    const plainValue = comboValue ? plainSiblingOf(comboValue, productValues) ?? null : null;
    const selection = {
      option_value_ids: [...selected],
      color_id: line.color_id ? String(line.color_id) : null,
      combo_value_id: comboValue?.id ?? null,
      plain_value_id: plainValue?.id ?? null,
    };
    const isCombo = (family === 'fdm' || family === 'resin') && (comboValue !== null || COMBO_RE.test(`${line.option_snapshot} ${line.name_snapshot}`));
    const facts = paidNet.get(line.order_id);
    const pp = protectionOf.get(line.item_id);
    // What one unit cost, by the shared rule; each unit then gives back the
    // protection IT received (below).
    const paidLine = facts ? paidNetPerUnit(facts.order, facts.lines, line.item_id) ?? 0 : 0;
    const protectionOpen = pp?.open ?? false;
    const opsMonths = effectiveBaseMonths(parseOpsPolicy(line.ops_policy).base_months, printers.has(line.product_id));
    const qty = Math.min(Math.max(1, Number(line.qty) || 1), MAX_UNITS_PER_LINE);
    for (let unitIndex = 1; unitIndex <= qty; unitIndex++) {
      // What this unit was paid less the protection credited FOR IT (review
      // F7): each claim's credit over the units it covered — a unit already
      // in a trade-in when a claim was decided received none of it — rounded
      // against the store.
      const paid = Math.max(0, paidLine - protectionDeduction(pp, unitIndex));
      const split = isCombo
        ? amsSplit({
            paidIqd: paid,
            combo: unpriced.has(line.product_id) ? null : comboValue,
            siblings: productValues,
            productPriceIqd: Number(line.price_iqd) || 0,
            referenceIqd: rules.ams.ams_reference_iqd,
          })
        : { method: 'none' as const, share_bp: null, ams_base_iqd: 0 };
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
      // The slot's devices: its own unit and every warranty replacement after it.
      const slotUnits: string[] = [];
      for (let cur: typeof unit = unit, hop = 0; cur && hop <= MAX_REPLACEMENT_HOPS; hop++) {
        slotUnits.push(cur.id);
        cur = cur.replaced_by_unit_id ? (unitById.get(cur.replaced_by_unit_id) ?? null) : null;
      }
      const serviceOpen = claimedLines.has(line.item_id) || slotUnits.some((id) => claimedUnits.has(id));
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
        // One money process per unit (plan §1.3): a device on the repair desk
        // (V4 / G-5) or a line whose price-protection claim is still being
        // decided is not valued until that process is over.
        else if (serviceOpen) reason = 'TRADE_IN_SERVICE_OPEN';
        else if (protectionOpen) reason = 'TRADE_IN_PROTECTION_OPEN';
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
        selection,
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

/**
 * A UNIT AS ITS CUSTOMER READS IT (DECISIONS rows 220 and 238) — an ALLOW-LIST,
 * built field by field, never a spread of the internal unit.
 *
 * Since S-P2 the offer is the only figure for the old device: no part base, no
 * AMS share, no split method's numbers (they were the v1 valuation's inputs, and
 * on a `reference` split the owner's private AMS reference). The keys the old
 * wizard reads stay (`ams_split.method`, `scopes[].base_iqd` = null) so a phone
 * still holding it keeps working until it reloads. What the customer paid is
 * their own figure and stays.
 */
export interface PublicEligibleUnit {
  key: string;
  order_item_id: string;
  unit_index: number;
  order_id: string;
  product_id: string;
  product_slug: string;
  name: string;
  variant: string;
  image: string;
  family: TradeInFamily;
  is_combo: boolean;
  ams_split: { method: AmsSplit['method']; share_bp: null };
  paid_iqd: number;
  ordered_at: string;
  delivered_at: string | null;
  warranty_end_at: string | null;
  usage_days: number;
  usage_months: number;
  warranty_remaining_months: number;
  scopes: Array<{ scope: TradeInScope; available: boolean; reason: TradeInCode | null; components: Array<{ role: ComponentRole; family: TradeInFamily }>; base_iqd: null }>;
  available: boolean;
  reason: TradeInCode | null;
  open_request_id: string | null;
  /** S-P2: the shop holds this device (received for a trade-in, not handed back yet). */
  in_shop: boolean;
  /** S-P2: the stage of the open trade-in on this device, or null (`listMyDevices`). */
  stage: TradeInStage | null;
}
export function publicUnit(u: EligibleUnit, facts?: { in_shop: boolean; stage: TradeInStage | null }): PublicEligibleUnit {
  return {
    key: u.key,
    order_item_id: u.order_item_id,
    unit_index: u.unit_index,
    order_id: u.order_id,
    product_id: u.product_id,
    product_slug: u.product_slug,
    name: u.name,
    variant: u.variant,
    image: u.image,
    family: u.family,
    is_combo: u.is_combo,
    ams_split: { method: u.ams_split.method, share_bp: null },
    paid_iqd: u.paid_iqd,
    ordered_at: u.ordered_at,
    delivered_at: u.delivered_at,
    warranty_end_at: u.warranty_end_at,
    usage_days: u.usage_days,
    usage_months: u.usage_months,
    warranty_remaining_months: u.warranty_remaining_months,
    scopes: u.scopes.map((sc) => ({
      scope: sc.scope,
      available: sc.available,
      reason: sc.reason,
      components: sc.components.map(({ role, family }) => ({ role, family })),
      base_iqd: null,
    })),
    available: u.available,
    reason: u.reason,
    open_request_id: u.open_request_id,
    in_shop: facts?.in_shop ?? false,
    stage: facts?.stage ?? null,
  };
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
  // ---- 0192 (trade-in v2): present on a migrated database, absent before it.
  valuation_version?: number;
  paid_net_iqd?: number | null;
  now_price_iqd?: number | null;
  now_price_channel?: string | null;
  offer_iqd?: number | null;
  offer_at?: string | null;
  offer_expires_at?: string | null;
  /** The server's ceiling at intake: staff-visible, never the customer's. */
  ceiling_iqd?: number | null;
  ceiling_at?: string | null;
  above_ceiling?: number;
  intake_at?: string | null;
  intake_by?: string | null;
  intake_serial_norm?: string | null;
  intake_serial_match?: 'match' | 'mismatch' | 'unrecorded' | 'not_applicable' | null;
  intake_json?: string;
  handover?: 'store' | 'pickup' | null;
  pickup_fee_iqd?: number;
  device_returned_at?: string | null;
  device_returned_by?: string | null;
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
  /** 0192: the condition recorded at intake (staff). */
  intake_inputs_json?: string;
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
  /** 0192: who took it (the customer's evidence, or the desk's at intake) and what it proves (`hours`, a fault id). */
  phase?: 'customer' | 'intake';
  proves?: string;
}

/**
 * THE FIGURE A RECEIVED DEVICE IS HELD TO (spec §6.5): the v2 offer — or the lower value the desk
 * already proposed against it — or, for a request sent before S-P2, its figure at that stage (the
 * estimate, the proposal, the value fixed on photos). The intake ceiling is min(this, the formula).
 */
export function referenceOf(
  req: Pick<RequestRow, 'status' | 'offer_iqd' | 'estimated_iqd' | 'admin_value_iqd' | 'final_value_iqd'> & { valuation_version?: number }
): number {
  const nonNeg = (n: number | null | undefined) => Math.max(0, Math.trunc(Number(n) || 0));
  if ((req.valuation_version ?? 1) >= 2 && req.offer_iqd !== null && req.offer_iqd !== undefined) {
    if (req.status === 'value_changed' && req.admin_value_iqd !== null) return Math.min(nonNeg(req.offer_iqd), nonNeg(req.admin_value_iqd));
    if ((req.status === 'awaiting_payment' || req.status === 'completed') && req.final_value_iqd !== null) return nonNeg(req.final_value_iqd);
    return nonNeg(req.offer_iqd);
  }
  if (req.status === 'value_changed') return nonNeg(req.admin_value_iqd ?? req.estimated_iqd);
  if (req.status === 'awaiting_payment' || req.status === 'completed') return nonNeg(req.final_value_iqd ?? req.estimated_iqd);
  return nonNeg(req.estimated_iqd);
}

/**
 * THE MOST A FINANCIAL ADMIN MAY FIX (decision 3): the server's ceiling recorded at intake — never
 * a figure the client sends, never the submit-time estimate once the device was received. A
 * request received before the ceiling was recorded (none in production) is held to its reference.
 */
export const approvalCeiling = (req: RequestRow): number =>
  req.ceiling_iqd !== null && req.ceiling_iqd !== undefined ? Math.max(0, Math.trunc(req.ceiling_iqd)) : referenceOf(req);

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
  // A counted estimate (`previewDraft`) is a log line, not a step of the
  // request: the timeline never draws it, and `previewCount` counts it.
  const { results } = await db
    .prepare(
      `SELECT id, actor_role, action, from_status, to_status, detail_json, created_at FROM trade_in_events
        WHERE request_id = ? AND action <> 'preview' ORDER BY created_at, rowid LIMIT 100`
    )
    .bind(requestId)
    .all<{ id: string; actor_role: string; action: string; from_status: string | null; to_status: string | null; detail_json: string; created_at: string }>();
  return (results ?? []).map((e) => ({ ...e, detail: safeParse<Record<string, unknown>>(e.detail_json, {}), detail_json: undefined }));
}

export function eventStatement(
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
export function fence(db: D1Database, id: string, token: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE trade_in_requests SET status = CASE WHEN decision_token = ?2 THEN status ELSE NULL END WHERE id = ?1`)
    .bind(id, token);
}

export const isAbort = (e: unknown) => /NOT NULL|constraint|UNIQUE/i.test(e instanceof Error ? e.message : String(e));

/**
 * ONE MONEY PROCESS PER UNIT (Services V2 plan §1.3), inside the batch.
 *
 * The eligibility read above refuses a unit with an open return, an open
 * warranty claim or a price-protection claim being decided; this is the same
 * question asked AGAIN in the write, so a claim opened between that read and
 * this batch aborts it (status → NULL on the NOT NULL column) instead of
 * landing a draft, an estimate or a credit on a device that is on the repair
 * desk or whose price is being compensated. `?2` the line, `?3` the slot's
 * unit ids (JSON). The three questions (an open return holding the slot's
 * device — review R1's count rule —, an open warranty claim, a protection claim
 * being decided) live in worker/lib/services/myDevices.ts, shared by every service.
 */
export interface Slot {
  orderItemId: string;
  unitIds: string[];
}

/** The devices of one slot: its own unit and every warranty replacement after it (the deviceCustody chain). */
export async function slotOf(db: D1Database, orderItemId: string, unitIndex: number): Promise<Slot> {
  const { results } = await db
    .prepare('SELECT id, unit_index, replaced_by_unit_id FROM order_item_units WHERE order_item_id = ?')
    .bind(orderItemId)
    .all<{ id: string; unit_index: number; replaced_by_unit_id: string | null }>();
  const byId = new Map((results ?? []).map((u) => [u.id, u]));
  const unitIds: string[] = [];
  let cur = (results ?? []).find((u) => Number(u.unit_index) === unitIndex) ?? null;
  for (let hop = 0; cur && hop <= MAX_REPLACEMENT_HOPS; hop++) {
    unitIds.push(cur.id);
    cur = cur.replaced_by_unit_id ? (byId.get(cur.replaced_by_unit_id) ?? null) : null;
  }
  return { orderItemId, unitIds };
}

export function serviceFence(db: D1Database, requestId: string, slot: Slot): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE trade_in_requests SET status = CASE WHEN ${openReturnSql} OR ${openServiceSql} OR ${openProtectionSql} THEN NULL ELSE status END
        WHERE id = ?1`
    )
    .bind(requestId, slot.orderItemId, JSON.stringify(slot.unitIds));
}

/** Which process holds the unit now, after a fenced batch aborted — the honest refusal, or null. */
export async function serviceBlocker(db: D1Database, slot: Slot): Promise<TradeInCode | null> {
  const row = await db
    .prepare(`SELECT ${openReturnSql} AS ret, ${openServiceSql} AS svc, ${openProtectionSql} AS pp WHERE ?1 IS NULL OR ?1 IS NOT NULL`)
    .bind(null, slot.orderItemId, JSON.stringify(slot.unitIds))
    .first<{ ret: number; svc: number; pp: number }>();
  if (row?.svc) return 'TRADE_IN_SERVICE_OPEN';
  if (row?.pp) return 'TRADE_IN_PROTECTION_OPEN';
  if (row?.ret) return 'TRADE_IN_RETURN_OPEN';
  return null;
}

/** Owner decision 2: a trade-in credit is usable for seven days from the moment it is minted. */
export const TRADE_IN_CREDIT_VALID_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * WHEN A CREDIT ENDS (owner decision 2): its coupon's own end, plus the time
 * an order that spent it and was then cancelled held it — a cancelled order
 * costs the customer no time and buys them none either. Null: a credit minted
 * before credits had an end keeps none.
 *
 * Since migration 0191 the cancel itself moves the coupon's `ends_at` by that
 * time (`trg_orders_coupon_released`), so `held` is only ever an order
 * cancelled before 0191 whose use is still spent (row 237).
 */
export function creditEndsAt(
  endsAt: string | null | undefined,
  held: { created_at: string; cancelled_at: string | null } | null | undefined,
  nowMs: number
): string | null {
  if (!endsAt || !Number.isFinite(Date.parse(endsAt))) return null;
  const from = held ? Date.parse(held.created_at) : NaN;
  const to = held?.cancelled_at ? Date.parse(held.cancelled_at) : nowMs;
  const lost = Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : 0;
  return new Date(Date.parse(endsAt) + lost).toISOString();
}

const creditExpired = (endsAt: string | null, nowMs: number) => endsAt !== null && Date.parse(endsAt) < nowMs;

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
  // Trade-in v2 (0192): a new draft is valued by the store-safe offer and asks for the v2 photo proofs.
  const v2 = await tradeInV2Installed(db);
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
            family, scope, is_combo, source_snapshot_json, created_at, updated_at${v2 ? ', valuation_version' : ''})
         VALUES (?1, ?2, 'draft', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12${v2 ? ', 2' : ''})`
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
  const slot = await slotOf(db, unit.order_item_id, unit.unit_index);
  stmts.push(serviceFence(db, id, slot));
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isAbort(e)) throw refuse((await serviceBlocker(db, slot)) ?? 'TRADE_IN_ALREADY_CLAIMED');
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
    name_ckb?: string;
    image: string;
    family: TradeInFamily;
    options: Array<{ id: string; label_ar: string; label_en: string; label_ckb?: string }>;
    color: { id: string; label_ar: string; label_en: string; label_ckb?: string; hex: string } | null;
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
  // S-P2: an unlisted target (hidden, held, «يحتاج تسعيرًا», gone) reads its own sentence.
  if (!row) throw refuse('TRADE_IN_TARGET_NOT_LISTED');
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
      // The catalogue's own Sorani where the owner wrote it (DECISIONS row 183); the screen reads the name otherwise.
      ...(doc.name_ckb ? { name_ckb: doc.name_ckb } : {}),
      image: coverOf(doc),
      family,
      options: optionValueIds.map((id) => {
        const o = doc.options.find((x) => x.id === id);
        return { id, label_ar: o?.name_ar || o?.name_en || id, label_en: o?.name_en || o?.name_ar || id, ...(o?.name_ckb ? { label_ckb: o.name_ckb } : {}) };
      }),
      color: color
        ? { id: color.id, label_ar: color.name_ar || color.name_en, label_en: color.name_en || color.name_ar, ...(color.name_ckb ? { label_ckb: color.name_ckb } : {}), hex: color.hex }
        : null,
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
        `SELECT id, product_id, group_id, name_en, name_ar, name_ckb, sort FROM product_option_values
          WHERE product_id IN (SELECT value FROM json_each(?1)) AND active = 1 AND merged_into IS NULL ORDER BY sort`
      )
      .bind(ids)
      .all<{ id: string; product_id: string; group_id: string; name_en: string; name_ar: string | null; name_ckb: string | null; sort: number }>(),
    db
      .prepare('SELECT id, product_id, name_en, name_ar, name_ckb, hex, sort FROM product_colors WHERE product_id IN (SELECT value FROM json_each(?1)) AND active = 1 ORDER BY sort')
      .bind(ids)
      .all<{ id: string; product_id: string; name_en: string; name_ar: string | null; name_ckb: string | null; hex: string; sort: number }>(),
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
      ...(doc.name_ckb ? { name_ckb: doc.name_ckb } : {}),
      image: coverOf(doc),
      family,
      from_price_iqd: doc.price_iqd,
      groups: g.map((grp) => ({
        id: grp.id,
        name: grp.name_en,
        values: (values.results ?? [])
          .filter((v) => v.group_id === grp.id)
          .map((v) => ({ id: v.id, label_ar: v.name_ar || v.name_en, label_en: v.name_en, ...(v.name_ckb ? { label_ckb: v.name_ckb } : {}) })),
      })),
      colors: (colors.results ?? [])
        .filter((c) => c.product_id === pid)
        .map((c) => ({ id: c.id, label_ar: c.name_ar || c.name_en, label_en: c.name_en, ...(c.name_ckb ? { label_ckb: c.name_ckb } : {}), hex: c.hex })),
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

// ================================================================= what a customer reads

/**
 * WHAT THE CUSTOMER'S WIZARD NEEDS TO ASK — never what an answer is worth
 * (DECISIONS row 220). The trade-in value is a price Levonis sets; its rules
 * (each factor's effect and weight, the floor and the cap, the resale view
 * and the per-product overrides) are the calculation behind that price, and
 * the owner's rule gives anyone but the owner the final figure alone. So the
 * customer is told which questions are on and the choices of the two
 * checklists, by id and label; the Worker values the answers.
 */
export interface TradeInQuestions {
  family: TradeInFamily;
  version: number;
  /** The factors the owner turned on: which questions the wizard shows. */
  asked: FactorId[];
  faults: Array<{ id: string; label_ar: string; label_en: string; label_ckb?: string }>;
  replaced_parts: Array<{ id: string; label_ar: string; label_en: string; label_ckb?: string }>;
}

export function publicQuestions(r: TradeInRuleSet): TradeInQuestions {
  // The Sorani of an item that still reads as seeded (DECISIONS row 183); an
  // item the owner wrote carries the owner's two languages.
  const choices = (factor: 'faults' | 'replaced_parts') =>
    checklistOf(r, factor).map(({ id, label_ar, label_en }) => {
      const label_ckb = checklistLabelCkb(label_ar);
      return label_ckb ? { id, label_ar, label_en, label_ckb } : { id, label_ar, label_en };
    });
  return {
    family: r.family,
    version: r.version,
    asked: r.factors.filter((f) => f.enabled).map((f) => f.factor),
    faults: choices('faults'),
    replaced_parts: choices('replaced_parts'),
  };
}

/** The estimate as a customer reads it: each part's final value, the total and the settlement — no line, floor or cap. */
export interface PublicEstimate {
  components: Array<{ role: ComponentRole; family: TradeInFamily; label_ar: string; label_en: string; value_iqd: number }>;
  total_iqd: number;
  settlement: TradeInSettlement | null;
  usage_months: number;
  warranty_remaining_months: number;
  computed_at: string;
}

export function publicEstimate(e: Estimate): PublicEstimate {
  return {
    components: e.components.map((c) => ({ role: c.role, family: c.family, label_ar: c.label_ar, label_en: c.label_en, value_iqd: c.valuation.value_iqd })),
    total_iqd: e.total_iqd,
    settlement: e.settlement,
    usage_months: e.usage_months,
    warranty_remaining_months: e.warranty_remaining_months,
    computed_at: e.computed_at,
  };
}

/**
 * HOW MANY FIGURES ONE CUSTOMER MAY ASK FOR (Services V2, trade-in G11).
 *
 * An estimate is a function of the answers, so a door that answers any set of
 * answers on demand recovers the owner's valuation rules one toggled answer at
 * a time (DECISIONS row 220). The door stays — a customer deserves to see the
 * figure before sending — but each answer is COUNTED, on the request and on
 * the account: 20 for one request, 60 across the account in any 24 hours.
 * A draft's own view carries no figure (`requestView`), so this is the only
 * door to a draft's estimate, and the limit cannot be stepped around by
 * saving answers and reading the draft back. The submitted request keeps the
 * estimate fixed at submit, as before.
 */
export const TRADE_IN_PREVIEW_PER_REQUEST = 20;
export const TRADE_IN_PREVIEW_PER_DAY = 60;
const PREVIEW_DAY_MS = 24 * 3600 * 1000;

/** Counted estimates on one request (the log lines `previewDraft` writes). */
export async function previewCount(db: D1Database, requestId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM trade_in_events WHERE request_id = ? AND action = 'preview'`)
    .bind(requestId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * THE WIZARD'S FIGURE, PRICED HERE AND COUNTED. The wizard posts the answers
 * so far (and the product it is looking at) when the customer asks for the
 * figure, and reads the final figures back. The answers are validated exactly
 * as `saveDraft` validates them, the target is re-priced for this customer by
 * the server, never taken from the client — and nothing about the request
 * changes. What is written is one log line (`action = 'preview'`, with the
 * total it answered, for the staff's eyes): the slot is taken by a single
 * conditional INSERT, so two presses at once cannot both slip under the
 * limit, and a refusal answers no figure at all.
 */
/** The customer's ONE figure for the old device (S-P2 spec §6.4) — no part value, no formula. */
export interface PreviewOffer {
  offer_iqd: number | null;
  no_offer_reason?: 'no_price_today' | 'below_minimum';
  now_price_iqd: number | null;
  target_price_iqd: number | null;
  difference_iqd: number | null;
  excess_iqd: number;
  pickup_fee_if_collected_iqd: number;
  valid_until_if_sent: string;
}

export async function previewDraft(
  env: Env,
  userId: string,
  id: string,
  body: { components?: unknown; target?: unknown }
): Promise<{ estimate: PublicEstimate; previews_left: number; offer?: PreviewOffer }> {
  const db = env.DB;
  const req = await ownRequest(db, userId, id);
  if (req.status !== 'draft') throw refuse('TRADE_IN_NOT_EDITABLE');
  const [comps, book] = await Promise.all([loadComponents(db, id), loadRuleBook(db)]);
  const raw = (body.components && typeof body.components === 'object' ? body.components : {}) as Record<string, unknown>;
  const errors: Record<string, string[]> = {};
  const answered = comps.map((c) => {
    if (raw[c.role] === undefined) return c;
    const checked = validateInputs(raw[c.role], book[c.family]);
    if (!checked.ok) {
      errors[c.role] = checked.errors;
      return c;
    }
    return { ...c, inputs_json: JSON.stringify(checked.value) };
  });
  if (Object.keys(errors).length) throw refuse('TRADE_IN_INPUTS_INVALID', { errors });
  let targetPrice = req.target_price_iqd;
  if (body.target !== undefined && body.target !== null) {
    const sel = parseTargetSelection(body.target);
    if (!sel) throw refuse('TRADE_IN_TARGET_UNAVAILABLE', { reason: 'selection' });
    targetPrice = (await priceTarget(env, userId, sel)).price_iqd;
  }
  const now = new Date();
  // Trade-in v2: the store-safe offer (owner decision 1). The old `estimate.total_iqd` key answers the
  // same figure (no part value) so a phone still holding the old wizard keeps working (§7.4).
  let offer: PreviewOffer | undefined;
  let estimate: PublicEstimate;
  if (await tradeInV2Installed(db)) {
    const nowIso = now.toISOString();
    const [unit, slot, policy] = await Promise.all([
      resolveUnit(env, userId, req.order_item_id, req.unit_index, nowIso),
      slotOf(db, req.order_item_id, req.unit_index),
      getSetting(db, 'tradeInPolicy'),
    ]);
    const o = await offerFor(env, {
      req,
      unit,
      comps: answered,
      book,
      phase: 'preview',
      inputsOf: (c) => storedInputs(answered.find((x) => x.role === c.role)?.inputs_json ?? '{}', book[c.family]),
      slotUnitIds: slot.unitIds,
      nowIso,
    });
    if (o.no_offer_reason === 'scope_unavailable') throw refuse('TRADE_IN_SCOPE_UNAVAILABLE');
    const s = targetPrice && o.offer_iqd !== null ? tradeInSettlement(targetPrice, o.offer_iqd) : null;
    offer = {
      offer_iqd: o.offer_iqd,
      ...(o.no_offer_reason ? { no_offer_reason: o.no_offer_reason } : {}),
      now_price_iqd: o.now_price_iqd,
      target_price_iqd: targetPrice ?? null,
      difference_iqd: s ? s.difference_iqd : targetPrice ?? null,
      excess_iqd: s ? s.excess_iqd : 0,
      pickup_fee_if_collected_iqd: policy.pickup_fee_iqd,
      valid_until_if_sent: new Date(now.getTime() + policy.offer_valid_days * DAY_MS).toISOString(),
    };
    estimate = {
      components: [],
      total_iqd: o.offer_iqd ?? 0,
      settlement: s,
      usage_months: o.usage_months,
      warranty_remaining_months: o.warranty_remaining_months,
      computed_at: nowIso,
    };
  } else {
    estimate = publicEstimate(estimateFor({ ...req, target_price_iqd: targetPrice }, answered, book, now.toISOString()).estimate);
  }

  const since = new Date(now.getTime() - PREVIEW_DAY_MS).toISOString();
  const taken = await db
    .prepare(
      `INSERT INTO trade_in_events (id, request_id, actor_id, actor_role, action, from_status, to_status, detail_json, created_at)
       SELECT ?1, ?2, ?3, 'customer', 'preview', NULL, NULL, ?4, ?5
        WHERE EXISTS (SELECT 1 FROM trade_in_requests WHERE id = ?2 AND user_id = ?3 AND status = 'draft')
          AND (SELECT COUNT(*) FROM trade_in_events WHERE request_id = ?2 AND action = 'preview') < ?6
          AND (SELECT COUNT(*) FROM trade_in_events
                WHERE request_id IN (SELECT id FROM trade_in_requests WHERE user_id = ?3)
                  AND action = 'preview' AND created_at > ?7) < ?8`
    )
    .bind(newId('tie'), id, userId, JSON.stringify(offer ? { offer_iqd: offer.offer_iqd } : { total_iqd: estimate.total_iqd }), now.toISOString(), TRADE_IN_PREVIEW_PER_REQUEST, since, TRADE_IN_PREVIEW_PER_DAY)
    .run();
  const used = await previewCount(db, id);
  if (!taken.meta?.changes) {
    // Which limit — so the screen can say «send it» or «tomorrow». The
    // request's own state is re-read too: a draft sent a moment ago is not a limit.
    const fresh = await ownRequest(db, userId, id);
    if (fresh.status !== 'draft') throw refuse('TRADE_IN_NOT_EDITABLE');
    throw refuse('TRADE_IN_PREVIEW_LIMIT', { scope: used >= TRADE_IN_PREVIEW_PER_REQUEST ? 'request' : 'day' });
  }
  return { estimate, previews_left: Math.max(0, TRADE_IN_PREVIEW_PER_REQUEST - used), ...(offer ? { offer } : {}) };
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

/**
 * HOW THE DEVICE REACHES THE SHOP (decision 2): in the store, or collected
 * (the policy's fee comes off the credit). While a draft, or sent and not yet
 * received — one conditional UPDATE; anything else is not editable.
 */
export async function setHandover(env: Env, userId: string, id: string, handover: 'store' | 'pickup'): Promise<void> {
  const db = env.DB;
  await ownRequest(db, userId, id);
  const policy = await getSetting(db, 'tradeInPolicy');
  const fee = handover === 'pickup' ? policy.pickup_fee_iqd : 0;
  const res = await db
    .prepare(
      `UPDATE trade_in_requests SET handover = ?3, pickup_fee_iqd = ?4, updated_at = ?5
        WHERE id = ?1 AND user_id = ?2 AND (status = 'draft' OR (status = 'submitted' AND intake_at IS NULL))`
    )
    .bind(id, userId, handover, fee, new Date().toISOString())
    .run();
  if (!res.meta?.changes) throw refuse('TRADE_IN_NOT_EDITABLE');
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
  // A v2 request (0192) also binds the hours answer to a photo of the hours screen and asks for a
  // damage close-up per ticked fault (G14); a v1 draft is not blocked by proofs it was never asked for.
  const v2 = (req.valuation_version ?? 1) >= 2;
  for (const c of comps) {
    const checked = validateInputs(safeParse(c.inputs_json, {}), book[c.family]);
    if (!checked.ok) inputs[c.role] = checked.errors;
    const mine = photos.filter((p) => p.component_role === c.role && (p.phase ?? 'customer') === 'customer');
    const m = missingPhotoAngles(c.family, mine.map((p) => p.angle));
    if (v2 && checked.ok) m.push(...missingProofs(c.family, checked.value, mine));
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
  if (Object.keys(blockers.photos).length) {
    const all = Object.values(blockers.photos).flat();
    const code: TradeInCode = all.some((x) => !x.startsWith('damage:') && x !== 'hours')
      ? 'TRADE_IN_PHOTOS_MISSING'
      : all.includes('hours')
        ? 'TRADE_IN_HOURS_PHOTO'
        : 'TRADE_IN_DAMAGE_PHOTO';
    throw refuse(code, { missing: blockers.photos });
  }
  if (blockers.target) throw refuse('TRADE_IN_TARGET_REQUIRED');
  // The target's price NOW, not when it was picked — the estimate the admin
  // reviews must be against today's figure.
  const priced = await priceTarget(env, userId, {
    product_id: req.target_product_id!,
    option_value_ids: safeParse<string[]>(req.target_option_value_ids, []),
    color_id: req.target_color_id,
  });
  if (await tradeInV2Installed(db)) return submitV2(env, req, comps, book, priced);
  const now = new Date().toISOString();
  const { estimate } = estimateFor({ ...req, target_price_iqd: priced.price_iqd }, comps, book, now);
  const token = randomToken(12);
  const slot = await slotOf(db, req.order_item_id, req.unit_index);
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
    serviceFence(db, id, slot),
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
    if (isAbort(e)) throw refuse((await serviceBlocker(db, slot)) ?? 'TRADE_IN_STALE');
    throw e;
  }
  return (await loadRequest(db, id))!;
}

/**
 * SEND A v2 REQUEST (spec §6.17-A): the ONE offer is computed here, by the
 * server, on today's public prices; the customer reads «حتى X» and has
 * `offer_valid_days` to hand the device in. No offer (no public price today,
 * or below the minimum) → TRADE_IN_NO_OFFER and the draft stays, with a
 * `no_offer` line for the desk. Per-part values are not stored for the customer
 * to read (G11): the owner's figures go to `trade_in_valuations`.
 */
async function submitV2(env: Env, req: RequestRow, comps: ComponentRow[], book: RuleBook, priced: PricedTarget): Promise<RequestRow> {
  const db = env.DB;
  const nowIso = new Date().toISOString();
  const [unit, slot, policy] = await Promise.all([
    resolveUnit(env, req.user_id, req.order_item_id, req.unit_index, nowIso),
    slotOf(db, req.order_item_id, req.unit_index),
    getSetting(db, 'tradeInPolicy'),
  ]);
  const o = await offerFor(env, {
    req,
    unit,
    comps,
    book,
    phase: 'submit',
    inputsOf: (c) => storedInputs(comps.find((x) => x.role === c.role)?.inputs_json ?? '{}', book[c.family]),
    slotUnitIds: slot.unitIds,
    nowIso,
  });
  if (o.no_offer_reason === 'scope_unavailable') throw refuse('TRADE_IN_SCOPE_UNAVAILABLE');
  if (o.offer_iqd === null) {
    // The desk sees «بلا عرض» (§16 D-1): one log line, outside any money batch.
    await eventStatement(db, req.id, { id: req.user_id, role: 'customer' }, 'no_offer', 'draft', 'draft', { reason: o.no_offer_reason }, nowIso)
      .run()
      .catch(() => undefined);
    throw refuse('TRADE_IN_NO_OFFER', { reason: o.no_offer_reason ?? 'below_minimum' });
  }
  const offer = o.offer_iqd;
  const expires = new Date(Date.parse(nowIso) + policy.offer_valid_days * DAY_MS).toISOString();
  const token = randomToken(12);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE trade_in_requests
            SET status = 'submitted', submitted_at = ?2, updated_at = ?2, decision_token = ?3, valuation_version = 2,
                target_price_iqd = ?4, target_snapshot_json = ?5, offer_iqd = ?6, offer_at = ?2, offer_expires_at = ?7,
                now_price_iqd = ?8, now_price_channel = ?9, paid_net_iqd = ?10, estimated_iqd = ?6, estimate_json = ?11, rule_versions_json = ?12
          WHERE id = ?1 AND status = 'draft'`
      )
      .bind(
        req.id, nowIso, token, priced.price_iqd, JSON.stringify(priced.snapshot), offer, expires,
        o.now_price_iqd, o.now_price_channel, o.paid_net_iqd, JSON.stringify({ offer_iqd: offer, computed_at: nowIso }), JSON.stringify(o.rule_versions)
      ),
    fence(db, req.id, token),
    serviceFence(db, req.id, slot),
    db.prepare(`UPDATE trade_in_components SET estimate_json = '{}', value_iqd = NULL WHERE request_id = ?`).bind(req.id),
    valuationStatement(db, req.id, o.owner, req.user_id, nowIso),
    eventStatement(db, req.id, { id: req.user_id, role: 'customer' }, 'submit', 'draft', 'submitted', { offer_iqd: offer, target_price_iqd: priced.price_iqd }, nowIso),
    notifyStatement(db, {
      userId: req.user_id,
      kind: 'trade_in',
      title_ar: 'استلمنا طلب الاستبدال',
      title_en: 'We received your trade-in request',
      body_ar: `عرضنا حتى ${iqdText(offer, 'ar')}. سلّم جهازك قبل ${dayText(expires)}.`,
      body_en: `Our offer is up to ${iqdText(offer, 'en')}. Hand in your device by ${dayText(expires)}.`,
      meta: {
        title_ckb: 'داواکاریی گۆڕینەوەکەت وەرگیرا',
        body_ckb: `پێشنیارەکەمان تا ${iqdText(offer, 'ckb')}ە. ئامێرەکەت پێش ${dayText(expires)} ڕادەست بکە.`,
      },
      link: requestPath(req.id),
      entity_type: 'trade_in',
      entity_id: req.id,
      eventKey: `trade_in:${req.id}:submitted`,
    }).stmt,
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isAbort(e)) throw refuse((await serviceBlocker(db, slot)) ?? 'TRADE_IN_STALE');
    throw e;
  }
  return (await loadRequest(db, req.id))!;
}

// ================================================================= transitions

export async function releaseStatements(db: D1Database, req: Pick<RequestRow, 'id'>): Promise<D1PreparedStatement[]> {
  const out = [db.prepare('DELETE FROM trade_in_claims WHERE request_id = ?').bind(req.id)];
  // The credit coupon, if one was minted, dies with the request.
  out.push(db.prepare('UPDATE coupons SET active = 0 WHERE trade_in_id = ? AND active = 1').bind(req.id));
  return out;
}

/**
 * The order that redeemed this request's credit, newest first — cancelled ones included.
 * `redemption_state` is the use itself: 'released' once a cancel gave it back
 * (migration 0191's trigger), still 'active' for an order cancelled before that.
 */
export async function creditOrders(db: D1Database, requestId: string) {
  const { results } = await db
    .prepare(
      `SELECT r.order_id, r.coupon_id, r.amount_iqd, r.state AS redemption_state, o.status, o.created_at, o.cancelled_at
         FROM coupons c
         JOIN coupon_redemptions r ON r.coupon_id = c.id
         JOIN orders o ON o.id = r.order_id
        WHERE c.trade_in_id = ?1
        ORDER BY r.created_at DESC`
    )
    .bind(requestId)
    .all<{
      order_id: string;
      coupon_id: string;
      amount_iqd: number;
      redemption_state: string;
      status: string;
      created_at: string;
      cancelled_at: string | null;
    }>();
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
    // The read above, asked again in the write: an order that spent the
    // credit between that read and this batch keeps the request (plan §1.3).
    noLiveCreditOrderFence(db, req.id),
    ...(await releaseStatements(db, req)),
    eventStatement(db, req.id, actor, 'cancel', req.status, 'cancelled', { reason }, now),
  ];
  // S-P2: the shop already holds the device — it goes back to its customer (no money moves).
  if (req.intake_at) stmts.push(deviceReadyNotice(db, req));
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
    if (isAbort(e)) {
      const spent = (await creditOrders(db, req.id)).find((o) => o.status !== 'cancelled');
      if (spent) throw refuse('TRADE_IN_ORDER_ACTIVE', { order_id: spent.order_id });
      throw refuse('TRADE_IN_STALE');
    }
    throw e;
  }
  return (await loadRequest(db, req.id))!;
}

/** «جهازك جاهز للاستلام من المتجر» — a received device whose request was cancelled or declined (S-P2 §6.12). */
export function deviceReadyNotice(db: D1Database, req: Pick<RequestRow, 'id' | 'user_id'>): D1PreparedStatement {
  return notifyStatement(db, {
    userId: req.user_id,
    kind: 'trade_in',
    title_ar: 'جهازك جاهز للاستلام من المتجر',
    title_en: 'Your device is ready to collect from the store',
    meta: { title_ckb: 'ئامێرەکەت ئامادەیە بۆ وەرگرتنەوە لە فرۆشگا' },
    link: requestPath(req.id),
    entity_type: 'trade_in',
    entity_id: req.id,
    eventKey: `trade_in:${req.id}:device_ready`,
  }).stmt;
}

/**
 * A LIVE ORDER HOLDS THE CREDIT → THE REQUEST STAYS (plan §1.3), inside the
 * batch that would cancel it: the request's status trips its NOT NULL when an
 * order that is not cancelled redeemed one of its credit coupons, so the
 * cancel, the released device and the retired coupon all roll back.
 */
export function noLiveCreditOrderFence(db: D1Database, requestId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE trade_in_requests SET status = CASE WHEN EXISTS (
          SELECT 1 FROM coupons c JOIN coupon_redemptions r ON r.coupon_id = c.id JOIN orders o ON o.id = r.order_id
           WHERE c.trade_in_id = ?1 AND o.status <> 'cancelled') THEN NULL ELSE status END
        WHERE id = ?1`
    )
    .bind(requestId);
}

/**
 * THE CREDIT IS STILL THE REQUEST'S, IN THE ORDER'S OWN WRITE (plan §1.3).
 *
 * `tradeInCouponCap` read the request before the checkout priced the cart. A
 * return or a cancel that lands between that read and the order batch cancels
 * the request, releases the device and retires the coupon — and the
 * redemption trigger counts uses only. So the checkout batch asks again, in
 * its own transaction: unless the request still awaits payment, on exactly
 * this coupon, for this customer, with the coupon still active, the request's
 * NOT NULL status trips and the whole order rolls back (nothing redeemed,
 * nothing ordered). It touches no column otherwise.
 *
 * ONE CREDIT PER REQUEST, ACROSS ITS COUPONS (row 237). Before migration 0191
 * «إتمام الدفع» could mint a second coupon after a cancel, and that cancelled
 * order could then be reopened while still holding the first: a live order
 * already carrying a use of ANOTHER coupon of this request trips the fence
 * too. (A use of this same coupon is the limit trigger's to refuse.) The
 * fence runs before this order's own redemption is inserted.
 */
export function tradeInCreditFence(db: D1Database, couponId: string, userId: string, v2 = false): D1PreparedStatement {
  // S-P2 (0192, decision 2): the device must have been received; and a COMPLETED request's credit is
  // spendable again only while a re-issue (row 237: a cancel or a return gave it back) is live.
  const spendable = v2
    ? `intake_at IS NOT NULL AND (status = 'awaiting_payment'
         OR (status = 'completed' AND EXISTS (SELECT 1 FROM trade_in_credit_reissues x
                                               WHERE x.request_id = trade_in_requests.id AND x.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))))`
    : `status = 'awaiting_payment'`;
  return db
    .prepare(
      `UPDATE trade_in_requests
          SET status = CASE WHEN ${spendable} AND coupon_id = ?1 AND user_id = ?2
                             AND EXISTS (SELECT 1 FROM coupons c WHERE c.id = ?1 AND c.active = 1 AND c.trade_in_id = trade_in_requests.id)
                             AND NOT EXISTS (SELECT 1 FROM coupons c2
                                               JOIN coupon_redemptions r ON r.coupon_id = c2.id
                                               JOIN orders o ON o.id = r.order_id
                                              WHERE c2.trade_in_id = trade_in_requests.id AND c2.id <> ?1
                                                AND r.state = 'active' AND o.status <> 'cancelled')
                            THEN status ELSE NULL END
        WHERE id = (SELECT trade_in_id FROM coupons WHERE id = ?1)`
    )
    .bind(couponId, userId);
}

/** Whether a failed order batch was refused by `tradeInCreditFence`. */
export const isTradeInCreditFenceAbort = (e: unknown): boolean =>
  /NOT NULL constraint failed: trade_in_requests\.status/i.test(e instanceof Error ? e.message : String(e));

/** Price protection on one line, as the trade-in valuation reads it. */
interface LineProtection {
  /** A claim is still being decided: no trade-in until it is. */
  open: boolean;
  /** Each credited claim: its credit per covered unit, and the units it covered (null: every unit). */
  credits: Array<{ perUnit: number; units: ReadonlySet<number> | null }>;
}

/**
 * The protection on each line, claim by claim (review F7). A claim decided
 * since S-P0 records how many units it credited (`covered_qty`) and, when a
 * unit was in a trade-in, which units (`covered_unit_indexes`); an older one
 * is spread over the units it was filed for (`qty`), on every unit.
 */
function protectionByLine(rows: ReadonlyArray<{ order_item_id: string; state: string; credited_iqd: number | null; qty: number | null; covered_qty: number | null; covered_units: string | null }>): Map<string, LineProtection> {
  const out = new Map<string, LineProtection>();
  for (const r of rows) {
    const e = out.get(r.order_item_id) ?? { open: false, credits: [] };
    if (r.state === 'requested' || r.state === 'approved') e.open = true;
    const credited = Math.max(0, Number(r.credited_iqd) || 0);
    if ((r.state === 'approved' || r.state === 'credited') && credited > 0) {
      const listed = safeParse<unknown[] | null>(r.covered_units, null);
      const units = Array.isArray(listed) ? new Set(listed.map((x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0)) : null;
      const over = Math.max(1, Math.trunc(Number(r.covered_qty) || 0) || Math.trunc(Number(r.qty) || 0) || 1);
      e.credits.push({ perUnit: Math.ceil(credited / over), units: units && units.size ? units : null });
    }
    out.set(r.order_item_id, e);
  }
  return out;
}

/** What unit `unitIndex` of a line received in protection credits. */
function protectionDeduction(pp: LineProtection | undefined, unitIndex: number): number {
  let total = 0;
  for (const c of pp?.credits ?? []) if (!c.units || c.units.has(unitIndex)) total += c.perUnit;
  return total;
}

/** A trade-in holding units of one line, as the return door sees it (plan §1.3). */
export interface LineTradeIn {
  request: RequestRow;
  /** The devices of every slot it claims (each unit and its warranty replacements). */
  unitIds: string[];
  /** Slots claimed on the line. */
  units: number;
  /** A live (not cancelled) order spent its credit, or it is complete: the device is no longer just the customer's. */
  committed: boolean;
}

/**
 * Whether this database carries the trade-in tables (0143). The return and
 * price-protection doors ask about trade-ins on every money act, and code can
 * run ahead of its migrations (a redeploy of an older database): without the
 * tables there is no trade-in to fence against, and nothing must 500.
 */
export async function tradeInInstalled(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT 1 FROM trade_in_claims LIMIT 0').all();
    return true;
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
}

/**
 * The units of a line a trade-in holds (draft to complete), in SQL with ONE
 * positional parameter (the line id): each slot counts once, whatever part
 * was claimed. A database without the trade-in tables holds none.
 */
export const tradedUnitsSql = (installed: boolean) =>
  installed
    ? '(SELECT COUNT(DISTINCT unit_index) FROM trade_in_claims WHERE order_item_id = ?)'
    : 'COALESCE((SELECT 0 WHERE ? IS NOT NULL), 0)';

/** Every trade-in holding a unit of `orderItemId` (its claim rows exist only while it is live or complete). */
export async function tradeInsOnLine(db: D1Database, orderItemId: string): Promise<LineTradeIn[]> {
  if (!(await tradeInInstalled(db))) return [];
  const { results } = await db
    .prepare('SELECT DISTINCT request_id, unit_index FROM trade_in_claims WHERE order_item_id = ?')
    .bind(orderItemId)
    .all<{ request_id: string; unit_index: number }>();
  const byRequest = new Map<string, number[]>();
  for (const r of results ?? []) {
    const list = byRequest.get(r.request_id) ?? [];
    if (!list.includes(Number(r.unit_index))) list.push(Number(r.unit_index));
    byRequest.set(r.request_id, list);
  }
  const out: LineTradeIn[] = [];
  for (const [id, indexes] of byRequest) {
    const request = await loadRequest(db, id);
    if (!request) continue;
    const live = (await creditOrders(db, id)).some((o) => o.status !== 'cancelled');
    const unitIds = (await Promise.all(indexes.map((i) => slotOf(db, orderItemId, i)))).flatMap((s) => s.unitIds);
    out.push({
      request,
      unitIds,
      units: indexes.length,
      // S-P2 (§1.3, «after intake ✗ everything»): a device the shop has received is no longer the
      // customer's to return either — the return door answers TRADE_IN_ACTIVE.
      committed: live || isTerminal(request.status) || !canTransition(request.status, 'cancelled') || !!request.intake_at,
    });
  }
  return out;
}

/**
 * THE RETURN WINS (plan §1.3: «Trade-in submitted, before intake → Return ✓
 * the return wins; the trade-in is cancelled»). The statements that cancel a
 * trade-in, in the SAME batch as the return case the customer is opening:
 * fenced on the status read, and on no live order holding its credit — a
 * credit spent in the meantime aborts the whole batch (no case, no cancel).
 * The credit coupon dies with the request (`releaseStatements`); the customer
 * is told in their language.
 */
export async function returnWinsStatements(db: D1Database, req: RequestRow, actorUserId: string, returnCaseId: string, now: string): Promise<D1PreparedStatement[]> {
  const token = randomToken(12);
  return [
    db
      .prepare(
        `UPDATE trade_in_requests
            SET status = 'cancelled', cancelled_at = ?2, updated_at = ?2, cancel_reason = '', cancelled_by = ?3, decision_token = ?4
          WHERE id = ?1 AND status = ?5`
      )
      .bind(req.id, now, actorUserId, token, req.status),
    fence(db, req.id, token),
    noLiveCreditOrderFence(db, req.id),
    ...(await releaseStatements(db, req)),
    eventStatement(db, req.id, { id: actorUserId, role: 'customer' }, 'cancel', req.status, 'cancelled', { reason: 'return_opened', return_case_id: returnCaseId }, now),
    notifyStatement(db, {
      userId: req.user_id,
      kind: 'trade_in',
      title_ar: 'أُلغي طلب الاستبدال',
      title_en: 'Your trade-in request was cancelled',
      body_ar: 'فتحت طلب إرجاع لهذا الجهاز، فأُلغي طلب استبداله.',
      body_en: 'You opened a return for this device, so its trade-in request was cancelled.',
      meta: {
        title_ckb: 'داواکاریی گۆڕینەوەکەت هەڵوەشێندرایەوە',
        body_ckb: 'داواکاریی گەڕاندنەوەت بۆ ئەم ئامێرە کردەوە، بۆیە داواکاریی گۆڕینەوەکەی هەڵوەشێندرایەوە.',
      },
      link: requestPath(req.id),
      entity_type: 'trade_in',
      entity_id: req.id,
      eventKey: `trade_in:${req.id}:cancelled`,
    }).stmt,
  ];
}

export async function markInspected(env: Env, req: RequestRow, adminId: string): Promise<RequestRow> {
  const db = env.DB;
  // S-P2: «بدأ الفحص» was a label; the device is now received for real at intake (serial, hours,
  // findings). The old door stays mounted so a cached desk tab reads a sentence, not a 404.
  if (await tradeInV2Installed(db)) throw refuse('TRADE_IN_INTAKE_REQUIRED');
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
 *
 * IT ENDS (owner decision 2, row 223): `ends_at` is seven days after it is
 * minted (`TRADE_IN_CREDIT_VALID_DAYS`), and `validateCoupon` refuses it
 * after that. A fixed dinar credit held for months ages with the device and
 * the prices it was computed from.
 *
 * IT IS THE REQUEST'S ONE COUPON, FOR LIFE (row 237, migration 0191's
 * `trg_trade_in_one_credit`): it is minted once, in `fixValue`. When an order
 * that spent it is cancelled the same coupon comes back with the same code,
 * and its end moves by exactly the time that order held it (the cancel
 * trigger, or `checkoutCredit` for an order cancelled before 0191).
 */
function couponStatement(db: D1Database, req: RequestRow, credit: number, couponId: string, code: string, now: string, endsAt: string | null): D1PreparedStatement {
  const optionIds = safeParse<string[]>(req.target_option_value_ids, []);
  return db
    .prepare(
      `INSERT INTO coupons (id, code, tier_required, kind, value, min_total_iqd, max_global, max_per_user, active, created_at,
          assigned_user_id, scope, product_id, option_value_id, color_id, fulfillment_types, applies_to, cap_scope, max_quantity, stacks, trade_in_id, ends_at)
       VALUES (?1, ?2, NULL, 'fixed_iqd', ?3, 0, 1, 1, 1, ?4, ?5, 'product', ?6, ?7, ?8, '["direct_sale"]', 'merchandise', 'per_order', 1, 0, ?9, ?10)`
    )
    .bind(couponId, code, credit, now, req.user_id, req.target_product_id, optionIds[0] ?? null, req.target_color_id, req.id, endsAt);
}

/** «2026-10-21» — the credit's last day, as the notification states it in every language. */
export const dayText = (iso: string) => iso.slice(0, 10);

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
  step: {
    via: 'admin' | 'web' | 'telegram';
    actor: { id: string; role: 'customer' | 'admin' };
    passThrough: 'approved_as_estimated' | 'customer_accepted';
    /** The money authority the admin acted under (worker/lib/moneyAuthority.ts), for the audit row. */
    grant?: MoneyGrant;
  }
): Promise<RequestRow> {
  const db = env.DB;
  const v2 = await tradeInV2Installed(db);
  // Decision 2 (S-P2): no value is fixed, and no credit minted, before the device is in the shop.
  // The desk hears what to do; a customer accepting a proposal made on photos before S-P2 hears why.
  if (v2 && !req.intake_at) throw refuse(step.actor.role === 'admin' ? 'TRADE_IN_INTAKE_REQUIRED' : 'TRADE_IN_DEVICE_NOT_RECEIVED');
  const priced = await priceTarget(env, req.user_id, {
    product_id: req.target_product_id ?? '',
    option_value_ids: safeParse<string[]>(req.target_option_value_ids, []),
    color_id: req.target_color_id,
  });
  const policy = v2 ? await getSetting(db, 'tradeInPolicy') : null;
  // v2: the collection fee comes off the credit (decision 2); the excess is never paid out.
  const s = v2 ? offerSettlement(priced.price_iqd, value, req.pickup_fee_iqd ?? 0) : tradeInSettlement(priced.price_iqd, value);
  const now = new Date().toISOString();
  const token = randomToken(12);
  // THE ONE COUPON FOR LIFE (row 237): a credit minted on photos before S-P2 and re-valued at
  // intake comes back on the SAME row (same code), re-targeted and re-dated; else one is minted.
  const reuse = v2 && !!req.coupon_id;
  const couponId = reuse ? req.coupon_id : s.credit_iqd > 0 ? newId('cpn') : null;
  const code = couponId && !reuse ? couponCode() : null;
  const validDays = policy?.credit_valid_days ?? TRADE_IN_CREDIT_VALID_DAYS;
  const endsAt = new Date(Date.parse(now) + validDays * DAY_MS).toISOString();
  const until = s.credit_iqd > 0
    ? {
        ar: ` الرصيد صالح حتى ${dayText(endsAt)}.`,
        en: ` The credit is valid until ${dayText(endsAt)}.`,
        ckb: ` باڵانسەکە تا ${dayText(endsAt)} بەردەوامە.`,
      }
    : { ar: '', en: '', ckb: '' };
  const slot = await slotOf(db, req.order_item_id, req.unit_index);
  const from = req.status;
  const optionIds = safeParse<string[]>(req.target_option_value_ids, []);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE trade_in_requests
            SET status = 'awaiting_payment', final_value_iqd = ?2, credit_iqd = ?3, difference_iqd = ?4,
                target_price_iqd = ?5, target_snapshot_json = ?6, coupon_id = ?7, decided_at = ?8, updated_at = ?8,
                decided_via = ?9, decision_token = ?10
          WHERE id = ?1 AND status = ?11 AND offer_no = ?12${v2 ? ' AND intake_at IS NOT NULL' : ''}`
      )
      .bind(req.id, s.trade_in_value_iqd, s.credit_iqd, s.difference_iqd, s.target_price_iqd, JSON.stringify(priced.snapshot), couponId, now, step.via, token, from, req.offer_no),
    fence(db, req.id, token),
    // No credit for a device that went to the repair desk, whose price is
    // being compensated, or that a return is bringing back (plan §1.3).
    serviceFence(db, req.id, slot),
    eventStatement(db, req.id, step.actor, step.passThrough === 'approved_as_estimated' ? 'approve' : 'accept', from, step.passThrough, { value_iqd: value, via: step.via }, now),
    eventStatement(db, req.id, { id: null, role: 'system' }, 'awaiting_payment', step.passThrough, 'awaiting_payment', { ...s, ends_at: s.credit_iqd > 0 ? endsAt : null }, now),
    ...(reuse
      ? [
          db
            .prepare(
              `UPDATE coupons SET value = ?3, active = CASE WHEN ?3 > 0 THEN 1 ELSE 0 END, ends_at = ?4, product_id = ?5, option_value_id = ?6, color_id = ?7
                WHERE id = ?1 AND trade_in_id = ?2`
            )
            .bind(req.coupon_id, req.id, s.credit_iqd, endsAt, req.target_product_id, optionIds[0] ?? null, req.target_color_id),
        ]
      : couponId && code
        ? [couponStatement(db, req, s.credit_iqd, couponId, code, now, endsAt)]
        : []),
    notifyStatement(db, {
      userId: req.user_id,
      kind: 'trade_in',
      title_ar: v2 && s.credit_iqd > 0 ? `رصيد الاستبدال جاهز حتى ${dayText(endsAt)}` : 'ثُبّتت قيمة الاستبدال — أكمل الدفع',
      title_en: v2 && s.credit_iqd > 0 ? `Your trade-in credit is ready until ${dayText(endsAt)}` : 'Your trade-in value is fixed — complete the payment',
      body_ar: `قيمة جهازك ${iqdText(s.trade_in_value_iqd, 'ar')}. المطلوب للجهاز الجديد ${iqdText(s.difference_iqd, 'ar')} + التوصيل.${until.ar}`,
      body_en: `Your device is worth ${iqdText(s.trade_in_value_iqd, 'en')}. You pay ${iqdText(s.difference_iqd, 'en')} for the new device, plus delivery.${until.en}`,
      meta: {
        title_ckb: v2 && s.credit_iqd > 0 ? `باڵانسی گۆڕینەوەکەت تا ${dayText(endsAt)} ئامادەیە` : 'بەهای گۆڕینەوە جێگیر کرا — پارەدان تەواو بکە',
        body_ckb: `بەهای ئامێرەکەت ${iqdText(s.trade_in_value_iqd, 'ckb')}. بۆ ئامێرە نوێیەکە ${iqdText(s.difference_iqd, 'ckb')} دەدەیت، لەگەڵ کرێی گەیاندن.${until.ckb}`,
      },
      link: requestPath(req.id),
      entity_type: 'trade_in',
      entity_id: req.id,
      eventKey: `trade_in:${req.id}:fixed`,
    }).stmt,
  ];
  if (step.actor.role === 'admin') {
    stmts.push(...(await auditStatements(db, step.actor.id, 'trade_in.approve', req.id, { value_iqd: value, ...s, authority: step.grant?.audit ?? null })).statements);
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    // 0191's trg_trade_in_one_credit (a second credit coupon for this request) is an
    // invariant no path reaches — a request mints once — and reads as the stale answer if it ever does.
    if (isAbort(e) || /TRADE_IN_CREDIT_EXISTS/.test(e instanceof Error ? e.message : String(e))) {
      const now2 = await loadRequest(db, req.id);
      if (now2 && now2.offer_no !== req.offer_no) throw refuse('TRADE_IN_OFFER_STALE');
      throw refuse((await serviceBlocker(db, slot)) ?? 'TRADE_IN_STALE');
    }
    throw e;
  }
  return (await loadRequest(db, req.id))!;
}

/** The customer's line when the desk proposes the ceiling after intake (the owner may type another). */
export const INTAKE_REASON = 'بعد فحص الجهاز في المتجر';

/**
 * «اعتماد» (decision 3). Before S-P2: the submit-time estimate is fixed. v2: the device must have been
 * received (TRADE_IN_INTAKE_REQUIRED); the figure is the server's ceiling from intake. When it equals
 * the reference (the offer, or the legacy figure) the value is fixed and the credit minted; when it is
 * lower the customer is asked (`changeValue`), with the owner's line or «بعد فحص الجهاز في المتجر».
 */
export async function approveEstimate(env: Env, req: RequestRow, adminId: string, grant?: MoneyGrant, reason = ''): Promise<RequestRow> {
  if (await tradeInV2Installed(env.DB)) {
    if (!req.intake_at) throw refuse('TRADE_IN_INTAKE_REQUIRED');
    if (!canTransition(req.status, 'approved_as_estimated')) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
    const ceiling = approvalCeiling(req);
    if (ceiling < referenceOf(req)) return changeValue(env, req, adminId, ceiling, reason.trim() || INTAKE_REASON, grant);
    return fixValue(env, req, ceiling, { via: 'admin', actor: { id: adminId, role: 'admin' }, passThrough: 'approved_as_estimated', grant });
  }
  if (!canTransition(req.status, 'approved_as_estimated')) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  if (req.estimated_iqd === null) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  return fixValue(env, req, req.estimated_iqd, { via: 'admin', actor: { id: adminId, role: 'admin' }, passThrough: 'approved_as_estimated', grant });
}

export const TRADE_IN_VALUE_MAX_IQD = 1_000_000_000;

/**
 * «تغييره يدوياً مع سبب اختياري» — a new value the customer must accept or
 * decline. `offer_no` moves with it, so a decision always names the value it
 * answers. The in-app row rides in the batch; email, WhatsApp and the
 * Telegram buttons follow (`notifyCustomerOfValue`).
 */
export async function changeValue(
  env: Env,
  req: RequestRow,
  adminId: string,
  value: number,
  reason: string,
  grant?: MoneyGrant,
  /** S-P2: the owner's record of a value above the ceiling (`trade_in_valuations`, phase 'override'). */
  override?: ValuationDraft | null
): Promise<RequestRow> {
  const db = env.DB;
  if (!Number.isSafeInteger(value) || value < 0 || value > TRADE_IN_VALUE_MAX_IQD) throw refuse('TRADE_IN_INVALID_VALUE');
  const v2 = await tradeInV2Installed(db);
  // Decision 2: the value is judged on the device in the shop. A credit fixed on photos before S-P2 is
  // re-valued by the intake itself (worker/lib/tradeInIntake.ts), never by this door.
  if (v2 && !req.intake_at) throw refuse('TRADE_IN_INTAKE_REQUIRED');
  if (req.status === 'awaiting_payment' || !canTransition(req.status, 'value_changed')) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  const now = new Date().toISOString();
  const token = randomToken(12);
  const slot = await slotOf(db, req.order_item_id, req.unit_index);
  const offer = req.offer_no + 1;
  const est = req.offer_iqd ?? req.estimated_iqd ?? 0;
  const s = settlementOf(req, value);
  const above = grant?.above_ceiling === true;
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE trade_in_requests
              SET status = 'value_changed', admin_value_iqd = ?2, admin_reason = ?3, offer_no = ?4, valued_at = ?5, updated_at = ?5,
                  decision_token = ?6, tg_chat_id = NULL, tg_message_id = NULL${v2 ? ', above_ceiling = ?9' : ''}
            WHERE id = ?1 AND status = ?7 AND offer_no = ?8${v2 ? ' AND intake_at IS NOT NULL' : ''}`
        )
        .bind(req.id, value, reason, offer, now, token, req.status, req.offer_no, ...(v2 ? [above ? 1 : 0] : [])),
      fence(db, req.id, token),
      serviceFence(db, req.id, slot),
      ...(v2 && override ? [valuationStatement(db, req.id, { ...override, phase: 'override' }, adminId, now)] : []),
      eventStatement(db, req.id, { id: adminId, role: 'admin' }, 'change_value', req.status, 'value_changed', { value_iqd: value, estimated_iqd: est, reason, offer_no: offer, above_estimate: above }, now),
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
      ...(await auditStatements(db, adminId, 'trade_in.change_value', req.id, { value_iqd: value, estimated_iqd: est, reason, offer_no: offer, authority: grant?.audit ?? null })).statements,
    ]);
  } catch (e) {
    if (isAbort(e)) {
      const again = await loadRequest(db, req.id);
      if (again && again.offer_no !== req.offer_no) throw refuse('TRADE_IN_OFFER_STALE');
      throw refuse((await serviceBlocker(db, slot)) ?? 'TRADE_IN_STALE');
    }
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
      ...(req.intake_at ? [deviceReadyNotice(db, req)] : []),
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
 * «إتمام الدفع» — the coupon the checkout will redeem: the credit's ONE coupon
 * (row 237). Refuses when a live order already carries the credit (the
 * customer is sent to that order). Never mints: a cancelled order gives the
 * same coupon back, and its end moves by the time that order held it.
 *
 * A cancel since migration 0191 already released the use and moved the end
 * (`trg_orders_coupon_released`), so this only answers the code. An order
 * cancelled BEFORE 0191 (or on a database without that trigger) still holds
 * its use: this releases it here, once — every write is conditional on the
 * use still being 'active' and the order still being cancelled, so two
 * presses at the same moment release once and extend once (the end is
 * assigned, never added to).
 */
export async function checkoutCredit(
  env: Env,
  req: RequestRow
): Promise<{ code: string | null; order_id: string | null; any_device?: boolean; ends_at?: string | null }> {
  const db = env.DB;
  const v2 = await tradeInV2Installed(db);
  if (v2 && req.status === 'completed') return reissuedCredit(db, req);
  if (req.status !== 'awaiting_payment') throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  // Decision 2 (0192): the credit is spent once the shop holds the old device.
  if (v2 && !req.intake_at) throw refuse('TRADE_IN_DEVICE_NOT_RECEIVED');
  const orders = await creditOrders(db, req.id);
  const live = orders.find((o) => o.status !== 'cancelled');
  if (live) return { code: null, order_id: live.order_id };
  if (!req.credit_iqd || !req.coupon_id) return { code: null, order_id: null };
  const current = await db
    .prepare('SELECT id, code, active, ends_at FROM coupons WHERE id = ? AND trade_in_id = ?')
    .bind(req.coupon_id, req.id)
    .first<{ id: string; code: string; active: number; ends_at: string | null }>();
  if (!current || current.active !== 1) throw refuse('TRADE_IN_COUPON_MISMATCH');
  // A cancelled order that still holds the use: cancelled before 0191.
  const held = orders.find((o) => o.coupon_id === current.id && o.status === 'cancelled' && o.redemption_state === 'active') ?? null;
  const nowMs = Date.now();
  const endsAt = creditEndsAt(current.ends_at, held, nowMs);
  if (creditExpired(endsAt, nowMs)) throw refuse('TRADE_IN_CREDIT_EXPIRED');
  if (held) {
    const now = new Date(nowMs).toISOString();
    // ?1 coupon, ?2 the cancelled order — the use is still spent and the order still cancelled.
    const stillHeld = `EXISTS (SELECT 1 FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id
                                WHERE r.order_id = ?2 AND r.coupon_id = ?1 AND r.state = 'active' AND o.status = 'cancelled')`;
    await db.batch([
      db.prepare(`UPDATE coupons SET ends_at = ?3 WHERE id = ?1 AND ?3 IS NOT NULL AND ${stillHeld}`).bind(current.id, held.order_id, endsAt),
      db
        .prepare(
          `INSERT INTO trade_in_events (id, request_id, actor_id, actor_role, action, from_status, to_status, detail_json, created_at)
           SELECT ?3, ?4, NULL, 'system', 'credit_restored', 'awaiting_payment', 'awaiting_payment', ?5, ?6 WHERE ${stillHeld}`
        )
        .bind(
          current.id,
          held.order_id,
          newId('tie'),
          req.id,
          JSON.stringify({ order_id: held.order_id, coupon_id: current.id, ends_at: endsAt, via: 'checkout' }),
          now
        ),
      db
        .prepare(`UPDATE coupon_redemptions SET state = 'released', released_at = ?3 WHERE order_id = ?2 AND coupon_id = ?1 AND state = 'active' AND ${stillHeld}`)
        .bind(current.id, held.order_id, now),
    ]);
  }
  return { code: current.code, order_id: null };
}

/**
 * A COMPLETED REQUEST'S CREDIT, GIVEN BACK (row 237, S-P2 §6.9): the order it bought was cancelled
 * before delivery, or the new device was returned. The SAME coupon (same code) is live for 30 days
 * on any device sold directly; «إتمام الدفع» answers its code, no target (the customer chooses).
 */
async function reissuedCredit(db: D1Database, req: RequestRow): Promise<{ code: string | null; order_id: string | null; any_device: boolean; ends_at: string | null }> {
  const reissue = await liveReissue(db, req.id);
  if (!reissue || !req.coupon_id) throw refuse('TRADE_IN_BAD_STATE', { status: req.status });
  if (!req.intake_at) throw refuse('TRADE_IN_DEVICE_NOT_RECEIVED');
  const live = (await creditOrders(db, req.id)).find((o) => o.status !== 'cancelled' && o.redemption_state === 'active');
  if (live) return { code: null, order_id: live.order_id, any_device: true, ends_at: null };
  const coupon = await db
    .prepare('SELECT code, active, ends_at FROM coupons WHERE id = ? AND trade_in_id = ?')
    .bind(req.coupon_id, req.id)
    .first<{ code: string; active: number; ends_at: string | null }>();
  if (!coupon || coupon.active !== 1) throw refuse('TRADE_IN_COUPON_MISMATCH');
  if (creditExpired(coupon.ends_at, Date.now())) throw refuse('TRADE_IN_CREDIT_EXPIRED');
  return { code: coupon.code, order_id: null, any_device: true, ends_at: coupon.ends_at ?? reissue.ends_at };
}

export interface CustodyPlan {
  unitId: string | null;
  statements: D1PreparedStatement[];
}

/** The live unit of the request's slot and who else holds it, or null for an AMS-only trade-in. */
export async function custodyTarget(db: D1Database, req: RequestRow) {
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
export async function custodyStatements(env: Env, req: RequestRow, adminId: string | null, now: string): Promise<CustodyPlan> {
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
  // S-P2: completion books the device into stock and waits for the new order's delivery
  // (worker/lib/tradeInStock.ts). Before 0192 the manual act below stands.
  if (await tradeInV2Installed(db)) {
    const { completeManually } = await import('./tradeInStock');
    return completeManually(env, req, adminId);
  }
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

export interface TradeInCapLine {
  /** The order line's id (the checkout's `ComputedLine.id`, which becomes `order_items.id`). */
  id?: string;
  product_id: string;
  option_value_ids?: readonly string[];
  color_id?: string | null;
  unit: number;
  pricing_basis?: string;
  gift?: unknown;
}

const DEVICE_FAMILIES: ReadonlySet<TradeInFamily> = new Set<TradeInFamily>(['fdm', 'resin', 'laser', 'ams']);

/** A credit given back (row 237) is still live on this request (0192; none on an older database). */
async function liveReissue(db: D1Database, requestId: string): Promise<{ ends_at: string } | null> {
  try {
    return (
      (await db
        .prepare(`SELECT ends_at FROM trade_in_credit_reissues WHERE request_id = ? AND ends_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY ends_at DESC LIMIT 1`)
        .bind(requestId)
        .first<{ ends_at: string }>()) ?? null
    );
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

/**
 * THE CHECKOUT'S TRADE-IN RULE — called from computeCheckout's coupon block.
 *
 * null      the coupon is not a trade-in credit; nothing changes.
 * an answer the most this coupon may take off — ONE unit of the line it pays
 *           for — and that line's id (frozen as `coupon_snapshot.trade_in_line_id`).
 * throws    the coupon IS a trade-in credit and this cart cannot use it:
 *   - another customer, or a request that no longer holds it → TRADE_IN_COUPON_MISMATCH;
 *   - the shop has not received the old device (0192, decision 2) → TRADE_IN_DEVICE_NOT_RECEIVED;
 *   - awaiting payment: no direct-sale line of the target product and model → MISMATCH;
 *   - completed with a credit given back (row 237, a cancel or a return): the
 *     credit buys ANY device sold directly — the most expensive non-gift direct
 *     FDM / resin / laser / AMS line of the cart; none → MISMATCH.
 */
export async function tradeInCouponLine(
  db: D1Database,
  userId: string,
  couponId: string,
  lines: ReadonlyArray<TradeInCapLine>
): Promise<{ cap: number; lineId: string | null; anyDevice: boolean } | null> {
  type Row = {
    trade_in_id: string | null;
    assigned_user_id: string | null;
    product_id: string | null;
    option_value_id: string | null;
    color_id: string | null;
    status: string | null;
    user_id: string | null;
    coupon_id: string | null;
    /** Absent on a database without 0192 (the v1 rule); null = the device was not received. */
    intake_at?: string | null;
  };
  const head = 'SELECT c.trade_in_id, c.assigned_user_id, c.product_id, c.option_value_id, c.color_id, r.status, r.user_id, r.coupon_id';
  const tail = 'FROM coupons c LEFT JOIN trade_in_requests r ON r.id = c.trade_in_id WHERE c.id = ?';
  let c: Row | null;
  try {
    c = await db.prepare(`${head}, r.intake_at ${tail}`).bind(couponId).first<Row>();
  } catch (e) {
    if (!/no such column/i.test(e instanceof Error ? e.message : String(e))) throw e;
    c = await db.prepare(`${head} ${tail}`).bind(couponId).first<Row>();
  }
  if (!c || !c.trade_in_id) return null;
  if (c.user_id !== userId || c.assigned_user_id !== userId || c.coupon_id !== couponId) throw refuse('TRADE_IN_COUPON_MISMATCH');
  if (c.status !== 'awaiting_payment' && c.status !== 'completed') throw refuse('TRADE_IN_COUPON_MISMATCH');
  if (c.intake_at === null) throw refuse('TRADE_IN_DEVICE_NOT_RECEIVED');
  const bought = (l: TradeInCapLine) => !l.gift && (l.pricing_basis === undefined || l.pricing_basis === 'direct');
  if (c.status === 'awaiting_payment') {
    const line = lines.find(
      (l) =>
        // A gift line (0175, S8) is never the bought target: its 0 IQD would cap
        // the credit at nothing, and a product given free earns no trade-in.
        bought(l) &&
        l.product_id === c!.product_id &&
        (!c!.option_value_id || (l.option_value_ids ?? []).includes(c!.option_value_id)) &&
        (!c!.color_id || l.color_id === c!.color_id)
    );
    if (!line) throw refuse('TRADE_IN_COUPON_MISMATCH');
    return { cap: Math.max(0, Math.trunc(line.unit)), lineId: line.id ?? null, anyDevice: false };
  }
  // A completed request: only a live re-issue makes its credit spendable again (0192 only).
  if (c.intake_at === undefined || !(await liveReissue(db, c.trade_in_id))) throw refuse('TRADE_IN_COUPON_MISMATCH');
  const candidates = lines.filter(bought);
  if (!candidates.length) throw refuse('TRADE_IN_COUPON_MISMATCH');
  const ids = [...new Set(candidates.map((l) => l.product_id))];
  const [idx, rows] = await Promise.all([
    catalogIndexFor(db),
    db
      .prepare('SELECT id, template_family, category_id, sub_category_id, name, name_ar FROM products WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids))
      .all<{ id: string; template_family: string | null; category_id: string | null; sub_category_id: string | null; name: string | null; name_ar: string | null }>(),
  ]);
  const device = new Set((rows.results ?? []).filter((r) => DEVICE_FAMILIES.has(familyOfProduct(r, idx) as TradeInFamily)).map((r) => r.id));
  const best = candidates.filter((l) => device.has(l.product_id)).sort((a, b) => Math.trunc(b.unit) - Math.trunc(a.unit))[0];
  if (!best) throw refuse('TRADE_IN_COUPON_MISMATCH');
  return { cap: Math.max(0, Math.trunc(best.unit)), lineId: best.id ?? null, anyDevice: true };
}

/** `tradeInCouponLine`'s figure alone (the most this credit may take off this cart), or null. */
export async function tradeInCouponCap(db: D1Database, userId: string, couponId: string, lines: ReadonlyArray<TradeInCapLine>): Promise<number | null> {
  return (await tradeInCouponLine(db, userId, couponId, lines))?.cap ?? null;
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

/** Who reads a request: its customer, a staff member (any admin), or the owner (cost scope). 'admin' = the owner's full view. */
export type RequestAudience = 'customer' | 'staff' | 'owner' | 'admin';

/** A credit given back (row 237) on this request, newest first; none on a database without 0192. */
async function reissuesOf(db: D1Database, requestId: string): Promise<Array<{ order_id: string; reason: string; ends_at: string; created_at: string }>> {
  try {
    const { results } = await db
      .prepare('SELECT order_id, reason, ends_at, created_at FROM trade_in_credit_reissues WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10')
      .bind(requestId)
      .all<{ order_id: string; reason: string; ends_at: string; created_at: string }>();
    return results ?? [];
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return [];
    throw e;
  }
}

/** The source device as its customer reads it: words and dates, never the paid split or an AMS share. */
function publicSource(src: Record<string, unknown>) {
  const pick = (k: string) => (typeof src[k] === 'string' ? (src[k] as string) : null);
  return {
    name: pick('name') ?? '',
    variant: pick('variant') ?? '',
    image: pick('image') ?? '',
    product_slug: pick('product_slug') ?? '',
    order_id: pick('order_id'),
    delivered_at: pick('delivered_at'),
    warranty_end_at: pick('warranty_end_at'),
  };
}

/** The target snapshot as stored (the server's priced selection): public words and the price the customer pays. */
function publicTarget(req: RequestRow) {
  if (!req.target_product_id) return null;
  const t = safeParse<Record<string, unknown>>(req.target_snapshot_json, {});
  return {
    product_id: req.target_product_id,
    slug: typeof t.slug === 'string' ? t.slug : '',
    name: typeof t.name === 'string' ? t.name : '',
    name_ar: typeof t.name_ar === 'string' ? t.name_ar : '',
    ...(typeof t.name_ckb === 'string' ? { name_ckb: t.name_ckb } : {}),
    image: typeof t.image === 'string' ? t.image : '',
    family: t.family ?? null,
    options: Array.isArray(t.options) ? t.options : [],
    color: t.color ?? null,
    option_value_ids: safeParse<string[]>(req.target_option_value_ids, []),
    color_id: req.target_color_id,
    price_iqd: req.target_price_iqd,
  };
}

/**
 * THE REQUEST AS EACH READER SEES IT (S-P2 spec §6.4, §6.13; DECISIONS rows 220, 238).
 *
 * Built from the columns, field by field — `loadRequest`'s `SELECT *` row is
 * never spread into a response.
 *   customer  the stage, the ONE offer, the final value, the credit and the
 *             difference; never the ceiling, the intake record, the formula, a
 *             per-part value, the rules or the owner's valuation;
 *   staff     + the customer, the counted previews, the server's ceiling and the
 *             intake record (any admin); no rules, no factor lines (B.10);
 *   owner     + the rules, the full stored estimate and the source snapshot.
 */
export async function requestView(env: Env, req: RequestRow, audience: RequestAudience) {
  const db = env.DB;
  const owner = audience === 'owner' || audience === 'admin';
  const staff = owner || audience === 'staff';
  // The counted estimates: the admin reads how many a request used (a probe
  // shows as a long run of them); a customer's draft says how many are left.
  const countsPreviews = staff || req.status === 'draft';
  const [comps, photos, events, book, orders, credit, previews, reissues] = await Promise.all([
    loadComponents(db, req.id),
    loadPhotos(db, req.id),
    loadEvents(db, req.id),
    loadRuleBook(db),
    creditOrders(db, req.id),
    req.coupon_id
      ? db.prepare('SELECT ends_at FROM coupons WHERE id = ? AND trade_in_id = ?').bind(req.coupon_id, req.id).first<{ ends_at: string | null }>()
      : Promise.resolve(null),
    countsPreviews ? previewCount(db, req.id) : Promise.resolve(0),
    req.status === 'completed' ? reissuesOf(db, req.id) : Promise.resolve([]),
  ]);
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const stored = safeParse<Estimate | null>(req.estimate_json, null);
  const blockers = req.status === 'draft' ? submitBlockers(req, comps, photos, book) : null;
  // The order holding the credit: not cancelled, its use still spent (a returned device's order gave it back).
  const creditOrder = orders.find((o) => o.status !== 'cancelled' && o.redemption_state === 'active') ?? null;
  // The credit's last moment, as «إتمام الدفع» will judge it (`checkoutCredit`). A released
  // order's time is already in `ends_at`; only a cancellation from before 0191, whose use is
  // still spent, is added on read.
  const legacyHeld = orders.find((o) => o.coupon_id === req.coupon_id && o.status === 'cancelled' && o.redemption_state === 'active') ?? null;
  const creditEnd = credit ? creditEndsAt(credit.ends_at, legacyHeld, nowMs) : null;
  const creditLapsed = !creditOrder && creditExpired(creditEnd, nowMs);
  const liveReissue = reissues.find((x) => Date.parse(x.ends_at) > nowMs) ?? null;
  const stage = stageOf(req, !!creditOrder, !!liveReissue && !creditOrder);
  const proposal =
    req.admin_value_iqd !== null
      ? {
          offer_no: req.offer_no,
          value_iqd: req.admin_value_iqd,
          reason: req.admin_reason,
          settlement: settlementOf(req, req.admin_value_iqd),
          valued_at: req.valued_at,
        }
      : null;
  const v2Offer = req.offer_iqd !== undefined && req.offer_iqd !== null ? { offer_iqd: req.offer_iqd, offer_at: req.offer_at ?? null, valid_until: req.offer_expires_at ?? null } : null;
  const families = [...new Set(comps.map((c) => c.family))];
  const source = safeParse<Record<string, unknown>>(req.source_snapshot_json, {});
  const v2 = (req.valuation_version ?? 1) >= 2;
  const received = !!req.intake_at;
  const intakeFacts = safeParse<Record<string, unknown>>(req.intake_json ?? '{}', {});
  const publicEst = stored && Array.isArray(stored.components) ? { ...publicEstimate(stored), components: [] } : null;
  const base = {
    id: req.id,
    status: req.status,
    status_label: STATUS_LABELS[req.status],
    stage,
    stage_label: STAGE_LABELS[stage],
    scope: req.scope,
    family: req.family,
    is_combo: req.is_combo === 1,
    valuation_version: req.valuation_version ?? 1,
    order_id: req.order_id,
    order_item_id: req.order_item_id,
    unit_index: req.unit_index,
    source: owner ? source : publicSource(source),
    target: publicTarget(req),
    // The store-safe offer (v2); while a value proposal is open it also carries that proposal's
    // keys, which a phone still holding the old request page reads (§7.4).
    offer: v2Offer || proposal ? { ...(v2Offer ?? { offer_iqd: null, offer_at: null, valid_until: null }), ...(proposal ?? {}) } : null,
    value_proposal: proposal,
    now_price_iqd: req.now_price_iqd ?? null,
    paid_net_iqd: req.paid_net_iqd ?? null,
    handover: req.handover ?? null,
    pickup_fee_iqd: req.pickup_fee_iqd ?? 0,
    // The figure fixed at submit: v2 the offer, v1 the estimate. A draft carries none (G11: the counted
    // preview is the only door to a draft's figure) — the owner reads the live engine figure.
    estimate: req.status === 'draft' ? (owner ? estimateFor(req, comps, book, now).estimate : null) : owner ? stored : v2 ? null : publicEst,
    estimated_iqd: req.status === 'draft' ? (owner ? estimateFor(req, comps, book, now).estimate.total_iqd : null) : req.estimated_iqd,
    final_value_iqd: req.final_value_iqd,
    credit_iqd: req.credit_iqd,
    difference_iqd: req.difference_iqd,
    excess_iqd: req.final_value_iqd !== null && req.credit_iqd !== null ? Math.max(0, req.final_value_iqd - (req.pickup_fee_iqd ?? 0) - req.credit_iqd) : null,
    credit_order: creditOrder ? { id: creditOrder.order_id, status: creditOrder.status, amount_iqd: creditOrder.amount_iqd } : null,
    /** The credit's last moment (owner decision 2), or null for a credit minted before credits ended. */
    credit_expires_at: creditOrder ? null : liveReissue ? liveReissue.ends_at : creditEnd,
    credit_expired: liveReissue ? false : creditLapsed,
    reissue: liveReissue && !creditOrder ? { ends_at: liveReissue.ends_at, any_device: true as const } : null,
    intake: received ? { received_at: req.intake_at!, serial_matched: req.intake_serial_match === 'match' } : null,
    customer_note: req.customer_note,
    cancel_reason: req.cancel_reason,
    blockers,
    components: comps.map((c) => ({
      role: c.role,
      family: c.family,
      label_ar: c.label_ar,
      label_en: c.label_en,
      inputs: safeParse<Record<string, unknown>>(c.inputs_json, {}),
      required_angles: REQUIRED_PHOTOS[c.family].map((a) => a.id),
      allowed_angles: anglesFor(c.family, req.valuation_version ?? 1).map((a) => a.id),
      photos: photos.filter((p) => p.component_role === c.role && (p.phase ?? 'customer') === 'customer').map(photoView),
      ...(staff ? { intake_inputs: safeParse<Record<string, unknown>>(c.intake_inputs_json ?? '{}', {}) } : {}),
      // The owner's own breakdown; staff and the customer read no part value (B.10, G11).
      ...(owner ? { base_iqd: c.base_iqd, value_iqd: c.value_iqd, estimate: safeParse<ComponentValuation | null>(c.estimate_json, null) } : {}),
    })),
    events: events.map((e) => ({
      action: e.action,
      actor_role: e.actor_role,
      from_status: e.from_status,
      to_status: e.to_status,
      created_at: e.created_at,
      detail: owner ? e.detail : pickPublicDetail(e.detail),
    })),
    ...(staff ? { previews } : req.status === 'draft' ? { previews_left: Math.max(0, TRADE_IN_PREVIEW_PER_REQUEST - previews) } : {}),
    // The rules that price it are the owner's to read (B.10); the customer's wizard is told what to ask.
    ...(owner
      ? { rules: Object.fromEntries(families.map((f) => [f, publicRules(book[f])])) }
      : { questions: Object.fromEntries(families.map((f) => [f, publicQuestions(book[f])])) }),
    can: {
      edit: req.status === 'draft',
      submit: req.status === 'draft' && !!blockers && !Object.keys(blockers.inputs).length && !Object.keys(blockers.photos).length && !blockers.target,
      cancel: !isTerminal(req.status) && !creditOrder,
      // A proposal made on photos before S-P2 is answered once the device is received (0192 columns present).
      decide: req.status === 'value_changed' && (req.intake_at === undefined || received),
      pay: (req.status === 'awaiting_payment' && !creditOrder && (req.credit_iqd ?? 0) > 0 && !creditLapsed && (!v2 || received)) || (!!liveReissue && !creditOrder),
      choose_handover: req.status === 'draft' || (req.status === 'submitted' && !received),
    },
    created_at: req.created_at,
    submitted_at: req.submitted_at,
    decided_at: req.decided_at,
    completed_at: req.completed_at,
    cancelled_at: req.cancelled_at,
  };
  if (!staff) return base;
  const intakePhotos = photos.filter((p) => p.phase === 'intake').map((p) => ({ ...photoView(p), proves: p.proves ?? '' }));
  const byName = req.intake_by ? ((await db.prepare('SELECT name FROM users WHERE id = ?').bind(req.intake_by).first<{ name: string | null }>())?.name ?? null) : null;
  // What the customer declared against what the desk saw, answer by answer (§6.13).
  const declaredVsIntake = comps.flatMap((c) => {
    const declared = safeParse<Record<string, unknown>>(c.inputs_json, {});
    const seen = safeParse<Record<string, unknown>>(c.intake_inputs_json ?? '{}', {});
    return Object.keys(seen)
      .filter((k) => JSON.stringify(seen[k]) !== JSON.stringify(declared[k]))
      .map((field) => ({ role: c.role, field, declared: declared[field] ?? null, seen: seen[field] }));
  });
  return {
    ...base,
    offer_expires_at: req.offer_expires_at ?? null,
    // The server's ceiling at intake (staff), never the customer's.
    ceiling_iqd: req.ceiling_iqd ?? null,
    ceiling_at: req.ceiling_at ?? null,
    above_ceiling: (req.above_ceiling ?? 0) === 1,
    intake: received
      ? {
          received_at: req.intake_at!,
          serial_matched: req.intake_serial_match === 'match',
          by: req.intake_by ?? null,
          by_name: byName,
          serial_norm: req.intake_serial_norm ?? null,
          serial_match: req.intake_serial_match ?? null,
          hours_seen: intakeFacts.hours_seen ?? null,
          hours_declared: intakeFacts.hours_declared ?? null,
          hours_flag: intakeFacts.hours_flag === true,
          findings: typeof intakeFacts.findings === 'string' ? intakeFacts.findings : '',
          serial_override: intakeFacts.serial_override === true,
        }
      : null,
    intake_photos: intakePhotos,
    declared_vs_intake: declaredVsIntake,
    device_returned_at: req.device_returned_at ?? null,
    cutover: v2 ? false : req.status !== 'draft' && !isTerminal(req.status),
  };
}

/** The settlement a value would give against the request's target, the collection fee off the credit (v2). */
function settlementOf(req: RequestRow, value: number): TradeInSettlement {
  const s = offerSettlement(req.target_price_iqd ?? 0, value, req.pickup_fee_iqd ?? 0);
  return { target_price_iqd: s.target_price_iqd, trade_in_value_iqd: s.trade_in_value_iqd, credit_iqd: s.credit_iqd, difference_iqd: s.difference_iqd, excess_iqd: s.excess_iqd };
}

function pickPublicDetail(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['value_iqd', 'estimated_iqd', 'offer_iqd', 'reason', 'offer_no', 'via', 'difference_iqd', 'credit_iqd', 'ends_at', 'order_id']) if (k in d) out[k] = d[k];
  return out;
}

/** The rule set as the admin desk reads it (`requestView(…, 'admin')`, the rules editor) — the owner's rules, never sent to a customer (DECISIONS row 220). */
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

export function appOrigin(env: Env): string | null {
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
  const s = settlementOf(req, req.admin_value_iqd ?? 0);
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
    const s = settlementOf(req, req.admin_value_iqd ?? 0);
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
export async function notifyAdmins(
  env: Env,
  req: RequestRow,
  event: 'submitted' | 'accepted' | 'rejected' | 'order_placed' | 'received' | 'device_to_return'
): Promise<void> {
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
          : event === 'received'
            ? '📦 استُلم جهاز استبدال في المتجر'
            : event === 'device_to_return'
              ? '↩️ جهاز استبدال يُعاد إلى الزبون'
              : '🧾 طلب شراء بقيمة الاستبدال';
  // S-P2 staff topics: the offer and the ceiling (staff figures), never a cap, a margin or a cost.
  const serial =
    req.intake_serial_match === 'match' ? 'مطابق' : req.intake_serial_match === 'mismatch' ? 'غير مطابق — قرار المالك' : req.intake_serial_match === 'unrecorded' ? 'غير مسجّل — الاعتماد للمالك' : 'لا ينطبق';
  const lines = [
    `${head} — ${req.id}`,
    `الجهاز: ${name} (طلب ${src.order_id ?? req.order_id})`,
    `النطاق: ${req.scope === 'whole' ? 'الجهاز كاملاً' : req.scope === 'ams_only' ? 'AMS فقط' : 'الطابعة فقط'}`,
    `الجهاز الجديد: ${sanitizeUserText(String(tgt.name ?? ''), { max: 120 })} — ${iqdText(req.target_price_iqd ?? 0, 'ar')}`,
    event === 'submitted'
      ? `التقدير الأولي: ${iqdText(req.estimated_iqd ?? 0, 'ar')}`
      : event === 'received'
        ? `العرض: ${iqdText(req.offer_iqd ?? req.estimated_iqd ?? 0, 'ar')} · الحد الأعلى: ${iqdText(req.ceiling_iqd ?? 0, 'ar')} · الرقم التسلسلي: ${serial}`
        : event === 'device_to_return'
          ? 'الجهاز في المتجر: يُسلَّم للزبون ثم يُعلَّم «أُعيد الجهاز».'
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
