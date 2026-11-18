/**
 * «خصص طابعتك» phase 2 (migration 0235; owner rulings 2026-11-17) — the two
 * panels of the shared price list that are not services:
 *
 * - THE MEMBERSHIP: on/off, which tiers a customer may buy WITH a printer, and
 *   which tier each package preselects (default «none»; the Complete package
 *   includes no membership). The price is never stored here: it is the live
 *   membership_plans row, shown read-only with a link to the memberships admin.
 * - THE FILAMENT KITS: owner-made from real products / variants / colours, with
 *   a per-printer quantity. A kit costs the sum of its items' live prices, less
 *   the owner's kit discount when one is set (phase 4, DECISIONS row 355 —
 *   supersedes phase 2's «no discount»); each item's colour is fixed or the
 *   customer's pick.
 *
 * PHASE 4 SCOPE (owner, 2026-11-18): the kits panel sits on ONE printer's page
 * and shows only what that printer offers. Whether a kit shows with this
 * printer is one switch that edits this printer's entry alone; kits made for
 * other printers are counted and folded, never listed by printer — a printer's
 * page never names another printer.
 *
 * Both edit the same draft as the rest of the list (`upd`); the fieldset of the
 * parent disables every control for a non-owner.
 */
import { useEffect, useState } from 'react';
import { api, formatIqd } from '../../lib/api';
import { tierLabel } from '../subscription/tierMeta';
import ProductPicker from '../adminProducts/form/ProductPicker';
import { resolveProductNames } from '../adminBenefits/shared';
import { refusalText } from '../../lib/refusalStrings';
import {
  MAX_DISCOUNT_FIXED_IQD,
  MAX_DISCOUNT_PERCENT,
  MAX_KITS,
  MAX_KIT_ITEMS,
  MAX_KIT_ITEM_QTY,
  MEMBERSHIP_TIERS,
  colorModeOf,
  kitItemKey,
  type FilamentKit,
  type KitColorMode,
  type KitItem,
  type KitPrinterRef,
  type MembershipTier,
  type PrinterDiscount,
  type PrinterServicesConfig,
} from '../../../packages/pricing/src/printerServices';
import { S, discountPreview, say, sharedWithOthers, type Loc } from './adminPrinterStrings';

type Upd = (fn: (d: PrinterServicesConfig) => void) => void;
export interface Printer { id: string; slug: string; name: string; versions: Array<{ id: string; name: string }> }

export const KIT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * What the save and publish would refuse in the kits, found before asking (phase 2 review U9): an
 * invalid id, an id used by an earlier kit, the same product and selection twice in one kit, and a
 * printer (any product in a printer section, mapped or not) as a kit item. One entry per kit; the
 * item problems name the item's index.
 */
export interface KitProblems { badId: boolean; dupId: boolean; dupItems: number[]; printerItems: number[] }
export function kitProblems(kits: readonly FilamentKit[], printerIds: ReadonlySet<string>): KitProblems[] {
  const seen = new Set<string>();
  return kits.map((k) => {
    const badId = !KIT_ID.test(k.id);
    const dupId = !badId && seen.has(k.id);
    seen.add(k.id);
    const keys = new Set<string>();
    // Phase 4: a product whose colour the customer picks appears once (with its selection) in the kit.
    const selections = new Set<string>();
    const customerSelections = new Set<string>();
    const dupItems: number[] = [];
    const printerItems: number[] = [];
    k.items.forEach((it, j) => {
      const key = kitItemKey(it);
      const sel = `${it.product_id}|${[...it.option_value_ids].sort().join(',')}`;
      const customer = colorModeOf(it) === 'customer';
      if (keys.has(key) || customerSelections.has(sel) || (customer && selections.has(sel))) dupItems.push(j);
      keys.add(key);
      selections.add(sel);
      if (customer) customerSelections.add(sel);
      if (printerIds.has(it.product_id)) printerItems.push(j);
    });
    return { badId, dupId, dupItems, printerItems };
  });
}
export const kitsBlocked = (kits: readonly FilamentKit[], printerIds: ReadonlySet<string>) =>
  kitProblems(kits, printerIds).some((p) => p.badId || p.dupId || p.dupItems.length > 0 || p.printerItems.length > 0);

/**
 * One server issue (`path: message`, English — packages/pricing/src/printerServices.ts configIssues /
 * publishIssues, worker/lib/printerServices.ts kitCatalogIssues) in the reader's language. The kit and
 * membership ones are said in words; anything else keeps the server's line (shown left-to-right).
 */
