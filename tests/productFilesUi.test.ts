/**
 * FILES ON PRODUCTS, ON THE SCREEN (docs/COMMUNITY_ECOSYSTEM.md §9.4, Phase 4
 * client 2) — the storefront block (src/components/storefront/ProductFiles.tsx),
 * the merchant editor (src/components/merchant/catalog/ProductFilesEditor.tsx)
 * and the seam between them and the server.
 *
 *   the words: every key in ar, en AND real Sorani, in both tables;
 *   the decisions: rows grouped by role in the reading order, what a row
 *     offers (view / download / «يتاح بعد الشراء» / a name), the size label,
 *     the default role of a new file, a move at the edge, the picker's types;
 *   the render (`renderToStaticMarkup`): the roles' names, a guest sees no
 *     download and reads the sentence, a granted row shows the button with the
 *     door's own URL, a preview with a mesh offers the viewer;
 *   the mint: opening the viewer asks the door for a token for THAT file id;
 *   the server: the public list carries `granted` — false for a guest, true
 *     for the owner — beside `downloadable`;
 *   the pins: the block is a lazy chunk of the product page, the editor a lazy
 *     chunk of the product form, the tile uploads with purpose product_file,
 *     the storefront block speaks the store's vocabulary (no app tokens, no
 *     inline style, no dark: variants, no hex), the editor no dark:/hex.
 *
 * Run: node --import tsx --test tests/productFilesUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { freshDb, asD1, stubApp, post, get, json, hasColumn, memoryBucket, type StubUser, type Mount } from './fixtures/app';
import { seedCatalog } from './fixtures/catalog';
import { LanguageProvider } from '../src/LanguageContext';
import { STOREFRONT_STRINGS } from '../src/components/storefront/strings';
import { PRODUCT_FILES_STRINGS } from '../src/components/merchant/catalog/strings';
import ProductFiles, { ROLE_ORDER, bytesLabel, groupByRole, openViewer, rowAction, type FilesDoor, type StorefrontFile } from '../src/components/storefront/ProductFiles';
import { ACCEPTED_EXTENSIONS, acceptsFile, defaultRole, moved } from '../src/components/merchant/catalog/ProductFilesEditor';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantCatalogRoutes } from '../worker/routes/merchantCatalog';
import { merchantProductFileRoutes, publicProductFileRoutes } from '../worker/routes/productFiles';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

// ------------------------------------------------------------------ words

/** A table flattened to `a.b.c` → text; functions are called with a sample, arrays indexed. */
function flat(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function') out[`${prefix}${k}`] = String((v as (a: number, b: number) => string)(3, 12));
    else if (v && typeof v === 'object') Object.assign(out, flat(v as Record<string, unknown>, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = String(v);
  }
  return out;
}

test('both tables carry every key in ar, en and ckb, and the Sorani is Sorani — never the Arabic pasted across', () => {
  for (const [name, table] of [
    ['storefront files', { ar: STOREFRONT_STRINGS.ar.files, en: STOREFRONT_STRINGS.en.files, ckb: STOREFRONT_STRINGS.ckb.files }],
    ['editor', PRODUCT_FILES_STRINGS],
  ] as const) {
    const ar = flat(table.ar as unknown as Record<string, unknown>);
    const en = flat(table.en as unknown as Record<string, unknown>);
    const ckb = flat(table.ckb as unknown as Record<string, unknown>);
    assert.ok(Object.keys(ar).length >= 12, `${name}: a real table`);
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort(), `${name}: en carries every key`);
    assert.deepEqual(Object.keys(ckb).sort(), Object.keys(ar).sort(), `${name}: ckb carries every key`);
    for (const k of Object.keys(ar)) {
      assert.ok(ar[k].trim() && en[k].trim() && ckb[k].trim(), `${name}: ${k} is empty somewhere`);
      assert.notEqual(ckb[k], ar[k], `${name}: ckb.${k} is the Arabic pasted across`);
      assert.match(ckb[k], /[؀-ۿ]/, `${name}: ckb.${k} is written in the Sorani script`);
    }
  }
  // The five roles read the same on the shopfront and in the editor.
  for (const l of ['ar', 'en', 'ckb'] as const) {
    assert.deepEqual(STOREFRONT_STRINGS[l].files.roles, PRODUCT_FILES_STRINGS[l].roles, `${l}: one vocabulary for the roles`);
  }
  assert.equal(STOREFRONT_STRINGS.ar.files.view3d, 'عرض ثلاثي الأبعاد');
  assert.equal(STOREFRONT_STRINGS.ar.files.afterPurchase, 'يتاح بعد الشراء');
});

// -------------------------------------------------------------- decisions

