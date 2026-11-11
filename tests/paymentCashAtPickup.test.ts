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
 * And, from the review of that change: a pickup that applies points and part
 * of the wallet owes only the rest at the counter (3.2); version 4 stays
 * readable by `?version=4` once version 5 is archived beside it; and what
 * other documents still say «at the door» is listed exactly, and left to the
 * owner in row 312 (an approved estimate rise on a pickup is proven in
 * tests/orderEstimates.test.ts).
 *
 * Run: node --import tsx --test tests/paymentCashAtPickup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, stubApp, post, get, json, row, all, freshDb, pending, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { policiesRoutes } from '../worker/routes/policies';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';
import { seedCatalogue, orderBody } from './lib/bundles';
import { POLICY_DOCUMENTS } from '../worker/lib/policies';
import { POLICY_LANGS, policyEffectiveInstant, type PolicyLang } from '../worker/lib/policies/types';

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

/**
 * PART OF IT AHEAD, THE REST AT THE COUNTER (payment 3.2: the amount due on
 * collection is the one on the order and the invoice «after deduction of
 * whatever was paid in advance from the wallet or in points»). A buyer holding
 * $200 — 300,000 at the fixture's 1,500 — and 20,000 points turns both on with
 * cash and pickup: the points come off the total, the whole balance is taken
 * when the order is placed, and only the rest is paid in cash at the
 * warehouse, still untaxed. (Article 2.3, «no partial advance», says the
 * opposite of this checkout for a door order as much as for a pickup; that is
 * an owner question in DECISIONS row 312, not something this test settles.)
 */
test('a cash pickup with points and part of the wallet: both are taken at placement, the invoice is partial, and only the rest is paid in cash on collection', async () => {
  const raw = seedCatalogue();
  raw.exec(`
    INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_printer','cat_printers_fdm',0);
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('thin','Noor','t@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default)
      VALUES ('addr_t','thin','Home','Noor','+9647704445556','Mosul, Zuhur 3','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_t','thin','deposit','USD',20000,'approved'),
      ('pts_t','thin','deposit','POINT',20000,'approved');
  `);
  const db = asD1(raw);
  const thin: StubUser = { id: 'thin', role: 'customer', email: 't@x.co' };
  const app = shop(db, thin);
  const added = await json(await post(app, '/api/cart/items', { productId: 'p_printer', qty: 2 }));
  assert.equal(added.success, true, JSON.stringify(added).slice(0, 300));

  const both = { addressId: 'addr_t', useWallet: true, usePoints: true };
  const quoted = await json(await post(app, '/api/orders/quote', { ...quoteBody('pickup'), ...both }));
  assert.equal(quoted.success, true, JSON.stringify(quoted).slice(0, 400));
  const q = quoted.quote;
  assert.equal(q.is_pickup, true);
  assert.equal(q.points.applied_iqd, 20_000, 'the points come off first');
  assert.equal(q.wallet.applied_iqd, 300_000, 'the whole $200 balance, not the whole order');
  assert.equal(q.wallet.required_advance_iqd, 0, 'nothing was required: the customer chose it');
  assert.equal(q.cod_tax_iqd, 0, 'still no cash-on-delivery tax on pickup (3.3)');
  assert.ok(q.total_iqd > 300_000, `total ${q.total_iqd}: the fixture must leave something for the counter`);
  assert.equal(q.due_on_delivery_iqd, q.total_iqd - 300_000, 'the rest is paid in cash on collection');

  const placed = await json(await post(app, '/api/orders', orderBody({ deliveryMethodId: 'pickup', ...both })));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 400));
  const order = placed.order;
  assert.equal(order.payment_method_id, 'cash');
  assert.equal(order.delivery_method.id, 'pickup');
  assert.equal(order.points_discount_iqd, 20_000);
  assert.equal(order.wallet_applied_iqd, 300_000);
  assert.equal(order.total_iqd, q.total_iqd);
  assert.equal(order.due_on_delivery_iqd, q.due_on_delivery_iqd);
  assert.equal(order.financial.outstanding_iqd, order.due_on_delivery_iqd);

  // The invoice says the same: the wallet part paid, the rest due on collection.
  const invoice = row<{ amount_due_iqd: number; amount_paid_iqd: number; payment_status: string }>(
    raw,
    'SELECT amount_due_iqd, amount_paid_iqd, payment_status FROM invoices WHERE order_id = ? AND revision = 1',
    order.id
  )!;
  assert.ok(invoice, 'no invoice was issued');
  assert.deepEqual([invoice.amount_paid_iqd, invoice.amount_due_iqd, invoice.payment_status], [300_000, order.due_on_delivery_iqd, 'partial']);

  // The counter records the cash it took, the rest and no more, and the order is paid.
  const settled = await json(
    await post(shop(db, boss), `/api/orders/${order.id}/settlement`, {
      amountIqd: order.due_on_delivery_iqd,
      eventKey: 'pickup-cash:counter-2',
      kind: 'cod_collection',
    })
  );
  assert.equal(settled.success, true, JSON.stringify(settled).slice(0, 400));
  assert.equal(settled.settlement.collected_iqd, order.total_iqd, 'the wallet part recorded at placement and the cash at the counter');
  assert.equal(settled.settlement.fully_settled, true);
  assert.equal(settled.settlement.outstanding_iqd, 0);
  const after = await json(await get(app, `/api/orders/${order.id}`));
  assert.equal(after.order.financial.payment_state, 'paid');
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

