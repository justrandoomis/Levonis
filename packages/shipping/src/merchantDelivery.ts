/**
 * MERCHANT DELIVERY BY GOVERNORATE — the one rule that prices a community
 * store's delivery (docs/MERCHANT_PLATFORM.md §2 decisions 3–4, §4.2).
 *
 * The merchant sets the delivery of their own store; Levonis never prices it.
 * The fee is computed ON THE SERVER from the customer's SAVED address →
 * governorate → this configuration, at the quote and again at place-order.
 * The Worker is the authority (worker/routes/storeOrders.ts); the merchant's
 * editor and the storefront import the same functions only to SHOW what the
 * server will do. Nothing a client sends is ever a fee.
 *
 * THE MODEL.
 *   · a PROFILE per store: the default mode (fee | free | disabled) and fee,
 *     the free-delivery threshold, pickup, preparation days, a note, and a
 *     VERSION bumped by every save (the quote fingerprint binds it);
 *   · RULES per governorate, only where the merchant departs from the
 *     default: fee (an override), free, or disabled — plus an optional
 *     threshold, preparation days, an ETA line and a note of their own.
 *
 * PRECEDENCE (resolveMerchantDelivery):
 *   pickup chosen  → the pickup switch alone decides; fee 0
 *   no governorate → unavailable, `governorate_required` (never the default)
 *   disabled       → unavailable, `governorate_disabled`
 *   free rule      → 0 (`free_governorate`)
 *   override fee   → the rule's fee (`override`)
 *   default        → the profile's fee, or 0 when the default is free
 *   then the free-over threshold (the rule's own, else the store's) sets a
 *   positive fee to 0 (`free_over`) when the merchandise reaches it.
 *
 * Pickup is a PLACE, not a governorate: a customer whose address lies in a
 * governorate the store does not deliver to may still collect from the store,
 * and a legacy address with no governorate is fine for pickup (it only gives
 * the store a name and a phone).
 *
 * THE THRESHOLD'S BASIS is the merchandise AFTER the merchant's coupon
 * (`after_discount`, audit 02 B22, docs/DECISIONS.md): a 50% code on a 14,000
 * cart does not earn a 14,000 free-delivery threshold for a customer paying
 * 7,000. It is recorded on every profile so a different basis would be a
 * visible migration, never a silent change of meaning.
 *
 * Integer dinars throughout, never negative. Pure: no I/O, no bindings.
 */
import { IRAQ_GOVERNORATES, normalizeGovernorate } from './iraqGovernorates';

