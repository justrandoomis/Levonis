import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import type { Env } from '../lib/types';
import { requireAuth, badRequest, notFound, str, int } from '../lib/http';
import { newId } from '../lib/crypto';
import { requireStoreOwner } from '../lib/merchantAuth';
import { getSetting } from '../lib/settings';
import { CAPABILITIES } from '../lib/printMatching';
import type { PrintMaterial } from '../lib/printPricing';
import { readReasons } from '../lib/eligibility';
import { loadCatalogue, rematchNow } from '../lib/printMatchingStore';
import { normalizeGovernorate } from '../lib/iraqGovernorates';
import { audit } from '../lib/audit';

/**
 * WHAT A MERCHANT CAN MAKE, AND WHAT THEY WANT TO HEAR ABOUT.
 *
 * Two things live here because they answer the same question from two sides:
 *
 *   PRINTERS are facts. Build volume, technology, materials, nozzle, enclosure.
 *   These decide ELIGIBILITY, and a merchant cannot opt into a job their machine
 *   cannot do — so these are also the fields that must be honest, and the reason
 *   the matcher reads them rather than a free-text "we do everything!".
 *
 *   PREFERENCES are wishes. Which of the jobs they COULD take they want to be
 *   told about: materials, colours, capabilities, governorates, job size, and a
 *   pause switch. These only ever NARROW what a merchant hears; they can never
 *   widen it past what their printers can do.
 *
 * The master on/off switch is NOT here. It is
 * `merchant_notification_preferences.request_opportunities`, which already
 * existed (0030) and already has its own endpoint in worker/routes/merchant.ts.
 * Duplicating it would give a merchant two switches with one meaning, and the
 * day they disagreed nobody would know which one was real.
 */

/*
 * W5-B — CAPABILITY AS DATA. A printer is tied to a canonical machine
 * (`printer_models`) wherever one exists: its physics — technology, build
 * volume, enclosure, which nozzles fit, whether a hardened nozzle or a
 * multi-material unit CAN be fitted — come from that row and a request cannot
 * be widened by typing a bigger bed; the merchant sets only what is theirs
 * (name, nozzle fitted, hardened nozzle / AMS fitted, materials run, best
 * quality, availability) and their ECONOMICS. A machine with no canonical row
 * is still accepted as self-declared and shown as such. The workshop's
 * MATERIAL STOCK lives here too. Every change re-matches this workshop against
 * the open board (worker/lib/printMatchingStore.ts `rematchNow`).
 */
export const merchantPrinterRoutes = new Hono<AppContext>();
// Its own guard rather than borrowing the one on merchantRoutes: a router that
// depends on a sibling's middleware is one re-mount away from being open.
merchantPrinterRoutes.use('*', requireAuth);

const TECHNOLOGIES = ['fdm', 'resin'];
const QUALITIES = ['draft', 'standard', 'fine', 'ultra'];
const AVAILABILITY = ['available', 'busy', 'offline'];
const WORKLOADS = ['light', 'normal', 'busy', 'full'];
const DELIVERY = ['delivery', 'pickup'];

const jsonArray = (raw: unknown, max: number, itemMax: number): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw.slice(0, max)) {
    if (typeof v !== 'string') continue;
    const s = v.trim().slice(0, itemMax);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
};

