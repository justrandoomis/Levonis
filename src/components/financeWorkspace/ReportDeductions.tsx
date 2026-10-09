import { useLanguage } from '../../LanguageContext';
import { Money, Row } from './ui';
import { PA_STRINGS, tri } from './displayCurrencyStrings';

/**
 * P-A F4/F5: the coupon and price-protection credits as deductions IN THIS
 * REPORT ONLY (owner question Q3, default "report only"). Shown only when one
 * of them is not zero; the note says what they do not change.
 */
export default function ReportDeductions({ totals, net, compact = false }: { totals: { coupon_iqd?: number | null; price_protection_iqd?: number | null }; net: number | null | undefined; compact?: boolean }) {
  const { loc } = useLanguage();
  const coupon = totals.coupon_iqd ?? 0, credit = totals.price_protection_iqd ?? 0;
  if (!coupon && !credit) return null;
  return <div data-finance-report-deductions>
    {!!coupon && <Row label={tri(loc, PA_STRINGS.couponDeduction)} value={<Money value={-coupon} />} />}
    {!!credit && <Row label={tri(loc, PA_STRINGS.priceProtectionCredit)} value={<Money value={-credit} />} />}
    <Row label={tri(loc, PA_STRINGS.netAfterReportDeductions)} value={<Money value={net} />} prominent={!compact} />
    <p className="fw-note">{tri(loc, PA_STRINGS.reportOnlyNote)}</p>
  </div>;
}
