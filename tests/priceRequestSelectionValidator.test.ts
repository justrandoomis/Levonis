/**
 * `validatePriceRequestSelection(db, productId, selection)` — THE PRICE-REQUEST
 * DOOR'S VALIDATION, ON ITS OWN (DECISIONS row 240; spec §4.3 steps 3–6; the
 * Bambu import spec §K.1 D-5 and §I.1.10).
 *
 * `POST /api/price-requests` runs it before it writes anything
 * (tests/priceRequestsRoutes.test.ts holds the door), and the import's
 * `/complete` calls it directly for each product's default selection and each
 * selection it checked: eligible for a complete selection, SELECTION_REQUIRED
 * for an incomplete one. Here it is called with no door around it, and proves
 * it is READ-ONLY: no request row, no stats row, no money or stock row is
 * created, and a database without 0193's tables validates the same.
 *
 * The world is the door's (tests/fixtures/catalogOnly.ts): the H2D shown and
 * unpriced (two models × two colours; White sold with the Combo only, Red
 * retired, an old model merged away), the Snapmaker U1 shown and unpriced with
 * no option at all, the A1 priced.
 *
 * Run: node --import tsx --test tests/priceRequestSelectionValidator.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all } from './fixtures/app';
import { P } from './fixtures/liveCatalog';
import { CAT, CAT_SEL, catalogOnlyWorld, moneyCounts, type CatalogOnlyWorld } from './fixtures/catalogOnly';
import { validatePriceRequestSelection, type PriceRequestSelectionInput } from '../worker/lib/priceRequests';

const U1 = P.U1;

async function build(opts: { without0193?: boolean } = {}): Promise<CatalogOnlyWorld> {
  const w = await catalogOnlyWorld({ alsoUnpriced: [U1] });
  w.raw.exec(`
    INSERT INTO product_color_option_links (color_id, option_value_id, group_id) VALUES ('${CAT_SEL.white}', '${CAT_SEL.combo}', 'g_cat_model');
    INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active) VALUES ('c_cat_red', '${CAT.id}', 'Red', 'أحمر', 'سوور', '#ff0000', 2, 0);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, merged_into)
      VALUES ('v_cat_old', '${CAT.id}', 'g_cat_model', 'H2D 2024', 'H2D 2024', 'H2D 2024', 2, 1, '${CAT_SEL.std}');
    INSERT INTO products (id, slug, name, status, price_iqd) VALUES ('p_other', 'other-draft', 'Other', 'draft', 0);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_other', 'p_other', 'Size', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('v_other', 'p_other', 'g_other', 'Big', 0, 1);
    -- Held by the owner's switch for a catalogue gap (no picture): hidden.
    INSERT INTO product_completeness (product_id, complete, held, missing_json, missing_count, computed_at)
      VALUES ('${P.A2L}', 0, 1, '[{"c":"IMAGE","o":""}]', 1, '2026-10-15T00:00:00.000Z');
  `);
  if (opts.without0193) w.raw.exec('DROP TABLE product_price_requests; DROP TABLE product_price_request_stats;');
  return w;
}
let shared: Promise<CatalogOnlyWorld> | null = null;
const world = () => (shared ??= build());

const sel = (value: string, color: string): PriceRequestSelectionInput => ({ option_value_ids: [value], color_id: color });

/** Everything a request could write: its rows, its stats, and every money and stock table. */
function footprint(w: CatalogOnlyWorld) {
  return {
    requests: all(w.raw, 'SELECT * FROM product_price_requests ORDER BY id'),
    stats: all(w.raw, 'SELECT * FROM product_price_request_stats ORDER BY product_id'),
    money: moneyCounts(w.raw),
  };
}

