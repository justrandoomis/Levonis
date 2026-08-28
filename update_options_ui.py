import re

with open('src/components/AdminProducts.tsx', 'r') as f:
    content = f.read()

# Replace Option UI
option_ui_old = """                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Option Name (e.g. 128GB)</label>
                  <input type="text" value={opt.name} onChange={e => {
                    const newO = [...form.options]; newO[idx].name = e.target.value; setForm({...form, options: newO});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>"""

option_ui_new = """                <div>
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
                </div>"""

content = content.replace(option_ui_old, option_ui_new)

option_prices_old = """              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
              </div>"""

option_prices_new = """              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
              </div>"""
content = content.replace(option_prices_old, option_prices_new)


with open('src/components/AdminProducts.tsx', 'w') as f:
    f.write(content)
