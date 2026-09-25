/**
 * A merchant's public shop — what `ali3d.levonis-iq.com` renders.
 *
 * ONE APPLICATION, MANY STORES (§10). There is no per-merchant frontend; this
 * page is reached either because the hostname resolved to a store, or because
 * someone opened `/community/store/:slug` on the main site. Both paths end
 * here with the same component and the same data.
 *
 * THE PAGE IS THE STORE'S PUBLISHED LAYOUT (docs/MERCHANT_PLATFORM.md §4.4).
 * The server answers the store together with the ONE layout visitors may see
 * — the published revision, never the draft — and the rows its blocks show
 * (worker/lib/storeLayout.ts). A store that never published renders the
 * classic layout: the reference profile and its tabs, exactly the page every
 * store had before themes. The blocks live in src/components/storefront and
 * render the same way in the builder's preview; this file owns what ACTS —
 * follow, contact, share, the owner's share kit, favourites, install, the way
 * back, the request board's door, the loaders for more products — and hands
 * those to the blocks through the storefront runtime.
 *
 * VISUALLY IT IS LEVONIS. §12 and §93: a merchant may brand their shop but not
 * escape the platform's design. Themes are presets, tokens are enums, the
 * accent is a NAME, widget icons map through a fixed table, and no merchant
 * string ever becomes a style rule or raw HTML.
 */

import { Suspense, createContext, lazy, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Hammer, Link2, Loader2, MessageCircle, MessageCircleMore, MoreHorizontal, PackageX } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { api, ApiError } from '../lib/api';
import { storefrontApi, communityFavoritesApi } from '../lib/storefrontApi';
import type { MerchantProduct } from '../lib/merchant';
import { useStore } from '../StoreContext';
import { trackStoreEvent } from '../lib/storeBeacon';
import { useCommunityAccess } from './community/access';
import InstallAppButton from '../components/pwa/InstallAppButton';
import StoreUnavailable from '../components/merchant/StoreUnavailable';
import StoreRenderer from '../components/storefront/StoreRenderer';
import '../components/storefront/styles';
import { SavedIdsProvider, StorefrontRuntimeProvider, type StorefrontRuntime, type TabKind } from '../components/storefront/runtime';
import type { AccentClasses } from '../components/storefront/theme';
import type { StorefrontStore } from '../components/storefront/types';
import type { LinkRoute } from '../../packages/storeLayout/src/refs';
import type { ReviewsData } from '../../packages/storeLayout/src/data';

// The owner's «QR and store card» row and its strings arrive with the «…»
// menu, not with the page: a customer's visit never downloads them (W2-F).
const OwnerShareMenuItem = lazy(() => import('../components/merchant/share/OwnerShareMenuItem'));

type Loc = (ar: string, en: string, ckb?: string) => string;

