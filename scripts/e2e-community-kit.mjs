#!/usr/bin/env node
/**
 * THE COMMUNITY KIT, MEASURED IN A REAL BROWSER (community UI plan B1, kit
 * review round 3). tests/communityScope.test.ts pins what the scope sheet
 * says; this measures what Chromium draws on the kit fixture
 * (tests/browser/community-kit.html):
 *
 *   - the chosen segmented label is never clipped (scrollWidth over
 *     clientWidth) at 390, 375, 360 and 320 in English, Sorani and Arabic;
 *   - every line and icon of a one-line choice tile stays at least 2px clear
 *     of the check badge seat (ckb 375, en 390 / 375 / 360, ar 390, ckb 320);
 *   - the keyboard focus of a thumb, a tile and a chip, chosen or not, is a
 *     2px line 2px off the control in the focus colour, the flush ring gone;
 *   - a FilterSelect menu row under the keyboard wears the focus line, inset;
 *   - a held kit button keeps its full ink under reduced motion (no 0.72 dim).
 *
 * Screenshots go to OUT_DIR (default /tmp/claude-0/shots/community-kit/).
 *
 * Run: serve the repo with vite (`npx vite --port 4192`), then
 *      node scripts/e2e-community-kit.mjs
 *      (COMMUNITY_KIT_URL, PLAYWRIGHT_MODULE as for the other e2e scripts)
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.COMMUNITY_KIT_URL || 'http://127.0.0.1:4192/tests/browser/community-kit.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/community-kit';
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passes += 1;
    console.log(`ok   ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`FAIL ${name} ${detail}`);
  }
}

async function open(browser, { theme = 'dark', lang = 'ar', width = 390, height = 844, reduced = true, touch = true }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    hasTouch: touch,
    isMobile: touch,
  });
  await context.addInitScript(([l, t]) => {
    try {
      localStorage.setItem('levo_lang', l);
      localStorage.setItem('levonis.theme.v1', t);
    } catch {
      /* private mode: the query string still sets both */
    }
  }, [lang, theme]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?theme=${theme}&lang=${lang}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-kit="tiles"] [role="radiogroup"]');
  await page.waitForTimeout(600);
  return { context, page, errors, tag: `${theme}-${lang}-${width}` };
}

const browser = await chromium.launch();

// ------------------------------------------------- the segmented label
for (const [lang, width, height] of [['en', 390, 844], ['en', 375, 812], ['en', 360, 780], ['en', 320, 700], ['ckb', 320, 700], ['ckb', 360, 780], ['ar', 320, 700]]) {
  const { context, page, errors, tag } = await open(browser, { lang, width, height });
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.cm-seg [role="radio"]')].map((o) => {
      const s = o.querySelector('.truncate');
      const ro = o.getBoundingClientRect();
      const rs = s.getBoundingClientRect();
      return { text: s.textContent, checked: o.getAttribute('aria-checked'), sw: s.scrollWidth, cw: s.clientWidth, room: Math.min(rs.left - ro.left, ro.right - rs.right) };
    })
  );
  for (const l of labels) {
    check(`${tag}: segmented «${l.text}»${l.checked === 'true' ? ' (chosen)' : ''} is not clipped`, l.sw <= l.cw, `scrollWidth ${l.sw} over ${l.cw}`);
    check(`${tag}: segmented «${l.text}» keeps 2px from the thumb edge`, l.room >= 2 - 0.5, `${l.room.toFixed(1)}px`);
  }
  await page.locator('[data-segmented="kit-quality"]').screenshot({ path: `${out}/${tag}-segmented.png` });
  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

// ------------------------------------------------- the one-line tiles
for (const [lang, width, height] of [['ckb', 375, 812], ['en', 390, 844], ['en', 375, 812], ['en', 360, 780], ['ar', 390, 844], ['ckb', 320, 700]]) {
  for (const theme of ['dark', 'light']) {
    const { context, page, tag } = await open(browser, { theme, lang, width, height });
    const tiles = await page.evaluate(() =>
      [...document.querySelectorAll('[data-kit="tiles"] [role="radiogroup"] > button')]
        .filter((t) => t.querySelector('.cm-tile-body'))
        .map((t) => {
          const tb = t.getBoundingClientRect();
          const rtl = getComputedStyle(t).direction === 'rtl';
          // The seat the badge takes once the tile is chosen: 1px border, 6px in, a 20px disc.
          const x = rtl ? tb.right - 1 - 6 - 20 : tb.left + 1 + 6;
          const seat = { l: x, r: x + 20, t: tb.top + 1 + 6, b: tb.top + 1 + 26 };
          const badge = t.querySelector('.cm-check').getBoundingClientRect();
          const rects = [];
          const walk = document.createTreeWalker(t.querySelector('.cm-tile-body'), NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (!n.textContent.trim()) continue;
            const r = document.createRange();
            r.selectNodeContents(n);
            rects.push(...r.getClientRects());
          }
          const icon = t.querySelector('.cm-tile-body svg');
          if (icon) rects.push(icon.getBoundingClientRect());
          let gap = Infinity;
          for (const q of rects) {
            const dx = Math.max(seat.l - q.right, q.left - seat.r, 0);
            const dy = Math.max(seat.t - q.bottom, q.top - seat.b, 0);
            gap = Math.min(gap, dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy));
          }
          const chosen = t.getAttribute('aria-checked') === 'true';
          const seatOff = chosen ? Math.max(Math.abs(badge.left - seat.l), Math.abs(badge.top - seat.t)) : 0;
          return { text: t.textContent.trim(), chosen, gap, seatOff };
        })
    );
    for (const t of tiles) {
      check(`${tag}: tile «${t.text}» stays 2px clear of the badge seat`, t.gap >= 2 - 0.05, `${t.gap.toFixed(1)}px`);
      if (t.chosen) check(`${tag}: the badge of «${t.text}» sits where the seat is measured`, t.seatOff <= 0.5, `${t.seatOff.toFixed(1)}px off`);
    }
    await page.locator('[data-kit="tiles"] [role="radiogroup"]').first().screenshot({ path: `${out}/${tag}-tiles.png` });
    await context.close();
  }
}

