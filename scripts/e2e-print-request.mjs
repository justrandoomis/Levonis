#!/usr/bin/env node
/**
 * THE PRINT REQUEST JOURNEY, end to end against a running worker.
 *
 * The owner's architecture stated as a test:
 *
 *   ONE published request → Smart Matching finds eligible merchants → ONLY
 *   notifications are sent → the notification opens THAT SAME request →
 *   several merchants offer on it → the customer picks one.
 *
 * So the load-bearing assertions here are the negative ones: that publishing
 * creates exactly one row in community_requests and not one more, that the
 * matcher writes no request anywhere, that a notification's link resolves to the
 * original id, and that an incompatible merchant is never told.
 *
 * It drives the REAL stack — HTTP, R2, D1, the geometry reader, the pricing
 * engine, the matcher, the notification inbox, the existing offer/accept path.
 *
 *   node scripts/e2e-print-request.mjs        (expects wrangler dev on :8787)
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
  constructor(name) {
    this.cookie = '';
    this.name = name;
  }
  async call(m, p, b, raw) {
    const h = this.cookie ? { Cookie: this.cookie } : {};
    if (b !== undefined && !raw) h['Content-Type'] = 'application/json';
    const send = () =>
      fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : raw ? b : JSON.stringify(b) });
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
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  put(p, b) { return this.call('PUT', p, b); }
  del(p) { return this.call('DELETE', p); }
}

// ------------------------------------------------------------- model fixtures

/** A closed box, wound so the normals point outward. */
function boxTriangles(sx, sy, sz) {
  const v = (i, j, k) => [i * sx, j * sy, k * sz];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  return [
    [p000, p110, p100].flat(), [p000, p010, p110].flat(),
    [p001, p101, p111].flat(), [p001, p111, p011].flat(),
    [p000, p100, p101].flat(), [p000, p101, p001].flat(),
    [p010, p011, p111].flat(), [p010, p111, p110].flat(),
    [p000, p001, p011].flat(), [p000, p011, p010].flat(),
    [p100, p110, p111].flat(), [p100, p111, p101].flat(),
  ];
}

function binaryStl(triangles) {
  const out = new Uint8Array(84 + triangles.length * 50);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, triangles.length, true);
  let at = 84;
  for (const t of triangles) {
    at += 12;
    for (let i = 0; i < 9; i++) { dv.setFloat32(at, t[i], true); at += 4; }
    at += 2;
  }
  return out;
}

