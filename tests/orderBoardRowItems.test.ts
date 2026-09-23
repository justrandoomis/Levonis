/**
 * «في تجهيز الطلبات … يظهر بشكل صغير سطر بجانب رقم الطلب المنتجات التي طلبها»
 *
 * THE SYMPTOM. The board's rows named the customer, the governorate, the
 * journey, the status and the order number — and never what was in the box.
 * The items were ALREADY on the payload (`GET /api/admin/orders` attaches every
 * page row's lines in one IN query, `orderPublic` maps them to
 * `{name, variant, qty}`); the row simply never read them. So the person
 * packing opened every order to learn whether it was the printer or the spool.
 *
 * This renders the REAL row with `renderToStaticMarkup` (the technique
 * tests/policyArticleAnchors.test.ts established) and asserts on the markup,
 * then drives the same payload through the real board route so the two halves
 * — "the server sends the items" and "the row prints them" — are both proven.
 *
 * Run: node --import tsx --test tests/orderBoardRowItems.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import OrderBoardRow, { itemsSummary } from '../src/components/adminOrders/OrderBoardRow';
import type { AdminOrderRow } from '../src/lib/api';
import { freshDb, asD1, stubApp, get, json } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';

const loc = (ar: string) => ar;

function row(items: Array<Record<string, unknown>>): AdminOrderRow {
  return {
    id: 'ORD-ROW1',
    status: 'pending',
    shipping_type: 'direct',
    total_iqd: 250_000,
    address: { name: 'سارة', governorate: 'baghdad' },
    items,
    quick_next: null,
    due_bucket: 'today',
    due_label: 'اليوم',
  } as unknown as AdminOrderRow;
}

function render(order: AdminOrderRow, latin = false): string {
  return renderToStaticMarkup(
    createElement(OrderBoardRow, {
      order,
      loc,
      latin,
      onOpen: () => {},
      onDelete: () => {},
      onAdvance: () => {},
      advancing: false,
      deleting: false,
    })
  );
}

test('THE LINE — name, option/colour and quantity, one entry per item, in Arabic digits', () => {
  const html = render(
    row([
      { name: 'طابعة X', variant: 'أسود', qty: 2 },
      { name: 'PLA', variant: '', qty: 3 },
    ])
  );
  assert.match(html, /data-order-items/);
  assert.match(html, /طابعة X \(أسود\) ×٢ · PLA ×٣/);
  // Readable when truncated: the whole list is in `title`.
  assert.match(html, /title="طابعة X \(أسود\) ×٢ · PLA ×٣"/);
});

test('ENGLISH reads Latin digits; the separator and the order are the same', () => {
  assert.equal(itemsSummary(row([{ name: 'Printer X', variant: 'Black', qty: 2 }]), true), 'Printer X (Black) ×2');
});

test('A BUNDLE IS ONE LINE — its components are never spelled out on the row', () => {
  const html = render(
    row([
      {
        name: 'باقة البداية',
        variant: '',
        qty: 1,
        bundle: { kind: 'bundle', components: [{ name: 'مكوّن سري', variant: '', qty: 4 }] },
      },
    ])
  );
  assert.match(html, /باقة البداية ×١/);
  assert.doesNotMatch(html, /مكوّن سري/);
});

test('AN ORDER WITH NO LINES draws NO line — not an empty row of height', () => {
  assert.doesNotMatch(render(row([])), /data-order-items/);
});

test('END TO END — the board route hands the row its items, and the row prints them', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('u1','زبون','u1@x.co','h','customer'),
      ('boss','Owner','boss@x.co','h','admin');
    INSERT INTO orders
      (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
       subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage)
    VALUES ('ORD-E2E','u1','pending','{"name":"سارة"}','home','{}','cod',1000,1500,1000,0,'direct','received');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
    VALUES ('oi1','ORD-E2E',NULL,'طابعة X','','أسود',2,500,1000),
           ('oi2','ORD-E2E',NULL,'PLA','','',3,0,0);
  `);
  const app = stubApp(
    asD1(raw),
    { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null },
    (a) => a.route('/api/admin', adminRoutes)
  );
  const body = await json(await get(app, '/api/admin/orders?scope=all'));
  const order = (body.orders as AdminOrderRow[]).find((o) => o.id === 'ORD-E2E')!;
  assert.ok(order, JSON.stringify(body).slice(0, 300));
  assert.match(render(order), /طابعة X \(أسود\) ×٢ · PLA ×٣/);
});