/**
 * WHAT STILL READS AS «AT THE DOOR» — the open question of DECISIONS row 312.
 *
 * Version 5 names the warehouse wherever the payment policy speaks of the
 * amount due. Other documents still speak of cash on delivery, or of an
 * estimate's approved rise, as paid at the door alone. None of them refuses
 * cash on pickup, but on a pickup they leave the customer an argument
 * (purchase 4.16 and price_protection 5.6 say the rise is «collected only at
 * the door», and the code adds it to what the counter collects —
 * tests/orderEstimates.test.ts). Moving them is a new version of purchase and
 * price_protection, and of terms, a consent document every customer would
 * accept again: the owner's call, asked in row 312 («باقٍ»). Until it is
 * made, this list is exact:
 *   - a new statement that cash is paid only at the door — the usual wording,
 *     in any document and language — fails here;
 *   - a listed one that moves fails here too, so the list and row 312 are
 *     cleared together;
 *   - row 312 names every listed article, so the question cannot be lost.
 */
const STILL_AT_THE_DOOR: ReadonlyArray<{ key: string; article: string; says: Partial<Record<PolicyLang, string>> }> = [
  {
    key: 'purchase',
    article: '4.8',
    says: { ar: 'لأنه اختار الدفع عند الباب', en: 'on the ground that they chose to pay at the door', ckb: 'لەبەر ئەوەی پارەدانی لە بەردەرگا هەڵبژاردووە' },
  },
  {
    key: 'purchase',
    article: '4.13',
    says: { ar: 'لا يُسوّى إلا عبر المحفظة أو عند الباب', en: 'can be settled only through the wallet or at the door', ckb: 'تەنها لە ڕێگەی جزدانەوە یان لە بەردەرگا یەکلایی دەکرێتەوە' },
  },
  {
    key: 'purchase',
    article: '4.16',
    says: { ar: 'ولا يُحصَّل إلا عند الباب', en: 'is collected only at the door', ckb: 'تەنها لە بەردەرگا وەردەگیرێت' },
  },
  {
    key: 'purchase',
    article: '10.5',
    says: { ar: 'بتهيئة المبلغ المستحق كاملاً عند الباب', en: 'to have the full amount due ready at the door', ckb: 'ئامادەکردنی تەواوی ئەو بڕەی لە بەردەرگا دەدرێت' },
  },
  {
    key: 'price_protection',
    article: '1.2',
    says: { ar: 'لا من المحفظة ولا عند الباب', en: 'neither from the wallet nor at the door', ckb: 'نە لە جزدان و نە لە بەردەرگا' },
  },
  {
    key: 'price_protection',
    article: '5.6',
    says: { ar: 'حُصِّل الفرق عند الباب وحده', en: 'the difference is collected only at the door', ckb: 'جیاوازییەکە تەنها لە بەردەرگا وەردەگیرێت' },
  },
  {
    key: 'terms',
    article: '6.4',
    says: { ar: 'ومنها الدفع عند الباب', en: 'including payment at the door', ckb: 'لەوانە پارەدان لەبەردەم دەرگا' },
  },
  // The Arabic and the Sorani of 7.7 say «الدفع عند الاستلام», which covers the warehouse; the English narrows it.
  { key: 'terms', article: '7.7', says: { en: 'does offer payment at the door and warehouse pickup' } },
];

/** «Only at the door» as the corpus words it: a new statement of it in any document is a new question for the owner. */
const ONLY_AT_THE_DOOR: Record<PolicyLang, RegExp> = {
  ar: /إلا عند الباب|عند الباب وحده|إلا عبر المحفظة أو عند الباب/,
  en: /only at the door|at the door alone|at the door only|only through the wallet or at the door/i,
  ckb: /تەنها لە بەردەرگا|تەنها لە ڕێگەی جزدانەوە یان لە بەردەرگا/,
};

