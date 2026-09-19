import React, { useState } from 'react';
import { useLanguage } from '../LanguageContext';

import { Settings, Package, Boxes, LayoutList, Users, Wallet, Bell, LayoutDashboard, ClipboardList, Megaphone, Barcode, Star, ShieldCheck, Crown, Ticket, Tag, Truck, Store, Factory, Dice5, Layers, Percent as PercentIcon, BadgePercent, MessageCircle } from 'lucide-react';
import DashboardLayout from '../components/DashboardLayout';

/**
 * THE NINETEEN ADMIN PANELS, EACH ITS OWN CHUNK (`01-TARGET.md` §10, plan 1.8).
 *
 * They were static imports, so opening any page of the site downloaded the
 * product form, the import panel, the taxonomy editor, the KYC console and the
 * printer-farm configuration — the largest components in the application, used
 * by a handful of people, reached from a tab that renders exactly one of them
 * at a time. `activeTab` already decides which one mounts; making the import
 * follow that decision changes nothing a user can do and everything about what
 * they download.
 *
 * NO API CHANGE. Same components, same props, same tabs, same order. The one
 * visible difference is a brief fallback the first time a tab is opened, and
 * `<Suspense>` below is scoped to the panel area so the sidebar and the title
 * never flicker with it.
 */
// The order board was ~250 lines INSIDE this page while every comparable
// panel — including this one's own modal, stage panel and chat — already lived
// in src/components/adminOrders/. It is the twentieth panel now, and it is
// lazy for the same reason the other nineteen are: the tab decides what is
// downloaded.
const OrdersBoard = React.lazy(() => import('../components/adminOrders/OrdersBoard'));
const AdminCoupons = React.lazy(() => import('../components/adminCoupons/AdminCoupons'));
const AdminDelivery = React.lazy(() => import('../components/adminDelivery/AdminDelivery'));
const AdminCommunity = React.lazy(() => import('../components/adminCommunity/AdminCommunity'));
const AdminProducts = React.lazy(() => import('../components/AdminProducts'));
// The bundles panel moved to its own folder when a bundle became a real
// products row (docs/BUNDLES_MYSTERY.md §11.1). The chunk NAME is unchanged —
// tests/bundleBudget.test.ts pins it — because the file name is unchanged.
const AdminBundles = React.lazy(() => import('../components/adminBundles/AdminBundles'));
// §11.1 tab 4: windows, tiers, limits and the offer price for ANY subject —
// the one promotion model, with its own chunk (§14 bundle budget).
const AdminOffers = React.lazy(() => import('../components/adminOffers/AdminOffers'));
// §11.1 tabs 2 and 3. Seventeen admin routes under `/api/admin/mystery` had no
// UI at all: an owner could not create a mystery offer (the bundles panel pins
// `kind` to 'bundle' on create), could not set a spool count, a pool, a
// duplicate policy or a reveal milestone, and the two warnings the mandate
// quotes word for word — POOL_ZERO_WEIGHT and POOL_TOO_SMALL_FOR_FORBID —
// were computed and could never render to a human.
const AdminMystery = React.lazy(() => import('../components/adminMystery/AdminMystery'));
const AdminMysteryPools = React.lazy(() => import('../components/adminMystery/AdminMysteryPools'));
const AdminTaxonomy = React.lazy(() => import('../components/adminTaxonomy/AdminTaxonomy'));
const AdminWarranties = React.lazy(() => import('../components/adminWarranty/AdminWarranties'));
const AdminAds = React.lazy(() => import('../components/AdminAds'));
const AdminHomeSettings = React.lazy(() => import('../components/AdminHomeSettings'));
const AdminOverview = React.lazy(() => import('../components/AdminOverview'));
const AdminUsers = React.lazy(() => import('../components/AdminUsers'));
const AdminWalletRequests = React.lazy(() => import('../components/AdminWalletRequests'));
const AdminWalletSettings = React.lazy(() => import('../components/AdminWalletSettings'));
const AdminStoreSettings = React.lazy(() => import('../components/AdminStoreSettings'));
const AdminChannels = React.lazy(() => import('../components/AdminChannels'));
const AdminSerials = React.lazy(() => import('../components/AdminSerials'));
const AdminReviews = React.lazy(() => import('../components/AdminReviews'));
const AdminKyc = React.lazy(() => import('../components/AdminKyc'));
const AdminMemberships = React.lazy(() => import('../components/AdminMemberships'));
// What a PREMIUM or a PRO membership is WORTH at a checkout — the rules of
// `membership_benefit_rules`, the simulator that prices a basket through the
// checkout's own functions, and the version history (docs/MEMBERSHIP_BENEFITS.md
// §6, §7). Its own chunk like every other panel: it carries a product picker
// and a taxonomy reader nobody else on this page needs.
const AdminBenefits = React.lazy(() => import('../components/adminBenefits/AdminBenefits'));
const AdminFarmConfig = React.lazy(() => import('../components/adminFarm/AdminFarmConfig'));

