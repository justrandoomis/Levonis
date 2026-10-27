/**
 * LEVONIS PRINT CLOUD — the test world (docs/PRINT_CLOUD.md §14).
 *
 * A fresh database with EVERY migration, real routers mounted the way
 * worker/index.ts mounts them, a D1 that enforces the live limits and can
 * interleave a competing request just before a chosen batch (RaceD1), an R2
 * double, and one app per signed-in role. The catalogue is built through the
 * ADMIN API itself — so every test that buys, prints or ships also proves the
 * administration that set it up.
 *
 * Nothing here is a mock of Print Cloud: only the session lookup is stubbed.
 */
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, memoryBucket, stubApp, ctx, pending, type App, type Mount, type StubUser, type MemoryBucket } from './app';
import { RaceD1 } from './raceD1';
import { printCloudRoutes } from '../../worker/routes/printCloud';
import { printCloudAgentRoutes } from '../../worker/routes/printCloudAgent';
import { adminPrintCloudRoutes } from '../../worker/routes/printCloudAdmin';
import { runPrintCloudTasks } from '../../worker/lib/printCloud/background';

export const CUSTOMER_A: StubUser = { id: 'usr_pc_a', role: 'customer', email: 'a@x.co' };
export const CUSTOMER_B: StubUser = { id: 'usr_pc_b', role: 'customer', email: 'b@x.co' };
export const PC_OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
export const PC_FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
export const PC_ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };

export const mountPrintCloud: Mount = (a) => {
  a.route('/api/print-cloud/v1/agent', printCloudAgentRoutes);
  a.route('/api/print-cloud/v1', printCloudRoutes);
  a.route('/api/admin/print-cloud', adminPrintCloudRoutes);
};

export interface World {
  raw: DatabaseSync;
  race: RaceD1;
  db: D1Database;
  bucket: MemoryBucket;
  env: Record<string, unknown>;
  as: (user: StubUser | null, host?: string) => App;
  owner: App;
  full: App;
  assistant: App;
  a: App;
  b: App;
  guest: App;
  runTasks: (limit?: number) => Promise<unknown>;
}

export function pcWorld(opts: { env?: Record<string, unknown> } = {}): World {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role, username, admin_scope, email_verified_at) VALUES
    ('usr_pc_a', 'Ali', 'a@x.co', 'h', 'customer', 'usr_pc_a', NULL, '2026-01-01T00:00:00.000Z'),
    ('usr_pc_b', 'Bana', 'b@x.co', 'h', 'customer', 'usr_pc_b', NULL, '2026-01-01T00:00:00.000Z'),
    ('usr_owner', 'Owner', 'boss@x.co', 'h', 'admin', 'usr_owner', NULL, '2026-01-01T00:00:00.000Z'),
    ('usr_full', 'Full', 'full@x.co', 'h', 'admin', 'usr_full', 'full', '2026-01-01T00:00:00.000Z'),
    ('usr_asst', 'Operator', 'asst@x.co', 'h', 'admin', 'usr_asst', 'assistant', '2026-01-01T00:00:00.000Z')`);
  const race = new RaceD1(raw);
  const db = race as unknown as D1Database;
  const bucket = memoryBucket();
  const env = {
    BUCKET: bucket,
    R2_PRIVATE: bucket,
    PRINT_CLOUD_DEV_PAYMENTS: 'on',
    PRINT_CLOUD_PAYMENT_WEBHOOK_SECRET: 'whsec_'.padEnd(48, 'x'),
    PRINT_CLOUD_FILE_URL_SECRET: 'files_'.padEnd(48, 'y'),
    ...(opts.env ?? {}),
  };
  const as = (user: StubUser | null, host?: string) => stubApp(db, user, mountPrintCloud, { env, host, publishV2: false });
  return {
    raw,
    race,
    db,
    bucket,
    env,
    as,
    owner: as(PC_OWNER),
    full: as(PC_FULL),
    assistant: as(PC_ASSISTANT),
    a: as(CUSTOMER_A),
    b: as(CUSTOMER_B),
    guest: as(null),
    // Work a request already started after its answer (waitUntil) settles first, then the due rest runs.
    runTasks: async (limit = 10) => {
      await Promise.allSettled(pending.splice(0));
      return runPrintCloudTasks({ DB: db, BUCKET: bucket as never, R2_PRIVATE: bucket as never }, { limit });
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export async function call(app: App, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const res = await app.request(
    path,
    {
      method,
      headers: { 'CF-Connecting-IP': '1.2.3.4', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    undefined,
    ctx
  );
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

export const API = '/api/print-cloud/v1';
export const ADMIN = '/api/admin/print-cloud';
export const AGENT = '/api/print-cloud/v1/agent';

let keyCounter = 0;
export const idem = (label = 'k') => ({ 'Idempotency-Key': `test-${label}-${++keyCounter}-${Date.now()}` });

let readingCounter = 0;
/**
 * A telemetry body as the agent sends it (docs/PRINT_CLOUD.md §9): one boot
 * for the test process, each reading the next of its sequence. A body that
 * names its own `boot` or `seq` keeps them.
 */
export const reading = (body: Record<string, unknown>): Record<string, unknown> => ({ boot: 1, seq: ++readingCounter, ...body });

/** The call must succeed; returns `data`. */
export async function ok(app: App, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Json> {
  const r = await call(app, method, path, body, headers);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.json).slice(0, 600)}`);
  return r.json.data;
}

