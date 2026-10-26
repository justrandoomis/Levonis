/**
 * LEVONIS PRINT CLOUD — review fixes, cluster «i18n» (finding c29).
 *
 * A notice that names a material speaks each reader's language: the Arabic
 * body carries the variant's Arabic name and the unit's Arabic word, the
 * Sorani body the Sorani ones, and the English body the English name and the
 * unit's symbol. Before the fix every body was filled from one English-only
 * map, so Arabic and Sorani readers saw «PLA Basic Cold White» and a bare 'g'.
 *
 * Run: node --import tsx --import ./scripts/test-no-network.mjs --test tests/printCloudFixes-i18n.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, API, buy, estimatedJob, ok, owned, pcWorld, reconcileClean, rows, runToPrinting, seedCatalog, type World } from './fixtures/printCloud';
import { enqueueTask } from '../worker/lib/printCloud/tasks';

const H = 3600;
const WHITE = { en: 'PLA Basic Cold White', ar: 'PLA أبيض بارد', ckb: 'PLA سپی سارد' };
const GRAM = { ar: 'غرام', ckb: 'گرام' };

interface Bodies {
  ar: string;
  en: string;
  ckb: string;
}

function notices(w: World, notice: string): Bodies[] {
  return rows<{ body_ar: string; body_en: string; meta: string }>(
    w,
    "SELECT body_ar, body_en, meta FROM user_notifications WHERE user_id = 'usr_pc_a' AND kind = 'print_cloud' AND json_extract(meta, '$.notice') = ? ORDER BY created_at",
    notice
  ).map((n) => ({ ar: n.body_ar, en: n.body_en, ckb: String(JSON.parse(n.meta).body_ckb ?? '') }));
}

/** Each body names the white PLA in its own language, never in English where it should not. */
function speaksEachLanguage(b: Bodies, label: string, qty?: number): void {
  assert.ok(b.ar.includes(`«${WHITE.ar}»`), `${label}: the Arabic body names the Arabic variant: ${b.ar}`);
  assert.ok(b.ckb.includes(`«${WHITE.ckb}»`), `${label}: the Sorani body names the Sorani variant: ${b.ckb}`);
  assert.ok(b.en.includes(`«${WHITE.en}»`), `${label}: the English body names the English variant: ${b.en}`);
  assert.ok(!b.ar.includes(WHITE.en) && !b.ckb.includes(WHITE.en), `${label}: no English name in Arabic or Sorani`);
  if (qty === undefined) return;
  assert.ok(b.ar.includes(`${qty} ${GRAM.ar}`), `${label}: the Arabic body reads the unit as «${GRAM.ar}»: ${b.ar}`);
  assert.ok(b.ckb.includes(`${qty} ${GRAM.ckb}`), `${label}: the Sorani body reads the unit as «${GRAM.ckb}»: ${b.ckb}`);
  assert.ok(b.en.includes(`${qty} g `), `${label}: the English body keeps the symbol: ${b.en}`);
  assert.ok(!/\d g\b/.test(b.ar) && !/\d g\b/.test(b.ckb), `${label}: no raw unit code in Arabic or Sorani`);
  assert.notEqual(b.ckb, b.ar, `${label}: the Sorani body is not a copy of the Arabic`);
}

async function buybackWorld(): Promise<{ w: World; white: string }> {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await ok(w.full, 'PATCH', `${ADMIN}/categories/filaments/buyback`, { buyback_enabled: true, buyback_rate_bps: 5000 });
  await buy(w.a, [{ kind: 'material', variant_id: cat.white, quantity: 250 }]);
  return { w, white: cat.white };
}

test('c29: an approved buyback tells the customer in Arabic, English and Sorani, each with its own name and unit', async () => {
  const { w, white } = await buybackWorld();
  const req = await ok(w.a, 'POST', `${API}/buybacks`, { variant_id: white, qty: 100 });
  const approved = await ok(w.full, 'POST', `${ADMIN}/buybacks/${req.buyback_id}/approve`, { note: 'ok' });
  const [b] = notices(w, 'buyback_approved');
  assert.ok(b, 'the approval notice was written');
  speaksEachLanguage(b, 'buyback_approved', 100);
  for (const body of [b.ar, b.en, b.ckb]) assert.ok(body.includes(String(approved.value_iqd)), `the value is in every body: ${body}`);
  await reconcileClean(w);
});

test('c29: a rejected buyback names the material in each reader’s language', async () => {
  const { w, white } = await buybackWorld();
  const req = await ok(w.a, 'POST', `${API}/buybacks`, { variant_id: white, qty: 100 });
  await ok(w.full, 'POST', `${ADMIN}/buybacks/${req.buyback_id}/reject`, { note: 'not now' });
  const [b] = notices(w, 'buyback_rejected');
  assert.ok(b, 'the rejection notice was written');
  speaksEachLanguage(b, 'buyback_rejected');
  assert.equal((await owned(w.a, white)).available_qty, 250, 'the rejected grams are back');
  await reconcileClean(w);
});

test('c29: the low-material notice reads the variant and the unit in each language', async () => {
  const w = pcWorld();
  const cat = await seedCatalog(w);
  await buy(w.a, [{ kind: 'credit_package', package_id: cat.packages.h24 }, { kind: 'material', variant_id: cat.white, quantity: 250 }]);
  const { jobId } = await estimatedJob(w, w.a, cat, { seconds: H, materials: [{ variant_id: cat.white, model_grams: 200 }] });
  await runToPrinting(w, w.a, jobId);
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/complete`, { printed_seconds: H, materials: [{ variant_id: cat.white, qty: 200 }] });
  assert.equal((await owned(w.a, cat.white)).available_qty, 50);

  await w.db.batch([enqueueTask(w.db, { kind: 'low_inventory_scan', dedupeKey: 'i18n-scan', now: new Date() })]);
  await w.runTasks();
  const [low] = notices(w, 'inventory_low');
  assert.ok(low, 'the low-material notice was written');
  speaksEachLanguage(low, 'inventory_low', 50);
  await reconcileClean(w);
});
