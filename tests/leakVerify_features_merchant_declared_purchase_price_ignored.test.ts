/**
 * LEAK VERIFY (features) — a store owner who declared their printer's purchase
 * price is costed with NO wear and told they did not enter it.
 *
 * DECISIONS row 219 builds a merchant's costing from the merchant's own
 * figures: `priceForPrinter` (worker/routes/printQuote.ts) now hands the
 * engine `withoutOwnerEconomics(printer)`, whose `usefulPrintHours` is 0. The
 * depreciation rung for a merchant who declared a purchase price is still
 *
 *   machineIqdPerHour({ purchaseIqd: overrides.purchaseIqd, …,
 *                       usefulPrintHours: overrides.usefulPrintHours ?? printer.usefulPrintHours })
 *
 * so when the merchant left «عمرها بساعات الطباعة» blank — every economics
 * field is optional on «طابعاتي» (PrintersTab, merchantPrinters.ts) — the
 * hours fall to 0 and the declared purchase price is silently not charged
 * (machineIqdPerHour returns 0 without hours). Before this commit the model
 * card's useful life filled the gap, so the merchant's own price WAS charged.
 *
 * And the new costing notice (CostingTab PrinterCard, `data-costing-no-wear`)
 * keys on `because.machine_iqd_per_hour === 0` alone, so it tells exactly this
 * merchant «لم تُدخل سعر شراء هذه الطابعة» — "you did not enter this printer's
 * purchase price" — which they did.
 *
 * The same rung prices the workshop's request costing
 * (worker/routes/merchantWorkshop.ts), whose price becomes the merchant's
 * offer to a customer («استخدم هذا كعرضي»).
 *
 * Expected: a purchase price the merchant declared is either charged, or the
 * answer does not read as "no purchase price".
 *
 * FIXED (DECISIONS row 219, verification pass) the second way: the model
 * card's useful life is the OWNER's figure (purchase ÷ the rate charged would
 * hand it to the merchant), so it never fills the gap; instead the costing
 * answer says which of the merchant's own figures the wear still needs
 * (`because.wear_missing`: 'purchase' | 'useful_hours' | null) and the screen
 * asks for the useful life when the price is there. Declared both, the wear
 * is charged at the merchant's own purchase ÷ hours.
 *
 * LOCAL ONLY: in-memory SQLite with every migration, the real print-quote
 * router, the stub session of tests/fixtures/app.ts. No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, json, post, stubApp, type App, type Mount } from './fixtures/app';
import { printQuoteRoutes } from '../worker/routes/printQuote';

const MERCHANT_USER = { id: 'u-shop', role: 'merchant' as const, email: 'shop@x.co' };
/** What the merchant paid for their A1 mini — their own figure, typed on «طابعاتي». */
const DECLARED_PURCHASE = 1_000_000;
/** The canonical model's useful life (the owner filled the model card). */
const MODEL_HOURS = 5_000;

