#!/usr/bin/env node
/**
 * THE STORE SETTINGS SCREEN, IN A REAL BROWSER (review of the settings
 * screen, 2026-09-28).
 *
 * The real application (tests/browser/merchant-workspace-fixture.tsx — its
 * settings save answers with the store as kept and records what was sent),
 * at 360px in Arabic and 1280px in English:
 *
 *   - the seven store colours are one radio group, drawn from the storefront;
 *   - «حفظ» is off while nothing changed; an edit says «تغييرات غير محفوظة»
 *     and leaving asks first;
 *   - a social link that cannot be an address is marked on its row and
 *     NOTHING is sent; `instagram.com/x` is sent as https://instagram.com/x,
 *     and the form shows what the server kept;
 *   - «تم الحفظ» only while nothing has changed since;
 *   - a day can be «مغلق», with no times;
 *   - no horizontal overflow on a phone.
 *
 * Screenshots go to OUT_DIR (default /tmp/claude-0/shots/settings/).
 *
 * Run: serve the repo with vite (`npx vite --port 4191`), then
 *      PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright node scripts/e2e-store-settings.mjs
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WORKSPACE_URL || 'http://127.0.0.1:4191';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/settings';
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes += 1;
  else {
    failures.push(`${name} ${detail}`);
    console.log(`FAIL ${name} ${detail}`);
  }
}

const T = {
  ar: { tagline: 'وصف مختصر', unsaved: 'تغييرات غير محفوظة', saved: 'تم الحفظ', addLink: 'إضافة رابط', addDay: 'إضافة يوم', closed: 'مغلق' },
  en: { tagline: 'Tagline', unsaved: 'Unsaved changes', saved: 'Saved', addLink: 'Add link', addDay: 'Add a day', closed: 'Closed' },
};

const browser = await chromium.launch();
for (const [w, h, lang] of [
  [360, 780, 'ar'],
  [1280, 900, 'en'],
]) {
  const t = T[lang];
  const tag = `${w}-${lang}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 640, isMobile: w < 640, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${origin}/tests/browser/merchant-workspace.html?lang=${lang}&path=/merchant/store/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-store-settings]', { timeout: 20000 });

  const saveBar = page.locator('[data-settings-savebar]');
  const saveBtn = page.locator('[data-settings-save]');
  const sent = () => page.evaluate(() => (window.__apiBodies ?? []).filter((b) => b.path === '/api/merchant/store' && b.method === 'PATCH'));

  // The colours: one radio group of seven, the store's own checked.
  const radios = page.locator('[role="radiogroup"] [role="radio"]');
  check(`${tag} seven colours`, (await radios.count()) === 7, String(await radios.count()));
  check(`${tag} the store's colour is checked`, (await page.locator('[role="radio"][data-accent="olive"]').getAttribute('aria-checked')) === 'true');
  const radioHeights = await radios.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  check(`${tag} colour targets ≥ 44px`, radioHeights.every((hh) => hh >= 44), JSON.stringify(radioHeights));

  // Clean: nothing to save.
  check(`${tag} clean on open`, (await saveBar.getAttribute('data-dirty')) === 'false');
  check(`${tag} save is off while clean`, await saveBtn.isDisabled());

  // An edit: the bar says so, save turns on, leaving asks.
  await page.getByLabel(t.tagline, { exact: true }).fill('Prints that last');
  check(`${tag} dirty after an edit`, (await saveBar.getAttribute('data-dirty')) === 'true');
  check(`${tag} «unsaved» said`, (await saveBar.innerText()).includes(t.unsaved));
  check(`${tag} save is on`, !(await saveBtn.isDisabled()));
  const asks = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  check(`${tag} leaving with changes asks first`, asks);

  // A social link that cannot be an address: marked, nothing sent.
  await page.getByRole('button', { name: new RegExp(t.addLink) }).click();
  const row = page.locator('[data-social-row]').first();
  check(`${tag} a new row proposes Instagram`, (await row.locator('input').first().inputValue()) === 'Instagram');
  await row.locator('input').nth(1).fill('javascript:alert(1)');
  await saveBtn.click();
  await page.waitForTimeout(150);
  check(`${tag} the bad link is marked on its row`, (await row.locator('[aria-invalid="true"]').count()) === 1);
  check(`${tag} the refusal is said`, (await saveBar.locator('[role="alert"]').count()) === 1);
  check(`${tag} nothing was sent`, (await sent()).length === 0);

  // Typed as people type it: sent as an address; the form shows what was kept.
  await row.locator('input').nth(1).fill('instagram.com/ali3d');
  check(`${tag} the mark leaves as the link is fixed`, (await row.locator('[aria-invalid="true"]').count()) === 0);
  await saveBtn.click();
  await page.waitForFunction(() => (window.__apiBodies ?? []).some((b) => b.path === '/api/merchant/store' && b.method === 'PATCH'), null, { timeout: 5000 });
  const [body] = await sent();
  check(`${tag} the link travels as https://`, body?.body?.social_links?.Instagram === 'https://instagram.com/ali3d', JSON.stringify(body?.body?.social_links));
  check(`${tag} the tagline travels`, body?.body?.tagline === 'Prints that last');
  check(`${tag} «open» is not sent when it did not change`, body && !('open' in body.body));
  await page.waitForFunction(() => document.querySelector('[data-settings-savebar]')?.getAttribute('data-dirty') === 'false', null, { timeout: 5000 });
  check(`${tag} «saved» after the save`, (await saveBar.innerText()).includes(t.saved));
  check(`${tag} the row shows what was kept`, (await page.locator('[data-social-row] input').nth(1).inputValue()) === 'https://instagram.com/ali3d');

  // «Saved» does not outlive the next edit.
  await page.getByLabel(t.tagline, { exact: true }).fill('Prints that last!');
  check(`${tag} «saved» gone after a new edit`, !(await saveBar.innerText()).includes(t.saved));

  // A closed day: no times.
  await page.getByRole('button', { name: new RegExp(t.addDay) }).click();
  const day = page.locator('[data-hours-row]').last();
  check(`${tag} a new day has times`, (await day.locator('input[type="time"]').count()) === 2);
  await day.locator('[role="switch"]').click();
  check(`${tag} the day is closed`, (await day.locator('[data-hours-closed="true"]').count()) === 1);
  check(`${tag} a closed day has no times`, (await day.locator('input[type="time"]').count()) === 0);
  check(`${tag} «closed» is said`, (await day.innerText()).includes(t.closed));

  // The phone: nothing wider than the screen.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${tag} no horizontal overflow`, overflow <= 1, `${overflow}px`);

  await page.screenshot({ path: `${out}/settings-${tag}.png`, fullPage: true });
  check(`${tag} no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}
await browser.close();

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
