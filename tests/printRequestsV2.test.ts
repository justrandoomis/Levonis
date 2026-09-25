/**
 * PRINT REQUESTS v2 (stream W5-A) — draft → published, revisions, wizard v2
 * inputs, expiry, offers v2, and what acceptance reveals.
 *
 * Real routes and migrations (0130 included) through the D1 adapter. Each test
 * names the rule it pins (docs/merchant-platform/audit/03 §9 G1–G5, G15–G17,
 * §11 items 9–12 and 19–20; docs/MERCHANT_PLATFORM.md §4.7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, post, patch, put, get, json, count, row, all, type Mount } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { runCommunitySweeps } from '../worker/lib/communityRequests';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array | ArrayBuffer) {
    this.objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  async head(key: string) {
    const v = this.objects.get(key);
    return v ? ({ key, size: v.byteLength } as unknown as R2Object) : null;
  }
  async get(key: string) {
    const v = this.objects.get(key);
    if (!v) return null;
    return { body: new Blob([v as unknown as BlobPart]).stream(), httpEtag: `"${key}"`, arrayBuffer: async () => v.buffer };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

const RATE = 1400;

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,phone_e164) VALUES
      ('buyer','Sara','s@x.co','h','customer','+9647700000001'), ('owner','Ali','a@x.co','h','customer',NULL),
      ('owner2','Omar','o@x.co','h','customer',NULL), ('stranger','Nour','n@x.co','h','customer',NULL);
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name,phone) VALUES ('m1','owner','Ali 3D','+9647511111111'), ('m2','owner2','Omar Resin','');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,contact_phone) VALUES
      ('s1','m1','owner','ali3d','Ali 3D',''), ('s2','m2','owner2','omarresin','Omar Resin','+9647522222222');
    -- m1 prints FDM up to 300 mm; m2 prints only resin.
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p1','m1','s1','Big FDM','fdm',300,300,300,'[]','ultra'),
             ('p2','m2','s2','Resin','resin',200,200,200,'[]','ultra');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default,governorate,area)
      VALUES ('a1','buyer','Home','Sara K','+9647700000009','Street 12, house 4','near the mosque',1,'baghdad','Karrada');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const fund = (raw: DatabaseSync, user: string, iqd: number) =>
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_${Math.random().toString(36).slice(2)}','${user}','deposit','USD',${Math.ceil((iqd * 100) / RATE)},'approved','test funding')`);

const as = (raw: DatabaseSync, id: string, bucket?: MemoryBucket) =>
  stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount, bucket ? { env: { BUCKET: bucket } } : {});

const PLA = { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1 };

async function newDraft(raw: DatabaseSync, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await post(as(raw, 'buyer'), '/api/marketplace/requests', {
    title: 'A phone stand', description: 'A stand for a phone, please', ...extra,
  });
  assert.equal(res.status, 201);
  return (await json(res)).request.id as string;
}

async function publish(raw: DatabaseSync, id: string, body: Record<string, unknown> = PLA) {
  const res = await post(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, body);
  return { status: res.status, body: await json(res) };
}

async function newPublished(raw: DatabaseSync, body: Record<string, unknown> = PLA): Promise<string> {
  const id = await newDraft(raw);
  const pub = await publish(raw, id, body);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  return id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON body, read field by field below
type Json = Record<string, any>;
async function offersAs(raw: DatabaseSync, who: string, id: string) {
  return (await json(await get(as(raw, who), `/api/marketplace/requests/${id}/offers`))).offers as Json[];
}

const png = () => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
};
const upload = (raw: DatabaseSync, bucket: MemoryBucket, id: string, name = 'photo.png', bytes = png()) => {
  const form = new FormData();
  form.append('file', new File([bytes as unknown as BlobPart], name));
  return as(raw, 'buyer', bucket).request(`/api/marketplace/requests/${id}/files`, { method: 'POST', body: form });
};

// ----------------------------------------------------------- 1. draft → published

test('a draft is invisible: not on the board, not readable, not offerable, not matched, its files and offers not served', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const id = await newDraft(raw);
  assert.equal((await upload(raw, bucket, id)).status, 201);
  const fileId = row<{ id: string }>(raw, 'SELECT id FROM community_request_files WHERE request_id = ?', id)!.id;

  const board = await json(await get(as(raw, 'owner'), '/api/marketplace/requests'));
  assert.ok(!(board.requests as Array<{ id: string }>).some((r) => r.id === id));
  for (const path of [
    `/api/marketplace/requests/${id}`,
    `/api/marketplace/print/requests/${id}`,
    `/api/marketplace/print/requests/${id}/revisions`,
    `/api/marketplace/print/requests/${id}/draft`,
    `/api/marketplace/requests/${id}/offers`,
  ]) {
    assert.equal((await get(as(raw, 'owner'), path)).status, 404, path);
  }
  assert.equal((await get(as(raw, 'owner', bucket), `/api/marketplace/requests/${id}/files/${fileId}`)).status, 404);
  const mint = await post(as(raw, 'owner', bucket), `/api/marketplace/print/requests/${id}/files/${fileId}/viewer-token`);
  assert.ok([403, 404].includes(mint.status), String(mint.status));
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 1000 })).status, 404);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_matches WHERE request_id = ?', id), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_revisions WHERE request_id = ?', id), 0, 'nobody priced a draft');
  // Its customer sees all of it.
  assert.equal((await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`)).status, 200);
  assert.equal((await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}/offers`)).status, 200);
});

test('«احفظ كمسودة» keeps the wizard\'s answers on the draft, pushes its abandon clock, and is refused once published', async () => {
  const raw = seed();
  const id = await newDraft(raw);
  raw.exec(`UPDATE community_requests SET expires_at = '2026-01-01T00:00:00.000Z' WHERE id = '${id}'`);
  const saved = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, {
    source_type: 'description', process: 'unsure', material_id: 'unsure', quantity: 3,
    customer_notes: 'Matte finish please', deadline: '2099-01-01', stated_dimensions_mm: { x: 40, y: 30, z: 20 },
    governorate: 'basra', budget_iqd: 25000,
  });
  assert.equal(saved.status, 400, 'a deadline more than a year ahead is not a date the wizard offers');
  assert.equal((await json(saved)).code, 'DEADLINE_INVALID');

  const today = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const ok = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, {
    source_type: 'description', process: 'unsure', material_id: 'unsure', quantity: 3,
    customer_notes: 'Matte finish please', deadline: today, stated_dimensions_mm: { x: 40, y: 30, z: 20 },
    governorate: 'basra', budget_iqd: 25000,
  });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  const draft = (await json(ok)).draft;
  assert.equal(draft.state, 'draft');
  assert.equal(draft.quantity, 3);
  assert.equal(draft.customer_notes, 'Matte finish please');
  assert.equal(draft.deadline, today);
  assert.equal(draft.print.process, 'unsure');
  assert.equal(draft.print.material_id, 'unsure');
  assert.deepEqual(draft.print.stated_dimensions_mm, { x: 40, y: 30, z: 20 });
  const r = row<{ state: string; expires_at: string }>(raw, 'SELECT state, expires_at FROM community_requests WHERE id = ?', id)!;
  assert.equal(r.state, 'draft', 'saving publishes nothing');
  assert.ok(Date.parse(r.expires_at) > Date.now() + 13 * 86_400_000, 'a draft being worked on is not abandoned');

  const bad = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, { stated_dimensions_mm: { x: 0, y: 1, z: 1 } });
  assert.equal((await json(bad)).code, 'DIMENSIONS_INVALID');
  assert.equal((await get(as(raw, 'stranger'), `/api/marketplace/print/requests/${id}/draft`)).status, 404);

  assert.equal((await publish(raw, id, {})).status, 200, 'a saved draft publishes as stored');
  const late = await put(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}/draft`, { quantity: 9 });
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'REQUEST_NOT_DRAFT');
});

test('publish runs the matching ONCE: the first publish matches and records revision 1; an unchanged re-publish re-matches nobody', async () => {
  const raw = seed();
  const id = await newDraft(raw);
  const first = await publish(raw, id);
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  assert.ok(first.body.matching.notified >= 1);
  const r = row<{ state: string; published_at: string | null; revision: number }>(raw, 'SELECT state, published_at, revision FROM community_requests WHERE id = ?', id)!;
  assert.equal(r.state, 'open');
  assert.ok(r.published_at);
  const rev = row<{ revision: number; reason: string; hash: string }>(raw, 'SELECT revision, reason, hash FROM community_request_revisions WHERE request_id = ?', id)!;
  assert.deepEqual([rev.revision, rev.reason], [1, 'publish']);
  assert.match(rev.hash, /^[0-9a-f]{64}$/);

  const matches = count(raw, 'SELECT COUNT(*) AS n FROM community_request_matches WHERE request_id = ?', id);
  const notes = count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'matching_request'");
  const audits = count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'print.request_published'");
  const again = await publish(raw, id);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.deepEqual(again.body.matching, { considered: 0, eligible: 0, notified: 0 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_matches WHERE request_id = ?', id), matches);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'matching_request'"), notes);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'print.request_published'"), audits);
});

// ----------------------------------------------------------- 3. wizard v2 inputs

test('a named source must really be there: model, link and images are checked at publish, description-only is fine', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ source_type: 'model' }, 'SOURCE_FILE_REQUIRED'],
    [{ source_type: 'link' }, 'SOURCE_LINK_REQUIRED'],
    [{ source_type: 'images' }, 'SOURCE_IMAGES_REQUIRED'],
  ];
  for (const [extra, code] of cases) {
    const id = await newDraft(raw);
    const res = await publish(raw, id, { ...PLA, ...extra });
    assert.equal(res.status, 400, code);
    assert.equal(res.body.code, code);
    assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', id)?.state, 'draft');
  }
  const withImage = await newDraft(raw);
  assert.equal((await upload(raw, bucket, withImage)).status, 201);
  assert.equal((await publish(raw, withImage, { ...PLA, source_type: 'images' })).status, 200);
  const described = await newDraft(raw);
  assert.equal((await publish(raw, described, { ...PLA, source_type: 'description' })).status, 200);
  const factsRes = await get(as(raw, 'owner'), `/api/marketplace/print/requests/${described}`);
  const facts = await json(factsRes);
  assert.equal(factsRes.status, 200, JSON.stringify(facts));
  assert.equal(facts.print.source_type, 'description');
});

test('«لست متأكدًا»: no PLA is assumed — the flags are stored, the estimate is a range or nothing, and an unsure process reaches FDM AND resin shops', async () => {
  const raw = seed();
  const id = await newDraft(raw, { customer_notes: 'Any strong material is fine' });
  const pub = await publish(raw, id, {
    source_type: 'description', process: 'unsure', material_id: 'unsure', quantity: 2,
    stated_dimensions_mm: { x: 50, y: 40, z: 30 }, deadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const p = row<{ process_unsure: number; material_unsure: number; material_id: string; stated_dims: string }>(raw,
    'SELECT process_unsure, material_unsure, material_id, stated_dims FROM community_print_requests WHERE request_id = ?', id)!;
  assert.deepEqual([p.process_unsure, p.material_unsure, p.material_id], [1, 1, '']);
  assert.deepEqual(JSON.parse(p.stated_dims), { x: 50, y: 40, z: 30 });
  assert.equal(row<{ material: string }>(raw, 'SELECT material FROM community_requests WHERE id = ?', id)?.material, '', 'no material is written on the board card');
  assert.ok(pub.body.quote.priced === false || pub.body.quote.range_basis === 'materials', JSON.stringify(pub.body.quote));
  // Both the FDM shop and the resin-only shop were matched and told.
  const told = all<{ user_id: string }>(raw, "SELECT user_id FROM user_notifications WHERE kind = 'matching_request' AND entity_id = ?", id).map((r) => r.user_id).sort();
  assert.deepEqual(told, ['owner', 'owner2']);
  // The stated size is what the board shows and what the matcher measured against.
  assert.equal(row<{ dimensions: string }>(raw, 'SELECT dimensions FROM community_requests WHERE id = ?', id)?.dimensions, '50×40×30 mm');
  const detail = await json(await get(as(raw, 'owner'), `/api/marketplace/requests/${id}`));
  assert.equal(detail.request.customer_notes, 'Any strong material is fine', 'the notes for merchants are shown to them');
  assert.equal(detail.request.notes, undefined, 'the private notes column never is');
});

test('the estimate endpoint prices an unsure material as a range across the catalogue, never as PLA', async () => {
  const raw = seed();
  const res = await post(as(raw, 'buyer'), '/api/marketplace/print/quote', {
    process: 'fdm', material_id: 'unsure', quality: 'standard', volume_cm3: 20,
  });
  const q = (await json(res)).quote;
  assert.equal(q.material_id, '');
  if (q.priced) {
    assert.equal(q.range_basis, 'materials');
    assert.ok(q.price_high_iqd >= q.price_low_iqd);
    assert.equal(q.confidence, 'low');
  }
});

// ----------------------------------------------------------- 2. revisions

test('a change nobody priced rewrites the current revision in place; after the first offer it makes a new one and supersedes the offer', async () => {
  const raw = seed();
  const id = await newPublished(raw);
  const h1 = row<{ hash: string }>(raw, 'SELECT hash FROM community_request_revisions WHERE request_id = ? AND revision = 1', id)!.hash;

  // No offers yet: quantity 1 → 2 rewrites revision 1.
  const edit = await publish(raw, id, { ...PLA, quantity: 2 });
  assert.equal(edit.body.revised, false);
  assert.equal(edit.body.revision, 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_request_revisions WHERE request_id = ?', id), 1);
  assert.notEqual(row<{ hash: string }>(raw, 'SELECT hash FROM community_request_revisions WHERE request_id = ? AND revision = 1', id)!.hash, h1);

  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000, delivery_method: 'pickup' })).status, 201);
  const offerId = row<{ id: string }>(raw, 'SELECT id FROM community_offers WHERE request_id = ?', id)!.id;

  // A material change after the first offer.
  const change = await publish(raw, id, { ...PLA, quantity: 2, material_id: 'petg' });
  assert.equal(change.status, 200);
  assert.equal(change.body.revised, true);
  assert.equal(change.body.revision, 2);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', offerId)?.state, 'superseded');
  assert.equal(row<{ offer_count: number }>(raw, 'SELECT offer_count FROM community_requests WHERE id = ?', id)?.offer_count, 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'offer_stale' AND user_id = 'owner' AND entity_id = ?", offerId), 1);

  // The merchant can read what changed before re-pricing.
  const revs = await json(await get(as(raw, 'owner'), `/api/marketplace/print/requests/${id}/revisions`));
  assert.equal(revs.current, 2);
  assert.deepEqual(revs.revisions.map((r: { revision: number }) => r.revision), [1, 2]);
  assert.ok(revs.revisions[1].changes.includes('material_id'), JSON.stringify(revs.revisions[1].changes));

  // The merchant re-confirms: pending again, pricing revision 2.
  const re = await post(as(raw, 'owner'), `/api/marketplace/offers/${offerId}/reconfirm`);
  assert.equal(re.status, 200);
  const o = row<{ state: string; request_revision: number; revision: number }>(raw, 'SELECT state, request_revision, revision FROM community_offers WHERE id = ?', offerId)!;
  assert.deepEqual([o.state, o.request_revision, o.revision], ['pending', 2, 2]);
});

test('an attachment added under a standing offer is a new revision with the file in its snapshot; the offer is superseded', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const id = await newPublished(raw);
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000 })).status, 201);
  assert.equal((await upload(raw, bucket, id)).status, 201);
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_requests WHERE id = ?', id)?.revision, 2);
  const snap = row<{ files: string; reason: string }>(raw, 'SELECT files, reason FROM community_request_revisions WHERE request_id = ? AND revision = 2', id)!;
  assert.equal(snap.reason, 'files');
  assert.equal(JSON.parse(snap.files).length, 1);
  const seen = await offersAs(raw, 'buyer', id);
  assert.equal(seen[0].state, 'superseded');
  assert.equal(seen[0].stale, true);
});

// ----------------------------------------------------------- 5. offers v2 · accept

test('offers v2: the delivery method is from the list, materials are from the catalogue, validity is days', async () => {
  const raw = seed();
  const id = await newPublished(raw);
  const bad = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 5000, delivery_method: 'teleport' });
  assert.equal((await json(bad)).code, 'OFFER_DELIVERY_INVALID');
  const badMat = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 5000, material_ids: ['unobtanium'] });
  assert.equal((await json(badMat)).code, 'OFFER_MATERIAL_INVALID');
  const tooLong = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 5000, valid_days: 400 });
  assert.equal(tooLong.status, 400);

  const t0 = Date.now();
  const ok = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
    price_iqd: 30_000, completion_days: 4, delivery_method: 'merchant_delivery', material_ids: ['pla', 'petg'],
    included: 'Sanding and a primer coat', warranty_terms: 'Reprint if it cracks within 30 days', valid_days: 7,
    message: 'Can start tomorrow',
  });
  assert.equal(ok.status, 201, JSON.stringify(await json(ok.clone())));
  const offer = (await json(ok)).offer;
  assert.deepEqual(offer.material_ids, ['pla', 'petg']);
  assert.equal(offer.delivery_method, 'merchant_delivery');
  assert.ok(Date.parse(offer.expires_at) >= t0 + 7 * 86_400_000 - 5000);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offer_revisions WHERE offer_id = ?', offer.id), 1);
});

test('an edit is a new offer revision the customer sees with its history and is told about; accepting the old one is refused (bait-and-switch)', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const id = await newPublished(raw);
  const made = (await json(await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 50_000, delivery_method: 'pickup' }))).offer;
  const seenBefore = (await offersAs(raw, 'buyer', id))[0];

  const edited = await patch(as(raw, 'owner'), `/api/marketplace/offers/${made.id}`, { price_iqd: 95_000, completion_days: 3 });
  assert.equal(edited.status, 200);
  const now = (await offersAs(raw, 'buyer', id))[0];
  assert.equal(now.revision, 2);
  assert.deepEqual(now.history.map((h: { price_iqd: number }) => h.price_iqd), [50_000, 95_000]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'buyer' AND event_key = ?", `offer_updated:${made.id}:2`), 1);

  const stale = await post(as(raw, 'buyer'), `/api/marketplace/offers/${made.id}/accept`, {
    expected_price_iqd: seenBefore.price_iqd, offer_revision: seenBefore.revision,
  });
  assert.equal(stale.status, 409);
  const body = await json(stale);
  assert.equal(body.code, 'OFFER_CHANGED');
  assert.equal(body.details.offer.price_iqd, 95_000, 'the refusal hands back the terms now on offer');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0, 'the reservation came back');

  const fine = await post(as(raw, 'buyer'), `/api/marketplace/offers/${made.id}/accept`, { expected_price_iqd: 95_000, offer_revision: 2 });
  assert.equal(fine.status, 201);
  assert.equal((await json(fine)).order.price_iqd, 95_000);
});

test('a superseded offer cannot be accepted — OFFER_STALE — until its merchant re-confirms or edits it', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const id = await newPublished(raw);
  const made = (await json(await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 40_000 }))).offer;
  assert.equal((await publish(raw, id, { ...PLA, quantity: 5 })).body.revised, true);
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${made.id}/accept`, { expected_price_iqd: 40_000, offer_revision: 1 });
  assert.equal(acc.status, 409);
  assert.equal((await json(acc)).code, 'OFFER_STALE');
  // An edit re-prices for the job as it is now and re-opens it.
  const ed = await patch(as(raw, 'owner'), `/api/marketplace/offers/${made.id}`, { price_iqd: 160_000 });
  assert.equal(ed.status, 200);
  const o = (await json(ed)).offer;
  assert.deepEqual([o.state, o.request_revision, o.stale], ['pending', 2, false]);
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/offers/${made.id}/accept`, { expected_price_iqd: 160_000, offer_revision: o.revision })).status, 201);
});

/** Since W5-B an offer needs a workshop that can make the job: Omar gets an FDM machine for the PLA jobs below. */
const omarPrintsFdm = (raw: DatabaseSync) =>
  raw.exec(`INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
            VALUES ('p3','m2','s2','FDM too','fdm',256,256,256,'[]','fine')`);

