/**
 * READERS AND OFFERS V3, FIFTH REVIEW (P1-05, docs/DECISIONS.md row 267) —
 * through the real routes and migrations.
 *
 * Pinned:
 *   fence    a price-only edit of a pending whole offer on a ONE-part v3 job
 *            and on a v1 job, racing a part the customer adds, is
 *            REQUEST_CHANGED and the offer stays superseded; so is a new whole
 *            offer of an older client (no hash) on a one-part job; an edit
 *            that names an older revision hash is refused, the current one
 *            written.
 *   colours  a material-only substitute keeps every colour asked, «any» and
 *            «as in the reference» included: it is counted (MULTICOLOR on a
 *            single-colour printer, on a job of parts and on a v1 job of two
 *            colours), kept in the agreement, and on both sides of the line.
 *   card     the custom-order chat card says partial and substituted.
 *   R10      the request page counts an original model file as the list does
 *            when an older writer made the row no longer v3.
 *   board    a job of parts with a part whose material is open says so.
 *   quote    /quote on a published job of parts answers the page figures.
 *   words    the match notice in Arabic and Sorani has a word for a part and
 *            another for a piece, and the pieces in all.
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

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/merchant/workshop', merchantWorkshopRoutes);
};
const as = (raw: DatabaseSync, id: string) => stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount);

/** A D1 whose batch runs `hook` first — once — when one of its statements matches `re`: after every read of the route, before its write. */
function raced(raw: DatabaseSync, user: string, re: RegExp, hook: () => Promise<void>) {
  const d1 = asD1(raw) as unknown as Record<string, unknown> & { batch: (s: Array<{ sql?: string }>) => Promise<unknown> };
  let fired = false;
  const wrapped = new Proxy(d1, {
    get(t, k) {
      if (k === 'batch') {
        return async (stmts: Array<{ sql?: string }>) => {
          if (!fired && stmts.some((s) => re.test(String(s.sql ?? '')))) {
            fired = true;
            await hook();
          }
          return t.batch(stmts);
        };
      }
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return stubApp(wrapped as never, { id: user, role: 'customer', email: `${user}@x.co` }, mount);
}

const ONE = { schema_version: 3, parts: [{ name: 'Body', process: 'fdm', stated_dimensions_mm: { x: 40, y: 30, z: 10 }, materials: [{ material_id: 'pla' }] }] };
const LID = { name: 'Lid', process: 'fdm', stated_dimensions_mm: { x: 50, y: 50, z: 5 }, materials: [{ material_id: 'pla' }] };
const withLid = async (raw: DatabaseSync, id: string) => {
  const d = await readDraft(raw, id);
  const res = await publish(raw, id, { schema_version: 3, parts: [...d.model.parts, LID] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};
const offerRow = (raw: DatabaseSync, id: string) =>
  row<{ state: string; request_revision: number; revision: number; price_iqd: number; covers_all: number }>(
    raw, 'SELECT state, request_revision, revision, price_iqd, covers_all FROM community_offers WHERE id = ?', id
  )!;
const offersOn = (raw: DatabaseSync, id: string) => row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_offers WHERE request_id = ?', id)!.n;
const partsOn = (raw: DatabaseSync, id: string) => row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM community_request_parts WHERE request_id = ?', id)!.n;

// ================================================================ fence

for (const [label, body] of [['a one-part v3 job', ONE], ['a v1 job', null]] as const) {
  test(`fence: a price-only edit of a pending whole offer on ${label}, racing a part the customer adds, is REQUEST_CHANGED — the offer stays superseded`, async () => {
    const raw = world();
    const id = await newDraft(raw);
    const pub = body ? await publish(raw, id, body) : await publish(raw, id);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const o = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup' });
    assert.equal(o.status, 201, JSON.stringify(await json(o.clone())));
    const offer = (await json(o)).offer;
    const app = raced(raw, 'owner', /state = 'pending', revision = revision \+ 1/, () => withLid(raw, id));
    const ed = await patch(app, `/api/marketplace/offers/${offer.id}`, { price_iqd: 29_000 });
    assert.equal(ed.status, 409, JSON.stringify(await json(ed.clone())));
    assert.equal((await json(ed)).code, 'REQUEST_CHANGED');
    assert.equal(partsOn(raw, id), 2, 'the customer did add the part');
    const after = offerRow(raw, offer.id);
    assert.equal(after.state, 'superseded', 'never reopened over the added part');
    assert.equal(after.request_revision, 1);
    assert.equal(after.price_iqd, 30_000);
    // Edited again, it takes the stale path: the added part must be named.
    const again = await patch(as(raw, 'owner'), `/api/marketplace/offers/${offer.id}`, { price_iqd: 29_000 });
    assert.equal(again.status, 400, JSON.stringify(await json(again.clone())));
    assert.equal((await json(again)).code, 'OFFER_COVERAGE_INVALID');
  });
}

test('fence: a new whole offer of an older client (no hash) on a one-part job, racing a part the customer adds, is REQUEST_CHANGED', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, ONE)).status, 200);
  const app = raced(raw, 'owner', /INSERT INTO community_offers/, () => withLid(raw, id));
  const res = await post(app, `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup' });
  assert.equal(res.status, 409, JSON.stringify(await json(res.clone())));
  assert.equal((await json(res)).code, 'REQUEST_CHANGED');
  assert.equal(offersOn(raw, id), 0, 'no whole offer over a part its merchant never saw');
  assert.equal(partsOn(raw, id), 2);
});

test('fence: a sent whole draft on a v1 job, racing a part the customer adds, is REQUEST_CHANGED and the draft is kept', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id)).status, 200);
  const dr = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { draft: true, price_iqd: 30_000, completion_days: 3, delivery_method: 'pickup' });
  assert.equal(dr.status, 201, JSON.stringify(await json(dr.clone())));
  const draftId = (await json(dr)).offer.id;
  const app = raced(raw, 'owner', /INSERT INTO community_offers/, () => withLid(raw, id));
  const res = await post(app, `/api/marketplace/offers/${draftId}/send`, {});
  assert.equal(res.status, 409, JSON.stringify(await json(res.clone())));
  assert.equal((await json(res)).code, 'REQUEST_CHANGED');
  assert.equal(offersOn(raw, id), 0);
  assert.ok(row(raw, 'SELECT id FROM community_offer_drafts WHERE id = ?', draftId), 'the draft is kept');
});

test('seen revision: an edit of a sent offer that names an older revision hash is REQUEST_CHANGED; the current hash is written', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, ONE)).status, 200);
  const seen = await json(await get(as(raw, 'owner'), `/api/marketplace/print/requests/${id}`));
  const o = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup', expected_request_hash: seen.revision_hash });
  assert.equal(o.status, 201, JSON.stringify(await json(o.clone())));
  const offer = (await json(o)).offer;
  // The customer adds a part: the offer is superseded, and the merchant edits on the page they had open.
  await withLid(raw, id);
  const now = await json(await get(as(raw, 'owner'), `/api/marketplace/print/requests/${id}`));
  assert.notEqual(now.revision_hash, seen.revision_hash);
  const d = await readDraft(raw, id);
  const all = d.model.parts.map((p: { id: string }) => p.id);
  const old = await patch(as(raw, 'owner'), `/api/marketplace/offers/${offer.id}`, { price_iqd: 40_000, coverage: { parts: all }, expected_request_hash: seen.revision_hash });
  assert.equal(old.status, 409, JSON.stringify(await json(old.clone())));
  assert.equal((await json(old)).code, 'REQUEST_CHANGED');
  assert.equal(offerRow(raw, offer.id).state, 'superseded');
  const ok = await patch(as(raw, 'owner'), `/api/marketplace/offers/${offer.id}`, { price_iqd: 40_000, coverage: { parts: all }, expected_request_hash: now.revision_hash });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  const after = offerRow(raw, offer.id);
  assert.equal(after.state, 'pending');
  assert.equal(after.price_iqd, 40_000);
  assert.equal(after.request_revision, 2);
});

test('fence: an ordinary price-only edit of a pending whole offer on a one-part job is still written', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, ONE)).status, 200);
  const o = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 30_000, delivery_method: 'pickup' });
  const offer = (await json(o)).offer;
  const ed = await patch(as(raw, 'owner'), `/api/marketplace/offers/${offer.id}`, { price_iqd: 29_000 });
  assert.equal(ed.status, 200, JSON.stringify(await json(ed.clone())));
  assert.deepEqual({ ...offerRow(raw, offer.id) }, { state: 'pending', request_revision: 1, revision: 2, price_iqd: 29_000, covers_all: 1 });
});

// ================================================================ colours

const BLACK = { mode: 'catalogue', hex: '#1a1a1a', label: 'Black' };
const partsWith = (colors: unknown[]) => ({
  schema_version: 3,
  parts: [
    { name: 'Body', process: 'fdm', stated_dimensions_mm: { x: 80, y: 60, z: 20 }, materials: [{ material_id: 'pla', colors }] },
    { name: 'Lid', process: 'fdm', stated_dimensions_mm: { x: 60, y: 20, z: 20 }, materials: [{ material_id: 'pla', colors: [BLACK] }] },
  ],
});

async function swapOffer(raw: DatabaseSync, id: string, to: Record<string, unknown>) {
  const d = await readDraft(raw, id);
  const a = d.model.parts[0];
  const res = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
    price_iqd: 30_000, delivery_method: 'pickup',
    substitutions: [{ part_id: a.id, material_row_id: a.materials[0].id, to }],
  });
  return { status: res.status, body: await json(res), part: a };
}

for (const [label, colors] of [
  ['Black and «as in the reference»', [BLACK, { mode: 'as_reference' }]],
  ['Black and «any colour»', [BLACK, { mode: 'any' }]],
  ['«as in the reference» twice', [{ mode: 'as_reference' }, { mode: 'as_reference' }]],
  ['«any colour» twice', [{ mode: 'any' }, { mode: 'any' }]],
] as const) {
  test(`colours: a material-only substitute on a part asked in ${label} is counted on both colours — MULTICOLOR on a single-colour printer`, async () => {
    const raw = world();
    raw.exec(`UPDATE merchant_printers SET materials = '["pla","petg"]', multicolor = 0 WHERE id = 'p1'`);
    const id = await newDraft(raw);
    const pub = await publish(raw, id, partsWith([...colors]));
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const r = await swapOffer(raw, id, { material_id: 'petg' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'OFFER_PART_NOT_ELIGIBLE');
    assert.deepEqual(r.body.details.reasons, ['MULTICOLOR']);
    assert.equal(offersOn(raw, id), 0, 'nothing written');
  });
}

test('colours: on a multicolour printer the material-only substitute is offered with every colour on both sides, and the agreement keeps «as in the reference»', async () => {
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET materials = '["pla","petg"]', multicolor = 1 WHERE id = 'p1'`);
  fund(raw, 'buyer', 1_000_000);
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, partsWith([BLACK, { mode: 'as_reference' }]))).status, 200);
  const r = await swapOffer(raw, id, { material_id: 'petg' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const sub = r.body.offer.substitutions[0];
  const both = [{ hex: '#1a1a1a', label: 'Black' }, { hex: '', label: '', mode: 'as_reference' }];
  assert.deepEqual(sub.from, { material_id: 'pla', colors: both });
  assert.deepEqual(sub.to, { material_id: 'petg', colors: both }, 'what stays is on the side the customer reads');
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${r.body.offer.id}/accept`, {
    expected_total_iqd: r.body.offer.total_iqd, offer_revision: r.body.offer.revision, accept_substitutions: true,
  });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const snap = JSON.parse(row<{ request_snapshot: string }>(raw, 'SELECT request_snapshot FROM community_orders')!.request_snapshot);
  const agreed = snap.agreement.parts[0].materials[0];
  assert.equal(agreed.material_id, 'petg');
  assert.deepEqual(agreed.colors.map((c: { mode: string }) => c.mode), ['catalogue', 'as_reference'], 'both colours, as asked');
  assert.equal(agreed.colors[0].hex, '#1a1a1a');
});

test('colours: a substitute that names a colour replaces the named one and keeps «as in the reference» — counted two, kept in the agreement', async () => {
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET materials = '["pla","petg"]', multicolor = 0 WHERE id = 'p1'`);
  fund(raw, 'buyer', 1_000_000);
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, partsWith([BLACK, { mode: 'as_reference' }]))).status, 200);
  const red = { colors: [{ hex: '#d32f2f', label: 'Red' }] };
  const single = await swapOffer(raw, id, red);
  assert.equal(single.status, 403, JSON.stringify(single.body));
  assert.deepEqual(single.body.details.reasons, ['MULTICOLOR']);
  raw.exec(`UPDATE merchant_printers SET multicolor = 1 WHERE id = 'p1'`);
  const r = await swapOffer(raw, id, red);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.offer.substitutions[0].to.colors, [{ hex: '#d32f2f', label: 'Red' }, { hex: '', label: '', mode: 'as_reference' }]);
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${r.body.offer.id}/accept`, {
    expected_total_iqd: r.body.offer.total_iqd, offer_revision: r.body.offer.revision, accept_substitutions: true,
  });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const snap = JSON.parse(row<{ request_snapshot: string }>(raw, 'SELECT request_snapshot FROM community_orders')!.request_snapshot);
  assert.deepEqual(snap.agreement.parts[0].materials[0].colors.map((c: { mode: string; hex: string }) => [c.mode, c.hex]), [['custom', '#d32f2f'], ['as_reference', '']]);
});

test('colours: a draft with a colour substitute on a part with «as in the reference» saves only the named colour and is sent', async () => {
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET materials = '["pla","petg"]', multicolor = 1 WHERE id = 'p1'`);
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, partsWith([BLACK, { mode: 'as_reference' }]))).status, 200);
  const d = await readDraft(raw, id);
  const a = d.model.parts[0];
  const dr = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
    draft: true, price_iqd: 30_000, completion_days: 3, delivery_method: 'pickup',
    substitutions: [{ part_id: a.id, material_row_id: a.materials[0].id, to: { colors: [{ hex: '#d32f2f', label: 'Red' }] } }],
  });
  assert.equal(dr.status, 201, JSON.stringify(await json(dr.clone())));
  const draftId = (await json(dr)).offer.id;
  const payload = JSON.parse(row<{ payload_json: string }>(raw, 'SELECT payload_json FROM community_offer_drafts WHERE id = ?', draftId)!.payload_json);
  assert.deepEqual(payload.substitutions[0].to, { colors: [{ hex: '#d32f2f', label: 'Red' }] });
  const sent = await post(as(raw, 'owner'), `/api/marketplace/offers/${draftId}/send`, {});
  assert.equal(sent.status, 201, JSON.stringify(await json(sent.clone())));
  // The stored offer edited again with its own substitution: the kept entry is read back from the request.
  const offer = (await json(sent)).offer;
  const ed = await patch(as(raw, 'owner'), `/api/marketplace/offers/${offer.id}`, { price_iqd: 31_000 });
  assert.equal(ed.status, 200, JSON.stringify(await json(ed.clone())));
  const subs = JSON.parse(row<{ substitutions_json: string }>(raw, 'SELECT substitutions_json FROM community_offers WHERE id = ?', offer.id)!.substitutions_json);
  assert.equal(subs[0].to.colors.length, 2);
});

