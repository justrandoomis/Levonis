#!/usr/bin/env node
/**
 * THE PURCHASE BAR'S MORPH, MEASURED IN A REAL BROWSER (owner spec §4;
 * src/components/quickBuy/QuickBuyBar.tsx).
 *
 * Drives tests/browser/quick-buy.html: a tap on the compact ⚡ (press, then a
 * ~450ms push sampled frame by frame), the big ⚡ buying without changing the
 * mode, the compact 🛒 reversing it, a drag below the threshold (springs
 * back), a drag past it (completes), a flick below it (completes), the
 * reverse drag and flick, a not-activated account (press + nudge, the sheet,
 * then the automatic morph on completion), insufficient balance (stays in
 * Quick Buy), the keyboard (Enter/Space on the compact capsules), reduced
 * motion (a short change, no push), and a 60-step drag measured for long
 * tasks, frame intervals and React commits (DOM mutations other than the
 * bar's own style writes). Frame screenshots at p ≈ 0, .3, .6 and 1.
 *
 * Run:  npx vite --port 4195 --strictPort --host 127.0.0.1   (from the repo)
 *       node scripts/e2e-quick-buy-bar.mjs <scenario[,scenario]|all> [width] [theme] [lang] [reduced]
 * Env:  QUICK_BUY_TEST_URL, OUT_DIR (screenshots), PLAYWRIGHT_MODULE.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const OUT = process.env.OUT_DIR || '/tmp/quick-buy-e2e';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.QUICK_BUY_TEST_URL || 'http://127.0.0.1:4195/tests/browser/quick-buy.html';
const [scenarioArg = 'tap', widthArg = '390', theme = 'dark', lang = 'ar', reducedArg] = process.argv.slice(2);
const width = Number(widthArg);
const reduced = reducedArg === 'reduced';
const tag = `${width}-${theme}-${lang}${reduced ? '-reduced' : ''}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const C = 50;
const G = 6;

async function open(browser, query) {
  const page = await browser.newPage({
    viewport: { width, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: false,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/storefront\/resolve|Failed to load resource/.test(m.text())) page.errors.push(m.text().slice(0, 300));
  });
  await page.goto(`${BASE}?${query}&theme=${theme}&lang=${lang}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-quick-buy-bar]')].some((b) => b.getBoundingClientRect().width > 0));
  await page.waitForTimeout(700);
  return page;
}

/** The bar's geometry, read from the DOM: p from the ⚡ capsule's width. */
async function geo(page) {
  return page.evaluate(([C, G]) => {
    const bar = [...document.querySelectorAll('[data-quick-buy-bar]')].find((b) => b.getBoundingClientRect().width > 0);
    const q = bar.querySelector('[data-quick-buy-capsule="quick"]').getBoundingClientRect();
    const c = bar.querySelector('[data-quick-buy-capsule="cart"]').getBoundingClientRect();
    const W = q.width + G + c.width;
    const D = W - G - 2 * C;
    return { mode: bar.dataset.mode, p: (q.width - C) / D, W, D, q: { x: q.x, y: q.y, w: q.width, h: q.height }, c: { x: c.x, y: c.y, w: c.width, h: c.height } };
  }, [C, G]);
}

const shot = async (page, name) => {
  const g = await geo(page);
  const pad = 14;
  const x = Math.min(g.q.x, g.c.x) - pad;
  const y = g.q.y - pad;
  const file = `${OUT}/bar-${name}-${tag}.png`;
  await page.screenshot({ path: file, clip: { x: Math.max(0, x), y: Math.max(0, y), width: Math.min(width, g.W + 2 * pad), height: g.q.h + 2 * pad } });
  console.log(`  shot ${file} (p=${g.p.toFixed(2)})`);
};

/** The ⚡ capsule's centre, and the sign that points toward the inline end on screen. */
async function handle(page) {
  const g = await geo(page);
  const rtl = await page.evaluate(() => getComputedStyle(document.querySelector('[data-quick-buy-bar]')).direction === 'rtl');
  return { x: g.q.x + g.q.w / 2, y: g.q.y + g.q.h / 2, toEnd: rtl ? -1 : 1, D: g.D };
}

