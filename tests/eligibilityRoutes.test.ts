/**
 * ELIGIBILITY AS DATA, THROUGH THE REAL ROUTES (stream W5-B).
 *
 * Real routes and migrations (0132/0133 included) through the D1 adapter and
 * an in-memory R2. Each test names the contract it pins:
 *
 *   - an offer is refused for a workshop that cannot make the job
 *     (OFFER_NOT_ELIGIBLE with the reasons), and the notification switch is
 *     not a permission;
 *   - the board's «مناسب لي» view: only eligible requests, filters, cursor
 *     paging, thumbnails;
 *   - re-match on a request revision and on a workshop's printers, stock,
 *     preferences and delivery; the queue and its sweep;
 *   - the file matrix, the coarse preview, token binding to (user, revision),
 *     and every read counted;
 *   - costing a request's own model privately, and «استخدم هذا كعرضي»;
 *   - the printer and stock routes' refusals.
 *
 * Run: node --import tsx --test tests/eligibilityRoutes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, put, get, patch, json, count, row, all, type Mount } from './fixtures/app';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { merchantPrinterRoutes } from '../worker/routes/merchantPrinters';
import { merchantWorkshopRoutes } from '../worker/routes/merchantWorkshop';
import { merchantRoutes } from '../worker/routes/merchant';
import { drainMatchQueue, enqueueMatchStatement } from '../worker/lib/printMatchingStore';
import { COARSE_PREVIEW_MAX_TRIANGLES, coarsePreviewMesh } from '../worker/lib/requestFilePolicy';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/merchant/workshop', merchantWorkshopRoutes);
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/merchant', merchantPrinterRoutes);
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
    return {
      body: new Blob([v as unknown as BlobPart]).stream(),
      httpEtag: `"${key}"`,
      arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
    };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';

/**
 *   ali   (m1) — FDM, a Bambu P1S tied to its canonical row, PLUS
 *   omar  (m2) — resin only, PLUS
 *   zaid  (m3) — FDM, PLUS, «فرص طلبات العملاء» switched OFF
 *   lapsed(m4) — FDM, no plan
 */
function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('ali','Ali','a@x.co','h','customer'), ('omar','Omar','o@x.co','h','customer'),
      ('zaid','Zaid','z@x.co','h','customer'), ('lapsed','Nour','n@x.co','h','customer'), ('stranger','Huda','h@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','ali','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem2','omar','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem3','zaid','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','ali','Ali 3D'), ('m2','omar','Omar Resin'), ('m3','zaid','Zaid'), ('m4','lapsed','Nour');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,governorate) VALUES
      ('s1','m1','ali','ali3d','Ali 3D','baghdad'), ('s2','m2','omar','omarresin','Omar Resin','basra'),
      ('s3','m3','zaid','zaid3d','Zaid','baghdad'), ('s4','m4','lapsed','nour3d','Nour','baghdad');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max,model_id,brand,model) VALUES
      ('p1','m1','s1','P1S','fdm',256,256,250,'[]','fine','bbl-p1s','Bambu Lab','P1S'),
      ('p2','m2','s2','Saturn','resin',218,122,220,'[]','ultra','el-saturn4ultra','Elegoo','Saturn 4 Ultra'),
      ('p3','m3','s3','Ender','fdm',220,220,250,'[]','fine',NULL,'','');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p4','m4','s4','A1','fdm',256,256,256,'[]','fine');
    INSERT INTO merchant_notification_preferences (merchant_id, request_opportunities) VALUES ('m3', 0);
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default,governorate,area)
      VALUES ('a1','buyer','Home','Sara K','+9647700000009','Street 12','',1,'baghdad','Karrada');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const as = (raw: DatabaseSync, id: string | null, bucket = new MemoryBucket()) =>
  stubApp(asD1(raw), id ? { id, role: 'customer', email: `${id}@x.co` } : null, mount, { env: { BUCKET: bucket } });

/** A real binary STL of a W×D×H box, wound outward (analyseModel measures it). */
function stl(w = 20, d = 20, h = 20): Uint8Array {
  const v: Array<[number, number, number]> = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
  ];
  const tris: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
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
const png = () => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
};

async function uploadFile(raw: DatabaseSync, bucket: MemoryBucket, id: string, name: string, bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append('file', new File([bytes as unknown as BlobPart], name));
  const res = await as(raw, 'buyer', bucket).request(`/api/marketplace/requests/${id}/files`, { method: 'POST', body: form });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  return (await json(res)).file.id as string;
}

