/**
 * WHICH PRINTER A PART FITS (migration 0148) — the one writer and every reader.
 *
 * «في مواد الصيانة عند إضافة المنتج في الحقول يكون هذه القطعة مخصصة لأي طابعه
 * … مثلا الفوهة تكون مخصصة لطابعات متعددة مثل A1, A1 mini و A2L … بحيث تفيد
 * عند الفلترة مواد الصيانه لطابعه معينه، وتفيد في صيانه وطلب صيانه الطابعه،
 * وتفيد في الخوارزمية عندما يشتري المستخدم طابعة معينة يظهر له اقتراحات مواد
 * الصيانة» (owner, 2026-09-27).
 *
 * A LINK BETWEEN TWO CATALOGUE PRODUCTS, not a spec string, because every use
 * the owner named is a join on a product id: the listing filter, the printer
 * page's shelf, the suggestions for a printer an order line names, the parts a
 * maintenance request can quote. The free-text «يناسب الموديلات» spec stays
 * what it was — prose for machines this shop does not sell.
 *
 * WHAT COUNTS AS A PRINTER is the owner's own flag and nothing else:
 * `catalogs.is_printer_catalog` reached through `product_catalogs`
 * (worker/lib/printerIdentity.ts) — the flag the gift, warranty and review
 * rules already read. A laser machine is filed in a printer catalog, so a
 * replacement lens can name the cutter it fits.
 *
 * WHAT A SHOPPER SEES is only what they could open: a printer that is not
 * `active` is kept in the admin's list (a part can be linked to a printer
 * before it is published) and left out of every storefront answer.
 *
 * AHEAD OF ITS MIGRATION. A Worker can reach production a deploy before 0148
 * reaches D1. Every reader then answers "no links" — which is TRUE of a table
 * that does not exist, not a guess — and the writer refuses only a save that
 * actually asks for a link, naming the migration, so an owner can still
 * correct a price in that window.
 */
import { badRequest, unavailable } from './http';
import { isMissingTable } from './membershipBenefits';
import { printerProductIds } from './printerIdentity';

/** How many printers one part may name. A nozzle fits a family, not a catalogue. */
export const MAX_PRINTER_FITS = 40;

/** «مواد الصيانة» (0148) — the section the storefront's shelves and suggestions list. */
export const MAINTENANCE_ROOT_ID = 'cat_maint';

/** «المستعمل» (0147) — a used listing is one unit, not a model. */
const USED_ROOT_ID = 'cat_used';

/**
 * A READ OF THE LINKS THAT ANSWERS "NONE" WHILE 0148 IS NOT APPLIED — which is
 * true of a table that does not exist, not a guess. Only a missing TABLE
 * degrades (`isMissingTable`); anything else is an error and is thrown. No
 * probe first: the listing and the product page are hot paths, and a probe
 * would be a round trip on every one of them for a window that lasts minutes.
 */
async function orNone<T>(run: () => Promise<T>, none: T): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (isMissingTable(e)) return none;
    throw e;
  }
}

/** Is the table there yet? One PRAGMA, the same probe the search index uses — for the WRITER. */
export async function printerFitsInstalled(db: D1Database): Promise<boolean> {
  try {
    const rows = await db.prepare('PRAGMA table_info("product_printer_fits")').all<{ name: string }>();
    return (rows.results ?? []).length > 0;
  } catch {
    return false;
  }
}

/** A printer as the admin picker and the storefront chips name it. */
export interface FitPrinter {
  id: string;
  slug: string;
  /** `products.name` — the English/source name. */
  name_en: string;
  name_ar: string;
  /** `products.name_ku` — Sorani. */
  name_ckb: string;
  status: string;
  /** Filed under «المستعمل»: one used unit rather than a model. */
  used: boolean;
}

interface PrinterRow {
  id: string;
  slug: string;
  name: string | null;
  name_ar: string | null;
  name_ku: string | null;
  status: string;
  category_id: string | null;
  sub_category_id: string | null;
}

