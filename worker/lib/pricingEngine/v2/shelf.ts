/**
 * PRICING V2 — THE SHELF A COST-FIRST PRICE IS READ FROM (owner decisions of
 * 2026-10-17, DECISIONS rows 244 and 249; docs/PRICING-V2.md §10).
 *
 *   1. A model with units on the shelf is priced, for the DIRECT sale, from the
 *      HIGHEST landed unit cost among its batches still on the shelf
 *      (`inventory_lots.qty_remaining > 0`, the effective cost of each batch —
 *      its latest cost version, as FIFO and the batch card read it). No unit is
 *      then ever sold below its cost + the minimum profit, and the price stays
 *      put while the shelf sells: it moves only when a costlier batch arrives or
 *      the costliest one sells out.
 *   2. A shelf that is sold out goes back to the supplier calculation; without
 *      one the model is not sold (priceV2.ts V2_STOCK_SOLD_OUT) and the owner's
 *      bell rings — never a silent stale price.
 *   3. THE DOLLAR IS THE ANCHOR (row 249, modifying row 244's formula: «الدولار
 *      هو الأساس … والدينار هو المتغير بسعر الصرف»). A batch's effective dinars
 *      are divided by ITS purchase-time U (`inventory_lots.usd_iqd_rate_at_purchase`,
 *      0182) into micro-dollars — in SQL, one expression (`lotUsdMicroSql`) the
 *      shelf read and the sweep's signature share, so the two can never disagree —
 *      and the highest is priced at TODAY's U: R_shelf = ceil(max USD × U). A batch
 *      with no purchase rate (an opening batch, or one received before 0182)
 *      keeps its dinars as paid; the shelf's cost is the higher of the two. The
 *      maths (priceV2) receive whole dinars as before, so D − R_shelf ≥ T × U
 *      still holds at publication.
 *
 * WHICH BATCHES ARE A SKU'S SHELF is the cart's own stock rule
 * (worker/lib/inventory.ts `resolveStock`), by the product's CURRENT inventory
 * mode — batches left under another mode's scope are not on its shelf:
 *   BASE                 the product's own batches;
 *   OPTION               the batches of each option value the SKU selects (its model,
 *                        and any other stocked option): a unit sold consumes one
 *                        from each, so their costs ADD and the units are the fewest;
 *   COLOR                the batches of its colour;
 *   VARIANT_COMBINATION  the batches of the variant whose combo_key is the SKU's.
 * A batch whose cost is unknown («تكلفة غير معروفة», an opening batch without
 * a cost) never sets the price: the highest KNOWN cost does, and a shelf where
 * no remaining batch has a known cost is priced as if it had none (the supplier
 * calculation).
 *
 * WHEN IT IS READ AGAIN. Every V2 evaluation reads the shelf as it is (the
 * owner's preview, a save, the automatic repricing). The automatic repricing
 * (autoReprice.ts) knows a shelf moved by its SIGNATURE (`shelf:v2`): a hash of
 * each shelf identity's state (its highest known cost in micro-dollars and in
 * unrated dinars, «unknown», or «sold out» — never today's U, so a rate move is
 * the `USD` reason, not `STOCK`) stored
 * on `product_pricing_state.shelf_sig` (migration 0198) by every V2 write,
 * against today's — computed inside the sweep's one states read
 * (`shelfItemsSql`), so a tick with nothing to do costs no statement more.
 * Units are not in it, so a sale that leaves the costliest batch on the shelf
 * changes nothing; a batch received, a sale, an adjustment or a return that
 * moves any identity's highest cost — or empties it — makes the product stale
 * ('STOCK') for the quarter-hour sweep, the existing repricing queue.
 *
 * PRIVATE: every figure here is the owner's (row 220). Nothing logs a cost, a
 * unit count or a signature's input; the stored signature is a hash.
 */
import { sha256Hex } from '../../crypto';
import { ceilToPlaces, compareProcurementExact, mulProcurementExact, procurementExact, procurementExactText, quotientProcurementExact } from '@levonis/contracts/procurementCost';
import { isInventoryMode, type InventoryMode } from '../../inventory';
import type { V2Shelf } from '@levonis/pricing/priceV2';

