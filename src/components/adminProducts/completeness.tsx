/**
 * «ناقص» — THE RED FLAGS OF «تعديل منتج» / «إضافة منتج», THE «ناقص N» BADGE OF
 * THE PRODUCTS LIST AND THE OWNER'S «إخفاء المنتجات الناقصة عن الزبائن»
 * (owner brief 2026-10-10: «اخفاء كل المنتجات التي تنقصها التكاليف والحقول
 * الناقصه مع اعلام احمر للحقل الناقص»).
 *
 * The SERVER decides what is missing (worker/lib/productCompleteness.ts, one
 * central list); this module only renders its codes. A private code (cost, the
 * USD pricing data) reaches the verified owner alone; any other admin receives
 * one OWNER_DATA item instead, rendered here like any other.
 *
 * The flags describe the SAVED product: while the form has unsaved edits a
 * quiet line says so («تُحدَّث العلامات بعد الحفظ») rather than guessing.
 *
 * Every string is Arabic, English and Sorani (docs/DECISIONS.md row 183):
 * the field labels come from packages/contracts/src/productCompleteness.ts,
 * the sentences below from COMPLETENESS_UI.
 */
import React, { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';
import {
  COMPLETENESS_ENTRIES,
  type CompletenessItemCode,
} from '../../../packages/contracts/src/productCompleteness';

export type CompletenessLang = 'ar' | 'en' | 'ckb';
export interface Tri {
  ar: string;
  en: string;
  ckb: string;
}
export const tri = (t: Tri, lang: string): string => (lang === 'en' ? t.en : lang === 'ckb' ? t.ckb : t.ar);
export const fill = (s: string, vars: Record<string, string | number>): string =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));

