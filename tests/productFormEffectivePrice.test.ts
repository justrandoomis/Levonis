/**
 * «inherit» ON A ROW THE STOREFRONT CHARGES 899,000 FOR.
 *
 * THE DEFECT the owner reported, in their numbers. Bambu Lab A1: base Regular
 * 725,000, and the "A1 Combo" option sells for 899,000. Because the product's
 * own price must be the CHEAPEST sellable one, `normalizeCheapestBase` stores
 * the Combo as an ADJUSTMENT — `regular_price_iqd = null`,
 * `regular_adjust_iqd = 174000` — which is correct, is what the checkout
 * resolves from, and is what the customer is charged. The product form then
 * read the four `*_price_iqd` scalars raw, found NULL, and printed «inherit».
 * The price was never missing; the form was reading the wrong half of the pair.
 *
 * THE FIX IS NOT A SECOND FORMULA. `rowCells` / `rowLadder` (packages/pricing)
 * resolve one row through the SAME `priceMode` → `step` → `memberAtRung` →
 * `clampMemberLadder` chain as `buildGrid` and the checkout. This file pins
 * that they agree — a form that computed 899,000 its own way would be one
 * refactor away from disagreeing with the till.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rowCells,
  rowLadder,
  buildGrid,
  rowCharges,
  type GridProductInput,
} from '../worker/lib/priceGrid';
import { resolveUnitPrice, priceMode, type PricingProduct, type PriceFields } from '../worker/lib/pricing';
import { freshDb, asD1, stubApp, get, json, row, type App } from './fixtures/app';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { hydrateRelations, type RelationsResponse } from '../src/components/adminProducts/form/model';

// ------------------------------------------------- the A1, exactly as stored

/** The product's own four prices — the cheapest sellable variant. */
const A1_BASE = { regular: 725_000, prime: 711_000, pro: 625_000, cost: 435_938 };

/**
 * The A1 Combo AS THE DATABASE HOLDS IT: two adjustments and nothing else.
 * PRIME and PRO carry NO row of their own — they ride the regular surcharge,
 * which is the owner's rule that an option is an extra cost for every tier.
 */
const A1_COMBO: PriceFields = {
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  regular_adjust_iqd: 174_000,
  prime_adjust_iqd: null,
  pro_adjust_iqd: null,
  cost_adjust_iqd: 253_070,
};

// ------------------------------------------------------------ tests 1 – 4

test('1 — base 725,000 + adjustment 174,000 shows 899,000, not «inherit»', () => {
  const cells = rowCells(A1_COMBO, A1_BASE);
  assert.equal(cells.regular.effective, 899_000);
  assert.equal(cells.regular.mode, 'adjust', 'the mode is read from the row, and the row holds a delta');
  assert.equal(cells.regular.adjust, 174_000, 'the provenance line has a real number to print');
  assert.equal(cells.regular.inherited, 725_000, 'and the placeholder says what «يرث» would land on');
});

test('2 — PRIME carries the option surcharge: 711,000 → 885,000', () => {
  const cells = rowCells(A1_COMBO, A1_BASE);
  assert.equal(cells.prime.effective, 885_000);
  // It carries WITHOUT a prime row of its own. Before this fix the form showed
  // an empty box here and an admin could easily have "corrected" it by typing
  // the base 711,000 in — pinning the Combo's PRIME below its regular price.
  assert.equal(cells.prime.mode, 'inherit');
  assert.equal(cells.prime.inherited, 885_000, 'inheriting lands on the carried value, not on the bare base');
});

test('3 — PRO carries the same surcharge: 625,000 → 799,000', () => {
  const cells = rowCells(A1_COMBO, A1_BASE);
  assert.equal(cells.pro.effective, 799_000);
  assert.equal(cells.pro.mode, 'inherit');
});

test('4 — cost 435,938 + adjustment 253,070 shows 689,008', () => {
  const cells = rowCells(A1_COMBO, A1_BASE);
  assert.equal(cells.cost.effective, 689_008);
  assert.equal(cells.cost.mode, 'adjust');
});

test('the four numbers the owner named, together, from the adjustment form', () => {
  const cells = rowCells(A1_COMBO, A1_BASE);
  assert.deepEqual(
    { regular: cells.regular.effective, prime: cells.prime.effective, pro: cells.pro.effective, cost: cells.cost.effective },
    { regular: 899_000, prime: 885_000, pro: 799_000, cost: 689_008 }
  );
});

// ------------------------------------- the form and the till are one resolver

