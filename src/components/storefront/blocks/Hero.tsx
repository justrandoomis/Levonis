/**
 * HERO — the store's identity at the top of the page.
 *
 * `profile` is the reference profile every store had before blocks, and the
 * classic layout's first block: cover → avatar/name/verification → three
 * honest stats → bio → the merchant's three links → their three info cards →
 * the «not taking orders» notice → contact, follow and share. The rows below
 * the identity are shared by every variant and each can be switched off.
 *
 * The name, tagline, description, logo and banner are the STORE's data, read
 * live; the block holds only optional overrides (a headline, a line, another
 * picture), so a merchant editing settings keeps seeing those edits.
 */
import { lazy, Suspense } from 'react';
import { BadgeCheck, Star, Store } from 'lucide-react';
import ProMerchantBadge from '../../merchant/ProMerchantBadge';
import { WidgetIcon } from '../../merchant/profileIcons';
import { useLanguage } from '../../../LanguageContext';
import { badgeLabel } from '../../../lib/storefrontApi';
import { mediaSrc } from '../../../../packages/storeLayout/src/refs';
import { isBlank } from '../../../../packages/storeLayout/src/text';
import { useStorefrontRuntime } from '../runtime';
import { useStoreTheme } from '../StoreTheme';
import { Column, factsWithFallback, hasLink, joinedLine, LinkTo, linkPillLabel, useText } from '../parts';
import type { BlockProps, StorefrontStore } from '../types';

export type HeroProps = BlockProps<'hero'>;

/** The cover, split and minimal variants: not the classic page's, so in the lazy chunk. */
const HeroVariant = lazy(() => import('./extra').then((m) => ({ default: m.HeroVariant })));

export default function HeroBlock({ block, store, data }: HeroProps) {
  const s = block.settings;
  const text = useText();
  const cover = mediaSrc(s.image) || store.bannerUrl || '';
  const name = text(s.headline) || store.name;
  if (block.variant !== 'profile') {
    return (
      <Suspense fallback={<div className="min-h-48" />}>
        <HeroVariant block={block} store={store} data={data} cover={cover} name={name} />
      </Suspense>
    );
  }
  return <ProfileHero block={block} store={store} data={data} cover={cover} name={name} />;
}

// ------------------------------------------------------------------ profile

