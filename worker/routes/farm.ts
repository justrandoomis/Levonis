/**
 * LEVO Printer Farm — the player API (docs/PRINTER_FARM.md §4), mounted at
 * /api/farm.
 *
 * THE SERVER IS THE GAME. Every state change that affects coins, inventory,
 * printers, jobs or reputation happens here, over D1, in ONE batch, on the
 * server clock; the client renders state and sends intents. Nothing in a
 * request body is ever a timestamp, a balance or an outcome — the only client
 * facts a mutation reads are ids, quantities, a quality and an idempotency key.
 *
 * Every request first runs `resolve()` to now (prints that finished, services
 * that completed, deferred payouts, offers that lapsed, deadlines that passed,
 * fresh offers) and writes that as one batch; then the intent runs as a
 * second batch. EVERY batch opens with the revision fence (migration 0054):
 * `UPDATE farm_profiles SET revision = CASE WHEN revision = ?expected THEN
 * revision + 1 ELSE -1 END`, and `ck_farm_profiles_revision` aborts the whole
 * batch when the row moved under the request — a request that read stale rows
 * commits nothing, re-reads, and either replays (farm_requests) or re-plans
 * once. Business ledger rows carry ids that name the EVENT (`fl_sale_<printer>`,
 * `fl_maint_<printer>_<revision>`, `fl_payout_<job>`), so a double that slips
 * past everything else collides on the primary key. Money and inventory are
 * additionally held by the database itself: the overdraft trigger, the spool
 * CHECK, one-printing-per-printer, one printer per slot, and the per-job
 * quantity trigger (migration 0053).
 *
 * Randomness is the server's: a print's outcome seed is 32 random bytes
 * written on the row, offers are seeded from a per-player secret the client
 * never receives. Nothing a request carries can steer a roll.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, SessionUser } from '../lib/types';
import { HttpError, badRequest, conflict, notFound, requireAuth, str, int, oneOf } from '../lib/http';
import { sha256Hex } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { getSetting } from '../lib/settings';
import {
  QUALITIES, normalizeFarmConfig, publicFarmConfig, type FarmConfig, type Quality,
} from '../lib/farm/config';
import {
  gramsFor, isQuality, locationSpec, lowestFreeSlot, materialSpec, partFits, printerModel, productSpec, resaleValue,
  supportsMaterial,
} from '../lib/farm/catalog';
import { failureProbabilityFor } from '../lib/farm/failure';
import { generateOffers, starterFirstJob, type JobInsert } from '../lib/farm/jobs';
import {
  BALANCE_SQL, clientKeyProblem, clientLedgerKey, eventLedgerId, isInsufficientCoins, ledgerInsertStatement, requestLedgerId,
  systemLedgerKey,
} from '../lib/farm/ledger';
import { featureLockLevel, maxActiveJobs, starterKit, unlockLevels } from '../lib/farm/progression';
import { randomSeedHex, seedFrom } from '../lib/farm/rng';
import {
  dailyCapAllows, deliveryPlan, parseColors, resolve, startStatements,
  type DailyIncrement, type EventInsert, type SimResult, type SimUpdate,
} from '../lib/farm/sim';
import {
  awaySummary, currentAssignmentOf, defaultNickname, eventPublic, jobPublic, printerPublic, profilePublic, queueOf, spoolPublic,
  stateUnlocks,
} from '../lib/farm/state';
import { baghdadDayOf, endsAtFor, msOf, printSeconds, serviceUntil } from '../lib/farm/time';
import { ownedCapacity } from '../lib/farm/catalog';
import {
  ACTIVE_JOB_STATES, LIVE_JOB_STATES, PARKED_SLOT_BASE, isPayoutDeferred, parseStats,
  type FarmAssignmentRow, type FarmDailyRow, type FarmEventRow, type FarmJobRow, type FarmPrinterRow, type FarmProfileRow,
  type FarmSpoolRow, type FarmState, type SqlStatement,
} from '../lib/farm/types';

export const farmRoutes = new Hono<AppContext>();

// ------------------------------------------------------------------ helpers

export async function loadFarmConfig(db: D1Database): Promise<FarmConfig> {
  return normalizeFarmConfig(await getSetting(db, 'printerFarmConfig'));
}

const bind = (db: D1Database, s: SqlStatement) => db.prepare(s.sql).bind(...s.params);

const COL_RE = /^[a-z_]+$/;
function assertCol(k: string) {
  if (!COL_RE.test(k)) throw new Error(`bad column ${k}`);
}

/** One SimUpdate → one UPDATE, scoped to the user and guarded as the engine asked. */
function updateStatement(u: SimUpdate, userId: string): SqlStatement {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(u.set)) { assertCol(k); sets.push(`${k} = ?`); params.push(v); }
  for (const [k, v] of Object.entries(u.inc ?? {})) { assertCol(k); sets.push(`${k} = ${k} + ?`); params.push(v); }
  if (!sets.length) throw new Error('empty update');
  let where: string;
  if (u.table === 'farm_profiles') {
    where = 'user_id = ?';
    params.push(u.id);
  } else {
    where = 'id = ? AND user_id = ?';
    params.push(u.id, userId);
  }
  if (u.guardPrintingAssignment) {
    where += " AND EXISTS (SELECT 1 FROM farm_assignments g WHERE g.id = ? AND g.state = 'printing')";
    params.push(u.guardPrintingAssignment);
  }
  if (u.guardQueuedAssignment) {
    where += " AND EXISTS (SELECT 1 FROM farm_assignments g WHERE g.id = ? AND g.state = 'queued')";
    params.push(u.guardQueuedAssignment);
  }
  if (u.guardStateIn && u.guardStateIn.length) {
    where += ` AND state IN (${u.guardStateIn.map(() => '?').join(',')})`;
    params.push(...u.guardStateIn);
  }
  return { sql: `UPDATE ${u.table} SET ${sets.join(', ')} WHERE ${where}`, params };
}

/** Guards must run BEFORE the assignment they watch flips, so assignments go last. */
const TABLE_ORDER: Record<SimUpdate['table'], number> = {
  farm_profiles: 0, farm_printers: 1, farm_spools: 2, farm_jobs: 3, farm_assignments: 4,
};
function orderedUpdates(updates: SimUpdate[]): SimUpdate[] {
  return [...updates].sort((a, b) => TABLE_ORDER[a.table] - TABLE_ORDER[b.table]);
}

function eventStatement(e: EventInsert): SqlStatement {
  return {
    sql: 'INSERT OR IGNORE INTO farm_events (id, user_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    params: [e.id, e.user_id, e.kind, JSON.stringify(e.payload).slice(0, 4000), e.created_at],
  };
}

