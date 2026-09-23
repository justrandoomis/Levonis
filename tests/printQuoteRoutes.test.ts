/**
 * The quote engine end to end, against the real migrations and the real router.
 *
 * `freshDb()` applies every file in migrations/ to a real SQLite, so 0078's
 * CHECK constraints, its indexes and its seed all execute here — and the route
 * module mounted below is the same one worker/index.ts mounts. Nothing about
 * the code under test is mocked; only the session lookup is stubbed.
 *
 * What these prove, in the mandate's terms:
 *
 *   §22  a customer's payload physically cannot carry a cost line
 *   §23  a guest can upload, analyse and be quoted
 *   §34  a model is private, and a stranger gets 404 rather than a 403 oracle
 *   §2   a measurement that cannot be true is refused, never rounded into shape
 *   §25  an ineligible printer is returned WITH its reasons, not dropped
 *   §36  the fingerprint lookup answers before a browser spends a slice
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, post, row, stubApp, type App } from './fixtures/app';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import type { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';

const mount = (a: Hono<AppContext>) => a.route('/api/print-quote', printQuoteRoutes);

type Raw = ReturnType<typeof freshDb>;

function seedUser(raw: Raw, id: string, role = 'customer') {
  raw.prepare(
    `INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, 'x', ?)`
  ).run(id, `${id}@x.co`, id, role);
}

function seedMerchant(raw: Raw, merchantId: string, userId: string) {
  seedUser(raw, userId, 'merchant');
  raw.prepare(
    `INSERT INTO community_merchants (id, user_id, name, status) VALUES (?, ?, 'Shop', 'approved')`
  ).run(merchantId, userId);
  // `storeForUser` joins through merchant_stores — a merchant without a store
  // is not yet a shop that can price anything.
  raw.prepare(
    `INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name)
     VALUES (?, ?, ?, ?, 'Shop')`
  ).run(`st-${merchantId}`, merchantId, userId, `shop-${merchantId}`);
}

/** A real binary STL of a 20 mm cube — the classifier accepts it AND
 *  `analyseModel` can measure it, which the server-side measure route needs.
 *  Twelve triangles, wound outward, so the signed-volume sum is +8,000 mm³. */
