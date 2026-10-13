/**
 * LEAK AUDIT — customer-api: the public print estimates are an ORACLE for the
 * private target margin and for the job's full cost (true cost / break-even).
 *
 * The owner's rule: anyone other than the main admin / super admin gets ONLY the
 * final price — «لا يتسرب تكلفه او عمليه حسابيه نهائيا». Both print engines strip
 * the cost on purpose before a customer reads them:
 *
 *   Engine B  publicQuote (worker/routes/printQuote.ts) — «not one line of what
 *             it cost the shop»: no lines, no true_cost_iqd, no break_even_iqd,
 *             no margin_percent. Margin = PLATFORM_TARGET_MARGIN_PERCENT.
 *   Engine A  POST /api/marketplace/print/quote drops cost_iqd, floor_iqd,
 *             margin_percent, cost_lines. Margin = printPricingConfig
 *             .target_margin_percent, an OWNER-ONLY cost setting
 *             (COST_SETTING_KEYS in worker/routes/admin.ts).
 *
 * But the caller chooses the hardware and its counts (up to 500 of each), the
 * hardware's per-piece cost is published (GET /api/print-quote/accessories,
 * GET /api/marketplace/print/catalog, and the grams door echoes
 * `accessories_iqd`), and both engines add the hardware to the cost BEFORE the
 * margin and OUTSIDE the failure reserve. So with two quotes of the same job —
 * without and with a known hardware basket H:
 *
 *     price = cost / (1 − m)   ⇒   m = 1 − H / (price_with − price_without)
 *                                  cost = price_without × (1 − m)
 *
 * which hands a guest (Engine B) and any signed-in customer (Engine A) the very
 * margin and true cost the strip was written to hide. The grams door also takes
 * caller-chosen grams and print minutes, so the per-gram and per-hour COST of
 * the job follow the same way.
 *
 * Every figure the "attacker" side of these tests uses comes from a public
 * answer of the real route modules. The private reference values come from the
 * owner's own write path / the merchant view of the same engine (Engine B) and
 * the pure engine with the route's own settings (Engine A).
 *
 * LOCAL ONLY: an in-memory SQLite database with every migration, the real route
 * modules, the stub session of tests/fixtures/app.ts. No network.
 *
 * Run: node --import tsx --test tests/leakAudit_customer-api_print_estimate_margin_and_cost_oracle.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, freshDb, get, json, post, put, stubApp, type Mount, type StubUser } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import type { Context } from 'hono';
import {
  analysisFromGrams,
  platformMachineHourIqd,
  platformMinimumJobIqd,
  priceForPrinter,
  printQuoteRoutes,
  PLATFORM_TARGET_MARGIN_PERCENT,
} from '../worker/routes/printQuote';
import { loadMaterialPhysics, printerModelFromRow } from '../worker/lib/printQuote/repository';
import type { AppContext } from '../worker/lib/types';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { adminRoutes } from '../worker/routes/admin';
import { DEFAULT_PRICING, quotePrint, type PrintMaterial, type PrintPricingConfig } from '../worker/lib/printPricing';
import { getSetting } from '../worker/lib/settings';
import type { PrintAccessory } from '../worker/lib/printAccessories';

/** The owner's private Engine A margin — a figure no default or price here equals. */
const OWNER_MARGIN_PERCENT = 37.3;

const bucket = { put: async () => ({}), get: async () => null, head: async () => null, delete: async () => undefined };
const ENV = { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket };

const mount: Mount = (a) => {
  a.route('/api/print-quote', printQuoteRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/admin', adminRoutes);
};

const CUSTOMER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };

/**
 * A shop that has filled in its numbers (the same figures
 * tests/printQuoteGrams.test.ts uses), the default hardware catalogue, and an
 * OWNER who set their own Engine A margin through the owner-only write path.
 */
async function shop(): Promise<DatabaseSync> {
  const raw = freshDb();
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  raw
    .prepare(
      `UPDATE printer_models
          SET purchase_iqd = 900000, residual_iqd = 100000, useful_print_hours = 4000,
              maintenance_iqd_per_hour = 150, printing_watts = 110,
              bed_heating_watts = 350, nozzle_heating_watts = 60
        WHERE id = 'bbl-a1m'`
    )
    .run();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'),
      ('u-merchant','Shop','merchant@x.co','h','merchant');
    INSERT INTO community_merchants (id, user_id, name, status) VALUES ('m-1','u-merchant','Shop','approved');
    INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name) VALUES ('st-m-1','m-1','u-merchant','shop-m-1','Shop');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  const res = await put(stubApp(asD1(raw), OWNER, mount, { env: ENV }), '/api/admin/settings/printPricingConfig', {
    value: { ...DEFAULT_PRICING, target_margin_percent: OWNER_MARGIN_PERCENT },
  });
  assert.equal(res.status, 200, `the owner could not set the print margin: ${JSON.stringify(await json(res))}`);
  const cfg = await getSetting(asD1(raw), 'printPricingConfig');
  assert.equal(cfg.target_margin_percent, OWNER_MARGIN_PERCENT, 'the owner write did not store the margin');
  return raw;
}

