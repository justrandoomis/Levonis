/**
 * Who may see money — mandate §11: "cost وجميع تفاصيل الربح متاحة فقط
 * للمالك/الدور المالي. مساعد الأدمن العادي لا يراها في API ولا في HTML ولا في
 * export".
 *
 * `users.admin_scope` (migration 0021):
 *   NULL / 'full'  unrestricted admin — sees cost, margin and price history
 *   'assistant'    catalogue and operations only; NO cost, NO margin, NO
 *                  supplier price, in the API, the HTML and every export
 *
 * NULL is unrestricted so the migration could not quietly demote a live admin.
 * The site owner (INITIAL_ADMIN_EMAIL) is always financial and can never be
 * demoted — otherwise a compromised assistant could lock the owner out of
 * their own numbers.
 *
 * This is an AUTHORIZATION rule, not a display preference. Every financial
 * field must be removed on the SERVER, before serialization, so that reading
 * the raw API response, the HTML or a downloaded file reveals nothing.
 */

import type { Env, SessionUser } from './types';

export type AdminScope = 'full' | 'assistant';

/**
 * UNSET IS UNRESTRICTED; UNRECOGNISED IS NOT.
 *
 * NULL meaning "full" is deliberate and documented above — migration 0021
 * could not be allowed to quietly demote every live admin. The defect was that
 * everything ELSE also meant full: `'assisstant'` with a typo, a value written
 * by an older build, a half-finished manual UPDATE, or anything a future
 * migration adds and this function has not learned yet all fell through the
 * same `return null`, and `canViewFinancials` reads that as "not an
 * assistant" — so a scope nobody recognised granted the cost, the margin and
 * the supplier price.
 *
 * The two cases are now told apart. Absent stays unrestricted, which is the
 * documented upgrade path. Present-but-unrecognised resolves to the LEAST
 * privilege, because the one thing certain about a value we cannot read is
 * that somebody meant to restrict something.
 */
export function normalizeAdminScope(v: unknown): AdminScope | null {
  if (v === 'assistant') return 'assistant';
  if (v === 'full') return 'full';
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  return 'assistant';
}

/** True when this session may see cost, margin and other financial detail. */
export function canViewFinancials(env: Env, user: SessionUser | null | undefined): boolean {
  if (!user || user.role !== 'admin') return false;
  if (isOwner(env, user)) return true;
  return normalizeAdminScope(user.admin_scope) !== 'assistant';
}

/** The bootstrap owner account named by INITIAL_ADMIN_EMAIL. Only the address
 *  is needed, so a stored user row qualifies as well as a session. */
export function isOwner(env: Env, user: Pick<SessionUser, 'email'> | null | undefined): boolean {
  const owner = (env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!owner || !user) return false;
  return user.email.trim().toLowerCase() === owner;
}

/** Every field name that carries financial information about a product. Used
 *  by the strippers below AND by the export/template paths, so a new financial
 *  field only has to be added in one place. */
export const FINANCIAL_FIELDS = [
  'cost_iqd',
  'product_cost_iqd',
  'margin_iqd',
  'margin_percent',
  'supplier_price_iqd',
  // 0044/§12: a cost adjustment is a cost, and a profit figure IS the margin
  // detail §11 restricts — leaking either would defeat stripping the cost.
  'cost_adjust_iqd',
  'profit_iqd',
] as const;

type AnyRecord = Record<string, unknown>;

/**
 * Recursively removes financial fields from a serializable value. Recursive
 * on purpose: cost lives at product, option, colour AND variant level, and a
 * shallow delete would leak every nested one.
 */
