import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Plus, Scale, Store } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useGoBack } from '../lib/useGoBack';
import { readRecentlyViewed } from '../lib/recentlyViewed';
import { ApiError } from '../lib/api';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';
import {
  MAX_COMPARE_IDS,
  fetchCandidates,
  fetchComparison,
  labelIndex,
  priceRow,
  readIds,
  columnName,
  writeIds,
  type CompareLang,
  type CompareProductCard,
  type CompareResult,
  type PowerAdvice,
} from '../lib/compare';
import { compareStrings } from '../components/compare/strings';
import VerdictBand from '../components/compare/VerdictBand';
import BasisNote from '../components/compare/BasisNote';
import SpecChart from '../components/compare/SpecChart';
import PriceRow from '../components/compare/PriceRow';
import SpecTable from '../components/compare/SpecTable';
import CompareSlots from '../components/compare/CompareSlots';
import ProductPicker, { CandidateGrid } from '../components/compare/ProductPicker';
import PowerBlock from '../components/compare/PowerBlock';

/**
 * «المقارنة» — THE PAGE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDER OF THIS PAGE IS ITS DESIGN.
 *
 *   1. THE VERDICT. Someone who reads only the first screen has their answer:
 *      each machine, its share of the decisive axes, what it wins on, and what
 *      it does not.
 *   2. ONE LINE NAMING THE BASIS, so an empty row further down is never a
 *      mystery.
 *   3. ONE CHART over the axes the server already chose. Not two.
 *   4. PRICE ALONE, as a trade-off, rendered from the server's own synthetic
 *      row so the page cannot disagree with its own verdict.
 *   5. THE TABLE, in the server's groups, shared ones first.
 *   6. THE «الفروقات فقط» FILTER, which lives with the table it filters.
 *
 * Managing the set — remove, replace, reorder — comes last, because it is the
 * thing you do AFTER reading, and putting controls above the answer is how a
 * comparison page becomes a form.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE IDS LIVE IN THE URL, AND THAT IS THE FEATURE.
 *
 * `/compare?ids=a,b` is what the product button and the assistant button open,
 * and it is a LINK someone can send. So every change — adding, removing,
 * replacing, reordering — is a history PUSH of a new `?ids=`, never component
 * state: back undoes the last change, and a recipient sees exactly what the
 * sender was looking at, in the same column order (the server preserves the
 * request order on purpose).
 *
 * The three shapes are the three states: no ids (pick both), one id (the
 * product page's «قارن», with the second slot open), two to four (a
 * comparison).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SIGNED OUT WORKS. Neither endpoint is behind `requireAuth` and nothing here
 * touches the session. A comparison is a reason to visit the shop.
 *
 * A REFUSAL ABOUT ONE COLUMN IS ANSWERED ABOUT THAT COLUMN. The server names
 * the offending product — `COMPARE_NO_SPECS` carries `product_id`,
 * `COMPARE_MERCHANT_PRODUCT` carries `ids` — so the page offers to drop that
 * one and carry on rather than showing a dead end with the other machine's
 * comparison one tap away behind it.
 */

/** The ids a refusal blames, when it blamed any. */
function blamedIds(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.details ?? {};
  if (error.code === 'COMPARE_NO_SPECS' && typeof details.product_id === 'string') {
    return [details.product_id];
  }
  // «الفيلمنت مقابل الفيلمنت، الطابعة مقابل الطابعة». The server names the
  // column that is not the same kind as the rest, in the same shape, so the
  // page offers to drop it rather than showing a dead end with a perfectly
  // good comparison one tap away behind it.
  if (error.code === 'COMPARE_TYPE_MISMATCH' && typeof details.product_id === 'string') {
    return [details.product_id];
  }
  if (error.code === 'COMPARE_MERCHANT_PRODUCT' && Array.isArray(details.ids)) {
    return details.ids.filter((id): id is string => typeof id === 'string');
  }
  return [];
}

