/**
 * «الذكاء الاصطناعي للمساعد» — THE OWNER'S AI TAB (push B plan §11).
 *
 * Mounted at /api/admin/assist-ai (worker/index.ts, before /api/admin), so it
 * sits behind the apex-only host guard and the no-store layer. Its own door:
 * a rate limit, then `requireOwner` (the VERIFIED owner alone; every other
 * admin hears 403 OWNER_ONLY). Every write also asks for a sign-in younger
 * than ten minutes (`requireFreshSession`, 401 REAUTH_REQUIRED).
 *
 *   GET    /                     settings, model rows (rates in USD), today's
 *                                spend, the 7-day ledger, provider health and
 *                                the last 24 h of outcome codes
 *   GET    /models?task=…        the provider's LIVE list, never cached
 *   PUT    /tasks/:task/:rank    save a model row: the live list is fetched
 *                                again and the id must be in it with the
 *                                capability the task needs (a typed speech id
 *                                only with a passing Test's token)
 *   DELETE /tasks/:task/:rank    remove a model row
 *   PUT    /settings             the switch, the cap, guests, Sorani reading
 *   POST   /test/:task           one budgeted, ledgered call; answers codes
 *                                and flags only, never the model's output
 *
 * CREDENTIALS ARE BOOLEANS. No answer carries the provider key, a prefix of
 * it or its length: only whether it is set, whether the speech binding and
 * the images binding are there.
 *
 * EVERY CONFIG WRITE bumps `ai_settings.version`, so every isolate's 30 s
 * memo picks the change up (this one at once), and is audited with the
 * task, rank, model id and the NAMES of the changed fields — never a value.
 *
 * Before migration 0210 the GET answers `{ migrated: false }` and every write
 * 409 AI_SCHEMA_MISSING.
 */
import { Hono, type Context } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { HttpError } from '../lib/http';
import { requireFreshSession, requireOwner } from '../lib/costAccess';
import { limitByMethod, limitRoute } from '../lib/ratelimit';
import { auditStatements } from '../lib/audit';
import { pumpAfter } from '../lib/eventBus';
import { webpConversionAvailable } from '../lib/imageConvert';
import { assistAiMessage, type AssistAiRefusalCode } from '../../packages/contracts/src/assistAiRefusals';
import { anthropicAvailable, anthropicListModels, MODEL_ID_SHAPE } from '../lib/ai/providers/anthropic';
import { workersAiAvailable, workersAiListSpeechModels } from '../lib/ai/providers/workersAi';
import { forgetAiConfig, loadAiState, taskModelOf } from '../lib/ai/config';
import { hasRequiredRates, perCallLimitMicro, utcDay } from '../lib/ai/budget';
import { providerAvailable, taskWorstCaseMicro } from '../lib/ai/readiness';
import { later, runTask, speechSpec, understandSpec, visionSpec, PHOTO_LIMITS, SPEECH_MAX_BYTES, type TaskOutcome } from '../lib/ai/run';
import { conformsTo, HMS_PATTERN, PHOTO_SCHEMA, READING_SCHEMA } from '../lib/ai/schemas';
import { bytesToBase64, stripJpegMetadata } from '../lib/ai/jpeg';
import { aliasOfToken } from '../lib/assist/ai/aliases';
import { AI_TASKS, PROVIDER_KINDS, TASK_PROVIDER, type AiTask, type ListedModel, type TaskModel } from '../lib/ai/types';

export const adminAssistAiRoutes = new Hono<AppContext>();

adminAssistAiRoutes.use('*', limitByMethod(['assist-ai-read', 300], ['assist-ai-write', 60]));
adminAssistAiRoutes.use('*', requireOwner);
adminAssistAiRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});

const refuse = (status: number, code: AssistAiRefusalCode) => new HttpError(status, assistAiMessage(code), code);

