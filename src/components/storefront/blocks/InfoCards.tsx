/**
 * INFO CARDS — `store`: the three the merchant arranged in settings, with the
 * honest fallback (location, coverage, delivery) until they do; `custom`: up to
 * six the layout holds, each an icon from the closed set, a title and a line.
 */
import { WidgetIcon } from '../../merchant/profileIcons';
import { useLanguage } from '../../../LanguageContext';
import { Column, factsWithFallback, useText } from '../parts';
import type { BlockProps } from '../types';

export default function InfoCardsBlock({ block, store }: BlockProps<'info_cards'>) {
  const { loc, lang } = useLanguage();
  const text = useText();
  const cards =
    block.settings.source === 'custom'
      ? block.settings.items.map((it) => ({ icon: it.icon as string, title: text(it.title), subtitle: text(it.subtitle) })).filter((c) => c.title)
      : factsWithFallback(store, loc, lang).map((w) => ({ icon: w.icon, title: w.title, subtitle: w.subtitle ?? '' }));
  if (!cards.length) return null;
  const grid = block.variant === 'grid' ? 'grid-cols-2 @min-[40rem]:grid-cols-3' : cards.length === 1 ? 'grid-cols-1' : cards.length === 2 ? 'grid-cols-2' : 'grid-cols-3';
  return (
    <Column>
      <div dir="rtl" className={`grid gap-3 ${grid}`}>
        {cards.map((w, i) => (
          <div key={i} className="sf-fact px-2 py-2.5 flex items-center justify-center gap-2 min-w-0">
            <WidgetIcon name={w.icon} className="w-4 h-4 shrink-0 text-zinc-400" />
            <div className="min-w-0">
              <p className="text-zinc-100 text-[12.5px] font-medium truncate leading-tight" dir="auto">
                {w.title}
              </p>
              {w.subtitle && (
                <p className="text-zinc-500 text-[11px] truncate leading-tight" dir="auto">
                  {w.subtitle}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </Column>
  );
}