const TAB_KINDS: readonly TabKind[] = ['products', 'collections', 'deals', 'services', 'showcase', 'about'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The main site, from wherever this store is rendered. On a subdomain the
 * messenger and the request board live on the apex; the shared cookie keeps
 * the visitor signed in across the hop.
 *
 * FROM THE SERVER (audit 01 B19): `/api/storefront/resolve` names the root
 * domain the Worker is configured with, and StoreContext keeps it. Empty when
 * no root domain is configured — the links are then relative, which on such a
 * deployment is the right answer.
 */
function useMainSite(): string {
  return useStore().mainSite;
}

/** What the live controls below read: the store on screen and who is looking. */
interface LiveState {
  store: StorefrontStore;
  profileOnly: boolean;
  signedIn: boolean;
  onHost: boolean;
  /** Levo Community refused this viewer (the only thing that closes its doors). */
  communityClosed: boolean;
  backTo: string;
}

const LiveContext = createContext<LiveState | null>(null);
function useLive(): LiveState {
  const live = useContext(LiveContext);
  if (!live) throw new Error('a storefront control rendered outside the storefront');
  return live;
}

export default function Storefront({
  store: injected,
  profileProducts,
}: { store?: StorefrontStore | null; profileProducts?: MerchantProduct[] } = {}) {
  const { slug: routeSlug } = useParams<{ slug: string }>();
  const location = useLocation();
  const { loc } = useLanguage();
  const { user } = useAuth();
  const { store: hostStore, unknownStore: hostUnknown, unavailableStore: hostUnavailable } = useStore();
  const MAIN_SITE = useMainSite();
  /**
   * THE BACK ARROW MUST NOT POINT AT A CLOSED DOOR.
   *
   * This shop is reachable by its OWN address and stays open while Levo
   * Community is under maintenance — that is the deliberate shape of the gate
   * (worker/lib/communityGate.ts). But the arrow in the page's corner is the
   * only way out, and it points into the directory. While the server says
   * this viewer may not enter, it points at the site's front page instead: a
   * way out that works, rather than a maintenance card or a hidden arrow that
   * strands the visitor on a shop.
   */
  const { access: communityAccess } = useCommunityAccess();
  const backTo = communityAccess?.may_enter === false ? '/' : '/community';

  const [store, setStore] = useState<StorefrontStore | null>(injected ?? null);
  // Nothing to load on a store host whose resolve already answered "unknown"
  // or "unavailable" — without this the page spun for ever there.
  const [loading, setLoading] = useState(!injected && !hostUnknown && !hostUnavailable);
  const [notFound, setNotFound] = useState(hostUnknown);
  // The server answered STORE_UNAVAILABLE for the in-site route
  // (`/community/store/:slug`) — an admin-suspended store.
  const [unavailable, setUnavailable] = useState(false);

  // The hearts. Public product lists carry no per-user state (§59), so a
  // signed-in visitor's saved set is fetched once from the authed side and
  // intersected here — the same split the follow button uses. One request
  // per product may be in flight at a time; its desired state is recorded
  // so a hydration response that raced a tap cannot wipe the tap out.
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const pendingSaves = useRef(new Map<string, boolean>());

  const slug = store?.slug ?? routeSlug ?? '';
  // First-party analytics (W2-E): the Worker counts one store view per visitor per day.
  useEffect(() => trackStoreEvent(store?.id, 'store_view'), [store?.id]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    communityFavoritesApi
      .ids()
      .then((d) => {
        if (!alive) return;
        setSavedIds(() => {
          const n = new Set(d.product_ids);
          // A toggle that raced this response is the newer truth.
          for (const [id, want] of pendingSaves.current) {
            if (want) n.add(id);
            else n.delete(id);
          }
          return n;
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user]);

  // Stable across renders (it reads the live set through a ref), so the
  // memoised runtime below does not change on every heart.
  const savedRef = useRef(savedIds);
  useEffect(() => {
    savedRef.current = savedIds;
  }, [savedIds]);
  const toggleSave = useMemo(
    () => (productId: string) => {
      if (!user) {
        window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      // Like the follow button's busy flag: a second tap while the first
      // request is still flying is dropped, so PUT and DELETE can never be in
      // flight together and land out of order.
      if (pendingSaves.current.has(productId)) return;
      const wasSaved = savedRef.current.has(productId);
      const want = !wasSaved;
      pendingSaves.current.set(productId, want);
      setSavedIds((s) => {
        const n = new Set(s);
        if (want) n.add(productId);
        else n.delete(productId);
        return n;
      });
      (want ? communityFavoritesApi.add(productId) : communityFavoritesApi.remove(productId))
        .catch(() => {
          // The server disagreed — put the heart back the way it really is.
          setSavedIds((s) => {
            const n = new Set(s);
            if (wasSaved) n.add(productId);
            else n.delete(productId);
            return n;
          });
        })
        .finally(() => {
          pendingSaves.current.delete(productId);
        });
    },
    [user]
  );

  useEffect(() => {
    if (injected) {
      setStore(injected);
      setLoading(false);
      return;
    }
    if (!routeSlug) return;
    let alive = true;
    setLoading(true);
    storefrontApi
      .store(routeSlug)
      .then((d) => alive && setStore(d.store as StorefrontStore))
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiError && e.code === 'STORE_UNAVAILABLE') setUnavailable(true);
        else setNotFound(true);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [routeSlug, injected]);

  // What the address asks for: a tab (`/about`, old `/reviews` deep links,
  // `/products`, `?tab=`) and a collection (`?section=`).
  const search = new URLSearchParams(location.search);
  const tabParam = search.get('tab') ?? '';
  const initialTab: TabKind | null = (TAB_KINDS as readonly string[]).includes(tabParam)
    ? (tabParam as TabKind)
    : location.pathname.endsWith('/reviews') || location.pathname.endsWith('/about')
      ? 'about'
      : location.pathname.endsWith('/products')
        ? 'products'
        : null;
  const sectionParam = search.get('section') ?? '';
  const section = ID.test(sectionParam) ? sectionParam : '';

  // A community merchant with no store row gets the same reference profile,
  // assembled from their real profile data (CommunityStorePage). The primary
  // action there is the conversation itself, and product cards walk into the
  // legacy product page.
  const profileOnly = !!store && !store.slug;
  const onHost = !!hostStore;
  const communityClosed = communityAccess?.may_enter === false;

  const runtime = useMemo<StorefrontRuntime>(() => {
    const base = onHost ? '' : `/community/store/${slug}`;
    const withQuery = (q: string) => (onHost ? `/?${q}` : `${base}?${q}`);
    const routeHref = (route: LinkRoute): string => {
      switch (route) {
        case 'home':
          return onHost ? '/' : base;
        case 'products':
          return onHost ? '/products' : withQuery('tab=products');
        case 'about':
          return onHost ? '/about' : withQuery('tab=about');
        case 'reviews':
          return onHost ? '/reviews' : withQuery('tab=about');
        case 'cart':
          return '/cart';
        default:
          return withQuery(`tab=${route}`);
      }
    };
    const noStore = !slug;
    return {
      mode: 'live',
      onHost,
      profileOnly,
      communityOpen: !communityClosed,
      initialTab,
      section,
      injectedProducts: profileOnly ? (profileProducts ?? []) : null,
      toggleSave,
      // On a merchant host the shop IS the site, so a product lives at /p/…;
      // on the main site it needs the store in the path.
      productHref: (productSlug) => (onHost ? `/p/${productSlug}` : `/community/store/${slug}/p/${productSlug}`),
      legacyProductHref: (productSlug) => `/product/${productSlug}`,
      routeHref,
      collectionHref: (id) => (onHost ? `/products?section=${encodeURIComponent(id)}` : `${base}?section=${encodeURIComponent(id)}`),
      requestsHref: onHost ? `${MAIN_SITE}/requests` : '/requests',
      loadProducts: async ({ source, collection_id, cursor }) => {
        if (noStore) return { items: [], next_cursor: null };
        const qs = new URLSearchParams();
        if (source === 'deals') qs.set('deals', '1');
        if (source === 'collection' && collection_id) qs.set('section', collection_id);
        if (cursor) qs.set('cursor', cursor);
        const q = qs.toString();
        const d = await storefrontApi.products(slug, q ? `?${q}` : '');
        return { items: d.products, next_cursor: d.next_cursor };
      },
      loadCollections: async () =>
        noStore
          ? []
          : (await storefrontApi.sections(slug)).sections.map((s) => ({
              id: s.id,
              name: s.name,
              name_ar: s.name_ar,
              product_count: Number(s.product_count ?? 0),
            })),
      loadServices: async () => (noStore ? [] : (await storefrontApi.services(slug)).services),
      loadShowcase: async () => (noStore ? [] : (await storefrontApi.showcase(slug)).items),
      loadReviews: async () =>
        noStore
          ? { average: null, count: 0, distribution: {}, reviews: [], next_cursor: null }
          : ((await storefrontApi.reviews(slug)) as unknown as ReviewsData),
      Back: LiveBack,
      Menu: LiveMenu,
      ProfileActions: LiveProfileActions,
      ServiceDoors: LiveServiceDoors,
      ChatButton: LiveChatButton,
      InstallCard: LiveInstallCard,
    };
  }, [onHost, slug, profileOnly, communityClosed, initialTab, section, profileProducts, toggleSave, MAIN_SITE]);

  const live = useMemo<LiveState | null>(
    () => (store ? { store, profileOnly, signedIn: !!user, onHost, communityClosed, backTo } : null),
    [store, profileOnly, user, onHost, communityClosed, backTo]
  );

  // OWNER DECISION (2026-09-24): an admin-suspended store is this page and
  // nothing else — the server sends nothing of the shop to render anyway.
  if (hostUnavailable || unavailable) return <StoreUnavailable />;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gold animate-spin" />
      </div>
    );
  }

  if (notFound || !store || !live) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <PackageX className="w-10 h-10 text-zinc-600 mx-auto mb-4" />
          <h1 className="text-gold font-bold text-lg mb-2">
            {loc('لا يوجد متجر هنا', 'No store here', 'هیچ فرۆشگایەک لێرە نییە')}
          </h1>
          <p className="text-zinc-500 text-[13px] mb-6">
            {loc(
              'قد يكون العنوان مكتوبًا بشكل خاطئ أو أن المتجر لم يعد موجودًا.',
              'The address may be mistyped, or the store no longer exists.',
              'لەوانەیە ناونیشانەکە هەڵە بێت یان فرۆشگاکە نەمابێت.'
            )}
          </p>
          <a
            href={MAIN_SITE ? `${MAIN_SITE}/` : '/'}
            translate="no"
            className="inline-flex items-center gap-2 min-h-[44px] px-5 rounded-2xl bg-olive text-white font-bold text-[13px]"
          >
            LEVONIS
          </a>
        </div>
      </div>
    );
  }

  return (
    <LiveContext.Provider value={live}>
      <StorefrontRuntimeProvider value={runtime}>
        <SavedIdsProvider value={savedIds}>
          {/* Keyed on what the address asks for, so following a link to a tab
              or a collection starts the page there. */}
          <StoreRenderer key={`${initialTab ?? ''}|${section}`} store={store} className="min-h-screen pb-24" />
        </SavedIdsProvider>
      </StorefrontRuntimeProvider>
    </LiveContext.Provider>
  );
}

// ------------------------------------------------------------ live controls

/** The way out: the bare arrow in the page's top-left corner, as drawn. */
function LiveBack() {
  const { onHost, backTo } = useLive();
  const { loc } = useLanguage();
  const MAIN_SITE = useMainSite();
  const cls = 'relative lv-hit w-9 h-9 rounded-full flex items-center justify-center text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  return onHost ? (
    <a href={`${MAIN_SITE}${backTo}`} className={cls} aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}>
      <ArrowLeft className="w-5 h-5" strokeWidth={2} />
    </a>
  ) : (
    <Link to={backTo} className={cls} aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}>
      <ArrowLeft className="w-5 h-5" strokeWidth={2} />
    </Link>
  );
}