export default function Compare() {
  const { lang, dir } = useLanguage();
  const s = compareStrings(lang);
  const goBack = useGoBack('/products');
  const [params, setParams] = useSearchParams();

  const ids = useMemo(() => readIds(params), [params]);
  // The string, not the array: an array literal is a new object every render
  // and would re-run the fetch effect forever.
  const idsKey = ids.join(',');

  const [products, setProducts] = useState<CompareProductCard[]>([]);
  const [comparison, setComparison] = useState<CompareResult | null>(null);
  /**
   * The mains answer per column, as GET /api/compare sends it: trilingual
   * ordered points, aligned index-for-index with `products`, and present for a
   * SINGLE column too — «كم تستهلك الطابعة» is worth answering about one
   * machine. Held beside `comparison` rather than inside it because the server
   * emits it beside the comparison for the same reason: it exists whether or
   * not there is a second column to compare against.
   */
  const [power, setPower] = useState<PowerAdvice[] | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  /**
   * A RETRY HAS TO BE ABLE TO ASK THE SAME QUESTION AGAIN.
   *
   * The obvious retry — write the same `?ids=` back — changes nothing the
   * effect depends on, so it would refetch nothing while pushing a duplicate
   * history entry that the back button then has to be pressed twice to escape.
   * A counter in the dependency list is the honest "do it again".
   */
  const [attempt, setAttempt] = useState(0);

  /** Replace `?ids=` and push, so the back button undoes exactly this change. */
  const setIds = useCallback(
    (next: string[]) => {
      const value = writeIds(next);
      const query = new URLSearchParams();
      if (value) query.set('ids', value);
      setParams(query);
    },
    [setParams]
  );

  // ------------------------------------------------------------- the fetch

  useEffect(() => {
    if (!idsKey) {
      setProducts([]);
      setComparison(null);
      setPower(undefined);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetchComparison(idsKey.split(','), { signal: controller.signal })
      .then((res) => {
        setProducts(res.products);
        setComparison(res.comparison);
        setPower(res.power);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        // The previous comparison is cleared deliberately: leaving it on screen
        // under an error message would show a comparison that no longer matches
        // the URL the visitor would then share.
        setProducts([]);
        setComparison(null);
        setPower(undefined);
        setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [idsKey, attempt]);

  // ------------------------------------------------------- the empty state

  /**
   * WITH NOTHING PLACED THERE IS NO ANCHOR, so `/api/compare/candidates` — which
   * ranks relative to one — has nothing to rank against. The honest anchor is
   * the last machine this browser looked at: `recentlyViewed` is a local,
   * never-transmitted list this shop already keeps, and someone opening a
   * comparison has almost always just been reading a product page. One call
   * then yields both halves of the empty state — the anchor's own card (the
   * endpoint echoes it) and a dozen machines like it — so the first screen is
   * still one tap rather than a search box.
   */
  const [seedCards, setSeedCards] = useState<CompareProductCard[] | null>(null);
  const seedId = useMemo(() => (idsKey ? null : readRecentlyViewed()[0]?.id ?? null), [idsKey]);

  useEffect(() => {
    if (!seedId) {
      setSeedCards(null);
      return;
    }
    const controller = new AbortController();
    fetchCandidates(seedId, '', { signal: controller.signal, mascot: 'silent' })
      // `for` is nullable now (the anchor-free list answers null); a seeded
      // call always has one, but filtering is cheaper than a crash if it does
      // not.
      .then((res) => setSeedCards([res.for, ...res.products].filter(Boolean) as CompareProductCard[]))
      // A product that has since been unpublished is not an error worth
      // showing: the empty state simply falls back to the catalogue link.
      .catch(() => setSeedCards(null));
    return () => controller.abort();
  }, [seedId]);

  // ------------------------------------------------------------ the picker

  /** null = closed; a number = replacing that column; -1 = adding a column. */
  const [picking, setPicking] = useState<number | null>(null);

  const onPicked = useCallback(
    (card: CompareProductCard, optionId: string | null) => {
      const index = picking;
      setPicking(null);
      if (index === null) return;
      const key = optionId ? `${card.id}:${optionId}` : card.id;
      if (index < 0) {
        setIds([...ids, key]);
        return;
      }
      const next = [...ids];
      next[index] = key;
      setIds(next);
    },
    [ids, picking, setIds]
  );

  /** `productId` or `productId:optionId` — the id the URL and the server both
   *  speak. See readIds in worker/routes/compare.ts. */
  const slotKey = (productId: string, optionId: string | null): string =>
    optionId ? `${productId}:${optionId}` : productId;

  const removeId = useCallback((id: string) => setIds(ids.filter((v) => v !== id)), [ids, setIds]);

  const moveToStart = useCallback(
    (index: number) => setIds([ids[index], ...ids.filter((_, i) => i !== index)]),
    [ids, setIds]
  );

  const labels = useMemo(() => (comparison ? labelIndex(comparison) : new Map()), [comparison]);
  const price = comparison ? priceRow(comparison) : null;
  const blamed = blamedIds(error);
  /** A 400 is the server refusing this exact request; only transport and
   *  server-side failures can be answered by asking again. */
  const retryable = !(error instanceof ApiError && error.status === 400);
  const BackIcon = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    // 16px side gutters, and no bottom-nav padding: the shell already reserves
    // `.nav-clearance` after every route that renders the floating nav, and a
    // second reservation here would leave a dead band under the last section.
    <div className="mx-auto w-full max-w-4xl px-4 pb-6" aria-busy={loading}>
      <header className="flex items-center gap-2 py-3">
        <button
          type="button"
          onClick={goBack}
          aria-label={s.back}
          className="lv-button lv-button-ghost min-h-[44px] min-w-[44px] px-0"
        >
          <BackIcon aria-hidden="true" className="h-5 w-5" />
        </button>
        <h1 className="flex flex-1 items-center gap-2 text-base font-bold text-[var(--color-text-primary)]">
          <Scale aria-hidden="true" className="h-4 w-4 text-[var(--color-text-muted)]" />
          {s.pageTitle}
        </h1>
        {/*
          AVAILABLE WITH NOTHING PLACED TOO. The gate used to be
          `ids.length > 0`, so on the one screen where the visitor has
          nothing yet — «يظهر فقط الذي شاهدته مؤخرا» — there was no control
          at all, and the recently-viewed list was the only way in.
        */}
        {ids.length < MAX_COMPARE_IDS ? (
          <button
            type="button"
            onClick={() => setPicking(-1)}
            aria-label={s.addProduct}
            title={s.addProduct}
            className="lv-button lv-button-secondary min-h-[44px] min-w-[44px] px-0"
          >
            <Plus aria-hidden="true" className="h-5 w-5" />
          </button>
        ) : null}
      </header>

      {loading && products.length === 0 ? (
        <p aria-live="polite" className="py-10 text-center text-[13px] text-[var(--color-text-muted)]">
          {s.loading}
        </p>
      ) : null}

      {error ? (
        <div className="py-2">
          {/* A retry is offered only where one could work. `COMPARE_NO_SPECS`
              and `COMPARE_MERCHANT_PRODUCT` are 400s about a specific product:
              asking again returns the same refusal, and a button that always
              fails teaches people that buttons do not work. Those get the
              action that DOES resolve it — drop that column — instead. */}
          <ErrorState
            error={error}
            onRetry={retryable ? () => setAttempt((n) => n + 1) : undefined}
          />
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {blamed.length > 0 ? (
              <button
                type="button"
                onClick={() => setIds(ids.filter((id) => !blamed.includes(id)))}
                className="lv-button lv-button-primary lv-button-sm"
              >
                {s.dropThis}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setIds([])}
              className="lv-button lv-button-secondary lv-button-sm"
            >
              {s.startOver}
            </button>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------ nothing placed yet */}
      {!error && ids.length === 0 ? (
        <section className="lv-surface p-4">
          <h2 className="text-sm font-bold text-[var(--color-text-primary)]">{s.emptyTitle}</h2>
          <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">{s.emptyBody}</p>

          {/*
            THE BUTTON, ABOVE THE LIST RATHER THAN INSTEAD OF IT.

            «عند الضغط على المقارنة فإنه يظهر فقط الذي شاهدته مؤخرا أريد أن
             يكون زر لاضافه الطابعه.»

            The recently-viewed rail below is genuinely the fastest way in for
            somebody who has just come off a product page, and it stays. What
            was missing is a way in for everybody else — a first visit, cleared
            storage, or wanting a machine unlike the one they were reading —
            and for them the rail was not "few choices", it was NO choices.
            This opens the same picker the second slot uses, which now has a
            search box over the whole catalogue because `for` became optional
            on the endpoint behind it.
          */}
          <button
            type="button"
            onClick={() => setPicking(-1)}
            className="lv-button lv-button-primary lv-button-sm mt-3 w-full sm:w-auto"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {s.addProduct}
          </button>

          {seedCards && seedCards.length > 0 ? (
            <>
              <h3 className="mt-4 text-[12px] font-bold text-[var(--color-text-muted)]">
                {s.emptyRecent}
              </h3>
              <div className="mt-2">
                <CandidateGrid
                  cards={seedCards}
                  excluded={ids}
                  onPick={(card, optionId) => setIds([...ids, slotKey(card.id, optionId)])}
                  s={s}
                />
              </div>
            </>
          ) : (
            <div className="mt-4">
              <EmptyState
                icon={<Store aria-hidden="true" className="h-6 w-6" />}
                title={s.pickNone}
                description={s.pickNoneHint}
                compact
                action={
                  <Link to="/products" className="lv-button lv-button-primary lv-button-sm">
                    {s.browse}
                  </Link>
                }
              />
            </div>
          )}
        </section>
      ) : null}

      {/* -------------------------------------- one placed: open the second slot */}
      {!error && products.length === 1 ? (
        <section className="lv-surface p-4">
          <h2 className="text-sm font-bold text-[var(--color-text-primary)]">{s.onlyOneTitle}</h2>
          <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
            {s.onlyOneBody}
          </p>
          <h3 className="mt-4 text-[12px] font-bold text-[var(--color-text-muted)]">
            {s.pickLike(columnName(products[0], lang as CompareLang))}
          </h3>
          <div className="mt-2">
            <SecondSlot
              anchorId={products[0].product_id ?? products[0].id}
              exclude={ids}
              onPick={(card, optionId) => setIds([...ids, slotKey(card.id, optionId)])}
            />
          </div>
        </section>
      ) : null}

      {/* --------------------------------------------------- the comparison */}
      {!error && comparison && products.length >= 2 ? (
        <>
          <VerdictBand products={products} result={comparison} labels={labels} />
          <div className="lv-section">
            <BasisNote result={comparison} />
          </div>
          <SpecChart products={products} result={comparison} />
          {price ? <PriceRow products={products} row={price} /> : null}
          <SpecTable products={products} result={comparison} />
        </>
      ) : null}

      {/* THE MAINS ANSWER. Below the specs because it is a CONCLUSION drawn
          from them — the wattage rows are in the table above — and outside the
          `products.length >= 2` block on purpose: the question «كم تستهلك
          وشقد UPS أحتاج» is worth answering about a single machine, which is
          also the state a visitor arrives in from a product page. The block
          renders nothing of its own accord when no column has a wattage. */}
      {!error ? <PowerBlock products={products} power={power} /> : null}

      {!error && products.length >= 1 ? (
        <CompareSlots
          products={products}
          onRemove={(i) => removeId(ids[i])}
          onReplace={(i) => setPicking(i)}
          onMoveToStart={moveToStart}
          onAdd={() => setPicking(-1)}
        />
      ) : null}

      <ProductPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        anchorId={ids[0] ?? null}
        // When replacing a column, the column being replaced is not an
        // exclusion — choosing the same machine again is a no-op, not a bug.
        exclude={picking !== null && picking >= 0 ? ids.filter((_, i) => i !== picking) : ids}
        onPick={onPicked}
      />
    </div>
  );
}

/**
 * The second slot, inline rather than behind a sheet.
 *
 * With one machine placed, choosing the other IS the page's whole job, so the
 * list is on the screen rather than one tap behind a button. It is the same
 * ranked list the sheet shows — same endpoint, same component — with no search
 * box, because someone who has just arrived from a product page is being
 * offered the machines next to it on the shelf and does not need to type.
 */
function SecondSlot({
  anchorId,
  exclude,
  onPick,
}: {
  anchorId: string;
  exclude: string[];
  onPick: (card: CompareProductCard, optionId: string | null) => void;
}) {
  const { lang } = useLanguage();
  const s = compareStrings(lang);
  const [cards, setCards] = useState<CompareProductCard[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchCandidates(anchorId, '', { signal: controller.signal, mascot: 'silent' })
      .then((res) => {
        setCards(res.products);
        setError(null);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err);
      });
    return () => controller.abort();
  }, [anchorId]);

  if (error) return <ErrorState error={error} compact />;
  if (cards === null) {
    return (
      <p aria-live="polite" className="py-4 text-center text-[12px] text-[var(--color-text-muted)]">
        {s.pickSearching}
      </p>
    );
  }
  return <CandidateGrid cards={cards} excluded={exclude} onPick={onPick} s={s} />;
}