function stlBytes(): Uint8Array {
  const S = 20;
  const v: Array<[number, number, number]> = [
    [0, 0, 0], [S, 0, 0], [S, S, 0], [0, S, 0],
    [0, 0, S], [S, 0, S], [S, S, S], [0, S, S],
  ];
  const tris: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    o += 12;
    for (const i of [a, b, c]) {
      dv.setFloat32(o, v[i][0], true);
      dv.setFloat32(o + 4, v[i][1], true);
      dv.setFloat32(o + 8, v[i][2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

async function upload(a: App, guestToken?: string) {
  const form = new FormData();
  form.append('file', new File([stlBytes()], 'bracket.stl', { type: 'application/octet-stream' }));
  if (guestToken) form.append('guest_token', guestToken);
  const res = await a.request('/api/print-quote/uploads', { method: 'POST', body: form });
  return { res, body: await json(res) };
}

const STATS = {
  filament_mm: 60_000,
  time_estimate: 14_400,
  layers: 200,
  model_layers: 200,
  raft_layers: 0,
};

const analyseBody = (over: Record<string, unknown> = {}) => ({
  printer_model_id: 'bbl-a1m',
  stats: STATS,
  tools: [{ slot: 0, material_id: 'pla', color_hex: '#000000' }],
  bounding_box_mm: { x: 100, y: 80, z: 40 },
  model_volume_mm3: 96_000,
  layer_height_mm: 0.2,
  preparation_minutes: 8,
  slicer_version: 'three-slicer@0.2.2',
  profile_revision: 'bbl-a1m-04-r1',
  ...over,
});

// ------------------------------------------------------------- the catalogue

test('the printer catalogue is public and carries no shop economics', async () => {
  const raw = freshDb();
  const a = stubApp(asD1(raw), null, mount);
  const body = await json(await a.request('/api/print-quote/printers'));

  assert.equal(body.success, true);
  // Seeded from studio/app/printer-profiles.ts, so the catalogue and the engine
  // cannot disagree about whether a part fits.
  const mini = body.printers.find((p: Record<string, unknown>) => p.id === 'bbl-a1m');
  assert.deepEqual(mini.build_mm, { x: 180, y: 180, z: 180 });
  const h2d = body.printers.find((p: Record<string, unknown>) => p.id === 'bbl-h2d');
  assert.deepEqual(h2d.build_mm, { x: 350, y: 320, z: 325 });
  assert.equal(h2d.toolhead_count, 2);
  assert.equal(h2d.multi_material, 'independent_toolheads');

  // §22: purchase price, maintenance and reliability are how a shop's costs are
  // computed and never reach an anonymous caller.
  const serialized = JSON.stringify(body);
  for (const leaked of ['purchase_iqd', 'maintenance_iqd_per_hour', 'baseline_success_rate', 'residual']) {
    assert.ok(!serialized.includes(leaked), `${leaked} must not reach a customer`);
  }

  // The waste characteristics ARE public — they are what lets a comparison
  // explain itself, and neither architecture claims to be free (§9).
  assert.ok(mini.purge_mm3_per_change > 0, 'a flushing machine wastes real grams');
  assert.equal(h2d.purge_mm3_per_change, 0, 'independent heads have nothing to flush');
  assert.ok(h2d.change_seconds > 0, 'and a change still costs time');
});

test('the material catalogue carries the densities the conversion needs', async () => {
  const raw = freshDb();
  const a = stubApp(asD1(raw), null, mount);
  const body = await json(await a.request('/api/print-quote/materials'));
  const pla = body.materials.find((m: Record<string, unknown>) => m.id === 'pla');
  assert.equal(pla.density_g_cm3, 1.24);
  assert.equal(pla.diameter_mm, 1.75);
  const abs = body.materials.find((m: Record<string, unknown>) => m.id === 'abs');
  assert.equal(abs.needs_enclosure, 1);
  // No invented prices in the seed (§53).
  assert.ok(!JSON.stringify(body).includes('default_iqd_per_kg'));
});

// ------------------------------------------------------------- guest upload

test('a guest can upload, and the model is stored private', async () => {
  const raw = freshDb();
  const put: Array<Record<string, unknown>> = [];
  const bucket = {
    put: async (key: string, _v: unknown, o: unknown) => {
      put.push({ key, o });
      return {};
    },
    get: async () => null,
    head: async () => null,
    delete: async () => undefined,
  };
  const a = stubApp(asD1(raw), null, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });

  const { res, body } = await upload(a, 'tok-guest-1');
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.ok(body.analysis_id);
  assert.equal(body.kind, 'model');
  assert.equal(body.extension, 'stl');
  // A guest's analysis expires (§35); a signed-in user's does not.
  assert.ok(body.expires_at);

  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM print_analyses WHERE id = ?', body.analysis_id)!;
  assert.equal(stored.owner_id, null);
  assert.ok(String(stored.guest_token_hash).length >= 64, 'the TOKEN is never stored, only its hash');
  // The canonical four-segment key, in the private domain — not a hand-built
  // path, and not anything `isAnonymousPublicMediaKey` would serve to the world.
  assert.match(String(stored.file_key), /^print-requests\/g[0-9a-f]+\/models\/[A-Za-z0-9_-]+\.stl$/);
  assert.equal(put.length, 1);
});

test('a guest without a token cannot upload, and a non-model is refused', async () => {
  const raw = freshDb();
  const a = stubApp(asD1(raw), null, mount);

  const noToken = new FormData();
  noToken.append('file', new File([stlBytes()], 'x.stl'));
  const r1 = await a.request('/api/print-quote/uploads', { method: 'POST', body: noToken });
  assert.equal(r1.status, 400);
  assert.equal((await json(r1)).code, 'GUEST_TOKEN_REQUIRED');

  const bad = new FormData();
  bad.append('file', new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], 'evil.exe'));
  bad.append('guest_token', 'tok');
  const r2 = await a.request('/api/print-quote/uploads', { method: 'POST', body: bad });
  assert.equal(r2.status, 400);
  assert.equal((await json(r2)).code, 'UNSUPPORTED_MODEL');
});

// --------------------------------------------------------------- the analysis

async function uploadedGuest(raw: Raw) {
  const bucket = { put: async () => ({}), get: async () => null, head: async () => null, delete: async () => undefined };
  const a = stubApp(asD1(raw), null, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });
  const { res, body } = await upload(a, 'tok-guest-1');
  if (!body.analysis_id) throw new Error(`upload failed ${res.status}: ${JSON.stringify(body)}`);
  return { a, id: body.analysis_id as string };
}

