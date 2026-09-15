/**
 * WRITING THE (MODEL x ORDER TYPE) AND (MODEL x ROUTE) CELLS.
 *
 * The owner's rule, and the reason this file is separate from the rest of the
 * relations writer:
 *
 *   "لا تنشئ Pre-order / Direct / Air / Sea / Land كـProduct Options."
 *
 * The structure endpoint (`PUT /:id/relations`) writes MODELS — option groups,
 * option values, colours, images. This one writes what each model does:
 * whether it sells directly, whether it can be pre-ordered, what each route
 * costs, how long each takes. Keeping the two doors apart is what makes the
 * first rule enforceable: a payload for models cannot invent an order type,
 * and a payload for order types cannot invent a model.
 *
 * A save is a REPLACEMENT, like every other relations write here: whatever the
 * admin sends is what the product has afterwards. That is the only shape that
 * lets a cell be removed at all, and it matches what `planProductSave` already
 * does for groups and values.
 */
import { badRequest } from './http';
import { newId } from './crypto';
import type { OptionValueRow } from './productRelations';

export const FULFILLMENT_TYPES = ['direct_sale', 'pre_order'] as const;
export const TRANSPORT_METHODS = ['air', 'sea', 'land'] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];
export type TransportMethod = (typeof TRANSPORT_METHODS)[number];

/** The eight money columns every rung of the ladder carries. */
export interface CellPrices {
  regular_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  cost_iqd: number | null;
  regular_adjust_iqd: number | null;
  prime_adjust_iqd: number | null;
  pro_adjust_iqd: number | null;
  cost_adjust_iqd: number | null;
}

export interface LeadTime {
  lead_time_text: string;
  lead_time_min_days: number | null;
  lead_time_max_days: number | null;
}

export interface TransportCell extends CellPrices, LeadTime {
  method: TransportMethod;
  enabled: boolean;
  surcharge_iqd: number | null;
  sort: number;
  /**
   * 0075 — THIS ROUTE'S OWN PRE-ORDER QUOTA, or null.
   *
   * null = this route draws on the fulfilment cell's SHARED pool, so selling
   * one unit by air leaves one fewer for sea and for land. A number = this
   * route holds its own quota, independent of the pool and of the other two
   * routes, and it does NOT also spend the pool: one counter per sale.
   *
   * NOTHING COPIES A QUANTITY ONTO THE THREE ROUTES, here or anywhere else —
   * "لا تكرر نفس الكمية تلقائيًا على الطرق الثلاث". Each route is written only
   * if the admin wrote it.
   */
  capacity: number | null;
}

export interface FulfillmentCell extends CellPrices, LeadTime {
  option_id: string;
  fulfillment_type: FulfillmentType;
  enabled: boolean;
  sort: number;
  /**
   * 0075 — THE MODEL'S SHARED PRE-ORDER POOL, or null for UNTRACKED.
   *
   * null = no limit is claimed and pre-orders are unlimited, which is what
   * every existing cell carries and how the shop behaved before 0075. 0 = the
   * pool is tracked and empty, and a pre-order is refused. The two are
   * different answers and the resolver never conflates them.
   *
   * MEANINGLESS ON A direct_sale CELL, and refused there: the direct-sale
   * number is the MODEL's stock (`product_option_values.stock`), one source
   * per actual selection. See `parseFulfillmentPayload`.
   */
  capacity: number | null;
  transports: TransportCell[];
}

// ---------------------------------------------------------------------------

/** A money field: an integer ≥ 0, or null for "inherit the rung beneath". */
function money(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) throw badRequest(`${field} must be a whole number of dinars, or empty to inherit`);
  return n;
}

/** An adjustment: a SIGNED integer, or null. Zero is a real value, not empty. */
function adjust(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n)) throw badRequest(`${field} must be a whole number of dinars, or empty`);
  return n;
}

/**
 * A CAPACITY: a whole number of units >= 0, or null for UNTRACKED.
 *
 * `''`, null and undefined all mean UNTRACKED — the field was left blank, and
 * a blank capacity claims no limit. `0` is a real, tracked value meaning "none
 * available right now" and must survive the round trip, which is why the check
 * is on emptiness and not on falsiness.
 */
