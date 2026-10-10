import { createContext, useContext } from 'react';
import { formatUsdCents } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { formatMoney, Money } from './ui';
import { PA_STRINGS, tri } from './displayCurrencyStrings';
import type { UsdCents } from './types';

/**
 * «عملة العرض» — the IQD/USD display toggle of «الأرباح والتكاليف» (design
 * P-A §8). DISPLAY ONLY: the server sends integer US cents beside the dinars
 * (`display_usd`), converted at the shop's rate when each order was placed;
 * this module formats them and never computes money. It starts at IQD on
 * every load and is never stored. In USD every figure reads dollars first with
 * «القيمة المحاسبية: … د.ع» beneath — the accounting value, unchanged.
 */
export type DisplayCurrency = 'IQD' | 'USD';

export const DisplayCurrencyContext = createContext<DisplayCurrency>('IQD');
export const useDisplayCurrency = () => useContext(DisplayCurrencyContext);

/** USD cents for display, or "—" for an incomplete value (never 0). */
export const usdText = (cents: number | null | undefined) => (cents == null ? '—' : formatUsdCents(cents));

/**
 * A figure in the chosen currency. In USD with server cents: the dollars, and
 * the accounting dinars beneath. With no cents for this figure (an IQD-only
 * figure, or USD unavailable) it stays in dinars.
 */
export function DisplayMoney({ iqd, cents, compact = false }: { iqd: number | null | undefined; cents?: number | null; compact?: boolean }) {
  const currency = useDisplayCurrency();
  const { loc } = useLanguage();
  if (currency !== 'USD' || cents === undefined) return <Money value={iqd} compact={compact} />;
  return <span className="fw-money-dual" data-finance-usd>
    <span className={`fw-money${compact ? ' fw-money--compact' : ''}`} dir="ltr">{usdText(cents)}</span>
    {!compact && <small className="fw-money-accounting">{tri(loc, PA_STRINGS.accountingValue, { amount: formatMoney(iqd) })}</small>}
  </span>;
}

/** Pick one field's cents from a server cents row; undefined (stay in IQD) when the row is absent. */
export const centsAt = (row: UsdCents | undefined, field: string): number | null | undefined =>
  row === undefined ? undefined : row[field.replace(/_iqd$/, '_cents')] ?? null;

export function CurrencyToggle({ value, onChange }: { value: DisplayCurrency; onChange: (next: DisplayCurrency) => void }) {
  const { loc } = useLanguage();
  const label = tri(loc, PA_STRINGS.displayCurrency);
  return <div className="fw-currency-toggle" role="group" aria-label={label} data-finance-display-currency>
    <span className="fw-currency-toggle-label">{label}</span>
    {(['IQD', 'USD'] as const).map((code) => <button key={code} type="button" className="fw-pill" aria-pressed={value === code} onClick={() => onChange(code)}>
      {tri(loc, code === 'IQD' ? PA_STRINGS.dinarOption : PA_STRINGS.dollarOption)}
    </button>)}
  </div>;
}

/**
 * What the dollar figures stand on: always the note that accounting stays in
 * dinars, then the rate basis — at the time of each order, at today's rate
 * («≈»), or a mix — or, with no approved rate at all, that the page stays in
 * dinars.
 */
export function UsdBasisNote({ available, atTimeCount = 0, todayCount = 0, todayRate, single, batchLines = 0 }: {
  available: boolean; atTimeCount?: number; todayCount?: number; todayRate?: string | null;
  single?: { usd_basis: 'at_time' | 'today'; fx_rate_snapshot: string };
  /** FX-6: how many lines' goods cost is at their batches' purchase-time rates (the server's `batch_cost_lines`). */
  batchLines?: number;
}) {
  const { loc } = useLanguage();
  if (!available) return <p className="fw-note" role="status" data-finance-usd-note="none">{tri(loc, PA_STRINGS.usdNone)}</p>;
  const rate = (r: string | null | undefined) => (r ? Number(r).toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—');
  const basis = single
    ? single.usd_basis === 'today' ? tri(loc, PA_STRINGS.usdToday, { rate: rate(single.fx_rate_snapshot) }) : tri(loc, PA_STRINGS.usdAtTime, { rate: rate(single.fx_rate_snapshot) })
    : todayCount > 0 && atTimeCount === 0 ? tri(loc, PA_STRINGS.usdToday, { rate: rate(todayRate) })
      : todayCount > 0 ? tri(loc, PA_STRINGS.usdMixed, { n: todayCount })
        : tri(loc, PA_STRINGS.usdAtTimeEach);
  return <p className="fw-note" role="status" data-finance-usd-note={single?.usd_basis ?? (todayCount > 0 ? (atTimeCount ? 'mixed' : 'today') : 'at_time')}>
    {tri(loc, PA_STRINGS.usdNote)} <bdi>{basis}</bdi>
    {batchLines > 0 && <> <bdi data-finance-usd-batch-cost>{tri(loc, PA_STRINGS.usdBatchCost, { n: batchLines })}</bdi></>}
  </p>;
}