test('a complete selection of a shown, unpriced product is eligible, with its canonical SKU key — and nothing is written', async () => {
  const w = await world();
  const before = footprint(w);
  const combo = await validatePriceRequestSelection(w.db, CAT.id, sel(CAT_SEL.combo, CAT_SEL.white));
  assert.deepEqual(combo, {
    ok: true,
    product_id: CAT.id,
    key: CAT_SEL.key(CAT_SEL.combo, CAT_SEL.white),
    option_value_ids: [CAT_SEL.combo],
    color_id: CAT_SEL.white,
    sellable: false,
  });
  const std = await validatePriceRequestSelection(w.db, CAT.id, sel(CAT_SEL.std, CAT_SEL.grey));
  assert.equal(std.ok && std.key, CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey));
  assert.deepEqual(footprint(w), before, 'no request row, no stats row, no money or stock row');
});

test('an incomplete selection is SELECTION_REQUIRED (the import\'s /complete reads this for a partial default)', async () => {
  const w = await world();
  for (const [why, s] of [
    ['nothing chosen', {}],
    ['the colour is missing', { option_value_ids: [CAT_SEL.std] }],
    ['the model is missing', { color_id: CAT_SEL.grey }],
  ] as const) {
    assert.deepEqual(await validatePriceRequestSelection(w.db, CAT.id, s), { ok: false, status: 400, code: 'PRICE_REQUEST_SELECTION_REQUIRED' }, why);
  }
});

test('anything that is not one of the product\'s SKUs is SELECTION_INVALID', async () => {
  const w = await world();
  const invalid = { ok: false, status: 400, code: 'PRICE_REQUEST_SELECTION_INVALID' };
  for (const [why, s] of [
    ['another product’s value', sel('v_other', CAT_SEL.grey)],
    ['an invented value', sel('v_nope', CAT_SEL.grey)],
    ['a retired colour', sel(CAT_SEL.std, 'c_cat_red')],
    ['White is not sold with the standard model', sel(CAT_SEL.std, CAT_SEL.white)],
    ['a merged value', sel('v_cat_old', CAT_SEL.grey)],
    ['a non-text id', { option_value_ids: [CAT_SEL.std, 7], color_id: CAT_SEL.grey }],
    ['a colour that is not text', { option_value_ids: [CAT_SEL.std], color_id: 7 }],
    ['an id past the door\'s bound', { option_value_ids: ['v'.repeat(61)], color_id: CAT_SEL.grey }],
  ] as const) {
    assert.deepEqual(await validatePriceRequestSelection(w.db, CAT.id, s as PriceRequestSelectionInput), invalid, why);
  }
});

test('a product with no option is the key \'\'; a selection sent for it is refused, never read as something else', async () => {
  const w = await world();
  const u1 = await validatePriceRequestSelection(w.db, U1, {});
  assert.equal(u1.ok && u1.key, '');
  assert.deepEqual(await validatePriceRequestSelection(w.db, U1, { color_id: CAT_SEL.grey }), { ok: false, status: 400, code: 'PRICE_REQUEST_SELECTION_INVALID' });
});

test('a priced, sellable product is ALREADY_PRICED; a hidden one, a draft and an invented id are the same not-found', async () => {
  const w = await world();
  assert.deepEqual(await validatePriceRequestSelection(w.db, P.A1, {}), { ok: false, status: 409, code: 'PRICE_REQUEST_ALREADY_PRICED', key: '' });
  for (const id of [P.A2L, 'p_other', 'prd_does_not_exist']) {
    assert.deepEqual(await validatePriceRequestSelection(w.db, id, {}), { ok: false, status: 404, code: 'PRODUCT_NOT_FOUND' }, id);
  }
});

test('it reads only the catalogue: a database without 0193\'s tables validates the same', async () => {
  const w = await build({ without0193: true });
  const combo = await validatePriceRequestSelection(w.db, CAT.id, sel(CAT_SEL.combo, CAT_SEL.white));
  assert.equal(combo.ok, true);
  assert.deepEqual(await validatePriceRequestSelection(w.db, CAT.id, { option_value_ids: [CAT_SEL.combo] }), { ok: false, status: 400, code: 'PRICE_REQUEST_SELECTION_REQUIRED' });
});
