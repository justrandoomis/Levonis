/**
 * `LedgerEntrypoint` — the money contract (`01-TARGET.md` §6.1) over the
 * wallet engine that already exists in `worker/lib/walletOps.ts`. This is what
 * `levonis-ledger` will be in Phase 8; from Phase 6 every caller of money
 * declares `LEDGER_CORE` pointing here.
 *
 * IT ADDS NO MONEY PATH. Every method below delegates to the exported function
 * the site routes already call, so a command over a binding and a command from
 * a route are the same code, the same guards, the same idempotency and the
 * same audit trail — which is the only way the extraction can be a move rather
 * than a rewrite. Nothing here writes SQL of its own.
 *
 * WHAT IS DELIBERATELY ABSENT (and named in CONTRACT.md): `credit`, `debit`,
 * `refund`, the points commands and `decideDeposit`. Each of those is a real
 * command with its own guards, and inventing a second implementation of them
 * here — beside the ones in the routes — is exactly the duplication Phase 0
 * spent its time removing. They arrive with the slices that move their
 * callers (6a/6b/7.2 for the refunds, 4b-ii for the nonce-verified deposit
 * decision, 8.0 for the rest).
 */
import type { Applied, Balances, HoldResult, LedgerApi, MoneyCmd, ReconcileReport, Refused } from '@levonis/contracts/rpc/ledger';
import { isWellFormedEventKey } from '@levonis/contracts/rpc/ledger';
import type { RpcCtx } from '@levonis/contracts/rpc/common';
import { CoreEntrypoint } from './base';
import {
  commitHold,
  createPurchaseHold,
  getAvailableBalances,
  getWalletBreakdown,
  releaseHold,
  reconcileWallets,
  type HoldFailure,
} from '../lib/walletOps';

/** The engine's refusal, in the contract's words. */
const REFUSAL: Record<HoldFailure, Refused['reason']> = {
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INSUFFICIENT_AVAILABLE: 'INSUFFICIENT',
  DUPLICATE_EVENT: 'STATE_CONFLICT',
  EVENT_KEY_REUSED: 'EVENT_KEY_REUSED',
  MISSING_EVENT_KEY: 'FORBIDDEN',
  STATE_CONFLICT: 'STATE_CONFLICT',
  NOT_FOUND: 'STATE_CONFLICT',
};

export class LedgerEntrypoint extends CoreEntrypoint {
  /**
   * Reserve money for a purchase. The `eventKey` is REQUIRED and must be
   * server-minted (`<service>:<aggregate>:<id>:<leg>` or one of the legacy
   * deterministic ids): a client's idempotency string is not a money key, and
   * a command without one is refused before the engine is touched.
   */
  async hold(cmd: MoneyCmd & { kind: string; sagaId?: string }, ctx?: RpcCtx): Promise<HoldResult> {
    await this.assertHop('hold', [cmd], ctx);
    const env = this.ready();
    if (!isWellFormedEventKey(cmd.eventKey)) return { ok: false, reason: 'FORBIDDEN', detail: 'a money command needs a server-minted eventKey' };
    if (cmd.currency !== 'USD') return { ok: false, reason: 'INVALID_AMOUNT', detail: 'only USD holds exist today' };
    if (cmd.kind !== 'purchase') return { ok: false, reason: 'FORBIDDEN', detail: 'withdrawal holds are placed by requestWithdrawal' };
    const res = await createPurchaseHold(env.DB, {
      userId: cmd.userId,
      amountCents: cmd.amount,
      eventKey: cmd.eventKey,
      refType: cmd.ref.type,
      refId: cmd.ref.id,
      note: cmd.reason,
    });
    if (!res.ok) return { ok: false, reason: REFUSAL[res.reason] };
    return res.replayed ? { ok: true, holdId: res.holdId, applied: false, replayed: true } : { ok: true, holdId: res.holdId, applied: true };
  }

