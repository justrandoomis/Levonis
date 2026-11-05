/**
 * «أسعار المورّد» — THE OWNER'S SUPPLIER PRICE CATALOGUE
 * (docs/SMART_PRICING.md §3.4–§3.9; migration 0218; DECISIONS rows 278–281).
 *
 * Mounted INSIDE adminPricingRoutes at `/supplier-prices` (worker/routes/
 * adminPricing.ts, the mount line lands with WP15), so it inherits that
 * router's door — requireAdmin → limitByMethod(['pricing-read', 1200],
 * ['pricing-write', 600]) → requireCostRead — and `/api/admin/pricing` is
 * already `admin:owner` at the gateway. It also declares its own
 * `use('*', requireCostRead)`, so it is never served without the owner-only
 * guard (tests/costPredicateUsage.test.ts LATER_ROUTERS pins it): every other
 * caller hears 403 COST_ACCESS_DENIED, the same bytes as every cost route, for
 * a real id and an invented one alike. Every write calls assertCostWrite.
 *
 *   GET  /snapshots                  every snapshot: source, date, state, counts, matched, age
 *   POST /snapshots                  a new snapshot in state `loading`
 *   POST /snapshots/:id/items        one chunk of ≤ 50 items and ≤ 256 KB (strict parser)
 *   POST /snapshots/:id/complete     counts and hash checked; the previous one superseded
 *   POST /snapshots/:id/discard      its rows deleted; superseded beyond three per source pruned
 *   POST /match {cursor | product_ids}  one page of 25 products matched (suggestions, auto-confirmations)
 *   GET  /matches?state=&cursor=     the review: suggested | auto | rejected | missing, 25 a page
 *   PUT  /matches/:product_id        confirm, re-point or reject (version-fenced)
 *   PUT  /manual/:product_id         the owner's typed prices (version-fenced)
 *   GET  /lookup?q=                  ≤ 50 catalogue items by URL, id, handle, code or words
 *   POST /read-store-page            one EU / US store page read, optionally saved as his price
 *                                    (on sale: the regular price saved, the sale price answered)
 *   GET  /links?q=&source=&cursor=   the supplier links of every linked product, 25 a page
 *   GET  /links/:product_id          one product's supplier links
 *   GET  /owner-links/:product_id[?combo_key= | ?scope=&scope_id=]
 *                                    the owner's own links (§3.10) beside the matched links of
 *                                    the same SKUs, and the keys a new one may be saved for
 *   PUT  /owner-links/:product_id    adds, edits and removes his links (version-fenced; no price)
 *
 * Owner-only data (invariant I6): nothing here reaches a customer or another
 * admin. Every answer is `private, no-store`.
 *
 * DEPLOY-AHEAD (§2.4): on a database without 0218 every route answers 503
 * PRICE_ESTIMATES_NOT_INSTALLED (probed once per binding) — except the three
 * links reads, which answer an empty list (the product form's banner reads
 * them and simply shows none). Without 0223 the owner-links read answers
 * `installed: false` and its write 503 SUPPLIER_LINKS_NOT_INSTALLED.
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../lib/types';
import { jsonObject, notFound } from '../lib/http';
import { assertCostWrite, requireCostRead } from '../lib/costAccess';
import { SESSION_CACHE_CONTROL } from '../lib/edgePolicy';
import { auditStatements } from '../lib/audit';
import { inputInvalid } from '../lib/pricingEngine/whatIf';
import { priceEstimatesInstalled } from '../lib/priceEstimateLabel';
import { supplierItemUrl, supplierSkuUrl } from '@levonis/catalog/supplierPrices/links';
import {
  EMPTY_TOKEN,
  estimatesNotInstalled,
  isProductId,
  loadProductSkus,
  manualWriteStatements,
  sellableComboKeys,
  setManualPrices,
  strictBody,
  versionTokens,
} from '../lib/supplierPrices/store';
import { UPLOAD_CHUNK_BYTES, completeSnapshot, createSnapshot, discardSnapshot, listSnapshots, uploadItems } from '../lib/supplierPrices/upload';
import { REVIEW_STATES, decideMatches, reviewPageIds, runMatchPage, type ReviewState } from '../lib/supplierPrices/matcher';
import { lookupCatalogue, parseSupplierQuery } from '../lib/supplierPrices/lookup';
import { chosenOffer, readStorePage, storableCurrency, storePageTarget, storePageUnreadable } from '../lib/supplierPrices/storePage';
import { linksPage, productLinkViews, productLinks } from '../lib/supplierPrices/links';
import { ownerLinksFilter, ownerLinksView, setOwnerLinks } from '../lib/supplierPrices/ownerLinks';

export const adminSupplierPricesRoutes = new Hono<AppContext>();

// Private and never stored — the refusals included.
adminSupplierPricesRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', SESSION_CACHE_CONTROL);
});
// THE DOOR (owner decision 2): owner only, before any route reads an id.
adminSupplierPricesRoutes.use('*', requireCostRead);

const actorOf = (c: Context<AppContext>): string => c.get('user')!.id;
const today = (): string => new Date().toISOString().slice(0, 10);

/** 503 PRICE_ESTIMATES_NOT_INSTALLED on a database without 0218 (asked after the door, so only the owner hears it). */
async function installed(c: Context<AppContext>): Promise<void> {
  if (!(await priceEstimatesInstalled(c.env.DB))) throw estimatesNotInstalled();
}

