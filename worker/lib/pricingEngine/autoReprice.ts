/**
 * FX-5 — AUTOMATIC REPRICING WHEN A CONFIRMED RATE CHANGES (FX programme plan
 * §7; USD design §6.5; owner decisions 10 and 11).
 *
 * WHEN. After the FX scheduler or an owner act commits a new effective rate
 * (USD/IQD, EUR/USD, CNY/USD), after the owner changes a central shipping
 * rate, and on every quarter-hour tick (the sweep) until nothing is stale.
 * Below the dead band nothing is committed, so nothing is stale and nothing is
 * written or purged (decision 10); a candidate held for review
 * (REVIEW_REQUIRED) or rejected never becomes the effective rate, so it
 * reprices nothing until the owner approves it (decision 11) — and the
 * approval commits it, which makes the products stale and reprices them.
 *
 * WHAT. Exactly the stale list (engineWrite.staleReasons): an ENGINE product
 * whose stored price was computed at a confirmed rate that has changed since.
 * Only `product_pricing_state.mode = 'engine'` rows are ever read for writing:
 * a manual product is never touched.
 *
 * HOW. The owner's own writer path, never a second price computation:
 * evaluateEngineWrite (E1 at the LAST CONFIRMED central rates of the versioned
 * reader → planWrites → verifyPlan against the cart's own resolver) →
 * engineWriteStatements → ONE atomic batch per product, fenced on its pricing
 * state, the engine's config version and pause, its price image and the very
 * rates it was priced at, idempotent (`auto:<product>:<evaluation hash>`), and
 * audited (values in pricing_audit `reprice_auto`, ids and codes only in
 * audit_log). A batch that misses its fence (the owner saved, a rate moved)
 * leaves the product stale for the next tick, which prices it afresh.
 *
 * DEFICIT FIRST. Every due product is evaluated from bulk reads (a constant
 * number of statements, the price images read BEFORE the documents), then
 * written in order of how far today's price lies below the new replacement
 * cost + minimum profit — the writer's own figures — largest first.
 *
 * THE BUDGET. Every read and every statement of every batch is charged to the
 * invocation's statement budget (fx/budget.ts: 600 for the six-hour run and an
 * owner's request, 200 for the quarter-hour sweep). A batch the budget cannot
 * cover is not sent; it and every product after it stay stale for a later
 * tick, in the same order.
 *
 * A PRODUCT THAT CANNOT BE REPRICED (incomplete, a shape the price fields
 * cannot carry, a resolver mismatch, a database refusal) keeps its prices,
 * stays on the stale list with `product_pricing_state.reprice_blocked_code`
 * (a code, never a figure), rings the owner's bell once, and never blocks the
 * others. It is tried again when a rate changes again, when the owner saves
 * it (the writer clears the code), or after 24 hours.
 *
 * THE PURGE. One targeted purge after the run: the pages and APIs of the
 * products whose customer price moved (edgePolicy.purgeCatalogueFromJob, the
 * same seam the FX run uses). Nothing moved → nothing purged.
 *
 * NEVER THROWS. Never in the customer path: imported by the FX side's door
 * (fx/reprice.ts), the owner's rates read model and the owner's pricing routes.
 */
import type { Env } from '../types';
import { SHIPPING_PROFILES } from '@levonis/pricing/skuChannel';
import { auditStatements } from '../audit';
import { fence } from '../operations';
import { purgeCatalogueFromJob } from '../edgePolicy';
import { engineDbRefusalCode } from '../pricingDbRefusals';
import { isMissingTable } from '../fx/pairs';
import { loadPreviewContext, loadProducts } from './load';
import { loadProductsPricing, pricingAuditStatement } from './store';
import { loadPricingRates, type PricingRates } from './rates';
import {
  engineWriteStatements,
  evaluateEngineWrite,
  loadEngineControl,
  loadStoredSkuCosts,
  priceImagesEach,
  priceImagesOf,
  staleReasons,
  type EngineEvaluation,
  type StoredSkuCost,
} from './engineWrite';

