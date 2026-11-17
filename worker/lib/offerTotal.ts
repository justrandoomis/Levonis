/**
 * WHAT A CUSTOMER AGREES TO ON AN OFFER (offers V2, 0159; docs/
 * COMMUNITY_ECOSYSTEM.md §4e and §9.5): the price plus the delivery fee, the
 * escrow gross. Computed on the server, never read from a client, and one
 * rule for every read that says it — the offers list (`offerShape`,
 * worker/routes/marketplace.ts) and the customer's «طلباتي»
 * (worker/routes/printRequests.ts).
 */

/** The delivery fee an offer row carries (0159); a row from before it, or a pickup, carries none. */
export const offerFee = (o: Record<string, unknown>): number => Math.max(0, Number(o.delivery_fee_iqd ?? 0) || 0);

/** Price plus fee. */
export const offerTotal = (o: Record<string, unknown>): number => (Number(o.price_iqd ?? 0) || 0) + offerFee(o);