test('a customer gets a real number WITHOUT a slicer, and it never claims to be one', async () => {
  // THE customer path. The store bundle carries no slicer and never embeds
  // Studio (docs/STUDIO_PLAN.md decision 6), so this endpoint is what answers
  // «احسب سعر طباعتك»: the bytes are measured on the Worker and the extrusion
  // is modelled from them.
  const raw = freshDb();
  const bytes = stlBytes();
  const bucket = {
    put: async () => ({}),
    get: async () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }),
    head: async () => null,
    delete: async () => undefined,
  };
  const a = stubApp(asD1(raw), null, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });
  const up = (await upload(a, 'tok-guest-1')).body;
  const id = up.analysis_id as string;
  const h = { 'X-Guest-Token': 'tok-guest-1' };

  const measured = await json(
    await post(a, `/api/print-quote/analyses/${id}/measure`, { printer_model_id: 'bbl-a1m', material_id: 'pla' }, h)
  );
  assert.equal(measured.success, true, JSON.stringify(measured));

  // The geometry half is EXACT and comes back separately, so the UI can show
  // what is a fact about the file apart from the model's reading of it.
  assert.ok(Math.abs(measured.geometry.volume_mm3 - 8_000) < 1);
  assert.equal(measured.geometry.triangle_count, 12);

  // ~3.6 g of PLA for a 20 mm cube at 15% infill — and not a gram of support,
  // because the only downward face is the one on the build plate.
  const grams = measured.analysis.materials[0].grams;
  assert.ok(grams > 3.4 && grams < 3.9, `${grams} g`);

  // THE line this route must not cross. `platform`, never `measured`.
  assert.equal(measured.analysis.provenance, 'platform');
  assert.match(measured.analysis.engine ?? '', /levonis-geometry/);

  // It is persisted as a complete analysis, so the quote route can price it.
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM print_analyses WHERE id = ?', id)!;
  assert.equal(stored.state, 'complete');
  assert.equal(stored.provenance, 'platform');

  // And pricing it produces an ESTIMATE with a range, never a single figure —
  // the seed carries no filament price, so the honest answer is that the
  // catalogue cannot price the material yet.
  const quoted = await json(await post(a, `/api/print-quote/analyses/${id}/quote`, {}, h));
  assert.equal(quoted.success, true, JSON.stringify(quoted));
  assert.equal(quoted.quote.confidence, 'insufficient');
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();

  const priced = await json(await post(a, `/api/print-quote/analyses/${id}/quote`, {}, h));
  assert.equal(priced.quote.confidence, 'estimated', JSON.stringify(priced.quote));
  assert.ok(priced.quote.range_iqd.high > priced.quote.range_iqd.low, 'an estimate must be shown as a range');
  // §22: not one cost, margin or component reaches the customer.
  const text = JSON.stringify(priced.quote);
  for (const leak of ['cost', 'margin', 'profit', 'lines', 'break_even', 'depreciation']) {
    assert.ok(!text.toLowerCase().includes(leak), `the customer payload carries '${leak}'`);
  }
});

