/**
 * A server issue in the reader's language. The server lists what blocks a save or a publish in
 * English (`path: message` — packages/pricing/src/printerServices.ts configIssues / publishIssues,
 * worker/lib/printerServices.ts printerExtrasCatalogIssues). Every known one is said in words, and a
 * kit or an add-on is named by its TITLE, never by its code; an unknown one keeps the server's line
 * (shown left-to-right).
 */
import { formatIqd } from '../../lib/api';
import {
  MAX_DISCOUNT_FIXED_IQD,
  MAX_DISCOUNT_PERCENT,
  MAX_KITS,
  MAX_KIT_ITEMS,
  MAX_KIT_ITEM_QTY,
  type FilamentKit,
  type PrinterAddon,
} from '../../../packages/pricing/src/printerServices';
import { careIssueText } from './CareTermsPanel';
import { S, pkgName, say, type Loc } from './adminPrinterStrings';

type Titled = { id: string; title: { ar: string; en: string; ckb: string } | null };
const titleOf = (x: Titled | undefined, loc: Loc) => (x?.title ? loc(x.title.ar, x.title.en, x.title.ckb || x.title.en).trim() : '');

export function issueText(
  issue: string, loc: Loc, kits: readonly FilamentKit[] = [], addons: readonly PrinterAddon[] = []
): { text: string; translated: boolean } {
  const care = careIssueText(issue, loc);
  if (care) return { text: care, translated: true };

  /** `kits[2]` (by position) or `kits.kit-3` (by id) → the kit's own title, or its place in the list. */
  const named = (ref: string, list: readonly Titled[], kind: 'kits' | 'addons') => {
    const at = new RegExp(`^${kind}\\[(\\d+)\\]$`).exec(ref);
    const n = at ? Number(at[1]) : list.findIndex((x) => x.id === ref.slice(kind.length + 1));
    const title = titleOf(list[n], loc);
    const place = n >= 0 ? ` ${n + 1}` : '';
    return kind === 'kits'
      ? title ? loc(`الباقة «${title}»`, `Kit «${title}»`, `پاکێجی «${title}»`) : loc(`الباقة${place}`, `Kit${place}`, `پاکێجی${place}`)
      : title ? loc(`الإضافة «${title}»`, `Add-on «${title}»`, `زیادکراوی «${title}»`) : loc(`الإضافة${place}`, `Add-on${place}`, `زیادکراوی${place}`);
  };
  const kitName = (ref: string) => named(ref, kits, 'kits');
  const addonName = (ref: string) => named(ref, addons, 'addons');
  const n1 = (v: string) => Number(v) + 1;
  const discountRule = loc(
    `الخصم: نسبة من 1 إلى ${MAX_DISCOUNT_PERCENT}% أو مبلغ ثابت لكل طابعة حتى ${formatIqd(MAX_DISCOUNT_FIXED_IQD)}`,
    `discount: 1 to ${MAX_DISCOUNT_PERCENT}% or a fixed amount per printer up to ${formatIqd(MAX_DISCOUNT_FIXED_IQD)}`,
    `داشکاندن: لە 1 تا ${MAX_DISCOUNT_PERCENT}% یان بڕێکی جێگیر بۆ هەر پرینتەرێک تا ${formatIqd(MAX_DISCOUNT_FIXED_IQD)}`
  );
  const noColour = loc('لا ألوان مفعّلة له ليختار الزبون منها', 'it has no active colour for the customer to pick', 'هیچ ڕەنگێکی چالاکی نییە بۆ ئەوەی کڕیار هەڵیبژێرێت');
  const gone = loc('أحد منتجاتها لم يعد موجوداً — احذفه منها', 'one of its products no longer exists — remove it', 'یەکێک لە بەرهەمەکانی ئیتر بوونی نییە — لای ببە');
  const otherPrinter = loc('مربوطة بطابعة لم تُختر لها عائلة ضمان وفئة توصيل', 'tied to a printer with no warranty family and delivery class yet', 'بە پرینتەرێکەوە بەستراوە کە هێشتا خێزانی گەرەنتی و پۆلی گەیاندنی بۆ هەڵنەبژێردراوە');
  const pkgIssue = (id: string, text: string) => `${say(loc, pkgName(id as 'smart' | 'complete'))}: ${text}`;

  const rules: Array<[RegExp, (m: RegExpExecArray) => string]> = [
    // The printer's own mapping.
    [/^products: map at least one printer/, () => loc('اختر عائلة الضمان وفئة التوصيل لطابعة واحدة على الأقل', 'choose a warranty family and a delivery class for at least one printer', 'لانیکەم بۆ یەک پرینتەر خێزانی گەرەنتی و پۆلی گەیاندن هەڵبژێرە')],
    [/^products\.\S+: no warranty family$/, () => loc('اختر عائلة الضمان لهذه الطابعة', 'choose this printer\'s warranty family', 'خێزانی گەرەنتی ئەم پرینتەرە هەڵبژێرە')],
    [/^products\.\S+: no delivery class$/, () => loc('اختر فئة التوصيل لهذه الطابعة', 'choose this printer\'s delivery class', 'پۆلی گەیاندنی ئەم پرینتەرە هەڵبژێرە')],
    [/^products\.\S+: no version has both/, () => loc('لا توجد نسخة تجمع عائلة ضمان وفئة توصيل معاً — اخترهما للطابعة نفسها', 'no version has both a warranty family and a delivery class — choose both for the printer itself', 'هیچ وەشانێک خێزانی گەرەنتی و پۆلی گەیاندنی پێکەوە نییە — هەردووکیان بۆ پرینتەرەکە خۆی هەڵبژێرە')],
    // Phase 6 (DECISIONS row 362): the price anchor and the warehouse pickup.
    [/^price_anchor: the Smart package is off/, () => loc('«سعر الطابعة هو سعر الاختيار الذكي» مفعّل وباقة الاختيار الذكي موقوفة — فعّل الباقة أو أوقف هذا الخيار', '«The price is the Smart Choice price» is on but the Smart Choice package is off — switch the package on, or this switch off', '«نرخەکە نرخی هەڵبژاردنی زیرەکە» چالاکە بەڵام پاکێجی هەڵبژاردنی زیرەک ڕاگیراوە — پاکێجەکە چالاک بکە یان ئەم هەڵبژاردەیە ڕابگرە')],
    [/^price_anchor: /, () => loc('خيار «ماذا يتضمن سعر الطابعة» غير صالح', 'the «what the price includes» choice is not valid', 'هەڵبژاردەی «نرخی پرینتەر چی تێدایە» دروست نییە')],
    [/^products\.\S+: the Smart package is not priced/, () => loc('باقة الاختيار الذكي غير مسعّرة لعائلة ضمان هذه الطابعة — ضع سعر ضمانها، أو أوقف «سعر الطابعة هو سعر الاختيار الذكي»', 'the Smart Choice package has no price for this printer\'s warranty family — price its warranty, or switch «the price is the Smart Choice price» off', 'پاکێجی هەڵبژاردنی زیرەک بۆ خێزانی گەرەنتی ئەم پرینتەرە نرخی نییە — نرخی گەرەنتییەکەی دابنێ، یان «نرخەکە نرخی هەڵبژاردنی زیرەکە» ڕابگرە')],
    [/^delivery\.pickup/, () => say(loc, S.pickupNoteRule)],
    // The two ready packages.
    [/^packages\.(smart|complete): includes Levo Care, which is not priced/, (m) => pkgIssue(m[1], loc('فيها ليفو كير وليس له سعر — ضع سعره أو أوقف الباقة', 'it includes Levo Care, which has no price — price it or switch the package off', 'لیڤۆ کێری تێدایە و نرخی نییە — نرخی بۆ دابنێ یان پاکێجەکە ڕابگرە'))],
    [/^packages\.(smart|complete): includes extra packaging, which is not priced/, (m) => pkgIssue(m[1], loc('فيها تغليف الحماية الإضافية وليس له سعر', 'it includes extra packaging, which has no price', 'پێچانەوەی زیادەی تێدایە و نرخی نییە'))],
    [/^packages\.(smart|complete): includes the inspection, which is not priced/, (m) => pkgIssue(m[1], loc('فيها الفحص قبل الشحن وليس له سعر', 'it includes the inspection, which has no price', 'پشکنینی پێش ناردنی تێدایە و نرخی نییە'))],
    [/^packages\.(smart|complete): includes a warranty, but the warranty is off/, (m) => pkgIssue(m[1], loc('فيها ضمان والضمان موقوف', 'it includes a warranty, but the warranty is off', 'گەرەنتی تێدایە بەڵام گەرەنتی ڕاگیراوە'))],
    [/^packages\.(smart|complete): a package must include a warranty/, (m) => pkgIssue(m[1], loc('الباقة الجاهزة يجب أن تتضمن ضماناً', 'a ready package must include a warranty', 'پاکێجی ئامادە دەبێت گەرەنتی تێدا بێت'))],
    [/^packages\.(smart|complete)(\.membership_tier)?: (preselects a membership tier|plus, prime, pro)/, (m) => pkgIssue(m[1], loc('تقترح مستوى عضوية غير معروض', 'it preselects a membership tier that is not offered', 'ئاستێکی ئەندامێتی پێشنیار دەکات کە پێشکەش ناکرێت'))],
    // Phase 4 (DECISIONS row 355): kit discounts and customer colours, add-ons, store bundles.
    [/^(kits\[\d+\])\.(\S+\.)?discount/, (m) => `${kitName(m[1])}: ${discountRule}`],
    [/^(kits\[\d+\])\.items\[(\d+)\]: a product whose colour the customer picks appears once/, (m) => `${kitName(m[1])}: ${loc(`المنتج ${n1(m[2])} يختار الزبون لونه، فيظهر مرة واحدة — ارفع كميته بدلاً من تكراره`, `item ${n1(m[2])} has a customer-picked colour, so it appears once — raise its quantity instead`, `بەرهەمی ${n1(m[2])} ڕەنگەکەی کڕیار هەڵیدەبژێرێت، بۆیە یەکجار دەردەکەوێت — لەبری دووبارەکردنەوە بڕەکەی زیاد بکە`)}`],
    [/^(kits\.[^:]+): \S+ has no active colour for the customer to pick/, (m) => `${kitName(m[1])}: ${noColour}`],
    [/^(addons\[\d+\])\.id: used twice$/, (m) => `${addonName(m[1])}: ${say(loc, S.idDup)}`],
    [/^(addons\[\d+\])\.id: /, (m) => `${addonName(m[1])}: ${say(loc, S.idRule)}`],
    [/^(addons\[\d+\])\.qty/, (m) => `${addonName(m[1])}: ${loc('الكمية لكل طابعة من 1 إلى 20', 'quantity per printer 1 to 20', 'بڕ بۆ هەر پرینتەرێک لە 1 تا 20')}`],
    [/^(addons\[\d+\])\.(\S+\.)?discount/, (m) => `${addonName(m[1])}: ${discountRule}`],
    [/^(addons\[\d+\])\.title/, (m) => `${addonName(m[1])}: ${loc('الاسم الخاص بثلاث لغات، حتى 80 حرفاً لكل منها', 'its own name in three languages, up to 80 characters each', 'ناوی تایبەت بە سێ زمان، هەریەکە تا 80 پیت')}`],
    [/^addons: at most/, () => loc('حتى 40 إضافة', 'at most 40 add-ons', 'تا 40 زیادکراو')],
    [/^(addons\.[^:]+): a title needs/, (m) => `${addonName(m[1])}: ${loc('الاسم الخاص يحتاج العربية والإنجليزية والكردية، أو اتركه ليظهر باسم المنتج', 'its own name needs Arabic, English and Kurdish — or none, to show the product\'s name', 'ناوی تایبەت پێویستی بە عەرەبی و ئینگلیزی و کوردی هەیە — یان هیچ، بۆ پیشاندانی ناوی بەرهەمەکە')}`],
    [/^(addons\.[^:]+): (a printer cannot be an add-on|\S+ is a printer, not an add-on)/, (m) => `${addonName(m[1])}: ${say(loc, S.addonNoPrinter)}`],
    [/^(addons\.[^:]+): \S+ is a bundle or a mystery offer/, (m) => `${addonName(m[1])}: ${loc('العرض المجمّع أو الصندوق المفاجئ لا يكون إضافة', 'a bundle or mystery offer cannot be an add-on', 'پاکێجی کۆکراوە یان سندووقی سەرسوڕهێنەر نابێتە زیادکراو')}`],
    [/^(addons\.[^:]+): \S+ has no active colour for the customer to pick/, (m) => `${addonName(m[1])}: ${noColour}`],
    [/^(addons\.[^:]+): product \S+ does not exist/, (m) => `${addonName(m[1])}: ${loc('منتجها لم يعد موجوداً — اختر منتجاً آخر أو احذفها', 'its product no longer exists — pick another or remove it', 'بەرهەمەکەی ئیتر بوونی نییە — یەکێکی تر هەڵبژێرە یان لای ببە')}`],
    [/^(addons\.[^:]+): printer \S+ is not mapped/, (m) => `${addonName(m[1])}: ${otherPrinter}`],
    [/^products\.\S+?\.?store_bundle_ids?: /, () => loc('العروض المجمّعة: حتى 8، كل عرض مرة واحدة', 'store bundles: up to 8, each once', 'پاکێجە کۆکراوەکان: تا 8، هەریەکە یەکجار')],
    [/^products\.\S+: (store bundle \S+ (does not exist|is a printer)|\S+ is not a store bundle)/, () => loc('عرض مجمّع مربوط لم يعد موجوداً أو ليس عرضاً مجمّعاً — احذفه', 'a linked store bundle no longer exists or is not a store bundle — remove it', 'پاکێجێکی کۆکراوەی بەستراو ئیتر بوونی نییە یان پاکێجی کۆکراوە نییە — لای ببە')],
    [/^(kits\[\d+\])\.id: used twice$/, (m) => `${kitName(m[1])}: ${say(loc, S.kitIdDup)}`],
    [/^(kits\[\d+\])\.id: /, (m) => `${kitName(m[1])}: ${say(loc, S.idRule)}`],
    [/^(kits\[\d+\])\.items\[(\d+)\]: the same product and selection twice/, (m) => `${kitName(m[1])}: ${loc(`المنتج ${n1(m[2])} مكرر بنفس الاختيار — ارفع كمية الأول بدلاً منه`, `item ${n1(m[2])} repeats the same product and selection — raise the first one's quantity instead`, `بەرهەمی ${n1(m[2])} هەمان بەرهەم و هەڵبژاردە دووبارە دەکاتەوە — لەبری ئەوە بڕی یەکەم زیاد بکە`)}`],
    [/^(kits\[\d+\])\.items\[(\d+)\]\.qty/, (m) => `${kitName(m[1])}: ${loc(`كمية المنتج ${n1(m[2])} من 1 إلى ${MAX_KIT_ITEM_QTY}`, `item ${n1(m[2])}: quantity 1 to ${MAX_KIT_ITEM_QTY}`, `بڕی بەرهەمی ${n1(m[2])} لە 1 تا ${MAX_KIT_ITEM_QTY}`)}`],
    [/^(kits\[\d+\])\.items: at most/, (m) => `${kitName(m[1])}: ${loc(`حتى ${MAX_KIT_ITEMS} منتجاً`, `at most ${MAX_KIT_ITEMS} items`, `تا ${MAX_KIT_ITEMS} بەرهەم`)}`],
    [/^(kits\[\d+\])\.title/, (m) => `${kitName(m[1])}: ${loc('الاسم بثلاث لغات، حتى 80 حرفاً لكل منها', 'a name in three languages, up to 80 characters each', 'ناو بە سێ زمان، هەریەکە تا 80 پیت')}`],
    [/^(kits\[\d+\])\.sort/, (m) => `${kitName(m[1])}: ${loc('الترتيب من 0 إلى 999', 'sort 0 to 999', 'ڕیزبەندی لە 0 تا 999')}`],
    [/^(kits\[\d+\])\.\S*: kits carry no discount/, (m) => `${kitName(m[1])}: ${loc('لا خصم على الباقات', 'kits carry no discount', 'پاکێج داشکاندنی نییە')}`],
    [/^kits: at most/, () => loc(`حتى ${MAX_KITS} باقة`, `at most ${MAX_KITS} kits`, `تا ${MAX_KITS} پاکێج`)],
    [/^(kits\.[^:]+): needs a title/, (m) => `${kitName(m[1])}: ${loc('تحتاج اسماً بالعربية والإنجليزية والكردية', 'needs a name in Arabic, English and Kurdish', 'پێویستی بە ناو بە عەرەبی و ئینگلیزی و کوردی هەیە')}`],
    [/^(kits\.[^:]+): needs at least one item/, (m) => `${kitName(m[1])}: ${loc('تحتاج منتجاً واحداً على الأقل', 'needs at least one item', 'لانیکەم پێویستی بە یەک بەرهەم هەیە')}`],
    [/^(kits\.[^:]+): (a printer cannot be a kit item|\S+ is a printer, not a kit item)/, (m) => `${kitName(m[1])}: ${loc('الطابعة لا تكون منتجاً داخل باقة', 'a printer cannot be a kit item', 'پرینتەر نابێتە بەرهەمێکی ناو پاکێج')}`],
    [/^(kits\.[^:]+): printer \S+ is not mapped/, (m) => `${kitName(m[1])}: ${otherPrinter}`],
    [/^(kits\.[^:]+): product \S+ does not exist/, (m) => `${kitName(m[1])}: ${gone}`],
    [/^membership/, () => loc('العضوية: التشغيل والمستويات (Plus وPrime وPro، كلٌّ مرة واحدة)', 'Membership: on/off and tiers (Plus, Prime, Pro, each once)', 'ئەندامێتی: کردنەوە و ئاستەکان (Plus، Prime، Pro، هەریەکە یەکجار)')],
  ];
  for (const [re, words] of rules) {
    const m = re.exec(issue);
    if (m) return { text: words(m), translated: true };
  }
  return { text: issue, translated: false };
}
