const fs = require('fs');

const code = `
import React, { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, ChevronDown, ChevronUp, Image as ImageIcon, X, Save, ArrowLeft, Check } from 'lucide-react';
import { queryDb } from '../lib/db';
import { useWallet } from '../WalletContext';

const initialForm = {
  id: '',
  name: '',
  slug: '',
  description: '',
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
  specifications: []
};

const SectionCard = ({ title, children, defaultOpen = false }: { title: string, children: React.ReactNode, defaultOpen?: boolean }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden mb-6">
      <button 
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex justify-between items-center p-4 bg-zinc-900 hover:bg-zinc-800 transition-colors"
      >
        <h3 className="font-bold text-white">{title}</h3>
        {isOpen ? <ChevronUp className="w-5 h-5 text-zinc-500" /> : <ChevronDown className="w-5 h-5 text-zinc-500" />}
      </button>
      {isOpen && <div className="p-4">{children}</div>}
    </div>
  );
};

export default function AdminProducts() {
  const [products, setProducts] = useState<any[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState(initialForm);
  const { exchangeRate } = useWallet();

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

  const handleSave = async () => {
    try {
      const id = form.id || Math.random().toString(36).substr(2, 9);
      
      const sql = \`
        INSERT INTO products (id, name, slug, description, images, options, colors, selling_type, shipping_methods, base_price, original_price, product_cost, membership_prices, payment_options, subcategory_id, display_order, is_featured, specifications)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, slug=excluded.slug, description=excluded.description, images=excluded.images,
          options=excluded.options, colors=excluded.colors, selling_type=excluded.selling_type, shipping_methods=excluded.shipping_methods,
          base_price=excluded.base_price, original_price=excluded.original_price, product_cost=excluded.product_cost,
          membership_prices=excluded.membership_prices, payment_options=excluded.payment_options, subcategory_id=excluded.subcategory_id,
          display_order=excluded.display_order, is_featured=excluded.is_featured, specifications=excluded.specifications
      \`;

      await queryDb(sql, [
        id, form.name, form.slug, form.description, JSON.stringify(form.images), JSON.stringify(form.options),
        JSON.stringify(form.colors), form.selling_type, JSON.stringify(form.shipping_methods),
        form.base_price, form.original_price, form.product_cost, JSON.stringify(form.membership_prices),
        JSON.stringify(form.payment_options), form.subcategory_id, form.display_order, form.is_featured ? 1 : 0,
        JSON.stringify(form.specifications)
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
      setForm({
        ...prod,
        images: JSON.parse(prod.images || '[]'),
        options: JSON.parse(prod.options || '[]'),
        colors: JSON.parse(prod.colors || '[]'),
        shipping_methods: JSON.parse(prod.shipping_methods || '[]'),
        membership_prices: JSON.parse(prod.membership_prices || '{"plus":0,"pro":0}'),
        payment_options: JSON.parse(prod.payment_options || '["full"]'),
        specifications: JSON.parse(prod.specifications || '[]'),
        is_featured: !!prod.is_featured
      });
    } else {
      setForm(initialForm);
    }
    setIsEditing(true);
  };

  if (isEditing) {
    return (
      <div>
        <div className="flex items-center justify-between mb-6">
          <button onClick={() => setIsEditing(false)} className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <button onClick={handleSave} className="flex items-center gap-2 bg-olive text-white px-6 py-2 rounded-lg font-bold hover:bg-olive/90 transition-colors">
            <Save className="w-4 h-4" /> Save Product
          </button>
        </div>

        {/* General Info */}
        <SectionCard title="General Information" defaultOpen>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Name</label>
              <input type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Slug (SEO)</label>
              <input type="text" value={form.slug} onChange={e => setForm({...form, slug: e.target.value})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description</label>
              <textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none h-32" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Subcategory ID</label>
              <input type="text" value={form.subcategory_id} onChange={e => setForm({...form, subcategory_id: e.target.value})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div className="flex items-center gap-6">
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Display Order</label>
                <input type="number" value={form.display_order} onChange={e => setForm({...form, display_order: parseInt(e.target.value) || 0})} className="w-32 bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
              </div>
              <label className="flex items-center gap-2 mt-6 cursor-pointer">
                <input type="checkbox" checked={form.is_featured} onChange={e => setForm({...form, is_featured: e.target.checked})} className="w-5 h-5 accent-olive" />
                <span className="text-white font-medium">Featured Product</span>
              </label>
            </div>
          </div>
        </SectionCard>

        {/* Images */}
        <SectionCard title="Product Images">
          <div className="flex flex-col gap-3">
            {form.images.map((img, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <input type="text" placeholder="Image URL" value={img} onChange={e => {
                  const newImgs = [...form.images];
                  newImgs[idx] = e.target.value;
                  setForm({...form, images: newImgs});
                }} className="flex-1 bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                <button onClick={() => {
                  const newImgs = form.images.filter((_, i) => i !== idx);
                  setForm({...form, images: newImgs});
                }} className="p-3 text-zinc-500 hover:text-red-500 bg-black border border-zinc-800 rounded"><Trash2 className="w-5 h-5"/></button>
              </div>
            ))}
            <button onClick={() => setForm({...form, images: [...form.images, '']})} className="flex items-center justify-center gap-2 p-3 bg-zinc-800/50 hover:bg-zinc-800 text-zinc-300 rounded border border-dashed border-zinc-700 transition-colors">
              <Plus className="w-4 h-4" /> Add Image URL
            </button>
          </div>
        </SectionCard>

        {/* Pricing System */}
        <SectionCard title="Pricing System & Payment">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 pb-6 border-b border-zinc-800">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Base Price ($)</label>
              <input type="number" value={form.base_price} onChange={e => setForm({...form, base_price: parseFloat(e.target.value) || 0})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Original Price ($)</label>
              <input type="number" value={form.original_price} onChange={e => setForm({...form, original_price: parseFloat(e.target.value) || 0})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Cost ($)</label>
              <input type="number" value={form.product_cost} onChange={e => setForm({...form, product_cost: parseFloat(e.target.value) || 0})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6 pb-6 border-b border-zinc-800">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Plus Member Price ($)</label>
              <input type="number" value={form.membership_prices.plus} onChange={e => setForm({...form, membership_prices: {...form.membership_prices, plus: parseFloat(e.target.value) || 0}})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Pro Member Price ($)</label>
              <input type="number" value={form.membership_prices.pro} onChange={e => setForm({...form, membership_prices: {...form.membership_prices, pro: parseFloat(e.target.value) || 0}})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3">Payment Options</label>
            <div className="flex gap-4">
              {['full', 'deposit_50', 'cod'].map(opt => (
                <label key={opt} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.payment_options.includes(opt)} onChange={e => {
                    const newOpts = e.target.checked 
                      ? [...form.payment_options, opt] 
                      : form.payment_options.filter(o => o !== opt);
                    setForm({...form, payment_options: newOpts});
                  }} className="w-5 h-5 accent-olive" />
                  <span className="text-white font-medium capitalize">{opt.replace('_', ' ')}</span>
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
                <div key={idx} className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-3 bg-black p-3 rounded border border-zinc-800">
                  <select value={method.method} onChange={e => {
                    const newM = [...form.shipping_methods];
                    newM[idx].method = e.target.value;
                    setForm({...form, shipping_methods: newM});
                  }} className="bg-zinc-900 border border-zinc-800 rounded p-2 text-white">
                    <option value="standard">Standard</option>
                    <option value="express">Express</option>
                    <option value="economy">Economy</option>
                  </select>
                  <input type="text" placeholder="Delivery Time (e.g. 2-3 Days)" value={method.delivery_time} onChange={e => {
                    const newM = [...form.shipping_methods];
                    newM[idx].delivery_time = e.target.value;
                    setForm({...form, shipping_methods: newM});
                  }} className="bg-zinc-900 border border-zinc-800 rounded p-2 text-white" />
                  <input type="number" placeholder="Cost ($)" value={method.cost} onChange={e => {
                    const newM = [...form.shipping_methods];
                    newM[idx].cost = parseFloat(e.target.value) || 0;
                    setForm({...form, shipping_methods: newM});
                  }} className="bg-zinc-900 border border-zinc-800 rounded p-2 text-white" />
                  <input type="number" placeholder="Selling Price ($)" value={method.price} onChange={e => {
                    const newM = [...form.shipping_methods];
                    newM[idx].price = parseFloat(e.target.value) || 0;
                    setForm({...form, shipping_methods: newM});
                  }} className="bg-zinc-900 border border-zinc-800 rounded p-2 text-white" />
                  <button onClick={() => {
                    const newM = form.shipping_methods.filter((_, i) => i !== idx);
                    setForm({...form, shipping_methods: newM});
                  }} className="bg-zinc-900 text-red-500 border border-zinc-800 rounded p-2 flex justify-center"><Trash2 className="w-5 h-5"/></button>
                </div>
              ))}
              <button onClick={() => setForm({...form, shipping_methods: [...form.shipping_methods, {method: 'standard', delivery_time: '', cost: 0, price: 0}]})} className="text-olive text-sm font-bold flex items-center gap-1 mt-2">
                <Plus className="w-4 h-4" /> Add Shipping Method
              </button>
            </div>
          )}
        </SectionCard>

        {/* Options */}
        <SectionCard title="Product Options (Size, Storage, etc.)">
          {form.options.map((opt: any, idx) => (
            <div key={idx} className="bg-black border border-zinc-800 p-4 rounded-xl mb-4 relative">
              <button onClick={() => {
                const newO = form.options.filter((_, i) => i !== idx);
                setForm({...form, options: newO});
              }} className="absolute top-4 right-4 text-zinc-500 hover:text-red-500"><X className="w-5 h-5"/></button>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 pr-8">
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Option Name (e.g. 128GB)</label>
                  <input type="text" value={opt.name} onChange={e => {
                    const newO = [...form.options]; newO[idx].name = e.target.value; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Option Image URL (Optional)</label>
                  <input type="text" value={opt.image || ''} onChange={e => {
                    const newO = [...form.options]; newO[idx].image = e.target.value; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Price ($)</label>
                  <input type="number" value={opt.price} onChange={e => {
                    const newO = [...form.options]; newO[idx].price = parseFloat(e.target.value) || 0; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Original Price ($)</label>
                  <input type="number" value={opt.original_price} onChange={e => {
                    const newO = [...form.options]; newO[idx].original_price = parseFloat(e.target.value) || 0; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Cost ($)</label>
                  <input type="number" value={opt.cost} onChange={e => {
                    const newO = [...form.options]; newO[idx].cost = parseFloat(e.target.value) || 0; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
              </div>
            </div>
          ))}
          <button onClick={() => setForm({...form, options: [...form.options, { id: 'opt_'+Date.now(), name: '', image: '', price: 0, original_price: 0, cost: 0 }]})} className="flex items-center justify-center gap-2 p-3 w-full bg-zinc-800/50 hover:bg-zinc-800 text-zinc-300 rounded border border-dashed border-zinc-700 transition-colors">
            <Plus className="w-4 h-4" /> Add Option
          </button>
        </SectionCard>

        {/* Colors */}
        <SectionCard title="Product Colors">
          {form.colors.map((col: any, idx) => (
            <div key={idx} className="bg-black border border-zinc-800 p-4 rounded-xl mb-4 relative">
              <button onClick={() => {
                const newC = form.colors.filter((_, i) => i !== idx);
                setForm({...form, colors: newC});
              }} className="absolute top-4 right-4 text-zinc-500 hover:text-red-500"><X className="w-5 h-5"/></button>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 pr-8">
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Color Name</label>
                  <input type="text" value={col.name} onChange={e => {
                    const newC = [...form.colors]; newC[idx].name = e.target.value; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Color Image URL (Optional)</label>
                  <input type="text" value={col.image || ''} onChange={e => {
                    const newC = [...form.colors]; newC[idx].image = e.target.value; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">HEX Value (e.g. #000000)</label>
                  <div className="flex gap-2">
                    <input type="color" value={col.hex || '#ffffff'} onChange={e => {
                      const newC = [...form.colors]; newC[idx].hex = e.target.value; setForm({...form, colors: newC});
                    }} className="w-12 h-12 rounded cursor-pointer bg-zinc-900 border border-zinc-800 p-1" />
                    <input type="text" value={col.hex || ''} onChange={e => {
                      const newC = [...form.colors]; newC[idx].hex = e.target.value; setForm({...form, colors: newC});
                    }} className="flex-1 bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Gradient HEX (Optional, e.g. #000,#fff)</label>
                  <input type="text" value={col.gradient || ''} onChange={e => {
                    const newC = [...form.colors]; newC[idx].gradient = e.target.value; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
              </div>

              <div className="mb-4">
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Link to Specific Options (Leave empty for all)</label>
                <div className="flex flex-wrap gap-2">
                  {form.options.map((opt: any) => (
                    <label key={opt.id} className="flex items-center gap-1.5 bg-zinc-900 px-3 py-1.5 rounded-full border border-zinc-800 cursor-pointer">
                      <input type="checkbox" checked={col.linked_option_ids?.includes(opt.id) || false} onChange={e => {
                        const newC = [...form.colors];
                        const linked = newC[idx].linked_option_ids || [];
                        if (e.target.checked) newC[idx].linked_option_ids = [...linked, opt.id];
                        else newC[idx].linked_option_ids = linked.filter((id: string) => id !== opt.id);
                        setForm({...form, colors: newC});
                      }} className="accent-olive" />
                      <span className="text-sm text-zinc-300">{opt.name || 'Unnamed Option'}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Price ($)</label>
                  <input type="number" value={col.price} onChange={e => {
                    const newC = [...form.colors]; newC[idx].price = parseFloat(e.target.value) || 0; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Original Price ($)</label>
                  <input type="number" value={col.original_price} onChange={e => {
                    const newC = [...form.colors]; newC[idx].original_price = parseFloat(e.target.value) || 0; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Cost ($)</label>
                  <input type="number" value={col.cost} onChange={e => {
                    const newC = [...form.colors]; newC[idx].cost = parseFloat(e.target.value) || 0; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
                </div>
              </div>
            </div>
          ))}
          <button onClick={() => setForm({...form, colors: [...form.colors, { id: 'col_'+Date.now(), name: '', hex: '', gradient: '', image: '', linked_option_ids: [], price: 0, original_price: 0, cost: 0 }]})} className="flex items-center justify-center gap-2 p-3 w-full bg-zinc-800/50 hover:bg-zinc-800 text-zinc-300 rounded border border-dashed border-zinc-700 transition-colors">
            <Plus className="w-4 h-4" /> Add Color
          </button>
        </SectionCard>

        {/* Specifications */}
        <SectionCard title="Features & Specifications">
          {form.specifications.map((spec: any, idx) => (
            <div key={idx} className="flex gap-2 mb-2">
              <input type="text" placeholder="Key (e.g. Brand)" value={spec.key} onChange={e => {
                const newS = [...form.specifications]; newS[idx].key = e.target.value; setForm({...form, specifications: newS});
              }} className="w-1/3 bg-black border border-zinc-800 rounded p-2 text-white" />
              <input type="text" placeholder="Value (e.g. Apple)" value={spec.value} onChange={e => {
                const newS = [...form.specifications]; newS[idx].value = e.target.value; setForm({...form, specifications: newS});
              }} className="flex-1 bg-black border border-zinc-800 rounded p-2 text-white" />
              <button onClick={() => {
                const newS = form.specifications.filter((_, i) => i !== idx);
                setForm({...form, specifications: newS});
              }} className="p-2 text-zinc-500 hover:text-red-500 bg-black border border-zinc-800 rounded"><X className="w-5 h-5"/></button>
            </div>
          ))}
          <button onClick={() => setForm({...form, specifications: [...form.specifications, {key: '', value: ''}]})} className="text-olive text-sm font-bold flex items-center gap-1 mt-4">
            <Plus className="w-4 h-4" /> Add Specification
          </button>
        </SectionCard>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Manage Products</h2>
        <button onClick={() => openEditor()} className="flex items-center gap-2 bg-olive hover:bg-olive-light text-white px-4 py-2 rounded-lg transition-colors font-medium">
          <Plus className="w-4 h-4" />
          Add Product
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500">
              <th className="pb-3 px-4 font-medium">Product</th>
              <th className="pb-3 px-4 font-medium">Type</th>
              <th className="pb-3 px-4 font-medium">Base Price</th>
              <th className="pb-3 px-4 font-medium">Featured</th>
              <th className="pb-3 px-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8 text-zinc-500">No products found.</td></tr>
            )}
            {products.map(p => {
              const images = JSON.parse(p.images || '[]');
              const firstImage = images[0] || 'https://via.placeholder.com/40';
              return (
                <tr key={p.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
                  <td className="py-4 px-4 text-white font-medium flex items-center gap-3">
                    <img src={firstImage} className="w-10 h-10 rounded object-cover border border-zinc-800" alt="" />
                    <div>
                      <div className="font-bold">{p.name}</div>
                      <div className="text-xs text-zinc-500">{p.slug}</div>
                    </div>
                  </td>
                  <td className="py-4 px-4 text-sm text-zinc-400 capitalize">{p.selling_type.replace('_', ' ')}</td>
                  <td className="py-4 px-4 text-gold font-bold">
                    \${p.base_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="py-4 px-4">
                    {p.is_featured ? <Check className="w-5 h-5 text-olive" /> : <X className="w-5 h-5 text-zinc-600" />}
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => openEditor(p)} className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors"><Edit2 className="w-4 h-4" /></button>
                      <button onClick={() => handleDelete(p.id)} className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
`;

fs.writeFileSync('src/components/AdminProducts.tsx', code);