function capacity(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) {
    throw badRequest(`${field} must be a whole number of units (0 or more), or empty for unlimited`);
  }
  if (n > 1_000_000) throw badRequest(`${field} is larger than this shop can plan for`);
  return n;
}

function days(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0 || n > 3650) throw badRequest(`${field} must be a whole number of days`);
  return n;
}

function prices(row: Record<string, unknown>, where: string): CellPrices {
  return {
    regular_price_iqd: money(row.regular_price_iqd, `${where}.regular_price_iqd`),
    prime_price_iqd: money(row.prime_price_iqd, `${where}.prime_price_iqd`),
    pro_price_iqd: money(row.pro_price_iqd, `${where}.pro_price_iqd`),
    cost_iqd: money(row.cost_iqd, `${where}.cost_iqd`),
    regular_adjust_iqd: adjust(row.regular_adjust_iqd, `${where}.regular_adjust_iqd`),
    prime_adjust_iqd: adjust(row.prime_adjust_iqd, `${where}.prime_adjust_iqd`),
    pro_adjust_iqd: adjust(row.pro_adjust_iqd, `${where}.pro_adjust_iqd`),
    cost_adjust_iqd: adjust(row.cost_adjust_iqd, `${where}.cost_adjust_iqd`),
  };
}

function leadTime(row: Record<string, unknown>, where: string): LeadTime {
  const min = days(row.lead_time_min_days, `${where}.lead_time_min_days`);
  const max = days(row.lead_time_max_days, `${where}.lead_time_max_days`);
  if (min !== null && max !== null && min > max) {
    throw badRequest(`${where}: the shortest lead time cannot be longer than the longest`);
  }
  return {
    lead_time_text: String(row.lead_time_text ?? '').trim().slice(0, 200),
    lead_time_min_days: min,
    lead_time_max_days: max,
  };
}

/**
 * VALIDATE A WHOLE PAYLOAD AGAINST THE MODELS THAT ACTUALLY EXIST.
 *
 * `validOptionIds` is the set of live option rows for this product, read from
 * the database rather than trusted from the request — a cell naming a model
 * that is not there, or a model belonging to a different product, is a payload
 * that would create an unreachable price.
 */
