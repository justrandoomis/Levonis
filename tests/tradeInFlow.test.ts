/**
 * «الاستبدال» — THE WHOLE JOURNEY, THROUGH THE REAL ROUTES.
 *
 * Every migration applied to a real SQLite database; the real trade-in routes,
 * the real upload/file gate, the real Telegram webhook, the real cart and the
 * real checkout. Stubbed: the session, Telegram and mail at `fetch`, the two
 * R2 buckets and the Images binding. The D1 limits the local engine does not
 * enforce (100 bound parameters, 5 compound terms) are enforced by `LimitD1`.
 *
 * What is proved, in the owner's words:
 *   «يختار المنتج من طلباته السابقة في LEVONIS فقط» — another customer's line
 *     is 404, an undelivered one refused, a filament spool never listed;
 *   a Combo's AMS is valued from the option gap, alone or with its printer, and
 *     no part can be claimed twice;
 *   the server enforces the answers, the photographs and the target;
 *   an admin value change reaches the customer with Telegram buttons, only the
 *     linked owner can press them, and a stale offer cannot be accepted;
 *   the accepted value is credited ONCE at the real checkout, only on the
 *     target line, only for its owner, capped at that line.
 *
 * Run: node --import tsx --test tests/tradeInFlow.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, stubApp, post, get, json, send, row, count, pending, ctx, type StubUser } from './fixtures/app';
import { LimitD1, violations } from './fixtures/d1Limits';
import { tradeInRoutes, adminTradeInRoutes } from '../worker/routes/tradeIn';
import { fileRoutes } from '../worker/routes/uploads';
import { telegramRoutes } from '../worker/routes/telegram';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { tradeInCallbackData, parseTradeInCallbackData } from '../worker/lib/tradeIn';
import { DEFAULT_RULE_SETS, REQUIRED_PHOTOS, blankInputs, valuateComponent, wholeMonthsBetween } from '../packages/pricing/src/tradeIn';
import { acceptedPolicies } from './lib/policies';
import { PRINTER_STANDARD_DELIVERY_POLICY } from '../packages/shipping/src/printerDeliveryPolicy';

const HOOK_SECRET = 'customer-hook-secret';
const CUSTOMER_TG = 7101;
const STRANGER_TG = 7102;

const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
const CUSTOMER: StubUser = { id: 'cust', role: 'customer', email: 'sara@x.co' };
const OTHER: StubUser = { id: 'other', role: 'customer', email: 'omar@x.co' };

// ---------------------------------------------------------------- stubs

interface Call {
  method: string;
  body: Record<string, unknown>;
}
const calls: Call[] = [];
const realFetch = globalThis.fetch;
let mid = 900;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  let body: Record<string, unknown> = {};
  if (typeof init?.body === 'string') {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(url);
  calls.push({ method: m ? m[1] : 'email', body });
  const chat = Number(body.chat_id ?? 0) || 1;
  return new Response(JSON.stringify({ ok: true, id: 'em_1', result: { message_id: ++mid, chat: { id: chat } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
test.after(() => void (globalThis.fetch = realFetch));

class MemoryBucket {
  objects = new Map<string, Uint8Array>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, bytes);
  }
  async get(key: string) {
    const b = this.objects.get(key);
    if (!b) return null;
    return {
      body: new Blob([b as unknown as BlobPart]).stream(),
      size: b.byteLength,
      httpEtag: `"${key}"`,
      httpMetadata: { contentType: 'image/webp' },
      writeHttpMetadata(h: Headers) {
        h.set('Content-Type', 'image/webp');
      },
      arrayBuffer: () => new Blob([b as unknown as BlobPart]).arrayBuffer(),
    };
  }
  async head(key: string) {
    return this.objects.has(key) ? { key, size: this.objects.get(key)!.byteLength } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function webp(): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x58], 12);
  b.set([0x7f, 0x02, 0x00], 24); // 640
  b.set([0xdf, 0x01, 0x00], 27); // 480
  return b;
}
const images = {
  async info() {
    return { format: 'image/webp', fileSize: 30, width: 640, height: 480 };
  },
  input() {
    return { async output() { return { response: () => new Response(webp() as unknown as BodyInit) }; } };
  },
};
/** A JPEG by its magic bytes — what a phone camera hands the page. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

const privateBucket = new MemoryBucket();
const publicBucket = new MemoryBucket();
const ENV = {
  TELEGRAM_BOT_TOKEN: '1111:CUSTOMER-BOT',
  TELEGRAM_WEBHOOK_SECRET: HOOK_SECRET,
  TELEGRAM_ADMIN_CHAT_ID: '-100999',
  APP_ORIGIN: 'https://levonis-iq.com',
  EMAIL_API_KEY: 're_k',
  EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
  BUCKET: privateBucket,
  R2_PRIVATE: privateBucket,
  R2_PUBLIC: publicBucket,
  IMAGES: images,
};

const dbOf = (raw: DatabaseSync) => new LimitD1(raw) as unknown as D1Database;
const customerApp = (raw: DatabaseSync, user: StubUser = CUSTOMER) =>
  stubApp(dbOf(raw), user, (a) => {
    a.route('/api/trade-in', tradeInRoutes);
    a.route('/files', fileRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/cart', cartRoutes);
  }, { env: ENV });
const adminApp = (raw: DatabaseSync, user: StubUser = OWNER) =>
  stubApp(dbOf(raw), user, (a) => {
    a.route('/api/admin/trade-in', adminTradeInRoutes);
    a.route('/files', fileRoutes);
  }, { env: ENV });
const hookApp = (raw: DatabaseSync) => stubApp(dbOf(raw), null, (a) => a.route('/api/telegram', telegramRoutes), { env: ENV });

const DELIVERED = '2025-09-26T00:00:00.000Z';

/**
 * Sara bought an A1 COMBO (paid 1,100,000; catalogue: A1 850,000, Combo
 * 1,150,000), a resin printer and a spool of PLA, all delivered; she also has
 * an undelivered A1. Omar has a delivered A1 of his own. The shop sells a P1S
 * directly at 1,500,000 and an AMS Lite at 350,000.
 */
