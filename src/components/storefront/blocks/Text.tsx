/**
 * TEXT — a heading and paragraphs. The body is PLAIN TEXT: a blank line starts
 * a paragraph and a line break is kept; nothing is parsed as markup, so a
 * merchant's `<b>` shows as the three characters they typed.
 */
import { BlockHeading, Column, useText } from '../parts';
import type { BlockProps } from '../types';

export function Paragraphs({ text, className = '' }: { text: string; className?: string }) {
  if (!text) return null;
  return (
    <div className={`space-y-2 ${className}`}>
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i} className="whitespace-pre-line" dir="auto">
          {p}
        </p>
      ))}
    </div>
  );
}

export default function TextBlock({ block }: BlockProps<'text'>) {
  const s = block.settings;
  const text = useText();
  const title = text(s.title);
  const body = text(s.body);
  if (!title && !body) return null;
  const center = s.align === 'center';
  const inner = (
    <div className={center ? 'text-center mx-auto max-w-2xl' : 'max-w-3xl'}>
      {title && <BlockHeading title={title} />}
      <Paragraphs text={body} className="text-zinc-300 text-[13.5px] leading-relaxed" />
    </div>
  );
  return <Column>{block.variant === 'callout' ? <div className="sf-card sf-card-pad">{inner}</div> : inner}</Column>;
}
