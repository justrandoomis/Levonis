/**
 * THE ORDER SNAPSHOT IS IMMUTABLE — case 7 of the owner's seventeen,
 * docs/BUNDLES_MYSTERY.md §6.2, through the REAL routers and real migrations.
 *
 * BUY, THEN BREAK THE CATALOGUE UNDERNEATH IT. Every component's price is
 * changed, every component is renamed, a colour is deactivated and the bundle
 * itself is repriced and renamed — and `GET /api/orders/:id` and the invoice
 * must answer exactly what they answered before, because a snapshot that moves
 * is not a snapshot: it is a receipt that rewrites itself after the customer
 * has paid.
 *
 * WHAT THE SNAPSHOT MUST CARRY, AND WHY EACH FIELD EARNS ITS PLACE:
 *
 *  - the composition block, with the component total, the bundle price, the
 *    discount, the saving and the price mode, so "what did this customer
 *    actually buy, and what did the shop give away" is answerable years later;
 *  - `items[].reservation_line_id`, which IS the ledger's `line_id` — the
 *    inventory reservation reference the mandate asks for, with no new column;
 *  - the offer block with its `offer_id`, so "which offer produced this price"
 *    is answerable after the window has been edited or deleted;
 *  - NO `cost_iqd`, anywhere, at any level. It is stripped before persistence
 *    because the order is served straight back to the buyer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, get, json, all, row, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { createInvoiceForOrder } from '../worker/lib/invoices';
import { addBundle, seedCatalogue, orderBody } from './lib/bundles';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

/** Everything about the catalogue that a snapshot must survive. */
function breakTheCatalogue(raw: DatabaseSync): void {
  raw.exec(`
    UPDATE products SET price_iqd = price_iqd * 3, name = 'RENAMED', name_ar = 'مغيّر'
      WHERE id IN ('p_printer','p_pla','p_nozzle','p_color');
    UPDATE products SET price_iqd = 1, name = 'Bundle RENAMED', status = 'hidden' WHERE id = 'prd_b1';
    UPDATE product_colors SET active = 0, name_en = 'GONE' WHERE id = 'pc_black';
    UPDATE bundle_config SET price_mode = 'discount_percent', discount_percent = 90 WHERE product_id = 'prd_b1';
    DELETE FROM offer_windows WHERE subject_id = 'prd_b1';
    DELETE FROM bundle_components WHERE bundle_product_id = 'prd_b1';
  `);
}

async function buyOne(raw: DatabaseSync) {
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    priceIqd: 400_000,
    window: { ends_at: '2099-01-01T00:00:00.000Z' },
    components: [
      { id: 'bc_printer', product: 'p_printer', qty: 1 },
      { id: 'bc_pla', product: 'p_pla', qty: 2 },
      { id: 'bc_abs', product: 'p_color', qty: 1, colorId: 'pc_black' },
    ],
  });
  const db = asD1(raw);
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  return { db, orderId: res.order.id as string, before: res.order };
}

test('case 7 — the order is unchanged after every component is repriced, renamed and deactivated', async () => {
  const raw = seedCatalogue();
  const { db, orderId, before } = await buyOne(raw);
  const beforeDetail = await json(await get(appFor(db), `/api/orders/${orderId}`));
  breakTheCatalogue(raw);
  const afterDetail = await json(await get(appFor(db), `/api/orders/${orderId}`));

  // The whole customer projection, byte for byte — not a field-by-field read,
  // because the failure this guards against is the NEXT field somebody joins
  // to the live product row.
  assert.deepEqual(
    { ...afterDetail.order, items: afterDetail.order.items },
    { ...beforeDetail.order, items: beforeDetail.order.items }
  );
  assert.equal(afterDetail.order.items.length, 1);
  assert.equal(afterDetail.order.items[0].name, 'Starter Bundle');
  assert.equal(afterDetail.order.items[0].unit_price_iqd, 400_000);
  assert.equal(afterDetail.order.items[0].bundle.components.length, 3);
  assert.equal(before.items[0].unit_price_iqd, 400_000);
});

test('case 7 — the invoice is unchanged too, and lists the parts under the priced line', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await buyOne(raw);
  const env = { DB: db } as unknown as Parameters<typeof createInvoiceForOrder>[0];
  const first = await createInvoiceForOrder(env, orderId);
  assert.ok(first);
  const snapshot = JSON.parse(
    String(row<{ snapshot: string }>(raw, 'SELECT snapshot FROM invoices WHERE order_id = ?', orderId)!.snapshot)
  ) as { lines: Array<Record<string, unknown>>; totals: Record<string, number> };

  assert.equal(snapshot.lines.length, 1, 'the components are not priced invoice lines');
  assert.equal((snapshot.lines[0].included as unknown[]).length, 3);
  assert.equal(snapshot.lines[0].line_total_iqd, 400_000);
  assert.equal(
    snapshot.lines.reduce((n, l) => n + Number(l.line_total_iqd), 0),
    snapshot.totals.subtotal_iqd,
    'Σ printed lines still equals the printed subtotal'
  );

  breakTheCatalogue(raw);
  const again = JSON.parse(
    String(row<{ snapshot: string }>(raw, 'SELECT snapshot FROM invoices WHERE order_id = ?', orderId)!.snapshot)
  );
  assert.deepEqual(again, snapshot);
});

