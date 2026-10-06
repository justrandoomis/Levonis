/**
 * «تأكيد وإصدار الكود» — THE ADMIN'S GIFT DECISION (docs/REVIEWS_GIFTS.md §6.2,
 * brief §3, §4, §11). Lane S2. Real migrations, the real gift router, a real
 * database; only the session is stubbed.
 *
 *   - the admin picks every level 1..5 and nothing is preselected or defaulted
 *   - the code is six digits, shown ONCE (`no-store`), stored nowhere raw
 *   - a double press or a retried request makes ONE entitlement and ONE code
 *   - the decision, the entitlement, its snapshot, the verifier, the reward
 *     state and the audit row are one batch — all or nothing
 *   - a manual gift pins one product/variant/colour the store really offers
 *   - the snapshot never moves when the product is edited later
 *   - revoke + re-issue: a new code, the old one dead, audited
 *
 * Run: node --import tsx --test tests/giftIssue.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import {
  addLevelItem,
  giftWorld,
  issue,
  issueOk,
  json,
  myGifts,
  post,
  redeem,
  requestId,
  seedPrinterReward,
  simulateGiftCartLine,
  simulateGiftOrder,
} from './fixtures/giftWorld';
import { count, failingD1, row, stubApp } from './fixtures/app';

const n = (raw: DatabaseSync, sql: string, ...params: unknown[]) => count(raw, sql, ...params);

/** Every value of every table, as text — the haystack the raw code must never be in. */
function everyStoredText(raw: DatabaseSync): string[] {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const out: string[] = [];
  for (const { name } of tables) {
    for (const r of raw.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>) {
      for (const v of Object.values(r)) if (v !== null && v !== undefined) out.push(`${name}:${String(v)}`);
    }
  }
  return out;
}

/** The code as a TOKEN (not a run of digits inside an id, a hash or a timestamp). */
const tokenRe = (code: string) => new RegExp(`(?<![0-9A-Za-z_-])${code}(?![0-9A-Za-z_-])`);

async function levelItemsOneToFive(admin: Parameters<typeof addLevelItem>[0]) {
  for (const level of [1, 2, 3, 4, 5]) {
    await addLevelItem(admin, { level, productId: 'g-plain', saleType: 'direct_sale' });
  }
}

test('the admin issues at each level 1..5, and nothing is preselected or defaulted', async () => {
  const w = giftWorld({ rewards: 5 });
  await levelItemsOneToFive(w.admin);

  // No level, an out-of-range level, a non-number, and the OLD body shape that
  // leaned on the stored predicted tier: all refused, nothing written.
  w.raw.prepare('UPDATE review_rewards SET quality_score = 4 WHERE id = ?').run('rr-1'); // a stale predicted tier
  for (const body of [
    { mode: 'level' },
    { mode: 'level', level: 0 },
    { mode: 'level', level: 6 },
    { mode: 'level', level: 'three' },
    { mode: 'level', level: null },
    { qualityScore: 4, reason: 'Great review with photos and video.' },
  ]) {
    const res = await issue(w.admin, 'rev-1', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await json(res)).code, 'GIFT_LEVEL_REQUIRED', JSON.stringify(body));
  }
  // A level but no mode: the admin must say which kind of gift.
  const noMode = await issue(w.admin, 'rev-1', { level: 3 });
  assert.equal(noMode.status, 400);
  assert.equal((await json(noMode)).code, 'GIFT_MODE_REQUIRED');
  assert.equal(n(w.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0);
  assert.equal(row<{ state: string }>(w.raw, "SELECT state FROM review_rewards WHERE id = 'rr-1'")?.state, 'submitted');

  // Every level is selectable, and the level written is exactly the one chosen.
  for (const level of [1, 2, 3, 4, 5]) {
    const { body, entitlementId } = await issueOk(w.admin, `rev-${level}`, { level, mode: 'level' });
    assert.equal(body.entitlement.level, level);
    assert.equal(body.entitlement.state, 'code_issued');
    const ge = row<{ max_level: number; chosen_level: number; grant_mode: string; state: string }>(
      w.raw,
      'SELECT max_level, chosen_level, grant_mode, state FROM gift_entitlements WHERE id = ?',
      entitlementId
    )!;
    assert.deepEqual(ge, { max_level: level, chosen_level: level, grant_mode: 'level', state: 'code_issued' });
    const rr = row<{ state: string; quality_score: number; decided_by: string }>(
      w.raw,
      'SELECT state, quality_score, decided_by FROM review_rewards WHERE id = ?',
      `rr-${level}`
    )!;
    assert.deepEqual(rr, { state: 'approved', quality_score: level, decided_by: 'boss' });
  }
});