export const COMPLETENESS_UI = {
  missingField: {
    ar: 'ناقص — مطلوب لعرض المنتج للزبائن',
    en: 'Missing — required to show the product to customers',
    ckb: 'ناتەواوە — پێویستە بۆ نیشاندانی بەرهەمەکە بە کڕیاران',
  },
  missingOn: { ar: 'ناقص في «{name}»', en: 'Missing on «{name}»', ckb: 'لە «{name}» ناتەواوە' },
  badge: { ar: 'ناقص {n}', en: '{n} missing', ckb: '{n} ناتەواو' },
  badgeLabel: {
    ar: 'ينقص هذا المنتج {n} من الحقول المطلوبة',
    en: 'This product is missing {n} required fields',
    ckb: 'ئەم بەرهەمە {n} خانەی پێویستی کەمە',
  },
  heldBadge: { ar: 'مخفي عن الزبائن', en: 'Hidden from customers', ckb: 'لە کڕیاران شاردراوە' },
  bannerHeld: {
    ar: 'هذا المنتج ناقص ({n}) — مخفي عن الزبائن حتى يكتمل.',
    en: 'This product is incomplete ({n}) — hidden from customers until it is completed.',
    ckb: 'ئەم بەرهەمە ناتەواوە ({n}) — تا تەواو دەبێت لە کڕیاران شاردراوەتەوە.',
  },
  bannerShown: {
    ar: 'هذا المنتج ناقص ({n}) — ما زال يظهر للزبائن لأن «إخفاء المنتجات الناقصة» متوقف.',
    en: 'This product is incomplete ({n}) — still shown to customers because «hide incomplete products» is off.',
    ckb: 'ئەم بەرهەمە ناتەواوە ({n}) — هێشتا بە کڕیاران نیشان دەدرێت چونکە «شاردنەوەی بەرهەمە ناتەواوەکان» ڕاگیراوە.',
  },
  bannerWillHide: {
    ar: 'هذا المنتج ناقص ({n}) — سيُخفى عن الزبائن عند حفظه نشطاً.',
    en: 'This product is incomplete ({n}) — it will be hidden from customers when saved as active.',
    ckb: 'ئەم بەرهەمە ناتەواوە ({n}) — کاتێک بە چالاکی پاشەکەوت دەکرێت لە کڕیاران دەشاردرێتەوە.',
  },
  afterSave: { ar: 'تُحدَّث العلامات بعد الحفظ.', en: 'The flags update after saving.', ckb: 'نیشانەکان دوای پاشەکەوتکردن نوێ دەبنەوە.' },
  newProduct: {
    ar: 'تُفحص الحقول المطلوبة بعد أول حفظ.',
    en: 'The required fields are checked after the first save.',
    ckb: 'خانە پێویستەکان دوای یەکەم پاشەکەوتکردن دەپشکنرێن.',
  },
  sectionMissing: { ar: '{n} ناقص', en: '{n} missing', ckb: '{n} ناتەواو' },
  // ---- the products list
  filterIncomplete: { ar: 'الناقصة فقط', en: 'Incomplete only', ckb: 'تەنها ناتەواوەکان' },
  // ---- the owner's switch
  switchTitle: {
    ar: 'إخفاء المنتجات الناقصة عن الزبائن',
    en: 'Hide incomplete products from customers',
    ckb: 'شاردنەوەی بەرهەمە ناتەواوەکان لە کڕیاران',
  },
  switchExplain: {
    ar: 'المنتج الذي ينقصه حقل مطلوب (التكلفة، السعر، الصورة، القسم، الوزن أو أبعاد الصندوق…) يختفي من المتجر والبحث والصفحة الرئيسية والرابط المباشر حتى يكتمل. لا يُمس أي طلب أو هدية.',
    en: 'A product missing a required field (cost, price, image, section, weight or box size…) disappears from the shop, search, the home page and its direct link until it is completed. No order or gift is touched.',
    ckb: 'ئەو بەرهەمەی خانەیەکی پێویستی کەمە (تێچوو، نرخ، وێنە، بەش، کێش یان قەبارەی سندوق…) لە فرۆشگا، گەڕان، پەڕەی سەرەکی و بەستەری ڕاستەوخۆ ون دەبێت تا تەواو دەبێت. دەست لە هیچ داواکاری و دیارییەک نادرێت.',
  },
  switchOff: { ar: 'متوقف', en: 'Off', ckb: 'ڕاگیراوە' },
  switchOn: { ar: 'مُفعّل', en: 'On', ckb: 'چالاکە' },
  willHide: {
    ar: 'سيُخفى {n} منتجاً (ويتوقف {m} عرضاً مجمّعاً).',
    en: '{n} products will be hidden ({m} bundles stop).',
    ckb: '{n} بەرهەم دەشاردرێتەوە ({m} پاکێج ڕادەگیرێت).',
  },
  hiddenNow: { ar: 'مخفي الآن: {n} منتجاً.', en: 'Hidden now: {n} products.', ckb: 'ئێستا شاردراوە: {n} بەرهەم.' },
  stale: {
    ar: 'لم يُفحص {n} منتجاً بعد — حدّث العدّ أولاً.',
    en: '{n} products are not checked yet — recount first.',
    ckb: '{n} بەرهەم هێشتا نەپشکنراون — سەرەتا دووبارە بژمێرە.',
  },
  recount: { ar: 'تحديث العدّ', en: 'Recount', ckb: 'دووبارە ژماردنەوە' },
  recounting: { ar: 'جارٍ فحص المنتجات…', en: 'Checking products…', ckb: 'بەرهەمەکان دەپشکنرێن…' },
  turnOn: { ar: 'تفعيل الإخفاء', en: 'Turn hiding on', ckb: 'شاردنەوە چالاک بکە' },
  turnOff: { ar: 'إيقاف الإخفاء', en: 'Turn hiding off', ckb: 'شاردنەوە ڕابگرە' },
  confirmOn: {
    ar: 'تأكيد: إخفاء {n} منتجاً عن الزبائن الآن',
    en: 'Confirm: hide {n} products from customers now',
    ckb: 'پشتڕاستکردنەوە: ئێستا {n} بەرهەم لە کڕیاران بشارەوە',
  },
  showList: { ar: 'اعرض المنتجات الناقصة', en: 'Show the incomplete products', ckb: 'بەرهەمە ناتەواوەکان پیشان بدە' },
  failed: { ar: 'تعذّر تنفيذ الطلب — أعد المحاولة.', en: 'The request failed — try again.', ckb: 'داواکارییەکە سەرکەوتوو نەبوو — دووبارە هەوڵ بدەرەوە.' },
  // ---- the data-file preview
  afterApplyComplete: {
    ar: 'سيكتمل المنتج بعد التطبيق.',
    en: 'The product will be complete after applying.',
    ckb: 'دوای جێبەجێکردن بەرهەمەکە تەواو دەبێت.',
  },
  afterApplyMissing: {
    ar: 'سيبقى ناقصاً بعد التطبيق ({n}):',
    en: 'Still missing after applying ({n}):',
    ckb: 'دوای جێبەجێکردن هێشتا ناتەواو دەبێت ({n}):',
  },
  nowMissing: { ar: 'ناقص الآن: {n}', en: 'Missing now: {n}', ckb: 'ئێستا ناتەواو: {n}' },
} as const satisfies Record<string, Tri>;

