/**
 * OFFER COVERAGE, REVIEW FIXES (P1-05, docs/DECISIONS.md row 267) — through
 * the real routes and migrations.
 *
 * Pinned: the rollback script leaves no open partial or substituted offer and
 * no draft with a coverage that an older build could fund as the whole job; a
 * whole offer re-confirmed or edited while the customer adds a part is
 * refused (REQUEST_CHANGED), not stretched over that part; a draft keeps only
 * what the merchant named, and its send refuses a substitution whose source
 * the customer changed since; the offers list marks a whole offer whose
 * workshop can no longer make every part, as acceptance does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, patch, post, row, stubApp } from './fixtures/app';
import { as, fund, mount, newDraft, publish, readDraft, world } from './fixtures/requestModelWorld';

const ROLLBACK = readFileSync(new URL('../scripts/before-rollback-offers-v3.sql', import.meta.url), 'utf8');

const JOB = {
  schema_version: 3,
  parts: [
    { name: 'Body', process: 'fdm', stated_dimensions_mm: { x: 80, y: 60, z: 20 }, materials: [{ material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#1a1a1a', label: 'Black' }] }] },
    { name: 'Grip', process: 'fdm', stated_dimensions_mm: { x: 60, y: 20, z: 20 }, materials: [{ material_id: 'tpu', colors: [{ mode: 'catalogue', hex: '#d32f2f', label: 'Red' }] }] },
  ],
};

async function jobOfParts(raw: DatabaseSync, body: Record<string, unknown> = JOB) {
  const id = await newDraft(raw);
  const res = await publish(raw, id, body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = await readDraft(raw, id);
  const [a, b] = d.model.parts;
  return { id, a: a.id as string, b: b.id as string, mb: b.materials[0].id as string, parts: d.model.parts };
}

const offer = async (raw: DatabaseSync, id: string, body: Record<string, unknown> = {}) => {
  const res = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup', ...body });
  return { status: res.status, body: await json(res) };
};
const offerRow = (raw: DatabaseSync, id: string) =>
  row<{ state: string; covers_all: number; request_revision: number; revision: number }>(
    raw, 'SELECT state, covers_all, request_revision, revision FROM community_offers WHERE id = ?', id)!;
const drafts = (raw: DatabaseSync) => row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_offer_drafts')!.n;

/** The owner's app whose D1 runs `hook` once, just before the first batch whose SQL matches `re`. */
function ownerWithHook(raw: DatabaseSync, re: RegExp, hook: () => Promise<void>) {
  const d1 = asD1(raw) as unknown as { batch: (s: Array<{ sql: string }>) => Promise<unknown> };
  let fired = false;
  const wrapped = new Proxy(d1, {
    get(t, k) {
      if (k === 'batch') {
        return async (stmts: Array<{ sql: string }>) => {
          if (!fired && stmts.some((s) => re.test(s.sql))) {
            fired = true;
            await hook();
          }
          return t.batch(stmts);
        };
      }
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return stubApp(wrapped as unknown as D1Database, { id: 'owner', role: 'customer', email: 'owner@x.co' }, mount);
}

// ------------------------------------------------------------ the rollback

test('rollback script: every open partial or substituted offer is withdrawn, a whole one untouched; idempotent', async () => {
  const raw = world();
  const partial = await jobOfParts(raw);
  const p = await offer(raw, partial.id, { coverage: { parts: [partial.a] }, price_iqd: 12_000 });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const substituted = await jobOfParts(raw);
  const s = await offer(raw, substituted.id, { substitutions: [{ part_id: substituted.b, material_row_id: substituted.mb, to: { material_id: 'petg' }, note: '' }] });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const superseded = await jobOfParts(raw);
  const q = await offer(raw, superseded.id, { coverage: { parts: [superseded.a] }, price_iqd: 12_000 });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  raw.prepare(`UPDATE community_offers SET state = 'superseded' WHERE id = ?`).run(q.body.offer.id);
  const whole = await jobOfParts(raw);
  const w = await offer(raw, whole.id);
  assert.equal(w.status, 201, JSON.stringify(w.body));

  raw.exec(ROLLBACK);
  raw.exec(ROLLBACK);
  assert.equal(offerRow(raw, p.body.offer.id).state, 'withdrawn');
  assert.equal(offerRow(raw, s.body.offer.id).state, 'withdrawn');
  assert.equal(offerRow(raw, q.body.offer.id).state, 'withdrawn');
  assert.equal(offerRow(raw, w.body.offer.id).state, 'pending');
  // Withdrawn is terminal: neither an edit nor a re-confirm re-opens it.
  const ed = await patch(as(raw, 'owner'), `/api/marketplace/offers/${p.body.offer.id}`, { message: 'Still available' });
  assert.notEqual(ed.status, 200);
  const rc = await post(as(raw, 'owner'), `/api/marketplace/offers/${q.body.offer.id}/reconfirm`, {});
  assert.notEqual(rc.status, 200);
  assert.equal(offerRow(raw, p.body.offer.id).state, 'withdrawn');
  assert.equal(offerRow(raw, q.body.offer.id).state, 'withdrawn');
});

test('rollback script: a draft with a coverage or a substitution is deleted, a whole draft kept', async () => {
  const raw = world();
  const a = await jobOfParts(raw);
  assert.ok([200, 201].includes((await offer(raw, a.id, { draft: true, coverage: { parts: [a.a] } })).status));
  const b = await jobOfParts(raw);
  assert.ok([200, 201].includes((await offer(raw, b.id, { draft: true, substitutions: [{ part_id: b.b, material_row_id: b.mb, to: { material_id: 'petg' }, note: '' }] })).status));
  const c = await jobOfParts(raw);
  assert.ok([200, 201].includes((await offer(raw, c.id, { draft: true })).status));
  assert.equal(drafts(raw), 3);
  raw.exec(ROLLBACK);
  assert.equal(drafts(raw), 1);
  assert.equal(row<{ request_id: string }>(raw, 'SELECT request_id FROM community_offer_drafts')!.request_id, c.id);
  // A payload that is not JSON is left alone, and does not stop the script.
  raw.prepare(`UPDATE community_offer_drafts SET payload_json = 'not json'`).run();
  raw.exec(ROLLBACK);
  assert.equal(drafts(raw), 1);
});

// ------------------------------------------------- a whole offer, fenced

async function supersededWholeOffer(raw: DatabaseSync) {
  const j = await jobOfParts(raw);
  const o = await offer(raw, j.id);
  assert.equal(o.status, 201, JSON.stringify(o.body));
  // The customer edits a material: a new revision, the offer superseded.
  const d = await readDraft(raw, j.id);
  const r2 = { schema_version: 3, parts: [d.model.parts[0], { ...d.model.parts[1], materials: [{ ...d.model.parts[1].materials[0], material_id: 'pla' }] }] };
  assert.equal((await publish(raw, j.id, r2)).status, 200);
  assert.equal(offerRow(raw, o.body.offer.id).state, 'superseded');
  const d2 = await readDraft(raw, j.id);
  const r3 = { schema_version: 3, parts: [...d2.model.parts, { name: 'Lid', process: 'fdm', stated_dimensions_mm: { x: 50, y: 50, z: 5 }, materials: [{ material_id: 'pla' }] }] };
  return { j, offerId: String(o.body.offer.id), addPart: async () => assert.equal((await publish(raw, j.id, r3)).status, 200) };
}

for (const [door, re] of [['re-confirm', /SET state = 'pending', revision = revision \+ 1,\s+request_revision/], ['edit', /SET .*state = 'pending', revision = revision \+ 1/]] as const) {
  test(`a whole offer's ${door} refuses REQUEST_CHANGED when the customer adds a part in between`, async () => {
    const raw = world();
    fund(raw, 'buyer', 1_000_000);
    const { offerId, addPart } = await supersededWholeOffer(raw);
    const app = ownerWithHook(raw, re, addPart);
    const res = door === 're-confirm'
      ? await post(app, `/api/marketplace/offers/${offerId}/reconfirm`, {})
      : await patch(app, `/api/marketplace/offers/${offerId}`, { message: 'Same terms' });
    const body = await json(res);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'REQUEST_CHANGED');
    // Nothing written: still superseded, so it cannot be accepted over the added part.
    assert.equal(offerRow(raw, offerId).state, 'superseded');
    assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_orders')!.n, 0);
  });
}

for (const door of ['re-confirm', 'edit'] as const) {
  test(`a whole offer's ${door} with no change in between is pending again (the fence passes)`, async () => {
    const raw = world();
    const { offerId } = await supersededWholeOffer(raw);
    const res = door === 're-confirm'
      ? await post(as(raw, 'owner'), `/api/marketplace/offers/${offerId}/reconfirm`, {})
      : await patch(as(raw, 'owner'), `/api/marketplace/offers/${offerId}`, { message: 'Same terms' });
    assert.equal(res.status, 200, JSON.stringify(await json(res)));
    assert.equal(offerRow(raw, offerId).state, 'pending');
  });
}

// ------------------------------------------------------------- the draft

test('a draft keeps only what the merchant named; its send refuses a substitute whose source changed', async () => {
  const raw = world();
  const j = await jobOfParts(raw);
  const dr = await offer(raw, j.id, { draft: true, substitutions: [{ part_id: j.b, material_row_id: j.mb, to: { material_id: 'petg' }, note: 'TPU out' }] });
  assert.ok([200, 201].includes(dr.status), JSON.stringify(dr.body));
  // The composer restores a material and no colour: the merchant named none.
  assert.deepEqual(dr.body.offer.substitutions, [{ part_id: j.b, material_row_id: j.mb, to: { material_id: 'petg', colors: [] }, note: 'TPU out' }]);
  const stored = JSON.parse(row<{ payload_json: string }>(raw, 'SELECT payload_json FROM community_offer_drafts')!.payload_json);
  assert.deepEqual(stored.substitutions[0].to, { material_id: 'petg' });

  // The customer recolours the grip blue (no offer yet: rewritten in place, same ids).
  const [a, b] = j.parts;
  const recol = { schema_version: 3, parts: [a, { ...b, materials: [{ ...b.materials[0], colors: [{ mode: 'catalogue', hex: '#1e40af', label: 'Blue' }] }] }] };
  assert.equal((await publish(raw, j.id, recol)).status, 200);
  const sent = await post(as(raw, 'owner'), `/api/marketplace/offers/${dr.body.offer.id}/send`, {});
  const sb = await json(sent);
  assert.equal(sent.status, 400, JSON.stringify(sb));
  assert.equal(sb.code, 'OFFER_SUBSTITUTION_INVALID');
  assert.equal(drafts(raw), 1, 'the draft is kept');
});

test('a draft sent with its source unchanged offers exactly the material named, in the colours asked', async () => {
  const raw = world();
  const j = await jobOfParts(raw);
  const dr = await offer(raw, j.id, { draft: true, substitutions: [{ part_id: j.b, material_row_id: j.mb, to: { material_id: 'petg' }, note: '' }] });
  assert.ok([200, 201].includes(dr.status), JSON.stringify(dr.body));
  const sent = await post(as(raw, 'owner'), `/api/marketplace/offers/${dr.body.offer.id}/send`, {});
  const sb = await json(sent);
  assert.equal(sent.status, 201, JSON.stringify(sb));
  assert.deepEqual(sb.offer.substitutions.map((x: Record<string, unknown>) => ({ from: x.from, to: x.to })), [
    { from: { material_id: 'tpu', colors: [{ hex: '#d32f2f', label: 'Red' }] }, to: { material_id: 'petg', colors: [{ hex: '#d32f2f', label: 'Red' }] } },
  ]);
});

// ------------------------------------------------------------ the list

test('the offers list marks a whole offer whose workshop can no longer make every part, as acceptance refuses it', async () => {
  const raw = world();
  fund(raw, 'buyer', 1_000_000);
  const j = await jobOfParts(raw);
  const o = await offer(raw, j.id);
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const listed = async () => {
    const lb = await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${j.id}/offers`));
    return (lb.offers ?? []).find((x: Record<string, unknown>) => x.id === o.body.offer.id);
  };
  assert.equal((await listed()).workshop_unable, false);
  // The printer no longer runs TPU: the grip cannot be made.
  raw.exec(`UPDATE merchant_printers SET materials = '["pla"]' WHERE id = 'p1'`);
  const mine = await listed();
  assert.equal(mine.state, 'pending');
  assert.equal(mine.workshop_unable, true);
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${o.body.offer.id}/accept`, { expected_total_iqd: o.body.offer.total_iqd, offer_revision: o.body.offer.revision });
  assert.equal(acc.status, 409);
  assert.equal((await json(acc)).code, 'OFFER_NOT_ELIGIBLE');
});

test('a partial offer on the part the workshop can still make stays live in the list', async () => {
  const raw = world();
  const j = await jobOfParts(raw);
  const o = await offer(raw, j.id, { coverage: { parts: [j.a] }, price_iqd: 12_000 });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  raw.exec(`UPDATE merchant_printers SET materials = '["pla"]' WHERE id = 'p1'`);
  const lb = await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${j.id}/offers`));
  const mine = (lb.offers ?? []).find((x: Record<string, unknown>) => x.id === o.body.offer.id);
  assert.equal(mine.workshop_unable, false);
});
