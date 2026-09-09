/**
 * ELIGIBILITY — case 16 of the owner's seventeen ("PRO inherits PLUS; every
 * eligibility check is server-side"), docs/BUNDLES_MYSTERY.md §9.
 *
 * `required_tiers` is an explicit SET, and that is a deliberate departure from
 * `validateCoupon`'s ladder minimum. `TIER_RANK` is
 * { free: 0, plus: 1, prime: 2, pro: 3 }, so a MINIMUM of 'plus' would silently
 * admit PRIME to every PLUS-exclusive offer and hand it the PLUS member price,
 * while the repo's own entitlements module states the opposite intent for buyer
 * tiers in as many words. And the owner's own enumeration includes
 * "PLUS + PRO but not PRIME", which a linear minimum cannot express at all.
 *
 * The whole matrix is walked here — {guest, free, plus, prime, pro} ×
 * {no gate, plus, prime, pro, plus+pro} × {active, expired, restricted} —
 * against the ONE function every surface calls, so the locked card and the
 * purchase door cannot disagree: the lock IS `!ok && MEMBERSHIP_REQUIRED`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1 } from './fixtures/app';
import { getTierStatus } from '../worker/lib/entitlements';
import { TIER_RANK, type Tier } from '../worker/lib/pricing';
import {
  INHERITS,
  loadOffers,
  offerEligible,
  offerKey,
  parseRequiredTiers,
  scheduleState,
  type OfferView,
} from '../worker/lib/offers';

const NOW = Date.parse('2026-06-15T12:00:00Z');

const status = (tier: Tier, active = true, gated: string[] = []) => ({
  tier,
  active,
  expires_at: null,
  pending_launch: null,
  gated_benefits: gated,
});

const view = (over: Partial<NonNullable<OfferView['window']>> = {}): OfferView => ({
  window: {
    id: 'ofw_1',
    starts_at: null,
    ends_at: null,
    required_tiers: [],
    offer_price_mode: '',
    offer_price_iqd: null,
    discount_percent: null,
    discount_iqd: null,
    plus_price_iqd: null,
    locked_preview: true,
    active: true,
    ...over,
  },
  limits: null,
});

// ------------------------------------------------------------------ schedule

test('the schedule has three states and an explicit Z is what decides them', () => {
  assert.equal(scheduleState(null, null, NOW), 'live');
  assert.equal(scheduleState('2026-07-01T00:00:00Z', null, NOW), 'upcoming');
  assert.equal(scheduleState(null, '2026-06-01T00:00:00Z', NOW), 'ended');
  assert.equal(scheduleState('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', NOW), 'live');
  // The boundaries belong to the window: it is live at its own start and end.
  assert.equal(scheduleState('2026-06-15T12:00:00Z', null, NOW), 'live');
  assert.equal(scheduleState(null, '2026-06-15T12:00:00Z', NOW), 'live');
});

test('a schedule refusal names WHICH bound was crossed', () => {
  assert.equal(offerEligible(status('free'), view({ starts_at: '2026-07-01T00:00:00Z' }), NOW).reason, 'OFFER_WINDOW_NOT_STARTED');
  assert.equal(offerEligible(status('free'), view({ ends_at: '2026-06-01T00:00:00Z' }), NOW).reason, 'OFFER_WINDOW_EXPIRED');
  assert.equal(offerEligible(status('free'), view({ active: false }), NOW).reason, 'OFFER_INACTIVE');
});

// -------------------------------------------------------------- the matrix

const GATES: Array<[string, Tier[]]> = [
  ['no gate', []],
  ['plus', ['plus']],
  ['prime', ['prime']],
  ['pro', ['pro']],
  ['plus+pro', ['plus', 'pro']],
];

/** The expected verdict, written out rather than computed, so the test states
 *  the rule instead of restating the implementation. */
const EXPECTED: Record<string, Record<string, boolean>> = {
  guest: { 'no gate': true, plus: false, prime: false, pro: false, 'plus+pro': false },
  free: { 'no gate': true, plus: false, prime: false, pro: false, 'plus+pro': false },
  plus: { 'no gate': true, plus: true, prime: false, pro: false, 'plus+pro': true },
  prime: { 'no gate': true, plus: false, prime: true, pro: false, 'plus+pro': false },
  pro: { 'no gate': true, plus: true, prime: false, pro: true, 'plus+pro': true },
};

test('the whole {viewer} × {gate} matrix, with PRO inheriting PLUS and PRIME standing alone', () => {
  for (const [gateName, tiers] of GATES) {
    for (const viewer of ['guest', 'free', 'plus', 'prime', 'pro'] as const) {
      const s = viewer === 'guest' ? null : status(viewer === 'free' ? 'free' : (viewer as Tier), viewer !== 'free');
      const out = offerEligible(s, view({ required_tiers: tiers }), NOW);
      assert.equal(out.ok, EXPECTED[viewer][gateName], `${viewer} × ${gateName}`);
      if (!out.ok) assert.equal(out.reason, 'MEMBERSHIP_REQUIRED', `${viewer} × ${gateName}`);
      // The card's lock and the door's refusal are the SAME verdict.
      const locked = !out.ok && out.reason === 'MEMBERSHIP_REQUIRED';
      assert.equal(locked, !EXPECTED[viewer][gateName], `${viewer} × ${gateName}: lock and purchase agree`);
    }
  }
});

