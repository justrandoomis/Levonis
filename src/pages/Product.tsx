import { MotionCharacterHome } from '../components/bloub/MotionCharacterAnchor';
import { mascot } from '../lib/mascot';
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
import ShippingConflictDialog from '../components/cart/ShippingConflictDialog';
import { useAuth } from '../AuthContext';
import { useWallet } from '../WalletContext';
import {
  ArrowRight, ArrowLeft, ShoppingCart, Star, Sparkles, Check, Share2, Heart, Clock, Package,
  ChevronDown, Minus, Plus, X, FileText, Settings2, ShieldCheck, Truck,
  AlertTriangle, Store, ZoomIn, Image as ImageIcon, Box, ExternalLink, PlayCircle, Wrench, TrendingUp, PackageOpen,
} from 'lucide-react';
import ProAddressNotice from '../components/membership/ProAddressNotice';
import { api, ApiError, CartItem, pickText } from '../lib/api';
import { rememberViewed } from '../lib/recentlyViewed';
import { useGoBack } from '../lib/useGoBack';
import { useFreshOnReturn } from '../lib/useFreshOnReturn';
import { setCartCount, countCartItems } from '../lib/cartCount';
import ReviewSection from '../components/reviews/ReviewSection';
import CheaperElsewhereSheet from '../components/product/CheaperElsewhereSheet';
import GiniInstalmentsSheet, { giniLinkOf } from '../components/product/GiniInstalmentsSheet';
import SafeImage from '../components/ui/SafeImage';
import Note from '../components/ui/Note';
import { Overlay } from '../components/ui/Overlay';
import { ProductDetailSkeleton } from '../components/ui/Skeleton';
import { ErrorState, NotFoundState } from '../components/ui/AsyncStates';
import { monthsLabel } from '../components/orders/format';
import { authPathWithSupportRef, captureSupportRefFromSearch } from '../lib/supportRef';
import { refusalText, stockRefusal } from '../lib/refusalStrings';
import { productGalleryForSelection, productVariantIdForSelection } from '../lib/productImage';
import {
  formatPhysicalMeasurement,
  hasProductDimensions,
  resolveProductSelectionDimensions,
} from '../lib/productDimensions';
import type {
  ProductDimensionOverridesV2,
  ProductDimensionsV2,
} from '../lib/productTypes';
import { tierLabel } from '../components/subscription/tierMeta';
import ConditionPanel from '../components/product/ConditionPanel';
import StockAlertPanel from '../components/product/StockAlertPanel';
import {
  decodeAlertIntent,
  type AlertColorOption,
  type AlertModel,
  type StockAlertWish,
} from '../components/product/stockAlertTargets';
import { conditionKindLabel, type ConditionEntry } from '../lib/condition';
import { resolveOrderType, resolveTransport, routeIsUsable } from '../lib/productSelection';
import { useMoney } from '../CurrencyContext';
import { CommunityStoreLink } from './community/access';
import CompareBadge from '../components/compare/CompareBadge';

// ------------------------------------------------------------------ strings

const STRINGS = {
  ar: {
    compareCta: 'المقارنة', cheaperCta: 'وجدتها بمكان أرخص', giniCta: 'تريدها أقساط؟',
    back: 'رجوع', share: 'مشاركة', linkCopied: 'تم نسخ الرابط', favorite: 'إضافة للمفضلة',
    unfavorite: 'إزالة من المفضلة', gallery: 'صور المنتج', noImages: 'لا توجد صور لهذا المنتج',
    imageOf: 'صورة {n} من {total}', zoom: 'تكبير الصورة', close: 'إغلاق',
    officialStore: 'المتجر الرسمي', communityStore: 'متجر مجتمع', visitStore: 'زيارة المتجر',
    price: 'السعر', from: 'يبدأ من', regularPrice: 'السعر العادي',
    /**
     * NO TIER NAME IS TYPED ON THIS PAGE. It used to spell «PRIME» in all
     * three languages while the one table that owns the customer-facing names
     * (components/subscription/tierMeta.ts) says PREMIUM — this was the last
     * surface in the store still calling a tier by its API id. The label is
     * now an argument, and `tierLabel()` is the only thing that supplies it.
     */
    appliedPriceOf: (tier: string) => `سعر ${tier}`,
    memberPriceOf: (tier: string) => `سعر أعضاء ${tier}`,
    savedWithTier: (amount: string, tier: string) => `وفّرت ${amount} بعضوية ${tier}`,
    upgradeTo: (tier: string) => `الترقية إلى ${tier}`,
    subscribe: 'اشترك الآن', updatingPrice: 'يجري تحديث السعر…',
    priceUnavailable: 'أكمل الاختيار لعرض السعر النهائي',
    options: 'الخيارات المتاحة', colors: 'الألوان المتاحة', chooseOption: 'اختر خيارًا',
    chooseColor: 'اختر لونًا', transport: 'وسيلة النقل للطلب المسبق', chooseTransport: 'اختر وسيلة النقل',
    transportAir: 'شحن جوي', transportSea: 'شحن بحري', transportLand: 'شحن بري',
    transportUnset: 'بدون زيادة', warranty: 'الضمان الممدد', noWarranty: 'بدون ضمان ممدد',
    months: 'شهرًا', extension: 'تمديد', total: 'إجمالي',
    warrantyIntro: (base: string) => `الضمان الأساسي ${base} من التسليم. أضف تمديدًا الآن أو من السلة — قبل إتمام الطلب فقط.`,
    warrantyIntroNoBase: 'يُشترى التمديد الآن أو من السلة — قبل إتمام الطلب فقط.',
    extendedPlan: (ext: string) => `+${ext}`,
    extendedTotal: (total: string) => `${total} إجمالًا`,
    warrantyPolicy: 'شروط الضمان الممدد',
    WARRANTY_NOT_PRINTER: 'الضمان الممدد متاح للطابعات فقط.',
    qty: 'الكمية', increase: 'زيادة الكمية', decrease: 'إنقاص الكمية',
    addToCart: 'أضف إلى السلة', adding: 'جارٍ الإضافة…', added: 'تمت الإضافة إلى السلة',
    viewCart: 'عرض السلة', signInToBuy: 'سجّل الدخول للشراء',
    inCart: (n: number) => `في السلة: ${n}`,
    directSale: 'بيع مباشر', preorderMode: 'طلب مسبق', unavailable: 'غير متوفر',
    salesSold: 'مبيعات',
    reviewsCount: (n: number): string => (n === 1 ? 'تقييم' : n === 2 ? 'تقييمان' : n <= 10 ? 'تقييمات' : 'تقييماً'),
    ratingAria: (avg: string, n: number): string => `التقييم ${avg} من 5، من ${n} تقييم`,
    salesAria: (tier: string): string => `أكثر من ${tier} عملية بيع`,
    fulfilment: 'طريقة التوفر', fulfilDirectSub: 'يصلك فورًا من المخزون', fulfilPreorderSub: 'يُطلب لك ثم يُشحن',
    levelOut: 'نفد', levelLeft: 'بقي {n}', levelAvail: 'متوفر {n}',
    inStock: 'متوفر', lowStock: 'بقي {n} فقط', stockProductScope: 'الكمية مسجّلة على مستوى المنتج وليست لكل خيار',
    untracked: 'التوفر غير مرتبط بعدّاد مخزون',
    qtyCapped: 'المتاح الآن {n} فقط — لم نضف الباقي كطلب مسبق',
    lineTotal: 'إجمالي البنود',
    preorderCodHint: 'الدفع مقدمًا من المحفظة يُبقي هذا السعر؛ الدفع عند الاستلام يُسعَّر كبيع مباشر ويبقى الطلب طلبًا مسبقًا.',
    CART_WARRANTY_CONFLICT: 'هذه الطابعة في سلتك بخيار ضمان ممدد مختلف — غيّره من السلة.',
    printerNote: (v: string) => `عند طلب توصيل الطابعة إلى المنزل يُدفع ${v} مقدماً من المحفظة.`,
    description: 'وصف المنتج', noDescription: 'لا يوجد وصف لهذا المنتج بعد',
    specs: 'المواصفات التقنية', media: 'الصور والفيديو', reviews: 'التقييمات',
    howToUse: 'طريقة الاستخدام', inTheBox: 'محتويات العلبة', setupTitle: 'التركيب والتنصيب',
    officialGuide: 'الدليل الرسمي', watchVideo: 'مشاهدة الفيديو', stepDoc: 'الشرح الرسمي لهذه الخطوة',
    serverChecks: 'يُعاد التحقق من السعر والتوفر على الخادم عند السلة وعند تأكيد الطلب.',
    // machine reasons → honest text
    OUT_OF_STOCK: 'نفد المخزون حاليًا.',
    /**
     * 0075 — THE PRE-ORDER COUNTER, WHICH IS NOT THE SHELF. A pre-order is
     * bought from a supplier, so «نفد المخزون» would be the wrong sentence:
     * the shelf may be full and the import quota still closed.
     */
    PREORDER_CAPACITY_EXHAUSTED: 'اكتملت حصة الطلب المسبق لهذا الاختيار.',
    routeQuotaFull: 'اكتملت حصة هذه الطريقة',
    preorderLeft: 'بقي {n} من حصة الطلب المسبق',
    directSoldOutPreorderOpen: 'نفد مخزون البيع المباشر — الطلب المسبق ما زال متاحًا.',
    PREORDER_NOT_ENABLED: 'الطلب المسبق غير مفعّل لهذا المنتج.',
    NO_TRANSPORT_OFFERED: 'الطلب المسبق مفعّل لكن لا توجد وسيلة نقل معروضة.',
    TRANSPORT_COMMISSION_UNCONFIGURED: 'طريقة الشحن هذه غير متاحة حاليًا.',
    COMMUNITY_LISTING_NOT_SELLABLE: 'هذا عرض من متجر مجتمعي ولا يُشترى عبر سلة المتجر.',
    OPTION_REQUIRED: 'اختر خيارًا أولًا.', OPTION_GROUP_REQUIRED: 'اختر قيمة من كل مجموعة خيارات.',
    OPTION_GROUP_DUPLICATE_SELECTION: 'اختر قيمة واحدة فقط من كل مجموعة.', COLOR_REQUIRED: 'اختر لونًا أولًا.',
    OPTION_NOT_FOUND: 'الخيار المحدد غير موجود.', OPTION_INACTIVE: 'الخيار المحدد لم يعد متاحًا.',
    COLOR_NOT_FOUND: 'اللون المحدد غير موجود.', COLOR_INACTIVE: 'اللون المحدد لم يعد متاحًا.',
    COLOR_OPTION_MISMATCH: 'هذا اللون لا يناسب الخيار المحدد.',
    TRANSPORT_REQUIRED: 'اختر وسيلة النقل.', TRANSPORT_NOT_OFFERED: 'وسيلة النقل غير معروضة.',
    TRANSPORT_NOT_APPLICABLE: 'وسيلة النقل لا تنطبق على البيع المباشر.',
    WARRANTY_PLAN_NOT_FOUND: 'خطة الضمان غير متاحة.',
    REGULAR_PRICE_INVALID: 'سعر هذا المنتج غير صالح — تواصل مع الدعم.',
  },
  en: {
    compareCta: 'Compare', cheaperCta: 'Found it cheaper', giniCta: 'Want it in instalments?',
    back: 'Back', share: 'Share', linkCopied: 'Link copied', favorite: 'Add to favourites',
    unfavorite: 'Remove from favourites', gallery: 'Product images', noImages: 'This product has no images yet',
    imageOf: 'Image {n} of {total}', zoom: 'Zoom image', close: 'Close',
    officialStore: 'Official store', communityStore: 'Community store', visitStore: 'Visit store',
    price: 'Price', from: 'From', regularPrice: 'Regular price',
    appliedPriceOf: (tier: string) => `${tier} price`,
    memberPriceOf: (tier: string) => `${tier} member price`,
    savedWithTier: (amount: string, tier: string) => `Saved ${amount} with ${tier} membership`,
    upgradeTo: (tier: string) => `Upgrade to ${tier}`,
    subscribe: 'Subscribe', updatingPrice: 'Updating price…',
    priceUnavailable: 'Complete your selection to see the final price',
    options: 'Options', colors: 'Colours', chooseOption: 'Choose an option',
    chooseColor: 'Choose a colour', transport: 'Pre-order transport', chooseTransport: 'Choose transport',
    transportAir: 'Air freight', transportSea: 'Sea freight', transportLand: 'Land freight',
    transportUnset: 'No added fee', warranty: 'Extended Warranty', noWarranty: 'No extended warranty',
    months: 'months', extension: 'extension', total: 'total',
    warrantyIntro: (base: string) => `${base} base warranty from delivery. Add an extension now or in the cart — before placing the order only.`,
    warrantyIntroNoBase: 'An extension is bought now or in the cart — before placing the order only.',
    extendedPlan: (ext: string) => `+${ext}`,
    extendedTotal: (total: string) => `${total} total`,
    warrantyPolicy: 'Extended warranty terms',
    WARRANTY_NOT_PRINTER: 'Extended warranty is available for printers only.',
    qty: 'Quantity', increase: 'Increase quantity', decrease: 'Decrease quantity',
    addToCart: 'Add to cart', adding: 'Adding…', added: 'Added to your cart',
    viewCart: 'View cart', signInToBuy: 'Sign in to buy',
    inCart: (n: number) => `In your cart: ${n}`,
    directSale: 'Direct sale', preorderMode: 'Pre-order', unavailable: 'Unavailable',
    salesSold: 'sold',
    reviewsCount: (n: number): string => (n === 1 ? 'review' : 'reviews'),
    ratingAria: (avg: string, n: number): string => `Rated ${avg} out of 5, from ${n} reviews`,
    salesAria: (tier: string): string => `More than ${tier} sold`,
    fulfilment: 'Availability', fulfilDirectSub: 'Ships now from stock', fulfilPreorderSub: 'Ordered for you, then shipped',
    levelOut: 'Out', levelLeft: '{n} left', levelAvail: '{n} available',
    inStock: 'In stock', lowStock: 'Only {n} left', stockProductScope: 'Stock is tracked per product, not per option',
    untracked: 'Availability is not tied to a stock counter',
    qtyCapped: 'Only {n} available now — the rest was not turned into a pre-order',
    lineTotal: 'Line total',
    preorderCodHint: 'Paying in advance from the wallet keeps this price; cash on delivery is priced as a direct sale while the order stays a pre-order.',
    CART_WARRANTY_CONFLICT: 'This printer is already in your cart with a different extended-warranty choice — change it from the cart.',
    printerNote: (v: string) => `When home delivery is requested for a printer, ${v} is paid in advance from your wallet.`,
    description: 'Description', noDescription: 'No description for this product yet',
    specs: 'Specifications', media: 'Photos & video', reviews: 'Reviews',
    howToUse: 'How to use', inTheBox: 'In the box', setupTitle: 'Setup & installation',
    officialGuide: 'Official guide', watchVideo: 'Watch the video', stepDoc: 'Official doc for this step',
    serverChecks: 'Price and availability are re-checked on the server at cart and at checkout.',
    OUT_OF_STOCK: 'Out of stock right now.',
    PREORDER_CAPACITY_EXHAUSTED: 'The pre-order quota for this selection is full.',
    routeQuotaFull: 'This route’s quota is full',
    preorderLeft: '{n} left in the pre-order quota',
    directSoldOutPreorderOpen: 'Direct sale is sold out — pre-order is still open.',
    PREORDER_NOT_ENABLED: 'Pre-order is not enabled for this product.',
    NO_TRANSPORT_OFFERED: 'Pre-order is enabled but no transport option is offered.',
    TRANSPORT_COMMISSION_UNCONFIGURED: 'This shipping route is not available right now.',
    COMMUNITY_LISTING_NOT_SELLABLE: 'This is a community listing and is not sold through the store cart.',
    OPTION_REQUIRED: 'Choose an option first.', OPTION_GROUP_REQUIRED: 'Choose one value from every option group.',
    OPTION_GROUP_DUPLICATE_SELECTION: 'Choose only one value from each group.', COLOR_REQUIRED: 'Choose a colour first.',
    OPTION_NOT_FOUND: 'The selected option does not exist.', OPTION_INACTIVE: 'The selected option is no longer available.',
    COLOR_NOT_FOUND: 'The selected colour does not exist.', COLOR_INACTIVE: 'The selected colour is no longer available.',
    COLOR_OPTION_MISMATCH: 'That colour does not belong to the selected option.',
    TRANSPORT_REQUIRED: 'Choose a transport method.', TRANSPORT_NOT_OFFERED: 'That transport method is not offered.',
    TRANSPORT_NOT_APPLICABLE: 'Transport does not apply to a direct sale.',
    WARRANTY_PLAN_NOT_FOUND: 'That warranty plan is unavailable.',
    REGULAR_PRICE_INVALID: 'This product has an invalid price — please contact support.',
  },
  ckb: {
    compareCta: 'بەراورد', cheaperCta: 'لە شوێنێکی هەرزانتر دۆزیمەوە', giniCta: 'بە قیست دەتەوێت؟',
    back: 'گەڕانەوە', share: 'هاوبەشکردن', linkCopied: 'بەستەرەکە کۆپی کرا', favorite: 'زیادکردن بۆ دڵخوازەکان',
    unfavorite: 'لابردن لە دڵخوازەکان', gallery: 'وێنەکانی بەرهەم', noImages: 'ئەم بەرهەمە هێشتا وێنەی نییە',
    imageOf: 'وێنەی {n} لە {total}', zoom: 'گەورەکردنی وێنە', close: 'داخستن',
    officialStore: 'فرۆشگای فەرمی', communityStore: 'فرۆشگای کۆمەڵگا', visitStore: 'سەردانی فرۆشگا',
    price: 'نرخ', from: 'دەست پێدەکات لە', regularPrice: 'نرخی ئاسایی',
    /*
     * The Kurdish below is the store's OWN wording, reused — nothing here was
     * translated. «نرخی ئەندامانی …» and «نرخی PRO …» were already in this
     * block; «پاشەکەوتت کرد» is the cart's saved line (pages/Cart.tsx);
     * «ئەندامێتی PRO» is the referrals page (pages/Referrals.tsx); «بەشداری …
     * بکە» is the merchant dashboard (pages/MerchantDashboardPage.tsx). Only
     * the Latin tier name is a variable, as it is in every language.
     */
    appliedPriceOf: (tier: string) => `نرخی ${tier}`,
    memberPriceOf: (tier: string) => `نرخی ئەندامانی ${tier}`,
    savedWithTier: (amount: string, tier: string) => `پاشەکەوتت کرد ${amount} — ئەندامێتی ${tier}`,
    upgradeTo: (tier: string) => `بەشداری ${tier} بکە`,
    subscribe: 'بەشداربە', updatingPrice: 'نرخ نوێ دەکرێتەوە…',
    priceUnavailable: 'هەڵبژاردنەکەت تەواو بکە بۆ بینینی نرخی کۆتایی',
    options: 'هەڵبژاردەکان', colors: 'ڕەنگەکان', chooseOption: 'هەڵبژاردەیەک هەڵبژێرە',
    chooseColor: 'ڕەنگێک هەڵبژێرە', transport: 'گواستنەوەی پێشداواکاری', chooseTransport: 'شێوازی گواستنەوە هەڵبژێرە',
    transportAir: 'بار بە ئاسمان', transportSea: 'بار بە دەریا', transportLand: 'بار بە وشکانی',
    transportUnset: 'بێ زیادە', warranty: 'گەرەنتی درێژکراوە', noWarranty: 'بێ گەرەنتی درێژکراوە',
    months: 'مانگ', extension: 'درێژکردنەوە', total: 'کۆ',
    warrantyIntro: (base: string) => `گەرەنتی بنەڕەتی ${base} لە گەیاندنەوە. درێژکردنەوە ئێستا یان لە سەبەتە زیاد بکە — تەنها پێش تەواوکردنی داواکاری.`,
    warrantyIntroNoBase: 'درێژکردنەوە ئێستا یان لە سەبەتە دەکڕدرێت — تەنها پێش تەواوکردنی داواکاری.',
    extendedPlan: (ext: string) => `+${ext}`,
    extendedTotal: (total: string) => `${total} کۆی گشتی`,
    warrantyPolicy: 'مەرجەکانی گەرەنتی درێژکراوە',
    WARRANTY_NOT_PRINTER: 'گەرەنتی درێژکراوە تەنها بۆ پرینتەرەکانە.',
    qty: 'بڕ', increase: 'زیادکردنی بڕ', decrease: 'کەمکردنی بڕ',
    addToCart: 'زیادکردن بۆ سەبەتە', adding: 'زیاد دەکرێت…', added: 'زیادکرا بۆ سەبەتەکەت',
    viewCart: 'بینینی سەبەتە', signInToBuy: 'بچۆ ژوورەوە بۆ کڕین',
    inCart: (n: number) => `لە سەبەتەکەتدا: ${n}`,
    directSale: 'فرۆشتنی ڕاستەوخۆ', preorderMode: 'پێشداواکاری', unavailable: 'بەردەست نییە',
    salesSold: 'فرۆشراو',
    reviewsCount: (n: number): string => (n === 1 ? 'هەڵسەنگاندن' : 'هەڵسەنگاندن'),
    ratingAria: (avg: string, n: number): string => `${avg} لە 5، لە ${n} هەڵسەنگاندن`,
    salesAria: (tier: string): string => `زیاتر لە ${tier} فرۆشراوە`,
    fulfilment: 'شێوازی بەردەستبوون', fulfilDirectSub: 'یەکسەر لە کۆگاوە دەگات', fulfilPreorderSub: 'بۆت داوا دەکرێت پاشان دەنێردرێت',
    levelOut: 'نەماوە', levelLeft: '{n} ماوە', levelAvail: '{n} بەردەستە',
    inStock: 'بەردەستە', lowStock: 'تەنها {n} ماوە', stockProductScope: 'بڕ لەسەر ئاستی بەرهەم تۆمار کراوە، نەک بۆ هەر هەڵبژاردەیەک',
    untracked: 'بەردەستی بە ژمێرەری کۆگا نەبەستراوە',
    qtyCapped: 'تەنها {n} بەردەستە ئێستا — ئەوەی ماوە نەکرا بە پێشداواکاری',
    lineTotal: 'کۆی گشتی',
    preorderCodHint: 'پارەدانی پێشوەخت لە جزدانەوە ئەم نرخە دەهێڵێتەوە؛ پارەدان لە کاتی گەیاندن وەک فرۆشتنی ڕاستەوخۆ نرخ دەکرێت و داواکارییەکە وەک پێش-داواکاری دەمێنێتەوە.',
    CART_WARRANTY_CONFLICT: 'ئەم پرینتەرە پێشتر لە سەبەتەکەتدایە بە هەڵبژاردەیەکی جیاوازی گەرەنتی درێژکراوە — لە سەبەتەوە بیگۆڕە.',
    printerNote: (v: string) => `کاتێک گەیاندنی پرینتەر بۆ ماڵەوە داوا دەکرێت، ${v} پێشوەخت لە جزدانەکەتەوە دەدرێت.`,
    description: 'باسکردن', noDescription: 'هێشتا باسکردنێک بۆ ئەم بەرهەمە نییە',
    specs: 'تایبەتمەندییە تەکنیکییەکان', media: 'وێنە و ڤیدیۆ', reviews: 'پێداچوونەوەکان',
    howToUse: 'شێوازی بەکارهێنان', inTheBox: 'ناو سندوقەکە', setupTitle: 'دامەزراندن و ڕێکخستن',
    officialGuide: 'ڕێبەری فەرمی', watchVideo: 'ڤیدیۆکە ببینە', stepDoc: 'بەڵگەنامەی فەرمی ئەم هەنگاوە',
    serverChecks: 'نرخ و بەردەستی لەسەر ڕاژەکار دووبارە پشکنین دەکرێن لە سەبەتە و لە کاتی داواکاری.',
    OUT_OF_STOCK: 'ئێستا لە کۆگا نییە.',
    /*
     * NO SORANI IS INVENTED HERE. These four sentences arrived with 0075 and
     * the Kurdish for them is the owner's to write by hand — the same rule the
     * rest of this block follows («nothing here was translated»). Until they
     * do, a Kurdish reader gets the ARABIC sentence, which is the documented
     * fallback elsewhere in this app (components/adminBenefits/shared.ts),
     * rather than a machine translation of a refusal.
     */
    PREORDER_CAPACITY_EXHAUSTED: 'اكتملت حصة الطلب المسبق لهذا الاختيار.',
    routeQuotaFull: 'اكتملت حصة هذه الطريقة',
    preorderLeft: 'بقي {n} من حصة الطلب المسبق',
    directSoldOutPreorderOpen: 'نفد مخزون البيع المباشر — الطلب المسبق ما زال متاحًا.',
    PREORDER_NOT_ENABLED: 'پێشداواکاری بۆ ئەم بەرهەمە چالاک نەکراوە.',
    NO_TRANSPORT_OFFERED: 'پێشداواکاری چالاکە بەڵام هیچ شێوازی گواستنەوە پێشکەش نەکراوە.',
    TRANSPORT_COMMISSION_UNCONFIGURED: 'ئەم ڕێگای ناردنە لە ئێستادا بەردەست نییە.',
    COMMUNITY_LISTING_NOT_SELLABLE: 'ئەمە ڕیکلامی فرۆشگای کۆمەڵگایە و بە سەبەتەی فرۆشگا نافرۆشرێت.',
    OPTION_REQUIRED: 'سەرەتا هەڵبژاردەیەک هەڵبژێرە.', OPTION_GROUP_REQUIRED: 'لە هەر گرووپێکدا یەک بەها هەڵبژێرە.',
    OPTION_GROUP_DUPLICATE_SELECTION: 'لە هەر گرووپێکدا تەنها یەک بەها هەڵبژێرە.', COLOR_REQUIRED: 'سەرەتا ڕەنگێک هەڵبژێرە.',
    OPTION_NOT_FOUND: 'هەڵبژاردەی دیاریکراو نییە.', OPTION_INACTIVE: 'هەڵبژاردەی دیاریکراو چیتر بەردەست نییە.',
    COLOR_NOT_FOUND: 'ڕەنگی دیاریکراو نییە.', COLOR_INACTIVE: 'ڕەنگی دیاریکراو چیتر بەردەست نییە.',
    COLOR_OPTION_MISMATCH: 'ئەم ڕەنگە بۆ ئەم هەڵبژاردەیە نییە.',
    TRANSPORT_REQUIRED: 'شێوازی گواستنەوە هەڵبژێرە.', TRANSPORT_NOT_OFFERED: 'ئەم شێوازی گواستنەوەیە پێشکەش نەکراوە.',
    TRANSPORT_NOT_APPLICABLE: 'گواستنەوە بۆ فرۆشتنی ڕاستەوخۆ ناگونجێت.',
    WARRANTY_PLAN_NOT_FOUND: 'ئەم پلانی گەرەنتییە بەردەست نییە.',
    REGULAR_PRICE_INVALID: 'نرخی ئەم بەرهەمە دروست نییە — پەیوەندی بە پشتگیری بکە.',
  },
} as const;

