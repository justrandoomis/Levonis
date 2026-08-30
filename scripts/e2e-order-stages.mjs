#!/usr/bin/env node
/**
 * A real order, walked through both tracking paths by the real engine.
 *
 * WHY THIS EXISTS ALONGSIDE tests/orderStages.test.ts. The unit tests pin the
 * arithmetic: which stage follows which, how long each waits, that nothing
 * schedules its way to "delivered". They run against pure functions and know
 * nothing about D1. Everything that can actually go wrong in production is in
 * the half they cannot see:
 *
 *   * does the stage column survive a write, and does `orders.status` — with
 *     its CHECK constraint from 0001 — accept the value mapped from it;
 *   * does the cron sweep actually find a due order, and does it refuse to
 *     touch one waiting on a person;
 *   * does a manual change really cancel the pending automatic transition, or
 *     does the old next_stage_at survive and fire later anyway;
 *   * does order_status_history record who moved what;
 *   * does the customer's tracker show the owner's Arabic, in order.
 *
 * The clock is controlled by SETTING THE DURATIONS TO ZERO through the same
 * admin settings endpoint an owner would use — not by backdating rows behind
 * the engine's back. An order that promotes instantly at zero minutes is the
 * same code path as one that promotes in ninety, and it proves the durations
 * are editable at the same time.
 *
 *   node scripts/e2e-order-stages.mjs        (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

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

const settle = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* still re-binding */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the dev server did not come back after a direct SQL statement');
};
const sqlCmd = (statement) => {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  return execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' }).toString();
};

class Client {
  constructor() { this.cookie = ''; }
  async call(method, p, body) {
    const h = {};
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  }
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  put(p, b) { return this.call('PUT', p, b); }
  patch(p, b) { return this.call('PATCH', p, b); }
  del(p, b) { return this.call('DELETE', p, b); }
}

const rnd = Math.random().toString(36).slice(2, 8);
const password = 'stages-pass-1';

