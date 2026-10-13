/**
 * LEAK AUDIT — staff-api: the OWNER's private machine-hour economics reach any
 * merchant / store owner (an ASSISTANT ADMIN who opened a store included)
 * through the workshop costing door and the print-quote compare door.
 *
 * What the code itself classifies as the owner's alone:
 *
 *   * `printPricingConfig.machine_hour_iqd` — `printPricingConfig` is in
 *     COST_SETTING_KEYS (worker/routes/admin.ts), deleted from
 *     GET /api/admin/settings for every admin but the owner;
 *   * the printer model card's economics — `purchase_iqd`, `residual_iqd`,
 *     `useful_print_hours`, `maintenance_iqd_per_hour` and the per-hour figure
 *     derived from them — shown only by GET /api/admin/print-quote/printer-models,
 *     which is `requireCostRead` (DECISIONS row 185 (9): «محرر اقتصاديات
 *     الطابعات تكلفة … وسعر ساعة الآلة المقروء من printPricingConfig»).
 *
 * The control below proves that split on the admin side: the assistant admin
 * is refused that screen, the owner reads the very sentinels seeded here.
 *
 * The doors under test answer a store owner with `merchantQuote()`, which
 * returns every cost line WITH its detail:
 *
 *   * DEPRECIATION: `<h> h @ <rate>/h` (worker/lib/printQuote/cost.ts) — the
 *     rate is `platformMachineHourIqd()` (the owner's setting) whenever neither
 *     the merchant's printer nor the model card carries purchase economics,
 *     else `(purchase_iqd − residual_iqd) / useful_print_hours` off the card;
 *   * MAINTENANCE: `hours × printer_models.maintenance_iqd_per_hour`, with the
 *     hours stated next to it (`machine_hours`), so `iqd / machine_hours` is the
 *     card's figure;
 *   * /compare additionally states `because.machine_iqd_per_hour`.
 *
 * Doors:
 *   A. POST /api/merchant/workshop/requests/:id/cost   (an eligible workshop)
 *   B. POST /api/print-quote/analyses/:id/compare      (a store owner's own analysis)
 * Actors: a plain merchant, and an assistant admin who owns a store (no cost
 * right — the admin side refuses them the same figures).
 *
 * LOCAL ONLY: an in-memory SQLite database with every migration, the real route
 * modules, the stub session and in-memory R2 of tests/fixtures/app.ts. No network.
 *
 * Run: node --import tsx --test tests/leakAudit_staff-api_merchant_print_quote_owner_machine_rate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, MemoryBucket, asD1, freshDb, get, json, post, stubApp, type App, type Mount, type StubUser } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { merchantWorkshopRoutes } from '../worker/routes/merchantWorkshop';
import { adminPrintQuoteRoutes, printQuoteRoutes } from '../worker/routes/printQuote';
import { DEFAULT_PRICING } from '../worker/lib/printPricing';

// ------------------------------------------------------------- the sentinels

/** printPricingConfig.machine_hour_iqd.fdm — the owner's platform machine-hour rate. */
const PLATFORM_HOUR_FDM = 3_917;
/** printPricingConfig.machine_hour_iqd.resin — set too, so neither is the code default. */
const PLATFORM_HOUR_RESIN = 5_821;
/** printer_models.maintenance_iqd_per_hour for bbl-p1s — the owner's model card. */
const MODEL_MAINT = 287;
/** printer_models purchase economics for bbl-p1s (scenario «the owner typed the card»). */
const MODEL_PURCHASE = 9_876_000;
const MODEL_RESIDUAL = 0;
const MODEL_USEFUL_HOURS = 2_000;
/** (purchase − residual) / useful hours — what the owner's printer-models screen calls machine_iqd_per_hour. */
const MODEL_HOUR = (MODEL_PURCHASE - MODEL_RESIDUAL) / MODEL_USEFUL_HOURS; // 4,938

