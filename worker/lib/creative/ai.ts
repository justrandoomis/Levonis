/**
 * ONE AI REQUEST, END TO END (spec §27–§29; docs/CREATIVE_STUDIO.md §4).
 *
 * Every AI route runs the same sequence, in this order, so no route can skip
 * a step:
 *
 *   1. READY — the studio is installed, a key is configured (the owner's sealed
 *      key or the Worker secret), and the owner has chosen a model:
 *      otherwise 409 KEY_NOT_CONFIGURED / MODEL_NOT_SELECTED, before anything.
 *   2. JOB + IDEMPOTENCY — the same key with the same request answers the
 *      stored outcome without a second provider call; a different request
 *      under the same key is 409 IDEMPOTENCY_KEY_REUSED.
 *   3. BUDGET — a worst-case reservation on today's spend row; a refusal is
 *      429 BUDGET_EXCEEDED or PARALLEL_LIMIT and the provider is never called.
 *   4. THE CALL — through worker/lib/creative/anthropic.ts.
 *   5. LOCAL VALIDATION — the route's validator (aiContracts) decides what the
 *      app accepts; valid JSON proves nothing (spec §15).
 *   6. THE RECORD — in one batch: the job's outcome, a usage row (counts and
 *      codes only, never text), and the settled reservation.
 *
 * No fake success: a failed call is a failed job, a usage row with its code,
 * and an error answer — never an empty "result".
 */
import type { AiTask, AiUsageDto, ErrorCode } from '../../../packages/creativeDoc/src/api';
import { newId } from '../crypto';
import { HttpError } from '../http';
import type { Env } from '../types';
import { MAX_TOKENS, createMessage, keyState, messagesBody, type Billing, type ContentBlock, type ProviderErrorCode, type ProviderUsage, type Transport } from './anthropic';
import { estimateCostMicro, estimateInputTokens, releaseStatement, reserve, settleStatement, worstCase, type Reservation } from './budget';
import { jsonObject, nowIso, schemaMissing } from './db';
import { failQueued, finishStatement, jobById, markRunning, openJob, requestHash, staleRunning, type JobRow } from './jobs';
import { SYSTEM_PROMPT } from './prompts';
import { readProviderSettings, type ProviderSettings } from './settings';

/** A reservation older than this belongs to a Worker that died mid-call (the longest deadline is 60 s plus one retry). */
const STALE_RUNNING_MS = 5 * 60_000;

type AiEnv = Pick<Env, 'DB' | 'ANTHROPIC_API_KEY' | 'CREATIVE_STUDIO_ENC_KEY'>;

/** The HTTP status each refusal code answers with. */
export function statusOf(code: ErrorCode | ProviderErrorCode | string): number {
  switch (code) {
    case 'KEY_NOT_CONFIGURED':
    case 'MODEL_NOT_SELECTED':
    case 'JOB_CANCELLED':
    case 'JOB_IN_PROGRESS':
    case 'IDEMPOTENCY_KEY_REUSED':
    case 'VISION_REVIEW_DISABLED':
    case 'STALE_VERSION':
      return 409;
    case 'BUDGET_EXCEEDED':
    case 'PARALLEL_LIMIT':
    case 'PROVIDER_RATE_LIMITED':
      return 429;
    case 'PROVIDER_OVERLOADED':
    case 'ENCRYPTION_NOT_CONFIGURED':
    case 'CREATIVE_SCHEMA_MISSING':
      return 503;
    case 'PROVIDER_TIMEOUT':
      return 504;
    default:
      return 502;
  }
}

const MESSAGES: Record<string, string> = {
  KEY_NOT_CONFIGURED: 'No provider key is configured. The studio works by hand; AI needs a key.',
  MODEL_NOT_SELECTED: 'The owner has not chosen a model yet.',
  BUDGET_EXCEEDED: "Today's AI budget is used up.",
  PARALLEL_LIMIT: 'Too many AI requests are running at once; try again in a moment.',
  KEY_REJECTED: 'The provider refused the key.',
  MODEL_GONE: 'The chosen model is no longer available; choose another one.',
  PROVIDER_RATE_LIMITED: 'The provider is rate-limiting requests; try again shortly.',
  PROVIDER_OVERLOADED: 'The provider is overloaded; try again shortly.',
  PROVIDER_TIMEOUT: 'The provider did not answer in time. The request may still be billed; it was not repeated.',
  PROVIDER_ERROR: 'The provider answered with an error.',
  PROVIDER_REFUSED: 'The model declined this request.',
  OUTPUT_TRUNCATED: 'The answer was cut off before it was complete.',
  INVALID_OUTPUT: 'The answer did not pass the studio checks and was not used.',
  JOB_CANCELLED: 'This request was cancelled; its result is never applied.',
  JOB_IN_PROGRESS: 'The same request is still running.',
};

