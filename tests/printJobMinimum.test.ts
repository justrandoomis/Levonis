/**
 * «لا يوجد حد أدنى لأي طلب طباعة» — NO MINIMUM FOR ANY PRINT JOB.
 *
 * The owner's ruling, and the reason it needs a test rather than a diff: the
 * floor lives in THREE places that can disagree, and two of them are data.
 *
 *   1. `DEFAULT_PRICING.min_job_iqd` — the seeded platform floor.
 *   2. `DEFAULT_MATERIALS[].min_economic_iqd` — a seeded floor PER MATERIAL,
 *      which the quote takes the MAX of alongside the platform one, so leaving
 *      these at 3,000–12,000 د.ع would have kept a minimum under another name.
 *   3. The `admin_settings` rows. `getSetting` returns a stored row verbatim
 *      and falls back to the code default only when none exists, so on a
 *      database where the admin screen has ever been saved, changing the
 *      defaults changes NOTHING. migrations/0097 is what reaches those rows,
 *      and its second statement is the one that can corrupt rather than fix:
 *      rebuilding a JSON array without the `json()` wrapper double-encodes
 *      every material and the catalogue reads as empty.
 *
 * What is NOT removed, and must not be: the margin floor. `min_margin_percent`
 * is not a minimum charge — it moves with the job's own cost — and an estimate
 * below it is one no merchant can honour.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { analyseModel, type ModelAnalysis } from '../worker/lib/modelGeometry';
import {
  DEFAULT_PRICING,
  DEFAULT_MATERIALS,
  quotePrint,
  type PrintPricingConfig,
  type QuoteInput,
} from '../worker/lib/printPricing';

// ------------------------------------------------------------ the seeds

test('the platform charges no minimum, and neither does any seeded material', () => {
  assert.equal(DEFAULT_PRICING.min_job_iqd, 0, 'the platform floor is back');
  const withFloor = DEFAULT_MATERIALS.filter((m) => m.min_economic_iqd !== 0);
  assert.deepEqual(
    withFloor.map((m) => `${m.id}=${m.min_economic_iqd}`),
    [],
    'a per-material floor is still a minimum for a print job'
  );
});

test('the margin floor survives — it is not a minimum charge', () => {
  // The distinction the ruling turns on. A 2 g keychain is now quoted at what
  // it costs plus the margin; what it must never be quoted at is under cost.
  assert.ok(DEFAULT_PRICING.min_margin_percent > 0, 'the margin floor was removed with the job floor');
});

// ------------------------------------------------------------ the quote

/** A real STL, analysed by the real geometry reader — the same fixtures
 *  tests/printPricing.test.ts uses, because a hand-written ModelAnalysis that
 *  the analyser would never produce proves nothing about the quote. */
