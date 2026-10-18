/**
 * «تعبئة أبعاد الشحن من بيانات الاستيراد» — the owner's button on the import
 * dashboard (owner request 2026-10-18): POST /api/admin/catalog-import/fill-package-measures
 * copies the imported products' verified packaged weight and box into their
 * EMPTY package fields (the product, its options, its colours) — never of a
 * priced product, whose measures change only through the product form's
 * reviewed save — and answers the counts, the priced products left for that
 * form and the imported products still missing a weight or box, each with a
 * link to its editor at «الأبعاد والوزن».
 *
 * Kept apart from CatalogImportDashboard.tsx: that screen only reads the
 * import (tests/catalogImportDashboard.test.ts), and this act is not an import
 * step — it writes catalogue measures, never the queue.
 */
import { useState } from 'react';
import { AlertTriangle, Check, PackageCheck } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import * as T from '../adminProducts/theme';
import { tri, type ImportLang, type Tri } from './catalogImportStrings';

const ENDPOINT = '/api/admin/catalog-import/fill-package-measures';

const t = (ar: string, en: string, ckb: string): Tri => ({ ar, en, ckb });

export const FILL_STRINGS = {
  title: t('تعبئة أبعاد الشحن من بيانات الاستيراد', 'Fill shipping measures from the import data', 'پڕکردنەوەی قەبارە و کێشی ناردن لە زانیاری هاوردەکردنەوە'),
  intro: t(
    'ينسخ الوزن مع التغليف وأبعاد الصندوق المؤكدة من بيانات المصدر إلى المنتجات المستوردة غير المسعّرة وخياراتها وألوانها — في الخانات الفارغة فقط، ولا يكتب فوق قيمة أدخلتها هنا أو في التسعير. المنتج المسعّر لا يُعبّأ: راجع أبعاده من نموذج المنتج.',
    'Copies the verified packaged weight and box size from the source data into imported products that are not priced yet, their options and colours — into empty fields only, never over a value you entered here or in pricing. A priced product is not filled: review its dimensions in the product form.',
    'کێشی لەگەڵ بەستەبەندی و قەبارەی سندوقی پشتڕاستکراوە لە زانیاری سەرچاوەوە دەگوازێتەوە بۆ ئەو بەرهەمە هاوردەکراوانەی هێشتا نرخیان بۆ دانەنراوە و هەڵبژاردە و ڕەنگەکانیان — تەنها بۆ خانە بەتاڵەکان، و هەرگیز بەسەر بەهایەکدا نانووسێت کە لێرە یان لە نرخداناندا نووسیوتە. بەرهەمی نرخدانراو پڕناکرێتەوە: قەبارەکانی لە فۆرمی بەرهەمەکەدا پێداچوونەوە بکە.'
  ),
  run: t('تعبئة الآن', 'Fill now', 'ئێستا پڕی بکەرەوە'),
  running: t('جارٍ التعبئة…', 'Filling…', 'پڕدەکرێتەوە…'),
  importBusy: t(
    'الاستيراد يكتب الآن. لم يُملأ شيء؛ أعد المحاولة بعد دقيقة.',
    'The import is writing right now. Nothing was filled; try again in a minute.',
    'هاوردەکردن ئێستا دەنووسێت. هیچ پڕنەکرایەوە؛ دوای خولەکێک دووبارە هەوڵ بدەرەوە.'
  ),
  failed: t('تعذّرت التعبئة. أعد المحاولة.', 'The fill failed. Try again.', 'پڕکردنەوەکە سەرنەکەوت. دووبارە هەوڵ بدەرەوە.'),
  imported: t('منتجات مستوردة', 'Imported products', 'بەرهەمی هاوردەکراو'),
  productsFilled: t('منتجات عُبّئت', 'Products filled', 'بەرهەمی پڕکراوە'),
  product: t('المنتج', 'Product', 'بەرهەم'),
  option: t('الخيارات', 'Options', 'هەڵبژاردەکان'),
  color: t('الألوان', 'Colours', 'ڕەنگەکان'),
  weight: t('الوزن مع التغليف', 'Packaged weight', 'کێش لەگەڵ بەستەبەندی'),
  box: t('أبعاد الصندوق', 'Box size', 'قەبارەی سندوق'),
  kept: t('قيم موجودة أُبقيت كما هي', 'Existing values kept as they are', 'بەها هەبووەکان وەک خۆیان هێڵدرانەوە'),
  unused: t(
    'قياسات لم تُستخدم (تعارض، غير مؤكدة، صندوق ناقص)',
    'Measures not used (conflict, unverified, partial box)',
    'پێوانە بەکارنەهاتووەکان (ناکۆکی، پشتڕاستنەکراوە، سندوقی ناتەواو)'
  ),
  stillMissing: t(
    'منتجات مستوردة ما زال ينقصها الوزن أو الصندوق — أكملها يدويًا:',
    'Imported products still missing a weight or box — complete them by hand:',
    'بەرهەمە هاوردەکراوەکان کە هێشتا کێش یان سندوقیان نییە — بە دەست تەواویان بکە:'
  ),
  priced: t(
    'منتجات مسعّرة لم تُعبّأ — راجع الأبعاد من نموذج المنتج:',
    'Priced products not filled — review the dimensions in the product form:',
    'بەرهەمە نرخدانراوەکان کە پڕنەکرانەوە — قەبارەکان لە فۆرمی بەرهەمەکەدا پێداچوونەوە بکە:'
  ),
  noneMissing: t('لا ينقص أي منتج مستورد وزنٌ أو صندوق.', 'No imported product is missing a weight or box.', 'هیچ بەرهەمێکی هاوردەکراو کێش یان سندوقی کەم نییە.'),
  more: t('ومنتجات أخرى لم تُعرض:', 'More not shown:', 'بەرهەمی تری نیشاننەدراو:'),
  edit: t('تعديل', 'Edit', 'دەستکاری'),
} as const;