const PLA = { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1, governorate: 'baghdad' };

/** A published request with a measured model (and its preview) and a picture. */
async function published(raw: DatabaseSync, bucket: MemoryBucket, body: Record<string, unknown> = PLA, dims: [number, number, number] = [20, 20, 20]) {
  const res = await post(as(raw, 'buyer', bucket), '/api/marketplace/requests', { title: 'A bracket', description: 'Print me a bracket please' });
  const id = (await json(res)).request.id as string;
  const model = await uploadFile(raw, bucket, id, 'Sara_private_bracket.stl', stl(...dims));
  const picture = await uploadFile(raw, bucket, id, 'photo.png', png());
  const an = await post(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/files/${model}/analyze`);
  assert.equal(an.status, 200, JSON.stringify(await json(an.clone())));
  const pub = await post(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/publish`, { ...body, primary_file_id: model });
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  return { id, model, picture };
}

const verdictRow = (raw: DatabaseSync, id: string, merchant: string) =>
  row<{ eligible: number; reasons: string; revision: number; notified: number; notify_ok: number; engine: number }>(
    raw, 'SELECT eligible, reasons, revision, notified, notify_ok, engine FROM community_request_matches WHERE request_id = ? AND merchant_id = ?', id, merchant
  );

// ------------------------------------------------------------ 1. publish & offers

test('publish decides every workshop by the one verdict: the FDM shops can, the resin shop and the lapsed plan cannot, the switched-off shop can but is not told', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id } = await published(raw, bucket);
  assert.deepEqual([verdictRow(raw, id, 'm1')!.eligible, verdictRow(raw, id, 'm1')!.notified, verdictRow(raw, id, 'm1')!.engine], [1, 1, 2]);
  assert.deepEqual(JSON.parse(verdictRow(raw, id, 'm2')!.reasons), ['PROCESS']);
  assert.equal(verdictRow(raw, id, 'm2')!.notified, 0);
  assert.deepEqual([verdictRow(raw, id, 'm3')!.eligible, verdictRow(raw, id, 'm3')!.notify_ok, verdictRow(raw, id, 'm3')!.notified], [1, 0, 0]);
  assert.deepEqual(JSON.parse(verdictRow(raw, id, 'm4')!.reasons), ['PLAN_LAPSED']);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'matching_request' AND entity_id = ?", id), 1, 'only Ali is told');
  assert.equal(verdictRow(raw, id, 'm1')!.revision, 1);
});

test('OFFER_NOT_ELIGIBLE: a workshop that cannot make the job is refused with its reasons and nothing is written; a switched-off one may still bid', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id } = await published(raw, bucket);
  const resin = await post(as(raw, 'omar'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000, completion_days: 3 });
  assert.equal(resin.status, 403);
  const body = await json(resin);
  assert.equal(body.code, 'OFFER_NOT_ELIGIBLE');
  assert.deepEqual(body.details.reasons, ['PROCESS']);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE merchant_id = 'm2'"), 0);
  // The notification switch answers «tell me», not «let me».
  assert.equal((await post(as(raw, 'zaid'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 21_000, completion_days: 3 })).status, 201);
  assert.equal((await post(as(raw, 'ali'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000, completion_days: 3 })).status, 201);
});

test('an offer edit re-asks the verdict: a workshop whose printer went offline cannot re-price, but can still withdraw', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id } = await published(raw, bucket);
  const offer = (await json(await post(as(raw, 'ali'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000, completion_days: 3 }))).offer;
  raw.exec("UPDATE merchant_printers SET availability = 'offline' WHERE id = 'p1'");
  const edit = await patch(as(raw, 'ali'), `/api/marketplace/offers/${offer.id}`, { price_iqd: 18_000 });
  assert.equal(edit.status, 403);
  assert.deepEqual((await json(edit)).details.reasons, ['NO_PRINTER']);
  assert.equal(row<{ price_iqd: number }>(raw, 'SELECT price_iqd FROM community_offers WHERE id = ?', offer.id)!.price_iqd, 20_000);
  assert.equal((await post(as(raw, 'ali'), `/api/marketplace/offers/${offer.id}/withdraw`)).status, 200);
});

// ---------------------------------------------------------------- 2. the board

