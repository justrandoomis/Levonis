/**
 * A MAKER IN THE DIRECTORY (community UI plan C5; IMG_8476). From the inline
 * start: «متابعة», then the name with its trust marks, the first line of the
 * bio and «عرض الملف ‹», then the 64px picture at the inline end; under them
 * three of the public projects of the maker.
 *
 * ONE LINK PER CARD. «عرض الملف» is the only link, stretched over the whole
 * card and named «عرض الملف: <name>»; the follow button (the shared one of
 * social/FollowUserButton, hidden on the account of the viewer and for a
 * blocked person) sits above it. No place line: a person has no public
 * governorate (plan R11). The works are public project covers only (plan
 * B3), decorative and `aria-hidden`.
 */
import { Link } from 'react-router-dom';
import { BadgeCheck } from 'lucide-react';
import { OnwardChevron } from '../kit/buttons';
import FollowUserButton from '../social/FollowUserButton';
import { creatorHref, type CreatorCard } from '../social/api';
import { ApprovedMark, Avatar } from '../hub/parts';
import { useHubStrings } from '../hub/strings';
import WorksStrip from './WorksStrip';
import { specialtyLine, useDirectoryStrings } from './strings';

export default function MakerDirectoryCard({ creator: c }: { creator: CreatorCard }) {
  const s = useHubStrings();
  const d = useDirectoryStrings();
  const line = specialtyLine(c.bio);
  return (
    <article
      data-community-creator={c.id}
      data-directory-card="maker"
      className="cm-card relative flex min-w-0 flex-col gap-3 rounded-xl p-3 shadow-sm has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
    >
      {/* One row while the text column keeps 8.5rem (every phone from 360 in Arabic); on a narrower one, or
          with a longer follow label, the picture goes under it at the inline end rather than crushing the name. */}
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <FollowUserButton userId={c.id} following={c.viewer.following} followers={c.stats.followers} size="sm" tone="gold" name={c.name} />
        <div className="min-w-0 grow basis-[8.5rem]">
          <h3 className="flex min-w-0 items-center gap-1.5">
            <bdi dir="auto" className="line-clamp-2 break-words text-start text-[17px] font-bold leading-snug text-text-primary">
              {c.name}
            </bdi>
            {c.badges.verified_merchant && <BadgeCheck className="h-4 w-4 shrink-0 text-gold" aria-label={s.verifiedMerchant} role="img" />}
            {c.badges.approved_provider === true && <ApprovedMark />}
          </h3>
          {line && (
            <p dir="auto" data-maker-line className="mt-0.5 line-clamp-1 text-start text-[15px] text-text-secondary">
              {line}
            </p>
          )}
          <Link
            to={creatorHref(c.username)}
            data-maker-profile
            className="-my-1.5 inline-flex min-h-11 items-center gap-1 text-[14px] font-semibold text-gold after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none"
          >
            {d.viewProfile}
            <span className="sr-only">
              : <bdi>{c.name}</bdi>
            </span>
            <OnwardChevron className="h-3.5 w-3.5" />
          </Link>
        </div>
        <Avatar src={c.avatarUrl} className="ms-auto h-16 w-16" />
      </div>
      <WorksStrip works={c.works} ratio="4 / 3" />
    </article>
  );
}