function LiveMenu() {
  const { store } = useLive();
  const { loc } = useLanguage();
  return <StoreMenu url={store.url} name={store.name} loc={loc} storeId={store.id} />;
}

/**
 * Actions, exactly two as drawn: the contact button on the right, and the
 * outlined follow pill on the left with the share link living inside the
 * pill's far-left end.
 */
function LiveProfileActions({ accent }: { accent: AccentClasses }) {
  const { store, signedIn, onHost, profileOnly } = useLive();
  const { loc } = useLanguage();
  const { access: communityAccess } = useCommunityAccess();
  return (
    <div dir="rtl" className="flex gap-4">
      <ContactButton merchantId={store.merchant.id} signedIn={signedIn} onHost={onHost} loc={loc} accentBtn={accent.btn} profileOnly={profileOnly} />
      <div className="relative flex-[1.08] min-w-0">
        <FollowButton merchantId={store.merchant.id} signedIn={signedIn} loc={loc} accentChip={accent.chip} closed={communityAccess?.may_enter === false} />
        <SharePin url={store.url} name={store.name} loc={loc} />
      </div>
    </div>
  );
}

/** Opens the real conversation with the store — the same thread every time. */
function useOpenChat(): { open: () => Promise<void>; failed: boolean } {
  const { store, signedIn, onHost } = useLive();
  const navigate = useNavigate();
  const MAIN_SITE = useMainSite();
  const [failed, setFailed] = useState(false);
  async function open() {
    if (!signedIn) {
      window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    setFailed(false);
    try {
      const r = await api.post<{ chatId: string }>('/api/chats/open', { merchantId: store.merchant.id });
      if (onHost) window.location.href = `${MAIN_SITE}/chat/${r.chatId}`;
      else navigate(`/chat/${r.chatId}`);
    } catch {
      // Said on the control itself, not in a native alert that blocks the page.
      setFailed(true);
    }
  }
  return { open, failed };
}

/**
 * The real doors to buying a service: a priced quote through the request
 * board (escrow-protected), or a direct conversation.
 */
function LiveServiceDoors({ accepts }: { accepts: boolean }) {
  const { onHost } = useLive();
  const { loc } = useLanguage();
  const MAIN_SITE = useMainSite();
  const { open: openChat, failed: chatFailed } = useOpenChat();
  const requestsHref = onHost ? `${MAIN_SITE}/requests` : '/requests';
  // The request board IS Levo Community and closes with it (DECISIONS 110):
  // while it is shut to this viewer the quote door would open onto the
  // maintenance card, so only the conversation is offered.
  const { access: communityAccess } = useCommunityAccess();
  const quotes = accepts && communityAccess?.may_enter !== false;

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {quotes && (
          <a
            href={requestsHref}
            className="relative lv-hit h-10 rounded-xl bg-olive text-white font-bold text-[12px] flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Hammer className="w-3.5 h-3.5" />
            {loc('اطلب عرض سعر', 'Request a quote', 'داوای نرخ بکە')}
          </a>
        )}
        <button
          onClick={openChat}
          className={`relative lv-hit h-10 rounded-xl border border-white/10 bg-white/[0.03] text-zinc-200 font-bold text-[12px] flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${quotes ? '' : 'col-span-2'}`}
        >
          <MessageCircle className="w-3.5 h-3.5" aria-hidden="true" />
          {loc('مراسلة المتجر', 'Message the store', 'نامە بۆ فرۆشگا')}
        </button>
      </div>
      {chatFailed && (
        <p role="alert" className="text-red-300/90 text-[11.5px] text-center">
          {loc('تعذّر فتح المحادثة — حاول مجددًا.', 'Could not open the conversation — try again.')}
          {/* OWNER: Sorani to be written by hand. */}
        </p>
      )}
      {quotes && (
        <p className="text-zinc-600 text-[10.5px] text-center">
          {loc(
            'عروض الأسعار تمر عبر منصة Levonis والمبلغ يبقى محجوزًا حتى استلامك.',
            'Quotes go through Levonis and your money stays held until you receive the work.',
            'نرخەکان بە ڕێگای LEVONIS دەبن و پارەکەت پارێزراوە.'
          )}
        </p>
      )}
    </>
  );
}

