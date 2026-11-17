/**
 * «الحساب باختصار» — THE PERSON STATEMENT, IN THREE LANGUAGES (owner request
 * 2026-11-17: a person who works and invests «did not know what he earns from
 * work, what he earns from investing, what remains, how much he can withdraw,
 * what his profit is from invest 1 and 2»).
 *
 * The words of src/components/financePeople/PersonStatement.tsx: the money
 * flow (earned − paid − in a withdrawal request − waiting = can withdraw now,
 * for work, for investing and together), the numbered investments table, and
 * the owner's one-line-per-person summaries on the Staff and Investors pages.
 * Labels are neutral (no "you" / "he"), as in personFinanceStrings.ts, so the
 * owner and the person read the same words. The Sorani is its own, never the
 * Arabic (docs/DECISIONS.md row 183; tests/personStatement.test.ts).
 */
import type { Language } from '../translations';

export interface PersonStatementStrings {
  flowTitle: string;
  flowHint: string;
  colWork: string;
  colInvest: string;
  colTotal: string;
  earned: string;
  paid: string;
  reserved: string;
  held: string;
  waiting: string;
  debt: string;
  available: string;
  capitalBack: string;
  canWithdraw: string;
  investTitle: string;
  investHint: string;
  invNo: (n: number) => string;
  item: string;
  capital: string;
  share: string;
  sold: string;
  unitsLeft: (n: number) => string;
  returnPct: string;
  waitingShort: string;
  stageIncoming: string;
  stageSoldOut: string;
  stageSelling: string;
  earnedWork: string;
  earnedInvest: string;
  withdrawHint: string;
  profit: string;
  profitAvailable: string;
  capitalReturned: string;
  total: string;
  other: string;
  unitsOf: (sold: number, all: number) => string;
  staffSummary: string;
  investorSummary: string;
  summaryHint: string;
  name: string;
  open: string;
}

