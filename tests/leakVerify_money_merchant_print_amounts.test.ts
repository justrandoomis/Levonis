/**
 * LEAK VERIFY (money) — the amounts a store owner reads and charges for print
 * work, for the SAME inputs, before and after DECISIONS row 220.
 *
 * Row 219 changed two merchant money paths in worker/routes/printQuote.ts:
 *
 *   1. The public calculators (/analyses/:id/quote, /grams-quote) now answer a
 *      store owner exactly like a guest: platform margin, platform figures,
 *      `merchantId: null`. Before, a store owner was priced on their own
 *      spool and could name their margin. (Disclosed as «changed approach».)
 *
 *   2. `priceForPrinter` with a merchant id (/analyses/:id/compare and the
 *      workshop's request costing, merchantWorkshop.ts — whose price becomes
 *      the merchant's OFFER to a customer, «استخدم هذا كعرضي») now strips the
 *      model card's economics (`withoutOwnerEconomics`: purchase, residual,
 *      useful hours, maintenance, baseline success rate), charges no machine
 *      hour where the merchant declared none (was the owner's platform rate),
 *      no maintenance (was the model card's), and drops the platform's
 *      per-kilo default (`loadMaterialPrices(..., { platformDefaults: false })`).
 *      The port report's «Changed approach» section does not list this one.
 *
 * Both are the STATED policy of row 220 (listed in its «changed approach»
 * after this verification): a merchant's numbers come from the merchant's own
 * figures and public constants only, never from the owner's machine-hour
 * rate, model card or per-kilo price, and the platform's calculators answer
 * every caller with the platform's public quote. The figures this test
 * measured on base 10c6541a, kept for the owner's review:
 *
 *   1. own spool, public file calculator: base 5,909 IQD (own spool) and
 *      9,603 IQD at a named 60 % → now the platform's 7,202 IQD for both;
 *   2. own A1 mini with no economics declared, own spool, /compare: base
 *      5,909 IQD with the owner's platform machine hour (1,200 IQD/h) → now
 *      3,971 IQD (−32.8 %), no machine hour, the default 0.9 success rate.
 *
 * The tests below pin the policy itself (who is priced on what), not those
 * amounts.
 *
 * LOCAL ONLY: in-memory SQLite with every migration, the real print-quote
 * router, a stub session (tests/fixtures/app.ts). No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, post, stubApp, type App } from './fixtures/app';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import type { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';

const mount = (a: Hono<AppContext>) => a.route('/api/print-quote', printQuoteRoutes);
type Raw = ReturnType<typeof freshDb>;
const MERCHANT = { id: 'u-shop', role: 'merchant' as const, email: 'shop@levonis.test' };
const CUSTOMER = { id: 'u-cust', role: 'customer' as const, email: 'cust@levonis.test' };

function seed(): Raw {
  const raw = freshDb();
  for (const [id, role] of [['u-shop', 'merchant'], ['u-cust', 'customer']] as const) {
    raw.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, 'x', ?)`).run(id, `${id}@levonis.test`, id, role);
  }
  raw.prepare(`INSERT INTO community_merchants (id, user_id, name, status) VALUES ('m-shop','u-shop','Shop','approved')`).run();
  raw.prepare(`INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name) VALUES ('st-shop','m-shop','u-shop','shop','Shop')`).run();
  // The platform's own per-kilo price for PLA (owner data) — what an
  // undeclared spool fell back to before row 220.
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  return raw;
}


/** The merchant's own analysis of one job: 100 g of PLA, 60 minutes on an A1 mini (as costPublicChannels.test.ts seeds it). */
async function merchantAnalysis(raw: Raw): Promise<{ app: App; id: string }> {
  raw.exec("INSERT INTO print_analyses (id,owner_id,file_sha256,fingerprint,printer_model_id,print_minutes_per_plate) VALUES ('pa-shop','u-shop','sha-shop','fp-shop','bbl-a1m',60)");
  raw.exec("INSERT INTO print_analysis_materials (id,analysis_id,material_id,material_type,model_grams) VALUES ('pam-shop','pa-shop','pla','PLA',100)");
  return { app: stubApp(asD1(raw), MERCHANT, mount), id: 'pa-shop' };
}

test('a store owner on the public file calculator reads the platform’s own price — their spool and a named margin change nothing', async () => {
  const raw = seed();
  raw.prepare(`INSERT INTO merchant_spools (id, merchant_id, material_id, purchase_iqd, original_grams) VALUES ('sp-1','m-shop','pla', 14000, 1000)`).run();
  const { app, id } = await merchantAnalysis(raw);
  const plain = await json(await post(app, `/api/print-quote/analyses/${id}/quote`, {}));
  const named = await json(await post(app, `/api/print-quote/analyses/${id}/quote`, { target_margin_percent: 60 }));
  assert.equal(plain.success, true, JSON.stringify(plain));
  assert.equal(named.success, true, JSON.stringify(named));
  // The same job, quoted to a plain customer — the platform price.
  raw.prepare(`UPDATE print_analyses SET owner_id = 'u-cust' WHERE id = ?`).run(id);
  const cust = await json(await post(stubApp(asD1(raw), CUSTOMER, mount), `/api/print-quote/analyses/${id}/quote`, {}));
  assert.equal(plain.quote.price_iqd, cust.quote.price_iqd, 'the store owner reads the customer’s price');
  assert.equal(named.quote.price_iqd, cust.quote.price_iqd, 'a named margin does not turn the public door into a cost oracle');
});

test('a store owner’s costing of their own A1 mini is built from their own figures: no economics declared → no wear, and the screen is told which figure is missing', async () => {
  const raw = seed();
  raw.prepare(
    `INSERT INTO merchant_printers (id, merchant_id, name, technology, brand, model,
       build_x_mm, build_y_mm, build_z_mm, nozzle_mm, materials, model_id)
     VALUES ('mp-mini','m-shop','My A1 mini','fdm','Bambu','A1 mini',180,180,180,0.4,'["PLA"]','bbl-a1m')`
  ).run();
  raw.prepare(`INSERT INTO merchant_spools (id, merchant_id, material_id, purchase_iqd, original_grams) VALUES ('sp-1','m-shop','pla', 14000, 1000)`).run();
  const { app, id } = await merchantAnalysis(raw);
  const compared = await json(await post(app, `/api/print-quote/analyses/${id}/compare`, {}));
  assert.equal(compared.success, true, JSON.stringify(compared));
  const mini = compared.printers.find((p: Record<string, unknown>) => p.merchant_printer_id === 'mp-mini');
  assert.ok(mini.eligible, JSON.stringify(mini));
  assert.equal(mini.because.machine_iqd_per_hour, 0, 'never the owner’s platform machine-hour rate');
  assert.equal(mini.because.wear_missing, 'purchase');
  const lines = (mini.lines ?? []) as Array<{ component: string; from?: string }>;
  assert.equal(lines.some((l) => l.component === 'DEPRECIATION'), false, JSON.stringify(lines));
  // The material line is the merchant's own spool, not the platform's per-kilo default.
  assert.ok(lines.filter((l) => /MATERIAL/.test(l.component)).every((l) => l.from !== 'platform'), JSON.stringify(lines));
});
