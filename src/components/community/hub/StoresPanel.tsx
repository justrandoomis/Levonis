/**
 * «المتاجر» — the stores directory, a page at a time from
 * /api/community/merchants, searched on the server by the page `q`. Moved
 * out of src/pages/Community.tsx (community UI plan B4) so the home tab and
 * the section page /community/stores render the same list; C5 restyles it.
 *
 * Above the list, the viewer own place in the directory (YourStore) and the
 * works rail. «متابعة» answers at once and is put back if the server says
 * no; a guest is asked to sign in and brought back (DECISIONS row 89).
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, Store } from 'lucide-react';
import { useAuth } from '../../../AuthContext';
import { useLanguage } from '../../../LanguageContext';
import { useSignInPrompt } from '../../../lib/guest';
import { ApiError } from '../../../lib/api';
import type { MerchantMe } from '../../../lib/merchant';
import { merchantHref } from '../../../lib/merchantRoutes';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { toast } from '../../ui/Toast';
import LoadMore from '../../listing/LoadMore';
import { applicationCta, approvalReason } from '../../merchantApplication/approvalWords';
import StoreCard from './StoreCard';
import WorksRail from './WorksRail';
import { StoreListSkeleton, StoreMark } from './parts';
import { NoResults, SearchLine } from './search';
import { useHubStrings } from './strings';
import { useCommunityFeed, type CommunityFeed } from './useCommunityFeed';
import { forgetHome } from './useHomeData';
import { communityHubApi, type CommunityStore } from './api';

/** How many «عرض المزيد» can honestly promise: the first page total, less what is shown. */
function remaining<T extends { id: string }>(feed: CommunityFeed<T>): number {
  if (!feed.hasMore || !feed.rows) return 0;
  return Math.max(1, (feed.total ?? 0) - feed.rows.length);
}

export default function StoresPanel({ q, viewer, me, onClear }: { q: string; viewer: string; me: MerchantMe | null; onClear: () => void }) {
  const s = useHubStrings();
  const { user, isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const feed = useCommunityFeed<CommunityStore>('merchants', q, viewer);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * «متابعة» answers at once and is put back if the server says no. A guest is
   * asked to sign in and brought back here; a follow is never sent that is sure
   * to fail (docs/DECISIONS.md row 89).
   */
  const toggleFollow = async (m: CommunityStore) => {
    if (!isAuthenticated) {
      signIn();
      return;
    }
    if (busy) return;
    const was = !!m.following;
    const set = (following: boolean, followers: number) =>
      feed.patch((rows) => rows.map((r) => (r.id === m.id ? { ...r, following, followers } : r)));
    setBusy(m.id);
    set(!was, Math.max(0, (m.followers ?? 0) + (was ? -1 : 1)));
    try {
      await (was ? communityHubApi.unfollow(m.id) : communityHubApi.follow(m.id));
      feed.forgetOthers();
      forgetHome();
    } catch (e) {
      set(was, m.followers ?? 0);
      if (e instanceof ApiError && e.status === 401) signIn();
      else toast.error(s.followFailed);
    } finally {
      setBusy(null);
    }
  };

  let body: React.ReactNode;
  if (feed.error) body = <ErrorState error={feed.error} onRetry={feed.reload} />;
  else if (!feed.rows) body = <StoreListSkeleton />;
  else if (feed.rows.length === 0) {
    body = q ? <NoResults q={q} onClear={onClear} /> : <EmptyState icon={<Store aria-hidden="true" className="h-6 w-6" />} title={s.noStores} />;
  } else {
    body = (
      <>
        <SearchLine q={q} total={feed.total} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {feed.rows.map((m) => (
            <StoreCard key={m.id} store={m} canFollow={m.user_id !== user?.id} busy={busy === m.id} onToggleFollow={toggleFollow} />
          ))}
        </div>
        <LoadMore remaining={remaining(feed)} state={feed.more} onMore={feed.loadMore} />
      </>
    );
  }

  return (
    <div data-community-panel="merchants">
      {!q && <WorksRail />}
      {!q && <YourStore me={me} />}
      {body}
    </div>
  );
}

/**
 * The viewer own place in the directory: their store, one tap from its
 * workspace, or the way to one. A member with no approval yet is shown the
 * MERCHANT APPLICATION whatever their plan: applying needs no PLUS (owner
 * decision C3). An approved member opens their store when their plan lets
 * them; an older server (no `approved` in its answer) keeps the plan gate.
 * Nothing for anyone else: a button to a door that will not open is the dead
 * control the mandate forbids (src/components/merchant/StoreCta.tsx).
 */
function YourStore({ me }: { me: MerchantMe | null }) {
  const { dir, loc } = useLanguage();
  const s = useHubStrings();
  if (!me) return null;
  const applying = !me.store && me.approved === false;
  if (!me.store && !applying && !me.eligible) return null;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const to = me.store ? merchantHref.home() : '/merchant/start';
  return (
    <Link
      to={to}
      data-community-your-store={me.store ? 'manage' : applying ? 'apply' : 'create'}
      className="lv-surface mb-4 flex items-center gap-3 px-4 py-3 active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {me.store ? (
        <StoreMark src={me.store.logoUrl} />
      ) : (
        <span aria-hidden="true" className="lv-well flex h-12 w-12 shrink-0 items-center justify-center rounded-full">
          <Plus className="h-5 w-5 text-text-secondary" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-text-primary">
          {me.store ? s.yourStore : applying ? applicationCta(me.application, loc) : s.createStore}
        </span>
        <span dir={me.store ? 'auto' : undefined} className="block truncate text-start text-[12px] text-text-secondary">
          {me.store ? me.store.name : applying ? approvalReason(me.application, loc) : s.yourStoreHint}
        </span>
      </span>
      <Chevron aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
    </Link>
  );
}