export function parseFulfillmentPayload(
  body: unknown,
  validOptionIds: Set<string>
): FulfillmentCell[] {
  const raw = (body as { fulfillments?: unknown })?.fulfillments;
  if (!Array.isArray(raw)) throw badRequest('fulfillments must be an array');
  if (raw.length > 200) throw badRequest('Too many order-type cells in one save');

  const cells: FulfillmentCell[] = [];
  const seenCell = new Set<string>();

  raw.forEach((entry, i) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const where = `fulfillments[${i}]`;
    const optionId = String(row.option_id ?? '').trim();
    if (!optionId) throw badRequest(`${where}.option_id is required`);
    if (!validOptionIds.has(optionId)) {
      throw badRequest(`${where}.option_id names a model that is not on this product`, 'UNKNOWN_OPTION');
    }
    const type = String(row.fulfillment_type ?? '').trim() as FulfillmentType;
    if (!FULFILLMENT_TYPES.includes(type)) {
      throw badRequest(`${where}.fulfillment_type must be direct_sale or pre_order`);
    }
    // ONE CELL PER (MODEL, ORDER TYPE) — the same rule the unique index holds,
    // refused here with a sentence instead of a constraint error.
    const cellKey = `${optionId}|${type}`;
    if (seenCell.has(cellKey)) throw badRequest(`${where}: this model already has a ${type} cell`);
    seenCell.add(cellKey);

    const transportsRaw = Array.isArray(row.transports) ? row.transports : [];
    if (type === 'direct_sale' && transportsRaw.length) {
      // A DIRECT SALE HAS NO JOURNEY. Air/sea/land is how a unit reaches Iraq,
      // which is a pre-order's question; local delivery is a separate, later
      // choice that lives in ops_policy and never here.
      throw badRequest(`${where}: a direct sale has no transport — air/sea/land belongs to a pre-order`, 'TRANSPORT_ON_DIRECT');
    }
    /**
     * A DIRECT SALE HAS NO CAPACITY OF ITS OWN (0075, DECISION 1/2).
     *
     * Its availability IS the model's stock — the row `products.inventory_mode`
     * already selects — and accepting a second number here would give the shop
     * two places to be wrong about one physical shelf, which is the fork 0073
     * warned about and the owner forbids ("لا تنشئ نظامًا موازيًا"). Refused
     * with the field to use instead, because a silent drop would let an admin
     * type 50 into a box and believe they had set something.
     */
    const cellCapacity = capacity(row.capacity, `${where}.capacity`);
    if (type === 'direct_sale' && cellCapacity !== null) {
      throw badRequest(
        `${where}: a direct sale has no capacity of its own — set the model's stock instead`,
        'CAPACITY_ON_DIRECT'
      );
    }
    const seenMethod = new Set<string>();
    const transports: TransportCell[] = transportsRaw.map((t, j) => {
      const tr = (t ?? {}) as Record<string, unknown>;
      const tWhere = `${where}.transports[${j}]`;
      const method = String(tr.method ?? '').trim() as TransportMethod;
      if (!TRANSPORT_METHODS.includes(method)) throw badRequest(`${tWhere}.method must be air, sea or land`);
      if (seenMethod.has(method)) throw badRequest(`${tWhere}: ${method} is listed twice`);
      seenMethod.add(method);
      return {
        method,
        enabled: tr.enabled !== false,
        surcharge_iqd: money(tr.surcharge_iqd, `${tWhere}.surcharge_iqd`),
        sort: Number.isInteger(tr.sort) ? (tr.sort as number) : j,
        // Left exactly as sent. A blank stays null — this route keeps drawing
        // on the shared pool — and nothing here copies the cell's number, or
        // another route's, onto it.
        capacity: capacity(tr.capacity, `${tWhere}.capacity`),
        ...prices(tr, tWhere),
        ...leadTime(tr, tWhere),
      };
    });

    cells.push({
      option_id: optionId,
      fulfillment_type: type,
      enabled: row.enabled !== false,
      sort: Number.isInteger(row.sort) ? (row.sort as number) : i,
      capacity: cellCapacity,
      transports,
      ...prices(row, where),
      ...leadTime(row, where),
    });
  });

  return cells;
}

/**
 * WHAT A ROW ALREADY IS, so a replace does not destroy what only the ledger
 * can put back (0075).
 *
 * `id` — a cell's row id is `inventory_ledger.scope_id` for every pre-order
 * unit it is holding. Mint a new one on a save and the release for a live
 * order aims at a row that no longer exists: the hold never comes back and the
 * units are stranded for ever, invisibly. So a cell that is still in the
 * payload KEEPS ITS ID.
 *
 * `capacity_reserved` — the units held AT THE MOMENT OF THE READ. It is never
 * sent by an admin form and never derived from one, and `fulfillmentStatements`
 * DOES NOT WRITE IT BACK: a number read before the batch is stale by the time
 * the batch runs, and writing it back is how a checkout that committed in
 * between had its hold erased. The count here is read-only evidence, used to
 * REFUSE a save that would strand a hold (`refuseStrandedCapacity`) and to
 * report one that vanished (`verifyApplied`). The row keeps its own count.
 */
export interface ExistingCells {
  /** key: `<option_id>|<fulfillment_type>` */
  cells: Map<string, { id: string; capacity_reserved: number }>;
  /** key: `<option_id>|<fulfillment_type>|<method>` */
  transports: Map<string, { id: string; capacity_reserved: number }>;
}

export const cellKey = (optionId: string, type: string) => `${optionId}|${type}`;
export const transportKey = (optionId: string, type: string, method: string) =>
  `${optionId}|${type}|${method}`;

