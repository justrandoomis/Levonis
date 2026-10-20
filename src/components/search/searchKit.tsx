import React from 'react';
import { X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import type { ApiProduct, ProductsListResponse, SearchChip } from '../../lib/api';
import AvailabilityLine from '../product/AvailabilityLine';
import { linkWithSelection } from './resultLink';

/**
 * WHAT THE SEARCH UNDERSTOOD, SAID BACK (smart search 1.7, the assistant plan
 * §6 «Search bar» and «Result cards»).
 *
 * The listing answers `/api/products?search=…&nl=1` with data, never wording
 * (worker/routes/products.ts): the constraints the words became
 * (`understood.chips`), the codes typed whole that a product carries
 * (`exact`), the codes nothing the shopper may see carries (`exact_miss`) and
 * the selection each product matched (`matched`). This file says it in Arabic,
 * English and Sorani:
 *
 *   - CHIPS, one per constraint: «حتى 30,000 د.ع ✕», «أسود ✕», «بدون AMS ✕».
 *     Removing one puts the search text without the words of that chip in the
 *     field (`drop`, built by the parser), so a removed chip is just another
 *     search and the field always shows what is applied.
 *   - THE EXACT LINE: «تطابق دقيق لـ FAP035», or «لا يوجد تطابق دقيق لـ 10102»
 *     with the results under it labelled as near, never as the code.
 *   - THE ROW NOTE: «تطابق دقيق» / «قريب» on a row, and the card three-state
 *     availability line (../product/AvailabilityLine.tsx, the shared
 *     `cardAvailability` of packages/catalog).
 *   - THE LINK, with the matched selection as `?v=` (./resultLink.ts).
 *
 * A LAZY CHUNK. The field (./LiveSearch.tsx) is in every first paint; it gets
 * these pieces from its panel (./LiveSearchPanel.tsx), and the results page
 * imports them directly, so none of the wording is in the entry.
 */

/** What a search answer says beyond its products. */
export type SearchExtras = Pick<ProductsListResponse, 'understood' | 'exact' | 'exact_miss' | 'matched'>;

type Loc = (ar: string, en: string, ckb: string) => string;

/**
 * The base colours in three languages: the same words as the listing colour
 * filter (packages/catalog/src/bambuImport/registry/colours.ts `BASE_COLOURS`,
 * tests/searchUi.test.ts holds them equal). Written here rather than imported
 * because that table rides in the listing chunk, and a second importer would
 * split it into a chunk of its own.
 */
const COLOURS: Readonly<Record<string, readonly [string, string, string]>> = {
  black: ['أسود', 'Black', 'ڕەش'],
  white: ['أبيض', 'White', 'سپی'],
  grey: ['رمادي', 'Grey', 'خۆڵەمێشی'],
  red: ['أحمر', 'Red', 'سوور'],
  orange: ['برتقالي', 'Orange', 'پرتەقاڵی'],
  yellow: ['أصفر', 'Yellow', 'زەرد'],
  green: ['أخضر', 'Green', 'سەوز'],
  blue: ['أزرق', 'Blue', 'شین'],
  purple: ['بنفسجي', 'Purple', 'مۆر'],
  pink: ['وردي', 'Pink', 'پەمەیی'],
  brown: ['بني', 'Brown', 'قاوەیی'],
  beige: ['بيج', 'Beige', 'بێژ'],
  gold: ['ذهبي', 'Gold', 'زێڕین'],
  silver: ['فضي', 'Silver', 'زیوی'],
  transparent: ['شفاف', 'Transparent', 'ڕوون'],
  multicolour: ['متعدد الألوان', 'Multicolour', 'فرەڕەنگ'],
};
export const COLOUR_WORDS = COLOURS;

/** A word the parser excluded, as the shop writes it: «AMS», «Combo», or the word itself. */
const excluded = (w: string): string => (w === 'ams' ? 'AMS' : w === 'combo' ? 'Combo' : w);

/**
 * One chip, in the reader language. A dinar bound is written by the shop
 * money hook (`money`), so it reads in the currency the cards beside it
 * read in; a dollar bound is what the shopper typed («$500», «5 ورقات»).
 * Exported for the test.
 */
export function chipLabel(c: SearchChip, loc: Loc, money: (iqd: number) => string): string {
  switch (c.kind) {
    case 'price': {
      const fmt = (n: number) => (c.currency === 'USD' ? `$${n.toLocaleString('en-US')}` : money(n));
      if (c.min !== null && c.max !== null) return `${fmt(c.min)} – ${fmt(c.max)}`;
      if (c.max !== null) return loc(`حتى ${fmt(c.max)}`, `Up to ${fmt(c.max)}`, `تا ${fmt(c.max)}`);
      return c.min !== null ? loc(`${fmt(c.min)} فأكثر`, `${fmt(c.min)} or more`, `${fmt(c.min)} و زیاتر`) : '';
    }
    case 'sale':
      return c.value === 'direct' ? loc('متوفر الآن', 'In stock now', 'ئێستا بەردەستە') : loc('طلب مسبق', 'Pre-order', 'پێش-داواکاری');
    case 'spool':
      return c.value === 'refill'
        ? loc('عبوة بدون بكرة', 'Refill (no spool)', 'پڕکردنەوە بەبێ ماسوورە')
        : loc('مع بكرة', 'With spool', 'لەگەڵ ماسوورە');
    case 'diameter':
      return loc(`قطر ${c.value} مم`, `${c.value} mm`, `تیرەی ${c.value} مم`);
    case 'color': {
      const w = COLOURS[c.value];
      if (!w) return '';
      const name = loc(w[0], w[1], w[2]);
      return c.not ? loc(`ليس ${name}`, `Not ${name.toLowerCase()}`, `جگە لە ${name}`) : name;
    }
    case 'material': {
      const m = c.value.toUpperCase();
      return c.not ? loc(`بدون ${m}`, `Not ${m}`, `بێ ${m}`) : m;
    }
    case 'sort':
      return c.value === 'price_asc'
        ? loc('الأرخص أولاً', 'Cheapest first', 'هەرزانترین سەرەتا')
        : c.value === 'price_desc'
          ? loc('الأغلى أولاً', 'Most expensive first', 'گرانترین سەرەتا')
          : '';
    case 'exclude': {
      const w = excluded(c.value);
      return loc(`بدون ${w}`, `Not ${w}`, `بێ ${w}`);
    }
    default:
      return '';
  }
}

/** The codes of a line, joined the way each language lists (Arabic and Sorani share the comma «،»). */
const codes = (list: readonly string[], lang: string) => list.join(lang === 'en' ? ', ' : '، ');

/**
 * ABOVE THE RESULTS: the chips, then the exact line. Nothing at all when the
 * answer understood nothing and named no code, so a plain search looks as it
 * always did.
 */
export function SearchHead({
  a,
  count,
  onDrop,
  stale = false,
  className = '',
}: {
  a: SearchExtras;
  /** Products listed under it: the near-match sentence only labels results that are there. */
  count: number;
  onDrop: (text: string) => void;
  /** The answer is for older text than the field holds: its chips are shown, dimmed, and cannot be removed. */
  stale?: boolean;
  className?: string;
}) {
  const { loc, lang } = useLanguage();
  const { money } = useMoney();
  const chips = (a.understood?.chips ?? []).map((c) => ({ c, label: chipLabel(c, loc, money) })).filter((x) => x.label);
  const miss = a.exact_miss ?? [];
  const hits = [...new Set((a.exact ?? []).map((h) => h.key))];
  /** Listed rows that are not an exact hit: the near sentence labels those only. */
  const near = count - new Set((a.exact ?? []).map((h) => h.product_id)).size;
  if (!chips.length && !miss.length && !hits.length) return null;
  return (
    <div className={`space-y-1 ${className}`} data-search-head>
      {chips.length > 0 && (
        <div
          role="group"
          aria-label={loc('ما فهمناه من البحث', 'What we understood', 'ئەوەی لە گەڕانەکەت تێگەیشتین')}
          data-understood
          className={`flex flex-wrap items-center gap-x-1.5 transition-opacity duration-150 ${stale ? 'opacity-60' : ''}`}
        >
          {chips.map(({ c, label }) => (
            <button
              key={`${c.kind}:${label}`}
              type="button"
              data-understood-chip={c.kind}
              disabled={stale}
              aria-label={loc(`أزل: ${label}`, `Remove: ${label}`, `لابردن: ${label}`)}
              onClick={() => onDrop(c.drop)}
              className="group inline-flex min-h-11 shrink-0 items-center focus-visible:outline-none disabled:cursor-default"
            >
              <span className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full bg-surface-selected pe-2 ps-3 text-[12.5px] font-bold text-text-primary transition-colors group-hover:bg-surface-raised group-focus-visible:ring-2 group-focus-visible:ring-focus">
                <bdi>{label}</bdi>
                <X aria-hidden="true" className="size-3.5 text-text-muted" strokeWidth={2.4} />
              </span>
            </button>
          ))}
        </div>
      )}
      {/* Both lines when one code was carried and another was not («10101 10102»). */}
      {hits.length > 0 && (
        <p data-exact-hit className="text-[13px] font-semibold leading-snug text-success">
          {loc('تطابق دقيق لـ', 'Exact match for', 'هاوتای ورد بۆ')} «<bdi dir="ltr">{codes(hits, lang)}</bdi>»
        </p>
      )}
      {miss.length > 0 && (
        <p data-exact-miss className="text-[13px] font-semibold leading-snug text-text-secondary">
          {loc('لا يوجد تطابق دقيق لـ', 'No exact match for', 'هیچ هاوتایەکی ورد نەدۆزرایەوە بۆ')} «<bdi dir="ltr">{codes(miss, lang)}</bdi>»
          {/* What is listed under it is near the code, never the code itself; an exact hit beside it is not near. */}
          {near > 0 && (
            <span data-exact-near className="block text-[12px] font-medium text-text-muted">
              {hits.length > 0
                ? loc('النتائج الأخرى قريبة منه، وليست تطابقًا دقيقًا', 'The other results are near matches, not exact', 'ئەنجامەکانی تر نزیکن، هاوتای ورد نین')
                : loc('النتائج أدناه قريبة منه، وليست تطابقًا دقيقًا', 'The results below are near matches, not exact', 'ئەنجامەکانی خوارەوە نزیکن، هاوتای ورد نین')}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

/** Under a row: «تطابق دقيق» or «قريب» when a code was typed, then the card availability line. */
export function RowNote({ p, a }: { p: ApiProduct; a: SearchExtras }) {
  const { loc } = useLanguage();
  const exact = (a.exact ?? []).some((h) => h.product_id === p.id);
  const near = !exact && (a.exact_miss?.length ?? 0) > 0;
  return (
    <div className="mt-0.5 flex items-center gap-2">
      {exact ? (
        <span data-row-exact className="shrink-0 rounded-full bg-success/15 px-1.5 text-[10.5px] font-bold leading-[16px] text-success">
          {loc('تطابق دقيق', 'Exact match', 'هاوتای ورد')}
        </span>
      ) : near ? (
        <span data-row-near className="shrink-0 rounded-full bg-surface-selected px-1.5 text-[10.5px] font-bold leading-[16px] text-text-muted">
          {loc('قريب', 'Near', 'نزیک')}
        </span>
      ) : null}
      <AvailabilityLine product={p} className="min-w-0 flex-1" />
    </div>
  );
}

/** Where a result opens: its page, on the selection its codes matched. */
export const resultHref = (href: string, p: ApiProduct, a: SearchExtras | null | undefined): string =>
  linkWithSelection(href, a?.matched?.[p.id]);
