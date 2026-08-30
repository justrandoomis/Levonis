#!/usr/bin/env node
/**
 * The admin order fulfilment screen, driven in a real browser.
 *
 * WHY THIS EXISTS. The owner's report was "الطلبات لا يمكن عرض المعلومات
 * لتجهيز الطلب" — the orders table showed an id, a customer, an item count, a
 * total and a status, and nothing a person can pack a box from. This drives a
 * REAL order placed through the real checkout, opens the real modal, and
 * checks what an admin can actually read and copy:
 *
 *   * the name on its own, the phone, governorate, area, landmark and notes,
 *     each with its own copy button that copies THAT value and nothing else
 *   * the items with the option/colour the customer picked, and the quantity
 *   * the final total, copyable, as the number written on the receipt
 *   * the price breakdown, collapsed until asked for
 *   * a chat about the order, in the same modal, without navigating away
 *
 * Clipboard reads need a granted permission, so the context grants it and the
 * test asserts the CLIPBOARD CONTENT — not merely that a button exists.
 *
 *   node scripts/e2e-order-fulfilment.mjs        (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const OUT = path.join(ROOT, 'docs', 'evidence', 'orders');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
  }
}

let passed = 0;
let failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const sql = (statement) => {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' });
};
const settle = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* re-binding */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the dev server did not come back');
};

class Client {
  constructor() {
    this.cookie = '';
  }
  async call(method, p, body) {
    const headers = this.cookie ? { Cookie: this.cookie } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  }
  get(p) {
    return this.call('GET', p);
  }
  post(p, b) {
    return this.call('POST', p, b);
  }
  put(p, b) {
    return this.call('PUT', p, b);
  }
}

