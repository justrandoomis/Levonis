/**
 * THE ONE LIST OF WHAT A CATALOGUE IMPORT MAY NEVER WRITE (Bambu import spec
 * §B.4, §C.10 layer 3; docs/DECISIONS.md rows 239 and 241).
 *
 * The import writes products through the app's own save path, inside ONE D1
 * batch that starts by inserting the guard row
 * `ops_guards(id = 'catalog-import-batch')` and ends by deleting it. While that
 * row exists — which is only inside an import batch, because D1 serialises
 * batches — the triggers migration 0195 creates from this file abort any write
 * that would put a price, a cost, a stock figure, a package measure, a
 * stock decision or any pricing / order / wallet / ledger row in the database.
 *
 * The triggers are GENERATED, never hand-written: `scripts/gen-import-guard-triggers.mjs`
 * reads these constants and rewrites the delimited block of 0195;
 * `tests/catalogImportGuards.test.ts` fails when the committed block differs
 * from what the generator prints, and when any table or column named here is
 * missing from the schema every migration builds.
 *
 * Plain data and two pure SQL-text helpers only: the generator imports this
 * file with Node's own type stripping, so it imports nothing and uses no
 * TypeScript-only runtime syntax. The helpers are the ONE spelling of "a
 * guarded column left at its default" and "the money a JSON array column
 * carries": the generated triggers, the writer's per-write fingerprint and its
 * money-default probe all read them (§E.4).
 */

/** The `ops_guards.id` that arms every guard trigger below. */
export const IMPORT_GUARD_ID = 'catalog-import-batch';

/** The RAISE(ABORT) message every guard trigger uses (§C.11). */
export const IMPORT_GUARD_REFUSAL = 'IMPORT_FINANCIAL_WRITE_REFUSED';

export interface ProtectedTable {
  table: string;
  /**
   * The migration file that creates the table, when it is NEWER than the base
   * this branch was cut from. The generator emits triggers only for tables the
   * schema before 0195 actually has, and the guard test refuses to accept a
   * missing table unless its `since` file is itself absent from migrations/.
   * Once that file lands, the table must be guarded: the generated block goes
   * stale and the test names the command that regenerates it.
   */
  since?: string;
}

/**
 * Tables an import batch may not INSERT into, UPDATE or DELETE from, at all.
 * Pricing, its inputs and results, price history, stock and its cost layers,
 * order and wallet records, the ledger, procurement cost defaults, and the
 * price-request tables (so the import can never create demand).
 */
export const PROTECTED_TABLES: readonly ProtectedTable[] = [
  { table: 'product_pricing_state' },
  { table: 'product_sku_prices' },
  { table: 'pricing_v2_sku_results' },
  { table: 'pricing_price_points' },
  { table: 'pricing_preorder_discounts' },
  { table: 'pricing_legacy_snapshots' },
  { table: 'pricing_inputs' },
  { table: 'pricing_rules' },
  { table: 'price_history' },
  { table: 'inventory_lots' },
  { table: 'inventory_ledger' },
  { table: 'product_option_fulfillment' },
  { table: 'product_option_transports' },
  { table: 'orders' },
  { table: 'order_items' },
  { table: 'wallet_transactions' },
  { table: 'accounting_entries' },
  { table: 'procurement_selection_cost_defaults' },
  { table: 'product_price_requests', since: '0193_price_requests.sql' },
  { table: 'product_price_request_stats', since: '0193_price_requests.sql' },
];

/**
 * How a guarded column's value reads when an import-created row leaves it
 * alone: the column's schema default.
 *   null         — must be NULL
 *   zero         — must be 0 (a NOT NULL DEFAULT 0 counter or price)
 *   zero_or_null — NULL or 0
 *   empty_object — the JSON default '{}'
 *   empty_array  — the JSON default '[]'
 */
export type GuardedDefault = 'null' | 'zero' | 'zero_or_null' | 'empty_object' | 'empty_array';