/**
 * THE OWNER'S BUG, IN THE ONE SHAPE THAT CATCHES IT.
 *
 * «CHOOSING A DIFFERENT PRINTER DOES NOT CHANGE THE PRICE». It did not, and no
 * test noticed, because the engine's own unit tests hand `priceJob` a printer
 * carrying invented economics (350,000 IQD, 6,000 useful hours, 95 W) and those
 * DO move a price. The live catalogue carries none: migration 0078 leaves
 * `purchase_iqd`, `useful_print_hours`, `maintenance_iqd_per_hour` and all four
 * wattages NULL on every seeded machine, on purpose, and no route or admin
 * screen has ever written one.
 *
 * The printer reaches a price ONLY through time, and all three lines that turn
 * hours into money were multiplying them by zero. So the A1 mini and the H2D
 * quoted a single 20 mm cube to the same dinar while the screen showed two
 * different print times beside the identical figure.
 *
 * This runs the REAL migrations and the REAL router, so it fails the moment the
 * machine-hour rate stops reaching the quote — which is exactly how it got here
 * in the first place.
 *
 * WHAT IT ASSERTS, AND WHY NOT "THE FASTER MACHINE IS CHEAPER". It is not, on
 * this fixture, and the reason is a real one worth pinning rather than dodging:
 * the H2D lays down the cube faster (5.3 min against 6.5) and is ENCLOSED, so
 * 0078 gives it a six-minute warm-up against the A1 mini's four — and on a
 * five-minute print the warm-up is most of the job. So the flagship honestly
 * costs MORE here and would honestly cost less on anything large. The invariant
 * that holds either way, and the one a rate reaching the quote actually
 * guarantees, is that the machine with more hours on it costs more. A rate that
 * arrived without the hours attached would move both prices by the same amount
 * and still pass a bare `notEqual`, so that is what is asserted.
 */
test('two printers, one file, two prices — the machine hour is not free', async () => {
  const raw = freshDb();
  const bytes = stlBytes();
  const bucket = {
    put: async () => ({}),
    get: async () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }),
    head: async () => null,
    delete: async () => undefined,
  };
  const a = stubApp(asD1(raw), null, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();

  // The seed's own physics, and the ONLY thing separating these two rows that
  // a customer's quote can see: 28 mm³/s against 32, and 2.0 s of travel per
  // layer against 1.5. Both run PLA, both take the cube. Nothing else differs
  // that the file path reads.
  const quoteOn = async (printerModelId: string) => {
    const up = (await upload(a, `tok-${printerModelId}`)).body;
    const id = up.analysis_id as string;
    const h = { 'X-Guest-Token': `tok-${printerModelId}` };
    const measured = await json(
      await post(a, `/api/print-quote/analyses/${id}/measure`, { printer_model_id: printerModelId, material_id: 'pla' }, h)
    );
    assert.equal(measured.success, true, JSON.stringify(measured));
    const priced = await json(await post(a, `/api/print-quote/analyses/${id}/quote`, {}, h));
    assert.equal(priced.quote.confidence, 'estimated', JSON.stringify(priced.quote));
    return { quote: priced.quote, analysis: measured.analysis, quoteId: priced.quote_id as string };
  };

  const slow = await quoteOn('bbl-a1m');
  const fast = await quoteOn('bbl-h2d');

  // The premise: the engine really does think these are different jobs in time.
  // If this ever stops being true the price assertion below means nothing.
  assert.ok(
    slow.analysis.print_minutes_per_plate > fast.analysis.print_minutes_per_plate,
    `the A1 mini must be the slower machine (${slow.analysis.print_minutes_per_plate} vs ${fast.analysis.print_minutes_per_plate})`
  );
  // THE SYMPTOM ITSELF: two machines, one file, two prices. Before the rate
  // reached the quote these were equal to the dinar.
  assert.notEqual(
    fast.quote.price_iqd,
    slow.quote.price_iqd,
    `both printers quoted ${slow.quote.price_iqd} — the printer is not reaching the price`
  );

  // And the difference is the HOURS, in the only direction an hourly rate can
  // push them. The enclosed machine spends longer warming up than it saves
  // printing a 20 mm cube, so on this fixture it is the dearer one — which is
  // the honest answer, not a bug.
  assert.ok(fast.quote.machine_hours > slow.quote.machine_hours, 'premise: the H2D spends longer on this cube');
  assert.ok(
    fast.quote.price_iqd > slow.quote.price_iqd,
    `more hours must cost more: ${fast.quote.price_iqd} at ${fast.quote.machine_hours} h against ${slow.quote.price_iqd} at ${slow.quote.machine_hours} h`
  );

  // §30: the rate decided the difference, so the stored quote has to remember
  // what it was — otherwise neither price is explainable next month.
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM print_quotes WHERE id = ?', slow.quoteId)!;
  const snapshot = JSON.parse(String(stored.snapshot)) as Record<string, unknown>;
  const rate = snapshot.machine_iqd_per_hour as { value: number; from: string };
  assert.ok(rate.value > 0, 'a quote that charged for machine time must record the rate it charged');
  // And it is the PLATFORM's figure, not this shop's — no panel may show it as
  // a merchant's own number, because the merchant never entered one.
  assert.equal(rate.from, 'platform');

  // §22 still holds: the new line is a cost, and a customer sees no costs.
  assert.ok(!JSON.stringify(slow.quote).toLowerCase().includes('machine_iqd'));
});

