import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Layers, ShieldCheck, Wrench, Package, Users, Gift } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { STUDIO_URL } from '../../translations';

/**
 * What LEVONIS does besides sell boxes.
 *
 * EVERY CARD POINTS AT A PAGE THAT EXISTS. This is a storefront promise, so
 * nothing here is aspirational: each route below is registered in App.tsx and
 * already works. If a service is ever removed, its card goes with it rather
 * than becoming a dead link.
 *
 * The Studio card is written out as a LITERAL `<a href={STUDIO_URL}>` rather
 * than looped with the rest. That is deliberate: tests/store-isolation.test.ts
 * greps for exactly that anchor, and a link hidden behind an array entry would
 * pass review while silently becoming a router <Link> or growing a
 * target="_blank". The entry is a PLAIN full-page navigation to the standalone
 * subdomain — no iframe, no prefetch, no Studio code in this bundle
 * (docs/STUDIO_PLAN.md decision 6).
 */

const CARD_BASE =
  'group flex items-center gap-3.5 rounded-2xl border p-4 min-h-[88px] transition-colors min-w-0';
const CARD_PLAIN = 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-600';
const CARD_FEATURED =
  'bg-gradient-to-br from-olive/20 to-zinc-900/60 border-olive/40 hover:border-olive/70';

function CardBody({
  icon: Icon,
  title,
  desc,
  featured,
}: {
  icon: React.ElementType;
  title: string;
  desc: string;
  featured?: boolean;
}) {
  const { dir } = useLanguage();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <>
      <div
        className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border ${
          featured ? 'bg-olive/25 border-olive/50' : 'bg-zinc-800/70 border-zinc-700/60'
        }`}
      >
        <Icon aria-hidden="true" className={`w-6 h-6 ${featured ? 'text-olive-light' : 'text-zinc-300'}`} />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-white font-bold text-sm mb-0.5 line-clamp-2">{title}</h3>
        <p className="text-xs text-zinc-400 line-clamp-2">{desc}</p>
      </div>
      <Chevron aria-hidden="true" className={`w-4 h-4 shrink-0 ${featured ? 'text-olive-light' : 'text-zinc-500'}`} />
    </>
  );
}

export default function ServicesGrid() {
  const { t } = useLanguage();

  const inApp: Array<{ id: string; to: string; title: string; desc: string; icon: React.ElementType }> = [
    { id: 'warranty', to: '/warranty', title: t('svcWarrantyTitle'), desc: t('svcWarrantyDesc'), icon: ShieldCheck },
    { id: 'tools', to: '/tools', title: t('svcToolsTitle'), desc: t('svcToolsDesc'), icon: Wrench },
    { id: 'bundles', to: '/bundles', title: t('svcBundlesTitle'), desc: t('svcBundlesDesc'), icon: Package },
    { id: 'community', to: '/community', title: t('svcCommunityTitle'), desc: t('svcCommunityDesc'), icon: Users },
    { id: 'rewards', to: '/points', title: t('svcRewardsTitle'), desc: t('svcRewardsDesc'), icon: Gift },
  ];

  return (
    <section data-home-section="services" className="mb-12">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-1 h-6 bg-olive rounded-full" />
        <h2 className="text-xl md:text-2xl font-bold text-white">{t('services')}</h2>
      </div>

      {/* One column on a phone, two on a tablet, three on a wide screen —
          §1's responsive grid, with min-w-0 so a long Kurdish title wraps
          instead of widening the row. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <a href={STUDIO_URL} data-service="studio" className={`${CARD_BASE} ${CARD_FEATURED}`}>
          <CardBody icon={Layers} title={t('studioCardTitle')} desc={t('studioCardSubtitle')} featured />
        </a>

        {inApp.map((s) => (
          <Link key={s.id} to={s.to} data-service={s.id} className={`${CARD_BASE} ${CARD_PLAIN}`}>
            <CardBody icon={s.icon} title={s.title} desc={s.desc} />
          </Link>
        ))}
      </div>
    </section>
  );
}
