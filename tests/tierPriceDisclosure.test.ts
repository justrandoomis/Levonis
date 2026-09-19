/**
 * THE PRO/PRIME FOLD — AND THE ONE THING THAT MAKES FOLDING HONEST.
 *
 * The owner asked for the two member-price boxes to stop shouting on every
 * option and every colour: «اجعل هنالك زر وسيط صغير سطر بكتابة … عند النقر
 * عليه يفتح خانتين سعر البرو لهذا الخيار او اللون وسعر البريميوم». They did NOT
 * ask for the feature to be removed, and it must not be — a member price typed
 * on one row is how that row steps out of the product's membership discount
 * while every other row keeps it.
 *
 * Which is exactly why folding is dangerous. A product can carry ten options
 * and a hundred colours. If a folded row looked the same whether or not it held
 * a PRO price, the ONE row quietly ignoring a 10% discount would be invisible,
 * and the only way to find it would be to open all hundred. So this suite
 * exists to pin the two rules that answer that, and it fails if either is lost:
 *
 *   1. a row that already carries a member price is OPEN on arrival;
 *   2. wherever it is folded, the line NAMES the amount.
 *
 * It renders the real component with `renderToStaticMarkup` (the technique
 * tests/policyArticleAnchors.test.ts established, `createElement` rather than
 * JSX so the file stays a `.ts` and the runner's `tests/*.test.ts` glob picks it
 * up), and it drives the default-open predicate through the REAL pricing
 * resolver rather than a copy of it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TierPriceDisclosure, tierPriceSummary, tierPriceOpen, type TierPriceMark } from '../src/components/adminProducts/form/formUi';
import { rowCells, rowCharges } from '../packages/pricing/src/priceGrid';
import { tierPriceMarks } from '../src/components/adminProducts/form/OptionsSection';
import type { PriceFields } from '../packages/pricing/src/pricing';
import { formatIqd } from '../src/lib/api';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const OPTIONS = 'src/components/adminProducts/form/OptionsSection.tsx';
const FORM = 'src/components/adminProducts/ProductForm.tsx';
const UI = 'src/components/adminProducts/form/formUi.tsx';

const MARKER = 'THE-TWO-MONEY-BOXES';

function render(scope: 'option' | 'color' | 'product', marks: TierPriceMark[]): string {
  return renderToStaticMarkup(
    // `children` goes IN the props object, not as createElement's rest
    // argument. React 19's typings declare the component's own `children` as
    // a required prop, and the variadic overload does not satisfy it — so the
    // rest form renders correctly and still fails `tsc -p tests/tsconfig.json`,
    // which `npm run check` runs. A test that only passes under tsx is a test
    // that fails the build.
    createElement(TierPriceDisclosure, {
      scope,
      marks,
      children: createElement('span', { 'data-child': '' }, MARKER),
    })
  );
}

// --------------------------------------------------- 1. the control itself

test('the fold is a real button, and the thing it says it controls exists', () => {
  const html = render('option', []);
  // A `<span role="button">` would not inherit the global `:active` dim in
  // src/index.css, which on an iPad — where Tailwind v4 gates `hover:` behind
  // `@media (hover: hover)` — is the only press feedback there is.
  assert.match(html, /<button type="button"/, 'the control is not a real button');
  const expanded = html.match(/aria-expanded="(true|false)"/);
  assert.ok(expanded, 'the button does not say whether it is open');
  const controls = html.match(/aria-controls="([^"]+)"/);
  assert.ok(controls, 'the button does not name the region it opens');
  // The id must live on a wrapper that is ALWAYS rendered, or `aria-controls`
  // dangles for exactly the half of the time the control is shut.
  assert.match(
    html,
    new RegExp(`id="${controls![1].replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}"`),
    'aria-controls points at an element the closed panel never rendered'
  );
});

test('the fold meets a real hit target and never relies on hover alone', () => {
  const html = render('option', []);
  // formUi's own floor: inputs 40px, buttons may go to 36px. `min-h-9` is 36px
  // of padding — a target without a filled box, which is what «زر خفيف صغير
  // وناعم» asks for.
  assert.match(html, /min-h-9/, 'the line is a 11px tap target on a tablet');
  // The chevron is on screen at rest, so the line reads as pressable before
  // anyone hovers it. NOT `/<svg[^>]*class="[^"]*rotate|<svg/`: that second
  // branch matched any <svg> anywhere in the output, so deleting the chevron
  // outright still passed. Pin the chevron's own size class instead.
  assert.match(html, /<svg[^>]*class="[^"]*w-3\.5[^"]*"/, 'no chevron rendered');
  assert.match(html, /transition-transform motion-reduce:transition-none/, 'the chevron animates through a reduced-motion user');
  // And it must actually turn, in the one axis that survives RTL. A
  // ChevronRight + `rotate-90` reads backwards in an RTL panel (it is live and
  // backwards in Cart.tsx); a vertical 180° flip is direction-neutral.
  assert.doesNotMatch(html, /rotate-180/, 'the chevron is already rotated while the panel is shut');
  assert.match(render('option', [{ label: 'PRO', iqd: 1 }]), /rotate-180/, 'the chevron does not turn when the panel opens');
});

test('every arbitrary text size the fold renders carries an explicit leading', () => {
  // src/index.css §: a line-height under 1.15 clips Cairo's ascenders and the
  // dots under ب ج ي, so an arbitrary `text-[Npx]` that sets font-size alone is
  // a rendering defect in Arabic. The same sweep tests/uiSystem.test.ts runs
  // over the storefront, run over this control's own output.
  const html = render('color', [{ label: 'PRO', iqd: 855_000 }]);
  const offenders: string[] = [];
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    const cls = m[1];
    if (/text-\[\d+(?:\.\d+)?px\]/.test(cls) && !/\bleading-/.test(cls)) offenders.push(cls);
  }
  assert.deepEqual(offenders, [], 'an arbitrary text size with no leading- beside it');
});

test('the fold uses logical properties only — the admin panel is RTL', () => {
  const html = render('option', [{ label: 'PRIME', iqd: 900_000 }]);
  const physical = /\b-?(ml|mr|pl|pr)-\d|\btext-(left|right)\b|\b(left|right)-\d|\brounded-(l|r)-|\bborder-(l|r)-\d|\b(ms|me|ps|pe)-\[?-/;
  const hit = html.match(physical);
  assert.equal(hit, null, `the fold renders a physical direction class: ${hit?.[0]}`);
});

// ------------------------------------------ 2. folded means folded, not gone

test('a row with nothing typed arrives folded, with the plain invitation', () => {
  const html = render('option', []);
  assert.match(html, /aria-expanded="false"/, 'an empty row should not arrive open');
  assert.match(html, /grid-rows-\[0fr\]/, 'the panel is not collapsed');
  assert.match(html, /\binvisible\b/, 'a folded money box stays in the tab order');
  assert.match(html, /سعر خاص لهذا الخيار/, 'the invitation is missing');
  assert.doesNotMatch(html, /data-tier-price-set/, 'a row with nothing set advertises a value');
  // The fold is CSS, not a mount: the children are rendered in both states,
  // which is the only way `grid-template-rows: 0fr -> 1fr` can animate to a
  // height nobody measured.
  assert.match(html, new RegExp(MARKER), 'the panel unmounts its children, so it cannot animate open');
});

test('the wording names THIS row, never the product, when it is a row', () => {
  // MembershipDiscountSection's banner already says a typed price means «لن
  // يُقرأ هذا التجاوز» — about the PRODUCT. Repeating that here unscoped would
  // contradict it: the rule IS still read for every option that typed nothing.
  const option = render('option', []);
  assert.match(option, /سعر خاص لهذا الخيار/);
  assert.match(option, /لهذا الخيار وحده/, 'the rule sentence does not scope itself to this option');
  assert.match(option, /وتبقى بقية الخيارات على الخصم/, 'it does not say the other options keep the discount');

  const color = render('color', []);
  assert.match(color, /سعر خاص لهذا اللون/);
  assert.match(color, /لهذا اللون وحده/);
  assert.match(color, /وتبقى بقية الألوان على الخصم/);

  const product = render('product', []);
  assert.match(product, /سعر خاص لهذا المنتج/);
  assert.match(product, /لهذا المنتج كله/, 'the product-level sentence must not claim to be row-scoped');
  // BOTH HALVES OF THE PARAGRAPH, not just the Arabic one. An unconditional
  // English «for this row only» sat beside the product sentence and said the
  // opposite of it: MembershipDiscountSection's banner states that a typed
  // product price means the rule «لن يُقرأ» at all, so an English reader was
  // being told the discount still covered everything else when it covered
  // nothing.
  assert.doesNotMatch(product, /for this row only/, 'the English half still calls the product override a per-row exception');
  assert.match(product, /for this whole product/, 'the product panel lost its English sentence');
  assert.match(option, /for this row only/, 'a row panel must still say it is row-scoped in English');
  assert.match(color, /for this row only/);

  // The house verb for precedence is «يسبق» / «يفوز على» / «يستبدل». The
  // owner's «يطغى» appears nowhere else in this codebase, and one screen using
  // a private word for the store's most expensive rule is how two screens end
  // up describing the same behaviour differently.
  for (const html of [option, color, product]) {
    assert.match(html, /يسبق خصم العضوية/);
    assert.doesNotMatch(html, /يطغى/);
  }
  // And the escape hatch is stated, so «فارغ» is never a guess.
  assert.match(option, /اتركه فارغًا ليسري الخصم/);
});

// ------------------------- 3. a set price is never folded away in silence

test('a row that already carries a member price arrives OPEN', () => {
  const html = render('color', [{ label: 'PRO', iqd: 855_000 }]);
  assert.match(html, /aria-expanded="true"/, 'a colour with a PRO price arrived folded — the override is invisible');
  assert.match(html, /grid-rows-\[1fr\]/);
  assert.match(html, /\bvisible\b/);
});

test('a typed ZERO opens the panel too — 0 is a price here, not an empty box', () => {
  // The form documents it: a COLOUR's PRIME of 0 is charged as 0, because the
  // colour is the last rung and nothing carries it further. A truthiness check
  // (`if (prices.prime_price_iqd)`) would treat that row as untyped, fold it,
  // and hide a colour being given away.
  const html = render('color', [{ label: 'PRIME', iqd: 0 }]);
  assert.match(html, /aria-expanded="true"/, 'a typed 0 was mistaken for "nothing set"');
});

test('the folded line names what is set, so one row in a hundred cannot hide', () => {
  // The state this prints in — an admin who deliberately folded a row that HAS
  // a price — is reachable only by a click, so the string itself is asserted.
  assert.equal(tierPriceSummary([]), '', 'a row with nothing set must print no tail at all');

  const one = tierPriceSummary([{ label: 'PRO', iqd: 855_000 }]);
  assert.match(one, /PRO/);
  assert.ok(one.includes(formatIqd(855_000)), `the amount is not formatted the way the rest of the form formats money: ${one}`);
  assert.match(one, /^·/, 'the house separator for a quiet appended detail is «·»');

  // Both tiers, both named — «PRIME 900,000 د.ع · PRO 855,000 د.ع» is the shape
  // section 3's own collapsed summary already uses.
  const both = tierPriceSummary([
    { label: 'PRIME', iqd: 900_000 },
    { label: 'PRO', iqd: 855_000 },
  ]);
  assert.ok(both.includes(formatIqd(900_000)) && both.includes(formatIqd(855_000)), both);

  // A typed 0 the till really takes still prints a number. «PRO 0 د.ع» is
  // alarming on purpose; an empty tail would be a lie. (The other 0 — the one
  // an option's rung carry erases — arrives here as null, and is tested in
  // section 4 against the resolver rather than asserted as a string.)
  assert.ok(tierPriceSummary([{ label: 'PRO', iqd: 0 }]).includes(formatIqd(0)));
});

// --------------- 3b. the state machine, which is the feature and had no test

/**
 * `open` is only ever observed with `choice === null` through
 * `renderToStaticMarkup`, and there is no DOM here to click in — the repo has
 * `react-dom/server` and nothing else, and jsdom would be a new dependency. So
 * the derivation is exported and tested directly. It shipped once as
 * `choice ?? marks.length > 0`, which is correct on arrival and wrong the
 * moment a price is REMOVED; the third case below is that bug.
 */