/** One shelf identity of a product: its batches, summed. */
export interface ShelfIdentity {
  scope: 'base' | 'option' | 'color' | 'variant';
  scope_id: string;
  /** VARIANT_COMBINATION: the variant's combo_key (the SKU identity); null otherwise. */
  combo_key: string | null;
  /** The highest known unit cost (whole dinars as paid) among its batches still on the shelf; null when none is known (display). */
  cost_iqd: number | null;
  /** Row 249: the highest known cost in micro-dollars among its batches with a purchase rate; null when none. */
  cost_usd_micro: number | null;
  /**
   * Row 249: that costliest rated batch exactly — its dinars and its purchase U — so today's dinars are
   * ceil(dinars × U_today ÷ U_purchase), and the dinars as paid when U has not moved. Absent or null: the
   * micro-dollars alone are priced (a hand-built shelf).
   */
  cost_usd_lot?: { iqd: number; rate: string } | null;
  /** Row 249: the highest known cost (dinars as paid) among its batches WITHOUT a purchase rate; null when none. */
  cost_iqd_unrated: number | null;
  /** Units still on the shelf (every batch, known cost or not). */
  units: number;
}

/** A product's shelf, under its current inventory mode. */
export interface ProductShelf {
  mode: InventoryMode;
  identities: ShelfIdentity[];
}

const SCOPE_OF_MODE: Readonly<Record<InventoryMode, ShelfIdentity['scope']>> = {
  BASE: 'base',
  OPTION: 'option',
  COLOR: 'color',
  VARIANT_COMBINATION: 'variant',
};

/** Received units in the product's current stock scope; contains no monetary value. */
export const receivedShelfExistsSql = (product: string): string => `EXISTS (
  SELECT 1 FROM inventory_lots l WHERE l.product_id=${product}.id AND l.qty_remaining>0
    AND l.scope=CASE ${product}.inventory_mode WHEN 'OPTION' THEN 'option' WHEN 'COLOR' THEN 'color'
      WHEN 'VARIANT_COMBINATION' THEN 'variant' ELSE 'base' END )`;

const CHUNK = 50;
const isMissing = (e: unknown): boolean => /no such (table|column)/i.test(e instanceof Error ? e.message : String(e));
const whole = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/**
 * The shelves of the products named, in `shelfReads(n)` statements: one per 50
 * products. A batch's cost is its newest cost version (0165), as FIFO's; a
 * database older than 0165 reads the batch's own cost (one statement more), and
 * one without `inventory_lots` reads as no shelf. A product with no batch under
 * its current mode is absent.
 */
export const shelfReads = (n: number): number => Math.ceil(Math.max(0, n) / CHUNK);

/** A batch's effective dinars: its newest cost version (0165), as FIFO's. */
const versionedCostSql = (lot: string) =>
  `COALESCE((SELECT v.unit_cost_iqd FROM inventory_lot_cost_versions v WHERE v.lot_id = ${lot}.id ORDER BY v.version DESC LIMIT 1), ${lot}.unit_cost_iqd)`;
/** Row 249: the batch carries its purchase-time U (0182). */
const ratedSql = (lot: string) => `(${lot}.usd_iqd_rate_at_purchase IS NOT NULL AND CAST(${lot}.usd_iqd_rate_at_purchase AS REAL) > 0)`;
/**
 * Row 249: a rated batch's cost in whole micro-dollars — its dinars ÷ its purchase-time U. THE one expression
 * of it: the shelf read and the sweep's signature items both use it (SQLite's own REAL division, never
 * recomputed in JS), so their signatures always agree.
 */
export const lotUsdMicroSql = (lot: string, cost: string) => `CAST(ROUND(${cost} * 1000000.0 / CAST(${lot}.usd_iqd_rate_at_purchase AS REAL)) AS INTEGER)`;
/**
 * The costliest rated batch itself, as one sortable text `<micro, 20 digits>|<dinars, 15 digits>|<its U>`:
 * the micro-dollars only CHOOSE the batch (a tie takes the higher dinars); its dinars and its U price it
 * exactly (`identityIqd`), so a U that has not moved gives back the dinars as paid, never one more.
 */
const lotExactSql = (lot: string, cost: string) =>
  `printf('%020d|%015d|%s', ${lotUsdMicroSql(lot, cost)}, CAST(${cost} AS INTEGER), CAST(${lot}.usd_iqd_rate_at_purchase AS TEXT))`;

/** The schema the shelf read is attempted against, newest first (0165's cost versions, 0182's purchase rate). */
const SHELF_SCHEMAS: ReadonlyArray<{ cost: string; rated: boolean }> = [
  { cost: versionedCostSql('l'), rated: true },
  { cost: 'l.unit_cost_iqd', rated: true },
  { cost: versionedCostSql('l'), rated: false },
  { cost: 'l.unit_cost_iqd', rated: false },
];

