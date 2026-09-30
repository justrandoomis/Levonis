/**
 * THE DOCK — the four doors a shop owner opens every day (merchant platform
 * v2 §3.2 «افعل الآن»): a new product, a reel, the cover, the design. A row
 * of chips that scrolls on a phone and sits in the side column on a desk.
 *
 * The reel door is Levo Community's composer, so it appears only when GET
 * /api/community/access says this person may enter (rule 13 of the community
 * plan: never a door the other side would refuse). Read-only use of the gate:
 * a failed or slow answer simply means no reel door this visit.
 */
import { useEffect, useState } from 'react';
import { Clapperboard, Image, Palette, Plus } from 'lucide-react';
import { api } from '../../../lib/api';
import { merchantHref } from '../../../lib/merchantRoutes';
import { Door } from './PulseRow';
import { useCounterStrings } from './strings';

/** The community composer the reel door opens (src/App.tsx). */
export const REEL_COMPOSER_PATH = '/community/projects/new';

export default function QuickDock() {
  const s = useCounterStrings();
  const [reel, setReel] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<{ success: true; may_enter: boolean }>('/api/community/access')
      .then((r) => {
        if (alive) setReel(!!r.may_enter);
      })
      .catch(() => {
        /* no door this visit */
      });
    return () => {
      alive = false;
    };
  }, []);

  const doors: Array<{ id: string; to: string; icon: typeof Plus; label: string }> = [
    { id: 'new-product', to: merchantHref.newProduct(), icon: Plus, label: s.dock.newProduct },
    ...(reel ? [{ id: 'reel', to: REEL_COMPOSER_PATH, icon: Clapperboard, label: s.dock.reel }] : []),
    { id: 'cover', to: merchantHref.storeSettings(), icon: Image, label: s.dock.cover },
    { id: 'design', to: merchantHref.storeDesign(), icon: Palette, label: s.dock.design },
  ];

  return (
    <section aria-labelledby="cc-dock" className="space-y-3">
      <h2 id="cc-dock" className="text-[15px] font-bold text-text-primary">
        {s.dock.title}
      </h2>
      {/* Edge to edge on a phone only (the row scrolls under the 16 px gutter);
          from `sm` up it is a row inside its column — `bleed-x` is the viewport
          bleed and would cross the side column on a desk. In the 340 px side
          column at `lg` the four doors WRAP: a hidden scrollbar there left the
          fourth door clipped with no way to reach it by mouse (§3.2). */}
      <nav aria-label={s.dock.title} data-quick-dock className="-mx-4 flex gap-2 overflow-x-auto px-4 hide-scrollbar sm:mx-0 sm:px-0 lg:flex-wrap lg:overflow-visible">
        {doors.map((d) => {
          const Icon = d.icon;
          return (
            <Door key={d.id} to={d.to} className="lv-button lv-button-secondary lv-button-sm press-scale shrink-0" data-dock={d.id}>
              <Icon aria-hidden="true" className="h-4 w-4" />
              {d.label}
            </Door>
          );
        })}
      </nav>
    </section>
  );
}