test('withdraw and decline: a merchant withdraws a superseded offer; the customer declines one and its merchant is told', async () => {
  const raw = seed();
  omarPrintsFdm(raw);
  const id = await newPublished(raw);
  const a = (await json(await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 40_000 }))).offer;
  const b = (await json(await post(as(raw, 'owner2'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 45_000 }))).offer;
  await publish(raw, id, { ...PLA, quantity: 3 });
  assert.equal((await post(as(raw, 'owner'), `/api/marketplace/offers/${a.id}/withdraw`)).status, 200);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', a.id)?.state, 'withdrawn');

  assert.equal((await post(as(raw, 'stranger'), `/api/marketplace/offers/${b.id}/decline`)).status, 404, 'only the customer declines');
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/offers/${b.id}/decline`)).status, 200);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', b.id)?.state, 'rejected');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'owner2' AND kind = 'offer_rejected' AND entity_id = ?", b.id), 1);
  assert.equal((await json(await post(as(raw, 'buyer'), `/api/marketplace/offers/${b.id}/decline`))).code, 'OFFER_NOT_AVAILABLE');
});

// ----------------------------------------------------------- 6. contact reveal

test('contact is revealed by acceptance and not before: the order carries the accepted revision, the merchant gets the delivery contact, the customer the merchant\'s', async () => {
  const raw = seed();
  omarPrintsFdm(raw);
  fund(raw, 'buyer', 500_000);
  const id = await newPublished(raw);
  const a = (await json(await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 40_000, delivery_method: 'merchant_delivery' }))).offer;
  const b = (await json(await post(as(raw, 'owner2'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 41_000 }))).offer;

  // Before acceptance nothing of the customer reaches a merchant.
  const before = JSON.stringify([await offersAs(raw, 'owner', id), await json(await get(as(raw, 'owner'), `/api/marketplace/requests/${id}`)),
    await json(await get(as(raw, 'owner'), `/api/marketplace/print/requests/${id}`))]);
  for (const secret of ['+9647700000009', 'Street 12', '+9647700000001', 's@x.co']) assert.ok(!before.includes(secret), secret);

  const other = await post(as(raw, 'buyer'), `/api/marketplace/offers/${a.id}/accept`, { expected_price_iqd: 40_000, offer_revision: 1, address_id: 'not-mine' });
  assert.equal((await json(other)).code, 'ADDRESS_NOT_FOUND');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);

  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${a.id}/accept`, { expected_price_iqd: 40_000, offer_revision: 1, address_id: 'a1' });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const orderId = (await json(acc)).order.id as string;
  const o = row<{ request_revision: number; request_snapshot: string }>(raw, 'SELECT request_revision, request_snapshot FROM community_orders WHERE id = ?', orderId)!;
  assert.equal(o.request_revision, 1);
  const snap = JSON.parse(o.request_snapshot);
  assert.equal(snap.revision, 1);
  assert.equal(snap.spec.material_id, 'pla');
  assert.match(snap.hash, /^[0-9a-f]{64}$/);

  const asMerchant = await json(await get(as(raw, 'owner'), `/api/marketplace/orders/${orderId}`));
  assert.equal(asMerchant.contact.phone, '+9647700000009');
  assert.equal(asMerchant.contact.address, 'Street 12, house 4');
  assert.equal(asMerchant.contact.governorate, 'baghdad');
  assert.equal(asMerchant.order.contact_snapshot, undefined, 'never the raw pair');
  assert.deepEqual(asMerchant.thread, { request_id: id, merchant_id: 'm1' });
  const asCustomer = await json(await get(as(raw, 'buyer'), `/api/marketplace/orders/${orderId}`));
  // s1 publishes no contact phone: none is revealed — never the merchant
  // account's private one (review W2-5 #7).
  assert.equal(asCustomer.contact.phone, '');
  assert.equal(asCustomer.contact.store_slug, 'ali3d');
  assert.equal(asCustomer.contact.address, undefined, 'the customer is shown the merchant, not their own address');
  assert.equal((await get(as(raw, 'owner2'), `/api/marketplace/orders/${orderId}`)).status, 404, 'the losing merchant sees no order');
  // …and was told they were not chosen.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'owner2' AND kind = 'offer_rejected' AND entity_id = ?", b.id), 1);
});