test('the panel opens for a price that arrives and does NOT slam shut on one that leaves', () => {
  // Nothing typed, nothing chosen: folded. The plain invitation.
  assert.equal(tierPriceOpen(null, false, false), false);
  // A price is present at first paint: open, unasked.
  assert.equal(tierPriceOpen(null, true, false), true);
  // A price ARRIVES after mount — the product document lands from the server
  // later than this control mounts — so it must still force the panel open. An
  // open flag seeded once with `useState(marks.length > 0)` would miss this and
  // hide the override, which is the whole defect this control exists against.
  assert.equal(tierPriceOpen(null, true, true), true);
  // THE REGRESSION. The admin clears the field to put this row back on the
  // discount, exactly as the panel's own sentence instructs. `marks` empties on
  // the last backspace. The panel must NOT fold: folding applies
  // `visibility: hidden` to an ancestor of the focused input, which drops focus
  // to <body> and leaves the «يرث» button destroying the container it stands in.
  assert.equal(tierPriceOpen(null, false, true), true, 'clearing a price folds the panel out from under the cursor');
  // The admin's own choice overrules both directions, and keeps overruling them.
  assert.equal(tierPriceOpen(false, true, true), false, 'a deliberately folded row springs back open');
  assert.equal(tierPriceOpen(true, false, false), true, 'a deliberately opened empty row folds itself again');
});