export interface FillKindCounts {
  weight: number;
  box: number;
}

export interface FillView {
  imported: number;
  productsFilled: number;
  filled: { product: FillKindCounts; option: FillKindCounts; color: FillKindCounts };
  kept: number;
  unused: number;
  priced: Array<{ id: string; slug: string; name: Tri }>;
  pricedTotal: number;
  missing: Array<{ id: string; slug: string; name: Tri; weight: boolean; box: boolean }>;
  missingTotal: number;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The server's answer, read defensively: numbers only for the counts, a safe id for every link. */
export function readFillReport(raw: unknown): FillView {
  const r = obj(raw);
  const filled = obj(r.filled);
  const kind = (k: string): FillKindCounts => ({ weight: n(obj(filled[k]).weight), box: n(obj(filled[k]).box) });
  const skipped = obj(r.skipped);
  const refs = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map(obj)
      .filter((m) => ID.test(s(m.id)))
      .map((m) => ({ m, ref: { id: s(m.id), slug: s(m.slug), name: { ar: s(m.name_ar), en: s(m.name_en), ckb: s(m.name_ckb) } } }));
  const missing = refs(r.still_missing).map(({ m, ref }) => ({ ...ref, weight: m.weight === true, box: m.box === true }));
  const priced = refs(r.priced_products).map(({ ref }) => ref);
  return {
    imported: n(r.imported_products),
    productsFilled: n(r.products_filled),
    filled: { product: kind('product'), option: kind('option'), color: kind('color') },
    kept: n(skipped.kept_existing),
    unused: n(skipped.conflict) + n(skipped.unverified) + n(skipped.invalid) + n(skipped.partial_box),
    priced,
    pricedTotal: Math.max(n(r.skipped_priced), priced.length),
    missing,
    missingTotal: Math.max(n(r.still_missing_total), missing.length),
  };
}

/** The product's editor, at «الأبعاد والوزن» (section 4). */
export const editorHref = (id: string) => `/admin?tab=products&edit=${encodeURIComponent(id)}&section=4`;

export function FillResult({ view, lang }: { view: FillView; lang: ImportLang }) {
  const rows = [
    ['product', FILL_STRINGS.product],
    ['option', FILL_STRINGS.option],
    ['color', FILL_STRINGS.color],
  ] as const;
  return (
    <div className="space-y-3" data-fill-result>
      <dl className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
        <div>
          <dt className={T.text2}>{tri(FILL_STRINGS.imported, lang)}</dt>
          <dd className="font-bold tabular-nums" data-fill-imported>{view.imported}</dd>
        </div>
        <div>
          <dt className={T.text2}>{tri(FILL_STRINGS.productsFilled, lang)}</dt>
          <dd className="font-bold tabular-nums" data-fill-products>{view.productsFilled}</dd>
        </div>
        <div>
          <dt className={T.text2}>{tri(FILL_STRINGS.kept, lang)}</dt>
          <dd className="font-bold tabular-nums">{view.kept}</dd>
        </div>
        <div>
          <dt className={T.text2}>{tri(FILL_STRINGS.unused, lang)}</dt>
          <dd className="font-bold tabular-nums">{view.unused}</dd>
        </div>
      </dl>
      <table className="w-full text-[13px]">
        <thead>
          <tr className={T.text2}>
            <th className="py-1 text-start font-medium" />
            <th className="py-1 text-start font-medium">{tri(FILL_STRINGS.weight, lang)}</th>
            <th className="py-1 text-start font-medium">{tri(FILL_STRINGS.box, lang)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, label]) => (
            <tr key={k} data-fill-kind={k}>
              <td className="py-1">{tri(label, lang)}</td>
              <td className="py-1 tabular-nums">{view.filled[k].weight}</td>
              <td className="py-1 tabular-nums">{view.filled[k].box}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.pricedTotal > 0 ? (
        <div className="space-y-1.5" data-fill-priced>
          <p className="text-[13px] font-bold">
            {tri(FILL_STRINGS.priced, lang)} <span className="tabular-nums">{view.pricedTotal}</span>
          </p>
          <ul className="max-h-[240px] space-y-1 overflow-y-auto text-[13px]">
            {view.priced.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2" data-fill-priced-id={m.id}>
                <a className="font-medium underline underline-offset-2" href={editorHref(m.id)}>
                  {tri(m.name, lang) || m.slug || m.id}
                </a>
                <a className={`${T.btnGhostSm} ms-auto`} href={editorHref(m.id)}>
                  {tri(FILL_STRINGS.edit, lang)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.missingTotal === 0 ? (
        <p className="flex items-center gap-1.5 text-[13px]" data-fill-none-missing>
          <Check className="h-4 w-4" aria-hidden />
          {tri(FILL_STRINGS.noneMissing, lang)}
        </p>
      ) : (
        <div className="space-y-1.5" data-fill-missing>
          <p className="text-[13px] font-bold">
            {tri(FILL_STRINGS.stillMissing, lang)} <span className="tabular-nums">{view.missingTotal}</span>
          </p>
          <ul className="max-h-[320px] space-y-1 overflow-y-auto text-[13px]">
            {view.missing.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2" data-fill-missing-id={m.id}>
                <a className="font-medium underline underline-offset-2" href={editorHref(m.id)}>
                  {tri(m.name, lang) || m.slug || m.id}
                </a>
                {m.weight ? <span className={`${T.chip} text-[11px]`}>{tri(FILL_STRINGS.weight, lang)}</span> : null}
                {m.box ? <span className={`${T.chip} text-[11px]`}>{tri(FILL_STRINGS.box, lang)}</span> : null}
                <a className={`${T.btnGhostSm} ms-auto`} href={editorHref(m.id)}>
                  {tri(FILL_STRINGS.edit, lang)}
                </a>
              </li>
            ))}
          </ul>
          {view.missingTotal > view.missing.length ? (
            <p className={`text-[12px] ${T.text2}`}>
              {tri(FILL_STRINGS.more, lang)} <span className="tabular-nums">{view.missingTotal - view.missing.length}</span>
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function PackageMeasuresFill() {
  const { lang: rawLang } = useLanguage();
  const lang: ImportLang = rawLang === 'en' || rawLang === 'ckb' ? rawLang : 'ar';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Tri | null>(null);
  const [view, setView] = useState<FillView | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setView(readFillReport(await api.post<unknown>(ENDPOINT, {})));
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'CATALOG_IMPORT_BUSY' ? FILL_STRINGS.importBusy : FILL_STRINGS.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${T.surface} space-y-3 p-4`} data-package-fill aria-labelledby="package-fill-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id="package-fill-title" className="flex items-center gap-2 text-[16px] font-bold">
            <PackageCheck className="h-4 w-4" aria-hidden />
            {tri(FILL_STRINGS.title, lang)}
          </h3>
          <p className={`max-w-[68ch] text-[13px] leading-relaxed ${T.text2}`}>{tri(FILL_STRINGS.intro, lang)}</p>
        </div>
        <button type="button" className={T.btnPrimary} onClick={() => void run()} disabled={busy} aria-busy={busy} data-package-fill-run>
          {tri(busy ? FILL_STRINGS.running : FILL_STRINGS.run, lang)}
        </button>
      </div>
      {error ? (
        <p className="flex items-center gap-1.5 text-[13px] text-[var(--color-error-ink)]" role="alert" data-package-fill-error>
          <AlertTriangle className="h-4 w-4" aria-hidden />
          {tri(error, lang)}
        </p>
      ) : null}
      {view ? <FillResult view={view} lang={lang} /> : null}
    </section>
  );
}
