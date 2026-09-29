/**
 * «مشاريعي» on the account page — every project of the signed-in person,
 * drafts and archived ones included, newest first, each a row to its page.
 * The list is the author's own view (GET /api/community/my-posts), so it says
 * what the public card never does: the state, a pending consent, a hide.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, EyeOff, Plus } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { EmptyState, ErrorState } from '../ui/AsyncStates';
import SafeImage from '../ui/SafeImage';
import LoadMore from '../listing/LoadMore';
import { projectsApi, type MyPost } from '../community/projects/api';
import { useProjectStrings } from '../community/projects/strings';
import { timeAgo } from '../community/hub/copy';

export default function MyProjectsTab() {
  const { lang, dir } = useLanguage();
  const s = useProjectStrings();
  const hubLang = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
  const [rows, setRows] = useState<MyPost[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  useEffect(() => {
    let alive = true;
    setError(null);
    projectsApi
      .mine()
      .then((p) => {
        if (!alive) return;
        setRows(p.posts);
        setNext(p.next);
      })
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [nonce]);

  const loadMore = () => {
    if (!next || more === 'loading') return;
    setMore('loading');
    projectsApi
      .mine(next)
      .then((p) => {
        setRows((r) => [...(r ?? []), ...p.posts]);
        setNext(p.next);
        setMore('idle');
      })
      .catch(() => setMore('error'));
  };

  const newButton = (
    <Link to="/community/projects/new" data-my-projects-new className="lv-button lv-button-primary lv-button-sm gap-1.5">
      <Plus aria-hidden="true" className="h-4 w-4" />
      {s.newProject}
    </Link>
  );

  if (error) return <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} compact />;
  if (!rows) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[76px] animate-pulse rounded-2xl bg-surface-selected motion-reduce:animate-none" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return <EmptyState title={s.noProjectsYet} description={s.myProjectsEmpty} action={newButton} compact />;
  }
  return (
    <div data-my-projects>
      <div className="mb-3 flex justify-end">{newButton}</div>
      <ul className="flex flex-col gap-2">
        {rows.map((p) => (
          <li key={p.id}>
            <Link
              to={p.url}
              className="flex items-center gap-3 rounded-2xl border border-border-subtle/60 bg-surface p-2 pe-3 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <SafeImage src={p.cover?.url ?? null} alt="" aspect="square" className="size-14 shrink-0 overflow-hidden rounded-xl" bgClassName="bg-surface-selected" />
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-start text-[14px] font-semibold text-text-primary">
                  {p.title}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-text-muted">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      p.state === 'published' ? 'bg-success/15 text-success' : p.state === 'archived' ? 'bg-surface-selected text-text-muted' : 'bg-gold/10 text-gold'
                    }`}
                  >
                    {s.states[p.state]}
                  </span>
                  {p.consent_status === 'pending' && <span>{s.consentPending}</span>}
                  {p.hidden && (
                    <span className="inline-flex items-center gap-1 text-danger">
                      <EyeOff aria-hidden="true" className="h-3 w-3" />
                      {s.hiddenBanner}
                    </span>
                  )}
                  <span>{timeAgo(p.published_at ?? p.created_at, hubLang)}</span>
                </span>
              </span>
              <Chevron aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            </Link>
          </li>
        ))}
      </ul>
      <LoadMore remaining={next ? 1 : 0} state={more} onMore={loadMore} />
    </div>
  );
}
