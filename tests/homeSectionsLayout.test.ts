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
  assert.match(plate, /min-h-4/, 'and reserves the wrapped height so the tile does not jump between pages');
  // An arbitrary `text-[11px]` sets font-size ONLY; the line height is still
  // the page's inherited 1.5, so a reserve in rem would be a guess. Pinning
  // the leading is what makes 16px the real line box.
  assert.match(plate, /leading-4/, 'the reserve is only exact if the line box is pinned');
});

test('the rotation dots are real targets — for a reduced-motion visitor they are the only way through', () => {
  const src = read('src/components/home/SpotlightTiles.tsx');
  // The tile does not rotate under prefers-reduced-motion, by design. That
  // makes these buttons the sole control, and a 6px button is not a control.
  assert.match(src, /h-11\s+min-w-\[28px\]/, 'the button is 44px tall with the small dot drawn inside it');
  assert.match(src, /motion-reduce:transition-none/, 'and the dot honours reduced motion by not animating');
});

test('the spotlight sections are reachable by heading navigation', () => {
  const src = read('src/components/home/SpotlightTiles.tsx');
  // The title was a plain span inside a link, so neither section existed to a
  // screen reader browsing by heading — unlike every other shelf here.
  assert.match(src, /<h2 className=[^>]*>\{title\}<\/h2>/);
});

test('the same product cannot appear twice in one tile', () => {
  const src = read('src/components/home/SpotlightTiles.tsx');
  // selectionPool is best-sellers concatenated with the newest arrivals, from
  // two endpoints; a product that is both appeared twice, side by side.
  assert.match(src, /new Set<string>\(\)/);
  assert.match(src, /seen\.has\(p\.id\)/);
});

test('a touch is not a hover — a tap used to pause the rotation for about a tenth of a second', () => {
  const src = read('src/components/home/SpotlightTiles.tsx');
  assert.match(src, /pointerType !== 'mouse'/, 'a non-mouse pointer arms a real hold');
  assert.match(src, /TOUCH_HOLD_MS/, 'which expires on its own, so one touch does not freeze the tile for ever');
});

// =========================================================================
// «تصفّح حسب القسم»
// =========================================================================

test('the block keeps its own heading and each department is an h3 beneath it', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  // The owner asked for the department name to read «كما هو في تصفح حسب
  // الأقسام» — at that altitude, ALONGSIDE it. Dropping the block heading
  // would have put «تصفّح حسب القسم» nowhere and made every department a
  // sibling of every other shelf on the page.
  assert.match(src, /title=\{t\('browseCategories'\)\}/, 'the block heading stays');
  assert.match(src, /level="h3"/, 'and departments sit under it, not beside it');
  assert.match(src, /data-category-shelf=/, 'each department is addressable');
});

test('a department is a plain div — five named sections would be five new ARIA landmarks', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  assert.doesNotMatch(
    src,
    /<section[^>]*aria-labelledby/,
    'every other shelf on this page is an unnamed section; the h2/h3 outline carries the structure'
  );
});

test('the sub-sections are a horizontal rail with the house scroll mechanics', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  assert.match(src, /useRail\(\)/, 'useRail owns the RTL scroll conventions — every rail on the page uses it');
  for (const cls of ['overflow-x-auto', 'overscroll-x-contain', 'hide-scrollbar', 'snap-x']) {
    assert.ok(src.includes(cls), `the rail must carry ${cls}, like every other rail on this page`);
  }
  // `overflow-x-auto` forces the computed overflow-y to auto, so a card's
  // focus ring is clipped along its top edge without room above it.
  assert.match(src, /pt-1/, 'the focus ring needs somewhere to be drawn');
  // Deliberately NOT role="list": no other rail here uses it, and
  // BestSellersRail documents choosing against it. A convention pinned in one
  // file is a convention that gets reverted.
  assert.doesNotMatch(src, /role="list"/);
});

