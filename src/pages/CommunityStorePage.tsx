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
 * A merchant from the pre-store era can hold a community profile with no
 * `merchant_stores` row at all — nothing to resolve. They still get the SAME
 * reference profile: a synthetic store view is assembled from their real
 * community data (name, avatar, bio, followers, their legacy products,
 * joined date) and rendered in profile-only mode, where the primary action
 * is the pinned «مراسلة» conversation. Only a merchant that does not exist
 * at all falls through to the legacy page's not-found state.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { storefrontApi, type MerchantStore as StoreShape, type MerchantProduct } from '../lib/merchant';
import Storefront from './Storefront';
import MerchantStore from './MerchantStore';

interface LegacyMerchant {
  id: string;
  user_id: string;
  name: string;
  bio: string | null;
  avatarUrl: string | null;
  verified: boolean;
  pro_badge?: boolean;
  created_at: string;
}

interface LegacyStorePayload {
  merchant: LegacyMerchant;
  products: Array<Record<string, unknown>>;
  followers: number;
  following: boolean;
}

/** The reference profile, fed by the community profile's real data. */
function syntheticStore(d: LegacyStorePayload): StoreShape {
  return {
    id: `profile-${d.merchant.id}`,
    merchant_id: d.merchant.id,
    slug: '',
    url: '',
    name: d.merchant.name,
    tagline: '',
    description: d.merchant.bio ?? '',
    logoUrl: d.merchant.avatarUrl,
    bannerUrl: null,
    accent: 'default',
    categories: [],
    governorate: '',
    service_areas: [],
    contact_phone: null,
    business_hours: [],
    policies: {},
    social_links: {},
    accepts_custom_requests: false,
    sells_direct_products: true,
    status: 'active',
    open: true,
    followers: d.followers,
    product_count: d.products.length,
    positive_pct: null,
    deal_count: 0,
    profile_links: [],
    profile_facts: [],
    profile_facts_configured: false,
    created_at: d.merchant.created_at,
    merchant: {
      id: d.merchant.id,
      name: d.merchant.name,
      verified: d.merchant.verified,
      pro_badge: d.merchant.pro_badge,
      badge: 'new',
      rating: null,
      rating_count: 0,
      completed_orders: 0,
    },
  };
}

export default function CommunityStorePage() {
  const { id } = useParams<{ id: string }>();
  const [store, setStore] = useState<StoreShape | null>(null);
  const [profileProducts, setProfileProducts] = useState<MerchantProduct[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    setStore(null);
    setProfileProducts(null);
    storefrontApi
      .store(id)
      .catch(() => storefrontApi.storeById(id))
      .then((d) => {
        if (!alive) return;
        // A shop with its own address IS its own site: hand the visitor over
        // to the subdomain rather than embedding the shop in the main site.
        // The shared cookie keeps their session across the hop. Without a
        // configured root domain the URL is this same path, so we render
        // in place instead of looping.
        const url = d.store?.url ?? '';
        if (/^https?:\/\//.test(url)) {
          try {
            if (new URL(url).origin !== window.location.origin) {
              // Keep the loader on screen until the browser actually leaves —
              // dropping it would flash another page mid-handover.
              window.location.replace(url);
              return;
            }
          } catch {
            /* malformed — render in place */
          }
        }
        setStore(d.store);
        setLoading(false);
      })
      .catch(async () => {
        // No store row — assemble the profile-only view from community data.
        try {
          const d = await api.get<LegacyStorePayload>(`/api/community/store/${encodeURIComponent(id)}`);
          if (!alive) return;
          setStore(syntheticStore(d));
          setProfileProducts((d.products ?? []) as unknown as MerchantProduct[]);
        } catch {
          /* merchant truly gone — the legacy page below owns not-found */
        }
        if (alive) setLoading(false);
      });
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
  return store ? (
    <Storefront store={store} profileProducts={profileProducts ?? undefined} />
  ) : (
    <MerchantStore />
  );
}