function offerStatement(j: JobInsert): SqlStatement {
  return {
    sql: `INSERT OR IGNORE INTO farm_jobs (id, user_id, state, customer_tier, customer_name, product_key, qty, material, colors_json,
            grams, print_seconds, quality, reward_coins, reputation_gain_bp, late_penalty_bp, cancel_penalty_coins, cancel_penalty_bp,
            offered_at, offer_expires_at, deadline_at, seed, created_at, updated_at)
          VALUES (?, ?, 'offered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      j.id, j.user_id, j.customer_tier, j.customer_name, j.product_key, j.qty, j.material, j.colors_json,
      j.grams, j.print_seconds, j.quality, j.reward_coins, j.reputation_gain_bp, j.late_penalty_bp, j.cancel_penalty_coins,
      j.cancel_penalty_bp, j.offered_at, j.offer_expires_at, j.deadline_at, j.seed, j.offered_at, j.offered_at,
    ],
  };
}

/**
 * The REVISION FENCE that opens every write batch (migration 0054). The batch
 * expects the revision this request loaded and bumps it; if the row moved
 * under the request the CASE writes -1 and `ck_farm_profiles_revision` aborts
 * the batch — nothing else in it lands. Unlike a token the request itself
 * rewrites, the counter also fences a mutation against its OWN resolver batch:
 * whoever commits second always sees a different number.
 */
export function fenceStatement(profile: Pick<FarmProfileRow, 'user_id' | 'revision'>, nowIso: string, cfg: FarmConfig): SqlStatement {
  return {
    sql: `UPDATE farm_profiles
             SET revision = CASE WHEN revision = ? THEN revision + 1 ELSE -1 END,
                 last_resolved_at = ?, config_version = ?, updated_at = ?
           WHERE user_id = ?`,
    params: [profile.revision, nowIso, cfg.version, nowIso, profile.user_id],
  };
}
const isFenceConflict = (msg: string) => msg.includes('ck_farm_profiles_revision') || msg.includes('ck_farm_profiles_level');

function dailyStatement(userId: string, d: DailyIncrement): SqlStatement {
  return {
    sql: `INSERT INTO farm_daily (user_id, day, coins_earned, jobs_delivered) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, day) DO UPDATE SET coins_earned = coins_earned + ?, jobs_delivered = jobs_delivered + ?`,
    params: [userId, d.day, d.coins, d.jobs, d.coins, d.jobs],
  };
}

function simStatements(sim: SimResult, userId: string): SqlStatement[] {
  return [
    ...orderedUpdates(sim.updates).map((u) => updateStatement(u, userId)),
    ...sim.ledgerRows.map(ledgerInsertStatement),
    ...sim.dailyIncrements.map((d) => dailyStatement(userId, d)),
    ...sim.events.map(eventStatement),
    ...sim.newOffers.map(offerStatement),
  ];
}

/** The seed of one offer refresh: a per-player secret the client never sees, and the refresh counter. */
async function offerSeedFor(profile: Pick<FarmProfileRow, 'offer_salt' | 'offer_refresh_index'>, index = profile.offer_refresh_index): Promise<string> {
  return seedFrom(profile.offer_salt, 'offers', String(index));
}

export async function loadFarmState(db: D1Database, userId: string, nowIso: string): Promise<FarmState | null> {
  const profile = await db.prepare('SELECT * FROM farm_profiles WHERE user_id = ?').bind(userId).first<FarmProfileRow>();
  if (!profile) return null;
  const live = LIVE_JOB_STATES.map((s) => `'${s}'`).join(',');
  const [bal, printers, spools, jobs, assignments, daily] = await Promise.all([
    db.prepare(BALANCE_SQL).bind(userId).first<{ balance: number }>(),
    // Sold machines keep their rows (their batch history is a job's memory) but are not part of the farm.
    db.prepare('SELECT * FROM farm_printers WHERE user_id = ? AND sold_at IS NULL ORDER BY slot').bind(userId).all<FarmPrinterRow>(),
    db.prepare('SELECT * FROM farm_spools WHERE user_id = ? ORDER BY created_at, id').bind(userId).all<FarmSpoolRow>(),
    db.prepare(`SELECT * FROM farm_jobs WHERE user_id = ? AND state IN (${live}) ORDER BY offered_at, id`).bind(userId).all<FarmJobRow>(),
    db.prepare(
      `SELECT a.* FROM farm_assignments a
        WHERE a.user_id = ?
          AND (a.state IN ('queued','printing','done')
               OR (a.state = 'failed' AND a.collected_at IS NULL)
               OR a.job_id IN (SELECT j.id FROM farm_jobs j WHERE j.user_id = ? AND j.state IN (${live})))
        ORDER BY a.position, a.created_at, a.id`
    ).bind(userId, userId).all<FarmAssignmentRow>(),
    db.prepare('SELECT * FROM farm_daily WHERE user_id = ? AND day = ?').bind(userId, baghdadDayOf(nowIso)).first<FarmDailyRow>(),
  ]);
  return {
    profile,
    balance: Number(bal?.balance ?? 0),
    printers: printers.results,
    spools: spools.results,
    jobs: jobs.results,
    assignments: assignments.results,
    daily: daily ?? null,
  };
}

/** The starter kit, written once: profile, starter coins, one A1 mini, one PLA spool, first offers. */
async function bootstrapStatements(user: SessionUser, cfg: FarmConfig, nowIso: string): Promise<SqlStatement[]> {
  const kit = starterKit(cfg);
  const userId = user.id;
  const farmName = String(user.username ?? user.name ?? '').trim().slice(0, 40);
  const printerId = `fprn_starter_${userId}`.slice(0, 80);
  const spoolId = `fspl_starter_${userId}`.slice(0, 80);
  // The player's secret: seeds every offer refresh, never returned by any route.
  const offerSalt = randomSeedHex();
  const out: SqlStatement[] = [
    {
      sql: `INSERT INTO farm_profiles (user_id, farm_name, level, xp, reputation_bp, location_key, state, last_seen_at, last_resolved_at,
              last_offer_at, offer_refresh_index, config_version, stats_json, tutorial_json, created_at, updated_at, revision, offer_salt)
            VALUES (?, ?, 1, 0, ?, ?, 'active', ?, ?, ?, 1, ?, '{}', '{}', ?, ?, 0, ?)`,
      params: [userId, farmName, kit.reputation_bp, kit.location_key, nowIso, nowIso, nowIso, cfg.version, nowIso, nowIso, offerSalt],
    },
  ];
  if (kit.coins > 0) {
    out.push(ledgerInsertStatement({
      id: `fl_starter_${userId}`.slice(0, 120), userId, kind: 'starter', amount: kit.coins, refType: 'starter', refId: 'kit',
      idempotencyKey: 'starter', note: 'starter kit', createdAt: nowIso,
    }));
  }
  out.push({
    sql: `INSERT INTO farm_printers (id, user_id, model_key, slot, nickname, health, state, hours, prints, failures, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 100, 'idle', 0, 0, 0, ?, ?)`,
    params: [printerId, userId, kit.printer.model_key, kit.printer.slot, defaultNickname(cfg, kit.printer.model_key, kit.printer.slot), nowIso, nowIso],
  });
  out.push({
    sql: `INSERT INTO farm_spools (id, user_id, material, color, grams_left, grams_total, quality, cost_paid, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    params: [spoolId, userId, kit.spool.material, kit.spool.color, kit.spool.grams, kit.spool.grams, kit.spool.quality, nowIso],
  });
  const first = starterFirstJob(cfg, userId, nowIso);
  if (first) out.push(offerStatement(first));
  const starterPrinter: FarmPrinterRow = {
    id: printerId, user_id: userId, model_key: kit.printer.model_key, slot: 0, nickname: '', health: 100, state: 'idle',
    state_until: null, hours: 0, prints: 0, failures: 0, upgrades_json: '[]', created_at: nowIso, updated_at: nowIso, sold_at: null,
  };
  const more = generateOffers({
    userId,
    profile: { level: 1, reputation_bp: kit.reputation_bp },
    capacity: ownedCapacity([starterPrinter], cfg),
    now: nowIso,
    cfg,
    seed: await offerSeedFor({ offer_salt: offerSalt, offer_refresh_index: 0 }),
    count: Math.max(0, cfg.jobs.offers_visible - (first ? 1 : 0)),
  });
  for (const o of more) out.push(offerStatement(o));
  return out;
}

/**
 * Loads the player's farm, creating it on first contact, and resolves it to
 * `nowIso`. Returns rows that reflect everything that happened until now.
 */