/** «Message the store» as one button (the contact block). */
function LiveChatButton({ className = '', children }: { className?: string; children?: ReactNode }) {
  const { loc } = useLanguage();
  const { open, failed } = useOpenChat();
  return (
    <>
      <button type="button" onClick={open} className={className}>
        {children}
      </button>
      {failed && (
        <p role="alert" className="text-red-300/90 text-[11.5px] text-center">
          {loc('تعذّر فتح المحادثة — حاول مجددًا.', 'Could not open the conversation — try again.')}
          {/* OWNER: Sorani to be written by hand. */}
        </p>
      )}
    </>
  );
}

/*
  «ثبّت هذا المتجر», AND IT ONLY BELONGS ON THIS HOST.

  On `ali3d.levonis-iq.com` the whole application is `StorefrontApp` (see
  App.tsx), whose route table declares no `/settings` at all — so the install
  affordance lives on the page itself, below the blocks, on every tab. It
  needs no account, which matters most here: a shopper arriving on a merchant
  link from a story is signed out.

  `onHost` gates it: reached as `/community/store/:slug` on the main site this
  same page is a PREVIEW of someone else's shop inside LEVONIS, and the
  manifest that origin serves is the platform's. Offering to install «متجر علي»
  there would install LEVONIS under that name — the exact deception the
  per-host manifest exists to stop. `offered`, so «ليس الآن» buys a month of
  silence — nobody asked for this row.
*/
function LiveInstallCard() {
  const { onHost } = useLive();
  const { loc } = useLanguage();
  if (!onHost) return null;
  return (
    <div className="sf-card p-4">
      <p className="text-white font-bold text-[13px]">{loc('تحميل التطبيق', 'Install the app', 'دابەزاندنی ئەپەکە')}</p>
      <p className="mt-1 text-zinc-400 text-[11.5px] leading-relaxed">
        {loc(
          'أضف المتجر إلى شاشتك الرئيسية ليفتح مثل التطبيق.',
          'Add the shop to your home screen so it opens like an app.',
          'فرۆشگا زیاد بکە بۆ شاشەی سەرەکیت تا وەک ئەپ بکرێتەوە.'
        )}
      </p>
      <InstallAppButton offered />
    </div>
  );
}