test('a model that cannot fit the machine is refused before it is priced', async () => {
  const raw = freshDb();
  const bytes = stlBytes();
  const bucket = {
    put: async () => ({}),
    get: async () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }),
    head: async () => null,
    delete: async () => undefined,
  };
  const a = stubApp(asD1(raw), null, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });
  const id = (await upload(a, 'tok-guest-1')).body.analysis_id as string;
  const h = { 'X-Guest-Token': 'tok-guest-1' };

  // A 20 mm cube fits everything, so shrink the machine instead of inventing a
  // second fixture: the refusal is about the comparison, not about the file.
  raw.prepare(`UPDATE printer_models SET build_x_mm = 10, build_y_mm = 10, build_z_mm = 10 WHERE id = 'bbl-a1m'`).run();
  const res = await post(a, `/api/print-quote/analyses/${id}/measure`, { printer_model_id: 'bbl-a1m', material_id: 'pla' }, h);
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'DOES_NOT_FIT');
  assert.equal(row<Record<string, unknown>>(raw, 'SELECT state FROM print_analyses WHERE id = ?', id)!.state, 'failed');
});

test('a material with no density is refused rather than weighed as PLA', async () => {
  const raw = freshDb();
  const bytes = stlBytes();
  const bucket = {
    put: async () => ({}),
    get: async () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }),
    head: async () => null,
    delete: async () => undefined,
  };
  const a = stubApp(asD1(raw), null, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });
  const id = (await upload(a, 'tok-guest-1')).body.analysis_id as string;

  raw.prepare(
    `INSERT INTO print_materials (id, material_type, name, density_g_cm3) VALUES ('mystery','???','Mystery', 0)`
  ).run();
  const res = await post(
    a,
    `/api/print-quote/analyses/${id}/measure`,
    { printer_model_id: 'bbl-a1m', material_id: 'mystery' },
    { 'X-Guest-Token': 'tok-guest-1' }
  );
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'MATERIAL_NOT_WEIGHABLE');
});

