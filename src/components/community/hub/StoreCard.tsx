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
 */
import { BadgeCheck, Check, Hammer, MapPin, Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';
import { badgeLabel, storeHref } from '../../../lib/merchant';
import ProMerchantBadge from '../../merchant/ProMerchantBadge';
import PremiumMemberBadge from '../../merchant/PremiumMemberBadge';
import { HubLink, StoreMark } from './parts';
import { completedLabel, followersLabel, productsLabel } from './copy';
import type { CommunityStore } from './api';

export default function StoreCard({
  store: m,
  canFollow,
  busy,
  onToggleFollow,
}: {
  store: CommunityStore;
  /** False on the viewer's own shop — following yourself is not a thing. */
  canFollow: boolean;
  busy: boolean;
  onToggleFollow: (store: CommunityStore) => void;
}) {
  const { lang, loc } = useLanguage();
  const name = m.store_name || m.name;
  const about = m.tagline || m.bio;
  const place = m.governorate ? GOVERNORATE_LABELS[m.governorate]?.[lang] ?? '' : '';
  const rated = typeof m.rating === 'number' && (m.rating_count ?? 0) > 0;
  const standing = m.badge && m.badge !== 'new' ? badgeLabel(m.badge, loc) : '';

  return (
    <article
      data-community-store={m.id}
      className="relative flex min-w-0 items-start gap-3 rounded-2xl border border-zinc-800/60 bg-zinc-900/40 p-4 transition-colors hover:border-zinc-700 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
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
            className="line-clamp-2 break-words text-[14.5px] font-bold leading-snug text-white after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none"
          >
            {name}
          </HubLink>
          {m.verified && (
            <BadgeCheck className="h-4 w-4 shrink-0 text-gold" aria-label={loc('موثّق من Levonis', 'Verified by Levonis')} role="img" />
          )}
          {m.pro_badge && <ProMerchantBadge compact />}
          {m.premium_badge && <PremiumMemberBadge compact />}
        </h3>
        {about && (
          <p dir="auto" className="mt-0.5 line-clamp-1 text-start text-[12.5px] text-zinc-400">
            {about}
          </p>
        )}
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-text-muted">
          {rated ? (
            <span className="inline-flex items-center gap-1">
              <Star className="h-3.5 w-3.5 fill-gold text-gold" aria-hidden="true" />
              <span className="font-semibold tabular-nums text-zinc-200">{(m.rating ?? 0).toFixed(1)}</span>
              <span className="tabular-nums">({m.rating_count})</span>
              {/* OWNER: Sorani to be written by hand. */}
              <span className="sr-only">{loc('تقييم', 'rating')}</span>
            </span>
          ) : (
            <span>{badgeLabel('new', loc)}</span>
          )}
          {standing && <span className="text-zinc-300">{standing}</span>}
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
              {/* OWNER: Sorani to be written by hand. */}
              {loc('يقبل طلبات خاصة', 'Takes custom requests')}
            </span>
          )}
        </p>
      </div>
      {canFollow && (
        <div className="relative z-10 flex shrink-0 flex-col items-center gap-1">
          <button
            type="button"
            onClick={() => onToggleFollow(m)}
            disabled={busy}
            aria-pressed={!!m.following}
            aria-busy={busy || undefined}
            data-community-follow={m.following ? 'on' : 'off'}
            className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-3.5 text-[12.5px] font-semibold transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              m.following
                ? 'border-zinc-700 text-zinc-400 hover:bg-zinc-800/60'
                : 'border-sage/40 bg-sage/10 text-sage hover:bg-sage/20'
            }`}
          >
            {m.following && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            {/* OWNER: Sorani to be written by hand. */}
            {m.following ? loc('تتابعه', 'Following') : loc('متابعة', 'Follow')}
          </button>
          {(m.followers ?? 0) > 0 && (
            <span className="text-[10.5px] tabular-nums text-text-muted">{followersLabel(m.followers ?? 0, lang)}</span>
          )}
        </div>
      )}
    </article>
  );
}