test('the load-bearing cells, stated on their own', () => {
  const plusOnly = view({ required_tiers: ['plus'] });
  assert.equal(offerEligible(status('pro'), plusOnly, NOW).ok, true, 'PRO satisfies a PLUS requirement');
  assert.equal(offerEligible(status('prime'), plusOnly, NOW).ok, false, 'PRIME does NOT');
  const plusPro = view({ required_tiers: ['plus', 'pro'] });
  assert.equal(offerEligible(status('plus'), plusPro, NOW).ok, true);
  assert.equal(offerEligible(status('pro'), plusPro, NOW).ok, true);
  assert.equal(offerEligible(status('prime'), plusPro, NOW).ok, false, 'plus+pro excludes PRIME — unrepresentable as a minimum');
});

test('an UNGATED window is public: a guest and a free account are both eligible', () => {
  assert.equal(offerEligible(null, view(), NOW).ok, true);
  assert.equal(offerEligible(status('free', false), view(), NOW).ok, true);
  // ...and `exclusiveSections` is not ANDed in, which would have made every
  // scheduled offer on an ordinary product subscriber-only.
  assert.equal(offerEligible(status('free', false), view({ ends_at: '2099-01-01T00:00:00Z' }), NOW).ok, true);
});

test('a lapsed membership is not a membership', () => {
  assert.equal(offerEligible(status('plus', false), view({ required_tiers: ['plus'] }), NOW).ok, false);
});

test('an admin restriction case pauses gated access without cancelling the paid membership', () => {
  const restricted = status('plus', true, ['exclusiveSections']);
  assert.equal(offerEligible(restricted, view({ required_tiers: ['plus'] }), NOW).ok, false);
  assert.equal(offerEligible(restricted, view({ required_tiers: ['plus'] }), NOW).reason, 'MEMBERSHIP_REQUIRED');
  // The membership itself is untouched, and an UNGATED offer still works.
  assert.equal(restricted.tier, 'plus');
  assert.equal(offerEligible(restricted, view(), NOW).ok, true);
});

test('no window at all is not a refusal — the subject simply has no offer', () => {
  assert.equal(offerEligible(status('free'), null, NOW).ok, true);
  assert.equal(offerEligible(null, null, NOW).ok, true);
});

test('the tier SET is a membership relation, and TIER_RANK stays the only ranking', () => {
  assert.deepEqual(INHERITS.pro, ['free', 'plus', 'pro']);
  assert.deepEqual(INHERITS.prime, ['free', 'prime'], 'PRIME inherits nothing from PLUS');
  assert.deepEqual(TIER_RANK, { free: 0, plus: 1, prime: 2, pro: 3 });
  // A ladder minimum on TIER_RANK would admit PRIME to a PLUS gate — this is
  // exactly the bug the set exists to prevent.
  assert.ok(TIER_RANK.prime > TIER_RANK.plus);
  assert.equal(offerEligible(status('prime'), view({ required_tiers: ['plus'] }), NOW).ok, false);
});

test('a stored required_tiers set is parsed, sorted and cleaned of anything that is not a tier', () => {
  assert.deepEqual(parseRequiredTiers('["pro","plus"]'), ['plus', 'pro']);
  assert.deepEqual(parseRequiredTiers('["nonsense","plus"]'), ['plus']);
  assert.deepEqual(parseRequiredTiers('not json'), []);
  assert.deepEqual(parseRequiredTiers('[]'), []);
});

// ------------------------------------------------------- against a real DB

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,email) VALUES ('u_free','free@x.co'),('u_plus','plus@x.co'),('u_prime','prime@x.co'),('u_pro','pro@x.co'),('u_gated','gated@x.co');
    INSERT INTO products (id,slug,name,price_iqd,composition) VALUES ('prd_bundle','b','Starter Bundle',145000,'bundle');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('m_plus','u_plus','plus_12mo','plus','active',12,99000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('m_prime','u_prime','prime_12mo','prime','active',12,99000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('m_pro','u_pro','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('m_gated','u_gated','plus_12mo','plus','active',12,99000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO restriction_cases (id,user_id,kind,state,reason,benefit_flags)
      VALUES ('rc1','u_gated','other','active','under review','["exclusiveSections"]');
    INSERT INTO offer_windows (subject_type,subject_id,id,required_tiers,active)
      VALUES ('product','prd_bundle','ofw_bundle','["plus"]',1);
    INSERT INTO offer_limits (subject_type,subject_id,max_per_user,max_global) VALUES ('product','prd_bundle',2,10);
  `);
}

test('the stored window and limits load in one pass, and the real tier status decides', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);

  const offers = await loadOffers(db, [
    ['product', 'prd_bundle'],
    ['product', 'prd_missing'],
  ]);
  const v = offers.get(offerKey(['product', 'prd_bundle']))!;
  assert.deepEqual(v.window!.required_tiers, ['plus']);
  assert.equal(v.window!.id, 'ofw_bundle');
  assert.deepEqual(v.limits, { max_per_user: 2, max_global: 10 });
  assert.equal(offers.has(offerKey(['product', 'prd_missing'])), false, 'no row means no offer, never a refusal');

  const verdicts: Record<string, boolean> = {};
  for (const u of ['u_free', 'u_plus', 'u_prime', 'u_pro', 'u_gated']) {
    verdicts[u] = offerEligible(await getTierStatus(db, u), v, NOW).ok;
  }
  assert.deepEqual(verdicts, {
    u_free: false,
    u_plus: true,
    u_prime: false, // PRIME is not a PLUS
    u_pro: true, // PRO inherits PLUS
    u_gated: false, // an active restriction case
  });
});

test('a subject with no offer row behaves exactly as it does today', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const offers = await loadOffers(db, [['product', 'prd_ordinary']]);
  assert.equal(offers.size, 0);
  assert.equal(offerEligible(await getTierStatus(db, 'u_free'), offers.get('product:prd_ordinary') ?? null, NOW).ok, true);
});
