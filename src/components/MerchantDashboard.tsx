import React, { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import DashboardLayout from './DashboardLayout';
import { Home, ShoppingBag, ListOrdered, Settings, User, Save, Plus, X, Edit, Trash2, Store, Users, Package, Image as ImageIcon, Check, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { followStoreHref, useCommunityStoreHref } from '../pages/community/access';
import { api, ApiError, uploadFile, formatIqd } from '../lib/api';

interface Merchant {
  id: string;
  name: string;
  bio: string;
  avatarUrl: string | null;
  verified: boolean;
  created_at: string;
}

interface CommunityProduct {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  description: string;
  images: string[];
  price_iqd: number;
  original_price_iqd: number | null;
  created_at: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function MerchantDashboard() {
  const { dir } = useLanguage();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('overview');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [products, setProducts] = useState<CommunityProduct[]>([]);
  const [followers, setFollowers] = useState<number | null>(null);
  // The in-site store page is behind the community wall: while it is shut to
  // this merchant, «زيارة الصفحة» goes to the store's own site (or is hidden).
  const storeHref = useCommunityStoreHref(merchant?.id);

  // Store setup / edit form
  const [storeName, setStoreName] = useState('');
  const [storeBio, setStoreBio] = useState('');
  const [storeSaveState, setStoreSaveState] = useState<SaveState>('idle');
  const [storeSaveError, setStoreSaveError] = useState<string | null>(null);

  // Add-product form (controlled)
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [newName, setNewName] = useState('');
  const [newNameAr, setNewNameAr] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newImage, setNewImage] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [productSaveState, setProductSaveState] = useState<SaveState>('idle');
  const [productSaveError, setProductSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadStore = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<{ merchant: Merchant | null; products: CommunityProduct[] }>('/api/community/my-store');
      setMerchant(data.merchant);
      setProducts(data.products);
      if (data.merchant) {
        setStoreName(data.merchant.name);
        setStoreBio(data.merchant.bio || '');
        try {
          const storeData = await api.get<{ followers: number }>(`/api/community/store/${data.merchant.id}`);
          setFollowers(storeData.followers);
        } catch {
          setFollowers(null);
        }
      }
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Failed to load your store');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStore();
  }, [loadStore]);

  const saveStore = async () => {
    if (storeSaveState === 'saving') return;
    setStoreSaveState('saving');
    setStoreSaveError(null);
    try {
      await api.post('/api/community/my-store', { name: storeName.trim(), bio: storeBio.trim() });
      setStoreSaveState('saved');
      await loadStore();
    } catch (e) {
      setStoreSaveState('error');
      setStoreSaveError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const addProduct = async () => {
    if (productSaveState === 'saving') return;
    const price = parseInt(newPrice, 10);
    if (!newName.trim() || !Number.isFinite(price) || price < 0) {
      setProductSaveState('error');
      setProductSaveError(dir === 'rtl' ? 'أدخل اسم المنتج وسعراً صحيحاً بالدينار' : 'Enter a product name and a valid IQD price');
      return;
    }
    setProductSaveState('saving');
    setProductSaveError(null);
    try {
      await api.post('/api/community/my-store/products', {
        name: newName.trim(),
        name_ar: newNameAr.trim() || undefined,
        price_iqd: price,
        images: newImage ? [newImage] : [],
      });
      setProductSaveState('idle');
      setShowAddProduct(false);
      setNewName('');
      setNewNameAr('');
      setNewPrice('');
      setNewImage('');
      await loadStore();
    } catch (e) {
      setProductSaveState('error');
      setProductSaveError(e instanceof ApiError ? e.message : 'Failed to add the product');
    }
  };

  const deleteProduct = async (p: CommunityProduct) => {
    if (deletingId) return;
    if (!window.confirm(dir === 'rtl' ? `حذف المنتج "${p.name_ar || p.name}"؟` : `Delete product "${p.name}"? This cannot be undone.`)) return;
    setDeletingId(p.id);
    try {
      await api.delete(`/api/community/my-store/products/${p.id}`);
      await loadStore();
    } catch (e) {
      alert((dir === 'rtl' ? 'فشل الحذف: ' : 'Delete failed: ') + (e instanceof ApiError ? e.message : 'unknown error'));
    } finally {
      setDeletingId(null);
    }
  };

  const sidebarItems = [
    { id: 'overview', icon: Home, label: dir === 'rtl' ? 'نظرة عامة' : 'Overview' },
    { id: 'store_page', icon: User, label: dir === 'rtl' ? 'صفحة المتجر' : 'Store Page' },
    { id: 'products', icon: ShoppingBag, label: dir === 'rtl' ? 'المنتجات' : 'Products' },
    { id: 'orders', icon: ListOrdered, label: dir === 'rtl' ? 'الطلبات' : 'Orders' },
    { id: 'settings', icon: Settings, label: dir === 'rtl' ? 'الإعدادات' : 'Settings' },
  ];

  const SoftCard = ({ children, className = "", onClick }: { children: React.ReactNode, className?: string, onClick?: () => void }) => (
    <div onClick={onClick} className={`bg-zinc-900/90 rounded-[24px] shadow-[0_10px_30px_rgba(0,0,0,0.2)] border border-zinc-800/50 p-6 ${className}`}>
      {children}
    </div>
  );

  // ------------------------------------------------ loading & setup states

  if (loading) {
    return (
      <DashboardLayout sidebarItems={sidebarItems} activeTab={activeTab} onTabChange={setActiveTab}>
        <div className="text-center text-zinc-500 py-24">{dir === 'rtl' ? 'جارٍ تحميل متجرك...' : 'Loading your store...'}</div>
      </DashboardLayout>
    );
  }

  if (!merchant) {
    // No store yet → real setup form.
    return (
      <DashboardLayout sidebarItems={sidebarItems} activeTab={activeTab} onTabChange={setActiveTab}>
        <div className="max-w-xl mx-auto mt-10">
          {loadError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 mb-6 text-sm font-medium">
              {loadError}
            </div>
          )}
          <SoftCard>
            <div className="flex flex-col items-center text-center mb-6">
              <div className="w-16 h-16 rounded-2xl bg-[#708238]/15 flex items-center justify-center mb-4">
                <Store className="w-8 h-8 text-[#708238]" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">
                {dir === 'rtl' ? 'أنشئ متجرك في مجتمع ليفو' : 'Set up your Levo Community store'}
              </h2>
              <p className="text-sm text-zinc-400">
                {dir === 'rtl' ? 'أدخل اسم متجرك ووصفاً قصيراً للبدء.' : 'Enter a store name and a short bio to get started.'}
              </p>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-2">{dir === 'rtl' ? 'اسم المتجر' : 'Store Name'}</label>
                <input
                  type="text"
                  value={storeName}
                  onChange={e => { setStoreName(e.target.value); setStoreSaveState('idle'); }}
                  placeholder={dir === 'rtl' ? 'مثال: متجر ليفو' : 'e.g. My Levo Shop'}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-2">{dir === 'rtl' ? 'وصف المتجر' : 'Store Bio'}</label>
                <textarea
                  value={storeBio}
                  onChange={e => { setStoreBio(e.target.value); setStoreSaveState('idle'); }}
                  rows={3}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
              {storeSaveState === 'error' && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm font-medium">
                  {storeSaveError}
                </div>
              )}
              <button
                onClick={saveStore}
                disabled={storeSaveState === 'saving' || !storeName.trim()}
                className="w-full flex items-center justify-center gap-2 bg-[#708238] hover:bg-[#859846] text-white px-6 py-3 rounded-xl font-bold transition-colors disabled:opacity-50"
              >
                <Store className="w-4 h-4" />
                {storeSaveState === 'saving' ? (dir === 'rtl' ? 'جارٍ الإنشاء...' : 'Creating...') : dir === 'rtl' ? 'إنشاء المتجر' : 'Create Store'}
              </button>
            </div>
          </SoftCard>
        </div>
      </DashboardLayout>
    );
  }

  // ------------------------------------------------ main dashboard

  return (
    <DashboardLayout
      sidebarItems={sidebarItems}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 mb-6 text-sm font-medium max-w-3xl">
          {loadError}
        </div>
      )}

      {activeTab === 'overview' && (
        <div className="w-full pb-6 max-w-[1000px] mx-auto space-y-6">
          {/* Real, simple counts — no fabricated KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <SoftCard className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-[#708238]/15 flex items-center justify-center shrink-0">
                <Package className="w-6 h-6 text-[#708238]" />
              </div>
              <div>
                <div className="text-zinc-400 text-[11px] font-semibold mb-1">{dir === 'rtl' ? 'المنتجات' : 'Products'}</div>
                <div className="text-2xl font-black text-white">{products.length}</div>
              </div>
            </SoftCard>
            <SoftCard className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-[#D4AF37]/15 flex items-center justify-center shrink-0">
                <Users className="w-6 h-6 text-[#D4AF37]" />
              </div>
              <div>
                <div className="text-zinc-400 text-[11px] font-semibold mb-1">{dir === 'rtl' ? 'المتابعون' : 'Followers'}</div>
                <div className="text-2xl font-black text-white">{followers === null ? '—' : followers}</div>
              </div>
            </SoftCard>
            <SoftCard className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-zinc-800 flex items-center justify-center shrink-0">
                <Store className="w-6 h-6 text-zinc-400" />
              </div>
              <div>
                <div className="text-zinc-400 text-[11px] font-semibold mb-1">{dir === 'rtl' ? 'تاريخ الإنشاء' : 'Store Since'}</div>
                <div className="text-lg font-black text-white">
                  {merchant.created_at ? new Date(merchant.created_at).toLocaleDateString() : '—'}
                </div>
              </div>
            </SoftCard>
          </div>

          {/* Honest placeholder — no sales analytics backend for merchants yet */}
          <SoftCard>
            <h3 className="text-lg font-bold text-white mb-2">{dir === 'rtl' ? 'المبيعات والإحصائيات' : 'Sales & Analytics'}</h3>
            <p className="text-sm text-zinc-400">
              {dir === 'rtl'
                ? 'لا تتوفر إحصائيات مبيعات بعد — ستظهر هنا عندما تبدأ طلبات متجرك.'
                : 'No sales data yet — analytics will appear here once your store starts receiving orders.'}
            </p>
          </SoftCard>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <SoftCard className="cursor-pointer hover:bg-zinc-800/70 transition-colors" onClick={() => setActiveTab('products')}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-white">{dir === 'rtl' ? 'إدارة المنتجات' : 'Manage Products'}</div>
                  <div className="text-xs text-zinc-500 mt-1">{dir === 'rtl' ? 'إضافة وحذف منتجات متجرك' : 'Add and remove your store products'}</div>
                </div>
                <ShoppingBag className="w-6 h-6 text-[#708238]" />
              </div>
            </SoftCard>
            {storeHref && (
            <SoftCard className="cursor-pointer hover:bg-zinc-800/70 transition-colors" onClick={() => followStoreHref(storeHref, navigate)}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-white">{dir === 'rtl' ? 'زيارة صفحة المتجر' : 'Visit Store Page'}</div>
                  <div className="text-xs text-zinc-500 mt-1">{dir === 'rtl' ? 'شاهد متجرك كما يراه الزوار' : 'See your store as visitors do'}</div>
                </div>
                <Store className="w-6 h-6 text-[#D4AF37]" />
              </div>
            </SoftCard>
            )}
          </div>
        </div>
      )}

      {/* STORE PAGE CONTROL TAB */}
      {activeTab === 'store_page' && (
        <div className="mt-6 max-w-3xl">
          <h2 className="text-2xl font-bold text-white mb-6">{dir === 'rtl' ? 'التحكم بصفحة المتجر في ليفو' : 'Control Levo Store Page'}</h2>

          <div className="space-y-6">
            <SoftCard>
              <h3 className="text-lg font-bold text-white mb-4">{dir === 'rtl' ? 'المعلومات الأساسية' : 'Basic Info'}</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-zinc-400 mb-2">{dir === 'rtl' ? 'اسم المتجر' : 'Store Name'}</label>
                  <input
                    type="text"
                    value={storeName}
                    onChange={e => { setStoreName(e.target.value); setStoreSaveState('idle'); }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-2">{dir === 'rtl' ? 'وصف المتجر' : 'Store Bio'}</label>
                  <textarea
                    value={storeBio}
                    onChange={e => { setStoreBio(e.target.value); setStoreSaveState('idle'); }}
                    rows={3}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#D4AF37]"
                  ></textarea>
                </div>
                {storeSaveState === 'error' && (
                  <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm font-medium">
                    {storeSaveError}
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <button
                    onClick={saveStore}
                    disabled={storeSaveState === 'saving' || !storeName.trim()}
                    className="flex items-center gap-2 bg-[#708238] hover:bg-[#859846] text-white px-6 py-3 rounded-xl font-bold transition-colors disabled:opacity-50"
                  >
                    <Save className="w-4 h-4" />
                    {storeSaveState === 'saving' ? (dir === 'rtl' ? 'جارٍ الحفظ...' : 'Saving...') : dir === 'rtl' ? 'حفظ التغييرات' : 'Save Changes'}
                  </button>
                  {storeSaveState === 'saved' && (
                    <span className="text-sm font-bold text-[#2CE59B] flex items-center gap-1">
                      <Check className="w-4 h-4" /> {dir === 'rtl' ? 'تم الحفظ' : 'Saved'}
                    </span>
                  )}
                </div>
              </div>
            </SoftCard>

            <SoftCard>
              <h3 className="text-lg font-bold text-white mb-4">{dir === 'rtl' ? 'رابط الصفحة' : 'Page Link'}</h3>
              <p className="text-sm text-zinc-400 mb-4">{dir === 'rtl' ? 'هذا هو الرابط الخاص بمتجرك في مجتمع ليفو' : 'This is your store link in the Levo community'}</p>
              <div className="flex items-center gap-4 flex-wrap sm:flex-nowrap">
                <code className="w-full sm:flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-[#D4AF37] text-sm overflow-x-auto" dir="ltr">
                  {storeHref ?? `/community/store/${merchant.id}`}
                </code>
                {storeHref && (
                <button onClick={() => followStoreHref(storeHref, navigate)} className="w-full sm:w-auto bg-zinc-800 hover:bg-zinc-700 text-white px-6 py-3 rounded-xl font-bold transition-colors whitespace-nowrap">
                  {dir === 'rtl' ? 'زيارة الصفحة' : 'Visit Page'}
                </button>
                )}
              </div>
            </SoftCard>
          </div>
        </div>
      )}

      {/* PRODUCTS TAB */}
      {activeTab === 'products' && (
        <div className="mt-6 max-w-5xl">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-white">{dir === 'rtl' ? 'إدارة المنتجات' : 'Manage Products'}</h2>
            <button onClick={() => setShowAddProduct(true)} className="bg-[#D4AF37] hover:bg-[#ebd074] transition-colors text-[#0a0a0a] px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2">
              <Plus className="w-4 h-4" /> {dir === 'rtl' ? 'إضافة منتج' : 'Add Product'}
            </button>
          </div>

          {showAddProduct && (
            <SoftCard className="mb-6 border-[#D4AF37]">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-bold text-white">{dir === 'rtl' ? 'إضافة منتج جديد' : 'Add New Product'}</h3>
                <button onClick={() => setShowAddProduct(false)} className="text-zinc-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm text-zinc-400 mb-2">{dir === 'rtl' ? 'اسم المنتج' : 'Product Name'}</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={e => { setNewName(e.target.value); setProductSaveState('idle'); }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-[#D4AF37]"
                    placeholder="e.g. Vintage T-Shirt"
                  />
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-2">{dir === 'rtl' ? 'اسم المنتج (عربي، اختياري)' : 'Product Name (Arabic, optional)'}</label>
                  <input
                    type="text"
                    value={newNameAr}
                    onChange={e => setNewNameAr(e.target.value)}
                    dir="rtl"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-[#D4AF37]"
                    placeholder="اسم المنتج"
                  />
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-2">{dir === 'rtl' ? 'السعر (دينار عراقي)' : 'Price (IQD)'}</label>
                  <input
                    type="number"
                    value={newPrice}
                    onChange={e => { setNewPrice(e.target.value); setProductSaveState('idle'); }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-[#D4AF37]"
                    placeholder="25000"
                    min={0}
                  />
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-2">{dir === 'rtl' ? 'صورة المنتج (اختياري)' : 'Product Image (optional)'}</label>
                  <div className="flex items-center gap-3">
                    {newImage ? (
                      <img src={newImage} className="w-12 h-12 rounded-lg object-cover border border-zinc-700" alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center">
                        <ImageIcon className="w-5 h-5 text-zinc-600" />
                      </div>
                    )}
                    <label className={`flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl cursor-pointer transition-colors border border-zinc-700 text-sm font-bold ${uploadingImage ? 'opacity-50 pointer-events-none' : ''}`}>
                      <Plus className="w-4 h-4" />
                      {uploadingImage ? (dir === 'rtl' ? 'جارٍ الرفع...' : 'Uploading...') : dir === 'rtl' ? 'رفع صورة' : 'Upload Image'}
                      <input type="file" className="hidden" accept="image/*" onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setUploadingImage(true);
                        try {
                          const result = await uploadFile(file, 'community');
                          setNewImage(result.url);
                        } catch (err) {
                          setProductSaveState('error');
                          setProductSaveError(err instanceof ApiError ? err.message : 'Upload failed');
                        } finally {
                          setUploadingImage(false);
                        }
                      }} />
                    </label>
                  </div>
                </div>
              </div>
              {productSaveState === 'error' && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm font-medium mb-4">
                  {productSaveError}
                </div>
              )}
              <button
                onClick={addProduct}
                disabled={productSaveState === 'saving' || uploadingImage}
                className="bg-[#708238] hover:bg-[#859846] text-white px-6 py-2 rounded-xl font-bold transition-colors disabled:opacity-50"
              >
                {productSaveState === 'saving' ? (dir === 'rtl' ? 'جارٍ الحفظ...' : 'Saving...') : dir === 'rtl' ? 'حفظ المنتج' : 'Save Product'}
              </button>
            </SoftCard>
          )}

          <div className="space-y-4">
            {products.length === 0 ? (
              <SoftCard>
                <div className="text-zinc-400 text-center py-10">
                  {dir === 'rtl' ? 'لا توجد منتجات حالياً' : 'No products found'}
                </div>
              </SoftCard>
            ) : (
              <div className="bg-zinc-900/90 rounded-[24px] border border-zinc-800/50 overflow-hidden overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[600px]">
                  <thead>
                    <tr className="bg-zinc-800/50 text-zinc-400 text-sm border-b border-zinc-800">
                      <th className={`p-4 font-semibold ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>{dir === 'rtl' ? 'المنتج' : 'Product'}</th>
                      <th className={`p-4 font-semibold ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>{dir === 'rtl' ? 'السعر' : 'Price'}</th>
                      <th className={`p-4 font-semibold ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>{dir === 'rtl' ? 'تاريخ الإضافة' : 'Added'}</th>
                      <th className={`p-4 font-semibold ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>{dir === 'rtl' ? 'إجراءات' : 'Actions'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map(product => (
                      <tr key={product.id} className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30 transition-colors">
                        <td className={`p-4 ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>
                          <div className="flex items-center gap-3">
                            {product.images?.[0] ? (
                              <img src={product.images[0]} className="w-10 h-10 rounded-lg object-cover border border-zinc-700" alt="" referrerPolicy="no-referrer" />
                            ) : (
                              <div className="w-10 h-10 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center">
                                <ImageIcon className="w-4 h-4 text-zinc-600" />
                              </div>
                            )}
                            <span className="text-white font-medium">{dir === 'rtl' && product.name_ar ? product.name_ar : product.name}</span>
                          </div>
                        </td>
                        <td className={`p-4 text-white font-medium whitespace-nowrap ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>{formatIqd(product.price_iqd)}</td>
                        <td className={`p-4 text-zinc-400 font-medium whitespace-nowrap ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>
                          {product.created_at ? new Date(product.created_at).toLocaleDateString() : '—'}
                        </td>
                        <td className="p-4">
                          <div className="flex gap-2">
                            <button
                              disabled
                              title={dir === 'rtl' ? 'قريباً — التعديل غير متاح بعد' : 'Coming soon — editing is not available yet'}
                              className="p-2 bg-zinc-800 text-zinc-600 rounded-lg cursor-not-allowed"
                            >
                              <Edit className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => deleteProduct(product)}
                              disabled={deletingId === product.id}
                              className="p-2 bg-zinc-800 text-zinc-300 hover:text-red-400 rounded-lg transition-colors disabled:opacity-50"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ORDERS TAB — no merchant-order backend exists yet, honest empty state */}
      {activeTab === 'orders' && (
        <div className="mt-6 max-w-5xl">
          <h2 className="text-2xl font-bold text-white mb-6">{dir === 'rtl' ? 'الطلبات' : 'Orders'}</h2>
          <SoftCard>
            <div className="flex flex-col items-center text-center py-12">
              <div className="w-14 h-14 rounded-2xl bg-zinc-800 flex items-center justify-center mb-4">
                <ListOrdered className="w-7 h-7 text-zinc-500" />
              </div>
              <div className="text-white font-bold mb-1">
                {dir === 'rtl' ? 'لا توجد طلبات بعد' : 'No orders yet'}
              </div>
              <p className="text-sm text-zinc-400 max-w-sm">
                {dir === 'rtl'
                  ? 'ستظهر طلبات متجرك هنا عند توفرها.'
                  : 'Orders from your store will appear here.'}
              </p>
            </div>
          </SoftCard>
        </div>
      )}

      {/* SETTINGS TAB */}
      {activeTab === 'settings' && (
        <div className="mt-6 max-w-3xl">
          <h2 className="text-2xl font-bold text-white mb-6">{dir === 'rtl' ? 'الإعدادات' : 'Settings'}</h2>
          <SoftCard>
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-bold text-white mb-1">{dir === 'rtl' ? 'إعدادات الإشعارات' : 'Notification Settings'}</h3>
                <p className="text-sm text-zinc-400 mb-4 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
                  {dir === 'rtl'
                    ? 'إعدادات الإشعارات غير متاحة بعد — ستُفعَّل قريباً.'
                    : 'Notification preferences are not available yet — coming soon.'}
                </p>
                <div className="space-y-3 opacity-50">
                  <label className="flex items-center gap-3 cursor-not-allowed">
                    <input type="checkbox" disabled className="w-5 h-5 rounded border-zinc-700 bg-zinc-800 accent-[#D4AF37]" />
                    <span className="text-zinc-300">{dir === 'rtl' ? 'إشعارات الطلبات الجديدة' : 'New order notifications'}</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-not-allowed">
                    <input type="checkbox" disabled className="w-5 h-5 rounded border-zinc-700 bg-zinc-800 accent-[#D4AF37]" />
                    <span className="text-zinc-300">{dir === 'rtl' ? 'إشعارات مجتمع ليفو' : 'Levo Community notifications'}</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-not-allowed">
                    <input type="checkbox" disabled className="w-5 h-5 rounded border-zinc-700 bg-zinc-800 accent-[#D4AF37]" />
                    <span className="text-zinc-300">{dir === 'rtl' ? 'رسائل البريد الإلكتروني الترويجية' : 'Promotional emails'}</span>
                  </label>
                </div>
              </div>
            </div>
          </SoftCard>
        </div>
      )}
    </DashboardLayout>
  );
}
