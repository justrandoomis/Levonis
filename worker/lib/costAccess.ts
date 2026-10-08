/**
 * COST ACCESS AT THE ROUTE BOUNDARY — owner decision 2 (2026-10-07), step S1.
 *
 * «Main Admin / Owner فقط … أي Admin جديد يبدأ Assistant Admin بدون
 * PRICING_PRIVATE_READ / PRICING_PRIVATE_WRITE … لا أريد تفويض بيانات التكلفة
 * لأي شخص غير Main Admin/Owner».
 *
 * The predicates themselves live in `adminScope.ts` (one source of truth, pure,
 * no Hono). This module is what a ROUTE uses: the uniform refusal, the
 * middleware for router doors, the owner-only gate, the fresh-sign-in gate,
 * the readiness refusal by viewer, and the grant loader the session calls.
 *
 * THE REFUSAL IS ONE ANSWER. A non-owner asking for any cost surface gets
 * 403 `COST_ACCESS_DENIED` with the same generic sentence whatever the route,
 * whether the id exists or not, and with no number, id or field value in it
 * (brief 1 §31, §32, §38): there is nothing to learn from the refusal itself.
 * The one exception is the owner's own session before the address is
 * verified: it hears OWNER_EMAIL_UNVERIFIED, the way to open cost
 * (`costRefusal`, DECISIONS row 185 amendment).
 */
import type { Context, MiddlewareHandler } from 'hono';
import { HttpError } from './http';
import {
  PRIVATE_DELEGATION_ENABLED,
  PRIVATE_GRANTS,
  canMoveMoney,
  canViewCost,
  canWriteCost,
  isOwner,
  isUnverifiedOwner,
  viewerClass,
  type CostSubject,
  type PrivateGrant,
} from './adminScope';
import { FRESH_SESSION_SECONDS, sessionAgeSeconds } from './session';
import type { AppContext, Env } from './types';
import {
  PRODUCT_UNAVAILABLE_SERVER_MESSAGE,
  serverMessage,
} from '../../packages/contracts/src/costRefusals';

// The predicates, re-exported so a route imports its whole cost vocabulary
// from one place. They are DEFINED in adminScope.ts and nowhere else.
export {
  PRIVATE_DELEGATION_ENABLED,
  PRIVATE_GRANTS,
  canMoveMoney,
  canViewCost,
  canWriteCost,
  isOwner,
  isUnverifiedOwner,
  viewerClass,
  type CostSubject,
  type PrivateGrant,
};

/**
 * 403 COST_ACCESS_DENIED. `fields` names the cost fields a write tried to set
 * (names only, never values) so the product form can say which inputs were
 * refused; a read refusal carries nothing.
 */
export function costDenied(details?: { fields?: string[] }): HttpError {
  return new HttpError(
    403,
    serverMessage('COST_ACCESS_DENIED'),
    'COST_ACCESS_DENIED',
    details?.fields && details.fields.length ? { fields: details.fields } : undefined
  );
}

/**
 * 403 OWNER_EMAIL_UNVERIFIED — the owner's own session, while the account's
 * address is not verified yet (DECISIONS row 185, amendment of 2026-10-08).
 * The same shape as `costDenied` (field NAMES on a write, nothing on a read),
 * and a sentence that names the way out instead of "main admin only".
 */
export function ownerEmailUnverified(details?: { fields?: string[] }): HttpError {
  return new HttpError(
    403,
    serverMessage('OWNER_EMAIL_UNVERIFIED'),
    'OWNER_EMAIL_UNVERIFIED',
    details?.fields && details.fields.length ? { fields: details.fields } : undefined
  );
}

/**
 * THE COST REFUSAL, BY CALLER. Every cost door and assert throws this, never
 * `costDenied` directly, so that:
 *
 *   - the owner's admin row whose address is not verified yet hears
 *     OWNER_EMAIL_UNVERIFIED — how to open cost, not a lockout;
 *   - EVERY OTHER CALLER hears exactly the COST_ACCESS_DENIED it heard before,
 *     the same bytes for a real target and an invented one. The choice reads
 *     the caller's own session only (role, address, stamp), never the target,
 *     so it adds no oracle: nobody but the owner's own session can tell the
 *     two answers apart.
 */
export function costRefusal(
  env: Env,
  user: CostSubject | null | undefined,
  details?: { fields?: string[] }
): HttpError {
  return isUnverifiedOwner(env, user) ? ownerEmailUnverified(details) : costDenied(details);
}

export type OwnerOnlyCode =
  | 'OWNER_ONLY'
  | 'SCOPE_ELEVATION_OWNER_ONLY'
  | 'INVESTOR_FLAG_OWNER_ONLY'
  | 'PRIVATE_DELEGATION_DISABLED'
  | 'OWNER_EMAIL_LOCKED';

/** 403 for an act only the owner may perform. */
export function ownerOnly(code: OwnerOnlyCode = 'OWNER_ONLY'): HttpError {
  return new HttpError(403, serverMessage(code), code);
}

