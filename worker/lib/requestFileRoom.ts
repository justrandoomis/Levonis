/**
 * MAY ONE MORE FILE LAND ON THIS REQUEST? — the checks BOTH upload doors ask
 * (the whole-body route in worker/routes/marketplace.ts, the resumable
 * session at open and again at complete in worker/routes/uploadSessions.ts)
 * and the SQL guard in `insertRequestFile` (worker/lib/requestFileHooks.ts)
 * asks once more where the row is written (DECISIONS row 258).
 *
 * A LEAF on purpose: it imports nothing but the HTTP errors and the limits
 * table (a module with no imports of its own), so the route
 * modules that share it cannot be pulled into an import cycle through it.
 */
import { badRequest, conflict, notFound } from './http';
import { REQUEST_FILE_LIMITS } from '../../packages/contracts/src/requestFiles';

/** A request may carry this many attachments — the one table every door reads (packages/contracts/src/requestFiles.ts, R5). */
export const MAX_FILES_PER_REQUEST: number = REQUEST_FILE_LIMITS.maxFiles;
/** The request states in which its attachments may still change — a draft, and a job still taking offers. */
export const REQUEST_FILE_STATES: ReadonlySet<string> = new Set(['draft', 'open', 'receiving_offers']);

/**
 * The request is the caller's and its attachments may still change: 404 for
 * anyone else's (a stranger cannot tell it exists), REQUEST_NOT_EDITABLE once
 * it stopped taking offers — attachments are what merchants priced against,
 * so the window closes with the request.
 */
export async function assertRequestFilesOpen(db: D1Database, requestId: string, userId: string): Promise<void> {
  const r = await db
    .prepare('SELECT id, customer_id, state FROM community_requests WHERE id = ?')
    .bind(requestId)
    .first<{ id: string; customer_id: string; state: string }>();
  if (!r || r.customer_id !== userId) throw notFound('Request not found');
  if (!REQUEST_FILE_STATES.has(r.state)) {
    throw conflict('This request is no longer open, so its attachments cannot change', 'REQUEST_NOT_EDITABLE');
  }
}

/** The room left on a request for one more attachment — the marketplace's cap of six. */
export async function assertRequestFileRoom(db: D1Database, requestId: string): Promise<void> {
  const existing = await db
    .prepare('SELECT COUNT(*) AS n FROM community_request_files WHERE request_id = ?')
    .bind(requestId)
    .first<{ n: number }>();
  if (Number(existing?.n ?? 0) >= MAX_FILES_PER_REQUEST) {
    throw badRequest(`A request may have at most ${MAX_FILES_PER_REQUEST} attachments`, 'REQUEST_FILES_FULL', {
      max_files: MAX_FILES_PER_REQUEST,
    });
  }
}

/**
 * ONE MORE FILE MAY LAND ON THIS REQUEST — asked by BOTH doors (the
 * whole-body route and the resumable session, at open AND at complete) and
 * asked again in SQL by `insertRequestFile` (worker/lib/requestFileHooks.ts)
 * at the moment the row is written (DECISIONS row 258).
 */
export async function assertRequestTakesFiles(db: D1Database, requestId: string, userId: string): Promise<void> {
  await assertRequestFilesOpen(db, requestId, userId);
  await assertRequestFileRoom(db, requestId);
}