// ------------------- 4. the predicate, against the resolver the cart uses

/**
 * The rows below go through `rowCells` — the same `priceMode` / `memberAtRung`
 * / `clampMemberLadder` chain the checkout resolver and the Quick Edit grid
 * use. This is the gate OptionsSection feeds the fold, so it is tested here
 * rather than re-implemented.
 */
const BENEATH = { regular: 900_000, prime: null, pro: null, cost: null };
/**
 * THE REAL DERIVATION, IMPORTED — not a copy of it. `tierPriceMarks` is
 * exported from OptionsSection for exactly this reason: a mirrored predicate
 * here would keep passing while production drifted, which is how a test ends up
 * proving only that the test is self-consistent. Everything this file asserts
 * about which rows are marked, and with what number, runs the same function the
 * form runs, over the same `rowCells` / `rowCharges` the checkout resolver uses.
 */
const marksFor = (row: PriceFields, level: 'option' | 'color' = 'color') =>
  tierPriceMarks(rowCells(row, BENEATH), rowCharges(row, BENEATH, level));

const EMPTY: PriceFields = {
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
};

test('an untouched row produces no marks, so it folds', () => {
  assert.deepEqual(marksFor(EMPTY), []);
  assert.match(render('option', marksFor(EMPTY)), /aria-expanded="false"/);
});

