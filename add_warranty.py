import re

with open('src/components/AdminProducts.tsx', 'r') as f:
    content = f.read()

warranty_and_how_to_use_code = """
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
"""

content = content.replace("{/* Description Rich Media */}", warranty_and_how_to_use_code + "\n        {/* Description Rich Media */}")

with open('src/components/AdminProducts.tsx', 'w') as f:
    f.write(content)