const a1Product = (): PricingProduct => ({
  price_iqd: A1_BASE.regular,
  prime_price_iqd: A1_BASE.prime,
  pro_price_iqd: A1_BASE.pro,
  product_cost_iqd: A1_BASE.cost,
  selling_type: 'direct_sale',
  sale_types: ['direct_sale'],
  options: [
    {
      id: 'combo',
      name_ar: 'A1 Combo',
      name_en: 'A1 Combo',
      name_ckb: 'A1 Combo',
      image: '',
      order: 0,
      active: true,
      ...A1_COMBO,
    },
  ] as PricingProduct['options'],
  colors: [],
  preorder_transports: [],
  warranty_plans: [],
});

test('what the form shows is what the checkout charges — every tier', () => {
  const p = a1Product();
  const cells = rowCells(A1_COMBO, A1_BASE);
  // 'prime' is the PLUS tier's wire name in the resolver (Tier), not 'plus'.
  const charged = (tier: 'free' | 'prime' | 'pro') =>
    resolveUnitPrice({ product: p, optionId: 'combo', tier, tierActive: tier !== 'free' }).applied_iqd;

  assert.equal(charged('free'), cells.regular.effective, 'regular');
  assert.equal(charged('prime'), cells.prime.effective, 'PRIME');
  assert.equal(charged('pro'), cells.pro.effective, 'PRO');
});

test('and what Quick Edit shows for the same row — one ladder, two screens', () => {
  const p = a1Product();
  const grid = buildGrid({
    price_iqd: p.price_iqd,
    prime_price_iqd: p.prime_price_iqd,
    pro_price_iqd: p.pro_price_iqd,
    product_cost_iqd: p.product_cost_iqd,
    selling_type: p.selling_type,
    sale_types: p.sale_types,
    options: p.options as GridProductInput['options'],
    colors: [],
  });
  const quick = grid.find((r) => r.id === 'combo');
  assert.ok(quick);
  const form = rowCells(A1_COMBO, A1_BASE);
  for (const f of ['regular', 'prime', 'pro', 'cost'] as const) {
    assert.equal(form[f].effective, quick.cells[f].effective, `${f}: the product form and Quick Edit disagree`);
    assert.equal(form[f].mode, quick.cells[f].mode, `${f}: the two screens name a different mode`);
  }
});

// ------------------------------------------------ a colour under an option

test('a colour hanging under an option is measured over the OPTION, not the base', () => {
  // +10,000 for the textured plate colourway, on top of the Combo's 899,000.
  const colour: PriceFields = {
    regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
    regular_adjust_iqd: 10_000, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
  };
  const beneath = rowLadder(A1_COMBO, A1_BASE);
  const cells = rowCells(colour, beneath);
  assert.equal(cells.regular.effective, 909_000, '899,000 + 10,000, not 725,000 + 10,000');
  assert.equal(cells.prime.effective, 895_000, 'the member tiers carry the colour surcharge too');
  assert.equal(cells.pro.effective, 809_000);
});

test('a colour inherits its option UNCLAMPED — the clamp is the last word on the picked line only', () => {
  // An option whose PRIME sits ABOVE its regular price. `rowCells` clamps the
  // displayed PRIME down to the regular price, because that is what the
  // customer is charged for THAT line. But `buildGrid` hands the colour the
  // RAW value, so `rowLadder` must too — otherwise the form would price a
  // colour from a number the resolver never carried.
  const odd: PriceFields = {
    regular_price_iqd: 100_000, prime_price_iqd: 150_000, pro_price_iqd: null, cost_iqd: null,
    regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
  };
  const base = { regular: 100_000, prime: 90_000, pro: 80_000, cost: null };
  assert.equal(rowCells(odd, base).prime.effective, 100_000, 'shown clamped to the regular price');
  assert.equal(rowLadder(odd, base).prime, 150_000, 'carried raw to the next rung');

  // And that is exactly what buildGrid does, so the two agree by construction.
  const grid = buildGrid({
    price_iqd: 100_000, prime_price_iqd: 90_000, pro_price_iqd: 80_000, product_cost_iqd: null,
    options: [{ id: 'o', ...odd }] as GridProductInput['options'],
    colors: [{ id: 'c', option_id: 'o', regular_adjust_iqd: 5_000 }] as unknown as GridProductInput['colors'],
  });
  const colourRow = grid.find((r) => r.id === 'c');
  assert.ok(colourRow);
  const viaHelper = rowCells(
    { regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, regular_adjust_iqd: 5_000 },
    rowLadder(odd, base)
  );
  assert.equal(viaHelper.regular.effective, colourRow.cells.regular.effective);
  assert.equal(viaHelper.prime.effective, colourRow.cells.prime.effective);
});

