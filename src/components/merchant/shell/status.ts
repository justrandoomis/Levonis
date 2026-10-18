/**
 * The store's status pill: one word and one tone from `/api/merchant/me` —
 * the server's answer, never a tier string the page reads for itself
 * (tests/storefrontIsolation.test.ts «the frontend never decides who may
 * sell») — plus the sentence that says why.
 *
 * The order is the severity a merchant needs to know first: Levonis's
 * suspension, then their own pause, then a lapsed PLUS, then a restriction
 * short of suspension. Pure, for the tests.
 */
import type { MerchantMe } from '../../../lib/merchant';
import { say, sellingReason, W, type Loc, type Words } from './strings';

export type StoreStatusKey = 'open' | 'paused' | 'suspended' | 'lapsed' | 'restricted' | 'approval';

export interface StoreStatus {
  key: StoreStatusKey;
  tone: 'success' | 'warning' | 'danger';
  label: Words;
  /** Why — empty for an open store. */
  reason: (loc: Loc) => string;
}

export function storeStatus(me: Pick<MerchantMe, 'store' | 'selling'> & Partial<Pick<MerchantMe, 'approved' | 'application'>>): StoreStatus {
  const store = me.store;
  const merchantStatus = store?.merchant?.status ?? 'active';
  if (store?.status === 'suspended' || merchantStatus === 'suspended') {
    const code = store?.status === 'suspended' ? 'store_suspended' : 'merchant_suspended';
    return { key: 'suspended', tone: 'danger', label: W.suspended, reason: (loc) => sellingReason(code, loc) };
  }
  // THE APPROVAL AXIS (Community V3, DECISIONS rows 256–257), right after
  // Levonis's own suspension: a merchant no reviewer approved yet — every
  // merchant from before the gate included (owner decision C1) — is told where
  // the application stands, with the reviewer's public reason. Only an
  // explicit `false` from the server: an older answer without the field says
  // nothing about approval.
  if (me.approved === false) {
    // One short sentence (the frame has a byte budget, tests/bundleBudget.test.ts),
    // plus the reviewer's own public words when they asked for changes or refused.
    const app = me.application;
    const said = app && (app.state === 'changes_requested' || app.state === 'rejected') ? app.reason_public.trim() : '';
    return { key: 'approval', tone: 'warning', label: W.approval, reason: (loc) => `${say(loc, W.approvalWhy)}${said ? ` ${said}` : ''}` };
  }
  if (store?.status === 'paused') return { key: 'paused', tone: 'warning', label: W.paused, reason: (loc) => sellingReason('store_paused', loc) };
  const why = me.selling?.reason ?? '';
  if (!me.selling?.canSell && (why === 'subscription_inactive' || why === 'benefit_restricted')) {
    return { key: 'lapsed', tone: 'warning', label: W.lapsed, reason: (loc) => sellingReason(why, loc) };
  }
  if (merchantStatus !== 'active') return { key: 'restricted', tone: 'warning', label: W.restricted, reason: (loc) => sellingReason('merchant_restricted', loc) };
  if (!me.selling?.canSell) return { key: 'paused', tone: 'warning', label: W.paused, reason: (loc) => sellingReason(why, loc) };
  return { key: 'open', tone: 'success', label: W.open, reason: () => '' };
}
