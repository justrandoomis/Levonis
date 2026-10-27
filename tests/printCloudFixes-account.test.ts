/**
 * LEVONIS PRINT CLOUD — the server gaps the customer's ACCOUNT screens
 * exposed (src/cloud/pages/account), each closed and proven here:
 *
 *   g1  a finished print already on a live shipment could be asked for again:
 *       the plan never looked, and the database's own guard (the partial
 *       unique index on live items) answered «STATE_CHANGED — try again»
 *       after three plans, for ever. Now refused ALREADY_IN_SHIPMENT by name,
 *       two requests racing for one print make ONE shipment, and GET /jobs
 *       names the shipment each finished print is on.
 *   g2  the two ledgers paged on `created_at < before` alone, so a page that
 *       ended inside an instant one batch wrote skipped the rest of it: now an
 *       exact (created_at, id) cursor, `before` alone keeping its old meaning.
 *   g3  POST /buybacks took no Idempotency-Key, so a retry after a lost answer
 *       reserved the grams twice: now a money door (required key, its answer
 *       stored in pc_operations in the same batch as the reservation).
 *   g4  no customer door listed the conversion rules: GET /me/credits/conversions
 *       lists the enabled ones, POST /me/credits/convert/quote shows the very
 *       plan the conversion writes.
 *   g5  no delivery fee before POST /shipments: POST /shipments/quote answers
 *       the request's own assessment — fee, rule, start, items, refusals.
 *   g6  the workshop's default reminder amount and top-up target: stated on
 *       every GET /me/inventory row, the values the scan and the top-up apply.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-account.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  API,
  buy,
  call,
  estimatedJob,
  idem,
  ok,
  owned,
  pcWorld,
  reconcileClean,
  refused,
  row,
  rows,
  runToPrinting,
  seedCatalog,
  type Catalog,
  type Json,
  type World,
} from './fixtures/printCloud';
import { enqueueTask } from '../worker/lib/printCloud/tasks';
import { ledgerCursor } from '../worker/lib/printCloud/reports';

const H = 3600;
const ADDRESS = { recipient_name: 'Ali', phone: '07700000000', governorate: 'baghdad', city: 'Baghdad', address_line: 'Karrada, street 62' };
const ERBIL = { ...ADDRESS, governorate: 'erbil', city: 'Erbil', address_line: '100m road' };

async function patchSettings(w: World, config: Record<string, unknown>): Promise<void> {
  const settings = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, { version: settings.version, config });
}

/** A print of customer A's, finished: estimated, confirmed, printed and completed with 30 g of white PLA. */
async function finishedPrint(w: World, cat: Catalog, title = 'Dragon'): Promise<string> {
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 30 }], title });
  await runToPrinting(w, w.a, jobId);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: cat.white, qty: 30 }] });
  return jobId;
}

async function completedRow(w: World, jobId: string): Promise<Json> {
  const jobs = await ok(w.a, 'GET', `${API}/jobs`);
  const job = jobs.completed.find((j: Json) => j.id === jobId);
  assert.ok(job, `job ${jobId} is listed as completed`);
  return job;
}

const count = (w: World, table: string, where = '1 = 1') => Number(row(w, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)?.n);

// ============================================================ g1 — one live shipment per finished print