/** The fixed sentence of the understanding Test (§11): triage, a clog, an A1. */
export const UNDERSTAND_TEST_SENTENCE = 'النوزل مال طابعتي A1 مسدود';
/** A manual speech id is saved only within this long after a passing Test. */
export const TEST_TOKEN_TTL_MS = 10 * 60_000;
/** The largest multipart Test body (a canvas JPEG or a 10 s recording). */
export const TEST_BODY_MAX_BYTES = 2 * 1024 * 1024;
const LIST_TIMEOUT_MS = 8_000;
const RATE_MAX_MICRO = 1_000_000_000;
const CAP_MAX_MICRO = 50_000_000;

const usd = (micro: number) => Math.round(Number(micro || 0)) / 1_000_000;
const isMissingTable = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

function taskOf(raw: string | undefined): AiTask | null {
  return raw && (AI_TASKS as readonly string[]).includes(raw) ? (raw as AiTask) : null;
}
function rankOf(raw: string | undefined): 0 | 1 | null {
  return raw === '0' ? 0 : raw === '1' ? 1 : null;
}

/**
 * A USD amount → integer micro-USD, read from its decimal text so no float
 * rounding can move a price: at most `dp` decimals, at most `maxMicro`.
 * `undefined`/`null`/'' is absent (null here, 0 to the caller).
 */
export function usdToMicro(v: unknown, dp: number, maxMicro: number): number | null | 'invalid' {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return 'invalid';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v.trim();
  const m = new RegExp(`^(\\d{1,9})(?:\\.(\\d{1,${dp}}))?$`).exec(s);
  if (!m) return 'invalid';
  const micro = Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0').slice(0, 6) || '0');
  return Number.isSafeInteger(micro) && micro <= maxMicro ? micro : 'invalid';
}

/** Is the 0210 schema there? (Writes refuse before anything else when it is not.) */
async function requireSchema(db: D1Database): Promise<{ version: number }> {
  try {
    const row = await db.prepare('SELECT version FROM ai_settings WHERE id = 1').first<{ version: number }>();
    if (row) return { version: Number(row.version) };
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }
  throw refuse(409, 'AI_SCHEMA_MISSING');
}

const bumpVersion = (db: D1Database, actor: string | null, nowIso: string) =>
  db.prepare('UPDATE ai_settings SET version = version + 1, updated_by = ?1, updated_at = ?2 WHERE id = 1').bind(actor, nowIso);

/** A config write, its version bump and its audit row, in one batch. */
async function writeAudited(
  c: Context<AppContext>,
  statements: D1PreparedStatement[],
  action: string,
  target: string,
  detail: Record<string, unknown>
): Promise<void> {
  const db = c.env.DB;
  const actor = c.get('user')?.id ?? null;
  const audit = await auditStatements(db, actor, action, target, detail);
  await db.batch([...statements, bumpVersion(db, actor, new Date().toISOString()), ...audit.statements]);
  pumpAfter(db, [audit.eventId], later(c));
  forgetAiConfig(db);
}

// ------------------------------------------------------------------ the speech Test token

let tokenKey: Promise<CryptoKey> | null = null;
/** A random HMAC key held in this isolate's memory only: a token is good here, for ten minutes. */
const tokenKeyOf = () =>
  (tokenKey ??= crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));

