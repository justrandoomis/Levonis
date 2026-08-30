#!/usr/bin/env node
/**
 * The import pipeline, exercised against a running worker — mandate §10 and
 * its acceptance rows in §12:
 *
 *   "زر تنزيل القالب يجب أن يعمل فعلًا ولا يعيد ملفًا فارغًا أو 404"
 *   "نفّذ preview قبل الاعتماد ... دون كتابة قاعدة البيانات"
 *   "بعد التأكيد نفّذ الاستيراد في transaction أو batches idempotent مع import_id"
 *   "وفر تقرير نتيجة قابلًا للتنزيل يبين created/updated/skipped/failed"
 *   "نفّذ round-trip: تصدير منتج ثم استيراده يعيد نفس الخيارات والألوان
 *    والروابط والصور والترتيب والمخزون والأسعار"
 *
 * Nothing here is mocked: it registers an admin, promotes it with real SQL,
 * downloads the real files, uploads them back and reads the rows the worker
 * actually wrote.
 *
 *   node scripts/e2e-import.mjs            (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
// --evidence <dir> writes the REAL downloaded files next to the run, so the
// mandate's "أمثلة قوالب حقيقية ... وتقرير استيراد" is a file on disk rather
// than a claim in a summary.
const EVIDENCE = process.argv.includes('--evidence')
  ? resolve(ROOT, process.argv[process.argv.indexOf('--evidence') + 1])
  : null;
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
const keep = (name, data) => {
  if (!EVIDENCE) return;
  writeFileSync(resolve(EVIDENCE, name), data);
  console.log(`  kept ${name}`);
};

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
  /** multipart upload of one file plus scalar fields. */
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

// ------------------------------------------------------------ tiny CSV IO

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
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

const toCsv = (rows) =>
  rows
    .map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    .join('\r\n');

