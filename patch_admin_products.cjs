const fs = require('fs');
let content = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const target = `      <div className="overflow-x-auto">
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
                      <div className="font-bold">{language === 'ar' && p.name_ar ? p.name_ar : p.name}</div>
                      <div className="text-xs text-zinc-500">{p.slug}</div>
                    </div>
                  </td>
                  <td className="py-4 px-4 text-sm text-zinc-400 capitalize">{p.selling_type.replace('_', ' ')}</td>
                  <td className="py-4 px-4 text-gold font-bold">
                    IQD {(p.base_price * exchangeRate).toLocaleString('en-US', { minimumFractionDigits: 0 })}
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
      </div>`;

const replacement = `      <div className="grid gap-4">
        {products.length === 0 && (
          <div className="text-center py-12 text-zinc-500 bg-black/20 rounded-xl border border-zinc-800/50">
            No products found.
          </div>
        )}
        {products.map(p => {
          const images = JSON.parse(p.images || '[]');
          const firstImage = images[0] || 'https://via.placeholder.com/40';
          return (
            <div key={p.id} className="bg-black/40 border border-zinc-800/80 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-olive/30 transition-colors shadow-lg group">
              <div className="flex items-center gap-4 flex-1">
                <img src={firstImage} className="w-16 h-16 rounded-lg object-cover border border-zinc-800 bg-zinc-900" alt="" />
                <div className="flex flex-col">
                  <span className="font-bold text-white text-base line-clamp-1">{language === 'ar' && p.name_ar ? p.name_ar : p.name}</span>
                  <span className="text-xs text-zinc-500 line-clamp-1">{p.slug}</span>
                  {p.is_featured && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-olive mt-1 w-fit bg-olive/10 px-1.5 py-0.5 rounded border border-olive/20">
                      <Check className="w-3 h-3" /> Featured
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-6 sm:gap-8 lg:border-l lg:border-zinc-800 lg:pl-6">
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Type</span>
                  <span className="text-sm text-zinc-300 capitalize font-medium">{p.selling_type.replace('_', ' ')}</span>
                </div>

                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Base Price</span>
                  <span className="text-gold font-bold text-base whitespace-nowrap">
                    {(p.base_price * exchangeRate).toLocaleString('en-US', { minimumFractionDigits: 0 })} <span className="text-xs text-zinc-500">IQD</span>
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button onClick={() => openEditor(p)} className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors border border-transparent hover:border-zinc-700" title="Edit">
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
      </div>`;

content = content.replace(target, replacement);

fs.writeFileSync('src/components/AdminProducts.tsx', content);
