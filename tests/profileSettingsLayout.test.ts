/**
 * TWO LAYOUT REPORTS FROM THE SAME iPad SESSION.
 *
 *   «في بروفايل برنامج الإحالة وتنبيهاته اجعلها في سطر واحد زرين في سطر واحد
 *    وليس في سطرين.»
 *   «الوضع في الإعدادات غير مناسب غير مرتب أعد الترتيب لتكون أنسب وأمتع
 *    بصريا — استخدم مهارات التصميم.»
 *
 * Neither is about a control that misbehaves; both are about arrangement, and
 * arrangement is the kind of thing a later tidy-up silently undoes — a card
 * gains a subtitle and wraps, a section is appended in the wrong place, a
 * responsive class is dropped in a merge. So each rule is written down here
 * with the reason it exists, because the reason is the part that stops it
 * being undone.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const profile = read('src/pages/Profile.tsx');
const settings = read('src/pages/Settings.tsx');

test('the referral and alerts signposts are two buttons on ONE row', () => {
  const referral = profile.indexOf('data-profile-referrals');
  const alerts = profile.indexOf('data-profile-stock-alerts');
  assert.ok(referral > 0 && alerts > referral, 'both signposts still exist, in that order');

  // ONE grid owns them both. Two full-width rows cost 112px of a phone screen
  // to say two words each, and pushed the quick actions below the fold.
  const grid = profile.lastIndexOf('grid grid-cols-2 gap-2', referral);
  assert.ok(grid > 0, 'the pair is not in a two-column grid any more');
  const closed = profile.indexOf('</div>', alerts);
  assert.ok(closed > alerts, 'the grid still closes after the second button');
  // Nothing between them but the second button's own comment and markup.
  const between = profile.slice(referral, alerts);
  assert.ok(!between.includes('grid grid-cols-'), 'something was inserted between the pair');

  // NEITHER MAY GO FULL WIDTH AGAIN. `w-full` is what they used to carry.
  for (const [name, at] of [['referral', referral], ['alerts', alerts]] as const) {
    const button = profile.slice(at, at + 400);
    assert.ok(!/className="w-full/.test(button), `the ${name} signpost went full width again`);
    assert.ok(/min-w-0/.test(button), `the ${name} signpost can overflow its half`);
    assert.ok(/min-h-\[56px\]/.test(button), `the ${name} signpost lost its touch target`);
  }

  // At half the width a subtitle truncates to a few characters and says
  // nothing, which is worse than saying nothing at all — the icon and title
  // already name the destination. The referral CODE is the exception: it is a
  // fact worth reading without opening anything.
  assert.ok(profile.includes('{mine.referral.code}'), 'the code is still readable at a glance');
  const alertsButton = profile.slice(alerts, profile.indexOf('</button>', alerts));
  assert.ok(
    !/text-\[11px\][\s\S]{0,200}loc\(/.test(alertsButton),
    'a subtitle that will truncate to nothing is back on the alerts signpost'
  );
});

test('the settings page is seven cards, in the order they are used', () => {
  // The owner asked for a REORDER. It ran account → security → linking →
  // addresses → preferences: the things you set up ONCE were first and the
  // things you come back to change were buried. Language, currency and theme
  // are the most-visited settings in a trilingual shop.
  const order = ['secAccount', 'secPrefs', 'secAddresses', 'secSecurity', 'secLinking', 'secNotifications', 'secPrivacy'];
  const at = order.map((k) => settings.indexOf(`title={s.${k}}`));
  for (const [i, index] of at.entries()) {
    assert.ok(index > 0, `the ${order[i]} card is missing`);
    if (i > 0) {
      assert.ok(index > at[i - 1], `${order[i]} must come after ${order[i - 1]}`);
    }
  }

  // …and every one of them is a SectionCard. The linking section used to
  // hand-roll its own heading and spacing, so on a page of seven identical
  // cards exactly one looked different — a large part of «غير مرتب» on a page
  // whose whole job is to look orderly.
  assert.equal(
    (settings.match(/<SectionCard\b/g) ?? []).length,
    7,
    'a settings section is not a SectionCard again'
  );
  assert.ok(
    !/<section className="mb-6" id="settings-linking"/.test(settings),
    'the linking section hand-rolled its own look again'
  );
  // The anchor survives the conversion — «توثيق رقمي» scrolls here by id.
  assert.match(settings, /id="settings-linking"/);
  assert.match(settings, /scrollMarginTop: '72px'/);
});

test('the settings cards go two abreast where there is room, and never split', () => {
  // Seven cards of wildly uneven height in a 576px column is a narrow ribbon
  // with a quarter of an iPad empty on each side.
  assert.match(settings, /max-w-xl md:max-w-4xl/, 'the column is pinned narrow on a tablet again');
  assert.match(settings, /className="md:columns-2 md:gap-x-5"/, 'the two-column layout is gone');
  // A multi-column flow will happily split «الأمان» across the gap unless
  // every card refuses. This is the one class that makes it a set of whole
  // cards rather than a magazine.
  assert.match(
    settings,
    /<section id=\{id\} className="mb-7 break-inside-avoid"/,
    'the cards can be split down the middle again'
  );
});