/**
 * WHAT THE PRODUCT'S CELLS ARE RIGHT NOW, KEYED THE WAY THE REPLACE LOOKS THEM
 * UP (0075).
 *
 * Every caller of `fulfillmentStatements` on an EXISTING product needs this,
 * and each one deriving it for itself is how the two paths drift: the admin
 * fulfilment door would keep a live pre-order's hold and a whole-product save
 * would silently mint new row ids and zero `capacity_reserved`, stranding the
 * units — `inventory_ledger.scope_id` names the row that no longer exists, so
 * the release for that order matches nothing and no screen can show where the
 * units went. One builder, both doors.
 *
 * A transport is keyed by its CELL's (option, type) rather than by
 * `fulfillment_id`, because the payload side has no row ids at all — it names
 * a model, an order type and a route. A transport whose cell has vanished is
 * skipped: it cannot be matched to anything in the payload, and the FK drops
 * it with the cell.
 */
export function existingCellsFrom(
  fulfillments: readonly {
    id: string;
    option_id: string;
    fulfillment_type: string;
    capacity_reserved?: number | null;
  }[],
  transports: readonly {
    id: string;
    fulfillment_id: string;
    method: string;
    capacity_reserved?: number | null;
  }[]
): ExistingCells {
  const byId = new Map(fulfillments.map((f) => [f.id, f] as const));
  const out: ExistingCells = { cells: new Map(), transports: new Map() };
  for (const f of fulfillments) {
    out.cells.set(cellKey(f.option_id, String(f.fulfillment_type)), {
      id: f.id,
      capacity_reserved: f.capacity_reserved ?? 0,
    });
  }
  for (const t of transports) {
    const cell = byId.get(t.fulfillment_id);
    if (!cell) continue;
    out.transports.set(transportKey(cell.option_id, String(cell.fulfillment_type), String(t.method)), {
      id: t.id,
      capacity_reserved: t.capacity_reserved ?? 0,
    });
  }
  return out;
}

/**
 * A SAVE MAY NOT STRAND SOMEBODY'S PRE-ORDER (0075).
 *
 * Two ways it could, and both are refused here with the count rather than left
 * to a constraint error:
 *
 *  1. REMOVING a cell or a route that is holding units. The hold lives in that
 *    row's `capacity_reserved`, and `inventory_ledger.scope_id` names the row;
 *    delete it and the release for a live order matches nothing, so the units
 *    are never given back and no screen can show where they went. This is the
 *    same rule `/:id/relations` already applies to a stock row with reserved
 *    units, applied to the counter 0075 added.
 *
 * EVERY WRITER INHERITS IT, not just the admin panel. A TXT template and a
 * CSV sheet reach the same rows through `planProductSave`, and a file is the
 * likeliest way to cut a quota by accident — nobody reviews a spreadsheet row
 * by row. So the check lives beside the statements it guards rather than in
 * one route, and a caller that forgets to run it is the defect.
 *
 *  2. LOWERING a capacity BELOW what is already held. `available` would go
 *    negative — clamped to 0 everywhere, so the shop looks merely sold out —
 *    and then the `deduct` at confirmation, which guards on
 *    `capacity >= qty`, would silently match nothing and leave a confirmed
 *    order that never consumed its unit. An admin who really wants to cut the
 *    quota must cancel the orders first, which is a decision, not a side
 *    effect of a form save.
 *
 *  3. GOING UNTRACKED — capacity back to NULL — WHILE UNITS ARE HELD. This was
 *    permitted, because the check above reads `capacity !== null && capacity <
 *    held` and a NULL capacity is neither. It is STRICTLY WORSE than lowering
 *    the number to 0, and this is the whole reason it has its own refusal:
 *
 *      the deduct guard in worker/lib/inventory.ts is
 *      `<on_hand> IS NOT NULL AND <on_hand> >= ? AND <reserved> >= ?`,
 *
 *    so once the column is NULL that WHERE clause can never match again. The
 *    held units can never be deducted and never released:
 *    `capacity_reserved` stays non-zero for ever, `planOrderDeduction` answers
 *    `rejected: [{ reason: 'NOT_TRACKED' }]`, and the operator note at
 *    worker/lib/orderStageOps.ts tells staff to "check the product stock
 *    before shipping" — naming a counter that was never involved. Re-tracking
 *    it afterwards is then blocked for ever by CAPACITY_BELOW_RESERVED,
 *    because any number is below a hold that can no longer be released.
 *
 *    "Untracked" is a claim that NOTHING is outstanding, so it is only true
 *    when nothing is held. The refusal says what to do instead: clear the
 *    orders, or keep a number.
 */
