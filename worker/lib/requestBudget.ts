/**
 * WHO READS A REQUEST'S BUDGET (Q2, plan P1-06, docs/DECISIONS.md rows 262,
 * 266 (٧) and 268).
 *
 * The budget is the customer's hope, not part of the job: it is PRIVATE BY
 * DEFAULT. The customer and an admin always read it. A merchant reads it only
 * when the customer turned on «اعرض ميزانيتي للتجار» (`budget_visible = 1`,
 * migration 0208), and only a merchant the request is meant for — the
 * contract's `merchants` audience (packages/contracts/src/requestModel.ts
 * `REQUEST_FIELD_VISIBILITY`): a workshop the eligibility engine found
 * eligible for it, the merchant whose offer was accepted, or the one store a
 * DIRECT request was sent to. Being a merchant account is not enough, and
 * neither is having once offered on it (critique 2 of the P1-06 server list):
 * every door asks the one authority that already knows — the workshop board
 * and «طلبات تناسبك» (`eligible = 1` on this revision), and the file policy's
 * reader (`fileReader`: `eligible`, which a sent direct request's store also
 * is, and `engaged`). Nobody else, ever: the public board, the community
 * list, search, a guest, a member, the public API.
 *
 * NO NOTIFICATION CARRIES IT, whatever the switch says: a stored notification
 * is composed once and never rewritten, so a budget in it would outlive a
 * switch turned off later (worker/routes/printRequests.ts `PrintMatchFacts`).
 * And a chat card shows it only to a reader its thread names (fail closed,
 * worker/lib/chatCards.ts `cardBudgetReader`).
 *
 * A REQUEST THE CHAT SHEET MADE FOR ONE STORE (critique 3) is the one place
 * the switch is not the whole answer: a budget typed in that short in-chat
 * form was written for that store, so its store reads it (`budgetSwitchOf`).
 * The sheet now stores the switch on, but every such row written before it
 * stores it off, and B0 rewrites no row (no migration): the rule is read here.
 *
 * Stored bytes are never rewritten. A revision spec, an order's request
 * snapshot and a chat card keep the budget they were written with; a reader
 * who may not see it gets them without it (`stripSpecBudget`). A database
 * without the column reads the budget as hidden — private by default is Q2
 * itself — so every reader here tolerates its absence.
 */
import { isMissingSchema } from './merchantApproval';
import type { FileReader } from './requestFilePolicy';

/** Who is reading: the request's customer, an admin, a merchant the request is meant for, or anyone else. */
export type BudgetReader = 'owner' | 'admin' | 'merchant' | 'public';

/** The switch, as a row stores it: on only when exactly 1. A row without the column reads off. */
export const budgetShown = (visible: unknown): boolean => Number(visible ?? 0) === 1;

/**
 * The private `notes` mark the request editor's entries leave on the draft
 * they make (`entry:<kind>:<id>`, worker/routes/requestEntries.ts
 * `originNote`). `notes` is written when a request is created and never
 * after, and no reader but the customer's own rows returns it.
 */
export const ENTRY_NOTE_PREFIX = 'entry:';

/**
 * A DIRECT REQUEST THE CUSTOMER MADE IN A STORE'S CONVERSATION (0151:
 * `visibility = 'direct'`, `created_by = 'customer'`, `origin_chat_id` set):
 * the chat sheet's own row. Its only merchant readers are the store it is
 * addressed to (the file policy's `eligible`, and `engaged` once its offer is
 * accepted), never a workshop of the board. A row read without those columns
 * answers no, which keeps the budget hidden.
 *
 * NARROWED FOR THE REQUEST EDITOR'S DIRECT SEND (P1-06 2b, B0b): the editor's
 * store and product entries make a direct draft too, and its send records the
 * conversation, so after the send such a row has every mark above. It also
 * carries the editor's entry mark in `notes` (`ENTRY_NOTE_PREFIX`), which the
 * chat sheet never writes (it stores `notes = ''`). Those rows are left out
 * here: the editor asks with the switch «اعرض ميزانيتي للتجار», and only the
 * switch decides what their store reads. The chat sheet's rows written before
 * it stored the switch keep this read rule (no row is rewritten).
 */
export const madeInChatForOneStore = (r: Record<string, unknown>): boolean =>
  r.visibility === 'direct' &&
  r.created_by === 'customer' &&
  typeof r.origin_chat_id === 'string' &&
  r.origin_chat_id !== '' &&
  !String(r.notes ?? '').startsWith(ENTRY_NOTE_PREFIX);

/**
 * The switch AS A MERCHANT THE REQUEST IS MEANT FOR READS IT, from a request
 * row: on when the customer turned it on, and on for a request the chat sheet
 * made for one store (a budget typed there is for that store, critique 3,
 * including the rows written before the sheet stored the switch). Every
 * other reader still goes through `budgetFor`, so a guest, a member and a
 * workshop the request is not for never read it either way.
 */
export const budgetSwitchOf = (r: Record<string, unknown> | null | undefined): 0 | 1 =>
  r && (budgetShown(r.budget_visible) || madeInChatForOneStore(r)) ? 1 : 0;

/** The budget this reader may see, or null. */
export function budgetFor(budget: unknown, visible: unknown, reader: BudgetReader): number | null {
  if (budget === null || budget === undefined || budget === '') return null;
  const n = Number(budget);
  if (!Number.isFinite(n)) return null;
  if (reader === 'owner' || reader === 'admin') return n;
  return reader === 'merchant' && budgetShown(visible) ? n : null;
}

/**
 * THE BUDGET READER A CALLER IS, from what the door already knows about them:
 * the customer, an admin by role, and otherwise the file policy's reader
 * (worker/lib/requestFilePolicy.ts `fileReader`). `eligible` is a workshop
 * whose live verdict on this request is eligible, or the store a sent direct
 * request is addressed to; `engaged` is the accepted merchant. Those two are
 * the contract's `merchants`; everyone else, signed in or not, is `public`.
 */
export function budgetReaderOf(p: { isOwner: boolean; isAdmin: boolean; reader: FileReader | null | undefined }): BudgetReader {
  if (p.isOwner || p.reader === 'owner') return 'owner';
  if (p.isAdmin || p.reader === 'admin') return 'admin';
  return p.reader === 'eligible' || p.reader === 'engaged' ? 'merchant' : 'public';
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

/**
 * The switch of one request as a merchant it is meant for reads it
 * (`budgetSwitchOf`), read on its own (a reader whose query cannot name the
 * columns). The whole row, so a database without a column reads it off.
 */
export async function budgetVisibleOf(db: D1Database, requestId: string): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT * FROM community_requests WHERE id = ?').bind(requestId).first<Record<string, unknown>>();
    return budgetSwitchOf(row) === 1;
  } catch (e) {
    if (isMissingSchema(e)) return false;
    throw e;
  }
}
