/**
 * A merchant's public shop — what `ali3d.levonis-iq.com` renders.
 *
 * ONE APPLICATION, MANY STORES (§10). There is no per-merchant frontend; this
 * page is reached either because the hostname resolved to a store, or because
 * someone opened `/community/store/:slug` on the main site. Both paths end
 * here with the same component and the same data.
 *
 * VISUALLY IT IS LEVONIS. §12 and §93 are explicit that a merchant may brand
 * their shop but not escape the platform's design: the merchant controls
 * CONTENT — cover, avatar, words, the three link pills, the three info
 * cards, products, services, showcase — plus an accent chosen from a fixed
 * set of presets. No merchant string ever becomes a style rule or raw HTML:
 * `accent` maps through a lookup below, widget ICON NAMES map through a
 * fixed component table, and anything unrecognised falls back safely.
 *
 * THE SHAPE follows one fixed profile skeleton, top to bottom: cover →
 * avatar/name/verification → three honest stats → bio → the merchant's three
 * links → their three info cards → actions (contact, follow, share) → tabs →
 * the product grid. The merchant rearranges what fills the slots from their
 * dashboard; the skeleton itself never moves.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Store, Star, BadgeCheck, Clock, ShoppingBag, MessageCircle, MessageCircleMore,
  Loader2, PackageX, Check, Printer, Layers, Hammer, ArrowLeft, ChevronLeft,
  MapPin, X, Heart, MoreHorizontal, Link2,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { TabStrip, TabPanels } from '../components/ui/Tabs';
import { useAuth } from '../AuthContext';
import { api, ApiError } from '../lib/api';
import {
  storefrontApi, communityFavoritesApi, badgeLabel, iqd,
  type MerchantStore, type MerchantProduct, type StoreSection, type StoreService,
  type ShowcaseItem, type ProfileWidget,
} from '../lib/merchant';
import { GOVERNORATE_LABELS } from '../lib/governorates';
import { WidgetIcon } from '../components/merchant/profileIcons';
import { useStore } from '../StoreContext';

/**
 * The accent presets. A NAME maps to classes chosen here — a merchant never
 * supplies a colour, so nothing they type can reach the stylesheet. `btn` is
 * the contact button's fill; the rest tint rings, chips and the active tab.
 */
/* `line` was a BORDER colour, because the active tab used to be a border on
   its own button. The travelling indicator is a filled element, so each accent
   also names the FILL — `indicator` — rather than having the strip guess a
   background from a border class. `line` stays: other places still use it. */
const ACCENTS: Record<string, { ring: string; chip: string; glow: string; text: string; btn: string; line: string; indicator: string }> = {
  default: { ring: 'border-gold/30', chip: 'bg-olive/30 text-gold', glow: 'bg-olive/15', text: 'text-gold', btn: 'bg-zinc-100 text-zinc-900', line: 'border-gold', indicator: 'bg-gold' },
  olive: { ring: 'border-olive-light/40', chip: 'bg-olive/40 text-gold', glow: 'bg-olive/20', text: 'text-gold', btn: 'bg-olive text-white', line: 'border-gold', indicator: 'bg-gold' },
  gold: { ring: 'border-gold/40', chip: 'bg-gold/15 text-gold', glow: 'bg-gold/10', text: 'text-gold', btn: 'bg-gold text-zinc-900', line: 'border-gold', indicator: 'bg-gold' },
  slate: { ring: 'border-slate-500/40', chip: 'bg-slate-500/15 text-slate-200', glow: 'bg-slate-500/10', text: 'text-slate-200', btn: 'bg-slate-200 text-slate-900', line: 'border-slate-300', indicator: 'bg-slate-300' },
  plum: { ring: 'border-purple-500/40', chip: 'bg-purple-500/15 text-purple-200', glow: 'bg-purple-500/10', text: 'text-purple-200', btn: 'bg-purple-300 text-purple-950', line: 'border-purple-300', indicator: 'bg-purple-300' },
  teal: { ring: 'border-teal-500/40', chip: 'bg-teal-500/15 text-teal-200', glow: 'bg-teal-500/10', text: 'text-teal-200', btn: 'bg-teal-300 text-teal-950', line: 'border-teal-300', indicator: 'bg-teal-300' },
  blue: { ring: 'border-sky-500/40', chip: 'bg-sky-500/15 text-sky-300', glow: 'bg-sky-500/10', text: 'text-sky-400', btn: 'bg-zinc-100 text-zinc-900', line: 'border-sky-400', indicator: 'bg-sky-400' },
};

type Tab = 'products' | 'sections' | 'deals' | 'services' | 'showcase' | 'about';

/** The main site, from wherever this store is rendered. On a subdomain the
 *  messenger and the request board live on the apex; the shared cookie keeps
 *  the visitor signed in across the hop. */
const MAIN_SITE = 'https://levonis-iq.com';