/**
 * What a tab shows while its chunk arrives. Deliberately the panel's own empty
 * frame rather than a spinner in the middle of the screen: the sidebar, the
 * title bar and the panel's box are already on screen, so replacing only the
 * contents is what the person actually sees happening.
 */
function PanelFallback({ dir }: { dir: 'rtl' | 'ltr' }) {
  return (
    <div className="py-16 text-center text-sm text-zinc-500" dir={dir}>
      {dir === 'rtl' ? 'جارٍ التحميل…' : 'Loading…'}
    </div>
  );
}

type AdminTab =
  | 'overview'
  | 'orders'
  | 'products'
  | 'bundles'
  | 'mystery'
  | 'mystery_pools'
  | 'offers'
  | 'taxonomy'
  | 'warranties'
  | 'home_settings'
  | 'users'
  | 'wallet_requests'
  | 'wallet_settings'
  | 'store_settings'
  | 'channels'
  | 'ads'
  | 'serials'
  | 'reviews'
  | 'kyc'
  | 'memberships'
  | 'membership_benefits'
  | 'coupons'
  | 'delivery'
  | 'community'
  | 'printer_farm';


export default function Admin() {
  const { t, dir, loc } = useLanguage();
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');

  const section = (id: string, ar: string, en: string, ckb?: string) => ({ section: id, sectionLabel: loc(ar, en, ckb) });
  const sidebarItems = [
    { id: 'overview', icon: LayoutDashboard, label: loc('نظرة عامة', 'Overview', 'پێداچوونەوە'), ...section('operations', 'التشغيل', 'Operations', 'بەڕێوەبردن') },
    { id: 'orders', icon: ClipboardList, label: loc('الطلبات', 'Orders', 'داواکارییەکان'), ...section('operations', 'التشغيل', 'Operations') },
    { id: 'wallet_requests', icon: Bell, label: loc('طلبات المحفظة', 'Wallet requests'), ...section('operations', 'التشغيل', 'Operations') },
    { id: 'products', icon: Package, label: t('adminProducts'), ...section('catalog', 'الكتالوج', 'Catalog', 'کاتالۆگ') },
    { id: 'bundles', icon: Boxes, label: loc('الباقات', 'Bundles'), ...section('catalog', 'الكتالوج', 'Catalog') },
    { id: 'mystery', icon: Dice5, label: loc('العروض العشوائية', 'Mystery offers', 'ئۆفەرە نهێنییەکان'), ...section('catalog', 'الكتالوج', 'Catalog') },
    { id: 'mystery_pools', icon: Layers, label: loc('مجموعات السحب', 'Mystery pools', 'کۆمەڵەکانی هەڵبژاردن'), ...section('catalog', 'الكتالوج', 'Catalog') },
    { id: 'taxonomy', icon: Tag, label: loc('التصنيفات', 'Taxonomy'), ...section('catalog', 'الكتالوج', 'Catalog') },
    { id: 'warranties', icon: ShieldCheck, label: loc('الضمانات', 'Warranties'), ...section('catalog', 'الكتالوج', 'Catalog') },
    { id: 'memberships', icon: Crown, label: loc('الأعضاء والدعم', 'Members & support'), ...section('growth', 'العضويات والتسويق', 'Growth', 'گەشەکردن') },
    { id: 'membership_benefits', icon: BadgePercent, label: loc('مزايا العضوية', 'Membership benefits'), ...section('growth', 'العضويات والتسويق', 'Growth') },
    { id: 'coupons', icon: Ticket, label: loc('أكواد الخصم', 'Promo codes'), ...section('growth', 'العضويات والتسويق', 'Growth') },
    { id: 'offers', icon: PercentIcon, label: loc('العروض الخاصة', 'Special offers', 'ئۆفەرە تایبەتەکان'), ...section('growth', 'العضويات والتسويق', 'Growth') },
    { id: 'ads', icon: Megaphone, label: loc('الإعلانات والنصوص', 'Ads & texts'), ...section('growth', 'العضويات والتسويق', 'Growth') },
    { id: 'users', icon: Users, label: t('adminUsers'), ...section('administration', 'الإدارة', 'Administration', 'بەڕێوەبەرایەتی') },
    { id: 'kyc', icon: ShieldCheck, label: loc('التحقق والعناوين', 'KYC & addresses'), ...section('administration', 'الإدارة', 'Administration') },
    { id: 'serials', icon: Barcode, label: loc('الأجهزة والتسلسلات', 'Serials & devices'), ...section('administration', 'الإدارة', 'Administration') },
    { id: 'reviews', icon: Star, label: loc('المراجعات والهدايا', 'Reviews & gifts'), ...section('administration', 'الإدارة', 'Administration') },
    { id: 'delivery', icon: Truck, label: loc('التوصيل المحلي', 'Local delivery'), ...section('administration', 'الإدارة', 'Administration') },
    { id: 'community', icon: Store, label: loc('مجتمع ليفو', 'Levo Community'), ...section('administration', 'الإدارة', 'Administration') },
    { id: 'printer_farm', icon: Factory, label: loc('مزرعة الطابعات', 'Printer Farm', 'کێڵگەی چاپکەر'), ...section('administration', 'الإدارة', 'Administration') },
    { id: 'home_settings', icon: LayoutList, label: loc('إعدادات الرئيسية', 'Home settings'), ...section('settings', 'الإعدادات', 'Settings', 'ڕێکخستنەکان') },
    { id: 'wallet_settings', icon: Wallet, label: loc('إعدادات المحفظة', 'Wallet settings'), ...section('settings', 'الإعدادات', 'Settings') },
    { id: 'store_settings', icon: Settings, label: loc('إعدادات المتجر', 'Store settings'), ...section('settings', 'الإعدادات', 'Settings') },
    // Not "notification settings" — there is nothing to set here. It answers
    // one question the owner actually has: will an order confirmation reach
    // the customer today, on each of the three channels.
    { id: 'channels', icon: MessageCircle, label: loc('قنوات التواصل', 'Customer channels', 'کەناڵەکانی پەیوەندی'), ...section('settings', 'الإعدادات', 'Settings') },
  ];

  return (
    <DashboardLayout
      title="ADMIN"
      topbarSlot
      sidebarItems={sidebarItems}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as AdminTab)}
    >
      <div className={`max-w-[1280px] mx-auto text-white ${activeTab === 'products' || activeTab === 'overview' || activeTab === 'taxonomy' || activeTab === 'warranties' || activeTab === 'membership_benefits' ? '' : 'bg-zinc-900/50 backdrop-blur-xl border border-zinc-800/50 rounded-2xl p-4 md:p-5 shadow-lg'}`}>
        <React.Suspense fallback={<PanelFallback dir={dir} />}>

        {activeTab === 'overview' && (
          <AdminOverview onNavigateTab={(tab) => setActiveTab(tab as AdminTab)} />
        )}

        {activeTab === 'orders' && (
          <OrdersBoard />
        )}

        {activeTab === 'products' && (
          <AdminProducts />
        )}

        {activeTab === 'bundles' && <AdminBundles />}
        {activeTab === 'mystery' && <AdminMystery />}
        {activeTab === 'mystery_pools' && <AdminMysteryPools />}
        {activeTab === 'offers' && <AdminOffers />}
        {activeTab === 'taxonomy' && <AdminTaxonomy />}
        {activeTab === 'warranties' && <AdminWarranties />}
        {activeTab === 'ads' && (
          <AdminAds />
        )}

        {activeTab === 'home_settings' && (
          <AdminHomeSettings />
        )}

        {activeTab === 'users' && (
          <AdminUsers />
        )}

        {activeTab === 'wallet_requests' && (
           <AdminWalletRequests />
        )}

        {activeTab === 'wallet_settings' && (
           <AdminWalletSettings />
        )}

        {activeTab === 'store_settings' && (
           <AdminStoreSettings />
        )}

        {activeTab === 'channels' && (
           <AdminChannels />
        )}

        {activeTab === 'serials' && (
           <AdminSerials />
        )}

        {activeTab === 'reviews' && (
           <AdminReviews />
        )}

        {activeTab === 'kyc' && (
           <AdminKyc />
        )}

        {activeTab === 'memberships' && (
           <AdminMemberships />
        )}

        {activeTab === 'membership_benefits' && <AdminBenefits />}

        {activeTab === 'coupons' && <AdminCoupons dir={dir} />}

        {activeTab === 'delivery' && <AdminDelivery dir={dir} />}

        {activeTab === 'community' && <AdminCommunity dir={dir} />}

        {activeTab === 'printer_farm' && <AdminFarmConfig />}
        </React.Suspense>
      </div>
    </DashboardLayout>
  );
}