// ------------------------------------------------- an untouched row is inert

test('a row that carries nothing shows what it inherits, and says it inherits it', () => {
  const cells = rowCells(
    { regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null },
    A1_BASE
  );
  assert.equal(cells.regular.effective, 725_000);
  assert.equal(cells.regular.mode, 'inherit');
  assert.equal(cells.regular.adjust, null, 'nothing for the provenance line to invent');
});

test('a null row (no prices object at all) resolves to the values beneath', () => {
  const cells = rowCells(null, A1_BASE);
  assert.equal(cells.regular.effective, 725_000);
  assert.equal(cells.cost.effective, 435_938);
  assert.equal(cells.regular.mode, 'inherit');
});


// ============================================================ test 9, end to end
//
// «قيمة ثابتة معدّلة من الواجهة تلغي التعديل المتعارض بشكل صحيح».
//
// TWO HALVES, and both are needed. The FORM half is that `PriceCells.commit`
// writes `{ [column]: v, [adjustment]: null }`, so a number typed into the box
// pins the row and drops the delta in the same patch. The SERVER half is that
// `readPrices` collapses the pair regardless of who sent it — because the TXT
// import writes through the same planner and a hand-authored template can
// perfectly well carry both.
//
// Why it matters that the SERVER does it: `priceMode` already answers 'fixed'
// while both are set, so the stale adjustment is invisible — right up until
// someone clears the fixed price to make the row inherit again, at which point
// a delta nobody typed starts moving the price.

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
};

const put = (a: App, path: string, body: unknown) =>
  a.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify(body),
  });

test('9 — a save carrying BOTH a fixed price and an adjustment stores only the fixed price', async () => {
  const raw = freshDb();
  const db = asD1(raw);
  const app = stubApp(db, OWNER, mount);

  const made = await json(
    await app.request('/api/admin/products-v2', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({
        name_en: 'A1', name_ar: 'إيه1', price_iqd: A1_BASE.regular,
        prime_price_iqd: A1_BASE.prime, pro_price_iqd: A1_BASE.pro, status: 'draft',
      }),
    })
  );
  assert.equal(made.success, true, JSON.stringify(made));
  const id = made.product.id as string;

  // Exactly the contradiction: the row already priced as base+174,000, and a
  // client that pins 899,000 without clearing the delta.
  const res = await put(app, `/api/admin/products/${id}/relations`, {
    inventory_mode: 'BASE',
    groups: [
      {
        id: 'g1', name_en: 'Model', sort: 0, active: true,
        values: [
          {
            id: 'v_combo', name_en: 'A1 Combo', sort: 0, active: true,
            regular_price_iqd: 899_000, regular_adjust_iqd: 174_000,
            cost_iqd: 689_008, cost_adjust_iqd: 253_070,
          },
        ],
      },
    ],
    colors: [], variants: [], images: [],
  });
  assert.equal(res.status, 200, await res.text());

  const stored = row<{ regular_price_iqd: number | null; regular_adjust_iqd: number | null; cost_iqd: number | null; cost_adjust_iqd: number | null }>(
    raw,
    'SELECT regular_price_iqd, regular_adjust_iqd, cost_iqd, cost_adjust_iqd FROM product_option_values WHERE id = ?',
    'v_combo'
  );
  assert.ok(stored, 'the option value was written');
  assert.equal(stored.regular_price_iqd, 899_000);
  assert.equal(stored.regular_adjust_iqd, null, 'the contradicting delta was dropped, not stored beside it');
  assert.equal(stored.cost_iqd, 689_008);
  assert.equal(stored.cost_adjust_iqd, null);

  // And the mode is unambiguous rather than "fixed, but with a landmine".
  assert.equal(priceMode(stored, 'regular_price_iqd'), 'fixed');

  // Clearing the fixed price later returns the row to plain inheritance — the
  // failure this collapse prevents is that it would return to base + 174,000.
  const cleared = await put(app, `/api/admin/products/${id}/relations`, {
    inventory_mode: 'BASE',
    groups: [
      {
        id: 'g1', name_en: 'Model', sort: 0, active: true,
        values: [{ id: 'v_combo', name_en: 'A1 Combo', sort: 0, active: true }],
      },
    ],
    colors: [], variants: [], images: [],
  });
  assert.equal(cleared.status, 200, await cleared.text());
  const after = row<{ regular_price_iqd: number | null; regular_adjust_iqd: number | null }>(
    raw,
    'SELECT regular_price_iqd, regular_adjust_iqd FROM product_option_values WHERE id = ?',
    'v_combo'
  );
  assert.deepEqual({ ...after }, { regular_price_iqd: null, regular_adjust_iqd: null });

  // The form now reads that row back as plain inheritance at the base price —
  // through `hydrateRelations`, the transform ProductForm actually runs over
  // the GET, not over a hand-shaped stand-in for it.
  const p = await json(await get(app, `/api/admin/products-v2/${id}`));
  const rel = hydrateRelations(await json(await get(app, `/api/admin/products/${id}/relations`)) as unknown as RelationsResponse, p.product);
  const value = rel.groups[0].values[0];
  assert.equal(value.regular_price_iqd, null, 'the form state carries no fixed price');
  assert.equal(value.regular_adjust_iqd ?? null, null, 'and no resurrected delta');
  assert.equal(rowCells(value as PriceFields, A1_BASE).regular.effective, A1_BASE.regular);
});

