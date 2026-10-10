/**
 * WHAT THE HOT PUBLIC ROUTES COST D1 (P2a; plan §B.1 #4) — ceilings, measured.
 *
 * Each route runs on the real router against the real migrations through the
 * wave-counting adapter (tests/fixtures/wavesD1.ts): `prepares` is how many
 * statements it built, `waves` how many DEPENDENT round trips it took — the
 * number that becomes latency from a Worker whose D1 primary is in another
 * region. The ceilings below are the numbers measured after P2a; a change
 * that adds a wave to a first-screen route fails here, by name.
 *
 *   before → after (guest, warm isolate; member in brackets)
 *   /api/home              4 → 3  (7 → 6)      /api/products          3 → 2  (6 → 5)
 *   /api/home/sections     5 → 4  (8 → 6)      /api/products/:slug    6 → 2  (9 → 5)
 *   storefront resolve     9 → 5                 /:slug/reviews         3 → 2
 *
 * Also proved: the pricing inputs are read in ONE wave on a cold isolate and
 * from memory on a warm one; an admin write forgets them at once; the
 * shopfront reads the owner's tier once, not twice.
 *
 * Run: node --import tsx --test tests/d1Waves.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, stubApp, get, type Mount, type StubUser } from './fixtures/app';
import { wavesD1 } from './fixtures/wavesD1';
import { seedLiveCatalog, LIVE_PRODUCTS } from './fixtures/liveCatalog';
import { seedLayoutStore, SLUG } from './fixtures/storeLayout';
import { homeRoutes, productRoutes, pricingCtxForUser } from '../worker/routes/products';
import { storefrontRoutes } from '../worker/routes/storefront';
import { miscRoutes } from '../worker/routes/misc';
import { communityRoutes } from '../worker/routes/community';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { PRICING_INPUTS_TTL_MS, forgetPricingInputs, pricingInputsFor } from '../worker/lib/membershipBenefits';

const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const HOST = `${SLUG}.levonis-iq.com`;
const MEMBER: StubUser = { id: 'c1', role: 'customer', email: 'c1@x.co' };

const mount: Mount = (a) => {
  a.route('/api/home', homeRoutes);
  a.route('/api/products', productRoutes);
  a.route('/api/storefront', storefrontRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/print-quote', printQuoteRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api', miscRoutes);
};

function world() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  seedLayoutStore(raw);
  const { waves, db } = wavesD1(raw);
  const app = (user: StubUser | null, host?: string) => stubApp(db, user, mount, { host, env: ENV });
  const measure = async (path: string, user: StubUser | null = null, host?: string) => {
    waves.reset();
    const res = await get(app(user, host), path);
    const body = await res.text();
    assert.equal(res.status, 200, `${path}: ${body}`);
    return { ...waves.counts };
  };
  return { raw, db, waves, measure };
}

/** The ceilings (guest warm / guest cold / member warm), the prepare ceiling, and where. */
const CEILINGS: Array<{ path: string; host?: string; waves: [warm: number, cold: number, member: number]; prepares: number }> = [
  // FX-7: the SKU rung (product_sku_prices) is read beside the relations, in the same wave — one statement, no wave.
  { path: '/api/home', waves: [3, 3, 6], prepares: 23 },
  { path: '/api/home/sections', waves: [4, 4, 6], prepares: 22 },
  { path: '/api/products', waves: [2, 2, 5], prepares: 17 },
  { path: `/api/products/${LIVE_PRODUCTS[0].slug}`, waves: [2, 2, 5], prepares: 23 },
  // FX-1: the display rate (pricing_fx_rates USD) is read beside the settings, in the same wave.
  { path: '/api/settings/public', waves: [1, 1, 1], prepares: 2 },
  { path: '/api/community/access', waves: [1, 1, 1], prepares: 1 },
  { path: '/api/storefront/resolve', host: HOST, waves: [5, 5, 5], prepares: 20 },
  { path: `/api/storefront/${SLUG}`, waves: [5, 5, 5], prepares: 20 },
  { path: `/api/storefront/${SLUG}/products`, waves: [2, 2, 2], prepares: 2 },
  { path: `/api/storefront/${SLUG}/reviews`, waves: [2, 2, 2], prepares: 3 },
  { path: '/api/print-quote/materials', waves: [1, 1, 1], prepares: 1 },
  { path: '/api/print-quote/printers', waves: [2, 2, 3], prepares: 3 },
  { path: '/api/print-quote/accessories', waves: [1, 1, 1], prepares: 1 },
  { path: '/api/marketplace/print/catalog', waves: [1, 1, 1], prepares: 3 },
];