test('«مناسب لي»: only what the workshop can make, filtered, paged by cursor, with a readable thumbnail and my own offer marked', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const a = await published(raw, bucket);
  const b = await published(raw, bucket, { ...PLA, governorate: 'basra' });
  const c = await published(raw, bucket, { ...PLA, material_id: 'petg' });
  const big = await published(raw, bucket, PLA, [400, 20, 20]);
  const resin = await published(raw, bucket, { process: 'resin', material_id: 'resin-standard', quality: 'fine', quantity: 1, governorate: 'baghdad' });
  await post(as(raw, 'ali'), `/api/marketplace/requests/${a.id}/offers`, { price_iqd: 20_000, completion_days: 3 });

  const board = await json(await get(as(raw, 'ali', bucket), '/api/merchant/workshop/board'));
  const ids = (board.requests as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(new Set(ids), new Set([a.id, b.id, c.id]), 'not the 400 mm part, not the resin job');
  assert.ok(!ids.includes(big.id) && !ids.includes(resin.id));
  const first = (board.requests as Array<Record<string, unknown>>).find((r) => r.id === a.id)!;
  assert.equal(first.my_offer, 'pending');
  assert.equal(first.has_preview, true);
  assert.match(String(first.thumb_url), /^\/api\/marketplace\/requests\/.+\/files\/.+$/);
  assert.equal((await get(as(raw, 'ali', bucket), String(first.thumb_url))).status, 200, 'the thumbnail is readable by the workshop it is shown to');

  const petg = await json(await get(as(raw, 'ali', bucket), '/api/merchant/workshop/board?material=petg'));
  assert.deepEqual((petg.requests as Array<{ id: string }>).map((r) => r.id), [c.id]);
  const basra = await json(await get(as(raw, 'ali', bucket), '/api/merchant/workshop/board?governorate=basra'));
  assert.deepEqual((basra.requests as Array<{ id: string }>).map((r) => r.id), [b.id]);
  const fdm = await json(await get(as(raw, 'ali', bucket), '/api/merchant/workshop/board?process=resin'));
  assert.deepEqual(fdm.requests, []);

  const page1 = await json(await get(as(raw, 'ali', bucket), '/api/merchant/workshop/board?limit=2'));
  assert.equal(page1.requests.length, 2);
  assert.ok(page1.next_cursor);
  const page2 = await json(await get(as(raw, 'ali', bucket), `/api/merchant/workshop/board?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`));
  assert.equal(page2.requests.length, 1);
  assert.equal(page2.next_cursor, null);
  const seen = [...page1.requests, ...page2.requests].map((r: { id: string }) => r.id);
  assert.equal(new Set(seen).size, 3, 'no request twice, none dropped');
  assert.equal((await json(await get(as(raw, 'ali'), '/api/merchant/workshop/board?cursor=junk'))).code, 'BAD_CURSOR');

  // The resin shop sees the resin job and nothing else; a lapsed plan sees nothing, and says why.
  const omar = await json(await get(as(raw, 'omar', bucket), '/api/merchant/workshop/board'));
  assert.deepEqual((omar.requests as Array<{ id: string }>).map((r) => r.id), [resin.id]);
  const lapsed = await json(await get(as(raw, 'lapsed', bucket), '/api/merchant/workshop/board'));
  assert.deepEqual([lapsed.requests, lapsed.blocked], [[], 'CANNOT_TAKE_WORK']);
});

test('the board is Levo Community: shut to a merchant, it answers 503 like the board', async () => {
  const raw = seed();
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":false}')`);
  const res = await get(as(raw, 'ali'), '/api/merchant/workshop/board');
  assert.equal(res.status, 503);
});

// ------------------------------------------------------------- 3. re-match

