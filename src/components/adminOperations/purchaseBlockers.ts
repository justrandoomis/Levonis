/**
 * WHY «التالي» CANNOT MOVE YET (owner report 2026-11-03: «لا أستطيع الضغط على التالي»).
 *
 * The purchase wizard greyed out «التالي» and the step tabs with no word on why: an item without
 * its raw supplier price, an unsaved price edit in a card or a route without its freight rate all
 * looked the same. Every check the button makes is named here, with the item it is about and the
 * field that fixes it, in the order of the steps, so the footer can list them and «اذهب» can take
 * the owner straight to the field.
 *
 * Pure: the panel hands in the results of its own checks (the same expressions that gate the
 * button), so this list explains the gate and never decides it.
 */
import type { FundingProblem } from './PurchaseFundingFields';

export type PurchaseStep = 0 | 1 | 2 | 3;
type Lang = 'ar' | 'en' | 'ckb';

export interface PurchaseLineCheck {
  label: string;
  /** The DOM id prefix of the line's fields: `<key>-qty`, `-invoiced`, `-origins`, `-raw`, `-packed`, `-pricing`. */
  key: string;
  /** The ordered quantity: a whole number, 1 or more. */
  quantity: boolean;
  /** The invoice quantity: a whole number, 0 or more. */
  invoiced: boolean;
  origins: boolean;
  raw: boolean;
  rawMode: 'unit' | 'total';
  /** The packed weight or volume a freight route needs; null when no route asks for it. */
  packed: boolean | null;
  pendingPrice: boolean;
}

export interface PurchaseChargeCheck {
  title: string;
  problems: readonly string[];
}

export interface PurchaseCheckInput {
  nameValid: boolean;
  /** What an investor-funded draft lacks (`fundingProblems`); empty for the store's own money. */
  funding: readonly FundingProblem[];
  lines: readonly PurchaseLineCheck[];
  trackedOverLimit: boolean;
  currency: string;
  exchangeRateValid: boolean;
  /** A route is chosen and its freight rate is a number ≥ 0 (null: no route). */
  freightRateValid: boolean | null;
  basis: 'weight' | 'volume' | null;
  /** The document rate against the approved central rate (`rateStanding`). */
  rate: 'iqd' | 'ok' | 'far' | 'missing';
  rateConfirmed: boolean;
  rateMissingText: string;
  rateFarText: string;
  charges: readonly PurchaseChargeCheck[];
  serialsOverLimit: boolean;
  serialsNeedFinal: boolean;
  totalsValid: boolean;
}

export interface PurchaseBlocker {
  id: string;
  /** The step where it is fixed. */
  step: PurchaseStep;
  text: string;
  /** The element «اذهب» scrolls to and focuses; null when the step itself is the place. */
  target: string | null;
}

const pick = (lang: Lang, ar: string, en: string, ckb: string) => (lang === 'ar' ? ar : lang === 'ckb' ? ckb : en);

