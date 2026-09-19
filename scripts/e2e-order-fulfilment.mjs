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
 * Since the board was rebuilt it also checks the screen that LISTS the orders:
 *   * one header line of server counts, one search box, and ONE row of three
 *     controls — not seven status chips in a sideways-scrolling strip
 *   * a day-grouped list of cards at EVERY width, with headers that really do
 *     stick (nothing between them and the page scroller scrolls sideways)
 *   * a row that names the person and the governorate rather than an email,
 *     keeps the PRO badge, and marks a day that moved
 *   * the search box being labelled with the reading the SERVER chose, and the
 *     browser never re-filtering what the server already folded
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

  // ---- what the BOARD is built out of. Every one of these is computed on the
  // server against the one Baghdad day boundary; the screen renders them and
  // re-derives none of them, because between 00:00 and 03:00 Baghdad a
  // UTC-derived "today" in the admin's browser is still yesterday — which is
  // exactly the early-morning shift when the delivery runs are planned.
  check('the board answers with its day counts', typeof list.data?.counts?.today === 'number', JSON.stringify(list.data?.counts));
  check('and with the anchors they were counted against', /^\d{4}-\d{2}-\d{2}$/.test(String(list.data?.today)), String(list.data?.today));
  check(
    'every row carries its bucket and its rendered day label',
    (list.data?.orders ?? []).every((o) => typeof o.due_bucket === 'string' && typeof o.due_label === 'string'),
    JSON.stringify((list.data?.orders ?? []).map((o) => [o.due_bucket, o.due_label]).slice(0, 4))
  );
  check(
    'and the delivery name, so a row never has to fall back to an email',
    (list.data?.orders ?? []).every((o) => o.address && typeof o.address === 'object'),
    'an order came back with no parsed address'
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

  /**
   * THE THREE FACTS THE BOARD IS ABOUT, written onto the fixture directly.
   *
   * `delivery_due_day` is taken from the SERVER's own `today` — never from
   * this process's clock, which is the same mistake the screen is forbidden to
   * make. `delivery_day_changed_at` is what makes the row say «مؤجل»: an order
   * that silently sinks down the list looks, to the admin who read it this
   * morning, like an order that vanished. `priority` is the owner's pin
   * («طلباتهم مثبتة في الأعلى دائما»), and its badge is the only visible
   * evidence that the pin is working at all.
   */
  const today = String((await admin.get('/api/admin/orders?limit=1')).data?.today ?? '');
  check('the server names its own Baghdad day', /^\d{4}-\d{2}-\d{2}$/.test(today), today);
  sql(
    `UPDATE orders SET delivery_due_day='${today}', delivery_day_changed_at='${today}T09:00:00.000Z', ` +
      `delivery_day_schedulable=1, priority=1 WHERE id='${orderId}'`
  );
  await settle();
  const pinned = await admin.get('/api/admin/orders?limit=50');
  const pinnedRow = (pinned.data?.orders ?? []).find((o) => o.id === orderId);
  check('the fixture now sits in today\'s bucket', pinnedRow?.due_bucket === 'today', JSON.stringify(pinnedRow?.due_bucket));
  check(
    'and its day arrives already written as «اليوم» — the SPA never formats one',
    pinnedRow?.due_label === 'اليوم',
    JSON.stringify(pinnedRow?.due_label)
  );
  check('the moved day is reported', !!pinnedRow?.delivery_day_changed_at, JSON.stringify(pinnedRow?.delivery_day_changed_at));

  // ---- the search, decided on the SERVER and never re-filtered in the browser
  console.log('\n1c. one box, four readings, and the fold that makes them useful');
  const search = async (q) => admin.get(`/api/admin/orders?q=${encodeURIComponent(q)}&limit=20`);
  let sr = await search(orderId);
  check('an order number is read as an order number', sr.data?.search_kind === 'order_id', String(sr.data?.search_kind));
  check('and it PIERCES the board rather than honouring its filters', sr.data?.search?.pierced === true, JSON.stringify(sr.data?.search));
  sr = await search(PHONE);
  check('a phone number is read as a phone number', sr.data?.search_kind === 'phone', String(sr.data?.search_kind));
  sr = await search('5-9');
  check('«5-9» is read as a date', sr.data?.search_kind === 'date', String(sr.data?.search_kind));
  check(
    'day-first, as Iraq writes it, with the other reading offered rather than OR-ed in',
    sr.data?.search?.date?.assumed_day_first === true && /^\d{4}-05-09$/.test(String(sr.data?.search?.date?.flip_day)),
    JSON.stringify(sr.data?.search?.date)
  );
  /**
   * THE ASSERTION THAT PROTECTS THE WHOLE FEATURE. «الإختبار» is written with
   * a hamza the stored name does not have. The server folds Arabic orthography
   * on BOTH sides of the comparison, so it matches — and a
   * `.toLowerCase().includes()` laid over the results in the browser, the way
   * src/components/AdminUsers.tsx does over its own, would then hide the very
   * row the fold just found. It would pass in English and fail silently in
   * Arabic, which is the only language this screen is used in.
   */
  sr = await search('الإختبار');
  check('a name is read as a name', sr.data?.search_kind === 'name', String(sr.data?.search_kind));
  check(
    'and a hamza the stored name does not carry still finds it — the fold is the feature',
    (sr.data?.orders ?? []).some((o) => o.id === orderId),
    JSON.stringify((sr.data?.orders ?? []).map((o) => o.id).slice(0, 5))
  );

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
    // The board is its own lazy chunk now, like the other nineteen panels, so
    // wait for the thing itself rather than for a guess at how long it takes.
    await page.waitForSelector('[data-order-filters]', { timeout: 15000 });
    await page.waitForTimeout(800);

    // ---- the list itself, before anything is opened
    //
    // WHAT THIS BLOCK ASSERTED BEFORE, AND WHY IT CHANGED. It pinned SEVEN
    // status chips in a horizontally scrolling strip, plus "cards on a phone,
    // a table from the tablet up". The board is now four things rather than a
    // filter panel: one header line of counts, one search box, ONE ROW OF
    // THREE controls (type, status, an archive switch — «أكثر تنسيقا» is
    // better organised, not more controls), and one day-grouped list of cards
    // at EVERY width. The 44px floor and the no-sideways-scroll rule are the
    // two assertions that carried over unchanged, because they are about
    // fingers and phones rather than about this particular layout.
    const layout = await page.evaluate(() => {
      const strip = document.querySelector('[data-order-filters]');
      const controls = strip ? [...strip.querySelectorAll('[data-order-filter]')] : [];
      const groups = [...document.querySelectorAll('[data-order-group]')];
      const header = groups[0]?.querySelector('h3') ?? null;
      /**
       * THE STICKY FAILURE THIS ENCODES. A `position: sticky` header sticks to
       * its nearest SCROLLING ancestor, so a grouped list retrofitted onto the
       * old 820px-min table would stop sticking the moment it was wrapped in
       * `overflow-x-auto` — and only at the desktop breakpoint, where the
       * table was. Computed position alone would not catch that: the rule
       * would still say `sticky` while sticking to a box the size of the
       * table. So the ancestors are walked too.
       */
      let clippedBy = null;
      for (let el = header?.parentElement; el && el !== document.body; el = el.parentElement) {
        const ox = getComputedStyle(el).overflowX;
        if (ox === 'auto' || ox === 'scroll') { clippedBy = el.className || el.tagName; break; }
        if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY === 'auto') break;
      }
      return {
        filters: controls.map((c) => c.getAttribute('data-order-filter')),
        // Three controls in one row must FIT. The old strip solved its overflow
        // by scrolling; a row that needs scrolling to reach its third control
        // has not replaced seven chips, it has hidden them.
        stripFits: strip ? strip.scrollWidth <= strip.clientWidth + 1 : false,
        shortestFilter: controls.length
          ? Math.round(Math.min(...controls.map((c) => c.getBoundingClientRect().height)))
          : 0,
        searchBoxes: document.querySelectorAll('[data-order-search]').length,
        statusSelectsOnList: document.querySelectorAll('[data-order-status-select]').length,
        buckets: document.querySelector('[data-order-buckets]')?.textContent?.trim() ?? '',
        groups: groups.map((g) => g.getAttribute('data-order-group')),
        headerPosition: header ? getComputedStyle(header).position : null,
        headerClippedBy: clippedBy,
        cards: document.querySelectorAll('[data-order-card]').length,
        tables: [...document.querySelectorAll('table')].filter((t) => t.getBoundingClientRect().width > 0).length,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check(
      `${width}px — three controls, not seven chips: type, status, archive`,
      JSON.stringify(layout.filters) === JSON.stringify(['type', 'status', 'archive']),
      JSON.stringify(layout.filters)
    );
    check(`${width}px — every control is at least 44px tall`, layout.shortestFilter >= 44, `${layout.shortestFilter}px`);
    check(`${width}px — the three controls fit their row without scrolling`, layout.stripFits, JSON.stringify(layout));
    check(`${width}px — there is exactly one search box`, layout.searchBoxes === 1, String(layout.searchBoxes));
    check(`${width}px — the orders list does not scroll the page sideways`, layout.docOverflow <= 1, `${layout.docOverflow}px`);

    // The header line is the owner's morning question, answered before any
    // click: it comes from the server's counts and it is TEXT, not chips.
    check(
      `${width}px — the header line names today and tomorrow`,
      /اليوم|Today/.test(layout.buckets) && /غدًا|Tomorrow/.test(layout.buckets),
      JSON.stringify(layout.buckets)
    );

    // ONE LAYOUT AT EVERY WIDTH. The grouped list is built as cards from the
    // phone up precisely so the sticky headers below cannot be broken by a
    // table's own horizontal scroller at one breakpoint only.
    check(`${width}px — orders render as cards, never a wide table`, layout.cards > 0 && layout.tables === 0, JSON.stringify(layout));

    // The WHEN dimension is answered by the shape of the list, not by a
    // control — so the day headers have to actually be there, and stick.
    check(`${width}px — the list is grouped by day`, layout.groups.length > 0, JSON.stringify(layout.groups));
    check(`${width}px — the day headers are sticky`, layout.headerPosition === 'sticky', String(layout.headerPosition));
    check(
      `${width}px — and nothing between a header and the page scroller scrolls sideways`,
      layout.headerClippedBy === null,
      String(layout.headerClippedBy)
    );

    // The per-row status dropdown is GONE from the list. It moved into the
    // modal's stage panel, which is already the authority — the mis-tap it
    // caused on a scan-and-tap list is recorded in this page's own history.
    check(`${width}px — no status dropdown on a list row`, layout.statusSelectsOnList === 0, String(layout.statusSelectsOnList));

    // ---- what the row says: the person and the place, never the email
    const row = await page.evaluate((id) => {
      const el = document.querySelector(`[data-order-card="${id}"]`);
      if (!el) return null;
      return {
        text: el.innerText,
        pro: el.querySelectorAll('[data-order-pro]').length,
        day: el.querySelector('[data-order-day]')?.getAttribute('data-order-day') ?? null,
        dayText: el.querySelector('[data-order-day]')?.textContent?.trim() ?? '',
        postponed: el.querySelectorAll('[data-order-postponed]').length,
        kind: el.querySelector('[data-order-kind]')?.getAttribute('data-order-kind') ?? null,
        actions: el.querySelectorAll('button, a').length,
      };
    }, orderId);
    check(`${width}px — the order has a row`, !!row, String(row));
    if (row) {
      check(`${width}px — the row names the person the parcel is for`, row.text.includes(NAME), JSON.stringify(row.text.slice(0, 160)));
      check(`${width}px — and where it is going, by NAME`, row.text.includes('بغداد'), JSON.stringify(row.text.slice(0, 160)));
      check(
        `${width}px — and NOT the customer's email, which is useless to someone packing a box`,
        !row.text.includes(email),
        JSON.stringify(row.text.slice(0, 160))
      );
      check(`${width}px — the row carries the journey badge`, row.kind === 'direct', String(row.kind));
      // THE PRO BADGE MUST SURVIVE THE COMPACT ROW. Inside one day the ordering
      // is entirely tie-breaks; drop the badge for space and the owner loses
      // the only visible evidence that the pin they asked for is working.
      check(`${width}px — the PRO badge survives the compact row`, row.pro === 1, JSON.stringify(row));
      check(`${width}px — the day chip reads "today" from the server's bucket`, row.day === 'today', String(row.day));
      check(`${width}px — a day that MOVED is marked «مؤجل»`, row.postponed === 1, JSON.stringify(row));
      // One primary action per row. The delete verb only exists on a cancelled
      // order, and this fixture is not one.
      check(`${width}px — the row carries one action, not a control panel`, row.actions === 1, String(row.actions));
    }

    // ---- ONE BOX, AND A CHIP THAT SAYS WHAT IT DID (1024 only: this is about
    // behaviour, not about layout, and driving it at four widths buys nothing).
    if (width === 1024) {
      const box = page.locator('[data-order-search]');
      const kindOf = () =>
        page.evaluate(() => document.querySelector('[data-order-search-kind]')?.getAttribute('data-order-search-kind') ?? null);

      /**
       * THE SEARCH RESETS THE PAGE, AND THAT IS NOT A DETAIL. Typed from page
       * 4, a search asks the server for rows 90-120 of a result set that now
       * has one row in it, and the admin lands on an empty screen for a search
       * that MATCHED. Only exercised when this database actually has a second
       * page; the run says so either way rather than reporting a silent pass.
       */
      const pager = page.locator('[data-orders-next]');
      const paged = (await pager.count()) > 0 && (await pager.first().isEnabled());
      if (paged) {
        await pager.first().click();
        await page.waitForTimeout(1200);
      }

      await box.fill('الإختبار');
      await page.waitForTimeout(1400);
      check('1024px — a typed name is labelled as a name', (await kindOf()) === 'name', String(await kindOf()));
      check(
        paged
          ? '1024px — searching from page 2 lands on the match, not on an empty page 2'
          : '1024px — the match is on screen (one page of orders in this database)',
        (await page.locator(`[data-order-card="${orderId}"]`).count()) === 1
      );
      // The row the SERVER's Arabic fold found is still on screen. A
      // `.toLowerCase().includes()` over the results — the pattern
      // src/components/AdminUsers.tsx uses over its own — would have removed it
      // here, because it does no folding and «الإختبار» is not a substring of
      // the stored «زبون الاختبار».
      check('1024px — and the browser did not re-filter the fold away', (await page.locator('[data-order-card]').count()) >= 1);

      await box.fill(PHONE);
      await page.waitForTimeout(1400);
      check('1024px — a typed phone number is labelled as one', (await kindOf()) === 'phone', String(await kindOf()));
      check(
        '1024px — and the screen says the lookup ignored the board',
        (await page.locator('[data-order-search-pierced]').count()) === 1
      );

      await box.fill('5-9');
      await page.waitForTimeout(1400);
      check('1024px — an ambiguous date is labelled as a date', (await kindOf()) === 'date', String(await kindOf()));
      const flip = page.locator('[data-order-search-flip]');
      check('1024px — with the other reading one tap away', (await flip.count()) === 1);
      if ((await flip.count()) === 1) {
        await flip.first().click();
        await page.waitForTimeout(1400);
        check('1024px — the flip lands on a day that cannot be read two ways', (await kindOf()) === 'date' && (await page.locator('[data-order-search-flip]').count()) === 0);
      }

      await page.locator('[data-order-search-clear]').click();
      await page.waitForTimeout(1400);
      check('1024px — clearing the box gives the board back', (await page.locator(`[data-order-card="${orderId}"]`).count()) === 1);
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

    // THE STATUS CONTROL LIVES HERE NOW, UNDER THE STAGES. It was on every row
    // of the board, beside the one button the owner came for, on a list they
    // scan with a thumb — and this page's own history records the mis-tap that
    // caused. The stage panel above it is the ordinary route; the dropdown is
    // the correction path (`delivered` back to `shipped`) that the stage graph
    // does not offer as a forward move.
    await page.locator('[data-order-tab="stages"]').click();
    await page.waitForSelector('[data-order-status-correction]', { timeout: 15000 });
    check(`${width}px — the stage panel is the authority, and it is on screen`, (await page.locator('[data-order-stages]').count()) === 1);
    const options = await page.evaluate(() => {
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
    await page.locator('[data-order-tab="order"]').click();
    await page.waitForTimeout(400);

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
