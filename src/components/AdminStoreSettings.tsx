import React, { useState, useEffect, useRef } from 'react';
import { useWallet, CheckoutDeliveryMethod, CheckoutPaymentMethod, CartShippingMethod } from '../WalletContext';
import { ApiError } from '../lib/api';
import { Plus, Trash2, Check, AlertTriangle, Lock } from 'lucide-react';

const DELIVERY_ICONS = ['Truck', 'User', 'Store', 'CreditCard', 'Banknote'];

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Local rows wrap each method with a stable render key (the id it was
 * hydrated with, or a generated draft key for new rows) and an `existing`
 * flag: ids of already-saved entries are immutable because products and
 * orders reference them.
 */
interface Row<T> {
  key: string;
  existing: boolean;
  value: T;
}

function toRows<T extends { id: string }>(items: T[]): Row<T>[] {
  return items.map(item => ({ key: item.id, existing: true, value: item }));
}

function SaveButton({ state, onClick, error }: { state: SaveState; onClick: () => void; error: string | null }) {
  return (
    <div>
      <button
        onClick={onClick}
        disabled={state === 'saving'}
        className="w-full bg-green-600 hover:bg-green-700 font-bold py-3 rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {state === 'saving' ? 'جارٍ الحفظ...' : state === 'saved' ? (<><Check className="w-4 h-4" /> تم الحفظ</>) : 'حفظ التغييرات'}
      </button>
      {state === 'error' && (
        <div className="mt-2 text-sm text-red-400 flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error || 'Save failed'}
        </div>
      )}
    </div>
  );
}

