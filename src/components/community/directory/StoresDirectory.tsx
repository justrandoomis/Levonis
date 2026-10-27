/**
 * «المتاجر» — THE STORES DIRECTORY (community UI plan C5; IMG_8469), under the
 * section header of src/pages/community/Stores.tsx:
 *
 *   the search       scoped to stores, the term in `?q=` after a 300ms pause
 *   the chips        «المحافظة» (the governorate sheet), «FDM», «ريزن» and
 *                    «تصميم», all in the address (`?gov=&tech=&design=1`,
 *                    directory/filters.ts) and read by the server (plan B3),
 *                    so the first page `total` counts what they let through
 *   «متجرك»          the viewer own store, or the way to one, while nothing
 *                    is searched or filtered
 *   the cards        StoreDirectoryCard, a page at a time (useCommunityFeed,
 *                    its memory keyed by the filters), «عرض المزيد» after
 *
 * FDM and resin are one server filter (`tech`), so pressing one releases the
 * other; each chip says its own state (`aria-pressed`) and the result count
 * is announced. The states: a skeleton like the card, the error with retry,
 * an empty directory, a search with no answer (NoResults, its way back), and
 * filters with no answer («مسح الفلاتر»).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, PenTool, SearchX, Store } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import type { MerchantMe } from '../../../lib/merchant';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import LoadMore from '../../listing/LoadMore';
import FilterChip from '../FilterChip';
import { SearchField } from '../kit/fields';
import { NoResults, SearchLine } from '../hub/search';
import { hubLang, resultsCount, useHubStrings } from '../hub/strings';
import { useCommunityFeed } from '../hub/useCommunityFeed';
import { useStoreFollow } from '../hub/useStoreFollow';
import type { CommunityStore } from '../hub/api';
import FdmGlyph from './FdmGlyph';
import GovernorateFilter from './GovernorateFilter';
import StoreDirectoryCard from './StoreDirectoryCard';
import { StoreDirectorySkeleton } from './Skeletons';
import YourStore from './YourStore';
import { STORE_FILTER_KEYS, activeCount, readQuery, readStoreFilters, withParams } from './filters';
import { useDirectoryStrings } from './strings';

export default function StoresDirectory({ viewer, me }: { viewer: string; me: MerchantMe | null }) {
  const { lang } = useLanguage();
  const s = useHubStrings();
  const d = useDirectoryStrings();
  const [params, setParams] = useSearchParams();
  const q = readQuery(params);
  const filters = readStoreFilters(params);
  const filtered = activeCount(filters) > 0;
  const feed = useCommunityFeed<CommunityStore>('merchants', q, viewer, filters);
  const follow = useStoreFollow();

  // The field types freely; the address (and the list) follows after a pause.
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const set = useCallback((patch: Record<string, string | null>) => setParams((prev) => withParams(prev, patch), { replace: true }), [setParams]);
  const settle = useCallback(
    (value: string) => {
      const next = value.trim().slice(0, 60);
      if (next !== q) set({ q: next || null });
    },
    [q, set]
  );
  const clearSearch = () => set({ q: null });
  const clearFilters = () => set(Object.fromEntries(STORE_FILTER_KEYS.map((k) => [k, null])));

  let body: React.ReactNode;
  if (feed.error) body = <ErrorState error={feed.error} onRetry={feed.reload} />;
  else if (!feed.rows) body = <StoreDirectorySkeleton />;
  else if (feed.rows.length === 0) {
    if (filtered) {
      body = (
        <EmptyState
          icon={<SearchX aria-hidden="true" className="h-6 w-6" />}
          title={d.noStoresFiltered}
          action={
            <button type="button" onClick={clearFilters} data-directory-clear-filters className="lv-button lv-button-secondary lv-button-sm mt-1">
              {s.clearFilters}
            </button>
          }
        />
      );
    } else if (q) body = <NoResults q={q} onClear={clearSearch} />;
    else body = <EmptyState icon={<Store aria-hidden="true" className="h-6 w-6" />} title={s.noStores} />;
  } else {
    const remaining = feed.hasMore ? Math.max(1, (feed.total ?? 0) - feed.rows.length) : 0;
    body = (
      <>
        <SearchLine q={q} total={feed.total} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-directory-list="stores">
          {feed.rows.map((m) => (
            <StoreDirectoryCard key={m.id} store={follow.view(m)} follow={follow.followProps(m)} />
          ))}
        </div>
        <LoadMore remaining={remaining} state={feed.more} onMore={feed.loadMore} />
      </>
    );
  }

  return (
    <div data-community-panel="merchants" className="flex flex-col gap-3">
      <SearchField
        label={s.search.stores}
        placeholder={s.search.stores}
        value={text}
        onValueChange={setText}
        onSettled={settle}
        debounceMs={300}
        enterKeyHint="search"
        data-directory-search
      />
      <div role="group" aria-label={d.storeFilters} className="-mx-4 -my-1 flex snap-x items-center gap-1.5 overflow-x-auto px-4 hide-scrollbar" data-directory-filters>
        <GovernorateFilter value={filters.governorate} onChange={(id) => set({ gov: id || null })} />
        <FilterChip
          shape="rect"
          on={filters.tech === 'fdm'}
          aria-pressed={filters.tech === 'fdm'}
          icon={<FdmGlyph />}
          data-directory-filter="fdm"
          onClick={() => set({ tech: filters.tech === 'fdm' ? null : 'fdm' })}
        >
          {d.fdm}
        </FilterChip>
        <FilterChip
          shape="rect"
          on={filters.tech === 'resin'}
          aria-pressed={filters.tech === 'resin'}
          icon={<Box aria-hidden="true" className="h-[18px] w-[18px]" />}
          data-directory-filter="resin"
          onClick={() => set({ tech: filters.tech === 'resin' ? null : 'resin' })}
        >
          {d.resin}
        </FilterChip>
        <FilterChip
          shape="rect"
          on={filters.service === 'design'}
          aria-pressed={filters.service === 'design'}
          icon={<PenTool aria-hidden="true" className="h-[18px] w-[18px]" />}
          data-directory-filter="design"
          onClick={() => set({ design: filters.service === 'design' ? null : '1' })}
        >
          {d.design}
        </FilterChip>
      </div>
      {!q && !filtered && <YourStore me={me} className="" />}
      {/* What the filters let through, said once the list has answered (a search says it in SearchLine). */}
      <p role="status" className="sr-only" data-directory-status>
        {filtered && !q && feed.rows ? (feed.rows.length ? resultsCount(feed.total ?? feed.rows.length, hubLang(lang)) : d.noStoresFiltered) : ''}
      </p>
      {body}
    </div>
  );
}
