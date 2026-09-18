/**
 * THE FOUR THINGS THE OWNER REPORTED FROM THEIR PHONE, pinned in source.
 *
 * This repository has no browser DOM runner on purpose, so these assertions
 * hold the CONTRACT rather than the pixels: the shapes that were wrong, the
 * reasons they were wrong, and the specific classes whose removal would put
 * each defect back. Visual behaviour is still checked in a browser before a
 * deploy; what a test can hold is that nobody quietly undoes the decision.
 *
 * The four reports, in the owner's words:
 *
 *   «شكل البطاقتين في مختارة لك وصفقات مميزة كبيرة جدا, يجب جعلها في سطر واحد
 *    صغيرة»            → SpotlightTiles: two tiles, one row, at every width.
 *   «البطاقات في تصفح حسب القسم سيئة جدا جدا، يجب تغييرها بشكل جذري ui ux»
 *   «يكون اسم القسم الرئيسي وأسفله يكون تمرير أفقي ببطاقات بالأقسام الفرعية»
 *                      → CategoryBoard: a heading per department, a rail under it.
 *   «عند الدخول إلى قسم فرعي معين يظهر الفئة: slug وليس اسم الفئة»
 *                      → Products: never render the URL parameter as a name.
 *   «في أبرز العلامات لا تجعل هنالك خلفية بيضاء ... بدون ... اسم للعلامة»
 *                      → Strips: no white plate, no caption, and an alt that
 *                        still names the link.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The CODE, with every comment removed.
 *
 * This matters more than it looks. These assertions are mostly of the form
 * "this class must not appear", and the components below explain at length
 * WHY the removed class was wrong — quoting it. A scan over raw source would
 * therefore fail on the very comment that records the decision, and the only
 * way to make it pass would be to delete the explanation. A test that
 * punishes documentation is worse than no test.
 *
 * Strings are preserved intact, because `https://…` is not a comment and a
 * className is not prose.
 *
 * THE ONE THING IT DOES NOT DO: a comment written INSIDE a template literal's
 * `${…}` interpolation survives, because the whole literal is treated as a
 * string. That is a deliberate stopping point rather than a bug to work
 * around — tracking brace depth through nested literals is a parser, and the
 * repo already prefers a comment lifted above the JSX to one wedged inside a
 * ternary inside a template. If a future assertion trips on one, move the
 * comment rather than teaching this function to parse.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote = '';
  let esc = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const read = (path: string) => stripComments(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

// =========================================================================
// «مختارات لك» / «صفقات مميّزة»
// =========================================================================

test('the two spotlight tiles sit in ONE row at every width, including the narrowest phone', () => {
  const src = read('src/components/home/SpotlightTiles.tsx');
  // `grid-cols-1 sm:grid-cols-2` was the defect: below 640px each tile took
  // the whole column, they stacked, and every thumbnail inside was half the
  // screen wide.
  assert.doesNotMatch(
    src,
    /grid-cols-1\s+sm:grid-cols-2/,
    'stacking them on a phone is the exact shape the owner reported as «كبيرة جدا»'
  );
  assert.match(src, /grid\s+grid-cols-2\s+gap-2\s+sm:gap-3/, 'two columns from the smallest width up');
});

test('the section name is rendered ONCE — the duplicate badge could not fit and silently truncated', () => {
  const src = read('src/components/home/SpotlightTiles.tsx');
  assert.doesNotMatch(src, /\bbadge=\{/, 'the badge prop printed the same string as the title');
  assert.doesNotMatch(src, /badge:\s*string/, 'and its type went with it');
});

test('a price is never truncated, because a clipped price reads as a smaller number', () => {
  const src = read('src/components/home/SpotlightTiles.tsx');
  const plate = src.slice(src.indexOf('function PricePlate'), src.indexOf('function Slot'));
  assert.ok(plate.length > 0, 'PricePlate must still exist');
  assert.doesNotMatch(plate, /truncate/, '«1,525,0…» is not an unfinished number, it is a wrong one');
  assert.match(plate, /flex-wrap/, 'it wraps instead');
  assert.match(plate, /min-h-\[/, 'and reserves the wrapped height so the tile does not jump between pages');
});

test('the rotation dots are real targets — for a reduced-motion visitor they are the only way through', () => {
  const src = read('src/components/home/SpotlightTiles.tsx');
  // The tile does not rotate under prefers-reduced-motion, by design. That
  // makes these buttons the sole control, and a 6px button is not a control.
  assert.match(src, /h-11\s+min-w-\[28px\]/, 'the button is 44px tall with the small dot drawn inside it');
  assert.match(src, /motion-reduce:transition-none/, 'and the dot honours reduced motion by not animating');
});

test('a touch is not a hover — a tap used to pause the rotation for about a tenth of a second', () => {
  const src = read('src/components/home/SpotlightTiles.tsx');
  assert.match(src, /pointerType !== 'mouse'/, 'a non-mouse pointer arms a real hold');
  assert.match(src, /TOUCH_HOLD_MS/, 'which expires on its own, so one touch does not freeze the tile for ever');
});

// =========================================================================
// «تصفّح حسب القسم»
// =========================================================================

test('every department gets its own heading and its own labelled region', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  assert.match(src, /aria-labelledby=\{headingId\}/, 'the region is named by its own heading');
  assert.match(src, /<SectionHeader\s+id=\{headingId\}/, 'and that heading is the shared one, at heading altitude');
  assert.match(src, /data-category-shelf=/, 'each department is addressable');
});

test('the sub-sections are a horizontal rail with the house scroll mechanics', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  assert.match(src, /useRail\(\)/, 'useRail owns the RTL scroll conventions — every rail on the page uses it');
  for (const cls of ['overflow-x-auto', 'overscroll-x-contain', 'hide-scrollbar', 'snap-x']) {
    assert.ok(src.includes(cls), `the rail must carry ${cls}, like every other rail on this page`);
  }
  assert.match(src, /role="list"/, 'and it is announced as a list of sections');
  assert.match(src, /role="listitem"/);
});

test('the 11px chips are gone — they were a third of the 44px this app holds for a finger', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  assert.doesNotMatch(src, /text-\[11px\][^\n]*px-2\s+py-1/, 'the old SubChip shape must not come back');
  assert.doesNotMatch(src, /VISIBLE_CHILDREN/, 'and neither must the +N pill that linked to the wrong place');
});

test('no artwork is invented, and a section with no photo is a designed state rather than a hole', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  assert.match(src, /monogramOf/, 'the monogram is the honest stand-in — `catalogs` has no image column');
  assert.match(src, /sub_category_id/, 'a real photo is borrowed from a product already on the page');
  assert.doesNotMatch(src, /api\.get|fetch\(/, 'and nothing is re-fetched for it');
});

test('the rail bleed stays SYMMETRIC — a one-sided bleed scrolls the page in one direction only', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  assert.match(src, /-mx-4\s+px-4\s+sm:mx-0\s+sm:px-0/, 'both edges, or neither');
  assert.doesNotMatch(src, /-ms-4|-me-4/, 'a logical-properties sweep must not split this one');
});

// =========================================================================
// «الفئة: cat_printers_fdm»
// =========================================================================

test('the products heading never renders the URL parameter — that was the whole defect', () => {
  const src = read('src/pages/Products.tsx');
  assert.doesNotMatch(
    src,
    /الفئة['"`:\s]*\$\{/,
    'the old heading interpolated the raw `category` parameter straight into the h1'
  );
  assert.doesNotMatch(src, /t\('products' as any\)/, 'and the key it fell back from does not exist in translations.ts');
  assert.match(src, /categoryRef\.name_ar/, 'the name comes from the server-resolved catalog');
});

test('the sticky bar can truncate a long section name without pushing the way back off screen', () => {
  const src = read('src/pages/Products.tsx');
  const bar = src.slice(src.indexOf('sticky top-0'), src.indexOf('<div className="p-4">'));
  assert.match(bar, /min-w-0/, 'without min-w-0 on the flex child the row overflows instead of truncating');
  assert.match(bar, /truncate/);
  assert.match(bar, /w-11 h-11/, 'and the back button is a real 44px target');
  assert.match(bar, /aria-label=/, 'with a name, which it never had');
});

// =========================================================================
// «أبرز العلامات»
// =========================================================================

test('there is no white plate behind a brand logo — the owner has now asked for this twice', () => {
  const src = read('src/components/home/Strips.tsx');
  // src/pages/Cart.tsx records the same decision being made once already: the
  // only pure-white surface in the app, removed for exactly this reason.
  assert.doesNotMatch(src, /bg-zinc-100/, 'a white puck on a near-black page');
  assert.doesNotMatch(src, /bg-white/);
});

test('the admin preview is dark too, because the owner can only fix what they can see', () => {
  const src = read('src/components/AdminHomeSettings.tsx');
  assert.doesNotMatch(
    src,
    /bg-zinc-100 border border-zinc-300\/30/,
    'a light preview hides exactly the logo defect the storefront reveals'
  );
});

test('with the caption gone the alt text IS the link name — half this change is an empty link', () => {
  const src = read('src/components/home/Strips.tsx');
  const mark = src.slice(src.indexOf('function MarqueeMark'), src.indexOf('const cls = logoOnly'));
  assert.ok(mark.length > 0, 'MarqueeMark must still exist');
  assert.match(mark, /alt=\{entry\.name\}/, 'the logo carries the brand name');
  // The trap: the wrapper span used to carry `aria-hidden` whenever there was
  // an image. Writing an alt into an aria-hidden subtree cancels both, and the
  // screen reader falls back to announcing the href.
  const logoBranch = mark.slice(mark.indexOf('logoOnly ? ('), mark.indexOf(') : ('));
  assert.doesNotMatch(logoBranch, /aria-hidden/, 'nothing may hide the element the alt is on');
});

test('a dark logo is brightened rather than backed — measured, not guessed', () => {
  const src = read('src/components/home/Strips.tsx');
  // Against --color-canvas five of the seven seeded logos sit under 3:1.
  // Removing the plate and doing nothing else would have hidden them.
  assert.match(src, /brightness\(2\) saturate\(1\.25\)/, 'the treatment that lifts every one of them over the floor');
  assert.doesNotMatch(src, /mix-blend/, 'multiply crushes to black on this backdrop and screen erases black, not white');
  assert.doesNotMatch(src, /invert\(1\)/, 'and invert turns Bambu Lab green into magenta');
});

test('the marquee set keeps its fixed stride and its trailing space', () => {
  const src = read('src/components/home/Strips.tsx');
  // Marquee measures ONE set and walks exactly that stride. A mark that sized
  // itself to a lazily-loaded logo would widen the set after measurement and
  // the whole belt would visibly re-lay-out.
  assert.match(src, /w-\[112px\] h-14/, 'the logo mark is a fixed box');
  assert.match(src, /pe-3/, 'and the set carries its own trailing space, which is what hides the loop seam');
});