export default function Storefront({
  store: injected,
  profileProducts,
}: { store?: MerchantStore | null; profileProducts?: MerchantProduct[] } = {}) {
  const { slug: routeSlug } = useParams<{ slug: string }>();
  const location = useLocation();
  const { loc, lang } = useLanguage();
  const { user } = useAuth();
  const { store: hostStore } = useStore();

  const [store, setStore] = useState<MerchantStore | null>(injected ?? null);
  const [loading, setLoading] = useState(!injected);
  const [notFound, setNotFound] = useState(false);
  // Old /reviews deep-links land on «عن المتجر», where the reviews now live.
  const [tab, setTab] = useState<Tab>(() =>
    location.pathname.endsWith('/reviews') || location.pathname.endsWith('/about') ? 'about' : 'products'
  );
  // The section filter lives up here: the sections TAB picks one, the
  // products tab shows it (with a clear chip).
  const [sectionFilter, setSectionFilter] = useState('');

  // The optional halves of the profile, fetched once per store. A tab only
  // exists when there is something behind it.
  const [sections, setSections] = useState<StoreSection[]>([]);
  const [services, setServices] = useState<StoreService[]>([]);
  const [showcase, setShowcase] = useState<ShowcaseItem[]>([]);

  // The hearts. Public product lists carry no per-user state (§59), so a
  // signed-in visitor's saved set is fetched once from the authed side and
  // intersected here — the same split the follow button uses. One request
  // per product may be in flight at a time; its desired state is recorded
  // so a hydration response that raced a tap cannot wipe the tap out.
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const pendingSaves = useRef(new Map<string, boolean>());

  const slug = store?.slug ?? routeSlug ?? '';

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

  function toggleSave(productId: string) {
    if (!user) {
      window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    // Like the follow button's busy flag: a second tap while the first
    // request is still flying is dropped, so PUT and DELETE can never be
    // in flight together and land out of order.
    if (pendingSaves.current.has(productId)) return;
    const wasSaved = savedIds.has(productId);
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
  }

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
      .then((d) => alive && setStore(d.store))
      .catch(() => alive && setNotFound(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [routeSlug, injected]);

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    storefrontApi.sections(slug).then((d) => alive && setSections(d.sections)).catch(() => {});
    storefrontApi.services(slug).then((d) => alive && setServices(d.services)).catch(() => {});
    storefrontApi.showcase(slug).then((d) => alive && setShowcase(d.items)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [slug]);

  const accent = ACCENTS[store?.accent ?? 'default'] ?? ACCENTS.default;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gold animate-spin" />
      </div>
    );
  }

  if (notFound || !store) {
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
            href={MAIN_SITE}
            className="inline-flex items-center gap-2 min-h-[44px] px-5 rounded-2xl bg-olive text-white font-bold text-[13px]"
          >
            LEVONIS
          </a>
        </div>
      </div>
    );
  }

  const links = (store.profile_links ?? []).filter((w) => w.visible !== false && w.url).slice(0, 3);
  const facts = factsWithFallback(store, loc, lang);
  // A community merchant with no store row gets the same reference profile,
  // assembled from their real profile data. The primary action there is the
  // conversation itself, and product cards walk into the legacy product page.
  const profileOnly = !store.slug;

  const TABS: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: 'products', label: loc('المنتجات', 'Products', 'بەرهەمەکان'), show: true },
    { id: 'sections', label: loc('الأقسام', 'Sections', 'بەشەکان'), show: sections.length > 0 },
    { id: 'deals', label: loc('العروض', 'Deals', 'ئۆفەرەکان'), show: (store.deal_count ?? 0) > 0 },
    { id: 'services', label: loc('الخدمات', 'Services', 'خزمەتگوزاری'), show: services.length > 0 },
    { id: 'showcase', label: loc('المعرض', 'Showcase', 'پیشانگا'), show: showcase.length > 0 },
    { id: 'about', label: loc('عن المتجر', 'About', 'دەربارە'), show: true },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-24">
      <div className={`fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-2xl h-[380px] ${accent.glow} rounded-full blur-[120px] pointer-events-none z-0`} />

      {/* 1 — Cover */}
      <div className="relative z-10">
        <div className="h-36 sm:h-48 w-full overflow-hidden bg-white/[0.03] relative">
          {store.bannerUrl && (
            <img src={store.bannerUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a]/30 to-transparent" />
          {/* The reference pins the way back to the physical top-LEFT as a
              bare glyph, and the options dots to the top-RIGHT — fixed
              corners, not writing-direction ones. */}
          {hostStore ? (
            <a
              href={`${MAIN_SITE}/community`}
              className="absolute top-3 left-3 w-9 h-9 flex items-center justify-center text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]"
              aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
            >
              <ArrowLeft className="w-5 h-5" strokeWidth={2} />
            </a>
          ) : (
            <Link
              to="/community"
              className="absolute top-3 left-3 w-9 h-9 flex items-center justify-center text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]"
              aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
            >
              <ArrowLeft className="w-5 h-5" strokeWidth={2} />
            </Link>
          )}
          <StoreMenu url={store.url} name={store.name} loc={loc} />
        </div>

        <div className="max-w-3xl mx-auto px-4 sm:px-6 relative">
          {/* 2 — Avatar + name + verification. The identity block is
              LEFT-anchored exactly like the reference — the avatar on the
              left edge overlapping the cover's last rows, the words in a
              left-aligned column beside it — regardless of the UI language. */}
          <div dir="ltr" className="flex items-start gap-4 mb-3.5 -mt-[18px] text-left">
            <div className="relative shrink-0">
              <div className={`w-[72px] h-[72px] rounded-full bg-[#0a0a0a] border-2 ${accent.ring} overflow-hidden flex items-center justify-center`}>
                {store.logoUrl ? (
                  <img src={store.logoUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Store className="w-7 h-7 text-gold" strokeWidth={1.5} />
                )}
              </div>
              {store.merchant.verified && (
                <BadgeCheck className="absolute -bottom-0.5 -right-0.5 w-5 h-5 text-white fill-sky-500" />
              )}
            </div>
            <div className="min-w-0 flex-1 pt-2.5">
              <h1 className="text-white font-bold text-[17px] leading-tight truncate" dir="auto">{store.name}</h1>
              {profileOnly ? (
                <p className="text-zinc-400 text-[12px] truncate" dir="auto">{joinedLine(store.created_at, loc, lang)}</p>
              ) : (
                <p className="text-zinc-400 text-[12px] truncate">@{store.slug}</p>
              )}
              {store.merchant.rating !== null ? (
                <span className="inline-flex items-center gap-1 text-[12.5px] mt-1">
                  <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                  <span className="text-white font-semibold">{store.merchant.rating.toFixed(1)}</span>
                  <span className="text-zinc-500">({store.merchant.rating_count})</span>
                  <span className="text-amber-400/80">({loc('تقييم', 'reviews', 'هەڵسەنگاندن')})</span>
                </span>
              ) : (
                <span className="block text-zinc-500 text-[11.5px] mt-1">{badgeLabel(store.merchant.badge, loc)}</span>
              )}
              {store.merchant.verified && (
                <span className={`block w-fit mt-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full ${accent.chip}`}>
                  {loc('متجر موثّق', 'Verified store', 'فرۆشگای پشتڕاستکراو')}
                </span>
              )}
            </div>
          </div>

          {/* 3 — Three honest stats, split by short centered hairlines.
              The skeleton rows below carry explicit dir attributes: the
              reference geometry is permanent, and switching the UI language
              must never mirror the page. */}
          <div dir="rtl" className="flex items-center mb-3.5">
            <ProfileStat
              value={store.positive_pct !== null && store.positive_pct !== undefined ? `${store.positive_pct}%` : '—'}
              label={loc('تقييم إيجابي', 'Positive rating', 'هەڵسەنگاندنی ئەرێنی')}
            />
            <div className="h-6 w-px bg-white/10 shrink-0" />
            <ProfileStat value={String(store.product_count ?? 0)} label={loc('منتجات', 'Products', 'بەرهەم')} />
            <div className="h-6 w-px bg-white/10 shrink-0" />
            <ProfileStat value={String(store.followers ?? 0)} label={loc('متابعون', 'Followers', 'شوێنکەوتوو')} />
          </div>

          {/* 4 — Bio */}
          {(store.description || store.tagline) && (
            <p dir="auto" className="text-zinc-300 text-[13px] leading-snug text-center line-clamp-2 mb-4 px-2">
              {store.description || store.tagline}
            </p>
          )}

          {/* 5 — The merchant's three link pills: thin outlined stadiums, the
              icon leading the (LTR) address text on the left, as drawn. A
              pill without a valid URL is not rendered to visitors at all —
              a dead control is noise; the dashboard editor still shows it
              for fixing. */}
          {links.length > 0 && (
            <div dir="ltr" className={`grid gap-3 mb-3 px-1.5 ${links.length === 1 ? 'grid-cols-1' : links.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
              {links.map((w, i) => (
                <a
                  key={i}
                  href={w.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="h-7 rounded-full border border-white/15 bg-transparent flex items-center justify-center gap-1.5 px-2.5 text-zinc-200 active:scale-[0.98] transition-transform min-w-0"
                >
                  <WidgetIcon name={w.icon} className="w-3 h-3 shrink-0 text-zinc-400" />
                  <span className="text-[12px] font-medium truncate" dir="auto">{linkPillLabel(w)}</span>
                </a>
              ))}
            </div>
          )}

          {/* 6 — The merchant's three info cards: borderless filled tiles,
              content centered, the icon on the row's leading side. */}
          {facts.length > 0 && (
            <div dir="rtl" className={`grid gap-3 mb-4 ${facts.length === 1 ? 'grid-cols-1' : facts.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
              {facts.map((w, i) => (
                <div key={i} className="rounded-[10px] bg-white/[0.05] px-2 py-2.5 flex items-center justify-center gap-2 min-w-0">
                  <WidgetIcon name={w.icon} className="w-4 h-4 shrink-0 text-zinc-400" />
                  <div className="min-w-0">
                    <p className="text-zinc-100 text-[12.5px] font-medium truncate leading-tight">{w.title}</p>
                    {w.subtitle && <p className="text-zinc-500 text-[11px] truncate leading-tight">{w.subtitle}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* A closed store says so, without saying why — that is between the
              merchant and Levonis (§51). */}
          {!store.open && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 mb-4">
              <p className="text-amber-200/90 text-[12px]">
                {loc(
                  'هذا المتجر لا يستقبل طلبات حاليًا.',
                  'This store is not taking orders right now.',
                  'ئەم فرۆشگایە لە ئێستادا داواکاری وەرناگرێت.'
                )}
              </p>
            </div>
          )}

          {/* 7 — Actions, exactly two as drawn: the white contact button on
              the right, and the outlined follow pill on the left with the
              share link living inside the pill's far-left end. */}
          <div dir="rtl" className="flex gap-4 mb-4">
            <ContactButton merchantId={store.merchant.id} signedIn={!!user} onHost={!!hostStore} loc={loc} accentBtn={accent.btn} profileOnly={profileOnly} />
            <div className="relative flex-[1.08] min-w-0">
              <FollowButton merchantId={store.merchant.id} signedIn={!!user} loc={loc} accentChip={accent.chip} />
              <SharePin url={store.url} name={store.name} loc={loc} />
            </div>
          </div>

          {/* 8 — Tabs: spread across the width, white when active over an
              accent-colored underline. */}
          {/* The active tab used to be a `border-b-2` on the button itself, so
              the underline was destroyed under one tab and built under the
              next — no movement, nothing saying these are one row. It is now a
              single element that travels along the strip as a spring, which is
              also what makes it interruptible: tap three tabs quickly and it
              chases the finger instead of queueing. */}
          <div dir="rtl" className="border-b border-white/10 mb-4 overflow-x-auto hide-scrollbar">
            <TabStrip
              group="storefront"
              label={loc('أقسام المتجر', 'Store sections', 'بەشەکانی فرۆشگا')}
              value={tab}
              onChange={(id) => setTab(id as Tab)}
              items={TABS.map((t) => ({ id: t.id, label: t.label, show: t.show }))}
              indicatorClassName={accent.indicator}
              idleClassName="text-zinc-500"
              className="min-w-full"
            />
          </div>
        </div>
      </div>

      {/* 9 — Tab bodies. z-0, deliberately below the header's z-10 subtree:
          the ... menu's close-backdrop lives inside that subtree, and being
          a sibling stacking context at the same level would paint this whole
          block over it — taps meant to dismiss the menu would open products. */}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 relative z-0">
        {/* The body arrives from the side the change came from and the old one
            leaves the other way, so a person can tell which direction they
            moved along the strip. The order is TABS' own order, and the sign
            mirrors with the writing direction rather than assuming Latin. */}
        <TabPanels value={tab} order={TABS.map((t) => t.id)}>
        {tab === 'products' && (
          <ProductsTab
            slug={slug}
            open={!!store.open}
            sections={sections}
            sectionFilter={sectionFilter}
            onClearSection={() => setSectionFilter('')}
            accentText={accent.text}
            savedIds={savedIds}
            onToggleSave={toggleSave}
            injected={profileOnly ? (profileProducts ?? []) : undefined}
          />
        )}
        {tab === 'sections' && (
          <SectionsTab
            sections={sections}
            onPick={(id) => {
              setSectionFilter(id);
              setTab('products');
            }}
          />
        )}
        {tab === 'deals' && <DealsTab slug={slug} open={!!store.open} savedIds={savedIds} onToggleSave={toggleSave} />}
        {tab === 'services' && <ServicesTab services={services} merchantId={store.merchant.id} onHost={!!hostStore} accepts={store.accepts_custom_requests} />}
        {tab === 'showcase' && <ShowcaseTab items={showcase} />}
        {tab === 'about' && (
          <div className="space-y-4">
            <AboutTab store={store} />
            {/* Store reviews are slug-scoped; a profile-only merchant has no
                review history to show, and an empty promise helps nobody. */}
            {!profileOnly && (
              <div>
                <h2 className="text-white font-bold text-[15px] mb-3">{loc('التقييمات', 'Reviews', 'هەڵسەنگاندنەکان')}</h2>
                <ReviewsTab slug={slug} />
              </div>
            )}
          </div>
        )}
        </TabPanels>
      </div>
    </div>
  );
}

function ProfileStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex-1 py-1 px-1 text-center min-w-0">
      <div className="text-white font-bold text-[14px] leading-tight" dir="ltr">{value}</div>
      <div className="text-zinc-500 text-[11px] truncate">{label}</div>
    </div>
  );
}

/** «انضم في أغسطس 2026» — the joined line a profile-only merchant shows
 *  where a store would show its @address. */
function joinedLine(
  createdAt: string,
  loc: (ar: string, en: string, ckb?: string) => string,
  lang: string
): string {
  if (!createdAt) return loc('تاجر مجتمع', 'Community merchant', 'بازرگانی کۆمەڵگا');
  const when = new Date(createdAt).toLocaleDateString(lang === 'en' ? 'en-US' : 'ar-IQ', {
    year: 'numeric',
    month: 'long',
  });
  return `${loc('انضم في', 'Joined', 'بەشداری کرد لە')} ${when}`;
}

/**
 * The profile's price line, written the way the reference writes it:
 * the dinar marker «ع.» immediately left of the western digits. The flex
 * row makes that ordering deterministic — bidi resolution never gets a say.
 */
function DinarPrice({ amount, className = '' }: { amount: number; className?: string }) {
  return (
    <span className={`inline-flex flex-row items-baseline ${className}`} dir="ltr">
      <span>ع.</span>
      <span>{Number(amount).toLocaleString('en-US')}</span>
    </span>
  );
}

/**
 * What a link pill SAYS must not contradict where it GOES. A free-text title
 * («تابعنا على إنستغرام») shows as written; a title that reads like an
 * address but names a different host than the real destination is replaced
 * by the destination's own host — a platform-branded page must not lend its
 * trust to «instagram.com/…» pointing somewhere else.
 */
function linkPillLabel(w: ProfileWidget): string {
  if (!w.url) return w.title;
  let host = '';
  try {
    host = new URL(w.url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return w.title;
  }
  const looksLikeAddress = /^[^\s]+\.[^\s]{2,}/.test(w.title.trim());
  if (looksLikeAddress && host && !w.title.toLowerCase().includes(host)) return host;
  return w.title;
}

/**
 * The info cards, with an honest fallback: until the merchant arranges their
 * own three, the store's existing facts fill the row (location, coverage,
 * delivery note) — real values, never invented ones.
 */
function factsWithFallback(
  store: MerchantStore,
  loc: (ar: string, en: string, ckb?: string) => string,
  lang: string
): ProfileWidget[] {
  // Once the merchant has arranged this row at all, their arrangement is
  // final — hiding every card means an intentionally empty row, and the
  // fallback must not resurrect what they removed.
  if (store.profile_facts_configured) {
    return (store.profile_facts ?? []).filter((w) => w.visible !== false).slice(0, 3);
  }

  const out: ProfileWidget[] = [];
  if (store.governorate) {
    const gov = GOVERNORATE_LABELS[store.governorate]?.[lang === 'ckb' ? 'ckb' : lang === 'en' ? 'en' : 'ar'] ?? store.governorate;
    out.push({ icon: 'map-pin', title: gov, subtitle: loc('الموقع', 'Location', 'شوێن'), visible: true });
  }
  if ((store.service_areas?.length ?? 0) > 0) {
    out.push({
      icon: 'truck',
      title: loc('شحن إلى', 'Ships to', 'گەیاندن بۆ'),
      subtitle: store.service_areas.slice(0, 2).join('، '),
      visible: true,
    });
  }
  const note = (store.delivery_settings as Record<string, unknown> | undefined)?.note;
  if (typeof note === 'string' && note) {
    out.push({ icon: 'clock', title: loc('التوصيل', 'Delivery', 'گەیاندن'), subtitle: note, visible: true });
  }
  return out.slice(0, 3);
}

// --------------------------------------------------------------- products

function ProductsTab({
  slug,
  open,
  sections,
  sectionFilter,
  onClearSection,
  accentText,
  savedIds,
  onToggleSave,
  injected,
}: {
  slug: string;
  open: boolean;
  sections: StoreSection[];
  sectionFilter: string;
  onClearSection: () => void;
  accentText: string;
  savedIds: Set<string>;
  onToggleSave: (id: string) => void;
  /** Profile-only mode: the merchant's legacy products, already loaded. */
  injected?: MerchantProduct[];
}) {
  const { loc, lang } = useLanguage();
  const [products, setProducts] = useState<MerchantProduct[] | null>(injected ?? null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // The shelf filter is a SERVER query — one loaded page must never decide
  // what a whole section appears to contain.
  const sectionParam = sectionFilter ? `?section=${encodeURIComponent(sectionFilter)}` : '';

  useEffect(() => {
    if (injected) {
      setProducts(injected);
      setCursor(null);
      return;
    }
    let alive = true;
    setProducts(null);
    storefrontApi
      .products(slug, sectionParam)
      .then((d) => {
        if (!alive) return;
        setProducts(d.products);
        setCursor(d.next_cursor);
      })
      .catch(() => alive && setProducts([]));
    return () => {
      alive = false;
    };
  }, [slug, sectionParam, injected]);

  async function loadMore() {
    if (!cursor) return;
    setMore(true);
    try {
      const d = await storefrontApi.products(
        slug,
        `${sectionParam || '?'}${sectionParam ? '&' : ''}cursor=${encodeURIComponent(cursor)}`
      );
      setProducts((p) => [...(p ?? []), ...d.products]);
      setCursor(d.next_cursor);
    } catch {
      /* keep the page we have */
    } finally {
      setMore(false);
    }
  }

  if (products === null) {
    return (
      <div className="py-10 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  }

  const sectionName = sectionFilter
    ? (() => {
        const s = sections.find((x) => x.id === sectionFilter);
        return s ? (lang === 'en' || !s.name_ar ? s.name : s.name_ar) : '';
      })()
    : '';

  if (!products.length) {
    return (
      <div>
        {sectionFilter && (
          <button
            onClick={onClearSection}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-xl bg-white/[0.05] border border-white/10 text-zinc-200 text-[12px] font-medium mb-3"
          >
            <span dir="auto">{sectionName}</span>
            <X className="w-3.5 h-3.5 text-zinc-500" />
          </button>
        )}
        <Empty
          icon={<ShoppingBag className="w-8 h-8 text-zinc-600" strokeWidth={1.5} />}
          text={
            sectionFilter
              ? loc('لا توجد منتجات في هذا القسم حاليًا', 'No products in this section right now', 'لەم بەشە بەرهەم نییە')
              : loc('لا توجد منتجات بعد', 'No products yet', 'هێشتا بەرهەم نییە')
          }
        />
      </div>
    );
  }

  // The merchant's featured picks lead; within that, the server's order.
  const sorted = [...products].sort((a, b) => Number(!!b.featured) - Number(!!a.featured));
  const revealed = showAll || sectionFilter ? sorted : sorted.slice(0, 6);

  return (
    <div>
      <div dir="rtl" className="flex items-center justify-between mb-3">
        {sectionFilter ? (
          <button
            onClick={onClearSection}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-xl bg-white/[0.05] border border-white/10 text-zinc-200 text-[12px] font-medium"
          >
            <span dir="auto">{sectionName}</span>
            <X className="w-3.5 h-3.5 text-zinc-500" />
          </button>
        ) : (
          <h2 className="text-white font-bold text-[16px]">
            {loc('أحدث المنتجات', 'Latest products', 'نوێترین بەرهەمەکان')}
          </h2>
        )}
        {!sectionFilter && (sorted.length > 6 || cursor) && (
          <button onClick={() => setShowAll((v) => !v)} className={`text-[13px] font-medium ${accentText}`}>
            {showAll ? loc('عرض أقل', 'Show less', 'کەمتر') : loc('عرض الكل', 'View all', 'هەموو ببینە')}
          </button>
        )}
      </div>

      <ProductGrid slug={slug} products={revealed} storeOpen={open} savedIds={savedIds} onToggleSave={onToggleSave} legacyLinks={!!injected} />

      {cursor && (showAll || sectionFilter) && (
        <button
          onClick={loadMore}
          disabled={more}
          className="w-full h-10 mt-3 rounded-xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[12.5px] font-medium disabled:opacity-50"
        >
          {more ? loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…') : loc('عرض المزيد', 'Show more', 'زیاتر')}
        </button>
      )}
    </div>
  );
}

function ProductGrid({
  slug,
  products,
  storeOpen,
  savedIds,
  onToggleSave,
  legacyLinks = false,
}: {
  slug: string;
  products: MerchantProduct[];
  storeOpen: boolean;
  savedIds: Set<string>;
  onToggleSave: (id: string) => void;
  legacyLinks?: boolean;
}) {
  return (
    <div dir="rtl" className="grid grid-cols-3 sm:grid-cols-4 gap-2.5">
      {products.map((p) => (
        <ProductCard
          key={p.id}
          slug={slug}
          product={p}
          storeOpen={storeOpen}
          saved={savedIds.has(p.id)}
          onToggleSave={onToggleSave}
          legacyLink={legacyLinks}
        />
      ))}
    </div>
  );
}

function ProductCard({
  slug,
  product,
  storeOpen,
  saved,
  onToggleSave,
  legacyLink = false,
}: {
  slug: string;
  product: MerchantProduct;
  storeOpen: boolean;
  saved: boolean;
  onToggleSave: (id: string) => void;
  legacyLink?: boolean;
}) {
  const { loc } = useLanguage();
  const { store: hostStore } = useStore();
  // On a merchant host the shop IS the site, so the product lives at /p/...
  // On the main site it needs the store in the path. A profile-only
  // merchant's legacy products keep their historical /product/:slug page.
  const href = legacyLink
    ? `/product/${product.slug}`
    : hostStore
      ? `/p/${product.slug}`
      : `/community/store/${slug}/p/${product.slug}`;
  const image = product.images[0];
  const discounted = product.original_price_iqd && product.original_price_iqd > product.price_iqd;
  const sellable = storeOpen && product.in_stock !== false;

  return (
    <Link
      to={href}
      className="rounded-[10px] bg-white/[0.04] overflow-hidden active:scale-[0.98] transition-transform"
    >
      <div className="aspect-square bg-black/40 overflow-hidden relative">
        {image ? (
          <img src={image} alt={product.name} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ShoppingBag className="w-5 h-5 text-zinc-700" strokeWidth={1.5} />
          </div>
        )}
        {/* The heart lives on the image's physical top-left, as drawn. */}
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleSave(product.id);
          }}
          className="absolute top-1.5 left-1.5 w-[22px] h-[22px] rounded-full bg-[#10161f]/85 flex items-center justify-center"
          aria-label={saved ? loc('إزالة من المحفوظات', 'Remove from saved', 'لابردن') : loc('حفظ المنتج', 'Save product', 'پاشەکەوتکردن')}
        >
          <Heart className={`w-3 h-3 ${saved ? 'text-rose-500 fill-rose-500' : 'text-white'}`} strokeWidth={2} />
        </button>
        {discounted && (
          <span className="absolute top-1.5 right-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/85 text-white" dir="ltr">
            −{Math.round((1 - product.price_iqd / (product.original_price_iqd as number)) * 100)}%
          </span>
        )}
        {!sellable && (
          <span className="absolute bottom-1 start-1 text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-zinc-800/90 text-zinc-300">
            {loc('غير متوفر', 'Unavailable', 'بەردەست نییە')}
          </span>
        )}
      </div>
      <div className="p-2">
        <p className="text-zinc-300 text-[12.5px] truncate leading-snug" dir="auto">{product.name}</p>
        {/* One price line that never wraps — the −% badge already tells the
            deal story on a card this narrow. */}
        <p className="text-zinc-400 text-[12px] whitespace-nowrap mt-0.5">
          <DinarPrice amount={product.price_iqd} />
        </p>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------- sections

function SectionsTab({ sections, onPick }: { sections: StoreSection[]; onPick: (id: string) => void }) {
  const { loc, lang } = useLanguage();
  return (
    <div dir="rtl" className="space-y-2">
      {sections.map((s) => (
        <button
          key={s.id}
          onClick={() => onPick(s.id)}
          className="w-full h-12 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 flex items-center justify-between gap-2 active:scale-[0.99] transition-transform"
        >
          <span className="text-zinc-100 text-[13px] font-medium truncate">
            {lang === 'en' || !s.name_ar ? s.name : s.name_ar}
          </span>
          <span className="flex items-center gap-1.5 shrink-0 text-zinc-500">
            <span className="text-[11px]">
              {s.product_count} {loc('منتج', 'products', 'بەرهەم')}
            </span>
            <ChevronLeft className="w-4 h-4 ltr:rotate-180" strokeWidth={1.75} />
          </span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- deals

function DealsTab({
  slug,
  open,
  savedIds,
  onToggleSave,
}: {
  slug: string;
  open: boolean;
  savedIds: Set<string>;
  onToggleSave: (id: string) => void;
}) {
  const { loc } = useLanguage();
  const [products, setProducts] = useState<MerchantProduct[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let alive = true;
    storefrontApi
      .products(slug, '?deals=1')
      .then((d) => {
        if (!alive) return;
        setProducts(d.products);
        setCursor(d.next_cursor);
      })
      .catch(() => alive && setProducts([]));
    return () => {
      alive = false;
    };
  }, [slug]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await storefrontApi.products(slug, `?deals=1&cursor=${encodeURIComponent(cursor)}`);
      setProducts((prev) => [...(prev ?? []), ...d.products]);
      setCursor(d.next_cursor);
    } catch {
      /* keep what we have */
    } finally {
      setLoadingMore(false);
    }
  }

  if (products === null) {
    return (
      <div className="py-10 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  }
  if (!products.length) {
    return <Empty icon={<Star className="w-8 h-8 text-zinc-600" strokeWidth={1.5} />} text={loc('لا توجد عروض حالية', 'No current deals', 'ئۆفەر نییە')} />;
  }
  return (
    <div className="space-y-3">
      <ProductGrid slug={slug} products={products} storeOpen={open} savedIds={savedIds} onToggleSave={onToggleSave} />
      {cursor && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full h-9 rounded-xl border border-zinc-800 text-[12px] text-zinc-300 hover:border-zinc-700 disabled:opacity-50"
        >
          {loadingMore ? loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…') : loc('عرض المزيد', 'Show more', 'زیاتر ببینە')}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- services

const SERVICE_KIND_META: Record<string, { icon: React.ReactNode; ar: string; en: string; ckb: string }> = {
  print_service: { icon: <Printer className="w-3 h-3" />, ar: 'طباعة حسب الطلب', en: 'Print on demand', ckb: 'چاپ بەپێی داوا' },
  design: { icon: <Hammer className="w-3 h-3" />, ar: 'تصميم ونمذجة', en: 'Design & modelling', ckb: 'دیزاین' },
  finishing: { icon: <Layers className="w-3 h-3" />, ar: 'تشطيب ومعالجة', en: 'Finishing', ckb: 'تەواوکاری' },
  scanning: { icon: <Layers className="w-3 h-3" />, ar: 'مسح ثلاثي الأبعاد', en: '3D scanning', ckb: 'سکانی 3D' },
  repair: { icon: <Hammer className="w-3 h-3" />, ar: 'صيانة وإصلاح', en: 'Repair', ckb: 'چاککردنەوە' },
  other: { icon: <Hammer className="w-3 h-3" />, ar: 'خدمة', en: 'Service', ckb: 'خزمەتگوزاری' },
};

function ServicesTab({
  services,
  merchantId,
  onHost,
  accepts,
}: {
  services: StoreService[];
  merchantId: string;
  onHost: boolean;
  accepts: boolean;
}) {
  const { loc } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();
  const requestsHref = onHost ? `${MAIN_SITE}/requests` : '/requests';

  async function openChat() {
    if (!user) {
      window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    try {
      const r = await api.post<{ chatId: string }>('/api/chats/open', { merchantId });
      if (onHost) window.location.href = `${MAIN_SITE}/chat/${r.chatId}`;
      else navigate(`/chat/${r.chatId}`);
    } catch (e) {
      if (e instanceof ApiError) alert(e.message);
    }
  }

  return (
    <div className="space-y-3">
      {services.map((s) => {
        const meta = SERVICE_KIND_META[s.kind] ?? SERVICE_KIND_META.other;
        return (
          <div key={s.id} className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
            {s.imageUrl && (
              <div className="aspect-[3/1] bg-black/40">
                <img src={s.imageUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
              </div>
            )}
            <div className="p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/10 text-zinc-300">
                  {meta.icon}
                  {loc(meta.ar, meta.en, meta.ckb)}
                </span>
              </div>
              <p className="text-white text-[13.5px] font-bold">{s.title}</p>
              {s.description && (
                <p className="text-zinc-400 text-[12px] leading-relaxed mt-1 whitespace-pre-wrap">{s.description}</p>
              )}
              {s.materials.length > 0 && (
                <div className="flex gap-1 flex-wrap mt-2">
                  {s.materials.map((m) => (
                    <span key={m} className="text-[10px] px-2 py-0.5 rounded-full bg-black/40 border border-white/10 text-zinc-400" dir="ltr">
                      {m}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between gap-2 mt-2.5">
                <span className="text-[12.5px] font-bold text-gold" dir="ltr">
                  {s.price_from_iqd !== null
                    ? `${loc('يبدأ من', 'From', 'لە')} ${iqd(s.price_from_iqd)}${s.price_unit ? ` / ${s.price_unit}` : ''}`
                    : loc('السعر حسب الطلب', 'Quoted per job', 'نرخ بەپێی داوا')}
                </span>
              </div>
            </div>
          </div>
        );
      })}

      {/* The real doors to buying a service: a priced quote through the
          request board (escrow-protected), or a direct conversation. */}
      <div className="grid grid-cols-2 gap-2">
        {accepts && (
          <a
            href={requestsHref}
            className="h-10 rounded-xl bg-olive text-white font-bold text-[12px] flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
          >
            <Hammer className="w-3.5 h-3.5" />
            {loc('اطلب عرض سعر', 'Request a quote', 'داوای نرخ بکە')}
          </a>
        )}
        <button
          onClick={openChat}
          className={`h-10 rounded-xl border border-white/10 bg-white/[0.03] text-zinc-200 font-bold text-[12px] flex items-center justify-center gap-1.5 ${accepts ? '' : 'col-span-2'}`}
        >
          <MessageCircle className="w-3.5 h-3.5" />
          {loc('مراسلة المتجر', 'Message the store', 'نامە بۆ فرۆشگا')}
        </button>
      </div>
      {accepts && (
        <p className="text-zinc-600 text-[10.5px] text-center">
          {loc(
            'عروض الأسعار تمر عبر منصة ليفونيس والمبلغ يبقى محجوزًا حتى استلامك.',
            'Quotes go through Levonis and your money stays held until you receive the work.',
            'نرخەکان بە ڕێگای LEVONIS دەبن و پارەکەت پارێزراوە.'
          )}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- showcase

function ShowcaseTab({ items }: { items: ShowcaseItem[] }) {
  const { loc } = useLanguage();
  const groups: Array<{ kind: ShowcaseItem['kind']; icon: React.ReactNode; title: string }> = [
    { kind: 'work', icon: <Hammer className="w-3.5 h-3.5" />, title: loc('من أعمالنا', 'Our work', 'لە کارەکانمان') },
    { kind: 'printer', icon: <Printer className="w-3.5 h-3.5" />, title: loc('طابعاتنا', 'Our printers', 'چاپکەرەکانمان') },
    { kind: 'material', icon: <Layers className="w-3.5 h-3.5" />, title: loc('الخامات التي نعمل بها', 'Materials we work with', 'کەرەستەکانمان') },
  ];

  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const group = items.filter((i) => i.kind === g.kind);
        if (!group.length) return null;
        return (
          <div key={g.kind}>
            <p className="text-zinc-300 text-[12.5px] font-bold mb-2 flex items-center gap-1.5">
              {g.icon}
              {g.title}
            </p>
            {g.kind === 'work' ? (
              <div className="grid grid-cols-2 gap-2">
                {group.map((it) => (
                  <div key={it.id} className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
                    <div className="aspect-square bg-black/40">
                      {it.imageUrl && <img src={it.imageUrl} alt={it.title} className="w-full h-full object-cover" loading="lazy" />}
                    </div>
                    <div className="p-2">
                      <p className="text-white text-[11.5px] font-semibold truncate">{it.title}</p>
                      {it.details && <p className="text-zinc-500 text-[10.5px] line-clamp-2">{it.details}</p>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {group.map((it) => (
                  <div key={it.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 flex items-center gap-2.5">
                    <div className="w-12 h-12 rounded-lg bg-black/40 overflow-hidden shrink-0 flex items-center justify-center">
                      {it.imageUrl ? (
                        <img src={it.imageUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        g.icon
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-white text-[12.5px] font-semibold truncate" dir="ltr">{it.title}</p>
                      {it.details && <p className="text-zinc-500 text-[11px] line-clamp-2">{it.details}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- reviews

function ReviewsTab({ slug }: { slug: string }) {
  const { loc } = useLanguage();
  const [data, setData] = useState<Awaited<ReturnType<typeof storefrontApi.reviews>> | null>(null);

  useEffect(() => {
    let alive = true;
    storefrontApi
      .reviews(slug)
      .then((d) => alive && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [slug]);

  if (!data) {
    return (
      <div className="py-10 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  }

  if (!data.count) {
    return (
      <Empty
        icon={<Star className="w-8 h-8 text-zinc-600" strokeWidth={1.5} />}
        text={loc('لا توجد تقييمات بعد', 'No reviews yet', 'هێشتا هەڵسەنگاندن نییە')}
        hint={loc(
          'التقييمات تأتي من طلبات مكتملة فقط.',
          'Reviews come only from completed orders.',
          'هەڵسەنگاندنەکان تەنها لە داواکاریە تەواوکراوەکانەوە دێن.'
        )}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
        <div className="flex items-center gap-4">
          <div className="text-center shrink-0">
            <div className="text-gold font-bold text-xl">{data.average?.toFixed(1)}</div>
            <div className="text-zinc-500 text-[10.5px]">
              {loc(`${data.count} تقييم`, `${data.count} reviews`, `${data.count} هەڵسەنگاندن`)}
            </div>
          </div>
          <div className="flex-1 space-y-1">
            {[5, 4, 3, 2, 1].map((n) => {
              const count = data.distribution[String(n)] ?? 0;
              const pct = data.count ? (count / data.count) * 100 : 0;
              return (
                <div key={n} className="flex items-center gap-2" dir="ltr">
                  <span className="text-zinc-500 text-[10px] w-3">{n}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <div className="h-full bg-gold/70 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-zinc-600 text-[10px] w-6 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {data.reviews.map((r) => (
        <div key={String(r.id)} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-white text-[12.5px] font-semibold truncate">{String(r.customer_name)}</span>
              {/* Every review here came from a completed transaction — the
                  database will not hold one that did not. */}
              <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                {loc('شراء موثّق', 'Verified', 'کڕینی پشتڕاستکراو')}
              </span>
            </div>
            <div className="flex gap-0.5 shrink-0">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star
                  key={n}
                  className={`w-3 h-3 ${n <= Number(r.rating) ? 'text-gold fill-gold' : 'text-zinc-700'}`}
                />
              ))}
            </div>
          </div>
          {!!r.body && <p className="text-zinc-300 text-[12.5px] leading-relaxed">{String(r.body)}</p>}
          {!!r.merchant_reply && (
            <div className="mt-2.5 ps-3 border-s-2 border-gold/30">
              <p className="text-gold/80 text-[10.5px] font-semibold mb-0.5">
                {loc('رد البائع', 'Seller reply', 'وەڵامی فرۆشیار')}
              </p>
              <p className="text-zinc-400 text-[12px] leading-relaxed">{String(r.merchant_reply)}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ about

function AboutTab({ store }: { store: MerchantStore }) {
  const { loc, lang } = useLanguage();
  const policies = useMemo(() => Object.entries(store.policies ?? {}), [store.policies]);
  const socials = useMemo(() => Object.entries(store.social_links ?? {}), [store.social_links]);
  const delivery = (store.delivery_settings ?? {}) as Record<string, unknown>;
  const deliveryNote = typeof delivery.note === 'string' ? delivery.note : '';

  return (
    <div className="space-y-3">
      {store.description && (
        <Section title={loc('عن المتجر', 'About the store', 'دەربارەی فرۆشگا')}>
          <p className="text-zinc-300 text-[12.5px] leading-relaxed whitespace-pre-wrap">{store.description}</p>
        </Section>
      )}

      {(store.categories?.length ?? 0) > 0 && (
        <Section title={loc('التخصصات', 'Specialities', 'پسپۆڕییەکان')}>
          <div className="flex flex-wrap gap-1.5">
            {store.categories.map((cat) => (
              <span key={cat} className="text-[11px] px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300">
                {cat}
              </span>
            ))}
          </div>
        </Section>
      )}

      {(store.service_areas?.length ?? 0) > 0 && (
        <Section title={loc('مناطق التغطية', 'Service areas', 'ناوچەکانی گەیاندن')}>
          <div className="flex flex-wrap gap-1.5">
            {store.service_areas.map((a) => (
              <span key={a} className="text-[11px] px-2.5 py-1 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 inline-flex items-center gap-1">
                <MapPin className="w-3 h-3 text-zinc-500" />
                {a}
              </span>
            ))}
          </div>
        </Section>
      )}

      {deliveryNote && (
        <Section title={loc('التوصيل', 'Delivery', 'گەیاندن')}>
          <p className="text-zinc-300 text-[12.5px] leading-relaxed">{deliveryNote}</p>
        </Section>
      )}

      {store.business_hours.length > 0 && (
        <Section title={loc('ساعات العمل', 'Business hours', 'کاتژمێری کارکردن')}>
          <div className="space-y-1.5">
            {store.business_hours.map((h, i) => (
              <div key={i} className="flex items-center justify-between text-[12px]">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  {typeof h === 'string' ? h : h.day}
                </span>
                {typeof h !== 'string' && (
                  <span className="text-zinc-300" dir="ltr">
                    {h.open} – {h.close}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {store.contact_phone && (
        <Section title={loc('التواصل', 'Contact', 'پەیوەندی')}>
          <a href={`tel:${store.contact_phone}`} className="text-gold text-[13px] font-semibold" dir="ltr">
            {store.contact_phone}
          </a>
        </Section>
      )}

      {policies.length > 0 && (
        <Section title={loc('سياسات المتجر', 'Store policies', 'سیاسەتەکانی فرۆشگا')}>
          <div className="space-y-2.5">
            {policies.map(([k, v]) => (
              <div key={k}>
                <p className="text-zinc-400 text-[11.5px] font-semibold mb-0.5">{k}</p>
                <p className="text-zinc-300 text-[12px] leading-relaxed whitespace-pre-wrap">{v}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {socials.length > 0 && (
        <Section title={loc('روابط', 'Links', 'بەستەرەکان')}>
          <div className="flex flex-wrap gap-2">
            {socials.map(([k, v]) => (
              // The server already reduced these to http(s) URLs, so a
              // javascript: href in a store profile cannot reach here.
              <a
                key={k}
                href={v}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-[11.5px] px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300"
              >
                {k}
              </a>
            ))}
          </div>
        </Section>
      )}

      {store.created_at && (
        <p className="text-zinc-600 text-[11px] text-center pt-1">
          {loc('على ليفونيس منذ', 'On Levonis since', 'لەسەر LEVONIS لە')}{' '}
          {new Date(store.created_at).toLocaleDateString(lang === 'en' ? 'en-US' : 'ar-IQ', {
            year: 'numeric',
            month: 'long',
          })}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ bits

function FollowButton({
  merchantId,
  signedIn,
  loc,
  accentChip,
}: {
  merchantId: string;
  signedIn: boolean;
  loc: (ar: string, en: string, ckb?: string) => string;
  accentChip: string;
}) {
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);

  // Hydrated from the server: a visitor who already follows this shop must
  // see "Following", not a button that lies until it is pressed.
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    api
      .get<{ following: Array<{ merchant_id: string }> }>('/api/community-reviews/following')
      .then((d) => alive && setFollowing(d.following.some((f) => f.merchant_id === merchantId)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [signedIn, merchantId]);

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
      disabled={busy}
      className={`w-full h-[30px] rounded-full font-medium text-[13px] flex items-center justify-center gap-1.5 px-9 active:scale-[0.98] transition-all disabled:opacity-50 ${
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
  loc: (ar: string, en: string, ckb?: string) => string;
  accentBtn: string;
  profileOnly?: boolean;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function open() {
    if (!signedIn) {
      window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ chatId: string }>('/api/chats/open', { merchantId });
      if (onHost) window.location.href = `${MAIN_SITE}/chat/${r.chatId}`;
      else navigate(`/chat/${r.chatId}`);
    } catch (e) {
      if (e instanceof ApiError) alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={open}
      disabled={busy}
      className={`flex-1 h-[30px] rounded-xl font-semibold text-[13px] flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform disabled:opacity-50 ${accentBtn}`}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageCircleMore className="w-3.5 h-3.5" strokeWidth={1.75} />}
      {/* A profile with no store behind it is a person to talk to, and the
          «مراسلة» name is a pinned contract for that page. */}
      {profileOnly
        ? loc('مراسلة', 'Message', 'نامە')
        : loc('تواصل مع المتجر', 'Contact the store', 'پەیوەندی بە فرۆشگا')}
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
function SharePin({
  url,
  name,
  loc,
}: {
  url: string;
  name: string;
  loc: (ar: string, en: string, ckb?: string) => string;
}) {
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
      className="absolute left-0 top-0 h-[30px] w-9 rounded-full flex items-center justify-center text-zinc-300 active:scale-[0.9] transition-transform"
      aria-label={loc('مشاركة المتجر', 'Share the store', 'هاوبەشکردن')}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" strokeWidth={1.75} /> : <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} />}
    </button>
  );
}

/** The «…» over the cover: share and copy-link, both real. */
function StoreMenu({
  url,
  name,
  loc,
}: {
  url: string;
  name: string;
  loc: (ar: string, en: string, ckb?: string) => string;
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
    <div className="absolute top-3 right-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-[30px] h-[30px] rounded-full border border-white/20 bg-white/5 backdrop-blur flex items-center justify-center text-white"
        aria-label={loc('خيارات المتجر', 'Store options', 'هەڵبژاردەکان')}
      >
        <MoreHorizontal className="w-4 h-4" strokeWidth={1.75} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-[34px] right-0 z-30 w-44 rounded-xl border border-white/10 bg-[#131417] shadow-2xl overflow-hidden">
            <button onClick={share} className="w-full text-start px-3.5 py-2.5 text-[12.5px] text-zinc-200 active:bg-white/10">
              {loc('مشاركة المتجر', 'Share the store', 'هاوبەشکردنی فرۆشگا')}
            </button>
            <button onClick={copy} className="w-full text-start px-3.5 py-2.5 text-[12.5px] text-zinc-200 active:bg-white/10 border-t border-white/5">
              {copied ? loc('تم النسخ ✓', 'Copied ✓', 'کۆپی کرا ✓') : loc('نسخ الرابط', 'Copy the link', 'کۆپی بەستەر')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
      <h3 className="text-gold font-bold text-[12.5px] mb-2.5">{title}</h3>
      {children}
    </div>
  );
}

function Empty({ icon, text, hint }: { icon: React.ReactNode; text: string; hint?: string }) {
  return (
    <div className="py-12 text-center">
      <div className="flex justify-center mb-3">{icon}</div>
      <p className="text-zinc-400 text-[13px]">{text}</p>
      {hint && <p className="text-zinc-600 text-[11.5px] mt-1.5">{hint}</p>}
    </div>
  );
}