/** A 1x1 PNG, so the ZIP carries a file that really passes magic-byte sniffing. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const rnd = Math.random().toString(36).slice(2, 8);

async function main() {
  console.log(`\nLEVONIS import pipeline — ${BASE}\n`);

  // ------------------------------------------------------------- fixtures
  const admin = new Client();
  const email = `imp-${rnd}@test.local`;
  const password = 'import-pass-1';
  let r = await admin.post('/api/auth/register', {
    email,
    username: `imp${rnd}`,
    name: 'Import Admin',
    password,
  });
  check('admin account created', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  sql(`UPDATE users SET role='admin' WHERE email='${email}'`);
  r = await admin.post('/api/auth/login', { email, password });
  check('admin signed in', r.status === 200);

  const cats = (await admin.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const devicesSection =
    cats.find((c) => c.id === 'cat_printers_fdm') ??
    cats.find((c) => c.effective_template_family === 'devices' && c.parent_id) ??
    cats.find((c) => c.effective_template_family === 'devices');
  const materialsSection =
    cats.find((c) => c.id === 'cat_materials') ?? cats.find((c) => c.effective_template_family === 'materials');
  check('a Devices section exists', !!devicesSection, `catalogs=${cats.length}`);
  check('a Materials section exists', !!materialsSection);
  if (!devicesSection || !materialsSection) throw new Error('the seeded taxonomy is missing');

  const brandName = `E2E Brand ${rnd}`;
  const brand = await admin.post('/api/admin/taxonomy/brands', { name_en: brandName, name_ar: brandName });
  check('a brand exists to import against', brand.status === 200 && !!brand.data?.brand?.id);

  // ------------------------------------------------- 1. template downloads
  console.log('\n1. template downloads');
  for (const [label, section] of [
    ['devices', devicesSection],
    ['materials', materialsSection],
  ]) {
    const res = await admin.raw('GET', `/api/admin/import/template?category=${encodeURIComponent(section.id)}&format=csv`);
    const text = await res.text();
    const rows = parseCsv(text);
    check(`${label} CSV template downloads`, res.status === 200, `status=${res.status}`);
    check(
      `${label} CSV template is an attachment with a real length`,
      /attachment/.test(res.headers.get('content-disposition') ?? '') &&
        Number(res.headers.get('content-length')) > 200,
      `cd=${res.headers.get('content-disposition')} len=${res.headers.get('content-length')}`
    );
    check(`${label} CSV template is not empty`, rows.length >= 3, `rows=${rows.length}`);
    check(`${label} CSV template starts with row_type,key`, rows[0]?.[0] === 'row_type' && rows[0]?.[1] === 'key');
    check(`${label} CSV template carries a label row`, rows[1]?.[0] === '#labels');
    check(`${label} CSV template carries a worked example`, rows.some((x) => x[0] === 'product'));
    keep(`template-${label}.csv`, text);
  }

  const devSpec = (
    await admin.raw('GET', `/api/admin/import/template?category=${encodeURIComponent(devicesSection.id)}&format=csv`)
  ).text();
  const matSpec = (
    await admin.raw('GET', `/api/admin/import/template?category=${encodeURIComponent(materialsSection.id)}&format=csv`)
  ).text();
  const devCols = parseCsv(await devSpec)[0];
  const matCols = parseCsv(await matSpec)[0];
  check(
    'the two families do NOT share one column list',
    JSON.stringify(devCols) !== JSON.stringify(matCols),
    `dev=${devCols.length} mat=${matCols.length}`
  );
  check(
    'a Materials sheet has no Devices-only column',
    !matCols.includes('spec.nozzle') && devCols.includes('spec.nozzle')
  );

  const zipRes = await admin.raw(
    'GET',
    `/api/admin/import/template?category=${encodeURIComponent(devicesSection.id)}&format=zip`
  );
  const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
  check('devices ZIP template downloads', zipRes.status === 200 && zipBytes.length > 300, `len=${zipBytes.length}`);
  keep('template-devices.zip', Buffer.from(zipBytes));
  const entries = unzipSync(zipBytes);
  check('the ZIP holds data.csv', !!entries['data.csv']);
  check('the ZIP holds README.txt', !!entries['README.txt'] && strFromU8(entries['README.txt']).length > 400);
  check('the ZIP names an images/ folder', Object.keys(entries).some((k) => k.startsWith('images/')));

  // ------------------------------------------------------- 2. preview only
  console.log('\n2. preview writes nothing');
  const columns = devCols;
  const col = (v) => columns.map((c) => v[c] ?? '');
  const key = `E2E-${rnd}`;
  const fileRows = [
    columns,
    col({
      row_type: 'product',
      key,
      name: `E2E Printer ${rnd}`,
      description: 'Nozzle diameter: 0.4 mm',
      status: 'active',
      display_order: '5',
      brand: brandName,
      category: devicesSection.name_en || devicesSection.slug,
      sale_types: 'direct_sale|pre_order',
      inventory_mode: 'COLOR',
      price_iqd: '900000',
      prime_price_iqd: '870000',
      pro_price_iqd: '850000',
      cost_iqd: '600000',
      stock: '9',
      low_stock_threshold: '2',
      'spec.technology': 'FDM',
      'spec.build_volume': '256x256x256',
    }),
    col({ row_type: 'option', key, group: 'Printer', value: 'A1', sku_part: 'A1', active: 'yes' }),
    col({ row_type: 'option', key, group: 'Plug', value: 'EU', sku_part: 'EU', active: 'yes' }),
    col({
      row_type: 'color',
      key,
      value: 'Black',
      hex: '#101010',
      stock: '4',
      active: 'yes',
      links: 'Printer:A1|Plug:EU',
    }),
    col({ row_type: 'color', key, value: 'White', hex: '#fafafa', stock: '5', active: 'yes' }),
    col({ row_type: 'image', key, image: 'images/front.png', alt: 'front', primary: 'yes' }),
    col({ row_type: 'image', key, image: 'images/black.png', alt: 'black', links: 'color:Black' }),
  ];
  const uploadZip = zipSync({
    'data.csv': strToU8(toCsv(fileRows)),
    'images/front.png': new Uint8Array(PNG_1PX),
    // A second, distinct image so the two rows cannot collide on one hash.
    'images/black.png': new Uint8Array(Buffer.concat([PNG_1PX, Buffer.from([0x00])])),
  });

  const before = await admin.get(`/api/admin/products-v2?search=${encodeURIComponent(key)}`);
  const beforeCount = (before.data?.products ?? []).length;

  const prev = await admin.upload('/api/admin/import/preview', 'import.zip', uploadZip, {
    category: devicesSection.id,
  });
  check('preview accepts the ZIP', prev.status === 200, JSON.stringify(prev.data).slice(0, 200));
  const importId = prev.data?.import_id;
  check('preview returns an import_id', !!importId);
  check(
    'preview reports one product to create with no errors',
    prev.data?.summary?.create === 1 && prev.data?.summary?.failed === 0,
    JSON.stringify(prev.data?.summary)
  );
  check(
    'preview counts 2 options, 2 colours, 2 links and 2 images',
    prev.data?.rows?.[0]?.options === 2 &&
      prev.data?.rows?.[0]?.colors === 2 &&
      prev.data?.rows?.[0]?.links === 2 &&
      prev.data?.rows?.[0]?.images === 2,
    JSON.stringify(prev.data?.rows?.[0])
  );

  const afterPreview = await admin.get(`/api/admin/products-v2?search=${encodeURIComponent(key)}`);
  check(
    'preview created NO product',
    (afterPreview.data?.products ?? []).length === beforeCount,
    `before=${beforeCount} after=${(afterPreview.data?.products ?? []).length}`
  );

  // ------------------------------------------------------------ 3. confirm
  console.log('\n3. confirm, and confirm again');
  const applied = await admin.post('/api/admin/import/confirm', { import_id: importId });
  check('confirm succeeds', applied.status === 200, JSON.stringify(applied.data).slice(0, 200));
  check(
    'confirm reports 1 created, 0 failed',
    applied.data?.summary?.created === 1 && applied.data?.summary?.failed === 0,
    JSON.stringify(applied.data?.summary)
  );
  const productId = applied.data?.rows?.[0]?.product_id;
  check('the report names the product id', !!productId);

  const again = await admin.post('/api/admin/import/confirm', { import_id: importId });
  check('a repeated confirm is a no-op', again.status === 200 && again.data?.already_applied === true);
  const listAfter = await admin.get(`/api/admin/products-v2?search=${encodeURIComponent(key)}`);
  check(
    'confirming twice produced ONE product, not two',
    (listAfter.data?.products ?? []).filter((p) => p.sku === key).length === 1,
    JSON.stringify((listAfter.data?.products ?? []).map((p) => p.sku))
  );

  const okReport = await admin.raw('GET', `/api/admin/import/${importId}/report?format=csv`);
  keep('import-report-applied.csv', await okReport.text());
  keep('import-file-devices.csv', toCsv(fileRows));

  // ------------------------------------------------ 4. what actually landed
  console.log('\n4. the written structure');
  const rel = await admin.get(`/api/admin/products/${productId}/relations`);
  const groups = rel.data?.groups ?? [];
  const values = rel.data?.values ?? [];
  const colors = rel.data?.colors ?? [];
  const links = rel.data?.links ?? [];
  const images = rel.data?.images ?? [];
  check('two option groups were written', groups.length === 2, `groups=${groups.length}`);
  check('two option values were written', values.length === 2, `values=${values.length}`);
  check('two colours were written', colors.length === 2, `colors=${colors.length}`);
  check('the linked colour has both links', links.length === 2, `links=${links.length}`);
  check('two images were written', images.length === 2, `images=${images.length}`);
  check('exactly one image is primary', images.filter((i) => i.is_primary === 1).length === 1);
  check(
    'the images were stored, not left as file names',
    images.every((i) => String(i.url).startsWith('/files/')),
    JSON.stringify(images.map((i) => i.url))
  );
  check('inventory_mode came through as COLOR', rel.data?.product?.inventory_mode === 'COLOR', String(rel.data?.product?.inventory_mode));
  const black = colors.find((c) => c.name_en === 'Black');
  check('the colour stock landed on the colour row', black?.stock === 4, JSON.stringify(black ?? null).slice(0, 120));

  const detail = await admin.get(`/api/admin/products-v2/${productId}`);
  const doc = detail.data?.product;
  check('prices landed exactly', doc?.price_iqd === 900000 && doc?.prime_price_iqd === 870000 && doc?.pro_price_iqd === 850000,
    JSON.stringify([doc?.price_iqd, doc?.prime_price_iqd, doc?.pro_price_iqd]));
  check('both sale types landed', JSON.stringify(doc?.sale_types) === JSON.stringify(['direct_sale', 'pre_order']),
    JSON.stringify(doc?.sale_types));
  check('the name is identical in all three languages (never translated)',
    doc?.name_en === doc?.name_ar && doc?.name_ar === doc?.name_ckb,
    JSON.stringify([doc?.name_en, doc?.name_ar, doc?.name_ckb]));
  check('the section was recorded', doc?.category_id === devicesSection.id || doc?.sub_category_id === devicesSection.id);

  // -------------------------------------------------------- 5. round-trip
  console.log('\n5. export → import round-trip');
  const exp = await admin.raw(
    'GET',
    `/api/admin/import/export?ids=${encodeURIComponent(productId)}&format=csv`
  );
  const expText = await exp.text();
  check('export downloads', exp.status === 200 && expText.length > 100, `status=${exp.status}`);
  keep('export-devices.csv', expText);
  const expRows = parseCsv(expText);
  check('the export holds the product and its children', expRows.length === 8, `rows=${expRows.length}`);

  const roundTrip = await admin.upload('/api/admin/import/preview', 'roundtrip.csv', strToU8(expText), {
    category: devicesSection.id,
  });
  check('the exported file previews with no errors', roundTrip.data?.summary?.failed === 0,
    JSON.stringify(roundTrip.data?.rows?.[0]?.errors ?? []).slice(0, 300));
  check('the exported file matches the SAME product (update, not create)',
    roundTrip.data?.summary?.update === 1 && roundTrip.data?.summary?.create === 0,
    JSON.stringify(roundTrip.data?.summary));

  const applied2 = await admin.post('/api/admin/import/confirm', { import_id: roundTrip.data?.import_id });
  check('the round-trip import applies as an update', applied2.data?.summary?.updated === 1,
    JSON.stringify(applied2.data?.summary));

  const rel2 = await admin.get(`/api/admin/products/${productId}/relations`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const shape = (x) => ({
    groups: (x.groups ?? []).map((g) => [g.id, g.name_en]).sort(),
    values: (x.values ?? []).map((v) => [v.id, v.name_en, v.stock]).sort(),
    colors: (x.colors ?? []).map((c) => [c.id, c.name_en, c.hex, c.stock]).sort(),
    links: (x.links ?? []).map((l) => [l.color_id, l.option_value_id]).sort(),
    images: (x.images ?? []).map((i) => [i.id, i.url, i.sort_order, i.is_primary]).sort(),
    mode: x.product?.inventory_mode,
  });
  check('the round-trip preserved every id, order, stock and link',
    same(shape(rel.data), shape(rel2.data)),
    `${JSON.stringify(shape(rel.data)).slice(0, 200)}\n     vs ${JSON.stringify(shape(rel2.data)).slice(0, 200)}`);

  // ----------------------------------------------------- 6. failure report
  console.log('\n6. errors are reported, not swallowed');
  const badKey = `E2E-BAD-${rnd}`;
  const badRows = [
    columns,
    col({
      row_type: 'product',
      key: badKey,
      name: 'Bad Ladder',
      category: devicesSection.name_en || devicesSection.slug,
      price_iqd: '1000',
      prime_price_iqd: '900',
      pro_price_iqd: '950',
    }),
    col({ row_type: 'color', key: badKey, value: 'Nope', hex: 'not-a-hex' }),
    col({ row_type: 'color', key: 'MISSING-PARENT', value: 'Ghost', hex: '#000000' }),
  ];
  const badPrev = await admin.upload('/api/admin/import/preview', 'bad.csv', strToU8(toCsv(badRows)), {
    category: devicesSection.id,
  });
  check('a bad file still previews (it reports, it does not 500)', badPrev.status === 200, `status=${badPrev.status}`);
  check('the price ladder violation is reported', JSON.stringify(badPrev.data?.rows ?? []).includes('PRO'));
  check('the bad hex is reported against its own row', JSON.stringify(badPrev.data?.rows ?? []).includes('hex'),
    JSON.stringify(badPrev.data?.file_issues ?? []).slice(0, 200));
  check('the orphan child row is reported', JSON.stringify(badPrev.data).includes('MISSING-PARENT'));
  check('the failing product is marked failed', badPrev.data?.summary?.failed === 1, JSON.stringify(badPrev.data?.summary));

  const badApplied = await admin.post('/api/admin/import/confirm', { import_id: badPrev.data?.import_id });
  check('confirming a file whose only product failed writes nothing',
    badApplied.data?.summary?.created === 0 && badApplied.data?.summary?.skipped === 1,
    JSON.stringify(badApplied.data?.summary));

  const reportRes = await admin.raw('GET', `/api/admin/import/${badPrev.data?.import_id}/report?format=csv`);
  const reportText = await reportRes.text();
  check('the result report downloads as CSV', reportRes.status === 200 && reportText.includes('action'),
    `status=${reportRes.status}`);
  keep('import-report-rejected.csv', reportText);
  check('the report names the reason for each failure', reportText.includes('hex') || reportText.includes('PRO'),
    reportText.slice(0, 200));

  // ------------------------------------------------- 7. no URL extraction
  console.log('\n7. §2 — a product page is never scraped');
  const scrapeRows = [
    columns,
    col({
      row_type: 'product',
      key: `E2E-SCRAPE-${rnd}`,
      name: 'Scrape Attempt',
      category: devicesSection.name_en || devicesSection.slug,
      price_iqd: '1000',
    }),
    col({ row_type: 'image', key: `E2E-SCRAPE-${rnd}`, image: 'https://example.com/a-product-page', primary: 'yes' }),
  ];
  const scrape = await admin.upload('/api/admin/import/preview', 'scrape.csv', strToU8(toCsv(scrapeRows)), {
    category: devicesSection.id,
  });
  check('a non-image URL is refused rather than fetched as a page',
    scrape.data?.summary?.failed === 1,
    JSON.stringify(scrape.data?.rows?.[0]?.errors ?? []).slice(0, 200));

  // ---------------------------------------------------------------- done
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
