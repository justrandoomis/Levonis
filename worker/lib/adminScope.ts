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

export function normalizeAdminScope(v: unknown): AdminScope | null {
  if (v === 'assistant') return 'assistant';
  if (v === 'full') return 'full';
  return null;
}

/** True when this session may see cost, margin and other financial detail. */
export function canViewFinancials(env: Env, user: SessionUser | null | undefined): boolean {
  if (!user || user.role !== 'admin') return false;
  if (isOwner(env, user)) return true;
  return normalizeAdminScope(user.admin_scope) !== 'assistant';
}

/** The bootstrap owner account named by INITIAL_ADMIN_EMAIL. */
export function isOwner(env: Env, user: SessionUser | null | undefined): boolean {
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
