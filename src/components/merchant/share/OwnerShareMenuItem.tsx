/**
 * «رمز QR وبطاقة المتجر» — one extra row in the storefront's «…» menu, for
 * the store's OWNER and nobody else.
 *
 * OWNERSHIP IS THE SERVER'S ANSWER. The row asks `GET /api/merchant/store/share`
 * — which resolves the store from the SESSION (`requireStoreOwner`) — and
 * shows itself only when the store that answers is the store on screen. A
 * signed-out visitor never asks; a signed-in customer, or a merchant looking
 * at someone else's shop, gets a 404 or another store's id and sees nothing.
 * It asks when the menu opens, never on page load: a customer's first view of
 * a storefront pays nothing for it.
 *
 * THE WINDOW OUTLIVES THE ROW. The menu unmounts its rows when it closes, so
 * the row keeps the menu open while the window is up and lets it close (via
 * `onDone`) only after the window's own exit has played. The heavy half —
 * the panel and the QR encoder — is a lazy chunk.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { useAuth } from '../../../AuthContext';
import { useLanguage } from '../../../LanguageContext';
import { useMotion } from '../../../lib/motion';
import { shareStoreApi, type StoreShareKit } from './shareStoreApi';
import { shareStrings } from './strings';

const ShareStoreSheet = lazy(() => import('./ShareStoreSheet'));

export default function OwnerShareMenuItem({
  storeId,
  onDone,
  className = '',
}: {
  /** The store on screen. */
  storeId: string;
  /** Close the menu — called once the window has finished leaving. */
  onDone: () => void;
  className?: string;
}) {
  const { user } = useAuth();
  const { loc } = useLanguage();
  const m = useMotion();
  const [kit, setKit] = useState<StoreShareKit | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!user || !storeId) return;
    let alive = true;
    shareStoreApi
      .kit()
      .then((k) => {
        if (alive && k.store_id === storeId) setKit(k);
      })
      .catch(() => {
        // Not a merchant, not this store's owner, or offline: no row.
      });
    return () => {
      alive = false;
    };
  }, [user, storeId]);

  useEffect(() => {
    if (open || !mounted) return;
    const timer = window.setTimeout(onDone, m.reduced ? 180 : 380);
    return () => window.clearTimeout(timer);
  }, [open, mounted, onDone, m.reduced]);

  if (!kit) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
        className={className}
      >
        {shareStrings(loc).menuItem}
      </button>
      {mounted && (
        <Suspense fallback={null}>
          <ShareStoreSheet open={open} onClose={() => setOpen(false)} kit={kit} />
        </Suspense>
      )}
    </>
  );
}