async function tokenSig(modelId: string, exp: number): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await tokenKeyOf(), new TextEncoder().encode(`speech|${modelId}|${exp}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function mintTestToken(modelId: string, nowMs: number): Promise<string> {
  const exp = nowMs + TEST_TOKEN_TTL_MS;
  return `${exp}.${await tokenSig(modelId, exp)}`;
}

export async function testTokenValid(token: unknown, modelId: string, nowMs: number): Promise<boolean> {
  if (typeof token !== 'string') return false;
  const m = /^(\d{13})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > nowMs) || exp - nowMs > TEST_TOKEN_TTL_MS) return false;
  const want = await tokenSig(modelId, exp);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0;
}

// ------------------------------------------------------------------ GET /

interface ModelRow {
  task: string;
  rank: number;
  provider: string;
  model_id: string;
  in_micro_per_mtok: number;
  out_micro_per_mtok: number;
  cache_write_micro_per_mtok: number;
  cache_read_micro_per_mtok: number;
  speech_micro_per_minute: number;
  effort_low: number;
  gone: number;
  updated_at: string;
}

adminAssistAiRoutes.get('/', async (c) => {
  const env = c.env;
  const nowMs = Date.now();
  const credentials = {
    anthropic_key: anthropicAvailable(env),
    ai_binding: workersAiAvailable(env),
    images_binding: webpConversionAvailable(env),
  };
  const day = utcDay(nowMs);
  const weekFrom = utcDay(nowMs - 6 * 86_400_000);
  const since24h = new Date(nowMs - 86_400_000).toISOString();
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        'SELECT enabled, daily_cap_micro_usd, guests, guest_share_pct, understand_ckb, version, updated_at FROM ai_settings WHERE id = 1'
      ),
      env.DB.prepare(
        `SELECT task, rank, provider, model_id, in_micro_per_mtok, out_micro_per_mtok, cache_write_micro_per_mtok,
                cache_read_micro_per_mtok, speech_micro_per_minute, effort_low, gone, updated_at
           FROM ai_task_models ORDER BY task, rank`
      ),
      env.DB.prepare('SELECT spent_micro_usd, reserved_micro_usd, guest_micro_usd, calls FROM ai_spend_day WHERE day = ?').bind(day),
      env.DB.prepare(
        `SELECT day, task, COUNT(*) AS calls, SUM(CASE WHEN outcome = 'OK' THEN 1 ELSE 0 END) AS ok, SUM(cost_micro_usd) AS cost
           FROM ai_usage WHERE day >= ? GROUP BY day, task ORDER BY day DESC, task`
      ).bind(weekFrom),
      env.DB.prepare('SELECT provider, last_ok_at, last_fail_at, last_fail_code, consecutive_failures, open_until FROM ai_provider_health'),
      env.DB.prepare('SELECT task, outcome, COUNT(*) AS n FROM ai_usage WHERE created_at >= ? GROUP BY task, outcome').bind(since24h),
    ]);
  } catch (e) {
    if (isMissingTable(e)) return c.json({ success: true, migrated: false, health: { ...credentials, providers: {} } });
    throw e;
  }
  const s = results[0]?.results?.[0] as Record<string, number | string> | undefined;
  if (!s) return c.json({ success: true, migrated: false, health: { ...credentials, providers: {} } });
  const capMicro = Number(s.daily_cap_micro_usd ?? 0);
  const tasks = ((results[1]?.results ?? []) as unknown as ModelRow[]).map((r) => {
    const m: TaskModel | null = taskModelOf(r);
    const worst = m ? taskWorstCaseMicro(m) : 0;
    return {
      task: r.task,
      rank: Number(r.rank),
      provider: r.provider,
      model_id: r.model_id,
      rates: {
        in: usd(r.in_micro_per_mtok),
        out: usd(r.out_micro_per_mtok),
        cache_write: usd(r.cache_write_micro_per_mtok),
        cache_read: usd(r.cache_read_micro_per_mtok),
        per_minute: usd(r.speech_micro_per_minute),
      },
      effort_low: Number(r.effort_low) === 1,
      gone: Number(r.gone) === 1,
      ready: !!m && Number(r.gone) !== 1 && providerAvailable(env, m.provider) && hasRequiredRates(m) && worst <= perCallLimitMicro(capMicro),
      worst_case_usd: usd(worst),
      worst_case_warn: !!m && worst > perCallLimitMicro(capMicro),
      updated_at: r.updated_at,
    };
  });
  const sp = results[2]?.results?.[0] as Record<string, number> | undefined;
  const providers: Record<string, unknown> = {};
  for (const h of (results[4]?.results ?? []) as Record<string, string | number | null>[]) {
    if (!(PROVIDER_KINDS as readonly string[]).includes(String(h.provider))) continue;
    const open = typeof h.open_until === 'string' && Date.parse(h.open_until) > nowMs ? h.open_until : null;
    providers[String(h.provider)] = {
      last_ok_at: h.last_ok_at ?? null,
      last_fail_at: h.last_fail_at ?? null,
      last_fail_code: h.last_fail_code ?? null,
      consecutive_failures: Number(h.consecutive_failures ?? 0),
      circuit_open_until: open,
    };
  }
  const outcomes: Record<string, Record<string, number>> = {};
  for (const o of (results[5]?.results ?? []) as Record<string, string | number>[]) {
    const t = String(o.task);
    (outcomes[t] ??= {})[String(o.outcome)] = Number(o.n ?? 0);
  }
  return c.json({
    success: true,
    migrated: true,
    settings: {
      enabled: Number(s.enabled) === 1,
      daily_cap_usd: usd(capMicro),
      guests: Number(s.guests) === 1,
      guest_share_pct: Number(s.guest_share_pct),
      understand_ckb: Number(s.understand_ckb) === 1,
      version: Number(s.version),
      updated_at: s.updated_at,
    },
    tasks,
    today: {
      day,
      spent: usd(sp?.spent_micro_usd ?? 0),
      reserved: usd(sp?.reserved_micro_usd ?? 0),
      guest: usd(sp?.guest_micro_usd ?? 0),
      cap: usd(capMicro),
      calls: Number(sp?.calls ?? 0),
    },
    week: ((results[3]?.results ?? []) as Record<string, string | number>[]).map((w) => ({
      day: w.day,
      task: w.task,
      calls: Number(w.calls ?? 0),
      ok: Number(w.ok ?? 0),
      cost: usd(Number(w.cost ?? 0)),
    })),
    health: { ...credentials, providers },
    outcomes_24h: outcomes,
  });
});

// ------------------------------------------------------------------ GET /models

async function liveList(env: Env, task: AiTask): Promise<ListedModel[] | null> {
  if (task === 'speech') return workersAiListSpeechModels(env);
  return anthropicListModels(env, task, AbortSignal.timeout(LIST_TIMEOUT_MS));
}

adminAssistAiRoutes.get('/models', async (c) => {
  const task = taskOf(c.req.query('task'));
  if (!task) throw refuse(400, 'AI_TASK_INVALID');
  return c.json({ success: true, task, models: await liveList(c.env, task) });
});

// ------------------------------------------------------------------ PUT /tasks/:task/:rank

const RATE_FIELDS = [
  ['in', 'in_micro_per_mtok'],
  ['out', 'out_micro_per_mtok'],
  ['cache_write', 'cache_write_micro_per_mtok'],
  ['cache_read', 'cache_read_micro_per_mtok'],
  ['per_minute', 'speech_micro_per_minute'],
] as const;

adminAssistAiRoutes.put('/tasks/:task/:rank', async (c) => {
  requireFreshSession(c);
  const task = taskOf(c.req.param('task'));
  const rank = rankOf(c.req.param('rank'));
  if (!task || rank === null) throw refuse(400, 'AI_TASK_INVALID');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse(400, 'AI_MODEL_ID_INVALID');
  const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
  if (!MODEL_ID_SHAPE.test(modelId)) throw refuse(400, 'AI_MODEL_ID_INVALID');

  const rawRates = body.rates && typeof body.rates === 'object' && !Array.isArray(body.rates) ? (body.rates as Record<string, unknown>) : {};
  const micro: Record<(typeof RATE_FIELDS)[number][0], number> = { in: 0, out: 0, cache_write: 0, cache_read: 0, per_minute: 0 };
  for (const [k] of RATE_FIELDS) {
    const v = usdToMicro(rawRates[k], 6, RATE_MAX_MICRO);
    if (v === 'invalid') throw refuse(400, 'AI_RATE_INVALID');
    micro[k] = v ?? 0;
  }
  const speech = task === 'speech';
  if (speech ? micro.per_minute <= 0 : micro.in <= 0 || micro.out <= 0) throw refuse(400, 'AI_RATES_REQUIRED');
  // A rate the task never uses is not stored: a speech row has no token prices, a text row no per-minute one.
  if (speech) micro.in = micro.out = micro.cache_write = micro.cache_read = 0;
  else micro.per_minute = 0;

  const db = c.env.DB;
  await requireSchema(db);

  // EVERY SAVE RE-FETCHES THE LIVE LIST (§0, §11): never a cached one.
  const list = await liveList(c.env, task);
  let effortLow = false;
  if (list === null) {
    if (!speech) throw refuse(409, 'AI_MODEL_LIST_UNAVAILABLE');
    if (!(await testTokenValid(body.test_token, modelId, Date.now()))) throw refuse(409, 'AI_TEST_TOKEN_REQUIRED');
  } else {
    const found = list.find((m) => m.id === modelId);
    if (!found) throw refuse(409, 'AI_MODEL_NOT_LISTED');
    effortLow = found.effortLow;
  }

  const prev = await db
    .prepare(
      `SELECT model_id, in_micro_per_mtok, out_micro_per_mtok, cache_write_micro_per_mtok, cache_read_micro_per_mtok,
              speech_micro_per_minute, effort_low, gone
         FROM ai_task_models WHERE task = ? AND rank = ?`
    )
    .bind(task, rank)
    .first<Record<string, unknown>>();
  // A new row is compared with the table's defaults (no model, zero rates, no low effort).
  const fields: string[] = [];
  if (!prev || prev.model_id !== modelId) fields.push('model_id');
  for (const [k, col] of RATE_FIELDS) if (Number(prev?.[col] ?? 0) !== micro[k]) fields.push(`rates.${k}`);
  if (Number(prev?.effort_low ?? 0) !== (effortLow ? 1 : 0)) fields.push('effort_low');
  if (prev && Number(prev.gone) === 1) fields.push('gone');

  const actor = c.get('user')?.id ?? null;
  const nowIso = new Date().toISOString();
  await writeAudited(
    c,
    [
      db
        .prepare(
          `INSERT INTO ai_task_models (task, rank, provider, model_id, in_micro_per_mtok, out_micro_per_mtok, cache_write_micro_per_mtok,
                                       cache_read_micro_per_mtok, speech_micro_per_minute, effort_low, gone, updated_by, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12)
           ON CONFLICT(task, rank) DO UPDATE SET
             provider = excluded.provider, model_id = excluded.model_id,
             in_micro_per_mtok = excluded.in_micro_per_mtok, out_micro_per_mtok = excluded.out_micro_per_mtok,
             cache_write_micro_per_mtok = excluded.cache_write_micro_per_mtok, cache_read_micro_per_mtok = excluded.cache_read_micro_per_mtok,
             speech_micro_per_minute = excluded.speech_micro_per_minute, effort_low = excluded.effort_low,
             gone = 0, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
        )
        .bind(task, rank, TASK_PROVIDER[task], modelId, micro.in, micro.out, micro.cache_write, micro.cache_read, micro.per_minute, effortLow ? 1 : 0, actor, nowIso),
    ],
    'assist_ai.model.save',
    `assist_ai:${task}:${rank}`,
    { task, rank, model_id: modelId, fields }
  );

  const saved: TaskModel = {
    task,
    rank,
    provider: TASK_PROVIDER[task],
    modelId,
    rates: { inPerMTok: micro.in, outPerMTok: micro.out, cacheWritePerMTok: micro.cache_write, cacheReadPerMTok: micro.cache_read, speechPerMinute: micro.per_minute },
    effortLow,
  };
  const state = await loadAiState(db);
  const capMicro = state?.config.capMicro ?? 0;
  const worst = taskWorstCaseMicro(saved);
  return c.json({ success: true, task, rank, effort_low: effortLow, worst_case_usd: usd(worst), worst_case_warn: worst > perCallLimitMicro(capMicro) });
});

