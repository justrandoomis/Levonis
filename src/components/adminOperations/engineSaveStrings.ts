/**
 * THE WRITER'S WORDS (owner decision 8: the save that completes a product's
 * pricing shows the new prices first, then adopts the engine and writes them;
 * USD design §5.4 "Review-step preview", §6.1-§6.5; the stale list).
 *
 * In Arabic, English and real Sorani (docs/DECISIONS.md row 183: a `ckb`
 * slot never carries the Arabic). ckb uses the pricing terms — shipping
 * «ناردن», product «بەرهەم» — never «گواستنەوە» or «کاڵا»
 * (tests/engineSaveStrings.test.ts).
 *
 * Pure: no React, no request.
 */
import type { Language } from '../../translations';
import type { EngineAdoption } from './procurementPricing';

type Fill = (v: string) => string;
type Fill2 = (a: string, b: string) => string;

export interface EngineSaveStrings {
  sheetTitle: string;
  adoptIntro: string;
  repriceIntro: string;
  saveAdopt: string;
  saveReprice: string;
  cancel: string;
  saving: string;
  largeTick: string;
  largeNote: string;
  dropFlag: string;
  reviewPending: Fill;
  routeFeeRemoved: string;
  memberBeforeAfter: (tier: string, before: string, after: string) => string;
  legacyStep: string;
  codAsDirect: string;
  reauth: string;
  incomplete: Fill;
  savedAdopted: string;
  savedRepriced: string;
  // The stale list (the «التسعير والشحن» page and the rates panel).
  listTitle: string;
  staleCount: Fill;
  readyCount: Fill;
  staleHint: string;
  readyHint: string;
  reasons: Fill;
  previewAll: string;
  saveAll: string;
  savedCount: Fill2;
  refusedLine: Fill2;
  nothing: string;
  exit: string;
  exitConfirm: string;
}

const ar: EngineSaveStrings = {
  sheetTitle: 'معاينة الأسعار الجديدة قبل الحفظ',
  adoptIntro: 'هذا الحفظ يُكمل بيانات تسعير المنتج: يُعتمد التسعير التلقائي له وتُكتب الأسعار الجديدة أدناه في الخطوة نفسها.',
  repriceIntro: 'هذا المنتج مسعَّر تلقائيًا: يُحفظ هذا التغيير وتُكتب أسعاره الجديدة أدناه في الخطوة نفسها.',
  saveAdopt: 'حفظ واعتماد الأسعار الجديدة',
  saveReprice: 'حفظ الأسعار الجديدة',
  cancel: 'رجوع دون حفظ الأسعار',
  saving: 'جارٍ الحفظ…',
  largeTick: 'أؤكد التغيّر الكبير في السعر',
  largeNote: 'تغيّر أكبر من 15٪ — أكّد، وقد يُطلب تسجيل دخول حديث',
  dropFlag: 'انخفاض أكبر من 30٪ في سعر واحد على الأقل — راجعه قبل الحفظ',
  reviewPending: (rate) => `سعر صرف جديد بانتظار اعتمادك؛ تُحسب هذه الأسعار بالسعر المعتمد الحالي ${rate}`,
  routeFeeRemoved: 'رسم المسار القديم أصبح جزءًا من السعر',
  memberBeforeAfter: (tier, before, after) => `سعر عضو ${tier}: ${before} ← ${after}`,
  legacyStep: 'يرتفع السعر 1,000 د.ع بسبب تقريب الحد الأدنى المرحَّل إلى السنت',
  codAsDirect: 'الدفع عند الاستلام للطلب المسبق يدفع سعر البيع المباشر',
  reauth: 'التغيّر الكبير يحتاج تسجيل دخول حديثًا: سجّل الدخول مجددًا ثم احفظ',
  incomplete: (list) => `تُحفظ البيانات فقط؛ ينقص: ${list}`,
  savedAdopted: 'حُفظ واعتُمد التسعير التلقائي وكُتبت الأسعار الجديدة',
  savedRepriced: 'حُفظت الأسعار الجديدة',
  listTitle: 'منتجات تنتظر حفظ أسعارها الجديدة',
  staleCount: (n) => `تغيّر سعر صرف أو شحن معتمد: ${n}`,
  readyCount: (n) => `اكتملت بياناتها وما زالت يدوية: ${n}`,
  staleHint: 'أسعارها المخزنة حُسبت بسعر تغيّر منذ ذلك؛ عاينها ثم احفظها مرة واحدة (إعادة التسعير التلقائية بتغيّر الصرف في التحديث القادم).',
  readyHint: 'مكتمل — راجع الأسعار الجديدة واحفظ',
  reasons: (list) => `بسبب: ${list}`,
  previewAll: 'معاينة الأسعار الجديدة',
  saveAll: 'حفظ الكل',
  savedCount: (saved, total) => `حُفظ ${saved} من ${total}`,
  refusedLine: (name, why) => `لم يُحفظ ${name}: ${why}`,
  nothing: 'لا شيء ينتظر الحفظ',
  exit: 'رجوع إلى التسعير اليدوي',
  exitConfirm: 'تبقى الأسعار كما هي الآن، ويعود تعديلها يدويًا. متابعة؟',
};

