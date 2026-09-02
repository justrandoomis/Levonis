#!/usr/bin/env node
/**
 * §12 acceptance: "رفع عدة صور، تغيير الترتيب، تعيين رئيسية واحدة، وربط صورة
 * بلون/خيار يعمل على الهاتف والتابلت" — several images, reordering, exactly one
 * primary, and binding an image to a colour or option, working on phone AND
 * tablet.
 *
 * WHY A SEPARATE SUITE. scripts/e2e-product-form.mjs measures the form at five
 * widths, but its fixture is created with `images: []`. Every control in the
 * images panel is rendered ONLY once an image exists, so the whole panel was
 * invisible to the responsive checks — which is how four 36px touch targets
 * and two 36px inputs survived in a form whose every other control meets the
 * 44px §1 asks for. This suite creates a product WITH images and drives that
 * panel by its accessible names, at a phone width and two tablet widths.
 *
 * Every mutation is made by CLICKING, then saved through the real form, then
 * read back from the API — so what is asserted is what the database holds, not
 * what React happened to render.
 *
 *   node scripts/e2e-images.mjs        (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || process.env.API_BASE || 'http://127.0.0.1:8787';
const OUT = path.join(ROOT, 'docs', 'evidence', 'images');

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

// A 1x1 PNG, inlined so the panel renders a real <img> with no network.
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const rnd = Math.random().toString(36).slice(2, 8);

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nLEVONIS product images — phone and tablet — ${BASE}\n`);

  // ------------------------------------------------------------- fixtures
  const admin = new Client();
  const email = `img-${rnd}@test.local`;
  const password = 'images-pass-1';
  let r = await admin.post('/api/auth/register', { email, username: `img${rnd}`, name: 'Image Admin', password });
  check('admin account created', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  sql(`UPDATE users SET role='admin' WHERE email='${email}'`);
  await settle();
  r = await admin.post('/api/auth/login', { email, password });
  check('admin signed in', r.status === 200);

  const cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const section =
    cats.find((c) => c.id === 'cat_printers_fdm') ?? cats.find((c) => c.effective_template_family === 'devices');
  check('a section exists', !!section, `catalogs=${cats.length}`);
  if (!section) throw new Error('the seeded taxonomy is missing');

  const created = await admin.post('/api/admin/products-v2', {
    name_en: `Image Fixture ${rnd}`,
    description_en: 'A product with a real gallery.',
    price_iqd: 300000,
    status: 'draft',
    sale_types: ['direct_sale'],
    category_id: section.id,
    stock: 5,
  });
  const productId = created.data?.product?.id;
  check('the fixture product saved', created.status === 200 && !!productId, JSON.stringify(created.data).slice(0, 200));
  if (!productId) throw new Error('nothing to test against');

  // A colour and an option value, so "link this image to…" has real targets.
  const colorId = `c_red_${rnd}`;
  const valueId = `v_a1_${rnd}`;
  const rel = await admin.put(`/api/admin/products/${productId}/relations`, {
    inventory_mode: 'BASE',
    groups: [
      {
        id: `g_model_${rnd}`,
        name_en: 'Model',
        sort: 0,
        active: true,
        values: [{ id: valueId, name_en: 'A1', sort: 0, active: true }],
      },
    ],
    colors: [{ id: colorId, name_en: 'Red', hex: '#ff0000', stock: 2, option_value_ids: [] }],
    variants: [],
    images: [
      { id: `pi_1_${rnd}`, url: PIXEL, alt_en: 'first', sort_order: 0, is_primary: true },
      { id: `pi_2_${rnd}`, url: PIXEL, alt_en: 'second', sort_order: 1, is_primary: false },
      { id: `pi_3_${rnd}`, url: PIXEL, alt_en: 'third', sort_order: 2, is_primary: false },
    ],
    facet_ids: [],
  });
  check('three images saved through the API', rel.status === 200, JSON.stringify(rel.data).slice(0, 200));

  const readBack = await admin.get(`/api/admin/products/${productId}/relations`);
  const stored = (readBack.data?.images ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
  check('the API really holds three images', stored.length === 3, `images=${stored.length}`);
  check('exactly one of them is primary', stored.filter((i) => i.is_primary === 1).length === 1);
  check('the primary is the first one', stored[0]?.is_primary === 1, JSON.stringify(stored.map((i) => i.alt_en)));

  // --------------------------------------------------------------- the UI
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  // 390 = phone, 768 and 1024 = tablet. §12 names both.
  for (const width of [390, 768, 1024]) {
    const label = width === 390 ? 'phone' : 'tablet';
    console.log(`\n${width}px (${label})`);
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: 'ar' });
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
    await page.waitForTimeout(500);

    if ((await page.locator('[data-tab="products"]:visible').count()) === 0) {
      await page.locator('[data-action="open-sidebar"]').first().click();
      await page.waitForTimeout(400);
    }
    await page.locator('[data-tab="products"]:visible').first().click({ timeout: 15000 });
    await page.waitForTimeout(1200);

    const editBtn = page.locator(`[data-product-id="${productId}"] [data-action="edit"]`).first();
    check(`${width}px — the fixture is listed`, (await editBtn.count()) > 0, `productId=${productId}`);
    if ((await editBtn.count()) === 0) {
      await ctx.close();
      continue;
    }
    await editBtn.click({ timeout: 15000 });
    await page.waitForTimeout(1600);

    // Open section 6 — the images. §1 keeps at most one heavy section open at
    // a time, so clicking every header in turn CLOSES this one again; the
    // panel has to be opened by name, last, and its state verified.
    const imagesToggle = page.locator('[data-section-toggle="6"]').first();
    check(`${width}px — the images section exists`, (await imagesToggle.count()) === 1);
    if ((await imagesToggle.getAttribute('aria-expanded')) === 'false') {
      await imagesToggle.click();
      await page.waitForTimeout(500);
    }
    check(
      `${width}px — the images section is open`,
      (await imagesToggle.getAttribute('aria-expanded')) === 'true',
      String(await imagesToggle.getAttribute('aria-expanded'))
    );
    await imagesToggle.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);

    // The panel is really there — everything below is vacuous otherwise.
    const stars = page.locator('[aria-label="اجعلها رئيسية"]');
    const cards = await stars.count();
    check(`${width}px — all three image cards rendered`, cards === 3, `cards=${cards}`);
    if (cards !== 3) {
      await page.screenshot({ path: path.join(OUT, `images-${width}-missing.png`), fullPage: true });
      await ctx.close();
      continue;
    }

    // Control sizes. §1 asked for 44-48px, but the owner's density mandate
    // later shrank every admin BUTTON to the 36px scale (same reasoning as
    // e2e-import-ui); inputs and selects keep the 40px floor.
    const touch = await page.evaluate(() => {
      const buttons = ['اجعلها رئيسية', 'للأعلى', 'للأسفل', 'حذف'];
      const fields = ['Alt text', 'تظهر مع'];
      const min = (l) => {
        const els = [...document.querySelectorAll(`[aria-label="${l}"]`)];
        return els.length ? Math.round(Math.min(...els.map((e) => e.getBoundingClientRect().height))) : 0;
      };
      return {
        buttons: Object.fromEntries(buttons.map((l) => [l, min(l)])),
        fields: Object.fromEntries(fields.map((l) => [l, min(l)])),
      };
    });
    for (const [name, h] of Object.entries(touch.buttons)) {
      check(`${width}px — "${name}" is at least 36px tall`, h >= 36, `${h}px`);
    }
    for (const [name, h] of Object.entries(touch.fields)) {
      check(`${width}px — "${name}" is at least 40px tall`, h >= 40, `${h}px`);
    }

    // Nothing in the gallery may push the page sideways on a phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    check(`${width}px — the page does not scroll sideways with a gallery open`, overflow <= 1, `${overflow}px`);

    const spill = await page.evaluate(() => {
      let worst = 0;
      for (const el of document.querySelectorAll('[aria-label="تظهر مع"], [aria-label="اجعلها رئيسية"]')) {
        const r = el.getBoundingClientRect();
        worst = Math.max(worst, Math.ceil(r.right) - window.innerWidth, Math.ceil(-r.left));
      }
      return worst;
    });
    check(`${width}px — no image control is clipped by the viewport`, spill <= 2, `${spill}px`);

    await page.screenshot({ path: path.join(OUT, `images-${width}.png`), fullPage: true });

    // ---- REORDER: move the third image up one, by clicking.
    const before = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Alt text"]')].map((e) => e.value)
    );
    await page.locator('[aria-label="للأعلى"]').nth(2).click();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Alt text"]')].map((e) => e.value)
    );
    check(
      `${width}px — clicking "up" reorders the gallery`,
      JSON.stringify(after) !== JSON.stringify(before) && after[1] === before[2] && after[2] === before[1],
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`
    );

    // ---- PRIMARY: make the LAST card primary; the old one must clear.
    await page.locator('[aria-label="اجعلها رئيسية"]').nth(2).click();
    await page.waitForTimeout(400);
    const primaryCount = await page.evaluate(
      () => [...document.querySelectorAll('span')].filter((s) => s.textContent?.trim() === 'رئيسية').length
    );
    check(`${width}px — exactly one card is badged primary`, primaryCount === 1, `badges=${primaryCount}`);

    // ---- BIND: link the first image to the colour. The partitioned gallery
    // (general → option-linked → colour-linked) MOVES a bound card into its
    // group, so the binding is asserted across all selects, not on .first().
    await page.locator('[aria-label="تظهر مع"]').first().selectOption(`c:${colorId}`);
    await page.waitForTimeout(300);
    const bindVals = () =>
      page.evaluate(() => [...document.querySelectorAll('[aria-label="تظهر مع"]')].map((e) => e.value));
    check(
      `${width}px — an image can be bound to a colour`,
      (await bindVals()).includes(`c:${colorId}`),
      JSON.stringify(await bindVals())
    );
    // And to an option value, on the first still-general card.
    await page.locator('[aria-label="تظهر مع"]').first().selectOption(`o:${valueId}`);
    await page.waitForTimeout(300);
    check(
      `${width}px — an image can be bound to an option value`,
      (await bindVals()).includes(`o:${valueId}`),
      JSON.stringify(await bindVals())
    );

    // What the gallery shows NOW (post-bind regrouping) is the order the save
    // must persist — UI↔DB fidelity, not a snapshot from before the binds.
    const finalUi = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Alt text"]')].map((e) => e.value)
    );

    // ---- SAVE, then read the DATABASE, not the DOM.
    const saveBtn = page.locator('[data-form="save-bar"] [data-action="save"]').first();
    const haveSave = (await saveBtn.count()) > 0;
    check(`${width}px — the save bar offers a save action`, haveSave);
    if (haveSave) {
      await saveBtn.click();
      await page.waitForTimeout(2500);

      const persisted = (await admin.get(`/api/admin/products/${productId}/relations`)).data?.images ?? [];
      const ordered = persisted.slice().sort((a, b) => a.sort_order - b.sort_order);
      check(`${width}px — the save persisted three images`, ordered.length === 3, `images=${ordered.length}`);
      check(
        `${width}px — the database holds exactly one primary`,
        ordered.filter((i) => i.is_primary === 1).length === 1,
        JSON.stringify(ordered.map((i) => [i.alt_en, i.is_primary]))
      );
      check(
        `${width}px — the saved order matches what the gallery showed`,
        JSON.stringify(ordered.map((i) => i.alt_en)) === JSON.stringify(finalUi),
        `db=${JSON.stringify(ordered.map((i) => i.alt_en))} ui=${JSON.stringify(finalUi)}`
      );
      check(
        `${width}px — the colour binding reached the database`,
        ordered.some((i) => i.color_id === colorId),
        JSON.stringify(ordered.map((i) => i.color_id))
      );
      check(
        `${width}px — the option binding reached the database`,
        ordered.some((i) => i.option_value_id === valueId),
        JSON.stringify(ordered.map((i) => i.option_value_id))
      );

      // Reset for the next width, so each viewport starts from the same state.
      await admin.put(`/api/admin/products/${productId}/relations`, {
        inventory_mode: 'BASE',
        groups: [
          {
            id: `g_model_${rnd}`,
            name_en: 'Model',
            sort: 0,
            active: true,
            values: [{ id: valueId, name_en: 'A1', sort: 0, active: true }],
          },
        ],
        colors: [{ id: colorId, name_en: 'Red', hex: '#ff0000', stock: 2, option_value_ids: [] }],
        variants: [],
        images: [
          { id: `pi_1_${rnd}`, url: PIXEL, alt_en: 'first', sort_order: 0, is_primary: true },
          { id: `pi_2_${rnd}`, url: PIXEL, alt_en: 'second', sort_order: 1, is_primary: false },
          { id: `pi_3_${rnd}`, url: PIXEL, alt_en: 'third', sort_order: 2, is_primary: false },
        ],
        facet_ids: [],
      });
    }

    await ctx.close();
  }

  // ------------------------------------------- the server's own guarantees
  console.log('\nserver rules');
  const twoPrimaries = await admin.put(`/api/admin/products/${productId}/relations`, {
    inventory_mode: 'BASE',
    groups: [],
    colors: [],
    variants: [],
    images: [
      { id: `pi_a_${rnd}`, url: PIXEL, alt_en: 'a', sort_order: 0, is_primary: true },
      { id: `pi_b_${rnd}`, url: PIXEL, alt_en: 'b', sort_order: 1, is_primary: true },
    ],
    facet_ids: [],
  });
  check(
    'the server refuses two primary images',
    twoPrimaries.status >= 400 && /one image/.test(JSON.stringify(twoPrimaries.data ?? '')),
    `status=${twoPrimaries.status} ${JSON.stringify(twoPrimaries.data).slice(0, 160)}`
  );

  const noPrimary = await admin.put(`/api/admin/products/${productId}/relations`, {
    inventory_mode: 'BASE',
    groups: [],
    colors: [],
    variants: [],
    images: [
      { id: `pi_c_${rnd}`, url: PIXEL, alt_en: 'c', sort_order: 0, is_primary: false },
      { id: `pi_d_${rnd}`, url: PIXEL, alt_en: 'd', sort_order: 1, is_primary: false },
    ],
    facet_ids: [],
  });
  check('a gallery with no primary is accepted', noPrimary.status === 200, JSON.stringify(noPrimary.data).slice(0, 160));
  const promoted = (await admin.get(`/api/admin/products/${productId}/relations`)).data?.images ?? [];
  check(
    'and the server promotes the first image rather than leaving none',
    promoted.filter((i) => i.is_primary === 1).length === 1,
    JSON.stringify(promoted.map((i) => [i.alt_en, i.is_primary]))
  );

  const badBinding = await admin.put(`/api/admin/products/${productId}/relations`, {
    inventory_mode: 'BASE',
    groups: [],
    colors: [],
    variants: [],
    images: [{ id: `pi_e_${rnd}`, url: PIXEL, alt_en: 'e', sort_order: 0, is_primary: true, color_id: 'c_does_not_exist' }],
    facet_ids: [],
  });
  check(
    'an image bound to a colour that does not exist is refused',
    badBinding.status >= 400 && /unknown colour/.test(JSON.stringify(badBinding.data ?? '')),
    `status=${badBinding.status} ${JSON.stringify(badBinding.data).slice(0, 160)}`
  );

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
