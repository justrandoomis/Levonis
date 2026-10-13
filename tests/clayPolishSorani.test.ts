/**
 * CLAY POLISH, BATCH 2 — THE CUSTOMER SCREENS (2026-10-13).
 *
 * The owner: «فيما يخص التصميم claymorphism أريد اكمال التطوير في التصميم
 * ولجعله افضل اكثر». The screens this batch touched hold these lines:
 *
 *  1. NO ARABIC IN A SORANI SLOT (docs/DECISIONS.md row 183). The points page,
 *     the cart, the profile and the orders list carry no two-argument `loc()`:
 *     every string has its own Kurdish, and none of it is the Arabic copied.
 *  2. THE PAGE FOR AN UNKNOWN ADDRESS is a real page in three languages, not a
 *     bare English «Under Construction» line.
 *  3. NO THIRD-PARTY AVATAR. A member without a picture is drawn as their
 *     initial by us; the username never leaves for an avatar service.
 *  4. THE POINTS PAGE has one light: the coin is one raised gold disc with no
 *     hex and no tilt, the check-in card one raised slab with no paperclip,
 *     and its load error never prints the server's raw English.
 *  5. THE PHONE CART IS CLAY: its trays sit on the canvas and the summary is
 *     the one raised card.
 *  6. A LIST OF ORDER CARDS HAS NO PRIMARY, and a total is ink, not gold.
 *  7. «طلب جديد» opens nothing while the board says the community is shut.
 *
 * Run: node --import tsx --test tests/clayPolishSorani.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** A `loc('ar', 'en')` call with exactly two string arguments (quotes or backticks). */
