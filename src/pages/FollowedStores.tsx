import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowLeft, ArrowRight, Store, Star } from 'lucide-react';

export default function FollowedStores() {
  const navigate = useNavigate();
  const { dir } = useLanguage();
  const [stores, setStores] = useState<any[]>([]);

  useEffect(() => {
    const followedStores = JSON.parse(localStorage.getItem('followed_stores') || '[]');
    setStores(followedStores);
  }, []);

  return (
    <div className="w-full min-h-screen bg-black text-white font-sans">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="font-bold text-lg">{dir === 'rtl' ? 'متاجري' : 'My Stores'}</h1>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {stores.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
            <Store className="w-16 h-16 mb-4 opacity-50" />
            <p>{dir === 'rtl' ? 'لا توجد متاجر تمت متابعتها' : 'No followed stores yet'}</p>
          </div>
        ) : (
          stores.map((store, i) => (
            <div 
              key={i} 
              onClick={() => navigate(`/community/store/${store.id}`)}
              className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 flex items-center gap-4 cursor-pointer hover:bg-zinc-800/50 transition-colors"
            >
              <img referrerPolicy="no-referrer" src={store.avatar || undefined} alt={store.name} className="w-12 h-12 rounded-full object-cover" />
              <div className="flex-1">
                <h3 className="font-bold">{store.name}</h3>
                <div className="text-sm text-zinc-400">{store.username}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