/** The call must be refused with this code. */
export async function refused(app: App, method: string, path: string, body: unknown, code: string, headers: Record<string, string> = {}): Promise<Json> {
  const r = await call(app, method, path, body, headers);
  assert.ok(r.status >= 400, `${method} ${path} should be refused with ${code}, got ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
  assert.equal(r.json.code, code, `${method} ${path}: ${JSON.stringify(r.json).slice(0, 400)}`);
  return r.json;
}

const names = (en: string, ar: string, ckb: string) => ({ name_en: en, name_ar: ar, name_ckb: ckb });

export interface Catalog {
  tier: string;
  model: string;
  printers: string[];
  packages: Record<'h6' | 'h24' | 'h48' | 'h72', string>;
  white: string;
  black: string;
  red: string;
  gold: string;
  magnets: string;
  rings: string;
}

/** The workshop of the brief: an X2D Combo tier with two machines, PLA by the gram, magnets and keychain rings. */
export async function seedCatalog(w: World, opts: { approval?: boolean; secondPrinter?: boolean } = {}): Promise<Catalog> {
  const settings = await ok(w.owner, 'GET', `${ADMIN}/settings`);
  await ok(w.owner, 'PATCH', `${ADMIN}/settings`, { version: settings.version, config: { enabled: true, require_operator_approval: opts.approval ?? true } });
  const tier = await ok(w.owner, 'POST', `${ADMIN}/catalog/tiers`, {
    code: 'x2d',
    ...names('X2D Combo hours', 'ساعات X2D Combo', 'کاتژمێرەکانی X2D Combo'),
    hourly_rate_iqd: 1500,
    custom_hours_enabled: true,
  });
  const model = await ok(w.owner, 'POST', `${ADMIN}/catalog/printer_models`, {
    tier_id: tier.id,
    code: 'BBL-X2D-COMBO',
    brand: 'Bambu Lab',
    model_name: 'X2D Combo',
    build_x_mm: 256,
    build_y_mm: 256,
    build_z_mm: 256,
    nozzle_options_um: [400],
    extruder_config: 'dual',
    ams_systems_json: ['AMS 2 Pro'],
    max_colors: 8,
    supported_materials_json: ['PLA', 'PETG'],
    enclosed: true,
    camera: true,
    average_power_w: 350,
    quality_rank: 90,
  });
  const printers: string[] = [];
  for (const n of opts.secondPrinter === false ? [1] : [1, 2]) {
    const p = await ok(w.owner, 'POST', `${ADMIN}/catalog/printers`, {
      model_id: model.id,
      name: `X2D #${n}`,
      serial_number: `SN-X2D-000${n}`,
      equipment_code: `LEV-X2D-0${n}`,
      location: 'Workshop A',
      nozzle_um: 400,
      ams_slots: 4,
      materials_json: ['PLA', 'PETG'],
      acquisition_cost_iqd: 2_400_000,
      expected_life_hours: 10_000,
      residual_value_iqd: 400_000,
      maintenance_reserve_iqd_per_hour: 100,
    });
    printers.push(p.id);
  }
  const pkg = async (code: string, hours: number, price: number) =>
    (await ok(w.owner, 'POST', `${ADMIN}/catalog/packages`, { tier_id: tier.id, code, ...names(`${hours} hours`, `${hours} ساعة`, `${hours} کاتژمێر`), seconds: hours * 3600, price_iqd: price, sort: hours })).id as string;
  const packages = { h6: await pkg('x2d-6h', 6, 10500), h24: await pkg('x2d-24h', 24, 36000), h48: await pkg('x2d-48h', 48, 68000), h72: await pkg('x2d-72h', 72, 96000) };
  const pla = await ok(w.owner, 'POST', `${ADMIN}/catalog/products`, {
    category_code: 'filaments',
    brand: 'Bambu Lab',
    ...names('PLA Basic', 'PLA أساسي', 'PLA بنەڕەتی'),
    material: 'PLA',
    grade: 'Basic',
  });
  const variant = async (productId: string, sku: string, en: string, ar: string, ckb: string, unit: string, extra: Record<string, unknown> = {}) =>
    (await ok(w.owner, 'POST', `${ADMIN}/catalog/variants`, { product_id: productId, sku, ...names(en, ar, ckb), unit_code: unit, ...extra })).id as string;
  const gram = { min_purchase_qty: 100, purchase_step_qty: 10, max_purchase_qty: 5000, diameter_um: 1750 };
  const white = await variant(pla.id, 'PLA-BASIC-COLDWHITE', 'PLA Basic Cold White', 'PLA أبيض بارد', 'PLA سپی سارد', 'g', { ...gram, color_name: 'Cold White', color_hex: '#F4F7FA' });
  const black = await variant(pla.id, 'PLA-BASIC-BLACK', 'PLA Basic Black', 'PLA أسود', 'PLA ڕەش', 'g', { ...gram, color_name: 'Black', color_hex: '#000000' });
  const red = await variant(pla.id, 'PLA-BASIC-RED', 'PLA Basic Red', 'PLA أحمر', 'PLA سوور', 'g', { ...gram, color_name: 'Red', color_hex: '#C12E1F' });
  const gold = await variant(pla.id, 'PLA-SILK-GOLD', 'PLA Silk Gold', 'PLA حريري ذهبي', 'PLA ئاوریشمی زێڕین', 'g', { ...gram, color_name: 'Gold', color_hex: '#D4AF37' });
  const plaTiers = {
    tiers: [
      { mode: 'pack', min_qty: 100, pack_price_iqd: 3500 },
      { mode: 'pack', min_qty: 250, pack_price_iqd: 8000 },
      { mode: 'pack', min_qty: 500, pack_price_iqd: 14500 },
      { mode: 'pack', min_qty: 1000, pack_price_iqd: 24250 },
      { mode: 'bracket', min_qty: 100, unit_price_milli_iqd: 35000 },
      { mode: 'bracket', min_qty: 250, unit_price_milli_iqd: 32000 },
      { mode: 'bracket', min_qty: 500, unit_price_milli_iqd: 29000 },
      { mode: 'bracket', min_qty: 1000, unit_price_milli_iqd: 24250 },
    ],
  };
  for (const v of [white, black, red, gold]) await ok(w.owner, 'PUT', `${ADMIN}/variants/${v}/price-tiers`, plaTiers);
  const magnetProduct = await ok(w.owner, 'POST', `${ADMIN}/catalog/products`, { category_code: 'magnets', ...names('Neodymium magnets', 'مغناطيس نيوديميوم', 'موگناتیسی نیۆدیمیۆم') });
  const magnets = await variant(magnetProduct.id, 'MAG-8X3', '8×3 mm magnet', 'مغناطيس 8×3 مم', 'موگناتیسی 8×3 ملم', 'pc');
  const ringProduct = await ok(w.owner, 'POST', `${ADMIN}/catalog/products`, { category_code: 'keychain_rings', ...names('Keychain rings', 'حلقات ميدالية', 'ئەڵقەی کلیلدان') });
  const rings = await variant(ringProduct.id, 'RING-25', 'Keychain ring 25 mm', 'حلقة ميدالية 25 مم', 'ئەڵقەی کلیلدان 25 ملم', 'pc');
  await ok(w.owner, 'PUT', `${ADMIN}/variants/${magnets}/price-tiers`, { tiers: [{ mode: 'bracket', min_qty: 1, unit_price_milli_iqd: 250000 }, { mode: 'pack', min_qty: 10, pack_price_iqd: 2000 }] });
  await ok(w.owner, 'PUT', `${ADMIN}/variants/${rings}/price-tiers`, { tiers: [{ mode: 'bracket', min_qty: 1, unit_price_milli_iqd: 300000 }] });
  const receive = (variantId: string, qty: number, cost: number) => ok(w.owner, 'POST', `${ADMIN}/stock/receive`, { variant_id: variantId, qty, total_cost_iqd: cost, supplier: 'Bambu Lab' }, idem('stock'));
  await receive(white, 20000, 400000);
  await receive(black, 5000, 100000);
  await receive(red, 5000, 100000);
  await receive(gold, 100, 2500);
  await receive(magnets, 500, 50000);
  await receive(rings, 300, 30000);
  await ok(w.owner, 'POST', `${ADMIN}/catalog/accessory_rules`, {
    keyword: 'keychain',
    variant_id: rings,
    qty_per_item: 1,
    note_en: 'Attach one ring per keychain',
    note_ar: 'ركّب حلقة لكل ميدالية',
    note_ckb: 'بۆ هەر کلیلدانێک ئەڵقەیەک دابنێ',
  });
  await ok(w.owner, 'POST', `${ADMIN}/catalog/accessory_rules`, { project_type: 'magnetic', variant_id: magnets, qty_per_item: 2, needs_pause_at_layer: true });
  return { tier: tier.id, model: model.id, printers, packages, white, black, red, gold, magnets, rings };
}