// ------------------------------------------------- the focus off the sand
for (const theme of ['dark', 'light']) {
  for (const lang of ['ar', 'en']) {
    const { context, page, tag } = await open(browser, { theme, lang, touch: false });
    const focus = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-surface')).getPropertyValue('--color-focus').trim());
    const rgbOf = (c) => page.evaluate((c) => {
      const el = document.createElement('i');
      el.style.color = c;
      document.body.append(el);
      const v = getComputedStyle(el).color;
      el.remove();
      return v;
    }, c);
    const ring = await rgbOf(focus);
    // A keyboard press first: a focus moved by script after it is :focus-visible, as after a Tab.
    await page.keyboard.press('Shift');
    const targets = [
      ['the chosen segmented thumb', '[data-segmented="kit-quality"] [aria-checked="true"]', null],
      ['the chosen print-method tile', '[data-kit="tiles"] [role="radiogroup"] [aria-checked="true"]', null],
      ['an unchosen tile', '[data-kit="tiles"] [role="radiogroup"] [aria-checked="false"]', null],
      ['the chosen filter chip', '[data-filter-select="fdm"] button[aria-haspopup]', '.cm-sel'],
      ['the pressed chip', '[data-kit-row="filters"] > button[aria-pressed="true"]:has(.cm-sel)', '.cm-sel'],
    ];
    for (const [name, sel, drawn] of targets) {
      const style = await page.evaluate(([sel, drawn]) => {
        const el = document.querySelector(sel);
        el.focus();
        const at = drawn ? el.querySelector(drawn) : el;
        const cs = getComputedStyle(at);
        return { fv: el.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset, color: cs.outlineColor, shadow: cs.boxShadow };
      }, [sel, drawn]);
      await page.waitForTimeout(220); // the colour transition of the house control
      const color = await page.evaluate(([sel, drawn]) => {
        const el = document.querySelector(sel);
        return getComputedStyle(drawn ? el.querySelector(drawn) : el).outlineColor;
      }, [sel, drawn]);
      check(`${tag}: ${name} draws its focus as a 2px line 2px off it`, style.fv && style.style === 'solid' && style.width === '2px' && parseFloat(style.offset) >= 2, JSON.stringify(style));
      check(`${tag}: … in the focus colour`, color === ring, `${color} vs ${ring}`);
      check(`${tag}: … and no ring hugs the fill`, !style.shadow.includes(ring.replace(')', '')), style.shadow.slice(0, 120));
    }
    await page.locator('[data-kit="selection"]').screenshot({ path: `${out}/${tag}-focus-filters.png` });

    // ----------------------------------------------- the menu row focus
    await page.locator('[data-filter-select] button[aria-haspopup]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(250);
    const row = await page.evaluate(() => {
      const a = document.activeElement;
      const cs = getComputedStyle(a);
      return { item: a.hasAttribute('data-menu-item'), surface: a.closest('[data-surface]')?.getAttribute('data-surface'), style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset, color: cs.outlineColor };
    });
    check(`${tag}: the menu opens inside the scope`, row.surface === 'community', String(row.surface));
    check(`${tag}: the focused menu row wears a 2px focus line, inset`, row.item && row.style === 'solid' && row.width === '2px' && parseFloat(row.offset) < 0 && row.color === ring, JSON.stringify(row));
    const menu = page.locator('[role="menu"]');
    if (await menu.count()) await menu.screenshot({ path: `${out}/${tag}-menu-focus.png` });
    await page.keyboard.press('Escape');
    await context.close();
  }
}

// ------------------------------------------------- the press under reduced motion
for (const theme of ['light', 'dark']) {
  for (const reduced of [true, false]) {
    const { context, page, tag } = await open(browser, { theme, reduced, touch: false });
    for (const row of ['outline', 'gold', 'ghost', 'danger', 'secondary']) {
      const btn = page.locator(`[data-kit-row="${row}"] button:not([data-force]):not(:disabled):not([data-busy])`).first();
      await btn.scrollIntoViewIfNeeded();
      const b = await btn.boundingBox();
      await page.mouse.move(b.x + 6, b.y + 6);
      await page.mouse.down();
      await page.waitForTimeout(250);
      const held = await btn.evaluate((e) => ({ active: e.matches(':active'), opacity: getComputedStyle(e).opacity }));
      await btn.screenshot({ path: `${out}/${tag}${reduced ? '-reduce' : ''}-held-${row}.png` });
      await page.mouse.up();
      await page.mouse.move(1, 1);
      check(`${tag}${reduced ? ' reduced motion' : ''}: a held ${row} button keeps its full ink`, held.active && held.opacity === '1', JSON.stringify(held));
    }
    await context.close();
  }
}

await browser.close();
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
