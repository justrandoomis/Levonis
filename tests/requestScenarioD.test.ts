/**
 * SCENARIO D, STEPS 2 AND 3 (Community V3 traceability 30.D2, 30.D3; plan
 * P1-05; docs/DECISIONS.md row 267, D8/D9) — through the real routes and
 * migrations.
 *
 *   30.D2  A request of two parts — an STL measured in PLA, and a part in PLA
 *          and TPU from pictures, a link and a description — is published
 *          and needs a technical review. The customer sees it on the request
 *          page and in «طلباتي», a merchant on the board card, the workshop
 *          board and the eligibility answer, an admin in the review queue. A
 *          reviewer's confirmation clears it without moving the revision or
 *          superseding an offer; a customer edit between the reviewer's read
 *          and the decision refuses the decision (REQUEST_CHANGED); and a
 *          customer save that read before the decision cannot undo it.
 *   30.D3  Three workshops answer: a complete offer, a partial one and a
 *          complete one with a substitution — and the customer's offer list
 *          carries what each covers and substitutes.
 *
 * A v1 request in several colours shows no review anywhere and is not queued
 * (critique 6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { analyseModel } from '../worker/lib/modelGeometry';
import { approveMerchants, asD1, get, json, post, stubApp, type Mount } from './fixtures/app';
import { addFile, newDraft, publish, readDraft, world } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { merchantWorkshopRoutes } from '../worker/routes/merchantWorkshop';
import { communityRoutes } from '../worker/routes/community';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { modelWriteStatements, readRequestModel, reviewFenceStatement, stateOf } from '../worker/lib/requestModel';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/merchant/workshop', merchantWorkshopRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
};
const as = (raw: DatabaseSync, id: string, role: 'customer' | 'admin' = 'customer') =>
  stubApp(asD1(raw), { id, role, email: `${id}@x.co` }, mount);

function stl(mm: number): Uint8Array {
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
}

/** The third workshop: an FDM machine with four colours at once, PLA and PETG only. */
function thirdWorkshop(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('owner3','Huda','h@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
      VALUES ('mem3','owner3','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name,phone) VALUES ('m3','owner3','Huda Prints','');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,contact_phone) VALUES ('s3','m3','owner3','hudaprints','Huda Prints','');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max,multicolor)
      VALUES ('p4','m3','s3','AMS','fdm',256,256,256,'["pla","petg"]','ultra',1);
  `);
  approveMerchants(raw);
}

const LINK = 'https://www.printables.com/model/4242-cable-clip';

async function scenarioD(raw: DatabaseSync) {
  const id = await newDraft(raw, { title: 'A clip and its soft grip', description: 'A cable clip with a soft grip, please' });
  addFile(raw, id, 'crf_stl', 'model', 'clip.stl', { analysis: analyseModel(stl(30), 'clip.stl') as unknown as Record<string, unknown> });
  addFile(raw, id, 'crf_pic', 'reference', 'grip.png');
  const res = await publish(raw, id, {
    schema_version: 3,
    sources: [
      { kind: 'file', file_id: 'crf_stl', is_primary: true },
      { kind: 'file', file_id: 'crf_pic', note: 'the grip, like this' },
      { id: 'tmp_link', kind: 'link', url: LINK },
      { id: 'tmp_text', kind: 'text_ref', ref_text: 'Soft where the thumb goes, hard where it clips' },
    ],
    parts: [
      { name: 'Clip', process: 'fdm', measured_file_id: 'crf_stl', source_ids: ['rps_crf_stl'], materials: [{ material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#1a1a1a' }] }] },
      {
        name: 'Grip', process: 'fdm', stated_dimensions_mm: { x: 40, y: 15, z: 10 }, source_ids: ['rps_crf_pic', 'tmp_link', 'tmp_text'],
        materials: [{ material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#1a1a1a' }] }, { material_id: 'tpu', colors: [{ mode: 'catalogue', hex: '#d32f2f' }] }],
      },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return id;
}

test('30.D2: the request needs a technical review — and every reader shows it', async () => {
  const raw = world();
  const id = await scenarioD(raw);
  // The customer's request page.
  const page = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}`));
  assert.equal(page.summary.review_state, 'needs_technical_review');
  assert.deepEqual(page.summary.review_reasons, ['multi_material']);
  assert.deepEqual(page.model.parts.map((p: Record<string, unknown>) => [p.name, p.review_state, p.review_reasons]), [
    ['Clip', '', []],
    ['Grip', 'needs_technical_review', ['multi_material']],
  ]);
  assert.equal(page.estimate === undefined, true, 'the estimate rides on `print`');
  assert.equal(page.print.estimate.coverage.parts_total, 2);
  // «طلباتي».
  const mine = await json(await get(as(raw, 'buyer'), '/api/marketplace/print/my-requests'));
  assert.deepEqual(mine.requests.find((r: Record<string, unknown>) => r.id === id).summary.review_state, 'needs_technical_review');
  // The board card, for a merchant.
  const board = await json(await get(as(raw, 'owner'), '/api/marketplace/requests'));
  const card = board.requests.find((r: Record<string, unknown>) => r.id === id);
  assert.deepEqual(card.summary, { parts_count: 2, pieces_per_set: 2, review_state: 'needs_technical_review' });
  // The workshop's own board and its eligibility answer: Ali's single-colour
  // machine makes the clip, not the two-material grip.
  const ws = await json(await get(as(raw, 'owner'), '/api/merchant/workshop/board'));
  const mine2 = ws.requests.find((r: Record<string, unknown>) => r.id === id);
  assert.ok(mine2, JSON.stringify(ws));
  assert.equal(mine2.summary.review_state, 'needs_technical_review');
  assert.equal(mine2.estimate_complete, false, 'the grip has nothing measured to price');
  const el = await json(await get(as(raw, 'owner'), `/api/merchant/workshop/requests/${id}/eligibility`));
  assert.equal(el.eligible, true);
  assert.equal(el.covers_all, false);
  assert.deepEqual(el.parts.map((p: Record<string, unknown>) => [p.eligible, p.reasons]), [[true, []], [false, ['MULTICOLOR']]]);
  // The admin queue.
  const queue = await json(await get(as(raw, 'admin1', 'admin'), '/api/admin/community/requests?review=needs_technical_review'));
  const q = queue.requests.find((r: Record<string, unknown>) => r.id === id);
  assert.ok(q, JSON.stringify(queue));
  assert.equal(q.parts_count, 2);
  assert.deepEqual(q.review_reasons, ['multi_material']);
});