export default function AdminStoreSettings() {
  const {
    checkoutDeliveryMethods, updateCheckoutDeliveryMethods,
    checkoutPaymentMethods, updateCheckoutPaymentMethods,
    cartShippingMethods, updateCartShippingMethods,
    isLoaded,
  } = useWallet();

  const [deliveryRows, setDeliveryRows] = useState<Row<CheckoutDeliveryMethod>[]>([]);
  const [paymentRows, setPaymentRows] = useState<Row<CheckoutPaymentMethod>[]>([]);
  const [shippingRows, setShippingRows] = useState<Row<CartShippingMethod>[]>([]);

  const [deliveryState, setDeliveryState] = useState<SaveState>('idle');
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [paymentState, setPaymentState] = useState<SaveState>('idle');
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [shippingState, setShippingState] = useState<SaveState>('idle');
  const [shippingError, setShippingError] = useState<string | null>(null);

  // Seed local state from the context only after settings have loaded — the
  // context starts empty, so a plain useState initializer would race it.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || hydratedRef.current) return;
    hydratedRef.current = true;
    setDeliveryRows(toRows(checkoutDeliveryMethods));
    setPaymentRows(toRows(checkoutPaymentMethods));
    setShippingRows(toRows(cartShippingMethods));
  }, [isLoaded, checkoutDeliveryMethods, checkoutPaymentMethods, cartShippingMethods]);

  const saveDeliveryMethods = async () => {
    setDeliveryState('saving');
    setDeliveryError(null);
    try {
      const value = deliveryRows.map(r => ({ ...r.value, price_iqd: Math.round(Number(r.value.price_iqd)) || 0 }));
      await updateCheckoutDeliveryMethods(value);
      // Once saved, every id becomes referenced data → lock it.
      setDeliveryRows(rows => rows.map(r => ({ ...r, key: r.value.id, existing: true })));
      setDeliveryState('saved');
    } catch (e) {
      setDeliveryState('error');
      setDeliveryError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const savePaymentMethods = async () => {
    setPaymentState('saving');
    setPaymentError(null);
    try {
      await updateCheckoutPaymentMethods(paymentRows.map(r => r.value));
      setPaymentRows(rows => rows.map(r => ({ ...r, key: r.value.id, existing: true })));
      setPaymentState('saved');
    } catch (e) {
      setPaymentState('error');
      setPaymentError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const saveShippingMethods = async () => {
    setShippingState('saving');
    setShippingError(null);
    try {
      await updateCartShippingMethods(shippingRows.map(r => r.value));
      setShippingRows(rows => rows.map(r => ({ ...r, key: r.value.id, existing: true })));
      setShippingState('saved');
    } catch (e) {
      setShippingState('error');
      setShippingError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const idInput = <T extends { id: string }>(
    row: Row<T>,
    setRows: React.Dispatch<React.SetStateAction<Row<T>[]>>,
    onDirty: () => void
  ) => (
    row.existing ? (
      <div className="flex items-center gap-2 bg-zinc-800/60 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-400 cursor-not-allowed" title="Existing IDs are locked — products reference them">
        <Lock className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate font-mono text-sm">{row.value.id}</span>
      </div>
    ) : (
      <input
        type="text"
        value={row.value.id}
        onChange={e => {
          const id = e.target.value;
          setRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, id } } : r));
          onDirty();
        }}
        placeholder="ID (e.g. standard)"
        className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
      />
    )
  );

  if (!isLoaded) {
    return (
      <div className="text-center text-zinc-500 py-16">Loading settings...</div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Checkout Delivery Methods */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-700 p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">طرق التوصيل (Checkout Delivery Methods)</h2>
          <button
            onClick={() => {
              const key = 'new_' + Date.now();
              setDeliveryRows(rows => [...rows, { key, existing: false, value: { id: '', titleAr: 'جديد', titleEn: 'New', descAr: '', descEn: '', price_iqd: 0, icon: 'Truck' } }]);
              setDeliveryState('idle');
            }}
            className="flex items-center gap-2 bg-[#ef233c] hover:bg-[#d90429] px-4 py-2 rounded-lg font-bold"
          >
            <Plus className="w-4 h-4" /> إضافة
          </button>
        </div>
        <div className="space-y-4">
          {deliveryRows.map((row) => (
            <div key={row.key} className="grid grid-cols-1 md:grid-cols-3 gap-4 border border-zinc-700 p-4 rounded-xl">
              {idInput(row, setDeliveryRows, () => setDeliveryState('idle'))}
              <input
                type="text"
                value={row.value.titleAr}
                onChange={e => { setDeliveryRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, titleAr: e.target.value } } : r)); setDeliveryState('idle'); }}
                placeholder="Title (Ar)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input
                type="text"
                value={row.value.titleEn}
                onChange={e => { setDeliveryRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, titleEn: e.target.value } } : r)); setDeliveryState('idle'); }}
                placeholder="Title (En)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input
                type="text"
                value={row.value.descAr}
                onChange={e => { setDeliveryRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, descAr: e.target.value } } : r)); setDeliveryState('idle'); }}
                placeholder="Desc (Ar)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input
                type="text"
                value={row.value.descEn}
                onChange={e => { setDeliveryRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, descEn: e.target.value } } : r)); setDeliveryState('idle'); }}
                placeholder="Desc (En)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <select
                value={row.value.icon || 'Truck'}
                onChange={e => { setDeliveryRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, icon: e.target.value } } : r)); setDeliveryState('idle'); }}
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
                title="Icon"
              >
                {DELIVERY_ICONS.map(icon => (
                  <option key={icon} value={icon}>{icon}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={row.value.price_iqd}
                  onChange={e => { setDeliveryRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, price_iqd: Number(e.target.value) } } : r)); setDeliveryState('idle'); }}
                  placeholder="Price (IQD)"
                  className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2 flex-1"
                />
                <button
                  onClick={() => {
                    if (!window.confirm(`Delete delivery method "${row.value.titleEn || row.value.id}"?`)) return;
                    setDeliveryRows(rows => rows.filter(r => r.key !== row.key));
                    setDeliveryState('idle');
                  }}
                  className="bg-red-500/20 text-red-500 p-2 rounded-lg"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          ))}
          <SaveButton state={deliveryState} onClick={saveDeliveryMethods} error={deliveryError} />
        </div>
      </div>

      {/* Checkout Payment Methods */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-700 p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">طرق الدفع (Checkout Payment Methods)</h2>
          <button
            onClick={() => {
              const key = 'new_' + Date.now();
              setPaymentRows(rows => [...rows, { key, existing: false, value: { id: '', titleAr: 'جديد', titleEn: 'New', icon: 'CreditCard' } }]);
              setPaymentState('idle');
            }}
            className="flex items-center gap-2 bg-[#ef233c] hover:bg-[#d90429] px-4 py-2 rounded-lg font-bold"
          >
            <Plus className="w-4 h-4" /> إضافة
          </button>
        </div>
        <div className="space-y-4">
          {paymentRows.map((row) => (
            <div key={row.key} className="grid grid-cols-1 md:grid-cols-4 gap-4 border border-zinc-700 p-4 rounded-xl">
              {idInput(row, setPaymentRows, () => setPaymentState('idle'))}
              <input
                type="text"
                value={row.value.titleAr}
                onChange={e => { setPaymentRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, titleAr: e.target.value } } : r)); setPaymentState('idle'); }}
                placeholder="Title (Ar)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input
                type="text"
                value={row.value.titleEn}
                onChange={e => { setPaymentRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, titleEn: e.target.value } } : r)); setPaymentState('idle'); }}
                placeholder="Title (En)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  value={row.value.icon}
                  onChange={e => { setPaymentRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, icon: e.target.value } } : r)); setPaymentState('idle'); }}
                  placeholder="Icon Name"
                  className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2 flex-1"
                />
                <button
                  onClick={() => {
                    if (!window.confirm(`Delete payment method "${row.value.titleEn || row.value.id}"?`)) return;
                    setPaymentRows(rows => rows.filter(r => r.key !== row.key));
                    setPaymentState('idle');
                  }}
                  className="bg-red-500/20 text-red-500 p-2 rounded-lg"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          ))}
          <SaveButton state={paymentState} onClick={savePaymentMethods} error={paymentError} />
        </div>
      </div>

      {/* Cart Shipping Methods */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-700 p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">شحن المنتجات (Cart Shipping Methods)</h2>
          <button
            onClick={() => {
              const key = 'new_' + Date.now();
              setShippingRows(rows => [...rows, { key, existing: false, value: { id: '', titleAr: 'جديد', titleEn: 'New', descAr: '', descEn: '' } }]);
              setShippingState('idle');
            }}
            className="flex items-center gap-2 bg-[#ef233c] hover:bg-[#d90429] px-4 py-2 rounded-lg font-bold"
          >
            <Plus className="w-4 h-4" /> إضافة
          </button>
        </div>
        <div className="space-y-4">
          {shippingRows.map((row) => (
            <div key={row.key} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 border border-zinc-700 p-4 rounded-xl">
              {idInput(row, setShippingRows, () => setShippingState('idle'))}
              <input
                type="text"
                value={row.value.titleAr}
                onChange={e => { setShippingRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, titleAr: e.target.value } } : r)); setShippingState('idle'); }}
                placeholder="Title (Ar)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input
                type="text"
                value={row.value.titleEn}
                onChange={e => { setShippingRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, titleEn: e.target.value } } : r)); setShippingState('idle'); }}
                placeholder="Title (En)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input
                type="text"
                value={row.value.descAr}
                onChange={e => { setShippingRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, descAr: e.target.value } } : r)); setShippingState('idle'); }}
                placeholder="Desc (Ar)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  value={row.value.descEn}
                  onChange={e => { setShippingRows(rows => rows.map(r => r.key === row.key ? { ...r, value: { ...r.value, descEn: e.target.value } } : r)); setShippingState('idle'); }}
                  placeholder="Desc (En)"
                  className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2 flex-1"
                />
                <button
                  onClick={() => {
                    if (!window.confirm(`Delete shipping method "${row.value.titleEn || row.value.id}"?`)) return;
                    setShippingRows(rows => rows.filter(r => r.key !== row.key));
                    setShippingState('idle');
                  }}
                  className="bg-red-500/20 text-red-500 p-2 rounded-lg"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          ))}
          <SaveButton state={shippingState} onClick={saveShippingMethods} error={shippingError} />
        </div>
      </div>
    </div>
  );
}