const anonymous = (raw: DatabaseSync) => stubApp(asD1(raw), null, mount, { env: ENV });
const as = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, mount, { env: ENV });

/**
 * THE ATTACKER'S PROBE, built only from a public catalogue answer: the three
 * costliest accessories, 500 of each (the engines' own cap). Null when the
 * catalogue publishes no per-piece cost — then no known-cost probe exists.
 */
function probeFrom(catalogue: Array<{ id: string; cost_iqd?: unknown }>) {
  const priced = catalogue
    .filter((a) => typeof a.cost_iqd === 'number' && (a.cost_iqd as number) > 0)
    .sort((a, b) => (b.cost_iqd as number) - (a.cost_iqd as number))
    .slice(0, 3);
  if (!priced.length) return null;
  const selection = priced.map((a) => ({ id: a.id, qty: 500 }));
  const hardwareIqd = priced.reduce((n, a) => n + (a.cost_iqd as number) * 500, 0);
  return { selection, hardwareIqd };
}

/** m and the job cost, from two public prices and a known hardware delta. */
function derive(priceWithout: number, priceWith: number, hardwareIqd: number) {
  const m = 1 - hardwareIqd / (priceWith - priceWithout);
  return { marginPercent: m * 100, cost: priceWithout * (1 - m), m };
}

// ------------------------------------------------------------------ Engine B

const GRAMS_JOB = {
  printer_model_id: 'bbl-a1m',
  rows: [{ material_id: 'pla', grams: 100, color_hex: '#000000' }],
  print_minutes: 180,
};

/**
 * THE PRIVATE REFERENCE for a grams job: the platform's own pricing assembly
 * (`priceForPrinter`, no merchant, the platform margin) on the route's own
 * settings — what the door prices every caller at. It used to be read off a
 * store owner's answer of the same door, which carried the platform's whole
 * cost chain; that door answers everyone the public shape now (DECISIONS row
 * 219), so the reference is computed here and checked to give the door's price.
 */
async function privateGrams(raw: DatabaseSync, body: typeof GRAMS_JOB) {
  const db = asD1(raw);
  const modelRow = raw.prepare('SELECT * FROM printer_models WHERE id = ?').get(body.printer_model_id) as Record<string, unknown>;
  const printer = printerModelFromRow(modelRow);
  const physics = await loadMaterialPhysics(db, body.rows.map((r) => r.material_id));
  const rows = body.rows.map((r) => ({
    materialId: r.material_id,
    materialType: physics[r.material_id]!.materialType,
    colorHex: r.color_hex,
    densityGPerCm3: physics[r.material_id]!.densityGPerCm3,
    grams: r.grams,
  }));
  const fakeCtx = { env: { DB: db } } as unknown as Context<AppContext>;
  const ref = await priceForPrinter(fakeCtx, {
    analysis: analysisFromGrams({ printer, rows, printMinutes: body.print_minutes }),
    printer,
    merchantId: null,
    merchantPrinter: null,
    quantity: 1,
    targetMarginPercent: PLATFORM_TARGET_MARGIN_PERCENT,
    minimumJobIqd: await platformMinimumJobIqd(db),
    platformMachineHourIqd: await platformMachineHourIqd(db, printer.technology),
  });
  return { price_iqd: ref.result.recommendedPriceIqd, true_cost_iqd: ref.result.trueExpectedCostIqd };
}

async function gramsQuote(app: ReturnType<typeof anonymous>, body: Record<string, unknown>) {
  const res = await post(app, '/api/print-quote/grams-quote', body);
  const out = await json(res);
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.success, true, JSON.stringify(out));
  return out;
}

