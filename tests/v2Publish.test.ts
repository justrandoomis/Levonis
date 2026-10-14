/**
 * THE CLEAN START'S TEST FIXTURE, PROVEN (spec addendum A.12.1;
 * tests/fixtures/v2Publish.ts).
 *
 *   1. the reproduce rule over 10,000 prices and rates (moved here with
 *      `usdReproducing` from tests/pricingV2Maths.test.ts: the V2-5 migration
 *      was retired by the owner's answer Q6, DECISIONS row 222);
 *   2. off-step prices move UP;
 *   3. `publishAllV2` publishes every census product through the real V2
 *      writer: each SKU's direct price stays the seeded one (to the step), its
 *      cheapest route stays under it, route fees are 0, compositions are
 *      skipped (owner question Q7) and a second call publishes nothing.
 *
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/v2Publish.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb } from './fixtures/app';
import { OWNER_ROW_SQL } from './fixtures/fx';
import { seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { cartGrid } from './fixtures/pricingV2';
import { FIXTURE_U, discountReproducing, isV2Published, publishAllV2, usdReproducing } from './fixtures/v2Publish';

type Q = readonly [bigint, bigint];
const q = (t: string): Q => {
  const [i, f = ''] = t.split('.');
  return [BigInt(`${i}${f}`), 10n ** BigInt(f.length)];
};
const qi = (n: number): Q => [BigInt(n), 1n];
const qMul = (a: Q, b: Q): Q => [a[0] * b[0], a[1] * b[1]];
const qSub = (a: Q, b: Q): Q => [a[0] * b[1] - b[0] * a[1], a[1] * b[1]];
const qCeilStep = (a: Q): number => {
  const d = a[1] * 1000n;
  const fl = a[0] / d;
  return Number((a[0] % d === 0n ? fl : fl + 1n) * 1000n);
};
const ceilStep = (n: number) => Math.ceil(n / 1000) * 1000;

function lcg(seed: bigint) {
  let state = seed;
  const rnd = () => {
    state = (state * 1103515245n + 12345n) % 2147483648n;
    return Number(state) / 2147483648;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  return { rnd, int };
}

test('reproduce property (10,000 prices and rates): ceil(usdReproducing(I) × U) = ceil(I); a pre-order under D is reproduced by Δ; above D sells at D', () => {
  const g = lcg(20261014n);
  for (let i = 0; i < 10_000; i++) {
    const U = `${g.int(1000, 99999)}.${String(g.int(0, 9999)).padStart(4, '0')}`;
    const I = g.int(1, 1_000_000_000);
    const usd = usdReproducing(I, U);
    assert.match(usd, /^[0-9]+(\.[0-9]{1,2})?$/, 'cents');
    assert.equal(qCeilStep(qMul(q(usd), q(U))), qCeilStep(qi(I)), `I ${I} U ${U} → ${usd}`);
    const D_I = g.int(1000, 1_000_000_000);
    const P_I = g.rnd() < 0.8 ? g.int(1, D_I) : g.int(D_I, D_I + 5_000_000);
    const D = usdReproducing(D_I, U);
    const delta = discountReproducing(D, P_I, U);
    const P = qCeilStep(qMul(qSub(q(D), q(delta)), q(U)));
    if (P_I <= D_I) assert.equal(P, qCeilStep(qi(P_I)), `D_I ${D_I} P_I ${P_I} U ${U}`);
    else {
      assert.equal(delta, '0');
      assert.equal(P, qCeilStep(qi(D_I)));
    }
  }
});

test('off-step prices move UP: 1,004,500 → 1,005,000 (never 1,004,000); a step-exact price stays; no float', () => {
  for (const U of ['1500', '1530.25', '1600', '99999.9999', '1000']) {
    assert.equal(qCeilStep(qMul(q(usdReproducing(1_004_500, U)), q(U))), 1_005_000, U);
    assert.equal(qCeilStep(qMul(q(usdReproducing(1_000_000, U)), q(U))), 1_000_000, U);
    assert.equal(qCeilStep(qMul(q(usdReproducing(1, U)), q(U))), 1000, U);
  }
  assert.equal(usdReproducing(1_500_000, '1500'), '1000');
  assert.equal(discountReproducing('1000', 1_425_000, '1500'), '50');
  assert.equal(discountReproducing('1000', 1_600_000, '1500'), '0', 'a pre-order above D sells at D');
  assert.throws(() => usdReproducing(1000, '100000'), RangeError, 'a cent × U must stay below one step');
  assert.throws(() => usdReproducing(0, '1500'), RangeError);
  assert.throws(() => usdReproducing(1000.5, '1500'), RangeError);
  assert.throws(() => usdReproducing(1000, 1500.5 as unknown as string), RangeError);
});

test('publishAllV2: every census product is published by the real V2 writer at U 1,500, its seeded prices kept to the step, fees 0', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const ids = seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  const db = asD1(raw);
  const before = new Map<string, Awaited<ReturnType<typeof cartGrid>>>();
  for (const id of ids) before.set(id, await cartGrid(db, id));
  const published = await publishAllV2(raw);
  assert.deepEqual([...published].sort(), [...ids].sort());
  assert.equal((raw.prepare("SELECT effective_rate AS r FROM fx_rate_pairs WHERE pair = 'USD_IQD'").get() as { r: string }).r, FIXTURE_U);
  let compared = 0;
  for (const id of ids) {
    assert.ok(isV2Published(raw, id), id);
    const after = await cartGrid(db, id);
    const was = before.get(id)!;
    for (const [key, now] of Object.entries(after)) {
      const old = was[key];
      if (!old?.ok || old.prepaid === null) continue;
      assert.ok(now.ok, `${id} ${key}: still sellable (${now.errors.join(',')})`);
      assert.equal(now.fee ?? 0, 0, `${id} ${key}: no fee on a V2 product`);
      if (key.endsWith('@direct_sale')) assert.equal(now.prepaid, ceilStep(old.prepaid), `${id} ${key}: the seeded direct price`);
      else {
        const direct = after[key.replace(/@.*$/, '@direct_sale')];
        if (direct?.prepaid != null) assert.ok(now.prepaid! <= direct.prepaid, `${id} ${key}: P ≤ D`);
      }
      compared++;
    }
  }
  assert.ok(compared > 100, `compared ${compared} SKU × channels`);
  assert.deepEqual(await publishAllV2(raw), [], 'a second call publishes nothing');
});

test('publishAllV2 skips compositions (owner question Q7): a bundle has no V2 method and stays unpublished', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO products (id, slug, name, status, price_iqd, stock, composition) VALUES ('b1', 'bundle-1', 'Bundle', 'active', 50000, 3, 'bundle')`);
  raw.exec(`INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES ('p1', 'plain-1', 'Plain', 'active', 12345, 3)`);
  assert.deepEqual(await publishAllV2(raw), ['p1']);
  assert.equal(isV2Published(raw, 'b1'), false);
  assert.equal(isV2Published(raw, 'p1'), true);
  const grid = await cartGrid(asD1(raw), 'p1');
  assert.equal(grid['@direct_sale']?.prepaid ?? grid[Object.keys(grid)[0]!]!.prepaid, 13_000, 'an off-step 12,345 moves to the next 1,000');
});
