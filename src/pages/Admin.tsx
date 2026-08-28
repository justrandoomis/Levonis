import React, { useState } from 'react';
import { useLanguage } from '../LanguageContext';

import { Settings, Package, LayoutList, Users, Plus, Edit2, Trash2, Wallet, Check, X, Bell, LayoutDashboard } from 'lucide-react';
import { useWallet } from '../WalletContext';
import { queryDb } from '../lib/db';
import { useEffect } from 'react';
import AdminProducts from '../components/AdminProducts';
import AdminAds from '../components/AdminAds';
import AdminHomeSettings from '../components/AdminHomeSettings';
import AdminOverview from '../components/AdminOverview';
import AdminUsers from '../components/AdminUsers';
import AdminWalletRequests from '../components/AdminWalletRequests';
import AdminWalletSettings from '../components/AdminWalletSettings';
import { Megaphone } from 'lucide-react';
import AdminStoreSettings from '../components/AdminStoreSettings';
import DashboardLayout from '../components/DashboardLayout';

export default function Admin() {
  const { t, dir } = useLanguage();
  const [activeTab, setActiveTab] = useState<'overview' | 'products' | 'sections' | 'users' | 'wallet_requests' | 'wallet_settings' | 'store_settings' | 'ads'>('overview');

  const sidebarItems = [
    { id: 'overview', icon: LayoutDashboard, label: dir === 'rtl' ? 'نظرة عامة' : 'Overview' },
    { id: 'wallet_requests', icon: Bell, label: 'Wallet Requests' },
    { id: 'products', icon: Package, label: t('adminProducts') },
    { id: 'home_settings', icon: LayoutList, label: dir === 'rtl' ? 'اعدادات الرئيسية' : 'Home Settings' },
    { id: 'users', icon: Users, label: t('adminUsers') },
    { id: 'wallet_settings', icon: Wallet, label: 'Wallet Settings' },
    { id: 'store_settings', icon: Settings, label: 'Store Settings' },
    { id: 'ads', icon: Megaphone, label: 'Ads & Texts' }
  ];

  return (
    <DashboardLayout 
      title="ADMIN"
      sidebarItems={sidebarItems}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as any)}
    >
      <div className={`max-w-[1280px] mx-auto text-white ${activeTab === 'products' || activeTab === 'overview' ? '' : 'bg-zinc-900/50 backdrop-blur-xl border border-zinc-800/50 rounded-3xl p-6 md:p-8 shadow-lg'}`}>
        
        {activeTab === 'overview' && (
          <AdminOverview onNavigateTab={(tab) => setActiveTab(tab as any)} />
        )}

        {activeTab === 'products' && (
          <AdminProducts />
        )}
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
      </div>
    </DashboardLayout>
  );
}
