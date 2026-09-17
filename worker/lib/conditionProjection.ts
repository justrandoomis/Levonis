/**
 * READING `products.condition_doc` ON A DATABASE THAT IS BEHIND THE CODE.
 *
 * THE OUTAGE THIS EXISTS FOR. A Worker carrying migration 0085's
 * `products.condition_doc` reached production over a database still at 0083.
 * `/api/home` names that column in a WHERE clause, the statement refused, and
 * because the home handler gathers its strips with `Promise.all` the refusal
 * discarded six good results: the storefront's entire first screen became the
 * SERVICE_SETUP card — «جزء من المتجر قيد التجهيز» — products, categories,
 * brands and all. One optional shelf took the page with it.
 *
 * WHY THIS IS A SUBSTITUTION AND NOT A DEGRADE — the distinction
 * `worker/lib/membershipBenefits.ts` spends thirty lines on, and is right to.
 *
 * `degradeIfSchemaMissing` answers "no rows", and is permitted ONLY for a
 * missing TABLE, because a table that is absent genuinely holds nothing. A
 * missing COLUMN is the opposite case: the table is there and may be FULL, so
 * answering "no rows" can hide real data — that module's own example is a PRO
 * member with three live discount rules being told they have none and charged
 * the regular price at HTTP 200, with no error anywhere.
 *
 * That reasoning does not reach this column, and the reason is arithmetic
 * rather than judgement. `condition_doc` is declared
 * `TEXT NOT NULL DEFAULT '{}'`, `'{}'` is what `parseConditionDoc` reads as
 * "not graded", and a column that does not exist yet can have no other value:
 * the instant migration 0085 runs, every pre-existing row carries `'{}'`. So
 * an empty graded shelf, and a return that is not refused on condition
 * grounds, are not a guess about the data — they are the data, one migration
 * early. Nothing is withheld because nothing can yet be there.
 *
 * This is the same shape as `worker/lib/cartLineProjection.ts`, which the
 * membershipBenefits comment names as the sanctioned exception, and it keeps
 * that module's two rules:
 *
 *   THE FAST PATH COSTS NOTHING. `PRAGMA table_info` is read only after a
 *   statement has already refused for missing schema, which on a correctly
 *   migrated database never happens.
 *
 *   ONLY THIS COLUMN. A missing `products` TABLE is re-thrown — a shop whose
 *   catalogue is gone must not render as a shop with nothing in it — and so
 *   is any OTHER absent column, because for those the doctrine above applies
 *   in full and an empty answer could be a lie.
 */

import { isSchemaMissing } from './membershipBenefits';

/** The column, and the DEFAULT its own migration declares. */
export const CONDITION_DOC_COLUMN = 'condition_doc';
export const CONDITION_DOC_DEFAULT_SQL = "'{}'";

/**
 * Is `e` the absence of `products.condition_doc`, and nothing else?
 *
 * Answers `false` — meaning "re-throw this" — for every other reading of the
 * failure, including the two that matter most: the products table being gone,
 * and some different column being unreadable. A caller that treats `true` as
 * "substitute the declared default" is then exactly as correct as the
 * migration it is one step ahead of.
 */
export async function isConditionColumnMissing(db: D1Database, e: unknown): Promise<boolean> {
  if (!isSchemaMissing(e)) return false;
  let cols: { name: string }[];
  try {
    const { results } = await db.prepare('PRAGMA table_info(products)').all<{ name: string }>();
    cols = results ?? [];
  } catch {
    // If we cannot even ask, we do not get to assume. Re-throw.
    return false;
  }
  // No rows means the TABLE is absent, not the column.
  if (cols.length === 0) return false;
  // The column is there, so something else in that statement was not.
  if (cols.some((c) => String(c.name) === CONDITION_DOC_COLUMN)) return false;
  console.error(
    'products.condition_doc is behind the deployment (migration 0085 has not been applied); ' +
      'graded listings read as ungraded until it is'
  );
  return true;
}

/**
 * Does the live `products` table carry `condition_doc` yet?
 *
 * THE WRITE SIDE OF THE SAME PROBLEM, and it needed the opposite technique.
 * A read can be attempted and repaired on failure, because the failure costs
 * nothing. A product save is a BATCH — the row, its images, its option groups,
 * its variants, its catalog placements — and a statement that names a column
 * the table does not have aborts the whole batch. Retrying it means
 * re-planning the save, so this one asks first.
 *
 * ONE EXTRA READ, ON AN ADMIN ACTION. Naming the column unconditionally would
 * be free, and would have turned a broken home page into a broken product form
 * the moment `condition_doc` joined the write path: on a database one migration
 * behind, every save — a price correction, a stock fix, anything — would answer
 * `has no column named condition_doc`. A shop that cannot change its own prices
 * is worse than a shop with an empty graded shelf, and a PRAGMA on a save
 * nobody performs a hundred times a minute is not a cost worth that.
 *
 * Omitting the column is the same substitution the reads make: the row takes
 * the DEFAULT its migration declares, which is `'{}'` — ungraded — which is
 * what a product on a pre-0085 database can only be.
 */
export async function productsHaveConditionDoc(db: D1Database): Promise<boolean> {
  try {
    const { results } = await db.prepare('PRAGMA table_info(products)').all<{ name: string }>();
    // No rows at all means the table is absent. Answering "yes" lets the save
    // name the column and fail loudly on the real problem, which is right.
    if (!results || results.length === 0) return true;
    return results.some((c) => String(c.name) === CONDITION_DOC_COLUMN);
  } catch {
    // Cannot ask — assume the column is there and let the save report the
    // truth rather than silently dropping a grade the owner just chose.
    return true;
  }
}
