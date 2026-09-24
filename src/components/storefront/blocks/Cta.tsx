/** CALL TO ACTION — a heading, a line and one button to a real destination. No destination, no button. */
import { useStoreTheme } from '../StoreTheme';
import { Column, hasLink, LinkTo, useText } from '../parts';
import { Paragraphs } from './Text';
import type { BlockProps } from '../types';

export default function CtaBlock({ block, data }: BlockProps<'cta'>) {
  const s = block.settings;
  const text = useText();
  const { accent } = useStoreTheme();
  const title = text(s.title);
  const body = text(s.body);
  const label = text(s.label);
  const linked = !!label && hasLink(s.link, data);
  if (!title && !body && !linked) return null;
  const center = s.align === 'center';
  return (
    <Column>
      <div className={`sf-card p-5 ${center ? 'text-center' : ''} ${block.variant === 'accent' ? `border-2 ${accent.ring}` : ''}`}>
        {title && (
          <h2 className="sf-title text-white [text-wrap:balance]" dir="auto">
            {title}
          </h2>
        )}
        <Paragraphs text={body} className={`text-zinc-400 text-[13px] leading-relaxed mt-1.5 ${center ? 'mx-auto max-w-xl' : ''}`} />
        {linked && (
          <LinkTo link={s.link} data={data} className={`inline-flex items-center justify-center min-h-[44px] px-5 mt-4 rounded-xl font-bold text-[13px] ${accent.btn} active:scale-[0.98] transition-transform`}>
            {label}
          </LinkTo>
        )}
      </div>
    </Column>
  );
}
