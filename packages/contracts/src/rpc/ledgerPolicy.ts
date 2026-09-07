/**
 * Argument policy per caller for money methods (`01-TARGET.md` §4 item 7,
 * ADR-006 (c)). Per-method caller allowlists are not enough for money: a
 * compromised Reviews Worker could otherwise `credit({currency:'USD',
 * amount:1e8})`. The Ledger applies these on top of the hop allowlist;
 * a violation is `FORBIDDEN` + `AuditRecorded` + `RiskFlagRaised`.
 * Pinned by `tests/ledgerPolicy.test.ts`.
 */
import type { Currency, LedgerApi, MoneyCmd } from './ledger';

export type LedgerCaller =
  | 'commerce' | 'marketplace' | 'reviews' | 'subscriptions' | 'referrals' | 'notifications' | 'ledger-admin' | 'ledger' | 'core';

/** `maxAmount` is either a fixed integer or the name of a limit the Ledger resolves per call. */
export type MaxAmountRule =
  | { kind: 'fixed'; amount: number }
  | { kind: 'configured'; limit: 'reviewAward' | 'referralReward' }
  | { kind: 'reference'; limit: 'paidForRef' | 'settlementOfRef' }
  | { kind: 'unbounded' };

export interface LedgerArgPolicy {
  currencies: readonly Currency[];
  refTypes: readonly string[]; // [] = any
  maxAmount: MaxAmountRule;
  /** Optional per-caller cap on the sum of amounts credited within a UTC day (integer, same unit as the command). */
  dailyCap: number | null;
}

export const LEDGER_POLICIES: Readonly<Record<LedgerCaller, LedgerArgPolicy>> = {
  // Reviews may only mint the configured POINT award for a review.
  reviews: { currencies: ['POINT'], refTypes: ['review'], maxAmount: { kind: 'configured', limit: 'reviewAward' }, dailyCap: null },
  // Referrals grant the configured reward for a referral.
  referrals: { currencies: ['USD', 'POINT'], refTypes: ['referral'], maxAmount: { kind: 'configured', limit: 'referralReward' }, dailyCap: null },
  // Subscriptions charge and refund memberships; a refund is at most what was paid.
  subscriptions: { currencies: ['USD'], refTypes: ['membership'], maxAmount: { kind: 'reference', limit: 'paidForRef' }, dailyCap: null },
  // Marketplace moves escrow and store-order money.
  marketplace: { currencies: ['USD'], refTypes: ['escrow', 'store_order'], maxAmount: { kind: 'unbounded' }, dailyCap: null },
  // Commerce settles orders, returns and price protection, never above the settlement.
  commerce: { currencies: ['USD', 'POINT'], refTypes: ['order', 'return', 'price_protection'], maxAmount: { kind: 'reference', limit: 'settlementOfRef' }, dailyCap: null },
  // Notifications may only forward deposit decisions (decideDeposit) — no money command at all.
  notifications: { currencies: [], refTypes: [], maxAmount: { kind: 'fixed', amount: 0 }, dailyCap: 0 },
  // The admin BFF: manual credits, scoped, audited (the Phase-0 reference implementation).
  'ledger-admin': { currencies: ['USD', 'POINT'], refTypes: ['manual', 'deposit', 'adjustment'], maxAmount: { kind: 'unbounded' }, dailyCap: null },
  // The Ledger deployable calling itself (Loyalty/Payments packages through the self-binding).
  ledger: { currencies: ['USD', 'POINT'], refTypes: [], maxAmount: { kind: 'unbounded' }, dailyCap: null },
  // The legacy core during the strangler phases: today's writers, unchanged behaviour.
  core: { currencies: ['USD', 'POINT'], refTypes: [], maxAmount: { kind: 'unbounded' }, dailyCap: null },
};

