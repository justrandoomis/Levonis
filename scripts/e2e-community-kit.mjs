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
 *   - a held kit button keeps its full ink under reduced motion (no 0.72 dim);
 *   (round 4)
 *   - the tab underline is the label plus 24px, on the bottom edge of the tab,
 *     3px, inside its tab, at 390 and 1440 in English, Arabic and Sorani; it
 *     travels to the next tab (a transform in flight) and jumps under
 *     reduced motion;
 *   - every held kit control (link, tab, thumb, select, tile, row, drop zone,
 *     search opener, filter chip, switch, stepper key) keeps its full ink in
 *     both themes and both motion settings;
 *   - under forced colours the ON knob of the Toggle is Highlight, as the
 *     house switch draws it;
 *   - the portals carry the scope (src/components/community/scopePortals.ts):
 *     a sheet and the confirmation opened from it, a menu and the shell toast
 *     stack wear the pair and follow a theme switch; a window opened from the
 *     shell does not; the toast stack loses it when the community page goes.
 *   (round 5)
 *   - with the OTHER tab chosen, the underline still sits on the bottom edge
 *     of its tab and on the baseline of the strip when the first label wraps
 *     (en 390, ckb 320 and the rest of the matrix, both themes), and every
 *     frame of its travel runs along that baseline;
 *   - under forced colours the current ListRow, a current `.cm-sel` chip and
 *     a pressed filter chip wear the house Highlight line and outline (the
 *     row its start bar in Highlight too), the idle ones do not, and a focused
 *     one shows the 2px CanvasText focus line instead.
 *   (fix round 2)
 *   - under forced colours the underline of the chosen tab is Highlight, never
 *     the Canvas it was (the weight of the label was the only cue left), with
 *     the first and then the second tab chosen; the idle tab draws no line.
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

// ------------------------------------------------- the tab underline (round 4)
for (const [lang, width, height] of [['en', 390, 844], ['ar', 390, 844], ['ckb', 390, 844], ['en', 1440, 1000], ['ar', 1440, 1000], ['ckb', 320, 700]]) {
  for (const theme of ['dark', 'light']) {
    const { context, page, tag } = await open(browser, { theme, lang, width, height });
    const strip = page.locator('[data-kit="selection"] .cm-tabs');
    await strip.scrollIntoViewIfNeeded();
    const geo = await page.evaluate(() => {
      const tab = document.querySelector('[data-kit="selection"] .cm-tabs [data-tab-active]');
      const label = tab.querySelector('.cm-tab-label');
      const line = tab.querySelector('[data-tab-line]');
      const house = tab.querySelector('[data-tab-indicator]');
      if (!label || !line) return { line: null, houseDrawn: !!house && getComputedStyle(house).display !== 'none' };
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height };
      };
      // The label as drawn: its text and badge, without the line it holds.
      const text = [...label.childNodes].filter((n) => n !== line).map((n) => {
        const r = document.createRange();
        r.selectNodeContents(n);
        return r.getBoundingClientRect();
      });
      const lw = Math.max(...text.map((r) => r.right)) - Math.min(...text.map((r) => r.left));
      return { tab: box(tab), label: box(label), text: lw, line: line ? box(line) : null, houseDrawn: house ? getComputedStyle(house).display !== 'none' : false, color: line ? getComputedStyle(line).backgroundColor : '', gold: getComputedStyle(tab).color };
    });
    check(`${tag}: the active tab draws one underline (the house indicator is not drawn)`, !!geo.line && !geo.houseDrawn, JSON.stringify({ line: !!geo.line, house: geo.houseDrawn }));
    if (geo.line) {
      check(`${tag}: the underline is the label plus 24px`, Math.abs(geo.line.w - (geo.text + 24)) <= 0.75, `line ${geo.line.w.toFixed(1)} vs label ${geo.text.toFixed(1)} + 24, tab ${geo.tab.w.toFixed(1)}`);
      check(`${tag}: … centred on the label`, Math.abs(geo.line.l + geo.line.w / 2 - (geo.label.l + geo.label.w / 2)) <= 0.75, `${(geo.line.l + geo.line.w / 2).toFixed(1)} vs ${(geo.label.l + geo.label.w / 2).toFixed(1)}`);
      check(`${tag}: … 3px on the bottom edge of the tab`, Math.abs(geo.line.h - 3) <= 0.1 && Math.abs(geo.line.b - geo.tab.b) <= 0.5, JSON.stringify({ h: geo.line.h, lineBottom: geo.line.b, tabBottom: geo.tab.b }));
      check(`${tag}: … inside its tab`, geo.line.l >= geo.tab.l - 0.5 && geo.line.r <= geo.tab.r + 0.5, JSON.stringify({ line: [geo.line.l, geo.line.r], tab: [geo.tab.l, geo.tab.r] }));
      check(`${tag}: … in the gold of the label`, geo.color === geo.gold, `${geo.color} vs ${geo.gold}`);
    }
    await strip.screenshot({ path: `${out}/${tag}-tabs-underline.png` });

    // The OTHER tab chosen (round 5). When one label wraps, both tabs grow; a one-line label
    // centred in its tab left its line 10.7px above the baseline (en 390, en 320, ckb 320). The
    // label fills the height of its tab, so the line sits on the tab bottom and on the 1px
    // baseline of the strip, whichever tab is chosen.
    await page.locator('[data-kit="selection"] .cm-tabs [role="tab"][aria-selected="false"]').first().click();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(300);
    const second = await page.evaluate(() => {
      const bar = document.querySelector('[data-kit="selection"] .cm-tabs');
      const tab = bar.querySelector('[data-tab-active]');
      const line = tab.querySelector('[data-tab-line]');
      if (!line) return null;
      const lr = line.getBoundingClientRect();
      const tabs = [...bar.querySelectorAll('[data-tab]')].map((x) => x.getBoundingClientRect().height);
      return { lineBottom: lr.bottom, lineHeight: lr.height, tabBottom: tab.getBoundingClientRect().bottom, baseline: bar.getBoundingClientRect().bottom - parseFloat(getComputedStyle(bar).borderBottomWidth), tabs };
    });
    check(`${tag}: the second tab draws its underline`, !!second, 'no line under the chosen tab');
    if (second) {
      check(`${tag}: … on the bottom edge of the second tab`, Math.abs(second.lineBottom - second.tabBottom) <= 0.5, JSON.stringify(second));
      check(`${tag}: … and on the baseline of the strip`, Math.abs(second.lineBottom - second.baseline) <= 0.5 && Math.abs(second.lineHeight - 3) <= 0.1, JSON.stringify(second));
    }
    await strip.screenshot({ path: `${out}/${tag}-tabs-second.png` });
    await context.close();
  }
}

