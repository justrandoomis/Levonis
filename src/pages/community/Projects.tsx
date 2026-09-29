/**
 * ALL THE PROJECTS — /community/projects. The published, public pieces of
 * the whole community, newest first, narrowed on the server by kind, tag and
 * a search term. The filters live in the URL (`?kind=`, `?tag=`, `?q=`) so
 * Back, a reload and a shared link land on the same list.
 *
 * The community home's «المشاريع» tab mounts the same grid (Phase 2); this
 * page is the address a tag or a «الكل» link resolves to.
 */
import React, { Suspense, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Plus, Search, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { useGoBack } from '../../lib/useGoBack';
import { EmptyState, ErrorState } from '../../components/ui/AsyncStates';
import LoadMore from '../../components/listing/LoadMore';
import ProjectCard, { ProjectCardSkeleton } from '../../components/community/projects/ProjectCard';
import { POST_KINDS, projectsApi, type PostCard, type PostFilters, type PostKind } from '../../components/community/projects/api';
import { useProjectStrings } from '../../components/community/projects/strings';
import { useSearchBox } from '../../components/community/search/useSearchBox';

/** The community's cross-entity search under the bar (Phase 3) — fetched the first time the box is focused. */
const SearchOverlay = React.lazy(() => import('../../components/community/search/SearchOverlay'));

export default function ProjectsPage() {
  const goBack = useGoBack('/community');
  const { loc, dir } = useLanguage();
  const { isAuthenticated } = useAuth();
  const s = useProjectStrings();
  const [params, setParams] = useSearchParams();
  const kindRaw = params.get('kind') ?? '';
  const kind = (POST_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as PostKind) : '';
  const tag = (params.get('tag') ?? '').trim().slice(0, 30);
  const q = (params.get('q') ?? '').trim().slice(0, 60);
  const [draft, setDraft] = useState(q);
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

  const setParam = (k: string, v: string) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (v) p.set(k, v);
        else p.delete(k);
        return p;
      },
      { replace: k === 'q' }
    );

  const submitSearch = (term: string) => {
    const next = term.trim().slice(0, 60);
    setDraft(next);
    setParam('q', next);
    box.close();
  };

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const newLink = isAuthenticated ? { to: '/community/projects/new' } : { to: '/auth', state: { from: '/community/projects/new' } };

  return (
    <div className="min-h-screen bg-canvas pb-28 text-text-primary">
      <div className="material scroll-edge sticky top-0 z-40 h-16 px-4">
        <div className="mx-auto flex h-full max-w-6xl items-center gap-3">
          <button
            type="button"
            aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
            onClick={goBack}
            className="press-scale -ms-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Back className="h-5 w-5" />
          </button>
          <form
            ref={box.barRef}
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              submitSearch(draft);
            }}
            className="relative min-w-0 flex-1 lg:max-w-2xl"
          >
            <label htmlFor="projects-search" className="sr-only">
              {loc('ابحث في المشاريع', 'Search projects', 'لە پڕۆژەکان بگەڕێ')}
            </label>
            <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              id="projects-search"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              dir="auto"
              value={draft}
              maxLength={60}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={loc('ابحث في المشاريع', 'Search projects', 'لە پڕۆژەکان بگەڕێ')}
              data-projects-search
              className="lv-input w-full rounded-full ps-10 pe-10 [&::-webkit-search-cancel-button]:appearance-none"
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
          <Link to={newLink.to} state={newLink.state} className="lv-button lv-button-primary lv-button-sm hidden gap-1.5 sm:inline-flex">
            <Plus aria-hidden="true" className="h-4 w-4" />
            {s.newProject}
          </Link>
        </div>
      </div>

      {box.ever && (
        <Suspense fallback={null}>
          <SearchOverlay open={box.open} value={draft} onChange={setDraft} onSubmit={submitSearch} onClose={box.close} inputRef={box.inputRef} barRef={box.barRef} scopeLabel={s.projects} />
        </Suspense>
      )}

      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 pt-4">
        <header className="flex items-end justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-[11px] font-semibold text-gold">
              <span aria-hidden="true" className="h-px w-4 bg-gold" />
              {loc('مجتمع ليفو', 'Levo Community', 'کۆمەڵگەی لیڤۆ')}
            </p>
            <h1 className="mt-1 text-[24px] font-black leading-tight">{s.projects}</h1>
          </div>
          <Link to={newLink.to} state={newLink.state} className="lv-button lv-button-primary lv-button-sm gap-1.5 sm:hidden">
            <Plus aria-hidden="true" className="h-4 w-4" />
            {s.newProject}
          </Link>
        </header>

        {/* kind chips; the chosen tag shows as a removable chip */}
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 hide-scrollbar" role="group" aria-label={s.kind}>
          <button type="button" className="lv-choice shrink-0" aria-pressed={kind === ''} onClick={() => setParam('kind', '')}>
            {s.seeAll}
          </button>
          {POST_KINDS.map((k) => (
            <button key={k} type="button" className="lv-choice shrink-0" aria-pressed={kind === k} onClick={() => setParam('kind', kind === k ? '' : k)}>
              {s.kinds[k]}
            </button>
          ))}
          {tag && (
            <button type="button" className="lv-choice shrink-0 gap-1" aria-pressed onClick={() => setParam('tag', '')} aria-label={`${s.tags}: ${tag}`}>
              #{tag}
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <ProjectsGrid filters={{ kind, tag, q }} />
      </div>
    </div>
  );
}

/** The grid itself — reused by the community home's «المشاريع» tab. */
export function ProjectsGrid({ filters }: { filters: PostFilters }) {
  const s = useProjectStrings();
  const { loc } = useLanguage();
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

  if (error) return <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (!rows) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 8 }, (_, i) => (
          <ProjectCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    const filtered = !!(filters.q || filters.tag || filters.kind);
    return (
      <EmptyState
        title={filtered ? loc('لا مشاريع تطابق هذا البحث بعد', 'No projects match this yet', 'هێشتا هیچ پڕۆژەیەک لەگەڵ ئەمە ناگونجێت') : s.noProjectsYet}
        description={filtered ? undefined : s.noProjectsHint}
      />
    );
  }
  return (
    <div data-projects-grid>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {rows.map((p, i) => (
          <ProjectCard key={p.id} post={p} eager={i < 4} />
        ))}
      </div>
      <LoadMore remaining={state.next ? Math.max(1, (state.total ?? 0) - rows.length) : 0} state={more} onMore={loadMore} />
    </div>
  );
}
