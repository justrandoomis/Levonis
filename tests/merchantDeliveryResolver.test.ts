/**
 * THE MERCHANT DELIVERY RESOLVER — packages/shipping/src/merchantDelivery.ts
 * (merchant platform W2-A, docs/MERCHANT_PLATFORM.md §4.2). Pure units: the
 * precedence, the threshold, pickup, integer dinars, the legacy mapping, the
 * strict validator the Worker and the editor share, and coverage.
 *
 * Run: node --import tsx --test tests/merchantDeliveryResolver.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DELIVERY_PROFILE,
  DELIVERY_LIMITS,
  GOVERNORATE_IDS,
  canonicalLegacySettings,
  deliveryCoverage,
  deliveryTable,
  legacySettingsFromProfile,
  normalizeStoredProfile,
  normalizeStoredRule,
  profileFromLegacySettings,
  resolveMerchantDelivery,
  servedGovernorates,
  validateDeliveryConfig,
  type MerchantDeliveryProfile,
  type MerchantDeliveryRule,
} from '../packages/shipping/src/merchantDelivery';

const profile = (p: Partial<MerchantDeliveryProfile> = {}): MerchantDeliveryProfile => ({
  ...DEFAULT_DELIVERY_PROFILE,
  default_mode: 'fee',
  default_fee_iqd: 5000,
  version: 3,
  ...p,
});
const rule = (governorate_id: string, r: Partial<MerchantDeliveryRule> = {}): MerchantDeliveryRule => ({
  governorate_id,
  mode: 'fee',
  fee_iqd: 8000,
  free_over_iqd: null,
  prep_days: null,
  eta_note: '',
  note: '',
  ...r,
});

// ------------------------------------------------------------- precedence

test('the default fee prices a governorate with no rule of its own', () => {
  const r = resolveMerchantDelivery(profile(), [], 'baghdad', 20_000);
  assert.deepEqual(
    { available: r.available, fee: r.fee_iqd, base: r.base_fee_iqd, rule: r.rule, gov: r.governorate, v: r.profile_version },
    { available: true, fee: 5000, base: 5000, rule: 'default', gov: 'baghdad', v: 3 }
  );
});

test('an override fee beats the default, only for its governorate', () => {
  const rules = [rule('basra', { fee_iqd: 9000 })];
  assert.equal(resolveMerchantDelivery(profile(), rules, 'basra', 0).fee_iqd, 9000);
  assert.equal(resolveMerchantDelivery(profile(), rules, 'basra', 0).rule, 'override');
  assert.equal(resolveMerchantDelivery(profile(), rules, 'baghdad', 0).fee_iqd, 5000);
});

test('a free governorate is 0 whatever the default, and says why', () => {
  const r = resolveMerchantDelivery(profile(), [rule('baghdad', { mode: 'free', fee_iqd: null })], 'baghdad', 0);
  assert.equal(r.fee_iqd, 0);
  assert.equal(r.rule, 'free_governorate');
  assert.equal(r.free_over_iqd, null);
});

test('a disabled governorate is unavailable — before any fee, threshold or free default', () => {
  for (const p of [profile(), profile({ default_mode: 'free' }), profile({ free_over_iqd: 1 })]) {
    const r = resolveMerchantDelivery(p, [rule('duhok', { mode: 'disabled', fee_iqd: null })], 'duhok', 10_000_000);
    assert.equal(r.available, false);
    assert.equal(r.reason, 'governorate_disabled');
    assert.equal(r.fee_iqd, 0);
    assert.equal(r.rule, null);
  }
});

test('a disabled DEFAULT serves only the governorates a rule opens', () => {
  const p = profile({ default_mode: 'disabled' });
  const rules = [rule('baghdad', { fee_iqd: 3000 }), rule('erbil', { mode: 'free', fee_iqd: null })];
  assert.equal(resolveMerchantDelivery(p, rules, 'basra', 0).reason, 'governorate_disabled');
  assert.equal(resolveMerchantDelivery(p, rules, 'baghdad', 0).fee_iqd, 3000);
  assert.equal(resolveMerchantDelivery(p, rules, 'erbil', 0).rule, 'free_governorate');
  assert.deepEqual(servedGovernorates(p, rules), ['baghdad', 'erbil']);
});

test('a free DEFAULT is 0 with the default rule, and a fee rule still charges', () => {
  const p = profile({ default_mode: 'free' });
  const free = resolveMerchantDelivery(p, [], 'najaf', 0);
  assert.equal(free.fee_iqd, 0);
  assert.equal(free.rule, 'default');
  assert.equal(resolveMerchantDelivery(p, [rule('najaf', { fee_iqd: 4000 })], 'najaf', 0).fee_iqd, 4000);
});

test('no governorate is REFUSED, never priced at the default (a legacy address)', () => {
  for (const g of ['', '   ', 'Atlantis', null, undefined, 42]) {
    const r = resolveMerchantDelivery(profile(), [], g, 0);
    assert.equal(r.available, false, String(g));
    assert.equal(r.reason, 'governorate_required');
    assert.equal(r.fee_iqd, 0);
  }
});

test('a governorate NAME in any language resolves to its id (legacy free-text addresses)', () => {
  const rules = [rule('baghdad', { fee_iqd: 2500 })];
  for (const g of ['بغداد', 'Baghdad', 'baghdad', 'بەغدا']) {
    const r = resolveMerchantDelivery(profile(), rules, g, 0);
    assert.equal(r.governorate, 'baghdad');
    assert.equal(r.fee_iqd, 2500);
  }
});

// -------------------------------------------------------------- threshold

test('the store threshold waives a positive fee at or above it — judged on the merchandise passed in', () => {
  const p = profile({ free_over_iqd: 50_000 });
  const below = resolveMerchantDelivery(p, [], 'baghdad', 49_999);
  assert.deepEqual([below.fee_iqd, below.rule, below.free_over_iqd], [5000, 'default', 50_000]);
  const at = resolveMerchantDelivery(p, [], 'baghdad', 50_000);
  assert.deepEqual([at.fee_iqd, at.base_fee_iqd, at.rule], [0, 5000, 'free_over']);
});

test('a governorate threshold replaces the store one for that governorate only', () => {
  const p = profile({ free_over_iqd: 50_000 });
  const rules = [rule('basra', { fee_iqd: 9000, free_over_iqd: 100_000 })];
  assert.equal(resolveMerchantDelivery(p, rules, 'basra', 60_000).fee_iqd, 9000);
  assert.equal(resolveMerchantDelivery(p, rules, 'basra', 100_000).rule, 'free_over');
  assert.equal(resolveMerchantDelivery(p, rules, 'baghdad', 60_000).fee_iqd, 0);
});

test('a threshold never turns a free delivery into a free_over one', () => {
  const p = profile({ default_mode: 'free', free_over_iqd: 1 });
  const r = resolveMerchantDelivery(p, [], 'baghdad', 1_000_000);
  assert.equal(r.rule, 'default');
  assert.equal(r.free_over_iqd, null);
});

// ---------------------------------------------------------------- pickup

test('pickup is 0 when offered, whatever the address governorate — even a disabled one or none', () => {
  const p = profile({ pickup_enabled: true, pickup_governorate: 'baghdad', pickup_note: 'Karrada, call first', prep_days: 2 });
  const rules = [rule('basra', { mode: 'disabled', fee_iqd: null })];
  for (const g of ['basra', '', 'baghdad']) {
    const r = resolveMerchantDelivery(p, rules, g, 0, 'pickup');
    assert.deepEqual(
      [r.available, r.fee_iqd, r.rule, r.governorate, r.note, r.prep_days],
      [true, 0, 'pickup', 'baghdad', 'Karrada, call first', 2]
    );
  }
});

test('pickup is refused when the store does not offer it', () => {
  const r = resolveMerchantDelivery(profile(), [], 'baghdad', 0, 'pickup');
  assert.equal(r.available, false);
  assert.equal(r.reason, 'pickup_disabled');
});

// ----------------------------------------------------- integer, never negative

test('integer dinars, never negative: garbage is floored or failed closed', () => {
  const r = resolveMerchantDelivery(profile({ default_fee_iqd: 4999.9 }), [], 'baghdad', -5);
  assert.equal(r.fee_iqd, 4999);
  const neg = resolveMerchantDelivery(profile({ default_fee_iqd: -100 }), [], 'baghdad', 0);
  assert.equal(neg.fee_iqd, 0);
  // A fee rule WITHOUT a usable fee is not "free delivery nobody set": it is not served.
  const broken = resolveMerchantDelivery(profile(), [rule('basra', { fee_iqd: null })], 'basra', 0);
  assert.equal(broken.reason, 'governorate_disabled');
  for (const g of GOVERNORATE_IDS) {
    for (const m of [0, 1, 10_000, 1e9]) {
      const x = resolveMerchantDelivery(profile({ free_over_iqd: 10_000 }), [rule('basra', { fee_iqd: 7777 })], g, m);
      assert.ok(Number.isInteger(x.fee_iqd) && x.fee_iqd >= 0);
    }
  }
});

test('preparation days, the ETA line and the note come from the rule, else the store', () => {
  const p = profile({ prep_days: 1, note: 'store note' });
  const rules = [rule('erbil', { prep_days: 4, eta_note: '2–3 days', note: 'via courier' })];
  const e = resolveMerchantDelivery(p, rules, 'erbil', 0);
  assert.deepEqual([e.prep_days, e.eta_note, e.note], [4, '2–3 days', 'via courier']);
  const b = resolveMerchantDelivery(p, rules, 'baghdad', 0);
  assert.deepEqual([b.prep_days, b.eta_note, b.note], [1, '', 'store note']);
});

// ------------------------------------------------------------ legacy JSON

test('the legacy flat settings map to the profile the migration backfills', () => {
  assert.deepEqual(
    pick(profileFromLegacySettings('{"fee_iqd":5000,"free_over_iqd":50000,"note":" 2–4 days "}')),
    { default_mode: 'fee', default_fee_iqd: 5000, free_over_iqd: 50_000, note: '2–4 days', version: 0 }
  );
  assert.deepEqual(pick(profileFromLegacySettings('{}')), { default_mode: 'free', default_fee_iqd: 0, free_over_iqd: null, note: '', version: 0 });
  assert.deepEqual(pick(profileFromLegacySettings('not json')), { default_mode: 'free', default_fee_iqd: 0, free_over_iqd: null, note: '', version: 0 });
  // floored fee, capped at 1,000,000; threshold rounded UP (an integer basket reaches 1000.5 at 1001)
  assert.equal(profileFromLegacySettings({ fee_iqd: 2_000_000.7 }).default_fee_iqd, DELIVERY_LIMITS.fee_iqd);
  assert.equal(profileFromLegacySettings({ fee_iqd: 5000, free_over_iqd: 1000.5 }).free_over_iqd, 1001);
  assert.equal(profileFromLegacySettings({ fee_iqd: '3000' }).default_fee_iqd, 3000);
});

test('the legacy mapping charges exactly what the wave-1 checkout charged', () => {
  const old = (settings: Record<string, unknown>, merchandise: number) => {
    const rawFee = Number(settings.fee_iqd);
    const freeOver = Number(settings.free_over_iqd);
    let delivery = Number.isFinite(rawFee) && rawFee > 0 ? Math.floor(rawFee) : 0;
    if (Number.isFinite(freeOver) && freeOver > 0 && merchandise >= freeOver) delivery = 0;
    return delivery;
  };
  for (const s of [{}, { fee_iqd: 0 }, { fee_iqd: 5000 }, { fee_iqd: 5000, free_over_iqd: 14_000 }, { fee_iqd: 700.9, free_over_iqd: 999.5 }]) {
    for (const m of [0, 999, 1000, 13_999, 14_000, 100_000]) {
      const r = resolveMerchantDelivery(profileFromLegacySettings(s), [], 'basra', m);
      assert.equal(r.fee_iqd, old(s, m), `${JSON.stringify(s)} @ ${m}`);
    }
  }
});

test('the rollback mirror writes the default back in the legacy shape', () => {
  assert.deepEqual(legacySettingsFromProfile(profile({ free_over_iqd: 9000, note: 'n' })), { fee_iqd: 5000, free_over_iqd: 9000, note: 'n' });
  assert.deepEqual(legacySettingsFromProfile(profile({ default_mode: 'free' })), { fee_iqd: 0 });
  assert.deepEqual(canonicalLegacySettings({ fee_iqd: '5000', note: '  x ', junk: 1 }), { fee_iqd: 5000, note: 'x' });
  assert.deepEqual(canonicalLegacySettings('{"free_over_iqd":0}'), {});
});

test('stored rows are typed defensively', () => {
  const p = normalizeStoredProfile({ default_mode: 'weird', default_fee_iqd: 5, pickup_enabled: 1, pickup_governorate: 'mars', version: 7 });
  assert.deepEqual([p.default_mode, p.pickup_enabled, p.pickup_governorate, p.version], ['disabled', true, '', 7]);
  assert.equal(normalizeStoredRule({ governorate_id: 'mars', mode: 'fee', fee_iqd: 1 }), null);
  assert.equal(normalizeStoredRule({ governorate_id: 'basra', mode: 'fee', fee_iqd: null })!.mode, 'disabled');
});

// ------------------------------------------------------------- validation

const valid = { profile: { default_mode: 'fee', default_fee_iqd: 5000 }, rules: [] };

test('a well-formed configuration validates, rules sorted in the government order', () => {
  const v = validateDeliveryConfig({
    profile: { ...valid.profile, free_over_iqd: 50_000, pickup_enabled: true, pickup_governorate: 'baghdad', prep_days: 2, note: ' hi ' },
    rules: [
      { governorate_id: 'erbil', mode: 'free' },
      { governorate_id: 'baghdad', mode: 'fee', fee_iqd: 3000, prep_days: 1, eta_note: 'same day' },
      { governorate_id: 'basra', mode: 'disabled', fee_iqd: 9000 },
    ],
  });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.deepEqual(v.rules.map((r) => r.governorate_id), ['baghdad', 'basra', 'erbil']);
  assert.equal(v.rules[1].fee_iqd, null, 'a fee on a non-fee rule is not kept');
  assert.equal(v.profile.note, 'hi');
});

test('the validator refuses, with a path and a code, and never coerces', () => {
  const issues = (input: { profile?: unknown; rules?: unknown }) =>
    (validateDeliveryConfig(input) as { ok: false; issues: Array<{ path: string; code: string }> }).issues?.map((i) => `${i.path}:${i.code}`) ?? [];
  assert.deepEqual(issues({ profile: null }), ['profile:invalid']);
  assert.deepEqual(issues({ profile: { default_mode: 'cheap' } }), ['profile.default_mode:mode']);
  assert.deepEqual(issues({ profile: { default_mode: 'fee' } }), ['profile.default_fee_iqd:fee_required']);
  assert.deepEqual(issues({ profile: { default_mode: 'fee', default_fee_iqd: '5000' } }), ['profile.default_fee_iqd:not_integer']);
  assert.deepEqual(issues({ profile: { default_mode: 'fee', default_fee_iqd: 12.5 } }), ['profile.default_fee_iqd:not_integer']);
  assert.deepEqual(issues({ profile: { default_mode: 'fee', default_fee_iqd: 1_000_001 } }), ['profile.default_fee_iqd:fee_range']);
  assert.deepEqual(issues({ profile: { default_mode: 'fee', default_fee_iqd: -1 } }), ['profile.default_fee_iqd:fee_range']);
  assert.deepEqual(issues({ profile: { ...valid.profile, free_over_iqd: 0 } }), ['profile.free_over_iqd:free_over_range']);
  assert.deepEqual(issues({ profile: { ...valid.profile, prep_days: 61 } }), ['profile.prep_days:prep_days_range']);
  assert.deepEqual(issues({ profile: { ...valid.profile, pickup_enabled: true } }), ['profile.pickup_governorate:pickup_governorate_required']);
  assert.deepEqual(issues({ profile: { ...valid.profile, pickup_enabled: 'yes' } }), ['profile.pickup_enabled:invalid']);
  assert.deepEqual(issues({ profile: { ...valid.profile, pickup_governorate: 'بغداد' } }), ['profile.pickup_governorate:governorate_unknown'], 'ids only, never names');
  assert.deepEqual(issues({ profile: { ...valid.profile, note: 'x'.repeat(201) } }), ['profile.note:too_long']);
  assert.deepEqual(issues({ profile: { ...valid.profile, free_over_basis: 'before_discount' } }), ['profile.free_over_basis:invalid']);
  assert.deepEqual(issues({ ...valid, rules: [{ governorate_id: 'Baghdad', mode: 'free' }] }), ['rules[0].governorate_id:governorate_unknown']);
  assert.deepEqual(
    issues({ ...valid, rules: [{ governorate_id: 'basra', mode: 'free' }, { governorate_id: 'basra', mode: 'disabled' }] }),
    ['rules.basra.governorate_id:governorate_duplicate']
  );
  assert.deepEqual(issues({ ...valid, rules: [{ governorate_id: 'basra', mode: 'fee' }] }), ['rules.basra.fee_iqd:fee_required']);
  assert.deepEqual(issues({ ...valid, rules: [{ governorate_id: 'basra', mode: 'x' }] }), ['rules.basra.mode:mode']);
  assert.deepEqual(issues({ ...valid, rules: [{ governorate_id: 'basra', mode: 'free', eta_note: 'y'.repeat(81) }] }), ['rules.basra.eta_note:too_long']);
  assert.deepEqual(issues({ ...valid, rules: 'all' }), ['rules:invalid']);
  assert.deepEqual(issues({ ...valid, rules: Array.from({ length: 19 }, () => ({})) }), ['rules:too_many_rules']);
});

// ---------------------------------------------------------------- coverage

test('coverage: delivery somewhere or pickup is serviceable; everything off is not', () => {
  const allOff = GOVERNORATE_IDS.map((g) => rule(g, { mode: 'disabled', fee_iqd: null }));
  assert.equal(deliveryCoverage(profile(), allOff).serviceable, false);
  assert.equal(deliveryCoverage(profile({ default_mode: 'disabled' }), []).serviceable, false);
  assert.equal(deliveryCoverage(profile({ default_mode: 'disabled', pickup_enabled: true, pickup_governorate: 'basra' }), []).serviceable, true);
  assert.equal(deliveryCoverage(profile(), []).served.length, 18);
});

test('the table lists all eighteen with the effective answer', () => {
  const t = deliveryTable(profile({ free_over_iqd: 40_000 }), [rule('basra', { fee_iqd: 9000 }), rule('duhok', { mode: 'disabled', fee_iqd: null })]);
  assert.equal(t.length, 18);
  assert.deepEqual(t.find((g) => g.governorate === 'basra'), { governorate: 'basra', mode: 'fee', fee_iqd: 9000, free_over_iqd: 40_000, prep_days: 0, eta_note: '', custom: true });
  assert.equal(t.find((g) => g.governorate === 'duhok')!.mode, 'disabled');
  assert.equal(t.find((g) => g.governorate === 'baghdad')!.custom, false);
});

function pick(p: MerchantDeliveryProfile) {
  return { default_mode: p.default_mode, default_fee_iqd: p.default_fee_iqd, free_over_iqd: p.free_over_iqd, note: p.note, version: p.version };
}
