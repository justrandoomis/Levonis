import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, notFound, str, int } from '../lib/http';
import { newId } from '../lib/crypto';
import { requireStoreOwner } from '../lib/merchantAuth';
import { getSetting } from '../lib/settings';
import { CAPABILITIES } from '../lib/printMatching';
import type { PrintMaterial } from '../lib/printPricing';

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
});

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
  });
});

function readPrinter(body: Record<string, unknown>) {
  const technology = TECHNOLOGIES.includes(String(body.technology)) ? String(body.technology) : 'fdm';
  const quality = QUALITIES.includes(String(body.quality_max)) ? String(body.quality_max) : 'fine';
  const availability = AVAILABILITY.includes(String(body.availability)) ? String(body.availability) : 'available';
  const build = {
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
  const nozzleRaw = typeof body.nozzle_mm === 'number' ? body.nozzle_mm : 0.4;
  return {
    name: str(body.name, 'name', { min: 1, max: 80 }),
    technology,
    brand: str(body.brand, 'brand', { max: 60, required: false }) ?? '',
    model: str(body.model, 'model', { max: 60, required: false }) ?? '',
    build,
    nozzle_mm: Number.isFinite(nozzleRaw) && nozzleRaw > 0 && nozzleRaw <= 5 ? nozzleRaw : 0.4,
    materials: jsonArray(body.materials, 40, 60),
    colors: jsonArray(body.colors, 40, 9).map((x) => x.toLowerCase()),
    multicolor: body.multicolor === true ? 1 : 0,
    enclosed: body.enclosed === true ? 1 : 0,
    hardened_nozzle: body.hardened_nozzle === true ? 1 : 0,
    quality_max: quality,
    machine_hour_iqd:
      body.machine_hour_iqd === null || body.machine_hour_iqd === undefined || body.machine_hour_iqd === ''
        ? null
        : int(body.machine_hour_iqd, 'machine_hour_iqd', { min: 0, max: 1_000_000 }),
    availability,
    active: body.active === false ? 0 : 1,
    sort_order: int(body.sort_order, 'sort_order', { min: 0, max: 999, def: 0 }),
  };
}

merchantPrinterRoutes.post('/printers', async (c) => {
  const ctx = await requireStoreOwner(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const p = readPrinter(body);
  const id = newId('prn');
  await c.env.DB.prepare(
    `INSERT INTO merchant_printers
       (id, merchant_id, store_id, name, technology, brand, model,
        build_x_mm, build_y_mm, build_z_mm, nozzle_mm, materials, colors,
        multicolor, enclosed, hardened_nozzle, quality_max, machine_hour_iqd,
        availability, active, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      id, ctx.merchant.id, ctx.store.id, p.name, p.technology, p.brand, p.model,
      p.build.x, p.build.y, p.build.z, p.nozzle_mm,
      JSON.stringify(p.materials), JSON.stringify(p.colors),
      p.multicolor, p.enclosed, p.hardened_nozzle, p.quality_max, p.machine_hour_iqd,
      p.availability, p.active, p.sort_order
    )
    .run();
  const row = await c.env.DB.prepare('SELECT * FROM merchant_printers WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, printer: printerOut(row!) }, 201);
});

merchantPrinterRoutes.put('/printers/:id', async (c) => {
  const ctx = await requireStoreOwner(c);
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const p = readPrinter(body);
  const res = await c.env.DB.prepare(
    `UPDATE merchant_printers
        SET name=?, technology=?, brand=?, model=?, build_x_mm=?, build_y_mm=?, build_z_mm=?,
            nozzle_mm=?, materials=?, colors=?, multicolor=?, enclosed=?, hardened_nozzle=?,
            quality_max=?, machine_hour_iqd=?, availability=?, active=?, sort_order=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND merchant_id=?`
  )
    .bind(
      p.name, p.technology, p.brand, p.model, p.build.x, p.build.y, p.build.z,
      p.nozzle_mm, JSON.stringify(p.materials), JSON.stringify(p.colors),
      p.multicolor, p.enclosed, p.hardened_nozzle, p.quality_max, p.machine_hour_iqd,
      p.availability, p.active, p.sort_order, id, ctx.merchant.id
    )
    .run();
  if (!res.meta.changes) throw notFound('Printer not found');
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
  return c.json({ success: true });
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
    governorates: jsonArray(body.governorates, 20, 40),
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
    `SELECT m.request_id, m.eligible, m.reject_reason, m.score, m.notified, m.created_at,
            r.title, r.state
       FROM community_request_matches m
       JOIN community_requests r ON r.id = m.request_id
      WHERE m.merchant_id = ?
      ORDER BY m.created_at DESC
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
      notified: !!r.notified,
      created_at: r.created_at,
    })),
  });
});
