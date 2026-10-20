/**
 * A PRODUCT'S SEARCH ALIASES — the words a shopper types for it that are
 * written in neither its name nor its options (Bambu import spec §C.1, §G.5;
 * DECISIONS row 241).
 *
 * Two kinds, both from migration 0194:
 *   - its SEARCHABLE EXTERNAL IDS (`product_external_ids.searchable = 1`): a
 *     filament's colour code «10101», a part code «FAP035», the manufacturer's
 *     SKU code. A shopper holding the spool or the spare part types exactly
 *     that. The opaque store ids (`bambu_product_id`, `bambu_variant_id`) are
 *     stored with `searchable = 0` and never read here.
 *   - its IDENTITY: the `identity.model` and `identity.series` spec rows
 *     («H2D», «X1 Series»), the names a shopper uses for the machine a part
 *     belongs to. Public rows only: an owner-only spec row never becomes a
 *     customer's search token.
 *
 * ONE LOADER, BOTH WRITERS. The index is written by the product save
 * (`planProductSave`) and by the cron backfill (`searchDocsForRows` /
 * `backfillSearchIndex`). A token one of them writes and the other does not
 * is a product that becomes unfindable the day the other one rewrites it —
 * the first owner edit of an imported product, or the backfill after an
 * `INDEX_STAMP` bump. So both read here, and the document builder
 * (./document.ts) puts the aliases in the `model` field beside the option
 * names, where a typed code ranks with a typed model name.
 *
 * THE COST. One statement per 90 products (D1 refuses more than 100 bound
 * parameters; the codebase's `IN (…)` lists are cut at 90): the same numbered
 * parameters serve both halves of one `UNION ALL`, so a slice binds 90 values,
 * not 180. Nothing at all on a database without 0194 — the presence probe
 * (worker/lib/catalogKnowledge.ts) answers once per binding, and then the map
 * is empty and the document is exactly today's.
 */
import { catalogKnowledgeInstalled } from '../catalogKnowledge';

/** Products per alias read: the codebase's `IN (…)` cut (worker/lib/financeReport.ts §7). */
export const ALIAS_IN_CHUNK = 90;

/** The identity spec rows a shopper's words name (`identity.family` is a facet, not a name). */
export const ALIAS_SPEC_KEYS = ['identity.model', 'identity.series'] as const;

/** The longest alias kept: `product_external_ids.value` is at most 120 characters. */
const MAX_ALIAS = 120;

const distinctIds = (ids: readonly unknown[]): string[] => [
  ...new Set(ids.filter((x): x is string => typeof x === 'string' && x !== '')),
];

/** The statements `loadSearchAliases` sends for these products once 0194 is known present: one per 90. */
export function aliasReadCount(productIds: readonly unknown[]): number {
  return Math.ceil(distinctIds(productIds).length / ALIAS_IN_CHUNK);
}

/**
 * The external ids come back WITH THEIR SCOPE AND TYPE: the identifier lane
 * (./identifiers.ts, migration 0206) keys a colour code to the colour it
 * names, and it reads them here, in the same statement, so a writer that has
 * the aliases has the identifiers too and pays nothing more for them.
 */
const ALIAS_SQL = (n: number): string => {
  const ph = Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',');
  return `SELECT product_id, value AS alias, scope_kind, scope_id, id_type FROM product_external_ids
           WHERE searchable = 1 AND product_id IN (${ph})
          UNION ALL
          SELECT product_id, value_text AS alias, 'product', '', canonical_key FROM product_spec_values
           WHERE canonical_key IN ('${ALIAS_SPEC_KEYS.join("','")}') AND visibility = 'public' AND value_text <> ''
             AND product_id IN (${ph})`;
};

/** One searchable external id, as stored (0194): what the identifier lane derives its rows from. */
export interface ExternalIdSource {
  scope_kind: string;
  scope_id: string;
  id_type: string;
  value: string;
}

export interface SearchSources {
  /** productId → its aliases (`loadSearchAliases`). */
  aliases: Map<string, string[]>;
  /** productId → its searchable external ids, scoped. Products with none are absent. */
  externalIds: Map<string, ExternalIdSource[]>;
}

/**
 * productId → its aliases (distinct, trimmed, sorted so a document is the
 * same however the rows came back). A product with none is absent from the
 * map. `installed` skips the presence probe when the caller already knows the
 * answer (a budgeted pass that charged the probe itself).
 */
export async function loadSearchAliases(
  db: D1Database,
  productIds: readonly string[],
  opts: { installed?: boolean } = {}
): Promise<Map<string, string[]>> {
  return (await loadSearchSources(db, productIds, opts)).aliases;
}

/**
 * The aliases AND the scoped external ids of these products, from the same
 * statements `loadSearchAliases` sends (one per 90 products, none without
 * 0194). The external ids keep the order they were stored in.
 */
export async function loadSearchSources(
  db: D1Database,
  productIds: readonly string[],
  opts: { installed?: boolean } = {}
): Promise<SearchSources> {
  const out: SearchSources = { aliases: new Map(), externalIds: new Map() };
  const ids = distinctIds(productIds);
  if (ids.length === 0) return out;
  const installed = opts.installed ?? (await catalogKnowledgeInstalled(db));
  if (!installed) return out;
  const found = new Map<string, Set<string>>();
  for (let i = 0; i < ids.length; i += ALIAS_IN_CHUNK) {
    const part = ids.slice(i, i + ALIAS_IN_CHUNK);
    const { results } = await db
      .prepare(ALIAS_SQL(part.length))
      .bind(...part)
      .all<{ product_id: string; alias: string | null; scope_kind: string | null; scope_id: string | null; id_type: string | null }>();
    for (const r of results ?? []) {
      const alias = typeof r.alias === 'string' ? r.alias.trim() : '';
      if (!alias || alias.length > MAX_ALIAS) continue;
      const pid = String(r.product_id);
      let set = found.get(pid);
      if (!set) found.set(pid, (set = new Set()));
      set.add(alias);
      const list = out.externalIds.get(pid) ?? [];
      list.push({ scope_kind: String(r.scope_kind ?? 'product'), scope_id: String(r.scope_id ?? ''), id_type: String(r.id_type ?? ''), value: alias });
      out.externalIds.set(pid, list);
    }
  }
  for (const [pid, set] of found) out.aliases.set(pid, [...set].sort());
  return out;
}
