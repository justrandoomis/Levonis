/**
 * THE ADMIN «المراجعات والهدايا» MODEL — pure, no React, no fetch.
 *
 * The screens of src/components/adminReviews/* read the server through these
 * normalisers only. Each one accepts the contract of docs/REVIEWS_GIFTS.md
 * §6.1–§6.2 (the nested gift-queue row, the level item, the gift-options
 * projection) and, where an older field name exists, that name too — so a
 * Worker deployed a minute before or after the SPA renders an honest row
 * instead of a crash or a blank. Nothing here decides eligibility, a price, a
 * level or a state: the server derives every one of them, and the client only
 * shows them and refuses to ASK for something the server would refuse
 * (the issue button stays off without a level, the configurator lists the
 * missing choices before it saves).
 */

export type Lang = 'ar' | 'en' | 'ckb';

export type GiftCheck =
  | 'buyer'
  | 'delivered'
  | 'printer'
  | 'unit'
  | 'unit_owned'
  | 'registered_to_reviewer'
  | 'five_stars'
  | 'text_ok'
  | 'user_authored'
  | 'unit_not_rewarded';

/** The ten conditions of brief §2, in the order the checklist shows them. */
export const GIFT_CHECKS: readonly GiftCheck[] = [
  'buyer',
  'delivered',
  'printer',
  'unit',
  'unit_owned',
  'registered_to_reviewer',
  'five_stars',
  'text_ok',
  'user_authored',
  'unit_not_rewarded',
];

export const GIFT_LEVELS = [1, 2, 3, 4, 5] as const;
export const CODE_MAX_ATTEMPTS = 5;

export type ReviewStatus = 'pending' | 'published' | 'rejected';
export type RewardState = 'submitted' | 'revision_needed' | 'approved' | 'rejected';
export type RewardKind = 'printer_gift' | 'points';
export type Family = 'fdm' | 'resin' | 'laser';
export type RegistrationState = 'reviewer' | 'other' | 'released' | 'none';
export type EntitlementState =
  | 'available'
  | 'selected'
  | 'code_issued'
  | 'redeemed_ready_to_order'
  | 'ordered'
  | 'fulfilled'
  | 'cancelled';
export type CodeState = 'none' | 'issued' | 'redeemed' | 'revoked';
export type GrantMode = 'legacy' | 'level' | 'manual';
export type SaleType = 'direct_sale' | 'pre_order';
export type Transport = 'air' | 'sea' | 'land';
export const TRANSPORTS: readonly Transport[] = ['air', 'sea', 'land'];

export interface MediaItem {
  url: string;
  kind: 'image' | 'video';
}

export interface Diagnostics {
  family: Family | null;
  checks: Partial<Record<GiftCheck, boolean>>;
  excluded: { gift_line: boolean; refunded: boolean; traded_in: boolean };
  /** The unit the checks ran on (giftDiagnostics.unit), when the server includes it. */
  unit: Record<string, unknown> | null;
  prior_reward: { reward_id: string; state: string } | null;
}

export interface EntitlementView {
  id: string;
  state: EntitlementState;
  grant_mode: GrantMode;
  level: number | null;
  code_state: CodeState;
  code_attempts: number;
  code_issued_at: string | null;
  code_issued_by: string;
  code_redeemed_at: string | null;
  in_cart: boolean;
  order: { id: string; status: string } | null;
}

export interface Person {
  id: string;
  email: string;
  username: string;
  name: string;
}

export interface QueueRow {
  review: {
    id: string;
    stars: number;
    body: string;
    media: MediaItem[];
    created_at: string;
    status: ReviewStatus;
    source: 'user' | 'system';
    moderation_note: string;
  };
  user: Person;
  product: {
    id: string;
    name: string;
    name_ar: string;
    image: string;
    family: Family | null;
    section: { name_ar: string; name_en: string; name_ckb: string } | null;
  };
  order: { id: string; status: string; delivered_at: string | null } | null;
  order_item: { id: string; name: string; option: string } | null;
  unit: {
    id: string;
    unit_index: number | null;
    delivered_at: string | null;
    warranty_end_at: string | null;
    replaced_by_unit_id: string;
  } | null;
  serial: string;
  receipt_no: string;
  registration: { state: RegistrationState; registered_at: string | null };
  /** At admission (the statement only inserts when all ten hold) and now. */
  eligibility: { snapshot: Partial<Record<GiftCheck, boolean>> | null; live: Diagnostics | null };
  prior_reward: { reward_id: string; state: string } | null;
  reward: {
    id: string;
    kind: RewardKind;
    state: RewardState;
    /** Only meaningful once decided — NEVER a prediction, never preselected. */
    level: number | null;
    decided_by: string;
    decided_at: string | null;
    reason: string;
    points_awarded: number;
  };
  entitlement: EntitlementView | null;
  legacy: boolean;
  instagram: { link: string; file_url: string } | null;
  quality: { score: number | null; reasons: string[]; signals: string[] } | null;
}

export interface ReviewListRow {
  review_id: string;
  created_at: string;
  stars: number;
  body: string;
  media: MediaItem[];
  status: ReviewStatus;
  source: 'user' | 'system';
  moderation_note: string;
  customer: Person;
  product: { id: string; name: string; name_ar: string; family: Family | null };
  order_id: string;
  order_item_id: string;
  reward: { id: string; kind: RewardKind; state: RewardState; level: number | null } | null;
}

/** One frozen gift item (gift_snapshot.items[]) as the admin sees it. */
export interface SnapshotItem {
  ref: string;
  product_id: string;
  sale_type: SaleType | '';
  transport_method: string;
  allowed_option_value_ids: string[];
  allowed_color_ids: string[];
  display: GiftDisplay;
}