// ------------------------------------------------------------- snapshots (§3.4)

adminSupplierPricesRoutes.get('/snapshots', async (c) => {
  await installed(c);
  return c.json({ success: true, snapshots: await listSnapshots(c.env.DB, today()) });
});

adminSupplierPricesRoutes.post('/snapshots', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const snapshot = await createSnapshot(c.env.DB, await jsonObject(c), actorOf(c), new Date());
  return c.json({ success: true, snapshot }, 201);
});

adminSupplierPricesRoutes.post('/snapshots/:id/items', async (c) => {
  assertCostWrite(c);
  await installed(c);
  // ≤ 256 KB a chunk: a declared length over it is refused before the body is read, and the text
  // itself is measured before it is parsed.
  const declared = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(declared) && declared > UPLOAD_CHUNK_BYTES) throw inputInvalid('items');
  const answer = await uploadItems(c.env.DB, c.req.param('id'), await c.req.text());
  return c.json({ success: true, ...answer });
});

adminSupplierPricesRoutes.post('/snapshots/:id/complete', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const snapshot = await completeSnapshot(c.env.DB, c.req.param('id'), await jsonObject(c), actorOf(c), new Date());
  return c.json({ success: true, snapshot });
});

adminSupplierPricesRoutes.post('/snapshots/:id/discard', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const snapshot = await discardSnapshot(c.env.DB, c.req.param('id'), actorOf(c), new Date());
  return c.json({ success: true, snapshot });
});

// ------------------------------------------------------------- matching and review (§3.5, §3.6)

adminSupplierPricesRoutes.post('/match', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const body = await jsonObject(c);
  strictBody(body, ['cursor', 'product_ids']);
  return c.json({ success: true, ...(await runMatchPage(c.env.DB, body, actorOf(c), new Date())) });
});

const ALL_STATES = new Set<'confirmed' | 'suggested' | 'rejected'>(['confirmed', 'suggested', 'rejected']);

adminSupplierPricesRoutes.get('/matches', async (c) => {
  await installed(c);
  const stateRaw = c.req.query('state') ?? 'suggested';
  if (!(REVIEW_STATES as readonly string[]).includes(stateRaw)) throw inputInvalid('state');
  const state = stateRaw as ReviewState;
  const cursor = c.req.query('cursor') ?? '';
  if (cursor !== '' && !isProductId(cursor)) throw inputInvalid('cursor');
  const page = await reviewPageIds(c.env.DB, state, cursor);
  const views = await productLinkViews(c.env.DB, page.ids, { states: ALL_STATES, manual: true });
  return c.json({ success: true, state, products: page.ids.flatMap((id) => views.get(id) ?? []), next_cursor: page.next });
});

adminSupplierPricesRoutes.put('/matches/:product_id', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const pid = c.req.param('product_id');
  await decideMatches(c.env.DB, pid, await jsonObject(c), actorOf(c), new Date());
  const view = (await productLinkViews(c.env.DB, [pid], { states: ALL_STATES, manual: true })).get(pid) ?? null;
  return c.json({ success: true, product: view });
});

adminSupplierPricesRoutes.put('/manual/:product_id', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const pid = c.req.param('product_id');
  await setManualPrices(c.env.DB, pid, await jsonObject(c), actorOf(c), new Date());
  const view = (await productLinkViews(c.env.DB, [pid], { states: ALL_STATES, manual: true })).get(pid) ?? null;
  return c.json({ success: true, product: view });
});

// ------------------------------------------------------------- lookup and the one-page store read (§3.6)

adminSupplierPricesRoutes.get('/lookup', async (c) => {
  await installed(c);
  const q = parseSupplierQuery(c.req.query('q') ?? '');
  return c.json({ success: true, query: q.kind, supplier_prices: await lookupCatalogue(c.env.DB, q) });
});