// ------------------------------------------------------------------ DELETE /tasks/:task/:rank

adminAssistAiRoutes.delete('/tasks/:task/:rank', async (c) => {
  requireFreshSession(c);
  const task = taskOf(c.req.param('task'));
  const rank = rankOf(c.req.param('rank'));
  if (!task || rank === null) throw refuse(400, 'AI_TASK_INVALID');
  const db = c.env.DB;
  await requireSchema(db);
  const prev = await db.prepare('SELECT model_id FROM ai_task_models WHERE task = ? AND rank = ?').bind(task, rank).first<{ model_id: string }>();
  await writeAudited(
    c,
    [db.prepare('DELETE FROM ai_task_models WHERE task = ? AND rank = ?').bind(task, rank)],
    'assist_ai.model.remove',
    `assist_ai:${task}:${rank}`,
    { task, rank, model_id: prev?.model_id ?? null, fields: prev ? ['model_id'] : [] }
  );
  return c.json({ success: true, removed: !!prev });
});

// ------------------------------------------------------------------ PUT /settings

adminAssistAiRoutes.put('/settings', async (c) => {
  requireFreshSession(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse(400, 'AI_SETTINGS_INVALID');
  const next: Record<string, number> = {};
  const flag = (k: string, col: string) => {
    if (body[k] === undefined) return;
    if (typeof body[k] !== 'boolean') throw refuse(400, 'AI_SETTINGS_INVALID');
    next[col] = body[k] ? 1 : 0;
  };
  flag('enabled', 'enabled');
  flag('guests', 'guests');
  flag('understand_ckb', 'understand_ckb');
  if (body.daily_cap_usd !== undefined) {
    const cap = usdToMicro(body.daily_cap_usd, 2, CAP_MAX_MICRO);
    if (cap === 'invalid' || cap === null) throw refuse(400, 'AI_SETTINGS_INVALID');
    next.daily_cap_micro_usd = cap;
  }
  if (body.guest_share_pct !== undefined) {
    const p = body.guest_share_pct;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 100) throw refuse(400, 'AI_SETTINGS_INVALID');
    next.guest_share_pct = p;
  }
  const cols = Object.keys(next);
  if (cols.length === 0) throw refuse(400, 'AI_SETTINGS_INVALID');
  const db = c.env.DB;
  await requireSchema(db);
  const prev = await db
    .prepare('SELECT enabled, daily_cap_micro_usd, guests, guest_share_pct, understand_ckb FROM ai_settings WHERE id = 1')
    .first<Record<string, number>>();
  const fields = cols.filter((col) => Number(prev?.[col]) !== next[col]);
  // Column names come from the fixed list above, never from the body.
  const set = cols.map((col, i) => `${col} = ?${i + 1}`).join(', ');
  await writeAudited(
    c,
    [db.prepare(`UPDATE ai_settings SET ${set} WHERE id = 1`).bind(...cols.map((col) => next[col]))],
    'assist_ai.settings.save',
    'assist_ai:settings',
    { fields }
  );
  return c.json({ success: true, fields });
});