export async function ensureFarmState(db: D1Database, user: SessionUser, cfg: FarmConfig, nowIso: string): Promise<FarmState> {
  let state = await loadFarmState(db, user.id, nowIso);
  if (!state) {
    try {
      await db.batch((await bootstrapStatements(user, cfg, nowIso)).map((s) => bind(db, s)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Two first reads racing: the second finds the profile already there —
      // the ONLY failure a bootstrap may swallow.
      if (!(msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) || !msg.includes('farm_profiles')) {
        console.error('farm bootstrap failed', user.id, msg);
        throw e;
      }
    }
    state = await loadFarmState(db, user.id, nowIso);
    if (!state) throw new Error('farm bootstrap did not produce a profile');
  }
  if (!state.profile.offer_salt) {
    // A profile from before migration 0054: issue its secret once. Guarded on
    // the empty value so two first reads keep the same salt.
    await db.prepare("UPDATE farm_profiles SET offer_salt = ? WHERE user_id = ? AND offer_salt = ''").bind(randomSeedHex(), user.id).run();
    state = (await loadFarmState(db, user.id, nowIso))!;
  }
  const sim = resolve(state, nowIso, cfg, await offerSeedFor(state.profile));
  if (sim.changed) {
    try {
      await db.batch([fenceStatement(state.profile, nowIso, cfg), ...simStatements(sim, user.id)].map((s) => bind(db, s)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Another request of the same player resolved first; its rows are the
      // truth and the fence is what told us. Anything else is a real failure:
      // swallowing it would freeze the farm's clock silently.
      if (!isFenceConflict(msg)) {
        console.error('farm resolve failed', user.id, msg);
        throw e;
      }
    }
    state = (await loadFarmState(db, user.id, nowIso))!;
  }
  return state;
}

async function unseenEvents(db: D1Database, userId: string): Promise<FarmEventRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM farm_events WHERE user_id = ? AND seen_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 50')
    .bind(userId)
    .all<FarmEventRow>();
  return results;
}

/** Today's counters against the daily caps, so the client can say WHY a payout waits. */
export function limitsBlock(state: FarmState, cfg: FarmConfig, nowIso: string) {
  const day = baghdadDayOf(nowIso);
  const daily = state.daily && state.daily.day === day ? state.daily : null;
  return {
    max_active_jobs: maxActiveJobs(state.profile.level, cfg),
    storage_grams: locationSpec(cfg, state.profile.location_key).storage_grams,
    daily_jobs_cap: cfg.limits.daily_jobs_cap,
    daily_coins_cap: cfg.limits.daily_coins_cap,
    jobs_today: daily?.jobs_delivered ?? 0,
    coins_today: daily?.coins_earned ?? 0,
  };
}

/** The §4 state envelope. */
export function stateBody(state: FarmState, cfg: FarmConfig, nowIso: string, events: FarmEventRow[], includeConfig: boolean) {
  const jobsById = new Map(state.jobs.map((j) => [j.id, j]));
  const offered = state.jobs.filter((j) => j.state === 'offered');
  const active = state.jobs.filter((j) => ACTIVE_JOB_STATES.includes(j.state));
  return {
    now: nowIso,
    config_version: cfg.version,
    unlocks: stateUnlocks(state.profile, cfg),
    unlock_levels: unlockLevels(cfg),
    profile: profilePublic(state.profile, state.balance, cfg),
    printers: state.printers.map((p) => printerPublic(p, state.assignments, jobsById, cfg, nowIso)),
    spools: state.spools.map(spoolPublic),
    jobs: {
      offered: offered.map((j) => jobPublic(j, state.assignments, cfg)),
      active: active.map((j) => jobPublic(j, state.assignments, cfg)),
    },
    events_unseen: events.map(eventPublic),
    away: awaySummary(state.profile, events, nowIso, cfg),
    limits: limitsBlock(state, cfg, nowIso),
    ...(includeConfig ? { config: publicFarmConfig(cfg) } : {}),
  };
}

const M = (ar: string, en: string) => `${ar} / ${en}`;

// ---------------------------------------------------------------- mutation pipeline

interface MutationCtx {
  db: D1Database;
  state: FarmState;
  body: Record<string, unknown>;
  nowIso: string;
  cfg: FarmConfig;
  user: SessionUser;
  idempotencyKey: string;
  /** Deterministic id prefix for rows this request creates. */
  keyHash: string;
}
interface MutationPlan {
  statements: SqlStatement[];
  /** Indices (into `statements`) that must change ≥ 1 row, else the intent lost a race → 409. */
  mustChange?: number[];
  raceCode?: string;
  raceMessage?: string;
  result?: Record<string, unknown>;
}
interface MutationOpts {
  /** Second, tighter bucket for purchases. */
  buy?: boolean;
}

interface StoredRequest { route: string; result_json: string }

/** "<METHOD> <path>": the same key on another job, printer or route is a reuse, not a replay. */
const routeOf = (c: Context<AppContext>) => `${c.req.method} ${c.req.path}`.slice(0, 200);

async function storedRequest(db: D1Database, userId: string, key: string): Promise<StoredRequest | null> {
  return db.prepare('SELECT route, result_json FROM farm_requests WHERE user_id = ? AND idempotency_key = ?').bind(userId, key)
    .first<StoredRequest>();
}

function requestStatement(userId: string, key: string, route: string, result: Record<string, unknown>, nowIso: string): SqlStatement {
  let json = '{}';
  try {
    const v = JSON.stringify(result ?? {});
    if (v.length <= 8000) json = v;
  } catch {
    /* unserialisable result → {} */
  }
  return {
    sql: 'INSERT INTO farm_requests (user_id, idempotency_key, route, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
    params: [userId, key, route, json, nowIso],
  };
}

function parseResult(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const REUSED = () => conflict(M('مفتاح التكرار مستعمل لعملية مختلفة', 'This idempotency key was used for a different action'), 'IDEMPOTENCY_KEY_REUSED');
const STATE_CHANGED = () => conflict(M('تغيّرت الحالة، أعد المحاولة', 'State changed, please retry'), 'STATE_CHANGED');

/**
 * The pipeline every intent runs through:
 *   1. rate limit, parse, validate the key (no server-namespace look-alikes);
 *   2. resolve the farm to now (its own fenced batch) and re-read it;
 *   3. replay memory: a key this player already spent answers with the stored
 *      result of THAT request — or 409 IDEMPOTENCY_KEY_REUSED for another route;
 *   4. plan on the fresh rows; write [fence, …intent, farm_requests] as ONE
 *      batch. A stale fence aborts everything; the request re-reads, checks the
 *      replay memory again (a double-tap that lost the race replays), and
 *      re-plans once. Failing the fence twice is 409 STATE_CHANGED.
 */
async function runMutation(
  c: Context<AppContext>,
  opts: MutationOpts,
  plan: (ctx: MutationCtx) => Promise<MutationPlan> | MutationPlan
) {
  const user = c.get('user')!;
  const db = c.env.DB;
  const nowIso = new Date().toISOString();
  const cfg = await loadFarmConfig(db);
  await rateLimit(c, 'farm-mutate', cfg.limits.mutations_per_hour, 3600);
  if (opts.buy) await rateLimit(c, 'farm-buy', 30, 3600);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body !== 'object' || body === null) throw badRequest('Body must be a JSON object');
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });
  const keyProblem = clientKeyProblem(idempotencyKey);
  if (keyProblem) throw badRequest(keyProblem, 'IDEMPOTENCY_KEY_INVALID');
  const keyHash = (await sha256Hex(`${user.id}:${idempotencyKey}`)).slice(0, 24);
  const route = routeOf(c);

  const replay = async (stored: StoredRequest, state: FarmState) => {
    if (stored.route !== route) throw REUSED();
    return c.json({
      success: true, replayed: true, ...parseResult(stored.result_json),
      ...stateBody(state, cfg, nowIso, await unseenEvents(db, user.id), false),
    });
  };

  let state = await ensureFarmState(db, user, cfg, nowIso);
  const prior = await storedRequest(db, user.id, idempotencyKey);
  if (prior) return replay(prior, state);

  let result: Record<string, unknown> = {};
  for (let attempt = 0; ; attempt++) {
    const p = await plan({ db, state, body, nowIso, cfg, user, idempotencyKey, keyHash });
    result = p.result ?? {};
    try {
      const rows = await db.batch(
        [fenceStatement(state.profile, nowIso, cfg), ...p.statements, requestStatement(user.id, idempotencyKey, route, result, nowIso)]
          .map((st) => bind(db, st))
      );
      for (const i of p.mustChange ?? []) {
        const meta = rows[i + 1]?.meta as { changes?: number } | undefined;
        if (!meta || !(meta.changes && meta.changes > 0)) {
          // Planned on fenced, fresh rows, so this is a plan that disagreed
          // with its own predicate — reported, never silently accepted.
          console.error('farm intent guard changed no row', route, i);
          throw conflict(p.raceMessage ?? M('تغيّرت الحالة، أعد المحاولة', 'State changed, please retry'), p.raceCode ?? 'STATE_CHANGED');
        }
      }
      break;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (isFenceConflict(msg)) {
        // The farm moved under this request: nothing landed. Re-read; a
        // double-tap that lost the race now finds its twin in the memory.
        state = await ensureFarmState(db, user, cfg, nowIso);
        const twin = await storedRequest(db, user.id, idempotencyKey);
        if (twin) return replay(twin, state);
        if (attempt === 0) continue;
        throw STATE_CHANGED();
      }
      if (msg.includes('farm_requests')) {
        // Same key committed by a concurrent twin between our read and our write.
        const twin = await storedRequest(db, user.id, idempotencyKey);
        if (twin) return replay(twin, await ensureFarmState(db, user, cfg, nowIso));
        throw STATE_CHANGED();
      }
      if (isInsufficientCoins(msg)) throw badRequest(M('العملات غير كافية', 'Not enough Farm Coins'), 'INSUFFICIENT_COINS');
      if (msg.includes('FARM_QTY_EXCEEDED')) throw badRequest(M('الكمية تتجاوز المطلوب', 'Quantity exceeds what the job still needs'), 'QTY_MISMATCH');
      if (msg.includes('grams_left')) throw badRequest(M('البكرة لا تكفي', 'The spool does not hold enough grams'), 'SPOOL_INSUFFICIENT');
      if (msg.includes('farm_assignments.printer_id')) throw conflict(M('الطابعة مشغولة', 'The printer is already printing'), 'PRINTER_UNAVAILABLE');
      if (msg.includes('farm_printers.user_id, farm_printers.slot')) throw conflict(M('لا توجد فتحة حرة', 'No free slot in the room'), 'NO_FREE_SLOT');
      if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
        // A deterministic business id collided on fenced rows: the event
        // already happened. Honest answer, nothing written.
        console.error('farm intent collided on a deterministic id', route, msg);
        throw STATE_CHANGED();
      }
      throw e;
    }
  }
  const fresh = await ensureFarmState(db, user, cfg, nowIso);
  return c.json({ success: true, replayed: false, ...result, ...stateBody(fresh, cfg, nowIso, await unseenEvents(db, user.id), false) });
}

