/**
 * «المال والأرباح» → المحاسبة → «سجل العمليات المالية» — ITS WORDS (the owner's brief, 2026-11-12, part 4: «audit logs»;
 * GET /api/admin/finance-workspace/activity, DECISIONS row 328). The page's own words, and a short sentence for every action
 * the log can hold, in Arabic, English and Sorani: what the person did, in the past tense. An action this table does not know
 * (one added later) is shown as its code, never hidden. tests/accountingActivityPage.test.ts holds the Sorani rules of
 * DECISIONS row 183 and that every action the server can return has its sentence here.
 */
type Tri = readonly [ar: string, en: string, ckb: string];
type Loc = (ar: string, en: string, ckb?: string) => string;

export const AAS = {
  title: ['سجل العمليات المالية', 'Finance activity log', 'تۆماری کارە داراییەکان'],
  sub: ['كل تغيير في المال: من فعله ومتى وعلى ماذا، في الفترة المختارة.', 'Every change to money: who made it, when and to what, in the chosen period.', 'هەموو گۆڕانکارییەک لە پارەدا: کێ کردی، کەی و لەسەر چی، لە ماوەی هەڵبژێردراودا.'],
  search: ['ابحث برقم طلب أو اسم أو مرجع', 'Search an order number, a name or a reference', 'بە ژمارەی داواکاری یان ناو یان سەرچاوە بگەڕێ'],
  auto: ['يشمل ما فعله النظام وحده', 'Include what the system did by itself', 'ئەوەی سیستەم بە تەنها کردوویەتی لەخۆبگرێت'],
  none: ['لا عمليات في هذه الفترة.', 'No activity in this period.', 'هیچ کارێک لەم ماوەیەدا نییە.'],
  more: ['المزيد', 'More', 'زیاتر'],
  failed: ['تعذّر تحميل السجل.', 'The log could not load.', 'تۆمارەکە بار نەکرا.'],
  colWhat: ['العملية', 'Action', 'کار'],
  colWhen: ['الوقت', 'When', 'کات'],
  colWho: ['من', 'Who', 'کێ'],
  colOn: ['على', 'On', 'لەسەر'],
  colAmount: ['المبلغ', 'Amount', 'بڕ'],
  system: ['النظام', 'System', 'سیستەم'],
} as const satisfies Record<string, Tri>;

