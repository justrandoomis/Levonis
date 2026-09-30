/**
 * REPUTATION V2 AND DISPUTE EVIDENCE — the client's typed doors to
 * worker/routes/community.ts (`GET /api/community/badges`, the `badges` on
 * every store card), worker/routes/merchantReputation.ts
 * (`GET /api/merchant/reputation`) and the evidence read of
 * worker/routes/chats.ts (docs/COMMUNITY_ECOSYSTEM.md §9.6, migration 0163).
 *
 * WHAT EACH READER GETS, and it is the whole privacy design:
 *
 *   a customer / a guest   `badges: [{key, since}]` on the store read
 *                          (`merchant.badges`), the directory card
 *                          (`merchants[].badges`) and the creator page's store
 *                          card (`creator.store.badges`) — never the evidence.
 *                          Show up to three (`visibleBadges`), each with a
 *                          «لماذا؟» explaining the RULE from `badgeCatalogue()`.
 *   the merchant           `myReputation()`: the same badges WITH the figures
 *                          that earned them, the last 30 / 90 days as numbers,
 *                          and the rules — so a badge not yet earned can say
 *                          what is missing («٧ محادثات من ١٠»).
 *   staff                  a disputed order's thread through the ordinary chat
 *                          reads: `read_only: true`, `role: 'staff'`, every
 *                          card's `actions` empty, `chat.evidence` naming the
 *                          case — and no composer (no write door admits them).
 *
 * NO COPY LIVES HERE. Badge names, the rule sentences and «يرد عادةً خلال …»
 * belong in the feature's own strings.ts (ar / en / ckb); the server answers
 * closed keys and numbers. Refusal codes these doors raise — map them through
 * src/lib/refusalStrings.ts: EVIDENCE_NOT_LINKED (staff opened a thread no
 * disputed order links), EVIDENCE_CLOSED (its dispute has been decided).
 */
import { api, ApiError, type RequestOptions } from '../../../lib/api';

/** The closed catalogue, in the order a card shows them — the server's `BADGE_KEYS`. */
export const BADGE_KEYS = ['verified_merchant', 'fast_response', 'reliable_seller', 'custom_specialist', 'high_completion'] as const;
export type BadgeKey = (typeof BADGE_KEYS)[number];

export function isBadgeKey(v: unknown): v is BadgeKey {
  return typeof v === 'string' && (BADGE_KEYS as readonly string[]).includes(v);
}

/** How many badges a store hero, a directory card or a creator page shows (§9.6). */
export const VISIBLE_BADGES_MAX = 3;

/** A badge as the public sees it: which one, and the Baghdad day it was earned. */
export interface PublicBadge {
  key: BadgeKey;
  /** 'YYYY-MM-DD' — held without a break since. */
  since: string;
}

/**
 * The numbers each rule compares, as `GET /api/community/badges` publishes
 * them. Percentages are whole percents; windows are days.
 *
 *   verified_merchant   { verified: true }
 *   fast_response       { window_days: 30, median_within_minutes: 60, min_threads: 10 }
 *   reliable_seller     { window_days: 90, min_completed: 20, max_merchant_cancel_percent: 3, max_disputes_lost: 0 }
 *   custom_specialist   { window_days: 90, min_custom_completed: 10, accepts_custom_requests: true }
 *   high_completion     { window_days: 90, min_completion_percent: 95, min_orders: 20 }
 */
export type BadgeRuleParams = Record<string, number | boolean>;

export interface BadgeCatalogueEntry {
  key: BadgeKey;
  rule_params: BadgeRuleParams;
}

/**
 * The figures that earned a badge, as of the night it was computed — the
 * merchant's eyes only.
 *
 *   verified_merchant   { verified }
 *   fast_response       { median_within_minutes, threads, window_days }
 *   reliable_seller     { completed, merchant_cancel_percent, disputes_lost, window_days }
 *   custom_specialist   { custom_completed, window_days }
 *   high_completion     { completion_percent, orders, window_days }
 */