test('a PRO price stored as an ADJUSTMENT still opens the panel', () => {
  // The trap this exists for. `normalizeCheapestBase` and Quick Edit both write
  // the base+adjustment shape, where `pro_price_iqd` is NULL and
  // `pro_adjust_iqd` carries the delta. A gate reading only the `*_price_iqd`
  // scalar — which is also all `pinnedRows`/`isPinned` read — would call this
  // row untyped, fold it, and hide a live override on one colour of a hundred.
  const row: PriceFields = { ...EMPTY, pro_adjust_iqd: -5_000 };
  const marks = marksFor(row);
  assert.equal(marks.length, 1, 'an adjustment-stored PRO was read as "nothing set"');
  assert.equal(marks[0].label, 'PRO');
  assert.match(render('color', marks), /aria-expanded="true"/);
});

test('a typed ZERO is typed, through the resolver, not just through the label', () => {
  const row: PriceFields = { ...EMPTY, prime_price_iqd: 0 };
  assert.equal(rowCells(row, BENEATH).prime.mode, 'fixed', 'a typed 0 must not resolve as inherit');
  assert.equal(marksFor(row).length, 1);
});

test('the folded label must NOT be built from rowCharges — it would brand every row', () => {
  // `rowCharges`' member() returns `charged: v ?? regular`: the regular price
  // stands in for any tier with no price of its own. So on a row that states
  // nothing, `charges.pro.charged` is still a number. Labelling from it would
  // print «سعر خاص · PRO …» on all hundred colours and the plain invitation
  // would never appear once — the exact inverse of what this control is for.
  const charges = rowCharges(EMPTY, BENEATH, 'color');
  assert.notEqual(charges.pro.charged, null, 'the premise of this test no longer holds');
  assert.equal(charges.pro.viaRegular, true);
  assert.deepEqual(marksFor(EMPTY), [], 'the fold is GATING on rowCharges');

  // And the form must actually call the derivation these tests import, rather
  // than growing a second copy inside the component that nothing here reaches.
  const options = src(OPTIONS);
  assert.match(options, /const memberMarks = tierPriceMarks\(cells, charges\);/, 'PriceCells has its own copy of the mark derivation again');
  // `cells[f].effective` is the number this used to print, and printing it is
  // the defect below. It must not come back anywhere in the marks.
  assert.doesNotMatch(options, /iqd: cells\[f\]\.effective/, 'the fold is printing the stored value again, not the charged one');
});

