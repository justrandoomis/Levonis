/**
 * «طابعات مستعملة» — the shop's graded stock, on a page of its own.
 *
 * WHY THIS PAGE INVENTS NOTHING. The catalogue already models this. A product
 * the owner graded carries a `condition` document — kind (open_box / used /
 * refurbished), grade, hours on the clock, the fault it had, the repair that
 * was done, and the LEVO warranty that still covers it — and the home page
 * already renders a rail of them. So "used" is not a new concept to be
 * introduced here with its own flag, its own admin field and its own second
 * opinion about which printers are second-hand. It is a filter over data that
 * exists, and this page is that filter with room to read.
 *
 * WHAT THE DATA CANNOT DO, said plainly rather than faked:
 *
 *   1. THERE IS NO SERVER-SIDE CONDITION FILTER. `GET /api/products` takes
 *      `search`, `category`, `type`, `limit` and `offset` — no `condition`.
 *      The only selection on `condition_doc` that exists anywhere is the one
 *      `GET /api/home` runs for its shelf, capped at the twelve newest. So
 *      this page reads that shelf (src/lib/api.ts `fetchGradedStock`) and SAYS
 *      the shelf is the newest arrivals, with a link to the full catalogue,
 *      instead of pretending a twelve-row window is the whole of the used
 *      stock. Answering «لا توجد» because we stopped looking would be the one
 *      unforgivable bug on a page like this.
 *
 *   2. THE DATA DOES NOT KNOW A PRINTER FROM A SPOOL. The condition document
 *      grades a PRODUCT; it carries no product kind, and the catalogue's
 *      section ids are not reachable from a card without a second request. A
 *      graded filament spool would therefore appear here. That is why the
 *      lead sentence says «الأجهزة والمنتجات المستعملة» rather than promising
 *      printers only — the page describes what it can actually prove.
 *
 * THE KIND FILTER IS THE CUSTOMER'S, NOT A DEFAULT WE CHOSE FOR THEM.
 * «مستعمل» and «مجدّد» are different purchases — one is cheap, the other was
 * broken and repaired — and Open Box is neither: it is a new machine whose box
 * was opened. Hiding any of them behind a heading called "used" would sell a
 * refurbished unit as an ordinary second-hand one. So all three are shown,
 * each labelled, with chips to narrow to one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, PackageOpen, PackageSearch } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { fetchGradedStock, formatIqd, type GradedProduct } from '../lib/api';
import {
  conditionGradeLabel,
  conditionKindLabel,
  type ConditionKind,
} from '../lib/condition';
import SafeImage from '../components/ui/SafeImage';
import { ErrorState, EmptyState } from '../components/ui/AsyncStates';
import { ProductGridSkeleton } from '../components/ui/Skeleton';
import { productPrimaryImage } from '../lib/productImage';

/** 'all' plus the three kinds the server can actually store. */
type KindFilter = 'all' | ConditionKind;

const FILTERS: readonly KindFilter[] = ['all', 'used', 'refurbished', 'open_box'];