export function issueText(issue: string, loc: Loc, kits: readonly FilamentKit[] = []): { text: string; translated: boolean } {
  const kitName = (ref: string) => {
    const at = /^kits\[(\d+)\]$/.exec(ref);
    const id = at ? kits[Number(at[1])]?.id || `#${Number(at[1]) + 1}` : ref.replace(/^kits\./, '');
    return loc(`الباقة «${id}»`, `Kit «${id}»`, `پاکێجی «${id}»`);
  };
  const n1 = (v: string) => Number(v) + 1;
  const addonName = (ref: string) => {
    const at = /^addons\[(\d+)\]$/.exec(ref);
    const id = at ? `#${Number(at[1]) + 1}` : ref.replace(/^addons\./, '');
    return loc(`الإضافة «${id}»`, `Add-on «${id}»`, `زیادکراوی «${id}»`);
  };
  const discountRule = loc(
    `الخصم: نسبة من 1 إلى ${MAX_DISCOUNT_PERCENT}% أو مبلغ ثابت لكل طابعة حتى ${formatIqd(MAX_DISCOUNT_FIXED_IQD)}`,
    `discount: 1 to ${MAX_DISCOUNT_PERCENT}% or a fixed amount per printer up to ${formatIqd(MAX_DISCOUNT_FIXED_IQD)}`,
    `داشکاندن: لە 1 تا ${MAX_DISCOUNT_PERCENT}% یان بڕێکی جێگیر بۆ هەر پرینتەرێک تا ${formatIqd(MAX_DISCOUNT_FIXED_IQD)}`
  );
  const noColour = loc('لا ألوان مفعّلة له ليختار الزبون منها', 'it has no active colour for the customer to pick', 'هیچ ڕەنگێکی چالاکی نییە بۆ ئەوەی کڕیار هەڵیبژێرێت');
  const rules: Array<[RegExp, (m: RegExpExecArray) => string]> = [
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
    [/^(addons\.[^:]+): product (\S+) does not exist/, (m) => `${addonName(m[1])}: ${loc(`المنتج ${m[2]} غير موجود`, `product ${m[2]} does not exist`, `بەرهەمی ${m[2]} بوونی نییە`)}`],
    [/^(addons\.[^:]+): printer \S+ is not mapped/, (m) => `${addonName(m[1])}: ${loc('مربوطة بطابعة غير مسجّلة في الخدمات', 'tied to a printer that is not enrolled', 'بە پرینتەرێکەوە بەستراوە کە تۆمار نەکراوە')}`],
    [/^products\.\S+?\.?store_bundle_ids?: /, () => loc('العروض المجمّعة: حتى 8، كل عرض مرة واحدة', 'store bundles: up to 8, each once', 'پاکێجە کۆکراوەکان: تا 8، هەریەکە یەکجار')],
    [/^products\.\S+: (store bundle \S+ (does not exist|is a printer)|\S+ is not a store bundle)/, () => loc('عرض مجمّع مربوط لم يعد موجوداً أو ليس عرضاً مجمّعاً — احذفه', 'a linked store bundle no longer exists or is not a store bundle — remove it', 'پاکێجێکی کۆکراوەی بەستراو ئیتر بوونی نییە یان پاکێجی کۆکراوە نییە — لای ببە')],
    [/^(kits\[\d+\])\.id: used twice$/, (m) => `${kitName(m[1])}: ${loc('المعرّف مستخدم لباقة أخرى', 'the id is used by another kit', 'ناسنامەکە بۆ پاکێجێکی تر بەکارهاتووە')}`],
    [/^(kits\[\d+\])\.id: /, (m) => `${kitName(m[1])}: ${loc('المعرّف: حروف إنجليزية صغيرة وأرقام و _ أو -، حتى 32', 'id: lowercase letters, digits, _ or -, up to 32', 'ناسنامە: پیتی بچووکی ئینگلیزی، ژمارە، _ یان -، تا 32')}`],
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
    [/^(kits\.[^:]+): printer \S+ is not mapped/, (m) => `${kitName(m[1])}: ${loc('مربوطة بطابعة غير مسجّلة في الخدمات', 'tied to a printer that is not enrolled', 'بە پرینتەرێکەوە بەستراوە کە تۆمار نەکراوە')}`],
    [/^(kits\.[^:]+): product (\S+) does not exist/, (m) => `${kitName(m[1])}: ${loc(`المنتج ${m[2]} غير موجود`, `product ${m[2]} does not exist`, `بەرهەمی ${m[2]} بوونی نییە`)}`],
    [/^packages\.(smart|complete)(\.membership_tier)?: (preselects a membership tier|plus, prime, pro)/, (m) => `${m[1] === 'smart' ? loc('الاختيار الذكي', 'Smart Choice', 'هەڵبژاردنی زیرەک') : loc('التجربة الكاملة', 'Complete', 'ئەزموونی تەواو')}: ${loc('يقترح مستوى عضوية غير معروض', 'preselects a membership tier that is not offered', 'ئاستێکی ئەندامێتی پێشنیار دەکات کە پێشکەش ناکرێت')}`],
    [/^membership/, () => loc('العضوية: التشغيل والمستويات (Plus وPrime وPro، كلٌّ مرة واحدة)', 'Membership: on/off and tiers (Plus, Prime, Pro, each once)', 'ئەندامێتی: کردنەوە و ئاستەکان (Plus، Prime، Pro، هەریەکە یەکجار)')],
  ];
  for (const [re, say] of rules) {
    const m = re.exec(issue);
    if (m) return { text: say(m), translated: true };
  }
  return { text: issue, translated: false };
}

// ------------------------------------------------------------- membership

interface AdminPlan { id: string; tier: string; duration_months: number; price_iqd: number | null; active: boolean; paused?: boolean }

