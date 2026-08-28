
import React, { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, ChevronDown, ChevronUp, Image as ImageIcon, X, Save, ArrowLeft, Check, ShoppingCart, Star } from 'lucide-react';
import { queryDb } from '../lib/db';
import { useLanguage } from '../LanguageContext';
import { useWallet } from '../WalletContext';

const initialForm = {
  id: '',
  name: '',
  name_ar: '',
  name_ku: '',
  slug: '',
  description: '',
  description_ar: '',
  description_ku: '',
  images: [''],
  options: [],
  colors: [],
  selling_type: 'direct_sale',
  shipping_methods: [],
  base_price: 0,
  original_price: 0,
  product_cost: 0,
  membership_prices: { plus: 0, pro: 0 },
  payment_options: ['full'],
  subcategory_id: '',
  display_order: 0,
  is_featured: false,
  specifications: [],
  brand: '',
  labels: [],
  hashtags: [],
  features: [],
  algorithm_tags: [],
  description_images: [],
  description_videos: [],
  stores: [],
  categories: '',
  warranty_plans: [],
  how_to_use: ''
};

const SectionCard = ({ title, children, defaultOpen = false }: { title: string, children: React.ReactNode, defaultOpen?: boolean }) => {
  return (
    <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl overflow-hidden mb-6 shadow-lg">
      <div className="w-full p-4 bg-zinc-800/20 border-b border-zinc-800/50">
        <h3 className="font-bold text-white">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
};



function ProductPreviewModal({ form, onClose, dir }: { form: any, onClose: () => void, dir: string }) {
  const mainImage = form.images?.[0] || '';
  const price = form.original_price || form.base_price || 0;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-white font-bold">Storefront Preview</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-white"><X className="w-5 h-5"/></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6" dir={dir}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <div className="aspect-square bg-zinc-800 rounded-2xl overflow-hidden mb-4 border border-zinc-700">
                {mainImage ? (
                  <img referrerPolicy="no-referrer" src={mainImage || undefined} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-600">No Image</div>
                )}
              </div>
              <div className="grid grid-cols-5 gap-2">
                {form.images?.slice(1, 6).map((img: string, i: number) => (
                  <div key={i} className="aspect-square bg-zinc-800 rounded-xl overflow-hidden border border-zinc-700">
                    {img && <img referrerPolicy="no-referrer" src={img || undefined} className="w-full h-full object-cover" />}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-6">
              <div>
                <div className="text-[#6B46FF] font-bold mb-2">{form.brand}</div>
                <h1 className="text-2xl font-bold text-white mb-2">{dir === 'rtl' ? (form.name_ar || form.name) : form.name}</h1>
                <div className="flex items-center gap-4 text-sm text-zinc-400">
                  <div className="flex items-center gap-1 text-yellow-500"><Star className="w-4 h-4 fill-current"/> 5.0</div>
                  <div>•</div>
                  <div>120 Reviews</div>
                </div>
              </div>
              <div className="text-3xl font-bold text-white">IQD {price.toLocaleString()}</div>
              
              {form.colors?.length > 0 && (
                <div>
                  <h3 className="text-white font-bold mb-3">{dir === 'rtl' ? 'اللون' : 'Color'}</h3>
                  <div className="flex flex-wrap gap-2">
                    {form.colors.map((c: any, i: number) => (
                      <div key={i} className="w-10 h-10 rounded-full border-2 border-zinc-700" style={{backgroundColor: c.hex_code || '#333'}}></div>
                    ))}
                  </div>
                </div>
              )}
              
              {form.options?.length > 0 && (
                <div>
                  <h3 className="text-white font-bold mb-3">{dir === 'rtl' ? 'الخيارات' : 'Options'}</h3>
                  <div className="flex flex-wrap gap-2">
                    {form.options.map((o: any, i: number) => (
                      <div key={i} className="px-4 py-2 border border-zinc-700 rounded-xl text-zinc-300">{dir === 'rtl' ? (o.name_ar || o.name) : o.name}</div>
                    ))}
                  </div>
                </div>
              )}
              
              <div className="pt-6 border-t border-zinc-800">
                <button className="w-full bg-[#6B46FF] text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2">
                  <ShoppingCart className="w-5 h-5" />
                  {dir === 'rtl' ? 'أضف إلى السلة' : 'Add to Cart'}
                </button>
              </div>
              
              <div>
                <h3 className="text-white font-bold mb-2">{dir === 'rtl' ? 'الوصف' : 'Description'}</h3>
                <p className="text-zinc-400 whitespace-pre-wrap">{dir === 'rtl' ? (form.description_ar || form.description) : form.description}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminProducts() {
  const { language, dir } = useLanguage();
  const [products, setProducts] = useState<any[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [form, setForm] = useState(initialForm);
  const { exchangeRate, cartShippingMethods, checkoutPaymentMethods } = useWallet();
  const [isTranslating, setIsTranslating] = useState(false);

  const handleAutoTranslate = async () => {
    if (!form.name_ar && !form.description_ar) {
      alert("Please enter the Arabic name or description first.");
      return;
    }
    setIsTranslating(true);
    try {
      let newName = form.name;
      let newDesc = form.description;
      let newNameKu = form.name_ku;
      let newDescKu = form.description_ku;
      
      if (form.name_ar) {
        const resEn = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: form.name_ar, targetLang: 'en' })
        });
        const dataEn = await resEn.json();
        if (dataEn.success && dataEn.translation) newName = dataEn.translation;
        
        const resKu = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: form.name_ar, targetLang: 'ku' })
        });
        const dataKu = await resKu.json();
        if (dataKu.success && dataKu.translation) newNameKu = dataKu.translation;
      }
      
      if (form.description_ar) {
        const resEn = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: form.description_ar, targetLang: 'en' })
        });
        const dataEn = await resEn.json();
        if (dataEn.success && dataEn.translation) newDesc = dataEn.translation;
        
        const resKu = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: form.description_ar, targetLang: 'ku' })
        });
        const dataKu = await resKu.json();
        if (dataKu.success && dataKu.translation) newDescKu = dataKu.translation;
      }
      setForm({ ...form, name: newName, name_ku: newNameKu, description: newDesc, description_ku: newDescKu, slug: newName.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
    } catch (e) {
      console.error(e);
      alert("Translation failed");
    } finally {
      setIsTranslating(false);
    }
  };

  const loadProducts = async () => {
    try {
      const res = await queryDb('SELECT * FROM products ORDER BY created_at DESC');
      setProducts(res);
    } catch (err) {
      console.error("Error loading products", err);
    }
  };

  useEffect(() => {
    loadProducts();
  }, []);


  const handleUploadImage = async (file: File, callback: (url: string) => void) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        callback(data.url);
      } else {
        alert('Upload failed: ' + data.error);
      }
    } catch (err) {
      alert('Upload error');
    }
  };

  const handleSave = async () => {
    try {
      let finalName = form.name;
      let finalDesc = form.description;
      let finalNameKu = form.name_ku;
      let finalDescKu = form.description_ku;
      
      // Auto-translate if English or Kurdish is empty but Arabic is present
      if ((!finalName || !finalNameKu) && form.name_ar) {
        setIsTranslating(true);
        try {
          if (!finalName) {
            const res = await fetch('/api/translate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: form.name_ar, targetLang: 'en' })
            });
            const data = await res.json();
            if (data.success && data.translation) finalName = data.translation;
          }
          if (!finalNameKu) {
            const res = await fetch('/api/translate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: form.name_ar, targetLang: 'ku' })
            });
            const data = await res.json();
            if (data.success && data.translation) finalNameKu = data.translation;
          }
        } catch(e) {}
        setIsTranslating(false);
      }
      
      if ((!finalDesc || !finalDescKu) && form.description_ar) {
        setIsTranslating(true);
        try {
          if (!finalDesc) {
            const res = await fetch('/api/translate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: form.description_ar, targetLang: 'en' })
            });
            const data = await res.json();
            if (data.success && data.translation) finalDesc = data.translation;
          }
          if (!finalDescKu) {
            const res = await fetch('/api/translate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: form.description_ar, targetLang: 'ku' })
            });
            const data = await res.json();
            if (data.success && data.translation) finalDescKu = data.translation;
          }
        } catch(e) {}
        setIsTranslating(false);
      }

      const id = form.id || Math.random().toString(36).substr(2, 9);
      const finalSlug = form.slug || finalName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      
      const sql = `
        INSERT INTO products (id, name, name_ar, name_ku, slug, description, description_ar, description_ku, images, options, colors, selling_type, shipping_methods, base_price, original_price, product_cost, membership_prices, payment_options, subcategory_id, display_order, is_featured, specifications, brand, labels, hashtags, algorithm_tags, features, description_images, description_videos, stores, categories, warranty_plans, how_to_use)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, name_ar=excluded.name_ar, name_ku=excluded.name_ku, slug=excluded.slug, description=excluded.description, description_ar=excluded.description_ar, description_ku=excluded.description_ku, images=excluded.images,
          options=excluded.options, colors=excluded.colors, selling_type=excluded.selling_type, shipping_methods=excluded.shipping_methods,
          base_price=excluded.base_price, original_price=excluded.original_price, product_cost=excluded.product_cost,
          membership_prices=excluded.membership_prices, payment_options=excluded.payment_options, subcategory_id=excluded.subcategory_id,
          display_order=excluded.display_order, is_featured=excluded.is_featured, specifications=excluded.specifications,
          brand=excluded.brand, labels=excluded.labels, hashtags=excluded.hashtags, algorithm_tags=excluded.algorithm_tags, features=excluded.features, description_images=excluded.description_images, description_videos=excluded.description_videos, stores=excluded.stores, categories=excluded.categories, warranty_plans=excluded.warranty_plans, how_to_use=excluded.how_to_use
      `;

      await queryDb(sql, [
        id, finalName, form.name_ar, finalNameKu, finalSlug, finalDesc, form.description_ar, finalDescKu, JSON.stringify(form.images), 
        JSON.stringify(form.options.map((o: any) => ({...o, cost: o.cost/exchangeRate, price: o.price/exchangeRate, original_price: o.original_price/exchangeRate, pro_price: o.pro_price/exchangeRate, name_ar: o.name_ar}))),
        JSON.stringify(form.colors.map((c: any) => ({...c, cost: c.cost/exchangeRate, price: c.price/exchangeRate, original_price: c.original_price/exchangeRate, pro_price: c.pro_price/exchangeRate, option_id: c.option_id, name_ar: c.name_ar}))), 
        form.selling_type, 
        JSON.stringify(form.shipping_methods.map((m: any) => ({...m, cost: m.cost/exchangeRate, price: m.price/exchangeRate}))),
        form.base_price / exchangeRate, form.original_price / exchangeRate, form.product_cost / exchangeRate, 
        JSON.stringify({
          plus: form.membership_prices.plus / exchangeRate,
          pro: form.membership_prices.pro / exchangeRate
        }),
        JSON.stringify(form.payment_options), form.subcategory_id, form.display_order, form.is_featured ? 1 : 0,
        JSON.stringify(form.specifications),
        form.brand, JSON.stringify(form.labels), JSON.stringify(form.hashtags), JSON.stringify(form.algorithm_tags), JSON.stringify(form.features), JSON.stringify(form.description_images), JSON.stringify(form.description_videos), JSON.stringify(form.stores), form.categories, JSON.stringify(form.warranty_plans), form.how_to_use
      ]);

      await loadProducts();
      setIsEditing(false);
    } catch (err) {
      alert("Error saving product: " + err.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure?")) return;
    try {
      await queryDb('DELETE FROM products WHERE id = ?', [id]);
      await loadProducts();
    } catch (err) {
      alert("Error deleting product");
    }
  };

  const openEditor = (prod?: any) => {
    if (prod) {
      let parsedMem = { plus: 0, pro: 0 };
      try { parsedMem = JSON.parse(prod.membership_prices || '{"plus":0,"pro":0}'); } catch (e) {}
      let parsedSM = [];
      try { parsedSM = JSON.parse(prod.shipping_methods || '[]'); } catch (e) {}
      let parsedOpts = [];
      try { parsedOpts = JSON.parse(prod.options || '[]'); } catch (e) {}
      let parsedCols = [];
      try { parsedCols = JSON.parse(prod.colors || '[]'); } catch (e) {}

      setForm({
        ...prod,
        name_ar: prod.name_ar || '',
        name_ku: prod.name_ku || '',
        description_ar: prod.description_ar || '',
        description_ku: prod.description_ku || '',
        base_price: (prod.base_price || 0) * exchangeRate,
        original_price: (prod.original_price || 0) * exchangeRate,
        product_cost: (prod.product_cost || 0) * exchangeRate,
        membership_prices: {
          plus: (parsedMem.plus || 0) * exchangeRate,
          pro: (parsedMem.pro || 0) * exchangeRate
        },
        shipping_methods: parsedSM.map(m => ({...m, cost: (m.cost||0)*exchangeRate, price: (m.price||0)*exchangeRate})),
        options: parsedOpts.map(o => ({...o, cost: (o.cost||0)*exchangeRate, price: (o.price||0)*exchangeRate, original_price: (o.original_price||0)*exchangeRate, pro_price: (o.pro_price||0)*exchangeRate, name_ar: o.name_ar||''})),
        colors: parsedCols.map(c => ({...c, cost: (c.cost||0)*exchangeRate, price: (c.price||0)*exchangeRate, original_price: (c.original_price||0)*exchangeRate, pro_price: (c.pro_price||0)*exchangeRate, option_id: c.option_id||'', name_ar: c.name_ar||''})),
        images: JSON.parse(prod.images || '[]'),
        payment_options: JSON.parse(prod.payment_options || '["full"]'),
        specifications: JSON.parse(prod.specifications || '[]'),
        is_featured: !!prod.is_featured,
        brand: prod.brand || '',
        algorithm_tags: prod.algorithm_tags ? JSON.parse(prod.algorithm_tags) : [],
        labels: JSON.parse(prod.labels || '[]'),
        hashtags: JSON.parse(prod.hashtags || '[]'),
        features: JSON.parse(prod.features || '[]'),
        description_images: JSON.parse(prod.description_images || '[]'),
        description_videos: JSON.parse(prod.description_videos || '[]'),
        
        stores: JSON.parse(prod.stores || '[]'),
        categories: prod.categories || '',
        warranty_plans: JSON.parse(prod.warranty_plans || '[]'),
        how_to_use: prod.how_to_use || ''

      });
    } else {
      setForm(initialForm);
    }
    setIsEditing(true);
  };

  if (isEditing) {
    const uniqueBrands = Array.from(new Set(products.map(p => p.brand).filter(Boolean))) as string[];
    const uniqueSubcategories = Array.from(new Set(products.map(p => p.subcategory_id).filter(Boolean))) as string[];
    const uniqueCategories = Array.from(new Set(products.map(p => p.categories).filter(Boolean).flatMap((c: string) => c.split(',').map(s=>s.trim())))) as string[];
    const uniqueLabels = Array.from(new Set(products.flatMap(p => {
      try { return JSON.parse(p.labels || '[]'); } catch(e) { return []; }
    }).filter(Boolean))) as string[];
    const uniqueHashtags = Array.from(new Set(products.flatMap(p => {
      try { return JSON.parse(p.hashtags || '[]'); } catch(e) { return []; }
    }).filter(Boolean))) as string[];

    const renderSingleChips = (options: string[], currentValue: string, onSelect: (val: string) => void) => (
      <div className="flex flex-wrap gap-2 mt-2">
        {options.map(opt => (
          <button
            key={opt}
            type="button"
            onClick={() => onSelect(opt)}
            className={`px-2 py-1 text-[10px] rounded border transition-colors ${currentValue === opt ? 'bg-[#6B46FF] border-[#6B46FF] text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-white'}`}
          >
            {opt}
          </button>
        ))}
      </div>
    );

    const renderMultiArrayChips = (options: string[], currentArray: string[], onSelect: (newArray: string[]) => void) => (
      <div className="flex flex-wrap gap-2 mt-2">
        {options.map(opt => {
          const isSelected = currentArray.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => {
                if (isSelected) {
                  onSelect(currentArray.filter(v => v !== opt));
                } else {
                  onSelect([...currentArray, opt]);
                }
              }}
              className={`px-2 py-1 text-[10px] rounded border transition-colors ${isSelected ? 'bg-[#6B46FF] border-[#6B46FF] text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-white'}`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    );

    const renderMultiStringChips = (options: string[], currentString: string, onSelect: (val: string) => void) => {
      const currentArray = currentString ? currentString.split(',').map(s=>s.trim()).filter(Boolean) : [];
      return renderMultiArrayChips(options, currentArray, (newArr) => onSelect(newArr.join(', ')));
    };

    return (
      <div>
        <div className="flex items-center justify-between mb-6">
          <button onClick={() => setIsEditing(false)} className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex gap-2">
            <button onClick={() => setIsPreviewOpen(true)} className="flex items-center gap-2 bg-zinc-800 text-white px-6 py-2 rounded-lg font-bold hover:bg-zinc-700 transition-colors">
              Preview
            </button>
            <button onClick={handleSave} disabled={isTranslating} className="flex items-center gap-2 bg-[#6B46FF] text-white px-6 py-2 rounded-lg font-bold hover:bg-[#6B46FF]/90 transition-colors disabled:opacity-50">
              <Save className="w-4 h-4" /> {isTranslating ? "Translating & Saving..." : "Save Product"}
            </button>
          </div>
        </div>

        <div className="bg-zinc-900/40 border border-[#6B46FF]/30 rounded-2xl p-4 mb-6 flex items-end gap-4 shadow-lg shadow-[#6B46FF]/5">
          <div className="flex-1">
            <label className="block text-xs font-bold text-[#6B46FF] uppercase tracking-wider mb-2">Auto Extract Product from URL</label>
            <input type="text" id="extract_url" placeholder="Paste product URL here (e.g., from Amazon, Aliexpress)..." className="w-full bg-zinc-800/50 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
          </div>
          <button type="button" onClick={async () => {
            const urlInput = document.getElementById('extract_url') as HTMLInputElement;
            if (!urlInput || !urlInput.value) return;
            const btn = document.getElementById('extract_btn');
            if (btn) btn.innerHTML = 'Extracting...';
            try {
              const res = await fetch('/api/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: urlInput.value })
              });
              const data = await res.json();
              if (data.success && data.product) {
                setForm(prev => ({
                  ...prev,
                  name: data.product.name || prev.name,
                  name_ar: '', // let user translate or type
                  description: data.product.description || prev.description,
                  images: data.product.images.length > 0 ? data.product.images : prev.images
                }));
                alert('Extraction successful! Please translate fields if needed.');
              } else {
                alert('Extraction failed or no data found.');
              }
            } catch(e) {
              alert('Error extracting product data.');
            }
            if (btn) btn.innerHTML = 'Extract Data';
          }} id="extract_btn" className="bg-[#6B46FF] hover:bg-[#5a3ae0] text-white px-6 py-3 rounded-xl font-bold transition-colors whitespace-nowrap">
            Extract Data
          </button>
        </div>

        {/* General Info */}
        <SectionCard title="General Information" defaultOpen>
          <div className="flex justify-between items-center mb-4">
            <h4 className="text-white font-bold">Product Details</h4>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Name (Arabic)</label>
              <input type="text" value={form.name_ar} onChange={e => setForm({...form, name_ar: e.target.value, name: '', name_ku: ''})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all text-right" dir="rtl" placeholder="اسم المنتج" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Name (English)</label>
              <input type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all" placeholder="English Name" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Name (Kurdish)</label>
              <input type="text" value={form.name_ku} onChange={e => setForm({...form, name_ku: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all text-right" dir="rtl" placeholder="ناوی بەرهەم" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Slug (SEO)</label>
              <input type="text" value={form.slug} onChange={e => setForm({...form, slug: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description (Arabic)</label>
              <textarea value={form.description_ar} onChange={e => setForm({...form, description_ar: e.target.value, description: '', description_ku: ''})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all h-32 text-right" dir="rtl" placeholder="وصف المنتج" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description (English)</label>
              <textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all h-32" placeholder="English Description" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description (Kurdish)</label>
              <textarea value={form.description_ku} onChange={e => setForm({...form, description_ku: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all h-32 text-right" dir="rtl" placeholder="وەسفی بەرهەم" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Subcategory / القسم الفرعي</label>
              <input type="text" value={form.subcategory_id} onChange={e => setForm({...form, subcategory_id: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all" />
              {uniqueSubcategories.length > 0 && renderSingleChips(uniqueSubcategories, form.subcategory_id, (val) => setForm({...form, subcategory_id: val}))}
            </div>
            <div className="flex items-center gap-6">
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Display Order (Sequence in Subcategory/Brand)</label>
                <input type="number" value={form.display_order} onChange={e => setForm({...form, display_order: parseInt(e.target.value) || 0})} className="w-32 bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all" />
              </div>
              <label className="flex items-center gap-2 mt-6 cursor-pointer">
                <input type="checkbox" checked={form.is_featured} onChange={e => setForm({...form, is_featured: e.target.checked})} className="w-5 h-5 accent-olive" />
                <span className="text-white font-medium">Featured Product</span>
              </label>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Categories (comma separated) / الأقسام</label>
              <input type="text" value={form.categories || ''} onChange={e => setForm({...form, categories: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
              {uniqueCategories.length > 0 && renderMultiStringChips(uniqueCategories, form.categories || '', (val) => setForm({...form, categories: val}))}
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Brand / البراند</label>
              <input type="text" value={form.brand || ''} onChange={e => setForm({...form, brand: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
              {uniqueBrands.length > 0 && renderSingleChips(uniqueBrands, form.brand || '', (val) => setForm({...form, brand: val}))}
            </div>
          </div>
        </SectionCard>

        {/* Marketing & Tags */}
        <SectionCard title="Marketing & Tags">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Algorithms & Suggestions (comma separated)</label>
              <input type="text" value={(form.algorithm_tags || []).join(', ')} onChange={e => setForm({...form, algorithm_tags: e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})} placeholder="e.g. Trending, Recommended" className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Labels (comma separated) / الليبل</label>
              <input type="text" value={(form.labels || []).join(', ')} onChange={e => setForm({...form, labels: e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})} placeholder="e.g. New, Bestseller, 20% OFF" className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
              {uniqueLabels.length > 0 && renderMultiArrayChips(uniqueLabels, form.labels || [], (val) => setForm({...form, labels: val}))}
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Hashtags (comma separated) / الهاشتاق</label>
              <input type="text" value={(form.hashtags || []).join(', ')} onChange={e => setForm({...form, hashtags: e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})} placeholder="e.g. #fashion, #sale" className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
              {uniqueHashtags.length > 0 && renderMultiArrayChips(uniqueHashtags, form.hashtags || [], (val) => setForm({...form, hashtags: val}))}
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Key Features (comma separated)</label>
              <input type="text" value={(form.features || []).join(', ')} onChange={e => setForm({...form, features: e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})} placeholder="e.g. Waterproof, 2-year warranty" className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
            </div>
          </div>
        </SectionCard>

        
        {/* Warranty & Usage */}
        <SectionCard title="Warranty & Usage Instructions">
          <div className="mb-6">
            <h4 className="text-white font-bold mb-2">Warranty Plans</h4>
            <p className="text-xs text-zinc-400 mb-4">Add extended warranty options for this product.</p>
            {form.warranty_plans.map((wp: any, idx: number) => (
              <div key={idx} className="flex gap-4 mb-2 items-center">
                <input type="text" placeholder="Plan Name (e.g. 2 Years)" value={wp.name} onChange={e => {
                  const newWP = [...form.warranty_plans]; newWP[idx].name = e.target.value; setForm({...form, warranty_plans: newWP});
                }} className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-white" />
                <input type="number" placeholder="Extra Cost (IQD)" value={wp.price} onChange={e => {
                  const newWP = [...form.warranty_plans]; newWP[idx].price = parseFloat(e.target.value) || 0; setForm({...form, warranty_plans: newWP});
                }} className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-white" />
                <button onClick={() => {
                  const newWP = form.warranty_plans.filter((_, i) => i !== idx); setForm({...form, warranty_plans: newWP});
                }} className="p-2 text-red-500 bg-zinc-900 border border-zinc-700 rounded"><Trash2 className="w-5 h-5"/></button>
              </div>
            ))}
            <button onClick={() => setForm({...form, warranty_plans: [...(form.warranty_plans||[]), {name: '', price: 0}]})} className="text-[#6B46FF] text-sm font-bold flex items-center gap-1 mt-2">
              <Plus className="w-4 h-4" /> Add Warranty Plan
            </button>
          </div>
          <div>
            <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">How to Use / In The Box (Text or Markdown)</label>
            <textarea value={form.how_to_use || ''} onChange={e => setForm({...form, how_to_use: e.target.value})} rows={5} placeholder="Instructions on how to use the product or what is inside the box..." className="w-full bg-zinc-900 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
          </div>
        </SectionCard>

        {/* Description Rich Media */}
        <SectionCard title="Description Media (Images & Videos)">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description Images</label>
              <div className="flex flex-col gap-2">
                {(form.description_images || []).map((img, idx) => (
                  <div key={idx} className="flex gap-2">
                    <div className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-zinc-400 text-sm truncate">{img}</div>
                    <button onClick={() => {
                      const newImgs = (form.description_images || []).filter((_, i) => i !== idx); setForm({...form, description_images: newImgs});
                    }} className="p-2 text-zinc-500 hover:text-red-500 bg-zinc-900 border border-zinc-700 rounded"><X className="w-4 h-4"/></button>
                  </div>
                ))}
                <label className="flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl cursor-pointer transition-colors border border-dashed border-zinc-600">
                  <Plus className="w-4 h-4" /> Upload Description Image
                  <input type="file" className="hidden" accept="image/*" multiple onChange={async (e) => {
                    if (e.target.files) {
                      const newUrls = [];
                      for (let i = 0; i < e.target.files.length; i++) {
                        await new Promise<void>(resolve => {
                          handleUploadImage(e.target.files![i], (url) => {
                            newUrls.push(url);
                            resolve();
                          });
                        });
                      }
                      setForm({...form, description_images: [...(form.description_images || []), ...newUrls]});
                    }
                  }} />
                </label>
              </div>
            </div>
            
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description Videos</label>
              <div className="flex flex-col gap-2">
                {(form.description_videos || []).map((vid, idx) => (
                  <div key={idx} className="flex gap-2">
                    <div className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-zinc-400 text-sm truncate">{vid}</div>
                    <button onClick={() => {
                      const newVids = (form.description_videos || []).filter((_, i) => i !== idx); setForm({...form, description_videos: newVids});
                    }} className="p-2 text-zinc-500 hover:text-red-500 bg-zinc-900 border border-zinc-700 rounded"><X className="w-4 h-4"/></button>
                  </div>
                ))}
                <label className="flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl cursor-pointer transition-colors border border-dashed border-zinc-600">
                  <Plus className="w-4 h-4" /> Upload Description Video
                  <input type="file" className="hidden" accept="video/*" multiple onChange={async (e) => {
                    if (e.target.files) {
                      const newUrls = [];
                      for (let i = 0; i < e.target.files.length; i++) {
                        await new Promise<void>(resolve => {
                          handleUploadImage(e.target.files![i], (url) => {
                            newUrls.push(url);
                            resolve();
                          });
                        });
                      }
                      setForm({...form, description_videos: [...(form.description_videos || []), ...newUrls]});
                    }
                  }} />
                </label>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Stores and Other Sites */}
        <SectionCard title="Other Stores & Availability">
          <p className="text-sm text-zinc-400 mb-4">You can list external stores (like Amazon, Noon) where this product is also available.</p>
          {(form.stores || []).map((store: any, idx: number) => (
            <div key={idx} className="flex gap-2 mb-2 p-3 bg-zinc-800/30 border border-zinc-700 rounded-xl">
              <input type="text" placeholder="Store Name (e.g. Amazon)" value={store.name} onChange={e => {
                const newS = [...form.stores]; newS[idx].name = e.target.value; setForm({...form, stores: newS});
              }} className="w-1/4 bg-zinc-900 border border-zinc-700 rounded p-2 text-white" />
              <input type="text" placeholder="Store Link (URL)" value={store.url} onChange={e => {
                const newS = [...form.stores]; newS[idx].url = e.target.value; setForm({...form, stores: newS});
              }} className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-white" />
              <input type="number" placeholder="Price (IQD)" value={store.price} onChange={e => {
                const newS = [...form.stores]; newS[idx].price = parseFloat(e.target.value) || 0; setForm({...form, stores: newS});
              }} className="w-1/4 bg-zinc-900 border border-zinc-700 rounded p-2 text-white" />
              <button onClick={() => {
                const newS = form.stores.filter((_: any, i: number) => i !== idx);
                setForm({...form, stores: newS});
              }} className="p-2 text-zinc-500 hover:text-red-500 bg-zinc-900 border border-zinc-700 rounded"><X className="w-5 h-5"/></button>
            </div>
          ))}
          <button onClick={() => setForm({...form, stores: [...(form.stores||[]), {name: '', url: '', price: 0}]})} className="text-[#6B46FF] text-sm font-bold flex items-center gap-1 mt-4">
            <Plus className="w-4 h-4" /> Add External Store
          </button>
        </SectionCard>

        {/* Images */}
        <SectionCard title="Product Images">
          <div className="flex flex-col gap-3">
            {form.images.map((img, idx) => (
              <div key={idx} className="flex flex-col sm:flex-row items-start sm:items-center gap-2 p-2 bg-zinc-900 border border-zinc-700 rounded">
                <div className="relative">
                  <img src={img || undefined} className="w-16 h-16 rounded object-cover border border-zinc-800" alt={`Product ${idx + 1}`} referrerPolicy="no-referrer" />
                  {idx === 0 && (
                    <div className="absolute -top-2 -right-2 bg-[#6B46FF] text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow">
                      Main
                    </div>
                  )}
                </div>
                <div className="flex-1 text-zinc-400 text-sm truncate px-2">{img}</div>
                <div className="flex items-center gap-1">
                  {idx !== 0 && (
                    <button type="button" onClick={() => {
                      const newImgs = [...form.images];
                      newImgs.splice(idx, 1);
                      newImgs.unshift(img);
                      setForm({...form, images: newImgs});
                    }} className="p-2 text-zinc-400 hover:text-[#6B46FF] hover:bg-zinc-800 rounded transition-colors" title="Set as Main">
                      <Star className="w-4 h-4" />
                    </button>
                  )}
                  <button type="button" disabled={idx === 0} onClick={() => {
                    const newImgs = [...form.images];
                    const temp = newImgs[idx - 1];
                    newImgs[idx - 1] = newImgs[idx];
                    newImgs[idx] = temp;
                    setForm({...form, images: newImgs});
                  }} className="p-2 text-zinc-400 hover:text-white disabled:opacity-30 disabled:hover:text-zinc-400 hover:bg-zinc-800 rounded transition-colors" title="Move Up">
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button type="button" disabled={idx === form.images.length - 1} onClick={() => {
                    const newImgs = [...form.images];
                    const temp = newImgs[idx + 1];
                    newImgs[idx + 1] = newImgs[idx];
                    newImgs[idx] = temp;
                    setForm({...form, images: newImgs});
                  }} className="p-2 text-zinc-400 hover:text-white disabled:opacity-30 disabled:hover:text-zinc-400 hover:bg-zinc-800 rounded transition-colors" title="Move Down">
                    <ChevronDown className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={() => {
                    const newImgs = form.images.filter((_, i) => i !== idx);
                    setForm({...form, images: newImgs});
                  }} className="p-2 text-zinc-500 hover:text-red-500 hover:bg-red-500/10 rounded transition-colors" title="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
            
            <div className="flex gap-2 mt-2">
              <label className="flex-1 flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl border border-dashed border-zinc-600 transition-colors cursor-pointer font-medium">
                <Plus className="w-5 h-5" /> Upload Image
                <input type="file" className="hidden" accept="image/*" onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleUploadImage(e.target.files[0], (url) => {
                      setForm({...form, images: [...form.images, url]});
                    });
                  }
                }} />
              </label>
            </div>
          </div>
        </SectionCard>

        {/* Pricing System */}
        <SectionCard title="Pricing System & Payment">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 pb-6 border-b border-zinc-700">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Base Price (IQD)</label>
              <input type="number" value={form.base_price} onChange={e => setForm({...form, base_price: parseFloat(e.target.value) || 0})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Original Price (IQD)</label>
              <input type="number" value={form.original_price} onChange={e => setForm({...form, original_price: parseFloat(e.target.value) || 0})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Cost (IQD)</label>
              <input type="number" value={form.product_cost} onChange={e => setForm({...form, product_cost: parseFloat(e.target.value) || 0})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6 pb-6 border-b border-zinc-700">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Plus Member Price (IQD)</label>
              <input type="number" value={form.membership_prices.plus} onChange={e => setForm({...form, membership_prices: {...form.membership_prices, plus: parseFloat(e.target.value) || 0}})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Pro Member Price (IQD)</label>
              <input type="number" value={form.membership_prices.pro} onChange={e => setForm({...form, membership_prices: {...form.membership_prices, pro: parseFloat(e.target.value) || 0}})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3">Payment Options</label>
            <div className="flex flex-wrap gap-4">
              {checkoutPaymentMethods.map(method => (
                <label key={method.id} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.payment_options.includes(method.id)} onChange={e => {
                    const newOpts = e.target.checked 
                      ? [...form.payment_options, method.id] 
                      : form.payment_options.filter(o => o !== method.id);
                    setForm({...form, payment_options: newOpts});
                  }} className="w-5 h-5 accent-olive" />
                  <span className="text-white font-medium">{dir === 'rtl' ? method.titleAr : method.titleEn}</span>
                </label>
              ))}
            </div>
          </div>
        </SectionCard>

        {/* Selling Type & Shipping */}
        <SectionCard title="Selling Type & Shipping">
          <div className="flex gap-4 mb-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="selling_type" value="direct_sale" checked={form.selling_type === 'direct_sale'} onChange={() => setForm({...form, selling_type: 'direct_sale'})} className="w-5 h-5 accent-olive" />
              <span className="text-white font-medium">Direct Sale</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="selling_type" value="pre_order" checked={form.selling_type === 'pre_order'} onChange={() => setForm({...form, selling_type: 'pre_order'})} className="w-5 h-5 accent-olive" />
              <span className="text-white font-medium">Pre-Order</span>
            </label>
          </div>

          {form.selling_type === 'pre_order' && (
            <div>
              <h4 className="text-white font-bold mb-3">Pre-Order Shipping Methods</h4>
              {form.shipping_methods.map((method: any, idx) => (
                <div key={idx} className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-3 bg-zinc-900 p-3 rounded border border-zinc-700">
                  <select value={method.id || method.method} onChange={e => {
                    const newM = [...form.shipping_methods];
                    newM[idx].id = e.target.value;
                    newM[idx].method = e.target.value;
                    setForm({...form, shipping_methods: newM});
                  }} className="bg-zinc-900 border border-zinc-700 rounded p-2 text-white">
                    <option value="">Select Method</option>
                    {cartShippingMethods.map(sm => (
                      <option key={sm.id} value={sm.id}>
                        {dir === 'rtl' ? sm.titleAr : sm.titleEn}
                      </option>
                    ))}
                  </select>
                  <input type="text" placeholder="Delivery Time (e.g. 2-3 Days)" value={method.delivery_time} onChange={e => {
                    const newM = [...form.shipping_methods];
                    newM[idx].delivery_time = e.target.value;
                    setForm({...form, shipping_methods: newM});
                  }} className="bg-zinc-900 border border-zinc-700 rounded p-2 text-white" />
                  <input type="number" placeholder="Cost (IQD)" value={method.cost} onChange={e => {
                    const newM = [...form.shipping_methods];
                    newM[idx].cost = parseFloat(e.target.value) || 0;
                    setForm({...form, shipping_methods: newM});
                  }} className="bg-zinc-900 border border-zinc-700 rounded p-2 text-white" />
                  <input type="number" placeholder="Selling Price (IQD)" value={method.price} onChange={e => {
                    const newM = [...form.shipping_methods];
                    newM[idx].price = parseFloat(e.target.value) || 0;
                    setForm({...form, shipping_methods: newM});
                  }} className="bg-zinc-900 border border-zinc-700 rounded p-2 text-white" />
                  <button onClick={() => {
                    const newM = form.shipping_methods.filter((_, i) => i !== idx);
                    setForm({...form, shipping_methods: newM});
                  }} className="bg-zinc-900 text-red-500 border border-zinc-700 rounded p-2 flex justify-center"><Trash2 className="w-5 h-5"/></button>
                </div>
              ))}
              <button onClick={() => setForm({...form, shipping_methods: [...form.shipping_methods, {id: cartShippingMethods[0]?.id || 'direct', method: cartShippingMethods[0]?.id || 'direct', delivery_time: '', cost: 0, price: 0}]})} className="text-[#6B46FF] text-sm font-bold flex items-center gap-1 mt-2">
                <Plus className="w-4 h-4" /> Add Shipping Method
              </button>
            </div>
          )}
        </SectionCard>

        {/* Options */}
        <SectionCard title="Product Options (Size, Storage, etc.)">
          {form.options.map((opt: any, idx) => (
            <div key={idx} className="bg-zinc-900 border border-zinc-700 p-4 rounded-xl mb-4 relative">
              <button onClick={() => {
                const newO = form.options.filter((_, i) => i !== idx);
                setForm({...form, options: newO});
              }} className="absolute top-4 right-4 text-zinc-500 hover:text-red-500"><X className="w-5 h-5"/></button>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 pr-8">
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Option Name EN</label>
                  <input type="text" value={opt.name} onChange={e => {
                    const newO = [...form.options]; newO[idx].name = e.target.value; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Option Name AR</label>
                  <input type="text" value={opt.name_ar} onChange={e => {
                    const newO = [...form.options]; newO[idx].name_ar = e.target.value; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" dir="rtl" />
                </div>
                
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Option Image URL (Optional)</label>
                  <div className="flex gap-2">
                    <div className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-zinc-400 truncate">{opt.image || "No image"}</div>
                    <label className="flex items-center justify-center p-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded cursor-pointer transition-colors">
                      <ImageIcon className="w-5 h-5" />
                      <input type="file" className="hidden" accept="image/*" onChange={(e) => {
                        if (e.target.files && e.target.files[0]) {
                          handleUploadImage(e.target.files[0], (url) => {
                            const newO = [...form.options]; newO[idx].image = url; setForm({...form, options: newO});
                          });
                        }
                      }} />
                    </label>
                  </div>
                </div>

              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Price (IQD)</label>
                  <input type="number" value={opt.price} onChange={e => {
                    const newO = [...form.options]; newO[idx].price = parseFloat(e.target.value) || 0; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Original Price (IQD)</label>
                  <input type="number" value={opt.original_price} onChange={e => {
                    const newO = [...form.options]; newO[idx].original_price = parseFloat(e.target.value) || 0; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Cost (IQD)</label>
                  <input type="number" value={opt.cost} onChange={e => {
                    const newO = [...form.options]; newO[idx].cost = parseFloat(e.target.value) || 0; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Pro Price (IQD)</label>
                  <input type="number" value={opt.pro_price} onChange={e => {
                    const newO = [...form.options]; newO[idx].pro_price = parseFloat(e.target.value) || 0; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
              </div>
            </div>
          ))}
          <button onClick={() => setForm({...form, options: [...form.options, { id: 'opt_'+Date.now(), name: '', name_ar: '', image: '', price: 0, original_price: 0, cost: 0, pro_price: 0 }]})} className="flex items-center justify-center gap-2 p-3 w-full bg-zinc-800 hover:bg-zinc-800 text-zinc-200 rounded border border-dashed border-zinc-600 transition-colors">
            <Plus className="w-4 h-4" /> Add Option
          </button>
        </SectionCard>

        {/* Colors */}
        <SectionCard title="Product Colors">
          {form.colors.map((col: any, idx) => (
            <div key={idx} className="bg-zinc-900 border border-zinc-700 p-4 rounded-xl mb-4 relative">
              <button onClick={() => {
                const newC = form.colors.filter((_, i) => i !== idx);
                setForm({...form, colors: newC});
              }} className="absolute top-4 right-4 text-zinc-500 hover:text-red-500"><X className="w-5 h-5"/></button>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 pr-8">
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Color Name EN</label>
                  <input type="text" value={col.name} onChange={e => {
                    const newC = [...form.colors]; newC[idx].name = e.target.value; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Color Name AR</label>
                  <input type="text" value={col.name_ar} onChange={e => {
                    const newC = [...form.colors]; newC[idx].name_ar = e.target.value; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" dir="rtl" />
                </div>
                
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Color Image URL (Optional)</label>
                  <div className="flex gap-2">
                    <div className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-zinc-400 truncate">{col.image || "No image"}</div>
                    <label className="flex items-center justify-center p-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded cursor-pointer transition-colors">
                      <ImageIcon className="w-5 h-5" />
                      <input type="file" className="hidden" accept="image/*" onChange={(e) => {
                        if (e.target.files && e.target.files[0]) {
                          handleUploadImage(e.target.files[0], (url) => {
                            const newC = [...form.colors]; newC[idx].image = url; setForm({...form, colors: newC});
                          });
                        }
                      }} />
                    </label>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Link to Option (Optional)</label>
                  <select value={col.option_id || ''} onChange={e => {
                    const newC = [...form.colors]; newC[idx].option_id = e.target.value; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none">
                    <option value="">All Options</option>
                    {form.options.map(o => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">HEX Value (e.g. #000000)</label>
                  <div className="flex gap-2">
                    <input type="color" value={col.hex || '#ffffff'} onChange={e => {
                      const newC = [...form.colors]; newC[idx].hex = e.target.value; setForm({...form, colors: newC});
                    }} className="w-12 h-12 rounded cursor-pointer bg-zinc-900 border border-zinc-700 p-1" />
                    <input type="text" value={col.hex || ''} onChange={e => {
                      const newC = [...form.colors]; newC[idx].hex = e.target.value; setForm({...form, colors: newC});
                    }} className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Gradient HEX (Optional, e.g. #000,#fff)</label>
                  <input type="text" value={col.gradient || ''} onChange={e => {
                    const newC = [...form.colors]; newC[idx].gradient = e.target.value; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
              </div>

              <div className="mb-4">
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Link to Specific Options (Leave empty for all)</label>
                <div className="flex flex-wrap gap-2">
                  {form.options.map((opt: any) => (
                    <label key={opt.id} className="flex items-center gap-1.5 bg-zinc-900 px-3 py-1.5 rounded-full border border-zinc-700 cursor-pointer">
                      <input type="checkbox" checked={col.linked_option_ids?.includes(opt.id) || false} onChange={e => {
                        const newC = [...form.colors];
                        const linked = newC[idx].linked_option_ids || [];
                        if (e.target.checked) newC[idx].linked_option_ids = [...linked, opt.id];
                        else newC[idx].linked_option_ids = linked.filter((id: string) => id !== opt.id);
                        setForm({...form, colors: newC});
                      }} className="accent-olive" />
                      <span className="text-sm text-zinc-200">{opt.name || 'Unnamed Option'}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Price (IQD)</label>
                  <input type="number" value={col.price} onChange={e => {
                    const newC = [...form.colors]; newC[idx].price = parseFloat(e.target.value) || 0; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Original Price (IQD)</label>
                  <input type="number" value={col.original_price} onChange={e => {
                    const newC = [...form.colors]; newC[idx].original_price = parseFloat(e.target.value) || 0; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Cost (IQD)</label>
                  <input type="number" value={col.cost} onChange={e => {
                    const newC = [...form.colors]; newC[idx].cost = parseFloat(e.target.value) || 0; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Pro Price (IQD)</label>
                  <input type="number" value={col.pro_price} onChange={e => {
                    const newC = [...form.colors]; newC[idx].pro_price = parseFloat(e.target.value) || 0; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>
              </div>
            </div>
          ))}
          <button onClick={() => setForm({...form, colors: [...form.colors, { id: 'col_'+Date.now(), name: '', hex: '', gradient: '', image: '', linked_option_ids: [], price: 0, original_price: 0, cost: 0 }]})} className="flex items-center justify-center gap-2 p-3 w-full bg-zinc-800 hover:bg-zinc-800 text-zinc-200 rounded border border-dashed border-zinc-600 transition-colors">
            <Plus className="w-4 h-4" /> Add Color
          </button>
        </SectionCard>

        {/* Specifications */}
        <SectionCard title="Features & Specifications">
          {form.specifications.map((spec: any, idx) => (
            <div key={idx} className="flex gap-2 mb-2">
              <input type="text" placeholder="Key (e.g. Brand)" value={spec.key} onChange={e => {
                const newS = [...form.specifications]; newS[idx].key = e.target.value; setForm({...form, specifications: newS});
              }} className="w-1/3 bg-zinc-900 border border-zinc-700 rounded p-2 text-white" />
              <input type="text" placeholder="Value (e.g. Apple)" value={spec.value} onChange={e => {
                const newS = [...form.specifications]; newS[idx].value = e.target.value; setForm({...form, specifications: newS});
              }} className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-white" />
              <button onClick={() => {
                const newS = form.specifications.filter((_, i) => i !== idx);
                setForm({...form, specifications: newS});
              }} className="p-2 text-zinc-500 hover:text-red-500 bg-zinc-900 border border-zinc-700 rounded"><X className="w-5 h-5"/></button>
            </div>
          ))}
          <button onClick={() => setForm({...form, specifications: [...form.specifications, {key: '', value: ''}]})} className="text-[#6B46FF] text-sm font-bold flex items-center gap-1 mt-4">
            <Plus className="w-4 h-4" /> Add Specification
          </button>
        </SectionCard>
        {isPreviewOpen && <ProductPreviewModal form={form} onClose={() => setIsPreviewOpen(false)} dir={dir} />}
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Manage Products</h2>
        <button onClick={() => openEditor()} className="flex items-center gap-2 bg-[#6B46FF] hover:bg-[#6B46FF]-light text-black px-4 py-2 rounded-xl transition-all font-bold shadow-lg hover:shadow-olive/20">
          <Plus className="w-4 h-4" />
          Add Product
        </button>
      </div>

      <div className="grid gap-4">
        {products.length === 0 && (
          <div className="text-center py-12 text-zinc-500 bg-zinc-800/20 rounded-xl border border-zinc-800/50">
            No products found.
          </div>
        )}
        {products.map(p => {
          const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();
          const firstImage = images[0] || 'https://via.placeholder.com/40';
          return (
            <div key={p.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-zinc-800/30 rounded-xl transition-colors group">
              <div className="flex items-center gap-4 flex-1">
                <img referrerPolicy="no-referrer" src={firstImage || undefined} className="w-16 h-16 rounded-lg object-cover border border-zinc-700 bg-zinc-900" alt="" />
                <div className="flex flex-col">
                  <span className="font-bold text-white text-base line-clamp-1">{language === 'ar' && p.name_ar ? p.name_ar : p.name}</span>
                  <span className="text-xs text-zinc-500 line-clamp-1">{p.slug}</span>
                  {p.is_featured && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-[#6B46FF] mt-1 w-fit bg-[#6B46FF]/10 px-1.5 py-0.5 rounded border border-olive/20">
                      <Check className="w-3 h-3" /> Featured
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-6 sm:gap-8 lg:border-l lg:border-zinc-700 lg:pl-6">
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Type</span>
                  <span className="text-sm text-zinc-200 capitalize font-medium">{p.selling_type.replace('_', ' ')}</span>
                </div>

                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Base Price</span>
                  <span className="text-white font-bold text-base whitespace-nowrap">
                    {(p.base_price * exchangeRate).toLocaleString('en-US', { minimumFractionDigits: 0 })} <span className="text-xs text-zinc-500">IQD</span>
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button onClick={() => openEditor(p)} className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors border border-transparent hover:border-zinc-600" title="Edit">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(p.id)} className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors border border-transparent hover:border-red-500/20" title="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  );
}
