/**
 * THE COMPARISON READS THE KNOWLEDGE MODEL (the Bambu import spec §G.5
 * «Compare»): for the registry keys flagged `compare`, a product's typed fact
 * (0194 `product_spec_values`) answers the cell its template field would
 * otherwise answer from `spec_fields` — with its unit, its test method and,
 * where there is no value, the state's words instead of a blank («غير متوفر في
 * المصادر التي رُوجعت» …, never 0, never «No»).
 *
 * ONE EXTRA `IN` READ for ≤ 4 products, in the wave the route already spends on
 * the taxonomy and the pictures (tests/d1Waves.test.ts records the compare
 * route's measured ceiling). Without 0194 it answers nothing and every cell is
 * read from `spec_fields` exactly as before (CLAUDE.md rule 2).
 *
 * Public rows only, never the US 110 V table (a US value is not the product a
 * customer in Iraq compares), and per COLUMN: a column narrowed to an option
 * (`?ids=product:option`) takes that option's own fact first, then the
 * product's.
 */
import { knowledgeRead } from './schema';
import { COMPARE_KEY_FIELDS, type CompareFact } from './compareKeys';

/*
 * Which facts a column stands on — the key map, the cells and «has a value» — is ./compareKeys.ts (pure), shared
 * with the import's runner (§I.1.11). Re-exported for the callers that know this module.
 */
export { COMPARE_KEY_FIELDS, cellHasValue, comparedFields, hasKnowledgeValue, isCompareFact, knowledgeCellsFor, type CompareFact } from './compareKeys';

export interface CompareKnowledgeRow extends CompareFact {
  product_id: string;
}

/** The compared products' typed facts, by product id; null on a database without 0194. */
export async function loadCompareKnowledge(db: D1Database, productIds: readonly string[]): Promise<Map<string, CompareKnowledgeRow[]> | null> {
  const ids = [...new Set(productIds)].filter(Boolean);
  if (ids.length === 0 || COMPARE_KEY_FIELDS.size === 0) return new Map();
  // The statement narrows by `isCompareFact`'s own rule (public, not US 110 V, product or option scope, a compare
  // key); `knowledgeCellsFor` applies it again, so the rows and the runner's count can never part.
  const rows = await knowledgeRead(db, async () =>
    (
      await db
        .prepare(
          `SELECT product_id, canonical_key, scope_kind, scope_id, region, value_text, value_num, value_num_max, unit, status, test_method
             FROM product_spec_values
            WHERE product_id IN (SELECT value FROM json_each(?)) AND canonical_key IN (SELECT value FROM json_each(?))
              AND visibility = 'public' AND region <> 'us_110v' AND scope_kind IN ('product', 'option_value')`
        )
        .bind(JSON.stringify(ids), JSON.stringify([...COMPARE_KEY_FIELDS.keys()]))
        .all<CompareKnowledgeRow>()
    ).results ?? []
  );
  if (!rows) return null;
  const out = new Map<string, CompareKnowledgeRow[]>();
  for (const r of rows) {
    const list = out.get(r.product_id);
    if (list) list.push(r);
    else out.set(r.product_id, [r]);
  }
  return out;
}