export const aiError = (code: string, details?: Record<string, unknown>) => new HttpError(statusOf(code), MESSAGES[code] ?? code, code, details);

export interface Ready {
  settings: ProviderSettings;
  model: string;
}

/** Step 1. */
export async function ensureReady(env: AiEnv): Promise<Ready> {
  const settings = await readProviderSettings(env.DB);
  if (!settings.migrated) throw schemaMissing();
  const key = await keyState(env);
  if (key.source === 'none') throw aiError('KEY_NOT_CONFIGURED');
  if (!settings.model) throw aiError('MODEL_NOT_SELECTED');
  return { settings, model: settings.model };
}

export interface AiSpec<T> {
  task: AiTask;
  actorId: string;
  idempotencyKey: string;
  /** The request as the client sent it (hashed for idempotency). */
  request: Record<string, unknown>;
  documentId: string | null;
  baseVersion: number | null;
  targetIds: string[];
  content: ContentBlock[];
  schema: Record<string, unknown>;
  imageTokens?: number;
  /** Step 5: the app's own decision. A refusal fails the job with INVALID_OUTPUT and the reason. */
  validate: (raw: unknown) => { ok: true; result: T } | { ok: false; reason: string; detail?: unknown };
  /** Rows the accepted result adds in the same batch (the ideas). */
  persist?: (job: JobRow, result: T) => D1PreparedStatement[];
}

export interface AiOutcome<T> {
  job: JobRow;
  result: T;
  usage: AiUsageDto;
  replay: boolean;
}

async function usageOfJob(db: D1Database, jobId: string, model: string): Promise<AiUsageDto> {
  const u = await db
    .prepare('SELECT model, input_tokens, output_tokens, est_cost_micro_usd FROM creative_usage WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(jobId)
    .first<{ model: string | null; input_tokens: number | null; output_tokens: number | null; est_cost_micro_usd: number | null }>();
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    est_cost_usd: u?.est_cost_micro_usd != null ? u.est_cost_micro_usd / 1_000_000 : null,
    model: u?.model ?? model,
  };
}

function usageRow(
  db: D1Database,
  input: { actorId: string; task: AiTask; model: string; status: 'ok' | 'error' | 'cancelled' | 'refused'; code: string | null; usage: ProviderUsage | null; cost: number | null; rateSource: string | null; jobId: string; documentId: string | null }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO creative_usage (id, created_at, actor_id, task, model, status, error_code, input_tokens, output_tokens, cache_read_tokens, est_cost_micro_usd, rate_source, job_id, document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      newId('cuse'), nowIso(), input.actorId, input.task, input.model, input.status, input.code,
      input.usage ? input.usage.input_tokens + input.usage.cache_creation_input_tokens : null,
      input.usage ? input.usage.output_tokens : null,
      input.usage ? input.usage.cache_read_input_tokens : null,
      input.cost, input.rateSource, input.jobId, input.documentId
    );
}

/** Return every reservation a crashed Worker left behind (their jobs fail with INTERRUPTED). */
async function releaseStale(db: D1Database): Promise<void> {
  const stale = await staleRunning(db, STALE_RUNNING_MS);
  for (const j of stale) {
    const statements: D1PreparedStatement[] = [
      db.prepare(`UPDATE creative_jobs SET status = 'failed', error_code = 'INTERRUPTED', finished_at = ? WHERE id = ? AND status = 'running'`).bind(nowIso(), j.id),
    ];
    if (j.reserved_day) statements.push(releaseStatement(db, { day: j.reserved_day, tokens: j.reserved_tokens, usdMicro: j.reserved_usd_micro }));
    await db.batch(statements);
  }
}

/** The stored outcome of a replayed job: its result, or the error it ended with. */
async function replay<T>(db: D1Database, job: JobRow, model: string): Promise<AiOutcome<T>> {
  if (job.status === 'succeeded' && job.result_json) {
    return { job, result: JSON.parse(job.result_json) as T, usage: await usageOfJob(db, job.id, model), replay: true };
  }
  if (job.status === 'cancelled') throw aiError('JOB_CANCELLED', { job_id: job.id });
  if (job.status === 'queued' || job.status === 'running') throw aiError('JOB_IN_PROGRESS', { job_id: job.id });
  const code = job.error_code ?? 'PROVIDER_ERROR';
  throw new HttpError(statusOf(code), MESSAGES[code] ?? 'This request failed.', code, { job_id: job.id, ...(job.result_json ? { reason: jsonObject(job.result_json).reason } : {}) });
}