test('counts use the shared Arabic plural helper rather than a bare numeral', () => {
  const board = read('src/components/home/CategoryBoard.tsx');
  const header = read('src/components/home/SectionHeader.tsx');
  // «3 منتج» is wrong for the commonest counts a small shop has; the repo
  // already had itemCountLabel with the dual and both plurals.
  assert.match(board, /itemCountLabel\(/, 'the card count');
  assert.match(header, /itemCountLabel\(/, 'and the heading count');
});

test('small counts clear the contrast floor — zinc-500 does not', () => {
  const board = read('src/components/home/CategoryBoard.tsx');
  const header = read('src/components/home/SectionHeader.tsx');
  // #71717a on --color-surface (#131519) is about 3.8:1, under the 4.5:1 that
  // text below 18.66px needs.
  assert.doesNotMatch(board, /text-\[11px\][^"`]*text-zinc-500/);
  assert.doesNotMatch(header, /text-\[12px\][^"`]*text-zinc-500/);
});

test('a broken cover falls back rather than staying broken, and never nests a button inside a link', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  // SafeImage's failure state renders a retry BUTTON, and these plates live
  // inside a <Link>. Interactive content inside interactive content is
  // something no browser agrees on and no keyboard user escapes cleanly.
  assert.doesNotMatch(src, /SafeImage/, 'the card draws its own image');
  // The BEHAVIOUR, not the state variable that implements it. This assertion
  // used to pin `onError={() => setBroken(true)}` character for character,
  // which fixed the fallback at exactly one step — and migration 0100 gave a
  // section two candidate pictures (the one its owner chose and the one
  // borrowed from a product), so the single latch had to become a walk. A test
  // that spells out the implementation makes the correct version of the code
  // unwritable; what matters is that a dead URL leads somewhere.
  assert.match(src, /onError=/, 'a dead URL must lead somewhere');
  assert.match(src, /setFailed/, 'and the plate must remember which candidates died');
});

test('the picture an ADMIN chose outranks the one borrowed from a product', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  // Migration 0100. The order is the whole feature: an authored cover is a
  // decision and a borrowed product photo is a guess, so `image_url` must come
  // FIRST in the candidate list. Reversed, the owner could upload artwork and
  // watch the page keep drawing whichever product the shelf query happened to
  // return first — which is the complaint 0100 answers.
  assert.match(
    src,
    /\[node\.image_url,\s*covers\.get\(node\.id\)\]/,
    'authored first, borrowed second'
  );
  // And the two must stay DISTINGUISHABLE at the plate, or an authored cover
  // whose object is missing from R2 would drop past a perfectly good product
  // photo straight to the monogram.
  assert.match(src, /sources:\s*Array<string \| undefined>/, 'the plate takes the ranked list, not a winner');
});

test('the department heading does not print the count its own cards already carry', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  // On the live shop one department holds one sub-section, so a roll-up on the
  // heading would print the same number twice, three millimetres apart.
  assert.match(src, /count=\{children\.length > 0 \? undefined : category\.product_count\}/);
});

test('the 11px chips are gone — they were a third of the 44px this app holds for a finger', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  assert.doesNotMatch(src, /text-\[11px\][^\n]*px-2\s+py-1/, 'the old SubChip shape must not come back');
  assert.doesNotMatch(src, /VISIBLE_CHILDREN/, 'and neither must the +N pill that linked to the wrong place');
});

test('no artwork is invented, and a section with no photo is a designed state rather than a hole', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  // The monogram is the last of three answers, not the only stand-in: since
  // migration 0100 a section can carry a picture its owner uploaded, and
  // failing that it still borrows one from a product already on the page.
  // Whichever of the three is reached, nothing is fetched for it.
  assert.match(src, /monogramOf/, 'the monogram is the honest last resort');
  assert.match(src, /sub_category_id/, 'a real photo is borrowed from a product already on the page');
  assert.doesNotMatch(src, /api\.get|fetch\(/, 'and nothing is re-fetched for it');
});

test('the monogram tints are visible against the card they sit in', () => {
  const src = read('src/components/home/CategoryBoard.tsx');
  // The first attempt used the olive tokens. `--color-olive` is #1B2010, so
  // `from-olive/40` over `--color-surface` composites to 1.03:1 — the tint was
  // a no-op and every plate read as an empty black rectangle with a letter.
  assert.doesNotMatch(src, /from-olive/, 'olive on this page is nearly black');
  assert.match(src, /from-gold\/25/, 'these were measured: 1.50:1 to 1.68:1 against the card');
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
  const logo = src.slice(src.indexOf('function BrandLogo'), src.indexOf('function MarqueeMark'));
  assert.ok(logo.length > 0, 'BrandLogo must still exist');
  assert.match(logo, /alt=\{entry\.name\}/, 'the logo carries the brand name');
  // The trap: the wrapper span used to carry `aria-hidden` whenever there was
  // an image. Writing an alt into an aria-hidden subtree cancels both, and the
  // screen reader falls back to announcing the href.
  assert.doesNotMatch(logo, /aria-hidden=\{!!entry\.image/, 'nothing may hide the element the alt is on');
});

test('a nameless card cannot produce a nameless link', () => {
  const src = read('src/components/home/Strips.tsx');
  // An authored card is legal with a picture and an EMPTY title, and in bare
  // mode its alt would be '' — a link a screen reader announces by its href.
  assert.match(
    src,
    /entries\.every\(\(e\) => !!e\.image && !!e\.name\.trim\(\)\)/,
    'bare mode requires a name as well as a picture'
  );
});

test('a logo that does not load falls back to the monogram, not to a broken-image glyph', () => {
  const src = read('src/components/home/Strips.tsx');
  assert.match(src, /onError=\{\(\) => setBroken\(true\)\}/);
  assert.match(src, /sr-only">\{entry\.name\}/, 'and the fallback keeps the link named');
});

test('the focus ring is INSET, because the belt clips everything outside itself', () => {
  const src = read('src/components/home/Strips.tsx');
  // The marquee container is overflow-hidden and the track is exactly one mark
  // tall, so an outer ring or an outline-offset is drawn outside the clip and
  // never seen. A ring nobody can see is worse than none: it reads as solved.
  assert.match(src, /focus-visible:ring-inset/);
  assert.doesNotMatch(src, /outline-offset-2/);
});

/**
 * A SOURCE PIN CANNOT PROVE THAT A BELT MOVES, and the three tests this block
 * replaces are the proof of that.
 *
 * They asserted the SOURCE TEXT of the drift — `el.scrollLeft += sign * speed
 * * dt`, `const drifting = !held && !hovered && !focused;` — and every one of
 * them passed on a belt that had not moved a pixel on the owner's iPad. Three
 * separate stoppers were live at once (a hover flag a touch screen sets and
 * never clears, a focus flag a tapped link sets, and a per-frame increment too
 * small to survive being rounded to a pixel), and reading the code could not
 * see any of them.
 *
 * So the behaviour is proved in a real engine by scripts/e2e-marquee-drift.mjs
 * against tests/browser/marquee.html, which measures the actual scroll
 * position across actual animation frames — it fails on the implementation
 * this replaces. What is left HERE is only what a source pin can honestly
 * assert: that the structures the browser proof depends on still exist, and
 * that the specific mistakes are not back.
 */
test('the belt is a SCROLL container the finger can drag, not a paused animation', () => {
  const src = read('src/components/home/Marquee.tsx');
  assert.match(src, /overflow-x-auto/, 'there is something to drag');
  assert.doesNotMatch(src, /animation-play-state/, 'nothing is left to pause');
  // `pan-x` ALONE told the compositor a touch starting on the belt could never
  // scroll the page — and the ads strip is a full-width band near the top, so
  // a customer swiping up from it found the page frozen.
  assert.doesNotMatch(src, /touchAction: 'pan-x'/, 'a vertical swipe must still scroll the page');
  assert.match(src, /touchAction: 'manipulation'/);
  // The drift keeps its own float position. A read-modify-write against the
  // DOM loses 0.28–0.57px per frame to rounding, which is the whole budget.
  assert.match(
    src,
    /let next = posRef\.current \+ speedRef\.current \* dt;/,
    'the position is a float we keep, advanced from our own value'
  );
  assert.match(src, /const posRef = useRef\(0\);/);
  assert.doesNotMatch(src, /el\.scrollLeft \+=/, 'never read-modify-write against the DOM');
  // Direction is measured by useRail, not asserted from the UI language.
  assert.match(src, /import \{ readPos, writePos \} from '\.\.\/\.\.\/lib\/useRail'/);
  assert.doesNotMatch(src, /sign = dir === 'rtl'/, 'three conventions exist; a sign is a guess');
  // Runway on BOTH sides, so a drag meets a recycle rather than a wall.
  assert.match(src, /Math\.ceil\(cw \/ sw\) \+ 3/);
  // The recycle must not run from a scroll handler: writing scrollLeft during
  // an iOS momentum fling cancels the fling.
  assert.doesNotMatch(src, /onScroll=\{/, 'no write inside the scroll event');
});

test('nothing that stops the belt can latch, and the browser proof says so', () => {
  const src = read('src/components/home/Marquee.tsx');
  // HOVER IS A MOUSE FACT. iPadOS synthesises a mouse-enter for a tap and
  // withholds the matching leave until the customer taps something else, so
  // `onMouseEnter` was a one-way switch on the device this shop is run from.
  assert.doesNotMatch(src, /onMouseEnter=/, 'a touch must not be able to set hover');
  assert.match(src, /e\.pointerType === 'mouse'/);
  // FOCUS IS READ, NOT REMEMBERED: `:focus-visible` on the active element is
  // true for a Tab and false for a tap, so a tapped link no longer parks the
  // belt for the rest of the session.
  assert.doesNotMatch(src, /setFocused\(/, 'no focus latch');
  assert.match(src, /:focus-visible/);
  // A HUMAN'S GRIP IS A TIMESTAMP THAT EXPIRES, so a pointer event that never
  // arrives cannot strand the belt.
  assert.match(src, /userAtRef\.current/);
  assert.match(src, /now - userAtRef\.current < 140/);
  // AND A FINGER HELD STILL IS ITS OWN FACT. It scrolls nothing, so the
  // movement signal above cannot see it — without this the belt slides out
  // from under a thumb trying to press a mark, which the first draft of this
  // rewrite shipped. Cleared from the WINDOW so it cannot be withheld, and
  // expiring anyway so a lost event costs a pause rather than the feature.
  assert.match(src, /onPointerDown=/);
  assert.match(src, /pressRef\.current \+= 1;/);
  assert.match(src, /window\.addEventListener\('pointerup', onRelease\)/);
  assert.match(src, /window\.addEventListener\('pointercancel', onRelease\)/);
  assert.match(src, /pressRef\.current > 0 && now - pressAtRef\.current < 5000/);
  // The focus probe fails OPEN: an engine that cannot answer must not park
  // the belt for ever.
  assert.match(src, /catch \{\s*\n\s*keyboard = false;/);
  // And the loop is mounted once, so no stopper can tear it down and rebuild
  // it in a stopped state — which is what the dependency array used to do.
  assert.doesNotMatch(src, /\}, \[dir, speed, stride, drifting, wrap\]\);/);
  // The system preference still parks it, watched rather than read once.
  assert.match(src, /prefers-reduced-motion: reduce/);
  assert.match(src, /reducedRef\.current/);
});

test('the belt has a real browser proof, and it drives the real component', () => {
  // The point of this test is that the proof EXISTS and is wired to the
  // shipped component. A source pin that guards a source pin would be the
  // same mistake one level up.
  const e2e = read('scripts/e2e-marquee-drift.mjs');
  const fixture = read('tests/browser/marquee-fixture.tsx');
  assert.match(fixture, /from '\.\.\/\.\.\/src\/components\/home\/Marquee'/, 'the production component');
  assert.doesNotMatch(fixture, /function Marquee\(/, 'and not a copy of it');
  // Both real call-site shapes: plain children (the ads strip) and renderSet
  // (the brands belt). A zero-width measurement in either used to leave the
  // loop permanently un-started.
  assert.match(fixture, /data-belt="ads"/);
  assert.match(fixture, /data-belt="brands"/);
  assert.match(fixture, /data-belt="ltr"/);
  // The measurements that matter, each named in the runner.
  for (const claim of [
    'the belt must drift on its own',
    'a tap must not latch the belt off',
    'the drift must resume once the pointer leaves',
    'the belt must recycle, not park at the end',
    'the belt must drift in LTR as well',
    'prefers-reduced-motion must stop the drift',
    'a held finger must park the belt',
    'the drift must resume when the finger lifts',
  ]) {
    assert.ok(e2e.includes(claim), `the browser proof still asserts: ${claim}`);
  }
});

test('the resting logo is at full opacity — `hover:` never fires on a phone', () => {
  const src = read('src/components/home/Strips.tsx');
  // Tailwind v4 gates `hover:` behind `@media (hover: hover)`. An
  // `opacity-90` resting state would be permanent on the device the owner
  // filed this from, giving back a tenth of the contrast the brightening won.
  assert.doesNotMatch(src, /opacity-90/);
  assert.match(src, /active:scale-\[0\.97\]/, 'the press feedback is one a finger also gets');
});

test('the brightening is scoped to the shop own brand marks, not to owner photos', () => {
  const src = read('src/components/home/Strips.tsx');
  // The constant was tuned against seven specific transparent logo files. An
  // authored card's picture can be a photograph, and doubling a photograph's
  // brightness is damage rather than correction.
  assert.match(src, /entry\.data === 'brand' \? LOGO_FILTER : undefined/);
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
