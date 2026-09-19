/**
 * TESTS 8 AND 10 OF THE MANDATE, stated as the owner stated them.
 *
 *   8. «علاقات الصور تنجو من TXT → apply → reload»
 *  10. «export → import round-trip لا يغيّر الأسعار المحسوبة للزبون»
 *
 * Test 10 is the one worth being careful about. It is easy to write a round
 * trip that compares STORED COLUMNS and passes while the customer's price
 * moves: the base+adjustment architecture means the same charge has more than
 * one stored spelling, and `normalizeCheapestBase` deliberately rewrites
 * between them. So this compares what `resolveUnitPrice` CHARGES — every
 * option, every colour, every tier — before and after the trip, which is the
 * only number a customer can feel.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, get, json, all, type App } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { productRoutes } from '../worker/routes/products';
import { hydrateRelations, type RelationsResponse } from '../src/components/adminProducts/form/model';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { resolveUnitPrice, type PricingProduct } from '../worker/lib/pricing';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/template', templateRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
  a.route('/api/products', productRoutes);
};

function setup() {
  const raw = freshDb();
  raw.prepare("INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('brd_bambu','bambu','بامبو','Bambu Lab')").run();
  return { raw, app: stubApp(asD1(raw), OWNER, mount) };
}

const apply = async (a: App, text: string, extra: Record<string, unknown> = {}) => {
  const res = await post(a, '/api/admin/template/apply', { text, mode: 'draft', confirm: true, ...extra });
  return { status: res.status, body: await json(res) };
};

/** The A1, priced the way the owner's real product is: a cheapest base and a
 *  Combo expressed as a surcharge over it, plus a colour that adds again. */
const TXT = `template_version=2
slug=roundtrip-a1
name_ar=إيه1
name_en=Bambu Lab A1
status=draft
price_iqd=725000
prime_price_iqd=711000
pro_price_iqd=625000
brand=bambu
images.1.id=img_hero
images.1.url=/files/products/catalog/gallery/hero00001.jpg
images.1.alt_en=Hero
images.1.primary=true
images.2.id=img_combo
images.2.url=/files/products/catalog/gallery/combo0002.jpg
images.2.alt_en=Combo shot
images.2.option_value_id=opt_combo
images.3.id=img_black
images.3.url=/files/products/catalog/gallery/black0003.jpg
images.3.alt_en=Black
images.3.color_id=col_black
options.1.id=opt_base
options.1.group=Model
options.1.name_ar=أساسي
options.1.name_en=A1
options.1.active=true
options.2.id=opt_combo
options.2.group=Model
options.2.name_ar=كومبو
options.2.name_en=A1 Combo
options.2.active=true
options.2.regular_price_iqd=+174000
colors.1.id=col_black
colors.1.name_ar=أسود
colors.1.name_en=Black
colors.1.hex=#000000
colors.1.option_ids=opt_base,opt_combo
colors.1.regular_price_iqd=+5000
colors.1.active=true
`;

async function formState(a: App, id: string) {
  const p = await json(await get(a, `/api/admin/products-v2/${id}`));
  const r = await json(await get(a, `/api/admin/products/${id}/relations`));
  assert.equal(p.success, true, JSON.stringify(p));
  return { doc: toEditorDoc(p.product), rel: hydrateRelations(r as unknown as RelationsResponse, p.product) };
}

/** The storefront's own view of the product — what pricing resolves from. */
async function pricingProduct(a: App, slug: string): Promise<PricingProduct> {
  const pub = await json(await get(a, `/api/products/${slug}`));
  assert.ok(pub.product, JSON.stringify(pub));
  return pub.product as PricingProduct;
}

/** Every price a customer could be charged on this product, as a flat map. */
function everyCharge(p: PricingProduct): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const tiers = [
    ['free', false],
    ['prime', true],
    ['pro', true],
  ] as const;
  const optionIds: Array<string | undefined> = [undefined, ...p.options.map((o) => o.id)];
  const colorIds: Array<string | undefined> = [undefined, ...p.colors.map((c) => c.id)];
  for (const [tier, active] of tiers) {
    for (const optionId of optionIds) {
      for (const colorId of colorIds) {
        const key = `${tier}/${optionId ?? '-'}/${colorId ?? '-'}`;
        try {
          out[key] = resolveUnitPrice({ product: p, optionId, colorId, tier, tierActive: active }).applied_iqd;
        } catch {
          out[key] = null; // an impossible combination stays impossible
        }
      }
    }
  }
  return out;
}

// ================================================================== test 8

