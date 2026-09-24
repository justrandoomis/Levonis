/**
 * The delivery editor's state, as plain data (merchant platform W2-A) — kept
 * out of the component so the round trip server → draft → payload is testable
 * without a browser (tests/deliveryEditorModel.test.ts).
 *
 * A DRAFT holds what the merchant is typing: a governorate row is `default`
 * (no rule — it follows the store default) or one of the three modes; numbers
 * are `null` while a field is empty. The PAYLOAD is exactly what
 * PUT /api/merchant/delivery validates (packages/shipping/src/merchantDelivery.ts
 * `validateDeliveryConfig`), which the editor also runs as the merchant types.
 */
import {
  GOVERNORATE_IDS,
  deliveryCoverage,
  validateDeliveryConfig,
  type DeliveryConfigInput,
  type DeliveryIssue,
  type DeliveryMode,
  type MerchantDeliveryProfile,
  type MerchantDeliveryRule,
} from '../../../../packages/shipping/src/merchantDelivery';

export type RowMode = 'default' | DeliveryMode;

export interface RuleDraft {
  mode: RowMode;
  fee_iqd: number | null;
  free_over_iqd: number | null;
  prep_days: number | null;
  eta_note: string;
  note: string;
}

export interface DeliveryDraft {
  default_mode: DeliveryMode;
  default_fee_iqd: number | null;
  free_over_on: boolean;
  free_over_iqd: number | null;
  pickup_enabled: boolean;
  pickup_governorate: string;
  pickup_note: string;
  prep_days: number | null;
  note: string;
  rules: Record<string, RuleDraft>;
}

export const emptyRule = (): RuleDraft => ({ mode: 'default', fee_iqd: null, free_over_iqd: null, prep_days: null, eta_note: '', note: '' });

/** The draft for a stored configuration. `storeGovernorate` seeds the pickup place when none is set. */
export function draftFromConfig(
  cfg: { profile: MerchantDeliveryProfile; rules: MerchantDeliveryRule[] },
  storeGovernorate = ''
): DeliveryDraft {
  const rules: Record<string, RuleDraft> = {};
  for (const id of GOVERNORATE_IDS) rules[id] = emptyRule();
  for (const r of cfg.rules) {
    rules[r.governorate_id] = {
      mode: r.mode,
      fee_iqd: r.fee_iqd,
      free_over_iqd: r.free_over_iqd,
      prep_days: r.prep_days,
      eta_note: r.eta_note,
      note: r.note,
    };
  }
  const p = cfg.profile;
  return {
    default_mode: p.default_mode,
    default_fee_iqd: p.default_fee_iqd,
    free_over_on: p.free_over_iqd !== null,
    free_over_iqd: p.free_over_iqd,
    pickup_enabled: p.pickup_enabled,
    pickup_governorate: p.pickup_governorate || (GOVERNORATE_IDS.includes(storeGovernorate) ? storeGovernorate : ''),
    pickup_note: p.pickup_note,
    prep_days: p.prep_days,
    note: p.note,
    rules,
  };
}

/** What the server is sent: the profile, and a rule only where a governorate departs from the default. */
export function payloadFromDraft(d: DeliveryDraft): { profile: DeliveryConfigInput; rules: MerchantDeliveryRule[] } {
  const rules: MerchantDeliveryRule[] = [];
  for (const id of GOVERNORATE_IDS) {
    const r = d.rules[id];
    if (!r || r.mode === 'default') continue;
    rules.push({
      governorate_id: id,
      mode: r.mode,
      fee_iqd: r.mode === 'fee' ? r.fee_iqd : null,
      free_over_iqd: r.mode === 'disabled' ? null : r.free_over_iqd,
      prep_days: r.prep_days,
      eta_note: r.eta_note.trim(),
      note: r.note.trim(),
    });
  }
  return {
    profile: {
      default_mode: d.default_mode,
      default_fee_iqd: d.default_fee_iqd ?? 0,
      free_over_iqd: d.free_over_on ? d.free_over_iqd : null,
      free_over_basis: 'after_discount',
      pickup_enabled: d.pickup_enabled,
      pickup_governorate: d.pickup_governorate,
      pickup_note: d.pickup_note.trim(),
      prep_days: d.prep_days ?? 0,
      note: d.note.trim(),
    },
    rules,
  };
}

/** The server's own check, run on the draft — issues keyed by path for the fields. */
export function draftIssues(d: DeliveryDraft): DeliveryIssue[] {
  const payload = payloadFromDraft(d);
  const issues: DeliveryIssue[] = [];
  if (d.default_mode === 'fee' && d.default_fee_iqd === null) issues.push({ path: 'profile.default_fee_iqd', code: 'fee_required' });
  if (d.free_over_on && d.free_over_iqd === null) issues.push({ path: 'profile.free_over_iqd', code: 'free_over_range' });
  const v = validateDeliveryConfig(payload);
  if ('issues' in v) for (const i of v.issues) if (!issues.some((x) => x.path === i.path)) issues.push(i);
  return issues;
}

/** Where the draft delivers, and whether a customer could receive anything at all. */
export function draftCoverage(d: DeliveryDraft) {
  const p = payloadFromDraft(d);
  return deliveryCoverage({ ...p.profile, version: 0 }, p.rules);
}

/** Stable for comparing the draft against what was loaded (dirty state). */
export const draftKey = (d: DeliveryDraft) => JSON.stringify(payloadFromDraft(d));

/** The row's own words: what a customer in this governorate is charged. */
export function rowAnswer(d: DeliveryDraft, id: string): { mode: DeliveryMode; fee: number | null; custom: boolean } {
  const r = d.rules[id] ?? emptyRule();
  if (r.mode === 'default') return { mode: d.default_mode, fee: d.default_mode === 'fee' ? d.default_fee_iqd : null, custom: false };
  return { mode: r.mode, fee: r.mode === 'fee' ? r.fee_iqd : null, custom: true };
}