test('RE-MATCH ON A WORKSHOP CHANGE: a new printer makes a job eligible and tells the workshop once; stock, preferences and delivery take it away again', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id } = await published(raw, bucket, { process: 'resin', material_id: 'resin-standard', quality: 'fine', quantity: 1, governorate: 'baghdad' });
  assert.equal(verdictRow(raw, id, 'm1')!.eligible, 0);

  // Ali buys a resin printer: tied to its canonical row, whatever physics he types.
  const add = await post(as(raw, 'ali'), '/api/merchant/printers', { name: 'Mars', model_id: 'el-mars4ultra', build_x_mm: 999, build_y_mm: 999, build_z_mm: 999 });
  assert.equal(add.status, 201, JSON.stringify(await json(add.clone())));
  const printer = (await json(add)).printer;
  assert.deepEqual([printer.technology, printer.build_x_mm, printer.nozzle_mm, printer.canonical], ['resin', 153, 0, true]);
  assert.deepEqual([verdictRow(raw, id, 'm1')!.eligible, verdictRow(raw, id, 'm1')!.notified], [1, 1]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'ali' AND kind = 'matching_request' AND entity_id = ?", id), 1);

  // Stock: tracked, and no resin on the shelf → off the board.
  const stock = await put(as(raw, 'ali'), '/api/merchant/material-stock', { lines: [{ material_id: 'pla', color_hex: '', grams: 3000 }] });
  assert.equal(stock.status, 200);
  assert.deepEqual(JSON.parse(verdictRow(raw, id, 'm1')!.reasons), ['STOCK_MATERIAL']);
  await put(as(raw, 'ali'), '/api/merchant/material-stock', { lines: [{ material_id: 'resin-standard', color_hex: '', grams: 1000 }] });
  assert.equal(verdictRow(raw, id, 'm1')!.eligible, 1);

  // Preferences narrow.
  await put(as(raw, 'ali'), '/api/merchant/request-prefs', { processes: ['fdm'] });
  assert.deepEqual(JSON.parse(verdictRow(raw, id, 'm1')!.reasons), ['PREF_PROCESS']);
  await put(as(raw, 'ali'), '/api/merchant/request-prefs', { processes: [] });
  assert.equal(verdictRow(raw, id, 'm1')!.eligible, 1);

  // Delivery (W2-A's own editor): Baghdad switched off → the Baghdad customer is out of reach.
  const cfg = await json(await get(as(raw, 'ali'), '/api/merchant/delivery'));
  const saved = await put(as(raw, 'ali'), '/api/merchant/delivery', {
    version: cfg.profile.version,
    profile: { ...cfg.profile },
    rules: [{ governorate_id: 'baghdad', mode: 'disabled', fee_iqd: null, free_over_iqd: null, prep_days: null, eta_note: '', note: '' }],
  });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())));
  assert.deepEqual(JSON.parse(verdictRow(raw, id, 'm1')!.reasons), ['REACH_DELIVERY']);
  // Told once for the request, never again.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'ali' AND kind = 'matching_request' AND entity_id = ?", id), 1);
});