test('colours: a v1 job of two colours (one named) — a material-only substitute is judged on two colours — refused, the substitute the cause', async () => {
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET multicolor = 1, materials = '["pla"]' WHERE id = 'p1'`);
  raw.exec(`INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
            VALUES ('p3','m1','s1','Small PETG','fdm',300,300,300,'["petg"]','ultra')`);
  const id = await newDraft(raw);
  const pub = await publish(raw, id, { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1, color_hex: '#1a1a1a', color_name: 'Black', colors_count: 2 });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const r = await swapOffer(raw, id, { material_id: 'petg' });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.code, 'OFFER_PART_NOT_ELIGIBLE');
  // The first reason in policy order across the printers: p1 runs no PETG
  // (MATERIAL), p3 runs it in one colour (MULTICOLOR). Before review 5 the
  // substitute was counted on its one named colour, and p3 took it.
  assert.deepEqual(r.body.details.reasons, ['MATERIAL']);
  assert.equal(r.body.details.substitute, true, 'the job itself is made as asked');
  // A printer that runs PETG in several colours makes it.
  raw.exec(`UPDATE merchant_printers SET multicolor = 1 WHERE id = 'p3'`);
  const ok = await swapOffer(raw, id, { material_id: 'petg' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

// ================================================================ card

test('card: an order accepted from a partial offer with a substitute says so on its chat card and on the customer order row; a whole order keeps its card bytes', async () => {
  const { customOrderCard } = await import('../worker/lib/chatCards');
  const raw = world();
  raw.exec(`UPDATE merchant_printers SET materials = '["pla","petg","tpu"]' WHERE id = 'p1'`);
  fund(raw, 'buyer', 1_000_000);
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, partsWith([BLACK]))).status, 200);
  const d = await readDraft(raw, id);
  const a = d.model.parts[0];
  const o = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, {
    price_iqd: 12_000, delivery_method: 'pickup', coverage: { parts: [a.id] },
    substitutions: [{ part_id: a.id, material_row_id: a.materials[0].id, to: { material_id: 'petg' } }],
  });
  assert.equal(o.status, 201, JSON.stringify(await json(o.clone())));
  const offer = (await json(o)).offer;
  const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${offer.id}/accept`, {
    expected_total_iqd: offer.total_iqd, offer_revision: offer.revision, accept_partial: true, accept_substitutions: true,
  });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const order = row<Record<string, unknown>>(raw, 'SELECT * FROM community_orders')!;
  const card = customOrderCard(order, 'A phone stand', 'funded');
  assert.equal(card.snapshot.covers_all, false);
  assert.equal(card.snapshot.uncovered_count, 1);
  assert.equal(card.snapshot.substitutes, true);
  const rows = (await json(await get(as(raw, 'buyer'), '/api/marketplace/orders'))).orders;
  assert.equal(rows[0].covers_all, false);
  assert.equal(rows[0].uncovered_count, 1);
  assert.equal(rows[0].substitutes, true);
  assert.equal(rows[0].offer_snapshot, undefined, 'the snapshots stay on the order page');
  assert.equal(rows[0].request_snapshot, undefined);
  // A whole order with nothing substituted: the card every order had before.
  const whole = customOrderCard({ ...order, request_snapshot: '{}', offer_snapshot: '{"coverage":{"covers_all":true,"parts":null},"substitutions":[]}' }, 'A phone stand', 'funded');
  assert.deepEqual(Object.keys(whole.snapshot), ['v', 'order_id', 'request_id', 'title', 'price_iqd', 'completion_days', 'delivery_method', 'event']);
});