function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES
      ('boss','Ali','boss@x.co','h','admin',NULL,'ar'),
      ('helper','Mona','helper@x.co','h','admin',NULL,'ar'),
      ('cust','سارة','sara@x.co','h','customer','2026-01-01T00:00:00.000Z','ar'),
      ('other','Omar','omar@x.co','h','customer','2026-01-01T00:00:00.000Z','ar');
    UPDATE users SET admin_scope = 'assistant' WHERE id = 'helper';
    INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
      VALUES ('cust', ${CUSTOMER_TG}, ${CUSTOMER_TG}, '+9647700000001', '2026-01-01T00:00:00.000Z');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_c','cust','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('addr_o','other','Home','Omar','+9647709876543','Erbil, Ankawa 4','',1);

    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,category_id,sub_category_id) VALUES
      ('p_a1','a1','Bambu Lab A1','بامبو A1',850000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm'),
      ('p_p1s','p1s','Bambu Lab P1S','بامبو P1S',1500000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_fdm'),
      ('p_ams','ams-lite','AMS Lite','AMS Lite',350000,'active',5,'[]','[]','direct_sale','["direct_sale"]','[]','cat_pacc','cat_pacc_fdm'),
      ('p_resin','saturn','Elegoo Saturn 4','إليغو ساتورن 4',600000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','cat_printers','cat_printers_resin'),
      ('p_pla','pla','PLA Basic','PLA أساسي',25000,'active',50,'[]','[]','direct_sale','["direct_sale"]','[]','cat_materials','cat_materials_fdm');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_a1','p_a1','Model',0,1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, sort, active, regular_price_iqd, variant_key) VALUES
      ('v_a1','p_a1','g_a1','A1','A1',0,1,850000,'a1'),
      ('v_a1c','p_a1','g_a1','A1 Combo','A1 كومبو',1,1,1150000,'a1-combo');

    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at,delivered_at) VALUES
      ('ORD-DLV','cust','delivered','delivered','{}','standard','{}','cash',1725000,0,1400,1725000,0,'2025-09-20T00:00:00.000Z','${DELIVERED}','${DELIVERED}'),
      ('ORD-PEND','cust','pending','received','{}','standard','{}','cash',850000,0,1400,850000,850000,'2026-09-20T00:00:00.000Z','2026-09-20T00:00:00.000Z',NULL),
      ('ORD-OTHER','other','delivered','delivered','{}','standard','{}','cash',850000,0,1400,850000,0,'2025-09-20T00:00:00.000Z','${DELIVERED}','${DELIVERED}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids) VALUES
      ('oi_combo','ORD-DLV','p_a1','Bambu Lab A1','','A1 Combo',1,1100000,1100000,'v_a1c','["v_a1c"]'),
      ('oi_resin','ORD-DLV','p_resin','Elegoo Saturn 4','','',1,600000,600000,'','[]'),
      ('oi_pla','ORD-DLV','p_pla','PLA Basic','','',1,25000,25000,'','[]'),
      ('oi_pend','ORD-PEND','p_a1','Bambu Lab A1','','A1',1,850000,850000,'v_a1','["v_a1"]'),
      ('oi_other','ORD-OTHER','p_a1','Bambu Lab A1','','A1',1,850000,850000,'v_a1','["v_a1"]');
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_ext_months,warranty_start_at,warranty_end_at,policy_version)
      VALUES ('unit_combo','ORD-DLV','oi_combo','p_a1','cust',1,'${DELIVERED}',24,0,'${DELIVERED}','2027-09-26T00:00:00.000Z','{}');
  `);
  return raw;
}

const answers = (family: 'fdm' | 'ams' | 'resin', over: Record<string, unknown> = {}) => ({ ...blankInputs(family), ...over });

function photoForm(component: string, angle: string, bytes: Uint8Array = JPEG): FormData {
  const f = new FormData();
  f.set('file', new File([bytes as unknown as BlobPart], 'p.jpg', { type: 'image/jpeg' }));
  f.set('component', component);
  f.set('angle', angle);
  return f;
}
const upload = (a: ReturnType<typeof customerApp>, id: string, component: string, angle: string) =>
  a.request(`/api/trade-in/requests/${id}/photos`, { method: 'POST', body: photoForm(component, angle), headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);

async function uploadAll(a: ReturnType<typeof customerApp>, id: string, component: 'device' | 'ams', family: 'fdm' | 'ams' | 'resin') {
  for (const angle of REQUIRED_PHOTOS[family]) {
    const res = await upload(a, id, component, angle.id);
    assert.equal(res.status, 201, `${component}/${angle.id}: ${await res.clone().text()}`);
  }
}

const settle = () => Promise.all(pending.splice(0));

async function press(raw: DatabaseSync, data: string, from = CUSTOMER_TG) {
  const res = await post(hookApp(raw), '/api/telegram/webhook', {
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: { id: `cb_${Math.random()}`, from: { id: from }, data, message: { message_id: 55, chat: { id: from, type: 'private' }, text: 'LEVONIS' } },
  }, { 'X-Telegram-Bot-Api-Secret-Token': HOOK_SECRET });
  await settle();
  return res;
}

// ================================================================ eligibility

test('only this customer’s delivered LEVONIS devices are offered; another’s line is 404', async () => {
  const raw = seed();
  const a = customerApp(raw);
  const res = await json(await get(a, '/api/trade-in/eligible'));
  const keys = (res.units as Array<{ order_item_id: string }>).map((u) => u.order_item_id).sort();
  assert.deepEqual(keys, ['oi_combo', 'oi_resin'], 'no filament, no undelivered order, nobody else’s printer');
  const combo = res.units.find((u: { order_item_id: string }) => u.order_item_id === 'oi_combo');
  assert.equal(combo.family, 'fdm');
  assert.equal(combo.is_combo, true);
  assert.equal(combo.ams_split.method, 'option_gap');
  assert.equal(combo.ams_split.ams_base_iqd, 286_880);
  assert.equal(combo.paid_iqd, 1_100_000);
  assert.equal(combo.warranty_end_at, '2027-09-26T00:00:00.000Z');
  assert.deepEqual(combo.scopes.map((s: { scope: string }) => s.scope), ['whole', 'printer_only', 'ams_only']);
  const resin = res.units.find((u: { order_item_id: string }) => u.order_item_id === 'oi_resin');
  assert.equal(resin.family, 'resin');
  assert.equal(resin.is_combo, false);

  // IDOR: Omar's order line, opened by Sara, is "not found" — not "forbidden".
  const theirs = await post(a, '/api/trade-in/requests', { order_item_id: 'oi_other', unit_index: 1, scope: 'whole' });
  assert.equal(theirs.status, 404);
  const pend = await post(a, '/api/trade-in/requests', { order_item_id: 'oi_pend', unit_index: 1, scope: 'whole' });
  assert.equal(pend.status, 409);
  assert.equal((await json(pend)).code, 'TRADE_IN_NOT_DELIVERED');
  const pla = await post(a, '/api/trade-in/requests', { order_item_id: 'oi_pla', unit_index: 1, scope: 'whole' });
  assert.equal((await json(pla)).code, 'TRADE_IN_NOT_ELIGIBLE');
  // A request id that is not theirs is 404 on every door.
  const mine = await json(await post(a, '/api/trade-in/requests', { order_item_id: 'oi_resin', unit_index: 1, scope: 'whole' }));
  const omar = customerApp(raw, OTHER);
  assert.equal((await get(omar, `/api/trade-in/requests/${mine.request.id}`)).status, 404);
  assert.equal((await send(omar, 'PATCH', `/api/trade-in/requests/${mine.request.id}`, { customer_note: 'x' })).status, 404);
  assert.equal((await post(omar, `/api/trade-in/requests/${mine.request.id}/submit`)).status, 404);
  assert.equal((await post(omar, `/api/trade-in/requests/${mine.request.id}/cancel`)).status, 404);
  assert.equal((await upload(omar, mine.request.id, 'device', 'front')).status, 404);
  assert.deepEqual(violations, []);
});

test('a part cannot be traded twice: the AMS alone blocks the whole Combo, not its printer; cancelling frees it', async () => {
  const raw = seed();
  const a = customerApp(raw);
  const ams = await json(await post(a, '/api/trade-in/requests', { order_item_id: 'oi_combo', unit_index: 1, scope: 'ams_only' }));
  assert.equal(ams.request.status, 'draft');
  assert.deepEqual(ams.request.components.map((c: { role: string; base_iqd: number }) => [c.role, c.base_iqd]), [['ams', 286_880]]);
  const whole = await post(a, '/api/trade-in/requests', { order_item_id: 'oi_combo', unit_index: 1, scope: 'whole' });
  assert.equal(whole.status, 409);
  assert.equal((await json(whole)).code, 'TRADE_IN_ALREADY_CLAIMED');
  const printer = await json(await post(a, '/api/trade-in/requests', { order_item_id: 'oi_combo', unit_index: 1, scope: 'printer_only' }));
  assert.deepEqual(printer.request.components.map((c: { role: string; base_iqd: number }) => [c.role, c.base_iqd]), [['device', 1_100_000 - 286_880]]);
  // The eligibility list says so too.
  const units = (await json(await get(a, '/api/trade-in/eligible'))).units;
  const combo = units.find((u: { order_item_id: string }) => u.order_item_id === 'oi_combo');
  assert.equal(combo.available, false);
  assert.equal(combo.reason, 'TRADE_IN_ALREADY_CLAIMED');
  // Cancel the AMS request: its claim goes with it.
  const cancelled = await json(await post(a, `/api/trade-in/requests/${ams.request.id}/cancel`, {}));
  assert.equal(cancelled.request.status, 'cancelled');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_claims WHERE request_id = ?", ams.request.id), 0);
  assert.equal((await post(a, '/api/trade-in/requests', { order_item_id: 'oi_combo', unit_index: 1, scope: 'ams_only' })).status, 201);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_claims'), 2);
});

// ================================================================ the draft and the door

test('the server enforces the answers, every required photograph and the target before a request is sent', async () => {
  const raw = seed();
  const a = customerApp(raw);
  const created = await json(await post(a, '/api/trade-in/requests', { order_item_id: 'oi_combo', unit_index: 1, scope: 'whole' }));
  const id = created.request.id as string;
  assert.deepEqual(created.request.components.map((c: { role: string }) => c.role), ['device', 'ams']);

  // An invented fault id is refused, not priced at zero.
  const bad = await send(a, 'PATCH', `/api/trade-in/requests/${id}`, { components: { device: answers('fdm', { faults: ['free_money'] }) } });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'TRADE_IN_INPUTS_INVALID');
  // A price from the client is ignored — there is no field for it; the target is priced by the server.
  const saved = await json(
    await send(a, 'PATCH', `/api/trade-in/requests/${id}`, {
      components: { device: answers('fdm', { hours: 450, exterior: 3 }), ams: answers('ams', { faults: ['rfid'] }) },
      target: { product_id: 'p_p1s', option_value_ids: [], color_id: null, price_iqd: 1 },
    })
  );
  assert.equal(saved.request.target.price_iqd, 1_500_000);

  // Nothing photographed yet.
  const early = await post(a, `/api/trade-in/requests/${id}/submit`);
  assert.equal(early.status, 409);
  const missing = (await json(early)).details.missing;
  assert.deepEqual(missing.device, REQUIRED_PHOTOS.fdm.map((x) => x.id));
  assert.deepEqual(missing.ams, REQUIRED_PHOTOS.ams.map((x) => x.id));

  // An angle that belongs to another family is refused.
  const lens = await upload(a, id, 'ams', 'lens');
  assert.equal(lens.status, 400);
  assert.equal((await json(lens)).code, 'TRADE_IN_PHOTO_ANGLE');
  // A file that is not a picture is refused by its bytes.
  const html = await a.request(`/api/trade-in/requests/${id}/photos`, { method: 'POST', body: photoForm('device', 'front', new TextEncoder().encode('<html>')) }, undefined, ctx);
  assert.equal(html.status, 400);

  await uploadAll(a, id, 'device', 'fdm');
  await uploadAll(a, id, 'ams', 'ams');
  const photo = row<{ file_key: string }>(raw, 'SELECT file_key FROM trade_in_photos WHERE request_id = ? LIMIT 1', id)!;
  assert.match(photo.file_key, new RegExp(`^trade-in/${id}/photos/[a-z0-9]+\\.webp$`), 'converted, under the request’s own private folder');
  // The file gate: the owner reads it, a stranger does not.
  assert.equal((await get(a, `/files/${photo.file_key}`)).status, 200);
  assert.equal((await get(customerApp(raw, OTHER), `/files/${photo.file_key}`)).status, 403);
  assert.equal((await get(adminApp(raw), `/files/${photo.file_key}`)).status, 200, 'the inspecting admin reads every photograph');

  const sent = await json(await post(a, `/api/trade-in/requests/${id}/submit`));
  assert.equal(sent.request.status, 'submitted');
  // The server's estimate is the engine's, on the server's facts.
  const months = wholeMonthsBetween(DELIVERED, new Date().toISOString());
  const left = Math.max(0, Math.ceil((Date.parse('2027-09-26T00:00:00.000Z') - Date.now()) / 86_400_000 / 30));
  const dev = valuateComponent(DEFAULT_RULE_SETS.fdm, { base_iqd: 1_100_000 - 286_880, usage_months: months, warranty_remaining_months: left, product_id: 'p_a1' }, { ...answers('fdm', { hours: 450, exterior: 3 }) } as never);
  const amsV = valuateComponent(DEFAULT_RULE_SETS.ams, { base_iqd: 286_880, usage_months: months, warranty_remaining_months: left, product_id: 'p_a1' }, { ...answers('ams', { faults: ['rfid'] }), hours: null } as never);
  assert.equal(sent.request.estimated_iqd, dev.value_iqd + amsV.value_iqd);
  assert.equal(sent.request.estimate.settlement.target_price_iqd, 1_500_000);

  // Sent is sent: no more edits, no more photographs.
  assert.equal((await send(a, 'PATCH', `/api/trade-in/requests/${id}`, { customer_note: 'late' })).status, 409);
  assert.equal((await upload(a, id, 'device', 'damage')).status, 409);
  await settle();
  assert.ok(calls.some((c) => c.method === 'sendMessage' && String(c.body.text ?? '').includes('طلب استبدال جديد')), 'the admin topic heard about it');
  assert.deepEqual(violations, []);
});

async function submitted(raw: DatabaseSync, scope: 'whole' | 'printer_only' | 'ams_only' = 'ams_only', item = 'oi_combo') {
  const a = customerApp(raw);
  const r = await json(await post(a, '/api/trade-in/requests', { order_item_id: item, unit_index: 1, scope }));
  const id = r.request.id as string;
  const comps = r.request.components as Array<{ role: 'device' | 'ams'; family: 'fdm' | 'ams' | 'resin' }>;
  await send(a, 'PATCH', `/api/trade-in/requests/${id}`, {
    components: Object.fromEntries(comps.map((c) => [c.role, answers(c.family)])),
    target: { product_id: 'p_p1s', option_value_ids: [], color_id: null },
  });
  for (const c of comps) await uploadAll(a, id, c.role, c.family);
  const s = await post(a, `/api/trade-in/requests/${id}/submit`);
  assert.equal(s.status, 200, await s.clone().text());
  await settle();
  return id;
}

// ================================================================ the admin's value, the customer's answer

test('a changed value asks the customer; only the linked owner may press, a stale offer cannot be accepted', async () => {
  const raw = seed();
  const id = await submitted(raw);
  // An assistant admin may inspect but not put a number on it.
  assert.equal((await post(adminApp(raw, ASSISTANT), `/api/admin/trade-in/requests/${id}/inspect`)).status, 200);
  const denied = await post(adminApp(raw, ASSISTANT), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 150_000 });
  assert.equal(denied.status, 403);
  assert.equal((await post(adminApp(raw, ASSISTANT), `/api/admin/trade-in/requests/${id}/approve`)).status, 403);

  calls.length = 0;
  const changed = await json(await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 150_000, reason: 'خدش في الغطاء' }));
  assert.equal(changed.request.status, 'value_changed');
  assert.equal(changed.request.offer.offer_no, 1);
  await settle();
  const prompt = calls.find((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === CUSTOMER_TG);
  assert.ok(prompt, 'the customer got a Telegram prompt');
  const kb = (prompt!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string }>> }).inline_keyboard;
  assert.equal(kb[0][0].callback_data, tradeInCallbackData('accept', id, 1));
  assert.deepEqual(parseTradeInCallbackData(kb[1][0].callback_data), { decision: 'reject', requestId: id, offerNo: 1 });
  assert.ok(Buffer.byteLength(kb[0][0].callback_data!) <= 64);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'cust' AND kind = 'trade_in'") >= 2, true);

  // The admin changes it again: the first offer's buttons are stale.
  await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 180_000, reason: '' });
  const a = customerApp(raw);
  const stale = await post(a, `/api/trade-in/requests/${id}/accept`, { offer_no: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'TRADE_IN_OFFER_STALE');
  await press(raw, tradeInCallbackData('accept', id, 1));
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'value_changed');

  // A stranger pressing a forwarded message changes nothing.
  await press(raw, tradeInCallbackData('accept', id, 2), STRANGER_TG);
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'value_changed');

  // The owner accepts on Telegram: the value is fixed, the credit minted once.
  await press(raw, tradeInCallbackData('accept', id, 2));
  const r = row<Record<string, unknown>>(raw, 'SELECT * FROM trade_in_requests WHERE id = ?', id)!;
  assert.equal(r.status, 'awaiting_payment');
  assert.equal(r.final_value_iqd, 180_000);
  assert.equal(r.credit_iqd, 180_000);
  assert.equal(r.difference_iqd, 1_320_000);
  assert.equal(r.decided_via, 'telegram');
  const coupon = row<Record<string, unknown>>(raw, 'SELECT * FROM coupons WHERE trade_in_id = ?', id)!;
  assert.equal(coupon.value, 180_000);
  assert.equal(coupon.assigned_user_id, 'cust');
  assert.equal(coupon.product_id, 'p_p1s');
  assert.equal(coupon.max_global, 1);
  // A second press, and the site's own button, are replays.
  await press(raw, tradeInCallbackData('accept', id, 2));
  const again = await json(await post(a, `/api/trade-in/requests/${id}/accept`, { offer_no: 2 }));
  assert.equal(again.replayed, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupons WHERE trade_in_id = ?', id), 1);
  assert.deepEqual(
    (await json(await get(a, `/api/trade-in/requests/${id}`))).request.events.map((e: { action: string }) => e.action),
    ['create', 'submit', 'inspect', 'change_value', 'change_value', 'accept', 'awaiting_payment']
  );
  assert.deepEqual(violations, []);
});

test('the customer can decline: the request closes and the device is free again', async () => {
  const raw = seed();
  const id = await submitted(raw, 'printer_only');
  await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 100_000 });
  const a = customerApp(raw);
  const res = await json(await post(a, `/api/trade-in/requests/${id}/reject`, { offer_no: 1 }));
  assert.equal(res.request.status, 'customer_rejected');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_claims WHERE request_id = ?', id), 0);
  assert.equal((await post(a, `/api/trade-in/requests/${id}/accept`, { offer_no: 1 })).status, 409);
  // Declined is terminal; the admin cannot resurrect it with a new value.
  assert.equal((await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 120_000 })).status, 409);
});

// ================================================================ the money

async function checkoutBody(extra: Record<string, unknown> = {}) {
  return {
    printerStandardDeliveryAcceptance: { version: PRINTER_STANDARD_DELIVERY_POLICY.version, accepted: true },
    addressId: 'addr_c',
    deliveryMethodId: 'standard',
    paymentMethodId: 'cash',
    useWallet: false,
    usePoints: false,
    itemIds: [],
    idempotencyKey: `ti-${Math.random()}`,
    policyAcceptance: acceptedPolicies(),
    ...extra,
  };
}

test('the accepted value is credited ONCE, on the target line only, for its owner only', async () => {
  const raw = seed();
  const id = await submitted(raw);
  const approved = await json(await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`));
  assert.equal(approved.request.status, 'awaiting_payment');
  const value = approved.request.final_value_iqd as number;
  assert.ok(value > 0);
  assert.equal(approved.request.difference_iqd, 1_500_000 - value);

  const a = customerApp(raw);
  const pay = await json(await post(a, `/api/trade-in/requests/${id}/checkout`));
  const code = pay.coupon_code as string;
  assert.match(code, /^TI[A-Z2-9]{10}$/);
  assert.equal(pay.target.product_id, 'p_p1s');

  // A cart WITHOUT the new device: the credit is refused, not spent on filament.
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_pla','cust','p_pla','','[]','','','','',1)`);
  const wrong = await post(a, '/api/orders/quote', await checkoutBody({ couponCode: code }));
  assert.equal(wrong.status, 400);
  assert.equal((await json(wrong)).code, 'TRADE_IN_COUPON_MISMATCH');

  // Another customer holding the code: it does not exist for them.
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_o','other','p_p1s','','[]','','','','',1)`);
  const stolen = await post(customerApp(raw, OTHER), '/api/orders/quote', { ...(await checkoutBody({ couponCode: code })), addressId: 'addr_o' });
  assert.equal(stolen.status, 400);
  assert.equal((await json(stolen)).code, 'CODE_NOT_FOUND');

  // The target in the cart: the credit applies, capped at that line.
  raw.exec(`DELETE FROM cart_items WHERE id = 'c_pla';
            INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_p1s','cust','p_p1s','','[]','','','','',1)`);
  const quote = (await json(await post(a, '/api/orders/quote', await checkoutBody({ couponCode: code })))).quote;
  assert.equal(quote.coupon.discount_iqd, value);
  const placed = await post(a, '/api/orders', await checkoutBody({ couponCode: code }));
  assert.equal(placed.status, 200, await placed.clone().text());
  const orderId = (await json(placed)).order.id as string;
  assert.equal(row<{ total_iqd: number }>(raw, 'SELECT total_iqd FROM orders WHERE id = ?', orderId)!.total_iqd, quote.total_iqd);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ?', orderId), 1);

  // Twice? The second order is refused by the redemption trigger, whole.
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('c_p1s2','cust','p_p1s','','[]','','','','',1)`);
  const twice = await post(a, '/api/orders', await checkoutBody({ couponCode: code }));
  assert.equal(twice.status, 400);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE user_id = 'cust' AND status <> 'delivered'"), 2, 'only ORD-PEND and the one order');

  // The request knows its order; «إتمام الدفع» now points at it instead of minting.
  const view = (await json(await get(a, `/api/trade-in/requests/${id}`))).request;
  assert.equal(view.credit_order.id, orderId);
  assert.equal(view.can.pay, false);
  assert.equal((await json(await post(a, `/api/trade-in/requests/${id}/checkout`))).order_id, orderId);
  // It cannot be cancelled from under a live order.
  assert.equal((await json(await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/cancel`, { reason: 'test cancel' }))).code, 'TRADE_IN_ORDER_ACTIVE');

  // The order is cancelled: the credit is re-issued, never lost, never doubled.
  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
  const re = await json(await post(a, `/api/trade-in/requests/${id}/checkout`));
  assert.notEqual(re.coupon_code, code);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupons WHERE trade_in_id = ? AND active = 1', id), 1);
  const old = await post(a, '/api/orders/quote', await checkoutBody({ couponCode: code }));
  assert.equal(old.status, 400, 'the spent code stays spent');

  // Completing needs a live order carrying the credit.
  assert.equal((await json(await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/complete`))).code, 'TRADE_IN_NO_ORDER');
  const placed2 = await post(a, '/api/orders', await checkoutBody({ couponCode: re.coupon_code }));
  assert.equal(placed2.status, 200, await placed2.clone().text());
  const done = await json(await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/complete`));
  assert.equal(done.request.status, 'completed');
  // Completed keeps its claim for ever: the AMS of this unit is traded.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_claims WHERE request_id = ?', id), 1);
  assert.deepEqual(violations, []);
});

