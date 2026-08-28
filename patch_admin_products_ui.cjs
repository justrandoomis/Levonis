const fs = require('fs');
let content = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const inputsTarget = `          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Name (English)</label>
              <input type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Name (Arabic)</label>
              <input type="text" value={form.name_ar} onChange={e => setForm({...form, name_ar: e.target.value})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none text-right" dir="rtl" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Slug (SEO)</label>
              <input type="text" value={form.slug} onChange={e => setForm({...form, slug: e.target.value})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div className="md:col-span-1">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description (English)</label>
              <textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none h-32" />
            </div>
            <div className="md:col-span-1">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description (Arabic)</label>
              <textarea value={form.description_ar} onChange={e => setForm({...form, description_ar: e.target.value})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none h-32 text-right" dir="rtl" />
            </div>`;

const inputsNew = `          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Product Name (Arabic)</label>
              <input type="text" value={form.name_ar} onChange={e => setForm({...form, name_ar: e.target.value, name: ''})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none text-right" dir="rtl" placeholder="اسم المنتج" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Slug (SEO)</label>
              <input type="text" value={form.slug} onChange={e => setForm({...form, slug: e.target.value})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Description (Arabic)</label>
              <textarea value={form.description_ar} onChange={e => setForm({...form, description_ar: e.target.value, description: ''})} className="w-full bg-black border border-zinc-800 rounded p-3 text-white focus:border-olive focus:outline-none h-32 text-right" dir="rtl" placeholder="وصف المنتج" />
            </div>`;

content = content.replace(inputsTarget, inputsNew);
fs.writeFileSync('src/components/AdminProducts.tsx', content);
