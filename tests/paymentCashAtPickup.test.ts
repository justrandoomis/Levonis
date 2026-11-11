/**
 * CASH AT WAREHOUSE PICKUP — the owner, 2026-11-11 (DECISIONS row 312).
 *
 * Payment policy version 4 said cash on delivery «غير متاح على الاستلام من
 * المخزن» while the checkout offered it there. The owner chose the checkout:
 * «Allow cash at pickup: keep the checkout as it is; publish a new version of
 * the payment policy that lets pickup customers pay cash when they collect.»
 *
 * This file holds the two halves together, so neither can move alone:
 *   - THE CHECKOUT, through the real cart, quote, order and settlement routes:
 *     a pickup cart is offered cash; a cash pickup carries no cash-on-delivery
 *     tax and needs nothing in advance, owes its whole total at the warehouse
 *     (on the order and on its invoice), and is paid only once the collection
 *     is recorded — the same door a courier's cash goes through;
 *   - THE PUBLISHED PAYMENT POLICY, version 5, in ar, en and ckb: 1.2 and 3.1
 *     let a pickup be paid in cash on collection and still keep community
 *     stores prepaid, 3.3 still charges no tax on pickup, 3.5 hands a pickup
 *     over only once it is paid, and no document still says the opposite.
 *
 * Run: node --import tsx --test tests/paymentCashAtPickup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, stubApp, post, get, json, row, pending, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { seedCatalogue, orderBody } from './lib/bundles';
import { POLICY_DOCUMENTS } from '../worker/lib/policies';
import { POLICY_LANGS, type PolicyLang } from '../worker/lib/policies/types';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const boss: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };

const shop = (db: D1Database, user: StubUser) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

const quoteBody = (deliveryMethodId: string) => ({
  addressId: 'addr_b',
  deliveryMethodId,
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
});

/**
 * Two printers in the cart: 800,000 IQD, so a door collection reaches a whole
 * tax block and the pickup's zero is the exemption, not a small order. Filed
 * under the seeded printers section, so the printer rules (the home-delivery
 * advance among them) apply exactly as they do in the shop.
 */
async function pickupWorld() {
  const raw = seedCatalogue();
  raw.exec("INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_printer','cat_printers_fdm',0)");
  const db = asD1(raw);
  const app = shop(db, buyer);
  const added = await json(await post(app, '/api/cart/items', { productId: 'p_printer', qty: 2 }));
  assert.equal(added.success, true, JSON.stringify(added).slice(0, 300));
  return { raw, db, app };
}

test('the checkout offers cash on pickup: no cash-on-delivery tax, nothing in advance, the whole total due at the warehouse', async () => {
  const { app } = await pickupWorld();

  const pickup = await json(await post(app, '/api/orders/quote', quoteBody('pickup')));
  assert.equal(pickup.success, true, JSON.stringify(pickup).slice(0, 400));
  const q = pickup.quote;
  assert.equal(q.is_pickup, true);
  assert.ok(q.allowed_payment_methods.includes('cash'), `pickup offers ${JSON.stringify(q.allowed_payment_methods)}`);
  assert.equal(q.cod_tax_iqd, 0, 'no cash-on-delivery tax on pickup (payment 3.3)');
  assert.equal(q.cod_tax_before_exemption_iqd, 0, 'zero because pickup is not taxed, not because a membership waived it');
  assert.equal(q.wallet.required_advance_iqd, 0, 'a pickup asks nothing of the wallet in advance');
  assert.equal(q.wallet.applied_iqd, 0);
  assert.ok(q.total_iqd >= 800_000, `total ${q.total_iqd}`);
  assert.equal(q.due_on_delivery_iqd, q.total_iqd, 'the whole total is paid in cash at the warehouse');

  // The same cart and the same cash, delivered to the door: the tax and the
  // printer advance both apply there, which is what makes the zeros above the
  // pickup's own.
  const door = await json(await post(app, '/api/orders/quote', quoteBody('standard')));
  assert.equal(door.success, true, JSON.stringify(door).slice(0, 400));
  assert.equal(door.quote.is_pickup, false);
  assert.ok(door.quote.allowed_payment_methods.includes('cash'));
  assert.ok(door.quote.cod_tax_iqd > 0, 'a door collection of a whole block is taxed');
  assert.ok(door.quote.wallet.required_advance_iqd > 0, 'home delivery of a printer takes its advance');
});

