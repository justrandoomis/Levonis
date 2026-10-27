/**
 * A FEATURED MAKER AS A ROW (community UI plan C1 R10 and D3 (f); IMG_8487,
 * IMG_8462): the picture at the inline start, the name over the first line of
 * their bio, and at the inline end «متابعة» (kit FollowButton through
 * FollowUserButton) and the onward chevron.
 *
 * The name is the stretched link to the maker page (`/u/<username>`), so the
 * row is one Tab stop for the page and one for the follow; the follow button
 * is a sibling above the link (`relative z-10`), never inside it. A blocked
 * maker is not drawn (the caller filters).
 *
 * No specialty field exists (D-12): the line is the first line of the bio.
 */
import { Link } from 'react-router-dom';
import FollowUserButton from '../social/FollowUserButton';
import { creatorHref, type CreatorCard } from '../social/api';
import { KitAvatar } from '../kit/display';
import { OnwardChevron } from '../kit/buttons';

/** The first line of a bio: the specialty a maker wrote first. */
export const firstLine = (bio: string | null | undefined) => (bio ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

export default function MakerRow({ creator: c, wide = false }: { creator: CreatorCard; wide?: boolean }) {
  const line = firstLine(c.bio);
  return (
    <li data-community-creator={c.id} className="relative flex min-h-[72px] items-center gap-3 px-4 py-3 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus">
      <KitAvatar src={c.avatarUrl} name={c.name} size={wide ? 64 : 48} />
      <div className="min-w-0 flex-1">
        <h3 className={`truncate font-bold leading-snug text-text-primary ${wide ? 'text-[17px]' : 'text-[15px]'}`}>
          <Link to={creatorHref(c.username)} className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">
            <bdi>{c.name}</bdi>
          </Link>
        </h3>
        {line && (
          <p dir="auto" className="truncate text-start text-[13px] text-text-secondary">
            {line}
          </p>
        )}
      </div>
      <FollowUserButton userId={c.id} following={c.viewer.following} followers={c.stats.followers} size="sm" name={c.name} className="relative z-10 shrink-0" />
      {!wide && <OnwardChevron className="h-[18px] w-[18px] shrink-0 text-text-secondary" />}
    </li>
  );
}