test('the folded line never names a number the till does not take — an option PRIME of 0', () => {
  /**
   * The rung carry, which PriceCells documents on `level`: `memberAtRung` drops
   * a member price that lands at zero or below, so the SAME typed 0 means two
   * different things one rung apart.
   *
   *   OPTION, prime 0 -> cells.fixed/0, charges 900,000 viaRegular  (0 is erased)
   *   COLOUR, prime 0 -> cells.fixed/0, charges 0                   (0 is charged)
   *
   * Both rows must OPEN — the price is typed either way and rule 1 stands. But
   * the folded line on the option row must not say «PRIME 0 د.ع» while the cell
   * inside it says «تُحاسب بسعر البيع 900,000» and the customer pays 900,000.
   */
  const row: PriceFields = { ...EMPTY, prime_price_iqd: 0 };

  const onOption = marksFor(row, 'option');
  assert.equal(onOption.length, 1, 'a typed 0 on an option stopped counting as typed — the panel would fold on it');
  assert.equal(onOption[0].iqd, null, 'the fold prints 0 for an option whose 0 the resolver erased');
  assert.match(render('option', onOption), /aria-expanded="true"/);
  // The fold and the cell must return the same verdict about the same row.
  assert.equal(rowCharges(row, BENEATH, 'option').prime.viaRegular, true, 'the premise of this test no longer holds');
  assert.match(tierPriceSummary(onOption), /لا يُحتسب/, 'a typed-but-uncharged price reads as an unknown amount');
  assert.doesNotMatch(tierPriceSummary(onOption), /—/, 'a bare dash reads as "set, value unknown"');

  // The colour rung is the last one, so its 0 really is charged and really is 0.
  const onColor = marksFor(row, 'color');
  assert.equal(onColor[0].iqd, 0, 'a colour priced at 0 must still print 0 — it is charged');
  assert.ok(tierPriceSummary(onColor).includes(formatIqd(0)));
});

// ------------------------------------------------ 5. the three call sites