export default function UsedPrinters() {
  const { loc, lang, dir } = useLanguage();
  const navigate = useNavigate();
  const [rows, setRows] = useState<GradedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [kind, setKind] = useState<KindFilter>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchGradedStock());
    } catch (e) {
      // A failed fetch is an ERROR with a retry — never rendered as "no stock".
      // The two states look identical to a customer and mean opposite things.
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * A row with no `condition` document is not graded and has no business on
   * this page. The server's own predicate (`condition_doc <> '{}'`) should
   * already have excluded it, but the shelf is a public payload and this page
   * would otherwise render an ungraded product under the word «مستعمل» —
   * which is the single worst thing it could say.
   */
  const graded = useMemo(() => rows.filter((p) => !!p.condition), [rows]);
  const shown = useMemo(
    () => (kind === 'all' ? graded : graded.filter((p) => p.condition?.kind === kind)),
    [graded, kind]
  );

  const countFor = (k: KindFilter): number =>
    k === 'all' ? graded.length : graded.filter((p) => p.condition?.kind === k).length;

  const filterLabel = (k: KindFilter): string =>
    k === 'all' ? loc('الكل', 'All', 'هەموو') : conditionKindLabel(k, lang);

  const goBack = () => {
    // navigate(-1) is a no-op on a deep link or a refresh, and this page is
    // reached from a card on the home rail — so home is the honest fallback.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <div className="w-full min-h-screen bg-canvas text-zinc-300 font-sans pb-24" data-used-printers-page>
      <header className="sticky top-0 z-40 material material-thin px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-surface-raised text-white hover:bg-surface-selected active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus transition-colors"
        >
          <Back aria-hidden="true" className="w-5 h-5" />
        </button>
        <h1 className="text-white font-bold text-lg leading-6 flex-1 min-w-0 truncate">
          {/* NOT «طابعات مستعملة». A condition document grades a PRODUCT and
              carries no product kind, and a card does not expose enough
              taxonomy to filter to printers without a second request — so a
              graded filament spool or a graded nozzle set lands on this page
              too. An H1 that says "used printers" over a spool of PLA has told
              the customer the wrong thing, and an Open Box unit is a NEW
              machine in an opened carton, which is the wrong thing in the
              other direction. The name says what the data can prove; when a
              kind lands on the condition document (or a category filter lands
              on the shelf query) it can narrow and be renamed back. */}
          {loc('مستعمل ومجدّد و Open Box', 'Used, refurbished & Open Box', 'بەکارهاتوو، نۆژەنکراوە و Open Box')}
        </h1>
      </header>

      <div className="p-4 max-w-4xl mx-auto">
        {/* The scope of the page, in one sentence, before anything is shown.
            It names the window (newest arrivals) because the endpoint behind
            it is a shelf and not a search — see the header note. */}
        <p className="text-[12px] leading-5 text-zinc-500 mb-4">
          {/* WHAT THE CONDITION DOCUMENT CAN ACTUALLY PROVE, AND NOTHING MORE.
              This sentence used to promise three things the data does not
              carry, on the one page in the shop where a buyer leans hardest on
              our word. «كل قطعة مفحوصة» has NO backing field at all — the
              document records a grade, a fault, a repair and notes, and
              nothing anywhere records that an inspection happened. «ساعات
              تشغيلها» is `usage_hours: number | null`, and the card three
              components below proves the promise false by rendering the hours
              only when they are not null. And «ضمان ليفو الذي يغطيها» is
              `warranty_months`, which is free to be 0 — a unit with no
              warranty at all. The general claim is gone; each unit now states
              its own two figures on its own card, including when the answer is
              «غير مذكورة» or «بدون ضمان». */}
          {loc(
            'الأجهزة والمنتجات المستعملة والمجدّدة وOpen Box المتوفرة الآن — أحدث ما وصل. حالة كل قطعة وأي عيب فيها مذكوران على صفحتها.',
            'Used, refurbished and Open Box items available now — the latest arrivals. Each unit’s grade and any fault it has are stated on its page.',
            'ئامێر و بەرهەمی بەکارهاتوو و نۆژەنکراوە و Open Box کە ئێستا بەردەستن — نوێترین هاتووەکان. حاڵەتی هەر دانەیەک و هەر عەیبێکی تێدابێت لەسەر پەڕەکەی نووسراوە.'
          )}
        </p>

        {/* The chips are rendered even while loading so the page does not jump
            when the rows land; their counts simply read zero until then. */}
        <div
          role="group"
          aria-label={loc('تصفية حسب الحالة', 'Filter by condition', 'پاڵاوتن بەپێی حاڵەت')}
          data-used-filters
          className="flex flex-wrap gap-2 mb-5"
        >
          {FILTERS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className="lv-choice px-3 py-2 text-[13px] leading-5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {filterLabel(k)}
              <span className="ms-1.5 text-[11px] leading-4 text-zinc-500 tabular-nums" dir="ltr">
                {countFor(k)}
              </span>
            </button>
          ))}
        </div>

        {loading ? (
          <ProductGridSkeleton count={6} />
        ) : error ? (
          <ErrorState error={error} onRetry={load} />
        ) : graded.length === 0 ? (
          /* NOTHING GRADED IN THE SHOP AT ALL — a real state, not a failure.
             The shop sells new machines too, so the way out is the catalogue
             rather than a retry button that would change nothing. */
          <EmptyState
            icon={<PackageSearch aria-hidden="true" className="w-6 h-6" />}
            title={loc(
              'لا توجد قطع مستعملة معروضة الآن',
              'Nothing used is listed right now',
              'ئێستا هیچ شتێکی بەکارهاتوو نییە'
            )}
            description={loc(
              'تصل القطع المستعملة والمجدّدة على دفعات. تصفّح المتجر الآن أو عد لاحقًا.',
              'Used and refurbished units arrive in batches. Browse the shop now, or come back later.',
              'شتی بەکارهاتوو و نۆژەنکراوە بە کۆمەڵ دێن. ئێستا سەیری فرۆشگا بکە یان دواتر بگەڕێوە.'
            )}
            action={
              <Link to="/products" className="lv-button lv-button-primary px-4">
                {loc('تصفّح المتجر', 'Browse the shop', 'سەیری فرۆشگا بکە')}
              </Link>
            }
          />
        ) : shown.length === 0 ? (
          /* A DIFFERENT EMPTY. There IS graded stock; this filter just matches
             none of it. Telling the customer "nothing used is listed" here
             would be false, and the way out is the filter, not the catalogue. */
          <EmptyState
            icon={<PackageOpen aria-hidden="true" className="w-6 h-6" />}
            title={loc(
              'لا يوجد ضمن هذه الحالة',
              'Nothing in this condition',
              'هیچ لەم حاڵەتەدا نییە'
            )}
            description={loc(
              'جرّب حالة أخرى من الأعلى.',
              'Try another condition above.',
              'حاڵەتێکی تر لە سەرەوە تاقی بکەرەوە.'
            )}
            action={
              <button type="button" onClick={() => setKind('all')} className="lv-button lv-button-secondary px-4">
                {loc('اعرض الكل', 'Show all', 'هەموویان پیشان بدە')}
              </button>
            }
          />
        ) : (
          <>
            <ul data-used-grid className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-3">
              {shown.map((p) => (
                <li key={p.id} className="min-w-0">
                  <GradedCard p={p} lang={lang} />
                </li>
              ))}
            </ul>
            {/* The shelf's limit, stated. A customer who counted twelve cards
                and stopped looking is a customer we misled. */}
            <p className="mt-5 text-[12px] leading-5 text-zinc-500">
              {loc(
                'تُعرض هنا أحدث القطع المستعملة. لعرض المتجر كاملًا:',
                'The newest graded units are shown here. For the whole shop:',
                'نوێترین دانەکان لێرە پیشان دەدرێن. بۆ هەموو فرۆشگا:'
              )}{' '}
              <Link to="/products" className="text-gold underline underline-offset-2 hover:text-gold-light">
                {loc('كل المنتجات', 'All products', 'هەموو بەرهەمەکان')}
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One graded card.
 *
 * A separate component from `ProductCard` for the same reason OpenBoxShelf's
 * card is separate — the price row means something else here. The struck-out
 * number is the price of a DIFFERENT product (the new one this is a used copy
 * of), not a compare-at on this row, so rendering it through a component that
 * means "this was cheaper before" would tell the customer a used printer is on
 * sale. It is only ever shown when the SERVER found an honest saving.
 */
function GradedCard({ p, lang }: { p: GradedProduct; lang: string }) {
  /** `lang` stays a prop because conditionKindLabel/conditionGradeLabel take
   *  it, but the card's OWN sentences go through `loc(ar, en, ckb)` — three
   *  languages, never a two-way test that drops Sorani into the Arabic arm. */
  const { loc } = useLanguage();
  const condition = p.condition ?? null;
  const reference = p.condition_reference;
  const price = p.display_price_iqd ?? p.price_iqd;

  return (
    <Link
      to={`/product/${p.slug || p.id}`}
      data-graded-card={p.id}
      data-condition-kind={condition?.kind ?? ''}
      className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus min-w-0"
    >
      <div className="relative aspect-square overflow-hidden bg-black">
        <SafeImage src={productPrimaryImage(p)} alt={p.name} aspect="square" className="w-full h-full" />
        {condition ? (
          /* The ONE tinted element on the card, because the grade is the whole
             reason this row is not an ordinary listing. */
          <span className="absolute top-2 start-2 inline-flex items-center gap-1 rounded-full bg-info/15 px-2 py-1 text-[10px] leading-4 font-bold text-info backdrop-blur-sm">
            <PackageOpen aria-hidden="true" className="w-3 h-3" />
            {conditionKindLabel(condition.kind, lang)}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
        {/* The product name is English in every language and never translated
            — the same rule the ordinary card follows. */}
        <h2 dir="ltr" className="min-h-[2.2rem] text-[13px] font-medium leading-snug text-white line-clamp-2 text-start">
          {p.name}
        </h2>

        {condition ? (
          <span className="text-[11px] leading-4 text-zinc-400">
            {conditionGradeLabel(condition.grade, lang)}
            {' · '}
            {/* THE HOURS ARE SAID EITHER WAY. Rendering them only when they are
                present, under a lead sentence that promised they are stated,
                left a silent gap that reads as "nothing to report" rather than
                as "nobody typed it". `usage_hours` is nullable and a used
                machine with no recorded hours is a real thing to say out loud. */}
            {condition.usage_hours !== null ? (
              <>
                <span dir="ltr" className="tabular-nums">
                  {condition.usage_hours.toLocaleString('en-US')}
                </span>
                {/* loc(), not `lang === 'en' ? 'h' : 'س'`. That is the banned
                    `dir === 'rtl' ? ar : en` idiom wearing a different test:
                    Sorani is also right-to-left, so the Kurdish reader falls
                    into the ARABIC branch and is served «س» for an hour. */}
                {` ${loc('س', 'h', 'کژ')}`}
              </>
            ) : (
              loc('ساعات التشغيل غير مذكورة', 'hours not stated', 'کاتژمێری کارکردن نەنووسراوە')
            )}
            {' · '}
            {/* And the warranty, which the card never showed at all while the
                page's lead sentence promised «ضمان ليفو الذي يغطيها».
                `warranty_months` is free to be 0, which is a unit carrying no
                warranty — a fact a second-hand buyer is entitled to before the
                product page, not after it. */}
            {condition.warranty_months > 0
              ? loc(
                  `ضمان ${condition.warranty_months} شهر`,
                  `${condition.warranty_months}-month warranty`,
                  `گەرەنتی ${condition.warranty_months} مانگ`
                )
              : loc('بدون ضمان', 'no warranty', 'بێ گەرەنتی')}
          </span>
        ) : null}

        <span className="mt-auto flex flex-col pt-1">
          <span className="text-[14px] leading-5 font-bold text-white tabular-nums">{formatIqd(price)}</span>
          {reference ? (
            <span className="text-[11px] leading-4 text-zinc-500 line-through tabular-nums">
              {formatIqd(reference.reference_iqd)}
            </span>
          ) : null}
        </span>
      </div>
    </Link>
  );
}
