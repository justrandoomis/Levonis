/**
 * READERS AND OFFERS V3, THIRD REVIEW (P1-05, docs/DECISIONS.md row 267) —
 * through the real routes and migrations.
 *
 * Pinned:
 *   R10      the request page, /quote and «طلباتي» count the model files the
 *            estimate did not price by one rule: a one-job estimate priced the
 *            mirror's primary file, a job of parts only its parts' measured
 *            files.
 *   board    a job in several materials is found by each of its materials and
 *            a job in several technologies by each of them; the card carries
 *            the parts' materials and technologies (never «any technology»
 *            for a job that named two).
 *   swap     a substitution is judged against the workshop's printers whether
 *            or not the part could be made as asked — on a job of parts and on
 *            a one-job request (v3 and v1) — at the offer, in the offers list
 *            and at acceptance.
 *   rollback the script that withdraws open partial or substituted offers
 *            recounts each request's advertised offer count.
 *
 * Fourth review (round 2):
 *   fence    every money write that read the request model for the part
 *            check is fenced on that revision hash — a price-only edit of a
 *            pending whole offer, a new whole offer and a sent whole draft —
 *            so a part the customer adds before the write answers
 *            REQUEST_CHANGED; an edit whose request moved between its reads
 *            too.
 *   seen     the request page names its revision hash and a new offer or a
 *            sent draft that carries an older one is refused: a whole offer
 *            never covers a part added while the composer was open.
 *   colours  a substitute is judged with its own colour count (MULTICOLOR).
 *   words    a part refused only for its substitute says so
 *            (`details.substitute`); preferences never refuse a substitute.
 *   R10      a request with no print row counts no unpriced model file.
 *   notice   «1 set», not «1 sets».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, patch, post, row, stubApp, type Mount } from './fixtures/app';
import { addFile, fund, newDraft, publish, readDraft, world } from './fixtures/requestModelWorld';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { merchantWorkshopRoutes } from '../worker/routes/merchantWorkshop';
import { analyseModel } from '../worker/lib/modelGeometry';

const ROLLBACK = readFileSync(new URL('../scripts/before-rollback-offers-v3.sql', import.meta.url), 'utf8');

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/merchant/workshop', merchantWorkshopRoutes);
};
const as = (raw: DatabaseSync, id: string) => stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount);

/** A closed cube of `mm` millimetres, as binary STL. */
function cube(mm: number): Uint8Array {
  const v = (i: number, j: number, k: number) => [i * mm, j * mm, k * mm];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  const tris = [
    [p000, p110, p100], [p000, p010, p110], [p001, p101, p111], [p001, p111, p011],
    [p000, p100, p101], [p000, p101, p001], [p010, p011, p111], [p010, p111, p110],
    [p000, p001, p011], [p000, p011, p010], [p100, p110, p111], [p100, p111, p101],
  ].map((t) => t.flat());
  const out = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, tris.length, true);
  let at = 84;
  for (const t of tris) {
    at += 12;
    for (let i = 0; i < 9; i++) { dv.setFloat32(at, t[i], true); at += 4; }
    at += 2;
  }
  return out;
}
const MEASURED = analyseModel(cube(30), 'c.stl') as unknown as Record<string, unknown>;