function boxTriangles(mm: number): number[][] {
  const v = (i: number, j: number, k: number) => [i * mm, j * mm, k * mm];
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

function binaryStl(triangles: number[][]): Uint8Array {
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

const cube = (mm: number): ModelAnalysis => analyseModel(binaryStl(boxTriangles(mm)), 'c.stl');

/** The smallest thing anyone prints: a 4 mm cube at 5% infill. */
function tinyQuote(cfg: PrintPricingConfig) {
  const input: QuoteInput = {
    analysis: cube(4),
    materialId: 'pla',
    quality: 'standard',
    infill: 0.05,
    quantity: 1,
    colors: 1,
    supports: false,
    post_processing_minutes: 0,
  };
  return quotePrint(input, DEFAULT_MATERIALS, cfg);
}

test('a tiny part is no longer lifted to a flat figure nobody computed', () => {
  const q = tinyQuote(DEFAULT_PRICING);
  assert.equal(q.priced, true);
  // The only floor left is cost + the minimum margin, which for a 4 mm cube is
  // far under the 5,000 د.ع this used to be rounded up to.
  assert.ok(q.price_iqd > 0, 'a real job still costs something');
  assert.ok(q.price_iqd < 5000, `a 4 mm cube still quotes ${q.price_iqd} — a floor is still applied`);
  assert.ok(q.margin_percent >= DEFAULT_PRICING.min_margin_percent - 0.01, `margin was ${q.margin_percent}%`);
});

test('a floor the owner types back into the admin still binds', () => {
  // The capability is what survives the decision. If this stopped working, the
  // admin field would be a control that does nothing.
  const q = tinyQuote({ ...DEFAULT_PRICING, min_job_iqd: 7000 });
  assert.ok(q.price_iqd >= 7000, `${q.price_iqd} ignored the configured floor`);
});

// -------------------------------------------------------- the stored rows

function migrated(rows: Array<[string, string]>): Map<string, string> {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const [key, value] of rows) {
    db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(key, value);
  }
  db.exec(readFileSync(join(ROOT, 'migrations/0097_no_minimum_print_job.sql'), 'utf8'));
  const out = new Map<string, string>();
  for (const r of db.prepare('SELECT key, value FROM admin_settings').all() as Array<{ key: string; value: string }>) {
    out.set(r.key, r.value);
  }
  db.close();
  return out;
}

test('a saved pricing row loses its floor and keeps everything else', () => {
  const stored = JSON.stringify({ ...DEFAULT_PRICING, min_job_iqd: 5000, round_to_iqd: 250, setup_minutes: 17 });
  const after = JSON.parse(migrated([['printPricingConfig', stored]]).get('printPricingConfig')!);
  assert.equal(after.min_job_iqd, 0);
  assert.equal(after.setup_minutes, 17, "the owner's other edits were overwritten");
  assert.equal(after.round_to_iqd, 250);
  assert.equal(Object.keys(after).length, Object.keys(DEFAULT_PRICING).length, 'the shape changed');
});

test('a saved material catalogue comes back as an ARRAY OF OBJECTS, not of strings', () => {
  // THE FAILURE THIS TEST EXISTS FOR. json_group_array over json_set produces
  // ["{\"id\":\"pla\"…}", …] unless each element is wrapped in json(). The row
  // would still be valid JSON and the migration would still report success,
  // and every material would be unreadable.
  const stored = JSON.stringify(DEFAULT_MATERIALS.map((m) => ({ ...m, min_economic_iqd: 3000 })));
  const after = JSON.parse(migrated([['printMaterials', stored]]).get('printMaterials')!);
  assert.ok(Array.isArray(after));
  assert.equal(after.length, DEFAULT_MATERIALS.length);
  for (const m of after) {
    assert.equal(typeof m, 'object', 'a material came back double-encoded as a string');
    assert.equal(m.min_economic_iqd, 0, `${m.id} kept its floor`);
  }
  assert.equal(after[0].id, DEFAULT_MATERIALS[0].id, 'the order moved');
  assert.equal(after[0].price_iqd_per_kg, DEFAULT_MATERIALS[0].price_iqd_per_kg, "the owner's prices were touched");
});

test('a row that is not JSON is left exactly as it was', () => {
  // A hand-edited or truncated row must not be turned into something the
  // parser then rejects; settings.ts already falls back to the seed for it.
  const after = migrated([
    ['printPricingConfig', 'not json at all'],
    ['printMaterials', '{"not":"an array"}'],
  ]);
  assert.equal(after.get('printPricingConfig'), 'not json at all');
  assert.equal(after.get('printMaterials'), '{"not":"an array"}');
});

test('a database nobody has saved these settings in is not given a row', () => {
  // The migration must not INSERT: an absent row means "use the seeded
  // default", which is now 0 anyway, and writing one would freeze today's
  // seeds into the database forever.
  const after = migrated([['someOtherKey', '{"a":1}']]);
  assert.equal(after.has('printPricingConfig'), false);
  assert.equal(after.has('printMaterials'), false);
  assert.equal(after.size, 1);
});