adminSupplierPricesRoutes.post('/read-store-page', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const body = await jsonObject(c);
  strictBody(body, ['url', 'save']);
  const target = storePageTarget(body.url);
  let save: { product_id: string; combo_keys: string[] } | null = null;
  if (body.save !== undefined && body.save !== null) {
    const s = body.save;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw inputInvalid('save');
    const o = s as Record<string, unknown>;
    strictBody(o, ['product_id', 'combo_keys']);
    if (!isProductId(o.product_id)) throw notFound();
    const product = (await loadProductSkus(c.env.DB, [o.product_id])).get(o.product_id);
    if (!product) throw notFound();
    save = { product_id: o.product_id, combo_keys: sellableComboKeys(product, o.combo_keys) };
  }
  const read = await readStorePage(target);
  const chosen = chosenOffer(read);
  let saved = 0;
  if (save) {
    // The variant the address named is not on the page, or the page gives it several prices (its
    // copies disagree: details.reason 'copies_disagree'). No variant named and several prices: the
    // owner opens a variant link instead — nothing is guessed.
    if (!chosen && !target.variant_id) throw inputInvalid('url');
    if (!chosen) throw storePageUnreadable(read.offers.some((o) => o.sku_key === target.variant_id) ? 'copies_disagree' : undefined);
    const currency = storableCurrency(chosen);
    if (!currency) throw storePageUnreadable();
    const now = new Date().toISOString();
    // The evidence: the final address when it fits its column, else the rebuilt one (never answered, never a link).
    const evidence = read.final_url.length <= 600 ? read.final_url : target.url;
    const audit = await auditStatements(c.env.DB, actorOf(c), 'supplier_prices.store_page_save', save.product_id, {
      skus: save.combo_keys.length,
      host: read.host,
      redirected: read.source !== target.source,
      on_sale: chosen.sale_price !== undefined,
    });
    await c.env.DB.batch([
      ...manualWriteStatements(
        c.env.DB,
        save.product_id,
        // On a sale page `price` is the regular price; the sale price (`sale_price`) is answered, never saved.
        save.combo_keys.map((combo_key) => ({ combo_key, amount: chosen.price, currency, note: '' })),
        { origin: 'store_page', url: evidence, host: read.host },
        actorOf(c),
        now
      ),
      ...audit.statements,
    ]);
    saved = save.combo_keys.length;
  }
  return c.json({
    success: true,
    saved,
    supplier_prices: {
      // The page asked for, its links rebuilt from its handle and id; the source and host that answered.
      requested_source: target.source,
      handle: target.handle,
      variant_id: target.variant_id,
      item_url: supplierItemUrl(target.source, target.handle),
      sku_url: target.variant_id ? supplierSkuUrl(target.source, target.handle, target.variant_id) : null,
      source: read.source,
      host: read.host,
      redirected: read.source !== target.source,
      offers: read.offers,
      chosen_sku_key: chosen ? chosen.sku_key : null,
    },
  });
});

// ------------------------------------------------------------- supplier links (§3.9)

adminSupplierPricesRoutes.get('/links', async (c) => {
  const page = await linksPage(c.env.DB, { q: c.req.query('q'), source: c.req.query('source'), cursor: c.req.query('cursor') });
  return c.json({ success: true, ...page });
});

adminSupplierPricesRoutes.get('/links/:product_id', async (c) => {
  const pid = c.req.param('product_id');
  if (!isProductId(pid)) return c.json({ success: true, products: [], next_cursor: null, versions: { matches: EMPTY_TOKEN, manual: EMPTY_TOKEN } });
  const products = await productLinks(c.env.DB, pid);
  // The tokens, even with no link yet: «تحديث السعر» opens the manual entry on any product.
  const versions = products[0]?.versions ?? (await versionTokens(c.env.DB, [pid])).get(pid)!;
  return c.json({ success: true, products, next_cursor: null, versions });
});

// ------------------------------------------------------------- the owner's own links (§3.10, DECISIONS row 293)

// A read, like the two above: never 503 (installed: false on an older database), 404 for no such product.
adminSupplierPricesRoutes.get('/owner-links/:product_id', async (c) => {
  const filter = ownerLinksFilter({ combo_key: c.req.query('combo_key'), scope: c.req.query('scope'), scope_id: c.req.query('scope_id') });
  return c.json({ success: true, ...(await ownerLinksView(c.env.DB, c.req.param('product_id'), filter)) });
});

adminSupplierPricesRoutes.put('/owner-links/:product_id', async (c) => {
  assertCostWrite(c);
  await installed(c);
  const saved = await setOwnerLinks(c.env.DB, c.req.param('product_id'), await jsonObject(c), actorOf(c), new Date());
  return c.json({ success: true, saved });
});