export interface GiftDisplay {
  name_ar: string;
  name_en: string;
  name_ckb: string;
  image: string;
  variant_ar: string;
  variant_en: string;
  variant_ckb: string;
  color_name: string;
  color_hex: string;
  regular_iqd: number | null;
}

export interface GrantedRow extends EntitlementView {
  created_at: string;
  review_id: string;
  user: Person;
  printer: { id: string; name: string; name_ar: string; image: string } | null;
  items: SnapshotItem[];
  chosen_ref: string;
  legacy: { max_level: number | null; chosen_level: number | null; contents: string[] } | null;
}

export interface LevelItem {
  id: string;
  level: number;
  product_id: string;
  sale_type: SaleType | '';
  option_value_ids: string[];
  color_id: string;
  transport_method: Transport | '';
  allowed_option_value_ids: string[];
  allowed_color_ids: string[];
  active: boolean;
  sort: number;
  /** A label-only row of the old box pool: shown, never granted. */
  legacy: boolean;
  display: GiftDisplay;
  /** Names of the customer's allowed values when the server sends them. */
  allowed_labels: string[];
  warnings: string[];
}

export interface OptionValue {
  id: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  active: boolean;
}

export interface OptionGroup {
  id: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  values: OptionValue[];
}

export interface ColorOption {
  id: string;
  name_en: string;
  name_ar: string;
  name_ckb: string;
  hex: string;
  active: boolean;
  /** Option values this colour is linked to; empty = fits every selection. */
  option_value_ids: string[];
}

export interface SaleTypeOption {
  type: SaleType;
  available: boolean;
  reason: string;
  transports: Transport[];
}

/** The server's selectable projection of ONE product (GET /admin/gift-options/:id). */
export interface GiftOptions {
  product: { id: string; name_ar: string; name_en: string; name_ckb: string; image: string; status: string; composition: string };
  sale_types: SaleTypeOption[];
  groups: OptionGroup[];
  colors: ColorOption[];
  transports: Transport[];
}

/** What the admin is configuring in the item sheet. */
export interface GiftDraft {
  productId: string;
  saleType: SaleType | '';
  /** group id → pinned value id ('' = not pinned). */
  pins: Record<string, string>;
  /** group id → true when the customer picks this group from `allowed`. */
  customerPicks: Record<string, boolean>;
  allowed: Record<string, string[]>;
  colorPin: string;
  customerPicksColor: boolean;
  allowedColors: string[];
  transport: Transport | '';
  active: boolean;
}

export type DraftMode = 'level-item' | 'manual-gift';

export type ProblemKey =
  | 'needProduct'
  | 'composition'
  | 'needSaleType'
  | 'saleTypeNotOffered'
  | 'needTransport'
  | 'needGroup'
  | 'needGroupManual'
  | 'allowedEmpty'
  | 'needColor'
  | 'needColorManual'
  | 'allowedColorsEmpty'
  | 'colorMismatch';

export interface Problem {
  key: ProblemKey;
  /** The option group's id (needGroup, needGroupManual, allowedEmpty). */
  group?: string;
}

/** The body of POST /admin/pools and PUT /admin/pools/:id (LevelItemInput). */
export interface LevelItemInput {
  level: number;
  productId: string;
  saleType: SaleType;
  optionValueIds: string[];
  colorId: string;
  transportMethod: Transport | '';
  allowedOptionValueIds: string[];
  allowedColorIds: string[];
  active: boolean;
  sort?: number;
}

/** The body of POST /admin/pools/preview and the issue's `manual` (GiftSelectionInput). */
export interface GiftSelectionInput {
  productId: string;
  saleType: SaleType;
  optionValueIds: string[];
  colorId: string;
  transportMethod: Transport | '';
}

/** A manual gift chosen in the sheet, before «تأكيد وإصدار الكود». */
export interface ManualGift {
  selection: GiftSelectionInput;
  display: GiftDisplay;
}

/** The issue / re-issue answer — the ONE response that carries the raw code. */
export interface IssueResult {
  code: string | null;
  replay: boolean;
  entitlementId: string;
  level: number | null;
  issuedAt: string | null;
  issuedBy: string;
}

// ------------------------------------------------------------ primitives

export const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

export const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

export const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const list = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const ids = (v: unknown): string[] => [...new Set(list(v).map(str).filter(Boolean))];

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(str(v)) ? (str(v) as T) : fallback;

const nullableDate = (v: unknown): string | null => (str(v) ? str(v) : null);

// ------------------------------------------------------------ normalisers

export function normalizeMedia(raw: unknown): MediaItem[] {
  const out: MediaItem[] = [];
  for (const m of list(raw)) {
    const o = obj(m);
    if (!o) continue;
    const url = str(o.url) || (str(o.key) ? `/api/reviews/media/${str(o.key)}` : '');
    if (!url) continue;
    out.push({ url, kind: o.kind === 'video' ? 'video' : 'image' });
  }
  return out;
}

export function normalizeFamily(v: unknown): Family | null {
  const s = str(v);
  return s === 'fdm' || s === 'resin' || s === 'laser' ? s : null;
}

function normalizePerson(raw: unknown): Person {
  const o = obj(raw);
  return { id: str(o?.id), email: str(o?.email), username: str(o?.username), name: str(o?.name) };
}