export function stripFinancials<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripFinancials(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: AnyRecord = {};
    for (const [k, v] of Object.entries(value as AnyRecord)) {
      if ((FINANCIAL_FIELDS as readonly string[]).includes(k)) continue;
      out[k] = stripFinancials(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Applies the rule in one call at a route boundary. */
export function projectForAdmin<T>(env: Env, user: SessionUser | null | undefined, payload: T): T {
  return canViewFinancials(env, user) ? payload : stripFinancials(payload);
}

// ------------------------------------------------- who may change whom

/** The stored row an administrator is editing. */
export interface UserPatchTarget {
  id: string;
  role: string;
  email: string;
  is_investor: number | boolean | null;
}

/** What the request asks to set. Absent means "not sent". */
export interface UserPatchChanges {
  role?: 'customer' | 'merchant' | 'admin';
  is_investor?: boolean;
  admin_scope?: AdminScope | null;
}

/**
 * Why an administrator's PATCH of an account must be refused, or null when
 * it may proceed. The route throws forbidden(reason).
 *
 * THE HOLE THIS CLOSES. `admin_scope` was gated — only a financial admin may
 * hand out financial access — but `role` was not, and a freshly promoted
 * admin has admin_scope NULL, which canViewFinancials reads as FULL. So an
 * assistant, who must never see a cost, could promote any account (a second
 * account of their own included) and sign in to unrestricted financials. The
 * same assistant could demote every other admin, the owner included, and
 * hand out investor status. Minting or revoking an administrator IS granting
 * or revoking financial access, so it follows the admin_scope rule; investor
 * status is financial standing, so it does too. Customer ↔ merchant stays an
 * operations task an assistant may do.
 *
 * ONLY A CHANGE IS AN ATTEMPT. The admin panel echoes the whole row on every
 * save, so an assistant editing a membership tier sends role: 'admin' for an
 * admin it never touched. A value equal to what is stored is not a request to
 * change it — the same distinction attemptedFinancialWrites draws for cost.
 */
export function userPatchRefusal(
  env: Env,
  actor: SessionUser,
  target: UserPatchTarget,
  changes: UserPatchChanges
): string | null {
  const financial = canViewFinancials(env, actor);
  if (changes.role !== undefined && changes.role !== target.role) {
    if (target.id === actor.id && changes.role !== 'admin') return 'You cannot remove your own administrator role';
    if (isOwner(env, target) && changes.role !== 'admin') return 'The owner account cannot be demoted';
    if ((changes.role === 'admin' || target.role === 'admin') && !financial) {
      return 'Only a financial administrator can grant or revoke administrator access';
    }
  }
  if (changes.is_investor !== undefined && changes.is_investor !== Boolean(target.is_investor) && !financial) {
    return 'Only a financial administrator can change investor status';
  }
  if (changes.admin_scope !== undefined) {
    if (!financial) return 'Only a financial administrator can change financial access';
    if (changes.admin_scope === 'assistant' && isOwner(env, target)) return 'The owner account cannot be restricted';
  }
  return null;
}

// ------------------------------------------------- the write side of §11

/** The shape the cost rules care about — product doc, or the stored previous. */
export interface CostBearing {
  product_cost_iqd: number | null;
  options: Array<{ id: string; cost_iqd: number | null }>;
  colors: Array<{ id: string; cost_iqd: number | null }>;
}

/**
 * Which financial fields this request ACTUALLY tried to change.
 *
 * ABSENT IS NOT AN ATTEMPT, and that distinction is the whole point. An
 * assistant's own GET returns the document with every cost removed, so their
 * panel posts it back without the key at all. The validator defaults a missing
 * cost to null, so comparing the validated doc against the stored value used to
 * read as "you tried to set it to null" for every product that HAD a cost —
 * which refused the save outright and left an assistant unable to edit even the
 * name of any priced product. So the raw body decides what was sent, and the
 * validated doc decides whether what was sent differs.
 *
 * @param raw  the request body exactly as it arrived, before validation
 * @param doc  the validated document
 * @param prev the stored document, or null when creating
 */
export function attemptedFinancialWrites(
  raw: Record<string, unknown>,
  doc: CostBearing,
  prev: CostBearing | null
): string[] {
  const sentIds = (list: unknown): Set<string> => {
    const out = new Set<string>();
    if (!Array.isArray(list)) return out;
    for (const x of list) {
      if (!x || typeof x !== 'object') continue;
      const id = (x as { id?: unknown }).id;
      if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(x, 'cost_iqd')) out.add(id);
    }
    return out;
  };
  const costOf = (list: Array<{ id: string; cost_iqd: number | null }>) =>
    new Map(list.map((x) => [x.id, x.cost_iqd ?? null]));

  const attempted: string[] = [];
  if (
    Object.prototype.hasOwnProperty.call(raw, 'product_cost_iqd') &&
    (doc.product_cost_iqd ?? null) !== (prev?.product_cost_iqd ?? null)
  ) {
    attempted.push('product_cost_iqd');
  }
  for (const [kind, sent, next, before] of [
    ['option', sentIds(raw.options), costOf(doc.options), costOf(prev?.options ?? [])],
    ['color', sentIds(raw.colors), costOf(doc.colors), costOf(prev?.colors ?? [])],
  ] as const) {
    for (const [id, cost] of next) {
      if (!sent.has(id)) continue; // never on the wire — nothing was attempted
      if ((before.get(id) ?? null) !== (cost ?? null)) attempted.push(`${kind}:${id}.cost_iqd`);
    }
  }
  return attempted;
}

/**
 * Puts the stored costs back on a document an assistant saved, so a save that
 * never carried a cost cannot blank one. Mutates `doc` and returns it.
 */
export function carryStoredCostForward<T extends CostBearing>(doc: T, prev: CostBearing | null): T {
  doc.product_cost_iqd = prev?.product_cost_iqd ?? null;
  const prevOption = new Map((prev?.options ?? []).map((o) => [o.id, o.cost_iqd]));
  for (const o of doc.options) o.cost_iqd = prevOption.get(o.id) ?? null;
  const prevColor = new Map((prev?.colors ?? []).map((x) => [x.id, x.cost_iqd]));
  for (const col of doc.colors) col.cost_iqd = prevColor.get(col.id) ?? null;
  return doc;
}
