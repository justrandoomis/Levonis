/**
 * «المزيد» — on a phone, every destination the four bottom tabs do not open,
 * grouped as the sidebar groups them (the same nav table, ./nav.ts). A sheet
 * that drags from its handle only (ui/Sheet v2), so the list inside scrolls
 * freely. Its own chunk: only a phone ever opens it.
 */
import { Link } from 'react-router-dom';
import { useLanguage } from '../../../LanguageContext';
import { Sheet } from '../../ui/Sheet';
import type { MerchantSection } from '../../../lib/merchantRoutes';
import { badgeCount, moreEntries, navGroups, sectionPath } from './nav';
import { W, say } from './strings';
import type { Attention } from './attention';

export default function MoreSheet({
  open,
  onClose,
  base,
  current,
  attention,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  current: MerchantSection | null;
  attention: Attention | null;
}) {
  const { loc } = useLanguage();
  const groups = navGroups(moreEntries());
  const title = say(loc, W.more);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={title}
      detents={['medium', 'large']}
      defaultDetent="large"
      header={<h2 className="px-4 pb-2 text-[15px] font-bold text-text-primary">{title}</h2>}
      testId="merchant-more-sheet"
    >
      <nav aria-label={title} className="px-2 pb-4">
        {groups.map((g) => (
          <div key={g.id} className="pt-2">
            {g.label && <p className="px-3 pb-1 text-[12px] font-medium text-text-muted">{say(loc, g.label)}</p>}
            <ul>
              {g.entries.map((e) => {
                const count = badgeCount(e.badge, attention);
                const active = current === e.id;
                return (
                  <li key={e.id}>
                    <Link
                      to={sectionPath(e.id, base)}
                      onClick={onClose}
                      aria-current={active ? 'page' : undefined}
                      data-nav={e.id}
                      className={`flex min-h-12 items-center gap-3 rounded-lg px-3 text-[14.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                        active ? 'bg-surface-selected text-text-primary' : 'text-text-secondary'
                      }`}
                    >
                      <e.icon aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                      <span className="min-w-0 flex-1 truncate">{say(loc, e.label)}</span>
                      {count ? (
                        <span className="rounded-full bg-white/[0.08] px-2 text-[12px] font-semibold leading-6 tabular-nums text-text-primary" dir="ltr">
                          {count > 99 ? '99+' : count}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </Sheet>
  );
}