function normalizeChecks(raw: unknown): Partial<Record<GiftCheck, boolean>> {
  const o = obj(raw);
  const out: Partial<Record<GiftCheck, boolean>> = {};
  if (!o) return out;
  for (const c of GIFT_CHECKS) if (c in o) out[c] = bool(o[c]);
  return out;
}

export function normalizeDiagnostics(raw: unknown): Diagnostics | null {
  const o = obj(raw);
  if (!o || !obj(o.checks)) return null;
  const ex = obj(o.excluded);
  const prior = obj(o.prior_reward);
  return {
    family: normalizeFamily(o.family),
    checks: normalizeChecks(o.checks),
    excluded: { gift_line: bool(ex?.gift_line), refunded: bool(ex?.refunded), traded_in: bool(ex?.traded_in) },
    unit: obj(o.unit),
    prior_reward: prior && str(prior.reward_id) ? { reward_id: str(prior.reward_id), state: str(prior.state) } : null,
  };
}

/**
 * The admission snapshot. The statement that writes it (admitPrinterGiftStatement)
 * inserts ONLY when all ten conditions hold, so a v2 snapshot means "all ten at
 * entry". A snapshot that carries its own `checks` is read as it is. A legacy
 * row (written before the rules) has neither, and its column says "unknown".
 */
export function normalizeSnapshotChecks(raw: unknown): Partial<Record<GiftCheck, boolean>> | null {
  const o = obj(typeof raw === 'string' ? safeJson(raw) : raw);
  if (!o) return null;
  if (obj(o.checks)) return normalizeChecks(o.checks);
  if (num(o.v) === 2 || str(o.admitted_at) || str(o.unit_id)) {
    const all: Partial<Record<GiftCheck, boolean>> = {};
    for (const c of GIFT_CHECKS) all[c] = true;
    return all;
  }
  return null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const ENT_STATES: readonly EntitlementState[] = [
  'available',
  'selected',
  'code_issued',
  'redeemed_ready_to_order',
  'ordered',
  'fulfilled',
  'cancelled',
];
const CODE_STATES: readonly CodeState[] = ['none', 'issued', 'redeemed', 'revoked'];
const GRANT_MODES: readonly GrantMode[] = ['legacy', 'level', 'manual'];
const REVIEW_STATUSES: readonly ReviewStatus[] = ['pending', 'published', 'rejected'];
const REWARD_STATES: readonly RewardState[] = ['submitted', 'revision_needed', 'approved', 'rejected'];

export function normalizeEntitlement(raw: unknown, fallbackId = ''): EntitlementView | null {
  const o = obj(raw);
  const id = str(o?.id) || fallbackId;
  if (!id) return null;
  const order = obj(o?.order);
  const orderId = str(order?.id ?? o?.order_id);
  return {
    id,
    state: oneOf(o?.state, ENT_STATES, 'code_issued'),
    grant_mode: oneOf(o?.grant_mode, GRANT_MODES, 'legacy'),
    level: num(o?.level ?? o?.chosen_level ?? o?.max_level),
    code_state: oneOf(o?.code_state, CODE_STATES, 'none'),
    code_attempts: num(o?.code_attempts) ?? 0,
    code_issued_at: nullableDate(o?.code_issued_at),
    code_issued_by: str(o?.code_issued_by_email ?? o?.code_issued_by),
    code_redeemed_at: nullableDate(o?.code_redeemed_at),
    in_cart: bool(o?.in_cart) || !!obj(o?.in_cart),
    order: orderId ? { id: orderId, status: str(order?.status ?? o?.order_status) } : null,
  };
}

/**
 * One gift-queue row. Reads the nested contract of §6.2 and, for the flat row
 * the base Worker sends (`review_id`, `customer`, `reward_state`…), the same
 * facts under their old names.
 */
export function normalizeQueueRow(raw: unknown): QueueRow | null {
  const r = obj(raw);
  if (!r) return null;
  const rv = obj(r.review);
  const reviewId = str(rv?.id ?? r.review_id);
  if (!reviewId) return null;
  const p = obj(r.product);
  const sec = obj(p?.section);
  const o = obj(r.order);
  const oi = obj(r.order_item);
  const u = obj(r.unit);
  const reg = obj(r.registration);
  const el = obj(r.eligibility);
  const rw = obj(r.reward);
  const prior = obj(r.prior_reward);
  const q = obj(r.quality);
  const ig = obj(r.instagram);
  const live = normalizeDiagnostics(el?.live ?? r.diagnostics);
  // The diagnostics carry the unit the checks ran on; the row's own fields win.
  const lu = live?.unit ?? null;
  const rewardState = oneOf(rw?.state ?? r.reward_state, REWARD_STATES, 'submitted');
  const orderId = str(o?.id ?? r.order_id);
  const unitId = str(u?.id ?? r.unit_id ?? lu?.id);
  const serial = str(r.serial ?? u?.serial ?? lu?.serial);
  const regState = oneOf(reg?.state ?? r.registration_state ?? lu?.registration, ['reviewer', 'other', 'released', 'none'] as const, 'none');
  return {
    review: {
      id: reviewId,
      stars: num(rv?.stars ?? r.stars) ?? 0,
      body: str(rv?.body ?? r.body),
      media: normalizeMedia(rv?.media ?? r.media),
      created_at: str(rv?.created_at ?? r.created_at),
      status: oneOf(rv?.status ?? r.review_status, REVIEW_STATUSES, 'published'),
      source: str(rv?.source ?? r.source) === 'system' ? 'system' : 'user',
      moderation_note: str(rv?.moderation_note ?? r.moderation_note),
    },
    user: normalizePerson(r.user ?? r.customer),
    product: {
      id: str(p?.id),
      name: str(p?.name),
      name_ar: str(p?.name_ar),
      image: str(p?.image),
      family: normalizeFamily(p?.family ?? live?.family),
      section: sec ? { name_ar: str(sec.name_ar), name_en: str(sec.name_en), name_ckb: str(sec.name_ckb) } : null,
    },
    order: orderId ? { id: orderId, status: str(o?.status ?? r.order_status), delivered_at: nullableDate(o?.delivered_at) } : null,
    order_item: oi || r.order_item_id
      ? { id: str(oi?.id ?? r.order_item_id), name: str(oi?.name_snapshot ?? oi?.name), option: str(oi?.option_snapshot ?? oi?.option) }
      : null,
    unit: unitId
      ? {
          id: unitId,
          unit_index: num(u?.unit_index ?? lu?.unit_index),
          delivered_at: nullableDate(u?.delivered_at ?? lu?.delivered_at),
          warranty_end_at: nullableDate(u?.warranty_end_at ?? lu?.warranty_end_at),
          replaced_by_unit_id: str(u?.replaced_by_unit_id ?? lu?.replaced_by_unit_id),
        }
      : null,
    serial,
    receipt_no: str(r.receipt_no ?? lu?.receipt_no),
    registration: { state: regState, registered_at: nullableDate(reg?.registered_at ?? lu?.registered_at) },
    eligibility: { snapshot: normalizeSnapshotChecks(el?.snapshot), live },
    prior_reward:
      prior && str(prior.reward_id)
        ? { reward_id: str(prior.reward_id), state: str(prior.state) }
        : r.prior_reward === undefined
          ? live?.prior_reward ?? null
          : null,
    reward: {
      id: str(rw?.id ?? r.reward_id),
      kind: str(rw?.kind ?? r.kind) === 'points' ? 'points' : 'printer_gift',
      state: rewardState,
      // A level exists only once decided. The old row's `quality_score` on an
      // undecided reward was the PREDICTED tier — it is never read as a level.
      level: rewardState === 'approved' ? num(rw?.level ?? r.quality_score) : null,
      decided_by: str(rw?.decided_by_email ?? rw?.decided_by ?? r.decided_by),
      decided_at: nullableDate(rw?.decided_at ?? r.decided_at),
      reason: str(rw?.reason ?? r.reason),
      points_awarded: num(rw?.points_awarded ?? r.points_awarded) ?? 0,
    },
    entitlement: normalizeEntitlement(r.entitlement, str(r.entitlement_id)),
    legacy: r.legacy === undefined ? !unitId : bool(r.legacy),
    instagram: ig && (str(ig.link) || str(ig.file_url)) ? { link: str(ig.link), file_url: str(ig.file_url) } : null,
    quality: q
      ? {
          score: num(q.score),
          reasons: list(q.reasons).map(str).filter(Boolean),
          signals: list(q.signals ?? q.suspiciousSignals).map(str).filter(Boolean),
        }
      : null,
  };
}

export function normalizeReviewListRow(raw: unknown): ReviewListRow | null {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.review_id ?? r.id);
  if (!id) return null;
  const p = obj(r.product);
  const rw = obj(r.reward);
  return {
    review_id: id,
    created_at: str(r.created_at),
    stars: num(r.stars) ?? 0,
    body: str(r.body),
    media: normalizeMedia(r.media),
    status: oneOf(r.status, REVIEW_STATUSES, 'published'),
    source: str(r.source) === 'system' ? 'system' : 'user',
    moderation_note: str(r.moderation_note),
    customer: normalizePerson(r.customer ?? r.user),
    product: { id: str(p?.id), name: str(p?.name), name_ar: str(p?.name_ar), family: normalizeFamily(p?.family) },
    order_id: str(r.order_id),
    order_item_id: str(r.order_item_id),
    reward:
      rw && str(rw.id)
        ? {
            id: str(rw.id),
            kind: str(rw.kind) === 'points' ? 'points' : 'printer_gift',
            state: oneOf(rw.state, REWARD_STATES, 'submitted'),
            level: oneOf(rw.state, REWARD_STATES, 'submitted') === 'approved' ? num(rw.level) : null,
          }
        : null,
  };
}