// ================================================================ rollback

test('rollback: the read-only open-orders query lists a running order accepted from a partial or substituted offer, and nothing else', async () => {
  const sql = readFileSync(new URL('../scripts/before-rollback-open-orders-v3.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\b(UPDATE|DELETE|INSERT|DROP|ALTER)\b/i, 'read only');
  const raw = world();
  fund(raw, 'buyer', 2_000_000);
  const take = async (body: Record<string, unknown>, extra: Record<string, unknown>) => {
    const id = await newDraft(raw);
    assert.equal((await publish(raw, id, partsWith([BLACK]))).status, 200);
    const d = await readDraft(raw, id);
    const o = await post(as(raw, 'owner'), `/api/marketplace/requests/${id}/offers`, { price_iqd: 12_000, delivery_method: 'pickup', ...(typeof body.coverage === 'string' ? { coverage: { parts: [d.model.parts[0].id] } } : {}) });
    assert.equal(o.status, 201, JSON.stringify(await json(o.clone())));
    const offer = (await json(o)).offer;
    const acc = await post(as(raw, 'buyer'), `/api/marketplace/offers/${offer.id}/accept`, { expected_total_iqd: offer.total_iqd, offer_revision: offer.revision, ...extra });
    assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
    return String((await json(acc)).order.id);
  };
  const partial = await take({ coverage: 'first' }, { accept_partial: true });
  const whole = await take({}, {});
  const listed = () => (raw.prepare(sql.replace(/--.*$/gm, '')).all() as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(listed(), [partial]);
  raw.prepare(`UPDATE community_orders SET state = 'completed' WHERE id = ?`).run(partial);
  assert.deepEqual(listed(), [], 'an order that ended is not followed');
  assert.ok(whole);
  const runbook = readFileSync(new URL('../docs/CLOUDFLARE_BUILDS_RUNBOOK.md', import.meta.url), 'utf8');
  assert.match(runbook, /scripts\/before-rollback-open-orders-v3\.sql/);
  assert.match(readFileSync(new URL('../scripts/before-rollback-offers-v3.sql', import.meta.url), 'utf8'), /before-rollback-open-orders-v3\.sql/);
});

// ================================================================ R10

const cube = (mm: number): Uint8Array => {
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
};
const { analyseModel } = await import('../worker/lib/modelGeometry');
const MEASURED = analyseModel(cube(30), 'c.stl') as unknown as Record<string, unknown>;

async function countsFor(raw: DatabaseSync, id: string) {
  const page = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}`));
  const list = await json(await get(as(raw, 'buyer'), '/api/marketplace/print/my-requests'));
  const mine = list.requests.find((r: Record<string, unknown>) => r.id === id);
  return { page: page.print.models_unpriced as number, list: mine.summary.models_unpriced as number };
}

test('R10: a row an older writer made no longer v3 still never counts the original model file — the page says what the list says', async () => {
  const raw = world();
  const id = await newDraft(raw);
  addFile(raw, id, 'crf_a', 'model', 'a.stl', { analysis: MEASURED });
  addFile(raw, id, 'crf_o', 'model', 'orig.stl', { analysis: MEASURED });
  addFile(raw, id, 'crf_x', 'model', 'x.stl', { analysis: MEASURED });
  const res = await publish(raw, id, {
    schema_version: 3, source_type: 'model',
    sources: [{ kind: 'file', file_id: 'crf_a', is_primary: true }, { kind: 'file', file_id: 'crf_o', role: 'source' }],
    parts: [
      { name: 'A', process: 'fdm', measured_file_id: 'crf_a', materials: [{ material_id: 'pla' }] },
      { name: 'B', process: 'fdm', stated_dimensions_mm: { x: 20, y: 20, z: 20 }, materials: [{ material_id: 'tpu' }] },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await countsFor(raw, id), { page: 1, list: 1 });
  // An older deploy writes a v1 column the tables do not carry: no longer an effective v3 row.
  raw.prepare(`UPDATE community_print_requests SET color_name = 'Olive', color_hex = '#556b2f' WHERE request_id = ?`).run(id);
  const page = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}`));
  assert.notEqual(page.model?.schema_version, 3, 'the row reads as v1 now');
  assert.deepEqual(await countsFor(raw, id), { page: 1, list: 1 });
});