export function MembershipPanel({ draft, upd, loc }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc }) {
  const m = draft.membership ?? { active: false, tiers: [] };
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [planError, setPlanError] = useState(false);
  useEffect(() => {
    let live = true;
    api.get<{ plans: AdminPlan[] }>('/api/memberships/admin/plans')
      .then((r) => { if (live) setPlans(r.plans ?? []); })
      .catch(() => { if (live) setPlanError(true); });
    return () => { live = false; };
  }, []);
  const months = (n: number) => loc(`${n} شهر`, `${n} months`, `${n} مانگ`);
  const setTier = (t: MembershipTier, on: boolean) => upd((d) => {
    const cur = d.membership ?? { active: false, tiers: [] };
    const tiers = on ? [...new Set([...cur.tiers, t])] : cur.tiers.filter((x) => x !== t);
    d.membership = { active: cur.active, tiers: MEMBERSHIP_TIERS.filter((x) => tiers.includes(x)) };
    // A package cannot preselect a tier that is no longer offered (the publish refuses it).
    for (const id of ['smart', 'complete'] as const) {
      const pt = d.packages[id].membership_tier;
      if (pt && !d.membership.tiers.includes(pt)) d.packages[id].membership_tier = null;
    }
  });

  return (
    <section className="mt-3 rounded-lg border border-border-subtle p-3 text-[12px] text-text-secondary" data-printer-services-membership>
      <h2 className="text-[14px] font-bold text-text-primary">{loc('العضوية مع الطابعة', 'Membership with the printer', 'ئەندامێتی لەگەڵ پرینتەر')}</h2>
      <p className="mt-1">
        {loc(
          'سطر مستقل في الطلب بسعر الخطة الحالي (ناقص رصيد الترقية). تبدأ فقط عند تسليم الطلب ودفعه، ولا تُسترد بعد أن تبدأ.',
          'Its own order line at the live plan price (less any upgrade credit). It starts only when the order is delivered and paid, and is non-refundable once started.',
          'هێڵێکی جیا لە داواکاریدا بە نرخی ئێستای پلانەکە (کەمکردنەوەی باڵانسی بەرزکردنەوە). تەنها کاتێک داواکارییەکە گەیەندرا و پارەکەی درا دەست پێدەکات، و دوای دەستپێکردن پارەکەی ناگەڕێتەوە.'
        )}
      </p>
      <label className="mt-2 flex items-center gap-2 text-[13px] font-semibold text-text-primary">
        <input type="checkbox" checked={m.active} onChange={(e) => upd((d) => { d.membership = { active: e.target.checked, tiers: [...(d.membership?.tiers ?? [])] }; })} />
        {loc('عرض صف العضوية للزبائن', 'Show the membership row to customers', 'ڕیزی ئەندامێتی بۆ کڕیاران پیشان بدە')}
      </label>
      <div className="mt-2 flex flex-wrap gap-3" role="group" aria-label={loc('المستويات المعروضة', 'Tiers offered', 'ئاستە پێشکەشکراوەکان')}>
        {MEMBERSHIP_TIERS.map((t) => (
          <label key={t} className="flex items-center gap-2 text-[13px] text-text-primary">
            <input type="checkbox" checked={m.tiers.includes(t)} onChange={(e) => setTier(t, e.target.checked)} />
            {tierLabel(t)}
          </label>
        ))}
      </div>

      <h3 className="mt-3 font-semibold text-text-primary">{loc('أسعار الخطط الحالية (للقراءة فقط)', 'Live plan prices (read only)', 'نرخی ئێستای پلانەکان (تەنها خوێندنەوە)')}</h3>
      {planError ? (
        <p className="mt-1">{loc('تعذّر تحميل الخطط.', 'The plans could not be loaded.', 'پلانەکان بار نەکران.')}</p>
      ) : !plans ? (
        <p className="mt-1">{loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…')}</p>
      ) : (
        <ul className="mt-1 space-y-1" data-printer-services-plans>
          {plans.filter((p) => (MEMBERSHIP_TIERS as readonly string[]).includes(p.tier)).map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{tierLabel(p.tier)} · {months(p.duration_months)}{!p.active ? ` · ${loc('غير مفعّلة', 'inactive', 'ناچالاک')}` : p.paused ? ` · ${loc('متوقفة', 'paused', 'ڕاگیراو')}` : ''}</span>
              <span dir="ltr" className="tabular-nums text-text-primary">{p.price_iqd === null ? loc('بلا سعر', 'unpriced', 'بێ نرخ') : formatIqd(p.price_iqd)}</span>
            </li>
          ))}
        </ul>
      )}
      <a href="/admin?tab=memberships" target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-11 items-center text-[12px] text-text-primary underline">
        {loc('تعديل الأسعار في إدارة العضويات', 'Change the prices in Memberships admin', 'گۆڕینی نرخەکان لە بەڕێوەبردنی ئەندامێتی')}
      </a>

      <h3 className="mt-3 font-semibold text-text-primary">{loc('ما تختاره كل باقة مسبقاً', 'What each package preselects', 'ئەوەی هەر پاکێجێک پێشوەختە هەڵیدەبژێرێت')}</h3>
      <p className="mt-1">{loc('تلميح فقط: الزبون يرى المستوى مقترحاً ويقرر بنفسه، والعضوية لا تدخل في سعر الباقة.', 'A hint only: the customer sees the tier suggested and decides; the membership is never in the package price.', 'تەنها ئاماژەیە: کڕیار ئاستەکە وەک پێشنیار دەبینێت و خۆی بڕیار دەدات؛ ئەندامێتی هەرگیز ناچێتە نێو نرخی پاکێجەوە.')}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {(['smart', 'complete'] as const).map((id) => (
          <label key={id} className="flex flex-col gap-1">
            {id === 'smart' ? loc('الاختيار الذكي', 'Smart Choice', 'هەڵبژاردنی زیرەک') : loc('التجربة الكاملة', 'Complete', 'ئەزموونی تەواو')}
            <select
              className="lv-input h-9 px-2 text-[12px]"
              value={draft.packages[id].membership_tier ?? ''}
              onChange={(e) => upd((d) => { d.packages[id].membership_tier = (e.target.value || null) as MembershipTier | null; })}
            >
              <option value="">{loc('بدون', 'None', 'هیچ')}</option>
              {m.tiers.map((t) => <option key={t} value={t}>{tierLabel(t)}</option>)}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------- the shared item toolkit (kits and add-ons)

export interface ProductDoc {
  id: string; slug: string; name_ar: string; name_en: string; name_ckb?: string;
  /** What the admin read answers today: an ESTIMATE base only (the cart prices at the customer's tier). */
  price_iqd?: number | null;
  /** Owner-only (projectForAdmin strips it for anyone else): the below-cost warning reads it when present. */
  cost_iqd?: number | null;
  composition?: string;
  options: Array<{ id: string; name_ar: string; name_en: string; name_ckb: string; active: boolean; group_en?: string; order: number }>;
  colors: Array<{ id: string; name_ar: string; name_en: string; name_ckb: string; active: boolean; option_id: string | null; option_ids?: string[]; order: number; hex?: string; stock?: number | null }>;
}
interface PreviewKit {
  id: string; title: { ar: string; en: string; ckb: string } | null; available: boolean; price_per_printer_iqd: number | null; total_iqd: number | null;
  /** Phase 4 (WP-B): the price before the owner's kit discount; absent from an older server. */
  before_per_printer_iqd?: number | null;
  items: Array<{ product_id: string; name: string; name_ar: string; variant: string; qty: number; unit_price_iqd: number | null; available: boolean; reason: string | null }>;
}

const docCache = new Map<string, Promise<ProductDoc | null>>();
function productDoc(id: string): Promise<ProductDoc | null> {
  let p = docCache.get(id);
  if (!p) {
    p = api.get<{ product: ProductDoc }>(`/api/admin/products-v2/${encodeURIComponent(id)}`).then((r) => r.product ?? null, () => null);
    docCache.set(id, p);
  }
  return p;
}

export function useDocs(ids: string[]): Record<string, ProductDoc | null> {
  const [docs, setDocs] = useState<Record<string, ProductDoc | null>>({});
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(',') : []) {
      void productDoc(id).then((d) => { if (live) setDocs((prev) => (id in prev ? prev : { ...prev, [id]: d })); });
    }
    return () => { live = false; };
  }, [key]);
  return docs;
}

export function useNames(ids: string[], lang: string): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    let live = true;
    if (key) void resolveProductNames(key.split(','), lang).then((m) => { if (live) setNames(m); });
    return () => { live = false; };
  }, [key, lang]);
  return names;
}

