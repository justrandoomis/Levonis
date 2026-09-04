#!/usr/bin/env node
/**
 * BAMBU LAB A1 — one product, two models, two ways to buy each, end to end.
 *
 *     A1        — pre-order        A1        — direct sale
 *     A1 Combo  — pre-order        A1 Combo  — direct sale
 *
 * The unit tests pin the resolver's arithmetic. This drives the REAL stack —
 * the TXT importer, the relations writer, SQLite, the overlay, the public
 * product payload and the quote endpoint — and asserts the things only a
 * running system can prove:
 *
 *   1. the four cells exist as four option rows with four separate prices,
 *      PRO prices, PRIME prices, costs, stocks and lead times;
 *   2. choosing a pre-order cell REQUIRES a transport and choosing a direct
 *      cell REFUSES one, whatever the request says;
 *   3. the product's sale types were DERIVED from its options;
 *   4. the customer never sees a cost, at any level;
 *   5. an export re-imports to the same four cells (the owner's edit loop);
 *   6. AND — the thing that matters most — a product written the old way,
 *      with no availability on any option, behaves exactly as it did before.
 *
 *   node scripts/e2e-option-availability.mjs      (expects wrangler dev :8787)
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

let passed = 0;
let failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

class Client {
  constructor() { this.cookie = ''; }
  async raw(method, p, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    const res = await fetch(BASE + p, { method, headers: h, body });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return res;
  }
  async json(method, p, body) {
    const res = await this.raw(method, p, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, data, raw: res };
  }
  get(p) { return this.json('GET', p); }
  post(p, b) { return this.json('POST', p, b); }
  put(p, b) { return this.json('PUT', p, b); }
  async text(p) {
    const res = await this.raw('GET', p);
    return { status: res.status, body: await res.text() };
  }
}

const rnd = Math.random().toString(36).slice(2, 8);
const admin = new Client();
const guest = new Client();

/** The owner's product, as a TXT template. */
const templateFor = (slug) => `template_version=2
slug=${slug}
name_ar=Bambu Lab A1 ${rnd}
name_en=Bambu Lab A1 ${rnd}
status=active
price_iqd=899000
selling_type=mixed
transports.1.method=air
transports.1.commission_iqd=25000
transports.1.active=true

options.1.id=${slug}-a1-pre
options.1.name_ar=A1 - Pre-order
options.1.availability_type=pre_order
options.1.variant_key=a1
options.1.variant_label=A1
options.1.lead_time_text=3-4 weeks
options.1.lead_time_min_days=21
options.1.lead_time_max_days=28
options.1.stock=__NULL__
options.1.regular_price_iqd=899000
options.1.prime_price_iqd=885000
options.1.pro_price_iqd=799000
options.1.cost_iqd=700000

options.2.id=${slug}-a1-dir
options.2.name_ar=A1 - Direct Sale
options.2.availability_type=direct_sale
options.2.variant_key=a1
options.2.variant_label=A1
options.2.stock=4
options.2.regular_price_iqd=950000
options.2.prime_price_iqd=935000
options.2.pro_price_iqd=799000
options.2.cost_iqd=720000

options.3.id=${slug}-combo-pre
options.3.name_ar=A1 Combo - Pre-order
options.3.availability_type=pre_order
options.3.variant_key=a1-combo
options.3.variant_label=A1 Combo
options.3.lead_time_text=3-4 weeks
options.3.stock=__NULL__
options.3.regular_price_iqd=1099000
options.3.prime_price_iqd=1085000
options.3.pro_price_iqd=999000
options.3.cost_iqd=900000

options.4.id=${slug}-combo-dir
options.4.name_ar=A1 Combo - Direct Sale
options.4.availability_type=direct_sale
options.4.variant_key=a1-combo
options.4.variant_label=A1 Combo
options.4.stock=2
options.4.regular_price_iqd=1150000
options.4.prime_price_iqd=1135000
options.4.pro_price_iqd=999000
options.4.cost_iqd=920000
`;

