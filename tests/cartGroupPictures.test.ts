/**
 * A COLOUR GROUP SHOWS EACH PICTURE ONCE (docs/ux/COLOUR-QUANTITIES.md §5.2, owner's screenshot 2026-10-17).
 *
 * «eSUN PLA+ Filament — 1 kg · الألوان: 3 · القطع: 56» showed a black spool in
 * its header, then the BLACK line showed the same black spool as its picture
 * AND as the dot beside its name: one picture three times. The header drew the
 * first line's SELECTION picture (`image`, the colour's photo) and the line's
 * title repeated its picture slot as a swatch.
 *
 * Now the header is the product's own main photo (`product_image`, new and
 * additive on the cart line), each line shows its colour once in its picture
 * slot — its photo, or its hex circle when it has none or when its photo IS
 * the header's — and its name carries no second dot.
 *
 * Run: node --import tsx --test tests/cartGroupPictures.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, post, stubApp } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { groupCartLines, groupPictures, type PicturedLine } from '../src/lib/cartGroups';
import { ColourTag } from '../src/components/product/ColourTag';

const MAIN = 'products/p_esun/main.webp';
const BLACK_IMG = 'products/p_esun/black.webp';
const WHITE_IMG = 'products/p_esun/white.webp';

function seed(mainIsBlack: boolean): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_esun','esun','eSUN PLA+ Filament — 1 kg','eSUN PLA+',24000,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','[]','COLOR');
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,sort,active,stock) VALUES
      ('c_black','p_esun','BLACK','BLACK','#000000',0,1,99),
      ('c_white','p_esun','COLD WHITE','COLD WHITE','#F4F7FA',1,1,99),
      ('c_beige','p_esun','BEIGE','BEIGE','#E8DCC4',2,1,99);
    INSERT INTO product_images (id, product_id, url, r2_key, content_type, sort_order, is_primary, color_id) VALUES
      ('img_black','p_esun','/files/${BLACK_IMG}','${BLACK_IMG}','image/webp',1,${mainIsBlack ? 1 : 0},'c_black'),
      ('img_white','p_esun','/files/${WHITE_IMG}','${WHITE_IMG}','image/webp',2,0,'c_white');
  `);
  if (!mainIsBlack) {
    raw.exec(`INSERT INTO product_images (id, product_id, url, r2_key, content_type, sort_order, is_primary, color_id)
              VALUES ('img_main','p_esun','/files/${MAIN}','${MAIN}','image/webp',0,1,NULL);`);
  }
  return raw;
}

type Line = PicturedLine & { productId: string; color_id: string; colors: Array<{ id: string }>; color_tag: { id: string; image: string; hex: string } | null };

async function groupOf(raw: DatabaseSync): Promise<Line[]> {
  const app = stubApp(asD1(raw), { id: 'u1', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/cart', cartRoutes));
  for (const [colorId, qty] of [['c_beige', 1], ['c_white', 5], ['c_black', 50]] as const) {
    const res = await post(app, '/api/cart/items', { productId: 'p_esun', optionValueIds: [], colorId, qty, fulfillmentType: 'direct_sale' });
    assert.equal(res.status, 200, JSON.stringify(await json(res.clone())).slice(0, 400));
  }
  const items = (await json(await get(app, '/api/cart'))).items as Line[];
  const entries = groupCartLines(items);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'group');
  return (entries[0] as { items: Line[] }).items;
}

test('the cart line carries the product\'s own main photo beside the selection\'s picture (additive)', async () => {
  const lines = await groupOf(seed(false));
  const black = lines.find((l) => l.color_id === 'c_black')!;
  assert.equal(black.image, `/files/${BLACK_IMG}`, 'the selection picture is the colour\'s photo, as before');
  assert.equal(black.product_image, `/files/${MAIN}`, 'the product\'s main photo, no selection');
});

test('§5.2: the header is the product photo; each colour shows once — its photo, else its hex circle', async () => {
  const lines = await groupOf(seed(false));
  assert.deepEqual(lines.map((l) => l.color_id), ['c_black', 'c_white', 'c_beige'], 'the product colour order');
  const { header, rows } = groupPictures(lines);
  assert.equal(header, `/files/${MAIN}`, 'never the first colour\'s photo');
  const by = (c: string) => rows.get(lines.find((l) => l.color_id === c)!.id)!;
  assert.deepEqual(by('c_black'), { image: `/files/${BLACK_IMG}`, hex: '#000000' });
  assert.deepEqual(by('c_white'), { image: `/files/${WHITE_IMG}`, hex: '#F4F7FA' });
  assert.deepEqual(by('c_beige'), { image: '', hex: '#E8DCC4' }, 'no photo of its own: the hex circle');
  // No picture twice in the group.
  const shown = [header, ...[...rows.values()].map((r) => r.image)].filter(Boolean);
  assert.equal(new Set(shown).size, shown.length);
});

test('§5.2: a product whose main photo IS its black spool shows it once — the BLACK line takes its hex circle', async () => {
  const lines = await groupOf(seed(true));
  const { header, rows } = groupPictures(lines);
  assert.equal(header, `/files/${BLACK_IMG}`);
  const black = rows.get(lines.find((l) => l.color_id === 'c_black')!.id)!;
  assert.deepEqual(black, { image: '', hex: '#000000' });
  const shown = [header, ...[...rows.values()].map((r) => r.image)].filter(Boolean);
  assert.equal(new Set(shown).size, shown.length, 'no picture twice');
});

test('an older Worker without product_image: the header falls back to the first line\'s picture, and that colour is not drawn again', () => {
  const lines: PicturedLine[] = [
    { id: 'a', image: '/files/black.webp', color_tag: { image: '/files/black.webp', hex: '#000' } },
    { id: 'b', image: '/files/white.webp', color_tag: { image: '/files/white.webp', hex: '#fff' } },
  ];
  const { header, rows } = groupPictures(lines);
  assert.equal(header, '/files/black.webp');
  assert.deepEqual(rows.get('a'), { image: '', hex: '#000' });
  assert.deepEqual(rows.get('b'), { image: '/files/white.webp', hex: '#fff' });
});

test('the grouped line\'s name carries no second dot; every other ColourTag keeps its swatch', () => {
  const without = renderToStaticMarkup(createElement(ColourTag, { name: 'BLACK', hex: '#000000', image: '/files/black.webp', swatch: false }));
  assert.ok(!without.includes('aria-hidden="true"') && !without.includes('black.webp'), without);
  assert.match(without, /<bdi[^>]*>BLACK<\/bdi>/);
  const withDot = renderToStaticMarkup(createElement(ColourTag, { name: 'BLACK', hex: '#000000' }));
  assert.match(withDot, /data-colour-swatch/);
});

test('Cart.tsx draws the group from groupPictures: header picture, one colour per line, no dot in the line title, 44 px targets kept', () => {
  const src = readFileSync(join(ROOT, 'src/pages/Cart.tsx'), 'utf8');
  const group = src.slice(src.indexOf('const renderColourGroup'), src.indexOf('if (merchantScope)'));
  assert.match(group, /const pictures = groupPictures\(lines\)/);
  assert.match(group, /src=\{pictures\.header\}/);
  assert.doesNotMatch(group, /src=\{first\.image\}/, 'the header never shows the first colour\'s photo');
  assert.match(group, /renderLine\(l, true, pictures\.rows\.get\(l\.id\)\)/);
  assert.match(group, /min-h-\[44px\]/, 'the group checkbox keeps its 44 px target');
  const line = src.slice(src.indexOf('const renderLine = '), src.indexOf('const renderColourGroup'));
  const title = line.slice(line.indexOf('data-cart-item-title className="mb-1"'), line.indexOf('</h3>'));
  assert.match(title, /swatch=\{false\}/, 'the grouped title shows the name without a second dot');
  assert.match(line, /<ColourSwatch hex=\{picture \? picture\.hex : item\.color_tag\.hex\} image=\{picture \? picture\.image : item\.color_tag\.image\} px=\{40\} \/>/);
  assert.match(line, /min-h-\[44px\]/, 'the line checkbox keeps its 44 px target');
});