const PER_HOUR_SENTINELS = [PLATFORM_HOUR_FDM, PLATFORM_HOUR_RESIN, MODEL_MAINT, MODEL_HOUR];
const SENTINEL_NUMBERS = [...PER_HOUR_SENTINELS, MODEL_PURCHASE];
const spelled = (n: number) => [n.toLocaleString('en-US'), String(n)];
const SENTINEL_TEXT = [PLATFORM_HOUR_FDM, PLATFORM_HOUR_RESIN, MODEL_HOUR, MODEL_PURCHASE].flatMap(spelled);

/**
 * Every place one of the owner's per-hour figures reaches a response:
 *   - the sentinel as a number, at any depth (e.g. because.machine_iqd_per_hour);
 *   - the sentinel spelled inside a string (DEPRECIATION's `… h @ 3,917/h`);
 *   - the sentinel DERIVABLE from what was returned: a per-hour line divided by
 *     the machine hours the same payload states (MAINTENANCE prints no rate,
 *     but `iqd / machine_hours` is the model card's figure).
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
      const hours = Number(o.machine_hours);
      if (Array.isArray(o.lines) && hours > 0) {
        for (const [i, l] of (o.lines as Array<Record<string, unknown>>).entries()) {
          if (l.component !== 'DEPRECIATION' && l.component !== 'MAINTENANCE') continue;
          const rate = Number(l.iqd) / hours;
          for (const s of PER_HOUR_SENTINELS) {
            // Line iqd is rounded to the dinar and hours to 1/100 h: allow that rounding.
            if (Math.abs(rate - s) <= Math.max(1, s * 0.02)) {
              out.push(`${path}.lines[${i}] (${l.component}) iqd/machine_hours = ${l.iqd}/${hours} = ${rate.toFixed(1)} ≈ ${s}`);
            }
          }
        }
      }
      for (const [k, x] of Object.entries(o)) walk(x, `${path}.${k}`);
      return;
    }
    if (typeof v === 'number' && SENTINEL_NUMBERS.includes(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'string') {
      for (const t of SENTINEL_TEXT) if (new RegExp(`(^|[^\\d,])${t}([^\\d,]|$)`).test(v)) out.push(`${path} ⊃ "${t}" («${v.slice(0, 80)}»)`);
    }
  };
  walk(body, '$');
  return [...new Set(out)];
}

function report(door: string, who: string, body: Record<string, unknown>, found: string[]): string {
  const generic = leaks(body).slice(0, 6);
  return (
    `${door}: ${who} (not the owner) receives the owner's private machine-hour economics — ` +
    `${found.join('; ')}` +
    (generic.length ? ` | the shared leak scanner also flags: ${generic.join('; ')}` : '')
  );
}

// ------------------------------------------------------------------- actors

const FUTURE = '2099-01-01T00:00:00.000Z';
const MERCHANT: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
/** An assistant admin (no cost right) who also opened a store of their own. */
const ASSISTANT: StubUser = { id: 'asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };

/**
 * The owner set his platform machine-hour rate and the P1S model card's
 * maintenance; the card's purchase economics stay NULL (as every seeded
 * machine's do) unless `ownerTypedCard`. Two workshops, each with a P1S linked
 * to the canonical model and NO economics of their own: `ali` (a merchant) and
 * `asst` (an assistant admin with a store).
 */
function shop(opts: { ownerTypedCard?: boolean } = {}): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('ali','Ali','ali@x.co','h','merchant');
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('asst','Asst','asst@x.co','h','admin','assistant');
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES ('usr_owner','Boss','boss@x.co','h','admin','2026-01-01T00:00:00.000Z');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','ali','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem2','asst','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','ali','Ali 3D'), ('m5','asst','Asst 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,governorate) VALUES
      ('s1','m1','ali','ali3d','Ali 3D','baghdad'), ('s5','m5','asst','asst3d','Asst 3D','baghdad');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max,model_id,brand,model) VALUES
      ('p1','m1','s1','P1S','fdm',256,256,250,'[]','fine','bbl-p1s','Bambu Lab','P1S'),
      ('p5','m5','s5','P1S','fdm',256,256,250,'[]','fine','bbl-p1s','Bambu Lab','P1S');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  raw
    .prepare(`INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('printPricingConfig', ?)`)
    .run(JSON.stringify({ ...DEFAULT_PRICING, machine_hour_iqd: { fdm: PLATFORM_HOUR_FDM, resin: PLATFORM_HOUR_RESIN } }));
  raw.prepare(`UPDATE printer_models SET maintenance_iqd_per_hour = ? WHERE id = 'bbl-p1s'`).run(MODEL_MAINT);
  if (opts.ownerTypedCard) {
    raw
      .prepare(`UPDATE printer_models SET purchase_iqd = ?, residual_iqd = ?, useful_print_hours = ? WHERE id = 'bbl-p1s'`)
      .run(MODEL_PURCHASE, MODEL_RESIDUAL, MODEL_USEFUL_HOURS);
  }
  return raw;
}

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/merchant/workshop', merchantWorkshopRoutes);
  a.route('/api/print-quote', printQuoteRoutes);
  a.route('/api/admin/print-quote', adminPrintQuoteRoutes);
};
const as = (raw: DatabaseSync, user: StubUser | null, bucket: MemoryBucket) =>
  stubApp(asD1(raw), user, mount, { env: { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket } });

/** A real binary STL of a W×D×H box, wound outward (analyseModel measures it). */
function stl(w: number, d: number, h: number): Uint8Array {
  const v: Array<[number, number, number]> = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
  ];
  const tris: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
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

/** The buyer publishes a PLA request with a measured 60×60×40 mm model; both workshops are matched. */
async function publishedRequest(raw: DatabaseSync, bucket: MemoryBucket): Promise<string> {
  const buyer = as(raw, BUYER, bucket);
  const res = await post(buyer, '/api/marketplace/requests', { title: 'A bracket', description: 'Print me a bracket please' });
  const id = (await json(res)).request.id as string;
  const form = new FormData();
  form.append('file', new File([stl(60, 60, 40) as unknown as BlobPart], 'bracket.stl'));
  const up = await buyer.request(`/api/marketplace/requests/${id}/files`, { method: 'POST', body: form });
  assert.equal(up.status, 201, JSON.stringify(await json(up.clone())));
  const model = (await json(up)).file.id as string;
  const an = await post(buyer, `/api/marketplace/print/requests/${id}/files/${model}/analyze`);
  assert.equal(an.status, 200, JSON.stringify(await json(an.clone())));
  const pub = await post(buyer, `/api/marketplace/print/requests/${id}/publish`, {
    process: 'fdm', material_id: 'pla', quality: 'standard', quantity: 1, governorate: 'baghdad', primary_file_id: model,
  });
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  return id;
}

/** The store owner's OWN calculator analysis, measured from slicer stats on the P1S in PLA. */
async function ownAnalysis(a: App): Promise<string> {
  const form = new FormData();
  form.append('file', new File([stl(60, 60, 40) as unknown as BlobPart], 'bracket.stl', { type: 'application/octet-stream' }));
  const up = await json(await a.request('/api/print-quote/uploads', { method: 'POST', body: form }));
  assert.equal(up.success, true, JSON.stringify(up));
  const id = up.analysis_id as string;
  const analysed = await json(
    await post(a, `/api/print-quote/analyses/${id}`, {
      printer_model_id: 'bbl-p1s',
      stats: { filament_mm: 60_000, time_estimate: 14_400, layers: 200, model_layers: 200, raft_layers: 0 },
      tools: [{ slot: 0, material_id: 'pla', color_hex: '#000000' }],
      bounding_box_mm: { x: 60, y: 60, z: 40 },
      model_volume_mm3: 144_000,
      layer_height_mm: 0.2,
      preparation_minutes: 8,
      slicer_version: 'three-slicer@0.2.2',
      profile_revision: 'bbl-p1s-04-r1',
    })
  );
  assert.equal(analysed.success, true, JSON.stringify(analysed));
  return id;
}

