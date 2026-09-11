/**
 * LEVO Printer Farm — the balancing targets docs/PRINTER_FARM.md §5 sets for
 * the DEFAULT configuration, asserted by simulating the documented first
 * session with the real engine (offers, durations, rewards, electricity):
 *
 *   * with one A1 mini and the starter spool the first job takes 2–4 real
 *     minutes;
 *   * a second spool is affordable after the first job, which is net-positive;
 *   * the second printer (an A1 mini) becomes affordable after roughly eight to
 *     ten delivered jobs — not at once, and not after twenty;
 *   * a single idle printer costs nothing, however long it sits.
 *
 * Every number here is a FIRST BALANCING GUESS (DECISIONS.md); when the owner
 * moves a default, this test says which target moved with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FARM_CONFIG_DEFAULTS } from '../worker/lib/farm/config';
import { gramsFor, ownedCapacity, productSpec } from '../worker/lib/farm/catalog';
import { generateOffers, starterFirstJob, type JobInsert } from '../worker/lib/farm/jobs';
import { levelForXp, xpForJob } from '../worker/lib/farm/progression';
import { seedFrom } from '../worker/lib/farm/rng';
import { resolve } from '../worker/lib/farm/sim';
import { gameHours, gameSecondsToRealMs, printSeconds } from '../worker/lib/farm/time';
import type { FarmPrinterRow, FarmState } from '../worker/lib/farm/types';

const cfg = FARM_CONFIG_DEFAULTS;
const a1mini = cfg.printers.a1_mini;
const NOW = '2026-09-05T10:00:00.000Z';

const starterPrinter: FarmPrinterRow = {
  id: 'p', user_id: 'sim', model_key: 'a1_mini', slot: 0, nickname: '', health: 100, state: 'idle', state_until: null,
  hours: 0, prints: 0, failures: 0, upgrades_json: '[]', created_at: NOW, updated_at: NOW, sold_at: null,
};

interface Session {
  coins: number;
  gramsByMaterial: Record<string, number>;
  xp: number;
  level: number;
  reputation: number;
  delivered: number;
  realMs: number;
  /** delivered-job count at which a second A1 mini first became affordable */
  printerAffordableAt: number | null;
  coinsAfterFirstJob: number | null;
  log: string[];
}

function electricity(seconds: number): number {
  return Math.round((a1mini.watts / 1000) * gameHours(seconds) * cfg.economy.energy.coins_per_kwh);
}

/** Prints a job on the one A1 mini, buying the smallest spool that covers a shortfall. Returns false when unaffordable. */
function deliver(s: Session, job: JobInsert): boolean {
  const product = productSpec(cfg, job.product_key)!;
  const material = cfg.materials[job.material];
  const need = gramsFor(product, job.qty);
  let have = s.gramsByMaterial[job.material] ?? 0;
  let spent = 0;
  while (have < need) {
    const size = cfg.economy.spool_sizes_g.find((g) => have + g >= need) ?? cfg.economy.spool_sizes_g[cfg.economy.spool_sizes_g.length - 1];
    const price = Math.ceil(material.price_per_gram * size);
    if (s.coins - spent < price) return false;
    spent += price;
    have += size;
  }
  // A job that cannot pay for the spool it needs is REJECTED, as a player
  // would (POST /jobs/:id/reject) — the sim is naive, not foolish.
  if (spent > job.reward_coins) return false;
  s.coins -= spent;
  s.gramsByMaterial[job.material] = have - need;
  const seconds = printSeconds(product, job.qty, a1mini, job.quality, cfg);
  s.realMs += gameSecondsToRealMs(seconds, cfg);
  s.coins += job.reward_coins - electricity(seconds);
  s.xp += xpForJob(job.qty, cfg);
  s.level = levelForXp(s.xp, cfg);
  s.reputation = Math.min(cfg.progression.reputation_cap_bp, s.reputation + job.reputation_gain_bp);
  s.delivered += 1;
  s.log.push(`#${s.delivered} ${job.product_key}×${job.qty} ${job.quality} +${job.reward_coins} → ${s.coins} coins`);
  if (s.delivered === 1) s.coinsAfterFirstJob = s.coins;
  if (s.printerAffordableAt === null && s.coins >= a1mini.price) s.printerAffordableAt = s.delivered;
  return true;
}

