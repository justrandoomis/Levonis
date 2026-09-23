/**
 * LEVO COMMUNITY IS UNDER MAINTENANCE — «ليفو كوميونيتي تحت الصيانة، واسمح
 * بالأعضاء من قائمة في الادارة» — by one row, on the server, with a named
 * list of people who may still come in.
 *
 * WHY THE REFUSAL LIVES HERE AND NOT IN THE APP. Hiding the Community tab in
 * BottomNav.tsx hides a LINK, not an API. `/api/community/requests` answers a
 * curl from anyone, and the routes behind this gate write real rows —
 * customer requests, merchant profiles, products, follows. A client-only
 * gate is not a gate, so the refusal is here, in front of the handlers, and
 * everything the SPA does about it is presentation on top.
 *
 * ONE SWITCH, IN THE HOUSE'S STORE. `admin_settings.communityGate` holds
 * `{"open": boolean, "allowed_user_ids": ["usr_…"]}` and nothing else opens
 * the community: a missing row, an empty value, unparseable JSON,
 * `{"open": "true"}`, an `allowed_user_ids` that is not an array — every one
 * of them reads CLOSED with an EMPTY allow-list. That default is deliberate,
 * and it is the same one the printer farm ships with
 * (worker/routes/farm.ts, "the shelving switch"): the deploy itself carries
 * out the owner's instruction instead of waiting for someone to remember a
 * database write, and a database that has lost the row closes the community
 * rather than quietly opening it to everybody.
 *
 * WHY THE ALLOW-LIST IS A SETTINGS ROW AND NOT A COLUMN ON `users`. It is a
 * TEMPORARY testing door. It has to be flippable in one write, without a
 * deploy and without a migration — a migration is append-only here and would
 * leave a column behind on every user row long after the community opens and
 * the list stops meaning anything. A settings row can be emptied, and then it
 * is genuinely gone. It also keeps the whole decision in ONE place that one
 * audited admin route writes, instead of spread across a table nobody would
 * think to look at a year from now.
 *
 * IT IS USER IDS, NEVER USERNAMES OR EMAILS. A username can be changed by the
 * person holding it; an email can be re-registered. Matching a gate on
 * anything the user controls turns the allow-list into an impersonation
 * surface — you would only need to rename yourself into the list. `users.id`
 * is server-minted and immutable, so it is the only key this may use.
 *
 * NOTHING IS DELETED BY CLOSING. No merchant, no product, no request, no
 * follow, no order: the refusal is a door, and every store behind it stays
 * exactly as its owner left it.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppContext, SessionUser } from './types';
import { HttpError } from './http';

export const COMMUNITY_GATE_SETTING_KEY = 'communityGate';

/** The switch as the server understands it: open to all, or open to a list. */
export interface CommunityGate {
  /** True only when the stored value literally says `"open": true`. */
  open: boolean;
  /** The user ids let through while it is closed. Empty unless the row says otherwise. */
  allowed: readonly string[];
}

/** What every unreadable answer means. Referenced by name so it cannot drift. */
export const COMMUNITY_GATE_CLOSED: CommunityGate = { open: false, allowed: [] };

/**
 * Read the stored value. Only `{"open": true}` opens the community, and only
 * an `allowed_user_ids` that is genuinely an array of non-empty strings
 * contributes names to the list — a string, a number, a null, an object, or
 * an array with junk in it yields the entries it can read and drops the rest,
 * because a value nobody can parse is not a decision anybody made.
 */
export function communityGateFromSetting(value: string | null | undefined): CommunityGate {
  if (typeof value !== 'string' || value.trim() === '') return COMMUNITY_GATE_CLOSED;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return COMMUNITY_GATE_CLOSED;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return COMMUNITY_GATE_CLOSED;
  const row = parsed as { open?: unknown; allowed_user_ids?: unknown };
  const open = row.open === true;
  const allowed = Array.isArray(row.allowed_user_ids)
    ? row.allowed_user_ids.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];
  return { open, allowed };
}

/** The switch, from one indexed read on a tiny table. */
export async function readCommunityGate(db: D1Database): Promise<CommunityGate> {
  const row = await db
    .prepare('SELECT value FROM admin_settings WHERE key = ?')
    .bind(COMMUNITY_GATE_SETTING_KEY)
    .first<{ value: string }>();
  return communityGateFromSetting(row?.value);
}

/**
 * THE ADMIN DOOR. Every platform admin keeps the community open to
 * themselves, because that is how it gets finished, tested and moderated
 * while it is shut. This is the same server-side role check the rest of the
 * admin surface runs on (`users.role`, written by the server) — not a new
 * secret, not a query parameter, not a header anybody can send.
 */
export function communityAdminDoor(user: SessionUser | null | undefined): boolean {
  return user?.role === 'admin';
}

