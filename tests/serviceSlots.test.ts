/**
 * THE SERVICES RAIL IS A SET OF PROMISES. THIS IS WHAT CHECKS THEM.
 *
 * The owner asked, in so many words, «تأكد من أن خدمات الروابط تعمل وجميعها
 * موجودة» — make sure the services' links work and that they all exist. The
 * answer could not be "I clicked them": the destinations live in two places
 * that have no compiler relationship (a slot table in the Worker, a card list
 * in a React component) and the route table is a third file. Any of the three
 * can be edited alone, and nothing but a test notices.
 *
 * So this file resolves EVERY service slot's link against the routes
 * src/App.tsx actually registers, and fails if one of them would land on the
 * `*` fallback — the bare «Under Construction» panel. A list of links nobody
 * verifies is exactly how a storefront comes to advertise a page it does not
 * have.
 *
 * These are source-text assertions, not a rendered DOM: this repository has no
 * browser runner (see tests/uiSystem.test.ts), and the pairing being pinned
 * here is structural — which id, which object, which path — so reading it out
 * of the source is the honest check rather than a weaker stand-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SERVICE_SLOTS, isSiteMediaObject, siteMediaKey, resolveSiteMedia } from '../worker/lib/siteMedia';
import { isAnonymousPublicMediaKey, isSafeMediaKey } from '../worker/lib/mediaStorage';
import { STUDIO_URL } from '../src/translations';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The same source with comments removed. An assertion that a BANNED STRING is
 *  absent has to read the code only, or the comment explaining why the string
 *  is banned fails the very test it documents. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

/** A link's route path — the query string is not part of what the router
 *  matches, and «الفلامنت العشوائي» deliberately carries one. */
const pathOf = (link: string): string => link.split('#')[0].split('?')[0];

const isAbsolute = (link: string): boolean => /^https?:\/\//.test(link);

/**
 * The routes THIS application serves, as opposed to the merchant storefront.
 *
 * src/App.tsx holds three <Routes> blocks. One belongs to `StorefrontApp`, the
 * separate tree rendered for a merchant's own subdomain, and it ends in a
 * catch-all that would make every assertion below pass for the wrong reason.
 * It is cut out by name so the remaining two — the full-screen shell and the
 * ordinary one, which between them are the main site — are what a service link
 * is checked against.
 */
function mainAppRoutes(): Set<string> {
  const app = read('src/App.tsx');
  const start = app.indexOf('function StorefrontApp()');
  const end = app.indexOf('function AppBootstrapLayer()');
  assert.ok(start > 0 && end > start, 'src/App.tsx no longer has a StorefrontApp block to exclude');
  const mainOnly = app.slice(0, start) + app.slice(end);
  const paths = new Set<string>();
  for (const m of mainOnly.matchAll(/<Route\s+path="([^"]+)"/g)) paths.add(m[1]);
  assert.ok(paths.size > 20, 'the route table did not parse — the regex or the file shape changed');
  return paths;
}

test('the eleven service slots name the objects the owner uploaded, in the owner’s order', () => {
  // Transcribed from a live listing of `UiUx/MainPage/`, not from the brand's
  // or the service's own spelling. R2 keys are byte-exact: `LevoStudio.webp`
  // written `Levostudio.webp` is a 404 and a broken tile on the first screen.
  assert.deepEqual(
    SERVICE_SLOTS.map((s) => [s.slot, s.defaultObject]),
    [
      ['service-studio', 'LevoStudio.webp'],
      ['service-compare', 'Compare.webp'],
      ['service-tools', 'Tools.webp'],
      ['service-bundles', 'Bundle.webp'],
      ['service-mystery', 'Randoms.webp'],
      ['service-tradein', 'Replace.webp'],
      ['service-used', 'Used.webp'],
      ['service-rewards', 'Reward.webp'],
      ['service-warranty', 'Warranty.webp'],
      ['service-community', 'Community.webp'],
      ['service-support', 'Support.webp'],
    ]
  );
});

test('every service icon is a real object name an anonymous visitor may fetch', () => {
  // The services rail is on the first screen a signed-out visitor sees. An
  // icon that needs a session is not a private asset, it is a broken one.
  const seen = new Set<string>();
  for (const slot of SERVICE_SLOTS) {
    assert.ok(slot.defaultObject, `${slot.slot} has no default object`);
    assert.ok(isSiteMediaObject(slot.defaultObject), `${slot.defaultObject} is not a valid object name`);
    assert.ok(!seen.has(slot.defaultObject), `${slot.defaultObject} is claimed by two slots`);
    seen.add(slot.defaultObject);
    const key = siteMediaKey(slot.defaultObject);
    assert.ok(isSafeMediaKey(key), `${key} is not a safe media key`);
    assert.ok(isAnonymousPublicMediaKey(key), `${key} would not be served to a signed-out visitor`);
  }
});

