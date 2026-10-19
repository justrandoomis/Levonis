/**
 * Who owns this store, and is this request allowed to act for it?
 *
 * TENANT ISOLATION LIVES HERE (§54). Every merchant-scoped mutation goes
 * through `requireStoreOwner`, and it constrains on BOTH facts at once:
 * the store row, and the session user's ownership of it. Never one or the
 * other, and never the hostname.
 *
 * The hostname says which storefront is being *viewed*. It says nothing about
 * permission. Opening `ali3d.levonis-iq.com/admin` while signed in as someone
 * else must be a 403, and swapping an id in a request body must never reach
 * another merchant's data — so the ownership check is a WHERE clause on every
 * query, not a branch taken once at the door (§72).
 *
 * SELLING PRIVILEGES ARE SEPARATE FROM DATA ACCESS (§47, §48). When PLUS
 * lapses or an admin suspends a store, the merchant keeps reading their
 * orders, their money and their disputes, and keeps finishing work already
 * accepted. What stops is taking on NEW commercial commitments. Those two
 * questions have two functions — `requireStoreOwner` and
 * `requireSellingPrivileges` — because collapsing them into one is how an
 * expired subscription ends up hiding a merchant's own payout history.
 */

import type { Context } from 'hono';
import type { AppContext } from './types';
import { forbidden, HttpError, notFound, unauthorized } from './http';
import { getTierStatus, benefits, type TierStatus } from './entitlements';
import { approvedAtSql, merchantApproved, merchantNotApprovedRefusal, withApprovalSchema } from './merchantApproval';

export interface MerchantRow {
  id: string;
  user_id: string;
  name: string;
  status: string;
  verified: number;
  badge: string;
  badge_override: string;
  reputation_score: number;
  rating_avg_x100: number;
  rating_count: number;
  completed_orders: number;
  /**
   * 0204 — the approval stamp (Community V3 push 1.4). NULL until a reviewer
   * approved this account; a database without the column reads NULL too, so
   * every gate that asks `merchantApproved` fails CLOSED.
   */
  approved_at: string | null;
}

export interface StoreRow {
  id: string;
  merchant_id: string;
  user_id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  logo_key: string | null;
  banner_key: string | null;
  accent: string;
  categories: string;
  governorate: string;
  service_areas: string;
  contact_phone: string;
  contact_phone_public: number;
  business_hours: string;
  policies: string;
  delivery_settings: string;
  social_links: string;
  /** 0037 — the two merchant-arranged profile-header rows (JSON arrays). */
  profile_links: string;
  profile_facts: string;
  accepts_custom_requests: number;
  sells_direct_products: number;
  status: string;
  status_reason: string;
  created_at: string;
  updated_at: string;
}

export interface StoreContext {
  store: StoreRow;
  merchant: MerchantRow;
}

/** Loads a store and its merchant by slug. Public read — no session needed. */
export async function storeBySlug(db: D1Database, slug: string): Promise<StoreContext | null> {
  return storeContextWhere(db, 's.slug', slug);
}

/** Loads a store and its merchant by store id. */
export async function storeById(db: D1Database, storeId: string): Promise<StoreContext | null> {
  return storeContextWhere(db, 's.id', storeId);
}

/** The merchant entity for a user, if they have one. `approved_at` is NULL on a database without 0204. */
export async function merchantForUser(db: D1Database, userId: string): Promise<MerchantRow | null> {
  const row = await db
    .prepare('SELECT * FROM community_merchants WHERE user_id = ?')
    .bind(userId)
    .first<MerchantRow>();
  return row ? { ...row, approved_at: merchantApproved(row) ? row.approved_at : null } : null;
}

/** The store owned by a user, if they have one. */
export async function storeForUser(db: D1Database, userId: string): Promise<StoreContext | null> {
  return storeContextWhere(db, 's.user_id', userId);
}

/**
 * THE THREE STORE-CONTEXT READS, ONE QUERY (push 1.4): the store row, its
 * merchant's columns, and the merchant's approval stamp — read by every gate
 * through `merchantApproved(ctx.merchant)`. On a database without 0204 the
 * stamp reads NULL (`withApprovalSchema`), so the store still loads for its
 * owner's finishing routes while every new commitment and every public read
 * is closed (C11).
 */
