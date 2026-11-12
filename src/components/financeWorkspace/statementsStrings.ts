/**
 * «المال والأرباح» → الأشخاص والدفعات → «الكشوف» — THE WORDS OF THE PAYOUT STATEMENTS PAGE (the owner, 2026-11-13: «more
 * improvement if possible on ui ux» of the statements; DECISIONS row 336). One table in Arabic, English and Sorani;
 * tests/payoutStatements.test.ts holds the Sorani rules of DECISIONS row 183. Placeholders are {name}.
 */
type Tri = readonly [ar: string, en: string, ckb: string];
type Loc = (ar: string, en: string, ckb?: string) => string;

export const PS = {
  title: ['كشوف الدفعات', 'Payout statements', 'کەشفی پارەدانەکان'],
  sub: ['كل دفعة لموظف وكل سحب لمستثمر في الفترة، بكشفه Excel وPDF', 'Every staff payment and investor withdrawal in the period, each with its statement in Excel and PDF', 'هەموو پارەدانێکی کارمەند و ڕاکێشانێکی وەبەرهێنەر لە ماوەکەدا، بە کەشفەکەی Excel و PDF'],
  staffTitle: ['دفعات الموظفين', 'Staff payments', 'پارەدانی کارمەندان'],
  withdrawalsTitle: ['سحوبات المستثمرين', 'Investor withdrawals', 'ڕاکێشانی وەبەرهێنەران'],
  colDay: ['اليوم', 'Day', 'ڕۆژ'],
  colEmployee: ['الموظف', 'Employee', 'کارمەند'],
  colInvestor: ['المستثمر', 'Investor', 'وەبەرهێنەر'],
  colKind: ['النوع', 'Kind', 'جۆر'],
  colAmount: ['المبلغ', 'Amount', 'بڕ'],
  colPaid: ['المدفوع', 'Paid', 'دراوە'],
  colState: ['الحالة', 'State', 'دۆخ'],
  colStatement: ['الكشف', 'Statement', 'کەشف'],
  kindPayment: ['دفعة', 'Payment', 'پارەدان'],
  kindAdvance: ['سلفة', 'Advance', 'پێشینە'],
  requested: ['مطلوب', 'Requested', 'داواکراو'],
  approved: ['موافَق عليه', 'Approved', 'پەسەندکراو'],
  part_paid: ['دُفع جزء منه', 'Part paid', 'بەشێکی دراوە'],
  paid: ['مدفوع', 'Paid', 'دراوە'],
  noneStaff: ['لا دفعات لموظفين في الفترة.', 'No staff payments in the period.', 'هیچ پارەدانێکی کارمەند لە ماوەکەدا نییە.'],
  noneWithdrawals: ['لا سحوبات في الفترة.', 'No withdrawals in the period.', 'هیچ ڕاکێشانێک لە ماوەکەدا نییە.'],
  failed: ['تعذّر تحميل الكشوف.', 'Could not load the statements.', 'بارکردنی کەشفەکان سەرنەکەوت.'],
} as const satisfies Record<string, Tri>;

export type PsKey = keyof typeof PS;

export function pss(loc: Loc, key: PsKey, vars: Record<string, string | number> = {}): string {
  const [ar, en, ckb] = PS[key];
  return loc(ar, en, ckb).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}
