/**
 * PRICING V2 CLEAN START — THE LAST SURFACES (review of feat/pricing-v2-core, 2026-10-14).
 *   - a community post keeps the author's words but links only to a product customers can see — since
 *     DECISIONS row 240 a product still «يحتاج تسعيرًا» is SHOWN (catalog-only), so it links; a product
 *     held for a catalog gap (no picture) does not;
 *   - the public reviews of a product still «يحتاج تسعيرًا» are shown with it (row 240); a hidden one's
 *     answer like an unknown product;
 *   - the admin price reports' «السعر الآن» is a V2 price or null, never the old ladder;
 *   - trade-in: a Combo of a product still «يحتاج تسعيرًا» is valued by the reference method, never by
 *     its old model prices.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { publishV2 } from './fixtures/v2Publish';
import { postCard, withListedEmbeds } from '../worker/routes/communityPosts';
import { reviewRoutes } from '../worker/routes/reviews';

const seed = (raw: ReturnType<typeof freshDb>) =>
  raw.exec(`INSERT INTO products (id, slug, name, name_ar, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
            VALUES ('p_printer', 'printer-x', 'Printer X', 'طابعة', 'active', 917001, 3, 'direct_sale', '["direct_sale"]', '[]', 'BASE')`);

const cardRow = {
  id: 'post1', kind: 'project', title: 'A print', body: '', author_id: 'u1',
  printer_product_id: 'p_printer', printer_slug: 'printer-x', printer_product_name: 'Printer X', printer_product_name_ar: 'طابعة', printer_status: 'active',
  printer_name: '',
};

test('a community post links only to a visible product; the author\'s words stay', async () => {
  const raw = freshDb();
  seed(raw);
  const db = asD1(raw);
  const card = postCard(cardRow, null);
  assert.ok(card.printer.product, 'the row itself is active');
  // Still «يحتاج تسعيرًا» is shown catalog-only (DECISIONS row 240): the link stays, and carries no price.
  const [shown] = await withListedEmbeds(db, [card]);
  assert.equal(shown!.printer.product?.url, '/product/printer-x');
  assert.doesNotMatch(JSON.stringify(shown), /917001/);
  // A draft product never links, whatever the listing says.
  assert.equal(postCard({ ...cardRow, printer_status: 'draft' }, null).printer.product, null);
  // Held by the owner's switch for a CATALOG gap (no picture): hidden, so the link drops; the words stay.
  raw.exec(`INSERT INTO product_completeness (product_id, complete, held, missing_json, missing_count, computed_at)
            VALUES ('p_printer', 0, 1, '[{"c":"IMAGE","o":""}]', 1, '2026-10-15T00:00:00Z')`);
  const [hidden] = await withListedEmbeds(db, [card]);
  assert.equal(hidden!.printer.product, null, 'held for a catalog gap: no /product link');
  assert.equal(hidden!.printer.name, 'Printer X');
  raw.exec("DELETE FROM product_completeness WHERE product_id = 'p_printer'");
  await publishV2(raw, 'p_printer');
  const [listed] = await withListedEmbeds(db, [card]);
  assert.equal(listed!.printer.product?.url, '/product/printer-x');
});

test('the public reviews of a product still «يحتاج تسعيرًا» are shown with it; a hidden product\'s answer like an unknown product', async () => {
  const raw = freshDb();
  seed(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/reviews', reviewRoutes), { publishV2: false });
  // Shown catalog-only (DECISIONS row 240): its reviews are part of its page.
  assert.equal((await get(app, '/api/reviews/product/printer-x')).status, 200);
  raw.exec("UPDATE products SET status = 'draft' WHERE id = 'p_printer'");
  assert.equal((await get(app, '/api/reviews/product/printer-x')).status, 404);
  raw.exec("UPDATE products SET status = 'active' WHERE id = 'p_printer'");
  await publishV2(raw, 'p_printer');
  const res = await get(app, '/api/reviews/product/printer-x');
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
});

test('price reports and trade-in read no old dinar price of a product still «يحتاج تسعيرًا»', () => {
  const reports = readFileSync(join(import.meta.dirname, '../worker/routes/priceReports.ts'), 'utf8');
  assert.doesNotMatch(reports, /p\.price_iqd AS product_price_now/);
  assert.match(reports, /MIN\(fr\.final_price_iqd\)/);
  const tradeIn = readFileSync(join(import.meta.dirname, '../worker/lib/tradeIn.ts'), 'utf8');
  assert.match(tradeIn, /combo: unpriced\.has\(line\.product_id\) \? null : comboValue/);
});