test('every service slot names a destination, and every in-app one is a route App.tsx serves', () => {
  const routes = mainAppRoutes();
  for (const slot of SERVICE_SLOTS) {
    assert.ok(slot.link, `${slot.slot} has no link — a card with no destination is a dead card`);
    if (isAbsolute(slot.link)) continue;
    assert.ok(slot.link.startsWith('/'), `${slot.slot}: "${slot.link}" is neither absolute nor rooted`);
    const path = pathOf(slot.link);
    assert.ok(
      routes.has(path),
      `${slot.slot} points at ${path}, which src/App.tsx does not register — it would land on the "*" fallback`
    );
  }
});

test('a full-screen destination is declared in the full-screen table, not only in the ordinary one', () => {
  /**
   * AppContent decides between two trees BEFORE the router runs: a fixed list
   * of prefixes renders the full-screen shell, everything else the ordinary
   * one. A path on that list which is only declared in the ordinary block
   * would match `isFullScreenRoute`, render the full-screen tree, and find
   * nothing there — a blank page rather than a 404, which is worse because it
   * looks like a loading state. /support and /points both ride this path.
   */
  const app = read('src/App.tsx');
  const listed = app.match(/const isFullScreenRoute = \[([^\]]+)\]/);
  assert.ok(listed, 'the full-screen prefix list moved — this check needs updating, not deleting');
  const prefixes = [...listed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const start = app.indexOf('if (isFullScreenRoute) {');
  const end = app.indexOf('const navHidden = isBottomNavHidden');
  assert.ok(start > 0 && end > start, 'the full-screen shell block moved');
  const fullScreenBlock = app.slice(start, end);

  for (const slot of SERVICE_SLOTS) {
    if (!slot.link || isAbsolute(slot.link)) continue;
    const path = pathOf(slot.link);
    const full = prefixes.some((p) => path === p || path.startsWith(p + '/'));
    if (!full) continue;
    assert.ok(
      fullScreenBlock.includes(`<Route path="${path}"`),
      `${slot.slot} points at ${path}, which renders the full-screen shell but is not declared in it`
    );
  }
});

test('the Studio link is the one absolute destination, and it is the configured origin', () => {
  // The Worker cannot import from src/, so the origin is written out in
  // worker/lib/siteMedia.ts. This is what stops the copy from drifting away
  // from the constant the store actually navigates with.
  const studio = SERVICE_SLOTS.find((s) => s.slot === 'service-studio')!;
  assert.equal(studio.link, STUDIO_URL);
  const absolutes = SERVICE_SLOTS.filter((s) => isAbsolute(s.link ?? ''));
  assert.deepEqual(absolutes.map((s) => s.slot), ['service-studio']);
});

