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
    return <div className="text-center text-text-muted py-16">{dir === 'rtl' ? 'جارٍ التحميل...' : 'Loading...'}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center mb-6 gap-4 flex-wrap">
        <h2 className="text-2xl font-black text-text-primary">
          {dir === 'rtl' ? 'إدارة الإعلانات / النصوص المتحركة' : 'Manage Ads / Animated Texts'}
        </h2>
        <div className="flex items-center gap-3">
          {saveState === 'saved' && (
            <span className="text-xs font-bold text-success flex items-center gap-1">
              <Check className="w-3.5 h-3.5" /> {dir === 'rtl' ? 'تم الحفظ' : 'Saved'}
            </span>
          )}
          {saveState === 'error' && (
            <span className="text-xs font-bold text-danger flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> {saveError || (dir === 'rtl' ? 'فشل الحفظ' : 'Save failed')}
            </span>
          )}
          <button onClick={addAd} className="lv-button lv-button-secondary">
            <Plus className="w-4 h-4" /> {dir === 'rtl' ? 'إضافة نص' : 'Add Text'}
          </button>
          <button
            onClick={handleSave}
            disabled={saveState === 'saving'}
            className="lv-button lv-button-primary"
          >
            <Save className="w-4 h-4" /> {saveState === 'saving' ? (dir === 'rtl' ? 'جارٍ الحفظ...' : 'Saving...') : dir === 'rtl' ? 'حفظ' : 'Save'}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="lv-alert lv-alert-danger text-sm font-medium text-text-primary">
          {loadError}
        </div>
      )}

      <div className="lv-surface p-6">
        <h3 className="text-lg font-bold mb-4 text-text-secondary">
          {dir === 'rtl' ? 'النصوص الحالية (تظهر في الرئيسية)' : 'Current texts (shown on the home page)'}
        </h3>
        <div className="space-y-4">
          {ads.map((ad, index) => (
            <div key={ad.id} className="flex items-center gap-4 rounded-lg bg-surface-raised p-4">
              <span className="text-text-muted font-bold">{index + 1}.</span>
              <input
                className="lv-input flex-1"
                type="text"
                value={ad.text}
                onChange={(e) => updateAd(ad.id, 'text', e.target.value)}
                placeholder={dir === 'rtl' ? 'النص...' : 'Text...'}
              />
              <select
                className="lv-input w-auto"
                value={ad.animation}
                onChange={(e) => updateAd(ad.id, 'animation', e.target.value)}
              >
                <option value="true_focus">True Focus</option>
              </select>
              <button onClick={() => deleteAd(ad.id)} className="lv-button lv-button-ghost px-2.5 hover:text-danger">
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          ))}
          {ads.length === 0 && (
            <div className="text-text-muted text-center py-4">
              {dir === 'rtl' ? 'لا توجد نصوص. أضف نصاً جديداً.' : 'No texts yet. Add a new one.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