export const ACTION_WORDS: Record<string, Tri> = {
  'finance.expense.create': ['سجّل مصروفًا', 'Recorded an expense', 'خەرجییەکی تۆمارکرد'],
  'finance.expense.update': ['عدّل مصروفًا', 'Edited an expense', 'خەرجییەکی دەستکاریکرد'],
  'finance.expense.void': ['ألغى مصروفًا', 'Voided an expense', 'خەرجییەکی هەڵوەشاندەوە'],
  'finance.expense.restore': ['أعاد مصروفًا ملغى', 'Restored a voided expense', 'خەرجییەکی هەڵوەشێنراوەی گەڕاندەوە'],
  'finance.expense_category.create': ['أضاف تصنيف مصروف', 'Added an expense category', 'پۆلێنێکی خەرجی زیادکرد'],
  'finance.expense_category.update': ['عدّل تصنيف مصروف', 'Edited an expense category', 'پۆلێنێکی خەرجی دەستکاریکرد'],
  'finance.expense_category.seed': ['أنشأ التصنيفات الافتراضية', 'Created the default categories', 'پۆلێنە بنەڕەتییەکانی دروستکرد'],
  'finance.expense_linked': ['ربط مصروفًا', 'Linked an expense', 'خەرجییەکی بەستەوە'],
  'finance.monthly_promotion': ['سجّل ترويج الشهر أو عدّله', 'Recorded or edited the month’s promotion', 'بانگەشەی مانگی تۆمارکرد یان دەستکاریکرد'],
  'finance.order_adjusted': ['صحّح أرقام طلب', 'Corrected an order’s figures', 'ژمارەکانی داواکارییەکی ڕاستکردەوە'],
  'finance.order_assigned': ['أسند مهمة طلب', 'Assigned an order task', 'ئەرکی داواکارییەکی سپارد'],
  'finance.order_recomputed': ['أعاد حساب طلب', 'Recomputed an order', 'داواکارییەکی دووبارە ژماردەوە'],
  'finance.posting_retried': ['أعاد ترحيلًا فشل', 'Retried a failed posting', 'تۆمارکردنێکی شکستخواردووی دووبارەکردەوە'],
  'finance.collection_recorded': ['سجّل تحصيلًا', 'Recorded a collection', 'وەرگرتنێکی پارەی تۆمارکرد'],
  'finance.cost_approved': ['اعتمد أجرًا', 'Approved a wage', 'کرێیەکی پەسەندکرد'],
  'finance.cost_reversed': ['عكس أجرًا', 'Reversed a wage', 'کرێیەکی پێچەوانەکردەوە'],
  'finance.rule_created': ['أضاف قاعدة أجر', 'Added a wage rule', 'یاسایەکی کرێی زیادکرد'],
  'finance.rule_updated': ['عدّل قاعدة أجر', 'Edited a wage rule', 'یاسایەکی کرێی دەستکاریکرد'],
  'finance.wage_change_applied': ['طبّق تغيير أجر', 'Applied a wage change', 'گۆڕانکارییەکی کرێی جێبەجێکرد'],
  'finance.wage_reconciled': ['أعاد مطابقة الأجور', 'Reconciled wages', 'کرێکانی هاوتاکردەوە'],
  'finance.staff_created': ['أضاف موظفًا', 'Added a staff member', 'کارمەندێکی زیادکرد'],
  'finance.staff_updated': ['عدّل موظفًا', 'Edited a staff member', 'کارمەندێکی دەستکاریکرد'],
  'finance.staff_archived': ['أرشف موظفًا', 'Archived a staff member', 'کارمەندێکی ئەرشیفکرد'],
  'finance.staff_linked': ['ربط موظفًا بحساب', 'Linked a staff member to an account', 'کارمەندێکی بە هەژمارێکەوە بەستەوە'],
  'finance.staff_paid': ['دفع لموظف', 'Paid a staff member', 'پارەی دا بە کارمەندێک'],
  'finance.staff_settled': ['سوّى أجور موظف', 'Settled a staff member’s wages', 'کرێکانی کارمەندێکی یەکلاکردەوە'],
  'finance.staff_cost_adjusted': ['عدّل أجر موظف', 'Adjusted a staff wage', 'کرێی کارمەندێکی ڕێکخست'],
  'finance.staff_cost_materialized': ['ثبّت أجرًا كان معلّقًا', 'Fixed a wage that waited', 'کرێیەکی هەڵپەسێردراوی جێگیرکرد'],
  'finance.staff_percentage_recalculated': ['أعاد حساب أجر بالنسبة', 'Recalculated a percentage wage', 'کرێیەکی ڕێژەیی دووبارە ژماردەوە'],
  'finance.staff_employment_adjusted': ['عدّل أجرًا بتاريخ العمل', 'Adjusted a wage for the employment dates', 'کرێیەکی بەپێی ڕێکەوتی کار ڕێکخست'],
  'finance.staff_recheck_requested': ['طلب إعادة فحص أجور موظف', 'Asked to recheck a staff member’s wages', 'داوای پشکنینەوەی کرێی کارمەندێکی کرد'],
  'finance.advance_settled': ['سوّى سلفة مع الأجور', 'Settled an advance against wages', 'پێشینەیەکی لەگەڵ کرێ یەکلاکردەوە'],
  'finance.center_created': ['أضاف مركز تكلفة', 'Added a cost centre', 'ناوەندێکی تێچووی زیادکرد'],
  'finance.center_updated': ['عدّل مركز تكلفة', 'Edited a cost centre', 'ناوەندێکی تێچووی دەستکاریکرد'],
  'finance.withdrawal_requested': ['طلب سحبًا', 'Requested a withdrawal', 'داوای ڕاکێشانی پارەی کرد'],
  'finance.withdrawal_approved': ['وافق على سحب', 'Approved a withdrawal', 'ڕاکێشانێکی پەسەندکرد'],
  'finance.withdrawal_rejected': ['رفض سحبًا', 'Rejected a withdrawal', 'ڕاکێشانێکی ڕەتکردەوە'],
  'finance.withdrawal_cancelled': ['ألغى سحبًا', 'Cancelled a withdrawal', 'ڕاکێشانێکی هەڵوەشاندەوە'],
  'finance.withdrawal_paid': ['دفع سحبًا', 'Paid a withdrawal', 'ڕاکێشانێکی پارەدا'],
  'accounting.journal_posted': ['سجّل قيدًا يدويًا', 'Posted a manual journal entry', 'تۆمارێکی دەستیی ڕۆژنامەی تۆمارکرد'],
  'accounting.journal_reversed': ['عكس قيدًا يدويًا', 'Reversed a manual journal entry', 'تۆمارێکی دەستیی پێچەوانەکردەوە'],
  'accounting.period_closed': ['أغلق شهرًا', 'Closed a month', 'مانگێکی داخست'],
  'operations.permission_changed': ['غيّر صلاحيات العمليات', 'Changed operations permissions', 'دەسەڵاتەکانی کارکردنی گۆڕی'],
  'stock.lot_cost_adjusted': ['صحّح تكلفة دفعة مخزون', 'Corrected a stock batch cost', 'تێچووی وەجبەیەکی کۆگای ڕاستکردەوە'],
  'investment.contract_created': ['أنشأ اتفاق استثمار', 'Created an investment agreement', 'ڕێککەوتنێکی وەبەرهێنانی دروستکرد'],
  'investment.contract_funded': ['سجّل تمويل اتفاق', 'Recorded an agreement’s funding', 'پارەدانی ڕێککەوتنێکی تۆمارکرد'],
  'investment.contract_voided': ['أبطل اتفاق استثمار', 'Voided an investment agreement', 'ڕێککەوتنێکی وەبەرهێنانی هەڵوەشاندەوە'],
  'investment.legacy_reviewed': ['راجع استثمارًا قديمًا', 'Reviewed an old investment', 'وەبەرهێنانێکی کۆنی پێداچووەوە'],
  'investment.profile_updated': ['عدّل ملف مستثمر', 'Edited an investor’s profile', 'پرۆفایلی وەبەرهێنەرێکی دەستکاریکرد'],
  'investment.surplus_returned': ['أعاد فائضًا لمستثمر', 'Returned a surplus to an investor', 'زیادەیەکی گەڕاندەوە بۆ وەبەرهێنەرێک'],
  'wallet.manual_adjust': ['عدّل محفظة عضو يدويًا', 'Adjusted a member’s wallet by hand', 'جزدانی ئەندامێکی بە دەست ڕێکخست'],
  'wallet.manual_credit': ['أضاف رصيدًا لمحفظة يدويًا', 'Credited a wallet by hand', 'باڵانسی بۆ جزدانێک بە دەست زیادکرد'],
  'wallet.adjustment': ['سوّى محفظة', 'Adjusted a wallet', 'جزدانێکی ڕێکخست'],
  'wallet.rounding_drift': ['سوّى فرق تقريب محفظة', 'Settled a wallet rounding difference', 'جیاوازیی خڕکردنەوەی جزدانێکی یەکلاکردەوە'],
  'wallet.rounding_drift.run': ['شغّل تسوية فروقات التقريب', 'Ran the rounding settlement', 'یەکلاکردنەوەی جیاوازییەکانی خڕکردنەوەی کارپێکرد'],
  'wallet.deposit.approved': ['قبل إيداعًا', 'Approved a deposit', 'پارەدانانێکی پەسەندکرد'],
  'wallet.deposit.rejected': ['رفض إيداعًا', 'Rejected a deposit', 'پارەدانانێکی ڕەتکردەوە'],
  'wallet.withdrawal.approved_for_processing': ['وافق على سحب من محفظة', 'Approved a wallet withdrawal', 'ڕاکێشانێکی جزدانی پەسەندکرد'],
  'wallet.withdrawal.processing': ['بدأ تنفيذ سحب من محفظة', 'Started a wallet withdrawal', 'دەستی کرد بە ڕاکێشانێکی جزدان'],
  'wallet.withdrawal.paid': ['دفع سحبًا من محفظة', 'Paid a wallet withdrawal', 'ڕاکێشانێکی جزدانی پارەدا'],
  'wallet.withdrawal.rejected': ['رفض سحبًا من محفظة', 'Rejected a wallet withdrawal', 'ڕاکێشانێکی جزدانی ڕەتکردەوە'],
  'wallet.withdrawal.failed': ['تعثّر سحب من محفظة', 'A wallet withdrawal failed', 'ڕاکێشانێکی جزدان شکستی هێنا'],
  'wallet.withdrawal.cancelled': ['ألغى سحبًا من محفظة', 'Cancelled a wallet withdrawal', 'ڕاکێشانێکی جزدانی هەڵوەشاندەوە'],
  'wallet.withdrawal.reconciliation_flagged': ['علّم سحبًا للمطابقة', 'Flagged a withdrawal for reconciliation', 'ڕاکێشانێکی بۆ هاوتاکردن نیشانکرد'],
  'wallet.withdrawal.reconciliation_cleared': ['أنهى مطابقة سحب', 'Cleared a withdrawal’s reconciliation', 'هاوتاکردنی ڕاکێشانێکی تەواوکرد'],
  'wallet.withdrawal_fee.changed': ['غيّر رسم السحب', 'Changed the withdrawal fee', 'کرێی ڕاکێشانی گۆڕی'],
  'wallet.store_hold_released': ['أطلق مبلغًا محجوزًا لمتجر', 'Released a store’s held amount', 'بڕێکی ڕاگیراوی فرۆشگایەکی ئازادکرد'],
  'wallet.reconciliation.anomalies': ['وجد فروقًا في مطابقة المحافظ', 'Found wallet reconciliation differences', 'جیاوازیی لە هاوتاکردنی جزدانەکاندا دۆزییەوە'],
  'wallet.review.closed': ['أنهى مراجعة محفظة', 'Closed a wallet review', 'پێداچوونەوەی جزدانێکی داخست'],
};

export type AasKey = keyof typeof AAS;
export const aas = (loc: Loc, key: AasKey) => { const [ar, en, ckb] = AAS[key]; return loc(ar, en, ckb); };
/** What the person did, in the reader's language; an action this table does not know reads as its code. */
export const actionWords = (loc: Loc, action: string) => { const t = ACTION_WORDS[action]; return t ? loc(t[0], t[1], t[2]) : action; };
