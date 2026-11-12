/**
 * «المال والأرباح» → المحاسبة — THE WORDS OF THE BOOKS' OWN CHECKS (the owner's brief, 2026-11-12, part 4: «automated
 * consistency checks»; worker/lib/financeChecks.ts). One table in Arabic, English and Sorani: a key missing a language does
 * not compile, and tests/accountingChecksPage.test.ts holds the Sorani rules of DECISIONS row 183 — the Sorani slot is
 * neither the Arabic nor the English pasted across, has a Sorani letter and no Arabic-only one, and its placeholders agree.
 * Each check has its name and one sentence: what it found and what to do about it. Never an amount here: the page shows
 * the server's money beside the words. Placeholders are {name}; numbers stay Latin, as on every money screen.
 */
import type { FinanceCheckKey } from './types';

type Tri = readonly [ar: string, en: string, ckb: string];
type Loc = (ar: string, en: string, ckb?: string) => string;

export const AS = {
  title: ['فحص الدفاتر', 'Books check', 'پشکنینی دەفتەرەکان'],
  sub: ['يُعاد كل صباح تلقائيًا، وتُبلَّغ مجموعة الإدارة بما يجده دون مبالغ.', 'It runs again every morning, and the admin group is told what it finds, without amounts.', 'هەموو بەیانییەک خۆکارانە دووبارە دەبێتەوە، و گرووپی بەڕێوەبردن بێ بڕی پارە ئاگادار دەکرێتەوە لەوەی دەیدۆزێتەوە.'],
  clear: ['لا شيء يحتاج مراجعة: القيود متوازنة، ولا خطأ ترحيل، ولا تحصيل زائد.', 'Nothing needs a look: the journal balances, no posting failed and nothing was over-collected.', 'هیچ شتێک پێویستی بە پێداچوونەوە نییە: تۆمارەکان هاوسەنگن، هیچ تۆمارکردنێک شکستی نەهێناوە و هیچ پارەیەک زیادە وەرنەگیراوە.'],
  checked: ['فُحص {time}', 'Checked {time}', 'پشکنرا {time}'],
  again: ['افحص الآن', 'Check now', 'ئێستا بپشکنە'],
  failed: ['تعذّر الفحص. أعد المحاولة.', 'The check could not run. Try again.', 'پشکنین نەکرا. دووبارە هەوڵ بدەرەوە.'],
  fault: ['خلل', 'Fault', 'هەڵە'],
  look: ['للمراجعة', 'To review', 'بۆ پێداچوونەوە'],
  more: ['و{n} غيرها', 'and {n} more', 'و {n} دانەی تر'],
  count: ['{n}', '{n}', '{n}'],

  journal_unbalanced: ['قيود مدينها لا يساوي دائنها', 'Journal entries whose debits differ from their credits', 'تۆمارەکانی ڕۆژنامە کە قەرزار و بەستانکارییان یەکسان نییە'],
  journal_unbalancedNote: ['لا يحدث إلا بتعديل يدوي على قاعدة البيانات؛ راجع القيد وصحّحه بقيد عكسي.', 'Only a hand edit to the database makes one; review the entry and correct it with a reversal.', 'تەنها بە دەستکاریی دەستیی بنکەی زانیاری ڕوودەدات؛ تۆمارەکە بپشکنە و بە تۆمارێکی پێچەوانە ڕاستی بکەرەوە.'],
  posting_errors: ['أخطاء ترحيل تنتظر الإعادة', 'Postings that failed and wait to be retried', 'تۆمارکردنی شکستخواردوو کە چاوەڕێی دووبارەکردنەوەن'],
  posting_errorsNote: ['تمنع إغلاق شهرها؛ أعِدها من «دفتر القيود وميزان المراجعة» أدناه.', 'They keep their month from closing; retry them from «Journal and trial balance» below.', 'ڕێگری لە داخستنی مانگەکەیان دەکەن؛ لە «دەفتەری تۆمارەکان و هاوسەنگیی پێداچوونەوە» لە خوارەوە دووبارەیان بکەرەوە.'],
  collections_over_due: ['تحصيل أكثر من المستحق', 'More cash recorded than was due', 'پارەی وەرگیراو زیاترە لە شایستە'],
  collections_over_dueNote: ['سُجّل على الطلب أكثر مما يستحق عند التسليم أو من Gini؛ راجع تحصيلاته.', 'The order has more recorded than was due on delivery or from Gini; review its collections.', 'لەسەر داواکارییەکە زیاتر لەوەی لە کاتی گەیاندن یان لە Gini شایستە بوو تۆمارکراوە؛ وەرگرتنەکانی بپشکنە.'],
  undated_delivered: ['طلبات مسلَّمة بلا تاريخ تسليم صالح', 'Delivered orders with no valid delivery date', 'داواکاریی گەیەنراو بێ ڕێکەوتی گەیاندنی دروست'],
  undated_deliveredNote: ['لا تدخل أي فترة ولا أي رقم حتى يُصحَّح تاريخ تسليمها.', 'They count in no period and no figure until their delivery date is corrected.', 'تا ڕێکەوتی گەیاندنیان ڕاست نەکرێتەوە لە هیچ ماوە و هیچ ژمارەیەکدا ناژمێردرێن.'],
  staff_payment_overallocated: ['دفعات موظفين وُزّع منها أكثر من مبلغها', 'Staff payments shared out beyond their amount', 'پارەدانی کارمەندان کە زیاتر لە بڕەکەیان دابەشکراوە'],
  staff_payment_overallocatedNote: ['ما خُصّص من الدفعة على الأجور أكبر من الدفعة نفسها.', 'What the payment was set against in wages adds up to more than the payment.', 'ئەوەی لە پارەدانەکە بۆ کرێ تەرخانکراوە زیاترە لە خودی پارەدانەکە.'],
  delivered_without_sale: ['طلبات مسلَّمة لم يصل بيعها إلى القيود', 'Delivered orders whose sale never reached the journal', 'داواکاریی گەیەنراو کە فرۆشتنەکەی نەگەیشتووەتە تۆمارەکان'],
  delivered_without_saleNote: ['منذ أول بيع في القيود؛ افتح الطلب وأعد حسابه.', 'Since the journal’s first sale; open the order and recompute it.', 'لە یەکەم فرۆشتنی ناو تۆمارەکانەوە؛ داواکارییەکە بکەرەوە و دووبارە بیژمێرەوە.'],
  cancelled_after_delivery_in_journal: ['طلبات أُلغيت بعد التسليم وما زال بيعها في القيود', 'Orders cancelled after delivery whose sale is still in the journal', 'داواکاریی هەڵوەشێنراو دوای گەیاندن کە فرۆشتنەکەی هێشتا لە تۆمارەکاندایە'],
  cancelled_after_delivery_in_journalNote: ['خرجت من كل الشاشات، ويبقى بيعها في دفتر القيود حتى يُعكس كالمرتجع.', 'They are out of every screen; their sale stays in the journal until it is reversed like a return.', 'لە هەموو پەڕەکان دەرچوون؛ فرۆشتنەکەیان لە دەفتەری تۆمارەکان دەمێنێتەوە تا وەک گەڕاندنەوە پێچەوانە دەکرێتەوە.'],
  walk_backs: ['طلبات أُرجعت من «تم التوصيل» ولم تُلغَ', 'Orders moved back from «delivered» and not cancelled', 'داواکاری کە لە «گەیەنرا» گەڕێنرانەوە و هەڵنەوەشێنرانەوە'],
  walk_backsNote: ['خرجت من أرقام الفترة؛ سلّمها من جديد أو ألغها.', 'They left the period’s figures; deliver them again or cancel them.', 'لە ژمارەکانی ماوەکە دەرچوون؛ دووبارە بیانگەیەنە یان هەڵیانبوەشێنەوە.'],
  cash_on_cancelled: ['طلبات ملغاة عليها تحصيل مسجَّل', 'Cancelled orders with cash recorded on them', 'داواکاریی هەڵوەشێنراو کە پارەی وەرگیراوی لەسەر تۆمارکراوە'],
  cash_on_cancelledNote: ['المال المحصَّل عليها يُردّ للزبون أو يُعاد تصنيفه.', 'The cash collected on them is to be paid back or reclassified.', 'ئەو پارەیەی لەسەریان وەرگیراوە بۆ کڕیار دەگەڕێندرێتەوە یان پۆلێنەکەی دەگۆڕدرێت.'],
  pending_cost_months: ['أشهر لا تُغلق لأن تكاليف فيها معلّقة', 'Months that cannot close while costs wait', 'ئەو مانگانەی داناخرێن چونکە تێچووی هەڵپەسێردراویان تێدایە'],
  pending_cost_monthsNote: ['أكمل التكاليف الناقصة لتلك الأشهر من «التكاليف الناقصة».', 'Complete those months’ missing costs from «Missing costs».', 'تێچووە کەمەکانی ئەو مانگانە لە «تێچووە کەمەکان» تەواو بکە.'],
  expenses_counting_nowhere: ['مصاريف مربوطة بطلبات لا يُحتسب فيها شيء', 'Expenses linked to orders that never count them', 'خەرجی بەستراو بە داواکارییەک کە هەرگیز نایژمێرێت'],
  expenses_counting_nowhereNote: ['مربوطة بطلب ملغى أو طلب متجر أو طلب بلا تاريخ تسليم؛ اربطها بمركز تكلفة أو اجعلها مصروفًا عامًا.', 'Linked to a cancelled order, a store’s order or one with no delivery date; link it to a cost centre or make it a general expense.', 'بەستراوە بە داواکارییەکی هەڵوەشێنراو یان هی فرۆشگایەک یان بێ ڕێکەوتی گەیاندن؛ بە ناوەندی تێچوو بیبەستەرەوە یان بیکە بە خەرجیی گشتی.'],
  courier_money_overdue: ['نقد لدى شركة التوصيل منذ أكثر من 14 يومًا', 'Cash with the courier for over 14 days', 'پارە لای کۆمپانیای گەیاندن زیاتر لە 14 ڕۆژە'],
  courier_money_overdueNote: ['طرود سُلّمت ولم يدفع نقدَها أي تحويل؛ سجّل تحويل الزعيم من «أموال لدى شركة التوصيل» أو طالِب به.', 'Parcels delivered whose cash no transfer has paid yet; record Al-Zaeem’s transfer under «Money with the courier», or ask for it.', 'پاکەتی گەیەنراو کە هێشتا هیچ گواستنەوەیەک پارەکەی نەداوە؛ گواستنەوەکە لە «پارە لای کۆمپانیای گەیاندن» تۆمار بکە، یان داوای بکە.'],
  courier_transfers_unchecked: ['تحويلات من شركة التوصيل لم تُطابَق منذ أكثر من 7 أيام', 'Courier transfers not checked for over 7 days', 'گواستنەوەی کۆمپانیای گەیاندن کە زیاتر لە 7 ڕۆژە بەراورد نەکراون'],
  courier_transfers_uncheckedNote: ['طابِق كل تحويل مع كشف الزعيم، ثم اضغط «تمت المطابقة» في «أموال لدى شركة التوصيل».', 'Check each transfer against Al-Zaeem’s statement, then press «Mark checked» under «Money with the courier».', 'هەر گواستنەوەیەک لەگەڵ کەشفی کۆمپانیاکە بەراورد بکە، پاشان لە «پارە لای کۆمپانیای گەیاندن» «بەراوردکرا» دابگرە.'],
} as const satisfies Record<string, Tri>;

export type AsKey = keyof typeof AS;

export function acs(loc: Loc, key: AsKey, vars: Record<string, string | number> = {}): string {
  const [ar, en, ckb] = AS[key];
  return loc(ar, en, ckb).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

/** A check's name and its one sentence. */
export const checkWords = (loc: Loc, key: FinanceCheckKey) => ({ title: acs(loc, key), note: acs(loc, `${key}Note` as AsKey) });
