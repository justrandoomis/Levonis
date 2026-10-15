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
 *   - ON, a COMMERCIAL gap (DECISIONS row 240): it stays shown in the
 *     catalog-only state — listed, searchable, its page and the public API
 *     answer with `price_status: 'unpriced'` and no number — and every purchase
 *     door refuses it (quote and cart add 409 PRICE_NOT_AVAILABLE, the cart
 *     view lists it apart); the public counts say it is not priced;
 *   - ON, a CATALOG gap (no picture): it is gone from the listing, search,
 *     home, its page (404), the quote, the public API (list, page, counts), the
 *     sitemap, compare, the cart's add (404) and view — while every admin read
 *     still shows it, flagged;
 *   - completing it (the data file's apply, a real write) sells it again with
 *     no other act, and turning the switch off restores everything;
 *   - only the verified owner moves the switch (a full admin, an assistant and
 *     an unverified owner are refused; the generic settings PUT refuses it);
 *   - a database without 0184 (and so without 0189) shows every active product
 *     catalog-only and sells nothing.
 *
 * Run: node --import tsx --test tests/catalogHideIncomplete.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, dbThrough, freshDb, get, json, post, put } from './fixtures/app';
import { ASSISTANT, CUSTOMER, FULL_ADMIN, OWNER, recount, seedCatalog, seedProduct, world, type World } from './fixtures/completeness';
import {
  completenessAbsentLately,
  listing,
  optimisticSellable,
  optimisticVisible,
  pricingV2AbsentLately,
  runListed,
  withoutHeld,
  withoutV2,
} from '../worker/lib/listing';

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
  const page = await w.guest('/api/products/gap-printer');
  const detail = page.status;
  const detailBody = detail === 200 ? await json(page) : null;
  const quoteRes = await w.guest('/api/products/gap-printer/quote', { method: 'POST', body: { qty: 1 } });
  const quote = quoteRes.status;
  const quoteCode = quote === 200 ? null : String((await json(quoteRes)).code ?? '');
  const apiListBody = await json(await w.guest('/api/public/v1/products'));
  const apiList = slugsOf(apiListBody);
  const apiGap = ((apiListBody.data ?? []) as Array<{ slug: string; price: { status: string; amount: number | null } }>).find((p) => p.slug === 'gap-printer');
  const apiDetail = (await w.guest('/api/public/v1/products/gap-printer')).status;
  const sitemap = await (await w.guest('/sitemap.xml')).text();
  return { listingAll, search, homeLatest, detail, detailBody, quote, quoteCode, apiList, apiGap, apiDetail, sitemap };
}

/** A catalog gap (DECISIONS row 240): no picture. The cost is filled, so IMAGE is the one code missing. */
function imageGap(w: World): void {
  w.raw.exec("UPDATE products SET product_cost_iqd = 70000 WHERE id = 'p_gap'");
  w.raw.exec("DELETE FROM product_images WHERE product_id = 'p_gap'");
}

/**
 * The clean start (DECISIONS row 222): a listed product is V2-published, and the fixture publishes price-first,
 * which needs no cost (productCompleteness.ts, PRICING-V2 A1) — so a missing COST no longer holds a listed
 * product, and the data file cannot write a dinar cost anyway. The hiding mechanics are proved here with a
 * gap every product is asked: the packaged weight.
 */