export async function loadShelves(db: D1Database, ids: readonly string[]): Promise<Map<string, ProductShelf>> {
  for (const [i, schema] of SHELF_SCHEMAS.entries()) {
    try {
      return await readShelves(db, ids, schema.cost, schema.rated);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // An older database: without 0165 the batch's own cost, without 0182 dinars as paid (no batch has a rate).
      if (i === SHELF_SCHEMAS.length - 1 || !/no such table: inventory_lot_cost_versions|no such column: l\.usd_iqd_rate_at_purchase/i.test(msg)) throw e;
    }
  }
  return new Map();
}

async function readShelves(db: D1Database, ids: readonly string[], cost: string, rated: boolean): Promise<Map<string, ProductShelf>> {
  const out = new Map<string, ProductShelf>();
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  if (!unique.length) return out;
  try {
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const stmt = db.prepare(
        `SELECT l.product_id AS product_id, p.inventory_mode AS mode, l.scope AS scope, l.scope_id AS scope_id,
                MAX(v.combo_key) AS combo_key,
                MAX(CASE WHEN l.qty_remaining > 0 THEN ${cost} END) AS cost_iqd,
                ${rated ? `MAX(CASE WHEN l.qty_remaining > 0 AND ${ratedSql('l')} THEN ${lotUsdMicroSql('l', cost)} END)` : 'NULL'} AS cost_usd_micro,
                ${rated ? `MAX(CASE WHEN l.qty_remaining > 0 AND ${ratedSql('l')} THEN ${lotExactSql('l', cost)} END)` : 'NULL'} AS cost_usd_lot,
                ${rated ? `MAX(CASE WHEN l.qty_remaining > 0 AND NOT ${ratedSql('l')} THEN ${cost} END)` : `MAX(CASE WHEN l.qty_remaining > 0 THEN ${cost} END)`} AS cost_iqd_unrated,
                SUM(CASE WHEN l.qty_remaining > 0 THEN l.qty_remaining ELSE 0 END) AS units
           FROM inventory_lots l
           JOIN products p ON p.id = l.product_id
           LEFT JOIN product_variants v ON l.scope = 'variant' AND v.id = l.scope_id AND v.product_id = l.product_id
          WHERE l.product_id IN (SELECT value FROM json_each(?))
          GROUP BY l.product_id, l.scope, l.scope_id
          ORDER BY l.product_id, l.scope, l.scope_id`
      );
      const { results } = await stmt.bind(JSON.stringify(chunk)).all<Record<string, unknown>>();
      for (const r of results ?? []) {
        const pid = String(r.product_id);
        const mode: InventoryMode = isInventoryMode(r.mode) ? r.mode : 'BASE';
        const scope = String(r.scope) as ShelfIdentity['scope'];
        // Only the current mode's scope is the shelf (a batch left under another mode is not sold from).
        if (scope !== SCOPE_OF_MODE[mode]) continue;
        const shelf = out.get(pid) ?? { mode, identities: [] };
        shelf.identities.push({
          scope,
          scope_id: String(r.scope_id ?? ''),
          combo_key: r.combo_key === null || r.combo_key === undefined ? null : String(r.combo_key),
          cost_iqd: whole(r.cost_iqd),
          cost_usd_micro: whole(r.cost_usd_micro),
          cost_usd_lot: lotOf(r.cost_usd_lot),
          cost_iqd_unrated: whole(r.cost_iqd_unrated),
          units: whole(r.units) ?? 0,
        });
        out.set(pid, shelf);
      }
    }
  } catch (e) {
    if (/no such table: inventory_lot_cost_versions|no such column: l\.usd_iqd_rate_at_purchase/i.test(e instanceof Error ? e.message : String(e))) throw e;
    if (isMissing(e)) return new Map();
    throw e;
  }
  return out;
}

/** `lotExactSql`'s text read back: the batch's dinars and its U; null when unreadable. */
const lotOf = (v: unknown): { iqd: number; rate: string } | null => {
  if (typeof v !== 'string') return null;
  const m = /^[0-9]{20}\|([0-9]{15})\|(.+)$/.exec(v);
  if (!m) return null;
  const iqd = whole(m[1]);
  const rate = m[2]!.trim();
  try {
    return iqd !== null && procurementExact(rate).num > 0n ? { iqd, rate } : null;
  } catch {
    return null;
  }
};