/** Every catalog id at or under «المستعمل», walked from the live tree. */
async function usedSubtree(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT id, parent_id FROM catalogs').all<{ id: string; parent_id: string | null }>();
  const children = new Map<string, string[]>();
  for (const r of results ?? []) {
    if (!r.parent_id) continue;
    const list = children.get(r.parent_id) ?? [];
    list.push(r.id);
    children.set(r.parent_id, list);
  }
  const out = new Set<string>();
  const stack = [USED_ROOT_ID];
  while (stack.length && out.size < 500) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

const toPrinter = (r: PrinterRow, used: Set<string>): FitPrinter => ({
  id: String(r.id),
  slug: String(r.slug),
  name_en: String(r.name ?? ''),
  name_ar: String(r.name_ar ?? ''),
  name_ckb: String(r.name_ku ?? ''),
  status: String(r.status),
  used: used.has(String(r.category_id ?? '')) || used.has(String(r.sub_category_id ?? '')),
});

/**
 * THE ADMIN PICKER'S LIST: every printer in the catalogue, whatever its status.
 * Models first, then used units; published before hidden and drafts; by name.
 */
export async function printerOptions(db: D1Database): Promise<FitPrinter[]> {
  const [{ results }, used] = await Promise.all([
    db
      .prepare(
        `SELECT p.id, p.slug, p.name, p.name_ar, p.name_ku, p.status, p.category_id, p.sub_category_id
           FROM products p
          WHERE p.composition = ''
            AND EXISTS (SELECT 1 FROM product_catalogs pc
                          JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                         WHERE pc.product_id = p.id)
          LIMIT 500`
      )
      .all<PrinterRow>(),
    usedSubtree(db),
  ]);
  const rank = (s: string) => (s === 'active' ? 0 : s === 'hidden' ? 1 : 2);
  return (results ?? [])
    .map((r) => toPrinter(r, used))
    .sort(
      (a, b) =>
        Number(a.used) - Number(b.used) ||
        rank(a.status) - rank(b.status) ||
        (a.name_en || a.name_ar).localeCompare(b.name_en || b.name_ar, 'en', { sensitivity: 'base', numeric: true })
    );
}

/** The ids one product fits, in the order the admin chose. [] before 0148. */
export async function loadPrinterFitIds(db: D1Database, productId: string): Promise<string[]> {
  return orNone(async () => {
    const { results } = await db
      .prepare('SELECT printer_id FROM product_printer_fits WHERE product_id = ? ORDER BY position, printer_id')
      .bind(productId)
      .all<{ printer_id: string }>();
    return (results ?? []).map((r) => String(r.printer_id));
  }, [] as string[]);
}

/** Printer ids → their slugs, in the same order — how a file names them. */
export async function printerSlugs(db: D1Database, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare('SELECT id, slug FROM products WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids))
    .all<{ id: string; slug: string }>();
  const byId = new Map((results ?? []).map((r) => [String(r.id), String(r.slug)]));
  return ids.map((id) => byId.get(id) ?? id);
}

/**
 * THE WRITER: `product_printer_fits` for this product → exactly `requested`,
 * in that order. Statements only — they ride in the product save's own batch
 * (worker/lib/productPersistence.ts), so the link and the product land
 * together or not at all.
 *
 * Refused, by name: an id that is not a printer in the catalogue, the product
 * itself, and more than MAX_PRINTER_FITS. Duplicates collapse to the first.
 */
export async function planPrinterFits(
  db: D1Database,
  productId: string,
  requested: readonly string[]
): Promise<{ stmts: D1PreparedStatement[]; ids: string[] }> {
  const ids: string[] = [];
  for (const raw of requested) {
    const id = String(raw ?? '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_PRINTER_FITS) {
    throw badRequest(`printer_fit_ids: at most ${MAX_PRINTER_FITS} printers / ${MAX_PRINTER_FITS} طابعة كحد أقصى`, 'PRINTER_FITS_INVALID');
  }
  if (ids.includes(productId)) {
    throw badRequest('printer_fit_ids: a product cannot fit itself / لا يمكن ربط المنتج بنفسه', 'PRINTER_FITS_INVALID');
  }
  if (!(await printerFitsInstalled(db))) {
    // Nothing asked, nothing to write — the save goes through in the window.
    if (ids.length === 0) return { stmts: [], ids };
    throw unavailable(
      'Compatible printers need migration 0148 — apply the database migrations first / ميزة الطابعات المتوافقة تحتاج ترحيل قاعدة البيانات 0148',
      'SERVICE_SETUP'
    );
  }
  if (ids.length) {
    const printers = await printerProductIds(db, ids);
    const bad = ids.find((id) => !printers.has(id));
    if (bad) {
      throw badRequest(
        `printer_fit_ids: "${bad}" is not a printer in the catalogue / «${bad}» ليست طابعة في المتجر`,
        'PRINTER_FITS_INVALID'
      );
    }
  }
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM product_printer_fits WHERE product_id = ?').bind(productId),
    ...ids.map((printerId, position) =>
      db
        .prepare('INSERT INTO product_printer_fits (product_id, printer_id, position) VALUES (?, ?, ?)')
        .bind(productId, printerId, position)
    ),
  ];
  return { stmts, ids };
}

/**
 * The ACTIVE printers each of these products fits, in the admin's order — the
 * product page's «يناسب» chips and the listing's printer filter. Products with
 * no link are absent from the map.
 */
export async function activeFitsFor(db: D1Database, productIds: readonly string[]): Promise<Map<string, FitPrinter[]>> {
  const out = new Map<string, FitPrinter[]>();
  const wanted = [...new Set(productIds.filter(Boolean))];
  if (!wanted.length) return out;
  const rows = await orNone(async () => {
    const { results } = await db
      .prepare(
        `SELECT f.product_id AS part_id, pr.id, pr.slug, pr.name, pr.name_ar, pr.name_ku, pr.status,
                pr.category_id, pr.sub_category_id
           FROM product_printer_fits f
           JOIN products pr ON pr.id = f.printer_id AND pr.status = 'active'
          WHERE f.product_id IN (SELECT value FROM json_each(?))
          ORDER BY f.product_id, f.position, f.printer_id`
      )
      .bind(JSON.stringify(wanted))
      .all<PrinterRow & { part_id: string }>();
    return results ?? [];
  }, [] as Array<PrinterRow & { part_id: string }>);
  // `used` is the admin picker's grouping; a shopper is never told it, so the
  // catalogs read behind it is not paid for on the listing's hot path.
  const noUsed = new Set<string>();
  for (const r of rows) {
    const list = out.get(String(r.part_id)) ?? [];
    list.push(toPrinter(r, noUsed));
    out.set(String(r.part_id), list);
  }
  return out;
}

/**
 * How many ACTIVE maintenance parts fit each of these printers — the printer
 * page decides from this whether to ask for its shelf, and the devices page
 * whether to offer the link. Only parts filed at or under «مواد الصيانة».
 */
export async function maintenancePartCounts(db: D1Database, printerIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = [...new Set(printerIds.filter(Boolean))];
  if (!wanted.length) return out;
  const results = await orNone(async () => (await db
    .prepare(
      `WITH RECURSIVE maint(id) AS (
         SELECT id FROM catalogs WHERE id = ?
         UNION SELECT c.id FROM catalogs c JOIN maint m ON c.parent_id = m.id
       )
       SELECT f.printer_id, COUNT(DISTINCT f.product_id) AS n
         FROM product_printer_fits f
         JOIN products p ON p.id = f.product_id AND p.status = 'active' AND p.composition = ''
        WHERE f.printer_id IN (SELECT value FROM json_each(?))
          AND (p.category_id IN (SELECT id FROM maint)
               OR p.sub_category_id IN (SELECT id FROM maint)
               OR EXISTS (SELECT 1 FROM product_catalogs pc WHERE pc.product_id = p.id AND pc.catalog_id IN (SELECT id FROM maint)))
        GROUP BY f.printer_id`
    )
    .bind(MAINTENANCE_ROOT_ID, JSON.stringify(wanted))
    .all<{ printer_id: string; n: number }>()).results ?? [], [] as Array<{ printer_id: string; n: number }>);
  for (const r of results) out.set(String(r.printer_id), Number(r.n) || 0);
  return out;
}

/** A printer model whose maintenance parts apply to one product, with their count. */
export interface MaintenanceTarget extends FitPrinter {
  /** Active parts at or under «مواد الصيانة» linked to this model. */
  count: number;
}

/**
 * FOR EACH OF THESE PRODUCTS — a printer, or a used unit of one — THE MODEL
 * WHOSE MAINTENANCE PARTS APPLY, and how many there are. A used unit is read
 * as its model through `condition.new_product_id`, the link a graded listing
 * already carries for its price comparison. Products that are not printers
 * with parts are absent from the map. Three reads for any number of products.
 */
export async function maintenanceFor(db: D1Database, productIds: readonly string[]): Promise<Map<string, MaintenanceTarget>> {
  const out = new Map<string, MaintenanceTarget>();
  const wanted = [...new Set(productIds.filter(Boolean))];
  if (!wanted.length) return out;
  const { results: modelRows } = await db
    .prepare(
      `SELECT p.id,
              COALESCE(NULLIF(CASE WHEN json_valid(p.condition_doc) THEN json_extract(p.condition_doc, '$.new_product_id') END, ''), p.id) AS model_id
         FROM products p
        WHERE p.id IN (SELECT value FROM json_each(?))`
    )
    .bind(JSON.stringify(wanted))
    .all<{ id: string; model_id: string }>();
  const modelOf = new Map((modelRows ?? []).map((r) => [String(r.id), String(r.model_id)]));
  const counts = await maintenancePartCounts(db, [...new Set(modelOf.values())]);
  const withParts = [...counts.entries()].filter(([, n]) => n > 0).map(([id]) => id);
  if (!withParts.length) return out;
  const { results: rows } = await db
    .prepare(
      `SELECT id, slug, name, name_ar, name_ku, status, category_id, sub_category_id
         FROM products WHERE status = 'active' AND id IN (SELECT value FROM json_each(?))`
    )
    .bind(JSON.stringify(withParts))
    .all<PrinterRow>();
  const noUsed = new Set<string>();
  const models = new Map((rows ?? []).map((r) => [String(r.id), { ...toPrinter(r, noUsed), count: counts.get(String(r.id)) ?? 0 }]));
  for (const [productId, modelId] of modelOf) {
    const model = models.get(modelId);
    if (model) out.set(productId, model);
  }
  return out;
}
