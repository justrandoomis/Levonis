/**
 * THE PHONE'S FOUR TABS — Home, Print, Store, Account — floating over the
 * bottom edge, the shop's own nav grammar (src/components/BottomNav.tsx):
 * an opaque clay pod (`material`, no glass), the current tab a DIMPLE pressed
 * into it (the well fill and the press shadow) with the gold notch as its
 * second cue, one label weight in both states so a Sorani label never
 * reflows the pod. Wide screens have the header's pill instead.
 *
 * The shell reserves its height at the end of the scroller (`nav-clearance`)
 * and the toasts sit above it (`ToasterGate aboveNav`), as on the shop.
 */
import { Link, useLocation } from 'react-router-dom';
import { activeTab, TABS } from '../routes';
import { nav } from '../strings/common';
import { useCloudText } from '../text';
import { TAB_ICONS } from './CloudHeader';

export function CloudTabBar() {
  const { t, dir } = useCloudText();
  const { pathname } = useLocation();
  const current = activeTab(pathname);
  return (
    <nav
      aria-label={t(nav.sections)}
      data-cloud-tabs
      className="fixed inset-x-0 bottom-[max(0.625rem,env(safe-area-inset-bottom))] z-[120] flex justify-center px-3 pointer-events-none md:hidden"
    >
      <ul className="material pointer-events-auto flex h-16 w-full max-w-md items-center gap-0.5 rounded-2xl border border-border-subtle p-1.5 shadow-lg">
        {TABS.map((tab) => {
          const Icon = TAB_ICONS[tab.id];
          const active = tab.id === current;
          return (
            <li key={tab.id} className="h-full min-w-0 flex-1">
              <Link
                to={tab.to}
                dir={dir}
                aria-current={active ? 'page' : undefined}
                data-clay-dimple={active || undefined}
                className={`relative flex h-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 transition-[color,background-color,opacity,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus active:scale-[0.98] ${
                  active ? 'bg-[var(--clay-well-bg)] shadow-press text-text-primary' : 'text-text-muted hover:bg-white/[0.04] hover:text-text-secondary'
                }`}
              >
                {active ? (
                  <span aria-hidden="true" className="absolute start-1/2 top-0 h-0.5 w-5 -translate-x-1/2 rtl:translate-x-1/2 rounded-full bg-gold" />
                ) : null}
                <Icon aria-hidden="true" className="h-[22px] w-[22px]" strokeWidth={active ? 1.9 : 1.55} />
                <span className="max-w-full truncate text-[10px] font-medium">{t(tab.label)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