const closedJob = (j: FarmJobRow) => !LIVE_JOB_STATES.includes(j.state);
/** Jobs that still occupy one of the player's active slots: accepted and not yet handed over. */
const countsAsActive = (j: FarmJobRow) => ACTIVE_JOB_STATES.includes(j.state) && !isPayoutDeferred(j);

/** Progressive disclosure is a server rule: a feature the level has not reached answers 409 FEATURE_LOCKED. */
function requireUnlock(state: FarmState, cfg: FarmConfig, feature: string): void {
  const need = featureLockLevel(state.profile, cfg, feature);
  if (need !== null) {
    throw new HttpError(409, M(`تُفتح هذه الميزة في المستوى ${need}`, `This feature unlocks at level ${need}`), 'FEATURE_LOCKED', { feature, min_level: need });
  }
}

function findJob(state: FarmState, id: string): FarmJobRow {
  const j = state.jobs.find((x) => x.id === id);
  if (!j) throw notFound(M('الطلب غير موجود', 'Job not found'));
  return j;
}

/**
 * An offer the resolver just closed is no longer in the live set; the player
 * who tapped it a moment too late deserves "expired", not "not found".
 */
async function findOffer(db: D1Database, state: FarmState, id: string): Promise<FarmJobRow> {
  const live = state.jobs.find((x) => x.id === id);
  if (live) return live;
  const closed = await db.prepare('SELECT state FROM farm_jobs WHERE id = ? AND user_id = ?').bind(id, state.profile.user_id)
    .first<{ state: FarmJobRow['state'] }>();
  if (!closed) throw notFound(M('الطلب غير موجود', 'Job not found'));
  if (closed.state === 'expired') throw conflict(M('انتهت صلاحية هذا العرض', 'This offer has expired'), 'OFFER_EXPIRED');
  throw conflict(M('هذا العرض لم يعد متاحًا', 'This offer is no longer available'), 'JOB_NOT_OFFERED');
}
function findPrinter(state: FarmState, id: string): FarmPrinterRow {
  const p = state.printers.find((x) => x.id === id);
  if (!p) throw notFound(M('الطابعة غير موجودة', 'Printer not found'));
  return p;
}

/** The profile columns a delivery/cancel touches, as one UPDATE. */
function profileUpdate(userId: string, set: Record<string, string | number | null>, nowIso: string): SqlStatement {
  return updateStatement({ table: 'farm_profiles', id: userId, set: { ...set, updated_at: nowIso } }, userId);
}

// ---------------------------------------------------------------- public read

/**
 * PUBLIC (no auth): the leaderboard, computed from farm_profiles and owned
 * printers at catalog resale value. Rows carry only username, avatar_key,
 * farm_name and the score — never an email or an id. Registered BEFORE the
 * auth middleware so it stays open; everything after it requires a session.
 */
farmRoutes.get('/leaderboard', async (c) => {
  const board = oneOf(c.req.query('board') ?? 'reputation', 'board', ['reputation', 'farm_value', 'jobs_delivered'] as const);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 50 });
  const cfg = await loadFarmConfig(c.env.DB);
  let scoreSql: string;
  const params: unknown[] = [];
  if (board === 'reputation') {
    scoreSql = 'p.reputation_bp';
  } else if (board === 'jobs_delivered') {
    scoreSql = "COALESCE(json_extract(p.stats_json, '$.delivered'), 0)";
  } else {
    const models = Object.keys(cfg.printers);
    const caseSql = models.length ? `CASE fp.model_key ${models.map(() => 'WHEN ? THEN ?').join(' ')} ELSE 0 END` : '0';
    for (const k of models) params.push(k, resaleValue(cfg, k));
    scoreSql = `((SELECT COALESCE(SUM(l.amount), 0) FROM farm_ledger l WHERE l.user_id = p.user_id)
               + (SELECT COALESCE(SUM(${caseSql}), 0) FROM farm_printers fp WHERE fp.user_id = p.user_id AND fp.sold_at IS NULL))`;
  }
  params.push(limit);
  const { results } = await c.env.DB
    .prepare(
      `SELECT u.username, u.avatar_key, p.farm_name, ${scoreSql} AS score
         FROM farm_profiles p JOIN users u ON u.id = p.user_id
        ORDER BY score DESC, p.reputation_bp DESC, p.created_at ASC
        LIMIT ?`
    )
    .bind(...params)
    .all<{ username: string | null; avatar_key: string | null; farm_name: string; score: number }>();
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({
    success: true,
    board,
    generated_at: new Date().toISOString(),
    rows: results.map((r, i) => ({
      rank: i + 1, username: r.username, avatar_key: r.avatar_key, farm_name: r.farm_name, score: Number(r.score ?? 0),
    })),
  });
});

farmRoutes.use('*', requireAuth);

// ---------------------------------------------------------------- reads

farmRoutes.get('/state', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const nowIso = new Date().toISOString();
  const cfg = await loadFarmConfig(db);
  const state = await ensureFarmState(db, user, cfg, nowIso);
  const events = await unseenEvents(db, user.id);
  const body = stateBody(state, cfg, nowIso, events, c.req.query('config') !== '0');
  // The away summary was computed against the previous visit; record this one.
  await db.prepare('UPDATE farm_profiles SET last_seen_at = ? WHERE user_id = ?').bind(nowIso, user.id).run();
  return c.json({ success: true, ...body });
});