test('an adjustment ALONE survives the same round trip untouched', async () => {
  // The collapse must not be a quiet migration to fixed prices: the
  // base+adjustment shape is the intended one, and this is what proves the
  // rule only fires on a genuine contradiction.
  const raw = freshDb();
  const db = asD1(raw);
  const app = stubApp(db, OWNER, mount);
  const made = await json(
    await app.request('/api/admin/products-v2', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({ name_en: 'A1', name_ar: 'إيه1', price_iqd: A1_BASE.regular, status: 'draft' }),
    })
  );
  const id = made.product.id as string;
  const res = await put(app, `/api/admin/products/${id}/relations`, {
    inventory_mode: 'BASE',
    groups: [
      {
        id: 'g1', name_en: 'Model', sort: 0, active: true,
        values: [{ id: 'v_combo', name_en: 'A1 Combo', sort: 0, active: true, regular_adjust_iqd: 174_000 }],
      },
    ],
    colors: [], variants: [], images: [],
  });
  assert.equal(res.status, 200, await res.text());
  const stored = row<{ regular_price_iqd: number | null; regular_adjust_iqd: number | null }>(
    raw,
    'SELECT regular_price_iqd, regular_adjust_iqd FROM product_option_values WHERE id = ?',
    'v_combo'
  );
  assert.deepEqual({ ...stored }, { regular_price_iqd: null, regular_adjust_iqd: 174_000 });
  assert.equal(rowCells(stored as PriceFields, A1_BASE).regular.effective, 899_000);
});


// ============================================ the form is wired to the resolver
//
// There is no DOM in this suite, so the wiring is pinned the way
// `tests/adminProductHydration.test.ts` pins it: by reading the component
// source. These assertions are cheap and they catch the exact regression this
// round fixed — a future edit that goes back to rendering the four
// `*_price_iqd` scalars raw, or that reimplements the ladder locally.

test('OptionsSection resolves through the shared helper and never re-implements the ladder', () => {
  const src = readFileSync(new URL('../src/components/adminProducts/form/OptionsSection.tsx', import.meta.url), 'utf8');

  assert.match(src, /rowCells\(prices as PriceFields, beneath\)/, 'the cells come from the shared resolver');
  // The box holds what the tier is CHARGED, which is `cell.effective` plus the
  // resolver's member fallback — see `chargedAt` and the test below it.
  assert.match(src, /value=\{charged\}/, 'the box holds the RESOLVED number, not the stored scalar');
  assert.match(src, /beneath=\{base\}/, 'an option is measured over the product base');
  assert.match(src, /beneath=\{beneathColor\(c\)\}/, 'a colour is measured over its option');
  assert.match(src, /rowLadder\(parent as PriceFields, base\)/, 'and it inherits the option UNCLAMPED');

  // One typed number must write BOTH halves of the pair.
  assert.match(
    src,
    /onChange\(\{ \[col\]: v, \[ADJUST_OF\[col\]\]: null \}/,
    'a typed fixed price must clear the adjustment beside it'
  );

  // And the arithmetic must not be here. A local `+ adjust` in this file is the
  // second implementation the shared helper exists to prevent.
  assert.ok(
    !/_adjust_iqd\s*[)\]]*\s*[+-]/.test(src),
    'OptionsSection is doing price arithmetic of its own'
  );
});

