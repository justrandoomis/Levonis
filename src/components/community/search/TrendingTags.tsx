/**
 * «وسوم رائجة» — the tags of the last 30 days' public posts, most used first,
 * from the one five-minute /trending read that the home's composite already
 * holds (hub/useHomeData.ts). A chip row under the cover, each chip the
 * projects page narrowed to that tag. The row is laid out WITH the cover —
 * the tags arrive in the same composite — so it never inserts itself under
 * the cover a moment later and pushes the first section down. Nothing when
 * there are no tags: an empty row is not a feature.
 *
 * A chip is an `.lv-choice`, whose own `:focus-visible` outline is the
 * keyboard's ring — nothing here switches it off.
 */
import { Link } from 'react-router-dom';
import { Hash } from 'lucide-react';
import type { TrendingTag } from './api';
import { useSearchStrings } from './strings';

export default function TrendingTags({ tags, limit = 12 }: { tags: TrendingTag[] | null; limit?: number }) {
  const s = useSearchStrings();
  const rows = tags?.slice(0, limit) ?? [];
  if (rows.length === 0) return null;
  return (
    <nav aria-label={s.trendingTags} data-community-trending-tags="" className="-mx-4 flex snap-x items-center gap-2 overflow-x-auto px-4 pb-1 hide-scrollbar">
      <span className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-text-muted">
        <Hash aria-hidden="true" className="h-3.5 w-3.5" />
        {s.trendingTags}
      </span>
      {rows.map((t) => (
        <Link key={t.tag} to={`/community/projects?tag=${encodeURIComponent(t.tag)}`} className="lv-choice inline-flex shrink-0 snap-start items-center gap-1.5 px-3 text-[12.5px]">
          <span dir="auto">#{t.tag}</span>
          {t.count > 0 && <span className="tabular-nums text-text-muted">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
