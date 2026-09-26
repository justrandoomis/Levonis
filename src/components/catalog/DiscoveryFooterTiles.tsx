import React, { useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Scale, WandSparkles } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { compareHref, compareTray } from '../../lib/compareTray';

/**
 * The explorer's two last doors (§5 item 6): the printer finder and the
 * comparison. Quiet surface tiles — the banners above are the page's moment,
 * these are the "not sure where to start?" exits. The comparison opens with
 * what the tray already holds.
 */
export default function DiscoveryFooterTiles() {
  const { loc } = useLanguage();
  const tray = useSyncExternalStore(compareTray.subscribe, compareTray.getSnapshot, compareTray.getSnapshot);
  const tiles = [
    {
      to: '/printer-finder',
      icon: <WandSparkles aria-hidden="true" className="size-[18px]" />,
      // OWNER: Sorani to be written by hand (the four strings of this file).
      title: loc('ساعدني أختار طابعة', 'Help me choose a printer'),
      body: loc('ستة أسئلة ونرشّح لك ثلاثًا.', 'Six questions, three suggestions.'),
      id: 'finder',
    },
    {
      to: compareHref(tray),
      icon: <Scale aria-hidden="true" className="size-[18px]" />,
      title: loc('قارن الطابعات', 'Compare printers'),
      body: loc('حتى أربع طابعات جنبًا إلى جنب.', 'Up to four printers side by side.'),
      id: 'compare',
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2.5 lg:gap-4">
      {tiles.map((t) => (
        <Link
          key={t.id}
          to={t.to}
          data-discovery-tile={t.id}
          className="group flex min-h-[104px] flex-col gap-1.5 rounded-2xl border border-border-subtle bg-surface p-3.5 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus lg:min-h-[120px] lg:flex-row lg:items-center lg:gap-4 lg:p-5"
        >
          <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-surface-selected text-text-primary lg:size-11">
            {t.icon}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13.5px] font-extrabold leading-[19px] text-text-primary lg:text-[16px] lg:leading-6">{t.title}</span>
            <span className="text-[11.5px] leading-4 text-text-muted lg:text-[13px] lg:leading-5">{t.body}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}