/** Per-method caller allowlists (`01-TARGET.md` §4 item 3 examples). */
export const LEDGER_METHOD_CALLERS: Readonly<Record<keyof LedgerApi, readonly LedgerCaller[]>> = {
  credit: ['commerce', 'marketplace', 'reviews', 'subscriptions', 'referrals', 'ledger-admin', 'ledger', 'core'],
  debit: ['commerce', 'marketplace', 'subscriptions', 'ledger', 'core'],
  hold: ['commerce', 'marketplace', 'subscriptions', 'ledger', 'core'],
  commitHoldAndDebit: ['commerce', 'marketplace', 'subscriptions', 'ledger', 'core'],
  releaseHold: ['commerce', 'marketplace', 'subscriptions', 'ledger', 'core'],
  refund: ['commerce', 'marketplace', 'subscriptions', 'ledger-admin', 'ledger', 'core'],
  reservePoints: ['commerce', 'ledger', 'core'],
  settlePoints: ['commerce', 'ledger', 'core'],
  releasePoints: ['commerce', 'ledger', 'core'],
  reversePoints: ['commerce', 'ledger', 'core'],
  decideDeposit: ['notifications', 'ledger-admin', 'core'],
  getBalances: ['commerce', 'marketplace', 'subscriptions', 'referrals', 'reviews', 'ledger-admin', 'ledger', 'core', 'notifications'],
  getBreakdown: ['ledger-admin', 'ledger', 'core'],
  reconcile: ['ledger-admin', 'ledger', 'core'],
  health: ['commerce', 'marketplace', 'subscriptions', 'referrals', 'reviews', 'notifications', 'ledger-admin', 'ledger', 'core'],
};

export interface PolicyLimits {
  /** the configured POINT award for a review */
  reviewAward?: number;
  /** the configured referral reward, in the command's currency */
  referralReward?: number;
  /** what was paid for `ref` (USD cents) — memberships */
  paidForRef?: (ref: MoneyCmd['ref']) => number | null;
  /** the settlement of `ref` (USD cents or points) — orders/returns/price protection */
  settlementOfRef?: (ref: MoneyCmd['ref'], currency: Currency) => number | null;
  /** the sum already credited today by this caller (same unit) */
  creditedToday?: number;
}

export type PolicyVerdict =
  | { ok: true }
  | { ok: false; reason: 'FORBIDDEN'; violation: 'CALLER_UNKNOWN' | 'METHOD_NOT_ALLOWED' | 'CURRENCY' | 'REF_TYPE' | 'AMOUNT' | 'DAILY_CAP' | 'LIMIT_UNRESOLVED' };

/**
 * Applies the per-method allowlist and the caller's argument policy to a
 * money command. Pure: the Ledger passes the limits it resolved from config
 * and its own rows.
 */
export function checkLedgerPolicy(caller: string, method: keyof LedgerApi, cmd: MoneyCmd, limits: PolicyLimits = {}): PolicyVerdict {
  const policy = (LEDGER_POLICIES as Record<string, LedgerArgPolicy | undefined>)[caller];
  if (!policy) return { ok: false, reason: 'FORBIDDEN', violation: 'CALLER_UNKNOWN' };
  if (!(LEDGER_METHOD_CALLERS[method] as readonly string[]).includes(caller)) return { ok: false, reason: 'FORBIDDEN', violation: 'METHOD_NOT_ALLOWED' };
  if (!policy.currencies.includes(cmd.currency)) return { ok: false, reason: 'FORBIDDEN', violation: 'CURRENCY' };
  if (policy.refTypes.length > 0 && !policy.refTypes.includes(cmd.ref.type)) return { ok: false, reason: 'FORBIDDEN', violation: 'REF_TYPE' };
  if (!Number.isInteger(cmd.amount) || cmd.amount < 0) return { ok: false, reason: 'FORBIDDEN', violation: 'AMOUNT' };
  const max = resolveMax(policy.maxAmount, cmd, limits);
  if (max === 'unresolved') return { ok: false, reason: 'FORBIDDEN', violation: 'LIMIT_UNRESOLVED' };
  if (max !== null && cmd.amount > max) return { ok: false, reason: 'FORBIDDEN', violation: 'AMOUNT' };
  if (policy.dailyCap !== null && (limits.creditedToday ?? 0) + cmd.amount > policy.dailyCap) {
    return { ok: false, reason: 'FORBIDDEN', violation: 'DAILY_CAP' };
  }
  return { ok: true };
}

function resolveMax(rule: MaxAmountRule, cmd: MoneyCmd, limits: PolicyLimits): number | null | 'unresolved' {
  switch (rule.kind) {
    case 'unbounded':
      return null;
    case 'fixed':
      return rule.amount;
    case 'configured': {
      const v = limits[rule.limit];
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 'unresolved';
    }
    case 'reference': {
      const fn = rule.limit === 'paidForRef' ? limits.paidForRef : limits.settlementOfRef;
      if (!fn) return 'unresolved';
      const v = rule.limit === 'paidForRef' ? (fn as NonNullable<PolicyLimits['paidForRef']>)(cmd.ref) : (fn as NonNullable<PolicyLimits['settlementOfRef']>)(cmd.ref, cmd.currency);
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 'unresolved';
    }
  }
}