export function normalizeDisplay(raw: unknown, fallback?: { name_ar?: unknown; name_en?: unknown; name?: unknown; image?: unknown }): GiftDisplay {
  const d = obj(raw);
  return {
    name_ar: str(d?.name_ar ?? fallback?.name_ar),
    name_en: str(d?.name_en ?? fallback?.name_en ?? fallback?.name),
    name_ckb: str(d?.name_ckb),
    image: str(d?.image ?? fallback?.image),
    variant_ar: str(d?.variant_ar),
    variant_en: str(d?.variant_en),
    variant_ckb: str(d?.variant_ckb),
    color_name: str(d?.color_name),
    color_hex: str(d?.color_hex),
    regular_iqd: num(d?.regular_iqd),
  };
}

function normalizeSnapshotItem(raw: unknown): SnapshotItem | null {
  const o = obj(raw);
  if (!o) return null;
  return {
    ref: str(o.ref),
    product_id: str(o.product_id),
    sale_type: oneOf(o.sale_type, ['direct_sale', 'pre_order', ''] as const, ''),
    transport_method: str(o.transport_method),
    allowed_option_value_ids: ids(o.allowed_option_value_ids),
    allowed_color_ids: ids(o.allowed_color_ids),
    display: normalizeDisplay(o.display),
  };
}

