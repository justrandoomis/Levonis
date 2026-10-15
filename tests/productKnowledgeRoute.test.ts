/**
 * `GET /api/products/:slug/knowledge` (the Bambu import spec §G.1, §G.2, §G.4,
 * §B.2; docs/DECISIONS.md rows 239 and 241; worker/lib/knowledge/productKnowledge.ts).
 *
 * The world: the live catalogue of 2026-09-25 with no product priced (every one
 * is shown, none sold — the knowledge answer never depends on a price), and the
 * H2D carrying a full 0194 knowledge model: typed rows from the store page, a
 * manual, the US table and a not-found key; owner-only rows (CBM, a warranty
 * note); logistics and the box; documents on allowed and forbidden hosts;
 * relations to a visible, a hidden and a not-yet-imported target; a swatch; and
 * its source reference. Every private value is a MARKER, so one search over the
 * answer's bytes proves none of them left.
 *
 *   1. the shape the page's lazy tabs read, row by row;
 *   2. what never leaves: store references and titles, owner rows, CBM,
 *      provenance of swatches, documents, relations and the source;
 *   3. the documents, the box, compatibility (a link only to a VISIBLE target);
 *   4. completeness over the expected keys of the product's type;
 *   5. one 404 for a missing slug, a hidden, a draft and a composition row;
 *   6. the edge policy: five minutes for a guest, private for a session, purged
 *      by every catalogue write (`cataloguePaths`);
 *   7. a database without 0194: 200 and empty;
 *   8. the leak scanners over the answer.
 *
 * Run: node --import tsx --test tests/productKnowledgeRoute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, stubApp, type StubUser } from './fixtures/app';
import { seedLiveCatalog, P } from './fixtures/liveCatalog';
import { leaks, arithmeticLeaks } from './fixtures/costlyProduct';
import { catalogLeaks } from './fixtures/catalogOnly';
import { productRoutes, KNOWLEDGE_LIFETIME } from '../worker/routes/products';
import { cataloguePaths, cacheControlFor, SESSION_CACHE_CONTROL } from '../worker/lib/edgePolicy';
import { specKey } from '../packages/catalog/src/bambuImport/registry/specKeys';
import { insertSpecValue } from './fixtures/knowledgeModel';
import { GROUP_LABELS } from '../worker/lib/knowledge/labels';
import { completenessOf, knowledgeTypeOf } from '../worker/lib/knowledge/completeness';
import { publicDocumentUrl, isOwnerOnlyKey } from '../worker/lib/knowledge/productKnowledge';

const H2D = { id: P.H2D, slug: 'bambu-lab-h2d' };
const A1 = { id: P.A1, slug: 'bambu-lab-a1' };
const X2D = { id: P.X2D, slug: 'bambu-lab-x2d' };

/** Private values, each searched for in the raw bytes of every answer. */
const MARK = {
  storeUrl: 'https://us.store.bambulab.com/products/h2d?store-page-secret',
  canonical: 'https://us.store.bambulab.com/products/h2d?canonical-secret',
  storeTitle: 'Bambu Lab US store product page',
  swatchSource: 'https://store.bblcdn.com/swatch-source-secret.png',
  hexRef: 'hex-ref-secret',
  tracker: 'https://e.bambulab.com/t?c=tracker-secret',
  handle: 'ams-2-pro-handle-secret',
  evidence: 'evidence-text-secret',
  conflict: 'also published as: conflict-secret',
  derived: 'derived-from-secret',
  original: 'original-value-secret',
  warranty: 'warranty-note-secret',
  cbm: 0.271828,
  badHost: 'https://evil.example/manual.pdf',
} as const;
const SECRET_TEXT = [MARK.storeUrl, MARK.canonical, MARK.storeTitle, MARK.swatchSource, MARK.hexRef, MARK.tracker, MARK.handle, MARK.evidence, 'conflict-secret', MARK.derived, MARK.original, MARK.warranty, 'evil.example', 'us.store.bambulab.com'];

