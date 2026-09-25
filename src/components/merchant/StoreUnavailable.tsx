/**
 * «المتجر غير متاح حاليًا» — the whole page of a store under an admin sanction.
 *
 * OWNER DECISION (2026-09-24, docs/MERCHANT_PLATFORM.md §2): a customer on an
 * admin-suspended store sees only this — «Products, banner and bio are not
 * served». The server enforces it (every `/api/storefront/*` read answers
 * `STORE_UNAVAILABLE` and carries nothing of the shop), so this page has no
 * store data to show even if it wanted to: no name, no logo, no reason. A
 * visitor is never told WHY a shop is unavailable — that is between the
 * merchant and Levonis (§51).
 *
 * TWO WAYS OUT, because a page with nothing on it must not be a dead end: the
 * platform's own front door (from the server's root domain, never a domain
 * typed into the bundle), and «طلباتي» — a customer with an order from this
 * shop keeps it, and this is where it lives.
 */
import { Link } from 'react-router-dom';
import { Store } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useStore } from '../../StoreContext';

export default function StoreUnavailable() {
  const { loc } = useLanguage();
  const { store: hostStore, unavailableStore, mainSite } = useStore();
  // On a store's own host the platform is another origin; on the main site
  // (the in-app `/community/store/:slug` route) it is this one.
  const onStoreHost = unavailableStore || !!hostStore;
  const home = onStoreHost && mainSite ? `${mainSite}/` : '/';

  return (
    <main
      data-store-unavailable
      className="min-h-[100dvh] bg-black flex items-center justify-center px-6 py-12"
    >
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-5 w-14 h-14 rounded-full bg-white/[0.04] border border-white/10 flex items-center justify-center">
          <Store className="w-6 h-6 text-zinc-500" strokeWidth={1.5} aria-hidden="true" />
        </div>
        <h1 className="text-white text-[17px] font-bold leading-snug [text-wrap:balance]">
          {loc('المتجر غير متاح حاليًا', 'This store is not available right now')}
          {/* OWNER: Sorani to be written by hand. */}
        </h1>
        <p className="mt-2 text-zinc-500 text-[13px] leading-relaxed [text-wrap:pretty]">
          {loc(
            'إن كان لديك طلب من هذا المتجر فهو محفوظ في «طلباتي».',
            'If you have an order from this store, it is kept in My orders.'
          )}
          {/* OWNER: Sorani to be written by hand. */}
        </p>
        <div className="mt-6 flex flex-col gap-2.5">
          {onStoreHost ? (
            <a href={home} className="lv-button lv-button-primary w-full" translate="no">
              LEVONIS
            </a>
          ) : (
            <Link to="/" className="lv-button lv-button-primary w-full" translate="no">
              LEVONIS
            </Link>
          )}
          <Link to="/orders" className="lv-button lv-button-ghost w-full">
            {loc('طلباتي', 'My orders', 'داواکاریەکانم')}
          </Link>
        </div>
      </div>
    </main>
  );
}
