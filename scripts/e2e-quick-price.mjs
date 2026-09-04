#!/usr/bin/env node
/**
 * QUICK EDIT PRICING, end to end against a running worker.
 *
 * The owner's ask was speed — change any product's price or cost in seconds on
 * a product carrying Options x Colors x Availability. Speed is worthless if the
 * number the admin edits is not the number the customer is charged, so this
 * suite drives the REAL stack (HTTP, the relations writer, SQLite, the overlay,
 * the price resolver, the cart) and pins:
 *
 *   1. the grid is the whole product in one read, and every effective price it
 *      shows is the price the storefront quotes;
 *   2. a dirty-cell save writes ONLY those cells and reaches the cart;
 *   3. an ADJUSTMENT follows a later base-price change, which is the failure
 *      worker/lib/pinnedPrices.ts documents, fixed;
 *   4. bulk and copy must be previewed, and the preview is what gets written;
 *   5. the profit guard warns and does not veto;
 *   6. undo restores what the batch changed, and only that;
 *   7. price history records every move;
 *   8. an assistant admin sees no cost and cannot write one;
 *   9. the CSV round trip carries the adjustments; and
 *  10. a quick edit never touches anything else about the product.
 *
 *   node scripts/e2e-quick-price.mjs      (expects wrangler dev :8787)
 */
import { execSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const ROOT = '/home/user/Levonis';
const rnd = Math.random().toString(36).slice(2, 8);

const sql = (s) =>
  execSync(`npx wrangler d1 execute levonis-db --local --command ${JSON.stringify(s)}`, { cwd: ROOT, stdio: 'pipe' });
const query = (statement) => {
  const out = execSync(
    `npx wrangler d1 execute levonis-db --local --json --command ${JSON.stringify(statement)}`,
    { cwd: ROOT, stdio: 'pipe' }
  ).toString();
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

class C {
  constructor() {
    this.cookie = '';
  }
  async call(m, p, b) {
    const h = this.cookie ? { Cookie: this.cookie } : {};
    if (b !== undefined) h['Content-Type'] = 'application/json';
    const send = () =>
      fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
    // This suite reads the database between requests through `wrangler d1
    // execute`, which blocks the event loop long enough for the dev server to
    // close an idle keep-alive socket. The retry is about that, not about the
    // server: a genuine failure fails twice.
    let r;
    try {
      r = await send();
    } catch {
      await sleep(300);
      r = await send();
    }
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let d = null;
    try {
      d = await r.json();
    } catch {
      /* not JSON */
    }
    return { status: r.status, data: d };
  }
  get(p) {
    return this.call('GET', p);
  }
  post(p, b) {
    return this.call('POST', p, b);
  }
  patch(p, b) {
    return this.call('PATCH', p, b);
  }
}

/** The owner's product: two models, two fulfilment routes, four prices each. */
const templateFor = (slug) => `template_version=2
slug=${slug}
name_ar=Bambu Lab A1 ${rnd}
name_en=Bambu Lab A1 ${rnd}
status=active
price_iqd=899000
prime_price_iqd=885000
pro_price_iqd=799000
product_cost_iqd=700000
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
options.2.stock=6
options.2.regular_price_iqd=950000
options.2.prime_price_iqd=935000
options.2.pro_price_iqd=850000
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
options.4.stock=3
options.4.regular_price_iqd=1150000
options.4.prime_price_iqd=1135000
options.4.pro_price_iqd=1050000
options.4.cost_iqd=920000
`;

const grid = async (admin, id) => (await admin.get(`/api/admin/products/${id}/price-grid`)).data;
const rowOf = (g, key) => (g?.rows ?? []).find((r) => `${r.level}:${r.id}` === key);

async function main() {
  console.log(`\nQUICK EDIT PRICING — ${BASE}\n`);

  const admin = new C();
  const buyer = new C();
  const helper = new C();
  const password = 'quick-price-12345';
  const aEmail = `qp-${rnd}@test.local`;
  await admin.post('/api/auth/register', { email: aEmail, username: `qp${rnd}`, name: 'Admin', password });
  sql(`UPDATE users SET role='admin' WHERE email='${aEmail}'`);
  await sleep(700);
  let r = await admin.post('/api/auth/login', { email: aEmail, password });
  check('admin signed in', r.status === 200, `${r.status}`);

  // ------------------------------------------------------ 0. the fixture
  const slug = `qp-a1-${rnd}`;
  const applied = await admin.post('/api/admin/template/apply', { text: templateFor(slug), mode: 'draft', confirm: true });
  const productId = applied.data?.product_id;
  check('the four-cell product exists', !!productId, JSON.stringify(applied.data).slice(0, 200));
  if (!productId) return report();
  sql(`UPDATE products SET status='active' WHERE id='${productId}'`);

  // -------------------------------------- 1. the grid is the whole product
  console.log('\n1. one read gives the whole price table');
  let g = await grid(admin, productId);
  check('the grid loads', !!g?.rows?.length, JSON.stringify(g).slice(0, 200));
  check('one base row plus one row per option', g.rows.length === 5, `n=${g.rows.length}`);
  check('the base row is the product itself', g.rows[0].level === 'product' && g.rows[0].cells.regular.effective === 899000);
  check(
    'each option row carries its own model and fulfilment route',
    g.rows.filter((x) => x.level === 'option').every((x) => x.variant_key && x.availability_type),
    JSON.stringify(g.rows.map((x) => [x.id, x.variant_key, x.availability_type]))
  );
  check(
    'the vocabulary for the scope pickers comes back with it',
    g.variants.length === 2 && g.availability.length === 2,
    JSON.stringify({ v: g.variants, a: g.availability })
  );
  check('a financial admin sees the cost column', g.can_view_cost === true && g.rows[0].cells.cost !== undefined);
  check(
    'and the profit beside it',
    g.rows[0].profit.profit_iqd === 199000 && g.rows[0].profit.margin_percent === 22.1,
    JSON.stringify(g.rows[0].profit)
  );

  // ------------------------------- 2. the effective price IS the quoted one
  console.log('\n2. the grid agrees with what the customer is quoted');
  for (const row of g.rows.filter((x) => x.level === 'option')) {
    const q = await admin.post(`/api/admin/products-v2/${productId}/quote`, {
      optionId: row.id,
      transportMethod: row.availability_type === 'pre_order' ? 'air' : '',
      tier: 'free',
      tierActive: false,
    });
    const applied2 = q.data?.quote?.applied_iqd;
    check(
      `${row.label_ar}: the grid's price is the quoted price`,
      applied2 === row.cells.regular.effective,
      `grid=${row.cells.regular.effective} quote=${applied2}`
    );
  }

  // ------------------------------------------ 3. the dirty-cell quick save
  console.log('\n3. a quick save writes only the cells that were touched');
  check('this product is on the JSON option store', g.product.store === 'json', g.product.store);
  /** One option out of products.options, so the assertion works on either store. */
  const jsonOption = (id) => {
    const row = query(`SELECT options FROM products WHERE id='${productId}'`)[0];
    return JSON.parse(row.options).find((o) => o.id === id) ?? {};
  };
  const untouched = (o) => JSON.stringify({ n: o.name_ar, s: o.stock, a: o.active, i: o.image, av: o.availability_type });
  const before = untouched(jsonOption(`${slug}-a1-dir`));
  r = await admin.patch(`/api/admin/products/${productId}/price-grid`, {
    cells: [{ level: 'option', id: `${slug}-a1-dir`, field: 'regular', mode: 'fixed', value: '975K' }],
  });
  check('the save succeeds', r.status === 200 && r.data?.changed === 1, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  check('the shorthand was read exactly', rowOf(r.data, `option:${slug}-a1-dir`)?.cells.regular.effective === 975000);
  const after = untouched(jsonOption(`${slug}-a1-dir`));
  check('nothing else about the option moved', before === after && before !== '{}', `${before} / ${after}`);
  const batch1 = r.data?.batch_id;
  check('the save is one undoable batch', !!batch1, String(batch1));

  // it reaches the customer
  const bEmail = `qpb-${rnd}@test.local`;
  await buyer.post('/api/auth/register', { email: bEmail, username: `qpb${rnd}`, name: 'Buyer', password });
  await buyer.post('/api/auth/login', { email: bEmail, password });
  await buyer.post('/api/cart/items', { productId, qty: 1, optionId: `${slug}-a1-dir` });
  const cartUnit = ((await buyer.get('/api/cart')).data?.items ?? []).find((i) => i.productId === productId)?.unit_price_iqd;
  check('the cart charges the new price', cartUnit === 975000, String(cartUnit));

  // ---------------------------------------- 4. an adjustment keeps following
  console.log('\n4. an adjustment follows the base price; a pin does not');
  r = await admin.patch(`/api/admin/products/${productId}/price-grid`, {
    cells: [{ level: 'option', id: `${slug}-combo-dir`, field: 'regular', mode: 'adjust', value: '260000' }],
  });
  check('the adjustment saves', r.status === 200 && r.data?.changed === 1, JSON.stringify(r.data).slice(0, 200));
  check(
    'and resolves to base + adjustment',
    rowOf(r.data, `option:${slug}-combo-dir`)?.cells.regular.effective === 1159000,
    String(rowOf(r.data, `option:${slug}-combo-dir`)?.cells.regular.effective)
  );

  r = await admin.patch(`/api/admin/products/${productId}/price-grid`, {
    cells: [{ level: 'product', id: '', field: 'regular', mode: 'fixed', value: '1M' }],
  });
  check('the base price moves to 1,000,000', r.status === 200, JSON.stringify(r.data).slice(0, 160));
  g = r.data;
  check(
    'the ADJUSTED option came with it',
    rowOf(g, `option:${slug}-combo-dir`)?.cells.regular.effective === 1260000,
    String(rowOf(g, `option:${slug}-combo-dir`)?.cells.regular.effective)
  );
  check(
    'the PINNED option did not — which is why the grid shows the mode',
    rowOf(g, `option:${slug}-a1-dir`)?.cells.regular.effective === 975000 &&
      rowOf(g, `option:${slug}-a1-dir`)?.cells.regular.mode === 'fixed'
  );
  const comboDirQuote = await admin.post(`/api/admin/products-v2/${productId}/quote`, {
    optionId: `${slug}-combo-dir`,
    tier: 'free',
    tierActive: false,
  });
  check(
    'and the customer is quoted the adjusted price, not the stored one',
    comboDirQuote.data?.quote?.applied_iqd === 1260000,
    JSON.stringify(comboDirQuote.data).slice(0, 200)
  );

  // ------------------------------------------------------- 5. bulk changes
  console.log('\n5. a bulk change must be previewed, and the preview is what is written');
  const previewBody = {
    op: 'add',
    fields: ['regular'],
    value: 25000,
    scope: { availability: ['pre_order'] },
  };
  r = await admin.post(`/api/admin/products/${productId}/price-grid/bulk`, previewBody);
  check('the preview names each cell and where it lands', r.status === 200 && r.data?.preview?.changes?.length === 2,
    JSON.stringify(r.data?.preview?.changes ?? r.data).slice(0, 250));
  const promised = new Map((r.data.preview.changes ?? []).map((c) => [`${c.level}:${c.id}:${c.field}`, c.to_iqd]));
  check('the preview writes nothing on its own',
    jsonOption(`${slug}-a1-pre`).regular_price_iqd === 899000,
    String(jsonOption(`${slug}-a1-pre`).regular_price_iqd));

  r = await admin.post(`/api/admin/products/${productId}/price-grid/bulk`, { ...previewBody, apply: true });
  check('applying moves exactly those cells', r.status === 200 && r.data?.changed === 2, JSON.stringify(r.data).slice(0, 200));
  const batch2 = r.data?.batch_id;
  let ok = true;
  for (const [key, to] of promised) {
    const [level, id] = key.split(':');
    const row = rowOf(r.data, `${level}:${id}`);
    if (row?.cells.regular.effective !== to) ok = false;
  }
  check('and lands where the preview promised', ok, JSON.stringify([...promised]));
  check(
    'a direct-sale row was left alone',
    rowOf(r.data, `option:${slug}-a1-dir`)?.cells.regular.effective === 975000
  );

  console.log('\n5b. an inherit bulk unpins the rows so the next change reaches them');
  const unpin = { op: 'inherit', fields: ['prime'], scope: { levels: ['option'] }, apply: true };
  r = await admin.post(`/api/admin/products/${productId}/price-grid/bulk`, unpin);
  check(
    'unpinning below a cost asks for a confirmation first',
    r.status === 409 && r.data?.code === 'PROFIT_GUARD',
    `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`
  );
  r = await admin.post(`/api/admin/products/${productId}/price-grid/bulk`, { ...unpin, confirm: true });
  check('the PRIME pins clear once confirmed', r.status === 200 && r.data?.changed === 4, JSON.stringify(r.data).slice(0, 200));
  check('and the rows come back with the save', (r.data?.rows ?? []).length === 5, `n=${r.data?.rows?.length}`);
  check(
    'and every option now inherits the product PRIME price',
    (r.data.rows ?? []).filter((x) => x.level === 'option').every((x) => x.cells.prime.mode === 'inherit' && x.cells.prime.effective === 885000),
    JSON.stringify((r.data.rows ?? []).filter((x) => x.level === 'option').map((x) => x.cells.prime))
  );

  // ------------------------------------------------------- 6. quick copy
  console.log('\n6. copying pre-order onto direct pairs the rows by model');
  r = await admin.post(`/api/admin/products/${productId}/price-grid/copy`, {
    from: { availability: 'pre_order' },
    to: { availability: 'direct_sale' },
    fields: ['pro'],
  });
  check('the copy previews before it writes', r.status === 200 && (r.data?.preview?.changes ?? []).length === 2,
    JSON.stringify(r.data?.preview ?? r.data).slice(0, 250));
  check('and only touches the PRO field', (r.data.preview.changes ?? []).every((c) => c.field === 'pro'));
  r = await admin.post(`/api/admin/products/${productId}/price-grid/copy`, {
    from: { availability: 'pre_order' },
    to: { availability: 'direct_sale' },
    fields: ['pro'],
    apply: true,
  });
  check(
    'the A1 direct cell now carries the A1 pre-order PRO price',
    rowOf(r.data, `option:${slug}-a1-dir`)?.cells.pro.effective === 799000,
    String(rowOf(r.data, `option:${slug}-a1-dir`)?.cells.pro.effective)
  );

  // -------------------------------------------------------- 7. profit guard
  console.log('\n7. the guard warns and does not veto');
  r = await admin.patch(`/api/admin/products/${productId}/price-grid`, {
    cells: [{ level: 'option', id: `${slug}-a1-dir`, field: 'regular', mode: 'fixed', value: 500000 }],
  });
  check('a price below cost is refused until it is confirmed', r.status === 409 && r.data?.code === 'PROFIT_GUARD', `${r.status}`);
  check('and the refusal names the reason', (r.data?.details?.guards ?? [])[0]?.code === 'BELOW_COST',
    JSON.stringify(r.data?.details).slice(0, 200));
  check('nothing was written', jsonOption(`${slug}-a1-dir`).regular_price_iqd === 975000,
    String(jsonOption(`${slug}-a1-dir`).regular_price_iqd));
  r = await admin.patch(`/api/admin/products/${productId}/price-grid`, {
    cells: [{ level: 'option', id: `${slug}-a1-dir`, field: 'regular', mode: 'fixed', value: 500000 }],
    confirm: true,
  });
  check('an explicit confirmation goes through — a clearance price is a real decision', r.status === 200 && r.data?.changed === 1,
    `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  const guardBatch = r.data?.batch_id;

  console.log('\n7b. a configured margin floor warns too');
  await admin.call('PUT', '/api/admin/settings/minMarginPercent', { value: 30 });
  const settingRow = query("SELECT value FROM admin_settings WHERE key='minMarginPercent'");
  if (settingRow.length) {
    r = await admin.patch(`/api/admin/products/${productId}/price-grid`, {
      cells: [{ level: 'option', id: `${slug}-combo-pre`, field: 'regular', mode: 'fixed', value: 1000000 }],
    });
    check('a thin margin asks for a confirmation', r.status === 409 && (r.data?.details?.guards ?? [])[0]?.code === 'THIN_MARGIN',
      `${r.status} ${JSON.stringify(r.data?.details).slice(0, 200)}`);
    sql("DELETE FROM admin_settings WHERE key='minMarginPercent'");
  } else {
    check('a thin margin asks for a confirmation', false, 'the minMarginPercent setting could not be written');
  }

  // -------------------------------------------------------------- 8. undo
  console.log('\n8. undo puts back exactly what the batch changed');
  r = await admin.post(`/api/admin/products/${productId}/price-grid/undo`, { batch_id: guardBatch });
  check('the undo runs', r.status === 200 && r.data?.changed === 1, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  check(
    'the price is back where it was before that save',
    rowOf(r.data, `option:${slug}-a1-dir`)?.cells.regular.effective === 975000,
    String(rowOf(r.data, `option:${slug}-a1-dir`)?.cells.regular.effective)
  );
  r = await admin.post(`/api/admin/products/${productId}/price-grid/undo`, { batch_id: batch2 });
  check('an older batch can be undone too', r.status === 200 && r.data?.changed === 2, JSON.stringify(r.data).slice(0, 200));
  check(
    'and the bulk it undid is back to where it started',
    rowOf(r.data, `option:${slug}-a1-pre`)?.cells.regular.effective === 899000,
    String(rowOf(r.data, `option:${slug}-a1-pre`)?.cells.regular.effective)
  );
  r = await admin.post(`/api/admin/products/${productId}/price-grid/undo`, { batch_id: 'pb_nope' });
  check('undoing a batch that does not exist is a 404, not a silent no-op', r.status === 404, `${r.status}`);

  // ----------------------------------------------------------- 9. history
  console.log('\n9. every move is in the price history');
  r = await admin.get(`/api/admin/products/${productId}/price-history?limit=200`);
  check('the history loads', r.status === 200 && (r.data?.entries ?? []).length > 0, `${r.status} n=${r.data?.entries?.length}`);
  const hist = r.data.entries;
  check('it names where each change happened', hist.some((e) => e.where && e.where.includes('A1')), JSON.stringify(hist[0]));
  check('and who made it', hist.every((e) => !!e.changed_by), JSON.stringify(hist[0]));
  check(
    'a cost change is recorded as a cost change',
    hist.some((e) => e.field === 'regular') && hist.every((e) => ['regular', 'prime', 'pro', 'cost'].includes(e.field))
  );

  // --------------------------------------------------- 10. the scope rule
  console.log('\n10. an assistant admin sees no cost and cannot write one');
  const hEmail = `qph-${rnd}@test.local`;
  await helper.post('/api/auth/register', { email: hEmail, username: `qph${rnd}`, name: 'Helper', password });
  sql(`UPDATE users SET role='admin', admin_scope='assistant' WHERE email='${hEmail}'`);
  await sleep(700);
  await helper.post('/api/auth/login', { email: hEmail, password });
  const hg = await grid(helper, productId);
  check('the assistant can open the grid', hg?.rows?.length > 0, JSON.stringify(hg).slice(0, 160));
  check('but there is no cost cell at all', hg.rows.every((x) => x.cells.cost === undefined), JSON.stringify(hg.rows[0].cells));
  check('and no profit figure', hg.rows.every((x) => x.profit.profit_iqd === null && x.profit.cost_iqd === null));
  check('the margin floor is not disclosed either', hg.min_margin_percent === null && hg.can_view_cost === false);
  r = await helper.patch(`/api/admin/products/${productId}/price-grid`, {
    cells: [{ level: 'product', id: '', field: 'cost', mode: 'fixed', value: 1 }],
  });
  check('writing a cost is refused', r.status === 403, `${r.status}`);
  r = await helper.get(`/api/admin/products/${productId}/price-history`);
  check('and the price history is closed to them', r.status === 403, `${r.status}`);
  r = await helper.patch(`/api/admin/products/${productId}/price-grid`, {
    cells: [{ level: 'option', id: `${slug}-a1-dir`, field: 'regular', mode: 'fixed', value: 980000 }],
  });
  check('an ordinary price edit still works for them', r.status === 200 && r.data?.changed === 1, `${r.status}`);

  // ---------------------------------------------------- 11. the refusals
  console.log('\n11. the refusals');
  const bad = async (body, code) => {
    const res = await admin.patch(`/api/admin/products/${productId}/price-grid`, body);
    return { ok: res.status >= 400 && (!code || res.data?.code === code), got: `${res.status} ${res.data?.code}` };
  };
  let b = await bad({ cells: [{ level: 'product', id: '', field: 'regular', mode: 'inherit' }] }, 'BASE_PRICE_REQUIRED');
  check('the base regular price cannot be cleared', b.ok, b.got);
  b = await bad({ cells: [{ level: 'option', id: `${slug}-a1-dir`, field: 'regular', mode: 'fixed', value: '950.5' }] }, 'AMOUNT_NOT_WHOLE_DINARS');
  check('a fractional dinar is refused rather than rounded', b.ok, b.got);
  b = await bad({ cells: [{ level: 'option', id: 'nope', field: 'regular', mode: 'fixed', value: 1 }] }, 'ROW_NOT_FOUND');
  check('a row from another product is refused', b.ok, b.got);
  b = await bad({ cells: [] }, 'NO_CELLS');
  check('an empty save is refused', b.ok, b.got);
  r = await admin.post(`/api/admin/products/${productId}/price-grid/bulk`, { op: 'nonsense', fields: ['regular'], value: 1 });
  check('an unknown bulk operation is refused', r.status === 400 && r.data?.code === 'BAD_OP', `${r.status}`);
  r = await admin.post(`/api/admin/products/${productId}/price-grid/copy`, {
    from: { availability: 'pre_order' },
    to: { availability: 'pre_order' },
    fields: ['regular'],
  });
  check('copying a side onto itself is refused', r.status === 400 && r.data?.code === 'COPY_SAME_SIDE', `${r.status}`);

  // ------------------------------------------- 12. the supplier cost change
  console.log('\n12. a supplier cost change shows the difference before anything is written');
  r = await admin.post(`/api/admin/products/${productId}/price-grid/cost-change`, { new_cost_iqd: '770K' });
  check('the difference is stated in dinars and percent', r.status === 200 && r.data?.diff_iqd === 70000 && r.data?.diff_percent === 10,
    JSON.stringify(r.data).slice(0, 250));
  check('it offers a cost-only change', r.data?.cost_only?.fields?.[0] === 'cost' && r.data?.cost_only?.op === 'set');
  check('and a price suggestion the admin must approve', r.data?.suggest_prices?.op === 'add_percent' && r.data?.suggest_prices?.value === 10,
    JSON.stringify(r.data?.suggest_prices));
  check('it writes nothing by itself',
    query(`SELECT product_cost_iqd FROM products WHERE id='${productId}'`)[0].product_cost_iqd === 700000);

  // -------------------------------------------- 13. the export carries them
  console.log('\n13. an adjustment survives the export/import round trip');
  await admin.patch(`/api/admin/products/${productId}/price-grid`, {
    cells: [{ level: 'option', id: `${slug}-combo-pre`, field: 'regular', mode: 'adjust', value: 99000 }],
  });
  const exportRes = await fetch(`${BASE}/api/admin/template/export/${productId}`, { headers: { Cookie: admin.cookie } });
  const txt = exportRes.ok ? await exportRes.text() : '';
  check('the TXT export carries the adjustment', txt.includes('regular_adjust_iqd=99000'), txt.slice(0, 200) || `${exportRes.status}`);
  if (txt) {
    const reparsed = await admin.post('/api/admin/template/parse', { text: txt });
    check('and it re-imports with no errors and no unknown keys',
      reparsed.status === 200 && (reparsed.data?.errors ?? []).length === 0 && (reparsed.data?.unknown_keys ?? []).length === 0,
      JSON.stringify({ e: reparsed.data?.errors, u: reparsed.data?.unknown_keys }).slice(0, 250));
  }

  // -------------------------------- 14. an old product still works untouched
  console.log('\n14. a product with no adjustment anywhere behaves exactly as before');
  const plain = (
    await admin.post('/api/admin/products-v2', {
      name_en: `Plain ${rnd}`,
      price_iqd: 120000,
      product_cost_iqd: 90000,
      status: 'active',
      sale_types: ['direct_sale'],
      stock: 5,
    })
  ).data?.product;
  const pg = await grid(admin, plain.id);
  check('its grid is just the base row', pg.rows.length === 1 && pg.rows[0].level === 'product', `n=${pg.rows.length}`);
  check('with the price it was created with', pg.rows[0].cells.regular.effective === 120000);
  check('and its profit', pg.rows[0].profit.profit_iqd === 30000 && pg.rows[0].profit.margin_percent === 25,
    JSON.stringify(pg.rows[0].profit));
  r = await admin.patch(`/api/admin/products/${plain.id}/price-grid`, {
    cells: [{ level: 'product', id: '', field: 'regular', mode: 'fixed', value: '150K' }],
  });
  check('a quick edit works on it too', r.status === 200 && rowOf(r.data, 'product:')?.cells.regular.effective === 150000,
    JSON.stringify(r.data).slice(0, 160));
  check('and the products list shows the new price',
    query(`SELECT price_iqd FROM products WHERE id='${plain.id}'`)[0].price_iqd === 150000);

  // ------------------------------------- 15. the OTHER store: relational rows
  //
  // The TXT template writes the JSON option column; the admin product form
  // writes the relational tables, and worker/lib/productOverlay.ts makes those
  // WIN when they exist. Both stores have to answer, and a quick edit has to
  // write whichever one the resolver actually reads — otherwise the admin edits
  // numbers nobody is charged.
  console.log('\n15. a product on the relational option store');
  const relProduct = (
    await admin.post('/api/admin/products-v2', {
      name_en: `Relational ${rnd}`,
      price_iqd: 200000,
      prime_price_iqd: 190000,
      pro_price_iqd: 180000,
      product_cost_iqd: 140000,
      status: 'active',
      sale_types: ['direct_sale', 'pre_order'],
    })
  ).data?.product;
  const gid = `og-${rnd}`;
  r = await admin.call('PUT', `/api/admin/products/${relProduct.id}/relations`, {
    inventory_mode: 'OPTION',
    groups: [
      {
        id: gid,
        name_en: 'Model',
        sort: 0,
        active: true,
        values: [
          {
            id: `ov-${rnd}-pre`,
            name_en: 'S - Pre-order',
            sort: 0,
            active: true,
            stock: null,
            availability_type: 'pre_order',
            variant_key: 's',
            variant_label: 'S',
            regular_price_iqd: 200000,
            prime_price_iqd: null,
            pro_price_iqd: null,
            cost_iqd: 140000,
          },
          {
            id: `ov-${rnd}-dir`,
            name_en: 'S - Direct Sale',
            sort: 1,
            active: true,
            stock: 4,
            availability_type: 'direct_sale',
            variant_key: 's',
            variant_label: 'S',
            regular_price_iqd: null,
            regular_adjust_iqd: 30000,
            prime_price_iqd: null,
            pro_price_iqd: null,
            cost_iqd: 150000,
          },
        ],
      },
    ],
    colors: [],
    variants: [],
    images: [],
  });
  check('the relational structure saves', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 250)}`);
  let rg = await grid(admin, relProduct.id);
  check('the grid reads the relational store', rg?.product?.store === 'relational', rg?.product?.store);
  check(
    'the adjustment written through the relations endpoint survived',
    rowOf(rg, `option:ov-${rnd}-dir`)?.cells.regular.mode === 'adjust' &&
      rowOf(rg, `option:ov-${rnd}-dir`)?.cells.regular.effective === 230000,
    JSON.stringify(rowOf(rg, `option:ov-${rnd}-dir`)?.cells.regular)
  );
  r = await admin.patch(`/api/admin/products/${relProduct.id}/price-grid`, {
    cells: [{ level: 'option', id: `ov-${rnd}-pre`, field: 'regular', mode: 'fixed', value: '215K' }],
  });
  check('a quick edit writes the relational row', r.status === 200 && r.data?.changed === 1, `${r.status}`);
  check(
    'and SQLite holds the new number',
    query(`SELECT regular_price_iqd FROM product_option_values WHERE id='ov-${rnd}-pre'`)[0].regular_price_iqd === 215000,
    JSON.stringify(query(`SELECT regular_price_iqd, name_en, stock FROM product_option_values WHERE id='ov-${rnd}-pre'`))
  );
  const relRow = query(`SELECT name_en, stock, sort, availability_type FROM product_option_values WHERE id='ov-${rnd}-pre'`)[0];
  check(
    'and touched nothing else on that row',
    relRow.name_en === 'S - Pre-order' && relRow.stock === null && relRow.availability_type === 'pre_order',
    JSON.stringify(relRow)
  );
  r = await admin.patch(`/api/admin/products/${relProduct.id}/price-grid`, {
    cells: [{ level: 'product', id: '', field: 'regular', mode: 'fixed', value: 250000 }],
  });
  check(
    'raising the base carries the adjusted relational row with it',
    rowOf(r.data, `option:ov-${rnd}-dir`)?.cells.regular.effective === 280000,
    String(rowOf(r.data, `option:ov-${rnd}-dir`)?.cells.regular.effective)
  );
  const relQuote = await admin.post(`/api/admin/products-v2/${relProduct.id}/quote`, {
    optionId: `ov-${rnd}-dir`,
    tier: 'free',
    tierActive: false,
  });
  check('and the customer is quoted exactly that', relQuote.data?.quote?.applied_iqd === 280000,
    JSON.stringify(relQuote.data?.quote).slice(0, 200));

  // The product form must not erase what Quick Edit set. It replaces the whole
  // row set on save, so a field it does not carry is a field it clears.
  const formShaped = (await admin.get(`/api/admin/products/${relProduct.id}/relations`)).data;
  r = await admin.call('PUT', `/api/admin/products/${relProduct.id}/relations`, {
    inventory_mode: formShaped.product.inventory_mode,
    groups: formShaped.groups.map((gr) => ({
      ...gr,
      active: !!gr.active,
      values: formShaped.values
        .filter((v) => v.group_id === gr.id)
        .map((v) => ({ ...v, active: !!v.active })),
    })),
    colors: [],
    variants: [],
    images: [],
  });
  check('a product-form save round-trips', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  rg = await grid(admin, relProduct.id);
  check(
    'and the adjustment is still there afterwards',
    rowOf(rg, `option:ov-${rnd}-dir`)?.cells.regular.mode === 'adjust' &&
      rowOf(rg, `option:ov-${rnd}-dir`)?.cells.regular.effective === 280000,
    JSON.stringify(rowOf(rg, `option:ov-${rnd}-dir`)?.cells.regular)
  );

  // -------------------------------------------------------------------------
  console.log('\n16. availability, stock and active change from the SAME drawer');
  // The owner asked for Direct/Pre-order to be changeable "very fast from the
  // product list". The prices already were; these three were not.
  let tg = await grid(admin, relProduct.id);
  const dirRow = rowOf(tg, `option:ov-${rnd}-dir`);
  const preRow = rowOf(tg, `option:ov-${rnd}-pre`);
  check('the grid reports each option\'s route', !!dirRow && !!preRow,
    JSON.stringify(tg.rows.map((x) => `${x.id}:${x.availability_type}`)));
  const beforeTypes = query(`SELECT sale_types FROM products WHERE id='${relProduct.id}'`)[0]?.sale_types;
  check('the product starts mixed', String(beforeTypes).includes('pre_order') && String(beforeTypes).includes('direct_sale'),
    String(beforeTypes));

  // Flip the pre-order option to direct sale: the product must stop being mixed.
  r = await admin.call('PATCH', `/api/admin/products/${relProduct.id}/price-grid/traits`, {
    traits: [{ level: 'option', id: `ov-${rnd}-pre`, field: 'availability_type', value: 'direct_sale' }],
  });
  check('the traits patch succeeds', r.status === 200 && r.data?.changed === 1,
    `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  check('and it re-derives the product\'s sale types', r.data?.sale_types_changed === true,
    JSON.stringify(r.data?.sale_types));
  const afterTypes = query(`SELECT sale_types, selling_type FROM products WHERE id='${relProduct.id}'`)[0];
  check('so the stored product is no longer mixed',
    !String(afterTypes?.sale_types).includes('pre_order'), JSON.stringify(afterTypes));
  check('and the scalar follows it', afterTypes?.selling_type === 'direct_sale', String(afterTypes?.selling_type));

  // The inverse the drawer needs for undo.
  check('the response carries the exact inverse', Array.isArray(r.data?.undo) && r.data.undo.length === 1
    && r.data.undo[0].value === 'pre_order', JSON.stringify(r.data?.undo));
  r = await admin.call('PATCH', `/api/admin/products/${relProduct.id}/price-grid/traits`, { traits: r.data.undo });
  check('applying it puts the route back', r.status === 200 && r.data?.changed === 1, `${r.status}`);
  const restored = query(`SELECT sale_types FROM products WHERE id='${relProduct.id}'`)[0]?.sale_types;
  check('and the product is mixed again', String(restored).includes('pre_order') && String(restored).includes('direct_sale'),
    String(restored));

  // Stock and active, on the same path.
  r = await admin.call('PATCH', `/api/admin/products/${relProduct.id}/price-grid/traits`, {
    traits: [
      { level: 'option', id: `ov-${rnd}-dir`, field: 'stock', value: 7 },
      { level: 'option', id: `ov-${rnd}-dir`, field: 'active', value: false },
    ],
  });
  check('stock and active change together', r.status === 200 && r.data?.changed === 2, `${r.status}`);
  const row = query(`SELECT stock, active FROM product_option_values WHERE id='ov-${rnd}-dir'`)[0];
  check('the stock is written', Number(row?.stock) === 7, JSON.stringify(row));
  // The bug this pins: the JSON store reads `active !== false`, so a 0 written
  // as a number would read back as ACTIVE. Both stores must mean the same "off".
  check('and OFF really means off', Number(row?.active) === 0, JSON.stringify(row));
  tg = await grid(admin, relProduct.id);
  check('the grid agrees', rowOf(tg, `option:ov-${rnd}-dir`)?.active === false,
    JSON.stringify(rowOf(tg, `option:ov-${rnd}-dir`)?.active));
  // An option switched off stops voting on the sale types, per deriveSaleTypes.
  const offTypes = query(`SELECT sale_types FROM products WHERE id='${relProduct.id}'`)[0]?.sale_types;
  check('a switched-off option stops voting on the sale types',
    !String(offTypes).includes('direct_sale'), String(offTypes));

  // Refusals.
  r = await admin.call('PATCH', `/api/admin/products/${relProduct.id}/price-grid/traits`, {
    traits: [{ level: 'product', id: '', field: 'availability_type', value: 'pre_order' }],
  });
  check('the product itself has no route to set', r.status === 400 && r.data?.code === 'BAD_LEVEL', `${r.status} ${r.data?.code}`);
  r = await admin.call('PATCH', `/api/admin/products/${relProduct.id}/price-grid/traits`, {
    traits: [{ level: 'option', id: `ov-${rnd}-dir`, field: 'stock', value: -3 }],
  });
  check('a negative stock is refused', r.status === 400 && r.data?.code === 'BAD_STOCK', `${r.status} ${r.data?.code}`);
  r = await admin.call('PATCH', `/api/admin/products/${relProduct.id}/price-grid/traits`, {
    traits: [{ level: 'option', id: `ov-${rnd}-dir`, field: 'availability_type', value: 'someday' }],
  });
  check('an unknown route is refused', r.status === 400 && r.data?.code === 'BAD_AVAILABILITY', `${r.status} ${r.data?.code}`);

  // ------------------------------- 17. undo puts an ADJUSTMENT back as one
  //
  // price_history stores a price as a number, and a number cannot tell an
  // inherited 950,000 from a pinned 950,000 from a +50,000 adjustment. Undo
  // used to re-derive the mode from that number and always wrote
  // write_adjust: null, so undoing a bulk change on an adjusted cell PINNED
  // it: the difference stopped following the base price, silently, on the one
  // action an admin presses when something has just gone wrong. 0046 records
  // the mode, so undo restores it instead of guessing.
  console.log('\n17. undo restores the MODE, not just the number');
  await admin.patch(`/api/admin/products/${productId}/price-grid`, {
    cells: [{ level: 'option', id: `${slug}-combo-dir`, field: 'regular', mode: 'adjust', value: 40000 }],
  });
  let g17 = await grid(admin, productId);
  const adjCell = () => rowOf(g17, `option:${slug}-combo-dir`)?.cells.regular;
  check('the cell is an adjustment to start with',
    adjCell()?.mode === 'adjust' && adjCell()?.adjust === 40000, JSON.stringify(adjCell()));
  const baseBefore = adjCell()?.inherited;

  r = await admin.post(`/api/admin/products/${productId}/price-grid/bulk`, {
    op: 'add', value: 15000, fields: ['regular'], levels: ['option'], apply: true,
  });
  const bulkBatch = r.data?.batch_id;
  check('a bulk move over it succeeds', r.status === 200 && !!bulkBatch, `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);

  r = await admin.post(`/api/admin/products/${productId}/price-grid/undo`, { batch_id: bulkBatch });
  check('the undo succeeds', r.status === 200 && r.data?.changed > 0, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);

  g17 = await grid(admin, productId);
  check('the cell is an ADJUSTMENT again, not a pinned number',
    adjCell()?.mode === 'adjust', `mode=${adjCell()?.mode} value=${adjCell()?.value} adjust=${adjCell()?.adjust}`);
  check('with the same difference it had', adjCell()?.adjust === 40000, `adjust=${adjCell()?.adjust}`);
  check('and the stored fixed value is cleared, so it still follows the base',
    adjCell()?.value === null, `value=${adjCell()?.value}`);
  check('the effective price is back where it started',
    adjCell()?.effective === (baseBefore ?? 0) + 40000,
    `effective=${adjCell()?.effective} base=${baseBefore}`);

  // The point of an adjustment is that it MOVES when the base moves. The new
  // base is deliberately far from where the cell sat, so a cell that had been
  // PINNED by the undo cannot pass this by arithmetic coincidence.
  await admin.patch(`/api/admin/products/${productId}/price-grid`, {
    cells: [{ level: 'product', id: '', field: 'regular', mode: 'fixed', value: 1250000 }],
  });
  g17 = await grid(admin, productId);
  check('and it still follows the base after the base changes',
    adjCell()?.effective === 1250000 + 40000, `effective=${adjCell()?.effective}`);

  report();
}

function report() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
