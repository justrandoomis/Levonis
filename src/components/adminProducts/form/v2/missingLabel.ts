/**
 * What one missing entry is called — the pricing screens' own label for the code (the code itself when
 * unknown). Its own light module (contracts only): the «يحتاج تسعيرًا» queue in the products list uses it,
 * and importing it from StatusChipV2 would pull the form's V2 model (and its cost field names) into the
 * list's chunk.
 */
import { isPricingIssueCode, pricingIssueLabel } from '../../../../../packages/contracts/src/pricingIssues';
import { isPricingFieldName } from '../../../../../packages/contracts/src/pricingFieldLabels';

export function missingLabel(m: { code: string; field: string | null }, lang: 'ar' | 'en' | 'ckb'): string {
  if (!isPricingIssueCode(m.code)) return m.code;
  return pricingIssueLabel(m.code, lang, isPricingFieldName(m.field) ? { field: m.field } : {});
}
