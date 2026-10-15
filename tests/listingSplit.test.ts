/**
 * VISIBLE AND SELLABLE — THE TWO PREDICATES (DECISIONS row 240; spec §1, §7.1;
 * worker/lib/listing.ts), against the real migrated schema.
 *
 * The matrix: the owner's «إخفاء المنتجات الناقصة» switch off (nothing held)
 * or on (held) × every completeness code × V2-published or not × active or a
 * draft. Proves:
 *   - VISIBLE = active, and not held for a CATALOG gap (`IMAGE`, `CATEGORY`);
 *     every other code (the name, the price, the cost, the engine inputs, the
 *     box) only stops the sale;
 *   - SELLABLE = the old «listed» predicate byte for byte: active, not held
 *     for ANY gap, V2-published;
 *   - `statesOf` names each state (hidden / catalog_only / sellable), and a
 *     composition is shown only while sellable (default D6);
 *   - `visibleProductBySlug` carries `sellable_now`, and `parseProductRow`
 *     ignores that column;
 *   - the id-set readers agree with the SQL.
 *
 * Run: node --import tsx --test tests/listingSplit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, row } from './fixtures/app';
import { publishV2 } from './fixtures/v2Publish';
import { CATALOG_BLOCKING_CODES, COMPLETENESS_CODES } from '@levonis/contracts/productCompleteness';
import { listing, sellableSql, visibleProductBySlug, visibleSql } from '../worker/lib/listing';
import { parseProductRow } from '../worker/lib/productModel';

async function world() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO products (id, slug, name, status, price_iqd, stock, selling_type, sale_types) VALUES
      ('p_pub', 'published', 'Published', 'active', 100000, 3, 'direct_sale', '["direct_sale"]'),
      ('p_new', 'unpublished', 'Unpublished', 'active', 100000, 3, 'direct_sale', '["direct_sale"]'),
      ('p_draft', 'draft', 'Draft', 'draft', 100000, 3, 'direct_sale', '["direct_sale"]');
  `);
  await publishV2(raw, 'p_pub');
  return raw;
}

type State = { visible: boolean; sellable: boolean };

async function stateOf(raw: ReturnType<typeof freshDb>, id: string): Promise<State & { stateOf: string; invisible: boolean; unsellable: boolean }> {
  const db = asD1(raw);
  const L = await listing(db);
  const r = row<{ v: number; s: number; f: number }>(
    raw,
    `SELECT (CASE WHEN ${L.visible('p')} THEN 1 ELSE 0 END) AS v, (CASE WHEN ${L.sellable('p')} THEN 1 ELSE 0 END) AS s, ${L.sellableFlag('p')} AS f FROM products p WHERE p.id = ?`,
    id
  )!;
  assert.equal(r.f, r.s, 'the SELECT-list flag is the WHERE predicate');
  const states = await L.statesOf([id]);
  return {
    visible: r.v === 1,
    sellable: r.s === 1,
    stateOf: states.get(id)!,
    invisible: (await L.invisibleIds([id])).has(id),
    unsellable: (await L.unsellableIds([id])).has(id),
  };
}

function hold(raw: ReturnType<typeof freshDb>, id: string, code: string | null, held: boolean): void {
  raw.prepare('DELETE FROM product_completeness WHERE product_id = ?').run(id);
  if (code === null) return;
  raw
    .prepare(
      `INSERT INTO product_completeness (product_id, complete, held, missing_json, missing_count, computed_at)
       VALUES (?, 0, ?, ?, 1, '2026-10-15T00:00:00.000Z')`
    )
    .run(id, held ? 1 : 0, JSON.stringify([{ c: code, o: '' }]));
}

test('the matrix: switch × every code × published or not', async () => {
  const raw = await world();
  for (const id of ['p_pub', 'p_new'] as const) {
    const published = id === 'p_pub';
    for (const held of [false, true]) {
      for (const code of [null, ...COMPLETENESS_CODES]) {
        hold(raw, id, code, held);
        const s = await stateOf(raw, id);
        const catalogGap = held && code !== null && (CATALOG_BLOCKING_CODES as readonly string[]).includes(code);
        const saleGap = held && code !== null;
        const where = `${id} held=${held} code=${code}`;
        assert.equal(s.visible, !catalogGap, `${where}: VISIBLE`);
        assert.equal(s.sellable, published && !saleGap, `${where}: SELLABLE`);
        assert.equal(s.stateOf, s.sellable ? 'sellable' : s.visible ? 'catalog_only' : 'hidden', `${where}: statesOf`);
        assert.equal(s.invisible, !s.visible, `${where}: invisibleIds`);
        assert.equal(s.unsellable, !s.sellable, `${where}: unsellableIds`);
      }
    }
  }
});

test('a draft is neither; a composition is shown only while sellable', async () => {
  const raw = await world();
  const draft = await stateOf(raw, 'p_draft');
  assert.deepEqual([draft.visible, draft.sellable, draft.stateOf], [false, false, 'hidden']);
  raw.exec("INSERT INTO products (id, slug, name, status, price_iqd, composition) VALUES ('p_bundle', 'bundle', 'Bundle', 'active', 0, 'bundle')");
  const bundle = await stateOf(raw, 'p_bundle');
  assert.equal(bundle.stateOf, 'hidden', 'an unpriced bundle is never shown catalog-only (its content is its price)');
  assert.equal(bundle.invisible, true);
});

test('the SQL: SELLABLE is the old «listed» predicate; VISIBLE never reads a price or the V2 tables', () => {
  assert.equal(visibleSql('p', false), "p.status = 'active'");
  assert.doesNotMatch(visibleSql('p', true), /pricing|price|pv2/);
  assert.match(visibleSql('p', true), /pcv\.held = 1 AND EXISTS \(SELECT 1 FROM json_each\(pcv\.missing_json\) jcv WHERE json_extract\(jcv\.value, '\$\.c'\) IN \('IMAGE','CATEGORY'\)\)/);
  assert.match(sellableSql('p', true), /pch\.held = 1/);
  assert.match(sellableSql('p', true), /pv2\.mode = 'engine' AND pv2\.pricing_method IS NOT NULL/);
  assert.match(sellableSql('p', true, false), / AND 0$/, 'without 0189 nothing is sellable');
  assert.throws(() => visibleSql('p; DROP TABLE x', true), /LISTING_INVARIANT/);
});

test('visibleProductBySlug carries sellable_now; parseProductRow ignores it', async () => {
  const raw = await world();
  const db = asD1(raw);
  const pub = await visibleProductBySlug(db, 'published');
  const unpub = await visibleProductBySlug(db, 'unpublished');
  assert.equal(pub?.sellable_now, 1);
  assert.equal(unpub?.sellable_now, 0, 'shown, not sold');
  assert.equal(await visibleProductBySlug(db, 'draft'), null);
  const doc = parseProductRow(unpub!) as unknown as Record<string, unknown>;
  assert.equal('sellable_now' in doc, false);
  hold(raw, 'p_new', 'IMAGE', true);
  assert.equal(await visibleProductBySlug(db, 'unpublished'), null, 'a catalogue gap hides it');
  hold(raw, 'p_new', 'PRICE', true);
  assert.equal((await visibleProductBySlug(db, 'unpublished'))?.sellable_now, 0, 'a commercial gap only stops the sale');
});
