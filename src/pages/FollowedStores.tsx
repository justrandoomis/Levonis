/**
 * «متاجر أتابعها» — THE SHOPS THIS CUSTOMER FOLLOWS, drawn with the directory's
 * own card (components/community/hub/StoreCard): the store's name, logo and
 * tagline, its rating, finished orders, products and place, and one link over
 * the whole card. The page used to show the community profile's name and bio
 * — not the shop's — on a card that was a clickable <div> holding a button,
 * and a failed unfollow said nothing (review of Levo Community, 2026-09-28).
 *
 * «تتابعه» toggles IN PLACE: the card stays, so an accidental tap is undone by
 * the next one, and the list is read again on the next visit. A failure puts
 * the button back and says so. The community page's cached store list is
 * dropped after a change, so its «تتابعه» agrees with this one.
 *
 * A shop Levonis has sanctioned stays as a neutral card with only the way to
 * stop following it (review S5; the server sends nothing the merchant wrote).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Heart, Store } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import { useGoBack } from '../lib/useGoBack';
import { useSignInPrompt } from '../lib/guest';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';
import { toast } from '../components/ui/Toast';
import StoreCard from '../components/community/hub/StoreCard';
import { StoreListSkeleton } from '../components/community/hub/parts';
import { communityHubApi, type CommunityStore } from '../components/community/hub/api';
import { forgetCommunityFeed } from '../components/community/hub/feedCache';
import { storesLabel } from '../components/community/hub/copy';

type FollowedStore = CommunityStore & { unavailable?: boolean };

export default function FollowedStores() {
  const { dir, lang, loc } = useLanguage();
  const goBack = useGoBack('/community');
  const { signIn } = useSignInPrompt();
  const [stores, setStores] = useState<FollowedStore[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .get<{ merchants: FollowedStore[] }>('/api/community/followed')
      .then((d) => alive && setStores(d.merchants ?? []))
      // A signed-out answer is ErrorState's own sign-in prompt, as everywhere else.
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setStores(null);
    setAttempt((n) => n + 1);
  }, []);

  const toggle = async (m: FollowedStore) => {
    if (busyId) return;
    const was = m.following !== false;
    const set = (following: boolean, followers: number) =>
      setStores((rows) => rows?.map((r) => (r.id === m.id ? { ...r, following, followers } : r)) ?? rows);
    setBusyId(m.id);
    set(!was, Math.max(0, (m.followers ?? 0) + (was ? -1 : 1)));
    try {
      await (was ? communityHubApi.unfollow(m.id) : communityHubApi.follow(m.id));
      forgetCommunityFeed('merchants');
    } catch (e) {
      set(was, m.followers ?? 0);
      if (e instanceof ApiError && e.status === 401) signIn();
      // OWNER: Sorani to be written by hand.
      else toast.error(loc('تعذّر تحديث المتابعة. حاول مرة أخرى.', 'Could not update the follow. Try again.'));
    } finally {
      setBusyId(null);
    }
  };

  /** A sanctioned shop: gone from the list once unfollowed — there is nothing of it to go back to. */
  const unfollowUnavailable = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await communityHubApi.unfollow(id);
      setStores((rows) => rows?.filter((r) => r.id !== id) ?? rows);
      forgetCommunityFeed('merchants');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) signIn();
      // OWNER: Sorani to be written by hand.
      else toast.error(loc('تعذّر تحديث المتابعة. حاول مرة أخرى.', 'Could not update the follow. Try again.'));
    } finally {
      setBusyId(null);
    }
  };

  const followingNow = stores?.filter((s) => !s.unavailable && s.following !== false).length ?? 0;

  let body: React.ReactNode;
  if (error) body = <ErrorState error={error} onRetry={retry} />;
  else if (stores === null) body = <StoreListSkeleton count={4} />;
  else if (stores.length === 0) {
    body = (
      // OWNER: Sorani to be written by hand.
      <EmptyState
        icon={<Heart aria-hidden="true" className="h-6 w-6" />}
        title={loc('لا تتابع أي متجر بعد', 'You don’t follow any store yet')}
        description={loc(
          'تابع متجرًا من مجتمع ليفو ليظهر هنا، وتصل إليه بلمسة.',
          'Follow a store in Levo Community and it shows here, one tap away.'
        )}
        action={
          <Link
            to="/community?tab=merchants"
            data-followed-browse
            className="inline-flex min-h-11 items-center justify-center rounded-2xl bg-olive px-5 text-[13px] font-semibold text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {loc('تصفّح المتاجر', 'Browse stores')}
          </Link>
        }
      />
    );
  } else {
    body = (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-followed-list>
        {stores.map((m) =>
          m.unavailable ? (
            <UnavailableCard key={m.id} busy={busyId === m.id} onUnfollow={() => unfollowUnavailable(m.id)} />
          ) : (
            <StoreCard key={m.id} store={{ ...m, following: m.following !== false }} canFollow busy={busyId === m.id} onToggleFollow={() => toggle(m)} />
          )
        )}
      </div>
    );
  }

  return (
    <div className="w-full min-h-screen bg-black pb-28 text-zinc-300">
      <div className="material scroll-edge sticky top-0 z-40 h-16 px-4">
        <div className="mx-auto flex h-full max-w-6xl items-center gap-3">
          <button
            type="button"
            aria-label={loc('رجوع', 'Back')}
            onClick={goBack}
            className="press-scale flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-900 transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {dir === 'rtl' ? <ArrowRight className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-bold text-white">
            {loc('متاجر أتابعها', 'Stores you follow', 'شوێنکەوتن')}
          </h1>
          {followingNow > 0 && (
            <span className="shrink-0 text-[12px] tabular-nums text-text-muted" data-followed-count>
              {storesLabel(followingNow, lang)}
            </span>
          )}
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 pt-4">{body}</div>
    </div>
  );
}

function UnavailableCard({ busy, onUnfollow }: { busy: boolean; onUnfollow: () => void }) {
  const { loc } = useLanguage();
  return (
    <div data-store-unavailable-card className="flex items-center gap-3 rounded-2xl border border-zinc-800/40 bg-zinc-900/30 p-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-zinc-700/60 bg-zinc-800/60">
        <Store className="h-5 w-5 text-zinc-500" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        {/* OWNER: Sorani to be written by hand. */}
        <h3 className="truncate text-[14.5px] font-bold text-zinc-400">{loc('متجر غير متاح', 'Store unavailable')}</h3>
        <p className="truncate text-[12.5px] text-zinc-500">{loc('هذا المتجر غير متاح حاليًا.', 'This store is not available right now.')}</p>
      </div>
      <button
        type="button"
        onClick={onUnfollow}
        disabled={busy}
        aria-busy={busy || undefined}
        className="min-h-11 shrink-0 rounded-full border border-zinc-700 px-4 text-[12.5px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {/* OWNER: Sorani to be written by hand. */}
        {loc('إلغاء المتابعة', 'Unfollow')}
      </button>
    </div>
  );
}
