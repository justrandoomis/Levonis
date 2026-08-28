import React, { useState } from 'react';
import { useWallet } from '../WalletContext';
import { Plus, Edit2, Trash2 } from 'lucide-react';

export default function AdminStoreSettings() {
  const { 
    checkoutDeliveryMethods, updateCheckoutDeliveryMethods,
    checkoutPaymentMethods, updateCheckoutPaymentMethods,
    cartShippingMethods, updateCartShippingMethods 
  } = useWallet();

  const [deliveryMethods, setDeliveryMethods] = useState(checkoutDeliveryMethods);
  const [paymentMethods, setPaymentMethods] = useState(checkoutPaymentMethods);
  const [shippingMethods, setShippingMethods] = useState(cartShippingMethods);

  const saveDeliveryMethods = () => updateCheckoutDeliveryMethods(deliveryMethods);
  const savePaymentMethods = () => updateCheckoutPaymentMethods(paymentMethods);
  const saveShippingMethods = () => updateCartShippingMethods(shippingMethods);

  return (
    <div className="space-y-8">
      {/* Checkout Delivery Methods */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-700 p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">طرق التوصيل (Checkout Delivery Methods)</h2>
          <button 
            onClick={() => setDeliveryMethods([...deliveryMethods, { id: 'new_' + Date.now(), titleAr: 'جديد', titleEn: 'New', descAr: '', descEn: '', price: 0, icon: 'Truck' }])}
            className="flex items-center gap-2 bg-[#ef233c] hover:bg-[#d90429] px-4 py-2 rounded-lg font-bold"
          >
            <Plus className="w-4 h-4" /> إضافة
          </button>
        </div>
        <div className="space-y-4">
          {deliveryMethods.map((method, index) => (
            <div key={index} className="grid grid-cols-1 md:grid-cols-3 gap-4 border border-zinc-700 p-4 rounded-xl">
              <input 
                type="text" 
                value={method.id} 
                onChange={e => setDeliveryMethods(m => m.map((x, i) => i === index ? { ...x, id: e.target.value } : x))}
                placeholder="ID (e.g. standard)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input 
                type="text" 
                value={method.titleAr} 
                onChange={e => setDeliveryMethods(m => m.map((x, i) => i === index ? { ...x, titleAr: e.target.value } : x))}
                placeholder="Title (Ar)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input 
                type="text" 
                value={method.titleEn} 
                onChange={e => setDeliveryMethods(m => m.map((x, i) => i === index ? { ...x, titleEn: e.target.value } : x))}
                placeholder="Title (En)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input 
                type="text" 
                value={method.descAr} 
                onChange={e => setDeliveryMethods(m => m.map((x, i) => i === index ? { ...x, descAr: e.target.value } : x))}
                placeholder="Desc (Ar)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input 
                type="text" 
                value={method.descEn} 
                onChange={e => setDeliveryMethods(m => m.map((x, i) => i === index ? { ...x, descEn: e.target.value } : x))}
                placeholder="Desc (En)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <div className="flex gap-2">
                <input 
                  type="number" 
                  value={method.price} 
                  onChange={e => setDeliveryMethods(m => m.map((x, i) => i === index ? { ...x, price: Number(e.target.value) } : x))}
                  placeholder="Price"
                  className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2 flex-1"
                />
                <button 
                  onClick={() => setDeliveryMethods(m => m.filter((_, i) => i !== index))}
                  className="bg-red-500/20 text-red-500 p-2 rounded-lg"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          ))}
          <button onClick={saveDeliveryMethods} className="w-full bg-green-600 hover:bg-green-700 font-bold py-3 rounded-lg">حفظ التغييرات</button>
        </div>
      </div>

      {/* Checkout Payment Methods */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-700 p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">طرق الدفع (Checkout Payment Methods)</h2>
          <button 
            onClick={() => setPaymentMethods([...paymentMethods, { id: 'new_' + Date.now(), titleAr: 'جديد', titleEn: 'New', icon: 'CreditCard' }])}
            className="flex items-center gap-2 bg-[#ef233c] hover:bg-[#d90429] px-4 py-2 rounded-lg font-bold"
          >
            <Plus className="w-4 h-4" /> إضافة
          </button>
        </div>
        <div className="space-y-4">
          {paymentMethods.map((method, index) => (
            <div key={index} className="grid grid-cols-1 md:grid-cols-4 gap-4 border border-zinc-700 p-4 rounded-xl">
              <input 
                type="text" 
                value={method.id} 
                onChange={e => setPaymentMethods(m => m.map((x, i) => i === index ? { ...x, id: e.target.value } : x))}
                placeholder="ID (e.g. card)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input 
                type="text" 
                value={method.titleAr} 
                onChange={e => setPaymentMethods(m => m.map((x, i) => i === index ? { ...x, titleAr: e.target.value } : x))}
                placeholder="Title (Ar)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input 
                type="text" 
                value={method.titleEn} 
                onChange={e => setPaymentMethods(m => m.map((x, i) => i === index ? { ...x, titleEn: e.target.value } : x))}
                placeholder="Title (En)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <div className="flex gap-2">
                <input 
                  type="text" 
                  value={method.icon} 
                  onChange={e => setPaymentMethods(m => m.map((x, i) => i === index ? { ...x, icon: e.target.value } : x))}
                  placeholder="Icon Name"
                  className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2 flex-1"
                />
                <button 
                  onClick={() => setPaymentMethods(m => m.filter((_, i) => i !== index))}
                  className="bg-red-500/20 text-red-500 p-2 rounded-lg"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          ))}
          <button onClick={savePaymentMethods} className="w-full bg-green-600 hover:bg-green-700 font-bold py-3 rounded-lg">حفظ التغييرات</button>
        </div>
      </div>

      {/* Cart Shipping Methods */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-700 p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">شحن المنتجات (Cart Shipping Methods)</h2>
          <button 
            onClick={() => setShippingMethods([...shippingMethods, { id: 'new_' + Date.now(), titleAr: 'جديد', titleEn: 'New', descAr: '', descEn: '' }])}
            className="flex items-center gap-2 bg-[#ef233c] hover:bg-[#d90429] px-4 py-2 rounded-lg font-bold"
          >
            <Plus className="w-4 h-4" /> إضافة
          </button>
        </div>
        <div className="space-y-4">
          {shippingMethods.map((method, index) => (
            <div key={index} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 border border-zinc-700 p-4 rounded-xl">
              <input 
                type="text" 
                value={method.id} 
                onChange={e => setShippingMethods(m => m.map((x, i) => i === index ? { ...x, id: e.target.value } : x))}
                placeholder="ID (e.g. direct)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input 
                type="text" 
                value={method.titleAr} 
                onChange={e => setShippingMethods(m => m.map((x, i) => i === index ? { ...x, titleAr: e.target.value } : x))}
                placeholder="Title (Ar)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input 
                type="text" 
                value={method.titleEn} 
                onChange={e => setShippingMethods(m => m.map((x, i) => i === index ? { ...x, titleEn: e.target.value } : x))}
                placeholder="Title (En)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <input 
                type="text" 
                value={method.descAr} 
                onChange={e => setShippingMethods(m => m.map((x, i) => i === index ? { ...x, descAr: e.target.value } : x))}
                placeholder="Desc (Ar)"
                className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2"
              />
              <div className="flex gap-2">
                <input 
                  type="text" 
                  value={method.descEn} 
                  onChange={e => setShippingMethods(m => m.map((x, i) => i === index ? { ...x, descEn: e.target.value } : x))}
                  placeholder="Desc (En)"
                  className="bg-zinc-800/30 border border-zinc-700 rounded-lg px-3 py-2 flex-1"
                />
                <button 
                  onClick={() => setShippingMethods(m => m.filter((_, i) => i !== index))}
                  className="bg-red-500/20 text-red-500 p-2 rounded-lg"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          ))}
          <button onClick={saveShippingMethods} className="w-full bg-green-600 hover:bg-green-700 font-bold py-3 rounded-lg">حفظ التغييرات</button>
        </div>
      </div>
    </div>
  );
}
