/**
 * The store's status pill: one word and one tone from `/api/merchant/me` —
 * the server's answer, never a tier string the page reads for itself
 * (tests/storefrontIsolation.test.ts «the frontend never decides who may
 * sell») — plus the sentence that says why.
 *
 * The order is the severity a merchant needs to know first: Levonis's
 * suspension, then their own pause, then a lapsed PLUS, then a restriction
 * short of suspension. Pure, for the tests.
 *
 * APPROVAL IS ITS OWN AXIS, NEVER THE PILL (Community V3, DECISIONS rows
 * 256–257). It rides beside the operational status as `approval`, and the
 * shell says it in its own notice: a merchant from before the gate (owner
 * decision C1) whose PLUS lapsed must still read «lapsed», and the open/pause
 * switch must still say «open» or «paused».
 */
import type { MerchantMe } from '../../../lib/merchant';
import { say, sellingReason, W, type Loc, type Words } from './strings';

export type StoreStatusKey = 'open' | 'paused' | 'suspended' | 'lapsed' | 'restricted';

export interface StoreStatus {
  key: StoreStatusKey;
  tone: 'success' | 'warning' | 'danger';
  label: Words;
  /** Why — empty for an open store. */
  reason: (loc: Loc) => string;
  /**
   * The approval axis: where the application stands, for a merchant no
   * reviewer approved yet. Null when approved, and when the server said
   * nothing (an older answer without the field).
   */
  approval: ((loc: Loc) => string) | null;
}

type StatusInput = Pick<MerchantMe, 'store' | 'selling'> & Partial<Pick<MerchantMe, 'approved' | 'application'>>;

/** Only an explicit `false` from the server; one short sentence (the frame has a byte budget) plus the reviewer's public words when they asked for changes or refused. */
function approvalNotice(me: StatusInput): StoreStatus['approval'] {
  if (me.approved !== false) return null;
  const app = me.application;
  const said = app && (app.state === 'changes_requested' || app.state === 'rejected') ? app.reason_public.trim() : '';
  return (loc) => `${say(loc, W.approvalWhy)}${said ? ` ${said}` : ''}`;
}

export function storeStatus(me: StatusInput): StoreStatus {
  const approval = approvalNotice(me);
  const store = me.store;
  const merchantStatus = store?.merchant?.status ?? 'active';
  if (store?.status === 'suspended' || merchantStatus === 'suspended') {
    const code = store?.status === 'suspended' ? 'store_suspended' : 'merchant_suspended';
    return { key: 'suspended', tone: 'danger', label: W.suspended, reason: (loc) => sellingReason(code, loc), approval };
  }
  if (store?.status === 'paused') return { key: 'paused', tone: 'warning', label: W.paused, reason: (loc) => sellingReason('store_paused', loc), approval };
  const why = me.selling?.reason ?? '';
  if (!me.selling?.canSell && (why === 'subscription_inactive' || why === 'benefit_restricted')) {
    return { key: 'lapsed', tone: 'warning', label: W.lapsed, reason: (loc) => sellingReason(why, loc), approval };
  }
  if (merchantStatus !== 'active') return { key: 'restricted', tone: 'warning', label: W.restricted, reason: (loc) => sellingReason('merchant_restricted', loc), approval };
  if (!me.selling?.canSell) return { key: 'paused', tone: 'warning', label: W.paused, reason: (loc) => sellingReason(why, loc), approval };
  return { key: 'open', tone: 'success', label: W.open, reason: () => '', approval };
}