// The line travels (a transform in flight) and, under reduced motion, jumps.
for (const reduced of [false, true]) {
  const { context, page, tag } = await open(browser, { theme: 'dark', lang: 'en', reduced, touch: false });
  await page.locator('[data-kit="selection"] .cm-tabs').scrollIntoViewIfNeeded();
  // Where the line rests under a label: the start of its words less 12px.
  const where = () =>
    page.evaluate(() => {
      const line = document.querySelector('[data-kit="selection"] .cm-tabs [data-tab-line]');
      if (!line) return { left: NaN, home: 0 };
      const label = line.parentElement;
      const words = document.createRange();
      words.setStart(label, 0);
      words.setEnd(label, label.childNodes.length - 1);
      return { left: line.getBoundingClientRect().left, home: words.getBoundingClientRect().left - 12 };
    });
  const before = (await where()).left;
  await page.locator('[data-kit="selection"] .cm-tabs [role="tab"][aria-selected="false"]').first().click();
  await page.waitForTimeout(60);
  const mid = await where();
  await page.waitForTimeout(900);
  const after = await where();
  check(`${tag}${reduced ? ' reduced motion' : ''}: the underline settles under the chosen label`, Math.abs(after.left - after.home) <= 0.75, JSON.stringify(after));
  if (reduced) check(`${tag} reduced motion: the underline jumps (in place at once)`, Math.abs(mid.left - mid.home) <= 0.75, JSON.stringify(mid));
  else check(`${tag}: the underline travels from the old tab (in flight after 60ms)`, Math.abs(mid.left - mid.home) > 2 && Math.abs(mid.left - before) > 0.5, JSON.stringify({ before, ...mid }));
  await context.close();
}

