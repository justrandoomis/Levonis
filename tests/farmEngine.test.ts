/**
 * LEVO Printer Farm — the pure engine (worker/lib/farm/*), tested as maths:
 *
 *   * randomness is deterministic: the same seed and salt always roll the same
 *     number, different salts differ, values stay in [0, 1);
 *   * durations follow the config: reference seconds × speed × quality, and
 *     game seconds become real milliseconds through time_scale;
 *   * failure probability is monotonic — worse health, finer quality, harder
 *     material, worse spool, more complex part all raise it, never lower it;
 *   * offers are a pure function of their seed and gated by tier;
 *   * progression thresholds and unlocks follow the config;
 *   * the normaliser fills every hole and clamps every range; the public
 *     projection carries no limit or reward budget at any depth;
 *   * resolve() is pure and does exactly what the timestamps say;
 *   * (0054) server randomness has the right shape and never repeats; client
 *     keys cannot impersonate server ledger keys; a delivery is one plan shared
 *     by collect and by the resolver's deferred payout; a late job is ready.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, randomSeedHex, roll, rollInt, seedFrom, sequence, weightedIndex } from '../worker/lib/farm/rng';
import { clientKeyProblem, clientLedgerKey, systemLedgerKey } from '../worker/lib/farm/ledger';
import {
  FARM_CONFIG_DEFAULTS, FARM_CONFIG_SCHEMA, farmConfigProblems, normalizeFarmConfig, publicFarmConfig, type FarmConfig,
} from '../worker/lib/farm/config';
import { baghdadDayOf, endsAtFor, gameSecondsToRealMs, printSeconds, progressOf, referenceSeconds, speedFactor } from '../worker/lib/farm/time';
import { failureCosts, failureProbability, pickFailureKind } from '../worker/lib/farm/failure';
import { eligibleTiers, generateOffers, rewardFor, starterFirstJob } from '../worker/lib/farm/jobs';
import { levelForXp, maxActiveJobs, reputationAfterDelivery, starterKit, unlocks, xpForNextLevel } from '../worker/lib/farm/progression';
import { ownedCapacity, partFits, resaleValue } from '../worker/lib/farm/catalog';
import { dailyCapAllows, deliveryPlan, resolve } from '../worker/lib/farm/sim';
import { emptyStats } from '../worker/lib/farm/types';
import type { FarmAssignmentRow, FarmJobRow, FarmPrinterRow, FarmProfileRow, FarmSpoolRow, FarmState } from '../worker/lib/farm/types';

const cfg = FARM_CONFIG_DEFAULTS;

// ------------------------------------------------------------------ rng

test('rng: the same seed and salt roll the same number; salts and seeds differ; range is [0, 1)', async () => {
  const seed = await seedFrom('user-1', 'offers', '3');
  assert.match(seed, /^[0-9a-f]{64}$/);
  assert.equal(seed, await seedFrom('user-1', 'offers', '3'));
  assert.notEqual(seed, await seedFrom('user-1', 'offers', '4'));
  assert.equal(roll(seed, 'outcome'), roll(seed, 'outcome'));
  assert.notEqual(roll(seed, 'outcome'), roll(seed, 'kind'));
  assert.notEqual(roll(seed, 'outcome'), roll(await seedFrom('user-2', 'offers', '3'), 'outcome'));
  // Repetitive seeds must not collapse onto each other (a plain XOR fold would send both to 0).
  assert.notEqual(roll('a'.repeat(64), 'x'), roll('b'.repeat(64), 'x'));
  assert.notEqual(roll('a'.repeat(64), 'x'), roll('0'.repeat(64), 'x'));
  for (let i = 0; i < 2000; i++) {
    const r = roll(`seed-${i}`, 'x');
    assert.ok(r >= 0 && r < 1, `roll out of range: ${r}`);
  }
  const gen = mulberry32(123);
  const a = [gen(), gen(), gen()];
  const gen2 = mulberry32(123);
  assert.deepEqual([gen2(), gen2(), gen2()], a);
  const seq = sequence(seed, 's');
  const seq2 = sequence(seed, 's');
  assert.deepEqual([seq(), seq(), seq()], [seq2(), seq2(), seq2()]);
  for (let i = 0; i < 200; i++) {
    const n = rollInt(seed, `int${i}`, 3, 7);
    assert.ok(n >= 3 && n <= 7 && Number.isInteger(n));
  }
  // weighted choice covers the ends and respects zero weights
  assert.equal(weightedIndex([0, 5, 0], 0.999), 1);
  assert.equal(weightedIndex([1, 1], 0), 0);
  assert.equal(weightedIndex([1, 1], 0.5), 1);
  // distribution sanity: a fair roll is not stuck on one side
  let low = 0;
  for (let i = 0; i < 1000; i++) if (roll(seed, `d${i}`) < 0.5) low++;
  assert.ok(low > 400 && low < 600, `skewed distribution: ${low}/1000 below 0.5`);
});

// ------------------------------------------------------------------ time

test('time: durations scale with printer speed and quality; game seconds → real ms through time_scale', () => {
  const keychain = cfg.products.keychain;
  const a1mini = cfg.printers.a1_mini;
  const h2c = cfg.printers.h2c;
  assert.equal(referenceSeconds(keychain, 2), 3000);
  assert.equal(speedFactor(a1mini, cfg), 1, 'the A1 mini is the reference machine');
  assert.equal(printSeconds(keychain, 2, a1mini, 'standard', cfg), 3000);
  assert.ok(printSeconds(keychain, 2, h2c, 'standard', cfg) < 3000, 'a faster machine prints sooner');
  assert.equal(printSeconds(keychain, 2, a1mini, 'draft', cfg), Math.round(3000 * cfg.quality.draft.time_factor));
  assert.ok(printSeconds(keychain, 2, a1mini, 'ultra', cfg) > printSeconds(keychain, 2, a1mini, 'fine', cfg));
  assert.equal(gameSecondsToRealMs(3000, cfg), 150_000, '3000 game seconds = 2.5 real minutes at scale 20');
  const start = '2026-09-05T10:00:00.000Z';
  assert.equal(endsAtFor(start, 3000, cfg), '2026-09-05T10:02:30.000Z');
  assert.equal(progressOf(start, '2026-09-05T10:02:30.000Z', '2026-09-05T10:01:15.000Z'), 0.5);
  assert.equal(progressOf(start, '2026-09-05T10:02:30.000Z', '2026-09-05T11:00:00.000Z'), 1);
  assert.equal(progressOf(null, null, start), 0);
  // The platform's day: 22:30 UTC is already tomorrow in Baghdad.
  assert.equal(baghdadDayOf('2026-09-05T22:30:00.000Z'), '2026-09-06');
  assert.equal(baghdadDayOf('2026-09-05T20:30:00.000Z'), '2026-09-05');
});

// ------------------------------------------------------------------ failure

test('failure: probability is monotonic in health and quality (and every other input), bounded, and kinds follow weights', () => {
  const base = { health: 100, reliability: 0.9, materialDifficulty: 0.05, spoolQuality: 1, complexity: 0.1, quality: 'standard' as const };
  let prev = failureProbability(base, cfg);
  assert.ok(prev > 0 && prev < 0.1, `a healthy A1 mini on PLA fails rarely: ${prev}`);
  for (const health of [90, 70, 50, 30, 10, 0]) {
    const p = failureProbability({ ...base, health }, cfg);
    assert.ok(p >= prev, `lower health must not lower risk (${health}: ${p} < ${prev})`);
    prev = p;
  }
  const byQuality = (['draft', 'standard', 'fine', 'ultra'] as const).map((q) => failureProbability({ ...base, quality: q }, cfg));
  for (let i = 1; i < byQuality.length; i++) assert.ok(byQuality[i] >= byQuality[i - 1], `finer quality must not lower risk: ${byQuality}`);
  assert.ok(failureProbability({ ...base, reliability: 0.5 }, cfg) > failureProbability(base, cfg));
  assert.ok(failureProbability({ ...base, materialDifficulty: 0.7 }, cfg) > failureProbability(base, cfg));
  assert.ok(failureProbability({ ...base, spoolQuality: 0.3 }, cfg) > failureProbability(base, cfg));
  assert.ok(failureProbability({ ...base, complexity: 0.9 }, cfg) > failureProbability(base, cfg));
  const worst = failureProbability({ health: 0, reliability: 0, materialDifficulty: 1, spoolQuality: 0, complexity: 1, quality: 'ultra' }, cfg);
  assert.ok(worst <= cfg.failure.max && worst > 0.5, `worst case stays under the cap: ${worst}`);

  // Kinds: the roll picks by weight; ams_jam only on multi-colour batches.
  assert.equal(pickFailureKind(cfg, 0, false), 'spaghetti');
  const kinds = new Set<string>();
  for (let i = 0; i < 200; i++) kinds.add(pickFailureKind(cfg, i / 200, true));
  assert.ok(kinds.has('mechanical') && kinds.has('first_layer') && kinds.has('ams_jam'));
  for (let i = 0; i < 200; i++) assert.notEqual(pickFailureKind(cfg, i / 200, false), 'ams_jam');
  const costs = failureCosts('mechanical', cfg, 100, 3600);
  assert.equal(costs.breaks, true);
  assert.equal(costs.gramsLost + costs.gramsReturned, 100);
  assert.equal(costs.secondsElapsed, 1800);
  assert.equal(costs.healthHit, cfg.failure.kinds.mechanical.health_hit);
  const fl = failureCosts('first_layer', cfg, 100, 3600);
  assert.ok(fl.gramsReturned > costs.gramsReturned, 'a first-layer failure wastes little');
});

// ------------------------------------------------------------------ jobs

test('offers: deterministic per seed, gated by tier, printable by the machines owned, priced by the formula', () => {
  const starter: FarmPrinterRow = {
    id: 'p', user_id: 'u', model_key: 'a1_mini', slot: 0, nickname: '', health: 100, state: 'idle', state_until: null,
    hours: 0, prints: 0, failures: 0, upgrades_json: '[]', created_at: 'x', updated_at: 'x', sold_at: null,
  };
  const cap = ownedCapacity([starter], cfg);
  assert.equal(cap.maxColors, 1, 'no AMS → single colour');
  assert.ok(cap.materials.has('PLA') && !cap.materials.has('ABS'));
  const now = '2026-09-05T10:00:00.000Z';
  const input = { userId: 'u', profile: { level: 1, reputation_bp: 0 }, capacity: cap, now, cfg, seed: 'a'.repeat(64), count: 5 };
  const a = generateOffers(input);
  const b = generateOffers(input);
  assert.deepEqual(a, b, 'same seed → same offers');
  assert.equal(a.length, 5);
  assert.notDeepEqual(generateOffers({ ...input, seed: 'b'.repeat(64) }).map((j) => j.product_key + j.qty), a.map((j) => j.product_key + j.qty));
  for (const j of a) {
    assert.equal(j.customer_tier, 'individual', 'a fresh player only hears from individuals');
    assert.equal(JSON.parse(j.colors_json).length, 1);
    assert.ok(cfg.printers.a1_mini.materials.includes(j.material));
    assert.ok(partFits(cfg.printers.a1_mini, cfg.products[j.product_key]));
    assert.ok(j.qty >= 1 && j.qty <= 4);
    assert.equal(j.reward_coins, rewardFor(cfg, cfg.products[j.product_key], j.qty, j.material, 'individual', j.quality));
    assert.ok(Date.parse(j.deadline_at) > Date.parse(j.offer_expires_at) && Date.parse(j.offer_expires_at) > Date.parse(now));
    assert.match(j.id, /^fjob_[0-9a-f]{16}[0-9a-z]$/);
  }
  // Tier gates: reputation and level both count.
  assert.deepEqual(eligibleTiers(cfg, { level: 1, reputation_bp: 5000 }), ['individual']);
  assert.deepEqual(eligibleTiers(cfg, { level: 12, reputation_bp: 0 }), ['individual']);
  assert.deepEqual(eligibleTiers(cfg, { level: 4, reputation_bp: 1200 }), ['individual', 'small_business', 'merchant']);
  const veteran = generateOffers({ ...input, profile: { level: 12, reputation_bp: 5000 }, count: 40 });
  assert.ok(veteran.some((j) => j.customer_tier !== 'individual'), 'a veteran hears from businesses');
  // Reward formula, by hand, for the starter job.
  const first = starterFirstJob(cfg, 'u', now)!;
  const f = cfg.jobs.reward_formula;
  const expected = Math.round(
    (24 * cfg.materials.PLA.price_per_gram * f.per_gram_factor + (3000 / 3600) * f.per_hour_coins + 2 * f.per_part_coins) *
      cfg.customers.individual.reward_margin
  );
  assert.equal(first.reward_coins, expected);
  assert.equal(first.grams, 24);
  assert.equal(first.print_seconds, 3000);
  assert.equal(first.id, 'fjob_first_u');
});

// ------------------------------------------------------------------ progression

test('progression: level thresholds, xp_next, active-job cap, reputation clamps and phase-aware unlocks', () => {
  assert.equal(levelForXp(0, cfg), 1);
  assert.equal(levelForXp(99, cfg), 1);
  assert.equal(levelForXp(100, cfg), 2);
  assert.equal(levelForXp(250, cfg), 3);
  assert.equal(levelForXp(10_000_000, cfg), cfg.progression.level_thresholds.length);
  assert.equal(xpForNextLevel(1, cfg), 100);
  assert.equal(xpForNextLevel(cfg.progression.level_thresholds.length, cfg), null);
  assert.equal(maxActiveJobs(1, cfg), 2);
  assert.equal(maxActiveJobs(99, cfg), cfg.jobs.max_active_jobs[cfg.jobs.max_active_jobs.length - 1]);
  const job = { reputation_gain_bp: 40, late_penalty_bp: 80 };
  assert.equal(reputationAfterDelivery(4990, job, false, 1, cfg), 5000, 'capped');
  assert.equal(reputationAfterDelivery(30, job, true, 1, cfg), 0, 'floored');
  assert.equal(reputationAfterDelivery(1000, job, false, 1.3, cfg), 1052, 'scaled by the quality factor');
  const u1 = unlocks({ level: 1 }, cfg);
  assert.equal(u1.market, true);
  assert.equal(u1.maintenance, false);
  assert.equal(unlocks({ level: 2 }, cfg).maintenance, true);
  assert.equal(unlocks({ level: 50 }, cfg).store, false, 'a feature that is not built never reports open');
  const kit = starterKit(cfg);
  assert.equal(kit.printer.model_key, 'a1_mini');
  assert.equal(kit.coins, 1500);
  assert.equal(kit.spool.material, 'PLA');
  assert.equal(resaleValue(cfg, 'a1_mini'), 3300);
});

// ------------------------------------------------------------------ config

test('normalizeFarmConfig fills from defaults, clamps, forces schema and preserves version', () => {
  assert.deepEqual(normalizeFarmConfig(undefined), FARM_CONFIG_DEFAULTS);
  assert.deepEqual(normalizeFarmConfig('garbage'), FARM_CONFIG_DEFAULTS);
  assert.deepEqual(normalizeFarmConfig({}), FARM_CONFIG_DEFAULTS);
  assert.deepEqual(normalizeFarmConfig(JSON.stringify(FARM_CONFIG_DEFAULTS)), FARM_CONFIG_DEFAULTS);
  const n = normalizeFarmConfig({
    schema: 99,
    version: 7,
    time: { time_scale: -5, offer_refresh_minutes: 'abc' },
    economy: { starter_coins: 2500.7, resale_factor: 3 },
    failure: { base: 1.5, weights: { health: -1 } },
    printers: { a1_mini: { price: 'free', reliability: 2 }, custom_x: { price: 100 } },
    materials: { PLA: { price_per_gram: 4 } },
    products: { keychain: { max_colors: 0 } },
    customers: { individual: { qty_range: [9, 2] } },
    progression: { level_thresholds: [500, 0, 100], unlocks: { maintenance: 3, 'bad key!': 1 } },
    jobs: { reward_formula: { quality_multipliers: { fine: 2 } } },
    rewards: { levonis_points: { enabled: true, coins_per_point: 'x' } },
    limits: { daily_coins_cap: 0 },
  });
  assert.equal(n.schema, FARM_CONFIG_SCHEMA, 'schema is forced');
  assert.equal(n.version, 7, 'version is preserved');
  assert.equal(n.time.time_scale, 1, 'clamped to the floor');
  assert.equal(n.time.offer_refresh_minutes, cfg.time.offer_refresh_minutes, 'garbage → default');
  assert.equal(n.economy.starter_coins, 2501, 'integers stay integers');
  assert.equal(n.economy.resale_factor, 1);
  assert.equal(n.failure.base, 1);
  assert.equal(n.failure.weights.health, 0);
  assert.equal(n.printers.a1_mini.price, cfg.printers.a1_mini.price, 'a non-number falls back to the default entry');
  assert.equal(n.printers.a1_mini.reliability, 1);
  assert.equal(n.printers.custom_x.price, 100, 'a new catalog entry is kept…');
  assert.equal(n.printers.custom_x.speed, cfg.printers.a1_mini.speed, '…with template values for what it did not say');
  assert.equal(n.materials.PLA.price_per_gram, 4);
  assert.deepEqual(n.materials.PLA.colors, cfg.materials.PLA.colors);
  assert.equal(n.products.keychain.max_colors, 1);
  assert.deepEqual(n.customers.individual.qty_range, [2, 9], 'an inverted range is fixed');
  assert.deepEqual(n.progression.level_thresholds, [0, 100, 500], 'sorted, starting at 0');
  assert.equal(n.progression.unlocks.maintenance, 3);
  assert.equal('bad key!' in n.progression.unlocks, false);
  assert.equal(n.progression.unlocks.market, 1, 'missing unlocks come from defaults');
  assert.equal(n.jobs.reward_formula.quality_multipliers.fine, 2);
  assert.equal(n.jobs.reward_formula.quality_multipliers.ultra, cfg.jobs.reward_formula.quality_multipliers.ultra);
  assert.equal(n.rewards.levonis_points.enabled, true, 'normalisation keeps the flag; problems() refuses it');
  assert.equal(n.rewards.levonis_points.coins_per_point, cfg.rewards.levonis_points.coins_per_point);
  assert.equal(n.limits.daily_coins_cap, 1);
  assert.deepEqual(Object.keys(n.customers), ['individual', 'small_business', 'merchant', 'company', 'industrial']);
  assert.deepEqual(Object.keys(n.failure.kinds), ['spaghetti', 'clog', 'first_layer', 'runout', 'ams_jam', 'detach', 'mechanical']);
});

test('farmConfigProblems: the defaults are clean; broken references, bad prices and the Points switch are refused', () => {
  assert.deepEqual(farmConfigProblems(FARM_CONFIG_DEFAULTS), []);
  const bad: FarmConfig = JSON.parse(JSON.stringify(FARM_CONFIG_DEFAULTS));
  bad.products.keychain.materials = ['UNOBTAINIUM'];
  bad.printers.a1_mini.materials = ['NOPE'];
  bad.printers.p1p.price = 0;
  bad.materials.PETG.price_per_gram = 0;
  bad.starter.printer_model = 'ender3';
  bad.rewards.levonis_points.enabled = true;
  const problems = farmConfigProblems(bad);
  assert.ok(problems.some((p) => p.includes('products.keychain.materials')));
  assert.ok(problems.some((p) => p.includes('printers.a1_mini.materials')));
  assert.ok(problems.some((p) => p.includes('printers.p1p.price')));
  assert.ok(problems.some((p) => p.includes('materials.PETG.price_per_gram')));
  assert.ok(problems.some((p) => p.includes('starter.printer_model')));
  assert.ok(problems.some((p) => p.includes('rewards.levonis_points.enabled')));
});

/** Every key on every object, at any depth. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

test('publicFarmConfig hides limits and reward budgets at every depth, and keeps what the client renders', () => {
  const pub = publicFarmConfig(FARM_CONFIG_DEFAULTS) as unknown as Record<string, unknown>;
  assert.equal('limits' in pub, false);
  assert.equal('rewards' in pub, false);
  const keys = [...allKeys(pub)];
  const leaky = keys.filter((k) => /budget|levonis|mutations_per_hour|daily_|weekly_|coins_per_point|_cap$/.test(k));
  assert.deepEqual(leaky, [], `public config leaks: ${leaky.join(', ')}`);
  assert.ok(pub.printers && pub.materials && pub.products && pub.customers && pub.quality && pub.progression && pub.colors);
  assert.equal((pub.printers as Record<string, { name: { ckb: string } }>).a1_mini.name.ckb, 'A1 mini');
  assert.equal((pub.products as Record<string, { name: { ar: string } }>).keychain.name.ar, 'ميدالية مفاتيح');
});

// ------------------------------------------------------------------ resolve

function fixture(now: string): FarmState {
  const profile: FarmProfileRow = {
    user_id: 'u', farm_name: 'F', level: 1, xp: 0, reputation_bp: 1000, location_key: 'tiny_room', state: 'active',
    last_seen_at: now, last_resolved_at: now, last_offer_at: now, offer_refresh_index: 1, config_version: 0,
    stats_json: '{}', tutorial_json: '{}', created_at: now, updated_at: now, revision: 0, offer_salt: 's'.repeat(64),
  };
  const printer: FarmPrinterRow = {
    id: 'p1', user_id: 'u', model_key: 'a1_mini', slot: 0, nickname: '', health: 100, state: 'printing', state_until: null,
    hours: 0, prints: 0, failures: 0, upgrades_json: '[]', created_at: now, updated_at: now, sold_at: null,
  };
  const spool: FarmSpoolRow = { id: 's1', user_id: 'u', material: 'PLA', color: 'black', grams_left: 476, grams_total: 500, quality: 1, cost_paid: 0, created_at: now };
  const job: FarmJobRow = {
    id: 'j1', user_id: 'u', state: 'printing', customer_tier: 'individual', customer_name: '{}', product_key: 'keychain', qty: 2,
    material: 'PLA', colors_json: '["black"]', grams: 24, print_seconds: 3000, quality: 'standard', reward_coins: 300,
    reputation_gain_bp: 40, late_penalty_bp: 80, cancel_penalty_coins: 0, cancel_penalty_bp: 150,
    offered_at: now, offer_expires_at: '2026-09-05T11:00:00.000Z', deadline_at: '2026-09-05T13:00:00.000Z', accepted_at: now,
    delivered_at: null, seed: 'j1', created_at: now, updated_at: now, payout_deferred_day: null,
  };
  const assignment: FarmAssignmentRow = {
    id: 'a1', user_id: 'u', job_id: 'j1', printer_id: 'p1', spool_id: 's1', qty: 2, grams: 24, seconds: 3000, quality: 'standard',
    position: 1, state: 'printing', started_at: now, ends_at: '2026-09-05T10:02:30.000Z', failure_p: 0, failure_kind: null,
    outcome_seed: 'seed-a1', collected_at: null, created_at: now, updated_at: now,
  };
  return { profile, balance: 1500, printers: [printer], spools: [spool], jobs: [job], assignments: [assignment], daily: null };
}

test('resolve() is pure and driven by timestamps: nothing before ends_at, done + ready + electricity after it', () => {
  const start = '2026-09-05T10:00:00.000Z';
  const s = fixture(start);
  const early = resolve(s, '2026-09-05T10:01:00.000Z', cfg, null);
  assert.equal(early.changed, false);
  assert.deepEqual(early.updates, []);
  const snapshot = JSON.stringify(s);
  const r = resolve(s, '2026-09-05T10:03:00.000Z', cfg, null);
  assert.equal(JSON.stringify(s), snapshot, 'the input is not mutated');
  assert.equal(r.changed, true);
  assert.deepEqual(r.finishedAssignments, ['a1']);
  assert.deepEqual(r.readyJobs, ['j1']);
  const asg = r.updates.find((u) => u.table === 'farm_assignments' && u.id === 'a1')!;
  assert.equal(asg.set.state, 'done');
  assert.equal(asg.guardPrintingAssignment, 'a1');
  const prn = r.updates.find((u) => u.table === 'farm_printers')!;
  assert.equal(prn.set.state, 'done');
  assert.equal(prn.inc?.prints, 2);
  assert.equal(prn.inc?.hours, 83, '3000 s = 0.83 h × 100');
  assert.ok((prn.set.health as number) < 100);
  assert.equal(r.updates.find((u) => u.table === 'farm_jobs')!.set.state, 'ready');
  assert.equal(r.ledgerRows.length, 1);
  assert.equal(r.ledgerRows[0].kind, 'electricity');
  assert.ok(r.ledgerRows[0].amount < 0);
  assert.equal(r.balance, 1500 + r.ledgerRows[0].amount);
  assert.deepEqual(r.events.map((e) => e.kind).sort(), ['job_ready', 'print_done']);
  // Same input, same output — replaying a resolution changes nothing.
  assert.deepEqual(resolve(s, '2026-09-05T10:03:00.000Z', cfg, null), r);
});

test('resolve(): a failed print keeps part of the grams, hits health, may break the printer; the customer cancels after grace', () => {
  const start = '2026-09-05T10:00:00.000Z';
  const s = fixture(start);
  s.assignments[0].failure_p = 1;
  const r = resolve(s, '2026-09-05T10:03:00.000Z', cfg, null);
  const asg = r.updates.find((u) => u.table === 'farm_assignments' && u.id === 'a1')!;
  assert.equal(asg.set.state, 'failed');
  assert.ok(typeof asg.set.failure_kind === 'string');
  const refund = r.updates.find((u) => u.table === 'farm_spools');
  const kind = cfg.failure.kinds[asg.set.failure_kind as keyof typeof cfg.failure.kinds];
  if (kind.grams_loss_factor < 1) assert.equal(refund?.inc?.grams_left, 24 - Math.ceil(24 * kind.grams_loss_factor));
  const prn = r.updates.find((u) => u.table === 'farm_printers')!;
  assert.equal(prn.inc?.failures, 1);
  assert.equal(prn.set.state, kind.breaks ? 'broken' : 'done');
  assert.equal(r.reputationBp, 1000 - cfg.progression.failure_reputation_bp);
  assert.equal(r.stats.failures, 1);
  assert.ok(r.events.some((e) => e.kind === 'print_failed'));
  assert.deepEqual(r.readyJobs, []);

  // Long after the deadline + grace: the customer walks away.
  const late = resolve(fixture(start), '2026-09-05T15:00:00.000Z', cfg, null);
  assert.deepEqual(late.cancelledJobs, ['j1']);
  assert.equal(late.reputationBp, 1000 - 150);
  assert.ok(late.events.some((e) => e.kind === 'job_cancelled_by_customer'));
  // Just after the deadline: late, not cancelled.
  const justLate = resolve(fixture(start), '2026-09-05T13:30:00.000Z', cfg, null);
  assert.deepEqual(justLate.lateJobs, ['j1']);
  assert.deepEqual(justLate.cancelledJobs, []);
});

test('resolve(): an idle printer costs nothing, however long it sits; offers refresh only when due and seeded', () => {
  const start = '2026-09-05T10:00:00.000Z';
  const s = fixture(start);
  s.printers[0].state = 'idle';
  s.assignments = [];
  s.jobs = [];
  s.profile.last_offer_at = start;
  const week = resolve(s, '2026-09-12T10:00:00.000Z', cfg, null);
  assert.deepEqual(week.ledgerRows, [], 'no electricity, no wear, no cost for an idle machine');
  assert.equal(week.updates.filter((u) => u.table === 'farm_printers').length, 0);
  // With a seed and the interval passed, the board is refilled deterministically.
  const withSeed = resolve(s, '2026-09-12T10:00:00.000Z', cfg, 'c'.repeat(64));
  assert.equal(withSeed.newOffers.length, cfg.jobs.offers_visible);
  assert.deepEqual(withSeed.newOffers, resolve(s, '2026-09-12T10:00:00.000Z', cfg, 'c'.repeat(64)).newOffers);
  const profileUpdate = withSeed.updates.find((u) => u.table === 'farm_profiles')!;
  assert.equal(profileUpdate.set.offer_refresh_index, 2);
  // Too soon after the last refresh: nothing new.
  const soon = resolve(s, '2026-09-05T10:05:00.000Z', cfg, 'c'.repeat(64));
  assert.deepEqual(soon.newOffers, []);
});

// ------------------------------------------------------------------ 0054: server randomness, key namespaces

test('randomSeedHex is 64 hex chars and never repeats; client keys cannot wear a server namespace', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const h = randomSeedHex();
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!seen.has(h), 'a repeated seed');
    seen.add(h);
  }
  // A random seed feeds the same PRNG as a derived one, so outcomes stay reproducible from the stored row.
  const h = randomSeedHex();
  assert.equal(roll(h, 'outcome'), roll(h, 'outcome'));
  assert.equal(clientKeyProblem('fine-key-0001'), null);
  assert.match(clientKeyProblem('fl_energy_fasg_x') ?? '', /fl_/);
  assert.match(clientKeyProblem('sys:fl_energy_x') ?? '', /":"/);
  assert.match(clientKeyProblem('sysfoo-00000001') ?? '', /sys/);
  assert.match(clientKeyProblem('a:b-00000001') ?? '', /":"/);
  assert.equal(clientLedgerKey('k1'), 'req:k1');
  assert.equal(systemLedgerKey('fl_energy_a'), 'sys:fl_energy_a');
});

// ------------------------------------------------------------------ 0054: delivery plan, deferred payout, late → ready

test('deliveryPlan: one shape for collect and for the resolver — payout id names the job, lateness is judged on the hand-over time', () => {
  const now = '2026-09-05T12:00:00.000Z';
  const s = fixture('2026-09-05T10:00:00.000Z');
  s.assignments[0].state = 'collected';
  s.assignments[0].quality = 'fine';
  const running = { reputation: 1000, xp: 90, level: 1, stats: emptyStats() };
  const onTime = deliveryPlan({ userId: 'u', job: s.jobs[0], assignments: s.assignments, deliveredAt: now, now, running, cfg });
  assert.equal(onTime.summary.late, false);
  assert.equal(onTime.ledgerRow?.id, 'fl_payout_j1');
  assert.equal(onTime.ledgerRow?.idempotencyKey, 'sys:fl_payout_j1');
  assert.equal(onTime.ledgerRow?.amount, 300);
  assert.equal(onTime.running.reputation, 1000 + Math.round(40 * cfg.quality.fine.reputation_factor), 'gain scaled by the quality printed');
  assert.equal(onTime.running.xp, 90 + cfg.progression.xp_per_job + 2 * cfg.progression.xp_per_part);
  assert.equal(onTime.running.level, 2, 'crossed the 100 xp threshold');
  assert.equal(onTime.summary.level_up, true);
  assert.deepEqual(onTime.events.map((e) => e.kind), ['level_up']);
  assert.deepEqual(onTime.daily, { day: '2026-09-05', coins: 300, jobs: 1 });
  assert.equal(onTime.running.stats.delivered, 1);
  assert.equal(onTime.running.stats.streak, 1);
  const jobUpdate = onTime.updates.find((u) => u.table === 'farm_jobs')!;
  assert.equal(jobUpdate.set.state, 'delivered');
  assert.equal(jobUpdate.set.delivered_at, now);
  assert.equal(jobUpdate.set.payout_deferred_day, null);
  assert.deepEqual(jobUpdate.guardStateIn, ['accepted', 'printing', 'ready', 'late']);
  // Paid a day later, but handed over before the deadline: still not late.
  const later = deliveryPlan({ userId: 'u', job: s.jobs[0], assignments: s.assignments, deliveredAt: now, now: '2026-09-06T09:00:00.000Z', running, cfg });
  assert.equal(later.summary.late, false);
  assert.equal(later.daily.day, '2026-09-06', 'counted on the day the coins arrive');
  // Handed over after the deadline: the penalty, wherever the payout lands.
  const late = deliveryPlan({ userId: 'u', job: s.jobs[0], assignments: s.assignments, deliveredAt: '2026-09-05T14:00:00.000Z', now, running, cfg });
  assert.equal(late.summary.late, true);
  assert.equal(late.running.reputation, 1000 - 80);
  assert.equal(late.running.stats.late, 1);
  assert.equal(late.running.stats.streak, 0);
  // The cap helper.
  assert.equal(dailyCapAllows(null, 300, cfg), true);
  assert.equal(dailyCapAllows({ jobs_delivered: cfg.limits.daily_jobs_cap, coins_earned: 0 }, 300, cfg), false);
  assert.equal(dailyCapAllows({ jobs_delivered: 0, coins_earned: cfg.limits.daily_coins_cap - 299 }, 300, cfg), false);
  assert.equal(dailyCapAllows({ jobs_delivered: 0, coins_earned: cfg.limits.daily_coins_cap - 300 }, 300, cfg), true);
});

test('resolve(): a payout deferred by the daily cap is paid on a later day under that day\'s cap, and never touched by the deadline', () => {
  const start = '2026-09-05T10:00:00.000Z';
  const s = fixture(start);
  s.printers[0].state = 'idle';
  s.assignments[0].state = 'collected';
  s.assignments[0].collected_at = '2026-09-05T11:00:00.000Z';
  s.jobs[0].state = 'ready';
  s.jobs[0].delivered_at = '2026-09-05T11:00:00.000Z';
  s.jobs[0].payout_deferred_day = '2026-09-05';
  // Same day: waits. Past the deadline + grace on the same day: still not cancelled.
  const sameDay = resolve(s, '2026-09-05T20:00:00.000Z', cfg, null);
  assert.deepEqual(sameDay.paidJobs, []);
  assert.deepEqual(sameDay.cancelledJobs, []);
  assert.deepEqual(sameDay.lateJobs, []);
  assert.equal(sameDay.ledgerRows.length, 0);
  // Next Baghdad day: paid once, counted on that day, profile advanced.
  const next = resolve(s, '2026-09-06T05:00:00.000Z', cfg, null);
  assert.deepEqual(next.paidJobs, ['j1']);
  assert.equal(next.ledgerRows.length, 1);
  assert.equal(next.ledgerRows[0].id, 'fl_payout_j1');
  assert.equal(next.ledgerRows[0].idempotencyKey, 'sys:fl_payout_j1');
  assert.equal(next.balance, 1500 + 300);
  assert.deepEqual(next.dailyIncrements, [{ day: '2026-09-06', coins: 300, jobs: 1 }]);
  const job = next.updates.find((u) => u.table === 'farm_jobs' && u.id === 'j1')!;
  assert.equal(job.set.state, 'delivered');
  assert.equal(job.set.delivered_at, '2026-09-05T11:00:00.000Z', 'the hand-over time is kept');
  const profile = next.updates.find((u) => u.table === 'farm_profiles')!;
  assert.equal(profile.set.xp, cfg.progression.xp_per_job + 2 * cfg.progression.xp_per_part);
  assert.equal(profile.set.reputation_bp, 1040, 'handed over before the 13:00 deadline → gain, not penalty');
  assert.equal(next.stats.delivered, 1);
  assert.equal(next.stats.late, 0);
  assert.deepEqual(next.cancelledJobs, [], 'a handed-over job is never cancelled by the customer');
  assert.deepEqual(resolve(s, '2026-09-06T05:00:00.000Z', cfg, null), next, 'deterministic');
  // The next day is itself at the cap: it waits again, silently.
  const full = { ...s, daily: { user_id: 'u', day: '2026-09-06', coins_earned: 0, jobs_delivered: cfg.limits.daily_jobs_cap, points_converted: 0 } };
  const held = resolve(full, '2026-09-06T05:00:00.000Z', cfg, null);
  assert.deepEqual(held.paidJobs, []);
  assert.equal(held.ledgerRows.length, 0);
  assert.equal(held.changed, false);
});

test('resolve(): a job already late becomes ready when its last part finishes — event and list, state keeps the overlay', () => {
  const start = '2026-09-05T10:00:00.000Z';
  const s = fixture(start);
  s.jobs[0].state = 'late';
  s.jobs[0].deadline_at = '2026-09-05T10:01:00.000Z';
  const r = resolve(s, '2026-09-05T10:03:00.000Z', cfg, null);
  assert.deepEqual(r.readyJobs, ['j1']);
  assert.ok(r.events.some((e) => e.kind === 'job_ready' && e.payload.late === true));
  assert.equal(r.updates.some((u) => u.table === 'farm_jobs' && u.set.state === 'ready'), false, 'late is not overwritten');
  assert.deepEqual(r.lateJobs, [], 'not marked late a second time');
  assert.deepEqual(r.cancelledJobs, []);
});
