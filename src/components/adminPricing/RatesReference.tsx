/**
 * THE RATE REFERENCE OF P1 — what the calculator uses unless the owner types
 * other rates: the exchange rates (USD, EUR, CNY → IQD) and the shipping
 * rates (Germany land and China air per kg, China sea per CBM).
 *
 * They are read by the server from the purchase screens' cost profiles, so
 * every one says «not confirmed» (b.ratesFromPurchases): P1 has no central
 * rates card yet, and a value nobody confirmed is labelled as one. A rate the
 * purchases never held — USD today — is shown as MISSING, with the contract's
 * own sentence, never as 0 and never as the wallet's exchange rate.
 *
 * Figures are the server's exact decimal TEXT, grouped for reading only.
 */
import React, { useId } from 'react';
import { StatusChip } from '../ui/Badge';
import type { Language } from '../../translations';
import type { PricingRates } from './api';
import { Eyebrow, Figure } from './parts';
import { readDecimal, profileLabel, ratesFromPurchasesText, usdMissingText, type PricingUiStrings } from './strings';

export default function RatesReference({ rates, lang, s, headingLevel = 3 }: { rates: PricingRates; lang: Language; s: PricingUiStrings; headingLevel?: 3 | 4 }) {
  const Heading = `h${headingLevel}` as 'h3' | 'h4';
  const titleId = useId();
  const unit = lang === 'en' ? 'IQD' : 'د.ع';
  // The banner above says every purchase rate is unconfirmed; a row carries a
  // chip only when it differs from that — a rate the owner typed for a
  // calculation. One cue per fact, not one per row.
  const originChip = (origin: 'central' | 'procurement_profiles' | 'what_if', _confirmed: boolean) =>
    origin === 'what_if' ? <StatusChip tone="info">{s.fromWhatIf}</StatusChip> : null;

  return (
    <section aria-labelledby={titleId} data-pricing-rates className="lv-surface min-w-0 p-4">
      <Heading id={titleId} className="text-[15px] font-bold leading-snug text-text-primary">
        {s.ratesHeading}
      </Heading>
      <p className="mt-0.5 text-[13px] leading-relaxed text-text-muted">{s.ratesIntro}</p>
      <p role="note" className="lv-alert lv-alert-warning mt-3 text-[13px] leading-relaxed text-text-secondary">
        {ratesFromPurchasesText(lang)}
      </p>

      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <div className="min-w-0">
          <Eyebrow>{s.fxHeading}</Eyebrow>
          <ul className="mt-2 divide-y divide-border-subtle/60">
            {rates.fx_rates.map((r) => (
              <li key={r.currency} data-fx-rate={r.currency} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5">
                <span className="text-[14px] font-semibold text-text-primary">
                  <Figure>{readDecimal('1', lang)} {r.currency}</Figure>
                </span>
                {r.rate_iqd === null ? (
                  <span className="text-end text-[13px] text-warning">
                    <span className="font-semibold">{s.missingRate}</span>
                    {r.currency === 'USD' && <span className="block text-[12px] text-text-muted">{usdMissingText(lang)}</span>}
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    <span className="text-[14px] font-semibold text-text-primary">
                      <Figure>{readDecimal(r.rate_iqd, lang)}</Figure> {unit}
                    </span>
                    {originChip(r.rate_origin, r.confirmed)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          <Eyebrow>{s.shippingHeading}</Eyebrow>
          <ul className="mt-2 divide-y divide-border-subtle/60">
            {rates.shipping_rates.map((r) => (
              <li key={r.profile} data-shipping-rate={r.profile} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5">
                <span className="min-w-0 text-[14px] font-semibold text-text-primary">{profileLabel(r.profile, lang)}</span>
                {r.rate_iqd === null ? (
                  <span className="text-[13px] font-semibold text-warning">{s.missingRate}</span>
                ) : (
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    <span className="text-[14px] text-text-primary">
                      <Figure className="font-semibold">{readDecimal(r.rate_iqd, lang)}</Figure>{' '}
                      <span className="text-[12px] text-text-muted">{r.basis === 'volume' ? s.perCbm : s.perKg}</span>
                    </span>
                    {originChip(r.rate_origin, r.confirmed)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