/** Throws the cost refusal (`costRefusal`) unless this session may READ cost (the owner). */
export function assertCostRead(c: Context<AppContext>): void {
  const user = c.get('user');
  if (!canViewCost(c.env, user)) throw costRefusal(c.env, user);
}

/** Throws the cost refusal (`costRefusal`) unless this session may WRITE cost (the owner). */
export function assertCostWrite(c: Context<AppContext>, fields?: string[]): void {
  const user = c.get('user');
  if (!canWriteCost(c.env, user)) throw costRefusal(c.env, user, { fields });
}

/** Router door for a cost router: mount after the rate limit, before any id is read. */
export const requireCostRead: MiddlewareHandler<AppContext> = async (c, next) => {
  assertCostRead(c);
  await next();
};

/** Router door for a cost-writing router. */
export const requireCostWrite: MiddlewareHandler<AppContext> = async (c, next) => {
  assertCostWrite(c);
  await next();
};

/** Owner-only acts: the security console, grants, FIFO overrides, historical reconciliation. */
export const requireOwner: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin' || !isOwner(c.env, user)) throw ownerOnly();
  await next();
};

/**
 * A sign-in within the last ten minutes. Elevating an admin's scope is an act
 * a stolen cookie must not be able to perform: the cookie proves a browser
 * holds a session, not that the owner is at it.
 */
export function requireFreshSession(c: Context<AppContext>): void {
  if (sessionAgeSeconds(c) > FRESH_SESSION_SECONDS) {
    throw new HttpError(401, serverMessage('REAUTH_REQUIRED'), 'REAUTH_REQUIRED');
  }
}

/** One missing pricing input, by field NAME. Values never travel. */
export interface PricingMissing {
  level: 'product' | 'option' | 'color' | 'variant';
  id: string;
  field: string;
}

/**
 * The readiness refusal, by viewer (brief 1 §38). The engine steps call it
 * whenever a product's price is not ready:
 *
 *   customer, guest, merchant  PRODUCT_UNAVAILABLE (the existing code and its
 *                              cart wording, master plan F19). At the add and
 *                              quote doors (`door: 'add'`) the code is
 *                              PRODUCT_CURRENTLY_UNAVAILABLE, whose sentence
 *                              is exactly «هذا المنتج غير متوفر حالياً.»
 *                              (critique G-34).
 *   assistant or full admin    PRICING_INCOMPLETE, with no list.
 *   the owner                  PRICING_INCOMPLETE plus `details.missing`
 *                              (field names), the one viewer allowed to know
 *                              what is missing.
 *
 * Status: 404 on reads, 409 on cart, checkout and publish.
 */
export function pricingUnavailable(
  env: Env,
  user: CostSubject | null | undefined,
  missing: readonly PricingMissing[] = [],
  opts: { status?: 404 | 409; door?: 'line' | 'add' } = {}
): HttpError {
  const status = opts.status ?? 409;
  const cls = viewerClass(env, user);
  if (cls === 'owner' || cls === 'cost_grantee') {
    if (canViewCost(env, user)) {
      return new HttpError(409, serverMessage('PRICING_INCOMPLETE'), 'PRICING_INCOMPLETE', {
        missing: missing.map((m) => ({ level: m.level, id: m.id, field: m.field })),
      });
    }
    return new HttpError(409, serverMessage('PRICING_INCOMPLETE'), 'PRICING_INCOMPLETE');
  }
  if (cls === 'assistant_admin' || cls === 'full_admin') {
    return new HttpError(409, serverMessage('PRICING_INCOMPLETE'), 'PRICING_INCOMPLETE');
  }
  if (opts.door === 'add') {
    return new HttpError(status, serverMessage('PRODUCT_CURRENTLY_UNAVAILABLE'), 'PRODUCT_CURRENTLY_UNAVAILABLE');
  }
  return new HttpError(status, PRODUCT_UNAVAILABLE_SERVER_MESSAGE, 'PRODUCT_UNAVAILABLE');
}

/**
 * The live private grants of one admin, for the session loader.
 *
 * READ ONLY WHILE DELEGATION IS ON. With PRIVATE_DELEGATION_ENABLED false (the
 * owner's decision) this returns [] without touching the database, so a grant
 * row — however it got there — cannot widen anyone's access. When delegation
 * is on, any failure (the 0177 table missing on a database the code reached
 * first, a transient D1 error) is also [] — fail closed.
 */
export async function loadPrivateGrants(
  db: D1Database,
  userId: string,
  opts: { delegation?: boolean } = {}
): Promise<PrivateGrant[]> {
  if (!(opts.delegation ?? PRIVATE_DELEGATION_ENABLED)) return [];
  try {
    const { results } = await db
      .prepare('SELECT grant_key FROM admin_private_grants WHERE user_id = ? AND revoked_at IS NULL')
      .bind(userId)
      .all<{ grant_key: string }>();
    const known = new Set<string>(PRIVATE_GRANTS);
    return (results ?? [])
      .map((r) => String(r.grant_key))
      .filter((k): k is PrivateGrant => known.has(k));
  } catch {
    return [];
  }
}
