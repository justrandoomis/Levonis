import re

with open('src/components/AdminProducts.tsx', 'r') as f:
    content = f.read()

color_name_old = """                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Color Name</label>
                  <input type="text" value={col.name} onChange={e => {
                    const newC = [...form.colors]; newC[idx].name = e.target.value; setForm({...form, colors: newC});
                  }} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-[#6B46FF] focus:outline-none" />
                </div>"""

color_name_new = """                <div>
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
                </div>"""
content = content.replace(color_name_old, color_name_new)

color_hex_old = """                <div>
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">HEX Value (e.g. #000000)</label>"""

color_hex_new = """                <div>
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
                  <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">HEX Value (e.g. #000000)</label>"""

content = content.replace(color_hex_old, color_hex_new)


with open('src/components/AdminProducts.tsx', 'w') as f:
    f.write(content)
