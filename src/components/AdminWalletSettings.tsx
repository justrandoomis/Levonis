import React, { useState } from 'react';
import { useWallet } from '../WalletContext';
import { Check, Edit2, Plus, Trash2, Video, DollarSign, CreditCard } from 'lucide-react';

export default function AdminWalletSettings() {
  const { exchangeRate, setExchangeRate, adVideoUrl, setAdVideoUrl, paymentMethods, updatePaymentMethods } = useWallet();
  const [methods, setMethods] = useState(paymentMethods || []);
  const [editingMethodId, setEditingMethodId] = useState<string | null>(null);

  const handleUpdateMethod = (id: string, field: 'name' | 'details' | 'type', value: string) => {
    const newMethods = methods.map(m => m.id === id ? { ...m, [field]: value } : m);
    setMethods(newMethods);
  };

  const handleSaveMethods = () => {
    updatePaymentMethods(methods);
    setEditingMethodId(null);
  };

  const handleAddMethod = () => {
    const newId = 'pm_' + Date.now();
    setMethods([...methods, { id: newId, name: 'New Method', details: '', type: 'manual' }]);
    setEditingMethodId(newId);
  };

  const handleDeleteMethod = (id: string) => {
    if (confirm('Are you sure you want to delete this payment method?')) {
      const newMethods = methods.filter(m => m.id !== id);
      setMethods(newMethods);
      updatePaymentMethods(newMethods);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-white">Wallet Settings</h2>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-green-500" />
            </div>
            <h3 className="text-lg font-bold text-white">Exchange Rate</h3>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-zinc-400">1 USD = IQD</label>
            <div className="flex items-center gap-4">
              <div className="flex-1 relative">
                <input 
                  type="number" 
                  value={exchangeRate}
                  onChange={(e) => setExchangeRate(Number(e.target.value))}
                  className="w-full bg-zinc-800 border-none text-white px-4 py-3 rounded-2xl font-bold focus:ring-2 focus:ring-[#6B46FF]/50"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-bold text-sm">IQD</span>
              </div>
            </div>
            <div className="text-xs font-semibold text-zinc-500 flex items-center gap-1 mt-2">
              <Check className="w-3 h-3 text-[#2CE59B]" /> Saved automatically
            </div>
          </div>
        </div>
        
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <Video className="w-5 h-5 text-blue-500" />
            </div>
            <h3 className="text-lg font-bold text-white">Ad Video Config</h3>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-bold text-zinc-400">Video URL (Direct link to mp4)</label>
            <input 
              type="text" 
              value={adVideoUrl}
              onChange={(e) => setAdVideoUrl(e.target.value)}
              placeholder="e.g. https://www.w3schools.com/html/mov_bbb.mp4"
              className="w-full bg-zinc-800 border-none text-white px-4 py-3 rounded-2xl font-medium focus:ring-2 focus:ring-[#6B46FF]/50"
            />
            <div className="text-xs font-semibold text-zinc-500 flex items-center gap-1 mt-2">
              <Check className="w-3 h-3 text-[#2CE59B]" /> Saved automatically
            </div>
          </div>
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
              <CreditCard className="w-5 h-5 text-purple-500" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">Deposit Methods</h3>
              <p className="text-xs text-zinc-400">Manage manual payment options available to users.</p>
            </div>
          </div>
          <button 
            onClick={handleAddMethod}
            className="flex items-center gap-1 bg-white hover:bg-zinc-200 text-black px-4 py-2 rounded-xl text-sm font-bold transition-all"
          >
            <Plus className="w-4 h-4" /> Add Method
          </button>
        </div>

        <div className="space-y-4">
          {methods.map(method => (
            <div key={method.id} className="bg-zinc-800/50 border border-zinc-700/50 p-4 rounded-2xl">
              {editingMethodId === method.id ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-zinc-500 mb-1">Method Name</label>
                      <input 
                        type="text" 
                        value={method.name}
                        onChange={e => handleUpdateMethod(method.id, 'name', e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 text-white px-3 py-2 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-zinc-500 mb-1">Account Details / Numbers</label>
                      <input 
                        type="text" 
                        value={method.details}
                        onChange={e => handleUpdateMethod(method.id, 'details', e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 text-white px-3 py-2 rounded-lg"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button 
                      onClick={handleSaveMethods}
                      className="bg-[#2CE59B] text-black px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1 hover:bg-[#06D6A0]"
                    >
                      <Check className="w-4 h-4" /> Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-bold text-white">{method.name}</h4>
                    <p className="text-sm text-zinc-400">{method.details}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => setEditingMethodId(method.id)}
                      className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-zinc-300 transition-colors"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => handleDeleteMethod(method.id)}
                      className="p-2 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-500 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {methods.length === 0 && (
            <div className="text-center text-zinc-500 py-8 text-sm">
              No deposit methods configured.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
