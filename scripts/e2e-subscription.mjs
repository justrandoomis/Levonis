#!/usr/bin/env node
/**
 * /subscription in a real browser, at every width.
 *
 * WHY THIS EXISTS. The page used to render its plans in a WebGL carousel
 * (CircularGallery) laid out in world units on a fixed 450px stage. Its cards
 * kept their own proportions no matter how wide the viewport was, so on a
 * tablet they spilled off both edges — which is exactly what the owner
 * photographed. A screenshot proves a fix on one device; these checks prove it
 * on five, and they assert the page is ON SCREEN before measuring anything, so
 * a blank render cannot quietly pass every responsive assertion.
 *
 *   node scripts/e2e-subscription.mjs            (expects wrangler dev on :8787)
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
const OUT = path.join(ROOT, 'docs', 'evidence', 'subscription');

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

const rnd = Math.random().toString(36).slice(2, 8);

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nLEVONIS /subscription — ${BASE}\n`);

  // ------------------------------------------------------- the plan catalog
  const plansRes = await fetch(`${BASE}/api/memberships/plans`);
  const { plans = [] } = await plansRes.json();
  check('the plan catalog loads', plansRes.status === 200 && plans.length > 0, `plans=${plans.length}`);

  const byTier = (tier) => plans.filter((p) => p.tier === tier);
  check('LEVO PRIME is in the catalog', byTier('prime').length === 1, JSON.stringify(byTier('prime')));
  check(
    'PRIME is annual at 99,000 IQD',
    byTier('prime')[0]?.duration_months === 12 && byTier('prime')[0]?.price_iqd === 99000,
    JSON.stringify(byTier('prime')[0] ?? null)
  );
  check(
    'PLUS is offered as 12 months only',
    byTier('plus').length === 1 && byTier('plus')[0].duration_months === 12,
    JSON.stringify(byTier('plus').map((p) => p.duration_months))
  );
  check(
    'PRO is offered as 12 months only',
    byTier('pro').length === 1 && byTier('pro')[0].duration_months === 12,
    JSON.stringify(byTier('pro').map((p) => p.duration_months))
  );
  check(
    'no plan shorter than 12 months is sellable at all',
    plans.every((p) => p.duration_months === 12),
    JSON.stringify(plans.map((p) => `${p.id}:${p.duration_months}`))
  );

  // A retired plan must stay un-buyable even when its id is posted directly.
  const email = `sub-${rnd}@test.local`;
  const password = 'subscription-pass-1';
  let cookie = '';
  const call = async (p, body) => {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  };
  await call('/api/auth/register', { email, username: `sub${rnd}`, name: 'Sub Tester', password });
  await call('/api/auth/login', { email, password });
  const retired = await call('/api/memberships/subscribe', {
    planId: 'plus_3mo',
    idempotencyKey: `sub-${rnd}-retired`,
  });
  check(
    'a retired plan is refused server-side, not just hidden',
    retired.status >= 400,
    `status=${retired.status} ${JSON.stringify(retired.data).slice(0, 120)}`
  );

  // ------------------------------------------------------------- the page
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });

  for (const width of [360, 390, 768, 1024, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: 'ar' });
    await ctx.addCookies([
      { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' },
    ]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/subscription`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    // Assert the page really rendered BEFORE measuring; otherwise an empty
    // document passes every overflow check below for the wrong reason.
    const tabs = await page.locator('[data-tier-tab]').count();
    const cards = await page.locator('[data-plan]').count();
    check(`${width}px — the tier tabs rendered`, tabs === 3, `tabs=${tabs}`);
    check(`${width}px — a plan card rendered`, cards >= 1, `cards=${cards}`);
    if (tabs !== 3 || cards < 1) {
      await ctx.close();
      continue;
    }

    check(
      `${width}px — PLUS, PRIME and PRO are all offered`,
      (await page.locator('[data-tier-tab="plus"]').count()) === 1 &&
        (await page.locator('[data-tier-tab="prime"]').count()) === 1 &&
        (await page.locator('[data-tier-tab="pro"]').count()) === 1
    );

    // RATIO — the whole point of the rebuild.
    const doc = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${width}px — the page does not scroll sideways`, doc <= 1, `overflow=${doc}px`);

    const spill = await page.evaluate(() => {
      let worst = 0;
      for (const el of document.querySelectorAll('main *, body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          worst = Math.max(worst, Math.ceil(r.right) - window.innerWidth, Math.ceil(-r.left));
        }
      }
      return worst;
    });
    check(`${width}px — nothing spills past the viewport`, spill <= 2, `spill=${spill}px`);

    const geom = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-plan]')];
      return cards.map((c) => {
        const r = c.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), ratio: +(r.width / r.height).toFixed(3) };
      });
    });
    check(
      `${width}px — every plan card holds its 3:4 ratio`,
      geom.every((g) => Math.abs(g.ratio - 0.75) < 0.06),
      JSON.stringify(geom)
    );
    check(
      `${width}px — plan cards are wide enough to read`,
      geom.every((g) => g.w >= 120),
      JSON.stringify(geom.map((g) => g.w))
    );

    const tabH = await page.evaluate(() => {
      const t = [...document.querySelectorAll('[data-tier-tab]')];
      return t.length ? Math.min(...t.map((x) => x.getBoundingClientRect().height)) : 0;
    });
    check(`${width}px — every tab is at least 44px tall`, tabH >= 44, `min=${Math.round(tabH)}px`);

    // NO ANIMATION — no canvas stage, no WebGL context, no bouncing hint.
    const anim = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      bouncing: document.querySelectorAll('.animate-bounce').length,
      // the loading spinner is legitimate; it is gone once plans have loaded
      spinners: document.querySelectorAll('.animate-spin').length,
    }));
    check(`${width}px — no canvas/WebGL stage remains`, anim.canvases === 0, JSON.stringify(anim));
    check(`${width}px — no bouncing scroll hint remains`, anim.bouncing === 0, JSON.stringify(anim));
    check(`${width}px — no spinner once the plans are in`, anim.spinners === 0, JSON.stringify(anim));

    // Switching to PRIME must show the annual PRIME plan and its price.
    await page.locator('[data-tier-tab="prime"]').first().click();
    await page.waitForTimeout(400);
    const primeCards = await page.locator('[data-plan]').count();
    const primeText = await page.locator('[data-plan]').first().innerText();
    check(`${width}px — PRIME shows exactly one annual plan`, primeCards === 1, `cards=${primeCards}`);
    check(
      `${width}px — the PRIME card shows 12 months and 99,000`,
      // Strip every space the locale may use (ASCII, NBSP, narrow NBSP)
      // before matching, and accept either thousands separator.
      /12/.test(primeText) && /99[,.\u066C]?000/.test(primeText.replace(/[\s\u00A0\u202F]/g, '')),
      JSON.stringify(primeText)
    );

    await page.screenshot({ path: path.join(OUT, `subscription-${width}.png`) });
    await page.locator('[data-tier-tab="pro"]').first().click();
    await page.waitForTimeout(300);

    await ctx.close();
  }

  // ------------------------------------------------ /community is reachable
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'ar' });
    await ctx.addCookies([
      { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' },
    ]);
    const page = await ctx.newPage();

    // An account with NO username is the case that used to bounce forever.
    sql(`UPDATE users SET username = NULL WHERE email = '${email}'`);
    await page.goto(`${BASE}/community`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    check(
      '/community stays on /community for an account with no username',
      new URL(page.url()).pathname === '/community',
      page.url()
    );
    await page.screenshot({ path: path.join(OUT, 'community-390.png') });
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