test('a cash pickup is placed with the whole total due, on the order and on its invoice, and stays unpaid until the collection is recorded', async () => {
  const { raw, db, app } = await pickupWorld();

  const placed = await json(await post(app, '/api/orders', orderBody({ deliveryMethodId: 'pickup' })));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 400));
  const order = placed.order;
  assert.equal(order.payment_method_id, 'cash');
  assert.equal(order.delivery_method.id, 'pickup');
  assert.equal(order.cod_tax_iqd, 0);
  assert.equal(order.wallet_applied_iqd, 0);
  assert.equal(order.due_on_delivery_iqd, order.total_iqd);
  assert.equal(order.financial.payment_state, 'cod_due', 'an order handed over at the warehouse is not paid by existing');
  assert.equal(order.financial.outstanding_iqd, order.total_iqd);

  // The invoice issued at placement says the same: everything due, nothing paid, no tax line.
  const invoice = row<{ amount_due_iqd: number; amount_paid_iqd: number; payment_status: string; snapshot: string }>(
    raw,
    'SELECT amount_due_iqd, amount_paid_iqd, payment_status, snapshot FROM invoices WHERE order_id = ? AND revision = 1',
    order.id
  )!;
  assert.ok(invoice, 'no invoice was issued');
  assert.equal(invoice.amount_due_iqd, order.total_iqd);
  assert.equal(invoice.amount_paid_iqd, 0);
  assert.equal(invoice.payment_status, 'cod_due');
  assert.equal(JSON.parse(invoice.snapshot).totals.cod_tax_iqd, 0);

  // A customer cannot mark their own cash as collected.
  const self = await post(app, `/api/orders/${order.id}/settlement`, { amountIqd: order.total_iqd, eventKey: 'pickup:self' });
  assert.equal(self.status, 404);

  // The team records the cash taken at the warehouse counter — the one door
  // that settles a cash order, for a pickup exactly as for a courier (3.4).
  const settled = await json(
    await post(shop(db, boss), `/api/orders/${order.id}/settlement`, {
      amountIqd: order.due_on_delivery_iqd,
      eventKey: 'pickup-cash:counter-1',
      kind: 'cod_collection',
      note: 'paid in cash on collection at the warehouse',
    })
  );
  assert.equal(settled.success, true, JSON.stringify(settled).slice(0, 400));
  assert.equal(settled.settlement.fully_settled, true);
  assert.equal(settled.settlement.collected_iqd, order.total_iqd);
  assert.equal(settled.settlement.outstanding_iqd, 0);

  const after = await json(await get(app, `/api/orders/${order.id}`));
  assert.equal(after.order.financial.payment_state, 'paid');
  assert.equal(after.order.financial.collected_iqd, order.total_iqd);
  assert.equal(after.order.financial.outstanding_iqd, 0);
  await Promise.allSettled(pending.splice(0));
});

/** One article of a published body: its heading line through the line before the next heading. */
function article(body: string, n: string): string {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`### ${n} `));
  assert.ok(at >= 0, `article ${n} is not published`);
  const end = lines.findIndex((l, i) => i > at && l.startsWith('#'));
  return lines.slice(at, end < 0 ? undefined : end).join('\n');
}

