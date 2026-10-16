/**
 * «اكتمال المعلومات» — INFORMATION COMPLETENESS (the Bambu import spec §H.2;
 * the server: worker/lib/knowledge/infoCompleteness.ts).
 *
 * How well the knowledge model DESCRIBES a product of its type — never
 * whether it may be sold (that is the commercial «ناقص», `missing_count`,
 * which this does not read or change). Shown only for a product with
 * knowledge rows: the list's column and the form's card.
 *
 *   ratio       (verified + unverified) / applicable
 *   «ناقص»      not_found + not_published («Missing» / «کەم»)
 *   «غير معروف» no fact, or one marked unknown («Unknown» / «نەزانراو»)
 *   «غير مؤكَّد» stated, not confirmed by an official source («Unverified»)
 *   not_applicable is excluded from everything.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export type InfoLang = 'ar' | 'en' | 'ckb';
interface Tri {
  ar: string;
  en: string;
  ckb: string;
}
const t = (ar: string, en: string, ckb: string): Tri => ({ ar, en, ckb });
const w = (x: Tri, lang: InfoLang) => x[lang] || x.en;

/** §H.2's words, exactly, and the card's own. */
export const INFO_WORDS = {
  column: t('اكتمال المعلومات', 'Information completeness', 'تەواوی زانیاری'),
  missing: t('ناقص', 'Missing', 'کەم'),
  unknown: t('غير معروف', 'Unknown', 'نەزانراو'),
  unverified: t('غير مؤكَّد', 'Unverified', 'پشتڕاست نەکراوەتەوە'),
  of: t('من', 'of', 'لە'),
  hint: t(
    'ما تذكره بيانات المنتج من المواصفات المتوقعة لنوعه. لا يؤثر على البيع.',
    'How much of what a product of this type should state is stated. It never affects sale.',
    'چەندە لەو تایبەتمەندییانەی بۆ ئەم جۆرە بەرهەمە چاوەڕوان دەکرێن نووسراون. کاریگەری لەسەر فرۆشتن نییە.'
  ),
} as const;

export interface InfoCompletenessSummary {
  ratio: number | null;
  applicable: number;
  verified: number;
  unverified: number;
  missing: number;
  unknown: number;
}

export interface InfoCompletenessCardData extends InfoCompletenessSummary {
  type: string | null;
  not_found: number;
  not_published: number;
  gaps: Array<{ key: string; label: Tri; status: string }>;
}

const percent = (ratio: number | null): string => (ratio === null ? '—' : `${Math.round(ratio * 100)}%`);

/** The list's cell: the percentage and the three counts apart; «—» for a product with no knowledge row. */
export function InfoCompletenessCell({ value, lang }: { value: InfoCompletenessSummary | null | undefined; lang: InfoLang }) {
  if (!value) return <span className="text-[12px] text-[var(--ap-text-3)]">—</span>;
  const tone = value.ratio !== null && value.ratio >= 0.9 ? 'text-[var(--ap-text-1)]' : 'text-[var(--ap-warning)]';
  return (
    <span className="inline-flex flex-col gap-0.5" data-info-completeness={value.ratio === null ? 'none' : Math.round(value.ratio * 100)}>
      <span className={`text-[13.5px] font-bold tabular-nums ${tone}`} dir="ltr">
        {percent(value.ratio)}
      </span>
      <span className="text-[11px] text-[var(--ap-text-3)] whitespace-nowrap">
        {value.missing > 0 ? (
          <>
            {w(INFO_WORDS.missing, lang)} <bdi className="tabular-nums">{value.missing}</bdi>
          </>
        ) : null}
        {value.unknown > 0 ? (
          <>
            {value.missing > 0 ? ' · ' : ''}
            {w(INFO_WORDS.unknown, lang)} <bdi className="tabular-nums">{value.unknown}</bdi>
          </>
        ) : null}
        {value.unverified > 0 ? (
          <>
            {value.missing > 0 || value.unknown > 0 ? ' · ' : ''}
            {w(INFO_WORDS.unverified, lang)} <bdi className="tabular-nums">{value.unverified}</bdi>
          </>
        ) : null}
      </span>
    </span>
  );
}

const GAP_ORDER: Array<{ status: string[]; word: Tri }> = [
  { status: ['not_found', 'not_published'], word: INFO_WORDS.missing },
  { status: ['unknown'], word: INFO_WORDS.unknown },
  { status: ['unverified'], word: INFO_WORDS.unverified },
];

/** The form's card: the same counts and the keys that are not stated, by name. Nothing for a product with no knowledge row. */
export function InfoCompletenessView({ data, lang }: { data: InfoCompletenessCardData; lang: InfoLang }) {
  return (
    <section className="lv-surface mb-2.5 min-w-0 p-3 text-[12px]" data-info-completeness-card aria-label={w(INFO_WORDS.column, lang)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-bold text-text-primary">{w(INFO_WORDS.column, lang)}</h3>
        <span className="text-[15px] font-black tabular-nums text-text-primary" dir="ltr">
          {percent(data.ratio)}
        </span>
        <span className="text-text-muted">
          <bdi className="tabular-nums">{data.verified + data.unverified}</bdi> {w(INFO_WORDS.of, lang)} <bdi className="tabular-nums">{data.applicable}</bdi>
        </span>
      </div>
      <p className="mt-1 text-[11px] text-text-muted">{w(INFO_WORDS.hint, lang)}</p>
      {GAP_ORDER.map((g) => {
        const keys = data.gaps.filter((k) => g.status.includes(k.status));
        if (!keys.length) return null;
        return (
          <div key={g.word.en} className="mt-2" data-info-gap={g.status.join('+')}>
            <p className="font-semibold text-text-secondary">
              {w(g.word, lang)} <bdi className="tabular-nums">({keys.length})</bdi>
            </p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {keys.map((k) => (
                <li key={k.key} className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-text-secondary" data-info-key={k.key}>
                  {w(k.label, lang)}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/** Reads `/api/admin/products-v2/:id/info-completeness` and draws the card; nothing while loading or without data. */
export default function InfoCompletenessCard({ productId, lang }: { productId: string | null; lang: InfoLang }) {
  const [data, setData] = useState<InfoCompletenessCardData | null>(null);
  useEffect(() => {
    setData(null);
    if (!productId) return;
    const ac = new AbortController();
    api
      .get<{ info_completeness: InfoCompletenessCardData | null }>(`/api/admin/products-v2/${encodeURIComponent(productId)}/info-completeness`, { signal: ac.signal })
      .then((r) => {
        if (!ac.signal.aborted) setData(r.info_completeness ?? null);
      })
      .catch(() => {
        // A database without 0194, an older Worker: no card, never an error over the form.
      });
    return () => ac.abort();
  }, [productId]);
  return data ? <InfoCompletenessView data={data} lang={lang} /> : null;
}
