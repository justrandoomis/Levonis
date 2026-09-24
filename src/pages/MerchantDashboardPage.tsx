/**
 * Store administration — `/merchant` on the main site, `/admin` on a storefront.
 *
 * THIS IS NOT THE PLATFORM ADMIN. It talks only to `/api/merchant/*`, every
 * route of which resolves the caller's own store from their session. There is
 * no store id in any request here to swap, and the frontend guard is UX only
 * — the server refuses regardless of what this page renders (§72).
 *
 * READING NEVER STOPS. When PLUS lapses or a store is paused, the merchant
 * keeps every screen: orders, money, reviews, customers. What disappears are
 * the CONTROLS that create new obligations, and each one says why rather than
 * quietly vanishing (§48, §84).
 *
 * THE STORE BUILDER. This workspace is where «التاجر يبني متجره بنفسه»:
 * identity (logo, banner, colour, words), the page design, the shelves
 * (sections), the services a workshop sells, the showcase, coupons, both
 * order books (store products AND funded custom orders), earnings, customers
 * and reviews. Every screen is a working screen backed by its own API —
 * nothing is decorative.
 *
 * SINCE W3-A this page is the route element and the gate; the workspace
 * itself — URL routes, the one nav table, the command palette, the Command
 * Center — is src/components/merchant/shell/. What stays here is what must be
 * decided BEFORE any of it is drawn: is there a store, and is this the right
 * host for it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Store } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { merchantApi, type MerchantMe } from '../lib/merchant';
import { useStore } from '../StoreContext';
import MerchantShell from '../components/merchant/shell/MerchantShell';
import { onOwnHost } from '../components/merchant/shell/ownHost';

export default function MerchantDashboardPage() {
  const { loc } = useLanguage();
  const { store: hostStore, unknownStore: hostUnknown, unavailableStore: hostUnavailable } = useStore();
  const [me, setMe] = useState<MerchantMe | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    merchantApi
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(reload, [reload]);

  if (loading) {
    return (
      <div className="flex h-[100dvh] w-full flex-1 bg-canvas" role="status" aria-busy="true" aria-label={loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}>
        <div aria-hidden="true" className="hidden w-[72px] shrink-0 border-e border-border-subtle bg-surface sm:block lg:w-64" />
        <div aria-hidden="true" className="flex-1">
          <div className="h-16 border-b border-border-subtle" />
        </div>
      </div>
    );
  }

  // No store yet: point at the one thing that fixes it.
  if (!me?.store) {
    return (
      <div className="flex h-[100dvh] w-full flex-1 items-center justify-center bg-canvas px-6">
        <div className="max-w-sm text-center">
          <Store aria-hidden="true" className="mx-auto mb-4 h-10 w-10 text-text-muted" />
          <h1 className="mb-2 text-lg font-bold text-text-primary">
            {loc('ليس لديك متجر بعد', 'You do not have a store yet', 'هێشتا فرۆشگات نییە')}
          </h1>
          <Link to={me?.eligible ? '/merchant/start' : '/subscription'} className="lv-button lv-button-primary mt-4">
            {me?.eligible
              ? loc('أنشئ متجرك', 'Create your store', 'فرۆشگاکەت دروست بکە')
              : loc('اشترك في PLUS', 'Subscribe to PLUS', 'بەشداری PLUS بکە')}
            <ArrowRight aria-hidden="true" className="h-4 w-4 rtl:rotate-180" />
          </Link>
        </div>
      </div>
    );
  }

  // Any of the three means StorefrontApp is serving this page: the workspace lives under /admin here.
  const storeHost = !!hostStore || hostUnknown || hostUnavailable;
  if (!onOwnHost(me.store, { storeId: hostStore?.id ?? null, storeHost }, window.location.host)) {
    const ownAdmin = /^https?:\/\//.test(me.store.url) ? `${me.store.url}/admin` : '/merchant';
    return (
      <div className="flex h-[100dvh] w-full flex-1 items-center justify-center bg-canvas px-6" data-not-your-store>
        <div className="max-w-sm text-center">
          <Store className="mx-auto mb-4 h-10 w-10 text-text-muted" aria-hidden="true" />
          <h1 className="mb-2 text-[17px] font-bold text-text-primary [text-wrap:balance]">
            {loc('هذه لوحة إدارة متجر آخر', 'This is another store\'s dashboard')}
            {/* OWNER: Sorani to be written by hand. */}
          </h1>
          <p className="text-[13px] leading-relaxed text-text-muted">
            {loc('لوحة متجرك على عنوان متجرك.', 'Your store\'s dashboard is on your store\'s own address.')}
            {/* OWNER: Sorani to be written by hand. */}
          </p>
          <a href={ownAdmin} className="lv-button lv-button-primary mt-6 w-full">
            {loc('افتح لوحة متجري', 'Open my store dashboard')}
            {/* OWNER: Sorani to be written by hand. */}
          </a>
        </div>
      </div>
    );
  }

  return (
    <MerchantShell
      me={me}
      reloadMe={reload}
      onStoreHost={storeHost}
      mainOrigin={me.root_domain ? `https://${me.root_domain}` : null}
    />
  );
}
