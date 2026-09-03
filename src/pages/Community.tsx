import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { STUDIO_URL } from '../translations';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
import { TabStrip, TabPanels } from '../components/ui/Tabs';
import { api, ApiError, formatIqd } from '../lib/api';
import { storeHref } from '../lib/merchant';
import {
  ArrowLeft, ArrowRight, Search, Box, Calculator,
  MessageSquare, Plus, Store,
  BadgeCheck, X
} from 'lucide-react';

interface CommunityProduct {
  id: string;
  slug: string;
  merchant_id: string;
  name: string;
  name_ar: string;
  description: string;
  images: string[];
  price_iqd: number;
  original_price_iqd: number | null;
  created_at: string;
}

interface CommunityMerchant {
  id: string;
  name: string;
  bio: string;
  avatarUrl: string | null;
  verified: boolean;
  created_at: string;
  store_slug?: string | null;
  /** The shop's own address — a card click is a full navigation there. */
  store_url?: string | null;
}

interface CommunityRequest {
  id: string;
  title: string;
  description: string;
  status: string;
  customer_username: string | null;
  created_at: string;
}

export default function Community() {
  const navigate = useNavigate();
  const location = useLocation();
  const { lang, dir, t } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();

  const queryParams = new URLSearchParams(location.search);
  const activeTab = queryParams.get('tab') || 'products';

  const [products, setProducts] = useState<CommunityProduct[]>([]);
  const [merchants, setMerchants] = useState<CommunityMerchant[]>([]);
  const [requests, setRequests] = useState<CommunityRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // New-request modal state
  const [showNewRequest, setShowNewRequest] = useState(false);
  const [reqTitle, setReqTitle] = useState('');
  const [reqDescription, setReqDescription] = useState('');
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqError, setReqError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      setLoading(true);
      setLoadError(null);
      try {
        if (activeTab === 'products') {
          const data = await api.get<{ products: CommunityProduct[] }>('/api/community/products');
          if (!cancelled) setProducts(data.products || []);
        } else if (activeTab === 'merchants') {
          const data = await api.get<{ merchants: CommunityMerchant[] }>('/api/community/merchants');
          if (!cancelled) setMerchants(data.merchants || []);
        } else if (activeTab === 'requests') {
          const data = await api.get<{ requests: CommunityRequest[] }>('/api/community/requests');
          if (!cancelled) setRequests(data.requests || []);
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError && err.message
              ? err.message
              : dir === 'rtl' ? 'تعذر التحميل. حاول مرة أخرى.' : 'Failed to load. Please try again.'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadData();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const openNewRequest = () => {
    if (!isAuthenticated) {
      signIn();
      return;
    }
    setReqError(null);
    setShowNewRequest(true);
  };

  const submitNewRequest = async () => {
    if (reqTitle.trim().length < 3 || reqSubmitting) return;
    setReqSubmitting(true);
    setReqError(null);
    try {
      await api.post('/api/community/requests', { title: reqTitle.trim(), description: reqDescription.trim() });
      setShowNewRequest(false);
      setReqTitle('');
      setReqDescription('');
      // Refresh the requests list if it is the visible tab, otherwise take the user there.
      if (activeTab === 'requests') {
        try {
          const data = await api.get<{ requests: CommunityRequest[] }>('/api/community/requests');
          setRequests(data.requests || []);
        } catch {
          /* list refresh is best-effort */
        }
      } else {
        navigate('/community?tab=requests');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        signIn();
        return;
      }
      setReqError(
        err instanceof ApiError && err.message
          ? err.message
          : dir === 'rtl' ? 'تعذر إرسال الطلب' : 'Failed to submit request'
      );
    } finally {
      setReqSubmitting(false);
    }
  };

  const q = search.trim().toLowerCase();
  const filteredProducts = q
    ? products.filter(p => (p.name || '').toLowerCase().includes(q) || (p.name_ar || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q))
    : products;
  const filteredMerchants = q
    ? merchants.filter(m => (m.name || '').toLowerCase().includes(q) || (m.bio || '').toLowerCase().includes(q))
    : merchants;
  const filteredRequests = q
    ? requests.filter(r => (r.title || '').toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))
    : requests;

  const comingSoon = dir === 'rtl' ? 'قريباً' : 'Coming soon';

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen bg-black">
      {/* The search bar is FLOATING CHROME: content passes under it. It used
          to end in a 1px border, which is a line the design never asked for —
          what it was trying to say is "there is more below". A short gradient
          says that, and only where the overlap is real (`.scroll-edge`). */}
      <div className="material scroll-edge sticky top-0 z-40 [--material-tint:#000] px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          aria-label={dir === 'rtl' ? 'رجوع' : 'Back'}
          onClick={() => navigate(-1)}
          className="press-scale p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors"
        >
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <div className="flex-1 relative">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={dir === 'rtl' ? "بحث في المجتمع..." : "Search community..."}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-full py-2 px-4 ps-10 text-sm focus:outline-none focus:border-olive/50 text-white"
          />
          <Search className={`w-4 h-4 text-zinc-500 absolute top-2.5 ${dir === 'rtl' ? 'right-3' : 'left-3'}`} />
        </div>
      </div>

      <div className="p-4 flex flex-col gap-6">

        {/* Shortcuts. THESE ARE BUTTONS. They were `<div onClick>` with a
            `group-hover:` tint, which means: no keyboard access, no screen-
            reader role, and — on the iPad this app is actually used on — no
            feedback at all, because `hover:` does not exist on touch. A tile
            is small enough that shrinking reads as contact rather than as a
            wobble, so they take `press-scale` on top of the sitewide dim. */}
        <div className="grid grid-cols-4 gap-2">
           <button type="button" className="press-scale flex flex-col items-center gap-2 group" onClick={() => navigate('/chats')}>
             <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center group-hover:border-olive/50 transition-colors">
               <MessageSquare className="w-5 h-5 text-zinc-400 group-hover:text-olive transition-colors" />
             </div>
             <span className="text-[10px] font-medium text-zinc-400">{dir === 'rtl' ? 'الرسائل' : 'Messages'}</span>
           </button>
           <button type="button" className="press-scale flex flex-col items-center gap-2 group" onClick={() => navigate('/community?tab=requests')}>
             <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center group-hover:border-olive/50 transition-colors">
               <Box className="w-5 h-5 text-zinc-400 group-hover:text-olive transition-colors" />
             </div>
             <span className="text-[10px] font-medium text-zinc-400">{dir === 'rtl' ? 'الطلبات' : 'Requests'}</span>
           </button>
           <button type="button" className="press-scale flex flex-col items-center gap-2 group" onClick={openNewRequest}>
             <div className="w-12 h-12 rounded-2xl bg-olive/10 border border-olive/30 flex items-center justify-center group-hover:bg-olive/20 transition-colors">
               <Plus className="w-5 h-5 text-olive" />
             </div>
             <span className="text-[10px] font-medium text-olive">{dir === 'rtl' ? 'طلب جديد' : 'New Order'}</span>
           </button>
           <button type="button" className="press-scale flex flex-col items-center gap-2 group" onClick={() => navigate('/profile')}>
             <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center overflow-hidden">
               <img referrerPolicy="no-referrer" src={user?.avatar_key ? `/files/${user.avatar_key}` : `https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.username || "Levonis"}&backgroundColor=fde047`} alt="Avatar" className="w-full h-full object-cover" />
             </div>
             <span className="text-[10px] font-medium text-zinc-400">{dir === 'rtl' ? 'ملفي' : 'Profile'}</span>
           </button>
        </div>

        {/* Banners (mandate §9). The «المساعدات والهدايا» / Giveaways card is
            GONE and its slot belongs to LEVO Studio — the one real ACTIVE
            entry here: a plain full-page navigation to the standalone
            subdomain (STUDIO_URL, the single configurable constant in
            src/translations.ts). No iframe, no prefetch/preload, no slicer or
            3D code in this bundle (tests/store-isolation.test.ts pins all of
            that). The target stays the user's choice — the anchor does not
            force a new tab — and rel="noopener noreferrer" protects the
            opener if the user opens one themselves. A working href is NOT a
            claim that the Studio is deployed; publishing the Studio subdomain
            is a separate owner step (docs/DECISIONS.md row 30 covers that domain). The remaining
            cards are features not launched yet, shown honestly as coming soon. */}
        <div className="flex overflow-x-auto hide-scrollbar gap-3 -mx-4 px-4 snap-x pb-2">
           <a
             href={STUDIO_URL}
             target="_blank"
             data-testid="community-studio-link"
             rel="noopener noreferrer"
             aria-label={`${t('studioCardTitle')} — ${t('studioOpen')}`}
             className="shrink-0 w-[240px] h-24 rounded-2xl bg-gradient-to-r from-olive/25 to-black border border-olive/50 p-4 flex flex-col justify-center snap-start relative overflow-hidden hover:border-olive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold transition-colors"
           >
             <div className="absolute right-2 bottom-0 opacity-20">
               <Box aria-hidden="true" className="w-20 h-20 text-olive" />
             </div>
             <h3 className="text-white font-bold text-sm mb-1">{t('studioCardTitle')}</h3>
             <p className="text-xs text-olive font-medium">{t('studioOpen')}</p>
           </a>
           {/* Was a dead card. The calculator is real now — it prices from
               the shop's own filament, not from invented numbers. */}
           <button
             type="button"
             onClick={() => navigate('/tools')}
             className="shrink-0 w-[240px] h-24 rounded-2xl bg-gradient-to-r from-zinc-800 to-zinc-900 border border-zinc-700 p-4 flex flex-col justify-center snap-start relative overflow-hidden text-start hover:border-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold transition-colors"
           >
             <div className="absolute right-2 bottom-0 opacity-20">
               <Calculator className="w-20 h-20" />
             </div>
             <h3 className="text-white font-bold text-sm mb-1">{dir === 'rtl' ? 'احسب سعر طباعتك' : 'Calculate Print Price'}</h3>
             <p className="text-xs text-zinc-300">{dir === 'rtl' ? 'افتح الحاسبة' : 'Open the calculator'}</p>
           </button>
           <div className="shrink-0 w-[240px] h-24 rounded-2xl bg-gradient-to-r from-olive/20 to-black border border-olive/30 p-4 flex flex-col justify-center snap-start relative overflow-hidden opacity-70" aria-disabled="true">
             <div className="absolute right-2 bottom-0 opacity-20">
               <Box className="w-20 h-20 text-olive" />
             </div>
             <h3 className="text-white font-bold text-sm mb-1">{dir === 'rtl' ? 'مكتبة ملفات الطباعة' : '3D Models Library'}</h3>
             <p className="text-xs text-olive/70">{comingSoon}</p>
           </div>
        </div>

        {/* Explore Tabs. The underline is now ONE element that travels
            between them (TabStrip's shared-layout indicator) instead of three
            conditional divs that blink in and out — so the row reads as one
            row a person moved along, which is the whole job of an indicator. */}
        <div className="material material-thin scroll-edge sticky top-[60px] z-30 [--material-tint:#000]">
          <TabStrip
            group="community"
            label={dir === 'rtl' ? 'أقسام المجتمع' : 'Community sections'}
            value={activeTab}
            onChange={(id) => navigate(`/community?tab=${id}`)}
            items={[
              { id: 'products', label: dir === 'rtl' ? 'المنتجات' : 'Products' },
              { id: 'merchants', label: dir === 'rtl' ? 'التجار' : 'Merchants' },
              { id: 'requests', label: dir === 'rtl' ? 'الطلبات' : 'Requests' },
            ]}
            className="justify-between"
          />
        </div>

        {/* Tab Content */}
        <div className="min-h-[400px]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-500 gap-3">
              <p className="text-sm">{loadError}</p>
            </div>
          ) : (
            /* The bodies arrive from the side the change came from, and leave
               to the other — so a person can tell whether they went forward or
               back along the strip. In Arabic "forward" is leftward, which
               TabPanels takes from the writing direction rather than assuming. */
            <TabPanels value={activeTab} order={['products', 'merchants', 'requests']}>
              {activeTab === 'products' && (
                filteredProducts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
                    <Box className="w-12 h-12 mb-3 opacity-40" />
                    <p className="text-sm">{q ? (dir === 'rtl' ? 'لا توجد نتائج' : 'No results') : (dir === 'rtl' ? 'لا توجد منتجات بعد' : 'No products yet')}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {filteredProducts.map(p => {
                      const firstImage = (p.images && p.images[0]) || null;
                      const name = lang === 'ar' && p.name_ar ? p.name_ar : p.name;
                      return (
                        <Link to={`/product/${p.slug}`} key={p.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col group hover:border-olive/50 transition-colors">
                          <div className="relative aspect-square overflow-hidden bg-black">
                            {firstImage ? (
                              <img referrerPolicy="no-referrer" src={firstImage} alt={name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-zinc-700">
                                <Box className="w-10 h-10" />
                              </div>
                            )}
                          </div>
                          <div className="p-3">
                            <h3 className="text-white font-medium text-sm line-clamp-2 mb-1">{name}</h3>
                            <div className="text-white font-bold text-sm">{formatIqd(p.price_iqd || 0)}</div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )
              )}

              {activeTab === 'merchants' && (
                filteredMerchants.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
                    <Store className="w-12 h-12 mb-3 opacity-40" />
                    <p className="text-sm">{q ? (dir === 'rtl' ? 'لا توجد نتائج' : 'No results') : (dir === 'rtl' ? 'لا يوجد تجار بعد' : 'No merchants yet')}</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {filteredMerchants.map((m) => (
                      <div
                        key={m.id}
                        onClick={() => {
                          // A shop with its own subdomain IS its own site —
                          // it opens in ITS OWN TAB, leaving the directory
                          // where the visitor left it (the shared cookie
                          // keeps their session across the hop).
                          const href = storeHref(m.store_url, m.id);
                          if (href.startsWith('http')) window.open(href, '_blank', 'noopener,noreferrer');
                          else navigate(href);
                        }}
                        className="bg-zinc-900/40 border border-zinc-800/60 rounded-2xl p-4 flex flex-col gap-4 cursor-pointer hover:border-olive/50 transition-colors"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 bg-zinc-800 rounded-full overflow-hidden flex items-center justify-center border border-zinc-700 shrink-0">
                              {m.avatarUrl ? (
                                <img referrerPolicy="no-referrer" src={m.avatarUrl} alt={m.name} className="w-full h-full object-cover" />
                              ) : (
                                <Store className="w-5 h-5 text-zinc-500" />
                              )}
                            </div>
                            <div>
                              <div className="flex items-center gap-1.5">
                                <h3 className="text-white font-bold text-sm">{m.name}</h3>
                                {m.verified && <BadgeCheck className="w-4 h-4 text-gold" />}
                              </div>
                              {m.bio && <div className="text-xs text-zinc-400 mt-0.5 line-clamp-1">{m.bio}</div>}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="w-8 h-8 rounded-full border border-zinc-700 flex items-center justify-center text-zinc-400">
                              <Store className="w-4 h-4" />
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}

              {activeTab === 'requests' && (
                filteredRequests.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
                    <Box className="w-12 h-12 mb-3 opacity-40" />
                    <p className="text-sm">{q ? (dir === 'rtl' ? 'لا توجد نتائج' : 'No results') : (dir === 'rtl' ? 'لا توجد طلبات بعد' : 'No requests yet')}</p>
                    {!q && (
                      <button onClick={openNewRequest} className="mt-4 text-olive text-sm font-medium hover:text-olive/80">
                        {dir === 'rtl' ? 'أنشئ أول طلب' : 'Post the first request'}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {filteredRequests.map((r) => (
                      <div key={r.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
                         <h3 className="text-white font-medium mb-1">{r.title}</h3>
                         {r.description && <p className="text-sm text-zinc-400 mb-2 line-clamp-3">{r.description}</p>}
                         <div className="flex justify-between items-center text-xs text-zinc-500">
                           <span>{dir === 'rtl' ? 'بانتظار العروض' : 'Waiting for offers'}</span>
                           {r.customer_username && <span dir="ltr">@{r.customer_username}</span>}
                         </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </TabPanels>
          )}
        </div>

      </div>

      {/* New Request Modal */}
      {showNewRequest && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => !reqSubmitting && setShowNewRequest(false)}>
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-bold">{dir === 'rtl' ? 'طلب جديد' : 'New Request'}</h3>
              <button onClick={() => !reqSubmitting && setShowNewRequest(false)} className="p-1.5 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">{dir === 'rtl' ? 'العنوان' : 'Title'}</label>
                <input
                  type="text"
                  value={reqTitle}
                  onChange={(e) => setReqTitle(e.target.value)}
                  maxLength={150}
                  placeholder={dir === 'rtl' ? 'ماذا تحتاج؟' : 'What do you need?'}
                  className="w-full bg-black border border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-olive/50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1">{dir === 'rtl' ? 'الوصف (اختياري)' : 'Description (optional)'}</label>
                <textarea
                  value={reqDescription}
                  onChange={(e) => setReqDescription(e.target.value)}
                  maxLength={2000}
                  rows={4}
                  placeholder={dir === 'rtl' ? 'تفاصيل إضافية...' : 'More details...'}
                  className="w-full bg-black border border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-olive/50 resize-none"
                />
              </div>
              {reqError && <p className="text-xs text-red-400">{reqError}</p>}
              <button
                onClick={submitNewRequest}
                disabled={reqTitle.trim().length < 3 || reqSubmitting}
                className="w-full bg-olive text-black font-bold py-3 rounded-xl disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
              >
                {reqSubmitting ? (dir === 'rtl' ? 'جارٍ الإرسال...' : 'Submitting...') : (dir === 'rtl' ? 'إرسال الطلب' : 'Submit Request')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