// Every frame of the move runs ALONG the baseline (round 5). With a wrapped label in the strip the
// line under the one-line label sat higher, so it hopped up and down on its way (a translateY of
// 6.5px at en 390 and 7.6px at ckb 320 in flight).
for (const [lang, width, height] of [['en', 390, 844], ['ckb', 320, 700]]) {
  for (const theme of ['dark', 'light']) {
    const { context, page, tag } = await open(browser, { theme, lang, width, height, reduced: false, touch: false });
    await page.locator('[data-kit="selection"] .cm-tabs').scrollIntoViewIfNeeded();
    const flight = await page.evaluate(
      () =>
        new Promise((done) => {
          const bar = document.querySelector('[data-kit="selection"] .cm-tabs');
          const at = () => {
            const r = bar.querySelector('[data-tab-line]').getBoundingClientRect();
            return { left: r.left, off: r.bottom - (bar.getBoundingClientRect().bottom - parseFloat(getComputedStyle(bar).borderBottomWidth)) };
          };
          const frames = [at()];
          bar.querySelector('[role="tab"][aria-selected="false"]').click();
          const t0 = performance.now();
          const tick = () => {
            frames.push(at());
            if (performance.now() - t0 < 900) requestAnimationFrame(tick);
            else done(frames);
          };
          requestAnimationFrame(tick);
        })
    );
    const start = flight[0].left;
    const end = flight[flight.length - 1].left;
    const worst = Math.max(...flight.map((f) => Math.abs(f.off)));
    check(`${tag}: the underline travels to the other tab (frames in between)`, flight.some((f) => Math.abs(f.left - start) > 2 && Math.abs(f.left - end) > 2), JSON.stringify({ start, end, frames: flight.length }));
    check(`${tag}: … along the baseline, with no vertical move in any frame`, worst <= 0.5, `${worst.toFixed(2)}px off the baseline at worst, over ${flight.length} frames`);
    await context.close();
  }
}

// ------------------------------------------------- every held control at full ink (round 4)
const HELD = [
  ['the text link', '[data-kit] a.text-gold'],
  ['the chosen tab', '[data-kit="selection"] .cm-tabs [role="tab"][aria-selected="true"]'],
  ['an idle tab', '[data-kit="selection"] .cm-tabs [role="tab"][aria-selected="false"]'],
  ['a segmented option', '[data-segmented="kit-quality"] [role="radio"][aria-checked="false"]:not(:disabled):not([aria-disabled="true"])'],
  ['a select button', 'button[aria-haspopup="listbox"]:not(:disabled):not([data-force])'],
  ['a choice tile', '[data-choice]:not(:disabled):not([data-force])'],
  ['a list row', '.cm-row:has(.cm-sub)'],
  ['the drop zone', '.cm-drop-zone:not(:disabled)'],
  ['the search opener', 'button[aria-haspopup="dialog"].cm-raised'],
  ['a filter chip', '[data-filter-select] button[aria-haspopup]'],
  ['a switch', '[role="switch"]:not(:disabled)'],
  ['a stepper key', '.cm-stepper .lv-well > button:not(:disabled)'],
];
for (const theme of ['light', 'dark']) {
  for (const reduced of [false, true]) {
    const { context, page, tag } = await open(browser, { theme, lang: 'en', reduced, touch: false });
    for (const [name, sel] of HELD) {
      const el = page.locator(sel).first();
      if (!(await el.count())) {
        check(`${tag}: ${name} is in the fixture`, false, sel);
        continue;
      }
      await el.scrollIntoViewIfNeeded();
      const b = await el.boundingBox();
      await page.mouse.move(b.x + Math.min(10, b.width / 2), b.y + b.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(250);
      const held = await el.evaluate((e) => {
        const effective = (n) => {
          let o = 1;
          for (let x = n; x && x.nodeType === 1; x = x.parentElement) o *= parseFloat(getComputedStyle(x).opacity);
          return o;
        };
        // The deepest element that draws words: its own opacity and every ancestor multiply.
        const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        let ink = e;
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent.trim()) ink = n.parentElement;
        return { active: e.matches(':active'), control: effective(e), label: effective(ink) };
      });
      // Released away from it: no click, so no navigation, file chooser or toggle.
      await page.mouse.move(1, 1);
      await page.mouse.up();
      check(`${tag}${reduced ? ' reduced motion' : ''}: a held ${name} keeps its full ink`, held.active && held.control === 1 && held.label === 1, JSON.stringify(held));
    }
    await context.close();
  }
}