function shop(): DatabaseSync {
  const raw = freshDb();
  raw.prepare(`UPDATE printer_models SET useful_print_hours = ? WHERE id = 'bbl-a1m'`).run(MODEL_HOURS);
  raw
    .prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, 'Shop', 'x', 'merchant')`)
    .run(MERCHANT_USER.id, MERCHANT_USER.email);
  raw.prepare(`INSERT INTO community_merchants (id, user_id, name, status) VALUES ('m-shop', ?, 'Shop', 'approved')`).run(MERCHANT_USER.id);
  raw
    .prepare(`INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name) VALUES ('st-shop', 'm-shop', ?, 'shop-verify', 'Shop')`)
    .run(MERCHANT_USER.id);
  // The merchant's own A1 mini, linked to the canonical model: a purchase price, no useful life.
  raw
    .prepare(
      `INSERT INTO merchant_printers (id, merchant_id, name, technology, brand, model,
         build_x_mm, build_y_mm, build_z_mm, nozzle_mm, materials, model_id, purchase_iqd)
       VALUES ('mp-mini','m-shop','My A1 mini','fdm','Bambu','A1 mini',180,180,180,0.4,'["PLA"]','bbl-a1m', ?)`
    )
    .run(DECLARED_PURCHASE);
  return raw;
}

const bucket = { put: async () => ({}), get: async () => null, head: async () => null, delete: async () => undefined };
const mount: Mount = (a) => {
  a.route('/api/print-quote', printQuoteRoutes);
};
const merchant = (raw: DatabaseSync) => stubApp(asD1(raw), MERCHANT_USER, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });

function stlBytes(): Uint8Array {
  const S = 20;
  const v: Array<[number, number, number]> = [[0, 0, 0], [S, 0, 0], [S, S, 0], [0, S, 0], [0, 0, S], [S, 0, S], [S, S, S], [0, S, S]];
  const tris: Array<[number, number, number]> = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    o += 12;
    for (const i of [a, b, c]) {
      dv.setFloat32(o, v[i][0], true);
      dv.setFloat32(o + 4, v[i][1], true);
      dv.setFloat32(o + 8, v[i][2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

async function analysis(a: App): Promise<string> {
  const form = new FormData();
  form.append('file', new File([stlBytes()], 'bracket.stl', { type: 'application/octet-stream' }));
  const up = await json(await a.request('/api/print-quote/uploads', { method: 'POST', body: form }));
  assert.equal(up.success, true, JSON.stringify(up));
  const id = up.analysis_id as string;
  const analysed = await json(
    await post(a, `/api/print-quote/analyses/${id}`, {
      printer_model_id: 'bbl-a1m',
      stats: { filament_mm: 60_000, time_estimate: 14_400, layers: 200, model_layers: 200, raft_layers: 0 },
      tools: [{ slot: 0, material_id: 'pla', color_hex: '#000000' }],
      bounding_box_mm: { x: 100, y: 80, z: 40 },
      model_volume_mm3: 96_000,
      layer_height_mm: 0.2,
      preparation_minutes: 8,
      slicer_version: 'three-slicer@0.2.2',
      profile_revision: 'bbl-a1m-04-r1',
    })
  );
  assert.equal(analysed.success, true, JSON.stringify(analysed));
  return id;
}

test('/compare: a merchant who declared a purchase price but no useful life is asked for the life — never told the price is missing, never costed on the owner’s hours', async () => {
  const raw = shop();
  const a = merchant(raw);
  const id = await analysis(a);
  const body = await json(await post(a, `/api/print-quote/analyses/${id}/compare`, {}));
  assert.equal(body.success, true, JSON.stringify(body));
  const mini = (body.printers as Array<Record<string, unknown>>).find((p) => p.merchant_printer_id === 'mp-mini');
  assert.ok(mini && mini.eligible === true, `the merchant's printer was not priced: ${JSON.stringify(body.printers)}`);
  const because = mini.because as { machine_iqd_per_hour: number; machine_hours: number; wear_missing: string | null };
  // Never the owner's model card: 1,000,000 ÷ 5,000 h would be 200/h.
  assert.notEqual(because.machine_iqd_per_hour, Math.round(DECLARED_PURCHASE / MODEL_HOURS), 'the owner’s useful life priced the merchant’s wear');
  assert.equal(because.machine_iqd_per_hour, 0);
  assert.equal(because.wear_missing, 'useful_hours', JSON.stringify(because));

  // The screen asks for the life on exactly this answer, and keeps the «no purchase price» sentence for the other case.
  const costingTab = readFileSync(new URL('../src/components/merchant/dashboard/CostingTab.tsx', import.meta.url), 'utf8');
  assert.match(costingTab, /wear_missing === 'useful_hours' && \(\s*<p[^>]*data-costing-no-wear="useful_hours"/);
  assert.match(costingTab, /wear_missing !== 'useful_hours' && \(\s*<p[^>]*data-costing-no-wear="purchase"/);
});

test('/compare: the merchant’s own purchase price and useful life are charged as wear', async () => {
  const raw = shop();
  raw.prepare("UPDATE merchant_printers SET useful_print_hours = 2500 WHERE id = 'mp-mini'").run();
  const a = merchant(raw);
  const id = await analysis(a);
  const body = await json(await post(a, `/api/print-quote/analyses/${id}/compare`, {}));
  const mini = (body.printers as Array<Record<string, unknown>>).find((p) => p.merchant_printer_id === 'mp-mini')!;
  const because = mini.because as { machine_iqd_per_hour: number; wear_missing: string | null };
  assert.equal(because.machine_iqd_per_hour, Math.round(DECLARED_PURCHASE / 2500), 'the merchant’s own 1,000,000 over their own 2,500 h');
  assert.equal(because.wear_missing, null);
  const wear = (mini.lines as Array<{ component: string; iqd: number }>).find((l) => l.component === 'DEPRECIATION');
  assert.ok((wear?.iqd ?? 0) > 0, JSON.stringify(mini.lines));
});
