import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowLeft, ArrowRight, Trash2, ShieldCheck, ChevronRight, Check, Minus, Plus, X } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { useWallet } from '../WalletContext';

export default function Cart() {
  const navigate = useNavigate();
  const { t, dir } = useLanguage();
  const { user } = useAuth();
  const { cartShippingMethods, pointBalance } = useWallet();
  
  const [currentPlan, setCurrentPlan] = useState('free');
  
  // Modals state
  const [variantModalOpen, setVariantModalOpen] = useState(false);
  const [selectedItemForVariant, setSelectedItemForVariant] = useState<any>(null);
  const [shippingModalOpen, setShippingModalOpen] = useState(false);
  const [selectedItemForShipping, setSelectedItemForShipping] = useState<any>(null);
  
  const [dealsExpanded, setDealsExpanded] = useState(false);
  const [usePoints, setUsePoints] = useState(false);
  
  useEffect(() => {
    const dbPlan = user?.subscription_plan;
    setCurrentPlan(dbPlan && dbPlan !== 'free' ? dbPlan : (localStorage.getItem('levo_subscription') || 'free'));
  }, [user]);

  // Mock data to match the image structure
  const [storeGroups, setStoreGroups] = useState<any[]>([]);

  const updateQuantity = (storeId: string, itemId: number, delta: number) => {
    setStoreGroups(groups => groups.map(group => {
      if (group.id !== storeId) return group;
      return {
        ...group,
        items: group.items.map(item => {
          if (item.id !== itemId) return item;
          const newQuantity = Math.max(1, (item.stock ? Math.min(item.quantity + delta, item.stock) : item.quantity + delta));
          return { ...item, quantity: newQuantity };
        })
      };
    }));
  };

  const deleteItem = (storeId: string, itemId: number) => {
    setStoreGroups(groups => groups.map(group => {
      if (group.id !== storeId) return group;
      return {
        ...group,
        items: group.items.filter(item => item.id !== itemId)
      };
    }).filter(group => group.items.length > 0));
  };

  const toggleSelect = (storeId: string, itemId: number) => {
    setStoreGroups(groups => groups.map(group => {
      if (group.id !== storeId) return group;
      return {
        ...group,
        items: group.items.map(item => item.id === itemId ? { ...item, selected: !item.selected } : item)
      };
    }));
  };

  const allSelected = storeGroups.length > 0 && storeGroups.every(group => group.items.every(item => item.selected));

  const toggleSelectAll = () => {
    const newState = !allSelected;
    setStoreGroups(groups => groups.map(group => ({
      ...group,
      items: group.items.map(item => ({ ...item, selected: newState }))
    })));
  };

  const selectedItems = storeGroups.flatMap(g => g.items.filter(i => i.selected));
  const subtotal = selectedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const totalOriginalPrice = selectedItems.reduce((sum, item) => sum + (item.originalPrice * item.quantity), 0);
  const discounts = totalOriginalPrice - subtotal;
  const selectedCount = selectedItems.reduce((sum, item) => sum + item.quantity, 0);
  
  let shipping = selectedCount > 0 ? 5000 : 0;
  let shippingMsg = '';
  
  if (currentPlan === 'pro' && subtotal >= 50000) {
    shipping = 0;
    shippingMsg = dir === 'rtl' ? 'توصيل مجاني (Pro)' : 'Free Shipping (Pro)';
  } else if (currentPlan === 'plus' && subtotal >= 150000) {
    shipping = 0;
    shippingMsg = dir === 'rtl' ? 'توصيل مجاني (Plus)' : 'Free Shipping (Plus)';
  }

  const pointsDiscount = usePoints ? Math.min(pointBalance, subtotal) : 0;
  const total = subtotal + shipping - pointsDiscount;

  return (
    <div className="w-full pt-16 pb-48 text-zinc-300 min-h-screen bg-black flex flex-col font-sans">
      {/* Header */}
      <div className="fixed top-0 left-0 right-0 z-40 bg-black backdrop-blur-xl border-b border-zinc-900 px-4 py-4 flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="p-1 hover:text-white transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-6 h-6" /> : <ArrowLeft className="w-6 h-6" />}
        </button>
        <h1 className="text-white font-bold text-[17px]">
          {t('cart' as any) || (dir === 'rtl' ? 'السلة' : 'Cart')}
        </h1>
        <button className="text-[15px] text-zinc-300 hover:text-white font-medium">
          {dir === 'rtl' ? 'المفضلة' : 'Favorites'}
        </button>
      </div>
      
      {/* Main Content */}
      <div className="flex-1 overflow-y-auto bg-[#050505]">
        {storeGroups.map((group, index) => (
          <div key={group.id} className={`bg-[#0a0a0a] ${index > 0 ? 'mt-2' : ''} border-y border-zinc-900/50 pb-4`}>
            {/* Group Header */}
            <div className="px-4 py-3 flex items-center gap-2">
              {!group.isDepartment && (
                <div className="w-5 h-5 rounded-full bg-zinc-800 overflow-hidden flex items-center justify-center shrink-0 border border-zinc-700">
                  <span className="text-[10px] text-zinc-400 font-bold">{group.shipper.substring(0,2)}</span>
                </div>
              )}
              <span className="text-zinc-300 text-[15px] font-medium">
                {group.isDepartment 
                  ? (dir === 'rtl' ? `شحن بواسطة ليفو - ${group.shipper}` : `Shipped by Levo - ${group.shipper}`)
                  : (dir === 'rtl' ? `شحن بواسطة ${group.shipper}` : `Shipped by ${group.shipper}`)
                }
              </span>
              {group.verified && (
                <div className="w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center">
                  <Check className="w-3 h-3 text-white" strokeWidth={3} />
                </div>
              )}
              <ChevronRight className="w-4 h-4 text-zinc-500 ml-auto" />
            </div>

            {/* Items */}
            {group.items.map(item => (
              <div key={item.id} className="px-4 py-2 flex gap-3">
                {/* Checkbox */}
                <div className="pt-8 shrink-0" onClick={() => toggleSelect(group.id, item.id)}>
                  <div className={`w-[22px] h-[22px] rounded-full border flex items-center justify-center transition-colors cursor-pointer ${
                    item.selected 
                      ? 'bg-[#ef233c] border-[#ef233c]' 
                      : 'border-zinc-500 hover:border-zinc-400'
                  }`}>
                    {item.selected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
                  </div>
                </div>

                {/* Product Image */}
                <div className="w-[100px] h-[100px] shrink-0 bg-white rounded-lg overflow-hidden border border-zinc-800">
                  <img referrerPolicy="no-referrer" src={item.img || undefined} alt={item.name} className="w-full h-full object-cover mix-blend-multiply" />
                </div>

                {/* Product Details */}
                <div className="flex-1 flex flex-col justify-between">
                  <div>
                    <h3 className="text-zinc-200 text-[14px] leading-snug line-clamp-2 mb-1">{item.name}</h3>
                    {group.isDepartment && (
                      <div className="flex items-center gap-1 text-[13px] text-zinc-400 mb-1">
                        {dir === 'rtl' ? 'القسم' : 'Department'} <span className="text-zinc-300 ml-1">{group.seller}</span>
                        <ChevronRight className="w-3 h-3" />
                      </div>
                    )}
                    
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      <button 
                        onClick={() => { setSelectedItemForVariant(item); setVariantModalOpen(true); }}
                        className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 flex items-center gap-1 w-max"
                      >
                        <span className="text-[12px] text-zinc-300">{item.variant}</span>
                        <ChevronRight className="w-3 h-3 text-zinc-500" />
                      </button>

                      <button 
                        onClick={() => { setSelectedItemForShipping(item); setShippingModalOpen(true); }}
                        className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 flex items-center gap-1 w-max"
                      >
                        <span className="text-[12px] text-zinc-300">
                          {(() => {
                            const sm = cartShippingMethods.find(m => m.id === item.shippingMethod);
                            return sm ? (dir === 'rtl' ? sm.titleAr : sm.titleEn) : (dir === 'rtl' ? 'شحن مباشر' : 'Direct');
                          })()}
                        </span>
                        <ChevronRight className="w-3 h-3 text-zinc-500" />
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-1 mb-1">
                      {item.tags.map(tag => {
                        let tagClass = 'bg-zinc-800 text-zinc-400';
                        if (tag.includes('deal') || tag.includes('Sale')) {
                          if (currentPlan === 'pro') {
                            tagClass = 'bg-olive/10 text-olive';
                          } else if (currentPlan === 'plus') {
                            tagClass = 'bg-zinc-500/10 text-zinc-300';
                          } else {
                            tagClass = 'bg-[#ef233c]/10 text-[#ef233c]';
                          }
                        }
                        return (
                          <span key={tag} className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 font-medium ${tagClass}`}>
                            {tag}
                          </span>
                        );
                      })}
                    </div>

                    {item.purchased && (
                      <p className="text-[12px] text-zinc-500 mb-1">{item.purchased}</p>
                    )}
                  </div>

                  <div className="flex items-baseline gap-1.5 mb-2 mt-1">
                    <span className="text-[#ef233c] font-bold text-[17px]">{item.price.toLocaleString()} د.ع</span>
                    <span className="text-zinc-500 text-[12px] line-through">{item.originalPrice.toLocaleString()}</span>
                    <span className="text-[#ef233c] text-[12px]">{item.discount}</span>
                  </div>

                  <div className="flex items-center justify-between mt-auto">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded">
                        <button onClick={() => updateQuantity(group.id, item.id, -1)} className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors">
                          {item.quantity <= 1 ? <Trash2 className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
                        </button>
                        <span className="w-8 text-center text-[14px] font-medium text-zinc-200 border-x border-zinc-800 py-1">{item.quantity}</span>
                        <button onClick={() => updateQuantity(group.id, item.id, 1)} className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors">
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                      {item.stock && (
                        <span className="text-[#ef233c] text-[12px]">Only {item.stock} left</span>
                      )}
                    </div>
                    <button onClick={() => deleteItem(group.id, item.id)} className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-[13px] font-medium text-zinc-300 hover:bg-zinc-800 transition-colors">
                      {dir === 'rtl' ? 'حذف' : 'Delete'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}

        {/* Deals Row */}
        <div className="mt-2 bg-[#0a0a0a] border-y border-zinc-900/50 flex flex-col">
          <div onClick={() => setDealsExpanded(!dealsExpanded)} className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-zinc-900/30 transition-colors">
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="w-5 h-5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              <span className="text-zinc-200 text-[15px] font-bold">{dir === 'rtl' ? 'العروض والخصومات' : 'Deals & Discounts'}</span>
              <span className="bg-[#ef233c]/10 text-[#ef233c] text-[11px] font-medium px-1.5 py-0.5 rounded">{dir === 'rtl' ? 'تم التطبيق' : 'Applied'}</span>
            </div>
            <ChevronRight className={`w-4 h-4 text-zinc-500 transition-transform ${dealsExpanded ? 'rotate-90' : ''}`} />
          </div>
          
          {dealsExpanded && (
            <div className="px-4 pb-4 pt-1 animate-in slide-in-from-top-2 fade-in duration-200">
              <p className="text-zinc-400 text-sm mb-3">{dir === 'rtl' ? 'استخدم نقاطك للحصول على خصم' : 'Use your points for a discount'}</p>
              <div className="flex flex-col gap-2 mb-4">
                <label className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-colors ${usePoints ? 'border-emerald-500 bg-emerald-500/10' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'}`}>
                  <div className="flex items-center gap-3">
                    <input type="checkbox" className="w-5 h-5 accent-emerald-500" checked={usePoints} onChange={() => setUsePoints(!usePoints)} disabled={pointBalance === 0} />
                    <div>
                      <p className={`font-bold ${usePoints ? 'text-emerald-400' : 'text-zinc-300'}`}>{dir === 'rtl' ? 'استخدام النقاط' : 'Use Points'}</p>
                      <p className="text-xs text-zinc-400">
                        {dir === 'rtl' ? `رصيدك: ${pointBalance.toLocaleString()} نقطة = ${pointBalance.toLocaleString()} د.ع` : `Balance: ${pointBalance.toLocaleString()} pts = ${pointBalance.toLocaleString()} IQD`}
                      </p>
                    </div>
                  </div>
                </label>
              </div>

              <div>
                <p className="text-white font-bold mb-2 text-sm">{dir === 'rtl' ? 'كود الخصم' : 'Promo Code'}</p>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    placeholder={dir === 'rtl' ? 'أدخل الكود هنا' : 'Enter code here'} 
                    className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-white outline-none focus:border-[#ef233c] transition-colors text-sm"
                  />
                  <button className="bg-zinc-800 text-white font-bold px-4 py-2 rounded-lg border border-zinc-700 hover:bg-zinc-700 transition-colors text-sm">
                    {dir === 'rtl' ? 'تطبيق' : 'Apply'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Summary Details */}
        <div className="mt-2 bg-[#0a0a0a] border-y border-zinc-900/50 p-4 mb-20 flex flex-col gap-3">
          <h3 className="text-white font-bold text-[16px] mb-1">{dir === 'rtl' ? 'ملخص الطلب' : 'Order Summary'}</h3>
          
          <div className="flex justify-between items-center">
            <span className="text-zinc-400 text-[14px]">{dir === 'rtl' ? 'المجموع الفرعي' : 'Subtotal'}</span>
            <span className="text-zinc-200 text-[14px] font-medium">{totalOriginalPrice.toLocaleString()} د.ع</span>
          </div>

          {discounts > 0 && (
            <div className="flex justify-between items-center text-[#ef233c]">
              <div className="flex items-center gap-1">
                <span className="text-[14px]">{dir === 'rtl' ? 'خصم ليفو' : 'Levo Discount'}</span>
              </div>
              <span className="text-[14px] font-medium">- {discounts.toLocaleString()} د.ع</span>
            </div>
          )}

          {pointsDiscount > 0 && (
            <div className="flex justify-between items-center text-emerald-400">
              <div className="flex items-center gap-1">
                <span className="text-[14px]">{dir === 'rtl' ? 'خصم النقاط' : 'Points Discount'}</span>
              </div>
              <span className="text-[14px] font-medium">- {pointsDiscount.toLocaleString()} د.ع</span>
            </div>
          )}

          <div className="flex justify-between items-center text-[#ef233c]">
            <div className="flex items-center gap-1">
              <span className="text-[14px]">{dir === 'rtl' ? 'خصم الكوبون' : 'Coupon Discount'}</span>
            </div>
            <span className="text-[14px] font-medium">- 0 د.ع</span>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-zinc-400 text-[14px]">{dir === 'rtl' ? 'التوصيل' : 'Shipping'}</span>
            <span className="text-zinc-200 text-[14px] font-medium">
              {shipping === 0 ? (
                <span className="text-green-500">{shippingMsg || (dir === 'rtl' ? 'مجاني' : 'Free')}</span>
              ) : (
                `${shipping.toLocaleString()} د.ع`
              )}
            </span>
          </div>

          <div className="flex justify-between items-center">
            <div className="flex items-center gap-1">
              <span className="text-zinc-400 text-[14px]">{dir === 'rtl' ? 'الضرائب' : 'Taxes'}</span>
              <div className="w-3.5 h-3.5 rounded-full border border-zinc-500 text-zinc-500 flex items-center justify-center text-[10px]">i</div>
            </div>
            <span className="text-zinc-200 text-[14px] font-medium">0 د.ع</span>
          </div>

          <div className="h-[1px] w-full bg-zinc-800/50 my-1"></div>

          <div className="flex justify-between items-center">
            <span className="text-white font-bold text-[15px]">{dir === 'rtl' ? 'المجموع الكلي' : 'Total'}</span>
            <span className="text-white font-bold text-[17px]">{total.toLocaleString()} د.ع</span>
          </div>
        </div>
      </div>
      
      {/* Sticky Bottom Bar */}
      <div className="fixed bottom-[80px] sm:bottom-[100px] left-2 right-2 md:left-1/2 md:-translate-x-1/2 md:w-full md:max-w-md bg-zinc-900/90 backdrop-blur-xl border border-zinc-800 px-3 py-3 z-40 rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
        <div className="w-full flex items-center justify-between gap-2">
          
          <div className="flex items-center gap-2 cursor-pointer shrink-0" onClick={toggleSelectAll}>
            <div className={`w-5 h-5 sm:w-[22px] sm:h-[22px] rounded-full border flex items-center justify-center transition-colors ${
              allSelected 
                ? 'bg-[#ef233c] border-[#ef233c]' 
                : 'border-zinc-500'
            }`}>
              {allSelected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
            </div>
            <span className="text-zinc-300 text-[13px] sm:text-[14px] whitespace-nowrap">{dir === 'rtl' ? 'الكل' : 'All'}</span>
          </div>

          <div className="flex flex-col items-end flex-1 overflow-hidden pr-2">
            <div className="flex items-baseline gap-1.5 w-full justify-end">
              <span className="text-white font-bold text-[15px] sm:text-[17px] whitespace-nowrap truncate">{total.toLocaleString()} د.ع</span>
            </div>
            {discounts > 0 && (
              <div className="flex items-center gap-1 text-[#ef233c] text-[10px] sm:text-[11px] whitespace-nowrap">
                <span>{dir === 'rtl' ? 'توفير' : 'Saved'} {discounts.toLocaleString()}</span>
              </div>
            )}
          </div>
          
          <button 
            onClick={() => navigate('/checkout')}
            className="bg-[#ef233c] hover:bg-[#d90429] text-white font-bold py-2 sm:py-2.5 px-3 sm:px-5 rounded-lg text-[13px] sm:text-[15px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0 whitespace-nowrap"
            disabled={selectedCount === 0}
          >
            {dir === 'rtl' ? `إتمام الطلب (${selectedCount})` : `Checkout (${selectedCount})`}
          </button>
        </div>
      </div>

      {/* Variant Modal */}
      {variantModalOpen && selectedItemForVariant && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 w-full max-w-md rounded-t-2xl p-5 border-t border-zinc-800 flex flex-col gap-4 animate-in slide-in-from-bottom-full duration-300">
            <div className="flex items-start justify-between">
              <div className="flex gap-4">
                <img referrerPolicy="no-referrer" src={selectedItemForVariant.img || undefined} alt="" className="w-20 h-20 rounded-lg object-cover bg-white" />
                <div>
                  <p className="text-[#ef233c] font-bold text-lg">{selectedItemForVariant.price.toLocaleString()} د.ع</p>
                  <p className="text-sm text-zinc-400">Stock: {selectedItemForVariant.stock || 10}</p>
                </div>
              </div>
              <button onClick={() => setVariantModalOpen(false)} className="p-2 bg-zinc-800 rounded-full hover:bg-zinc-700 text-zinc-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <p className="text-white font-bold mb-2">{dir === 'rtl' ? 'اللون' : 'Color'}</p>
              <div className="flex gap-2">
                <button className="px-4 py-2 rounded-lg border border-[#ef233c] text-[#ef233c] bg-[#ef233c]/10 text-sm">Black</button>
                <button className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-300 bg-zinc-800 text-sm">White</button>
              </div>
            </div>

            <div>
              <p className="text-white font-bold mb-2">{dir === 'rtl' ? 'الخيارات' : 'Options'}</p>
              <div className="flex gap-2">
                <button className="px-4 py-2 rounded-lg border border-[#ef233c] text-[#ef233c] bg-[#ef233c]/10 text-sm">
                  {selectedItemForVariant.id === 1 ? '256GB' : '1pc'}
                </button>
                <button className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-300 bg-zinc-800 text-sm">
                  {selectedItemForVariant.id === 1 ? '512GB' : '2pcs'}
                </button>
              </div>
            </div>

            <button 
              onClick={() => setVariantModalOpen(false)}
              className="w-full mt-4 bg-[#ef233c] text-white font-bold py-3 rounded-xl hover:bg-[#d90429] transition-colors"
            >
              {dir === 'rtl' ? 'تأكيد' : 'Confirm'}
            </button>
          </div>
        </div>
      )}

      {/* Shipping Modal */}
      {shippingModalOpen && selectedItemForShipping && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 w-full max-w-md rounded-t-2xl p-5 border-t border-zinc-800 flex flex-col gap-4 animate-in slide-in-from-bottom-full duration-300">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-white font-bold text-[17px]">{dir === 'rtl' ? 'طريقة الشحن' : 'Shipping Method'}</h3>
                <p className="text-zinc-400 text-sm mt-1">{dir === 'rtl' ? 'اختر طريقة الشحن المفضلة لهذا المنتج' : 'Choose your preferred shipping method for this item'}</p>
              </div>
              <button onClick={() => setShippingModalOpen(false)} className="p-2 bg-zinc-800 rounded-full hover:bg-zinc-700 text-zinc-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex flex-col gap-3 mt-2">
              {cartShippingMethods.filter(method => selectedItemForShipping.shippingOptions.some((opt: any) => opt.id === method.id)).map(method => {
                const optPrice = selectedItemForShipping.shippingOptions.find((opt: any) => opt.id === method.id);
                return (
                  <button
                    key={method.id}
                    onClick={() => {
                      setStoreGroups(groups => groups.map(g => ({
                        ...g,
                        items: g.items.map(i => {
                          if (i.id === selectedItemForShipping.id) {
                            return { ...i, shippingMethod: method.id, price: optPrice.price, originalPrice: optPrice.originalPrice };
                          }
                          return i;
                        })
                      })));
                      setShippingModalOpen(false);
                    }}
                    className={`flex items-start justify-between p-4 rounded-xl border transition-all text-left w-full ${selectedItemForShipping.shippingMethod === method.id ? 'border-[#ef233c] bg-[#ef233c]/10' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'}`}
                  >
                    <div className="flex-1">
                      <p className={`font-bold text-[15px] ${selectedItemForShipping.shippingMethod === method.id ? 'text-[#ef233c]' : 'text-zinc-200'}`}>
                        {dir === 'rtl' ? method.titleAr : method.titleEn}
                      </p>
                      <p className="text-zinc-500 text-xs mt-1">
                        {dir === 'rtl' ? method.descAr : method.descEn}
                      </p>
                      <p className={`text-[13px] mt-1.5 font-bold ${selectedItemForShipping.shippingMethod === method.id ? 'text-[#ef233c]' : 'text-zinc-300'}`}>
                        {optPrice.price.toLocaleString()} د.ع
                      </p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${selectedItemForShipping.shippingMethod === method.id ? 'border-[#ef233c]' : 'border-zinc-600'}`}>
                      {selectedItemForShipping.shippingMethod === method.id && <div className="w-2.5 h-2.5 rounded-full bg-[#ef233c]"></div>}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
