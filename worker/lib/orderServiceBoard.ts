/**
 * «خصص طابعتك» ON THE ADMIN ORDER SCREENS (owner, 2026-11-21; DECISIONS row 364).
 *
 * What the order BOARD needs to know of each order's printer services — the badges, the filters and the
 * inspection hold — and the small readings the receipt, the waybill and the label share. Every reader
 * here tolerates a database behind its migration (0234 tasks / snapshot, 0235 membership line and
 * purchases, 0244 draws): the answer is then «nothing», never an error on the board.
 *
 * Customer facts only: what was bought and what staff must do. No cost, margin or investor figure.
 */
import { safeParse } from './types';

type Row = Record<string, unknown>;

/** An order in one of these states has no warehouse work left: its service tasks cannot be completed. */
export const ENDED_ORDER_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'returned', 'refunded']);

/** The membership bought with the order is the one top-level line that is not in the parcel; a gift and a draw prize are. */
export const isPhysicalLine = (it: Row): boolean => it.line_kind !== 'membership';

export const BOARD_SERVICE_FILTERS = ['printer_services', 'inspection', 'pickup', 'care', 'academy', 'membership_pending'] as const;
export type BoardServiceFilter = (typeof BOARD_SERVICE_FILTERS)[number];

export interface BoardServiceFacts {
  /** A line of the order carries printer services. */
  printer_services: boolean;
  /** The package of its serviced lines; 'mixed' when they differ. */
  package: 'just' | 'smart' | 'complete' | 'custom' | 'mixed' | null;
  /** Levo Care was bought on a line. */
  care: boolean;
  /** No warranty was bought on some serviced line. */
  no_warranty: boolean;
  /** The store's pickup method. */
  pickup: boolean;
  /** An inspection bought on the order is still open: it may not be handed over. */
  inspection_open: boolean;
  /** A live Academy session is still to be scheduled. */
  academy_open: boolean;
  /** The membership bought with the order waits (pending) or needs a person (blocked). */
  membership: 'pending' | 'blocked' | null;
}

const missing = (e: unknown) => /no such (table|column)/i.test(e instanceof Error ? e.message : String(e));

/** Runs a tolerant read: [] when the table or column is not there yet. */
async function rowsOrNone<T>(run: () => Promise<{ results?: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).results ?? [];
  } catch (e) {
    if (missing(e)) return [];
    throw e;
  }
}

/**
 * The page's service facts: the lines already loaded for the page (no read), plus ONE read of the open
 * tasks and ONE of the waiting memberships for the page's ids. Only orders with something to say are in
 * the map, so an ordinary order's row carries no new field.
 */
export async function boardServiceFacts(
  db: D1Database,
  orderIds: readonly string[],
  itemsByOrder: ReadonlyMap<string, readonly Row[]>,
  orders: readonly Row[]
): Promise<Map<string, BoardServiceFacts>> {
  const out = new Map<string, BoardServiceFacts>();
  if (!orderIds.length) return out;
  const blank = (): BoardServiceFacts => ({
    printer_services: false, package: null, care: false, no_warranty: false, pickup: false, inspection_open: false, academy_open: false, membership: null,
  });
  const of = (id: string) => {
    let f = out.get(id);
    if (!f) { f = blank(); out.set(id, f); }
    return f;
  };
  for (const [orderId, items] of itemsByOrder) {
    for (const it of items) {
      if (typeof it.services_snapshot !== 'string' || !it.services_snapshot) continue;
      const v = safeParse<Row | null>(it.services_snapshot, null);
      if (!v || typeof v !== 'object') continue;
      const f = of(orderId);
      f.printer_services = true;
      const sel = v.selection && typeof v.selection === 'object' ? (v.selection as Row) : null;
      const pkg = sel && (sel.package === 'just' || sel.package === 'smart' || sel.package === 'complete' || sel.package === 'custom') ? sel.package : null;
      if (pkg) f.package = f.package === null || f.package === pkg ? pkg : 'mixed';
      if (Number(v.care_months) > 0) f.care = true;
      if (!(Number(v.warranty_months) > 0)) f.no_warranty = true;
    }
  }
  // The store pickup is said on the row only where it changes the packer's work: a serviced printer.
  for (const o of orders) {
    const f = out.get(String(o.id));
    if (f && String(o.delivery_method_id ?? '') === 'pickup') f.pickup = true;
  }
  const idsJson = JSON.stringify(orderIds);
  const tasks = await rowsOrNone(() => db
    .prepare("SELECT order_id, kind FROM order_service_tasks WHERE status = 'open' AND kind IN ('inspection','academy') AND order_id IN (SELECT value FROM json_each(?))")
    .bind(idsJson).all<{ order_id: string; kind: string }>());
  for (const t of tasks) {
    const f = of(String(t.order_id));
    if (t.kind === 'inspection') f.inspection_open = true;
    else f.academy_open = true;
  }
  const waiting = await rowsOrNone(() => db
    .prepare("SELECT order_id, state FROM order_membership_purchases WHERE state IN ('pending','blocked') AND order_id IN (SELECT value FROM json_each(?))")
    .bind(idsJson).all<{ order_id: string; state: string }>());
  for (const m of waiting) {
    const f = of(String(m.order_id));
    f.membership = m.state === 'blocked' || f.membership === 'blocked' ? 'blocked' : 'pending';
  }
  return out;
}