export function normalizeGrantedRow(raw: unknown): GrantedRow | null {
  const o = obj(raw);
  const ent = normalizeEntitlement(o);
  if (!o || !ent) return null;
  const pr = obj(o.printer ?? o.product);
  const snap = obj(typeof o.gift_snapshot === 'string' ? safeJson(o.gift_snapshot) : o.gift_snapshot);
  const items = list(o.items ?? snap?.items).map(normalizeSnapshotItem).filter((x): x is SnapshotItem => !!x);
  const chosen = obj(o.chosen);
  const leg = obj(o.legacy);
  const isLegacy = ent.grant_mode === 'legacy';
  const contents = list(leg?.contents ?? o.contents)
    .map((c) => {
      const co = obj(c);
      return co ? str(co.label_ar ?? co.label_en ?? co.item_id) : str(c);
    })
    .filter(Boolean);
  return {
    ...ent,
    created_at: str(o.created_at),
    review_id: str(o.review_id),
    user: normalizePerson(o.user ?? o.customer),
    printer: pr ? { id: str(pr.product_id ?? pr.id), name: str(pr.name), name_ar: str(pr.name_ar), image: str(pr.image) } : null,
    items,
    chosen_ref: str(chosen?.ref ?? o.gift_item_ref),
    legacy: isLegacy
      ? { max_level: num(leg?.max_level ?? o.max_level), chosen_level: num(leg?.chosen_level ?? o.chosen_level), contents }
      : null,
  };
}

export function normalizeLevelItem(raw: unknown): LevelItem | null {
  const o = obj(raw);
  if (!o || !str(o.id)) return null;
  const productId = str(o.product_id ?? o.productId);
  const prod = obj(o.product);
  const display = normalizeDisplay(o.display ?? o.snapshot ?? prod, {
    name_ar: o.label_ar ?? prod?.name_ar,
    name_en: o.label_en ?? prod?.name_en ?? prod?.name,
    image: prod?.image,
  });
  if (!display.name_ckb && str(o.label_ckb)) display.name_ckb = str(o.label_ckb);
  const allowed = obj(o.allowed);
  const labels = list(o.allowed_labels ?? allowed?.labels)
    .map((x) => {
      const lo = obj(x);
      return lo ? str(lo.name_ar ?? lo.name_en ?? lo.name) : str(x);
    })
    .filter(Boolean);
  return {
    id: str(o.id),
    level: num(o.level) ?? 1,
    product_id: productId,
    sale_type: oneOf(o.sale_type ?? o.saleType, ['direct_sale', 'pre_order', ''] as const, ''),
    option_value_ids: ids(o.option_value_ids ?? o.optionValueIds),
    color_id: str(o.color_id ?? o.colorId),
    transport_method: oneOf(o.transport_method ?? o.transportMethod, ['air', 'sea', 'land', ''] as const, ''),
    allowed_option_value_ids: ids(o.allowed_option_value_ids ?? o.allowedOptionValueIds),
    allowed_color_ids: ids(o.allowed_color_ids ?? o.allowedColorIds),
    active: o.active === undefined ? true : bool(o.active),
    sort: num(o.sort) ?? 0,
    legacy: o.legacy === undefined ? !productId : bool(o.legacy),
    display,
    allowed_labels: labels,
    warnings: list(o.warnings)
      .map((w) => {
        const wo = obj(w);
        return wo ? str(wo.code ?? wo.kind) : str(w);
      })
      .filter(Boolean),
  };
}

function normalizeValue(raw: unknown): OptionValue | null {
  const o = obj(raw);
  if (!o || !str(o.id)) return null;
  return {
    id: str(o.id),
    name_en: str(o.name_en ?? o.name),
    name_ar: str(o.name_ar),
    name_ckb: str(o.name_ckb),
    active: o.active === undefined ? true : bool(o.active),
  };
}

const TRANSPORT_OF = (v: unknown): Transport | null => {
  const s = str(obj(v)?.method ?? v).replace(/^preorder_/, '');
  return s === 'air' || s === 'sea' || s === 'land' ? s : null;
};

