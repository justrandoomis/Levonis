#!/usr/bin/env node
/**
 * THE REQUEST PAGE, DRIVEN AND PHOTOGRAPHED — tests/browser/request.html
 * (src/pages/community/Request.tsx, Client 5c) through Playwright: the
 * customer comparing offers, the workshop composing one, a draft, a guest,
 * the accepted order from both sides, finished work, a draft request, and the
 * old `/requests?request=<id>` address — in Arabic and English at a phone
 * and a wide screen, Sorani once, dark and cream, reduced motion on the cream
 * pass.
 *
 * Checks, besides «no horizontal overflow» and «no page errors»:
 *   the sections come in the owner's order (header → status → files →
 *   details → discussion → offers → compare → chat → accepted → timeline →
 *   escrow → delivery → review);
 *   every offer card shows its TOTAL; a revised offer says «عرض معدّل» with
 *   the old price and opens its history;
 *   accepting sends `expected_total_iqd` + `offer_revision`, meets
 *   OFFER_CHANGED with the fresh terms and «حدّث», and the second press sends
 *   the fresh total;
 *   the workshop's composer has «احفظ مسودة» and «أرسل العرض», previews the
 *   total, and sends `draft: true` only for the draft;
 *   the discussion offers each role its own kinds — the customer «أجب» on an
 *   unanswered question, the workshop «سؤال للعميل», a guest the sign-in line;
 *   the old address lands on /requests/req_1 with its hash.
 *
 *   (vite already on :4191)   node scripts/e2e-request.mjs
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.REQUEST_URL || 'http://127.0.0.1:4191/tests/browser/request.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/request';
await mkdir(out, { recursive: true });

const ORDER = ['header', 'status', 'files', 'details', 'discussion', 'offers', 'compare', 'chat', 'accepted', 'timeline', 'escrow', 'delivery', 'review'];

const failures = [];
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes += 1;
  else failures.push(`${name} ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : detail}`);
};

const SCENES = [
  { viewer: 'customer', mark: '[data-offer-compare]', expect: ['header', 'status', 'files', 'details', 'discussion', 'offers', 'compare'] },
  { viewer: 'merchant', mark: '[data-offer-make]', expect: ['header', 'status', 'files', 'details', 'discussion', 'offers'] },
  { viewer: 'merchant-draft', mark: '[data-merchant-offer="draft"]', expect: ['header', 'status', 'files', 'details', 'discussion', 'offers'] },
  { viewer: 'guest', mark: '[data-request-onlooker]', expect: ['header', 'status', 'files', 'details', 'discussion', 'offers'] },
  { viewer: 'customer-accepted', mark: '[data-request-timeline-peek]', expect: ['header', 'status', 'files', 'details', 'discussion', 'offers', 'chat', 'accepted', 'timeline', 'escrow', 'delivery'] },
  { viewer: 'merchant-accepted', mark: '[data-request-receivable]', expect: ['header', 'status', 'files', 'details', 'discussion', 'chat', 'accepted', 'timeline', 'escrow', 'delivery'] },
  { viewer: 'customer-completed', mark: '[data-request-section="review"]', expect: ['header', 'status', 'files', 'details', 'discussion', 'offers', 'chat', 'accepted', 'timeline', 'escrow', 'delivery', 'review'] },
  { viewer: 'owner-draft', mark: '[data-requests="draft"]', expect: ['header', 'status', 'files', 'details'] },
];

const lab = (page) => page.evaluate(() => window.__lab);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function sectionsOf(page) {
  return page.$$eval('[data-request-section]', (els) => els.map((e) => e.getAttribute('data-request-section')));
}

/** The customer: the offers, the history, the acceptance with OFFER_CHANGED, the answer to a question. */
async function customerFlow(page, tag, shot) {
  const cards = await page.locator('[data-offer-columns] [data-offer]').count();
  check(`${tag} three offer cards`, cards === 3, `cards=${cards}`);
  const totals = await page.locator('[data-offer-columns] [data-offer-total]').count();
  check(`${tag} every card shows its total`, totals === 3, `totals=${totals}`);
  check(`${tag} the fee is in the total (20,000 on the card with a 2,000 fee)`, (await page.locator('[data-offer="off_1"] [data-offer-total]').getAttribute('data-offer-total')) === '20000');
  check(`${tag} a revised offer says so, with the old price`, (await page.locator('[data-offer="off_1"] [data-offer-edited]').count()) === 1 && (await page.locator('[data-offer="off_1"] [data-offer-was]').count()) === 1);
  check(`${tag} the stale offer cannot be accepted`, (await page.locator('[data-offer-accept="off_3"]').count()) === 0);
  // the history
  await page.locator('[data-offer-history="off_1"]').click();
  const hist = await page.waitForSelector('[data-offer-history-list]', { timeout: 5000 }).then(() => true).catch(() => false);
  check(`${tag} the history opens`, hist);
  if (hist) {
    const rows = await page.locator('[data-offer-history-row]').count();
    check(`${tag} with both versions`, rows === 2, `rows=${rows}`);
    await page.screenshot({ path: `${out}/history-${shot}.png` });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  // the discussion, by role
  check(`${tag} a system row is inline`, (await page.locator('[data-comment-kind="system_update"]').count()) === 1);
  check(`${tag} «أجب» on the unanswered question only`, (await page.locator('[data-comment-answer]').count()) === 1 && (await page.locator('[data-comment-answer="q2"]').count()) === 1);
  check(`${tag} the customer is not offered «سؤال للعميل»`, (await page.locator('[data-discussion-pick]').count()) === 0);
  await page.locator('[data-comment-answer="q2"]').click();
  await page.waitForTimeout(200);
  check(`${tag} the composer is aimed at the question`, (await page.locator('[data-discussion-target="customer_answer"]').count()) === 1);
  await page.locator('[data-discussion-input]').fill('نعم، مثله تمامًا.');
  await page.locator('[data-discussion-send]').click();
  await page.waitForTimeout(500);
  let l = await lab(page);
  const sent = l.commentBodies[l.commentBodies.length - 1] ?? {};
  check(`${tag} the answer goes as customer_answer under q2`, sent.kind === 'customer_answer' && sent.parent_id === 'q2', JSON.stringify(sent));
  // the acceptance: OFFER_CHANGED, «حدّث», then the fresh total
  await page.locator('[data-offer-accept="off_1"]').scrollIntoViewIfNeeded();
  await page.locator('[data-offer-accept="off_1"]').click();
  const sheet = await page.waitForSelector('[data-accept-sheet]', { timeout: 5000 }).then(() => true).catch(() => false);
  check(`${tag} the acceptance sheet opens`, sheet);
  if (!sheet) return;
  await page.waitForTimeout(400);
  check(`${tag} it names the total`, (await page.locator('[data-accept-total]').getAttribute('data-accept-total')) === '20000');
  await page.screenshot({ path: `${out}/accept-${shot}.png` });
  await page.locator('[data-accept-confirm]').click();
  const changed = await page.waitForSelector('[data-accept="changed"]', { timeout: 5000 }).then(() => true).catch(() => false);
  check(`${tag} OFFER_CHANGED is said, with «حدّث»`, changed && (await page.locator('[data-accept-refresh]').count()) === 1);
  check(`${tag} the fresh total is on screen`, (await page.locator('[data-accept-total]').getAttribute('data-accept-total')) === '20500');
  await page.screenshot({ path: `${out}/accept-changed-${shot}.png` });
  await page.locator('[data-accept-confirm]').click();
  await page.waitForTimeout(700);
  l = await lab(page);
  const [first, second] = l.acceptBodies;
  check(`${tag} the first press sent the total and revision on screen`, first?.expected_total_iqd === 20000 && first?.offer_revision === 2 && first?.address_id === 'a1', JSON.stringify(first));
  check(`${tag} the second press sent the fresh total`, second?.expected_total_iqd === 20500 && second?.offer_revision === 3, JSON.stringify(second));
  check(`${tag} never a price field`, !l.acceptBodies.some((b) => 'expected_price_iqd' in b));
}

/** The workshop: the composer's two exits and its total preview; «سؤال للعميل» in the discussion. */
async function merchantFlow(page, tag, shot) {
  check(`${tag} the workshop's verdict card is there`, (await page.locator('[data-request-section="offers"] [data-workshop-card], [data-request-section="offers"] section, [data-request-section="offers"] div').count()) > 0);
  check(`${tag} the discussion offers «سؤال للعميل»`, (await page.locator('[data-discussion-pick="merchant_question"]').count()) === 1);
  await page.locator('[data-discussion-pick="merchant_question"]').click();
  await page.locator('[data-discussion-input]').fill('هل الغطاء من السيليكون؟');
  await page.locator('[data-discussion-send]').click();
  await page.waitForTimeout(500);
  let l = await lab(page);
  check(`${tag} the question goes as merchant_question`, l.commentBodies[l.commentBodies.length - 1]?.kind === 'merchant_question', JSON.stringify(l.commentBodies));

  await page.locator('[data-offer-make]').click();
  const composer = await page.waitForSelector('[data-offer-composer="new"]', { timeout: 5000 }).then(() => true).catch(() => false);
  check(`${tag} the composer opens`, composer);
  if (!composer) return;
  check(`${tag} «احفظ مسودة» and «أرسل العرض»`, (await page.locator('[data-offer-save-draft]').count()) === 1 && (await page.locator('[data-offer-send]').count()) === 1);
  await page.locator('[data-offer-price]').fill('18000');
  await page.locator('[data-offer-days]').fill('3');
  await page.locator('[data-offer-fee]').fill('2000');
  await page.waitForTimeout(300);
  check(`${tag} the total preview is price + fee`, (await page.locator('[data-offer-total-preview]').getAttribute('data-offer-total-preview')) === '20000');
  await page.screenshot({ path: `${out}/composer-${shot}.png` });
  await page.locator('[data-offer-save-draft]').click();
  await page.waitForTimeout(700);
  l = await lab(page);
  check(`${tag} «احفظ مسودة» sends draft: true`, l.offerBodies[0]?.draft === true && l.offerBodies[0]?.price_iqd === 18000, JSON.stringify(l.offerBodies[0]));
  // again, and send it
  await page.locator('[data-offer-make]').click();
  await page.waitForSelector('[data-offer-composer="new"]', { timeout: 5000 }).catch(() => {});
  await page.locator('[data-offer-price]').fill('18000');
  await page.locator('[data-offer-days]').fill('3');
  await page.locator('[data-offer-fee]').fill('2000');
  await page.locator('[data-offer-send]').click();
  await page.waitForTimeout(700);
  l = await lab(page);
  const live = l.offerBodies[1] ?? {};
  check(`${tag} «أرسل العرض» sends no draft flag, the fee and the days`, !('draft' in live) && live.delivery_fee_iqd === 2000 && live.completion_days === 3 && live.valid_days === 7, JSON.stringify(live));
}

async function draftFlow(page, tag, shot) {
  check(`${tag} the draft says the customer cannot see it`, (await page.locator('[data-offer-draft-send]').count()) === 1 && (await page.locator('[data-offer-draft-continue]').count()) === 1);
  check(`${tag} the draft shows its total`, (await page.locator('[data-merchant-offer="draft"] [data-offer-total]').getAttribute('data-offer-total')) === '20500');
  await page.locator('[data-offer-draft-continue]').click();
  const composer = await page.waitForSelector('[data-offer-composer="draft"]', { timeout: 5000 }).then(() => true).catch(() => false);
  check(`${tag} «أكمل المسودة» opens the composer on the draft`, composer);
  if (composer) {
    await page.waitForTimeout(300);
    check(`${tag} with its file`, (await page.locator('[data-offer-files] [data-offer-file]').count()) === 1);
    await page.screenshot({ path: `${out}/composer-draft-${shot}.png` });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await page.locator('[data-offer-draft-send]').click();
  await page.waitForTimeout(600);
  check(`${tag} «أرسل العرض» on the card sends the draft`, (await lab(page)).sends === 1);
}

async function acceptedFlow(page, tag, shot, viewer) {
  check(`${tag} «آخر تحديث» names the newest event`, (await page.locator('[data-request-last-event="photo"]').count()) === 1);
  check(`${tag} the money line says held`, (await page.locator('[data-request-escrow="held"]').count()) === 1);
  if (viewer === 'customer-accepted') {
    check(`${tag} the other offers are folded`, (await page.locator('[data-request-other-offers]').count()) === 1);
    check(`${tag} the chat door names the merchant`, (await page.locator('[data-request-chat="merchant"]').count()) === 1);
    check(`${tag} the store's phone`, (await page.locator('[data-order-contact-role="customer"] [data-order-contact-phone]').count()) === 1);
  } else {
    check(`${tag} the workshop reads what it receives`, (await page.locator('[data-request-receivable]').count()) === 1);
    check(`${tag} the customer's address`, (await page.locator('[data-order-contact-role="merchant"]').innerText()).includes('12'));
  }
  const html = await page.content();
  check(`${tag} no file key on the page`, !/merchants\/u_ali\/offers|community-orders\//.test(html.replace(/data-[a-z-]+="[^"]*"/g, '')));
  await page.locator('[data-request-timeline-door]').click();
  const sheet = await page.waitForSelector('[data-request-timeline-sheet]', { timeout: 6000 }).then(() => true).catch(() => false);
  check(`${tag} the door opens the order's timeline`, sheet);
  if (sheet) {
    const spine = await page.waitForSelector('[data-request-timeline-sheet] [data-order-timeline-root], [data-request-timeline-sheet] [data-order-timeline]', { timeout: 8000 }).then(() => true).catch(() => false);
    check(`${tag} with Client 5d's timeline inside`, spine);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/timeline-${shot}.png` });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}

const browser = await chromium.launch();
for (const lang of ['ar', 'en', 'ckb']) {
  for (const theme of ['dark', 'light']) {
    for (const width of [360, 1280]) {
      if (lang === 'ckb' && (theme === 'light' || width === 1280)) continue; // Sorani: one representative pass
      if (lang === 'en' && theme === 'light' && width === 1280) continue;
      const phone = width < 640;
      const context = await browser.newContext({
        viewport: { width, height: phone ? 800 : 900 },
        deviceScaleFactor: 2,
        locale: lang === 'en' ? 'en-US' : 'ar-IQ',
        colorScheme: theme,
        hasTouch: phone,
        isMobile: phone,
        // The cream pass doubles as the reduced-motion pass.
        reducedMotion: theme === 'light' ? 'reduce' : 'no-preference',
      });
      const tag = `${lang}-${theme}-${width}`;
      const errors = [];
      for (const s of SCENES) {
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(`${s.viewer}: ${e.message}`));
        await page.goto(`${base}?lang=${lang}&theme=${theme}&viewer=${s.viewer}`, { waitUntil: 'networkidle' });
        const found = await page.waitForSelector(s.mark, { timeout: 8000, state: 'attached' }).then(() => true).catch(() => false);
        await page.waitForTimeout(500);
        const t = `${tag} ${s.viewer}:`;
        check(`${t} ${s.mark} present`, found);
        const got = await sectionsOf(page);
        check(`${t} the sections, in the owner's order`, JSON.stringify(got) === JSON.stringify(s.expect), `got=${got.join(',')}`);
        check(`${t} the order is the owner's`, got.every((x, i) => i === 0 || ORDER.indexOf(x) > ORDER.indexOf(got[i - 1])));
        check(`${t} no horizontal overflow`, (await overflow(page)) <= 0, `overflow=${await overflow(page)}`);
        await page.screenshot({ path: `${out}/${s.viewer}-${tag}.png`, fullPage: true });
        const shot = `${s.viewer}-${tag}`;
        if (found && s.viewer === 'customer') await customerFlow(page, t, shot);
        if (found && s.viewer === 'merchant') await merchantFlow(page, t, shot);
        if (found && s.viewer === 'merchant-draft') await draftFlow(page, t, shot);
        if (found && s.viewer === 'guest') {
          check(`${t} a guest is asked to sign in to join the discussion`, (await page.locator('[data-discussion-signin]').count()) === 1);
          check(`${t} and has no composer`, (await page.locator('[data-discussion-composer]').count()) === 0);
        }
        if (found && (s.viewer === 'customer-accepted' || s.viewer === 'merchant-accepted')) await acceptedFlow(page, t, shot, s.viewer);
        if (found && s.viewer === 'customer-completed') check(`${t} the rating card is there`, (await page.locator('[data-request-section="review"] [role="radiogroup"], [data-request-section="review"] button').count()) > 0);
        if (found && s.viewer === 'owner-draft') {
          check(`${t} a draft publishes, continues or is discarded`, (await page.locator('[data-requests="publish-draft"]').count()) === 1 && (await page.locator('[data-requests="continue-draft"]').count()) === 1 && (await page.locator('[data-requests="discard-draft"]').count()) === 1);
        }
        check(`${t} no horizontal overflow after the flow`, (await overflow(page)) <= 0);
        await page.close();
      }
      // THE OLD ADDRESS: /requests?request=req_1#discussion → /requests/req_1#discussion
      if (lang === 'ar' && theme === 'dark') {
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(`legacy: ${e.message}`));
        await page.goto(`${base}?lang=${lang}&theme=${theme}&viewer=merchant&route=legacy`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[data-request-section="header"]', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(400);
        const at = await page.locator('[data-location]').getAttribute('data-location');
        check(`${tag} the old ?request= address is replaced by /requests/req_1 with its hash`, at === '/requests/req_1#discussion', `at=${at}`);
        // Review 2026-09-30: the hash used to land ~370 px short — the sections above were still growing. It lands ON the
        // section once the page settles (or at the page's end, when the section cannot reach the top).
        await page.waitForTimeout(1500);
        const land = await page.evaluate(() => {
          const el = document.getElementById('discussion');
          const end = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
          return { top: el ? Math.round(el.getBoundingClientRect().top) : null, end };
        });
        check(`${tag} #discussion lands on its section`, land.top !== null && ((land.top >= -4 && land.top <= 160) || land.end), JSON.stringify(land));
        await page.close();
      }
      check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
      await context.close();
    }
  }
}
await browser.close();
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