async function countsFor(raw: DatabaseSync, id: string) {
  const page = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}`));
  const list = await json(await get(as(raw, 'buyer'), '/api/marketplace/print/my-requests'));
  const mine = list.requests.find((r: Record<string, unknown>) => r.id === id);
  return { page: page.print.models_unpriced as number, list: mine.summary.models_unpriced as number };
}

// ------------------------------------------------------------------ R10

test('R10: one part priced the v1 way from the model file named as the main source — that file is priced on the page, the list and /quote', async () => {
  const raw = world();
  const id = await newDraft(raw);
  addFile(raw, id, 'crf_m', 'model', 'body.stl', { analysis: MEASURED });
  const body = {
    schema_version: 3, source_type: 'model',
    sources: [{ kind: 'file', file_id: 'crf_m', is_primary: true }],
    parts: [{ name: 'A', process: 'fdm', measured_file_id: null, materials: [{ material_id: 'pla' }] }],
  };
  const res = await publish(raw, id, body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const p = row<{ primary_file_id: string; estimate: string }>(raw, 'SELECT primary_file_id, estimate FROM community_print_requests WHERE request_id = ?', id)!;
  assert.equal(p.primary_file_id, 'crf_m', 'the mirror prices the main source');
  assert.equal(JSON.parse(p.estimate).priced, true);
  assert.equal(JSON.parse(p.estimate).coverage, undefined, 'a one-job estimate');
  assert.deepEqual(await countsFor(raw, id), { page: 0, list: 0 });
  const q = await json(await post(as(raw, 'buyer'), '/api/marketplace/print/quote', { request_id: id, ...body }));
  assert.equal(q.success, true, JSON.stringify(q));
  assert.equal(q.models_unpriced, 0);
});

test('R10: a job of parts with no part measured counts the main model file on the page and in the list alike', async () => {
  const raw = world();
  const id = await newDraft(raw);
  addFile(raw, id, 'crf_m', 'model', 'body.stl', { analysis: MEASURED });
  const res = await publish(raw, id, {
    schema_version: 3, source_type: 'model',
    sources: [{ kind: 'file', file_id: 'crf_m', is_primary: true }],
    parts: [
      { name: 'A', process: 'fdm', measured_file_id: null, stated_dimensions_mm: { x: 30, y: 30, z: 30 }, materials: [{ material_id: 'pla' }] },
      { name: 'B', process: 'fdm', measured_file_id: null, stated_dimensions_mm: { x: 20, y: 20, z: 20 }, materials: [{ material_id: 'tpu' }] },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const est = JSON.parse(row<{ estimate: string }>(raw, 'SELECT estimate FROM community_print_requests WHERE request_id = ?', id)!.estimate);
  assert.equal(typeof est.coverage, 'object', 'priced part by part');
  assert.deepEqual(await countsFor(raw, id), { page: 1, list: 1 });
});

test('R10: a job of parts whose first part is measured counts only the file beside it, on both', async () => {
  const raw = world();
  const id = await newDraft(raw);
  addFile(raw, id, 'crf_a', 'model', 'a.stl', { analysis: MEASURED });
  addFile(raw, id, 'crf_x', 'model', 'x.stl', { analysis: MEASURED });
  const res = await publish(raw, id, {
    schema_version: 3,
    parts: [
      { name: 'A', process: 'fdm', measured_file_id: 'crf_a', materials: [{ material_id: 'pla' }] },
      { name: 'B', process: 'fdm', stated_dimensions_mm: { x: 20, y: 20, z: 20 }, materials: [{ material_id: 'tpu' }] },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await countsFor(raw, id), { page: 1, list: 1 });
});

// ---------------------------------------------------------------- board

test('board: a PLA and TPU job is found by either material, and the card names both', async () => {
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET materials = '["tpu"]' WHERE id = 'p1'`);
  const id = await newDraft(raw);
  const res = await publish(raw, id, {
    schema_version: 3,
    parts: [
      { name: 'Body', process: 'fdm', stated_dimensions_mm: { x: 40, y: 30, z: 10 }, materials: [{ material_id: 'pla' }] },
      { name: 'Grip', process: 'fdm', stated_dimensions_mm: { x: 40, y: 30, z: 10 }, materials: [{ material_id: 'tpu' }] },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const board = async (q = '') => (await json(await get(as(raw, 'owner'), `/api/merchant/workshop/board${q}`))).requests as Array<Record<string, unknown>>;
  const all = await board();
  const card = all.find((r) => r.id === id)!;
  assert.ok(card, 'eligible for the TPU part');
  assert.deepEqual((card.summary as Record<string, unknown>).materials, ['pla', 'tpu']);
  assert.deepEqual((card.summary as Record<string, unknown>).processes, ['fdm']);
  assert.deepEqual((await board('?material=tpu')).map((r) => r.id), [id]);
  assert.deepEqual((await board('?material=pla')).map((r) => r.id), [id]);
  assert.deepEqual((await board('?material=petg')).map((r) => r.id), []);
  assert.deepEqual((await board('?process=fdm')).map((r) => r.id), [id]);
  assert.deepEqual((await board('?process=resin')).map((r) => r.id), []);
});

test('board: an FDM and resin job shows both technologies to the resin shop, and only matching filters find it', async () => {
  const raw = world();
  const id = await newDraft(raw);
  const res = await publish(raw, id, {
    schema_version: 3,
    parts: [
      { name: 'Body', process: 'fdm', stated_dimensions_mm: { x: 40, y: 30, z: 10 }, materials: [{ material_id: 'pla' }] },
      { name: 'Detail', process: 'resin', stated_dimensions_mm: { x: 20, y: 20, z: 10 }, materials: [{ material_id: 'resin-standard' }] },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const board = async (q = '') => (await json(await get(as(raw, 'owner2'), `/api/merchant/workshop/board${q}`))).requests as Array<Record<string, unknown>>;
  const card = (await board()).find((r) => r.id === id)!;
  assert.ok(card);
  assert.equal(card.process, null, 'the mirror is unsure');
  assert.deepEqual((card.summary as Record<string, unknown>).processes, ['fdm', 'resin']);
  assert.deepEqual((card.summary as Record<string, unknown>).materials, ['pla', 'resin-standard']);
  assert.deepEqual((await board('?process=resin')).map((r) => r.id), [id]);
  assert.deepEqual((await board('?material=resin-standard')).map((r) => r.id), [id]);
  assert.deepEqual((await board('?material=resin-tough')).map((r) => r.id), []);
});

test('board: a v1 job is filtered by its own row as before', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id)).status, 200);
  const board = async (q = '') => (await json(await get(as(raw, 'owner'), `/api/merchant/workshop/board${q}`))).requests as Array<Record<string, unknown>>;
  assert.deepEqual((await board('?material=pla')).map((r) => r.id), [id]);
  assert.deepEqual((await board('?material=tpu')).map((r) => r.id), []);
  assert.deepEqual(((await board()).find((r) => r.id === id)!.summary as Record<string, unknown>).materials, ['pla']);
});

