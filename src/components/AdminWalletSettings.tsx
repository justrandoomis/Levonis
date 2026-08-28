import React, { useState, useEffect, useRef } from 'react';
import { useWallet, PaymentMethod } from '../WalletContext';
import { ApiError } from '../lib/api';
import { Check, Edit2, Plus, Trash2, Video, DollarSign, CreditCard, Save, AlertTriangle } from 'lucide-react';

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

function SaveStatus({ state, error }: { state: SaveState; error?: string | null }) {
  if (state === 'saving') {
    return <div className="text-xs font-semibold text-zinc-400 mt-2">Saving...</div>;
  }
  if (state === 'saved') {
    return (
      <div className="text-xs font-semibold text-zinc-500 flex items-center gap-1 mt-2">
        <Check className="w-3 h-3 text-[#2CE59B]" /> Saved
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="text-xs font-semibold text-red-400 flex items-center gap-1 mt-2">
        <AlertTriangle className="w-3 h-3" /> {error || 'Save failed'}
      </div>
    );
  }
  if (state === 'dirty') {
    return <div className="text-xs font-semibold text-yellow-400/80 mt-2">Unsaved changes</div>;
  }
  return null;
}

export default function AdminWalletSettings() {
  const {
    exchangeRate, setExchangeRate,
    adVideoUrl, setAdVideoUrl,
    paymentMethods, updatePaymentMethods,
    isLoaded,
  } = useWallet();

  // Local editable copies — saved explicitly, never per keystroke.
  const [rateInput, setRateInput] = useState<string>('');
  const [rateState, setRateState] = useState<SaveState>('idle');
  const [rateError, setRateError] = useState<string | null>(null);

  const [urlInput, setUrlInput] = useState<string>('');
  const [urlState, setUrlState] = useState<SaveState>('idle');
  const [urlError, setUrlError] = useState<string | null>(null);

  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [methodsState, setMethodsState] = useState<SaveState>('idle');
  const [methodsError, setMethodsError] = useState<string | null>(null);
  const [editingMethodId, setEditingMethodId] = useState<string | null>(null);

  // Seed local state from the context once settings have actually loaded,
  // so an empty pre-load context never clobbers the form (stale-initializer fix).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || hydratedRef.current) return;
    hydratedRef.current = true;
    setRateInput(String(exchangeRate));
    setUrlInput(adVideoUrl);
    setMethods(paymentMethods);
  }, [isLoaded, exchangeRate, adVideoUrl, paymentMethods]);

  // Keep untouched sections in sync when the context refreshes (e.g. after a save elsewhere).
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (rateState === 'idle' || rateState === 'saved') setRateInput(String(exchangeRate));
  }, [exchangeRate]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (urlState === 'idle' || urlState === 'saved') setUrlInput(adVideoUrl);
  }, [adVideoUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (methodsState === 'idle' || methodsState === 'saved') setMethods(paymentMethods);
  }, [paymentMethods]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveRate = async () => {
    const parsed = parseInt(rateInput, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setRateState('error');
      setRateError('Enter a whole number of IQD per USD (at least 1)');
      return;
    }
    setRateState('saving');
    setRateError(null);
    try {
      await setExchangeRate(parsed);
      setRateState('saved');
    } catch (e) {
      setRateState('error');
      setRateError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const handleSaveUrl = async () => {
    setUrlState('saving');
    setUrlError(null);
    try {
      await setAdVideoUrl(urlInput.trim());
      setUrlState('saved');
    } catch (e) {
      setUrlState('error');
      setUrlError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const saveMethods = async (next: PaymentMethod[]) => {
    setMethodsState('saving');
    setMethodsError(null);
    try {
      await updatePaymentMethods(next);
      setMethodsState('saved');
      setEditingMethodId(null);
    } catch (e) {
      setMethodsState('error');
      setMethodsError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const handleUpdateMethod = (id: string, field: 'name' | 'details', value: string) => {
    setMethods(ms => ms.map(m => m.id === id ? { ...m, [field]: value } : m));
    setMethodsState('dirty');
  };

  const handleAddMethod = () => {
    const newId = 'pm_' + Date.now();
    setMethods(ms => [...ms, { id: newId, name: 'New Method', details: '' }]);
    setMethodsState('dirty');
    setEditingMethodId(newId);
  };

  const handleDeleteMethod = (id: string) => {
    if (!window.confirm('Are you sure you want to delete this payment method?')) return;
    const next = methods.filter(m => m.id !== id);
    setMethods(next);
    saveMethods(next);
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
            <div className="flex items-center gap-3">
              <div className="flex-1 relative">
                <input
                  type="number"
                  value={rateInput}
                  onChange={(e) => { setRateInput(e.target.value); setRateState('dirty'); }}
                  disabled={!isLoaded}
                  className="w-full bg-zinc-800 border-none text-white px-4 py-3 rounded-2xl font-bold focus:ring-2 focus:ring-[#6B46FF]/50 disabled:opacity-50"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-bold text-sm">IQD</span>
              </div>
              <button
                onClick={handleSaveRate}
                disabled={rateState === 'saving' || !isLoaded}
                className="flex items-center gap-2 bg-[#2CE59B] hover:bg-[#06D6A0] text-black px-4 py-3 rounded-2xl font-bold transition-colors disabled:opacity-50"
              >
                <Save className="w-4 h-4" /> Save
              </button>
            </div>
            <p className="text-[11px] text-zinc-500">
              Product prices are stored in IQD and are not affected by rate changes; the rate only converts wallet USD at checkout.
            </p>
            <SaveStatus state={rateState} error={rateError} />
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
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); setUrlState('dirty'); }}
                disabled={!isLoaded}
                placeholder="e.g. https://www.w3schools.com/html/mov_bbb.mp4"
                className="flex-1 bg-zinc-800 border-none text-white px-4 py-3 rounded-2xl font-medium focus:ring-2 focus:ring-[#6B46FF]/50 disabled:opacity-50"
              />
              <button
                onClick={handleSaveUrl}
                disabled={urlState === 'saving' || !isLoaded}
                className="flex items-center gap-2 bg-[#2CE59B] hover:bg-[#06D6A0] text-black px-4 py-3 rounded-2xl font-bold transition-colors disabled:opacity-50"
              >
                <Save className="w-4 h-4" /> Save
              </button>
            </div>
            <SaveStatus state={urlState} error={urlError} />
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
          <div className="flex items-center gap-2">
            {methodsState === 'dirty' && (
              <button
                onClick={() => saveMethods(methods)}
                className="flex items-center gap-1 bg-[#2CE59B] hover:bg-[#06D6A0] text-black px-4 py-2 rounded-xl text-sm font-bold transition-all"
              >
                <Save className="w-4 h-4" /> Save All
              </button>
            )}
            <button
              onClick={handleAddMethod}
              disabled={!isLoaded}
              className="flex items-center gap-1 bg-white hover:bg-zinc-200 text-black px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50"
            >
              <Plus className="w-4 h-4" /> Add Method
            </button>
          </div>
        </div>

        <SaveStatus state={methodsState} error={methodsError} />

        <div className="space-y-4 mt-4">
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
                      onClick={() => saveMethods(methods)}
                      disabled={methodsState === 'saving'}
                      className="bg-[#2CE59B] text-black px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1 hover:bg-[#06D6A0] disabled:opacity-50"
                    >
                      <Check className="w-4 h-4" /> {methodsState === 'saving' ? 'Saving...' : 'Save'}
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
              {isLoaded ? 'No deposit methods configured.' : 'Loading...'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