test('an old device worth more than the new one: the credit is capped at the new device’s price', async () => {
  const raw = seed();
  const id = await submitted(raw, 'printer_only');
  // Retarget is not possible after submit, so price the cap against a cheaper device directly.
  raw.prepare("UPDATE trade_in_requests SET target_product_id = 'p_ams', target_price_iqd = 350000 WHERE id = ?").run(id);
  await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 500_000, reason: 'حالة ممتازة' });
  const res = await json(await post(customerApp(raw), `/api/trade-in/requests/${id}/accept`, { offer_no: 1 }));
  assert.equal(res.request.status, 'awaiting_payment');
  assert.equal(res.request.final_value_iqd, 500_000);
  assert.equal(res.request.credit_iqd, 350_000);
  assert.equal(res.request.difference_iqd, 0);
  assert.equal(res.request.excess_iqd, 150_000);
  assert.equal(row<{ value: number }>(raw, 'SELECT value FROM coupons WHERE trade_in_id = ?', id)!.value, 350_000);
});

// ================================================================ the rules

test('the rules editor: financial scope to save, a new version each time, validation before anything is stored', async () => {
  const raw = seed();
  const rules = (await json(await get(adminApp(raw, ASSISTANT), '/api/admin/trade-in/rules'))).rules;
  assert.equal(rules.fdm.version, 1);
  assert.equal(rules.fdm.is_default, true);
  const next = { ...rules.fdm, floor_bp: 1500 };
  assert.equal((await send(adminApp(raw, ASSISTANT), 'PUT', '/api/admin/trade-in/rules/fdm', { rules: next })).status, 403);
  const invalid = await send(adminApp(raw), 'PUT', '/api/admin/trade-in/rules/fdm', { rules: { ...next, floor_bp: 9900 } });
  assert.equal(invalid.status, 400);
  assert.ok((await json(invalid)).details.errors.includes('floor_above_cap'));
  const saved = await json(await send(adminApp(raw), 'PUT', '/api/admin/trade-in/rules/fdm', { rules: next, note: 'أرضية أعلى' }));
  assert.equal(saved.rules.version, 2);
  assert.equal(saved.rules.is_default, false);
  assert.equal(saved.rules.floor_bp, 1500);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_rule_sets WHERE family = 'fdm'"), 2, 'version 1 stays as history');
  // The calculator answers with the same engine and stores nothing.
  const tested = await json(await post(adminApp(raw, ASSISTANT), '/api/admin/trade-in/rules/fdm/test', { rules: next, sample: { base_iqd: 1_000_000, usage_months: 0, target_price_iqd: 1_500_000 } }));
  assert.equal(tested.valuation.value_iqd, valuateComponent({ ...next, version: 0, is_default: false }, { base_iqd: 1_000_000, usage_months: 0, warranty_remaining_months: 0, product_id: '' }, blankInputs('fdm')).value_iqd);
  assert.equal(tested.settlement.target_price_iqd, 1_500_000);
});

test('the admin list filters by status and family and names the customer', async () => {
  const raw = seed();
  await submitted(raw, 'ams_only');
  await submitted(raw, 'whole', 'oi_resin');
  const all = await json(await get(adminApp(raw), '/api/admin/trade-in/requests'));
  assert.equal(all.requests.length, 2);
  const resin = await json(await get(adminApp(raw), '/api/admin/trade-in/requests?family=resin'));
  assert.equal(resin.requests.length, 1);
  assert.equal(resin.requests[0].customer_name, 'سارة');
  assert.equal(all.counts.submitted, 2);
  assert.equal((await get(adminApp(raw), '/api/admin/trade-in/requests?status=nonsense')).status, 400);
  assert.equal((await get(adminApp(raw, CUSTOMER), '/api/admin/trade-in/requests')).status, 403, 'a customer is not an admin');
});