const en: EngineSaveStrings = {
  sheetTitle: 'New prices — preview before saving',
  adoptIntro: "This save completes the product's pricing data: automatic pricing is adopted for it and the new prices below are written in the same step.",
  repriceIntro: 'This product is priced automatically: this change is saved and its new prices below are written in the same step.',
  saveAdopt: 'Save and apply the new prices',
  saveReprice: 'Save the new prices',
  cancel: 'Back without saving the prices',
  saving: 'Saving…',
  largeTick: 'I confirm the large price change',
  largeNote: 'A change above 15% — confirm; a fresh sign-in may be asked',
  dropFlag: 'At least one price falls more than 30% — review it before saving',
  reviewPending: (rate) => `A new exchange rate awaits your approval; these prices use the current approved rate ${rate}`,
  routeFeeRemoved: 'The old route fee is now part of the price',
  memberBeforeAfter: (tier, before, after) => `${tier} member price: ${before} → ${after}`,
  legacyStep: 'The price rises by 1,000 IQD because the migrated minimum is rounded up to the cent',
  codAsDirect: 'Cash-on-delivery pre-orders pay the direct-sale price',
  reauth: 'A large change needs a fresh sign-in: sign in again, then save',
  incomplete: (list) => `Data is saved only; missing: ${list}`,
  savedAdopted: 'Saved: automatic pricing adopted and the new prices written',
  savedRepriced: 'The new prices are saved',
  listTitle: 'Products waiting for their new prices to be saved',
  staleCount: (n) => `An approved exchange or shipping rate changed: ${n}`,
  readyCount: (n) => `Data complete, still priced by hand: ${n}`,
  staleHint: 'Their stored prices were computed at a rate that has changed since; preview them, then save them in one go (automatic repricing on rate changes arrives in the next update).',
  readyHint: 'Complete — review the new prices and save',
  reasons: (list) => `Because of: ${list}`,
  previewAll: 'Preview the new prices',
  saveAll: 'Save all',
  savedCount: (saved, total) => `Saved ${saved} of ${total}`,
  refusedLine: (name, why) => `${name} was not saved: ${why}`,
  nothing: 'Nothing is waiting to be saved',
  exit: 'Back to manual pricing',
  exitConfirm: 'Prices stay exactly as they are now and are edited by hand again. Continue?',
};

