/**
 * «في صفحة المقارنة اجعل عند الضغط على إضافة يظهر نافذة منبثقة يختار الخيار
 *  قبل الإضافة للمقارنه خاصه الطابعات التي تحمل ليزر او كومبو فيه جهاز ams
 *  فهذا يفرق — مثلا يقارن بين طابعه ونفس الطابعه لكن الخيار يختلف.»
 *
 * A printer sold bare, with a laser, and as a Combo with an AMS is three
 * purchases at three prices under one name. The comparison addressed PRODUCTS,
 * so all three were one column and the difference the customer came to read
 * was the one thing the page could not show — and asking for the same printer
 * twice collapsed to a single column, silently.
 *
 * An id is a SLOT now: `productId` or `productId:optionId`. That keeps the
 * whole comparison a link someone can send, which is the property the route's
 * own header calls the feature.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT. The price of a configured column is a
 * number on a page whose job is telling somebody which machine to buy, and
 * an option's price is a LADDER (absolute override, or an adjustment measured
 * from the product's own price, clamped against the member tiers). There is
 * one implementation of that ladder — packages/pricing/src/priceGrid.ts, the
 * same one the admin grid and the TXT export read — and the point of these
 * tests is that this route calls it rather than doing the arithmetic itself.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrid } from '../packages/pricing/src/priceGrid';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const route = () => read('worker/routes/compare.ts');

/** Every money column present and null: "this level sets nothing". */
const INHERIT = {
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
};

// -------------------------------------------------- the id is a slot

test('an id may carry an option, and the slot is what is deduped', () => {
  const src = route();
  assert.match(src, /const cut = key\.indexOf\(':'\);/);
  assert.match(src, /const productId = cut < 0 \? key : key\.slice\(0, cut\);/);
  assert.match(src, /const optionId = cut < 0 \? null : key\.slice\(cut \+ 1\);/);
  // DEDUPED ON THE WHOLE SLOT. On the product id, the second column of one
  // printer under a different option would vanish without a word — which is
  // the exact case this change exists for.
  assert.match(src, /if \(!ids\.includes\(key\)\) \{/);
  assert.ok(!/if \(!ids\.includes\(id\)\) ids\.push\(id\);/.test(src), 'the old product-level dedupe is back');
});

test('a malformed slot is refused by name rather than guessed at', () => {
  const src = route();
  // An empty product half, an over-long half, or a second colon.
  assert.match(src, /if \(!productId \|\| productId\.length > 60\) \{/);
  assert.match(src, /optionId\.includes\(':'\)/);
  assert.match(src, /'COMPARE_BAD_ID'/);
});

test('the lookup is over distinct products, and the columns are the slots', () => {
  const src = route();
  // One product may fill two columns, so the IN list must not carry the same
  // id twice and the column order must come from the slots.
  assert.match(src, /const ids = \[\.\.\.new Set\(slots\.map\(\(slot\) => slot\.productId\)\)\];/);
  assert.match(src, /const rows = slots\.map\(\(slot\) => byId\.get\(slot\.productId\)!\);/);
});

// ------------------------------------------------- the option itself

test('an option that is not this product’s, or is inactive, is refused — not ignored', () => {
  const src = route();
  // Silently falling back to the base product would make a SHARED LINK change
  // which configuration it compares without saying so.
  assert.match(src, /'COMPARE_OPTION_NOT_FOUND'/);
  assert.match(src, /if \(!option \|\| option\.active === false\) \{/);
  // Blamed in the shape COMPARE_NO_SPECS already uses, so the page's existing
  // "drop that column" affordance works on it unchanged.
  assert.match(src, /\{ product_id: slot\.productId, option_id: slot\.optionId \}/);
});

test('the options come off the row through the one parser, not a second query', () => {
  const src = route();
  assert.match(src, /parseProductRow\(byId\.get\(id\) as unknown as Record<string, unknown>\)/);
  assert.match(src, /docById\.get\(slot\.productId\)\?\.options\.find\(\(o\) => o\.id === slot\.optionId\)/);
});

// --------------------------------------------------------- the price

test('the configured price comes from buildGrid, never from arithmetic here', () => {
  const src = route();
  assert.match(src, /import \{ buildGrid \} from '\.\.\/lib\/priceGrid';/);
  assert.match(src, /const line = grid\.find\(\(g\) => g\.level === 'option' && g\.id === option\.id\);/);
  assert.match(src, /return line\?\.cells\.regular\.effective \?\? base;/);
  // The two things a second implementation would look like.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/base \+ Number\(option\./.test(code), 'the surcharge is being added by hand');
  assert.ok(!/regular_adjust_iqd/.test(code), 'the ladder is being re-read column by column');
});

test('and the comparison is scored on THAT price, not the product’s', () => {
  const src = route();
  // The spec sheet is the product's; the price is the option's, and the price
  // row is the one line where two columns of one printer genuinely differ.
  assert.match(src, /id: slots\[i\]\.key,[\s\S]{0,400}price_iqd: priceOf\(i\),/);
  assert.ok(
    !/price_iqd: Number\(p\.row\.price_iqd\) \|\| 0,\s*\}\)\),\s*\}\);/.test(src),
    'the comparison is still scored on the base price'
  );
});