export function refuseStrandedCapacity(existing: ExistingCells, cells: FulfillmentCell[]): void {
  const keptCells = new Set(cells.map((c) => cellKey(c.option_id, c.fulfillment_type)));
  const keptRoutes = new Set(
    cells.flatMap((c) => c.transports.map((t) => transportKey(c.option_id, c.fulfillment_type, t.method)))
  );

  for (const [key, row] of existing.cells) {
    if (row.capacity_reserved > 0 && !keptCells.has(key)) {
      throw badRequest(
        `This order type is holding ${row.capacity_reserved} pre-ordered unit(s) — cancel or fulfil those orders before removing it.`,
        'CAPACITY_RESERVED'
      );
    }
  }
  for (const [key, row] of existing.transports) {
    if (row.capacity_reserved > 0 && !keptRoutes.has(key)) {
      throw badRequest(
        `This transport route is holding ${row.capacity_reserved} pre-ordered unit(s) — cancel or fulfil those orders before removing it.`,
        'CAPACITY_RESERVED'
      );
    }
  }

  for (const cell of cells) {
    const held = existing.cells.get(cellKey(cell.option_id, cell.fulfillment_type))?.capacity_reserved ?? 0;
    // Case 3, BEFORE the comparison — a NULL capacity is not "below" anything,
    // which is exactly how it used to slip past.
    if (cell.capacity === null && held > 0) {
      throw badRequest(
        `This order type is holding ${held} pre-ordered unit(s), so its capacity cannot be cleared to untracked — ` +
          `leave a number of at least ${held}, or cancel or fulfil those orders first.`,
        'CAPACITY_UNTRACKED_WHILE_HELD'
      );
    }
    if (cell.capacity !== null && cell.capacity < held) {
      throw badRequest(
        `Capacity cannot be set below the ${held} unit(s) already held for live pre-orders.`,
        'CAPACITY_BELOW_RESERVED'
      );
    }
    for (const t of cell.transports) {
      const routeHeld =
        existing.transports.get(transportKey(cell.option_id, cell.fulfillment_type, t.method))?.capacity_reserved ?? 0;
      if (t.capacity === null && routeHeld > 0) {
        throw badRequest(
          `${t.method}: this route is holding ${routeHeld} pre-ordered unit(s), so its quota cannot be cleared to ` +
            `untracked — leave a number of at least ${routeHeld}, or cancel or fulfil those orders first.`,
          'CAPACITY_UNTRACKED_WHILE_HELD'
        );
      }
      if (t.capacity !== null && t.capacity < routeHeld) {
        throw badRequest(
          `${t.method}: capacity cannot be set below the ${routeHeld} unit(s) already held for live pre-orders.`,
          'CAPACITY_BELOW_RESERVED'
        );
      }
    }
  }
}

/**
 * THE STATEMENTS THAT MAKE THE PRODUCT'S CELLS EXACTLY THIS SET.
 *
 * AN UPSERT PER SURVIVING ROW, NOT A DELETE-THEN-INSERT. A cell's SETTINGS
 * have no identity a customer ever sees — it IS (model, order type) — so
 * rewriting them loses nothing. Its HELD UNITS and its ROW ID are not
 * settings: `inventory_ledger.scope_id` names this exact row for every
 * pre-order unit it is holding, and `capacity_reserved` is the hold itself.
 *
 * SO THIS WRITER NEVER NAMES `capacity_reserved`, IN EITHER TABLE. That is the
 * shape `product_option_values` has always had — its upsert lists `stock` and
 * never `reserved`, which is why an ordinary relations save cannot lose a
 * model's reservation — and it is the only shape that is correct under
 * concurrency. The previous version re-inserted the row binding the count the
 * caller had READ WHEN THE PLAN WAS BUILT, so a checkout that reserved a unit
 * between that read and this batch had its hold written back to the stale
 * number: the ledger kept the reserve row, the counter did not, and the
 * release for that live order could then never match. A held count is not a
 * setting a save may carry in its hand; it belongs to the row, and the row is
 * the only thing that knows it.
 *
 * WHAT IS STILL A REPLACE. Whatever the payload describes is what the product
 * has afterwards: a cell or route the payload dropped is DELETED here, exactly
 * as before. Only the rows that survive are addressed by id, so the delete is
 * "everything of this product except these ids" rather than "everything".
 *
 * THE DELETE ASKS THE ROW, TOO. A row that is holding units is not deleted,
 * whatever the plan-time read believed — including a cell whose CASCADE would
 * take a holding route down with it. `refuseStrandedCapacity` already refuses
 * such a save at the door, but it judges a read taken before the batch, and in
 * the window between them a checkout can take a hold on the very row the
 * payload drops. Losing the admin's removal is recoverable and is reported by
 * the read-back net (`verifyApplied`, section `inventory`); stranding a
 * customer's units is neither.
 *
 * A caller that passes no `existing` map keeps the pre-0075 behaviour exactly:
 * nothing is kept, so the delete is unrestricted and every row is written
 * fresh.
 */