/** Press on ⚡, move `share` of the travel toward the inline end in `steps`, optionally hold, release. */
async function drag(page, share, { steps = 12, stepMs = 16, hold = 120, shots = [], release = true, from } = {}) {
  const h = from ?? (await handle(page));
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(h.x + h.toEnd * h.D * share * (i / steps), h.y);
    if (stepMs) await page.waitForTimeout(stepMs);
    for (const s of shots) if (Math.abs(i / steps - s.at) < 1e-9) await shot(page, s.name);
  }
  if (hold) await page.waitForTimeout(hold);
  if (release) await page.mouse.up();
  return h;
}

const requests = (page) => page.evaluate(() => window.quickBuyRequests.map((r) => ({ ...r })));

const scenarios = {
  // Tap the compact ⚡: press, then the push over ~450ms, then quick mode — and frames along the way.
  async tap(browser) {
    const page = await open(browser, 'view=product&profile=active');
    const g0 = await geo(page);
    check('cart mode at rest: ⚡ is the compact circle at the inline start', g0.mode === 'cart' && Math.abs(g0.q.w - C) < 1 && Math.abs(g0.q.h - C) < 1 && (lang === 'en' ? g0.q.x < g0.c.x : g0.q.x > g0.c.x), JSON.stringify(g0.q));
    await shot(page, 'p0');
    // Sample p on every frame, then tap: the push is timed from the first frame it moves.
    await page.evaluate(([C]) => {
      window.__ps = [];
      const bar = [...document.querySelectorAll('[data-quick-buy-bar]')].find((b) => b.getBoundingClientRect().width > 0);
      const q = bar.querySelector('[data-quick-buy-capsule="quick"]');
      const c = bar.querySelector('[data-quick-buy-capsule="cart"]');
      const tick = (t) => {
        const qw = q.getBoundingClientRect().width;
        const D = qw + c.getBoundingClientRect().width - C * 2;
        window.__ps.push([t, (qw - C) / D]);
        if (window.__ps.length < 240) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, [C]);
    await page.click('[data-quick-buy-capsule="quick"] >> visible=true');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-quick-buy-bar]')].some((b) => b.dataset.mode === 'quick' && b.getBoundingClientRect().width > 0), null, { timeout: 3000 });
    const ps = await page.evaluate(() => window.__ps);
    const start = ps.find(([, v]) => v > 0.002);
    const end = ps.find(([, v]) => v > 0.998);
    const took = start && end ? Math.round(end[0] - start[0]) : -1;
    const middle = ps.filter(([, v]) => v > 0.1 && v < 0.9).length;
    const g1 = await geo(page);
    check(
      reduced ? 'reduced motion: a short change (≤ 220ms), no push' : 'the push takes ~450ms (380–520) and passes through the middle',
      reduced ? took >= 0 && took <= 220 && middle === 0 : took >= 380 && took <= 520 && middle >= 8,
      `took ${took}ms, ${middle} frames between 10% and 90%`
    );
    check('quick mode: ⚡ fills the bar, 🛒 is the compact circle, total width unchanged', Math.abs(g1.p - 1) < 0.01 && Math.abs(g1.c.w - C) < 1 && Math.abs(g1.W - g0.W) < 1, `p=${g1.p.toFixed(3)} W ${g0.W}→${g1.W}`);
    await shot(page, 'p1');
    const names = await page.evaluate(() => {
      const bar = [...document.querySelectorAll('[data-quick-buy-bar]')].find((b) => b.getBoundingClientRect().width > 0);
      return { quick: bar.querySelector('[data-quick-buy-capsule="quick"]').getAttribute('aria-label'), cart: bar.querySelector('[data-quick-buy-capsule="cart"]').getAttribute('aria-label') };
    });
    check('names: the big ⚡ is its visible label, the compact 🛒 says «back to add to cart»', names.quick === null && /(العودة إلى الإضافة للسلة|Back to Add to cart|گەڕانەوە بۆ زیادکردن بۆ سەبەتە)/.test(names.cart ?? ''), JSON.stringify(names));
    check('entering quick mode bought nothing and asked nothing of the wallet', !(await requests(page)).some((r) => r.path === '/api/quick-buy/items'));
    // The big capsule buys; it never changes the mode.
    await page.click('[data-quick-buy-capsule="quick"] >> visible=true');
    await page.waitForTimeout(1300);
    const adds = (await requests(page)).filter((r) => r.path === '/api/quick-buy/items');
    const g2 = await geo(page);
    check('the big ⚡ buys and stays in quick mode', adds.length === 1 && g2.mode === 'quick', `${adds.length} add(s), mode ${g2.mode}`);
    // Reverse tap: the compact 🛒.
    await page.click('[data-quick-buy-capsule="cart"] >> visible=true');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-quick-buy-bar]')].some((b) => b.dataset.mode === 'cart' && b.getBoundingClientRect().width > 0), null, { timeout: 3000 });
    const g3 = await geo(page);
    check('the compact 🛒 reverses it exactly', Math.abs(g3.p) < 0.01 && Math.abs(g3.q.w - C) < 1, `p=${g3.p.toFixed(3)}`);
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  // Drags: below the threshold springs back; past it completes; frames at p≈.3 and .6.
  async drag(browser) {
    const page = await open(browser, 'view=product&profile=active');
    await drag(page, 0.3, { shots: [{ at: 1, name: 'p03' }] });
    await page.waitForTimeout(700);
    const back = await geo(page);
    check('a slow drag to 30% springs back to the cart', back.mode === 'cart' && Math.abs(back.p) < 0.01, `p=${back.p.toFixed(3)}`);
    const before = (await requests(page)).length;
    await drag(page, 0.6, { shots: [{ at: 0.5, name: 'p03-way' }, { at: 1, name: 'p06' }] });
    await page.waitForTimeout(800);
    const done = await geo(page);
    check('a slow drag to 60% completes to Quick Buy', done.mode === 'quick' && Math.abs(done.p - 1) < 0.01, `p=${done.p.toFixed(3)}`);
    check('a drag never buys or adds', !(await requests(page)).slice(before).some((r) => r.path === '/api/quick-buy/items' || r.path === '/api/cart'));
    // Reverse drag: the big ⚡ toward the inline start.
    const h = await handle(page);
    await drag(page, -0.6, { from: { ...h, x: h.x } });
    await page.waitForTimeout(800);
    const rev = await geo(page);
    check('the reverse drag returns to the cart', rev.mode === 'cart' && Math.abs(rev.p) < 0.01, `p=${rev.p.toFixed(3)}`);
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  // A flick: 22% of the travel in ~3 frames — fast enough to complete although below the threshold.
  async flick(browser) {
    const page = await open(browser, 'view=product&profile=active');
    await drag(page, 0.22, { steps: 3, stepMs: 8, hold: 0 });
    await page.waitForTimeout(800);
    const g = await geo(page);
    check('a flick toward the inline end completes below the threshold', g.mode === 'quick' && Math.abs(g.p - 1) < 0.01, `p=${g.p.toFixed(3)}`);
    await drag(page, -0.22, { steps: 3, stepMs: 8, hold: 0 });
    await page.waitForTimeout(800);
    const back = await geo(page);
    check('a flick back returns', back.mode === 'cart' && Math.abs(back.p) < 0.01, `p=${back.p.toFixed(3)}`);
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  // Not activated: ⚡ plays the press, the sheet opens, and completing it morphs the bar with no second tap.
  async activate(browser) {
    const page = await open(browser, 'view=product&profile=inactive');
    await page.click('[data-quick-buy-capsule="quick"] >> visible=true');
    await page.waitForSelector('[data-overlay="quick-buy-sheet"] [data-quick-buy-activate]', { timeout: 8000 });
    const g0 = await geo(page);
    check('not activated: the bar stays in cart mode and the sheet opens', g0.mode === 'cart' && g0.p < 0.08, `p=${g0.p.toFixed(3)}`);
    for (const box of await page.$$('[data-overlay="quick-buy-sheet"] input[type=checkbox]')) await box.click();
    await page.click('[data-quick-buy-address="adr_home"]');
    await page.click('[data-quick-buy-activate]');
    await page.waitForSelector('[data-overlay="quick-buy-sheet"]', { state: 'detached', timeout: 8000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-quick-buy-bar]')].some((b) => b.dataset.mode === 'quick' && b.getBoundingClientRect().width > 0), null, { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(300);
    const g1 = await geo(page);
    check('activation completes → the bar morphs to Quick Buy on its own', g1.mode === 'quick' && Math.abs(g1.p - 1) < 0.01, `p=${g1.p.toFixed(3)}`);
    check('…and nothing was bought', !(await requests(page)).some((r) => r.path === '/api/quick-buy/items'));
    await shot(page, 'after-activation');
    check('no page errors', page.errors.length === 0, page.errors.join(' || '));
    await page.close();
  },

  // Insufficient balance: the refusal is said, and the bar stays in Quick Buy mode.
  async balance(browser) {
    const page = await open(browser, 'view=product&profile=active&balance=low');
    await page.click('[data-quick-buy-capsule="quick"] >> visible=true');
    await page.waitForTimeout(900);
    await page.click('[data-quick-buy-capsule="quick"] >> visible=true');
    await page.waitForTimeout(1300);
    const g = await geo(page);
    const txt = await page.evaluate(() => [...document.querySelectorAll('[role="status"], [role="alert"]')].map((n) => n.textContent.trim()).join(' | '));
    check('insufficient balance: both amounts said, quick mode kept', g.mode === 'quick' && /125,000/.test(txt) && /460,000/.test(txt), `${g.mode} ${txt.slice(0, 140)}`);
    await page.close();
  },

  // Keyboard: both compact capsules are real buttons.
  async keyboard(browser) {
    const page = await open(browser, 'view=product&profile=active');
    await page.focus('[data-quick-buy-capsule="quick"] >> visible=true');
    const label = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await shot(page, 'focus-quick');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-quick-buy-bar]')].some((b) => b.dataset.mode === 'quick' && b.getBoundingClientRect().width > 0), null, { timeout: 3000 }).catch(() => {});
    const g = await geo(page);
    check('Enter on the compact ⚡ («Turn on Quick Buy») morphs', g.mode === 'quick' && /(تفعيل الشراء السريع|Turn on Quick Buy|چالاککردنی کڕینی خێرا)/.test(label ?? ''), label);
    await page.focus('[data-quick-buy-capsule="cart"] >> visible=true');
    await page.keyboard.press(' ');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-quick-buy-bar]')].some((b) => b.dataset.mode === 'cart' && b.getBoundingClientRect().width > 0), null, { timeout: 3000 }).catch(() => {});
    const g2 = await geo(page);
    check('Space on the compact 🛒 returns', g2.mode === 'cart', g2.mode);
    await page.close();
  },

  // Frames and long tasks while a finger drags: no React render, no dropped frames.
  async perf(browser) {
    const page = await open(browser, 'view=product&profile=active');
    await page.evaluate(() => {
      window.__perf = { frames: [], longtasks: [], mutations: 0 };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__perf.longtasks.push(Math.round(e.duration));
      }).observe({ type: 'longtask', buffered: false });
      const mo = new MutationObserver((records) => {
        // React commits change children, text and attributes; the bar's own frames write only `style`.
        for (const r of records) if (!(r.type === 'attributes' && r.attributeName === 'style')) window.__perf.mutations += 1;
      });
      mo.observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true, characterData: true });
      window.__perfStop = () => mo.disconnect();
      let last = performance.now();
      const tick = (t) => {
        window.__perf.frames.push(t - last);
        last = t;
        if (window.__perf.running) requestAnimationFrame(tick);
      };
      window.__perf.running = true;
      requestAnimationFrame(tick);
    });
    await drag(page, 0.42, { steps: 60, stepMs: 16, hold: 60, release: false });
    const during = await page.evaluate(() => {
      window.__perf.running = false;
      window.__perfStop();
      const f = window.__perf.frames.slice(2);
      const sorted = [...f].sort((a, b) => a - b);
      return { n: f.length, max: Math.max(...f), p95: sorted[Math.floor(sorted.length * 0.95)], long: window.__perf.longtasks, mutations: window.__perf.mutations };
    });
    await page.mouse.up();
    check('during a 60-step drag: no long task, no React commit, frames on time', during.long.length === 0 && during.mutations === 0 && during.p95 < 20, JSON.stringify(during));
    await page.close();
  },
};

(async () => {
  const browser = await pw.chromium.launch();
  for (const name of scenarioArg === 'all' ? Object.keys(scenarios) : scenarioArg.split(',')) {
    console.log(`\n# ${name} (${tag})`);
    try {
      await scenarios[name](browser);
    } catch (e) {
      check(`${name} ran to the end`, false, String(e && e.message ? e.message : e).slice(0, 400));
    }
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
