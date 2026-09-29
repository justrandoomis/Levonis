/**
 * A STORE IN THE COMMUNITY DIRECTORY — the shop the visitor will land on, with
 * the reasons to trust it that its own page already publishes.
 *
 * ONE LINK, ONE BUTTON, NEVER ONE INSIDE THE OTHER. The store's name is the
 * link, stretched over the whole card (`after:absolute after:inset-0`), so the
 * card is one big target for a finger and one stop for a keyboard; «متابعة»
 * sits above that layer as its own button. A button nested in a link is
 * invalid HTML and a screen reader announces it as nonsense.
 *
 * THE NUMBERS ARE THE STORE'S OWN: its rating with how many reviews it rests
 * on, the orders it has finished, its published products. A shop with no
 * reviews says «جديد» — never a fabricated five stars. A shop that takes
 * custom print requests says so: that is why many come to the community.
 *
 * `variant="rail"` is the home's 200 px tile: logo, name, a strip of three of
 * the shop's works (`works`, from /api/community/works grouped by store) and
 * the same follow pill.
 */
import { BadgeCheck, Check, Hammer, MapPin, Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';
import { badgeLabel, storeHref } from '../../../lib/merchant';
import ProMerchantBadge from '../../merchant/ProMerchantBadge';
import PremiumMemberBadge from '../../merchant/PremiumMemberBadge';
import SafeImage from '../../ui/SafeImage';
import { HubLink, StoreMark } from './parts';
import { completedLabel, followersLabel, productsLabel } from './copy';
import { useHubStrings } from './strings';
import type { CommunityStore, CommunityWork } from './api';

export interface StoreCardProps {
  store: CommunityStore;
  /** False on the viewer's own shop — following yourself is not a thing. */
  canFollow: boolean;
  busy: boolean;
  onToggleFollow: (store: CommunityStore) => void;
  /** `rail`: a fixed-width tile in a horizontal strip; `row`: the directory's card. */
  variant?: 'row' | 'rail';
  /** The rail tile's three works. */
  works?: CommunityWork[];
}

export default function StoreCard({ store: m, canFollow, busy, onToggleFollow, variant = 'row', works }: StoreCardProps) {
  const { lang, loc } = useLanguage();
  const s = useHubStrings();
  const name = m.store_name || m.name;
  const about = m.tagline || m.bio;
  const place = m.governorate ? GOVERNORATE_LABELS[m.governorate]?.[lang] ?? '' : '';
  const rated = typeof m.rating === 'number' && (m.rating_count ?? 0) > 0;
  const standing = m.badge && m.badge !== 'new' ? badgeLabel(m.badge, loc) : '';

  const follow = canFollow && (
    <button
      type="button"
      onClick={() => onToggleFollow(m)}
      disabled={busy}
      aria-pressed={!!m.following}
      aria-busy={busy || undefined}
      data-community-follow={m.following ? 'on' : 'off'}
      className={`relative z-10 inline-flex min-h-11 items-center gap-1 rounded-full border px-3.5 text-[12.5px] font-semibold transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        m.following ? 'border-border-subtle bg-surface text-text-secondary hover:text-text-primary' : 'border-sage/40 bg-sage/10 text-sage hover:bg-sage/20'
      }`}
    >
      {m.following && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
      {m.following ? loc('تتابعه', 'Following', 'شوێنی دەکەویت') : loc('متابعة', 'Follow', 'شوێنکەوتن')}
    </button>
  );

  if (variant === 'rail') {
    const strip = (works ?? []).slice(0, 3);
    return (
      <article
        data-community-store={m.id}
        className="relative flex w-[200px] shrink-0 snap-start flex-col gap-2.5 rounded-2xl border border-border-subtle/60 bg-surface p-3 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
      >
        <div className="flex min-w-0 items-center gap-2">
          <StoreMark src={m.logoUrl ?? m.avatarUrl} />
          <h3 className="min-w-0 flex-1">
            <HubLink
              href={storeHref(m.store_url, m.id)}
              dir="auto"
              className="line-clamp-2 break-words text-start text-[13.5px] font-bold leading-snug text-text-primary after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none"
            >
              {name}
            </HubLink>
            {m.accepts_custom_requests && (
              <span className="mt-0.5 flex items-center gap-1 text-[11px] text-text-muted" data-store-takes-requests>
                <Hammer className="h-3 w-3" aria-hidden="true" />
                {s.takesRequests}
              </span>
            )}
          </h3>
        </div>
        {strip.length > 0 && (
          <div aria-hidden="true" className="grid grid-cols-3 gap-1">
            {strip.map((w) => (
              <SafeImage key={w.id} src={w.imageUrl} alt="" aspect="square" className="overflow-hidden rounded-lg" bgClassName="bg-surface-selected" />
            ))}
          </div>
        )}
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] tabular-nums text-text-muted">
            {(m.followers ?? 0) > 0 ? followersLabel(m.followers ?? 0, lang) : rated ? `★ ${(m.rating ?? 0).toFixed(1)}` : badgeLabel('new', loc)}
          </span>
          {follow}
        </div>
      </article>
    );
  }

  return (
    <article
      data-community-store={m.id}
      className="relative flex min-w-0 items-start gap-3 rounded-2xl border border-border-subtle/60 bg-surface p-4 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
    >
      <StoreMark src={m.logoUrl ?? m.avatarUrl} />
      <div className="min-w-0 flex-1">
        <h3 className="flex min-w-0 items-center gap-1.5">
          {/* Two lines before an ellipsis — a small phone leaves the name a
              narrow column — and dir="auto" on the box that clamps, so an
              English name loses its END inside the Arabic page, not its start. */}
          <HubLink
            href={storeHref(m.store_url, m.id)}
            dir="auto"
            className="line-clamp-2 break-words text-[14.5px] font-bold leading-snug text-text-primary after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none"
          >
            {name}
          </HubLink>
          {m.verified && <BadgeCheck className="h-4 w-4 shrink-0 text-gold" aria-label={s.verified} role="img" />}
          {m.pro_badge && <ProMerchantBadge compact />}
          {m.premium_badge && <PremiumMemberBadge compact />}
        </h3>
        {about && (
          <p dir="auto" className="mt-0.5 line-clamp-1 text-start text-[12.5px] text-text-secondary">
            {about}
          </p>
        )}
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-text-muted">
          {rated ? (
            <span className="inline-flex items-center gap-1">
              <Star className="h-3.5 w-3.5 fill-gold text-gold" aria-hidden="true" />
              <span className="font-semibold tabular-nums text-text-primary">{(m.rating ?? 0).toFixed(1)}</span>
              <span className="tabular-nums">({m.rating_count})</span>
              <span className="sr-only">{s.rating}</span>
            </span>
          ) : (
            <span>{badgeLabel('new', loc)}</span>
          )}
          {standing && <span className="text-text-secondary">{standing}</span>}
          {(m.completed_orders ?? 0) > 0 && <span>{completedLabel(m.completed_orders ?? 0, lang)}</span>}
          {(m.product_count ?? 0) > 0 && <span>{productsLabel(m.product_count ?? 0, lang)}</span>}
          {place && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" aria-hidden="true" />
              {place}
            </span>
          )}
          {m.accepts_custom_requests && (
            <span className="inline-flex items-center gap-1" data-store-takes-requests>
              <Hammer className="h-3 w-3" aria-hidden="true" />
              {s.takesRequests}
            </span>
          )}
        </p>
      </div>
      {canFollow && (
        <div className="relative z-10 flex shrink-0 flex-col items-center gap-1">
          {follow}
          {(m.followers ?? 0) > 0 && (
            <span className="text-[10.5px] tabular-nums text-text-muted">{followersLabel(m.followers ?? 0, lang)}</span>
          )}
        </div>
      )}
    </article>
  );
}