const SERVICED_LINE = "i.services_snapshot IS NOT NULL AND i.services_snapshot <> ''";

/**
 * The board filter as a WHERE clause on `orders o` (no parameters). '0' — no order — when the table or
 * column the filter reads is not there yet, so the statement always runs.
 */
export async function boardServiceClause(db: D1Database, service: BoardServiceFilter): Promise<string> {
  const reads = async (sql: string): Promise<boolean> => {
    try {
      await db.prepare(sql).first();
      return true;
    } catch (e) {
      if (missing(e)) return false;
      throw e;
    }
  };
  switch (service) {
    case 'pickup':
      // A serviced printer collected from the store — the pickup that changes what staff do with it.
      return (await reads('SELECT services_snapshot FROM order_items LIMIT 1'))
        ? `o.delivery_method_id = 'pickup' AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND ${SERVICED_LINE})`
        : '0';
    case 'printer_services':
      return (await reads('SELECT services_snapshot FROM order_items LIMIT 1'))
        ? `EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND ${SERVICED_LINE})`
        : '0';
    case 'care':
      // json_valid first: an unguarded json_extract over a row whose text is not JSON throws.
      return (await reads('SELECT services_snapshot FROM order_items LIMIT 1'))
        ? `EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND ${SERVICED_LINE} AND json_valid(i.services_snapshot) AND COALESCE(json_extract(i.services_snapshot, '$.care_months'), 0) > 0)`
        : '0';
    case 'inspection':
    case 'academy':
      return (await reads('SELECT 1 FROM order_service_tasks LIMIT 1'))
        ? `EXISTS (SELECT 1 FROM order_service_tasks t WHERE t.order_id = o.id AND t.kind = '${service}' AND t.status = 'open')`
        : '0';
    case 'membership_pending':
      return (await reads('SELECT 1 FROM order_membership_purchases LIMIT 1'))
        ? "EXISTS (SELECT 1 FROM order_membership_purchases m WHERE m.order_id = o.id AND m.state IN ('pending','blocked'))"
        : '0';
  }
}

/**
 * How many orders wait on staff for each of the three service filters that are WORK, board-wide like the
 * price-hold counts: an inspection to do (live orders), an Academy session to schedule (any order not
 * cancelled — it is arranged after delivery), a membership waiting or blocked (live orders). 0 on any failure.
 */
export async function boardServiceCounts(db: D1Database): Promise<{ inspection: number; academy: number; membership_pending: number }> {
  const one = async (sql: string): Promise<number> => {
    try {
      return Number((await db.prepare(sql).first<{ n: number }>())?.n ?? 0);
    } catch {
      return 0;
    }
  };
  const [inspection, academy, membership] = await Promise.all([
    one("SELECT COUNT(DISTINCT t.order_id) AS n FROM order_service_tasks t JOIN orders o ON o.id = t.order_id WHERE t.kind = 'inspection' AND t.status = 'open' AND o.status NOT IN ('delivered','cancelled')"),
    one("SELECT COUNT(DISTINCT t.order_id) AS n FROM order_service_tasks t JOIN orders o ON o.id = t.order_id WHERE t.kind = 'academy' AND t.status = 'open' AND o.status <> 'cancelled'"),
    one("SELECT COUNT(DISTINCT m.order_id) AS n FROM order_membership_purchases m JOIN orders o ON o.id = m.order_id WHERE m.state IN ('pending','blocked') AND o.status NOT IN ('delivered','cancelled')"),
  ]);
  return { inspection, academy, membership_pending: membership };
}

