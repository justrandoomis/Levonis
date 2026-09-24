/**
 * FAQ — questions and answers as disclosure rows. Native <details>/<summary>:
 * keyboard, screen reader and «find in page» all work, with no script.
 */
import { ChevronDown } from 'lucide-react';
import { BlockHeading, Column, useText } from '../parts';
import { Paragraphs } from './Text';
import type { BlockProps } from '../types';

export default function FaqBlock({ block }: BlockProps<'faq'>) {
  const text = useText();
  const items = block.settings.items.filter((it) => text(it.q) && text(it.a));
  if (!items.length) return null;
  return (
    <Column>
      <BlockHeading title={text(block.settings.title)} />
      <div className="space-y-2">
        {items.map((it, i) => (
          <details key={i} className="sf-row group">
            <summary className="list-none cursor-pointer min-h-[48px] px-3.5 py-3 flex items-center justify-between gap-3 text-zinc-100 text-[13px] font-semibold [&::-webkit-details-marker]:hidden">
              <span dir="auto">{text(it.q)}</span>
              <ChevronDown className="w-4 h-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <Paragraphs text={text(it.a)} className="px-3.5 pb-3.5 text-zinc-400 text-[12.5px] leading-relaxed" />
          </details>
        ))}
      </div>
    </Column>
  );
}