type Strings = { readonly [K in keyof typeof STRINGS['ar']]: (typeof STRINGS)['ar'][K] extends string ? string : (typeof STRINGS)['ar'][K] };

// -------------------------------------------------------------------- types

type ProductSource = 'catalog' | 'community';

interface MediaItem {
  id?: string; url: string; alt_ar?: string; alt_en?: string; alt_ckb?: string;
  order?: number; primary?: boolean;
  option_value_id?: string | null; color_id?: string | null; variant_id?: string | null;
}
interface OptionItem extends ProductDimensionOverridesV2 {
  id: string; name_ar?: string; name_en?: string; name_ckb?: string; name?: string;
  /** 0043. Absent on every product written before per-option availability,
   *  which is exactly why the two-step chooser below is opt-in. */
  availability_type?: '' | 'direct_sale' | 'pre_order';
  /** Modern models carry independent direct/pre-order cells on one option. */
  fulfillments?: Array<{ fulfillment_type: 'direct_sale' | 'pre_order'; enabled?: boolean }>;
  variant_key?: string;
  variant_label?: string;
  lead_time_text?: string;
  /** 0079. «مدة التجهيز» in the two other languages; '' = read the source. */
  lead_time_text_ar?: string;
  lead_time_text_ckb?: string;
  lead_time_min_days?: number | null;
  lead_time_max_days?: number | null;
}
interface ColorItem extends ProductDimensionOverridesV2 {
  id: string; name_ar?: string; name_en?: string; name_ckb?: string; name?: string;
  hex?: string; option_id?: string | null;
}
/** A plan as the server prices it for a selection (worker/lib/warrantyPlans.ts
 *  pricedPlans): `fee_iqd` is already the resolved dinar, `total_months` the
 *  coverage it yields — the page shows both and computes neither. */
interface WarrantyPlanItem {
  id: string; title_ar?: string; title_en?: string; title_ckb?: string;
  duration_months: number; duration_kind: 'total' | 'extension' | string; fee_iqd: number;
  fee_percent?: number | null; basis_iqd?: number; base_months?: number | null; total_months?: number | null;
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
  /** The owner's catalog flag; the printer home-delivery note keys off it. */
  is_printer?: boolean;
  media?: MediaItem[]; images?: string[];
  dimensions?: ProductDimensionsV2;
  options?: OptionItem[]; colors?: ColorItem[];
  warranty_plans?: WarrantyPlanItem[];
  /** Base coverage in months from delivery (printers: 12); null = not configured. */
  warranty_base_months?: number | null;
  spec_groups?: SpecGroup[]; specifications?: Array<{ key: string; value: string }>;
  description_images?: string[]; description_videos?: string[];
  how_to_use?: string; how_to_use_ar?: string; how_to_use_ckb?: string;
  brand?: string; stock?: number | null;
  spec_fields?: Record<string, string>;
  usage_guide?: {
    official_url: string;
    steps: Array<{
      id: string; kind: 'setup' | 'usage'; title: string; body: string;
      /** 0079. '' = nothing authored in this language; read the source. */
      title_ar?: string; title_ckb?: string; body_ar?: string; body_ckb?: string;
      images: string[]; video_url: string; link_url: string; order: number;
    }>;
  };
  merchant?: { id: string; name: string; verified: boolean };
  /** This product's own page in the Gini app — the only thing «تريدها أقساط؟»
   *  can open. Empty (or absent on an older worker) means the shop has not
   *  listed this product there, and the note is not drawn at all. */
  gini_url?: string;
  /** The CHEAPEST way to buy this product, resolved at the viewer's tier —
   *  the same number the card showed. Never `price_iqd`, which is the base
   *  row and may be a price nobody is charged. */
  display_price_iqd?: number;
  /** True only when the variants GENUINELY differ in price; the server proved
   *  it by resolving every one of them. This is what «يبدأ من» is allowed to
   *  key off — the page must never infer it from not having a quote yet. */
  display_from?: boolean;
  /**
   * The scheduled window on this product (worker/routes/products.ts
   * `projectProduct`). `price_source: 'offer'` means a LIVE, eligible window
   * is what set the regular price of every level — read here only to know
   * whether a membership is the whole reason a price fell (see
   * `memberSavingIqd`), never to price anything.
   */
  offer?: { schedule_state?: string; price_source?: 'ladder' | 'offer'; locked?: boolean } | null;
}

/** The relational structure (worker publicRelations): per-level sellable
 *  counts and image↔choice bindings the legacy JSON shape cannot express. */
interface RelationsPayload {
  inventory_mode: 'BASE' | 'OPTION' | 'COLOR' | 'VARIANT_COMBINATION' | string;
  option_groups: Array<{
    id: string; name_en: string; sort: number;
    values: Array<{
      id: string; name_en: string; image: string; sort: number; available: number | null;
    } & ProductDimensionOverridesV2>;
  }>;
  colors: Array<{
    id: string; name_en: string; hex: string; image: string; sort: number; available: number | null;
    links?: Array<{ group_id: string; option_value_id: string }>;
  } & ProductDimensionOverridesV2>;
  variants?: Array<{
    id: string; combo_key: string; available: number | null;
  } & ProductDimensionOverridesV2>;
  images: Array<{
    id: string; url: string; alt_en: string; sort_order: number; is_primary: boolean;
    option_value_id: string | null; color_id: string | null; variant_id: string | null;
  }>;
}

interface TransportView { method: string; commission_iqd: number | null; configured: boolean }

/**
 * 0075 — THE PRE-ORDER COUNTER FOR ONE ROUTE, AS THE SERVER RESOLVED IT.
 *
 * `available: null` is UNTRACKED — no limit was claimed, which is how every
 * pre-order in this catalogue behaved before 0075 — and `0` is a tracked
 * counter with nothing left. `scope` says WHOSE number it is: 'preorder' means
 * the route is spending the model's SHARED pool (so the other routes show the
 * same figure and move with it), 'preorder_transport' means it holds its own.
 *
 * The page never adds these together and never compares them with `stock`:
 * two counters, and only the server decides which one a line consumes.
 */
interface PreorderRouteView {
  method: string;
  available: number | null;
  scope: 'preorder' | 'preorder_transport' | null;
  scope_id: string;
  usable: boolean;
  reason: string | null;
}

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
    option_value_ids?: string[];
    complete: boolean; errors: string[];
  };
  /** §6: every sale type the product offers, with whether it can be used. */
  modes?: Array<{ type: 'direct_sale' | 'pre_order'; usable: boolean; reason: string | null }>;
  preorder: {
    enabled: boolean;
    usable: boolean;
    reason: string | null;
    transports: TransportView[];
    /** 0075. Optional: a Worker from before this change sends neither, and the
     *  page then behaves exactly as it did — untracked, unlimited. */
    routes?: PreorderRouteView[];
    capacity?: {
      tracked: boolean;
      scope: 'preorder' | 'preorder_transport' | null;
      scope_id: string;
      available: number | null;
      max_qty: number;
    };
  };
  qty_ok: boolean;
}

interface Quote {
  regular_iqd: number; pro_iqd: number | null; prime_iqd: number | null; applied_iqd: number;
  applied_tier: 'regular' | 'pro' | 'prime'; price_source: string;
  transport: { method: string; commission_iqd: number; waived: boolean; waived_by?: string } | null;
  /** The direct-sale premium that applies; `waived` = an active PRO pays 0 of it. */
  direct?: { surcharge_iqd: number; waived: boolean } | null;
  pricing_basis?: 'direct' | 'preorder';
  warranty: {
    plan_id: string; title_ar: string; fee_iqd: number; duration_months: number; duration_kind: string;
    fee_percent?: number | null; total_months?: number | null; base_months?: number | null;
  } | null;
  unit_subtotal_iqd: number; errors: string[]; qty: number; line_total_iqd: number;
}

/**
 * The FINAL price of every way to get the selection, as the SERVER priced it
 * (worker/routes/products.ts `pricingModes`): the direct pill, each pre-order
 * journey paid in advance or cash on delivery, and whether cash changes the
 * number at all. The page lays these out and computes none of them — the PRO
 * exemptions are already applied exactly as the checkout applies them.
 */
interface PricingModes {
  direct: { unit_subtotal_iqd: number; direct: { surcharge_iqd: number; waived: boolean } | null } | null;
  preorder: Array<{
    method: string;
    prepaid: { unit_subtotal_iqd: number } | null;
    cod: { unit_subtotal_iqd: number; pricing_basis?: 'direct' | 'preorder' } | null;
    cod_reprices: boolean;
  }>;
  cod_reprices: boolean;
}

/** `active` is the membership; `pricing_active` is what the figures on the
 *  same response were priced with (a PRO outside the PRO purchase context —
 *  default address not approved — is active, and priced as ordinary). */
interface ViewerTier {
  tier: 'free' | 'plus' | 'pro' | 'prime';
  active: boolean;
  pricing_active?: boolean;
  pro_benefits_context?: boolean;
}

/**
 * ONE SELECTION'S PRICE, AS THE SERVER RESOLVED IT ON THE PAGE REQUEST
 * (worker/routes/products.ts `priceLevels`). Not a hint and not an estimate —
 * the same resolver, the same membership context and the same live offer that
 * price the door, run for every selection the choosers can reach, so a tap can
 * paint the exact figure on its own frame instead of waiting for a round trip.
 */
interface PriceLevel {
  applied_iqd: number;
  regular_iqd: number;
  unit_subtotal_iqd: number;
  applied_tier: 'regular' | 'pro' | 'prime';
}

interface PriceLevels {
  base: PriceLevel;
  option: Record<string, PriceLevel>;
  color: Record<string, PriceLevel>;
  /** Keyed `optionId|colorId`. Empty when `complete` is false. */
  combo: Record<string, PriceLevel>;
  /** False = the combination grid was too large to publish; a combination
   *  price is then genuinely unknown until the quote lands, and the page says
   *  so rather than guessing. */
  complete: boolean;
}

/**
 * §8/§9 — WHAT A MEMBERSHIP WOULD PAY FOR THIS EXACT SELECTION.
 *
 * Resolved by the server (worker/routes/products.ts `membershipPreview`)
 * through the very rules the checkout reads, so the figure shown to someone
 * deciding whether to subscribe is the figure they are charged afterwards.
 * `null` for a tier means there is NOTHING TO PROMISE for this selection — the
 * page then says nothing at all, rather than an "up to" number it would have
 * had to invent.
 */
interface MembershipPreviewTier {
  /** What that tier pays for the goods. */
  unit_iqd: number;
  regular_iqd: number;
  /** `regular_iqd - unit_iqd`, computed on the server. */
  saving_iqd: number;
  /** The benefit rule behind it, or null when a typed member price is. */
  rule_id: string | null;
}

interface MembershipPreview {
  prime: MembershipPreviewTier | null;
  pro: MembershipPreviewTier | null;
}

interface DetailResponse {
  product: ProductDetail;
  /** The opening selection's quote, already resolved by the server on this
   *  request. It is the first shelf-backed direct selection when one exists. */
  pricing?: Omit<Quote, 'qty' | 'line_total_iqd'>;
  initial_selection?: {
    option_id: string | null;
    option_value_ids: string[];
    color_id: string | null;
    fulfillment_type: 'direct_sale';
  } | null;
  price_levels?: PriceLevels;
  /** The BASE selection's membership preview, so §8/§9 can be stated on the
   *  FIRST PAINT instead of waiting for the debounced quote. */
  membership_preview?: MembershipPreview;
  source: ProductSource;
  favorite: boolean;
  relations?: RelationsPayload | null;
  availability?: Availability;
  /** The ways to buy the BASE selection, priced by the server. */
  pricing_modes?: PricingModes;
  viewer_tier?: ViewerTier;
  /** §10: a composition slug answers with the canonical location beside its
   *  payload, so an old `/product/<bundle>` link still works. */
  redirect?: string;
  /**
   * The header's two extra signals.
   *
   * `sales_badge` is a TIER the product has genuinely passed, never the exact
   * count — the raw figure is bucketed in the Worker and never sent, so the
   * shop's per-product sales volume is not published to anyone who opens
   * devtools (worker/lib/salesBadge.ts). Null below the first tier.
   */
  sales_badge?: number | null;
  rating?: { average: number; count: number } | null;
  /** The linked new product's CURRENT price, when this is a graded listing. */
  condition_reference?: { reference_iqd: number; saving_iqd: number } | null;
}

interface QuoteResponse {
  quote: Quote;
  availability: Availability;
  /** The same preview, re-resolved for THIS selection. */
  membership_preview?: MembershipPreview;
  /** The extended-warranty options re-priced for THIS selection's regular price. */
  warranty_plans?: WarrantyPlanItem[];
  /** The ways to buy THIS selection, priced by the server. */
  pricing_modes?: PricingModes;
  viewer_tier?: ViewerTier;
}

// ------------------------------------------------------------------ helpers

type Lang = 'ar' | 'en' | 'ckb';

/**
 * The tier §9's line invites the viewer to, named by the one table that owns
 * the customer-facing names. PRO is the highest tier, so this line is shown to
 * everyone below it — a PREMIUM member included.
 */
const PRO_LABEL = tierLabel('pro');

/**
 * The product, option and colour NAMES are English in every language
 * (product-form mandate §3: "عنوان/اسم المنتج يبقى باللغة الإنجليزية في جميع
 * الواجهات ولا تتم ترجمته"; §7 defines option and colour names as English
 * only). The ar/ckb slots are filled with the same English string on save, so
 * the fallbacks here only matter for rows saved before that rule existed.
 */