test('RE-MATCH ON A REVISION: every verdict is decided again for the new revision, and nobody reads an older one', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id } = await published(raw, bucket);
  await post(as(raw, 'ali'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000, completion_days: 3 });
  const again = await post(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/publish`, { process: 'resin', material_id: 'resin-standard', quality: 'fine', quantity: 2, governorate: 'baghdad' });
  assert.equal((await json(again)).revised, true);
  assert.deepEqual([verdictRow(raw, id, 'm1')!.revision, JSON.parse(verdictRow(raw, id, 'm1')!.reasons)[0]], [2, 'PROCESS']);
  assert.deepEqual([verdictRow(raw, id, 'm2')!.revision, verdictRow(raw, id, 'm2')!.eligible], [2, 1]);
  const ali = await json(await get(as(raw, 'ali', bucket), '/api/merchant/workshop/board'));
  assert.deepEqual(ali.requests, [], 'the old revision\'s «eligible» is read by nobody');
});

test('THE QUEUE: a re-match left queued is finished by the sweep, and a verdict row written behind the revision is ignored by the attention count', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id } = await published(raw, bucket);
  raw.exec(`UPDATE community_request_matches SET eligible = 0, reasons = '["NO_PRINTER"]' WHERE request_id = '${id}'`);
  await enqueueMatchStatement(asD1(raw), 'request', id, 'test').run();
  const report = await drainMatchQueue({ DB: asD1(raw) } as never, { limit: 5 });
  assert.deepEqual([report.requests, report.failed], [1, 0]);
  assert.equal(verdictRow(raw, id, 'm1')!.eligible, 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_match_queue'), 0);
  // A request re-match tells nobody twice.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'matching_request' AND entity_id = ?", id), 1);
});

// ------------------------------------------------------------- 4. the files

test('THE FILE MATRIX: the eligible workshop sees the picture and previews the model but never downloads it; the customer and the accepted workshop get the original; others nothing — and every read is counted', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id, model, picture } = await published(raw, bucket);
  const listed = await json(await get(as(raw, 'ali', bucket), `/api/marketplace/requests/${id}`));
  const byId = new Map((listed.files as Array<{ id: string; access: string; url: string | null }>).map((f) => [f.id, f]));
  assert.deepEqual([byId.get(model)!.access, byId.get(model)!.url], ['preview', null]);
  assert.equal(byId.get(picture)!.access, 'view');

  assert.equal((await get(as(raw, 'ali', bucket), `/api/marketplace/requests/${id}/files/${picture}`)).status, 200);
  const original = await get(as(raw, 'ali', bucket), `/api/marketplace/requests/${id}/files/${model}`);
  assert.equal(original.status, 403);
  assert.equal((await json(original)).code, 'FILE_ORIGINAL_RESTRICTED');
  for (const who of ['omar', 'stranger']) {
    const r = await get(as(raw, who, bucket), `/api/marketplace/requests/${id}/files/${picture}`);
    assert.equal(r.status, 403, who);
    assert.equal((await json(r)).code, 'FILE_NOT_ALLOWED');
  }
  const strangerList = await json(await get(as(raw, 'stranger', bucket), `/api/marketplace/requests/${id}`));
  assert.ok((strangerList.files as Array<{ url: string | null }>).every((f) => f.url === null), 'no URL for a file the caller may not read');
  assert.equal((await get(as(raw, 'buyer', bucket), `/api/marketplace/requests/${id}/files/${model}`)).status, 200);

  // Accepted: the workshop gets the original.
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES ('wt1','buyer','deposit','USD',${Math.ceil((500_000 * 100) / RATE)},'approved','f')`);
  const offer = (await json(await post(as(raw, 'ali'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 20_000, completion_days: 3 }))).offer;
  assert.equal((await post(as(raw, 'buyer'), `/api/marketplace/offers/${offer.id}/accept`, { expected_price_iqd: 20_000, offer_revision: 1, address_id: 'a1' })).status, 201);
  assert.equal((await get(as(raw, 'ali', bucket), `/api/marketplace/requests/${id}/files/${model}`)).status, 200);

  const reads = all<{ user_id: string; access: string; what: string }>(raw, 'SELECT user_id, access, what FROM request_file_reads WHERE request_id = ? ORDER BY first_at', id);
  assert.ok(reads.some((r) => r.user_id === 'ali' && r.access === 'eligible' && r.what === 'inline'));
  assert.ok(reads.some((r) => r.user_id === 'ali' && r.access === 'engaged' && r.what === 'original'));
  assert.ok(reads.some((r) => r.user_id === 'buyer' && r.access === 'owner' && r.what === 'original'));
});

test('THE PREVIEW: an eligible workshop gets a coarse mesh bound to it and to the revision; the customer the stored one; a new revision retires the link', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id, model } = await published(raw, bucket, PLA, [20.1, 13.3, 7.7]); // edges off the preview's 0.25 mm grid
  const mint = await post(as(raw, 'ali', bucket), `/api/marketplace/print/requests/${id}/files/${model}/viewer-token`);
  assert.equal(mint.status, 200);
  const { token, grant } = await json(mint);
  assert.equal(grant, 'preview');
  const t = row<{ revision: number; grant_level: string; bound_user: number }>(raw, 'SELECT revision, grant_level, bound_user FROM model_view_tokens');
  assert.deepEqual(t, { revision: 1, grant_level: 'preview', bound_user: 1 });

  assert.equal((await get(as(raw, 'stranger', bucket), `/api/marketplace/print/viewer/${token}`)).status, 404, 'bound to the account that minted it');
  assert.equal((await get(as(raw, null, bucket), `/api/marketplace/print/viewer/${token}`)).status, 404);
  const meta = await json(await get(as(raw, 'ali', bucket), `/api/marketplace/print/viewer/${token}`));
  assert.equal(meta.grant, 'preview');
  const mesh = new Uint8Array(await (await get(as(raw, 'ali', bucket), `/api/marketplace/print/viewer/${token}/mesh`)).arrayBuffer());
  const stored = bucket.objects.get(`request-previews/${id}/${model}.lvm`)!;
  assert.notDeepEqual(mesh, stored, 'never the stored preview');
  assert.deepEqual(mesh, coarsePreviewMesh(stored));

  const own = (await json(await post(as(raw, 'buyer', bucket), `/api/marketplace/print/requests/${id}/files/${model}/viewer-token`))).token;
  const full = new Uint8Array(await (await get(as(raw, 'buyer', bucket), `/api/marketplace/print/viewer/${own}/mesh`)).arrayBuffer());
  assert.deepEqual(full, stored, 'the customer sees their own mesh as stored');

  // A new revision of the job (an edit after an offer moves it) retires both links.
  raw.exec(`UPDATE community_requests SET revision = revision + 1 WHERE id = '${id}'`);
  assert.equal((await get(as(raw, 'ali', bucket), `/api/marketplace/print/viewer/${token}`)).status, 404);
  assert.equal((await get(as(raw, 'buyer', bucket), `/api/marketplace/print/viewer/${own}`)).status, 404);
  assert.ok(count(raw, "SELECT COUNT(*) AS n FROM request_file_reads WHERE what IN ('preview_link','preview_meta','preview_mesh')") >= 4);

  // The workshop the job does not fit cannot mint at all.
  const denied = await post(as(raw, 'omar', bucket), `/api/marketplace/print/requests/${id}/files/${model}/viewer-token`);
  assert.equal(denied.status, 403);
  assert.deepEqual((await json(denied)).details.reasons, ['PROCESS']);
});

