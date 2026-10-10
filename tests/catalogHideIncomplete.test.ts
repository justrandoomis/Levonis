/**
 * «إخفاء المنتجات الناقصة عن الزبائن» — THE OWNER'S SWITCH, END TO END (owner
 * brief 2026-10-10: «اخفاء كل المنتجات التي تنقصها التكاليف والحقول الناقصه»;
 * worker/lib/listing.ts, worker/routes/adminCompleteness.ts, migration 0184).
 *
 * One complete product (`p_full`) and one that misses its cost (`p_gap`), the
 * customer surfaces reached through the REAL Worker as a signed-out shopper
 * (and the cart as a signed-in one), the admin doors through the stubbed
 * session. Proves:
 *   - OFF (the default): every surface answers exactly as before — the
 *     incomplete product is listed, searchable, on the home page, its page and
 *     the public API answer, the sitemap names it, the cart takes it;
 *   - the owner reads the count first; the switch refuses a stale count
 *     (HIDE_COUNT_CHANGED) and unchecked products (COMPLETENESS_NOT_READY);
 *   - ON: it is gone from the listing, search, home, its page (404), the quote,
 *     the public API (list, page, counts), the sitemap, compare, the cart's
 *     add (404) and view — while every admin read still shows it, flagged;
 *   - completing it (the data file's apply, a real write) shows it again with
 *     no other act, and turning the switch off restores everything;
 *   - only the verified owner moves the switch (a full admin, an assistant and
 *     an unverified owner are refused; the generic settings PUT refuses it);
 *   - a database without 0184 lists exactly as before.
 *
 * Run: node --import tsx --test tests/catalogHideIncomplete.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, dbThrough, get, json, post, put } from './fixtures/app';
import { ASSISTANT, CUSTOMER, FULL_ADMIN, OWNER, recount, seedCatalog, seedProduct, world, type World } from './fixtures/completeness';
import { listedWithoutHeld, listing, optimisticListed, runListed, withoutHeld } from '../worker/lib/listing';

const slugsOf = (body: Record<string, unknown>): string[] => {
  const list = (body.products ?? (body.data as unknown[]) ?? []) as Array<{ slug?: string }>;
  return list.map((p) => String(p.slug ?? ''));
};

async function listingSlugs(w: World, query = ''): Promise<string[]> {
  const res = await w.guest(`/api/products${query}`);
  assert.equal(res.status, 200, await res.clone().text());
  return slugsOf(await json(res));
}

async function surfaces(w: World) {
  const listingAll = await listingSlugs(w);
  const search = await listingSlugs(w, '?search=Gap');
  const home = await json(await w.guest('/api/home'));
  const homeLatest = ((home.latest ?? home.products ?? []) as Array<{ slug?: string }>).map((p) => String(p.slug ?? ''));
  const detail = (await w.guest('/api/products/gap-printer')).status;
  const quote = (await w.guest('/api/products/gap-printer/quote', { method: 'POST', body: { qty: 1 } })).status;
  const apiList = slugsOf(await json(await w.guest('/api/public/v1/products')));
  const apiDetail = (await w.guest('/api/public/v1/products/gap-printer')).status;
  const sitemap = await (await w.guest('/sitemap.xml')).text();
  return { listingAll, search, homeLatest, detail, quote, apiList, apiDetail, sitemap };
}

async function setSwitch(w: World, enabled: boolean, user = OWNER) {
  const summary = await json(await get(w.admin(user), '/api/admin/products-v2/completeness/summary'));
  return put(w.admin(user), '/api/admin/products-v2/completeness/hide', {
    enabled,
    ...(enabled ? { expected_count: summary.summary?.would_hide } : {}),
  });
}

test('OFF (the default): every customer surface answers exactly as before, the incomplete product included', async () => {
  const w = world();
  await recount(w);
  assert.equal(Number(w.raw.prepare("SELECT COUNT(*) AS n FROM product_completeness WHERE held = 1").get()!.n), 0, 'nothing is held while the switch is off');
  const s = await surfaces(w);
  assert.ok(s.listingAll.includes('gap-printer') && s.listingAll.includes('full-printer'));
  assert.ok(s.search.includes('gap-printer'), 'search finds it');
  assert.ok(s.homeLatest.includes('gap-printer'), 'the home page carries it');
  assert.equal(s.detail, 200);
  assert.equal(s.quote, 200);
  assert.ok(s.apiList.includes('gap-printer'));
  assert.equal(s.apiDetail, 200);
  assert.match(s.sitemap, /gap-printer/);
  assert.equal((await json(await w.guest('/api/public/v1/context'))).content.products, 2, 'the public counts include it');
  // The cart takes it.
  const add = await post(w.shopper(), '/api/cart/items', { productId: 'p_gap', qty: 1 });
  assert.equal(add.status, 200, await add.clone().text());
});

test('the owner reads the count; the switch refuses a moved count and unchecked products, then turns on in one batch', async () => {
  const w = world();
  // Nothing checked yet: refused.
  const notReady = await put(w.admin(), '/api/admin/products-v2/completeness/hide', { enabled: true, expected_count: 0 });
  assert.equal(notReady.status, 409);
  assert.equal((await json(notReady)).code, 'COMPLETENESS_NOT_READY');
  await recount(w);
  const summary = (await json(await get(w.admin(), '/api/admin/products-v2/completeness/summary'))).summary;
  assert.equal(summary.would_hide, 1);
  assert.equal(summary.enabled, false);
  assert.equal(summary.stale, 0);
  const wrong = await put(w.admin(), '/api/admin/products-v2/completeness/hide', { enabled: true, expected_count: 0 });
  assert.equal(wrong.status, 409);
  const wrongBody = await json(wrong);
  assert.equal(wrongBody.code, 'HIDE_COUNT_CHANGED');
  assert.equal(wrongBody.details.summary.would_hide, 1, 'the refusal carries the fresh count');
  const on = await put(w.admin(), '/api/admin/products-v2/completeness/hide', { enabled: true, expected_count: 1 });
  assert.equal(on.status, 200, await on.clone().text());
  assert.equal((await json(on)).summary.held, 1);
  assert.deepEqual(
    w.raw.prepare('SELECT product_id FROM product_completeness WHERE held = 1').all().map((r) => r.product_id),
    ['p_gap']
  );
  const audit = w.raw.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'catalog.hide_incomplete.%'").all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.action, 'catalog.hide_incomplete.enabled');
  // Idempotent: the same state again is a no-op.
  const again = await setSwitch(w, true);
  assert.equal((await json(again)).already, true);
  assert.equal(w.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'catalog.hide_incomplete.%'").get()!.n, 1);
});

test('ON: the incomplete product is gone from every customer surface — and every admin read still shows it, flagged', async () => {
  const w = world();
  await recount(w);
  assert.equal((await setSwitch(w, true)).status, 200);
  const s = await surfaces(w);
  assert.ok(!s.listingAll.includes('gap-printer') && s.listingAll.includes('full-printer'), 'listing');
  assert.ok(!s.search.includes('gap-printer'), 'search');
  assert.ok(!s.homeLatest.includes('gap-printer'), 'home');
  assert.equal(s.detail, 404, 'its page answers as a hidden product does');
  assert.equal(s.quote, 404, 'the quote too');
  assert.ok(!s.apiList.includes('gap-printer') && s.apiList.includes('full-printer'), 'public API list');
  assert.equal(s.apiDetail, 404, 'public API page');
  assert.doesNotMatch(s.sitemap, /gap-printer/);
  assert.match(s.sitemap, /full-printer/);
  const ctx = await json(await w.guest('/api/public/v1/context'));
  assert.equal(ctx.content.products, 1, 'the public counts leave it out');
  const cmp = await w.guest('/api/compare?ids=p_full,p_gap');
  assert.equal(cmp.status, 400, 'compare refuses it as not on display');
  assert.equal((await json(cmp)).code, 'COMPARE_NOT_VISIBLE');
  // The cart: refused at the add, as a hidden product is.
  const add = await post(w.shopper(), '/api/cart/items', { productId: 'p_gap', qty: 1 });
  assert.equal(add.status, 404);
  // Admin: the list shows it, flagged; its own read is unchanged.
  const list = await json(await get(w.admin(), '/api/admin/products-v2?limit=50'));
  const row = (list.products as Array<{ id: string; held: boolean; missing_count: number | null }>).find((p) => p.id === 'p_gap')!;
  assert.equal(row.held, true);
  assert.equal(row.missing_count, 1);
  assert.equal((await get(w.admin(), '/api/admin/products-v2/p_gap')).status, 200);
  const only = await json(await get(w.admin(), '/api/admin/products-v2?incomplete=1'));
  assert.deepEqual((only.products as Array<{ id: string }>).map((p) => p.id), ['p_gap']);
  // Nothing about the product itself moved.
  assert.equal(w.raw.prepare("SELECT status FROM products WHERE id = 'p_gap'").get()!.status, 'active');
});

test('a cart line already holding it drops out of the cart view while the switch is on, and comes back', async () => {
  const w = world();
  await recount(w);
  assert.equal((await post(w.shopper(), '/api/cart/items', { productId: 'p_gap', qty: 1 })).status, 200);
  const before = await json(await get(w.shopper(), '/api/cart'));
  assert.equal((before.items as unknown[]).length, 1);
  await setSwitch(w, true);
  const during = await json(await get(w.shopper(), '/api/cart'));
  assert.equal((during.items as unknown[]).length, 0, 'held: read as a hidden product');
  assert.equal(w.raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE product_id = 'p_gap'").get()!.n, 1, 'the line itself is untouched');
  await setSwitch(w, false);
  const after = await json(await get(w.shopper(), '/api/cart'));
  assert.equal((after.items as unknown[]).length, 1);
});

test('completing the product (the data file, a real write) shows it again at once; turning the switch off restores everything', async () => {
  const w = world();
  await recount(w);
  await setSwitch(w, true);
  assert.equal((await w.guest('/api/products/gap-printer')).status, 404);

  // The owner's data file: the preview names what would still be missing, then the apply writes the cost.
  const file = await (await get(w.admin(), '/api/admin/template/data-export/p_gap')).text();
  const unchanged = await json(await post(w.admin(), '/api/admin/template/data-preview', { text: file, product_id: 'p_gap' }));
  assert.deepEqual(unchanged.products[0].completeness.after.map((i: { code: string }) => i.code), ['COST'], 'still missing: the cost');
  const edited = file.replace(/^product_cost_iqd=.*$/m, 'product_cost_iqd=65000');
  assert.notEqual(edited, file);
  const pv = await json(await post(w.admin(), '/api/admin/template/data-preview', { text: edited, product_id: 'p_gap' }));
  const card = pv.products[0];
  assert.deepEqual(card.completeness.before.map((i: { code: string }) => i.code), ['COST']);
  assert.deepEqual(card.completeness.after, [], 'complete after the apply');
  const applied = await post(w.admin(), '/api/admin/template/data-apply', { text: edited, product_id: 'p_gap', token: card.token });
  assert.equal(applied.status, 200, await applied.clone().text());

  const row = w.raw.prepare("SELECT complete, held FROM product_completeness WHERE product_id = 'p_gap'").get()!;
  assert.deepEqual({ complete: row.complete, held: row.held }, { complete: 1, held: 0 }, 're-evaluated by the write itself');
  assert.equal((await w.guest('/api/products/gap-printer')).status, 200, 'shown again');
  assert.ok((await listingSlugs(w)).includes('gap-printer'));

  // Break it again, then switch off: shown whatever its state.
  w.raw.exec("UPDATE products SET product_cost_iqd = NULL, updated_at = '2026-10-02T00:00:00.000Z' WHERE id = 'p_gap'");
  await recount(w);
  assert.equal((await w.guest('/api/products/gap-printer')).status, 404);
  assert.equal((await setSwitch(w, false)).status, 200);
  assert.equal((await w.guest('/api/products/gap-printer')).status, 200);
  assert.equal(Number(w.raw.prepare('SELECT COUNT(*) AS n FROM product_completeness WHERE held = 1').get()!.n), 0);
});

test('only the verified owner moves the switch or reads its count; the generic settings PUT refuses it', async () => {
  const w = world();
  await recount(w);
  for (const user of [FULL_ADMIN, ASSISTANT, { ...OWNER, email_verified_at: null }]) {
    const res = await put(w.admin(user), '/api/admin/products-v2/completeness/hide', { enabled: true, expected_count: 1 });
    assert.equal(res.status, 403, `${user.id} ${user.email_verified_at === null ? '(unverified)' : ''}`);
    assert.equal((await get(w.admin(user), '/api/admin/products-v2/completeness/summary')).status, 403);
    assert.equal((await post(w.admin(user), '/api/admin/products-v2/completeness/refresh', {})).status, 403);
  }
  const raw = await put(w.admin(), '/api/admin/settings/catalogHideIncomplete', { value: { enabled: true } });
  assert.equal(raw.status, 400);
  assert.equal((await json(raw)).code, 'HIDE_SWITCH_ROUTE');
  assert.equal(w.raw.prepare("SELECT COUNT(*) AS n FROM admin_settings WHERE key = 'catalogHideIncomplete'").get()!.n, 0, 'nothing stored');
  assert.equal(Number(w.raw.prepare('SELECT COUNT(*) AS n FROM product_completeness WHERE held = 1').get()!.n), 0);
});

test('the flags: the owner reads the private field by name; any other admin reads one OWNER_DATA item', async () => {
  const w = world();
  await recount(w);
  const owner = await json(await get(w.admin(), '/api/admin/products-v2/p_gap/completeness'));
  assert.deepEqual(owner.items.map((i: { code: string }) => i.code), ['COST']);
  assert.equal(owner.complete, false);
  for (const user of [FULL_ADMIN, ASSISTANT]) {
    const body = await json(await get(w.admin(user), '/api/admin/products-v2/p_gap/completeness'));
    assert.deepEqual(body.items.map((i: { code: string }) => i.code), ['OWNER_DATA'], user.id);
    assert.ok(!JSON.stringify(body).includes('COST'), 'the private code never travels');
    const list = await json(await get(w.admin(user), '/api/admin/products-v2?limit=50'));
    assert.equal((list.products as Array<{ id: string; missing_count: number }>).find((p) => p.id === 'p_gap')!.missing_count, 1);
  }
  const full = await json(await get(w.admin(), '/api/admin/products-v2/p_full/completeness'));
  assert.deepEqual(full.items, []);
  assert.equal(full.complete, true);
});

test('a database without 0184 lists exactly as before (the predicate falls back; no completeness route breaks a read)', async () => {
  const raw = dbThrough('0183');
  seedCatalog(raw);
  seedProduct(raw, { id: 'p_old', slug: 'old-printer' });
  const db = asD1(raw);
  const L = await listing(db);
  assert.equal(L.installed, false);
  assert.equal(L.listed('p'), "p.status = 'active'");
  assert.equal((await L.heldIds(['p_old'])).size, 0);
  // The first screen's optimistic reads: the held clause refused for the missing table, run again without it.
  const optimistic = `SELECT slug FROM products p WHERE ${optimisticListed(db, 'p')}`;
  assert.match(optimistic, /product_completeness/);
  assert.equal(withoutHeld(optimistic), "SELECT slug FROM products p WHERE p.status = 'active'");
  const rows = await runListed(db, optimistic, (q) => db.prepare(q).all<{ slug: string }>());
  assert.deepEqual(rows.results.map((r) => r.slug), ['old-printer']);
  assert.equal(listedWithoutHeld(db), true, 'remembered for a minute: the next read builds today\'s SQL');
  assert.equal(optimisticListed(db, 'p'), "p.status = 'active'");
  // A migrated database never prepares the retry.
  const fresh = asD1(dbThrough('0184'));
  const statements: string[] = [];
  await runListed(fresh, `SELECT id FROM products WHERE ${optimisticListed(fresh)}`, (q) => (statements.push(q), fresh.prepare(q).all()));
  assert.equal(statements.length, 1);
  assert.equal(listedWithoutHeld(fresh), false);
  const w = world({ raw: dbThrough('0183') });
  const s = await surfaces(w);
  assert.ok(s.listingAll.includes('gap-printer'));
  assert.equal(s.detail, 200);
  const flags = await json(await get(w.admin(), '/api/admin/products-v2/p_gap/completeness'));
  assert.equal(flags.installed, false);
  // The owner's summary is a read: it answers as on 0184 (200), saying not installed; only the acts refuse.
  const summary = await get(w.admin(), '/api/admin/products-v2/completeness/summary');
  assert.equal(summary.status, 200);
  assert.deepEqual(await json(summary), { success: true, installed: false, summary: null });
  const refresh = await post(w.admin(), '/api/admin/products-v2/completeness/refresh', {});
  assert.equal(refresh.status, 503);
  assert.equal((await json(refresh)).code, 'COMPLETENESS_NOT_INSTALLED');
  void CUSTOMER;
});
