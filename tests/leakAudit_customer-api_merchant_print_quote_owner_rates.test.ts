/**
 * LEAK AUDIT — customer-api: the OWNER's private print-cost inputs reach any
 * merchant / store owner through the print-quote calculator's merchant payload.
 *
 * The owner's rule is that anyone other than the main admin / super admin gets
 * ONLY the final price. The code itself classifies these print inputs as the
 * owner's alone:
 *
 *   * `printPricingConfig.machine_hour_iqd` — `printPricingConfig` is in
 *     COST_SETTING_KEYS (worker/routes/admin.ts), stripped from
 *     GET /api/admin/settings for every admin but the owner;
 *   * `printer_models.maintenance_iqd_per_hour` (and the rest of a model's
 *     purchase economics) — the editor that shows them,
 *     /api/admin/print-quote/printer-models, sits behind `requireCostRead`
 *     («COST, THE OWNER'S ALONE (owner decision 2)», worker/routes/printQuote.ts);
 *   * `print_materials.default_iqd_per_kg` — the platform's own price per kilo,
 *     deliberately left out of GET /api/print-quote/materials.
 *
 * A merchant who has declared no economics of their own is priced on exactly
 * these figures (`priceForPrinter`, the «last rung»), and `merchantQuote()`
 * returns every cost line with its detail string — `… h @ <rate>/h`,
 * `… g PLA @ <rate>/kg` — while /compare adds `because.machine_iqd_per_hour`
 * read off the snapshot («the owner's platform rate»). This test seeds a
 * sentinel on each owner-only input and looks for it in what a merchant gets
 * back from the three print-quote doors that build `merchantQuote`:
 *
 *   1. POST /api/print-quote/grams-quote          (merchant, no upload needed)
 *   2. POST /api/print-quote/analyses/:id/quote   (merchant's own analysis)
 *   3. POST /api/print-quote/analyses/:id/compare (merchant's linked printer, no economics)
 *
 * plus a control (an anonymous caller on door 1 gets the public shape and none
 * of it), and the guard gap: the role matrix's merchant owns no store, so
 * `storeForUser` is null and the sweep never reaches the merchant payload.
 *
 * LOCAL ONLY: an in-memory SQLite database with every migration, the real route
 * modules, the stub session of tests/fixtures/app.ts. No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, json, post, stubApp, type App, type Mount } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { ROLES, seedRoleMatrix } from './fixtures/roleMatrix';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import { storeForUser } from '../worker/lib/merchantAuth';
import { DEFAULT_PRICING } from '../worker/lib/printPricing';

// ------------------------------------------------------------- the sentinels

/** printPricingConfig.machine_hour_iqd.fdm — the owner's machine-hour rate. */
const PLATFORM_HOUR_FDM = 3_917;
/** printPricingConfig.machine_hour_iqd.resin — set too, so neither is the code default. */
const PLATFORM_HOUR_RESIN = 5_821;
/** print_materials.default_iqd_per_kg for PLA — the platform's own price per kilo. */
const PLATFORM_KG = 27_389;
/** printer_models.maintenance_iqd_per_hour for bbl-a1m — a model-card (owner-only) economic. */
const MODEL_MAINT = 287;

const SENTINEL_NUMBERS = [PLATFORM_HOUR_FDM, PLATFORM_HOUR_RESIN, PLATFORM_KG, MODEL_MAINT];
const SENTINEL_TEXT = ['3,917', '3917', '5,821', '5821', '27,389', '27389'];

/**
 * Every place an owner-only print rate reaches a response:
 *   - the sentinel as a number, at any depth;
 *   - the sentinel spelled inside a string (a cost line's `detail`);
 *   - the sentinel DERIVABLE from what was returned: a per-hour line divided by
 *     the machine hours the same payload states (MAINTENANCE carries no rate in
 *     its detail, but `iqd / machine_hours` is the model card's figure).
 */