export function fulfillmentStatements(
  db: { prepare(sql: string): D1PreparedStatement },
  productId: string,
  cells: FulfillmentCell[],
  makeId: () => string = () => newId('ofl'),
  existing?: ExistingCells
): D1PreparedStatement[] {
  /**
   * One pass to settle every row id BEFORE any statement is built: the delete
   * needs the ids that survive, and the upserts need the same ids. Deriving
   * them twice is how the two lists drift apart and a surviving row is deleted
   * anyway.
   */
  const planned = cells.map((cell) => {
    const kept = existing?.cells.get(cellKey(cell.option_id, cell.fulfillment_type));
    return {
      cell,
      id: kept?.id ?? makeId(),
      /** Only a row that ALREADY EXISTS may be excluded from the delete. */
      survives: !!kept,
      transports: cell.transports.map((t) => {
        const keptRoute = existing?.transports.get(
          transportKey(cell.option_id, cell.fulfillment_type, t.method)
        );
        return { t, id: keptRoute?.id ?? makeId(), survives: !!keptRoute };
      }),
    };
  });

  const keptCellIds = planned.filter((p) => p.survives).map((p) => p.id);
  const keptRouteIds = planned.flatMap((p) => p.transports.filter((r) => r.survives).map((r) => r.id));

  /**
   * THE SURVIVORS RIDE AS ONE JSON PARAMETER, not one placeholder each — the
   * same idiom, for the same reason, as the bundle component cleanup in
   * worker/lib/bundleCart.ts. `parseFulfillmentPayload` accepts up to 200
   * cells and each may carry three routes, which is more ids than D1 accepts
   * bound parameters in one query, and a `NOT IN` list cannot be chunked the
   * way a positive one can: each chunk would delete the rows every other chunk
   * is keeping. `json_each` of an empty array yields no rows, and `x NOT IN
   * (<empty>)` is TRUE, so a caller that supplies no `existing` map gets
   * exactly the unrestricted delete this function performed before 0075.
   */
  const out: D1PreparedStatement[] = [
    // A route that is holding units survives the replace rather than taking
    // its hold with it. NULL `capacity_reserved` cannot occur (NOT NULL
    // DEFAULT 0, migration 0075) and is not coalesced away here either.
    db
      .prepare(
        `DELETE FROM product_option_transports
          WHERE product_id = ?
            AND capacity_reserved = 0
            AND id NOT IN (SELECT value FROM json_each(?))`
      )
      .bind(productId, JSON.stringify(keptRouteIds)),
    // …and neither does a cell, directly or through the CASCADE that would
    // drop its routes with it.
    db
      .prepare(
        `DELETE FROM product_option_fulfillment
          WHERE product_id = ?
            AND capacity_reserved = 0
            AND id NOT IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (SELECT 1 FROM product_option_transports t
                             WHERE t.fulfillment_id = product_option_fulfillment.id
                               AND t.capacity_reserved > 0)`
      )
      .bind(productId, JSON.stringify(keptCellIds)),
  ];

  for (const { cell, id, transports } of planned) {
    out.push(
      db
        .prepare(
          `INSERT INTO product_option_fulfillment
             (id, product_id, option_id, fulfillment_type, enabled,
              regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd,
              regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd,
              lead_time_text, lead_time_min_days, lead_time_max_days, sort,
              capacity)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (id) DO UPDATE SET
             product_id = excluded.product_id,
             option_id = excluded.option_id,
             fulfillment_type = excluded.fulfillment_type,
             enabled = excluded.enabled,
             regular_price_iqd = excluded.regular_price_iqd,
             prime_price_iqd = excluded.prime_price_iqd,
             pro_price_iqd = excluded.pro_price_iqd,
             cost_iqd = excluded.cost_iqd,
             regular_adjust_iqd = excluded.regular_adjust_iqd,
             prime_adjust_iqd = excluded.prime_adjust_iqd,
             pro_adjust_iqd = excluded.pro_adjust_iqd,
             cost_adjust_iqd = excluded.cost_adjust_iqd,
             lead_time_text = excluded.lead_time_text,
             lead_time_min_days = excluded.lead_time_min_days,
             lead_time_max_days = excluded.lead_time_max_days,
             sort = excluded.sort,
             capacity = excluded.capacity`
        )
        .bind(
          id,
          productId,
          cell.option_id,
          cell.fulfillment_type,
          cell.enabled ? 1 : 0,
          cell.regular_price_iqd,
          cell.prime_price_iqd,
          cell.pro_price_iqd,
          cell.cost_iqd,
          cell.regular_adjust_iqd,
          cell.prime_adjust_iqd,
          cell.pro_adjust_iqd,
          cell.cost_adjust_iqd,
          cell.lead_time_text,
          cell.lead_time_min_days,
          cell.lead_time_max_days,
          cell.sort,
          // A direct-sale cell is parsed with `capacity: null` and could carry
          // nothing else — the parser refuses it — so this is the pre-order
          // pool or nothing. `capacity_reserved` is ABSENT from both halves of
          // this statement: a new row takes the column's DEFAULT 0, and an
          // existing row keeps whatever it is holding right now.
          cell.capacity
        )
    );
    for (const { t, id: routeId } of transports) {
      out.push(
        db
          .prepare(
            `INSERT INTO product_option_transports
               (id, product_id, fulfillment_id, method, enabled, surcharge_iqd,
                regular_price_iqd, prime_price_iqd, pro_price_iqd, cost_iqd,
                regular_adjust_iqd, prime_adjust_iqd, pro_adjust_iqd, cost_adjust_iqd,
                lead_time_text, lead_time_min_days, lead_time_max_days, sort,
                capacity)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT (id) DO UPDATE SET
               product_id = excluded.product_id,
               fulfillment_id = excluded.fulfillment_id,
               method = excluded.method,
               enabled = excluded.enabled,
               surcharge_iqd = excluded.surcharge_iqd,
               regular_price_iqd = excluded.regular_price_iqd,
               prime_price_iqd = excluded.prime_price_iqd,
               pro_price_iqd = excluded.pro_price_iqd,
               cost_iqd = excluded.cost_iqd,
               regular_adjust_iqd = excluded.regular_adjust_iqd,
               prime_adjust_iqd = excluded.prime_adjust_iqd,
               pro_adjust_iqd = excluded.pro_adjust_iqd,
               cost_adjust_iqd = excluded.cost_adjust_iqd,
               lead_time_text = excluded.lead_time_text,
               lead_time_min_days = excluded.lead_time_min_days,
               lead_time_max_days = excluded.lead_time_max_days,
               sort = excluded.sort,
               capacity = excluded.capacity`
          )
          .bind(
            routeId,
            productId,
            id,
            t.method,
            t.enabled ? 1 : 0,
            t.surcharge_iqd,
            t.regular_price_iqd,
            t.prime_price_iqd,
            t.pro_price_iqd,
            t.cost_iqd,
            t.regular_adjust_iqd,
            t.prime_adjust_iqd,
            t.pro_adjust_iqd,
            t.cost_adjust_iqd,
            t.lead_time_text,
            t.lead_time_min_days,
            t.lead_time_max_days,
            t.sort,
            // As above: this route's own quota, never its hold.
            t.capacity
          )
      );
    }
  }
  return out;
}