test('ProductForm feeds the section the LIVE base price, not the loaded one', () => {
  const src = readFileSync(new URL('../src/components/adminProducts/ProductForm.tsx', import.meta.url), 'utf8');
  assert.match(src, /regular: doc\.price_iqd/, 'the base comes from the editor document');
  assert.match(src, /prime: doc\.prime_price_iqd/);
  assert.match(src, /pro: doc\.pro_price_iqd/);
  assert.match(src, /cost: doc\.product_cost_iqd/);
  // `loadedBasePrice` is the PinnedPriceNotice's snapshot of what was saved. If
  // the ladder were fed from it, raising the base in section 4 would leave every
  // inheriting option showing yesterday's number until the page was reloaded.
  assert.ok(!/regular: loadedBasePrice/.test(src), 'the ladder must follow the live edit');
});


// ==================== the exhaustive cross-check against the real resolver
//
// The four numbered tests above pin the owner's own product. This one asks the
// broader question they stand for — *does the editor ever show a number the
// till would not charge?* — over every shape crossed with every base, and it
// is how the defect below was found rather than argued about.
//
// THE DEFECT IT CAUGHT. `Cell.effective` is null for a member cell whose row
// states no price for that tier. That is correct for the ladder, and
// `previewBulk` depends on it — null is how "this row has no PRO price of its
// own" stays distinguishable from "its PRO price happens to equal the regular
// one", and folding them together would make a bulk «raise PRO by 10,000» pin
// a PRO number onto every row that never had one.
//
// But it is NOT what the customer pays. `resolveUnitPrice` falls back:
//   `if (isPro && proIqd !== null) …` — when it IS null, the member is charged
// `regularIqd`. Most products leave `prime_price_iqd` and `pro_price_iqd` null
// at the base, so on most products EVERY member cell resolved to null while a
// PLUS customer was being charged the full regular price. Rendering that as an
// empty box is the same defect this whole round is about.
//
// So the ladder keeps its null and the editor asks `chargedAt`.

const SHAPES: Array<{ name: string; row: PriceFields }> = [
  { name: 'adjust only', row: { regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, regular_adjust_iqd: 174_000 } },
  { name: 'fixed only', row: { regular_price_iqd: 899_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null } },
  { name: 'negative adjustment', row: { regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, regular_adjust_iqd: -100_000 } },
  { name: 'PRIME pinned over an adjusted regular', row: { regular_price_iqd: null, prime_price_iqd: 800_000, pro_price_iqd: null, cost_iqd: null, regular_adjust_iqd: 174_000 } },
  { name: 'PRO above the regular price', row: { regular_price_iqd: 100_000, prime_price_iqd: null, pro_price_iqd: 500_000, cost_iqd: null } },
  { name: 'PRIME below PRO', row: { regular_price_iqd: 900_000, prime_price_iqd: 600_000, pro_price_iqd: 700_000, cost_iqd: null } },
  { name: 'a member adjustment', row: { regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, prime_adjust_iqd: -20_000 } },
  { name: 'nothing at all', row: { regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null } },
];

const BASES: Array<{ name: string; base: Record<'regular' | 'prime' | 'pro' | 'cost', number | null> }> = [
  { name: 'full member ladder', base: { regular: 725_000, prime: 711_000, pro: 625_000, cost: 435_938 } },
  { name: 'NO member prices (the common product)', base: { regular: 725_000, prime: null, pro: null, cost: null } },
  { name: 'PRIME only', base: { regular: 725_000, prime: 700_000, pro: null, cost: null } },
  { name: 'PRO only', base: { regular: 725_000, prime: null, pro: 600_000, cost: null } },
  { name: 'a free product', base: { regular: 0, prime: null, pro: null, cost: null } },
];

test('the editor never shows a number the till would not charge — every shape × every base', () => {
  const mismatches: string[] = [];
  for (const b of BASES) {
    for (const s of SHAPES) {
      const product: PricingProduct = {
        price_iqd: b.base.regular ?? 0,
        prime_price_iqd: b.base.prime,
        pro_price_iqd: b.base.pro,
        product_cost_iqd: b.base.cost,
        selling_type: 'direct_sale',
        sale_types: ['direct_sale'],
        options: [
          { id: 'o', name_ar: 'o', name_en: 'o', name_ckb: 'o', image: '', order: 0, active: true, ...s.row },
        ] as PricingProduct['options'],
        colors: [],
        preorder_transports: [],
        warranty_plans: [],
      };
      const charges = rowCharges(s.row, b.base, 'option');
      for (const [tier, field] of [['free', 'regular'], ['prime', 'prime'], ['pro', 'pro']] as const) {
        const charged = resolveUnitPrice({ product, optionId: 'o', tier, tierActive: tier !== 'free' }).applied_iqd;
        const shown = charges[field].charged;
        if (charged !== shown) {
          mismatches.push(`[${b.name}] [${s.name}] ${tier}: the till charges ${charged}, the form shows ${shown}`);
        }
      }
    }
  }
  assert.deepEqual(mismatches, [], `${mismatches.length} of ${BASES.length * SHAPES.length * 3} combinations disagree`);
});