const rnd = Math.random().toString(36).slice(2, 8);
const NAME = `زبون الاختبار ${rnd}`;
const PHONE = `+964-7701${Math.floor(100000 + Math.random() * 899999)}`;
const AREA = `الكرادة ${rnd}`;
const LANDMARK = `مقابل الجامع ${rnd}`;
const NOTES = `اتصل قبل الوصول ${rnd}`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nLEVONIS order fulfilment — ${BASE}\n`);

  // ------------------------------------------------ a real customer + order
  console.log('0. a real order, placed through the real checkout');
  const buyer = new Client();
  const email = `ord-${rnd}@test.local`;
  const password = 'orders-pass-1';
  let r = await buyer.post('/api/auth/register', { email, username: `ord${rnd}`, name: 'Order Buyer', password });
  check('customer registered', r.status === 200, JSON.stringify(r.data).slice(0, 140));
  await buyer.post('/api/auth/login', { email, password });

  // The address carries every field the fulfilment screen must show.
  const addr = await buyer.post('/api/addresses', {
    label: 'Home',
    name: NAME,
    phone: PHONE,
    address: 'شارع 62، محلة 909، دار 15',
    landmark: LANDMARK,
    governorate: 'baghdad',
    area: AREA,
    notes: NOTES,
    isDefault: true,
  });
  check('the address saved with governorate, area and notes', addr.status === 200, JSON.stringify(addr.data).slice(0, 160));
  const addressId = addr.data?.id;

  const back = await buyer.get('/api/addresses');
  const saved = (back.data?.addresses ?? []).find((a) => a.id === addressId);
  check('the governorate round-trips as an id', saved?.governorate === 'baghdad', JSON.stringify(saved?.governorate));
  check('the area round-trips', saved?.area === AREA, JSON.stringify(saved?.area));
  check('the notes round-trip', saved?.notes === NOTES, JSON.stringify(saved?.notes));

  const bogus = await buyer.post('/api/addresses', {
    label: 'X', name: 'X Y', phone: PHONE, address: 'somewhere over there',
    governorate: 'Atlantis',
  });
  check('an unknown governorate is refused, not silently stored empty', bogus.status >= 400, `status=${bogus.status}`);

  // A product to buy.
  const admin = new Client();
  const adminEmail = `orda-${rnd}@test.local`;
  await admin.post('/api/auth/register', { email: adminEmail, username: `orda${rnd}`, name: 'Order Admin', password });
  sql(`UPDATE users SET role='admin' WHERE email='${adminEmail}'`);
  await settle();
  await admin.post('/api/auth/login', { email: adminEmail, password });

  const cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const section = cats.find((c) => c.effective_template_family === 'devices') ?? cats[0];
  const created = await admin.post('/api/admin/products-v2', {
    name_en: `Order Fixture ${rnd}`,
    description_en: 'A product to place a real order against.',
    price_iqd: 250000,
    status: 'active',
    sale_types: ['direct_sale'],
    category_id: section?.id ?? null,
    stock: 10,
    options: [{ id: `og_${rnd}`, name_en: 'Bundle', sort: 0, active: true }],
    colors: [{ id: `c_${rnd}`, name_en: 'Matte Black', hex: '#111111', sort: 0, active: true }],
  });
  const productId = created.data?.product?.id;
  check('a product exists to order', created.status === 200 && !!productId, JSON.stringify(created.data).slice(0, 200));

  const add = await buyer.post('/api/cart/items', {
    productId,
    qty: 2,
    optionId: `og_${rnd}`,
    colorId: `c_${rnd}`,
  });
  check('the item is in the cart with an option and a colour', add.status === 200, JSON.stringify(add.data).slice(0, 200));

  const methods = (await buyer.get('/api/settings/public')).data?.settings?.checkoutDeliveryMethods ?? [];
  const deliveryId = methods[0]?.id ?? 'standard';

  // §7 consent: checkout refuses without the CURRENT published versions, so
  // the test accepts exactly what the server says is required rather than
  // hardcoding a version that would rot.
  const pol = await buyer.get('/api/policies');
  const policyAcceptance = (pol.data?.policies ?? [])
    .filter((p) => p.key === 'terms' || p.key === 'privacy')
    .map((p) => ({ key: p.key, version: Number(p.version) }));

  const placed = await buyer.post('/api/orders', {
    addressId,
    deliveryMethodId: deliveryId,
    paymentMethodId: 'cash',
    policyAcceptance,
    idempotencyKey: `ord-${rnd}-key`,
  });
  check('the order was placed', placed.status === 200, JSON.stringify(placed.data).slice(0, 240));
  const orderId = placed.data?.order?.id;
  if (!orderId) throw new Error('no order to inspect');
  console.log(`     order ${orderId}`);

  // ----------------------------------------------- the detail API itself
  console.log('\n1. the fulfilment payload');
  const detail = await admin.get(`/api/admin/orders/${orderId}`);
  check('the order detail endpoint answers', detail.status === 200, `status=${detail.status}`);
  const o = detail.data?.order;
  check('it carries the address the order was placed to', o?.address?.governorate === 'baghdad', JSON.stringify(o?.address));
  check('it carries the customer', !!o?.customer?.id, JSON.stringify(o?.customer));
  check('it carries the money breakdown', typeof o?.financial?.total_iqd === 'number', JSON.stringify(o?.financial ?? null).slice(0, 200));
  check('it carries the items', (o?.items ?? []).length === 1, `items=${(o?.items ?? []).length}`);
  check('the item keeps its quantity', o?.items?.[0]?.qty === 2, JSON.stringify(o?.items?.[0]?.qty));
  check(
    'it never leaks cost — §11 holds on this screen too',
    !JSON.stringify(detail.data).includes('cost_iqd'),
    'cost_iqd appears in the payload'
  );
  const missing = await admin.get('/api/admin/orders/ORD-DOES-NOT-EXIST');
  check('an unknown order is a 404, not an empty screen', missing.status === 404, `status=${missing.status}`);

  // ---- the list: a PAGE, and one query for its items
  const list = await admin.get('/api/admin/orders?limit=5');
  check('the list returns a page, not everything', (list.data?.orders ?? []).length <= 5, `n=${(list.data?.orders ?? []).length}`);
  check('the list reports the total so the UI can page', typeof list.data?.total === 'number', JSON.stringify(list.data?.total));
  check(
    'items still come back with each order',
    (list.data?.orders ?? []).every((o) => Array.isArray(o.items)),
    'an order had no items array'
  );
  const filteredList = await admin.get('/api/admin/orders?status=pending&limit=50');
  check(
    'the status filter is applied by the SERVER, across the whole table',
    (filteredList.data?.orders ?? []).every((o) => o.status === 'pending'),
    JSON.stringify((filteredList.data?.orders ?? []).map((o) => o.status).slice(0, 8))
  );

  // ---- corrections in both directions
  console.log('\n1b. an order can be corrected, not just advanced');
  const move = async (to) => admin.call('PATCH', `/api/admin/orders/${orderId}`, { status: to });
  let r2 = await move('confirmed');
  check('pending -> confirmed', r2.status === 200, JSON.stringify(r2.data).slice(0, 160));
  r2 = await move('shipped');
  check('confirmed -> shipped skips a step, as a real shop does', r2.status === 200, JSON.stringify(r2.data).slice(0, 160));
  r2 = await move('processing');
  check('shipped -> processing BACKWARDS, to undo a mis-tap', r2.status === 200, JSON.stringify(r2.data).slice(0, 160));
  r2 = await move('delivered');
  check('processing -> delivered', r2.status === 200, JSON.stringify(r2.data).slice(0, 200));
  r2 = await move('shipped');
  check('delivered -> shipped is allowed as the one correction path', r2.status === 200, JSON.stringify(r2.data).slice(0, 160));
  check(
    'and it SAYS what a reversal does not undo',
    /not reversed|NOT reversed/i.test(JSON.stringify(r2.data ?? '')),
    JSON.stringify(r2.data).slice(0, 200)
  );
  r2 = await move('shipped');
  check('a no-op move to the same status is refused', r2.status >= 400, `status=${r2.status}`);
  r2 = await admin.call('PATCH', `/api/admin/orders/${orderId}`, { status: 'nonsense' });
  check('an unknown status is refused', r2.status >= 400, `status=${r2.status}`);

  // Leave the fixture mid-flight. `delivered` deliberately offers only the
  // single correction path, so parking it there would make the "more than two
  // moves" check below assert the opposite of what it means to.
  r2 = await move('processing');
  check('the fixture is left mid-flight for the UI checks', r2.status === 200, JSON.stringify(r2.data).slice(0, 140));

  // ------------------------------------------------------------ the modal
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  for (const width of [390, 768, 1024, 1440]) {
    console.log(`\n2. the modal at ${width}px`);
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      locale: 'ar',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    await ctx.addCookies([
      {
        name: admin.cookie.split('=')[0],
        value: admin.cookie.split('=').slice(1).join('='),
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    if ((await page.locator('[data-tab="orders"]:visible').count()) === 0) {
      await page.locator('[data-action="open-sidebar"]').first().click();
      await page.waitForTimeout(400);
    }
    await page.locator('[data-tab="orders"]:visible').first().click({ timeout: 15000 });
    await page.waitForTimeout(1200);

    // ---- the list itself, before anything is opened
    const layout = await page.evaluate(() => {
      const strip = document.querySelector('[data-order-filters]');
      const buttons = strip ? [...strip.querySelectorAll('[data-order-filter]')] : [];
      const last = buttons[buttons.length - 1];
      return {
        filters: buttons.length,
        // A strip whose content is wider than its box must be SCROLLABLE. It
        // used to sit in a flex row with no min-w-0, so on a phone the row
        // refused to shrink and the last filters were simply unreachable.
        stripScrollable: strip ? strip.scrollWidth > strip.clientWidth + 1 : false,
        stripOverflows: strip ? getComputedStyle(strip).overflowX : null,
        lastFilterReachable: !!last && last.getBoundingClientRect().width > 0,
        shortestFilter: buttons.length
          ? Math.round(Math.min(...buttons.map((b) => b.getBoundingClientRect().height)))
          : 0,
        cards: document.querySelectorAll('[data-order-card]').length,
        tables: [...document.querySelectorAll('table')].filter((t) => t.getBoundingClientRect().width > 0).length,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check(`${width}px — all seven status filters are rendered`, layout.filters === 7, JSON.stringify(layout.filters));
    check(`${width}px — every filter is at least 44px tall`, layout.shortestFilter >= 44, `${layout.shortestFilter}px`);
    check(
      `${width}px — the filter strip can be scrolled to its last filter`,
      layout.stripOverflows === 'auto' || layout.stripOverflows === 'scroll' || !layout.stripScrollable,
      JSON.stringify(layout)
    );
    check(`${width}px — the orders list does not scroll the page sideways`, layout.docOverflow <= 1, `${layout.docOverflow}px`);
    if (width === 390) {
      // CARDS on a phone. A seven-column table on a 390px screen puts the one
      // control the owner came for off the right edge of a sideways scroll.
      check('390px — orders render as cards, not a wide table', layout.cards > 0 && layout.tables === 0, JSON.stringify(layout));
    } else {
      check(`${width}px — orders render as a table from the tablet up`, layout.tables === 1, JSON.stringify(layout));
    }

    if (width === 390 || width === 1024) {
      await page.screenshot({ path: path.join(OUT, `orders-list-${width}.png`) });
    }

    const openBtn = page.locator(`[data-action="prepare"][data-order-id="${orderId}"]:visible`);
    check(`${width}px — the order is listed with a way to open it`, (await openBtn.count()) === 1, `found=${await openBtn.count()}`);
    if ((await openBtn.count()) !== 1) {
      await page.screenshot({ path: path.join(OUT, `orders-${width}-missing.png`), fullPage: true });
      await ctx.close();
      continue;
    }
    await openBtn.click();
    await page.waitForTimeout(1400);

    const modal = page.locator('[data-order-modal]');
    check(`${width}px — the modal opened`, (await modal.count()) === 1);

    // THE MODAL MUST BE ON SCREEN WITHOUT SCROLLING. `position: fixed` stops
    // meaning "the viewport" under any ancestor with a transform or filter,
    // and the admin page has a scrolling pane — so the modal opened far below
    // the fold and the owner had to hunt for it. It is portalled to <body>
    // now; this measures where it actually landed.
    const placement = await page.evaluate(() => {
      const el = document.querySelector('[data-order-modal]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        inBody: el.closest('#main-scroll-container') === null,
        vh: window.innerHeight,
      };
    });
    check(
      `${width}px — the modal is portalled out of the scrolling pane`,
      placement?.inBody === true,
      JSON.stringify(placement)
    );
    check(
      `${width}px — the modal is visible without scrolling`,
      !!placement && placement.top >= -2 && placement.top < placement.vh * 0.5,
      JSON.stringify(placement)
    );
    if ((await modal.count()) !== 1) {
      await ctx.close();
      continue;
    }

    // Every value the admin has to retype, and its own copy button.
    const fields = await page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('[data-copy-button]')) {
        const label = el.getAttribute('data-copy-button');
        const box = el.closest('div')?.parentElement;
        const value = box?.querySelector('[data-copy-value]')?.textContent ?? '';
        out[label] = { value, h: Math.round(el.getBoundingClientRect().height) };
      }
      return out;
    });
    const labels = Object.keys(fields);
    check(`${width}px — the copyable fields are present`, labels.length >= 6, JSON.stringify(labels));
    check(
      `${width}px — every copy button is at least 44px`,
      Object.values(fields).every((f) => f.h >= 44),
      JSON.stringify(Object.entries(fields).map(([k, v]) => `${k}:${v.h}`))
    );

    const valueOf = (needle) => {
      const k = labels.find((l) => l.includes(needle));
      return k ? fields[k].value : null;
    };
    check(`${width}px — the name is shown`, valueOf('الاسم') === NAME, JSON.stringify(valueOf('الاسم')));
    check(`${width}px — the phone is shown`, valueOf('الرقم') === PHONE, JSON.stringify(valueOf('الرقم')));
    check(`${width}px — the governorate is shown by NAME, not by id`, valueOf('المحافظة') === 'بغداد', JSON.stringify(valueOf('المحافظة')));
    check(`${width}px — the area is shown`, valueOf('المنطقة') === AREA, JSON.stringify(valueOf('المنطقة')));
    check(`${width}px — the landmark is shown`, valueOf('نقطة دالة') === LANDMARK, JSON.stringify(valueOf('نقطة دالة')));
    check(`${width}px — the notes are shown`, valueOf('الملاحظات') === NOTES, JSON.stringify(valueOf('الملاحظات')));

    // THE COPY ACTUALLY COPIES — and copies that field ALONE.
    const nameLabel = labels.find((l) => l.includes('الاسم'));
    await page.locator(`[data-copy-button="${nameLabel}"]`).click();
    await page.waitForTimeout(350);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check(`${width}px — copying the name yields the name and nothing else`, clip === NAME, JSON.stringify(clip));

    // The number written on the receipt.
    const totalLabel = labels.find((l) => l.includes('الإجمالي بعد'));
    check(`${width}px — the final total has its own copy button`, !!totalLabel, JSON.stringify(labels));
    if (totalLabel) {
      await page.locator(`[data-copy-button="${totalLabel}"]`).click();
      await page.waitForTimeout(350);
      const totalClip = await page.evaluate(() => navigator.clipboard.readText());
      check(
        `${width}px — the copied total is the order total, digits only`,
        totalClip === String(o.total_iqd),
        `clip=${JSON.stringify(totalClip)} total=${o.total_iqd}`
      );
    }

    // The breakdown starts collapsed and opens on click.
    check(`${width}px — the price breakdown starts collapsed`, (await page.locator('[data-breakdown]').count()) === 0);
    await page.locator('[data-breakdown-toggle]').click();
    await page.waitForTimeout(300);
    check(`${width}px — clicking it expands the breakdown`, (await page.locator('[data-breakdown]').count()) === 1);
    const rows = await page.locator('[data-breakdown] dt').allInnerTexts();
    check(`${width}px — the breakdown names the parts`, rows.length >= 3, JSON.stringify(rows));

    // The goods, with what the customer picked.
    const items = await page.locator('[data-order-item]').count();
    check(`${width}px — the item is listed`, items === 1, `items=${items}`);
    const itemText = await page.locator('[data-order-item]').first().innerText();
    check(`${width}px — the quantity is on the card`, /2/.test(itemText), JSON.stringify(itemText.slice(0, 120)));

    // The status control must offer real choices, not two.
    const options = await page.evaluate(() => {
      // Both layouts are in the DOM; read the one actually on screen.
      const sel = [...document.querySelectorAll('[data-order-status-select]')].find(
        (e) => e.getBoundingClientRect().width > 0
      );
      return sel ? [...sel.querySelectorAll('option')].filter((o) => o.value).map((o) => o.value) : [];
    });
    check(
      `${width}px — the status control offers more than two moves`,
      options.length >= 3,
      JSON.stringify(options)
    );

    // Nothing spills — this is a modal on a phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    check(`${width}px — the page does not scroll sideways`, overflow <= 1, `${overflow}px`);

    if (width === 390 || width === 1024) {
      await page.screenshot({ path: path.join(OUT, `order-modal-${width}.png`) });
    }

    // ---- the chat tab, in the SAME modal
    await page.locator('[data-order-tab="chat"]').click();
    await page.waitForTimeout(1600);
    check(`${width}px — the chat opens without leaving the page`, new URL(page.url()).pathname === '/admin', page.url());
    check(`${width}px — the modal is still open`, (await page.locator('[data-order-modal]').count()) === 1);
    const composer = page.locator('[data-order-chat-input]');
    check(`${width}px — the chat has a composer`, (await composer.count()) === 1);

    // Opening the chat scrolls to the newest message. That must scroll the
    // MESSAGE LIST — an earlier version used scrollIntoView, which walks every
    // scrollable ancestor, scrolled the admin page behind the modal and
    // dragged the modal itself off the bottom of the screen.
    const box = await page.locator('[data-order-modal]').boundingBox();
    check(
      `${width}px — the modal stays on screen after the chat scrolls to the newest message`,
      !!box && box.y > -2 && box.y < 900 * 0.5,
      JSON.stringify(box)
    );

    if (width === 1024) {
      const msg = `رسالة بخصوص الطلب ${rnd}`;
      await composer.fill(msg);
      await page.locator('[data-order-chat-send]').click();
      await page.waitForTimeout(2000);
      const shown = await page.locator('[data-order-chat]').innerText();
      check('the message appears in the thread', shown.includes(msg), JSON.stringify(shown.slice(0, 160)));
      await page.screenshot({ path: path.join(OUT, 'order-modal-chat-1024.png') });

      // And it is scoped to THIS order, not a general DM.
      const scoped = await admin.get(`/api/admin/orders/${orderId}`);
      check('the thread is attached to the order', !!scoped.data?.order?.chat_id, JSON.stringify(scoped.data?.order?.chat_id));
    }

    // Back to the order — the modal must not have lost it.
    await page.locator('[data-order-tab="order"]').click();
    await page.waitForTimeout(500);
    check(
      `${width}px — switching back still shows the order`,
      (await page.locator('[data-order-item]').count()) === 1
    );

    await ctx.close();
  }

  // ------------------------------------------------------- who may open it
  console.log('\n3. an order thread is not public');
  const stranger = new Client();
  const sEmail = `ords-${rnd}@test.local`;
  await stranger.post('/api/auth/register', { email: sEmail, username: `ords${rnd}`, name: 'Stranger', password });
  await stranger.post('/api/auth/login', { email: sEmail, password });
  const stolen = await stranger.post('/api/chats/open', { orderId });
  check("a stranger cannot open someone else's order thread", stolen.status >= 400, `status=${stolen.status}`);

  const owner = await buyer.post('/api/chats/open', { orderId });
  check('the order OWNER can open it', owner.status === 200, JSON.stringify(owner.data).slice(0, 140));

  const general = await buyer.post('/api/chats/open', { userId: o.customer.id === null ? '' : (await admin.get('/api/auth/me')).data.user.id });
  check('a general DM is a DIFFERENT thread from the order thread', general.status === 200 && general.data?.chatId !== owner.data?.chatId, `${general.data?.chatId} vs ${owner.data?.chatId}`);

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