// ---------------------------------------------------- the substitute judged

const TWO = {
  schema_version: 3,
  parts: [
    { name: 'Body', process: 'fdm', stated_dimensions_mm: { x: 80, y: 60, z: 20 }, materials: [{ material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#1a1a1a', label: 'Black' }] }] },
    { name: 'Grip', process: 'fdm', stated_dimensions_mm: { x: 60, y: 20, z: 20 }, materials: [{ material_id: 'tpu', colors: [{ mode: 'catalogue', hex: '#d32f2f', label: 'Red' }] }] },
  ],
};
const ONE = { schema_version: 3, parts: [{ name: 'Body', process: 'fdm', materials: [{ material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#1a1a1a', label: 'Black' }] }] }] };

async function offerSwap(raw: DatabaseSync, id: string, to: string, partIndex = 0) {
  const d = await readDraft(raw, id);
  const part = d.model.parts[partIndex];
  const res = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
    price_iqd: 30_000, delivery_method: 'pickup',
    substitutions: [{ part_id: part.id, material_row_id: part.materials[0].id, to: { material_id: to } }],
  });
  return { status: res.status, body: await json(res), part };
}

for (const [label, body] of [['a job of parts', TWO], ['a one-part v3 job', ONE], ['a v1 job', null]] as const) {
  test(`swap: on ${label}, a substitute none of the printers runs is refused even though the part can be made as asked`, async () => {
    const raw = world();
    raw.exec(`UPDATE merchant_printers SET materials = '["pla","tpu"]' WHERE id = 'p1'`);
    const id = await newDraft(raw);
    const pub = body ? await publish(raw, id, body) : await publish(raw, id);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const bad = await offerSwap(raw, id, 'petg');
    assert.equal(bad.status, 403, JSON.stringify(bad.body));
    assert.equal(bad.body.code, 'OFFER_PART_NOT_ELIGIBLE');
    assert.equal(bad.body.details.part_id, bad.part.id);
    assert.ok(bad.body.details.reasons.includes('MATERIAL'), JSON.stringify(bad.body.details));
    assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_offers')!.n, 0, 'nothing written');
    // A substitute it does run is offered.
    const ok = await offerSwap(raw, id, 'tpu');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });
}

for (const [label, body] of [['a job of parts', TWO], ['a one-part v3 job', ONE]] as const) {
  test(`swap: on ${label}, a substituted offer whose printer stops running the substitute is unable in the list and refused at acceptance`, async () => {
    const raw = world();
    fund(raw, 'buyer', 1_000_000);
    const id = await newDraft(raw);
    assert.equal((await publish(raw, id, body)).status, 200);
    const o = await offerSwap(raw, id, 'petg');
    assert.equal(o.status, 201, JSON.stringify(o.body));
    const listed = async () => {
      const lb = await json(await get(as(raw, 'buyer'), `/api/marketplace/requests/${id}/offers`));
      return (lb.offers ?? []).find((x: Record<string, unknown>) => x.id === o.body.offer.id);
    };
    assert.equal((await listed()).workshop_unable, false);
    // The printer still makes every part as asked, but no longer runs PETG.
    raw.exec(`UPDATE merchant_printers SET materials = '["pla","tpu"]' WHERE id = 'p1'`);
    assert.equal((await listed()).workshop_unable, true);
    const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${o.body.offer.id}/accept`, {
      expected_total_iqd: o.body.offer.total_iqd, offer_revision: o.body.offer.revision, accept_substitutions: true,
    });
    assert.equal(acc.status, 409, JSON.stringify(await json(acc.clone())));
    assert.equal((await json(acc)).code, 'OFFER_NOT_ELIGIBLE');
    assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_orders')!.n, 0);
  });
}

// ------------------------------------------------------------- rollback

test('rollback script: the advertised offer count is recounted for every request it withdrew an offer on', async () => {
  const raw = world();
  const partial = await newDraft(raw);
  assert.equal((await publish(raw, partial, TWO)).status, 200);
  const d = await readDraft(raw, partial);
  const p = await post(as(raw, 'owner'), `/api/marketplace/requests/${partial}/offers`, { price_iqd: 12_000, delivery_method: 'pickup', coverage: { parts: [d.model.parts[0].id] } });
  assert.equal(p.status, 201, JSON.stringify(await json(p.clone())));
  const whole = await newDraft(raw);
  assert.equal((await publish(raw, whole, TWO)).status, 200);
  const w = await post(as(raw, 'owner'), `/api/marketplace/requests/${whole}/offers`, { price_iqd: 30_000, delivery_method: 'pickup' });
  assert.equal(w.status, 201);
  const count = (id: string) => row<{ n: number }>(raw, 'SELECT offer_count AS n FROM community_requests WHERE id = ?', id)!.n;
  assert.equal(count(partial), 1);
  assert.equal(count(whole), 1);
  raw.exec(ROLLBACK);
  assert.equal(count(partial), 0, 'the board no longer advertises the withdrawn offer');
  assert.equal(count(whole), 1, 'a request it did not touch keeps its count');
  raw.exec(ROLLBACK);
  assert.equal(count(partial), 0, 'idempotent');
});

// ================================================== fourth review (round 2)

/**
 * A D1 whose batch runs `hook` first — once — when one of its statements
 * matches `re`: the customer's publish lands after every read of the route
 * and just before its write. With `onFirst`, the hook runs instead before the
 * first `.first()` of a statement whose SQL matches: between two reads.
 */
function raced(raw: DatabaseSync, user: string, re: RegExp, hook: () => Promise<void>, onFirst = false) {
  const d1 = asD1(raw) as unknown as Record<string, unknown> & { batch: (s: Array<{ sql?: string }>) => Promise<unknown>; prepare: (sql: string) => Record<string, unknown> };
  let fired = false;
  const fire = async () => {
    if (fired) return;
    fired = true;
    await hook();
  };
  const wrapStatement = (st: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(st, {
      get(t, k) {
        if (k === 'bind') return (...a: unknown[]) => wrapStatement((t.bind as (...x: unknown[]) => Record<string, unknown>)(...a));
        if (k === 'first') return async (...a: unknown[]) => { await fire(); return (t.first as (...x: unknown[]) => Promise<unknown>)(...a); };
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  const wrapped = new Proxy(d1, {
    get(t, k) {
      if (k === 'batch' && !onFirst) {
        return async (stmts: Array<{ sql?: string }>) => {
          if (stmts.some((s) => re.test(String((s as { sql?: string }).sql ?? '')))) await fire();
          return t.batch(stmts);
        };
      }
      if (k === 'prepare' && onFirst) return (sql: string) => (re.test(sql) && !fired ? wrapStatement(t.prepare(sql)) : t.prepare(sql));
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return stubApp(wrapped as never, { id: user, role: 'customer', email: `${user}@x.co` }, mount);
}

const LID = { name: 'Lid', process: 'fdm', stated_dimensions_mm: { x: 50, y: 50, z: 5 }, materials: [{ material_id: 'pla' }] };
const withLid = async (raw: DatabaseSync, id: string) => {
  const d = await readDraft(raw, id);
  const res = await publish(raw, id, { schema_version: 3, parts: [...d.model.parts, LID] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};
const offerRow = (raw: DatabaseSync, id: string) =>
  row<{ state: string; request_revision: number; revision: number; price_iqd: number }>(raw, 'SELECT state, request_revision, revision, price_iqd FROM community_offers WHERE id = ?', id)!;
const offersOn = (raw: DatabaseSync, id: string) => row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_offers WHERE request_id = ?', id)!.n;

test('fence: a price-only edit of a pending whole offer racing a part the customer adds is REQUEST_CHANGED — never pending over the new part', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, TWO)).status, 200);
  const o = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup' });
  assert.equal(o.status, 201, JSON.stringify(await json(o.clone())));
  const offer = (await json(o)).offer;
  const app = raced(raw, 'owner', /state = 'pending', revision = revision \+ 1/, () => withLid(raw, id));
  const ed = await patch(app, `/api/marketplace/offers/${offer.id}`, { price_iqd: 29_000 });
  assert.equal(ed.status, 409, JSON.stringify(await json(ed.clone())));
  assert.equal((await json(ed)).code, 'REQUEST_CHANGED');
  const after = offerRow(raw, offer.id);
  assert.equal(after.state, 'superseded', 'the edit wrote nothing: the publish superseded it');
  assert.equal(after.request_revision, 1);
  assert.equal(after.price_iqd, 30_000);
});

test('fence: an edit whose request moves between its reads (a new revision) is REQUEST_CHANGED, not re-priced over the new part', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, TWO)).status, 200);
  const o = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup' });
  const offer = (await json(o)).offer;
  // The part check reads the revision model: the customer's publish lands just before that read.
  const app = raced(raw, 'owner', /LEFT JOIN community_request_revisions v ON v\.request_id = r\.id AND v\.revision = r\.revision/, () => withLid(raw, id), true);
  const ed = await patch(app, `/api/marketplace/offers/${offer.id}`, { price_iqd: 29_000 });
  assert.equal(ed.status, 409, JSON.stringify(await json(ed.clone())));
  assert.equal((await json(ed)).code, 'REQUEST_CHANGED');
  assert.equal(offerRow(raw, offer.id).state, 'superseded');
  // Edited again, it takes the stale path: the added part must be named.
  const again = await patch(as(raw, 'owner'), `/api/marketplace/offers/${offer.id}`, { price_iqd: 29_000 });
  assert.equal(again.status, 400, JSON.stringify(await json(again.clone())));
  assert.equal((await json(again)).code, 'OFFER_COVERAGE_INVALID');
});

test('fence: a price-only edit of a substituted offer racing a change to the substituted material is REQUEST_CHANGED', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, TWO)).status, 200);
  const d = await readDraft(raw, id);
  const b = d.model.parts[1];
  const o = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
    price_iqd: 30_000, delivery_method: 'pickup', substitutions: [{ part_id: b.id, material_row_id: b.materials[0].id, to: { material_id: 'petg' } }],
  });
  assert.equal(o.status, 201, JSON.stringify(await json(o.clone())));
  const offer = (await json(o)).offer;
  const changed = { schema_version: 3, parts: [d.model.parts[0], { ...b, materials: [{ ...b.materials[0], material_id: 'pla' }] }] };
  const app = raced(raw, 'owner', /state = 'pending', revision = revision \+ 1/, async () => {
    assert.equal((await publish(raw, id, changed)).status, 200);
  });
  const ed = await patch(app, `/api/marketplace/offers/${offer.id}`, { price_iqd: 29_000 });
  assert.equal(ed.status, 409, JSON.stringify(await json(ed.clone())));
  assert.equal((await json(ed)).code, 'REQUEST_CHANGED');
  assert.equal(offerRow(raw, offer.id).state, 'superseded', 'never pending with a stale «from»');
});

for (const how of ['create', 'send'] as const) {
  test(`fence: ${how === 'create' ? 'a new whole offer' : 'a whole draft sent'} racing a part the customer adds (revision 1 rewritten in place) is REQUEST_CHANGED`, async () => {
    const raw = world();
    const id = await newDraft(raw);
    assert.equal((await publish(raw, id, TWO)).status, 200);
    const app = raced(raw, 'owner', /INSERT INTO community_offers/, () => withLid(raw, id));
    let res: Response;
    let draftId = '';
    if (how === 'create') {
      res = await post(app, `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup' });
    } else {
      const dr = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { draft: true, price_iqd: 30_000, completion_days: 3, delivery_method: 'pickup' });
      assert.equal(dr.status, 201, JSON.stringify(await json(dr.clone())));
      draftId = (await json(dr)).offer.id;
      res = await post(app, `/api/marketplace/offers/${draftId}/send`, {});
    }
    assert.equal(res.status, 409, JSON.stringify(await json(res.clone())));
    assert.equal((await json(res)).code, 'REQUEST_CHANGED');
    assert.equal(offersOn(raw, id), 0, 'nothing written');
    if (draftId) assert.ok(row(raw, 'SELECT id FROM community_offer_drafts WHERE id = ?', draftId), 'the draft is kept');
    assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_request_parts WHERE request_id = ?', id)!.n, 3);
  });
}

test('seen revision: the request page gives the revision hash; an offer that sends an older one is REQUEST_CHANGED, the current one or none is written', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, TWO)).status, 200);
  const seen = await json(await get(as(raw, 'owner'), `/api/marketplace/print/requests/${id}`));
  const h1 = row<{ hash: string }>(raw, 'SELECT hash FROM community_request_revisions WHERE request_id = ? AND revision = 1', id)!.hash;
  assert.equal(seen.revision_hash, h1);
  assert.equal(seen.model.parts.length, 2);
  // The customer adds a part while the composer is open: no offer yet, revision 1 rewritten in place.
  await withLid(raw, id);
  const now = await json(await get(as(raw, 'owner'), `/api/marketplace/print/requests/${id}`));
  assert.notEqual(now.revision_hash, h1, 'the hash moved');
  const stale = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup', expected_request_hash: h1 });
  assert.equal(stale.status, 409, JSON.stringify(await json(stale.clone())));
  assert.equal((await json(stale)).code, 'REQUEST_CHANGED');
  assert.equal(offersOn(raw, id), 0, 'the part the merchant never saw is not covered');
  // A draft saved on the old view is sent only on the job as it now is.
  const dr = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { draft: true, price_iqd: 30_000, completion_days: 3, delivery_method: 'pickup' });
  assert.equal(dr.status, 201, JSON.stringify(await json(dr.clone())));
  const draftId = (await json(dr)).offer.id;
  const sendOld = await post(as(raw, 'owner'), `/api/marketplace/offers/${draftId}/send`, { expected_request_hash: h1 });
  assert.equal(sendOld.status, 409, JSON.stringify(await json(sendOld.clone())));
  assert.equal((await json(sendOld)).code, 'REQUEST_CHANGED');
  assert.ok(row(raw, 'SELECT id FROM community_offer_drafts WHERE id = ?', draftId), 'the draft is kept');
  const sendNow = await post(as(raw, 'owner'), `/api/marketplace/offers/${draftId}/send`, { expected_request_hash: now.revision_hash });
  assert.equal(sendNow.status, 201, JSON.stringify(await json(sendNow.clone())));
});