test('g1: a finished print on a live shipment is refused by name — never «try again» — and GET /jobs names that shipment', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const jobId = await finishedPrint(w, cat);
  assert.equal((await completedRow(w, jobId)).shipment_id, null, 'free to leave');

  const first = await ok(w.a, 'POST', `${API}/shipments`, { kind: 'pickup', job_ids: [jobId] }, idem('s1'));
  assert.equal((await completedRow(w, jobId)).shipment_id, first.shipment_id, 'GET /jobs names the shipment it is on');

  const again = await refused(w.a, 'POST', `${API}/shipments`, { kind: 'pickup', job_ids: [jobId] }, 'ALREADY_IN_SHIPMENT', idem('s2'));
  assert.equal(again.details.job_id, jobId);
  assert.equal(again.details.shipment_id, first.shipment_id, 'the refusal names the shipment that carries it');
  const words = again.details.messages;
  assert.ok(words.ar && words.en && words.ckb, 'three languages');
  assert.notEqual(words.ckb, words.ar, 'the Sorani is its own');
  // The quote says the same before anything is sent; with material beside it, nothing of that is held either.
  await refused(w.a, 'POST', `${API}/shipments/quote`, { kind: 'pickup', job_ids: [jobId] }, 'ALREADY_IN_SHIPMENT');
  await refused(
    w.a,
    'POST',
    `${API}/shipments`,
    { kind: 'delivery', job_ids: [jobId], items: [{ variant_id: cat.white, qty: 100 }], payment_method: 'manual', delivery_address: ADDRESS },
    'ALREADY_IN_SHIPMENT',
    idem('s3')
  );
  assert.equal((await owned(w.a, cat.white)).reserved_qty, 0, 'nothing held by a refused request');
  assert.equal(count(w, 'pc_shipments'), 1);
  assert.equal(count(w, 'pc_orders', "kind = 'shipping'"), 0, 'no fee order either');

  // Cancelled, the print is free again — the next request takes it.
  await ok(w.a, 'POST', `${API}/shipments/${first.shipment_id}/cancel`);
  assert.equal((await completedRow(w, jobId)).shipment_id, null);
  const second = await ok(w.a, 'POST', `${API}/shipments`, { kind: 'pickup', job_ids: [jobId] }, idem('s4'));
  // Handed over, it stays on that shipment for good.
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${second.shipment_id}/advance`, { to: 'ready_for_pickup' });
  await ok(w.assistant, 'POST', `${ADMIN}/shipments/${second.shipment_id}/advance`, { to: 'picked_up' });
  const after = await refused(w.a, 'POST', `${API}/shipments`, { kind: 'pickup', job_ids: [jobId] }, 'ALREADY_IN_SHIPMENT', idem('s5'));
  assert.equal(after.details.shipment_id, second.shipment_id);
  assert.equal((await completedRow(w, jobId)).shipment_id, second.shipment_id);
  await reconcileClean(w);
});

test('g1: two requests racing for one print make ONE shipment; the loser writes nothing and is refused by name', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const jobId = await finishedPrint(w, cat);
  const body = { kind: 'pickup', job_ids: [jobId] };
  const seen: { winner?: { status: number; json: Json } } = {};
  // The competing request lands at the exact moment the first is about to write its batch.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_shipment_items'));
  w.race.hook = async () => {
    seen.winner = await call(w.a, 'POST', `${API}/shipments`, body, idem('race-winner'));
  };
  const loserKey = idem('race-loser');
  const loser = await call(w.a, 'POST', `${API}/shipments`, body, loserKey);
  assert.equal(w.race.hook, null, 'the competing request ran just before the first one’s batch');
  assert.equal(seen.winner?.status, 201, JSON.stringify(seen.winner?.json).slice(0, 300));
  const winnerId = seen.winner?.json.data.shipment_id as string;
  assert.equal(loser.status, 409, JSON.stringify(loser.json).slice(0, 300));
  assert.equal(loser.json.code, 'ALREADY_IN_SHIPMENT', 'the re-plan names what happened, never «try again»');
  assert.equal(loser.json.details.shipment_id, winnerId);
  assert.deepEqual(rows(w, 'SELECT shipment_id FROM pc_shipment_items WHERE job_id = ? AND live = 1', jobId), [{ shipment_id: winnerId }]);
  assert.equal(row(w, 'SELECT shipment_id FROM pc_print_jobs WHERE id = ?', jobId)?.shipment_id, winnerId);
  assert.equal(count(w, 'pc_shipments'), 1, 'the loser’s shipment never existed');
  assert.equal(count(w, 'pc_operations', "scope = 'shipment.create'"), 1, 'and no answer was stored for its key…');
  await refused(w.a, 'POST', `${API}/shipments`, body, 'ALREADY_IN_SHIPMENT', loserKey);
  await reconcileClean(w);
});

test('g1: the batch itself refuses a print taken after its plan — the job’s fence and the live-item index, not the plan, are the guard', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 500 }]);
  const jobId = await finishedPrint(w, cat);
  const other = await finishedPrint(w, cat, 'Vase');
  // Between the plan and the batch, the print is taken by a shipment written behind the API's back (no job row
  // update at all — only a live item): the index alone must refuse, and the re-plan must name it.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_shipment_items'));
  w.race.hook = async () => {
    w.raw.exec(`INSERT INTO pc_shipments (id, user_id, kind, status, created_at, updated_at) VALUES ('pcsp_side', 'usr_pc_a', 'pickup', 'preparing', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    w.raw.prepare("INSERT INTO pc_shipment_items (id, shipment_id, item_type, job_id, qty, live) VALUES ('pcsi_side', 'pcsp_side', 'print_job', ?, 1, 1)").run(jobId);
  };
  const r = await call(w.a, 'POST', `${API}/shipments`, { kind: 'pickup', job_ids: [other, jobId] }, idem('both'));
  assert.equal(w.race.hook, null);
  assert.equal(r.status, 409, JSON.stringify(r.json).slice(0, 300));
  assert.equal(r.json.code, 'ALREADY_IN_SHIPMENT');
  assert.deepEqual([r.json.details.job_id, r.json.details.shipment_id], [jobId, 'pcsp_side']);
  assert.equal(row(w, 'SELECT shipment_id FROM pc_print_jobs WHERE id = ?', other)?.shipment_id, null, 'the other print was not taken either: one batch, nothing of it');
  assert.equal(count(w, 'pc_shipment_items', `job_id = '${other}' AND live = 1`), 0);

  // The other guard: the job row names a shipment the plan did not see (and no live item does) — the job's CAS
  // matches nothing, its fence aborts the batch, and the re-plan names the shipment.
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_shipment_items'));
  w.race.hook = async () => {
    w.raw.exec(`INSERT INTO pc_shipments (id, user_id, kind, status, created_at, updated_at) VALUES ('pcsp_row', 'usr_pc_a', 'pickup', 'preparing', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    w.raw.prepare("UPDATE pc_print_jobs SET shipment_id = 'pcsp_row' WHERE id = ?").run(other);
  };
  const fenced = await call(w.a, 'POST', `${API}/shipments`, { kind: 'pickup', job_ids: [other] }, idem('fenced'));
  assert.equal(w.race.hook, null);
  assert.equal(fenced.json.code, 'ALREADY_IN_SHIPMENT', JSON.stringify(fenced.json).slice(0, 300));
  assert.equal(fenced.json.details.shipment_id, 'pcsp_row');
  assert.equal(count(w, 'pc_shipment_items', `job_id = '${other}'`), 0, 'no item of it was written');
  assert.equal(count(w, 'pc_shipments'), 2, 'only the two shipments written behind the API’s back');
});

// ============================================================ g2 — the ledgers page exactly

/** A list answer (`data` is an array). */
const okList = async (app: World['a'], path: string): Promise<Json[]> => (await ok(app, 'GET', path)) as unknown as Json[];

async function pageAll(w: World, path: string, limit: number): Promise<Json[]> {
  const out: Json[] = [];
  let last: Json | null = null;
  for (let i = 0; i < 50; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const cursor = last ? `&before=${encodeURIComponent(last.created_at)}&before_id=${encodeURIComponent(last.id)}` : '';
    const page = await okList(w.a, `${path}${sep}limit=${limit}${cursor}`);
    out.push(...page);
    if (page.length < limit) return out;
    last = page[page.length - 1];
  }
  throw new Error('paging never ended');
}

test('g2: the credit ledger pages exactly — rows one batch wrote at one instant are never skipped between pages', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  // One payment, four packages: four ledger rows written by one batch, at one instant.
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'credit_package', package_id: cat.packages.h24 },
    { kind: 'credit_package', package_id: cat.packages.h48 },
    { kind: 'credit_package', package_id: cat.packages.h72 },
  ]);
  const all = await okList(w.a, `${API}/me/credits/ledger?limit=200`);
  assert.equal(all.length, 4);
  assert.equal(new Set(all.map((r) => r.created_at)).size, 1, 'the four rows share one instant');
  for (const limit of [1, 2, 3]) {
    assert.deepEqual((await pageAll(w, `${API}/me/credits/ledger`, limit)).map((r) => r.id), all.map((r) => r.id), `pages of ${limit}: every row once, in order`);
  }
  // The old cursor — the instant alone — keeps its meaning, «strictly before»: from inside the instant it finds
  // nothing more, which is the skip the exact cursor exists to prevent.
  const [first] = await okList(w.a, `${API}/me/credits/ledger?limit=1`);
  assert.deepEqual(await okList(w.a, `${API}/me/credits/ledger?before=${encodeURIComponent(first.created_at)}`), []);
  const exact = await okList(w.a, `${API}/me/credits/ledger?before=${encodeURIComponent(first.created_at)}&before_id=${encodeURIComponent(first.id)}`);
  assert.deepEqual(exact.map((r) => r.id), all.slice(1).map((r) => r.id));
  // An id without its instant is not a cursor.
  const bad = await refused(w.a, 'GET', `${API}/me/credits/ledger?before_id=${encodeURIComponent(first.id)}`, undefined, 'VALIDATION');
  assert.deepEqual([bad.details.field, bad.details.reason], ['before_id', 'requires_before']);
  // Another customer's rows are never on these pages.
  assert.deepEqual(await ok(w.b, 'GET', `${API}/me/credits/ledger?limit=200`), []);
});

test('g2: the material ledger pages exactly too, across variants and within one', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  // One payment: two lots of white (two lines), one each of black and red — four rows at one instant, two of white.
  await buy(w.a, [
    { kind: 'material', variant_id: cat.white, quantity: 250 },
    { kind: 'material', variant_id: cat.white, quantity: 100 },
    { kind: 'material', variant_id: cat.black, quantity: 100 },
    { kind: 'material', variant_id: cat.red, quantity: 100 },
  ]);
  const all = await okList(w.a, `${API}/me/inventory/ledger?limit=200`);
  assert.equal(all.length, 4);
  assert.equal(new Set(all.map((r) => r.created_at)).size, 1);
  for (const limit of [1, 3]) assert.deepEqual((await pageAll(w, `${API}/me/inventory/ledger`, limit)).map((r) => r.id), all.map((r) => r.id));
  const whites = await okList(w.a, `${API}/me/inventory/ledger?variant_id=${cat.white}&limit=200`);
  assert.equal(whites.length, 2);
  assert.deepEqual((await pageAll(w, `${API}/me/inventory/ledger?variant_id=${cat.white}`, 1)).map((r) => r.id), whites.map((r) => r.id));
  // The cursor is the page's own order: (created_at, id), newest first, as SQLite compares text.
  assert.deepEqual(ledgerCursor(null, null), { sql: '', params: [] });
  assert.deepEqual(ledgerCursor('2026-10-27T10:00:00.000Z', undefined), { sql: ' AND created_at < ?', params: ['2026-10-27T10:00:00.000Z'] });
  assert.deepEqual(ledgerCursor('2026-10-27T10:00:00.000Z', 'pcil_x'), {
    sql: ' AND (created_at < ? OR (created_at = ? AND id < ?))',
    params: ['2026-10-27T10:00:00.000Z', '2026-10-27T10:00:00.000Z', 'pcil_x'],
  });
  assert.throws(() => ledgerCursor('', 'pcil_x'), (e: { code?: string }) => e.code === 'VALIDATION');
});

// ============================================================ g3 — a sell-back is a money door

async function buybackWorld(): Promise<{ w: World; cat: Catalog }> {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await ok(w.full, 'PATCH', `${ADMIN}/categories/filaments/buyback`, { buyback_enabled: true, buyback_rate_bps: 5000 });
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 250 }]);
  return { w, cat };
}

test('g3: POST /buybacks takes a key: without one nothing is held; a retry with it replays the first answer, never a second reservation', async () => {
  const { w, cat } = await buybackWorld();
  const body = { variant_id: cat.white, qty: 100 };
  await refused(w.a, 'POST', `${API}/buybacks`, body, 'IDEMPOTENCY_KEY_REQUIRED');
  await refused(w.a, 'POST', `${API}/buybacks`, body, 'IDEMPOTENCY_KEY_REQUIRED', { 'Idempotency-Key': 'short' });
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.white)).reserved_qty], [250, 0]);
  assert.equal(count(w, 'pc_buyback_requests'), 0);

  const key = idem('bb');
  const first = await call(w.a, 'POST', `${API}/buybacks`, body, key);
  assert.equal(first.status, 201, JSON.stringify(first.json).slice(0, 300));
  assert.equal(first.json.data.replayed, false);
  assert.equal(first.json.data.estimated_value_iqd, 1600, '100 g of a 250 g lot bought for 8,000 IQD, at 50 %');
  // The answer was lost on the way back; the customer's screen sends the same intent again.
  const retry = await call(w.a, 'POST', `${API}/buybacks`, body, key);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.data.replayed, true);
  assert.deepEqual({ ...retry.json.data, replayed: false }, first.json.data, 'the first answer, word for word');
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.white)).reserved_qty], [150, 100], 'held once');
  assert.equal(count(w, 'pc_buyback_requests'), 1);
  assert.equal(count(w, 'pc_inventory_reservations', "purpose = 'buyback'"), 1);
  // The key's answer was stored by the same batch as the reservation, under the customer.
  const op = row(w, "SELECT actor_id, result_json FROM pc_operations WHERE scope = 'buyback.request'");
  assert.equal(op?.actor_id, 'usr_pc_a');
  assert.equal(JSON.parse(String(op?.result_json)).buyback_id, first.json.data.buyback_id);
  // The same key for another request is refused; another key is another sell-back.
  await refused(w.a, 'POST', `${API}/buybacks`, { variant_id: cat.white, qty: 50 }, 'IDEMPOTENCY_KEY_REUSED', key);
  const other = await ok(w.a, 'POST', `${API}/buybacks`, { variant_id: cat.white, qty: 50 }, idem('bb2'));
  assert.notEqual(other.buyback_id, first.json.data.buyback_id);
  // A refusal is not stored: the key may be used again once the request can go through.
  const late = idem('bb3');
  await refused(w.a, 'POST', `${API}/buybacks`, { variant_id: cat.white, qty: 200 }, 'INSUFFICIENT_INVENTORY', late);
  await ok(w.a, 'POST', `${API}/buybacks/${other.buyback_id}/cancel`);
  await ok(w.a, 'POST', `${API}/buybacks/${first.json.data.buyback_id}/cancel`);
  const after = await call(w.a, 'POST', `${API}/buybacks`, { variant_id: cat.white, qty: 200 }, late);
  assert.equal(after.status, 201);
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.white)).reserved_qty], [50, 200]);
  await reconcileClean(w);
});

test('g3: a retry racing its own original (the answer still on its way) makes ONE sell-back', async () => {
  const { w, cat } = await buybackWorld();
  const body = { variant_id: cat.white, qty: 100 };
  const key = idem('bb-race');
  const seen: { original?: { status: number; json: Json } } = {};
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_buyback_requests'));
  w.race.hook = async () => {
    seen.original = await call(w.a, 'POST', `${API}/buybacks`, body, key);
  };
  const retry = await call(w.a, 'POST', `${API}/buybacks`, body, key);
  assert.equal(w.race.hook, null, 'the original committed just before the retry’s batch');
  assert.equal(seen.original?.status, 201);
  assert.equal(retry.status, 200, JSON.stringify(retry.json).slice(0, 300));
  assert.equal(retry.json.data.replayed, true);
  assert.equal(retry.json.data.buyback_id, seen.original?.json.data.buyback_id);
  assert.equal(count(w, 'pc_buyback_requests'), 1);
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.white)).reserved_qty], [150, 100]);
  await reconcileClean(w);
});

test('g3: two different sell-backs racing for the same last grams: one holds them, the other is refused — never an oversold balance', async () => {
  const { w, cat } = await buybackWorld();
  const seen: { first?: { status: number; json: Json } } = {};
  w.race.when = (sqls) => sqls.some((s) => s.includes('INSERT INTO pc_buyback_requests'));
  w.race.hook = async () => {
    seen.first = await call(w.a, 'POST', `${API}/buybacks`, { variant_id: cat.white, qty: 200 }, idem('bb-a'));
  };
  const second = await call(w.a, 'POST', `${API}/buybacks`, { variant_id: cat.white, qty: 100 }, idem('bb-b'));
  assert.equal(seen.first?.status, 201);
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'INSUFFICIENT_INVENTORY');
  assert.deepEqual([(await owned(w.a, cat.white)).available_qty, (await owned(w.a, cat.white)).reserved_qty], [50, 200]);
  assert.equal(count(w, 'pc_operations', "scope = 'buyback.request'"), 1, 'only the request that went through stored its answer');
  await reconcileClean(w);
});

// ============================================================ g4 — the conversions, listed and previewed by the conversion's own plan

async function tier(w: World, code: string): Promise<string> {
  return (await ok(w.owner, 'POST', `${ADMIN}/catalog/tiers`, { code, name_en: `${code} hours`, name_ar: `ساعات ${code}`, name_ckb: `کاتژمێرەکانی ${code}`, hourly_rate_iqd: 750 })).id;
}

async function rule(w: World, from: string, to: string, num: number, den: number, enabled: boolean): Promise<string> {
  const r = await ok(w.full, 'POST', `${ADMIN}/catalog/conversion_rules`, { from_tier_id: from, to_tier_id: to, ratio_num: num, ratio_den: den });
  if (enabled) await ok(w.full, 'PATCH', `${ADMIN}/catalog/conversion_rules/${r.id}`, { enabled: true });
  return r.id;
}

test('g4: GET /me/credits/conversions lists exactly the rules the conversion accepts — enabled, out of a class the customer holds', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const a1 = await tier(w, 'a1');
  const p1 = await tier(w, 'p1');
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }]);
  assert.deepEqual(await ok(w.a, 'GET', `${API}/me/credits/conversions`), [], 'nothing is allowed until the owner enables a rule');
  const allowed = await rule(w, cat.tier, a1, 2, 1, true);
  await rule(w, cat.tier, p1, 3, 4, false); // off: never offered
  await rule(w, a1, cat.tier, 1, 2, true); // out of a class the customer holds nothing in
  assert.deepEqual(await ok(w.a, 'GET', `${API}/me/credits/conversions`), [
    {
      rule_id: allowed,
      from_tier_id: cat.tier,
      to_tier_id: a1,
      ratio_num: 2,
      ratio_den: 1,
      from_code: 'x2d',
      from_name: { ar: 'ساعات X2D Combo', en: 'X2D Combo hours', ckb: 'کاتژمێرەکانی X2D Combo' },
      to_code: 'a1',
      to_name: { ar: 'ساعات a1', en: 'a1 hours', ckb: 'کاتژمێرەکانی a1' },
    },
  ]);
  assert.deepEqual(await ok(w.b, 'GET', `${API}/me/credits/conversions`), [], 'a customer with no hours is offered nothing');
  // Every listed pair converts; an unlisted one is refused.
  await ok(w.a, 'POST', `${API}/me/credits/convert`, { from_tier_id: cat.tier, to_tier_id: a1, seconds: H }, idem('cv'));
  await refused(w.a, 'POST', `${API}/me/credits/convert`, { from_tier_id: cat.tier, to_tier_id: p1, seconds: H }, 'CONVERSION_DISABLED', idem('cv'));
});

test('g4: the quote is the conversion’s own plan — what it says arrives does, from the lots it names, keeping their expiry; it writes nothing', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const a1 = await tier(w, 'a1');
  const expiring = (
    await ok(w.owner, 'POST', `${ADMIN}/catalog/packages`, {
      tier_id: cat.tier,
      code: 'x2d-2h-30d',
      name_en: '2 hours, 30 days',
      name_ar: 'ساعتان لثلاثين يومًا',
      name_ckb: 'دوو کاتژمێر بۆ سی ڕۆژ',
      seconds: 2 * H,
      price_iqd: 3000,
      expires_after_days: 30,
    })
  ).id;
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'credit_package', package_id: expiring }]);
  await rule(w, cat.tier, a1, 3, 2, true);
  const expLot = row<{ id: string; expires_at: string }>(w, 'SELECT id, expires_at FROM pc_credit_lots WHERE tier_id = ? AND expires_at IS NOT NULL', cat.tier) as { id: string; expires_at: string };
  const plainLot = row<{ id: string }>(w, 'SELECT id FROM pc_credit_lots WHERE tier_id = ? AND expires_at IS NULL', cat.tier) as { id: string };
  const body = { from_tier_id: cat.tier, to_tier_id: a1, seconds: 3 * H };

  const tables = ['pc_credit_ledger', 'pc_credit_lots', 'pc_credit_lot_draws', 'pc_credit_accounts', 'pc_operations'];
  const before = tables.map((t) => count(w, t));
  const quote = await ok(w.a, 'POST', `${API}/me/credits/convert/quote`, body);
  assert.deepEqual(tables.map((t) => count(w, t)), before, 'a quote writes nothing');
  // 3 h × 3/2 = 4 h 30 m; the expiring lot is spent first and its hours keep their date in the new class.
  assert.deepEqual(quote, {
    from_tier_id: cat.tier,
    to_tier_id: a1,
    converted_seconds: 3 * H,
    received_seconds: 4.5 * H,
    ratio_num: 3,
    ratio_den: 2,
    draws: [
      { lot_id: expLot.id, seconds: 2 * H, expires_at: expLot.expires_at },
      { lot_id: plainLot.id, seconds: H, expires_at: null },
    ],
    receives: [
      { seconds: 3 * H, expires_at: expLot.expires_at },
      { seconds: 1.5 * H, expires_at: null },
    ],
  });

  const done = await ok(w.a, 'POST', `${API}/me/credits/convert`, body, idem('cv'));
  assert.equal(done.received_seconds, quote.received_seconds, 'the conversion gave what the quote said');
  assert.deepEqual(
    rows(w, "SELECT lot_id, seconds FROM pc_credit_lot_draws WHERE ledger_entry_key LIKE 'conversion_out:%' ORDER BY rowid"),
    quote.draws.map((d: Json) => ({ lot_id: d.lot_id, seconds: d.seconds })),
    'from the lots the quote named, in its order'
  );
  assert.deepEqual(
    rows(w, 'SELECT seconds_total AS seconds, expires_at FROM pc_credit_lots WHERE tier_id = ? ORDER BY expires_at IS NULL, expires_at', a1),
    quote.receives,
    'into the lots the quote named, each keeping its expiry'
  );
  await reconcileClean(w);
});

test('g4: the quote refuses exactly what the conversion refuses', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  const a1 = await tier(w, 'a1');
  const tiny = await tier(w, 't1');
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h6 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  await rule(w, cat.tier, a1, 1, 1, true);
  await rule(w, cat.tier, tiny, 1, 1000, true);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ from_tier_id: cat.tier, to_tier_id: 'pctier_none', seconds: H }, 'CONVERSION_DISABLED'],
    [{ from_tier_id: a1, to_tier_id: cat.tier, seconds: H }, 'CONVERSION_DISABLED'],
    [{ from_tier_id: cat.tier, to_tier_id: a1, seconds: 59 }, 'VALIDATION'],
    [{ from_tier_id: cat.tier, to_tier_id: a1 }, 'VALIDATION'],
    [{ from_tier_id: cat.tier, to_tier_id: a1, seconds: 7 * H }, 'INSUFFICIENT_CREDIT'],
    [{ from_tier_id: cat.tier, to_tier_id: tiny, seconds: 60 }, 'QUANTITY_NOT_ALLOWED'],
  ];
  for (const [body, code] of cases) {
    const q = await call(w.a, 'POST', `${API}/me/credits/convert/quote`, body);
    const c = await call(w.a, 'POST', `${API}/me/credits/convert`, body, idem('cv'));
    assert.deepEqual([q.status, q.json.code], [c.status, c.json.code], `${JSON.stringify(body)}: the same refusal`);
    assert.equal(q.json.code, code, JSON.stringify(body));
  }
  // Held hours do not move, in the quote as in the conversion.
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: 5 * H, materials: [{ variant_id: cat.white, model_grams: 30 }] });
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/review`);
  await ok(w.a, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'));
  const body = { from_tier_id: cat.tier, to_tier_id: a1, seconds: 2 * H };
  await refused(w.a, 'POST', `${API}/me/credits/convert/quote`, body, 'INSUFFICIENT_CREDIT');
  await refused(w.a, 'POST', `${API}/me/credits/convert`, body, 'INSUFFICIENT_CREDIT', idem('cv'));
  assert.equal((await ok(w.a, 'POST', `${API}/me/credits/convert/quote`, { ...body, seconds: H })).received_seconds, H);
});

// ============================================================ g5 — the delivery fee before the request

test('g5: the quote states the fee POST /shipments charges, the rule that set it and where it would start — and writes nothing', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 500 }]);
  // The owner's own fee for Erbil; every other governorate pays the flat 5,000.
  await patchSettings(w, { delivery: { fee_by_governorate: { erbil: 7000 } } });
  const items = [{ variant_id: cat.white, qty: 100 }];
  const tables = ['pc_shipments', 'pc_shipment_items', 'pc_orders', 'pc_inventory_reservations', 'pc_operations', 'pc_inventory_ledger'];
  const before = tables.map((t) => count(w, t));

  const pickup = await ok(w.a, 'POST', `${API}/shipments/quote`, { kind: 'pickup', items });
  assert.deepEqual(pickup, {
    kind: 'pickup',
    fee_iqd: 0,
    fee_rule: 'pickup',
    governorate: null,
    status: 'preparing',
    payment_method: null,
    packaging: 'standard',
    jobs: [],
    items: [{ variant_id: cat.white, qty: 100, unit_code: 'g', available_qty: 500 }],
    available: { pickup: true, delivery: true },
  });
  const flat = await ok(w.a, 'POST', `${API}/shipments/quote`, { kind: 'delivery', items, payment_method: 'manual', delivery_address: ADDRESS });
  assert.deepEqual([flat.fee_iqd, flat.fee_rule, flat.governorate, flat.status, flat.payment_method], [5000, 'flat', 'baghdad', 'awaiting_payment', 'manual']);
  const own = await ok(w.a, 'POST', `${API}/shipments/quote`, { kind: 'delivery', items, payment_method: 'manual', delivery_address: ERBIL });
  assert.deepEqual([own.fee_iqd, own.fee_rule, own.governorate, own.status], [7000, 'governorate', 'erbil', 'awaiting_payment']);
  assert.deepEqual(tables.map((t) => count(w, t)), before, 'quotes write nothing, hold nothing, order nothing');

  // The request answers exactly what its quote said.
  const sent = await ok(w.a, 'POST', `${API}/shipments`, { kind: 'delivery', items, payment_method: 'manual', delivery_address: ERBIL }, idem('ship'));
  assert.deepEqual([sent.fee_iqd, sent.status], [own.fee_iqd, own.status]);
  assert.equal(row(w, 'SELECT total_iqd FROM pc_orders WHERE id = ?', sent.fee_order_id)?.total_iqd, own.fee_iqd);
  // A pickup sent from its quote starts where the quote said, with no fee order.
  const collected = await ok(w.a, 'POST', `${API}/shipments`, { kind: 'pickup', items }, idem('pick'));
  assert.deepEqual([collected.fee_iqd, collected.status, collected.fee_order_id], [pickup.fee_iqd, pickup.status, null]);
  await reconcileClean(w);
});

