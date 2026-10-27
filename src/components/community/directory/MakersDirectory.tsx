/**
 * «الصنّاع» — THE MAKERS DIRECTORY (community UI plan C5; IMG_8476), under the
 * section header of src/pages/community/Makers.tsx:
 *
 *   the search row   «ابحث عن صانع» (the term in `?q=` after a 300ms pause)
 *                    and the filter button, which opens MakersFilterSheet;
 *                    its name counts the filters that are on, and a dot
 *                    shows them
 *   the head         «صنّاع مميزون» in the featured order (no search, no
 *                    order chosen), the chosen order name otherwise, or the
 *                    result count of a search (SearchLine)
 *   the cards        MakerDirectoryCard, a page at a time, «عرض المزيد»
 *
 * Everything chosen lives in the address (`?sort=&has_store=1&approved=1`,
 * directory/filters.ts). Blocked accounts are left out by the server both
 * ways, and one the viewer blocks a moment ago leaves the list at once.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SearchX, SlidersHorizontal, Users } from 'lucide-react';
import type { CreatorSort } from '../../../../packages/contracts/src/communityFilters';
import { useLanguage } from '../../../LanguageContext';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import LoadMore from '../../listing/LoadMore';
import { KitIconButton } from '../kit/buttons';
import { SearchField } from '../kit/fields';
import type { CreatorCard } from '../social/api';
import { useSocial } from '../social/SocialContext';
import { NoResults, SearchLine } from '../hub/search';
import { hubLang, resultsCount, useHubStrings } from '../hub/strings';
import { useCommunityFeed } from '../hub/useCommunityFeed';
import MakerDirectoryCard from './MakerDirectoryCard';
import { MakerDirectorySkeleton } from './Skeletons';
import MakersFilterSheet from './MakersFilterSheet';
import { MAKER_FILTER_KEYS, activeCount, effectiveSort, readMakerFilters, readQuery, withParams } from './filters';
import { useDirectoryStrings } from './strings';

export default function MakersDirectory({ viewer }: { viewer: string }) {
  const { lang } = useLanguage();
  const s = useHubStrings();
  const d = useDirectoryStrings();
  const social = useSocial();
  const [params, setParams] = useSearchParams();
  const q = readQuery(params);
  const filters = readMakerFilters(params);
  const on = activeCount(filters);
  const feed = useCommunityFeed<CreatorCard>('creators', q, viewer, filters);
  const [sheet, setSheet] = useState(false);

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
  const sort = effectiveSort(q, filters.sort);
  const chooseSort = (next: CreatorSort) => set({ sort: next === effectiveSort(q, '') ? null : next });
  const toggle = (key: 'has_store' | 'approved') => set({ [key]: filters[key] ? null : '1' });
  const clearFilters = () => set(Object.fromEntries(MAKER_FILTER_KEYS.map((k) => [k, null])));

  const sortLabel = { recent: d.sortRecent, featured: d.sortFeatured, followers: d.sortFollowers }[sort];
  const head = q ? null : !filters.sort ? s.featuredCreators : sortLabel;

  // A maker the viewer blocked a moment ago leaves the list at once.
  const rows = feed.rows ? feed.rows.filter((c) => !social.blocked.has(c.id)) : null;
  let body: React.ReactNode;
  if (feed.error) body = <ErrorState error={feed.error} onRetry={feed.reload} />;
  else if (!rows) body = <MakerDirectorySkeleton />;
  else if (rows.length === 0) {
    if (filters.has_store || filters.approved) {
      body = (
        <EmptyState
          icon={<SearchX aria-hidden="true" className="h-6 w-6" />}
          title={d.noMakersFiltered}
          action={
            <button type="button" onClick={clearFilters} data-directory-clear-filters className="lv-button lv-button-secondary lv-button-sm mt-1">
              {s.clearFilters}
            </button>
          }
        />
      );
    } else if (q) body = <NoResults q={q} onClear={() => set({ q: null })} />;
    else body = <EmptyState icon={<Users aria-hidden="true" className="h-6 w-6" />} title={s.noCreators} />;
  } else {
    const remaining = feed.hasMore ? Math.max(1, (feed.total ?? 0) - (feed.rows?.length ?? 0)) : 0;
    body = (
      <>
        <SearchLine q={q} total={feed.total} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-directory-list="makers">
          {rows.map((c) => (
            <MakerDirectoryCard key={c.id} creator={c} />
          ))}
        </div>
        <LoadMore remaining={remaining} state={feed.more} onMore={feed.loadMore} />
      </>
    );
  }

  return (
    <div data-community-panel="creators" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SearchField
          label={s.search.creators}
          placeholder={s.search.creators}
          value={text}
          onValueChange={setText}
          onSettled={settle}
          debounceMs={300}
          enterKeyHint="search"
          className="min-w-0 flex-1"
          data-directory-search
        />
        <KitIconButton
          shape="square"
          label={on > 0 ? d.filtersOn(on) : d.filter}
          icon={<SlidersHorizontal className="h-[22px] w-[22px]" strokeWidth={1.75} />}
          badge={on > 0 ? 'dot' : null}
          aria-haspopup="dialog"
          aria-expanded={sheet}
          data-makers-filter-button={on}
          onClick={() => setSheet(true)}
        />
      </div>
      {head && (
        <h2 className="mt-1 text-[18px] font-bold text-text-primary" data-directory-head={filters.sort || 'featured'}>
          {head}
        </h2>
      )}
      {/* What the filters let through, said once the list has answered (a search says it in SearchLine). */}
      <p role="status" className="sr-only" data-directory-status>
        {on > 0 && !q && rows ? (rows.length ? resultsCount(feed.total ?? rows.length, hubLang(lang)) : d.noMakersFiltered) : ''}
      </p>
      {body}
      <MakersFilterSheet open={sheet} onClose={() => setSheet(false)} filters={filters} sort={sort} onSort={chooseSort} onToggle={toggle} />
    </div>
  );
}
