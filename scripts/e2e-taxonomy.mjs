#!/usr/bin/env node
/**
 * The taxonomy admin, exercised against a running worker — the owner's
 * «لا يوجد زر او قسم او صفحة في الادارة لادارة التصنيف» request:
 *
 *   1. sections     add a main section (with a template family), a
 *                   sub-section that inherits it, edit, toggle, delete —
 *                   deactivated when products or children use it;
 *   2. brands       add, edit, delete — deactivated when products use it;
 *   3. filters      add with a new kind, delete;
 *   4. hashtags     add, auto-registration from a product save, rename that
 *                   rewrites the product, adopt an unlisted tag, strip, delete;
 *   5. the template a new section / brand / filter / hashtag is an accepted
 *                   value in the very next template download (CSV lookup
 *                   block, ZIP lookups.csv + README) and in /import/lookups;
 *   6. import       a sheet with a hashtags column sets the product's tags
 *                   and registers a new tag in the vocabulary.
 *
 * Nothing is mocked: it registers an admin, promotes it with real SQL, and
 * writes to the LOCAL database it is pointed at. Never run it against
 * production data.
 *
 *   BASE_URL=http://127.0.0.1:8787 node scripts/e2e-taxonomy.mjs
 */
import { execSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

let passed = 0;
let failed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class Client {
  constructor() {
    this.cookie = '';
  }
  async raw(method, p, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    const res = await fetch(BASE + p, { method, headers: h, body });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    return res;
  }
  async json(method, p, body) {
    const res = await this.raw(method, p, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  }
  get(p) {
    return this.json('GET', p);
  }
  post(p, b) {
    return this.json('POST', p, b);
  }
  put(p, b) {
    return this.json('PUT', p, b);
  }
  del(p) {
    return this.json('DELETE', p);
  }
  async upload(p, filename, bytes, fields) {
    const form = new FormData();
    form.set('file', new File([bytes], filename));
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const res = await this.raw('POST', p, { body: form });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  }
}

function sql(statement) {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' });
}

function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (rows) => rows.map((r) => r.map((c) => q(String(c ?? ''))).join(',')).join('\r\n');

const rnd = Math.random().toString(36).slice(2, 8);

async function main() {
  console.log(`\nLEVONIS taxonomy admin — ${BASE}\n`);

  const admin = new Client();
  const email = `tax-${rnd}@test.local`;
  const password = 'taxonomy-pass-1';
  let r = await admin.post('/api/auth/register', { email, username: `tax${rnd}`, name: 'Taxonomy Admin', password });
  check('admin account created', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  sql(`UPDATE users SET role='admin' WHERE email='${email}'`);
  r = await admin.post('/api/auth/login', { email, password });
  check('admin signed in', r.status === 200);

  const anon = new Client();
  r = await anon.get('/api/admin/taxonomy/hashtags');
  check('the taxonomy API refuses an anonymous caller', r.status === 401 || r.status === 403, `status=${r.status}`);

  // ------------------------------------------------------------ 1. sections
  console.log('\n1. sections');
  r = await admin.post('/api/admin/taxonomy/catalogs', { name_en: `E2E Section ${rnd}`, name_ar: `قسم ${rnd}`, template_family: 'devices', sort: 900 });
  const rootId = r.data?.catalog?.id;
  const rootSlug = r.data?.catalog?.slug;
  check('main section created with a family', r.status === 200 && r.data?.created === true && !!rootId, JSON.stringify(r.data).slice(0, 160));
  r = await admin.post('/api/admin/taxonomy/catalogs', { name_en: `E2E Sub ${rnd}`, name_ar: `فرعي ${rnd}`, parent_id: rootId });
  const subId = r.data?.catalog?.id;
  const subSlug = r.data?.catalog?.slug;
  check('sub-section created under it', r.status === 200 && !!subId && r.data?.catalog?.parent_id === rootId);
  let cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const sub = cats.find((c) => c.id === subId);
  check('sub-section inherits the family', sub?.effective_template_family === 'devices' && sub?.template_family === null, JSON.stringify(sub).slice(0, 160));
  r = await admin.post('/api/admin/taxonomy/catalogs', { id: rootId, name_en: `E2E Section ${rnd} renamed`, sort: 901 });
  check('section edited (rename + sort)', r.status === 200 && r.data?.created === false && r.data?.catalog?.name_en.endsWith('renamed') && r.data?.catalog?.sort === 901);
  r = await admin.post('/api/admin/taxonomy/catalogs', { id: subId, active: false });
  cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  check('section deactivated through the editor', cats.find((c) => c.id === subId)?.active === false);
  r = await admin.post('/api/admin/taxonomy/catalogs', { id: subId, active: true });
  check('and re-activated', r.status === 200 && r.data?.catalog?.active === 1);
  check('a partial update keeps the names', r.data?.catalog?.name_en === `E2E Sub ${rnd}` && r.data?.catalog?.name_ar === `فرعي ${rnd}`, JSON.stringify(r.data?.catalog).slice(0, 160));
  r = await admin.post('/api/admin/taxonomy/catalogs', { id: subId, name_ar: '' });
  check('an EXPLICIT empty Arabic name clears it (absent keeps, empty clears)', r.status === 200 && r.data?.catalog?.name_ar === '' && r.data?.catalog?.name_en === `E2E Sub ${rnd}`, JSON.stringify(r.data?.catalog).slice(0, 160));
  r = await admin.post('/api/admin/taxonomy/catalogs', { id: subId, name_ar: `فرعي ${rnd}` });
  r = await admin.post('/api/admin/taxonomy/catalogs', { id: subId, name_en: '' });
  check('the English name can never be blanked', r.status === 400, `status=${r.status}`);
  r = await admin.post('/api/admin/taxonomy/catalogs', { id: rootId, parent_id: subId });
  check('a loop in the tree is refused', r.status === 400, `status=${r.status}`);

  // ------------------------------------------------------------- 2. brands
  console.log('\n2. brands');
  r = await admin.post('/api/admin/taxonomy/brands', { name_en: `E2E Brand ${rnd}`, name_ar: `علامة ${rnd}` });
  const brandId = r.data?.brand?.id;
  const brandSlug = r.data?.brand?.slug;
  check('brand created', r.status === 200 && !!brandId);
  r = await admin.post('/api/admin/taxonomy/brands', { name_en: `E2E Throwaway ${rnd}` });
  const brand2 = r.data?.brand?.id;
  r = await admin.del(`/api/admin/taxonomy/brands/${brand2}`);
  check('an unused brand is deleted for good', r.status === 200 && r.data?.deleted === true, JSON.stringify(r.data));
  const brands = (await admin.get('/api/admin/taxonomy/brands')).data?.brands ?? [];
  check('and is gone from the list', !brands.some((b) => b.id === brand2));
  r = await admin.del('/api/admin/taxonomy/brands/brd_does_not_exist');
  check('deleting a missing brand is a 404', r.status === 404);

  // a product that USES the section, sub-section and brand
  const typedTag = `typed-${rnd}`;
  r = await admin.post('/api/admin/products-v2', {
    name_en: `E2E Taxonomy Product ${rnd}`,
    name_ar: `منتج ${rnd}`,
    price_iqd: 15000,
    status: 'draft',
    category_id: rootId,
    sub_category_id: subId,
    brand_id: brandId,
    hashtags: [typedTag, 'PLA'],
    sale_types: ['direct_sale'],
    media: [],
  });
  const productId = r.data?.product?.id;
  check('a product in the new section with the new brand', r.status === 200 && !!productId, JSON.stringify(r.data).slice(0, 200));

  r = await admin.del(`/api/admin/taxonomy/brands/${brandId}`);
  check('a brand on a product is deactivated, not deleted', r.status === 200 && r.data?.deleted === false && r.data?.deactivated === true && r.data?.products === 1, JSON.stringify(r.data));
  r = await admin.post('/api/admin/taxonomy/brands', { id: brandId, active: true });
  check('brand re-activated for the template checks', r.status === 200 && r.data?.brand?.active === 1);
  check('the brand keeps its English name through the toggle', r.data?.brand?.name_en === `E2E Brand ${rnd}`, JSON.stringify(r.data?.brand).slice(0, 160));

  r = await admin.del(`/api/admin/taxonomy/catalogs/${subId}`);
  check('a sub-section with a product is deactivated, not deleted', r.status === 200 && r.data?.deleted === false && r.data?.reason === 'IN_USE' && r.data?.products === 1, JSON.stringify(r.data));
  r = await admin.post('/api/admin/taxonomy/catalogs', { id: subId, active: true });
  r = await admin.del(`/api/admin/taxonomy/catalogs/${rootId}`);
  check('a main section with children is deactivated, not deleted', r.status === 200 && r.data?.deleted === false && r.data?.children === 1, JSON.stringify(r.data));
  r = await admin.post('/api/admin/taxonomy/catalogs', { id: rootId, active: true });
  r = await admin.post('/api/admin/taxonomy/catalogs', { name_en: `E2E Empty ${rnd}` });
  const emptyId = r.data?.catalog?.id;
  r = await admin.del(`/api/admin/taxonomy/catalogs/${emptyId}`);
  check('an unused section is deleted for good', r.status === 200 && r.data?.deleted === true);

  // ------------------------------------------------------------ 3. filters
  console.log('\n3. filters');
  r = await admin.post('/api/admin/taxonomy/facets', { name_en: `E2E Filter ${rnd}`, name_ar: `فلتر ${rnd}`, kind: `e2e_kind_${rnd}` });
  const facetId = r.data?.facet?.id;
  const facetSlug = r.data?.facet?.slug;
  check('filter created with a new kind', r.status === 200 && !!facetId && r.data?.facet?.kind === `e2e_kind_${rnd}`);
  const facets = (await admin.get('/api/admin/taxonomy/facets')).data?.facets ?? [];
  check('filter listed with its product count', facets.find((f) => f.id === facetId)?.product_count === 0);

  // ----------------------------------------------------------- 4. hashtags
  console.log('\n4. hashtags');
  r = await admin.post('/api/admin/taxonomy/hashtags', { tag: `#Managed ${rnd}`, name_ar: 'مُدار' });
  const tagId = r.data?.hashtag?.id;
  const managedTag = r.data?.hashtag?.tag;
  check('hashtag created, normalized like the form does it', r.status === 200 && r.data?.created === true && managedTag === `Managed-${rnd}`, JSON.stringify(r.data).slice(0, 160));
  r = await admin.post('/api/admin/taxonomy/hashtags', { tag: `managed-${rnd}` });
  check('the same tag in another case is the same row, keeping its spelling', r.status === 200 && r.data?.created === false && r.data?.hashtag?.id === tagId && r.data?.hashtag?.tag === managedTag, JSON.stringify(r.data?.hashtag));
  let tags = (await admin.get('/api/admin/taxonomy/hashtags')).data?.hashtags ?? [];
  const typedRow = tags.find((t) => t.tag === typedTag);
  check('a tag typed into a product save is registered automatically', typedRow?.managed === true && typedRow?.product_count === 1, JSON.stringify(typedRow));
  check('the managed tag lists with zero products', tags.find((t) => t.id === tagId)?.product_count === 0);

  r = await admin.post('/api/admin/taxonomy/hashtags', { id: typedRow?.id, tag: `renamed-${rnd}` });
  check('renaming rewrites the product that carries it', r.status === 200 && r.data?.products_updated === 1, JSON.stringify(r.data).slice(0, 160));
  let product = (await admin.get(`/api/admin/products-v2/${productId}`)).data?.product;
  check('the product now carries the new spelling', Array.isArray(product?.hashtags) && product.hashtags.includes(`renamed-${rnd}`) && !product.hashtags.includes(typedTag), JSON.stringify(product?.hashtags));

  r = await admin.post('/api/admin/taxonomy/hashtags', { id: tagId, tag: `renamed-${rnd}` });
  check('renaming onto an existing tag is refused', r.status === 400 && r.data?.code === 'HASHTAG_TAKEN', JSON.stringify(r.data).slice(0, 120));

  sql(`UPDATE products SET hashtags='["renamed-${rnd}","raw-${rnd}","PLA"]' WHERE id='${productId}'`);
  tags = (await admin.get('/api/admin/taxonomy/hashtags')).data?.hashtags ?? [];
  const rawRow = tags.find((t) => t.tag === `raw-${rnd}`);
  check('a tag that lives only on products shows as unlisted', rawRow?.managed === false && rawRow?.product_count === 1, JSON.stringify(rawRow));
  r = await admin.post('/api/admin/taxonomy/hashtags', { tag: `raw-${rnd}` });
  tags = (await admin.get('/api/admin/taxonomy/hashtags')).data?.hashtags ?? [];
  check('adopting it makes it managed', r.status === 200 && tags.find((t) => t.tag === `raw-${rnd}`)?.managed === true);
  r = await admin.post('/api/admin/taxonomy/hashtags/strip', { tag: `raw-${rnd}` });
  product = (await admin.get(`/api/admin/products-v2/${productId}`)).data?.product;
  check('strip removes it from the product', r.status === 200 && r.data?.products_updated === 1 && !product?.hashtags.includes(`raw-${rnd}`), JSON.stringify(product?.hashtags));

  r = await admin.del(`/api/admin/taxonomy/hashtags/${typedRow?.id}?strip=1`);
  product = (await admin.get(`/api/admin/products-v2/${productId}`)).data?.product;
  check('delete with strip=1 removes the row and the product tag', r.status === 200 && r.data?.products_updated === 1 && !product?.hashtags.includes(`renamed-${rnd}`), JSON.stringify(product?.hashtags));
  // SQLite's NOCASE folds ASCII only, so a non-ASCII case pair is where a
  // second vocabulary row for one tag would appear if the write path trusted
  // the index instead of folding the tags itself.
  const uniA = `Çap-${rnd}`;
  const uniB = `çap-${rnd}`;
  r = await admin.post('/api/admin/products-v2', {
    name_en: `E2E Unicode A ${rnd}`, name_ar: `يونيكود أ ${rnd}`, price_iqd: 7000, status: 'draft',
    category_id: rootId, hashtags: [uniA], sale_types: ['direct_sale'], media: [],
  });
  const uniProductA = r.data?.product?.id;
  r = await admin.post('/api/admin/products-v2', {
    name_en: `E2E Unicode B ${rnd}`, name_ar: `يونيكود ب ${rnd}`, price_iqd: 7000, status: 'draft',
    category_id: rootId, hashtags: [uniB], sale_types: ['direct_sale'], media: [],
  });
  check('two products carry the same tag in two cases', r.status === 200 && !!uniProductA);
  tags = (await admin.get('/api/admin/taxonomy/hashtags')).data?.hashtags ?? [];
  const uniRows = tags.filter((t) => t.tag.toLowerCase() === uniA.toLowerCase());
  check('a non-ASCII case pair is ONE vocabulary row, counted once per product', uniRows.length === 1 && uniRows[0].product_count === 2, JSON.stringify(uniRows));
  r = await admin.post('/api/admin/taxonomy/hashtags', { id: uniRows[0]?.id, tag: `çapkirin-${rnd}` });
  check('renaming it moves BOTH products, none stranded', r.status === 200 && r.data?.products_updated === 2, JSON.stringify(r.data).slice(0, 140));
  tags = (await admin.get('/api/admin/taxonomy/hashtags')).data?.hashtags ?? [];
  check('and no sibling row is left behind', tags.filter((t) => t.tag.toLowerCase().startsWith(`çap-${rnd}`.toLowerCase())).length === 0);

  r = await admin.post('/api/admin/taxonomy/hashtags', { id: tagId, active: false });
  tags = (await admin.get('/api/admin/taxonomy/hashtags')).data?.hashtags ?? [];
  check('a hashtag can be deactivated', tags.find((t) => t.id === tagId)?.active === false);
  r = await admin.post('/api/admin/taxonomy/hashtags', { id: tagId, active: true });

  // ----------------------------------------------------------- 5. template
  r = await admin.post('/api/admin/taxonomy/brands', { id: brandId, active: false });
  const brandsList = (await admin.get('/api/admin/taxonomy/brands')).data?.brands ?? [];
  check('a deactivated brand is still LISTED for the admin, flagged inactive', brandsList.find((b) => b.id === brandId)?.active === false);
  r = await admin.post('/api/admin/taxonomy/brands', { id: brandId, active: true });

  console.log('\n5. the template follows the taxonomy');
  r = await admin.get('/api/admin/import/lookups');
  check('lookups endpoint lists the new section, sub-section, brand, filter and hashtag',
    r.status === 200 &&
      r.data?.sections?.some((s) => s.id === rootId && s.family === 'devices') &&
      r.data?.sections?.some((s) => s.id === subId && s.parent_id === rootId) &&
      r.data?.brands?.some((b) => b.id === brandId) &&
      r.data?.facets?.some((f) => f.id === facetId) &&
      r.data?.hashtags?.some((h) => h.tag === managedTag),
    JSON.stringify({ s: r.data?.sections?.length, b: r.data?.brands?.length, f: r.data?.facets?.length, h: r.data?.hashtags?.length }));
  r = await admin.post('/api/admin/taxonomy/brands', { id: brandId, active: false });
  r = await admin.get('/api/admin/import/lookups');
  check('an inactive brand is NOT offered (the import would refuse it)', !r.data?.brands?.some((b) => b.id === brandId));
  r = await admin.post('/api/admin/taxonomy/brands', { id: brandId, active: true });

  const tplRes = await admin.raw('GET', `/api/admin/import/template?category=${encodeURIComponent(subId)}&format=csv`);
  const tplRows = parseCsv(await tplRes.text());
  const cols = tplRows[0];
  check('CSV template downloads for the new sub-section', tplRes.status === 200 && cols?.[0] === 'row_type');
  check('the sheet has a hashtags column', cols.includes('hashtags'));
  const lk = (type, key) => tplRows.find((x) => x[0] === type && x[1] === key);
  // Values are advertised BY SLUG: a display name may belong to two rows and
  // the importer refuses an ambiguous one rather than pick a section for you.
  check('CSV lookup block names the new main section by slug', !!lk('#lookup:category', rootSlug), rootSlug);
  check('CSV lookup block names the new sub-section under its parent', lk('#lookup:sub_category', subSlug)?.[cols.indexOf('category')] === rootSlug);
  check('CSV lookup block names the new brand by slug', !!lk('#lookup:brand', brandSlug), brandSlug);
  check('CSV lookup block names the managed hashtag', !!lk('#lookup:hashtags', managedTag));
  // The product form has no filters picker any more, so the sheet must not
  // offer a filter column or a filter value nobody could correct afterwards.
  check('the sheet no longer carries a filters column', !cols.includes('facets'));
  check('the lookup block no longer offers filters', !lk('#lookup:facets', facetSlug));
  check('every lookup row keeps the column count', tplRows.filter((x) => x[0].startsWith('#lookup')).every((x) => x.length === cols.length));
  check(
    'every lookup marker names a real column of the sheet',
    tplRows.filter((x) => x[0].startsWith('#lookup:')).every((x) => cols.includes(x[0].slice('#lookup:'.length))),
    [...new Set(tplRows.filter((x) => x[0].startsWith('#lookup:')).map((x) => x[0]))].join(' ')
  );

  const zipRes = await admin.raw('GET', `/api/admin/import/template?category=${encodeURIComponent(subId)}&format=zip`);
  const entries = unzipSync(new Uint8Array(await zipRes.arrayBuffer()));
  check('ZIP template carries lookups.csv', !!entries['lookups.csv']);
  const lkRows = parseCsv(strFromU8(entries['lookups.csv'] ?? new Uint8Array()));
  check('lookups.csv lists brand and hashtag rows', lkRows.some((x) => x[0] === 'brand' && x[1] === brandSlug && x[2] === `E2E Brand ${rnd}`) && lkRows.some((x) => x[0] === 'hashtags' && x[1] === managedTag), JSON.stringify(lkRows.filter((x) => x[0] === 'brand').slice(0, 2)));
  const readme = strFromU8(entries['README.txt'] ?? new Uint8Array());
  check('README lists the accepted values', readme.includes(brandSlug) && readme.includes(`E2E Brand ${rnd}`) && readme.includes('القيم المتاحة'));
  check('README no longer offers a filters list', !readme.includes('facets — الفلاتر'));
  check('README names the product type and every row type', ['product', 'option', 'color', 'variant', 'image', 'transport', 'spec', 'label', 'warranty', 'content', 'guide'].every((x) => readme.includes(x)) && readme.includes('النوع:'));
  const expRes = await admin.raw('GET', `/api/admin/import/export?category=${encodeURIComponent(rootId)}&format=zip`);
  const expEntries = unzipSync(new Uint8Array(await expRes.arrayBuffer()));
  check('export ZIP carries lookups.csv too', expRes.status === 200 && !!expEntries['lookups.csv']);
  const expRows = parseCsv(strFromU8(expEntries['data.csv'] ?? new Uint8Array()));
  // The section holds several products by now, so the row is found by NAME,
  // not by being the first product line in the sheet.
  const nameCol = expRows[0].indexOf('name');
  const expProduct = expRows.find((x) => x[0] === 'product' && x[nameCol] === `E2E Taxonomy Product ${rnd}`);
  check('export writes the product hashtags into the hashtags column', expProduct?.[expRows[0].indexOf('hashtags')] === 'PLA', JSON.stringify(expProduct?.[expRows[0].indexOf('hashtags')]));

  // ------------------------------------------------------------- 6. import
  console.log('\n6. an ambiguous display name is refused, the slug is not');
  const twinName = `E2E Twin ${rnd}`;
  const twinA = (await admin.post('/api/admin/taxonomy/catalogs', { name_en: twinName, template_family: 'devices' })).data?.catalog;
  const twinB = (await admin.post('/api/admin/taxonomy/catalogs', { name_en: twinName, template_family: 'devices' })).data?.catalog;
  check('two sections may carry the same display name with different slugs', !!twinA?.id && !!twinB?.id && twinA.slug !== twinB.slug, JSON.stringify([twinA?.slug, twinB?.slug]));
  const twinCols = parseCsv(await (await admin.raw('GET', `/api/admin/import/template?category=${encodeURIComponent(twinA.id)}&format=csv`)).text())[0];
  const twinCol = (v) => twinCols.map((c) => v[c] ?? '');
  const ambiguousSheet = toCsv([
    twinCols,
    twinCol({ row_type: 'product', key: `E2E-AMB-${rnd}`, name: `Ambiguous ${rnd}`, status: 'draft', category: twinName, sale_types: 'direct_sale', inventory_mode: 'BASE', price_iqd: '5000' }),
  ]);
  r = await admin.upload('/api/admin/import/preview', 'amb.csv', new TextEncoder().encode(ambiguousSheet), { category: twinA.id });
  const ambErrors = (r.data?.rows?.[0]?.errors ?? []).join(' | ');
  check('a name two sections share is refused instead of filed under one of them', r.status === 200 && r.data?.summary?.failed === 1 && /أكثر من صف/.test(ambErrors) && /slug/.test(ambErrors), ambErrors.slice(0, 160));
  const bySlugSheet = toCsv([
    twinCols,
    twinCol({ row_type: 'product', key: `E2E-AMB-${rnd}`, name: `Ambiguous ${rnd}`, status: 'draft', category: twinB.slug, sale_types: 'direct_sale', inventory_mode: 'BASE', price_iqd: '5000' }),
  ]);
  r = await admin.upload('/api/admin/import/preview', 'amb2.csv', new TextEncoder().encode(bySlugSheet), { category: twinA.id });
  check('the same row with the slug resolves cleanly', r.status === 200 && r.data?.summary?.create === 1 && r.data?.summary?.failed === 0, JSON.stringify(r.data?.rows?.[0]?.errors ?? []).slice(0, 160));

  console.log('\n7. import with hashtags');
  const col = (v) => cols.map((c) => v[c] ?? '');
  const key = `E2E-TAX-${rnd}`;
  const sheet = toCsv([
    cols,
    col({
      row_type: 'product',
      key,
      name: `E2E Imported ${rnd}`,
      status: 'draft',
      brand: `E2E Brand ${rnd}`,
      category: `E2E Section ${rnd} renamed`,
      sub_category: `E2E Sub ${rnd}`,
      sale_types: 'direct_sale',
      inventory_mode: 'BASE',
      price_iqd: '20000',
      stock: '3',
      hashtags: `${managedTag}|from-sheet-${rnd}`,
    }),
  ]);
  r = await admin.upload('/api/admin/import/preview', 'tax.csv', new TextEncoder().encode(sheet), { category: subId });
  check('preview accepts the row', r.status === 200 && r.data?.summary?.create === 1 && r.data?.summary?.failed === 0, JSON.stringify(r.data?.rows?.[0]?.errors ?? r.data).slice(0, 200));
  r = await admin.post('/api/admin/import/confirm', { import_id: r.data?.import_id });
  const importedId = r.data?.rows?.[0]?.product_id;
  check('confirm creates it', r.status === 200 && r.data?.summary?.created === 1, JSON.stringify(r.data?.rows?.[0]).slice(0, 200));
  product = (await admin.get(`/api/admin/products-v2/${importedId}`)).data?.product;
  check('the imported product carries both hashtags', Array.isArray(product?.hashtags) && product.hashtags.includes(managedTag) && product.hashtags.includes(`from-sheet-${rnd}`), JSON.stringify(product?.hashtags));
  tags = (await admin.get('/api/admin/taxonomy/hashtags')).data?.hashtags ?? [];
  check('the tag typed into the sheet joined the vocabulary', tags.find((t) => t.tag === `from-sheet-${rnd}`)?.managed === true);
  // A tag can never carry the separators of the sheet's own cell.
  r = await admin.post('/api/admin/products-v2', {
    name_en: `E2E Separator ${rnd}`,
    name_ar: `فاصل ${rnd}`,
    price_iqd: 9000,
    status: 'draft',
    category_id: rootId,
    hashtags: [`a|b-${rnd}`, `c,d-${rnd}`, '#  spaced  tag  '],
    sale_types: ['direct_sale'],
    media: [],
  });
  const sepProduct = r.data?.product;
  check('a hashtag with | or , is stored joined, not split', r.status === 200 && sepProduct?.hashtags?.includes(`a-b-${rnd}`) && sepProduct?.hashtags?.includes(`c-d-${rnd}`) && sepProduct?.hashtags?.includes('spaced-tag'), JSON.stringify(sepProduct?.hashtags));

  // FILTERS ARE STILL A MANAGED VOCABULARY, they are just no longer typed on
  // the product form or in the sheet. The API still assigns them, and a
  // filter that a product uses is still deactivated rather than deleted.
  r = await admin.put(`/api/admin/products/${sepProduct.id}/relations`, { facet_ids: [facetId] });
  check('the relations API still assigns a filter explicitly', r.status === 200, JSON.stringify(r.data).slice(0, 200));
  const facetsAfter = (await admin.get('/api/admin/taxonomy/facets')).data?.facets ?? [];
  check('the filter counts the product it was assigned to', facetsAfter.find((f) => f.id === facetId)?.product_count === 1);

  // …and a save that says nothing about filters PRESERVES them, which is what
  // every save from the product form now does.
  r = await admin.put(`/api/admin/products/${sepProduct.id}/relations`, { inventory_mode: 'BASE' });
  check('a relations payload without facet_ids preserves the stored filters', r.status === 200, JSON.stringify(r.data).slice(0, 200));
  const stillThere = (await admin.get('/api/admin/taxonomy/facets')).data?.facets ?? [];
  check('the filter survived a save that did not mention it', stillThere.find((f) => f.id === facetId)?.product_count === 1);

  r = await admin.del(`/api/admin/taxonomy/facets/${facetId}`);
  check('a filter on a product is deactivated, not deleted', r.status === 200 && r.data?.deleted === false && r.data?.products === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
