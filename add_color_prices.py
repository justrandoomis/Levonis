import re

with open('src/components/AdminProducts.tsx', 'r') as f:
    content = f.read()

color_prices_code = """              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
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
              </div>"""

content = content.replace("</div>\n            </div>\n          ))}\n          <button onClick={() => setForm({...form, colors:", color_prices_code + "\n            </div>\n          ))}\n          <button onClick={() => setForm({...form, colors:")


with open('src/components/AdminProducts.tsx', 'w') as f:
    f.write(content)
