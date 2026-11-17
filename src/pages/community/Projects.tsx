/**
 * ALL THE PROJECTS — /community/projects (community UI plan C2.1; IMG_8485).
 * The published, public pieces of the whole community, narrowed on the
 * server. Every filter lives in the URL (`?q=`, `?kind=`, `?tag=`, `?sort=`,
 * `?material=`, `?printer=`, `?has_files=`) so Back, a reload and a shared
 * link land on the same list.
 *
 *   the section header «المشاريع» with «المحفوظات» (a guest signs in first)
 *   the search box «ابحث عن مشروع» (focus opens the cross-entity overlay,
 *     Enter writes `?q=` here) and «تصفية», which opens the lazy FilterSheet
 *     and wears a dot with the number of filters on
 *   the kind chips with their glyphs, scrolling sideways
 *   «وسوم ⌄», which opens the lazy TagSheet; a chosen tag shows «#tag ×»
 *   the grid of ProjectGridCard, two columns on a phone, and «عرض المزيد»
 *
 * Create stays reachable through the ComposerDock pill.
 */
import React, { Suspense, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bookmark, ChevronDown, SlidersHorizontal, Tag, X } from 'lucide-react';
import FilterChip from '../../components/community/FilterChip';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { EmptyState, ErrorState } from '../../components/ui/AsyncStates';
import LoadMore from '../../components/listing/LoadMore';
import ProjectGridCard, { ProjectGridCardSkeleton, type GridCardPatch } from '../../components/community/projects/ProjectGridCard';
import { POST_KINDS, projectsApi, type PostCard, type PostFilters, type PostKind } from '../../components/community/projects/api';
import { KindIcon } from '../../components/community/projects/kindIcons';
import { useProjectStrings } from '../../components/community/projects/strings';
import { activeFilterCount, type ProjectFilterValue } from '../../components/community/projects/filters';
import { useSearchBox } from '../../components/community/search/useSearchBox';
import CommunitySurface from '../../components/community/CommunitySurface';
import SectionPageHeader from '../../components/community/kit/SectionPageHeader';
import ComposerDock from '../../components/community/feed/ComposerDock';
import { POST_MATERIAL_IDS, POST_PRINTER_IDS, POST_SORTS } from '../../../packages/contracts/src/communityFilters';

/** The community's cross-entity search under the bar (Phase 3) — fetched the first time the box is focused. */
const SearchOverlay = React.lazy(() => import('../../components/community/search/SearchOverlay'));
/** The two sheets: fetched the first time their door is pressed. */
const FilterSheet = React.lazy(() => import('../../components/community/projects/FilterSheet'));
const TagSheet = React.lazy(() => import('../../components/community/projects/TagSheet'));

const NEW_PROJECT = '/community/projects/new';
const SAVED = '/community/saved';

/** A value from the address, or empty when it is not one the server knows. */
const oneOf = <T extends string>(list: readonly T[], raw: string | null): T | '' => ((list as readonly string[]).includes(raw ?? '') ? (raw as T) : '');

