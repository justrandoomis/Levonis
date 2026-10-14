/**
 * ONE ANSWER TO «MAY THIS ADMIN MOVE THIS MONEY?» FOR EVERY SERVICE.
 *
 * Owner decision 3 (docs/DECISIONS.md row 223): «المساعد لا يحرّك مالاً أبداً؛
 * المسؤول المالي حتى ما يحسبه الخادم؛ المالك وحده فوق السقف بسبب مسجّل، وتمديد
 * أي ضمان، واستبدال جهاز كامل».
 *
 * Before this file each service money door answered the question its own way,
 * or not at all: price-protection `decide` and the return refund took any
 * admin (an assistant credited wallets), a trade-in `value` took any figure up
 * to a billion dinars from any financial admin, and an assistant could add
 * months to any warranty or move its delivery date later. Every one of those
 * doors now asks HERE, with the amount the server computed:
 *
 *   tier        who                         may
 *   ─────────── ─────────────────────────── ─────────────────────────────────
 *   none        assistant scope, customers  nothing — 403 FINANCIAL_SCOPE_REQUIRED
 *   financial   NULL / 'full' scope         an act up to `ceilingIqd` (what
 *                                           the server computed); an act with
 *                                           no ceiling (a refund of what was
 *                                           paid) in full
 *   owner       INITIAL_ADMIN_EMAIL,        everything above; above a ceiling
 *               verified                    only with a reason (≥ 5 chars),
 *                                           returned in `audit` for the row
 *
 * OWNER-ONLY ACTS ignore amounts: lengthening a warranty, moving a delivery
 * date later, replacing a whole unit, editing the trade-in valuation rules.
 *
 * A CONFLICT OF INTEREST (the approver wrote the price row that made a
 * price-protection drop: plan §3.5 «four eyes») is treated as above the
 * ceiling: the owner, with a reason.
 *
 * The answers carry no amount and no ceiling (`moneyAuthorityMessage`): the
 * same sentence whatever was asked. The amounts go to the audit row only.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AppContext, Env } from './types';
import { HttpError } from './http';
import { canMoveMoney, isOwner, isUnverifiedOwner, type CostSubject } from './adminScope';
import { ownerEmailUnverified } from './costAccess';
import { moneyAuthorityMessage, type MoneyAuthorityCode } from '../../packages/contracts/src/moneyAuthority';

export type MoneyAct =
  | 'price_protection_decide'
  | 'return_refund'
  | 'trade_in_approve'
  | 'trade_in_value'
  | 'trade_in_inspect'
  | 'trade_in_complete'
  | 'trade_in_rules'
  | 'warranty_lengthen'
  | 'warranty_delivery_later'
  | 'warranty_replace'
  | 'warranty_claim_decision';

/** The acts only the owner performs, whatever the amount (decision 3). */
export const OWNER_ONLY_ACTS: ReadonlySet<MoneyAct> = new Set<MoneyAct>([
  'trade_in_rules',
  'warranty_lengthen',
  'warranty_delivery_later',
  'warranty_replace',
]);

/** The shortest reason the owner may record for going above a ceiling. */
export const OWNER_REASON_MIN = 5;

export interface MoneyAsk {
  act: MoneyAct;
  /** What this act moves, as the SERVER computed it (never a client figure). */
  amountIqd?: number | null;
  /**
   * The most a financial admin may move for this act, computed by the server.
   * Absent: the act's amount is the server's own (a refund of what was paid)
   * and a financial admin may perform it in full.
   */
  ceilingIqd?: number | null;
  /** The approver has a stake in the figure (four eyes): the owner decides. */
  conflictOfInterest?: boolean;
  /** The owner's reason, required above a ceiling or on a conflict. */
  reason?: string | null;
}

export interface MoneyGrant {
  tier: 'owner' | 'financial';
  above_ceiling: boolean;
  /** For the audit row (staff-only): the act, the tier, the figures, the owner's reason. */
  audit: {
    act: MoneyAct;
    tier: 'owner' | 'financial';
    amount_iqd: number | null;
    ceiling_iqd: number | null;
    above_ceiling: boolean;
    conflict_of_interest: boolean;
    owner_reason?: string;
  };
}

function refusal(status: 400 | 403, code: MoneyAuthorityCode): HttpError {
  return new HttpError(status, moneyAuthorityMessage(code), code);
}

const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/**
 * The decision. Throws the refusal (403 FINANCIAL_SCOPE_REQUIRED, 403
 * OWNER_REQUIRED, 403 OWNER_EMAIL_UNVERIFIED, 400 OWNER_REASON_REQUIRED) or
 * returns the grant with what the audit row should carry.
 */
export function moneyAuthority(env: Env, user: CostSubject | null | undefined, ask: MoneyAsk): MoneyGrant {
  if (!user || user.role !== 'admin' || !canMoveMoney(env, user)) throw refusal(403, 'FINANCIAL_SCOPE_REQUIRED');
  const owner = isOwner(env, user);
  const amount = whole(ask.amountIqd);
  const ceiling = whole(ask.ceilingIqd);
  const conflict = ask.conflictOfInterest === true;
  const ownerOnly = OWNER_ONLY_ACTS.has(ask.act);
  const above = ceiling !== null && (amount === null || amount > ceiling);
  const needsOwner = ownerOnly || above || conflict;
  if (needsOwner) {
    if (!owner) throw refusal(403, 'OWNER_REQUIRED');
    // The owner's address on an unverified row is not yet the owner (critique A10).
    if (isUnverifiedOwner(env, user)) throw ownerEmailUnverified();
  }
  const reason = typeof ask.reason === 'string' ? ask.reason.trim() : '';
  if ((above || conflict) && reason.length < OWNER_REASON_MIN) throw refusal(400, 'OWNER_REASON_REQUIRED');
  const tier = owner ? 'owner' : 'financial';
  return {
    tier,
    above_ceiling: above,
    audit: {
      act: ask.act,
      tier,
      amount_iqd: amount,
      ceiling_iqd: ceiling,
      above_ceiling: above,
      conflict_of_interest: conflict,
      ...(above || conflict ? { owner_reason: reason } : {}),
    },
  };
}

/** `moneyAuthority` for the request's own session. */
export function assertMoneyAuthority(c: Context<AppContext>, ask: MoneyAsk): MoneyGrant {
  return moneyAuthority(c.env, c.get('user'), ask);
}

/**
 * THE SAME RULE ON THE ROUTE DECLARATION, before a body is parsed or a row is
 * read: an assistant hears 403 at the door, and an owner-only act refuses
 * everyone else there too. An act with an amount checks it again inside the
 * handler, once the server has computed it.
 */
export function requireMoneyAuthority(act: MoneyAct): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    moneyAuthority(c.env, c.get('user'), { act });
    await next();
  };
}
