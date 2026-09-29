/**
 * A PRODUCT MADE FOR ONE CUSTOMER (migration 0152; docs/COMMUNITY_COMMERCE_CHAT.md §2 D6).
 *
 * A private product is an ordinary `community_products` row with an audience:
 * published (so it can be bought) yet `status = 'hidden'` (0152's mirror), so
 * every public reader — they all ask `status = 'active'` — passes it by. The
 * buy path is the store's own cart and checkout; these helpers are the ONE
 * place that lets its audience, and nobody else, through:
 *
 *   · `buyablePrivateIds` — which of a cart's products are private products
 *     this buyer may buy right now (published, not hidden by moderation, not
 *     expired, and the buyer IS the audience);
 *   · `PRIVATE_BUYABLE_SQL` — the same predicate for a fence inside a batch.
 *
 * On a database behind 0152 there are no private products: every helper
 * answers "none" instead of failing, so the cart and the checkout keep working
 * through a deploy that ships before its migration.
 */
import { isSchemaMissing } from './membershipBenefits';

let ready = false;

/**
 * Does this database carry 0152? Remembered once true (a column never goes
 * away); asked again while false, so an isolate that outlives the migration
 * notices it.
 */
export async function privateProductsReady(db: D1Database): Promise<boolean> {
  if (ready) return true;
  try {
    await db.prepare('SELECT audience_user_id FROM community_products LIMIT 0').all();
    ready = true;
    return true;
  } catch (e) {
    if (isSchemaMissing(e)) return false;
    throw e;
  }
}

/** For tests that build databases at different migrations in one process. */
export function resetPrivateProductsMemo(): void {
  ready = false;
}

/** The predicate a private product must meet to be bought by `userParam` at `nowParam` — SQL over the product alias. */
export function PRIVATE_BUYABLE_SQL(alias: string, userParam: string, nowParam: string): string {
  return `(${alias}.lifecycle = 'active' AND ${alias}.publish_state = 'published' AND ${alias}.admin_hidden_at IS NULL
           AND ${alias}.audience_user_id = ${userParam}
           AND (${alias}.custom_expires_at IS NULL OR ${alias}.custom_expires_at = '' OR ${alias}.custom_expires_at > ${nowParam}))`;
}

/**
 * Which of these products are private products `userId` may buy right now.
 * An empty set on a database behind 0152 — there are none there.
 */
export async function buyablePrivateIds(
  db: D1Database,
  productIds: string[],
  userId: string,
  now: string = new Date().toISOString()
): Promise<Set<string>> {
  if (!productIds.length || !(await privateProductsReady(db))) return new Set();
  const { results } = await db
    .prepare(
      `SELECT p.id FROM community_products p
        WHERE p.id IN (SELECT value FROM json_each(?1)) AND ${PRIVATE_BUYABLE_SQL('p', '?2', '?3')}`
    )
    .bind(JSON.stringify([...new Set(productIds)]), userId, now)
    .all<{ id: string }>();
  return new Set((results ?? []).map((r) => r.id));
}

/** Is this product a private one (anyone's)? False on a database behind 0152. */
export async function isPrivateProduct(db: D1Database, productId: string): Promise<boolean> {
  if (!(await privateProductsReady(db))) return false;
  const row = await db
    .prepare('SELECT 1 AS x FROM community_products WHERE id = ? AND audience_user_id IS NOT NULL')
    .bind(productId)
    .first();
  return !!row;
}

/** A private product the catalogue's own doors must leave alone — its one refusal. */
export const CUSTOM_PRODUCT_LOCKED_MESSAGE =
  'This is a private product made for one customer. It cannot be edited — cancel it from the conversation and send a new one.';