test('8 — image relations survive TXT → apply → reload', async () => {
  const { raw, app } = setup();
  const created = await apply(app, TXT);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.product_id as string;

  // The ROWS, not the JSON mirror: a relation that lives only in the mirror is
  // one the storefront's relational read cannot see.
  const rows = all<{ id: string; option_value_id: string | null; color_id: string | null; is_primary: number }>(
    raw,
    'SELECT id, option_value_id, color_id, is_primary FROM product_images WHERE product_id = ? ORDER BY sort_order',
    id
  );
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.id === 'img_combo')?.option_value_id, 'opt_combo');
  assert.equal(rows.find((r) => r.id === 'img_black')?.color_id, 'col_black');
  assert.equal(rows.filter((r) => r.is_primary).length, 1, 'exactly one primary');
  assert.equal(rows.find((r) => r.is_primary)?.id, 'img_hero');

  // And the FORM sees the same links, through its own transform.
  const { rel } = await formState(app, id);
  assert.equal(rel.images.find((i) => i.id === 'img_combo')?.option_value_id, 'opt_combo');
  assert.equal(rel.images.find((i) => i.id === 'img_black')?.color_id, 'col_black');
  assert.equal(rel.images.find((i) => i.id === 'img_hero')?.is_primary, true);
  assert.equal(rel.images.find((i) => i.id === 'img_combo')?.is_primary, false);

  // And so does the customer.
  raw.prepare("UPDATE products SET status='active' WHERE id = ?").run(id);
  const pub = await pricingProduct(app, 'roundtrip-a1');
  const media = (pub as unknown as { media: Array<Record<string, unknown>> }).media ?? [];
  assert.equal(media.length, 3, 'the storefront receives all three');
  assert.equal(media.find((m) => m.id === 'img_combo')?.option_value_id, 'opt_combo');
});

// ================================================================= test 10

test('10 — export → import changes no price the customer can be charged', async () => {
  const { raw, app } = setup();
  const id = (await apply(app, TXT)).body.product_id as string;
  raw.prepare("UPDATE products SET status='active' WHERE id = ?").run(id);

  const before = everyCharge(await pricingProduct(app, 'roundtrip-a1'));
  // The base ladder is real, so the comparison has something to protect.
  assert.equal(before['free/opt_combo/-'], 899_000);
  assert.equal(before['prime/opt_combo/-'], 885_000);
  assert.equal(before['pro/opt_combo/-'], 799_000);
  assert.equal(before['free/opt_combo/col_black'], 904_000, 'the colour adds again, over the option');

  // The store's own export, re-imported over the same product.
  const res = await get(app, `/api/admin/template/export/${id}`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const back = await apply(app, text, { mode: 'update', id });
  assert.equal(back.status, 200, JSON.stringify(back.body));

  const after = everyCharge(await pricingProduct(app, 'roundtrip-a1'));
  assert.deepEqual(after, before, 'a round trip through the export moved a price');
});

test('10 — and the images and their links come back identical too', async () => {
  const { raw, app } = setup();
  const id = (await apply(app, TXT)).body.product_id as string;
  const shape = () =>
    all<{ id: string; url: string; option_value_id: string | null; color_id: string | null; is_primary: number }>(
      raw,
      'SELECT id, url, option_value_id, color_id, is_primary FROM product_images WHERE product_id = ? ORDER BY sort_order',
      id
    );
  const before = shape();
  const res = await get(app, `/api/admin/template/export/${id}`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.equal((await apply(app, text, { mode: 'update', id })).status, 200);
  assert.deepEqual(shape(), before);
});

test('10 — a round trip does not convert an adjustment into a frozen price', async () => {
  // This is the failure mode the architecture exists to prevent: if the export
  // wrote 899,000 as a fixed number, the Combo would stop following the base
  // and the next base change would silently leave it behind. The CHARGE would
  // be identical on the day of the trip, so only the STORAGE shape catches it.
  const { raw, app } = setup();
  const id = (await apply(app, TXT)).body.product_id as string;
  const res = await get(app, `/api/admin/template/export/${id}`);
  const text = await res.text();
  assert.equal((await apply(app, text, { mode: 'update', id })).status, 200, text);

  const combo = all<{ regular_price_iqd: number | null; regular_adjust_iqd: number | null }>(
    raw,
    'SELECT regular_price_iqd, regular_adjust_iqd FROM product_option_values WHERE id = ?',
    'opt_combo'
  )[0];
  assert.equal(combo.regular_price_iqd, null, 'still an adjustment, not a pin');
  assert.equal(combo.regular_adjust_iqd, 174_000);

  // And it still follows the base: raise the base, the Combo moves with it.
  raw.prepare('UPDATE products SET price_iqd = 800000 WHERE id = ?').run(id);
  raw.prepare("UPDATE products SET status='active' WHERE id = ?").run(id);
  const p = await pricingProduct(app, 'roundtrip-a1');
  assert.equal(
    resolveUnitPrice({ product: p, optionId: 'opt_combo', tier: 'free', tierActive: false }).applied_iqd,
    974_000,
    'the surcharge followed the new base'
  );
});
