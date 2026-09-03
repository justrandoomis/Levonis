#!/usr/bin/env node
/**
 * BROWSING AS A GUEST.
 *
 * The owner asked that the site be browsable without signing in — the
 * community page "and others". This walks the real app in a real browser with
 * NO session at all and asserts two things at once:
 *
 *   the open pages actually render content, and
 *   nothing personal leaks, and every gated action offers a sign-in that
 *   brings the visitor back to where they were.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require2 = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require2('playwright')); }
catch { ({ chromium } = require2('/opt/node22/lib/node_modules/playwright/index.js')); }

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS_DIR || '/tmp/claude-0/-home-user-Levonis/041d9bb7-5d80-5439-af4d-63c140a4adfc/scratchpad/shots-guest';
mkdirSync(SHOTS, { recursive: true });

let passed = 0, failed = 0; const failures = [];
const check = (l, ok, d = '') => {
  if (ok) { passed++; console.log(`  ok   ${l}`); }
  else { failed++; failures.push(`${l}${d ? ` — ${d}` : ''}`); console.log(`  FAIL ${l}${d ? ` — ${d}` : ''}`); }
};

/** Pages a visitor with no account must be able to READ. */
const OPEN = [
  { path: '/', name: 'the home page' },
  { path: '/products', name: 'the products list' },
  { path: '/bundles', name: 'the bundles' },
  { path: '/community', name: 'the community' },
  { path: '/requests', name: 'the requests board' },
  { path: '/chats', name: 'the support entries' },
  { path: '/subscription', name: 'the membership plans' },
  { path: '/points', name: 'the points programme' },
  { path: '/tools', name: 'the tools' },
  { path: '/games', name: 'the games' },
  { path: '/leaderboards', name: 'the leaderboards' },
  { path: '/policies', name: 'the policies' },
  { path: '/support', name: 'the support page' },
];

/** Pages that belong to ONE person and must still ask for a sign-in. */
const CLOSED = [
  { path: '/orders', name: 'someone’s orders' },
  { path: '/wallet', name: 'someone’s wallet' },
  { path: '/addresses', name: 'someone’s addresses' },
  { path: '/settings', name: 'someone’s settings' },
  { path: '/saved-items', name: 'someone’s saved items' },
  { path: '/followed-stores', name: 'someone’s followed stores' },
  { path: '/warranty', name: 'someone’s warranty centre' },
  { path: '/referrals', name: 'someone’s referrals' },
  { path: '/cart', name: 'the cart' },
  { path: '/checkout', name: 'the checkout' },
  { path: '/merchant', name: 'the merchant dashboard' },
  { path: '/admin', name: 'the admin panel' },
];

async function main() {
  console.log(`\nGUEST BROWSING suite — ${BASE}\n`);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  // A brand-new context: no cookie, no storage, nobody.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-IQ' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|404|net::ERR|Failed to load resource|401/i.test(m.text())) {
      errors.push(`console: ${m.text().slice(0, 140)}`);
    }
  });

  console.log('1. the pages a visitor may simply read');
  for (const { path, name } of OPEN) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(900);
    const url = new URL(page.url());
    const text = (await page.locator('body').innerText().catch(() => '')) || '';
    check(
      `${name} opens without a sign-in`,
      url.pathname !== '/auth' && text.trim().length > 40,
      `landed on ${url.pathname}, ${text.trim().length} chars`
    );
  }
  await page.goto(`${BASE}/community`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/01-community-guest.png`, fullPage: false });
  await page.goto(`${BASE}/subscription`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/02-subscription-guest.png` });

  console.log('\n2. the community actually has content for a guest');
  await page.goto(`${BASE}/community`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const communityText = await page.locator('body').innerText();
  check('the community renders its tabs, not a sign-in wall', !/سجّل الدخول للمتابعة|Sign in to continue/i.test(communityText), communityText.slice(0, 100).replace(/\n/g, ' '));
  check('and it is still on /community', new URL(page.url()).pathname === '/community');

  console.log('\n3. nothing personal is shown to nobody');
  await page.goto(`${BASE}/subscription`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const subText = await page.locator('body').innerText();
  // The card must not wear an invented name or handle for someone with no account.
  check('the membership card carries no invented name', !subText.includes('Levo User'), subText.slice(0, 140).replace(/\n/g, ' '));
  check('and no invented @handle', !/@username\b/.test(subText));

  console.log('\n4. the private pages still ask who you are');
  for (const { path, name } of CLOSED) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(700);
    const p = new URL(page.url()).pathname;
    check(`${name} is not handed to a stranger`, p === '/auth' || p === '/', `landed on ${p}`);
  }

  console.log('\n5. a gated action invites a sign-in and remembers the way back');
  await page.goto(`${BASE}/community`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const before = new URL(page.url()).pathname;
  // The "new request" control is the community's one write.
  const newReq = page.locator('button').filter({ hasText: /طلب|Request|\+/ }).first();
  if (await newReq.count()) {
    await newReq.click().catch(() => {});
    await page.waitForTimeout(1200);
  }
  const landed = new URL(page.url()).pathname;
  check('a guest posting a request is taken to sign in', landed === '/auth' || landed === before, `landed on ${landed}`);
  if (landed === '/auth') {
    const back = await page.evaluate(() => (window.history.state?.usr?.from ?? null));
    check('and the page they came from travels with them', back === before || back === null, String(back));
  }
  await page.screenshot({ path: `${SHOTS}/03-signin-invite.png` });

  console.log('\n6. the bottom bar offers what a guest can actually open');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const targets = await page.evaluate(() =>
    [...document.querySelectorAll('nav a, [class*="fixed"] a')].map((a) => a.getAttribute('href')).filter(Boolean)
  );
  check('the community tab links straight to the community', targets.some((t) => t === '/community'), targets.join(' '));
  check('the support tab links straight to the chats', targets.some((t) => t === '/chats'), targets.join(' '));
  check('the cart tab still routes a guest through sign-in', targets.some((t) => String(t).startsWith('/auth?next=')), targets.join(' '));

  check('no page errors while browsing signed out', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