/** Everything that stops the purchase from moving on, step by step (fix the earliest first). */
export function purchaseBlockers(input: PurchaseCheckInput, lang: Lang): PurchaseBlocker[] {
  const t = (ar: string, en: string, ckb: string) => pick(lang, ar, en, ckb);
  const out: PurchaseBlocker[] = [];
  const add = (id: string, step: PurchaseStep, text: string, target: string | null = null) => out.push({ id, step, text, target });

  // Step 1 · funding (the name sits above every step and is checked on each).
  if (!input.nameValid) add('name', 0, t('اسم الشراء أطول من المسموح؛ اختصره.', 'The purchase name is too long; shorten it.', 'ناوی کڕینەکە زۆر درێژە؛ کورتی بکەرەوە.'), 'purchase-name');
  const funding: Record<FundingProblem, [string, string, string, string]> = {
    account: ['اختر حساب المستثمر.', 'Choose the investor account.', 'هەژماری وەبەرهێنەر هەڵبژێرە.', 'purchase-funding-account'],
    agreed: ['أدخل الاستثمار المتفق عليه بالدينار، عددًا صحيحًا أكبر من صفر.', 'Enter the agreed investment in IQD, a whole number above zero.', 'وەبەرهێنانی ڕێککەوتوو بە دینار بنووسە، ژمارەیەکی تەواو لە سەرووی سفر.', 'purchase-funding-agreed'],
    received: ['المبلغ المستلم فعليًا عدد صحيح، 0 أو أكثر، أو اتركه فارغًا.', 'Money actually received is a whole number, 0 or more, or left empty.', 'بڕی وەرگیراو ژمارەیەکی تەواوە، 0 یان زیاتر، یان بەتاڵی بهێڵەوە.', 'purchase-funding-received'],
    profit: ['اجعل نسبة ربح المستثمر بين 0 و100%.', 'Set the investor profit share between 0 and 100%.', 'ڕێژەی قازانجی وەبەرهێنەر لە نێوان 0 و 100% دابنێ.', 'purchase-funding-profit'],
    loss: ['اجعل نسبة تحمّل الخسارة بين 0 و100% («الخسارة والإعداد الافتراضي»).', 'Set the loss share between 0 and 100% (“Loss and defaults”).', 'ڕێژەی هەڵگرتنی زیان لە نێوان 0 و 100% دابنێ («زیان و ڕێکخستنی بنەڕەتی»).', 'purchase-funding-loss'],
    reference: ['لمبلغ مستلم أدخل مرجع التحويل وتاريخ الاستلام.', 'For money received, enter the transfer reference and the receipt date.', 'بۆ پارەی وەرگیراو، ژمارەی حەواڵە و ڕێکەوتی وەرگرتن بنووسە.', 'purchase-funding-reference'],
  };
  input.funding.forEach((p) => {
    const [ar, en, ckb, target] = funding[p];
    add(`funding:${p}`, 0, t(ar, en, ckb), target);
  });

  // Step 2 · products.
  if (!input.lines.length) add('lines', 1, t('أضف منتجًا واحدًا على الأقل.', 'Add at least one item.', 'لانیکەم یەک بەرهەم زیاد بکە.'), 'purchase-add-item');
  input.lines.forEach((l) => {
    if (!l.quantity) add(`${l.key}:qty`, 1, t(`أدخل الكمية المطلوبة عددًا صحيحًا، 1 أو أكثر: ${l.label}`, `Enter the ordered quantity as a whole number, 1 or more: ${l.label}`, `بڕی داواکراو بە ژمارەیەکی تەواو بنووسە، 1 یان زیاتر: ${l.label}`), `${l.key}-qty`);
    if (!l.invoiced) add(`${l.key}:invoiced`, 1, t(`أدخل كمية الفاتورة عددًا صحيحًا، 0 أو أكثر: ${l.label}`, `Enter the invoice quantity as a whole number, 0 or more: ${l.label}`, `بڕی پسوولە بە ژمارەیەکی تەواو بنووسە، 0 یان زیاتر: ${l.label}`), `${l.key}-invoiced`);
    if (!l.origins) add(`${l.key}:origins`, 1, t(`أكمل رقم طلب المورد لكل قطعة: ${l.label}`, `Complete the supplier order number of every unit: ${l.label}`, `ژمارەی داواکاریی دابینکەر بۆ هەموو پارچەکان تەواو بکە: ${l.label}`), `${l.key}-origins`);
  });
  if (input.trackedOverLimit) add('tracked', 1, t(
    'أكثر من 5000 قطعة بمرجع فردي؛ وزّع الكمية على أكثر من أمر شراء.',
    'More than 5,000 individually tracked units; split them across purchases.',
    'زیاتر لە 5000 پارچەی شوێنکەوتنکراو؛ بڕەکە بەسەر چەند کڕینێکدا دابەش بکە.',
  ));

  // Step 3 · costs and freight.
  if (input.currency !== 'IQD' && !input.exchangeRateValid) add('exchange', 2, t(
    `أدخل سعر ${input.currency} الواحد بالدينار العراقي.`,
    `Enter the IQD rate for one ${input.currency}.`,
    `نرخی یەک ${input.currency} بە دیناری عێراقی بنووسە.`,
  ), 'purchase-rate');
  if (input.rate === 'missing') add('rate-missing', 2, input.rateMissingText, 'purchase-rate');
  else if (input.rate === 'far' && !input.rateConfirmed) add('rate-far', 2, input.rateFarText, 'purchase-rate-confirm');
  if (input.freightRateValid === false) add('freight', 2, t(
    input.basis === 'volume' ? 'أدخل سعر شحن المتر المكعب بالدينار العراقي.' : 'أدخل سعر شحن الكيلوغرام بالدينار العراقي.',
    input.basis === 'volume' ? 'Enter the freight rate per cubic metre in IQD.' : 'Enter the freight rate per kilogram in IQD.',
    input.basis === 'volume' ? 'نرخی ناردنی هەر مەترێکی سێجا بە دیناری عێراقی بنووسە.' : 'نرخی ناردنی هەر کیلۆگرامێک بە دیناری عێراقی بنووسە.',
  ), 'purchase-freight');
  input.lines.forEach((l) => {
    if (!l.raw) add(`${l.key}:raw`, 2, l.rawMode === 'total'
      ? t(`أدخل إجمالي سعر الشراء الخام من المورد: ${l.label}`, `Enter the raw supplier purchase total: ${l.label}`, `کۆی نرخی کڕینی خاو لە دابینکەر بنووسە: ${l.label}`)
      : t(`أدخل سعر شراء القطعة الخام من المورد: ${l.label}`, `Enter the raw supplier unit price: ${l.label}`, `نرخی کڕینی خاوی پارچە لە دابینکەر بنووسە: ${l.label}`), `${l.key}-raw`);
    if (l.packed === false) add(`${l.key}:packed`, 2, input.basis === 'volume'
      ? t(`أدخل حجم الكرتون مع التغليف (CBM): ${l.label}`, `Enter the packed carton volume (CBM): ${l.label}`, `قەبارەی کارتۆن لەگەڵ پاکێج (CBM) بنووسە: ${l.label}`)
      : t(`أدخل وزن الكرتون مع التغليف بالكيلوغرام: ${l.label}`, `Enter the packed carton weight (kg): ${l.label}`, `کێشی کارتۆن لەگەڵ پاکێج بە کیلۆگرام بنووسە: ${l.label}`), `${l.key}-packed`);
  });
  input.charges.forEach((c, j) => {
    const p = c.problems[0];
    if (!p) return;
    const name = c.title.trim();
    // An expense with no name yet is called that, never «»: the sentence still says which one.
    const it = name
      ? { ar: `المصروف «${name}»`, en: `the expense “${name}”`, ckb: `خەرجیی «${name}»` }
      : { ar: 'المصروف الذي بلا اسم', en: 'the unnamed expense', ckb: 'خەرجییە بێ ناوەکە' };
    const id = `purchase-charge-${j}`;
    if (p === 'review') add(`charge:${j}`, 2, t(`قرّر بشأن ${it.ar}: هل هو شحن أم لا.`, `Decide on ${it.en}: is it freight or not?`, `بڕیار لەسەر ${it.ckb} بدە: کرێی ناردنە یان نا؟`), id);
    else if (p === 'title') add(`charge:${j}`, 2, t('اكتب اسم المصروف الإضافي.', 'Name the extra expense.', 'ناوی خەرجییە زیادەکە بنووسە.'), `${id}-title`);
    else if (p === 'amount') add(`charge:${j}`, 2, t(`أدخل مبلغ ${it.ar} أو احذفه.`, `Enter the amount of ${it.en}, or remove it.`, `بڕی ${it.ckb} بنووسە، یان بیسڕەوە.`), `${id}-amount`);
    else if (p === 'lines') add(`charge:${j}`, 2, t(`اختر البنود التي يشملها ${it.ar}.`, `Choose the items ${it.en} covers.`, `ئەو بەندانە هەڵبژێرە کە ${it.ckb} دەیانگرێتەوە.`), `${id}-lines`);
    else add(`charge:${j}`, 2, t(`أكمل ما يحتاجه توزيع ${it.ar} أو اختر توزيعًا آخر.`, `Complete what the split of ${it.en} needs, or choose another split.`, `ئەوەی دابەشکردنی ${it.ckb} پێویستیەتی تەواو بکە، یان شێوازێکی تر هەڵبژێرە.`), `${id}-basis`);
  });
  if (!input.totalsValid) add('totals', 2, t('المجموع خارج الحد المسموح؛ راجع الكميات والأسعار.', 'The total is out of range; check the quantities and prices.', 'کۆی گشتی لە سنوور دەرچووە؛ بڕ و نرخەکان بپشکنە.'));
  if (input.serialsOverLimit) add('serials-limit', 2, t(
    'يمكن تسجيل 50 رقمًا تسلسليًا مع التأكيد؛ سجّل البقية بعد حفظ الشراء.',
    'Up to 50 serials can be registered with the confirmation; add the rest after saving.',
    'لەگەڵ پشتڕاستکردنەوە تا 50 ژمارەی زنجیرەیی تۆمار دەکرێت؛ ئەوانی تر دوای پاشەکەوتکردن زیاد بکە.',
  ));
  if (input.serialsNeedFinal) add('serials-final', 2, t(
    'ثبّت التكلفة النهائية قبل شراء يحتوي على أرقام تسلسلية («حالة التكلفة» أسفل الخطوة).',
    'Set the cost status to final before a purchase with serial numbers (“Cost status” at the bottom of this step).',
    'پێش کڕینێک کە ژمارەی زنجیرەیی تێدایە، دۆخی تێچوو بکە بە کۆتایی («دۆخی تێچوو» لە خوارەوەی ئەم هەنگاوە).',
  ), 'purchase-cost-state');
  input.lines.forEach((l) => {
    if (l.pendingPrice) add(`${l.key}:price`, 2, t(
      `احفظ تعديلات السعر في بطاقة «${l.label}» أو تراجع عنها.`,
      `Save or discard the price edits in the “${l.label}” card.`,
      `دەستکارییەکانی نرخ لە کارتی «${l.label}» پاشەکەوت بکە یان پاشگەزببەوە.`,
    ), `${l.key}-pricing`);
  });
  return out;
}