test('a slicer measurement is stored with its grams attributed, and quoted without costs', async () => {
  const raw = freshDb();
  const { a, id } = await uploadedGuest(raw);
  const h = { 'X-Guest-Token': 'tok-guest-1' };

  const analysed = await json(await post(a, `/api/print-quote/analyses/${id}`, analyseBody(), h));
  assert.equal(analysed.success, true, JSON.stringify(analysed));
  // 60 m of 1.75 mm PLA at 1.24 g/cm³ is ~178.9 g — the engine's own geometry,
  // not a number anybody typed.
  const grams = analysed.analysis.materials[0].modelGrams;
  assert.ok(Math.abs(grams - 178.9) < 0.5, `expected ~178.9 g, got ${grams}`);
  assert.equal(analysed.analysis.print_minutes_per_plate, 240);
  // The buckets this engine cannot separate are NAMED, so a support line of
  // zero is never read as "needs no support".
  assert.ok(analysed.analysis.unmeasured.includes('SUPPORT_MATERIAL'));

  // NOTHING PRICES A GRAM YET, and the engine says so rather than pretending.
  // 0078 seeds densities but deliberately no filament prices (§53), which is
  // the same root cause as the owner's empty calculator: the data is missing,
  // not the code. `insufficient` is the honest answer to that.
  const unpriced = await json(await post(a, `/api/print-quote/analyses/${id}/quote`, {}, h));
  assert.equal(unpriced.quote.confidence, 'insufficient');

  // Give the platform a fallback price and the same job prices properly.
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 18000 WHERE id = 'pla'`).run();
  const quoted = await json(await post(a, `/api/print-quote/analyses/${id}/quote`, {}, h));
  assert.equal(quoted.success, true, JSON.stringify(quoted));
  assert.ok(quoted.quote.price_iqd > 0);
  // A platform default is not a measurement, so the quote is a RANGE (§50).
  assert.equal(quoted.quote.confidence, 'estimated');
  assert.ok(quoted.quote.range_iqd.high > quoted.quote.range_iqd.low);

  // §22 — THE CUSTOMER PAYLOAD CANNOT CARRY A COST. Not "should not": the shape
  // has no field for one, so no future edit can leak it by forgetting a check.
  for (const key of ['lines', 'true_cost_iqd', 'profit_iqd', 'margin_percent', 'base_cost_iqd', 'failure_reserve_iqd']) {
    assert.ok(!(key in quoted.quote), `${key} must not reach a customer`);
  }

  // The quote and its components really landed, and the snapshot with them.
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM print_quotes WHERE id = ?', quoted.quote_id)!;
  assert.ok(Number(stored.true_cost_iqd) > 0);
  assert.ok(String(stored.snapshot).length > 100, 'a quote without its inputs is not reproducible');
  const components = raw
    .prepare('SELECT component FROM print_quote_cost_components WHERE quote_id = ?')
    .all(quoted.quote_id) as Array<{ component: string }>;
  assert.ok(components.some((x) => x.component === 'MODEL_MATERIAL'));
  assert.ok(components.some((x) => x.component === 'FAILURE_RESERVE'));
});

test('a measurement that cannot describe a real print is refused, not reshaped', async () => {
  const raw = freshDb();
  const { a, id } = await uploadedGuest(raw);
  const h = { 'X-Guest-Token': 'tok-guest-1' };

  // Economy mode reports no time. A job with no machine hours is a material
  // bill, not a quote.
  const noTime = await a.request(`/api/print-quote/analyses/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...h },
    body: JSON.stringify(analyseBody({ stats: { ...STATS, time_estimate: 0 } })),
  });
  assert.equal(noTime.status, 400);
  assert.equal((await json(noTime)).code, 'NO_TIME_ESTIMATE');

  // The row is marked failed rather than left quotable.
  assert.equal(row<Record<string, unknown>>(raw, 'SELECT state FROM print_analyses WHERE id = ?', id)!.state, 'failed');
});