test('every hot public route stays under its measured wave and prepare ceilings — cold isolate, warm isolate, signed in', async () => {
  const w = world();
  const report: string[] = [];
  for (const r of CEILINGS) {
    const cold = await w.measure(r.path, null, r.host);
    const warm = await w.measure(r.path, null, r.host);
    const member = await w.measure(r.path, MEMBER, r.host);
    report.push(`${r.path}: waves cold ${cold.waves} warm ${warm.waves} member ${member.waves}; prepares ${cold.prepares}/${warm.prepares}/${member.prepares}`);
    assert.ok(cold.waves <= r.waves[1], `${r.path} cold: ${cold.waves} waves > ${r.waves[1]}\n${cold.sqls.join('\n')}`);
    assert.ok(warm.waves <= r.waves[0], `${r.path} warm: ${warm.waves} waves > ${r.waves[0]}\n${warm.sqls.join('\n')}`);
    assert.ok(member.waves <= r.waves[2], `${r.path} member: ${member.waves} waves > ${r.waves[2]}\n${member.sqls.join('\n')}`);
    for (const c of [cold, warm, member]) assert.ok(c.prepares <= r.prepares + (c === member ? 5 : 0), `${r.path}: ${c.prepares} prepares > ${r.prepares}`);
  }
  console.log(report.join('\n'));
});

test('the pricing inputs: one wave cold, no statement warm, forgotten at once by the seam, re-read after the TTL', async () => {
  const w = world();
  w.waves.reset();
  await pricingCtxForUser(w.db, null);
  assert.equal(w.waves.counts.waves, 1, 'settings, rules, ancestry and the pause go out together');
  assert.equal(w.waves.counts.executions, 4);
  w.waves.reset();
  await pricingCtxForUser(w.db, null);
  assert.equal(w.waves.counts.executions, 0, 'a warm isolate prices from memory');
  // A member still pays their own tier, and nothing else.
  w.waves.reset();
  await pricingCtxForUser(w.db, 'c1');
  assert.ok(w.waves.counts.sqls.every((s) => !/admin_settings|membership_benefit_rules|FROM catalogs/.test(s)), w.waves.counts.sqls.join('\n'));
  forgetPricingInputs(w.db);
  w.waves.reset();
  await pricingCtxForUser(w.db, null);
  assert.equal(w.waves.counts.executions, 4, 'the seam forgets them in this isolate');
  // The TTL, on the memo's own clock: filled at t0, it answers until the
  // window closes and re-reads past it.
  forgetPricingInputs(w.db);
  const t0 = 1_700_000_000_000;
  await pricingInputsFor(w.db, t0);
  w.waves.reset();
  await pricingInputsFor(w.db, t0 + PRICING_INPUTS_TTL_MS - 1);
  assert.equal(w.waves.counts.executions, 0);
  await pricingInputsFor(w.db, t0 + PRICING_INPUTS_TTL_MS + 1);
  assert.equal(w.waves.counts.executions, 4);
  // A second database never sees the first one's memo (keyed by the binding).
  const other = world();
  other.waves.reset();
  await pricingCtxForUser(other.db, null);
  assert.equal(other.waves.counts.executions, 4);
});

test('the shopfront reads the owner\'s tier ONCE, and its stats in one batch', async () => {
  const w = world();
  const c = await w.measure('/api/storefront/resolve', null, HOST);
  const sweeps = c.sqls.filter((s) => s.startsWith("UPDATE memberships SET state = 'expired'"));
  assert.equal(sweeps.length, 1, `getTierStatus ran ${sweeps.length} times:\n${c.sqls.join('\n')}`);
  assert.equal(c.batches, 1, 'the four stat counts are one D1 call');
  assert.ok(c.sqls.some((s) => s.startsWith('BATCH(4)')));
  // The product page: everything that needs only the row's id leaves in the second wave.
  const p = await w.measure(`/api/products/${LIVE_PRODUCTS[0].slug}`);
  assert.equal(p.waves, 2, p.sqls.join('\n'));
  const home = await w.measure('/api/home');
  assert.equal(home.waves, 3, home.sqls.join('\n'));
});