/**
 * THE PRODUCT'S SALE TYPES FOLLOW ITS MODELS — the same direction 0043
 * established, extended to the cells. A product whose models all sell one way
 * IS that one way; a product with both is both. Derived, never asked for, so
 * the product row and its models cannot disagree.
 */
export function saleTypesFromCells(
  values: OptionValueRow[],
  cells: FulfillmentCell[],
  fallback: readonly string[]
): string[] {
  const live = new Set(values.filter((v) => !String(v.merged_into ?? '').trim()).map((v) => v.id));
  const types = new Set<string>();
  for (const cell of cells) {
    if (!cell.enabled || !live.has(cell.option_id)) continue;
    types.add(cell.fulfillment_type);
  }
  if (!types.size) return [...fallback];
  // Keep the stored order stable so a save is not a no-op diff every time.
  return ['direct_sale', 'pre_order'].filter((t) => types.has(t));
}

// ---------------------------------------------------------------------------
//  THE OLD SHAPE CANNOT COME BACK
// ---------------------------------------------------------------------------

/**
 * "لا تنشئ Pre-order / Direct / Air / Sea / Land كـProduct Options."
 *
 * Migration 0073 merged the old shape away. This is what stops the next save
 * from recreating it — in the FORM and in the TXT importer alike, because both
 * reach the same validator.
 *
 * TWO SIGNALS, and both are specific enough to have no false positive worth
 * worrying about:
 *
 *   1. TWO LIVE MODELS SHARING A `variant_key`. That is not a judgement call:
 *      `variant_key` exists for exactly one purpose — to say "these two option
 *      rows are the same model" — so two rows sharing one IS the old shape,
 *      by the field's own definition.
 *
 *   2. A NAME THE LEGACY PARSER WOULD READ AS AN ORDER TYPE. The test is not a
 *      new regex invented here; it is `availabilityFromName`, the function that
 *      would actually treat the name as a route. If the store's own parser
 *      would read "A1 mini — Pre-order" as a pre-order, then naming an option
 *      that is creating the old shape, and the admin is told to use the order
 *      types on the model instead.
 *
 * A row that ALREADY EXISTS with either signal is left alone: this refuses new
 * ones, it does not make an untouched legacy product unsavable. That is the
 * difference between blocking a shape and breaking a catalogue.
 */