test('buildGrid really does resolve an option surcharge — the behaviour this leans on', () => {
  // Not a source assertion: if this ever stopped being true, every configured
  // column on the page would quietly show the base price.
  const rows = buildGrid({
    price_iqd: 1_000_000,
    prime_price_iqd: null,
    pro_price_iqd: null,
    product_cost_iqd: null,
    selling_type: 'direct_sale',
    sale_types: ['direct_sale'],
    options: [
      // PriceFields wants all four money columns present, null meaning
      // "inherit" — the same shape a row off `product_option_values` has.
      { id: 'ov_bare', name_en: 'Bare', active: true, ...INHERIT },
      { id: 'ov_combo', name_en: 'Combo', active: true, ...INHERIT, regular_adjust_iqd: 250_000 },
      { id: 'ov_fixed', name_en: 'Fixed', active: true, ...INHERIT, regular_price_iqd: 1_750_000 },
    ],
    colors: [],
  });
  const price = (id: string) =>
    rows.find((r) => r.level === 'option' && r.id === id)?.cells.regular.effective;
  assert.equal(price('ov_bare'), 1_000_000, 'an option with no price of its own inherits the base');
  assert.equal(price('ov_combo'), 1_250_000, 'an adjustment is measured from the base');
  assert.equal(price('ov_fixed'), 1_750_000, 'an absolute override wins over the base');
});

// ---------------------------------------------------------- the card

test('the card IS the slot, and still knows which product it is', () => {
  const src = route();
  // `card.id` is what the page removes by, replaces by, and writes back into
  // `?ids=`. The product id has to survive separately or the link to the
  // product page — which knows nothing about slots — would break.
  assert.match(src, /id: slots\[i\]\.key,\s*product_id: product\.row\.id,/);
  assert.match(src, /price_iqd: priceOf\(i\),/);
  assert.match(src, /option: option\s*\?\s*\{ id: option\.id, label: tri\(option\.name_ar, option\.name_en, option\.name_ckb\) \}\s*:\s*null,/);
});