const file = (over: Partial<StorefrontFile> & Pick<StorefrontFile, 'id' | 'role'>): StorefrontFile => ({
  name: `${over.id}.stl`,
  bytes: 1024,
  kind: 'model',
  has_preview: false,
  downloadable: false,
  ...over,
});

const FOUR: StorefrontFile[] = [
  file({ id: 'f_guide', role: 'instruction', name: 'Printing guide.pdf', kind: 'document', bytes: 812_000 }),
  file({ id: 'f_prev', role: 'preview', name: 'dragon-preview.stl', has_preview: true, bytes: 2_516_582 }),
  file({ id: 'f_print', role: 'download_after_purchase', name: 'dragon-printable.3mf', bytes: 41_943_040 }),
  file({ id: 'f_ref', role: 'reference', name: 'Assembly reference.pdf', kind: 'document', bytes: 640 }),
];

test('rows group by role in the reading order (what a shopper can do first), empty roles dropped, merchant order kept inside a role', () => {
  assert.deepEqual([...ROLE_ORDER], ['preview', 'download_after_purchase', 'source_model', 'reference', 'instruction']);
  const groups = groupByRole(FOUR);
  assert.deepEqual(
    groups.map((g) => [g.role, g.files.map((f) => f.id)]),
    [
      ['preview', ['f_prev']],
      ['download_after_purchase', ['f_print']],
      ['reference', ['f_ref']],
      ['instruction', ['f_guide']],
    ]
  );
  const two = groupByRole([file({ id: 'b', role: 'reference' }), file({ id: 'a', role: 'reference' })]);
  assert.deepEqual(two[0].files.map((f) => f.id), ['b', 'a'], 'the merchant’s order inside a role');
  assert.deepEqual(groupByRole([]), []);
});

test('what a row offers: a preview is viewed (with a mesh) and never downloaded; every other role downloads only when the server says so', () => {
  assert.equal(rowAction({ role: 'preview', has_preview: true, downloadable: false }), 'view');
  assert.equal(rowAction({ role: 'preview', has_preview: false, downloadable: false }), 'name_only');
  // A buyer holds the preview too (granted) — still a view, never a download.
  assert.equal(rowAction({ role: 'preview', has_preview: true, downloadable: false, granted: true }), 'view');
  for (const role of ['download_after_purchase', 'source_model', 'reference', 'instruction'] as const) {
    assert.equal(rowAction({ role, has_preview: false, downloadable: false }), 'after_purchase', role);
    assert.equal(rowAction({ role, has_preview: false, downloadable: true }), 'download', role);
    // An older server answering only `granted`.
    assert.equal(rowAction({ role, has_preview: false, downloadable: false, granted: true }), 'download', role);
  }
});

test('the size label counts in the language’s own units', () => {
  const ar = STOREFRONT_STRINGS.ar.files.units;
  assert.equal(bytesLabel(640, ar), '640 بايت');
  assert.equal(bytesLabel(812_000, ar), '793 ك.ب');
  assert.equal(bytesLabel(70_000, ar), '68.4 ك.ب');
  assert.equal(bytesLabel(41_943_040, STOREFRONT_STRINGS.en.files.units), '40.0 MB');
  assert.equal(bytesLabel(2_516_582, STOREFRONT_STRINGS.ckb.files.units), '2.4 مێگابایت');
  assert.equal(bytesLabel(-5, ar), '0 بايت');
  assert.equal(bytesLabel(Number.NaN, ar), '0 بايت');
});

