/**
 * resolve(state, now, cfg) — the deterministic simulation step.
 *
 * Progress is resolved from timestamps, never ticked: a print that started at
 * T with duration D is done at T+D whenever the state is next read. This
 * function is PURE — it takes the loaded rows and the server clock and returns
 * what changed as DATA (row updates, ledger rows, events, new offers); the
 * route turns that into one D1 batch. It never reads the clock itself, never
 * touches D1, and rolls every outcome from the seed stored on the row — a
 * seed the server drew (`randomSeedHex`) or derived from a secret the player
 * never sees, so no request input can steer a roll.
 *
 * Race safety comes from the shape of the data it returns: assignment flips
 * are guarded by `state = 'printing'`, printer changes repeat that guard
 * (`guardPrintingAssignment`), events carry deterministic ids for INSERT OR
 * IGNORE, ledger rows carry deterministic ids so a second resolution of the
 * same batch collides instead of paying twice, and the route opens every write
 * batch with a compare-and-swap on the profile row.
 */

import type { FarmConfig } from './config';
import { materialSpec, ownedCapacity, printerModel, productSpec } from './catalog';
import { failureCosts, failureProbabilityFor, pickFailureKind } from './failure';
import { generateOffers, type JobInsert } from './jobs';
import { eventLedgerId, systemLedgerKey, type LedgerInsert } from './ledger';
import { clampReputation, levelForXp, reputationAfterDelivery, xpForJob } from './progression';
import { roll } from './rng';
import { baghdadDayOf, endsAtFor, gameHours, msOf, realMinutesToMs } from './time';
import {
  ACTIVE_JOB_STATES, isPayoutDeferred, parseStats,
  type FarmAssignmentRow, type FarmDailyRow, type FarmEventKind, type FarmJobRow, type FarmPrinterRow, type FarmState,
  type FarmStats,
} from './types';

export interface SimUpdate {
  table: 'farm_assignments' | 'farm_printers' | 'farm_jobs' | 'farm_spools' | 'farm_profiles';
  /** Row id (user_id for farm_profiles). */
  id: string;
  /** Columns set to absolute values. */
  set: Record<string, string | number | null>;
  /** Columns incremented (`col = col + n`). */
  inc?: Record<string, number>;
  /** Apply only while this assignment is still `printing` — repeats the winner's predicate. */
  guardPrintingAssignment?: string;
  /** Apply only while this assignment is still `queued`. */
  guardQueuedAssignment?: string;
  /** Apply only while the target row's own `state` is one of these. */
  guardStateIn?: readonly string[];
}

/** A farm_daily upsert: coins earned and jobs delivered on a Baghdad day. */
export interface DailyIncrement {
  day: string;
  coins: number;
  jobs: number;
}