type Clause = 'def' | 'scope' | 'cash' | 'community' | 'noTax' | 'handOver' | 'merchant';
const SAYS: Record<PolicyLang, Record<Clause, string>> = {
  ar: {
    def: 'تحصيل قيمة الطلب نقداً عند تسليمه إلى عنوان، أو عند استلامه من المخزن',
    scope: 'سواء سُلِّمت إلى عنوان أو استلمها الزبون من المخزن',
    cash: 'وفي الاستلام من المخزن يُدفع المبلغ نقداً عند استلام الطلب',
    community: 'وهو غير متاح في طلبات متاجر مجتمع ليفو',
    noTax: 'ولا تُفرض على الطلب المدفوع مسبقاً ولا على الاستلام من المخزن',
    handOver: 'وإذا لم يوفّره عند الاستلام من المخزن لم يُسلَّم إليه الطلب حتى يؤدي المبلغ المستحق كاملاً',
    merchant: 'لا يوجد دفع عند الاستلام في طلبات التجار',
  },
  en: {
    def: "collection of the order's value in cash on its delivery to an address, or on its collection from the warehouse",
    scope: 'whether they are delivered to an address or collected by the customer from the warehouse',
    cash: 'On warehouse pickup the amount is paid in cash when the order is collected',
    community: 'It is not available on orders from Levo community stores',
    noTax: 'It is not charged on a prepaid order or on warehouse pickup',
    handOver: 'Where they do not have it on collection from the warehouse, the order is not handed over to them until the amount due is paid in full',
    merchant: 'There is no cash on delivery on merchant orders',
  },
  ckb: {
    def: 'کۆکردنەوەی بەهای داواکارییەکە بە نەقد لە کاتی گەیاندنی بۆ ناونیشانێک، یان لە کاتی وەرگرتنی لە کۆگا',
    scope: 'چ بۆ ناونیشانێک بگەیەنرێن چ کڕیار لە کۆگا وەریان بگرێت',
    cash: 'لە وەرگرتن لە کۆگادا بڕەکە لە کاتی وەرگرتنی داواکارییەکەدا بە نەقد دەدرێت',
    community: 'لە داواکارییەکانی فرۆشگاکانی کۆمەڵگای لیڤۆدا بەردەست نییە',
    noTax: 'لەسەر داواکاری پێشەکی دراو و لەسەر وەرگرتن لە کۆگا زیاد ناکرێت',
    handOver: 'ئەگەر لە کاتی وەرگرتن لە کۆگادا ئامادەی نەکرد، تا تەواوی بڕەکە نەدات داواکارییەکەی ڕادەست ناکرێت',
    merchant: 'لە داواکارییەکانی بازرگاناندا پارەدان لە کاتی وەرگرتن نییە',
  },
};

test('payment 5 says it in ar, en and ckb: pickup is paid in cash on collection, community stores stay prepaid, no tax on pickup, handed over once paid', () => {
  const doc = POLICY_DOCUMENTS.find((d) => d.key === 'payment')!;
  assert.equal(doc.version, 5);
  for (const lang of POLICY_LANGS) {
    const body = doc.body[lang];
    const says = SAYS[lang];
    assert.ok(article(body, '1.2').includes(says.def), `payment/${lang} 1.2: cash on delivery is not defined to include the warehouse`);
    const scope = article(body, '3.1');
    for (const part of ['scope', 'cash', 'community'] as const) {
      assert.ok(scope.includes(says[part]), `payment/${lang} 3.1 lost «${says[part]}»`);
    }
    assert.ok(article(body, '3.3').includes(says.noTax), `payment/${lang} 3.3: pickup is no longer exempt from the tax`);
    assert.ok(article(body, '3.5').includes(says.handOver), `payment/${lang} 3.5: a pickup without the money is not dealt with`);
    // Chapter 9 is untouched: a community-store order still has no cash on delivery.
    assert.ok(article(body, '9.2').includes(says.merchant), `payment/${lang} 9.2: merchant orders gained cash on delivery`);
  }
  // The Sorani is Sorani (DECISIONS row 183): every changed article carries its own letters, never the Arabic.
  for (const n of ['1.2', '3.1', '3.2', '3.4', '3.5', '11.8']) {
    const ckb = article(doc.body.ckb, n);
    assert.notEqual(ckb, article(doc.body.ar, n), `payment/ckb ${n} is the Arabic`);
    assert.match(ckb, /[ڕێۆەڵ]/, `payment/ckb ${n} carries no Sorani letter`);
  }
});

test('no published policy still says cash on delivery is unavailable on warehouse pickup', () => {
  const OLD: Record<PolicyLang, RegExp> = {
    ar: /غير متاح على الاستلام من المخزن/,
    en: /not available on warehouse pickup/i,
    ckb: /لەسەر وەرگرتن لە کۆگاش بەردەست نییە/,
  };
  for (const doc of POLICY_DOCUMENTS) {
    for (const lang of POLICY_LANGS) {
      assert.doesNotMatch(doc.body[lang], OLD[lang], `${doc.key}/${lang} still refuses cash on pickup`);
    }
  }
});