test('g5: the quote refuses exactly what the request refuses — one assessment for both doors', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h6 },
    { kind: 'material', variant_id: cat.white, quantity: 500 },
    { kind: 'material', variant_id: cat.magnets, quantity: 10 },
  ]);
  const done = await finishedPrint(w, cat);
  const { jobId: unfinished } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 20 }], title: 'Unfinished' });
  // Magnets stay at the workshop: the catalogue does not let them leave.
  await ok(w.owner, 'PATCH', `${ADMIN}/catalog/variants/${cat.magnets}`, { fulfillment_modes_json: ['inventory', 'project'] });
  const white = (qty: number) => [{ variant_id: cat.white, qty }];
  const compare = async (label: string, body: Record<string, unknown>, code: string) => {
    const q = await call(w.a, 'POST', `${API}/shipments/quote`, body);
    const r = await call(w.a, 'POST', `${API}/shipments`, body, idem('cmp'));
    assert.deepEqual([q.status, q.json.code], [r.status, r.json.code], `${label}: the quote and the request agree`);
    assert.equal(q.json.code, code, `${label}: ${JSON.stringify(q.json).slice(0, 300)}`);
  };
  await compare('more material than is free', { kind: 'pickup', items: white(471) }, 'INSUFFICIENT_INVENTORY');
  await compare('material that may not leave', { kind: 'pickup', items: [{ variant_id: cat.magnets, qty: 5 }] }, 'DELIVERY_NOT_AVAILABLE');
  await compare('an unfinished print', { kind: 'pickup', job_ids: [unfinished] }, 'INVALID_TRANSITION');
  await compare('someone else’s print', { kind: 'pickup', job_ids: ['pcj_nobody'] }, 'NOT_FOUND');
  await compare('an address the server refuses', { kind: 'delivery', items: white(100), delivery_address: { ...ADDRESS, phone: '07x' } }, 'VALIDATION');
  await compare('nothing to ship', { kind: 'pickup' }, 'VALIDATION');
  await patchSettings(w, { wallet_payment_enabled: false });
  await compare('a fee with a payment method switched off', { kind: 'delivery', items: white(100), payment_method: 'levonis_wallet', delivery_address: ADDRESS }, 'PAYMENT_ADAPTER_DISABLED');
  await patchSettings(w, { delivery: { pickup_enabled: false } });
  await compare('pickup switched off', { kind: 'pickup', job_ids: [done] }, 'DELIVERY_NOT_AVAILABLE');
  const off = await call(w.a, 'POST', `${API}/shipments/quote`, { kind: 'delivery', job_ids: [done], payment_method: 'manual', delivery_address: ADDRESS });
  assert.equal(off.status, 200);
  assert.deepEqual(off.json.data.available, { pickup: false, delivery: true }, 'the quote says which ways are offered');
  await patchSettings(w, { delivery: { enabled: false } });
  await compare('delivery switched off', { kind: 'delivery', job_ids: [done], payment_method: 'manual', delivery_address: ADDRESS }, 'DELIVERY_NOT_AVAILABLE');
  assert.equal(count(w, 'pc_shipments'), 0, 'not one refused request wrote a shipment');
  assert.equal((await owned(w.a, cat.white)).reserved_qty, 0);
});