function FollowButton({
  merchantId,
  signedIn,
  loc,
  accentChip,
  closed,
}: {
  merchantId: string;
  signedIn: boolean;
  loc: Loc;
  accentChip: string;
  /**
   * Levo Community is under maintenance for this viewer. Follows are part of
   * it and the server refuses them (/api/community-reviews/follow*), so the
   * pill stays in place — the share link lives inside it — but is inert.
   */
  closed?: boolean;
}) {
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);

  // Hydrated from the server: a visitor who already follows this shop must
  // see "Following", not a button that lies until it is pressed.
  useEffect(() => {
    if (!signedIn || closed) return;
    let alive = true;
    api
      .get<{ following: Array<{ merchant_id: string }> }>('/api/community-reviews/following')
      .then((d) => alive && setFollowing(d.following.some((f) => f.merchant_id === merchantId)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [signedIn, merchantId, closed]);

  async function toggle() {
    if (!signedIn) {
      // Preserve where they were, so signing in returns them to this shop.
      window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    setBusy(true);
    try {
      if (following) {
        await api.delete(`/api/community-reviews/follow/${merchantId}`);
        setFollowing(false);
      } else {
        await api.post(`/api/community-reviews/follow/${merchantId}`);
        setFollowing(true);
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy || closed}
      className={`relative lv-hit w-full h-[30px] rounded-full font-medium text-[13px] flex items-center justify-center gap-1.5 px-9 active:scale-[0.98] transition-all disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        following ? accentChip : 'border border-white/15 bg-transparent text-zinc-200'
      }`}
    >
      {following ? <Check className="w-3.5 h-3.5" strokeWidth={1.75} /> : null}
      {following ? loc('تتابعه', 'Following', 'شوێنی کەوتوویت') : loc('تابع', 'Follow', 'شوێنکەوتن')}
    </button>
  );
}

/**
 * «تواصل مع المتجر» opens the REAL conversation — one tap lands in the
 * thread, and a second tap lands in the SAME thread (the server reuses the
 * pair's DM). On a store subdomain the messenger lives on the apex; the
 * shared cookie keeps the session across the hop.
 */
function ContactButton({
  merchantId,
  signedIn,
  onHost,
  loc,
  accentBtn,
  profileOnly = false,
}: {
  merchantId: string;
  signedIn: boolean;
  onHost: boolean;
  loc: Loc;
  accentBtn: string;
  profileOnly?: boolean;
}) {
  const navigate = useNavigate();
  const MAIN_SITE = useMainSite();
  const [busy, setBusy] = useState(false);
  // A failed open is said ON the button for a few seconds (and announced),
  // not in a native alert that blocks the whole page.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => setFailed(false), 4000);
    return () => clearTimeout(t);
  }, [failed]);

  async function open() {
    if (!signedIn) {
      window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const r = await api.post<{ chatId: string }>('/api/chats/open', { merchantId });
      if (onHost) window.location.href = `${MAIN_SITE}/chat/${r.chatId}`;
      else navigate(`/chat/${r.chatId}`);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={open}
      disabled={busy}
      className={`relative lv-hit flex-1 h-[30px] rounded-xl font-semibold text-[13px] flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${accentBtn}`}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <MessageCircleMore className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />}
      {/* A profile with no store behind it is a person to talk to, and the
          «مراسلة» name is a pinned contract for that page. */}
      <span aria-live="polite">
        {failed
          ? loc('تعذّر الفتح — حاول مجددًا', 'Could not open — try again') /* OWNER: Sorani to be written by hand. */
          : profileOnly
            ? loc('مراسلة', 'Message', 'نامە')
            : loc('تواصل مع المتجر', 'Contact the store', 'پەیوەندی بە فرۆشگا')}
      </span>
    </button>
  );
}

/** The store's address, absolute — falls back to where the visitor already is. */
function absoluteStoreUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : window.location.href;
}

/**
 * The chain-link pinned inside the follow pill's far-left end, as the
 * reference draws it. It is its own control layered over the pill: tapping
 * the glyph shares the shop (system sheet, clipboard fallback) without
 * touching the follow state.
 */
function SharePin({ url, name, loc }: { url: string; name: string; loc: Loc }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const target = absoluteStoreUrl(url);
    try {
      if (navigator.share) {
        await navigator.share({ title: name, url: target });
        return;
      }
    } catch {
      return; // the user closed the sheet — not a reason to also copy
    }
    try {
      await navigator.clipboard.writeText(target);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <button
      onClick={share}
      className="absolute lv-hit left-0 top-0 h-[30px] w-9 rounded-full flex items-center justify-center text-zinc-300 active:scale-[0.9] transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      aria-label={loc('مشاركة المتجر', 'Share the store', 'هاوبەشکردن')}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" strokeWidth={1.75} /> : <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} />}
    </button>
  );
}

