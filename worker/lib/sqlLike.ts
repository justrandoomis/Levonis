/**
 * BUILDING A `LIKE` PATTERN D1 WILL ACCEPT.
 *
 * Cloudflare D1 refuses a LIKE or GLOB pattern longer than **50 BYTES**:
 *
 *     D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR
 *
 * SQLite's own default for SQLITE_LIMIT_LIKE_PATTERN_LENGTH is 50 000, which is
 * why nothing in local testing ever hit this and why the failure only ever
 * appears on the live site. It took the product delete down completely — the
 * R2 key `products/catalog/gallery/65b35fbf52e44ef996a4.webp` is exactly 50
 * bytes, and wrapping it in two `%` made 52.
 *
 * BYTES, NOT CHARACTERS, AND THAT IS THE WHOLE POINT. Every search box in this
 * codebase bounded its term by CHARACTER count — `str(q, { max: 60 })` and
 * friends — which is not a bound on this limit at all. Arabic is two bytes per
 * letter in UTF-8, so «بحث عن طابعة ثلاثية الأبعاد بامبو» is 33 characters and
 * 61 bytes: comfortably inside every char cap in the repo and over D1's limit.
 * A shopper searching in the language this shop is written in got a 500, and a
 * shopper searching in English did not.
 *
 * SO THE TERM IS TRUNCATED BY BYTES, at a code-point boundary, and never in the
 * middle of a UTF-8 sequence or an escape pair. A search that is cut short
 * still finds things; a search that throws finds nothing.
 *
 * WILDCARDS THE PERSON TYPED ARE LITERAL. `%` and `_` are LIKE metacharacters,
 * so a customer searching for "50% off" was running a wildcard, and one
 * searching `_` matched every single-character difference. They are escaped
 * here, which means the SQL MUST carry `ESCAPE '\'` — `sqlLikeClause` exists so
 * that cannot be forgotten.
 */

const encoder = new TextEncoder();

/** D1's documented ceiling. The pattern, including its wildcards, must fit. */
export const D1_LIKE_PATTERN_MAX_BYTES = 50;

/**
 * Headroom. Sitting exactly on a platform limit is how a limit becomes an
 * outage the first time anything about the encoding changes.
 */
const BUDGET = D1_LIKE_PATTERN_MAX_BYTES - 2;

export type LikeShape = 'contains' | 'prefix' | 'suffix';

/**
 * A search term as a bound LIKE pattern, or '' when there is nothing to search.
 *
 * The empty string is returned rather than `'%%'` on purpose: a caller must
 * decide what "no term" means — usually "do not add this clause at all" — and a
 * pattern that matches everything is the wrong default for a WHERE.
 */
export function likePattern(raw: unknown, shape: LikeShape = 'contains'): string {
  const term = String(raw ?? '').trim();
  if (!term) return '';

  const wildcards = shape === 'contains' ? 2 : 1;
  const budget = BUDGET - wildcards;

  let body = '';
  let used = 0;
  // Iterating the string directly walks CODE POINTS, so an emoji or an Arabic
  // letter is never cut in half — a lone surrogate would corrupt the query.
  for (const ch of term) {
    const piece = ch === '\\' || ch === '%' || ch === '_' ? `\\${ch}` : ch;
    const cost = encoder.encode(piece).length;
    if (used + cost > budget) break;
    body += piece;
    used += cost;
  }
  if (!body) return '';

  return shape === 'prefix' ? `${body}%` : shape === 'suffix' ? `%${body}` : `%${body}%`;
}

/**
 * The SQL fragment for one or more columns, with the ESCAPE clause attached.
 *
 * Written as a helper rather than left to each call site because the escape is
 * not optional: `likePattern` emits `\%` for a literal percent, and without
 * `ESCAPE '\'` SQLite reads that as a backslash followed by a wildcard — which
 * silently turns a search for "50% off" into a search for everything.
 *
 * `placeholder` defaults to `?`; pass `?1` when the statement numbers its
 * parameters, so one pattern can serve several columns.
 */
export function sqlLikeClause(columns: readonly string[], placeholder = '?'): string {
  return columns.map((c) => `${c} LIKE ${placeholder} ESCAPE '\\'`).join(' OR ');
}

/** How many bytes a pattern occupies — for tests and for asserting the bound. */
export function patternBytes(pattern: string): number {
  return encoder.encode(pattern).length;
}