function ProfileHero({ block, store, cover, name }: HeroProps & { cover: string; name: string }) {
  const s = block.settings;
  const { loc, lang } = useLanguage();
  const { accent } = useStoreTheme();
  const rt = useStorefrontRuntime();
  const text = useText();
  const bio = text(s.subheadline) || store.description || store.tagline;

  return (
    <div className="relative">
      {/* 1 — Cover. The way back and the ⋯ menu float over it (the header). */}
      {s.show_cover && (
        <div className="h-36 @min-[40rem]:h-48 w-full overflow-hidden bg-white/[0.03] relative">
          {cover && <img src={cover} alt="" className="w-full h-full object-cover" loading="eager" fetchPriority="high" />}
          <div className="absolute inset-0 sf-cover-fade" />
        </div>
      )}

      <Column className="relative sf-flush">
        {/* 2 — Avatar + name + verification. The identity block is
            LEFT-anchored exactly like the reference — the avatar on the left
            edge overlapping the cover's last rows, the words in a
            left-aligned column beside it — regardless of the UI language. */}
        <div dir="ltr" className={`flex items-start gap-4 mb-3.5 text-left ${s.show_cover ? '-mt-[18px]' : 'pt-4'}`}>
          <div className="relative shrink-0">
            <div className={`w-[72px] h-[72px] rounded-full sf-bg border-2 ${accent.ring} overflow-hidden flex items-center justify-center`}>
              {store.logoUrl ? (
                <img src={store.logoUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <Store className="w-7 h-7 text-gold" strokeWidth={1.5} aria-hidden="true" />
              )}
            </div>
            {store.merchant.verified && (
              <BadgeCheck className="absolute -bottom-0.5 -right-0.5 w-5 h-5 text-white fill-sky-500" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0 flex-1 pt-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="sf-name min-w-0 truncate leading-tight text-white" dir="auto">
                {name}
              </h1>
              {store.merchant.pro_badge && <ProMerchantBadge compact />}
            </div>
            {rt.profileOnly ? (
              <p className="text-zinc-400 text-[12px] truncate" dir="auto">
                {joinedLine(store.created_at, loc, lang)}
              </p>
            ) : (
              <p className="text-zinc-400 text-[12px] truncate">@{store.slug}</p>
            )}
            <RatingLine store={store} />
            {store.merchant.verified && (
              <span className={`block w-fit mt-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full ${accent.chip}`}>
                {loc('متجر موثّق', 'Verified store', 'فرۆشگای پشتڕاستکراو')}
              </span>
            )}
          </div>
        </div>

        <ProfileRows block={block} store={store} bio={bio} />
      </Column>
    </div>
  );
}

export function RatingLine({ store, center = false }: { store: StorefrontStore; center?: boolean }) {
  const { loc } = useLanguage();
  if (store.merchant.rating !== null && store.merchant.rating !== undefined) {
    return (
      <span className={`inline-flex items-center gap-1 text-[12.5px] mt-1 ${center ? 'justify-center' : ''}`}>
        <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" aria-hidden="true" />
        <span className="text-white font-semibold">{store.merchant.rating.toFixed(1)}</span>
        <span className="text-zinc-500">({store.merchant.rating_count})</span>
        <span className="text-amber-400/80">({loc('تقييم', 'reviews', 'هەڵسەنگاندن')})</span>
      </span>
    );
  }
  return <span className="block text-zinc-500 text-[11.5px] mt-1">{badgeLabel(store.merchant.badge, loc)}</span>;
}

/**
 * Stats → bio → links → info cards → closed notice → actions: the rows under
 * the identity, in the reference's order, each behind its own switch.
 */
export function ProfileRows({ block, store, bio }: { block: HeroProps['block']; store: StorefrontStore; bio: string }) {
  const s = block.settings;
  const { loc, lang } = useLanguage();
  const { accent } = useStoreTheme();
  const rt = useStorefrontRuntime();
  // A pill without a valid address is not rendered to visitors at all — a
  // dead control is noise; the dashboard editor still shows it for fixing.
  const links = (store.profile_links ?? []).filter((w) => w.visible !== false && !!w.url && /^https?:\/\//i.test(w.url)).slice(0, 3);
  const facts = factsWithFallback(store, loc, lang);
  const cols = (n: number) => (n === 1 ? 'grid-cols-1' : n === 2 ? 'grid-cols-2' : 'grid-cols-3');

  return (
    <>
      {/* 3 — Three honest stats, split by short centered hairlines. The rows
          carry explicit dir attributes: the reference geometry is permanent,
          and switching the UI language must never mirror the page. */}
      {s.show_stats && (
        <div dir="rtl" className="flex items-center mb-3.5">
          <ProfileStat
            value={store.positive_pct !== null && store.positive_pct !== undefined ? `${store.positive_pct}%` : '—'}
            label={loc('تقييم إيجابي', 'Positive rating', 'هەڵسەنگاندنی ئەرێنی')}
          />
          <div className="h-6 w-px bg-white/10 shrink-0" />
          <ProfileStat value={String(store.product_count ?? 0)} label={loc('منتجات', 'Products', 'بەرهەم')} />
          <div className="h-6 w-px bg-white/10 shrink-0" />
          <ProfileStat value={String(store.followers ?? 0)} label={loc('متابعون', 'Followers', 'شوێنکەوتوو')} />
        </div>
      )}

      {/* 4 — Bio */}
      {s.show_bio && bio && (
        <p dir="auto" className="text-zinc-300 text-[13px] leading-snug text-center line-clamp-2 mb-4 px-2">
          {bio}
        </p>
      )}

      {/* 5 — The merchant's three link pills: thin outlined stadiums, the
          icon leading the (LTR) address text on the left, as drawn. */}
      {s.show_links && links.length > 0 && (
        <div dir="ltr" className={`grid gap-3 mb-3 px-1.5 ${cols(links.length)}`}>
          {links.map((w, i) => (
            <a
              key={i}
              href={w.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="relative lv-hit h-7 rounded-full border border-white/15 bg-transparent flex items-center justify-center gap-1.5 px-2.5 text-zinc-200 active:scale-[0.98] transition-transform min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <WidgetIcon name={w.icon} className="w-3 h-3 shrink-0 text-zinc-400" />
              <span className="text-[12px] font-medium truncate" dir="auto">
                {linkPillLabel(w)}
              </span>
            </a>
          ))}
        </div>
      )}

      {/* 6 — The merchant's three info cards: borderless filled tiles,
          content centered, the icon on the row's leading side. */}
      {s.show_info_cards && facts.length > 0 && (
        <div dir="rtl" className={`grid gap-3 mb-4 ${cols(facts.length)}`}>
          {facts.map((w, i) => (
            <div key={i} className="sf-fact px-2 py-2.5 flex items-center justify-center gap-2 min-w-0">
              <WidgetIcon name={w.icon} className="w-4 h-4 shrink-0 text-zinc-400" />
              <div className="min-w-0">
                <p className="text-zinc-100 text-[12.5px] font-medium truncate leading-tight">{w.title}</p>
                {w.subtitle && <p className="text-zinc-500 text-[11px] truncate leading-tight">{w.subtitle}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* A closed store says so, without saying why — that is between the
          merchant and Levonis (§51). `open` is the cart's own answer; a shop
          that sells no products directly is not "closed" to the custom work
          it does take. */}
      {!store.open && store.sells_direct_products !== false && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 mb-4">
          <p className="text-amber-200/90 text-[12px]">
            {loc(
              'هذا المتجر لا يستقبل طلبات حاليًا.',
              'This store is not taking orders right now.',
              'ئەم فرۆشگایە لە ئێستادا داواکاری وەرناگرێت.'
            )}
          </p>
        </div>
      )}

      {/* 7 — Actions: the contact button and the follow pill with the share
          link inside its far-left end, as drawn. The host draws them live. */}
      {s.show_actions && (
        <div className="mb-4">
          <rt.ProfileActions accent={accent} />
        </div>
      )}
    </>
  );
}

function ProfileStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex-1 py-1 px-1 text-center min-w-0">
      <div className="text-white font-bold text-[14px] leading-tight" dir="ltr">
        {value}
      </div>
      <div className="text-zinc-500 text-[11px] truncate">{label}</div>
    </div>
  );
}

export function Avatar({ store, size }: { store: StorefrontStore; size: string }) {
  const { accent } = useStoreTheme();
  return (
    <div className={`${size} rounded-full sf-bg border-2 ${accent.ring} overflow-hidden flex items-center justify-center shrink-0`}>
      {store.logoUrl ? (
        <img src={store.logoUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        <Store className="w-7 h-7 text-gold" strokeWidth={1.5} aria-hidden="true" />
      )}
    </div>
  );
}

export function HeroCta({ block, data }: Pick<HeroProps, 'block' | 'data'>) {
  const text = useText();
  const { accent } = useStoreTheme();
  const label = text(block.settings.cta_label);
  if (!label || isBlank(block.settings.cta_label) || !hasLink(block.settings.cta_link, data)) return null;
  return (
    <LinkTo
      link={block.settings.cta_link}
      data={data}
      className={`inline-flex items-center justify-center min-h-[44px] px-5 rounded-xl font-bold text-[13px] ${accent.btn} active:scale-[0.98] transition-transform`}
    >
      {label}
    </LinkTo>
  );
}