test('the coarse preview has at most its triangle budget and every coordinate on its grid', () => {
  const n = 50_000;
  const src = new Uint8Array(32 + n * 36);
  const dv = new DataView(src.buffer);
  src.set([0x4c, 0x56, 0x4d, 0x31], 0);
  dv.setUint32(4, n, true);
  [-50, -50, -50, 50, 50, 50].forEach((v, i) => dv.setFloat32(8 + i * 4, v, true));
  for (let i = 0; i < n * 9; i++) dv.setFloat32(32 + i * 4, ((i * 7919) % 10_000) / 100 - 50, true);
  const out = coarsePreviewMesh(src)!;
  const ov = new DataView(out.buffer);
  const kept = ov.getUint32(4, true);
  assert.ok(kept <= COARSE_PREVIEW_MAX_TRIANGLES && kept > 0);
  const grid = 100 / 400;
  for (let i = 0; i < kept * 9; i += 97) {
    const v = ov.getFloat32(32 + i * 4, true);
    assert.ok(Math.abs(v / grid - Math.round(v / grid)) < 1e-3, `${v} is on the ${grid} mm grid`);
  }
  assert.equal(coarsePreviewMesh(new Uint8Array([1, 2, 3])), null);
});

// -------------------------------------------------------------- 5. costing

test('COSTING v2: the eligible workshop costs the request\'s own model privately — no copy, no owner, its own quote — and «استخدم هذا كعرضي» marks it offered', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id } = await published(raw, bucket);
  const res = await post(as(raw, 'ali', bucket), `/api/merchant/workshop/requests/${id}/cost`, {});
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const costed = await json(res);
  assert.ok(costed.quote.price_iqd > 0);
  assert.ok(Array.isArray(costed.quote.lines), 'the workshop sees its cost lines');
  assert.equal(costed.request_revision, 1);
  assert.equal(costed.printer.id, 'p1');

  const q = row<{ request_id: string; merchant_id: string; state: string; analysis_id: string }>(raw, 'SELECT request_id, merchant_id, state, analysis_id FROM print_quotes WHERE id = ?', costed.quote_id)!;
  assert.deepEqual([q.request_id, q.merchant_id, q.state], [id, 'm1', 'draft']);
  const a = row<{ file_key: string; file_name: string; owner_id: string | null }>(raw, 'SELECT file_key, file_name, owner_id FROM print_analyses WHERE id = ?', q.analysis_id)!;
  assert.deepEqual(a, { file_key: '', file_name: '', owner_id: null }, 'nothing can serve the bytes back through it');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM request_file_reads WHERE what = 'costing' AND user_id = 'ali'"), 1);

  // Private: only Ali's list has it; the customer's view of the request carries no such price.
  const mine = await json(await get(as(raw, 'ali'), `/api/merchant/workshop/requests/${id}/costs`));
  assert.deepEqual(mine.costs.map((c: { id: string }) => c.id), [costed.quote_id]);
  assert.deepEqual((await json(await get(as(raw, 'zaid'), `/api/merchant/workshop/requests/${id}/costs`))).costs, []);
  const customer = JSON.stringify([
    await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}`)),
    await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}/offers`)),
  ]);
  assert.ok(!customer.includes(costed.quote_id));

  // «استخدم هذا كعرضي»: sent as the offer, the quote is `offered`.
  const offer = await post(as(raw, 'ali'), `/api/marketplace/requests/${id}/offers`, { price_iqd: costed.quote.price_iqd, completion_days: 2, quote_id: costed.quote_id });
  assert.equal(offer.status, 201);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM print_quotes WHERE id = ?', costed.quote_id)!.state, 'offered');
});

