/**
 * THE FEED — «أحدث المشاريع» on «لك», and the whole of «أتابعهم»: PostCard
 * rows from /api/community/feed, a cursor page at a time through
 * useCommunityFeed (so Back finds the rows it left, for two minutes).
 *
 * The next page arrives on its own TWICE, when the end of the list comes
 * near (IntersectionObserver); after that «عرض المزيد» is a button, so the
 * footer stays reachable and the list's length is a fact. A failed first
 * page is the one place on the home that shows an error: the feed is the
 * issue's body, not a rail that can step aside.
 *
 * A lazy chunk: the home mounts it when the feed section approaches.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../../../AuthContext';
import { ErrorState } from '../../ui/AsyncStates';
import LoadMore from '../../listing/LoadMore';
import type { PostCard as PostCardData } from '../projects/api';
import type { FeedScope } from '../social/api';
import { PostSkeleton } from '../hub/parts';
import { useCommunityFeed } from '../hub/useCommunityFeed';
import { useSocial } from '../social/SocialContext';
import ComposerDock from './ComposerDock';
import PostCard, { type PostPatch } from './PostCard';

const AUTO_LOADS = 2;

export default function FeedList({
  scope,
  empty,
  dock,
}: {
  scope: FeedScope;
  /** What to show when the feed has nothing (the caller decides the words). */
  empty: ReactNode;
  /** The composer's door, docked at the end of the list. */
  dock?: { to: string; state?: unknown };
}) {
  const { user } = useAuth();
  const viewer = user?.id ?? 'guest';
  const feed = useCommunityFeed<PostCardData>(scope === 'following' ? 'feed:following' : 'feed:foryou', '', viewer);
  const social = useSocial();
  const [auto, setAuto] = useState(0);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadMore = feed.loadMore;
  const patch = feed.patch;
  const armed = feed.hasMore && feed.more === 'idle' && auto < AUTO_LOADS;

  // A like or a save made here is written into the remembered page too, so
  // Back finds the heart lit and the number right — not the row as fetched.
  const onPatch = useCallback(
    (id: string, change: PostPatch) =>
      patch((rows) =>
        rows.map((r) =>
          r.id === id ? { ...r, counts: { ...r.counts, ...change.counts }, viewer: { ...(r.viewer ?? {}), ...change.viewer } } : r
        )
      ),
    [patch]
  );

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !armed || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        setAuto((n) => n + 1);
        loadMore();
      },
      { rootMargin: '200px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [armed, loadMore]);

  if (feed.error) return <ErrorState error={feed.error} onRetry={feed.reload} />;
  if (!feed.rows) return <PostSkeleton />;
  // The viewer's OWN block or mute, made a moment ago, hides the person's rows
  // already on screen; the server drops them from the next uncached read.
  const rows = feed.rows.filter((p) => !social.blocked.has(p.author.id) && !social.muted.has(p.author.id));
  if (rows.length === 0 && !feed.hasMore) return <>{empty}</>;

  return (
    <div data-community-feed={scope}>
      <div>
        {rows.map((p, i) => (
          <PostCard key={p.id} post={p} eager={i < 2} onPatch={onPatch} />
        ))}
      </div>
      <div ref={sentinel} aria-hidden="true" />
      <LoadMore remaining={feed.hasMore ? null : 0} state={feed.more} onMore={feed.loadMore} />
      {dock && <ComposerDock to={dock.to} state={dock.state} />}
    </div>
  );
}
