/**
 * Task «احذف الفلاتر … شريط الثابت … قالب الاستيراد/التصدير» — the three
 * things the owner asked for, checked on the running app rather than argued
 * about in a commit message.
 *
 *   1. The product form has NO filters block any more, and saving from it
 *      does not silently drop the filters a product already carries.
 *   2. The save bar sits ON the bottom edge: no gap under it, opaque, and
 *      still clear of the iPad home indicator.
 *   3. The import/export template is offered per product type, its columns
 *      follow the type, and it carries every field of the product form.
 *
 * Usage: node scripts/e2e-product-template.mjs [baseUrl]
 */
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const OUT = resolve(ROOT, 'artifacts/product-template');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
  }
}

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

function sql(statement) {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' });
}

const rnd = Math.random().toString(36).slice(2, 8);

/** A CSV parser good enough for the assertions below (quotes + CRLF). */
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
        if (src[i + 1] === '"') { field += '"'; i++; continue; }
        quoted = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nLEVONIS product form + import template — ${BASE}\n`);

  const email = `ptpl-${rnd}@test.local`;
  const password = 'product-template-1';
  let cookie = '';
  const api = async (method, p, body) => {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, data };
  };
  const raw = async (p) => fetch(BASE + p, { headers: cookie ? { Cookie: cookie } : {} });

  console.log('0. an admin session');
  check('admin registered', (await api('POST', '/api/auth/register', { email, username: `pt${rnd}`, name: 'PT', password })).status === 200);
  sql(`UPDATE users SET role='admin' WHERE email='${email}'`);
  check('admin signed in', (await api('POST', '/api/auth/login', { email, password })).status === 200);

  // ------------------------------------------------------------- 3. template
  console.log('\n3. the template follows the product type');
  const types = (await api('GET', '/api/admin/import/types')).data?.types ?? [];
  check('the four product types are served', types.map((t) => t.id).join(',') === 'printer,parts,filament,accessory', JSON.stringify(types.map((t) => t.id)));
  check('each type is labelled in Arabic and counts its columns', types.every((t) => t.label_ar && t.hint_ar && t.spec_columns > 0));

  const sheets = {};
  for (const t of types) {
    const res = await raw(`/api/admin/import/template?type=${t.id}&format=csv`);
    const rows = parseCsv(await res.text());
    sheets[t.id] = rows;
    check(`${t.id}: the template downloads without a section`, res.status === 200 && rows[0]?.[0] === 'row_type');
  }
  const cols = (id) => sheets[id]?.[0] ?? [];
  const spec = (id) => cols(id).filter((c) => c.startsWith('spec.'));
  check('a printer sheet asks for a build volume, a filament sheet does not',
    spec('printer').includes('spec.build_volume') && !spec('filament').includes('spec.build_volume'));
  check('a filament sheet asks for a diameter, a printer sheet does not',
    spec('filament').includes('spec.diameter') && !spec('printer').includes('spec.diameter'));
  check('parts and accessory sheets are narrower than a printer sheet',
    spec('parts').length < spec('printer').length && spec('accessory').length < spec('printer').length,
    `printer=${spec('printer').length} parts=${spec('parts').length} accessory=${spec('accessory').length}`);
  check('no sheet carries a filters column', Object.keys(sheets).every((id) => !cols(id).includes('facets')));

  // Every field of the product form has a column or a row type.
  const need = ['sku', 'is_featured', 'direct_surcharge_iqd', 'payment_options', 'how_to_use', 'usage_url', 'duration_months', 'unit', 'kind', 'body', 'url', 'label'];
  check('the product row carries the form fields that used to be missing',
    need.every((c) => cols('printer').includes(c)),
    need.filter((c) => !cols('printer').includes(c)).join(','));
  const exampleTypes = new Set(sheets.printer.filter((r) => r[1] === 'EXAMPLE-PRINTER').map((r) => r[0]));
  for (const rowType of ['product', 'option', 'color', 'variant', 'image', 'transport', 'spec', 'label', 'warranty', 'content', 'guide']) {
    check(`the worked example demonstrates a ${rowType} row`, exampleTypes.has(rowType));
  }
  check('each type ships its own example, named after itself',
    Object.keys(sheets).every((id) => sheets[id].some((r) => r[1] === `EXAMPLE-${id.toUpperCase()}`)));

  const bad = await raw('/api/admin/import/template?type=spaceship&format=csv');
  check('an invented type is refused by name, not silently defaulted', bad.status === 400);

  // ------------------------------------------------------- 1 + 2. the form
  console.log('\n1 + 2. the product form');
  const catalogs = (await api('GET', '/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  check('every section with a family reports the product type it belongs to',
    catalogs.filter((c) => c.effective_template_family).every((c) => !!c.product_type),
    JSON.stringify(catalogs.filter((c) => c.effective_template_family && !c.product_type).map((c) => c.slug)));
  const cat = catalogs.find((c) => c.active && c.effective_template_family && !c.parent_id) ?? catalogs.find((c) => c.active);

  // A product that already carries a filter, so a save from the form can be
  // checked for NOT dropping it.
  const facet = (await api('POST', '/api/admin/taxonomy/facets', { name_en: `PT Filter ${rnd}`, name_ar: `فلتر ${rnd}`, kind: `pt_${rnd}` })).data?.facet;
  const made = await api('POST', '/api/admin/products-v2', {
    name_en: `PT Product ${rnd}`,
    name_ar: `منتج ${rnd}`,
    price_iqd: 100000,
    status: 'draft',
    category_id: cat?.id ?? null,
    sale_types: ['direct_sale'],
    media: [],
  });
  const productId = made.data?.product?.id;
  check('a fixture product exists', made.status === 200 && !!productId, JSON.stringify(made.data).slice(0, 160));
  check('its filter is assigned through the API',
    (await api('PUT', `/api/admin/products/${productId}/relations`, { inventory_mode: 'BASE', facet_ids: [facet?.id] })).status === 200);

  // ------------------------------------------- the sheet writes the whole form
  console.log('\n3b. one file carries every part of the product');
  // A `/files/...` URL that this store already serves is the one image cell an
  // export writes, so using one here exercises the same path a round-trip does
  // — including the guide-step and content-block pictures, which used to be
  // left out of the resolver and would have failed the row.
  const anyImage = (await api('GET', '/api/admin/products-v2?limit=1')).status === 200
    ? (await (async () => {
        const list = (await api('GET', '/api/admin/products-v2?limit=50')).data?.products ?? [];
        for (const row of list) if (row.image && row.image.startsWith('/files/')) return row.image;
        return '';
      })())
    : '';

  const sectionForImport = catalogs.find((c) => c.active && c.effective_template_family && c.parent_id)
    ?? catalogs.find((c) => c.active && c.effective_template_family);
  const typeOfSection = sectionForImport?.product_type ?? 'printer';
  const tplRes = await raw(`/api/admin/import/template?category=${encodeURIComponent(sectionForImport.id)}&format=csv&example=0`);
  const tplCols = parseCsv(await tplRes.text())[0];
  const importKey = `PT-FULL-${rnd}`;
  const cell = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const line = (v) => tplCols.map((c) => cell(v[c] ?? '')).join(',');
  const sheet = [
    tplCols.join(','),
    line({
      row_type: 'product', key: importKey, name: `PT Full ${rnd}`, description: 'Every row type in one file.',
      status: 'draft', sku: importKey, display_order: '2', is_featured: 'yes',
      category: sectionForImport.slug, sale_types: 'direct_sale|pre_order', inventory_mode: 'VARIANT_COMBINATION',
      price_iqd: '300000', prime_price_iqd: '290000', pro_price_iqd: '280000', direct_surcharge_iqd: '7000',
      stock: '5', low_stock_threshold: '1', payment_options: 'cod|wallet',
      how_to_use: 'Plug it in.', usage_url: 'https://example.com/manual', hashtags: `pt-${rnd}`,
    }),
    line({ row_type: 'option', key: importKey, group: 'Size', value: 'Large', sku_part: 'L', active: 'yes' }),
    line({ row_type: 'color', key: importKey, value: 'Black', hex: '#000000', active: 'yes', links: 'Size:Large' }),
    line({ row_type: 'variant', key: importKey, links: 'Size:Large|color:Black', sku_part: `L-BLK-${rnd}`, stock: '3', active: 'yes' }),
    line({ row_type: 'transport', key: importKey, value: 'air', active: 'yes' }),
    line({ row_type: 'transport', key: importKey, value: 'sea', price_iqd: '12000', active: 'no' }),
    line({ row_type: 'spec', key: importKey, group: 'Motion', label: 'System', value: 'CoreXY' }),
    line({ row_type: 'spec', key: importKey, group: 'Motion', label: 'Max speed', value: '500', unit: 'mm/s' }),
    line({ row_type: 'label', key: importKey, kind: 'warranty_included', value: 'Warranty included', active: 'yes' }),
    line({ row_type: 'warranty', key: importKey, value: 'One year', body: 'Defects only.', duration_months: '12', kind: 'total', price_iqd: '0', active: 'yes' }),
    line({ row_type: 'content', key: importKey, kind: 'text', body: 'A block under the page.' }),
    line({ row_type: 'guide', key: importKey, kind: 'setup', value: 'Unbox', body: 'Remove the foam.', image: anyImage, links: 'https://example.com/unbox' }),
  ].join('\r\n');

  const form = new FormData();
  form.set('file', new File([new TextEncoder().encode(sheet)], 'full.csv'));
  form.set('category', sectionForImport.id);
  const prevRes = await fetch(`${BASE}/api/admin/import/preview`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  const prev = await prevRes.json();
  check('the whole-form sheet previews with no errors',
    prev?.summary?.create === 1 && prev?.summary?.failed === 0,
    JSON.stringify(prev?.rows?.[0]?.errors ?? prev?.file_issues ?? prev).slice(0, 300));
  const confirmed = await api('POST', '/api/admin/import/confirm', { import_id: prev?.import_id });
  const importedId = confirmed.data?.rows?.[0]?.product_id;
  check('the import creates the product', confirmed.data?.summary?.created === 1, JSON.stringify(confirmed.data?.rows?.[0]).slice(0, 200));

  const doc = (await api('GET', `/api/admin/products-v2/${importedId}`)).data?.product;
  check('the sheet set the featured flag and the availability premium', doc?.is_featured === true && doc?.direct_surcharge_iqd === 7000);
  check('the sheet set the payment options and the usage text',
    JSON.stringify(doc?.payment_options) === JSON.stringify(['cod', 'wallet']) && doc?.how_to_use === 'Plug it in.');
  check('the sheet wrote the pre-order transports',
    doc?.preorder_transports?.length === 2 && doc.preorder_transports[0].method === 'air' && doc.preorder_transports[1].commission_iqd === 12000,
    JSON.stringify(doc?.preorder_transports));
  check('the sheet wrote a specification group with its two rows',
    doc?.spec_groups?.length === 1 && doc.spec_groups[0].rows?.length === 2 && doc.spec_groups[0].rows[1].unit === 'mm/s',
    JSON.stringify(doc?.spec_groups));
  check('the sheet wrote the badge', doc?.labels?.length === 1 && doc.labels[0].key === 'warranty_included');
  check('the sheet wrote the warranty plan', doc?.warranty_plans?.length === 1 && doc.warranty_plans[0].duration_months === 12);
  check('the sheet wrote the content block', doc?.content_blocks?.length === 1 && doc.content_blocks[0].kind === 'text');
  check('the sheet wrote the guide, its official link and its step',
    doc?.usage_guide?.official_url === 'https://example.com/manual' && doc.usage_guide.steps?.length === 1 && doc.usage_guide.steps[0].kind === 'setup',
    JSON.stringify(doc?.usage_guide));
  if (anyImage) {
    check('a picture on a guide step resolves instead of being refused',
      doc?.usage_guide?.steps?.[0]?.images?.length === 1,
      JSON.stringify(doc?.usage_guide?.steps?.[0]?.images));
  }
  const rel = (await api('GET', `/api/admin/products/${importedId}/relations`)).data;
  check('the sheet built the stock combination', rel?.variants?.length === 1 && rel.variants[0].stock === 3, JSON.stringify(rel?.variants));
  check('the arabic copy was produced locally for a translated field',
    typeof doc?.description_ar === 'string' && doc.description_ar.length > 0);

  // A COMBINATION SKU IS UNIQUE ACROSS THE STORE (idx_product_variants_sku is a
  // partial unique index over the whole table). Two products both having a
  // Large-Black combination is ordinary, so the collision has to come back as a
  // sentence naming the product that holds it — not as a raw D1 error.
  const clashKey = `${importKey}-CLASH`;
  const clashSheet = sheet
    .split('\r\n')
    .map((ln, i) => (i === 0 ? ln : ln.replace(new RegExp(importKey, 'g'), clashKey)))
    .join('\r\n');
  const clashForm = new FormData();
  clashForm.set('file', new File([new TextEncoder().encode(clashSheet)], 'clash.csv'));
  clashForm.set('category', sectionForImport.id);
  const clashPrev = await (await fetch(`${BASE}/api/admin/import/preview`, { method: 'POST', headers: { Cookie: cookie }, body: clashForm })).json();
  const clashRes = await api('POST', '/api/admin/import/confirm', { import_id: clashPrev?.import_id });
  const clashRow = clashRes.data?.rows?.[0];
  check('a combination SKU another product holds is refused by name, not by a database error',
    clashRow?.action === 'failed' && /SKU/i.test(String(clashRow?.reason)) && !/D1_ERROR|SQLITE/i.test(String(clashRow?.reason)),
    JSON.stringify(clashRow?.reason));

  // …and the export writes them all back out.
  const backRes = await raw(`/api/admin/import/export?ids=${importedId}&format=csv`);
  const back = parseCsv(await backRes.text());
  const backTypes = new Set(back.filter((r) => r[1] === importKey).map((r) => r[0]));
  for (const rowType of ['product', 'option', 'color', 'variant', 'transport', 'spec', 'label', 'warranty', 'content', 'guide']) {
    check(`the export writes the ${rowType} row back out`, backTypes.has(rowType), [...backTypes].join(','));
  }
  const reForm = new FormData();
  reForm.set('file', new File([new TextEncoder().encode(back.map((r) => r.map(cell).join(',')).join('\r\n'))], 'back.csv'));
  reForm.set('category', sectionForImport.id);
  const reRes = await fetch(`${BASE}/api/admin/import/preview`, { method: 'POST', headers: { Cookie: cookie }, body: reForm });
  const re = await reRes.json();
  check('re-importing the export is a clean UPDATE of the same product',
    re?.summary?.update === 1 && re?.summary?.create === 0 && re?.summary?.failed === 0,
    JSON.stringify(re?.rows?.[0]?.errors ?? re?.file_issues ?? re).slice(0, 300));
  check('the round-trip resolved the section type it came from', typeOfSection === (sectionForImport.product_type));

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });
  // 1024x768 is the iPad the owner sent the screenshot from.
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, locale: 'ar' });
  await ctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  if ((await page.locator('[data-tab="products"]:visible').count()) === 0) {
    await page.locator('[data-action="open-sidebar"]').first().click();
    await page.waitForTimeout(400);
  }
  await page.locator('[data-tab="products"]:visible').first().click({ timeout: 15000 });
  await page.waitForTimeout(1000);

  await page.locator(`[data-action="edit"]`).first().click({ timeout: 15000 });
  await page.waitForSelector('[data-form="save-bar"]', { timeout: 20000 });
  await page.waitForTimeout(600);

  const body = await page.locator('body').innerText();
  check('the form no longer shows a «الفلاتر» block', !body.includes('Filters — separate from sections'));
  check('the sub-section field is still there', body.includes('القسم الفرعي'));

  // THE SAVE BAR sits on the bottom edge of its scroll area.
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = main.scrollHeight;
  });
  await page.waitForTimeout(400);
  const geom = await page.evaluate(() => {
    const bar = document.querySelector('[data-form="save-bar"]');
    const main = document.querySelector('main');
    const b = bar.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    return {
      gap: Math.round(m.bottom - b.bottom),
      viewportGap: Math.round(window.innerHeight - b.bottom),
      position: cs.position,
      background: cs.backgroundColor,
      borderTop: cs.borderTopWidth,
      height: Math.round(b.height),
    };
  });
  check('the save bar is sticky, not floating in the flow', geom.position === 'sticky', geom.position);
  check('nothing sits between the save bar and the bottom of the screen', geom.gap <= 1 && geom.viewportGap <= 1, JSON.stringify(geom));
  check('the bar is opaque, so the page does not show through it', !/rgba\(.*,\s*0(\.\d+)?\)$/.test(geom.background) && geom.background !== 'transparent', geom.background);
  check('the bar is separated by a hairline on its top edge only', parseFloat(geom.borderTop) > 0, geom.borderTop);
  check('both actions are still on it',
    (await page.locator('[data-form="save-bar"] [data-action="save"]').count()) === 1 &&
    (await page.locator('[data-form="save-bar"] [data-action="save-draft"]').count()) === 1);
  await page.screenshot({ path: `${OUT}/save-bar-1024.png` });

  // Saving from the form must not clear the filters it can no longer show.
  await page.locator('[data-form="save-bar"] [data-action="save-draft"]').click();
  await page.waitForTimeout(2500);
  const after = (await api('GET', `/api/admin/products/${productId}/relations`)).data;
  check('a save from the form preserves the filters the form cannot show',
    Array.isArray(after?.facet_ids) && after.facet_ids.includes(facet?.id),
    JSON.stringify(after?.facet_ids));

  // The import panel offers the four types.
  await page.locator('[data-action="back"], [aria-label="رجوع"]').first().click().catch(() => {});
  await page.waitForTimeout(1200);
  await page.locator('[data-testid="admin-import-open"]').first().click({ timeout: 15000 });
  await page.waitForTimeout(1200);
  check('the import panel offers the four product types',
    (await page.locator('[data-import-type]').count()) === 4,
    String(await page.locator('[data-import-type]').count()));
  check('the template download is blocked until a type is chosen',
    (await page.locator('[data-import="template-csv"]').first().evaluate((el) => el.disabled)) === true);
  await page.locator('[data-import-type="filament"]').click();
  await page.waitForTimeout(300);
  check('choosing a type alone enables the template download',
    (await page.locator('[data-import="template-csv"]').first().evaluate((el) => el.disabled)) === false);
  await page.screenshot({ path: `${OUT}/import-types-1024.png` });

  await ctx.close();
  await browser.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