function ownerRateLeaks(body: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // A quote payload that states its machine hours next to per-hour lines.
      const hours = Number(o.machine_hours);
      if (Array.isArray(o.lines) && hours > 0) {
        for (const [i, l] of (o.lines as Array<Record<string, unknown>>).entries()) {
          if (l.component !== 'DEPRECIATION' && l.component !== 'MAINTENANCE') continue;
          const rate = Number(l.iqd) / hours;
          for (const s of [PLATFORM_HOUR_FDM, MODEL_MAINT]) {
            if (Math.abs(rate - s) <= 1) out.push(`${path}.lines[${i}] (${l.component}) iqd/machine_hours = ${rate.toFixed(2)} ≈ ${s}`);
          }
        }
      }
      for (const [k, x] of Object.entries(o)) walk(x, `${path}.${k}`);
      return;
    }
    if (typeof v === 'number' && SENTINEL_NUMBERS.includes(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'string') for (const t of SENTINEL_TEXT) if (v.includes(t)) out.push(`${path} ⊃ "${t}" («${v.slice(0, 80)}»)`);
  };
  walk(body, '$');
  return [...new Set(out)];
}

// ------------------------------------------------------------------ the shop

const MERCHANT_USER = { id: 'u-shop', role: 'merchant' as const, email: 'shop@x.co' };

/** The owner set his print rates; a merchant opened a store and declared NO economics of their own. */
function shop(): DatabaseSync {
  const raw = freshDb();
  raw
    .prepare(
      `INSERT INTO admin_settings (key, value) VALUES ('printPricingConfig', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(JSON.stringify({ ...DEFAULT_PRICING, machine_hour_iqd: { fdm: PLATFORM_HOUR_FDM, resin: PLATFORM_HOUR_RESIN } }));
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = ? WHERE id = 'pla'`).run(PLATFORM_KG);
  // Maintenance on the model card; purchase economics left NULL, so the
  // machine hour falls to the owner's platform rate (the «last rung»).
  raw.prepare(`UPDATE printer_models SET maintenance_iqd_per_hour = ? WHERE id = 'bbl-a1m'`).run(MODEL_MAINT);

  raw
    .prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, 'Shop', 'x', 'merchant')`)
    .run(MERCHANT_USER.id, MERCHANT_USER.email);
  raw
    .prepare(`INSERT INTO community_merchants (id, user_id, name, status) VALUES ('m-shop', ?, 'Shop', 'approved')`)
    .run(MERCHANT_USER.id);
  raw
    .prepare(
      `INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name) VALUES ('st-shop', 'm-shop', ?, 'shop-audit', 'Shop')`
    )
    .run(MERCHANT_USER.id);
  return raw;
}

const bucket = { put: async () => ({}), get: async () => null, head: async () => null, delete: async () => undefined };
const mount: Mount = (a) => {
  a.route('/api/print-quote', printQuoteRoutes);
};
const env = { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket };
const merchant = (raw: DatabaseSync) => stubApp(asD1(raw), MERCHANT_USER, mount, { env });
const anonymous = (raw: DatabaseSync) => stubApp(asD1(raw), null, mount, { env });

/** A real binary STL of a 20 mm cube (the same bytes tests/printQuoteRoutes.test.ts uploads). */
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

/** The merchant's OWN analysis, measured from slicer stats on the A1 mini in PLA. */
async function merchantAnalysis(a: App): Promise<string> {
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

const GRAMS_BODY = { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 100 }], print_minutes: 120 };

function report(door: string, body: Record<string, unknown>, found: string[]): string {
  const generic = leaks(body).slice(0, 8);
  return (
    `${door}: a MERCHANT (not the owner) receives the owner's private print-cost inputs — ` +
    `${found.join('; ')}` +
    (generic.length ? ` | the shared leak scanner also flags: ${generic.join('; ')}` : '')
  );
}

// ----------------------------------------------------------------- control