const parse = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const printerOut = (r: Record<string, unknown>) => ({
  id: r.id,
  name: r.name,
  technology: r.technology,
  brand: r.brand,
  model: r.model,
  build_x_mm: Number(r.build_x_mm ?? 0),
  build_y_mm: Number(r.build_y_mm ?? 0),
  build_z_mm: Number(r.build_z_mm ?? 0),
  nozzle_mm: Number(r.nozzle_mm ?? 0.4),
  materials: parse<string[]>(r.materials, []),
  colors: parse<string[]>(r.colors, []),
  multicolor: !!r.multicolor,
  enclosed: !!r.enclosed,
  hardened_nozzle: !!r.hardened_nozzle,
  quality_max: r.quality_max,
  machine_hour_iqd: r.machine_hour_iqd === null ? null : Number(r.machine_hour_iqd),
  availability: r.availability,
  active: !!r.active,
  sort_order: Number(r.sort_order ?? 0),
  /** The canonical machine this printer is (null = self-declared physics). */
  model_id: (r.model_id as string | null) ?? null,
  canonical: !!r.model_id,
  /** The merchant's own economics — what the costing engine charges for this machine. */
  economics: {
    purchase_iqd: nullableNum(r.purchase_iqd),
    purchase_date: (r.purchase_date as string | null) ?? null,
    residual_iqd: nullableNum(r.residual_iqd),
    useful_print_hours: nullableNum(r.useful_print_hours),
    maintenance_iqd_per_hour: nullableNum(r.maintenance_iqd_per_hour),
    electricity_iqd_per_kwh: nullableNum(r.electricity_iqd_per_kwh),
    labor_iqd_per_hour: nullableNum(r.labor_iqd_per_hour),
  },
});

const nullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The canonical machines a merchant may tie a printer to. Physics only — never economics. */
async function selectableModels(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT id, manufacturer, model, technology, build_x_mm, build_y_mm, build_z_mm, nozzle_sizes,
              default_nozzle_mm, enclosed, hardened_nozzle_available, max_simultaneous_materials, multi_material
         FROM printer_models WHERE merchant_selectable = 1
        ORDER BY technology, sort_order, manufacturer, model`
    )
    .all<Record<string, unknown>>();
  return (results ?? []).map((m) => ({
    id: String(m.id),
    manufacturer: String(m.manufacturer ?? ''),
    model: String(m.model ?? ''),
    technology: m.technology === 'resin' ? 'resin' : 'fdm',
    build_mm: { x: Number(m.build_x_mm ?? 0), y: Number(m.build_y_mm ?? 0), z: Number(m.build_z_mm ?? 0) },
    nozzle_sizes_mm: parse<unknown[]>(m.nozzle_sizes, []).map(Number).filter((n) => n > 0),
    default_nozzle_mm: Number(m.default_nozzle_mm ?? 0),
    enclosed: !!Number(m.enclosed ?? 0),
    hardened_nozzle_available: !!Number(m.hardened_nozzle_available ?? 0),
    max_colors: Math.max(1, Number(m.max_simultaneous_materials ?? 1) || 1),
    multi_material: String(m.multi_material ?? 'none'),
  }));
}

/**
 * RE-MATCH THIS WORKSHOP AFTER ITS CAPABILITY CHANGED — inline, bounded, and
 * left to the scheduled sweep if it cannot finish. The save has committed
 * either way; `rematchNow` never throws.
 */
async function rematchWorkshop(env: Env, merchantId: string, reason: string): Promise<void> {
  await rematchNow(env, 'merchant', merchantId, reason);
}

// ------------------------------------------------------------------ printers

merchantPrinterRoutes.get('/printers', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM merchant_printers WHERE merchant_id = ? ORDER BY sort_order, created_at'
  )
    .bind(ctx.merchant.id)
    .all<Record<string, unknown>>();
  const materials = await getSetting(c.env.DB, 'printMaterials');
  return c.json({
    success: true,
    printers: (results ?? []).map(printerOut),
    // The vocabulary the form needs, so the merchant picks from the same
    // catalogue the matcher and the pricing engine read.
    materials: (materials as PrintMaterial[])
      .filter((m) => m.active !== false)
      .map((m) => ({ id: m.id, process: m.process, name_en: m.name_en, name_ar: m.name_ar, needs_enclosure: m.needs_enclosure, abrasive: m.abrasive })),
    technologies: TECHNOLOGIES,
    qualities: QUALITIES,
    // The canonical machines (W5-B): pick one and its physics are filled in and locked.
    models: await selectableModels(c.env.DB),
  });
});

/** A non-negative whole IQD figure, or null for «not set». */
function money(v: unknown, name: string, max = 1_000_000_000): number | null {
  return v === null || v === undefined || v === '' ? null : int(v, name, { min: 0, max });
}

/**
 * THE PRINTER A MERCHANT MAY SAVE. With `model_id` the physics are the
 * canonical machine's and the request's own values for them are IGNORED
 * (technology, build volume, enclosure); what the merchant chooses must be
 * something that machine can have — a nozzle it takes, a hardened nozzle or
 * a multi-material unit only if one can be fitted — or the save is refused
 * with a code naming the field. Without one, the typed physics stand as a
 * self-declared machine. Materials must be catalogue ids of the printer's
 * technology: an unknown id is REFUSED, never dropped (dropping every entry of
 * a list would turn «only these» into «everything»).
 */
async function readPrinter(env: Env, body: Record<string, unknown>) {
  const modelId = str(body.model_id, 'model_id', { max: 60, required: false }) || null;
  const model = modelId
    ? await env.DB.prepare('SELECT * FROM printer_models WHERE id = ? AND merchant_selectable = 1').bind(modelId).first<Record<string, unknown>>()
    : null;
  if (modelId && !model) throw badRequest('Unknown printer model', 'PRINTER_MODEL_UNKNOWN');

  const technology = model
    ? (model.technology === 'resin' ? 'resin' : 'fdm')
    : TECHNOLOGIES.includes(String(body.technology)) ? String(body.technology) : 'fdm';
  const quality = QUALITIES.includes(String(body.quality_max)) ? String(body.quality_max) : 'fine';
  const availability = AVAILABILITY.includes(String(body.availability)) ? String(body.availability) : 'available';
  const build = model
    ? { x: Number(model.build_x_mm ?? 0), y: Number(model.build_y_mm ?? 0), z: Number(model.build_z_mm ?? 0) }
    : {
        x: int(body.build_x_mm, 'build_x_mm', { min: 0, max: 5000, def: 0 }),
        y: int(body.build_y_mm, 'build_y_mm', { min: 0, max: 5000, def: 0 }),
        z: int(body.build_z_mm, 'build_z_mm', { min: 0, max: 5000, def: 0 }),
      };
  // A printer with no declared build volume can never be matched to anything —
  // the matcher would have to guess, and guessing here means promising a
  // customer a job that does not fit. Better to refuse the row.
  if (build.x <= 0 || build.y <= 0 || build.z <= 0) {
    throw badRequest('Enter the build volume — matching cannot work without it', 'BUILD_VOLUME_REQUIRED');
  }

  const nozzleRaw = typeof body.nozzle_mm === 'number' ? body.nozzle_mm : Number(body.nozzle_mm);
  let nozzle = Number.isFinite(nozzleRaw) && nozzleRaw > 0 && nozzleRaw <= 5 ? nozzleRaw : 0.4;
  let hardened = body.hardened_nozzle === true ? 1 : 0;
  let multicolor = body.multicolor === true ? 1 : 0;
  let enclosed = body.enclosed === true ? 1 : 0;
  let multiMaterial: string | null = null;
  let toolheads: number | null = null;
  if (model) {
    enclosed = Number(model.enclosed ?? 0) ? 1 : 0;
    if (technology === 'resin') {
      nozzle = 0;
      hardened = 0;
      multicolor = 0;
    } else {
      const sizes = parse<unknown[]>(model.nozzle_sizes, []).map(Number).filter((n) => n > 0);
      if (body.nozzle_mm === undefined || body.nozzle_mm === null || body.nozzle_mm === '') nozzle = Number(model.default_nozzle_mm ?? 0.4) || 0.4;
      else if (sizes.length && !sizes.some((n) => Math.abs(n - nozzle) < 1e-6)) {
        throw badRequest('That nozzle does not fit this printer', 'PRINTER_NOZZLE_INVALID', { sizes });
      }
      if (hardened && !Number(model.hardened_nozzle_available ?? 0)) {
        throw badRequest('This printer cannot take a hardened nozzle', 'PRINTER_HARDENED_UNAVAILABLE');
      }
      if (multicolor && !(Number(model.max_simultaneous_materials ?? 1) > 1)) {
        throw badRequest('This printer cannot print several materials at once', 'PRINTER_MULTICOLOR_UNAVAILABLE');
      }
    }
    multiMaterial = multicolor ? String(model.multi_material ?? 'none') : 'none';
    toolheads = Number(model.toolhead_count ?? 1) || 1;
  } else if (technology === 'resin') {
    nozzle = 0;
    hardened = 0;
    multicolor = 0;
  }

  const catalogue = await loadCatalogue(env.DB);
  const materials = jsonArray(body.materials, 40, 60);
  const wrong = materials.filter((id) => catalogue.get(id)?.process !== technology);
  if (wrong.length) throw badRequest('A material is not one this printer can run', 'PRINTER_MATERIAL_INVALID', { materials: wrong });

  const purchaseDate = str(body.purchase_date, 'purchase_date', { max: 10, required: false }) || null;
  if (purchaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw badRequest('Enter the purchase date as a date', 'PRINTER_DATE_INVALID');
  const econ = (body.economics && typeof body.economics === 'object' ? body.economics : body) as Record<string, unknown>;

  return {
    name: str(body.name, 'name', { min: 1, max: 80 }),
    model_id: model ? String(model.id) : null,
    technology,
    brand: model ? String(model.manufacturer ?? '') : str(body.brand, 'brand', { max: 60, required: false }) ?? '',
    model: model ? String(model.model ?? '') : str(body.model, 'model', { max: 60, required: false }) ?? '',
    build,
    nozzle_mm: nozzle,
    materials,
    colors: jsonArray(body.colors, 40, 9).map((x) => x.toLowerCase()).filter((x) => /^#[0-9a-f]{6}$/.test(x)),
    multicolor,
    enclosed,
    hardened_nozzle: hardened,
    multi_material: multiMaterial,
    toolhead_count: toolheads,
    quality_max: quality,
    machine_hour_iqd: money(body.machine_hour_iqd, 'machine_hour_iqd', 1_000_000),
    availability,
    active: body.active === false ? 0 : 1,
    sort_order: int(body.sort_order, 'sort_order', { min: 0, max: 999, def: 0 }),
    purchase_iqd: money(econ.purchase_iqd, 'purchase_iqd'),
    purchase_date: purchaseDate ?? ((econ.purchase_date as string | undefined) && /^\d{4}-\d{2}-\d{2}$/.test(String(econ.purchase_date)) ? String(econ.purchase_date) : null),
    residual_iqd: money(econ.residual_iqd, 'residual_iqd'),
    useful_print_hours: econ.useful_print_hours === null || econ.useful_print_hours === undefined || econ.useful_print_hours === ''
      ? null
      : int(econ.useful_print_hours, 'useful_print_hours', { min: 1, max: 200_000 }),
    maintenance_iqd_per_hour: money(econ.maintenance_iqd_per_hour, 'maintenance_iqd_per_hour', 1_000_000),
    electricity_iqd_per_kwh: money(econ.electricity_iqd_per_kwh, 'electricity_iqd_per_kwh', 100_000),
    labor_iqd_per_hour: money(econ.labor_iqd_per_hour, 'labor_iqd_per_hour', 1_000_000),
  };
}

type PrinterInput = Awaited<ReturnType<typeof readPrinter>>;

/** Every column a save writes, in one order, for both the INSERT and the UPDATE. */
const PRINTER_COLUMNS = [
  'name', 'model_id', 'technology', 'brand', 'model', 'build_x_mm', 'build_y_mm', 'build_z_mm', 'nozzle_mm',
  'materials', 'colors', 'multicolor', 'enclosed', 'hardened_nozzle', 'multi_material', 'toolhead_count',
  'quality_max', 'machine_hour_iqd', 'availability', 'active', 'sort_order', 'purchase_iqd', 'purchase_date',
  'residual_iqd', 'useful_print_hours', 'maintenance_iqd_per_hour', 'electricity_iqd_per_kwh', 'labor_iqd_per_hour',
] as const;

function printerValues(p: PrinterInput): Array<string | number | null> {
  return [
    p.name, p.model_id, p.technology, p.brand, p.model, p.build.x, p.build.y, p.build.z, p.nozzle_mm,
    JSON.stringify(p.materials), JSON.stringify(p.colors), p.multicolor, p.enclosed, p.hardened_nozzle,
    p.multi_material, p.toolhead_count, p.quality_max, p.machine_hour_iqd, p.availability, p.active, p.sort_order,
    p.purchase_iqd, p.purchase_date, p.residual_iqd, p.useful_print_hours, p.maintenance_iqd_per_hour,
    p.electricity_iqd_per_kwh, p.labor_iqd_per_hour,
  ];
}

merchantPrinterRoutes.post('/printers', async (c) => {
  const ctx = await requireStoreOwner(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const p = await readPrinter(c.env, body);
  const id = newId('prn');
  await c.env.DB.prepare(
    `INSERT INTO merchant_printers (id, merchant_id, store_id, ${PRINTER_COLUMNS.join(', ')})
     VALUES (?,?,?,${PRINTER_COLUMNS.map(() => '?').join(',')})`
  )
    .bind(id, ctx.merchant.id, ctx.store.id, ...printerValues(p))
    .run();
  await audit(c.env.DB, c.get('user')!.id, 'merchant.printer_added', id, { model_id: p.model_id, technology: p.technology });
  await rematchWorkshop(c.env, ctx.merchant.id, 'printer');
  const row = await c.env.DB.prepare('SELECT * FROM merchant_printers WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, printer: printerOut(row!) }, 201);
});

merchantPrinterRoutes.put('/printers/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const p = await readPrinter(c.env, body);
  const res = await c.env.DB.prepare(
    `UPDATE merchant_printers
        SET ${PRINTER_COLUMNS.map((col) => `${col}=?`).join(', ')},
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND merchant_id=?`
  )
    .bind(...printerValues(p), id, ctx.merchant.id)
    .run();
  if (!res.meta.changes) throw notFound('Printer not found');
  await audit(c.env.DB, c.get('user')!.id, 'merchant.printer_updated', id, { model_id: p.model_id, technology: p.technology });
  await rematchWorkshop(c.env, ctx.merchant.id, 'printer');
  const row = await c.env.DB.prepare('SELECT * FROM merchant_printers WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, printer: printerOut(row!) });
});

merchantPrinterRoutes.delete('/printers/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const res = await c.env.DB.prepare('DELETE FROM merchant_printers WHERE id = ? AND merchant_id = ?')
    .bind(id, ctx.merchant.id)
    .run();
  if (!res.meta.changes) throw notFound('Printer not found');
  await audit(c.env.DB, c.get('user')!.id, 'merchant.printer_deleted', id, {});
  await rematchWorkshop(c.env, ctx.merchant.id, 'printer');
  return c.json({ success: true });
});

// ------------------------------------------------------------ material stock

/** Lines a workshop may keep. Enough for every material × a palette of colours. */
const STOCK_MAX_LINES = 120;

const stockOut = (r: Record<string, unknown>) => ({
  material_id: String(r.material_id),
  color_hex: String(r.color_hex ?? ''),
  color_name: String(r.color_name ?? ''),
  grams: Number(r.grams ?? 0),
  updated_at: String(r.updated_at ?? ''),
});

/**
 * THE SHELF: material × colour × grams, in the same material ids requests
 * name. `tracked` is false until the workshop saves a line — then stock is a
 * dimension of eligibility (a job in a material or colour the shelf lacks, or
 * heavier than any spool of it, is not this workshop's).
 */
merchantPrinterRoutes.get('/material-stock', async (c) => {
  const ctx = await requireStoreOwner(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM merchant_material_stock WHERE merchant_id = ? ORDER BY material_id, color_hex'
  )
    .bind(ctx.merchant.id)
    .all<Record<string, unknown>>();
  const materials = (await getSetting(c.env.DB, 'printMaterials')) as PrintMaterial[];
  return c.json({
    success: true,
    tracked: (results ?? []).length > 0,
    stock: (results ?? []).map(stockOut),
    materials: materials
      .filter((m) => m.active !== false)
      .map((m) => ({ id: m.id, process: m.process, name_en: m.name_en, name_ar: m.name_ar })),
    max_lines: STOCK_MAX_LINES,
  });
});

/**
 * REPLACE THE SHELF, whole, in one batch (the lines travel as ONE json_each
 * parameter, so D1's bound-parameter limit never applies). Every line is
 * checked — a catalogue material, a #rrggbb colour or none, whole grams
 * 0…1,000,000, no duplicate (material, colour) — and one bad line refuses the
 * lot with its index. An EMPTY list is refused unless `untrack: true` says
 * so: clearing the shelf takes stock out of eligibility, which WIDENS what the
 * workshop is shown, and that must never happen by an accident of a client.
 */
merchantPrinterRoutes.put('/material-stock', async (c) => {
  const ctx = await requireStoreOwner(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const raw = Array.isArray(body.lines) ? body.lines : null;
  if (!raw) throw badRequest('Send the stock lines', 'STOCK_INVALID');
  if (raw.length > STOCK_MAX_LINES) throw badRequest('Too many stock lines', 'STOCK_TOO_MANY', { max: STOCK_MAX_LINES });
  if (!raw.length && body.untrack !== true) {
    throw badRequest('An empty shelf stops stock tracking — confirm it', 'STOCK_UNTRACK_CONFIRM');
  }
  const catalogue = await loadCatalogue(c.env.DB);
  const seen = new Set<string>();
  const lines = raw.map((l, i) => {
    const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const material = String(o.material_id ?? '');
    if (!catalogue.has(material)) throw badRequest('Unknown material', 'STOCK_MATERIAL_INVALID', { index: i });
    const hex = String(o.color_hex ?? '').trim().toLowerCase();
    if (hex && !/^#[0-9a-f]{6}$/.test(hex)) throw badRequest('Colour must be #rrggbb', 'STOCK_COLOR_INVALID', { index: i });
    const grams = Number(o.grams);
    if (!Number.isInteger(grams) || grams < 0 || grams > 1_000_000) throw badRequest('Grams must be a whole number', 'STOCK_GRAMS_INVALID', { index: i });
    const key = `${material}|${hex}`;
    if (seen.has(key)) throw badRequest('The same material and colour twice', 'STOCK_DUPLICATE', { index: i });
    seen.add(key);
    const name = String(o.color_name ?? '').trim().slice(0, 40);
    return { id: newId('mst'), material_id: material, color_hex: hex, color_name: name, grams };
  });
  const ts = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM merchant_material_stock WHERE merchant_id = ?').bind(ctx.merchant.id),
    c.env.DB.prepare(
      `INSERT INTO merchant_material_stock (id, merchant_id, material_id, color_hex, color_name, grams, created_at, updated_at)
       SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.material_id'), json_extract(value, '$.color_hex'),
              json_extract(value, '$.color_name'), json_extract(value, '$.grams'), ?2, ?2
         FROM json_each(?3)`
    ).bind(ctx.merchant.id, ts, JSON.stringify(lines)),
  ]);
  await audit(c.env.DB, c.get('user')!.id, 'merchant.stock_saved', ctx.merchant.id, { lines: lines.length, untracked: !lines.length });
  await rematchWorkshop(c.env, ctx.merchant.id, 'stock');
  return c.json({ success: true, tracked: lines.length > 0, stock: lines.map((l) => stockOut({ ...l, updated_at: ts })) });
});

// -------------------------------------------------------------- preferences

const EMPTY_PREFS = {
  processes: [] as string[],
  materials: [] as string[],
  colors: [] as string[],
  capabilities: [] as string[],
  governorates: [] as string[],
  delivery: [] as string[],
  min_job_iqd: 0,
  max_job_iqd: null as number | null,
  min_size_mm: 0,
  max_size_mm: null as number | null,
  workload: 'normal',
  paused: false,
  paused_until: null as string | null,
};

merchantPrinterRoutes.get('/request-prefs', async (c) => {
  const ctx = await requireStoreOwner(c);
  const row = await c.env.DB.prepare('SELECT * FROM merchant_request_prefs WHERE merchant_id = ?')
    .bind(ctx.merchant.id)
    .first<Record<string, unknown>>();
  // A merchant who has never opened this screen has NO filters, which means
  // "tell me about everything my printers can do". That is the right default:
  // silence should never be read as "not interested".
  const prefs = row
    ? {
        processes: parse<string[]>(row.processes, []),
        materials: parse<string[]>(row.materials, []),
        colors: parse<string[]>(row.colors, []),
        capabilities: parse<string[]>(row.capabilities, []),
        governorates: parse<string[]>(row.governorates, []),
        delivery: parse<string[]>(row.delivery, []),
        min_job_iqd: Number(row.min_job_iqd ?? 0),
        max_job_iqd: row.max_job_iqd === null ? null : Number(row.max_job_iqd),
        min_size_mm: Number(row.min_size_mm ?? 0),
        max_size_mm: row.max_size_mm === null ? null : Number(row.max_size_mm),
        workload: String(row.workload ?? 'normal'),
        paused: !!row.paused,
        paused_until: (row.paused_until as string | null) ?? null,
      }
    : EMPTY_PREFS;

  const materials = (await getSetting(c.env.DB, 'printMaterials')) as PrintMaterial[];
  return c.json({
    success: true,
    prefs,
    vocabulary: {
      processes: TECHNOLOGIES,
      capabilities: CAPABILITIES,
      delivery: DELIVERY,
      workloads: WORKLOADS,
      materials: materials
        .filter((m) => m.active !== false)
        .map((m) => ({ id: m.id, process: m.process, name_en: m.name_en, name_ar: m.name_ar })),
    },
  });
});

merchantPrinterRoutes.put('/request-prefs', async (c) => {
  const ctx = await requireStoreOwner(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const workload = WORKLOADS.includes(String(body.workload)) ? String(body.workload) : 'normal';
  const pausedUntil = str(body.paused_until, 'paused_until', { max: 40, required: false }) ?? '';
  const values = {
    processes: jsonArray(body.processes, 4, 10).filter((x) => TECHNOLOGIES.includes(x)),
    materials: jsonArray(body.materials, 40, 60),
    colors: jsonArray(body.colors, 40, 9).map((x) => x.toLowerCase()),
    capabilities: jsonArray(body.capabilities, 12, 20).filter((x) => (CAPABILITIES as string[]).includes(x)),
    // Stored as closed-list ids where the value names one (a name in any of
    // the three languages is mapped), so the filter compares like with like.
    governorates: jsonArray(body.governorates, 20, 40).map((g) => normalizeGovernorate(g) || g),
    delivery: jsonArray(body.delivery, 4, 20).filter((x) => DELIVERY.includes(x)),
    min_job_iqd: int(body.min_job_iqd, 'min_job_iqd', { min: 0, max: 1_000_000_000, def: 0 }),
    max_job_iqd:
      body.max_job_iqd === null || body.max_job_iqd === undefined || body.max_job_iqd === ''
        ? null
        : int(body.max_job_iqd, 'max_job_iqd', { min: 0, max: 1_000_000_000 }),
    min_size_mm: int(body.min_size_mm, 'min_size_mm', { min: 0, max: 5000, def: 0 }),
    max_size_mm:
      body.max_size_mm === null || body.max_size_mm === undefined || body.max_size_mm === ''
        ? null
        : int(body.max_size_mm, 'max_size_mm', { min: 0, max: 5000 }),
    workload,
    paused: body.paused === true ? 1 : 0,
    paused_until: pausedUntil && !Number.isNaN(Date.parse(pausedUntil)) ? pausedUntil : null,
  };

  await c.env.DB.prepare(
    `INSERT INTO merchant_request_prefs
       (merchant_id, processes, materials, colors, capabilities, governorates, delivery,
        min_job_iqd, max_job_iqd, min_size_mm, max_size_mm, workload, paused, paused_until, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (merchant_id) DO UPDATE SET
       processes=excluded.processes, materials=excluded.materials, colors=excluded.colors,
       capabilities=excluded.capabilities, governorates=excluded.governorates,
       delivery=excluded.delivery, min_job_iqd=excluded.min_job_iqd,
       max_job_iqd=excluded.max_job_iqd, min_size_mm=excluded.min_size_mm,
       max_size_mm=excluded.max_size_mm, workload=excluded.workload,
       paused=excluded.paused, paused_until=excluded.paused_until, updated_at=excluded.updated_at`
  )
    .bind(
      ctx.merchant.id,
      JSON.stringify(values.processes), JSON.stringify(values.materials), JSON.stringify(values.colors),
      JSON.stringify(values.capabilities), JSON.stringify(values.governorates), JSON.stringify(values.delivery),
      values.min_job_iqd, values.max_job_iqd, values.min_size_mm, values.max_size_mm,
      values.workload, values.paused, values.paused_until
    )
    .run();
  await rematchWorkshop(c.env, ctx.merchant.id, 'prefs');

  return c.json({ success: true });
});

/**
 * Why this shop did or did not hear about a request.
 *
 * A merchant who suspects the matcher is ignoring them can read the answer
 * instead of guessing, and so can support. It exposes only THIS merchant's own
 * decisions — never another shop's score.
 */
merchantPrinterRoutes.get('/request-matches', async (c) => {
  const ctx = await requireStoreOwner(c);
  const limit = int(c.req.query().limit, 'limit', { min: 1, max: 100, def: 30 });
  const { results } = await c.env.DB.prepare(
    `SELECT m.request_id, m.eligible, m.reject_reason, m.reasons, m.score, m.notified, m.notify_ok,
            m.revision, m.computed_at, m.created_at, r.title, r.state, r.revision AS r_revision
       FROM community_request_matches m
       JOIN community_requests r ON r.id = m.request_id
      WHERE m.merchant_id = ?
      ORDER BY COALESCE(m.computed_at, m.created_at) DESC
      LIMIT ?`
  )
    .bind(ctx.merchant.id, limit)
    .all<Record<string, unknown>>();
  return c.json({
    success: true,
    matches: (results ?? []).map((r) => ({
      request_id: r.request_id,
      title: r.title,
      state: r.state,
      eligible: !!r.eligible,
      reject_reason: r.reject_reason,
      /** Every failing reason (W5-B), in policy order. */
      reasons: readReasons(r.reasons),
      notified: !!r.notified,
      /** Decided for the request as it is now (false: an older revision's verdict). */
      current: Number(r.revision ?? 0) === Number(r.r_revision ?? 1),
      created_at: r.computed_at ?? r.created_at,
    })),
  });
});
