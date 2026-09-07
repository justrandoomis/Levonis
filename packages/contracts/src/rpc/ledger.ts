/**
 * The money contract (`01-TARGET.md` §6.1), exposed from the core's
 * `LedgerEntrypoint` from Phase 2 and from `levonis-ledger` from Phase 8.
 * Every command REQUIRES a server-minted `eventKey`.
 */
import type { Actor, HealthReport, RpcCtx } from './common';

export type Currency = 'USD' | 'POINT';

export interface MoneyRef {
  type: string; // 'order' | 'return' | 'price_protection' | 'escrow' | 'membership' | 'review' | 'referral' | 'store_order' | 'deposit' | 'manual'
  id: string;
}

export interface MoneyCmd {
  eventKey: string; // `<service>:<aggregate>:<server id>:<leg>` or a legacy deterministic id (wtx_ord_<id>_usd …)
  userId: string;
  currency: Currency;
  amount: number; // integer: USD cents or points
  ref: MoneyRef;
  reason: string;
  actor: Actor;
  correlationId: string;
}

export type HoldKind = 'purchase' | 'withdrawal' | 'escrow';

export type Applied =
  | { ok: true; applied: true; txIds: string[] }
  | { ok: true; applied: false; replayed: true; txIds: string[] };

export type RefusalReason = 'INSUFFICIENT' | 'EVENT_KEY_REUSED' | 'INVALID_AMOUNT' | 'STATE_CONFLICT' | 'FORBIDDEN';
export type Refused = { ok: false; reason: RefusalReason; detail?: string };

export type HoldResult =
  | { ok: true; holdId: string; applied: boolean; replayed?: true }
  | Refused;

export interface Balances {
  usd_cents: { settled: number; held: number; available: number };
  points: { settled: number; held: number; available: number };
}

/** What Notifications forwards from a Telegram `callback_query` (`01-TARGET.md` §6.5) — never a decision. */
export interface DepositDecisionRequest {
  update_id: number;
  telegram_user_id: string;
  nonce: string;
  chat_id: string;
  message_id: number;
  decision: 'approve' | 'reject';
  correlationId: string;
}

export type DepositDecisionResult =
  | { outcome: 'won'; request_id: string; status: 'approved' | 'rejected' }
  | { outcome: 'lost_race'; request_id: string; status: 'approved' | 'rejected' }
  | { outcome: 'decision_failed'; reason: 'NONCE_INVALID' | 'NOT_AN_APPROVER' | 'AMOUNT_MISMATCH' | 'STATE_CONFLICT' | 'UNKNOWN' };

export interface ReconcileReport {
  run_id: string;
  checked_users: number;
  anomalies: Array<{ user_id: string; currency: Currency; sum: number; cached: number | null; held_active: number; kind: string }>;
}

export interface LedgerApi {
  credit(cmd: MoneyCmd, ctx: RpcCtx): Promise<Applied | Refused>; // approved deposit row
  debit(cmd: MoneyCmd, ctx: RpcCtx): Promise<Applied | Refused>; // conditional withdrawal row (usdSpendStatement semantics)
  hold(cmd: MoneyCmd & { kind: HoldKind; sagaId?: string }, ctx: RpcCtx): Promise<HoldResult>; // wallet_holds conditional insert
  commitHoldAndDebit(cmd: { holdId: string; eventKey: string; txId: string; note: string; sagaId?: string }, ctx: RpcCtx): Promise<Applied | Refused>; // atomic: withdrawal row + hold→committed
  releaseHold(cmd: { holdId: string; eventKey: string; sagaId?: string }, ctx: RpcCtx): Promise<Applied | Refused>;
  refund(cmd: MoneyCmd, ctx: RpcCtx): Promise<Applied | Refused>; // credit with ref.type ∈ {order, return, price_protection, escrow, membership}
  reservePoints(cmd: MoneyCmd & { sagaId?: string }, ctx: RpcCtx): Promise<Applied | Refused>;
  settlePoints(cmd: MoneyCmd, ctx: RpcCtx): Promise<Applied | Refused>;
  releasePoints(cmd: MoneyCmd & { sagaId?: string }, ctx: RpcCtx): Promise<Applied | Refused>;
  reversePoints(cmd: MoneyCmd, ctx: RpcCtx): Promise<Applied | Refused>;
  decideDeposit(cmd: DepositDecisionRequest, ctx: RpcCtx): Promise<DepositDecisionResult>; // the ONLY approval path
  getBalances(userId: string, ctx: RpcCtx): Promise<Balances>;
  getBreakdown(userId: string, ctx: RpcCtx): Promise<{ rows: Array<Record<string, unknown>> }>;
  reconcile(ctx: RpcCtx): Promise<ReconcileReport>;
  health(): Promise<HealthReport>;
}

/** Methods tagged `money`: refuse without `eventKey`; batch carries `AuditRecorded` (`01-TARGET.md` §4 item 7). */
export const LEDGER_MONEY_METHODS = [
  'credit', 'debit', 'hold', 'commitHoldAndDebit', 'releaseHold', 'refund', 'reservePoints', 'settlePoints', 'releasePoints',
  'reversePoints', 'decideDeposit',
] as const satisfies readonly (keyof LedgerApi)[];

/** The deterministic ids already in use become the keys (`01-TARGET.md` §6.1). */
export const LEGACY_EVENT_KEY_PATTERNS = [
  /^wtx_ord_[A-Za-z0-9_-]+_(usd|pts)$/,
  /^wtx_refund_[A-Za-z0-9_-]+(_(usd|pts))?$/,
  /^wtx_ret_[A-Za-z0-9_-]+$/,
  /^wtx_pp_[A-Za-z0-9_-]+$/,
  /^wtx_review_[A-Za-z0-9_-]+$/,
  /^wtx_acc_[A-Za-z0-9_-]+$/,
  /^wtx_membership_[A-Za-z0-9_-]+$/,
] as const;

/** `<service>:<aggregate>:<server id>:<leg>` */
export const CONTRACT_EVENT_KEY = /^[a-z][a-z0-9-]*:[a-z_]+:[A-Za-z0-9_-]+:[a-z_]+$/;

export function isWellFormedEventKey(key: string): boolean {
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) return false;
  return CONTRACT_EVENT_KEY.test(key) || LEGACY_EVENT_KEY_PATTERNS.some((re) => re.test(key));
}