export const DELIVERY_MODES = ['fee', 'free', 'disabled'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const FULFILMENTS = ['delivery', 'pickup'] as const;
export type Fulfilment = (typeof FULFILMENTS)[number];

export const DELIVERY_RULE_KINDS = ['override', 'default', 'free_governorate', 'free_over', 'pickup'] as const;
export type DeliveryRuleKind = (typeof DELIVERY_RULE_KINDS)[number];

export type DeliveryUnavailableReason = 'governorate_required' | 'governorate_disabled' | 'pickup_disabled';

export const FREE_OVER_BASIS = 'after_discount' as const;
export type FreeOverBasis = typeof FREE_OVER_BASIS;

/** The bounds the API, the database CHECKs and the editor share. The fee cap is the one wave 1 already used. */
export const DELIVERY_LIMITS = {
  fee_iqd: 1_000_000,
  free_over_iqd: 1_000_000_000,
  prep_days: 60,
  note: 200,
  pickup_note: 200,
  eta_note: 80,
  rule_note: 120,
} as const;

/**
 * THE PLATFORM'S MAXIMUM MERCHANT DELIVERY FEE (owner decision 2026-09-25,
 * review W2-5 finding 2). Commission is taken on the goods, not the delivery,
 * so an uncapped fee let a store sell at 0 IQD and charge the price as
 * «delivery». The owner sets the cap in the community admin
 * (`merchantDeliveryFeeMaxIqd`); this is its default. It bounds every fee a
 * store may SAVE (the validator's `maxFeeIqd`) and every fee a checkout
 * CHARGES (the resolver clamps a stored fee above the current cap to it).
 */
export const DEFAULT_MERCHANT_DELIVERY_FEE_MAX_IQD = 25_000;

/** A cap as the resolver applies it: a whole, non-negative number, or none. */
function capOf(max: number | null | undefined): number | null {
  return typeof max === 'number' && Number.isFinite(max) && max >= 0 ? Math.floor(max) : null;
}
const clampFee = (fee: number, max: number | null | undefined): number => {
  const cap = capOf(max);
  return cap === null ? fee : Math.min(fee, cap);
};

/** The eighteen ids, in the government's order. */
export const GOVERNORATE_IDS: readonly string[] = IRAQ_GOVERNORATES.map((g) => g.id);
const IDS = new Set(GOVERNORATE_IDS);

export interface MerchantDeliveryProfile {
  default_mode: DeliveryMode;
  default_fee_iqd: number;
  /** Merchandise (after the coupon) at or above which a positive fee becomes 0; null = no threshold. */
  free_over_iqd: number | null;
  free_over_basis: FreeOverBasis;
  pickup_enabled: boolean;
  /** Where pickup happens — a closed-list id, '' when pickup is off. */
  pickup_governorate: string;
  pickup_note: string;
  prep_days: number;
  note: string;
  /** 0 = no stored profile yet (the legacy settings stand in); every save bumps it. */
  version: number;
}

export interface MerchantDeliveryRule {
  governorate_id: string;
  mode: DeliveryMode;
  /** Required for `fee`; null otherwise. */
  fee_iqd: number | null;
  /** This governorate's own threshold; null = the store's. */
  free_over_iqd: number | null;
  /** This governorate's own preparation days; null = the store's. */
  prep_days: number | null;
  eta_note: string;
  note: string;
}

export interface MerchantDeliveryResolution {
  available: boolean;
  reason: DeliveryUnavailableReason | null;
  fulfilment: Fulfilment;
  /** Delivery: the address's governorate id ('' when it has none). Pickup: the pickup point's. */
  governorate: string;
  fee_iqd: number;
  /** The fee before the threshold — what is charged below it. */
  base_fee_iqd: number;
  rule: DeliveryRuleKind | null;
  /** The threshold that applies here, or null. */
  free_over_iqd: number | null;
  prep_days: number;
  eta_note: string;
  note: string;
  profile_version: number;
}

/** A store that never configured anything: free delivery everywhere — what an empty settings row always meant. */
export const DEFAULT_DELIVERY_PROFILE: MerchantDeliveryProfile = Object.freeze({
  default_mode: 'free',
  default_fee_iqd: 0,
  free_over_iqd: null,
  free_over_basis: FREE_OVER_BASIS,
  pickup_enabled: false,
  pickup_governorate: '',
  pickup_note: '',
  prep_days: 0,
  note: '',
  version: 0,
}) as MerchantDeliveryProfile;

const whole = (x: unknown): number => {
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const positiveOrNull = (x: unknown): number | null => {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};
const isFee = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

function parseObject(raw: unknown): Record<string, unknown> {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The profile the LEGACY settings (`merchant_stores.delivery_settings`, wave 1)
 * describe — exactly what migration 0120 backfills, and what a store with no
 * stored profile is priced by (version 0). The old checkout charged
 * `floor(fee_iqd)` when positive and nothing otherwise, and waived a positive
 * fee once the goods reached `free_over_iqd`; an integer basket reaches a
 * fractional threshold x exactly when it reaches ceil(x).
 */
export function profileFromLegacySettings(raw: unknown): MerchantDeliveryProfile {
  const s = parseObject(raw);
  const feeNum = Number(s.fee_iqd);
  const fee = Number.isFinite(feeNum) && feeNum > 0 ? Math.min(Math.floor(feeNum), DELIVERY_LIMITS.fee_iqd) : 0;
  const foNum = Number(s.free_over_iqd);
  const freeOver =
    Number.isFinite(foNum) && foNum > 0 ? Math.min(Math.ceil(foNum), DELIVERY_LIMITS.free_over_iqd) : null;
  const note = typeof s.note === 'string' ? s.note.trim().slice(0, DELIVERY_LIMITS.note) : '';
  return {
    ...DEFAULT_DELIVERY_PROFILE,
    default_mode: fee > 0 ? 'fee' : 'free',
    default_fee_iqd: fee,
    free_over_iqd: freeOver,
    note,
  };
}

/**
 * The legacy settings a profile is MIRRORED into on every save, so a rollback
 * of the code still charges the merchant's latest default. The old checkout
 * cannot refuse a governorate, so a disabled default mirrors its fee value.
 */
export function legacySettingsFromProfile(p: MerchantDeliveryProfile): Record<string, unknown> {
  const out: Record<string, unknown> = { fee_iqd: p.default_mode === 'free' ? 0 : whole(p.default_fee_iqd) };
  if (p.free_over_iqd) out.free_over_iqd = p.free_over_iqd;
  if (p.note) out.note = p.note;
  return out;
}

/**
 * The legacy settings as the wave-1 store form writes them (the PATCH
 * /api/merchant/store sanitiser's rules), in a canonical form — so the door can
 * tell an unchanged echo from a real edit.
 */
export function canonicalLegacySettings(raw: unknown): Record<string, unknown> {
  const s = parseObject(raw);
  const out: Record<string, unknown> = {};
  const fee = Number(s.fee_iqd);
  const freeOver = Number(s.free_over_iqd);
  if (s.fee_iqd !== undefined && s.fee_iqd !== null && Number.isFinite(fee) && fee >= 0) {
    out.fee_iqd = Math.floor(Math.min(fee, DELIVERY_LIMITS.fee_iqd));
  }
  if (Number.isFinite(freeOver) && freeOver > 0) out.free_over_iqd = Math.floor(Math.min(freeOver, DELIVERY_LIMITS.free_over_iqd));
  if (typeof s.note === 'string' && s.note.trim()) out.note = s.note.trim().slice(0, DELIVERY_LIMITS.note);
  return out;
}

/** A stored profile row, defensively typed. Anything out of range is clamped into it. */
export function normalizeStoredProfile(row: Record<string, unknown>): MerchantDeliveryProfile {
  const mode = (DELIVERY_MODES as readonly string[]).includes(String(row.default_mode))
    ? (String(row.default_mode) as DeliveryMode)
    : 'disabled';
  const pickupGov = IDS.has(String(row.pickup_governorate ?? '')) ? String(row.pickup_governorate) : '';
  return {
    default_mode: mode,
    default_fee_iqd: Math.min(whole(row.default_fee_iqd), DELIVERY_LIMITS.fee_iqd),
    free_over_iqd: positiveOrNull(row.free_over_iqd),
    free_over_basis: FREE_OVER_BASIS,
    pickup_enabled: Number(row.pickup_enabled) === 1 || row.pickup_enabled === true,
    pickup_governorate: pickupGov,
    pickup_note: String(row.pickup_note ?? ''),
    prep_days: Math.min(whole(row.prep_days), DELIVERY_LIMITS.prep_days),
    note: String(row.note ?? ''),
    version: whole(row.version),
  };
}

/**
 * A stored rule row, defensively typed — or null for a row naming no
 * governorate. A `fee` rule without a usable fee FAILS CLOSED: it reads as
 * disabled rather than as free delivery nobody configured.
 */
export function normalizeStoredRule(row: Record<string, unknown>): MerchantDeliveryRule | null {
  const gov = String(row.governorate_id ?? '');
  if (!IDS.has(gov)) return null;
  let mode = (DELIVERY_MODES as readonly string[]).includes(String(row.mode)) ? (String(row.mode) as DeliveryMode) : 'disabled';
  const feeRaw = row.fee_iqd === null || row.fee_iqd === undefined ? null : Number(row.fee_iqd);
  let fee: number | null = null;
  if (mode === 'fee') {
    if (feeRaw === null || !Number.isFinite(feeRaw) || feeRaw < 0) mode = 'disabled';
    else fee = Math.floor(feeRaw);
  }
  const prep = row.prep_days === null || row.prep_days === undefined ? null : Math.min(whole(row.prep_days), DELIVERY_LIMITS.prep_days);
  return {
    governorate_id: gov,
    mode,
    fee_iqd: fee,
    free_over_iqd: mode === 'disabled' ? null : positiveOrNull(row.free_over_iqd),
    prep_days: prep,
    eta_note: String(row.eta_note ?? ''),
    note: String(row.note ?? ''),
  };
}

function ruleFor(rules: readonly MerchantDeliveryRule[], gov: string): MerchantDeliveryRule | null {
  for (const r of rules) if (r.governorate_id === gov) return r;
  return null;
}

/** The mode a governorate is served under: its own rule, else the default. */
export function effectiveMode(p: MerchantDeliveryProfile, rules: readonly MerchantDeliveryRule[], gov: string): DeliveryMode {
  const rule = ruleFor(rules, gov);
  if (rule) return rule.mode === 'fee' && !isFee(rule.fee_iqd) ? 'disabled' : rule.mode;
  return p.default_mode;
}

/**
 * THE RESOLVER. `merchandiseIqd` is what the customer pays for the goods
 * after the merchant's coupon (the threshold's basis). Never throws; an
 * unavailable answer carries its reason and a fee of 0.
 */
export function resolveMerchantDelivery(
  profile: MerchantDeliveryProfile,
  rules: readonly MerchantDeliveryRule[],
  governorateId: unknown,
  merchandiseIqd: number,
  fulfilment: Fulfilment = 'delivery',
  /** The platform's current maximum fee: a stored fee above it is charged AT it, never above. */
  maxFeeIqd?: number | null
): MerchantDeliveryResolution {
  const version = whole(profile.version);
  const merchandise = whole(merchandiseIqd);
  const base = {
    fulfilment,
    fee_iqd: 0,
    base_fee_iqd: 0,
    free_over_iqd: null as number | null,
    eta_note: '',
    profile_version: version,
  };

  if (fulfilment === 'pickup') {
    const at = IDS.has(profile.pickup_governorate) ? profile.pickup_governorate : '';
    if (!profile.pickup_enabled) {
      return { ...base, available: false, reason: 'pickup_disabled', governorate: at, rule: null, prep_days: 0, note: '' };
    }
    return {
      ...base,
      available: true,
      reason: null,
      governorate: at,
      rule: 'pickup',
      prep_days: whole(profile.prep_days),
      note: profile.pickup_note,
    };
  }

  const gov = normalizeGovernorate(governorateId);
  if (!gov) {
    return { ...base, available: false, reason: 'governorate_required', governorate: '', rule: null, prep_days: 0, note: '' };
  }
  const rule = ruleFor(rules, gov);
  const mode = effectiveMode(profile, rules, gov);
  if (mode === 'disabled') {
    return { ...base, available: false, reason: 'governorate_disabled', governorate: gov, rule: null, prep_days: 0, note: '' };
  }

  let kind: DeliveryRuleKind;
  let baseFee: number;
  if (mode === 'free') {
    kind = rule ? 'free_governorate' : 'default';
    baseFee = 0;
  } else if (rule) {
    kind = 'override';
    baseFee = clampFee(whole(rule.fee_iqd), maxFeeIqd);
  } else {
    kind = 'default';
    baseFee = clampFee(whole(profile.default_fee_iqd), maxFeeIqd);
  }
  const threshold = rule && rule.free_over_iqd !== null ? positiveOrNull(rule.free_over_iqd) : positiveOrNull(profile.free_over_iqd);
  let fee = baseFee;
  if (fee > 0 && threshold !== null && merchandise >= threshold) {
    fee = 0;
    kind = 'free_over';
  }
  return {
    ...base,
    available: true,
    reason: null,
    governorate: gov,
    fee_iqd: fee,
    base_fee_iqd: baseFee,
    rule: kind,
    free_over_iqd: baseFee > 0 ? threshold : null,
    prep_days: whole(rule && rule.prep_days !== null ? rule.prep_days : profile.prep_days),
    eta_note: rule?.eta_note ?? '',
    note: (rule?.note || profile.note) ?? '',
  };
}

/** One governorate as the store serves it — for the storefront and the editor's summary. */
export interface GovernorateDelivery {
  governorate: string;
  mode: DeliveryMode;
  /** The fee before any threshold (0 for free). */
  fee_iqd: number;
  free_over_iqd: number | null;
  prep_days: number;
  eta_note: string;
  /** Whether a rule of the governorate's own decides it. */
  custom: boolean;
}

export function deliveryTable(
  p: MerchantDeliveryProfile,
  rules: readonly MerchantDeliveryRule[],
  /** The platform's maximum fee, as the resolver applies it. */
  maxFeeIqd?: number | null
): GovernorateDelivery[] {
  return GOVERNORATE_IDS.map((gov) => {
    const rule = ruleFor(rules, gov);
    const mode = effectiveMode(p, rules, gov);
    const fee = mode === 'fee' ? clampFee(whole(rule ? rule.fee_iqd : p.default_fee_iqd), maxFeeIqd) : 0;
    const threshold = rule && rule.free_over_iqd !== null ? rule.free_over_iqd : p.free_over_iqd;
    return {
      governorate: gov,
      mode,
      fee_iqd: fee,
      free_over_iqd: mode === 'fee' && fee > 0 ? threshold : null,
      prep_days: whole(rule && rule.prep_days !== null ? rule.prep_days : p.prep_days),
      eta_note: rule?.eta_note ?? '',
      custom: !!rule,
    };
  });
}

/** Where the store delivers, in the government's order. */
export function servedGovernorates(p: MerchantDeliveryProfile, rules: readonly MerchantDeliveryRule[]): string[] {
  return GOVERNORATE_IDS.filter((gov) => effectiveMode(p, rules, gov) !== 'disabled');
}

/** Can a customer anywhere receive this store's goods at all — delivery somewhere, or pickup? */
export function deliveryCoverage(p: MerchantDeliveryProfile, rules: readonly MerchantDeliveryRule[]) {
  const served = servedGovernorates(p, rules);
  return { served, pickup: !!p.pickup_enabled, serviceable: served.length > 0 || !!p.pickup_enabled };
}

// ------------------------------------------------------------ validation

export type DeliveryIssueCode =
  | 'invalid'
  | 'mode'
  | 'not_integer'
  | 'fee_required'
  | 'fee_range'
  | 'free_over_range'
  | 'prep_days_range'
  | 'governorate_unknown'
  | 'governorate_duplicate'
  | 'too_long'
  | 'pickup_governorate_required'
  | 'too_many_rules'
  /** Above the platform's maximum delivery fee (`maxFeeIqd`). */
  | 'fee_above_max';

export interface DeliveryIssue {
  /** `profile.<field>` or `rules.<governorate id>.<field>` (`rules[<i>]` when the entry names none). */
  path: string;
  code: DeliveryIssueCode;
}

export type DeliveryConfigInput = Omit<MerchantDeliveryProfile, 'version'>;

export type DeliveryValidation =
  | { ok: true; profile: DeliveryConfigInput; rules: MerchantDeliveryRule[] }
  | { ok: false; issues: DeliveryIssue[] };

/**
 * STRICT validation of an editor's `{profile, rules}` — the one the Worker's
 * PUT answers with and the editor checks as the merchant types. Values are
 * never coerced: a string where a number belongs, a fraction of a dinar, an
 * id outside the closed list, a second rule for one governorate — each is an
 * issue with its path. Unknown keys are ignored (the output is built field by
 * field from this allow-list).
 */
export function validateDeliveryConfig(
  input: { profile?: unknown; rules?: unknown },
  /** `maxFeeIqd`: the platform's maximum delivery fee — a fee above it is `fee_above_max`. */
  opts: { maxFeeIqd?: number | null } = {}
): DeliveryValidation {
  const issues: DeliveryIssue[] = [];
  const add = (path: string, code: DeliveryIssueCode) => issues.push({ path, code });
  const cap = capOf(opts.maxFeeIqd);

  const intIn = (v: unknown, path: string, min: number, max: number, codeRange: DeliveryIssueCode): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      add(path, 'not_integer');
      return null;
    }
    if (v < min || v > max) {
      add(path, codeRange);
      return null;
    }
    return v;
  };
  /** A fee in range, and under the platform's cap when one is given. */
  const feeIn = (v: unknown, path: string): number | null => {
    const fee = intIn(v, path, 0, DELIVERY_LIMITS.fee_iqd, 'fee_range');
    if (fee !== null && cap !== null && fee > cap) {
      add(path, 'fee_above_max');
      return null;
    }
    return fee;
  };
  const text = (v: unknown, path: string, max: number): string => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') {
      add(path, 'invalid');
      return '';
    }
    const t = v.trim();
    if (t.length > max) add(path, 'too_long');
    return t.slice(0, max);
  };
  const optionalInt = (v: unknown, path: string, min: number, max: number, code: DeliveryIssueCode): number | null =>
    v === undefined || v === null ? null : intIn(v, path, min, max, code);

  const raw = input.profile;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: 'profile', code: 'invalid' }] };
  }
  const p = raw as Record<string, unknown>;
  const mode = (DELIVERY_MODES as readonly unknown[]).includes(p.default_mode) ? (p.default_mode as DeliveryMode) : null;
  if (!mode) add('profile.default_mode', 'mode');
  let defaultFee = 0;
  if (p.default_fee_iqd === undefined || p.default_fee_iqd === null) {
    if (mode === 'fee') add('profile.default_fee_iqd', 'fee_required');
  } else {
    defaultFee = feeIn(p.default_fee_iqd, 'profile.default_fee_iqd') ?? 0;
  }
  const freeOver = optionalInt(p.free_over_iqd, 'profile.free_over_iqd', 1, DELIVERY_LIMITS.free_over_iqd, 'free_over_range');
  if (p.free_over_basis !== undefined && p.free_over_basis !== FREE_OVER_BASIS) add('profile.free_over_basis', 'invalid');
  if (p.pickup_enabled !== undefined && typeof p.pickup_enabled !== 'boolean') add('profile.pickup_enabled', 'invalid');
  const pickupEnabled = p.pickup_enabled === true;
  let pickupGov = '';
  if (p.pickup_governorate !== undefined && p.pickup_governorate !== null && p.pickup_governorate !== '') {
    if (typeof p.pickup_governorate !== 'string' || !IDS.has(p.pickup_governorate)) add('profile.pickup_governorate', 'governorate_unknown');
    else pickupGov = p.pickup_governorate;
  }
  if (pickupEnabled && !pickupGov && !issues.some((i) => i.path === 'profile.pickup_governorate')) {
    add('profile.pickup_governorate', 'pickup_governorate_required');
  }
  const pickupNote = text(p.pickup_note, 'profile.pickup_note', DELIVERY_LIMITS.pickup_note);
  const prep = p.prep_days === undefined || p.prep_days === null ? 0 : intIn(p.prep_days, 'profile.prep_days', 0, DELIVERY_LIMITS.prep_days, 'prep_days_range') ?? 0;
  const note = text(p.note, 'profile.note', DELIVERY_LIMITS.note);

  const rules: MerchantDeliveryRule[] = [];
  const rawRules = input.rules === undefined || input.rules === null ? [] : input.rules;
  if (!Array.isArray(rawRules)) {
    add('rules', 'invalid');
  } else if (rawRules.length > GOVERNORATE_IDS.length) {
    add('rules', 'too_many_rules');
  } else {
    const seen = new Set<string>();
    rawRules.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        add(`rules[${i}]`, 'invalid');
        return;
      }
      const r = entry as Record<string, unknown>;
      const gov = typeof r.governorate_id === 'string' && IDS.has(r.governorate_id) ? r.governorate_id : '';
      if (!gov) {
        add(`rules[${i}].governorate_id`, 'governorate_unknown');
        return;
      }
      const at = `rules.${gov}`;
      if (seen.has(gov)) {
        add(`${at}.governorate_id`, 'governorate_duplicate');
        return;
      }
      seen.add(gov);
      const rMode = (DELIVERY_MODES as readonly unknown[]).includes(r.mode) ? (r.mode as DeliveryMode) : null;
      if (!rMode) {
        add(`${at}.mode`, 'mode');
        return;
      }
      let fee: number | null = null;
      if (rMode === 'fee') {
        if (r.fee_iqd === undefined || r.fee_iqd === null) add(`${at}.fee_iqd`, 'fee_required');
        else fee = feeIn(r.fee_iqd, `${at}.fee_iqd`);
      }
      const fo = rMode === 'disabled' ? null : optionalInt(r.free_over_iqd, `${at}.free_over_iqd`, 1, DELIVERY_LIMITS.free_over_iqd, 'free_over_range');
      const rPrep = optionalInt(r.prep_days, `${at}.prep_days`, 0, DELIVERY_LIMITS.prep_days, 'prep_days_range');
      rules.push({
        governorate_id: gov,
        mode: rMode,
        fee_iqd: fee,
        free_over_iqd: fo,
        prep_days: rPrep,
        eta_note: text(r.eta_note, `${at}.eta_note`, DELIVERY_LIMITS.eta_note),
        note: text(r.note, `${at}.note`, DELIVERY_LIMITS.rule_note),
      });
    });
  }

  if (issues.length || !mode) return { ok: false, issues };
  rules.sort((a, b) => GOVERNORATE_IDS.indexOf(a.governorate_id) - GOVERNORATE_IDS.indexOf(b.governorate_id));
  return {
    ok: true,
    profile: {
      default_mode: mode,
      default_fee_iqd: defaultFee,
      free_over_iqd: freeOver,
      free_over_basis: FREE_OVER_BASIS,
      pickup_enabled: pickupEnabled,
      pickup_governorate: pickupGov,
      pickup_note: pickupNote,
      prep_days: prep,
      note,
    },
    rules,
  };
}
