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

test('and nothing stored is deleted — the profile blob is not written from here', () => {
  /**
   * This is the whole difference between a move and a data loss. Since
   * 2026-11-18 this screen sends only what it shows (name, bio, username,
   * country): no `profile`, no `website`, no `creator_public`. The server
   * keeps every field a PATCH leaves out, so `printer1`–`printer4`, socials
   * and the website ride along untouched.
   */
  const src = read('src/pages/EditProfile.tsx');
  const at = src.indexOf('const body');
  assert.ok(at > 0, 'the save body is still built');
  const body = src.slice(at, src.indexOf("api.patch('/api/profile', body)", at));
  assert.ok(!/\bprofile\s*:/.test(body), 'the profile blob is not sent');
  assert.ok(!/\bwebsite\b/.test(body), 'nor the website');
  assert.ok(!/creator_public/.test(body), 'nor the creator switch');
  const server = read('worker/routes/profile.ts');
  assert.match(server, /body\.website !== undefined \?.+: user\.website/, 'an omitted website is kept');
  assert.match(server, /if \(body\.profile !== undefined\)/, 'an omitted profile is kept');
});

test('website, public page, socials and the store link are off /edit-profile', () => {
  const src = read('src/pages/EditProfile.tsx');
  for (const gone of ['Manage my store', '>Website<', '>Socials<', 'creatorPage', 'data-profile-printers', 'InstagramIcon']) {
    assert.ok(!src.includes(gone), `${gone} is gone`);
  }
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
  // Since W3-A: an entry of the workspace's one nav table, mounted by its screen table.
  assert.match(read('src/components/merchant/shell/nav.ts'), /id: 'printers'/);
  assert.match(read('src/components/merchant/shell/sections.tsx'), /<m\.PrintersTab/);
});
