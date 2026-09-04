#!/usr/bin/env node
/**
 * EVERY ADMIN CONTROL MUST BE ON THE SCREEN.
 *
 * The owner reported that they could not edit or delete a section, a
 * sub-section or a brand. The API accepted all three — create, edit and delete
 * were verified end to end — and the buttons existed in the markup. They were
 * simply off the screen: every admin list sets a min-width wider than a tablet
 * held upright, the wrapper scrolls sideways, and because the admin is RTL the
 * LAST column is on the LEFT, so it is the row actions that leave the viewport
 * rather than the slug.
 *
 * Measured at 1024x1366 before the fix:
 *   المنتجات   scroller 766 over 938 —  90 controls off-screen
 *                («تعديل» x=-97, «حذف / أرشفة» x=-59, «المزيد» x=-135)
 *   التصنيفات  scroller 766 over 869 — edit x=2, delete x=-70
 *   المستخدمين scroller 724 over 900 — 100 controls off-screen
 *
 * A unit test cannot see this: the markup is correct and the handlers work.
 * Only a real layout at a real viewport shows it, which is why this probe
 * exists and why it asserts on EVERY tab rather than the one that was reported.
 *
 * Needs a running dev server and a Chromium binary:
 *   npm run build
 *   npx wrangler dev --port 8789
 *   node scripts/e2e-admin-reach.mjs
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire('/opt/node22/lib/node_modules/playwright/index.js');
const { chromium } = require('/opt/node22/lib/node_modules/playwright/index.js');
const BASE = 'http://127.0.0.1:8789';
const rnd = Math.random().toString(36).slice(2, 7);
const sql = (s) => execSync(`npx wrangler d1 execute levonis-db --local --command ${JSON.stringify(s)}`, { cwd: '/home/user/Levonis', stdio: 'pipe' });
const email = `at-${rnd}@test.local`, pass = 'adm-tabs-12345';
await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, username: `at${rnd}`, name: 'A', password: pass }) });
sql(`UPDATE users SET role='admin' WHERE email='${email}'`);
await new Promise(r => setTimeout(r, 900));
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass }) });
const pair = (login.headers.get('set-cookie') || '').split(';')[0];
const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await ctx.addCookies([{ name, value, domain: '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

let failures = 0;
const TABS = ['المنتجات', 'التصنيفات', 'الطلبات', 'المستخدمين'];
for (const label of TABS) {
  const clicked = await page.evaluate((l) => {
    const el = [...document.querySelectorAll('button, a')].find((e) => (e.textContent || '').trim() === l);
    if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true;
  }, label);
  if (!clicked) { console.log(`${label}: tab not found`); continue; }
  await page.waitForTimeout(2600);
  const info = await page.evaluate(() => {
    const out = [];
    for (const sc of document.querySelectorAll('.overflow-x-auto, .overflow-auto')) {
      if (sc.scrollWidth <= sc.clientWidth + 1) continue;
      // Any interactive control clipped outside the viewport?
      const lost = [...sc.querySelectorAll('button, a, input, select')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right < 4 || r.left > innerWidth - 4);
      }).map((el) => ({ label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24), x: Math.round(el.getBoundingClientRect().left) }));
      out.push({ clientW: sc.clientWidth, scrollW: sc.scrollWidth, lostCount: lost.length, lost: lost.slice(0, 5) });
    }
    return out;
  });
  if (!info.length) { console.log(`  ok   ${label}: no horizontally-overflowing table`); continue; }
  for (const s of info) {
    if (s.lostCount === 0) console.log(`  ok   ${label}: scroller ${s.clientW}/${s.scrollW}, every control reachable`);
    else {
      failures += s.lostCount;
      console.log(`  FAIL ${label}: scroller ${s.clientW}/${s.scrollW} — ${s.lostCount} control(s) off-screen ${JSON.stringify(s.lost)}`);
    }
  }
}
await b.close();
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} unreachable controls)`}`);
process.exit(failures === 0 ? 0 : 1);