test('a picker card offers its options only when there are at least two', () => {
  const src = route();
  assert.match(src, /function withOptions\(card: CompareProductCard, row: ProductRow\): CompareProductCard \{/);
  assert.match(src, /if \(active\.length < 2\) return card;/);
  // Absent, not empty: the client's test is "is there a list".
  assert.ok(!/options: \[\]/.test(src), 'an empty list would open a popup with nothing in it');
  // Inactive options are never offered — a tap that cannot be honoured.
  assert.match(src, /doc\.options\.filter\(\(o\) => o\.active !== false\)/);
});

// --------------------------------------------------------- the popup

test('the grid asks before it adds, in ONE place', () => {
  const picker = read('src/components/compare/ProductPicker.tsx');
  // Every way in goes through CandidateGrid — the picker sheet, the recently
  // viewed rail and the second slot — so the gate is written once.
  assert.match(picker, /onClick=\{\(\) => \(card\.options\?\.length \? setAsking\(card\) : onPick\(card, null\)\)\}/);
  assert.match(picker, /onPick: \(card: CompareProductCard, optionId: string \| null\) => void;/);
  assert.match(picker, /function OptionSheet\(\{/);
});

test('the option sheet offers the base price first, and is guarded outside its body', () => {
  const picker = read('src/components/compare/ProductPicker.tsx');
  assert.match(picker, /onClick=\{\(\) => onPick\(null\)\}[\s\S]{0,300}\{s\.optionBase\}/);
  // JSX children are an ordinary eager argument: a body reading `card.` would
  // be built, and would throw, before the Sheet decided it was closed. This is
  // the AdminKyc black screen, and it is guarded the same way.
  assert.match(picker, /\{card \? \(/);
  assert.ok(!/label=\{s\.pickTitle\}[\s\S]{0,200}\{card\.name\}/.test(picker));
});

test('every add path writes the slot key back into the URL', () => {
  const page = read('src/pages/Compare.tsx');
  assert.match(page, /const slotKey = \(productId: string, optionId: string \| null\): string =>\s*optionId \? `\$\{productId\}:\$\{optionId\}` : productId;/);
  // The three: the empty state rail, the second slot, and the picker sheet.
  assert.equal((page.match(/slotKey\(card\.id, optionId\)/g) ?? []).length, 2);
  assert.match(page, /const key = optionId \? `\$\{card\.id\}:\$\{optionId\}` : card\.id;/);
  // The product link must not be built from a slot key.
  assert.match(page, /anchorId=\{products\[0\]\.product_id \?\? products\[0\]\.id\}/);
});

test('a card is excluded by its PRODUCT, so the second option is still offerable', () => {
  const picker = read('src/components/compare/ProductPicker.tsx');
  // `excluded` carries slot keys. Comparing them whole would keep offering a
  // printer that is already placed; comparing the product half means the two
  // columns come from the option sheet rather than from tapping twice.
  assert.match(picker, /const placed = new Set\(excluded\.map\(\(key\) => key\.split\(':'\)\[0\]\)\);/);
  assert.match(picker, /const offered = cards\.filter\(\(c\) => !placed\.has\(c\.id\)\);/);
});

test('one column name, so the page cannot label the same column three ways', () => {
  const lib = read('src/lib/compare.ts');
  assert.match(lib, /export function columnName\(card: CompareProductCard, lang: CompareLang\): string \{/);
  assert.match(lib, /return card\.option \? `\$\{base\} · \$\{tri\(card\.option\.label, lang\)\}` : base;/);
  for (const file of [
    'src/components/compare/CompareSlots.tsx',
    'src/components/compare/PowerBlock.tsx',
    'src/components/compare/PriceRow.tsx',
    'src/components/compare/SpecChart.tsx',
    'src/components/compare/SpecTable.tsx',
    'src/components/compare/VerdictBand.tsx',
  ]) {
    const src = read(file);
    assert.ok(src.includes('columnName('), `${file} still names a column by the product alone`);
    assert.ok(
      !/tri\(product\.name, l\)/.test(src),
      `${file} would print the same name twice for two options of one printer`
    );
  }
});

test('all three dictionaries carry the popup’s strings', () => {
  const src = read('src/components/compare/strings.ts');
  for (const key of ['optionTitle', 'optionBody', 'optionBase', 'optionBaseNote']) {
    assert.equal(
      (src.match(new RegExp(`^ *${key}:`, 'gm')) ?? []).length,
      4,
      `${key} is missing from the interface or from one of ar / en / ckb`
    );
  }
});
