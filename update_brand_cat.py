import re

with open('src/components/AdminProducts.tsx', 'r') as f:
    content = f.read()

# Make brand a select
brand_old = """            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Brand</label>
              <input type="text" value={form.brand || ''} onChange={e => setForm({...form, brand: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
              {uniqueBrands.length > 0 && renderSingleChips(uniqueBrands, form.brand || '', (val) => setForm({...form, brand: val}))}
            </div>"""

brand_new = """            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Brand</label>
              <select value={form.brand || ''} onChange={e => setForm({...form, brand: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none">
                <option value="">Select Brand</option>
                {uniqueBrands.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              <div className="mt-2 flex gap-2">
                 <input type="text" placeholder="Or add new brand..." id="new_brand_input" className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-white text-xs" />
                 <button type="button" onClick={() => {
                   const input = document.getElementById('new_brand_input') as HTMLInputElement;
                   if (input && input.value) setForm({...form, brand: input.value});
                 }} className="bg-zinc-800 px-3 py-2 rounded text-xs">Set New</button>
              </div>
            </div>"""

content = content.replace(brand_old, brand_new)

cat_old = """            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Categories (comma separated)</label>
              <input type="text" value={form.categories || ''} onChange={e => setForm({...form, categories: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
              {uniqueCategories.length > 0 && renderMultiStringChips(uniqueCategories, form.categories || '', (val) => setForm({...form, categories: val}))}
            </div>"""

cat_new = """            <div>
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Categories / Catalogs (comma separated)</label>
              <input type="text" value={form.categories || ''} onChange={e => setForm({...form, categories: e.target.value})} className="w-full bg-zinc-800/30 border border-zinc-700 rounded-xl p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
              {uniqueCategories.length > 0 && renderMultiStringChips(uniqueCategories, form.categories || '', (val) => setForm({...form, categories: val}))}
            </div>"""

content = content.replace(cat_old, cat_new)


with open('src/components/AdminProducts.tsx', 'w') as f:
    f.write(content)