// ------------------------------------------------- the switch under forced colours (round 4)
for (const theme of ['dark', 'light']) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce', forcedColors: 'active' });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('levo_lang', 'ar');
      localStorage.setItem('levonis.theme.v1', t);
    } catch {
      /* the query string sets it */
    }
  }, theme);
  const page = await context.newPage();
  await page.goto(`${base}?theme=${theme}&lang=ar`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-kit-row="toggles"] [role="switch"]');
  await page.waitForTimeout(600);
  const knobs = await page.evaluate(() => {
    const probe = document.createElement('i');
    document.body.append(probe);
    probe.style.background = 'Highlight';
    const highlight = getComputedStyle(probe).backgroundColor;
    probe.style.background = 'Canvas';
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      highlight,
      canvas,
      on: [...document.querySelectorAll('[data-kit-row="toggles"] [role="switch"][aria-checked="true"] span:not(:has(span))')].map((k) => getComputedStyle(k).backgroundColor),
      off: [...document.querySelectorAll('[data-kit-row="toggles"] [role="switch"][aria-checked="false"] span:not(:has(span))')].map((k) => getComputedStyle(k).backgroundColor),
    };
  });
  check(`forced colours ${theme}: the ON knobs are drawn in Highlight`, knobs.on.length > 0 && knobs.on.every((c) => c === knobs.highlight), JSON.stringify(knobs));
  check(`forced colours ${theme}: no knob is the Canvas of its track`, [...knobs.on, ...knobs.off].every((c) => c !== knobs.canvas), JSON.stringify(knobs));
  await page.locator('[data-kit-row="toggles"]').screenshot({ path: `${out}/forced-${theme}-switches.png` });

  // The current ListRow and a current or chosen `.cm-sel` (round 5). Forced colours drop the
  // dimple, the well fill, the gold bar and the sand, so the current row read like every other
  // row and the current section chip (plan R3 SectionNav, «لك») like every idle one. The house
  // cue for a selection there: the line and a 1px outline in Highlight; the bar comes back in
  // Highlight; the focus stays the 2px house line in CanvasText.
  const cues = await page.evaluate(() => {
    const host = document.querySelector('[data-kit="cards"]');
    const nav = document.createElement('nav');
    nav.setAttribute('data-probe-nav', '');
    nav.className = 'mt-3 grid grid-cols-3 gap-2';
    nav.innerHTML = ['#a', '#b', '#c'].map((h, i) => `<a href="${h}"${i === 0 ? ' aria-current="page"' : ''} class="cm-raised cm-sel flex h-12 items-center justify-center rounded-md text-[14px] font-semibold">${['لك', 'المشاريع', 'المتاجر'][i]}</a>`).join('');
    host.append(nav);
    const probe = document.createElement('i');
    document.body.append(probe);
    probe.style.color = 'Highlight';
    const highlight = getComputedStyle(probe).color;
    probe.style.color = 'CanvasText';
    const text = getComputedStyle(probe).color;
    probe.remove();
    const look = (el) => {
      const cs = getComputedStyle(el);
      return { outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, border: cs.borderTopColor };
    };
    const rows = [...document.querySelectorAll('.cm-row')].map((r) => ({ current: r.getAttribute('aria-current') === 'page', bar: getComputedStyle(r, '::before').backgroundColor, ...look(r) }));
    const chips = [...nav.children].map((a) => ({ current: a.hasAttribute('aria-current'), ...look(a) }));
    const pressed = [...document.querySelectorAll('[data-kit-row="filters"] > button:has(.cm-sel):not(:disabled)')].map((b) => ({ on: b.getAttribute('aria-pressed') === 'true', ...look(b.querySelector('.cm-sel')) }));
    return { highlight, text, rows, chips, pressed };
  });
  const cue = `solid 1px ${cues.highlight}`;
  const currentRows = cues.rows.filter((r) => r.current);
  check(`forced colours ${theme}: the current ListRow wears the Highlight outline`, currentRows.length === 1 && currentRows[0].outline === cue, JSON.stringify(currentRows));
  check(`forced colours ${theme}: … and its start bar in Highlight`, currentRows.length === 1 && currentRows[0].bar === cues.highlight, JSON.stringify(currentRows));
  check(`forced colours ${theme}: … and no other row does`, cues.rows.filter((r) => !r.current).every((r) => !r.outline.startsWith('solid') && r.bar !== cues.highlight), JSON.stringify(cues.rows));
  const currentChip = cues.chips.find((c) => c.current);
  check(`forced colours ${theme}: the current .cm-sel chip wears the Highlight line and outline`, !!currentChip && currentChip.outline === cue && currentChip.border === cues.highlight, JSON.stringify(cues.chips));
  check(`forced colours ${theme}: … and the idle chips do not`, cues.chips.filter((c) => !c.current).every((c) => !c.outline.startsWith('solid') && c.border !== cues.highlight), JSON.stringify(cues.chips));
  check(`forced colours ${theme}: a pressed filter chip wears it, an unpressed one does not`, cues.pressed.some((p) => p.on) && cues.pressed.every((p) => (p.on ? p.outline === cue : !p.outline.startsWith('solid'))), JSON.stringify(cues.pressed));
  // A focused current row and a focused current chip show the focus line, not the selection line.
  await page.keyboard.press('Shift');
  for (const [name, sel] of [['the current row', '.cm-row[aria-current="page"]'], ['the current chip', '[data-probe-nav] [aria-current="page"]']]) {
    const focused = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.focus();
      const cs = getComputedStyle(el);
      return { fv: el.matches(':focus-visible'), outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}` };
    }, sel);
    check(`forced colours ${theme}: focused, ${name} draws the 2px focus line in CanvasText`, focused.fv && focused.outline === `solid 2px ${cues.text}`, JSON.stringify(focused));
  }
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator('.cm-row').first().locator('xpath=..').screenshot({ path: `${out}/forced-${theme}-rows.png` });
  await page.locator('[data-probe-nav]').screenshot({ path: `${out}/forced-${theme}-current-chip.png` });
  await page.locator('[data-kit-row="filters"]').screenshot({ path: `${out}/forced-${theme}-filters.png` });

  // The underline of the chosen tab (fix round 2). Forced colours turned its gold background into
  // Canvas, so the chosen tab differed from the idle one by its weight alone. It comes back in
  // Highlight, as the row bar does, whichever tab is chosen; the idle tab draws no line.
  for (const which of ['first', 'second']) {
    if (which === 'second') {
      await page.locator('[data-kit="selection"] .cm-tabs [role="tab"][aria-selected="false"]').first().click();
      await page.mouse.move(1, 1);
      await page.evaluate(() => document.activeElement?.blur());
      await page.waitForTimeout(300);
    }
    const tabs = await page.evaluate(() => {
      const probe = document.createElement('i');
      document.body.append(probe);
      probe.style.background = 'Highlight';
      const highlight = getComputedStyle(probe).backgroundColor;
      probe.style.background = 'Canvas';
      const canvas = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const all = [...document.querySelectorAll('[data-kit="selection"] .cm-tabs [role="tab"]')].map((t) => {
        const line = t.querySelector('[data-tab-line]');
        return { chosen: t.getAttribute('aria-selected') === 'true', line: line ? getComputedStyle(line).backgroundColor : null, height: line ? line.getBoundingClientRect().height : 0 };
      });
      return { highlight, canvas, all };
    });
    const chosen = tabs.all.filter((t) => t.chosen);
    check(`forced colours ${theme}: the underline of the chosen tab (the ${which}) is Highlight, not Canvas`, chosen.length === 1 && chosen[0].line === tabs.highlight && chosen[0].line !== tabs.canvas && chosen[0].height === 3, JSON.stringify(tabs));
    check(`forced colours ${theme}: … and the idle tab draws no line`, tabs.all.filter((t) => !t.chosen).every((t) => t.line === null), JSON.stringify(tabs));
    await page.locator('[data-kit="selection"] [role="tablist"]').screenshot({ path: `${out}/forced-${theme}-tabs-${which}.png` });
  }
  await context.close();
}

// ------------------------------------------------- the portals carry the scope (round 4)
for (const theme of ['dark', 'light']) {
  const other = theme === 'dark' ? 'light' : 'dark';
  const { context, page, errors, tag } = await open(browser, { theme, lang: 'ar', touch: false });
  const pair = (sel) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? { surface: el.getAttribute('data-surface'), theme: el.getAttribute('data-theme'), parent: el.parentElement === document.body } : null;
    }, sel);
  const is = (p, t) => !!p && p.parent && p.surface === 'community' && p.theme === t;
  // A sheet opened from inside the scope, and its colours: the scope raised fill, not the house one.
  await page.locator('[data-kit-open="sheet"]').click();
  await page.waitForSelector('[data-overlay="kit-sheet"] [data-overlay-panel]');
  await page.waitForTimeout(400);
  check(`${tag}: a sheet opened in the scope wears the pair`, is(await pair('[data-overlay="kit-sheet"]'), theme), JSON.stringify(await pair('[data-overlay="kit-sheet"]')));
  const paint = await page.evaluate(() => {
    const probe = document.createElement('i');
    document.querySelector('.cm-surface').append(probe);
    probe.style.background = 'var(--color-surface-raised)';
    const scope = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { scope, panel: getComputedStyle(document.querySelector('[data-overlay="kit-sheet"] [data-overlay-panel]')).backgroundColor };
  });
  check(`${tag}: … and paints in the scope tokens`, paint.panel === paint.scope, JSON.stringify(paint));
  // A confirmation opened from that sheet.
  await page.locator('[data-kit-open="confirm"]').click();
  await page.waitForSelector('[data-overlay="kit-confirm"] [data-overlay-panel]');
  check(`${tag}: a confirmation opened from the sheet wears the pair`, is(await pair('[data-overlay="kit-confirm"]'), theme), JSON.stringify(await pair('[data-overlay="kit-confirm"]')));
  await page.locator('[data-kit-close="confirm"]').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  // A menu (Anchored) opened by the keyboard.
  await page.locator('[data-filter-select] button[aria-haspopup]').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-anchored]');
  check(`${tag}: a menu opened in the scope wears the pair`, is(await pair('[data-anchored]'), theme), JSON.stringify(await pair('[data-anchored]')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  // The shell toast stack, mounted by the first toast.
  await page.locator('[data-kit-open="toast"]').click();
  await page.waitForSelector('[data-toaster]');
  await page.waitForTimeout(300);
  check(`${tag}: the shell toast stack wears the pair`, is(await pair('[data-toaster]'), theme), JSON.stringify(await pair('[data-toaster]')));
  // A theme switch: the root, the toast stack and a sheet open across it follow.
  await page.locator('[data-kit-open="sheet"]').click();
  await page.waitForSelector('[data-overlay="kit-sheet"] [data-overlay-panel]');
  await page.locator('[data-kit-shell="theme"]').evaluate((b) => b.click());
  await page.waitForTimeout(300);
  check(`${tag}: after a theme switch the scope root says ${other}`, (await pair('.cm-surface'))?.theme === other, JSON.stringify(await pair('.cm-surface')));
  check(`${tag}: … the toast stack follows`, is(await pair('[data-toaster]'), other), JSON.stringify(await pair('[data-toaster]')));
  check(`${tag}: … the open sheet follows`, is(await pair('[data-overlay="kit-sheet"]'), other), JSON.stringify(await pair('[data-overlay="kit-sheet"]')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  // A window opened from the shell keeps the house palette.
  // The shell buttons sit under the toast stack (the toast stays): pressed by script, as a click.
  await page.locator('[data-kit-shell="window"]').evaluate((b) => b.click());
  await page.waitForSelector('[data-overlay="kit-shell-window"] [data-overlay-panel]');
  const shell = await pair('[data-overlay="kit-shell-window"]');
  check(`${tag}: a window opened from the shell does not wear the scope`, !!shell && shell.surface === null && shell.theme === null, JSON.stringify(shell));
  await page.locator('[data-kit-close="shell"]').click();
  await page.waitForTimeout(600);
  // The community page goes: the toast stack drops the pair; it comes back: the stack wears it again.
  await page.locator('[data-kit-shell="page"]').evaluate((b) => b.click());
  await page.waitForTimeout(300);
  const gone = await pair('[data-toaster]');
  check(`${tag}: with no scope on screen the toast stack wears nothing`, !!gone && gone.surface === null && gone.theme === null, JSON.stringify(gone));
  await page.locator('[data-kit-shell="page"]').evaluate((b) => b.click());
  await page.waitForSelector('.cm-surface');
  await page.waitForTimeout(300);
  check(`${tag}: … and wears it again when the page is back`, is(await pair('[data-toaster]'), other), JSON.stringify(await pair('[data-toaster]')));
  check(`${tag}: no page errors around the portals`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

await browser.close();
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
