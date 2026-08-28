const fs = require('fs');
let content = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

// 1. We need to add a "Translating..." state and a handleAutoTranslate function.
const stateTarget = `  const { exchangeRate } = useWallet();`;
const stateNew = `  const { exchangeRate } = useWallet();
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
      if (form.name_ar) {
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: form.name_ar, targetLang: 'en' })
        });
        const data = await res.json();
        if (data.success && data.translation) newName = data.translation;
      }
      if (form.description_ar) {
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: form.description_ar, targetLang: 'en' })
        });
        const data = await res.json();
        if (data.success && data.translation) newDesc = data.translation;
      }
      setForm({ ...form, name: newName, description: newDesc, slug: newName.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
    } catch (e) {
      console.error(e);
      alert("Translation failed");
    } finally {
      setIsTranslating(false);
    }
  };`;

content = content.replace(stateTarget, stateNew);

// 2. Change the save function to divide price by exchangeRate
const saveTarget = `        form.base_price, form.original_price, form.product_cost, JSON.stringify(form.membership_prices),`;
const saveNew = `        form.base_price / exchangeRate, form.original_price / exchangeRate, form.product_cost / exchangeRate, JSON.stringify(form.membership_prices),`;

content = content.replace(saveTarget, saveNew);

// 3. Change edit function to multiply by exchangeRate
const editTarget = `    setForm({
      ...p,
      name_ar: p.name_ar || '',
      description_ar: p.description_ar || ''
    });`;
const editNew = `    setForm({
      ...p,
      name_ar: p.name_ar || '',
      description_ar: p.description_ar || '',
      base_price: (p.base_price || 0) * exchangeRate,
      original_price: (p.original_price || 0) * exchangeRate,
      product_cost: (p.product_cost || 0) * exchangeRate
    });`;

content = content.replace(editTarget, editNew);

// 4. Update the input labels and add the Auto Translate button
const formTarget = `          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Name (English)</label>`;
const formNew = `          <div className="flex justify-between items-center mb-4">
            <h4 className="text-white font-bold">Product Details</h4>
            <button type="button" onClick={handleAutoTranslate} disabled={isTranslating} className="bg-olive/20 hover:bg-olive/30 text-gold px-3 py-1.5 rounded text-sm font-medium transition-colors border border-olive/30">
              {isTranslating ? 'Translating...' : '🪄 Auto Translate (AR to EN)'}
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Name (English)</label>`;

content = content.replace(formTarget, formNew);

// 5. Update price input labels
const priceTarget = `            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Base Price ($)</label>
              <input type="number" value={form.base_price} onChange={e => setForm({...form, base_price: parseFloat(e.target.value) || 0})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Original Price ($)</label>
              <input type="number" value={form.original_price} onChange={e => setForm({...form, original_price: parseFloat(e.target.value) || 0})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Cost ($)</label>`;

const priceNew = `            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Base Price (IQD)</label>
              <input type="number" value={form.base_price} onChange={e => setForm({...form, base_price: parseFloat(e.target.value) || 0})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Original Price (IQD)</label>
              <input type="number" value={form.original_price} onChange={e => setForm({...form, original_price: parseFloat(e.target.value) || 0})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Cost (IQD)</label>`;

content = content.replace(priceTarget, priceNew);

// 6. Fix table display for prices to display appropriately? Wait, in the Admin panel it used to show $. Let's keep it as is, or show IQD?
// User said "السعر يكتبه بالدينار العراقي والنظام يحوله للدولار عند قيام المستخدم بتحويل العمله"
// This implies they just write it in IQD.
// Let's modify the admin table to show IQD if we want, but showing USD is fine as it's the internal base price.

fs.writeFileSync('src/components/AdminProducts.tsx', content);