test('anonymous grams-quote: two public estimates give away the platform margin and the true cost of the job', async () => {
  const raw = await shop();
  const guest = anonymous(raw);

  // 1. Public: the hardware catalogue.
  const catRes = await get(guest, '/api/print-quote/accessories');
  assert.equal(catRes.status, 200);
  const catalogue = (await json(catRes)).accessories as Array<{ id: string; cost_iqd?: unknown }>;
  const probe = probeFrom(catalogue);

  // 2. Public: the same job without and with the hardware basket.
  const plain = await gramsQuote(guest, GRAMS_JOB);
  const P0 = Number(plain.quote?.price_iqd);
  assert.ok(P0 > 0, `no final price: ${JSON.stringify(plain.quote)}`);
  // The strip is real: the guest's quote names no cost and no margin directly.
  for (const k of ['true_cost_iqd', 'break_even_iqd', 'margin_percent', 'profit_iqd', 'lines', 'base_cost_iqd']) {
    assert.equal(k in (plain.quote ?? {}), false, `publicQuote carries ${k} directly — a different (direct) leak`);
  }

  // The private reference: the platform's own pricing assembly for the same
  // job, checked to be the very same price the door quoted.
  const reference = await privateGrams(raw, GRAMS_JOB);
  assert.equal(reference.price_iqd, P0, 'the private reference is not the same job, so it proves nothing');
  const trueCost = Number(reference.true_cost_iqd);
  assert.ok(trueCost > 0, `no private true cost: ${JSON.stringify(reference)}`);

  const found: string[] = [];
  if (probe) {
    const withHw = await gramsQuote(guest, { ...GRAMS_JOB, accessories: probe.selection });
    // The hardware really reached the engine (otherwise the path is not exercised).
    assert.ok(Number(withHw.quote?.price_iqd) > P0, `the hardware never moved the price: ${JSON.stringify(withHw.quote)}`);
    // The attacker prefers the route's own echo of the hardware total, else the catalogue.
    const H = typeof withHw.accessories_iqd === 'number' && withHw.accessories_iqd > 0 ? withHw.accessories_iqd : probe.hardwareIqd;
    const d = derive(P0, Number(withHw.quote.price_iqd), H);

    if (Math.abs(d.marginPercent - PLATFORM_TARGET_MARGIN_PERCENT) < 0.05) {
      found.push(`target margin derived = ${d.marginPercent.toFixed(4)}% (private: ${PLATFORM_TARGET_MARGIN_PERCENT}%)`);
    }
    if (Math.abs(d.cost - trueCost) <= 2) {
      found.push(`true cost / break-even derived = ${d.cost.toFixed(1)} IQD (private true_cost_iqd: ${trueCost})`);
    }
  }
  const scanner = [...leaks(plain.quote), ...leaks(plain.quote, { numbers: [trueCost] })];
  assert.deepEqual(
    found,
    [],
    `anonymous POST /api/print-quote/grams-quote is an oracle for private pricing values ` +
      `(price_without=${P0}, the hardware probe from the public catalogue): ${found.join('; ')}. ` +
      `The shared leak scanner flags nothing in the public quote: ${JSON.stringify(scanner)}`
  );
});

test('anonymous grams-quote: free grams and print minutes give the private per-gram and per-hour COST of the job', async () => {
  const raw = await shop();
  const guest = anonymous(raw);

  const catalogue = (await json(await get(guest, '/api/print-quote/accessories'))).accessories as Array<{ id: string; cost_iqd?: unknown }>;
  const probe = probeFrom(catalogue);

  const base = await gramsQuote(guest, GRAMS_JOB);
  const moreGrams = { ...GRAMS_JOB, rows: [{ material_id: 'pla', grams: 200, color_hex: '#000000' }] };
  const moreHours = { ...GRAMS_JOB, print_minutes: 300 };
  const g = await gramsQuote(guest, moreGrams);
  const h = await gramsQuote(guest, moreHours);

  // Private: the true cost of each of the three jobs (the platform's own assembly, same price).
  const tc: number[] = [];
  for (const [body, pub] of [[GRAMS_JOB, base], [moreGrams, g], [moreHours, h]] as const) {
    const ref = await privateGrams(raw, body);
    assert.equal(ref.price_iqd, pub.quote.price_iqd, 'the private reference is not the same job');
    tc.push(Number(ref.true_cost_iqd));
  }
  const privatePerGram = (tc[1] - tc[0]) / 100;
  const privatePerHour = (tc[2] - tc[0]) / 2;
  assert.ok(privatePerGram > 0 && privatePerHour > 0, 'grams and minutes do not move the cost, so the path is not exercised');

  const found: string[] = [];
  if (probe) {
    const withHw = await gramsQuote(guest, { ...GRAMS_JOB, accessories: probe.selection });
    const H = typeof withHw.accessories_iqd === 'number' && withHw.accessories_iqd > 0 ? withHw.accessories_iqd : probe.hardwareIqd;
    const { m } = derive(Number(base.quote.price_iqd), Number(withHw.quote.price_iqd), H);
    const perGram = ((Number(g.quote.price_iqd) - Number(base.quote.price_iqd)) * (1 - m)) / 100;
    const perHour = ((Number(h.quote.price_iqd) - Number(base.quote.price_iqd)) * (1 - m)) / 2;
    if (Math.abs(perGram - privatePerGram) <= 0.05) {
      found.push(`cost per gram derived = ${perGram.toFixed(3)} IQD (private: ${privatePerGram.toFixed(3)})`);
    }
    if (Math.abs(perHour - privatePerHour) <= 2) {
      found.push(`cost per machine hour derived = ${perHour.toFixed(1)} IQD (private: ${privatePerHour.toFixed(1)})`);
    }
  }
  assert.deepEqual(
    found,
    [],
    `anonymous POST /api/print-quote/grams-quote gives away the job's private cost slopes: ${found.join('; ')}`
  );
});

