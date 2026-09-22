#!/usr/bin/env node
/**
 * THE PAGES STAY DARK WHEN THE PHONE IS SET TO LIGHT.
 *
 * «صفحة المحادثات + صفحة الحساب بال light mode حل المشكلة.»
 *
 * There is no light theme in this app — `html` is pinned `color-scheme: dark`
 * and `#0b0c0f`, and every shared component is tokenised for that one ground.
 * /chats and /profile were the only two pages written as a hand-rolled
 * light/dark PAIR, and Tailwind v4 with no config compiles `dark:` to
 * `@media (prefers-color-scheme: dark)`. On a phone set to LIGHT the dark half
 * evaporated: the two pages repainted themselves cream inside a black app,
 * with every shared component still painting dark on top of them.
 *
 * WHY THE BROWSER. A source test can prove no `dark:` class survives. Only a
 * render under an EMULATED light preference proves the page is dark for the
 * person holding the phone — and that emulation is the entire defect, so a
 * test that cannot set it cannot see the bug.
 *
 * Run: node scripts/e2e-light-mode.mjs   (a vite dev server on :4178)
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const base = process.env.LIGHT_TEST_URL || 'http://127.0.0.1:4178/tests/browser/light-mode.html';
const out = process.env.OUT_DIR || '/tmp/levonis-diagnostics/light-mode';
await mkdir(out, { recursive: true });

const notes = [];
let cases = 0;
const check = async (name, fn) => {
  cases += 1;
  await fn();
  notes.push(`ok   ${name}`);
  console.log(`ok   ${name}`);
};

/** sRGB relative luminance, 0 (black) .. 1 (white). */
const luminance = (rgb) => {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

async function run(scheme) {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-page="chats"]');
  await page.waitForTimeout(150);

  await check(`${scheme}: the page ground is dark, not cream`, async () => {
    const bg = await page.$eval('[data-page="chats"] > div', (el) => getComputedStyle(el).backgroundColor);
    const l = luminance(bg);
    assert.ok(
      l < 0.08,
      `the /chats ground is ${bg} (luminance ${l.toFixed(3)}) — a light page inside a black app is the defect`
    );
    notes.push(`     ${scheme}: ground ${bg}, luminance ${l.toFixed(3)}`);
  });

  await check(`${scheme}: the text on it is light, so it can be read`, async () => {
    const heading = await page.$('[data-page="chats"] h1');
    assert.ok(heading, 'the page still has its heading');
    const colour = await heading.evaluate((el) => getComputedStyle(el).color);
    const l = luminance(colour);
    assert.ok(l > 0.5, `the heading is ${colour} (luminance ${l.toFixed(3)}) — dark text on a dark ground`);
  });

  await check(`${scheme}: no large SURFACE on the page is light`, async () => {
    // The grey block in the owner's screenshot was a shared, tokenised
    // component landing on a page that had repainted itself cream, so it is
    // not enough for the ROOT to be dark: nothing drawn on it may be a light
    // GROUND either.
    //
    // Scoped to surfaces — anything over 6,000px², about a card — because a
    // gold CTA with black text is this site's primary button on every screen
    // and a brand accent is not the defect. The defect was pages and panels
    // painting cream.
    const light = await page.$$eval('[data-page="chats"] *', (els) =>
      els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            bg: getComputedStyle(el).backgroundColor,
            area: r.width * r.height,
            // A CONTROL IS NOT A GROUND. The site's primary button is gold
            // with black text on every screen; flagging it would be flagging
            // the brand, not the defect, which was pages and panels painting
            // cream underneath the content.
            control: /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.getAttribute('role') === 'button',
            cls: el.className?.toString?.() ?? '',
          };
        })
        .filter(({ bg, area, control }) => {
          if (control || area < 6000) return false;
          const m = bg.match(/\d+(\.\d+)?/g);
          if (!m) return false;
          const [r, g, b, a = '1'] = m.map(Number);
          if (a < 0.5) return false; // a wash over a dark ground stays dark
          return 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255) > 0.45;
        })
        .map(({ cls, bg }) => `${bg}  ${cls.slice(0, 80)}`)
    );
    assert.deepEqual(light, [], `light surfaces painted on a dark page:\n${light.join('\n')}`);
  });

  await page.screenshot({ path: `${out}/chats-${scheme}.png`, fullPage: true });
  await browser.close();
}

// LIGHT FIRST — it is the broken case, so it fails fastest.
await run('light');
await run('dark');

await writeFile(`${out}/proof.txt`, notes.join('\n') + '\n');
console.log(`\n${cases} checks passed. Screenshots and notes in ${out}`);
