/**
 * A MAKER IN THE COMMUNITY — the person behind the projects, as a card that
 * opens their page (`/u/<username>`), with «متابعة» as its own button above
 * the card's stretched link (src/components/community/social/FollowUserButton).
 *
 * `rail`: the home's 132 px tile — picture, name, one count, the pill.
 * `row`: the makers' directory — StoreCard's rhythm: picture, name and
 * badges, one line of bio, the counts, the pill on the far side.
 */
import { Link } from 'react-router-dom';
import { BadgeCheck } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import ProMerchantBadge from '../../merchant/ProMerchantBadge';
import PremiumMemberBadge from '../../merchant/PremiumMemberBadge';
import FollowUserButton from '../social/FollowUserButton';
import { creatorHref, type CreatorCard as CreatorCardData } from '../social/api';
import { followersLabel, socialLang } from '../social/strings';
import { Avatar, HubLink } from './parts';
import { projectsLabel, hubLang, useHubStrings } from './strings';

export default function CreatorCard({ creator: c, variant = 'row' }: { creator: CreatorCardData; variant?: 'row' | 'rail' }) {
  const { lang } = useLanguage();
  const s = useHubStrings();
  const href = creatorHref(c.username);
  const badges = (
    <>
      {c.badges.verified_merchant && <BadgeCheck className="h-4 w-4 shrink-0 text-gold" aria-label={s.verifiedMerchant} role="img" />}
      {c.badges.pro && <ProMerchantBadge compact />}
      {c.badges.premium && <PremiumMemberBadge compact />}
    </>
  );

  if (variant === 'rail') {
    return (
      <article
        data-community-creator={c.id}
        className="relative flex w-[132px] shrink-0 snap-start flex-col items-center gap-2 rounded-2xl border border-border-subtle/60 bg-surface p-3 text-center has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
      >
        <Avatar src={c.avatarUrl} className="h-16 w-16" />
        <h3 className="flex w-full min-w-0 items-center justify-center gap-1 text-[13px] font-bold leading-snug text-text-primary">
          <Link to={href} className="min-w-0 truncate after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none">
            <bdi>{c.name}</bdi>
          </Link>
          {badges}
        </h3>
        <p className="text-[11px] tabular-nums text-text-muted">
          {c.stats.projects > 0 ? projectsLabel(c.stats.projects, hubLang(lang)) : c.stats.followers > 0 ? followersLabel(c.stats.followers, socialLang(lang)) : ' '}
        </p>
        <FollowUserButton userId={c.id} following={c.viewer.following} followers={c.stats.followers} size="sm" />
      </article>
    );
  }

  return (
    <article
      data-community-creator={c.id}
      className="relative flex min-w-0 items-start gap-3 rounded-2xl border border-border-subtle/60 bg-surface p-4 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
    >
      <Avatar src={c.avatarUrl} className="h-12 w-12" />
      <div className="min-w-0 flex-1">
        <h3 className="flex min-w-0 items-center gap-1.5">
          <Link to={href} className="line-clamp-2 break-words text-[14.5px] font-bold leading-snug text-text-primary after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none">
            <bdi>{c.name}</bdi>
          </Link>
          {badges}
        </h3>
        {c.bio && (
          <p dir="auto" className="mt-0.5 line-clamp-1 text-start text-[12.5px] text-text-secondary">
            {c.bio}
          </p>
        )}
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] tabular-nums text-text-muted">
          {c.stats.projects > 0 && <span>{projectsLabel(c.stats.projects, hubLang(lang))}</span>}
          {c.stats.followers > 0 && <span>{followersLabel(c.stats.followers, socialLang(lang))}</span>}
          {c.store && (
            <HubLink href={c.store.url} className="relative z-10 truncate rounded text-text-secondary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              {s.theirStore}: <bdi>{c.store.name}</bdi>
            </HubLink>
          )}
        </p>
      </div>
      <FollowUserButton userId={c.id} following={c.viewer.following} followers={c.stats.followers} size="sm" className="shrink-0" />
    </article>
  );
}