// ------------------------------------------------------------------ POST /test/:task

/** A multipart Test body, size-checked before it is parsed. */
async function testForm(c: Context<AppContext>): Promise<FormData> {
  const declared = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(declared) && declared > TEST_BODY_MAX_BYTES) throw refuse(413, 'AI_TEST_TOO_LARGE');
  if (!/^multipart\/form-data/i.test(c.req.header('content-type') ?? '')) throw refuse(400, 'AI_TEST_INPUT_INVALID');
  try {
    return await c.req.raw.formData();
  } catch {
    throw refuse(400, 'AI_TEST_INPUT_INVALID');
  }
}

async function fileBytes(v: File | string | null, maxBytes: number): Promise<Uint8Array> {
  if (!v || typeof v === 'string') throw refuse(400, 'AI_TEST_INPUT_INVALID');
  if (v.size <= 0) throw refuse(400, 'AI_TEST_INPUT_INVALID');
  if (v.size > maxBytes) throw refuse(413, 'AI_TEST_TOO_LARGE');
  return new Uint8Array(await v.arrayBuffer());
}

/** The saved rows of one rank only, when the owner tests a single row; undefined = the normal chain. */
function rankRows(models: TaskModel[], raw: unknown): TaskModel[] | undefined {
  const r = raw === 0 || raw === '0' ? 0 : raw === 1 || raw === '1' ? 1 : null;
  return r === null ? undefined : models.filter((m) => m.rank === r);
}