async function costAs(user: StubUser, opts: { ownerTypedCard?: boolean } = {}) {
  const raw = shop(opts);
  const bucket = new MemoryBucket();
  const id = await publishedRequest(raw, bucket);
  const res = await post(as(raw, user, bucket), `/api/merchant/workshop/requests/${id}/cost`, {});
  const body = await json(res);
  // The door really priced this workshop's printer as the MERCHANT payload — otherwise this proves nothing.
  assert.equal(res.status, 200, `${user.id} could not cost the request: ${JSON.stringify(body)}`);
  assert.ok(Array.isArray(body.quote?.lines), `not the merchant payload: ${JSON.stringify(body.quote)}`);
  return body;
}

// ----------------------------------------------------------------- control

test('control: the admin side treats these figures as the owner’s — the assistant is refused, the owner reads the sentinels', async () => {
  const raw = shop({ ownerTypedCard: true });
  const bucket = new MemoryBucket();
  const refused = await get(as(raw, ASSISTANT, bucket), '/api/admin/print-quote/printer-models');
  assert.equal(refused.status, 403, 'the assistant admin is refused the printer economics screen');
  const refusedBody = await json(refused);
  assert.deepEqual(ownerRateLeaks(refusedBody), []);

  const owner = await json(await get(as(raw, OWNER, bucket), '/api/admin/print-quote/printer-models'));
  assert.equal(owner.success, true, JSON.stringify(owner));
  assert.equal(owner.platform_machine_hour_iqd.fdm, PLATFORM_HOUR_FDM, 'the owner reads his platform rate');
  const p1s = (owner.models as Array<Record<string, unknown>>).find((m) => m.id === 'bbl-p1s')!;
  assert.equal(p1s.maintenance_iqd_per_hour, MODEL_MAINT);
  assert.equal(p1s.machine_iqd_per_hour, MODEL_HOUR, 'the owner screen derives the same per-hour figure');
});

// ------------------------------------------------------------------ door A

test('A1 merchant POST /api/merchant/workshop/requests/:id/cost carries none of the owner’s machine-hour figures (platform rate + card maintenance)', async () => {
  const body = await costAs(MERCHANT);
  const found = ownerRateLeaks(body);
  assert.deepEqual(found, [], report('POST /api/merchant/workshop/requests/:id/cost', 'a MERCHANT', body, found));
});

test('A2 assistant admin with a store: POST /api/merchant/workshop/requests/:id/cost carries none of the owner’s machine-hour figures', async () => {
  const body = await costAs(ASSISTANT);
  const found = ownerRateLeaks(body);
  assert.deepEqual(found, [], report('POST /api/merchant/workshop/requests/:id/cost', 'an ASSISTANT ADMIN with a store', body, found));
});

test('A3 merchant: when the owner typed the P1S card’s purchase economics, the costing carries no figure derived from them', async () => {
  const body = await costAs(MERCHANT, { ownerTypedCard: true });
  const found = ownerRateLeaks(body);
  assert.deepEqual(found, [], report('POST /api/merchant/workshop/requests/:id/cost (owner-typed model card)', 'a MERCHANT', body, found));
});

// ------------------------------------------------------------------ door B

test('B1 assistant admin with a store: POST /api/print-quote/analyses/:id/compare carries none of the owner’s machine-hour figures', async () => {
  const raw = shop();
  const bucket = new MemoryBucket();
  const a = as(raw, ASSISTANT, bucket);
  const id = await ownAnalysis(a);
  const body = await json(await post(a, `/api/print-quote/analyses/${id}/compare`, {}));
  assert.equal(body.success, true, JSON.stringify(body));
  const p5 = (body.printers as Array<Record<string, unknown>>).find((p) => p.merchant_printer_id === 'p5');
  assert.ok(p5 && p5.eligible === true, `the store owner's printer was not priced: ${JSON.stringify(body.printers)}`);
  const found = ownerRateLeaks(body);
  assert.deepEqual(found, [], report('POST /api/print-quote/analyses/:id/compare', 'an ASSISTANT ADMIN with a store', body, found));
});
