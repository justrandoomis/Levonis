/**
 * WHAT AN OFFER COVERS AND WHAT IT SUBSTITUTES (P1-05, docs/DECISIONS.md row
 * 267, D5–D7) — worker/lib/offerCoverage.ts through the real routes and
 * migrations.
 *
 * Pinned: a partial offer is stored as its parts with `covers_all = 0`, a
 * whole one as NULL with 1 (every part named is whole); each refusal answers
 * its own code; a workshop offers only on parts it can make, and a
 * substitution that makes a part makeable is taken; a substituted offer is
 * accepted only with `accept_substitutions` and a partial one only with
 * `accept_partial` — refused before any money moves, and with them the order
 * keeps the agreement; an edit of a substitution moves the revision; a
 * re-confirm re-checks the coverage against the job as it now is; a covered
 * part the workshop can no longer make refuses the acceptance; a database
 * before 0208 takes a default offer and refuses a named coverage honestly;
 * and a v1 offer's order snapshot is today's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, json, patch, post, row } from './fixtures/app';
import { as, dump, fund, newDraft, offerOn, PLA, publish, readDraft, world } from './fixtures/requestModelWorld';
import { revisionHashFence, isRevisionFenceAbort } from '../worker/lib/offerCoverage';

const JOB = {
  schema_version: 3,
  parts: [
    { name: 'Body', process: 'fdm', stated_dimensions_mm: { x: 80, y: 60, z: 20 }, materials: [{ material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#1a1a1a', label: 'Black' }] }] },
    { name: 'Grip', process: 'fdm', stated_dimensions_mm: { x: 60, y: 20, z: 20 }, materials: [{ material_id: 'tpu', colors: [{ mode: 'catalogue', hex: '#d32f2f', label: 'Red' }] }] },
  ],
};

interface Job { id: string; a: string; b: string; ma: string; mb: string }

async function jobOfParts(raw: DatabaseSync, body: Record<string, unknown> = JOB): Promise<Job> {
  const id = await newDraft(raw);
  const res = await publish(raw, id, body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = await readDraft(raw, id);
  const [a, b] = d.model.parts;
  return { id, a: a.id, b: b?.id, ma: a.materials[0].id, mb: b?.materials[0].id };
}

const offer = async (raw: DatabaseSync, id: string, body: Record<string, unknown> = {}, who = 'owner') => {
  const res = await post(as(raw, who), `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup', ...body });
  return { status: res.status, body: await json(res) };
};
const accept = async (raw: DatabaseSync, offerId: string, total: number, revision: number, extra: Record<string, unknown> = {}) => {
  const res = await post(as(raw, 'buyer'), `/api/marketplace/offers/${offerId}/accept`, { expected_total_iqd: total, offer_revision: revision, ...extra });
  return { status: res.status, body: await json(res) };
};
const money = (raw: DatabaseSync) => [
  dump(raw, 'wallet_transactions', 'id'),
  dump(raw, 'wallet_holds', 'id'),
  dump(raw, 'community_escrows', 'id'),
  dump(raw, 'community_orders', 'id'),
];
const offerRow = (raw: DatabaseSync, id: string) =>
  row<{ coverage_json: string | null; substitutions_json: string; covers_all: number; revision: number; state: string }>(
    raw, 'SELECT coverage_json, substitutions_json, covers_all, revision, state FROM community_offers WHERE id = ?', id)!;

test('a partial offer is stored as its parts with covers_all 0; a whole one — or every part named — as NULL with 1', async () => {
  const raw = world();
  const j = await jobOfParts(raw);
  const partial = await offer(raw, j.id, { coverage: { parts: [j.a] } });
  assert.equal(partial.status, 201, JSON.stringify(partial.body));
  assert.deepEqual({ ...offerRow(raw, partial.body.offer.id), revision: 0, state: '' },
    { coverage_json: JSON.stringify({ parts: [j.a] }), substitutions_json: '[]', covers_all: 0, revision: 0, state: '' });
  assert.deepEqual(partial.body.offer.coverage, { covers_all: false, parts: [j.a] });
  // The revision trail records it (offer history shows «was partial»).
  const terms = JSON.parse(row<{ terms: string }>(raw, 'SELECT terms FROM community_offer_revisions WHERE offer_id = ?', partial.body.offer.id)!.terms);
  assert.equal(terms.covers_all, 0);

  const k = await jobOfParts(raw);
  const all = await offer(raw, k.id, { coverage: { parts: [k.b, k.a] } });
  assert.equal(all.status, 201, JSON.stringify(all.body));
  assert.deepEqual({ ...offerRow(raw, all.body.offer.id) }, { coverage_json: null, substitutions_json: '[]', covers_all: 1, revision: 1, state: 'pending' });
  const whole = await offer(raw, (await jobOfParts(raw)).id);
  assert.equal(whole.status, 201);
  assert.equal(offerRow(raw, whole.body.offer.id).covers_all, 1);
  assert.deepEqual(whole.body.offer.substitutions, []);
  const trail = JSON.parse(row<{ terms: string }>(raw, 'SELECT terms FROM community_offer_revisions WHERE offer_id = ?', whole.body.offer.id)!.terms);
  assert.equal('covers_all' in trail, false, 'a whole offer writes today\'s trail');
});

test('OFFER_COVERAGE_INVALID: no part, an unknown part, a part twice — nothing written', async () => {
  const raw = world();
  const j = await jobOfParts(raw);
  for (const coverage of [{ parts: [] }, { parts: ['rpt_nope'] }, { parts: [j.a, j.a] }]) {
    const r = await offer(raw, j.id, { coverage });
    assert.equal(r.status, 400, JSON.stringify(coverage));
    assert.equal(r.body.code, 'OFFER_COVERAGE_INVALID');
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers WHERE request_id = ?', j.id), 0);
});

test('OFFER_PART_NOT_ELIGIBLE: a workshop without TPU cannot offer the whole job, can offer the PLA part, and can offer TPU→PETG', async () => {
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET materials = '["pla","petg"]' WHERE id = 'p1'`);
  const j = await jobOfParts(raw);
  const whole = await offer(raw, j.id);
  assert.equal(whole.status, 403, JSON.stringify(whole.body));
  assert.equal(whole.body.code, 'OFFER_PART_NOT_ELIGIBLE');
  assert.equal(whole.body.details.part_id, j.b);
  assert.deepEqual(whole.body.details.reasons, ['MATERIAL']);
  assert.equal(whole.body.details.position, 1, 'the part is named by its place too');
  // The PLA part alone.
  const partial = await offer(raw, j.id, { coverage: { parts: [j.a] } });
  assert.equal(partial.status, 201, JSON.stringify(partial.body));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers WHERE request_id = ?', j.id), 1);
  // Another job: the whole of it, with the grip in PETG instead.
  const k = await jobOfParts(raw);
  const sub = await offer(raw, k.id, { substitutions: [{ part_id: k.b, material_row_id: k.mb, to: { material_id: 'petg' }, note: 'TPU is out of stock' }] });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  const s = sub.body.offer.substitutions[0];
  assert.deepEqual(s.from, { material_id: 'tpu', colors: [{ hex: '#d32f2f', label: 'Red' }] }, 'the from is read from the request');
  assert.deepEqual(s.to, { material_id: 'petg', colors: [{ hex: '#d32f2f', label: 'Red' }] });
});

test('OFFER_SUBSTITUTION_INVALID: every way a substitute is not one', async () => {
  const raw = world();
  const j = await jobOfParts(raw);
  const unsure = await jobOfParts(raw, { schema_version: 3, parts: [{ name: 'Any', process: 'fdm', materials: [{ material_id: 'unsure', colors: [{ mode: 'any' }] }] }, { name: 'Two', process: 'fdm', materials: [{ material_id: 'pla', colors: [{ mode: 'any' }] }] }] });
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['a part the offer does not cover', j.id, { coverage: { parts: [j.a] }, substitutions: [{ part_id: j.b, material_row_id: j.mb, to: { material_id: 'petg' } }] }],
    ['a row not in the part', j.id, { substitutions: [{ part_id: j.a, material_row_id: j.mb, to: { material_id: 'petg' } }] }],
    ['a material the customer left open', unsure.id, { substitutions: [{ part_id: unsure.a, material_row_id: unsure.ma, to: { material_id: 'pla' } }] }],
    ['colours that were all any', unsure.id, { substitutions: [{ part_id: unsure.b, material_row_id: unsure.mb, to: { colors: [{ hex: '#ffffff', label: 'White' }] } }] }],
    ['a material outside the catalogue', j.id, { substitutions: [{ part_id: j.a, material_row_id: j.ma, to: { material_id: 'unobtainium' } }] }],
    ['a resin for an FDM part', j.id, { substitutions: [{ part_id: j.a, material_row_id: j.ma, to: { material_id: 'resin-standard' } }] }],
    ['a change that changes nothing', j.id, { substitutions: [{ part_id: j.a, material_row_id: j.ma, to: { material_id: 'pla' } }] }],
    ['two on one row', j.id, { substitutions: [{ part_id: j.a, material_row_id: j.ma, to: { material_id: 'petg' } }, { part_id: j.a, material_row_id: j.ma, to: { material_id: 'abs' } }] }],
  ];
  for (const [why, rid, body] of cases) {
    const r = await offer(raw, rid, body);
    assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'OFFER_SUBSTITUTION_INVALID', why);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers'), 0);
});

test('OFFER_SUBSTITUTION_UNACCEPTED before any money moves; accepted with the flag, the order keeps the agreement', async () => {
  const raw = world();
  fund(raw, 'buyer', 1_000_000);
  const j = await jobOfParts(raw);
  const sub = await offer(raw, j.id, { substitutions: [{ part_id: j.b, material_row_id: j.mb, to: { material_id: 'petg', colors: [{ hex: '#1a1a1a', label: 'Black' }] }, note: 'firmer grip' }] });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  const o = sub.body.offer;
  const before = money(raw);
  const refused = await accept(raw, o.id, o.total_iqd, o.revision);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'OFFER_SUBSTITUTION_UNACCEPTED');
  assert.equal(refused.body.details.offer.id, o.id, 'the fresh offer rides along');
  assert.deepEqual(money(raw), before, 'no money moved');
  // The partial flag is not the substitutions flag.
  assert.equal((await accept(raw, o.id, o.total_iqd, o.revision, { accept_partial: true })).body.code, 'OFFER_SUBSTITUTION_UNACCEPTED');

  const ok = await accept(raw, o.id, o.total_iqd, o.revision, { accept_substitutions: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const order = row<{ state: string; request_snapshot: string; offer_snapshot: string }>(raw, 'SELECT state, request_snapshot, offer_snapshot FROM community_orders WHERE offer_id = ?', o.id)!;
  assert.equal(order.state, 'funded');
  const snap = JSON.parse(order.request_snapshot);
  assert.equal(snap.schema_version, 3);
  assert.equal(snap.agreement.covers_all, true);
  assert.deepEqual(snap.agreement.acknowledged, { substitutions: true });
  assert.equal(snap.agreement.substitutions[0].to.material_id, 'petg');
  const grip = snap.agreement.parts.find((p: Record<string, unknown>) => p.id === j.b);
  assert.equal(grip.materials[0].material_id, 'petg');
  assert.equal(grip.materials[0].substituted, true);
  assert.equal('budget_iqd' in snap.agreement, false, 'the agreement never copies the budget');
  const os = JSON.parse(order.offer_snapshot);
  assert.deepEqual(os.coverage, { covers_all: true, parts: null });
  assert.equal(os.substitutions.length, 1);
});

test('OFFER_PARTIAL_UNACCEPTED before any money moves; with it the request closes, the rivals are rejected, the uncovered part is kept', async () => {
  const raw = world();
  fund(raw, 'buyer', 1_000_000);
  raw.exec(`INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
              VALUES ('p3','m2','s2','FDM too','fdm',300,300,300,'[]','ultra')`);
  const j = await jobOfParts(raw);
  const partial = await offer(raw, j.id, { coverage: { parts: [j.a] }, price_iqd: 12_000 });
  assert.equal(partial.status, 201, JSON.stringify(partial.body));
  const rival = await offer(raw, j.id, { price_iqd: 40_000 }, 'owner2');
  assert.equal(rival.status, 201, JSON.stringify(rival.body));
  const o = partial.body.offer;
  const before = money(raw);
  const refused = await accept(raw, o.id, o.total_iqd, o.revision, { accept_substitutions: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'OFFER_PARTIAL_UNACCEPTED');
  assert.deepEqual(money(raw), before);
  const ok = await accept(raw, o.id, o.total_iqd, o.revision, { accept_partial: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', j.id)!.state, 'in_progress');
  assert.equal(offerRow(raw, rival.body.offer.id).state, 'rejected');
  const snap = JSON.parse(row<{ request_snapshot: string }>(raw, 'SELECT request_snapshot FROM community_orders WHERE offer_id = ?', o.id)!.request_snapshot);
  assert.equal(snap.agreement.covers_all, false);
  assert.deepEqual(snap.agreement.uncovered.map((p: Record<string, unknown>) => p.id), [j.b]);
  assert.deepEqual(snap.agreement.acknowledged, { partial: true });
});

test('an edit of the substitutions moves the revision: the one the customer saw is OFFER_CHANGED', async () => {
  const raw = world();
  fund(raw, 'buyer', 1_000_000);
  const j = await jobOfParts(raw);
  const sub = await offer(raw, j.id, { substitutions: [{ part_id: j.b, material_row_id: j.mb, to: { material_id: 'petg' } }] });
  const o = sub.body.offer;
  const edit = await patch(as(raw, 'owner'), `/api/marketplace/offers/${o.id}`, { substitutions: [{ part_id: j.b, material_row_id: j.mb, to: { material_id: 'abs' } }] });
  assert.equal(edit.status, 200, JSON.stringify(await json(edit.clone())));
  const after = (await json(edit)).offer;
  assert.equal(after.revision, o.revision + 1);
  assert.equal(after.substitutions[0].to.material_id, 'abs');
  const stale = await accept(raw, o.id, o.total_iqd, o.revision, { accept_substitutions: true });
  assert.equal(stale.body.code, 'OFFER_CHANGED');
  // Back to no substitution: the columns go back to their defaults.
  const none = await patch(as(raw, 'owner'), `/api/marketplace/offers/${o.id}`, { substitutions: [] });
  assert.equal(none.status, 200);
  assert.equal(offerRow(raw, o.id).substitutions_json, '[]');
});

test('re-confirm checks the coverage against the job as it now is (critique 4)', async () => {
  const raw = world();
  const j = await jobOfParts(raw);
  // A partial offer on part B; the customer removes part B: the offer cannot stand.
  const onB = await offer(raw, j.id, { coverage: { parts: [j.b] } });
  assert.equal(onB.status, 201);
  const d = await readDraft(raw, j.id);
  const keepA = { schema_version: 3, parts: [d.model.parts[0]] };
  assert.equal((await publish(raw, j.id, keepA)).status, 200);
  assert.equal(offerRow(raw, onB.body.offer.id).state, 'superseded');
  const gone = await post(as(raw, 'owner'), `/api/marketplace/offers/${onB.body.offer.id}/reconfirm`, {});
  assert.equal(gone.status, 400);
  assert.equal((await json(gone)).code, 'OFFER_COVERAGE_INVALID');

  // A partial offer on part A; the customer removes part B: it is whole now, no acknowledgement needed.
  const k = await jobOfParts(raw);
  const onA = await offer(raw, k.id, { coverage: { parts: [k.a] } });
  const dk = await readDraft(raw, k.id);
  assert.equal((await publish(raw, k.id, { schema_version: 3, parts: [dk.model.parts[0]] })).status, 200);
  const re = await post(as(raw, 'owner'), `/api/marketplace/offers/${onA.body.offer.id}/reconfirm`, {});
  assert.equal(re.status, 200, JSON.stringify(await json(re.clone())));
  assert.deepEqual({ ...offerRow(raw, onA.body.offer.id), revision: 0 }, { coverage_json: null, substitutions_json: '[]', covers_all: 1, revision: 0, state: 'pending' });

  // A whole offer; the customer adds a part: «whole» does not stretch over it.
  const w = await jobOfParts(raw);
  const whole = await offer(raw, w.id);
  const dw = await readDraft(raw, w.id);
  const three = { schema_version: 3, parts: [...dw.model.parts, { name: 'Lid', process: 'fdm', materials: [{ material_id: 'pla' }] }] };
  assert.equal((await publish(raw, w.id, three)).status, 200);
  const added = await post(as(raw, 'owner'), `/api/marketplace/offers/${whole.body.offer.id}/reconfirm`, {});
  assert.equal(added.status, 400);
  const ab = await json(added);
  assert.equal(ab.code, 'OFFER_COVERAGE_INVALID');
  assert.equal(ab.details.added.length, 1);
});

test('a customer edit that changes a substituted material: re-confirm refuses, acceptance refuses before money moves', async () => {
  const raw = world();
  fund(raw, 'buyer', 1_000_000);
  const j = await jobOfParts(raw);
  const sub = await offer(raw, j.id, { substitutions: [{ part_id: j.b, material_row_id: j.mb, to: { material_id: 'petg' } }] });
  const d = await readDraft(raw, j.id);
  const grip = d.model.parts[1];
  const changed = { schema_version: 3, parts: [d.model.parts[0], { ...grip, materials: [{ ...grip.materials[0], material_id: 'abs' }] }] };
  assert.equal((await publish(raw, j.id, changed)).status, 200);
  const before = money(raw);
  const acc = await accept(raw, sub.body.offer.id, sub.body.offer.total_iqd, sub.body.offer.revision, { accept_substitutions: true });
  assert.equal(acc.status, 409);
  assert.equal(acc.body.code, 'OFFER_STALE');
  assert.deepEqual(money(raw), before);
  const re = await post(as(raw, 'owner'), `/api/marketplace/offers/${sub.body.offer.id}/reconfirm`, {});
  assert.equal(re.status, 400);
  assert.equal((await json(re)).code, 'OFFER_SUBSTITUTION_INVALID');
});

test('a covered part the workshop can no longer make refuses the acceptance OFFER_NOT_ELIGIBLE — no money moves (critique 2)', async () => {
  const raw = world();
  fund(raw, 'buyer', 1_000_000);
  const j = await jobOfParts(raw);
  const whole = await offer(raw, j.id);
  assert.equal(whole.status, 201);
  // The TPU machine goes: the PLA part is still makeable, the job is still «eligible».
  raw.exec(`UPDATE merchant_printers SET materials = '["pla"]' WHERE id = 'p1'`);
  const before = money(raw);
  const acc = await accept(raw, whole.body.offer.id, whole.body.offer.total_iqd, whole.body.offer.revision);
  assert.equal(acc.status, 409, JSON.stringify(acc.body));
  assert.equal(acc.body.code, 'OFFER_NOT_ELIGIBLE');
  assert.deepEqual(money(raw), before);
});

test('a part removed between the composer\'s read and the offer: refused, nothing written; and the write itself is fenced on the revision', async () => {
  const raw = world();
  const j = await jobOfParts(raw);
  const d = await readDraft(raw, j.id);
  // No offer yet: the customer's edit rewrites revision 1 in place.
  assert.equal((await publish(raw, j.id, { schema_version: 3, parts: [d.model.parts[0]] })).status, 200);
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', j.id)!.revision, 1);
  const late = await offer(raw, j.id, { coverage: { parts: [j.b] } });
  assert.equal(late.status, 400);
  assert.equal(late.body.code, 'OFFER_COVERAGE_INVALID');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers WHERE request_id = ?', j.id), 0);
  // The fence: a batch carrying a hash the revision no longer has writes nothing.
  const db = asD1(raw);
  await assert.rejects(
    db.batch([revisionHashFence(db, j.id, 'not-the-hash'), db.prepare(`UPDATE community_requests SET title = 'moved' WHERE id = ?`).bind(j.id)]),
    (e: unknown) => isRevisionFenceAbort(e)
  );
  assert.notEqual(row<{ title: string }>(raw, 'SELECT title FROM community_requests WHERE id = ?', j.id)!.title, 'moved');
});

test('before 0208: a default offer works, a named substitution is OFFER_COVERAGE_UNAVAILABLE; a v1 order snapshot has no coverage', async () => {
  const raw = world('0207');
  fund(raw, 'buyer', 1_000_000);
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, PLA)).status, 200);
  const named = await offer(raw, id, { substitutions: [{ part_id: `rpt_${id}_1`, material_row_id: `rpm_${id}_1_1`, to: { material_id: 'petg' } }] });
  assert.equal(named.status, 503, JSON.stringify(named.body));
  assert.equal(named.body.code, 'OFFER_COVERAGE_UNAVAILABLE');
  // The defaults written out are no coverage at all.
  const plain = await offer(raw, id, { coverage: null, substitutions: [] });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual(plain.body.offer.coverage, { covers_all: true, parts: null });
  const ok = await accept(raw, plain.body.offer.id, plain.body.offer.total_iqd, plain.body.offer.revision);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const order = row<{ offer_snapshot: string; request_snapshot: string }>(raw, 'SELECT offer_snapshot, request_snapshot FROM community_orders WHERE offer_id = ?', plain.body.offer.id)!;
  assert.equal('coverage' in JSON.parse(order.offer_snapshot), false);
  assert.equal('agreement' in JSON.parse(order.request_snapshot), false);
});

test('a v1 request on 0208: its pending offer is accepted at the same hash with today\'s body and today\'s snapshot keys', async () => {
  const raw = world();
  fund(raw, 'buyer', 1_000_000);
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, PLA)).status, 200);
  const hash = row<{ hash: string }>(raw, 'SELECT hash FROM community_request_revisions WHERE request_id = ? AND revision = 1', id)!.hash;
  const o = await offerOn(raw, id, 21_000);
  assert.deepEqual({ ...offerRow(raw, o.id) }, { coverage_json: null, substitutions_json: '[]', covers_all: 1, revision: 1, state: 'pending' });
  const ok = await accept(raw, o.id, 21_000, o.revision);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const order = row<{ offer_snapshot: string; request_snapshot: string }>(raw, 'SELECT offer_snapshot, request_snapshot FROM community_orders WHERE offer_id = ?', o.id)!;
  const rs = JSON.parse(order.request_snapshot);
  assert.equal(rs.hash, hash);
  assert.deepEqual(Object.keys(rs).sort(), ['estimate', 'files', 'hash', 'revision', 'spec']);
  assert.equal('coverage' in JSON.parse(order.offer_snapshot), false);
});