adminAssistAiRoutes.post('/test/:task', limitRoute('assist-ai-test', 6, 900), async (c) => {
  requireFreshSession(c);
  const task = taskOf(c.req.param('task'));
  if (!task) throw refuse(400, 'AI_TASK_INVALID');
  const env = c.env;
  await requireSchema(env.DB);
  const state = await loadAiState(env.DB);
  if (!state) throw refuse(409, 'AI_SCHEMA_MISSING');
  const deps = { waitUntil: later(c) };
  const saved = state.config.models[task];

  let out: TaskOutcome;
  let valid = false;
  let expected = false;
  let testToken: string | undefined;

  if (task === 'understand') {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null;
    const spec = understandSpec(env, { text: UNDERSTAND_TEST_SENTENCE, locale: 'ar' }, { guest: false }, deps);
    out = await runTask(env, spec, deps, { adminTest: true, models: rankRows(saved, body?.rank) });
    if (out.ok) {
      valid = conformsTo(READING_SCHEMA, out.value);
      const v = out.value as Record<string, unknown>;
      expected = valid && v.action === 'triage' && v.symptom === 'clog' && v.printer === aliasOfToken('A1');
    }
  } else if (task === 'vision') {
    const form = await testForm(c);
    const code = String(form.get('code') ?? '').trim().toUpperCase();
    if (!new RegExp(HMS_PATTERN).test(code)) throw refuse(400, 'AI_TEST_INPUT_INVALID');
    const jpeg = stripJpegMetadata(await fileBytes(form.get('image'), PHOTO_LIMITS.maxBytes));
    const spec = visionSpec(env, [jpeg], 'photo', deps);
    if (!spec) throw refuse(400, 'AI_TEST_INPUT_INVALID');
    out = await runTask(env, spec, deps, { adminTest: true, models: rankRows(saved, form.get('rank')) });
    if (out.ok) {
      valid = conformsTo(PHOTO_SCHEMA, out.value);
      const codes = valid ? ((out.value as { hms_codes: string[] }).hms_codes ?? []) : [];
      expected = codes.some((x) => x.toUpperCase() === code);
    }
  } else {
    const form = await testForm(c);
    const audio = await fileBytes(form.get('audio'), SPEECH_MAX_BYTES);
    const manualId = String(form.get('model_id') ?? '').trim();
    let models = rankRows(saved, form.get('rank'));
    if (manualId) {
      // A typed id the live list could not offer: tested on its own, at the rate the owner typed.
      if (!MODEL_ID_SHAPE.test(manualId)) throw refuse(400, 'AI_MODEL_ID_INVALID');
      const perMinute = usdToMicro(form.get('per_minute'), 6, RATE_MAX_MICRO);
      if (perMinute === 'invalid') throw refuse(400, 'AI_RATE_INVALID');
      if (!perMinute) throw refuse(400, 'AI_RATES_REQUIRED');
      models = [
        {
          task: 'speech',
          rank: 0,
          provider: 'workers_ai',
          modelId: manualId,
          rates: { inPerMTok: 0, outPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0, speechPerMinute: perMinute },
          effortLow: false,
        },
      ];
    }
    const spec = speechSpec(env, bytesToBase64(audio), audio.byteLength);
    if (!spec) throw refuse(400, 'AI_TEST_INPUT_INVALID');
    out = await runTask(env, spec, deps, { adminTest: true, models });
    if (out.ok) {
      const v = out.value as { text?: unknown; transcription_info?: { language?: unknown } };
      valid = typeof v.text === 'string' && v.text.trim().length > 0;
      const lang = typeof v.transcription_info?.language === 'string' ? v.transcription_info.language : '';
      expected = valid && (lang === 'ar' || lang === 'en');
      if (manualId && valid && expected) testToken = await mintTestToken(manualId, Date.now());
    }
  }

  // Codes and flags only: the model's output never leaves this handler.
  return c.json({
    success: true,
    ok: out.ok,
    code: out.code,
    ms: out.ms,
    cost_micro_usd: out.costMicro,
    valid,
    expected,
    ...(testToken ? { test_token: testToken } : {}),
  });
});

/** For tests: forget the isolate's token key (a new isolate). */
export function resetTestTokenKey(): void {
  tokenKey = null;
}
