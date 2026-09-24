/**
 * PRINTERS — the workshop's machines as the merchant registered them: what
 * they can make (technology, build volume, materials, multi-colour, enclosure),
 * never what they cost to run.
 */
import { Box, Printer } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { BlockHeading, Column, useText } from '../parts';
import type { BlockProps } from '../types';

export default function PrintersBlock({ block, data }: BlockProps<'printers'>) {
  const s = block.settings;
  const { loc, lang } = useLanguage();
  const text = useText();
  const printers = (data.printers ?? []).slice(0, s.limit);
  if (!printers.length) return null;
  const list = block.variant === 'list';
  return (
    <Column>
      <BlockHeading title={text(s.title) || loc('طابعاتنا', 'Our printers', 'چاپکەرەکانمان')} />
      <div className={list ? 'space-y-2' : 'grid gap-2.5 @min-[40rem]:grid-cols-2'}>
        {printers.map((p) => (
          <div key={p.id} className="sf-card sf-card-pad">
            <div className="flex items-start gap-2.5">
              <div className="w-10 h-10 rounded-lg sf-well flex items-center justify-center shrink-0">
                <Printer className="w-5 h-5 text-zinc-400" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-white text-[13px] font-bold truncate" dir="auto">
                  {p.name}
                </p>
                <p className="text-zinc-500 text-[11.5px] truncate" dir="ltr">
                  {[p.brand, p.model].filter(Boolean).join(' ') || (p.technology === 'resin' ? 'Resin' : 'FDM')}
                </p>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/10 text-zinc-300 shrink-0" translate="no">
                {p.technology === 'resin' ? 'Resin' : 'FDM'}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2.5 text-[10.5px]">
              {p.build_mm.every((n) => n > 0) && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/40 border border-white/10 text-zinc-300" dir="ltr">
                  <Box className="w-3 h-3" aria-hidden="true" />
                  {p.build_mm.join(' × ')} mm
                </span>
              )}
              {p.multicolor && <span className="px-2 py-0.5 rounded-full bg-black/40 border border-white/10 text-zinc-300">{loc('متعدد الألوان', 'Multi-colour')}</span>}
              {p.enclosed && <span className="px-2 py-0.5 rounded-full bg-black/40 border border-white/10 text-zinc-300">{loc('مغلقة', 'Enclosed')}</span>}
            </div>
            {s.show_materials && p.materials.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {p.materials.map((m) => (
                  <span key={m.id} className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-zinc-400" dir="ltr">
                    {lang === 'en' ? m.name_en : m.name_ar || m.name_en}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {/* OWNER: Sorani to be written by hand. */}
    </Column>
  );
}