// ============================================================ g6 — the workshop's defaults, stated

test('g6: every inventory row states the workshop’s default reminder (grams only) and top-up target — the values the scan and the top-up apply', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [
    { kind: 'credit_package', package_id: cat.packages.h24 },
    { kind: 'material', variant_id: cat.white, quantity: 250 },
    { kind: 'material', variant_id: cat.magnets, quantity: 10 },
  ]);
  const rowOf = async (variantId: string) => (await ok(w.a, 'GET', `${API}/me/inventory`)).find((r: Json) => r.variant_id === variantId);
  const white = await rowOf(cat.white);
  const magnets = await rowOf(cat.magnets);
  assert.equal(white.low_stock_alert_qty, null, 'the customer set none');
  assert.equal(white.low_stock_alert_default_qty, 100, 'the workshop’s default, in grams');
  assert.equal(magnets.low_stock_alert_default_qty, null, 'no gram figure is ever applied to pieces');
  assert.equal(white.top_up_default_target_qty, 1000);
  assert.equal(magnets.top_up_default_target_qty, 1000);
  // The dashboard's rows say the same.
  const dash = (await ok(w.a, 'GET', `${API}/me/dashboard`)).inventory.find((r: Json) => r.variant_id === cat.white);
  assert.deepEqual([dash.low_stock_alert_default_qty, dash.top_up_default_target_qty], [100, 1000]);
  // An empty target tops up to exactly the stated default.
  const topUp = await ok(w.a, 'POST', `${API}/me/inventory/top-up-quote`, { variant_id: cat.white });
  assert.deepEqual([topUp.target_qty, topUp.quantity], [white.top_up_default_target_qty, 750]);

  // The owner moves the default: the rows say so at once, and the scan reminds at it.
  await patchSettings(w, { low_inventory_default_g: 300 });
  assert.equal((await rowOf(cat.white)).low_stock_alert_default_qty, 300);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 30 }] });
  await runToPrinting(w, w.a, jobId);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: cat.white, qty: 30 }] });
  assert.equal((await owned(w.a, cat.white)).available_qty, 220, 'below the stated 300');
  await w.db.batch([enqueueTask(w.db, { kind: 'low_inventory_scan', dedupeKey: 'account-defaults-scan', now: new Date() })]);
  await w.runTasks();
  const reminded = rows<{ meta: string }>(w, "SELECT meta FROM user_notifications WHERE user_id = 'usr_pc_a' AND kind = 'print_cloud' AND json_extract(meta, '$.notice') = 'inventory_low'");
  assert.equal(reminded.length, 1, 'reminded at the default the row stated');
  // A customer's own amount wins, and the row still states the default it replaced.
  await ok(w.a, 'PATCH', `${API}/me/inventory/${cat.white}/alert`, { low_stock_alert_qty: 50 });
  const own = await rowOf(cat.white);
  assert.deepEqual([own.low_stock_alert_qty, own.low_stock_alert_default_qty], [50, 300]);
  // No other setting reaches the customer's rows.
  const keys = Object.keys(own).filter((k) => /default|config|setting|cost/.test(k)).sort();
  assert.deepEqual(keys, ['low_stock_alert_default_qty', 'top_up_default_target_qty']);
  await reconcileClean(w);
});
