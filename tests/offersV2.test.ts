/**
 * OFFERS V2, WORKSHOP FACTS AND MATCHING — Phase 5a of
 * docs/COMMUNITY_ECOSYSTEM.md §9.5, against the real routes and migrations
 * (0159 included) through the D1 adapter and an in-memory R2.
 *
 * What is pinned here: a draft is invisible to the customer and blocks
 * nobody — not another merchant's live offer, not the same merchant's later
 * send; the delivery fee is in the escrow gross and in the order snapshot;
 * `expected_total_iqd` is the contract (a price alone on a fee offer is
 * OFFER_CHANGED); a request revised after the offer is OFFER_STALE; a board
 * acceptance writes `chat_id` and posts the system card; a file key never
 * reaches the customer and a key that is not the merchant's own is refused;
 * a shorter turnaround ranks first among the eligible; `?for=me` shows only
 * the rows the engine marked eligible for THAT workshop; the workshop's
 * turnaround and intro are validated, stored and shown on the store page.
 *
 * Run: node --import tsx --test tests/offersV2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import {
  freshDb, asD1, stubApp, post, patch, put, get, json, count, row, all, pending, memoryBucket,
  type App, type Mount, type StubUser,
} from './fixtures/app';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { communityRoutes } from '../worker/routes/community';
import { merchantPrinterRoutes } from '../worker/routes/merchantPrinters';
import { HttpError } from '../worker/lib/http';
import { assertUploadEntity, placementFor, purposeAdmits, quotaBytesFor } from '../worker/lib/uploadEntity';
import { DEFAULT_MATCH_WEIGHTS, rankScore, turnaroundFraction, type RankSignals } from '../worker/lib/printMatchingScore';
import { EMPTY_PREFS, type CapabilityPrinter, type EligibilityRequest } from '../worker/lib/eligibility';
import { offerStateLabel } from '../src/components/community/offers/types';
import { wavesD1 } from './fixtures/wavesD1';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/merchant', merchantPrinterRoutes);
};

const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ALI: StubUser = { id: 'owner', role: 'customer', email: 'owner@x.co' };
const OMAR: StubUser = { id: 'owner2', role: 'customer', email: 'owner2@x.co' };
const NOUR: StubUser = { id: 'stranger', role: 'customer', email: 'stranger@x.co' };

/** Ali's own private uploads for an offer (purpose `offer`), Omar's, and a PUBLIC one of Ali's. */
const K_PDF = 'merchants/owner/offers/quote1.pdf';
const K_PNG = 'merchants/owner/offers/sample1.png';
const K_OMAR = 'merchants/owner2/offers/quote2.pdf';
const K_PUBLIC = 'merchants/owner/public/pic.webp';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 offer quote');

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('owner','Ali','owner@x.co','h','customer'),
      ('owner2','Omar','owner2@x.co','h','customer'), ('stranger','Nour','stranger@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','omar3d','Omar 3D');
    -- Since W5-B an offer needs a workshop that can make the job.
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials) VALUES
      ('p1','m1','s1','P1S','fdm',256,256,250,'["pla","petg"]'), ('p2','m2','s2','Ender','fdm',220,220,250,'["pla"]');
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at) VALUES
      ('r1','buyer','Print a bracket','I need a bracket printed','receiving_offers','open','public',0,'${FUTURE}');
    INSERT INTO file_objects (object_key,visibility,domain,owner_id,entity_id,mime_type,byte_size,original_name,purpose) VALUES
      ('${K_PDF}','private','merchants','owner','r1','application/pdf',${PDF_BYTES.length},'quote.pdf','offer'),
      ('${K_PNG}','private','merchants','owner','r1','image/png',120,'sample.png','offer'),
      ('${K_OMAR}','private','merchants','owner2','r1','application/pdf',15,'omar.pdf','offer'),
      ('${K_PUBLIC}','public','merchants','owner','','image/webp',15,'pic.webp','community');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const bucketFor = () => {
  const bucket = memoryBucket();
  void bucket.put(K_PDF, PDF_BYTES, { httpMetadata: { contentType: 'application/pdf' } });
  void bucket.put(K_PNG, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { httpMetadata: { contentType: 'image/png' } });
  return bucket;
};

const as = (raw: DatabaseSync, user: StubUser | null, bucket = bucketFor()): App =>
  stubApp(asD1(raw), user, mount, { env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket } });

const fund = (raw: DatabaseSync, user: string, iqd: number) =>
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_${Math.random().toString(36).slice(2)}','${user}','deposit','USD',${Math.ceil((iqd * 100) / RATE)},'approved','test funding')`);

const settle = () => Promise.allSettled(pending.splice(0));

async function offerBy(raw: DatabaseSync, who: StubUser, body: Record<string, unknown>) {
  const res = await post(as(raw, who), '/api/marketplace/requests/r1/offers', body);
  const data = await json(res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, data, offer: data.offer as Record<string, any> };
}

// ------------------------------------------------------------------ drafts

