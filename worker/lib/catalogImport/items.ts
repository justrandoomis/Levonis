/**
 * ONE ITEM'S LEASE AND ITS TRANSITIONS (Bambu import spec §A.3 `/lease`,
 * `/event`, `/stage`; §A.7; §A.10; §B.5).
 *
 * THE LEASE. `/lease` takes an item for 15 minutes and every item call renews
 * it. The runner's token is renewed while it is live; any other caller (a new
 * job after a crashed one, whose token is already revoked) takes the item over
 * with a fresh lease token, which makes every statement of the old executor
 * stale: the writer's guard row and the event fence both check the token.
 *
 * THE EVENTS (the transitions the RUNNER performs; trg_cii_transition and
 * trg_cii_stage_monotonic are the authority, this module only refuses earlier
 * and more precisely):
 *
 *   start    DISCOVERED → EXTRACTING, only the next item of the queue
 *   ok       a working stage → its successor, up to WRITING; the stage is
 *            recorded completed and stage_attempts starts again at 0. PUBLISHING,
 *            VERIFYING_LIVE and COMPLETE are reached only through /write,
 *            /publish-finish and /complete — an event cannot self-attest them
 *   retry    a working stage → RETRYING with the code and retry_at; every code
 *            but DEADLINE_EXIT counts toward stage_attempts (§A.7 rule 4: the
 *            eighth failure of a stage is refused RETRIES_EXHAUSTED); `release`
 *            lets the lease lapse now (the deadline park)
 *   blocked  a working stage or RETRYING → BLOCKED with its blocker and the resume
 *            instruction. After WRITTEN, a product this run CREATED is hidden in the
 *            same batch (§A.10, ./unpublish.ts) and its pages purged after it
 *   resume   RETRYING or BLOCKED → the stage after last_completed_stage; a product
 *            hidden on block whose item resumes straight into VERIFYING_LIVE is put
 *            back in the same batch (its /publish-finish already ran)
 *   info     no transition: the event alone
 *
 * Each event is one batch: a fence (the item still in the state and lease the
 * call read), the item, the event (seq = MAX + 1 of the run), the run's state,
 * the fence's delete. The answer carries `{state, last_completed_stage,
 * stage_attempts, seq}`; a code outside the fixed list is recorded as
 * UNCLASSIFIED, never as what was sent.
 */
import { newId, randomToken } from '../crypto';
import { fence, isFenceMiss } from '../operations';
import { blockerCode, eventCode, LEASE_MS, NOW_SQL, OpsRefusal, RESUME_INSTRUCTION, type ImportRun } from './auth';
import { refusalOfBatch } from './writer';
import { republishStatements, unpublishOnBlockStatements } from './unpublish';

export const STAGES = ['EXTRACTING', 'ENRICHING', 'VALIDATING', 'INGESTING_MEDIA', 'WRITING', 'PUBLISHING', 'VERIFYING_LIVE'] as const;
export type Stage = (typeof STAGES)[number];
export const TERMINAL = new Set(['COMPLETE', 'WITHDRAWN_AT_SOURCE']);
/**
 * Eight attempts of one stage across jobs (§A.7 rule 4, §B.5): a stage that has failed seven times (stage_attempts
 * 7) may run once more; its eighth failure is refused RETRIES_EXHAUSTED, so the runner blocks — the runner's own
 * rule (scripts/bambu-import/run.ts withRetries: `stageAttempts + 1 >= MAX_STAGE_ATTEMPTS`).
 */
export const MAX_STAGE_ATTEMPTS = 8;

/** An item of the run between DISCOVERED and a terminal state (BLOCKED and RETRYING included): ux_cii_inflight's own predicate. */
const IN_FLIGHT = "processing_state NOT IN ('DISCOVERED','COMPLETE','WITHDRAWN_AT_SOURCE')";

/** ux_cii_inflight's refusal: another item of the run is in flight. */
const isInflightClash = (e: unknown) => /UNIQUE constraint failed:\s*catalog_import_items\.run_id/i.test(String((e as Error)?.message ?? e));

/** The stage after `last_completed_stage` — the trigger's own CASE (§B.3). */
export function stageAfter(lastCompleted: string): Stage | null {
  if (lastCompleted === '') return 'EXTRACTING';
  const at = STAGES.indexOf(lastCompleted as Stage);
  return at >= 0 && at + 1 < STAGES.length ? STAGES[at + 1] : null;
}

/** The stages an `ok` event may complete: up to INGESTING_MEDIA → WRITING. */
const OK_NEXT: Readonly<Record<string, Stage>> = {
  EXTRACTING: 'ENRICHING',
  ENRICHING: 'VALIDATING',
  VALIDATING: 'INGESTING_MEDIA',
  INGESTING_MEDIA: 'WRITING',
};