async function simulateFirstSession(userId: string, maxJobs = 20): Promise<Session> {
  const s: Session = {
    coins: cfg.economy.starter_coins,
    gramsByMaterial: { [cfg.starter.spool.material]: cfg.starter.spool.grams },
    xp: 0, level: 1, reputation: cfg.progression.reputation_start_bp, delivered: 0, realMs: 0,
    printerAffordableAt: null, coinsAfterFirstJob: null, log: [],
  };
  const capacity = ownedCapacity([starterPrinter], cfg);
  const first = starterFirstJob(cfg, userId, NOW)!;
  assert.ok(deliver(s, first), 'the starter kit must cover the first job');
  let refresh = 0;
  while (s.delivered < maxJobs && refresh < 200) {
    const offers = generateOffers({
      userId, profile: { level: s.level, reputation_bp: s.reputation }, capacity, now: NOW, cfg,
      seed: await seedFrom(userId, 'offers', String(refresh++)), count: cfg.jobs.offers_visible,
    });
    for (const o of offers) {
      if (s.delivered >= maxJobs) break;
      deliver(s, o);
    }
  }
  return s;
}

test('the first job on the starter A1 mini takes 2–4 real minutes', () => {
  const first = starterFirstJob(cfg, 'balance', NOW)!;
  const seconds = printSeconds(productSpec(cfg, first.product_key)!, first.qty, a1mini, first.quality, cfg);
  const minutes = gameSecondsToRealMs(seconds, cfg) / 60_000;
  assert.ok(minutes >= 2 && minutes <= 4, `first job takes ${minutes} real minutes`);
  assert.ok(first.grams <= cfg.starter.spool.grams, 'the starter spool covers it');
  assert.ok(first.reward_coins > electricity(seconds) + first.grams * cfg.materials[first.material].price_per_gram, 'the first job is worth more than its filament and power');
});

test('a second spool is affordable after the first job, and the first job is net-positive', async () => {
  const s = await simulateFirstSession('balance-a', 1);
  const smallestSpool = Math.ceil(cfg.materials.PLA.price_per_gram * Math.min(...cfg.economy.spool_sizes_g));
  assert.ok(s.coinsAfterFirstJob! >= smallestSpool, `coins after job 1: ${s.coinsAfterFirstJob} < spool ${smallestSpool}`);
  assert.ok(s.coinsAfterFirstJob! > cfg.economy.starter_coins, `the first job must add coins (${s.coinsAfterFirstJob} vs ${cfg.economy.starter_coins})`);
});

test('the second A1 mini becomes affordable after roughly eight to ten delivered jobs (eight simulated players)', async () => {
  // Offers are random per player (seeded), so one player may land a big
  // lithophane order early and another may only hear about keychains; the
  // TARGET is the average, and every player must land in a sane window.
  const counts: number[] = [];
  const players = ['balance-1', 'balance-2', 'balance-3', 'balance-4', 'balance-5', 'balance-6', 'balance-7', 'balance-8'];
  for (const who of players) {
    const s = await simulateFirstSession(who, 20);
    assert.ok(s.printerAffordableAt !== null, `never affordable in 20 jobs:\n${s.log.join('\n')}`);
    counts.push(s.printerAffordableAt!);
    assert.ok(s.printerAffordableAt! >= 4, `too easy for ${who}: affordable after ${s.printerAffordableAt} jobs\n${s.log.join('\n')}`);
    assert.ok(s.printerAffordableAt! <= 14, `too slow for ${who}: affordable after ${s.printerAffordableAt} jobs\n${s.log.join('\n')}`);
  }
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  assert.ok(avg >= 7.5 && avg <= 10.5, `average ${avg} jobs (${counts.join(', ')}) is off the 8–10 target`);
});

test('a single idle printer costs nothing, however long it sits', () => {
  const state: FarmState = {
    profile: {
      user_id: 'sim', farm_name: '', level: 1, xp: 0, reputation_bp: 0, location_key: 'tiny_room', state: 'active',
      last_seen_at: NOW, last_resolved_at: NOW, last_offer_at: NOW, offer_refresh_index: 1, config_version: 0,
      stats_json: '{}', tutorial_json: '{}', created_at: NOW, updated_at: NOW, revision: 0, offer_salt: 's'.repeat(64),
    },
    balance: cfg.economy.starter_coins,
    printers: [starterPrinter],
    spools: [],
    jobs: [],
    assignments: [],
    daily: null,
  };
  for (const later of ['2026-09-05T11:00:00.000Z', '2026-09-06T10:00:00.000Z', '2026-10-05T10:00:00.000Z', '2027-09-05T10:00:00.000Z']) {
    const r = resolve(state, later, cfg, null);
    assert.deepEqual(r.ledgerRows, [], `an idle printer was charged at ${later}`);
    assert.equal(r.balance, cfg.economy.starter_coins);
    assert.equal(r.updates.filter((u) => u.table === 'farm_printers').length, 0, 'no wear, no state change');
  }
});
