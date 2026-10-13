/**
 * APPROVED CENTRAL RATES FOR A PROCUREMENT TEST (Pricing V2 V2-0 F4,
 * docs/DECISIONS.md row 224).
 *
 * A purchase in USD, EUR or CNY now saves only against an approved central
 * rate (`pricing_fx_rates`, written by the FX commit) and, without the owner's
 * `confirm_rate`, only within 6% of it. These defaults put the rates the
 * procurement tests have always typed inside that band: USD 1,500; EUR
 * 1.0842 × 1,500 = 1,626.3 (the tests' 1,626.25); CNY 0.1568 × 1,500 = 235.2
 * (the tests' 235.25 and 235.5). Applied as the approval route would
 * (tests/fixtures/fx.ts `applyRate`), so the derived rates are in step.
 */
import type { DatabaseSync } from 'node:sqlite';
import { applyRate } from './fx';

export function seedApprovedProcurementRates(
  raw: DatabaseSync,
  rates: { USD_IQD?: string; EUR_USD?: string; CNY_USD?: string } = {},
): void {
  applyRate(raw, 'USD_IQD', rates.USD_IQD ?? '1500');
  applyRate(raw, 'EUR_USD', rates.EUR_USD ?? '1.0842');
  applyRate(raw, 'CNY_USD', rates.CNY_USD ?? '0.1568');
}
