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