test('a part that does not fit the machine it claims to be sliced on is refused', async () => {
  const raw = freshDb();
  const { a, id } = await uploadedGuest(raw);
  const h = { 'X-Guest-Token': 'tok-guest-1' };

  // 300 mm on a 180 mm bed. A payload can lie about grams; it cannot make this
  // fit, and quoting it would price a job nobody can print.
  const res = await a.request(`/api/print-quote/analyses/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...h },
    body: JSON.stringify(analyseBody({ bounding_box_mm: { x: 300, y: 80, z: 40 } })),
  });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'PRINTER_INELIGIBLE');
  assert.deepEqual(body.details.reasons, ['build_volume']);
});

test('a material the catalogue cannot weigh is refused rather than defaulted to PLA', async () => {
  const raw = freshDb();
  const { a, id } = await uploadedGuest(raw);
  const res = await a.request(`/api/print-quote/analyses/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Guest-Token': 'tok-guest-1' },
    body: JSON.stringify(analyseBody({ tools: [{ slot: 0, material_id: 'unobtainium' }] })),
  });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'UNKNOWN_MATERIAL');
});

// ------------------------------------------------------------------- privacy

test('a stranger gets not-found, never a 403 that confirms the analysis exists', async () => {
  const raw = freshDb();
  const { a: guestApp, id } = await uploadedGuest(raw);
  await post(guestApp, `/api/print-quote/analyses/${id}`, analyseBody(), { 'X-Guest-Token': 'tok-guest-1' });

  // No token at all.
  assert.equal((await guestApp.request(`/api/print-quote/analyses/${id}`)).status, 404);
  // The WRONG token.
  assert.equal(
    (await guestApp.request(`/api/print-quote/analyses/${id}`, { headers: { 'X-Guest-Token': 'tok-someone-else' } })).status,
    404
  );

  // A different signed-in user is equally a stranger.
  seedUser(raw, 'u-other');
  const other = stubApp(asD1(raw), { id: 'u-other', role: 'customer', email: 'other@levonis.test' }, mount);
  assert.equal((await other.request(`/api/print-quote/analyses/${id}`)).status, 404);

  // The right token works.
  assert.equal(
    (await guestApp.request(`/api/print-quote/analyses/${id}`, { headers: { 'X-Guest-Token': 'tok-guest-1' } })).status,
    200
  );
});

// --------------------------------------------------------------- the cache

test('the lookup answers before a browser spends a slice, and only on a real match', async () => {
  const raw = freshDb();
  const { a, id } = await uploadedGuest(raw);
  const h = { 'X-Guest-Token': 'tok-guest-1' };
  const settings = {
    printer_model_id: 'bbl-a1m',
    profile_revision: 'bbl-a1m-04-r1',
    slicer_version: 'three-slicer@0.2.2',
    quality_id: 'standard',
    strength_id: 'standard',
    nozzle_mm: 0.4,
    supports: true,
    material_ids: ['pla'],
    orientation_key: 'as-sliced',
  };

  // Nothing measured yet.
  assert.equal((await json(await post(a, `/api/print-quote/analyses/${id}/lookup`, settings, h))).hit, false);

  await post(a, `/api/print-quote/analyses/${id}`, analyseBody(), h);

  const hit = await json(await post(a, `/api/print-quote/analyses/${id}/lookup`, settings, h));
  assert.equal(hit.hit, true);
  assert.ok(hit.analysis.materials[0].modelGrams > 0);

  // A different layer height is a DIFFERENT JOB, and the file hash alone would
  // have wrongly matched it.
  const miss = await json(
    await post(a, `/api/print-quote/analyses/${id}/lookup`, { ...settings, quality_id: 'fine' }, h)
  );
  assert.equal(miss.hit, false);
});

// ------------------------------------------------------------ merchant view