test('a draft is invisible to the customer, blocks nobody, and its send is the same fenced offer with its files', async () => {
  const raw = seed();
  const draft = await offerBy(raw, ALI, { draft: true, price_iqd: 50_000, delivery_fee_iqd: 5_000, color: 'black', terms: 'Half up front', files: [{ key: K_PDF }], valid_days: 10 });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal(draft.offer.draft, true);
  assert.equal(draft.offer.state, 'draft');
  assert.equal(draft.offer.total_iqd, 55_000, 'the total is computed on the server');
  assert.equal(draft.offer.files[0].key, K_PDF, 'the author sees their own keys, to send them back');
  assert.match(String(draft.offer.id), /^ofd_/);
  // Nothing of the offers table moved: no row, no count, no notice.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers'), 0);
  assert.equal(row<{ offer_count: number }>(raw, "SELECT offer_count FROM community_requests WHERE id = 'r1'")?.offer_count, 0);
  await settle();
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'buyer'"), 0);

  // The customer sees no offer and no draft.
  const seen = await json(await get(as(raw, BUYER), '/api/marketplace/requests/r1/offers'));
  assert.deepEqual(seen.offers, []);
  assert.equal(seen.draft, null);

  // Another merchant's live offer is not blocked by it; a second draft is one too many.
  const omar = await offerBy(raw, OMAR, { price_iqd: 60_000 });
  assert.equal(omar.status, 201, JSON.stringify(omar.data));
  const again = await offerBy(raw, ALI, { draft: true, price_iqd: 1 });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'OFFER_DRAFT_EXISTS');
  assert.equal(again.data.details.draft_id, draft.offer.id);

  // The merchant finds their draft beside the offers they may see (their own: none yet).
  const mine = await json(await get(as(raw, ALI), '/api/marketplace/requests/r1/offers'));
  assert.equal(mine.draft.id, draft.offer.id);
  assert.deepEqual(mine.offers, [], 'a rival\'s price is never shown');
  const list = await json(await get(as(raw, ALI), '/api/marketplace/my-offers'));
  assert.deepEqual(list.offers.map((o: Record<string, unknown>) => [o.id, o.draft, o.state]), [[draft.offer.id, true, 'draft']]);
  assert.equal(list.offers[0].request.title, 'Print a bracket');

  // An edit of the draft is in place: no revision, still invisible.
  const edited = await json(await patch(as(raw, ALI), `/api/marketplace/offers/${draft.offer.id}`, { delivery_fee_iqd: 6_000, files: [{ key: K_PDF }, { key: K_PNG }] }));
  assert.equal(edited.offer.draft, true);
  assert.equal(edited.offer.total_iqd, 56_000);
  assert.equal(edited.offer.files.length, 2);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers'), 1, 'only Omar\'s');

  // «أرسل العرض»: one batch — the fenced INSERT, the files, the draft gone.
  const sent = await post(as(raw, ALI), `/api/marketplace/offers/${draft.offer.id}/send`, {});
  assert.equal(sent.status, 201, JSON.stringify(await sent.clone().json()));
  const live = (await json(sent)).offer;
  assert.equal(live.draft, false);
  assert.equal(live.state, 'pending');
  assert.equal(live.delivery_fee_iqd, 6_000);
  assert.equal(live.total_iqd, 56_000);
  assert.equal(live.color, 'black');
  assert.equal(live.terms, 'Half up front');
  assert.equal(live.revision, 1);
  assert.equal(live.revised, false);
  assert.ok(live.valid_until && live.valid_until > new Date().toISOString(), 'validity runs from the send');
  assert.equal(live.files.length, 2);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offer_drafts'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offer_files WHERE offer_id = ?', live.id), 2);
  assert.equal(row<{ content_type: string }>(raw, 'SELECT content_type FROM community_offer_files WHERE file_key = ?', K_PDF)?.content_type, 'application/pdf');
  assert.equal(row<{ offer_count: number }>(raw, "SELECT offer_count FROM community_requests WHERE id = 'r1'")?.offer_count, 2);
  await settle();
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'buyer' AND kind = 'offer_received'"), 2, 'the customer hears of the offer only when it is sent');

  // A sent offer is not a draft; a missing one does not exist.
  const notDraft = await post(as(raw, ALI), `/api/marketplace/offers/${live.id}/send`, {});
  assert.equal(notDraft.status, 409);
  assert.equal((await json(notDraft)).code, 'OFFER_NOT_DRAFT');
  assert.equal((await post(as(raw, ALI), `/api/marketplace/offers/${draft.offer.id}/send`, {})).status, 404);
  // Both live now — the one-live-offer index still holds for a second live one.
  assert.equal((await offerBy(raw, ALI, { price_iqd: 1_000 })).data.code, 'OFFER_EXISTS');
});

test('«عروضي» (the workspace list) says a draft was never sent — not the «قائم» of a live offer (review 2026-09-30)', async () => {
  const raw = seed();
  assert.equal((await offerBy(raw, ALI, { draft: true, price_iqd: 45_000 })).status, 201);
  // Exactly the V1 list's «الكل» query.
  const list = await json(await get(as(raw, ALI), '/api/marketplace/my-offers?limit=20'));
  const first = list.offers[0];
  assert.deepEqual([first.draft, first.state, first.revision], [true, 'draft', 0]);
  const loc = (ar: string, en: string, ckb?: string) => `${ar}|${en}|${ckb ?? ''}`;
  const label = offerStateLabel(first, loc);
  assert.equal(label.text, 'مسودة — لم تُرسل|Draft — not sent|ڕەشنووس — نەنێردراوە');
  assert.equal(label.tone, 'warning');
  // A live offer still reads «قائم».
  assert.equal(offerStateLabel({ state: 'pending', stale: false, expired: false }, loc).text.split('|')[1], 'Open');
});

test('a draft on a request that closed stays a draft: OFFER_REQUEST_CLOSED', async () => {
  const raw = seed();
  const draft = await offerBy(raw, ALI, { draft: true, price_iqd: 40_000 });
  assert.equal(draft.status, 201);
  raw.exec("UPDATE community_requests SET state = 'cancelled', status = 'closed' WHERE id = 'r1'");
  const res = await post(as(raw, ALI), `/api/marketplace/offers/${draft.offer.id}/send`, {});
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'OFFER_REQUEST_CLOSED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offer_drafts'), 1, 'kept');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers'), 0);
  // The fee reader refuses what is not a whole non-negative dinar figure.
  raw.exec("UPDATE community_requests SET state = 'receiving_offers', status = 'open' WHERE id = 'r1'");
  assert.equal((await offerBy(raw, OMAR, { price_iqd: 1_000, delivery_fee_iqd: -5 })).data.code, 'OFFER_FEE_INVALID');
  assert.equal((await offerBy(raw, OMAR, { price_iqd: 1_000, delivery_fee_iqd: 12.5 })).data.code, 'OFFER_FEE_INVALID');
});