test('a member tier with no price of its own is shown the regular price, and told why', () => {
  // The exact case the cross-check caught. A product with no PRIME price:
  // a PLUS customer pays the full 899,000, so that is what the cell shows.
  const beneath = { regular: 725_000, prime: null, pro: null, cost: null };
  const cells = rowCells(A1_COMBO, beneath);
  const charges = rowCharges(A1_COMBO, beneath, 'option');
  assert.equal(cells.prime.effective, null, 'the LADDER still says "this row states no PRIME price"');
  assert.equal(charges.prime.charged, 899_000, 'but the EDITOR shows what a PLUS member is charged');
  assert.equal(charges.prime.viaRegular, true, 'and flags it, so it does not read as a discount');
  assert.equal(charges.pro.viaRegular, true);
  // Regular and cost never fall back — there is nothing above them to fall to.
  assert.equal(charges.regular.viaRegular, false);
  assert.equal(charges.cost.viaRegular, false);
  assert.equal(charges.cost.charged, null, 'an unknown cost stays unknown, never 0 and never the price');
});

test('the ladder keeps its null, so a bulk edit still cannot pin a price nobody set', () => {
  // The reason `chargedAt` is a separate function and not a change to
  // `Cell.effective`. previewBulk reads `cell.effective` to decide whether a
  // row HAS a value to move; if the fallback lived there, «raise PRO by
  // 10,000» would silently give a PRO price to every row that never had one.
  const cells = rowCells(A1_COMBO, { regular: 725_000, prime: null, pro: null, cost: null });
  assert.equal(cells.pro.effective, null);
  assert.equal(cells.pro.inherited, null);
});

test('the form renders the charged number, not the raw ladder value', () => {
  const src = readFileSync(new URL('../src/components/adminProducts/form/OptionsSection.tsx', import.meta.url), 'utf8');
  assert.match(src, /value=\{charged\}/, 'the box holds what the tier is charged');
  assert.match(src, /charged: charges\[field\]\.charged/);
  assert.match(src, /viaRegular: charges\[field\]\.viaRegular/);
  assert.match(src, /rowCharges\(prices as PriceFields, beneath, level\)/, 'and it is told which rung this row is');
  assert.match(src, /data-price-mode=\{viaRegular \? 'regular-fallback' : 'inherit'\}/, 'and says which it is');
});

// ============ THE ZERO THAT ISN'T A PRICE (adversarial review, finding 1)
//
// The exhaustive cross-check above ran over shapes that never produced a
// member value of exactly 0. A 200,000-shape randomised sweep did, and it
// disagreed with the till on 37,036 of them — all one cause.
//
// `resolveUnitPrice` walks base → option → COLOUR for a member price, and it
// walks the colour rung even when the customer picked no colour (`pickMember`,
// `row = null`). `memberAtRung` then treats a carried value of zero or less as
// NO MEMBER PRICE:  `inherited + regularDelta > 0 ? … : null`. So a PRIME of
// exactly 0 on an OPTION is erased on the way to the till and the member is
// charged the full regular price — while the same 0 on a COLOUR is charged as
// 0, because the colour is the last rung.
//
// A 0 is reachable: `Money` treats it as a real price on purpose, `validateForm`
// accepts it, and the relations route stores it.

