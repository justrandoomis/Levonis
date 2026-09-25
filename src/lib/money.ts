/**
 * ONE WAY TO WRITE A DINAR FIGURE OF RECORD.
 *
 * Three formatters grew up side by side: `iqd()` in lib/merchant.ts writes
 * «12,000 IQD» in every language, `formatIqd()` in lib/api.ts writes
 * «12,000 د.ع» in every language, and the storefront's `DinarPrice` writes
 * «ع. 12,000». A merchant workspace that mixed them would print one total
 * three ways on one screen.
 *
 * THE RULE, and it is the rule the app already applies wherever it has both
 * languages in hand (the request wizard's English pane, the admin unit
 * labels `loc('د.ع', 'IQD')`): Arabic and Sorani read «د.ع», English reads
 * «IQD». Sorani takes the Arabic abbreviation because it is a currency sign,
 * not a sentence — nothing here is written in Kurdish.
 *
 * THE DIGITS ARE formatIqd's, NOT A NEW RULE. For ar/ckb the figure is exactly
 * `formatIqd(iqd)` — the function the order board, the invoice and the wallet
 * already print with — so a total in the workspace and the same total on the
 * order page are one string (`tests/uiPrimitivesLogic.test.ts` pins that).
 * English uses Latin digits explicitly.
 *
 * CUSTOMER PRICES DO NOT COME THROUGH HERE. A price a shopper reads follows
 * the currency they chose, which is `useMoney()` in src/CurrencyContext.tsx —
 * untouched by this module. This is for figures of record: a merchant's sales,
 * payouts, ledger lines and product prices as the merchant set them, which
 * are always dinars.
 */
import { formatIqd } from './api';
import type { Language } from '../translations';

/** «د.ع» for Arabic and Sorani, «IQD» for English. */
export function iqdUnit(lang: Language): string {
  return lang === 'en' ? 'IQD' : 'د.ع';
}

/** The figure alone, rounded to the whole dinar, grouped. */
export function iqdNumber(iqd: number, lang: Language): string {
  const whole = Math.round(iqd);
  return lang === 'en' ? whole.toLocaleString('en-US') : whole.toLocaleString();
}

/** «12,000 د.ع» / «12,000 IQD», or «—» when there is no figure to write. */
export function formatMoney(iqd: number | null | undefined, lang: Language): string {
  if (iqd == null || !Number.isFinite(iqd)) return '—';
  return lang === 'en' ? `${iqdNumber(iqd, lang)} ${iqdUnit(lang)}` : formatIqd(iqd);
}

/**
 * A signed figure — «+12,000 د.ع» / «−3,000 د.ع». The sign is part of the fact
 * (a refund is not a sale), so zero carries none and a negative takes the real
 * minus sign U+2212, which does not break from its digits at a line end.
 */
export function formatSignedMoney(iqd: number | null | undefined, lang: Language): string {
  if (iqd == null || !Number.isFinite(iqd)) return '—';
  const rounded = Math.round(iqd);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '\u2212' : '';
  return `${sign}${formatMoney(Math.abs(rounded), lang)}`;
}