test('ServicesGrid renders a card for every slot, pointing where the slot says', () => {
  /**
   * The rail and the slot table are two lists of the same eleven services, and
   * the storefront joins them on `service-${card.id}`. Nothing in the type
   * system connects them: a card added here with no slot silently gets no
   * icon, and a slot with no card is an image the owner can upload and never
   * see. So both directions are asserted.
   */
  const grid = read('src/components/home/ServicesGrid.tsx');

  const cards = new Map<string, string>();
  for (const m of grid.matchAll(/id:\s*'([^']+)',\s*to:\s*'([^']+)'/g)) cards.set(m[1], m[2]);
  // The Studio card is a literal <a href={STUDIO_URL}> on purpose — see
  // tests/store-isolation.test.ts — so it is matched by its anchor instead.
  assert.match(grid, /href=\{STUDIO_URL\}[\s\S]{0,200}data-service="studio"/);
  cards.set('studio', STUDIO_URL);

  // The in-app cards carry `data-service={s.id}` through one map, so the id in
  // the list IS the id in the attribute. That single binding is asserted here;
  // asserting a literal per card would only pin a shape the file does not have.
  assert.match(grid, /inApp\.map\(\(s\) => \([\s\S]{0,300}data-service=\{s\.id\}/);
  assert.match(grid, /siteMedia\.find\(\(m\) => m\.group === 'service' && m\.slot === `service-\$\{id\}`\)/);

  for (const slot of SERVICE_SLOTS) {
    const id = slot.slot.replace(/^service-/, '');
    assert.ok(cards.has(id), `no card on the rail carries the id "${id}" for ${slot.slot}`);
    assert.equal(cards.get(id), slot.link, `${slot.slot} and its card disagree about the destination`);
  }
  assert.equal(cards.size, SERVICE_SLOTS.length, 'a card exists that no slot can put an icon on');
});

test('the rail picks its language with loc(), never with the direction', () => {
  /**
   * `dir === 'rtl' ? ar : en` serves ARABIC to every Kurdish reader, because
   * Sorani is right-to-left too. The house idiom is loc(ar, en, ckb), and the
   * three new cards on this rail have no translation key, so this is the file
   * where that mistake would have been made.
   */
  for (const path of [
    'src/components/home/ServicesGrid.tsx',
    'src/pages/UsedPrinters.tsx',
    'src/pages/TradeIn.tsx',
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /dir\s*===\s*'rtl'\s*\?\s*\w+\s*:\s*\w+\s*[,)}\n]/, `${path} picks text by direction`);

    /**
     * AND THE SAME DEFECT WEARING A DIFFERENT TEST. `lang === 'en' ? 'h' : 'س'`
     * is a TWO-branch choice on a THREE-language shop, and the branch the
     * Kurdish reader falls into is the Arabic one — identical in effect to the
     * direction test above and invisible to a reviewer who reads Arabic. It
     * shipped on the used-stock card eight lines from the assertion written to
     * prevent it, which is the whole argument for widening the guard rather
     * than only fixing the instance.
     *
     * A THREE-branch chain is fine and is not flagged: `lang === 'en' ? en :
     * lang === 'ckb' ? ckb : ar` names all three languages and is what
     * TradeIn.tsx legitimately does for a grade label. So the test is not "is
     * there a lang ternary" but "does this lang ternary ask about only ONE
     * language and then fall through" — which is the two-way shape.
     */
    for (const m of code(path).matchAll(/lang\s*===\s*'(en|ar|ckb)'\s*\?/g)) {
      // The window reaches BACKWARDS as well as forwards: in a three-branch
      // chain the second test is the last one, and looking only ahead of it
      // would flag the tail of a perfectly correct expression.
      const at = m.index ?? 0;
      const rest = code(path).slice(Math.max(0, at - 200), at + 200);
      assert.match(
        rest,
        /lang\s*[=!]==\s*'(en|ar|ckb)'[\s\S]*lang\s*[=!]==\s*'(en|ar|ckb)'/,
        `${path} picks text with a TWO-way lang test — three languages need loc(ar, en, ckb):\n  ${m[0]}`
      );
    }
    assert.match(source, /loc\(/, `${path} does not use loc() at all`);
  }
});

test('the used-stock page promises only what the condition document records', () => {
  /**
   * A ConditionEntry carries a grade, a fault, a repair, notes, a nullable
   * `usage_hours` and a `warranty_months` that is free to be 0. It records NO
   * inspection. The page's lead sentence once promised all three — «كل قطعة
   * مفحوصة ومذكور عليها … ساعات تشغيلها وضمان ليفو الذي يغطيها» — on the one
   * surface in the shop where a buyer leans hardest on our word, and its own
   * card disproved two of them by rendering neither figure when it was absent.
   */
  const used = code('src/pages/UsedPrinters.tsx');
  assert.doesNotMatch(used, /كل قطعة مفحوصة/, 'nothing records that an inspection happened');
  assert.doesNotMatch(used, /Every unit is inspected/);
  assert.doesNotMatch(used, /ضمان ليفو الذي يغطيها/);

  // Each unit states its own two figures instead, INCLUDING when the answer is
  // that there is none — a silent gap reads as "nothing to report".
  assert.match(used, /ساعات التشغيل غير مذكورة/);
  assert.match(used, /بدون ضمان/);
  assert.match(used, /condition\.warranty_months > 0/);

  // And the surface does not call itself printers. A condition document grades
  // a PRODUCT and carries no kind, so a graded spool lands here too.
  assert.doesNotMatch(used, /'طابعات مستعملة'/, 'the H1 promises printers the query cannot guarantee');
  assert.doesNotMatch(code('src/components/home/ServicesGrid.tsx'), /'طابعات مستعملة'/);
});

test('the two new pages exist, are routed, and state their own empty cases', () => {
  const app = read('src/App.tsx');
  assert.match(app, /<Route path="\/used-printers" element=\{<UsedPrinters \/>\} \/>/);
  assert.match(app, /<Route path="\/trade-in" element=\{<TradeIn \/>\} \/>/);

  const used = read('src/pages/UsedPrinters.tsx');
  // Loading, error-with-retry and empty are three DIFFERENT answers; a page
  // that renders "nothing in stock" for a failed fetch is lying to a customer.
  assert.match(used, /<ErrorState error=\{error\} onRetry=\{load\}/);
  assert.match(used, /<EmptyState/);
  assert.match(used, /data-used-printers-page/);

  const trade = read('src/pages/TradeIn.tsx');
  /**
   * THE FORM MUST REACH SOMETHING REAL. A trade-in page whose submit button
   * resolves to a toast is worse than one that says «قريبًا», so the POST and
   * the server's required confirmation flag are pinned here: if the endpoint
   * is ever removed from the call, this fails rather than the customer finding
   * out months later that nobody ever received their request.
   */
  assert.match(trade, /api\.post<[^>]*>\('\/api\/support\/tickets'/);
  assert.match(trade, /confirm: true/);
  assert.match(trade, /data-trade-in-form/);
  assert.match(trade, /data-trade-in-review/);
});

test('resolve gives every service slot a url and its link', () => {
  const resolved = resolveSiteMedia({});
  for (const slot of SERVICE_SLOTS) {
    const entry = resolved.find((m) => m.slot === slot.slot)!;
    assert.equal(entry.url, `/files/${siteMediaKey(slot.defaultObject)}`);
    assert.equal(entry.link, slot.link);
    assert.equal(entry.custom, false);
  }
});