async function storeContextWhere(
  db: D1Database,
  column: 's.slug' | 's.id' | 's.user_id',
  value: string
): Promise<StoreContext | null> {
  const row = await withApprovalSchema((schema) =>
    db
      .prepare(
        `SELECT s.*, m.id AS m_id, m.user_id AS m_user_id, m.name AS m_name, m.status AS m_status,
                m.verified AS m_verified, m.badge AS m_badge, m.badge_override AS m_badge_override,
                m.reputation_score AS m_rep, m.rating_avg_x100 AS m_rating, m.rating_count AS m_rating_count,
                m.completed_orders AS m_completed, ${approvedAtSql('m', schema)} AS m_approved_at
           FROM merchant_stores s
           JOIN community_merchants m ON m.id = s.merchant_id
          WHERE ${column} = ?`
      )
      .bind(value)
      .first<Record<string, unknown>>()
  );
  return row ? splitStoreRow(row) : null;
}

/**
 * NO PERMISSIVE DEFAULT (gap §3.4). A column the read did not return is not
 * read as the friendly value: a missing status is '' (which no allow-list
 * admits — `storeTakesOrders` and `merchantTakesNewWork` ask for exactly
 * 'active'), and a missing stamp is NULL (not approved).
 */
function splitStoreRow(row: Record<string, unknown>): StoreContext {
  const merchant: MerchantRow = {
    id: String(row.m_id),
    user_id: String(row.m_user_id),
    name: String(row.m_name),
    status: typeof row.m_status === 'string' ? row.m_status : '',
    verified: Number(row.m_verified ?? 0),
    badge: String(row.m_badge ?? 'new'),
    badge_override: String(row.m_badge_override ?? ''),
    reputation_score: Number(row.m_rep ?? 0),
    rating_avg_x100: Number(row.m_rating ?? 0),
    rating_count: Number(row.m_rating_count ?? 0),
    completed_orders: Number(row.m_completed ?? 0),
    approved_at: typeof row.m_approved_at === 'string' && row.m_approved_at.trim() !== '' ? row.m_approved_at : null,
  };
  const store = { ...row } as unknown as StoreRow;
  for (const k of Object.keys(row)) if (k.startsWith('m_')) delete (store as unknown as Record<string, unknown>)[k];
  return { store, merchant };
}

/**
 * The signed-in user's own store, or a 403/404.
 *
 * This is the ONLY way a route should obtain a store it is about to write to.
 * It refuses on the store row's own `user_id`, so passing someone else's
 * store id in a body or a URL cannot widen access — there is no id to swap.
 */
export async function requireStoreOwner(c: Context<AppContext>): Promise<StoreContext> {
  const user = c.get('user');
  if (!user) throw unauthorized();
  const ctx = await storeForUser(c.env.DB, user.id);
  if (!ctx) throw notFound('You do not have a store yet');
  // Belt and braces: the row was fetched BY user_id, so this cannot currently
  // fail. It is here so that if the query above is ever changed to take an id
  // from the request, the ownership check does not silently disappear with it.
  if (ctx.store.user_id !== user.id) throw forbidden('This store belongs to another account');
  // For the routers' purge middleware (worker/lib/edgePolicy.ts): the slug
  // as it is BEFORE this request's write, which is the one a rename retires.
  c.set('merchantStore', { id: ctx.store.id, slug: ctx.store.slug });
  return ctx;
}

/**
 * The same store, but also entitled to take on NEW commercial commitments.
 *
 * Publishing a product, accepting an order, submitting an offer. NOT: reading
 * orders, answering a customer, finishing accepted work, seeing money owed —
 * those stay available through `requireStoreOwner` even after PLUS lapses,
 * because a merchant with an unfinished order and a pending payout must be
 * able to see and finish both (§48).
 */
export async function requireSellingPrivileges(c: Context<AppContext>): Promise<StoreContext> {
  return sellingGate(c, true);
}

/**
 * TAKING A PROMISE BACK (gap §3.4 E4). Withdrawing an offer asks what selling
 * asks EXCEPT approval: an unapproved merchant's standing offers are exactly
 * the existing work they must be able to close — nothing new is promised by
 * withdrawing one.
 */
export async function requireWithdrawPrivileges(c: Context<AppContext>): Promise<StoreContext> {
  return sellingGate(c, false);
}

/**
 * A DRAFT IS NOT A PROMISE (Community V3 push 1.3, wave 1). Writing a product
 * that stays a DRAFT asks what selling asks EXCEPT approval — the same line as
 * a store-page draft (E10): nothing in it reaches a customer, so a merchant
 * under review prepares their catalogue while the reviewer decides. The
 * caller refuses MERCHANT_NOT_APPROVED itself the moment the write would
 * leave a product published (worker/routes/merchantCatalog.ts).
 */
export async function requireDraftPrivileges(c: Context<AppContext>): Promise<StoreContext> {
  return sellingGate(c, false);
}