/** One missing item, as the server sends it. */
export interface CompletenessItemDto {
  code: CompletenessItemCode;
  option_id: string;
  section: number;
  private: boolean;
}

export interface CompletenessRead {
  installed: boolean;
  applicable?: boolean;
  evaluated?: boolean;
  complete?: boolean | null;
  held?: boolean;
  switch_on?: boolean;
  missing_count?: number;
  items?: CompletenessItemDto[];
}

/** The label of one code in the viewer's language. */
export const completenessLabel = (code: CompletenessItemCode, lang: string): string => tri(COMPLETENESS_ENTRIES[code].label, lang);
export const completenessHint = (code: CompletenessItemCode, lang: string): string => tri(COMPLETENESS_ENTRIES[code].hint, lang);

/** The saved product's verdict, read again whenever `version` changes (a load, a save). */
export function useProductCompleteness(productId: string | null, version: string): CompletenessRead | null {
  const [read, setRead] = useState<CompletenessRead | null>(null);
  useEffect(() => {
    if (!productId) {
      setRead(null);
      return;
    }
    let alive = true;
    api
      .get<CompletenessRead>(`/api/admin/products-v2/${encodeURIComponent(productId)}/completeness`)
      .then((r) => {
        if (alive) setRead(r);
      })
      .catch(() => {
        // A flag is advice, never a gate: a failed read shows no flag.
        if (alive) setRead(null);
      });
    return () => {
      alive = false;
    };
  }, [productId, version]);
  return read;
}

interface Ctx {
  items: readonly CompletenessItemDto[];
  lang: string;
  /** Option value id → its display name, for «ناقص في …». */
  optionName?: (id: string) => string;
}

const CompletenessContext = createContext<Ctx>({ items: [], lang: 'ar' });

export function CompletenessProvider({ items, lang, optionName, children }: Ctx & { children: ReactNode }) {
  return <CompletenessContext.Provider value={{ items, lang, optionName }}>{children}</CompletenessContext.Provider>;
}

/** Is this code missing (on this model, when given; on the product, when '')? */
export function useMissing(code: CompletenessItemCode | undefined, optionId?: string): boolean {
  const { items } = useContext(CompletenessContext);
  if (!code) return false;
  return items.some((i) => i.code === code && (optionId === undefined || i.option_id === optionId));
}

/** How many items fall in one form section (the section header's red count). */
export function useSectionMissing(section: number): number {
  const { items } = useContext(CompletenessContext);
  return items.filter((i) => i.section === section).length;
}

/**
 * THE RED LINE UNDER A FIELD (or at the top of a section): an icon and a
 * sentence, red text with enough contrast on the dark panel, announced to a
 * screen reader through the id the control's `aria-describedby` names.
 */
export function MissingNote({ id, code, optionId, withLabel = false }: { id?: string; code: CompletenessItemCode; optionId?: string; withLabel?: boolean }) {
  const { lang, optionName } = useContext(CompletenessContext);
  const missing = useMissing(code, optionId);
  if (!missing) return null;
  const where = optionId && optionName ? optionName(optionId) : '';
  return (
    <p id={id} className="mt-1 flex items-start gap-1 text-[11px] font-bold leading-snug text-red-300" data-missing={code}>
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
      <span className="min-w-0">
        {withLabel ? `${completenessLabel(code, lang)} — ` : ''}
        {where ? `${fill(tri(COMPLETENESS_UI.missingOn, lang), { name: where })} — ` : ''}
        {tri(COMPLETENESS_UI.missingField, lang)}
      </span>
    </p>
  );
}