test('COSTING refusals: an ineligible workshop, a resin printer, a material the engine cannot weigh', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id } = await published(raw, bucket);
  const omar = await post(as(raw, 'omar', bucket), `/api/merchant/workshop/requests/${id}/cost`, {});
  assert.equal(omar.status, 403);
  assert.deepEqual([(await json(omar)).code], ['COSTING_NOT_ELIGIBLE']);
  const resinPrinter = await post(as(raw, 'ali', bucket), `/api/merchant/workshop/requests/${id}/cost`, { merchant_printer_id: 'p1', material_id: 'nope' });
  assert.equal((await json(resinPrinter)).code, 'COSTING_MATERIAL_REQUIRED');
  raw.exec(`INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm) VALUES ('p9','m1','s1','R','resin',200,200,200)`);
  const r = await post(as(raw, 'ali', bucket), `/api/merchant/workshop/requests/${id}/cost`, { merchant_printer_id: 'p9' });
  assert.equal((await json(r)).code, 'COSTING_RESIN_UNSUPPORTED');
});

test('the live verdict endpoint names every failing reason for the workshop, and a draft does not exist', async () => {
  const raw = seed();
  const bucket = new MemoryBucket();
  const { id } = await published(raw, bucket);
  const v = await json(await get(as(raw, 'omar'), `/api/merchant/workshop/requests/${id}/eligibility`));
  assert.deepEqual([v.eligible, v.reasons, v.dims.capability], [false, ['PROCESS'], 'fail']);
  const ok = await json(await get(as(raw, 'ali'), `/api/merchant/workshop/requests/${id}/eligibility`));
  assert.deepEqual([ok.eligible, ok.printer.id, ok.notify], [true, 'p1', true]);
  const draft = (await json(await post(as(raw, 'buyer'), '/api/marketplace/requests', { title: 'Draft one', description: 'Not published yet' }))).request.id;
  assert.equal((await get(as(raw, 'ali'), `/api/merchant/workshop/requests/${draft}/eligibility`)).status, 404);
});

// ----------------------------------------------------- 6. printers & stock

test('PRINTERS: canonical physics are locked, what the machine cannot take is refused by code, an unknown material is refused — never dropped', async () => {
  const raw = seed();
  const a1m = await post(as(raw, 'ali'), '/api/merchant/printers', { name: 'Mini', model_id: 'bbl-a1m', enclosed: true, build_x_mm: 500 });
  assert.equal(a1m.status, 201);
  const p = (await json(a1m)).printer;
  assert.deepEqual([p.build_x_mm, p.enclosed, p.brand, p.model], [180, false, 'Bambu Lab', 'A1 mini']);
  const refusals: Array<[Record<string, unknown>, string]> = [
    [{ name: 'x', model_id: 'nope' }, 'PRINTER_MODEL_UNKNOWN'],
    [{ name: 'x', model_id: 'bbl-p1s', nozzle_mm: 0.5 }, 'PRINTER_NOZZLE_INVALID'],
    [{ name: 'x', model_id: 'cr-k1', hardened_nozzle: true }, 'PRINTER_HARDENED_UNAVAILABLE'],
    [{ name: 'x', model_id: 'cr-ender3v3se', multicolor: true }, 'PRINTER_MULTICOLOR_UNAVAILABLE'],
    [{ name: 'x', model_id: 'bbl-p1s', materials: ['pla', 'resin-tough'] }, 'PRINTER_MATERIAL_INVALID'],
    [{ name: 'x', technology: 'fdm', build_x_mm: 200, build_y_mm: 200, build_z_mm: 200, materials: ['<junk>'] }, 'PRINTER_MATERIAL_INVALID'],
  ];
  for (const [body, code] of refusals) {
    const r = await post(as(raw, 'ali'), '/api/merchant/printers', body);
    assert.equal(r.status, 400, code);
    assert.equal((await json(r)).code, code);
  }
  const list = await json(await get(as(raw, 'ali'), '/api/merchant/printers'));
  assert.ok((list.models as Array<{ id: string; technology: string }>).some((m) => m.technology === 'resin'), 'resin machines are offered');
  assert.ok(!('purchase_iqd' in list.models[0]), 'the canonical list carries physics, not economics');
});