test('what other documents still say «at the door» is exactly the list row 312 leaves to the owner', () => {
  const listed = new Set(STILL_AT_THE_DOOR.map((s) => `${s.key} ${s.article}`));
  for (const s of STILL_AT_THE_DOOR) {
    const doc = POLICY_DOCUMENTS.find((d) => d.key === s.key)!;
    for (const [lang, words] of Object.entries(s.says) as Array<[PolicyLang, string]>) {
      assert.ok(
        article(doc.body[lang], s.article).includes(words),
        `${s.key} ${s.article}/${lang} no longer says «${words}»: if the owner's answer moved it, clear it here and in row 312`
      );
    }
  }
  for (const doc of POLICY_DOCUMENTS) {
    for (const lang of POLICY_LANGS) {
      for (const part of doc.body[lang].split(/^(?=### )/m)) {
        const n = /^### (\S+)/.exec(part)?.[1];
        if (!n || !ONLY_AT_THE_DOOR[lang].test(part)) continue;
        assert.ok(listed.has(`${doc.key} ${n}`), `${doc.key} ${n}/${lang} says cash is paid only at the door, and the owner was never asked about it (row 312)`);
      }
    }
  }

  const register = readFileSync(join(ROOT, 'docs', 'DECISIONS.md'), 'utf8');
  const row312 = register.split('\n').find((l) => l.startsWith('| 312 |'));
  assert.ok(row312, 'DECISIONS row 312 is the owner’s ruling on cash at pickup');
  const from = row312.indexOf('**باقٍ**');
  assert.ok(from > 0, 'row 312 has no «باقٍ»');
  const open = row312.slice(from);
  for (const s of STILL_AT_THE_DOOR) {
    assert.match(open, new RegExp(`(?<![\\d.])${s.article.replace('.', '\\.')}(?!\\d)`), `row 312 «باقٍ» does not name ${s.key} ${s.article}`);
  }
});

/**
 * VERSION 4 IS STILL THE TEXT ITS READERS READ. The archive holds payment 4 as
 * the live database does; the first read on the new Worker answers version 5
 * from the code and writes it beside version 4, dated the day it takes effect
 * (`published_at = effective_at`, which migration 0070 then freezes — hence
 * row 303: the date must be the day it goes live). `?version=4` still serves
 * the archived rows, untouched.
 */
test('?version=4 still serves the archived payment 4 after the first read writes version 5 beside it, dated the day it takes effect', async () => {
  const raw = freshDb();
  resetPolicyCorpusMemo();
  const LEDGER = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'policyHashes.json'), 'utf8')) as Record<string, string>;
  const V4 = { ar: 'نص النسخة 4 كما نُشر', en: 'The version 4 text as published', ckb: 'دەقی وەشانی 4 وەک بڵاوکرایەوە' } as const;
  for (const lang of POLICY_LANGS) {
    raw
      .prepare(
        `INSERT INTO policy_documents (id,key,version,lang,title,body,hash,status,published_at,effective_at)
         VALUES (?, 'payment', 4, ?, 'Payment and Wallet Policy', ?, ?, 'published', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z')`
      )
      .run(`pol_pay4_${lang}`, lang, V4[lang], LEDGER[`payment@4:${lang}`]);
  }
  const doc = POLICY_DOCUMENTS.find((d) => d.key === 'payment')!;
  const at = policyEffectiveInstant(doc.effective_at);
  const reader = (user: StubUser | null) => stubApp(asD1(raw), user, (a) => a.route('/api/policies', policiesRoutes));

  const current = await json(await get(reader(null), '/api/policies/payment?lang=ar'));
  assert.equal(current.success, true, JSON.stringify(current).slice(0, 300));
  assert.equal(current.policy.version, 5);
  assert.equal(current.policy.effective_at, at);
  assert.equal(current.policy.hash, LEDGER['payment@5:ar']);
  await Promise.all(pending.splice(0));

  const archived = all<{ lang: string; hash: string; published_at: string; effective_at: string }>(
    raw,
    "SELECT lang, hash, published_at, effective_at FROM policy_documents WHERE key = 'payment' AND version = 5 AND status = 'published' ORDER BY lang"
  );
  assert.deepEqual(
    archived.map((r) => ({ ...r })),
    [...POLICY_LANGS].sort().map((lang) => ({ lang, hash: LEDGER[`payment@5:${lang}`], published_at: at, effective_at: at })),
    'version 5 archived in three languages, under its ledgered hashes, dated the day it takes effect'
  );

  for (const lang of POLICY_LANGS) {
    const old = await json(await get(reader(buyer), `/api/policies/payment?lang=${lang}&version=4`));
    assert.equal(old.success, true, JSON.stringify(old).slice(0, 300));
    assert.equal(old.policy.version, 4);
    assert.equal(old.policy.body, V4[lang], `${lang}: version 4 is served from the archive, as it was published`);
    assert.equal(old.policy.hash, LEDGER[`payment@4:${lang}`]);
    const stored = row<{ body: string; hash: string; effective_at: string }>(raw, 'SELECT body, hash, effective_at FROM policy_documents WHERE id = ?', `pol_pay4_${lang}`)!;
    assert.deepEqual({ ...stored }, { body: V4[lang], hash: LEDGER[`payment@4:${lang}`], effective_at: '2026-09-23T00:00:00.000Z' }, `${lang}: the sync touched version 4`);
  }
  resetPolicyCorpusMemo();
});
