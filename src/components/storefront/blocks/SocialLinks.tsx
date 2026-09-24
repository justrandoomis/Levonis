/**
 * SOCIAL LINKS — `store` shows the links saved in store settings; `custom`
 * shows provider + handle pairs whose address is BUILT from the provider's own
 * template (packages/storeLayout refs.ts), so «Instagram» can only open
 * Instagram.
 */
import { WidgetIcon } from '../../merchant/profileIcons';
import { socialHref, type SocialProviderName } from '../../../../packages/storeLayout/src/refs';
import { BlockHeading, Column, useText } from '../parts';
import type { BlockProps } from '../types';

const PROVIDER: Record<SocialProviderName, { icon: string; name: string }> = {
  instagram: { icon: 'instagram', name: 'Instagram' },
  facebook: { icon: 'facebook', name: 'Facebook' },
  tiktok: { icon: 'tiktok', name: 'TikTok' },
  telegram: { icon: 'telegram', name: 'Telegram' },
  whatsapp: { icon: 'whatsapp', name: 'WhatsApp' },
  youtube: { icon: 'youtube', name: 'YouTube' },
  x: { icon: 'link', name: 'X' },
  snapchat: { icon: 'link', name: 'Snapchat' },
};

export default function SocialLinksBlock({ block, store }: BlockProps<'social_links'>) {
  const s = block.settings;
  const text = useText();
  const links: Array<{ href: string; icon: string; label: string; name: string }> =
    s.source === 'custom'
      ? s.items
          .map((it) => ({ href: socialHref(it), icon: PROVIDER[it.provider]?.icon ?? 'link', label: it.provider === 'whatsapp' ? `+${it.handle}` : `@${it.handle}`, name: PROVIDER[it.provider]?.name ?? '' }))
          .filter((l) => l.href)
      : Object.entries(store.social_links ?? {})
          .filter(([, v]) => typeof v === 'string' && /^https?:\/\//i.test(v))
          .map(([k, v]) => ({ href: v, icon: 'globe', label: k, name: k }));
  if (!links.length) return null;
  const icons = block.variant === 'icons';
  return (
    <Column>
      <BlockHeading title={text(s.title)} />
      <div className={`flex flex-wrap gap-2 ${icons ? 'justify-center' : ''}`}>
        {links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={icons ? l.name || l.label : undefined}
            className={
              icons
                ? 'w-11 h-11 rounded-full border border-white/15 flex items-center justify-center text-zinc-200 active:scale-[0.96] transition-transform'
                : 'inline-flex items-center gap-1.5 min-h-[40px] px-3.5 rounded-full border border-white/15 text-zinc-200 text-[12.5px] font-medium active:scale-[0.98] transition-transform'
            }
          >
            <WidgetIcon name={l.icon} className="w-4 h-4 shrink-0 text-zinc-400" />
            {!icons && (
              <span dir="ltr" translate="no">
                {l.label}
              </span>
            )}
          </a>
        ))}
      </div>
    </Column>
  );
}
