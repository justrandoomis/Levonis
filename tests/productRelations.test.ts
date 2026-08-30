/**
 * Colour ↔ option-value links and server-side validation — mandate §7 and §11,
 * acceptance row: "لون مرتبط بخيارين وثلاثة خيارات يظهر فقط مع التركيبات
 * الصحيحة".
 *
 * The algebra under test: OR inside an option group, AND across groups; a
 * colour with no links is visible everywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorVisibility,
  isValidHex,
  normalizeHex,
  validatePriceLadder,
  validateSelection,
  visibleColors,
  type ColorLinkRow,
  type ColorRow,
  type OptionGroupRow,
  type OptionValueRow,
} from '../worker/lib/productRelations';

// Three groups, mirroring the mandate's own example: printer / bundle / plug.
const G = { printer: 'g_printer', bundle: 'g_bundle', plug: 'g_plug' };

const groups: OptionGroupRow[] = [
  { id: G.printer, product_id: 'p1', name_en: 'Printer', sort: 1, active: 1 },
  { id: G.bundle, product_id: 'p1', name_en: 'Bundle', sort: 2, active: 1 },
  { id: G.plug, product_id: 'p1', name_en: 'Plug', sort: 3, active: 1 },
];

const val = (id: string, group_id: string, name_en: string, over: Partial<OptionValueRow> = {}): OptionValueRow => ({
  id,
  product_id: 'p1',
  group_id,
  name_en,
  sku_part: '',
  image: '',
  sort: 0,
  active: 1,
  stock: null,
  reserved: 0,
  low_stock_threshold: null,
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  ...over,
});

const values: OptionValueRow[] = [
  val('v_a1', G.printer, 'A1'),
  val('v_p1s', G.printer, 'P1S'),
  val('v_combo', G.bundle, 'Combo'),
  val('v_solo', G.bundle, 'Solo'),
  val('v_eu', G.plug, 'EU'),
  val('v_us', G.plug, 'US'),
];

const color = (id: string, name_en: string, over: Partial<ColorRow> = {}): ColorRow => ({
  id,
  product_id: 'p1',
  name_en,
  hex: '#000000',
  image: '',
  sku_part: '',
  sort: 0,
  active: 1,
  stock: null,
  reserved: 0,
  low_stock_threshold: null,
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  ...over,
});

const link = (color_id: string, option_value_id: string, group_id: string): ColorLinkRow => ({
  color_id,
  option_value_id,
  group_id,
});

test('a colour with NO links is visible with every selection', () => {
  const v = colorVisibility('c_free', [], { [G.printer]: 'v_a1' });
  assert.equal(v.visible, true);
  assert.deepEqual(v.pendingGroups, []);
});

test('one link: visible only for that value (OR of a single member)', () => {
  const links = [link('c_black', 'v_a1', G.printer)];
  assert.equal(colorVisibility('c_black', links, { [G.printer]: 'v_a1' }).visible, true);
  assert.equal(colorVisibility('c_black', links, { [G.printer]: 'v_p1s' }).visible, false);
});

test('two values in the SAME group are OR — either one shows the colour', () => {
  const links = [link('c_black', 'v_a1', G.printer), link('c_black', 'v_p1s', G.printer)];
  assert.equal(colorVisibility('c_black', links, { [G.printer]: 'v_a1' }).visible, true);
  assert.equal(colorVisibility('c_black', links, { [G.printer]: 'v_p1s' }).visible, true);
});

test('links in TWO groups are AND — both must match', () => {
  const links = [link('c_black', 'v_a1', G.printer), link('c_black', 'v_combo', G.bundle)];
  assert.equal(colorVisibility('c_black', links, { [G.printer]: 'v_a1', [G.bundle]: 'v_combo' }).visible, true);
  assert.equal(colorVisibility('c_black', links, { [G.printer]: 'v_a1', [G.bundle]: 'v_solo' }).visible, false);
  assert.equal(colorVisibility('c_black', links, { [G.printer]: 'v_p1s', [G.bundle]: 'v_combo' }).visible, false);
});

test("the mandate's own three-group example: A1 + Combo + EU only", () => {
  const links = [
    link('c_black', 'v_a1', G.printer),
    link('c_black', 'v_combo', G.bundle),
    link('c_black', 'v_eu', G.plug),
  ];
  const ok = { [G.printer]: 'v_a1', [G.bundle]: 'v_combo', [G.plug]: 'v_eu' };
  assert.equal(colorVisibility('c_black', links, ok).visible, true);
  for (const wrong of [
    { ...ok, [G.printer]: 'v_p1s' },
    { ...ok, [G.bundle]: 'v_solo' },
    { ...ok, [G.plug]: 'v_us' },
  ]) {
    assert.equal(colorVisibility('c_black', links, wrong).visible, false, JSON.stringify(wrong));
  }
});

test('a group the colour does not link into places no constraint', () => {
  const links = [link('c_black', 'v_a1', G.printer)];
  const v = colorVisibility('c_black', links, { [G.printer]: 'v_a1', [G.plug]: 'v_us' });
  assert.equal(v.visible, true);
});

test('an unanswered constrained group is reported as pending, not silently hidden', () => {
  const links = [link('c_black', 'v_a1', G.printer), link('c_black', 'v_combo', G.bundle)];
  const v = colorVisibility('c_black', links, { [G.printer]: 'v_a1' });
  assert.equal(v.visible, false);
  assert.deepEqual(v.pendingGroups, [G.bundle]);
  assert.deepEqual(v.conflictingGroups, []);
});

test('a conflicting group is reported separately from a pending one', () => {
  const links = [link('c_black', 'v_a1', G.printer), link('c_black', 'v_combo', G.bundle)];
  const v = colorVisibility('c_black', links, { [G.printer]: 'v_p1s' });
  assert.deepEqual(v.conflictingGroups, [G.printer]);
  assert.deepEqual(v.pendingGroups, [G.bundle]);
});

test('visibleColors filters and orders, and drops inactive colours', () => {
  const colors = [
    color('c_free', 'Free', { sort: 2 }),
    color('c_black', 'Black', { sort: 1 }),
    color('c_off', 'Retired', { sort: 0, active: 0 }),
  ];
  const links = [link('c_black', 'v_a1', G.printer)];
  const shown = visibleColors(colors, links, { [G.printer]: 'v_a1' });
  assert.deepEqual(shown.map((c) => c.id), ['c_black', 'c_free']);
  const other = visibleColors(colors, links, { [G.printer]: 'v_p1s' });
  assert.deepEqual(other.map((c) => c.id), ['c_free']);
});

// --------------------------------------------------------------- validation

test('a crafted request pairing a colour with the wrong option is rejected server-side', () => {
  const colors = [color('c_black', 'Black')];
  const links = [link('c_black', 'v_a1', G.printer)];
  const errors = validateSelection({
    groups: [groups[0]],
    values: values.filter((v) => v.group_id === G.printer),
    colors,
    links,
    selectedValueIds: ['v_p1s'],
    selectedColorId: 'c_black',
  });
  assert.ok(errors.includes('COLOR_OPTION_MISMATCH'));
});

test('every active group demands a choice', () => {
  const errors = validateSelection({
    groups,
    values,
    colors: [],
    links: [],
    selectedValueIds: ['v_a1'],
    selectedColorId: null,
  });
  assert.ok(errors.includes('OPTION_GROUP_REQUIRED'));
});

test('two values from ONE group is not a valid selection', () => {
  const errors = validateSelection({
    groups: [groups[0]],
    values: values.filter((v) => v.group_id === G.printer),
    colors: [],
    links: [],
    selectedValueIds: ['v_a1', 'v_p1s'],
    selectedColorId: null,
  });
  assert.ok(errors.includes('OPTION_GROUP_DUPLICATE_SELECTION'));
});

test('an inactive option value cannot be bought', () => {
  const vals = [val('v_a1', G.printer, 'A1', { active: 0 })];
  const errors = validateSelection({
    groups: [groups[0]],
    values: vals,
    colors: [],
    links: [],
    selectedValueIds: ['v_a1'],
    selectedColorId: null,
  });
  assert.ok(errors.includes('OPTION_VALUE_INACTIVE'));
});

test('a valid full selection produces no errors', () => {
  const colors = [color('c_black', 'Black')];
  const links = [
    link('c_black', 'v_a1', G.printer),
    link('c_black', 'v_combo', G.bundle),
    link('c_black', 'v_eu', G.plug),
  ];
  const errors = validateSelection({
    groups,
    values,
    colors,
    links,
    selectedValueIds: ['v_a1', 'v_combo', 'v_eu'],
    selectedColorId: 'c_black',
  });
  assert.deepEqual(errors, []);
});

// ------------------------------------------------------------- hex + prices

test('hex validation accepts #RGB and #RRGGBB and nothing else', () => {
  for (const good of ['#fff', '#FFFFFF', '#0a0b0c']) assert.equal(isValidHex(good), true, good);
  for (const bad of ['fff', '#ffff', 'rgb(0,0,0)', '#gggggg', '', null]) {
    assert.equal(isValidHex(bad), false, String(bad));
  }
  assert.equal(normalizeHex('#FFF'), '#ffffff');
});

test('the price ladder PRO <= PRIME <= Regular is enforced', () => {
  assert.deepEqual(
    validatePriceLadder(
      { regular_price_iqd: 100000, prime_price_iqd: 95000, pro_price_iqd: 90000, cost_iqd: 60000 },
      'Base'
    ),
    []
  );
  assert.equal(
    validatePriceLadder(
      { regular_price_iqd: 100000, prime_price_iqd: 110000, pro_price_iqd: null, cost_iqd: null },
      'Base'
    ).length,
    1
  );
  assert.equal(
    validatePriceLadder(
      { regular_price_iqd: 100000, prime_price_iqd: 90000, pro_price_iqd: 95000, cost_iqd: null },
      'Base'
    ).length,
    1,
    'PRO above PRIME inverts the ladder'
  );
});

test('a selling price identical to the cost is refused (§5)', () => {
  const errors = validatePriceLadder(
    { regular_price_iqd: 60000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: 60000 },
    'Base'
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /identical to the cost/);
});

test('non-integer and negative money is refused', () => {
  assert.ok(
    validatePriceLadder(
      { regular_price_iqd: 1000.5, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      'Base'
    ).length > 0
  );
  assert.ok(
    validatePriceLadder(
      { regular_price_iqd: -1, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      'Base'
    ).length > 0
  );
});

test('zero is a legal explicit price, not "blank"', () => {
  assert.deepEqual(
    validatePriceLadder(
      { regular_price_iqd: 0, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
      'Base'
    ),
    []
  );
});