// ================================================================ quote

test('quote: the v1 wizard quoting a published job of parts gets the page figures — the stored model priced part by part, its R10', async () => {
  const raw = world();
  const id = await newDraft(raw);
  addFile(raw, id, 'crf_a', 'model', 'a.stl', { analysis: MEASURED });
  addFile(raw, id, 'crf_b', 'model', 'b.stl', { analysis: MEASURED });
  const res = await publish(raw, id, {
    schema_version: 3, source_type: 'model',
    sources: [{ kind: 'file', file_id: 'crf_a', is_primary: true }, { kind: 'file', file_id: 'crf_b' }],
    parts: [
      { name: 'A', process: 'fdm', measured_file_id: 'crf_a', materials: [{ material_id: 'pla' }] },
      { name: 'B', process: 'fdm', measured_file_id: 'crf_b', materials: [{ material_id: 'tpu' }] },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const page = await json(await get(as(raw, 'buyer'), `/api/marketplace/print/requests/${id}`));
  const q = await json(await post(as(raw, 'buyer'), '/api/marketplace/print/quote', {
    request_id: id, file_id: 'crf_a', process: 'fdm', material_id: '', material_unsure: true, quality: 'standard', quantity: 1,
  }));
  assert.equal(q.success, true, JSON.stringify(q));
  assert.equal(q.models_unpriced, page.print.models_unpriced);
  assert.equal(q.models_unpriced, 0);
  const stored = JSON.parse(row<{ estimate: string }>(raw, 'SELECT estimate FROM community_print_requests WHERE request_id = ?', id)!.estimate);
  assert.equal(q.quote.price_low_iqd, stored.price_low_iqd, 'the range the page shows');
  assert.equal(q.quote.price_high_iqd, stored.price_high_iqd);
  // A v1 job is quoted the v1 way, as before.
  const v1 = await newDraft(raw);
  assert.equal((await publish(raw, v1)).status, 200);
  const q1 = await json(await post(as(raw, 'buyer'), '/api/marketplace/print/quote', { request_id: v1, process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1, volume_cm3: 10 }));
  assert.equal(q1.success, true);
  assert.equal(q1.quote.coverage, undefined, 'no part coverage on a v1 quote');
});

// ================================================================ board

test('board: a job with a PLA part and a part whose material is open says the material is open; a job of named materials does not', async () => {
  const raw = world();
  const id = await newDraft(raw);
  const res = await publish(raw, id, {
    schema_version: 3,
    parts: [
      { name: 'Body', process: 'fdm', stated_dimensions_mm: { x: 40, y: 30, z: 10 }, materials: [{ material_id: 'pla' }] },
      { name: 'Lid', process: 'fdm', stated_dimensions_mm: { x: 40, y: 30, z: 10 }, materials: [{ material_unsure: true }] },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const named = await newDraft(raw);
  assert.equal((await publish(raw, named, partsWith([BLACK]))).status, 200);
  const board = (await json(await get(as(raw, 'owner'), '/api/merchant/workshop/board'))).requests as Array<{ id: string; summary: Record<string, unknown> }>;
  const card = board.find((r) => r.id === id)!;
  assert.deepEqual(card.summary.materials, ['pla']);
  assert.equal(card.summary.materials_open, true);
  assert.equal(board.find((r) => r.id === named)!.summary.materials_open, false);
});

// ================================================================ words

test('notification: a part and a piece are two words in Arabic and Sorani, and the pieces in all are said', async () => {
  const { printMatchNotification } = await import('../worker/routes/printRequests');
  const body = printMatchNotification({
    title: 'Phone stand', process: 'fdm', quality: 'standard', quantity: 3, material: null, material_id: '', color_hex: '', dimensions: '',
    governorate: '', deadline: '', budget_iqd: null,
    parts: { count: 2, pieces_per_set: 3, sets: 3, materials: [{ id: 'pla', name_ar: 'PLA', name_en: 'PLA' }], processes: ['fdm'], review: false },
  } as never).body;
  assert.match(body.ar, /عدد الأجزاء 2 · القطع في الطقم 3 · الأطقم 3 · مجموع القطع 9/);
  assert.doesNotMatch(body.ar, /عدد القطع 2/);
  assert.match(body.ckb, /2 بەش · 3 پارچە لە هەر سێتێکدا · 3 سێت · کۆی پارچەکان 9/);
  assert.match(body.en, /2 parts · 3 pieces a set · 3 sets · 9 pieces in all/);
  const once = printMatchNotification({
    title: 'Phone stand', process: 'fdm', quality: 'standard', quantity: 1, material: null, material_id: '', color_hex: '', dimensions: '',
    governorate: '', deadline: '', budget_iqd: null,
    parts: { count: 2, pieces_per_set: 2, sets: 1, materials: [], processes: ['fdm'], review: false },
  } as never).body;
  assert.doesNotMatch(once.en, /in all/, 'one set: the pieces are already said');
});
