/**
 * SERVICES — what the workshop sells beyond products: «starting from» prices
 * that are honest floors, not quotes. Under the list, the host's real doors:
 * a quote through the request board (escrow-protected) or a chat.
 */
import { Hammer, Layers, Printer } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { iqd } from '../../../lib/merchant';
import type { ServiceData } from '../../../../packages/storeLayout/src/data';
import { useStorefrontRuntime } from '../runtime';
import { BlockHeading, Column, Loading, useText } from '../parts';
import { useBlockRows } from '../useBlockRows';
import type { BlockProps } from '../types';

const SERVICE_KIND_META: Record<string, { icon: ReactNode; ar: string; en: string; ckb: string }> = {
  print_service: { icon: <Printer className="w-3 h-3" aria-hidden="true" />, ar: 'طباعة حسب الطلب', en: 'Print on demand', ckb: 'چاپ بەپێی داوا' },
  design: { icon: <Hammer className="w-3 h-3" aria-hidden="true" />, ar: 'تصميم ونمذجة', en: 'Design & modelling', ckb: 'دیزاین' },
  finishing: { icon: <Layers className="w-3 h-3" aria-hidden="true" />, ar: 'تشطيب ومعالجة', en: 'Finishing', ckb: 'تەواوکاری' },
  scanning: { icon: <Layers className="w-3 h-3" aria-hidden="true" />, ar: 'مسح ثلاثي الأبعاد', en: '3D scanning', ckb: 'سکانی 3D' },
  repair: { icon: <Hammer className="w-3 h-3" aria-hidden="true" />, ar: 'صيانة وإصلاح', en: 'Repair', ckb: 'چاککردنەوە' },
  other: { icon: <Hammer className="w-3 h-3" aria-hidden="true" />, ar: 'خدمة', en: 'Service', ckb: 'خزمەتگوزاری' },
};

function ServiceCard({ s }: { s: ServiceData }) {
  const { loc } = useLanguage();
  const meta = SERVICE_KIND_META[s.kind] ?? SERVICE_KIND_META.other;
  return (
    <div className="sf-card overflow-hidden">
      {s.imageUrl && (
        <div className="aspect-[3/1] sf-well">
          <img src={s.imageUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        </div>
      )}
      <div className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/10 text-zinc-300">
            {meta.icon}
            {loc(meta.ar, meta.en, meta.ckb)}
          </span>
        </div>
        <p className="text-white text-[13.5px] font-bold">{s.title}</p>
        {s.description && <p className="text-zinc-400 text-[12px] leading-relaxed mt-1 whitespace-pre-wrap">{s.description}</p>}
        {s.materials.length > 0 && (
          <div className="flex gap-1 flex-wrap mt-2">
            {s.materials.map((m) => (
              <span key={m} className="text-[10px] px-2 py-0.5 rounded-full bg-black/40 border border-white/10 text-zinc-400" dir="ltr">
                {m}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 mt-2.5">
          <span className="text-[12.5px] font-bold text-gold" dir="ltr">
            {s.price_from_iqd !== null
              ? `${loc('يبدأ من', 'From', 'لە')} ${iqd(s.price_from_iqd)}${s.price_unit ? ` / ${s.price_unit}` : ''}`
              : loc('السعر حسب الطلب', 'Quoted per job', 'نرخ بەپێی داوا')}
          </span>
        </div>
      </div>
    </div>
  );
}

export function ServicesView({ services, accepts, doors = true, grid = false }: { services: ServiceData[]; accepts: boolean; doors?: boolean; grid?: boolean }) {
  const rt = useStorefrontRuntime();
  return (
    <div className="space-y-3">
      <div className={grid ? 'grid gap-3 @min-[40rem]:grid-cols-2' : 'space-y-3'}>
        {services.map((s) => (
          <ServiceCard key={s.id} s={s} />
        ))}
      </div>
      {doors && <rt.ServiceDoors accepts={accepts} />}
    </div>
  );
}

export default function ServicesBlock({ block, store, data }: BlockProps<'services'>) {
  const rt = useStorefrontRuntime();
  const text = useText();
  const rows = useBlockRows(data.services, rt.loadServices);
  if (rows === null) return <Column><Loading /></Column>;
  if (!rows.length) return null;
  return (
    <Column>
      <BlockHeading title={text(block.settings.title)} />
      <ServicesView
        services={rows.slice(0, block.settings.limit)}
        accepts={!!store.accepts_custom_requests}
        doors={block.settings.show_doors}
        grid={block.variant === 'grid'}
      />
    </Column>
  );
}
