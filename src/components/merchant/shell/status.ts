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
import { sellingReason, W, type Loc, type Words } from './strings';

export type StoreStatusKey = 'open' | 'paused' | 'suspended' | 'lapsed' | 'restricted';

export interface StoreStatus {
  key: StoreStatusKey;
  tone: 'success' | 'warning' | 'danger';
  label: Words;
  /** Why — empty for an open store. */
  reason: (loc: Loc) => string;
}

export function storeStatus(me: Pick<MerchantMe, 'store' | 'selling'>): StoreStatus {
  const store = me.store;
  const merchantStatus = store?.merchant?.status ?? 'active';
  if (store?.status === 'suspended' || merchantStatus === 'suspended') {
    const code = store?.status === 'suspended' ? 'store_suspended' : 'merchant_suspended';
    return { key: 'suspended', tone: 'danger', label: W.suspended, reason: (loc) => sellingReason(code, loc) };
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
