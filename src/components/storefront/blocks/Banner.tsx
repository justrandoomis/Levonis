/**
 * BANNER — one picture with optional words over its lower edge, the whole of
 * it a link when the merchant gave one. `wide` runs edge to edge; `inset` sits
 * in the content column with the theme's corners.
 */
import { useLanguage } from '../../../LanguageContext';
import { mediaSrc } from '../../../../packages/storeLayout/src/refs';
import { useStoreTheme } from '../StoreTheme';
import { Column, hasLink, LinkTo, useText } from '../parts';
import type { BlockProps } from '../types';

const HEIGHT = {
  short: 'h-32 @min-[40rem]:h-44',
  medium: 'h-44 @min-[40rem]:h-64',
  tall: 'h-60 @min-[40rem]:h-96',
} as const;

export default function BannerBlock({ block, store, data }: BlockProps<'banner'>) {
  const s = block.settings;
  const text = useText();
  const { accent } = useStoreTheme();
  const { lang } = useLanguage();
  const img = mediaSrc(s.image);
  const title = text(s.title);
  const subtitle = text(s.subtitle);
  const cta = text(s.cta_label);
  if (!img && !title && !subtitle) return null;
  const linked = hasLink(s.link, data);
  const inset = block.variant === 'inset';
  const words = title || subtitle || (cta && linked);

  const body = (
    <div className={`relative ${HEIGHT[s.height]} overflow-hidden bg-white/[0.03] ${inset ? 'sf-r-lg' : ''}`} lang={lang}>
      {img && <img src={img} alt={title ? '' : store.name} className="absolute inset-0 w-full h-full object-cover" loading="lazy" />}
      {words && s.overlay === 'dim' && <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent" aria-hidden="true" />}
      {words && (
        <div className="absolute inset-x-0 bottom-0 p-4 @min-[40rem]:p-6">
          <div className={inset ? '' : 'sf-col'}>
            {title && (
              <h2 className="sf-display text-white leading-tight [text-wrap:balance]" dir="auto">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="text-zinc-200 text-[13px] leading-snug mt-1 line-clamp-2 max-w-xl" dir="auto">
                {subtitle}
              </p>
            )}
            {cta && linked && (
              <span className={`inline-flex items-center min-h-[40px] px-4 mt-3 rounded-xl font-bold text-[13px] ${accent.btn}`}>{cta}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
  const content = linked ? (
    <LinkTo link={s.link} data={data} className="block active:scale-[0.995] transition-transform">
      {body}
    </LinkTo>
  ) : (
    body
  );
  return inset ? <Column>{content}</Column> : content;
}