// ------------------------------------------------------------------ Engine A

const WIZARD_JOB = { process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1, volume_cm3: 40 };

test("customer POST /api/marketplace/print/quote: two public estimates give away the OWNER's margin and the job's cost", async () => {
  const raw = await shop();
  const customer = as(raw, CUSTOMER);

  // 1. Public: the wizard's catalogue (anonymous, edge-cached).
  const catRes = await get(anonymous(raw), '/api/marketplace/print/catalog');
  assert.equal(catRes.status, 200);
  const probe = probeFrom((await json(catRes)).accessories as Array<{ id: string; cost_iqd?: unknown }>);

  // 2. The customer's two estimates.
  const r0 = await post(customer, '/api/marketplace/print/quote', WIZARD_JOB);
  const plain = await json(r0);
  assert.equal(r0.status, 200, JSON.stringify(plain));
  assert.equal(plain.quote?.priced, true, JSON.stringify(plain));
  const P0 = Number(plain.quote.price_iqd);
  for (const k of ['cost_iqd', 'floor_iqd', 'margin_percent', 'cost_lines']) {
    assert.equal(k in plain.quote, false, `the public quote carries ${k} directly — a different (direct) leak`);
  }

  // The private reference: the pure engine on the route's own settings, checked
  // to reproduce the route's price to the dinar.
  const db = asD1(raw);
  const cfg = (await getSetting(db, 'printPricingConfig')) as PrintPricingConfig;
  const mats = (await getSetting(db, 'printMaterials')) as PrintMaterial[];
  const accs = ((await getSetting(db, 'printAccessories')) as PrintAccessory[]).filter((a) => a && a.active !== false);
  const engine = (accessories: Array<{ id: string; qty: number }>) =>
    quotePrint(
      {
        analysis: null,
        materialId: 'pla',
        quality: 'standard',
        infill: 0.2,
        quantity: 1,
        colors: 1,
        supports: true,
        post_processing_minutes: 0,
        accessories,
        accessory_catalogue: accs,
        fallback_volume_cm3: WIZARD_JOB.volume_cm3,
      },
      mats,
      cfg
    );
  const privateQuote = engine([]);
  assert.equal(privateQuote.price_iqd, P0, 'the private reference is not the route\'s job, so it proves nothing');
  assert.equal(cfg.target_margin_percent, OWNER_MARGIN_PERCENT);

  const found: string[] = [];
  if (probe) {
    const r1 = await post(customer, '/api/marketplace/print/quote', { ...WIZARD_JOB, accessories: probe.selection });
    const withHw = await json(r1);
    assert.equal(r1.status, 200, JSON.stringify(withHw));
    const P1 = Number(withHw.quote?.price_iqd);
    assert.ok(P1 > P0, `the hardware never moved the price: ${JSON.stringify(withHw.quote)}`);
    assert.equal(engine(probe.selection).price_iqd, P1, 'the private reference does not reproduce the hardware quote');
    const d = derive(P0, P1, probe.hardwareIqd);

    if (Math.abs(d.marginPercent - OWNER_MARGIN_PERCENT) < 0.05) {
      found.push(`owner's target_margin_percent derived = ${d.marginPercent.toFixed(4)}% (private: ${OWNER_MARGIN_PERCENT}%)`);
    }
    // Within the price's own rounding step (round_to_iqd): as exact as the public price allows.
    if (Math.abs(d.cost - privateQuote.cost_iqd) <= cfg.round_to_iqd) {
      found.push(`job cost derived = ${d.cost.toFixed(0)} IQD (private cost_iqd: ${privateQuote.cost_iqd}, round_to_iqd ${cfg.round_to_iqd})`);
    }
  }
  const scanner = [...leaks(plain), ...leaks(plain, { numbers: [privateQuote.cost_iqd] })];
  assert.deepEqual(
    found,
    [],
    `signed-in customer POST /api/marketplace/print/quote is an oracle for the owner's private print pricing ` +
      `(price_without=${P0}, the hardware probe from the public catalogue): ${found.join('; ')}. ` +
      `The shared leak scanner flags nothing in the public answer: ${JSON.stringify(scanner)}`
  );
});