export interface EventInsert {
  id: string;
  user_id: string;
  kind: FarmEventKind;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface SimResult {
  updates: SimUpdate[];
  ledgerRows: LedgerInsert[];
  events: EventInsert[];
  newOffers: JobInsert[];
  /** Assignments whose print ended (done or failed). */
  finishedAssignments: string[];
  /** Jobs whose every part is now printed. */
  readyJobs: string[];
  lateJobs: string[];
  cancelledJobs: string[];
  expiredJobs: string[];
  /** Jobs whose deferred payout (daily cap) was paid in this resolution. */
  paidJobs: string[];
  /** farm_daily upserts the payouts above need. */
  dailyIncrements: DailyIncrement[];
  /** Coin balance after the ledger rows above. */
  balance: number;
  /** Reputation after every delta above. */
  reputationBp: number;
  stats: FarmStats;
  /** Whether anything needs writing. */
  changed: boolean;
}

/**
 * The updates that START a queued batch on a printer: the assignment goes
 * `printing` with its end time and the failure probability of this moment
 * (frozen on the row), the printer goes `printing`, and an `accepted` job
 * becomes `printing`. Shared by the resolver and the collect route.
 */
export function startStatements(
  state: FarmState,
  cfg: FarmConfig,
  printer: Pick<FarmPrinterRow, 'id' | 'health' | 'model_key'>,
  assignment: Pick<FarmAssignmentRow, 'id' | 'seconds' | 'spool_id' | 'quality'>,
  job: Pick<FarmJobRow, 'id' | 'product_key' | 'material' | 'state'>,
  now: string
): SimUpdate[] {
  const product = productSpec(cfg, job.product_key);
  const material = materialSpec(cfg, job.material);
  const spool = state.spools.find((s) => s.id === assignment.spool_id) ?? null;
  const failureP = failureProbabilityFor(cfg, printer, product, material, spool, assignment.quality);
  const out: SimUpdate[] = [
    {
      table: 'farm_printers', id: printer.id,
      set: { state: 'printing', state_until: null, updated_at: now },
      guardQueuedAssignment: assignment.id,
    },
    {
      table: 'farm_assignments', id: assignment.id,
      set: { state: 'printing', started_at: now, ends_at: endsAtFor(now, assignment.seconds, cfg), failure_p: failureP, updated_at: now },
      guardQueuedAssignment: assignment.id,
    },
  ];
  if (job.state === 'accepted') {
    out.unshift({ table: 'farm_jobs', id: job.id, set: { state: 'printing', updated_at: now }, guardQueuedAssignment: assignment.id });
  }
  return out;
}

// ---------------------------------------------------------------- delivery

/** The running player values a delivery moves; threaded so several payouts in one resolve compose. */
export interface RunningProfile {
  reputation: number;
  xp: number;
  level: number;
  stats: FarmStats;
}

export interface DeliveryInput {
  userId: string;
  job: FarmJobRow;
  /** Every assignment of this job; the collected ones set the quality factor. */
  assignments: FarmAssignmentRow[];
  /** The batch being collected in this same request (still `done` in the rows), if any. */
  collectingId?: string | null;
  /** When the work was handed over — collect time, or the stored delivered_at of a deferred job. */
  deliveredAt: string;
  now: string;
  running: RunningProfile;
  cfg: FarmConfig;
}

export interface DeliverySummary {
  job_id: string;
  reward_coins: number;
  late: boolean;
  reputation_delta_bp: number;
  reputation_bp: number;
  xp_gained: number;
  level: number;
  level_up: boolean;
}

export interface DeliveryPlan {
  /** The farm_jobs flip, guarded on the job still being active. */
  updates: SimUpdate[];
  ledgerRow: LedgerInsert | null;
  events: EventInsert[];
  daily: DailyIncrement;
  running: RunningProfile;
  summary: DeliverySummary;
}

/** Whether today's caps admit one more job worth `rewardCoins`, given what was already counted today. */
export function dailyCapAllows(
  daily: Pick<FarmDailyRow, 'jobs_delivered' | 'coins_earned'> | null, rewardCoins: number, cfg: FarmConfig
): boolean {
  const jobsToday = daily?.jobs_delivered ?? 0;
  const coinsToday = daily?.coins_earned ?? 0;
  return jobsToday < cfg.limits.daily_jobs_cap && coinsToday + rewardCoins <= cfg.limits.daily_coins_cap;
}

/**
 * Paying a job whose every part was handed over: the job becomes `delivered`,
 * the payout row carries the DETERMINISTIC id `fl_payout_<jobId>`, reputation
 * moves by the tier's gain (scaled by the lowest quality factor among the
 * batches) or by the late penalty when `deliveredAt` is past the deadline, xp
 * and level advance, the day's counters grow. Shared by the collect intent
 * (immediate) and the resolver (a payout the daily cap deferred), so both
 * pay exactly the same way.
 */
export function deliveryPlan(inp: DeliveryInput): DeliveryPlan {
  const { job, cfg, now, userId } = inp;
  const late = msOf(inp.deliveredAt) > msOf(job.deadline_at);
  const counted = inp.assignments.filter((a) => a.job_id === job.id && (a.state === 'collected' || a.id === inp.collectingId));
  const qualityFactor = counted.length ? Math.min(...counted.map((a) => cfg.quality[a.quality]?.reputation_factor ?? 1)) : 1;
  const reputation = reputationAfterDelivery(inp.running.reputation, job, late, qualityFactor, cfg);
  const xp = inp.running.xp + xpForJob(job.qty, cfg);
  const level = Math.max(inp.running.level, levelForXp(xp, cfg));
  const stats: FarmStats = { ...inp.running.stats };
  stats.delivered += 1;
  if (late) { stats.late += 1; stats.streak = 0; } else stats.streak += 1;
  stats.lifetime_coins += job.reward_coins;
  const updates: SimUpdate[] = [{
    table: 'farm_jobs', id: job.id,
    set: { state: 'delivered', delivered_at: inp.deliveredAt, payout_deferred_day: null, updated_at: now },
    guardStateIn: ACTIVE_JOB_STATES,
  }];
  const ledgerId = eventLedgerId('payout', job.id);
  const ledgerRow: LedgerInsert | null = job.reward_coins > 0
    ? {
        id: ledgerId, userId, kind: 'job_payout', amount: job.reward_coins, refType: 'job', refId: job.id,
        idempotencyKey: systemLedgerKey(ledgerId), note: late ? 'job delivered late' : 'job delivered', createdAt: now,
      }
    : null;
  const events: EventInsert[] = [];
  if (level > inp.running.level) {
    events.push({ id: `fev_${userId}_level_${level}`.slice(0, 120), user_id: userId, kind: 'level_up', payload: { level, xp }, created_at: now });
  }
  return {
    updates,
    ledgerRow,
    events,
    daily: { day: baghdadDayOf(now), coins: job.reward_coins, jobs: 1 },
    running: { reputation, xp, level, stats },
    summary: {
      job_id: job.id, reward_coins: job.reward_coins, late,
      reputation_delta_bp: reputation - inp.running.reputation, reputation_bp: reputation,
      xp_gained: xp - inp.running.xp, level, level_up: level > inp.running.level,
    },
  };
}

export function parseColors(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function resolve(state: FarmState, now: string, cfg: FarmConfig, offerSeed: string | null): SimResult {
  const t = msOf(now);
  const userId = state.profile.user_id;
  const updates: SimUpdate[] = [];
  const ledgerRows: LedgerInsert[] = [];
  const events: EventInsert[] = [];
  const finishedAssignments: string[] = [];
  const readyJobs: string[] = [];
  const lateJobs: string[] = [];
  const cancelledJobs: string[] = [];
  const expiredJobs: string[] = [];
  const paidJobs: string[] = [];
  const dailyIncrements: DailyIncrement[] = [];
  let balance = state.balance;
  let reputation = state.profile.reputation_bp;
  let xp = state.profile.xp;
  let level = state.profile.level;
  let stats = parseStats(state.profile.stats_json);
  const statsBefore = JSON.stringify(stats);

  const printers = new Map(state.printers.map((p) => [p.id, { ...p }]));
  const jobs = new Map(state.jobs.map((j) => [j.id, { ...j }]));
  const jobStateSet = new Map<string, FarmJobRow['state']>();
  const assignmentStates = new Map(state.assignments.map((a) => [a.id, a.state]));

  const event = (id: string, kind: FarmEventKind, payload: Record<string, unknown>) =>
    events.push({ id: id.slice(0, 120), user_id: userId, kind, payload, created_at: now });

  const debit = (id: string, kind: LedgerInsert['kind'], coins: number, refType: string, refId: string, note: string) => {
    // A debit the wallet cannot cover is clamped, never refused: resolution
    // must always be able to land, and a stuck farm is worse than a free
    // kilowatt-hour. What was waived is visible in the note.
    const amount = Math.min(Math.max(0, Math.round(coins)), balance);
    if (amount <= 0) return;
    ledgerRows.push({ id, userId, kind, amount: -amount, refType, refId, idempotencyKey: systemLedgerKey(id), note, createdAt: now });
    balance -= amount;
  };

  // ---- 1. prints whose time has come ------------------------------------
  const finished = state.assignments
    .filter((a) => a.state === 'printing' && a.ends_at && msOf(a.ends_at) <= t)
    .sort((a, b) => msOf(a.ends_at!) - msOf(b.ends_at!));
  for (const a of finished) {
    const printer = printers.get(a.printer_id);
    const model = printer ? printerModel(cfg, printer.model_key) : null;
    const job = jobs.get(a.job_id);
    const failed = roll(a.outcome_seed, 'outcome') < a.failure_p;
    const colors = job ? parseColors(job.colors_json).length : 1;
    finishedAssignments.push(a.id);
    let secondsElapsed = a.seconds;
    let healthHit = 0;
    let breaks = false;

    if (!failed) {
      updates.push({ table: 'farm_assignments', id: a.id, set: { state: 'done', updated_at: now }, guardPrintingAssignment: a.id });
      assignmentStates.set(a.id, 'done');
      stats.prints += a.qty;
      stats.parts += a.qty;
      event(`fev_${a.id}_done`, 'print_done', {
        assignment_id: a.id, job_id: a.job_id, printer_id: a.printer_id, qty: a.qty,
        product_key: job?.product_key ?? null, seconds: a.seconds,
      });
      if (job) {
        const doneQty = state.assignments
          .filter((x) => x.job_id === job.id)
          .reduce((s, x) => s + ((assignmentStates.get(x.id) === 'done' || assignmentStates.get(x.id) === 'collected') ? x.qty : 0), 0);
        const current = jobStateSet.get(job.id) ?? job.state;
        // A job already `late` keeps that overlay (it stays deliverable with
        // the penalty) but is every bit as ready: same event, same list. The
        // event's `late` is judged on the deadline itself, not only on the
        // stored state: when the print ends and the deadline passes in the
        // same resolution (step 5 runs after this step) the sheet must still
        // say late — the payout will.
        if (doneQty >= job.qty && (current === 'accepted' || current === 'printing' || current === 'late')) {
          readyJobs.push(job.id);
          if (current !== 'late') {
            jobStateSet.set(job.id, 'ready');
            updates.push({ table: 'farm_jobs', id: job.id, set: { state: 'ready', updated_at: now }, guardPrintingAssignment: a.id });
          }
          const lateNow = current === 'late' || msOf(job.deadline_at) <= t;
          event(`fev_${job.id}_ready`, 'job_ready', { job_id: job.id, product_key: job.product_key, qty: job.qty, reward_coins: job.reward_coins, late: lateNow });
        }
      }
    } else {
      const kind = pickFailureKind(cfg, roll(a.outcome_seed, 'kind'), colors > 1);
      const costs = failureCosts(kind, cfg, a.grams, a.seconds);
      secondsElapsed = costs.secondsElapsed;
      healthHit = costs.healthHit;
      breaks = costs.breaks;
      updates.push({
        table: 'farm_assignments', id: a.id,
        set: { state: 'failed', failure_kind: kind, updated_at: now },
        guardPrintingAssignment: a.id,
      });
      assignmentStates.set(a.id, 'failed');
      if (costs.gramsReturned > 0) {
        updates.push({ table: 'farm_spools', id: a.spool_id, set: {}, inc: { grams_left: costs.gramsReturned }, guardPrintingAssignment: a.id });
      }
      stats.failures += 1;
      reputation = clampReputation(reputation - cfg.progression.failure_reputation_bp, cfg);
      event(`fev_${a.id}_failed`, 'print_failed', {
        assignment_id: a.id, job_id: a.job_id, printer_id: a.printer_id, qty: a.qty, kind,
        grams_lost: costs.gramsLost, grams_returned: costs.gramsReturned, product_key: job?.product_key ?? null,
      });
    }

    if (printer) {
      const hours = gameHours(secondsElapsed);
      const wear = (model?.wear_per_hour ?? 0) * hours;
      const health = Math.max(0, Math.min(100, Math.round((printer.health - wear - healthHit) * 100) / 100));
      const broken = printer.state === 'broken' || breaks || health <= 0;
      const set: Record<string, string | number | null> = {
        state: broken ? 'broken' : 'done',
        health,
        updated_at: now,
      };
      const inc: Record<string, number> = { hours: Math.round(hours * 100) };
      if (failed) inc.failures = 1;
      else inc.prints = a.qty;
      updates.push({ table: 'farm_printers', id: printer.id, set, inc, guardPrintingAssignment: a.id });
      printer.health = health;
      printer.state = broken ? 'broken' : 'done';
      if (broken && !(state.printers.find((p) => p.id === printer.id)?.state === 'broken')) {
        event(`fev_${a.id}_broken`, 'printer_broken', { printer_id: printer.id, model_key: printer.model_key, assignment_id: a.id });
      }
      // Electricity for the hours the machine actually ran.
      if (model) {
        const kwh = (model.watts / 1000) * hours;
        const coins = Math.round(kwh * cfg.economy.energy.coins_per_kwh);
        if (coins > 0) debit(eventLedgerId('energy', a.id), 'electricity', coins, 'assignment', a.id, `electricity ${model.watts}W x ${hours.toFixed(2)}h`);
      }
    }
  }

  // ---- 2. services that finished ------------------------------------------
  for (const p of printers.values()) {
    if (p.state === 'maintenance' && p.state_until && msOf(p.state_until) <= t) {
      event(`fev_${p.id}_svc_${p.state_until}`, 'maintenance_done', { printer_id: p.id, model_key: p.model_key, health: p.health });
      // A queue that waited through the service starts now.
      const next = state.assignments
        .filter((a) => a.printer_id === p.id && (assignmentStates.get(a.id) ?? a.state) === 'queued')
        .sort((a, b) => a.position - b.position)[0];
      const nextJob = next ? jobs.get(next.job_id) : undefined;
      if (next && nextJob) {
        const start = startStatements(state, cfg, p, next, nextJob, now);
        updates.push(...start);
        assignmentStates.set(next.id, 'printing');
        p.state = 'printing';
        if ((jobStateSet.get(nextJob.id) ?? nextJob.state) === 'accepted') jobStateSet.set(nextJob.id, 'printing');
      } else {
        updates.push({ table: 'farm_printers', id: p.id, set: { state: 'idle', state_until: null, updated_at: now } });
        p.state = 'idle';
      }
    }
  }

  // ---- 3. payouts the daily cap held over to a later day -------------------
  // The work was handed over on `payout_deferred_day`; on the first read of a
  // later Baghdad day the job is paid under THAT day's caps, oldest first.
  // What still does not fit stays deferred and is retried on the next read.
  const today = baghdadDayOf(now);
  let dailyToday: Pick<FarmDailyRow, 'jobs_delivered' | 'coins_earned'> =
    state.daily && state.daily.day === today ? { ...state.daily } : { jobs_delivered: 0, coins_earned: 0 };
  const deferred = [...jobs.values()]
    .filter((j) => isPayoutDeferred(j) && j.payout_deferred_day! < today && ACTIVE_JOB_STATES.includes(jobStateSet.get(j.id) ?? j.state))
    .sort((a, b) => (a.delivered_at ?? '').localeCompare(b.delivered_at ?? '') || a.id.localeCompare(b.id));
  for (const j of deferred) {
    if (!dailyCapAllows(dailyToday, j.reward_coins, cfg)) continue;
    const plan = deliveryPlan({
      userId, job: j, assignments: state.assignments, deliveredAt: j.delivered_at ?? now, now,
      running: { reputation, xp, level, stats }, cfg,
    });
    updates.push(...plan.updates);
    if (plan.ledgerRow) { ledgerRows.push(plan.ledgerRow); balance += plan.ledgerRow.amount; }
    events.push(...plan.events);
    dailyIncrements.push(plan.daily);
    dailyToday = { jobs_delivered: dailyToday.jobs_delivered + 1, coins_earned: dailyToday.coins_earned + j.reward_coins };
    ({ reputation, xp, level, stats } = plan.running);
    jobStateSet.set(j.id, 'delivered');
    paidJobs.push(j.id);
  }

  // ---- 4. offers that lapsed ---------------------------------------------
  for (const j of jobs.values()) {
    if (j.state === 'offered' && msOf(j.offer_expires_at) <= t) {
      updates.push({ table: 'farm_jobs', id: j.id, set: { state: 'expired', updated_at: now } });
      jobStateSet.set(j.id, 'expired');
      expiredJobs.push(j.id);
    }
  }

  // ---- 5. deadlines: late, then cancelled by the customer -----------------
  const graceMs = realMinutesToMs(cfg.jobs.late_grace_minutes);
  for (const j of jobs.values()) {
    const current = jobStateSet.get(j.id) ?? j.state;
    if (!ACTIVE_JOB_STATES.includes(current)) continue;
    // Handed over, waiting only for the cap: the customer has their parts.
    if (isPayoutDeferred(j)) continue;
    const deadline = msOf(j.deadline_at);
    if (deadline + graceMs <= t) {
      updates.push({ table: 'farm_jobs', id: j.id, set: { state: 'cancelled', updated_at: now } });
      jobStateSet.set(j.id, 'cancelled');
      cancelledJobs.push(j.id);
      reputation = clampReputation(reputation - j.cancel_penalty_bp, cfg);
      stats.cancelled += 1;
      if (j.cancel_penalty_coins > 0) {
        debit(eventLedgerId('cancelpen', j.id), 'penalty', j.cancel_penalty_coins, 'job', j.id, 'customer cancelled after the deadline');
      }
      // Queued batches never start; their grams go back on the spool.
      for (const a of state.assignments) {
        if (a.job_id !== j.id || (assignmentStates.get(a.id) ?? a.state) !== 'queued') continue;
        updates.push({ table: 'farm_assignments', id: a.id, set: { state: 'cancelled', updated_at: now }, guardQueuedAssignment: a.id });
        updates.push({ table: 'farm_spools', id: a.spool_id, set: {}, inc: { grams_left: a.grams }, guardQueuedAssignment: a.id });
        assignmentStates.set(a.id, 'cancelled');
      }
      event(`fev_${j.id}_cancelled`, 'job_cancelled_by_customer', {
        job_id: j.id, product_key: j.product_key, qty: j.qty, reputation_penalty_bp: j.cancel_penalty_bp,
        coins_penalty: Math.min(j.cancel_penalty_coins, state.balance),
      });
    } else if (deadline <= t && current !== 'late') {
      updates.push({ table: 'farm_jobs', id: j.id, set: { state: 'late', updated_at: now } });
      jobStateSet.set(j.id, 'late');
      lateJobs.push(j.id);
      event(`fev_${j.id}_late`, 'job_late', { job_id: j.id, product_key: j.product_key, late_penalty_bp: j.late_penalty_bp, deadline_at: j.deadline_at });
    }
  }

  // ---- 6. fresh offers when the board is short and the interval passed ----
  let newOffers: JobInsert[] = [];
  const profileSet: Record<string, string | number | null> = {};
  const offeredCount = [...jobs.values()].filter((j) => (jobStateSet.get(j.id) ?? j.state) === 'offered').length;
  const lastOffer = state.profile.last_offer_at;
  const due = !lastOffer || msOf(lastOffer) + realMinutesToMs(cfg.time.offer_refresh_minutes) <= t;
  if (offerSeed && due && offeredCount < cfg.jobs.offers_visible) {
    newOffers = generateOffers({
      userId,
      profile: { level: state.profile.level, reputation_bp: reputation },
      capacity: ownedCapacity([...printers.values()], cfg),
      now,
      cfg,
      seed: offerSeed,
      count: cfg.jobs.offers_visible - offeredCount,
    });
    if (newOffers.length) {
      profileSet.last_offer_at = now;
      profileSet.offer_refresh_index = state.profile.offer_refresh_index + 1;
    }
  }

  // ---- 7. the profile row -----------------------------------------------
  if (reputation !== state.profile.reputation_bp) profileSet.reputation_bp = reputation;
  if (xp !== state.profile.xp) profileSet.xp = xp;
  if (level !== state.profile.level) profileSet.level = level;
  if (JSON.stringify(stats) !== statsBefore) profileSet.stats_json = JSON.stringify(stats);
  if (Object.keys(profileSet).length) {
    profileSet.updated_at = now;
    updates.push({ table: 'farm_profiles', id: userId, set: profileSet });
  }

  return {
    updates, ledgerRows, events, newOffers, finishedAssignments, readyJobs, lateJobs, cancelledJobs, expiredJobs,
    paidJobs, dailyIncrements,
    balance, reputationBp: reputation, stats,
    changed: updates.length > 0 || ledgerRows.length > 0 || events.length > 0 || newOffers.length > 0,
  };
}