/** The statement budget this module charges (fx/budget.ts `StatementBudget` is one). */
export interface RepriceBudget {
  readonly used: number;
  remaining(): number;
  canSpend(n: number): boolean;
  spend(n: number): boolean;
}

/** What started a run: the FX scheduler, an owner's rate act, an owner's shipping rate, the quarter-hour sweep. */
export type AutoRepriceTrigger = 'fx' | 'owner_rate' | 'shipping' | 'sweep';

/** The audit source of every automatic write. */
export const AUTO_REPRICE_SOURCE = 'fx_auto';
/** A blocked product is tried again after this long even when nothing else moved. */
export const BLOCK_RETRY_MS = 24 * 3_600_000;
/** The owner writer's own cap on one product's batch. */
export const AUTO_REPRICE_STATEMENT_CAP = 200;
/**
 * loadProducts reads in chunks of 50: one product read and nine relation reads per chunk (the ninth: the SKU rung,
 * FX-7). Exported: the owner's rate preview (ratePreview.ts) charges the same reads, so one count serves both.
 */
export const PRODUCT_CHUNK = 50;
export const READS_PER_CHUNK = 10;
/** The system actor of an automatic write the cron starts. */
export const SYSTEM_ACTOR = 'system:fx';

/** One engine product as the run reads it (codes, counters and times — no figure). */
export interface EngineStateRow {
  product_id: string;
  slug: string;
  inputs_seq: number;
  write_seq: number;
  reprice_blocked_code: string | null;
  reprice_blocked_at: string | null;
  /** The newest change of any central rate (fx or shipping) — a blocked product is retried after it. */
  rates_at: string | null;
}

const ENGINE_STATES_SQL = `SELECT s.product_id, p.slug, s.inputs_seq, s.write_seq, s.reprice_blocked_code, s.reprice_blocked_at,
       MAX(COALESCE((SELECT MAX(updated_at) FROM pricing_fx_rates), ''), COALESCE((SELECT MAX(updated_at) FROM pricing_shipping_rates), '')) AS rates_at
  FROM product_pricing_state s JOIN products p ON p.id = s.product_id
 WHERE s.mode = 'engine' AND COALESCE(p.composition, '') = ''
 ORDER BY s.product_id`;

/** Every engine-priced product (one indexed read: idx_product_pricing_state_engine). Throws on a database without 0181. */
export async function loadEngineStates(db: D1Database): Promise<EngineStateRow[]> {
  const { results } = await db.prepare(ENGINE_STATES_SQL).all<EngineStateRow>();
  return (results ?? []).map((r) => ({
    product_id: String(r.product_id),
    slug: String(r.slug ?? ''),
    inputs_seq: Number(r.inputs_seq ?? 0),
    write_seq: Number(r.write_seq ?? 0),
    reprice_blocked_code: r.reprice_blocked_code ?? null,
    reprice_blocked_at: r.reprice_blocked_at ?? null,
    rates_at: r.rates_at ? String(r.rates_at) : null,
  }));
}

export interface StaleEngineProduct {
  state: EngineStateRow;
  /** What moved since the stored price: a supplier currency (USD / EUR / CNY) or a shipping profile. */
  reasons: string[];
  rows: StoredSkuCost[];
}

/** The stale list: engine products whose stored figures were computed at a confirmed rate that has changed. */
export function staleEngineProducts(states: readonly EngineStateRow[], costs: readonly StoredSkuCost[], rates: PricingRates): StaleEngineProduct[] {
  const out: StaleEngineProduct[] = [];
  for (const state of states) {
    const rows = costs.filter((c) => c.product_id === state.product_id);
    const reasons = staleReasons(rows, rates);
    if (reasons.length) out.push({ state, reasons, rows });
  }
  return out;
}

/** A blocked product waits 24 hours, unless a central rate moved after it was blocked (or the owner saved it, which clears the code). */
export function blockedAndWaiting(s: Pick<EngineStateRow, 'reprice_blocked_code' | 'reprice_blocked_at' | 'rates_at'>, now: Date): boolean {
  if (!s.reprice_blocked_code || !s.reprice_blocked_at) return false;
  const at = Date.parse(s.reprice_blocked_at);
  if (!Number.isFinite(at) || now.getTime() - at >= BLOCK_RETRY_MS) return false;
  if (s.rates_at && s.rates_at > s.reprice_blocked_at) return false;
  return true;
}