const MANUAL_URL = 'https://store.bblcdn.com/s1/default/h2d-user-manual.pdf';
const WIKI_URL = 'https://wiki.bambulab.com/en/h2d/manual/specs';
const BOX_KEY = `products/import/gallery/${'ab'.repeat(32)}.webp`;
const SWATCH_URL = `/files/products/import/swatch/${'cd'.repeat(32)}.webp`;

/** One product_spec_values row with this file's markers (tests/fixtures/knowledgeModel.ts). */
function spec(raw: DatabaseSync, productId: string, key: string, over: Record<string, unknown> = {}): void {
  insertSpecValue(raw, productId, key, { original_value: MARK.original, source_ref: MARK.storeUrl, source_title: MARK.storeTitle, ...over });
}

/** The H2D's knowledge model (see the header). */
function seedKnowledge(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_k_ver', '${H2D.id}', 'Version', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES
      ('v_k_std', '${H2D.id}', 'g_k_ver', 'H2D', 0, 1),
      ('v_k_combo', '${H2D.id}', 'g_k_ver', 'H2D AMS Combo', 1, 1);
    INSERT INTO product_option_value_swatches (option_value_id, product_id, url, r2_key, width, height, published_hex, hex_source_ref, source_url)
      VALUES ('v_k_std', '${H2D.id}', '${SWATCH_URL}', '${SWATCH_URL.slice('/files/'.length)}', 128, 128, '#112233', '${MARK.hexRef}', '${MARK.swatchSource}');
    INSERT INTO product_source_refs (source, source_product_id, product_id, source_handle, canonical_url, source_route, match_kind, stock_decision, fingerprint, fetched_at, import_run_id)
      VALUES ('bambu_us', '552709755391528961', '${H2D.id}', 'h2d', '${MARK.canonical}', '552709755391528960>552709755550912512', 'created', 'not_configured', 'f', '2026-10-15T00:00:00Z', 'cir_test');
    UPDATE products SET status = 'hidden' WHERE id = '${X2D.id}';
    INSERT INTO product_documents (id, product_id, kind, title_en, title_ar, title_ckb, url, host, tracker_source, active, sort) VALUES
      ('doc_manual', '${H2D.id}', 'manual', 'H2D User Manual', 'دليل الاستخدام — H2D User Manual', 'ڕێبەری بەکارهێنان — H2D User Manual', '${MANUAL_URL}', 'store.bblcdn.com', '${MARK.tracker}', 1, 0),
      ('doc_wiki', '${H2D.id}', 'wiki', 'H2D specifications', '', '', '${WIKI_URL}', 'wiki.bambulab.com', '', 1, 1),
      ('doc_dead', '${H2D.id}', 'tds', 'Dead TDS', '', '', 'https://store.bblcdn.com/dead-tds.pdf', 'store.bblcdn.com', '', 0, 2),
      ('doc_evil', '${H2D.id}', 'other', 'Evil', '', '', '${MARK.badHost}', 'evil.example', '', 1, 3);
    INSERT INTO product_relations (id, product_id, relation, target_kind, target_product_id, target_source, target_source_handle, target_label, state, evidence_kind, evidence_text)
      VALUES
      ('rel_a1', '${H2D.id}', 'compatible_with', 'printer', '${A1.id}', 'bambu_us', 'a1', 'Bambu Lab A1', 'resolved', 'compat_section', '${MARK.evidence}'),
      ('rel_x2d', '${H2D.id}', 'compatible_with', 'printer', '${X2D.id}', 'bambu_us', 'x2d', 'Bambu Lab X2D', 'resolved', 'compat_section', '${MARK.evidence}'),
      ('rel_ams', '${H2D.id}', 'requires', 'ams', NULL, 'bambu_us', '${MARK.handle}', 'AMS 2 Pro', 'pending', 'feature_bullet', '${MARK.evidence}'),
      ('rel_other', '${H2D.id}', 'recommended_with', 'other', NULL, '', '', 'Cool Plate SuperTack', 'unresolvable', 'description_text', '');
  `);
  const s = (key: string, over: Record<string, unknown> = {}) => spec(raw, H2D.id, key, over);
  s('identity.family', { value_text: 'bambu_lab_3d_printers', sort: 1 });
  s('printing.build_volume', { value_text: '325 × 320 × 325 mm', value_list: '[325,320,325]', source_excerpt: '325*320*325 mm', conflict: MARK.conflict, sort: 2 });
  s('thermal.max_nozzle_temp', { value_text: '350 °C', value_num: 350, source_kind: 'manual', source_ref: MANUAL_URL, source_title: 'H2D User Manual', source_locator: 'p.12', source_excerpt: 'Max hotend temperature 350 °C', test_method: 'Bench measurement', derived_from: MARK.derived, sort: 3 });
  s('electrical.voltage', { value_text: '100-120 VAC', status: 'unverified', region: 'us_110v', test_condition: 'US version (100–120 V)', sort: 4 });
  s('motion.max_speed', {
    status: 'not_found',
    missing_reason: 'not_found_in_checked_sources',
    checked_sources: JSON.stringify([
      { kind: 'store_page', url: MARK.storeUrl, title: MARK.storeTitle },
      { kind: 'wiki', url: WIKI_URL, title: 'H2D specifications' },
      { kind: 'manual', url: MARK.badHost, title: 'A manual on a host nobody allowed' },
    ]),
    sort: 5,
  });
  s('extrusion.filament_diameter', { value_text: '1.75 mm', value_num: 1.75, sort: 6 });
  s('printing.supported_filament', { value_text: 'PLA, PETG', value_list: '["PLA","PETG"]', sort: 7 });
  s('x.chamber-fan', { original_label: 'Chamber Fan', value_text: 'Yes', status: 'unverified', group_key: 'other', sort: 8 });
  s('product.net_weight', { value_text: '31 kg', value_num: 31000, sort: 9 });
  s('shipment.gross_weight', { scope_kind: 'option_value', scope_id: 'v_k_combo', value_text: '44.2 kg', value_num: 44200, status: 'unverified', region: 'us_110v', sort: 10 });
  s('package.contents', {
    data_type: 'list',
    value_list: JSON.stringify([{ text: 'H2D printer', qty: 1, media_key: BOX_KEY }, 'Power cord', { text: 'A part with a bad picture', qty: 2, media_key: '../../etc/passwd' }]),
    sort: 11,
  });
  // Owner-only, by visibility and by key: never a customer's.
  s('package.volume_m3', { value_num: MARK.cbm, value_text: `${MARK.cbm} m³`, visibility: 'owner', source_kind: 'derived', confidence: 'derived', sort: 12 });
  s('package.volume_m3', { scope_kind: 'option_value', scope_id: 'v_k_combo', value_num: MARK.cbm, value_text: `${MARK.cbm} m³`, source_kind: 'derived', confidence: 'derived', sort: 13 });
  s('manufacturer_terms.warranty_note', { value_text: MARK.warranty, data_type: 'list', value_list: JSON.stringify([MARK.warranty]), visibility: 'owner', sort: 14 });
  s('physical.noise', { value_text: '≤ 50 dB', visibility: 'owner', sort: 15 });
}

function world(through: string | null = null) {
  const raw = through ? dbThrough(through) : freshDb();
  seedLiveCatalog(raw);
  if (!through) seedKnowledge(raw);
  const db = asD1(raw);
  const app = (user: StubUser | null = null) => stubApp(db, user, (a) => a.route('/api/products', productRoutes), { publishV2: false });
  return { raw, db, app };
}

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function knowledgeOf(w: ReturnType<typeof world>, slug = H2D.slug, user: StubUser | null = null): Promise<{ res: Response; body: Body; text: string }> {
  const res = await get(w.app(user), `/api/products/${slug}/knowledge`);
  const text = await res.text();
  return { res, body: JSON.parse(text) as Body, text };
}

const rowsOf = (body: Body) => [
  ...body.specs.flatMap((g: Body) => g.rows),
  ...body.logistics.product,
  ...body.logistics.package,
  ...body.logistics.shipment,
  ...body.logistics.carton,
];
const rowByKey = (body: Body, key: string) => rowsOf(body).find((r: Body) => r.key === key);

// ------------------------------------------------------------------ 1. the shape

test('the answer carries exactly the blocks the lazy tabs read', async () => {
  const { res, body } = await knowledgeOf(world());
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['compatibility', 'completeness', 'documents', 'in_the_box', 'logistics', 'specs', 'success', 'swatches']);
  assert.deepEqual(Object.keys(body.logistics).sort(), ['carton', 'package', 'product', 'shipment']);
  assert.deepEqual(Object.keys(body.compatibility).sort(), ['compatible', 'not_compatible', 'related', 'requires']);
  // Groups in the tab's order, each with its three-language heading.
  assert.deepEqual(body.specs.map((g: Body) => g.group), ['identity', 'printing', 'motion', 'extrusion', 'thermal', 'electrical', 'other']);
  for (const g of body.specs) assert.deepEqual(g.label, GROUP_LABELS[g.group] ?? { ar: g.group, en: g.group, ckb: g.group });
});

test('a spec row: the documented keys, the registry label, the value and its status', async () => {
  const { body } = await knowledgeOf(world());
  const vol = rowByKey(body, 'printing.build_volume');
  assert.deepEqual(Object.keys(vol).sort(), [
    'conflict', 'display', 'key', 'label', 'region', 'scope', 'source', 'status', 'test_condition', 'test_method', 'unit', 'value_bool', 'value_num', 'value_num_max', 'value_text',
  ]);
  assert.deepEqual(vol.label, specKey('printing.build_volume')!.labels);
  assert.equal(vol.value_text, '325 × 320 × 325 mm');
  assert.equal(vol.unit, 'mm');
  assert.equal(vol.status, 'verified');
  assert.deepEqual(vol.scope, { kind: 'product', id: '' });
  assert.equal(vol.conflict, true, 'a conflict is a flag; its text stays owner-side');
  // A list fact carries its items.
  assert.deepEqual(rowByKey(body, 'printing.supported_filament').items, ['PLA', 'PETG']);
  // An unknown label keeps the source's own words in every slot.
  assert.deepEqual(rowByKey(body, 'x.chamber-fan').label, { ar: 'Chamber Fan', en: 'Chamber Fan', ckb: 'Chamber Fan' });
  // The family is a filter code, not a table line.
  assert.equal(rowByKey(body, 'identity.family').display, false);
  assert.equal(rowByKey(body, 'printing.build_volume').display, true);
});

test('provenance: the store page is named by kind only; a manual, TDS, SDS or wiki page keeps its public link', async () => {
  const { body } = await knowledgeOf(world());
  const vol = rowByKey(body, 'printing.build_volume');
  assert.deepEqual(vol.source, { kind: 'store_page', title: '', locator: 'Specifications › row 1', excerpt: '325*320*325 mm' });
  const temp = rowByKey(body, 'thermal.max_nozzle_temp');
  assert.deepEqual(temp.source, { kind: 'manual', title: 'H2D User Manual', locator: 'p.12', excerpt: 'Max hotend temperature 350 °C', url: MANUAL_URL });
  assert.equal(temp.test_method, 'Bench measurement');
  assert.equal(temp.value_num, 350);
});

test('the US table: region us_110v, unverified, its test condition — shown, never as the product’s own value', async () => {
  const { body } = await knowledgeOf(world());
  const v = rowByKey(body, 'electrical.voltage');
  assert.equal(v.region, 'us_110v');
  assert.equal(v.status, 'unverified');
  assert.equal(v.test_condition, 'US version (100–120 V)');
});

test('a not-found row: no value, never 0, and the sources checked (the store page by kind alone, no link off the allow-list)', async () => {
  const { body } = await knowledgeOf(world());
  const r = rowByKey(body, 'motion.max_speed');
  assert.equal(r.status, 'not_found');
  assert.equal(r.value_text, '');
  assert.equal(r.value_num, null);
  assert.deepEqual(r.checked_sources, [
    { kind: 'store_page', title: '' },
    { kind: 'wiki', title: 'H2D specifications', url: WIKI_URL },
    { kind: 'manual', title: 'A manual on a host nobody allowed' },
  ]);
});

// ------------------------------------------------------------------ 2. what never leaves

test('no store reference, no owner row, no CBM, no provenance of a swatch, a document, a relation or the source', async () => {
  const { body, text } = await knowledgeOf(world());
  for (const s of SECRET_TEXT) assert.ok(!text.includes(s), `the answer carries «${s}»`);
  assert.ok(!text.includes(String(MARK.cbm)), 'CBM reached a customer');
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
  };
  walk(body);
  for (const k of ['source_ref', 'canonical_url', 'source_url', 'hex_source_ref', 'tracker_source', 'evidence_text', 'visibility', 'derived_from', 'original_value', 'target_source_handle', 'r2_key', 'checked_at']) {
    assert.equal(keys.has(k), false, `the key ${k} reached a customer`);
  }
  const all = rowsOf(body).map((r: Body) => r.key);
  assert.ok(!all.some((k: string) => /volume_m3|manufacturer_terms/.test(k)), all.join(', '));
  assert.ok(!all.includes('physical.noise'), 'an owner-visibility row reached a customer');
  assert.ok(isOwnerOnlyKey('package.volume_m3') && isOwnerOnlyKey('manufacturer_terms.warranty_note') && isOwnerOnlyKey('x.cbm'));
  assert.ok(!isOwnerOnlyKey('package.weight') && !isOwnerOnlyKey('printing.build_volume'));
});

test('a public document link is https on an allow-listed host, and nothing else', () => {
  assert.equal(publicDocumentUrl(MANUAL_URL), MANUAL_URL);
  assert.equal(publicDocumentUrl(WIKI_URL), WIKI_URL);
  for (const bad of ['http://store.bblcdn.com/x.pdf', MARK.badHost, MARK.storeUrl, 'https://user:pw@store.bblcdn.com/x.pdf', 'javascript:alert(1)', '', null]) {
    assert.equal(publicDocumentUrl(bad), null, String(bad));
  }
});

// ------------------------------------------------------------------ 3. documents, the box, compatibility, swatches

test('documents: the active ones on allowed hosts, titled in three languages (Sorani never the Arabic)', async () => {
  const { body } = await knowledgeOf(world());
  assert.deepEqual(body.documents, [
    {
      kind: 'manual',
      title: { ar: 'دليل الاستخدام — H2D User Manual', en: 'H2D User Manual', ckb: 'ڕێبەری بەکارهێنان — H2D User Manual' },
      url: MANUAL_URL,
      host: 'store.bblcdn.com',
      scope: { kind: 'product', id: '' },
    },
    {
      kind: 'wiki',
      title: { ar: 'ويكي Bambu Lab', en: 'H2D specifications', ckb: 'ویکی Bambu Lab' },
      url: WIKI_URL,
      host: 'wiki.bambulab.com',
      scope: { kind: 'product', id: '' },
    },
  ]);
});

test('logistics and the box: their own blocks, the box items with our own pictures only', async () => {
  const { body } = await knowledgeOf(world());
  assert.deepEqual(body.logistics.product.map((r: Body) => [r.key, r.value_num]), [['product.net_weight', 31000]]);
  assert.deepEqual(body.logistics.shipment.map((r: Body) => [r.key, r.scope, r.region]), [['shipment.gross_weight', { kind: 'option_value', id: 'v_k_combo' }, 'us_110v']]);
  assert.deepEqual(body.logistics.package, [], 'the package holds only the owner-only CBM here, which never leaves');
  assert.deepEqual(body.in_the_box, [
    { text: 'H2D printer', qty: 1, image: `/files/${BOX_KEY}`, scope: { kind: 'product', id: '' }, region: '', status: 'verified' },
    { text: 'Power cord', qty: null, scope: { kind: 'product', id: '' }, region: '', status: 'verified' },
    { text: 'A part with a bad picture', qty: 2, scope: { kind: 'product', id: '' }, region: '', status: 'verified' },
  ]);
  assert.ok(!body.specs.some((g: Body) => g.rows.some((r: Body) => /^(product|package|shipment|carton)\./.test(r.key))), 'a logistics row is answered once');
});

test('compatibility: a link only to a VISIBLE target; a hidden or pending target is its label alone', async () => {
  const { body } = await knowledgeOf(world());
  const [a1, x2d] = body.compatibility.compatible;
  assert.equal(a1.label, 'Bambu Lab A1');
  assert.equal(a1.state, 'resolved');
  assert.deepEqual(Object.keys(a1.product).sort(), ['id', 'image', 'name', 'slug']);
  assert.equal(a1.product.slug, A1.slug);
  assert.equal(a1.product.id, A1.id);
  assert.equal(x2d.label, 'Bambu Lab X2D');
  assert.equal('product' in x2d, false, 'a hidden target is never linked');
  assert.deepEqual(body.compatibility.requires, [
    { relation: 'requires', label: 'AMS 2 Pro', target_kind: 'ams', state: 'pending', scope: { kind: 'product', id: '' } },
  ]);
  assert.deepEqual(body.compatibility.related.map((r: Body) => [r.relation, r.label, r.state]), [['recommended_with', 'Cool Plate SuperTack', 'unresolvable']]);
  assert.deepEqual(body.compatibility.not_compatible, []);
});

test('swatches: our own picture, its size and the published hex — never its source', async () => {
  const { body } = await knowledgeOf(world());
  assert.deepEqual(body.swatches, [{ option_value_id: 'v_k_std', url: SWATCH_URL, width: 128, height: 128, published_hex: '#112233' }]);
});

// ------------------------------------------------------------------ 4. completeness

test('completeness: over the expected keys of the type its source route names, public rows only', async () => {
  const { body } = await knowledgeOf(world());
  // A printer expects seven keys; the H2D states four, the US voltage is unverified, max speed was not
  // found and the bed temperature has no row at all.
  assert.deepEqual(body.completeness, { applicable: 7, verified: 4, unverified: 1, not_found: 1, not_published: 0, unknown: 1 });
});

test('the type: the source route first, else the expected set the rows cover best', () => {
  assert.equal(knowledgeTypeOf('552709755391528960>552709755550912512', new Set()), 'printer');
  assert.equal(knowledgeTypeOf('552709755819347968>1>2', new Set()), 'filament');
  assert.equal(knowledgeTypeOf(null, new Set(['material.diameter', 'material.net_weight', 'material.density', 'print_settings.nozzle_temp'])), 'filament');
  assert.equal(knowledgeTypeOf(null, new Set(['nozzle.diameter'])), 'hotend');
  assert.equal(knowledgeTypeOf('', new Set(['x.other'])), null);
  const c = completenessOf([{ key: 'nozzle.diameter', status: 'verified' }, { key: 'nozzle.material', status: 'not_applicable' }], null);
  assert.equal(c.type, 'hotend');
  assert.equal(c.applicable, 1);
  assert.equal(c.ratio, 1);
});

// ------------------------------------------------------------------ 5. one 404

test('a missing slug, a hidden, a draft and a composition product answer the same 404', async () => {
  const w = world();
  w.raw.exec(`UPDATE products SET status = 'draft' WHERE id = '${P.A2L}'`);
  w.raw.exec(`UPDATE products SET composition = 'bundle' WHERE id = '${P.U1}'`);
  const answers = [];
  for (const slug of ['no-such-product', X2D.slug, 'bambu-lab-a2l', 'snapmaker-u1']) {
    const { res, text } = await knowledgeOf(w, slug);
    answers.push({ status: res.status, text });
  }
  for (const a of answers) assert.deepEqual(a, answers[0]);
  assert.equal(answers[0].status, 404);
  assert.deepEqual(JSON.parse(answers[0].text), { success: false, error: 'Product not found', code: 'NOT_FOUND' });
});

// ------------------------------------------------------------------ 6. the edge policy

test('a guest’s answer is shared for five minutes; a session’s is private; a catalogue write purges it', async () => {
  const w = world();
  const guest = await knowledgeOf(w);
  assert.equal(guest.res.headers.get('Cache-Control'), cacheControlFor(KNOWLEDGE_LIFETIME));
  assert.match(guest.res.headers.get('Cache-Control') ?? '', /s-maxage=300/);
  assert.ok(guest.res.headers.get('ETag'));
  const member = await knowledgeOf(w, H2D.slug, { id: 'u1', role: 'customer', email: 'u1@x.co' });
  assert.equal(member.res.status, 200);
  assert.equal(member.res.headers.get('Cache-Control'), SESSION_CACHE_CONTROL);
  assert.deepEqual(member.body, guest.body, 'the answer is nobody’s own');
  assert.ok(cataloguePaths([H2D.slug]).includes(`/api/products/${H2D.slug}/knowledge`));
  assert.ok(!cataloguePaths([]).some((p) => p.endsWith('/knowledge')));
});

// ------------------------------------------------------------------ 7. without 0194

test('a database without 0194: 200 and empty — never a 500', async () => {
  const w = world('0193');
  const { res, body } = await knowledgeOf(w);
  assert.equal(res.status, 200);
  assert.deepEqual(body, {
    success: true,
    specs: [],
    logistics: { product: [], package: [], shipment: [], carton: [] },
    in_the_box: [],
    compatibility: { compatible: [], not_compatible: [], requires: [], related: [] },
    documents: [],
    swatches: [],
    completeness: null,
  });
  // …and the 404 is still the 404.
  assert.equal((await knowledgeOf(w, 'no-such-product')).res.status, 404);
});

test('a product with no knowledge row: 200 and empty, completeness null', async () => {
  const { res, body } = await knowledgeOf(world(), A1.slug);
  assert.equal(res.status, 200);
  assert.deepEqual(body.specs, []);
  assert.equal(body.completeness, null);
});

// ------------------------------------------------------------------ 8. the leak scanners

test('the leak scanners find nothing in the answer: no cost, no financial key, no price arithmetic', async () => {
  const { body } = await knowledgeOf(world());
  assert.deepEqual(leaks(body), []);
  assert.deepEqual(catalogLeaks(body), []);
  assert.deepEqual(arithmeticLeaks(body), []);
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /price|cost|stock|"available"/i, 'no money or stock word in the knowledge answer');
});

test('every group heading is written in three languages, the Sorani never the Arabic', () => {
  for (const [group, t] of Object.entries(GROUP_LABELS)) {
    assert.ok(t.ar && t.en && t.ckb, group);
    assert.notEqual(t.ckb, t.ar, `${group}: the Sorani copies the Arabic`);
    assert.match(t.ckb, /[ڕڵێۆەڤ]/, `${group}: the Sorani has no Sorani letter`);
  }
});