/** A section-level flag: a red box listing the codes of this section (used where no single input carries it). */
export function MissingBlock({ codes }: { codes: readonly CompletenessItemCode[] }) {
  const { items, lang } = useContext(CompletenessContext);
  const hits = items.filter((i) => codes.includes(i.code) && i.option_id === '');
  if (!hits.length) return null;
  return (
    <div role="note" className="lv-alert lv-alert-danger mb-2.5 min-w-0 px-3 py-2 text-[12px] leading-snug text-text-primary" data-missing-block>
      {hits.map((i) => (
        <p key={i.code} className="flex items-start gap-1.5" data-missing={i.code}>
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
          <span className="min-w-0">
            <b>{completenessLabel(i.code, lang)}</b> — {tri(COMPLETENESS_UI.missingField, lang)}. {completenessHint(i.code, lang)}
          </span>
        </p>
      ))}
    </div>
  );
}

/** A stable id for a field's red line (the control's aria-describedby). */
export function useMissingId(): string {
  return `missing-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** The «ناقص N» pill (list rows, section headers). */
export function MissingBadge({ n, lang, held = false }: { n: number; lang: string; held?: boolean }) {
  if (n <= 0 && !held) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {n > 0 && (
        <span
          className="lv-chip [--chip:var(--color-danger)] [--chip-ink:var(--color-error-ink)] inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-bold"
          data-missing-badge={n}
          title={fill(tri(COMPLETENESS_UI.badgeLabel, lang), { n })}
        >
          <AlertTriangle className="h-3 w-3 text-red-400" aria-hidden="true" />
          <span aria-hidden="true">{fill(tri(COMPLETENESS_UI.badge, lang), { n })}</span>
          <span className="sr-only">{fill(tri(COMPLETENESS_UI.badgeLabel, lang), { n })}</span>
        </span>
      )}
      {held && (
        <span className="inline-flex h-5 items-center rounded-full bg-surface-selected px-2 text-[11px] font-bold text-text-primary" data-held-badge>
          {tri(COMPLETENESS_UI.heldBadge, lang)}
        </span>
      )}
    </span>
  );
}

/** The banner at the top of the form: how many, which, and what customers see. */
export function CompletenessBanner({ read, lang, dirty, status }: { read: CompletenessRead | null; lang: string; dirty: boolean; status: string }) {
  if (!read || !read.installed || read.applicable === false || !read.evaluated) return null;
  const items = read.items ?? [];
  if (!items.length) return null;
  const n = items.length;
  const sentence = read.held
    ? COMPLETENESS_UI.bannerHeld
    : read.switch_on && status !== 'active'
      ? COMPLETENESS_UI.bannerWillHide
      : read.switch_on
        ? COMPLETENESS_UI.bannerHeld
        : COMPLETENESS_UI.bannerShown;
  return (
    <div role="status" className="lv-alert lv-alert-danger mb-2.5 min-w-0 px-3 py-2 text-[12px] leading-snug text-text-primary" data-completeness-banner>
      <p className="flex items-start gap-1.5 font-bold">
        <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
        <span className="min-w-0">{fill(tri(sentence, lang), { n })}</span>
      </p>
      <ul className="mt-1 flex flex-wrap gap-1.5 ps-5">
        {[...new Map(items.map((i) => [i.code, i])).values()].map((i) => (
          <li key={i.code} className="lv-chip [--chip:var(--color-danger)] [--chip-ink:var(--color-error-ink)] rounded-md px-1.5 py-0.5 text-[11px]" data-missing={i.code}>
            {completenessLabel(i.code, lang)}
          </li>
        ))}
      </ul>
      {dirty && <p className="mt-1 ps-5 text-[11px] text-text-secondary">{tri(COMPLETENESS_UI.afterSave, lang)}</p>}
    </div>
  );
}
