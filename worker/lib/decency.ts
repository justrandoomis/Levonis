/**
 * THE OWNER'S HALF OF THE DECENCY RULE.
 *
 * `nameGuard.ts` next door is pure: a seed list, the folding, and the matching.
 * This is the part that reads the database, and it exists because the seed is
 * guaranteed to be incomplete. The words people actually type at a shop in
 * Baghdad are known in Baghdad, and a list that can only be extended by a
 * deploy is a list that stays wrong for a week at a time.
 *
 * TWO LAYERS, AND THE FLOOR IS THE ONE THAT CANNOT FAIL. The seed applies
 * everywhere, synchronously, inside `usernameRejection` and `displayName`.
 * These functions add the owner's rows on top. If `blocked_terms` is missing —
 * a Worker live before migration 0090 — the seed still applies and this simply
 * finds nothing extra: a missing TABLE holds no rows, which is the sanctioned
 * degrade of `membershipBenefits.ts`, and the honest answer here rather than a
 * sign-up that 500s.
 *
 * CACHED PER REQUEST, not per isolate. A Worker isolate can live for hours, and
 * a word the owner blocks at noon must work at 12:01 — not whenever
 * Cloudflare next recycles the isolate. The read is one indexed scan of a
 * table with a hundred rows, on sign-up only.
 */

import { compileTerms, isIndecent, type BlockedTerm, type TermScope } from './nameGuard';
import { badRequest } from './http';
import { degradeIfSchemaMissing } from './membershipBenefits';
import { normalizeText } from './search/normalize';

/** At most this many owner rows are compiled for one check. Far above any
 *  real list, and the bound is what stops a runaway table from turning every
 *  sign-up into a thousand regular expressions. */
const MAX_TERMS = 2000;

export async function loadOwnerTerms(db: D1Database): Promise<RegExp[]> {
  const rows = await degradeIfSchemaMissing(
    'blocked terms (migration 0090)',
    async () =>
      (
        await db
          .prepare(`SELECT term, scope FROM blocked_terms WHERE owner_added = 1 LIMIT ${MAX_TERMS}`)
          .all<{ term: string; scope: string }>()
      ).results ?? [],
    [] as Array<{ term: string; scope: string }>
  );
  const terms: BlockedTerm[] = [];
  for (const r of rows) {
    const term = normalizeText(r.term);
    if (!term) continue;
    terms.push({ term, scope: (r.scope === 'any' ? 'any' : 'word') as TermScope });
  }
  return compileTerms(terms);
}

/**
 * Refuse a name or a handle that is not something the next customer should
 * have to read. Throws; returns nothing.
 *
 * The message NEVER names what was found. A filter that quotes the word back
 * is a filter that teaches people exactly which letter to change, and it also
 * means an error toast repeats the insult to whoever is holding the phone.
 */
export async function assertDecent(
  db: D1Database,
  fields: { name?: unknown; username?: unknown }
): Promise<void> {
  const name = typeof fields.name === 'string' ? fields.name : '';
  const handle = typeof fields.username === 'string' ? fields.username : '';
  if (!name && !handle) return;

  // The seed alone would already have answered inside `displayName` and
  // `usernameRejection`; this pass is here for the owner's own rows, so it
  // only pays for the read when there is something to check.
  const extra = await loadOwnerTerms(db);
  if (extra.length === 0) return;

  if (handle && isIndecent(handle, extra)) {
    throw badRequest('Please choose a different username', 'USERNAME_NOT_ALLOWED');
  }
  if (name && isIndecent(name, extra)) {
    throw badRequest('Please choose a different name', 'NAME_NOT_ALLOWED');
  }
}
