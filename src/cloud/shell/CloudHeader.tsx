/**
 * PRINT CLOUD'S HEADER — the «Levonis» wordmark with its small «Print Cloud»
 * label, the four sections as a pill on a wide screen (a phone has the tab
 * bar), and at the inline end: language and theme (the house globe and its
 * sheet), the Levonis wallet, and the account.
 *
 * Solid clay on the page's own ground — no glass (docs/DECISIONS.md row
 * 208). It does not scroll: the page scrolls under it inside the shell.
 * While the service is closed to this viewer the sections are not offered
 * (every one of them would answer «not open yet»); a signed-out visitor can
 * still sign in, which is how an admin reaches the preview.
 */
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import LangThemeButton from '../../components/LangThemeSheet';
import { IconButton } from '../../components/ui/Button';
import { initialOf } from '../../lib/initials';
import { BRAND, PRODUCT } from '../brand';
import { useCloud } from '../CloudContext';
import { activeTab, TABS, type CloudTab } from '../routes';
import { header, nav } from '../strings/common';
import { useCloudText } from '../text';
import { Box, House, ShoppingBag, User, Wallet } from '../ui/icons';
import { WalletSheet } from './WalletSheet';

export const TAB_ICONS: Record<CloudTab, typeof House> = { home: House, print: Box, store: ShoppingBag, account: User };

/** The sections as one pill (wide screens): a well with a raised thumb under the current one. */
function PillNav() {
  const { t } = useCloudText();
  const { pathname } = useLocation();
  const current = activeTab(pathname);
  return (
    <nav aria-label={t(nav.sections)} className="hidden md:block">
      <ul className="flex items-center gap-1 rounded-full border border-border-subtle p-1 lv-well">
        {TABS.map((tab) => {
          const Icon = TAB_ICONS[tab.id];
          const active = tab.id === current;
          return (
            <li key={tab.id}>
              <Link
                to={tab.to}
                aria-current={active ? 'page' : undefined}
                className={`relative flex min-h-11 items-center rounded-full px-4 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                  active ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {active ? <span aria-hidden="true" className="absolute inset-0 rounded-full border border-border-subtle bg-surface-raised shadow-1" /> : null}
                <span className="relative flex items-center gap-2">
                  <Icon aria-hidden="true" className="h-4 w-4" />
                  {t(tab.label)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function CloudHeader({ full }: { full: boolean }) {
  const { t } = useCloudText();
  const cloud = useCloud();
  const location = useLocation();
  const [walletOpen, setWalletOpen] = useState(false);
  const initial = initialOf(cloud.user?.username || cloud.user?.name);

  return (
    <header className="shrink-0 border-b border-border-subtle">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
        <Link
          to="/"
          aria-label={t(nav.home_link)}
          className="flex min-w-0 items-baseline gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span dir="ltr" className="text-2xl font-extrabold tracking-tight text-text-primary">
            {BRAND}
          </span>
          <span dir="ltr" className="truncate text-[11px] font-bold uppercase tracking-wide text-text-muted">
            {PRODUCT}
          </span>
        </Link>

        {full ? <PillNav /> : null}

        <div className="flex shrink-0 items-center gap-1">
          <LangThemeButton variant="dash" />
          {full && cloud.signedIn ? (
            <IconButton variant="secondary" label={t(header.wallet)} icon={<Wallet aria-hidden="true" className="h-[18px] w-[18px]" />} onClick={() => setWalletOpen(true)} />
          ) : null}
          {cloud.signedIn ? (
            full ? (
              <Link
                to="/account"
                aria-label={t(header.account)}
                title={t(header.account)}
                className="flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-full bg-olive text-sm font-bold text-snow shadow-1">
                  {initial || <User className="h-4 w-4" />}
                </span>
              </Link>
            ) : null
          ) : cloud.authReady ? (
            <Link to="/auth" state={{ from: location.pathname + location.search }} className="lv-button lv-button-secondary lv-button-sm">
              {t(header.signIn)}
            </Link>
          ) : null}
        </div>
      </div>
      {full && cloud.signedIn ? <WalletSheet open={walletOpen} onClose={() => setWalletOpen(false)} /> : null}
    </header>
  );
}
