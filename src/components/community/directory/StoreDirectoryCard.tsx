/**
 * A STORE IN THE DIRECTORY (community UI plan C5; IMG_8469). From the inline
 * start: «متابعة», then the name with its trust marks, the place line, the
 * tagline and the «يقبل طلبات خاصة» pill, then the logo disc at the inline
 * end; under them three works, a hairline, and «زيارة المتجر ‹».
 *
 * ONE LINK PER CARD. «زيارة المتجر» is the only link, stretched over the
 * whole card (`after:absolute after:inset-0`), so the card is one target and
 * one Tab stop, named «زيارة المتجر: <name>»; the follow button sits above
 * that layer as its own button, never inside the link. A store on its own
 * subdomain opens in a new tab and says so (hub/parts.tsx HubLink).
 *
 * WHAT IT SAYS IS PUBLIC ALREADY. The place line is the governorate of the
 * store and nothing finer (no phone, no street). The rating is the store own
 * with how many reviews it rests on, or «جديد» (plan D-11); the counts and
 * the plan pills stay on the store page. The works are its showcase pictures
 * (plan B3), decorative and `aria-hidden`.
 *
 * Every look is a utility the app already ships or a scope variable read
 * inline, so the card adds no stylesheet rule.
 */
import { BadgeCheck, Box, MapPin, Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';
import { badgeLabel, storeHref } from '../../../lib/merchant';
import VariantImg from '../../ui/VariantImg';
import FollowButton, { type FollowButtonProps } from '../kit/FollowButton';
import { OnwardChevron } from '../kit/buttons';
import { ApprovedMark, HubLink } from '../hub/parts';
import { useHubStrings } from '../hub/strings';
import type { CommunityStore } from '../hub/api';
import WorksStrip from './WorksStrip';
import { useDirectoryStrings } from './strings';

/** The 58px logo disc, flat: information inside a raised card is never raised. */
const DISC = { width: 58, height: 58 } as const;

export default function StoreDirectoryCard({ store: m, follow }: { store: CommunityStore; follow: FollowButtonProps | null }) {
  const { lang, loc } = useLanguage();
  const s = useHubStrings();
  const d = useDirectoryStrings();
  const name = m.store_name || m.name;
  const about = m.tagline || m.bio;
  const place = m.governorate ? GOVERNORATE_LABELS[m.governorate]?.[lang === 'en' || lang === 'ckb' ? lang : 'ar'] ?? '' : '';
  const rated = typeof m.rating === 'number' && (m.rating_count ?? 0) > 0;
  const logo = m.logoUrl ?? m.avatarUrl;

  return (
    <article
      data-community-store={m.id}
      data-directory-card="store"
      className="cm-card relative flex min-w-0 flex-col gap-3 rounded-xl p-3 shadow-sm has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
    >
      {/* One row while the text column keeps 8.5rem (every phone from 360 in Arabic); on a narrower one, or
          with a longer follow label, the picture goes under it at the inline end rather than crushing the name. */}
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {follow && <FollowButton {...follow} tone="gold" />}
        <div className="min-w-0 grow basis-[8.5rem]">
          <h3 className="flex min-w-0 items-center gap-1.5">
            <bdi dir="auto" className="line-clamp-2 break-words text-start text-[18px] font-extrabold leading-snug text-text-primary">
              {name}
            </bdi>
            {m.verified && <BadgeCheck className="h-4 w-4 shrink-0 text-gold" aria-label={s.verified} role="img" />}
            {m.approved_provider === true && <ApprovedMark />}
          </h3>
          <p data-store-place className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[14px] text-text-secondary">
            {place && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-text-primary" aria-hidden="true" />
                <span className="sr-only">{d.place}: </span>
                {place}
              </span>
            )}
            {place && <span aria-hidden="true">·</span>}
            {rated ? (
              <span className="inline-flex items-center gap-1" data-store-rating>
                <Star className="h-3.5 w-3.5 fill-gold text-gold" aria-hidden="true" />
                <span className="sr-only">{s.rating}</span>
                <span className="font-semibold tabular-nums text-text-primary">{(m.rating ?? 0).toFixed(1)}</span>
                <span className="tabular-nums">({m.rating_count})</span>
              </span>
            ) : (
              <span data-store-rating="new">{badgeLabel('new', loc)}</span>
            )}
          </p>
          {about && (
            <p dir="auto" className="mt-0.5 line-clamp-1 text-start text-[14px] text-text-secondary">
              {about}
            </p>
          )}
          {m.accepts_custom_requests && (
            <span
              data-store-takes-requests
              className="mt-1.5 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-bold"
              style={{ background: 'var(--cm-wait-bg)', color: 'var(--cm-wait-ink)' }}
            >
              <Box className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {d.takesRequests}
            </span>
          )}
        </div>
        <span aria-hidden="true" className="ms-auto flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-selected" style={DISC}>
          {logo ? (
            <VariantImg sizes="58px" src={logo} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          ) : (
            <Box className="h-6 w-6 text-text-muted" />
          )}
        </span>
      </div>
      <WorksStrip works={m.works} ratio="9 / 8" />
      <div aria-hidden="true" className="h-px bg-border-subtle" />
      <HubLink
        href={storeHref(m.store_url, m.id)}
        data-store-visit
        className="-my-1.5 inline-flex min-h-11 items-center gap-1 self-start text-[16px] font-semibold text-gold after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none"
      >
        {d.visitStore}
        <span className="sr-only">
          : <bdi>{name}</bdi>
        </span>
        <OnwardChevron className="h-4 w-4" />
      </HubLink>
    </article>
  );
}