/**
 * How far today's price lies below the new floor (the new replacement cost +
 * minimum profit, the writer's own figures), the worst model × channel —
 * whole dinars; negative when every price is already above it. Ordering only.
 */
export function deficitOf(ev: Pick<EngineEvaluation, 'rows'>): number {
  let worst = Number.NEGATIVE_INFINITY;
  for (const r of ev.rows) worst = Math.max(worst, r.replacement_cost_iqd + r.target_profit_iqd - (r.old_iqd ?? 0));
  return Number.isFinite(worst) ? worst : 0;
}

/**
 * The code a blocked product carries (the CHECK: [A-Z0-9_], at most 40): a
 * resolver mismatch first, then the most specific reason (PRICE_INVALID only
 * says some channel has no price; the code beside it says why).
 */
export function blockCodeOf(codes: readonly string[]): string {
  const pick = codes.includes('RESOLVER_MISMATCH') ? 'RESOLVER_MISMATCH' : (codes.find((c) => c !== 'PRICE_INVALID') ?? codes[0] ?? 'REPRICE_BLOCKED');
  return /^[A-Z0-9_]{1,40}$/.test(pick) ? pick : 'REPRICE_BLOCKED';
}

/** No customer-visible price moves: every channel's price, PRO and PRIME stay, and no route fee is folded in. */
export function pricesUnchanged(ev: Pick<EngineEvaluation, 'rows'>): boolean {
  return ev.rows.every(
    (r) => r.old_iqd === r.new_iqd && r.pro_before_iqd === r.pro_after_iqd && r.prime_before_iqd === r.prime_after_iqd && !r.route_fee_removed
  );
}

const SHIPPING = new Set<string>(SHIPPING_PROFILES);

/** `engine_fx` when only exchange rates moved; a shipping rate is the owner's cost change (decision 6: it counts). */
export const priceSourceOf = (reasons: readonly string[]): 'engine_fx' | 'engine_owner' => (reasons.some((r) => SHIPPING.has(r)) ? 'engine_owner' : 'engine_fx');

/** One product the bell rings for, with its event key (once per product and write). */
export interface BlockedNotice {
  product_id: string;
  key: string;
}

export interface AutoRepriceOptions {
  trigger: AutoRepriceTrigger;
  budget: RepriceBudget;
  /** The owner whose act started the run; null for the cron (audited as the system). */
  actorId?: string | null;
  now?: Date;
  /** The request's own origin, purged beside the shop's apex and www (an owner act). */
  origin?: string;
  /** Rings the owner's bell for newly blocked products (fx/reprice.ts); it may spend one statement plus one per product. */
  onBlocked?: (items: BlockedNotice[]) => Promise<void>;
}

export interface AutoRepriceReport {
  trigger: AutoRepriceTrigger;
  skipped: null | 'NOT_INSTALLED' | 'PAUSED' | 'DERIVED_STALE' | 'NOTHING_STALE' | 'BUDGET' | 'ERROR';
  /** Stale engine products found at the start of the run. */
  stale: number;
  /** Products written (their stored figures are current now). */
  repriced: string[];
  /** Of those, the ones whose customer price moved (purged). */
  changed: string[];
  /** Products that could not be repriced: they keep their prices and stay listed. */
  blocked: Array<{ product_id: string; code: string }>;
  /** A batch missed its fence (the owner or a rate moved meanwhile): stale for the next tick. */
  conflicts: string[];
  /** Left for a later tick by the statement budget, in deficit order. */
  deferred: string[];
  /** Statements this run charged to the budget. */
  statements: number;
}

const fenceMissed = (e: unknown): boolean => /CHECK constraint failed:\s*ok\s*=\s*1\b/i.test(e instanceof Error ? e.message : String(e));