export interface ModelShapeInput {
  id: string;
  name_en: string;
  variant_key: string;
  active: number | boolean;
}

export function legacyShapeErrors(
  incoming: ModelShapeInput[],
  existing: ReadonlyMap<string, { name_en: string; variant_key: string }>,
  availabilityFromName: (name: string) => string
): string[] {
  const errors: string[] = [];
  const isNew = (v: ModelShapeInput) => !existing.has(v.id);
  const nameChanged = (v: ModelShapeInput) => existing.get(v.id)?.name_en !== v.name_en;
  const keyChanged = (v: ModelShapeInput) => existing.get(v.id)?.variant_key !== v.variant_key;

  const live = incoming.filter((v) => v.active !== 0 && v.active !== false);

  const byKey = new Map<string, ModelShapeInput[]>();
  for (const v of live) {
    const key = v.variant_key.trim();
    if (!key) continue;
    const arr = byKey.get(key);
    if (arr) arr.push(v);
    else byKey.set(key, [v]);
  }
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    // Untouched legacy rows stay saveable; a NEW or RENAMED duplicate does not.
    if (!group.some((v) => isNew(v) || keyChanged(v))) continue;
    errors.push(
      `"${group.map((v) => v.name_en).join('" و "')}" هما نفس الموديل (${key}) — ` +
        'الموديل يُذكر مرة واحدة، ونوع الطلب (بيع مباشر / طلب مسبق) يُضبط عليه. ' +
        `/ these are one model (${key}): a model is listed once, and its order types are set on it.`
    );
  }

  for (const v of live) {
    if (!isNew(v) && !nameChanged(v)) continue;
    if (!availabilityFromName(v.name_en)) continue;
    errors.push(
      `"${v.name_en}": نوع الطلب ليس خيار منتج — اضبط البيع المباشر / الطلب المسبق على الموديل نفسه. ` +
        '/ an order type is not a product option — set direct sale / pre-order on the model itself.'
    );
  }

  return errors;
}