test('seen revision: a new offer naming the current hash is written; an older client that names none keeps the old behaviour', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, TWO)).status, 200);
  const seen = await json(await get(as(raw, 'owner'), `/api/marketplace/print/requests/${id}`));
  assert.ok(typeof seen.revision_hash === 'string' && seen.revision_hash.length > 0, 'the page names its revision');
  const ok = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup', expected_request_hash: seen.revision_hash });
  assert.equal(ok.status, 201, JSON.stringify(await json(ok.clone())));
  const other = await newDraft(raw);
  assert.equal((await publish(raw, other)).status, 200);
  const old = await post(as(raw, 'owner'), `/api/marketplace/requests/${other}/offers`, { price_iqd: 20_000, delivery_method: 'pickup' });
  assert.equal(old.status, 201, JSON.stringify(await json(old.clone())));
});

// A part as asked in one colour; the substitute names two.
const TWO_COLOURS = { colors: [{ hex: '#1a1a1a', label: 'Black' }, { hex: '#ffffff', label: 'White' }] };
const V1_BLACK = { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1, color_hex: '#1a1a1a', color_name: 'Black' };

for (const [label, body] of [['a job of parts', TWO], ['a one-part v3 job', ONE], ['a v1 job', V1_BLACK]] as const) {
  test(`colours: on ${label}, a substitute that turns one colour into two is refused on a single-colour printer (MULTICOLOR), offered on a multicolour one`, async () => {
    const raw = world();
    const id = await newDraft(raw);
    const pub = body ? await publish(raw, id, body) : await publish(raw, id);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const d = await readDraft(raw, id);
    const part = d.model.parts[0];
    const offer = () => post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
      price_iqd: 30_000, delivery_method: 'pickup', substitutions: [{ part_id: part.id, material_row_id: part.materials[0].id, to: TWO_COLOURS }],
    });
    const bad = await offer();
    assert.equal(bad.status, 403, JSON.stringify(await json(bad.clone())));
    const b = await json(bad);
    assert.equal(b.code, 'OFFER_PART_NOT_ELIGIBLE');
    assert.deepEqual(b.details.reasons, ['MULTICOLOR']);
    assert.equal(b.details.substitute, true, 'the part itself can be made as asked');
    assert.equal(offersOn(raw, id), 0);
    raw.exec(`UPDATE merchant_printers SET multicolor = 1 WHERE id = 'p1'`);
    const ok = await offer();
    assert.equal(ok.status, 201, JSON.stringify(await json(ok.clone())));
  });
}