/** The blockers that keep the owner on `step` (everything fixed at it or before it). */
export const blockersUpTo = (all: readonly PurchaseBlocker[], step: number) => all.filter((b) => b.step <= step);

/** The footer's heading and the «اذهب» button, in the three languages. */
export const purchaseBlockerStrings = (lang: Lang) => ({
  title: pick(lang, 'لإكمال هذه الخطوة:', 'To finish this step:', 'بۆ تەواوکردنی ئەم هەنگاوە:'),
  confirmTitle: pick(lang, 'قبل تأكيد الشراء:', 'Before you confirm the purchase:', 'پێش پشتڕاستکردنەوەی کڕینەکە:'),
  go: pick(lang, 'اذهب', 'Go', 'بڕۆ'),
  more: (n: number) => pick(lang, `و${n} غيرها بعد ذلك`, `and ${n} more after that`, `و ${n} ی تر دوای ئەوە`),
  generic: pick(lang, 'أكمل البيانات المطلوبة في هذه الخطوة.', 'Complete the required details on this step.', 'زانیارییە پێویستەکانی ئەم هەنگاوە تەواو بکە.'),
  required: pick(lang, 'مطلوب لحساب التكلفة.', 'Needed to work out the cost.', 'بۆ هەژمارکردنی تێچوو پێویستە.'),
  quantity: pick(lang, 'عدد صحيح، 1 أو أكثر.', 'A whole number, 1 or more.', 'ژمارەیەکی تەواو، 1 یان زیاتر.'),
  invoiced: pick(lang, 'عدد صحيح، 0 أو أكثر.', 'A whole number, 0 or more.', 'ژمارەیەکی تەواو، 0 یان زیاتر.'),
});