// ------------------------------------------------------- the fee, the accept

test('the fee is in the escrow gross and in the snapshot; the customer confirms the TOTAL, and a price alone on a fee offer is OFFER_CHANGED', async () => {
  const raw = seed();
  const made = await offerBy(raw, ALI, { price_iqd: 50_000, delivery_fee_iqd: 5_000, delivery_method: 'courier', quantity: 2, color: 'red' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const offerId = made.offer.id as string;
  fund(raw, 'buyer', 500_000);
  const accept = (body: Record<string, unknown>) => post(as(raw, BUYER), `/api/marketplace/offers/${offerId}/accept`, body);

  // The old client's price, on an offer WITH a fee, is not what was shown.
  const priceOnly = await accept({ expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(priceOnly.status, 409);
  const po = await json(priceOnly);
  assert.equal(po.code, 'OFFER_CHANGED');
  assert.equal(po.details.offer.total_iqd, 55_000, 'the customer is shown the total to confirm');
  // A total that is only the price is a mismatch too.
  assert.equal((await json(await accept({ expected_total_iqd: 50_000, offer_revision: 1 }))).code, 'OFFER_CHANGED');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0, 'nothing reserved on a refusal');

  const ok = await accept({ expected_total_iqd: 55_000, offer_revision: 1 });
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  const body = await json(ok);
  assert.equal(body.order.price_iqd, 55_000, 'the order\'s money identity is the gross');
  const esc = row<{ gross_iqd: number; platform_fee_iqd: number; merchant_receivable_iqd: number; state: string }>(
    raw, 'SELECT gross_iqd, platform_fee_iqd, merchant_receivable_iqd, state FROM community_escrows WHERE community_order_id = ?', body.order.id
  )!;
  assert.equal(esc.gross_iqd, 55_000, 'the escrow holds price + fee');
  assert.equal(esc.platform_fee_iqd + esc.merchant_receivable_iqd, 55_000);
  assert.equal(esc.state, 'held');
  const snap = JSON.parse(String(body.order.offer_snapshot));
  assert.equal(snap.price_iqd, 50_000);
  assert.equal(snap.delivery_fee_iqd, 5_000);
  assert.equal(snap.total_iqd, 55_000);
  assert.equal(snap.quantity, 2);
  assert.equal(snap.color, 'red');
  // The replay answers with the order, on the same total.
  const replay = await accept({ expected_total_iqd: 55_000, offer_revision: 1 });
  assert.equal(replay.status, 200);
  assert.equal((await json(replay)).replayed, true);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_orders WHERE state <> 'cancelled'"), 1);
});

test('an offer without a fee still accepts an older client\'s expected_price_iqd, for one release', async () => {
  const raw = seed();
  const made = await offerBy(raw, ALI, { price_iqd: 30_000 });
  assert.equal(made.status, 201);
  fund(raw, 'buyer', 200_000);
  const ok = await post(as(raw, BUYER), `/api/marketplace/offers/${made.offer.id}/accept`, { expected_price_iqd: 30_000, offer_revision: 1 });
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  assert.equal((await json(ok)).order.price_iqd, 30_000);
});

test('a merchant edit bumps the revision (the customer sees «revised») so the old confirmation is OFFER_CHANGED; a job revised after the offer is OFFER_STALE', async () => {
  const raw = seed();
  const made = await offerBy(raw, ALI, { price_iqd: 50_000, delivery_fee_iqd: 5_000 });
  const offerId = made.offer.id as string;
  fund(raw, 'buyer', 500_000);

  const edited = await json(await patch(as(raw, ALI), `/api/marketplace/offers/${offerId}`, { delivery_fee_iqd: 7_000 }));
  assert.equal(edited.offer.revision, 2);
  assert.equal(edited.offer.revised, true);
  assert.equal(edited.offer.total_iqd, 57_000);
  const asCustomer = await json(await get(as(raw, BUYER), '/api/marketplace/requests/r1/offers'));
  assert.equal(asCustomer.offers[0].revised, true);
  assert.equal(asCustomer.offers[0].total_iqd, 57_000);
  // «عدّل تاجر عرضه»: the customer is told, once per revision.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'buyer' AND event_key = ?", `offer_updated:${offerId}:2`), 1);

  const stale = await post(as(raw, BUYER), `/api/marketplace/offers/${offerId}/accept`, { expected_total_iqd: 57_000, offer_revision: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'OFFER_CHANGED');

  // The CUSTOMER changed the job after the offer priced it (what the request
  // revision path writes: revision + 1, the offer superseded — 0116/0130).
  raw.exec(`UPDATE community_requests SET revision = revision + 1 WHERE id = 'r1';
            UPDATE community_offers SET state = 'superseded' WHERE id = '${offerId}'`);
  const superseded = await post(as(raw, BUYER), `/api/marketplace/offers/${offerId}/accept`, { expected_total_iqd: 57_000, offer_revision: 2 });
  assert.equal(superseded.status, 409);
  assert.equal((await json(superseded)).code, 'OFFER_STALE');
  // A row still `pending` behind the revision (pre-0130) is stale the same way.
  raw.exec(`UPDATE community_offers SET state = 'pending' WHERE id = '${offerId}'`);
  const behind = await post(as(raw, BUYER), `/api/marketplace/offers/${offerId}/accept`, { expected_total_iqd: 57_000, offer_revision: 2 });
  assert.equal((await json(behind)).code, 'OFFER_STALE');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'"), 0);
});

test('what the customer is TOLD is the total: the new-offer meta and outbound line, and a fee-only edit\'s notice (review 2026-09-30)', async () => {
  const raw = seed();
  const made = await offerBy(raw, ALI, { price_iqd: 50_000, delivery_fee_iqd: 5_000 });
  const offerId = made.offer.id as string;
  await settle();
  const received = row<{ meta: string; link: string }>(
    raw, "SELECT meta, link FROM user_notifications WHERE user_id = 'buyer' AND event_key = ?", `offer_received:${offerId}`
  )!;
  const meta = JSON.parse(received.meta) as Record<string, unknown>;
  assert.deepEqual([meta.price_iqd, meta.delivery_fee_iqd, meta.total_iqd], [50_000, 5_000, 55_000], received.meta);
  assert.equal(received.link, '/requests/r1', 'the request page itself, not the board\'s redirect');
  // Only the delivery fee moves: 55,000 → 95,000. «The price is now 50,000» would quote the one number that did not.
  const edited = await json(await patch(as(raw, ALI), `/api/marketplace/offers/${offerId}`, { delivery_fee_iqd: 45_000 }));
  assert.equal(edited.offer.total_iqd, 95_000);
  const notice = row<{ body_ar: string; body_en: string; meta: string }>(
    raw, "SELECT body_ar, body_en, meta FROM user_notifications WHERE user_id = 'buyer' AND event_key = ?", `offer_updated:${offerId}:2`
  )!;
  assert.equal(notice.body_en, 'The total is now 95,000 IQD (45,000 of it delivery). Review the offer before accepting.');
  assert.equal(notice.body_ar, 'الإجمالي الآن 95,000 د.ع (منها 45,000 توصيل). راجع العرض قبل القبول.');
  const updated = JSON.parse(notice.meta) as Record<string, unknown>;
  assert.equal(updated.total_iqd, 95_000);
  assert.ok(String(updated.body_ckb).includes('95,000') && String(updated.title_ckb).length > 0, 'the Sorani is stamped, with the same figure');
});

test('a pickup carries no delivery fee: named with one it is refused (create, draft, edit, send); switching an offer to pickup zeroes the stored fee', async () => {
  const raw = seed();
  const refused = await offerBy(raw, ALI, { price_iqd: 50_000, delivery_method: 'pickup', delivery_fee_iqd: 20_000 });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.code, 'OFFER_PICKUP_FEE');
  assert.equal((await offerBy(raw, ALI, { draft: true, price_iqd: 50_000, delivery_method: 'pickup', delivery_fee_iqd: 1 })).data.code, 'OFFER_PICKUP_FEE');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offer_drafts'), 0);
  // A pickup with no fee is an ordinary offer.
  const pickup = await offerBy(raw, ALI, { price_iqd: 50_000, delivery_method: 'pickup', delivery_fee_iqd: 0 });
  assert.equal(pickup.status, 201, JSON.stringify(pickup.data));
  const offerId = pickup.offer.id as string;
  // An edit naming a fee on the (stored) pickup is refused; nothing moves.
  const feeOnPickup = await patch(as(raw, ALI), `/api/marketplace/offers/${offerId}`, { delivery_fee_iqd: 9_000 });
  assert.equal((await json(feeOnPickup)).code, 'OFFER_PICKUP_FEE');
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_offers WHERE id = ?', offerId)!.revision, 1);
  // Delivered by the merchant with a fee, then switched to pickup without naming the fee: the fee goes to zero.
  const delivered = await json(await patch(as(raw, ALI), `/api/marketplace/offers/${offerId}`, { delivery_method: 'merchant_delivery', delivery_fee_iqd: 9_000 }));
  assert.equal(delivered.offer.total_iqd, 59_000);
  const switched = await json(await patch(as(raw, ALI), `/api/marketplace/offers/${offerId}`, { delivery_method: 'pickup' }));
  assert.deepEqual([switched.offer.delivery_method, switched.offer.delivery_fee_iqd, switched.offer.total_iqd], ['pickup', 0, 50_000]);

  // A draft: switching it to pickup zeroes its fee too, so «send» never meets the pair.
  const omarDraft = await offerBy(raw, OMAR, { draft: true, price_iqd: 30_000, delivery_method: 'courier', delivery_fee_iqd: 4_000 });
  assert.equal(omarDraft.status, 201, JSON.stringify(omarDraft.data));
  const draftId = omarDraft.offer.id as string;
  const zeroed = await json(await patch(as(raw, OMAR), `/api/marketplace/offers/${draftId}`, { delivery_method: 'pickup' }));
  assert.deepEqual([zeroed.offer.draft, zeroed.offer.delivery_fee_iqd, zeroed.offer.total_iqd], [true, 0, 30_000]);
  // A payload stored before the rule (written straight to the table) is refused at send, and the draft is kept.
  raw.exec(`UPDATE community_offer_drafts SET payload_json = json_set(payload_json, '$.delivery_fee_iqd', 4000) WHERE id = '${draftId}'`);
  const send = await post(as(raw, OMAR), `/api/marketplace/offers/${draftId}/send`, {});
  assert.equal((await json(send)).code, 'OFFER_PICKUP_FEE');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offer_drafts WHERE id = ?', draftId), 1, 'the draft stays');
});

test('a BOARD acceptance opens the request thread, writes chat_id and posts «تم إنشاء الطلب» there', async () => {
  const raw = seed();
  const made = await offerBy(raw, ALI, { price_iqd: 50_000 });
  fund(raw, 'buyer', 200_000);
  const ok = await post(as(raw, BUYER), `/api/marketplace/offers/${made.offer.id}/accept`, { expected_total_iqd: 50_000, offer_revision: 1 });
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  const order = (await json(ok)).order;
  assert.ok(order.chat_id, 'the order knows its conversation');
  const thread = row<{ context_type: string; context_id: string; store_id: string; merchant_id: string }>(
    raw, 'SELECT context_type, context_id, store_id, merchant_id FROM chats WHERE id = ?', order.chat_id
  );
  assert.deepEqual(thread, { context_type: 'request', context_id: 'r1', store_id: 's1', merchant_id: 'm1' });
  assert.deepEqual(
    all<{ user_id: string }>(raw, 'SELECT user_id FROM chat_participants WHERE chat_id = ? ORDER BY user_id', order.chat_id).map((r) => r.user_id),
    ['buyer', 'owner']
  );
  const card = row<{ card_type: string; card_ref: string; is_system: number; card_event_key: string }>(
    raw, 'SELECT card_type, card_ref, is_system, card_event_key FROM chat_messages WHERE chat_id = ?', order.chat_id
  );
  assert.deepEqual(card, { card_type: 'custom_order', card_ref: order.id, is_system: 1, card_event_key: `custom_order:${order.id}:funded` });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chats'), 1, 'one thread per request × store');
});

// ------------------------------------------------------------------- files

test('files: a key that is not the merchant\'s own private offer upload is refused; the customer gets URLs and never a key; only the parties read the bytes', async () => {
  const raw = seed();
  assert.equal((await offerBy(raw, ALI, { price_iqd: 10_000, files: [{ key: K_OMAR }] })).data.code, 'OFFER_FILE_NOT_OWNED', 'somebody else\'s');
  assert.equal((await offerBy(raw, ALI, { price_iqd: 10_000, files: [{ key: K_PUBLIC }] })).data.code, 'OFFER_FILE_NOT_OWNED', 'a public object would make the door decorative');
  assert.equal((await offerBy(raw, ALI, { price_iqd: 10_000, files: [{ key: 'merchants/owner/offers/never-uploaded.pdf' }] })).data.code, 'OFFER_FILE_NOT_OWNED');
  const tooMany = await offerBy(raw, ALI, { price_iqd: 10_000, files: Array.from({ length: 7 }, () => ({ key: K_PDF })) });
  assert.equal(tooMany.data.code, 'OFFER_FILE_LIMIT');
  // THE STRICT DOOR (review 2026-09-30): a legacy private row of Ali's own (purpose '' — a
  // bank-transfer receipt), an offer upload of his filed under ANOTHER request, and an
  // `offer` row outside his `merchants/<uid>/offers/` placement are not files of THIS offer.
  raw.exec(`INSERT INTO file_objects (object_key,visibility,domain,owner_id,entity_id,mime_type,byte_size,original_name,purpose) VALUES
    ('receipts/owner/evidence/rcpt0001.jpg','private','receipts','owner','owner','image/jpeg',10,'bank-transfer.jpg',''),
    ('merchants/owner/offers/forr2file.pdf','private','merchants','owner','r2','application/pdf',10,'for-r2.pdf','offer'),
    ('chat/chat_x/attachments/chatpic01.jpg','private','chat','owner','r1','image/jpeg',10,'chat.jpg','offer')`);
  for (const key of ['receipts/owner/evidence/rcpt0001.jpg', 'merchants/owner/offers/forr2file.pdf', 'chat/chat_x/attachments/chatpic01.jpg']) {
    assert.equal((await offerBy(raw, ALI, { price_iqd: 10_000, files: [{ key }] })).data.code, 'OFFER_FILE_NOT_OWNED', key);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers'), 0);

  const made = await offerBy(raw, ALI, { price_iqd: 10_000, files: [{ key: K_PDF }, { key: K_PNG }] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const offerId = made.offer.id as string;
  assert.equal(made.offer.files.length, 2);
  assert.equal(made.offer.files[0].key, K_PDF, 'the uploader keeps their keys');

  const res = await get(as(raw, BUYER), '/api/marketplace/requests/r1/offers');
  const text = await res.text();
  assert.ok(!text.includes('merchants/owner/offers'), 'no key reaches the customer');
  const seen = JSON.parse(text);
  const files = seen.offers[0].files as Array<Record<string, unknown>>;
  assert.equal(files.length, 2);
  assert.equal(files[0].key, undefined);
  assert.equal(files[0].kind, 'pdf');
  assert.equal(files[1].kind, 'image');
  assert.equal(files[0].url, `/api/marketplace/offers/${offerId}/files/${files[0].id}`);

  // The bytes: the customer and the merchant may read; a stranger and a rival workshop are told there is no such file.
  const bucket = bucketFor();
  const asBuyer = await get(as(raw, BUYER, bucket), String(files[0].url));
  assert.equal(asBuyer.status, 200);
  assert.equal(asBuyer.headers.get('content-type'), 'application/pdf');
  assert.match(asBuyer.headers.get('content-disposition') ?? '', /^attachment/);
  assert.equal(asBuyer.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(new TextDecoder().decode(await asBuyer.arrayBuffer()), '%PDF-1.4 offer quote');
  const picture = await get(as(raw, BUYER, bucket), String(files[1].url));
  assert.match(picture.headers.get('content-disposition') ?? '', /^inline/);
  assert.equal((await get(as(raw, ALI, bucket), String(files[0].url))).status, 200);
  assert.equal((await get(as(raw, NOUR, bucket), String(files[0].url))).status, 404);
  await offerBy(raw, OMAR, { price_iqd: 20_000 });
  assert.equal((await get(as(raw, OMAR, bucket), String(files[0].url))).status, 404, 'a rival with an offer of their own still cannot see Ali\'s files');
  assert.equal((await get(as(raw, null, bucket), String(files[0].url))).status, 401);

  // An edit replaces the set; a key that is not owned is refused before anything moves.
  assert.equal((await json(await patch(as(raw, ALI), `/api/marketplace/offers/${offerId}`, { files: [{ key: K_OMAR }] }))).code, 'OFFER_FILE_NOT_OWNED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offer_files WHERE offer_id = ?', offerId), 2);
  const replaced = await json(await patch(as(raw, ALI), `/api/marketplace/offers/${offerId}`, { files: [{ key: K_PNG }] }));
  assert.deepEqual(replaced.offer.files.map((f: Record<string, unknown>) => f.key), [K_PNG]);
  assert.equal(replaced.offer.revision, 2, 'a new file set is a new promise');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offer_files WHERE offer_id = ?', offerId), 1);
});

test('the offer upload door: an eligible workshop files under the request; anybody else is told it does not exist', async () => {
  const raw = seed();
  const db = asD1(raw);
  assert.equal(await assertUploadEntity(db, { id: 'owner', role: 'customer' }, 'offer', 'r1'), 'r1', 'the live verdict is eligible');
  for (const [who, why] of [['stranger', 'no store'], ['buyer', 'the request\'s own customer']] as const) {
    await assert.rejects(assertUploadEntity(db, { id: who, role: 'customer' }, 'offer', 'r1'), (e: unknown) => e instanceof HttpError && e.status === 404, why);
  }
  await assert.rejects(assertUploadEntity(db, { id: 'owner', role: 'customer' }, 'offer', 'r_missing'), (e: unknown) => e instanceof HttpError && e.status === 404);
  // A request off the board is closed to a workshop that has nothing on it — and open to the author of a draft.
  const draft = await offerBy(raw, ALI, { draft: true, price_iqd: 1_000 });
  assert.equal(draft.status, 201);
  raw.exec("UPDATE community_requests SET state = 'in_progress', status = 'closed' WHERE id = 'r1'");
  assert.equal(await assertUploadEntity(db, { id: 'owner', role: 'customer' }, 'offer', 'r1'), 'r1', 'the author of a draft');
  await assert.rejects(assertUploadEntity(db, { id: 'owner2', role: 'customer' }, 'offer', 'r1'), (e: unknown) => e instanceof HttpError && e.status === 404);
  // Where it lands, what it admits, what bounds it.
  assert.deepEqual(placementFor('offer', 'document', { userId: 'owner', entityId: 'r1', mime: 'application/pdf' }), {
    visibility: 'private', domain: 'merchants', entityId: 'owner', kind: 'offers',
  });
  assert.equal(purposeAdmits('offer', 'video'), false);
  assert.equal(purposeAdmits('offer', 'model'), true);
  const quotas = { post_gb: 2, product_file_gb: 5, request_gb: 1 };
  assert.equal(quotaBytesFor(quotas, 'offer'), quotaBytesFor(quotas, 'request'), 'bounded like request files');
});

// ---------------------------------------------------------------- ranking

test('a shorter stated turnaround ranks first among the eligible, an unstated one sits mid-table, and eligibility is untouched', () => {
  const req: EligibilityRequest = {
    id: 'r', customer_id: 'c', revision: 1, on_board: true, process: 'fdm', material_id: 'pla', color_hex: '', quality: 'standard',
    colors_count: 1, dims_mm: { x: 60, y: 60, z: 40 }, grams: null, governorate: 'baghdad', delivery_pref: '', estimate_iqd: null, quantity: 1,
  };
  const printer: CapabilityPrinter = {
    id: 'p', technology: 'fdm', build_x_mm: 256, build_y_mm: 256, build_z_mm: 250, nozzle_mm: 0.4, materials: ['pla'], enclosed: false,
    hardened_nozzle: false, max_colors: 1, quality_max: 'fine', machine_hour_iqd: null, availability: 'available', active: true, canonical: false,
  };
  const signals = (days: number | null): RankSignals => ({
    governorate: 'baghdad', prefs: { ...EMPTY_PREFS, turnaround_days: days }, rating_avg_x100: 450, rating_count: 10,
    completed_orders: 5, response_minutes: null, trouble_rate: 0, pro: false,
  });
  const W = DEFAULT_MATCH_WEIGHTS;
  const fast = rankScore(req, printer, signals(2), null, W);
  const unknown = rankScore(req, printer, signals(null), null, W);
  const slow = rankScore(req, printer, signals(25), null, W);
  assert.ok(fast.score > unknown.score && unknown.score > slow.score, `${fast.score} > ${unknown.score} > ${slow.score}`);
  assert.equal(fast.detail.turnaround, W.turnaround, 'one or two days is the full mark');
  assert.equal(unknown.detail.turnaround, Math.round(W.turnaround * 0.5));
  assert.equal(turnaroundFraction(1), 1);
  assert.equal(turnaroundFraction(31), 0);
  assert.equal(turnaroundFraction(null), 0.5);
  // Everything but the turnaround line is identical: the signal reorders, it never decides.
  const { turnaround: a, ...restFast } = fast.detail;
  const { turnaround: b, ...restSlow } = slow.detail;
  assert.deepEqual(restFast, restSlow);
  assert.ok(a > b);
  assert.ok(W.pro_bonus <= W.turnaround, 'the PRO bonus stays the smallest signal');
});

// ------------------------------------------------------------- ?for=me

test('?for=me: only the rows the engine marked eligible for THAT workshop at the current revision, never the merchant\'s own request, limit+1 cursor', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,expires_at,created_at) VALUES
      ('r2','buyer','A vase','tall','open','open','public','${FUTURE}','2026-09-20T10:00:00.000Z'),
      ('r3','buyer','A gear','nylon','open','open','public','${FUTURE}','2026-09-20T09:00:00.000Z'),
      ('r4','buyer','A box','pla','open','open','public','${FUTURE}','2026-09-20T08:00:00.000Z'),
      ('r_own','owner','My own','mine','open','open','public','${FUTURE}','2026-09-20T07:00:00.000Z'),
      ('r_closed','buyer','Done','closed','in_progress','closed','public','${FUTURE}','2026-09-20T06:00:00.000Z'),
      ('r_legacy','buyer','Old verdict','engine one','open','open','public','${FUTURE}','2026-09-20T09:30:00.000Z');
    UPDATE community_requests SET created_at = '2026-09-21T10:00:00.000Z' WHERE id = 'r1';
    INSERT INTO community_request_matches (id,request_id,merchant_id,eligible,revision,score,engine) VALUES
      ('x1','r1','m1',1,1,80,2), ('x2','r2','m1',0,1,0,2), ('x3','r3','m1',1,0,70,2), ('x4','r4','m1',1,1,60,2),
      ('x5','r_own','m1',1,1,90,2), ('x6','r_closed','m1',1,1,90,2), ('x7','r2','m2',1,1,50,2),
      -- A verdict the matcher before W5-B wrote (engine 1): the offer fence does not trust it, nor does this list.
      ('x8','r_legacy','m1',1,1,95,1);
  `);
  const ids = (b: Record<string, unknown>) => (b.requests as Array<{ id: string }>).map((r) => r.id);
  const page1 = await json(await get(as(raw, ALI), '/api/community/requests?for=me&limit=1'));
  assert.deepEqual(ids(page1), ['r1'], 'r2 not eligible, r3 decided for an older revision, own, closed and engine-1 excluded');
  assert.equal(page1.total, 2);
  assert.equal(page1.for, 'me');
  assert.equal(page1.requests[0].match_score, 80);
  assert.ok(page1.next_cursor, 'a next page exists');
  const page2 = await json(await get(as(raw, ALI), `/api/community/requests?for=me&limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`));
  assert.deepEqual(ids(page2), ['r4']);
  assert.equal(page2.next_cursor, null, 'exact: no cursor when nothing follows');
  assert.deepEqual(ids(await json(await get(as(raw, OMAR), '/api/community/requests?for=me'))), ['r2']);
  assert.deepEqual(ids(await json(await get(as(raw, BUYER), '/api/community/requests?for=me'))), [], 'no workshop, no board');
  assert.equal((await get(as(raw, null), '/api/community/requests?for=me')).status, 401);
  // The public board is unchanged by the parameter's absence.
  const everyone = await json(await get(as(raw, null), '/api/community/requests'));
  assert.ok(ids(everyone).includes('r2'));
  assert.equal(everyone.for, undefined);
  // THE WORKSHOP BOARD'S BAR (review 2026-09-30): a store Levonis suspended —
  // a write that queues no re-match, so the stored verdicts stay «eligible» —
  // and a store not taking custom requests are shown nothing, with the reason.
  raw.exec(`UPDATE merchant_stores SET status = 'suspended', status_reason = 'fraud' WHERE id = 's1'`);
  const suspended = await json(await get(as(raw, ALI), '/api/community/requests?for=me'));
  assert.deepEqual([ids(suspended), suspended.blocked, suspended.total], [[], 'CANNOT_TAKE_WORK', 0]);
  raw.exec(`UPDATE merchant_stores SET status = 'active', status_reason = '', accepts_custom_requests = 0 WHERE id = 's1'`);
  const closedDoor = await json(await get(as(raw, ALI), '/api/community/requests?for=me'));
  assert.deepEqual([ids(closedDoor), closedDoor.blocked], [[], 'NOT_TAKING_REQUESTS']);
});

// ------------------------------------------------------- workshop facts

test('the workshop profile: turnaround and intro are validated and stored, technologies and the largest bed derive from the printers, and the store page shows the facts', async () => {
  const raw = seed();
  const ali = as(raw, ALI);
  assert.equal((await json(await put(ali, '/api/merchant/request-prefs', { turnaround_days: 0 }))).code, 'PREFS_TURNAROUND_INVALID');
  assert.equal((await json(await put(ali, '/api/merchant/request-prefs', { turnaround_days: 61 }))).code, 'PREFS_TURNAROUND_INVALID');
  assert.equal((await json(await put(ali, '/api/merchant/request-prefs', { turnaround_days: 2.5 }))).code, 'PREFS_TURNAROUND_INVALID');
  assert.equal((await json(await put(ali, '/api/merchant/request-prefs', { workshop_intro: 'x'.repeat(301) }))).code, 'PREFS_INTRO_TOO_LONG');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_request_prefs'), 0, 'nothing written on a refusal');

  const saved = await put(ali, '/api/merchant/request-prefs', { turnaround_days: 3, workshop_intro: '  We print   fast. ', governorates: ['baghdad'], delivery: ['delivery'] });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  const prefs = (await json(await get(ali, '/api/merchant/request-prefs'))).prefs;
  assert.equal(prefs.turnaround_days, 3);
  assert.equal(prefs.workshop_intro, 'We print fast.');
  assert.deepEqual(prefs.technologies, ['fdm']);
  assert.deepEqual(prefs.max_build_mm, { x: 256, y: 256, z: 250 });
  assert.deepEqual(
    row(raw, "SELECT turnaround_days, technologies, max_build_mm FROM merchant_request_prefs WHERE merchant_id = 'm1'"),
    { turnaround_days: 3, technologies: '["fdm"]', max_build_mm: '{"x":256,"y":256,"z":250}' }
  );

  // Public facts on the store page, to a guest — nothing but facts.
  const store = await json(await get(as(raw, null), '/api/community/store/m1'));
  assert.deepEqual(store.workshop, {
    technologies: ['fdm'],
    materials: ['petg', 'pla'],
    max_build_mm: { x: 256, y: 256, z: 250 },
    turnaround_days: 3,
    governorates: ['baghdad'],
    delivery: ['delivery'],
    custom_enabled: true,
    intro: 'We print fast.',
  });
  assert.ok(!JSON.stringify(store).includes('machine_hour'), 'no economics');

  // A workshop that never saved prefs still shows what its printers say (computed live).
  const omar = await json(await get(as(raw, null), '/api/community/store/m2'));
  assert.deepEqual(omar.workshop.technologies, ['fdm']);
  assert.deepEqual(omar.workshop.max_build_mm, { x: 220, y: 220, z: 250 });
  assert.equal(omar.workshop.turnaround_days, null);

  // A printer write re-derives the facts: Ali's only printer goes, the facts go with it.
  const gone = await ali.request('/api/merchant/printers/p1', { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  assert.equal(gone.status, 200);
  assert.deepEqual(
    row(raw, "SELECT technologies, max_build_mm FROM merchant_request_prefs WHERE merchant_id = 'm1'"),
    { technologies: '[]', max_build_mm: '{}' }
  );
  const after = await json(await get(as(raw, null), '/api/community/store/m1'));
  assert.deepEqual(after.workshop.technologies, []);
  assert.deepEqual(after.workshop.max_build_mm, {});
  assert.equal(after.workshop.turnaround_days, 3, 'the merchant\'s own word stays');
  // The shelf, once tracked, is what the store names as materials.
  raw.exec("INSERT INTO merchant_material_stock (id,merchant_id,material_id,color_hex,grams) VALUES ('st1','m2','petg','',900)");
  assert.deepEqual((await json(await get(as(raw, null), '/api/community/store/m2'))).workshop.materials, ['petg']);
});

// ------------------------------------------------------------------ round trips

test('the offers reads cost no more dependent round trips than before Phase 5 (perf review 2026-09-30)', async () => {
  // The reads gained serial waves in Phase 5 (/requests/:id/offers 6→7 customer, 6→8 merchant; /my-offers 2→4;
  // /community/store/:id 5→7): files, drafts, badges and workshop facts each awaited the one before. They now
  // start together. Measured with tests/fixtures/wavesD1 (a statement that can start only after an earlier answer
  // opens a new wave); the ceilings are today's figures, each at or under the pre-Phase-5 one the review measured.
  const raw = seed();
  assert.equal((await offerBy(raw, ALI, { price_iqd: 50_000, delivery_fee_iqd: 5_000, files: [{ key: K_PDF }] })).status, 201);
  assert.equal((await offerBy(raw, OMAR, { draft: true, price_iqd: 60_000 })).status, 201);
  await settle();
  const { waves, db } = wavesD1(raw);
  const bucket = bucketFor();
  const measure = async (user: StubUser | null, path: string) => {
    const app = stubApp(db, user, mount, { env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket } });
    waves.reset();
    const res = await get(app, path);
    assert.equal(res.status, 200, `${path}: ${res.status}`);
    await settle();
    return waves.counts.waves;
  };
  const figures = {
    customer: await measure(BUYER, '/api/marketplace/requests/r1/offers'),
    merchant: await measure(ALI, '/api/marketplace/requests/r1/offers'),
    draftHolder: await measure(OMAR, '/api/marketplace/requests/r1/offers'),
    myOffers: await measure(ALI, '/api/marketplace/my-offers'),
    myDrafts: await measure(OMAR, '/api/marketplace/my-offers'),
    store: await measure(null, '/api/community/store/m1'),
  };
  console.log(`waves: ${JSON.stringify(figures)}`);
  // The request's offers: [the request, the caller's store] → [offers, revisions, files, the caller's draft] → the
  // membership badges (their own two: the expiry sweep, then the read).
  assert.ok(figures.customer <= 4, `the customer's read takes ${figures.customer} waves`);
  assert.ok(figures.merchant <= 4, `the merchant's read takes ${figures.merchant} waves`);
  assert.ok(figures.draftHolder <= 4, `a draft holder's read takes ${figures.draftHolder} waves`);
  // «عروضي»: the store → [the page, its files by the page's own subquery, the drafts] — HEAD's two.
  assert.ok(figures.myOffers <= 2 && figures.myDrafts <= 2, `«عروضي» takes ${figures.myOffers} / ${figures.myDrafts} waves`);
  // The workshop's public card: the gate → the merchant → [products, followers, facts, badges] → their second halves.
  assert.ok(figures.store <= 4, `the store card takes ${figures.store} waves`);
  // …and the one-wave page still carries each offer's own files.
  const list = await json(await get(as(raw, ALI), '/api/marketplace/my-offers'));
  const live = list.offers.find((o: Record<string, unknown>) => !o.draft);
  assert.deepEqual(live.files.map((f: Record<string, unknown>) => f.key), [K_PDF]);
  const onlyDrafts = await json(await get(as(raw, OMAR), '/api/marketplace/my-offers?state=draft'));
  assert.deepEqual(onlyDrafts.offers.map((o: Record<string, unknown>) => o.draft), [true]);
});

test('?for=me reads the open board, not the workshop\'s whole match history: the plan starts from the requests\' state index (perf review 2026-09-30)', async () => {
  // It was driven from community_request_matches by (merchant_id, eligible) — every job this workshop was ever
  // matched to, then sorted — and the COUNT repeated the scan; the rows read grew forever.
  const raw = seed();
  const seen: string[] = [];
  const d1 = asD1(raw) as unknown as { prepare: (sql: string) => unknown };
  const prepare = d1.prepare.bind(d1);
  d1.prepare = (sql: string) => (seen.push(sql), prepare(sql));
  const app = stubApp(d1 as unknown as D1Database, ALI, mount);
  assert.equal((await get(app, '/api/community/requests?for=me')).status, 200);
  const reads = seen.filter((q) => /community_request_matches vm/.test(q));
  assert.equal(reads.length, 2, 'the page and its count');
  for (const sql of reads) {
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail);
    assert.match(plan[0], /^SEARCH r USING INDEX idx_community_requests_state/, `driven from the board: ${plan.join(' | ')}`);
    assert.ok(plan.some((d) => /SEARCH vm EXISTS USING INDEX idx_request_matches_pair \(request_id=\? AND merchant_id=\?\)/.test(d)), `the verdict is a pair lookup: ${plan.join(' | ')}`);
    assert.ok(!plan.some((d) => /idx_request_matches_merchant/.test(d)), `a scan of the workshop's match history: ${plan.join(' | ')}`);
  }
});