const TWO_ARG_LOC = /\bloc\(\s*(['"`])(?:(?!\1)[^\\]|\\.)*\1\s*,\s*(['"`])(?:(?!\2)[^\\]|\\.)*\2\s*\)/g;
/** Every three-string `loc('ar', 'en', 'ckb')` call, with its arguments. */
const THREE_ARG_LOC = /\bloc\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*,\s*(['"`])((?:(?!\3)[^\\]|\\.)*)\3\s*,\s*(['"`])((?:(?!\5)[^\\]|\\.)*)\5\s*\)/g;

const SORANI_SCREENS = ['src/pages/Rewards.tsx', 'src/pages/Cart.tsx', 'src/pages/Profile.tsx', 'src/pages/Orders.tsx', 'src/pages/NotFound.tsx'];

test('the customer screens of this batch carry no two-argument loc() — Sorani is written, never the Arabic fallback', () => {
  for (const file of SORANI_SCREENS) {
    const src = read(file);
    const left = [...src.matchAll(TWO_ARG_LOC)].map((m) => m[0].replace(/\s+/g, ' ').slice(0, 90));
    assert.deepEqual(left, [], `${file} still has ${left.length} loc() call(s) with no Sorani:\n${left.join('\n')}`);
  }
});

test('no Sorani slot on those screens is a copy of its Arabic', () => {
  for (const file of SORANI_SCREENS) {
    for (const m of read(file).matchAll(THREE_ARG_LOC)) {
      const [ar, ckb] = [m[2], m[6]];
      // A punctuation join («، ») and a locale tag are the same in both on purpose.
      if (/^[\s،,]*$/.test(ar) || /^[a-z]{2}-[A-Z]{2}$/.test(ar)) continue;
      assert.notEqual(ckb, ar, `${file}: the Sorani of «${ar.slice(0, 40)}» is the Arabic copied`);
    }
  }
});

test('an unknown address renders a real, lazy, three-language page with one way home', () => {
  const app = read('src/App.tsx');
  assert.doesNotMatch(app, /Under Construction/, 'the bare English placeholder is back in App.tsx');
  assert.match(app, /const NotFound = React\.lazy\(\(\) => import\('\.\/pages\/NotFound'\)\);/);
  assert.match(app, /<Route path="\*" element=\{<NotFound \/>\} \/>/);
  const page = read('src/pages/NotFound.tsx');
  assert.match(page, /<h1\b/, 'the not-found title is the page h1');
  assert.match(page, /<Link to="\/" className="lv-button lv-button-primary/);
  for (const [ar, en] of [
    ['الصفحة غير موجودة', 'Page not found'],
    ['ربما تغيّر الرابط أو حُذفت الصفحة.', 'The link may have changed, or the page was removed.'],
    ['العودة إلى الرئيسية', 'Back to home'],
  ]) {
    const call = [...page.matchAll(THREE_ARG_LOC)].find((m) => m[2] === ar && m[4] === en);
    assert.ok(call, `NotFound.tsx says «${en}» in all three languages`);
    assert.notEqual(call[6], ar, `the Sorani of «${en}» is its own`);
  }
});

test('no avatar is fetched from a third-party service anywhere in src', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(tsx?|css)$/.test(entry.name) && /dicebear/i.test(read(rel))) offenders.push(rel);
    }
  };
  walk('src');
  assert.deepEqual(offenders, [], `these still send the username to an avatar service: ${offenders.join(', ')}`);
  const header = read('src/components/Header.tsx');
  assert.match(header, /initialOf\(user\?\.username \|\| user\?\.name\)/, 'the header draws the initial itself');
  assert.match(header, /onError=\{\(\) => setAvatarFailed\(true\)\}/, 'a broken picture falls back to the initial');
  assert.doesNotMatch(header, /<span>SU<\/span>/, 'a guest is never given an invented monogram');
  assert.match(header, /loc\('مجاني', 'Free', 'بەخۆڕایی'\)/, 'the free plan is named in the reader’s language');
});

test('the points page has one light and an honest error', () => {
  const page = read('src/pages/Rewards.tsx');
  assert.doesNotMatch(page, /#6b5f3c|#BAA369'?\]|from-\[#|to-\[#/, 'the coin is drawn with hex colours again');
  assert.doesNotMatch(page, /-rotate-12|-rotate-\[2deg\]/, 'the coin or the check-in card is tilted again');
  assert.doesNotMatch(page, /Paperclip/, 'the check-in card has its paperclip back');
  assert.match(page, /bg-gold-fill shadow-1 grid place-items-center text-onyx/, 'the coin is one raised gold disc');
  assert.match(page, /<div className="lv-surface-raised p-4">/, 'the check-in card is the one raised slab');
  assert.match(page, /formatFigure\(data\?\.point_balance \?\? pointBalance \?\? 0, lang\)/, 'the balance uses the shared figure helper');
  assert.doesNotMatch(page, /setLoadError\(err instanceof Error \? err\.message/, 'the load error prints the server’s raw sentence again');
  assert.match(page, /refusalText\(code, refusalLang\(lang\)\)/);
});

test('the phone cart is clay trays on the canvas with one raised summary', () => {
  const cart = read('src/pages/Cart.tsx');
  assert.match(cart, /<div className="lv-surface mx-4 mt-4 pb-3 overflow-hidden">/, 'the lines tray');
  assert.equal((cart.match(/<div className="lv-surface mx-4 mt-3 flex flex-col overflow-hidden">/g) ?? []).length, 2, 'the offers and support-code trays');
  assert.match(cart, /<div className="lv-surface-raised mx-4 mt-3 mb-4 p-4 flex flex-col gap-3 lg:mt-4 lg:sticky top-20">/, 'the summary is the one raised card, sticky beside the trays from 1024px');
  assert.doesNotMatch(cart, /sm:mx-4 sm:mt-4 sm:rounded-xl|bg-surface sm:mx-4 sm:rounded-xl/, 'a flat edge-to-edge band is back on the phone');
});

test('a list of order cards has no primary, and money is ink', () => {
  const card = read('src/components/orders/OrderCard.tsx');
  assert.doesNotMatch(card, /\$\{ACTION\} lv-button-primary/, 'an order card carries a primary again');
  assert.match(card, /\$\{ACTION\} lv-button-ghost text-danger/, 'cancel is a quiet ghost in the danger ink');
  assert.doesNotMatch(card, /text-gold font-bold text-\[15px\] tabular-nums/, 'the order total is gold again');
  assert.doesNotMatch(read('src/components/orders/PaymentBreakdown.tsx'), /strong \? 'text-gold/, 'the breakdown total is gold again');
});

test('«طلب جديد» opens nothing while the board says the community is shut', () => {
  const page = read('src/pages/Requests.tsx');
  assert.match(page, /loadError instanceof ApiError && loadError\.code === 'COMMUNITY_CLOSED'/);
  assert.match(page, /if \(closed\) return;/);
  assert.match(page, /aria-disabled=\{closed \|\| undefined\}/);
  assert.match(page, /aria-describedby=\{closed \? 'requests-closed-note' : undefined\}/);
});
