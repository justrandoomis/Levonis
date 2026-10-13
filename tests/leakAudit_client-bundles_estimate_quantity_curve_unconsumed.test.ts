/**
 * LEAK AUDIT — client-bundles: `estimate.quantity_curve` hands every guest and
 * customer the print job's COST STRUCTURE (fixed per-job cost vs per-copy cost),
 * and no screen ever renders it.
 *
 * The owner's rule: anyone other than the main admin / super admin gets ONLY the
 * final price — «لا يتسرب تكلفه او عمليه حسابيه نهائيا». The file calculator's
 * public quote (POST /api/print-quote/analyses/:id/quote, Engine B) strips every
 * cost line on purpose (`publicQuote`: «not one line of what it cost the shop»).
 * But the same answer carries `estimate.quantity_curve` (worker/routes/
 * printQuote.ts → `fromEngineB(..., { curve: quantityCurve(quantity, (qty) =>
 * engineBUnitPriceAt(priced.pricing, qty)) })`): the per-copy price at 1, 2, 5
 * and 10 copies, each a PURE RE-RUN of `priceJob` on the private inputs.
 *
 *   - The route pins `quantity` to 1, so these are prices the caller cannot ask
 *     the route for; they exist only to be re-derived from.
 *   - `priceJob` is linear in the copy count: the prep labour (LABOR) and the
 *     restart part of the failure reserve are paid once per job, everything
 *     else per copy. So total(q) = unit(q)·q = (F + V·q)/(1 − m):
 *       slope     = V/(1 − m)  — the per-copy cost, priced
 *       intercept = F/(1 − m)  — the fixed per-job (setup labour) cost, priced
 *       intercept/(intercept + slope) = F/(F + V) — the FIXED SHARE OF THE COST,
 *       a cost-derived ratio, with no margin needed at all.
 *   - With m from the public accessory delta (the hardware's per-piece cost is
 *     published by GET /api/print-quote/accessories and is added before the
 *     margin, outside the failure reserve), F and V come out in dinars.
 *   - NO CONSUMER: nothing under src/ reads `quantity_curve` beyond the type
 *     declaration (src/lib/printEstimate.ts), so the browser receives the curve
 *     on every quote and throws it away.
 *   - GUARD GAP: `unit_iqd` is not cost-named, so tests/fixtures/costlyProduct.ts
 *     `leaks()` never flags it, and the sentinels never enter a print quote.
 *
 * The private reference is the real `priceForPrinter` on the same analysis with
 * the route's own settings (checked to reproduce the route's price and every
 * curve point to the dinar), re-run through the pure `priceJob` at 1, 2, 5, 10.
 *
 * LOCAL ONLY: an in-memory SQLite database with every migration, the real route
 * modules, stub R2 buckets, the stub session of tests/fixtures/app.ts. No network.
 *
 * Run: node --import tsx --test tests/leakAudit_client-bundles_estimate_quantity_curve_unconsumed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Context } from 'hono';
import { asD1, freshDb, get, json, post, stubApp, type App, type Mount, type StubUser } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import {
  printQuoteRoutes,
  priceForPrinter,
  platformMachineHourIqd,
  platformMinimumJobIqd,
  PLATFORM_TARGET_MARGIN_PERCENT,
} from '../worker/routes/printQuote';
import { loadAnalysis, printerModelFromRow } from '../worker/lib/printQuote/repository';
import { priceJob } from '../worker/lib/printQuote/cost';
import type { AppContext } from '../worker/lib/types';

const ROOT = join(import.meta.dirname, '..');

const bucket = { put: async () => ({}), get: async () => null, head: async () => null, delete: async () => undefined };
const ENV = { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket };
const mount: Mount = (a) => {
  a.route('/api/print-quote', printQuoteRoutes);
};

const CUSTOMER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };

/** A real binary STL of a 20 mm cube (same as tests/printQuoteRoutes.test.ts). */
function stlBytes(): Uint8Array {
  const S = 20;
  const v: Array<[number, number, number]> = [
    [0, 0, 0], [S, 0, 0], [S, S, 0], [0, S, 0],
    [0, 0, S], [S, 0, S], [S, S, S], [0, S, S],
  ];
  const tris: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
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

/** The slicer measurement the browser posts (tests/printQuoteRoutes.test.ts). */
const ANALYSE_BODY = {
  printer_model_id: 'bbl-a1m',
  stats: { filament_mm: 60_000, time_estimate: 14_400, layers: 200, model_layers: 200, raft_layers: 0 },
  tools: [{ slot: 0, material_id: 'pla', color_hex: '#000000' }],
  bounding_box_mm: { x: 100, y: 80, z: 40 },
  model_volume_mm3: 96_000,
  layer_height_mm: 0.2,
  preparation_minutes: 8,
  slicer_version: 'three-slicer@0.2.2',
  profile_revision: 'bbl-a1m-04-r1',
};

/** A shop that has filled in its numbers (same figures as tests/printQuoteGrams.test.ts). */
function shop(): DatabaseSync {
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
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','buyer@x.co','h','customer');`);
  return raw;
}

/** The actor uploads a model and posts its slicer measurement — the calculator's own flow. */
async function analysedJob(a: App, guestToken: string | null): Promise<{ id: string; h: Record<string, string> }> {
  const form = new FormData();
  form.append('file', new File([stlBytes()], 'bracket.stl', { type: 'application/octet-stream' }));
  if (guestToken) form.append('guest_token', guestToken);
  const up = await a.request('/api/print-quote/uploads', { method: 'POST', body: form });
  const upBody = await json(up);
  assert.ok(upBody.analysis_id, `upload failed ${up.status}: ${JSON.stringify(upBody)}`);
  const id = String(upBody.analysis_id);
  const h: Record<string, string> = guestToken ? { 'X-Guest-Token': guestToken } : {};
  const analysed = await json(await post(a, `/api/print-quote/analyses/${id}`, ANALYSE_BODY, h));
  assert.equal(analysed.success, true, JSON.stringify(analysed));
  return { id, h };
}

/** Ordinary least squares y = a + b·x. */
function fit(points: Array<[number, number]>) {
  const n = points.length;
  const sx = points.reduce((s, [x]) => s + x, 0);
  const sy = points.reduce((s, [, y]) => s + y, 0);
  const sxx = points.reduce((s, [x]) => s + x * x, 0);
  const sxy = points.reduce((s, [x, y]) => s + x * y, 0);
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const a = (sy - b * sx) / n;
  return { intercept: a, slope: b };
}

/** Files under src/ that name `quantity_curve` (the type file excepted). */
function clientConsumers(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(name) && readFileSync(p, 'utf8').includes('quantity_curve')) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, 'src'));
  return out.filter((f) => f !== join('src', 'lib', 'printEstimate.ts'));
}