test('the editor’s decisions: the picker’s types, the default role of a new file, a move at the edge', () => {
  assert.deepEqual([...ACCEPTED_EXTENSIONS], ['stl', 'obj', '3mf', 'amf', 'glb', 'gltf', 'step', 'stp', 'pdf']);
  assert.ok(acceptsFile('Dragon.STL') && acceptsFile('guide.pdf') && acceptsFile('part.step'));
  assert.ok(!acceptsFile('photo.jpg') && !acceptsFile('archive.zip') && !acceptsFile('noext'));
  // The first model is the 3D preview; every later model is the printable; a document is instructions.
  assert.equal(defaultRole('dragon.stl', []), 'preview');
  assert.equal(defaultRole('dragon.3mf', [{ role: 'preview' }]), 'download_after_purchase');
  assert.equal(defaultRole('dragon.3mf', [{ role: 'reference' }]), 'preview');
  assert.equal(defaultRole('guide.pdf', []), 'instruction');
  assert.deepEqual(moved(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moved(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c'], 'the first row cannot move up');
  assert.deepEqual(moved(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c'], 'the last row cannot move down');
});

// ---------------------------------------------------------------- render

const html = (node: ReactNode) => renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }));

function door(calls: string[] = []): FilesDoor {
  return {
    viewerToken: async (slug, productId, fileId) => {
      calls.push(`${slug}/${productId}/${fileId}`);
      return { url: `/model-viewer/tok-${fileId}` };
    },
    downloadUrl: (slug, productId, fileId) => `/api/product-files/${slug}/${productId}/${fileId}/download`,
  };
}

test('the block renders the roles by name; a guest sees no download button and reads «يتاح بعد الشراء»; a preview with a mesh offers the viewer', () => {
  const out = html(createElement(ProductFiles, { slug: 'ali3d', productId: 'p1', files: FOUR, door: door() }));
  assert.match(out, /data-product-files/);
  assert.match(out, /الملفات/);
  for (const role of ['معاينة', 'تنزيل بعد الشراء', 'مرجع', 'تعليمات']) assert.match(out, new RegExp(role), role);
  assert.ok(!out.includes('ملف المصدر'), 'a role with no file is not drawn');
  assert.equal((out.match(/data-product-file="/g) ?? []).length, 4, 'four rows');
  assert.equal((out.match(/data-view-3d="f_prev"/g) ?? []).length, 1, 'one viewer button, on the preview');
  assert.match(out, /عرض ثلاثي الأبعاد/);
  assert.equal((out.match(/data-download=/g) ?? []).length, 0, 'a guest gets no download button');
  assert.ok(!out.includes('/download'), 'nor the download URL');
  assert.equal((out.match(/يتاح بعد الشراء/g) ?? []).length, 3, 'the three purchasable files say so');
  // Names, sizes, never a key.
  assert.match(out, /dragon-printable\.3mf/);
  assert.match(out, /40\.0 م\.ب/);
  assert.ok(!/merchants\//.test(out) && !/file_key/.test(out));
  // Reading order: the preview group comes before the instruction group.
  assert.ok(out.indexOf('data-file-role="preview"') < out.indexOf('data-file-role="instruction"'));
});

test('a granted row shows the download button pointing at the door’s attachment URL; the preview stays a view', () => {
  const granted = FOUR.map((f) => ({ ...f, granted: true, downloadable: f.role !== 'preview' }));
  const out = html(createElement(ProductFiles, { slug: 'ali3d', productId: 'p1', files: granted, door: door() }));
  assert.equal((out.match(/data-download=/g) ?? []).length, 3, 'three download buttons');
  assert.match(out, /href="\/api\/product-files\/ali3d\/p1\/f_print\/download"/);
  assert.match(out, /href="\/api\/product-files\/ali3d\/p1\/f_guide\/download"/);
  assert.ok(!out.includes('يتاح بعد الشراء'), 'nothing left to buy for');
  assert.equal((out.match(/data-view-3d="f_prev"/g) ?? []).length, 1);
  assert.ok(!out.includes('data-download="f_prev"'), 'the preview is never a download');
  assert.match(out, /download=""/, 'the anchor is a download, not a navigation');
});

test('a product without files, or with only a meshless preview, draws the block without a dead control', () => {
  assert.equal(html(createElement(ProductFiles, { slug: 's', productId: 'p', files: [], door: door() })), '');
  const out = html(createElement(ProductFiles, { slug: 's', productId: 'p', files: [file({ id: 'x', role: 'preview' })], door: door() }));
  assert.match(out, /data-file-action="name_only"/);
  assert.ok(!out.includes('data-view-3d') && !out.includes('data-download'));
});

test('opening the viewer mints a token for THAT file through the door and answers where it opens', async () => {
  const calls: string[] = [];
  const url = await openViewer(door(calls), 'ali3d', 'p1', 'f_prev');
  assert.deepEqual(calls, ['ali3d/p1/f_prev']);
  assert.equal(url, '/model-viewer/tok-f_prev');
});

// ---------------------------------------------------------------- server

const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const PDF_KEY = 'merchants/ali/product-files/guide.pdf';
const mount: Mount = (a) => {
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/merchant', merchantCatalogRoutes);
  a.route('/api/merchant', merchantProductFileRoutes);
  a.route('/api/product-files', publicProductFileRoutes);
};

test('the public list says `granted` beside `downloadable`: false for a guest, true for the owner', async () => {
  const raw = freshDb();
  seedCatalog(raw);
  const purpose = hasColumn(raw, 'file_objects', 'purpose');
  raw.exec(
    purpose
      ? `INSERT INTO file_objects (object_key,visibility,domain,owner_id,mime_type,byte_size,purpose) VALUES ('${PDF_KEY}','private','merchants','ali','application/pdf',15,'product_file')`
      : `INSERT INTO file_objects (object_key,visibility,domain,owner_id,mime_type,byte_size) VALUES ('${PDF_KEY}','private','merchants','ali','application/pdf',15)`
  );
  const bucket = memoryBucket();
  const as = (user: StubUser | null) => stubApp(asD1(raw), user, mount, { env: { BUCKET: bucket } });
  const created = await post(as(ALI), '/api/merchant/products', { name: 'Dragon STL', price_iqd: 10_000, state: 'published', track_stock: true, stock: 5 });
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const pid = (await json(created)).product.id as string;
  const attached = await post(as(ALI), `/api/merchant/products/${pid}/files`, { file_key: PDF_KEY, role: 'instruction', name: 'Printing guide' });
  assert.equal(attached.status, 201, JSON.stringify(await attached.clone().json()));

  const guest = await json(await get(as(null), `/api/product-files/ali3d/${pid}`));
  assert.equal(guest.files.length, 1);
  assert.equal(guest.files[0].granted, false);
  assert.equal(guest.files[0].downloadable, false);
  assert.equal(guest.files[0].file_key, undefined, 'never a key');

  const owner = await json(await get(as(ALI), `/api/product-files/ali3d/${pid}`));
  assert.equal(owner.files[0].granted, true);
  assert.equal(owner.files[0].downloadable, true);
  assert.equal(rowAction(owner.files[0]), 'download');
  assert.equal(rowAction(guest.files[0]), 'after_purchase');
});

// ------------------------------------------------------------------ pins

test('the block is a lazy chunk of the product page, mounted only when the product has files, with the doors injected', () => {
  const page = read('src/pages/StorefrontProduct.tsx');
  assert.match(page, /lazy\(\(\) => import\('\.\.\/components\/storefront\/ProductFiles'\)\)/);
  assert.match(page, /storefrontFilesApi\s*\.list\(slug, productId\)/);
  assert.match(page, /files\.length > 0 && \(\s*<Suspense fallback=\{null\}>\s*<ProductFiles slug=\{slug\} productId=\{product\.id\} files=\{files\} door=\{storefrontFilesApi\}/);
});

test('the storefront block speaks the store’s vocabulary: sf-* classes, no app tokens, no inline style, no dark: variant, no hex', () => {
  const src = code('src/components/storefront/ProductFiles.tsx');
  assert.match(src, /sf-card sf-card-pad/);
  assert.match(src, /sf-row/);
  assert.match(src, /sf-title/);
  for (const banned of [/text-text-/, /bg-surface/, /border-border-subtle/, /bg-canvas/, /style=\{/, /dark:/, /#[0-9a-fA-F]{3,8}\b/, /from '\.\.\/\.\.\/lib\/api'/]) {
    assert.ok(!banned.test(src), `ProductFiles.tsx: ${banned}`);
  }
  // A guest is never offered the download door by this file's own decision — the server's answer decides.
  assert.match(src, /f\.downloadable \|\| f\.granted/);
});

test('the editor is a lazy chunk of the product form, opened from the «الملفات» section, and uploads through the shared tile with purpose product_file', () => {
  const sheet = read('src/components/merchant/catalog/ProductEditorSheet.tsx');
  assert.match(sheet, /const ProductFilesEditor = lazy\(\(\) => import\('\.\/ProductFilesEditor'\)\)/);
  assert.match(sheet, /testId="files"/);
  assert.match(sheet, /<ProductFilesEditor productId=\{original\.id\} disabled=\{busy\} \/>/);
  const editor = code('src/components/merchant/catalog/ProductFilesEditor.tsx');
  assert.match(editor, /<UploadTile file=\{p\.file\} purpose="product_file" entityId=\{productId\}/);
  assert.match(editor, /productFilesApi\.add\(productId, \{ file_key: result\.key/);
  assert.match(editor, /productFilesApi\.reorder\(/);
  assert.match(editor, /apiRefusal\(/, 'refusals read as sentences');
  assert.match(editor, /useConfirm\(\)/, 'a removal is confirmed with its consequence');
  for (const banned of [/dark:/, /#[0-9a-fA-F]{3,8}\b/, /price/i]) assert.ok(!banned.test(editor), `ProductFilesEditor.tsx: ${banned}`);
  // The one inline style is the caption's 28px start inset (icon + gap): no `ps-7` utility exists in src/, and the stylesheet budget is full.
  assert.equal((editor.match(/style=\{/g) ?? []).length, 1);
  // Every button inside the product form is a plain button: the shared Button defaults to type="button", the raw ones say so.
  for (const m of editor.matchAll(/<button\b[^>]*>/g)) assert.match(m[0], /type="button"/);
});