farmRoutes.get('/config', async (c) => {
  const cfg = await loadFarmConfig(c.env.DB);
  const etag = `"farm-v${cfg.version}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', 'private, max-age=60');
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
  return c.json({ success: true, version: cfg.version, config: publicFarmConfig(cfg) });
});

farmRoutes.get('/ledger', async (c) => {
  const user = c.get('user')!;
  const beforeRaw = str(c.req.query('before'), 'before', { max: 200, required: false });
  const limit = 30;
  const params: unknown[] = [user.id];
  let where = '';
  if (beforeRaw) {
    const sep = beforeRaw.indexOf('|');
    const createdAt = sep >= 0 ? beforeRaw.slice(0, sep) : beforeRaw;
    const id = sep >= 0 ? beforeRaw.slice(sep + 1) : '';
    where = id ? 'WHERE (created_at < ? OR (created_at = ? AND id < ?))' : 'WHERE created_at < ?';
    params.push(...(id ? [createdAt, createdAt, id] : [createdAt]));
  }
  params.push(limit + 1);
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, kind, amount, balance_after, note, ref_type, ref_id, created_at FROM (
         SELECT id, kind, amount, note, ref_type, ref_id, created_at,
                SUM(amount) OVER (ORDER BY created_at, id ROWS UNBOUNDED PRECEDING) AS balance_after
           FROM farm_ledger WHERE user_id = ?
       ) ${where}
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(...params)
    .all<{ id: string; kind: string; amount: number; balance_after: number; note: string; ref_type: string; ref_id: string; created_at: string }>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    success: true,
    entries: page,
    next_before: results.length > limit && last ? `${last.created_at}|${last.id}` : null,
  });
});

farmRoutes.get('/events', async (c) => {
  const user = c.get('user')!;
  const all = c.req.query('all') === '1';
  const { results } = await c.env.DB
    .prepare(
      `SELECT * FROM farm_events WHERE user_id = ? ${all ? '' : 'AND seen_at IS NULL'} ORDER BY created_at DESC, id DESC LIMIT 100`
    )
    .bind(user.id)
    .all<FarmEventRow>();
  return c.json({ success: true, events: results.map(eventPublic) });
});

farmRoutes.post('/events/seen', async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && x.length <= 120).slice(0, 100) : [];
  if (!ids.length) return c.json({ success: true, marked: 0 });
  const nowIso = new Date().toISOString();
  const res = await c.env.DB
    .prepare(`UPDATE farm_events SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(nowIso, user.id, ...ids)
    .run();
  return c.json({ success: true, marked: res.meta.changes ?? 0 });
});

// ---------------------------------------------------------------- profile

farmRoutes.post('/profile', (c) =>
  runMutation(c, {}, ({ body, state, nowIso }) => {
    const farmName = str(body.farm_name, 'farm_name', { min: 2, max: 40 });
    return {
      statements: [profileUpdate(state.profile.user_id, { farm_name: farmName }, nowIso)],
      result: { farm_name: farmName },
    };
  })
);

// ---------------------------------------------------------------- job intents

farmRoutes.post('/jobs/:id/accept', (c) =>
  runMutation(c, {}, async ({ db, state, nowIso, cfg }) => {
    const job = await findOffer(db, state, c.req.param('id'));
    if (job.state !== 'offered') {
      throw conflict(M('هذا العرض لم يعد متاحًا', 'This offer is no longer available'), msOf(job.offer_expires_at) <= msOf(nowIso) ? 'OFFER_EXPIRED' : 'JOB_NOT_OFFERED');
    }
    const active = state.jobs.filter(countsAsActive).length;
    const cap = maxActiveJobs(state.profile.level, cfg);
    if (active >= cap) {
      throw new HttpError(409, M(`لديك ${cap} طلبات نشطة — سلّم أحدها أولًا`, `You already hold ${cap} active jobs — deliver one first`), 'TOO_MANY_ACTIVE_JOBS', { max_active_jobs: cap });
    }
    return {
      statements: [{
        sql: "UPDATE farm_jobs SET state = 'accepted', accepted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND state = 'offered'",
        params: [nowIso, nowIso, job.id, state.profile.user_id],
      }],
      mustChange: [0],
      raceCode: 'JOB_NOT_OFFERED',
      raceMessage: M('هذا العرض لم يعد متاحًا', 'This offer is no longer available'),
      result: { job_id: job.id },
    };
  })
);

farmRoutes.post('/jobs/:id/reject', (c) =>
  runMutation(c, {}, async ({ db, state, nowIso }) => {
    const job = await findOffer(db, state, c.req.param('id'));
    if (job.state !== 'offered') throw conflict(M('هذا العرض لم يعد متاحًا', 'This offer is no longer available'), 'JOB_NOT_OFFERED');
    return {
      statements: [{
        sql: "UPDATE farm_jobs SET state = 'rejected', updated_at = ? WHERE id = ? AND user_id = ? AND state = 'offered'",
        params: [nowIso, job.id, state.profile.user_id],
      }],
      mustChange: [0],
      raceCode: 'JOB_NOT_OFFERED',
      result: { job_id: job.id },
    };
  })
);

interface Allocation { printer_id: string; qty: number; spool_id: string }

