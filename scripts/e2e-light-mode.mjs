#!/usr/bin/env node
/**
 * THE PAGE FOLLOWS THE APP'S THEME, NOT THE PHONE'S.
 *
 * «صفحة المحادثات + صفحة الحساب بال light mode حل المشكلة.»
 *
 * The original defect: /chats followed the OS (`dark:` compiles to
 * `@media (prefers-color-scheme: dark)`) inside an app that did not, so a
 * phone set to light painted a cream page inside a black app. The app now has
 * two themes chosen in Settings → «المظهر» and switched by `data-theme`
 * (src/index.css, THE TWO THEMES). This renders the page under all four
 * combinations of OS setting and chosen theme and proves the ground, the text
 * and every large surface follow the CHOSEN theme.
 *
 * WHY THE BROWSER. A source test can prove no `dark:` class survives. Only a
 * render under an EMULATED preference proves the page ignores it.
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

async function run(scheme, theme) {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  await page.goto(`${base}?theme=${theme}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-page="chats"]');
  await page.waitForTimeout(150);

  const dark = theme === 'dark';
  const tag = `OS ${scheme}, theme ${theme}`;
  await check(`${tag}: the page ground is the chosen theme's`, async () => {
    const bg = await page.$eval('[data-page="chats"] > div', (el) => {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    });
    const l = luminance(bg);
    assert.ok(
      dark ? l < 0.08 : l > 0.7,
      `the /chats ground is ${bg} (luminance ${l.toFixed(3)}) under ${tag} — it followed something other than the choice`
    );
    notes.push(`     ${tag}: ground ${bg}, luminance ${l.toFixed(3)}`);
  });

  await check(`${tag}: the text on it can be read`, async () => {
    const heading = await page.$('[data-page="chats"] h1');
    assert.ok(heading, 'the page still has its heading');
    const colour = await heading.evaluate((el) => {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = getComputedStyle(el).color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    });
    const l = luminance(colour);
    assert.ok(dark ? l > 0.5 : l < 0.05, `the heading is ${colour} (luminance ${l.toFixed(3)}) under ${tag}`);
  });

  await check(`${tag}: no large SURFACE belongs to the other theme`, async () => {
    // The grey block in the owner's screenshot was a shared, tokenised
    // component landing on a page that had repainted itself cream, so it is
    // not enough for the ROOT to be dark: nothing drawn on it may be a light
    // GROUND either.
    //
    // Scoped to surfaces — anything over 6,000px², about a card — because a
    // gold CTA with black text is this site's primary button on every screen
    // and a brand accent is not the defect. The defect was pages and panels
    // painting cream.
    const light = await page.$$eval('[data-page="chats"] *', (els, isDark) => {
      // Computed colours come back as oklab()/color-mix() for the tokens, so
      // each is painted on a 1px canvas and read back as sRGB.
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const toRgba = (c) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
      };
      return els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            bg: toRgba(getComputedStyle(el).backgroundColor),
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
          const l = 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
          return isDark ? l > 0.45 : l < 0.3;
        })
        .map(({ cls, bg }) => `${bg}  ${cls.slice(0, 80)}`);
    }, dark);
    assert.deepEqual(light, [], `surfaces of the other theme painted on the page (${tag}):\n${light.join('\n')}`);
  });

  await page.screenshot({ path: `${out}/chats-os-${scheme}-theme-${theme}.png`, fullPage: true });
  await browser.close();
}

// The OS disagreeing with the choice first — that is the original defect.
await run('light', 'dark');
await run('dark', 'light');
await run('light', 'light');
await run('dark', 'dark');

await writeFile(`${out}/proof.txt`, notes.join('\n') + '\n');
console.log(`\n${cases} checks passed. Screenshots and notes in ${out}`);
