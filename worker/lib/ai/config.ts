/**
 * THE OWNER'S AI SETTINGS, READ ONCE PER 30 SECONDS PER ISOLATE (push B plan
 * §6.7 step 1, §10 "Memo").
 *
 * One `db.batch` reads the switch and cap (`ai_settings`), the model rows
 * (`ai_task_models`, rows marked gone left out), the provider circuits
 * (`ai_provider_health`) and today's spend. The answer is memoised for 30 s
 * per isolate and carries `ai_settings.version`, which every admin save bumps:
 * the kill switch and a model change reach every isolate within 30 s, and the
 * isolate that saved them at once (`forgetAiConfig`). A circuit this isolate
 * opens, or a model row it marks gone, is applied to the memo in place.
 *
 * TOLERATES ABSENCE. Before migration 0210 (a manual redeploy of an older
 * database, or Workers Builds re-opened in an emergency) every read fails with
 * "no such table": the answer is `null`, which every caller reads as basic
 * mode. Any other read failure is `null` too: the layer fails closed.
 */
import { AI_TASKS, PROVIDER_KINDS, TASK_PROVIDER, type AiConfig, type AiTask, type ProviderKind, type TaskModel } from './types';
import { utcDay } from './budget';

export const CONFIG_MEMO_MS = 30_000;

export interface AiState {
  config: AiConfig;
  /** Epoch ms until which a provider's circuit is open; absent = closed. */
  openUntil: Partial<Record<ProviderKind, number>>;
  /** Today's spend row as of the read (UTC day), for readiness only; the reservation is the real gate. */
  today: { day: string; spentMicro: number; reservedMicro: number };
}

interface Memo {
  state: AiState;
  at: number;
}

/** Keyed by the D1 binding object, so two databases in one process (tests) never share a memo. */
let memos = new WeakMap<object, Memo>();

/** Drop every memo: an admin save in this isolate, or a test. */
export function forgetAiConfig(db?: D1Database): void {
  if (db) memos.delete(db as object);
  else memos = new WeakMap();
}

interface SettingsRow {
  enabled: number;
  daily_cap_micro_usd: number;
  guests: number;
  guest_share_pct: number;
  understand_ckb: number;
  version: number;
}
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
}
interface HealthRow {
  provider: string;
  open_until: string | null;
}
interface SpendRow {
  spent_micro_usd: number;
  reserved_micro_usd: number;
}

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** A stored row → the runtime's model, or null when its task, rank or provider is not one this code knows. */
export function taskModelOf(r: ModelRow): TaskModel | null {
  if (!(AI_TASKS as readonly string[]).includes(r.task)) return null;
  const task = r.task as AiTask;
  if (r.rank !== 0 && r.rank !== 1) return null;
  if (r.provider !== TASK_PROVIDER[task]) return null;
  if (typeof r.model_id !== 'string' || !r.model_id) return null;
  return {
    task,
    rank: r.rank,
    provider: TASK_PROVIDER[task],
    modelId: r.model_id,
    rates: {
      inPerMTok: int(r.in_micro_per_mtok),
      outPerMTok: int(r.out_micro_per_mtok),
      cacheWritePerMTok: int(r.cache_write_micro_per_mtok),
      cacheReadPerMTok: int(r.cache_read_micro_per_mtok),
      speechPerMinute: int(r.speech_micro_per_minute),
    },
    effortLow: Number(r.effort_low) === 1,
  };
}

async function readState(db: D1Database, nowMs: number): Promise<AiState | null> {
  const day = utcDay(nowMs);
  const [settings, models, health, spend] = await db.batch([
    db.prepare(
      'SELECT enabled, daily_cap_micro_usd, guests, guest_share_pct, understand_ckb, version FROM ai_settings WHERE id = 1'
    ),
    db.prepare(
      `SELECT task, rank, provider, model_id, in_micro_per_mtok, out_micro_per_mtok, cache_write_micro_per_mtok,
              cache_read_micro_per_mtok, speech_micro_per_minute, effort_low
         FROM ai_task_models WHERE gone = 0 ORDER BY task, rank`
    ),
    db.prepare('SELECT provider, open_until FROM ai_provider_health'),
    db.prepare('SELECT spent_micro_usd, reserved_micro_usd FROM ai_spend_day WHERE day = ?').bind(day),
  ]);
  const s = (settings?.results?.[0] ?? null) as SettingsRow | null;
  if (!s) return null;
  const byTask: Record<AiTask, TaskModel[]> = { understand: [], vision: [], speech: [] };
  for (const row of (models?.results ?? []) as ModelRow[]) {
    const m = taskModelOf(row);
    if (m) byTask[m.task].push(m);
  }
  for (const t of AI_TASKS) byTask[t].sort((x, y) => x.rank - y.rank);
  const openUntil: Partial<Record<ProviderKind, number>> = {};
  for (const h of (health?.results ?? []) as HealthRow[]) {
    if (!(PROVIDER_KINDS as readonly string[]).includes(h.provider) || !h.open_until) continue;
    const t = Date.parse(h.open_until);
    if (Number.isFinite(t)) openUntil[h.provider as ProviderKind] = t;
  }
  const sp = (spend?.results?.[0] ?? null) as SpendRow | null;
  return {
    config: {
      version: int(s.version) || 1,
      enabled: Number(s.enabled) === 1,
      capMicro: int(s.daily_cap_micro_usd),
      guests: Number(s.guests) === 1,
      guestSharePct: Math.min(100, int(s.guest_share_pct)),
      understandCkb: Number(s.understand_ckb) === 1,
      models: byTask,
    },
    openUntil,
    today: { day, spentMicro: int(sp?.spent_micro_usd), reservedMicro: int(sp?.reserved_micro_usd) },
  };
}

/**
 * The memoised state, or null (no 0210 tables, no settings row, or a failed
 * read). `nowMs` is injectable for tests.
 */
export async function loadAiState(db: D1Database, nowMs: number = Date.now()): Promise<AiState | null> {
  const key = db as object;
  const memo = memos.get(key);
  if (memo && nowMs - memo.at < CONFIG_MEMO_MS && memo.state.today.day === utcDay(nowMs)) return memo.state;
  try {
    const state = await readState(db, nowMs);
    if (state) memos.set(key, { state, at: nowMs });
    else memos.delete(key);
    return state;
  } catch {
    memos.delete(key);
    return null;
  }
}

/** The config alone (plan §6.7 `loadAiConfig`). */
export async function loadAiConfig(db: D1Database, nowMs: number = Date.now()): Promise<AiConfig | null> {
  return (await loadAiState(db, nowMs))?.config ?? null;
}

/**
 * A circuit this isolate just opened is honoured at once, without waiting for
 * the memo: the next turn in this isolate does not call a provider that just
 * failed three times.
 */
export function noteCircuitOpen(db: D1Database, provider: ProviderKind, untilMs: number): void {
  const memo = memos.get(db as object);
  if (memo) memo.state.openUntil[provider] = untilMs;
}

/** A model row this isolate just marked gone is skipped at once. */
export function noteModelGone(db: D1Database, task: AiTask, rank: 0 | 1): void {
  const memo = memos.get(db as object);
  if (memo) memo.state.config.models[task] = memo.state.config.models[task].filter((m) => m.rank !== rank);
}