test('a PRIME of 0 on an OPTION is not a price — the member pays the regular one', () => {
  const base = { regular: 725_000, prime: 711_000, pro: null, cost: null };
  const row: PriceFields = {
    regular_price_iqd: null, prime_price_iqd: 0, pro_price_iqd: null, cost_iqd: null,
    regular_adjust_iqd: 174_000,
  };
  const charges = rowCharges(row, base, 'option');
  assert.equal(charges.regular.charged, 899_000);
  assert.equal(charges.prime.charged, 899_000, 'the 0 is erased by the colour rung and PRIME pays regular');
  assert.equal(charges.prime.viaRegular, true, 'and the form says so');

  // The till agrees.
  const product: PricingProduct = {
    price_iqd: base.regular, prime_price_iqd: base.prime, pro_price_iqd: base.pro, product_cost_iqd: base.cost,
    selling_type: 'direct_sale', sale_types: ['direct_sale'],
    options: [{ id: 'o', name_ar: 'o', name_en: 'o', name_ckb: 'o', image: '', order: 0, active: true, ...row }] as PricingProduct['options'],
    colors: [], preorder_transports: [], warranty_plans: [],
  };
  assert.equal(resolveUnitPrice({ product, optionId: 'o', tier: 'prime', tierActive: true }).applied_iqd, 899_000);
});

test('the same 0 on a COLOUR is charged as 0 — the colour is the last rung', () => {
  const base = { regular: 725_000, prime: 711_000, pro: null, cost: null };
  const colour: PriceFields = {
    regular_price_iqd: null, prime_price_iqd: 0, pro_price_iqd: null, cost_iqd: null,
  };
  assert.equal(rowCharges(colour, base, 'color').prime.charged, 0, 'nothing carries it further');
  assert.equal(rowCharges(colour, base, 'color').prime.viaRegular, false);
  // …and this is exactly why the level is part of the question.
  assert.equal(rowCharges(colour, base, 'option').prime.charged, 725_000);
});

test('the clamp runs AFTER the carry, as it does in the resolver', () => {
  // The case a first version of this got wrong. The row's PRIME resolves to 0
  // and its PRO to 45,024. Clamping first would raise PRIME up to PRO and show
  // 45,024; the resolver carries first, the 0 becomes null, and PRIME pays the
  // regular price.
  const base = { regular: 363_264, prime: null, pro: null, cost: null };
  const row: PriceFields = {
    regular_price_iqd: 112_224, prime_price_iqd: null, pro_price_iqd: 45_024, cost_iqd: null,
    prime_adjust_iqd: -144_576,
  };
  const product: PricingProduct = {
    price_iqd: base.regular, prime_price_iqd: null, pro_price_iqd: null, product_cost_iqd: null,
    selling_type: 'direct_sale', sale_types: ['direct_sale'],
    options: [{ id: 'o', name_ar: 'o', name_en: 'o', name_ckb: 'o', image: '', order: 0, active: true, ...row }] as PricingProduct['options'],
    colors: [], preorder_transports: [], warranty_plans: [],
  };
  const charges = rowCharges(row, base, 'option');
  assert.equal(resolveUnitPrice({ product, optionId: 'o', tier: 'prime', tierActive: true }).applied_iqd, 112_224);
  assert.equal(charges.prime.charged, 112_224, 'clamp-then-carry would have shown 45,024');
});

