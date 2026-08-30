#!/usr/bin/env node
/**
 * §12 acceptance: "اختبارات صلاحيات تثبت أن مساعد الأدمن لا يرى Cost أو
 * البيانات المالية حتى باستدعاء API مباشرة".
 *
 * WHY A SEPARATE SUITE. Every other §12 row had a home already — pricing and
 * the PRIME boundary in tests/pricing.test.ts and tests/shipping.test.ts, the
 * inventory rules in tests/inventory.test.ts and tests/orderInventory.test.ts,
 * the import round-trip in scripts/e2e-import.mjs. This row had none, and it
 * is the one row a UI test cannot answer: hiding a field in React proves
 * nothing about what the server put on the wire. So this speaks HTTP only,
 * signed in as a real assistant admin, and greps the RAW RESPONSE BYTES —
 * not the parsed object — for every financial field and for the literal cost
 * value. A number that reaches the browser at all has already leaked, whatever
 * the panel chooses to render.
 *
 * The suite is deliberately two-sided:
 *
 *   * A FULL admin must SEE the cost. Without this control the whole file
 *     would pass just as happily against a build where cost was never stored,
 *     or where the product failed to save at all.
 *   * The assistant must not see it, and must not be able to WRITE it either
 *     — §11 is an authorization rule in both directions, and a blind write is
 *     how a stale panel silently wipes a real number.
 *
 *   node scripts/e2e-permissions.mjs        (expects wrangler dev on :8787)
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const EVIDENCE = process.argv.includes('--evidence')
  ? resolve(ROOT, process.argv[process.argv.indexOf('--evidence') + 1])
  : null;
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });

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

// `wrangler d1 execute --local` opens the same SQLite file the dev server has
// mapped, which makes miniflare re-bind and drop every open socket. So after a
// promotion we wait for the server to answer again rather than racing it — a
// transport error here would otherwise read as a failed permission check.
const settle = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* still re-binding */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the dev server did not come back after a direct SQL statement');
};

const sql = (statement) => {
  const tpl = process.env.PROMOTE_CMD || 'npx wrangler d1 execute levonis-db --local --command {SQL}';
  execSync(tpl.replace('{SQL}', JSON.stringify(statement)), { cwd: ROOT, stdio: 'pipe' });
};

class Client {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }
  async raw(method, p, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    const res = await fetch(BASE + p, { method, headers: h, body });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return res;
  }
  /** The parsed body AND the exact bytes that crossed the wire. */
  async text(method, p, body) {
    const res = await this.raw(method, p, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
    const raw = await res.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* CSV, ZIP or an empty body */
    }
    return { status: res.status, raw, data };
  }
  get(p) {
    return this.text('GET', p);
  }
  post(p, b) {
    return this.text('POST', p, b);
  }
  put(p, b) {
    return this.text('PUT', p, b);
  }
}

// The names the server must never serialize for an assistant. Mirrors
// FINANCIAL_FIELDS in worker/lib/adminScope.ts; kept as a literal on purpose,
// so that adding a field there without widening the rule fails HERE rather
// than passing because the test imported the same (now wrong) list.
const FINANCIAL_FIELDS = ['cost_iqd', 'product_cost_iqd', 'margin_iqd', 'margin_percent', 'supplier_price_iqd'];

const PRODUCT_COST = 613377; // distinctive: no other number in the payload looks like it
const OPTION_COST = 41221;
const COLOR_COST = 27113;

/** Every way the leak could show up in one place. */
function leaks(raw) {
  const found = [];
  for (const f of FINANCIAL_FIELDS) if (raw.includes(`"${f}"`) || raw.includes(`,${f},`) || raw.includes(`${f},`)) found.push(f);
  for (const n of [PRODUCT_COST, OPTION_COST, COLOR_COST]) if (raw.includes(String(n))) found.push(`value:${n}`);
  return found;
}

const rnd = Math.random().toString(36).slice(2, 8);

