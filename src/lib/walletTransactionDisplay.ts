import { usdCentsToIqd } from './api';

interface WalletTransactionDisplayInput {
  cents: number;
  recordedIqd?: number | null;
  recordedRate?: number | null;
  deposit?: { amount_iqd: number; exchange_rate: number | null };
  withdrawalIqd?: number | null;
  withdrawalRate?: number | null;
  currentRate: number;
}

const positiveWhole = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/** Historical transaction display only: never changes cents or wallet balances. */
export function walletTransactionDisplay(input: WalletTransactionDisplayInput) {
  const rate = positiveWhole(input.recordedRate)
    ?? positiveWhole(input.withdrawalRate)
    ?? positiveWhole(input.deposit?.exchange_rate)
    ?? input.currentRate;
  const amountIqd = positiveWhole(input.recordedIqd)
    ?? positiveWhole(input.deposit?.amount_iqd)
    ?? positiveWhole(input.withdrawalIqd)
    ?? usdCentsToIqd(input.cents, rate);
  return { amountIqd, rate };
}