function pickName(en?: string, legacy?: string, ar?: string): string {
  return (en || legacy || ar || '').trim();
}

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
  const { money } = useMoney();
  const { slug } = useParams();
  const location = useLocation();
  const urlSlug = useSyncExternalStore(subscribeToPath, readPathSlug, readPathSlugServer);
  // The URL is authoritative for "which product should be on screen"; the
  // route param is the fallback (and the loader's input) once the router has
  // caught up.
  const shownSlug = urlSlug || slug;
  const navigate = useNavigate();
  /** The catalogue is this page's parent: a visitor who arrived from WhatsApp
   *  has no history to pop, and «رجوع» must take them INTO the shop. */
  const goBack = useGoBack('/products');
  const { lang, dir } = useLanguage();
  const { isAuthenticated } = useAuth();
  const [cheaperOpen, setCheaperOpen] = useState(false);
  const [giniOpen, setGiniOpen] = useState(false);
  const { settings: publicSettings } = useWallet();
  const s = STRINGS[lang as Lang];
  const pageRef = useRef<HTMLDivElement>(null);
  const pageHeaderRef = useRef<HTMLDivElement>(null);
  // The printer home-delivery note amount — the owner's public setting. null
  // when unset: the note is never shown with an invented figure.
  const printerNoteIqd = (() => {
    const n = publicSettings?.printerHomeDeliveryNoteIqd;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
  })();

  const [product, setProduct] = useState<ProductDetail | null>(null);

  /**
   * «تريدها أقساط؟» — WHETHER THE NOTE EXISTS AT ALL.
   *
   * Both halves are facts, not preferences: the owner's switch
   * (`giniPolicy.enabled`, the same one that decides whether checkout offers
   * the method) and a usable link to THIS product in the app. A note without a
   * link is an offer the shop cannot keep, so it is not drawn — no greyed
   * line, no "coming soon", nothing. `app_url` is deliberately NOT a fallback
   * here: the owner asked for «يكون رابط المنتج في تطبيق جني», and a landing
   * page that cannot show this product would be the wrong promise under this
   * sentence.
   *
   * IT WAITS FOR THE SETTINGS RATHER THAN GUESSING. Drawing the note while
   * `publicSettings` is still null and then removing it a moment later is a
   * promise made and withdrawn on the screen; not knowing yet is not a reason
   * to offer. A worker old enough to have no `giniPolicy` at all leaves
   * `enabled` undefined, which is not `false` — there the product's own link
   * is the whole answer, as it was before the setting existed.
   */
  const giniPolicy = publicSettings?.giniPolicy;
  const giniLink = publicSettings && giniPolicy?.enabled !== false ? giniLinkOf(product?.gini_url) : '';

  /** Header signals: the sales TIER (never the exact count) and the score. */
  const [salesBadge, setSalesBadge] = useState<number | null>(null);
  const [rating, setRating] = useState<{ average: number; count: number } | null>(null);
  /** Open box / used / refurbished — null for an ordinary new product. */
  const [conditionRef, setConditionRef] = useState<{ reference_iqd: number; saving_iqd: number } | null>(null);

  /**
   * The condition document rides on the product payload (CARD_FIELDS and the
   * public projection both carry it), so there is no second fetch and no
   * separate loading state — a graded page paints graded on first paint.
   */
  const productCondition =
    (product as (typeof product & { condition?: ConditionEntry | null }) | null)?.condition ?? null;
  const [source, setSource] = useState<ProductSource>('catalog');
  const [relations, setRelations] = useState<RelationsPayload | null>(null);
  const [baseAvailability, setBaseAvailability] = useState<Availability | null>(null);
  const [viewerTier, setViewerTier] = useState<ViewerTier | null>(null);
  // The server's per-mode prices: the detail's base-selection set until a
  // quote for the current selection lands, then that quote's. Nothing here
  // is ever added up in the browser.
  const [detailModes, setDetailModes] = useState<PricingModes | null>(null);
  const [quotedModes, setQuotedModes] = useState<PricingModes | null>(null);
  // §8/§9 — what PREMIUM and PRO pay for this selection, as the server
  // resolved it: the detail response's answer for the base selection until a
  // quote for the current one lands, then that quote's. Every dinar in the
  // membership lines below comes from one of these two; none is computed here.
  const [detailPreview, setDetailPreview] = useState<MembershipPreview | null>(null);
  const [quotedPreview, setQuotedPreview] = useState<MembershipPreview | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retryToken, setRetryToken] = useState(0);

  // The purchase column follows the measured page chrome, not a guessed
  // pixel offset. ResizeObserver catches language wrapping, viewport changes
  // and accessibility text scaling without causing React rerenders.
  useEffect(() => {
    const page = pageRef.current;
    const header = pageHeaderRef.current;
    if (!page || !header) return;
    const update = () => page.style.setProperty('--app-header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(header);
    window.addEventListener('resize', update, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [loading, product?.id]);

  // Selection — nothing is guessed: a value is set only when the catalogue
  // leaves exactly one possibility (no randomness) or the user picks it.
  /** One selected value per active relational group, kept in group order. */
  const [optionValueIds, setOptionValueIds] = useState<string[]>([]);
  /** Legacy and pricing compatibility: the first group remains `optionId`. */
  const optionId = optionValueIds[0] ?? '';
  const [colorId, setColorId] = useState('');
  const [transportMethod, setTransportMethod] = useState('');
  const [warrantyPlanId, setWarrantyPlanId] = useState('');
  const [qty, setQty] = useState(1);
  /**
   * §11 — THE CHARACTER WATCHES THE QUANTITY, and the controller decides what
   * that is worth.
   *
   * The stepper here is pure local state with no request behind it, so the
   * API-level feedback the rest of the app rides on cannot see it at all. This
   * is the only place that knows the number changed. It reports the change and
   * nothing more: whether a step up is a glance, a run of them is interest, or
   * a jump is genuinely surprising is escalation policy, and that lives in
   * `mascot.quantity` where the run is remembered.
   */
  const stepQty = React.useCallback((next: (q: number) => number) => {
    setQty((q) => {
      const to = next(q);
      if (to !== q) mascot.quantity(to, q);
      return to;
    });
  }, []);
  /**
   * THE ORDER TYPE THE CUSTOMER ACTUALLY CHOSE — and '' until they do.
   *
   * This used to be a boolean, and sending a TRANSPORT was what made the
   * server treat a line as a pre-order. That conflated two independent
   * decisions ("PRODUCT OPTION != ORDER TYPE != PREORDER TRANSPORT") and made
   * "pre-order by land" the only way to say "pre-order".
   *
   * '' is not a third kind of order — it means the customer has not been asked
   * (the product sells one way, so no pills are shown), and the server then
   * infers it exactly as it did before. The page never guesses on their behalf.
   */
  const [orderType, setOrderType] = useState<'' | 'direct_sale' | 'pre_order'>('');

  const [quote, setQuote] = useState<Quote | null>(null);
  const [liveAvailability, setLiveAvailability] = useState<Availability | null>(null);
  // The extended-warranty options as the LAST quote priced them for the
  // current option/colour (a percent fee follows the regular price of the
  // selection). Null until a quote lands; the detail's base-selection list is
  // the fallback, so the chooser is never empty for a printer.
  const [quotedPlans, setQuotedPlans] = useState<WarrantyPlanItem[] | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  /**
   * WHICH SELECTION THE QUOTE IN HAND ACTUALLY ANSWERS.
   *
   * `quote` alone cannot say: while a new selection's request is in flight the
   * previous selection's quote is still the value of the variable. Recording
   * the key it was fetched for is what lets the page show a figure and be
   * honest about whether it is the confirmed one — instead of the old
   * all-or-nothing gate that blanked the price on every tap.
   */
  const [quotedFor, setQuotedFor] = useState<string | null>(null);
  const [priceLevels, setPriceLevels] = useState<PriceLevels | null>(null);
  /** The extended-warranty disclosure. Closed by default because "no
   *  extension" is already the correct answer for most buyers. */
  const [warrantyOpen, setWarrantyOpen] = useState(false);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [quoteToken, setQuoteToken] = useState(0);

  const [galleryIndex, setGalleryIndex] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  // The zoom control the lightbox came out of. The viewer scales FROM this
  // button and collapses back INTO it, so the enlarged photo is visibly the
  // same object as the thumbnail the customer tapped rather than a second,
  // unrelated window that happened to appear. A plain callback ref (not a
  // typed useRef on the element) keeps the button conditional — it only
  // renders when there is a media URL — without fighting ref variance.
  const zoomBtnRef = useRef<HTMLElement | null>(null);

  const [addingToCart, setAddingToCart] = useState(false);
  // Set only from the server's CART_SHIPPING_CONFLICT refusal. null = no dialog.
  const [shippingConflict, setShippingConflict] = useState<{
    cartType: unknown;
    incomingType: unknown;
  } | null>(null);
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
    setSalesBadge(null);
    setRating(null);
    setConditionRef(null);
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
        // THE SERVER'S REDIRECT IS HONOURED (§10). A composition slug resolves
        // here — a bundle is a real `products` row — and the server answers
        // with the composition payload plus `redirect: '/bundles/<slug>'`.
        // Ignoring it left this renderer holding a bundle payload: no
        // components, no saving line, `stock: null`, `options: []`. The
        // navigation REPLACES the entry so Back does not bounce between the
        // two routes.
        if (data.redirect) {
          navigate(data.redirect, { replace: true });
          return;
        }
        setProduct(data.product);
        /**
         * Remember this view in THIS BROWSER, for the «مختارات لك» tile on the
         * home page. Nothing is sent anywhere: the list lives in localStorage,
         * holds an id plus its section and brand, and never leaves the device.
         * See src/lib/recentlyViewed.ts for why it is done here rather than by
         * adding a views table on the busiest read path in the shop.
         */
        rememberViewed({
          id: String((data.product as { id?: unknown }).id ?? ''),
          category_id: (data.product as { category_id?: string | null }).category_id ?? null,
          brand_id: (data.product as { brand_id?: string | null }).brand_id ?? null,
        });
        setSource(data.source);
        setFavorite(data.favorite);
        setRelations(data.relations ?? null);
        setBaseAvailability(data.availability ?? null);
        setViewerTier(data.viewer_tier ?? null);
        setDetailModes(data.pricing_modes ?? null);
        setQuotedModes(null);
        setDetailPreview(data.membership_preview ?? null);
        setQuotedPreview(null);
        setLiveAvailability(null);
        setQuotedPlans(null);
        setQuoteError(null);
        setPriceLevels(data.price_levels ?? null);
        setSalesBadge(data.sales_badge ?? null);
        setRating(data.rating ?? null);
        setConditionRef(data.condition_reference ?? null);
        // THE PRICE IS ALREADY HERE. `pricing` is the server's own resolver
        // result for the opening selection, computed on this request; seeding the
        // quote with it means the page opens with a real, final figure instead
        // of «يبدأ من» plus a round trip. `quotedFor` is set to that exact key so
        // the moment a variant IS chosen the page knows this quote no longer
        // answers the question.
        const initial = data.initial_selection?.fulfillment_type === 'direct_sale'
          ? data.initial_selection
          : null;
        setQuote(data.pricing ? { ...data.pricing, qty: 1, line_total_iqd: data.pricing.unit_subtotal_iqd } : null);
        setQuotedFor(
          data.pricing
            ? `${initial?.option_value_ids?.length ? initial.option_value_ids.join(',') : initial?.option_id ?? ''}|${initial?.color_id ?? ''}|${initial ? 'direct_sale' : ''}||`
            : null
        );
        // A quote left in flight by the PREVIOUS product must not leave this
        // one looking like it is still resolving.
        setQuoteLoading(false);
        setGalleryIndex(0);
        setQty(1);
        setWarrantyPlanId('');
        setWarrantyOpen(false);
        setActionError('');
        setNotice('');

        // Prefer the server-proven first direct-sale shelf. This happens once
        // per product load, never in a reactive effect that could overwrite a
        // later customer choice. Legacy/sold-out products keep the previous
        // single-possibility fallback.
        const publicRelationOptionIds = new Set(
          (data.relations?.option_groups ?? []).flatMap((group) => group.values.map((value) => value.id))
        );
        // The PRESENCE of relational data is the boundary, not whether its
        // public option set happens to be non-empty. An empty set can mean all
        // relation groups are inactive; falling back to the JSON options in
        // that case would resurrect admin-hidden values on the storefront.
        const opts = data.relations
          ? (data.product.options ?? []).filter((option) => publicRelationOptionIds.has(option.id))
          : (data.product.options ?? []);
        const openingOptionValueIds = initial
          ? (initial.option_value_ids?.length
              ? initial.option_value_ids
              : initial.option_id
                ? [initial.option_id]
                : [])
          : (opts.length === 1 ? [opts[0].id] : []);
        const openingOptionId = openingOptionValueIds[0] ?? '';
        setOptionValueIds(openingOptionValueIds);
        const cols = (data.product.colors ?? []).filter(
          (c) => !c.option_id || (openingOptionId && c.option_id === openingOptionId)
        );
        setColorId(
          initial
            ? (initial.color_id ?? '')
            : (cols.length === 1 && (data.product.colors ?? []).length === 1 ? cols[0].id : '')
        );
        // A product that only pre-orders, by exactly one route, has already
        // answered the route question — so it is answered for the buyer.
        //
        // This read the response's `mode`, which is the same field the derived
        // type stopped reading: harmless on a FIRST load, since that request
        // carries no preference for the server to echo, but the same
        // expression, and a later reader has no way to tell the safe use from
        // the unsafe one. It asks `resolveOrderType` instead — one rule, one
        // place, and no `.mode` left in this file to copy by accident.
        const usable = (data.availability?.preorder.transports ?? []).filter((t) => t.configured);
        const opensAsPreorder = resolveOrderType('', data.availability?.modes ?? []) === 'pre_order';
        setTransportMethod(!initial && opensAsPreorder && usable.length === 1 ? usable[0].method : '');
        setOrderType(initial ? 'direct_sale' : '');
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
    // `navigate` is stable across renders; it is listed because the load now
    // honours the server's composition redirect (§10).
  }, [slug, retryToken, navigate]);

  /**
   * THE SELECTION THE PRICE DEPENDS ON — AND QUANTITY IS NOT PART OF IT.
   *
   * Quantity provably cannot move a unit price: the worker resolves the unit
   * without ever seeing `qty` and then multiplies (worker/routes/products.ts,
   * `line_total_iqd: resolved.unit_subtotal_iqd * qty`). Keeping `qty` in this
   * key meant every tap of the + button spent a debounce and a round trip to
   * perform a multiplication the browser can do in a nanosecond — and, because
   * the old gate hid the price for the whole of that window, the figure the
   * customer was reading vanished each time they asked for one more.
   */
  const availability = liveAvailability ?? baseAvailability;

  /**
   * WHICH WAYS OF BUYING ARE ACTUALLY OPEN, straight from the server.
   *
   * These three lines used to sit five hundred lines further down, beside the
   * «طريقة التوفر» chooser they gate. They are hoisted because the header chip
   * needs them FIRST: a chip that follows the buyer's button press without
   * asking whether that button still leads anywhere prints «بيع مباشر ·
   * متوفر» over a product whose last unit sold while the page was open. They
   * are now hoisted again, above `requestedOrderType`, which needs the same
   * answer for the same reason — see below.
   */
  const modesArr = availability?.modes ?? [];
  const directUsable = modesArr.some((m) => m.type === 'direct_sale' && m.usable);
  const preUsable = modesArr.some((m) => m.type === 'pre_order' && m.usable);

  /**
   * THE ORDER TYPE EVERY REQUEST CARRIES — and it is never '' while the page
   * is drawing one of the two «طريقة التوفر» cards as already chosen.
   *
   * WHAT WAS WRONG. `orderType` starts '' and only becomes 'direct_sale' when
   * the detail response carried an `initial_selection`; a product whose direct
   * shelf is empty has none, so it stayed '' for the whole session unless the
   * buyer tapped a card — and every option tap resets it to '' again. But the
   * «طلب مسبق» card is drawn pressed from the SERVER's default mode, not from
   * `orderType`, so the page showed a pre-order ticked while holding nothing.
   * Both request builders below then send the field only `if (orderType)`, so
   * the quote and the add-to-cart left `fulfillmentType` out entirely. The
   * server's own rule for an absent type is `statedOrderType`
   * (worker/routes/products.ts) → '' → the pricing resolver infers
   * `direct_sale` from the missing transport (packages/pricing/src/pricing.ts),
   * so a dual-mode product was PRICED as a direct sale and the cart row was
   * TYPED as one — under a pre-order checkmark. That is the owner's «بالرغم من
   * اختيار طلب مسبق … ويظهر في السلة بيع مباشر».
   *
   * The fallback here is `lineOrderType`'s own fallback, written out in the
   * same order, so the client and the cart door resolve an untouched selection
   * to the SAME type by construction rather than by coincidence.
   *
   * AND THE BUYER'S PRESS ONLY WINS WHILE IT STILL LEADS SOMEWHERE — the same
   * rule `effectiveMode` states below, for the same reason. Without it, a
   * buyer who pressed «بيع مباشر» and then chose a colour whose shelf is empty
   * would keep SENDING `direct_sale`: the quote carries a type the server has
   * closed, nothing raises a pricing error, and «أضف إلى السلة» stays live for
   * an add the door refuses with OUT_OF_STOCK. The press is remembered in
   * `orderType`, so it wins again the moment that shelf refills.
   */
  const requestedOrderType: '' | 'direct_sale' | 'pre_order' = resolveOrderType(orderType, modesArr);

  /** The routes this combination really offers, as the server stated them. */
  const transportUsable = (method: string): boolean => routeIsUsable(availability?.preorder, method);

  /**
   * THE TRANSPORT EVERY REQUEST CARRIES — remembered across a version change,
   * and honoured only while this combination still offers it.
   *
   * «عند اختيار طلب مسبق وتحديد شحن بحري ثم اختيار النسخة … يختفي خيار الشحن
   *  ويجب النقر عليه مرة ثانية، وعند تغيير الخيار يرجع يختفي.» Nothing
   * downstream may read the raw press; `src/lib/productSelection.ts` carries
   * both rules and the reasoning, and the owner's scenario runs as a test
   * there rather than being asserted about this file's punctuation.
   */
  const effectiveTransport = resolveTransport(transportMethod, requestedOrderType, availability?.preorder);

  const priceKey = `${optionValueIds.join(',')}|${colorId}|${requestedOrderType}|${effectiveTransport}|${warrantyPlanId}`;
  const productSlug = product?.slug ?? '';
  useEffect(() => {
    if (!productSlug || source !== 'catalog') return;
    let cancelled = false;
    const ac = new AbortController();
    // The price on screen is NOT hidden while this runs — it is marked
    // pending. `quotedFor` is what says whether it answers the current
    // selection; this flag only says a confirmation is on its way.
    setQuoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.post<QuoteResponse>(
          `/api/products/${productSlug}/quote`,
          {
            qty: 1,
            optionId: optionId || undefined,
            optionValueIds: optionValueIds.length ? optionValueIds : undefined,
            colorId: colorId || undefined,
            transportMethod: effectiveTransport || undefined,
            fulfillmentType: requestedOrderType || undefined,
            warrantyPlanId: warrantyPlanId || undefined,
          },
          // A superseded or abandoned quote is dropped at the socket instead of
          // being left to hold a connection open behind the next one, and the
          // client's deadline turns a hang into an error the page can retry.
          { signal: ac.signal, timeoutMs: 12000 }
        );
        if (cancelled) return;
        setQuote(res.quote);
        setQuotedFor(priceKey);
        setLiveAvailability(res.availability);
        if (Array.isArray(res.warranty_plans)) setQuotedPlans(res.warranty_plans);
        if (res.pricing_modes) setQuotedModes(res.pricing_modes);
        // Assigned unconditionally: `null` for a tier is an ANSWER ("nothing
        // to promise for this selection"), not a missing field, and keeping
        // the previous selection's promise would be the "up to" number §9
        // forbids.
        setQuotedPreview(res.membership_preview ?? null);
        setQuoteError(null);
      } catch (err) {
        if (cancelled) return;
        // The previous quote is deliberately KEPT. It no longer answers this
        // selection — `quotedFor` already says so — and holding it lets the
        // page keep showing the last real number beside the error instead of
        // an empty box.
        setQuotedFor(null);
        setQuoteError(err);
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ac.abort();
    };
  }, [productSlug, source, priceKey, optionId, optionValueIds, colorId, requestedOrderType, effectiveTransport, warrantyPlanId, quoteToken]);

  /**
   * «يجب التاكد من ان السعر يتحدث» — ON THE SCREEN WHERE THE PRICE IS READ.
   *
   * Everything above is a MOUNT effect or a SELECTION effect: the detail load
   * keys on the slug, the quote keys on what the customer chose. Neither fires
   * again for a page that simply stays open, and on a phone that is the normal
   * case — the tab is left while the customer checks WhatsApp, the app is
   * backgrounded, or `back` restores the page from the bfcache, which remounts
   * nothing and re-runs no effect. The admin repriced and the last unit sold in
   * between, and the page kept showing yesterday's figure with «أضف إلى
   * السلة» live above it.
   *
   * The back-navigation snapshot cache already refuses to paint a REMEMBERED
   * price on this page for exactly that reason (and `tests/backNavigationCache`
   * asserts this file never touches it); this is the other half of the same
   * rule — a price LEFT on screen goes stale the same way a remembered one
   * does, and the exclusion buys nothing on its own for a page that simply
   * stays mounted.
   *
   * IT ASKS FOR A QUOTE, NOT FOR THE WHOLE PAGE. The quote is what the price
   * and `liveAvailability` are read from, so one round trip refreshes both the
   * number and the shelf count — and, unlike bumping `retryToken`, it does not
   * put the detail load back into its skeleton and blank the page every time
   * the customer returns to the tab. The quote effect already re-runs on
   * `quoteToken`, so there is no second fetch path to keep in step.
   *
   * The hold is the same one the cart and checkout use: never land a refresh
   * under an add the customer is waiting on, under the lightbox, or under the
   * shipping-conflict dialog they are answering.
   */
  useFreshOnReturn(() => setQuoteToken((n) => n + 1), {
    enabled: !addingToCart && !lightbox && shippingConflict === null,
    minIntervalMs: 8_000,
  });

  /**
   * A CONFIRMATION IS A MOMENT, NOT A STATE. The "added to cart" notice used
   * to stay on screen until the next add or a navigation, so it sat under the
   * button as a permanent claim about something that happened a minute ago —
   * and, worse, kept the CTA reading «تمت الإضافة». Three seconds is long
   * enough to read and short enough that the control returns to its real job.
   */
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  // Keep a valid selection, drop an invalid one (mandate §7.2: the user's
  // choice survives as long as it is valid).
  /**
   * WHICH COLOURS THIS SELECTION MAY HAVE — «إذا لم يحدد اللون لأي خيار يكون
   * تحديد لكل الخيارات، إذا حدد لخيار واحد فيظهر فقط في هذا الخيار».
   *
   * The owner's rule, stated exactly: a colour that names NO option belongs to
   * every option; a colour that names one belongs only to that one.
   *
   * WHAT WAS WRONG, and it is why the owner reported «الألوان لا تظهر في صفحة
   * تفاصيل المنتج». Both branches below asked whether the chosen value is
   * among the colour's own — and before the buyer has chosen anything,
   * `chosen` is EMPTY, so every answer is false. On a product whose direct
   * sale is sold out there is no `initial_selection` to pre-select an option
   * with (worker/routes/products.ts), so the page opened with nothing chosen
   * and every option-linked colour hidden. Not «no colours configured»: the
   * colours were there and the page was asking a question that could not yet
   * be answered.
   *
   * BEFORE A CHOICE, SHOW WHAT THE PRODUCT HAS. `nothingChosen` makes the
   * filter a no-op until the buyer picks an option, so the shopper sees the
   * range on the first paint and the list NARROWS as they choose — which is
   * also the order the owner asked the panels to run in (availability →
   * transport → version → colour).
   *
   * A colour whose option is then excluded is dropped by the effect below,
   * exactly as before, so nothing unbuyable can survive into the cart — and
   * the server refuses the pair independently (`COLOR_OPTION_MISMATCH`), so
   * this widening is a display decision and never an authorisation one.
   */
  const colorsForOption = useMemo(() => {
    const all = product?.colors ?? [];
    const chosen = new Set(optionValueIds);
    const nothingChosen = chosen.size === 0;
    const relational = new Map((relations?.colors ?? []).map((c) => [c.id, c] as const));
    return all.filter((c) => {
      const links = relational.get(c.id)?.links ?? [];
      // No link and no option_id — the colour names no option, so it is on
      // every one of them. This is the owner's default and it needs no choice
      // to be made first.
      if (links.length === 0) return !c.option_id || nothingChosen || chosen.has(c.option_id);
      if (nothingChosen) return true;
      // A colour linked to several groups is visible only when every linked
      // group accepts the selected value; several links inside one group are
      // alternatives (OR), exactly like the server's colorVisibility helper.
      const byGroup = new Map<string, string[]>();
      for (const link of links) {
        const ids = byGroup.get(link.group_id) ?? [];
        ids.push(link.option_value_id);
        byGroup.set(link.group_id, ids);
      }
      return [...byGroup.values()].every((ids) => ids.some((id) => chosen.has(id)));
    });
  }, [product, optionValueIds, relations]);

  useEffect(() => {
    if (colorId && !colorsForOption.some((c) => c.id === colorId)) setColorId('');
  }, [colorsForOption, colorId]);

  // Choosing an option or colour jumps the gallery to its images (the
  // selection-aware gallery puts them first).
  useEffect(() => {
    setGalleryIndex(0);
  }, [optionValueIds, colorId]);

  // ONE default, used by both. These disagreed (1 here, 99 in the clamp), so
  // before availability arrived the + button was dead while the effect would
  // have allowed 99.
  const maxQty = Math.max(1, availability?.stock.max_qty ?? 1);
  useEffect(() => {
    setQty((q) => Math.min(Math.max(1, q), maxQty));
  }, [maxQty]);

  // §3.3 — a product share link carries ?ref=<username>. Capturing it HERE is
  // what makes an arriving support code visible in the cart later; the ref is
  // never resolved, trusted or priced in the browser, and an existing code is
  // never silently replaced (the helper records a second, different ref as a
  // conflict the cart asks the buyer to resolve).
  useEffect(() => {
    if (!location.search || location.search.indexOf('ref=') === -1) return;
    captureSupportRefFromSearch(location.search, { product: location.pathname });
  }, [location.search, location.pathname]);

  /**
   * «خبرني لما يرجع» — THE CHOICE COMING BACK FROM /auth.
   *
   * Every stock-alert route is behind requireAuth, so a signed-out visitor who
   * picked the model they are waiting for has to go and sign in. `?alert=`
   * (src/components/product/stockAlertTargets.ts) is what carries that choice
   * through the round trip inside the existing `?next=` machinery, so they
   * return to a pre-ticked sheet instead of an empty one — which is exactly
   * where, on a phone, people give up.
   *
   * It is decoded as UNTRUSTED input (anyone can type it) and nothing is ever
   * armed from it: the sheet opens with the boxes ticked and waits for the
   * customer's own Save. The parameter is then dropped from the URL with a
   * REPLACE, so a refresh or a shared link does not re-open the sheet — and a
   * replace rather than a push, because a Back that only removes a query
   * parameter is a Back that appears not to work.
   */
  const [alertIntent, setAlertIntent] = useState<StockAlertWish[]>([]);
  useEffect(() => {
    if (!location.search || location.search.indexOf('alert=') === -1) return;
    const decoded = decodeAlertIntent(new URLSearchParams(location.search).get('alert'));
    if (decoded.length > 0) setAlertIntent(decoded);
  }, [location.search]);
  const consumeAlertIntent = useCallback(() => {
    setAlertIntent([]);
    const params = new URLSearchParams(location.search);
    if (!params.has('alert')) return;
    params.delete('alert');
    const rest = params.toString();
    navigate(`${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`, { replace: true });
  }, [navigate, location.search, location.pathname, location.hash]);

  /**
   * THE SUPPORT LINK IS FETCHED BEFORE THE TAP, NOT DURING IT.
   *
   * §3.3 — a signed-in sharer's link carries THEIR support handle, built by the
   * SERVER from the account's own username: the browser never invents a handle.
   * That part is unchanged. What changed is WHEN it is asked for.
   *
   * It used to be awaited inside the click, so every share paid a full network
   * round trip before the sheet appeared — the delay the owner reported. Worse
   * than slow, it was BROKEN on iOS: Safari requires `navigator.share()` to be
   * called synchronously inside the user gesture, and an `await` before it
   * detaches the call from that gesture, so the share throws NotAllowedError
   * and nothing opens at all.
   *
   * So the handle is resolved once, quietly, when the page settles. By the time
   * a thumb reaches the button the answer is already in a ref, the sheet opens
   * in the same tick as the tap, and a share that happens before the fetch
   * lands simply carries the plain product URL — which is a correct link, just
   * without the referral. Never a delay, never a failure, at worst a missed
   * extra.
   */
  const supportUrlRef = useRef<string | null>(null);
  useEffect(() => {
    supportUrlRef.current = null;
    if (!isAuthenticated || !slug) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<{ path: string; ref: string | null; supported: boolean }>(
          `/api/referrals/support/link?path=${encodeURIComponent(`/product/${slug}`)}`
        );
        if (!cancelled && res.supported && res.path) {
          supportUrlRef.current = new URL(res.path, window.location.origin).toString();
        }
      } catch {
        /* the plain product URL is the fallback, and it is a good one */
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, slug]);

  /**
   * «عند إضافة منتج إلى السلة وعند وجود هذا المنتج وهذا الخيار أو هذا اللون
   *  في السلة يجب أن يظهر هناك العدد في السلة مع زر عرض السلة».
   *
   * WHY THE LINES ARE HELD AND NOT JUST A NUMBER. The note is about THIS
   * selection, not this product: the same printer in black and in white are
   * two different lines, and telling a customer choosing white that they
   * already have two would be wrong about the only thing the note claims.
   * Matching needs the option values and the colour off each line, so the
   * lines are what is kept.
   *
   * One request, only for somebody who can have a cart, and a failure is
   * silent: an absent note is merely absent, while a wrong count is a lie
   * about the customer's basket — the same rule the nav badge follows.
   */
  const [cartLines, setCartLines] = useState<CartItem[]>([]);
  useEffect(() => {
    setCartLines([]);
    if (!isAuthenticated || !product?.id) return;
    let cancelled = false;
    void api
      .get<{ items: CartItem[] }>('/api/cart')
      .then((data) => {
        if (!cancelled) setCartLines(Array.isArray(data.items) ? data.items : []);
      })
      .catch(() => {
        /* no note rather than a made-up one */
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, product?.id]);

  /**
   * How many of EXACTLY what is selected are already in the cart.
   *
   * The comparison is the same identity the server upserts a line on: the
   * product, the full multi-group selection and the colour. `option_value_ids`
   * is sorted on both sides because group order is the admin's, not the
   * customer's, and two identical selections must not read as different
   * because one arrived from a different screen. It falls back to the legacy
   * `option_id` for lines written before that column existed.
   */
  const inCartQty = useMemo(() => {
    if (!product?.id || cartLines.length === 0) return 0;
    const key = (ids: string[] | undefined, legacy: string) =>
      (ids && ids.length ? [...ids].sort().join(',') : legacy) || '';
    const mine = key(optionValueIds, optionId);
    return cartLines.reduce((n, line) => {
      if (line.productId !== product.id) return n;
      if (key(line.option_value_ids, line.option_id) !== mine) return n;
      if ((line.color_id || '') !== (colorId || '')) return n;
      return n + (Number(line.qty) || 0);
    }, 0);
  }, [cartLines, product?.id, optionValueIds, optionId, colorId]);

  const handleShare = () => {
    const name = product ? pickName(product.name_en, product.name, product.name_ar) : '';
    const url = supportUrlRef.current ?? window.location.href;
    // NOT awaited before the call: `navigator.share` must be reached in the
    // same tick as the gesture. The promise is handled after the sheet opens.
    if (navigator.share) {
      navigator.share({ title: name, url }).catch(() => {
        /* the customer dismissed the sheet — not an error */
      });
      return;
    }
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setNotice(s.linkCopied);
        setTimeout(() => setNotice(''), 2000);
      })
      .catch(() => {
        /* a browser that refuses the clipboard: the URL bar still has the link */
      });
  };

  /**
   * THE HEART MOVES ON THE TAP, NOT ON THE ROUND TRIP.
   *
   * It used to wait for the server before changing, so on a phone the button
   * sat inert for as long as the network took — the slowness the owner
   * reported. A favourite is a preference, not a payment: the honest interface
   * shows the new state at once and puts it back if the server disagrees.
   *
   * The button is no longer DISABLED while in flight either. Disabling it was
   * how a double-tap was prevented, and it is also what made the control feel
   * dead; `favBusy` still guards re-entry, so a second tap during the request
   * is ignored rather than queued, and the control keeps its normal appearance
   * throughout.
   *
   * On failure the heart returns to where it was and the error is said out
   * loud. Silently keeping a filled heart that the server never recorded would
   * be a lie the customer only discovers on their favourites page.
   */
  const toggleFavorite = async () => {
    if (!product || favBusy || source !== 'catalog') return;
    if (!isAuthenticated) {
      navigate(authPathWithSupportRef(`/product/${product.slug}`));
      return;
    }
    const was = favorite;
    setFavorite(!was);
    setFavBusy(true);
    setActionError('');
    try {
      if (was) await api.delete(`/api/profile/favorites/${product.id}`);
      else await api.put(`/api/profile/favorites/${product.id}`);
    } catch (err) {
      setFavorite(was);
      if (err instanceof ApiError && err.status === 401) {
        navigate(authPathWithSupportRef(`/product/${product.slug}`));
        return;
      }
      setActionError(err instanceof Error ? err.message : 'Failed to update favorites');
    } finally {
      setFavBusy(false);
    }
  };

  // The add, factored out so the "empty the cart and add" button can repeat
  // the SAME request with replaceCart set, rather than assembling a second
  // body that could drift from this one.
  const postAddToCart = useCallback(
    async (replaceCart: boolean) => {
      if (!product) return;
      // Double-tap guard: a ref, not state, so two taps in the same tick cannot
      // both pass. Retrying after a failure is safe (the server upserts one row).
      if (addInFlight.current) return;
      if (!isAuthenticated) {
        navigate(authPathWithSupportRef(`/product/${product.slug}`));
        return;
      }
      addInFlight.current = true;
      setAddingToCart(true);
      setActionError('');
      setNotice('');
      try {
        const body: Record<string, unknown> = { productId: product.id, qty };
        if (optionId) body.optionId = optionId;
        if (optionValueIds.length) body.optionValueIds = optionValueIds;
        if (colorId) body.colorId = colorId;
        // THE ROUTE TRAVELS WITH THE TYPE THAT NEEDS IT, not with the
        // server's default mode. Gating on `availability.mode === 'preorder'`
        // dropped the chosen route whenever the direct shelf still had units:
        // a buyer who pressed «طلب مسبق» and picked «شحن بري» on such a
        // product sent neither field, and the line landed as a direct sale.
        if (requestedOrderType === 'pre_order' && effectiveTransport) body.transportMethod = effectiveTransport;
        // The ORDER TYPE travels on its own, so the cart line records what the
        // customer chose rather than what a transport implies.
        if (requestedOrderType) body.fulfillmentType = requestedOrderType;
        if (warrantyPlanId) body.warrantyPlanId = warrantyPlanId;
        if (replaceCart) body.replaceCart = true;
        const data = await api.post<{ items: CartItem[] }>('/api/cart/items', body);
        // Success is claimed ONLY after the server returns the saved cart.
        const count = countCartItems(data.items);
        // The response is the saved cart, so the note below the price updates
        // from the same answer that proved the add worked — no second request,
        // and no window in which the badge and the note disagree.
        setCartLines(Array.isArray(data.items) ? data.items : []);
        setShippingConflict(null);
        setNotice(`${s.added} (${count})`);
        // The nav badge is the one piece of confirmation visible from anywhere
        // on the page, including from the bottom of a long product.
        setCartCount(count);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          navigate(authPathWithSupportRef(`/product/${product.slug}`));
          return;
        }
        // A cart may hold exactly one shipping type. The SERVER owns that rule
        // and names both types when it refuses; we only ask the customer which
        // way out they want. Anything else stays an inline error.
        if (err instanceof ApiError && err.code === 'CART_SHIPPING_CONFLICT') {
          setShippingConflict({
            cartType: err.details?.cart_shipping_type,
            incomingType: err.details?.incoming_shipping_type,
          });
          return;
        }
        // The same printer is already in the cart with a different
        // extended-warranty choice; the server refuses to rewrite it silently
        // and the fix is named in the customer's language.
        if (err instanceof ApiError && err.code === 'CART_WARRANTY_CONFLICT') {
          setActionError(s.CART_WARRANTY_CONFLICT);
          return;
        }
        /**
         * THE DOOR SPEAKS THE CUSTOMER'S LANGUAGE WHEN IT CAN.
         *
         * `HttpError` carries one untranslated sentence, and this branch
         * echoed it verbatim — so the counter that refused was explained in
         * English on an Arabic page. This page already owns a sentence for
         * every code it can be refused with, including 0075's
         * PREORDER_CAPACITY_EXHAUSTED, which is the one refusal a customer
         * must not mistake for "sold out": the shelf may be full and the
         * import quota closed. `reasonText` returns the CODE when it has no
         * sentence, so only a decoded one is used and everything else still
         * falls back to what the server said.
         *
         * AND THE NUMBER COMES FIRST WHEN THE DOOR SENT ONE.
         *
         * «يجب التاكد بان المخزون يتحدث ويعطيه اشعارا بان المتبقي فقط 2.» The
         * add-to-cart door is where that race is actually lost: the stepper is
         * capped from `availability.stock.max_qty`, which was read when this
         * page loaded, so another buyer taking a unit in between is refused
         * HERE with `QTY_UNAVAILABLE` and a remainder. None of this page's own
         * sentences can carry a figure — they are static strings — so the
         * counted one from `src/lib/refusalStrings.ts` is preferred whenever
         * the server sent `details.available`, and it is built in all three
         * languages from that number rather than from English prose.
         *
         * `refusalText` is the last stop before the server's own sentence: it
         * owns the count-FREE wording for the cases with no remainder to name
         * (a per-order ceiling, a mystery-pool member whose exact count §8.2
         * row 18 suppresses), which this page has no string for.
         */
        const code = err instanceof ApiError ? err.code ?? '' : '';
        const counted = stockRefusal(err, lang);
        const said = code ? reasonText(s, code) : '';
        const raw = err instanceof Error ? err.message : 'Failed to add to cart';
        setActionError(
          counted || (said && said !== code ? said : refusalText(code, lang, raw))
        );
      } finally {
        addInFlight.current = false;
        setAddingToCart(false);
      }
    },
    [product, qty, optionId, optionValueIds, colorId, requestedOrderType, effectiveTransport, warrantyPlanId, isAuthenticated, navigate, s, lang]
  );

  const handleAddToCart = useCallback(() => postAddToCart(false), [postAddToCart]);

  // Escape used to be a hand-rolled window listener here. `Overlay` owns
  // Escape for every window in the app now, so keeping a second listener would
  // mean two places could disagree about when the viewer closes; it is deleted
  // rather than duplicated.

  // ------------------------------------------------------------ loading/error
  /**
   * TWO STEPS INSTEAD OF FOUR CARDS — but only when the data says so.
   *
   * The owner asked not to show "A1 pre-order / A1 direct / A1 Combo
   * pre-order / A1 Combo direct" as four flat chips. So when the options carry
   * a model key AND at least one of them names its own availability, they are
   * folded into: pick the model, then pick how to get it.
   *
   * When they do NOT — every product in the catalogue before this feature —
   * the flat chip list below renders exactly as it always has. That is the
   * whole backward-compatibility story on this page: one boolean, and no old
   * product takes the new path.
   */
  const tr = (ar: string, en: string, ckb: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb : ar);

  const relationOptionGroups = useMemo(
    () => (relations?.option_groups ?? []).filter((group) => group.values.length > 0),
    [relations]
  );
  const hasMultipleOptionGroups = relationOptionGroups.length > 1;
  const storefrontOptions = useMemo(() => {
    const all = product?.options ?? [];
    if (!relations) return all;
    const publicIds = new Set(
      relationOptionGroups.flatMap((group) => group.values.map((value) => value.id))
    );
    // Relations with zero public groups are meaningful: every relational
    // group is inactive. Return no options instead of reviving values from
    // inactive groups through the legacy JSON fallback.
    return all.filter((option) => publicIds.has(option.id));
  }, [product, relations, relationOptionGroups]);

  const models = useMemo(() => {
    // A relational multi-group product gets one visible chooser per group
    // below. Folding those values into the legacy "model" abstraction would
    // hide the secondary groups and lose part of the selection at checkout.
    if (hasMultipleOptionGroups) return null;
    const declared = storefrontOptions.some(
      (o) =>
        o.availability_type === 'pre_order' ||
        o.availability_type === 'direct_sale' ||
        (o.fulfillments?.length ?? 0) > 0
    );
    if (!declared) return null;
    const byKey = new Map<string, { key: string; label: string; options: OptionItem[] }>();
    for (const o of storefrontOptions) {
      const key = o.variant_key || o.id;
      const entry = byKey.get(key);
      if (entry) entry.options.push(o);
      else byKey.set(key, { key, label: o.variant_label || pickName(o.name_en, o.name, o.name_ar) || key, options: [o] });
    }
    return [...byKey.values()];
  }, [hasMultipleOptionGroups, storefrontOptions]);

  const selectedOption = useMemo(
    () => (optionId ? (product?.options ?? []).find((o) => o.id === optionId) ?? null : null),
    [product, optionId]
  );
  const [modelKey, setModelKey] = useState('');
  // The chosen option decides the model, so a deep link or a restored cart
  // lands on the right step without the page guessing.
  useEffect(() => {
    if (selectedOption) setModelKey(selectedOption.variant_key || selectedOption.id);
  }, [selectedOption]);
  // With exactly one model there is no first step to take.
  useEffect(() => {
    if (models && models.length === 1 && !modelKey) setModelKey(models[0].key);
  }, [models, modelKey]);


  if (loading || !product) {
    return (
      <div className="w-full min-h-[100dvh] bg-black text-zinc-300 font-sans" dir={dir}>
        <div className="lv-character-header sticky top-0 z-30 bg-black/90 backdrop-blur-xl px-4 pb-1.5 flex items-center">
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label={s.back}
            className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center bg-zinc-900/60 rounded-full hover:bg-zinc-800 transition-colors"
          >
            {dir === 'rtl' ? <ArrowRight className="w-5 h-5 text-white" /> : <ArrowLeft className="w-5 h-5 text-white" />}
          </button>
          <MotionCharacterHome busy={loading} />
          <span aria-hidden="true" />
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
  const name = pickName(product.name_en, product.name, product.name_ar);
  const description = pick(
    lang as Lang, product.description_ar, product.description_en, product.description_ckb, product.description
  );
  // Selection-aware gallery from ONE source: product_images/media. Exact
  // variant beats colour, colour beats any selected option (multi-group
  // aware), and the explicit primary is the fallback.
  const mediaBindings = (relations?.images?.length ? relations.images : product.media ?? []);
  const selectedVariantId = productVariantIdForSelection(relations?.variants ?? [], {
    optionValueIds,
    colorId,
  });
  const physicalDimensions = resolveProductSelectionDimensions(product, relations, {
    optionValueIds,
    colorId,
  });
  const showPhysicalDimensions = hasProductDimensions(physicalDimensions);
  const dimensionGroups: Array<{
    id: 'product' | 'package';
    title: string;
    rows: Array<{ key: keyof ProductDimensionsV2; label: string; kind: 'weight' | 'length' }>;
  }> = [
    {
      id: 'product',
      title: tr('المنتج', 'Product', 'بەرهەم'),
      rows: [
        { key: 'net_weight_g', label: tr('الوزن الصافي', 'Net weight', 'کێشی خاوێن'), kind: 'weight' },
        { key: 'width_mm', label: tr('العرض', 'Width', 'پانی'), kind: 'length' },
        { key: 'depth_mm', label: tr('العمق', 'Depth', 'قووڵایی'), kind: 'length' },
        { key: 'height_mm', label: tr('الارتفاع', 'Height', 'بەرزی'), kind: 'length' },
      ],
    },
    {
      id: 'package',
      title: tr('العبوة', 'Package', 'پاکەت'),
      rows: [
        { key: 'package_weight_g', label: tr('الوزن', 'Weight', 'کێش'), kind: 'weight' },
        { key: 'package_width_mm', label: tr('العرض', 'Width', 'پانی'), kind: 'length' },
        { key: 'package_depth_mm', label: tr('العمق', 'Depth', 'قووڵایی'), kind: 'length' },
        { key: 'package_height_mm', label: tr('الارتفاع', 'Height', 'بەرزی'), kind: 'length' },
      ],
    },
  ];
  const gallery = (() => {
    const base = galleryOf(product);
    return productGalleryForSelection(base, mediaBindings, {
      optionId,
      optionValueIds,
      colorId,
      variantId: selectedVariantId,
    });
  })();
  const optionImage = (id: string): string =>
    mediaBindings.find((image) => image.option_value_id === id)?.url ?? '';
  const colorImage = (id: string): string =>
    mediaBindings.find((image) => image.color_id === id)?.url ?? '';
  const activeMedia = gallery[Math.min(galleryIndex, Math.max(0, gallery.length - 1))];
  const options = storefrontOptions;

  // Per-level sellable counts (server-derived, never raw counters) — shown
  // on the pills ONLY when that level is the authoritative inventory source,
  // so a number the engine would ignore is never presented as stock.
  const invMode = relations?.inventory_mode ?? 'BASE';
  const availByValue = new Map<string, number | null>(
    (relations?.option_groups ?? []).flatMap((g) => g.values.map((v) => [v.id, v.available] as const))
  );
  const availByColor = new Map<string, number | null>(
    (relations?.colors ?? []).map((c) => [c.id, c.available] as const)
  );
  const variantAvailable = new Map<string, number | null>(
    (relations?.variants ?? []).map((v) => [v.combo_key, v.available] as const)
  );
  const variantTotalForOption = (id: string): number | null => {
    const rows = (relations?.variants ?? []).filter((v) => v.combo_key.split('|').includes(`o:${id}`));
    if (rows.length === 0 || rows.some((v) => v.available === null)) return null;
    return rows.reduce((sum, v) => sum + (v.available ?? 0), 0);
  };
  /**
   * THE COLOURS IN STOCK COME FIRST — «أريد أن الألوان المتوفرة تظهر أولا
   * والألوان التي لا تتوفر تظهر آخرا».
   *
   * Nothing anywhere ordered colours by availability: the one ordering in the
   * whole request is `ORDER BY sort, name_en` (worker/lib/productRelations.ts),
   * the admin's own order, and every projection between there and here maps in
   * place. A sold-out swatch therefore sat wherever the admin had put it, with
   * a red «نفد» chip as the only signal, and the buyer had to read the row to
   * find what they could actually have.
   *
   * IT ONLY APPLIES TO A DIRECT SALE, which is what the owner asked for and is
   * also the only case where the number means anything: `available` is the
   * SHELF, and a pre-order has no shelf — it draws on an import quota that the
   * colour rows do not carry. Sorting a pre-order's colours by a shelf count
   * would push a colour to the back for being out of something the buyer was
   * never going to be given from stock.
   *
   * THE KEY IS THE SAME NUMBER THE CHIP SHOWS (`levelChip`, below), so the row
   * can never claim one thing and order by another. `null` is UNTRACKED and
   * is emphatically not zero — those sort as available, with the configured
   * colours that have stock, because nothing says otherwise.
   *
   * STABLE, and deliberately so: the sort is by the availability BUCKET only,
   * and ties keep the admin's order because `Array.prototype.sort` is required
   * to be stable. Two colours that are both in stock never swap places under
   * the buyer's thumb.
   */
  const colorHasStock = (id: string): boolean => {
    const comboKey = optionValueIds.length
      ? [...optionValueIds].sort().map((v) => `o:${v}`).concat(`c:${id}`).join('|')
      : '';
    const n = invMode === 'COLOR'
      ? availByColor.get(id)
      : invMode === 'VARIANT_COMBINATION' && comboKey
        ? variantAvailable.get(comboKey)
        : null;
    return n === null || n === undefined ? true : n > 0;
  };
  const orderedColors =
    requestedOrderType === 'direct_sale'
      ? [...colorsForOption].sort((a, b) => Number(colorHasStock(b.id)) - Number(colorHasStock(a.id)))
      : colorsForOption;

  /**
   * THE CHIP REPORTS THE SHELF, AND A PRE-ORDER HAS NO SHELF.
   *
   * Every number this helper is handed — `availByColor`, `availByValue`,
   * `variantAvailable`, `variantTotalForOption` — comes from `relations.*
   * .available`, which `publicRelations` (worker/lib/productOverlay.ts) works
   * out as `stock - reserved` on the colour, option-value and variant rows.
   * That is units ON THE SHELF. A pre-order is not bought from it: it is
   * bought against an import quota that migration 0075 put on the fulfilment
   * cell and its routes (`product_option_fulfillment.capacity`,
   * `product_option_transports.capacity`) and that no colour, option value or
   * variant row carries at all. `resolveForOrderType` (worker/lib/inventory.ts)
   * is the authority and says the same thing by sending a pre-order to
   * `resolveCapacity` and never to `resolveStock`.
   *
   * SO «نفد» ON A PRE-ORDER IS A FALSE REFUSAL. The door would have accepted
   * that line — a zero-stock colour can be pre-ordered perfectly well — while
   * the swatch wore a red verdict about stock the buyer was never going to be
   * served from, and the buyer walked away from an order the shop could fill.
   * Under «طلب مسبق» the honest chip is NO CHIP, because there is no
   * per-colour and no per-option pre-order number in this payload to put
   * there: `availability.preorder.capacity` is resolved for the CURRENT
   * selection only, so painting it onto every swatch would attribute one
   * model's quota to a colour.
   *
   * THE GATE LIVES IN THE HELPER, NOT AT THE FOUR CALL SITES, so a fifth chip
   * cannot reintroduce this, and so the chip and the colour ordering read the
   * identical predicate — `orderedColors` above already refuses to sort by the
   * shelf for exactly this reason, and the two must never contradict each
   * other on the same row.
   */
  const levelChip = (n: number | null | undefined): { text: string; cls: string } | null => {
    if (requestedOrderType !== 'direct_sale') return null;
    if (n === null || n === undefined) return null;
    if (n <= 0) return { text: s.levelOut, cls: 'text-red-300' };
    if (n <= 5) return { text: s.levelLeft.replace('{n}', String(n)), cls: 'text-amber-300' };
    return { text: s.levelAvail.replace('{n}', String(n)), cls: 'text-emerald-300' };
  };
  /**
   * AND PER VALUE, NOT ONLY PER PAGE. `levelChip` is gated on the order type
   * the page is in, but a pill labels ONE model: while the buyer holds a
   * direct-sale model, a sibling that is sold only by pre-order would still
   * read its empty shelf and wear «نفد» — a verdict about a shelf that model
   * is never sold from. So a value whose own cells (or legacy
   * `availability_type`) offer no enabled direct sale gets no shelf chip.
   */
  const optionSellsDirect = (opt: OptionItem | undefined): boolean => {
    if (!opt) return true;
    const cells = opt.fulfillments ?? [];
    if (cells.length > 0) return cells.some((c) => c.fulfillment_type === 'direct_sale' && c.enabled !== false);
    return opt.availability_type !== 'pre_order';
  };
  // The plans priced for the CURRENT selection once a quote landed, else the
  // base-selection list the detail endpoint priced. Either way the dinar beside
  // each option is the server's.
  const warrantyPlans = quotedPlans ?? product.warranty_plans ?? [];
  const warrantyBase = product.warranty_base_months ?? warrantyPlans.find((w) => typeof w.base_months === 'number')?.base_months ?? null;
  /**
   * WHAT THE COLLAPSED WARRANTY HEADER SAYS. A disclosure that hides the
   * answer is worse than one that is always open, so the header carries the
   * current choice: the chosen plan's own headline, or "no extension".
   */
  const warrantySummary = (() => {
    const chosen = warrantyPlans.find((w) => w.id === warrantyPlanId);
    if (!chosen) return s.noWarranty;
    const label =
      chosen.duration_kind === 'extension'
        ? s.extendedPlan(monthsLabel(chosen.duration_months, lang))
        : pick(lang as Lang, chosen.title_ar, chosen.title_en, chosen.title_ckb) || chosen.id;
    return `${label} · +${money(chosen.fee_iqd)}`;
  })();
  const specGroups = (product.spec_groups ?? []).filter((g) => (g.rows ?? []).length > 0);
  const legacySpecs = product.specifications ?? [];
  const descriptionImages = product.description_images ?? [];
  // «محتويات العلبة»: the in_the_box spec field is authored one item per
  // line and shown as REAL bullets (the owner's «بنقاط»). Leading dash/dot
  // markers people naturally type are stripped so bullets never double up.
  const boxItems = (product.spec_fields?.in_the_box ?? '')
    .split(/\r?\n/)
    .map((t) => t.trim().replace(/^[-•·*]\s*/, ''))
    .filter(Boolean);
  /**
   * 0079. «طريقة الاستخدام» IN THE LANGUAGE ON SCREEN.
   *
   * The translation was generated on every save and discarded, so this
   * paragraph showed the admin's English to an Arabic reader for as long as
   * the field existed. `pick` falls back to the source when a language has no
   * authored copy — an honest fallback, never an invented sentence.
   */
  const howToUse = pick(lang as Lang, product.how_to_use_ar, product.how_to_use, product.how_to_use_ckb);
  const guideSteps = product.usage_guide?.steps ?? [];
  const setupSteps = guideSteps.filter((st) => st.kind === 'setup');
  const usageSteps = guideSteps.filter((st) => st.kind !== 'setup');
  const officialUrl = product.usage_guide?.official_url || '';
  // Direct media files play inline; page URLs (YouTube etc.) open as links —
  // an <iframe> for arbitrary stored URLs is not worth its attack surface.
  const isDirectVideo = (u: string) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u);
  const descriptionVideos = product.description_videos ?? [];

  const mode = availability?.mode ?? (source === 'community' ? 'unavailable' : 'direct_sale');
  const selectionComplete = availability ? availability.selection.complete : true;
  /**
   * THE QUOTE IN HAND ANSWERS THE SELECTION ON SCREEN. Anything else is a
   * previous selection's answer — still a real number, but not this one's.
   */
  const quoteFresh = !!quote && quotedFor === priceKey;
  const quoteErrors = quoteFresh ? (quote!.errors ?? []) : [];

  /**
   * THE SERVER'S PRICE FOR THIS SELECTION, FROM THE PAGE REQUEST.
   *
   * `price_levels` was resolved for every reachable option, colour and pair on
   * the same request that delivered the page, so a tap has the exact figure
   * already in memory. It carries no transport commission and no warranty fee
   * — those are chosen separately and only the quote knows them — which is
   * what `levelIsFinal` below is for.
   */
  // Three map lookups — cheaper than the hook that would memoize them, and
  // this sits below the page's early return where a hook cannot go.
  const levelPrice: PriceLevel | null = (() => {
    const L = priceLevels;
    if (!L) return null;
    // The compact level grid predates relational multi-group combinations.
    // Only the live quote can authoritatively price those; showing the first
    // group's figure as final would be a false price while the request runs.
    if (optionValueIds.length > 1) return null;
    if (optionId && colorId) return L.complete ? (L.combo[`${optionId}|${colorId}`] ?? null) : null;
    if (optionId) return L.option[optionId] ?? null;
    if (colorId) return L.color[colorId] ?? null;
    return L.base;
  })();
  const levelIsFinal = !effectiveTransport && !warrantyPlanId;

  /**
   * WHAT THE PAGE PAINTS — and it never paints nothing when it knows something.
   *
   * The confirmed quote first; failing that the server's level price, which is
   * the same resolver's answer to the same question minus the two fees the
   * customer has not chosen. `settled` is the only thing that decides whether
   * the figure is presented as final or as still confirming; it is NOT allowed
   * to decide whether a figure appears at all. That inversion — hiding a known
   * price behind a loading flag — was the whole of the "stuck on updating
   * price" report.
   */
  const shownPrice: { unit: number; regular: number; applied: number; tier: 'regular' | 'pro' | 'prime'; settled: boolean } | null =
    quoteFresh && quoteErrors.length === 0
      ? {
          unit: quote!.unit_subtotal_iqd,
          regular: quote!.regular_iqd,
          applied: quote!.applied_iqd,
          tier: quote!.applied_tier,
          settled: true,
        }
      : levelPrice
        ? {
            unit: levelPrice.unit_subtotal_iqd,
            regular: levelPrice.regular_iqd,
            applied: levelPrice.applied_iqd,
            tier: levelPrice.applied_tier,
            settled: levelIsFinal && !quoteLoading && quoteErrors.length === 0,
          }
        : null;
  /** A figure is on screen but the server has not confirmed THIS selection. */
  const priceIsPending = !!shownPrice && !shownPrice.settled;

  /**
   * THE BUY GATE IS UNCHANGED IN SUBSTANCE: a line may be added only when the
   * server has quoted this exact selection without errors. What changed is
   * that it no longer depends on quantity, so the button stops flickering
   * disabled every time someone asks for a second unit.
   */
  const priceIsAuthoritative = quoteFresh && quoteErrors.length === 0 && selectionComplete;
  const unitPrice = shownPrice?.unit ?? null;
  // The worker's own arithmetic (`unit_subtotal_iqd * qty`), done here so the
  // stepper is instant.
  const lineTotal = unitPrice === null ? null : unitPrice * qty;
  const isPro = viewerTier?.tier === 'pro' && viewerTier.active;
  const isPrime = viewerTier?.tier === 'prime' && viewerTier.active;

  /**
   * §8/§9 — THE MEMBERSHIP PREVIEW THAT ANSWERS THE SELECTION ON SCREEN.
   *
   * The confirmed quote's first; failing that the detail response's, which
   * answered the BASE selection on the very request that delivered the page —
   * which is what lets the membership line appear on the first paint instead
   * of after a debounce and a round trip. It is the same fallback the price
   * itself uses, for the same reason.
   *
   * This REPLACES the old `quote.pro_iqd` reading. That field is resolved in
   * the VIEWER's membership context, so for the people §9 is addressed to —
   * everyone who is not PRO — it could only ever see a typed `pro_price_iqd`
   * and never a configured benefit rule. The preview asks the rules what PRO
   * would actually pay.
   *
   * AND THE DETAIL RESPONSE'S PREVIEW IS READ ONLY FOR THE SELECTION IT
   * ANSWERED — the BASE one: no option, no colour, no transport, no stated
   * order type (`membershipPreview(ctx, doc, { optionId: null, colorId: null })`).
   *
   * Held past that, it is the "up to" number in disguise. A single-option
   * product pre-selects its option on load, and an option or a transport rung
   * may carry its own price: keeping the base answer would put a PRO figure
   * hundreds of thousands of dinars below what PRO actually pays for what is
   * on screen — for the debounce and the round trip, and, for a selection the
   * server refuses to quote (out of stock, transport unconfigured), until the
   * customer changes it. The line simply waits for the quote instead.
   */
  const detailPreviewAnswersSelection = !optionId && !colorId && !effectiveTransport && !orderType;
  const membershipPreview =
    quoteFresh && quoteErrors.length === 0 ? quotedPreview : detailPreviewAnswersSelection ? detailPreview : null;
  const proPreview = membershipPreview?.pro ?? null;

  /**
   * §8 — WHAT THE VIEWER'S OWN MEMBERSHIP TOOK OFF THIS SELECTION, in dinars.
   *
   * `shownPrice` is already the server's resolution for this selection (the
   * quote, or the price-levels grid for the same question), so the saving is
   * the two numbers it carries — never a percentage applied here.
   */
  const appliedMemberTier: 'pro' | 'prime' | null =
    shownPrice && (shownPrice.tier === 'pro' || shownPrice.tier === 'prime') ? shownPrice.tier : null;
  const appliedMemberLabel = appliedMemberTier ? tierLabel(appliedMemberTier) : '';
  /**
   * ...AND NOT WHILE A SCHEDULED OFFER IS ALSO MOVING THE PRICE.
   *
   * `regular - applied` is the membership's whole saving only while the
   * membership is the only thing that lowered this line. It is not, under a
   * live window: `price_levels` prices through `resolveOfferPrice` and the
   * `/quote` route does not (worker/routes/products.ts — `levelPrice` calls
   * `applyOfferToResolved`, the quote handler's `resolveUnitPrice` is bare),
   * so the same selection carries the offer's regular before the quote lands
   * and the ladder's regular after it. A member would be told they saved the
   * offer's discount too — a number the store could not stand behind on the
   * invoice, and one that would change on screen as the quote arrived.
   *
   * The struck regular price and the tier badge still appear. Only the dinar
   * ATTRIBUTION is withheld, because attributing it is exactly what the page
   * cannot currently do.
   */
  const offerPricesThisLine = product.offer?.price_source === 'offer';
  const memberSavingIqd =
    shownPrice && appliedMemberTier !== null && !offerPricesThisLine && shownPrice.regular > shownPrice.applied
      ? shownPrice.regular - shownPrice.applied
      : null;

  /**
   * §9 — THE INVITATION, AND ONLY WHILE IT IS AN INVITATION TO SOMETHING.
   *
   * A PREMIUM member is shown the PRO line, because PRO is the higher tier and
   * telling them otherwise would hide a real difference. But `clampMemberLadder`
   * keeps PRO ≤ PREMIUM, and one rule covering both tiers resolves them to the
   * SAME dinar — at which point a line reading "PRO pays 1,300,000" beside the
   * 1,300,000 they are already paying invites them to buy nothing. Both figures
   * are the server's; this compares them, it does not compute either.
   */
  const proInvite =
    proPreview !== null && !isPro && (!shownPrice || proPreview.unit_iqd < shownPrice.applied) ? proPreview : null;

  const blockingCodes: string[] = [
    ...(availability?.selection.errors ?? []),
    ...quoteErrors.filter((e) => !(availability?.selection.errors ?? []).includes(e)),
  ];
  /**
   * A PRE-ORDER WITH NO ROUTE IS NOT A LINE THE DOOR ACCEPTS, so the button
   * must not offer it. This is the client half of the cart's own refusal
   * (worker/routes/cart.ts, TRANSPORT_REQUIRED) written in the same shape:
   * the type the request will carry, and whether it names a route.
   *
   * `selection.complete` could never cover this — it is built from option and
   * colour codes only (worker/routes/products.ts) and a missing transport has
   * never been one of its errors. That is why «أضف إلى السلة» stayed live
   * with «شحن بري» untouched.
   */
  const routeReady = !(requestedOrderType === 'pre_order' && !effectiveTransport);
  const canBuy =
    source === 'catalog' &&
    mode !== 'unavailable' &&
    selectionComplete &&
    routeReady &&
    quoteErrors.length === 0 &&
    !!availability?.qty_ok &&
    priceIsAuthoritative;

  /**
   * THE ORDER TYPE IN FORCE — hoisted here so that ONE expression answers
   * "how is this being bought right now" for the whole page.
   *
   * This line used to live three hundred lines further down, next to the
   * «طريقة التوفر» chooser it drives, while the header chip and the stock note
   * read the raw server default `mode` instead. That is two computations for
   * one fact, and they drift the moment a buyer touches the chooser: on a
   * product where BOTH ways are open the server defaults to direct sale, so a
   * buyer who pressed «طلب مسبق» kept reading «بيع مباشر · متوفر» in the
   * header while the panel below them was quoting a pre-order. The header was
   * describing a purchase that was no longer the one on offer.
   *
   * It now reads the SAME `requestedOrderType` the quote body and the
   * add-to-cart body send. That is the point: the card drawn with the
   * checkmark, the price being quoted and the row the cart door writes are one
   * answer, so the page can no longer paint a pre-order it does not hold.
   */
  const effectivePreorder = requestedOrderType === 'pre_order';

  /**
   * The same answer as a three-state, which is what the header chip renders.
   *
   * `mode === 'unavailable'` wins outright: when the server says there is no
   * usable way to buy this selection, a buyer's stale button press must not
   * repaint the chip as a live pre-order.
   *
   * AND THE BUYER'S PICK ONLY WINS WHILE IT IS STILL USABLE. This mirrors the
   * server's own §6 resolution (worker/routes/products.ts), which reads
   * `wants === 'direct_sale' && directUsable` — the `&& directUsable` half is
   * the part a chip driven by the button press alone throws away. The failure
   * it prevents, with no race beyond ordinary stock movement: the buyer opens
   * a product while direct sale is in stock, so `orderType` is set to
   * 'direct_sale'; the last unit then sells; the buyer picks a warranty plan,
   * the quote refetches, and the server answers `mode: 'preorder'`. With the
   * pick unchecked the header would repaint the GREEN «بيع مباشر» chip and the
   * note «متوفر» beside a «بيع مباشر» button that is `disabled` and says «نفد
   * المخزون». The header would be contradicting the control under the thumb.
   *
   * So an unusable pick falls back to `mode`, the server's own answer, which
   * is stock-aware by construction. The chip and the chooser still share ONE
   * computation; that computation is now also true.
   *
   * NOTE for the live catalogue: a product whose direct sale is sold out and
   * whose pre-order is open resolves to 'preorder' on the SERVER — so the chip
   * reads «طلب مسبق», which is the truth. It says neither "in stock" nor
   * "unavailable", because neither is true.
   */
  const effectiveMode: 'direct_sale' | 'preorder' | 'unavailable' =
    mode === 'unavailable'
      ? 'unavailable'
      : effectivePreorder
        ? preUsable
          ? 'preorder'
          : mode
        : directUsable
          ? 'direct_sale'
          : mode;

  /**
   * The shelf note beside the chip. Gated on `effectiveMode` and not on `mode`
   * for the reason above: «متوفر» printed next to a «طلب مسبق» chip is a
   * contradiction the shopper has to resolve for themselves, and they will
   * resolve it wrongly.
   */
  const stockNote = (() => {
    if (!availability || effectiveMode !== 'direct_sale') return '';
    if (!availability.stock.tracked) return s.untracked;
    const left = availability.stock.available ?? 0;
    if (left > 0 && left <= 5) return s.lowStock.replace('{n}', String(left));
    // A tracked shelf at zero is not «متوفر». This branch was unreachable
    // while the note was gated on the raw server `mode` — the server never
    // resolves direct_sale at zero stock — and widening the gate to
    // `effectiveMode` is exactly what could reach it. Say nothing rather than
    // print a word the shelf does not support.
    return left > 0 ? s.inStock : '';
  })();

  const modeBadge =
    effectiveMode === 'preorder'
      ? { label: s.preorderMode, cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', icon: <Clock className="w-3.5 h-3.5" /> }
      : effectiveMode === 'direct_sale'
        ? { label: s.directSale, cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', icon: <Package className="w-3.5 h-3.5" /> }
        : { label: s.unavailable, cls: 'bg-red-500/10 text-red-300 border-red-500/30', icon: <AlertTriangle className="w-3.5 h-3.5" /> };

  // Fulfilment choice (owner's model): when direct sale AND pre-order are
  // both genuinely usable the buyer picks one, and every choice shows its
  // FINAL price — never "+X". Every figure is the SERVER's (`pricing_modes`
  // on the detail and on each quote): the direct price with the premium and
  // its PRO exemption, each journey's prepaid price with the commission and
  // its waiver — judged in the same PRO purchase context the checkout uses,
  // so a PRO whose default address is not approved sees the surcharge here
  // too. The page adds nothing to anything.
  // `modesArr` / `directUsable` / `preUsable` are computed further up, because
  // the header chip needs them before this section does — see the note above
  // `effectiveMode`.

  /**
   * 0075 — THE SERVER'S ANSWER PER ROUTE, LOOKED UP AND NEVER RECOMPUTED.
   *
   * A route with its own quota answers from that quota; a route without one
   * answers from the model's shared pool. The browser is told which, and does
   * not work it out: `routes[]` already carries `usable`, the `reason` and the
   * number, resolved by the same function the cart and the checkout run.
   */
  const routeCapacity = (method: string): PreorderRouteView | null =>
    availability?.preorder.routes?.find((r) => r.method === method) ?? null;
  /** The same two facts as `transportUsable` above, by the same name. */
  const routeUsable = (t: TransportView): boolean => transportUsable(t.method);
  /**
   * SOLD OUT ON THE SHELF IS NOT "UNAVAILABLE" WHEN IT CAN STILL BE ORDERED.
   * `modes` is the server's own per-type verdict, so this sentence appears
   * exactly when direct sale is offered-but-empty and pre-order is open.
   */
  const directOutOfStock = modesArr.some(
    (m) => m.type === 'direct_sale' && !m.usable && m.reason === 'OUT_OF_STOCK'
  );
  const directSoldOutPreorderOpen = preUsable && directOutOfStock;

  /**
   * «خبرني لما يرجع» — WHEN THE AFFORDANCE EXISTS AT ALL.
   *
   * Exactly when the server says direct sale is OFFERED and EMPTY. That is the
   * one situation an alert can be honest about: the shelf is the thing that
   * refills, and OUT_OF_STOCK is the server's own verdict that this target
   * sells from a shelf and the shelf is at zero. Every other closed reason is
   * something an alert can never answer — a pre-order-only model has no shelf
   * to watch, an untracked one has no counter to watch it with, and the door
   * would refuse both (worker/lib/stockAlertResolve.ts). Offering a button
   * that the next tap refuses is worse than not offering one.
   *
   * A community listing is excluded for the same reason it cannot be bought:
   * it is not the shop's stock, and nothing here sweeps it.
   */
  const stockAlertOffered = source === 'catalog' && directOutOfStock;
  /** The ONE option group's values, labelled exactly as the chooser labels
   *  them. Empty for a product with several groups — see buildAlertTargets:
   *  a stored alert has one `option_value_id`, so per-model rows would be a
   *  promise about a model in a combination nobody chose. */
  const alertModels: AlertModel[] =
    relationOptionGroups.length === 1
      ? relationOptionGroups[0].values.map((value) => {
          const option = options.find((item) => item.id === value.id);
          return {
            id: value.id,
            label: (option ? pickName(option.name_en, option.name, option.name_ar) : value.name_en) || value.id,
          };
        })
      : [];
  /** Every colour the product models, not only the ones visible for the
   *  current selection: a colour that has gone out of view still has to be
   *  NAMEABLE, or a standing alert on it renders as an unexplained id. */
  const alertColors: AlertColorOption[] = (product.colors ?? []).map((col) => ({
    id: col.id,
    label: pickName(col.name_en, col.name, col.name_ar) || col.id,
  }));
  /**
   * THE CHOICE IS SHOWN WHENEVER THE PRODUCT OFFERS ONE — not only when both
   * halves happen to be buyable today.
   *
   * This was gated on `directUsable && preUsable`, so the whole «طريقة التوفر» block vanished
   * the moment either side was closed: a model sold out on the shelf with its
   * pre-order wide open rendered NO chooser at all, and a buyer looking at
   * «نفد» had no way to learn that the thing could still be ordered. Silence
   * is the one answer a shop must never give about how to buy something.
   *
   * `modes` is the SERVER's list of the types this product declares, each with
   * its own `usable` and `reason`. Two entries means two ways to buy exist, so
   * both are drawn; the one that is closed is disabled and SAYS WHY, in the
   * shop's own words, rather than disappearing.
   */
  const offersBoth = modesArr.length >= 2;
  const modeOf = (type: 'direct_sale' | 'pre_order') => modesArr.find((m) => m.type === type) ?? null;

  /**
   * The order type in force: what the buyer picked, or — before they pick —
   * the server's own default. The transports below follow THIS and not the
   * button state, so a product whose only open route is pre-order still shows
   * its journeys on the first paint.
   */
  const showTransports = effectivePreorder && (availability?.preorder.transports.length ?? 0) > 0;
  const pricingModes = quotedModes ?? detailModes;
  const directFinal: number | null = pricingModes?.direct?.unit_subtotal_iqd ?? null;
  const transportFinal = (t: TransportView): number | null =>
    t.configured ? pricingModes?.preorder.find((m) => m.method === t.method)?.prepaid?.unit_subtotal_iqd ?? null : null;
  const preorderFromFinal = (() => {
    const finals = (availability?.preorder.transports ?? [])
      .map(transportFinal)
      .filter((n): n is number => n !== null);
    return finals.length ? Math.min(...finals) : null;
  })();
  // Cash on delivery changes the pre-order price ONLY when the product has a
  // direct premium this customer pays (H1: with none, the commission stays).
  // The explanation appears only where the number would actually move.
  const codReprices = pricingModes?.cod_reprices === true;

  // ------------------------------------------------------------ sub-renders
  const priceBlock = (
    <div className="lv-surface p-4">
      {shownPrice ? (
        <>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            {/*
              THE FIGURE NEVER LEAVES THE SCREEN. While the server confirms a
              new selection it dims and reports itself busy to assistive tech —
              it does not disappear and it is not replaced by a sentence. Only
              opacity animates, so nothing reflows.
            */}
            <span
              aria-busy={priceIsPending || undefined}
              data-pro-price={appliedMemberTier === 'pro' || undefined}
              className={`${appliedMemberTier === 'pro' ? 'text-coral' : 'text-white'} font-black text-2xl sm:text-3xl tabular-nums transition-opacity duration-200 ${
                priceIsPending ? 'opacity-55' : 'opacity-100'
              }`}
            >
              {money(unitPrice!)}
            </span>
            {appliedMemberTier ? (
              /* §8 — NAMED BY TIER, from tierMeta: «سعر PRO» / «سعر PREMIUM». */
              <span
                data-testid="product-applied-tier"
                data-tier={appliedMemberTier}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-black uppercase tracking-wide ${
                  appliedMemberTier === 'pro' ? 'bg-crimson/15 text-coral' : 'bg-gold/10 text-gold'
                }`}
              >
                {/* PRO is red across the shop — the tier's own colour (tierMeta). */}
                {appliedMemberTier === 'pro' ? (
                  <Sparkles aria-hidden="true" className="w-3 h-3" />
                ) : (
                  <Star aria-hidden="true" className="w-3 h-3 fill-gold" />
                )}
                {s.appliedPriceOf(appliedMemberLabel)}
              </span>
            ) : (
              <span className="text-zinc-400 text-[12px] font-bold">{s.regularPrice}</span>
            )}
          </div>
          {/* §4: no compare-at. The regular price is struck through only when
              the member's own resolved price is genuinely lower.
              §8: and when a MEMBERSHIP is the reason, the page says so in
              dinars, here, rather than leaving the customer to subtract two
              numbers or to discover the benefit at checkout. */}
          {shownPrice.applied < shownPrice.regular ? (
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-zinc-500/80 text-[12px] line-through tabular-nums">{money(shownPrice.regular)}</span>
              {memberSavingIqd !== null ? (
                <span
                  data-testid="product-member-saving"
                  className={`${appliedMemberTier === 'pro' ? 'text-coral' : 'text-gold'} text-[12.5px] font-bold tabular-nums`}
                >
                  {s.savedWithTier(money(memberSavingIqd), appliedMemberLabel)}
                </span>
              ) : null}
            </div>
          ) : null}
          {isPro && viewerTier?.pro_benefits_context === false ? <ProAddressNotice className="mt-2.5" /> : null}
          {qty > 1 ? (
            <div className="text-zinc-400 text-[13px] mt-2">
              {s.lineTotal}: <span className="text-white font-bold tabular-nums">{money(lineTotal!)}</span>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {/*
            NOTHING IS KNOWN YET — the only state in which the page may hedge.
            «يبدأ من» appears only when the SERVER proved the variants differ
            (`display_from`, resolved across every level) and nothing has been
            chosen yet, and the number beside it is `display_price_iqd`: the
            cheapest way to buy the product at this viewer's tier — the same
            figure on the card they tapped — never the raw base row.
          */}
          <div className="flex items-baseline gap-2 flex-wrap">
            {product.display_from && !optionId && !colorId ? (
              <span className="text-zinc-400 text-[12px] font-bold">{s.from}</span>
            ) : null}
            <span className="text-white font-bold text-xl tabular-nums opacity-80">
              {money(product.display_price_iqd ?? product.price_iqd)}
            </span>
          </div>
          <p className="text-zinc-400 text-[13px] mt-2">{quoteLoading ? s.updatingPrice : s.priceUnavailable}</p>
        </>
      )}

      {/*
        §9 — ONE LINE, AND ONLY WHEN THERE IS A REAL NUMBER TO PUT IN IT.
        What PRO pays for THIS product, from the server's preview, and a link
        to /subscription. A null preview means the rules promise PRO nothing
        here, and the line then does not exist — there is no "up to" figure and
        no gold advertisement. PRO is the top tier, so a PREMIUM member still
        sees it; the sentence changes to acknowledge that they already hold a
        membership rather than inviting them to start one.
      */}
      {proInvite !== null ? (
        <button
          type="button"
          data-testid="product-pro-invite"
          onClick={() => navigate('/subscription')}
          className="group mt-3 flex min-h-11 w-full items-center justify-between gap-3 border-s-2 border-gold/55 py-1.5 ps-3 pe-1 text-start text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span className="text-[12.5px] font-medium flex min-w-0 items-center gap-1.5">
            <Star aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-gold" />
            <span className="truncate">{s.memberPriceOf(PRO_LABEL)}</span>
            <span className="shrink-0 tabular-nums font-bold text-gold">{money(proInvite.unit_iqd)}</span>
          </span>
          <span className="shrink-0 text-[11.5px] font-semibold text-text-muted group-hover:text-text-secondary">
            {isPrime ? s.upgradeTo(PRO_LABEL) : s.subscribe}
          </span>
        </button>
      ) : null}

      {/* The customer sees the final product price. Only an optional warranty
          remains itemised; item price and fulfilment increases are deliberately
          not repeated as notes beneath that final figure. */}
      {priceIsAuthoritative && quote!.warranty ? (
        <dl className="mt-3 pt-3 border-t border-zinc-800/70 space-y-1.5 text-[13px]">
          <div className="flex justify-between gap-3" data-warranty-fee-row>
            <dt className="text-zinc-400">
              {s.warranty}
              {quote!.warranty.duration_kind === 'extension'
                ? ` · ${s.extendedPlan(monthsLabel(quote!.warranty.duration_months, lang))}`
                : ''}
            </dt>
            <dd className="text-zinc-200 tabular-nums">{money(quote!.warranty.fee_iqd)}</dd>
          </div>
        </dl>
      ) : null}

      {/* The printer home-delivery note (owner mandate): a fact beside the
          price, from the server's catalog flag and the server's amount. It is
          never added to any figure on this page. */}
      {source === 'catalog' && product.is_printer === true && printerNoteIqd !== null ? (
        <Note tone="zinc" compact animate={false} icon={<Truck className="w-4 h-4" />} className="mt-3" testId="product-printer-note">
          {s.printerNote(money(printerNoteIqd))}
        </Note>
      ) : null}
    </div>
  );

  const activeModel = models?.find((m) => m.key === modelKey) ?? null;

  /**
   * «الوضع في الاختيار يسبب أرباك للعميل ولا يعرف وغير clean» — AND THE
   * SHARPEST CASE OF IT WAS THE SAME QUESTION ASKED TWICE.
   *
   * Two panels on this page can both ask how the thing is fulfilled:
   *
   *   · the «طريقة التوفر» cards at the top, gated on `offersBoth`, which is
   *     `modes.length >= 2` — the server saying this selection can be bought
   *     now AND pre-ordered;
   *   · the «طريقة التوفر» row INSIDE the version chooser, for LEGACY data
   *     where one version is several option rows, each declaring its own route.
   *
   * On legacy data both are true at once, so the customer met the question
   * twice, in two places, with two different sets of buttons — and pressing
   * one left the other looking unanswered, because they are not the same
   * control: the top cards set the order type, the inline row picks the OPTION
   * ROW that carries the route.
   *
   * ONE OF THEM HAS TO STAND DOWN, and it must be the top one. The inline row
   * is not a duplicate of a question — it is the only control that can answer
   * it on this shape of data, because choosing the route means choosing which
   * option row is in the cart. The top cards cannot do that.
   *
   * Read from `models` as a whole rather than from the SELECTED model, so the
   * answer is a property of the product and cannot flip a panel in and out
   * mid-flow as the buyer moves between versions.
   */
  const routeAskedPerVersion = (models ?? []).some((m) => m.options.length > 1);

  /**
   * THE ANSWER, ON THE QUESTION — «الوضع في الاختيار … غير clean».
   *
   * Four to six `lv-section` panels stack down this column, and until now they
   * all looked identical whether or not the buyer had answered them. An
   * unanswered one carried an amber «اختر …» and an answered one carried
   * nothing, so the only way to read the column was to open every panel and
   * look for the ticked chip inside it. On a phone that is most of a screen
   * per question.
   *
   * `Chosen` puts the answer at the end of its own question, in the quiet type
   * the house uses for secondary facts. The column then reads as a summary —
   * «طريقة التوفر · طلب مسبق»، «وسيلة النقل · بحري»، «النسخة · X1C» — and the
   * questions still open are the ones wearing amber. One cue per state, and
   * neither competes with the price.
   *
   * It is the answer IN FORCE, never the raw press: an option that closed
   * while the page was open changes what the panel below is showing, so a
   * header that quoted the press would contradict the tick underneath it.
   */
  const Chosen = ({ value }: { value: string | null | undefined }) =>
    value ? (
      <span className="ms-2 font-medium text-[12px] text-zinc-400" data-chosen>
        · {value}
      </span>
    ) : null;

  const selectionBlocks = (
    <>
      {/*
        THE ORDER OF THESE PANELS IS THE ORDER OF THE DECISION, stated by the
        owner: «أولا يختار طريقة التوفر بيع مباشر أو طلب مسبق، إذا كان طلب مسبق
        ثانيا يختار وسيلة النقل للطلب المسبق، ثم ثالثا يختار النسخة/الخيار،
        ورابعا يختار اللون».

        HOW IT IS BUILT — availability · [notify-me] · transport · option ·
        colour · warranty. It used to run option · colour · availability ·
        notify-me · transport · warranty, which asked the buyer to pick a
        version and a colour before telling them WHICH WAY the thing is sold,
        and then moved the price under them once they answered. The first three
        move as ONE welded unit: the notify-me panel documents its own
        placement beside the disabled «بيع مباشر» card (see its comment), and
        the transport chooser only exists for a pre-order, so it belongs
        directly under the card that chose one.

        Nothing else changed. Every block below is the same JSX it was, with
        the same gate, the same handlers and the same state — this is a move.
      */}
      {offersBoth && !routeAskedPerVersion ? (
        <fieldset className="lv-section" data-fulfilment-chooser>
          <legend className="px-1 text-white font-bold text-[14px] flex items-center gap-2">
            <Truck aria-hidden="true" className="w-4 h-4 text-zinc-400" />
            {s.fulfilment}
            <Chosen value={effectivePreorder ? s.preorderMode : directUsable ? s.directSale : null} />
          </legend>
          <div className="mt-2 flex flex-col gap-2">
            {/* Choosing direct sale does NOT forget the route: a buyer who
                looks at the direct price and goes back to «طلب مسبق» finds
                their sea freight still chosen. `resolveTransport` already
                drops the route from every request while this is the pressed
                card, so nothing direct can carry a transport. */}
            <button
              type="button"
              disabled={!directUsable}
              aria-pressed={directUsable && !effectivePreorder}
              data-order-type="direct_sale"
              data-usable={directUsable ? 'yes' : 'no'}
              onClick={() => setOrderType('direct_sale')}
              className="lv-choice flex min-h-[52px] items-start gap-3 px-3 py-2.5 text-sm text-start disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="min-w-0 flex-1">
                <span className="block">{s.directSale}</span>
                <span className="block text-[11px] text-zinc-400 font-medium leading-snug">{s.fulfilDirectSub}</span>
                {directUsable && directFinal !== null ? (
                  <span className="block tabular-nums text-[14px] font-bold mt-1" data-direct-final>{money(directFinal)}</span>
                ) : null}
                {/* CLOSED, AND IT SAYS WHY. Never a dead chip with no sentence. */}
                {!directUsable ? (
                  <span className="block text-[11px] font-medium text-warning leading-snug mt-1" data-mode-closed>
                    {reasonText(s, modeOf('direct_sale')?.reason)}
                  </span>
                ) : null}
              </span>
              <span className="lv-choice-mark mt-0.5"><Check aria-hidden="true" className="h-3 w-3" /></span>
            </button>
            <button
              type="button"
              disabled={!preUsable}
              aria-pressed={preUsable && effectivePreorder}
              data-order-type="pre_order"
              data-usable={preUsable ? 'yes' : 'no'}
              onClick={() => {
                setOrderType('pre_order');
                const usable = (availability?.preorder.transports ?? []).filter((t) => t.configured);
                if (usable.length === 1) setTransportMethod(usable[0].method);
              }}
              className="lv-choice flex min-h-[52px] items-start gap-3 px-3 py-2.5 text-sm text-start disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="min-w-0 flex-1">
                <span className="block">{s.preorderMode}</span>
                <span className="block text-[11px] text-zinc-400 font-medium leading-snug">{s.fulfilPreorderSub}</span>
                {preUsable && preorderFromFinal !== null ? (
                  <span className="block tabular-nums text-[14px] font-bold mt-1">
                    <span className="text-[10px] font-medium text-zinc-400 me-1">{s.from}</span>
                    {money(preorderFromFinal)}
                  </span>
                ) : null}
                {!preUsable ? (
                  <span className="block text-[11px] font-medium text-warning leading-snug mt-1" data-mode-closed>
                    {reasonText(s, modeOf('pre_order')?.reason)}
                  </span>
                ) : null}
              </span>
              <span className="lv-choice-mark mt-0.5"><Check aria-hidden="true" className="h-3 w-3" /></span>
            </button>
          </div>
          {/* The pre-order price above is the PREPAID one. Paying cash on
              delivery re-prices the line as a direct sale at checkout (owner
              mandate) — said here so the number never surprises later, and
              ONLY when the server says the number would actually move. */}
          {codReprices ? (
            <p className="mt-2 text-[11px] text-zinc-500 leading-relaxed" data-preorder-cod-hint>
              {s.preorderCodHint}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {/*
        «خبرني لما يرجع» — DIRECTLY UNDER «طريقة التوفر», BESIDE THE DISABLED CARD.

        The disabled «بيع مباشر / نفد المخزون حاليًا» card above is where the
        customer learns the cheap route is empty, so the answer to «and then
        what?» belongs in the same block and not at the bottom of the page. It
        sits AFTER the chooser rather than inside it on purpose: the two cards
        in there are a choice between ways to BUY, and a third card that arms a
        notification would read as a third way to buy — «طلب مسبق» would then be
        competing with something that is not an alternative to it.
      */}
      {stockAlertOffered ? (
        <StockAlertPanel
          productId={product.id}
          productSlug={product.slug}
          productLabel={name}
          models={alertModels}
          optionGroupCount={relationOptionGroups.length}
          colors={alertColors}
          selectedColorId={colorId}
          preorderOpen={preUsable}
          isAuthenticated={isAuthenticated}
          intent={alertIntent}
          onIntentConsumed={consumeAlertIntent}
        />
      ) : null}

      {showTransports ? (
        <fieldset className="lv-section">
          <legend className="px-1 text-white font-bold text-[14px] flex items-center gap-2">
            <Truck aria-hidden="true" className="w-4 h-4 text-zinc-400" />
            {s.transport}
            <Chosen value={effectiveTransport ? transportLabel(s, effectiveTransport) : null} />
            {/* THE PANEL SAYS IT IS REQUIRED, beside the choice itself — the
                same shape the colour fieldset uses for `color_required`. The
                button below is disabled until a route is named (`routeReady`),
                and a disabled button with no sentence anywhere is the dead end
                this replaces. */}
            {!routeReady ? (
              <span className="ms-1 text-amber-300 font-medium text-[12px]" data-transport-required>
                {reasonText(s, 'TRANSPORT_REQUIRED')}
              </span>
            ) : null}
          </legend>
          <div className="mt-2 flex flex-col gap-2">
            {availability!.preorder.transports.map((t) => {
              const selected = effectiveTransport === t.method;
              const final = transportFinal(t);
              /**
               * 0075 — A FULL ROUTE IS NOT OFFERED, AND THE OTHERS STILL ARE.
               * The route that ran out is the one that closes: a sea quota of
               * zero must not take air and land down with it, and the customer
               * is told which fact stopped them — "nobody priced this route"
               * and "this route's quota is full" are different problems with
               * different answers.
               */
              const cap = routeCapacity(t.method);
              const usable = routeUsable(t);
              return (
                <button
                  key={t.method}
                  type="button"
                  disabled={!usable}
                  aria-pressed={selected}
                  data-route-usable={usable ? 'true' : 'false'}
                  data-route-reason={cap?.reason ?? (t.configured ? '' : 'TRANSPORT_COMMISSION_UNCONFIGURED')}
                  onClick={() => setTransportMethod(selected ? '' : t.method)}
                  className="lv-choice flex min-h-[48px] items-center justify-between gap-3 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="lv-choice-mark"><Check aria-hidden="true" className="h-3 w-3" /></span>
                    <span className="min-w-0 text-start">{transportLabel(s, t.method)}</span>
                  </span>
                  {/* The FINAL unit price for this journey — never "+X". */}
                  <span className="tabular-nums text-[13px] font-bold">
                    {!t.configured
                      ? s.transportUnset
                      : !usable
                        ? s.routeQuotaFull
                        : final !== null
                          ? money(final)
                          : s.transportUnset}
                  </span>
                </button>
              );
            })}
          </div>
          {/* A pre-order-only product has no fulfilment pill to carry the
              hint, so it sits under the journeys instead — once, not twice,
              and only when cash on delivery would change the price (a
              product with no direct premium keeps its commission either way). */}
          {!offersBoth && codReprices ? (
            <p className="mt-2 text-[11px] text-zinc-500 leading-relaxed" data-preorder-cod-hint>
              {s.preorderCodHint}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {hasMultipleOptionGroups ? (
        <div className="space-y-3" data-option-groups>
          {relationOptionGroups.map((group) => {
            const groupSelected = group.values.find((value) => optionValueIds.includes(value.id))?.id ?? '';
            return (
              <fieldset key={group.id} className="lv-section" data-option-group={group.id}>
                <legend className="px-1 text-white font-bold text-[14px]">
                  {group.name_en}
                  <Chosen
                    value={(() => {
                      if (!groupSelected) return null;
                      const picked = options.find((item) => item.id === groupSelected);
                      return picked ? pickName(picked.name_en, picked.name, picked.name_ar) : null;
                    })()}
                  />
                  {!groupSelected ? (
                    <span className="ms-2 text-amber-300 font-medium text-[12px]">{s.chooseOption}</span>
                  ) : null}
                </legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {group.values.map((value) => {
                    const selected = groupSelected === value.id;
                    const option = options.find((item) => item.id === value.id);
                    const label = option ? pickName(option.name_en, option.name, option.name_ar) : value.name_en || value.id;
                    const chip = !optionSellsDirect(option)
                      ? null
                      : invMode === 'OPTION'
                        ? levelChip(availByValue.get(value.id))
                        : invMode === 'VARIANT_COMBINATION'
                          ? levelChip(variantTotalForOption(value.id))
                          : null;
                    return (
                      <button
                        key={value.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setOptionValueIds((current) =>
                            relationOptionGroups.flatMap((candidateGroup) => {
                              if (candidateGroup.id === group.id) return selected ? [] : [value.id];
                              const kept = candidateGroup.values.find((item) => current.includes(item.id));
                              return kept ? [kept.id] : [];
                            })
                          );
                          /*
                            Any changed dimension asks the server afresh which
                            fulfilment modes this complete combination offers —
                            and that is ALL it does now.

                            IT USED TO CLEAR THE BUYER'S TWO ANSWERS TOO, and
                            the owner met the result: «عند الضغط على النسخة
                            يذهب خيار طريق الشحن … وعند تغيير الخيار يرجع
                            يختفي». Both presses are now remembered and
                            filtered instead — `requestedOrderType` and
                            `effectiveTransport` each honour the press only
                            while this combination still offers it.

                            The clearing existed for a real reason that is
                            fixed at its source. The derived type's fallback
                            used to read `availability.mode`, which is the
                            SERVER ECHOING BACK the `preferredType` this page
                            handed it — so an answer fed the next request and
                            re-latched itself, and dropping the press was the
                            only way to break the loop. The fallback reads
                            `modes[]` now, which the server computes before it
                            looks at `preferredType` at all, so there is no
                            loop left to break.
                          */
                          setLiveAvailability(null);
                        }}
                        className="lv-choice flex min-h-[48px] items-center gap-2 px-3 py-1.5 text-sm font-bold"
                      >
                        {optionImage(value.id) ? (
                          <SafeImage
                            src={optionImage(value.id)}
                            alt={label}
                            aspect="square"
                            fit="cover"
                            className="h-10 w-10 shrink-0 rounded-md"
                            bgClassName="bg-black"
                          />
                        ) : null}
                        <span className="min-w-0 text-start">
                          <span className="block truncate max-w-[10rem]">{label}</span>
                          {chip ? <span className={`block text-[10px] font-medium leading-tight ${chip.cls}`}>{chip.text}</span> : null}
                        </span>
                        <span className="lv-choice-mark ms-auto"><Check aria-hidden="true" className="h-3 w-3" /></span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>
      ) : models ? (
        <fieldset className="lv-section" data-variant-chooser>
          <legend className="px-1 text-white font-bold text-[14px]">
            {tr('اختر النسخة', 'Choose the version', 'وەشان هەڵبژێرە')}
            <Chosen value={activeModel?.label} />
            {!modelKey ? <span className="ms-2 text-amber-300 font-medium text-[12px]">{s.chooseOption}</span> : null}
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {models.map((m) => {
              const selected = modelKey === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  data-variant-model={m.key}
                  aria-pressed={selected}
                  onClick={() => {
                    setModelKey(selected ? '' : m.key);
                    // A modern model is one option with two independent
                    // fulfillment cells, so selecting the model selects that
                    // option immediately. Multiple rows are legacy data and
                    // still need the compatibility chooser below.
                    setOptionValueIds(selected ? [] : m.options.length === 1 ? [m.options[0].id] : []);
                    // A new model is a new fulfilment question, and the
                    // server answers it afresh. The buyer's own two presses
                    // survive it when the new model still offers them — see
                    // the option-group handler above for why they used to be
                    // thrown away and why they no longer need to be.
                    setLiveAvailability(null);
                  }}
                  className="lv-choice flex min-h-[50px] max-w-full items-center gap-2 px-2.5 py-1.5 text-sm font-bold"
                >
                  {m.options[0] && optionImage(m.options[0].id) ? (
                    <SafeImage
                      src={optionImage(m.options[0].id)}
                      alt={m.label}
                      aspect="square"
                      fit="cover"
                      className="h-10 w-10 shrink-0 rounded-md"
                      bgClassName="bg-black"
                    />
                  ) : null}
                  <span className="block truncate max-w-[12rem] text-start">{m.label}</span>
                  <span className="lv-choice-mark ms-auto"><Check aria-hidden="true" className="h-3 w-3" /></span>
                </button>
              );
            })}
          </div>

          {activeModel && activeModel.options.length > 1 ? (
            <div className="mt-4 border-t border-border-subtle pt-3" data-availability-chooser>
              <p className="text-white font-bold text-[13px] mb-2">
                {tr('طريقة التوفر', 'How to get it', 'چۆنیەتی بەردەستبوون')}
              </p>
              <div className="flex flex-wrap gap-2">
                {activeModel.options.map((opt) => {
                  const selected = optionId === opt.id;
                  const isPre = opt.availability_type === 'pre_order';
                  // The «طلب مسبق» button never carries a shelf verdict, even
                  // while the page itself is on the direct sibling.
                  const chip = isPre || !optionSellsDirect(opt)
                    ? null
                    : invMode === 'OPTION'
                      ? levelChip(availByValue.get(opt.id))
                      : invMode === 'VARIANT_COMBINATION'
                        ? levelChip(variantTotalForOption(opt.id))
                        : null;
                  const wait = pick(lang as Lang, opt.lead_time_text_ar, opt.lead_time_text, opt.lead_time_text_ckb);
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      data-availability-option={opt.id}
                      data-availability={opt.availability_type || 'inherit'}
                      aria-pressed={selected}
                      onClick={() => {
                        const next = selected ? '' : opt.id;
                        setOptionValueIds(next ? [next] : []);
                        // The option now decides the route, so the page stops
                        // asking the fulfilment question separately. A direct
                        // option needs no explicit forgetting of the transport:
                        // `effectiveTransport` is empty for anything that is
                        // not a pre-order, and keeping the press means a buyer
                        // who moves back to a pre-order option finds their
                        // journey still chosen.
                        // A LEGACY option that declares its own route answers the
                        // order-type question by being chosen — so the page sends
                        // that answer rather than leaving the server to infer it
                        // from whether a transport happens to follow.
                        if (next)
                          setOrderType(
                            opt.availability_type === 'pre_order'
                              ? 'pre_order'
                              : opt.availability_type === 'direct_sale'
                                ? 'direct_sale'
                                : ''
                          );
                      }}
                      className="lv-choice flex min-h-[48px] items-center gap-3 px-3 py-2 text-start"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold">
                          {isPre
                            ? tr('طلب مسبق', 'Pre-order', 'پێش-داواکاری')
                            : tr('بيع مباشر', 'Direct sale', 'فرۆشتنی ڕاستەوخۆ')}
                        </span>
                        {isPre && wait ? (
                          <span className="block text-[11px] font-medium text-warning leading-tight">{wait}</span>
                        ) : null}
                        {chip ? (
                          <span className={`block text-[10px] font-medium leading-tight ${chip.cls}`}>{chip.text}</span>
                        ) : null}
                      </span>
                      <span className="lv-choice-mark"><Check aria-hidden="true" className="h-3 w-3" /></span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </fieldset>
      ) : options.length > 0 ? (
        <fieldset className="lv-section">
          <legend className="px-1 text-white font-bold text-[14px]">
            {s.options}
            <Chosen
              value={(() => {
                const picked = options.find((item) => item.id === optionId);
                return picked ? pickName(picked.name_en, picked.name, picked.name_ar) : null;
              })()}
            />
            {availability?.selection.option_required && !optionId ? (
              <span className="ms-2 text-amber-300 font-medium text-[12px]">{s.chooseOption}</span>
            ) : null}
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {options.map((opt) => {
              const selected = optionId === opt.id;
              const label = pickName(opt.name_en, opt.name, opt.name_ar) || opt.id;
              const chip = !optionSellsDirect(opt)
                ? null
                : invMode === 'OPTION'
                  ? levelChip(availByValue.get(opt.id))
                  : invMode === 'VARIANT_COMBINATION'
                    ? levelChip(variantTotalForOption(opt.id))
                    : null;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setOptionValueIds(selected ? [] : [opt.id]);
                    // The buyer's presses are kept and filtered, not dropped —
                    // see the option-group handler above.
                    setLiveAvailability(null);
                  }}
                  className="lv-choice flex items-center gap-2 px-3 py-1.5 text-sm font-bold"
                >
                  {optionImage(opt.id) ? (
                    <SafeImage
                      src={optionImage(opt.id)}
                      alt={label}
                      aspect="square"
                      fit="cover"
                      className="h-10 w-10 shrink-0 rounded-md"
                      bgClassName="bg-black"
                    />
                  ) : null}
                  <span className="min-w-0 text-start">
                    <span className="block truncate max-w-[10rem]">{label}</span>
                    {chip && <span className={`block text-[10px] font-medium leading-tight ${chip.cls}`}>{chip.text}</span>}
                  </span>
                  <span className="lv-choice-mark ms-auto"><Check aria-hidden="true" className="h-3 w-3" /></span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {orderedColors.length > 0 ? (
        <fieldset className="lv-section">
          <legend className="px-1 text-white font-bold text-[14px]">
            {s.colors}
            <Chosen
              value={(() => {
                const picked = orderedColors.find((col) => col.id === colorId);
                return picked ? pickName(picked.name_en, picked.name, picked.name_ar) : null;
              })()}
            />
            {availability?.selection.color_required && !colorId ? (
              <span className="ms-2 text-amber-300 font-medium text-[12px]">{s.chooseColor}</span>
            ) : null}
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {orderedColors.map((col) => {
              const selected = colorId === col.id;
              const label = pickName(col.name_en, col.name, col.name_ar) || col.id;
              const comboKey = optionValueIds.length
                ? [...optionValueIds].sort().map((id) => `o:${id}`).concat(`c:${col.id}`).join('|')
                : '';
              const chip = invMode === 'COLOR'
                ? levelChip(availByColor.get(col.id))
                : invMode === 'VARIANT_COMBINATION' && comboKey
                  ? levelChip(variantAvailable.get(comboKey))
                  : null;
              return (
                <button
                  key={col.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    // THE COLOUR DOES NOT DECIDE HOW THE PRODUCT IS SOLD, so it
                    // must not clear the two panels ABOVE it. `option_availability`
                    // is per OPTION (packages/pricing/src/pricing.ts) — no colour
                    // carries one — and since the owner's order puts «طريقة
                    // التوفر» and «وسيلة النقل» first, clearing them here sent the
                    // buyer back two steps for picking a colour.
                    setColorId(selected ? '' : col.id);
                  }}
                  className="lv-choice flex items-center gap-2 px-3 py-1.5 text-sm font-bold"
                >
                  {colorImage(col.id) ? (
                    <SafeImage
                      src={colorImage(col.id)}
                      alt={label}
                      aspect="square"
                      fit="cover"
                      className="h-9 w-9 shrink-0 rounded-md"
                      bgClassName="bg-black"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="w-5 h-5 rounded-full border border-zinc-600 shrink-0"
                      style={{ backgroundColor: col.hex || '#3f3f46' }}
                    />
                  )}
                  <span className="min-w-0 text-start">
                    <span className="block truncate max-w-[9rem]">{label}</span>
                    {chip && <span className={`block text-[10px] font-medium leading-tight ${chip.cls}`}>{chip.text}</span>}
                  </span>
                  <span className="lv-choice-mark ms-auto"><Check aria-hidden="true" className="h-3 w-3" /></span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}


      {/* EXTENDED WARRANTY — printers only (owner mandate). The server sends
          the plans it will actually sell for this selection, each with its fee
          already resolved (a percent of the regular price, rounded once on the
          server) and the total months it yields; this block only lays those
          facts out. A plan can be chosen here or later in the cart, and only
          before the order is placed — the policy link says the rest. */}
      {warrantyPlans.length > 0 ? (
        /*
          AN OPTIONAL UPSELL, SIZED LIKE ONE.

          It used to render permanently expanded — an intro paragraph plus one
          full-width row per plan plus a "no extension" row — inside a gold
          panel that was the loudest surface on a black page. On a phone that
          is roughly 290px of a question the customer has not asked, sitting
          ABOVE the description they came for, and whose default answer ("no
          extension") is already the correct one.

          So it is a disclosure now, in the house zinc that every sibling
          panel uses, and the header states the current choice — closed does
          not mean unanswered. The gold is spent on the one thing that is
          actually a decision: the plan that is selected.
        */
        <fieldset className="lv-surface min-w-0 overflow-hidden" data-extended-warranty>
          <button
            type="button"
            onClick={() => setWarrantyOpen((o) => !o)}
            aria-expanded={warrantyOpen}
            className="w-full min-h-12 px-3.5 py-2 flex items-center justify-between gap-3 text-start hover:bg-white/[0.03] transition-colors [touch-action:manipulation]"
          >
            <span className="min-w-0 flex items-center gap-2">
              <ShieldCheck aria-hidden="true" className="w-4 h-4 text-text-muted shrink-0" />
              <span className="min-w-0">
                <span className="block text-white font-semibold text-[13.5px]">{s.warranty}</span>
                <span className={`block text-[11.5px] truncate ${warrantyPlanId ? 'text-text-secondary' : 'text-text-muted'}`}>
                  {warrantySummary}
                </span>
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className={`w-5 h-5 text-zinc-400 shrink-0 transition-transform duration-200 ${warrantyOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {warrantyOpen ? (
            <div className="px-4 pb-4">
              <p className="text-[12px] text-zinc-400 leading-relaxed">
                {warrantyBase !== null ? s.warrantyIntro(monthsLabel(warrantyBase, lang)) : s.warrantyIntroNoBase}
              </p>
              <div className="mt-3 flex flex-col gap-2" role="radiogroup" aria-label={s.warranty}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!warrantyPlanId}
                  onClick={() => setWarrantyPlanId('')}
                  className="lv-choice flex items-center justify-between gap-3 px-3 text-sm text-start press-scale"
                >
                  <span>{s.noWarranty}</span>
                  <span className="lv-choice-mark"><Check aria-hidden="true" className="h-3 w-3" /></span>
                </button>
                {warrantyPlans.map((w) => {
                  const selected = warrantyPlanId === w.id;
                  const extension = w.duration_kind === 'extension';
                  const headline = extension
                    ? s.extendedPlan(monthsLabel(w.duration_months, lang))
                    : pick(lang as Lang, w.title_ar, w.title_en, w.title_ckb) || w.id;
                  const total = typeof w.total_months === 'number' ? w.total_months : null;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-warranty-plan={w.id}
                      onClick={() => setWarrantyPlanId(selected ? '' : w.id)}
                      className="lv-choice flex min-h-[48px] flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm text-start press-scale"
                    >
                      {/* `flex-1 min-w-0` and NO nowrap: the label is what
                          gives way when the row runs out of room, and it wraps
                          instead of forcing the panel wider than the screen. */}
                      <span className="flex-1 min-w-0">
                        <span className="block">
                          <span dir="ltr" className="tabular-nums">{headline}</span>
                          {total !== null ? (
                            <span className="ms-1.5 text-[12px] font-normal text-text-secondary">
                              {/* The arrow follows the reading direction: from the
                                  extension to the total in both scripts. */}
                              {dir === 'rtl' ? '←' : '→'} {s.extendedTotal(monthsLabel(total, lang))}
                            </span>
                          ) : null}
                        </span>
                        {!extension ? (
                          <span className="block text-[12px] text-zinc-400">
                            {monthsLabel(w.duration_months, lang)} · {s.total}
                          </span>
                        ) : null}
                      </span>
                      <span className="ms-auto flex shrink-0 items-center gap-2 tabular-nums text-[13px]" aria-busy={quoteLoading || undefined}>
                        <span>+{money(w.fee_iqd)}</span>
                        <span className="lv-choice-mark"><Check aria-hidden="true" className="h-3 w-3" /></span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <Link
                to="/policies/extended_warranty"
                className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded"
                data-warranty-policy-link
              >
                <FileText aria-hidden="true" className="w-3.5 h-3.5" />
                {s.warrantyPolicy}
              </Link>
            </div>
          ) : null}
        </fieldset>
      ) : null}
    </>
  );

  /**
   * «يجب أن يظهر هناك العدد في السلة مع زر عرض السلة».
   *
   * ABOVE the quantity stepper, because that is the control it is about: the
   * customer is deciding how many MORE to add, and the number they already
   * have is the fact that decision needs. It is drawn only for the exact
   * selection on screen — this option, this colour — so a customer switching
   * to a colour they have none of sees nothing rather than a count belonging
   * to a different line.
   *
   * Quiet type and a text link, not a card: the price and the buy button are
   * what this column is for, and a boxed notice here would outrank both.
   */
  const inCartNote =
    inCartQty > 0 ? (
      <div
        data-in-cart-note
        className="mb-2 flex items-center justify-between gap-3 text-[12px] text-zinc-400"
      >
        <span className="tabular-nums">{s.inCart(inCartQty)}</span>
        <Link
          to="/cart"
          className="shrink-0 font-medium text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded"
        >
          {s.viewCart}
        </Link>
      </div>
    ) : null;

  const qtyControl = (
    <div>
      {inCartNote}
    <div className="flex items-center justify-between gap-3">
      <span className="text-zinc-300 text-sm font-bold">{s.qty}</span>
      <div className="flex items-center gap-1 rounded-lg bg-surface-raised p-1">
        <button
          type="button"
          aria-label={s.decrease}
          data-mascot="qty-dec"
          onClick={() => stepQty((q) => Math.max(1, q - 1))}
          disabled={qty <= 1}
          className="w-10 h-10 flex items-center justify-center rounded-md text-text-secondary hover:bg-white/[0.06] disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Minus aria-hidden="true" className="w-4 h-4" />
        </button>
        <span className="min-w-[2.5rem] text-center text-white font-bold tabular-nums" aria-live="polite">{qty}</span>
        <button
          type="button"
          aria-label={s.increase}
          data-mascot="qty-inc"
          onClick={() => stepQty((q) => Math.min(maxQty, q + 1))}
          disabled={qty >= maxQty}
          className="w-10 h-10 flex items-center justify-center rounded-md text-text-secondary hover:bg-white/[0.06] disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Plus aria-hidden="true" className="w-4 h-4" />
        </button>
      </div>
    </div>
    </div>
  );

  /**
   * THE PHONE'S ONLY STEPPER, SIZED FOR THE BAR.
   *
   * `qtyControl` above is a full-width labelled row, and at `lg` it is the
   * desktop panel's — there is no bottom bar at that width. Below `lg` this is
   * the only quantity control on the page: 44px targets (the floor for a
   * reliable tap), no label because the bar has no room for one, and it never
   * appears when there is only one unit to be had.
   *
   * It sits beside the price and «أضف إلى السلة», which is where a quantity
   * decision is actually made, and it is reachable from anywhere on the page
   * without scrolling back up.
   */
  const barStepper =
    maxQty > 1 ? (
      <div className="flex shrink-0 items-center rounded-lg bg-surface">
        <button
          type="button"
          aria-label={s.decrease}
          data-mascot="qty-dec"
          onClick={() => stepQty((q) => Math.max(1, q - 1))}
          disabled={qty <= 1}
          className="w-11 h-11 flex items-center justify-center rounded-s-lg text-text-secondary disabled:opacity-35 active:bg-white/[0.06] transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Minus aria-hidden="true" className="w-4 h-4" />
        </button>
        <span className="w-8 text-center text-white font-bold text-sm tabular-nums" aria-live="polite">
          {qty}
        </span>
        <button
          type="button"
          aria-label={s.increase}
          data-mascot="qty-inc"
          onClick={() => stepQty((q) => Math.min(maxQty, q + 1))}
          disabled={qty >= maxQty}
          className="w-11 h-11 flex items-center justify-center rounded-e-lg text-text-secondary disabled:opacity-35 active:bg-white/[0.06] transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Plus aria-hidden="true" className="w-4 h-4" />
        </button>
      </div>
    ) : null;

  const statusMessages = (
    <div className="space-y-2" aria-live="polite">
      {mode === 'unavailable' && availability?.reason ? (
        <p className="lv-alert lv-alert-danger text-red-200 text-[13px]">
          {reasonText(s, availability.reason)}
        </p>
      ) : null}
      {source === 'community' ? (
        <p className="lv-alert lv-alert-warning text-amber-100 text-[13px]">
          {s.COMMUNITY_LISTING_NOT_SELLABLE}
        </p>
      ) : null}
      {/* SOLD OUT FOR "BUY NOW", STILL OPEN AS A PRE-ORDER — said in those
          words. The page used to show only the pre-order badge, leaving a
          customer who came for the shelf to guess why the direct choice had
          gone. Both halves are the server's per-type verdict. */}
      {directSoldOutPreorderOpen ? (
        <p className="lv-alert lv-alert-warning text-amber-100 text-[13px]" data-direct-sold-out-preorder-open>
          {s.directSoldOutPreorderOpen}
        </p>
      ) : null}
      {mode !== 'unavailable' && blockingCodes.length > 0
        ? blockingCodes.map((code) => (
            <p key={code} className="lv-alert lv-alert-warning text-amber-100 text-[13px]">
              {reasonText(s, code)}
            </p>
          ))
        : null}
      {/* NO SECOND COPY BESIDE THE BUTTON. Now that the page always states the
          type, a routeless pre-order makes the resolver raise
          TRANSPORT_REQUIRED (packages/pricing/src/pricing.ts), so
          `blockingCodes` above already prints that sentence here, in this same
          stack, immediately over the CTA. The legend chip on the transport
          panel points at the control that answers it; a third copy between
          them was just noise. */}
      {availability && !availability.qty_ok && mode !== 'unavailable' ? (
        <p className="lv-alert lv-alert-warning text-amber-100 text-[13px]">
          {s.qtyCapped.replace('{n}', String(availability.stock.max_qty))}
        </p>
      ) : null}
      {quoteError ? (
        <div className="pt-1">
          <ErrorState error={quoteError} onRetry={() => setQuoteToken((n) => n + 1)} compact />
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className="lv-alert lv-alert-danger text-red-200 text-[13px]">
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <div className="lv-alert lv-alert-success flex items-center justify-between gap-3 text-[13px] text-emerald-200">
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

  // The line landed in the cart, and the button says so for a moment before
  // returning to its resting label — the feedback belongs on the control that
  // was pressed, not only in a panel somewhere above the fold.
  const justAdded = !!notice;
  const buyButtonLabel = !isAuthenticated
    ? s.signInToBuy
    : addingToCart
      ? s.adding
      : justAdded
        ? s.added
        : mode === 'unavailable'
          ? s.unavailable
          : s.addToCart;

  const buyButton = (
    <button
      type="button"
      data-testid="product-cta"
      onClick={handleAddToCart}
      disabled={addingToCart || (isAuthenticated && !canBuy)}
      className="lv-button lv-button-primary w-full min-h-[50px] text-[15px] active:scale-[0.985] [touch-action:manipulation]"
    >
      {justAdded ? (
        <Check aria-hidden="true" className="w-5 h-5" />
      ) : (
        <ShoppingCart aria-hidden="true" className="w-5 h-5" />
      )}
      {buyButtonLabel}
    </button>
  );

  // ------------------------------------------------------------------ render
  return (
    <div ref={pageRef} className="w-full min-h-[100dvh] bg-black text-zinc-300 font-sans" dir={dir}>
      {/* Sticky page chrome inside the app scroll container — never a fixed
          overlay that could land in the middle of the content. */}
      <div ref={pageHeaderRef} className="lv-character-header sticky top-0 z-30 bg-black/90 backdrop-blur-xl px-4 pb-1.5 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={goBack}
          aria-label={s.back}
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center bg-zinc-900/60 rounded-full hover:bg-zinc-800 transition-colors"
        >
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5 text-white" /> : <ArrowLeft className="w-5 h-5 text-white" />}
        </button>
        <MotionCharacterHome />
        <div className="flex items-center gap-2">
          {/* The compare tray, as a top-bar badge: the floating tray is not
              drawn here, where it would cover the purchase bar (owner Q8).
              Nothing is drawn while the tray is empty. */}
          <CompareBadge className="bg-zinc-900/60 text-zinc-300 hover:text-white hover:bg-zinc-800" />
          <button
            type="button"
            onClick={handleShare}
            aria-label={s.share}
            className="w-11 h-11 rounded-full bg-zinc-900/60 flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <Share2 aria-hidden="true" className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={toggleFavorite}
            disabled={source !== 'catalog'}
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
      <div className="mx-auto w-full max-w-[1540px] px-4 sm:px-6 xl:px-8 pt-2 pb-[calc(156px+env(safe-area-inset-bottom))] sm:pb-[calc(112px+env(safe-area-inset-bottom))] lg:pb-12">
        {/*
          THE LEFT COLUMN NEEDED A CEILING. With a single `minmax(0,1fr)` track
          against a fixed 400px panel inside a 1240px shell, the content side
          was 776px at every viewport from 1240px up — a 776×460 letterbox
          holding a square photo with 158px of empty black on each side, and
          text lines running past 110 characters. The extra width now goes to
          the panel and to the gutter instead of all to the gallery, and the
          grid centres rather than stretching.
        */}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_440px] lg:gap-8 xl:gap-12 lg:items-start">
          {/* -------------------------------------------------- left column */}
          <div className="min-w-0">
            <section aria-label={s.gallery}>
              <div className="relative w-full h-[min(78vw,340px)] sm:h-[420px] lg:h-[520px] xl:h-[560px] rounded-2xl border border-zinc-800/70 bg-zinc-950 overflow-hidden">
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
                    ref={(el) => {
                      zoomBtnRef.current = el;
                    }}
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
                        i === galleryIndex ? 'border-white/30 bg-surface-selected' : 'border-border-subtle hover:border-zinc-600'
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
              <h1 className="text-xl sm:text-2xl font-bold text-white leading-snug">{name}</h1>
              <p className="mt-2 text-[12px] text-zinc-500 flex items-center gap-1.5">
                <Store aria-hidden="true" className="w-3.5 h-3.5" />
                {source === 'community' && product.merchant ? (
                  <>
                    {s.communityStore} · {product.merchant.name}
                    {/* The in-site store page is behind the community wall;
                        while it is shut this goes to the store's own site. */}
                    <CommunityStoreLink id={product.merchant.id} className="underline underline-offset-2 ms-1">
                      {s.visitStore}
                    </CommunityStoreLink>
                  </>
                ) : (
                  <>{s.officialStore} · Levonis</>
                )}
              </p>
              {/*
                THE THREE SIGNALS A SHOPPER WEIGHS BEFORE THE PRICE.

                WHY HERE, DIRECTLY UNDER «المتجر الرسمي». The owner asked for
                this row to sit below the store line and above «وصف المنتج»,
                and reported it as never applied. It had in fact shipped — but
                ABOVE the <h1>, so the first thing on the page was a row of
                badges and the header looked untouched. A shopper reads WHAT
                this is and WHO sells it first; the signals qualify that
                answer, so they follow it.

                It goes ABOVE the ConditionPanel, not below it, for two
                reasons. The «مستعمل / مفتوح العلبة» chip in this row is the
                one-word version of the panel's whole argument, so the chip
                must introduce the panel rather than repeat it after the fact.
                And the panel is a paragraph of prose: dropping a badge row
                after it would restart the header halfway down the page.

                Availability, score and how many have sold. Only the first
                carries a semantic tint: it is the one that changes what
                happens when you tap Buy, and tinting all three would make a
                row of competing badges out of what should read as one quiet
                line of facts (§7 — accent where it communicates importance).
                The star keeps the gold because a rating without one is not a
                rating; the sales chip is neutral.

                Each chip renders only when it has something true to say — no
                "0 reviews" and no "0+ sold". A new product shows one chip,
                which is correct: nothing has happened to it yet.
              */}
              <div data-product-signals className="mt-3 flex items-center gap-x-2 gap-y-1.5 flex-wrap">
                <span className={`inline-flex items-center gap-1.5 border rounded-full px-2.5 py-1 text-[11px] leading-normal font-bold ${modeBadge.cls}`}>
                  {modeBadge.icon}
                  {modeBadge.label}
                </span>

                {rating && rating.count > 0 ? (
                  <span
                    data-product-rating
                    aria-label={s.ratingAria(rating.average.toFixed(1), rating.count)}
                    className="inline-flex items-center gap-1.5 border border-zinc-700 rounded-full px-2.5 py-1 text-[11px] leading-normal text-zinc-300"
                  >
                    <Star aria-hidden="true" className="w-3.5 h-3.5 text-gold" fill="currentColor" strokeWidth={0} />
                    {/* Tabular figures so a 4.0 and a 4.8 occupy the same
                        width and the row does not shift as products change. */}
                    <span className="font-bold tabular-nums" dir="ltr">{rating.average.toFixed(1)}</span>
                    <span className="text-zinc-500 tabular-nums">
                      ({rating.count.toLocaleString('en-US')} {s.reviewsCount(rating.count)})
                    </span>
                  </span>
                ) : null}

                {salesBadge !== null ? (
                  <span
                    data-product-sales={salesBadge}
                    aria-label={s.salesAria(salesBadge.toLocaleString('en-US'))}
                    className="inline-flex items-center gap-1.5 border border-zinc-700 rounded-full px-2.5 py-1 text-[11px] leading-normal text-zinc-300"
                  >
                    <TrendingUp aria-hidden="true" className="w-3.5 h-3.5 text-zinc-400" />
                    {/* `dir="ltr"` on the figure alone: «+200 مبيعات» has an
                        LTR number inside an RTL sentence, and without the
                        isolate the plus sign jumps to the wrong side of it. */}
                    <span className="font-bold tabular-nums" dir="ltr">+{salesBadge.toLocaleString('en-US')}</span>
                    <span className="text-zinc-500">{s.salesSold}</span>
                  </span>
                ) : null}

                {/* A graded unit says so beside its availability, not only
                    in the panel below — the chip row is what a shopper reads
                    before scrolling, and "used" is not a footnote. */}
                {productCondition ? (
                  <span
                    data-condition-chip={productCondition.kind}
                    className="inline-flex items-center gap-1.5 border border-info/30 bg-info/10 rounded-full px-2.5 py-1 text-[11px] leading-normal font-bold text-info"
                  >
                    <PackageOpen aria-hidden="true" className="w-3.5 h-3.5" />
                    {conditionKindLabel(productCondition.kind, lang)}
                  </span>
                ) : null}
                {product.brand ? (
                  <span className="border border-zinc-700 rounded-full px-2.5 py-1 text-[11px] leading-normal text-zinc-300">{product.brand}</span>
                ) : null}
                {stockNote ? <span className="text-zinc-400 text-[12px] leading-normal">{stockNote}</span> : null}
              </div>
              {/* The frame the price below only makes sense inside: what this
                  unit is, what was wrong with it, what it is covered for, and
                  that it cannot be sent back for a change of mind. Above the
                  purchase controls, never below them. */}
              {productCondition ? (
                <ConditionPanel condition={productCondition} reference={conditionRef} />
              ) : null}

              {/* Only honest when the counter really is product-wide: with
                  OPTION/COLOR inventory the pills carry their own counts. */}
              {availability?.stock.tracked &&
              (availability.stock.scope === 'product' || availability.stock.scope === 'base') &&
              invMode === 'BASE' &&
              (options.length > 0 || (product.colors ?? []).length > 0) ? (
                <p className="mt-1 text-[12px] text-zinc-500">{s.stockProductScope}</p>
              ) : null}
            </div>

            {/*
              Purchase panel on PHONES: the same controls, stacked, with the CTA
              AND THE STEPPER delegated to the single bottom bar.

              The quantity row used to live here as well. On a phone the bottom
              bar is always on screen, so the customer saw two steppers a
              thumb-length apart, driving the same number — the duplication the
              owner reported. Two controls for one value is not redundancy, it
              is a question about which one is real.

              The bar's own stepper is the survivor because it is the one beside
              the price and the «أضف إلى السلة» button, which is where a
              quantity decision is actually made. The DESKTOP panel below keeps
              its copy: there is no bottom bar at `lg`, so removing it there
              would leave no way to change quantity at all.
            */}
            <div className="mt-5 space-y-3 lg:hidden">
              {priceBlock}
              {selectionBlocks}
              {statusMessages}
            </div>

            {/* Content sections */}
            {/* A reading measure, independent of the gallery: 68 characters
                is a comfortable line, and the sections below are prose. */}
            <div className="mt-6 space-y-3 max-w-[68ch]">
              <Section title={s.description} icon={<FileText aria-hidden="true" className="w-5 h-5 text-zinc-400" />} defaultOpen>
                {description ? (
                  <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-line">{description}</p>
                ) : (
                  <p className="text-sm text-zinc-500">{s.noDescription}</p>
                )}
              </Section>

              {boxItems.length > 0 ? (
                <Section title={s.inTheBox} icon={<Box aria-hidden="true" className="w-5 h-5 text-zinc-400" />}>
                  <ul className="space-y-1.5">
                    {boxItems.map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-zinc-300 leading-relaxed">
                        <span aria-hidden="true" className="mt-2 w-1.5 h-1.5 rounded-full bg-gold shrink-0" />
                        <span dir="auto" className="min-w-0">{item}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {guideSteps.length > 0 || howToUse ? (
                <Section title={s.howToUse} icon={<Settings2 aria-hidden="true" className="w-5 h-5 text-zinc-400" />}>
                  {officialUrl ? (
                    <a
                      href={officialUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 mb-3 min-h-9 px-3 rounded-lg border border-gold/40 bg-gold/10 text-gold text-[13px] font-bold hover:bg-gold/20 transition-colors"
                    >
                      <ExternalLink aria-hidden="true" className="w-3.5 h-3.5" />
                      {s.officialGuide}
                    </a>
                  ) : null}
                  {guideSteps.length > 0 ? (
                    <div className="space-y-4">
                      {[
                        { steps: setupSteps, title: s.setupTitle, icon: <Wrench aria-hidden="true" className="w-4 h-4 text-amber-300" /> },
                        { steps: usageSteps, title: s.howToUse, icon: <Settings2 aria-hidden="true" className="w-4 h-4 text-zinc-400" /> },
                      ]
                        .filter((grp) => grp.steps.length > 0)
                        .map((grp) => (
                          <div key={grp.title} className="min-w-0">
                            {/* One kind alone skips the redundant sub-heading. */}
                            {setupSteps.length > 0 && usageSteps.length > 0 ? (
                              <h4 className="flex items-center gap-1.5 text-[13px] font-bold text-white mb-2">
                                {grp.icon}
                                {grp.title}
                              </h4>
                            ) : null}
                            <ol className="space-y-2.5">
                              {grp.steps.map((st, i) => (
                                <li key={st.id || i} className="rounded-xl border border-zinc-800/70 bg-zinc-900/50 p-3 min-w-0">
                                  <div className="flex items-start gap-2.5 min-w-0">
                                    <span
                                      aria-hidden="true"
                                      className="shrink-0 w-6 h-6 rounded-lg grid place-items-center text-[11px] font-black bg-gold/15 text-gold"
                                    >
                                      {i + 1}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      {pick(lang as Lang, st.title_ar, st.title, st.title_ckb) ? (
                                        <h5 dir="auto" className="text-[13px] font-bold text-white leading-snug">
                                          {pick(lang as Lang, st.title_ar, st.title, st.title_ckb)}
                                        </h5>
                                      ) : null}
                                      {pick(lang as Lang, st.body_ar, st.body, st.body_ckb) ? (
                                        <p dir="auto" className="mt-1 text-[13px] text-zinc-300 leading-relaxed whitespace-pre-line">
                                          {pick(lang as Lang, st.body_ar, st.body, st.body_ckb)}
                                        </p>
                                      ) : null}
                                    </div>
                                  </div>
                                  {st.images.length > 0 ? (
                                    <div className="mt-2.5 grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                                      {st.images.map((img, k) => (
                                        <SafeImage
                                          key={k}
                                          src={img}
                                          alt={pick(lang as Lang, st.title_ar, st.title, st.title_ckb)}
                                          aspect="square"
                                          fit="cover"
                                          className="rounded-lg border border-zinc-800"
                                          bgClassName="bg-zinc-900"
                                        />
                                      ))}
                                    </div>
                                  ) : null}
                                  {st.video_url && isDirectVideo(st.video_url) ? (
                                    <div className="mt-2.5 aspect-video rounded-lg overflow-hidden bg-black border border-zinc-800">
                                      <video src={st.video_url} controls preload="none" className="w-full h-full object-contain" />
                                    </div>
                                  ) : null}
                                  {(st.video_url && !isDirectVideo(st.video_url)) || st.link_url ? (
                                    <div className="mt-2.5 flex flex-wrap gap-2">
                                      {st.video_url && !isDirectVideo(st.video_url) ? (
                                        <a
                                          href={st.video_url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-zinc-700 bg-zinc-800/50 text-zinc-200 text-[12px] font-bold hover:border-zinc-500 transition-colors"
                                        >
                                          <PlayCircle aria-hidden="true" className="w-3.5 h-3.5" />
                                          {s.watchVideo}
                                        </a>
                                      ) : null}
                                      {st.link_url ? (
                                        <a
                                          href={st.link_url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-zinc-700 bg-zinc-800/50 text-zinc-200 text-[12px] font-bold hover:border-zinc-500 transition-colors"
                                        >
                                          <ExternalLink aria-hidden="true" className="w-3.5 h-3.5" />
                                          {s.stepDoc}
                                        </a>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </li>
                              ))}
                            </ol>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p dir="auto" className="text-sm text-zinc-300 leading-relaxed whitespace-pre-line">{howToUse}</p>
                  )}
                </Section>
              ) : null}

              {showPhysicalDimensions ? (
                <Section
                  title={tr('الأبعاد والوزن', 'Dimensions & weight', 'ڕەهەندەکان و کێش')}
                  icon={<PackageOpen aria-hidden="true" className="w-5 h-5 text-zinc-400" />}
                  defaultOpen
                >
                  <div
                    className="grid gap-3 sm:grid-cols-2"
                    data-resolved-physical-dimensions
                    data-variant-id={selectedVariantId ?? ''}
                  >
                    {dimensionGroups.map((group) => (
                      <div key={group.id} className="rounded-xl border border-zinc-800/70 bg-black/20 p-3">
                        <h4 className="mb-1 text-[12px] font-bold text-zinc-300">{group.title}</h4>
                        <dl className="text-[12px]">
                          {group.rows.map((row) => {
                            const value = physicalDimensions[row.key];
                            return (
                              <div
                                key={row.key}
                                className="flex items-baseline justify-between gap-3 border-b border-zinc-800/60 py-1.5 last:border-0"
                                data-dimension-field={row.key}
                              >
                                <dt className="text-zinc-500">{row.label}</dt>
                                <dd className="tabular-nums text-zinc-200" dir="ltr">
                                  {formatPhysicalMeasurement(value, row.kind)}
                                </dd>
                              </div>
                            );
                          })}
                        </dl>
                      </div>
                    ))}
                  </div>
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

              {/*
                THE TWO SOFT VERBS, at the end of the details and above the
                reviews — the moment the customer has finished reading the
                machine and is deciding, which is when «is there a better one»
                and «is it cheaper elsewhere» are actually asked.

                SIDE BY SIDE, not stacked: the owner asked for «زران ناعمان
                بشكل افقي … واحده جنب الاخرى». `grid-cols-2` with no responsive
                prefix stays two columns at 360px; the labels wrap inside their
                own button rather than pushing the pair into one column.

                SECONDARY ON PURPOSE. Neither is a second Add-to-cart, so both
                take `.lv-button-secondary` — one weight below the buy button
                that owns this page. `.press-scale` answers the finger on
                pointer-DOWN through the base layer's `:active`, so there is no
                JavaScript on the input path and nothing that depends on hover,
                which never fires on the owner's own phone.
              */}
              <div className="pt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => navigate(`/compare?ids=${encodeURIComponent(product.id)}`)}
                  data-product-compare
                  className="lv-button lv-button-secondary lv-button-sm press-scale w-full text-center"
                >
                  {s.compareCta}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // The page's own established signed-out answer — the one
                    // `toggleFavorite` already gives — rather than a second
                    // sign-in prompt invented for this one button.
                    if (!isAuthenticated) {
                      navigate(authPathWithSupportRef(`/product/${product.slug}`));
                      return;
                    }
                    setCheaperOpen(true);
                  }}
                  data-product-cheaper
                  className="lv-button lv-button-secondary lv-button-sm press-scale w-full text-center"
                >
                  {s.cheaperCta}
                </button>
              </div>

              {/*
                «يكون كملاحظه بسيطه في اسفل الزرين» — a NOTE, under the pair,
                and deliberately not a third button.

                The two above are already one weight below Add to cart; a third
                control of the same size would turn a quiet row into a menu and
                put an instalments offer at the same emphasis as the purchase
                this page is for. So this is body text with an underline — the
                web's own "this opens something" affordance — at the smallest
                size the page uses, in the muted foreground.

                It is still a real `<button>`: it takes the global `:active`
                dim and the focus ring, and it reads as a control to a screen
                reader, which a `<span onClick>` would not.

                DRAWN FOR SIGNED-OUT VISITORS TOO. Nothing behind it needs an
                account — the sheet states a bank's condition and opens a link —
                so sending someone to /auth first would be a gate in front of
                information, unlike the price report beside it which files
                something against their name.
              */}
              {giniLink ? (
                <div className="pt-1">
                  {/* Quiet to the eye, but a full-size target to the thumb:
                      `min-h-[40px]` with negative inline margin keeps the line
                      looking like body text while staying comfortably tappable
                      on the phone this page is mostly read on. */}
                  <button
                    type="button"
                    onClick={() => setGiniOpen(true)}
                    data-product-gini
                    className="inline-flex min-h-[40px] items-center -mx-1 rounded-sm px-1 text-[12.5px] font-light text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {s.giniCta}
                  </button>
                </div>
              ) : null}

              <div className="pt-2">
                <ReviewSection productId={product.id} />
              </div>
            </div>
          </div>

          {/* ------------------------------------------------- right column */}
          {/*
            THE BUY COLUMN SCROLLS ITSELF WHEN IT IS TALLER THAN THE SCREEN.

            It was `lg:sticky` with a `top` offset and nothing else. A sticky
            box taller than the viewport sticks at `top` and hangs its bottom
            BELOW the fold, where no scroll can reach it: the page scroll no
            longer moves it, and it only comes up once the page has scrolled
            past the whole left column and the element un-sticks. That is
            exactly what the owner described — «التمرير للأسفل في الخيارات لا
            يعمل إلا عند النزول لأسفل تفاصيل المنتج» — and the owner's own
            reorder is what made it reachable: availability, notify-me,
            transport, version, colour and warranty now stack in one column,
            and on a 1024-high screen that runs past the bottom long before the
            «أضف إلى السلة» button.

            Bounding the height and letting it scroll internally is the same
            answer src/components/policies/PolicyOutline.tsx already gives for
            the same shape, down to `100dvh`, the header-height variable and
            `custom-scrollbar`. A panel that FITS is unaffected: `max-height`
            does not bite and `overflow-y: auto` shows no scrollbar.
          */}
          <aside
            className="hidden lg:block lg:sticky space-y-3 lg:overflow-y-auto custom-scrollbar"
            style={{
              top: 'calc(var(--app-header-height, 68px) + 0.75rem)',
              maxHeight: 'calc(100dvh - var(--app-header-height, 68px) - 1.5rem)',
            }}
          >
            {priceBlock}
            {selectionBlocks}
            <div className="lv-surface space-y-3 p-4">
              {qtyControl}
              {buyButton}
              <p className="text-[11px] text-zinc-500 leading-relaxed">{s.serverChecks}</p>
            </div>
            {statusMessages}
          </aside>
        </div>
      </div>

      {/* ------------------------------------------------ phone purchase bar */}
      <div data-testid="product-buybar" className="lg:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border-subtle bg-surface-raised/98 px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shadow-[0_-12px_36px_-24px_rgb(0_0_0/.9)]">
        {/*
          THE CONFIRMATION LIVES WHERE THE TAP HAPPENED. On a phone the CTA is
          this fixed bar while the status panel is hundreds of pixels above the
          fold, so a customer who added from here previously got no visible
          answer at all.
        */}
        {notice ? (
          <div
            role="status"
            className="lv-alert lv-alert-success mx-auto mb-2 flex w-full max-w-[640px] items-center justify-between gap-3 text-[13px] text-emerald-200"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Check aria-hidden="true" className="w-4 h-4 shrink-0" />
              <span className="truncate">{notice}</span>
            </span>
            <Link to="/cart" className="font-bold underline underline-offset-2 shrink-0">
              {s.viewCart}
            </Link>
          </div>
        ) : null}
        {/*
          The same note, on the surface a phone actually has. `qtyControl` and
          its note are the DESKTOP panel's — below `lg` this bar is the only
          place a quantity decision is made, so the count belongs here too.

          Suppressed while `notice` is up: that banner is the answer to the tap
          the customer just made and already carries «عرض السلة». Two rows
          saying almost the same thing, one above the other, is the crowding
          this bar is kept clear of.
        */}
        {!notice ? <div className="mx-auto w-full max-w-[640px]">{inCartNote}</div> : null}
        <div className="mx-auto grid w-full max-w-[640px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:gap-2.5">
          {/*
            A FIXED FOOTPRINT. This cell used to be auto-sized, so its width
            followed whichever string it held — a number, «يجري تحديث السعر…»,
            or an em dash — and the `flex-1` CTA beside it visibly grew and
            shrank on every quote. Reserving the space keeps the bar still.
          */}
          <div className="min-w-0 sm:basis-[7.5rem] sm:shrink-0">
            <div className="text-[11px] text-zinc-500">{s.price}</div>
            <div
              aria-busy={priceIsPending || undefined}
              className={`text-white font-black text-[15px] tabular-nums truncate transition-opacity duration-200 ${
                priceIsPending ? 'opacity-55' : 'opacity-100'
              }`}
            >
              {lineTotal !== null ? money(lineTotal) : '—'}
            </div>
          </div>
          {barStepper}
          <div className="col-span-2 min-w-0 sm:flex-1">{buyButton}</div>
        </div>
      </div>

      {/* ------------------------------------------------------- image zoom */}
      {/*
        THE PHOTO VIEWER.

        It used to be a bare `fixed inset-0 bg-black/95` that was mounted when
        `lightbox` flipped true and unmounted when it flipped false: the photo
        appeared out of nothing and, on close, simply ceased to exist. On a
        product page that is worse than merely abrupt — the customer loses the
        thread between the thumbnail they tapped and the enlarged image, so a
        second tap feels like opening a different thing rather than returning
        to the same one.

        `Overlay`, not `Sheet`: this is a centred viewing task, not a tray of
        controls pulled up from the bottom edge, and a drag-down-to-dismiss
        grabber on top of a photograph would both cover the product and invite
        a gesture that fights the pinch/pan people expect over an image. It
        arrives scaled up out of the zoom button (`anchor`) and collapses back
        into it, which is the spatial link the old markup could not express.

        `solid`: the primitive's default material is tinted, blurred glass.
        Behind a product photo that is a lie about the colour the customer is
        about to pay for, so the viewer opts out and supplies its own neutral
        black ground — matching the old `bg-black/95` — where the only colour
        on screen is the product's own.

        Dismissal is unchanged in substance: the old container closed on any
        click that was not the image itself (the <img> stopped propagation), so
        the scrim closes it here, and the X button stays exactly as it was.
        `z={200}` preserves the old `z-[200]`.
      */}
      <Overlay
        open={lightbox && !!activeMedia?.url}
        onClose={() => setLightbox(false)}
        label={s.gallery}
        anchor={zoomBtnRef}
        solid
        z={200}
        testId="product-lightbox"
        panelClassName="bg-black max-w-full max-h-[calc(100dvh-2rem)] overflow-hidden"
      >
        <button
          type="button"
          onClick={() => setLightbox(false)}
          aria-label={s.close}
          className="absolute top-4 end-4 z-10 w-11 h-11 rounded-full bg-zinc-900 border border-zinc-700 flex items-center justify-center text-white"
        >
          <X aria-hidden="true" className="w-5 h-5" />
        </button>
        <img
          src={activeMedia?.url}
          alt={pick(lang as Lang, activeMedia?.alt_ar, activeMedia?.alt_en, activeMedia?.alt_ckb) || name}
          referrerPolicy="no-referrer"
          className="block max-w-full max-h-[calc(100dvh-2rem)] object-contain"
        />
      </Overlay>

      <ShippingConflictDialog
        open={shippingConflict !== null}
        lang={lang}
        dir={dir}
        cartType={shippingConflict?.cartType}
        incomingType={shippingConflict?.incomingType}
        busy={addingToCart}
        onConfirm={() => void postAddToCart(true)}
        onCancel={() => setShippingConflict(null)}
      />

      <CheaperElsewhereSheet
        open={cheaperOpen}
        productId={product.id}
        onClose={() => setCheaperOpen(false)}
      />

      {/* Mounted only when there is a link to open, so the sheet can never be
          opened onto an empty promise by a stale piece of state. */}
      {giniLink ? (
        <GiniInstalmentsSheet
          open={giniOpen}
          url={giniLink}
          condition={pickText(giniPolicy?.conditions, lang)}
          onClose={() => setGiniOpen(false)}
        />
      ) : null}
    </div>
  );
}