const ACTORS: Array<{ label: string; user: StubUser | null; token: string | null }> = [
  { label: 'anonymous visitor (guest token)', user: null, token: 'tok-guest-curve' },
  { label: 'signed-in customer', user: CUSTOMER, token: null },
];

for (const actor of ACTORS) {
  test(`${actor.label}: estimate.quantity_curve on POST /api/print-quote/analyses/:id/quote gives away the job's fixed and per-copy COST`, async () => {
    const raw = shop();
    const db = asD1(raw);
    const app = stubApp(db, actor.user, mount, { env: ENV });
    const { id, h } = await analysedJob(app, actor.token);

    // ---------------------------------------------------------- the attacker
    // 1. The public quote, exactly as the calculator screen receives it.
    const res = await post(app, `/api/print-quote/analyses/${id}/quote`, {}, h);
    const plain = await json(res);
    assert.equal(res.status, 200, JSON.stringify(plain));
    const P0 = Number(plain.quote?.price_iqd);
    assert.ok(P0 > 0, `no final price: ${JSON.stringify(plain.quote)}`);
    // The strip is real: the quote itself names no cost line.
    for (const k of ['lines', 'true_cost_iqd', 'base_cost_iqd', 'break_even_iqd', 'margin_percent', 'profit_iqd']) {
      assert.equal(k in plain.quote, false, `publicQuote carries ${k} directly — a different (direct) leak`);
    }
    // The estimate is there (the path is exercised) — and, since DECISIONS row
    // 219, without a quantity curve: re-runs of the engine at other copy counts
    // are exactly what this file proves gives the cost split away.
    assert.ok(plain.estimate && plain.estimate.priced === true, `no estimate reached the ${actor.label}: ${JSON.stringify(plain.estimate)}`);
    assert.equal(plain.estimate.quantity, 1, 'the route pins the copy count to 1');
    const curve = (plain.estimate?.quantity_curve ?? []) as Array<{ qty: number; unit_iqd: number }>;
    if (curve.length) assert.equal(curve.find((p) => p.qty === 1)?.unit_iqd, P0, 'the curve at ×1 is the quoted price');

    // 2. From the curve ALONE (when one is served): total(q) = unit(q)·q = I + S·q (priced).
    const { intercept: I, slope: S } =
      curve.length >= 2 ? fit(curve.map((p) => [p.qty, p.unit_iqd * p.qty] as [number, number])) : { intercept: NaN, slope: NaN };
    const fixedShare = I / (I + S); // F/(F+V): the margin cancels

    // 3. The margin, from the public hardware catalogue (per-piece cost_iqd) and
    //    one more quote of the same job with a hardware basket.
    const catalogue = (await json(await get(app, '/api/print-quote/accessories'))).accessories as Array<{
      id: string;
      cost_iqd?: unknown;
    }>;
    const priced = catalogue
      .filter((x) => typeof x.cost_iqd === 'number' && (x.cost_iqd as number) > 0)
      .sort((x, y) => (y.cost_iqd as number) - (x.cost_iqd as number))
      .slice(0, 3);
    let m: number | null = null;
    if (priced.length) {
      const selection = priced.map((x) => ({ id: x.id, qty: 500 }));
      const H = priced.reduce((n, x) => n + (x.cost_iqd as number) * 500, 0);
      const withHw = await json(await post(app, `/api/print-quote/analyses/${id}/quote`, { accessories: selection }, h));
      const P1 = Number(withHw.quote?.price_iqd);
      assert.ok(P1 > P0, `the hardware never moved the price: ${JSON.stringify(withHw.quote)}`);
      m = 1 - H / (P1 - P0);
    }
    const derivedFixed = m === null ? null : I * (1 - m);
    const derivedPerCopy = m === null ? null : S * (1 - m);

    // ------------------------------------------------- the private reference
    // The real pricing assembly on the same analysis with the route's settings.
    const loaded = await loadAnalysis(db, id);
    assert.ok(loaded, 'the analysis was not stored');
    const modelRow = raw.prepare(`SELECT * FROM printer_models WHERE id = 'bbl-a1m'`).get() as Record<string, unknown>;
    const printer = printerModelFromRow(modelRow);
    const fakeCtx = { env: { DB: db } } as unknown as Context<AppContext>;
    const ref = await priceForPrinter(fakeCtx, {
      analysis: loaded!.analysis,
      printer,
      merchantId: null,
      merchantPrinter: null,
      quantity: 1,
      targetMarginPercent: PLATFORM_TARGET_MARGIN_PERCENT,
      minimumJobIqd: await platformMinimumJobIqd(db),
      platformMachineHourIqd: await platformMachineHourIqd(db, printer.technology),
    });
    assert.equal(ref.result.recommendedPriceIqd, P0, "the private reference is not the route's job, so it proves nothing");
    const trueCost = new Map<number, number>();
    // The reference's own curve at 1, 2, 5, 10 copies (what the route used to serve), checked
    // against any curve the route still serves.
    for (const qty of [1, 2, 5, 10]) {
      const r = priceJob({ ...ref.pricing, quantity: qty });
      const served = curve.find((p) => p.qty === qty);
      if (served) assert.equal(Math.round(r.recommendedPriceIqd / qty), served.unit_iqd, `the reference does not reproduce the curve at ×${qty}`);
      trueCost.set(qty, r.trueExpectedCostIqd);
    }
    const priv = fit([...trueCost].map(([q, c]) => [q, c] as [number, number]));
    const privateFixed = priv.intercept; // LABOR (prep) + restart provision of the failure reserve
    const privatePerCopy = priv.slope; // material + machine + post, with their failure provision
    const privateShare = privateFixed / (privateFixed + privatePerCopy);
    // The same fixed cost, named from the private engine inputs.
    const labourLine = ref.result.lines.find((l) => l.component === 'LABOR')?.iqd ?? 0;
    const p = ref.pricing.risk.successRate.value;
    const namedFixed = labourLine + (1 / p - 1) * (10 / 60) * ref.pricing.laborIqdPerHour.value;
    assert.ok(labourLine > 0 && privateFixed > 0 && privatePerCopy > 0, 'the job has no fixed/variable split, so nothing is exercised');
    assert.ok(Math.abs(privateFixed - namedFixed) <= 3, `reference fixed ${privateFixed} vs named ${namedFixed}`);

    // ----------------------------------------------------------------- verdict
    const found: string[] = [];
    if (Math.abs(fixedShare - privateShare) <= 0.005) {
      found.push(
        `fixed share of the job's cost, from the curve ALONE = ${(fixedShare * 100).toFixed(2)}% ` +
          `(private: ${(privateShare * 100).toFixed(2)}%)`
      );
    }
    if (derivedFixed !== null && Math.abs(derivedFixed - privateFixed) <= Math.max(5, privateFixed * 0.01)) {
      found.push(
        `fixed per-job cost (prep labour ${labourLine} IQD + restart provision) = ${derivedFixed.toFixed(1)} IQD ` +
          `(private: ${privateFixed.toFixed(1)})`
      );
    }
    if (derivedPerCopy !== null && Math.abs(derivedPerCopy - privatePerCopy) <= Math.max(5, privatePerCopy * 0.01)) {
      found.push(`per-copy cost = ${derivedPerCopy.toFixed(1)} IQD (private: ${privatePerCopy.toFixed(1)})`);
    }
    const scanner = leaks(plain.estimate, { numbers: [...trueCost.values(), labourLine] });
    assert.deepEqual(
      found,
      [],
      `${actor.label}: POST /api/print-quote/analyses/:id/quote returns estimate.quantity_curve ` +
        `${JSON.stringify(curve)} — re-runs of the private engine at copy counts the route itself refuses — ` +
        `from which the job's private cost structure follows: ${found.join('; ')}. ` +
        `Margin used: ${m === null ? 'none' : (m * 100).toFixed(3) + '% from the public accessory delta'}. ` +
        `The shared leak scanner flags nothing in the estimate: ${JSON.stringify(scanner)}. ` +
        `Client code reading quantity_curve (beyond its type): ${JSON.stringify(clientConsumers())}`
    );
  });
}
