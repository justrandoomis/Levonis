/**
 * «خصص طابعتك» phase 2 (migration 0235; owner rulings 2026-11-17) — the two
 * panels of the shared price list that are not services:
 *
 * - THE MEMBERSHIP: on/off, which tiers a customer may buy WITH a printer, and
 *   which tier each package preselects (default «none»; the Complete package
 *   includes no membership). The price is never stored here: it is the live
 *   membership_plans row, shown read-only with a link to the memberships admin.
 * - THE FILAMENT KITS: owner-made from real products / variants / colours, with
 *   a per-printer quantity and the printers they fit. A kit costs the sum of its
 *   items' live prices — there is no discount field anywhere.
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
  MAX_KITS,
  MAX_KIT_ITEMS,
  MAX_KIT_ITEM_QTY,
  MEMBERSHIP_TIERS,
  kitItemKey,
  type FilamentKit,
  type KitItem,
  type MembershipTier,
  type PrinterServicesConfig,
} from '../../../packages/pricing/src/printerServices';

type Loc = (ar: string, en: string, ckb: string) => string;
type Upd = (fn: (d: PrinterServicesConfig) => void) => void;
interface Printer { id: string; slug: string; name: string; versions: Array<{ id: string; name: string }> }

const KIT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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
    const dupItems: number[] = [];
    const printerItems: number[] = [];
    k.items.forEach((it, j) => {
      const key = kitItemKey(it);
      if (keys.has(key)) dupItems.push(j);
      keys.add(key);
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
  const rules: Array<[RegExp, (m: RegExpExecArray) => string]> = [
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
    [/^(kits\.[^:]+): printer (\S+) is not mapped/, (m) => `${kitName(m[1])}: ${loc(`الطابعة ${m[2]} غير مربوطة بالخدمات`, `printer ${m[2]} is not mapped`, `پرینتەری ${m[2]} نەبەستراوەتەوە`)}`],
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

// ------------------------------------------------------------- kits

interface ProductDoc {
  id: string; slug: string; name_ar: string; name_en: string; name_ckb?: string;
  options: Array<{ id: string; name_ar: string; name_en: string; name_ckb: string; active: boolean; group_en?: string; order: number }>;
  colors: Array<{ id: string; name_ar: string; name_en: string; name_ckb: string; active: boolean; option_id: string | null; option_ids?: string[]; order: number }>;
}
interface PreviewKit {
  id: string; title: { ar: string; en: string; ckb: string }; available: boolean; price_per_printer_iqd: number | null; total_iqd: number | null;
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

function useDocs(ids: string[]): Record<string, ProductDoc | null> {
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

const pick3 = (o: { name_ar: string; name_en: string; name_ckb?: string }, lang: string) =>
  (lang === 'en' ? o.name_en || o.name_ar : lang === 'ckb' ? o.name_ckb || o.name_en || o.name_ar : o.name_ar || o.name_en) || '';

export function KitsPanel({ draft, upd, loc, lang, printers, productId }: { draft: PrinterServicesConfig; upd: Upd; loc: Loc; lang: string; printers: Printer[]; productId: string }) {
  const kits = draft.kits ?? [];
  const itemIds = kits.flatMap((k) => k.items.map((i) => i.product_id));
  const docs = useDocs(itemIds);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const namesKey = [...new Set(itemIds)].sort().join(',');
  useEffect(() => {
    let live = true;
    if (namesKey) void resolveProductNames(namesKey.split(','), lang).then((m) => { if (live) setNames(m); });
    return () => { live = false; };
  }, [namesKey, lang]);
  const [adding, setAdding] = useState<number | null>(null);
  const mapped = printers.filter((p) => draft.products[p.id]);
  // Every product in a printer section (mapped or not): none of them can be a kit item.
  const printerIds = new Set([...printers.map((p) => p.id), ...Object.keys(draft.products)]);
  const problems = kitProblems(kits, printerIds);

  const kitAt = (d: PrinterServicesConfig, n: number) => (d.kits ?? [])[n];
  const addKit = () => upd((d) => {
    const list = d.kits ?? [];
    let n = list.length + 1;
    while (list.some((k) => k.id === `kit-${n}`)) n += 1;
    d.kits = [...list, { id: `kit-${n}`, active: false, sort: list.length, title: { ar: '', en: '', ckb: '' }, items: [], printers: null }];
  });
  const removeKit = (n: number) => upd((d) => { d.kits = (d.kits ?? []).filter((_, j) => j !== n); });
  const setItem = (n: number, j: number, patch: Partial<KitItem>) => upd((d) => {
    const it = kitAt(d, n).items[j];
    Object.assign(it, patch);
    it.option_value_ids = [...it.option_value_ids].sort();
  });

  return (
    <section className="mt-3 rounded-lg border border-border-subtle p-3 text-[12px] text-text-secondary" data-printer-services-kits>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-bold text-text-primary">{loc('باقات الفيلامنت', 'Filament kits', 'پاکێجەکانی فیلامێنت')}</h2>
        <button type="button" className="lv-button lv-button-secondary lv-button-sm" disabled={kits.length >= MAX_KITS} onClick={addKit}>
          + {loc('باقة جديدة', 'New kit', 'پاکێجی نوێ')}
        </button>
      </div>
      <p className="mt-1">
        {loc(
          'من منتجات حقيقية. سعر الباقة = مجموع الأسعار الحالية لمنتجاتها، بلا خصم. الكمية لكل طابعة وتتبع عدد الطابعات. تظهر غير متوفرة إذا نفد أحد منتجاتها أو لا يُشحن بطريقة شحن الطابعة.',
          'Made of real products. A kit costs the sum of its items\' live prices, no discount. Quantities are per printer and follow the printer quantity. It shows as unavailable when an item is out or cannot ship the printer\'s way.',
          'لە بەرهەمی ڕاستەقینە. نرخی پاکێج = کۆی نرخی ئێستای بەرهەمەکانی، بێ داشکاندن. بڕەکان بۆ هەر پرینتەرێکن و بە ژمارەی پرینتەرەکان دەچن. ئەگەر بەرهەمێکی نەما یان بە جۆری ناردنی پرینتەرەکە نەنێردرێت، وەک بەردەست نییە پیشان دەدرێت.'
        )}
      </p>
      {kits.length === 0 ? <p className="mt-2">{loc('لا توجد باقات بعد.', 'No kits yet.', 'هێشتا هیچ پاکێجێک نییە.')}</p> : null}
      <div className="mt-2 space-y-3">
        {kits.map((k, n) => (
          <KitEditor
            key={n}
            kit={k}
            loc={loc}
            lang={lang}
            docs={docs}
            names={names}
            mapped={mapped}
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
      <KitPreview printers={printers.filter((p) => p.id === productId && draft.products[p.id])} loc={loc} lang={lang} />
    </section>
  );
}

function KitEditor({ kit, loc, lang, docs, names, mapped, adding, onAdding, onKit, onItem, onRemove, problems, isPrinter }: {
  kit: FilamentKit; loc: Loc; lang: string; docs: Record<string, ProductDoc | null>; names: Map<string, string>; mapped: Printer[];
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
  const anyPrinter = kit.printers === null;
  const onPrinter = (pid: string) => kit.printers?.filter((r) => r.product_id === pid) ?? [];

  return (
    <div className="rounded-lg border border-border-subtle p-2" data-printer-services-kit={kit.id}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          {loc('المعرّف', 'Id', 'ناسنامە')}
          <input className="lv-input h-9 px-2 text-[12px]" dir="ltr" maxLength={32} aria-invalid={idBad || undefined} value={kit.id} onChange={(e) => onKit((k) => { k.id = e.target.value.toLowerCase(); })} />
        </label>
        <label className="flex flex-col gap-1">
          {loc('الترتيب', 'Sort', 'ڕیزبەندی')}
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
          {loc('مفعّلة', 'Active', 'چالاک')}
        </label>
        <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={onRemove}>
          {loc('حذف الباقة', 'Remove the kit', 'سڕینەوەی پاکێج')}
        </button>
      </div>
      {idBad ? <p className="mt-1 text-text-primary" role="alert">{loc('المعرّف: حروف إنجليزية صغيرة وأرقام و _ أو -، حتى 32.', 'Id: lowercase letters, digits, _ or -, up to 32.', 'ناسنامە: پیتی بچووکی ئینگلیزی، ژمارە، _ یان -، تا 32.')}</p> : null}
      {problems.dupId ? <p className="mt-1 text-text-primary" role="alert" data-kit-problem="dup-id">{loc('هذا المعرّف مستخدم لباقة أخرى — اختر معرّفاً آخر.', 'This id is used by another kit — choose another id.', 'ئەم ناسنامەیە بۆ پاکێجێکی تر بەکارهاتووە — ناسنامەیەکی تر هەڵبژێرە.')}</p> : null}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {text('ar', loc('الاسم بالعربية', 'Name in Arabic', 'ناو بە عەرەبی'))}
        {text('en', loc('الاسم بالإنجليزية', 'Name in English', 'ناو بە ئینگلیزی'))}
        {text('ckb', loc('الاسم بالكردية', 'Name in Kurdish', 'ناو بە کوردی'))}
      </div>

      <h3 className="mt-3 font-semibold text-text-primary">{loc('المنتجات (الكمية لكل طابعة)', 'Items (quantity per printer)', 'بەرهەمەکان (بڕ بۆ هەر پرینتەرێک)')}</h3>
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
                onKit((k) => { k.items = [...k.items, { product_id: id, option_value_ids: [], color_id: null, qty: 1 }]; });
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

      <h3 className="mt-3 font-semibold text-text-primary">{loc('الطابعات التي تناسبها', 'Printers it fits', 'ئەو پرینتەرانەی بۆی دەگونجێن')}</h3>
      <label className="mt-1 flex items-center gap-2 text-[13px] text-text-primary">
        <input type="checkbox" checked={anyPrinter} onChange={(e) => onKit((k) => { k.printers = e.target.checked ? null : []; })} />
        {loc('كل الطابعات المسجّلة', 'Every enrolled printer', 'هەموو پرینتەرە تۆمارکراوەکان')}
      </label>
      {anyPrinter ? null : (
        <ul className="mt-1 space-y-1">
          {mapped.map((p) => {
            const rows = onPrinter(p.id);
            const whole = rows.some((r) => r.option_value_id === null);
            return (
              <li key={p.id}>
                <label className="flex items-center gap-2 text-text-primary">
                  <input type="checkbox" checked={rows.length > 0} onChange={(e) => onKit((k) => {
                    const rest = (k.printers ?? []).filter((r) => r.product_id !== p.id);
                    k.printers = e.target.checked ? [...rest, { product_id: p.id, option_value_id: null }] : rest;
                  })} />
                  {p.name}
                </label>
                {rows.length > 0 && p.versions.length > 1 ? (
                  <div className="mt-1 flex flex-wrap gap-3 ps-6">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={whole} onChange={(e) => onKit((k) => {
                        const rest = (k.printers ?? []).filter((r) => r.product_id !== p.id);
                        k.printers = e.target.checked ? [...rest, { product_id: p.id, option_value_id: null }] : [...rest, { product_id: p.id, option_value_id: p.versions[0].id }];
                      })} />
                      {loc('كل النسخ', 'Every version', 'هەموو وەشانەکان')}
                    </label>
                    {whole ? null : p.versions.map((v) => (
                      <label key={v.id} className="flex items-center gap-2">
                        <input type="checkbox" checked={rows.some((r) => r.option_value_id === v.id)} onChange={(e) => onKit((k) => {
                          const list = k.printers ?? [];
                          k.printers = e.target.checked
                            ? [...list, { product_id: p.id, option_value_id: v.id }]
                            : list.filter((r) => !(r.product_id === p.id && r.option_value_id === v.id));
                        })} />
                        {v.name}
                      </label>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
          {mapped.length === 0 ? <li>{loc('لا توجد طابعات مربوطة بعد.', 'No printers mapped yet.', 'هێشتا هیچ پرینتەرێک نەبەستراوەتەوە.')}</li> : null}
        </ul>
      )}
    </div>
  );
}

function ItemRow({ item, doc, name, loc, lang, onChange, onRemove, problem = null }: {
  item: KitItem; doc: ProductDoc | null | undefined; name: string; loc: Loc; lang: string;
  onChange: (patch: Partial<KitItem>) => void; onRemove: () => void;
  /** What the save would refuse about this item: a printer, or the same product and selection twice. */
  problem?: 'printer' | 'duplicate' | null;
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
  return (
    <li className="rounded-lg border border-border-subtle p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[13px] text-text-primary">{display}</span>
        <label className="flex items-center gap-1">
          {loc('الكمية', 'Qty', 'بڕ')}
          <input
            className="lv-input h-9 px-2 text-[12px] tabular-nums"
            inputMode="numeric"
            dir="ltr"
            size={3}
            value={String(item.qty)}
            onChange={(e) => onChange({ qty: Math.max(1, Math.min(MAX_KIT_ITEM_QTY, Number(e.target.value.replace(/[^\d]/g, '') || 1))) })}
          />
        </label>
        <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={onRemove}>
          {loc('حذف المنتج', 'Remove the item', 'سڕینەوەی بەرهەم')}
        </button>
      </div>
      {doc === null ? <p className="mt-1">{loc('تعذّرت قراءة المنتج.', 'The product could not be read.', 'بەرهەمەکە نەخوێندرایەوە.')}</p> : null}
      {problem === 'printer' ? <p className="mt-1 text-text-primary" role="alert" data-kit-problem="printer">{loc('الطابعة لا تكون منتجاً داخل باقة — احذفه.', 'A printer cannot be a kit item — remove it.', 'پرینتەر نابێتە بەرهەمێکی ناو پاکێج — بیسڕەوە.')}</p> : null}
      {problem === 'duplicate' ? <p className="mt-1 text-text-primary" role="alert" data-kit-problem="dup-item">{loc('نفس المنتج والاختيار مرتين — احذف هذا وارفع كمية الأول.', "The same product and selection twice — remove this one and raise the first one's quantity.", 'هەمان بەرهەم و هەڵبژاردە دوو جار — ئەمە بسڕەوە و بڕی یەکەم زیاد بکە.')}</p> : null}
      {doc && (groups.length > 0 && options.length > 0 || colours.length > 0) ? (
        <div className="mt-1 flex flex-wrap gap-2">
          {options.length > 0 ? groups.map((g) => {
            const inGroup = options.filter((o) => (o.group_en ?? '') === g);
            const chosen = inGroup.find((o) => item.option_value_ids.includes(o.id))?.id ?? '';
            return (
              <select
                key={g || 'options'}
                className="lv-input h-9 px-2 text-[12px]"
                aria-label={g || loc('النسخة', 'Version', 'وەشان')}
                value={chosen}
                onChange={(e) => {
                  const rest = item.option_value_ids.filter((id) => !inGroup.some((o) => o.id === id));
                  onChange({ option_value_ids: e.target.value ? [...rest, e.target.value] : rest });
                }}
              >
                <option value="">{g ? `${g} — ?` : loc('اختر النسخة', 'Choose the version', 'وەشانەکە هەڵبژێرە')}</option>
                {inGroup.map((o) => <option key={o.id} value={o.id}>{pick3(o, lang)}</option>)}
              </select>
            );
          }) : null}
          {colours.length > 0 ? (
            <select
              className="lv-input h-9 px-2 text-[12px]"
              aria-label={loc('اللون', 'Colour', 'ڕەنگ')}
              value={item.color_id ?? ''}
              onChange={(e) => onChange({ color_id: e.target.value || null })}
            >
              <option value="">{loc('اختر اللون', 'Choose the colour', 'ڕەنگەکە هەڵبژێرە')}</option>
              {colours.map((c) => <option key={c.id} value={c.id}>{pick3(c, lang)}</option>)}
            </select>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The customer's view of the kits for this printer, from the PUBLISHED list
 * (GET /api/products/:slug/kits — the live prices and availability the shop
 * would answer now, priced as for a guest). A saved draft shows here only after
 * it is published.
 */
function KitPreview({ printers, loc, lang }: { printers: Printer[]; loc: Loc; lang: string }) {
  const [at, setAt] = useState(printers[0] ? `${printers[0].slug}|` : '');
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
  if (!printers.length) return null;
  const title = (k: PreviewKit) => (lang === 'en' ? k.title.en : lang === 'ckb' ? k.title.ckb : k.title.ar) || k.title.en || k.id;
  return (
    <div className="mt-3 border-t border-border-subtle pt-3" data-printer-services-kit-preview>
      <h3 className="font-semibold text-text-primary">{loc('معاينة: الأسعار والتوفر الآن (من القائمة المنشورة)', 'Preview: prices and availability now (from the published list)', 'پێشبینین: نرخ و بەردەستبوون ئێستا (لە لیستی بڵاوکراوە)')}</h3>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <select className="lv-input h-9 px-2 text-[12px]" value={at} onChange={(e) => setAt(e.target.value)} aria-label={loc('الطابعة', 'Printer', 'پرینتەر')}>
          {printers.flatMap((p) => [
            <option key={p.id} value={`${p.slug}|`}>{p.name}</option>,
            ...p.versions.map((v) => <option key={v.id} value={`${p.slug}|${v.id}`}>{`${p.name} — ${v.name}`}</option>),
          ])}
        </select>
        <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={() => setTick((n) => n + 1)}>{loc('تحديث', 'Refresh', 'نوێکردنەوە')}</button>
      </div>
      {failed ? <p className="mt-1">{loc('تعذّر تحميل المعاينة.', 'The preview could not be loaded.', 'پێشبینینەکە بار نەکرا.')}</p>
        : !kits ? <p className="mt-1">{loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…')}</p>
        : kits.length === 0 ? <p className="mt-1">{loc('لا باقات منشورة لهذه الطابعة.', 'No published kits for this printer.', 'هیچ پاکێجێکی بڵاوکراوە بۆ ئەم پرینتەرە نییە.')}</p>
        : (
          <ul className="mt-1 space-y-2">
            {kits.map((k) => (
              <li key={k.id} className="rounded-lg border border-border-subtle p-2">
                <p className="flex flex-wrap items-center justify-between gap-2 text-text-primary">
                  <span className="font-semibold">{title(k)}</span>
                  <span dir="ltr" className="tabular-nums">
                    {k.available && k.price_per_printer_iqd !== null ? formatIqd(k.price_per_printer_iqd) : loc('غير متوفرة', 'Unavailable', 'بەردەست نییە')}
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
    </div>
  );
}
