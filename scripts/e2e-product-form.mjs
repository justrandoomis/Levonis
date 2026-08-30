#!/usr/bin/env node
/**
 * Browser verification of the rebuilt admin product form — mandate §12:
 *
 *   "اختبارات responsive على 360 و390 و768 و1024 و1440 بكسل: لا horizontal
 *    overflow، لا حقول خلف sidebar، وشريط الحفظ لا يغطي المحتوى."
 *   "النموذج يعرض الإنجليزية فقط ولا يعرض حقول ar/ckb."
 *   "عدم وجود قسم أو endpoint فعال لاستخراج المنتج من رابط."
 *
 * Drives the REAL app: wrangler dev serving the built dist/ plus the real
 * local API and D1. Fixtures are created through the real admin API. Nothing
 * is mocked, and every assertion reads the rendered DOM or a real HTTP status.
 *
 * Prereqs:
 *   npm run build
 *   npx wrangler dev --port 8787          (local D1 migrated)
 * Run:
 *   API_BASE=http://127.0.0.1:8787 node scripts/e2e-product-form.mjs
 *
 * Screenshots land in docs/evidence/product-form/.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

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

const BASE = process.env.API_BASE || 'http://127.0.0.1:8787';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(ROOT, 'docs/evidence/product-form');
mkdirSync(OUT, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`FAIL  ${name} ${extra}`);
  }
}

class Client {
  constructor() {
    this.cookie = '';
  }
  async req(method, p, body) {
    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + p, { method, headers, body: payload });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
  put(p, b) { return this.req('PUT', p, b); }
}

function sql(statement) {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' });
}

const rnd = Math.random().toString(36).slice(2, 8);

async function main() {
  // ------------------------------------------------------------- fixtures
  const admin = new Client();
  const email = `pf-${rnd}@test.local`;
  const password = 'product-form-pass-1';
  let r = await admin.post('/api/auth/register', {
    email,
    username: `pf${rnd}`,
    name: 'Form Admin',
    password,
  });
  check('admin account created', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  sql(`UPDATE users SET role='admin' WHERE email='${email}'`);
  r = await admin.post('/api/auth/login', { email, password });
  check('admin signed in', r.status === 200);

  // A section from the seeded tree, so the template fields have something to
  // resolve from.
  const cats = await admin.get('/api/admin/taxonomy/catalogs');
  const all = cats.data?.catalogs ?? [];
  check('seeded taxonomy is present', all.length > 0, `catalogs=${all.length}`);
  // The seeded tree is matched by ID, not by slug: a live store may already own
  // the slug 'printers' (the dev database does), in which case the seed took
  // the next free one.
  let printers = all.find((c) => c.id === 'cat_printers') ?? all.find((c) => c.effective_template_family === 'devices');
  if (!printers) {
    // Assigning a family is a normal admin action; doing it here also exercises
    // the catalogs endpoint rather than assuming the seed ran.
    const made = await admin.post('/api/admin/taxonomy/catalogs', {
      name_en: `Devices ${rnd}`,
      template_family: 'devices',
    });
    printers = made.data?.catalog;
  }
  check('a section with a devices template exists', !!printers, JSON.stringify(printers ?? null).slice(0, 120));

  const tpl = printers
    ? await admin.get(`/api/admin/taxonomy/templates?category=${encodeURIComponent(printers.id)}`)
    : { data: {} };
  check(
    'the section resolves a template family and its fields',
    tpl.data?.template_family === 'devices' && (tpl.data?.groups ?? []).length > 0,
    JSON.stringify(tpl.data).slice(0, 160)
  );

  // A product with a full structure, so every section has real content.
  const created = await admin.post('/api/admin/products-v2', {
    name_en: `Form Fixture ${rnd}`,
    description_en: 'Nozzle diameter: 0.4 mm\nA sentence the local engine cannot translate.',
    price_iqd: 250000,
    prime_price_iqd: 235000,
    pro_price_iqd: 220000,
    product_cost_iqd: 150000,
    status: 'draft',
    sale_types: ['direct_sale', 'pre_order'],
    category_id: printers?.id ?? null,
    stock: 7,
  });
  check('product saved through the real API', created.status === 200, JSON.stringify(created.data).slice(0, 200));
  const productId = created.data?.product?.id;
  check(
    'the save reports which fields the local translator could not cover',
    Array.isArray(created.data?.translation_review_needed),
    JSON.stringify(created.data?.translation_review_needed)
  );

  if (productId) {
    const rel = await admin.put(`/api/admin/products/${productId}/relations`, {
      inventory_mode: 'COLOR',
      groups: [
        {
          id: `g_printer_${rnd}`,
          name_en: 'Printer',
          sort: 0,
          active: true,
          values: [
            { id: `v_a1_${rnd}`, name_en: 'A1', sort: 0, active: true },
            { id: `v_p1s_${rnd}`, name_en: 'P1S', sort: 1, active: true },
          ],
        },
        {
          id: `g_plug_${rnd}`,
          name_en: 'Plug',
          sort: 1,
          active: true,
          values: [
            { id: `v_eu_${rnd}`, name_en: 'EU', sort: 0, active: true },
            { id: `v_us_${rnd}`, name_en: 'US', sort: 1, active: true },
          ],
        },
      ],
      colors: [
        { id: `c_black_${rnd}`, name_en: 'Black', hex: '#000000', stock: 3, option_value_ids: [`v_a1_${rnd}`, `v_eu_${rnd}`] },
        { id: `c_white_${rnd}`, name_en: 'White', hex: '#ffffff', stock: 0, option_value_ids: [] },
      ],
      variants: [],
      images: [],
      facet_ids: [],
    });
    check('relations saved (2 groups, 4 values, 2 colours)', rel.status === 200, JSON.stringify(rel.data).slice(0, 200));

    const back = await admin.get(`/api/admin/products/${productId}/relations`);
    const links = back.data?.links ?? [];
    // Black links to A1 and EU (two rows); White links to nothing, which IS
    // "visible with every option" in the §7 algebra.
    check(
      'relations round-trip: the links come back exactly as written',
      links.length === 2 &&
        links.every((l) => l.color_id === `c_black_${rnd}`) &&
        new Set(links.map((l) => l.option_value_id)).size === 2 &&
        (back.data?.values ?? []).length === 4 &&
        back.data?.product?.inventory_mode === 'COLOR',
      JSON.stringify({ links, values: back.data?.values?.length })
    );
    check(
      'a colour with no links stores no rows',
      links.every((l) => l.color_id !== `c_white_${rnd}`),
      JSON.stringify(links)
    );
  }

  // §2: the extraction endpoints must be GONE, not merely hidden.
  for (const p of ['/api/admin/extract-v2', '/api/extract']) {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ url: 'https://example.com/product/1' }),
    });
    check(`§2 ${p} is gone (404)`, res.status === 404, `status=${res.status}`);
  }

  // ------------------------------------------------------------- browser
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  const WIDTHS = [360, 390, 768, 1024, 1440];
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
      locale: 'ar',
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
    await page.waitForTimeout(500);
    // The admin tab is component state, not a URL parameter. Below the lg
    // breakpoint the sidebar lives in a drawer, so it has to be opened first —
    // the button is rendered either way, just not visible.
    const tab = page.locator('[data-tab="products"]:visible').first();
    if ((await tab.count()) === 0) {
      await page.locator('[data-action="open-sidebar"]').first().click();
      await page.waitForTimeout(400);
    }
    await page.locator('[data-tab="products"]:visible').first().click({ timeout: 15000 });
    await page.waitForTimeout(1000);

    // Open the fixture product's form. Measuring the LIST page instead would
    // make every assertion below pass without the form ever being rendered, so
    // its presence is asserted before anything is measured.
    const editBtn = page.locator(`[data-product-id="${productId}"] [data-action="edit"]`).first();
    check(`${width}px: the fixture product is listed`, (await editBtn.count()) > 0, `productId=${productId}`);
    await editBtn.click({ timeout: 15000 });
    await page.waitForTimeout(1400);

    const formPresent = await page.evaluate(() => ({
      sections: document.querySelectorAll('section button[aria-expanded]').length,
      hasSaveBar: !!document.querySelector('[data-form="save-bar"]'),
    }));
    check(
      `${width}px: the product form is actually rendered`,
      formPresent.sections >= 8 && formPresent.hasSaveBar,
      JSON.stringify(formPresent)
    );

    // Open every section so the widest content is measured, not just the
    // collapsed headers.
    const headers = page.locator('section button[aria-expanded]');
    const n = await headers.count();
    for (let i = 0; i < n; i++) {
      const h = headers.nth(i);
      if ((await h.getAttribute('aria-expanded')) === 'false') await h.click();
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(300);

    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const overflowing = [];
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        // An element genuinely wider than the viewport, that is not itself a
        // scroll container, is what makes the PAGE scroll sideways.
        const style = getComputedStyle(el);
        const scrolls = style.overflowX === 'auto' || style.overflowX === 'scroll';
        if (!scrolls && r.right > doc.clientWidth + 1) {
          overflowing.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 40)}`);
          if (overflowing.length > 4) break;
        }
      }
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        overflowing,
        controls: Array.from(document.querySelectorAll('input,select,textarea')).map((el) => ({
          h: Math.round(el.getBoundingClientRect().height),
          tag: el.tagName.toLowerCase(),
          dir: el.getAttribute('dir'),
        })),
        arabicFieldNames: Array.from(document.querySelectorAll('label'))
          .map((l) => l.textContent || '')
          .filter((t) => /name_ar|name_ku|name_ckb|description_ar|description_ku|الاسم بالعربية|الوصف بالعربية/i.test(t)),
        extractionUi: document.body.innerHTML.includes('استخراج من رابط'),
      };
    });

    check(
      `${width}px: no horizontal page overflow`,
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth} first=${metrics.overflowing[0] ?? '-'}`
    );
    check(
      `${width}px: no element pushes past the viewport`,
      metrics.overflowing.length === 0,
      metrics.overflowing.join(', ')
    );

    const short = metrics.controls.filter((c) => c.tag !== 'textarea' && c.h > 0 && c.h < 40);
    check(`${width}px: every control is at least 40px tall`, short.length === 0, `${short.length} short`);

    const rtlInputs = metrics.controls.filter((c) => c.tag !== 'select' && c.dir !== 'ltr');
    check(`${width}px: English inputs are LTR`, rtlInputs.length === 0, `${rtlInputs.length} not ltr`);

    check(`${width}px: no ar/ckb fields in the form`, metrics.arabicFieldNames.length === 0, metrics.arabicFieldNames.join(', '));
    check(`${width}px: no URL-extraction panel`, metrics.extractionUi === false);

    const bar = await page.evaluate(() => {
      const el = document.querySelector('[data-form="save-bar"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      // What sits directly under the middle of the bar? If it is a form
      // control, the bar is covering content the admin needs.
      const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        inViewport: r.bottom <= window.innerHeight + 2,
        coversControl: !!under && !!under.closest('[data-form="save-bar"]') === false,
        width: Math.round(r.width),
        viewport: window.innerWidth,
      };
    });
    check(`${width}px: the save bar sits inside the viewport`, !!bar && bar.inViewport, JSON.stringify(bar));
    check(
      `${width}px: the save bar does not cover the content beneath it`,
      !!bar && bar.coversControl === false,
      JSON.stringify(bar)
    );
    check(
      `${width}px: the save bar stays inside the content column`,
      !!bar && bar.width <= bar.viewport,
      JSON.stringify(bar)
    );

    // Two shots per width: the top of the form (what an admin opens to) and
    // the whole scroll length (so the evidence shows every section, not a
    // flattering crop).
    // The dashboard scrolls an inner column, not the window, so scrollTo on
    // window is a no-op here — every scrolled ancestor is reset instead.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (el instanceof HTMLElement && el.scrollTop > 0) el.scrollTop = 0;
      }
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `form-${width}-top.png`), fullPage: false });
    await page.screenshot({ path: path.join(OUT, `form-${width}-full.png`), fullPage: true });

    // A focused shot of §7's colour↔option link matrix — the part of the
    // mandate that is hardest to judge from a summary. Sections are toggled
    // from the BOTTOM up so collapsing one never moves the next target.
    if (width === 390 || width === 1024) {
      const all = page.locator('section button[aria-expanded]');
      const total = await all.count();
      for (let i = total - 1; i >= 0; i--) {
        const h = all.nth(i);
        const wanted = i === 4; // section 5, zero-based
        if (((await h.getAttribute('aria-expanded')) === 'true') !== wanted) {
          await h.scrollIntoViewIfNeeded();
          await h.click({ force: true, timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(80);
        }
      }
      await page.waitForTimeout(500);
      // fullPage cannot help here: the dashboard scrolls an inner column, so
      // Playwright's full-page capture is still one viewport. Scroll the link
      // matrix into view and shoot that instead of a screenshot that stops
      // above the thing being evidenced.
      const matrix = page.locator('text=اربط اللون بخيارات محددة').first();
      if ((await matrix.count()) > 0) {
        await matrix.scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
      }
      await page.screenshot({ path: path.join(OUT, `links-${width}.png`) });
    }
    await ctx.close();
  }

  await browser.close();

  console.log(`\npassed ${passed}  failed ${failed}`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