export interface GuardedColumn {
  name: string;
  insertDefault: GuardedDefault;
  /**
   * A JSON ARRAY WHOSE ELEMENTS CARRY MONEY (an extended-warranty fee, a
   * pre-order route commission). An UPDATE is refused when the multiset of the
   * elements' money tuples changes, not when the text does: the save path
   * re-serialises these columns on every save (a legacy `{name, price_iqd}`
   * plan is upgraded, a missing id is minted, keys are reordered), and that
   * moves no fee. Each entry is one SQL expression over `j.value`, the element
   * (`json_each` aliased `j`, objects only), matching what the save path's
   * upgrade reads (worker/lib/productModel.ts upgradeWarranty /
   * upgradeTransports). Absent: the column is compared as a whole value.
   */
  jsonElementMoney?: readonly string[];
}

export interface GuardedRowTable {
  table: string;
  /** Money: prices, costs, adjustments, membership prices, surcharges. */
  money: readonly GuardedColumn[];
  /** Stock: quantity, reservations, alert threshold. */
  stock: readonly GuardedColumn[];
  /** Package and product measures (0099): Pricing V2 freight inputs. */
  package: readonly GuardedColumn[];
}

const DIMENSIONS: readonly GuardedColumn[] = [
  { name: 'net_weight_g', insertDefault: 'null' },
  { name: 'width_mm', insertDefault: 'null' },
  { name: 'depth_mm', insertDefault: 'null' },
  { name: 'height_mm', insertDefault: 'null' },
  { name: 'package_weight_g', insertDefault: 'null' },
  { name: 'package_width_mm', insertDefault: 'null' },
  { name: 'package_depth_mm', insertDefault: 'null' },
  { name: 'package_height_mm', insertDefault: 'null' },
];

const ROW_PRICES: readonly GuardedColumn[] = [
  { name: 'regular_price_iqd', insertDefault: 'null' },
  { name: 'prime_price_iqd', insertDefault: 'null' },
  { name: 'pro_price_iqd', insertDefault: 'null' },
  { name: 'cost_iqd', insertDefault: 'null' },
];

const ROW_ADJUSTMENTS: readonly GuardedColumn[] = [
  { name: 'regular_adjust_iqd', insertDefault: 'null' },
  { name: 'prime_adjust_iqd', insertDefault: 'null' },
  { name: 'pro_adjust_iqd', insertDefault: 'null' },
  { name: 'cost_adjust_iqd', insertDefault: 'null' },
];

const ROW_STOCK: readonly GuardedColumn[] = [
  { name: 'stock', insertDefault: 'null' },
  { name: 'reserved', insertDefault: 'zero' },
  { name: 'low_stock_threshold', insertDefault: 'null' },
];

/**
 * Catalogue rows the import DOES write, whose money, stock and package columns
 * it may not set. A row the INSERT physically creates (a new row, or the row a
 * REPLACE puts back) must leave every one at its default — an AFTER INSERT
 * trigger, because an upsert that resolves to DO UPDATE fires no AFTER INSERT;
 * an UPDATE — the DO UPDATE of an upsert included — must not change any of
 * them.
 *
 * NOT a BEFORE INSERT comparison with the stored row (review 4, finding 1):
 * the planner's upserts leave `reserved` out of their column list, bind a
 * variant's cost as NULL without cost write and bind NULL for an omitted
 * dimension, while their DO UPDATE keeps all three, so the INSERT's NEW row
 * differs from the stored one on every merge that changes nothing. The one
 * write that judgement used to catch on top — a REPLACE that resets an
 * existing row to the defaults — is kept out differently: no write path names
 * these tables with REPLACE (tests/catalogImportGuards.test.ts reads the
 * sources, and that is what prevents it), and §E.4's per-write fingerprint,
 * read before and after inside the same batch, would DETECT one after the
 * commit (before_fp_equal false: the item is blocked, nothing refused).
 *
 * `product_colors` is guarded although the spec names three tables: a create
 * sends no colours, but a merge re-upserts an existing product's colour rows
 * through the same save path, and they carry the same price and stock columns
 * as option values.
 */
