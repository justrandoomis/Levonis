import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Save } from 'lucide-react';

export default function AdminAds() {
  const [ads, setAds] = useState<{ id: string; text: string; animation: string }[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem('levo_home_ads');
    if (saved) {
      setAds(JSON.parse(saved));
    } else {
      setAds([
        { id: '1', text: 'premium', animation: 'true_focus' },
        { id: '2', text: 'delivery', animation: 'true_focus' },
        { id: '3', text: 'pick-up', animation: 'true_focus' }
      ]);
    }
  }, []);

  const handleSave = () => {
    localStorage.setItem('levo_home_ads', JSON.stringify(ads));
    alert('تم الحفظ بنجاح');
  };

  const addAd = () => {
    setAds([...ads, { id: Date.now().toString(), text: 'New Text', animation: 'true_focus' }]);
  };

  const updateAd = (id: string, field: string, value: string) => {
    setAds(ads.map(ad => ad.id === id ? { ...ad, [field]: value } : ad));
  };

  const deleteAd = (id: string) => {
    setAds(ads.filter(ad => ad.id !== id));
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-black text-white">إدارة الإعلانات / النصوص المتحركة</h2>
        <div className="flex gap-2">
          <button onClick={addAd} className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-5 py-2.5 rounded-full transition-all font-bold">
            <Plus className="w-4 h-4" /> إضافة نص
          </button>
          <button onClick={handleSave} className="flex items-center gap-2 bg-[#6B46FF] hover:bg-[#5A38E6] text-white px-5 py-2.5 rounded-full transition-all font-bold shadow-[0_4px_12px_rgba(107,70,255,0.4)] hover:scale-105">
            <Save className="w-4 h-4" /> حفظ
          </button>
        </div>
      </div>

      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6">
        <h3 className="text-lg font-bold mb-4 text-zinc-300">النصوص الحالية (تظهر في الرئيسية)</h3>
        <div className="space-y-4">
          {ads.map((ad, index) => (
            <div key={ad.id} className="flex items-center gap-4 bg-zinc-800 p-4 rounded-xl">
              <span className="text-zinc-500 font-bold">{index + 1}.</span>
              <input
                type="text"
                value={ad.text}
                onChange={(e) => updateAd(ad.id, 'text', e.target.value)}
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 text-white focus:border-[#6B46FF] outline-none"
                placeholder="النص..."
              />
              <select
                value={ad.animation}
                onChange={(e) => updateAd(ad.id, 'animation', e.target.value)}
                className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 text-white focus:border-[#6B46FF] outline-none"
              >
                <option value="true_focus">True Focus</option>
              </select>
              <button onClick={() => deleteAd(ad.id)} className="p-2 text-zinc-400 hover:text-red-500 transition-colors">
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          ))}
          {ads.length === 0 && (
            <div className="text-zinc-500 text-center py-4">لا توجد نصوص. أضف نصاً جديداً.</div>
          )}
        </div>
      </div>
    </div>
  );
}
