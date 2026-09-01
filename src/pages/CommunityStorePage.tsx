/**
 * /community/store/:id on the MAIN site — the subdomain-free way into a shop
 * (§57), kept working forever for old links, shared messages and QR codes.
 *
 * The id in the wild is heterogeneous: the community directory and the
 * followed-stores list navigate by MERCHANT id, request offers link by store
 * SLUG, and chat share-cards carry a STORE id. The server resolves all three
 * (slug first, then the id endpoint that accepts either id), and the page
 * renders the same Storefront profile the subdomain serves.
 *
 * THE LEGACY FALLBACK IS DELIBERATE. A merchant from the pre-store era can
 * hold a community profile with no `merchant_stores` row at all — nothing to
 * resolve — and their page must keep working exactly as it always has
 * (including the pinned «مراسلة» behaviour), so they fall through to the old
 * MerchantStore component rather than to a "no store" dead end.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { storefrontApi, type MerchantStore as StoreShape } from '../lib/merchant';
import Storefront from './Storefront';
import MerchantStore from './MerchantStore';

export default function CommunityStorePage() {
  const { id } = useParams<{ id: string }>();
  const [store, setStore] = useState<StoreShape | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    setStore(null);
    storefrontApi
      .store(id)
      .catch(() => storefrontApi.storeById(id))
      .then((d) => alive && setStore(d.store))
      .catch(() => {
        /* no store row — the legacy page below owns this case, not-found included */
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gold animate-spin" />
      </div>
    );
  }
  return store ? <Storefront store={store} /> : <MerchantStore />;
}
