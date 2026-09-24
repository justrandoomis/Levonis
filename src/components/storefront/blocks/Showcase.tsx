/**
 * SHOWCASE — the workshop on display: finished works, the printers, the
 * materials. Grouped by kind (the classic Showcase tab) or one grid.
 */
import { Hammer, Layers, Printer } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLanguage } from '../../../LanguageContext';
import type { ShowcaseData } from '../../../../packages/storeLayout/src/data';
import { useStorefrontRuntime } from '../runtime';
import { BlockHeading, Column, Loading, useText } from '../parts';
import { useBlockRows } from '../useBlockRows';
import type { BlockProps } from '../types';

type Kind = ShowcaseData['kind'];

export function ShowcaseView({ items, kinds = ['work', 'printer', 'material'] }: { items: ShowcaseData[]; kinds?: readonly Kind[] }) {
  const { loc } = useLanguage();
  const groups: Array<{ kind: Kind; icon: ReactNode; title: string }> = [
    { kind: 'work', icon: <Hammer className="w-3.5 h-3.5" aria-hidden="true" />, title: loc('من أعمالنا', 'Our work', 'لە کارەکانمان') },
    { kind: 'printer', icon: <Printer className="w-3.5 h-3.5" aria-hidden="true" />, title: loc('طابعاتنا', 'Our printers', 'چاپکەرەکانمان') },
    { kind: 'material', icon: <Layers className="w-3.5 h-3.5" aria-hidden="true" />, title: loc('الخامات التي نعمل بها', 'Materials we work with', 'کەرەستەکانمان') },
  ];
  return (
    <div className="space-y-4">
      {groups
        .filter((g) => kinds.includes(g.kind))
        .map((g) => {
          const group = items.filter((i) => i.kind === g.kind);
          if (!group.length) return null;
          return (
            <div key={g.kind}>
              <p className="text-zinc-300 text-[12.5px] font-bold mb-2 flex items-center gap-1.5">
                {g.icon}
                {g.title}
              </p>
              {g.kind === 'work' ? (
                <div className="grid grid-cols-2 gap-2">
                  {group.map((it) => (
                    <WorkTile key={it.id} it={it} />
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {group.map((it) => (
                    <div key={it.id} className="sf-row p-2.5 flex items-center gap-2.5">
                      <div className="w-12 h-12 rounded-lg sf-well overflow-hidden shrink-0 flex items-center justify-center">
                        {it.imageUrl ? <img src={it.imageUrl} alt="" className="w-full h-full object-cover" loading="lazy" /> : g.icon}
                      </div>
                      <div className="min-w-0">
                        <p className="text-white text-[12.5px] font-semibold truncate" dir="ltr">
                          {it.title}
                        </p>
                        {it.details && <p className="text-zinc-500 text-[11px] line-clamp-2">{it.details}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

function WorkTile({ it }: { it: ShowcaseData }) {
  return (
    <div className="sf-row overflow-hidden">
      <div className="aspect-square sf-well">{it.imageUrl && <img src={it.imageUrl} alt={it.title} className="w-full h-full object-cover" loading="lazy" />}</div>
      <div className="p-2">
        <p className="text-white text-[11.5px] font-semibold truncate">{it.title}</p>
        {it.details && <p className="text-zinc-500 text-[10.5px] line-clamp-2">{it.details}</p>}
      </div>
    </div>
  );
}

export default function ShowcaseBlock({ block, data }: BlockProps<'showcase'>) {
  const rt = useStorefrontRuntime();
  const text = useText();
  const rows = useBlockRows(data.showcase, rt.loadShowcase);
  if (rows === null) return <Column><Loading /></Column>;
  const kinds = block.settings.kinds;
  const items = rows.filter((r) => kinds.includes(r.kind)).slice(0, block.settings.limit);
  if (!items.length) return null;
  return (
    <Column>
      <BlockHeading title={text(block.settings.title)} />
      {block.variant === 'grid' ? (
        <div className="grid grid-cols-2 @min-[40rem]:grid-cols-3 gap-2">
          {items.map((it) => (
            <WorkTile key={it.id} it={it} />
          ))}
        </div>
      ) : (
        <ShowcaseView items={items} kinds={kinds} />
      )}
    </Column>
  );
}
