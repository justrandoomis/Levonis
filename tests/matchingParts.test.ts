/**
 * THE MATCHER READS PARTS — ONLY OF A FRESH VERSION-3 ROW (P1-05, docs/
 * DECISIONS.md row 267, D4) — worker/lib/printMatchingStore.ts.
 *
 * Real routes and migrations. Pinned: a published job of parts is loaded with
 * its parts (process, materials, colours, size, grams); a version-3 row an
 * older build changed since (its fingerprint stale) and a v1 request are the
 * single job their v1 row says; a database before 0208 reads no parts and
 * does not fail; and of the workshops told about a job, one that can make
 * every part is told before one that can make some, whatever their score.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1 } from './fixtures/app';
import { apply0208, newDraft, publish, PLA, world } from './fixtures/requestModelWorld';
import { loadRequestFacts } from '../worker/lib/printMatchingStore';

const twoParts = {
  schema_version: 3,
  parts: [
    { name: 'Red', process: 'fdm', stated_dimensions_mm: { x: 40, y: 30, z: 10 }, materials: [{ material_id: 'pla', colors: [{ mode: 'catalogue', hex: '#d32f2f' }] }] },
    { name: 'Grip', process: 'fdm', stated_dimensions_mm: { x: 60, y: 20, z: 20 }, materials: [{ material_id: 'tpu', colors: [{ mode: 'catalogue', hex: '#1976d2' }] }] },
  ],
};

test('a fresh version-3 job of parts is loaded with its parts; a stale one and a v1 one are the single job they say', async () => {
  const raw = world();
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, twoParts)).status, 200);
  const facts = (await loadRequestFacts(asD1(raw), [id])).get(id)!;
  assert.equal(facts.parts!.length, 2);
  assert.deepEqual(facts.parts!.map((p) => [p.process, p.materials, p.colors_count, p.dims_mm]), [
    ['fdm', [{ material_id: 'pla', colours: ['#d32f2f'] }], 1, { x: 40, y: 30, z: 10 }],
    ['fdm', [{ material_id: 'tpu', colours: ['#1976d2'] }], 1, { x: 60, y: 20, z: 20 }],
  ]);
  // The v1 mirror says one colour at once — four parts in one colour each never ask for more.
  assert.equal(facts.colors_count, 1);

  // An older build changed the v1 row: the stamp is stale, the row is its v1 job.
  raw.prepare(`UPDATE community_print_requests SET material_id = 'abs', material_unsure = 0 WHERE request_id = ?`).run(id);
  const stale = (await loadRequestFacts(asD1(raw), [id])).get(id)!;
  assert.equal(stale.parts, undefined);
  assert.equal(stale.material_id, 'abs');

  // A one-part v3 job and a v1 job carry no parts.
  const one = await newDraft(raw);
  assert.equal((await publish(raw, one, { schema_version: 3, parts: [{ process: 'fdm', materials: [{ material_id: 'pla' }] }] })).status, 200);
  const v1 = await newDraft(raw);
  assert.equal((await publish(raw, v1, PLA)).status, 200);
  const both = await loadRequestFacts(asD1(raw), [one, v1]);
  assert.equal(both.get(one)!.parts, undefined);
  assert.equal(both.get(v1)!.parts, undefined);
});

test('a database before 0208 reads no parts and does not fail; after the migration nothing changes for a v1 job', async () => {
  const raw = world('0207');
  const id = await newDraft(raw);
  assert.equal((await publish(raw, id, PLA)).status, 200);
  const facts = (await loadRequestFacts(asD1(raw), [id])).get(id)!;
  assert.equal(facts.parts, undefined);
  assert.equal(facts.material_id, 'pla');
  apply0208(raw);
  const after = (await loadRequestFacts(asD1(raw), [id])).get(id)!;
  assert.deepEqual(after, facts);
});

test('who is told first: a workshop that can make every part, before a higher-scored one that can make some', async () => {
  const raw = world();
  raw.exec(`
    INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('printMatchNotifyLimit', '1');
    -- Ali makes PLA only, and is the better-rated shop.
    UPDATE merchant_printers SET materials = '["pla"]' WHERE id = 'p1';
    UPDATE community_merchants SET rating_avg_x100 = 500, rating_count = 50, completed_orders = 400 WHERE id = 'm1';
    -- Omar gains an FDM machine that runs everything.
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p3','m2','s2','Any FDM','fdm',300,300,300,'[]','ultra');
  `);
  const id = await newDraft(raw);
  const res = await publish(raw, id, twoParts);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = raw.prepare('SELECT merchant_id, eligible, notified FROM community_request_matches WHERE request_id = ? ORDER BY merchant_id').all(id) as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((r) => [r.merchant_id, r.eligible, r.notified]), [['m1', 1, 0], ['m2', 1, 1]]);
});