async function sellingGate(c: Context<AppContext>, approvalRequired: boolean): Promise<StoreContext> {
  const ctx = await requireStoreOwner(c);
  const user = c.get('user')!;

  // Each refusal names its cause with a stable code — the two sanctions are
  // separate rows (worker/routes/adminCommunity.ts) and the merchant is told
  // which one applies, not a generic FORBIDDEN.
  if (ctx.merchant.status === 'suspended') {
    throw new HttpError(403, 'This merchant account is suspended. Contact support.', 'MERCHANT_SUSPENDED');
  }
  if (ctx.store.status === 'suspended') {
    throw new HttpError(403, 'This store is suspended by Levonis. Contact support.', 'STORE_SUSPENDED');
  }
  // THE APPROVAL GATE (Community V3 push 1.4, E3; owner decisions C1/C2): no
  // reviewer approved this account, so nothing new is published, priced or
  // promised from its store — the merchant alone hears why.
  if (approvalRequired && !merchantApproved(ctx.merchant)) throw merchantNotApprovedRefusal();
  if (ctx.store.status === 'paused') {
    throw new HttpError(403, 'Your store is paused. Re-open it in store settings to sell again.', 'STORE_PAUSED');
  }

  const tier = await getTierStatus(c.env.DB, user.id);
  if (!benefits.merchantStore(tier)) {
    throw new HttpError(
      403,
      'Your LEVO PLUS subscription is not active. Your store and its history are kept — renew to sell again.',
      'SUBSCRIPTION_INACTIVE'
    );
  }
  return ctx;
}

/**
 * MAY THIS MERCHANT MAKE A NEW PROMISE ON A CUSTOMER'S REQUEST?
 *
 * Making an offer, re-confirming one the customer's change made stale, and
 * re-pricing one (an edit re-confirms — worker/routes/marketplace.ts) are each
 * a new commitment: everything `requireSellingPrivileges` asks, AND a merchant
 * in good standing. A RESTRICTED merchant — Levonis's sanction short of a
 * suspension: the store stays visible and existing work goes on, but no new
 * orders (`storeTakesOrders`, worker/lib/storeOrderOps.ts) and no new offers —
 * was refused only by the matcher, which stopped telling them about requests
 * but let them bid on any they found (audit 03 V, audit 04 #23).
 *
 * AN ALLOW-LIST, like the buy path: anything but exactly `active` is refused,
 * so a status nobody has taught this function stops bids rather than slipping
 * past. Withdrawing an offer stays on `requireSellingPrivileges` — taking a
 * promise back is never refused to a restricted merchant.
 */
export async function requireOfferPrivileges(c: Context<AppContext>): Promise<StoreContext> {
  const ctx = await requireSellingPrivileges(c);
  if (ctx.merchant.status !== 'active') {
    throw new HttpError(
      403,
      'Levonis has restricted your merchant account: you cannot make or re-confirm offers until the restriction is lifted. Your accepted work continues — contact support.',
      'MERCHANT_RESTRICTED'
    );
  }
  return ctx;
}

/**
 * May this user sell at all right now? A question, not a gate.
 * Used by read endpoints that must SHOW the merchant why something is
 * disabled instead of hiding it, which is what §84 asks for.
 */
export async function sellingStatus(
  c: Context<AppContext>,
  ctx: StoreContext
): Promise<{ canSell: boolean; reason: string }> {
  const user = c.get('user');
  if (!user) return { canSell: false, reason: 'signed_out' };
  return sellingVerdict(c.env.DB, ctx, user.id);
}

/**
 * MAY THIS MERCHANT WRITE DRAFTS? `requireDraftPrivileges` as a question, for
 * the workspace to keep «new product» open under review (push 1.3): selling's
 * answer, or — when the ONLY thing missing is approval — selling's answer with
 * the approval line set aside. A sanction, a pause or a lapsed PLUS still says
 * no, exactly as the draft gate does.
 */
export async function draftStatus(
  db: D1Database,
  ctx: StoreContext,
  ownerUserId: string,
  selling: { canSell: boolean; reason: string }
): Promise<boolean> {
  if (selling.canSell) return true;
  if (selling.reason !== 'not_approved') return false;
  return (await sellingVerdict(db, ctx, ownerUserId, undefined, { approval: false })).canSell;
}

