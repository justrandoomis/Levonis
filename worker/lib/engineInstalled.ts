/**
 * IS MIGRATION 0181 ON THIS DATABASE? (CLAUDE.md rule 2: every new read of a
 * new table or column tolerates its absence; USD design §10 "Deploy-ahead".)
 *
 * A Worker carrying the engine core can run against a 0179 database — a
 * manual redeploy of an older migration state, Workers Builds re-opened in an
 * emergency — so every caller asks here first and keeps today's behaviour
 * when the answer is no:
 *   - pricing routes answer 503 PRICING_NOT_INSTALLED;
 *   - a purchase save leaves `purchase_charges.pricing_role` out of its INSERT,
 *     which is then byte-identical to today's;
 *   - checkout keeps the identical `order_items` INSERT (the decision-6
 *     snapshot columns are named only when present).
 *
 * The answer is remembered per database binding and ONLY when it is "present":
 * a migration lands while the isolate lives, never un-lands, so a "no" is
 * asked again next time and a "yes" is never asked twice. A failure to ask is
 * a "no" — the old statement is always the safe one.
 *
 * It lives beside the accounting code, not in `pricingEngine/`, because it
 * names `order_items`: the engine module never does (tests/pricingCurrencyRoles).
 */

const PRESENT = new WeakMap<object, Set<string>>();

function remembered(db: object, key: string): boolean {
  return PRESENT.get(db)?.has(key) === true;
}

function remember(db: object, key: string): void {
  let set = PRESENT.get(db);
  if (!set) PRESENT.set(db, (set = new Set()));
  set.add(key);
}

/** The engine core's tables (0181): its control row is seeded by the migration itself. */
export async function engineCoreInstalled(db: D1Database): Promise<boolean> {
  if (remembered(db, 'core')) return true;
  try {
    const row = await db.prepare('SELECT id FROM pricing_engine_control WHERE id = 1').first<{ id: number }>();
    if (!row) return false;
    remember(db, 'core');
    return true;
  } catch {
    return false;
  }
}

/** The columns 0181 adds to live tables, the only ones this helper answers for. */
export const ENGINE_CORE_COLUMNS = {
  purchase_charges: ['pricing_role'],
  order_items: ['price_basis', 'engine_combo_key', 'engine_channel', 'engine_regular_iqd', 'usd_iqd_at_purchase', 'base_usd_at_purchase'],
  price_history: ['usd_iqd_rate', 'price_source'],
  price_protection_claims: ['eligible_unit_iqd', 'basis', 'usd_iqd_at_purchase', 'base_usd_at_purchase', 'base_usd_observed'],
} as const;

export type EngineCoreTable = keyof typeof ENGINE_CORE_COLUMNS;

/** True when `table.column` (one of ENGINE_CORE_COLUMNS) exists on this database. */
export async function engineColumnInstalled<T extends EngineCoreTable>(
  db: D1Database,
  table: T,
  column: (typeof ENGINE_CORE_COLUMNS)[T][number]
): Promise<boolean> {
  if (!(ENGINE_CORE_COLUMNS[table] as readonly string[]).includes(column)) throw new Error(`PRICING_INVARIANT: ${table}.${column} is not a 0181 column`);
  const key = `${table}.${column}`;
  if (remembered(db, key)) return true;
  try {
    // The table name comes from the fixed list above, never from a caller's text.
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const names = new Set((results ?? []).map((r) => String(r.name)));
    for (const c of ENGINE_CORE_COLUMNS[table] as readonly string[]) if (names.has(c)) remember(db, `${table}.${c}`);
    return names.has(column);
  } catch {
    return false;
  }
}