function weightGap(w: World): void {
  w.raw.exec("UPDATE products SET product_cost_iqd = 70000, package_weight_g = NULL WHERE id = 'p_gap'");
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
  // A cost gap stops sale only (DECISIONS row 240): held, shown without a price, never counted as hidden.
  assert.equal(summary.would_hide_from_catalog, 0);
  assert.equal(summary.enabled, false);
  assert.equal(summary.stale, 0);
  const wrong = await put(w.admin(), '/api/admin/products-v2/completeness/hide', { enabled: true, expected_count: 0 });
  assert.equal(wrong.status, 409);
  const wrongBody = await json(wrong);
  assert.equal(wrongBody.code, 'HIDE_COUNT_CHANGED');
  assert.equal(wrongBody.details.summary.would_hide, 1, 'the refusal carries the fresh count');
  const on = await put(w.admin(), '/api/admin/products-v2/completeness/hide', { enabled: true, expected_count: 1 });
  assert.equal(on.status, 200, await on.clone().text());
  const onSummary = (await json(on)).summary;
  assert.equal(onSummary.held, 1);
  assert.equal(onSummary.held_from_catalog, 0, 'held from sale, still shown');
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

test('ON, a commercial gap: the product stays shown catalog-only — no number anywhere — and every purchase door refuses it', async () => {
  const w = world();
  weightGap(w);
  await recount(w);
  await recount(w);
  assert.equal((await setSwitch(w, true)).status, 200);
  const s = await surfaces(w);
  assert.ok(s.listingAll.includes('gap-printer') && s.listingAll.includes('full-printer'), 'listing: shown');
  assert.ok(s.listingAll.indexOf('full-printer') < s.listingAll.indexOf('gap-printer'), 'browse puts the priced product first (R1)');
  assert.ok(s.search.includes('gap-printer'), 'search finds it');
  assert.equal(s.detail, 200, 'its page answers');
  assert.equal(s.detailBody!.price_status, 'unpriced');
  assert.equal(s.detailBody!.product.price_iqd, null);
  assert.equal(s.detailBody!.product.display_price_iqd, null);
  assert.equal(s.detailBody!.pricing, null);
  assert.equal(s.detailBody!.availability, null);
  assert.equal(s.quote, 409, 'the quote refuses it');
  assert.equal(s.quoteCode, 'PRICE_NOT_AVAILABLE');
  assert.ok(s.apiList.includes('gap-printer'), 'public API list');
  assert.deepEqual({ status: s.apiGap!.price.status, amount: s.apiGap!.price.amount }, { status: 'unpriced', amount: null });
  assert.equal(s.apiDetail, 200, 'public API page');
  assert.match(s.sitemap, /gap-printer/);
  const ctx = await json(await w.guest('/api/public/v1/context'));
  assert.equal(ctx.content.products, 2, 'the public count includes it');
  assert.equal(ctx.content.products_priced, 1, 'and says it is not priced');
  // Compare passes it as on display (these fixtures carry no spec sheet, so the next check is the one that answers).
  const cmp = await w.guest('/api/compare?ids=p_full,p_gap');
  assert.equal((await json(cmp)).code, 'COMPARE_NO_SPECS', 'not COMPARE_NOT_VISIBLE');
  // The cart: refused at the add, by name.
  const add = await post(w.shopper(), '/api/cart/items', { productId: 'p_gap', qty: 1 });
  assert.equal(add.status, 409);
  assert.equal((await json(add)).code, 'PRICE_NOT_AVAILABLE');
  // Admin: the list shows it, flagged.
  const list = await json(await get(w.admin(), '/api/admin/products-v2?limit=50'));
  const row = (list.products as Array<{ id: string; held: boolean; catalog_held: boolean; missing_count: number | null }>).find((p) => p.id === 'p_gap')!;
  assert.equal(row.held, true);
  assert.equal(row.catalog_held, false, 'held from sale only: still shown');
  const stats = await json(await get(w.admin(), '/api/admin/products-v2/stats'));
  assert.equal(stats.totals.shown_unpriced, 1, '«ظاهر بلا سعر»: the one customers see without a price');
  assert.equal(w.raw.prepare("SELECT status FROM products WHERE id = 'p_gap'").get()!.status, 'active');
  // No legacy number of the product reached any customer answer.
  assert.doesNotMatch(JSON.stringify(s.detailBody), /100000|100,000/);
});

test('ON, a catalog gap (no picture): the product is gone from every customer surface — and every admin read still shows it, flagged', async () => {
  const w = world();
  imageGap(w);
  await recount(w);
  await recount(w);
  assert.equal((await setSwitch(w, true)).status, 200);
  const held = (await json(await get(w.admin(), '/api/admin/products-v2/completeness/summary'))).summary;
  assert.deepEqual([held.held, held.held_from_catalog], [1, 1], 'a picture gap: held AND hidden');
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
  const row = (list.products as Array<{ id: string; held: boolean; catalog_held: boolean; missing_count: number | null }>).find((p) => p.id === 'p_gap')!;
  assert.equal(row.held, true);
  assert.equal(row.catalog_held, true, 'hidden, not «ظاهر بلا سعر»');
  assert.equal(row.missing_count, 1);
  assert.equal((await json(await get(w.admin(), '/api/admin/products-v2/stats'))).totals.shown_unpriced, 0, 'a hidden product is not counted as shown');
  assert.equal((await get(w.admin(), '/api/admin/products-v2/p_gap')).status, 200);
  const only = await json(await get(w.admin(), '/api/admin/products-v2?incomplete=1'));
  assert.deepEqual((only.products as Array<{ id: string }>).map((p) => p.id), ['p_gap']);
  assert.equal(w.raw.prepare("SELECT status FROM products WHERE id = 'p_gap'").get()!.status, 'active');
});

test('a cart line already holding it is listed apart (PRICE_NOT_AVAILABLE) while the switch is on, and comes back', async () => {
  const w = world();
  weightGap(w);
  await recount(w);
  assert.equal((await post(w.shopper(), '/api/cart/items', { productId: 'p_gap', qty: 1 })).status, 200);
  const before = await json(await get(w.shopper(), '/api/cart'));
  assert.equal((before.items as unknown[]).length, 1);
  // The first customer request published the fixture catalogue in dollars (a write the verdict notices):
  // the owner recounts before the switch, as the switch itself asks.
  await recount(w);
  await setSwitch(w, true);
  const during = await json(await get(w.shopper(), '/api/cart'));
  assert.equal((during.items as unknown[]).length, 0, 'held: never priced in the cart');
  const apart = during.unavailable_lines as Array<{ product_id: string; code: string }>;
  assert.deepEqual(apart.map((l) => [l.product_id, l.code]), [['p_gap', 'PRICE_NOT_AVAILABLE']], 'still shown, so the line says why');
  assert.doesNotMatch(JSON.stringify(apart), /100000|price_iqd/);
  assert.equal(w.raw.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE product_id = 'p_gap'").get()!.n, 1, 'the line itself is untouched');
  await setSwitch(w, false);
  const after = await json(await get(w.shopper(), '/api/cart'));
  assert.equal((after.items as unknown[]).length, 1);
});

test('completing the product (the data file, a real write) sells it again at once; turning the switch off restores everything', async () => {
  const w = world();
  weightGap(w);
  await recount(w);
  await setSwitch(w, true);
  const statusOf = async () => {
    const res = await w.guest('/api/products/gap-printer');
    return res.status === 200 ? String((await json(res)).price_status) : String(res.status);
  };
  assert.equal(await statusOf(), 'unpriced', 'shown catalog-only while the weight is missing');

  // The owner's data file: the preview names what would still be missing, then the apply writes the weight.
  const file = await (await get(w.admin(), '/api/admin/template/data-export/p_gap')).text();
  const unchanged = await json(await post(w.admin(), '/api/admin/template/data-preview', { text: file, product_id: 'p_gap' }));
  assert.deepEqual(unchanged.products[0].completeness.after.map((i: { code: string }) => i.code), ['PACKAGE_WEIGHT'], 'still missing: the weight');
  const edited = file.replace(/^package_weight_g=.*$/m, 'package_weight_g=1200');
  assert.notEqual(edited, file);
  const pv = await json(await post(w.admin(), '/api/admin/template/data-preview', { text: edited, product_id: 'p_gap' }));
  const card = pv.products[0];
  assert.deepEqual(card.completeness.before.map((i: { code: string }) => i.code), ['PACKAGE_WEIGHT']);
  assert.deepEqual(card.completeness.after, [], 'complete after the apply');
  const applied = await post(w.admin(), '/api/admin/template/data-apply', { text: edited, product_id: 'p_gap', token: card.token });
  assert.equal(applied.status, 200, await applied.clone().text());

  const row = w.raw.prepare("SELECT complete, held FROM product_completeness WHERE product_id = 'p_gap'").get()!;
  assert.deepEqual({ complete: row.complete, held: row.held }, { complete: 1, held: 0 }, 're-evaluated by the write itself');
  assert.equal(await statusOf(), 'priced', 'sold again');
  assert.ok((await listingSlugs(w)).includes('gap-printer'));

  // Break it again, then switch off: sold whatever its state.
  w.raw.exec("UPDATE products SET package_weight_g = NULL, updated_at = '2026-10-02T00:00:00.000Z' WHERE id = 'p_gap'");
  await recount(w);
  assert.equal(await statusOf(), 'unpriced');
  assert.equal((await setSwitch(w, false)).status, 200);
  assert.equal(await statusOf(), 'priced');
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

test('a database without 0184 (and so without 0189) shows every active product catalog-only, sells nothing and breaks no read; the completeness routes answer as before', async () => {
  const raw = dbThrough('0183');
  seedCatalog(raw);
  seedProduct(raw, { id: 'p_old', slug: 'old-printer' });
  const db = asD1(raw);
  const L = await listing(db);
  assert.equal(L.installed, false);
  // The clean start (spec addendum A.4.1): before 0189 no product is V2-published — SELLABLE is nothing
  // (fail closed), never a legacy price; VISIBLE is every active product (DECISIONS row 240).
  assert.equal(L.v2, false);
  assert.equal(L.sellable('p'), "p.status = 'active' AND 0");
  assert.equal(L.visible('p'), "p.status = 'active'");
  assert.equal((await L.unsellableIds(['p_old'])).size, 1);
  assert.equal((await L.statesOf(['p_old'])).get('p_old'), 'catalog_only');
  // The first screen's optimistic reads: refused for each missing table, run again without it — no read breaks.
  const optimistic = `SELECT slug FROM products p WHERE ${optimisticSellable(db, 'p')}`;
  assert.match(optimistic, /product_completeness/);
  assert.equal(withoutV2(withoutHeld(optimistic)), "SELECT slug FROM products p WHERE p.status = 'active' AND 0");
  const rows = await runListed(db, optimistic, (q) => db.prepare(q).all<{ slug: string }>());
  assert.deepEqual(rows.results.map((r) => r.slug), []);
  assert.equal(completenessAbsentLately(db), true, 'remembered for a minute: the next read builds the older SQL');
  assert.equal(pricingV2AbsentLately(db), true);
  assert.equal(optimisticSellable(db, 'p'), "p.status = 'active' AND 0");
  assert.equal(optimisticVisible(db, 'p'), "p.status = 'active'");
  const shown = await runListed(db, `SELECT slug FROM products p WHERE ${optimisticVisible(db, 'p')}`, (q) => db.prepare(q).all<{ slug: string }>());
  assert.deepEqual(shown.results.map((r) => r.slug), ['old-printer']);
  // A migrated database never prepares the retry.
  const fresh = asD1(freshDb());
  const statements: string[] = [];
  await runListed(fresh, `SELECT id FROM products WHERE ${optimisticVisible(fresh)} AND ${optimisticSellable(fresh)}`, (q) => (statements.push(q), fresh.prepare(q).all()));
  assert.equal(statements.length, 1);
  assert.equal(completenessAbsentLately(fresh), false);
  const w = world({ raw: dbThrough('0183') });
  const s = await surfaces(w);
  assert.ok(s.listingAll.includes('gap-printer') && s.listingAll.includes('full-printer'), 'shown, catalog-only');
  assert.equal(s.detail, 200);
  assert.equal(s.detailBody!.price_status, 'unpriced', 'never a legacy price');
  assert.equal(s.quote, 409, 'and nothing is sold');
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