test('only PRIME and PRO move; «السعر» and «التكلفة» are never inside the fold', () => {
  const options = src(OPTIONS);
  const open = options.indexOf('<TierPriceDisclosure scope={level}');
  const close = options.indexOf('</TierPriceDisclosure>', open);
  assert.ok(open > 0 && close > open, 'the option/colour rows no longer use the fold');
  const folded = options.slice(open, close);
  assert.match(folded, /label_ar="PRIME"/);
  assert.match(folded, /label_ar="PRO"/);
  assert.doesNotMatch(folded, /label_ar="السعر"/, 'the regular price was folded away');
  assert.doesNotMatch(folded, /label_ar="التكلفة"/, 'the cost was folded away');
  // Regular stays ABOVE the fold, cost BELOW it: the reading order is unchanged.
  assert.ok(options.indexOf('label_ar="السعر"') < open, 'the regular price moved');
  assert.ok(options.indexOf('label_ar="التكلفة"') > close, 'the cost moved');
});

test('the fold spans the whole grid row instead of posing as a fourth price box', () => {
  // The parent is
  // `grid … [grid-template-columns:minmax(0,1fr)] md:repeat(2,…) xl:repeat(3,…)`
  // and every PriceCell is a DIRECT item of it, so an ordinary item would land
  // beside «السعر» at md/xl. The nested Grid keeps the same track count, so
  // PRIME and PRO still line up under it.
  const ui = src(UI);
  assert.match(ui, /className="col-span-full min-w-0"/, 'the band does not span the row');
  const options = src(OPTIONS);
  const open = options.indexOf('<TierPriceDisclosure scope={level}');
  const close = options.indexOf('</TierPriceDisclosure>', open);
  assert.match(options.slice(open, close), /<Grid cols=\{3\}>/, 'the folded pair does not keep the parent track count');
});

test('both row levels and the product pair all use the one control', () => {
  const options = src(OPTIONS);
  // `level` is 'option' | 'color' and already means the rung, so the wording
  // follows the row without a second switch to keep in sync.
  assert.match(options, /<TierPriceDisclosure scope=\{level\} marks=\{memberMarks\}>/);
  assert.match(options, /beneath=\{base\}/, 'the option rows still measure over the product base');
  assert.match(options, /beneath=\{beneathColor\(c\)\}/, 'the colour rows still measure over their option');
  // The reuse that fails tests/adminProductFormFixes.test.ts, guarded here too
  // so the reason is recorded where the temptation is.
  assert.doesNotMatch(options, /MirrorNote/, 'MirrorNote is forbidden in OptionsSection');

  const form = src(FORM);
  assert.match(form, /<TierPriceDisclosure\s+scope="product"/, 'the product pair is not behind the fold');
  // The product row is the ONE rung with no adjustment column, so `!== null` is
  // the honest gate here and nowhere else.
  assert.match(form, /doc\.prime_price_iqd !== null \? \{ label: 'PRIME', iqd: doc\.prime_price_iqd \} : null/);
  assert.match(form, /doc\.pro_price_iqd !== null \? \{ label: 'PRO', iqd: doc\.pro_price_iqd \} : null/);
  // The panel that explains the precedence is still fed the same typed prices,
  // and the fields it names still carry their own note.
  assert.match(form, /typedMemberPrice=\{\{ prime: doc\.prime_price_iqd, pro: doc\.pro_price_iqd \}\}/);
  assert.match(form, /ar="سعر LEVO PRIME"/);
  assert.match(form, /ar="سعر LEVO PRO"/);
});

test('the fold survives a reduced-motion admin without losing the state change', () => {
  // src/index.css's reduce block clamps ANIMATIONS and deliberately leaves
  // transitions running, and this form renders outside the `.ap` scope whose
  // theme.css clamps both — so `motion-reduce:transition-none` is the only
  // thing standing between a reduced-motion admin and the travel.
  const html = render('option', []);
  assert.match(html, /transition-\[grid-template-rows\][^"]*motion-reduce:transition-none/);
  assert.match(html, /transition-\[visibility\][^"]*motion-reduce:transition-none/);
  // The panel still changes state — instantly. Feedback kept, movement dropped.
  assert.match(render('option', [{ label: 'PRO', iqd: 1 }]), /grid-rows-\[1fr\]/);
});