async function uploadModel(client, requestId, bytes, name) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
  const res = await fetch(`${BASE}/api/marketplace/requests/${requestId}/files`, {
    method: 'POST',
    headers: { Cookie: client.cookie },
    body: form,
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}

/** A merchant account with a store, a printer and preferences. */
async function makeMerchant(tag, printer, prefs) {
  const c = new C(tag);
  const email = `pm-${tag}-${rnd}@test.local`;
  await c.post('/api/auth/register', { email, username: `pm${tag}${rnd}`, name: `Shop ${tag}`, password: 'print-e2e-12345' });
  await c.post('/api/auth/login', { email, password: 'print-e2e-12345' });
  // Opening a store needs an active paid membership — an existing platform rule
  // this feature does not change. Granted directly so the suite tests matching,
  // not the subscription checkout.
  sql(
    `INSERT INTO memberships (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, source, starts_at, expires_at) ` +
      `SELECT 'mem_pr_${tag}_${rnd}', id, 'plus_12mo', 'plus', 'active', 12, 0, 'admin', '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z' ` +
      `FROM users WHERE email='${email}'`
  );
  await sleep(400);
  const on = await c.post('/api/merchant/onboard', {
    name: `Shop ${tag} ${rnd}`,
    store_name: `Shop ${tag} ${rnd}`,
    slug: `shop-${tag}-${rnd}`,
    governorate: 'baghdad',
    phone: '07701112233',
    bio: 'e2e',
  });
  if (on.status !== 200 && on.status !== 201) return { client: c, ok: false, detail: `onboard ${on.status} ${JSON.stringify(on.data).slice(0, 160)}` };
  const p = await c.post('/api/merchant/printers', printer);
  if (p.status !== 201) return { client: c, ok: false, detail: `printer ${p.status} ${JSON.stringify(p.data).slice(0, 200)}` };
  if (prefs) {
    const pr = await c.put('/api/merchant/request-prefs', prefs);
    if (pr.status !== 200) return { client: c, ok: false, detail: `prefs ${pr.status}` };
  }
  const me = query(`SELECT id FROM community_merchants WHERE user_id = (SELECT id FROM users WHERE email='${email}')`);
  return { client: c, ok: true, email, merchant_id: me[0]?.id ?? '' };
}

const FDM_256 = {
  name: 'X1C', technology: 'fdm', brand: 'Bambu', model: 'X1C',
  build_x_mm: 256, build_y_mm: 256, build_z_mm: 256, nozzle_mm: 0.4,
  materials: ['pla', 'petg'], colors: ['#000000'], multicolor: false,
  enclosed: true, hardened_nozzle: false, quality_max: 'fine', availability: 'available',
};

async function main() {
  console.log(`\nPRINT REQUEST JOURNEY — ${BASE}\n`);

  // ------------------------------------------------------------ 0. accounts
  const customer = new C('customer');
  const cEmail = `pc-${rnd}@test.local`;
  await customer.post('/api/auth/register', { email: cEmail, username: `pc${rnd}`, name: 'Customer', password: 'print-e2e-12345' });
  let r = await customer.post('/api/auth/login', { email: cEmail, password: 'print-e2e-12345' });
  check('customer signed in', r.status === 200, `${r.status}`);

  console.log('\n0. four merchants, exactly as the spec describes them');
  // A — resin only.
  const A = await makeMerchant('a', { ...FDM_256, name: 'Mars', technology: 'resin', materials: ['resin-standard'] });
  check('A (resin only) is set up', A.ok, A.detail);
  // B — FDM but the bed is too small.
  const B = await makeMerchant('b', { ...FDM_256, name: 'Mini', build_x_mm: 180, build_y_mm: 180, build_z_mm: 180 });
  check('B (bed too small) is set up', B.ok, B.detail);
  // C — FDM + PETG + room.
  const Cm = await makeMerchant('c', FDM_256);
  check('C (fits) is set up', Cm.ok, Cm.detail);
  // D — identical to C, but paused.
  const D = await makeMerchant('d', FDM_256, { paused: true });
  check('D (paused) is set up', D.ok, D.detail);
  if (!A.ok || !B.ok || !Cm.ok || !D.ok) return report();

  // ------------------------------------------------- 1. the request is created
  console.log('\n1. one request, created through the marketplace that already exists');
  const before = Number(query('SELECT COUNT(*) AS n FROM community_requests')[0].n);
  // EXACTLY WHAT THE WIZARD SENDS AT THE END OF STEP 1 — a title, a
  // description, nothing from step 2. The material, the colour, the size and
  // the governorate are not known yet, and the row must survive not knowing
  // them; `publish` is what fills them in.
  const created = await customer.post('/api/marketplace/requests', {
    title: `Bracket ${rnd}`,
    description: 'A functional bracket for a shelf, printed in PETG.',
    quantity: 1,
  });
  check('the request is created', created.status === 201, `${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
  const requestId = created.data?.request?.id;
  if (!requestId) return report();

  // ---------------------------------------------- 2. the model is measured
  console.log('\n2. the file is measured on the server, not asked about');
  const stl = binaryStl(boxTriangles(220, 180, 140));
  const up = await uploadModel(customer, requestId, stl, 'bracket.stl');
  check('the STL uploads', up.status === 201, `${up.status} ${JSON.stringify(up.data).slice(0, 200)}`);
  const fileId = up.data?.file?.id;
  check('and is classified as a model', up.data?.file?.kind === 'model', up.data?.file?.kind);
  if (!fileId) return report();

  r = await customer.post(`/api/marketplace/print/requests/${requestId}/files/${fileId}/analyze`);
  check('the analysis runs', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  const a = r.data?.analysis;
  check('it measured the real dimensions', a?.dimensions_mm?.x === 220 && a?.dimensions_mm?.y === 180 && a?.dimensions_mm?.z === 140,
    JSON.stringify(a?.dimensions_mm));
  check('and the real volume', Math.abs((a?.volume_mm3 ?? 0) - 220 * 180 * 140) < 100, String(a?.volume_mm3));
  check('and knows it is a closed solid', a?.watertight === true && a?.shell_count === 1,
    `${a?.watertight}/${a?.shell_count}`);
  check('and measured the overhang instead of guessing', Math.abs((a?.overhang_area_mm2 ?? 0) - 220 * 180) < 10,
    String(a?.overhang_area_mm2));

  r = await customer.post(`/api/marketplace/print/requests/${requestId}/files/${fileId}/analyze`);
  check('a second analysis is served from the stored result', r.data?.cached === true);

  // -------------------------------------------------- 3. an invalid file
  console.log('\n3. a file that is not a model is refused at the door');
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const bad = await uploadModel(customer, requestId, junk, 'virus.stl');
  check('a renamed non-model is rejected on upload', bad.status === 400, `${bad.status}`);

  // -------------------------------------------------------- 4. the estimate
  console.log('\n4. a real estimate: a range, a confidence, and no cost leak');
  const spec = {
    process: 'fdm', material_id: 'petg', quality: 'standard', infill_percent: 20,
    supports: true, colors_count: 1, quantity: 1, color_hex: '#000000', file_id: fileId,
  };
  r = await customer.post('/api/marketplace/print/quote', spec);
  check('the quote succeeds', r.status === 200 && r.data?.quote?.priced === true, JSON.stringify(r.data).slice(0, 250));
  const q = r.data.quote;
  check('it is a RANGE, not a single number', q.price_low_iqd < q.price_iqd && q.price_iqd < q.price_high_iqd,
    `${q.price_low_iqd}/${q.price_iqd}/${q.price_high_iqd}`);
  check('with a confidence', ['high', 'medium', 'low'].includes(q.confidence), q.confidence);
  check('and real weight and time', q.material_grams > 0 && q.print_time_minutes > 0,
    `${q.material_grams}g ${q.print_time_minutes}min`);
  check('the cost breakdown is NOT sent to the customer',
    q.cost_lines === undefined && q.cost_iqd === undefined && q.floor_iqd === undefined,
    Object.keys(q).join(','));

  const cheap = await customer.post('/api/marketplace/print/quote', { ...spec, infill_percent: 5, quality: 'draft' });
  check('a lighter, faster job costs less', cheap.data.quote.price_iqd < q.price_iqd,
    `${cheap.data.quote.price_iqd} vs ${q.price_iqd}`);

  // ------------------------------- 5. a material price change moves the estimate
  console.log('\n5. the estimate follows the admin material price');
  const admin = new C('admin');
  const aEmail = `pa-${rnd}@test.local`;
  await admin.post('/api/auth/register', { email: aEmail, username: `pa${rnd}`, name: 'Admin', password: 'print-e2e-12345' });
  sql(`UPDATE users SET role='admin' WHERE email='${aEmail}'`);
  await sleep(700);
  await admin.post('/api/auth/login', { email: aEmail, password: 'print-e2e-12345' });

  const cur = await admin.get('/api/admin/settings');
  const mats = cur.data?.settings?.printMaterials;
  check('the admin can read the material catalogue', Array.isArray(mats) && mats.length > 0, typeof mats);
  if (Array.isArray(mats)) {
    const dearer = mats.map((m) => (m.id === 'petg' ? { ...m, price_iqd_per_kg: m.price_iqd_per_kg * 4 } : m));
    const put = await admin.put('/api/admin/settings/printMaterials', { value: dearer });
    check('and change a filament price', put.status === 200, `${put.status} ${JSON.stringify(put.data).slice(0, 160)}`);
    const after = await customer.post('/api/marketplace/print/quote', spec);
    check('the estimate goes up', after.data.quote.price_iqd > q.price_iqd,
      `${after.data.quote.price_iqd} vs ${q.price_iqd}`);
    await admin.put('/api/admin/settings/printMaterials', { value: mats });
    const back = await customer.post('/api/marketplace/print/quote', spec);
    check('and comes back down when the price is restored', back.data.quote.price_iqd === q.price_iqd,
      `${back.data.quote.price_iqd} vs ${q.price_iqd}`);
  }

  console.log('\n5b. the minimum margin cannot be crossed');
  const tiny = binaryStl(boxTriangles(4, 4, 4));
  const tinyUp = await uploadModel(customer, requestId, tiny, 'tiny.stl');
  if (tinyUp.status === 201) {
    await customer.post(`/api/marketplace/print/requests/${requestId}/files/${tinyUp.data.file.id}/analyze`);
    const tq = await customer.post('/api/marketplace/print/quote', { ...spec, file_id: tinyUp.data.file.id });
    const cfg = cur.data?.settings?.printPricingConfig;
    check('a 4mm part is still quoted at or above the platform minimum',
      tq.data.quote.price_iqd >= (cfg?.min_job_iqd ?? 5000),
      `${tq.data.quote.price_iqd} vs ${cfg?.min_job_iqd}`);
  } else {
    check('a 4mm part is still quoted at or above the platform minimum', false, `upload ${tinyUp.status}`);
  }

  // ------------------------------------------------ 6. publish and match
  console.log('\n6. publishing notifies the right merchants and creates NOTHING else');
  const requestsBefore = Number(query('SELECT COUNT(*) AS n FROM community_requests')[0].n);
  const rowBefore = query(`SELECT governorate, material, dimensions FROM community_requests WHERE id='${requestId}'`)[0];
  check('before publishing the row knows no governorate', (rowBefore?.governorate ?? '') === '',
    JSON.stringify(rowBefore));
  r = await customer.post(`/api/marketplace/print/requests/${requestId}/publish`,
    { ...spec, primary_file_id: fileId, governorate: 'baghdad', delivery_pref: 'delivery', budget_iqd: 40000 });
  check('the publish succeeds', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 250)}`);
  const requestsAfter = Number(query('SELECT COUNT(*) AS n FROM community_requests')[0].n);

  // The step-2 answers land on THE REQUEST, not only on the print row — the
  // matcher reads the governorate from there, and so does the public board.
  const rowAfter = query(
    `SELECT governorate, delivery_pref, budget_iqd, material, color, dimensions FROM community_requests WHERE id='${requestId}'`
  )[0];
  check('publishing writes the governorate onto the request', rowAfter?.governorate === 'baghdad', JSON.stringify(rowAfter));
  check('and the delivery preference', rowAfter?.delivery_pref === 'delivery', String(rowAfter?.delivery_pref));
  check('and the budget', Number(rowAfter?.budget_iqd) === 40000, String(rowAfter?.budget_iqd));
  check('and the material, so the board card says what it is made of',
    String(rowAfter?.material).toUpperCase().includes('PETG'), String(rowAfter?.material));
  check('and the MEASURED size, which nobody typed',
    String(rowAfter?.dimensions).startsWith('220×180×140'), String(rowAfter?.dimensions));
  const board = await customer.get('/api/marketplace/requests');
  const onBoard = (board.data?.requests ?? []).find((x) => x.id === requestId);
  check('and the public board shows them', onBoard?.governorate === 'baghdad' && onBoard?.budget_iqd === 40000,
    JSON.stringify(onBoard ?? null).slice(0, 160));

  check('EXACTLY ONE request exists — publishing created no copies',
    requestsAfter === requestsBefore, `${requestsBefore} -> ${requestsAfter}`);
  check('and only one request carries this title',
    Number(query(`SELECT COUNT(*) AS n FROM community_requests WHERE title = 'Bracket ${rnd}'`)[0].n) === 1);
  check('the request count grew by one across the whole journey',
    requestsAfter === before + 1, `${before} -> ${requestsAfter}`);

  const matches = query(`SELECT merchant_id, eligible, reject_reason, notified FROM community_request_matches WHERE request_id='${requestId}'`);
  const byMerchant = new Map(matches.map((m) => [m.merchant_id, m]));
  check('A (resin) was considered and rejected for its process',
    byMerchant.get(A.merchant_id)?.eligible === 0 && byMerchant.get(A.merchant_id)?.reject_reason === 'PROCESS',
    JSON.stringify(byMerchant.get(A.merchant_id)));
  check('B was rejected for its build volume',
    byMerchant.get(B.merchant_id)?.reject_reason === 'BUILD_VOLUME',
    JSON.stringify(byMerchant.get(B.merchant_id)));
  check('C is eligible and was notified',
    byMerchant.get(Cm.merchant_id)?.eligible === 1 && byMerchant.get(Cm.merchant_id)?.notified === 1,
    JSON.stringify(byMerchant.get(Cm.merchant_id)));
  check('D was rejected because it is paused',
    byMerchant.get(D.merchant_id)?.reject_reason === 'PAUSED',
    JSON.stringify(byMerchant.get(D.merchant_id)));

  console.log('\n6b. only the compatible merchant has a notification, and it opens THAT request');
  const cNotes = await Cm.client.get('/api/notifications');
  check('C has one notification', cNotes.data?.notifications?.length === 1, JSON.stringify(cNotes.data?.notifications ?? []).slice(0, 200));
  const note = cNotes.data?.notifications?.[0];
  check('it is a print-request match', note?.kind === 'print_request_match', note?.kind);
  check('its link opens THAT SAME request', note?.link === `/requests?request=${requestId}`, note?.link);
  check('and it points at the request entity', note?.entity_type === 'request' && note?.entity_id === requestId,
    `${note?.entity_type}/${note?.entity_id}`);
  check('C has an unread badge', cNotes.data?.unread === 1, String(cNotes.data?.unread));

  for (const [tag, m] of [['A', A], ['B', B], ['D', D]]) {
    const n = await m.client.get('/api/notifications');
    check(`${tag} was told nothing`, (n.data?.notifications ?? []).length === 0, JSON.stringify(n.data?.notifications ?? []).slice(0, 120));
  }

  console.log('\n6c. republishing does not buzz the same merchant twice');
  await customer.post(`/api/marketplace/print/requests/${requestId}/publish`,
    { ...spec, primary_file_id: fileId, governorate: 'baghdad', delivery_pref: 'delivery', budget_iqd: 40000 });
  const again = await Cm.client.get('/api/notifications');
  check('C still has exactly one notification', again.data?.notifications?.length === 1,
    String(again.data?.notifications?.length));
  check('and still exactly one request exists',
    Number(query('SELECT COUNT(*) AS n FROM community_requests')[0].n) === requestsAfter);

  // -------------------------------------------------- 7. the merchant answers
  console.log('\n7. the notification opens the request, and the merchant offers on it');
  const seen = await Cm.client.get(`/api/marketplace/requests/${requestId}`);
  check('C can open the request the notification pointed at', seen.status === 200 && seen.data?.request?.id === requestId,
    `${seen.status}`);
  const printSide = await Cm.client.get(`/api/marketplace/print/requests/${requestId}`);
  check('and read the measurements the customer never had to type',
    printSide.data?.print?.analysis?.dimensions_mm?.x === 220, JSON.stringify(printSide.data?.print?.analysis?.dimensions_mm));
  check('and the estimate range', typeof printSide.data?.print?.estimate_low_iqd === 'number');
  check('but NOT how the platform costed it',
    printSide.data?.print?.estimate?.cost_lines === undefined && printSide.data?.print?.estimate?.cost_iqd === undefined);

  const offerC = await Cm.client.post(`/api/marketplace/requests/${requestId}/offers`, {
    price_iqd: 26000, completion_days: 3, message: 'Can do in PETG black.', warranty_terms: '7 days',
  });
  check('C offers on the SAME request', offerC.status === 201 || offerC.status === 200,
    `${offerC.status} ${JSON.stringify(offerC.data).slice(0, 200)}`);
  const offerRow = query(`SELECT request_id FROM community_offers WHERE id='${offerC.data?.offer?.id ?? ''}'`);
  check('and the offer is linked to the original request id', offerRow[0]?.request_id === requestId,
    JSON.stringify(offerRow));

  // A second merchant offers too — many offers, one request.
  const E = await makeMerchant('e', FDM_256);
  if (E.ok) {
    const offerE = await E.client.post(`/api/marketplace/requests/${requestId}/offers`, {
      price_iqd: 23000, completion_days: 5, message: 'Slightly slower, cheaper.',
    });
    check('a second merchant offers on the same request', offerE.status === 201 || offerE.status === 200, `${offerE.status}`);
  }

  const offers = await customer.get(`/api/marketplace/requests/${requestId}/offers`);
  check('the customer sees every offer on their one request',
    (offers.data?.offers ?? []).length >= 2, String((offers.data?.offers ?? []).length));
  check('and they all carry the same request id',
    Number(query(`SELECT COUNT(DISTINCT request_id) AS n FROM community_offers WHERE request_id='${requestId}'`)[0].n) === 1);

  // ------------------------------------------------------ 8. privacy
  console.log('\n8. what a merchant may see before an offer is accepted');
  const asMerchant = seen.data?.request ?? {};
  for (const leak of ['customer_id', 'notes', 'visibility', 'accepted_offer_id']) {
    check(`the request payload withholds ${leak}`, asMerchant[leak] === undefined);
  }
  const mine = await Cm.client.get(`/api/marketplace/requests/${requestId}/offers`);
  check('a merchant sees only their own offer, not a rival price',
    (mine.data?.offers ?? []).length === 1, String((mine.data?.offers ?? []).length));

  // -------------------------------------------------------- 9. the viewer
  console.log('\n9. the 3D viewer link is a token, and it serves a derived mesh');
  const tok = await customer.post(`/api/marketplace/print/requests/${requestId}/files/${fileId}/viewer-token`, { hours: 24 });
  check('a viewer token is minted', tok.status === 200 && !!tok.data?.token, `${tok.status}`);
  check('and the link is the standalone route', String(tok.data?.url ?? '').startsWith('/model-viewer/'), tok.data?.url);
  const token = tok.data?.token;

  const anon = new C('anon');
  const meta = await anon.get(`/api/marketplace/print/viewer/${token}`);
  check('the token opens without a session', meta.status === 200, `${meta.status}`);
  check('and reports the dimensions', meta.data?.dimensions_mm?.x === 220, JSON.stringify(meta.data?.dimensions_mm));

  const meshRes = await fetch(`${BASE}/api/marketplace/print/viewer/${token}/mesh`);
  const meshBytes = new Uint8Array(await meshRes.arrayBuffer());
  check('the mesh is served', meshRes.status === 200 && meshBytes.length > 32, `${meshRes.status} ${meshBytes.length}`);
  check('it is the derived preview format, not the STL',
    meshBytes[0] === 0x4c && meshBytes[1] === 0x56 && meshBytes[2] === 0x4d && meshBytes[3] === 0x31,
    [...meshBytes.slice(0, 4)].join(','));
  check('and it is NOT byte-identical to the uploaded file', meshBytes.length !== stl.length);

  const badToken = await anon.get('/api/marketplace/print/viewer/not-a-real-token-value-here');
  check('a wrong token is refused', badToken.status === 404, `${badToken.status}`);
  sql(`UPDATE model_view_tokens SET expires_at='2020-01-01T00:00:00Z'`);
  const expired = await anon.get(`/api/marketplace/print/viewer/${token}`);
  check('an expired token stops working', expired.status === 404, `${expired.status}`);
  check('the original file is still NOT public',
    (await (await fetch(`${BASE}/files/requests/`)).status) !== 200);

  // ------------------------------------------------------ 10. an external link
  console.log('\n10. a MakerWorld link is understood without scraping anything');
  const link = await customer.post('/api/marketplace/print/link', {
    url: 'https://makerworld.com/en/models/123456-cool-bracket?from=search&utm_source=x',
  });
  check('the link is parsed', link.status === 200, `${link.status} ${JSON.stringify(link.data).slice(0, 200)}`);
  check('the provider is recognised', link.data?.link?.provider === 'makerworld', link.data?.link?.provider);
  check('and the model id extracted', link.data?.link?.external_id === '123456', link.data?.link?.external_id);
  check('tracking parameters are dropped',
    !String(link.data?.link?.canonical_url ?? '').includes('utm_source'), link.data?.link?.canonical_url);
  check('with no provider API configured it says so rather than inventing data',
    link.data?.info?.resolved === false && link.data?.info?.reason === 'NO_API_CONFIGURED',
    JSON.stringify(link.data?.info));
  const junkLink = await customer.post('/api/marketplace/print/link', { url: 'http://localhost/admin' });
  check('a private address is refused', junkLink.status === 400, `${junkLink.status}`);

  // ------------------------------------------------- 11. my requests + repeat
  console.log('\n11. my requests, and ordering the same thing again');
  const mineList = await customer.get('/api/marketplace/my-requests');
  check('the request appears in my requests',
    (mineList.data?.requests ?? []).some((x) => x.id === requestId), String((mineList.data?.requests ?? []).length));

  // The owner's OWN list is a separate, richer route — it carries the estimate,
  // the material and the chosen merchant, none of which the public board's
  // privacy whitelist may ever expose.
  const richMine = await customer.get('/api/marketplace/print/my-requests');
  const richRow = (richMine.data?.requests ?? []).find((x) => x.id === requestId);
  check('the owner-scoped list returns the request', !!richRow, `${richMine.status}`);
  check('and it carries the print side', !!richRow?.print, JSON.stringify(richRow?.print ?? null).slice(0, 80));
  check('with the estimate the publish snapshotted',
    typeof richRow?.print?.estimate_low_iqd === 'number' && richRow.print.estimate_low_iqd > 0,
    String(richRow?.print?.estimate_low_iqd));
  check('and the material, so the card can say what it is made of',
    richRow?.print?.material_id === 'petg', String(richRow?.print?.material_id));
  check('no merchant is named before one is chosen', richRow?.accepted === null, JSON.stringify(richRow?.accepted));
  // Owner-scoped means owner-scoped: the SQL, not a filter afterwards.
  const strangerMine = new C('mine-stranger');
  const smEmail = `pm-${rnd}@test.local`;
  await strangerMine.post('/api/auth/register', { email: smEmail, username: `pm${rnd}`, name: 'Nosy', password: 'print-e2e-12345' });
  await strangerMine.post('/api/auth/login', { email: smEmail, password: 'print-e2e-12345' });
  const nosy = await strangerMine.get('/api/marketplace/print/my-requests');
  check('somebody else\'s list does not contain it',
    !(nosy.data?.requests ?? []).some((x) => x.id === requestId), String((nosy.data?.requests ?? []).length));

  const beforeRepeat = Number(query('SELECT COUNT(*) AS n FROM community_requests')[0].n);
  const repeat = await customer.post(`/api/marketplace/print/requests/${requestId}/repeat`);
  check('the repeat creates a new request', repeat.status === 201 && !!repeat.data?.request_id, `${repeat.status}`);
  const repeatId = repeat.data?.request_id;
  check('with a NEW id', repeatId && repeatId !== requestId, `${repeatId}`);
  check('and exactly one more request exists',
    Number(query('SELECT COUNT(*) AS n FROM community_requests')[0].n) === beforeRepeat + 1);
  const copiedFiles = query(`SELECT id, file_key, analysis FROM community_request_files WHERE request_id='${repeatId}'`);
  check('the attachments were copied, not shared',
    copiedFiles.length > 0 && copiedFiles.every((f) => !f.file_key.includes(requestId)),
    String(copiedFiles.length));
  check('and the measurement came with them', copiedFiles.some((f) => (f.analysis ?? '').includes('dimensions_mm')));
  const repeatSpec = query(`SELECT estimate_low_iqd, material_id FROM community_print_requests WHERE request_id='${repeatId}'`);
  check('the print spec was copied', repeatSpec[0]?.material_id === 'petg', JSON.stringify(repeatSpec[0]));
  check('but January\'s price was NOT — it is re-estimated on publish',
    repeatSpec[0]?.estimate_low_iqd === null, String(repeatSpec[0]?.estimate_low_iqd));

  // ------------------------------------------------------ 12. the refusals
  console.log('\n12. the refusals');
  const stranger = new C('stranger');
  const sEmail = `ps-${rnd}@test.local`;
  await stranger.post('/api/auth/register', { email: sEmail, username: `ps${rnd}`, name: 'Stranger', password: 'print-e2e-12345' });
  await stranger.post('/api/auth/login', { email: sEmail, password: 'print-e2e-12345' });
  r = await stranger.post(`/api/marketplace/print/requests/${requestId}/publish`, spec);
  check('a stranger cannot publish someone else\'s request', r.status === 404, `${r.status}`);
  r = await stranger.post(`/api/marketplace/print/requests/${requestId}/files/${fileId}/analyze`);
  check('nor analyse their file', r.status === 404, `${r.status}`);
  r = await stranger.post(`/api/marketplace/print/requests/${requestId}/repeat`);
  check('nor repeat their request', r.status === 404, `${r.status}`);
  r = await Cm.client.post('/api/merchant/printers', { ...FDM_256, build_x_mm: 0, build_y_mm: 0, build_z_mm: 0 });
  check('a printer with no build volume is refused', r.status === 400 && r.data?.code === 'BUILD_VOLUME_REQUIRED', `${r.status}`);

  // ------------------------------------------- 13. the merchant can see why
  console.log('\n13. a merchant can find out why they were or were not told');
  const why = await B.client.get('/api/merchant/request-matches');
  const mine2 = (why.data?.matches ?? []).find((m) => m.request_id === requestId);
  check('B can see the decision about them', !!mine2, JSON.stringify(why.data).slice(0, 200));
  check('and it names the reason', mine2?.reject_reason === 'BUILD_VOLUME', mine2?.reject_reason);
  check('and B cannot see anyone else\'s score',
    (why.data?.matches ?? []).every((m) => m.score === undefined));

  // ------------------------------------------------- 14. notifications API
  console.log('\n14. the notification inbox');
  let inbox = await Cm.client.get('/api/notifications');
  check('unread is 1 before reading', inbox.data?.unread === 1, String(inbox.data?.unread));
  const mark = await Cm.client.post('/api/notifications/read', { id: note.id });
  check('marking it read works', mark.status === 200 && mark.data?.unread === 0, JSON.stringify(mark.data));
  inbox = await Cm.client.get('/api/notifications');
  check('and it stays read', inbox.data?.notifications?.[0]?.read === true);
  const cross = await B.client.post('/api/notifications/read', { id: note.id });
  check('another user cannot mark it read', cross.data?.marked === 0, JSON.stringify(cross.data));

  report();
}

function report() {
  console.log(`\n${'='.repeat(64)}`);
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
