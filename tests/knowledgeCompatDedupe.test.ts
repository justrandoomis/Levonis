/**
 * COMPATIBILITY, ONE ITEM PER TARGET LABEL (docs/bambu-import/I18N-DESIGN.md
 * §C.1, §C.2; the owner's note on /product/filament-buffer, 2026-10-16:
 * «التوافق مكرر» — six chips X1, P1, P1, X1, P1, P1).
 *
 *   1. the canary's seven relation rows (the committed filament-buffer page,
 *      the committed compat-targets.json) answer compatible [P1 Series,
 *      X1 Series] and requires [AMS Hub] — not six chips;
 *   2. the scope merge: a product-wide row absorbs the same label scoped to a
 *      value; rows scoped to two values alone stay one item per value;
 *   3. two VISIBLE targets of one family label are one item: the first by slug
 *      is `product`, the other rides `more`;
 *   4. the answer does not depend on the order the rows arrive in;
 *   5. through the real route and the real migrations: the same, and a pending
 *      «يتطلب» row carries no link.
 *
 * Run: node --import tsx --test tests/knowledgeCompatDedupe.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { fixtureJson, pageOf } from './fixtures/bambu/load';
import { assembleKnowledge, type KnowledgeRows } from '../worker/lib/knowledge/answer';
import { asD1, freshDb, get, stubApp } from './fixtures/app';
import { seedLiveCatalog, LIVE_PRODUCTS, P } from './fixtures/liveCatalog';
import { productRoutes } from '../worker/routes/products';

const media = { url: (raw: string) => raw };

function canaryRelations(): Array<Record<string, unknown>> {
  const x = pageOf('filament-buffer').extraction;
  const p = buildImportPayload({
    extraction: x,
    writeMode: 'create',
    extractionSha256: extractionFingerprint(x),
    targets: fixtureJson('compat-targets.json') as never,
    retrievedAt: '2026-10-16T00:00:00Z',
  }).payload;
  return p.relations.map((r) => ({
    relation: r.relation,
    target_kind: r.target_kind,
    target_label: r.target_label,
    state: r.state,
    scope_kind: r.scope_kind,
    scope_id: r.scope_id,
    handle: r.target_source_handle,
  }));
}

const rowsOf = (relations: Array<Record<string, unknown>>): KnowledgeRows => ({ specs: [], documents: [], relations, swatches: [], sourceRoute: null });

test('the canary: seven rows answer compatible [P1 Series, X1 Series] and requires [AMS Hub], each once, product-wide', () => {
  const rel = canaryRelations();
  assert.equal(rel.length, 7, 'the seven rows of the screenshot');
  assert.equal(rel.filter((r) => r.relation === 'compatible_with').length, 6);
  const k = assembleKnowledge(rowsOf(rel), media);
  assert.deepEqual(k.compatibility.compatible.map((c) => c.label), ['P1 Series', 'X1 Series']);
  assert.deepEqual(k.compatibility.requires.map((c) => c.label), ['AMS Hub']);
  for (const c of [...k.compatibility.compatible, ...k.compatibility.requires]) {
    assert.deepEqual(c.scope, { kind: 'product', id: '' }, `${c.label}: the product-wide fact absorbs the value-scoped one`);
    assert.equal(c.product, undefined, 'nothing is visible yet: no link');
    assert.equal(c.state, 'pending');
  }
});

test('the scope merge: product + value is one product item; two values alone are one item each', () => {
  const base = { relation: 'compatible_with', target_kind: 'printer', state: 'pending' };
  const merged = assembleKnowledge(
    rowsOf([
      { ...base, target_label: 'A1 mini', scope_kind: 'option_value', scope_id: 'ov_a' },
      { ...base, target_label: 'A1 mini', scope_kind: 'product', scope_id: '' },
      { ...base, target_label: 'a1  MINI', scope_kind: 'option_value', scope_id: 'ov_b' },
    ]),
    media
  );
  assert.equal(merged.compatibility.compatible.length, 1);
  assert.deepEqual(merged.compatibility.compatible[0].scope, { kind: 'product', id: '' });
  assert.equal(merged.compatibility.compatible[0].label, 'A1 mini', 'the code-point-smallest label of the group');
  const split = assembleKnowledge(
    rowsOf([
      { ...base, target_label: 'A1 mini', scope_kind: 'option_value', scope_id: 'ov_b' },
      { ...base, target_label: 'A1 mini', scope_kind: 'option_value', scope_id: 'ov_a' },
      { ...base, target_label: 'A1 mini', scope_kind: 'option_value', scope_id: 'ov_a' },
    ]),
    media
  );
  assert.deepEqual(
    split.compatibility.compatible.map((c) => c.scope.id),
    ['ov_a', 'ov_b']
  );
  // Another relation of the same label is another item (requires ≠ compatible_with).
  const two = assembleKnowledge(
    rowsOf([
      { ...base, target_label: 'AMS Hub', scope_kind: 'product', scope_id: '' },
      { ...base, relation: 'requires', target_label: 'AMS Hub', scope_kind: 'product', scope_id: '' },
    ]),
    media
  );
  assert.equal(two.compatibility.compatible.length, 1);
  assert.equal(two.compatibility.requires.length, 1);
});

test('two visible targets of one family label: one item, `product` the first by slug, the other in `more`; state resolved if any row is', () => {
  const rel = canaryRelations().map((r) => {
    const visible: Record<string, { id: string; slug: string }> = {
      p1s: { id: 'p_p1s', slug: 'p1s' },
      'refurbished-p1s': { id: 'p_rp1s', slug: 'refurbished-p1s' },
    };
    const t = visible[String(r.handle)];
    return t ? { ...r, state: 'resolved', t_id: t.id, t_slug: t.slug, t_name: t.slug.toUpperCase() } : r;
  });
  const k = assembleKnowledge(rowsOf(rel), { ...media, targetPicture: (id) => `/files/${id}.webp` });
  const p1 = k.compatibility.compatible.find((c) => c.label === 'P1 Series')!;
  assert.equal(p1.state, 'resolved');
  assert.equal(p1.product?.slug, 'p1s');
  assert.equal(p1.product?.image, '/files/p_p1s.webp');
  assert.deepEqual(p1.more?.map((m) => [m.id, m.slug]), [['p_rp1s', 'refurbished-p1s']]);
  const x1 = k.compatibility.compatible.find((c) => c.label === 'X1 Series')!;
  assert.equal(x1.product, undefined);
  assert.equal(x1.more, undefined);
  assert.equal(x1.state, 'pending');
});

test('order independence: shuffled rows give the same answer', () => {
  const rel = canaryRelations();
  const want = JSON.stringify(assembleKnowledge(rowsOf(rel), media).compatibility);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 20; i++) {
    const shuffled = [...rel].sort(() => rnd() - 0.5);
    assert.equal(JSON.stringify(assembleKnowledge(rowsOf(shuffled), media).compatibility), want);
  }
  assert.equal(JSON.stringify(assembleKnowledge(rowsOf([...rel].reverse()), media).compatibility), want);
});

test('through the real route: one chip per label, a visible target linked, a pending «يتطلب» plain', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  raw.exec(`
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_c_compat', '${P.H2D}', 'Compatibility', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('v_c_all', '${P.H2D}', 'g_c_compat', 'X1 Series and P1 Series', 0, 1);
    INSERT INTO product_relations (id, product_id, relation, target_kind, target_product_id, target_source, target_source_handle, target_label, state, evidence_kind, scope_kind, scope_id) VALUES
      ('rel_c1', '${P.H2D}', 'compatible_with', 'family', '${P.P1S}', 'bambu_us', 'p1s', 'P1 Series', 'resolved', 'option_value', 'option_value', 'v_c_all'),
      ('rel_c2', '${P.H2D}', 'compatible_with', 'family', '${P.P1S}', 'bambu_us', 'p1s', 'P1 Series', 'resolved', 'compat_section', 'product', ''),
      ('rel_c3', '${P.H2D}', 'compatible_with', 'family', NULL, 'bambu_us', 'refurbished-x1c', 'X1 Series', 'pending', 'option_value', 'option_value', 'v_c_all'),
      ('rel_c4', '${P.H2D}', 'compatible_with', 'family', NULL, 'bambu_us', 'refurbished-x1c', 'X1 Series', 'pending', 'compat_section', 'product', ''),
      ('rel_c5', '${P.H2D}', 'requires', 'hub', NULL, 'bambu_us', 'ams-hub', 'AMS Hub', 'pending', 'description_text', 'product', '');
  `);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes), { publishV2: false });
  const slug = LIVE_PRODUCTS.find((p) => p.id === P.H2D)!.slug;
  const res = await get(app, `/api/products/${slug}/knowledge`);
  assert.equal(res.status, 200);
  const k = (await res.json()) as { compatibility: Record<string, Array<{ label: string; product?: { slug: string }; scope: { kind: string } }>> };
  assert.deepEqual(k.compatibility.compatible.map((c) => [c.label, c.scope.kind, c.product?.slug ?? null]), [
    ['P1 Series', 'product', LIVE_PRODUCTS.find((p) => p.id === P.P1S)!.slug],
    ['X1 Series', 'product', null],
  ]);
  assert.deepEqual(k.compatibility.requires.map((c) => [c.label, c.product ?? null]), [['AMS Hub', null]]);
});