/** THE RUN (see the file header). Never throws. */
export async function repriceStaleEngineProducts(env: Env, opts: AutoRepriceOptions): Promise<AutoRepriceReport> {
  const db = env.DB;
  const budget = opts.budget;
  const start = budget.used;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const actor = opts.actorId ?? SYSTEM_ACTOR;
  const auditActor = opts.actorId ?? null;
  const report: AutoRepriceReport = { trigger: opts.trigger, skipped: null, stale: 0, repriced: [], changed: [], blocked: [], conflicts: [], deferred: [], statements: 0 };
  const finish = (skipped: AutoRepriceReport['skipped'] = null): AutoRepriceReport => ({ ...report, skipped, statements: budget.used - start });

  try {
    // 1. The engine products and what their stored prices were computed from.
    if (!budget.spend(1)) return finish('BUDGET');
    let states: EngineStateRow[];
    try {
      states = await loadEngineStates(db);
    } catch (e) {
      if (isMissingTable(e)) return finish('NOT_INSTALLED');
      throw e;
    }
    if (!states.length) return finish('NOTHING_STALE');
    if (!budget.spend(3)) return finish('BUDGET');
    const [costs, rates] = await Promise.all([loadStoredSkuCosts(db, states.map((s) => s.product_id)), loadPricingRates(db)]);
    if (!rates) return finish('NOT_INSTALLED');
    // A derived rate out of step with its pairs prices nothing (every writer refuses FX_DERIVED_STALE).
    if (rates.derived_stale) return finish('DERIVED_STALE');
    const stale = staleEngineProducts(states, costs, rates);
    report.stale = stale.length;
    const due = stale.filter((p) => !blockedAndWaiting(p.state, now));
    if (!due.length) return finish('NOTHING_STALE');

    // 2. The candidates, in a constant number of reads: the control row, the price images FIRST (every
    //    write is fenced on them), then the documents, the stores and the guest pricing context.
    const ids = due.map((p) => p.state.product_id);
    if (!budget.spend(1 + 1 + READS_PER_CHUNK * Math.ceil(ids.length / PRODUCT_CHUNK) + 4 + 1)) return finish('BUDGET');
    const control = await loadEngineControl(db);
    if (control.paused) return finish('PAUSED');
    let images: Map<string, string>;
    try {
      images = await priceImagesOf(db, ids);
    } catch (e) {
      // An engine that refuses the correlated one-statement form: one image statement per product.
      if (isMissingTable(e)) throw e;
      if (!budget.spend(ids.length)) return finish('BUDGET');
      images = await priceImagesEach(db, ids);
    }
    const [loaded, stores, ctx] = await Promise.all([loadProducts(db, ids), loadProductsPricing(db, ids), loadPreviewContext(db)]);

    // 3. The writer's own evaluation of each: plan, the exact resolver check, the six figures.
    const ready: Array<{ p: StaleEngineProduct; ev: EngineEvaluation; deficit: number }> = [];
    const failing: Array<{ p: StaleEngineProduct; code: string }> = [];
    for (const p of due) {
      const pid = p.state.product_id;
      const product = loaded.get(pid);
      const stored = stores.get(pid);
      // Deleted, or taken back to manual since the first read: not ours to price.
      if (!product || !stored || stored.state?.mode !== 'engine') continue;
      let ev: EngineEvaluation;
      try {
        ev = await evaluateEngineWrite({
          loaded: product,
          stored,
          ctx,
          rates,
          control,
          inputs: stored.inputs,
          inputWrites: [],
          ruleWrites: [],
          image: images.get(pid) ?? '',
          storedCosts: p.rows,
        });
      } catch (e) {
        // FX-7 gaps: the SKU rung's read failed this time (not a missing table) — a transient error, not
        // a product the owner must fix: no block, no bell; it is still stale and the next tick retries.
        if (product.view?.sku_prices_unread) {
          console.error('auto reprice: SKU prices unreadable, retried next tick:', pid);
          continue;
        }
        console.error('auto reprice: evaluation failed:', pid, e instanceof Error ? e.name : 'unknown');
        failing.push({ p, code: 'REPRICE_BLOCKED' });
        continue;
      }
      if (ev.kind !== 'reprice' || !ev.complete || !ev.hash || !ev.needs_write) {
        failing.push({ p, code: blockCodeOf(ev.codes) });
        continue;
      }
      ready.push({ p, ev, deficit: deficitOf(ev) });
    }
    ready.sort((a, b) => b.deficit - a.deficit || (a.p.state.product_id < b.p.state.product_id ? -1 : a.p.state.product_id > b.p.state.product_id ? 1 : 0));

    // 4. Blocked products first — a code and the bell, a few statements each — so the owner hears at once.
    const notices: BlockedNotice[] = [];
    const block = async (p: StaleEngineProduct, code: string): Promise<void> => {
      const pid = p.state.product_id;
      report.blocked.push({ product_id: pid, code });
      if (p.state.reprice_blocked_code === code) {
        // Already listed with this code: only the 24-hour clock moves (no second bell).
        if (!budget.spend(1)) return;
        await db
          .prepare('UPDATE product_pricing_state SET reprice_blocked_at = ? WHERE product_id = ? AND write_seq = ? AND reprice_blocked_code = ?')
          .bind(nowIso, pid, p.state.write_seq, code)
          .run();
        return;
      }
      const statements = [
        ...fence(db, "EXISTS(SELECT 1 FROM product_pricing_state WHERE product_id = ? AND mode = 'engine' AND write_seq = ?)", [pid, p.state.write_seq]),
        db
          .prepare("UPDATE product_pricing_state SET reprice_blocked_code = ?, reprice_blocked_at = ?, updated_at = ? WHERE product_id = ? AND mode = 'engine' AND write_seq = ?")
          .bind(code, nowIso, nowIso, pid, p.state.write_seq),
        pricingAuditStatement(db, {
          entity: 'sku_price',
          entity_key: pid,
          product_id: pid,
          action: 'reprice_auto',
          summary: { blocked: code, trigger: opts.trigger, reasons: p.reasons },
          actor,
          now: nowIso,
        }),
        ...(await auditStatements(db, auditActor, 'pricing.engine.reprice_blocked', pid, { product_id: pid, code, trigger: opts.trigger, reasons: p.reasons })).statements,
      ];
      // The bell's two statements are reserved with the record.
      if (!budget.canSpend(statements.length + 2)) return;
      budget.spend(statements.length);
      try {
        await db.batch(statements);
        notices.push({ product_id: pid, key: `reprice_blocked:${pid}:${p.state.write_seq}` });
      } catch (e) {
        // The product moved meanwhile (its fence missed): the next tick judges it afresh.
        if (!fenceMissed(e)) console.error('auto reprice: block not recorded:', pid, e instanceof Error ? e.name : 'unknown');
      }
    };
    for (const f of failing) await block(f.p, f.code);

    // 5. Deficit first: one atomic, fenced, idempotent, audited batch per product, while the budget lasts.
    const slugs: string[] = [];
    for (let i = 0; i < ready.length; i++) {
      const { p, ev } = ready[i]!;
      const pid = p.state.product_id;
      const unchanged = pricesUnchanged(ev);
      const statements = await engineWriteStatements(db, ev, [], [], {
        actor,
        auditActor,
        now: nowIso,
        source: AUTO_REPRICE_SOURCE,
        idempotencyKey: `auto:${pid}:${ev.hash}`,
        auto: { priceSource: priceSourceOf(p.reasons), pricesUnchanged: unchanged, trigger: opts.trigger, reasons: p.reasons },
      });
      if (statements.length > AUTO_REPRICE_STATEMENT_CAP) {
        await block(p, 'PRICING_SET_TOO_LARGE');
        continue;
      }
      if (!budget.spend(statements.length)) {
        // Strict order: this product and every one after it wait for a later tick.
        report.deferred.push(...ready.slice(i).map((r) => r.p.state.product_id));
        break;
      }
      try {
        await db.batch(statements);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The same evaluation already written (another run got there first): done.
        if (/UNIQUE constraint failed: pricing_audit\.idempotency_key/i.test(msg)) continue;
        if (fenceMissed(e) || /UNIQUE constraint failed: ops_guards/i.test(msg)) {
          report.conflicts.push(pid);
          continue;
        }
        await block(p, engineDbRefusalCode(e) ?? 'COMMIT_REFUSED');
        continue;
      }
      report.repriced.push(pid);
      if (!unchanged) {
        report.changed.push(pid);
        if (p.state.slug) slugs.push(p.state.slug);
      }
    }

    // 6. The targeted purge (only what moved), the run's record (counts only), the bell.
    if (slugs.length) await purgeCatalogueFromJob(env, slugs, opts.origin ? { origin: opts.origin } : {});
    const worked = report.repriced.length + report.blocked.length + report.conflicts.length + report.deferred.length;
    if (worked > 0 && budget.spend(1)) {
      try {
        await pricingAuditStatement(db, {
          entity: 'run',
          entity_key: 'auto_reprice',
          product_id: null,
          action: 'run_finished',
          summary: {
            trigger: opts.trigger,
            stale: report.stale,
            repriced: report.repriced.length,
            changed: report.changed.length,
            blocked: report.blocked.length,
            conflicts: report.conflicts.length,
            deferred: report.deferred.length,
            remaining: report.stale - report.repriced.length,
          },
          actor,
          now: nowIso,
        }).run();
      } catch (e) {
        console.error('auto reprice: run not recorded:', e instanceof Error ? e.name : 'unknown');
      }
    }
    if (notices.length && opts.onBlocked && budget.spend(1 + notices.length)) await opts.onBlocked(notices);
    return finish();
  } catch (e) {
    console.error('auto reprice: run failed:', e instanceof Error ? e.name : 'unknown');
    return finish('ERROR');
  }
}