  /**
   * Settle a hold: the reserved money leaves the balance exactly once, as an
   * approved ledger debit posted in the SAME transaction as the state flip
   * (`commitHoldStatements`, the Phase-0 settlement rule).
   */
  async commitHoldAndDebit(cmd: { holdId: string; eventKey: string; txId?: string; note: string; sagaId?: string }, ctx?: RpcCtx): Promise<Applied | Refused> {
    await this.assertHop('commitHoldAndDebit', [cmd], ctx);
    const env = this.ready();
    if (!isWellFormedEventKey(cmd.eventKey)) return { ok: false, reason: 'FORBIDDEN', detail: 'a money command needs a server-minted eventKey' };
    const res = await commitHold(env.DB, { holdId: cmd.holdId, note: cmd.note, ref: cmd.eventKey });
    if (!res.ok) return { ok: false, reason: REFUSAL[res.reason] };
    const txIds = res.txId ? [res.txId] : [];
    return res.replayed ? { ok: true, applied: false, replayed: true, txIds } : { ok: true, applied: true, txIds };
  }

  /** Return reserved money to the available balance — exactly once. */
  async releaseHold(cmd: { holdId: string; eventKey: string; sagaId?: string }, ctx?: RpcCtx): Promise<Applied | Refused> {
    await this.assertHop('releaseHold', [cmd], ctx);
    const env = this.ready();
    const res = await releaseHold(env.DB, { holdId: cmd.holdId, reason: cmd.eventKey });
    if (!res.ok) return { ok: false, reason: REFUSAL[res.reason] };
    return res.replayed ? { ok: true, applied: false, replayed: true, txIds: [] } : { ok: true, applied: true, txIds: [] };
  }

  /** Settled, held and available — the three numbers, never one blended figure. */
  async getBalances(userId: string, ctx?: RpcCtx): Promise<Balances> {
    await this.assertHop('getBalances', [userId], ctx);
    const env = this.ready();
    const [breakdown, available] = await Promise.all([getWalletBreakdown(env.DB, userId), getAvailableBalances(env, userId)]);
    return {
      usd_cents: { settled: breakdown.usd_cents_settled, held: breakdown.usd_cents_held, available: breakdown.usd_cents_available },
      points: {
        settled: breakdown.points_settled,
        held: Math.max(0, breakdown.points_settled - available.points_available),
        available: available.points_available,
      },
    };
  }

  /** The wallet page's own numbers, including what is pending in each direction. */
  async getBreakdown(userId: string, ctx?: RpcCtx): Promise<{ rows: Array<Record<string, unknown>> }> {
    await this.assertHop('getBreakdown', [userId], ctx);
    const env = this.ready();
    return { rows: [await getWalletBreakdown(env.DB, userId) as unknown as Record<string, unknown>] };
  }

  /**
   * READS the ledger, the holds and the withdrawals and reports what does not
   * add up. It never releases a hold, never posts a row and never "fixes" a
   * balance: an anomaly is escalated to a person.
   */
  async reconcile(ctx?: RpcCtx): Promise<ReconcileReport> {
    await this.assertHop('reconcile', [], ctx);
    const env = this.ready();
    const report = await reconcileWallets(env);
    return {
      run_id: report.ran_at,
      checked_users: report.checked_users,
      anomalies: report.anomalies.map((a) => ({
        user_id: a.user_id,
        currency: 'USD' as const,
        sum: report.totals.settled_usd_cents,
        cached: null,
        held_active: report.totals.active_holds_usd_cents,
        kind: a.kind,
      })),
    };
  }
}

/** Compile-time proof against `packages/contracts/src/rpc/ledger.ts`. */
type ImplementedLedger = Pick<LedgerApi, 'commitHoldAndDebit' | 'releaseHold' | 'getBalances' | 'getBreakdown' | 'reconcile' | 'health'>;
export const _ledgerContract: (e: LedgerEntrypoint) => ImplementedLedger = (e) => e;