test('substitute words: a part the workshop can make as asked, refused only for its substitute, says so — not «remove it from the offer»', async () => {
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET materials = '["pla","tpu"]' WHERE id = 'p1'`);
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, ONE)).status, 200);
  const bad = await offerSwap(raw, id, 'petg');
  assert.equal(bad.status, 403, JSON.stringify(bad.body));
  assert.equal(bad.body.details.substitute, true);
  assert.match(bad.body.error ?? bad.body.message ?? '', /substitute/i);
  // A part the workshop cannot make even as asked keeps the plain refusal.
  raw.exec(`UPDATE merchant_printers SET materials = '["tpu"]' WHERE id = 'p1'`);
  const two = await newDraft(raw);
  assert.equal((await publish(raw, two, TWO)).status, 200);
  const d = await readDraft(raw, two);
  const a = d.model.parts[0];
  const plain = await post(as(raw, 'owner'), `/api/marketplace/requests/${two}/offers`, {
    price_iqd: 30_000, delivery_method: 'pickup', substitutions: [{ part_id: a.id, material_row_id: a.materials[0].id, to: { material_id: 'petg' } }],
  });
  const pb = await json(plain);
  assert.equal(plain.status, 403, JSON.stringify(pb));
  assert.equal(pb.code, 'OFFER_PART_NOT_ELIGIBLE');
  assert.equal(pb.details.substitute, undefined, 'the part itself cannot be made: remove it');
});

test('preferences: a substitute is judged on what the printers can do — the workshop own material preference does not refuse the material it proposes', async () => {
  const raw = world();
  raw.exec(`INSERT INTO merchant_request_prefs (merchant_id, materials) VALUES ('m1', '["pla","tpu"]')
            ON CONFLICT(merchant_id) DO UPDATE SET materials = excluded.materials`);
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, TWO)).status, 200);
  const r = await offerSwap(raw, id, 'petg');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // …but a substitute none of its printers runs is still refused.
  raw.exec(`UPDATE merchant_printers SET materials = '["pla","tpu"]' WHERE id = 'p1'`);
  const other = await newDraft(raw);
  assert.equal((await publish(raw, other, TWO)).status, 200);
  const bad = await offerSwap(raw, other, 'petg');
  assert.equal(bad.status, 403, JSON.stringify(bad.body));
  assert.deepEqual(bad.body.details.reasons, ['MATERIAL']);
});

test('R10: a request with no print row (a draft with a model file) counts no unpriced model file — the list says what the page says', async () => {
  const raw = world();
  const id = await newDraft(raw);
  addFile(raw, id, 'crf_a', 'model', 'a.stl', { analysis: MEASURED });
  const page = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}`));
  assert.equal(page.print, null, 'the page shows no estimate and no count');
  const list = await json(await get(as(raw, 'buyer'), '/api/marketplace/print/my-requests'));
  const mine = list.requests.find((r: Record<string, unknown>) => r.id === id);
  assert.equal(mine.print, null);
  assert.equal(mine.summary.models_unpriced, 0);
});

test('notification: a job of parts ordered once reads «1 set» in English, «2 sets» from two', async () => {
  const { printMatchNotification } = await import('../worker/routes/printRequests');
  const body = (sets: number) =>
    printMatchNotification({
      title: 'Phone stand', process: 'fdm', quality: 'standard', quantity: sets, material: null, material_id: '', color_hex: '', dimensions: '',
      governorate: '', deadline: '', budget_iqd: null,
      parts: { count: 2, pieces_per_set: 2, sets, materials: [{ id: 'pla', name_ar: 'PLA', name_en: 'PLA' }], processes: ['fdm'], review: false },
    } as never).body;
  assert.match(body(1).en, /· 1 set(?!s)/);
  assert.doesNotMatch(body(1).en, /1 sets/);
  assert.match(body(2).en, /· 2 sets/);
  assert.match(body(1).ar, /الأطقم 1/);
  assert.match(body(1).ckb, /1 سێت/);
});