async function main() {
  console.log(`\nLEVONIS admin scope — cost is owner-only — ${BASE}\n`);

  // ------------------------------------------------------------- fixtures
  console.log('0. two real admins, one restricted');
  const owner = new Client('full');
  const asst = new Client('assistant');
  const ownerEmail = `perm-full-${rnd}@test.local`;
  const asstEmail = `perm-asst-${rnd}@test.local`;
  const password = 'permissions-pass-1';

  for (const [client, email, user] of [
    [owner, ownerEmail, `permf${rnd}`],
    [asst, asstEmail, `perma${rnd}`],
  ]) {
    const r = await client.post('/api/auth/register', { email, username: user, name: 'Perm Tester', password });
    check(`${client.label} account created`, r.status === 200, JSON.stringify(r.data).slice(0, 120));
  }
  sql(`UPDATE users SET role='admin', admin_scope='full' WHERE email='${ownerEmail}'`);
  sql(`UPDATE users SET role='admin', admin_scope='assistant' WHERE email='${asstEmail}'`);
  await settle();
  for (const [client, email] of [
    [owner, ownerEmail],
    [asst, asstEmail],
  ]) {
    const r = await client.post('/api/auth/login', { email, password });
    check(`${client.label} signed in`, r.status === 200);
  }

  // Both really are admins — otherwise every 403 below would be the plain
  // "not an admin" refusal and would prove nothing about scope.
  const asstMe = await asst.get('/api/auth/me');
  check('the assistant IS an admin', asstMe.data?.user?.isAdmin === true, JSON.stringify(asstMe.data?.user ?? null).slice(0, 160));
  check(
    'the assistant is flagged as unable to view financials',
    asstMe.data?.user?.can_view_financials === false,
    JSON.stringify(asstMe.data?.user?.can_view_financials)
  );
  const ownerMe = await owner.get('/api/auth/me');
  check('the full admin IS flagged as financial', ownerMe.data?.user?.can_view_financials === true);

  // ------------------------------------------------- a product WITH a cost
  console.log('\n1. a product that really carries a cost');
  const cats = (await owner.get('/api/admin/taxonomy/catalogs')).data?.catalogs ?? [];
  const section =
    cats.find((c) => c.id === 'cat_printers_fdm') ??
    cats.find((c) => c.effective_template_family === 'devices' && c.parent_id) ??
    cats.find((c) => c.effective_template_family === 'devices');
  check('a Devices section exists to file the product under', !!section, `catalogs=${cats.length}`);
  if (!section) throw new Error('the seeded taxonomy is missing');

  const created = await owner.post('/api/admin/products-v2', {
    name_en: `Perm Fixture ${rnd}`,
    description_en: 'A product whose cost only the owner may see.',
    price_iqd: 900000,
    prime_price_iqd: 880000,
    pro_price_iqd: 850000,
    product_cost_iqd: PRODUCT_COST,
    status: 'active',
    sale_types: ['direct_sale'],
    category_id: section.id,
    stock: 4,
    options: [
      {
        id: `og_${rnd}`,
        name_en: 'Bundle',
        sort: 0,
        active: true,
        cost_iqd: OPTION_COST,
        price_delta_iqd: 15000,
      },
    ],
    colors: [{ id: `c_${rnd}`, name_en: 'Graphite', hex: '#333333', sort: 0, active: true, cost_iqd: COLOR_COST }],
  });
  check('the product saved', created.status === 200, JSON.stringify(created.data).slice(0, 220));
  const productId = created.data?.product?.id;
  check('the product has an id', !!productId);
  if (!productId) throw new Error('nothing to test against');

  // CONTROL. If this fails, every "no cost for the assistant" check below is
  // vacuous — the cost was never there to leak.
  const ownerDoc = await owner.get(`/api/admin/products-v2/${productId}`);
  check(
    'CONTROL — the full admin does see product_cost_iqd, and it is the value written',
    ownerDoc.data?.product?.product_cost_iqd === PRODUCT_COST,
    `got=${JSON.stringify(ownerDoc.data?.product?.product_cost_iqd)}`
  );
  check(
    'CONTROL — the full admin sees the option and colour cost too',
    ownerDoc.raw.includes(String(OPTION_COST)) && ownerDoc.raw.includes(String(COLOR_COST)),
    `option=${ownerDoc.raw.includes(String(OPTION_COST))} colour=${ownerDoc.raw.includes(String(COLOR_COST))}`
  );

  // --------------------------------------------- 2. every READ, raw bytes
  console.log('\n2. the assistant calls each endpoint DIRECTLY');
  const reads = [
    ['the product document', () => asst.get(`/api/admin/products-v2/${productId}`)],
    ['the product list', () => asst.get('/api/admin/products-v2?limit=100')],
    ['the search that would find it', () => asst.get(`/api/admin/products-v2?search=${encodeURIComponent(`Perm Fixture ${rnd}`)}`)],
    ['the relations view', () => asst.get(`/api/admin/products/${productId}/relations`)],
    ['the stock view', () => asst.get(`/api/admin/products/${productId}/stock`)],
    ['the admin dashboard overview', () => asst.get('/api/admin/overview')],
    ['the order list', () => asst.get('/api/admin/orders?limit=20')],
  ];
  for (const [label, run] of reads) {
    const r = await run();
    check(`${label} answers (not a blanket 403 that would hide the real question)`, r.status === 200, `status=${r.status}`);
    if (r.status !== 200) continue;
    const bad = leaks(r.raw);
    check(`${label} carries no financial field or value`, bad.length === 0, bad.join(', '));
  }

  // The quote endpoint resolves a price; it must resolve it without margin.
  const quote = await asst.post(`/api/admin/products-v2/${productId}/quote`, { quantity: 1 });
  check('the price quote answers for an assistant', quote.status === 200, `status=${quote.status}`);
  if (quote.status === 200) {
    const bad = leaks(quote.raw);
    check('the price quote carries no financial field or value', bad.length === 0, bad.join(', '));
  }

  // ------------------------------------------------ 3. downloads and files
  console.log('\n3. the files the assistant can download');
  const files = [
    ['the CSV export', `/api/admin/import/export?category=${encodeURIComponent(section.id)}&format=csv`],
    ['the CSV template', `/api/admin/import/template?category=${encodeURIComponent(section.id)}&format=csv`],
  ];
  for (const [label, path] of files) {
    const res = await asst.raw('GET', path);
    const text = await res.text();
    check(`${label} downloads for an assistant`, res.status === 200, `status=${res.status}`);
    if (res.status !== 200) continue;
    const header = text.split('\n')[0];
    check(
      `${label} has no cost COLUMN at all`,
      !FINANCIAL_FIELDS.some((f) => header.split(',').some((h) => h.replace(/^\uFEFF/, '').trim() === f)),
      header.slice(0, 200)
    );
    const bad = leaks(text);
    check(`${label} carries no financial field or value`, bad.length === 0, bad.join(', '));
    if (EVIDENCE) writeFileSync(resolve(EVIDENCE, `assistant-${label.replace(/\W+/g, '-')}.csv`), text);
  }

  // The ZIP is the one that would leak through a file the CSV check misses.
  const zipRes = await asst.raw('GET', `/api/admin/import/export?category=${encodeURIComponent(section.id)}&format=zip`);
  check('the ZIP export downloads for an assistant', zipRes.status === 200, `status=${zipRes.status}`);
  if (zipRes.status === 200) {
    const entries = unzipSync(new Uint8Array(await zipRes.arrayBuffer()));
    const names = Object.keys(entries);
    const allBad = [];
    for (const n of names) allBad.push(...leaks(strFromU8(entries[n])).map((x) => `${n}:${x}`));
    check(`no entry in the ZIP leaks a cost (${names.length} entries)`, allBad.length === 0, allBad.join(', '));
  }

  // The owner's own export MUST carry it, or the checks above are vacuous.
  const ownerCsv = await owner.raw('GET', `/api/admin/import/export?category=${encodeURIComponent(section.id)}&format=csv`);
  const ownerCsvText = await ownerCsv.text();
  check(
    'CONTROL — the full admin export DOES carry the cost column and value',
    ownerCsvText.includes('cost_iqd') && ownerCsvText.includes(String(PRODUCT_COST)),
    `column=${ownerCsvText.includes('cost_iqd')} value=${ownerCsvText.includes(String(PRODUCT_COST))}`
  );

  // ----------------------------------------------------- 4. WRITES, too
  console.log('\n4. the assistant cannot write a cost either');
  const doc = ownerDoc.data.product;

  // 4a. An outright attempt to change it is refused, loudly.
  const attempt = await asst.post('/api/admin/products-v2', {
    ...doc,
    id: productId,
    product_cost_iqd: 1,
    expected_updated_at: undefined,
  });
  check(
    'changing product_cost_iqd is REFUSED, not silently dropped',
    attempt.status === 403,
    `status=${attempt.status} ${JSON.stringify(attempt.data).slice(0, 160)}`
  );
  check(
    'the refusal names the field it refused',
    /product_cost_iqd/.test(JSON.stringify(attempt.data ?? '')),
    JSON.stringify(attempt.data).slice(0, 200)
  );

  // 4b. The realistic case: an assistant's panel never received the cost, so
  // it saves the document back WITHOUT it. That must not blank the stored
  // value — this is the silent data loss the two-sided rule exists to stop.
  const asstDoc = (await asst.get(`/api/admin/products-v2/${productId}`)).data.product;
  const blindSave = await asst.post('/api/admin/products-v2', {
    ...asstDoc,
    id: productId,
    name_en: `Perm Fixture ${rnd} (edited by assistant)`,
  });
  check('an assistant CAN still edit the non-financial part', blindSave.status === 200, JSON.stringify(blindSave.data).slice(0, 200));
  const afterBlind = await owner.get(`/api/admin/products-v2/${productId}`);
  check(
    "the assistant's blind save did NOT blank the stored cost",
    afterBlind.data?.product?.product_cost_iqd === PRODUCT_COST,
    `got=${JSON.stringify(afterBlind.data?.product?.product_cost_iqd)}`
  );
  check(
    'the edit the assistant WAS allowed to make did land',
    afterBlind.data?.product?.name_en?.includes('edited by assistant'),
    JSON.stringify(afterBlind.data?.product?.name_en)
  );
  check(
    "the assistant's blind save did not blank the option/colour cost either",
    afterBlind.raw.includes(String(OPTION_COST)) && afterBlind.raw.includes(String(COLOR_COST)),
    `option=${afterBlind.raw.includes(String(OPTION_COST))} colour=${afterBlind.raw.includes(String(COLOR_COST))}`
  );

  // 4c. An import is a write path too — the same rule must hold there.
  const importCsv = [
    'row_type,key,name,cost_iqd',
    `product,PERM-${rnd},Perm Import ${rnd},999999`,
  ].join('\n');
  const form = new FormData();
  form.set('file', new File([importCsv], 'costs.csv'));
  form.set('category', section.id);
  const prev = await asst.raw('POST', '/api/admin/import/preview', { body: form });
  const prevText = await prev.text();
  check(
    'an assistant importing a cost column does not get it applied',
    prev.status !== 200 || !prevText.includes('999999'),
    `status=${prev.status} ${prevText.slice(0, 200)}`
  );

  // ------------------------------------------- 5. cannot grant itself access
  console.log('\n5. the assistant cannot promote itself');
  const meId = asstMe.data?.user?.id;
  const selfPromote = await asst.raw('PATCH', `/api/admin/users/${meId}`, {
    body: JSON.stringify({ admin_scope: 'full' }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('self-promotion to a financial admin is refused', selfPromote.status === 403, `status=${selfPromote.status}`);
  const stillBlind = await asst.get(`/api/admin/products-v2/${productId}`);
  check(
    'and the cost is still not visible afterwards',
    leaks(stillBlind.raw).length === 0,
    leaks(stillBlind.raw).join(', ')
  );

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
