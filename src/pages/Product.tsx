/**
 * Product detail (integrated mandate §7).
 *
 * LAYOUT (§7.1)
 *  - Balanced gallery: ONE bounded box with fixed responsive dimensions, so
 *    nothing reflows while an image loads (SafeImage reserves the box and
 *    shows an explicit fallback). object-fit: contain — the product is never
 *    cropped in half nor stretched. Thumbnails follow the stored media order
 *    (primary first) and only the primary image is eager; the rest load lazily
 *    so they never delay the LCP image.
 *  - Wide screens: two columns (gallery | purchase panel) and the buy CTA
 *    lives INSIDE the purchase panel, which is sticky within its own column.
 *    There is no floating bar in the middle of the content on desktop.
 *  - Phones: ONE bottom purchase bar (lg:hidden) with safe-area padding, and
 *    the page reserves exactly its height so description/reviews are never
 *    covered. BottomNav does not render on /product/* (isBottomNavHidden), so
 *    there is no doubled floating button.
 *  - No ancestor transform/filter wraps the fixed bar (the old slide-up cart
 *    sheet translated the whole page, which is what broke fixed positioning);
 *    the page is a plain flow document inside #main-scroll-container.
 *
 * TRUTHFULNESS (§7.2)
 *  - Price, fees and availability come from the SERVER: `/api/products/:slug`
 *    for the base view and POST `/api/products/:slug/quote` for the selected
 *    option/color/transport/warranty. Nothing is recomputed in the browser,
 *    so the page can never disagree with what checkout charges.
 *  - Sale mode is the server's `availability.mode`: stock>0 → direct sale,
 *    admin-enabled pre-order with a usable transport → pre-order, otherwise
 *    an honest "unavailable" plus the machine reason. There is no manual
 *    direct/pre-order toggle that could contradict the catalogue.
 *  - A required option/colour must be chosen before any price or stock claim;
 *    changing it re-checks availability against the server.
 *  - Add-to-cart succeeds only after the server confirms, is guarded against
 *    double taps, and never silently splits a too-large quantity.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import {
  ArrowRight, ArrowLeft, ShoppingCart, Star, Check, Share2, Heart, Clock, Package,
  ChevronDown, Minus, Plus, X, FileText, Settings2, ShieldCheck, Truck,
  AlertTriangle, Store, ZoomIn, Image as ImageIcon,
} from 'lucide-react';
import { api, ApiError, CartItem, formatIqd } from '../lib/api';
import ReviewSection from '../components/reviews/ReviewSection';
import SafeImage from '../components/ui/SafeImage';
import { ProductDetailSkeleton } from '../components/ui/Skeleton';
import { ErrorState, NotFoundState } from '../components/ui/AsyncStates';
import { captureSupportRefFromSearch } from './Referrals';

// ------------------------------------------------------------------ strings

const STRINGS = {
  ar: {
    back: 'رجوع', share: 'مشاركة', linkCopied: 'تم نسخ الرابط', favorite: 'إضافة للمفضلة',
    unfavorite: 'إزالة من المفضلة', gallery: 'صور المنتج', noImages: 'لا توجد صور لهذا المنتج',
    imageOf: 'صورة {n} من {total}', zoom: 'تكبير الصورة', close: 'إغلاق',
    officialStore: 'المتجر الرسمي', communityStore: 'متجر مجتمع', visitStore: 'زيارة المتجر',
    price: 'السعر', from: 'يبدأ من', regularPrice: 'السعر العادي', proPrice: 'سعر أعضاء PRO',
    proApplied: 'سعر عضويتك PRO مطبّق', primeApplied: 'سعر عضويتك PRIME مطبّق', subscribe: 'اشترك الآن', updatingPrice: 'يجري تحديث السعر…',
    priceUnavailable: 'أكمل الاختيار لعرض السعر النهائي',
    options: 'الخيارات المتاحة', colors: 'الألوان المتاحة', chooseOption: 'اختر خيارًا',
    chooseColor: 'اختر لونًا', transport: 'وسيلة النقل للطلب المسبق', chooseTransport: 'اختر وسيلة النقل',
    transportAir: 'شحن جوي', transportSea: 'شحن بحري', transportLand: 'شحن بري',
    transportUnset: 'العمولة غير مُعدّة', warranty: 'خطة الضمان', noWarranty: 'بدون خطة إضافية',
    months: 'شهرًا', extension: 'تمديد', total: 'إجمالي',
    qty: 'الكمية', increase: 'زيادة الكمية', decrease: 'إنقاص الكمية',
    addToCart: 'أضف إلى السلة', adding: 'جارٍ الإضافة…', added: 'تمت الإضافة إلى السلة',
    viewCart: 'عرض السلة', signInToBuy: 'سجّل الدخول للشراء',
    directSale: 'بيع مباشر', preorderMode: 'طلب مسبق', unavailable: 'غير متوفر',
    inStock: 'متوفر', lowStock: 'بقي {n} فقط', stockProductScope: 'الكمية مسجّلة على مستوى المنتج وليست لكل خيار',
    untracked: 'التوفر غير مرتبط بعدّاد مخزون',
    qtyCapped: 'المتاح الآن {n} فقط — لم نضف الباقي كطلب مسبق',
    unitBreakdown: 'تفصيل سعر الوحدة', itemPrice: 'سعر المنتج', transportFee: 'عمولة النقل',
    warrantyFee: 'رسوم الضمان', waivedPro: 'معفاة لعضوية PRO', lineTotal: 'إجمالي البنود',
    description: 'وصف المنتج', noDescription: 'لا يوجد وصف لهذا المنتج بعد',
    specs: 'المواصفات التقنية', media: 'الصور والفيديو', reviews: 'التقييمات',
    howToUse: 'طريقة الاستخدام',
    serverChecks: 'يُعاد التحقق من السعر والتوفر على الخادم عند السلة وعند تأكيد الطلب.',
    // machine reasons → honest text
    OUT_OF_STOCK: 'نفد المخزون حاليًا.',
    PREORDER_NOT_ENABLED: 'الطلب المسبق غير مفعّل لهذا المنتج.',
    NO_TRANSPORT_OFFERED: 'الطلب المسبق مفعّل لكن لا توجد وسيلة نقل معروضة.',
    TRANSPORT_COMMISSION_UNCONFIGURED: 'الطلب المسبق مفعّل لكن عمولة النقل غير مُعدّة بعد.',
    COMMUNITY_LISTING_NOT_SELLABLE: 'هذا عرض من متجر مجتمعي ولا يُشترى عبر سلة المتجر.',
    OPTION_REQUIRED: 'اختر خيارًا أولًا.', COLOR_REQUIRED: 'اختر لونًا أولًا.',
    OPTION_NOT_FOUND: 'الخيار المحدد غير موجود.', OPTION_INACTIVE: 'الخيار المحدد لم يعد متاحًا.',
    COLOR_NOT_FOUND: 'اللون المحدد غير موجود.', COLOR_INACTIVE: 'اللون المحدد لم يعد متاحًا.',
    COLOR_OPTION_MISMATCH: 'هذا اللون لا يناسب الخيار المحدد.',
    TRANSPORT_REQUIRED: 'اختر وسيلة النقل.', TRANSPORT_NOT_OFFERED: 'وسيلة النقل غير معروضة.',
    TRANSPORT_NOT_APPLICABLE: 'وسيلة النقل لا تنطبق على البيع المباشر.',
    WARRANTY_PLAN_NOT_FOUND: 'خطة الضمان غير متاحة.',
    REGULAR_PRICE_INVALID: 'سعر هذا المنتج غير صالح — تواصل مع الدعم.',
  },
  en: {
    back: 'Back', share: 'Share', linkCopied: 'Link copied', favorite: 'Add to favourites',
    unfavorite: 'Remove from favourites', gallery: 'Product images', noImages: 'This product has no images yet',
    imageOf: 'Image {n} of {total}', zoom: 'Zoom image', close: 'Close',
    officialStore: 'Official store', communityStore: 'Community store', visitStore: 'Visit store',
    price: 'Price', from: 'From', regularPrice: 'Regular price', proPrice: 'PRO member price',
    proApplied: 'Your PRO price is applied', primeApplied: 'Your PRIME price is applied', subscribe: 'Subscribe', updatingPrice: 'Updating price…',
    priceUnavailable: 'Complete your selection to see the final price',
    options: 'Options', colors: 'Colours', chooseOption: 'Choose an option',
    chooseColor: 'Choose a colour', transport: 'Pre-order transport', chooseTransport: 'Choose transport',
    transportAir: 'Air freight', transportSea: 'Sea freight', transportLand: 'Land freight',
    transportUnset: 'Commission not configured', warranty: 'Warranty plan', noWarranty: 'No extra plan',
    months: 'months', extension: 'extension', total: 'total',
    qty: 'Quantity', increase: 'Increase quantity', decrease: 'Decrease quantity',
    addToCart: 'Add to cart', adding: 'Adding…', added: 'Added to your cart',
    viewCart: 'View cart', signInToBuy: 'Sign in to buy',
    directSale: 'Direct sale', preorderMode: 'Pre-order', unavailable: 'Unavailable',
    inStock: 'In stock', lowStock: 'Only {n} left', stockProductScope: 'Stock is tracked per product, not per option',
    untracked: 'Availability is not tied to a stock counter',
    qtyCapped: 'Only {n} available now — the rest was not turned into a pre-order',
    unitBreakdown: 'Unit price breakdown', itemPrice: 'Item price', transportFee: 'Transport commission',
    warrantyFee: 'Warranty fee', waivedPro: 'Waived for PRO', lineTotal: 'Line total',
    description: 'Description', noDescription: 'No description for this product yet',
    specs: 'Specifications', media: 'Photos & video', reviews: 'Reviews',
    howToUse: 'How to use',
    serverChecks: 'Price and availability are re-checked on the server at cart and at checkout.',
    OUT_OF_STOCK: 'Out of stock right now.',
    PREORDER_NOT_ENABLED: 'Pre-order is not enabled for this product.',
    NO_TRANSPORT_OFFERED: 'Pre-order is enabled but no transport option is offered.',
    TRANSPORT_COMMISSION_UNCONFIGURED: 'Pre-order is enabled but the transport commission is not configured yet.',
    COMMUNITY_LISTING_NOT_SELLABLE: 'This is a community listing and is not sold through the store cart.',
    OPTION_REQUIRED: 'Choose an option first.', COLOR_REQUIRED: 'Choose a colour first.',
    OPTION_NOT_FOUND: 'The selected option does not exist.', OPTION_INACTIVE: 'The selected option is no longer available.',
    COLOR_NOT_FOUND: 'The selected colour does not exist.', COLOR_INACTIVE: 'The selected colour is no longer available.',
    COLOR_OPTION_MISMATCH: 'That colour does not belong to the selected option.',
    TRANSPORT_REQUIRED: 'Choose a transport method.', TRANSPORT_NOT_OFFERED: 'That transport method is not offered.',
    TRANSPORT_NOT_APPLICABLE: 'Transport does not apply to a direct sale.',
    WARRANTY_PLAN_NOT_FOUND: 'That warranty plan is unavailable.',
    REGULAR_PRICE_INVALID: 'This product has an invalid price — please contact support.',
  },
  ckb: {
    back: 'گەڕانەوە', share: 'هاوبەشکردن', linkCopied: 'بەستەرەکە کۆپی کرا', favorite: 'زیادکردن بۆ دڵخوازەکان',
    unfavorite: 'لابردن لە دڵخوازەکان', gallery: 'وێنەکانی بەرهەم', noImages: 'ئەم بەرهەمە هێشتا وێنەی نییە',
    imageOf: 'وێنەی {n} لە {total}', zoom: 'گەورەکردنی وێنە', close: 'داخستن',
    officialStore: 'فرۆشگای فەرمی', communityStore: 'فرۆشگای کۆمەڵگا', visitStore: 'سەردانی فرۆشگا',
    price: 'نرخ', from: 'دەست پێدەکات لە', regularPrice: 'نرخی ئاسایی', proPrice: 'نرخی ئەندامانی PRO',
    proApplied: 'نرخی PRO جێبەجێ کراوە', primeApplied: 'نرخی PRIME جێبەجێ کراوە', subscribe: 'بەشداربە', updatingPrice: 'نرخ نوێ دەکرێتەوە…',
    priceUnavailable: 'هەڵبژاردنەکەت تەواو بکە بۆ بینینی نرخی کۆتایی',
    options: 'هەڵبژاردەکان', colors: 'ڕەنگەکان', chooseOption: 'هەڵبژاردەیەک هەڵبژێرە',
    chooseColor: 'ڕەنگێک هەڵبژێرە', transport: 'گواستنەوەی پێشداواکاری', chooseTransport: 'شێوازی گواستنەوە هەڵبژێرە',
    transportAir: 'بار بە ئاسمان', transportSea: 'بار بە دەریا', transportLand: 'بار بە وشکانی',
    transportUnset: 'کۆمیشن ڕێکنەخراوە', warranty: 'پلانی گەرەنتی', noWarranty: 'بێ پلانی زیادە',
    months: 'مانگ', extension: 'درێژکردنەوە', total: 'کۆ',
    qty: 'بڕ', increase: 'زیادکردنی بڕ', decrease: 'کەمکردنی بڕ',
    addToCart: 'زیادکردن بۆ سەبەتە', adding: 'زیاد دەکرێت…', added: 'زیادکرا بۆ سەبەتەکەت',
    viewCart: 'بینینی سەبەتە', signInToBuy: 'بچۆ ژوورەوە بۆ کڕین',
    directSale: 'فرۆشتنی ڕاستەوخۆ', preorderMode: 'پێشداواکاری', unavailable: 'بەردەست نییە',
    inStock: 'بەردەستە', lowStock: 'تەنها {n} ماوە', stockProductScope: 'بڕ لەسەر ئاستی بەرهەم تۆمار کراوە، نەک بۆ هەر هەڵبژاردەیەک',
    untracked: 'بەردەستی بە ژمێرەری کۆگا نەبەستراوە',
    qtyCapped: 'تەنها {n} بەردەستە ئێستا — ئەوەی ماوە نەکرا بە پێشداواکاری',
    unitBreakdown: 'وردەکاری نرخی یەکە', itemPrice: 'نرخی بەرهەم', transportFee: 'کۆمیشنی گواستنەوە',
    warrantyFee: 'کرێی گەرەنتی', waivedPro: 'بۆ PRO بەخشراوە', lineTotal: 'کۆی گشتی',
    description: 'باسکردن', noDescription: 'هێشتا باسکردنێک بۆ ئەم بەرهەمە نییە',
    specs: 'تایبەتمەندییە تەکنیکییەکان', media: 'وێنە و ڤیدیۆ', reviews: 'پێداچوونەوەکان',
    howToUse: 'شێوازی بەکارهێنان',
    serverChecks: 'نرخ و بەردەستی لەسەر ڕاژەکار دووبارە پشکنین دەکرێن لە سەبەتە و لە کاتی داواکاری.',
    OUT_OF_STOCK: 'ئێستا لە کۆگا نییە.',
    PREORDER_NOT_ENABLED: 'پێشداواکاری بۆ ئەم بەرهەمە چالاک نەکراوە.',
    NO_TRANSPORT_OFFERED: 'پێشداواکاری چالاکە بەڵام هیچ شێوازی گواستنەوە پێشکەش نەکراوە.',
    TRANSPORT_COMMISSION_UNCONFIGURED: 'پێشداواکاری چالاکە بەڵام کۆمیشنی گواستنەوە هێشتا ڕێکنەخراوە.',
    COMMUNITY_LISTING_NOT_SELLABLE: 'ئەمە ڕیکلامی فرۆشگای کۆمەڵگایە و بە سەبەتەی فرۆشگا نافرۆشرێت.',
    OPTION_REQUIRED: 'سەرەتا هەڵبژاردەیەک هەڵبژێرە.', COLOR_REQUIRED: 'سەرەتا ڕەنگێک هەڵبژێرە.',
    OPTION_NOT_FOUND: 'هەڵبژاردەی دیاریکراو نییە.', OPTION_INACTIVE: 'هەڵبژاردەی دیاریکراو چیتر بەردەست نییە.',
    COLOR_NOT_FOUND: 'ڕەنگی دیاریکراو نییە.', COLOR_INACTIVE: 'ڕەنگی دیاریکراو چیتر بەردەست نییە.',
    COLOR_OPTION_MISMATCH: 'ئەم ڕەنگە بۆ ئەم هەڵبژاردەیە نییە.',
    TRANSPORT_REQUIRED: 'شێوازی گواستنەوە هەڵبژێرە.', TRANSPORT_NOT_OFFERED: 'ئەم شێوازی گواستنەوەیە پێشکەش نەکراوە.',
    TRANSPORT_NOT_APPLICABLE: 'گواستنەوە بۆ فرۆشتنی ڕاستەوخۆ ناگونجێت.',
    WARRANTY_PLAN_NOT_FOUND: 'ئەم پلانی گەرەنتییە بەردەست نییە.',
    REGULAR_PRICE_INVALID: 'نرخی ئەم بەرهەمە دروست نییە — پەیوەندی بە پشتگیری بکە.',
  },
} as const;

type Strings = { readonly [K in keyof typeof STRINGS['ar']]: string };

// -------------------------------------------------------------------- types

type ProductSource = 'catalog' | 'community';

interface MediaItem {
  id?: string; url: string; alt_ar?: string; alt_en?: string; alt_ckb?: string;
  order?: number; primary?: boolean;
}
interface OptionItem {
  id: string; name_ar?: string; name_en?: string; name_ckb?: string; name?: string; image?: string;
}
interface ColorItem {
  id: string; name_ar?: string; name_en?: string; name_ckb?: string; name?: string;
  hex?: string; image?: string; option_id?: string | null;
}
interface WarrantyPlanItem {
  id: string; title_ar?: string; title_en?: string; title_ckb?: string;
  duration_months: number; duration_kind: 'total' | 'extension' | string; fee_iqd: number;
}
interface SpecRow {
  id?: string; label_ar?: string; label_en?: string; label_ckb?: string;
  value_ar?: string; value_en?: string; value_ckb?: string; unit?: string;
}
interface SpecGroup {
  id?: string; title_ar?: string; title_en?: string; title_ckb?: string; rows?: SpecRow[];
}

interface ProductDetail {
  id: string; slug: string;
  name?: string; name_ar?: string; name_en?: string; name_ckb?: string;
  description?: string; description_ar?: string; description_en?: string; description_ckb?: string;
  price_iqd: number; pro_price_iqd?: number | null; prime_price_iqd?: number | null;
  selling_type?: string;
  media?: MediaItem[]; images?: string[];
  options?: OptionItem[]; colors?: ColorItem[];
  warranty_plans?: WarrantyPlanItem[];
  spec_groups?: SpecGroup[]; specifications?: Array<{ key: string; value: string }>;
  description_images?: string[]; description_videos?: string[];
  how_to_use?: string; brand?: string; stock?: number | null;
  merchant?: { id: string; name: string; verified: boolean };
  display_price_iqd?: number;
}

interface TransportView { method: string; commission_iqd: number | null; configured: boolean }

interface Availability {
  mode: 'direct_sale' | 'preorder' | 'unavailable';
  reason: string | null;
  selling_type: string;
  stock: {
    tracked: boolean; scope: string; on_hand: number | null; reserved: number;
    available: number | null; max_qty: number;
  };
  selection: {
    option_required: boolean; color_required: boolean;
    option_id: string | null; color_id: string | null;
    complete: boolean; errors: string[];
  };
  preorder: { enabled: boolean; usable: boolean; reason: string | null; transports: TransportView[] };
  qty_ok: boolean;
}

interface Quote {
  regular_iqd: number; pro_iqd: number | null; prime_iqd: number | null; applied_iqd: number;
  applied_tier: 'regular' | 'pro' | 'prime'; price_source: string;
  transport: { method: string; commission_iqd: number; waived: boolean } | null;
  warranty: { plan_id: string; title_ar: string; fee_iqd: number; duration_months: number; duration_kind: string } | null;
  unit_subtotal_iqd: number; errors: string[]; qty: number; line_total_iqd: number;
}

interface DetailResponse {
  product: ProductDetail;
  source: ProductSource;
  favorite: boolean;
  availability?: Availability;
  viewer_tier?: { tier: 'free' | 'plus' | 'pro'; active: boolean };
}

interface QuoteResponse {
  quote: Quote;
  availability: Availability;
  viewer_tier?: { tier: 'free' | 'plus' | 'pro'; active: boolean };
}

// ------------------------------------------------------------------ helpers

type Lang = 'ar' | 'en' | 'ckb';

/** Picks the localized field, falling back to Arabic (the source language). */
function pick(lang: Lang, ar?: string, en?: string, ckb?: string, legacy?: string): string {
  if (lang === 'en') return (en || ar || legacy || '').trim();
  if (lang === 'ckb') return (ckb || ar || en || legacy || '').trim();
  return (ar || legacy || en || '').trim();
}

