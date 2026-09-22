/**
 * «الشخص عنده اكثر من طابعه يظهر له خيار فقط أربعة، وهذه المشكلة يجب جعل زر
 *  طابعاتي لدى التاجر وليس في تعديل الملف الشخصي للشخص العادي، وفي تاجر يجب
 *  أن يكون عبارة عنصر يستطيع وضع أكثر من طابعه».
 *
 * WHAT WAS THERE AND WHY IT WENT. /edit-profile carried four fixed text boxes
 * holding four free-form strings — «e.g. Creality Ender 3» — inside the
 * `profile` JSON blob. A printer shop with six machines could name four of
 * them, and naming them bought nothing: the strings decide no eligibility,
 * match no print request and are read by nothing else in this codebase.
 *
 * The merchant dashboard's Printers tab already holds the real thing,
 * unlimited, and as FACTS rather than free text — technology, build volume,
 * nozzle, materials, colours, enclosure — because those are what the request
 * matcher reads to decide which jobs a shop is eligible for. So the fix is not
 * a fifth text box; it is removing four that nothing consults, on the screen
 * where they were in the way.
 *
 * THE PART THAT MUST NOT REGRESS: nothing stored is deleted. `handleSave`
 * spreads `...user.profile` before writing, so an account that already has
 * `printer1`–`printer4` keeps them through every save made from this screen.
 * That is what makes this a move rather than a data loss, and it is one line
 * away from not being true.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test('the four fixed slots are gone from /edit-profile', () => {
  const src = read('src/pages/EditProfile.tsx');
  assert.ok(!src.includes('My Workshop Printers'), 'the section is gone');
  assert.ok(!/value=\{printer[1-4]\}/.test(src), 'and so are its inputs');
  assert.ok(!/setPrinter[1-4]\(/.test(src), 'and the state behind them');
});

test('and nothing stored is deleted — the spread carries it', () => {
  /**
   * This is the whole difference between a move and a data loss. The save
   * body spreads the existing profile before adding its own keys, so
   * `printer1`–`printer4` ride along untouched on every save from a screen
   * that no longer shows them.
   */
  const src = read('src/pages/EditProfile.tsx');
  const at = src.indexOf('profile: {');
  assert.ok(at > 0, 'the profile blob is still written');
  const body = src.slice(at, at + 400);
  assert.ok(body.includes('...user.profile'), 'the existing profile is spread FIRST');
  assert.ok(
    body.indexOf('...user.profile') < body.indexOf('instagram'),
    'before the keys this screen owns, so it never overwrites them'
  );
  assert.ok(!/\bprinter[1-4],/.test(body), 'and the four are not re-sent');
});

test('the merchant surface it moved to is real, unlimited, and made of facts', () => {
  const tab = read('src/components/merchant/dashboard/PrintersTab.tsx');
  // Facts, not free text — these are what the request matcher reads.
  for (const field of ['technology', 'build_x_mm', 'build_y_mm', 'build_z_mm', 'nozzle_mm', 'materials', 'enclosed']) {
    assert.ok(tab.includes(field), `a printer records its ${field}`);
  }
  // No slot count anywhere: the list is as long as the shop's shelf.
  assert.ok(!/printer[1-4]\b/.test(tab), 'nothing here is a numbered slot');
  // And it is reachable as its own tab in the dashboard.
  const page = read('src/pages/MerchantDashboardPage.tsx');
  assert.match(page, /id: 'printers'/);
  assert.match(page, /<PrintersTab/);
});