/** The shelf identities one SKU sells from (the cart's `resolveStock`, by the product's mode). */
function identitiesOf(shelf: ProductShelf, sku: { option_value_ids: readonly string[]; color_id: string | null; combo_key: string }): ShelfIdentity[] {
  switch (shelf.mode) {
    case 'BASE':
      return shelf.identities.filter((i) => i.scope === 'base');
    case 'OPTION':
      return shelf.identities.filter((i) => i.scope === 'option' && sku.option_value_ids.includes(i.scope_id));
    case 'COLOR':
      return sku.color_id === null ? [] : shelf.identities.filter((i) => i.scope === 'color' && i.scope_id === sku.color_id);
    case 'VARIANT_COMBINATION':
      return sku.combo_key === '' ? [] : shelf.identities.filter((i) => i.scope === 'variant' && i.combo_key === sku.combo_key);
  }
}

/** Receipt evidence for completeness; establishing a recorded landed cost
 * does not require an exchange rate. A recorded zero cost is valid. */
export function hasKnownShelfCost(shelf: ProductShelf | null | undefined, sku: { option_value_ids: readonly string[]; color_id: string | null; combo_key: string }): boolean {
  if (!shelf) return false;
  const ids = identitiesOf(shelf, sku);
  return ids.length > 0 && ids.every((i) => i.units > 0 && i.cost_iqd !== null);
}

/**
 * Row 249: one identity's cost in whole dinars at today's U — the higher of its rated batches' highest
 * micro-dollars × U (rounded UP to the dinar) and its unrated batches' dinars as paid. Null: no known cost,
 * or rated batches only and no U today (the supplier calculation then prices it).
 */
function identityIqd(i: ShelfIdentity, u: string | null): number | null {
  let usd: number | null = null;
  if (i.cost_usd_micro !== null) {
    if (!u) return null;
    try {
      // The costliest batch exactly when known (its dinars × today's U ÷ its U, the dinars as paid at the
      // same U); otherwise its micro-dollars × today's U.
      const lot = i.cost_usd_lot ?? null;
      const at = lot
        ? compareProcurementExact(procurementExact(lot.rate), procurementExact(u)) === 0
          ? procurementExact(lot.iqd)
          : ceilToPlaces(quotientProcurementExact(mulProcurementExact(procurementExact(lot.iqd), procurementExact(u)), procurementExact(lot.rate)), 0)
        : ceilToPlaces(quotientProcurementExact(mulProcurementExact(procurementExact(i.cost_usd_micro), procurementExact(u)), procurementExact(1_000_000)), 0);
      const n = Number(procurementExactText(at));
      usd = Number.isSafeInteger(n) && n >= 0 ? n : null;
    } catch {
      usd = null;
    }
    if (usd === null) return null;
  }
  if (usd === null) return i.cost_iqd_unrated;
  return i.cost_iqd_unrated === null ? usd : Math.max(usd, i.cost_iqd_unrated);
}

/**
 * One SKU's shelf for the maths (priceV2.ts `V2Shelf`), or null (no batch, or
 * units whose cost is not known — the supplier calculation then prices it).
 * `u` is the evaluation's USD/IQD: a rated batch is priced at it (row 249).
 * Several identities (OPTION mode, more than one stocked option): a unit takes
 * one from each, so the costs add and the units are the fewest; one sold out
 * leaves the SKU sold out.
 */
export function shelfOfSku(
  shelf: ProductShelf | null | undefined,
  sku: { option_value_ids: readonly string[]; color_id: string | null; combo_key: string },
  u: string | null
): V2Shelf | null {
  if (!shelf) return null;
  const ids = identitiesOf(shelf, sku);
  if (!ids.length) return null;
  if (ids.some((i) => i.units <= 0)) return { state: 'sold_out' };
  const costs = ids.map((i) => identityIqd(i, u));
  if (costs.some((c) => c === null)) return null;
  const cost = costs.reduce((n: number, c) => n + (c as number), 0);
  if (!Number.isSafeInteger(cost)) return null;
  return { state: 'on_shelf', cost_iqd: cost, units: Math.min(...ids.map((i) => i.units)) };
}

/**
 * The product's shelf signature: a hash of each identity's state under the
 * current mode — `<micro-dollars|->/<unrated dinars|->` of its highest known
 * costs (row 249), 'u' (units, no known cost) or 's' (sold out). Units are
 * left out on purpose: selling from the shelf without emptying the costliest
 * batch moves nothing; today's U is left out too (a rate move is the `USD`
 * reason). Null when the product has no batch (nothing to price from). The
 * same hash as `shelfSignatureOfItems` over the states read's `shelfItemsSql`.
 */
