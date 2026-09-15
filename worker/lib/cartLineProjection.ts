/**
 * READING A CART LINE ON A DATABASE THAT IS ONE MIGRATION BEHIND THE CODE.
 *
 * `cart_items` has grown a column at a time — `option_value_ids` in 0023,
 * `draw_salt` in 0058, `fulfillment_type` in 0073 — and each addition creates
 * a window in which the deployed Worker names a column the live table does
 * not yet have. In that window the SELECT refuses, and every route that reads
 * a cart line refuses with it.
 *
 * WHY THIS IS A SUBSTITUTION AND NOT A DEGRADE. The other resilience helper
 * in this codebase, `degradeIfSchemaMissing`, answers "no rows" and is
 * therefore allowed only when the table is genuinely ABSENT. This one is the
 * opposite case and the opposite answer: the row EXISTS, it is read, and the
 * one unreadable field is filled with the DEFAULT its own migration declares
 * — which is the value that row would have carried had the migration run.
 * Nothing is invented and nothing is withheld: a line stored before 0073 has
 * `fulfillment_type = ''`, and `selectionFromCartRow`'s legacy inference
 * already handles exactly that.
 *
 * THE FAST PATH IS UNCHANGED AND COSTS NOTHING. `PRAGMA table_info` is read
 * only after the ordinary statement has already refused for a missing column,
 * which on a correctly migrated database never happens. `cart_items` itself
 * being absent is NOT recovered from — the rebuilt statement still selects
 * from it and still throws, because a cart with no cart table is not a cart
 * that should quietly render empty.
 *
 * ONE REGISTRY, EVERY READER. The cart route survived this and the checkout
 * did not, so a customer could open a cart that rendered at the right price
 * and then find checkout dead — the worst of both answers. Both now read
 * through here.
 */
import { isSchemaMissing } from './membershipBenefits';

/** Every `cart_items` column a pricing read names, with the DEFAULT its own
 *  migration declares. Add a column here in the same commit that adds it to
 *  a SELECT, or that SELECT loses this protection. */
export const CART_LINE_COLUMNS: ReadonlyArray<{ name: string; sqlDefault: string }> = [
  { name: 'option_id', sqlDefault: "''" },
  { name: 'option_value_ids', sqlDefault: "'[]'" }, // 0023
  { name: 'color_id', sqlDefault: "''" },
  { name: 'shipping_method_id', sqlDefault: "''" },
  { name: 'transport_method', sqlDefault: "''" }, // 0002
  { name: 'fulfillment_type', sqlDefault: "''" }, // 0073
  { name: 'warranty_plan_id', sqlDefault: "''" }, // 0002
  { name: 'draw_salt', sqlDefault: "''" }, // 0058
];

/** `ci.<col>, …` — the projection when the database is up to date. */
export const namedCartLineColumns = (cols: ReadonlyArray<{ name: string }> = CART_LINE_COLUMNS): string =>
  cols.map((col) => `ci.${col.name}`).join(', ');

/**
 * Run a cart-line SELECT, retrying once with absent columns replaced by their
 * declared defaults. `build` receives the projection and returns the whole
 * statement, so each caller keeps its own filter and ordering.
 */
export async function cartLineSelect(
  db: D1Database,
  build: (projection: string) => string,
  binds: readonly unknown[],
  cols: ReadonlyArray<{ name: string; sqlDefault: string }> = CART_LINE_COLUMNS
): Promise<Record<string, unknown>[]> {
  try {
    const r = await db.prepare(build(namedCartLineColumns(cols))).bind(...binds).all<Record<string, unknown>>();
    return r.results ?? [];
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
    console.error(`cart line columns behind the deployment: ${e instanceof Error ? e.message : String(e)}`);
    const { results } = await db.prepare('PRAGMA table_info(cart_items)').all<{ name: string }>();
    const present = new Set((results ?? []).map((r) => String(r.name)));
    const projection = cols
      .map((col) => (present.has(col.name) ? `ci.${col.name}` : `${col.sqlDefault} AS ${col.name}`))
      .join(', ');
    const r = await db.prepare(build(projection)).bind(...binds).all<Record<string, unknown>>();
    return r.results ?? [];
  }
}
