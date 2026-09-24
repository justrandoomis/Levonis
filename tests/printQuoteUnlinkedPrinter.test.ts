/**
 * THE COSTING TAB AND THE PRINTERS THE DASHBOARD CREATES — audit 03 §10 L, Z.
 *
 * Every printer a merchant adds from the dashboard is UNLINKED: nothing writes
 * `merchant_printers.model_id`. `loadMerchantPrinters` selected `p.*` beside
 * the LEFT-JOINed `m.build_x_mm…`, the row kept the later (NULL) column, and
 * every such printer read a {0,0,0} build volume — so the Costing tab marked a
 * 300 mm machine too small for a 20 mm cube. The route suite never saw it: its
 * one priced printer is inserted already LINKED by SQL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asD1 } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { loadMerchantPrinters } from '../worker/lib/printQuote/repository';
import { printerEligibility } from '../worker/lib/printQuote/printers';

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','A','a@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m-1','u1','Shop');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m-1','u1','shop','Shop');
  `);
  return raw;
}

test('L: a printer created from the dashboard keeps the build volume its merchant typed', async () => {
  const raw = seed();
  // Exactly the row PrintersTab → POST /api/merchant/printers writes: no model_id.
  raw.exec(`INSERT INTO merchant_printers (id, merchant_id, store_id, name, technology, build_x_mm, build_y_mm, build_z_mm, materials)
            VALUES ('mp-big','m-1','s1','Big FDM','fdm',300,300,300,'["pla"]')`);
  const [p] = await loadMerchantPrinters(asD1(raw), 'm-1');
  assert.equal(p.unlinked, true);
  assert.deepEqual(p.model.buildMm, { x: 300, y: 300, z: 300 });
  const e = printerEligibility(p.model, { boundingBoxMm: { x: 20, y: 20, z: 20 }, materialTypes: ['PLA'], simultaneousMaterials: 1 });
  assert.deepEqual(e, { eligible: true, reasons: [] }, 'a 20 mm cube fits a 300 mm machine');
  // And a part that really is too big is still refused — the check works, it
  // just works on the right numbers.
  const big = printerEligibility(p.model, { boundingBoxMm: { x: 320, y: 20, z: 20 }, materialTypes: ['PLA'], simultaneousMaterials: 1 });
  assert.deepEqual(big.reasons, ['build_volume']);
});

test('L: a LINKED printer is still measured by its canonical model, not by what was typed beside it', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO merchant_printers (id, merchant_id, store_id, name, technology, build_x_mm, build_y_mm, build_z_mm, materials, model_id)
            VALUES ('mp-mini','m-1','s1','My A1 mini','fdm',999,999,999,'["pla"]','bbl-a1m')`);
  const [p] = await loadMerchantPrinters(asD1(raw), 'm-1');
  assert.equal(p.unlinked, false);
  assert.deepEqual(p.model.buildMm, { x: 180, y: 180, z: 180 }, 'the A1 mini is 180 mm whatever the row says');
});

test('Z: the Costing tab names every refusal the server actually sends', () => {
  const src = readFileSync(join(ROOT, 'src/components/merchant/dashboard/CostingTab.tsx'), 'utf8');
  // printers.ts `printerEligibility` codes, verbatim.
  for (const code of ['build_volume', 'materials_at_once', 'enclosure', 'hardened_nozzle', 'nozzle']) {
    assert.match(src, new RegExp(`\\b${code}:\\s*\\[`), `no label for the server's '${code}'`);
  }
  assert.match(src, /startsWith\('material:'\)/, "the per-material code 'material:<id>' is labelled too");
});