test('30.D2: a reviewer confirms — the summary clears, the revision and the pending offer stay; a customer edit in between refuses it', async () => {
  const raw = world();
  const id = await scenarioD(raw);
  const pending = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 15_000, delivery_method: 'pickup', coverage: { parts: [(await readDraft(raw, id)).model.parts[0].id] } });
  assert.equal(pending.status, 201, JSON.stringify(await json(pending.clone())));
  const offerId = (await json(pending)).offer.id;
  const rev = raw.prepare('SELECT revision FROM community_requests WHERE id = ?').get(id) as { revision: number };

  // A customer edit between the reviewer's read and the decision.
  const read1 = await json(await get(as(raw, 'admin1', 'admin'), `/api/admin/community/requests/${id}`));
  assert.equal(read1.review.state, 'needs_technical_review');
  const d = await readDraft(raw, id);
  const edited = { schema_version: 3, parts: [d.model.parts[0], { ...d.model.parts[1], notes: 'the grip a little softer' }] };
  assert.equal((await publish(raw, id, edited)).status, 200);
  const late = await post(as(raw, 'admin1', 'admin'), `/api/admin/community/requests/${id}/review`, { decision: 'confirmed', parts: read1.review.parts.map((p: Record<string, unknown>) => ({ id: p.id, updated_at: p.updated_at })) });
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'REQUEST_CHANGED');

  // Read again, decide.
  const read2 = await json(await get(as(raw, 'admin1', 'admin'), `/api/admin/community/requests/${id}`));
  const revBefore = (raw.prepare('SELECT revision FROM community_requests WHERE id = ?').get(id) as { revision: number }).revision;
  const ok = await post(as(raw, 'admin1', 'admin'), `/api/admin/community/requests/${id}/review`, { decision: 'confirmed', parts: read2.review.parts.map((p: Record<string, unknown>) => ({ id: p.id, updated_at: p.updated_at })) });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  assert.equal((await json(ok)).review_state, 'confirmed');
  assert.equal((raw.prepare('SELECT revision FROM community_requests WHERE id = ?').get(id) as { revision: number }).revision, revBefore, 'no revision moves');
  assert.ok(revBefore >= rev.revision);
  const page = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}`));
  assert.equal(page.summary.review_state, 'confirmed');
  const o = raw.prepare('SELECT state FROM community_offers WHERE id = ?').get(offerId) as { state: string };
  assert.notEqual(o.state, 'rejected');
  // The stamp is still fresh: the model is still read from its tables.
  assert.equal((await readRequestModel(asD1(raw), id))!.schema_version, 3);
  // Out of the queue.
  const queue = await json(await get(as(raw, 'admin1', 'admin'), '/api/admin/community/requests?review=needs_technical_review'));
  assert.equal(queue.requests.some((r: Record<string, unknown>) => r.id === id), false);
});

test('30.D2: a customer save that read before the review cannot undo it (the review fence)', async () => {
  const raw = world();
  const id = await scenarioD(raw);
  const db = asD1(raw);
  const customerRead = (await readRequestModel(db, id))!;
  const read = await json(await get(as(raw, 'admin1', 'admin'), `/api/admin/community/requests/${id}`));
  const ok = await post(as(raw, 'admin1', 'admin'), `/api/admin/community/requests/${id}/review`, { decision: 'confirmed', parts: read.review.parts.map((p: Record<string, unknown>) => ({ id: p.id, updated_at: p.updated_at })) });
  assert.equal(ok.status, 200);
  // The save the customer started before the review lands now: the fence aborts it.
  const ts = new Date().toISOString();
  await assert.rejects(
    db.batch([
      db.prepare('UPDATE community_requests SET updated_at = ? WHERE id = ?').bind(ts, id),
      ...reviewFenceStatement(db, customerRead),
      ...modelWriteStatements(db, [{ request_id: id, model: stateOf(customerRead), schema_version: 3 }], ts),
    ]),
    /NOT NULL constraint failed: community_requests\.updated_at/
  );
  assert.equal((await readRequestModel(db, id))!.summary.review_state, 'confirmed');
  // A save that read after the review goes through and keeps it.
  const fresh = (await readRequestModel(db, id))!;
  await db.batch([...reviewFenceStatement(db, fresh), ...modelWriteStatements(db, [{ request_id: id, model: stateOf(fresh), schema_version: 3 }], ts)]);
  assert.equal((await readRequestModel(db, id))!.summary.review_state, 'confirmed');
});

test('30.D3: a complete offer, a partial one, and a complete one with a substitution — the customer sees what each covers', async () => {
  const raw = world();
  thirdWorkshop(raw);
  raw.exec(`
    UPDATE merchant_printers SET multicolor = 1 WHERE id = 'p1';
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p3','m2','s2','Small FDM','fdm',200,200,200,'[]','ultra');
  `);
  const id = await scenarioD(raw);
  const d = await readDraft(raw, id);
  const [clip, grip] = d.model.parts;
  const tpuRow = grip.materials.find((m: Record<string, unknown>) => m.material_id === 'tpu');
  const send = (who: string, body: Record<string, unknown>) =>
    post(as(raw, who), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000, delivery_method: 'pickup', ...body });
  const a = await send('owner', {});
  assert.equal(a.status, 201, JSON.stringify(await json(a.clone())));
  const b = await send('owner2', { coverage: { parts: [clip.id] }, price_iqd: 9_000 });
  assert.equal(b.status, 201, JSON.stringify(await json(b.clone())));
  // Huda cannot run TPU: the whole job only with the grip's TPU in PETG.
  const refused = await send('owner3', {});
  assert.equal((await json(refused)).code, 'OFFER_PART_NOT_ELIGIBLE');
  const c = await send('owner3', { substitutions: [{ part_id: grip.id, material_row_id: tpuRow.id, to: { material_id: 'petg' }, note: 'PETG holds better' }] });
  assert.equal(c.status, 201, JSON.stringify(await json(c.clone())));

  const list = await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}/offers`));
  const by = new Map(list.offers.map((o: Record<string, unknown>) => [String((o.merchant as Record<string, unknown>).id), o]));
  const A = by.get('m1') as Record<string, unknown>;
  const B = by.get('m2') as Record<string, unknown>;
  const C = by.get('m3') as Record<string, unknown>;
  assert.deepEqual([A.coverage, A.substitutions], [{ covers_all: true, parts: null }, []]);
  assert.deepEqual([B.coverage, B.substitutions], [{ covers_all: false, parts: [clip.id] }, []]);
  assert.deepEqual(C.coverage, { covers_all: true, parts: null });
  assert.deepEqual((C.substitutions as Array<Record<string, unknown>>).map((s) => [s.part_id, (s.from as Record<string, unknown>).material_id, (s.to as Record<string, unknown>).material_id, s.note]), [[grip.id, 'tpu', 'petg', 'PETG holds better']]);
});

test('critique 6: a v1 request in several colours shows no review anywhere and is not queued', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1, colors_count: 3 })).status, 200);
  const page = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}`));
  assert.equal(page.summary.review_state, '');
  assert.ok(page.model.parts.every((p: Record<string, unknown>) => p.review_state === ''));
  const mine = await json(await get(as(raw, 'buyer'), '/api/marketplace/print/my-requests'));
  assert.equal(mine.requests.find((r: Record<string, unknown>) => r.id === id).summary.review_state, '');
  const board = await json(await get(as(raw, 'owner'), '/api/marketplace/requests'));
  assert.equal(board.requests.find((r: Record<string, unknown>) => r.id === id).summary.review_state, '');
  const queue = await json(await get(as(raw, 'admin1', 'admin'), '/api/admin/community/requests?review=needs_technical_review'));
  assert.equal(queue.requests.some((r: Record<string, unknown>) => r.id === id), false);
  const review = await post(as(raw, 'admin1', 'admin'), `/api/admin/community/requests/${id}/review`, { decision: 'confirmed', parts: [{ id: `rpt_${id}_1`, updated_at: 'x' }] });
  assert.equal(review.status, 409);
  assert.equal((await json(review)).code, 'REQUEST_NOT_REVIEWABLE');
});