farmRoutes.post('/jobs/:id/assign', (c) =>
  runMutation(c, {}, async ({ state, body, nowIso, cfg, keyHash }) => {
    const job = findJob(state, c.req.param('id'));
    if (job.state !== 'accepted' && job.state !== 'printing' && job.state !== 'late') {
      throw conflict(M('لا يمكن توزيع هذا الطلب الآن', 'This job cannot be assigned now'), 'JOB_NOT_ACTIVE');
    }
    const product = productSpec(cfg, job.product_key);
    if (!product) throw conflict(M('المنتج لم يعد في الكتالوج', 'This product is no longer in the catalog'), 'PRODUCT_UNKNOWN');
    const material = materialSpec(cfg, job.material);
    const quality: Quality = body.quality === undefined ? job.quality : oneOf(body.quality, 'quality', QUALITIES);
    const allowPartial = body.allow_partial === true;
    if (!Array.isArray(body.allocations) || body.allocations.length === 0 || body.allocations.length > 20) {
      throw badRequest(M('التوزيع مطلوب', 'allocations must be a non-empty array (max 20)'));
    }
    const allocations: Allocation[] = body.allocations.map((a: unknown, i: number) => {
      const o = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
      return {
        printer_id: str(o.printer_id, `allocations[${i}].printer_id`, { min: 1, max: 80 }),
        qty: int(o.qty, `allocations[${i}].qty`, { min: 1, max: 10000 }),
        spool_id: str(o.spool_id, `allocations[${i}].spool_id`, { min: 1, max: 80 }),
      };
    });
    const assignedQty = state.assignments
      .filter((a) => a.job_id === job.id && (a.state === 'queued' || a.state === 'printing' || a.state === 'done' || a.state === 'collected'))
      .reduce((s, a) => s + a.qty, 0);
    const remaining = job.qty - assignedQty;
    const total = allocations.reduce((s, a) => s + a.qty, 0);
    if (remaining <= 0 || total > remaining || (!allowPartial && total !== remaining)) {
      throw badRequest(
        M(`الكمية يجب أن تساوي ${remaining}`, `Quantities must add up to the ${remaining} part(s) still unassigned`),
        'QTY_MISMATCH',
        { remaining }
      );
    }
    const colors = parseColors(job.colors_json);
    const statements: SqlStatement[] = [];
    const mustChange: number[] = [];
    const spoolUse = new Map<string, number>();
    const startedPrinters = new Set<string>();
    let anyStarted = false;
    const created: Array<{ assignment_id: string; printer_id: string; qty: number; seconds: number; started: boolean; ends_at: string | null }> = [];

    for (let i = 0; i < allocations.length; i++) {
      const al = allocations[i];
      const printer = findPrinter(state, al.printer_id);
      const model = printerModel(cfg, printer.model_key);
      if (!model || printer.state === 'broken' || printer.state === 'maintenance') {
        throw badRequest(M('الطابعة غير متاحة', 'That printer is not available'), 'PRINTER_UNAVAILABLE', { printer_id: printer.id, state: printer.state });
      }
      if (!supportsMaterial(model, job.material)) {
        throw badRequest(M(`هذه الطابعة لا تطبع ${job.material}`, `This printer cannot print ${job.material}`), 'PRINTER_INCOMPATIBLE_MATERIAL', { printer_id: printer.id, material: job.material });
      }
      if (colors.length > 1 && !model.ams) {
        throw badRequest(M('الطلب متعدد الألوان ويحتاج طابعة مع AMS', 'A multi-colour job needs an AMS-capable printer'), 'PRINTER_NO_MULTICOLOR', { printer_id: printer.id });
      }
      if (!partFits(model, product)) {
        throw badRequest(M('القطعة أكبر من حجم الطباعة', 'The part does not fit this printer\'s build volume'), 'PART_TOO_LARGE', { printer_id: printer.id });
      }
      const spool = state.spools.find((s) => s.id === al.spool_id);
      if (!spool) throw notFound(M('البكرة غير موجودة', 'Spool not found'));
      if (spool.material !== job.material || (colors.length > 0 && !colors.includes(spool.color))) {
        throw badRequest(M('البكرة لا تطابق خامة الطلب أو لونه', 'The spool does not match the job\'s material or colour'), 'SPOOL_MISMATCH', { spool_id: spool.id });
      }
      const grams = gramsFor(product, al.qty);
      const used = (spoolUse.get(spool.id) ?? 0) + grams;
      if (used > spool.grams_left) {
        throw badRequest(M('البكرة لا تكفي', 'The spool does not hold enough grams'), 'SPOOL_INSUFFICIENT', { spool_id: spool.id, grams_left: spool.grams_left, needed: used });
      }
      spoolUse.set(spool.id, used);

      const seconds = printSeconds(product, al.qty, model, quality, cfg);
      // The id is deterministic per request (a retry collides, never books twice);
      // the SEED is the server's alone — 32 random bytes the client cannot search for.
      const id = `fasg_${keyHash}_${i}`;
      const outcomeSeed = randomSeedHex();
      const live = state.assignments.filter((a) => a.printer_id === printer.id && (a.state === 'queued' || a.state === 'printing' || a.state === 'done' || (a.state === 'failed' && !a.collected_at)));
      const position = Math.max(0, ...live.map((a) => a.position)) + 1 + i;
      const startNow = printer.state === 'idle' && !startedPrinters.has(printer.id) && !currentAssignmentOf(printer, state.assignments) && queueOf(printer, state.assignments).length === 0;
      const failureP = startNow ? failureProbabilityFor(cfg, printer, product, material, spool, quality) : 0;
      const endsAt = startNow ? endsAtFor(nowIso, seconds, cfg) : null;

      statements.push({
        sql: `INSERT INTO farm_assignments (id, user_id, job_id, printer_id, spool_id, qty, grams, seconds, quality, position, state,
                started_at, ends_at, failure_p, outcome_seed, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [id, state.profile.user_id, job.id, printer.id, spool.id, al.qty, grams, seconds, quality, position,
          startNow ? 'printing' : 'queued', startNow ? nowIso : null, endsAt, failureP, outcomeSeed, nowIso, nowIso],
      });
      // Reserved now; the CHECK on grams_left is what refuses an overdraw.
      statements.push({
        sql: 'UPDATE farm_spools SET grams_left = grams_left - ? WHERE id = ? AND user_id = ?',
        params: [grams, spool.id, state.profile.user_id],
      });
      mustChange.push(statements.length - 1);
      if (startNow) {
        statements.push({
          sql: "UPDATE farm_printers SET state = 'printing', updated_at = ? WHERE id = ? AND user_id = ? AND state = 'idle'",
          params: [nowIso, printer.id, state.profile.user_id],
        });
        mustChange.push(statements.length - 1);
        startedPrinters.add(printer.id);
        anyStarted = true;
      }
      created.push({ assignment_id: id, printer_id: printer.id, qty: al.qty, seconds, started: startNow, ends_at: endsAt });
    }
    if (anyStarted && job.state === 'accepted') {
      statements.push({
        sql: "UPDATE farm_jobs SET state = 'printing', updated_at = ? WHERE id = ? AND user_id = ? AND state = 'accepted'",
        params: [nowIso, job.id, state.profile.user_id],
      });
    }
    return {
      statements, mustChange,
      raceCode: 'PRINTER_UNAVAILABLE',
      raceMessage: M('تغيّرت حالة الطابعة أو البكرة، أعد المحاولة', 'The printer or spool changed under you, please retry'),
      result: { job_id: job.id, assignments: created },
    };
  })
);

farmRoutes.post('/jobs/:id/cancel', (c) =>
  runMutation(c, {}, ({ state, nowIso, cfg }) => {
    const job = findJob(state, c.req.param('id'));
    // A job whose parts were all handed over (payout waiting for the cap) is done work, not cancellable.
    if (!ACTIVE_JOB_STATES.includes(job.state) || isPayoutDeferred(job)) {
      throw conflict(M('لا يمكن إلغاء هذا الطلب', 'This job cannot be cancelled'), 'JOB_NOT_ACTIVE');
    }
    const userId = state.profile.user_id;
    const statements: SqlStatement[] = [{
      sql: `UPDATE farm_jobs SET state = 'cancelled', updated_at = ?
             WHERE id = ? AND user_id = ? AND state IN ('accepted','printing','ready','late') AND payout_deferred_day IS NULL`,
      params: [nowIso, job.id, userId],
    }];
    let refunded = 0;
    for (const a of state.assignments) {
      if (a.job_id !== job.id || a.state !== 'queued') continue;
      statements.push(updateStatement({ table: 'farm_assignments', id: a.id, set: { state: 'cancelled', updated_at: nowIso }, guardQueuedAssignment: a.id }, userId));
      statements.push({ sql: 'UPDATE farm_spools SET grams_left = grams_left + ? WHERE id = ? AND user_id = ?', params: [a.grams, a.spool_id, userId] });
      refunded += a.grams;
    }
    const penaltyCoins = Math.min(job.cancel_penalty_coins, state.balance);
    if (penaltyCoins > 0) {
      // One cancellation per job, ever — the id names the event, not the request.
      const id = eventLedgerId('cancelpen', job.id);
      statements.push(ledgerInsertStatement({
        id, userId, kind: 'penalty', amount: -penaltyCoins,
        refType: 'job', refId: job.id, idempotencyKey: systemLedgerKey(id), note: 'job cancelled by the player', createdAt: nowIso,
      }));
    }
    const stats = parseStats(state.profile.stats_json);
    stats.cancelled += 1;
    stats.streak = 0;
    const reputation = Math.max(0, Math.min(cfg.progression.reputation_cap_bp, state.profile.reputation_bp - job.cancel_penalty_bp));
    statements.push(profileUpdate(userId, { reputation_bp: reputation, stats_json: JSON.stringify(stats) }, nowIso));
    return {
      statements, mustChange: [0], raceCode: 'JOB_NOT_ACTIVE',
      result: { job_id: job.id, grams_refunded: refunded, reputation_bp: reputation, coins_penalty: penaltyCoins },
    };
  })
);

// ---------------------------------------------------------------- printer intents

farmRoutes.post('/printers/:id/queue', (c) =>
  runMutation(c, {}, ({ state, body, nowIso }) => {
    const printer = findPrinter(state, c.req.param('id'));
    if (!Array.isArray(body.order) || body.order.length > 100) throw badRequest('order must be an array of assignment ids');
    const order = body.order.filter((x: unknown): x is string => typeof x === 'string');
    const queued = queueOf(printer, state.assignments);
    const queuedIds = new Set(queued.map((a) => a.id));
    if (order.length !== queued.length || new Set(order).size !== order.length || !order.every((id: string) => queuedIds.has(id))) {
      throw badRequest(M('الترتيب يجب أن يضم كل الدفعات المنتظرة مرة واحدة', 'order must list every queued assignment exactly once'), 'QUEUE_MISMATCH', { queued: [...queuedIds] });
    }
    const base = Math.max(0, ...state.assignments.filter((a) => a.printer_id === printer.id && a.state !== 'queued').map((a) => a.position));
    return {
      statements: order.map((id: string, i: number) => ({
        sql: "UPDATE farm_assignments SET position = ?, updated_at = ? WHERE id = ? AND user_id = ? AND printer_id = ? AND state = 'queued'",
        params: [base + 1 + i, nowIso, id, state.profile.user_id, printer.id],
      })),
      result: { printer_id: printer.id, order },
    };
  })
);

farmRoutes.post('/printers/:id/collect', (c) =>
  runMutation(c, {}, ({ state, nowIso, cfg }) => {
    const printer = findPrinter(state, c.req.param('id'));
    const userId = state.profile.user_id;
    const cur = currentAssignmentOf(printer, state.assignments);
    if (!cur) throw conflict(M('لا توجد دفعة منتهية على هذه الطابعة', 'Nothing to collect on this printer'), 'NOTHING_TO_COLLECT');
    if (cur.state === 'printing') {
      throw new HttpError(409, M('الطباعة لم تنتهِ بعد', 'The print has not finished yet'), 'PRINT_NOT_FINISHED', { ends_at: cur.ends_at });
    }
    const statements: SqlStatement[] = [];
    const mustChange: number[] = [];
    if (cur.state === 'done') {
      statements.push({
        sql: "UPDATE farm_assignments SET state = 'collected', collected_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND state = 'done'",
        params: [nowIso, nowIso, cur.id, userId],
      });
    } else {
      statements.push({
        sql: "UPDATE farm_assignments SET collected_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND state = 'failed' AND collected_at IS NULL",
        params: [nowIso, nowIso, cur.id, userId],
      });
    }
    mustChange.push(0);

    // The printer ALWAYS comes free: idle, or straight into the next queued
    // batch — unless it is broken or being serviced, in which case it keeps
    // that state. No limit below may leave a batch on the bed.
    if (printer.state === 'done' || printer.state === 'idle') {
      const next = queueOf(printer, state.assignments)[0];
      const nextJob = next ? state.jobs.find((j) => j.id === next.job_id) : undefined;
      if (next && nextJob && !closedJob(nextJob)) {
        for (const u of startStatements(state, cfg, printer, next, nextJob, nowIso)) statements.push(updateStatement(u, userId));
      } else {
        statements.push({
          sql: "UPDATE farm_printers SET state = 'idle', updated_at = ? WHERE id = ? AND user_id = ? AND state IN ('done','idle')",
          params: [nowIso, printer.id, userId],
        });
      }
    }

    // Delivery: the job's every part collected → paid in this same batch, or
    // — when today's caps would be exceeded — handed over now and paid by the
    // resolver on a later day (`payout_deferred_day`), the job staying visible.
    let delivered: Record<string, unknown> | null = null;
    let deferred: Record<string, unknown> | null = null;
    const job = state.jobs.find((j) => j.id === cur.job_id);
    if (cur.state === 'done' && job && ACTIVE_JOB_STATES.includes(job.state) && !isPayoutDeferred(job)) {
      const collectedQty = state.assignments
        .filter((a) => a.job_id === job.id && (a.state === 'collected' || a.id === cur.id))
        .reduce((sum, a) => sum + a.qty, 0);
      if (collectedQty >= job.qty) {
        const day = baghdadDayOf(nowIso);
        const daily = state.daily && state.daily.day === day ? state.daily : null;
        if (dailyCapAllows(daily, job.reward_coins, cfg)) {
          const plan = deliveryPlan({
            userId, job, assignments: state.assignments, collectingId: cur.id, deliveredAt: nowIso, now: nowIso,
            running: { reputation: state.profile.reputation_bp, xp: state.profile.xp, level: state.profile.level, stats: parseStats(state.profile.stats_json) },
            cfg,
          });
          for (const u of plan.updates) { statements.push(updateStatement(u, userId)); mustChange.push(statements.length - 1); }
          if (plan.ledgerRow) statements.push(ledgerInsertStatement(plan.ledgerRow));
          statements.push(dailyStatement(userId, plan.daily));
          statements.push(profileUpdate(userId, {
            reputation_bp: plan.running.reputation, xp: plan.running.xp, level: plan.running.level, stats_json: JSON.stringify(plan.running.stats),
          }, nowIso));
          for (const e of plan.events) statements.push(eventStatement(e));
          delivered = { ...plan.summary };
        } else {
          statements.push({
            sql: `UPDATE farm_jobs SET payout_deferred_day = ?, delivered_at = ?,
                         state = CASE WHEN state = 'late' THEN 'late' ELSE 'ready' END, updated_at = ?
                   WHERE id = ? AND user_id = ? AND state IN ('accepted','printing','ready','late') AND payout_deferred_day IS NULL`,
            params: [day, nowIso, nowIso, job.id, userId],
          });
          mustChange.push(statements.length - 1);
          deferred = {
            job_id: job.id, reward_coins: job.reward_coins, day, late: msOf(nowIso) > msOf(job.deadline_at),
            reason: (daily?.jobs_delivered ?? 0) >= cfg.limits.daily_jobs_cap ? 'daily_jobs_cap' : 'daily_coins_cap',
          };
        }
      }
    }
    return {
      statements, mustChange,
      raceCode: 'NOTHING_TO_COLLECT',
      raceMessage: M('جُمعت هذه الدفعة بالفعل', 'This batch was already collected'),
      result: {
        printer_id: printer.id,
        collected: { assignment_id: cur.id, job_id: cur.job_id, qty: cur.qty, outcome: cur.state, failure_kind: cur.failure_kind },
        delivered,
        payout_deferred: deferred,
      },
    };
  })
);

function serviceStatements(
  ctx: MutationCtx, printer: FarmPrinterRow, kind: 'maintenance' | 'repair'
): MutationPlan {
  const { state, nowIso, cfg } = ctx;
  const userId = state.profile.user_id;
  const spec = kind === 'maintenance' ? cfg.economy.maintenance : cfg.economy.repair;
  const targetHealth = kind === 'maintenance' ? Math.max(printer.health, cfg.economy.maintenance.health_restore) : cfg.economy.repair.health;
  const until = serviceUntil(nowIso, spec.minutes, cfg);
  const statements: SqlStatement[] = [];
  if (spec.cost > 0) {
    // One debit per service ORDER: the revision this plan was built on is
    // consumed by the fence, so no second batch can carry the same id.
    const id = eventLedgerId(kind === 'maintenance' ? 'maint' : 'repair', `${printer.id}_${state.profile.revision}`);
    statements.push(ledgerInsertStatement({
      id, userId, kind, amount: -spec.cost,
      refType: 'printer', refId: printer.id, idempotencyKey: systemLedgerKey(id), note: `${kind} ${printer.model_key}`, createdAt: nowIso,
    }));
  }
  statements.push({
    sql: `UPDATE farm_printers SET state = 'maintenance', state_until = ?, health = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND state IN (${kind === 'repair' ? "'broken'" : "'idle','done'"})`,
    params: [until, targetHealth, nowIso, printer.id, userId],
  });
  return {
    statements,
    mustChange: [statements.length - 1],
    raceCode: 'PRINTER_BUSY',
    result: { printer_id: printer.id, state_until: until, cost: spec.cost, health: targetHealth },
  };
}

farmRoutes.post('/printers/:id/maintain', (c) =>
  runMutation(c, {}, (ctx) => {
    const printer = findPrinter(ctx.state, c.req.param('id'));
    // Progressive disclosure, enforced: a level-1 farm cannot buy maintenance
    // through the API either. Repair stays open — a broken starter printer
    // must be recoverable at any level.
    requireUnlock(ctx.state, ctx.cfg, 'maintenance');
    if (printer.state !== 'idle' && printer.state !== 'done') {
      throw conflict(M('الطابعة مشغولة الآن', 'The printer is busy right now'), printer.state === 'broken' ? 'PRINTER_BROKEN' : 'PRINTER_BUSY');
    }
    return serviceStatements(ctx, printer, 'maintenance');
  })
);

farmRoutes.post('/printers/:id/repair', (c) =>
  runMutation(c, {}, (ctx) => {
    const printer = findPrinter(ctx.state, c.req.param('id'));
    if (printer.state !== 'broken') throw conflict(M('الطابعة ليست معطّلة', 'The printer is not broken'), 'PRINTER_NOT_BROKEN');
    return serviceStatements(ctx, printer, 'repair');
  })
);

farmRoutes.post('/printers/:id/rename', (c) =>
  runMutation(c, {}, ({ state, body, nowIso }) => {
    const printer = findPrinter(state, c.req.param('id'));
    const nickname = str(body.nickname, 'nickname', { max: 40, required: false });
    return {
      statements: [{ sql: 'UPDATE farm_printers SET nickname = ?, updated_at = ? WHERE id = ? AND user_id = ?', params: [nickname, nowIso, printer.id, state.profile.user_id] }],
      result: { printer_id: printer.id, nickname },
    };
  })
);

// ---------------------------------------------------------------- market intents

farmRoutes.post('/market/filament', (c) =>
  runMutation(c, { buy: true }, async ({ state, body, nowIso, cfg, idempotencyKey, keyHash }) => {
    // The market tab the client hides below `unlocks.market` is closed here too.
    requireUnlock(state, cfg, 'market');
    const materialKey = str(body.material, 'material', { min: 1, max: 40 });
    const color = str(body.color, 'color', { min: 1, max: 40 });
    const grams = int(body.grams, 'grams', { min: 1, max: 1_000_000 });
    const material = materialSpec(cfg, materialKey);
    if (!material) throw badRequest(M('خامة غير معروفة', 'Unknown material'), 'MATERIAL_UNKNOWN');
    if (!material.colors.includes(color)) throw badRequest(M('هذا اللون غير متاح لهذه الخامة', 'That colour is not available for this material'), 'COLOR_UNKNOWN');
    if (!cfg.economy.spool_sizes_g.includes(grams)) throw badRequest(M('حجم بكرة غير متاح', 'That spool size is not sold'), 'SPOOL_SIZE_UNKNOWN', { sizes: cfg.economy.spool_sizes_g });
    if (material.min_level > state.profile.level) {
      throw new HttpError(409, M(`تُفتح هذه الخامة في المستوى ${material.min_level}`, `This material unlocks at level ${material.min_level}`), 'LEVEL_TOO_LOW', { min_level: material.min_level });
    }
    const storage = locationSpec(cfg, state.profile.location_key).storage_grams;
    const held = state.spools.reduce((s, x) => s + x.grams_left, 0);
    if (held + grams > storage) {
      throw new HttpError(409, M('المخزن ممتلئ', 'Your storage is full'), 'STORAGE_FULL', { storage_grams: storage, held_grams: held });
    }
    const cost = Math.ceil(material.price_per_gram * grams);
    const userId = state.profile.user_id;
    const spoolId = `fspl_${keyHash}`;
    const statements: SqlStatement[] = [];
    if (cost > 0) {
      statements.push(ledgerInsertStatement({
        id: await requestLedgerId(userId, idempotencyKey), userId, kind: 'filament_purchase', amount: -cost,
        refType: 'spool', refId: spoolId, idempotencyKey: clientLedgerKey(idempotencyKey), note: `${grams}g ${materialKey} ${color}`, createdAt: nowIso,
      }));
    }
    statements.push({
      sql: `INSERT INTO farm_spools (id, user_id, material, color, grams_left, grams_total, quality, cost_paid, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [spoolId, userId, materialKey, color, grams, grams, material.quality, cost, nowIso],
    });
    return { statements, result: { spool_id: spoolId, cost } };
  })
);

farmRoutes.post('/market/printers', (c) =>
  runMutation(c, { buy: true }, async ({ state, body, nowIso, cfg, idempotencyKey, keyHash }) => {
    requireUnlock(state, cfg, 'market');
    const modelKey = str(body.model_key, 'model_key', { min: 1, max: 40 });
    const model = printerModel(cfg, modelKey);
    if (!model) throw badRequest(M('طراز غير معروف', 'Unknown printer model'), 'MODEL_UNKNOWN');
    if (model.min_level > state.profile.level) {
      throw new HttpError(409, M(`يُفتح هذا الطراز في المستوى ${model.min_level}`, `This model unlocks at level ${model.min_level}`), 'LEVEL_TOO_LOW', { min_level: model.min_level });
    }
    const loc = locationSpec(cfg, state.profile.location_key);
    if (state.printers.length >= loc.max_printers) {
      throw new HttpError(409, M('لا توجد فتحة حرة في الغرفة', 'No free slot in the room'), 'NO_FREE_SLOT', { max_printers: loc.max_printers });
    }
    const userId = state.profile.user_id;
    const printerId = `fprn_${keyHash}`;
    const slot = lowestFreeSlot(state.printers);
    return {
      statements: [
        ledgerInsertStatement({
          id: await requestLedgerId(userId, idempotencyKey), userId, kind: 'printer_purchase', amount: -model.price,
          refType: 'printer', refId: printerId, idempotencyKey: clientLedgerKey(idempotencyKey), note: `bought ${modelKey}`, createdAt: nowIso,
        }),
        {
          sql: `INSERT INTO farm_printers (id, user_id, model_key, slot, nickname, health, state, hours, prints, failures, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 100, 'idle', 0, 0, 0, ?, ?)`,
          params: [printerId, userId, modelKey, slot, defaultNickname(cfg, modelKey, slot), nowIso, nowIso],
        },
      ],
      result: { printer_id: printerId, slot, cost: model.price },
    };
  })
);

farmRoutes.post('/market/printers/:id/sell', (c) =>
  runMutation(c, {}, ({ state, nowIso, cfg }) => {
    const printer = findPrinter(state, c.req.param('id'));
    requireUnlock(state, cfg, 'market');
    if (printer.state !== 'idle' || currentAssignmentOf(printer, state.assignments) || queueOf(printer, state.assignments).length) {
      throw conflict(M('لا تُباع إلا طابعة خاملة بلا طابور', 'Only an idle printer with an empty queue can be sold'), 'PRINTER_BUSY');
    }
    const userId = state.profile.user_id;
    const value = resaleValue(cfg, printer.model_key);
    // A farm without a printer earns nothing. Selling the LAST machine is
    // allowed only while the proceeds still buy the cheapest model this level
    // may own — otherwise the player would be stranded for good (the defaults:
    // 1,500 + 3,300 resale < 6,000), and bankruptcy must never kill a farm.
    if (state.printers.length === 1) {
      const affordable = Object.values(cfg.printers).filter((m) => m.min_level <= state.profile.level && m.price > 0).map((m) => m.price);
      const cheapest = affordable.length ? Math.min(...affordable) : 0;
      if (cheapest > 0 && state.balance + value < cheapest) {
        throw new HttpError(
          409,
          M('هذه آخر طابعة لديك، وبيعها لن يكفي لشراء أخرى', 'This is your last printer and selling it would not pay for another one'),
          'LAST_PRINTER',
          { coins_after_sale: state.balance + value, cheapest_printer_coins: cheapest }
        );
      }
    }
    // NEVER a DELETE: farm_assignments cascades from the printer and a
    // half-delivered job would forget the parts already made. The row stays
    // with `sold_at`, and its slot is PARKED at slot + 1000000 × n (n = how
    // many sold rows already came from that slot) so `slot >= 0` and
    // UNIQUE (user_id, slot) hold while the room slot itself comes free.
    const statements: SqlStatement[] = [{
      sql: `UPDATE farm_printers
               SET sold_at = ?, updated_at = ?,
                   slot = slot + ? * (1 + (SELECT COUNT(*) FROM farm_printers s
                                             WHERE s.user_id = farm_printers.user_id AND s.sold_at IS NOT NULL
                                               AND (s.slot % ?) = farm_printers.slot))
             WHERE id = ? AND user_id = ? AND sold_at IS NULL AND state = 'idle'
               AND NOT EXISTS (SELECT 1 FROM farm_assignments a WHERE a.printer_id = farm_printers.id AND a.state IN ('queued','printing','done'))`,
      params: [nowIso, nowIso, PARKED_SLOT_BASE, PARKED_SLOT_BASE, printer.id, userId],
    }];
    if (value > 0) {
      // A machine is sold once: the id names the printer, not the request.
      const id = eventLedgerId('sale', printer.id);
      statements.push(ledgerInsertStatement({
        id, userId, kind: 'printer_sale', amount: value,
        refType: 'printer', refId: printer.id, idempotencyKey: systemLedgerKey(id), note: `sold ${printer.model_key}`, createdAt: nowIso,
      }));
    }
    return { statements, mustChange: [0], raceCode: 'PRINTER_BUSY', result: { printer_id: printer.id, credited: value, slot_freed: printer.slot } };
  })
);

export { isQuality };