test('a pickup job hands the merchant a name and a phone, never an address', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const id = await newPublished(raw);
  const a = (await json(await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 10_000, delivery_method: 'pickup' }))).offer;
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${a.id}/accept`, { expected_price_iqd: 10_000, offer_revision: 1 });
  const orderId = (await json(acc)).order.id as string;
  const c = (await json(await get(as(raw, 'owner'), `/api/marketplace/orders/${orderId}`))).contact;
  assert.equal(c.phone, '+9647700000009');
  assert.equal(c.address, '');
  assert.equal(c.landmark, '');
});

// ----------------------------------------------------------- 4. expiry

test('expiry: an offer past its validity cannot be accepted, an expired request takes none, and abandoned drafts expire in the sweep', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const id = await newPublished(raw);
  const a = (await json(await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 10_000, valid_days: 1 }))).offer;
  raw.exec(`UPDATE community_offers SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = '${a.id}'`);
  const shown = (await offersAs(raw, 'buyer', id))[0];
  assert.equal(shown.expired, true, 'shown as expired before the sweep writes it');
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${a.id}/accept`, { expected_price_iqd: 10_000, offer_revision: 1 });
  assert.equal((await json(acc)).code, 'OFFER_EXPIRED');

  const abandoned = await newDraft(raw);
  const fresh = await newDraft(raw);
  raw.exec(`UPDATE community_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id IN ('${abandoned}','${id}')`);
  const report = await runCommunitySweeps({ DB: asD1(raw) } as never, new Date().toISOString());
  assert.equal(report.expired_drafts, 1, JSON.stringify(report));
  assert.equal(report.expired_requests, 1);
  assert.equal(report.expired_offers >= 0, true);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', abandoned)?.state, 'expired');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_requests WHERE id = ?', fresh)?.state, 'draft');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', a.id)?.state, 'expired');
  const pub = await publish(raw, abandoned);
  assert.equal(pub.status, 409, 'an expired draft is not published');
  const again = await runCommunitySweeps({ DB: asD1(raw) } as never, new Date().toISOString());
  assert.equal(again.expired_drafts, 0);
});