/** A product exactly as it would have been written before this feature. */
const legacyTemplate = (slug) => `template_version=2
slug=${slug}
name_ar=Legacy direct ${rnd}
status=active
price_iqd=100000
selling_type=direct_sale
options.1.id=${slug}-o1
options.1.name_ar=Standard
options.1.regular_price_iqd=120000
`;

async function main() {
  console.log(`\nLEVONIS per-option availability — ${BASE}\n`);

  // ---------------------------------------------------------- an admin
  const email = `oav-${rnd}@test.local`;
  const password = 'oav-pass-1';
  let r = await admin.post('/api/auth/register', { email, username: `oav${rnd}`, name: 'Opt Avail', password });
  check('admin registered', r.status === 200, `${r.status}`);
  const { execSync } = await import('node:child_process');
  execSync(`npx wrangler d1 execute levonis-db --local --command ${JSON.stringify(`UPDATE users SET role='admin' WHERE email='${email}'`)}`, { stdio: 'pipe' });
  r = await admin.post('/api/auth/login', { email, password });
  check('admin signed in', r.status === 200, `${r.status}`);

  // ------------------------------------------------- 1. import the product
  console.log('\n1. the TXT template creates all four cells');
  const slug = `bambu-a1-${rnd}`;
  const parsed = await admin.post('/api/admin/template/parse', { text: templateFor(slug) });
  check('the template parses with no errors', parsed.status === 200 && (parsed.data?.errors ?? []).length === 0,
    JSON.stringify(parsed.data?.errors ?? parsed.data).slice(0, 200));
  check('and with no unknown keys — every new field is declared',
    (parsed.data?.unknown_keys ?? []).length === 0, JSON.stringify(parsed.data?.unknown_keys));

  const applied = await admin.post('/api/admin/template/apply', { text: templateFor(slug), mode: 'draft', confirm: true });
  check('it applies', applied.status === 200 && !!applied.data?.product_id, `${applied.status} ${JSON.stringify(applied.data).slice(0, 200)}`);
  const productId = applied.data?.product_id;
  if (!productId) { report(); return; }

  const doc = await admin.get(`/api/admin/products-v2/${productId}`);
  const opts = doc.data?.product?.options ?? [];
  check('four options were stored', opts.length === 4, `n=${opts.length}`);

  const byId = new Map(opts.map((o) => [o.id, o]));
  const cells = [
    [`${slug}-a1-pre`, 'pre_order', 'a1', 899000, 885000, 799000, 700000, null],
    [`${slug}-a1-dir`, 'direct_sale', 'a1', 950000, 935000, 799000, 720000, 4],
    [`${slug}-combo-pre`, 'pre_order', 'a1-combo', 1099000, 1085000, 999000, 900000, null],
    [`${slug}-combo-dir`, 'direct_sale', 'a1-combo', 1150000, 1135000, 999000, 920000, 2],
  ];
  for (const [id, availability, key, regular, prime, pro, cost, stock] of cells) {
    const o = byId.get(id);
    check(`${id}: stored with its own availability, model, prices, cost and stock`,
      !!o && o.availability_type === availability && o.variant_key === key &&
      o.regular_price_iqd === regular && o.prime_price_iqd === prime &&
      o.pro_price_iqd === pro && o.cost_iqd === cost && (o.stock ?? null) === stock,
      o ? JSON.stringify({ a: o.availability_type, k: o.variant_key, r: o.regular_price_iqd, p: o.prime_price_iqd, pro: o.pro_price_iqd, c: o.cost_iqd, s: o.stock }) : 'missing');
  }
  check('the pre-order cells carry the lead time, the direct cells do not',
    byId.get(`${slug}-a1-pre`)?.lead_time_text === '3-4 weeks' &&
    !(byId.get(`${slug}-a1-dir`)?.lead_time_text ?? ''),
    `${byId.get(`${slug}-a1-pre`)?.lead_time_text} / ${byId.get(`${slug}-a1-dir`)?.lead_time_text}`);
  check('the structured days survived alongside the prose',
    byId.get(`${slug}-a1-pre`)?.lead_time_min_days === 21 && byId.get(`${slug}-a1-pre`)?.lead_time_max_days === 28);

  // -------------------------------------------- 2. sale types were derived
  console.log('\n2. the product follows its options');
  const st = doc.data?.product?.sale_types ?? [];
  check('sale_types was DERIVED as mixed, from the options themselves',
    st.includes('direct_sale') && st.includes('pre_order'), JSON.stringify(st));
  check('and the legacy scalar is still one of the three words the column allows',
    ['direct_sale', 'pre_order', 'bundle'].includes(doc.data?.product?.selling_type), doc.data?.product?.selling_type);

  // ------------------------------------ 3. the option constrains the line
  console.log('\n3. the chosen cell decides how the line is fulfilled');
  const quote = (optionId, transportMethod) =>
    admin.post(`/api/admin/products-v2/${productId}/quote`, { optionId, transportMethod, tier: 'free' });

  let q = await quote(`${slug}-combo-pre`, '');
  check('a pre-order cell with no transport is refused',
    (q.data?.quote?.errors ?? q.data?.errors ?? []).includes('TRANSPORT_REQUIRED'),
    JSON.stringify(q.data).slice(0, 200));

  q = await quote(`${slug}-combo-dir`, 'air');
  check('a direct cell REFUSES a transport, however the request is crafted',
    (q.data?.quote?.errors ?? q.data?.errors ?? []).includes('TRANSPORT_NOT_APPLICABLE'),
    JSON.stringify(q.data).slice(0, 200));

  q = await quote(`${slug}-combo-pre`, 'air');
  const pre = q.data?.quote ?? q.data;
  check('the pre-order cell prices with its commission',
    (pre?.errors ?? []).length === 0 && pre?.unit_subtotal_iqd === 1_124_000,
    JSON.stringify({ e: pre?.errors, u: pre?.unit_subtotal_iqd }));

  q = await quote(`${slug}-combo-dir`, '');
  const dir = q.data?.quote ?? q.data;
  check('and the direct cell of the SAME product prices differently',
    (dir?.errors ?? []).length === 0 && dir?.unit_subtotal_iqd === 1_150_000,
    JSON.stringify({ e: dir?.errors, u: dir?.unit_subtotal_iqd }));

  // ------------------------------------------- 4. the customer sees no cost
  console.log('\n4. internal cost never reaches a customer');
  // /apply forces every CREATE to draft — a template must never publish a
  // product by itself — so the storefront read needs it live first. This is
  // the documented behaviour, not a workaround for a bug.
  execSync(`npx wrangler d1 execute levonis-db --local --command ${JSON.stringify(`UPDATE products SET status='active' WHERE id='${productId}'`)}`, { stdio: 'pipe' });
  const publicProduct = await guest.get(`/api/products/${slug}`);
  check('the product is publicly readable', publicProduct.status === 200, `${publicProduct.status}`);
  const raw = JSON.stringify(publicProduct.data ?? {});
  check('no cost_iqd anywhere in the public payload', !raw.includes('cost_iqd'),
    raw.slice(Math.max(0, raw.indexOf('cost_iqd') - 60), raw.indexOf('cost_iqd') + 60));
  const pubOpts = publicProduct.data?.product?.options ?? [];
  check('but the customer DOES get the availability and the lead time',
    pubOpts.length === 4 && pubOpts.some((o) => o.availability_type === 'pre_order' && o.lead_time_text === '3-4 weeks'),
    JSON.stringify(pubOpts.map((o) => ({ a: o.availability_type, l: o.lead_time_text }))));
  check('and the model key, so the page can offer two steps instead of four cards',
    new Set(pubOpts.map((o) => o.variant_key)).size === 2,
    JSON.stringify(pubOpts.map((o) => o.variant_key)));

  // ------------------------------------------------ 5. the edit round-trip
  console.log('\n5. export → re-import returns the same four cells');
  const exported = await admin.text(`/api/admin/template/export/${productId}`);
  check('the product exports', exported.status === 200, `${exported.status}`);
  for (const k of ['availability_type', 'variant_key', 'variant_label', 'lead_time_text']) {
    check(`the export carries options.1.${k}`, exported.body.includes(`options.1.${k}=`));
  }
  const reparsed = await admin.post('/api/admin/template/parse', { text: exported.body });
  check('the store’s own export re-parses with no errors',
    reparsed.status === 200 && (reparsed.data?.errors ?? []).length === 0,
    JSON.stringify(reparsed.data?.errors ?? []).slice(0, 200));
  const reapplied = await admin.post('/api/admin/template/apply', { text: exported.body, mode: 'update', confirm: true });
  check('and re-applies to the SAME product', reapplied.status === 200 && reapplied.data?.product_id === productId,
    `${reapplied.status} ${reapplied.data?.product_id}`);
  const after = await admin.get(`/api/admin/products-v2/${productId}`);
  const afterOpts = after.data?.product?.options ?? [];
  const sameCell = afterOpts.find((o) => o.id === `${slug}-combo-pre`);
  check('the round-tripped cell kept every one of its numbers',
    afterOpts.length === 4 && sameCell?.availability_type === 'pre_order' &&
    sameCell?.regular_price_iqd === 1_099_000 && sameCell?.pro_price_iqd === 999_000 &&
    sameCell?.cost_iqd === 900_000 && sameCell?.lead_time_text === '3-4 weeks' &&
    sameCell?.variant_key === 'a1-combo',
    JSON.stringify(sameCell));

  // ---------------------------------------- 6. an old product is untouched
  console.log('\n6. a product written the old way behaves exactly as before');
  const legacySlug = `legacy-${rnd}`;
  const legacyApplied = await admin.post('/api/admin/template/apply', { text: legacyTemplate(legacySlug), mode: 'draft', confirm: true });
  check('a template with no availability on any option still applies',
    legacyApplied.status === 200 && !!legacyApplied.data?.product_id,
    `${legacyApplied.status} ${JSON.stringify(legacyApplied.data).slice(0, 160)}`);
  const legacyId = legacyApplied.data?.product_id;
  if (legacyId) {
    const legacyDoc = await admin.get(`/api/admin/products-v2/${legacyId}`);
    check('its sale types are untouched — the options had no opinion',
      JSON.stringify(legacyDoc.data?.product?.sale_types) === JSON.stringify(['direct_sale']),
      JSON.stringify(legacyDoc.data?.product?.sale_types));
    check('its option inherits, rather than being assumed direct sale',
      (legacyDoc.data?.product?.options ?? [])[0]?.availability_type === '',
      JSON.stringify((legacyDoc.data?.product?.options ?? [])[0]?.availability_type));
    const lq = await admin.post(`/api/admin/products-v2/${legacyId}/quote`, { optionId: `${legacySlug}-o1`, tier: 'free' });
    const lqq = lq.data?.quote ?? lq.data;
    check('it still prices with no transport, exactly as it always did',
      (lqq?.errors ?? []).length === 0 && lqq?.unit_subtotal_iqd === 120_000,
      JSON.stringify({ e: lqq?.errors, u: lqq?.unit_subtotal_iqd }));
    const lqBad = await admin.post(`/api/admin/products-v2/${legacyId}/quote`, { optionId: `${legacySlug}-o1`, transportMethod: 'air', tier: 'free' });
    check('and still refuses a transport it never offered',
      ((lqBad.data?.quote ?? lqBad.data)?.errors ?? []).includes('TRANSPORT_NOT_APPLICABLE'));
  }

  report();
}

function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
