/**
 * «التسعير والشحن» — THE OWNER'S PRICING WORKSPACE, P1: A PREVIEW
 * (MVP plan §6 P1; owner decision 2; answer B).
 *
 * What the owner sees:
 *   - a banner, first and always: preview only, nothing changes in the store;
 *   - every ordinary product with its status (worst first), the counts, a
 *     search and a status filter (PricingProducts);
 *   - one product: today's prices per model × channel with the old route fee
 *     and the old landed cost, the minimum profit and the direct-sale premium
 *     the old prices carry, conflicts, measures, typed member prices yes/no,
 *     the calculator and the rates it uses (ProductPricingSheet).
 *
 * WHO. Mounted by src/pages/Admin.tsx only on `can_write_cost === true` — a
 * courtesy; the router refuses everyone but the verified owner before a query
 * runs. If the server still refuses (the session changed under the screen),
 * the refusal is said BY CODE: OWNER_EMAIL_UNVERIFIED opens the verification
 * card, anything else says the contract's sentence.
 *
 * NAVIGATION. The list and a product are one stack: opening a product pushes
 * it, «كل المنتجات» pops back to the same search, filter and scroll position.
 * The open product is kept in the address (`?product=`) so a reload reopens it.
 *
 * NOTHING HERE WRITES. Two GETs and a POST that only answers a question.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { Skeleton } from '../ui/Skeleton';
import { fetchPricingProducts, OVERVIEW_PAGE_LIMIT, type PricingOverview, type PricingProductSummary } from './api';
import { PreviewBanner, PricingFailure } from './parts';
import PricingProducts, { type StatusFilter } from './PricingProducts';
import ProductPricingSheet from './ProductPricingSheet';
import { pricingStrings } from './strings';

const PRODUCT_PARAM = 'product';

function initialProduct(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get(PRODUCT_PARAM);
    return id && /^[\w.:-]{1,100}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function ListSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="flex gap-2">
        <Skeleton className="h-11 w-20" />
        <Skeleton className="h-11 w-48" />
        <Skeleton className="h-11 w-40" />
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="lv-surface divide-y divide-border-subtle/60">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-2 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminPricing() {
  const { lang, dir } = useLanguage();
  const s = useMemo(() => pricingStrings(lang), [lang]);
  const [list, setList] = useState<{ overview: PricingOverview; products: PricingProductSummary[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [productId, setProductId] = useState<string | null>(initialProduct);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const rootRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const lastOpened = useRef<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    fetchPricingProducts({ signal: ac.signal })
      .then((r) => {
        if (!ac.signal.aborted) setList(r);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      });
    return () => ac.abort();
  }, [reload]);

  // The open product lives in the address, beside the admin's own `tab`.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (productId) url.searchParams.set(PRODUCT_PARAM, productId);
      else url.searchParams.delete(PRODUCT_PARAM);
      window.history.replaceState(window.history.state, '', url);
    } catch {
      /* an address that cannot be rewritten changes nothing on screen */
    }
  }, [productId]);
  // Leaving the tab takes the product out of the address.
  useEffect(
    () => () => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete(PRODUCT_PARAM);
        window.history.replaceState(window.history.state, '', url);
      } catch {
        /* nothing to undo */
      }
    },
    []
  );

  const scroller = () => rootRef.current?.closest('main') ?? null;

  const open = useCallback((id: string) => {
    listScroll.current = scroller()?.scrollTop ?? 0;
    lastOpened.current = id;
    setProductId(id);
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'start' }));
  }, []);

  const back = useCallback(() => {
    setProductId(null);
    requestAnimationFrame(() => {
      const main = scroller();
      if (main) main.scrollTop = listScroll.current;
      const row = lastOpened.current ? rootRef.current?.querySelector<HTMLElement>(`[data-pricing-product="${CSS.escape(lastOpened.current)}"]`) : null;
      row?.focus({ preventScroll: true });
    });
  }, []);

  return (
    <div ref={rootRef} dir={dir} data-admin-pricing className="mx-auto w-full max-w-[1120px] min-w-0 space-y-4 pb-16">
      <header className="space-y-1">
        <h2 className="text-[22px] font-black leading-snug text-text-primary sm:text-[26px]">{s.title}</h2>
        <p className="max-w-[68ch] text-[14px] leading-relaxed text-text-muted">{s.subtitle}</p>
      </header>

      <PreviewBanner lang={lang} body={s.previewBody} />

      {productId ? (
        <ProductPricingSheet key={productId} id={productId} lang={lang} dir={dir} s={s} onBack={back} />
      ) : error ? (
        <PricingFailure error={error} lang={lang} onRetry={() => setReload((n) => n + 1)} fallback={s.loadFailed} />
      ) : !list ? (
        <>
          <p className="sr-only" role="status">{s.loading}</p>
          <ListSkeleton />
        </>
      ) : (
        <PricingProducts
          overview={list.overview}
          products={list.products}
          truncatedAt={list.truncated ? OVERVIEW_PAGE_LIMIT * list.overview.page_size : null}
          query={query}
          onQuery={setQuery}
          filter={filter}
          onFilter={setFilter}
          onOpen={open}
          lang={lang}
          dir={dir}
          s={s}
        />
      )}
    </div>
  );
}