export const PERSON_STATEMENT_STRINGS: Readonly<Record<Language, PersonStatementStrings>> = {
  ar: {
    flowTitle: 'الحساب باختصار',
    flowHint: 'كل المبالغ منذ البداية، لا للفترة المختارة فقط. المكتسب ناقص ما دُفع وما ينتظر = المتاح للسحب.',
    colWork: 'من العمل',
    colInvest: 'من الاستثمار',
    colTotal: 'المجموع',
    earned: 'المكتسب',
    paid: 'دُفع واستُلم',
    reserved: 'في طلب سحب لم يُدفع بعد',
    held: 'ينتظر، لم يُتح بعد',
    waiting: 'ينتظر أو في طلب سحب',
    debt: 'دُفع أكثر من المكتسب (يُسترد من أرباح قادمة)',
    available: 'الباقي المتاح للسحب',
    capitalBack: 'رأس مال رجع ويمكن سحبه',
    canWithdraw: 'يمكن سحبه الآن',
    investTitle: 'الاستثمارات واحدًا واحدًا',
    investHint: 'لكل استثمار: رأس ماله، حصته، ما بيع منه وما بقي، وربحه.',
    invNo: (n) => `استثمار ${n}`,
    item: 'الاستثمار',
    capital: 'رأس المال',
    share: 'الحصة',
    sold: 'مباع من الكل',
    unitsLeft: (n) => `باقٍ ${n}`,
    returnPct: 'العائد',
    waitingShort: 'ينتظر',
    stageIncoming: 'جزء من البضاعة لم يصل بعد',
    stageSoldOut: 'بيعت كل القطع',
    stageSelling: 'قيد البيع',
    earnedWork: 'المكتسب من العمل',
    earnedInvest: 'المكتسب من الاستثمار',
    withdrawHint: 'التفصيل كاملًا في «الحساب باختصار» أدناه.',
    profit: 'الربح المكتسب',
    profitAvailable: 'منه متاح',
    capitalReturned: 'رأس المال الراجع',
    total: 'المجموع',
    other: 'أرباح خارج هذه الاتفاقات',
    unitsOf: (sold, all) => `${sold} من ${all}`,
    staffSummary: 'ملخص الموظفين',
    investorSummary: 'ملخص المستثمرين',
    summaryHint: 'سطر لكل شخص، منذ البداية. اضغط الاسم لفتح حسابه.',
    name: 'الاسم',
    open: 'فتح الحساب',
  },
  en: {
    flowTitle: 'The account at a glance',
    flowHint: 'All amounts since the start, not just the chosen period. Earned minus what was paid and what is waiting = available to withdraw.',
    colWork: 'From work',
    colInvest: 'From investing',
    colTotal: 'Total',
    earned: 'Earned',
    paid: 'Paid out',
    reserved: 'In a withdrawal request, not paid yet',
    held: 'Waiting, not available yet',
    waiting: 'Waiting or in a request',
    debt: 'Paid beyond earnings (recovered from future earnings)',
    available: 'Left to withdraw',
    capitalBack: 'Capital returned and withdrawable',
    canWithdraw: 'Can withdraw now',
    investTitle: 'Each investment',
    investHint: 'For each investment: its capital, share, what sold and what is left, and its profit.',
    invNo: (n) => `Investment ${n}`,
    item: 'Investment',
    capital: 'Capital',
    share: 'Share',
    sold: 'Sold of all',
    unitsLeft: (n) => `${n} left`,
    returnPct: 'Return',
    waitingShort: 'Waiting',
    stageIncoming: 'Some goods have not arrived yet',
    stageSoldOut: 'All units sold',
    stageSelling: 'Selling',
    earnedWork: 'Earned from work',
    earnedInvest: 'Earned from investing',
    withdrawHint: 'The full breakdown is in “The account at a glance” below.',
    profit: 'Profit earned',
    profitAvailable: 'Of it available',
    capitalReturned: 'Capital returned',
    total: 'Total',
    other: 'Profit outside these agreements',
    unitsOf: (sold, all) => `${sold} of ${all}`,
    staffSummary: 'Staff summary',
    investorSummary: 'Investors summary',
    summaryHint: 'One line per person, since the start. Press a name to open the account.',
    name: 'Name',
    open: 'Open account',
  },
  ckb: {
    flowTitle: 'کورتەی هەژمار',
    flowHint: 'هەموو بڕەکان لە سەرەتاوە، نەک تەنها بۆ ماوەی هەڵبژێردراو. بەدەستهاتوو کەمتر لە دراو و چاوەڕوان = بەردەست بۆ ڕاکێشان.',
    colWork: 'لە کارەوە',
    colInvest: 'لە وەبەرهێنانەوە',
    colTotal: 'کۆی گشتی',
    earned: 'بەدەستهاتوو',
    paid: 'دراوە و وەرگیراوە',
    reserved: 'لە داواکاریی ڕاکێشاندا، هێشتا نەدراوە',
    held: 'چاوەڕوانە، هێشتا بەردەست نییە',
    waiting: 'چاوەڕوانە یان لە داواکاریدایە',
    debt: 'زیاتر لە بەدەستهاتوو دراوە (لە قازانجی داهاتوو دەگەڕێتەوە)',
    available: 'ماوەی بەردەست بۆ ڕاکێشان',
    capitalBack: 'سەرمایەی گەڕاوە کە دەتوانرێت ڕابکێشرێت',
    canWithdraw: 'ئێستا دەتوانرێت ڕابکێشرێت',
    investTitle: 'وەبەرهێنانەکان یەک بە یەک',
    investHint: 'بۆ هەر وەبەرهێنانێک: سەرمایەکەی، بەشەکەی، چەند فرۆشراوە و چەند ماوە، و قازانجەکەی.',
    invNo: (n) => `وەبەرهێنانی ${n}`,
    item: 'وەبەرهێنان',
    capital: 'سەرمایە',
    share: 'بەش',
    sold: 'فرۆشراو لە کۆی',
    unitsLeft: (n) => `${n} ماوە`,
    returnPct: 'گەڕانەوە',
    waitingShort: 'چاوەڕوان',
    stageIncoming: 'بەشێک لە کاڵاکان هێشتا نەگەیشتوون',
    stageSoldOut: 'هەموو پارچەکان فرۆشران',
    stageSelling: 'لە فرۆشتندایە',
    earnedWork: 'بەدەستهاتوو لە کار',
    earnedInvest: 'بەدەستهاتوو لە وەبەرهێنان',
    withdrawHint: 'وردەکاریی تەواو لە «کورتەی هەژمار» لە خوارەوەیە.',
    profit: 'قازانجی بەدەستهاتوو',
    profitAvailable: 'لەوە بەردەستە',
    capitalReturned: 'سەرمایەی گەڕاوە',
    total: 'کۆی گشتی',
    other: 'قازانج لە دەرەوەی ئەم ڕێککەوتنانە',
    unitsOf: (sold, all) => `${sold} لە ${all}`,
    staffSummary: 'کورتەی کارمەندان',
    investorSummary: 'کورتەی وەبەرهێنەران',
    summaryHint: 'هێڵێک بۆ هەر کەسێک، لە سەرەتاوە. ناوەکە دابگرە بۆ کردنەوەی هەژمارەکەی.',
    name: 'ناو',
    open: 'کردنەوەی هەژمار',
  },
};

export const personStatementStrings = (lang: Language): PersonStatementStrings => PERSON_STATEMENT_STRINGS[lang] ?? PERSON_STATEMENT_STRINGS.ar;
