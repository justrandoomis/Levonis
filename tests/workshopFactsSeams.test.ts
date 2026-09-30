/**
 * THE WORKSHOP PROFILE'S THREE SEAMS (community Phase 5, docs/COMMUNITY_ECOSYSTEM.md
 * §9.5) — each one a defect found after the builders finished, pinned here:
 *
 *   1. ABSENT MEANS UNCHANGED. The printers screen saves the matching filters
 *      alone; PUT /api/merchant/request-prefs used to write turnaround_days =
 *      NULL and workshop_intro = '' for the keys it did not send, wiping the
 *      «ملف الورشة» the store settings had written.
 *   2. NO SHARED DEFAULT. GET /request-prefs for a merchant without a row used
 *      to write the live printer facts INTO the module-level EMPTY_PREFS, so
 *      the next merchant without a row saw the previous workshop's technologies
 *      and bed for the life of the isolate.
 *   3. THE SHOPFRONT CARRIES THE FACTS. The storefront's Hero/Stats render the
 *      store read's `workshop`, which publicStore did not send; it now does, in
 *      one statement inside the shopfront's first wave (the d1Waves ceilings
 *      hold), and a plain shop sends `null`.
 *
 * Run: node --import tsx --test tests/workshopFactsSeams.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, put, get, json, row, type App, type Mount, type StubUser } from './fixtures/app';
import { merchantPrinterRoutes } from '../worker/routes/merchantPrinters';
import { storefrontRoutes } from '../worker/routes/storefront';
import { wavesD1 } from './fixtures/wavesD1';

const mount: Mount = (a) => {
  a.route('/api/merchant', merchantPrinterRoutes);
  a.route('/api/storefront', storefrontRoutes);
};

const FUTURE = '2099-01-01T00:00:00.000Z';
const ALI: StubUser = { id: 'owner', role: 'customer', email: 'owner@x.co' };
const OMAR: StubUser = { id: 'owner2', role: 'customer', email: 'owner2@x.co' };
const HIBA: StubUser = { id: 'owner3', role: 'customer', email: 'owner3@x.co' };

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('owner','Ali','owner@x.co','h','customer'), ('owner2','Omar','owner2@x.co','h','customer'),
      ('owner3','Hiba','owner3@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem3','owner3','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D'), ('m3','owner3','Hiba Shop');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,accepts_custom_requests) VALUES
      ('s1','m1','owner','ali3d','Ali 3D',1), ('s2','m2','owner2','omar3d','Omar 3D',1), ('s3','m3','owner3','hiba','Hiba Shop',0);
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials) VALUES
      ('p1','m1','s1','P1S','fdm',256,256,250,'["pla","petg"]');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const as = (raw: DatabaseSync, user: StubUser | null): App => stubApp(asD1(raw), user, mount);

test('1 · the printers screen saving its filters keeps the workshop turnaround and intro; a key that is sent is the new value', async () => {
  const raw = seed();
  const ali = as(raw, ALI);
  // «ملف الورشة» from the store settings: the whole prefs round-trip + the two fields.
  const first = await put(ali, '/api/merchant/request-prefs', { turnaround_days: 4, workshop_intro: 'We print fast.', governorates: ['baghdad'] });
  assert.equal(first.status, 200);
  // The printers screen's own save: the filters, and neither workshop key.
  const printersSave = await put(ali, '/api/merchant/request-prefs', {
    processes: ['fdm'], materials: ['pla'], colors: [], capabilities: [], governorates: ['baghdad', 'basra'], delivery: ['delivery'],
    min_job_iqd: 0, max_job_iqd: null, min_size_mm: 0, max_size_mm: null, workload: 'normal', paused: false, paused_until: '',
  });
  assert.equal(printersSave.status, 200);
  assert.deepEqual(
    row(raw, "SELECT turnaround_days, workshop_intro, governorates FROM merchant_request_prefs WHERE merchant_id = 'm1'"),
    { turnaround_days: 4, workshop_intro: 'We print fast.', governorates: '["baghdad","basra"]' },
    'the filters changed, the workshop profile did not'
  );
  // Sent keys are the new value — including an explicit clear.
  assert.equal((await put(ali, '/api/merchant/request-prefs', { turnaround_days: null, workshop_intro: '' })).status, 200);
  assert.deepEqual(
    row(raw, "SELECT turnaround_days, workshop_intro FROM merchant_request_prefs WHERE merchant_id = 'm1'"),
    { turnaround_days: null, workshop_intro: '' }
  );
  // A brand-new row with no workshop keys starts empty (no stale value to keep).
  const omar = as(raw, OMAR);
  assert.equal((await put(omar, '/api/merchant/request-prefs', { governorates: ['erbil'] })).status, 200);
  assert.deepEqual(row(raw, "SELECT turnaround_days, workshop_intro FROM merchant_request_prefs WHERE merchant_id = 'm2'"), { turnaround_days: null, workshop_intro: '' });
});

test('1b · ABSENT MEANS UNCHANGED for every column: a workshop-only PUT keeps the filters and the owner\'s pause (review 2026-09-30)', async () => {
  const raw = seed();
  const ali = as(raw, ALI);
  // The printers screen: Baghdad only, pickup only, jobs of 20k+, notifications paused, busy.
  const filters = await put(ali, '/api/merchant/request-prefs', {
    processes: ['fdm'], governorates: ['baghdad'], delivery: ['pickup'], min_job_iqd: 20000, paused: true, workload: 'busy',
  });
  assert.equal(filters.status, 200, await filters.text());
  // «ملف الورشة» sends its two keys alone (StoreSettingsTab `workshopPayload`).
  assert.equal((await put(ali, '/api/merchant/request-prefs', { turnaround_days: 3, workshop_intro: 'Fast prints' })).status, 200);
  const prefs = (await json(await get(ali, '/api/merchant/request-prefs'))).prefs;
  assert.deepEqual(
    { governorates: prefs.governorates, delivery: prefs.delivery, processes: prefs.processes, min_job_iqd: prefs.min_job_iqd, paused: prefs.paused, workload: prefs.workload },
    { governorates: ['baghdad'], delivery: ['pickup'], processes: ['fdm'], min_job_iqd: 20000, paused: true, workload: 'busy' },
    'the pause is honoured absolutely: a save that does not name it cannot lift it'
  );
  assert.deepEqual([prefs.turnaround_days, prefs.workshop_intro], [3, 'Fast prints']);
  // A key that IS sent is the new value — the unpause included.
  assert.equal((await put(ali, '/api/merchant/request-prefs', { paused: false })).status, 200);
  const after = (await json(await get(ali, '/api/merchant/request-prefs'))).prefs;
  assert.deepEqual([after.paused, after.governorates, after.turnaround_days], [false, ['baghdad'], 3]);
});

test('2 · a merchant without a prefs row never sees another workshop\'s live facts', async () => {
  const raw = seed();
  // Ali has a printer and no row: his GET computes live facts.
  const ali = (await json(await get(as(raw, ALI), '/api/merchant/request-prefs'))).prefs;
  assert.deepEqual(ali.technologies, ['fdm']);
  assert.deepEqual(ali.max_build_mm, { x: 256, y: 256, z: 250 });
  // Hiba has no printer and no row, in the same isolate: she must see nothing of Ali's.
  const hiba = (await json(await get(as(raw, HIBA), '/api/merchant/request-prefs'))).prefs;
  assert.deepEqual(hiba.technologies, [], 'no leaked technologies');
  assert.deepEqual(hiba.max_build_mm, {}, 'no leaked bed');
  // And the module default itself is untouched for the next reader.
  const again = (await json(await get(as(raw, OMAR), '/api/merchant/request-prefs'))).prefs;
  assert.deepEqual(again.technologies, []);
});

test('3 · the shopfront carries the workshop facts (stored, public, no economics) and a plain shop carries null, inside the wave ceiling', async () => {
  const raw = seed();
  // Ali saves his profile (which also stores the derived facts), then tracks a shelf.
  assert.equal((await put(as(raw, ALI), '/api/merchant/request-prefs', { turnaround_days: 3, workshop_intro: '  We print   fast. ', delivery: ['delivery'] })).status, 200);
  raw.exec("INSERT INTO merchant_material_stock (id,merchant_id,material_id,color_hex,grams) VALUES ('st1','m1','petg','',900)");
  const store = (await json(await get(as(raw, null), '/api/storefront/ali3d'))).store;
  assert.deepEqual(store.workshop, {
    technologies: ['fdm'],
    materials: ['petg'],
    max_build_mm: { x: 256, y: 256, z: 250 },
    turnaround_days: 3,
    governorates: [],
    delivery: ['delivery'],
    custom_enabled: true,
    intro: 'We print fast.',
  });
  assert.ok(!/machine_hour|cost|margin/i.test(JSON.stringify(store.workshop)), 'facts only');
  // A plain shop with no workshop row says nothing about printing.
  const hiba = (await json(await get(as(raw, null), '/api/storefront/hiba'))).store;
  assert.equal(hiba.workshop, null);
  // One more statement, no more dependent round trips than the shopfront's ceiling (tests/d1Waves.test.ts: 5).
  const { waves, db } = wavesD1(raw);
  const app = stubApp(db, null, mount);
  waves.reset();
  const res = await get(app, '/api/storefront/ali3d');
  assert.equal(res.status, 200);
  assert.ok(waves.counts.waves <= 5, `waves ${waves.counts.waves}`);
});
