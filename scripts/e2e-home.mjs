#!/usr/bin/env node
/**
 * The home page in a real browser, at every width, in BOTH hero modes.
 *
 * WHY THIS EXISTS. The home page opened on a bare Services card: no hero, no
 * categories, no brands. The owner could configure `coupons_offers`,
 * `categories` and `top_brands` in the admin panel and the storefront
 * rendered none of them, and the draggable section ORDER changed nothing a
 * customer could see. This drives the real page and asserts what a visitor
 * actually gets — with the hero present BEFORE measuring anything, so a blank
 * render cannot quietly pass every responsive check.
 *
 * Both hero modes are exercised against the same running app: first with no
 * banners configured (the fallback), then with real banners written through
 * the admin API and read back on the page.
 *
 *   node scripts/e2e-home.mjs        (expects wrangler dev on :8787)
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
const OUT = path.join(ROOT, 'docs', 'evidence', 'home');

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

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const WIDTHS = [360, 390, 768, 1024, 1440];
const rnd = Math.random().toString(36).slice(2, 8);

/** Everything the page can tell us in one evaluate. */
async function measure(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const all = (s) => [...document.querySelectorAll(s)];
    let spill = 0;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
      spill = Math.max(spill, Math.ceil(r.right) - document.documentElement.clientWidth);
    }
    const heroEl = q('[data-hero]');

    // The site header is FIXED and paints over the top of the page, so a hero
    // that starts at y=0 puts its headline underneath the search field. A
    // screenshot showed exactly that; none of the size or overflow checks
    // could. This measures the actual overlap in pixels.
    const headerBox = q('header form[role="search"]')?.getBoundingClientRect() ?? null;
    const titleBox = q('[data-hero-title]')?.getBoundingClientRect() ?? null;
    const ctaBoxes = all('[data-hero-cta]').map((e) => e.getBoundingClientRect());
    const overlapWith = (b) => {
      if (!headerBox || !b) return 0;
      const y = Math.min(headerBox.bottom, b.bottom) - Math.max(headerBox.top, b.top);
      const x = Math.min(headerBox.right, b.right) - Math.max(headerBox.left, b.left);
      return y > 0 && x > 0 ? Math.round(y) : 0;
    };

    return {
      headerOverlapsTitle: overlapWith(titleBox),
      headerOverlapsCta: Math.max(0, ...ctaBoxes.map(overlapWith)),
      sawHeader: !!headerBox,
      heroMode: heroEl?.getAttribute('data-hero') ?? null,
      heroTitle: q('[data-hero-title]')?.textContent?.trim() ?? '',
      heroHeight: heroEl ? Math.round(heroEl.getBoundingClientRect().height) : 0,
      heroCtas: all('[data-hero-cta]').length,
      shortestCta: all('[data-hero-cta]').length
        ? Math.round(Math.min(...all('[data-hero-cta]').map((e) => e.getBoundingClientRect().height)))
        : 0,
      services: all('[data-service]').map((e) => e.getAttribute('data-service')),
      shortestService: all('[data-service]').length
        ? Math.round(Math.min(...all('[data-service]').map((e) => e.getBoundingClientRect().height)))
        : 0,
      // Read off the LIVE element, so the check covers what the build
      // actually shipped rather than what the source says.
      studioTarget: document.querySelector('[data-service="studio"]')?.getAttribute('target') ?? null,
      studioRel: document.querySelector('[data-service="studio"]')?.getAttribute('rel') ?? null,
      studioHref: document.querySelector('[data-service="studio"]')?.getAttribute('href') ?? null,
      sections: all('[data-home-section]').map((e) => e.getAttribute('data-home-section')),
      categoryChips: all('[data-category-chip]').length,
      shortestChip: all('[data-category-chip]').length
        ? Math.round(Math.min(...all('[data-category-chip]').map((e) => e.getBoundingClientRect().height)))
        : 0,
      brandChips: all('[data-brand-chip]').length,
      dots: all('[data-hero-dot]').length,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      spill,
    };
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nLEVONIS home — hero, services and sections — ${BASE}\n`);

  // --------------------------------------------------- the API's own shape
  console.log('0. what /api/home actually returns');
  const home = await new Client().get('/api/home');
  check('/api/home answers 200', home.status === 200, `status=${home.status}`);
  check('it returns the real catalogue', Array.isArray(home.data?.categories), typeof home.data?.categories);
  check('it returns the real brands', Array.isArray(home.data?.brands), typeof home.data?.brands);
  check(
    'every category it returns actually has products',
    (home.data?.categories ?? []).every((c) => Number(c.product_count) > 0),
    JSON.stringify((home.data?.categories ?? []).map((c) => c.product_count))
  );
  // ONE CHIP PER NAME. The live database holds seven top-level catalogs all
  // called "Printers" and seven brands all called "Bambu Lab", left by
  // repeated seeding — the ungrouped query rendered seven identical chips in a
  // row on the real home page.
  const catNames = (home.data?.categories ?? []).map((c) => c.name_en || c.name_ar);
  const brandNames = (home.data?.brands ?? []).map((b) => b.name_en || b.name_ar);
  check(
    'no two category chips carry the same name',
    new Set(catNames).size === catNames.length,
    JSON.stringify(catNames)
  );
  check(
    'no two brand chips carry the same name',
    new Set(brandNames).size === brandNames.length,
    JSON.stringify(brandNames)
  );

  const liveCategories = (home.data?.categories ?? []).length;
  const liveBrands = (home.data?.brands ?? []).length;
  console.log(`     (${liveCategories} categories, ${liveBrands} brands with stock)`);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  // ------------------------------------------- 1. no banners: the fallback
  console.log('\n1. no banners configured — the default hero');
  // BOTH keys, not just the banners. Section 3 hides `categories` and
  // reorders the sections, and that layout outlives the process: a run that
  // is interrupted after section 3 leaves the next run starting with the
  // categories section switched off, and sections 1 and 2 then fail with
  // chips=0 and mode=default on a codebase that is perfectly fine. Reset
  // everything this suite writes, so a run's result depends on the run.
  sql("DELETE FROM admin_settings WHERE key IN ('homeBanners', 'homeSections')");
  await settle();

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ar' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const m = await measure(page);

    // Assert the page RENDERED before measuring — an empty document would
    // otherwise pass every overflow assertion below.
    check(`${width}px — a hero is rendered`, m.heroMode === 'default', `mode=${m.heroMode}`);
    if (m.heroMode !== 'default') {
      await page.screenshot({ path: path.join(OUT, `home-${width}-nohero.png`), fullPage: true });
      await ctx.close();
      continue;
    }
    check(`${width}px — the hero states what the store is`, m.heroTitle.length > 5, JSON.stringify(m.heroTitle));
    check(`${width}px — the hero offers both entry points`, m.heroCtas === 2, `ctas=${m.heroCtas}`);
    check(`${width}px — every hero button is at least 44px`, m.shortestCta >= 44, `${m.shortestCta}px`);
    check(`${width}px — the hero has real height`, m.heroHeight >= 240, `${m.heroHeight}px`);
    check(`${width}px — the fixed header does not cover the hero headline`, m.headerOverlapsTitle === 0, `${m.headerOverlapsTitle}px of overlap`);
    check(`${width}px — the fixed header does not cover a hero button`, m.headerOverlapsCta === 0, `${m.headerOverlapsCta}px of overlap`);

    check(`${width}px — all six services are listed`, m.services.length === 6, JSON.stringify(m.services));
    check(
      `${width}px — the Studio card is among them`,
      m.services.includes('studio'),
      JSON.stringify(m.services)
    );
    check(`${width}px — every service card is at least 44px`, m.shortestService >= 44, `${m.shortestService}px`);

    // The Studio opens on its OWN page. Asserted against the RENDERED DOM,
    // not the source: the owner reported the Studio taking over the store's
    // tab, and a source-only guard cannot tell whether the attribute survived
    // the build and reached the browser.
    check(
      `${width}px — the Studio card opens in a new tab`,
      m.studioTarget === '_blank',
      `target=${JSON.stringify(m.studioTarget)}`
    );
    check(
      `${width}px — and carries rel="noopener noreferrer"`,
      (m.studioRel ?? '').includes('noopener') && (m.studioRel ?? '').includes('noreferrer'),
      `rel=${JSON.stringify(m.studioRel)}`
    );
    check(
      `${width}px — pointing at the Studio subdomain, not a store path`,
      (m.studioHref ?? '').startsWith('https://studio.'),
      `href=${JSON.stringify(m.studioHref)}`
    );

    check(`${width}px — the page does not scroll sideways`, m.docOverflow <= 1, `${m.docOverflow}px`);
    check(`${width}px — nothing spills past the viewport`, m.spill <= 2, `${m.spill}px`);

    if (liveCategories > 0) {
      check(`${width}px — the real categories are shown`, m.categoryChips === liveCategories, `chips=${m.categoryChips}`);
      check(`${width}px — every category chip is at least 44px`, m.shortestChip >= 44, `${m.shortestChip}px`);
    }
    if (liveBrands > 0) {
      check(`${width}px — the real brands are shown`, m.brandChips === liveBrands, `chips=${m.brandChips}`);
    }

    await page.screenshot({ path: path.join(OUT, `home-default-${width}.png`), fullPage: width <= 768 });
    await ctx.close();
  }

  // --------------------------------------- 2. real banners: the owner hero
  console.log('\n2. banners configured — the owner hero');
  const admin = new Client();
  const email = `home-${rnd}@test.local`;
  const password = 'home-pass-1';
  let r = await admin.post('/api/auth/register', { email, username: `home${rnd}`, name: 'Home Admin', password });
  check('admin account created', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  sql(`UPDATE users SET role='admin' WHERE email='${email}'`);
  await settle();
  r = await admin.post('/api/auth/login', { email, password });
  check('admin signed in', r.status === 200);

  const HEAD_AR = `عنوان البانر ${rnd}`;
  const put = await admin.put('/api/admin/settings/homeBanners', {
    value: {
      first_banner: [
        {
          id: `bn_a_${rnd}`,
          image: PIXEL,
          link: '/products',
          title: { ar: HEAD_AR, en: `Banner headline ${rnd}`, ckb: '' },
          subtitle: { ar: 'وصف البانر', en: 'Banner sub-line', ckb: '' },
          cta: { ar: 'تسوّق', en: 'Shop', ckb: '' },
        },
        {
          id: `bn_b_${rnd}`,
          image: PIXEL,
          link: 'javascript:alert(1)',
          title: { ar: 'البانر الثاني', en: 'Second banner', ckb: '' },
          subtitle: { ar: '', en: '', ckb: '' },
          cta: { ar: '', en: '', ckb: '' },
        },
      ],
    },
  });
  check('the banners saved through the real admin API', put.status === 200, JSON.stringify(put.data).slice(0, 160));

  // The server must have dropped the script URL before it was ever stored.
  const after = await new Client().get('/api/home');
  const stored = after.data?.settings?.homeBanners?.first_banner ?? [];
  check('both banners came back', stored.length === 2, `banners=${stored.length}`);
  check(
    'the javascript: link was stripped on the way IN, not just on the way out',
    stored[1]?.link === '',
    JSON.stringify(stored[1]?.link)
  );
  check('the per-language headline survived the round trip', stored[0]?.title?.ar === HEAD_AR, JSON.stringify(stored[0]?.title));

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ar' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const m = await measure(page);

    check(`${width}px — the owner's banners replace the default hero`, m.heroMode === 'banners', `mode=${m.heroMode}`);
    if (m.heroMode !== 'banners') {
      await ctx.close();
      continue;
    }
    check(`${width}px — the Arabic headline is the one shown`, m.heroTitle === HEAD_AR, JSON.stringify(m.heroTitle));
    check(`${width}px — two dots for two banners`, m.dots === 2, `dots=${m.dots}`);
    check(`${width}px — the fixed header does not cover the banner headline`, m.headerOverlapsTitle === 0, `${m.headerOverlapsTitle}px of overlap`);
    check(`${width}px — the page still does not scroll sideways`, m.docOverflow <= 1, `${m.docOverflow}px`);
    check(`${width}px — nothing spills past the viewport`, m.spill <= 2, `${m.spill}px`);
    check(`${width}px — the services survive a configured hero`, m.services.length === 6, JSON.stringify(m.services));

    // No stored javascript: URL can reach an href.
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '')
    );
    check(
      `${width}px — no rendered link is a script URL`,
      !hrefs.some((h) => /^\s*(javascript|data|vbscript):/i.test(h)),
      JSON.stringify(hrefs.filter((h) => /^\s*(javascript|data|vbscript):/i.test(h)))
    );

    if (width === 390 || width === 1024) {
      await page.screenshot({ path: path.join(OUT, `home-banners-${width}.png`), fullPage: width === 390 });
    }
    await ctx.close();
  }

  // ------------------------------------ 3. the layout toggles do something
  console.log('\n3. the admin layout actually drives the page');
  const hide = await admin.put('/api/admin/settings/homeSections', {
    value: [
      { id: 'ads_panel', titleEn: 'Ads Panel', titleAr: 'لوحة الاعلانات', isVisible: true },
      { id: 'first_banner', titleEn: 'First Banner', titleAr: 'الشريط الاول', isVisible: false },
      { id: 'second_banner', titleEn: 'Second Banner', titleAr: 'الشريط الثاني', isVisible: true },
      { id: 'coupons_offers', titleEn: 'Coupons', titleAr: 'كوبونات', isVisible: true },
      { id: 'categories', titleEn: 'Categories', titleAr: 'الأقسام', isVisible: false },
      { id: 'discounts_offers', titleEn: 'Discounts', titleAr: 'خصومات', isVisible: true },
      { id: 'top_brands', titleEn: 'Top Brands', titleAr: 'العلامات', isVisible: true },
    ],
  });
  check('the layout saved', hide.status === 200, JSON.stringify(hide.data).slice(0, 120));

  {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 }, locale: 'ar' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const m = await measure(page);
    check(
      'hiding the first banner really removes it — the default hero returns',
      m.heroMode === 'default',
      `mode=${m.heroMode}`
    );
    check('hiding the categories section really removes it', m.categoryChips === 0, `chips=${m.categoryChips}`);
    check('a section left visible is still there', m.sections.includes('top_brands'), JSON.stringify(m.sections));
    await ctx.close();
  }

  // Reordering must move a section, not be ignored as it was before.
  const reorder = await admin.put('/api/admin/settings/homeSections', {
    value: [
      { id: 'top_brands', titleEn: 'Top Brands', titleAr: 'العلامات', isVisible: true },
      { id: 'categories', titleEn: 'Categories', titleAr: 'الأقسام', isVisible: true },
      { id: 'ads_panel', titleEn: 'Ads Panel', titleAr: 'لوحة الاعلانات', isVisible: true },
      { id: 'first_banner', titleEn: 'First Banner', titleAr: 'الشريط الاول', isVisible: true },
      { id: 'second_banner', titleEn: 'Second Banner', titleAr: 'الشريط الثاني', isVisible: true },
      { id: 'coupons_offers', titleEn: 'Coupons', titleAr: 'كوبونات', isVisible: true },
      { id: 'discounts_offers', titleEn: 'Discounts', titleAr: 'خصومات', isVisible: true },
    ],
  });
  check('the reordered layout saved', reorder.status === 200);
  {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 }, locale: 'ar' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const m = await measure(page);
    const brands = m.sections.indexOf('top_brands');
    const cats = m.sections.indexOf('categories');
    if (brands === -1 || cats === -1) {
      check('both reorderable sections are on the page', false, JSON.stringify(m.sections));
    } else {
      check(
        'top brands now renders BEFORE categories, as the admin ordered them',
        brands < cats,
        JSON.stringify(m.sections)
      );
    }
    await ctx.close();
  }

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