/** The order's gift lines that are the monthly Levo Care draw's prize (care_draws.gift_id, 0244); [] before the migration. */
export async function drawPrizeItemIds(db: D1Database, items: readonly Row[]): Promise<string[]> {
  const gifts = items.filter((it) => typeof it.gift_entitlement_id === 'string' && it.gift_entitlement_id !== '');
  if (!gifts.length) return [];
  const rows = await rowsOrNone(() => db
    .prepare('SELECT gift_id FROM care_draws WHERE gift_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(gifts.map((it) => String(it.gift_entitlement_id)))).all<{ gift_id: string }>());
  const prize = new Set(rows.map((r) => String(r.gift_id)));
  return gifts.filter((it) => prize.has(String(it.gift_entitlement_id))).map((it) => String(it.id));
}

const PACKAGE_WORDS: Record<string, { ar: string; en: string }> = {
  just: { ar: 'الطابعة فقط', en: 'Just Printer' },
  smart: { ar: 'الاختيار الذكي', en: 'Smart Choice' },
  complete: { ar: 'التجربة الكاملة', en: 'Complete' },
  custom: { ar: 'مخصّص', en: 'Custom' },
};

/**
 * The lines printed under an item on the purchase receipt (ar / en — the paper's two languages): what was
 * bought with a printer (package, warranty months or «بلا ضمان», the whole Levo Care cover, extra
 * packaging, inspection, live Academy), that a kit or add-on line is packed with its printer, a gift, the
 * membership, and a Levo Care part discount by its name.
 */
export function receiptServiceNotes(
  it: Row,
  services: { selection: Record<string, unknown> | null; lines: Array<{ service: string; choice: string }>; warranty_months: number; care_total_months: number; delivery: string | null } | null,
  careDiscountIqd: number
): Array<{ ar: string; en: string }> {
  const notes: Array<{ ar: string; en: string }> = [];
  if (services) {
    const pkg = PACKAGE_WORDS[String(services.selection?.package ?? '')];
    if (pkg) notes.push({ ar: `الباقة: ${pkg.ar}`, en: `Package: ${pkg.en}` });
    notes.push(services.warranty_months > 0
      ? { ar: `الضمان: ${services.warranty_months} شهراً من يوم التسليم`, en: `Warranty: ${services.warranty_months} months from delivery` }
      : { ar: 'بلا ضمان — بموافقة الزبون', en: 'No warranty — agreed by the customer' });
    if (services.care_total_months > 0) {
      notes.push({ ar: `ليفو كير: حتى ${services.care_total_months} شهراً من يوم التسليم`, en: `Levo Care: until ${services.care_total_months} months from delivery` });
    }
    const has = (service: string, ...choices: string[]) => services.lines.some((l) => l.service === service && choices.includes(l.choice));
    if (has('packaging', 'extra')) notes.push({ ar: 'تغليف حماية إضافي', en: 'Extra protective packaging' });
    if (has('inspection', 'full')) notes.push({ ar: 'فحص كامل قبل الإرسال', en: 'Full inspection before dispatch' });
    if (has('academy', 'live_whatsapp', 'live_in_person')) notes.push({ ar: 'دورة تعليمية مباشرة', en: 'Live training session' });
    if (services.delivery === 'pickup') notes.push({ ar: 'استلام من المخزن', en: 'Collected from the store' });
    else if (services.delivery === 'economy' || services.delivery === 'personal') notes.push({ ar: 'توصيل إلى المنزل', en: 'Home delivery' });
  }
  if (typeof it.kit_parent_item_id === 'string' && it.kit_parent_item_id) {
    notes.push(typeof it.addon_id === 'string' && it.addon_id
      ? { ar: 'إضافة مع الطابعة', en: 'Add-on with the printer' }
      : { ar: 'ضمن باقة الفيلامنت مع الطابعة', en: 'Filament kit with the printer' });
  }
  if (it.line_kind === 'membership') notes.push({ ar: 'عضوية — ليست في الطرد', en: 'Membership — not in the parcel' });
  if (typeof it.gift_entitlement_id === 'string' && it.gift_entitlement_id !== '') notes.push({ ar: 'هدية — 0 د.ع', en: 'Gift — 0 IQD' });
  if (careDiscountIqd > 0) {
    const n = careDiscountIqd.toLocaleString('en-US');
    notes.push({ ar: `خصم ليفو كير على قطعة: -${n} د.ع`, en: `Levo Care part discount: -${n} IQD` });
  }
  return notes;
}
