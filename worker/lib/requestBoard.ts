import { sqlLikeClause } from './sqlLike';

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