export interface ItemRow {
  id: string;
  run_id: string;
  source_product_id: string;
  handle: string;
  queue_position: number;
  processing_state: string;
  last_completed_stage: string;
  attempts: number;
  stage_attempts: number;
  retry_at: string;
  blocker_code: string;
  lease_token: string;
  lease_until: string;
  payload_sha256: string;
  stage_data: string;
  match_kind: string;
  levonis_product_id: string;
  slug: string;
  unpublished_on_block: number;
  lease_live: number;
}

const ITEM_COLUMNS = `id, run_id, source_product_id, handle, queue_position, processing_state, last_completed_stage, attempts, stage_attempts,
  retry_at, blocker_code, lease_token, lease_until, payload_sha256, stage_data, match_kind, levonis_product_id, slug, unpublished_on_block,
  CASE WHEN lease_until > ${NOW_SQL} THEN 1 ELSE 0 END AS lease_live`;

export async function itemBySource(db: D1Database, runId: string, sourceProductId: string): Promise<ItemRow> {
  const row = await db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM catalog_import_items WHERE run_id = ? AND source = 'bambu_us' AND source_product_id = ?`)
    .bind(runId, sourceProductId)
    .first<ItemRow>();
  if (!row) throw new OpsRefusal(404, 'IMPORT_ITEM_NOT_FOUND');
  return row;
}

const leaseUntil = () => new Date(Date.now() + LEASE_MS).toISOString();
const newLeaseToken = () => `lse_${randomToken(18)}`;

/** The counts and digests of stage_data (never a value): what /lease hands back. */
export function stageDataOf(item: Pick<ItemRow, 'stage_data'>): Record<string, unknown> {
  try {
    const v = JSON.parse(item.stage_data || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface LeaseAnswer {
  lease_token: string;
  state: string;
  last_completed_stage: string;
  attempts: number;
  stage_attempts: number;
  retry_at: string;
  stage_data: Record<string, unknown>;
  blocker_code: string;
  levonis_product_id: string;
  slug: string;
  payload_sha256: string;
}

function leaseAnswer(item: ItemRow, token: string): LeaseAnswer {
  return {
    lease_token: token,
    state: item.processing_state,
    last_completed_stage: item.last_completed_stage,
    attempts: Number(item.attempts),
    stage_attempts: Number(item.stage_attempts),
    retry_at: item.retry_at,
    stage_data: stageDataOf(item),
    blocker_code: item.blocker_code,
    levonis_product_id: item.levonis_product_id,
    slug: item.slug,
    payload_sha256: item.payload_sha256,
  };
}

/** POST /items/:sid/lease. A finished item is answered as it is, with no lease. */
export async function leaseItem(db: D1Database, run: ImportRun, sourceProductId: string, presented: string): Promise<LeaseAnswer> {
  const item = await itemBySource(db, run.id, sourceProductId);
  if (TERMINAL.has(item.processing_state)) return leaseAnswer(item, '');
  // §A.3: /lease is fenced by ux_cii_inflight. A queued item is not leased while another is in flight (it could
  // not start), and its attempts do not grow.
  if (item.processing_state === 'DISCOVERED') {
    const other = await db.prepare(`SELECT 1 AS x FROM catalog_import_items WHERE run_id = ? AND ${IN_FLIGHT} LIMIT 1`).bind(run.id).first();
    if (other) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  }
  const until = leaseUntil();
  if (presented && presented === item.lease_token && Number(item.lease_live) === 1) {
    const renewed = await db
      .prepare(`UPDATE catalog_import_items SET lease_until = ?, updated_at = ${NOW_SQL} WHERE id = ? AND lease_token = ?`)
      .bind(until, item.id, presented)
      .run();
    if (Number(renewed.meta?.changes ?? 0) === 1) return leaseAnswer(item, presented);
  }
  const token = newLeaseToken();
  await db
    .prepare(`UPDATE catalog_import_items SET lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ${NOW_SQL} WHERE id = ?`)
    .bind(token, until, item.id)
    .run();
  return leaseAnswer({ ...item, attempts: Number(item.attempts) + 1 }, token);
}

/**
 * Every item call but /lease: the presented token must hold a live lease; the lease is renewed. Answers the
 * item as it now is. IMPORT_LEASE_LOST makes the runner lease again (scripts/bambu-import/opsClient.ts).
 */
export async function holdLease(db: D1Database, run: ImportRun, sourceProductId: string, presented: unknown): Promise<ItemRow> {
  const item = await itemBySource(db, run.id, sourceProductId);
  if (typeof presented !== 'string' || !presented || presented !== item.lease_token || Number(item.lease_live) !== 1) {
    throw new OpsRefusal(409, 'IMPORT_LEASE_LOST', [item.id]);
  }
  const until = leaseUntil();
  const r = await db
    .prepare(`UPDATE catalog_import_items SET lease_until = ? WHERE id = ? AND lease_token = ? AND lease_until > ${NOW_SQL}`)
    .bind(until, item.id, presented)
    .run();
  if (Number(r.meta?.changes ?? 0) !== 1) throw new OpsRefusal(409, 'IMPORT_LEASE_LOST', [item.id]);
  return { ...item, lease_until: until };
}

// ---------------------------------------------------------------- events

export interface EventBody {
  state: string;
  outcome: 'start' | 'ok' | 'retry' | 'blocked' | 'resume' | 'info';
  code: string;
  retry_at: string;
  release: boolean;
  detail: Record<string, unknown>;
}

const OUTCOMES = new Set(['start', 'ok', 'retry', 'blocked', 'resume', 'info']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The event body, validated. Nothing of it is stored but codes, states, a time and counts. */
export function eventBodyOf(raw: Record<string, unknown>): EventBody {
  const state = typeof raw.state === 'string' ? raw.state : '';
  const outcome = typeof raw.outcome === 'string' ? raw.outcome : '';
  if (!OUTCOMES.has(outcome) || !/^[A-Z_]{4,24}$/.test(state)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  const retryAt = typeof raw.retry_at === 'string' && ISO.test(raw.retry_at) ? raw.retry_at : '';
  return {
    state,
    outcome: outcome as EventBody['outcome'],
    code: eventCode(raw.code),
    retry_at: retryAt,
    release: raw.release === true,
    detail: sanitizeDetail(raw.detail),
  };
}

/**
 * An event's detail keeps counts, booleans and digests only (catalog_import_events.detail is "counts and
 * ids", worker/lib/mediaRefs.ts): a key that is not snake_case, a text that is not a 64-hex digest, a nested
 * object — dropped. At most 24 keys.
 */
export function sanitizeDetail(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 24) break;
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) out[k] = v;
  }
  return out;
}

export interface EventAnswer {
  state: string;
  last_completed_stage: string;
  stage_attempts: number;
  seq: number | null;
  /** The product hidden on block (for the route's purge), or put back on resume. */
  unpublished?: boolean;
  republished?: boolean;
}

const eventInsert = (db: D1Database, run: ImportRun, item: ItemRow, stage: string, outcome: string, code: string, detail: Record<string, unknown>, lease: string) =>
  db
    .prepare(
      `INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, code, message, detail, lease_token, github_run_id)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM catalog_import_events WHERE run_id = ?), ?, ?, ?, '', ?, ?, ?)`
    )
    .bind(newId('cie'), run.id, item.id, run.id, stage, outcome, code, JSON.stringify(detail), lease, run.github_run_id);

const runState = (db: D1Database, run: ImportRun, state: 'running' | 'blocked') =>
  db.prepare(`UPDATE catalog_import_runs SET state = ? WHERE id = ? AND state IN ('open','running','blocked')`).bind(state, run.id);

/** POST /items/:sid/event (after holdLease). */
export async function applyEvent(db: D1Database, run: ImportRun, item: ItemRow, body: EventBody): Promise<EventAnswer> {
  const old = item.processing_state;
  const lease = item.lease_token;
  const statements: D1PreparedStatement[] = [];
  const [fenceIn, fenceOut] = fence(db, `EXISTS (SELECT 1 FROM catalog_import_items WHERE id = ? AND processing_state = ? AND lease_token = ?)`, [item.id, old, lease]);
  let next = old;
  let lastCompleted = item.last_completed_stage;
  let stageAttempts = Number(item.stage_attempts);
  let eventStage = old;
  let unpublishAt = -1;
  let republishAt = -1;
  const set = (sql: string, ...args: unknown[]) =>
    db.prepare(`UPDATE catalog_import_items SET ${sql}, updated_at = ${NOW_SQL} WHERE id = ? AND lease_token = ?`).bind(...args, item.id, lease);

  switch (body.outcome) {
    case 'info':
      if (body.state !== old) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
      statements.push(fenceIn, eventInsert(db, run, item, old, 'info', body.code, body.detail, lease), fenceOut);
      break;
    case 'start': {
      if (old !== 'DISCOVERED' || body.state !== 'EXTRACTING') throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
      // Only the next item of the queue starts (§J.4): nothing DISCOVERED before it, and no other item anywhere between
      // DISCOVERED and a terminal state, BLOCKED and RETRYING included (ux_cii_inflight; its own refusal, should a
      // start race this read, is answered the same way below).
      const earlier = await db
        .prepare(
          `SELECT 1 AS x FROM catalog_import_items
            WHERE run_id = ? AND id <> ? AND ((processing_state = 'DISCOVERED' AND queue_position < ?) OR ${IN_FLIGHT}) LIMIT 1`
        )
        .bind(run.id, item.id, item.queue_position)
        .first();
      if (earlier) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
      next = 'EXTRACTING';
      eventStage = 'EXTRACTING';
      statements.push(fenceIn, runState(db, run, 'running'), set("processing_state = 'EXTRACTING', retry_at = ''"));
      statements.push(eventInsert(db, run, item, eventStage, 'start', body.code, body.detail, lease), fenceOut);
      break;
    }
    case 'ok': {
      const to = OK_NEXT[old];
      if (!to || body.state !== to) throw new OpsRefusal(409, to ? 'IMPORT_ILLEGAL_TRANSITION' : 'IMPORT_EVENT_REFUSED', [item.id]);
      if (to === 'INGESTING_MEDIA' && !item.payload_sha256) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
      next = to;
      lastCompleted = old;
      stageAttempts = 0;
      const fp = typeof body.detail.source_fingerprint === 'string' && old === 'EXTRACTING' ? (body.detail.source_fingerprint as string) : null;
      statements.push(
        fenceIn,
        fp === null
          ? set("processing_state = ?, last_completed_stage = ?, stage_attempts = 0, retry_at = '', last_error_code = ''", to, old)
          : set("processing_state = ?, last_completed_stage = ?, stage_attempts = 0, retry_at = '', last_error_code = '', source_fingerprint = ?", to, old, fp),
        eventInsert(db, run, item, old, 'ok', body.code, body.detail, lease),
        fenceOut
      );
      break;
    }
    case 'retry': {
      if (!(STAGES as readonly string[]).includes(old) || body.state !== 'RETRYING') throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
      const counts = body.code !== 'DEADLINE_EXIT';
      if (counts && stageAttempts + 1 >= MAX_STAGE_ATTEMPTS) throw new OpsRefusal(409, 'RETRIES_EXHAUSTED', [item.id]);
      next = 'RETRYING';
      if (counts) stageAttempts += 1;
      statements.push(
        fenceIn,
        set(
          `processing_state = 'RETRYING', stage_attempts = ?, retry_at = ?, last_error_code = ?${body.release ? `, lease_until = ${NOW_SQL}` : ''}`,
          stageAttempts,
          body.retry_at,
          body.code
        ),
        eventInsert(db, run, item, old, 'retry', body.code, body.detail, lease),
        fenceOut
      );
      break;
    }
    case 'blocked': {
      if (!((STAGES as readonly string[]).includes(old) || old === 'RETRYING') || body.state !== 'BLOCKED') throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
      next = 'BLOCKED';
      const blocker = blockerCode(body.code);
      const transition = set("processing_state = 'BLOCKED', blocker_code = ?, resume_instruction = ?, last_error_code = ?, retry_at = ''", blocker, RESUME_INSTRUCTION, blocker);
      const written = ['WRITING', 'PUBLISHING', 'VERIFYING_LIVE'].includes(item.last_completed_stage);
      if (written && item.match_kind === 'created' && item.levonis_product_id) {
        // §A.10: hidden in the same batch, the event fenced by the lease; the run's state after the fenced event.
        const u = unpublishOnBlockStatements(db, {
          runId: run.id,
          itemId: item.id,
          leaseToken: lease,
          productId: item.levonis_product_id,
          extra: [transition, eventInsert(db, run, item, old, 'blocked', blocker, body.detail, lease)],
        });
        statements.push(fenceIn, ...u.statements, runState(db, run, 'blocked'), fenceOut);
        unpublishAt = 1 + u.changedAt;
      } else {
        statements.push(fenceIn, transition, eventInsert(db, run, item, old, 'blocked', blocker, body.detail, lease), runState(db, run, 'blocked'), fenceOut);
      }
      break;
    }
    case 'resume': {
      const to = stageAfter(item.last_completed_stage);
      if ((old !== 'RETRYING' && old !== 'BLOCKED') || !to || body.state !== to) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
      next = to;
      eventStage = to;
      const transition = set("processing_state = ?, blocker_code = '', resume_instruction = '', retry_at = ''", to);
      if (to === 'VERIFYING_LIVE' && Number(item.unpublished_on_block) === 1 && item.levonis_product_id) {
        // Its /publish-finish already ran: the product the import hid comes back before verification (§A.10).
        const r = republishStatements(db, {
          runId: run.id,
          itemId: item.id,
          leaseToken: lease,
          productId: item.levonis_product_id,
          extra: [runState(db, run, 'running'), transition, eventInsert(db, run, item, to, 'resume', body.code, body.detail, lease)],
        });
        statements.push(fenceIn, ...r.statements, fenceOut);
        republishAt = 1 + r.changedAt;
      } else {
        statements.push(fenceIn, runState(db, run, 'running'), transition, eventInsert(db, run, item, to, 'resume', body.code, body.detail, lease), fenceOut);
      }
      break;
    }
  }

  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = (await db.batch(statements)) as Array<{ meta?: { changes?: number } }>;
  } catch (e) {
    if (isFenceMiss(e) || isInflightClash(e)) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
    const mapped = refusalOfBatch(e);
    if (mapped instanceof Error && 'code' in mapped && typeof (mapped as { code: unknown }).code === 'string' && mapped !== e) {
      throw new OpsRefusal(409, (mapped as { code: string }).code, [item.id]);
    }
    throw e;
  }
  const seq = await db
    .prepare('SELECT MAX(seq) AS seq FROM catalog_import_events WHERE run_id = ? AND item_id = ?')
    .bind(run.id, item.id)
    .first<{ seq: number | null }>();
  return {
    state: next,
    last_completed_stage: lastCompleted,
    stage_attempts: stageAttempts,
    seq: seq?.seq ?? null,
    ...(unpublishAt >= 0 ? { unpublished: Number(results[unpublishAt]?.meta?.changes ?? 0) > 0 } : {}),
    ...(republishAt >= 0 ? { republished: Number(results[republishAt]?.meta?.changes ?? 0) > 0 } : {}),
  };
}

/** The states /stage accepts (§A.3; a resumed item re-stages a payload rebuilt from a fresh page, §A.7). */
export const STAGE_STATES = new Set(['VALIDATING', 'INGESTING_MEDIA', 'WRITING']);

/** Records the staged payload's digest and estimate. Never moves the state. */
export async function recordStaged(db: D1Database, item: ItemRow, sha: string, estimate: number): Promise<void> {
  const r = await db
    .prepare(
      `UPDATE catalog_import_items
          SET payload_sha256 = ?,
              stage_data = json_set(CASE WHEN json_valid(stage_data) THEN stage_data ELSE '{}' END, '$.invocation_estimate', ?),
              updated_at = ${NOW_SQL}
        WHERE id = ? AND lease_token = ? AND processing_state IN ('VALIDATING','INGESTING_MEDIA','WRITING')`
    )
    .bind(sha, estimate, item.id, item.lease_token)
    .run();
  if (Number(r.meta?.changes ?? 0) !== 1) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
}

/**
 * `/publish-finish`'s checkpoint: PUBLISHING → VERIFYING_LIVE, the stage recorded completed, under the fence
 * of the state and lease the call read. A finish called again in VERIFYING_LIVE (the cache rule, §I.1.9) moves
 * nothing.
 */
export async function finishPublishing(db: D1Database, run: ImportRun, item: ItemRow): Promise<string> {
  if (item.processing_state === 'VERIFYING_LIVE') return 'VERIFYING_LIVE';
  if (item.processing_state !== 'PUBLISHING') throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
  const [fenceIn, fenceOut] = fence(db, `EXISTS (SELECT 1 FROM catalog_import_items WHERE id = ? AND processing_state = 'PUBLISHING' AND lease_token = ?)`, [item.id, item.lease_token]);
  try {
    await db.batch([
      fenceIn,
      db
        .prepare(
          `UPDATE catalog_import_items SET processing_state = 'VERIFYING_LIVE', last_completed_stage = 'PUBLISHING', stage_attempts = 0, retry_at = '',
                  updated_at = ${NOW_SQL}
            WHERE id = ? AND lease_token = ? AND processing_state = 'PUBLISHING'`
        )
        .bind(item.id, item.lease_token),
      eventInsert(db, run, item, 'PUBLISHING', 'ok', '', {}, item.lease_token),
      fenceOut,
    ]);
  } catch (e) {
    if (isFenceMiss(e)) throw new OpsRefusal(409, 'IMPORT_ILLEGAL_TRANSITION', [item.id]);
    const mapped = refusalOfBatch(e);
    if (mapped !== e && mapped instanceof Error && 'code' in mapped) throw new OpsRefusal(409, String((mapped as { code: unknown }).code), [item.id]);
    throw e;
  }
  return 'VERIFYING_LIVE';
}