const ckb: EngineSaveStrings = {
  sheetTitle: 'پێشبینینی نرخە نوێیەکان پێش پاشەکەوتکردن',
  adoptIntro: 'ئەم پاشەکەوتکردنە زانیارییەکانی نرخدانانی بەرهەمەکە تەواو دەکات: نرخدانانی خۆکاری بۆ دەگیرێتە بەر و نرخە نوێیەکانی خوارەوە لە هەمان هەنگاودا دەنووسرێن.',
  repriceIntro: 'ئەم بەرهەمە بە خۆکاری نرخی بۆ دانراوە: ئەم گۆڕانکارییە پاشەکەوت دەکرێت و نرخە نوێیەکانی خوارەوە لە هەمان هەنگاودا دەنووسرێن.',
  saveAdopt: 'پاشەکەوتکردن و جێبەجێکردنی نرخە نوێیەکان',
  saveReprice: 'پاشەکەوتکردنی نرخە نوێیەکان',
  cancel: 'گەڕانەوە بەبێ پاشەکەوتکردنی نرخەکان',
  saving: 'پاشەکەوت دەکرێت…',
  largeTick: 'گۆڕانە گەورەکەی نرخ پشتڕاست دەکەمەوە',
  largeNote: 'گۆڕانێکی سەرووی 15٪ — پشتڕاستی بکەرەوە؛ لەوانەیە چوونەژوورەوەی نوێ داوا بکرێت',
  dropFlag: 'لانیکەم یەک نرخ زیاتر لە 30٪ دادەبەزێت — پێش پاشەکەوتکردن پێیدا بچۆرەوە',
  reviewPending: (rate) => `نرخێکی نوێی ئاڵوگۆڕ چاوەڕێی پەسەندکردنی تۆیە؛ ئەم نرخانە بە نرخی پەسەندکراوی ئێستا ${rate} هەژمار دەکرێن`,
  routeFeeRemoved: 'کرێی کۆنی ڕێگا ئێستا بەشێکە لە نرخەکە',
  memberBeforeAfter: (tier, before, after) => `نرخی ئەندامی ${tier}: ${before} ← ${after}`,
  legacyStep: 'نرخەکە 1,000 د.ع بەرز دەبێتەوە بەهۆی خڕکردنەوەی کەمترین قازانجی گواستراوە بۆ سەنت',
  codAsDirect: 'پێشداواکاریی پارەدان لە کاتی گەیاندن نرخی فرۆشتنی ڕاستەوخۆ دەدات',
  reauth: 'گۆڕانێکی گەورە چوونەژوورەوەیەکی نوێ دەوێت: دووبارە بچۆ ژوورەوە، پاشان پاشەکەوت بکە',
  incomplete: (list) => `تەنها زانیارییەکان پاشەکەوت دەکرێن؛ کەمە: ${list}`,
  savedAdopted: 'پاشەکەوت کرا: نرخدانانی خۆکار گیرایە بەر و نرخە نوێیەکان نووسران',
  savedRepriced: 'نرخە نوێیەکان پاشەکەوت کران',
  listTitle: 'ئەو بەرهەمانەی چاوەڕێی پاشەکەوتکردنی نرخە نوێیەکانیانن',
  staleCount: (n) => `نرخێکی پەسەندکراوی ئاڵوگۆڕ یان ناردن گۆڕاوە: ${n}`,
  readyCount: (n) => `زانیارییەکانیان تەواوە و هێشتا بە دەست نرخیان بۆ دادەنرێت: ${n}`,
  staleHint: 'نرخە هەڵگیراوەکانیان بە نرخێک هەژمار کراون کە لەو کاتەوە گۆڕاوە؛ پێشبینینیان بکە، پاشان بە یەک جار پاشەکەوتیان بکە (نوێکردنەوەی خۆکاری نرخ بە گۆڕانی ئاڵوگۆڕ لە نوێکردنەوەی داهاتوودا دێت).',
  readyHint: 'تەواوە — نرخە نوێیەکان ببینە و پاشەکەوتیان بکە',
  reasons: (list) => `بەهۆی: ${list}`,
  previewAll: 'پێشبینینی نرخە نوێیەکان',
  saveAll: 'پاشەکەوتکردنی هەموویان',
  savedCount: (saved, total) => `${saved} لە ${total} پاشەکەوت کران`,
  refusedLine: (name, why) => `${name} پاشەکەوت نەکرا: ${why}`,
  nothing: 'هیچ شتێک چاوەڕێی پاشەکەوتکردن نییە',
  exit: 'گەڕانەوە بۆ نرخدانانی دەستی',
  exitConfirm: 'نرخەکان وەک ئێستا دەمێننەوە و دووبارە بە دەست دەستکاری دەکرێن. بەردەوام دەبیت؟',
};

export const ENGINE_SAVE_STRINGS: Readonly<Record<Language, EngineSaveStrings>> = { ar, en, ckb };

export const engineSaveStrings = (lang: Language): EngineSaveStrings => ENGINE_SAVE_STRINGS[lang] ?? ar;

/** Whole dinars as the pricing screens print them (the server's integer; formatting only). */
const money = (v: number | null | undefined) => (v == null ? '—' : `${v.toLocaleString('en-US')} د.ع`);

/** The notices one product's preview raises, in the viewer's language (pure: the sheet and its test read it). */
export function engineNotices(a: EngineAdoption, lang: Language): string[] {
  const s = engineSaveStrings(lang);
  const out: string[] = [];
  if (a.review_pending && a.usd_iqd_rate) out.push(s.reviewPending(a.usd_iqd_rate));
  if (a.legacy_step) out.push(s.legacyStep);
  if (a.cod_priced_as_direct) out.push(s.codAsDirect);
  if (a.rows.some((r) => r.route_fee_removed)) out.push(s.routeFeeRemoved);
  if (a.drop_flag) out.push(s.dropFlag);
  for (const r of a.rows) {
    const label = (lang === 'en' ? r.name_en : lang === 'ckb' ? r.name_ckb : r.name_ar) || r.name_ar || r.name_en;
    if (r.pro_before_iqd != null || r.pro_after_iqd != null)
      out.push(`${label ? `${label} · ` : ''}${s.memberBeforeAfter('Pro', money(r.pro_before_iqd), money(r.pro_after_iqd))}`);
    if (r.prime_before_iqd != null || r.prime_after_iqd != null)
      out.push(`${label ? `${label} · ` : ''}${s.memberBeforeAfter('Prime', money(r.prime_before_iqd), money(r.prime_after_iqd))}`);
  }
  // A model's member prices repeat across its channels: each line once.
  return [...new Set(out)];
}