// ------------------------------------------------------------ the owner's status line

export interface AutoRepriceLastRun {
  at: string;
  trigger: string;
  repriced: number;
  blocked: number;
  remaining: number;
}

/** «يُعاد التسعير تلقائياً»: counts, the pause, and the last run that had work — never a figure. */
export interface AutoRepriceStatus {
  engine_products: number;
  /** Engine products whose stored price waits for a repricing (the automatic one, or the owner's save). */
  stale: number;
  /** Of every engine product, those an automatic repricing could not reach. */
  blocked: number;
  paused: boolean;
  derived_stale: boolean;
  last_run: AutoRepriceLastRun | null;
}

const count = (v: unknown): number => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

export async function lastAutoRun(db: D1Database): Promise<AutoRepriceLastRun | null> {
  const row = await db
    .prepare("SELECT summary_json, created_at FROM pricing_audit WHERE entity = 'run' AND entity_key = 'auto_reprice' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .first<{ summary_json: string; created_at: string }>();
  if (!row) return null;
  let s: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.summary_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) s = parsed as Record<string, unknown>;
  } catch {
    /* an unreadable summary still says when */
  }
  return {
    at: String(row.created_at),
    trigger: typeof s.trigger === 'string' && /^[a-z_]{1,20}$/.test(s.trigger) ? s.trigger : 'sweep',
    repriced: count(s.repriced),
    blocked: count(s.blocked),
    remaining: count(s.remaining),
  };
}

/** The owner's status; null on a database without the engine (0181) or the rates (0179). */
export async function autoRepriceStatus(db: D1Database, rates?: PricingRates | null): Promise<AutoRepriceStatus | null> {
  try {
    const states = await loadEngineStates(db);
    const [r, costs, control, last] = await Promise.all([
      rates === undefined ? loadPricingRates(db) : Promise.resolve(rates),
      loadStoredSkuCosts(db, states.map((s) => s.product_id)),
      loadEngineControl(db),
      lastAutoRun(db),
    ]);
    if (!r) return null;
    return {
      engine_products: states.length,
      stale: staleEngineProducts(states, costs, r).length,
      blocked: states.filter((s) => s.reprice_blocked_code !== null).length,
      paused: control.paused,
      derived_stale: r.derived_stale,
      last_run: last,
    };
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
}
