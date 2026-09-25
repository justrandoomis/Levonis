import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Save, Check, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../LanguageContext';

interface HomeAd {
  id: string;
  text: string;
  animation: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function AdminAds() {
  const { dir } = useLanguage();
  const [ads, setAds] = useState<HomeAd[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await api.get<{ settings: { homeAds: HomeAd[] } }>('/api/admin/settings');
        if (!cancelled) setAds(Array.isArray(data.settings.homeAds) ? data.settings.homeAds : []);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof ApiError ? e.message : 'Failed to load ads');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setSaveState('saving');
    setSaveError(null);
    try {
      await api.put('/api/admin/settings/homeAds', { value: ads });
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      setSaveError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const addAd = () => {
    setAds([...ads, { id: 'ad_' + Date.now(), text: 'New Text', animation: 'true_focus' }]);
    setSaveState('idle');
  };

  const updateAd = (id: string, field: 'text' | 'animation', value: string) => {
    setAds(ads.map(ad => ad.id === id ? { ...ad, [field]: value } : ad));
    setSaveState('idle');
  };

  const deleteAd = (id: string) => {
    if (!window.confirm(dir === 'rtl' ? 'حذف هذا النص؟' : 'Delete this text?')) return;
    setAds(ads.filter(ad => ad.id !== id));
    setSaveState('idle');
  };

  if (loading) {
    return <div className="text-center text-zinc-500 py-16">{dir === 'rtl' ? 'جارٍ التحميل...' : 'Loading...'}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center mb-6 gap-4 flex-wrap">
        <h2 className="text-2xl font-black text-white">
          {dir === 'rtl' ? 'إدارة الإعلانات / النصوص المتحركة' : 'Manage Ads / Animated Texts'}
        </h2>
        <div className="flex items-center gap-3">
          {saveState === 'saved' && (
            <span className="text-xs font-bold text-mint flex items-center gap-1">
              <Check className="w-3.5 h-3.5" /> {dir === 'rtl' ? 'تم الحفظ' : 'Saved'}
            </span>
          )}
          {saveState === 'error' && (
            <span className="text-xs font-bold text-red-400 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> {saveError || (dir === 'rtl' ? 'فشل الحفظ' : 'Save failed')}
            </span>
          )}
          <button onClick={addAd} className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-5 py-2.5 rounded-full transition-all font-bold">
            <Plus className="w-4 h-4" /> {dir === 'rtl' ? 'إضافة نص' : 'Add Text'}
          </button>
          <button
            onClick={handleSave}
            disabled={saveState === 'saving'}
            className="flex items-center gap-2 bg-[#6B46FF] hover:bg-iris-deep text-snow px-5 py-2.5 rounded-full transition-all font-bold shadow-[0_4px_12px_rgba(107,70,255,0.4)] hover:scale-105 disabled:opacity-50 disabled:hover:scale-100"
          >
            <Save className="w-4 h-4" /> {saveState === 'saving' ? (dir === 'rtl' ? 'جارٍ الحفظ...' : 'Saving...') : dir === 'rtl' ? 'حفظ' : 'Save'}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 text-sm font-medium">
          {loadError}
        </div>
      )}

      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6">
        <h3 className="text-lg font-bold mb-4 text-zinc-300">
          {dir === 'rtl' ? 'النصوص الحالية (تظهر في الرئيسية)' : 'Current texts (shown on the home page)'}
        </h3>
        <div className="space-y-4">
          {ads.map((ad, index) => (
            <div key={ad.id} className="flex items-center gap-4 bg-zinc-800 p-4 rounded-xl">
              <span className="text-zinc-500 font-bold">{index + 1}.</span>
              <input
                type="text"
                value={ad.text}
                onChange={(e) => updateAd(ad.id, 'text', e.target.value)}
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 text-white focus:border-iris outline-none"
                placeholder={dir === 'rtl' ? 'النص...' : 'Text...'}
              />
              <select
                value={ad.animation}
                onChange={(e) => updateAd(ad.id, 'animation', e.target.value)}
                className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 text-white focus:border-iris outline-none"
              >
                <option value="true_focus">True Focus</option>
              </select>
              <button onClick={() => deleteAd(ad.id)} className="p-2 text-zinc-400 hover:text-red-500 transition-colors">
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          ))}
          {ads.length === 0 && (
            <div className="text-zinc-500 text-center py-4">
              {dir === 'rtl' ? 'لا توجد نصوص. أضف نصاً جديداً.' : 'No texts yet. Add a new one.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