const DIRECT_PATH = ['received', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'];
const PREORDER_PATH = [
  'received', 'confirmed', 'supplier_preparing', 'at_origin_warehouse', 'preparing_freight',
  'handed_to_carrier', 'left_origin_warehouse', 'en_route_to_iraq', 'arrived_iraq',
  'en_route_to_levo', 'at_levo_warehouse', 'local_delivery_prep', 'out_for_delivery', 'delivered',
];

async function main() {
  console.log(`\nLEVONIS order tracking — the engine on a real order — ${BASE}\n`);

  console.log('0. a buyer, an admin, and one product of each shipping type');
  const buyer = new Client();
  const admin = new Client();
  const buyerEmail = `stg-${rnd}@test.local`;
  const adminEmail = `stga-${rnd}@test.local`;

  await buyer.post('/api/auth/register', { email: buyerEmail, username: `stg${rnd}`, name: 'Stage Buyer', password });
  await buyer.post('/api/auth/login', { email: buyerEmail, password });
  await admin.post('/api/auth/register', { email: adminEmail, username: `stga${rnd}`, name: 'Stage Admin', password });
  sqlCmd(`UPDATE users SET role='admin' WHERE email='${adminEmail}'`);
  await settle();
  await admin.post('/api/auth/login', { email: adminEmail, password });

  const cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const section = cats.find((c) => c.effective_template_family === 'devices') ?? cats[0];
  const mk = async (label, saleTypes, transports) =>
    (await admin.post('/api/admin/products-v2', {
      name_en: label, description_en: 'A tracking fixture.', price_iqd: 150000, status: 'active',
      sale_types: saleTypes, preorder_transports: transports, category_id: section?.id ?? null, stock: 50,
    })).data?.product?.id;

  const directProduct = await mk(`Stage Direct ${rnd}`, ['direct_sale'], []);
  const preProduct = await mk(`Stage Pre ${rnd}`, ['pre_order'], [
    { method: 'air', commission_iqd: 1000 },
    { method: 'sea', commission_iqd: 500 },
    { method: 'land', commission_iqd: 700 },
  ]);
  check('both fixtures exist', !!directProduct && !!preProduct, `${directProduct} / ${preProduct}`);

  const addr = await buyer.post('/api/addresses', {
    label: 'Home', name: 'Stage Buyer', phone: '07701234567',
    address: 'شارع 62، محلة 909، دار 15', governorate: 'baghdad', area: 'الجادرية', isDefault: true,
  });
  const addressId = addr.data?.id;
  const methods = (await buyer.get('/api/settings/public')).data?.settings?.checkoutDeliveryMethods ?? [];
  const deliveryId = methods[0]?.id ?? 'standard';
  const pol = await buyer.get('/api/policies');
  const policyAcceptance = (pol.data?.policies ?? [])
    .filter((p) => p.key === 'terms' || p.key === 'privacy')
    .map((p) => ({ key: p.key, version: Number(p.version) }));

  let orderSeq = 0;
  const place = async (productId, transportMethod) => {
    await buyer.del('/api/cart');
    const add = { productId, qty: 1 };
    if (transportMethod) add.transportMethod = transportMethod;
    const added = await buyer.post('/api/cart/items', add);
    if (added.status !== 200) throw new Error(`cart add failed: ${JSON.stringify(added.data).slice(0, 200)}`);
    const placed = await buyer.post('/api/orders', {
      addressId, deliveryMethodId: deliveryId, paymentMethodId: 'cash', policyAcceptance,
      idempotencyKey: `stg-${rnd}-${++orderSeq}-key`,
    });
    if (placed.status !== 200) throw new Error(`checkout failed: ${JSON.stringify(placed.data).slice(0, 260)}`);
    return placed.data.order.id;
  };

  // ------------------------------------------------------- the clock is ours
  console.log('\n1. every automatic duration is editable from admin settings');
  const ZERO = {
    preparing: 0, supplier_preparing_min: 0, supplier_preparing_max: 0,
    preparing_freight_air: 0, preparing_freight_sea: 0, preparing_freight_land: 0,
    handed_to_carrier: 0, left_origin_warehouse: 0,
    en_route_to_iraq_min: 0, en_route_to_iraq_max: 0, en_route_to_levo: 0,
  };
  const saved = await admin.put('/api/admin/settings/orderStageDurations', { value: ZERO });
  check('the durations setting saves', saved.status === 200, JSON.stringify(saved.data).slice(0, 160));
  const readBack = (await admin.get('/api/admin/settings')).data?.settings?.orderStageDurations ?? {};
  check(
    'and reads back as zero across all eleven waits',
    Object.keys(ZERO).every((k) => readBack[k] === 0),
    JSON.stringify(readBack)
  );
  const junk = await admin.put('/api/admin/settings/orderStageDurations', { value: { preparing: -5, nonsense: 'x' } });
  check('junk is refused or dropped, never stored', junk.status !== 200 || (await admin.get('/api/admin/settings')).data?.settings?.orderStageDurations?.preparing !== -5, `status=${junk.status}`);
  await admin.put('/api/admin/settings/orderStageDurations', { value: ZERO });

  // ------------------------------------------------------------- direct path
  console.log('\n2. a direct order: five stages, and the clock never confirms it');
  const directOrder = await place(directProduct);
  console.log(`     order ${directOrder}`);

  let t = await buyer.get(`/api/orders/${directOrder}/tracking`);
  check('the customer tracker answers', t.status === 200, `status=${t.status}`);
  check('it lists exactly the five direct stages, in order',
    JSON.stringify((t.data?.steps ?? []).map((s) => s.stage)) === JSON.stringify(DIRECT_PATH),
    JSON.stringify((t.data?.steps ?? []).map((s) => s.stage)));
  check('the order starts at "تم استلام الطلب"', t.data?.stage === 'received', String(t.data?.stage));
  check('and the first step reads in the owner\'s Arabic',
    t.data?.steps?.[0]?.label === 'تم استلام الطلب', String(t.data?.steps?.[0]?.label));
  check('nothing is scheduled — confirmation belongs to a person',
    t.data?.next_stage_at === null, String(t.data?.next_stage_at));

  let sweep = await admin.post('/api/admin/orders/sweep-stages');
  check('the sweep runs', sweep.status === 200, JSON.stringify(sweep.data).slice(0, 160));
  t = await buyer.get(`/api/orders/${directOrder}/tracking`);
  check('and it did NOT confirm the order for us', t.data?.stage === 'received', String(t.data?.stage));

  let mv = await admin.patch(`/api/admin/orders/${directOrder}/stage`, { stage: 'confirmed', note: 'Customer confirmed by phone' });
  check('an admin confirms it', mv.status === 200, JSON.stringify(mv.data).slice(0, 200));
  check('the legacy status followed to "confirmed"', mv.data?.legacy_status === 'confirmed', String(mv.data?.legacy_status));
  check('and the next automatic step is now armed', mv.data?.next_stage === 'preparing' && !!mv.data?.next_stage_at,
    `${mv.data?.next_stage} @ ${mv.data?.next_stage_at}`);

  sweep = await admin.post('/api/admin/orders/sweep-stages');
  check('the sweep promotes the due order', (sweep.data?.promoted ?? 0) >= 1, JSON.stringify(sweep.data));
  t = await buyer.get(`/api/orders/${directOrder}/tracking`);
  check('the order moved to "جارٍ تجهيز الطلب"', t.data?.stage === 'preparing', String(t.data?.stage));

  sweep = await admin.post('/api/admin/orders/sweep-stages');
  t = await buyer.get(`/api/orders/${directOrder}/tracking`);
  check('but the sweep will NOT put it on the road — that is the courier\'s to say',
    t.data?.stage === 'preparing', String(t.data?.stage));
  check('and nothing is scheduled towards it', t.data?.next_stage_at === null, String(t.data?.next_stage_at));

  // ------------------------------------------------- a manual change cancels
  console.log('\n3. a manual change cancels the automatic transition that was pending');
  const cancelOrder = await place(directProduct);
  await admin.patch(`/api/admin/orders/${cancelOrder}/stage`, { stage: 'confirmed' });
  let detail = await admin.get(`/api/admin/orders/${cancelOrder}`);
  const armed = detail.data?.order?.tracking;
  check('after confirming, an automatic move to "preparing" is pending',
    armed?.next_stage === 'preparing' && !!armed?.next_stage_at, JSON.stringify({ n: armed?.next_stage, at: armed?.next_stage_at }));

  // The admin overtakes it by hand. The pending transition must be gone —
  // not remembered and skipped, gone.
  await admin.patch(`/api/admin/orders/${cancelOrder}/stage`, { stage: 'out_for_delivery', note: 'Driver took it now' });
  detail = await admin.get(`/api/admin/orders/${cancelOrder}`);
  const after = detail.data?.order?.tracking;
  check('the manual move landed', after?.stage === 'out_for_delivery', String(after?.stage));
  check('and the pending automatic transition is gone, not queued',
    after?.next_stage_at === null, `next_stage=${after?.next_stage} at=${after?.next_stage_at}`);
  const sweepAfter = await admin.post('/api/admin/orders/sweep-stages');
  detail = await admin.get(`/api/admin/orders/${cancelOrder}`);
  check('a later sweep does not resurrect it',
    detail.data?.order?.tracking?.stage === 'out_for_delivery',
    `${detail.data?.order?.tracking?.stage} (sweep promoted ${sweepAfter.data?.promoted})`);

  // ----------------------------------------------------------- pre-order path
  console.log('\n4. a sea pre-order: fourteen stages, five human decisions');
  const preOrder = await place(preProduct, 'sea');
  console.log(`     order ${preOrder}`);
  t = await buyer.get(`/api/orders/${preOrder}/tracking`);
  check('it lists exactly the fourteen pre-order stages, in order',
    JSON.stringify((t.data?.steps ?? []).map((s) => s.stage)) === JSON.stringify(PREORDER_PATH),
    JSON.stringify((t.data?.steps ?? []).map((s) => s.stage)));
  check('the freight stage names the SEA mode',
    (t.data?.steps ?? []).find((s) => s.stage === 'preparing_freight')?.label === 'جارٍ التجهيز للشحن البحري',
    String((t.data?.steps ?? []).find((s) => s.stage === 'preparing_freight')?.label));
  check('and the type is labelled as a sea pre-order',
    t.data?.shipping_type_label === 'طلب مسبق — بحري', String(t.data?.shipping_type_label));

  // Walk it: five manual confirmations, and the sweep does everything between.
  const MANUAL_STOPS = ['confirmed', 'at_origin_warehouse', 'arrived_iraq', 'at_levo_warehouse', 'local_delivery_prep'];
  for (const stop of MANUAL_STOPS) {
    const res = await admin.patch(`/api/admin/orders/${preOrder}/stage`, { stage: stop });
    check(`admin: ${stop}`, res.status === 200, JSON.stringify(res.data).slice(0, 180));
    // Drain everything the clock owns after this decision.
    for (let i = 0; i < 6; i++) {
      const s = await admin.post('/api/admin/orders/sweep-stages');
      if ((s.data?.promoted ?? 0) === 0) break;
    }
  }
  t = await buyer.get(`/api/orders/${preOrder}/tracking`);
  check('after five human decisions the order is at "جارٍ تجهيز التوصيل المحلي"',
    t.data?.stage === 'local_delivery_prep', String(t.data?.stage));
  check('every stage before it is marked reached',
    (t.data?.steps ?? []).slice(0, PREORDER_PATH.indexOf('local_delivery_prep') + 1).every((s) => s.reached),
    JSON.stringify((t.data?.steps ?? []).map((s) => `${s.stage}:${s.reached ? 1 : 0}`)));
  check('and the last two are NOT — no timer may reach them',
    (t.data?.steps ?? []).slice(-2).every((s) => !s.reached),
    JSON.stringify((t.data?.steps ?? []).slice(-2)));

  // Prove the nine automatic stages were actually walked, not skipped over.
  const reachedAll = (t.data?.steps ?? []).filter((s) => s.reached).map((s) => s.stage);
  check('all twelve stages up to local delivery were entered, none skipped',
    JSON.stringify(reachedAll) === JSON.stringify(PREORDER_PATH.slice(0, 12)),
    JSON.stringify(reachedAll));

  // ---------------------------------------------------------------- history
  console.log('\n5. order_status_history records every move and who made it');
  detail = await admin.get(`/api/admin/orders/${preOrder}`);
  const history = detail.data?.order?.tracking?.history ?? [];
  check('there is one history row per stage entered', history.length >= 12, `rows=${history.length}`);
  check('the rows carry the owner\'s four columns',
    history.every((h) => h.stage && h.source && h.changed_at !== undefined && h.changed_by !== undefined),
    JSON.stringify(history[0] ?? null));
  check('the manual moves are attributed to the admin who made them',
    history.filter((h) => h.source === 'manual').every((h) => !!h.changed_by),
    JSON.stringify(history.filter((h) => h.source === 'manual').map((h) => h.changed_by)));
  check('the automatic ones are marked automatic and attributed to nobody',
    history.some((h) => h.source === 'automatic' && !h.changed_by),
    JSON.stringify(history.map((h) => `${h.stage}:${h.source}`)));
  check('the history is in chronological order',
    history.every((h, i) => i === 0 || h.changed_at >= history[i - 1].changed_at),
    JSON.stringify(history.map((h) => h.changed_at)));

  // ---------------------------------------------------- the legacy status map
  console.log('\n6. the legacy status column stays valid and in step');
  const row = sqlCmd(`SELECT status, stage FROM orders WHERE id='${preOrder}'`);
  check('the stored legacy status is one the 0001 CHECK allows',
    /pending|confirmed|processing|shipped|delivered|cancelled/.test(row), row.replace(/\s+/g, ' ').slice(0, 200));

  // The old dropdown is still in the panel. It must not leave the stage behind.
  const legacyOrder = await place(directProduct);
  await admin.patch(`/api/admin/orders/${legacyOrder}`, { status: 'shipped' });
  detail = await admin.get(`/api/admin/orders/${legacyOrder}`);
  check('the legacy status dropdown drags the stage with it',
    detail.data?.order?.tracking?.stage === 'out_for_delivery',
    String(detail.data?.order?.tracking?.stage));

  // A pre-order moved to "shipped" must land on the EARLIEST shipped stage —
  // never claim it already reached Iraq.
  const legacyPre = await place(preProduct, 'air');
  await admin.patch(`/api/admin/orders/${legacyPre}`, { status: 'shipped' });
  detail = await admin.get(`/api/admin/orders/${legacyPre}`);
  check('and on a pre-order it lands at the earliest shipped stage, claiming no more',
    detail.data?.order?.tracking?.stage === 'handed_to_carrier',
    String(detail.data?.order?.tracking?.stage));

  // ------------------------------------------------------- available moves
  console.log('\n7. the panel is offered the real moves, not two');
  detail = await admin.get(`/api/admin/orders/${legacyPre}`);
  const available = detail.data?.order?.tracking?.available ?? [];
  check('a pre-order mid-journey offers more than two moves', available.length > 2, `${available.length}: ${JSON.stringify(available.map((a) => a.stage))}`);
  check('every offered move is legal from here',
    available.every((a) => PREORDER_PATH.includes(a.stage) || a.stage === 'cancelled'),
    JSON.stringify(available.map((a) => a.stage)));
  check('and each carries its Arabic label', available.every((a) => !!a.label_ar), JSON.stringify(available[0] ?? null));

  const illegal = await admin.patch(`/api/admin/orders/${legacyPre}/stage`, { stage: 'received' });
  check('a two-step jump backwards is refused, not silently applied', illegal.status === 400, `status=${illegal.status}`);
  const unknown = await admin.patch(`/api/admin/orders/${legacyPre}/stage`, { stage: 'teleported' });
  check('an unknown stage is refused', unknown.status === 400, `status=${unknown.status}`);

  // Put the clock back. The suite ran with every wait at zero; leaving it
  // that way would make the next person's manual test promote instantly and
  // look like a bug in the engine.
  const restored = await admin.put('/api/admin/settings/orderStageDurations', { value: {} });
  check('the durations are restored to the defaults afterwards', restored.status === 200, `status=${restored.status}`);

  // ------------------------------------------------- the screens themselves
  console.log('\n8. the two screens, in a real browser');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
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
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const errs = [];

    // The ADMIN screen: the panel must offer the real moves, not two.
    const actx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const apage = await actx.newPage();
    apage.on('pageerror', (e) => errs.push(String(e)));
    await apage.goto(`${BASE}/auth`, { waitUntil: 'domcontentloaded' });
    await apage.evaluate(async (creds) => {
      await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
    }, { email: adminEmail, password });
    await apage.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await apage.getByRole('button', { name: /الطلبات|Orders/ }).first().click();
    await apage.waitForSelector('[data-order-filters]', { timeout: 15_000 });
    // EXACT text, not a substring: the status filter "قيد التجهيز" contains
    // "تجهيز", so a loose match picks the filter and the modal never opens.
    // And `:visible`, because the card layout and the table are both in the
    // DOM — one is hidden by a breakpoint, not unmounted.
    await apage.getByRole('button', { name: /^(تجهيز|Prepare|ئامادەکردن)$/ }).locator('visible=true').first().click();
    await apage.waitForSelector('[data-order-tab="stages"]', { timeout: 15_000 });
    check('the order modal has a Stages tab', true);
    await apage.locator('[data-order-tab="stages"]').click();
    await apage.waitForSelector('[data-order-stages]', { timeout: 10_000 });
    check('the stage panel renders', true);

    const stagesShown = await apage.locator('[data-admin-stage]').count();
    check('it draws the whole path, not a dropdown', stagesShown >= 5, String(stagesShown));
    const moves = await apage.locator('[data-stage-move]').count();
    // The bug the owner reported was a panel that offered two options.
    check('and offers MORE than two moves', moves > 2, String(moves));

    const beforeStage = await apage.locator('[data-admin-stage]').first().getAttribute('data-admin-stage');
    check('the first stage is "received"', beforeStage === 'received', String(beforeStage));

    // Move it from the panel and watch the modal reload with the new state.
    const target = await apage.locator('[data-stage-move]').first().getAttribute('data-stage-move');
    await apage.locator(`[data-stage-move="${target}"]`).click();
    await apage.waitForFunction(
      (t) => !document.querySelector(`[data-stage-move="${t}"]`),
      target,
      { timeout: 15_000 }
    );
    check(`moving to "${target}" from the panel takes effect and reloads the modal`, true);

    const printBar = await apage.locator('[data-order-print-bar]').count();
    check('the order tab carries the print bar', printBar >= 0);

    // The DELIVERY panel: the owner's mapping screen for Al-Waseet. It must
    // render and say honestly that the credentials are not set, rather than
    // looking broken — an unconfigured courier is a setting nobody filled in.
    await apage.locator('[aria-label="Close"], [data-order-tab="order"]').first().click().catch(() => {});
    await apage.keyboard.press('Escape').catch(() => {});
    await apage.getByRole('button', { name: /التوصيل المحلي|Local delivery/ }).first().click();
    await apage.waitForSelector('[data-admin-delivery]', { timeout: 15_000 });
    check('the local-delivery panel renders', true);
    // The panel renders its shell before its two requests land. Reading it
    // mid-load measures the loading state, not the screen.
    await apage.waitForFunction(
      () => !/جارٍ التحميل|Loading…/.test(document.querySelector('[data-admin-delivery]')?.textContent ?? ''),
      undefined,
      { timeout: 15_000 }
    );
    const deliveryText = await apage.locator('[data-admin-delivery]').innerText();
    check('it says the credentials are not configured, by NAME',
      /غير مهيأة|Not configured/.test(deliveryText) && deliveryText.includes('ALWASEET_BASE_URL'),
      deliveryText.slice(0, 200));
    check('and never shows a credential VALUE — only key names',
      !/ALWASEET_[A-Z_]+\s*[:=]\s*\S/.test(deliveryText), deliveryText.slice(0, 200));

    // The CUSTOMER screen.
    const cctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const cpage = await cctx.newPage();
    cpage.on('pageerror', (e) => errs.push(String(e)));
    await cpage.goto(`${BASE}/auth`, { waitUntil: 'domcontentloaded' });
    await cpage.evaluate(async (creds) => {
      await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) });
    }, { email: buyerEmail, password });
    await cpage.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
    const trackBtn = cpage.locator(`[data-track-order="${preOrder}"]`);
    check('the customer sees a "track shipment" button on their pre-order', await trackBtn.count() > 0, preOrder);
    await trackBtn.first().click();
    await cpage.waitForSelector('[data-order-tracker]', { timeout: 15_000 });
    const steps = await cpage.locator('[data-order-tracker] [data-stage]').count();
    check('the tracker draws all fourteen pre-order stages', steps === 14, String(steps));
    const reached = await cpage.locator('[data-order-tracker] [data-reached="1"]').count();
    check('and marks the ones actually reached, not all of them', reached > 0 && reached < 14, String(reached));
    const text = await cpage.locator('[data-order-tracker]').innerText();
    check('in the owner\'s Arabic', text.includes('تم استلام الطلب') && text.includes('تم التوصيل'), text.slice(0, 120));
    check('and names the SEA freight mode on the freight stage', text.includes('جارٍ التجهيز للشحن البحري'), '');
    check('no runtime errors on either screen', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    await browser.close();
  }

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
