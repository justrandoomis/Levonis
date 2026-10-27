import { sqlLikeClause } from './sqlLike';
import { requestSummarySql } from './requestModel';

/** What a board search reads: the request's own words. */
const REQUEST_SEARCH = ['r.title', 'r.description'] as const;

/**
 * On the public board: published, still taking offers, public, not expired —
 * one rule for the community page (worker/routes/community.ts), the request
 * board (worker/routes/marketplace.ts) and the public API. `now` and `q` are
 * the placeholders holding the current ISO time and the `likePattern` term.
 */
export const requestBoardVisible = (now: string, q: string) => `r.state IN ('open','receiving_offers') AND r.visibility = 'public'
        AND (r.expires_at IS NULL OR r.expires_at > ${now})
        AND (${q} = '' OR ${sqlLikeClause(REQUEST_SEARCH, q)})`;

/**
 * THE BOARD'S FILTERS (plan B3; packages/contracts/src/communityFilters.ts),
 * ANDed into a list's `where` so its `total` stays exact. `process` and
 * `offers` are placeholders holding '' (no filter) or a validated value:
 *   process  `fdm` | `resin` — a request that NAMES that process for a part
 *            (the summary's processes; «لست متأكدًا» names none);
 *   offers   `none` | `some` — no live offer yet, or at least one
 *            (`offer_count` counts the pending and the accepted).
 * The print row must be in scope as `p` (a LEFT JOIN: a request without one
 * names no process); `schema` as `requestSummarySql`'s.
 */
export function requestBoardFilterSql(process: string, offers: string, schema: boolean): string {
  const processes = requestSummarySql('p', schema).processes_json;
  return `AND (${process} = '' OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${processes}) THEN ${processes} ELSE '[]' END) pj
                                     WHERE pj.value = ${process}))
        AND (${offers} = '' OR (${offers} = 'none' AND COALESCE(r.offer_count, 0) = 0)
                            OR (${offers} = 'some' AND COALESCE(r.offer_count, 0) > 0))`;
}
