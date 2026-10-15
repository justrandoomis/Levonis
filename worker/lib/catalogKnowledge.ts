/**
 * IS MIGRATION 0194 (THE PRODUCT KNOWLEDGE MODEL) ON THIS DATABASE?
 * (Bambu import spec §B.2, §B.10, §C.1; docs/DECISIONS.md rows 239 and 241;
 * CLAUDE.md rule 2: every new read of a new table tolerates its absence.)
 *
 * A Worker carrying the readers of 0194 can run against a database without it
 * — a manual redeploy of an older migration state, Workers Builds re-opened in
 * an emergency — so every reader asks here first and keeps today's behaviour
 * when the answer is no:
 *   - the search index carries no alias (worker/lib/search/aliases.ts);
 *   - the Pricing V2 write carries no import stock fence, and no product is
 *     refused for a stock decision it cannot have (worker/lib/importStock.ts).
 *
 * ONE STATEMENT NAMES THE THREE TABLES THOSE READERS READ. 0194 lands as one
 * file (D1 applies a migration file as one transaction), so the three come
 * together or not at all; naming all three makes the answer "no" for any one
 * missing rather than a reader failing later on the one that is.
 *
 * REMEMBERED PER BINDING, the shape of priceRequests.ts: "present" for good (a
 * migration lands while the isolate lives and never un-lands); "absent" for a
 * minute, then asked again. ONLY A MISSING TABLE IS "ABSENT". Any other
 * failure is thrown — the stock gate must fail CLOSED (a probe that could not
 * be asked is never a reason to publish an imported product without its stock
 * decision), and a search document is never written thinner than its rows
 * because one read hiccupped.
 *
 * Budgeted callers (the quarter-hour cron) ask `catalogKnowledgeKnown` first,
 * so the probe is charged exactly when it is sent.
 */

const PRESENT = new WeakMap<object, true>();
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

/** The tables of 0194 that the readers of this file's callers name. */
export const CATALOG_KNOWLEDGE_TABLES = ['product_source_refs', 'product_external_ids', 'product_spec_values'] as const;

/** "no such table: product_source_refs" (or another 0194 table) — the deploy-ahead answer. */
export function isMissingCatalogKnowledge(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err);
  return /no such table:?\s*(product_source_refs|product_external_ids|product_spec_values|product_option_source_refs|product_documents|product_relations|product_option_value_swatches)\b/i.test(msg);
}

/**
 * What this binding is known to hold, without asking: true (0194 is there),
 * false (it was absent less than a minute ago), null (unknown — the next
 * `catalogKnowledgeInstalled` sends one statement).
 */
export function catalogKnowledgeKnown(db: object): boolean | null {
  if (PRESENT.has(db)) return true;
  if ((ABSENT_UNTIL.get(db) ?? 0) > Date.now()) return false;
  return null;
}

/** Migration 0194's tables are on this database. One statement per binding while unknown, none once present. */
export async function catalogKnowledgeInstalled(db: D1Database): Promise<boolean> {
  const known = catalogKnowledgeKnown(db);
  if (known !== null) return known;
  try {
    await db
      .prepare(
        `SELECT (SELECT 1 FROM product_source_refs LIMIT 1) AS r,
                (SELECT 1 FROM product_external_ids LIMIT 1) AS e,
                (SELECT 1 FROM product_spec_values LIMIT 1) AS s`
      )
      .first<{ r: number | null }>();
    PRESENT.set(db, true);
    return true;
  } catch (e) {
    if (isMissingCatalogKnowledge(e)) {
      ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
      return false;
    }
    throw e;
  }
}

/** A statement that named 0194's tables just succeeded on this binding: it is there, ask nothing more. */
export function rememberCatalogKnowledgePresent(db: object): void {
  PRESENT.set(db, true);
}