test('a merchant sees their own economics, and every printer with its reasons', async () => {
  const raw = freshDb();
  seedMerchant(raw, 'm-1', 'u-merchant');
  const bucket = { put: async () => ({}), get: async () => null, head: async () => null, delete: async () => undefined };
  const merchantUp = stubApp(asD1(raw), { id: 'u-merchant', role: 'merchant', email: 'merchant@levonis.test' }, mount, {
    env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket },
  });
  // The merchant's OWN analysis. A merchant cannot open a stranger's private
  // model — `readableAnalysis` answers 404 — and the door that will let them
  // price a customer's job is the print request, which grants the read the way
  // marketplace.ts already does for an open request. That linkage is phase 6.
  const { body: up } = await upload(merchantUp);
  const id = up.analysis_id as string;
  await post(merchantUp, `/api/print-quote/analyses/${id}`, analyseBody());

  raw.prepare(
    `INSERT INTO merchant_printers (id, merchant_id, name, technology, brand, model,
       build_x_mm, build_y_mm, build_z_mm, nozzle_mm, materials, model_id,
       purchase_iqd, residual_iqd, useful_print_hours, maintenance_iqd_per_hour,
       electricity_iqd_per_kwh, labor_iqd_per_hour)
     VALUES ('mp-mini','m-1','My A1 mini','fdm','Bambu','A1 mini',180,180,180,0.4,'["PLA"]','bbl-a1m',
             350000, 70000, 6000, 18, 150, 8000)`
  ).run();
  // A machine that cannot take the job at all.
  raw.prepare(
    `INSERT INTO merchant_printers (id, merchant_id, name, technology, brand, model,
       build_x_mm, build_y_mm, build_z_mm, nozzle_mm, materials, model_id)
     VALUES ('mp-resin','m-1','Resin','resin','X','Y',80,80,150,0.05,'["RESIN"]',NULL)`
  ).run();
  // The merchant's own spool, bought below the catalogue.
  raw.prepare(
    `INSERT INTO merchant_spools (id, merchant_id, material_id, purchase_iqd, original_grams)
     VALUES ('sp-1','m-1','pla', 14000, 1000)`
  ).run();

  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  const merchantApp = stubApp(asD1(raw), { id: 'u-merchant', role: 'merchant', email: 'merchant@levonis.test' }, mount);
  const compared = await json(await post(merchantApp, `/api/print-quote/analyses/${id}/compare`, {}));
  assert.equal(compared.success, true, JSON.stringify(compared));
  assert.equal(compared.printers.length, 2);

  const mini = compared.printers.find((p: Record<string, unknown>) => p.merchant_printer_id === 'mp-mini');
  assert.equal(mini.eligible, true);
  // §40 — the full economics panel.
  assert.ok(mini.true_cost_iqd > 0);
  assert.ok(mini.profit_iqd !== undefined);
  assert.ok(Array.isArray(mini.lines) && mini.lines.length > 0);
  assert.ok(mini.lines.some((l: Record<string, unknown>) => l.component === 'DEPRECIATION'));
  // §7 — their spool, not the catalogue, and the line SAYS so.
  const material = mini.lines.find((l: Record<string, unknown>) => l.component === 'MODEL_MATERIAL');
  assert.equal(material.from, 'merchant');
  assert.match(material.detail, /14,000\/kg/);
  // §25 — the reasons, not a hidden score.
  assert.ok(mini.because.machine_hours > 0);
  assert.ok(mini.because.machine_iqd_per_hour > 0);

  // §28 — an ineligible machine is returned WITH its reasons, not dropped.
  const resin = compared.printers.find((p: Record<string, unknown>) => p.merchant_printer_id === 'mp-resin');
  assert.equal(resin.eligible, false);
  assert.ok(resin.reasons.includes('build_volume'));
  assert.ok(resin.reasons.some((r: string) => r.startsWith('material:')));
  assert.equal(resin.unlinked, true, 'a legacy row with no canonical model says so');
});

test('only a merchant may compare printers', async () => {
  const raw = freshDb();
  const { id } = await uploadedGuest(raw);
  seedUser(raw, 'u-plain');
  const a = stubApp(asD1(raw), { id: 'u-plain', role: 'customer', email: 'plain@levonis.test' }, mount);
  const res = await post(a, `/api/print-quote/analyses/${id}/compare`, {});
  // Not their analysis, so it is not found — the ownership check runs first and
  // does not confirm the id exists.
  assert.equal(res.status, 404);
});
