/**
 * IS MIGRATION 0194 ON THIS DATABASE? (the Bambu import spec §B.2, §G.1;
 * docs/DECISIONS.md rows 239 and 241; CLAUDE.md rule 2.)
 *
 * Every reader of the knowledge model — the product page's relations (a value's
 * swatch, an image's source variant), `/api/products/:slug/knowledge`, the
 * compare cells, the admin information-completeness column — must keep working
 * on a database that has not run 0194: a manual redeploy of an older commit, or
 * Workers Builds re-opened in an emergency, can run this code against one.
 *
 * OPTIMISTIC, NEVER A PROBE FIRST. The product page and the listings are the
 * first screen, and `tests/d1Waves.test.ts` holds their round trips: a probe
 * would be one more dependent wave on every cold isolate. So a reader sends the
 * statement that names the 0194 table, and only when the database refuses it
 * for exactly that table (or column) does it run today's statement instead —
 * the shape `worker/lib/listing.ts` (`runListed`) uses for 0184 and 0189. On a
 * migrated database the fallback is never prepared, and a success proves the
 * tables are there, so nothing is ever asked twice. A refusal is remembered per
 * binding for a minute, so a Worker ahead of its migration pays the failed
 * statement once a minute, not once a request.
 */

const PRESENT = new WeakMap<object, true>();
const ABSENT_UNTIL = new WeakMap<object, number>();
const ABSENT_RECHECK_MS = 60_000;

/** The names 0194 adds: its seven tables and the one column a reader can name on its own. */
const KNOWLEDGE_NAMES =
  /product_spec_values|product_documents|product_relations|product_option_value_swatches|product_option_source_refs|product_source_refs|product_external_ids|via_variant_id/i;

/** "no such table: product_spec_values" (or a 0194 column): the deploy-ahead answer, and nothing else. */
export function isMissingKnowledgeSchema(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err ?? '');
  return /no such (table|column)/i.test(msg) && KNOWLEDGE_NAMES.test(msg);
}

/** This database refused a 0194 statement within the last minute: build today's statement. */
export function knowledgeAbsentLately(db: object): boolean {
  if (PRESENT.has(db)) return false;
  return (ABSENT_UNTIL.get(db) ?? 0) > Date.now();
}

/** A 0194 statement just ran on this database. */
export function rememberKnowledgePresent(db: object): void {
  PRESENT.set(db, true);
  ABSENT_UNTIL.delete(db);
}

function rememberKnowledgeAbsent(db: object): void {
  PRESENT.delete(db);
  ABSENT_UNTIL.set(db, Date.now() + ABSENT_RECHECK_MS);
}

/** Forget what this isolate learned (tests that migrate one database forward). */
export function forgetKnowledgeSchema(db: object): void {
  PRESENT.delete(db);
  ABSENT_UNTIL.delete(db);
}

/**
 * Runs `withKnowledge` (a statement naming a 0194 table) unless this database
 * refused one lately; on that refusal it remembers the answer and runs
 * `without` — today's statement, exactly. Every other failure is the caller's.
 */
export async function withKnowledgeFallback<T>(db: object, withKnowledge: () => Promise<T>, without: () => Promise<T>): Promise<T> {
  if (knowledgeAbsentLately(db)) return without();
  try {
    const out = await withKnowledge();
    rememberKnowledgePresent(db);
    return out;
  } catch (e) {
    if (!isMissingKnowledgeSchema(e)) throw e;
    rememberKnowledgeAbsent(db);
    return without();
  }
}

/**
 * A read that only exists with 0194 (the knowledge answer, the compare cells,
 * the completeness column): null when the database has no such table — the
 * caller's empty answer — and the rows otherwise.
 */
export async function knowledgeRead<T>(db: object, read: () => Promise<T>): Promise<T | null> {
  if (knowledgeAbsentLately(db)) return null;
  try {
    const out = await read();
    rememberKnowledgePresent(db);
    return out;
  } catch (e) {
    if (!isMissingKnowledgeSchema(e)) throw e;
    rememberKnowledgeAbsent(db);
    return null;
  }
}