test('the issued code is exactly six digits, answered once with no-store, and the reply never repeats it', async () => {
  const w = giftWorld();
  await addLevelItem(w.admin, { level: 2, productId: 'g-plain', saleType: 'direct_sale' });
  const rid = requestId();
  const res = await post(w.admin, '/api/reviews/admin/rev-1/reward', { action: 'approve', level: 2, mode: 'level', requestId: rid });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const body = await json(res);
  assert.match(body.code, /^\d{6}$/);
  assert.equal(body.code_issued_by, 'boss');
  assert.ok(body.code_issued_at);
  // The same request again: the same entitlement, and the code is NOT shown again.
  const again = await post(w.admin, '/api/reviews/admin/rev-1/reward', { action: 'approve', level: 2, mode: 'level', requestId: rid });
  assert.equal(again.status, 200);
  const replay = await json(again);
  assert.equal(replay.replay, true);
  assert.equal(replay.code, null);
  assert.equal(replay.entitlement.id, body.entitlement.id);
  // No read API returns it either.
  for (const path of ['/api/reviews/admin/gifts', '/api/reviews/admin/queue?state=all']) {
    const text = JSON.stringify(await json(await w.admin.request(path)));
    assert.ok(!tokenRe(body.code).test(text), `${path} leaked the code`);
    assert.ok(!/pbkdf2|code_verifier/.test(text), `${path} leaked the verifier`);
  }
  const customer = JSON.stringify(await myGifts(w.buyer));
  assert.ok(!tokenRe(body.code).test(customer) && !/pbkdf2|code_verifier/.test(customer));
});

