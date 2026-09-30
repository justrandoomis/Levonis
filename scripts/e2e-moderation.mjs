#!/usr/bin/env node
/**
 * MODERATION V2, REPUTATION V2 AND DISPUTE EVIDENCE, PHOTOGRAPHED
 * (docs/COMMUNITY_ECOSYSTEM.md §9.6, Client 6a) — tests/browser/moderation.html
 * through Playwright, at 360 and 1280, in Arabic and English (and Sorani once,
 * reduced motion), dark (and cream once):
 *
 *   desk        every kind a report names is drawn; the ladder closes the steps
 *               lighter than the sanction in force; «حظر» asks the reason,
 *               then the ConfirmDialog naming the account, and only «yes»
 *               sends — with the report it answers; hiding a comment; a
 *               restriction's end (a «date» with no day is asked again, never
 *               sent as «no end»); the history sheet; «المزيد» (a staff account
 *               has no ladder, a gone
 *               target says so); the filters; the appeals — accepted once
 *   disputes    a case → «المحادثة» (/admin/chats/<id>, a new tab) and «الطلب»
 *   evidence    the chat read-only for staff: the banner, «كل قراءة مسجَّلة»,
 *               no composer, no card action; a refused read says why
 *   page        «حالة حسابي»: the banner per standing, the notice's decision
 *               marked, an appeal filed ONCE (the door becomes its state)
 *   badges      /community/badges#key: five rules, the one asked for marked
 *   storefront  the hero's chips in the island's ink, «لماذا؟» inside the island
 *   creator     the maker's store's chips; the popover's way to the page
 *   reputation  «سمعتك»: the evidence, what is missing, the windows
 *
 * Every scene: no horizontal overflow, no page error.
 *
 *   npx vite --port 4191 &   node scripts/e2e-moderation.mjs
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.MODERATION_URL || 'http://127.0.0.1:4191/tests/browser/moderation.html';
const out = process.env.OUT_DIR || '/tmp/claude-0/shots/moderation';
await mkdir(out, { recursive: true });

const failures = [];
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes += 1;
  else failures.push(`${name} ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : detail}`);
};

/** The words each language uses for what the checks press and read. */
const W = {
  ar: { ban: 'حظر', restrict: 'تقييد', confirmBan: 'حظر حساب Omar 3D؟', cont: 'متابعة', hide: 'إخفاء', history: 'السجل', more: 'المزيد', appeals: 'الاعتراضات', accept: 'قبول', evidence: 'قراءة فقط — مراقبة نزاع', recorded: 'كل قراءة مسجَّلة', conversation: 'المحادثة', request: 'الطلب', appeal: 'اعتراض', underReview: 'اعتراضك قيد المراجعة', why: 'لماذا؟', all: 'الكل' },
  en: { ban: 'Ban', restrict: 'Restrict', confirmBan: 'Ban Omar 3D’s account?', cont: 'Continue', hide: 'Hide', history: 'History', more: 'Load more', appeals: 'Appeals', accept: 'Accept', evidence: 'Read-only — dispute review', recorded: 'Every read is recorded', conversation: 'Conversation', request: 'Request', appeal: 'Appeal', underReview: 'Your appeal is being reviewed', why: 'Why?', all: 'All' },
  ckb: { ban: 'قەدەغەکردن', restrict: 'سنووردارکردن', confirmBan: 'قەدەغەکردنی هەژماری Omar 3D؟', cont: 'بەردەوامبوون', hide: 'شاردنەوە', history: 'مێژوو', more: 'زیاتر', appeals: 'ناڕەزاییەکان', accept: 'پەسەندکردن', evidence: 'تەنها خوێندنەوە — چاودێریی ناکۆکی', recorded: 'هەموو خوێندنەوەیەک تۆمار دەکرێت', conversation: 'گفتوگۆ', request: 'داواکاری', appeal: 'ناڕەزایی', underReview: 'ناڕەزاییەکەت لە پێداچوونەوەدایە', why: 'بۆچی؟', all: 'هەموو' },
};