/** Quote → order → (dev) payment. Returns the order id. */
export async function buy(app: App, lines: unknown[], opts: { payment?: string; address?: unknown; eventId?: string } = {}): Promise<string> {
  const quote = await ok(app, 'POST', `${API}/quotes`, { lines });
  const order = await ok(app, 'POST', `${API}/orders`, { quote_id: quote.quote_id, payment_method: opts.payment ?? 'dev', delivery_address: opts.address }, idem('order'));
  if ((opts.payment ?? 'dev') === 'dev') {
    const paid = await ok(app, 'POST', `${API}/orders/${order.order_id}/dev-pay`, opts.eventId ? { event_id: opts.eventId } : {});
    assert.equal(paid.outcome, 'applied');
  }
  return order.order_id;
}

/** A binary STL of an axis-aligned box (12 triangles), sizes in millimetres. */
export function boxStl(x: number, y: number, z: number): Uint8Array {
  const v = [
    [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
    [0, 0, z], [x, 0, z], [x, y, z], [0, y, z],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buf = new ArrayBuffer(84 + faces.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, faces.length, true);
  faces.forEach((f, i) => {
    const o = 84 + i * 50;
    f.forEach((vi, k) => {
      dv.setFloat32(o + 12 + k * 12, v[vi][0], true);
      dv.setFloat32(o + 16 + k * 12, v[vi][1], true);
      dv.setFloat32(o + 20 + k * 12, v[vi][2], true);
    });
  });
  return new Uint8Array(buf);
}

export async function upload(app: App, bytes: Uint8Array, name: string): Promise<{ status: number; json: Json }> {
  const fd = new FormData();
  fd.append('file', new File([bytes as unknown as BlobPart], name));
  const res = await app.request(`${API}/files`, { method: 'POST', body: fd, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  return { status: res.status, json: (await res.json()) as Json };
}

/** Upload a box, run the analysis task, and return the ready file id. */
export async function readyFile(w: World, app: App, mm: [number, number, number] = [40, 30, 10], name = 'part.stl'): Promise<string> {
  const r = await upload(app, boxStl(...mm), name);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await w.runTasks();
  return r.json.data.file_id;
}

/**
 * The printing flow up to an estimate: project → model (with materials) →
 * job → analysis → operator-entered slicer figures.
 */
export async function estimatedJob(
  w: World,
  app: App,
  cat: Catalog,
  p: { seconds: number; materials: Array<{ variant_id: string; model_grams: number; support_grams?: number; purge_grams?: number }>; accessories?: Array<{ variant_id: string; qty: number }>; title?: string; fileId?: string; projectType?: string }
): Promise<{ jobId: string; projectId: string }> {
  const fileId = p.fileId ?? (await readyFile(w, app));
  const project = await ok(app, 'POST', `${API}/projects`, { name: p.title ?? 'Dragon', project_type: p.projectType ?? 'figure' });
  await ok(app, 'POST', `${API}/projects/${project.project_id}/models`, {
    file_id: fileId,
    quantity: 1,
    material_assignments: p.materials.map((m, i) => ({ part: i === 0 ? 'default' : `part${i}`, variant_id: m.variant_id })),
  });
  const job = await ok(app, 'POST', `${API}/jobs`, { project_id: project.project_id, printer_model_id: cat.model, title: p.title ?? 'Dragon', accessories: p.accessories });
  assert.equal(job.status, 'uploaded');
  const analysis = await ok(app, 'POST', `${API}/jobs/${job.job_id}/analyze`);
  assert.equal(analysis.status, 'analyzing');
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${job.job_id}/estimate`, {
    duration_seconds: p.seconds,
    layer_count: 420,
    materials: p.materials.map((m) => ({ variant_id: m.variant_id, model_grams: m.model_grams, support_grams: m.support_grams ?? 0, purge_grams: m.purge_grams ?? 0 })),
    slicer_name: 'OrcaSlicer',
    slicer_version: '2.3.0',
    printer_profile: 'Bambu Lab X2D 0.4 nozzle',
  });
  return { jobId: job.job_id, projectId: project.project_id };
}

/** review → confirm (customer) → approve (operator) → on a machine → printing. */
export async function runToPrinting(w: World, app: App, jobId: string, printerId?: string): Promise<void> {
  await ok(app, 'POST', `${API}/jobs/${jobId}/review`);
  const confirmed = await ok(app, 'POST', `${API}/jobs/${jobId}/confirm`, undefined, idem('confirm'));
  if (confirmed.status === 'confirmed') await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/approve`);
  if (printerId) await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/assign`, { printer_id: printerId });
  else {
    const run = await ok(w.assistant, 'POST', `${ADMIN}/queue/run`);
    assert.ok(run.assigned.some((a: Json) => a.job_id === jobId), `job ${jobId} was not assigned: ${JSON.stringify(run)}`);
  }
  await ok(w.assistant, 'POST', `${ADMIN}/jobs/${jobId}/start`);
}

export const row = <T = Json>(w: World, sql: string, ...params: unknown[]) => {
  const r = w.raw.prepare(sql).get(...(params as never[]));
  return (r === undefined ? undefined : { ...(r as object) }) as T | undefined;
};
export const rows = <T = Json>(w: World, sql: string, ...params: unknown[]) => (w.raw.prepare(sql).all(...(params as never[])) as object[]).map((r) => ({ ...r })) as T[];

export async function credits(app: App, tierId: string): Promise<Json> {
  const c = await ok(app, 'GET', `${API}/me/credits`);
  return c.tiers.find((t: Json) => t.tier_id === tierId) ?? { available_seconds: 0, reserved_seconds: 0, consumed_seconds: 0 };
}

export async function owned(app: App, variantId: string): Promise<Json> {
  const inv = await ok(app, 'GET', `${API}/me/inventory`);
  return inv.find((i: Json) => i.variant_id === variantId) ?? { available_qty: 0, reserved_qty: 0, consumed_qty: 0 };
}

export async function reconcileClean(w: World): Promise<void> {
  const r = await ok(w.owner, 'GET', `${ADMIN}/reconcile`);
  const bad = r.checks.filter((c: Json) => !c.ok && c.name !== 'payments_needing_refund');
  assert.deepEqual(bad, [], `reconciliation found issues: ${JSON.stringify(bad).slice(0, 1500)}`);
}
