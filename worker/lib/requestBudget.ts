/**
 * WHO READS A REQUEST'S BUDGET (Q2, plan P1-06, docs/DECISIONS.md rows 262,
 * 266 (٧) and 268).
 *
 * The budget is the customer's hope, not part of the job: it is PRIVATE BY
 * DEFAULT. The customer and an admin always read it; a merchant reads it only
 * when the customer turned on «اعرض ميزانيتي للتجار» (`budget_visible = 1`,
 * migration 0208) — and only a merchant the request is already meant for:
 * a workshop the eligibility engine marked eligible (the workshop board, the
 * «طلبات تناسبك» list, the match notification, the request page when the
 * file reader is `eligible`), a merchant who offered on it, the merchant
 * whose offer was accepted, or the one store a DIRECT request was sent to.
 * Being a merchant account is not enough (the contract's `merchants`
 * audience, packages/contracts/src/requestModel.ts). Nobody else, ever: the
 * public board, the community list, search, a guest, the public API.
 *
 * Stored bytes are never rewritten. A revision spec, an order's request
 * snapshot and a chat card keep the budget they were written with; a reader
 * who may not see it gets them without it (`stripSpecBudget`). A database
 * without the column reads the budget as hidden — private by default is Q2
 * itself — so every reader here tolerates its absence.
 */
import { isMissingSchema } from './merchantApproval';

/** Who is reading: the request's customer, an admin, a merchant the request is meant for, or anyone else. */
export type BudgetReader = 'owner' | 'admin' | 'merchant' | 'public';

/** The switch, as a row stores it: on only when exactly 1. A row without the column reads off. */
export const budgetShown = (visible: unknown): boolean => Number(visible ?? 0) === 1;

/** The budget this reader may see, or null. */
export function budgetFor(budget: unknown, visible: unknown, reader: BudgetReader): number | null {
  if (budget === null || budget === undefined || budget === '') return null;
  const n = Number(budget);
  if (!Number.isFinite(n)) return null;
  if (reader === 'owner' || reader === 'admin') return n;
  return reader === 'merchant' && budgetShown(visible) ? n : null;
}

/**
 * A stored spec or snapshot (a revision, an order's request snapshot, a chat
 * card) as this reader may read it: the budget emptied unless they may see it.
 * The stored row is never touched.
 */
export function stripSpecBudget<T extends Record<string, unknown>>(spec: T, visible: unknown, reader: BudgetReader): T {
  if (!spec || typeof spec !== 'object' || !('budget_iqd' in spec)) return spec;
  const shown = budgetFor(spec.budget_iqd, visible, reader);
  return shown === spec.budget_iqd ? spec : { ...spec, budget_iqd: shown };
}

/**
 * A stored REVISION SNAPSHOT (`{spec, files, estimate, …}`, as an accepted
 * order freezes it) for this reader: the budget emptied in its `spec`, and at
 * the top level for an older shape. Never rewritten in storage.
 */
export function stripSnapshotBudget<T extends Record<string, unknown>>(snapshot: T, visible: unknown, reader: BudgetReader): T {
  const top = stripSpecBudget(snapshot, visible, reader);
  const spec = top.spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return top;
  const inner = stripSpecBudget(spec as Record<string, unknown>, visible, reader);
  return inner === spec ? top : { ...top, spec: inner };
}

/** Does a stored snapshot carry a budget anywhere a reader could see it? */
export const snapshotHasBudget = (snapshot: Record<string, unknown>): boolean =>
  (snapshot.budget_iqd !== null && snapshot.budget_iqd !== undefined) ||
  (!!snapshot.spec && typeof snapshot.spec === 'object' && (snapshot.spec as Record<string, unknown>).budget_iqd != null);

/** The switch of one request, read on its own (a reader whose query cannot name the column). Off when absent. */
export async function budgetVisibleOf(db: D1Database, requestId: string): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT budget_visible FROM community_requests WHERE id = ?').bind(requestId).first<{ budget_visible: unknown }>();
    return budgetShown(row?.budget_visible);
  } catch (e) {
    if (isMissingSchema(e)) return false;
    throw e;
  }
}
