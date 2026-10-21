/**
 * READERS AND OFFERS V3, SIXTH REVIEW (P1-05, docs/DECISIONS.md row 267) —
 * through the real routes and migrations.
 *
 * Pinned:
 *   rollback  the rollback script runs twice: before the older build goes
 *             live and again right after; the second run withdraws a partial
 *             offer the P1-05 build took in between. The runbook, the script
 *             header and row 267 say so.
 *   band      the job-value band applies to a complete estimate of a job of
 *             parts in several materials, as it does to one in one material.
 *   colours   a colour substitute named without a hex (as the composer sent
 *             it) is judged for stock: a workshop that tracks its colours
 *             and holds no such line is refused STOCK_COLOR, as it is for a
 *             hex it does not hold; a palette colour it holds is offered.
 *   list      «طلباتي» says an accepted order is partial or substituted.
 *   revision  a substitute on a one-job request with no revision row is
 *             still judged at acceptance (low).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, row, stubApp, type Mount } from './fixtures/app';
import { addFile, fund, newDraft, PLA, publish, readDraft, world } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { merchantWorkshopRoutes } from '../worker/routes/merchantWorkshop';
import { loadRequestFacts } from '../worker/lib/printMatchingStore';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/merchant/workshop', merchantWorkshopRoutes);
};
const as = (raw: DatabaseSync, id: string) => stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount);
const text = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const BLACK = { mode: 'catalogue', hex: '#1a1a1a', label: 'Black' };
const RED = { mode: 'catalogue', hex: '#d32f2f', label: 'Red' };
const TWO = {
  schema_version: 3,
  parts: [
    { name: 'Body', process: 'fdm', stated_dimensions_mm: { x: 40, y: 30, z: 10 }, materials: [{ material_id: 'pla', colors: [BLACK] }] },
    { name: 'Grip', process: 'fdm', stated_dimensions_mm: { x: 40, y: 30, z: 10 }, materials: [{ material_id: 'tpu', colors: [RED] }] },
  ],
};
const ONE = { schema_version: 3, parts: [TWO.parts[0]] };

// ============================================================== rollback

test('rollback: the script runs again right after the older build is live — a partial offer taken in between is withdrawn; the runbook, the script and row 267 say so', async () => {
  const sql = text('scripts/before-rollback-offers-v3.sql');
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET materials = '["pla","tpu"]' WHERE id = 'p1'`);
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, TWO)).status, 200);
  // The first run, before the redeploy: nothing open yet.
  raw.exec(sql);
  // Between the run and the cut-over the P1-05 build still answers: a partial offer is taken.
  const d = await readDraft(raw, id);
  const o = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
    price_iqd: 12_000, delivery_method: 'pickup', coverage: { parts: [d.model.parts[0].id] },
  });
  assert.equal(o.status, 201, JSON.stringify(await json(o.clone())));
  const offer = (await json(o)).offer;
  const state = () => row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offer.id)!.state;
  assert.equal(state(), 'pending');
  // The second run, once the older build is live, withdraws it and recounts.
  raw.exec(sql);
  assert.equal(state(), 'withdrawn');
  assert.equal(row<{ offer_count: number }>(raw, 'SELECT offer_count FROM community_requests WHERE id = ?', id)!.offer_count, 0);

  const header = sql.split('\n').filter((l) => l.startsWith('--')).map((l) => l.replace(/^--\s?/, '')).join(' ').replace(/\s+/g, ' ');
  assert.match(header, /RUN IT TWICE: once before the redeploy, and AGAIN right after the older build is live/, 'the script header says to run it twice');
  const runbook = text('docs/CLOUDFLARE_BUILDS_RUNBOOK.md').replace(/\s+/g, ' ');
  assert.match(runbook, /again right after the older build is live/i, 'the runbook says to run it twice');
  const row267 = text('docs/DECISIONS.md').split('\n').find((l) => l.startsWith('| 267 |'))!;
  assert.match(row267, /\(6أ\)[^(]*مرة ثانية فور/, 'row 267 says to run it twice');
});

// ================================================================== band

const cube = (mm: number): Uint8Array => {
  const v = (i: number, j: number, k: number) => [i * mm, j * mm, k * mm];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  const tris = [
    [p000, p110, p100], [p000, p010, p110], [p001, p101, p111], [p001, p111, p011],
    [p000, p100, p101], [p000, p101, p001], [p010, p011, p111], [p010, p111, p110],
    [p000, p001, p011], [p000, p011, p010], [p100, p110, p111], [p100, p111, p101],
  ].map((t) => t.flat());
  const out = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, tris.length, true);
  let at = 84;
  for (const t of tris) {
    at += 12;
    for (let i = 0; i < 9; i++) { dv.setFloat32(at, t[i], true); at += 4; }
    at += 2;
  }
  return out;
};
const { analyseModel } = await import('../worker/lib/modelGeometry');
const MEASURED = analyseModel(cube(30), 'c.stl') as unknown as Record<string, unknown>;

for (const [label, mats, measuredB, expect] of [
  ['PLA + TPU, every part priced', ['pla', 'tpu'], true, 'band'],
  ['PLA + PLA, every part priced', ['pla', 'pla'], true, 'band'],
  ['PLA + TPU, one part unpriced', ['pla', 'tpu'], false, 'open'],
] as const) {
  test(`band: a job of parts in ${label} — the job-value band ${expect === 'band' ? 'applies' : 'does not apply to a sum over some parts'}`, async () => {
    const raw = world();
    raw.exec(`UPDATE merchant_printers SET materials = '["pla","tpu"]' WHERE id = 'p1'`);
    raw.exec(`INSERT INTO merchant_request_prefs (merchant_id, max_job_iqd) VALUES ('m1', 1000)`);
    const id = await newDraft(raw);
    addFile(raw, id, 'fa', 'model', 'a.stl', { analysis: MEASURED });
    addFile(raw, id, 'fb', 'model', 'b.stl', { analysis: MEASURED });
    const pub = await publish(raw, id, {
      schema_version: 3,
      parts: [
        { name: 'A', process: 'fdm', measured_file_id: 'fa', materials: [{ material_id: mats[0] }] },
        measuredB
          ? { name: 'B', process: 'fdm', measured_file_id: 'fb', materials: [{ material_id: mats[1] }] }
          : { name: 'B', process: 'fdm', stated_dimensions_mm: { x: 20, y: 20, z: 20 }, materials: [{ material_id: mats[1] }] },
      ],
    });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const est = JSON.parse(row<{ estimate: string }>(raw, 'SELECT estimate FROM community_print_requests WHERE request_id = ?', id)!.estimate);
    assert.equal(est.priced, true);
    assert.equal(est.coverage.complete, measuredB);
    const facts = (await loadRequestFacts(asD1(raw), [id])).get(id)!;
    assert.ok(facts.parts && facts.parts.length === 2, 'read as a job of parts');
    const m = row<{ eligible: number; reasons: string }>(raw, 'SELECT eligible, reasons FROM community_request_matches WHERE request_id = ? AND merchant_id = ?', id, 'm1')!;
    const told = row<{ n: number }>(raw, `SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'matching_request' AND entity_id = ? AND user_id = 'owner'`, id)!.n;
    if (expect === 'band') {
      assert.equal(facts.estimate_iqd, est.price_iqd, 'the whole job priced: the band reads it');
      assert.equal(m.eligible, 0);
      assert.deepEqual(JSON.parse(m.reasons), ['PREF_JOB_TOO_LARGE']);
      assert.equal(told, 0, 'a workshop whose band the job is above is not told');
    } else {
      assert.equal(facts.estimate_iqd, null, 'a sum over some parts is not the job value');
      assert.equal(m.eligible, 1);
    }
  });
}

// ================================================================ colours

for (const [label, body] of [['a one-part job', ONE], ['a PLA + TPU job', TWO]] as const) {
  test(`colours: on ${label}, a colour substitute named without a hex is judged for stock — STOCK_COLOR where the workshop tracks its colours; a palette colour it holds is offered`, async () => {
    const raw = world();
    raw.exec(`UPDATE merchant_printers SET materials = '["pla","tpu"]' WHERE id = 'p1'`);
    raw.exec(`INSERT INTO merchant_material_stock (id,merchant_id,material_id,color_hex,grams) VALUES
                ('st1','m1','pla','#1a1a1a',1000), ('st2','m1','tpu','#d32f2f',1000), ('st3','m1','pla','#f2f2f2',1000)`);
    const id = await newDraft(raw);
    assert.equal((await publish(raw, id, body)).status, 200);
    const d = await readDraft(raw, id);
    const p = d.model.parts[0];
    const swap = async (colors: unknown[]) => {
      const res = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
        price_iqd: 30_000, delivery_method: 'pickup',
        substitutions: [{ part_id: p.id, material_row_id: p.materials[0].id, to: { colors } }],
      });
      return { status: res.status, body: await json(res) };
    };
    const named = await swap([{ label: 'Gold' }]);
    assert.equal(named.status, 403, JSON.stringify(named.body));
    assert.equal(named.body.code, 'OFFER_PART_NOT_ELIGIBLE');
    assert.deepEqual(named.body.details.reasons, ['STOCK_COLOR']);
    assert.equal(named.body.details.substitute, true, 'the part itself is made as asked');
    // The same colour by its hex is refused the same way.
    const hexed = await swap([{ hex: '#ffd700', label: 'Gold' }]);
    assert.deepEqual(hexed.body.details?.reasons, ['STOCK_COLOR']);
    // A palette colour on the shelf, as the composer now sends it.
    const white = await swap([{ hex: '#f2f2f2', label: 'White' }]);
    assert.equal(white.status, 201, JSON.stringify(white.body));
    assert.deepEqual(white.body.offer.substitutions[0].to.colors, [{ hex: '#f2f2f2', label: 'White' }]);
  });
}

test('colours: a colour named without a hex is in stock on a line whose colour is not tracked; a hexless colour the customer asked is not judged on a material-only substitute', async () => {
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET materials = '["pla","petg"]' WHERE id = 'p1'`);
  raw.exec(`INSERT INTO merchant_material_stock (id,merchant_id,material_id,color_hex,grams) VALUES ('st1','m1','pla','',1000), ('st2','m1','petg','#1a1a1a',1000)`);
  const id = await newDraft(raw);
  const custom = { mode: 'custom', hex: '', label: 'Navy' };
  assert.equal((await publish(raw, id, { schema_version: 3, parts: [{ ...ONE.parts[0], materials: [{ material_id: 'pla', colors: [custom] }] }] })).status, 200);
  const d = await readDraft(raw, id);
  const p = d.model.parts[0];
  const res = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
    price_iqd: 30_000, delivery_method: 'pickup',
    substitutions: [{ part_id: p.id, material_row_id: p.materials[0].id, to: { colors: [{ label: 'Gold' }] } }],
  });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  // A material-only substitute keeps the customer's own hexless colour, judged as the part as asked is.
  const raw2 = world();
  raw2.exec(`UPDATE merchant_printers SET materials = '["pla","petg"]' WHERE id = 'p1'`);
  raw2.exec(`INSERT INTO merchant_material_stock (id,merchant_id,material_id,color_hex,grams) VALUES ('st1','m1','pla','#1a1a1a',1000), ('st2','m1','petg','#1a1a1a',1000)`);
  const id2 = await newDraft(raw2);
  assert.equal((await publish(raw2, id2, { schema_version: 3, parts: [{ ...ONE.parts[0], materials: [{ material_id: 'pla', colors: [custom] }] }] })).status, 200);
  const d2 = await readDraft(raw2, id2);
  const p2 = d2.model.parts[0];
  const mat = await post(as(raw2, 'owner'), `/api/marketplace/requests/${id2}/offers`, {
    price_iqd: 30_000, delivery_method: 'pickup',
    substitutions: [{ part_id: p2.id, material_row_id: p2.materials[0].id, to: { material_id: 'petg' } }],
  });
  assert.equal(mat.status, 201, JSON.stringify(await json(mat.clone())));
});

// ================================================================== list

test('list: «طلباتي» says an accepted order is partial and substituted, from the order itself; a whole order adds nothing', async () => {
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET materials = '["pla","petg","tpu"]' WHERE id = 'p1'`);
  fund(raw, 'buyer', 2_000_000);
  const take = async (partial: boolean) => {
    const id = await newDraft(raw);
    assert.equal((await publish(raw, id, TWO)).status, 200);
    const d = await readDraft(raw, id);
    const a = d.model.parts[0];
    const o = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
      price_iqd: 12_000, delivery_method: 'pickup',
      ...(partial ? { coverage: { parts: [a.id] }, substitutions: [{ part_id: a.id, material_row_id: a.materials[0].id, to: { material_id: 'petg' } }] } : {}),
    });
    assert.equal(o.status, 201, JSON.stringify(await json(o.clone())));
    const offer = (await json(o)).offer;
    const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${offer.id}/accept`, {
      expected_total_iqd: offer.total_iqd, offer_revision: offer.revision,
      ...(partial ? { accept_partial: true, accept_substitutions: true } : {}),
    });
    assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
    return id;
  };
  const partial = await take(true);
  const whole = await take(false);
  const list = (await json(await get(as(raw, 'buyer'), '/api/marketplace/print/my-requests'))).requests as Array<Record<string, any>>;
  const p = list.find((r) => r.id === partial)!.accepted;
  assert.equal(p.covers_all, false);
  assert.equal(p.uncovered_count, 1);
  assert.equal(p.substitutes, true);
  assert.equal(p.offer_snapshot, undefined, 'the snapshots stay on the order page');
  const w = list.find((r) => r.id === whole)!.accepted;
  assert.deepEqual(Object.keys(w), ['offer_id', 'order_id', 'merchant_name', 'price_iqd', 'completion_days']);
});

// ============================================================== revision

test('revision (low): a substitute on a one-job request with no revision row is still judged at acceptance — refused, not funded in a material no printer runs', async () => {
  const raw = world();
  fund(raw, 'buyer', 1_000_000);
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, PLA)).status, 200);
  raw.exec(`DELETE FROM community_request_revisions WHERE request_id = '${id}'`);
  const res = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
    price_iqd: 30_000, delivery_method: 'pickup',
    substitutions: [{ part_id: `rpt_${id}_1`, material_row_id: `rpm_${id}_1_1`, to: { material_id: 'petg' } }],
  });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const offer = (await json(res)).offer;
  raw.exec(`UPDATE merchant_printers SET materials = '["pla"]' WHERE id = 'p1'`);
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${offer.id}/accept`, {
    expected_total_iqd: offer.total_iqd, offer_revision: offer.revision, accept_substitutions: true,
  });
  assert.equal(acc.status, 409, JSON.stringify(await json(acc.clone())));
  assert.equal((await json(acc)).code, 'OFFER_NOT_ELIGIBLE');
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_orders')!.n, 0, 'no order, no money held');
});