export async function shelfSignature(shelf: ProductShelf | null | undefined): Promise<string | null> {
  if (!shelf || !shelf.identities.length) return null;
  const known = (n: number | null) => (n === null ? '-' : String(n));
  return signatureOf(
    shelf.mode,
    shelf.identities.map(
      (i) => `${i.scope}:${i.scope_id}=${i.units <= 0 ? 's' : i.cost_usd_micro === null && i.cost_iqd_unrated === null ? 'u' : `${known(i.cost_usd_micro)}/${known(i.cost_iqd_unrated)}`}`
    )
  );
}

/** `v2`: row 249's USD-anchored items (a `v1` signature stored before it reads as a shelf move once). */
const signatureOf = (mode: InventoryMode, items: string[]): Promise<string> => sha256Hex(`shelf:v2|${mode}|${[...items].sort().join(',')}`);

/** The items `SHELF_ITEMS_SQL` joins (unit separator). */
const ITEM_SEPARATOR = '\u001e';

/**
 * The shelf signature from the automatic repricing's states read — no read of
 * its own: `mode` is the product's inventory mode, `items` the column
 * `SHELF_ITEMS_SQL` produced (null: no batch under the mode).
 */
export async function shelfSignatureOfItems(mode: unknown, items: string | null | undefined): Promise<string | null> {
  if (!items) return null;
  return signatureOf(isInventoryMode(mode) ? mode : 'BASE', items.split(ITEM_SEPARATOR));
}

/** Do the states read's shelf items hold any unit on a shelf (an item that is not «sold out»)? */
export const shelfItemsHaveUnits = (items: string | null | undefined): boolean => !!items && items.split(ITEM_SEPARATOR).some((i) => !i.endsWith('=s'));

/**
 * One SQL expression (a correlated subquery) of a product's shelf as signature
 * items, `scope:scope_id=<micro-dollars|->/<unrated dinars|-> | u | s>`, joined
 * by the unit separator — so the sweep's one states read also says whether any
 * shelf moved (no statement of its own, no figure leaving the database but as a
 * hash). The batches' effective cost is their newest cost version (0165), as
 * FIFO's; the micro-dollars are `lotUsdMicroSql`, as the shelf read's. The
 * states read needs 0198, so 0165 and 0182 are there.
 */
export function shelfItemsSql(productExpr: string): string {
  const cost = versionedCostSql('sl');
  const usd = `MAX(CASE WHEN sl.qty_remaining > 0 AND ${ratedSql('sl')} THEN ${lotUsdMicroSql('sl', cost)} END)`;
  const iqd = `MAX(CASE WHEN sl.qty_remaining > 0 AND NOT ${ratedSql('sl')} THEN ${cost} END)`;
  return `(SELECT group_concat(item, char(30)) FROM (
      SELECT sl.scope || ':' || sl.scope_id || '=' ||
             CASE WHEN SUM(CASE WHEN sl.qty_remaining > 0 THEN sl.qty_remaining ELSE 0 END) <= 0 THEN 's'
                  WHEN ${usd} IS NULL AND ${iqd} IS NULL THEN 'u'
                  ELSE COALESCE(CAST(CAST(${usd} AS INTEGER) AS TEXT), '-') || '/' || COALESCE(CAST(CAST(${iqd} AS INTEGER) AS TEXT), '-') END AS item
        FROM inventory_lots sl JOIN products sp ON sp.id = sl.product_id
       WHERE sl.product_id = ${productExpr}
         AND sl.scope = CASE sp.inventory_mode WHEN 'OPTION' THEN 'option' WHEN 'COLOR' THEN 'color' WHEN 'VARIANT_COMBINATION' THEN 'variant' ELSE 'base' END
       GROUP BY sl.scope, sl.scope_id))`;
}

/**
 * Is migration 0198 (`product_pricing_state.shelf_sig`) installed? One probe
 * per database binding and isolate (the column is never dropped once there).
 */
const sigInstalled = new WeakMap<D1Database, boolean>();
export async function shelfSigInstalled(db: D1Database): Promise<boolean> {
  const known = sigInstalled.get(db);
  if (known !== undefined) return known;
  let yes = false;
  try {
    yes = !!(await db.prepare("SELECT 1 AS x FROM pragma_table_info('product_pricing_state') WHERE name = 'shelf_sig'").first());
  } catch {
    yes = false;
  }
  // Only a positive answer is kept: a database migrated after this probe is read again next time.
  if (yes) sigInstalled.set(db, true);
  return yes;
}