export const pick3 = (o: { name_ar: string; name_en: string; name_ckb?: string }, lang: string) =>
  (lang === 'en' ? o.name_en || o.name_ar : lang === 'ckb' ? o.name_ckb || o.name_en || o.name_ar : o.name_ar || o.name_en) || '';
export const text3 = (t: { ar: string; en: string; ckb: string } | null | undefined, lang: string) =>
  (t ? (lang === 'en' ? t.en : lang === 'ckb' ? t.ckb || t.en : t.ar) || t.en || t.ar : '') || '';

/** One printer's worth of the items at today's admin prices (null when any price is unknown). */
export function perPrinterEstimate(items: ReadonlyArray<{ product_id: string; qty: number }>, docs: Record<string, ProductDoc | null>, field: 'price_iqd' | 'cost_iqd'): number | null {
  if (!items.length) return null;
  let sum = 0;
  for (const it of items) {
    const v = docs[it.product_id]?.[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    sum += v * it.qty;
  }
  return sum;
}

// ------------------------------------------------------------- this printer's entry

/** Whether a kit or an add-on shows with this printer (null = every enrolled printer). */
export const onThisPrinter = (refs: KitPrinterRef[] | null | undefined, productId: string) =>
  refs === null || refs === undefined || refs.some((r) => r.product_id === productId);

/**
 * The printers list after the switch on THIS printer — no other printer's entry moves. Off on a kit
 * for every printer keeps it on every OTHER enrolled printer (their ids, never shown).
 */
export function withThisPrinter(refs: KitPrinterRef[] | null, productId: string, on: boolean, enrolledIds: readonly string[]): KitPrinterRef[] | null {
  if (on) {
    if (refs === null) return null;
    return refs.some((r) => r.product_id === productId) ? refs : [...refs, { product_id: productId, option_value_id: null }];
  }
  if (refs === null) return enrolledIds.filter((id) => id !== productId).map((id) => ({ product_id: id, option_value_id: null }));
  return refs.filter((r) => r.product_id !== productId);
}

/** How many OTHER printers a list of printers names besides this one (0 for «every printer»: that has its own badge). */
export function otherPrintersCount(refs: KitPrinterRef[] | null, productId: string): number {
  return refs === null ? 0 : new Set(refs.filter((r) => r.product_id !== productId).map((r) => r.product_id)).size;
}

/** «مشتركة مع N طابعات أخرى» — only for a list that shows with this printer AND others; a count, never names. */
export function SharedBadge({ refs, productId, loc }: { refs: KitPrinterRef[] | null; productId: string; loc: Loc }) {
  const n = otherPrintersCount(refs, productId);
  if (!n || !onThisPrinter(refs, productId)) return null;
  return <span className="lv-chip [--chip:var(--color-info)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold" data-shared-printers={n}>{say(loc, sharedWithOthers(n))}</span>;
}

/** «يظهر مع هذه الطابعة» and, for a printer with versions, which of ITS versions. */
export function PrinterScope({ refs, printer, productId, enrolledIds, loc, onChange }: {
  refs: KitPrinterRef[] | null; printer: Printer | null; productId: string; enrolledIds: readonly string[]; loc: Loc;
  onChange: (refs: KitPrinterRef[] | null) => void;
}) {
  const on = onThisPrinter(refs, productId);
  const mine = refs?.filter((r) => r.product_id === productId) ?? [];
  const whole = refs === null || mine.some((r) => r.option_value_id === null);
  const versions = printer?.versions ?? [];
  const rest = () => (refs ?? []).filter((r) => r.product_id !== productId);
  return (
    <div className="space-y-1" data-printer-scope>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold text-text-primary">
          <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(withThisPrinter(refs, productId, e.target.checked, enrolledIds))} />
          {say(loc, S.showsHere)}
        </label>
        {refs === null ? <span className="lv-chip [--chip:var(--color-info)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold" data-every-printer>{say(loc, S.everyPrinter)}</span> : null}
        <SharedBadge refs={refs} productId={productId} loc={loc} />
      </div>
      {refs === null ? <p className="text-[11px] text-text-muted">{say(loc, S.everyPrinterOffNote)}</p> : null}
      {on && refs !== null && versions.length > 1 ? (
        <div className="flex flex-wrap gap-3 ps-6">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={whole} onChange={(e) => onChange(e.target.checked
              ? [...rest(), { product_id: productId, option_value_id: null }]
              : [...rest(), { product_id: productId, option_value_id: versions[0].id }])} />
            {say(loc, S.everyVersion)}
          </label>
          {whole ? null : versions.map((v) => (
            <label key={v.id} className="flex items-center gap-2">
              <input type="checkbox" checked={mine.some((r) => r.option_value_id === v.id)} onChange={(e) => onChange(e.target.checked
                ? [...(refs ?? []), { product_id: productId, option_value_id: v.id }]
                : (refs ?? []).filter((r) => !(r.product_id === productId && r.option_value_id === v.id)))} />
              {v.name}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------- discount

/** «بدون | نسبة % | مبلغ ثابت لكل طابعة», the value, and the live «قبل — بعد (وفّر %)». */
export function DiscountRow({ value, onChange, beforeIqd, costIqd, loc, label }: {
  value: PrinterDiscount | null | undefined; onChange: (d: PrinterDiscount | null) => void;
  beforeIqd: number | null; costIqd: number | null; loc: Loc; label: string;
}) {
  const d = value ?? null;
  const mode = d?.mode ?? 'none';
  const seg = (m: 'none' | PrinterDiscount['mode'], text: string) => (
    <button
      type="button"
      className={`lv-button lv-button-sm ${mode === m ? 'lv-button-primary' : 'lv-button-secondary'}`}
      aria-pressed={mode === m}
      onClick={() => onChange(m === 'none' ? null : m === 'percent' ? { mode: 'percent', value: d?.mode === 'percent' ? d.value : 10 } : { mode: 'fixed_iqd', value: d?.mode === 'fixed_iqd' ? d.value : 5_000 })}
    >
      {text}
    </button>
  );
  const view = discountPreview(d, beforeIqd);
  const below = !!view && costIqd !== null && view.after < costIqd;
  return (
    <div className="space-y-2" data-printer-discount>
      <h4 className="text-[12px] font-semibold text-text-primary">{label}</h4>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {seg('none', say(loc, S.discNone))}
        {seg('percent', say(loc, S.discPercent))}
        {seg('fixed_iqd', say(loc, S.discFixed))}
      </div>
      {d ? (
        <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
          {say(loc, d.mode === 'percent' ? S.discValuePercent : S.discValueFixed)}
          <input
            className="lv-input h-10 w-40 px-2 tabular-nums"
            inputMode="numeric"
            dir="ltr"
            // A fixed amount is shown with its thousands separators (5,000); typing strips them again.
            value={d.mode === 'fixed_iqd' ? d.value.toLocaleString('en-US') : String(d.value)}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/[^\d]/g, '') || 0);
              onChange(d.mode === 'percent'
                ? { mode: 'percent', value: Math.max(1, Math.min(MAX_DISCOUNT_PERCENT, n)) }
                : { mode: 'fixed_iqd', value: Math.max(1, Math.min(MAX_DISCOUNT_FIXED_IQD, n)) });
            }}
          />
        </label>
      ) : null}
      {d ? (
        view ? (
          <p className="flex flex-wrap items-baseline gap-2 text-[12px]" data-discount-preview>
            <span className="text-text-muted">{say(loc, S.before)}</span>
            <span dir="ltr" className="tabular-nums line-through text-text-muted">{formatIqd(view.before)}</span>
            <span className="text-text-muted">{say(loc, S.after)}</span>
            <span dir="ltr" className="tabular-nums font-bold text-text-primary">{formatIqd(view.after)}</span>
            <span className="text-success">({say(loc, S.save)} {view.pct}%)</span>
            <span className="text-text-muted">{say(loc, S.perPrinter)}</span>
          </p>
        ) : <p className="text-[12px] text-text-muted">{say(loc, S.priceUnknown)}</p>
      ) : null}
      {below ? <p className="text-[12px] font-semibold text-warning" role="alert" data-discount-below-cost>{say(loc, S.belowCost)} ({formatIqd(costIqd as number)})</p> : null}
      {d ? <p className="text-[11px] text-text-muted">{say(loc, S.estimateNote)}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------- kits (this printer only)

export function KitsPanel({ draft, upd, loc, lang, printers, productId }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc; lang: string; printers: Printer[]; productId: string }) {
  const kits = draft.kits ?? [];
  const itemIds = kits.flatMap((k) => k.items.map((i) => i.product_id));
  const docs = useDocs(itemIds);
  const names = useNames(itemIds, lang);
  const [adding, setAdding] = useState<number | null>(null);
  const printer = printers.find((p) => p.id === productId) ?? null;
  const enrolledIds = Object.keys(draft.products);
  // Every product in a printer section (mapped or not): none of them can be a kit item.
  const printerIds = new Set([...printers.map((p) => p.id), ...enrolledIds]);
  const problems = kitProblems(kits, printerIds);
  // Only the kits this printer offers; their index in the shared list is what `upd` edits.
  const here = kits.map((k, n) => ({ k, n })).filter(({ k }) => onThisPrinter(k.printers, productId));

  const kitAt = (d: PrinterServicesConfig, n: number) => (d.kits ?? [])[n];
  const addKit = () => upd((d) => {
    const list = d.kits ?? [];
    let n = list.length + 1;
    while (list.some((k) => k.id === `kit-${n}`)) n += 1;
    // A kit made on a printer's page starts on that printer alone.
    d.kits = [...list, { id: `kit-${n}`, active: false, sort: list.length, title: { ar: '', en: '', ckb: '' }, items: [], printers: [{ product_id: productId, option_value_id: null }], discount: null }];
    setAdding(list.length);
  });
  const removeKit = (n: number) => upd((d) => { d.kits = (d.kits ?? []).filter((_, j) => j !== n); });
  const setItem = (n: number, j: number, patch: Partial<KitItem>) => upd((d) => {
    const it = kitAt(d, n).items[j];
    Object.assign(it, patch);
    it.option_value_ids = [...it.option_value_ids].sort();
  });

  return (
    <section className="rounded-lg border border-border-subtle p-3 text-[12px] text-text-secondary space-y-2" data-printer-services-kits>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-bold text-text-primary">{say(loc, S.kits)}</h3>
        <button type="button" className="lv-button lv-button-secondary lv-button-sm" disabled={kits.length >= MAX_KITS} onClick={addKit}>
          + {loc('باقة جديدة', 'New kit', 'پاکێجی نوێ')}
        </button>
      </div>
      <p className="leading-relaxed">{say(loc, S.kitsHint)}</p>
      {here.length === 0 ? <p>{say(loc, S.noKitsHere)}</p> : null}
      <div className="space-y-3">
        {here.map(({ k, n }) => (
          <KitEditor
            key={n}
            kit={k}
            loc={loc}
            lang={lang}
            docs={docs}
            names={names}
            printer={printer}
            productId={productId}
            enrolledIds={enrolledIds}
            adding={adding === n}
            problems={problems[n]}
            isPrinter={(id) => printerIds.has(id)}
            onAdding={(on) => setAdding(on ? n : null)}
            onKit={(fn) => upd((d) => fn(kitAt(d, n)))}
            onItem={(j, patch) => setItem(n, j, patch)}
            onRemove={() => removeKit(n)}
          />
        ))}
      </div>
      <KitPreview printer={printer && draft.products[printer.id] ? printer : null} loc={loc} lang={lang} />
    </section>
  );
}

function KitEditor({ kit, loc, lang, docs, names, printer, productId, enrolledIds, adding, onAdding, onKit, onItem, onRemove, problems, isPrinter }: {
  kit: FilamentKit; loc: Loc; lang: string; docs: Record<string, ProductDoc | null>; names: Map<string, string>;
  printer: Printer | null; productId: string; enrolledIds: readonly string[];
  adding: boolean; onAdding: (on: boolean) => void; onKit: (fn: (k: FilamentKit) => void) => void;
  onItem: (j: number, patch: Partial<KitItem>) => void; onRemove: () => void;
  problems: KitProblems; isPrinter: (productId: string) => boolean;
}) {
  const idBad = problems.badId;
  const [pickRefused, setPickRefused] = useState('');
  const text = (field: 'ar' | 'en' | 'ckb', label: string) => (
    <label className="flex flex-col gap-1">
      {label}
      <input
        className="lv-input h-9 px-2 text-[13px]"
        dir={field === 'en' ? 'ltr' : 'rtl'}
        maxLength={80}
        value={kit.title[field]}
        onChange={(e) => onKit((k) => { k.title[field] = e.target.value; })}
      />
    </label>
  );
  const before = perPrinterEstimate(kit.items, docs, 'price_iqd');
  const cost = perPrinterEstimate(kit.items, docs, 'cost_iqd');
  const view = discountPreview(kit.discount ?? null, before);
  const hasProblem = idBad || problems.dupId || problems.dupItems.length > 0 || problems.printerItems.length > 0;

  return (
    <details className="rounded-lg border border-border-subtle p-2" open={adding || hasProblem || kit.items.length === 0 || undefined} data-printer-services-kit={kit.id}>
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 text-[13px] text-text-primary">
        <span className="min-w-0 flex-1 font-semibold">{text3(kit.title, lang) || kit.id}</span>
        {kit.printers === null ? <span className="lv-chip [--chip:var(--color-info)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{say(loc, S.everyPrinter)}</span> : null}
        <SharedBadge refs={kit.printers} productId={productId} loc={loc} />
        {!kit.active ? <span className="lv-chip [--chip:var(--color-warning)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{loc('موقوفة', 'Off', 'ڕاگیراو')}</span> : null}
        {view ? (
          <span className="inline-flex items-baseline gap-1.5 text-[12px]">
            <span dir="ltr" className="tabular-nums line-through text-text-muted">{formatIqd(view.before)}</span>
            <span dir="ltr" className="tabular-nums font-bold">{formatIqd(view.after)}</span>
          </span>
        ) : before !== null ? <span dir="ltr" className="tabular-nums text-[12px]">{formatIqd(before)}</span> : null}
      </summary>

      <div className="mt-2 space-y-3">
        <PrinterScope refs={kit.printers} printer={printer} productId={productId} enrolledIds={enrolledIds} loc={loc} onChange={(refs) => onKit((k) => { k.printers = refs; })} />

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            {say(loc, S.id)}
            <input className="lv-input h-9 px-2 text-[12px]" dir="ltr" maxLength={32} aria-invalid={idBad || undefined} value={kit.id} onChange={(e) => onKit((k) => { k.id = e.target.value.toLowerCase(); })} />
          </label>
          <label className="flex flex-col gap-1">
            {say(loc, S.sort)}
            <input
              className="lv-input h-9 px-2 text-[12px] tabular-nums"
              inputMode="numeric"
              dir="ltr"
              value={String(kit.sort)}
              onChange={(e) => onKit((k) => { k.sort = Math.min(999, Number(e.target.value.replace(/[^\d]/g, '') || 0)); })}
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold text-text-primary">
            <input type="checkbox" checked={kit.active} onChange={(e) => onKit((k) => { k.active = e.target.checked; })} />
            {say(loc, S.active)}
          </label>
          <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={onRemove}>
            {loc('حذف الباقة', 'Remove the kit', 'سڕینەوەی پاکێج')}
          </button>
        </div>
        {idBad ? <p className="text-text-primary" role="alert">{say(loc, S.idRule)}</p> : null}
        {problems.dupId ? <p className="text-text-primary" role="alert" data-kit-problem="dup-id">{loc('هذا المعرّف مستخدم لباقة أخرى — اختر معرّفاً آخر.', 'This id is used by another kit — choose another id.', 'ئەم ناسنامەیە بۆ پاکێجێکی تر بەکارهاتووە — ناسنامەیەکی تر هەڵبژێرە.')}</p> : null}
        <div className="grid gap-2 sm:grid-cols-3">
          {text('ar', say(loc, S.nameAr))}
          {text('en', say(loc, S.nameEn))}
          {text('ckb', say(loc, S.nameCkb))}
        </div>

        <div>
          <h4 className="font-semibold text-text-primary">{loc('المنتجات (الكمية لكل طابعة)', 'Items (quantity per printer)', 'بەرهەمەکان (بڕ بۆ هەر پرینتەرێک)')}</h4>
          <ul className="mt-1 space-y-2">
            {kit.items.map((it, j) => (
              <ItemRow key={`${it.product_id}-${j}`} item={it} doc={docs[it.product_id]} name={names.get(it.product_id) ?? it.product_id} loc={loc} lang={lang}
                problem={problems.printerItems.includes(j) ? 'printer' : problems.dupItems.includes(j) ? 'duplicate' : null}
                onChange={(patch) => onItem(j, patch)}
                onRemove={() => onKit((k) => { k.items = k.items.filter((_, x) => x !== j); })}
              />
            ))}
          </ul>
          {kit.items.length < MAX_KIT_ITEMS ? (
            adding ? (
              <div className="mt-2">
                <ProductPicker
                  value=""
                  ariaLabel={loc('ابحث عن منتج للباقة', 'Find a product for the kit', 'بەرهەمێک بۆ پاکێجەکە بدۆزەوە')}
                  onChange={(id) => {
                    if (!id) return;
                    // A printer is never a kit item; the same product with no selection yet is already in the kit.
                    if (isPrinter(id)) { setPickRefused(loc('الطابعة لا تكون منتجاً داخل باقة.', 'A printer cannot be a kit item.', 'پرینتەر نابێتە بەرهەمێکی ناو پاکێج.')); return; }
                    if (kit.items.some((i) => i.product_id === id && !i.option_value_ids.length && !i.color_id)) {
                      setPickRefused(loc('هذا المنتج في الباقة بلا اختيار — اختر نسخته أو لونه هناك، أو ارفع كميته.', 'This product is already in the kit with no selection — choose its version or colour there, or raise its quantity.', 'ئەم بەرهەمە بێ هەڵبژاردە لە پاکێجەکەدایە — لەوێ وەشان یان ڕەنگەکەی هەڵبژێرە، یان بڕەکەی زیاد بکە.'));
                      return;
                    }
                    setPickRefused('');
                    onKit((k) => { k.items = [...k.items, { product_id: id, option_value_ids: [], color_id: null, qty: 1, color_mode: 'fixed' }]; });
                    onAdding(false);
                  }}
                />
                {pickRefused ? <p className="mt-1 text-text-primary" role="alert" data-kit-pick-refused>{pickRefused}</p> : null}
              </div>
            ) : (
              <button type="button" className="lv-button lv-button-secondary lv-button-sm mt-2" onClick={() => onAdding(true)}>
                + {loc('أضف منتجاً', 'Add an item', 'بەرهەمێک زیاد بکە')}
              </button>
            )
          ) : null}
        </div>

        <DiscountRow
          value={kit.discount}
          onChange={(d) => onKit((k) => { k.discount = d; })}
          beforeIqd={before}
          costIqd={cost}
          loc={loc}
          label={loc('خصم الباقة', 'Kit discount', 'داشکاندنی پاکێج')}
        />
      </div>
    </details>
  );
}

/** One product of a kit or an add-on: its version, its colour (fixed, or the customer's pick) and its quantity. */
export interface ItemLike { product_id: string; option_value_ids: string[]; color_id: string | null; qty: number; color_mode?: KitColorMode }

export function ItemRow({ item, doc, name, loc, lang, onChange, onRemove, problem = null, maxQty = MAX_KIT_ITEM_QTY, qtyLabel }: {
  item: ItemLike; doc: ProductDoc | null | undefined; name: string; loc: Loc; lang: string;
  onChange: (patch: Partial<ItemLike>) => void; onRemove?: () => void;
  /** What the save would refuse about this item: a printer, or the same product and selection twice. */
  problem?: 'printer' | 'duplicate' | null;
  maxQty?: number;
  qtyLabel?: string;
}) {
  // The product's option groups (by their English group name), one value chosen in each.
  const options = (doc?.options ?? []).filter((o) => o.active || item.option_value_ids.includes(o.id)).sort((a, b) => a.order - b.order);
  const groups = [...new Set(options.map((o) => o.group_en ?? ''))];
  const colours = (doc?.colors ?? [])
    .filter((c) => c.active || c.id === item.color_id)
    .filter((c) => {
      const tied = c.option_ids?.length ? c.option_ids : c.option_id ? [c.option_id] : [];
      return !tied.length || !item.option_value_ids.length || tied.some((t) => item.option_value_ids.includes(t)) || c.id === item.color_id;
    })
    .sort((a, b) => a.order - b.order);
  const display = doc ? pick3(doc, lang) || name : name;
  const mode = colorModeOf(item);
  const modeSeg = (m: KitColorMode, text: string) => (
    <button
      type="button"
      className={`lv-button lv-button-sm ${mode === m ? 'lv-button-primary' : 'lv-button-secondary'}`}
      aria-pressed={mode === m}
      onClick={() => onChange(m === 'customer' ? { color_mode: 'customer', color_id: null } : { color_mode: 'fixed' })}
    >
      {text}
    </button>
  );
  return (
    <li className="rounded-lg border border-border-subtle p-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[13px] text-text-primary">{display}</span>
        {/* A long label («الكمية لكل طابعة») sits above its input on one line, never wrapped beside it. */}
        <label className={qtyLabel ? 'flex flex-col gap-1 whitespace-nowrap' : 'flex items-center gap-1'}>
          {qtyLabel ?? loc('الكمية', 'Qty', 'بڕ')}
          <input
            className="lv-input h-9 px-2 text-[12px] tabular-nums"
            inputMode="numeric"
            dir="ltr"
            size={3}
            value={String(item.qty)}
            onChange={(e) => onChange({ qty: Math.max(1, Math.min(maxQty, Number(e.target.value.replace(/[^\d]/g, '') || 1))) })}
          />
        </label>
        {onRemove ? (
          <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={onRemove}>
            {loc('حذف المنتج', 'Remove the item', 'سڕینەوەی بەرهەم')}
          </button>
        ) : null}
      </div>
      {doc === null ? <p>{loc('تعذّرت قراءة المنتج.', 'The product could not be read.', 'بەرهەمەکە نەخوێندرایەوە.')}</p> : null}
      {problem === 'printer' ? <p className="text-text-primary" role="alert" data-kit-problem="printer">{loc('الطابعة لا تكون منتجاً داخل باقة — احذفه.', 'A printer cannot be a kit item — remove it.', 'پرینتەر نابێتە بەرهەمێکی ناو پاکێج — بیسڕەوە.')}</p> : null}
      {problem === 'duplicate' ? <p className="text-text-primary" role="alert" data-kit-problem="dup-item">{loc('نفس المنتج والاختيار مرتين — احذف هذا وارفع كمية الأول.', "The same product and selection twice — remove this one and raise the first one's quantity.", 'هەمان بەرهەم و هەڵبژاردە دوو جار — ئەمە بسڕەوە و بڕی یەکەم زیاد بکە.')}</p> : null}
      {doc && groups.length > 0 && options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => {
            const inGroup = options.filter((o) => (o.group_en ?? '') === g);
            const chosen = inGroup.find((o) => item.option_value_ids.includes(o.id))?.id ?? '';
            return (
              <label key={g || 'options'} className="flex flex-col gap-1">
                {g || loc('النسخة', 'Version', 'وەشان')}
                <select
                  className="lv-input h-9 px-2 text-[12px]"
                  value={chosen}
                  onChange={(e) => {
                    const rest = item.option_value_ids.filter((id) => !inGroup.some((o) => o.id === id));
                    onChange({ option_value_ids: e.target.value ? [...rest, e.target.value] : rest });
                  }}
                >
                  <option value="">{say(loc, S.choose)}</option>
                  {inGroup.map((o) => <option key={o.id} value={o.id}>{pick3(o, lang)}</option>)}
                </select>
              </label>
            );
          })}
        </div>
      ) : null}
      {doc && (colours.length > 0 || mode === 'customer') ? (
        <div className="space-y-1" data-item-colour-mode={mode}>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={say(loc, S.colourMode)}>
            <span className="text-text-secondary">{say(loc, S.colourMode)}</span>
            {modeSeg('fixed', say(loc, S.colourFixed))}
            {modeSeg('customer', say(loc, S.colourCustomer))}
          </div>
          {mode === 'fixed' && colours.length > 0 ? (
            <label className="flex flex-col gap-1">
              {loc('اللون', 'Colour', 'ڕەنگ')}
              <select className="lv-input h-9 px-2 text-[12px]" value={item.color_id ?? ''} onChange={(e) => onChange({ color_id: e.target.value || null })}>
                <option value="">{say(loc, S.choose)}</option>
                {colours.map((c) => <option key={c.id} value={c.id}>{pick3(c, lang)}</option>)}
              </select>
            </label>
          ) : null}
          {mode === 'customer' ? (
            colours.filter((c) => c.active).length ? (
              <>
                <p className="text-[11px] text-text-muted">{say(loc, S.colourCustomerHint)}</p>
                <ul className="flex flex-wrap gap-1.5" data-item-colour-swatches>
                  {colours.filter((c) => c.active).map((c) => {
                    const out = typeof c.stock === 'number' && c.stock <= 0;
                    return (
                      <li key={c.id} className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[11px]">
                        <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full border border-border-subtle" style={{ background: c.hex || 'transparent' }} />
                        {pick3(c, lang)}
                        {out ? <span className="text-text-muted">· {say(loc, S.outOfStock)}</span> : null}
                      </li>
                    );
                  })}
                  <li className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-subtle px-2 py-0.5 text-[11px]">
                    {loc('لون عشوائي', 'Random colour', 'ڕەنگی هەڕەمەکی')}
                  </li>
                </ul>
              </>
            ) : <p className="text-warning" role="alert">{say(loc, S.colourNone)}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The customer's view of the kits for THIS printer, from the PUBLISHED list (GET
 * /api/products/:slug/kits — the live prices and availability the shop would answer now, priced as
 * for a guest). A saved draft shows here only after it is published.
 */
function KitPreview({ printer, loc, lang }: { printer: Printer | null; loc: Loc; lang: string }) {
  const [at, setAt] = useState(printer ? `${printer.slug}|` : '');
  const [kits, setKits] = useState<PreviewKit[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!at) return;
    const [slug, ov] = at.split('|');
    let live = true;
    setFailed(false);
    setKits(null);
    const q = new URLSearchParams({ qty: '1', fulfillmentType: 'direct_sale' });
    if (ov) q.set('optionValueIds', ov);
    api.get<{ kits: PreviewKit[] }>(`/api/products/${encodeURIComponent(slug)}/kits?${q}`)
      .then((r) => { if (live) setKits(r.kits ?? []); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [at, tick]);
  if (!printer) return null;
  const title = (k: PreviewKit) => text3(k.title, lang) || k.id;
  return (
    <details className="border-t border-border-subtle pt-3" data-printer-services-kit-preview>
      <summary className="cursor-pointer font-semibold text-text-primary">{loc('معاينة: الأسعار والتوفر الآن (من القائمة المنشورة)', 'Preview: prices and availability now (from the published list)', 'پێشبینین: نرخ و بەردەستبوون ئێستا (لە لیستی بڵاوکراوە)')}</summary>
      <div className="mt-1 flex flex-wrap items-end gap-2">
        {printer.versions.length > 1 ? (
          <label className="flex flex-col gap-1">
            {say(loc, S.version)}
            <select className="lv-input h-9 px-2 text-[12px]" value={at} onChange={(e) => setAt(e.target.value)}>
              <option value={`${printer.slug}|`}>{say(loc, S.wholePrinter)}</option>
              {printer.versions.map((v) => <option key={v.id} value={`${printer.slug}|${v.id}`}>{v.name}</option>)}
            </select>
          </label>
        ) : null}
        <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={() => setTick((n) => n + 1)}>{loc('تحديث', 'Refresh', 'نوێکردنەوە')}</button>
      </div>
      {failed ? <p className="mt-1">{loc('تعذّر تحميل المعاينة.', 'The preview could not be loaded.', 'پێشبینینەکە بار نەکرا.')}</p>
        : !kits ? <p className="mt-1">{say(loc, S.loading)}</p>
        : kits.length === 0 ? <p className="mt-1">{loc('لا باقات منشورة لهذه الطابعة.', 'No published kits for this printer.', 'هیچ پاکێجێکی بڵاوکراوە بۆ ئەم پرینتەرە نییە.')}</p>
        : (
          <ul className="mt-1 space-y-2">
            {kits.map((k) => (
              <li key={k.id} className="rounded-lg border border-border-subtle p-2">
                <p className="flex flex-wrap items-center justify-between gap-2 text-text-primary">
                  <span className="font-semibold">{title(k)}</span>
                  <span className="inline-flex items-baseline gap-1.5">
                    {k.available && k.price_per_printer_iqd !== null && (k.before_per_printer_iqd ?? 0) > k.price_per_printer_iqd
                      ? <span dir="ltr" className="tabular-nums line-through text-text-muted">{formatIqd(k.before_per_printer_iqd as number)}</span>
                      : null}
                    <span dir="ltr" className="tabular-nums">
                      {k.available && k.price_per_printer_iqd !== null ? formatIqd(k.price_per_printer_iqd) : loc('غير متوفرة', 'Unavailable', 'بەردەست نییە')}
                    </span>
                  </span>
                </p>
                <ul className="mt-1 space-y-0.5">
                  {k.items.map((i, j) => (
                    <li key={j} className="flex flex-wrap justify-between gap-2">
                      <span>{(lang === 'en' ? i.name : i.name_ar || i.name)}{i.variant ? ` · ${i.variant}` : ''} ×{i.qty}</span>
                      <span dir="ltr" className="tabular-nums">{i.available && i.unit_price_iqd !== null ? formatIqd(i.unit_price_iqd) : (i.reason ? refusalText(i.reason, lang === 'en' || lang === 'ckb' ? lang : 'ar', i.reason) : loc('غير متوفر', 'Unavailable', 'بەردەست نییە'))}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
    </details>
  );
}