test('the merchant\'s own offers list is theirs alone, with its request, and pages by cursor', async () => {
  const raw = seed();
  const ids = [await newPublished(raw), await newPublished(raw), await newPublished(raw)];
  for (const id of ids) await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 10_000 });
  await post(as(raw, 'owner2'), `/api/marketplace/requests/${ids[0]}/offers`, { price_iqd: 12_000 });
  const page1 = await json(await get(as(raw, 'owner'), '/api/marketplace/my-offers?limit=2'));
  assert.equal(page1.offers.length, 2);
  assert.ok(page1.next_cursor);
  const page2 = await json(await get(as(raw, 'owner'), `/api/marketplace/my-offers?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`));
  assert.equal(page2.offers.length, 1);
  const all3 = [...page1.offers, ...page2.offers];
  assert.ok(all3.every((o: { merchant_id: string }) => o.merchant_id === 'm1'));
  assert.deepEqual(new Set(all3.map((o: { request: { id: string } }) => o.request.id)), new Set(ids));
  assert.deepEqual((await json(await get(as(raw, 'buyer'), '/api/marketplace/my-offers'))).offers, []);
});

// ----------------------------------------------------------- backward compatibility

test('backward compatibility: an open request from before 0130 (no print row, no revision row) still takes and accepts offers, snapshotting the job as it stands', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at)
      VALUES ('old','buyer','Old bracket','Made before v2','open','open','public',0,'2099-01-01T00:00:00.000Z');
    DELETE FROM community_request_revisions WHERE request_id = 'old';
  `);
  const made = await post(as(raw, 'owner'), '/api/marketplace/requests/old/offers', { price_iqd: 20_000 });
  assert.equal(made.status, 201);
  const o = (await json(made)).offer;
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${o.id}/accept`, { expected_price_iqd: 20_000, offer_revision: 1 });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const snap = JSON.parse(row<{ request_snapshot: string }>(raw, "SELECT request_snapshot FROM community_orders WHERE request_id = 'old'")!.request_snapshot);
  assert.equal(snap.source, 'live');
  assert.equal(snap.spec.title, 'Old bracket');
});

test('migration 0130 backfills the current revision of every published request (not drafts) and every offer\'s current terms', () => {
  const raw = dbThrough('0129');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u','U','u@x.co','h','customer'), ('mu','M','m@x.co','h','customer');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m','mu','M');
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,revision)
      VALUES ('pub','u','Pub','Published one','receiving_offers','open','public',3),
             ('dr','u','Draft','A draft one','draft','closed','public',1);
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd,state,revision,request_revision)
      VALUES ('o','pub','m',5000,'pending',2,3);
  `);
  raw.exec(readFileSync(join(ROOT, 'migrations', '0130_request_revisions_offers_v2.sql'), 'utf8'));
  assert.deepEqual(all(raw, 'SELECT request_id, revision, reason FROM community_request_revisions').map((r) => ({ ...r })), [
    { request_id: 'pub', revision: 3, reason: 'backfill' },
  ]);
  assert.deepEqual({ ...row<Record<string, unknown>>(raw, 'SELECT offer_id, revision, request_revision, price_iqd FROM community_offer_revisions')! }, {
    offer_id: 'o', revision: 2, request_revision: 3, price_iqd: 5000,
  });
});