export type BadgeEvidence = Record<string, number | boolean>;

export interface OwnBadge extends PublicBadge {
  evidence: BadgeEvidence;
}

/** One window of the merchant's own figures (the last 30 or 90 complete Baghdad days). */
export interface ReputationWindow {
  window_days: number;
  /** Conversation turns measured (a customer's opening message → the first reply). */
  first_reply_count: number;
  /** The bound holding the median reply (15, 30, 60, 120, 240, 480 or 1440 minutes); null under 10 turns or past a day. */
  median_within_minutes: number | null;
  /** The mean reply in minutes, each turn capped at a day. */
  first_reply_avg_minutes: number | null;
  orders_completed: number;
  custom_orders_completed: number;
  orders_cancelled_by_merchant: number;
  disputes_lost: number;
  /** Completed + cancelled by the merchant: what the rates are shares of. */
  orders_ended: number;
  merchant_cancel_percent: number | null;
  completion_percent: number | null;
}

export interface MerchantReputation {
  badges: OwnBadge[];
  /** The store's «يرد عادةً خلال …» line, in minutes; null = not shown. */
  responds_within_minutes: number | null;
  metrics: { window_30: ReputationWindow; window_90: ReputationWindow };
  rules: Record<BadgeKey, BadgeRuleParams>;
  /** The last day the windows include (yesterday, Baghdad). */
  through: string;
}

/** The catalogue: every badge's key and rule numbers. Public, cached at the edge for guests. */
export async function badgeCatalogue(opts?: RequestOptions): Promise<BadgeCatalogueEntry[]> {
  const res = await api.get<{ success: true; badges: BadgeCatalogueEntry[] }>('/api/community/badges', opts);
  return (res.badges ?? []).filter((b) => isBadgeKey(b.key));
}

/**
 * The signed-in merchant's own reputation, or null while it cannot be
 * computed yet (a database a migration behind) — the page says «قيد الحساب»
 * then, not a row of zeros. An account without a store gets the 404 as an
 * `ApiError`, like every other workspace read.
 */
export async function myReputation(opts?: RequestOptions): Promise<MerchantReputation | null> {
  const res = await api.get<{ success: true; reputation: MerchantReputation | null }>('/api/merchant/reputation', opts);
  return res.reputation ?? null;
}

/**
 * The badges a card shows: known keys only (a newer server's badge this build
 * cannot explain is skipped, never drawn as its key), in catalogue order, at
 * most `max`.
 */
export function visibleBadges(badges: ReadonlyArray<{ key: unknown; since?: unknown }> | null | undefined, max = VISIBLE_BADGES_MAX): PublicBadge[] {
  if (!Array.isArray(badges)) return [];
  const since = new Map<BadgeKey, string>();
  for (const b of badges) {
    if (b && isBadgeKey(b.key) && !since.has(b.key)) since.set(b.key, typeof b.since === 'string' ? b.since : '');
  }
  return BADGE_KEYS.filter((k) => since.has(k))
    .slice(0, Math.max(0, max))
    .map((key) => ({ key, since: since.get(key) ?? '' }));
}

// ------------------------------------------------------------ staff evidence

/** On each dispute-desk row (`GET /api/admin/community/complaints[/:id]`): where «المحادثة» and «الطلب» go. */
export interface DisputeDeskLinks {
  /** The conversation the case's order lives in — open it at `/chat/<chat_id>`. */
  chat_id: string | null;
  /** The custom request behind a community order; null for a store order. */
  request_id: string | null;
}

/** `chat.evidence` on a staff read of a disputed order's thread: the case that opened it, by id. */
export interface ChatEvidence {
  community_order_id: string | null;
  order_id: string | null;
  complaint_id: string | null;
  request_id: string | null;
}

/** True when a chat read was refused because the evidence door is shut (not linked, or decided). */
export function isEvidenceRefusal(e: unknown): e is ApiError {
  return e instanceof ApiError && (e.code === 'EVIDENCE_NOT_LINKED' || e.code === 'EVIDENCE_CLOSED');
}