export default function ProjectsPage() {
  const { loc } = useLanguage();
  const { isAuthenticated } = useAuth();
  const s = useProjectStrings();
  const [params, setParams] = useSearchParams();
  const kind = oneOf<PostKind>(POST_KINDS, params.get('kind'));
  const tag = (params.get('tag') ?? '').trim().slice(0, 30);
  const q = (params.get('q') ?? '').trim().slice(0, 60);
  const sheet: ProjectFilterValue = {
    sort: oneOf(POST_SORTS, params.get('sort')),
    material: oneOf(POST_MATERIAL_IDS, params.get('material')),
    printer: oneOf(POST_PRINTER_IDS, params.get('printer')),
    has_files: params.get('has_files') === '1' ? '1' : '',
  };
  const filtersOn = activeFilterCount(sheet);
  const [draft, setDraft] = useState(q);
  const [filterOpen, setFilterOpen] = useState<boolean | null>(null);
  const [tagOpen, setTagOpen] = useState<boolean | null>(null);
  // The overlay is the cross-entity view; Enter writes the term here, on this
  // list. While it is open the URL debounce waits (src/pages/Community.tsx
  // says why) and resumes when it steps aside.
  const box = useSearchBox(params, setParams);

  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (box.open) return;
    const next = draft.trim().slice(0, 60);
    if (next === q) return;
    const t = window.setTimeout(() => setParam('q', next), 300);
    return () => window.clearTimeout(t);
  }, [draft, box.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMany = (change: Record<string, string>, replace = false) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(change)) {
          if (v) p.set(k, v);
          else p.delete(k);
        }
        return p;
      },
      { replace }
    );
  const setParam = (k: string, v: string) => setMany({ [k]: v }, k === 'q');

  const submitSearch = (term: string) => {
    const next = term.trim().slice(0, 60);
    setDraft(next);
    setParam('q', next);
    box.close();
  };

  const savedLink = isAuthenticated ? { to: SAVED } : { to: '/auth', state: { from: SAVED } };
  const newLink = isAuthenticated ? { to: NEW_PROJECT } : { to: '/auth', state: { from: NEW_PROJECT } };

  return (
    <CommunitySurface className="min-h-screen pb-28 text-text-primary">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4">
        <SectionPageHeader
          title={s.projects}
          trailing={
            <Link
              to={savedLink.to}
              state={savedLink.state}
              data-projects-saved
              className="relative inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-[15px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {s.savedLink}
              <Bookmark aria-hidden="true" className="h-6 w-6 text-text-primary" strokeWidth={1.75} />
            </Link>
          }
        />

        <div className="flex items-center gap-2">
          <form
            ref={box.barRef}
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              submitSearch(draft);
            }}
            className="relative min-w-0 flex-1"
          >
            <label htmlFor="projects-search" className="sr-only">
              {s.searchProjects}
            </label>
            <input
              id="projects-search"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              dir="auto"
              className="lv-input cm-field min-h-12 w-full ps-4 pe-10"
              value={draft}
              maxLength={60}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={s.searchProjects}
              data-projects-search
              {...box.inputProps}
            />
            {draft && (
              <button
                type="button"
                onClick={() => {
                  setDraft('');
                  setParam('q', '');
                }}
                aria-label={loc('مسح البحث', 'Clear search', 'گەڕان بسڕەوە')}
                className="absolute end-1.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </form>
          <button
            type="button"
            onClick={() => setFilterOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={!!filterOpen}
            data-projects-filter
            className="cm-raised relative inline-flex min-h-12 shrink-0 items-center gap-2 rounded-md px-3.5 text-[15px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <SlidersHorizontal aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
            {s.filter}
            {filtersOn > 0 && (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-gold px-1 text-[11px] font-bold tabular-nums text-onyx" data-projects-filter-count>
                {filtersOn}
                <span className="sr-only">{` (${s.filtersOn(filtersOn)})`}</span>
              </span>
            )}
          </button>
        </div>

        {/* The kinds: one at a time, each with its glyph after the word. */}
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 hide-scrollbar" role="group" aria-label={s.kind}>
          <FilterChip shape="rect" on={kind === ''} aria-pressed={kind === ''} onClick={() => setParam('kind', '')}>
            {s.seeAll}
          </FilterChip>
          {POST_KINDS.map((k) => (
            <FilterChip key={k} shape="rect" on={kind === k} aria-pressed={kind === k} trailing={<KindIcon kind={k} />} onClick={() => setParam('kind', kind === k ? '' : k)}>
              {s.kinds[k]}
            </FilterChip>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <FilterChip
            shape="rect"
            on={false}
            onClick={() => setTagOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={!!tagOpen}
            icon={<Tag aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />}
            trailing={<ChevronDown aria-hidden="true" className="h-4 w-4" />}
            data-projects-tags-door
          >
            {s.tags}
          </FilterChip>
          {tag && (
            <FilterChip shape="rect" on check={false} aria-label={s.removeTag(tag)} onClick={() => setParam('tag', '')} trailing={<X aria-hidden="true" className="h-4 w-4" />} data-projects-tag-chosen>
              <bdi>#{tag}</bdi>
            </FilterChip>
          )}
        </div>

        <ProjectsGrid filters={{ kind, tag, q, ...sheet }} />
        <ComposerDock to={newLink.to} state={newLink.state} />
      </div>

      {box.ever && (
        <Suspense fallback={null}>
          <SearchOverlay open={box.open} value={draft} onChange={setDraft} onSubmit={submitSearch} onClose={box.close} inputRef={box.inputRef} barRef={box.barRef} scopeLabel={s.projects} />
        </Suspense>
      )}
      {filterOpen !== null && (
        <Suspense fallback={null}>
          <FilterSheet open={filterOpen} value={sheet} onClose={() => setFilterOpen(false)} onApply={(v) => setMany({ ...v })} />
        </Suspense>
      )}
      {tagOpen !== null && (
        <Suspense fallback={null}>
          <TagSheet open={tagOpen} current={tag} onClose={() => setTagOpen(false)} onPick={(t) => setParam('tag', t)} />
        </Suspense>
      )}
    </CommunitySurface>
  );
}

/** The grid itself — also mounted by the community home's «المشاريع» tab. */
export function ProjectsGrid({ filters }: { filters: PostFilters }) {
  const s = useProjectStrings();
  const key = JSON.stringify(filters);
  const [state, setState] = useState<{ key: string; rows: PostCard[] | null; next: string | null; total: number | null }>({ key, rows: null, next: null, total: null });
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    setState({ key, rows: null, next: null, total: null });
    projectsApi
      .list(filters)
      .then((p) => alive && setState({ key, rows: p.posts, next: p.next, total: p.total }))
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [key, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = state.key === key ? state.rows : null;
  const loadMore = () => {
    if (!state.next || more === 'loading') return;
    setMore('loading');
    const k = key;
    projectsApi
      .list(filters, state.next)
      .then((p) => {
        setState((st) => (st.key !== k ? st : { ...st, rows: [...(st.rows ?? []), ...p.posts], next: p.next }));
        setMore('idle');
      })
      .catch(() => setMore('error'));
  };
  // A like or a save made on a card stays on the row, so a re-render (the
  // next page arriving) never turns the heart back off.
  const onPatch = (id: string, change: GridCardPatch) =>
    setState((st) => ({
      ...st,
      rows: st.rows?.map((r) => (r.id === id ? { ...r, counts: { ...r.counts, ...change.counts }, viewer: { ...(r.viewer ?? {}), ...change.viewer } } : r)) ?? null,
    }));

  const grid = 'grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4';
  if (error) return <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (!rows) {
    return (
      <div className={grid}>
        {Array.from({ length: 6 }, (_, i) => (
          <ProjectGridCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    const filtered = Object.values(filters).some(Boolean);
    return <EmptyState title={filtered ? s.noMatch : s.noProjectsYet} description={filtered ? undefined : s.noProjectsHint} />;
  }
  return (
    <div data-projects-grid>
      <div className={grid}>
        {rows.map((p, i) => (
          <ProjectGridCard key={p.id} post={p} eager={i < 4} onPatch={onPatch} />
        ))}
      </div>
      <LoadMore remaining={state.next ? Math.max(1, (state.total ?? 0) - rows.length) : 0} state={more} onMore={loadMore} />
    </div>
  );
}