test('control: an anonymous grams quote is the public shape and carries none of the owner rates', async () => {
  const raw = shop();
  const body = await json(await post(anonymous(raw), '/api/print-quote/grams-quote', GRAMS_BODY));
  assert.equal(body.success, true, JSON.stringify(body));
  assert.ok(Number(body.quote?.price_iqd) > 0, 'no final price');
  assert.equal(body.quote.lines, undefined, 'the public payload carries no cost line');
  assert.deepEqual(ownerRateLeaks(body), []);
});

// ------------------------------------------------------------------ door 1

test('merchant POST /api/print-quote/grams-quote carries none of the owner’s print rates', async () => {
  const raw = shop();
  const body = await json(await post(merchant(raw), '/api/print-quote/grams-quote', GRAMS_BODY));
  assert.equal(body.success, true, JSON.stringify(body));
  // The door really priced the job (the platform's estimate, which is all a
  // store owner reads here since DECISIONS row 219 — their own costing lives
  // on /compare and the workshop door, door 3 and the staff-api audit).
  assert.ok(Number(body.quote?.price_iqd) > 0, `the door did not price the job: ${JSON.stringify(body.quote)}`);
  assert.equal(body.quote.lines, undefined, 'the platform door answers a store owner the public shape');
  const found = ownerRateLeaks(body);
  assert.deepEqual(found, [], report('POST /api/print-quote/grams-quote', body, found));
});

// ------------------------------------------------------------------ door 2

test('merchant POST /api/print-quote/analyses/:id/quote carries none of the owner’s print rates', async () => {
  const raw = shop();
  const a = merchant(raw);
  const id = await merchantAnalysis(a);
  const body = await json(await post(a, `/api/print-quote/analyses/${id}/quote`, {}));
  assert.equal(body.success, true, JSON.stringify(body));
  assert.ok(Number(body.quote?.price_iqd) > 0, `the door did not price the job: ${JSON.stringify(body.quote)}`);
  assert.equal(body.quote.lines, undefined, 'the platform door answers a store owner the public shape');
  const found = ownerRateLeaks(body);
  assert.deepEqual(found, [], report('POST /api/print-quote/analyses/:id/quote', body, found));
});

// ------------------------------------------------------------------ door 3

test('merchant POST /api/print-quote/analyses/:id/compare carries none of the owner’s print rates', async () => {
  const raw = shop();
  const a = merchant(raw);
  const id = await merchantAnalysis(a);
  // The merchant's own A1 mini, linked to the canonical model, with NO economics declared.
  raw
    .prepare(
      `INSERT INTO merchant_printers (id, merchant_id, name, technology, brand, model,
         build_x_mm, build_y_mm, build_z_mm, nozzle_mm, materials, model_id)
       VALUES ('mp-mini','m-shop','My A1 mini','fdm','Bambu','A1 mini',180,180,180,0.4,'["PLA"]','bbl-a1m')`
    )
    .run();
  const body = await json(await post(a, `/api/print-quote/analyses/${id}/compare`, {}));
  assert.equal(body.success, true, JSON.stringify(body));
  const mini = (body.printers as Array<Record<string, unknown>>).find((p) => p.merchant_printer_id === 'mp-mini');
  assert.ok(mini && mini.eligible === true, `the merchant's printer was not priced: ${JSON.stringify(body.printers)}`);
  const found = ownerRateLeaks(body);
  assert.deepEqual(found, [], report('POST /api/print-quote/analyses/:id/compare', body, found));
});

// --------------------------------------------------------------- guard gap

test('guard gap: the role matrix merchant owns a store, so the sweep can reach the merchant payload', async () => {
  const raw = seedRoleMatrix();
  const merchantRole = ROLES.merchant!;
  const store = await storeForUser(asD1(raw), merchantRole.id);
  assert.ok(
    store,
    `tests/fixtures/roleMatrix.ts seeds merchant '${merchantRole.id}' with no community_merchants/merchant_stores row: ` +
      'storeForUser() is null, so every print-quote door answers that "merchant" with publicQuote() and the ' +
      'role-matrix sweep never sees merchantQuote() (and its write sweep sends no valid grams/analysis body outside /api/admin)'
  );
});
