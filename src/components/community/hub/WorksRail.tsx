/**
 * «من أعمال الورش» — finished prints the community's workshops show on their
 * own pages, newest first, each one a door into the shop that made it.
 *
 * It is the one picture of what the community actually MAKES, so it heads the
 * stores directory: before choosing a workshop, a customer sees the work. It
 * is drawn only when there is work to show — an empty rail is not a feature —
 * and a failed read hides it rather than putting an error above a directory
 * that loaded fine.
 */
import { useEffect, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { useRail } from '../../../lib/useRail';
import SafeImage from '../../ui/SafeImage';
import { HubLink, StoreMark } from './parts';
import { loadCommunityWorks } from './useCommunityFeed';
import type { CommunityWork } from './api';

export default function WorksRail() {
  const { loc } = useLanguage();
  const rail = useRail();
  const [works, setWorks] = useState<CommunityWork[] | null>(null);

  useEffect(() => {
    let alive = true;
    loadCommunityWorks()
      .then((w) => {
        if (alive) setWorks(w);
      })
      .catch(() => {
        if (alive) setWorks([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!works || works.length === 0) return null;

  return (
    <section aria-labelledby="community-works-title" data-community-works className="mb-6">
      <h2 id="community-works-title" className="mb-3 text-[15px] font-bold text-white">
        {/* OWNER: Sorani to be written by hand. */}
        {loc('من أعمال الورش', 'From the workshops')}
      </h2>
      <div ref={rail.ref} className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 hide-scrollbar">
        {works.map((w) => (
          <HubLink
            key={w.id}
            href={w.store.url}
            data-community-work={w.id}
            className="group w-[148px] shrink-0 snap-start focus-visible:outline-none sm:w-[168px]"
          >
            <SafeImage
              src={w.imageUrl}
              alt=""
              aspect="auto"
              className="aspect-[4/5] w-full overflow-hidden rounded-2xl border border-zinc-800/60 group-focus-visible:ring-2 group-focus-visible:ring-focus"
              imgClassName="transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none"
            />
            <span dir="auto" className="mt-2 block truncate text-start text-[12.5px] font-medium text-white">
              {w.title}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-400">
              <StoreMark src={w.store.logoUrl} size="xs" />
              <bdi className="truncate">{w.store.name}</bdi>
            </span>
          </HubLink>
        ))}
      </div>
    </section>
  );
}