/** Steps 2–6. `ready` comes from `ensureReady` (step 1), which the route calls before building the request. */
export async function runAi<T>(env: AiEnv, ready: Ready, spec: AiSpec<T>, transport: Transport = {}): Promise<AiOutcome<T>> {
  const db = env.DB;
  const { settings, model } = ready;
  const hash = await requestHash(spec.actorId, spec.task, spec.request);
  const opened = await openJob(db, { task: spec.task, actorId: spec.actorId, key: spec.idempotencyKey, hash, documentId: spec.documentId, baseVersion: spec.baseVersion, targetIds: spec.targetIds });
  if (opened.kind === 'replay') return replay<T>(db, opened.job, model);
  const job = opened.job;

  await releaseStale(db);
  const req = { task: spec.task, model, system: SYSTEM_PROMPT, content: spec.content, schema: spec.schema, effort: settings.effort, capabilities: settings.capabilities };
  const inputEstimate = estimateInputTokens(JSON.stringify(messagesBody(req)), spec.imageTokens ?? 0);
  const need = worstCase(inputEstimate, MAX_TOKENS[spec.task], settings.rates);
  const reserved = await reserve(db, settings.budget, settings.rates, need);
  if (!reserved.ok) {
    await failQueued(db, job.id, reserved.code);
    throw aiError(reserved.code, { job_id: job.id });
  }
  const r: Reservation = reserved.reservation;
  if (!(await markRunning(db, job.id, r))) {
    await releaseStatement(db, r).run();
    throw aiError('JOB_CANCELLED', { job_id: job.id });
  }

  const rateSource = settings.rates ? `${settings.rates.source} (${settings.rates.as_of})`.slice(0, 200) : null;
  const res = await createMessage(env, req, transport);

  if (!res.ok) {
    const cost = estimateCostMicro(res.usage, settings.rates);
    const settle = settleFor(db, r, res.billing, res.usage, cost);
    await db.batch([
      finishStatement(db, job.id, { status: 'failed', code: res.code }),
      usageRow(db, { actorId: spec.actorId, task: spec.task, model, status: res.code === 'PROVIDER_REFUSED' ? 'refused' : 'error', code: res.code, usage: res.usage, cost, rateSource, jobId: job.id, documentId: spec.documentId }),
      settle,
    ]);
    throw aiError(res.code, { job_id: job.id });
  }

  const cost = estimateCostMicro(res.usage, settings.rates);
  const usedTokens = res.usage.input_tokens + res.usage.output_tokens + res.usage.cache_read_input_tokens + res.usage.cache_creation_input_tokens;
  const settle = settleStatement(db, r, { tokens: usedTokens, usdMicro: cost ?? 0 });
  const verdict = spec.validate(res.json);
  const current = await jobById(db, job.id);
  if (current?.status === 'cancelled') {
    // Cancelled while the provider worked: the call is accounted for, its result is never stored as usable.
    await db.batch([
      usageRow(db, { actorId: spec.actorId, task: spec.task, model, status: 'cancelled', code: 'JOB_CANCELLED', usage: res.usage, cost, rateSource, jobId: job.id, documentId: spec.documentId }),
      settle,
    ]);
    throw aiError('JOB_CANCELLED', { job_id: job.id });
  }
  if (!verdict.ok) {
    await db.batch([
      finishStatement(db, job.id, { status: 'failed', code: 'INVALID_OUTPUT', result: { reason: verdict.reason } }),
      usageRow(db, { actorId: spec.actorId, task: spec.task, model, status: 'error', code: 'INVALID_OUTPUT', usage: res.usage, cost, rateSource, jobId: job.id, documentId: spec.documentId }),
      settle,
    ]);
    throw aiError('INVALID_OUTPUT', { job_id: job.id, reason: verdict.reason, ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}) });
  }
  await db.batch([
    finishStatement(db, job.id, { status: 'succeeded', result: verdict.result }),
    usageRow(db, { actorId: spec.actorId, task: spec.task, model, status: 'ok', code: null, usage: res.usage, cost, rateSource, jobId: job.id, documentId: spec.documentId }),
    settle,
    ...(spec.persist ? spec.persist(job, verdict.result) : []),
  ]);
  const finished = (await jobById(db, job.id))!;
  return {
    job: finished,
    result: verdict.result,
    usage: { input_tokens: res.usage.input_tokens + res.usage.cache_creation_input_tokens, output_tokens: res.usage.output_tokens, est_cost_usd: cost !== null ? cost / 1_000_000 : null, model: res.model || model },
    replay: false,
  };
}

/** How a failed call settles: released (not processed), its reported usage, or the worst case (unknown). */
function settleFor(db: D1Database, r: Reservation, billing: Billing, usage: ProviderUsage | null, cost: number | null): D1PreparedStatement {
  if (billing === 'none') return releaseStatement(db, r);
  if (billing === 'usage' && usage) {
    return settleStatement(db, r, { tokens: usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens, usdMicro: cost ?? 0 });
  }
  return settleStatement(db, r, { tokens: r.tokens, usdMicro: r.usdMicro });
}
