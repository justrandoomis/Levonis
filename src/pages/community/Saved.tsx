/**
 * «المحفوظات» — /community/saved. The projects the viewer bookmarked, newest
 * saved first, in the same cards as everywhere else. A private list: the
 * route sits behind ProtectedRoute and the server answers only the account's
 * own saves.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Bookmark } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { useGoBack } from '../../lib/useGoBack';
import { EmptyState, ErrorState } from '../../components/ui/AsyncStates';
import LoadMore from '../../components/listing/LoadMore';
import ProjectCard, { ProjectCardSkeleton } from '../../components/community/projects/ProjectCard';
import type { PostCard } from '../../components/community/projects/api';
import { socialApi } from '../../components/community/social/api';
import { useSocialStrings } from '../../components/community/social/strings';

export default function SavedPage() {
  const goBack = useGoBack('/community');
  const { loc, dir } = useLanguage();
  const { user } = useAuth();
  const s = useSocialStrings();
  const [rows, setRows] = useState<PostCard[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    setRows(null);
    socialApi
      .saved()
      .then((p) => {
        if (!alive) return;
        setRows(p.posts);
        setNext(p.next);
      })
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [nonce, user?.id]);

  const loadMore = () => {
    if (!next || more === 'loading') return;
    setMore('loading');
    socialApi
      .saved(next)
      .then((p) => {
        setRows((r) => [...(r ?? []), ...p.posts]);
        setNext(p.next);
        setMore('idle');
      })
      .catch(() => setMore('error'));
  };

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  return (
    <div className="min-h-screen bg-canvas pb-28 text-text-primary">
      <div className="material scroll-edge sticky top-0 z-40 h-14 px-4">
        <div className="mx-auto flex h-full max-w-6xl items-center gap-2">
          <button
            type="button"
            aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
            onClick={goBack}
            className="press-scale -ms-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Back className="h-5 w-5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-bold">{s.savedTitle}</h1>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 pt-4" data-saved-grid>
        {error ? (
          <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} className="mt-10" />
        ) : !rows ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 6 }, (_, i) => (
              <ProjectCardSkeleton key={i} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Bookmark aria-hidden="true" className="h-6 w-6" />}
            title={s.savedEmpty}
            description={s.savedEmptyHint}
            className="mt-10"
            action={
              <Link to="/community/projects" className="lv-button lv-button-secondary mt-1">
                {s.browseProjects}
              </Link>
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {rows.map((p, i) => (
                <ProjectCard key={p.id} post={p} eager={i < 4} />
              ))}
            </div>
            <LoadMore remaining={next ? null : 0} state={more} onMore={loadMore} />
          </>
        )}
      </div>
    </div>
  );
}