/**
 * May this viewer come in? Open to everyone, or an admin, or a signed-in user
 * whose id the owner put on the list. A signed-out caller is never on the
 * list: there is no id to match, and an empty id must not match an empty slot.
 */
export function communityMayEnter(gate: CommunityGate, user: SessionUser | null | undefined): boolean {
  if (gate.open) return true;
  if (communityAdminDoor(user)) return true;
  const id = user?.id;
  return typeof id === 'string' && id !== '' && gate.allowed.includes(id);
}

/**
 * 503, not 404 and not 403. The route exists, it is answering, and it is
 * telling the truth about why it will not act: the community is under
 * maintenance. A 404 would say "there was never a community here", which is a
 * lie the client would then have to translate into «تحت الصيانة» anyway, and
 * which would make reopening it look like a new feature rather than an open
 * door. 403 would be a lie too — the caller is not forbidden, the place is
 * shut to everyone who is not on the list. `code` is what the client keys
 * off; `details.closed` says it is the switch, not an outage.
 */
export function communityClosedRefusal(): HttpError {
  return new HttpError(
    503,
    'ليفو كوميونيتي تحت الصيانة / Levo Community is under maintenance and is not open yet',
    'COMMUNITY_CLOSED',
    { closed: true }
  );
}

/**
 * WHAT IS INSIDE THE WALL, AND WHAT IS DELIBERATELY OUTSIDE IT.
 *
 * The gate below runs on `/api/community/*`. These prefixes are the exception
 * — they answer normally even while the community is closed — and each one is
 * here for a reason that was traced to a caller, not assumed:
 *
 *   * `/api/community/my-store` (and `/my-store/products`) is MERCHANT
 *     SELF-SERVICE. src/components/MerchantDashboard.tsx runs a live shop from
 *     it — catalogue, storefront settings, and the Orders tab beside them —
 *     and src/components/DashboardLayout.tsx, src/pages/EditProfile.tsx and
 *     src/pages/Chat.tsx all read it to decide what a merchant is shown at
 *     all. Those shops are also served on their OWN subdomains, which are not
 *     behind this wall, so they keep taking real IQD while the directory is
 *     shut. Closing a merchant out of their own catalogue would strand trade
 *     that is already in flight, and the owner asked to close a browsing
 *     surface, not a business.
 *   * `/api/community/profile-status` is the same answer one step earlier: it
 *     is how the app decides whether to offer someone the merchant screens.
 *   * `/api/community/access` is the status route itself, which MUST answer
 *     while the community is closed — that is its entire job.
 *
 * Everything else under `/api/community` is inside: the product feed, the
 * merchant directory, the public request board and posting to it, the in-site
 * store page, and follows. That is the Levo Community the owner named.
 *
 * ALSO OUTSIDE, AND ON PURPOSE (no middleware is mounted on them): the
 * merchant-subdomain storefronts (`/api/storefront`, `/api/store-orders`),
 * the escrowed request marketplace (`/api/marketplace`),
 * `/api/community-reviews` — whose `/eligible` is computed from a DELIVERED
 * order and whose follow routes src/pages/Storefront.tsx calls on the
 * subdomain — and `/api/community-favorites`, which is the save button on
 * that same storefront page. Gating those would half-break shops that are
 * open by their own address: the page would render and its buttons would
 * answer 503. A shop with its own address is not the directory.
 *
 * The match is a PREFIX match on the full request path, and anything that
 * does not match is INSIDE the wall. That is the safe direction: a route
 * added later is gated until somebody deliberately names it here.
 */
export const COMMUNITY_GATE_OPEN_PATHS: readonly string[] = [
  '/api/community/access',
  '/api/community/my-store',
  '/api/community/profile-status',
];

/** True while this path is one of the few that answer with the wall up. */
export function communityPathOutsideWall(path: string): boolean {
  return COMMUNITY_GATE_OPEN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * The gate itself. Registered with `use('*')` at the top of the community
 * router so it sits in front of EVERY handler below it — the public product
 * feed included, because a community under maintenance publishing a live
 * merchant directory is the same surface the owner asked to close — and in
 * front of each route's own `requireAuth`, so a signed-out caller is told the
 * place is shut rather than being asked to sign in for a page that would
 * refuse them anyway.
 *
 * It reads `c.get('user')`, which is safe here: the global session middleware
 * in worker/index.ts runs on '*' before any router is mounted, so the session
 * is already resolved by the time this runs.
 */
export function communityGate(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if (communityPathOutsideWall(c.req.path)) {
      await next();
      return;
    }
    const gate = await readCommunityGate(c.env.DB);
    if (!communityMayEnter(gate, c.get('user'))) throw communityClosedRefusal();
    await next();
  };
}
