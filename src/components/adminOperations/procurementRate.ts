/**
 * THE PURCHASE SCREEN'S EXCHANGE RATE (Pricing V2 stage V2-0, finding F4;
 * docs/DECISIONS.md row 224).
 *
 * The document's rate is prefilled from the APPROVED central rate the server
 * hands the owner in `GET /api/admin/procurement/config` (`approved_rates`,
 * the engine's own `pricing_fx_rates`), never 1. No approved rate: the field
 * stays empty and the save is blocked with the server's own sentence. A rate
 * typed more than 6% away needs the owner's tick, which the save sends as
 * `confirm_rate: true` — the server refuses without it
 * (PURCHASE_RATE_CONFIRM_REQUIRED), so this file only asks first.
 *
 * No conversion happens here: the rate is the server's figure, formatted.
 */
import { COST_REFUSALS } from '../../../packages/contracts/src/costRefusals';
import {
  isProcurementRateCurrency,
  procurementRateFar,
  PROCUREMENT_RATE_DRIFT_PCT,
  type ApprovedProcurementRate,
} from '../../../packages/contracts/src/procurementRate';
import { groupedNumber } from '../../lib/localeNumber';

type Lang = 'ar' | 'en' | 'ckb';

/** The approved central rate of a currency, or null (IQD and an unapproved currency). */
export function approvedRateOf(rates: readonly ApprovedProcurementRate[] | undefined, currency: string): ApprovedProcurementRate | null {
  if (!isProcurementRateCurrency(currency)) return null;
  return rates?.find((r) => r.currency === currency && Number(r.rate_iqd) > 0) ?? null;
}

/** The value a fresh document (or a switch to `currency`) starts with: the approved rate, empty without one, 1 for IQD. */
export function prefillRate(rates: readonly ApprovedProcurementRate[] | undefined, currency: string): number {
  if (currency === 'IQD') return 1;
  const approved = approvedRateOf(rates, currency);
  return approved ? Number(approved.rate_iqd) : NaN;
}

/**
 * Where the typed rate stands: `iqd` needs none; `missing` — no approved rate,
 * the save is blocked; `far` — more than 6% away, the save needs the tick;
 * `ok` otherwise (an empty or unreadable field is left to the input's own check).
 */
export type RateStanding = 'iqd' | 'missing' | 'far' | 'ok';
export function rateStanding(rates: readonly ApprovedProcurementRate[] | undefined, currency: string, typed: number): RateStanding {
  if (currency === 'IQD') return 'iqd';
  const approved = approvedRateOf(rates, currency);
  if (!approved) return 'missing';
  if (!Number.isFinite(typed) || typed <= 0) return 'ok';
  return procurementRateFar(typed, Number(approved.rate_iqd)) ? 'far' : 'ok';
}

const rateText = (value: string | null) => (value === null ? '' : groupedNumber(Number(value), 10));

/** The rate field's hint, warning and tick, in the viewer's language (row 183: the Sorani is its own). */
export function procurementRateStrings(lang: Lang) {
  const pct = String(PROCUREMENT_RATE_DRIFT_PCT);
  const chain = (r: ApprovedProcurementRate) =>
    r.cross_rate && r.usd_iqd_rate
      ? lang === 'en'
        ? ` (${rateText(r.cross_rate)} USD × ${rateText(r.usd_iqd_rate)} IQD)`
        : lang === 'ckb'
          ? ` (${rateText(r.cross_rate)} دۆلار × ${rateText(r.usd_iqd_rate)} د.ع)`
          : ` (${rateText(r.cross_rate)} دولار × ${rateText(r.usd_iqd_rate)} د.ع)`
      : '';
  return {
    central: (r: ApprovedProcurementRate) =>
      (lang === 'en'
        ? `Approved central rate: ${rateText(r.rate_iqd)} IQD`
        : lang === 'ckb'
          ? `نرخی ناوەندیی پەسەندکراو: ${rateText(r.rate_iqd)} د.ع`
          : `السعر المركزي المعتمد: ${rateText(r.rate_iqd)} د.ع`) + chain(r),
    missing: COST_REFUSALS.PURCHASE_RATE_NOT_APPROVED[lang],
    far: (r: ApprovedProcurementRate) =>
      lang === 'en'
        ? `This rate is more than ${pct}% away from the approved central rate (${rateText(r.rate_iqd)} IQD). Check it before saving.`
        : lang === 'ckb'
          ? `ئەم نرخە زیاتر لە ${pct}٪ لە نرخی ناوەندیی پەسەندکراو (${rateText(r.rate_iqd)} د.ع) دوورە. پێش پاشەکەوتکردن بیپشکنەرەوە.`
          : `هذا السعر يبتعد أكثر من ${pct}٪ عن السعر المركزي المعتمد (${rateText(r.rate_iqd)} د.ع). راجعه قبل الحفظ.`,
    confirm:
      lang === 'en'
        ? 'I confirm this is the exchange rate actually paid for this purchase'
        : lang === 'ckb'
          ? 'پشتڕاستی دەکەمەوە کە ئەمە ئەو نرخی ئاڵوگۆڕەیە کە بە ڕاستی بۆ ئەم کڕینە دراوە'
          : 'أؤكد أن هذا هو سعر الصرف المدفوع فعلًا لهذا الشراء',
    useCentral: lang === 'en' ? 'Use the central rate' : lang === 'ckb' ? 'نرخی ناوەندی بەکاربهێنە' : 'استخدم السعر المركزي',
  };
}