function reasonText(s: Strings, code: string | null | undefined): string {
  if (!code) return '';
  const map = s as unknown as Record<string, string | undefined>;
  return map[code] || code;
}

function transportLabel(s: Strings, method: string): string {
  if (method === 'air') return s.transportAir;
  if (method === 'sea') return s.transportSea;
  if (method === 'land') return s.transportLand;
  return method;
}

/** Media in stored order, primary first, de-duplicated by URL. */
function galleryOf(product: ProductDetail): MediaItem[] {
  const media = Array.isArray(product.media) ? product.media.filter((m) => m && m.url) : [];
  const source: MediaItem[] = media.length
    ? [...media].sort((a, b) => {
        if (!!b.primary !== !!a.primary) return b.primary ? 1 : -1;
        return (a.order ?? 0) - (b.order ?? 0);
      })
    : (Array.isArray(product.images) ? product.images : []).filter(Boolean).map((url, i) => ({ url, order: i }));
  const seen = new Set<string>();
  return source.filter((m) => (seen.has(m.url) ? false : (seen.add(m.url), true)));
}

// ---------------------------------------------------------------- component

function Section({
  title, icon, children, defaultOpen = false,
}: { title: string; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-zinc-800/70 rounded-2xl bg-zinc-900/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full p-4 min-h-[44px] flex justify-between items-center text-white font-bold gap-3 hover:bg-white/5 transition-colors"
      >
        <span className="flex items-center gap-2 text-start">
          {icon}
          <span>{title}</span>
        </span>
        <ChevronDown aria-hidden="true" className={`w-5 h-5 text-zinc-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  );
}

/**
 * The address bar as an EXTERNAL STORE.
 *
 * React Router v7 wraps every navigation state update in
 * `React.startTransition`, so on a back/forward (POP) the previous screen
 * stays painted until the new render commits — which is exactly the "one
 * stale frame of the previous product under the new URL" this page must not
 * show. React is not allowed to defer a `useSyncExternalStore` update (it
 * would tear), so reading the path through this store forces the reset below
 * to flush BEFORE the browser paints. It is a read of the browser's own
 * state — it never navigates and never writes history.
 */
function subscribeToPath(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener('hashchange', onChange);
  };
}
function readPathSlug(): string {
  const p = window.location.pathname;
  if (!p.startsWith('/product/')) return '';
  try {
    return decodeURIComponent(p.slice('/product/'.length).split('/')[0]);
  } catch {
    return p.slice('/product/'.length).split('/')[0];
  }
}
/** No SSR in this app; an empty snapshot simply defers to the route param. */
const readPathSlugServer = (): string => '';

export default function Product() {
  const { slug } = useParams();
  const location = useLocation();
  const urlSlug = useSyncExternalStore(subscribeToPath, readPathSlug, readPathSlugServer);
  // The URL is authoritative for "which product should be on screen"; the
  // route param is the fallback (and the loader's input) once the router has
  // caught up.
  const shownSlug = urlSlug || slug;
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  const { isAuthenticated } = useAuth();
  const s = STRINGS[lang as Lang];

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [source, setSource] = useState<ProductSource>('catalog');
  const [baseAvailability, setBaseAvailability] = useState<Availability | null>(null);
  const [viewerTier, setViewerTier] = useState<{ tier: string; active: boolean } | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retryToken, setRetryToken] = useState(0);

  // Selection — nothing is guessed: a value is set only when the catalogue
  // leaves exactly one possibility (no randomness) or the user picks it.
  const [optionId, setOptionId] = useState('');
  const [colorId, setColorId] = useState('');
  const [transportMethod, setTransportMethod] = useState('');
  const [warrantyPlanId, setWarrantyPlanId] = useState('');
  const [qty, setQty] = useState(1);

  const [quote, setQuote] = useState<Quote | null>(null);
  const [liveAvailability, setLiveAvailability] = useState<Availability | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [quoteToken, setQuoteToken] = useState(0);

  const [galleryIndex, setGalleryIndex] = useState(0);
  const [lightbox, setLightbox] = useState(false);

  const [addingToCart, setAddingToCart] = useState(false);
  const addInFlight = useRef(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  // Synchronous stale-content guard (adjust-state-during-render): the load
  // effect is passive, so it only runs AFTER the browser paints the first
  // render for a new slug — which would flash the PREVIOUS product for one
  // frame under the new URL. Dropping the mismatched product during render
  // makes React re-render immediately (skeleton) before anything is painted.
  if (product && shownSlug && product.slug !== shownSlug) {
    setProduct(null);
    setLoading(true);
  }

  useEffect(() => {
    // Stale-response guard: when the slug changes mid-flight the cleanup flips
    // `cancelled`, so a late response for the PREVIOUS product cannot flash in.
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await api.get<DetailResponse>(`/api/products/${slug}`);
        if (cancelled) return;
        setProduct(data.product);
        setSource(data.source);
        setFavorite(data.favorite);
        setBaseAvailability(data.availability ?? null);
        setViewerTier(data.viewer_tier ?? null);
        setLiveAvailability(null);
        setQuote(null);
        setQuoteError(null);
        setGalleryIndex(0);
        setQty(1);
        setWarrantyPlanId('');
        setActionError('');
        setNotice('');

        // Deterministic pre-selection ONLY where a single possibility exists.
        const opts = data.product.options ?? [];
        setOptionId(opts.length === 1 ? opts[0].id : '');
        const cols = (data.product.colors ?? []).filter(
          (c) => !c.option_id || (opts.length === 1 && c.option_id === opts[0].id)
        );
        setColorId(cols.length === 1 && (data.product.colors ?? []).length === 1 ? cols[0].id : '');
        const usable = (data.availability?.preorder.transports ?? []).filter((t) => t.configured);
        setTransportMethod(
          data.availability?.mode === 'preorder' && usable.length === 1 ? usable[0].method : ''
        );
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setProduct(null);
          // 404 → not found; 5xx/network → error with retry. An outage is not
          // the same as a missing product.
          setLoadError(err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (slug) load();
    return () => {
      cancelled = true;
    };
  }, [slug, retryToken]);

  // Live server quote for the CURRENT selection. Debounced, stale-guarded, and
  // the only source of the displayed price/fees.
  const selectionKey = `${optionId}|${colorId}|${transportMethod}|${warrantyPlanId}|${qty}`;
  const productSlug = product?.slug ?? '';
  useEffect(() => {
    if (!productSlug || source !== 'catalog') return;
    let cancelled = false;
    // Mark the price stale for the WHOLE debounce + request window, so the
    // previous selection's figure is never presented as this one's final
    // price for the 220ms before the request even starts.
    setQuoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.post<QuoteResponse>(`/api/products/${productSlug}/quote`, {
          qty,
          optionId: optionId || undefined,
          colorId: colorId || undefined,
          transportMethod: transportMethod || undefined,
          warrantyPlanId: warrantyPlanId || undefined,
        });
        if (cancelled) return;
        setQuote(res.quote);
        setLiveAvailability(res.availability);
        setQuoteError(null);
      } catch (err) {
        if (cancelled) return;
        setQuote(null);
        setQuoteError(err);
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [productSlug, source, selectionKey, optionId, colorId, transportMethod, warrantyPlanId, qty, quoteToken]);

  const availability = liveAvailability ?? baseAvailability;

  // Keep a valid selection, drop an invalid one (mandate §7.2: the user's
  // choice survives as long as it is valid).
  const colorsForOption = useMemo(() => {
    const all = product?.colors ?? [];
    if (!optionId) return all;
    return all.filter((c) => !c.option_id || c.option_id === optionId);
  }, [product, optionId]);

  useEffect(() => {
    if (colorId && !colorsForOption.some((c) => c.id === colorId)) setColorId('');
  }, [colorsForOption, colorId]);

  const maxQty = Math.max(1, availability?.stock.max_qty ?? 1);
  useEffect(() => {
    setQty((q) => Math.min(Math.max(1, q), Math.max(1, availability?.stock.max_qty ?? 99)));
  }, [availability?.stock.max_qty]);

  // §3.3 — a product share link carries ?ref=<username>. Capturing it HERE is
  // what makes an arriving support code visible in the cart later; the ref is
  // never resolved, trusted or priced in the browser, and an existing code is
  // never silently replaced (the helper records a second, different ref as a
  // conflict the cart asks the buyer to resolve).
  useEffect(() => {
    if (!location.search || location.search.indexOf('ref=') === -1) return;
    captureSupportRefFromSearch(location.search, { product: location.pathname });
  }, [location.search, location.pathname]);

  const handleShare = async () => {
    const name = product ? pick(lang as Lang, product.name_ar, product.name_en, product.name_ckb, product.name) : '';
    // §3.3 — a signed-in sharer's link carries THEIR support handle. The path
    // is built by the SERVER from the account's own username (GET
    // /api/referrals/support/link): the browser never invents a handle, and a
    // signed-out visitor (or an account with no username yet) simply shares
    // the plain product URL instead of a broken code.
    let url = window.location.href;
    if (isAuthenticated && slug) {
      try {
        const res = await api.get<{ path: string; ref: string | null; supported: boolean }>(
          `/api/referrals/support/link?path=${encodeURIComponent(`/product/${slug}`)}`
        );
        if (res.supported && res.path) url = new URL(res.path, window.location.origin).toString();
      } catch {
        /* keep the plain product URL — sharing must not fail over an extra */
      }
    }
    try {
      if (navigator.share) {
        await navigator.share({ title: name, url });
      } else {
        await navigator.clipboard.writeText(url);
        setNotice(s.linkCopied);
        setTimeout(() => setNotice(''), 2000);
      }
    } catch {
      /* user cancelled the share sheet */
    }
  };

  const toggleFavorite = async () => {
    if (!product || favBusy || source !== 'catalog') return;
    if (!isAuthenticated) {
      navigate(`/auth?next=${encodeURIComponent(`/product/${product.slug}`)}`);
      return;
    }
    setFavBusy(true);
    setActionError('');
    try {
      if (favorite) {
        await api.delete(`/api/profile/favorites/${product.id}`);
        setFavorite(false);
      } else {
        await api.put(`/api/profile/favorites/${product.id}`);
        setFavorite(true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate(`/auth?next=${encodeURIComponent(`/product/${product.slug}`)}`);
        return;
      }
      setActionError(err instanceof Error ? err.message : 'Failed to update favorites');
    } finally {
      setFavBusy(false);
    }
  };

  const handleAddToCart = useCallback(async () => {
    if (!product) return;
    // Double-tap guard: a ref, not state, so two taps in the same tick cannot
    // both pass. Retrying after a failure is safe (the server upserts one row).
    if (addInFlight.current) return;
    if (!isAuthenticated) {
      navigate(`/auth?next=${encodeURIComponent(`/product/${product.slug}`)}`);
      return;
    }
    addInFlight.current = true;
    setAddingToCart(true);
    setActionError('');
    setNotice('');
    try {
      const body: Record<string, unknown> = { productId: product.id, qty };
      if (optionId) body.optionId = optionId;
      if (colorId) body.colorId = colorId;
      if (availability?.mode === 'preorder' && transportMethod) body.transportMethod = transportMethod;
      if (warrantyPlanId) body.warrantyPlanId = warrantyPlanId;
      const data = await api.post<{ items: CartItem[] }>('/api/cart/items', body);
      // Success is claimed ONLY after the server returns the saved cart.
      const count = data.items.reduce((n, it) => n + it.qty, 0);
      setNotice(`${s.added} (${count})`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate(`/auth?next=${encodeURIComponent(`/product/${product.slug}`)}`);
        return;
      }
      setActionError(err instanceof Error ? err.message : 'Failed to add to cart');
    } finally {
      addInFlight.current = false;
      setAddingToCart(false);
    }
  }, [product, qty, optionId, colorId, transportMethod, warrantyPlanId, availability, isAuthenticated, navigate, s.added]);

  // Escape closes the lightbox.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // ------------------------------------------------------------ loading/error
  if (loading || !product) {
    return (
      <div className="w-full min-h-[100dvh] bg-black text-zinc-300 font-sans" dir={dir}>
        <div className="sticky top-0 z-30 bg-black/90 backdrop-blur-xl px-4 py-3 flex items-center">
          <button
            onClick={() => navigate(-1)}
            aria-label={s.back}
            className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center bg-zinc-900/60 rounded-full hover:bg-zinc-800 transition-colors"
          >
            {dir === 'rtl' ? <ArrowRight className="w-5 h-5 text-white" /> : <ArrowLeft className="w-5 h-5 text-white" />}
          </button>
        </div>
        <div className="pb-10">
          {loading ? (
            <ProductDetailSkeleton />
          ) : loadError ? (
            <div className="px-4 pt-8 max-w-2xl mx-auto">
              <ErrorState error={loadError} onRetry={() => setRetryToken((n) => n + 1)} next={`/product/${slug ?? ''}`} />
            </div>
          ) : (
            <div className="px-4 pt-8 max-w-2xl mx-auto">
              <NotFoundState onBack={() => navigate(-1)} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------ derived view
  const name = pick(lang as Lang, product.name_ar, product.name_en, product.name_ckb, product.name);
  const description = pick(
    lang as Lang, product.description_ar, product.description_en, product.description_ckb, product.description
  );
  const gallery = galleryOf(product);
  const activeMedia = gallery[Math.min(galleryIndex, Math.max(0, gallery.length - 1))];
  const options = product.options ?? [];
  const warrantyPlans = product.warranty_plans ?? [];
  const specGroups = (product.spec_groups ?? []).filter((g) => (g.rows ?? []).length > 0);
  const legacySpecs = product.specifications ?? [];
  const descriptionImages = product.description_images ?? [];
  const descriptionVideos = product.description_videos ?? [];

  const mode = availability?.mode ?? (source === 'community' ? 'unavailable' : 'direct_sale');
  const selectionComplete = availability ? availability.selection.complete : true;
  const quoteErrors = quote?.errors ?? [];
  const priceIsAuthoritative = !!quote && quoteErrors.length === 0 && selectionComplete && !quoteLoading;
  const unitPrice = priceIsAuthoritative ? quote!.unit_subtotal_iqd : null;
  const lineTotal = priceIsAuthoritative ? quote!.line_total_iqd : null;
  const isPro = viewerTier?.tier === 'pro' && viewerTier.active;
  const proPrice = product.pro_price_iqd ?? null;

  const blockingCodes: string[] = [
    ...(availability?.selection.errors ?? []),
    ...quoteErrors.filter((e) => !(availability?.selection.errors ?? []).includes(e)),
  ];
  const canBuy =
    source === 'catalog' &&
    mode !== 'unavailable' &&
    selectionComplete &&
    quoteErrors.length === 0 &&
    !!availability?.qty_ok &&
    priceIsAuthoritative;

  const stockNote = (() => {
    if (!availability || mode !== 'direct_sale') return '';
    if (!availability.stock.tracked) return s.untracked;
    const left = availability.stock.available ?? 0;
    if (left > 0 && left <= 5) return s.lowStock.replace('{n}', String(left));
    return s.inStock;
  })();

  const modeBadge =
    mode === 'preorder'
      ? { label: s.preorderMode, cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', icon: <Clock className="w-3.5 h-3.5" /> }
      : mode === 'direct_sale'
        ? { label: s.directSale, cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', icon: <Package className="w-3.5 h-3.5" /> }
        : { label: s.unavailable, cls: 'bg-red-500/10 text-red-300 border-red-500/30', icon: <AlertTriangle className="w-3.5 h-3.5" /> };

  // ------------------------------------------------------------ sub-renders
  const priceBlock = (
    <div className="rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4">
      {priceIsAuthoritative ? (
        <>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <span className="text-white font-black text-2xl sm:text-3xl tabular-nums">{formatIqd(unitPrice!)}</span>
            {quote!.applied_tier === 'pro' || quote!.applied_tier === 'prime' ? (
              <span className="inline-flex items-center gap-1.5 bg-gold text-black px-2.5 py-1 rounded-lg text-[11px] font-black uppercase tracking-wide">
                <Star aria-hidden="true" className="w-3 h-3 fill-black" />
                {quote!.applied_tier === 'pro' ? s.proApplied : s.primeApplied}
              </span>
            ) : (
              <span className="text-zinc-400 text-[12px] font-bold">{s.regularPrice}</span>
            )}
          </div>
          {/* §4: no compare-at. The regular price is struck through only when
              the member's own resolved price is genuinely lower. */}
          {quote!.applied_iqd < quote!.regular_iqd ? (
            <div className="text-zinc-500 text-sm line-through mt-1 tabular-nums">{formatIqd(quote!.regular_iqd)}</div>
          ) : null}
          {qty > 1 ? (
            <div className="text-zinc-400 text-[13px] mt-2">
              {s.lineTotal}: <span className="text-white font-bold tabular-nums">{formatIqd(lineTotal!)}</span>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-zinc-400 text-[12px] font-bold">{s.from}</span>
            <span className="text-white font-bold text-xl tabular-nums opacity-80">{formatIqd(product.price_iqd)}</span>
          </div>
          <p className="text-zinc-400 text-[13px] mt-2">
            {quoteLoading ? s.updatingPrice : s.priceUnavailable}
          </p>
        </>
      )}

      {proPrice !== null && !isPro ? (
        <button
          type="button"
          onClick={() => navigate('/subscription')}
          className="mt-3 w-full min-h-[44px] flex items-center justify-between gap-2 rounded-xl border border-gold/30 bg-gold/5 px-3 text-start hover:bg-gold/10 transition-colors"
        >
          <span className="text-gold text-[13px] font-bold flex items-center gap-1.5">
            <Star aria-hidden="true" className="w-3.5 h-3.5" />
            {s.proPrice}: <span className="tabular-nums">{formatIqd(proPrice)}</span>
          </span>
          <span className="text-zinc-300 text-[12px] font-bold">{s.subscribe}</span>
        </button>
      ) : null}

      {/* Unit breakdown — every added fee is named, never folded silently. */}
      {priceIsAuthoritative && (quote!.transport || quote!.warranty) ? (
        <dl className="mt-3 pt-3 border-t border-zinc-800/70 space-y-1.5 text-[13px]">
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-400">{s.itemPrice}</dt>
            <dd className="text-zinc-200 tabular-nums">{formatIqd(quote!.applied_iqd)}</dd>
          </div>
          {quote!.transport ? (
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-400">
                {s.transportFee} · {transportLabel(s, quote!.transport.method)}
              </dt>
              <dd className="text-zinc-200 tabular-nums">
                {quote!.transport.waived ? s.waivedPro : formatIqd(quote!.transport.commission_iqd)}
              </dd>
            </div>
          ) : null}
          {quote!.warranty ? (
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-400">{s.warrantyFee}</dt>
              <dd className="text-zinc-200 tabular-nums">{formatIqd(quote!.warranty.fee_iqd)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );

  const selectionBlocks = (
    <>
      {options.length > 0 ? (
        <fieldset className="rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4">
          <legend className="px-1 text-white font-bold text-[14px]">
            {s.options}
            {availability?.selection.option_required && !optionId ? (
              <span className="ms-2 text-amber-300 font-medium text-[12px]">{s.chooseOption}</span>
            ) : null}
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {options.map((opt) => {
              const selected = optionId === opt.id;
              const label = pick(lang as Lang, opt.name_ar, opt.name_en, opt.name_ckb, opt.name) || opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setOptionId(selected ? '' : opt.id)}
                  className={`min-h-[44px] px-4 rounded-xl border text-sm font-bold transition-colors ${
                    selected
                      ? 'border-gold bg-gold/15 text-gold'
                      : 'border-zinc-700 bg-zinc-800/40 text-zinc-200 hover:border-zinc-500'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {colorsForOption.length > 0 ? (
        <fieldset className="rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4">
          <legend className="px-1 text-white font-bold text-[14px]">
            {s.colors}
            {availability?.selection.color_required && !colorId ? (
              <span className="ms-2 text-amber-300 font-medium text-[12px]">{s.chooseColor}</span>
            ) : null}
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {colorsForOption.map((col) => {
              const selected = colorId === col.id;
              const label = pick(lang as Lang, col.name_ar, col.name_en, col.name_ckb, col.name) || col.id;
              return (
                <button
                  key={col.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setColorId(selected ? '' : col.id)}
                  className={`min-h-[44px] px-3 rounded-xl border flex items-center gap-2 text-sm font-bold transition-colors ${
                    selected
                      ? 'border-gold bg-gold/15 text-gold'
                      : 'border-zinc-700 bg-zinc-800/40 text-zinc-200 hover:border-zinc-500'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="w-5 h-5 rounded-full border border-zinc-600 shrink-0"
                    style={{ backgroundColor: col.hex || '#3f3f46' }}
                  />
                  <span className="truncate max-w-[9rem]">{label}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {mode === 'preorder' && (availability?.preorder.transports.length ?? 0) > 0 ? (
        <fieldset className="rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4">
          <legend className="px-1 text-white font-bold text-[14px] flex items-center gap-2">
            <Truck aria-hidden="true" className="w-4 h-4 text-zinc-400" />
            {s.transport}
          </legend>
          <div className="mt-2 flex flex-col gap-2">
            {availability!.preorder.transports.map((t) => {
              const selected = transportMethod === t.method;
              return (
                <button
                  key={t.method}
                  type="button"
                  disabled={!t.configured}
                  aria-pressed={selected}
                  onClick={() => setTransportMethod(selected ? '' : t.method)}
                  className={`min-h-[44px] px-3 py-2 rounded-xl border flex items-center justify-between gap-3 text-sm transition-colors ${
                    !t.configured
                      ? 'border-zinc-800 bg-zinc-900/60 text-zinc-500 cursor-not-allowed'
                      : selected
                        ? 'border-gold bg-gold/15 text-gold font-bold'
                        : 'border-zinc-700 bg-zinc-800/40 text-zinc-200 hover:border-zinc-500'
                  }`}
                >
                  <span>{transportLabel(s, t.method)}</span>
                  <span className="tabular-nums text-[13px]">
                    {t.configured ? `+${formatIqd(t.commission_iqd ?? 0)}` : s.transportUnset}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {warrantyPlans.length > 0 ? (
        <fieldset className="rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4">
          <legend className="px-1 text-white font-bold text-[14px] flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="w-4 h-4 text-zinc-400" />
            {s.warranty}
          </legend>
          <div className="mt-2 flex flex-col gap-2">
            <button
              type="button"
              aria-pressed={!warrantyPlanId}
              onClick={() => setWarrantyPlanId('')}
              className={`min-h-[44px] px-3 rounded-xl border text-sm text-start transition-colors ${
                !warrantyPlanId
                  ? 'border-gold bg-gold/15 text-gold font-bold'
                  : 'border-zinc-700 bg-zinc-800/40 text-zinc-200 hover:border-zinc-500'
              }`}
            >
              {s.noWarranty}
            </button>
            {warrantyPlans.map((w) => {
              const selected = warrantyPlanId === w.id;
              const title = pick(lang as Lang, w.title_ar, w.title_en, w.title_ckb) || w.id;
              return (
                <button
                  key={w.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setWarrantyPlanId(selected ? '' : w.id)}
                  className={`min-h-[44px] px-3 py-2 rounded-xl border flex items-center justify-between gap-3 text-sm text-start transition-colors ${
                    selected
                      ? 'border-gold bg-gold/15 text-gold font-bold'
                      : 'border-zinc-700 bg-zinc-800/40 text-zinc-200 hover:border-zinc-500'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{title}</span>
                    <span className="block text-[12px] text-zinc-400">
                      {w.duration_months} {s.months} · {w.duration_kind === 'extension' ? s.extension : s.total}
                    </span>
                  </span>
                  <span className="tabular-nums text-[13px] shrink-0">+{formatIqd(w.fee_iqd)}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}
    </>
  );

  const qtyControl = (
    <div className="flex items-center justify-between gap-3">
      <span className="text-zinc-300 text-sm font-bold">{s.qty}</span>
      <div className="flex items-center gap-1 bg-zinc-800/60 border border-zinc-700 rounded-xl p-1">
        <button
          type="button"
          aria-label={s.decrease}
          onClick={() => setQty((q) => Math.max(1, q - 1))}
          disabled={qty <= 1}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 transition-colors"
        >
          <Minus aria-hidden="true" className="w-4 h-4" />
        </button>
        <span className="min-w-[2.5rem] text-center text-white font-bold tabular-nums" aria-live="polite">{qty}</span>
        <button
          type="button"
          aria-label={s.increase}
          onClick={() => setQty((q) => Math.min(maxQty, q + 1))}
          disabled={qty >= maxQty}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 transition-colors"
        >
          <Plus aria-hidden="true" className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  const statusMessages = (
    <div className="space-y-2" aria-live="polite">
      {mode === 'unavailable' && availability?.reason ? (
        <p className="text-red-300 text-[13px] bg-red-500/10 border border-red-500/25 rounded-xl px-3 py-2">
          {reasonText(s, availability.reason)}
        </p>
      ) : null}
      {source === 'community' ? (
        <p className="text-amber-200 text-[13px] bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2">
          {s.COMMUNITY_LISTING_NOT_SELLABLE}
        </p>
      ) : null}
      {mode !== 'unavailable' && blockingCodes.length > 0
        ? blockingCodes.map((code) => (
            <p key={code} className="text-amber-200 text-[13px] bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2">
              {reasonText(s, code)}
            </p>
          ))
        : null}
      {availability && !availability.qty_ok && mode !== 'unavailable' ? (
        <p className="text-amber-200 text-[13px] bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2">
          {s.qtyCapped.replace('{n}', String(availability.stock.max_qty))}
        </p>
      ) : null}
      {quoteError ? (
        <div className="pt-1">
          <ErrorState error={quoteError} onRetry={() => setQuoteToken((n) => n + 1)} compact />
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className="text-red-300 text-[13px] bg-red-500/10 border border-red-500/25 rounded-xl px-3 py-2">
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <div className="text-emerald-300 text-[13px] bg-emerald-500/10 border border-emerald-500/25 rounded-xl px-3 py-2 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <Check aria-hidden="true" className="w-4 h-4" />
            {notice}
          </span>
          <Link to="/cart" className="font-bold underline underline-offset-2 shrink-0">
            {s.viewCart}
          </Link>
        </div>
      ) : null}
    </div>
  );

  const buyButtonLabel = !isAuthenticated
    ? s.signInToBuy
    : addingToCart
      ? s.adding
      : mode === 'unavailable'
        ? s.unavailable
        : s.addToCart;

  const buyButton = (
    <button
      type="button"
      data-testid="product-cta"
      onClick={handleAddToCart}
      disabled={addingToCart || (isAuthenticated && !canBuy)}
      className="w-full min-h-[52px] rounded-2xl bg-gold text-black font-black text-[15px] flex items-center justify-center gap-2 hover:brightness-110 disabled:opacity-45 disabled:cursor-not-allowed transition-all active:scale-[0.99]"
    >
      <ShoppingCart aria-hidden="true" className="w-5 h-5" />
      {buyButtonLabel}
    </button>
  );

  // ------------------------------------------------------------------ render
  return (
    <div className="w-full min-h-[100dvh] bg-black text-zinc-300 font-sans" dir={dir}>
      {/* Sticky page chrome inside the app scroll container — never a fixed
          overlay that could land in the middle of the content. */}
      <div className="sticky top-0 z-30 bg-black/90 backdrop-blur-xl px-4 py-3 flex items-center justify-between gap-2">
        <button
          onClick={() => navigate(-1)}
          aria-label={s.back}
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center bg-zinc-900/60 rounded-full hover:bg-zinc-800 transition-colors"
        >
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5 text-white" /> : <ArrowLeft className="w-5 h-5 text-white" />}
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={handleShare}
            aria-label={s.share}
            className="w-11 h-11 rounded-full bg-zinc-900/60 flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <Share2 aria-hidden="true" className="w-5 h-5" />
          </button>
          <button
            onClick={toggleFavorite}
            disabled={favBusy || source !== 'catalog'}
            aria-label={favorite ? s.unfavorite : s.favorite}
            aria-pressed={favorite}
            className={`w-11 h-11 rounded-full bg-zinc-900/60 flex items-center justify-center transition-colors ${
              favorite ? 'text-rose-400' : 'text-zinc-300 hover:text-white hover:bg-zinc-800'
            } ${source !== 'catalog' ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <Heart aria-hidden="true" className={`w-5 h-5 ${favorite ? 'fill-rose-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* Bottom clearance equals the phone purchase bar (its height + safe
          area). BottomNav does not render on /product/*, so this is the only
          reserved space and nothing is covered. */}
      <div className="mx-auto w-full max-w-[1240px] px-4 pt-2 pb-[calc(112px+env(safe-area-inset-bottom))] lg:pb-12">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-8 lg:items-start">
          {/* -------------------------------------------------- left column */}
          <div className="min-w-0">
            <section aria-label={s.gallery}>
              <div className="relative w-full h-[min(78vw,340px)] sm:h-[420px] lg:h-[460px] rounded-2xl border border-zinc-800/70 bg-zinc-950 overflow-hidden">
                <SafeImage
                  key={activeMedia?.url || 'empty'}
                  src={activeMedia?.url}
                  alt={
                    pick(lang as Lang, activeMedia?.alt_ar, activeMedia?.alt_en, activeMedia?.alt_ckb) || name
                  }
                  aspect="auto"
                  fit="contain"
                  eager={galleryIndex === 0}
                  className="w-full h-full"
                  bgClassName="bg-zinc-950"
                  imgClassName="p-3"
                  fallbackIconClassName="w-10 h-10"
                  fallbackClassName="text-zinc-600"
                />
                {activeMedia?.url ? (
                  <button
                    type="button"
                    onClick={() => setLightbox(true)}
                    aria-label={s.zoom}
                    className="absolute bottom-2 end-2 w-11 h-11 rounded-full bg-black/70 border border-zinc-700 flex items-center justify-center text-zinc-200 hover:text-white transition-colors"
                  >
                    <ZoomIn aria-hidden="true" className="w-5 h-5" />
                  </button>
                ) : null}
              </div>

              {gallery.length > 1 ? (
                <div className="mt-3 flex gap-2 overflow-x-auto hide-scrollbar pb-1" aria-label={s.gallery}>
                  {gallery.map((m, i) => (
                    <button
                      key={m.url + i}
                      type="button"
                      aria-pressed={i === galleryIndex}
                      aria-label={s.imageOf.replace('{n}', String(i + 1)).replace('{total}', String(gallery.length))}
                      onClick={() => setGalleryIndex(i)}
                      className={`shrink-0 w-16 h-16 rounded-xl overflow-hidden border transition-colors ${
                        i === galleryIndex ? 'border-gold' : 'border-zinc-800 hover:border-zinc-600'
                      }`}
                    >
                      <SafeImage
                        src={m.url}
                        alt=""
                        aspect="square"
                        fit="contain"
                        className="w-full h-full"
                        bgClassName="bg-zinc-900"
                        fallbackIconClassName="w-4 h-4"
                      />
                    </button>
                  ))}
                </div>
              ) : null}

              {gallery.length === 0 ? (
                <p className="mt-3 text-zinc-500 text-[13px] flex items-center gap-2">
                  <ImageIcon aria-hidden="true" className="w-4 h-4" />
                  {s.noImages}
                </p>
              ) : null}
            </section>

            {/* Title + store, shown once (the panel repeats no heading). */}
            <div className="mt-5">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <span className={`inline-flex items-center gap-1.5 border rounded-full px-2.5 py-1 text-[11px] font-bold ${modeBadge.cls}`}>
                  {modeBadge.icon}
                  {modeBadge.label}
                </span>
                {product.brand ? (
                  <span className="border border-zinc-700 rounded-full px-2.5 py-1 text-[11px] text-zinc-300">{product.brand}</span>
                ) : null}
                {stockNote ? <span className="text-zinc-400 text-[12px]">{stockNote}</span> : null}
              </div>
              <h1 className="text-xl sm:text-2xl font-bold text-white leading-snug">{name}</h1>
              <p className="mt-2 text-[12px] text-zinc-500 flex items-center gap-1.5">
                <Store aria-hidden="true" className="w-3.5 h-3.5" />
                {source === 'community' && product.merchant ? (
                  <>
                    {s.communityStore} · {product.merchant.name}
                    <Link to={`/community/store/${product.merchant.id}`} className="underline underline-offset-2 ms-1">
                      {s.visitStore}
                    </Link>
                  </>
                ) : (
                  <>{s.officialStore} · Levonis</>
                )}
              </p>
              {availability?.stock.tracked && (options.length > 0 || (product.colors ?? []).length > 0) ? (
                <p className="mt-1 text-[12px] text-zinc-500">{s.stockProductScope}</p>
              ) : null}
            </div>

            {/* Purchase panel on PHONES: the same controls, stacked, with the
                CTA delegated to the single bottom bar (no doubled button). */}
            <div className="mt-5 space-y-3 lg:hidden">
              {priceBlock}
              {selectionBlocks}
              {qtyControl}
              {statusMessages}
            </div>

            {/* Content sections */}
            <div className="mt-6 space-y-3">
              <Section title={s.description} icon={<FileText aria-hidden="true" className="w-5 h-5 text-zinc-400" />} defaultOpen>
                {description ? (
                  <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-line">{description}</p>
                ) : (
                  <p className="text-sm text-zinc-500">{s.noDescription}</p>
                )}
              </Section>

              {product.how_to_use ? (
                <Section title={s.howToUse} icon={<Settings2 aria-hidden="true" className="w-5 h-5 text-zinc-400" />}>
                  <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-line">{product.how_to_use}</p>
                </Section>
              ) : null}

              {specGroups.length > 0 || legacySpecs.length > 0 ? (
                <Section title={s.specs} icon={<Settings2 aria-hidden="true" className="w-5 h-5 text-zinc-400" />}>
                  {specGroups.length > 0 ? (
                    <div className="space-y-4">
                      {specGroups.map((g, gi) => (
                        <div key={g.id || gi}>
                          {pick(lang as Lang, g.title_ar, g.title_en, g.title_ckb) ? (
                            <h4 className="text-white font-bold text-[13px] mb-2">
                              {pick(lang as Lang, g.title_ar, g.title_en, g.title_ckb)}
                            </h4>
                          ) : null}
                          <dl className="text-sm">
                            {(g.rows ?? []).map((r, ri) => (
                              <div key={r.id || ri} className="flex justify-between gap-3 py-2 border-b border-zinc-800/70 last:border-0">
                                <dt className="text-zinc-500">{pick(lang as Lang, r.label_ar, r.label_en, r.label_ckb)}</dt>
                                <dd className="text-zinc-200 text-end">
                                  {pick(lang as Lang, r.value_ar, r.value_en, r.value_ckb)}
                                  {r.unit ? ` ${r.unit}` : ''}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <dl className="text-sm">
                      {legacySpecs.map((spec, i) => (
                        <div key={i} className="flex justify-between gap-3 py-2 border-b border-zinc-800/70 last:border-0">
                          <dt className="text-zinc-500">{spec.key}</dt>
                          <dd className="text-zinc-200 text-end">{spec.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </Section>
              ) : null}

              {descriptionImages.length > 0 || descriptionVideos.length > 0 ? (
                <Section title={s.media} icon={<ImageIcon aria-hidden="true" className="w-5 h-5 text-zinc-400" />}>
                  {descriptionImages.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
                      {descriptionImages.map((img, i) => (
                        <SafeImage
                          key={i}
                          src={img}
                          alt=""
                          aspect="square"
                          fit="contain"
                          className="rounded-xl border border-zinc-800"
                          bgClassName="bg-zinc-900"
                        />
                      ))}
                    </div>
                  ) : null}
                  {descriptionVideos.map((video, i) => (
                    <div key={i} className="aspect-video rounded-xl overflow-hidden bg-black border border-zinc-800 mb-2 last:mb-0">
                      <video src={video} controls preload="none" className="w-full h-full object-contain" />
                    </div>
                  ))}
                </Section>
              ) : null}

              <div className="pt-2">
                <ReviewSection productId={product.id} />
              </div>
            </div>
          </div>

          {/* ------------------------------------------------- right column */}
          <aside className="hidden lg:block lg:sticky lg:top-4 space-y-3">
            {priceBlock}
            {selectionBlocks}
            <div className="rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4 space-y-3">
              {qtyControl}
              {buyButton}
              <p className="text-[11px] text-zinc-500 leading-relaxed">{s.serverChecks}</p>
            </div>
            {statusMessages}
          </aside>
        </div>
      </div>

      {/* ------------------------------------------------ phone purchase bar */}
      <div data-testid="product-buybar" className="lg:hidden fixed inset-x-0 bottom-0 z-40 bg-black/95 backdrop-blur-xl border-t border-zinc-800 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-[640px] flex items-center gap-3">
          <div className="min-w-0">
            <div className="text-[11px] text-zinc-500">{s.price}</div>
            <div className="text-white font-black text-[15px] tabular-nums truncate">
              {priceIsAuthoritative ? formatIqd(lineTotal!) : quoteLoading ? s.updatingPrice : '—'}
            </div>
          </div>
          <div className="flex-1">{buyButton}</div>
        </div>
      </div>

      {/* ------------------------------------------------------- image zoom */}
      {lightbox && activeMedia?.url ? (
        <div
          className="fixed inset-0 z-[200] bg-black/95 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={s.gallery}
          onClick={() => setLightbox(false)}
        >
          <button
            type="button"
            onClick={() => setLightbox(false)}
            aria-label={s.close}
            className="absolute top-4 end-4 w-11 h-11 rounded-full bg-zinc-900 border border-zinc-700 flex items-center justify-center text-white"
          >
            <X aria-hidden="true" className="w-5 h-5" />
          </button>
          <img
            src={activeMedia.url}
            alt={pick(lang as Lang, activeMedia.alt_ar, activeMedia.alt_en, activeMedia.alt_ckb) || name}
            referrerPolicy="no-referrer"
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
    </div>
  );
}