test('the composition block answers what was bought, at what price, under which offer — and carries no cost', async () => {
  const raw = seedCatalogue();
  const { orderId } = await buyOne(raw);
  const rows = all<Record<string, unknown>>(raw, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid', orderId);
  const parent = rows.find((r) => r.bundle_parent_item_id === null)!;
  const snapshot = JSON.parse(String(parent.pricing_snapshot)) as {
    composition: {
      kind: string;
      bundle_product_id: string;
      bundle_name: { ar: string; en: string; ckb: string };
      component_total_iqd: number;
      bundle_price_iqd: number;
      bundle_discount_iqd: number;
      saving_percent: number;
      price_mode: string;
      offer: { offer_id: string; ends_at: string } | null;
      items: Array<{ order_item_id: string; reservation_line_id: string; value_iqd: number; alloc_iqd: number; product_id: string }>;
    };
  };
  const c = snapshot.composition;
  assert.equal(c.kind, 'bundle');
  assert.equal(c.bundle_product_id, 'prd_b1');
  // ar/en/ckb, all three, frozen — the order page, the invoice, the printed
  // receipt and the return case render this for ever.
  assert.deepEqual(Object.keys(c.bundle_name).sort(), ['ar', 'ckb', 'en']);
  assert.equal(c.component_total_iqd, 400000 + 50000 + 30000);
  assert.equal(c.bundle_price_iqd, 400_000);
  assert.equal(c.bundle_discount_iqd, 80_000);
  assert.equal(c.saving_percent, 17);
  assert.equal(c.price_mode, 'fixed');
  assert.equal(c.offer?.offer_id, 'ofw_prd_b1', 'which offer produced this price, answerable after the window is gone');

  assert.equal(c.items.length, 3);
  const ledgerKeys = all<{ idempotency_key: string }>(
    raw,
    "SELECT idempotency_key FROM inventory_ledger WHERE order_id = ? AND kind = 'reserve'",
    orderId
  ).map((r) => r.idempotency_key.split(':')[2]);
  for (const it of c.items) {
    assert.equal(it.reservation_line_id, it.order_item_id);
    assert.ok(ledgerKeys.includes(it.reservation_line_id), 'the reference IS the ledger line id');
    assert.ok(it.value_iqd > 0);
    assert.ok(it.alloc_iqd > 0);
  }
  assert.equal(
    c.items.reduce((n, it) => n + it.alloc_iqd, 0),
    Number(parent.line_total_iqd)
  );

  for (const r of rows) {
    assert.ok(!String(r.pricing_snapshot).includes('cost_iqd'), 'cost never crosses this boundary');
  }
});

test('the parent option_snapshot is DATA ONLY — no prose, no count, no English sentence', async () => {
  const raw = seedCatalogue();
  const { orderId } = await buyOne(raw);
  const parent = all<Record<string, unknown>>(
    raw,
    'SELECT * FROM order_items WHERE order_id = ? AND bundle_parent_item_id IS NULL',
    orderId
  )[0];
  const snap = String(parent.option_snapshot);
  // "Printer X1 · PLA Basic ×2 · ABS Spool Black" — names and quantities.
  assert.match(snap, /Printer X1/);
  assert.match(snap, /×2/);
  assert.ok(!/\bitems?\b/i.test(snap), 'a frozen English sentence would be rendered to Arabic customers for ever');
  assert.ok(!/\bincludes\b/i.test(snap));
});

test('a bundle line keeps its own transport snapshot and its components keep theirs', async () => {
  const raw = seedCatalogue();
  raw.exec(
    `INSERT INTO admin_settings (key, value) VALUES ('preorderTransportDefaults', '[{"method":"sea","commission_iqd":3000}]')`
  );
  addBundle(raw, {
    id: 'prd_pre',
    slug: 'pre',
    priceIqd: 90_000,
    components: [
      { id: 'bc_pre', product: 'p_pre', qty: 1 },
      { id: 'bc_pre2', product: 'p_pre2', qty: 2 },
    ],
  });
  const db = asD1(raw);
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_pre', qty: 1, transportMethod: 'sea' }));
  assert.equal(added.success, true, JSON.stringify(added));
  const res = await json(await post(appFor(db), '/api/orders', orderBody({ paymentMethodId: 'wallet', useWallet: true })));
  assert.equal(res.success, true, JSON.stringify(res));

  const rows = all<Record<string, unknown>>(raw, 'SELECT * FROM order_items WHERE order_id = ?', res.order.id);
  const parent = rows.find((r) => r.bundle_parent_item_id === null)!;
  const transport = JSON.parse(String(parent.transport_snapshot)) as {
    method: string;
    commission_iqd: number;
    components: Array<{ component_id: string; commission_iqd: number; qty: number }>;
  };
  assert.equal(transport.method, 'sea');
  assert.equal(transport.commission_iqd, 3000 * 3, 'three spools, three commissions, charged on the parent');
  assert.equal(transport.components.length, 2, 'the per-component fee facts are recorded, not just their sum');
});