/**
 * THE SAME ANSWER, FOR A NAMED ACCOUNT RATHER THAN THE SIGNED-IN ONE.
 *
 * `sellingStatus` asks it of the session user — right on the merchant's own
 * dashboard, where the session IS the owner. The buy path asks it of the
 * store's OWNER while a CUSTOMER is signed in (worker/lib/storeOrderOps.ts,
 * `storeTakesOrders`): a lapsed PLUS stopped nothing at checkout because the
 * only copy of this rule read `c.get('user')`, which there is the buyer.
 */
export async function sellingVerdict(
  db: D1Database,
  ctx: StoreContext,
  ownerUserId: string,
  // The owner's tier when the caller already read it this request — the same
  // `getTierStatus` answer, judged by the same rule, read once (P2a).
  ownerTier?: TierStatus,
  // `approval: false` sets the approval line aside — ONLY for `draftStatus`.
  opts: { approval?: boolean } = {}
): Promise<{ canSell: boolean; reason: string }> {
  if (ctx.merchant.status === 'suspended') return { canSell: false, reason: 'merchant_suspended' };
  if (ctx.store.status === 'suspended') return { canSell: false, reason: 'store_suspended' };
  // E5: an unapproved merchant's store takes no new order (the buyer hears STORE_CLOSED).
  if (opts.approval !== false && !merchantApproved(ctx.merchant)) return { canSell: false, reason: 'not_approved' };
  if (ctx.store.status === 'paused') return { canSell: false, reason: 'store_paused' };
  const tier = ownerTier ?? (await getTierStatus(db, ownerUserId));
  if ((tier.gated_benefits ?? []).includes('merchantStore')) {
    return { canSell: false, reason: 'benefit_restricted' };
  }
  if (!benefits.merchantStore(tier)) return { canSell: false, reason: 'subscription_inactive' };
  return { canSell: true, reason: '' };
}

/**
 * MAY THIS MERCHANT RE-OPEN THEIR PAUSED STORE? (gap §3.4 E8.) Re-opening is
 * taking on new orders, so it is the selling rule itself — `sellingVerdict`
 * — asked of the store as it would stand once open. The settings route kept
 * an inline copy of it (merchant suspended, plan lapsed) that knew nothing of
 * approval; the copy is gone. Null when it may.
 */
export async function reopenRefusal(db: D1Database, ctx: StoreContext): Promise<HttpError | null> {
  const verdict = await sellingVerdict(db, { store: { ...ctx.store, status: 'active' }, merchant: ctx.merchant }, ctx.store.user_id);
  if (verdict.canSell) return null;
  switch (verdict.reason) {
    case 'merchant_suspended':
      return new HttpError(403, 'This merchant account is suspended. Contact support.', 'MERCHANT_SUSPENDED');
    case 'not_approved':
      return merchantNotApprovedRefusal();
    default:
      return new HttpError(403, 'Your store subscription is not active. Renew it to re-open the store.', 'SUBSCRIPTION_INACTIVE');
  }
}

/**
 * Is a store open for business to the public?
 * A suspended or paused store still RESOLVES — its page renders and explains
 * itself, and its existing customers keep their orders and chats. It simply
 * cannot take new ones.
 */
export function storeIsOpen(ctx: StoreContext): boolean {
  return ctx.store.status === 'active' && !storeHiddenFromPublic(ctx);
}

/**
 * Is this storefront under an ADMIN sanction — its own store suspension, or
 * its owner's merchant suspension?
 *
 * OWNER DECISION (2026-09-24, docs/MERCHANT_PLATFORM.md §2): a customer on an
 * admin-suspended store sees only «المتجر غير متاح حاليًا» — no products,
 * banner, bio or reviews. The two sanctions are separate rows and neither
 * writes the other (worker/routes/adminCommunity.ts), so the public reads ask
 * both here, in one place. `paused` is NOT a sanction: it is the merchant's
 * own switch, and a paused shop stays visible and says it is closed.
 */
export function storeSanctioned(ctx: StoreContext): boolean {
  return ctx.store.status === 'suspended' || ctx.merchant.status === 'suspended';
}

/**
 * MAY THE PUBLIC SEE THIS STORE AT ALL? (gap §3.6, push 1.4.) Not under a
 * sanction (`storeSanctioned`), AND its merchant approved by a reviewer
 * (owner decisions C1/C2). Every public read of one store — the subdomain,
 * the slug and id pages, an old slug's redirect, the PWA manifest and icons,
 * the share card — asks this, and a hidden store answers one generic
 * `STORE_UNAVAILABLE` (C9): never "under review", never "rejected". A store
 * its merchant PAUSED is not hidden: its page says it is closed (C10).
 */
export function storeHiddenFromPublic(ctx: StoreContext): boolean {
  return storeSanctioned(ctx) || !merchantApproved(ctx.merchant);
}