const transportsOf = (v: unknown): Transport[] => {
  const out: Transport[] = [];
  for (const t of list(v)) {
    const o = obj(t);
    if (o && o.enabled !== undefined && !bool(o.enabled)) continue;
    const m = TRANSPORT_OF(t);
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
};

/**
 * The gift-options projection. Groups may arrive with nested `values` or as a
 * flat `values` list carrying `group_id`; a colour's links as its own
 * `option_value_ids` or as the relations' `links` rows; sale types as names or
 * as objects. Every shape becomes the one the configurator reads.
 */
export function normalizeGiftOptions(raw: unknown): GiftOptions | null {
  const r = obj(raw);
  if (!r) return null;
  const p = obj(r.product) ?? {};
  const flatValues = list(r.values);
  const groups: OptionGroup[] = list(r.groups)
    .map((g) => {
      const go = obj(g);
      if (!go || !str(go.id)) return null;
      if (go.active !== undefined && !bool(go.active)) return null;
      const nested = list(go.values);
      const source = nested.length ? nested : flatValues.filter((v) => str(obj(v)?.group_id) === str(go.id));
      const values = source.map(normalizeValue).filter((v): v is OptionValue => !!v && v.active);
      return { id: str(go.id), name_en: str(go.name_en ?? go.name), name_ar: str(go.name_ar), name_ckb: str(go.name_ckb), values };
    })
    .filter((g): g is OptionGroup => !!g && g.values.length > 0);
  const links = list(r.links);
  const colors: ColorOption[] = list(r.colors)
    .map((c) => {
      const co = obj(c);
      if (!co || !str(co.id)) return null;
      const own = ids(co.option_value_ids ?? co.links);
      const linked = own.length
        ? own
        : links.filter((l) => str(obj(l)?.color_id) === str(co.id)).map((l) => str(obj(l)?.option_value_id)).filter(Boolean);
      return {
        id: str(co.id),
        name_en: str(co.name_en ?? co.name),
        name_ar: str(co.name_ar),
        name_ckb: str(co.name_ckb),
        hex: str(co.hex),
        active: co.active === undefined ? true : bool(co.active),
        option_value_ids: [...new Set(linked)],
      };
    })
    .filter((c): c is ColorOption => !!c && c.active);
  const topTransports = transportsOf(r.transports ?? obj(r.pre_order)?.transports);
  const rawTypes = list(r.sale_types ?? r.saleTypes);
  const sale_types: SaleTypeOption[] = (['direct_sale', 'pre_order'] as const).map((type) => {
    const hit = rawTypes.find((t) => str(obj(t)?.type ?? obj(t)?.sale_type ?? obj(t)?.id ?? t) === type);
    const ho = obj(hit);
    const flag = ho ? ho.available ?? ho.enabled ?? ho.ok : undefined;
    // No list at all = the projection did not say; the server's preview and
    // save still refuse a type the product does not offer.
    const available = !rawTypes.length ? true : hit === undefined ? false : flag === undefined ? true : bool(flag);
    const transports = type === 'pre_order' ? (ho && ho.transports !== undefined ? transportsOf(ho.transports) : topTransports) : [];
    return { type, available, reason: str(ho?.reason ?? ho?.code), transports };
  });
  return {
    product: {
      id: str(p.id),
      name_ar: str(p.name_ar),
      name_en: str(p.name_en ?? p.name),
      name_ckb: str(p.name_ckb),
      image: str(p.image),
      status: str(p.status),
      composition: str(p.composition),
    },
    sale_types,
    groups,
    colors,
    transports: topTransports,
  };
}

/** The issue / re-issue / conversion answer (§6.2). */
export function normalizeIssueResult(raw: unknown): IssueResult {
  const o = obj(raw);
  const ent = obj(o?.entitlement);
  const code = str(o?.code);
  return {
    code: /^\d{6}$/.test(code) ? code : null,
    replay: bool(o?.replay),
    entitlementId: str(ent?.id),
    level: num(ent?.level),
    issuedAt: nullableDate(o?.code_issued_at),
    issuedBy: str(o?.code_issued_by_email ?? o?.code_issued_by),
  };
}

// ------------------------------------------------------------ decisions the UI may refuse to ask

/** Why «تأكيد وإصدار الكود» cannot be pressed, or null when it can. */
export type IssueBlock =
  | 'decided'
  | 'system'
  | 'legacy'
  | 'notEligibleNow'
  | 'needLevel'
  | 'levelEmpty'
  | 'needManual';

export function issueBlock(
  row: Pick<QueueRow, 'reward' | 'review' | 'legacy' | 'eligibility'>,
  draft: { level: number | null; mode: 'level' | 'manual'; manual: ManualGift | null },
  activeInLevel: (level: number) => number | null
): IssueBlock | null {
  if (row.reward.state !== 'submitted' && row.reward.state !== 'revision_needed') return 'decided';
  if (row.review.source === 'system') return 'system';
  if (row.legacy) return 'legacy';
  if (liveFailing(row.eligibility.live)) return 'notEligibleNow';
  if (draft.level === null || !GIFT_LEVELS.includes(draft.level as 1)) return 'needLevel';
  if (draft.mode === 'level') {
    const n = activeInLevel(draft.level);
    if (n === 0) return 'levelEmpty';
  } else if (!draft.manual) {
    return 'needManual';
  }
  return null;
}

/** True when the live diagnostics say a condition fails or an exclusion applies. */
export function liveFailing(live: Diagnostics | null): boolean {
  if (!live) return false;
  if (GIFT_CHECKS.some((c) => live.checks[c] === false)) return true;
  return live.excluded.gift_line || live.excluded.refunded || live.excluded.traded_in;
}

export interface ChecklistRow {
  check: GiftCheck;
  /** null = unknown (legacy row, or diagnostics unavailable). */
  atEntry: boolean | null;
  now: boolean | null;
}

export function checklist(row: Pick<QueueRow, 'eligibility'>): ChecklistRow[] {
  const snap = row.eligibility.snapshot;
  const live = row.eligibility.live;
  return GIFT_CHECKS.map((check) => ({
    check,
    atEntry: snap && typeof snap[check] === 'boolean' ? (snap[check] as boolean) : null,
    now: live && typeof live.checks[check] === 'boolean' ? (live.checks[check] as boolean) : null,
  }));
}

// ------------------------------------------------------------ entitlement actions

/** «إلغاء وإصدار كود جديد»: the server re-issues only while the gift waits for its code. */
export const canReissue = (e: Pick<EntitlementView, 'state' | 'grant_mode'>): boolean =>
  e.grant_mode !== 'legacy' && e.state === 'code_issued';

/** «إلغاء الكود» alone: a live code only. */
export const canRevoke = (e: Pick<EntitlementView, 'state' | 'code_state' | 'grant_mode'>): boolean =>
  e.grant_mode !== 'legacy' && e.state === 'code_issued' && e.code_state === 'issued';

/** «إلغاء الهدية»: before it is ordered (an ordered gift is cancelled through its order). */
export const canCancel = (e: Pick<EntitlementView, 'state' | 'grant_mode'>): boolean =>
  e.grant_mode === 'legacy' ? e.state === 'available' : e.state === 'code_issued' || e.state === 'redeemed_ready_to_order';

/** Legacy box gifts: the hand-over of a chosen box. */
export const canFulfil = (e: Pick<EntitlementView, 'state' | 'grant_mode'>): boolean =>
  e.grant_mode === 'legacy' && e.state === 'selected';

/** Legacy `available` → a code (conversion, POST /admin/gifts/:id/issue). */
export const canConvert = (e: Pick<EntitlementView, 'state' | 'grant_mode'>): boolean =>
  e.grant_mode === 'legacy' && e.state === 'available';

export const isLocked = (e: Pick<EntitlementView, 'state' | 'code_state' | 'code_attempts'>): boolean =>
  e.state === 'code_issued' && e.code_state === 'issued' && e.code_attempts >= CODE_MAX_ATTEMPTS;

/** The state word to show: `in_cart` is derived (a cart line exists), never stored. */
export function shownState(e: Pick<EntitlementView, 'state' | 'in_cart'>): EntitlementState | 'in_cart' {
  return e.state === 'redeemed_ready_to_order' && e.in_cart ? 'in_cart' : e.state;
}

// ------------------------------------------------------------ the level editor's draft

export function emptyDraft(): GiftDraft {
  return {
    productId: '',
    saleType: '',
    pins: {},
    customerPicks: {},
    allowed: {},
    colorPin: '',
    customerPicksColor: false,
    allowedColors: [],
    transport: '',
    active: true,
  };
}

/** A fresh draft for a product just chosen: the only offered sale type is taken, nothing else is guessed. */
export function draftForProduct(productId: string, options: GiftOptions | null): GiftDraft {
  const d = emptyDraft();
  d.productId = productId;
  const offered = (options?.sale_types ?? []).filter((t) => t.available);
  if (offered.length === 1) d.saleType = offered[0].type;
  return d;
}

/** An existing level item, back into the editor. */
export function draftFromItem(item: LevelItem, options: GiftOptions | null): GiftDraft {
  const d = emptyDraft();
  d.productId = item.product_id;
  d.saleType = item.sale_type;
  d.transport = item.transport_method;
  d.active = item.active;
  const groupOf = (valueId: string) => options?.groups.find((g) => g.values.some((v) => v.id === valueId))?.id ?? '';
  for (const v of item.option_value_ids) {
    const g = groupOf(v);
    if (g) d.pins[g] = v;
  }
  for (const v of item.allowed_option_value_ids) {
    const g = groupOf(v);
    if (!g) continue;
    d.customerPicks[g] = true;
    d.allowed[g] = [...(d.allowed[g] ?? []), v];
  }
  d.colorPin = item.color_id;
  if (item.allowed_color_ids.length) {
    d.customerPicksColor = true;
    d.allowedColors = [...item.allowed_color_ids];
  }
  return d;
}

/** The option values a colour may sit beside, given the pins chosen so far. */
export function colorFits(color: ColorOption, groups: OptionGroup[], pins: Record<string, string>): boolean {
  if (!color.option_value_ids.length) return true;
  for (const g of groups) {
    const linkedHere = g.values.filter((v) => color.option_value_ids.includes(v.id)).map((v) => v.id);
    if (!linkedHere.length) continue;
    const pin = pins[g.id];
    if (pin && !linkedHere.includes(pin)) return false;
  }
  return true;
}

/**
 * What still has to be chosen before the draft can be saved or used. The
 * server re-validates every id (validateLevelItem / validateGiftSelection);
 * this only stops the admin from sending a request that cannot succeed and
 * names the missing choice beside the form.
 */
export function draftProblems(draft: GiftDraft, options: GiftOptions | null, mode: DraftMode): Problem[] {
  const out: Problem[] = [];
  if (!draft.productId) return [{ key: 'needProduct' }];
  if (options && options.product.composition) out.push({ key: 'composition' });
  if (!draft.saleType) out.push({ key: 'needSaleType' });
  else if (options && !options.sale_types.some((t) => t.type === draft.saleType && t.available)) out.push({ key: 'saleTypeNotOffered' });
  if (draft.saleType === 'pre_order' && !draft.transport) out.push({ key: 'needTransport' });
  for (const g of options?.groups ?? []) {
    const picks = mode === 'level-item' && !!draft.customerPicks[g.id];
    if (picks) {
      if (!(draft.allowed[g.id] ?? []).some((id) => g.values.some((v) => v.id === id))) out.push({ key: 'allowedEmpty', group: g.id });
    } else if (!draft.pins[g.id]) {
      out.push({ key: mode === 'manual-gift' ? 'needGroupManual' : 'needGroup', group: g.id });
    }
  }
  const colors = options?.colors ?? [];
  if (colors.length) {
    const picksColor = mode === 'level-item' && draft.customerPicksColor;
    if (picksColor) {
      if (!draft.allowedColors.some((id) => colors.some((c) => c.id === id))) out.push({ key: 'allowedColorsEmpty' });
    } else if (!draft.colorPin) {
      out.push({ key: mode === 'manual-gift' ? 'needColorManual' : 'needColor' });
    } else {
      const c = colors.find((x) => x.id === draft.colorPin);
      if (c && !colorFits(c, options?.groups ?? [], draft.pins)) out.push({ key: 'colorMismatch' });
    }
  }
  return out;
}

const pinnedValues = (draft: GiftDraft, options: GiftOptions | null, mode: DraftMode): string[] =>
  (options?.groups ?? [])
    .filter((g) => !(mode === 'level-item' && draft.customerPicks[g.id]))
    .map((g) => draft.pins[g.id])
    .filter((v): v is string => !!v)
    .sort();

/** The level item the server is asked to save (only meaningful once `draftProblems` is empty). */
export function draftToLevelInput(draft: GiftDraft, level: number, options: GiftOptions | null): LevelItemInput {
  const allowed = (options?.groups ?? [])
    .filter((g) => draft.customerPicks[g.id])
    .flatMap((g) => (draft.allowed[g.id] ?? []).filter((id) => g.values.some((v) => v.id === id)));
  return {
    level,
    productId: draft.productId,
    saleType: (draft.saleType || 'direct_sale') as SaleType,
    optionValueIds: pinnedValues(draft, options, 'level-item'),
    colorId: draft.customerPicksColor ? '' : draft.colorPin,
    transportMethod: draft.saleType === 'pre_order' ? draft.transport : '',
    allowedOptionValueIds: [...new Set(allowed)].sort(),
    allowedColorIds: draft.customerPicksColor ? [...new Set(draft.allowedColors)].sort() : [],
    active: draft.active,
  };
}

/** The complete selection of a manual gift (every group pinned, the colour pinned). */
export function draftToSelection(draft: GiftDraft, options: GiftOptions | null): GiftSelectionInput {
  return {
    productId: draft.productId,
    saleType: (draft.saleType || 'direct_sale') as SaleType,
    optionValueIds: pinnedValues(draft, options, 'manual-gift'),
    colorId: draft.colorPin,
    transportMethod: draft.saleType === 'pre_order' ? draft.transport : '',
  };
}

/**
 * A representative COMPLETE selection of a level-item draft, for the preview
 * card only: the pins plus the first allowed value of each customer group and
 * the first allowed colour. Never saved — the item saves its pins and lists.
 */
export function draftPreviewSelection(draft: GiftDraft, options: GiftOptions | null, mode: DraftMode): GiftSelectionInput | null {
  if (draftProblems(draft, options, mode).length) return null;
  const values = (options?.groups ?? [])
    .map((g) => (mode === 'level-item' && draft.customerPicks[g.id] ? (draft.allowed[g.id] ?? [])[0] : draft.pins[g.id]))
    .filter((v): v is string => !!v)
    .sort();
  const color = mode === 'level-item' && draft.customerPicksColor ? draft.allowedColors[0] ?? '' : draft.colorPin;
  return {
    productId: draft.productId,
    saleType: (draft.saleType || 'direct_sale') as SaleType,
    optionValueIds: values,
    colorId: color,
    transportMethod: draft.saleType === 'pre_order' ? draft.transport : '',
  };
}

// ------------------------------------------------------------ level lists

export function itemsOfLevel(items: LevelItem[], level: number): LevelItem[] {
  return items
    .filter((i) => i.level === level)
    .sort((a, b) => Number(a.legacy) - Number(b.legacy) || a.sort - b.sort || a.id.localeCompare(b.id));
}

/** Active, product-backed items of one level — what a level gift snapshots. */
export function activeCount(items: LevelItem[], level: number): number {
  return items.filter((i) => i.level === level && i.active && !i.legacy && i.product_id).length;
}

/** The ids of a level after moving one item up (-1) or down (+1); unchanged at an end. */
export function moved(idsInOrder: string[], id: string, delta: -1 | 1): string[] {
  const i = idsInOrder.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= idsInOrder.length) return idsInOrder;
  const next = [...idsInOrder];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// ------------------------------------------------------------ small helpers

/** One idempotency key per issue ATTEMPT (8–80 chars, the server's bound). */
export function newRequestId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return `gi-${c.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `gi-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The six digits as two halves for the eye; the clipboard always gets the raw six. */
export function codeHalves(code: string): [string, string] {
  return [code.slice(0, 3), code.slice(3)];
}

/** A product name in the reading language (ckb falls back to Arabic, never to English first). */
export function nameIn(lang: Lang, d: { name_ar?: string; name_en?: string; name_ckb?: string; name?: string }): string {
  const ar = d.name_ar || '';
  const en = d.name_en || d.name || '';
  if (lang === 'en') return en || ar;
  if (lang === 'ckb') return d.name_ckb || ar || en;
  return ar || en;
}

export function variantIn(lang: Lang, d: GiftDisplay): string {
  if (lang === 'en') return d.variant_en || d.variant_ar;
  if (lang === 'ckb') return d.variant_ckb || d.variant_ar || d.variant_en;
  return d.variant_ar || d.variant_en;
}

export function personLabel(p: Person): string {
  return p.name || p.username || p.email || p.id || '—';
}

/** `{hole}` filling for the string tables (holes are identical in the three languages). */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** ApiError-shaped facts, read without importing api.ts (keeps this module pure). */
export function errorFacts(e: unknown): { status: number; code: string; message: string; details: Record<string, unknown> | null } {
  const o = e as { status?: unknown; code?: unknown; message?: unknown; details?: unknown } | null;
  return {
    status: typeof o?.status === 'number' ? o.status : 0,
    code: typeof o?.code === 'string' ? o.code : '',
    message: typeof o?.message === 'string' ? o.message : '',
    details: obj(o?.details),
  };
}

/**
 * Whether an issue attempt's outcome is UNKNOWN (no answer, or a server
 * fault): the same requestId must then be sent again, so a retry is a replay
 * and never a second code.
 */
export function outcomeUnknown(e: unknown): boolean {
  const { status, code } = errorFacts(e);
  if (code === 'ABORTED') return false;
  return status === 0 || status >= 500;
}
