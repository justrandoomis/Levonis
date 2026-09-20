/**
 * Admin scope over the principal (`01-TARGET.md` §3.4, ADR-002 (a)): Identity
 * folds the owner rule into the signed `scope` claim (`owner | full |
 * assistant | null`), so no service needs `INITIAL_ADMIN_EMAIL` to decide who
 * may see money. `normalizeAdminScope`, `FINANCIAL_FIELDS` and
 * `stripFinancials` are byte-identical copies of `worker/lib/adminScope.ts`
 * (pinned by `tests/edgeParity.test.ts`).
 */
import type { Principal, PrincipalScope } from '@levonis/contracts/rpc/common';

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
  // 0098 — THE INVENTORY ACQUISITION COSTS. A lot's unit cost IS the cost of
  // goods sold for the units in it, so §11 covers it exactly as it covers
  // cost_iqd. The three components are the same fact broken into its parts,
  // and the totals are it summed — leaking any one would defeat stripping the
  // others.
  //
  // QUANTITIES ARE NOT HERE, and that is the line this list draws. An
  // assistant admin needs to see that twenty units are on the shelf and four
  // are reserved; §52 restricts what those units COST, not how many.
  //
  // Line comments and not a block: tests/edgeParity.test.ts extracts this
  // declaration by scanning balanced brackets and skips // but not /* */, so a
  // JSDoc here with a parenthesis in it reads as an unclosed declaration.
  'unit_cost_iqd',
  'purchase_unit_iqd',
  'purchase_total_iqd',
  'shipping_total_iqd',
  'shipping_share_iqd',
  'internal_delivery_total_iqd',
  'internal_share_iqd',
  'total_cost_iqd',
  'cogs_iqd',
  'inventory_value_iqd',
  'oldest_unit_cost_iqd',
  'newest_unit_cost_iqd',
  'gross_profit_iqd',
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

/** The signed claim Identity computes: owner > full > assistant; null for non-admins. */
export function scopeFor(input: { role: string; admin_scope: unknown; isOwner: boolean }): PrincipalScope {
  if (input.role !== 'admin') return null;
  if (input.isOwner) return 'owner';
  return normalizeAdminScope(input.admin_scope) === 'assistant' ? 'assistant' : 'full';
}

/** True when this principal may see cost, margin and other financial detail. */
export function canViewFinancials(p: Principal | null | undefined): boolean {
  if (!p || p.role !== 'admin') return false;
  return p.scope === 'owner' || p.scope === 'full';
}

export const isOwnerPrincipal = (p: Principal | null | undefined): boolean => !!p && p.role === 'admin' && p.scope === 'owner';

/** Applies the rule in one call at a route boundary. */
export function projectForPrincipal<T>(p: Principal | null | undefined, payload: T): T {
  return canViewFinancials(p) ? payload : stripFinancials(payload);
}

/** `admin:full` in the capability table = an admin whose scope is not `assistant`. */
export function meetsRequirement(p: Principal | null | undefined, requires: 'none' | 'auth' | 'investor' | 'admin' | 'admin:full'): boolean {
  switch (requires) {
    case 'none':
      return true;
    case 'auth':
      return !!p && p.role !== 'anonymous' && p.role !== 'system';
    case 'investor':
      return !!p && (p.investor || p.role === 'admin');
    case 'admin':
      return !!p && p.role === 'admin';
    case 'admin:full':
      return canViewFinancials(p);
  }
}
