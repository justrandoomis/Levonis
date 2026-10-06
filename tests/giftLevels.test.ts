/**
 * THE FIVE GIFT LEVELS AND THEIR ITEMS (owner brief 2026-10-06 §1;
 * docs/GIFTS_QUICK_BUY.md D2, D3, §1.2) — the admin editor through the real
 * routes on a fully migrated database.
 *
 *   «إدارة 5 مستويات … تحديد المنتج / الخيار / اللون / الكمية / بيع مباشر أو
 *    طلب مسبق» — a level item is ONE real store product, fully pinned; bundles,
 *    drafts and impossible selections are refused with their own code; every
 *    write leaves its audit row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, row } from './fixtures/app';
import {
  BOSS,
  NOZZLE_04_RED,
  PLATE_AIR,
  PLAIN,
  addLevelItem,
  appAs,
  apps,
  get,
  giftWorld,
  json,
  post,
  put,
  send,
} from './fixtures/giftWorld';
import { asD1 } from './fixtures/app';

/** A JSON body as the routes answer it, read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

const auditRows = (raw: ReturnType<typeof giftWorld>, action: string) =>
  all<{ actor_id: string | null; target: string; detail: string }>(raw, 'SELECT actor_id, target, detail FROM audit_log WHERE action = ? ORDER BY id', action);

test('five levels are seeded with three-language names, and only an admin reaches the editor', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const res = await get(a.admin, '/api/gifts/admin/levels');
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.deepEqual(out.levels.map((l: J) => l.n), [1, 2, 3, 4, 5]);
  for (const l of out.levels) {
    assert.equal(l.active, true);
    for (const lang of ['ar', 'en', 'ckb']) assert.ok(l.name[lang].trim().length > 0, `level ${l.n} ${lang}`);
    assert.notEqual(l.name.ckb, l.name.ar, 'the Sorani name is not the Arabic pasted across');
    assert.deepEqual(l.items, []);
    assert.deepEqual(l.legacy_items, []);
  }

  assert.equal((await get(a.buyer, '/api/gifts/admin/levels')).status, 403, 'a customer is refused');
  assert.equal((await get(appAs(asD1(raw), null), '/api/gifts/admin/levels')).status, 401, 'a visitor is refused');
  // Every admin door is behind the same guard.
  for (const [method, path] of [
    ['PUT', '/api/gifts/admin/levels/1'],
    ['POST', '/api/gifts/admin/levels/1/items'],
    ['PUT', '/api/gifts/admin/items/x'],
    ['DELETE', '/api/gifts/admin/items/x'],
    ['GET', '/api/gifts/admin/grants'],
    ['POST', '/api/gifts/admin/grants'],
  ] as const) {
    const r = method === 'GET' ? await get(a.buyer, path) : await send(a.buyer, method, path, {});
    assert.equal(r.status, 403, `${method} ${path}`);
  }
});

test('a level edit is validated, stored in three languages and audited with before and after', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  assert.equal((await put(a.admin, '/api/gifts/admin/levels/2', {})).status, 400, 'nothing to update');
  assert.equal((await put(a.admin, '/api/gifts/admin/levels/2', { name_ar: '' })).status, 400, 'the Arabic name is required');
  assert.equal((await put(a.admin, '/api/gifts/admin/levels/2', { active: 'no' })).status, 400);
  assert.equal((await put(a.admin, '/api/gifts/admin/levels/6', { name_ar: 'x' })).status, 400, 'there are five levels');

  const res = await put(a.admin, '/api/gifts/admin/levels/2', {
    name_ar: 'الهدية الفضية',
    name_en: 'Silver gift',
    name_ckb: 'دیاریی زیو',
    description_ar: 'ملحقات مختارة لطابعتك',
    description_en: 'Chosen accessories for your printer',
    description_ckb: 'پاشکۆی هەڵبژێردراو بۆ چاپکەرەکەت',
    active: false,
  });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.deepEqual(out.level.name, { ar: 'الهدية الفضية', en: 'Silver gift', ckb: 'دیاریی زیو' });
  assert.equal(out.level.description.ckb, 'پاشکۆی هەڵبژێردراو بۆ چاپکەرەکەت');
  assert.equal(out.level.active, false);
  assert.equal(row(raw, "SELECT updated_by FROM gift_pools WHERE id = 'gift_level_2'")?.updated_by, BOSS.id);

  const [audit] = auditRows(raw, 'gift.level.update');
  assert.equal(audit.target, 'gift_level_2');
  assert.equal(audit.actor_id, BOSS.id);
  const detail = JSON.parse(audit.detail);
  assert.equal(detail.level, 2);
  assert.equal(detail.before.name_ar, 'المستوى الثاني');
  assert.equal(detail.before.active, 1);
  assert.equal(detail.after.name_ar, 'الهدية الفضية');
  assert.equal(detail.after.active, 0);

  // A switched-off level is not granted by hand.
  const refused = await post(a.admin, '/api/gifts/admin/grants', {
    userId: 'buyer',
    mode: 'level',
    level: 2,
    reason: 'admin_gift',
    idempotencyKey: 'level-off-key-1',
  });
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'GIFT_LEVEL_INACTIVE');
});

test('a level item is a real product fully pinned; anything less is refused with its own code', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const refuse = async (body: Record<string, unknown>) => {
    const res = await post(a.admin, '/api/gifts/admin/levels/3/items', body);
    return { status: res.status, code: (await json(res)).code as string | undefined };
  };
  assert.deepEqual(await refuse({ ...NOZZLE_04_RED, productId: 'p_bundle', optionValueIds: [], colorId: '' }), {
    status: 400,
    code: 'GIFT_COMPOSITION_UNSUPPORTED',
  });
  assert.deepEqual(await refuse({ ...PLAIN, productId: 'p_draft' }), { status: 400, code: 'GIFT_PRODUCT_INACTIVE' });
  assert.deepEqual(await refuse({ ...PLAIN, productId: 'p_nope' }), { status: 400, code: 'GIFT_PRODUCT_NOT_FOUND' });
  assert.deepEqual(await refuse({ ...NOZZLE_04_RED, optionValueIds: [] }), { status: 400, code: 'GIFT_SELECTION_INVALID' }, 'a model is required');
  assert.deepEqual(await refuse({ ...NOZZLE_04_RED, optionValueIds: ['o_x'] }), { status: 400, code: 'GIFT_SELECTION_INVALID' }, 'another product’s model');
  assert.deepEqual(await refuse({ ...NOZZLE_04_RED, colorId: 'c_black' }), { status: 400, code: 'GIFT_SELECTION_INVALID' }, 'another product’s colour');
  assert.deepEqual(await refuse({ ...PLATE_AIR, transportMethod: '' }), { status: 400, code: 'GIFT_TRANSPORT_REQUIRED' });
  assert.deepEqual(await refuse({ ...PLATE_AIR, transportMethod: 'sea' }), { status: 400, code: 'GIFT_SALE_TYPE_UNAVAILABLE' }, 'a route the model does not offer');
  assert.deepEqual(await refuse({ ...NOZZLE_04_RED, saleType: 'pre_order', transportMethod: 'air' }), {
    status: 400,
    code: 'GIFT_SALE_TYPE_UNAVAILABLE',
  });
  assert.deepEqual(await refuse({ ...NOZZLE_04_RED, saleType: 'bundle' }), { status: 400, code: 'GIFT_SALE_TYPE_UNAVAILABLE' });
  assert.equal((await refuse({ ...NOZZLE_04_RED, qty: 0 })).status, 400);
  assert.equal((await refuse({ ...NOZZLE_04_RED, qty: 100 })).status, 400);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM gift_pool_items'), 0, 'no refusal wrote a row');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'gift.item.%'"), 0);

  // A sold-out model can still be configured: the level offers it as «unavailable» until stock returns.
  const soldOut = await addLevelItem(a.admin, 3, { ...NOZZLE_04_RED, optionValueIds: ['v_06'] });
  assert.equal(soldOut.available, false);
  assert.equal(soldOut.reason, 'OUT_OF_STOCK');

  const item = await addLevelItem(a.admin, 3, { ...NOZZLE_04_RED, qty: 2 });
  assert.equal(item.level, 3);
  assert.equal(item.product_id, 'p_nozzle');
  assert.deepEqual(item.option_value_ids, ['v_04']);
  assert.equal(item.color_id, 'c_red');
  assert.equal(item.qty, 2);
  assert.equal(item.sale_type, 'direct_sale');
  assert.equal(item.active, true);
  assert.equal(item.available, true);
  assert.equal(item.value_iqd, 80000, 'two units at the regular price');
  assert.deepEqual(item.name, { ar: 'طقم فوهات', en: 'Nozzle kit', ckb: 'کیتی نۆزڵ' });
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM gift_pool_items WHERE id = ?', item.id)!;
  assert.equal(stored.stock, 0, 'a product item never carries a private stock count (D6)');
  assert.equal(stored.option_value_ids, '["v_04"]');

  const pre = await addLevelItem(a.admin, 3, PLATE_AIR);
  assert.equal(pre.sale_type, 'pre_order');
  assert.equal(pre.transport_method, 'air');

  // The exact same selection twice in one level is one offer, not two.
  const dup = await post(a.admin, '/api/gifts/admin/levels/3/items', { ...NOZZLE_04_RED, qty: 2 });
  assert.equal(dup.status, 409);
  assert.equal((await json(dup)).code, 'GIFT_ITEM_DUPLICATE');

  const created = auditRows(raw, 'gift.item.create');
  assert.equal(created.length, 3);
  const detail = JSON.parse(created[1].detail);
  assert.equal(detail.level, 3);
  assert.equal(detail.product_id, 'p_nozzle');
  assert.equal(detail.actor, BOSS.id);

  // The editor lists the level's items with what the store says about them today.
  const levels = await json(await get(a.admin, '/api/gifts/admin/levels'));
  assert.deepEqual(levels.levels[2].items.map((i: J) => i.id), [soldOut.id, item.id, pre.id]);
});

test('editing and removing an item: audited, soft, and a legacy label-only row stays read-only', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const item = await addLevelItem(a.admin, 1, NOZZLE_04_RED);

  const res = await put(a.admin, `/api/gifts/admin/items/${item.id}`, { colorId: 'c_blue' });
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.item.color_id, 'c_blue');
  assert.deepEqual(out.item.option_value_ids, ['v_04'], 'the fields not sent are kept');
  const [update] = auditRows(raw, 'gift.item.update');
  const d = JSON.parse(update.detail);
  assert.equal(d.before.colorId, 'c_red');
  assert.equal(d.after.colorId, 'c_blue');

  const badEdit = await put(a.admin, `/api/gifts/admin/items/${item.id}`, { optionValueIds: ['o_x'] });
  assert.equal(badEdit.status, 400);
  assert.equal(row(raw, 'SELECT color_id FROM gift_pool_items WHERE id = ?', item.id)?.color_id, 'c_blue', 'a refused edit changes nothing');

  const del = await send(a.admin, 'DELETE', `/api/gifts/admin/items/${item.id}`);
  assert.equal(del.status, 200);
  assert.equal(row(raw, 'SELECT active FROM gift_pool_items WHERE id = ?', item.id)?.active, 0, 'soft: history keeps pointing at it');
  assert.equal(auditRows(raw, 'gift.item.delete').length, 1);

  // A legacy label-only box item, written through the old editor.
  const legacy = await json(
    await post(a.admin, '/api/reviews/admin/pools', { level: 1, kind: 'accessory', label_ar: 'حامل بكرة', stock: 4 })
  );
  assert.equal(legacy.success, true, JSON.stringify(legacy));
  const legacyId = legacy.item.id as string;
  const ro = await put(a.admin, `/api/gifts/admin/items/${legacyId}`, { qty: 2 });
  assert.equal(ro.status, 409);
  assert.equal((await json(ro)).code, 'GIFT_ITEM_LEGACY');
  const levels = await json(await get(a.admin, '/api/gifts/admin/levels'));
  assert.deepEqual(levels.levels[0].legacy_items.map((i: J) => i.id), [legacyId]);
  assert.deepEqual(levels.levels[0].items.map((i: J) => i.id), [item.id]);

  // …and the old editor never reaches a product item.
  assert.equal((await put(a.admin, `/api/reviews/admin/pools/${item.id}`, { stock: 9 })).status, 404);
  assert.equal((await send(a.admin, 'DELETE', `/api/reviews/admin/pools/${item.id}`)).status, 404);
  const oldList = await json(await get(a.admin, '/api/reviews/admin/pools'));
  assert.deepEqual(oldList.items.map((i: J) => i.id), [legacyId]);
});

test('the options projection names the models, colours and routes an item can pin', async () => {
  const raw = giftWorld();
  const a = apps(raw);
  const res = await get(a.admin, '/api/gifts/admin/products/p_plate/options');
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  const values = out.options.groups.flatMap((g: J) => g.values);
  assert.deepEqual(values.map((v: J) => [v.id, v.sale_types, v.routes]), [['v_pei', ['pre_order'], ['air']]]);
  assert.deepEqual(out.options.colors.map((c: J) => c.id), ['c_black']);
  assert.equal((await get(a.admin, '/api/gifts/admin/products/p_nope/options')).status, 404);
});