/** The «…» over the cover: share and copy-link, both real — and, for the
 *  store's own OWNER only, the share kit (QR code, card, app icon; W2-D). */
function StoreMenu({
  url,
  name,
  loc,
  storeId,
}: {
  url: string;
  name: string;
  loc: Loc;
  storeId: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function share() {
    const target = absoluteStoreUrl(url);
    try {
      if (navigator.share) {
        await navigator.share({ title: name, url: target });
        setOpen(false);
        return;
      }
    } catch {
      setOpen(false);
      return;
    }
    copy();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(absoluteStoreUrl(url));
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setOpen(false);
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative lv-hit w-[30px] h-[30px] rounded-full border border-white/20 bg-white/5 backdrop-blur flex items-center justify-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        aria-label={loc('خيارات المتجر', 'Store options', 'هەڵبژاردەکان')}
        aria-expanded={open}
      >
        <MoreHorizontal className="w-4 h-4" strokeWidth={1.75} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-[34px] right-0 z-30 w-44 rounded-xl border border-white/10 sf-menu shadow-2xl overflow-hidden">
            <button onClick={share} className="w-full text-start px-3.5 py-2.5 text-[12.5px] text-zinc-200 active:bg-white/10">
              {loc('مشاركة المتجر', 'Share the store', 'هاوبەشکردنی فرۆشگا')}
            </button>
            <button onClick={copy} className="w-full text-start px-3.5 py-2.5 text-[12.5px] text-zinc-200 active:bg-white/10 border-t border-white/5">
              {copied ? loc('تم النسخ ✓', 'Copied ✓', 'کۆپی کرا ✓') : loc('نسخ الرابط', 'Copy the link', 'کۆپی بەستەر')}
            </button>
            <Suspense fallback={null}>
              <OwnerShareMenuItem
                storeId={storeId}
                onDone={() => setOpen(false)}
                className="w-full text-start px-3.5 py-2.5 text-[12.5px] text-zinc-200 active:bg-white/10 border-t border-white/5"
              />
            </Suspense>
          </div>
        </>
      )}
    </div>
  );
}