export const GUARDED_ROW_TABLES: readonly GuardedRowTable[] = [
  {
    table: 'products',
    money: [
      { name: 'price_iqd', insertDefault: 'zero' },
      { name: 'original_price_iqd', insertDefault: 'null' },
      { name: 'product_cost_iqd', insertDefault: 'null' },
      { name: 'prime_price_iqd', insertDefault: 'null' },
      { name: 'pro_price_iqd', insertDefault: 'null' },
      { name: 'direct_surcharge_iqd', insertDefault: 'zero_or_null' },
      { name: 'membership_prices', insertDefault: 'empty_object' },
      // The price of an extended warranty: a fixed fee or a percentage per plan
      // (a legacy plan's `price_iqd` is the same fee). §E.2: never changed.
      {
        name: 'warranty_plans',
        insertDefault: 'empty_array',
        jsonElementMoney: [
          "COALESCE(json_extract(j.value, '$.fee_iqd'), json_extract(j.value, '$.price_iqd'), 0)",
          "COALESCE(json_extract(j.value, '$.fee_percent'), '')",
          "(json_extract(j.value, '$.active') IS NOT 0)",
        ],
      },
      // The commission per pre-order route (0073's precedence reads it before
      // the option cell's own surcharge).
      {
        name: 'preorder_transports',
        insertDefault: 'empty_array',
        jsonElementMoney: [
          "COALESCE(json_extract(j.value, '$.method'), '')",
          "COALESCE(json_extract(j.value, '$.commission_iqd'), '')",
          "(json_extract(j.value, '$.active') IS NOT 0)",
        ],
      },
    ],
    stock: [
      { name: 'stock', insertDefault: 'null' },
      { name: 'stock_reserved', insertDefault: 'zero' },
      { name: 'low_stock_threshold', insertDefault: 'null' },
    ],
    package: DIMENSIONS,
  },
  { table: 'product_option_values', money: [...ROW_PRICES, ...ROW_ADJUSTMENTS], stock: ROW_STOCK, package: DIMENSIONS },
  { table: 'product_variants', money: ROW_PRICES, stock: ROW_STOCK, package: DIMENSIONS },
  { table: 'product_colors', money: [...ROW_PRICES, ...ROW_ADJUSTMENTS], stock: ROW_STOCK, package: DIMENSIONS },
];

/**
 * The stock decision (§B.10). An import may record `not_configured` (and a
 * merge `not_required`); it may never write `tracked` or `untracked`, nor
 * change a decision once recorded.
 */
export const STOCK_DECISION_GUARD = {
  table: 'product_source_refs',
  refusedOnInsert: ['tracked', 'untracked'] as readonly string[],
  frozenColumns: ['stock_decision', 'stock_decided_by', 'stock_decided_at'] as readonly string[],
};

/**
 * `ref.name` differs from the column's insert default (`ref` is `NEW`, `OLD`
 * or a table name).
 */
export function nonDefaultSql(col: GuardedColumn, ref: string): string {
  switch (col.insertDefault) {
    case 'null':
      return `${ref}.${col.name} IS NOT NULL`;
    case 'zero':
      return `${ref}.${col.name} IS NOT 0`;
    case 'zero_or_null':
      return `COALESCE(${ref}.${col.name}, 0) <> 0`;
    case 'empty_object':
      return `${ref}.${col.name} IS NOT '{}'`;
    case 'empty_array':
      return `${ref}.${col.name} IS NOT '[]'`;
    default:
      throw new Error(`unknown insertDefault ${String(col.insertDefault)} for ${col.name}`);
  }
}

/**
 * The money a JSON array column carries, as one comparable value: the sorted
 * multiset of its object elements' money tuples (`jsonElementMoney`). NULL for
 * an empty array, a non-array or invalid JSON — the same on both sides of a
 * save that keeps every fee, whatever the text.
 */
export function jsonElementMoneySql(col: GuardedColumn, ref: string): string {
  const tuple = (col.jsonElementMoney ?? []).join(" || '|' || ");
  return (
    `(SELECT group_concat(m, ',') FROM (SELECT ${tuple} AS m` +
    ` FROM json_each(CASE WHEN json_valid(${ref}.${col.name}) THEN ${ref}.${col.name} ELSE '[]' END ) j` +
    ` WHERE j.type = 'object' ORDER BY m))`
  );
}
