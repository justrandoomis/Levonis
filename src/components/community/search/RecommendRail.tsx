/**
 * «قد يعجبك» / «متاجر مشابهة» — a rail from /api/community/recommend
 * (docs/COMMUNITY_ECOSYSTEM.md §9.3): for a project, other public pieces on
 * the same material, printer or tags; for a store, other visible stores of
 * the same governorate or trade; for a community product, other stores'
 * products of the same kind. No model of the viewer: the server ranks by
 * what the anchor shares with the candidates.
 *
 * A LAZY CHUNK OF THE PAGE, mounted below the fold, that hides itself on an
 * error or an empty answer — the page never says «loading» for a rail that
 * may never exist. The viewer's own blocks and mutes hide a maker's project
 * here as they do on every rail (hub/rails.tsx).
 */
import React, { useEffect, useState } from 'react';
import type { PostCard } from '../projects/api';
import ProjectCard from '../projects/ProjectCard';
import ProductTile from '../hub/ProductTile';
import StoreCard from '../hub/StoreCard';
import { Rail, Reveal } from '../hub/parts';
import { useStoreFollow } from '../hub/useStoreFollow';
import type { CommunityProduct, CommunityStore } from '../hub/api';
import { useSocial } from '../social/SocialContext';
import { searchApi, type RecommendKind, type Recommendation } from './api';
import { useSearchStrings } from './strings';

export default function RecommendRail({ anchor, kind, limit = 8, className = '' }: { anchor: string; kind: RecommendKind; limit?: number; className?: string }) {
  const s = useSearchStrings();
  const social = useSocial();
  const follow = useStoreFollow();
  const [rec, setRec] = useState<Recommendation | null>(null);

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    setRec(null);
    searchApi
      .recommend(anchor, limit, { signal: ac.signal })
      .then((r) => {
        if (alive) setRec(r);
      })
      .catch(() => {
        if (alive) setRec(null);
      });
    return () => {
      alive = false;
      ac.abort();
    };
  }, [anchor, limit]);

  if (!rec || rec.kind !== kind || rec.rows.length === 0) return null;
  const id = `community-recommend-${kind}`;
  const title = kind === 'projects' ? s.youMayLike : kind === 'stores' ? s.relatedStores : s.relatedProducts;

  let rows: React.ReactNode = null;
  if (kind === 'projects') {
    const posts = (rec.rows as PostCard[]).filter((p) => !social.blocked.has(p.author.id) && !social.muted.has(p.author.id));
    if (posts.length === 0) return null;
    rows = (
      <Rail>
        {posts.map((p) => (
          <ProjectCard key={p.id} post={p} variant="rail" />
        ))}
      </Rail>
    );
  } else if (kind === 'stores') {
    rows = (
      <Rail>
        {(rec.rows as CommunityStore[]).map((raw) => {
          const m = follow.view(raw);
          return <StoreCard key={m.id} store={m} variant="rail" works={[]} canFollow={follow.canFollow(m)} busy={follow.busy === m.id} onToggleFollow={follow.toggle} />;
        })}
      </Rail>
    );
  } else {
    rows = (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {(rec.rows as CommunityProduct[]).map((p) => (
          <ProductTile key={p.id} product={p} />
        ))}
      </div>
    );
  }

  return (
    <Reveal labelledBy={id} className={className} data-community-recommend={kind}>
      <h2 id={id} className="mb-3 flex items-center gap-2 text-[18px] font-black leading-tight text-text-primary">
        <span aria-hidden="true" className="h-px w-4 bg-gold" />
        {title}
      </h2>
      {rows}
    </Reveal>
  );
}