test('the raw code is in no column of any table and in no audit row', async () => {
  const w = giftWorld();
  await addLevelItem(w.admin, { level: 3, productId: 'g-mug', saleType: 'direct_sale', optionValueIds: ['v-s'], colorId: 'c-red' });
  const { code, entitlementId } = await issueOk(w.admin, 'rev-1', { level: 3, mode: 'level', note: 'great detail' });
  // A revoke and a re-issue, a wrong try and the redemption add their own rows.
  await post(w.admin, `/api/reviews/admin/gifts/${entitlementId}/revoke-code`, { reason: 'lost by the admin' });
  const re = await json(await post(w.admin, `/api/reviews/admin/gifts/${entitlementId}/reissue-code`, { reason: 'customer asked again', requestId: requestId() }));
  assert.match(re.code, /^\d{6}$/);
  await redeem(w.buyer, entitlementId, re.code === '000000' ? '000001' : '000000');
  assert.equal((await redeem(w.buyer, entitlementId, re.code)).status, 200);

  const stored = everyStoredText(w.raw);
  for (const c of [code, re.code]) {
    const hits = stored.filter((s) => tokenRe(c).test(s));
    assert.deepEqual(hits, [], `the raw code ${c} is stored: ${hits.join(' | ').slice(0, 300)}`);
  }
  // What IS stored: a PBKDF2 verifier with its own salt, bound to the entitlement.
  const ge = row<{ code_verifier: string }>(w.raw, 'SELECT code_verifier FROM gift_entitlements WHERE id = ?', entitlementId)!;
  assert.match(ge.code_verifier, /^pbkdf2\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  // The audit trail has the events, never the code.
  const actions = (w.raw.prepare('SELECT action, detail FROM audit_log ORDER BY id').all() as Array<{ action: string; detail: string }>);
  for (const a of ['gift.issue', 'gift.code.revoke', 'gift.code.reissue', 'gift.redeem.failed', 'gift.redeem']) {
    assert.ok(actions.some((x) => x.action === a), `audit ${a} missing`);
  }
  for (const a of actions) assert.ok(!/"code"\s*:/.test(a.detail), `audit ${a.action} names a code field`);
});

test('a double press with the same requestId makes one entitlement and one code; the replay returns no code', async () => {
  const w = giftWorld();
  await addLevelItem(w.admin, { level: 4, productId: 'g-plain', saleType: 'direct_sale' });
  const rid = requestId();
  const body = { action: 'approve', level: 4, mode: 'level', requestId: rid };
  // Two presses in flight at once.
  const [a, b] = await Promise.all([
    post(w.admin, '/api/reviews/admin/rev-1/reward', body),
    post(w.admin, '/api/reviews/admin/rev-1/reward', body),
  ]);
  const [ja, jb] = [await json(a), await json(b)];
  assert.equal(a.status, 200, JSON.stringify(ja));
  assert.equal(b.status, 200, JSON.stringify(jb));
  const codes = [ja.code, jb.code].filter((x) => x !== null);
  assert.equal(codes.length, 1, 'exactly one response carries a code');
  assert.equal(ja.entitlement.id, jb.entitlement.id);
  assert.ok(ja.replay === true || jb.replay === true);
  assert.equal(n(w.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 1);
  assert.equal(n(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.issue'"), 1);
  // A third press with ANOTHER requestId is a second decision: refused.
  const other = await post(w.admin, '/api/reviews/admin/rev-1/reward', { ...body, requestId: requestId() });
  assert.equal(other.status, 409);
  assert.equal((await json(other)).code, 'GIFT_ALREADY_ISSUED');
  assert.equal(n(w.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 1);
});

test('the decision is one batch: a failure anywhere writes nothing (reward, entitlement, audit)', async () => {
  const w = giftWorld();
  await addLevelItem(w.admin, { level: 2, productId: 'g-plain', saleType: 'direct_sale' });
  const { failing, db } = failingD1(w.raw);
  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO audit_log/.test(s.sql)) && stmts.some((s) => /INSERT INTO gift_entitlements/.test(s.sql));
  const admin = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, w.mount);
  const res = await issue(admin, 'rev-1', { level: 2, mode: 'level' });
  assert.ok(res.status >= 500, `a failed batch is not a success (${res.status})`);
  assert.equal(n(w.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0);
  assert.equal(row<{ state: string }>(w.raw, "SELECT state FROM review_rewards WHERE id = 'rr-1'")?.state, 'submitted');
  assert.equal(n(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'gift.%'"), 0);
  // The same request succeeds once the database is healthy again.
  failing.failWhen = null;
  assert.equal((await issue(admin, 'rev-1', { level: 2, mode: 'level' })).status, 200);
  assert.equal(n(w.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 1);
});

test('the eligibility re-check runs at issue: an unlinked printer or a lowered star rating is refused, nothing written', async () => {
  const w = giftWorld({ rewards: 2 });
  await addLevelItem(w.admin, { level: 1, productId: 'g-plain', saleType: 'direct_sale' });
  w.raw.prepare("UPDATE device_registrations SET revoked_at = '2026-09-05T00:00:00.000Z' WHERE unit_id = 'unit-1'").run();
  const unlinked = await issue(w.admin, 'rev-1', { level: 1, mode: 'level' });
  assert.equal(unlinked.status, 409);
  assert.equal((await json(unlinked)).code, 'GIFT_ELIGIBILITY_CHANGED');
  w.raw.prepare("UPDATE reviews SET stars = 4 WHERE id = 'rev-2'").run();
  const lowered = await issue(w.admin, 'rev-2', { level: 1, mode: 'level' });
  assert.equal(lowered.status, 409);
  assert.equal((await json(lowered)).code, 'GIFT_ELIGIBILITY_CHANGED');
  assert.equal(n(w.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0);
  assert.equal(n(w.raw, "SELECT COUNT(*) AS n FROM review_rewards WHERE state = 'approved'"), 0);
  // A unit registered to ANOTHER account is not the reviewer's link either.
  const third = seedPrinterReward(w.raw, 3);
  w.raw.prepare('UPDATE device_registrations SET user_id = ? WHERE unit_id = ?').run('other', third.unitId);
  assert.equal((await json(await issue(w.admin, third.reviewId, { level: 1, mode: 'level' }))).code, 'GIFT_ELIGIBILITY_CHANGED');
});

test('an empty level, a rejected reward and a system review are refused by name', async () => {
  const w = giftWorld({ rewards: 2 });
  const empty = await issue(w.admin, 'rev-1', { level: 5, mode: 'level' });
  assert.equal(empty.status, 400);
  assert.equal((await json(empty)).code, 'GIFT_LEVEL_EMPTY');
  // A disabled item does not count.
  const item = await addLevelItem(w.admin, { level: 5, productId: 'g-plain', saleType: 'direct_sale', active: false });
  assert.equal(item.active, false);
  assert.equal((await json(await issue(w.admin, 'rev-1', { level: 5, mode: 'level' }))).code, 'GIFT_LEVEL_EMPTY');

  await post(w.admin, '/api/reviews/admin/rev-2/reward', { action: 'reject', reason: 'not this time' });
  const rejected = await issue(w.admin, 'rev-2', { level: 1, mode: 'manual', manual: { productId: 'g-plain', saleType: 'direct_sale' } });
  assert.equal(rejected.status, 409);
  assert.equal((await json(rejected)).code, 'GIFT_REWARD_REJECTED');

  w.raw.prepare("UPDATE reviews SET source = 'system' WHERE id = 'rev-1'").run();
  const system = await issue(w.admin, 'rev-1', { level: 1, mode: 'manual', manual: { productId: 'g-plain', saleType: 'direct_sale' } });
  assert.equal(system.status, 400);
  assert.equal((await json(system)).code, 'SYSTEM_REVIEW_NO_REWARD');
  assert.equal(n(w.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0);
});

test('a manual gift pins one product, variant and colour and overrides the level items', async () => {
  const w = giftWorld();
  // Level 3 holds other products; the manual gift ignores them.
  await addLevelItem(w.admin, { level: 3, productId: 'g-plain', saleType: 'direct_sale' });
  await addLevelItem(w.admin, { level: 3, productId: 'g-spool', saleType: 'pre_order', transportMethod: 'air', optionValueIds: ['m-pla'], colorId: 'c-black' });
  const { entitlementId, code, body } = await issueOk(w.admin, 'rev-1', {
    level: 3,
    mode: 'manual',
    manual: { productId: 'g-mug', saleType: 'direct_sale', optionValueIds: ['v-s'], colorId: 'c-red' },
  });
  assert.equal(body.entitlement.grant_mode, 'manual');
  const ge = row<Record<string, unknown>>(
    w.raw,
    `SELECT grant_mode, max_level, gift_item_ref, gift_product_id, gift_option_value_ids, gift_color_id, gift_sale_type,
            gift_transport_method, gift_snapshot FROM gift_entitlements WHERE id = ?`,
    entitlementId
  )!;
  assert.equal(ge.grant_mode, 'manual');
  assert.equal(ge.max_level, 3, 'the admin still records the judgement as a level');
  assert.equal(ge.gift_item_ref, 'manual');
  assert.equal(ge.gift_product_id, 'g-mug');
  assert.equal(ge.gift_option_value_ids, '["v-s"]');
  assert.equal(ge.gift_color_id, 'c-red');
  assert.equal(ge.gift_sale_type, 'direct_sale');
  const snap = JSON.parse(String(ge.gift_snapshot));
  assert.equal(snap.mode, 'manual');
  assert.equal(snap.items.length, 1, 'one product, not the level’s items');
  assert.equal(snap.items[0].display.name_ar, 'كوب ليفونيس');
  assert.equal(snap.items[0].display.variant_ckb, 'بچووک');
  assert.equal(snap.items[0].display.color_name_ar, 'أحمر');
  assert.equal(snap.items[0].display.regular_iqd, 20000);
  assert.equal(snap.items[0].display.image, '/files/products/g-mug/main.webp');

  // After redeeming it is READY at once, and the customer cannot swap it.
  assert.equal((await redeem(w.buyer, entitlementId, code)).status, 200);
  const card = (await myGifts(w.buyer)).gifts[0];
  assert.equal(card.ui_state, 'ready');
  assert.equal(card.chosen.product_id, 'g-mug');
  assert.equal(card.chosen.display.color_name_ckb, 'سوور');
  const swap = await post(w.buyer, `/api/reviews/gifts/${entitlementId}/choose`, { ref: 'manual', optionValueIds: ['v-l'] });
  assert.equal(swap.status, 400);
  assert.equal((await json(swap)).code, 'GIFT_CHOICE_INVALID');
  assert.equal(row<{ gift_option_value_ids: string }>(w.raw, 'SELECT gift_option_value_ids FROM gift_entitlements WHERE id = ?', entitlementId)?.gift_option_value_ids, '["v-s"]');
});

test('a manual gift is validated by the store’s own rules — every refusal writes nothing', async () => {
  const w = giftWorld();
  const cases: Array<[Record<string, unknown>, string, string | null]> = [
    // A value of ANOTHER product.
    [{ productId: 'g-mug', saleType: 'direct_sale', optionValueIds: ['o-x'], colorId: 'c-blue' }, 'GIFT_SELECTION_INVALID', 'OPTION_VALUE_NOT_FOUND'],
    // A colour not linked to the chosen option (c-red is Small only).
    [{ productId: 'g-mug', saleType: 'direct_sale', optionValueIds: ['v-l'], colorId: 'c-red' }, 'GIFT_SELECTION_INVALID', 'COLOR_OPTION_MISMATCH'],
    // A colour of another product.
    [{ productId: 'g-mug', saleType: 'direct_sale', optionValueIds: ['v-s'], colorId: 'c-black' }, 'GIFT_SELECTION_INVALID', 'COLOR_NOT_FOUND'],
    // An option group left empty.
    [{ productId: 'g-mug', saleType: 'direct_sale', optionValueIds: [], colorId: 'c-blue' }, 'GIFT_SELECTION_INVALID', 'OPTION_GROUP_REQUIRED'],
    // A sale type this product does not offer.
    [{ productId: 'g-plain', saleType: 'pre_order', transportMethod: 'air' }, 'GIFT_SALE_TYPE_UNAVAILABLE', null],
    [{ productId: 'g-spool', saleType: 'direct_sale', optionValueIds: ['m-pla'], colorId: 'c-black' }, 'GIFT_SALE_TYPE_UNAVAILABLE', null],
    // A pre-order without its route, and with a route it does not offer.
    [{ productId: 'g-spool', saleType: 'pre_order', optionValueIds: ['m-pla'], colorId: 'c-black' }, 'GIFT_TRANSPORT_REQUIRED', null],
    [{ productId: 'g-spool', saleType: 'pre_order', transportMethod: 'sea', optionValueIds: ['m-pla'], colorId: 'c-black' }, 'GIFT_SALE_TYPE_UNAVAILABLE', null],
    // Bundles and mystery offers are never gifts; a draft product is not on sale.
    [{ productId: 'g-bundle', saleType: 'direct_sale' }, 'GIFT_COMPOSITION_UNSUPPORTED', null],
    [{ productId: 'g-draft', saleType: 'direct_sale' }, 'GIFT_PRODUCT_INACTIVE', null],
    [{ productId: 'nope', saleType: 'direct_sale' }, 'GIFT_PRODUCT_NOT_FOUND', null],
  ];
  for (const [manual, code, storeCode] of cases) {
    const res = await issue(w.admin, 'rev-1', { level: 2, mode: 'manual', manual });
    const body = await json(res);
    assert.equal(res.status, 400, `${JSON.stringify(manual)} → ${res.status} ${JSON.stringify(body)}`);
    assert.equal(body.code, code, JSON.stringify(manual));
    if (storeCode) assert.ok(body.details.errors.includes(storeCode), `${JSON.stringify(manual)}: ${JSON.stringify(body.details)}`);
  }
  assert.equal(n(w.raw, 'SELECT COUNT(*) AS n FROM gift_entitlements'), 0);
  assert.equal(row<{ state: string }>(w.raw, "SELECT state FROM review_rewards WHERE id = 'rr-1'")?.state, 'submitted');
  assert.equal(n(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.issue'"), 0);
  // And the valid pre-order with its route is accepted.
  const ok = await issueOk(w.admin, 'rev-1', {
    level: 2,
    mode: 'manual',
    manual: { productId: 'g-spool', saleType: 'pre_order', transportMethod: 'air', optionValueIds: ['m-petg'], colorId: 'c-black' },
  });
  assert.equal(row<{ gift_transport_method: string }>(w.raw, 'SELECT gift_transport_method FROM gift_entitlements WHERE id = ?', ok.entitlementId)?.gift_transport_method, 'air');
});

test('editing the product after issue leaves gift_snapshot unchanged', async () => {
  const w = giftWorld();
  await addLevelItem(w.admin, { level: 2, productId: 'g-mug', saleType: 'direct_sale', optionValueIds: ['v-l'], colorId: 'c-blue' });
  const { entitlementId } = await issueOk(w.admin, 'rev-1', { level: 2, mode: 'level' });
  const before = row<{ gift_snapshot: string }>(w.raw, 'SELECT gift_snapshot FROM gift_entitlements WHERE id = ?', entitlementId)!.gift_snapshot;
  // The catalogue moves on: new names, a new price, a renamed value and colour, a new image.
  w.raw.exec(`
    UPDATE products SET name = 'Renamed Mug', name_ar = 'كوب جديد', price_iqd = 99000 WHERE id = 'g-mug';
    UPDATE product_option_values SET name_en = 'XL', name_ar = 'كبير جدا' WHERE id = 'v-l';
    UPDATE product_colors SET name_en = 'Navy', hex = '#000080' WHERE id = 'c-blue';
    UPDATE product_images SET url = '/files/products/g-mug/v2.webp', r2_key = 'products/g-mug/v2.webp' WHERE id = 'img-mug';
  `);
  // And the level item itself is edited and then deleted.
  const items = (await json(await w.admin.request('/api/reviews/admin/pools'))).items;
  await w.admin.request(`/api/reviews/admin/pools/${items[0].id}`, { method: 'DELETE' });
  const after = row<{ gift_snapshot: string }>(w.raw, 'SELECT gift_snapshot FROM gift_entitlements WHERE id = ?', entitlementId)!.gift_snapshot;
  assert.equal(after, before, 'the granted gift is frozen');
  const card = (await myGifts(w.buyer)).gifts[0];
  assert.equal(card.items[0].display.name_ar, 'كوب ليفونيس');
  assert.equal(card.items[0].display.variant_en, 'Large');
  assert.equal(card.items[0].display.color_name, 'Blue');
  assert.equal(card.items[0].display.regular_iqd, 20000);
  assert.equal(card.items[0].display.image, '/files/products/g-mug/main.webp');
});

test('revoke and re-issue: a new code, the old one dead, both audited', async () => {
  const w = giftWorld();
  await addLevelItem(w.admin, { level: 1, productId: 'g-plain', saleType: 'direct_sale' });
  const { entitlementId, code: first } = await issueOk(w.admin, 'rev-1', { level: 1, mode: 'level' });

  const short = await post(w.admin, `/api/reviews/admin/gifts/${entitlementId}/revoke-code`, { reason: 'x' });
  assert.equal(short.status, 400, 'a reason is required');
  const revoked = await post(w.admin, `/api/reviews/admin/gifts/${entitlementId}/revoke-code`, { reason: 'the admin lost it' });
  assert.equal(revoked.status, 200);
  assert.equal((await json(revoked)).gift.code_state, 'revoked');
  assert.equal((await json(await post(w.admin, `/api/reviews/admin/gifts/${entitlementId}/revoke-code`, { reason: 'again please' }))).code, 'GIFT_CODE_NOT_ACTIVE');
  // The revoked code is dead.
  const dead = await redeem(w.buyer, entitlementId, first);
  assert.equal(dead.status, 400);
  assert.equal((await json(dead)).code, 'GIFT_CODE_INVALID');
  assert.equal((await myGifts(w.buyer)).gifts[0].ui_state, 'awaiting_code');

  const rid = requestId();
  const re = await post(w.admin, `/api/reviews/admin/gifts/${entitlementId}/reissue-code`, { reason: 'send the customer a new one', requestId: rid });
  assert.equal(re.status, 200);
  assert.equal(re.headers.get('Cache-Control'), 'no-store');
  const second = (await json(re)).code;
  assert.match(second, /^\d{6}$/);
  const replay = await json(await post(w.admin, `/api/reviews/admin/gifts/${entitlementId}/reissue-code`, { reason: 'send the customer a new one', requestId: rid }));
  assert.equal(replay.replay, true);
  assert.equal(replay.code, null);
  const ge = row<{ code_version: number; code_attempts: number; code_state: string }>(
    w.raw,
    'SELECT code_version, code_attempts, code_state FROM gift_entitlements WHERE id = ?',
    entitlementId
  )!;
  assert.deepEqual(ge, { code_version: 2, code_attempts: 1, code_state: 'issued' }, 'version 2; the failed try above was on version 1 and was reset');
  if (first !== second) assert.equal((await redeem(w.buyer, entitlementId, first)).status, 400, 'the first code stays dead');
  assert.equal((await redeem(w.buyer, entitlementId, second)).status, 200);
  // Past the code stage there is nothing to re-issue.
  const late = await post(w.admin, `/api/reviews/admin/gifts/${entitlementId}/reissue-code`, { reason: 'too late now', requestId: requestId() });
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'GIFT_NOT_AWAITING_CODE');
  assert.equal(n(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.code.revoke'"), 1);
  assert.equal(n(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.code.reissue'"), 1);
});

test('the admin cancel: from awaiting the code or ready (its cart line goes too); an ordered gift is refused', async () => {
  const w = giftWorld({ rewards: 3 });
  await addLevelItem(w.admin, { level: 1, productId: 'g-plain', saleType: 'direct_sale' });
  const a = await issueOk(w.admin, 'rev-1', { level: 1, mode: 'level' });
  const cancelA = await post(w.admin, `/api/reviews/admin/gifts/${a.entitlementId}/cancel`, { reason: 'fraud suspected' });
  assert.equal(cancelA.status, 200);
  const ga = row<Record<string, unknown>>(w.raw, 'SELECT state, code_state, cancelled_by, cancel_reason FROM gift_entitlements WHERE id = ?', a.entitlementId)!;
  assert.deepEqual(ga, { state: 'cancelled', code_state: 'revoked', cancelled_by: 'boss', cancel_reason: 'fraud suspected' });
  assert.equal((await redeem(w.buyer, a.entitlementId, a.code)).status, 400, 'its code died with it');

  const b = await issueOk(w.admin, 'rev-2', { level: 1, mode: 'level' });
  await redeem(w.buyer, b.entitlementId, b.code);
  simulateGiftCartLine(w.raw, b.entitlementId);
  assert.equal(n(w.raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', b.entitlementId), 1);
  assert.equal((await post(w.admin, `/api/reviews/admin/gifts/${b.entitlementId}/cancel`, { reason: 'customer asked' })).status, 200);
  assert.equal(n(w.raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE gift_entitlement_id = ?', b.entitlementId), 0, 'the cart line went in the same batch');
  assert.equal((await myGifts(w.buyer)).gifts.find((g: { id: string }) => g.id === b.entitlementId).ui_state, 'cancelled');

  const c = await issueOk(w.admin, 'rev-3', { level: 1, mode: 'level' });
  await redeem(w.buyer, c.entitlementId, c.code);
  simulateGiftOrder(w.raw, c.entitlementId);
  const refused = await post(w.admin, `/api/reviews/admin/gifts/${c.entitlementId}/cancel`, { reason: 'too late for this' });
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'GIFT_ALREADY_ORDERED');
  assert.equal(n(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gift.cancel'"), 2);
});

test('a legacy available gift is converted by issuing a code; other legacy states are not', async () => {
  const w = giftWorld();
  // Pre-0165 rows: a legacy reward (no unit) approved under the old program.
  const legacy = seedPrinterReward(w.raw, 7, { legacy: true });
  w.raw.exec(`
    UPDATE review_rewards SET state = 'approved', quality_score = 3 WHERE id = '${legacy.rewardId}';
    INSERT INTO gift_entitlements (id, reward_id, user_id, max_level, state, created_at)
    VALUES ('gent_legacy', '${legacy.rewardId}', 'buyer', 3, 'available', '2026-08-01T00:00:00.000Z');
  `);
  await addLevelItem(w.admin, { level: 2, productId: 'g-plain', saleType: 'direct_sale' });
  assert.equal((await myGifts(w.buyer)).gifts.find((g: { id: string }) => g.id === 'gent_legacy').ui_state, 'legacy');
  // Re-approving the legacy reward is not the way; the answer names the gift to convert.
  const again = await issue(w.admin, legacy.reviewId, { level: 2, mode: 'level' });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).details.legacy, true);

  const res = await post(w.admin, '/api/reviews/admin/gifts/gent_legacy/issue', { level: 2, mode: 'level', requestId: requestId() });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const out = await json(res);
  assert.match(out.code, /^\d{6}$/);
  const ge = row<Record<string, unknown>>(w.raw, "SELECT state, grant_mode, max_level, code_state FROM gift_entitlements WHERE id = 'gent_legacy'")!;
  assert.deepEqual(ge, { state: 'code_issued', grant_mode: 'level', max_level: 2, code_state: 'issued' });
  assert.equal((await redeem(w.buyer, 'gent_legacy', out.code)).status, 200);
  assert.equal((await json(await post(w.admin, '/api/reviews/admin/gifts/gent_legacy/issue', { level: 2, mode: 'level', requestId: requestId() }))).code, 'GIFT_ALREADY_ISSUED');

  w.raw.exec(`
    INSERT INTO reviews (id,user_id,product_id,order_item_id,order_id,stars,body,media,status,source)
    VALUES ('rev-sel','other','printer-7','oi-7','ORD-7',5,'old review','[]','published','user');
    INSERT INTO review_rewards (id,review_id,user_id,kind,state) VALUES ('rr-sel','rev-sel','other','printer_gift','approved');
    INSERT INTO gift_entitlements (id, reward_id, user_id, max_level, state, chosen_level, created_at)
    VALUES ('gent_sel', 'rr-sel', 'other', 2, 'selected', 2, '2026-08-01T00:00:00.000Z');
  `);
  const notConvertible = await post(w.admin, '/api/reviews/admin/gifts/gent_sel/issue', { level: 2, mode: 'level', requestId: requestId() });
  assert.equal(notConvertible.status, 409);
  assert.equal((await json(notConvertible)).code, 'GIFT_NOT_CONVERTIBLE');
  // The legacy hand-over still works for a selected row, and only for it.
  assert.equal((await post(w.admin, '/api/reviews/admin/gifts/gent_sel/fulfill', {})).status, 200);
  assert.equal((await post(w.admin, '/api/reviews/admin/gifts/gent_legacy/fulfill', {})).status, 400);
});

test('reject and request-changes keep their behaviour and never touch publication', async () => {
  const w = giftWorld({ rewards: 2 });
  const rc = await post(w.admin, '/api/reviews/admin/rev-1/reward', { action: 'request_changes', reason: 'add a photo of the first layer' });
  assert.equal(rc.status, 200);
  assert.equal((await json(rc)).reward_state, 'revision_needed');
  // A reward waiting for changes can still be issued.
  await addLevelItem(w.admin, { level: 1, productId: 'g-plain', saleType: 'direct_sale' });
  assert.equal((await issue(w.admin, 'rev-1', { level: 1, mode: 'level' })).status, 200);
  const rj = await post(w.admin, '/api/reviews/admin/rev-2/reward', { action: 'reject', reason: 'not eligible' });
  assert.equal(rj.status, 200);
  assert.equal(row<{ status: string }>(w.raw, "SELECT status FROM reviews WHERE id = 'rev-2'")?.status, 'published');
  // A decided (approved) reward is never re-decided.
  assert.equal((await post(w.admin, '/api/reviews/admin/rev-1/reward', { action: 'reject', reason: 'changed my mind' })).status, 409);
});