const browser = await chromium.launch();
const passesPlan = [
  { lang: 'ar', theme: 'dark', width: 360 },
  { lang: 'ar', theme: 'dark', width: 1280 },
  { lang: 'en', theme: 'dark', width: 360 },
  { lang: 'en', theme: 'dark', width: 1280 },
  { lang: 'ar', theme: 'light', width: 360 },
  // Sorani: one representative pass, which is also the reduced-motion pass.
  { lang: 'ckb', theme: 'dark', width: 360, reduced: true },
];

for (const { lang, theme, width, reduced } of passesPlan) {
  const phone = width < 640;
  const w = W[lang];
  const context = await browser.newContext({
    viewport: { width, height: phone ? 800 : 900 },
    deviceScaleFactor: 2,
    locale: lang === 'en' ? 'en-US' : 'ar-IQ',
    colorScheme: theme,
    hasTouch: phone,
    isMobile: phone,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const tag = `${lang}-${theme}-${width}${reduced ? '-reduced' : ''}`;
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const open = async (scene, extra = '') => {
    await page.goto(`${base}?scene=${scene}&lang=${lang}&theme=${theme}${extra}`, { waitUntil: 'networkidle' });
  };
  const writes = () => page.evaluate(() => window.__writes ?? []);
  const shot = (name, full = false) => page.screenshot({ path: `${out}/${name}-${tag}.png`, fullPage: full });
  const light = theme === 'light';
  /** Segmented options whose name the control had to cut (an ellipsis): none, in every language. */
  const cutSegments = () => page.evaluate(() => [...document.querySelectorAll('[role="radiogroup"] span.truncate')].filter((el) => el.scrollWidth > el.clientWidth + 0.5).map((el) => el.textContent));

  // ------------------------------------------------------------ the desk
  await open('desk');
  const desk = await page.waitForSelector('[data-moderation-desk] [data-report]', { timeout: 10000 }).then(() => true).catch(() => false);
  check(`${tag} desk: the queue draws`, desk);
  if (desk) {
    const kinds = await page.locator('[data-report]').evaluateAll((els) => els.map((e) => e.getAttribute('data-report-kind')));
    check(`${tag} desk: every kind a report names is drawn`, ['post', 'comment', 'request_comment', 'order_update', 'user', 'store', 'product', 'request'].every((k) => kinds.includes(k)), kinds.join(','));
    check(`${tag} desk: a page at a time`, kinds.length === 8, String(kinds.length));
    check(`${tag} desk: the reporter count on each row`, (await page.locator('[data-report-count]').count()) === 8);
    check(`${tag} desk: no horizontal overflow`, (await overflow()) <= 0, String(await overflow()));
    check(`${tag} desk: no option's name is cut`, (await cutSegments()).length === 0, JSON.stringify(await cutSegments()));
    await shot('desk', true);
    if (!light) {
      // THE LADDER on the post's author (suspended): «تقييد» is closed with the reason.
      const post = page.locator('[data-report-kind="post"]').first();
      await post.locator('[data-report-ladder]').click();
      const menu = await page.waitForSelector('[role="menu"], [data-overlay="menu-sheet"]', { timeout: 5000 }).then(() => true).catch(() => false);
      check(`${tag} desk: the ladder opens`, menu);
      const restrict = page.getByRole('menuitem', { name: new RegExp(w.restrict) }).first();
      check(`${tag} desk: a step lighter than the sanction in force is closed`, (await restrict.getAttribute('aria-disabled')) === 'true' || (await restrict.isDisabled().catch(() => false)));
      await page.waitForTimeout(250);
      await shot('desk-ladder');
      await page.getByRole('menuitem', { name: new RegExp(`^${w.ban}`) }).first().click();
      const sheet = await page.waitForSelector('[data-overlay="moderation-decision"] [data-decision-form]', { timeout: 5000 }).then(() => true).catch(() => false);
      check(`${tag} desk: «${w.ban}» asks the reason first`, sheet);
      const before = (await writes()).length;
      // Too short: refused in the sheet, nothing asked, nothing sent.
      await page.locator('[data-decision-reason]').fill('x');
      await page.locator('[data-decision-submit]').click();
      await page.waitForTimeout(250);
      check(`${tag} desk: a reason under 3 characters is refused in place`, (await page.locator('[data-overlay="moderation-decision"] .lv-field-error').count()) === 1 && (await page.locator('[data-overlay="confirm-dialog"]').count()) === 0);
      await page.locator('[data-decision-reason]').fill('احتيال متكرر على المشترين');
      await page.waitForTimeout(250);
      await shot('desk-decision');
      await page.locator('[data-decision-submit]').click();
      const confirm = await page.waitForSelector('[data-overlay="confirm-dialog"]', { timeout: 5000 }).then(() => true).catch(() => false);
      check(`${tag} desk: then the ConfirmDialog naming the account`, confirm && (await page.locator('[data-overlay="confirm-dialog"]').innerText()).includes(w.confirmBan));
      check(`${tag} desk: nothing sent before «yes»`, (await writes()).length === before);
      await page.waitForTimeout(350);
      await shot('desk-confirm');
      await page.locator('[data-overlay="confirm-dialog"] [data-confirm-action]').click();
      await page.waitForSelector('[data-overlay="moderation-decision"]', { state: 'detached', timeout: 5000 }).catch(() => null);
      const sent = (await writes()).slice(before);
      check(`${tag} desk: «yes» sends the ban with its report`, sent.length === 1 && sent[0].path === '/api/admin/moderation/users/u_omar/status' && sent[0].body?.status === 'ban' && sent[0].body?.report_id === 'rep_1', JSON.stringify(sent));
      // HIDING a comment: the sheet is the confirmation.
      await page.waitForSelector('[data-report-kind="comment"] [data-report-hide="hide"]', { timeout: 5000 }).catch(() => null);
      await page.locator('[data-report-kind="comment"] [data-report-hide="hide"]').first().click();
      await page.waitForSelector('[data-overlay="moderation-decision"] [data-decision-form]', { timeout: 5000 }).catch(() => null);
      await page.locator('[data-decision-reason]').fill('إساءة لشخص باسمه');
      const beforeHide = (await writes()).length;
      await page.locator('[data-decision-submit]').click();
      await page.waitForSelector('[data-overlay="moderation-decision"]', { state: 'detached', timeout: 5000 }).catch(() => null);
      const hid = (await writes()).slice(beforeHide);
      check(`${tag} desk: hiding a comment goes out with its report`, hid.length === 1 && hid[0].path === '/api/admin/moderation/comments/c1/hide' && hid[0].body?.hidden === true && hid[0].body?.report_id === 'rep_2', JSON.stringify(hid));
      // A RESTRICTION'S END: «تاريخ» with no day picked is asked again under the date — never sent as «no end».
      await page.locator('[data-report-kind="request"] [data-report-ladder]').first().click();
      await page.waitForSelector('[role="menu"], [data-overlay="menu-sheet"]', { timeout: 5000 }).catch(() => null);
      await page.getByRole('menuitem', { name: new RegExp(`^${w.restrict}`) }).first().click();
      const untilShown = await page.waitForSelector('[data-overlay="moderation-decision"] [data-decision-until]', { timeout: 5000 }).then(() => true).catch(() => false);
      check(`${tag} desk: «${w.restrict}» asks when it ends`, untilShown);
      await page.locator('[data-decision-reason]').fill('طلبات مكررة لمجسمات محمية');
      await page.locator('[data-until-preset]').selectOption('custom');
      const beforeUntil = (await writes()).length;
      await page.locator('[data-decision-submit]').click();
      await page.waitForTimeout(250);
      check(`${tag} desk: a date with no day is asked again, under the date, before any dialog`, (await page.locator('[data-overlay="moderation-decision"] [data-decision-until] .lv-field-error').count()) === 1 && (await page.locator('[data-overlay="confirm-dialog"]').count()) === 0 && (await writes()).length === beforeUntil);
      await page.locator('[data-decision-until] .lv-field-error').scrollIntoViewIfNeeded();
      await shot('desk-until');
      const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
      await page.locator('[data-decision-date]').fill(day);
      check(`${tag} desk: picking the day clears the question`, (await page.locator('[data-decision-until] .lv-field-error').count()) === 0);
      await page.locator('[data-decision-submit]').click();
      await page.waitForSelector('[data-overlay="confirm-dialog"]', { timeout: 5000 }).catch(() => null);
      await page.locator('[data-overlay="confirm-dialog"] [data-confirm-action]').click();
      await page.waitForSelector('[data-overlay="moderation-decision"]', { state: 'detached', timeout: 5000 }).catch(() => null);
      const limited = (await writes()).slice(beforeUntil);
      check(`${tag} desk: the restriction goes out with the day it ends`, limited.length === 1 && limited[0].path === '/api/admin/moderation/users/u_zain/status' && limited[0].body?.status === 'restrict' && Date.parse(String(limited[0].body?.until)) > Date.now() + 9 * 86_400_000 && limited[0].body?.report_id === 'rep_8', JSON.stringify(limited));
      // THE HISTORY of the reported account.
      await page.locator('[data-report-kind="user"] [data-report-history]').first().click();
      const hist = await page.waitForSelector('[data-overlay="moderation-history"] [data-history-action]', { timeout: 5000 }).then(() => true).catch(() => false);
      check(`${tag} desk: the history lists the decisions, with the appeal`, hist && (await page.locator('[data-history-appeal]').count()) >= 1);
      await page.waitForTimeout(400);
      await shot('desk-history');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-overlay="moderation-history"]', { state: 'detached', timeout: 5000 }).catch(() => null);
      // «المزيد»: a staff account has no ladder; a gone target says so.
      await page.waitForTimeout(400);
      const firstPage = await page.locator('[data-report]').count();
      await page.getByRole('button', { name: w.more }).click();
      await page.waitForTimeout(600);
      check(`${tag} desk: «${w.more}» brings the next page`, (await page.locator('[data-report]').count()) > firstPage, `${firstPage} → ${await page.locator('[data-report]').count()}`);
      check(`${tag} desk: a staff account has no ladder`, (await page.locator('[data-report="rep_9"] [data-report-ladder]').count()) === 0);
      check(`${tag} desk: a gone target says so`, (await page.locator('[data-report="rep_10"] [data-target-gone]').count()) === 1);
      // THE FILTERS: every state, then accounts only.
      await page.locator('[data-reports-state]').selectOption('all');
      await page.waitForSelector('[data-report-state="actioned"]', { timeout: 5000 }).catch(() => null);
      check(`${tag} desk: «${w.all}» includes the decided`, (await page.locator('[data-report-state="actioned"], [data-report-state="dismissed"]').count()) >= 1);
      check(`${tag} desk: a decided report offers no decision`, (await page.locator('[data-report-state="actioned"] [data-report-decide]').count()) === 0);
      await page.locator('[data-reports-type]').selectOption('user');
      await page.waitForTimeout(600);
      const onlyUsers = await page.locator('[data-report]').evaluateAll((els) => els.every((e) => e.getAttribute('data-report-kind') === 'user') && els.length > 0);
      check(`${tag} desk: the type filter keeps accounts only`, onlyUsers);
      // THE APPEALS: accept once.
      await page.locator('[data-moderation-view="appeals"]').click();
      const appeals = await page.waitForSelector('[data-appeals-queue] [data-appeal]', { timeout: 5000 }).then(() => true).catch(() => false);
      check(`${tag} desk: the appeals queue draws`, appeals);
      check(`${tag} desk: no appeal filter's name is cut`, (await cutSegments()).length === 0, JSON.stringify(await cutSegments()));
      await page.waitForTimeout(300);
      await shot('desk-appeals', true);
      await page.locator('[data-appeal="apl_1"] [data-appeal-accept]').click();
      await page.waitForSelector('[data-overlay="moderation-decision"] [data-decision-form]', { timeout: 5000 }).catch(() => null);
      await page.locator('[data-decision-reason]').fill('الرسائل كانت ردودًا على أسئلة.');
      const beforeAppeal = (await writes()).length;
      await page.locator('[data-decision-submit]').click();
      await page.waitForSelector('[data-overlay="moderation-decision"]', { state: 'detached', timeout: 5000 }).catch(() => null);
      const decided = (await writes()).slice(beforeAppeal);
      check(`${tag} desk: accepting sends the answer once`, decided.length === 1 && decided[0].path === '/api/admin/moderation/appeals/apl_1' && decided[0].body?.state === 'accepted', JSON.stringify(decided));
      await page.waitForTimeout(500);
      check(`${tag} desk: the decided appeal leaves the open queue`, (await page.locator('[data-appeal="apl_1"]').count()) === 0);
    }
    check(`${tag} desk: no horizontal overflow after the decisions`, (await overflow()) <= 0, String(await overflow()));
  }

  // ------------------------------------------------------------ the dispute desk
  if (!light) {
    await open('disputes');
    await page.waitForSelector('button:has-text("Ali 3D")', { timeout: 10000 }).catch(() => null);
    await page.locator('button:has-text("Ali 3D")').first().click();
    const links = await page.waitForSelector('[data-evidence-links]', { timeout: 8000 }).then(() => true).catch(() => false);
    check(`${tag} disputes: the case carries «${w.conversation}» and «${w.request}»`, links);
    if (links) {
      const chat = page.locator('[data-evidence-chat]');
      check(`${tag} disputes: «${w.conversation}» opens the evidence in a new tab`, (await chat.getAttribute('href')) === '/admin/chats/ch_1' && (await chat.getAttribute('target')) === '_blank' && (await chat.innerText()).includes(w.conversation));
      check(`${tag} disputes: «${w.request}» opens the request`, (await page.locator('[data-evidence-request]').getAttribute('href')) === '/requests/req_9');
      check(`${tag} disputes: the links are 44 px targets`, ((await chat.boundingBox())?.height ?? 0) >= 44);
      await page.locator('[data-evidence-links]').scrollIntoViewIfNeeded();
      await shot('disputes-case');
    }
    check(`${tag} disputes: no horizontal overflow`, (await overflow()) <= 0, String(await overflow()));
  }

  // ------------------------------------------------------------ the evidence thread
  await open('evidence');
  const ev = await page.waitForSelector('[data-chat-evidence]', { timeout: 10000 }).then(() => true).catch(() => false);
  check(`${tag} evidence: the banner`, ev);
  if (ev) {
    const text = await page.locator('[data-chat-evidence]').innerText();
    check(`${tag} evidence: «${w.evidence}» and «${w.recorded}»`, text.includes(w.evidence) && text.includes(w.recorded), text);
    await page.waitForSelector('[data-chat-messages] [data-card-kind], [data-chat-messages] article, [data-chat-messages] div', { timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(600);
    check(`${tag} evidence: no composer`, (await page.locator('[data-chat-composer]').count()) === 0);
    check(`${tag} evidence: no card action`, (await page.locator('[data-card-action]').count()) === 0);
    check(`${tag} evidence: the request the case is about`, (await page.locator('[data-chat-evidence-request]').getAttribute('href')) === '/requests/req_9');
    check(`${tag} evidence: no horizontal overflow`, (await overflow()) <= 0, String(await overflow()));
    await shot('evidence');
  }
  if (!light) {
    for (const refused of ['not_linked', 'closed']) {
      await open('evidence', `&refused=${refused}`);
      const code = refused === 'closed' ? 'EVIDENCE_CLOSED' : 'EVIDENCE_NOT_LINKED';
      const said = await page.waitForSelector(`[data-chat-evidence-refused="${code}"]`, { timeout: 10000 }).then(() => true).catch(() => false);
      check(`${tag} evidence: a refused read says why (${code})`, said);
      if (refused === 'closed') await shot('evidence-closed');
    }
  }

  // ------------------------------------------------------------ the person's own page
  for (const status of light ? ['restricted'] : ['restricted', 'suspended', 'banned']) {
    await open('page', `&status=${status}&action=mod_2`);
    const banner = await page.waitForSelector(`[data-status-banner="${status}"]`, { timeout: 10000 }).then(() => true).catch(() => false);
    check(`${tag} page(${status}): the banner`, banner);
    await page.waitForSelector('[data-decisions] [data-decision]', { timeout: 8000 }).catch(() => null);
    check(`${tag} page(${status}): the notice's decision is marked`, (await page.locator('[data-decision="mod_2"][aria-current="true"]').count()) === 1);
    check(`${tag} page(${status}): no door to itself`, (await page.locator('[data-status-appeal]').count()) === 0);
    check(`${tag} page(${status}): no horizontal overflow`, (await overflow()) <= 0, String(await overflow()));
    await shot(`page-${status}`, true);
    if (status === 'restricted' && !light) {
      // ONE appeal: the door becomes its state.
      await page.locator('[data-appeal-open="mod_2"]').click();
      const sheet = await page.waitForSelector('[data-overlay="appeal-sheet"] [data-appeal-body]', { timeout: 8000 }).then(() => true).catch(() => false);
      check(`${tag} page: «${w.appeal}» opens the sheet on that decision`, sheet && (await page.locator('[data-overlay="appeal-sheet"] [data-appeal-decision="mod_2"]').count()) === 1);
      await page.locator('[data-appeal-body]').fill('الصورة لا تحمل رقم هاتف، الرقم على علبة المنتج وهو رقم الموديل.');
      await page.waitForTimeout(300);
      await shot('page-appeal');
      const before = (await writes()).length;
      await page.locator('[data-appeal-send]').click();
      await page.waitForSelector('[data-overlay="appeal-sheet"]', { state: 'detached', timeout: 8000 }).catch(() => null);
      const sent = (await writes()).slice(before);
      check(`${tag} page: the appeal is sent once, about that decision`, sent.length === 1 && sent[0].path === '/api/moderation/appeals' && sent[0].body?.action_id === 'mod_2', JSON.stringify(sent));
      await page.waitForTimeout(300);
      check(`${tag} page: the door became the appeal's state`, (await page.locator('[data-appeal-open="mod_2"]').count()) === 0 && (await page.locator('[data-decision="mod_2"] [data-appeal-state="open"]').innerText()).includes(w.underReview));
      await shot('page-appealed');
    }
  }

  // ------------------------------------------------------------ the badges page
  await open('badges', '&hash=reliable_seller');
  const badges = await page.waitForSelector('[data-badges-page] [data-badge]', { timeout: 10000 }).then(() => true).catch(() => false);
  check(`${tag} badges: the page draws`, badges);
  if (badges) {
    check(`${tag} badges: five rules`, (await page.locator('[data-badge]').count()) === 5 && (await page.locator('[data-badge-rule]').count()) === 5);
    check(`${tag} badges: the one asked for is marked`, (await page.locator('[data-badge="reliable_seller"][aria-current="true"]').count()) === 1);
    await page.waitForTimeout(400);
    const inView = await page.locator('[data-badge="reliable_seller"]').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    check(`${tag} badges: and in view`, inView);
    check(`${tag} badges: no horizontal overflow`, (await overflow()) <= 0, String(await overflow()));
    await shot('badges', true);
  }

  // ------------------------------------------------------------ the store hero
  for (const hero of light ? ['profile'] : ['profile', 'cover']) {
    await open('storefront', `&hero=${hero}`);
    const chips = await page.waitForSelector('[data-badge-chips="store"] [data-badge-chip]', { timeout: 10000 }).then(() => true).catch(() => false);
    check(`${tag} storefront(${hero}): the hero carries its chips`, chips);
    if (chips) {
      const keys = await page.locator('[data-badge-chips="store"] [data-badge-chip]').evaluateAll((els) => els.map((e) => e.getAttribute('data-badge-chip')));
      check(`${tag} storefront(${hero}): at most three, the verification left to the hero`, keys.length === 3 && !keys.includes('verified_merchant'), keys.join(','));
      check(`${tag} storefront(${hero}): inside the store's island`, await page.locator('[data-badge-chips="store"]').evaluate((el) => !!el.closest('[data-store-theme]')));
      // ONE LINE per chip, its whole name: a long Sorani name never wraps inside the 28 px pill — the row scrolls sideways.
      check(`${tag} storefront(${hero}): every chip is one line, its name whole`, await page.locator('[data-badge-chips="store"] [data-badge-chip]').evaluateAll((els) => els.every((el) => { const t = el.querySelector('span'); return el.getBoundingClientRect().height <= 29 && !!t && t.scrollWidth <= t.clientWidth + 1; })));
      const first = page.locator('[data-badge-chip="fast_response"]');
      check(`${tag} storefront(${hero}): a chip is a 44 px target`, (await first.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const after = getComputedStyle(el, '::after');
        return Math.max(r.height, parseFloat(after.height) || 0);
      })) >= 44);
      await first.click();
      const why = await page.waitForSelector('[data-badge-chips="store"] [data-badge-why="fast_response"]', { timeout: 5000 }).then(() => true).catch(() => false);
      check(`${tag} storefront(${hero}): «${w.why}» opens inside the island`, why && (await page.locator('[data-badge-why]').innerText()).includes(w.why));
      check(`${tag} storefront(${hero}): the chip says it is open`, (await first.getAttribute('aria-expanded')) === 'true');
      check(`${tag} storefront(${hero}): no horizontal overflow with the popover`, (await overflow()) <= 0, String(await overflow()));
      await page.waitForTimeout(300);
      await shot(`storefront-${hero}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      check(`${tag} storefront(${hero}): Escape closes it, focus on the chip`, (await page.locator('[data-badge-why]').count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('data-badge-chip'))) === 'fast_response');
    }
  }

  // ------------------------------------------------------------ the creator page
  if (!light) {
    await open('creator');
    const chips = await page.waitForSelector('[data-badge-chips="app"] [data-badge-chip]', { timeout: 10000 }).then(() => true).catch(() => false);
    check(`${tag} creator: the store's chips under the name`, chips);
    if (chips) {
      const keys = await page.locator('header [data-badge-chips="app"] [data-badge-chip]').evaluateAll((els) => els.map((e) => e.getAttribute('data-badge-chip')));
      check(`${tag} creator: at most three, no second «verified»`, keys.length === 3 && !keys.includes('verified_merchant'), keys.join(','));
      check(`${tag} creator: every chip is one line, its name whole`, await page.locator('header [data-badge-chips="app"] [data-badge-chip]').evaluateAll((els) => els.every((el) => { const t = el.querySelector('span'); return el.getBoundingClientRect().height <= 29 && !!t && t.scrollWidth <= t.clientWidth + 1; })));
      await page.locator('header [data-badge-chip="reliable_seller"]').click();
      const why = await page.waitForSelector('[data-anchored="badge-why"] [data-badge-why="reliable_seller"]', { timeout: 5000 }).then(() => true).catch(() => false);
      check(`${tag} creator: «${w.why}» grows out of the chip`, why);
      await page.waitForTimeout(400);
      check(`${tag} creator: no horizontal overflow with the popover`, (await overflow()) <= 0, String(await overflow()));
      await shot('creator');
      await page.locator('[data-anchored="badge-why"] [data-badge-about]').click();
      const went = await page.waitForSelector('[data-badges-page] [data-badge="reliable_seller"][aria-current="true"]', { timeout: 5000 }).then(() => true).catch(() => false);
      check(`${tag} creator: the popover leads to /community/badges#reliable_seller, that badge marked`, went);
    }
  }

  // ------------------------------------------------------------ «سمعتك»
  await open('reputation');
  const rep = await page.waitForSelector('[data-reputation-card="ready"]', { timeout: 10000 }).then(() => true).catch(() => false);
  check(`${tag} reputation: the card draws`, rep);
  if (rep) {
    check(`${tag} reputation: two earned with their evidence`, (await page.locator('[data-reputation-badge][data-earned="yes"]').count()) === 2);
    check(`${tag} reputation: how far from the rest`, (await page.locator('[data-reputation-progress="7/10"]').count()) === 1);
    check(`${tag} reputation: the windows`, (await page.locator('[data-reputation-windows] table').count()) === 1);
    check(`${tag} reputation: no horizontal overflow`, (await overflow()) <= 0, String(await overflow()));
    await shot('reputation', true);
  }
  if (!light && lang === 'ar' && width === 360) {
    await open('reputation', '&rep=none');
    check(`${tag} reputation: «قيد الحساب» while nothing is computed`, await page.waitForSelector('[data-reputation-card="calculating"]', { timeout: 8000 }).then(() => true).catch(() => false));
  }

  check(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await context.close();
}
await browser.close();
console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