test('STOCK: every line checked, a duplicate refused, and an empty shelf only with an explicit «stop tracking»', async () => {
  const raw = seed();
  const bad: Array<[unknown, string]> = [
    [[{ material_id: 'unobtainium', grams: 1 }], 'STOCK_MATERIAL_INVALID'],
    [[{ material_id: 'pla', color_hex: 'red', grams: 1 }], 'STOCK_COLOR_INVALID'],
    [[{ material_id: 'pla', grams: -1 }], 'STOCK_GRAMS_INVALID'],
    [[{ material_id: 'pla', grams: 1.5 }], 'STOCK_GRAMS_INVALID'],
    [[{ material_id: 'pla', color_hex: '#000000', grams: 1 }, { material_id: 'pla', color_hex: '#000000', grams: 2 }], 'STOCK_DUPLICATE'],
    [[], 'STOCK_UNTRACK_CONFIRM'],
  ];
  for (const [lines, code] of bad) assert.equal((await json(await put(as(raw, 'ali'), '/api/merchant/material-stock', { lines }))).code, code);
  const ok = await json(await put(as(raw, 'ali'), '/api/merchant/material-stock', { lines: [{ material_id: 'pla', color_hex: '#000000', color_name: 'Black', grams: 750 }] }));
  assert.equal(ok.tracked, true);
  assert.equal((await json(await get(as(raw, 'ali'), '/api/merchant/material-stock'))).stock[0].grams, 750);
  const off = await json(await put(as(raw, 'ali'), '/api/merchant/material-stock', { lines: [], untrack: true }));
  assert.equal(off.tracked, false);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_material_stock WHERE merchant_id = 'm1'"), 0);
  // Another merchant's shelf is not reachable from this session.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_material_stock WHERE merchant_id <> 'm1'"), 0);
});

test('the backfill ties a typed printer to its canonical machine and queues every open request (0133)', async () => {
  const { dbThrough } = await import('./fixtures/app');
  const raw = dbThrough('0130_request_revisions_offers_v2.sql');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u','U','u@x.co','h'), ('c','C','c@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m','u','M');
    INSERT INTO merchant_printers (id,merchant_id,name,technology,brand,model,build_x_mm,build_y_mm,build_z_mm,hardened_nozzle)
      VALUES ('p','m','mine','fdm',' bambu lab ','a1 MINI',400,400,400,1), ('q','m','other','fdm','Acme','Zeta',300,300,300,0);
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,revision)
      VALUES ('r','c','t','d','receiving_offers','open','public',3), ('d','c','t','d','draft','closed','public',1);
    INSERT INTO community_request_matches (id,request_id,merchant_id,eligible,reject_reason) VALUES ('x','r','m',0,'MATERIAL');
    INSERT INTO model_view_tokens (token_hash,file_id,request_id,created_by,expires_at) SELECT 'h', 'f', 'r', 'c', '2099-01-01' WHERE 0;
  `);
  for (const f of ['0132_eligibility_capability_stock.sql', '0133_eligibility_backfill.sql']) {
    const { readFileSync } = await import('node:fs');
    raw.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  }
  const p = row<{ model_id: string; build_x_mm: number; hardened_nozzle: number }>(raw, "SELECT model_id, build_x_mm, hardened_nozzle FROM merchant_printers WHERE id = 'p'")!;
  assert.deepEqual(p, { model_id: 'bbl-a1m', build_x_mm: 180, hardened_nozzle: 1 });
  assert.equal(row<{ model_id: string | null }>(raw, "SELECT model_id FROM merchant_printers WHERE id = 'q'")!.model_id, null);
  assert.deepEqual(row(raw, "SELECT revision, reasons, engine FROM community_request_matches WHERE id = 'x'"), { revision: 3, reasons: '["MATERIAL"]', engine: 1 });
  assert.deepEqual(all(raw, 'SELECT kind, subject_id FROM community_match_queue'), [{ kind: 'request', subject_id: 'r' }]);
});
