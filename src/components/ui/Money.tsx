/**
 * MONEY — a dinar figure of record, written one way everywhere.
 *
 * `<Money iqd={12000} />` → «12,000 د.ع» in Arabic and Kurdish, «12,000 IQD»
 * in English (the rule and the digits are `formatMoney` in src/lib/money.ts,
 * which reuses formatIqd — see there for why).
 *
 * THE FIGURE IS AN LTR ISLAND. The digits (and a sign) sit in their own
 * left-to-right isolate, so «−3,000» never has its minus sign carried to the
 * far end of an Arabic line, and a grouping comma never reorders. The unit
 * follows the figure in the reading direction — «١٢٬٠٠٠ د.ع» reads number
 * then unit in Arabic exactly as formatIqd's text does — and the whole amount
 * is isolated from the sentence around it, so an English label beside an
 * Arabic unit cannot pull the words across it.
 *
 * TABULAR FIGURES: every digit is the same width, so a column of amounts
 * lines up and a changing total does not wobble.
 *
 * NO FIGURE, NO NUMBER: `null`/`undefined` renders «—», never «0 د.ع». A zero
 * that is really "unknown" is the kind of fact this workspace must not invent.
 *
 * Not for shoppers' prices: those follow the currency the shopper chose,
 * through `useMoney()` (src/CurrencyContext.tsx).
 */
import React from 'react';
import { useLanguage } from '../../LanguageContext';
import { iqdNumber, iqdUnit } from '../../lib/money';

export interface MoneyProps {
  iqd: number | null | undefined;
  /** Prefix «+» or «−»: a refund, a delta, a ledger movement. */
  signed?: boolean;
  className?: string;
}

export function Money({ iqd, signed = false, className = '' }: MoneyProps) {
  const { lang } = useLanguage();
  if (iqd == null || !Number.isFinite(iqd)) {
    return <span className={`tabular-nums ${className}`}>—</span>;
  }
  const rounded = Math.round(iqd);
  const sign = signed ? (rounded > 0 ? '+' : rounded < 0 ? '\u2212' : '') : rounded < 0 ? '\u2212' : '';
  return (
    <bdi data-money className={`whitespace-nowrap tabular-nums ${className}`}>
      <bdi dir="ltr">
        {sign}
        {iqdNumber(Math.abs(rounded), lang)}
      </bdi>{' '}
      {iqdUnit(lang)}
    </bdi>
  );
}
