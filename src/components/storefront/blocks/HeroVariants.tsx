/**
 * HERO VARIANTS — cover, split and minimal. The classic page's hero is the
 * `profile` variant (./Hero.tsx, in the storefront chunk); these three are
 * only drawn by a layout that picks one, so they travel in the lazy chunk
 * (./extra.tsx) and share the profile's rows, rating line, avatar and call to
 * action from ./Hero.tsx.
 */
import { BadgeCheck } from 'lucide-react';
import ProMerchantBadge from '../../merchant/ProMerchantBadge';
import { Column, useText } from '../parts';
import { Avatar, HeroCta, ProfileRows, RatingLine, type HeroProps } from './Hero';

type VariantProps = HeroProps & { cover: string; name: string };

export default function HeroVariant(props: VariantProps) {
  if (props.block.variant === 'cover') return <CoverHero {...props} />;
  if (props.block.variant === 'split') return <SplitHero {...props} />;
  return <MinimalHero {...props} />;
}

// -------------------------------------------------------------------- cover

/** A tall picture with the identity over its lower edge. */
function CoverHero({ block, store, data, cover, name }: VariantProps) {
  const s = block.settings;
  const text = useText();
  const center = s.align === 'center';
  const line = text(s.subheadline) || store.tagline;
  return (
    <div className="relative">
      <div className="relative h-60 @min-[40rem]:h-80 w-full overflow-hidden bg-white/[0.03]">
        {cover && <img src={cover} alt="" className="w-full h-full object-cover" loading="eager" fetchPriority="high" />}
        <div className="absolute inset-0 sf-cover-fade" />
        <div className="absolute inset-x-0 bottom-0">
          <Column className={`pb-5 flex flex-col gap-2 ${center ? 'items-center text-center' : 'items-start text-start'}`}>
            <Avatar store={store} size="w-16 h-16" />
            <div className={`flex items-center gap-2 min-w-0 max-w-full ${center ? 'justify-center' : ''}`}>
              <h1 className="sf-display leading-tight text-white truncate" dir="auto">
                {name}
              </h1>
              {store.merchant.pro_badge && <ProMerchantBadge compact />}
              {store.merchant.verified && <BadgeCheck className="w-5 h-5 shrink-0 text-white fill-sky-500" aria-hidden="true" />}
            </div>
            {line && (
              <p className="text-zinc-300 text-[13px] leading-snug line-clamp-2 max-w-xl" dir="auto">
                {line}
              </p>
            )}
            <HeroCta block={block} data={data} />
          </Column>
        </div>
      </div>
      <Column className="pt-4 sf-flush">
        <ProfileRows block={{ ...block, settings: { ...s, show_bio: false } }} store={store} bio="" />
      </Column>
    </div>
  );
}

// -------------------------------------------------------------------- split

/** Picture and words side by side on a wide page; stacked on a phone. */
function SplitHero({ block, store, data, cover, name }: VariantProps) {
  const s = block.settings;
  const text = useText();
  const line = text(s.subheadline) || store.tagline || store.description;
  return (
    <Column className="pt-5">
      <div className="grid gap-5 @min-[48rem]:grid-cols-2 @min-[48rem]:items-center">
        <div className="sf-r-lg overflow-hidden bg-white/[0.03] aspect-[4/3]">
          {cover && <img src={cover} alt="" className="w-full h-full object-cover" loading="eager" fetchPriority="high" />}
        </div>
        <div className="flex flex-col items-start gap-3 min-w-0">
          <div className="flex items-center gap-3 min-w-0 max-w-full">
            <Avatar store={store} size="w-14 h-14" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h1 className="sf-display-sm leading-tight text-white truncate" dir="auto">
                  {name}
                </h1>
                {store.merchant.pro_badge && <ProMerchantBadge compact />}
              </div>
              <RatingLine store={store} />
            </div>
          </div>
          {line && (
            <p className="text-zinc-300 text-[13.5px] leading-relaxed line-clamp-4" dir="auto">
              {line}
            </p>
          )}
          <HeroCta block={block} data={data} />
        </div>
      </div>
      <div className="pt-4 sf-flush">
        <ProfileRows block={{ ...block, settings: { ...s, show_bio: false } }} store={store} bio="" />
      </div>
    </Column>
  );
}

// ------------------------------------------------------------------ minimal

/** Logo, name and one line — no picture. */
function MinimalHero({ block, store, data, name }: VariantProps) {
  const s = block.settings;
  const text = useText();
  const center = s.align === 'center';
  const line = text(s.subheadline) || store.tagline;
  return (
    <Column className="pt-6">
      <div className={`flex flex-col gap-2 mb-4 ${center ? 'items-center text-center' : 'items-start text-start'}`}>
        <Avatar store={store} size="w-16 h-16" />
        <div className={`flex items-center gap-2 min-w-0 max-w-full ${center ? 'justify-center' : ''}`}>
          <h1 className="sf-display-sm leading-tight text-white truncate" dir="auto">
            {name}
          </h1>
          {store.merchant.pro_badge && <ProMerchantBadge compact />}
          {store.merchant.verified && <BadgeCheck className="w-5 h-5 shrink-0 text-white fill-sky-500" aria-hidden="true" />}
        </div>
        {line && (
          <p className="text-zinc-400 text-[13px] leading-snug line-clamp-2 max-w-xl" dir="auto">
            {line}
          </p>
        )}
        <HeroCta block={block} data={data} />
      </div>
      <div className="sf-flush">
        <ProfileRows block={{ ...block, settings: { ...s, show_bio: false } }} store={store} bio="" />
      </div>
    </Column>
  );
}
