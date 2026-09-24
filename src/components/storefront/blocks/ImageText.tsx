/**
 * IMAGE + TEXT — a picture beside a heading and a few paragraphs, the picture
 * on the start or end side (it follows the writing direction). Stacked on a
 * narrow page.
 */
import { mediaSrc } from '../../../../packages/storeLayout/src/refs';
import { useStoreTheme } from '../StoreTheme';
import { Column, hasLink, LinkTo, useText } from '../parts';
import { Paragraphs } from './Text';
import type { BlockProps } from '../types';

export default function ImageTextBlock({ block, data }: BlockProps<'image_text'>) {
  const s = block.settings;
  const text = useText();
  const { accent } = useStoreTheme();
  const img = mediaSrc(s.image);
  const title = text(s.title);
  const body = text(s.body);
  const cta = text(s.cta_label);
  if (!img && !title && !body) return null;
  return (
    <Column>
      <div className="grid gap-4 @min-[40rem]:grid-cols-2 @min-[40rem]:items-center">
        {img && (
          <div className={`sf-r-lg overflow-hidden sf-well aspect-[4/3] ${block.variant === 'image_end' ? '@min-[40rem]:order-last' : ''}`}>
            <img src={img} alt="" className="w-full h-full object-cover" loading="lazy" />
          </div>
        )}
        <div className="min-w-0">
          {title && (
            <h2 className="sf-title text-white mb-2 [text-wrap:balance]" dir="auto">
              {title}
            </h2>
          )}
          <Paragraphs text={body} className="text-zinc-300 text-[13px] leading-relaxed" />
          {cta && hasLink(s.link, data) && (
            <LinkTo link={s.link} data={data} className={`inline-flex items-center min-h-[44px] px-5 mt-3 rounded-xl font-bold text-[13px] ${accent.btn}`}>
              {cta}
            </LinkTo>
          )}
        </div>
      </div>
    </Column>
  );
}