test('a randomised sweep finds no shape where the editor and the till disagree', () => {
  // 200,000 shapes × 3 tiers. Deterministic (an LCG, not Math.random), so a
  // failure is reproducible from the seed printed in the message.
  let seed = 20260909;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const maybe = (n: number) => (rnd(3) === 0 ? null : rnd(n));
  const signed = (n: number) => (rnd(3) === 0 ? null : rnd(2 * n) - n);
  // Only shapes the database can hold: `readPrices` collapses a contradictory
  // fixed+adjustment pair on every write path.
  const collapse = (price: number | null, adjust: number | null) => (price === null ? adjust : null);

  const bad: string[] = [];
  for (let i = 0; i < 200_000 && bad.length < 3; i += 1) {
    const base = { regular: rnd(900_000), prime: maybe(900_000), pro: maybe(900_000), cost: maybe(500_000) };
    const row: PriceFields = {
      regular_price_iqd: maybe(900_000), prime_price_iqd: maybe(900_000),
      pro_price_iqd: maybe(900_000), cost_iqd: maybe(500_000),
      regular_adjust_iqd: signed(200_000), prime_adjust_iqd: signed(200_000),
      pro_adjust_iqd: signed(200_000), cost_adjust_iqd: signed(200_000),
    };
    row.regular_adjust_iqd = collapse(row.regular_price_iqd, row.regular_adjust_iqd ?? null);
    row.prime_adjust_iqd = collapse(row.prime_price_iqd, row.prime_adjust_iqd ?? null);
    row.pro_adjust_iqd = collapse(row.pro_price_iqd, row.pro_adjust_iqd ?? null);
    row.cost_adjust_iqd = collapse(row.cost_iqd, row.cost_adjust_iqd ?? null);

    const charges = rowCharges(row, base, 'option');
    for (const [tier, field] of [['free', 'regular'], ['prime', 'prime'], ['pro', 'pro']] as const) {
      const product: PricingProduct = {
        price_iqd: base.regular, prime_price_iqd: base.prime, pro_price_iqd: base.pro, product_cost_iqd: base.cost,
        selling_type: 'direct_sale', sale_types: ['direct_sale'],
        options: [{ id: 'o', name_ar: 'o', name_en: 'o', name_ckb: 'o', image: '', order: 0, active: true, ...row }] as PricingProduct['options'],
        colors: [], preorder_transports: [], warranty_plans: [],
      };
      const charged = resolveUnitPrice({ product, optionId: 'o', tier, tierActive: tier !== 'free' }).applied_iqd;
      if (charged !== charges[field].charged) {
        bad.push(`${tier}: till ${charged} vs form ${charges[field].charged} | base ${JSON.stringify(base)} row ${JSON.stringify(row)}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'the editor shows a number the till does not charge');
});

// ============== the rest of the adversarial review's product-form findings

test('every price input keeps its label — `Field` cannot wire a two-child cell', () => {
  // `Field` clones its generated id onto its child only when that child is a
  // SINGLE element (`React.isValidElement(children)`). The price cell has two
  // — the input and the provenance line — so `children` is an array, no clone
  // happens, and `<label htmlFor>` would point at nothing: three or four
  // inputs per option value and per colour with no accessible name.
  const src = readFileSync(new URL('../src/components/adminProducts/form/OptionsSection.tsx', import.meta.url), 'utf8');
  assert.match(src, /const inputId = useId\(\);/, 'the cell mints its own id');
  assert.match(src, /<Field ar=\{label_ar\} en=\{label_en\} tip=\{tip\} htmlFor=\{inputId\}>/, 'and tells the label');
  assert.match(src, /<Money\s+id=\{inputId\}/, 'and the input answers to it');

  const ui = readFileSync(new URL('../src/components/adminProducts/form/formUi.tsx', import.meta.url), 'utf8');
  assert.match(ui, /React\.isValidElement\(children\) && !htmlFor/, 'the clone rule that makes this necessary');
});

test('a colour linked to several options says its price moves with them', () => {
  const src = readFileSync(new URL('../src/components/adminProducts/form/OptionsSection.tsx', import.meta.url), 'utf8');
  // It resolves under the FIRST linked option — a price really charged for a
  // real combination — instead of the base, which is charged for none of them.
  assert.match(src, /const parent = c\.option_value_ids\.map\(\(id\) => optionById\.get\(id\)\)\.find\(Boolean\);/);
  assert.match(src, /data-color-price-spread/, 'and the range is disclosed');
  assert.match(src, /spread=\{colorSpread\(c\)\}/);
});

test('the colour spread is the set of prices the colour really takes', () => {
  // base 725,000; option A adds nothing, option B adds 174,000; the colour
  // adds 5,000 on top of whichever the customer picked.
  const base = { regular: 725_000, prime: null, pro: null, cost: null };
  const optionA: PriceFields = { regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null };
  const optionB: PriceFields = { regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, regular_adjust_iqd: 174_000 };
  const colour: PriceFields = { regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, regular_adjust_iqd: 5_000 };

  const under = (opt: PriceFields) => rowCharges(colour, rowLadder(opt, base), 'color').regular.charged;
  assert.equal(under(optionA), 730_000);
  assert.equal(under(optionB), 904_000);
  // Neither is 730,000-because-base: the old fallback showed a number the
  // customer is charged only when option A happens to be picked, with nothing
  // on screen saying so.
  assert.notEqual(under(optionA), under(optionB), 'the two differ, which is what the warning is for');
});

test('a combination price clears its twin adjustment, like every other cell', () => {
  const src = readFileSync(new URL('../src/components/adminProducts/form/OptionsSection.tsx', import.meta.url), 'utf8');
  assert.match(src, /\[key\]: value, \[ADJUST_OF\[key\]\]: null/, 'the variants table pins the pair too');
  assert.match(src, /onChange=\{\(n\) => setVariantPrice\(v\.id, k, n\)\}/);
  // The raw spread that created the contradiction must not come back.
  assert.ok(!/variants: r\.variants\.map\(\(x\) => \(x\.id === v\.id \? \{ \.\.\.x, \[k\]: n \} : x\)\)/.test(src));
});
